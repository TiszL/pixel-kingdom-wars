/** Redacted current-owner advanced fleet observations, separate from starter
 * installations and original-actor service history. Neither a parsed shape,
 * the admission hint nor elapsed wall time grants action or custody authority. */
import {z} from 'zod';
import {PHASE_E_VEHICLES} from './constants';
import {PhaseEVehicleFamilySchema,PhaseEVehicleMintIdentitySchema,PhaseEVehicleTierSchema} from './phaseEVehicles';

const Uuid=z.uuid().regex(/^[0-9a-f-]+$/),Wallet=PhaseEVehicleMintIdentitySchema.shape.assetId;
const I64=(1n<<63n)-1n,isCounter=(v:string)=>/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=I64;
const Counter=z.string().max(19).refine(isCounter);
const Timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
 .refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);

export const AdvancedFleetRequestSchema=z.object({baseId:Uuid}).strict();
export type AdvancedFleetRequest=z.infer<typeof AdvancedFleetRequestSchema>;
export const AdvancedFleetVehicleSchema=z.object({installationId:Uuid,berthId:Uuid,family:PhaseEVehicleFamilySchema,
 tier:PhaseEVehicleTierSchema,revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),
 completedTotal:Counter,allowanceStart:Counter,remainingUses:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 away:z.boolean(),pendingService:z.boolean()}).strict().superRefine((v,ctx)=>{
 if(!isCounter(v.completedTotal)||!isCounter(v.allowanceStart))return;
 const used=BigInt(v.completedTotal)-BigInt(v.allowanceStart),limit=BigInt(PHASE_E_VEHICLES.completedUsesPerInstall);
 if(used<0n||used>limit||v.remainingUses!==Number(limit-used))ctx.addIssue({code:'custom',message:'Remaining uses differ from actual lifetime completions and allowance'});
});
export type AdvancedFleetVehicle=z.infer<typeof AdvancedFleetVehicleSchema>;
export const AdvancedFleetEnvelopeSchema=z.object({version:z.literal(1),wallet:Wallet,baseId:Uuid,serverNow:Timestamp,
 acceptingNewActions:z.boolean(),vehicles:z.array(AdvancedFleetVehicleSchema).max(PHASE_E_VEHICLES.advancedFamilyCount)}).strict()
 .refine(v=>new Set(v.vehicles.map(row=>row.installationId)).size===v.vehicles.length
  &&new Set(v.vehicles.map(row=>row.berthId)).size===v.vehicles.length
  &&new Set(v.vehicles.map(row=>row.family)).size===v.vehicles.length,'Fleet repeats an installation, berth or family');
export type AdvancedFleetEnvelope=z.infer<typeof AdvancedFleetEnvelopeSchema>;
export function matchAdvancedFleetEnvelope(raw:unknown,wallet:string,baseId:string):AdvancedFleetEnvelope{
 const actor=Wallet.parse(wallet),request=AdvancedFleetRequestSchema.parse({baseId}),saved=AdvancedFleetEnvelopeSchema.parse(raw);
 if(saved.wallet!==actor||saved.baseId!==request.baseId)throw Error('Fleet differs from the requested wallet or base');
 return saved;
}
