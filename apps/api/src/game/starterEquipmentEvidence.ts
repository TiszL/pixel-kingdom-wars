/** Exact saved starter proof only. No private inventory or job projection.
 * Public adapters still authenticate the original actor/current base first. */
import {sql} from 'drizzle-orm';
import type {DbOrTx} from '../db/client';
type Secondary={base_id:string;term_id:string;term_hash:string;resource_id:string;gross:string;net:string;tax:string};
export type StarterEquipmentEvidence={reservation:{base_id:string;fitting_snapshot:unknown};release:{return_id:string}|null;secondary:Secondary|null;
 secondaryReturn:{return_id:string;stock_before:string;stock_after:string}|null;entries:{bucket:string;delta:string}[]};
export async function readStarterEquipmentEvidence(db:DbOrTx,id:string){
 const [row]=await db.execute<{evidence:StarterEquipmentEvidence}>(sql`select public.shardkeep_starter_equipment_evidence(${id}::uuid) evidence`);
 if(!row?.evidence)throw Error('Original starter equipment evidence is missing');return row.evidence;
}
