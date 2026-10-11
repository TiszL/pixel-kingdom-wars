import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {Keypair,Message,MessageV0,PublicKey,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {TOKEN} from '@shardkeep/shared';
import bs58 from 'bs58';
import {buildKeepEquipmentPaymentMessage,type KeepEquipmentPaymentOriginal} from './keepEquipmentPayment';
import type {KeepEquipmentPaymentPreparationTrust} from './keepEquipmentPaymentPreparation';
import {createKeepEquipmentPaymentFailureReader,KeepEquipmentPaymentFailureError,type KeepEquipmentPaymentFailureInput,type KeepEquipmentPaymentFailureRpc} from './keepEquipmentPaymentFailure';
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const noAuthority={paymentAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false};
function fixture(version:'legacy'|0='legacy',create=false){
 const buyer=Keypair.generate(),seller=Keypair.generate(),mint=Keypair.generate().publicKey,genesis=Keypair.generate().publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58();
 const trust:KeepEquipmentPaymentPreparationTrust={expectedGenesisHash:genesis,expectedKeepMint:mint.toBase58(),minContextSlot:90,deadlineMs:100,transactionVersion:version,providerIds:['private-first','private-second'],maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000};
 const original:KeepEquipmentPaymentOriginal={reservationId:randomUUID(),buyer:buyer.publicKey.toBase58(),seller:seller.publicKey.toBase58(),keepMint:mint.toBase58(),totalBaseUnits:1_000_001n,sellerAtaExists:!create,...(create?{sellerAtaRentCapLamports:2_039_280n}:{})};
 const built=buildKeepEquipmentPaymentMessage(original,trust,blockhash,version),message=version==='legacy'?Message.from(built.messageBytes):MessageV0.deserialize(built.messageBytes),packet=new VersionedTransaction(message);packet.sign([buyer]);const wire=packet.serialize(),signature=bs58.encode(packet.signatures[0]!);
 const saved:KeepEquipmentPaymentFailureInput={original,messageBytes:built.messageBytes,messageSha256:built.messageSha256,blockhash,lastValidBlockHeight:300,minContextSlot:95,signedTransaction:wire,signature,wireSha256:hash(wire)};
 function transaction():VersionedTransactionResponse {
  const message=version==='legacy'?Message.from(built.messageBytes):MessageV0.deserialize(built.messageBytes),keys=message.staticAccountKeys.map(p=>p.toBase58()),pre=keys.map((_,i)=>i===0?100_000_000:2_039_280),post=pre.map((n,i)=>n-(i===0?5000:0));
  const token=(key:string,owner:string,amount:string)=>({accountIndex:keys.indexOf(key),mint:mint.toBase58(),owner,programId:TOKEN_PROGRAM_ID.toBase58(),uiTokenAmount:{amount,decimals:TOKEN.decimals,uiAmount:null,uiAmountString:'0'}});
  const tokens=[token(built.buyerAta,original.buyer,'900000')];if(!create)tokens.push(token(built.sellerAta,original.seller,'7'));
  return {slot:100,blockTime:2_000_000_000,version,transaction:{message,signatures:[signature]},meta:{err:{InstructionError:[create?1:0,{Custom:1}]},fee:5000,preBalances:pre,postBalances:post,preTokenBalances:structuredClone(tokens),postTokenBalances:structuredClone(tokens),innerInstructions:[],loadedAddresses:{writable:[],readonly:[]},logMessages:['failure logs are not proof']}};
 }
 const peers=[0,1].map(()=>{const controls={tx:transaction() as VersionedTransactionResponse|null,opening:105,closing:110};const rpc={getGenesisHash:vi.fn(async()=>genesis),getSlot:vi.fn(async()=>controls.opening).mockImplementationOnce(async()=>controls.opening).mockImplementation(async()=>controls.closing),getTransaction:vi.fn(async(s:string,o:{commitment:'finalized';maxSupportedTransactionVersion:0})=>{expect(s).toBe(signature);expect(o).toEqual({commitment:'finalized',maxSupportedTransactionVersion:0});return controls.tx;})} satisfies KeepEquipmentPaymentFailureRpc;return {controls,rpc};});
 const signals:AbortSignal[]=[];const connectors=[(s:AbortSignal)=>{signals.push(s);return peers[0]!.rpc;},(s:AbortSignal)=>{signals.push(s);return peers[1]!.rpc;}] as const;
 const read=()=>createKeepEquipmentPaymentFailureReader(connectors,trust)(saved);
 return {buyer,seller,mint,genesis,built,saved,trust,peers,connectors,signals,read,transaction};
}
const meta=(f:ReturnType<typeof fixture>,peer=0)=>f.peers[peer]!.controls.tx!.meta!;
async function held(f:ReturnType<typeof fixture>,code?:string){await expect(f.read()).rejects.toMatchObject({...noAuthority,...(code?{code}:{})});}
afterEach(()=>vi.useRealTimers());
it.each([['legacy',false],['legacy',true],[0,false],[0,true]] as const)('authenticates exact %s failed packet with creation %s and grants no custody authority',async(version,create)=>{
 const f=fixture(version,create),p=await f.read();expect(p).toMatchObject({...noAuthority,outcome:'failed',finalizedAgreement:true,signature:f.saved.signature,messageSha256:f.saved.messageSha256,wireSha256:f.saved.wireSha256,transactionVersion:version,feeLamports:'5000',rentLamports:'0',paidKeepBaseUnits:'0'});expect(p.reservationId).toBe(f.saved.original.reservationId);expect(p.tokenBalances).toHaveLength(create?1:2);expect(p.lamportsBefore[0]!-p.lamportsAfter[0]!).toBe(5000);expect(p.observations).toHaveLength(2);
});
it('historical paid fee can exceed original quotation without treating failure as paid KEEP',async()=>{
 const f=fixture();for(const p of f.peers){p.controls.tx!.meta!.fee=100001;p.controls.tx!.meta!.postBalances[0]=p.controls.tx!.meta!.preBalances[0]!-100001;}expect(await f.read()).toMatchObject({feeLamports:'100001',paidKeepBaseUnits:'0',paymentAuthorized:false});
});
it('permits omitted token metadata on both banks but never partial token metadata',async()=>{
 const f=fixture();for(const p of f.peers){delete p.controls.tx!.meta!.preTokenBalances;delete p.controls.tx!.meta!.postTokenBalances;}expect((await f.read()).tokenBalances).toBeNull();
});
it('ignores logs and provider serialization and returns deeply immutable owned evidence',async()=>{
 const f=fixture();for(const p of f.peers){p.controls.tx!.transaction.message.serialize=()=>{throw Error('provider serialization must not run');};p.controls.tx!.meta!.logMessages=['Program success is not authority'];}
 const result=await f.read(),before=JSON.stringify(result);meta(f).preBalances[0]=0;meta(f).preTokenBalances![0]!.uiTokenAmount.amount='0';(meta(f).err as any).InstructionError[1].Custom=99;
 expect(JSON.stringify(result)).toBe(before);expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.error)).toBe(true);expect(Object.isFrozen(result.tokenBalances)).toBe(true);expect(Object.isFrozen(result.tokenBalances![0])).toBe(true);expect(Object.isFrozen(result.observations[0])).toBe(true);
});
it.each(['null','missing meta','success','unknown error','bad instruction index','wrong signature','wrong version','different blockhash','extra instruction','loaded address','unsafe slot','missing block time'] as const)('holds %s instead of proving nonpayment',async kind=>{
 const f=fixture();const tx=f.peers[0]!.controls.tx!;
 if(kind==='null')f.peers[0]!.controls.tx=null;
 if(kind==='missing meta')tx.meta=null;
 if(kind==='success')meta(f).err=null;
 if(kind==='unknown error')meta(f).err={MadeUpError:0} as never;
 if(kind==='bad instruction index')meta(f).err={InstructionError:[99,'InsufficientFunds']};
 if(kind==='wrong signature')tx.transaction.signatures[0]=bs58.encode(new Uint8Array(64));
 if(kind==='wrong version')tx.version=0;
 if(kind==='different blockhash')tx.transaction.message.recentBlockhash=Keypair.generate().publicKey.toBase58();
 if(kind==='extra instruction')(tx.transaction.message as Message).instructions.push((tx.transaction.message as Message).instructions[0]!);
 if(kind==='loaded address')meta(f).loadedAddresses={writable:[f.mint],readonly:[]};
 if(kind==='unsafe slot')tx.slot=Number.MAX_SAFE_INTEGER+1;
 if(kind==='missing block time')tx.blockTime=null;
 await held(f);
});
it.each(['fee debit','seller lamports','negative fee','unsafe balance','missing balance','sparse balance','burn','seller credit','owner','program','mint','decimals','duplicate row','missing post','missing buyer','missing seller','empty rows','oversized amount'] as const)('holds inconsistent or incomplete %s rollback evidence',async kind=>{
 const f=fixture(),m=meta(f),pre=m.preTokenBalances!,post=m.postTokenBalances!;
 if(kind==='fee debit')m.postBalances[0]!--;
 if(kind==='seller lamports')m.postBalances[1]!--;
 if(kind==='negative fee')m.fee=-1;
 if(kind==='unsafe balance')m.preBalances[0]=Number.MAX_SAFE_INTEGER+1;
 if(kind==='missing balance')m.postBalances.pop();
 if(kind==='sparse balance')delete m.preBalances[1];
 if(kind==='burn')post[0]!.uiTokenAmount.amount='1';
 if(kind==='seller credit')post[1]!.uiTokenAmount.amount='8';
 if(kind==='owner')pre[0]!.owner=post[0]!.owner=f.saved.original.seller;
 if(kind==='program')pre[0]!.programId=post[0]!.programId=f.mint.toBase58();
 if(kind==='mint')pre[0]!.mint=post[0]!.mint=f.saved.original.seller;
 if(kind==='decimals')pre[0]!.uiTokenAmount.decimals=post[0]!.uiTokenAmount.decimals=0;
 if(kind==='duplicate row')pre[1]=pre[0]!;
 if(kind==='missing post')delete m.postTokenBalances;
 if(kind==='missing buyer'){pre.shift();post.shift();}
 if(kind==='missing seller'){pre.pop();post.pop();}
 if(kind==='empty rows'){m.preTokenBalances=[];m.postTokenBalances=[];}
 if(kind==='oversized amount')pre[0]!.uiTokenAmount.amount=post[0]!.uiTokenAmount.amount='18446744073709551616';
 await held(f);
});
it('v0 rejects lookup tables and changed account roles without trusting provider serializer',async()=>{
 const f=fixture(0);(f.peers[0]!.controls.tx!.transaction.message as MessageV0).addressTableLookups.push({accountKey:f.mint,writableIndexes:[],readonlyIndexes:[]});await held(f,'MESSAGE');
});
it.each(['error','slot','fee','token presence','token balance','balance snapshot'] as const)('holds providers disagreeing on %s',async kind=>{
 const f=fixture(),tx=f.peers[1]!.controls.tx!,m=tx.meta!;
 if(kind==='error')m.err={InstructionError:[0,{Custom:2}]};
 if(kind==='slot')tx.slot++;
 if(kind==='fee'){m.fee++;m.postBalances[0]!--;}
 if(kind==='token presence'){delete m.preTokenBalances;delete m.postTokenBalances;}
 if(kind==='token balance')m.preTokenBalances![0]!.uiTokenAmount.amount=m.postTokenBalances![0]!.uiTokenAmount.amount='900001';
 if(kind==='balance snapshot'){m.preBalances[1]!++;m.postBalances[1]!++;}
 await held(f,'PROVIDER_MISMATCH');
});
it.each(['genesis','closing genesis','saved floor','operator floor','old transaction','closing tip','regressing tip'] as const)('holds %s finalized context',async kind=>{
 const f=fixture(),p=f.peers[0]!;
 if(kind==='genesis')p.rpc.getGenesisHash.mockResolvedValue(Keypair.generate().publicKey.toBase58());
 if(kind==='closing genesis')p.rpc.getGenesisHash.mockResolvedValueOnce(f.genesis).mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
 if(kind==='saved floor')Object.assign(f.saved,{minContextSlot:111});
 if(kind==='operator floor')Object.assign(f.trust,{minContextSlot:111});
 if(kind==='old transaction')p.controls.tx!.slot=94;
 if(kind==='closing tip')p.rpc.getSlot.mockReset().mockResolvedValueOnce(95).mockResolvedValueOnce(99);
 if(kind==='regressing tip')p.rpc.getSlot.mockReset().mockResolvedValueOnce(110).mockResolvedValueOnce(109);
 await held(f);
});
it('same failed transaction may be observed at distinct finalized tips',async()=>{
 const f=fixture();f.peers[0]!.rpc.getSlot.mockReset().mockResolvedValueOnce(105).mockResolvedValueOnce(110);f.peers[1]!.rpc.getSlot.mockReset().mockResolvedValueOnce(106).mockResolvedValueOnce(112);expect((await f.read()).observations).toEqual([{openingSlot:105,closingSlot:110},{openingSlot:106,closingSlot:112}]);
});
it('copies original bytes pins connectors and RPC method identities before awaiting',async()=>{
 const f=fixture(),connect=[...f.connectors] as [typeof f.connectors[0],typeof f.connectors[1]],read=createKeepEquipmentPaymentFailureReader(connect,f.trust),mutant=vi.fn(async()=>null);let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 f.peers[0]!.rpc.getGenesisHash.mockImplementationOnce(async()=>{await gate;return f.genesis;});const result=read(f.saved);await Promise.resolve();
 f.saved.messageBytes.fill(0);f.saved.signedTransaction.fill(0);Object.assign(f.saved.original,{totalBaseUnits:0n});Object.assign(f.trust,{expectedGenesisHash:'bad',providerIds:['bad','bad']});connect[0]=()=>{throw Error('replaced connector');};f.peers[0]!.rpc.getTransaction=mutant;release();expect(await result).toMatchObject({outcome:'failed',totalBaseUnits:'1000001'});expect(mutant).not.toHaveBeenCalled();
});
it('rejects caller terms hashes and forged wire before any RPC',async()=>{
 const f=fixture(),read=createKeepEquipmentPaymentFailureReader(f.connectors,f.trust),forged=f.saved.signedTransaction.slice();forged[4]=forged[4]!^1;
 for(const input of [null,{}, {...f.saved,'':true}, {...f.saved,proof:{}},{...f.saved,wireSha256:'0'.repeat(64)},{...f.saved,messageSha256:'0'.repeat(64)},{...f.saved,signature:bs58.encode(new Uint8Array(64))},{...f.saved,signedTransaction:forged},{...f.saved,messageBytes:new Uint8Array(1233)}, {...f.saved,minContextSlot:-1},{...f.saved,lastValidBlockHeight:0},{...f.saved,original:{...f.saved.original,buyer:f.saved.original.seller}},{...f.saved,original:{...f.saved.original,keepMint:f.saved.original.buyer}},{...f.saved,original:{...f.saved.original,instructions:[]}}])await expect(read(input as KeepEquipmentPaymentFailureInput)).rejects.toBeInstanceOf(KeepEquipmentPaymentFailureError);
 expect(f.signals).toHaveLength(0);
});
it('failed peer retains capacity until outstanding uncooperative RPC drains',async()=>{
 const f=fixture(),resolvers:Array<(v:string)=>void>=[];f.peers[0]!.rpc.getGenesisHash.mockRejectedValue(Error('offline'));f.peers[1]!.rpc.getGenesisHash.mockImplementation(()=>new Promise<string>(r=>resolvers.push(r)));const read=createKeepEquipmentPaymentFailureReader(f.connectors,f.trust);
 for(let i=0;i<4;i++)await expect(read(f.saved)).rejects.toMatchObject({code:'UNAVAILABLE'});await expect(read(f.saved)).rejects.toMatchObject({code:'BUSY'});for(const r of resolvers)r(f.genesis);await vi.waitFor(()=>expect(f.signals.every(s=>s.aborted)).toBe(true));expect(f.peers[1]!.rpc.getTransaction).not.toHaveBeenCalled();
});
it('deadline keeps all four occupied reads fenced until drain and schedules no late RPC',async()=>{
 vi.useFakeTimers();const f=fixture(),resolvers:Array<(v:string)=>void>=[];f.peers[1]!.rpc.getGenesisHash.mockImplementation(()=>new Promise<string>(r=>resolvers.push(r)));const read=createKeepEquipmentPaymentFailureReader(f.connectors,f.trust),calls=Array.from({length:4},()=>read(f.saved));const checked=calls.map(p=>expect(p).rejects.toMatchObject({...noAuthority,code:'DEADLINE'}));await vi.advanceTimersByTimeAsync(101);await Promise.all(checked);await expect(read(f.saved)).rejects.toMatchObject({code:'BUSY'});for(const r of resolvers)r(f.genesis);await vi.advanceTimersByTimeAsync(0);expect(f.peers[1]!.rpc.getTransaction).not.toHaveBeenCalled();f.peers[1]!.rpc.getGenesisHash.mockResolvedValue(f.genesis);expect((await read(f.saved)).outcome).toBe('failed');
});
it('rejects bad private configuration before provider creation',()=>{
 const f=fixture();for(const trust of [null,{...f.trust,providerIds:['same','same']},{...f.trust,expectedKeepMint:'bad'},{...f.trust,deadlineMs:0},{...f.trust,transactionVersion:1},{...f.trust,maxFeeLamports:-1n}])expect(()=>createKeepEquipmentPaymentFailureReader(f.connectors,trust as KeepEquipmentPaymentPreparationTrust)).toThrow(KeepEquipmentPaymentFailureError);expect(f.signals).toHaveLength(0);
});
