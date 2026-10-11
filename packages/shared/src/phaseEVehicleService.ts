/** D-153.132: owner-locked upgrade/exhaustion arithmetic only. A parsed snapshot
 * does not establish current revision, completed returns, idleness or admission. */
import {z} from 'zod';
import {PHASE_E_VEHICLES} from './constants';
import {PhaseEVehicleFamilySchema,PhaseEVehicleTierSchema} from './phaseEVehicles';
const I64=(1n<<63n)-1n;
const counter=(v:string)=>/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=I64;
const Counter=z.string().max(19).refine(counter),Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
export const VehicleServiceStateSchema=z.object({
 operation:z.enum(['upgrade','restore_uses']),installationId:Uuid,baseId:Uuid,berthId:Uuid,
 revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),
 family:PhaseEVehicleFamilySchema,tier:PhaseEVehicleTierSchema,completedTotal:Counter,allowanceStart:Counter,
}).strict().superRefine((v,ctx)=>{
 if(!counter(v.completedTotal)||!counter(v.allowanceStart))return;
 const used=BigInt(v.completedTotal)-BigInt(v.allowanceStart),limit=BigInt(PHASE_E_VEHICLES.completedUsesPerInstall);
 if(used<0n||used>limit||v.operation==='restore_uses'&&used!==limit
  ||v.operation==='upgrade'&&v.tier===PHASE_E_VEHICLES.tiers.at(-1))ctx.addIssue({code:'custom',message:'Service differs from the locked tier or exhaustion rule'});
});
export type VehicleServiceState=z.infer<typeof VehicleServiceStateSchema>;
export function vehicleServiceTransition(input:VehicleServiceState){
 const s=VehicleServiceStateSchema.parse(input),tierAfter=s.operation==='upgrade'?PHASE_E_VEHICLES.tiers[PHASE_E_VEHICLES.tiers.indexOf(s.tier)+1]:s.tier;
 if(tierAfter===undefined)throw Error('Vehicle tier cannot advance');
 const allowanceStartAfter=s.operation==='restore_uses'?s.completedTotal:s.allowanceStart;
 return Object.freeze({version:1 as const,...s,tierAfter,revisionAfter:s.revision+1,allowanceStartAfter,
  remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall-Number(BigInt(s.completedTotal)-BigInt(allowanceStartAfter)),serviceAuthorized:false as const});
}
