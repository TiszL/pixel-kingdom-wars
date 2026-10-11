/** Independent wallet-side Classic SPL checks of the exact reviewed packet. */
import {Message,MessageV0,PublicKey,SystemProgram,type Connection} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as P,TOKEN} from '@shardkeep/shared';
import {KeepEquipmentReviewSchema,type KeepEquipmentPurchase} from '@shardkeep/shared/keepEquipmentMarketApi';
import {canonicalKeepEquipmentMessage,keepEquipmentTrust,KEEP_TOKEN_PROGRAM,need,type KeepEquipmentSigningTrust} from './signing';
export type KeepEquipmentCurrentConnection=Pick<Connection,'getGenesisHash'|'getMultipleAccountsInfoAndContext'|'getMinimumBalanceForRentExemption'|'getFeeForMessage'|'isBlockhashValid'|'getBlockHeight'|'getSignatureStatuses'>;
const safe=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export function createKeepEquipmentCurrentChecks(input:KeepEquipmentCurrentConnection,pins:KeepEquipmentSigningTrust){
 const trust=keepEquipmentTrust(pins),connection={getGenesisHash:input.getGenesisHash.bind(input),getMultipleAccountsInfoAndContext:input.getMultipleAccountsInfoAndContext.bind(input),getMinimumBalanceForRentExemption:input.getMinimumBalanceForRentExemption.bind(input),getFeeForMessage:input.getFeeForMessage.bind(input),isBlockhashValid:input.isBlockhashValid.bind(input),getBlockHeight:input.getBlockHeight.bind(input),getSignatureStatuses:input.getSignatureStatuses.bind(input)};
 let pending=0;
 return async(raw:KeepEquipmentPurchase,reviewRaw:unknown,started:number,guard:()=>void)=>{
  const review=KeepEquipmentReviewSchema.parse(reviewRaw),built=await canonicalKeepEquipmentMessage(raw),v=built.value,p=v.preparation!,o=p.original;
  need(review.purchase.fill.id===v.fill.id&&JSON.stringify(review.purchase.fill)===JSON.stringify(v.fill)&&JSON.stringify(review.purchase.preparation)===JSON.stringify(p)&&review.current.messageSha256===p.messageSha256&&review.current.messageHex===p.messageHex
   &&review.current.blockhash===p.blockhash&&review.current.lastValidBlockHeight===p.lastValidBlockHeight&&review.current.expectedGenesisHash===trust.expectedGenesisHash&&review.current.expectedKeepMint===trust.expectedKeepMint,'Review no longer matches this original purchase.');
  need(!review.purchase.delivery&&JSON.stringify(review.purchase.wire)===JSON.stringify(v.wire),'Another session advanced this purchase. Recover its original payment.');
  need(p.expectedGenesisHash===trust.expectedGenesisHash&&p.expectedKeepMint===trust.expectedKeepMint&&BigInt(p.limits.maxFeeLamports)<=BigInt(trust.maxFeeLamports)&&BigInt(o.sellerAtaRentCapLamports??'0')<=BigInt(trust.maxAtaRentLamports));
  let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>{guard();const age=performance.now()-started;need(!expired&&age>=0&&age<P.reviewMaxAgeMs,'Payment review expired. Refresh this same purchase.');};
  const call=async<T>(operation:()=>Promise<T>)=>{active();const value=await operation();active();return value;};
  active();need(pending<P.maxPendingRpc,'Previous wallet checks are still pending.');pending++;
  const task=(async()=>{
   need(await call(()=>connection.getGenesisHash())===trust.expectedGenesisHash,'Wallet network differs from this payment.');
   const floor=Math.max(p.minContextSlot,...review.current.observations.map(row=>row.closingSlot)),keys=[new PublicKey(o.keepMint),new PublicKey(built.buyerAta),new PublicKey(built.sellerAta),new PublicKey(o.buyer)];
   const snapshot=await call(()=>connection.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:floor}));
   need(safe(snapshot.context.slot)&&snapshot.context.slot>=floor&&snapshot.value.length===4);let slot=snapshot.context.slot;
   const rows=snapshot.value.map(row=>{if(row===null)return null;need(row.owner instanceof PublicKey&&row.executable===false&&safe(row.lamports)&&row.data instanceof Uint8Array&&row.data.length<=165);return {owner:new PublicKey(row.owner.toBytes()),data:Buffer.from(row.data),lamports:BigInt(row.lamports)};});
   const mint=rows[0];need(mint&&mint.owner.equals(KEEP_TOKEN_PROGRAM)&&mint.data.length===82&&mint.data[44]===TOKEN.decimals&&mint.data[45]===1&&[0,1].includes(mint.data.readUInt32LE(0))&&[0,1].includes(mint.data.readUInt32LE(46)),'KEEP mint is unavailable.');
   const token=(row:(typeof rows)[number],wallet:string)=>{need(row&&row.owner.equals(KEEP_TOKEN_PROGRAM)&&row.data.length===165&&new PublicKey(row.data.subarray(0,32)).equals(keys[0]!)&&new PublicKey(row.data.subarray(32,64)).toBase58()===wallet&&row.data[108]===1&&row.data.readUInt32LE(109)===0&&[0,1].includes(row.data.readUInt32LE(72))&&[0,1].includes(row.data.readUInt32LE(129)),'KEEP token account is unavailable or frozen.');return row.data.readBigUInt64LE(64);};
   need(token(rows[1]!,o.buyer)>=BigInt(o.totalBaseUnits),'Not enough KEEP for this purchase.');
   if(o.sellerAtaExists)token(rows[2]!,o.seller);
   else if(rows[2]?.owner.equals(KEEP_TOKEN_PROGRAM))token(rows[2],o.seller);
   else need(rows[2]===null||rows[2]!.owner.equals(SystemProgram.programId)&&rows[2]!.data.length===0,'Seller token account changed.');
   const payer=rows[3];need(payer&&payer.owner.equals(SystemProgram.programId)&&payer.data.length===0);
   const fullRent=await call(()=>connection.getMinimumBalanceForRentExemption(165,'finalized'));need(safe(fullRent)&&fullRent>0&&String(fullRent)===review.current.costs.fullAtaRentLamports,'Token-account rent changed; review again.');
   const rent=o.sellerAtaExists?0n:BigInt(fullRent);need(o.sellerAtaExists||rent<=BigInt(o.sellerAtaRentCapLamports!));
   const fee=await call(()=>connection.getFeeForMessage(p.transactionVersion==='legacy'?Message.from(built.message):MessageV0.deserialize(built.message),'finalized'));
   need(safe(fee.context.slot)&&fee.context.slot>=slot&&safe(fee.value)&&BigInt(fee.value)<=BigInt(p.limits.maxFeeLamports)&&String(fee.value)===review.current.costs.feeLamports&&rent.toString()===review.current.costs.rentLamports,'Network fee changed; review this purchase again.');slot=fee.context.slot;
   need(BigInt(review.current.costs.totalLamports)===BigInt(fee.value)+rent,'Displayed network cost differs from the checked fee and rent.');
   need(payer.lamports>=BigInt(fee.value)+rent,'Not enough SOL for the network fee and token-account rent.');
   const valid=await call(()=>connection.isBlockhashValid(p.blockhash,{commitment:'finalized',minContextSlot:slot}));need(safe(valid.context.slot)&&valid.context.slot>=slot&&valid.value===true,'Original payment expired or is unresolved.');slot=valid.context.slot;
   const height=await call(()=>connection.getBlockHeight({commitment:'finalized',minContextSlot:slot}));need(safe(height)&&height<=p.lastValidBlockHeight);
   if(v.wire){const status=await call(()=>connection.getSignatureStatuses([v.wire!.signature],{searchTransactionHistory:true}));need(safe(status.context.slot)&&status.context.slot>=slot&&status.value.length===1&&status.value[0]===null,'This payment may already be recorded; recover it first.');}
   need(await call(()=>connection.getGenesisHash())===trust.expectedGenesisHash);active();
  })();void task.then(()=>{pending--;},()=>{pending--;});
  try{await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Wallet checks timed out. Keep this original purchase saved.'));},P.rpcTimeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);}
 };
}
