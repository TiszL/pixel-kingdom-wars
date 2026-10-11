/** T12-T15: actual account bytes and canonical signed messages; RPC seam only. */
import { describe,expect,it } from 'vitest';
import bs58 from 'bs58';
import { ComputeBudgetProgram,Keypair,Message,PublicKey,SYSVAR_CLOCK_PUBKEY,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction,type Connection,type SignatureStatus } from '@solana/web3.js';
import { buildBidMessage,buildWithdrawMessage } from '@shardkeep/chain/seeker-auction-instructions';
import { PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { prepareSeekerBid,prepareSeekerWithdrawal,readSeekerAuctionStatus,submitSeekerAuction,registerSeekerAuctionRoutes,type SeekerAuctionSource } from '../src/seeker/auctionRoutes';
import { createSeekerAuctionFixture,program,wallet,other } from '../../../packages/chain/src/testFixtures/seekerAuctionRead.fixture';
const signer=Keypair.fromSeed(Buffer.alloc(32,1)),otherSigner=Keypair.fromSeed(Buffer.alloc(32,2)),blockhash=new PublicKey(Buffer.alloc(32,211)).toBase58();
const signature=bs58.encode(Buffer.alloc(64,9));
async function fixture(options:Parameters<typeof createSeekerAuctionFixture>[0]={}){
 const f=await createSeekerAuctionFixture(options);const readRpc=f.source.connect(new AbortController().signal);
 const controls={height:3000,omitHeight:false,status:null as SignatureStatus|null,fail:false,relayFail:false,fee:5000 as number|null,slot:2000,statusSlot:2000,finalizedSlot:2000,genesis:f.source.trust.genesisHash};
 const calls:{name:string;args:unknown[]}[]=[],sent:Buffer[]=[];
 const rpc:ReturnType<SeekerAuctionSource['connect']>={...readRpc,
  getGenesisHash:async()=>controls.genesis,
  getLatestBlockhashAndContext:async settings=>{calls.push({name:'blockhash',args:[settings]});return {context:{slot:controls.slot},value:{blockhash,lastValidBlockHeight:3100}};},
  getFeeForMessage:async(message,commitment)=>{calls.push({name:'fee',args:[message,commitment]});return {context:{slot:controls.slot},value:controls.fee};},
  getMinimumBalanceForRentExemption:async(space,commitment)=>{calls.push({name:'rent',args:[space,commitment]});return space*10;},
  getSignatureStatuses:async(signatures,options)=>{calls.push({name:'status',args:[signatures,options]});if(controls.fail)throw Error('transport');return {context:{slot:controls.statusSlot},value:[controls.status]};},
  getEpochInfo:async settings=>{calls.push({name:'epoch',args:[settings]});if(controls.fail)throw Error('transport');return {absoluteSlot:controls.finalizedSlot,...(controls.omitHeight?{}:{blockHeight:controls.height}),epoch:1,slotIndex:1,slotsInEpoch:432000};},
  sendRawTransaction:async(raw:Parameters<Connection['sendRawTransaction']>[0],options)=>{calls.push({name:'send',args:[options]});const bytes=Buffer.from(raw);sent.push(bytes);if(controls.relayFail)throw Error('ambiguous relay transport');return bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);},
 };
 const source:SeekerAuctionSource={trust:f.source.trust,connect:signal=>{signal.throwIfAborted();return rpc;}};
 return {...f,source,controls,calls,sent};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const bid=(f:Fixture,spot=0,newTotal=f.openingBid*3n)=>({round:'0',spot,newTotalRaw:newTotal.toString()});
const withdraw={round:'0',spot:0};
function signed(message:Uint8Array,keys=[signer]){const tx=new VersionedTransaction(Message.from(message));tx.sign(keys);return Buffer.from(tx.serialize()).toString('base64');}
function altered(message:Uint8Array,change:(ix:TransactionInstruction[])=>TransactionInstruction[],payer=wallet,keys=[signer]){
 const decoded=TransactionMessage.decompile(Message.from(message)),m=new TransactionMessage({payerKey:payer,recentBlockhash:blockhash,instructions:change(decoded.instructions)}).compileToLegacyMessage();return signed(m.serialize(),keys);
}
describe('SA-2 T12 prepare bids from finalized state',()=>{
 it('quotes only the increment and RPC-measured network/rent amounts',async()=>{
  const f=await fixture(),existing=await prepareSeekerBid(f.source,wallet.toBase58(),bid(f));
  expect(existing).toMatchObject({blockhash,lastValidBlockHeight:'3100',incrementRaw:(f.openingBid*2n).toString(),networkFeeLamports:'5000',newAccountRentLamports:'0'});
  expect(Message.from(Buffer.from(existing.messageBase64,'base64')).instructions).toHaveLength(1);
  const fresh=await prepareSeekerBid(f.source,wallet.toBase58(),bid(f,2,f.openingBid));
  expect(fresh).toMatchObject({incrementRaw:f.openingBid.toString(),newAccountRentLamports:'830'});
  expect(Message.from(Buffer.from(fresh.messageBase64,'base64')).instructions).toHaveLength(2);
  expect(f.calls.filter(c=>c.name==='rent')).toEqual([{name:'rent',args:[83,'finalized']}]);
  expect(f.calls.filter(c=>c.name==='blockhash').every(c=>(c.args[0] as {commitment:string;minContextSlot:number}).commitment==='finalized'&&(c.args[0] as {minContextSlot:number}).minContextSlot===2000)).toBe(true);
 });
 const defects:[string,(f:Fixture)=>void|Promise<void>][]=[
  ['before window',f=>{f.account(SYSVAR_CLOCK_PUBKEY).data.writeBigInt64LE(f.auctionStart-1n,32);}],
  ['after window',f=>{f.account(SYSVAR_CLOCK_PUBKEY).data.writeBigInt64LE(f.operatingStart,32);}],
  ['paused',async f=>{f.models.authority.admission_paused=true;await f.core();}],
  ['not fully opened',async f=>{f.models.term.opened[12]!&=~8;await f.core();f.store.delete(f.auctionAddresses[99]!.toBase58());}],
  ['missing ATA',f=>{f.store.delete(f.ata.toBase58());}],
  ['insufficient increment',f=>{f.account(f.ata).data.writeBigUInt64LE(1n,64);}],
  ['leader backing',f=>{f.account(f.bidAddresses[1]!).data.writeBigUInt64LE(f.openingBid,73);}],
  ['unavailable fee',f=>{f.controls.fee=null;}],
  ['stale blockhash context',f=>{f.controls.slot=1999;}],
 ];
 for(const[label,mutate]of defects)it(`refuses ${label}`,async()=>{const f=await fixture();await mutate(f);await expect(prepareSeekerBid(f.source,wallet.toBase58(),bid(f,label==='leader backing'?1:0))).rejects.toThrow();expect(f.sent).toHaveLength(0);});
 it('refuses noncurrent rounds, unknown spots and non-increasing/under-opening amounts',async()=>{
  const f=await fixture();for(const request of [{...bid(f),round:'1'},{...bid(f),round:'00'},{...bid(f),spot:100},bid(f,0,f.openingBid*2n),bid(f,2,f.openingBid-1n)])await expect(prepareSeekerBid(f.source,wallet.toBase58(),request)).rejects.toThrow();
 });
});
describe('SA-2 T13 withdraw loses no access during pause',()=>{
 it('prepares losing escrow during pause and measures a missing destination ATA',async()=>{
  const f=await fixture();f.models.authority.admission_paused=true;await f.core();f.store.delete(f.ata.toBase58());
  const result=await prepareSeekerWithdrawal(f.source,wallet.toBase58(),withdraw);expect(result).toMatchObject({incrementRaw:'0',newAccountRentLamports:'1650'});
  expect(Message.from(Buffer.from(result.messageBase64,'base64')).instructions).toHaveLength(2);
 });
 it('prepares and submits old losing escrow beyond the display window while bids stay current-only',async()=>{
  const f=await fixture({round:0n,biddingRound:6n,paused:true});
  const prepared=await prepareSeekerWithdrawal(f.source,wallet.toBase58(),withdraw);
  expect(prepared.incrementRaw).toBe('0');
  await submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:signed(Buffer.from(prepared.messageBase64,'base64'))});expect(f.sent).toHaveLength(1);
  await expect(prepareSeekerBid(f.source,wallet.toBase58(),bid(f))).rejects.toThrow();
 });
 it('refuses current leader, zero/missing escrow and refunded escrow',async()=>{
  const f=await fixture();for(const spot of [1,2])await expect(prepareSeekerWithdrawal(f.source,wallet.toBase58(),{round:'0',spot})).rejects.toThrow();
  f.account(f.bidAddresses[0]!).data.writeBigUInt64LE(0n,73);f.account(f.bidAddresses[0]!).data[81]=1;
  await expect(prepareSeekerWithdrawal(f.source,wallet.toBase58(),withdraw)).rejects.toThrow();
 });
});
describe('SA-1 T15 finalized status observation',()=>{
 it('fails closed before status lookup when finalized epoch data omits blockHeight',async()=>{
  const f=await fixture();f.controls.omitHeight=true;
  await expect(readSeekerAuctionStatus(f.source,signature)).rejects.toMatchObject({statusCode:503,code:'SEEKER_AUCTION_UNAVAILABLE'});
  expect(f.calls).toEqual([{name:'epoch',args:[{commitment:'finalized'}]}]);expect(f.sent).toHaveLength(0);
 });
 it('keeps unknown pending even at a very high finalized height, without creating expiry',async()=>{
  const f=await fixture();f.controls.height=900000;expect(await readSeekerAuctionStatus(f.source,signature)).toEqual({signature,status:'pending',slot:null,error:null,found:false,finalizedBlockHeight:'900000'});
  expect(f.calls).toEqual([{name:'epoch',args:[{commitment:'finalized'}]},{name:'status',args:[[signature],{searchTransactionHistory:true}]}]);
 });
 it('refuses status from a context older than the sampled finalized slot, including an unknown signature',async()=>{
  const f=await fixture();f.controls.statusSlot=1999;
  await expect(readSeekerAuctionStatus(f.source,signature)).rejects.toMatchObject({statusCode:503});
  f.controls.status={slot:1998,confirmations:null,confirmationStatus:'finalized',err:null};
  await expect(readSeekerAuctionStatus(f.source,signature)).rejects.toMatchObject({statusCode:503});
  f.controls.statusSlot=2001;expect(await readSeekerAuctionStatus(f.source,signature)).toMatchObject({status:'finalized',found:true});
 });
 it('only treats finalized success/error as terminal; a confirmed error remains pending',async()=>{
  const f=await fixture();f.controls.status={slot:1999,confirmations:1,confirmationStatus:'confirmed',err:{InstructionError:[0,'InvalidArgument']}};
  expect(await readSeekerAuctionStatus(f.source,signature)).toMatchObject({status:'pending',found:true,error:null});
  f.controls.status.confirmationStatus='finalized';f.controls.status.confirmations=null;
  expect(await readSeekerAuctionStatus(f.source,signature)).toMatchObject({status:'failed',slot:'1999',error:'CHAIN_TRANSACTION_FAILED'});
  f.controls.status.err=null;expect(await readSeekerAuctionStatus(f.source,signature)).toMatchObject({status:'finalized',slot:'1999',error:null});
 });
 it('fails closed for RPC failure, malformed signature/height and genesis mismatch',async()=>{
  const f=await fixture();await expect(readSeekerAuctionStatus(f.source,'bad')).rejects.toThrow();f.controls.fail=true;await expect(readSeekerAuctionStatus(f.source,signature)).rejects.toThrow();
  f.controls.fail=false;f.controls.height=Number.MAX_SAFE_INTEGER+1;await expect(readSeekerAuctionStatus(f.source,signature)).rejects.toThrow();
  f.controls.height=3000;f.controls.genesis=blockhash;await expect(readSeekerAuctionStatus(f.source,signature)).rejects.toThrow();
 });
});
describe('SA-2 T14 signed wire relay',()=>{
 it('relays the exact verified bytes once with maxRetries 0, and signature-only never relays',async()=>{
  const f=await fixture(),prepared=await prepareSeekerBid(f.source,wallet.toBase58(),bid(f)),wire=signed(Buffer.from(prepared.messageBase64,'base64'));
  const result=await submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:wire});expect(result.status).toBe('pending');expect(f.sent).toEqual([Buffer.from(wire,'base64')]);
  expect(f.calls.filter(c=>c.name==='send')).toEqual([{name:'send',args:[{maxRetries:0,skipPreflight:false,preflightCommitment:'confirmed'}]}]);
  await submitSeekerAuction(f.source,wallet.toBase58(),{signature:result.signature});expect(f.sent).toHaveLength(1);
 });
 // V-S6: wallets may refresh a blockhash beyond the finalized bank; confirmed simulation must admit it.
 it('accepts D141 ComputeBudget rewrite and a different blockhash',async()=>{
  const f=await fixture(),m=buildBidMessage(program,{wallet,mint:f.mint,round:0n,spot:0,newTotal:f.openingBid*3n,needsBid:false,blockhash:other.toBase58()}).messageBytes;
  const wire=altered(m,ix=>[ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:375000}),...ix]);
  await submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:wire});expect(f.sent).toHaveLength(1);
 });
 it.each([1,2])('returns observed status for a landed wire at spot %s before re-reading a changed intent',async spot=>{
  const f=await fixture(),prepared=await prepareSeekerBid(f.source,wallet.toBase58(),bid(f,spot)),wire=signed(Buffer.from(prepared.messageBase64,'base64'));
  const first=await submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:wire});expect(f.sent).toHaveLength(1);
  const auction=f.auctionAddresses[spot]!,address=f.bidAddresses[spot]!;
  await f.pack('Bid',address,{version:1,auction,wallet,amount:f.openingBid*3n,refunded:false,
   bump:PublicKey.findProgramAddressSync([Buffer.from('bid'),auction.toBuffer(),wallet.toBuffer()],program)[1]});
  expect(f.store.has(address.toBase58())).toBe(true);
  // Current intent is no longer the original one. Found status is sufficient even if account reads then fail.
  f.store.delete(program.toBase58());
  for(const confirmationStatus of ['confirmed','finalized'] as const){
   f.controls.status={slot:1999,confirmations:confirmationStatus==='finalized'?null:1,confirmationStatus,err:null};
   expect(await submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:wire})).toMatchObject({signature:first.signature,found:true,status:confirmationStatus==='finalized'?'finalized':'pending'});
  }
  expect(f.sent).toHaveLength(1);
 });
 it('fails closed before relaying when the pre-submit signature observation is unavailable',async()=>{
  const f=await fixture(),p=await prepareSeekerBid(f.source,wallet.toBase58(),bid(f));f.controls.fail=true;
  await expect(submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:signed(Buffer.from(p.messageBase64,'base64'))})).rejects.toThrow();expect(f.sent).toHaveLength(0);
 });
 it('accepts an idempotent ATA withdrawal prefix when the destination appeared after prepare',async()=>{
  const f=await fixture(),m=buildWithdrawMessage(program,{wallet,mint:f.mint,round:0n,spot:0,needsDestination:true,blockhash});
  expect(f.store.has(f.ata.toBase58())).toBe(true);
  await submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:signed(m.messageBytes)});expect(f.sent).toHaveLength(1);
 });
 it('does not retry or report failed after an ambiguous relay error',async()=>{
  const f=await fixture(),m=await prepareSeekerBid(f.source,wallet.toBase58(),bid(f));f.controls.relayFail=true;
  const wire=signed(Buffer.from(m.messageBase64,'base64'));expect(await submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:wire})).toMatchObject({status:'pending',found:false});expect(f.sent).toHaveLength(1);
 });
 it('refuses another wallet intent and a mixed spot open/place pair',async()=>{
  const f=await fixture(),wrong=buildBidMessage(program,{wallet:other,mint:f.mint,round:0n,spot:2,newTotal:f.openingBid,needsBid:true,blockhash});
  await expect(submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:signed(wrong.messageBytes,[otherSigner])})).rejects.toThrow();
  const a=buildBidMessage(program,{wallet,mint:f.mint,round:0n,spot:2,newTotal:f.openingBid,needsBid:true,blockhash}),b=buildBidMessage(program,{wallet,mint:f.mint,round:0n,spot:3,newTotal:f.openingBid,needsBid:true,blockhash});
  const different=TransactionMessage.decompile(Message.from(b.messageBytes)).instructions;
  await expect(submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:altered(a.messageBytes,ix=>[ix[0]!,different[1]!])})).rejects.toThrow();expect(f.sent).toHaveLength(0);
 });
 const mutations:[string,(ix:TransactionInstruction[])=>TransactionInstruction[]][]=[
  ['extra transfer',ix=>[...ix,SystemProgram.transfer({fromPubkey:wallet,toPubkey:other,lamports:1})]],
  ['memo',ix=>[...ix,new TransactionInstruction({programId:new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),keys:[],data:Buffer.from('x')})]],
  ['second place',ix=>[...ix,ix[0]!]],
  ['privilege escalation',ix=>{const key=ix[0]!.keys.find(k=>!k.isWritable&&!k.isSigner)!;key.isWritable=true;return ix;}],
  ['compute tag0',ix=>[new TransactionInstruction({programId:ComputeBudgetProgram.programId,keys:[],data:Buffer.alloc(9)}),...ix]],
  ['compute tag1',ix=>[new TransactionInstruction({programId:ComputeBudgetProgram.programId,keys:[],data:Buffer.of(1,0,0,1,0)}),...ix]],
  ['compute under wrong program',ix=>{const cb=ComputeBudgetProgram.setComputeUnitLimit({units:200000});cb.programId=other;return[cb,...ix];}],
  ['duplicate compute',ix=>[ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitLimit({units:200000}),...ix]],
  ['compute accounts',ix=>{const cb=ComputeBudgetProgram.setComputeUnitLimit({units:200000});cb.keys.push({pubkey:other,isSigner:false,isWritable:false});return[cb,...ix];}],
  ['overbound fee',ix=>[ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:BigInt(PHASE_E_SEEKER_AUCTION_RUNTIME.maxWalletAddedPriorityFeeLamports)+1n}),...ix]],
  ['advance nonce',ix=>[SystemProgram.nonceAdvance({noncePubkey:other,authorizedPubkey:wallet}),...ix]],
 ];
 for(const[label,mutate]of mutations)it(`refuses ${label} before any relay`,async()=>{const f=await fixture(),p=await prepareSeekerBid(f.source,wallet.toBase58(),bid(f));await expect(submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:altered(Buffer.from(p.messageBase64,'base64'),mutate)})).rejects.toThrow();expect(f.sent).toHaveLength(0);});
 it('refuses changed payer, extra signer, bad signature, v0 and oversized packets',async()=>{
  const f=await fixture(),p=await prepareSeekerBid(f.source,wallet.toBase58(),bid(f)),bytes=Buffer.from(p.messageBase64,'base64');
  const payer=altered(bytes,ix=>ix,other,[otherSigner,signer]);
  const extra=altered(bytes,ix=>{ix[0]!.keys.push({pubkey:other,isSigner:true,isWritable:false});return ix;},wallet,[signer,otherSigner]);
  const bad=Buffer.from(signed(bytes),'base64');bad[1]!^=1;
  const d=TransactionMessage.decompile(Message.from(bytes)),v0=new VersionedTransaction(new TransactionMessage(d).compileToV0Message());v0.sign([signer]);
  for(const wire of [payer,extra,bad.toString('base64'),Buffer.from(v0.serialize()).toString('base64'),Buffer.alloc(1233).toString('base64')])await expect(submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:wire})).rejects.toThrow();expect(f.sent).toHaveLength(0);
 });
 it('refuses a withdrawal redirected to a noncanonical destination',async()=>{
  const f=await fixture(),m=buildWithdrawMessage(program,{wallet,mint:f.mint,round:0n,spot:0,needsDestination:false,blockhash});
  const wire=altered(m.messageBytes,ix=>{const target=ix[0]!.keys.find(k=>k.pubkey.equals(f.ata))!;target.pubkey=other;return ix;});
  await expect(submitSeekerAuction(f.source,wallet.toBase58(),{signedTransaction:wire})).rejects.toThrow();expect(f.sent).toHaveLength(0);
 });
});

// B2 F5: polling must not consume the 2FA write/admission budget.
it('gives auction reads their own bounded polling budget and keeps writes separately limited',()=>{
 const routes:{method:string;path:string;options:{config:{rateLimit:{max:number;timeWindow:number}}}}[]=[];
 const app={authenticate:()=>{},get:(path:string,options:{config:{rateLimit:{max:number;timeWindow:number}}})=>routes.push({method:'GET',path,options}),post:(path:string,options:{config:{rateLimit:{max:number;timeWindow:number}}})=>routes.push({method:'POST',path,options})};
 registerSeekerAuctionRoutes(app as never);
 const read={max:PHASE_E_SEEKER_AUCTION_RUNTIME.readRateLimitPerMin,timeWindow:60_000};
 const refundRead={max:PHASE_E_SEEKER_AUCTION_RUNTIME.refundReadRateLimitPerMin,timeWindow:60_000};
 const write={max:PHASE_E_SEEKER_AUCTION_RUNTIME.writeRateLimitPerMin,timeWindow:60_000};
 // Refund discovery has its own wallet-wide budget; every route remains exact.
 expect(routes.filter(r=>r.method==='GET').map(r=>({path:r.path,...r.options.config.rateLimit}))).toEqual([
  {path:'/seeker/auctions/current',...read},
  {path:'/seeker/auctions/refunds',...refundRead},
  {path:'/seeker/auctions/round/:round',...read},
  {path:'/seeker/auctions/tx/:signature',...read},
 ]);
 expect(routes.filter(r=>r.method==='POST').map(r=>({path:r.path,...r.options.config.rateLimit}))).toEqual([
  {path:'/seeker/auctions/bids/prepare',...write},
  {path:'/seeker/auctions/withdrawals/prepare',...write},
  {path:'/seeker/auctions/submit',...write},
 ]);
});
