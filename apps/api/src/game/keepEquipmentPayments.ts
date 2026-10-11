/** D153.190 private payment composition. One frozen packet per fill; retention
 * commits before any separate client relay. Historical recovery stays available
 * during pauses and after base transfer. No signer, broadcaster or release path. */
import {createHash} from 'node:crypto';
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT} from '@shardkeep/shared';
import {buildKeepEquipmentPaymentMessage,createKeepEquipmentPaymentReader,type KeepEquipmentPaymentRpc} from '@shardkeep/chain/keep-equipment-payment';
import {createKeepEquipmentPaymentPreparationReader,type KeepEquipmentPaymentPreparationRpc,type KeepEquipmentPaymentPreparationTrust} from '@shardkeep/chain/keep-equipment-payment-preparation';
import {verifyKeepEquipmentPaymentSignedWire} from '@shardkeep/chain/keep-equipment-payment-wire';
import {createKeepEquipmentPaymentCurrentReader} from '@shardkeep/chain/keep-equipment-payment-current';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {readKeepEquipmentRelease} from './keepEquipmentReleases';
import {readOwnedKeepEquipmentFill,type KeepEquipmentFill} from './keepEquipmentMarket';

import {KeepEquipmentPaymentPreparationSchema as Preparation,KeepEquipmentPaymentProofSchema as Proof,KeepEquipmentReviewSchema,KeepEquipmentSendSchema,type KeepEquipmentSavedPreparation} from '@shardkeep/shared/keepEquipmentMarketApi';
export type {KeepEquipmentSavedPreparation} from '@shardkeep/shared/keepEquipmentMarketApi';
export interface KeepEquipmentSavedWire {signature:string;wireSha256:string;messageSha256:string;signedTransactionHex:string;recordedAt:string}
export interface KeepEquipmentDelivery {fillId:string;buyerBaseId:string;itemId:KeepEquipmentFill['itemId'];quantity:string;proof:z.infer<typeof Proof>;deliveredAt:string}
export interface KeepEquipmentPaymentDependencies {
 assertAdmission?:()=>void;
 preparationConnect?:readonly[(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc,(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc];
 finalityConnect?:readonly[(signal:AbortSignal)=>KeepEquipmentPaymentRpc,(signal:AbortSignal)=>KeepEquipmentPaymentRpc];
 trust?:KeepEquipmentPaymentPreparationTrust;
 broadcastConnect?:(signal:AbortSignal)=>{
  getGenesisHash():Promise<string>;getSlot(commitment:'finalized'):Promise<number>;
  sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
 };
}
const held=(code:string):never=>{throw new HttpError(503,'Keep this purchase saved; payment recovery is held',code,{status:'held',fenceReleaseAuthorized:false,unpaidProven:false,broadcastAuthorized:false});};
const released=():never=>{throw new HttpError(409,'This purchase has been released','KEEP_EQUIPMENT_FILL_RELEASED');};
const missing=():never=>{throw new HttpError(404,'Equipment purchase not found','KEEP_EQUIPMENT_FILL_UNKNOWN');};
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown)=>JSON.stringify(value,(_,v:unknown)=>typeof v==='bigint'?v.toString():v);
function terms(p:z.infer<typeof Preparation>){const {sellerAtaRentCapLamports,...original}=p.original;return {original:{...original,totalBaseUnits:BigInt(original.totalBaseUnits),...(sellerAtaRentCapLamports===undefined?{}:{sellerAtaRentCapLamports:BigInt(sellerAtaRentCapLamports)})},limits:{...p.limits,maxFeeLamports:BigInt(p.limits.maxFeeLamports),maxPriorityFeeLamports:BigInt(p.limits.maxPriorityFeeLamports)}};}
function boundPreparation(raw:unknown,fill:KeepEquipmentFill):z.infer<typeof Preparation>{
 try{
  const p=Preparation.parse(raw),{original,limits}=terms(p),built=buildKeepEquipmentPaymentMessage(original,limits,p.blockhash,p.transactionVersion);
  if(original.reservationId!==fill.id||original.buyer!==fill.buyerWallet||original.seller!==fill.sellerWallet||original.totalBaseUnits.toString()!==fill.totalBaseUnits||original.keepMint!==p.expectedKeepMint
   ||built.messageSha256!==p.messageSha256||Buffer.from(built.messageBytes).toString('hex')!==p.messageHex||p.minContextSlot!==p.blockhashSlot
   ||p.observations.some(o=>o.accountSlot<o.openingSlot||p.blockhashSlot<o.accountSlot||o.feeSlot<p.blockhashSlot||o.validitySlot<o.feeSlot||o.closingSlot<o.validitySlot||o.currentBlockHeight>p.lastValidBlockHeight||o.feeLamports!==p.costs.feeLamports)
   ||BigInt(p.costs.feeLamports)>limits.maxFeeLamports||BigInt(p.costs.totalLamports)!==BigInt(p.costs.feeLamports)+BigInt(p.costs.rentLamports)
   ||BigInt(p.balances.buyerKeepBaseUnits)<original.totalBaseUnits||BigInt(p.balances.buyerSolLamports)<BigInt(p.costs.totalLamports)
   ||(original.sellerAtaExists?p.costs.rentLamports!=='0'||p.balances.sellerAccountState!=='existing':p.costs.rentLamports!==p.original.sellerAtaRentCapLamports||p.costs.fullAtaRentLamports!==p.costs.rentLamports||p.balances.sellerAccountState==='existing'))held('KEEP_EQUIPMENT_PREPARATION_SOURCE');
  return p;
 }catch{return held('KEEP_EQUIPMENT_PREPARATION_SOURCE');}
}
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.keep_equipment_payment_preparations'::regclass) allowed`);if(!r?.allowed)held('KEEP_EQUIPMENT_PAYMENT_OWNER');}
async function readPreparation(db:DbOrTx,fill:KeepEquipmentFill):Promise<KeepEquipmentSavedPreparation|null>{
 const [row]=await db.execute<{preparation:unknown;message_hex:string;message_sha256:string;recorded_at:Date}>(sql`select preparation,encode(message_bytes,'hex') message_hex,message_sha256,recorded_at from keep_equipment_payment_preparations where fill_id=${fill.id}`);
 if(!row)return null;const p=boundPreparation(row.preparation,fill);
 if(p.messageHex!==row.message_hex||p.messageSha256!==row.message_sha256)held('KEEP_EQUIPMENT_PREPARATION_SOURCE');
 return {...p,recordedAt:new Date(row.recorded_at).toISOString()};
}
function signed(p:KeepEquipmentSavedPreparation,bytes:Uint8Array){try{return verifyKeepEquipmentPaymentSignedWire({preparedMessageBytes:Buffer.from(p.messageHex,'hex'),signedTransaction:bytes,buyer:new PublicKey(p.original.buyer)});}catch{return held('KEEP_EQUIPMENT_PAYMENT_WIRE');}}
async function readWire(db:DbOrTx,p:KeepEquipmentSavedPreparation):Promise<KeepEquipmentSavedWire|null>{
 const [row]=await db.execute<{wire_hex:string;signature:string;wire_sha256:string;recorded_at:Date}>(sql`select encode(signed_transaction,'hex') wire_hex,signature,wire_sha256,recorded_at from keep_equipment_payment_wires where fill_id=${p.original.reservationId}`);
 if(!row)return null;const proof=signed(p,Buffer.from(row.wire_hex,'hex'));
 if(proof.signature!==row.signature||proof.wireSha256!==row.wire_sha256||proof.messageSha256!==p.messageSha256)held('KEEP_EQUIPMENT_PAYMENT_SOURCE');
 return {signature:proof.signature,wireSha256:proof.wireSha256,messageSha256:proof.messageSha256,signedTransactionHex:row.wire_hex,recordedAt:new Date(row.recorded_at).toISOString()};
}
function boundProof(raw:unknown,p:KeepEquipmentSavedPreparation,w:KeepEquipmentSavedWire){
 try{
  const v=Proof.parse(raw),{original,limits}=terms(p),b=buildKeepEquipmentPaymentMessage(original,limits,p.blockhash,p.transactionVersion);
  const {evidenceSha256,fenceReleaseAuthorized:_f,unpaidProven:_u,expectedGenesisHash,providerIds,finalizedAgreement:_a,...evidence}=v;
  if(v.reservationId!==original.reservationId||v.signature!==w.signature||v.messageSha256!==p.messageSha256||v.buyer!==original.buyer||v.seller!==original.seller||v.keepMint!==original.keepMint
   ||v.buyerAta!==b.buyerAta||v.sellerAta!==b.sellerAta||v.totalBaseUnits!==b.totalBaseUnits||v.sellerBaseUnits!==b.sellerBaseUnits||v.burnBaseUnits!==b.burnBaseUnits
   ||v.createsSellerAta!==b.createsSellerAta||v.sellerAtaRentCapLamports!==b.sellerAtaRentCapLamports||BigInt(v.sellerAtaRentLamports)>BigInt(b.sellerAtaRentCapLamports)||BigInt(v.feeLamports)>limits.maxFeeLamports
   ||v.slot<p.minContextSlot||expectedGenesisHash!==p.expectedGenesisHash||JSON.stringify(providerIds)!==JSON.stringify(p.providerIds)||digest(Buffer.from(JSON.stringify(evidence)))!==evidenceSha256)held('KEEP_EQUIPMENT_PAYMENT_PROOF');
  return v;
 }catch{return held('KEEP_EQUIPMENT_PAYMENT_PROOF');}
}
async function readDelivery(db:DbOrTx,fill:KeepEquipmentFill,p:KeepEquipmentSavedPreparation,w:KeepEquipmentSavedWire):Promise<KeepEquipmentDelivery|null>{
 const [row]=await db.execute<{proof:unknown;delivered_at:Date}>(sql`select proof,delivered_at from keep_equipment_deliveries where fill_id=${fill.id}`);
 return row?{fillId:fill.id,buyerBaseId:fill.buyerBaseId,itemId:fill.itemId,quantity:fill.quantity,proof:boundProof(row.proof,p,w),deliveredAt:new Date(row.delivered_at).toISOString()}:null;
}
export function createKeepEquipmentPayments(db:Db,deps:KeepEquipmentPaymentDependencies={}){
 if('rollback'in db)held('KEEP_EQUIPMENT_PAYMENT_TOP_LEVEL');
 // Freeze operator pins/connectors once. Requests cannot supply trusted proof,
 // override recipients, choose a mint/provider or bypass signed-wire retention.
 const trust=deps.trust?Object.freeze({...deps.trust,providerIds:Object.freeze([...deps.trust.providerIds]) as readonly[string,string]}):null;
 const preparer=trust&&deps.preparationConnect?createKeepEquipmentPaymentPreparationReader(deps.preparationConnect,trust):null;
 const verifier=trust&&deps.finalityConnect?createKeepEquipmentPaymentReader(deps.finalityConnect,trust):null;
 const current=trust&&deps.preparationConnect?createKeepEquipmentPaymentCurrentReader(deps.preparationConnect,trust):null;
 const broadcastConnect=deps.broadcastConnect;let pendingBroadcasts=0;
 const assertAdmission=deps.assertAdmission;
 const admission=()=>{if(!assertAdmission)held('KEEP_EQUIPMENT_MARKET_DISABLED');assertAdmission!();};
 function configured(p:KeepEquipmentSavedPreparation){
  if(!trust||trust.expectedGenesisHash!==p.expectedGenesisHash||trust.expectedKeepMint!==p.expectedKeepMint||JSON.stringify(trust.providerIds)!==JSON.stringify(p.providerIds)||trust.transactionVersion!==p.transactionVersion
   ||trust.maxFeeLamports.toString()!==p.limits.maxFeeLamports||trust.maxPriorityFeeLamports.toString()!==p.limits.maxPriorityFeeLamports||trust.maxComputeUnitLimit!==p.limits.maxComputeUnitLimit)held('KEEP_EQUIPMENT_PAYMENT_CONFIGURATION');
 }
 async function original(wallet:string,id:string){await owner(db);return await readOwnedKeepEquipmentFill(db,wallet,id)??missing();}
 async function read(wallet:string,id:string){
  const fill=await original(wallet,id),preparation=await readPreparation(db,fill),wire=preparation?await readWire(db,preparation):null,delivery=preparation&&wire?await readDelivery(db,fill,preparation,wire):null;
  const release=await readKeepEquipmentRelease(db,wallet,id);
  if(release&&delivery)held('KEEP_EQUIPMENT_PAYMENT_SOURCE');
  return {fill,preparation,wire,delivery,...(release?{release}:{}),status:release?'released' as const:delivery?'delivered' as const:wire?'signed' as const:preparation?'prepared' as const:'reserved' as const,signingAuthorized:false as const,broadcastAuthorized:false as const,fenceReleaseAuthorized:false as const,unpaidProven:false as const};
 }
 async function prepare(wallet:string,id:string){
  const state=await read(wallet,id);if(state.release)released();const fill=state.fill;if(state.preparation)return state;
  admission();if(!preparer||!trust)held('KEEP_EQUIPMENT_PREPARATION_UNAVAILABLE');
  let raw:Awaited<ReturnType<NonNullable<typeof preparer>>>;
  try{raw=await preparer!({reservationId:fill.id,buyer:fill.buyerWallet,seller:fill.sellerWallet,keepMint:trust!.expectedKeepMint,totalBaseUnits:BigInt(fill.totalBaseUnits)});}catch{return held('KEEP_EQUIPMENT_PREPARATION_UNAVAILABLE');}
  const {messageBytes,...metadata}=raw;
  const value=boundPreparation(JSON.parse(json({...metadata,messageHex:Buffer.from(messageBytes).toString('hex')})),fill);
  await db.transaction(async tx=>{
   await tx.execute(sql`select id from keep_equipment_fills where id=${fill.id} for update`);
   if(await readPreparation(tx,fill))return;admission();
   await tx.execute(sql`insert into keep_equipment_payment_preparations(fill_id,preparation,message_bytes) values(${fill.id},${JSON.stringify(value)}::jsonb,${Buffer.from(value.messageHex,'hex')})`);
   admission();
  });return read(wallet,id);
 }
 async function retainSigned(wallet:string,id:string,input:Uint8Array){
  if(!(input instanceof Uint8Array)||input.length<=65||input.length>1232)held('KEEP_EQUIPMENT_PAYMENT_WIRE');
  const bytes=Uint8Array.from(input),hex=Buffer.from(bytes).toString('hex'),state=await read(wallet,id);if(state.release)released();const fill=state.fill,p=state.preparation;
  if(!p)held('KEEP_EQUIPMENT_PREPARATION_REQUIRED');signed(p!,bytes);
  await db.transaction(async tx=>{
   await tx.execute(sql`select id from keep_equipment_fills where id=${fill.id} for update`);
   const old=await readWire(tx,p!);if(old){if(old.signedTransactionHex!==hex)held('KEEP_EQUIPMENT_PAYMENT_CONFLICT');return;}
   await tx.execute(sql`insert into keep_equipment_payment_wires(fill_id,signed_transaction) values(${fill.id},${Buffer.from(bytes)})`);
  });return read(wallet,id);
 }
 async function recover(wallet:string,id:string){
  const state=await read(wallet,id);if(state.delivery||state.release)return state;
  const p=state.preparation,w=state.wire;if(!p||!w)held('KEEP_EQUIPMENT_PAYMENT_NOT_RETAINED');
  if(!verifier||!trust)held('KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE');
  configured(p!);
  let raw:unknown;try{raw=await verifier!(terms(p!).original,w!.signature);}catch{return held('KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE');}
  const proof=boundProof(raw,p!,w!),fill=state.fill;
  await db.transaction(async tx=>{
   // Match the SQL effect and stable-base writers' root lock order. Never
   // replace these frozen participants with current owners after a transfer.
   const wallets=[fill.buyerWallet,fill.sellerWallet].sort(),bases=[fill.buyerBaseId,fill.sellerBaseId].sort();
   await tx.execute(sql`select wallet from players where wallet in (${wallets[0]},${wallets[1]}) order by wallet for update`);
   await tx.execute(sql`select id from bases where id in (${bases[0]}::uuid,${bases[1]}::uuid) order by id for update`);
   await tx.execute(sql`select base_id from base_slots where base_id in (${bases[0]}::uuid,${bases[1]}::uuid) order by base_id,wallet for update`);
   await tx.execute(sql`select id from keep_equipment_listings where id=${fill.listingId} for update`);
   await tx.execute(sql`select id from keep_equipment_fills where id=${fill.id} for update`);
   if(await readKeepEquipmentRelease(tx,wallet,id)||await readDelivery(tx,fill,p!,w!))return;
   await tx.execute(sql`insert into keep_equipment_deliveries(fill_id,proof) values(${fill.id},${JSON.stringify(proof)}::jsonb)`);
  });return read(wallet,id);
 }
 async function review(wallet:string,id:string){
  const started=Date.now(),expires=started+PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs;
  const purchase=await read(wallet,id);if(purchase.release)released();const p=purchase.preparation;if(!p)held('KEEP_EQUIPMENT_PREPARATION_REQUIRED');
  admission();configured(p!);if(!current)held('KEEP_EQUIPMENT_CURRENT_UNAVAILABLE');
  let result:Awaited<ReturnType<NonNullable<typeof current>>>;
  try{result=await current!({original:terms(p!).original,messageBytes:Buffer.from(p!.messageHex,'hex'),messageSha256:p!.messageSha256,blockhash:p!.blockhash,lastValidBlockHeight:p!.lastValidBlockHeight,minContextSlot:p!.minContextSlot});}
  catch{return held('KEEP_EQUIPMENT_CURRENT_UNAVAILABLE');}
  admission();if(await readKeepEquipmentRelease(db,wallet,id))released();if(Date.now()<started||Date.now()>=expires)held('KEEP_EQUIPMENT_CURRENT_EXPIRED');const {messageBytes,...metadata}=result;
  return KeepEquipmentReviewSchema.parse({purchase,current:JSON.parse(json({...metadata,messageHex:Buffer.from(messageBytes).toString('hex')})),reviewedAt:new Date(started).toISOString(),expiresAt:new Date(expires).toISOString()});
 }
 async function deliver(wallet:string,id:string){
  let purchase=await read(wallet,id);
  const response=(status:'delivered'|'submitted'|'held',reason:string|null=null)=>KeepEquipmentSendSchema.parse({purchase,status,reason,broadcastAuthorized:false,fenceReleaseAuthorized:false});
  if(purchase.release)return response('held','FILL_RELEASED');
  if(purchase.delivery)return response('delivered');
  if(!purchase.wire)return response('held','NOT_SIGNED');
  // A previous send may have succeeded despite a lost response. First finish
  // that irreversible original even when admission/broadcast is now paused.
  try{purchase=await recover(wallet,id);if(purchase.release)return response('held','FILL_RELEASED');if(purchase.delivery)return response('delivered');}catch(error){if(!(error instanceof HttpError))throw error;}
  if(!broadcastConnect||!trust)return response('held','PROVIDER_UNAVAILABLE');
  let fresh:Awaited<ReturnType<typeof review>>;try{fresh=await review(wallet,id);}catch{purchase=await read(wallet,id);return response('held',purchase.release?'FILL_RELEASED':'CURRENT_REVIEW_HELD');}
  purchase=await read(wallet,id);if(purchase.release)return response('held','FILL_RELEASED');const wire=purchase.wire;if(!wire)return response('held','NOT_SIGNED');
  if(pendingBroadcasts>=4)return response('held','BUSY');pendingBroadcasts++;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>{if(controller.signal.aborted)held('KEEP_EQUIPMENT_SEND_TIMEOUT');};
  const minContextSlot=Math.max(...fresh.current.observations.map(o=>o.closingSlot));
  const operation=(async()=>{
   active();const raw=broadcastConnect(controller.signal),genesis=raw.getGenesisHash.bind(raw),slot=raw.getSlot.bind(raw),send=raw.sendRawTransaction.bind(raw);
   if(await genesis()!==trust.expectedGenesisHash)held('KEEP_EQUIPMENT_SEND_CLUSTER');active();
   const observed=await slot('finalized');active();if(!Number.isSafeInteger(observed)||observed<minContextSlot)held('KEEP_EQUIPMENT_SEND_CONTEXT');
   admission();active();
   // A release racing an RPC review must stop relay. The only releasable signed
   // packet is already finalized failed, so even a last-instant race cannot
   // turn these exact immutable bytes into a second or successful payment.
   if(await readKeepEquipmentRelease(db,wallet,id))released();active();
   if(Date.now()<Date.parse(fresh.reviewedAt)||Date.now()>=Date.parse(fresh.expiresAt))held('KEEP_EQUIPMENT_CURRENT_EXPIRED');
   const result=await send(Buffer.from(wire.signedTransactionHex,'hex'),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot});active();
   if(result!==wire.signature)held('KEEP_EQUIPMENT_SEND_SIGNATURE');return result;
  })();
  // A late/unknown response never releases the reservation or permits a new
  // packet. Retain the slot until the adapter actually drains after abort.
  void operation.then(()=>{pendingBroadcasts--;},()=>{pendingBroadcasts--;});
  try{await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('send timeout'));},trust.deadlineMs);})]);return response('submitted');}
  catch{purchase=await read(wallet,id);return response('held',purchase.release?'FILL_RELEASED':'SEND_UNCERTAIN');}finally{if(timer)clearTimeout(timer);controller.abort();}
 }
 return Object.freeze({read,prepare,retainSigned,recover,review,deliver});
}
export type KeepEquipmentPayments=ReturnType<typeof createKeepEquipmentPayments>;
