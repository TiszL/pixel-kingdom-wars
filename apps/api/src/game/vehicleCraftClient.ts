/** Authenticated read/recovery adapter over accepted private originals. No issuer,
 * reserve command, signer, template, client proof, release or fee total. */
import {PHASE_E_POLICY,PHASE_E_VEHICLE_CLIENT} from '@shardkeep/shared';
import {VehicleCraftQuoteRequestSchema,VehicleCraftQuoteSchema,VehicleCraftRecordSchema,VehicleCraftHistoryPageSchema,VehicleCraftRecoverySchema,type VehicleCraftRecord} from '@shardkeep/shared/vehicleCraftClientApi';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import type {VehicleAssetPageV2} from '@shardkeep/shared/vehicleClientApi';
import {normalizeVehicleIssuanceOriginal,type VehicleIssuanceEvidence,type VehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import type {VehicleIssuanceTerminalEvidence} from '@shardkeep/chain/vehicle-issuance-terminal';
import {vehicleTermsHash,vehicleKeccak,vehicleVrfRequest,vehicleWins} from '@shardkeep/chain/vehicle-issuance-protocol';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {createVehicleCraftMaterials} from './vehicleCraftMaterials';
import {createVehicleIssuanceAcquisitions} from './vehicleIssuanceAcquisitions';
import {requireFreshBaseAuthority,assertFreshLockedBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {lockStablePrerequisiteBase} from './stableBasePrerequisites';
const address=PhaseEVehicleMintIdentitySchema.shape.assetId,uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const flags={materialReservationAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,reservationReleaseAuthorized:false} as const;
function held():never{throw new HttpError(503,'Original craft history is unavailable; retain its saved identity','VEHICLE_CRAFT_HISTORY_HELD');}
function missing():never{throw new HttpError(404,'Original craft was not found','VEHICLE_CRAFT_NOT_FOUND');}
async function source(db:DbOrTx){await db.execute(sql`select public.shardkeep_divine_fragment_source()`);}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
function validateMint(proof:VehicleIssuanceEvidence,o:VehicleIssuanceOriginal){
 const terms=vehicleTermsHash(o);
 if(proof.rootId!==o.rootId||proof.attemptId!==o.attemptId||proof.permitId!==o.permitId||proof.buyer!==o.buyer||proof.originalHash!==o.originalHash||!same(proof.identity,o.identity)||proof.termsHash!==terms||proof.requestHash!==vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,terms)).toString('hex')||proof.source.genesisHash!==o.genesisHash||!vehicleWins(Buffer.from(proof.randomness,'hex'),o.terms.oddsBps)||proof.requestSlot<Math.max(...proof.source.programs.map(p=>p.reviewedDeploymentSlot))||proof.requestSlot>proof.resultSlot||proof.resultSlot>proof.settlementSlot||proof.settlementSlot>proof.mintSlot||proof.mintSlot>proof.slot)held();
}
/** Full immutable registry/original/acquisition graph, independent of current
 * ownership. The caller must separately establish current finalized ownership. */
export async function readVehicleCandidateProvenance(db:Db,identity:z.infer<typeof PhaseEVehicleMintIdentitySchema>):Promise<VehicleAssetPageV2['items'][number]['provenance']>{
 try{await source(db);const [r]=await db.execute<{asset_id:string;collection:string;family:string;tier:number;provenance:string;owner_attestation:unknown;issuance_root:string|null}>(sql`select asset_id,collection,family,tier,provenance,owner_attestation,issuance_root from public.vehicle_mint_registry where asset_id=${identity.assetId}`);
  if(!r||!same(PhaseEVehicleMintIdentitySchema.parse({assetId:r.asset_id,collection:r.collection,family:r.family,tier:r.tier}),identity))held();
  if(r.provenance==='owner_attestation'){if(!z.record(z.string(),z.unknown()).safeParse(r.owner_attestation).success||r.issuance_root!==null)held();return {kind:'owner_attested'};}
  if(r.provenance!=='finalized_issuance'||r.owner_attestation!==null||!r.issuance_root)held();
  const store=createVehicleIssuanceAcquisitions(db),original=await store.loadOriginal(r.issuance_root),proof=await store.get(r.issuance_root);
  if(!original||!proof||!same(original.identity,identity))held();validateMint(proof,original);
  const [a]=await db.execute<{asset_id:string;collection:string;buyer:string;family:string;tier:number}>(sql`select asset_id,collection,buyer,family,tier from public.vehicle_issuance_acquisitions where root_id=${r.issuance_root}`);
  if(!a||a.buyer!==original.buyer||!same(PhaseEVehicleMintIdentitySchema.parse({assetId:a.asset_id,collection:a.collection,family:a.family,tier:a.tier}),identity))held();
  return {kind:'finalized_issuance',rootId:original.rootId};
 }catch{return held();}
}
export interface VehicleCraftClientDependencies{
 finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null;
 readFinalizedResult?:(rootId:string)=>Promise<VehicleIssuanceTerminalEvidence>;
 readFinalizedMint?:(rootId:string)=>Promise<VehicleIssuanceEvidence>;
}
export function createVehicleCraftClient(db:Db,dependencies:VehicleCraftClientDependencies={}){
 if('rollback'in db)held();
 const result=dependencies.readFinalizedResult,mint=dependencies.readFinalizedMint,ownership={finalizedDeedReader:dependencies.finalizedDeedReader??null,deedCollection:dependencies.deedCollection??null};
 const materials=createVehicleCraftMaterials(db,{...result?{readFinalizedResult:result}:{}}),acquisitions=createVehicleIssuanceAcquisitions(db,{...mint?{readFinalized:mint}:{}});
 async function read(wallet:string,key:string):Promise<VehicleCraftRecord>{
  wallet=address.parse(wallet);key=uuid.parse(key);
  try{const saved=await materials.read(wallet,key);if(!saved){const [exists]=await db.execute(sql`select id from public.vehicle_craft_material_reservations where actor_wallet=${wallet} and idempotency_key=${key}::uuid`);if(exists)held();return missing();}
   const o=normalizeVehicleIssuanceOriginal(saved.original),proof=await acquisitions.get(o.rootId),[registry]=await db.execute<{provenance:string;issuance_root:string|null}>(sql`select provenance,issuance_root from public.vehicle_mint_registry where asset_id=${o.identity.assetId}`);
   if(!!proof!==!!registry||registry&&(registry.provenance!=='finalized_issuance'||registry.issuance_root!==o.rootId))held();
   let mintedAt:string|null=null;
   if(proof){validateMint(proof,o);const provenance=await readVehicleCandidateProvenance(db,o.identity);if(provenance.kind!=='finalized_issuance'||provenance.rootId!==o.rootId)held();
    if(saved.terminal&&(saved.terminal.proof.outcome!=='won'||saved.terminal.proof.randomness!==proof.randomness||saved.terminal.proof.requestHash!==proof.requestHash||saved.terminal.proof.resultSlot!==proof.resultSlot||saved.terminal.proof.settlementSlot!==proof.settlementSlot))held();
    const [row]=await db.execute<{at:string}>(sql`select to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at from public.vehicle_issuance_acquisitions where root_id=${o.rootId}`);if(!row)held();if(saved.terminal)mintedAt=row.at;
   }
   return VehicleCraftRecordSchema.parse({version:1,wallet,idempotencyKey:key,reservationId:saved.id,baseId:saved.request.baseId,rootId:o.rootId,attemptId:o.attemptId,identity:o.identity,recipe:saved.recipe,recipeHash:saved.recipeHash,materialHash:saved.materialHash,reservedAt:saved.reservedAt,status:!saved.terminal?'held':saved.terminal.proof.outcome==='lost'?'paid_loss':mintedAt?'minted':'won_unminted',consumedAt:saved.terminal?.recordedAt??null,mintedAt,serverNow:new Date().toISOString(),...flags});
  }catch(error){if(error instanceof HttpError&&error.code==='VEHICLE_CRAFT_NOT_FOUND')throw error;return held();}
 }
 async function history(wallet:string,cursor?:string){
  wallet=address.parse(wallet);let after:string|null=null;
  if(cursor!==undefined){try{if(cursor.length>256)throw Error();const bytes=Buffer.from(cursor,'base64url');if(bytes.toString('base64url')!==cursor)throw Error();const v=z.object({version:z.literal(1),wallet:address,id:uuid}).strict().parse(JSON.parse(bytes.toString()));if(v.wallet!==wallet)throw Error();after=v.id;}catch{throw new HttpError(400,'Craft history cursor is invalid','VEHICLE_CRAFT_CURSOR');}}
  try{await source(db);const rows=await db.execute<{id:string;idempotency_key:string}>(sql`select id,idempotency_key from public.vehicle_craft_material_reservations where actor_wallet=${wallet} ${after?sql`and id>${after}::uuid`:sql``} order by id limit ${PHASE_E_VEHICLE_CLIENT.discoveryPageSize+1}`),page=rows.slice(0,PHASE_E_VEHICLE_CLIENT.discoveryPageSize),items=[];
   for(const row of page)items.push(await read(wallet,row.idempotency_key));const last=page.at(-1);
   return VehicleCraftHistoryPageSchema.parse({version:1,wallet,items,nextCursor:rows.length>PHASE_E_VEHICLE_CLIENT.discoveryPageSize&&last?Buffer.from(JSON.stringify({version:1,wallet,id:last.id})).toString('base64url'):null});
  }catch{return held();}
 }
 async function quote(wallet:string,input:unknown){
  wallet=address.parse(wallet);const p=VehicleCraftQuoteRequestSchema.parse(input);
  await requireFreshBaseAuthority(db,wallet,p.baseId,ownership.finalizedDeedReader,ownership.deedCollection);
  try{return await db.transaction(async tx=>{
   await source(tx);await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);await lockStablePrerequisiteBase(tx,wallet,{baseId:p.baseId,assertAuthority:async(...args)=>{await assertFreshLockedBaseAuthority(...args);}});
   const q=await materials.quote(wallet,{family:p.family,tier:p.tier,recipeVersion:p.recipeVersion}),ingredients=[];
   for(const input of q.recipe.inputs){const [stock]=input.kind==='refined'?await tx.execute<{available:string}>(sql`select available::text from public.crafting_stocks where base_id=${p.baseId}::uuid and item_id=${input.itemId}`):await tx.execute<{available:string}>(sql`select available::text from public.crystal_fragment_stocks where base_id=${p.baseId}::uuid`);
    const [holds]=await tx.execute<{quantity:string}>(sql`select coalesce(sum(l.quantity),0)::text quantity from public.vehicle_craft_material_lines l join public.vehicle_craft_material_reservations r on r.id=l.reservation_id where r.base_id=${p.baseId}::uuid and l.kind=${input.kind} and l.item_id=${input.itemId} and not exists(select 1 from public.vehicle_craft_material_terminals t where t.reservation_id=r.id)`);
    ingredients.push({kind:input.kind,itemId:input.itemId,required:input.quantity,available:stock?.available??'0',held:holds?.quantity??'0'});
   }
   await assertFreshLockedBaseAuthority(tx,wallet,p.baseId);return VehicleCraftQuoteSchema.parse({version:1,wallet,baseId:p.baseId,recipe:q.recipe,recipeHash:q.recipeHash,applicationFeeLamports:String(PHASE_E_POLICY.craft.applicationFeeLamports),ingredients,serverNow:new Date().toISOString(),...flags});
  });}catch(error){if(error instanceof HttpError&&error.statusCode<500)throw error;return held();}
 }
 async function recover(wallet:string,key:string){
  let record=await read(wallet,key);const response=(reason:'PROVIDER_UNAVAILABLE'|'PROOF_UNAVAILABLE'|null)=>VehicleCraftRecoverySchema.parse({version:1,wallet:record.wallet,idempotencyKey:record.idempotencyKey,status:reason?'held':'current',reason,record});
  if(record.status==='paid_loss'||record.status==='minted')return response(null);
  if(record.status==='held'){
   if(!result)return response('PROVIDER_UNAVAILABLE');
   try{await materials.settle(wallet,key);}catch(error){if(error instanceof HttpError&&error.code==='VEHICLE_MATERIAL_HELD'){record=await read(wallet,key);return response('PROOF_UNAVAILABLE');}return held();}
   record=await read(wallet,key);
  }
  if(record.status==='won_unminted'){
   if(!mint)return response('PROVIDER_UNAVAILABLE');
   try{await acquisitions.acquire(record.rootId);}catch(error){if(error instanceof HttpError&&['VEHICLE_ISSUANCE_HELD','VEHICLE_ISSUANCE_UNAVAILABLE','VEHICLE_ISSUANCE_SOURCE'].includes(error.code??'')){record=await read(wallet,key);return response('PROOF_UNAVAILABLE');}return held();}
   record=await read(wallet,key);
  }
  return response(null);
 }
 return Object.freeze({quote,read,history,recover});
}
export type VehicleCraftClientProvider=ReturnType<typeof createVehicleCraftClient>;
