/** D153.190 historical stock recovery. Only a never-created payment or a
 * positively finalized, exact retained failed packet can release custody. */
import {createHash} from 'node:crypto';
import {Message,MessageV0} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {KeepEquipmentPaymentPreparationSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {createKeepEquipmentPaymentFailureReader,type KeepEquipmentPaymentFailureRpc,type KeepEquipmentPaymentFailureObservation} from '../../../../packages/chain/src/keepEquipmentPaymentFailure';
import type {KeepEquipmentPaymentPreparationTrust} from '@shardkeep/chain/keep-equipment-payment-preparation';
import {isFailedSolanaExecution} from '../../../../packages/chain/src/solanaFailedExecution';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {readOwnedKeepEquipmentFill,type KeepEquipmentFill} from './keepEquipmentMarket';
import {createKeepEquipmentPayments} from './keepEquipmentPayments';

const safe=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),hash=z.string().regex(/^[0-9a-f]{64}$/),key=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const amount=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>BigInt(v)<=(1n<<64n)-1n);
const Failure=z.object({version:z.literal(1),outcome:z.literal('failed'),reservationId:z.string().uuid(),buyer:key,seller:key,keepMint:key,totalBaseUnits:amount,
 signature:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),messageSha256:hash,wireSha256:hash,transactionVersion:z.union([z.literal('legacy'),z.literal(0)]),slot:safe.positive(),blockTime:safe,error:z.unknown(),feeLamports:amount,
 resolvedKeys:z.array(key).min(1).max(16),lamportsBefore:z.array(safe).min(1).max(16),lamportsAfter:z.array(safe).min(1).max(16),
 tokenBalances:z.array(z.object({accountIndex:safe,mint:key,owner:key,programId:key,decimals:safe.max(255),amount}).strict()).min(1).max(2).nullable(),evidenceSha256:hash,
 rentLamports:z.literal('0'),paidKeepBaseUnits:z.literal('0'),expectedGenesisHash:key,providerIds:z.tuple([z.string().min(1).max(128),z.string().min(1).max(128)]),minContextSlot:safe,
 observations:z.tuple([z.object({openingSlot:safe,closingSlot:safe}).strict(),z.object({openingSlot:safe,closingSlot:safe}).strict()]),finalizedAgreement:z.literal(true),
 paymentAuthorized:z.literal(false),signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),deliveryAuthorized:z.literal(false),fenceReleaseAuthorized:z.literal(false),unpaidProven:z.literal(false),
}).strict();
export interface KeepEquipmentRelease {fillId:string;reason:'never_prepared'|'finalized_failed';signature:string|null;proof:KeepEquipmentPaymentFailureObservation|null;releasedAt:string}
export interface KeepEquipmentReleaseDependencies {
 failureConnect?:readonly[(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc,(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc];
 trust?:KeepEquipmentPaymentPreparationTrust;
}
const held=(code:string):never=>{throw new HttpError(503,'Keep this purchase saved; release is held',code,{fenceReleaseAuthorized:false,unpaidProven:false,broadcastAuthorized:false});};
const missing=():never=>{throw new HttpError(404,'Equipment purchase not found','KEEP_EQUIPMENT_FILL_UNKNOWN');};
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.keep_equipment_fill_releases'::regclass) allowed`);if(!r?.allowed)held('KEEP_EQUIPMENT_RELEASE_OWNER');}
function boundFailure(raw:unknown,fill:KeepEquipmentFill,preparation:unknown,signature:string,wireSha256:string):KeepEquipmentPaymentFailureObservation{
 try{
  const r=Failure.parse(raw),p=KeepEquipmentPaymentPreparationSchema.extend({recordedAt:z.string().optional()}).parse(preparation),bytes=Buffer.from(p.messageHex,'hex'),message=p.transactionVersion==='legacy'?Message.from(bytes):MessageV0.deserialize(bytes);
  const evidence={slot:r.slot,blockTime:r.blockTime,error:r.error,feeLamports:r.feeLamports,resolvedKeys:r.resolvedKeys,lamportsBefore:r.lamportsBefore,lamportsAfter:r.lamportsAfter,tokenBalances:r.tokenBalances};
  if(r.reservationId!==fill.id||r.buyer!==fill.buyerWallet||r.seller!==fill.sellerWallet||r.totalBaseUnits!==fill.totalBaseUnits||r.keepMint!==p.expectedKeepMint
   ||r.signature!==signature||r.wireSha256!==wireSha256||r.messageSha256!==p.messageSha256||r.transactionVersion!==p.transactionVersion
   ||r.expectedGenesisHash!==p.expectedGenesisHash||JSON.stringify(r.providerIds)!==JSON.stringify(p.providerIds)||r.providerIds[0]===r.providerIds[1]
   ||r.minContextSlot<p.minContextSlot||r.slot<r.minContextSlot||r.observations.some(o=>o.openingSlot<r.minContextSlot||o.closingSlot<Math.max(o.openingSlot,r.slot))
   ||JSON.stringify(r.resolvedKeys)!==JSON.stringify(message.staticAccountKeys.map(k=>k.toBase58()))||r.lamportsBefore.length!==r.resolvedKeys.length||r.lamportsAfter.length!==r.resolvedKeys.length
   ||r.lamportsBefore.some((n,i)=>BigInt(n)-BigInt(r.lamportsAfter[i]!)!==(i===0?BigInt(r.feeLamports):0n))
   ||!isFailedSolanaExecution(r.error,message.compiledInstructions.length,r.resolvedKeys.length)||createHash('sha256').update(JSON.stringify(evidence)).digest('hex')!==r.evidenceSha256)held('KEEP_EQUIPMENT_RELEASE_PROOF');
  return r as KeepEquipmentPaymentFailureObservation;
 }catch{return held('KEEP_EQUIPMENT_RELEASE_PROOF');}
}
/** Independent row read so payment recovery can embed this terminal receipt
 * without recursively constructing another payment service. */
export async function readKeepEquipmentRelease(db:DbOrTx,wallet:string,id:string):Promise<KeepEquipmentRelease|null>{
 await owner(db);const fill=await readOwnedKeepEquipmentFill(db,wallet,id);if(!fill)missing();
 const [row]=await db.execute<{reason:KeepEquipmentRelease['reason'];signature:string|null;proof:unknown;released_at:Date}>(sql`select reason,signature,proof,released_at from keep_equipment_fill_releases where fill_id=${id}`);
 if(!row)return null;let proof:KeepEquipmentPaymentFailureObservation|null=null;
 if(row.reason==='finalized_failed'){
  const [p]=await db.execute<{preparation:unknown;signature:string;wire_sha256:string}>(sql`select p.preparation,w.signature,w.wire_sha256 from keep_equipment_payment_preparations p join keep_equipment_payment_wires w on w.fill_id=p.fill_id where p.fill_id=${id}`);
  if(!p||p.signature!==row.signature)held('KEEP_EQUIPMENT_RELEASE_PROOF');proof=boundFailure(row.proof,fill!,p!.preparation,p!.signature,p!.wire_sha256);
 }else if(row.reason!=='never_prepared'||row.signature!==null||row.proof!==null)held('KEEP_EQUIPMENT_RELEASE_PROOF');
 return {fillId:id,reason:row.reason,signature:row.signature,proof,releasedAt:new Date(row.released_at).toISOString()};
}
async function lockOriginal(tx:DbOrTx,fill:KeepEquipmentFill){
 const wallets=[fill.buyerWallet,fill.sellerWallet].sort(),bases=[fill.buyerBaseId,fill.sellerBaseId].sort();
 await tx.execute(sql`select wallet from players where wallet in (${wallets[0]},${wallets[1]}) order by wallet for update`);
 await tx.execute(sql`select id from bases where id in (${bases[0]}::uuid,${bases[1]}::uuid) order by id for update`);
 await tx.execute(sql`select base_id from base_slots where base_id in (${bases[0]}::uuid,${bases[1]}::uuid) order by base_id,wallet for update`);
 await tx.execute(sql`select id from keep_equipment_listings where id=${fill.listingId} for update`);
 await tx.execute(sql`select id from keep_equipment_fills where id=${fill.id} for update`);
}
export function createKeepEquipmentReleases(db:Db,deps:KeepEquipmentReleaseDependencies={}){
 if('rollback'in db)held('KEEP_EQUIPMENT_RELEASE_TOP_LEVEL');
 const trust=deps.trust?Object.freeze({...deps.trust,providerIds:Object.freeze([...deps.trust.providerIds]) as readonly[string,string]}):null;
 const verifier=trust&&deps.failureConnect?createKeepEquipmentPaymentFailureReader(deps.failureConnect,trust):null;
 const payments=createKeepEquipmentPayments(db);
 async function release(wallet:string,id:string){
  const old=await readKeepEquipmentRelease(db,wallet,id);if(old)return old;
  const state=await payments.read(wallet,id),p=state.preparation,w=state.wire;
  if(state.delivery)held('KEEP_EQUIPMENT_RELEASE_DELIVERED');
  let proof:KeepEquipmentPaymentFailureObservation|null=null;
  if(p){
   if(!w)held('KEEP_EQUIPMENT_RELEASE_PREPARED');if(!trust||!verifier)held('KEEP_EQUIPMENT_RELEASE_UNAVAILABLE');
   if(trust!.expectedGenesisHash!==p.expectedGenesisHash||trust!.expectedKeepMint!==p.expectedKeepMint||JSON.stringify(trust!.providerIds)!==JSON.stringify(p.providerIds)||trust!.transactionVersion!==p.transactionVersion
    ||trust!.maxFeeLamports.toString()!==p.limits.maxFeeLamports||trust!.maxPriorityFeeLamports.toString()!==p.limits.maxPriorityFeeLamports||trust!.maxComputeUnitLimit!==p.limits.maxComputeUnitLimit)held('KEEP_EQUIPMENT_RELEASE_CONFIGURATION');
   const {sellerAtaRentCapLamports,...original}=p.original;
   let raw:unknown;try{raw=await verifier!({original:{...original,totalBaseUnits:BigInt(original.totalBaseUnits),...(sellerAtaRentCapLamports===undefined?{}:{sellerAtaRentCapLamports:BigInt(sellerAtaRentCapLamports)})},messageBytes:Buffer.from(p.messageHex,'hex'),messageSha256:p.messageSha256,blockhash:p.blockhash,lastValidBlockHeight:p.lastValidBlockHeight,minContextSlot:p.minContextSlot,signedTransaction:Buffer.from(w!.signedTransactionHex,'hex'),signature:w!.signature,wireSha256:w!.wireSha256});}
   catch{return held('KEEP_EQUIPMENT_RELEASE_UNAVAILABLE');}
   proof=boundFailure(raw,state.fill,p,w!.signature,w!.wireSha256);
  }
  await db.transaction(async tx=>{
   await lockOriginal(tx,state.fill);if(await readKeepEquipmentRelease(tx,wallet,id))return;
   // SQL rechecks non-preparation / same retained wire / non-delivery while
   // holding these locks. Failed late races never return a fabricated receipt.
   await tx.execute(sql`insert into keep_equipment_fill_releases(fill_id,reason,signature,proof) values(${id},${proof?'finalized_failed':'never_prepared'},${proof?.signature??null},${proof?JSON.stringify(proof):null}::jsonb)`);
  });return (await readKeepEquipmentRelease(db,wallet,id))!;
 }
 return Object.freeze({read:(wallet:string,id:string)=>readKeepEquipmentRelease(db,wallet,id),release});
}
