/** Beacon4dbfed12 old-refund browser binding; no fabricated whole-round view. */
import {expect,it,vi} from 'vitest';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {Keypair,Message,PublicKey,Transaction} from '@solana/web3.js';
import type {GameWallet} from '../../auth/useGameWallet';
import type {SeekerAuctionRefundsPage} from '@shardkeep/shared/seekerAuctionRefundsApi';
import {buildWithdrawMessage} from '../../../../../packages/chain/src/seekerAuctionInstructions';
import {seekerAuctionConfigPda,seekerAuctionPda,seekerBidPda} from '../../../../../packages/chain/src/seekerAuctionProtocol';
import idl from '../../../../../packages/chain/src/idl/shardkeep_economy.json' with {type:'json'};
import {createSeekerAuctionTransport,type SeekerAuctionTransport} from './transport';
import {prepareSeekerAuctionRefundSigning,signSeekerAuction} from './signing';
import {SeekerAuctionController} from './controller';
const key=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n)),request={round:'0',spot:20};
function fixture(setup=false){
 const signer=key(1),program=new PublicKey(idl.address),mint=key(2).publicKey,blockhash=key(3).publicKey.toBase58(),config=seekerAuctionConfigPda(program);
 // S6-M1 fixture successor: independent application identity also pins the program.
 const auction=seekerAuctionPda(program,config,request.spot,0n),bid=seekerBidPda(program,auction,signer.publicKey),identity={programId:program.toBase58(),mint:mint.toBase58(),decimals:6};
 const page:SeekerAuctionRefundsPage={version:1,source:'chain',wallet:signer.publicKey.toBase58(),observedSlot:'2000',chainUnixTime:'1800000000',programId:program.toBase58(),
  config:config.toBase58(),mint:mint.toBase58(),decimals:6,entries:[{bid:bid.toBase58(),auction:auction.toBase58(),...request,amountRaw:'9007199254740993'}],nextCursor:null};
 const plan=buildWithdrawMessage(program,{wallet:signer.publicKey,mint,round:0n,spot:request.spot,needsDestination:setup,blockhash});
 const prepared={messageBase64:Buffer.from(plan.messageBytes).toString('base64'),blockhash,lastValidBlockHeight:'3100',incrementRaw:'0',networkFeeLamports:'5000',newAccountRentLamports:setup?'1650':'0'};
 let signature=bs58.encode(Buffer.alloc(64,8));
 const wallet:GameWallet={publicKey:signer.publicKey,signMessage:null,isEmbedded:false,
  signTransaction:vi.fn(async(tx:Transaction)=>{tx.partialSign(signer);signature=bs58.encode(tx.signature!);return tx;}),sendTransaction:vi.fn(async()=>signature)};
 return {signer,program,mint,identity,page,prepared,plan,wallet,signature:()=>signature};
}
it('queries strict wallet-bound refund pages and never maps an unavailable or404 page to empty',async()=>{
 const f=fixture(),fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify(f.page),{status:200}));
 const transport=createSeekerAuctionTransport({apiBase:'https://game.test/api',fetch});
 expect(await transport.refunds(f.page.wallet)).toEqual(f.page);
 expect(fetch.mock.calls[0]![0]).toBe('https://game.test/api/seeker/auctions/refunds');
 const after={round:'0',spot:10};expect(await transport.refunds(f.page.wallet,{after})).toEqual(f.page);
 expect(fetch.mock.calls[1]![0]).toBe('https://game.test/api/seeker/auctions/refunds?round=0&spot=10');
 await expect(transport.refunds(f.page.wallet,{after:{round:'../0',spot:0}})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
 fetch.mockImplementation(async()=>new Response('{}',{status:404}));await expect(transport.refunds(f.page.wallet)).rejects.toThrow();
 fetch.mockImplementation(async()=>new Response(JSON.stringify({...f.page,wallet:key(9).publicKey.toBase58()}),{status:200}));await expect(transport.refunds(f.page.wallet)).rejects.toThrow();
});
it.each([false,true])('rebuilds exact old-refund canonical bytes with optional ATA=%s and existing wallet verification',async setup=>{
 const f=fixture(setup),proof=await prepareSeekerAuctionRefundSigning({page:f.page,request,prepared:f.prepared,identity:f.identity});
 const result=await signSeekerAuction(proof,f.wallet);expect('signedTransaction'in result.submission).toBe(true);
 if(!('signedTransaction'in result.submission))throw Error('signed only expected');
 // Canonical equality is every byte and its order, independent of Buffer realms.
 expect(Array.from(Transaction.from(Buffer.from(result.submission.signedTransaction,'base64')).serializeMessage())).toEqual(Array.from(f.plan.messageBytes));
 expect(result.lastValidBlockHeight).toBe('3100');
});
it('refuses an unlisted refund, forged context or canonical address, nonzero increment and altered message before wallet',async()=>{
 const changes=[(f:ReturnType<typeof fixture>)=>{f.page.entries=[];},(f:ReturnType<typeof fixture>)=>{f.page.entries[0]!.bid=key(9).publicKey.toBase58();},
  (f:ReturnType<typeof fixture>)=>{f.page.entries[0]!.auction=key(9).publicKey.toBase58();},(f:ReturnType<typeof fixture>)=>{f.page.config=key(9).publicKey.toBase58();},
  (f:ReturnType<typeof fixture>)=>{f.page.source='fixture' as never;},(f:ReturnType<typeof fixture>)=>{f.identity.mint=key(9).publicKey.toBase58();},
  (f:ReturnType<typeof fixture>)=>{f.prepared.incrementRaw='1';},(f:ReturnType<typeof fixture>)=>{const tx=Transaction.populate(Message.from(f.plan.messageBytes));tx.instructions.at(-1)!.keys[5]!.pubkey=key(9).publicKey;f.prepared.messageBase64=Buffer.from(tx.serializeMessage()).toString('base64');}];
 for(const change of changes){const f=fixture();change(f);await expect(prepareSeekerAuctionRefundSigning({page:f.page,request,prepared:f.prepared,identity:f.identity})).rejects.toThrow();expect(f.wallet.signTransaction).not.toHaveBeenCalled();expect(f.wallet.sendTransaction).not.toHaveBeenCalled();}
});
function controllerFixture(){
 const f=fixture(),pending=()=>({signature:f.signature(),status:'pending' as const,slot:null,error:null,found:false,finalizedBlockHeight:'3000'});
 const transport={current:vi.fn(async()=>{throw Error('whole view unavailable');}),round:vi.fn(async()=>{throw Error('old round outside display window');}),
  refunds:vi.fn<SeekerAuctionTransport['refunds']>(async()=>structuredClone(f.page)),prepareBid:vi.fn(async()=>f.prepared),prepareWithdraw:vi.fn(async()=>f.prepared),
  submit:vi.fn(async()=>pending()),status:vi.fn(async()=>pending())} satisfies SeekerAuctionTransport;
 const controller=new SeekerAuctionController({transport,wallet:()=>f.wallet,identity:f.identity});return {...f,transport,controller,pending};
}
it('keeps older refunds unavailable as an explicit error and retains the last valid page',async()=>{
 const f=controllerFixture();await f.controller.loadRefunds();expect(f.controller.snapshot()).toMatchObject({refunds:{status:'ready',page:f.page,error:null},canWithdrawRefunds:true});
 f.transport.refunds.mockRejectedValue(Error('RPC unavailable'));await f.controller.loadRefunds();
 expect(f.controller.snapshot()).toMatchObject({refunds:{status:'unavailable',page:f.page},canWithdrawRefunds:false});expect(f.controller.snapshot().refunds.error).toContain('Older refunds could not be checked');
 await f.controller.withdrawRefund(request);expect(f.transport.prepareWithdraw).not.toHaveBeenCalled();
});
it('withdraws a listed old refund without loading or manufacturing a whole-round view and retains its pending proof',async()=>{
 const f=controllerFixture();await f.controller.loadRefunds();await f.controller.withdrawRefund(request);
 expect(f.transport.round).not.toHaveBeenCalled();expect(f.transport.current).not.toHaveBeenCalled();expect(f.transport.prepareWithdraw).toHaveBeenCalledExactlyOnceWith(request);
 expect(f.controller.snapshot()).toMatchObject({status:'pending',view:null,canWithdrawRefunds:false,operation:{kind:'withdraw',round:'0',spot:20,signature:f.signature()},receipt:f.pending()});
 await f.controller.withdrawRefund(request);expect(f.transport.submit).toHaveBeenCalledOnce();
});
it('uses signature-only submission for send-only refunds and refreshes refunds after finality',async()=>{
 const f=controllerFixture();f.wallet.signTransaction=null;await f.controller.loadRefunds();await f.controller.withdrawRefund(request);
 expect(f.transport.submit).toHaveBeenCalledExactlyOnceWith({signature:f.signature()});
 f.transport.status.mockResolvedValue({...f.pending(),status:'finalized' as never,slot:'2000' as never,found:true});
 f.transport.refunds.mockResolvedValue({...f.page,entries:[]});await f.controller.poll();
 expect(f.controller.snapshot()).toMatchObject({status:'finalized',refunds:{status:'ready',page:{entries:[]}}});
});

/** MS-H static-review successor: refund retry, independent reads and wallet
 * disclosure. All preceding frozen cases remain byte-for-byte unchanged. */
function refundDeferred<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((accept,decline)=>{resolve=accept;reject=decline;});
 return {promise,resolve,reject};
}
it.each([
 {name:'below retained height',fields:{found:false,finalizedBlockHeight:'3099'},expired:false},
 {name:'equal retained height',fields:{found:false,finalizedBlockHeight:'3100'},expired:false},
 {name:'strictly greater finalized height',fields:{found:false,finalizedBlockHeight:'3101'},expired:true},
 {name:'found despite greater height',fields:{found:true,finalizedBlockHeight:'3101'},expired:false},
 {name:'legacy unknown height',fields:{},expired:false},
 {name:'malformed partial height evidence',fields:{found:false},expired:false},
])('refund successor: $name controls the refund-only retry flag without any automatic resend',async({fields,expired})=>{
 const f=controllerFixture(),transport:SeekerAuctionTransport=f.transport;
 await f.controller.loadRefunds();await f.controller.withdrawRefund(request);
 // The partial-evidence row deliberately supplies an invalid external response.
 const response={signature:f.signature(),status:'pending',slot:null,error:null,...fields} as Awaited<ReturnType<SeekerAuctionTransport['status']>>;
 transport.status=vi.fn<SeekerAuctionTransport['status']>(async()=>response);
 await f.controller.poll();
 expect(f.controller.snapshot()).toMatchObject({status:expired?'expired':'pending',view:null,canTransact:false,canRetry:expired,canWithdrawRefunds:expired,
  operation:{kind:'withdraw',wallet:f.page.wallet,round:request.round,spot:request.spot,signature:f.signature(),lastValidBlockHeight:'3100'}});
 expect(f.transport.current).not.toHaveBeenCalled();expect(f.transport.round).not.toHaveBeenCalled();
 expect(f.transport.prepareWithdraw).toHaveBeenCalledOnce();expect(f.wallet.signTransaction).toHaveBeenCalledOnce();
 expect(f.wallet.sendTransaction).not.toHaveBeenCalled();expect(f.transport.submit).toHaveBeenCalledOnce();
});
it.each(['resolve','reject'] as const)('refund successor: a ready refund can start during a current read whose late %s cannot overwrite the operation',async outcome=>{
 const f=controllerFixture(),transport:SeekerAuctionTransport=f.transport,current=refundDeferred<Awaited<ReturnType<SeekerAuctionTransport['current']>>>();
 transport.current=vi.fn<SeekerAuctionTransport['current']>(()=>current.promise);
 const loading=f.controller.load();await f.controller.loadRefunds();
 try{
  expect(f.controller.snapshot()).toMatchObject({view:null,refunds:{status:'ready',page:f.page},canWithdrawRefunds:true});
  await f.controller.withdrawRefund(request);
  const retained=f.controller.snapshot();expect(retained).toMatchObject({status:'pending',operation:{signature:f.signature()},receipt:f.pending()});
  if(outcome==='resolve')current.resolve(null);else current.reject(Error('late current RPC failure'));
  await loading;
  expect(f.controller.snapshot()).toMatchObject({status:'pending',view:null,operation:retained.operation,receipt:retained.receipt,costs:retained.costs,
   refunds:{status:'ready',page:f.page},canWithdrawRefunds:false,canRetry:false,error:null});
  expect(f.transport.prepareWithdraw).toHaveBeenCalledOnce();expect(f.transport.submit).toHaveBeenCalledOnce();
 }finally{current.resolve(null);await loading;}
});
it.each([false,true])('refund successor: passive wallet change hides the previous refund page while retaining pending=%s evidence',async pending=>{
 const f=controllerFixture();await f.controller.loadRefunds();if(pending)await f.controller.withdrawRefund(request);
 const retained=f.controller.snapshot();f.wallet.publicKey=key(9).publicKey;
 const changed=f.controller.snapshot();
 expect(changed).toMatchObject({refunds:{page:null},canWithdrawRefunds:false,canTransact:false,canRetry:false,
  operation:retained.operation,receipt:retained.receipt,costs:retained.costs});
 if(pending){expect(changed.status).toBe('pending');expect(changed.operation?.wallet).toBe(f.page.wallet);expect(changed.operation?.signature).toBe(f.signature());}
 await f.controller.withdrawRefund(request);
 expect(f.transport.prepareWithdraw).toHaveBeenCalledTimes(pending?1:0);expect(f.transport.submit).toHaveBeenCalledTimes(pending?1:0);
});
it.each(['resolve','reject'] as const)('refund successor: a deferred prior-wallet refresh %s never restores that wallet\'s displayed page',async outcome=>{
 const f=controllerFixture(),refresh=refundDeferred<SeekerAuctionRefundsPage>();await f.controller.loadRefunds();
 f.transport.refunds.mockImplementationOnce(()=>refresh.promise);
 const loading=f.controller.loadRefunds();f.wallet.publicKey=key(9).publicKey;
 try{
  expect(f.controller.snapshot()).toMatchObject({refunds:{page:null},canWithdrawRefunds:false});
  if(outcome==='resolve')refresh.resolve(structuredClone(f.page));else refresh.reject(Error('old wallet RPC failure'));
  await loading;
  expect(f.controller.snapshot()).toMatchObject({refunds:{page:null},canWithdrawRefunds:false,canRetry:false,operation:null,receipt:null});
  expect(f.transport.prepareWithdraw).not.toHaveBeenCalled();expect(f.transport.submit).not.toHaveBeenCalled();
 }finally{refresh.resolve(structuredClone(f.page));await loading;}
});
it.each(['resolve','reject'] as const)('refund successor: a superseded refresh %s after wallet change cannot erase a newer pending withdrawal',async outcome=>{
 const f=controllerFixture(),refresh=refundDeferred<SeekerAuctionRefundsPage>();await f.controller.loadRefunds();
 f.transport.refunds.mockImplementationOnce(()=>refresh.promise);
 const oldRead=f.controller.loadRefunds();
 // A newer successful read supersedes the slow page before any money operation.
 await f.controller.loadRefunds();await f.controller.withdrawRefund(request);
 const retained=f.controller.snapshot();expect(retained.status).toBe('pending');f.wallet.publicKey=key(9).publicKey;
 if(outcome==='resolve')refresh.resolve(structuredClone(f.page));else refresh.reject(Error('superseded wallet RPC failure'));
 await oldRead;
 expect(f.controller.snapshot()).toMatchObject({status:'pending',refunds:{page:null},canWithdrawRefunds:false,canTransact:false,canRetry:false,
  operation:retained.operation,receipt:retained.receipt,costs:retained.costs,error:null});
 expect(f.transport.prepareWithdraw).toHaveBeenCalledOnce();expect(f.wallet.signTransaction).toHaveBeenCalledOnce();expect(f.transport.submit).toHaveBeenCalledOnce();
});

/** S6-M1 successor: a separate refund page must carry the same independently
 * pinned program as the round path, even when all foreign PDAs agree. */
function substituteRefundProgram(f:ReturnType<typeof fixture>,setup=false){
 const foreign=key(9).publicKey,config=seekerAuctionConfigPda(foreign),auction=seekerAuctionPda(foreign,config,request.spot,BigInt(request.round));
 f.page.programId=foreign.toBase58();f.page.config=config.toBase58();
 f.page.entries[0]!.auction=auction.toBase58();f.page.entries[0]!.bid=seekerBidPda(foreign,auction,f.signer.publicKey).toBase58();
 const plan=buildWithdrawMessage(foreign,{wallet:f.signer.publicKey,mint:f.mint,round:BigInt(request.round),spot:request.spot,
  blockhash:f.prepared.blockhash,needsDestination:setup});
 f.prepared.messageBase64=Buffer.from(plan.messageBytes).toString('base64');
}
it.each([false,true])('S6-M1 refuses a self-consistent foreign refund program with IDENTITY before wallet, optional ATA=%s',async setup=>{
 const f=fixture(setup);substituteRefundProgram(f,setup);
 expect(f.identity.programId).not.toBe(f.page.programId);expect(f.identity.mint).toBe(f.page.mint);expect(f.identity.decimals).toBe(f.page.decimals);
 const action=async()=>signSeekerAuction(await prepareSeekerAuctionRefundSigning({page:f.page,request,prepared:f.prepared,identity:f.identity}),f.wallet);
 await expect(action()).rejects.toMatchObject({name:'SeekerAuctionSigningError',code:'IDENTITY'});
 expect(f.wallet.signTransaction).not.toHaveBeenCalled();expect(f.wallet.sendTransaction).not.toHaveBeenCalled();
});
it.each([false,true])('S6-M1 refuses a legacy identity with no program pin before a foreign refund reaches the wallet, optional ATA=%s',async setup=>{
 const f=fixture(setup);substituteRefundProgram(f,setup);
 // The legacy two-field identity passes the old shape check, isolating the
 // missing independent program trust boundary from the new fixture shape.
 delete (f.identity as {programId?:string}).programId;
 const action=async()=>signSeekerAuction(await prepareSeekerAuctionRefundSigning({page:f.page,request,prepared:f.prepared,identity:f.identity}),f.wallet);
 await expect(action()).rejects.toThrow();
 expect(f.wallet.signTransaction).not.toHaveBeenCalled();expect(f.wallet.sendTransaction).not.toHaveBeenCalled();
});
it.each(['foreign response','mismatched pin','missing pin'] as const)('S6-M1 keeps a separate refund action inert for a %s while its mint remains pinned',async defect=>{
 const f=controllerFixture();
 if(defect==='foreign response')substituteRefundProgram(f);
 else if(defect==='mismatched pin')f.identity.programId=key(9).publicKey.toBase58();
 else delete (f.identity as {programId?:string}).programId;
 await f.controller.loadRefunds();
 expect(f.identity.mint).toBe(f.page.mint);
 expect(f.controller.snapshot()).toMatchObject({view:null,refunds:{status:'ready',page:f.page},canWithdrawRefunds:false,canRetry:false});
 await f.controller.withdrawRefund(request);
 expect(f.transport.prepareWithdraw).not.toHaveBeenCalled();expect(f.wallet.signTransaction).not.toHaveBeenCalled();
 expect(f.wallet.sendTransaction).not.toHaveBeenCalled();expect(f.transport.submit).not.toHaveBeenCalled();
});
it('S6-M1 rechecks the captured refund program identity after asynchronous preparation',async()=>{
 const f=controllerFixture();await f.controller.loadRefunds();expect(f.controller.snapshot().canWithdrawRefunds).toBe(true);
 f.transport.prepareWithdraw.mockImplementationOnce(async()=>{f.identity.programId=key(9).publicKey.toBase58();return f.prepared;});
 await f.controller.withdrawRefund(request);
 expect(f.transport.prepareWithdraw).toHaveBeenCalledOnce();expect(f.controller.snapshot().canWithdrawRefunds).toBe(false);
 expect(f.controller.snapshot().error).toBeTruthy();expect(f.wallet.signTransaction).not.toHaveBeenCalled();
 expect(f.wallet.sendTransaction).not.toHaveBeenCalled();expect(f.transport.submit).not.toHaveBeenCalled();
});
