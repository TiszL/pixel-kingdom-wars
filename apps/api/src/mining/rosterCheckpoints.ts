/** Prospective registered facts only. A later proof reader must independently
 * bind the event frontier and earning interval; capture grants no tax authority. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {MiningRosterHistoryError} from './rosterHistory';
const walletSchema=z.string().min(1).max(128);
export async function captureMiningRosterCheckpoint(db:Db,wallet:string):Promise<void>{
 if('rollback' in db)throw new MiningRosterHistoryError('INVALID_INPUT');
 if(!walletSchema.safeParse(wallet).success)throw new MiningRosterHistoryError('INVALID_INPUT');
 if(!phaseEMiningEnabled())throw new MiningRosterHistoryError('DISABLED');
 try{await db.transaction(async tx=>{
  if(!phaseEMiningEnabled())throw new MiningRosterHistoryError('DISABLED');
  // The owner-only guard supplies clock, snapshot and frontier after its barrier.
  // Repeating an unchanged roster retains the original observation verbatim.
  await tx.execute(sql`insert into public.mining_roster_checkpoints(wallet) values(${wallet}) on conflict(wallet,event_frontier) do nothing`);
  if(!phaseEMiningEnabled())throw new MiningRosterHistoryError('DISABLED');
 });}catch(error){
  let cause=error;
  for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
   if('code'in cause&&cause.code==='55P03')throw new MiningRosterHistoryError('BUSY');
   cause='cause'in cause?cause.cause:undefined;
  }
  throw error;
 }
}
