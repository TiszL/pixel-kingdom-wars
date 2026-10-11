/** D-153.142 private current state under the installation mutex. This projection
 * is for new actions only; saved consent and trip readers retain original state. */
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import {PhaseEVehicleFamilySchema,PhaseEVehicleTierSchema} from '@shardkeep/shared/phaseEVehicles';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DbTx} from '../db/client';
import {HttpError} from '../lib/errors';

const uuid=z.uuid().regex(/^[0-9a-f-]+$/),i64=(1n<<63n)-1n;
const counter=z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).refine(v=>{try{return BigInt(v)<=i64;}catch{return false;}});
const instant=z.string().datetime({precision:6}).refine(v=>{const at=new Date(v);return Number.isFinite(+at)&&at.toISOString()===v.slice(0,23)+'Z';});
const Row=z.object({installation_id:uuid,base_id:uuid,berth_id:uuid,berth_completed_at:instant,
 family:PhaseEVehicleFamilySchema,tier:PhaseEVehicleTierSchema,revision:counter,completed_total:counter,
 allowance_start:counter,pending_intent_id:uuid.nullable(),away:z.boolean()}).strict();
export interface VehicleLifecycle {
 readonly installationId:string;readonly baseId:string;readonly berthId:string;readonly berthCompletedAt:string;
 readonly family:z.infer<typeof PhaseEVehicleFamilySchema>;readonly tier:z.infer<typeof PhaseEVehicleTierSchema>;
 readonly revision:number;readonly completedTotal:bigint;readonly allowanceStart:bigint;
 readonly pendingIntentId:string|null;readonly away:boolean;
}
const fail=(code:string):never=>{throw new HttpError(503,code,code);};
export async function readLockedVehicleLifecycle(tx:DbTx,installationId:string):Promise<Readonly<VehicleLifecycle>|null>{
 if(!('rollback'in tx))fail('VEHICLE_LIFECYCLE_TRANSACTION');
 const id=uuid.parse(installationId);
 // SQL checks the actual owner and READ COMMITTED, locks the stable0207 row
 // NOWAIT, then validates the complete application/return graph afresh.
 const rows=await tx.execute<Record<string,unknown>>(sql`select installation_id,base_id,berth_id,
  to_char(berth_completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') berth_completed_at,
  family,tier,revision::text,completed_total::text,allowance_start::text,pending_intent_id,away
  from public.shardkeep_vehicle_lifecycle(${id}::uuid)`);
 if(rows.length===0)return null;
 const parsed=Row.safeParse(rows[0]);if(rows.length!==1||!parsed.success)fail('VEHICLE_LIFECYCLE_SOURCE');
 const row=parsed.data!,revision=BigInt(row.revision),completedTotal=BigInt(row.completed_total),allowanceStart=BigInt(row.allowance_start),used=completedTotal-allowanceStart;
 if(row.installation_id!==id||revision>BigInt(Number.MAX_SAFE_INTEGER-1)||used<0n||used>BigInt(PHASE_E_VEHICLES.completedUsesPerInstall))fail('VEHICLE_LIFECYCLE_SOURCE');
 return Object.freeze({installationId:row.installation_id,baseId:row.base_id,berthId:row.berth_id,berthCompletedAt:row.berth_completed_at,
  family:row.family,tier:row.tier,revision:Number(revision),completedTotal,allowanceStart,pendingIntentId:row.pending_intent_id,away:row.away});
}
