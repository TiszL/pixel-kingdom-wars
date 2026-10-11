/** SA-3 T17/T18/T20; contract v2 has no T16 entry. Tests-only checkpoint.
 * Raw IDL/SPL banks and real transaction/permit signatures; no Db or runner.
 * Worker lifecycle/timers belong outside this core. One transaction per pass,
 * at most settleBatchMax auctions per settlement transaction. Restart recovery
 * below proves landed bitmap recovery, not exactly-once across lost memory.
 * Successor reads require review 4dbfed12's private reader, never public routes.
 */
import { describe,expect,it,vi } from 'vitest';
import { Ed25519Program,Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY,TransactionMessage,VersionedTransaction,
 type SignatureStatus,type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { keepAta } from '@shardkeep/chain';
import { buildOpenTermIx,buildSettleIx } from '@shardkeep/chain/seeker-auction-instructions';
import { canonicalSeekerRegistry,decodeSeekerActionPermit,hashOpenSeekerAuctionPayload,hashSeekerAuctionTerms,
 seekerTermPda,type SeekerAuctionTerms } from '@shardkeep/chain/seeker-auction-protocol';
import { readFinalizedHistoricalSeekerTerm } from '@shardkeep/chain/seeker-terms';
import { createSeekerAuctionFixture,program,wallet,other,configAddress,type SeekerAuctionFixture } from '../../../packages/chain/src/testFixtures/seekerAuctionRead.fixture';
import { createMiningTermFixture } from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { fundedMiningTerms } from '../../../packages/chain/src/testFixtures/fundedMiningTerms';
import { sign } from '../../../packages/chain/src/testFixtures/charterPreparation';
import type { CharterPolicyIssueRequest } from '../src/charterPolicyIssuer';
import type { CharterIssuerReceipt } from '../src/charterPolicyIssuerJournal';
import { createSeekerAuctionCrank,type SeekerAuctionCrankOptions,type SeekerAuctionCrankEvent,
 type SeekerAuctionCrankSource } from '../src/seeker/auctionCrank';

const P=PHASE_E_POLICY.seekerIsland,A=PHASE_E_SEEKER_AUCTION,R=PHASE_E_SEEKER_AUCTION_RUNTIME;
const signal=()=>new AbortController().signal;
const crankKey=Keypair.fromSeed(Buffer.alloc(32,1)),policyKey=Keypair.fromSeed(Buffer.alloc(32,33));
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n));
const allSpots=Array.from({length:P.totalSpots},(_,spot)=>spot);
const uuid=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
function instruction(value:TransactionInstruction){return {program:value.programId.toBase58(),data:value.data.toString('hex'),
 keys:value.keys.map(k=>({key:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable}))};}
function packet(bytes:Uint8Array){const tx=VersionedTransaction.deserialize(bytes);expect(tx.version).toBe('legacy');
 expect(tx.message.header.numRequiredSignatures).toBe(1);expect(tx.message.staticAccountKeys[0]!.equals(wallet)).toBe(true);
 expect(bytes.length).toBeLessThanOrEqual(1232);return TransactionMessage.decompile(tx.message);}
function terms(f:SeekerAuctionFixture,spot:number):SeekerAuctionTerms {
 const c=f.models.config,t=f.models.term,auction=f.auctionAddresses[spot]!;
 return {...canonicalSeekerRegistry()[spot]!,config:configAddress,term:f.termAddress,auction,registry:c.registry,
 registryHash:Buffer.from(c.registry_hash),round:f.round,auctionStart:t.auction_start,auctionEnd:t.auction_end,
 operatingStart:t.operating_start,operatingEnd:t.operating_end,mint:f.mint,tokenProgram:c.token_program,
 vault:keepAta(auction,f.mint,true),prizeOwner:f.prizeOwner,prizeAta:c.prize_ata,prizeBps:c.prize_bps,
 grace:c.grace_sec,openingBid:c.opening_bid,registryVersion:c.registry_version,auctionFormat:c.auction_format,termsFormat:c.terms_format};
}

async function fixture(options:{now?:bigint;rounds?:readonly bigint[];dryRun?:boolean}={}){
 const base=await createSeekerAuctionFixture(),rounds=new Map<bigint,SeekerAuctionFixture>([[0n,base]]);
 for(const round of options.rounds??[1n,2n])if(round!==0n)rounds.set(round,await createSeekerAuctionFixture({round}));
 const controls={now:options.now??base.auctionStart-10_000n,relayFails:false,status:null as SignatureStatus|null,
  height:3000,lastValidBlockHeight:3100,slot:2000,statusSlot:2000,failStatus:false,failEpoch:false,
  beforeGenesis:async()=>{},beforeLoad:async()=>{}};
 base.models.authority.current_policy_key=policyKey.publicKey;await base.core();
 // Only round-owned accounts are copied. Core trust and Clock remain one bank.
 function sync(f:SeekerAuctionFixture){if(f===base)return;for(const address of [f.termAddress,...f.auctionAddresses,...f.bidAddresses]){
  const row=f.store.get(address.toBase58());if(row)base.store.set(address.toBase58(),{...row,data:Buffer.from(row.data)});else base.store.delete(address.toBase58());}}
 for(const f of rounds.values())sync(f);
 function setNow(now:bigint){controls.now=now;base.account(SYSVAR_CLOCK_PUBKEY).data.writeBigInt64LE(now,32);}
 setNow(controls.now);
 async function holes(round:bigint,spots:readonly number[]){const f=rounds.get(round)!;
  for(const spot of spots){f.models.term.opened[spot>>3]!&=~(1<<(spot%8));f.store.delete(f.auctionAddresses[spot]!.toBase58());f.store.delete(f.bidAddresses[spot]!.toBase58());}
  await f.core();sync(f);
 }
 function missingTerm(round:bigint){const f=rounds.get(round)!;for(const address of [f.termAddress,...f.auctionAddresses,...f.bidAddresses])base.store.delete(address.toBase58());}
 async function settled(round:bigint,spots:readonly number[]){const f=rounds.get(round)!;
  for(const spot of spots){const t=terms(f,spot),winner=spot===0?other:spot===1?wallet:null;
   f.models.term.settled[spot>>3]!|=1<<(spot%8);
   const le=Buffer.alloc(8);le.writeBigUInt64LE(round);
   await f.pack('Auction',t.auction,{version:1,config:t.config,term:t.term,registry:t.registry,
    spot:{id:spot,class:t.class,realm_mask:t.realmMask},round,auction_start:t.auctionStart,auction_end:t.auctionEnd,
    operating_start:t.operatingStart,operating_end:t.operatingEnd,terms_hash:[...hashSeekerAuctionTerms(t)],vault:t.vault,
    high_bid:winner?f.openingBid*2n:0n,high_bidder:winner,outstanding_escrow:spot===0?f.openingBid:0n,
    settled:true,result_owner:winner,settled_at:controls.now,settled_slot:BigInt(controls.slot),
    bump:PublicKey.findProgramAddressSync([Buffer.from('auction'),configAddress.toBuffer(),Buffer.of(spot),le],program)[1]});
   if(spot===1)f.account(f.bidAddresses[spot]!).data.writeBigUInt64LE(0n,73);
  }
  const bits=(spot:number)=>(f.models.term.settled[spot>>3]!&(1<<(spot%8)))!==0;
  f.models.term.completed_count=allSpots.filter(bits).length;f.models.term.winner_count=[0,1].filter(bits).length;
  if(f.models.term.completed_count===P.totalSpots){f.models.term.completed_at=controls.now;f.models.term.completed_slot=BigInt(controls.slot);}
  await f.core();sync(f);
 }
 const sent:Uint8Array[]=[],rpcOrder:string[]=[],events:SeekerAuctionCrankEvent[]=[];
 let requestCounter=0,hashCounter=0;
 const sourceRpc=base.source.connect(signal());
 const rpc={
  getGenesisHash:vi.fn(async()=>{await controls.beforeGenesis();return sourceRpc.getGenesisHash();}),
  getMultipleAccountsInfoAndContext:vi.fn(async(...args:Parameters<typeof sourceRpc.getMultipleAccountsInfoAndContext>)=>{
   rpcOrder.push('accounts');return sourceRpc.getMultipleAccountsInfoAndContext(...args);}),
  getLatestBlockhashAndContext:vi.fn(async(_options:{commitment:'finalized';minContextSlot:number})=>{
   rpcOrder.push('blockhash');return {context:{slot:controls.slot},value:{blockhash:key(90+(hashCounter++)).toBase58(),lastValidBlockHeight:controls.lastValidBlockHeight}};}),
  getEpochInfo:vi.fn(async(_options:{commitment:'finalized';minContextSlot?:number})=>{
   rpcOrder.push('epoch');if(controls.failEpoch)throw Error('epoch unavailable');return {absoluteSlot:controls.slot,blockHeight:controls.height,epoch:1,slotIndex:1,slotsInEpoch:432000};}),
  getSignatureStatuses:vi.fn(async(_signatures:string[],_options:{searchTransactionHistory:true})=>{
   rpcOrder.push('status');if(controls.failStatus)throw Error('status unavailable');return {context:{slot:controls.statusSlot},value:[controls.status]};}),
  sendRawTransaction:vi.fn(async(raw:Uint8Array,_options:{maxRetries:number})=>{
   rpcOrder.push('send');sent.push(Uint8Array.from(raw));if(controls.relayFails)throw Error('ambiguous transport');
   return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]!);}),
 };
 const source:SeekerAuctionCrankSource={trust:base.source.trust,connect:caller=>{caller.throwIfAborted();return rpc;}};
 const loadSigner=vi.fn(async(_caller:AbortSignal)=>{await controls.beforeLoad();return crankKey;});
 const issueOnce=vi.fn(async(request:CharterPolicyIssueRequest,_caller:AbortSignal):Promise<CharterIssuerReceipt>=>({
  requestId:request.requestId,publicKey:policyKey.publicKey.toBase58(),message:Uint8Array.from(request.message),signature:sign(policyKey,request.message)}));
 const nextRequestId=vi.fn(()=>uuid(++requestCounter));
 // S6-S1 fixture extension: independent configured issuer pin, never copied from a read.
 const settings:SeekerAuctionCrankOptions={source,crankPublicKey:wallet.toBase58(),issuerPublicKey:policyKey.publicKey.toBase58(),dryRun:options.dryRun??false,loadSigner,
  issuer:{issueOnce},nextRequestId,onEvent:event=>{events.push(event);}};
 const make=()=>createSeekerAuctionCrank(settings);
 return {base,rounds,controls,setNow,holes,missingTerm,settled,source,rpc,sent,rpcOrder,loadSigner,issueOnce,nextRequestId,settings,events,make};
}

describe('S6-S1 independent issuer pin and refusal admission',()=>{
 it('requires a canonical independent issuer pin for live work before any I/O',async()=>{
  const f=await fixture();const {issuerPublicKey:_pin,...withoutPin}=f.settings;
  for(const options of [withoutPin,{...f.settings,issuerPublicKey:'invalid'},
   {...f.settings,issuerPublicKey:PublicKey.default.toBase58()}]){
   expect(()=>createSeekerAuctionCrank(options)).toThrow();
  }
  expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();expect(f.loadSigner).not.toHaveBeenCalled();
  expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 it('permits an unpinned read-only preview without loading secrets or issuing',async()=>{
  const f=await fixture({dryRun:true});await f.holes(0n,[2]);const {issuerPublicKey:_pin,...options}=f.settings;
  expect(await createSeekerAuctionCrank(options).runOnce(signal())).toMatchObject({status:'dry-run'});
  expect(f.loadSigner).not.toHaveBeenCalled();expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 for(const boundary of ['before key load','during key load'] as const)it(`holds a policy mismatch ${boundary} before issuance`,async()=>{
  const f=await fixture();await f.holes(0n,[2]);
  const rotate=async()=>{f.base.models.authority.current_policy_key=key(77);await f.base.core();};
  if(boundary==='before key load')await rotate();else f.controls.beforeLoad=rotate;
  const crank=f.make(),result=await crank.runOnce(signal());
  expect(result).toMatchObject({status:'held',actions:[],signature:null});
  expect(result.alarms).toContainEqual(expect.objectContaining({code:'POLICY_KEY_MISMATCH',round:'0',spots:[2]}));
  expect(f.events).toContainEqual(expect.objectContaining({type:'alarm',alarm:expect.objectContaining({code:'POLICY_KEY_MISMATCH'})}));
  expect(f.loadSigner).toHaveBeenCalledTimes(boundary==='before key load'?0:1);
  expect(f.nextRequestId).not.toHaveBeenCalled();expect(f.issueOnce).not.toHaveBeenCalled();
  expect(f.rpc.getLatestBlockhashAndContext).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);expect(crank.pendingAttempt()).toBeNull();
 });
 it('captures the configured policy pin at construction instead of accepting a later caller mutation',async()=>{
  const f=await fixture();await f.holes(0n,[2]);const options={...f.settings},crank=createSeekerAuctionCrank(options);
  options.issuerPublicKey=key(77).toBase58();f.base.models.authority.current_policy_key=key(77);await f.base.core();
  expect(await crank.runOnce(signal())).toMatchObject({status:'held'});
  expect(f.loadSigner).not.toHaveBeenCalled();expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 it('does not block permissionless settlement when the policy pin has rotated',async()=>{
  const f=await fixture();f.setNow(f.base.operatingStart+BigInt(A.settlementGraceSec));
  f.base.models.authority.current_policy_key=key(77);f.base.models.authority.admission_paused=true;await f.base.core();
  expect(await f.make().runOnce(signal())).toMatchObject({status:'submitted',actions:[{kind:'settle',round:'0',spots:[0,1,2,3]}]});
  expect(f.issueOnce).not.toHaveBeenCalled();expect(f.nextRequestId).not.toHaveBeenCalled();expect(f.sent).toHaveLength(1);
 });
 it('does not block permissionless term preparation when the policy pin has rotated',async()=>{
  const f=await fixture();f.missingTerm(1n);f.missingTerm(2n);
  f.base.models.authority.current_policy_key=key(77);await f.base.core();
  expect(await f.make().runOnce(signal())).toMatchObject({status:'submitted',actions:[{kind:'open-term',round:'1'}]});
  expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(1);
 });
 it('reconciles the retained signature before policy admission after rotation',async()=>{
  const f=await fixture();await f.holes(0n,[2]);f.controls.relayFails=true;const crank=f.make();
  const first=await crank.runOnce(signal());expect(first.status).toBe('pending');const retained=crank.pendingAttempt();
  expect(retained).not.toBeNull();f.base.models.authority.current_policy_key=key(77);await f.base.core();
  expect(await crank.runOnce(signal())).toMatchObject({status:'pending',signature:first.signature});
  expect(crank.pendingAttempt()).toEqual(retained);expect(f.issueOnce).toHaveBeenCalledTimes(1);expect(f.sent).toHaveLength(1);
 });
 it('turns an issuer transport refusal into a stable held alarm without a signed transaction or error disclosure',async()=>{
  const f=await fixture();await f.holes(0n,[2]);f.issueOnce.mockRejectedValueOnce(Error('SYNTHETIC_ISSUER_DETAIL_NOT_FOR_LOGS'));
  const crank=f.make(),result=await crank.runOnce(signal());
  expect(result).toMatchObject({status:'held',actions:[],signature:null});
  expect(result.alarms).toContainEqual(expect.objectContaining({code:'ISSUER_REFUSED',round:'0',spots:[2]}));
  expect(f.events).toContainEqual(expect.objectContaining({type:'alarm',alarm:expect.objectContaining({code:'ISSUER_REFUSED'})}));
  expect(JSON.stringify({result,events:f.events})).not.toContain('SYNTHETIC_ISSUER_DETAIL_NOT_FOR_LOGS');
  expect(f.issueOnce).toHaveBeenCalledTimes(1);expect(f.rpc.getLatestBlockhashAndContext).not.toHaveBeenCalled();
  expect(crank.pendingAttempt()).toBeNull();expect(f.sent).toHaveLength(0);
 });
 it('propagates cancellation during issuer refusal instead of disguising it as a held result',async()=>{
  const f=await fixture(),abort=new AbortController();await f.holes(0n,[2]);
  f.issueOnce.mockImplementationOnce(async()=>{abort.abort();throw Error('cancelled issuer');});
  const crank=f.make();await expect(crank.runOnce(abort.signal)).rejects.toThrow();
  expect(crank.pendingAttempt()).toBeNull();expect(f.sent).toHaveLength(0);
  expect(f.events.some(event=>event.type==='alarm'&&event.alarm.code==='ISSUER_REFUSED')).toBe(false);
 });
 for(const boundary of ['issuer','blockhash'] as const)it(`retains final admission after policy rotation during ${boundary}`,async()=>{
  const f=await fixture();await f.holes(0n,[2]);
  const rotate=async()=>{f.base.models.authority.current_policy_key=key(77);await f.base.core();};
  if(boundary==='issuer')f.issueOnce.mockImplementationOnce(async request=>{
   await rotate();return {requestId:request.requestId,publicKey:policyKey.publicKey.toBase58(),
    message:Uint8Array.from(request.message),signature:sign(policyKey,request.message)};
  });else f.rpc.getLatestBlockhashAndContext.mockImplementationOnce(async()=>{
   await rotate();return {context:{slot:f.controls.slot},value:{blockhash:key(91).toBase58(),lastValidBlockHeight:f.controls.lastValidBlockHeight}};
  });
  const crank=f.make();await expect(crank.runOnce(signal())).rejects.toThrow();
  expect(f.issueOnce).toHaveBeenCalledTimes(1);expect(f.sent).toHaveLength(0);expect(crank.pendingAttempt()).toBeNull();
 });
});

describe('SA-3 deterministic worker capability and lifecycle bounds',()=>{
 it('constructs lazily and previews opening without loading a key, issuing a permit, signing or sending',async()=>{
  const f=await fixture({dryRun:true});await f.holes(0n,[2]);const crank=f.make();
  expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();expect(f.loadSigner).not.toHaveBeenCalled();
  expect(await crank.runOnce(signal())).toMatchObject({status:'dry-run',actions:[{kind:'open-auction',round:'0',spot:2}]});
  expect(f.loadSigner).not.toHaveBeenCalled();expect(f.issueOnce).not.toHaveBeenCalled();expect(f.nextRequestId).not.toHaveBeenCalled();
  expect(f.rpc.getLatestBlockhashAndContext).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 it('previews settlement with the same dry-run restrictions',async()=>{
  const f=await fixture({dryRun:true});f.setNow(f.base.operatingStart+BigInt(A.settlementGraceSec));
  expect(await f.make().runOnce(signal())).toMatchObject({status:'dry-run',actions:[{kind:'settle',round:'0',spots:[0,1,2,3]}]});
  expect(f.loadSigner).not.toHaveBeenCalled();expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 it('holds concurrent re-entry and releases its guard after a failed read',async()=>{
  const f=await fixture(),entered=gate(),resume=gate();await f.holes(0n,[2]);
  f.controls.beforeGenesis=async()=>{entered.release();await resume.promise;};const crank=f.make(),first=crank.runOnce(signal());await entered.promise;
  expect(await crank.runOnce(signal())).toMatchObject({status:'busy'});expect(f.sent).toHaveLength(0);
  f.base.controls.failAccounts=true;resume.release();await expect(first).rejects.toThrow();
  f.base.controls.failAccounts=false;f.controls.beforeGenesis=async()=>{};
  expect(await crank.runOnce(signal())).toMatchObject({status:'submitted'});expect(f.sent).toHaveLength(1);
 });
 it('refuses a mismatching key before the issuer or any submission',async()=>{
  const f=await fixture();await f.holes(0n,[2]);f.loadSigner.mockResolvedValue(Keypair.fromSeed(Buffer.alloc(32,2)));
  await expect(f.make().runOnce(signal())).rejects.toThrow(/^Seeker auction crank unavailable: worker public key$/);expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 it('observes cancellation while loading the worker key',async()=>{
  const f=await fixture(),entered=gate(),resume=gate(),abort=new AbortController();await f.holes(0n,[2]);
  f.controls.beforeLoad=async()=>{entered.release();await resume.promise;};const run=f.make().runOnce(abort.signal);await entered.promise;const reason=Error('worker-key acquisition cancelled');abort.abort(reason);resume.release();
  await expect(run).rejects.toBe(reason);expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 for(const defect of ['RPC failure','wrong mint','wrong genesis','inconsistent bitmap'] as const)it(`never treats ${defect} as empty chain state`,async()=>{
  const f=await fixture();await f.holes(0n,[2]);
  if(defect==='RPC failure')f.base.controls.failAccounts=true;
  if(defect==='wrong mint')f.base.source.trust.mint=other.toBase58();
  if(defect==='wrong genesis')f.base.controls.genesisHash=other.toBase58();
  if(defect==='inconsistent bitmap')f.base.store.delete(f.base.auctionAddresses[3]!.toBase58());
  await expect(f.make().runOnce(signal())).rejects.toThrow();expect(f.loadSigner).not.toHaveBeenCalled();expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
});

describe('SA-3 T17 current and successor preparation from finalized state',()=>{
 it('bootstraps term zero alone and waits for chain evidence before requesting any spot permit',async()=>{
  const f=await fixture();f.missingTerm(0n);f.missingTerm(1n);f.missingTerm(2n);
  expect(await f.make().runOnce(signal())).toMatchObject({status:'submitted',actions:[{kind:'open-term',round:'0'}]});
  expect(packet(f.sent[0]!).instructions.map(instruction)).toEqual([instruction(buildOpenTermIx(program,{payer:wallet,round:0n}))]);
  expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(1);
 });
 it('opens N+1 as soon as N exists, before the first operating start and without requiring N to complete',async()=>{
  const f=await fixture();f.missingTerm(1n);f.missingTerm(2n);
  expect(f.base.models.term.completed_count).toBe(0);expect(f.controls.now).toBeLessThan(f.base.firstStart);
  expect(await f.make().runOnce(signal())).toMatchObject({actions:[{kind:'open-term',round:'1'}]});
  expect(packet(f.sent[0]!).instructions.map(instruction)).toEqual([instruction(buildOpenTermIx(program,{payer:wallet,round:1n}))]);
  expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(1);
 });
 it('opens a clear successor spot using only exact kind-7 canonical terms and the current policy signer',async()=>{
  const f=await fixture();await f.holes(1n,[42]);const future=f.rounds.get(1n)!;
  expect(await f.make().runOnce(signal())).toMatchObject({status:'submitted',actions:[{kind:'open-auction',round:'1',spot:42}]});
  const request=f.issueOnce.mock.calls[0]![0],permit=decodeSeekerActionPermit(request.message);
  expect(request).toMatchObject({kind:'seeker-auction-open-v1',requestId:uuid(1),auction:{round:'1',spot:42}});
  expect(permit.kind).toBe(7);expect(permit.programId.equals(program)).toBe(true);expect(permit.wallet.equals(wallet)).toBe(true);
  expect(permit.genesisHash.toBase58()).toBe(f.source.trust.genesisHash);
  expect(Buffer.from(permit.payloadHash)).toEqual(hashOpenSeekerAuctionPayload(terms(future,42)));
  expect(permit.expiry).toBe(f.controls.now+BigInt(A.issuedPolicyPermitTtlSec));
  const tx=packet(f.sent[0]!);expect(tx.instructions).toHaveLength(2);
  expect(tx.instructions[0]!.programId.equals(Ed25519Program.programId)).toBe(true);
  expect(tx.instructions[0]!.data.includes(Buffer.from(request.message))).toBe(true);
  expect(tx.instructions[1]!.programId.equals(program)).toBe(true);expect(tx.instructions[1]!.data.readUInt16LE(33)).toBe(0);
  expect(f.rpc.sendRawTransaction.mock.calls[0]![1]).toMatchObject({maxRetries:0});
  const signature=bs58.encode(VersionedTransaction.deserialize(f.sent[0]!).signatures[0]!);
  expect(f.events.some(event=>'signature'in event&&event.signature===signature)).toBe(true);
  expect(f.base.calls.every(call=>call.options.commitment==='finalized')).toBe(true);
  const tooFar=seekerTermPda(program,configAddress,2n).toBase58();expect(f.base.calls.some(call=>call.keys.includes(tooFar))).toBe(false);
 });
 it('resumes the first clear opened bit after restart, without revisiting a landed auction',async()=>{
  const f=await fixture();await f.holes(0n,[2,4]);expect(await f.make().runOnce(signal())).toMatchObject({actions:[{kind:'open-auction',round:'0',spot:2}]});
  const landed=await createSeekerAuctionFixture();f.base.models.term.opened[0]!|=1<<2;await f.base.core();
  f.base.store.set(f.base.auctionAddresses[2]!.toBase58(),landed.account(landed.auctionAddresses[2]!));
  expect(await f.make().runOnce(signal())).toMatchObject({actions:[{kind:'open-auction',round:'0',spot:4}]});
  expect(f.issueOnce.mock.calls.map(call=>call[0].auction?.spot)).toEqual([2,4]);expect(f.sent).toHaveLength(2);
 });
 it('does no work when current and immediate successor are fully opened, without chasing unbounded future terms',async()=>{
  const f=await fixture();expect(await f.make().runOnce(signal())).toMatchObject({status:'idle',actions:[]});
  expect(f.loadSigner).not.toHaveBeenCalled();expect(f.issueOnce).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
  expect(f.base.calls.some(c=>c.keys.includes(seekerTermPda(program,configAddress,2n).toBase58()))).toBe(false);
 });
 for(const offset of [-1n,0n,1n])it(`alarms at the lead boundary with offset ${offset} without making lead time a lower open bound`,async()=>{
  const f=await fixture({dryRun:true});await f.holes(0n,[2]);f.setNow(f.base.auctionStart-BigInt(R.openAlarmLeadSec)+offset);
  const result=await f.make().runOnce(signal());expect(result.actions).toEqual([{kind:'open-auction',round:'0',spot:2}]);
  expect(result.alarms.some(a=>a.code==='OPEN_DEADLINE'&&a.round==='0'&&a.spots.includes(2))).toBe(offset>=0n);
 });
 for(const offset of [0n,1n])it(`alarms rather than opening a missing auction at/after start (${offset})`,async()=>{
  const f=await fixture();await f.holes(0n,[2]);f.setNow(f.base.auctionStart+offset);
  const result=await f.make().runOnce(signal());expect(result.actions).toEqual([]);
  expect(result.alarms).toContainEqual(expect.objectContaining({code:'OPEN_WINDOW_MISSED',round:'0',spots:[2]}));
  expect(f.issueOnce).not.toHaveBeenCalled();expect(f.loadSigner).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 it('holds auction opens during admission pause',async()=>{
  const f=await fixture();await f.holes(0n,[2]);f.base.models.authority.admission_paused=true;await f.base.core();
  expect(await f.make().runOnce(signal())).toMatchObject({status:'held',actions:[]});
  expect(f.issueOnce).not.toHaveBeenCalled();expect(f.loadSigner).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 for(const defect of ['message','signature','policy key','request id','mutated request'] as const)it(`refuses an issuer receipt with changed ${defect}`,async()=>{
  const f=await fixture();await f.holes(0n,[2]);f.issueOnce.mockImplementation(async request=>{
   const message=Uint8Array.from(request.message);if(defect==='message'||defect==='mutated request')message[129]=message[129]!^1;
   if(defect==='mutated request')request.message.set(message);
   const signingKey=defect==='policy key'?crankKey:policyKey,signature=sign(signingKey,message);if(defect==='signature')signature[0]=signature[0]!^1;
   return {requestId:defect==='request id'?uuid(99):request.requestId,publicKey:signingKey.publicKey.toBase58(),message,signature};
  });
  const reason=defect==='mutated request'?'issuer mutated request':defect==='signature'?'issuer receipt signature':'issuer receipt binding';
  await expect(f.make().runOnce(signal())).rejects.toMatchObject({message:`Seeker auction crank unavailable: ${reason}`});expect(f.sent).toHaveLength(0);
 });
});

describe('SA-3 T18 permissionless, bounded, bitmap-driven settlement',()=>{
 it('preserves exact settlement-message checks after fee-payer promotion and detects an extra writable mint',async()=>{
  // Legacy messages promote the fee payer to writable. Compare canonical
  // messages without ignoring account flags: a writable mint must still differ.
  const f=await fixture();f.setNow(f.base.operatingStart+BigInt(A.settlementGraceSec));
  await f.make().runOnce(signal());const actual=VersionedTransaction.deserialize(f.sent[0]!).message;
  const expected=[0,1,2,3].map(spot=>buildSettleIx(program,{wallet,mint:f.base.mint,round:0n,spot,
   prizeOwner:f.base.prizeOwner,highBidder:spot===0?other:spot===1?wallet:null,highBid:spot<2?f.base.openingBid*2n:0n}));
  expect(expected.every(ix=>ix.keys[0]!.isSigner&&!ix.keys[0]!.isWritable)).toBe(true);
  const canonical=new TransactionMessage({payerKey:wallet,recentBlockhash:actual.recentBlockhash,instructions:expected}).compileToLegacyMessage();
  expect(TransactionMessage.decompile(canonical).instructions.every(ix=>ix.keys[0]!.isSigner&&ix.keys[0]!.isWritable)).toBe(true);
  expect(Buffer.from(actual.serialize())).toEqual(Buffer.from(canonical.serialize()));
  // Only elevate the mint in the first instruction; transaction-wide privilege
  // union must remain visible to the exact wire oracle, never normalized away.
  const mintMeta=expected[0]!.keys.find(meta=>meta.pubkey.equals(f.base.mint))!;expect(mintMeta.isWritable).toBe(false);mintMeta.isWritable=true;
  const noncanonical=new TransactionMessage({payerKey:wallet,recentBlockhash:actual.recentBlockhash,instructions:expected}).compileToLegacyMessage();
  expect(Buffer.from(actual.serialize())).not.toEqual(Buffer.from(noncanonical.serialize()));
 });
 it('does not request kind 8 or settle during grace',async()=>{
  const f=await fixture();f.setNow(f.base.operatingStart+BigInt(A.settlementGraceSec)-1n);
  expect(await f.make().runOnce(signal())).toMatchObject({status:'idle',actions:[]});
  expect(f.issueOnce).not.toHaveBeenCalled();expect(f.loadSigner).not.toHaveBeenCalled();expect(f.sent).toHaveLength(0);
 });
 it('settles exactly at auction_end+grace in one top-level batch of no more than four distinct auctions, even while paused',async()=>{
  const f=await fixture();f.setNow(f.base.operatingStart+BigInt(A.settlementGraceSec));f.base.models.authority.admission_paused=true;await f.base.core();
  expect(await f.make().runOnce(signal())).toMatchObject({status:'submitted',actions:[{kind:'settle',round:'0',spots:[0,1,2,3]}]});
  const decoded=packet(f.sent[0]!),ixs=decoded.instructions;expect(ixs).toHaveLength(R.settleBatchMax);expect(ixs.length).toBeLessThanOrEqual(4);
  const expected=[0,1,2,3].map(spot=>buildSettleIx(program,{wallet,mint:f.base.mint,round:0n,spot,
   prizeOwner:f.base.prizeOwner,highBidder:spot===0?other:spot===1?wallet:null,highBid:spot<2?f.base.openingBid*2n:0n}));
  // The old oracle compared IDL-local flags with decompiled transaction-wide
  // flags. The fee payer is writable after compilation; keep every flag check
  // by compiling the independently built expected batch to the same wire form.
  const canonical=new TransactionMessage({payerKey:wallet,recentBlockhash:decoded.recentBlockhash,instructions:expected}).compileToLegacyMessage();
  expect(ixs.map(instruction)).toEqual(TransactionMessage.decompile(canonical).instructions.map(instruction));
  expect(Buffer.from(VersionedTransaction.deserialize(f.sent[0]!).message.serialize())).toEqual(Buffer.from(canonical.serialize()));
  expect(new Set(ixs.map(ix=>ix.keys[3]!.pubkey.toBase58())).size).toBe(4);
  expect(ixs.every(ix=>ix.programId.equals(program))).toBe(true);expect(f.issueOnce).not.toHaveBeenCalled();expect(f.nextRequestId).not.toHaveBeenCalled();
  expect(f.sent).toHaveLength(1);expect(f.rpc.sendRawTransaction.mock.calls[0]![1]).toMatchObject({maxRetries:0});
 });
 it('restarts from settled bits alone and preserves leftover zero-bid auctions in the next batch',async()=>{
  const f=await fixture();f.setNow(f.base.operatingStart+BigInt(A.settlementGraceSec));
  await f.make().runOnce(signal());await f.settled(0n,[0,1,2,3]);
  expect(await f.make().runOnce(signal())).toMatchObject({actions:[{kind:'settle',round:'0',spots:[4,5,6,7]}]});
  expect(packet(f.sent[1]!).instructions).toHaveLength(4);expect(f.issueOnce).not.toHaveBeenCalled();
 });
 it('submits only the final incomplete spot and then observes chain completion without settling again',async()=>{
  const f=await fixture();f.setNow(f.base.operatingStart+BigInt(A.settlementGraceSec));await f.settled(0n,allSpots.slice(0,-1));
  expect(await f.make().runOnce(signal())).toMatchObject({actions:[{kind:'settle',round:'0',spots:[99]}]});expect(packet(f.sent[0]!).instructions).toHaveLength(1);
  await f.settled(0n,[99]);expect(await f.make().runOnce(signal())).toMatchObject({status:'idle',actions:[]});expect(f.sent).toHaveLength(1);
 });
});

describe('SA-3 ambiguous submissions are retained until finalized resolution',()=>{
 it('records the locally known signature after a send error and never blindly resends',async()=>{
  const f=await fixture();await f.holes(0n,[2]);f.controls.relayFails=true;const crank=f.make();
  const first=await crank.runOnce(signal()),signature=bs58.encode(VersionedTransaction.deserialize(f.sent[0]!).signatures[0]!);
  expect(first).toMatchObject({status:'pending',signature});expect(f.events.some(event=>'signature'in event&&event.signature===signature)).toBe(true);
  f.controls.height=f.controls.lastValidBlockHeight;expect(await crank.runOnce(signal())).toMatchObject({status:'pending',signature});
  expect(f.sent).toHaveLength(1);expect(f.issueOnce).toHaveBeenCalledTimes(1);
  expect(f.rpc.getSignatureStatuses.mock.calls.at(-1)).toEqual([[signature],{searchTransactionHistory:true}]);
 });
 it('retries only after finalized absence plus strict height expiry and a fresh clear-bit read, with a fresh permit id',async()=>{
  const f=await fixture();await f.holes(0n,[2]);f.controls.relayFails=true;const crank=f.make();await crank.runOnce(signal());
  f.controls.height=f.controls.lastValidBlockHeight+1;f.controls.lastValidBlockHeight+=200;f.controls.relayFails=false;const start=f.rpcOrder.length;
  expect(await crank.runOnce(signal())).toMatchObject({status:'submitted'});expect(f.sent).toHaveLength(2);
  const order=f.rpcOrder.slice(start);expect(order.indexOf('epoch')).toBeLessThan(order.indexOf('status'));
  expect(order.indexOf('accounts',order.indexOf('status'))).toBeGreaterThan(order.indexOf('status'));
  expect(order.lastIndexOf('accounts')).toBeLessThan(order.indexOf('send'));
  const permits=f.issueOnce.mock.calls.map(([request])=>decodeSeekerActionPermit(request.message));
  expect(Buffer.from(permits[0]!.permitId).equals(Buffer.from(permits[1]!.permitId))).toBe(false);
  expect(f.issueOnce.mock.calls.map(([request])=>request.requestId)).toEqual([uuid(1),uuid(2)]);
 });
 it('does not retry an expired-but-found unfinalized signature',async()=>{
  const f=await fixture();await f.holes(0n,[2]);const crank=f.make();await crank.runOnce(signal());f.controls.height=9999;
  f.controls.status={slot:2000,confirmations:1,err:null,confirmationStatus:'confirmed'};
  expect(await crank.runOnce(signal())).toMatchObject({status:'pending'});expect(f.sent).toHaveLength(1);expect(f.issueOnce).toHaveBeenCalledTimes(1);
 });
 for(const defect of ['status RPC','epoch RPC','stale status context'] as const)it(`does not reopen retry permission after ${defect}`,async()=>{
  const f=await fixture();await f.holes(0n,[2]);const crank=f.make();await crank.runOnce(signal());f.controls.height=9999;
  if(defect==='status RPC')f.controls.failStatus=true;if(defect==='epoch RPC')f.controls.failEpoch=true;if(defect==='stale status context')f.controls.statusSlot=1999;
  await expect(crank.runOnce(signal())).rejects.toThrow();expect(f.sent).toHaveLength(1);expect(f.issueOnce).toHaveBeenCalledTimes(1);
 });
 it('does not reopen a landed target after its old signature expires and disappears',async()=>{
  const f=await fixture();await f.holes(0n,[2]);const crank=f.make();await crank.runOnce(signal());f.controls.height=9999;
  const landed=await createSeekerAuctionFixture();f.base.models.term.opened[0]!|=1<<2;await f.base.core();
  f.base.store.set(f.base.auctionAddresses[2]!.toBase58(),landed.account(landed.auctionAddresses[2]!));
  expect(await crank.runOnce(signal())).toMatchObject({status:'idle',actions:[]});expect(f.sent).toHaveLength(1);
 });
});

// Worker queue ownership supplement: terminal observation ends one job before any next action.
describe('SA-3 retained pending observation for the dedicated worker',()=>{
 for(const failed of [false,true])it(`exposes detached pending and returns terminal failure=${failed} without another relay`,async()=>{
  const f=await fixture();await f.holes(0n,[2,4]);const crank=f.make();expect(crank.pendingAttempt()).toBeNull();
  const first=await crank.runOnce(signal()),held=crank.pendingAttempt();
  expect(held).toMatchObject({action:{kind:'open-auction',round:'0',spot:2},signature:first.signature,lastValidBlockHeight:3100,slot:2000});
  try{(held!.action as {spot:number}).spot=99;}catch{/* frozen snapshots may throw */}
  expect(crank.pendingAttempt()!.action).toMatchObject({spot:2});
  if(!failed){const landed=await createSeekerAuctionFixture();f.base.models.term.opened[0]!|=1<<2;await f.base.core();f.base.store.set(f.base.auctionAddresses[2]!.toBase58(),landed.account(landed.auctionAddresses[2]!));}
  f.controls.status={slot:2000,confirmations:null,confirmationStatus:'finalized',err:failed?{InstructionError:[0,'Custom']}:null};
  expect(await crank.runOnce(signal())).toMatchObject({status:failed?'failed':'finalized',actions:[{kind:'open-auction',round:'0',spot:2}],signature:first.signature});
  expect(crank.pendingAttempt()).toBeNull();expect(f.sent).toHaveLength(1);expect(f.issueOnce).toHaveBeenCalledTimes(1);
 });
 it('retains a inspectable pending signature after a status-read exception',async()=>{
  const f=await fixture();await f.holes(0n,[2]);const crank=f.make();const first=await crank.runOnce(signal());f.controls.failStatus=true;
  await expect(crank.runOnce(signal())).rejects.toThrow();expect(crank.pendingAttempt()).toMatchObject({signature:first.signature});expect(f.sent).toHaveLength(1);
 });
});

describe('SA-3 T20 completed terms retain original settlement provenance without hints',()=>{
 for(const winners of [[],[{spotId:0,wallet},{spotId:99,wallet:other}]])it(`verifies all 100 original settlements with ${winners.length} winners`,async()=>{
  const f=await createMiningTermFixture({day:'2026-10-06',genesisHash:key(204),programId:program,winners});
  const history=vi.spyOn(f.rpc,'getSignaturesForAddress'),blocks=vi.spyOn(f.rpc,'getBlock');
  const result=await readFinalizedHistoricalSeekerTerm(f.connect,f.policy);
  expect(result.winnerCount).toBe(winners.length);expect(result.auctions).toHaveLength(P.totalSpots);expect(result.operatingAdmissionAuthorized).toBe(false);
  expect(result.auctions.every(auction=>auction.settlement.method==='permissionless')).toBe(true);expect(history).toHaveBeenCalled();
  // Force the documented original-block fallback; empty history is not no bids.
  history.mockResolvedValue([]);expect((await readFinalizedHistoricalSeekerTerm(f.connect,f.policy)).auctions).toHaveLength(P.totalSpots);expect(blocks).toHaveBeenCalled();
 });
 it('preserves acceptance of existing genuine permitted historical settlements without adding kind 8 to the crank',async()=>{
  const replay=fundedMiningTerms({genesisHash:key(204),programId:program},'2026-10-05'),f=await replay('2026-10-06',2000);
  const result=await readFinalizedHistoricalSeekerTerm(f.connect,f.policy);expect(result.auctions).toHaveLength(P.totalSpots);
  expect(result.winnerCount).toBe(0);expect(result.operatingAdmissionAuthorized).toBe(false);
 });
});
