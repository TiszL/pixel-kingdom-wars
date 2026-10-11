/** Application-owned finalized KEEP payment preparation, never request-owned RPC.
 * This quotes the full ATA rent even for a prefunded canonical system account.
 * The immutable DB preparation must retain the resulting original and rent cap
 * separately from signed bytes: SPL CreateIdempotent encodes no rent maximum.
 * No signature, relay, delivery, nonpayment or cancellation authority follows. */
import {createHash} from 'node:crypto';
import {Message,MessageV0,PublicKey,SystemProgram} from '@solana/web3.js';
import {ACCOUNT_SIZE,MINT_SIZE,AccountLayout,AccountState,MintLayout,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {TOKEN} from '@shardkeep/shared';
import {buildKeepEquipmentPaymentInstructions,buildKeepEquipmentPaymentMessage,type KeepEquipmentPaymentOriginal,type KeepEquipmentPaymentLimits,type KeepEquipmentPaymentTrust} from './keepEquipmentPayment';

type Options={commitment:'finalized';minContextSlot:number};
type Context<T>={context:{slot:number};value:T};
export interface KeepEquipmentPreparationAccount {readonly owner:PublicKey;readonly executable:boolean;readonly lamports:number;readonly data:Uint8Array}
export interface KeepEquipmentPaymentPreparationRpc {
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:Options):Promise<Context<Array<KeepEquipmentPreparationAccount|null>>>;
 getMinimumBalanceForRentExemption(bytes:number,commitment:'finalized'):Promise<number>;
 getLatestBlockhashAndContext(options:Options):Promise<Context<{blockhash:string;lastValidBlockHeight:number}>>;
 getFeeForMessage(message:Message|MessageV0,commitment:'finalized'):Promise<Context<number|null>>;
 isBlockhashValid(blockhash:string,options:Options):Promise<Context<boolean>>;
 getBlockHeight(options:Options):Promise<number>;
}
export interface KeepEquipmentPaymentPreparationTrust extends KeepEquipmentPaymentTrust {
 readonly expectedKeepMint:string;readonly transactionVersion:'legacy'|0;
}
export type KeepEquipmentPaymentFill=Pick<KeepEquipmentPaymentOriginal,'reservationId'|'buyer'|'seller'|'keepMint'|'totalBaseUnits'>;
export class KeepEquipmentPaymentPreparationError extends Error {
 readonly signingAuthorized=false;readonly broadcastAuthorized=false;readonly deliveryAuthorized=false;
 readonly fenceReleaseAuthorized=false;readonly unpaidProven=false;
 constructor(readonly code:string){super(`KEEP payment preparation held: ${code}`);this.name='KeepEquipmentPaymentPreparationError';}
}
function need(v:unknown,code:string):asserts v{if(!v)throw new KeepEquipmentPaymentPreparationError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function address(v:unknown){need(typeof v==='string'&&v.length>=32&&v.length<=44,'INPUT');try{const key=new PublicKey(v);need(key.toBase58()===v,'INPUT');return key;}catch{throw new KeepEquipmentPaymentPreparationError('INPUT');}}
function context<T>(raw:Context<T>,floor:number,code:string){need(raw&&safe(raw.context?.slot)&&raw.context.slot>=floor,code);return raw;}
function account(raw:KeepEquipmentPreparationAccount|null,key:PublicKey,maxBytes:number){
 if(raw===null)return null;
 need(raw&&raw.owner instanceof PublicKey&&raw.executable===false&&safe(raw.lamports)&&raw.data instanceof Uint8Array&&raw.data.length<=maxBytes,'ACCOUNT');
 const data=Buffer.from(raw.data),owner=new PublicKey(raw.owner.toBytes());
 return {data,owner,lamports:BigInt(raw.lamports),facts:Object.freeze({address:key.toBase58(),owner:owner.toBase58(),lamports:String(raw.lamports),dataLength:data.length,dataSha256:hash(data),executable:false as const})};
}
function token(row:ReturnType<typeof account>,mint:PublicKey,wallet:PublicKey){
 need(row&&row.owner.equals(TOKEN_PROGRAM_ID)&&row.data.length===ACCOUNT_SIZE,'TOKEN_ACCOUNT');
 const value=AccountLayout.decode(row.data);
 need(value.mint.equals(mint)&&value.owner.equals(wallet)&&value.state===AccountState.Initialized&&value.isNativeOption===0
  &&(value.delegateOption===0||value.delegateOption===1)&&(value.closeAuthorityOption===0||value.closeAuthorityOption===1),'TOKEN_ACCOUNT');
 return value.amount;
}
/** Connectors and all pins are supplied once by private operator configuration.
 * The returned function accepts only the immutable original fill, never an RPC,
 * client-supplied account observation or a preverified preparation. */
export function createKeepEquipmentPaymentPreparationReader(connect:readonly[(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc,(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc],input:KeepEquipmentPaymentPreparationTrust){
 need(input&&typeof input==='object'&&Array.isArray(connect)&&connect.length===2&&connect.every(c=>typeof c==='function'),'INPUT');
 const expectedGenesisHash=address(input.expectedGenesisHash).toBase58(),expectedKeepMint=address(input.expectedKeepMint).toBase58(),minContextSlot=input.minContextSlot,deadlineMs=input.deadlineMs,transactionVersion=input.transactionVersion;
 need(Array.isArray(input.providerIds)&&input.providerIds.length===2,'INPUT');const providerIds=Object.freeze([...input.providerIds]);
 need(providerIds.every(v=>typeof v==='string'&&v.length>0&&v.length<=128)&&providerIds[0]!==providerIds[1]
  &&safe(minContextSlot)&&safe(deadlineMs)&&deadlineMs>0&&deadlineMs<=60_000&&(transactionVersion==='legacy'||transactionVersion===0),'INPUT');
 const limits:Readonly<KeepEquipmentPaymentLimits>=Object.freeze({maxFeeLamports:input.maxFeeLamports,maxPriorityFeeLamports:input.maxPriorityFeeLamports,maxComputeUnitLimit:input.maxComputeUnitLimit});
 const u64=(1n<<64n)-1n;
 need(typeof limits.maxFeeLamports==='bigint'&&limits.maxFeeLamports>=0n&&limits.maxFeeLamports<=u64&&typeof limits.maxPriorityFeeLamports==='bigint'
  &&limits.maxPriorityFeeLamports>=0n&&limits.maxPriorityFeeLamports<=limits.maxFeeLamports&&safe(limits.maxComputeUnitLimit)&&limits.maxComputeUnitLimit>0&&limits.maxComputeUnitLimit<=1_400_000,'INPUT');
 const connectors=[...connect];let pending=0;
 return async(fill:KeepEquipmentPaymentFill)=>{
  let originalFill:Readonly<KeepEquipmentPaymentFill>;
  try{
   need(fill&&typeof fill==='object'&&!Array.isArray(fill),'INPUT');
   const fields=Reflect.ownKeys(fill);need(fields.length===5&&fields.every(k=>typeof k==='string'&&['reservationId','buyer','seller','keepMint','totalBaseUnits'].includes(k)),'INPUT');
   originalFill=Object.freeze({reservationId:fill.reservationId,buyer:fill.buyer,seller:fill.seller,keepMint:fill.keepMint,totalBaseUnits:fill.totalBaseUnits});
   need(originalFill.keepMint===expectedKeepMint,'MINT');buildKeepEquipmentPaymentInstructions({...originalFill,sellerAtaExists:true},limits);
  }catch(error){if(error instanceof KeepEquipmentPaymentPreparationError)throw error;throw new KeepEquipmentPaymentPreparationError('INPUT');}
  need(pending<4,'BUSY');pending++;
  const controller=new AbortController(),requests=new Set<Promise<unknown>>();let timer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>need(!controller.signal.aborted,'DEADLINE');
  async function call<T>(operation:()=>Promise<T>):Promise<T>{
   active();const request=Promise.resolve().then(()=>{active();return operation();});requests.add(request);
   try{const value=await request;active();return value;}finally{requests.delete(request);}
  }
  const buyer=address(originalFill.buyer),seller=address(originalFill.seller),mint=address(originalFill.keepMint),buyerAta=getAssociatedTokenAddressSync(mint,buyer),sellerAta=getAssociatedTokenAddressSync(mint,seller);
  const keys=[mint,buyerAta,sellerAta,buyer];
  const work=(async()=>{
   const banks=await Promise.all(connectors.map(async open=>{
    active();const raw=open(controller.signal);
    const names=['getGenesisHash','getSlot','getMultipleAccountsInfoAndContext','getMinimumBalanceForRentExemption','getLatestBlockhashAndContext','getFeeForMessage','isBlockhashValid','getBlockHeight'] as const;
    need(raw&&names.every(name=>typeof raw[name]==='function'),'UNAVAILABLE');
    // Freeze method identities before the first await; later property mutation
    // cannot replace an application-owned connector method within this read.
    const rpc=Object.fromEntries(names.map(name=>[name,raw[name].bind(raw)])) as unknown as KeepEquipmentPaymentPreparationRpc;
    need(await call(()=>rpc.getGenesisHash())===expectedGenesisHash,'GENESIS');
    const openingSlot=await call(()=>rpc.getSlot('finalized'));need(safe(openingSlot)&&openingSlot>=minContextSlot,'CONTEXT');
    const snapshot=context(await call(()=>rpc.getMultipleAccountsInfoAndContext(keys.map(k=>new PublicKey(k.toBytes())),{commitment:'finalized',minContextSlot:openingSlot})),openingSlot,'CONTEXT');
    const accountSlot=snapshot.context.slot;need(Array.isArray(snapshot.value)&&snapshot.value.length===4,'ACCOUNT');
    const rows=snapshot.value.map((row,i)=>account(row,keys[i]!,i===0?MINT_SIZE:i===3?0:ACCOUNT_SIZE));
    const mintRow=rows[0];need(mintRow&&mintRow.owner.equals(TOKEN_PROGRAM_ID)&&mintRow.data.length===MINT_SIZE,'MINT');
    const mintState=MintLayout.decode(mintRow.data);
    need(mintState.isInitialized===true&&mintRow.data[45]===1&&mintState.decimals===TOKEN.decimals&&(mintState.mintAuthorityOption===0||mintState.mintAuthorityOption===1)&&(mintState.freezeAuthorityOption===0||mintState.freezeAuthorityOption===1),'MINT');
    const buyerKeep=token(rows[1]!,mint,buyer);need(buyerKeep>=originalFill.totalBaseUnits,'KEEP_BALANCE');
    const sellerRow=rows[2];let sellerKeep:bigint|null=null,sellerState:'existing'|'missing'|'prefunded';
    if(sellerRow?.owner.equals(TOKEN_PROGRAM_ID)){sellerKeep=token(sellerRow,mint,seller);sellerState='existing';}
    else{need(sellerRow===null||sellerRow&&sellerRow.owner.equals(SystemProgram.programId)&&sellerRow.data.length===0,'SELLER_ACCOUNT');sellerState=sellerRow===null?'missing':'prefunded';}
    const wallet=rows[3];need(wallet&&wallet.owner.equals(SystemProgram.programId)&&wallet.data.length===0,'BUYER_WALLET');
    const rent=await call(()=>rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE,'finalized'));need(safe(rent)&&rent>0,'RENT');
    const facts=Object.freeze(rows.map((row,i)=>row?.facts??Object.freeze({address:keys[i]!.toBase58(),owner:null,lamports:'0',dataLength:0,dataSha256:null,executable:false as const})));
    const accountEvidenceSha256=hash(Buffer.from(JSON.stringify({facts,rent})));
    return {rpc,openingSlot,accountSlot,facts,accountEvidenceSha256,buyerKeep,sellerKeep,sellerState,buyerSol:wallet.lamports,rent:BigInt(rent)};
   }));
   active();const first=banks[0]!,second=banks[1]!;need(first.accountEvidenceSha256===second.accountEvidenceSha256,'PROVIDER_MISMATCH');
   const floor=Math.max(first.accountSlot,second.accountSlot);
   const block=context(await call(()=>first.rpc.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:floor})),floor,'BLOCKHASH');
   need(block.value&&safe(block.value.lastValidBlockHeight)&&block.value.lastValidBlockHeight>0,'BLOCKHASH');
   const blockhash=address(block.value.blockhash).toBase58(),lastValidBlockHeight=block.value.lastValidBlockHeight,blockhashSlot=block.context.slot;
   const createAta=first.sellerState!=='existing',rentLamports=createAta?first.rent:0n;
   const original:Readonly<KeepEquipmentPaymentOriginal>=Object.freeze({...originalFill,sellerAtaExists:!createAta,...(createAta?{sellerAtaRentCapLamports:rentLamports}:{})});
   const built=buildKeepEquipmentPaymentMessage(original,limits,blockhash,transactionVersion),bytes=Uint8Array.from(built.messageBytes);
   const observations=await Promise.all(banks.map(async bank=>{
    const message=transactionVersion==='legacy'?Message.from(bytes):MessageV0.deserialize(bytes);
    const fee=context(await call(()=>bank.rpc.getFeeForMessage(message,'finalized')),blockhashSlot,'FEE');
    need(safe(fee.value)&&BigInt(fee.value)<=limits.maxFeeLamports,'FEE');const feeSlot=fee.context.slot,feeLamports=BigInt(fee.value);
    const valid=context(await call(()=>bank.rpc.isBlockhashValid(blockhash,{commitment:'finalized',minContextSlot:Math.max(blockhashSlot,feeSlot)})),Math.max(blockhashSlot,feeSlot),'BLOCKHASH');need(valid.value===true,'BLOCKHASH');const validitySlot=valid.context.slot;
    const height=await call(()=>bank.rpc.getBlockHeight({commitment:'finalized',minContextSlot:validitySlot}));need(safe(height)&&height<=lastValidBlockHeight,'EXPIRED');
    const closingSlot=await call(()=>bank.rpc.getSlot('finalized'));need(safe(closingSlot)&&closingSlot>=validitySlot,'CONTEXT');
    need(await call(()=>bank.rpc.getGenesisHash())===expectedGenesisHash,'GENESIS');
    return Object.freeze({openingSlot:bank.openingSlot,accountSlot:bank.accountSlot,feeSlot,validitySlot,closingSlot,currentBlockHeight:height,feeLamports});
   }));
   active();need(observations[0]!.feeLamports===observations[1]!.feeLamports,'PROVIDER_MISMATCH');
   const feeLamports=observations[0]!.feeLamports,totalLamports=feeLamports+rentLamports;need(first.buyerSol>=totalLamports,'SOL_BALANCE');
   return Object.freeze({version:1 as const,transactionVersion,original,limits,expectedGenesisHash,expectedKeepMint,providerIds,
    blockhash,lastValidBlockHeight,blockhashSlot,minContextSlot:blockhashSlot,messageSha256:built.messageSha256,get messageBytes(){return Uint8Array.from(bytes);},
    observedAccounts:first.facts,accountEvidenceSha256:first.accountEvidenceSha256,observations:Object.freeze(observations),
    balances:Object.freeze({buyerKeepBaseUnits:first.buyerKeep,sellerKeepBaseUnits:first.sellerKeep,buyerSolLamports:first.buyerSol,sellerAccountState:first.sellerState}),
    costs:Object.freeze({feeLamports,rentLamports,fullAtaRentLamports:first.rent,totalLamports}),
    signingAuthorized:false as const,broadcastAuthorized:false as const,deliveryAuthorized:false as const,fenceReleaseAuthorized:false as const,unpaidProven:false as const});
  })().catch(error=>{controller.abort();throw error;});
  // A deadline/failing peer does not free capacity while an adapter that ignores
  // abort still owns an outstanding RPC. Aborted workers cannot schedule more.
  const drain=async()=>{await Promise.allSettled([...requests]);pending--;};void work.then(drain,drain);
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new KeepEquipmentPaymentPreparationError('DEADLINE'));},deadlineMs);})]);}
  catch(error){if(error instanceof KeepEquipmentPaymentPreparationError)throw error;throw new KeepEquipmentPaymentPreparationError('UNAVAILABLE');}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
export type KeepEquipmentPaymentPreparation=Awaited<ReturnType<ReturnType<typeof createKeepEquipmentPaymentPreparationReader>>>;
