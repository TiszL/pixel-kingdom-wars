/** Complete prospective ledger facts, never a fungible-origin or useful-use score. */
import { GEMS } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { phaseEMiningEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
type Code = 'INVALID_INPUT' | 'DISABLED' | 'BUSY' | 'DAY_OPEN' | 'COVERAGE_UNAVAILABLE' | 'SOURCE_UNAVAILABLE' | 'TOO_LARGE';
export class GemsFlowEvidenceError extends Error {
 constructor(readonly code: Code) { super(`Gems flow evidence refused: ${code}`); this.name = 'GemsFlowEvidenceError'; }
}
function fail(code: Code): never { throw new GemsFlowEvidenceError(code); }
function busy(error: unknown): never { const e = error as { code?: string; cause?: { code?: string } }; if (e.code === '55P03' || e.cause?.code === '55P03') return fail('BUSY'); throw error; }
const walletSchema = z.string().min(32).max(44).refine(value => { if (value.length < 32 || value.length > 44) return false; try { return new PublicKey(value).toBase58() === value; } catch { return false; } });
const integer = z.string().max(21).regex(/^-?(0|[1-9][0-9]*)$/), positive = z.string().max(20).regex(/^[1-9][0-9]*$/);
const sourceSchema = z.object({
 entry: z.object({ id: positive, txnId: z.uuid(), accountId: z.uuid(), delta: integer }).strict(),
 account: z.object({ id: z.uuid(), kind: z.string(), currency: z.string(), wallet: z.string().nullable(), baseId: z.uuid().nullable() }).strict(),
 transaction: z.object({ id: z.uuid(), key: z.string(), type: z.string(), metadata: z.record(z.string(), z.unknown()), createdAt: z.string() }).strict(),
}).strict();
const receiptSchema = z.array(z.object({ id: positive, accountId: z.uuid(), delta: integer, kind: z.string(), currency: z.string(), wallet: z.string().nullable(), baseId: z.uuid().nullable() }).strict()).max(32);
type Classification = 'account-created' | 'source-mutation' | 'custodial-conversion' | 'wallet-conversion-ledger' | 'grant' | 'system-spend' | 'sink-refund' | 'excluded-gems-to-shards' | 'unclassified';
export interface GemsFlowFact {
 id: string; observedAt: string; effectiveObservedAt: string; transactionMarker: string; sourceTable: 'accounts' | 'ledger_transactions' | 'ledger_entries'; sourceId: string;
 operation: 'INSERT' | 'UPDATE' | 'DELETE'; accountId: string | null; transactionId: string | null;
 classification: Classification; source: unknown; before: unknown; receipt: unknown;
}
export interface GemsFlowEvidence {
 version: 1; sourcePolicyVersion: 1; transactionVisibility: 'whole-db-transaction-at-last-observation'; wallet: string; day: string; coverageStartedAt: string; birthEventId: string; facts: GemsFlowFact[];
 netGems: string | null; hasSourceMutations: boolean; hasUnclassified: boolean;
 usefulChainCreditAuthorized: false; allocationReady: false; publicationAuthorized: false;
}
function classify(source: z.infer<typeof sourceSchema>, receipt: z.infer<typeof receiptSchema>, wallet: string): Classification {
 const { entry: e, account: a, transaction: t } = source, m = t.metadata, delta = BigInt(e.delta), amount = delta < 0n ? -delta : delta;
 if (delta === 0n || a.wallet !== wallet || a.kind !== 'player_gems' || a.currency !== 'GEMS' || a.baseId !== null) return 'source-mutation';
 if (new Set(receipt.map(r => r.id)).size !== receipt.length || new Set(receipt.map(r => r.accountId)).size !== receipt.length) return 'unclassified';
 if (!receipt.some(r => r.id === e.id && r.accountId === a.id && r.delta === e.delta && r.kind === a.kind && r.currency === a.currency && r.wallet === wallet && r.baseId === null)) return 'unclassified';
 const has = (kind: string, currency: string, value: bigint, owner: string | null = null, baseId: string | null = null) => receipt.some(r => r.kind === kind && r.currency === currency && BigInt(r.delta) === value && r.wallet === owner && r.baseId === baseId);
 if (delta > 0n && receipt.length === 4 && m['wallet'] === wallet && m['gems'] === amount.toString() && has('gems_mint', 'GEMS', -amount) && has('emission_pool', 'KEEP', amount)) {
  if (t.type === 'gems.grant') {
   const reason = m['reason'], ref = m['ref'];
   const key = reason === 'welcome' || reason === 'dev' ? `grant:${reason}:${wallet}` : reason === 'task' && typeof ref === 'string' && ref.length ? `grant:task:${ref}:${wallet}` : reason === 'refund' && typeof ref === 'string' && ref.length ? `grant:refund:${ref}` : null;
   if (key === t.key && has('gems_reward_budget', 'KEEP', -amount)) return 'grant';
  }
  if (m['keep'] === amount.toString() && m['rate'] === GEMS.gemsPerKeep) {
   if (t.type === 'gems.from_keep' && m['source'] === 'ledger' && t.key.startsWith(`gems:from-keep:${wallet}:`) && t.key.length > `gems:from-keep:${wallet}:`.length && has('player_keep', 'KEEP', -amount, wallet)) return 'custodial-conversion';
   // This proves the copied ledger posting only. Deposits/finality and origin
   // attribution remain separate authorities; this result awards no credit.
   if (t.type === 'gems.buy' && m['source'] === 'wallet' && z.uuid().safeParse(m['depositId']).success && t.key === `deposit:${m['depositId']}:credit` && typeof m['txSignature'] === 'string' && has('onchain_inflow', 'KEEP', -amount)) return 'wallet-conversion-ledger';
  }
 }
 if (delta < 0n && receipt.length === 4 && t.type === 'gems.to_shards' && m['wallet'] === wallet && m['gems'] === amount.toString() && m['shards'] === amount.toString() && m['rate'] === GEMS.shardsPerGem && t.key.startsWith(`gems:to-shards:${wallet}:`) && has('gems_sink', 'GEMS', amount) && has('shard_genesis', 'SHARDS', -amount)) {
  const baseId = m['baseId']; if (baseId === undefined ? has('player_shards', 'SHARDS', amount, wallet) : typeof baseId === 'string' && has('base_shards', 'SHARDS', amount, null, baseId)) return 'excluded-gems-to-shards';
 }
 if (receipt.length === 2 && has('gems_sink', 'GEMS', -delta)) {
  if (delta < 0n && m['wallet'] === wallet && m['currency'] === 'GEMS') return 'system-spend';
  if (delta > 0n && t.type.endsWith('.system_refund')) return 'sink-refund';
 }
 return 'unclassified';
}
export async function initializeGemsFlowEvidence(db: Db): Promise<void> {
 if ((await db.execute(sql`select id from mining_gems_flow_coverage where id`)).length) return;
 if (!phaseEMiningEnabled()) return fail('DISABLED');
 try { await db.transaction(async tx => { await tx.execute(sql`insert into mining_gems_flow_coverage(id) values(true) on conflict do nothing`); }); } catch (error) { busy(error); }
}
export async function readGemsFlowEvidence(db: DbOrTx, input: unknown): Promise<GemsFlowEvidence> {
 const parsed = z.object({ wallet: walletSchema, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().safeParse(input); if (!parsed.success) return fail('INVALID_INPUT');
 const { wallet, day } = parsed.data, start = Date.parse(`${day}T00:00:00Z`); if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) return fail('INVALID_INPUT');
 const end = new Date(start + 86_400_000).toISOString();
 try { const snapshot = await db.transaction(async tx => {
  await tx.execute(sql`lock table players,accounts,ledger_transactions,ledger_entries,mining_free_coverage,mining_free_cohort_events,mining_gems_flow_coverage,mining_gems_flow_events in share mode nowait`);
  const [clock] = await tx.execute<{ closed: boolean; isolation: string }>(sql`select public.shardkeep_mining_free_clock()>=${end}::timestamptz as closed,current_setting('transaction_isolation') as isolation`);
  if (clock?.isolation !== 'read committed') return fail('SOURCE_UNAVAILABLE'); if (clock.closed !== true) return fail('DAY_OPEN');
  const [coverage] = await tx.execute<{ started: string }>(sql`select to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started from mining_gems_flow_coverage where id`); if (!coverage) return fail('COVERAGE_UNAVAILABLE');
  const births = await tx.execute<{ id: string; operation: string; valid: boolean }>(sql`
   select e.id::text,e.operation,(e.after_state->>'wallet'=${wallet} and e.id>c.birth_event_floor and c.started_at<=e.observed_at and c.started_at<=(e.after_state->>'created_at')::timestamptz and (e.after_state->>'created_at')::timestamptz<=e.observed_at and e.observed_at<${end}::timestamptz) is true as valid
   from mining_free_cohort_events e cross join mining_gems_flow_coverage c where c.id and e.wallet=${wallet} and e.source_table='players' and e.observed_at<${end}::timestamptz order by e.id limit 2`);
  const birth = births[0]; if (births.length !== 1 || !birth || birth.operation !== 'INSERT' || !birth.valid) return fail('COVERAGE_UNAVAILABLE');
  // Bound candidates before cross-wallet transaction-group lookups. Otherwise
  // many excluded groups could make a tiny visible result do unbounded work.
  const [candidates] = await tx.execute<{ candidate_count: string }>(sql`select count(*)::text as candidate_count from (
   select id from mining_gems_flow_events where wallet=${wallet} and observed_at<${end}::timestamptz order by observed_at,id limit 10001
  ) bounded_candidates`);
  if (!candidates) return fail('SOURCE_UNAVAILABLE'); if (BigInt(candidates.candidate_count) > 10_000n) return fail('TOO_LARGE');
  // Read counts and decoded byte sizes before PostgreSQL JSON reaches the client.
  // These are resource ceilings, not economic policy or a truncated result.
  const [size] = await tx.execute<{ count: string; bytes: string; largest: string; complete: boolean; chronological: boolean }>(sql`
   select count(*)::text as count,coalesce(sum(bytes),0)::text as bytes,coalesce(max(bytes),0)::text as largest,coalesce(bool_and(receipt_complete),true) as complete,coalesce(bool_and(after_birth),true) as chronological from (
    select octet_length(coalesce(e.before_state::text,''))+octet_length(coalesce(e.after_state::text,''))+octet_length(e.receipt::text) as bytes,e.receipt_complete,e.observed_at>=b.observed_at as after_birth
    from mining_gems_flow_events e cross join mining_free_cohort_events b where b.id=${birth.id}::bigint and e.wallet=${wallet} and e.observed_at<${end}::timestamptz and not exists(select 1 from mining_gems_flow_events later where later.transaction_marker=e.transaction_marker and later.observed_at>=${end}::timestamptz) order by e.observed_at,e.id limit 10001
   ) bounded`);
  if (!size) return fail('SOURCE_UNAVAILABLE'); if (BigInt(size.count) > 10_000n || BigInt(size.bytes) > 16_777_216n || BigInt(size.largest) > 1_048_576n || !size.complete) return fail('TOO_LARGE'); if (!size.chronological) return fail('COVERAGE_UNAVAILABLE');
  const rows = await tx.execute<{ id: string; observed_at: string; effective_observed_at: string; transaction_marker: string; source_table: GemsFlowFact['sourceTable']; source_id: string; operation: GemsFlowFact['operation']; account_id: string | null; transaction_id: string | null; before_state: unknown; after_state: unknown; receipt: unknown }>(sql`
   select e.id::text,to_char(e.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,
    to_char((select later.observed_at from mining_gems_flow_events later where later.transaction_marker=e.transaction_marker order by later.observed_at desc limit 1) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_observed_at,
    e.transaction_marker::text,e.source_table,e.source_id,e.operation,e.account_id,e.transaction_id,e.before_state,e.after_state,e.receipt
   from mining_gems_flow_events e where e.wallet=${wallet} and e.observed_at<${end}::timestamptz and not exists(select 1 from mining_gems_flow_events later where later.transaction_marker=e.transaction_marker and later.observed_at>=${end}::timestamptz) order by e.observed_at,e.id limit 10001`);
  if (rows.length !== Number(size.count)) return fail('SOURCE_UNAVAILABLE');
  return { coverage, birth, rows };
 });
  // Immutable copied rows can be decoded/classified after releasing live-source locks.
  const { coverage, birth, rows } = snapshot;
  rows.sort((a, b) => a.effective_observed_at.localeCompare(b.effective_observed_at) || (BigInt(a.transaction_marker) < BigInt(b.transaction_marker) ? -1 : BigInt(a.transaction_marker) > BigInt(b.transaction_marker) ? 1 : BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  let net = 0n, mutation = false, unclassified = false; const facts: GemsFlowFact[] = [];
  for (const row of rows) {
   let classification: Classification = 'source-mutation';
   if (row.source_table === 'accounts' && row.operation === 'INSERT') {
    const a = z.object({ id: z.uuid(), kind: z.literal('player_gems'), currency: z.literal('GEMS'), owner_wallet: z.literal(wallet), base_id: z.null(), initialBalance: z.literal('0') }).strict().safeParse(row.after_state);
    if (!a.success || a.data.id !== row.account_id || a.data.id !== row.source_id) return fail('SOURCE_UNAVAILABLE'); classification = 'account-created';
   } else if (row.source_table === 'ledger_entries' && row.operation === 'INSERT') {
    const s = sourceSchema.safeParse(row.after_state), r = receiptSchema.safeParse(row.receipt); if (!s.success || !r.success) return fail('SOURCE_UNAVAILABLE');
    if (s.data.entry.id !== row.source_id || s.data.entry.accountId !== s.data.account.id || s.data.entry.txnId !== s.data.transaction.id || s.data.account.id !== row.account_id || s.data.transaction.id !== row.transaction_id) return fail('SOURCE_UNAVAILABLE');
    classification = classify(s.data, r.data, wallet); if (classification !== 'source-mutation') net += BigInt(s.data.entry.delta);
   }
   if (classification === 'source-mutation') mutation = true; if (classification === 'unclassified') unclassified = true;
   facts.push({ id: row.id, observedAt: row.observed_at, effectiveObservedAt: row.effective_observed_at, transactionMarker: row.transaction_marker, sourceTable: row.source_table, sourceId: row.source_id, operation: row.operation, accountId: row.account_id, transactionId: row.transaction_id, classification, source: row.after_state ?? row.before_state, before: row.before_state, receipt: row.receipt });
  }
  if (!mutation && net < 0n) return fail('SOURCE_UNAVAILABLE');
  return { version: 1, sourcePolicyVersion: 1, transactionVisibility: 'whole-db-transaction-at-last-observation', wallet, day, coverageStartedAt: coverage.started, birthEventId: birth.id, facts, netGems: mutation ? null : net.toString(), hasSourceMutations: mutation, hasUnclassified: unclassified, usefulChainCreditAuthorized: false, allocationReady: false, publicationAuthorized: false };
 } catch (error) { return busy(error); }
}
