/** Prospective zero-paid-origin proof only; no fungible-lot or spend score. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db,DbOrTx } from '../db/client';
import { phaseEMiningEnabled } from '../config';
type Code='INVALID_INPUT'|'DISABLED'|'BUSY'|'DAY_OPEN'|'COVERAGE_UNAVAILABLE'|'SOURCE_UNAVAILABLE'|'TOO_LARGE';
export class FreeGemsEvidenceError extends Error {
 constructor(readonly code:Code){super(`Free Gems evidence refused: ${code}`);this.name='FreeGemsEvidenceError';}
}
function fail(code:Code):never{throw new FreeGemsEvidenceError(code);}
const iso=(v:unknown)=>{const n=typeof v==='string'||v instanceof Date?new Date(v).getTime():NaN;if(!Number.isFinite(n))return fail('SOURCE_UNAVAILABLE');return new Date(n).toISOString();};
const walletSchema=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const positive=z.string().max(20).regex(/^[1-9][0-9]*$/),integer=z.string().max(21).regex(/^-?(0|[1-9][0-9]*)$/);
const account=z.object({id:z.uuid(),kind:z.string(),currency:z.string(),wallet:z.string().nullable(),baseId:z.uuid().nullable()}).strict();
const sourceSchema=z.object({
 entry:z.object({id:positive,txnId:z.uuid(),accountId:z.uuid(),delta:positive}).strict(),account,
 transaction:z.object({id:z.uuid(),key:z.string(),type:z.string(),metadata:z.record(z.string(),z.unknown()),createdAt:z.string()}).strict(),
}).strict();
const receiptSchema=z.array(z.object({id:positive,accountId:z.uuid(),delta:integer,kind:z.string(),currency:z.string(),wallet:z.string().nullable(),baseId:z.uuid().nullable()}).strict()).length(4);
function canonicalGrant(source:z.infer<typeof sourceSchema>,raw:unknown):boolean{
 const parsed=receiptSchema.safeParse(raw);if(!parsed.success)return false;
 const {transaction:t,entry:e,account:a}=source,m=t.metadata,g=e.delta;
 if(m['wallet']!==a.wallet||m['gems']!==g)return false;
 const reason=m['reason'],ref=m['ref'];
 const key=reason==='welcome'||reason==='dev'?`grant:${reason}:${a.wallet}`
  :reason==='task'&&typeof ref==='string'&&ref.length?`grant:task:${ref}:${a.wallet}`
  :reason==='refund'&&typeof ref==='string'&&ref.length?`grant:refund:${ref}`:null;
 if(t.key!==key||new Set(parsed.data.map(r=>r.id)).size!==4||new Set(parsed.data.map(r=>r.accountId)).size!==4)return false;
 const has=(kind:string,currency:string,delta:string,wallet:string|null)=>parsed.data.some(r=>r.kind===kind&&r.currency===currency&&r.delta===delta&&r.wallet===wallet&&r.baseId===null);
 return parsed.data.some(r=>r.id===e.id&&r.accountId===a.id&&r.delta===g&&r.kind==='player_gems'&&r.wallet===a.wallet)
  &&has('player_gems','GEMS',g,a.wallet)&&has('gems_mint','GEMS',`-${g}`,null)
  &&has('gems_reward_budget','KEEP',`-${g}`,null)&&has('emission_pool','KEEP',g,null);
}
function busy(error:unknown):never{const e=error as {code?:string;cause?:{code?:string}};if(e.code==='55P03'||e.cause?.code==='55P03')return fail('BUSY');throw error;}
export async function initializeFreeGemsEvidence(db:Db):Promise<void>{
 const prior=await db.execute(sql`select id from mining_free_gems_coverage where id`);if(prior.length)return;
 if(!phaseEMiningEnabled())return fail('DISABLED');
 try{await db.transaction(async tx=>{await tx.execute(sql`insert into mining_free_gems_coverage(id) values(true) on conflict do nothing`);});}catch(error){busy(error);}
}
export interface FreeGemsEvidence {
 wallet:string;day:string;coverageStartedAt:string;birthEventId:string;originIds:string[];
 zeroQualifyingCredit:boolean;reason:'zero'|'paid-origin';allocationReady:false;publicationAuthorized:false;
}
export async function readFreeGemsEvidence(db:DbOrTx,input:unknown):Promise<FreeGemsEvidence>{
 const parsed=z.object({wallet:walletSchema,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict().safeParse(input);
 if(!parsed.success)return fail('INVALID_INPUT');
 const {wallet,day}=parsed.data,start=Date.parse(`${day}T00:00:00Z`);
 if(!Number.isFinite(start)||new Date(start).toISOString().slice(0,10)!==day)return fail('INVALID_INPUT');
 const end=new Date(start+86_400_000).toISOString();
 try{return await db.transaction(async tx=>{
  await tx.execute(sql`lock table players,accounts,ledger_transactions,ledger_entries,mining_free_coverage,mining_free_cohort_events,mining_free_gems_coverage,mining_free_gems_origins in share mode nowait`);
  const [clock]=await tx.execute<{closed:boolean;isolation:string}>(sql`select public.shardkeep_mining_free_clock()>=${end}::timestamptz as closed,current_setting('transaction_isolation') as isolation`);
  if(clock?.isolation!=='read committed')return fail('SOURCE_UNAVAILABLE');if(clock.closed!==true)return fail('DAY_OPEN');
  const [coverage]=await tx.execute<{started_at:unknown}>(sql`select started_at from mining_free_gems_coverage where id`);if(!coverage)return fail('COVERAGE_UNAVAILABLE');
  const coverageStartedAt=iso(coverage.started_at);
  // All authority comparisons stay in PostgreSQL's full timestamp precision.
  // Display ISO milliseconds must never promote a pre-coverage birth to valid.
  const births=await tx.execute<{id:string;operation:string;after_state:{wallet?:unknown;created_at?:unknown}|null;timing_valid:boolean}>(sql`
   select e.id::text,e.operation,e.after_state,
    (c.started_at<=e.observed_at and c.started_at<=(e.after_state->>'created_at')::timestamptz
     and (e.after_state->>'created_at')::timestamptz<=e.observed_at
     and e.observed_at<=${new Date(start).toISOString()}::timestamptz) is true as timing_valid
   from mining_free_cohort_events e cross join mining_free_gems_coverage c
   where c.id and e.wallet=${wallet} and e.source_table='players' and e.observed_at<${end}::timestamptz order by e.id limit 2`);
  const birth=births[0];
  if(births.length!==1||!birth||birth.operation!=='INSERT'||birth.after_state?.wallet!==wallet||birth.timing_valid!==true)return fail('COVERAGE_UNAVAILABLE');
  const origins=await tx.execute<{id:string;ledger_entry_id:string;source:unknown;receipt:unknown;after_birth:boolean}>(sql`
   select o.id::text,o.ledger_entry_id::text,o.source,o.receipt,(o.observed_at>=b.observed_at) as after_birth
   from mining_free_gems_origins o cross join mining_free_cohort_events b
   where b.id=${birth.id}::bigint and o.wallet=${wallet} and o.observed_at<${end}::timestamptz order by o.observed_at,o.id limit 10001`);
  if(origins.length>10_000)return fail('TOO_LARGE');let paid=false;
  for(const row of origins){
   const original=sourceSchema.safeParse(row.source);if(!original.success)return fail('SOURCE_UNAVAILABLE');
   const s=original.data;
   if(s.entry.id!==row.ledger_entry_id||s.entry.txnId!==s.transaction.id||s.entry.accountId!==s.account.id||s.account.wallet!==wallet
    ||s.account.kind!=='player_gems'||s.account.currency!=='GEMS'||s.account.baseId!==null||row.after_birth!==true)return fail('SOURCE_UNAVAILABLE');
   if(['gems.from_keep','gems.buy','gems.late_credit'].includes(s.transaction.type))paid=true;
   else if(s.transaction.type!=='gems.grant'||!canonicalGrant(s,row.receipt))return fail('SOURCE_UNAVAILABLE');
  }
  return {wallet,day,coverageStartedAt,birthEventId:birth.id,originIds:origins.map(r=>r.id),zeroQualifyingCredit:!paid,reason:paid?'paid-origin':'zero',allocationReady:false,publicationAuthorized:false};
 });}catch(error){return busy(error);}
}
