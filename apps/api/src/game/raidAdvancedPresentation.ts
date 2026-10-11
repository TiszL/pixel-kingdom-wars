/** Immutable prospective facts. SQL owns originals; TS owns the versioned art mapping. */
import {BuildingType,RAID_ADVANCED_PRESENTATION_V1} from '@shardkeep/shared';
import {PhaseEVehicleFamilySchema,PhaseEVehicleTierSchema} from '@shardkeep/shared/phaseEVehicles';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DbOrTx,DbTx} from '../db/client';
import {HttpError} from '../lib/errors';
const Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const Installation=z.object({family:PhaseEVehicleFamilySchema,tier:PhaseEVehicleTierSchema,presence:z.enum(['occupied','away','exhausted'])}).strict();
export const RaidAdvancedPresentationSchema=z.object({version:z.literal(1),berths:z.array(z.object({buildingId:Uuid,installation:Installation.nullable()}).strict())}).strict().superRefine((value,ctx)=>{
 if(value.berths.some((b,i)=>i>0&&value.berths[i-1]!.buildingId>=b.buildingId))ctx.addIssue({code:'custom',message:'Sorted unique frozen berths required'});
 const families=value.berths.flatMap(b=>b.installation?[b.installation.family]:[]);
 if(new Set(families).size!==families.length)ctx.addIssue({code:'custom',message:'Unique installed family required'});
});
export type RaidAdvancedPresentation=z.infer<typeof RaidAdvancedPresentationSchema>;
const FrozenBuildings=z.object({buildings:z.array(z.object({id:Uuid,type:z.string(),level:z.number().int().nonnegative(),underConstruction:z.boolean().optional()}).passthrough())}).passthrough();
export function parseRaidAdvancedPresentation(value:unknown,snapshot:unknown):RaidAdvancedPresentation|null|undefined{
 if(value===undefined||value===null)return value;
 const presentation=RaidAdvancedPresentationSchema.parse(value),buildings=FrozenBuildings.parse(snapshot).buildings;
 if(new Set(buildings.map(b=>b.id)).size!==buildings.length)throw Error('Duplicate frozen building identity');
 const berths=buildings.filter(b=>b.type===BuildingType.Berth).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 if(berths.length!==presentation.berths.length||berths.some((b,i)=>b.id!==presentation.berths[i]!.buildingId||b.underConstruction===true||(presentation.berths[i]!.installation!==null&&b.level<1)))throw Error('Frozen advanced presentation differs from its snapshot');
 return presentation;
}
const Counter=z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<=(1n<<63n)-1n);
const Facts=z.object({version:z.literal(1),berths:z.array(z.object({buildingId:Uuid,installation:z.object({family:PhaseEVehicleFamilySchema,tier:PhaseEVehicleTierSchema,away:z.boolean(),completedTotal:Counter,allowanceStart:Counter}).strict().nullable()}).strict())}).strict();
const Capture=z.object({version:z.literal(1),facts:Facts.nullable(),sourceSha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export function parseRaidAdvancedCapture(value:unknown,snapshot:unknown){
 const capture=Capture.parse(value);
 const presentation=capture.facts===null?null:{version:1,berths:capture.facts.berths.map(b=>{
  if(b.installation===null)return {...b,installation:null};
  const {family,tier,away,completedTotal,allowanceStart}=b.installation,used=BigInt(completedTotal)-BigInt(allowanceStart);
  if(used<0n||used>BigInt(RAID_ADVANCED_PRESENTATION_V1.completedUsesPerInstall))throw Error('Invalid frozen advanced allowance');
  return {buildingId:b.buildingId,installation:{family,tier,presence:away?'away':used===BigInt(RAID_ADVANCED_PRESENTATION_V1.completedUsesPerInstall)?'exhausted':'occupied'}};
 })};
 return {presentation:parseRaidAdvancedPresentation(presentation,snapshot)!,sourceSha256:capture.sourceSha256};
}
export async function readRaidAdvancedCandidate(tx:DbTx,baseId:string,snapshot:unknown,cutoff:Date){
 Uuid.parse(baseId);if(!('rollback'in tx))throw Error('Frozen advanced candidate requires transaction');
 const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_raid_advanced_candidate(${baseId}::uuid,${JSON.stringify(snapshot)}::jsonb,${cutoff.toISOString()}::timestamptz) value`);
 return parseRaidAdvancedCapture(row?.value,snapshot);
}
export async function readRaidAdvancedCapture(db:DbOrTx,raidId:string,snapshot:unknown){
 Uuid.parse(raidId);
 const [capability]=await db.execute<{ready:boolean}>(sql`select to_regprocedure('public.shardkeep_raid_advanced_presentation(uuid)') is not null ready`);
 if(!capability?.ready)throw new HttpError(503,'Frozen advanced presentation is unavailable','RAID_ADVANCED_SOURCE');
 const [row]=await db.execute<{value:unknown}>(sql`select public.shardkeep_raid_advanced_presentation(${raidId}::uuid) value`);
 return row?.value===null?undefined:parseRaidAdvancedCapture(row?.value,snapshot);
}
export async function raidAdvancedFields(db:DbOrTx,raidId:string,snapshot:unknown):Promise<{advancedServicePresentation?:RaidAdvancedPresentation|null}>{
 const capture=await readRaidAdvancedCapture(db,raidId,snapshot);
 return capture===undefined?{}:{advancedServicePresentation:capture.presentation};
}
