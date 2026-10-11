/** Frozen raid presentation is an immutable original, never a current fleet read. */
import {BuildingType} from '@shardkeep/shared';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';

const Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
export const RaidStarterPresentationSchema=z.object({version:z.literal(1),berths:z.array(z.object({
 buildingId:Uuid,installation:z.object({family:z.literal('starter'),presence:z.enum(['occupied','away'])}).strict().nullable(),
}).strict())}).strict().superRefine((value,context)=>{
 if(value.berths.some((berth,index)=>index>0&&value.berths[index-1]!.buildingId>=berth.buildingId))
  context.addIssue({code:'custom',message:'Frozen berth identities must be sorted and unique'});
 if(value.berths.filter(berth=>berth.installation!==null).length>1)
  context.addIssue({code:'custom',message:'One supported starter installation per base'});
});
export type RaidStarterPresentation=z.infer<typeof RaidStarterPresentationSchema>;
const FrozenBuildings=z.object({buildings:z.array(z.object({id:Uuid,type:z.string(),level:z.number().int().nonnegative(),
 underConstruction:z.boolean().optional()}).passthrough())}).passthrough();
export function parseRaidStarterPresentation(value:unknown,snapshot:unknown):RaidStarterPresentation|null|undefined{
 if(value===undefined||value===null)return value;
 const presentation=RaidStarterPresentationSchema.parse(value),buildings=FrozenBuildings.parse(snapshot).buildings;
 if(new Set(buildings.map(b=>b.id)).size!==buildings.length)throw Error('Duplicate frozen building identity');
 const berths=buildings.filter(b=>b.type===BuildingType.Berth).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 if(berths.length!==presentation.berths.length||berths.some((b,index)=>b.id!==presentation.berths[index]!.buildingId
  ||b.underConstruction===true||(presentation.berths[index]!.installation!==null&&b.level<1)))
  throw Error('Frozen starter presentation differs from its snapshot');
 return presentation;
}
const Capture=z.object({version:z.literal(1),presentation:RaidStarterPresentationSchema.nullable()}).strict();
export async function readRaidStarterPresentation(db:DbOrTx,raidId:string,snapshot:unknown):Promise<RaidStarterPresentation|null|undefined>{
 Uuid.parse(raidId);
 const [capability]=await db.execute<{ready:boolean}>(sql`select to_regprocedure('public.shardkeep_raid_starter_presentation(uuid)') is not null ready`);
 if(!capability?.ready)throw new HttpError(503,'Frozen fleet presentation is unavailable','RAID_STARTER_SOURCE');
 const [row]=await db.execute<{capture:unknown}>(sql`select public.shardkeep_raid_starter_presentation(${raidId}::uuid) capture`);
 if(row?.capture===null)return undefined;
 return parseRaidStarterPresentation(Capture.parse(row?.capture).presentation,snapshot);
}
export async function raidStarterFields(db:DbOrTx,raidId:string,snapshot:unknown):Promise<{servicePresentation?:RaidStarterPresentation|null}>{
 const servicePresentation=await readRaidStarterPresentation(db,raidId,snapshot);
 return servicePresentation===undefined?{}:{servicePresentation};
}
