import {readStarterEquipmentEvidence} from './starterEquipmentEvidence';
/** D153.189 one bounded companion output, inseparable from its actual trip.
 * Callers own the original base lock. No separate claim or return authority. */
import {sql} from 'drizzle-orm';
import {EquipmentSecondaryOutputSchema,type EquipmentSecondaryOutput} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import type {DbOrTx,DbTx} from '../db/client';
type Kind='starter'|'advanced';
type Source={base_id:string;term_id:string;term_hash:string;resource_id:string;gross:string;net:string;tax:string};
export async function createEquipmentSecondary(tx:DbTx,kind:Kind,id:string){
 await tx.execute(sql`insert into ordinary_equipment_secondary_outputs(trip_kind,expedition_id,base_id,term_id,term_hash,resource_id,gross,net,tax)
  select ${kind},id,base_id,term_id,term_hash,route_snapshot->'secondaryOutput'->>'resourceId',(route_snapshot->'secondaryOutput'->>'grossQuantity')::bigint,
   (route_snapshot->'secondaryOutput'->>'netQuantity')::bigint,(route_snapshot->'secondaryOutput'->>'islandPoolQuantity')::bigint
  from ${sql.identifier(kind+'_expeditions')} where id=${id} and route_snapshot->'fitting'->>'itemId'='survey_lens'`);
}
export async function readEquipmentSecondary(db:DbOrTx,kind:Kind,id:string,expected?:EquipmentSecondaryOutput){
 if(!expected)return null;
 const saved=kind==='starter'?await readStarterEquipmentEvidence(db,id):null;
 const rows=saved?(saved.secondary?[saved.secondary]:[]):await db.execute<Source>(sql`select base_id,term_id,term_hash,resource_id,gross::text,net::text,tax::text from ordinary_equipment_secondary_outputs where trip_kind=${kind} and expedition_id=${id}`);
 if(!expected){if(rows.length)throw Error('Unexpected equipment companion output');return null;}
 const s=rows[0];if(!s||rows.length!==1)throw Error('Original equipment companion output is missing');
 const output=EquipmentSecondaryOutputSchema.parse({resourceId:s.resource_id,grossQuantity:s.gross,netQuantity:s.net,islandPoolQuantity:s.tax});
 if(JSON.stringify(output)!==JSON.stringify(expected))throw Error('Original equipment companion output differs');
 return {...s,output};
}
export async function lockEquipmentReturnStocks(tx:DbTx,baseId:string,primary:string,secondary?:EquipmentSecondaryOutput){
 for(const resourceId of [primary,...secondary?[secondary.resourceId]:[]].sort()){
  await tx.execute(sql`insert into resource_stocks(base_id,resource_id) values(${baseId},${resourceId}) on conflict do nothing`);
  await tx.execute(sql`select resource_id from resource_stocks where base_id=${baseId} and resource_id=${resourceId} for update`);
 }
}
export async function settleEquipmentSecondary(tx:DbTx,kind:Kind,id:string,returnId:string,output?:EquipmentSecondaryOutput){
 if(!output)return;
 await tx.execute(sql`insert into ordinary_equipment_secondary_returns(trip_kind,expedition_id,return_id) values(${kind},${id},${returnId})`);
 for(const [bucket,delta] of [['issued',-BigInt(output.grossQuantity)],['base_stock',BigInt(output.netQuantity)],['island_pool',BigInt(output.islandPoolQuantity)]] as const)
  await tx.execute(sql`insert into ordinary_equipment_secondary_entries(trip_kind,expedition_id,bucket,delta) values(${kind},${id},${bucket},${delta.toString()}::bigint)`);
}
export async function readEquipmentSecondaryReturn(db:DbOrTx,kind:Kind,id:string,returnId:string,output?:EquipmentSecondaryOutput){
 if(!output)return undefined;
 const saved=kind==='starter'?await readStarterEquipmentEvidence(db,id):null;
 const rows=saved?(saved.secondaryReturn?[saved.secondaryReturn]:[]):await db.execute<{return_id:string;stock_before:string;stock_after:string}>(sql`select return_id,stock_before::text,stock_after::text from ordinary_equipment_secondary_returns where trip_kind=${kind} and expedition_id=${id}`);
 if(!output){if(rows.length)throw Error('Unexpected equipment companion return');return undefined;}
 const r=rows[0],entries=saved?saved.entries:await db.execute<{bucket:string;delta:string}>(sql`select bucket,delta::text from ordinary_equipment_secondary_entries where trip_kind=${kind} and expedition_id=${id}`);
 const expected=[['issued',-BigInt(output.grossQuantity)],['base_stock',BigInt(output.netQuantity)],['island_pool',BigInt(output.islandPoolQuantity)]] as const;
 if(rows.length!==1||!r||r.return_id!==returnId||BigInt(r.stock_after)-BigInt(r.stock_before)!==BigInt(output.netQuantity)||entries.length!==3
  ||expected.some(([bucket,delta])=>!entries.some(e=>e.bucket===bucket&&BigInt(e.delta)===delta)))throw Error('Original equipment companion return differs');
 return output;
}
