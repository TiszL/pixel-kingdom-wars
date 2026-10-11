/** SA-4 W3/W4 and T15 UI-state/callback contract; no screen or real RPC. */
import {describe,expect,it,vi} from 'vitest';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {Keypair,PublicKey,Transaction} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import type {SeekerAuctionPrepared,SeekerAuctionSourcedRoundView,SeekerAuctionTxStatus} from '@shardkeep/shared/seekerAuctionApi';
import type {GameWallet} from '../../auth/useGameWallet';
import {buildBidMessage,buildWithdrawMessage} from '../../../../../packages/chain/src/seekerAuctionInstructions';
import {seekerAuctionConfigPda} from '../../../../../packages/chain/src/seekerAuctionProtocol';
import idl from '../../../../../packages/chain/src/idl/shardkeep_economy.json' with {type:'json'};
import type {SeekerAuctionTransport} from './transport';
import {SeekerAuctionController,type SeekerAuctionState} from './controller';

const P=PHASE_E_POLICY.seekerIsland,A=PHASE_E_SEEKER_AUCTION,key=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n));
const height='9007199254740993',token=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associated=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const bid={round:'0',spot:20,newTotalRaw:'12345678'},withdraw={round:'0',spot:21};
function setup(){
 const signer=key(1),program=new PublicKey(idl.address),mint=key(2).publicKey,owner=key(3).publicKey,blockhash=key(4).publicKey.toBase58();
 // S6-M1 fixture successor: independent application identity also pins the program.
 const first=1791158400n,identity={programId:program.toBase58(),mint:mint.toBase58(),decimals:6};
 const view:SeekerAuctionSourcedRoundView={version:1,source:'chain',chainUnixTime:String(first-1n),walletSkrRaw:'1234567890123',wallet:signer.publicKey.toBase58(),observedSlot:'200',round:'0',biddingRound:'0',admissionPaused:false,
  config:{programId:program.toBase58(),address:seekerAuctionConfigPda(program).toBase58(),mint:identity.mint,decimals:identity.decimals,
   prizeOwner:owner.toBase58(),prizeAta:PublicKey.findProgramAddressSync([owner.toBuffer(),token.toBuffer(),mint.toBuffer()],associated)[0].toBase58(),
   openingBidRaw:'10000000',firstOperatingStart:String(first),termSec:String(P.operatingTermSec),auctionSec:String(P.overlappingAuctionSec),graceSec:String(A.settlementGraceSec)},
  auctionStart:String(first-BigInt(P.overlappingAuctionSec)),auctionEnd:String(first),operatingStart:String(first),operatingEnd:String(first+BigInt(P.operatingTermSec)),
  openedCount:P.totalSpots,completedCount:0,winnerCount:0,completedAt:null,
  spots:Array.from({length:P.totalSpots},(_,spot)=>({spot,class:spot<P.kingSpots?'king':'regular',realmMask:spot<P.kingSpots?(1<<P.realmCount)-1:
   Array.from({length:A.regularRealmCount},(_,n)=>n).reduce((mask,n)=>mask|(1<<((spot-P.kingSpots+n)%P.realmCount)),0),
   opened:true,highBidRaw:'0',highBidder:null,settled:false,yourBidRaw:'0',refundable:false}))};
 Object.assign(view.spots[withdraw.spot]!,{highBidRaw:'11000000',highBidder:key(5).publicKey.toBase58(),yourBidRaw:'10000000',refundable:true});
 let signature=bs58.encode(Buffer.alloc(64,8));
 const sign=vi.fn(async(tx:Transaction)=>{tx.partialSign(signer);signature=bs58.encode(tx.signature!);return tx;});
 const send=vi.fn(async(_tx:Transaction)=>signature);
 const wallet:GameWallet={publicKey:signer.publicKey,signMessage:null,isEmbedded:false,signTransaction:sign,sendTransaction:send};
 const pending=():SeekerAuctionTxStatus=>({signature,status:'pending',slot:null,error:null,found:false,finalizedBlockHeight:String(BigInt(height)-1n)});
 const preparation=(kind:'bid'|'withdraw',request:{round:string;spot:number;newTotalRaw?:string}):SeekerAuctionPrepared=>{
  const target={wallet:signer.publicKey,mint,round:BigInt(request.round),spot:request.spot,blockhash};
  const plan=kind==='bid'?buildBidMessage(program,{...target,newTotal:BigInt(request.newTotalRaw!),needsBid:true}):buildWithdrawMessage(program,{...target,needsDestination:true});
  return {messageBase64:Buffer.from(plan.messageBytes).toString('base64'),blockhash,lastValidBlockHeight:height,
   incrementRaw:kind==='bid'?request.newTotalRaw!:'0',networkFeeLamports:'5000',newAccountRentLamports:'1000'};
 };
 const transport={
  refunds:vi.fn<SeekerAuctionTransport['refunds']>(async()=>({version:1,source:'chain',wallet:view.wallet,observedSlot:view.observedSlot,chainUnixTime:view.chainUnixTime,programId:view.config.programId,config:view.config.address,mint:view.config.mint,decimals:view.config.decimals,entries:[],nextCursor:null})),
  current:vi.fn<SeekerAuctionTransport['current']>(async()=>structuredClone(view)),
  round:vi.fn<SeekerAuctionTransport['round']>(async()=>structuredClone(view)),
  prepareBid:vi.fn<SeekerAuctionTransport['prepareBid']>(async request=>preparation('bid',request)),
  prepareWithdraw:vi.fn<SeekerAuctionTransport['prepareWithdraw']>(async request=>preparation('withdraw',request)),
  submit:vi.fn<SeekerAuctionTransport['submit']>(async()=>pending()),
  status:vi.fn<SeekerAuctionTransport['status']>(async()=>pending()),
 } satisfies SeekerAuctionTransport;
 const onChange=vi.fn<(state:SeekerAuctionState)=>void>();
 const controller=new SeekerAuctionController({transport,wallet:()=>wallet,identity,onChange});
 return {controller,transport,wallet,sign,send,onChange,view,identity,preparation,pending,signature:()=>signature};
}

describe('SA-4 public Seeker auction state and callbacks for the Opus mount',()=>{
 it('exposes a sourced ready view and raw costs without fabricating an unavailable wallet balance',async()=>{
  const f=setup();await f.controller.load();
  expect(f.controller.snapshot()).toMatchObject({status:'ready',view:f.view,canTransact:true,canRetry:false,notEnough:null,costs:null,error:null,operation:null,receipt:null});
  await f.controller.bid(bid);
  expect(f.controller.snapshot()).toMatchObject({status:'pending',canTransact:false,canRetry:false,notEnough:null,
   costs:{incrementRaw:bid.newTotalRaw,networkFeeLamports:'5000',newAccountRentLamports:'1000'},receipt:f.pending(),
   operation:{kind:'bid',round:'0',spot:bid.spot,newTotalRaw:bid.newTotalRaw,signature:f.signature(),lastValidBlockHeight:height}});
  const statuses=f.onChange.mock.calls.map(([state])=>state.status);
  for(const status of ['loading','ready','preparing','awaiting-wallet','submitting','pending'])expect(statuses).toContain(status);
  expect(f.sign).toHaveBeenCalledOnce();expect(f.send).not.toHaveBeenCalled();
  expect(f.transport.submit.mock.calls[0]![0]).toEqual({signedTransaction:expect.any(String)});
 });
 it('W4 reports hidden only for the null current probe, and unavailable on a failed probe',async()=>{
  const f=setup();f.transport.current.mockResolvedValue(null);await f.controller.load();
  expect(f.controller.snapshot()).toMatchObject({status:'hidden',view:null,canTransact:false,canRetry:false});
  await f.controller.bid(bid);await f.controller.withdraw(withdraw);expect(f.transport.prepareBid).not.toHaveBeenCalled();expect(f.transport.prepareWithdraw).not.toHaveBeenCalled();
  const g=setup();g.transport.current.mockRejectedValue(Error('RPC unavailable'));await g.controller.load();
  expect(g.controller.snapshot()).toMatchObject({status:'unavailable',view:null,canTransact:false,canRetry:false});expect(g.controller.snapshot().error).toBeTruthy();
 });
 it('keeps TEST DATA visible but makes both money callbacks inert',async()=>{
  const f=setup();f.view.source='fixture';await f.controller.load();
  expect(f.controller.snapshot()).toMatchObject({status:'ready',view:{source:'fixture'},canTransact:false});
  await f.controller.bid(bid);await f.controller.withdraw(withdraw);
  expect(f.transport.prepareBid).not.toHaveBeenCalled();expect(f.transport.prepareWithdraw).not.toHaveBeenCalled();expect(f.sign).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
 });
 it('allows read-only display when the independent SKR identity is unavailable',async()=>{
  const f=setup(),controller=new SeekerAuctionController({transport:f.transport,wallet:()=>f.wallet,identity:null});
  await controller.load();expect(controller.snapshot()).toMatchObject({status:'ready',view:f.view,canTransact:false,notEnough:null});
  await controller.bid(bid);await controller.withdraw(withdraw);expect(f.transport.prepareBid).not.toHaveBeenCalled();expect(f.transport.prepareWithdraw).not.toHaveBeenCalled();expect(f.sign).not.toHaveBeenCalled();
 });
 it('uses an explicit historical GET without silently replacing the requested round',async()=>{
  const f=setup();await f.controller.load('0');expect(f.transport.round.mock.calls[0]!.slice(0,2)).toEqual([f.view.wallet,'0']);expect(f.transport.current).not.toHaveBeenCalled();
 });
 it('W2 rejects a substituted server message or identity mismatch before opening the wallet',async()=>{
  const f=setup();await f.controller.load();
  f.transport.prepareBid.mockImplementation(async()=>f.preparation('bid',{...bid,spot:bid.spot+1}));await f.controller.bid(bid);
  expect(f.controller.snapshot().error).toBeTruthy();expect(f.sign).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();expect(f.transport.submit).not.toHaveBeenCalled();
  const g=setup();g.identity.mint=key(9).publicKey.toBase58();await g.controller.load();await g.controller.bid(bid);expect(g.sign).not.toHaveBeenCalled();expect(g.transport.submit).not.toHaveBeenCalled();
 });
 it('W3 submits only a signature for send-only bid and withdrawal, retaining unknown expiry',async()=>{
  for(const kind of ['bid','withdraw'] as const){
   const f=setup();f.wallet.signTransaction=null;await f.controller.load();
   if(kind==='bid')await f.controller.bid(bid);else await f.controller.withdraw(withdraw);
   expect(f.send).toHaveBeenCalledOnce();expect(f.sign).not.toHaveBeenCalled();
   expect(f.transport.submit.mock.calls[0]![0]).toEqual({signature:f.signature()});
   expect(f.controller.snapshot()).toMatchObject({status:'pending',operation:{kind,signature:f.signature(),lastValidBlockHeight:null},canRetry:false});
   f.transport.status.mockResolvedValue({...f.pending(),finalizedBlockHeight:String(BigInt(height)+1000n)});await f.controller.poll();
   expect(f.controller.snapshot()).toMatchObject({status:'pending',canRetry:false});expect(f.send).toHaveBeenCalledOnce();
  }
 });
 it('does not repeat any prepare/wallet/submit while an attempt is pending, including concurrent callbacks',async()=>{
  const f=setup();await f.controller.load();await Promise.all([f.controller.bid(bid),f.controller.bid(bid)]);
  await f.controller.bid(bid);await f.controller.withdraw(withdraw);await f.controller.load();await f.controller.poll();
  expect(f.transport.prepareBid).toHaveBeenCalledOnce();expect(f.transport.prepareWithdraw).not.toHaveBeenCalled();expect(f.sign).toHaveBeenCalledOnce();expect(f.transport.submit).toHaveBeenCalledOnce();
  expect(f.controller.snapshot().status).toBe('pending');
 });
 it('retains a known local signature after ambiguous submit failure and polls it without automatic resubmission',async()=>{
  const f=setup();f.transport.submit.mockRejectedValue(Error('response lost'));await f.controller.load();await f.controller.bid(bid);
  expect(f.controller.snapshot()).toMatchObject({status:'pending',operation:{signature:f.signature(),lastValidBlockHeight:height},canRetry:false});
  await f.controller.poll();expect(f.transport.status.mock.calls[0]![0]).toBe(f.signature());expect(f.transport.submit).toHaveBeenCalledOnce();expect(f.sign).toHaveBeenCalledOnce();
 });
 it('rechecks wallet identity after asynchronous preparation and keeps late signed evidence without submitting under a changed account',async()=>{
  const f=setup();await f.controller.load();f.transport.prepareBid.mockImplementation(async request=>{f.wallet.publicKey=key(9).publicKey;return f.preparation('bid',request);});
  await f.controller.bid(bid);expect(f.sign).not.toHaveBeenCalled();expect(f.transport.submit).not.toHaveBeenCalled();
  const g=setup();await g.controller.load();g.sign.mockImplementation(async tx=>{tx.partialSign(key(1));g.wallet.publicKey=key(9).publicKey;return tx;});await g.controller.bid(bid);
  expect(g.transport.submit).not.toHaveBeenCalled();expect(g.controller.snapshot().operation?.signature).toBeTruthy();expect(g.controller.snapshot().canRetry).toBe(false);
 });
});

describe('SA-4 T15 finalized expiry proof is the only unknown-signature retry gate',()=>{
 it.each([
  {name:'below retained height',fields:{found:false,finalizedBlockHeight:String(BigInt(height)-1n)},expected:'pending'},
  {name:'equal retained height',fields:{found:false,finalizedBlockHeight:height},expected:'pending'},
  {name:'one beyond retained height',fields:{found:false,finalizedBlockHeight:String(BigInt(height)+1n)},expected:'expired'},
  {name:'found on chain even beyond retained height',fields:{found:true,finalizedBlockHeight:String(BigInt(height)+1n)},expected:'pending'},
  {name:'legacy unknown without height',fields:{},expected:'pending'},
 ])('$name is $expected and never automatically resends',async({fields,expected})=>{
  const f=setup();await f.controller.load();await f.controller.bid(bid);
  f.transport.status.mockResolvedValue({signature:f.signature(),status:'pending',slot:null,error:null,...fields});await f.controller.poll();
  expect(f.controller.snapshot()).toMatchObject({status:expected,canRetry:expected==='expired'});
  expect(f.transport.prepareBid).toHaveBeenCalledOnce();expect(f.sign).toHaveBeenCalledOnce();expect(f.send).not.toHaveBeenCalled();expect(f.transport.submit).toHaveBeenCalledOnce();
 });
 it('offers expiry without dispatch; a new explicit bid is required to prepare and sign a new attempt',async()=>{
  const f=setup();await f.controller.load();await f.controller.bid(bid);
  f.transport.status.mockResolvedValue({...f.pending(),finalizedBlockHeight:String(BigInt(height)+1n)});await f.controller.poll();await f.controller.poll();
  expect(f.controller.snapshot().canRetry).toBe(true);expect(f.sign).toHaveBeenCalledOnce();
  await f.controller.bid({...bid,newTotalRaw:'13000000'});expect(f.transport.prepareBid).toHaveBeenCalledTimes(2);expect(f.sign).toHaveBeenCalledTimes(2);expect(f.transport.submit).toHaveBeenCalledTimes(2);
 });
 it('keeps pending evidence on RPC outage, malformed partial height, and a status for another signature',async()=>{
  for(const failure of ['rpc','partial','wrong-signature'] as const){
   const f=setup();await f.controller.load();await f.controller.bid(bid);
   if(failure==='rpc')f.transport.status.mockRejectedValue(Error('RPC unavailable'));
   else f.transport.status.mockResolvedValue(failure==='partial'?{signature:f.signature(),status:'pending',slot:null,error:null,found:false}:
    {...f.pending(),signature:bs58.encode(Buffer.alloc(64,9)),finalizedBlockHeight:String(BigInt(height)+1n)});
   await f.controller.poll();expect(f.controller.snapshot()).toMatchObject({status:'pending',canRetry:false,operation:{signature:f.signature()}});
   expect(f.controller.snapshot().error).toBeTruthy();expect(f.transport.submit).toHaveBeenCalledOnce();expect(f.sign).toHaveBeenCalledOnce();
  }
 });
 it('refreshes the read model only after finalized success and exposes finalized chain errors without a resend',async()=>{
  for(const status of ['finalized','failed'] as const){
   const f=setup();await f.controller.load();await f.controller.bid(bid);
   f.transport.status.mockResolvedValue({...f.pending(),status,found:true,slot:'251',error:status==='failed'?'CHAIN_TRANSACTION_FAILED':null});
   await f.controller.poll();expect(f.controller.snapshot()).toMatchObject({status,canRetry:false,receipt:{signature:f.signature(),status,slot:'251'}});
   if(status==='finalized')expect(f.transport.current).toHaveBeenCalledTimes(2);else expect(f.controller.snapshot().error).toBeTruthy();
   expect(f.transport.submit).toHaveBeenCalledOnce();expect(f.sign).toHaveBeenCalledOnce();
  }
 });
});

describe('S6-M1 controller program-pin admission',()=>{
 it.each(['foreign response','mismatched pin','missing pin'] as const)('keeps round money callbacks inert for a %s while the mint remains pinned',async defect=>{
  const f=setup(),foreign=key(9).publicKey;
  if(defect==='foreign response'){f.view.config.programId=foreign.toBase58();f.view.config.address=seekerAuctionConfigPda(foreign).toBase58();}
  else if(defect==='mismatched pin')f.identity.programId=foreign.toBase58();
  else delete (f.identity as {programId?:string}).programId;
  await f.controller.load();
  expect(f.identity.mint).toBe(f.view.config.mint);
  expect(f.controller.snapshot()).toMatchObject({status:'ready',view:f.view,canTransact:false,canRetry:false});
  await f.controller.bid(bid);await f.controller.withdraw(withdraw);
  expect(f.transport.prepareBid).not.toHaveBeenCalled();expect(f.transport.prepareWithdraw).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();expect(f.transport.submit).not.toHaveBeenCalled();
 });
 it.each(['bid','withdraw'] as const)('rechecks the captured program identity after asynchronous %s preparation',async kind=>{
  const f=setup();await f.controller.load();expect(f.controller.snapshot().canTransact).toBe(true);
  if(kind==='bid'){
   f.transport.prepareBid.mockImplementationOnce(async request=>{f.identity.programId=key(9).publicKey.toBase58();return f.preparation('bid',request);});
   await f.controller.bid(bid);expect(f.transport.prepareBid).toHaveBeenCalledOnce();
  }else{
   f.transport.prepareWithdraw.mockImplementationOnce(async request=>{f.identity.programId=key(9).publicKey.toBase58();return f.preparation('withdraw',request);});
   await f.controller.withdraw(withdraw);expect(f.transport.prepareWithdraw).toHaveBeenCalledOnce();
  }
  expect(f.controller.snapshot().canTransact).toBe(false);expect(f.controller.snapshot().error).toBeTruthy();
  expect(f.sign).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();expect(f.transport.submit).not.toHaveBeenCalled();
 });
});
