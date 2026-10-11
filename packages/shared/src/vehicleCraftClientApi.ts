/** D153.212 redacted recipe/history only. None of these values grants custody,
 * signing, broadcast, minting, refund or new issuance authority. */
import {z} from 'zod';
import {PHASE_E_POLICY,PHASE_E_VEHICLE_CLIENT,PHASE_E_VEHICLE_RECIPES} from './constants';
import {PhaseEVehicleMintIdentitySchema,PhaseEVehicleFamilySchema,PhaseEVehicleTierSchema} from './phaseEVehicles';
import {PhaseEVehicleRecipeSnapshotSchema} from './phaseEVehicleRecipes';
const Address=PhaseEVehicleMintIdentitySchema.shape.assetId,Uuid=z.uuid().regex(/^[0-9a-f-]+$/),Hash=z.string().regex(/^[0-9a-f]{64}$/),Id=z.string().regex(/^[0-9a-f]{32}$/);
const Quantity=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<1n<<64n);
const Timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const JournalTimestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.slice(0,23)+'Z');
const Cursor=z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const flags={materialReservationAuthorized:z.literal(false),signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),reservationReleaseAuthorized:z.literal(false)};
export const VehicleCraftQuoteRequestSchema=z.object({baseId:Uuid,family:PhaseEVehicleFamilySchema,tier:PhaseEVehicleTierSchema,recipeVersion:z.literal(PHASE_E_VEHICLE_RECIPES.recipeVersion)}).strict();
export type VehicleCraftQuoteRequest=z.infer<typeof VehicleCraftQuoteRequestSchema>;
export const VehicleCraftQuoteSchema=z.object({version:z.literal(1),wallet:Address,baseId:Uuid,recipe:PhaseEVehicleRecipeSnapshotSchema,recipeHash:Hash,applicationFeeLamports:z.literal(String(PHASE_E_POLICY.craft.applicationFeeLamports)),ingredients:z.array(z.object({kind:z.enum(['refined','fragment']),itemId:z.string(),required:Quantity,available:Quantity,held:Quantity}).strict()),serverNow:Timestamp,...flags}).strict().refine(v=>JSON.stringify(v.ingredients.map(i=>({kind:i.kind,itemId:i.itemId,quantity:i.required})))===JSON.stringify(v.recipe.inputs),'Ingredient leaves differ from original recipe');
export type VehicleCraftQuote=z.infer<typeof VehicleCraftQuoteSchema>;
export const VehicleCraftRecordSchema=z.object({version:z.literal(1),wallet:Address,idempotencyKey:Uuid,reservationId:Uuid,baseId:Uuid,rootId:Id,attemptId:Id,identity:PhaseEVehicleMintIdentitySchema,recipe:PhaseEVehicleRecipeSnapshotSchema,recipeHash:Hash,materialHash:Hash,reservedAt:JournalTimestamp,status:z.enum(['held','paid_loss','won_unminted','minted']),consumedAt:JournalTimestamp.nullable(),mintedAt:JournalTimestamp.nullable(),serverNow:Timestamp,...flags}).strict().superRefine((v,c)=>{
 const bad=(message:string)=>c.addIssue({code:'custom',message});
 if(v.identity.family!==v.recipe.family||v.identity.tier!==v.recipe.tier)bad('Output identity differs from original recipe');
 if((v.status==='held')!==(v.consumedAt===null)||(v.status==='minted')!==(v.mintedAt!==null))bad('Outcome differs from original terminal graph');
 if(v.consumedAt&&v.consumedAt<v.reservedAt||v.mintedAt&&v.mintedAt<v.reservedAt)bad('Original journal order changed');
});
export type VehicleCraftRecord=z.infer<typeof VehicleCraftRecordSchema>;
export const VehicleCraftHistoryPageSchema=z.object({version:z.literal(1),wallet:Address,items:z.array(VehicleCraftRecordSchema).max(PHASE_E_VEHICLE_CLIENT.discoveryPageSize),nextCursor:Cursor.nullable()}).strict().refine(v=>v.items.every(r=>r.wallet===v.wallet)&&new Set(v.items.map(r=>r.idempotencyKey)).size===v.items.length,'History is not original-actor scoped');
export type VehicleCraftHistoryPage=z.infer<typeof VehicleCraftHistoryPageSchema>;
export const VehicleCraftRecoverySchema=z.object({version:z.literal(1),wallet:Address,idempotencyKey:Uuid,status:z.enum(['current','held']),reason:z.enum(['PROVIDER_UNAVAILABLE','PROOF_UNAVAILABLE']).nullable(),record:VehicleCraftRecordSchema}).strict().refine(v=>v.wallet===v.record.wallet&&v.idempotencyKey===v.record.idempotencyKey&&(v.status==='held')===(v.reason!==null),'Recovery differs from original actor or state');
export type VehicleCraftRecovery=z.infer<typeof VehicleCraftRecoverySchema>;
export const VehicleCraftHistoryQuerySchema=z.object({cursor:Cursor.optional()}).strict();
export const VehicleCraftKeyParamsSchema=z.object({key:Uuid}).strict();
