import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {AddressLookupTableAccount,ComputeBudgetProgram,Keypair,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {ACCOUNT_SIZE,TOKEN_PROGRAM_ID,createTransferCheckedInstruction,createApproveInstruction,createInitializeImmutableOwnerInstruction,createInitializeAccount3Instruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {TOKEN,PHASE_E_KEEP_EQUIPMENT_MARKET as POLICY} from '@shardkeep/shared';
import bs58 from 'bs58';
import {buildKeepEquipmentPaymentInstructions,buildKeepEquipmentPaymentMessage,verifyKeepEquipmentPaymentTransaction,createKeepEquipmentPaymentReader,KeepEquipmentPaymentError,type KeepEquipmentPaymentOriginal,type KeepEquipmentPaymentRpc,type KeepEquipmentPaymentLimits} from './keepEquipmentPayment';
const limits:KeepEquipmentPaymentLimits={maxFeeLamports:100_000n,maxPriorityFeeLamports:50_000n,maxComputeUnitLimit:300_000};
type Options={version?:'legacy'|0;lut?:boolean;total?:bigint;ata?:'fresh'|'raced'|'prefunded'|'funded-rent';rentCap?:bigint;edit?:(instructions:TransactionInstruction[],f:{buyer:Keypair;seller:Keypair;mint:PublicKey;buyerAta:PublicKey;sellerAta:PublicKey})=>void};
function fixture(options:Options={}){
 const buyer=Keypair.generate(),seller=Keypair.generate(),mint=Keypair.generate().publicKey,buyerAta=getAssociatedTokenAddressSync(mint,buyer.publicKey),sellerAta=getAssociatedTokenAddressSync(mint,seller.publicKey);
 const original:KeepEquipmentPaymentOriginal={reservationId:randomUUID(),buyer:buyer.publicKey.toBase58(),seller:seller.publicKey.toBase58(),keepMint:mint.toBase58(),totalBaseUnits:options.total??POLICY.minFillBaseUnits,sellerAtaExists:!options.ata,...(options.ata?{sellerAtaRentCapLamports:options.rentCap??2_039_280n}:{})};
 const instructions=buildKeepEquipmentPaymentInstructions(original,limits);options.edit?.(instructions,{buyer,seller,mint,buyerAta,sellerAta});
 const table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,addresses:[buyerAta,sellerAta,mint]}});
 const p=new TransactionMessage({payerKey:buyer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions}),message=options.version===0?p.compileToV0Message(options.lut?[table]:[]):p.compileToLegacyMessage();
 const signed=new VersionedTransaction(message);signed.sign([buyer]);const signature=bs58.encode(signed.signatures[0]!);
 const loaded=message.version===0?message.resolveAddressTableLookups(options.lut?[table]:[]):{writable:[],readonly:[]};
 const keys=[...message.staticAccountKeys,...loaded.writable,...loaded.readonly],sellerAmount=original.totalBaseUnits*9n/10n;
 const token=(owner:PublicKey,ata:PublicKey,amount:bigint)=>({accountIndex:keys.findIndex(k=>k.equals(ata)),mint:mint.toBase58(),owner:owner.toBase58(),programId:TOKEN_PROGRAM_ID.toBase58(),uiTokenAmount:{amount:amount.toString(),decimals:TOKEN.decimals,uiAmount:null}});
 const created=!!options.ata&&options.ata!=='raced',sellerIndex=keys.findIndex(k=>k.equals(sellerAta));
 const preBalances=keys.map(()=>100_000_000),postBalances=[...preBalances];let rent=0;
 if(created){preBalances[sellerIndex]=options.ata==='fresh'?0:options.ata==='prefunded'?890_880:2_039_280;rent=2_039_280-preBalances[sellerIndex]!;postBalances[sellerIndex]=2_039_280;}
 postBalances[0]!-=5_000+rent;
 const inner:TransactionInstruction[]=[];
 if(created){
  inner.push(new TransactionInstruction({programId:TOKEN_PROGRAM_ID,keys:[{pubkey:mint,isSigner:false,isWritable:false}],data:Buffer.from([21,7,0])}));
  if(options.ata==='fresh')inner.push(SystemProgram.createAccount({fromPubkey:buyer.publicKey,newAccountPubkey:sellerAta,lamports:rent,space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}));
  else{if(rent)inner.push(SystemProgram.transfer({fromPubkey:buyer.publicKey,toPubkey:sellerAta,lamports:rent}));inner.push(SystemProgram.allocate({accountPubkey:sellerAta,space:ACCOUNT_SIZE}),SystemProgram.assign({accountPubkey:sellerAta,programId:TOKEN_PROGRAM_ID}));}
  inner.push(createInitializeImmutableOwnerInstruction(sellerAta,TOKEN_PROGRAM_ID),createInitializeAccount3Instruction(sellerAta,mint,seller.publicKey,TOKEN_PROGRAM_ID));
 }
 const tx:VersionedTransactionResponse={version:message.version,slot:100,blockTime:1_900_000_000,transaction:{message,signatures:[signature]},meta:{err:null,fee:5_000,
  innerInstructions:created?[{index:instructions.findIndex(ix=>ix.data.length===1&&ix.data[0]===1),instructions:inner.map(ix=>({programIdIndex:keys.findIndex(k=>k.equals(ix.programId)),accounts:ix.keys.map(a=>keys.findIndex(k=>k.equals(a.pubkey))),data:bs58.encode(ix.data),stackHeight:2}))}]:[],loadedAddresses:loaded,preBalances,postBalances,
  preTokenBalances:[token(buyer.publicKey,buyerAta,10_000_000n),...(!created?[token(seller.publicKey,sellerAta,5n)]:[])],postTokenBalances:[token(buyer.publicKey,buyerAta,10_000_000n-original.totalBaseUnits),token(seller.publicKey,sellerAta,(created?0n:5n)+sellerAmount)]}};
 const genesis=Keypair.generate().publicKey.toBase58();const rpc=():KeepEquipmentPaymentRpc=>({getGenesisHash:async()=>genesis,getSlot:async()=>101,getTransaction:async()=>tx});
 const trust={...limits,expectedGenesisHash:genesis,minContextSlot:90,deadlineMs:500,providerIds:['reviewed-one','reviewed-two'] as const};
 return {buyer,seller,mint,buyerAta,sellerAta,original,tx,signature,genesis,rpc,trust};
}
const read=(f:ReturnType<typeof fixture>)=>verifyKeepEquipmentPaymentTransaction(f.tx,f.signature,f.original,limits);
afterEach(()=>vi.useRealTimers());
it.each([['legacy',false],[0,false],[0,true]] as const)('proves signed %s LUT=%s exact transfer and real BurnChecked',async(version,lut)=>{
 const f=fixture({version,lut}),proof=read(f);expect(proof.sellerBaseUnits).toBe('900000');expect(proof.burnBaseUnits).toBe('100000');expect(proof.fenceReleaseAuthorized).toBe(false);
 const reader=createKeepEquipmentPaymentReader([()=>f.rpc(),()=>f.rpc()],f.trust);expect((await reader(f.original,f.signature)).finalizedAgreement).toBe(true);
 const built=buildKeepEquipmentPaymentMessage(f.original,limits,f.tx.transaction.message.recentBlockhash,version);expect(built.memo).toBe('pkw:keep-market:'+f.original.reservationId);expect(built.signingAuthorized).toBe(false);
});
it('rounds remainder into actual burn without losing a unit',()=>{const f=fixture({total:1_000_001n}),p=read(f);expect(p.sellerBaseUnits).toBe('900000');expect(p.burnBaseUnits).toBe('100001');});
it('accepts bounded compute prefixes and preserves exact economic instructions',()=>{
 const f=fixture({edit:ix=>ix.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:200_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:25_000n}))});expect(read(f).totalBaseUnits).toBe('1000000');
});
const malformed:[string,NonNullable<Options['edit']>][]=[
 ['wrong seller amount',ix=>ix[0]!.data.writeBigUInt64LE(900_001n,1)],['wrong burn amount',ix=>ix[1]!.data.writeBigUInt64LE(99_999n,1)],
 ['wrong transfer decimals',ix=>ix[0]!.data[9]=TOKEN.decimals-1],['wrong burn decimals',ix=>ix[1]!.data[9]=TOKEN.decimals-1],
 ['wrong mint',ix=>ix[0]!.keys[1]!.pubkey=Keypair.generate().publicKey],['auxiliary seller token account',ix=>ix[0]!.keys[2]!.pubkey=Keypair.generate().publicKey],
 ['wrong source account',ix=>ix[0]!.keys[0]!.pubkey=Keypair.generate().publicKey],['wrong authority',ix=>{ix[1]!.keys[2]!.pubkey=Keypair.generate().publicKey;ix[1]!.keys[2]!.isSigner=false;}],
 ['wrong memo',ix=>ix[2]!.data=Buffer.from('pkw:keep-market:'+randomUUID())],['memo account-indexed reference',ix=>ix[2]!.keys.push({pubkey:Keypair.generate().publicKey,isSigner:false,isWritable:false})],
 ['unchecked transfer',ix=>ix[0]!.data=Buffer.concat([Buffer.of(3),ix[0]!.data.subarray(1,9)])],
 ['third-party transfer instead of burn',(ix,f)=>ix[1]=createTransferCheckedInstruction(f.buyerAta,f.mint,f.sellerAta,f.buyer.publicKey,100_000n,TOKEN.decimals)],
 ['extra approval',(ix,f)=>ix.splice(2,0,createApproveInstruction(f.buyerAta,f.seller.publicKey,f.buyer.publicKey,1n))],
 ['extra transfer',ix=>ix.splice(1,0,ix[0]!)],['swapped burn order',ix=>[ix[0],ix[1]]=[ix[1]!,ix[0]!]],
 ['unknown top-level program',ix=>ix[1]!.programId=Keypair.generate().publicKey],
 ['system transfer',(ix,f)=>ix.unshift(SystemProgram.transfer({fromPubkey:f.buyer.publicKey,toPubkey:f.seller.publicKey,lamports:1}))],
 ['compute price without limit',ix=>ix.unshift(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1n}))],
 ['excess priority fee',ix=>ix.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:300_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1_000_000n}))],
 ['duplicate compute limit',ix=>ix.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:200_000}),ComputeBudgetProgram.setComputeUnitLimit({units:200_000}))],
];
it.each(malformed)('refuses signed %s rather than treating buyer loss as a burn',(_name,edit)=>{const f=fixture({edit});expect(()=>read(f)).toThrow(KeepEquipmentPaymentError);});
it.each(['failure','missing trace','inner burn','wrong signature','wrong balance','wrong owner','wrong token program','missing token row','extra token row','extra SOL','fee cap','missing LUT','changed LUT','unsupported version'] as const)('holds %s evidence',kind=>{
 const f=fixture({version:0,lut:true}),m=f.tx.meta!;
 if(kind==='failure')m.err={InstructionError:[1,'InsufficientFunds']};
 if(kind==='missing trace')m.innerInstructions=null;
 if(kind==='inner burn')m.innerInstructions=[{index:1,instructions:[]}];
 if(kind==='wrong signature'){f.signature=bs58.encode(new Uint8Array(64).fill(9));f.tx.transaction.signatures[0]=f.signature;}
 if(kind==='wrong balance')m.postTokenBalances![0]!.uiTokenAmount.amount='1';
 if(kind==='wrong owner')m.postTokenBalances![0]!.owner=f.seller.publicKey.toBase58();
 if(kind==='wrong token program')m.preTokenBalances![0]!.programId=SystemProgram.programId.toBase58();
 if(kind==='missing token row')m.preTokenBalances!.pop();
 if(kind==='extra token row')m.postTokenBalances!.push(m.postTokenBalances![0]!);
 if(kind==='extra SOL')m.postBalances[1]!++;
 if(kind==='fee cap')m.fee=100_001;
 if(kind==='missing LUT')m.loadedAddresses={writable:[],readonly:[]};
 if(kind==='changed LUT')m.loadedAddresses!.writable.reverse();
 if(kind==='unsupported version')Object.assign(f.tx,{version:1});
 expect(()=>read(f)).toThrow(KeepEquipmentPaymentError);
});
it.each(['below minimum','u64 overflow','same parties','ATA creation without rent consent','bad reservation'] as const)('constructor refuses %s',kind=>{
 const f=fixture();const input={...f.original};
 if(kind==='below minimum')input.totalBaseUnits=POLICY.minFillBaseUnits-1n;
 if(kind==='u64 overflow')input.totalBaseUnits=1n<<64n;
 if(kind==='same parties')input.seller=input.buyer;
 if(kind==='ATA creation without rent consent')Object.assign(input,{sellerAtaExists:false});
 if(kind==='bad reservation')input.reservationId=input.reservationId.toUpperCase();
 expect(()=>buildKeepEquipmentPaymentInstructions(input,limits)).toThrow(KeepEquipmentPaymentError);
});
it.each(['missing','failure','genesis','slot','disagreement','unavailable'] as const)('two-provider reader holds %s without unpaid or release authority',async kind=>{
 const f=fixture(),second=f.rpc();
 if(kind==='missing')second.getTransaction=async()=>null;
 if(kind==='failure')second.getTransaction=async()=>({...f.tx,meta:{...f.tx.meta!,err:'failed'}});
 if(kind==='genesis')second.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();
 if(kind==='slot')second.getSlot=async()=>99;
 if(kind==='disagreement')second.getTransaction=async()=>({...f.tx,slot:101});
 if(kind==='unavailable')second.getTransaction=async()=>{throw Error('RPC offline');};
 const reader=createKeepEquipmentPaymentReader([()=>f.rpc(),()=>second],f.trust);
 await expect(reader(f.original,f.signature)).rejects.toMatchObject({fenceReleaseAuthorized:false,unpaidProven:false});
});
it('copies trusted limits, identities and original inputs before asynchronous evidence reads',async()=>{
 const f=fixture(),trust={...f.trust,providerIds:[...f.trust.providerIds] as [string,string]};const reader=createKeepEquipmentPaymentReader([()=>f.rpc(),()=>f.rpc()],trust),request={...f.original};
 const response=reader(request,f.signature);request.totalBaseUnits=100n;trust.expectedGenesisHash=Keypair.generate().publicKey.toBase58();trust.providerIds[0]='mutated';
 expect((await response).providerIds).toEqual(['reviewed-one','reviewed-two']);
});
it('retains concurrency capacity until ALL abort-ignoring provider operations settle',async()=>{
 vi.useFakeTimers();const f=fixture(),resolvers:Array<(x:VersionedTransactionResponse|null)=>void>=[];
 const blocked=()=>({...f.rpc(),getTransaction:()=>new Promise<VersionedTransactionResponse|null>(resolve=>resolvers.push(resolve))});
 const reader=createKeepEquipmentPaymentReader([()=>({...f.rpc(),getTransaction:async()=>{throw Error('offline');}}),blocked],{...f.trust,deadlineMs:10});
 for(let i=0;i<4;i++)await expect(reader(f.original,f.signature)).rejects.toMatchObject({code:'UNAVAILABLE'});
 await expect(reader(f.original,f.signature)).rejects.toMatchObject({code:'BUSY'});
 for(const resolve of resolvers)resolve(null);await Promise.resolve();await Promise.resolve();await Promise.resolve();
});


it.each((['legacy',0] as const).flatMap(version=>(['fresh','raced','prefunded','funded-rent'] as const).map(ata=>({version,ata}))))('accepts $version $ata ATA with exactly consented rent and retained token conservation',async({version,ata})=>{
 const f=fixture({version,lut:version===0,ata}),p=read(f);expect(p.sellerAtaCreated).toBe(ata!=='raced');expect(p.createsSellerAta).toBe(true);
 expect(p.sellerAtaRentLamports).toBe(ata==='fresh'?'2039280':ata==='prefunded'?'1148400':'0');expect(p.burnBaseUnits).toBe('100000');
 expect((await createKeepEquipmentPaymentReader([()=>f.rpc(),()=>f.rpc()],f.trust)(f.original,f.signature)).finalizedAgreement).toBe(true);
 const built=buildKeepEquipmentPaymentMessage(f.original,limits,f.tx.transaction.message.recentBlockhash,version);expect(built.createsSellerAta).toBe(true);expect(built.sellerAtaRentCapLamports).toBe('2039280');
});
it('keeps ATA creation under its exact parent when compute instructions precede it',()=>{
 const f=fixture({ata:'fresh',edit:ix=>ix.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:200_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:25_000n}))});
 expect(read(f).sellerAtaCreated).toBe(true);expect(f.tx.meta!.innerInstructions![0]!.index).toBe(2);
});
it.each(['missing CPI','extra CPI','extra group','wrong parent','nested CPI','missing depth','wrong program','wrong CPI account','wrong CPI mint','wrong CPI allocation','wrong CPI owner','wrong CPI rent','wrong initialize owner','wrong data size query','inner payment','invalid data encoding'] as const)('holds ATA %s without classifying the payment as unpaid',kind=>{
 const f=fixture({ata:'fresh'}),m=f.tx.meta!,trace=m.innerInstructions![0]!,ix=trace.instructions;
 const change=(at:number,mutate:(d:Buffer)=>void)=>{const d=Buffer.from(bs58.decode(ix[at]!.data));mutate(d);ix[at]!.data=bs58.encode(d);};
 if(kind==='missing CPI')ix.pop();
 if(kind==='extra CPI')ix.push(ix[0]!);
 if(kind==='extra group')m.innerInstructions!.push({...trace,index:1});
 if(kind==='wrong parent')trace.index=1;
 if(kind==='nested CPI')Object.assign(ix[0]!,{stackHeight:3});
 if(kind==='missing depth')Object.assign(ix[0]!,{stackHeight:undefined});
 if(kind==='wrong program')ix[0]!.programIdIndex=ix[1]!.programIdIndex;
 if(kind==='wrong CPI account')ix[1]!.accounts[1]=0;
 if(kind==='wrong CPI mint')ix[0]!.accounts[0]=0;
 if(kind==='wrong CPI allocation')change(1,d=>d.writeBigUInt64LE(166n,12));
 if(kind==='wrong CPI owner')change(1,d=>d.fill(0,20));
 if(kind==='wrong CPI rent')change(1,d=>d.writeBigUInt64LE(2_039_281n,4));
 if(kind==='wrong initialize owner')change(3,d=>d.fill(0,1));
 if(kind==='wrong data size query')change(0,d=>d[1]=8);
 if(kind==='inner payment')ix[3]!.data=bs58.encode(Buffer.of(8,0,0,0,0,0,0,0,0));
 if(kind==='invalid data encoding')ix[0]!.data='0';
 expect(()=>read(f)).toThrow(KeepEquipmentPaymentError);
 try{read(f);}catch(e){expect(e).toMatchObject({fenceReleaseAuthorized:false,unpaidProven:false});}
});
it.each(['rent cap','unconsented rent','extra fee debit','rent redirected','missing seller output','extra pretoken','wrong pretoken','missing race trace','prefund missing allocate','prefund extra topup','unsafe lamports'] as const)('holds %s instead of granting stock from incomplete creation evidence',kind=>{
 const f=fixture({ata:kind.startsWith('prefund')?'prefunded':kind==='missing race trace'?'raced':'fresh'}),m=f.tx.meta!;
 if(kind==='rent cap')Object.assign(f.original,{sellerAtaRentCapLamports:1n});
 if(kind==='unconsented rent')Object.assign(f.original,{sellerAtaExists:true,sellerAtaRentCapLamports:undefined});
 if(kind==='extra fee debit')m.postBalances[0]!--;
 if(kind==='rent redirected'){const i=m.postTokenBalances![0]!.accountIndex;m.postBalances[i]!++;}
 if(kind==='missing seller output')m.postTokenBalances!.pop();
 if(kind==='extra pretoken')m.preTokenBalances!.push(m.preTokenBalances![0]!);
 if(kind==='wrong pretoken')m.preTokenBalances![0]!.owner=f.seller.publicKey.toBase58();
 if(kind==='missing race trace')m.innerInstructions=[{index:0,instructions:[]}];
 if(kind==='prefund missing allocate')m.innerInstructions![0]!.instructions.splice(2,1);
 if(kind==='prefund extra topup')m.innerInstructions![0]!.instructions.splice(2,0,m.innerInstructions![0]!.instructions[1]!);
 if(kind==='unsafe lamports')m.preBalances[0]=Number.MAX_SAFE_INTEGER+1;
 expect(()=>read(f)).toThrow(KeepEquipmentPaymentError);
});
it.each([undefined,0n,-1n,BigInt(Number.MAX_SAFE_INTEGER)+1n])('requires a positive bounded frozen rent consent, received %s',sellerAtaRentCapLamports=>{
 const f=fixture();expect(()=>buildKeepEquipmentPaymentInstructions({...f.original,sellerAtaExists:false,...(sellerAtaRentCapLamports===undefined?{}:{sellerAtaRentCapLamports})},limits)).toThrow(KeepEquipmentPaymentError);
});
it.each(['non-idempotent','different ATA','different owner','different System program','different token program'] as const)('refuses signed ATA template change: %s',kind=>{
 const f=fixture({ata:'fresh',edit:ix=>{const a=ix[0]!;if(kind==='non-idempotent')a.data=Buffer.alloc(0);else a.keys[kind==='different ATA'?1:kind==='different owner'?2:kind==='different System program'?4:5]!.pubkey=Keypair.generate().publicKey;}});
 expect(()=>read(f)).toThrow(KeepEquipmentPaymentError);
});
it('requires provider agreement on rent, creation outcome and CPI profile',async()=>{
 const f=fixture({ata:'fresh'}),second=f.rpc();second.getTransaction=async()=>({...f.tx,meta:{...f.tx.meta!,innerInstructions:[]}});
 await expect(createKeepEquipmentPaymentReader([()=>f.rpc(),()=>second],f.trust)(f.original,f.signature)).rejects.toMatchObject({unpaidProven:false,fenceReleaseAuthorized:false});
});
it('preserves excess lamports already on a prefunded canonical ATA without charging the buyer again',()=>{
 const f=fixture({ata:'funded-rent'}),m=f.tx.meta!,index=m.postTokenBalances![1]!.accountIndex;
 m.preBalances[index]!+=100_000;m.postBalances[index]!+=100_000;
 const proof=read(f);expect(proof.sellerAtaCreated).toBe(true);expect(proof.sellerAtaRentLamports).toBe('0');expect(proof.lamportsAfter[index]).toBe(2_139_280);
});
