/** Explicit opt-in presentation sidecar. Existing expedition receipts stay byte-compatible.
 * These facts grant no route, material, reward, completion or renderer authority. */
import {z} from 'zod';
import {REALM_IDS} from './baseVisual';
import {PhaseEVehicleMintIdentitySchema} from './phaseEVehicles';
import {BoundCosmeticWakeReadSchema} from './boundCosmeticWake';

const Uuid=z.uuid().regex(/^[0-9a-f-]+$/),Wallet=PhaseEVehicleMintIdentitySchema.shape.assetId;
const Timestamp=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
export const BoundCosmeticWakeKindSchema=z.enum(['starter','advanced']);
export type BoundCosmeticWakeKind=z.infer<typeof BoundCosmeticWakeKindSchema>;
export const BoundCosmeticWakeOriginalQuerySchema=z.object({kind:BoundCosmeticWakeKindSchema,key:Uuid}).strict();
export const BoundCosmeticWakeCurrentQuerySchema=z.object({baseId:Uuid}).strict();
export const BoundCosmeticWakeCaptureSchema=z.union([
 BoundCosmeticWakeReadSchema,z.object({state:z.literal('legacy'),visual:z.null()}).strict(),
]);
export type BoundCosmeticWakeCapture=z.infer<typeof BoundCosmeticWakeCaptureSchema>;
const trip={expeditionId:Uuid,installationId:Uuid,homeRealmId:z.enum(REALM_IDS),realmId:z.enum(REALM_IDS),
 departedAt:Timestamp,returnsAt:Timestamp,wake:BoundCosmeticWakeCaptureSchema};
const chronological=(v:{departedAt:string;returnsAt:string})=>Date.parse(v.returnsAt)>Date.parse(v.departedAt);
export const BoundCosmeticWakeOriginalPresentationSchema=z.object({...trip,baseId:Uuid}).strict().refine(chronological,'Invalid trip times');
const actor={version:z.literal(1),wallet:Wallet,kind:BoundCosmeticWakeKindSchema,key:Uuid,serverNow:Timestamp};
export const BoundCosmeticWakeOriginalEnvelopeSchema=z.discriminatedUnion('status',[
 z.object({...actor,status:z.literal('unknown'),presentation:z.null(),returnedAt:z.null()}).strict(),
 z.object({...actor,status:z.literal('known'),presentation:BoundCosmeticWakeOriginalPresentationSchema,returnedAt:Timestamp.nullable()}).strict(),
]).refine(v=>v.status==='unknown'||v.key===v.presentation.expeditionId
 &&Date.parse(v.presentation.departedAt)<=Date.parse(v.serverNow)
 &&(v.returnedAt===null||Date.parse(v.returnedAt)>=Date.parse(v.presentation.returnsAt)&&Date.parse(v.returnedAt)<=Date.parse(v.serverNow)),
 'Presentation differs from the original key or observed chronology');
export type BoundCosmeticWakeOriginalEnvelope=z.infer<typeof BoundCosmeticWakeOriginalEnvelopeSchema>;
export const BoundCosmeticWakeCurrentTripSchema=z.object({...trip,kind:BoundCosmeticWakeKindSchema}).strict().refine(chronological,'Invalid trip times');
export const BoundCosmeticWakeCurrentEnvelopeSchema=z.object({version:z.literal(1),wallet:Wallet,baseId:Uuid,serverNow:Timestamp,
 trips:z.array(BoundCosmeticWakeCurrentTripSchema),
}).strict().refine(v=>new Set(v.trips.map(t=>t.kind+':'+t.expeditionId)).size===v.trips.length
 &&new Set(v.trips.map(t=>t.kind+':'+t.installationId)).size===v.trips.length
 &&v.trips.every(t=>Date.parse(t.departedAt)<=Date.parse(v.serverNow)), 'Duplicate or future active trip');
export type BoundCosmeticWakeCurrentEnvelope=z.infer<typeof BoundCosmeticWakeCurrentEnvelopeSchema>;
