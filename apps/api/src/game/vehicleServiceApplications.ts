/** D-153.142: finish a committed irreversible service intent exactly once.
 * Finality is verified outside gameplay locks. Original consent, including its
 * destination and actor, remains authoritative after pause or base transfer. */
import type {createVehicleServiceBurnFinalityReader} from '@shardkeep/chain/vehicle-service-burn-finality';
import {buildVehicleServiceBurnMessage} from '@shardkeep/chain/vehicle-service-burn-message';
import {verifyMiningClaimSignedWire} from '@shardkeep/chain/mining-claim-wire';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {VehicleServiceStateSchema,vehicleServiceTransition} from '@shardkeep/shared/phaseEVehicleService';
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {createVehicleServiceBurnPreparations,type VehicleServiceBurnPreparation} from './vehicleServiceBurnPreparations';
export type VehicleServiceApplicationProof=Awaited<ReturnType<ReturnType<typeof createVehicleServiceBurnFinalityReader>['verify']>>;
export interface VehicleServiceApplicationDependencies {verifyBurn?:(input:{reservationId:string;signedTransaction?:Uint8Array})=>Promise<VehicleServiceApplicationProof>}
const uuid=z.uuid(),address=PhaseEVehicleMintIdentitySchema.shape.assetId,integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),hash=z.string().regex(/^[0-9a-f]{64}$/);
const counter=z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).refine(v=>{try{return BigInt(v)<=(1n<<63n)-1n;}catch{return false;}});
const signature=z.string().min(64).max(88).refine(v=>{try{return bs58.decode(v).length===64&&bs58.encode(bs58.decode(v))===v;}catch{return false;}});
const ServiceEffect=VehicleServiceStateSchema.safeExtend({version:z.literal(1),tierAfter:PhaseEVehicleMintIdentitySchema.shape.tier,revisionAfter:integer,allowanceStartAfter:counter,remainingUses:integer,serviceAuthorized:z.literal(false)});
const Proof=z.object({version:z.literal(2),purpose:z.literal('vehicle_service'),reservationId:uuid,wallet:address,identity:PhaseEVehicleMintIdentitySchema,service:ServiceEffect,serviceSha256:hash,serviceAuthorized:z.literal(false),signature,slot:integer,blockTime:integer.nullable(),originalMessageSha256:hash,signedTransactionSha256:hash,
 feeLamports:z.string().max(20).regex(/^(0|[1-9][0-9]*)$/),assetRefundLamports:z.string().max(20).regex(/^(0|[1-9][0-9]*)$/),transactionEvidenceVerified:z.literal(true),finalityVerified:z.literal(true),preBurnOwnershipVerified:z.literal(true),registryMembershipVerified:z.literal(false),installationAuthorized:z.literal(false),preBurnOwner:address,finalizedThroughSlot:integer,anchorSlot:integer,
 history:z.array(z.object({signature,slot:integer,transactionIndex:integer,ownerAfter:address}).strict()).max(2000),source:z.object({genesisHash:address,reviewedDeploymentSlot:integer,reviewedProgramDataSha256:hash,upgradeAuthority:address.nullable(),addressIndexCompleteness:z.literal('configured-provider-trust'),savedAnchorAuthority:z.literal('private-application-reservation')}).strict()}).strict();
const Receipt=z.object({intentId:uuid,assetId:address,wallet:address,installationId:uuid,baseId:uuid,berthId:uuid,family:PhaseEVehicleMintIdentitySchema.shape.family,operation:z.enum(['upgrade','restore_uses']),state:VehicleServiceStateSchema,tierAfter:PhaseEVehicleMintIdentitySchema.shape.tier,revisionAfter:integer,completedTotal:counter,allowanceStartAfter:counter,appliedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),proof:Proof}).strict();
export type VehicleServiceApplicationReceipt=z.infer<typeof Receipt>;
const fail=(code:string):never=>{throw new HttpError(503,code,code);};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_service_consumptions'::regclass) allowed`);if(!r?.allowed)fail('VEHICLE_SERVICE_APPLICATION_OWNER');}
function bound(raw:unknown,p:VehicleServiceBurnPreparation,wire?:ReturnType<typeof verifyMiningClaimSignedWire>):z.infer<typeof Proof>{
 try{const proof=Proof.parse(raw),a=p.anchor,built=buildVehicleServiceBurnMessage(p.plan);
  if(proof.reservationId!==p.intentId||proof.wallet!==p.wallet||proof.preBurnOwner!==p.wallet||!equal(proof.identity,p.plan.identity)||!equal(proof.service,ServiceEffect.parse(built.service))||proof.serviceSha256!==built.serviceSha256||proof.originalMessageSha256!==p.messageSha256||proof.anchorSlot!==a.slot||proof.slot<=a.slot||proof.finalizedThroughSlot<proof.slot||proof.source.genesisHash!==a.genesisHash||proof.source.reviewedDeploymentSlot!==a.reviewedDeploymentSlot||proof.source.reviewedProgramDataSha256!==a.reviewedProgramDataSha256)fail('VEHICLE_SERVICE_APPLICATION_SOURCE');
  const message=Buffer.from(p.messageHex,'hex'),reconstructed=verifyMiningClaimSignedWire({wallet:new PublicKey(p.wallet),intentBytes:message,signedTransaction:Buffer.concat([Buffer.of(1),bs58.decode(proof.signature),message])});
  if(reconstructed.wireSha256!==proof.signedTransactionSha256||reconstructed.messageSha256!==proof.originalMessageSha256||wire&&(wire.signature!==proof.signature||wire.wireSha256!==proof.signedTransactionSha256||wire.messageSha256!==proof.originalMessageSha256))fail('VEHICLE_SERVICE_APPLICATION_SOURCE');
  let lastSlot=a.slot,lastIndex=-1;const seen=new Set<string>();for(const h of proof.history){if(h.slot<=a.slot||h.slot>proof.slot||h.slot<lastSlot||h.slot===lastSlot&&h.transactionIndex<=lastIndex||seen.has(h.signature))fail('VEHICLE_SERVICE_APPLICATION_SOURCE');seen.add(h.signature);lastSlot=h.slot;lastIndex=h.transactionIndex;}
  return proof;
 }catch{return fail('VEHICLE_SERVICE_APPLICATION_SOURCE');}
}
async function read(db:DbOrTx,p:VehicleServiceBurnPreparation,wire?:ReturnType<typeof verifyMiningClaimSignedWire>):Promise<VehicleServiceApplicationReceipt|null>{
 const [r]=await db.execute<{value:unknown;signature:string;signed_transaction_sha256:string;original_message_sha256:string;slot:string}>(sql`select c.signature,c.signed_transaction_sha256,c.original_message_sha256,c.slot::text,jsonb_build_object('intentId',c.intent_id,'assetId',c.asset_id,'wallet',c.wallet,'installationId',a.installation_id,'tierAfter',a.tier_after,'revisionAfter',a.revision_after,'completedTotal',a.completed_total::text,'allowanceStartAfter',a.allowance_start_after::text,'appliedAt',to_char(a.applied_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'proof',c.proof) value from public.vehicle_service_consumptions c full join public.vehicle_service_applications a using(intent_id) where coalesce(c.intent_id,a.intent_id)=${p.intentId}`);
 if(!r)return null;
 try{const state=p.plan.service,value=Receipt.parse({...r.value as Record<string,unknown>,baseId:state.baseId,berthId:state.berthId,family:state.family,operation:state.operation,state}),effect=vehicleServiceTransition(state);
  if(value.intentId!==p.intentId||value.assetId!==p.plan.identity.assetId||value.wallet!==p.wallet||value.installationId!==state.installationId||value.tierAfter!==effect.tierAfter||value.revisionAfter!==effect.revisionAfter||value.completedTotal!==state.completedTotal||value.allowanceStartAfter!==effect.allowanceStartAfter)fail('VEHICLE_SERVICE_APPLICATION_SOURCE');
  const proof=bound(value.proof,p,wire);if(r.signature!==proof.signature||r.signed_transaction_sha256!==proof.signedTransactionSha256||r.original_message_sha256!==proof.originalMessageSha256||r.slot!==String(proof.slot))fail('VEHICLE_SERVICE_APPLICATION_SOURCE');
  return {...value,proof};
 }catch{return fail('VEHICLE_SERVICE_APPLICATION_SOURCE');}
}
export function createVehicleServiceApplications(db:Db,dependencies:VehicleServiceApplicationDependencies={}){
 if('rollback'in db)fail('VEHICLE_SERVICE_APPLICATION_TOP_LEVEL');const preparations=createVehicleServiceBurnPreparations(db),verify=dependencies.verifyBurn;
 async function get(wallet:string,intentId:string):Promise<VehicleServiceApplicationReceipt|null>{await owner(db);const p=await preparations.get(wallet,intentId);return p?read(db,p):null;}
 async function recover(wallet:string,intentId:string,signedTransaction?:Uint8Array):Promise<VehicleServiceApplicationReceipt>{
  if(signedTransaction!==undefined&&(!(signedTransaction instanceof Uint8Array)||signedTransaction.length<=65||signedTransaction.length>1232))fail('VEHICLE_SERVICE_APPLICATION_WIRE');
  const copiedWire=signedTransaction===undefined?undefined:Uint8Array.from(signedTransaction);await owner(db);const p=await preparations.get(wallet,intentId);if(!p)return fail('VEHICLE_SERVICE_APPLICATION_PREPARATION');
  let wire:ReturnType<typeof verifyMiningClaimSignedWire>|undefined;if(copiedWire)try{wire=verifyMiningClaimSignedWire({wallet:new PublicKey(p.wallet),intentBytes:Buffer.from(p.messageHex,'hex'),signedTransaction:copiedWire});}catch{return fail('VEHICLE_SERVICE_APPLICATION_WIRE');}
  const old=await read(db,p,wire);if(old)return old;if(!verify)return fail('VEHICLE_SERVICE_APPLICATION_UNAVAILABLE');
  let raw:unknown;try{raw=await verify!({reservationId:p.intentId,...copiedWire?{signedTransaction:copiedWire}:{}});}catch{return fail('VEHICLE_SERVICE_APPLICATION_UNAVAILABLE');}
  // Parsing recursively owns the bounded proof before the first database await.
  const proof=bound(raw,p,wire);
  try{return await db.transaction(async tx=>{
   await tx.execute(sql`select reservation_id from public.advanced_vehicle_installations where reservation_id=${p.plan.service.installationId} for update`);
   await tx.execute(sql`select id from public.vehicle_service_intents where id=${p.intentId} for update`);
   await tx.execute(sql`select intent_id from public.vehicle_service_burn_preparations where intent_id=${p.intentId} for update`);
   const winner=await read(tx,p,wire);if(winner)return winner;
   await tx.execute(sql`insert into public.vehicle_service_consumptions(intent_id,proof) values(${p.intentId},${JSON.stringify(proof)}::jsonb)`);
   await tx.execute(sql`insert into public.vehicle_service_applications(intent_id) values(${p.intentId})`);
   return (await read(tx,p,wire))??fail('VEHICLE_SERVICE_APPLICATION_SOURCE');
  });}catch(error){let cause:unknown=error;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){if('code'in cause&&cause.code==='55P03')fail('VEHICLE_SERVICE_APPLICATION_BUSY');cause='cause'in cause?cause.cause:undefined;}throw error;}
 }
 return Object.freeze({get,recover});
}
