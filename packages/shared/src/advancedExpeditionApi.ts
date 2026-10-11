import {EquipmentSecondaryOutputSchema,EquipmentFittingSchema,EquipmentFittingSnapshotSchema,equipmentFittingMatches,fittingSelection} from './phaseEOrdinaryEquipment';
/** D-153.138 public saved-command history only. No live custody, inventory,
 * finality, signing, dispatch or service authority is granted by these schemas.
 * Elapsed arrival time never substitutes for an actual return receipt. */
import {z} from 'zod';
import {AdvancedExpeditionSnapshotSchema} from './phaseEAdvancedExpeditions';
import {PhaseEVehicleMintIdentitySchema} from './phaseEVehicles';
const Uuid=z.uuid().regex(/^[0-9a-f-]+$/),Wallet=PhaseEVehicleMintIdentitySchema.shape.assetId;
const Timestamp=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const Version=z.number().int().positive().max(2_147_483_647);
const RouteId=z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/);
const I64=(1n<<63n)-1n;
const isCounter=(v:string)=>/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=I64;
const Counter=z.string().max(19).refine(isCounter);
export const AdvancedExpeditionRequestSchema=z.object({idempotencyKey:Uuid,baseId:Uuid,installationId:Uuid,
 routeId:RouteId,policyVersion:Version,fitting:EquipmentFittingSchema.optional()}).strict();
export type AdvancedExpeditionRequest=z.infer<typeof AdvancedExpeditionRequestSchema>;
export const AdvancedExpeditionReceiptSchema=z.object({wallet:Wallet,request:AdvancedExpeditionRequestSchema,
 expeditionId:Uuid,installationId:Uuid,route:AdvancedExpeditionSnapshotSchema,departedAt:Timestamp,returnsAt:Timestamp,
 termId:Uuid,termHash:z.string().regex(/^[0-9a-f]{64}$/),completedBefore:Counter.refine(v=>isCounter(v)&&BigInt(v)<I64),
}).strict().refine(v=>v.expeditionId===v.request.idempotencyKey&&v.installationId===v.request.installationId
 &&JSON.stringify(fittingSelection(v.route).fitting)===JSON.stringify(v.request.fitting)
 &&v.route.routeId===v.request.routeId&&v.route.policyVersion===v.request.policyVersion
 &&Date.parse(v.returnsAt)-Date.parse(v.departedAt)===v.route.durationSec*1000,'Departure differs from its original command or duration');
export type AdvancedExpeditionReceipt=z.infer<typeof AdvancedExpeditionReceiptSchema>;
const envelope={wallet:Wallet,idempotencyKey:Uuid,serverNow:Timestamp};
export const AdvancedExpeditionEnvelopeSchema=z.discriminatedUnion('status',[
 z.object({...envelope,status:z.literal('unknown'),receipt:z.null(),return:z.null()}).strict(),
 z.object({...envelope,status:z.literal('accepted'),receipt:AdvancedExpeditionReceiptSchema,
  return:z.object({returnId:Uuid,returnedAt:Timestamp,completedTotal:Counter,secondaryOutput:EquipmentSecondaryOutputSchema.optional()}).strict().nullable()}).strict(),
]).refine(v=>v.status==='unknown'||v.wallet===v.receipt.wallet&&v.idempotencyKey===v.receipt.request.idempotencyKey
 &&(v.return===null||Date.parse(v.return.returnedAt)>=Date.parse(v.receipt.returnsAt)
  &&JSON.stringify(v.return.secondaryOutput)===JSON.stringify(v.receipt.route.secondaryOutput)
  &&isCounter(v.return.completedTotal)&&isCounter(v.receipt.completedBefore)
  &&BigInt(v.return.completedTotal)===BigInt(v.receipt.completedBefore)+1n),'History differs from the original actor, key or completed return');
export type AdvancedExpeditionEnvelope=z.infer<typeof AdvancedExpeditionEnvelopeSchema>;
export function matchAdvancedExpeditionEnvelope(raw:unknown,wallet:string,original:AdvancedExpeditionRequest):AdvancedExpeditionEnvelope{
 const request=AdvancedExpeditionRequestSchema.parse(original),proof=AdvancedExpeditionEnvelopeSchema.parse(raw);
 if(proof.wallet!==wallet||proof.idempotencyKey!==request.idempotencyKey
  ||proof.status==='accepted'&&JSON.stringify(proof.receipt.request)!==JSON.stringify(request))throw Error('Expedition history differs from original command');
 return proof;
}
