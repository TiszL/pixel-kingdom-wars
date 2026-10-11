/** Private D153.211 material custody. No signer, HTTP admission, release/refund,
 * salvage, licensed workshop or metadata provenance is created by this module. */
import {createHash} from 'node:crypto';
import {vehicleCraftRecipe,vehicleRecipeCanonical,VEHICLE_RECIPE_HASH_DOMAIN,PhaseEVehicleRecipeSnapshotSchema,type PhaseEVehicleRecipeSnapshot} from '@shardkeep/shared/phaseEVehicleRecipes';
import {PhaseEVehicleMintIdentitySchema,PHASE_E_VEHICLE_FAMILY_IDS} from '@shardkeep/shared/phaseEVehicles';
import {normalizeVehicleIssuanceOriginal,type VehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import type {VehicleIssuanceTerminalEvidence} from '@shardkeep/chain/vehicle-issuance-terminal';
import {vehicleKeccak,vehicleTermsHash,vehicleVrfRequest,vehicleWins} from '@shardkeep/chain/vehicle-issuance-protocol';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {phaseEVehiclesEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {ordinaryWorkshop} from './ordinaryCrafting';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from './stableBasePrerequisites';
const address=PhaseEVehicleMintIdentitySchema.shape.assetId,uuid=z.uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[0-9a-f]{64}$/),id=z.string().regex(/^[0-9a-f]{32}$/),slot=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const recipeRequest=z.object({family:PhaseEVehicleMintIdentitySchema.shape.family,tier:PhaseEVehicleMintIdentitySchema.shape.tier,recipeVersion:z.number().int().positive()}).strict();
const command=recipeRequest.extend({baseId:uuid,idempotencyKey:uuid}).strict();
export type VehicleCraftMaterialCommand=z.infer<typeof command>;
const Program=z.object({programId:address,reviewedDeploymentSlot:slot,reviewedProgramDataSha256:hash,upgradeAuthority:address.nullable()}).strict();
const Proof=z.object({version:z.literal(1),rootId:id,attemptId:id,buyer:address,identity:PhaseEVehicleMintIdentitySchema,originalHash:hash,termsHash:hash,requestHash:hash,randomness:hash,permitId:id,requestSlot:slot,resultSlot:slot,settlementSlot:slot,mintSlot:slot,slot,
 outcome:z.enum(['lost','won']),paid:z.literal(true),minted:z.boolean(),source:z.object({profile:z.literal('paid-normal-result-12-v1'),trust:z.literal('trusted-finalized-rpc-reviewed-program'),stateProvenance:z.literal('fresh-reviewed-deployment'),genesisHash:address,programs:z.array(Program).length(3),accounts:z.array(z.object({address,owner:address,executable:z.boolean(),dataSha256:hash}).strict()).length(12)}).strict(),finalizedNormalResultObserved:z.literal(true),finalizedMintObserved:z.literal(false),transactionProofVerified:z.literal(false),paymentAuthorized:z.literal(false),activationAuthorized:z.literal(false),reservationReleaseAuthorized:z.literal(false)}).strict();
function fail(code:string):never{throw new HttpError(code==='VEHICLE_MATERIAL_HELD'||code==='VEHICLE_MATERIAL_DISABLED'?503:409,code,code);}
const recipeHash=(recipe:PhaseEVehicleRecipeSnapshot)=>vehicleKeccak(Buffer.from(VEHICLE_RECIPE_HASH_DOMAIN+vehicleRecipeCanonical(recipe))).toString('hex');
export function vehicleCraftMaterialHash(p:{actorWallet:string;baseId:string;rootId:string;attemptId:string;nonce:string;recipeHash:string;recipe:PhaseEVehicleRecipeSnapshot}):string{
 address.parse(p.actorWallet);uuid.parse(p.baseId);id.parse(p.rootId);id.parse(p.attemptId);hash.parse(p.nonce);hash.parse(p.recipeHash);PhaseEVehicleRecipeSnapshotSchema.parse(p.recipe);
 return createHash('sha256').update(['SKVEHMAT01',p.actorWallet,p.baseId,p.rootId,p.attemptId,p.nonce,p.recipeHash,...p.recipe.inputs.map(l=>`${l.kind}:${l.itemId}:${l.quantity}`)].join('\n'),'utf8').digest('hex');
}
export interface VehicleCraftMaterialRecord{
 id:string;actorWallet:string;request:VehicleCraftMaterialCommand;nonce:string;reservedAt:string;recipe:PhaseEVehicleRecipeSnapshot;recipeHash:string;materialHash:string;original:VehicleIssuanceOriginal;
 status:'held'|'consumed';terminal:{proof:VehicleIssuanceTerminalEvidence;recordedAt:string}|null;
}
export interface VehicleCraftMaterialDependencies{
 /** Private configured authority, never a request body. The module derives all
  * recipe/material terms and rejects identity changes in this template. */
 loadTemplate?:(wallet:string,request:VehicleCraftMaterialCommand)=>Promise<VehicleIssuanceOriginal>;
 readFinalizedResult?:(rootId:string)=>Promise<VehicleIssuanceTerminalEvidence>;
 assertNewAdmission?:()=>void;
}
function validateProof(value:unknown,o:VehicleIssuanceOriginal):VehicleIssuanceTerminalEvidence{
 const p=Proof.parse(value),termsHash=vehicleTermsHash(o),won=vehicleWins(Buffer.from(p.randomness,'hex'),o.terms.oddsBps);
 if(p.rootId!==o.rootId||p.attemptId!==o.attemptId||p.buyer!==o.buyer||p.permitId!==o.permitId||p.originalHash!==o.originalHash||JSON.stringify(p.identity)!==JSON.stringify(o.identity)||p.source.genesisHash!==o.genesisHash||p.termsHash!==termsHash||p.requestHash!==vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,termsHash)).toString('hex')||p.outcome!==(won?'won':'lost')||p.requestSlot>p.resultSlot||p.resultSlot>p.settlementSlot||p.settlementSlot>p.slot||p.requestSlot<Math.max(...p.source.programs.map(x=>x.reviewedDeploymentSlot))||p.minted&&(p.outcome!=='won'||p.mintSlot<p.settlementSlot||p.mintSlot>p.slot)||!p.minted&&p.mintSlot!==0)fail('VEHICLE_MATERIAL_PROOF');
 return p;
}
async function source(db:DbOrTx){await db.execute(sql`select public.shardkeep_divine_fragment_source()`);}
async function readFrom(db:DbOrTx,wallet:string,key:string):Promise<VehicleCraftMaterialRecord|null>{
 const [r]=await db.execute<{id:string;actor_wallet:string;idempotency_key:string;base_id:string;root_id:string;attempt_id:string;nonce:string;reserved_at:string;recipe_hash:string;material_hash:string;canonical:string;original:unknown;proof:unknown|null;terminal_at:string|null}>(sql`select r.*,to_char(r.reserved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') reserved_at,p.canonical,o.original,t.proof,to_char(t.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') terminal_at from public.vehicle_craft_material_reservations r join public.vehicle_craft_recipe_policies p on p.recipe_hash=r.recipe_hash join public.vehicle_issuance_originals o on o.root_id=r.root_id left join public.vehicle_craft_material_terminals t on t.reservation_id=r.id where r.actor_wallet=${wallet} and r.idempotency_key=${key}::uuid`);
 if(!r)return null;
 const recipe=PhaseEVehicleRecipeSnapshotSchema.parse(JSON.parse(r.canonical)),original=normalizeVehicleIssuanceOriginal(r.original);
 if(vehicleRecipeCanonical(recipe)!==r.canonical||recipeHash(recipe)!==r.recipe_hash||vehicleCraftMaterialHash({actorWallet:wallet,baseId:r.base_id,rootId:r.root_id,attemptId:r.attempt_id,nonce:r.nonce,recipeHash:r.recipe_hash,recipe})!==r.material_hash||original.terms.materialHash!==r.material_hash||original.terms.recipeHash!==r.recipe_hash||original.buyer!==wallet||original.rootId!==r.root_id||original.attemptId!==r.attempt_id||original.identity.family!==recipe.family||original.identity.tier!==recipe.tier||original.terms.oddsBps!==recipe.oddsBps)fail('VEHICLE_MATERIAL_SOURCE');
 const lines=await db.execute<{kind:string;item_id:string;quantity:string}>(sql`select kind,item_id,quantity::text from public.vehicle_craft_material_lines where reservation_id=${r.id}::uuid order by position`);
 if(JSON.stringify(lines.map(l=>({kind:l.kind,itemId:l.item_id,quantity:l.quantity})))!==JSON.stringify(recipe.inputs))fail('VEHICLE_MATERIAL_SOURCE');
 return {id:r.id,actorWallet:wallet,request:{baseId:r.base_id,idempotencyKey:r.idempotency_key,family:recipe.family,tier:recipe.tier,recipeVersion:recipe.recipeVersion},nonce:r.nonce,reservedAt:r.reserved_at,recipe,recipeHash:r.recipe_hash,materialHash:r.material_hash,original,status:r.proof?'consumed':'held',terminal:r.proof?{proof:validateProof(r.proof,original),recordedAt:r.terminal_at!}:null};
}
function replay(record:VehicleCraftMaterialRecord,input:VehicleCraftMaterialCommand){if(JSON.stringify(command.parse(record.request))!==JSON.stringify(input))fail('VEHICLE_MATERIAL_CONFLICT');return record;}
export function createVehicleCraftMaterials(db:Db,dependencies:VehicleCraftMaterialDependencies={}){
 if('rollback'in db)fail('VEHICLE_MATERIAL_TOP_LEVEL');
 const gate=()=>{if(!phaseEVehiclesEnabled())fail('VEHICLE_MATERIAL_DISABLED');dependencies.assertNewAdmission?.();};
 async function read(wallet:string,key:string){wallet=address.parse(wallet);key=uuid.parse(key);await source(db);return readFrom(db,wallet,key);}
 async function quote(wallet:string,input:unknown){address.parse(wallet);const p=recipeRequest.parse(input),recipe=vehicleCraftRecipe(p.family,p.tier,p.recipeVersion);return {recipe,recipeHash:recipeHash(recipe),materialReservationAuthorized:false as const};}
 async function reserve(wallet:string,input:unknown,authority:StableBaseMutationContext):Promise<VehicleCraftMaterialRecord>{
  wallet=address.parse(wallet);const p=command.parse(input);await source(db);const prior=await readFrom(db,wallet,p.idempotencyKey);if(prior)return replay(prior,p);gate();
  if(p.baseId!==authority.baseId||!dependencies.loadTemplate)fail('VEHICLE_MATERIAL_AUTHORITY');
  const recipe=vehicleCraftRecipe(p.family,p.tier,p.recipeVersion),rh=recipeHash(recipe),template=normalizeVehicleIssuanceOriginal(await dependencies.loadTemplate(wallet,p));
  if(template.buyer!==wallet||template.identity.family!==p.family||template.identity.tier!==p.tier)fail('VEHICLE_MATERIAL_TEMPLATE');
  return db.transaction(async tx=>{
   await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);const again=await readFrom(tx,wallet,p.idempotencyKey);if(again)return replay(again,p);
   await lockStablePrerequisiteBase(tx,wallet,authority);gate();const facility=await ordinaryWorkshop(tx,p.baseId);
   await tx.execute(sql`insert into public.vehicle_craft_recipe_policies(recipe_hash,canonical) values(${rh},${vehicleRecipeCanonical(recipe)}) on conflict(recipe_hash) do nothing`);
   const [held]=await tx.execute<{id:string;material_hash:string}>(sql`insert into public.vehicle_craft_material_reservations(actor_wallet,idempotency_key,base_id,root_id,attempt_id,permit_id,asset_id,recipe_hash,workshop_id,workshop_job_id) values(${wallet},${p.idempotencyKey}::uuid,${p.baseId}::uuid,${template.rootId},${template.attemptId},${template.permitId},${template.identity.assetId},${rh},${facility.building.id}::uuid,${facility.completed.id}::uuid) returning id,material_hash`);
   if(!held)fail('VEHICLE_MATERIAL_MISSING');const {originalHash:_ignored,...base}=template;
   const original=normalizeVehicleIssuanceOriginal({...base,terms:{...template.terms,recipeVersion:recipe.recipeVersion,recipeHash:rh,materialHash:held.material_hash,oddsBps:recipe.oddsBps,family:PHASE_E_VEHICLE_FAMILY_IDS.indexOf(recipe.family),tier:recipe.tier}});
   await tx.execute(sql`insert into public.vehicle_issuance_originals(root_id,attempt_id,permit_id,asset_id,buyer,original) values(${original.rootId},${original.attemptId},${original.permitId},${original.identity.assetId},${wallet},${JSON.stringify(original)}::jsonb)`);
   gate();return (await readFrom(tx,wallet,p.idempotencyKey))??fail('VEHICLE_MATERIAL_MISSING');
  });
 }
 async function settle(wallet:string,key:string):Promise<VehicleCraftMaterialRecord>{
  wallet=address.parse(wallet);key=uuid.parse(key);const saved=await read(wallet,key);if(!saved)fail('VEHICLE_MATERIAL_MISSING');if(saved.terminal)return saved;
  if(!dependencies.readFinalizedResult)fail('VEHICLE_MATERIAL_HELD');let proof:VehicleIssuanceTerminalEvidence;
  try{proof=validateProof(await dependencies.readFinalizedResult(saved.original.rootId),saved.original);}catch{fail('VEHICLE_MATERIAL_HELD');}
  return db.transaction(async tx=>{await source(tx);await tx.execute(sql`select id from public.vehicle_craft_material_reservations where id=${saved.id}::uuid for update`);const old=await readFrom(tx,wallet,key);if(old?.terminal)return old;
   await tx.execute(sql`insert into public.vehicle_craft_material_terminals(reservation_id,outcome,proof) values(${saved.id}::uuid,${proof.outcome},${JSON.stringify(proof)}::jsonb)`);return (await readFrom(tx,wallet,key))??fail('VEHICLE_MATERIAL_MISSING');});
 }
 return Object.freeze({quote,reserve,read,settle});
}
