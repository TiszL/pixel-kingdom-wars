/** Current optional animation evidence only. Never attach to frozen snapshots. */
import {BuildingType,PHASE_E_ORDINARY_CRAFTING} from '@shardkeep/shared';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DbTx} from '../db/client';
const Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const Service=z.object({buildingId:Uuid,state:z.enum(['idle','working'])}).strict();
const Wire=z.object({version:z.literal(1),services:z.array(Service)}).strict();
export type ServiceActivity=z.infer<typeof Wire>;
const Internal=Wire.safeExtend({pendingCount:z.number().int().nonnegative()});
const Buildings=z.array(z.object({id:Uuid,type:z.string(),level:z.number().int().nonnegative(),underConstruction:z.boolean().optional()}).passthrough());
const kinds=new Set<string>([BuildingType.Workshop,BuildingType.Lodge,BuildingType.Market,BuildingType.Harvester]);
export function parseServiceActivity(value:unknown,buildings:unknown):ServiceActivity|null{
 if(value===null)return null;
 const parsed=Internal.parse(value),services=Buildings.parse(buildings).filter(b=>kinds.has(b.type)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 if(parsed.pendingCount>PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase)return null;
 if(new Set(services.map(b=>b.id)).size!==services.length||parsed.services.length!==services.length||parsed.services.some((s,i)=>{
  const b=services[i]!;return s.buildingId!==b.id||s.state==='working'&&(b.type!==BuildingType.Workshop||b.underConstruction===true||b.level<1);
 }))throw Error('Invalid current service activity closure');
 return {version:1,services:parsed.services};
}
export async function readServiceActivity(tx:DbTx,wallet:string,baseId:string,buildings:unknown,cutoff:Date):Promise<ServiceActivity|null>{
 if(!('rollback'in tx))throw Error('Service activity requires the protected base transaction');
 Uuid.parse(baseId);if(!Number.isFinite(+cutoff))throw Error('Invalid service activity cutoff');
 const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_service_activity(${wallet},${baseId}::uuid,${JSON.stringify(buildings)}::jsonb,${cutoff.toISOString()}::timestamptz) value`);
 return parseServiceActivity(row?.value,buildings);
}
