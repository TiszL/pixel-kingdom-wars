/** Current finalized review of one privately loaded, immutable preparation.
 * Never replaces its blockhash/message or proves payment, nonpayment or release.
 * A successful read remains separate from retained signed wire and explicit
 * client consent. CreateIdempotent still has no on-chain rent-cap operand. */
import {createHash} from 'node:crypto';
import {Message,MessageV0,PACKET_DATA_SIZE,PublicKey,SystemProgram} from '@solana/web3.js';
import {ACCOUNT_SIZE,MINT_SIZE,AccountLayout,AccountState,MintLayout,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {TOKEN} from '@shardkeep/shared';
import {buildKeepEquipmentPaymentMessage,type KeepEquipmentPaymentOriginal,type KeepEquipmentPaymentLimits} from './keepEquipmentPayment';
import type {KeepEquipmentPreparationAccount,KeepEquipmentPaymentPreparationRpc,KeepEquipmentPaymentPreparationTrust} from './keepEquipmentPaymentPreparation';

export interface KeepEquipmentPaymentCurrentInput {
 readonly original:KeepEquipmentPaymentOriginal;readonly messageBytes:Uint8Array;readonly messageSha256:string;
 readonly blockhash:string;readonly lastValidBlockHeight:number;readonly minContextSlot:number;
}
export class KeepEquipmentPaymentCurrentError extends Error {
 readonly signingAuthorized=false;readonly broadcastAuthorized=false;readonly deliveryAuthorized=false;
 readonly fenceReleaseAuthorized=false;readonly unpaidProven=false;readonly finalityVerified=false;
 constructor(readonly code:string){super(`KEEP payment current review held: ${code}`);this.name='KeepEquipmentPaymentCurrentError';}
}
function need(v:unknown,code:string):asserts v{if(!v)throw new KeepEquipmentPaymentCurrentError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function address(v:unknown){need(typeof v==='string'&&v.length>=32&&v.length<=44,'INPUT');try{const key=new PublicKey(v);need(key.toBase58()===v,'INPUT');return key;}catch{throw new KeepEquipmentPaymentCurrentError('INPUT');}}
function fields(v:unknown,required:string,optional=''){
 need(v&&typeof v==='object'&&!Array.isArray(v),'INPUT');const names=required.split(' '),allowed=[...names,...optional.split(' ')];
 need(names.every(k=>Object.hasOwn(v,k))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&allowed.includes(k)),'INPUT');
}
function context<T>(raw:{context:{slot:number};value:T},floor:number,code:string){need(raw&&safe(raw.context?.slot)&&raw.context.slot>=floor,code);return raw;}
function account(raw:KeepEquipmentPreparationAccount|null,key:PublicKey,maxBytes:number){
 if(raw===null)return null;
 need(raw&&raw.owner instanceof PublicKey&&raw.executable===false&&safe(raw.lamports)&&raw.data instanceof Uint8Array&&raw.data.length<=maxBytes,'ACCOUNT');
 const data=Buffer.from(raw.data),owner=new PublicKey(raw.owner.toBytes());
 return {data,owner,lamports:BigInt(raw.lamports),facts:Object.freeze({address:key.toBase58(),owner:owner.toBase58(),lamports:String(raw.lamports),dataLength:data.length,dataSha256:hash(data),executable:false as const})};
}
function token(row:ReturnType<typeof account>,mint:PublicKey,wallet:PublicKey){
 need(row&&row.owner.equals(TOKEN_PROGRAM_ID)&&row.data.length===ACCOUNT_SIZE,'TOKEN_ACCOUNT');const value=AccountLayout.decode(row.data);
 need(value.mint.equals(mint)&&value.owner.equals(wallet)&&value.state===AccountState.Initialized&&value.isNativeOption===0
  &&(value.delegateOption===0||value.delegateOption===1)&&(value.closeAuthorityOption===0||value.closeAuthorityOption===1),'TOKEN_ACCOUNT');
 return value.amount;
}
/** Connectors, mint/genesis/version and fee limits are fixed private operator
 * inputs. The returned reader takes the saved preparation, never client-owned
 * instructions, RPCs, observations, or claimed authority. */
export function createKeepEquipmentPaymentCurrentReader(connect:readonly[(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc,(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc],input:KeepEquipmentPaymentPreparationTrust){
 need(input&&typeof input==='object'&&Array.isArray(connect)&&connect.length===2&&connect.every(c=>typeof c==='function'),'INPUT');
 const expectedGenesisHash=address(input.expectedGenesisHash).toBase58(),expectedKeepMint=address(input.expectedKeepMint).toBase58(),minContextSlot=input.minContextSlot,deadlineMs=input.deadlineMs,transactionVersion=input.transactionVersion;
 need(Array.isArray(input.providerIds)&&input.providerIds.length===2,'INPUT');const providerIds=Object.freeze([...input.providerIds]);
 need(providerIds.every(v=>typeof v==='string'&&v.length>0&&v.length<=128)&&providerIds[0]!==providerIds[1]
  &&safe(minContextSlot)&&safe(deadlineMs)&&deadlineMs>0&&deadlineMs<=60_000&&(transactionVersion==='legacy'||transactionVersion===0),'INPUT');
 const limits:Readonly<KeepEquipmentPaymentLimits>=Object.freeze({maxFeeLamports:input.maxFeeLamports,maxPriorityFeeLamports:input.maxPriorityFeeLamports,maxComputeUnitLimit:input.maxComputeUnitLimit}),u64=(1n<<64n)-1n;
 need(typeof limits.maxFeeLamports==='bigint'&&limits.maxFeeLamports>=0n&&limits.maxFeeLamports<=u64&&typeof limits.maxPriorityFeeLamports==='bigint'
  &&limits.maxPriorityFeeLamports>=0n&&limits.maxPriorityFeeLamports<=limits.maxFeeLamports&&safe(limits.maxComputeUnitLimit)&&limits.maxComputeUnitLimit>0&&limits.maxComputeUnitLimit<=1_400_000,'INPUT');
 const connectors=[...connect];let pending=0;
 return async(inputSaved:KeepEquipmentPaymentCurrentInput)=>{
  let original:Readonly<KeepEquipmentPaymentOriginal>,bytes:Uint8Array,messageSha256:string,blockhash:string,lastValidBlockHeight:number,originalMinContextSlot:number;
  try{
   fields(inputSaved,'original messageBytes messageSha256 blockhash lastValidBlockHeight minContextSlot');
   const source=inputSaved.original;fields(source,'reservationId buyer seller keepMint totalBaseUnits sellerAtaExists','sellerAtaRentCapLamports');
   original=Object.freeze({reservationId:source.reservationId,buyer:source.buyer,seller:source.seller,keepMint:source.keepMint,totalBaseUnits:source.totalBaseUnits,
    sellerAtaExists:source.sellerAtaExists,...(source.sellerAtaRentCapLamports!==undefined?{sellerAtaRentCapLamports:source.sellerAtaRentCapLamports}:{})});
   need(original.keepMint===expectedKeepMint,'MINT');
   const raw=inputSaved.messageBytes;need(raw instanceof Uint8Array&&raw.length>0&&raw.length<=PACKET_DATA_SIZE-65,'INPUT');bytes=Uint8Array.from(raw);
   messageSha256=inputSaved.messageSha256;blockhash=address(inputSaved.blockhash).toBase58();lastValidBlockHeight=inputSaved.lastValidBlockHeight;originalMinContextSlot=inputSaved.minContextSlot;
   need(typeof messageSha256==='string'&&/^[0-9a-f]{64}$/.test(messageSha256)&&safe(lastValidBlockHeight)&&lastValidBlockHeight>0&&safe(originalMinContextSlot),'INPUT');
   const built=buildKeepEquipmentPaymentMessage(original,limits,blockhash,transactionVersion);
   // Canonical recompilation forbids extra instructions, alternate payer/order,
   // LUTs, compute budgets, alternate serialization and replacement blockhashes.
   need(built.messageSha256===messageSha256&&hash(bytes)===messageSha256&&Buffer.from(built.messageBytes).equals(Buffer.from(bytes)),'MESSAGE');
  }catch(error){if(error instanceof KeepEquipmentPaymentCurrentError)throw error;throw new KeepEquipmentPaymentCurrentError('INPUT');}
  const buyer=address(original.buyer),seller=address(original.seller),mint=address(original.keepMint),keys=[mint,getAssociatedTokenAddressSync(mint,buyer),getAssociatedTokenAddressSync(mint,seller),buyer];
  need(pending<4,'BUSY');pending++;
  const controller=new AbortController(),requests=new Set<Promise<unknown>>();let timer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>need(!controller.signal.aborted,'DEADLINE');
  async function call<T>(operation:()=>Promise<T>):Promise<T>{
   active();const request=Promise.resolve().then(()=>{active();return operation();});requests.add(request);
   try{const value=await request;active();return value;}finally{requests.delete(request);}
  }
  const work=(async()=>{
   const banks=await Promise.all(connectors.map(async open=>{
    active();const raw=open(controller.signal),names=['getGenesisHash','getSlot','getMultipleAccountsInfoAndContext','getMinimumBalanceForRentExemption','getFeeForMessage','isBlockhashValid','getBlockHeight'] as const;
    need(raw&&names.every(name=>typeof raw[name]==='function'),'UNAVAILABLE');
    const rpc=Object.freeze(Object.fromEntries(names.map(name=>[name,raw[name].bind(raw)]))) as unknown as KeepEquipmentPaymentPreparationRpc;
    need(await call(()=>rpc.getGenesisHash())===expectedGenesisHash,'GENESIS');
    const openingSlot=await call(()=>rpc.getSlot('finalized'));need(safe(openingSlot)&&openingSlot>=Math.max(minContextSlot,originalMinContextSlot),'CONTEXT');
    const snapshot=context(await call(()=>rpc.getMultipleAccountsInfoAndContext(keys.map(k=>new PublicKey(k.toBytes())),{commitment:'finalized',minContextSlot:openingSlot})),openingSlot,'CONTEXT');
    const accountSlot=snapshot.context.slot;need(Array.isArray(snapshot.value)&&snapshot.value.length===4,'ACCOUNT');
    const rows=snapshot.value.map((row,i)=>account(row,keys[i]!,i===0?MINT_SIZE:i===3?0:ACCOUNT_SIZE));
    const mintRow=rows[0];need(mintRow&&mintRow.owner.equals(TOKEN_PROGRAM_ID)&&mintRow.data.length===MINT_SIZE,'MINT');
    const mintState=MintLayout.decode(mintRow.data);
    need(mintState.isInitialized===true&&mintRow.data[45]===1&&mintState.decimals===TOKEN.decimals&&(mintState.mintAuthorityOption===0||mintState.mintAuthorityOption===1)&&(mintState.freezeAuthorityOption===0||mintState.freezeAuthorityOption===1),'MINT');
    const buyerKeep=token(rows[1]!,mint,buyer);need(buyerKeep>=original.totalBaseUnits,'KEEP_BALANCE');
    const sellerRow=rows[2];let sellerKeep:bigint|null=null,sellerState:'existing'|'missing'|'prefunded';
    if(sellerRow?.owner.equals(TOKEN_PROGRAM_ID)){sellerKeep=token(sellerRow,mint,seller);sellerState='existing';}
    else{need(!original.sellerAtaExists&&(sellerRow===null||sellerRow&&sellerRow.owner.equals(SystemProgram.programId)&&sellerRow.data.length===0),'SELLER_ACCOUNT');sellerState=sellerRow===null?'missing':'prefunded';}
    const wallet=rows[3];need(wallet&&wallet.owner.equals(SystemProgram.programId)&&wallet.data.length===0,'BUYER_WALLET');
    const rent=await call(()=>rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE,'finalized'));need(safe(rent)&&rent>0,'RENT');
    // Even a currently existing ATA can close before execution. Keep the full
    // 165-byte rent bound and funding for the saved create instruction.
    need(original.sellerAtaExists||BigInt(rent)<=original.sellerAtaRentCapLamports!,'ATA_RENT_CAP');
    const facts=Object.freeze(rows.map((row,i)=>row?.facts??Object.freeze({address:keys[i]!.toBase58(),owner:null,lamports:'0',dataLength:0,dataSha256:null,executable:false as const})));
    return {rpc,openingSlot,accountSlot,facts,accountEvidenceSha256:hash(Buffer.from(JSON.stringify({facts,rent}))),buyerKeep,sellerKeep,sellerState,buyerSol:wallet.lamports,rent:BigInt(rent)};
   }));
   active();const first=banks[0]!,second=banks[1]!;need(first.accountEvidenceSha256===second.accountEvidenceSha256,'PROVIDER_MISMATCH');
   const floor=Math.max(first.accountSlot,second.accountSlot);
   const observations=await Promise.all(banks.map(async bank=>{
    const message=transactionVersion==='legacy'?Message.from(bytes):MessageV0.deserialize(bytes);
    const fee=context(await call(()=>bank.rpc.getFeeForMessage(message,'finalized')),floor,'FEE');
    need(safe(fee.value)&&BigInt(fee.value)<=limits.maxFeeLamports,'FEE');const feeSlot=fee.context.slot,feeLamports=BigInt(fee.value);
    const validityFloor=Math.max(floor,feeSlot),valid=context(await call(()=>bank.rpc.isBlockhashValid(blockhash,{commitment:'finalized',minContextSlot:validityFloor})),validityFloor,'BLOCKHASH');
    need(valid.value===true,'BLOCKHASH');const validitySlot=valid.context.slot;
    const height=await call(()=>bank.rpc.getBlockHeight({commitment:'finalized',minContextSlot:validitySlot}));need(safe(height)&&height<=lastValidBlockHeight,'EXPIRED');
    const closingSlot=await call(()=>bank.rpc.getSlot('finalized'));need(safe(closingSlot)&&closingSlot>=validitySlot,'CONTEXT');
    need(await call(()=>bank.rpc.getGenesisHash())===expectedGenesisHash,'GENESIS');
    return Object.freeze({openingSlot:bank.openingSlot,accountSlot:bank.accountSlot,feeSlot,validitySlot,closingSlot,currentBlockHeight:height,feeLamports});
   }));
   active();need(observations[0]!.feeLamports===observations[1]!.feeLamports,'PROVIDER_MISMATCH');
   const feeLamports=observations[0]!.feeLamports,rentLamports=original.sellerAtaExists?0n:first.rent,totalLamports=feeLamports+rentLamports;
   need(first.buyerSol>=totalLamports,'SOL_BALANCE');
   return Object.freeze({version:1 as const,transactionVersion,original,limits,expectedGenesisHash,expectedKeepMint,providerIds,
    blockhash,lastValidBlockHeight,minContextSlot:originalMinContextSlot,messageSha256,get messageBytes(){return Uint8Array.from(bytes);},
    observedAccounts:first.facts,accountEvidenceSha256:first.accountEvidenceSha256,observations:Object.freeze(observations),
    balances:Object.freeze({buyerKeepBaseUnits:first.buyerKeep,sellerKeepBaseUnits:first.sellerKeep,buyerSolLamports:first.buyerSol,sellerAccountState:first.sellerState}),
    costs:Object.freeze({feeLamports,rentLamports,fullAtaRentLamports:first.rent,totalLamports}),
    currentReviewPassed:true as const,signingAuthorized:false as const,broadcastAuthorized:false as const,deliveryAuthorized:false as const,fenceReleaseAuthorized:false as const,unpaidProven:false as const,finalityVerified:false as const});
  })().catch(error=>{controller.abort();throw error;});
  // An ignored abort still occupies the bounded reader until the outstanding
  // calls drain. A rejected peer cannot leave another scheduling further work.
  const drain=async()=>{await Promise.allSettled([...requests]);pending--;};void work.then(drain,drain);
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new KeepEquipmentPaymentCurrentError('DEADLINE'));},deadlineMs);})]);}
  catch(error){if(error instanceof KeepEquipmentPaymentCurrentError)throw error;throw new KeepEquipmentPaymentCurrentError('UNAVAILABLE');}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
export type KeepEquipmentPaymentCurrent=Awaited<ReturnType<ReturnType<typeof createKeepEquipmentPaymentCurrentReader>>>;
