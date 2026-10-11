/** D-153.127: finish a prior committed irreversible intent, including while
 * admission is paused. No current-owner substitution, HTTP, relay or release.
 * Mint admission is still the private registry's owner attestation. */
import type {createVehicleBurnFinalityReader} from '@shardkeep/chain/vehicle-burn-finality';
import {verifyMiningClaimSignedWire} from '@shardkeep/chain/mining-claim-wire';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {createVehicleBurnPreparations,type VehicleBurnPreparation} from './vehicleBurnPreparations';
export type VehicleInstallationProof=Awaited<ReturnType<ReturnType<typeof createVehicleBurnFinalityReader>['verify']>>;
export interface VehicleInstallationDependencies {verifyBurn?:(input:{reservationId:string;signedTransaction?:Uint8Array})=>Promise<VehicleInstallationProof>}
const uuid=z.uuid(),address=PhaseEVehicleMintIdentitySchema.shape.assetId,integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),hash=z.string().regex(/^[0-9a-f]{64}$/);
const signature=z.string().min(64).max(88).refine(v=>{try{return bs58.decode(v).length===64&&bs58.encode(bs58.decode(v))===v;}catch{return false;}});
const Proof=z.object({version:z.literal(1),reservationId:uuid,wallet:address,identity:PhaseEVehicleMintIdentitySchema,signature,slot:integer,blockTime:integer.nullable(),originalMessageSha256:hash,signedTransactionSha256:hash,
 feeLamports:z.string().max(20).regex(/^(0|[1-9][0-9]*)$/),assetRefundLamports:z.string().max(20).regex(/^(0|[1-9][0-9]*)$/),transactionEvidenceVerified:z.literal(true),finalityVerified:z.literal(true),preBurnOwnershipVerified:z.literal(true),registryMembershipVerified:z.literal(false),installationAuthorized:z.literal(false),preBurnOwner:address,finalizedThroughSlot:integer,anchorSlot:integer,
 history:z.array(z.object({signature,slot:integer,transactionIndex:integer,ownerAfter:address}).strict()).max(2000),source:z.object({genesisHash:address,reviewedDeploymentSlot:integer,reviewedProgramDataSha256:hash,upgradeAuthority:address.nullable(),addressIndexCompleteness:z.literal('configured-provider-trust'),savedAnchorAuthority:z.literal('private-application-reservation')}).strict()}).strict();
const Receipt=z.object({reservationId:uuid,assetId:address,baseId:uuid,berthId:uuid,family:PhaseEVehicleMintIdentitySchema.shape.family,tier:PhaseEVehicleMintIdentitySchema.shape.tier,installedWallet:address,completedBuildJobId:uuid,berthCompletedAt:z.string(),installedAt:z.string(),proof:Proof}).strict();
export type VehicleInstallationReceipt=z.infer<typeof Receipt>;
const fail=(code:string):never=>{throw new HttpError(503,code,code);};
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_burn_consumptions'::regclass) allowed`);if(!r?.allowed)fail('VEHICLE_INSTALLATION_OWNER');}
function bound(raw:unknown,p:VehicleBurnPreparation,wire?:ReturnType<typeof verifyMiningClaimSignedWire>):z.infer<typeof Proof>{
 try{const proof=Proof.parse(raw),a=p.anchor;
  if(proof.reservationId!==p.reservationId||proof.wallet!==p.wallet||proof.preBurnOwner!==p.wallet||JSON.stringify(proof.identity)!==JSON.stringify(p.plan.identity)||proof.originalMessageSha256!==p.messageSha256||proof.anchorSlot!==a.slot||proof.slot<=a.slot||proof.finalizedThroughSlot<proof.slot||proof.source.genesisHash!==a.genesisHash||proof.source.reviewedDeploymentSlot!==a.reviewedDeploymentSlot||proof.source.reviewedProgramDataSha256!==a.reviewedProgramDataSha256)fail('VEHICLE_INSTALLATION_SOURCE');
  // Lost local wire is reconstructible: verify its signature and digest from
  // the retained canonical message rather than trusting reported hash metadata.
  const message=Buffer.from(p.messageHex,'hex'),reconstructed=verifyMiningClaimSignedWire({wallet:new PublicKey(p.wallet),intentBytes:message,signedTransaction:Buffer.concat([Buffer.of(1),bs58.decode(proof.signature),message])});
  if(reconstructed.wireSha256!==proof.signedTransactionSha256||reconstructed.messageSha256!==proof.originalMessageSha256)fail('VEHICLE_INSTALLATION_SOURCE');
  if(wire&&(wire.signature!==proof.signature||wire.wireSha256!==proof.signedTransactionSha256||wire.messageSha256!==proof.originalMessageSha256))fail('VEHICLE_INSTALLATION_SOURCE');
  let lastSlot=a.slot,lastIndex=-1;const seen=new Set<string>();for(const h of proof.history){if(h.slot<=a.slot||h.slot>proof.slot||h.slot<lastSlot||h.slot===lastSlot&&h.transactionIndex<=lastIndex||seen.has(h.signature))fail('VEHICLE_INSTALLATION_SOURCE');seen.add(h.signature);lastSlot=h.slot;lastIndex=h.transactionIndex;}
  return proof;
 }catch{return fail('VEHICLE_INSTALLATION_SOURCE');}
}
async function read(db:DbOrTx,p:VehicleBurnPreparation,wire?:ReturnType<typeof verifyMiningClaimSignedWire>):Promise<VehicleInstallationReceipt|null>{
 const [row]=await db.execute<{value:unknown}>(sql`select jsonb_build_object('reservationId',c.reservation_id,'assetId',i.asset_id,'baseId',i.base_id,'berthId',i.berth_id,'family',i.family,'tier',i.tier,'installedWallet',i.installed_wallet,'completedBuildJobId',i.completed_build_job_id,'berthCompletedAt',to_char(i.berth_completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'installedAt',to_char(i.installed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'proof',c.proof) value from public.vehicle_burn_consumptions c left join public.advanced_vehicle_installations i using(reservation_id) where c.reservation_id=${p.reservationId}`);
 if(!row)return null;try{const value=Receipt.parse(row.value);if(value.assetId!==p.plan.identity.assetId||value.family!==p.plan.identity.family||value.tier!==p.plan.identity.tier||value.installedWallet!==p.wallet)fail('VEHICLE_INSTALLATION_SOURCE');return {...value,proof:bound(value.proof,p,wire)};}catch{return fail('VEHICLE_INSTALLATION_SOURCE');}
}
export function createVehicleInstallations(db:Db,dependencies:VehicleInstallationDependencies={}){
 if('rollback'in db)fail('VEHICLE_INSTALLATION_TOP_LEVEL');const preparations=createVehicleBurnPreparations(db),verify=dependencies.verifyBurn;
 async function get(wallet:string,reservationId:string):Promise<VehicleInstallationReceipt|null>{
  await owner(db);const p=await preparations.get(wallet,reservationId);return p?read(db,p):null;
 }
 async function recover(wallet:string,reservationId:string,signedTransaction?:Uint8Array):Promise<VehicleInstallationReceipt>{
  if(signedTransaction!==undefined&&(!(signedTransaction instanceof Uint8Array)||signedTransaction.length<=65||signedTransaction.length>1232))fail('VEHICLE_INSTALLATION_WIRE');
  const copiedWire=signedTransaction===undefined?undefined:Uint8Array.from(signedTransaction);await owner(db);
  const p=await preparations.get(wallet,reservationId);if(!p)return fail('VEHICLE_INSTALLATION_PREPARATION');let wire:ReturnType<typeof verifyMiningClaimSignedWire>|undefined;
  if(copiedWire)try{wire=verifyMiningClaimSignedWire({wallet:new PublicKey(p.wallet),intentBytes:Buffer.from(p.messageHex,'hex'),signedTransaction:copiedWire});}catch{return fail('VEHICLE_INSTALLATION_WIRE');}
  const saved=await read(db,p,wire);if(saved)return saved;if(!verify)return fail('VEHICLE_INSTALLATION_UNAVAILABLE');
  let result:unknown;try{result=await verify!({reservationId:p.reservationId,...copiedWire?{signedTransaction:copiedWire}:{}});}catch{return fail('VEHICLE_INSTALLATION_UNAVAILABLE');}
  // Own the full bounded proof before another await; the provider cannot mutate
  // source identity or the receipt while this transaction waits for its locks.
  const proof=bound(result,p,wire);
  try{return await db.transaction(async tx=>{
   await tx.execute(sql`select id from public.vehicle_activation_reservations where id=${p.reservationId} for update`);
   const winner=await read(tx,p,wire);if(winner)return winner;
   await tx.execute(sql`insert into public.vehicle_burn_consumptions(reservation_id,proof) values(${p.reservationId},${JSON.stringify(proof)}::jsonb)`);
   await tx.execute(sql`insert into public.advanced_vehicle_installations(reservation_id) values(${p.reservationId})`);
   return (await read(tx,p,wire))??fail('VEHICLE_INSTALLATION_SOURCE');
  });}catch(error){let cause:unknown=error;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){if('code'in cause&&cause.code==='55P03')fail('VEHICLE_INSTALLATION_BUSY');cause='cause'in cause?cause.cause:undefined;}throw error;}
 }
 return Object.freeze({get,recover});
}
