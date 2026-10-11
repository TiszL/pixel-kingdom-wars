/** Original-term prefix, under the original wallet mutex. Reads of other Mines
 * deliberately never acquire their base/Mine locks: a waiting writer leaves an
 * older visible clock, which conservatively holds rather than deadlocking. */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { readStoredExpeditionTerm } from '../game/expeditionTermStore';
import { SHARDS_TAX_LINEAGE } from './shardsTaxAttribution';
import { assertShardsObstacleTermPrefix } from './shardsTaxObstacleObligations';
const hold = () => { throw new HttpError(503, 'Mine tax held for earlier original earning', 'SHARDS_TAX_ORDER_HELD'); };
export async function assertMineTaxTermPrefix(db:DbOrTx,wallet:string,termId:string,termHash:string,
  issuing:ReadonlyMap<string,bigint>,captured:ReadonlyMap<string,Date>,plannedFloor?:{term_id:string;term_hash:string}) {
 const term=await readStoredExpeditionTerm(db,termId,termHash);if(!term)return hold();
 const start=Date.parse(term.snapshot.startsAt),end=Date.parse(term.snapshot.endsAt);
 await assertShardsObstacleTermPrefix(db,wallet,term.snapshot.startsAt);
 const [storedFloor]=await db.execute<{term_id:string;term_hash:string}>(sql`select term_id,term_hash from shards_tax_all_assessments where wallet=${wallet} and lineage=${SHARDS_TAX_LINEAGE} order by wallet_sequence desc limit 1`);
 const floor=plannedFloor??storedFloor;
 if(floor){const prior=await readStoredExpeditionTerm(db,floor.term_id,floor.term_hash);if(!prior)return hold();
  if(floor.term_id===termId){if(floor.term_hash!==termHash)return hold();}
  else if(Date.parse(prior.snapshot.endsAt)>start)return hold();
 }
 const pending=await db.execute<{id:string;pending:string;starts_at:Date;ends_at:Date;term_id:string|null;term_hash:string|null;recovery_parent_id:string|null}>(sql`select s.id,(s.buffer::numeric+s.reserved)::text pending,s.starts_at,s.ends_at,a.term_id,a.term_hash,to_jsonb(s)->>'recovery_parent_id' recovery_parent_id from shards_mine_segments s left join shards_mine_admissions a on a.id=s.admission_id where s.wallet=${wallet} and (s.buffer>0 or s.reserved>0)`);
 for(const p of pending){if(BigInt(p.pending)<=(issuing.get(p.id)??0n))continue;
  // Existing admitted-source readers need no access to private recovery tables.
  // A recovered pending child needs its independent immutable term reference.
  if(!p.term_id&&p.recovery_parent_id){const [recovered]=await db.execute<{term_id:string;term_hash:string}>(sql`select term_id,term_hash from shards_mine_resolution_terms where segment_id=${p.id} and parent_id=${p.recovery_parent_id}`);if(!recovered)return hold();p.term_id=recovered.term_id;p.term_hash=recovered.term_hash;}
  if(!p.term_id){if(+new Date(p.starts_at)<end)return hold();continue;}
  if(p.term_id===termId&&p.term_hash===termHash)continue;
  const other=await readStoredExpeditionTerm(db,p.term_id,p.term_hash!);if(!other||Date.parse(other.snapshot.startsAt)<end)return hold();
 }
 const lazy=await db.execute<{mine_id:string;last_accrual_at:Date}>(sql`select e.mine_id,m.last_accrual_at from shards_mine_eras e join bases b on b.id=e.base_id join mine_accrual_states m on m.mine_building_id=e.mine_id where b.owner_wallet=${wallet}`);
 for(const m of lazy)if(+new Date(m.last_accrual_at)<start&&+(captured.get(m.mine_id)??new Date(0))<start)return hold();
}
