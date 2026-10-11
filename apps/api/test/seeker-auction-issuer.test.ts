/** T19: the existing issuer is extended by one exact native purpose, never 8.
 * Synthetic signer/account bank and isolated journal; the content pipeline queue only. */
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { keepAta } from '@shardkeep/chain';
import { canonicalSeekerRegistry,encodeSeekerActionPermit,hashOpenSeekerAuctionPayload,type SeekerAuctionTerms } from '@shardkeep/chain/seeker-auction-protocol';
import { createSeekerAuctionFixture,program,wallet,other } from '../../../packages/chain/src/testFixtures/seekerAuctionRead.fixture';
import { fixture as charterFixture } from '../../../packages/chain/src/testFixtures/charterCreation';
import { sign } from '../../../packages/chain/src/testFixtures/charterPreparation';
import { createCharterPolicyIssuer,type CharterPolicyIssueRequest } from '../src/charterPolicyIssuer';
import { initializeCharterIssuerJournal,openCharterIssuerJournal } from '../src/charterPolicyIssuerJournal';
import { CharterIssuerWireRequest,decodeCharterIssuerWireRequest,decodeCharterIssuerWireReceipt,encodeCharterIssuerWireReceipt } from '../src/charterPolicyIssuerClient';
const cleanups:(()=>Promise<void>)[]=[],signal=()=>new AbortController().signal;
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup(round=0n){
 const f=await createSeekerAuctionFixture({round,biddingRound:0n}),spot=2,policy=Keypair.fromSeed(Buffer.alloc(32,33));
 f.models.authority.current_policy_key=policy.publicKey;f.models.term.opened[0]!&=~(1<<spot);await f.core();f.store.delete(f.auctionAddresses[spot]!.toBase58());
 if(round>0n){const previous=await createSeekerAuctionFixture({round:round-1n,biddingRound:0n});f.store.set(previous.termAddress.toBase58(),previous.account(previous.termAddress));}
 const now=round===0n?f.auctionStart-1n:f.firstStart-1n;f.account(SYSVAR_CLOCK_PUBKEY).data.writeBigInt64LE(now,32);
 const config=f.models.config,term=f.models.term,terms:SeekerAuctionTerms={...canonicalSeekerRegistry()[spot]!,config:f.models.term.config,term:f.termAddress,auction:f.auctionAddresses[spot]!,registry:config.registry,registryHash:Buffer.from(config.registry_hash),round,
  auctionStart:term.auction_start,auctionEnd:term.auction_end,operatingStart:term.operating_start,operatingEnd:term.operating_end,mint:f.mint,tokenProgram:config.token_program,vault:keepAta(f.auctionAddresses[spot]!,f.mint,true),prizeOwner:f.prizeOwner,prizeAta:config.prize_ata,
  prizeBps:config.prize_bps,grace:config.grace_sec,openingBid:config.opening_bid,registryVersion:config.registry_version,auctionFormat:config.auction_format,termsFormat:config.terms_format};
 const charter=charterFixture(),domain={genesisHash:f.source.trust.genesisHash,economyProgram:program.toBase58()};
 const trust={...charter.trust,expectedGenesisHash:domain.genesisHash,economy:{programId:domain.economyProgram,reviewedDeploymentSlot:f.source.trust.deploymentSlot,reviewedProgramDataSha256:f.source.trust.programDataSha256,upgradeAuthority:f.source.trust.upgradeAuthority}};
 const dir=await mkdtemp(path.join(tmpdir(),'seeker-issuer-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));const journalFile=path.join(dir,'issuer.jsonl');await initializeCharterIssuerJournal(journalFile,domain);
 const signer=vi.fn((message:Uint8Array)=>sign(policy,message)),connect=vi.fn(()=>{throw Error('kind 7 must not use charter admission');});
 const options={journalFile,trust,connect,signer:{publicKey:policy.publicKey.toBase58(),sign:signer},seekerAuction:{source:f.source,crankPublicKey:wallet.toBase58()}};
 const issuer=await createCharterPolicyIssuer(options);cleanups.push(()=>issuer.close());
 function request(overrides:Partial<SeekerAuctionTerms>={},payer=wallet):CharterPolicyIssueRequest {
  return {kind:'seeker-auction-open-v1',requestId:randomUUID(),auction:{round:String(round),spot},message:encodeSeekerActionPermit({genesisHash:new PublicKey(domain.genesisHash),programId:program,kind:7,permitId:Buffer.from(randomUUID().replaceAll('-',''),'hex'),wallet:payer,
   expiry:now+BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec),payloadHash:hashOpenSeekerAuctionPayload({...terms,...overrides})})};
 }
 return {...f,issuer,options,terms,request,signer,connect,policy,journalFile,now,spot};
}
describe('SA-3 T19 independently derived kind-7 admission',()=>{
 it('signs exact own finalized terms for the pinned crank and recovers without signing twice',async()=>{
  const f=await setup(),request=f.request(),receipt=await f.issuer.issueOnce(request,signal());expect(receipt.message).toEqual(request.message);expect(receipt.signature).toEqual(sign(f.policy,request.message));
  expect(await f.issuer.issueOnce(request,signal())).toEqual(receipt);expect(await f.issuer.lookup(request.requestId,signal())).toEqual(receipt);expect(f.signer).toHaveBeenCalledTimes(1);expect(f.connect).not.toHaveBeenCalled();
  expect(await readFile(f.journalFile,'utf8')).toContain('seeker-auction-open-v1');
  expect(decodeCharterIssuerWireReceipt(encodeCharterIssuerWireReceipt(receipt,request.requestId),request.requestId)).toEqual(receipt);
 });
 it('signs the approved successor before term zero starts when the predecessor already exists',async()=>{
  const f=await setup(1n),request=f.request();expect(f.now<f.firstStart).toBe(true);
  const receipt=await f.issuer.issueOnce(request,signal());expect(receipt.message).toEqual(request.message);expect(f.signer).toHaveBeenCalledOnce();
 });
 it('strictly admits only kind-7 target metadata and preserves its canonical wire',async()=>{
  const f=await setup(),request=f.request(),wire={kind:request.kind,requestId:request.requestId,messageHex:Buffer.from(request.message).toString('hex'),auction:request.auction};
  expect(decodeCharterIssuerWireRequest(wire)).toEqual(request);
  for(const auction of [{round:'00',spot:2},{round:'-1',spot:2},{round:'18446744073709551616',spot:2},{round:'0',spot:100},{round:'0',spot:1.5},{round:'0',spot:2,extra:true}])expect(CharterIssuerWireRequest.safeParse({...wire,auction}).success).toBe(false);
  expect(CharterIssuerWireRequest.safeParse({...wire,extra:true}).success).toBe(false);
  const {auction,...missing}=wire;expect(CharterIssuerWireRequest.safeParse(missing).success).toBe(false);
  for(const kind of ['charter-registration-v1','charter-transfer-v1','charter-lock-v1','charter-retirement-v1'])expect(CharterIssuerWireRequest.safeParse({...wire,kind}).success).toBe(false);
 });
 it('refuses each substituted term role and calendar before signing',async()=>{
  const f=await setup();for(const altered of [{vault:other},{prizeAta:other},{auction:other},{config:other},{mint:other},{prizeOwner:other},{auctionStart:f.terms.auctionStart-1n},{operatingStart:f.terms.operatingStart+1n},{spotId:3}])await expect(f.issuer.issueOnce(f.request(altered),signal())).rejects.toThrow();
  expect(f.signer).not.toHaveBeenCalled();
 });
 it('refuses wrong crank, target mismatch, kind 8 and untrusted request fields',async()=>{
  const f=await setup(),beforeWrongCrank=await readFile(f.journalFile),readsBeforeWrongCrank=f.calls.length;
  await expect(f.issuer.issueOnce(f.request({},other),signal())).rejects.toMatchObject({code:'PURPOSE'});
  expect(await readFile(f.journalFile)).toEqual(beforeWrongCrank);expect(f.calls).toHaveLength(readsBeforeWrongCrank);
  const valid=f.request();for(const input of [{...valid,auction:{round:'0',spot:3}},{...valid,auction:{round:'00',spot:2}},{...valid,extra:true}])await expect(f.issuer.issueOnce(input,signal())).rejects.toThrow();
  const beforeKind8=await readFile(f.journalFile),readsBeforeKind8=f.calls.length;
  const kind8={...valid,message:Buffer.from(valid.message)};kind8.message[72]=8;
  await expect(f.issuer.issueOnce(kind8,signal())).rejects.toMatchObject({code:'PURPOSE'});
  expect(await readFile(f.journalFile)).toEqual(beforeKind8);expect(f.calls).toHaveLength(readsBeforeKind8);expect(f.signer).not.toHaveBeenCalled();
 });
 it('refuses a reused request id with changed auction metadata, including after original completion',async()=>{
  const f=await setup(),request=f.request();await f.issuer.issueOnce(request,signal());
  await expect(f.issuer.issueOnce({...request,auction:{round:'0',spot:3}},signal())).rejects.toThrow();expect(f.signer).toHaveBeenCalledTimes(1);
 });
 for(const mode of ['paused','current policy','at start','after start','expired','too far','already open','RPC failure'] as const)it(`refuses ${mode}`,async()=>{
  const f=await setup(),request=f.request();
  if(mode==='paused'){f.models.authority.admission_paused=true;await f.core();}
  if(mode==='current policy'){f.models.authority.current_policy_key=other;await f.core();}
  if(mode==='at start'||mode==='after start')f.account(SYSVAR_CLOCK_PUBKEY).data.writeBigInt64LE(f.auctionStart+(mode==='after start'?1n:0n),32);
  if(mode==='expired'||mode==='too far')Buffer.from(request.message.buffer,request.message.byteOffset,request.message.byteLength).writeBigInt64LE(mode==='expired'?f.now:f.now+601n,121);
  if(mode==='already open'){f.models.term.opened[0]!|=1<<f.spot;await f.core();}
  if(mode==='RPC failure')f.controls.failAccounts=true;
  await expect(f.issuer.issueOnce(request,signal())).rejects.toThrow();expect(f.signer).not.toHaveBeenCalled();
 });
 it('keeps original receipt recovery available after restart with a rotated key and offline reads',async()=>{
  const f=await setup(),request=f.request(),original=await f.issuer.issueOnce(request,signal());await f.issuer.close();
  const rotated=Keypair.fromSeed(Buffer.alloc(32,34)),signer=vi.fn((message:Uint8Array)=>sign(rotated,message));f.controls.failAccounts=true;
  const resumed=await createCharterPolicyIssuer({...f.options,signer:{publicKey:rotated.publicKey.toBase58(),sign:signer}});cleanups.push(()=>resumed.close());
  expect(await resumed.lookup(request.requestId,signal())).toEqual(original);expect(await resumed.issueOnce(request,signal())).toEqual(original);expect(signer).not.toHaveBeenCalled();
 });
});


/** MS-H2 / S6-S1: disabling new issuance must not consume the journal, while
 * durable recovery and exact request/body conflicts retain their priority. */
describe('MS-H2 S1 disabled kind-7 journal admission and recovery',()=>{
 async function reopenDisabled(f:Awaited<ReturnType<typeof setup>>){
  await f.issuer.close();
  const rotated=Keypair.fromSeed(Buffer.alloc(32,34)),signer=vi.fn((message:Uint8Array)=>sign(rotated,message));
  f.controls.failGenesis=true;f.controls.failAccounts=true;
  // Deliberately omit seekerAuction, rather than supply an unusable reader.
  const issuer=await createCharterPolicyIssuer({journalFile:f.journalFile,trust:f.options.trust,connect:f.connect,
   signer:{publicKey:rotated.publicKey.toBase58(),sign:signer}});
  cleanups.push(()=>issuer.close());return {issuer,signer};
 }
 async function retainPending(f:Awaited<ReturnType<typeof setup>>,request:CharterPolicyIssueRequest){
  await f.issuer.close();
  const journal=await openCharterIssuerJournal(f.journalFile,{genesisHash:f.options.trust.expectedGenesisHash,economyProgram:f.options.trust.economy.programId});
  try{await journal.begin({requestId:request.requestId,kind:request.kind,messageHex:Buffer.from(request.message).toString('hex'),
   publicKey:f.policy.publicKey.toBase58(),auction:request.auction});}finally{await journal.close();}
 }
 it('refuses repeated fresh disabled requests before retaining any pending attempt',async()=>{
  const f=await setup(),{issuer,signer}=await reopenDisabled(f),before=await readFile(f.journalFile),reads=f.calls.length;
  const requests=[f.request(),f.request(),f.request()];
  for(const request of requests)await expect(issuer.issueOnce(request,signal())).rejects.toMatchObject({code:'PURPOSE'});
  expect(await readFile(f.journalFile)).toEqual(before);
  // A rejected fresh request ID stays fresh; it must not become PENDING on retry.
  for(const request of requests){
   expect(await issuer.lookup(request.requestId,signal())).toBeNull();
   await expect(issuer.issueOnce(request,signal())).rejects.toMatchObject({code:'PURPOSE'});
  }
  expect(await readFile(f.journalFile)).toEqual(before);expect(f.calls).toHaveLength(reads);
  expect(f.connect).not.toHaveBeenCalled();expect(f.signer).not.toHaveBeenCalled();expect(signer).not.toHaveBeenCalled();
 });
 it('recovers the original completed receipt after disabling, key rotation and offline reads',async()=>{
  const f=await setup(),request=f.request(),original=await f.issuer.issueOnce(request,signal());
  const {issuer,signer}=await reopenDisabled(f),before=await readFile(f.journalFile),reads=f.calls.length;
  expect(await issuer.lookup(request.requestId,signal())).toEqual(original);
  expect(await issuer.issueOnce(request,signal())).toEqual(original);
  expect(original.publicKey).toBe(f.policy.publicKey.toBase58());
  expect(await readFile(f.journalFile)).toEqual(before);expect(f.calls).toHaveLength(reads);
  expect(f.connect).not.toHaveBeenCalled();expect(f.signer).toHaveBeenCalledOnce();expect(signer).not.toHaveBeenCalled();
 });
 it('preserves a durable pending attempt after disabling instead of replacing it or retrying issuance',async()=>{
  const f=await setup(),request=f.request();await retainPending(f,request);
  const {issuer,signer}=await reopenDisabled(f),before=await readFile(f.journalFile),reads=f.calls.length;
  expect(await issuer.lookup(request.requestId,signal())).toBeNull();
  for(let attempt=0;attempt<2;attempt++)await expect(issuer.issueOnce(request,signal())).rejects.toMatchObject({code:'PENDING'});
  expect(await readFile(f.journalFile)).toEqual(before);expect(f.calls).toHaveLength(reads);
  expect(f.connect).not.toHaveBeenCalled();expect(f.signer).not.toHaveBeenCalled();expect(signer).not.toHaveBeenCalled();
 });
 for(const state of ['pending','completed'] as const)it(`preserves exact request/body conflicts for a ${state} attempt while disabled`,async()=>{
  const f=await setup(),request=f.request();
  if(state==='completed')await f.issuer.issueOnce(request,signal());else await retainPending(f,request);
  const {issuer,signer}=await reopenDisabled(f),before=await readFile(f.journalFile),reads=f.calls.length;
  const changedMessage=Buffer.from(request.message);changedMessage[160]=changedMessage[160]!^1;
  for(const changed of [{...request,message:changedMessage},{...request,auction:{round:'0',spot:3}},{...request,auction:{round:'1',spot:f.spot}}]){
   await expect(issuer.issueOnce(changed,signal())).rejects.toMatchObject({code:'CONFLICT'});
  }
  expect(await readFile(f.journalFile)).toEqual(before);expect(f.calls).toHaveLength(reads);
  expect(f.connect).not.toHaveBeenCalled();expect(f.signer).toHaveBeenCalledTimes(state==='completed'?1:0);expect(signer).not.toHaveBeenCalled();
 });
});
