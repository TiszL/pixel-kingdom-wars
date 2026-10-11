/** D153.207 private unactivated original acquisition bridge. Only a configured
 * finalized reader supplies evidence; no HTTP payload/registry assertion does. */
import {normalizeVehicleIssuanceOriginal,type VehicleIssuanceOriginal,type VehicleIssuanceEvidence} from '@shardkeep/chain/vehicle-issuance-evidence';
import {vehicleId,vehicleTermsHash,vehicleKeccak,vehicleVrfRequest} from '@shardkeep/chain/vehicle-issuance-protocol';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
const address=PhaseEVehicleMintIdentitySchema.shape.assetId,hash=z.string().regex(/^[0-9a-f]{64}$/),id=z.string().regex(/^[0-9a-f]{32}$/),slot=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Program=z.object({programId:address,reviewedDeploymentSlot:slot,reviewedProgramDataSha256:hash,upgradeAuthority:address.nullable()}).strict();
const Evidence=z.object({version:z.literal(1),rootId:id,attemptId:id,buyer:address,identity:PhaseEVehicleMintIdentitySchema,originalHash:hash,termsHash:hash,requestHash:hash,randomness:hash,permitId:id,requestSlot:slot,resultSlot:slot,settlementSlot:slot,mintSlot:slot,slot,
 source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),stateProvenance:z.literal('fresh-reviewed-deployment'),genesisHash:address,programs:z.array(Program).length(3),accounts:z.array(z.object({address,owner:address,executable:z.boolean(),dataSha256:hash}).strict()).length(14)}).strict(),finalizedMintObserved:z.literal(true),transactionProofVerified:z.literal(false),paymentAuthorized:z.literal(false),activationAuthorized:z.literal(false),reservationReleaseAuthorized:z.literal(false)}).strict();
const fail=(code:string):never=>{throw new HttpError(code==='VEHICLE_ISSUANCE_CONFLICT'?409:503,code,code);};
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user=session_user and current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_issuance_originals'::regclass) allowed`);if(!r?.allowed)fail('VEHICLE_ISSUANCE_OWNER');}
export function createVehicleIssuanceAcquisitions(db:Db,dependencies:{readFinalized?:(rootId:string)=>Promise<VehicleIssuanceEvidence>}={}){
 if('rollback'in db)fail('VEHICLE_ISSUANCE_TOP_LEVEL');
 async function loadOriginal(rootId:string):Promise<VehicleIssuanceOriginal|null>{rootId=vehicleId(rootId);await owner(db);const [r]=await db.execute<{original:unknown}>(sql`select original from public.vehicle_issuance_originals where root_id=${rootId}`);return r?normalizeVehicleIssuanceOriginal(r.original):null;}
 async function saveOriginal(value:unknown):Promise<VehicleIssuanceOriginal>{
  const original=normalizeVehicleIssuanceOriginal(value);await owner(db);const json=JSON.stringify(original);
  await db.transaction(async tx=>{await tx.execute(sql`insert into public.vehicle_issuance_originals(root_id,attempt_id,permit_id,asset_id,buyer,original) values(${original.rootId},${original.attemptId},${original.permitId},${original.identity.assetId},${original.buyer},${json}::jsonb) on conflict(root_id) do nothing`);const [same]=await tx.execute(sql`select root_id from public.vehicle_issuance_originals where root_id=${original.rootId} and original=${json}::jsonb`);if(!same)fail('VEHICLE_ISSUANCE_CONFLICT');});return original;
 }
 async function getFrom(conn:DbOrTx,rootId:string):Promise<VehicleIssuanceEvidence|null>{const [r]=await conn.execute<{evidence:unknown}>(sql`select evidence from public.vehicle_issuance_acquisitions where root_id=${rootId}`);return r?Evidence.parse(r.evidence):null;}
 async function get(rootId:string){rootId=vehicleId(rootId);await owner(db);return getFrom(db,rootId);}
 async function acquire(rootId:string):Promise<VehicleIssuanceEvidence>{
  rootId=vehicleId(rootId);await owner(db);const old=await getFrom(db,rootId);if(old)return old;
  const original=await loadOriginal(rootId);if(!original)fail('VEHICLE_ISSUANCE_ORIGINAL');if(!dependencies.readFinalized)fail('VEHICLE_ISSUANCE_UNAVAILABLE');
  let proof:VehicleIssuanceEvidence;try{proof=Evidence.parse(await dependencies.readFinalized!(rootId));}catch{return fail('VEHICLE_ISSUANCE_HELD');}
  const o=original!,termsHash=vehicleTermsHash(o);
  if(proof.rootId!==o.rootId||proof.attemptId!==o.attemptId||proof.buyer!==o.buyer||proof.permitId!==o.permitId||proof.originalHash!==o.originalHash||JSON.stringify(proof.identity)!==JSON.stringify(o.identity)||proof.source.genesisHash!==o.genesisHash||proof.termsHash!==termsHash||proof.requestHash!==vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,termsHash)).toString('hex')||proof.requestSlot>proof.resultSlot||proof.resultSlot>proof.settlementSlot||proof.settlementSlot>proof.mintSlot||proof.mintSlot>proof.slot)fail('VEHICLE_ISSUANCE_SOURCE');
  return db.transaction(async tx=>{
   await tx.execute(sql`select root_id from public.vehicle_issuance_originals where root_id=${rootId} for update`);
   const prior=await getFrom(tx,rootId);if(prior)return prior;
   const identity=o.identity;
   await tx.execute(sql`insert into public.vehicle_issuance_acquisitions(root_id,asset_id,collection,buyer,family,tier,evidence) values(${rootId},${identity.assetId},${identity.collection},${o.buyer},${identity.family},${identity.tier},${JSON.stringify(proof)}::jsonb)`);
   await tx.execute(sql`insert into public.vehicle_mint_registry(asset_id,collection,family,tier,owner_attestation,provenance,issuance_root) values(${identity.assetId},${identity.collection},${identity.family},${identity.tier},null,'finalized_issuance',${rootId})`);
   return (await getFrom(tx,rootId))??fail('VEHICLE_ISSUANCE_MISSING');
  });
 }
 return Object.freeze({saveOriginal,loadOriginal,acquire,get});
}
