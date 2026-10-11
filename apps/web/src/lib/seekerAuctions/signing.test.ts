/** SA-4 W2/W3: chain SDK is a test-only independent ABI oracle. Browser source
 * must not import the SDK, Anchor, SPL Token or the node:crypto verifier. */
import {describe,expect,it,vi} from 'vitest';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {ComputeBudgetProgram,Keypair,Message,PublicKey,SystemProgram,Transaction,TransactionMessage} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_AUCTION_RUNTIME} from '@shardkeep/shared';
import type {SeekerAuctionSourcedRoundView} from '@shardkeep/shared/seekerAuctionApi';
import type {GameWallet} from '../../auth/useGameWallet';
import {buildBidMessage,buildWithdrawMessage} from '../../../../../packages/chain/src/seekerAuctionInstructions';
import {seekerAuctionConfigPda} from '../../../../../packages/chain/src/seekerAuctionProtocol';
import idl from '../../../../../packages/chain/src/idl/shardkeep_economy.json' with {type:'json'};
import {prepareSeekerAuctionSigning,signSeekerAuction,type SeekerAuctionSigningInput} from './signing';

const P=PHASE_E_POLICY.seekerIsland,A=PHASE_E_SEEKER_AUCTION;
const key=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n));
const token=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associated=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
function fixture(kind:'bid'|'withdraw'='bid',setup=false,spot=20,round=2n){
 const signer=key(1),program=new PublicKey(idl.address),mint=key(2).publicKey,owner=key(3).publicKey,blockhash=key(4).publicKey.toBase58();
 // S6-M1 fixture successor: independent application identity also pins the program.
 const first=1791158400n,start=first+round*BigInt(P.operatingTermSec),identity={programId:program.toBase58(),mint:mint.toBase58(),decimals:6};
 const view:SeekerAuctionSourcedRoundView={version:1,source:'chain',chainUnixTime:String(start-1n),walletSkrRaw:'1234567890123',wallet:signer.publicKey.toBase58(),observedSlot:'200',round:String(round),biddingRound:String(round),admissionPaused:false,
  config:{programId:program.toBase58(),address:seekerAuctionConfigPda(program).toBase58(),mint:identity.mint,decimals:identity.decimals,
   prizeOwner:owner.toBase58(),prizeAta:PublicKey.findProgramAddressSync([owner.toBuffer(),token.toBuffer(),mint.toBuffer()],associated)[0].toBase58(),
   openingBidRaw:'10000000',firstOperatingStart:String(first),termSec:String(P.operatingTermSec),auctionSec:String(P.overlappingAuctionSec),graceSec:String(A.settlementGraceSec)},
  auctionStart:String(start-BigInt(P.overlappingAuctionSec)),auctionEnd:String(start),operatingStart:String(start),operatingEnd:String(start+BigInt(P.operatingTermSec)),
  openedCount:P.totalSpots,completedCount:0,winnerCount:0,completedAt:null,
  spots:Array.from({length:P.totalSpots},(_,i)=>({spot:i,class:i<P.kingSpots?'king':'regular',realmMask:i<P.kingSpots?(1<<P.realmCount)-1:
   Array.from({length:A.regularRealmCount},(_,n)=>n).reduce((mask,n)=>mask|(1<<((i-P.kingSpots+n)%P.realmCount)),0),
   opened:true,highBidRaw:'0',highBidder:null,settled:false,yourBidRaw:'0',refundable:false}))};
 if(kind==='withdraw')Object.assign(view.spots[spot]!,{highBidRaw:'11000000',highBidder:key(5).publicKey.toBase58(),yourBidRaw:'10000000',refundable:true});
 const target={wallet:signer.publicKey,mint,spot,round,blockhash},newTotal=12345678n;
 const plan=kind==='bid'?buildBidMessage(program,{...target,newTotal,needsBid:setup}):buildWithdrawMessage(program,{...target,needsDestination:setup});
 const prepared={messageBase64:Buffer.from(plan.messageBytes).toString('base64'),blockhash,lastValidBlockHeight:'9007199254740993',
  incrementRaw:kind==='bid'?String(newTotal):'0',networkFeeLamports:'5000',newAccountRentLamports:setup?'1000':'0'};
 const input:SeekerAuctionSigningInput=kind==='bid'?{kind,request:{round:String(round),spot,newTotalRaw:String(newTotal)},view,prepared,identity}:
  {kind,request:{round:String(round),spot},view,prepared,identity};
 return {signer,program,mint,identity,view,prepared,input,plan};
}
function wallet(f:ReturnType<typeof fixture>,sign?:(tx:Transaction)=>Promise<Transaction>):GameWallet{
 return {publicKey:f.signer.publicKey,signMessage:null,isEmbedded:false,sendTransaction:vi.fn(async()=>bs58.encode(Buffer.alloc(64,8))),
  signTransaction:vi.fn(sign??(async tx=>{tx.partialSign(f.signer);return tx;}))};
}
async function signing(f:ReturnType<typeof fixture>,w:GameWallet){return signSeekerAuction(await prepareSeekerAuctionSigning(f.input),w);}

describe('SA-4 W2 canonical auction rebuild and wallet verification',()=>{
 it.each(['bid','withdraw'] as const)('rebuilds %s with both optional-account shapes across king/regular and round boundaries',async kind=>{
  for(const setup of [false,true])for(const spot of [0,P.kingSpots,P.totalSpots-1])for(const round of [0n,2n]){
   const f=fixture(kind,setup,spot,round),w=wallet(f),result=await signing(f,w);
   expect(w.signTransaction).toHaveBeenCalledOnce();expect(w.sendTransaction).not.toHaveBeenCalled();
   expect('signedTransaction' in result.submission).toBe(true);
   if(!('signedTransaction' in result.submission))throw Error('missing signed-only wire');
   const tx=Transaction.from(Buffer.from(result.submission.signedTransaction,'base64'));
   expect(Buffer.from(tx.serializeMessage())).toEqual(Buffer.from(f.plan.messageBytes));expect(tx.verifySignatures()).toBe(true);
   expect(result.signature).toBe(bs58.encode(tx.signature!));expect(result.lastValidBlockHeight).toBe(f.prepared.lastValidBlockHeight);
  }
 });
 it.each([
  {name:'payer',mutate:(tx:Transaction)=>{tx.feePayer=key(9).publicKey;}},
  {name:'action amount',mutate:(tx:Transaction)=>{const data=tx.instructions.at(-1)!.data;data[8]=data[8]!^1;}},
  {name:'source ATA',mutate:(tx:Transaction)=>{tx.instructions.at(-1)!.keys[7]!.pubkey=key(9).publicKey;}},
  {name:'vault ATA',mutate:(tx:Transaction)=>{tx.instructions.at(-1)!.keys[8]!.pubkey=key(9).publicKey;}},
  {name:'privilege',mutate:(tx:Transaction)=>{tx.instructions.at(-1)!.keys[1]!.isWritable=true;}},
  {name:'extra transfer',mutate:(tx:Transaction)=>{tx.add(SystemProgram.transfer({fromPubkey:tx.feePayer!,toPubkey:key(9).publicKey,lamports:1}));}},
  {name:'duplicate action',mutate:(tx:Transaction)=>{tx.add(tx.instructions.at(-1)!);}},
  {name:'setup order',mutate:(tx:Transaction)=>{tx.instructions.reverse();}},
  {name:'server-added ComputeBudget',mutate:(tx:Transaction)=>{tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:200000}));}},
 ])('W2 refuses a server $name mismatch before any wallet call',async({mutate})=>{
  const f=fixture('bid',true),w=wallet(f),tx=Transaction.populate(Message.from(f.plan.messageBytes));mutate(tx);f.prepared.messageBase64=Buffer.from(tx.serializeMessage()).toString('base64');
  await expect(signing(f,w)).rejects.toThrow();expect(w.signTransaction).not.toHaveBeenCalled();expect(w.sendTransaction).not.toHaveBeenCalled();
 });
 it('W2 binds independently validated mint/decimals, requested target and quote blockhash before signing',async()=>{
  const changes=[(f:ReturnType<typeof fixture>)=>{f.identity.mint=key(9).publicKey.toBase58();},
   (f:ReturnType<typeof fixture>)=>{f.identity.decimals++;},(f:ReturnType<typeof fixture>)=>{(f.input.request as {spot:number}).spot++;},
   (f:ReturnType<typeof fixture>)=>{(f.input.request as {round:string}).round='1';},(f:ReturnType<typeof fixture>)=>{f.prepared.blockhash=key(9).publicKey.toBase58();},
   (f:ReturnType<typeof fixture>)=>{f.view.source='fixture';},(f:ReturnType<typeof fixture>)=>{delete (f.view as {source?:string}).source;}];
  for(const mutate of changes){const f=fixture(),w=wallet(f);mutate(f);await expect(signing(f,w)).rejects.toThrow();expect(w.signTransaction).not.toHaveBeenCalled();}
 });
 it('refuses a misleading increment quote before any wallet prompt',async()=>{
  for(const kind of ['bid','withdraw'] as const){const f=fixture(kind),w=wallet(f);f.prepared.incrementRaw='1';
   await expect(signing(f,w)).rejects.toThrow();expect(w.signTransaction).not.toHaveBeenCalled();expect(w.sendTransaction).not.toHaveBeenCalled();}
 });
 it('refuses noncanonical legacy/v0/oversized payloads and a withdrawal to any other destination before wallet',async()=>{
  const f=fixture(),w=wallet(f),tx=Transaction.populate(Message.from(f.plan.messageBytes));
  for(const raw of ['%%%%',Buffer.alloc(1233).toString('base64'),Buffer.from(new TransactionMessage({payerKey:f.signer.publicKey,recentBlockhash:f.prepared.blockhash,instructions:tx.instructions}).compileToV0Message().serialize()).toString('base64')]){
   f.prepared.messageBase64=raw;await expect(signing(f,w)).rejects.toThrow();
  }
  const g=fixture('withdraw'),withdraw=Transaction.populate(Message.from(g.plan.messageBytes));withdraw.instructions.at(-1)!.keys[5]!.pubkey=key(9).publicKey;
  g.prepared.messageBase64=Buffer.from(withdraw.serializeMessage()).toString('base64');await expect(signing(g,wallet(g))).rejects.toThrow();expect(w.signTransaction).not.toHaveBeenCalled();
 });
 it('snapshots review inputs and refuses a fabricated signing proof or a switched wallet',async()=>{
  const f=fixture(),proof=await prepareSeekerAuctionSigning(f.input),w=wallet(f);f.prepared.messageBase64='%%%%';f.identity.mint=key(9).publicKey.toBase58();
  expect((await signSeekerAuction(proof,w)).lastValidBlockHeight).toBe('9007199254740993');
  await expect(signSeekerAuction({...proof},wallet(f))).rejects.toThrow();
  const g=fixture(),wrong={...wallet(g),publicKey:key(9).publicKey};await expect(signing(g,wrong)).rejects.toThrow();expect(wrong.signTransaction).not.toHaveBeenCalled();
 });
 it('allows the D-141 wallet budget rewrite and clears expiry when the wallet refreshes blockhash',async()=>{
  for(const refresh of [false,true]){
   const f=fixture(),w=wallet(f,async tx=>{
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:375000}));
    if(refresh)tx.recentBlockhash=key(9).publicKey.toBase58();tx.partialSign(f.signer);return tx;
   });
   const result=await signing(f,w);expect(result.lastValidBlockHeight).toBe(refresh?null:f.prepared.lastValidBlockHeight);expect(w.sendTransaction).not.toHaveBeenCalled();
  }
 });
 it('refuses validly signed wallet transfers, duplicate budgets, inflated fees and corrupt signatures without sending',async()=>{
  for(const mutate of [
   (tx:Transaction)=>{tx.add(SystemProgram.transfer({fromPubkey:tx.feePayer!,toPubkey:key(9).publicKey,lamports:1}));},
   (tx:Transaction)=>{tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitLimit({units:200000}));},
   (tx:Transaction)=>{tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:BigInt(PHASE_E_SEEKER_AUCTION_RUNTIME.maxWalletAddedPriorityFeeLamports)+1n}));},
  ]){
   const f=fixture(),w=wallet(f,async tx=>{mutate(tx);tx.partialSign(f.signer);return tx;});await expect(signing(f,w)).rejects.toThrow();expect(w.sendTransaction).not.toHaveBeenCalled();
  }
  const f=fixture(),w=wallet(f,async tx=>{tx.partialSign(f.signer);const signature=tx.signatures[0]!.signature!;signature[0]=signature[0]!^1;return tx;});await expect(signing(f,w)).rejects.toThrow();expect(w.sendTransaction).not.toHaveBeenCalled();
 });
});

describe('SA-4 W3 GameWallet send-only fallback',()=>{
 it.each(['bid','withdraw'] as const)('uses sendTransaction plus signature for %s when signTransaction is null',async kind=>{
  const f=fixture(kind,true),signature=bs58.encode(Buffer.alloc(64,8)),sendTransaction=vi.fn(async(tx:Transaction)=>{
   expect(Buffer.from(tx.serializeMessage())).toEqual(Buffer.from(f.plan.messageBytes));return signature;
  });
  const w:GameWallet={publicKey:f.signer.publicKey,signMessage:null,isEmbedded:false,signTransaction:null,sendTransaction};
  expect(await signing(f,w)).toEqual({submission:{signature},signature,lastValidBlockHeight:null});expect(sendTransaction).toHaveBeenCalledOnce();
 });
 it('uses the fallback for absent optional signTransaction and never falls back after a rejected sign-only request',async()=>{
  const f=fixture(),w=wallet(f);delete w.signTransaction;expect((await signing(f,w)).submission).toHaveProperty('signature');expect(w.sendTransaction).toHaveBeenCalledOnce();
  const g=fixture(),rejected=wallet(g,async()=>{throw Error('User rejected');});await expect(signing(g,rejected)).rejects.toThrow('User rejected');expect(rejected.sendTransaction).not.toHaveBeenCalled();
 });
 it('refuses malformed send signatures and unavailable signers without inventing a retryable height',async()=>{
  const f=fixture(),w:GameWallet={publicKey:f.signer.publicKey,signMessage:null,isEmbedded:false,signTransaction:null,sendTransaction:vi.fn(async()=> 'invalid')};
  await expect(signing(f,w)).rejects.toThrow();expect(w.sendTransaction).toHaveBeenCalledOnce();
  await expect(signing(f,{...w,sendTransaction:null})).rejects.toThrow();
 });
});

describe('S6-M1 independently pinned program identity',()=>{
 it.each(['bid','withdraw'] as const)('refuses a self-consistent foreign-program %s with IDENTITY before either wallet capability',async kind=>{
  for(const setup of [false,true]){
   const f=fixture(kind,setup),w=wallet(f),foreign=key(9).publicKey;
   f.view.config.programId=foreign.toBase58();f.view.config.address=seekerAuctionConfigPda(foreign).toBase58();
   const target={wallet:f.signer.publicKey,mint:f.mint,round:BigInt(f.input.request.round),spot:f.input.request.spot,blockhash:f.prepared.blockhash};
   const plan=f.input.kind==='bid'?buildBidMessage(foreign,{...target,newTotal:BigInt(f.input.request.newTotalRaw),needsBid:setup}):
    buildWithdrawMessage(foreign,{...target,needsDestination:setup});
   f.prepared.messageBase64=Buffer.from(plan.messageBytes).toString('base64');
   expect(f.identity.programId).not.toBe(f.view.config.programId);expect(f.identity.mint).toBe(f.view.config.mint);
   expect(f.identity.decimals).toBe(f.view.config.decimals);
   await expect(signing(f,w)).rejects.toMatchObject({name:'SeekerAuctionSigningError',code:'IDENTITY'});
   expect(w.signTransaction).not.toHaveBeenCalled();expect(w.sendTransaction).not.toHaveBeenCalled();
  }
 });
 it.each(['bid','withdraw'] as const)('refuses a legacy identity with no independent program pin before a foreign %s reaches the wallet',async kind=>{
  const f=fixture(kind),w=wallet(f),foreign=key(9).publicKey;
  f.view.config.programId=foreign.toBase58();f.view.config.address=seekerAuctionConfigPda(foreign).toBase58();
  const target={wallet:f.signer.publicKey,mint:f.mint,round:BigInt(f.input.request.round),spot:f.input.request.spot,blockhash:f.prepared.blockhash};
  const plan=f.input.kind==='bid'?buildBidMessage(foreign,{...target,newTotal:BigInt(f.input.request.newTotalRaw),needsBid:false}):
   buildWithdrawMessage(foreign,{...target,needsDestination:false});
  f.prepared.messageBase64=Buffer.from(plan.messageBytes).toString('base64');
  // Deliberate untyped/legacy host: old source accepts this exact two-field shape
  // and rebuilds the foreign program from the response. No trusted pin exists.
  delete (f.identity as {programId?:string}).programId;
  await expect(signing(f,w)).rejects.toThrow();
  expect(w.signTransaction).not.toHaveBeenCalled();expect(w.sendTransaction).not.toHaveBeenCalled();
 });
});
