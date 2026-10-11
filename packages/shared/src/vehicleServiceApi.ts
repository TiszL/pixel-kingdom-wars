/** Public original-actor service history. Parsed data never supplies
 * custody, signing, broadcast, finality or service authority. The private API
 * verifies message hashes and Ed25519; this contract binds shape and fields. */
import {z} from 'zod';
import {PhaseEVehicleMintIdentitySchema,PhaseEVehicleTierSchema} from './phaseEVehicles';
import {VehicleServiceStateSchema,vehicleServiceTransition} from './phaseEVehicleService';

const Uuid=z.uuid().regex(/^[0-9a-f-]+$/),Address=PhaseEVehicleMintIdentitySchema.shape.assetId;
const Key=z.string().min(1).max(128),Hash=z.string().regex(/^[0-9a-f]{64}$/);
const Integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),I64=(1n<<63n)-1n;
const isCounter=(v:string)=>/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=I64;
const Counter=z.string().max(19).refine(isCounter);
const Timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
 .refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const JournalTimestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
 .refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.slice(0,23)+'Z');
const base58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const Signature=z.string().min(64).max(88).refine(value=>{
 let decoded=0n;for(const character of value){const digit=base58.indexOf(character);if(digit<0)return false;decoded=decoded*58n+BigInt(digit);}
 let bytes=0;while(decoded){bytes++;decoded>>=8n;}return bytes+(value.match(/^1*/)?.[0].length??0)===64;
},'Expected a canonical 64-byte signature');
const base64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const Packet=z.string().min(88).max(1644).refine(value=>{
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return false;
 const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,bytes=value.length/4*3-padding;
 // Canonical base64 requires unused low bits to be zero, not merely padding.
 const last=base64.indexOf(value[value.length-padding-1]!);
 return bytes>=66&&bytes<=1232&&(padding===0||padding===1&&(last&3)===0||padding===2&&(last&15)===0);
},'Expected a canonical bounded signed packet');

export const VehicleServiceRequestSchema=z.object({installationId:Uuid,assetId:Address,
 operation:VehicleServiceStateSchema.shape.operation,idempotencyKey:Key}).strict();
export type VehicleServiceRequest=z.infer<typeof VehicleServiceRequestSchema>;
export const VehicleServiceSignedRequestSchema=z.object({signedTransaction:Packet}).strict();
export type VehicleServiceSignedRequest=z.infer<typeof VehicleServiceSignedRequestSchema>;
export const VehicleServiceIntentSchema=z.object({intentId:Uuid,wallet:Address,request:VehicleServiceRequestSchema,
 identity:PhaseEVehicleMintIdentitySchema,state:VehicleServiceStateSchema,reservedAt:JournalTimestamp}).strict()
 .refine(v=>v.intentId!==v.state.installationId&&v.request.installationId===v.state.installationId
  &&v.request.assetId===v.identity.assetId&&v.request.operation===v.state.operation
  &&v.identity.family===v.state.family&&v.identity.tier===v.state.tier,'Intent differs from original request or vehicle identity');
export type VehicleServiceIntent=z.infer<typeof VehicleServiceIntentSchema>;
export const VehicleServicePreparationSchema=z.object({messageHex:z.string().min(2).max(2334).regex(/^(?:[0-9a-f]{2})+$/),
 messageSha256:Hash,serviceSha256:Hash,blockhash:Address,blockhashContextSlot:Integer,lastValidBlockHeight:Integer,recordedAt:JournalTimestamp}).strict();
export type VehicleServicePreparation=z.infer<typeof VehicleServicePreparationSchema>;
export const VehicleServiceSignedSchema=z.object({signature:Signature,wireSha256:Hash,messageSha256:Hash,acceptedAt:JournalTimestamp}).strict();
export type VehicleServiceSigned=z.infer<typeof VehicleServiceSignedSchema>;
export const VehicleServiceApplicationSchema=z.object({tierAfter:PhaseEVehicleTierSchema,revisionAfter:Integer,
 completedTotal:Counter,allowanceStartAfter:Counter,remainingUses:Integer,appliedAt:JournalTimestamp,signature:Signature}).strict()
 .refine(v=>isCounter(v.completedTotal)&&isCounter(v.allowanceStartAfter)&&BigInt(v.allowanceStartAfter)<=BigInt(v.completedTotal),'Allowance cannot exceed actual lifetime completions');
export type VehicleServiceApplication=z.infer<typeof VehicleServiceApplicationSchema>;

const common={version:z.literal(1),purpose:z.literal('vehicle_service'),wallet:Address,idempotencyKey:Key,
 serverNow:Timestamp,intent:VehicleServiceIntentSchema,signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),
 reservationReleaseAuthorized:z.literal(false),serviceAuthorized:z.literal(false)};
export const VehicleServiceEnvelopeSchema=z.discriminatedUnion('status',[
 z.object({...common,status:z.literal('reserved'),preparation:z.null(),signed:z.null(),application:z.null()}).strict(),
 z.object({...common,status:z.literal('prepared'),preparation:VehicleServicePreparationSchema,signed:z.null(),application:z.null()}).strict(),
 z.object({...common,status:z.literal('signed'),preparation:VehicleServicePreparationSchema,signed:VehicleServiceSignedSchema,application:z.null()}).strict(),
 // Recovery may find finalized consent without a retained signed-wire row.
 z.object({...common,status:z.literal('applied'),preparation:VehicleServicePreparationSchema,signed:VehicleServiceSignedSchema.nullable(),application:VehicleServiceApplicationSchema}).strict(),
]).superRefine((v,ctx)=>{
 const reject=(message:string)=>ctx.addIssue({code:'custom',message});
 if(v.wallet!==v.intent.wallet||v.idempotencyKey!==v.intent.request.idempotencyKey)reject('History differs from original actor or key');
 if(v.signed&&v.signed.messageSha256!==v.preparation.messageSha256)reject('Signed consent differs from the original message');
 if(v.application){
  if(v.signed&&v.application.signature!==v.signed.signature)reject('Application differs from the retained signature');
  try{const effect=vehicleServiceTransition(v.intent.state),a=v.application;
   if(a.tierAfter!==effect.tierAfter||a.revisionAfter!==effect.revisionAfter||a.completedTotal!==effect.completedTotal
    ||a.allowanceStartAfter!==effect.allowanceStartAfter||a.remainingUses!==effect.remainingUses)reject('Application differs from the original shared transition');
  }catch{reject('Original service state is invalid');}
 }
});
export type VehicleServiceEnvelope=z.infer<typeof VehicleServiceEnvelopeSchema>;
export function matchVehicleServiceEnvelope(raw:unknown,wallet:string,original:unknown):VehicleServiceEnvelope{
 const request=VehicleServiceRequestSchema.parse(original),actor=Address.parse(wallet),saved=VehicleServiceEnvelopeSchema.parse(raw);
 if(saved.wallet!==actor||JSON.stringify(saved.intent.request)!==JSON.stringify(request))throw Error('Service history differs from original actor or command');
 return saved;
}
