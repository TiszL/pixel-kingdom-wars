/** Explicit prospective source activation; never called by gameplay or a collector. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db,DbOrTx } from '../db/client';
import { phaseEMiningEnabled } from '../config';
export interface MiningDevelopmentBaseline {
 baseId:string;observedAt:string;effectiveFrom:string;baseState:Record<string,unknown>;
 buildings:Record<string,unknown>[];jobs:Record<string,unknown>[];
}
export class MiningDevelopmentHistoryError extends Error {
 constructor(readonly code:'INVALID_INPUT'|'DISABLED'|'BUSY'){super(`Mining development history refused: ${code}`);this.name='MiningDevelopmentHistoryError';}
}
const iso=(value:unknown)=>new Date(String(value)).toISOString();
async function existing(db:DbOrTx,baseId:string):Promise<MiningDevelopmentBaseline|null>{
 const [row]=await db.execute<{base_id:string;observed_at:unknown;effective_from:unknown;base_state:Record<string,unknown>;buildings:Record<string,unknown>[];jobs:Record<string,unknown>[]}>(sql`select * from mining_development_baselines where base_id=${baseId}::uuid`);
 return row?{baseId:row.base_id,observedAt:iso(row.observed_at),effectiveFrom:iso(row.effective_from),baseState:row.base_state,buildings:row.buildings,jobs:row.jobs}:null;
}
/** The DB owner guard snapshots exact sources and enables dormant triggers under
 * the same NOWAIT barrier/transaction. No supplied timestamps or source JSON. */
export async function initializeMiningDevelopmentHistory(db:Db,baseId:string):Promise<MiningDevelopmentBaseline>{
 if(!z.uuid().safeParse(baseId).success)throw new MiningDevelopmentHistoryError('INVALID_INPUT');
 const prior=await existing(db,baseId);if(prior)return prior;
 if(!phaseEMiningEnabled())throw new MiningDevelopmentHistoryError('DISABLED');
 try{return await db.transaction(async tx=>{
  const duplicate=await existing(tx,baseId);if(duplicate)return duplicate;
  if(!phaseEMiningEnabled())throw new MiningDevelopmentHistoryError('DISABLED');
  await tx.execute(sql`insert into mining_development_baselines(base_id) values(${baseId}::uuid)`);
  return (await existing(tx,baseId))!;
 });}catch(error){const e=error as {code?:string;cause?:{code?:string}};if(e.code==='55P03'||e.cause?.code==='55P03')throw new MiningDevelopmentHistoryError('BUSY');throw error;}
}
