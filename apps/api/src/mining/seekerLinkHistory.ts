/** Recorded link facts only. Neither a current badge nor a recorded link proves
 * historical token holding, membership eligibility or any mining bonus.
 * Continuity follows trigger observation times. The reused journal cannot place
 * all operations of a cross-midnight transaction at one atomic commit cutoff. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_MINING_SCORE_POLICY as POLICY } from '@shardkeep/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { phaseEMiningEnabled } from '../config';

const DAY_MS = 86_400_000, MAX_DAYS = 10_000, MAX_ROWS = 10_000, MAX_BYTES = 8_388_608;
const key = z.string().min(32).max(44).refine(value => {
 if (value.length < 32 || value.length > 44) return false;
 try { return new PublicKey(value).toBase58() === value; } catch { return false; }
});
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const request = z.object({ wallet: key, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), policyVersion: z.literal(POLICY.version) }).strict();
const state = z.object({ wallet: key, seeker_wallet: key, sgt_mint: key, revoked_at: timestamp.nullable() }).strict();
type Code = 'DISABLED' | 'INVALID_INPUT' | 'DAY_OPEN' | 'IDENTITY_COVERAGE_UNAVAILABLE' | 'SOURCE_UNAVAILABLE' | 'SOURCE_CONFLICT' | 'TOO_LARGE' | 'BUSY';
export class MiningSeekerLinkHistoryError extends Error {
 constructor(readonly code: Code) { super(`Mining Seeker link history refused: ${code}`); this.name = 'MiningSeekerLinkHistoryError'; }
}
function fail(code: Code): never { throw new MiningSeekerLinkHistoryError(code); }

/** Explicit prospective owner operation. Existing coverage stays readable paused. */
export async function initializeMiningSeekerLinkHistory(db: Db): Promise<void> {
 const [prior] = await db.execute(sql`select id from public.mining_seeker_link_coverage where id`);
 if (prior) return;
 if (!phaseEMiningEnabled()) fail('DISABLED');
 try { await db.transaction(async tx => {
  if (!phaseEMiningEnabled()) fail('DISABLED');
  await tx.execute(sql`insert into public.mining_seeker_link_coverage(id) values(true) on conflict do nothing`);
 }); } catch (error) {
  const e = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.code === '55P03' || e.cause?.code === '55P03') fail('BUSY');
  if ((e.cause?.message ?? e.message) === 'MINING_SEEKER_LINK_SOURCE_UNAVAILABLE') fail('SOURCE_UNAVAILABLE');
  throw error;
 }
}

export interface MiningRecordedSeekerLink { wallet: string; seekerWallet: string; sgtMint: string; revokedAt: string | null }
export interface MiningSeekerLinkChange { eventId: string; observedAt: string; operation: 'INSERT' | 'UPDATE' | 'DELETE'; before: MiningRecordedSeekerLink | null; after: MiningRecordedSeekerLink | null }
type RawEvent = { id: string; wallet: string; observed_at: string; source_id: string; operation: string; before_state: unknown; after_state: unknown; after_coverage: boolean };
function normalized(column: 'before_state' | 'after_state') {
 const field = sql.raw(`e.${column}`);
 // Normalize timestamp presentation only in PostgreSQL, retaining microseconds
 // and the original four-key object so unknown payload fields remain detectable.
 return sql`case when ${field} is null then null else ${field} || jsonb_build_object('revoked_at',
  to_char((${field}->>'revoked_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end`;
}
async function boundedRows(db: DbOrTx, where: SQL, budget: number) {
 const [size] = await db.execute<{ n: number; bytes: string }>(sql`select count(*)::int n,
  coalesce(sum(octet_length(coalesce(e.before_state::text,''))::bigint+octet_length(coalesce(e.after_state::text,''))+octet_length(e.wallet)+octet_length(e.source_id)),0)::text bytes
  from (select * from public.mining_free_cohort_events e where ${where} order by e.id limit ${MAX_ROWS + 1}) e`);
 if (!size) fail('SOURCE_UNAVAILABLE');
 if (size.n > MAX_ROWS || BigInt(size.bytes) > BigInt(budget)) fail('TOO_LARGE');
 const rows = await db.execute<RawEvent>(sql`select e.id::text,e.wallet,
  to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,e.source_id,e.operation,
  ${normalized('before_state')} before_state,${normalized('after_state')} after_state,
  (e.observed_at>=c.started_at) is true after_coverage
  from public.mining_free_cohort_events e cross join public.mining_free_coverage c
  where c.id and ${where} order by e.observed_at,e.id limit ${MAX_ROWS + 1}`);
 if (rows.length !== size.n) fail('SOURCE_CONFLICT');
 return { rows, bytes: Number(size.bytes) };
}
function decode(row: RawEvent): MiningSeekerLinkChange {
 if (!/^[1-9][0-9]{0,19}$/.test(row.id) || !key.safeParse(row.wallet).success || !timestamp.safeParse(row.observed_at).success || !row.after_coverage) fail('SOURCE_CONFLICT');
 const parse = (raw: unknown): MiningRecordedSeekerLink | null => {
  if (raw === null) return null; const parsed = state.safeParse(raw); if (!parsed.success) fail('SOURCE_CONFLICT');
  return { wallet: parsed.data.wallet, seekerWallet: parsed.data.seeker_wallet, sgtMint: parsed.data.sgt_mint, revokedAt: parsed.data.revoked_at };
 };
 const before = parse(row.before_state), after = parse(row.after_state);
 if (row.operation === 'INSERT' ? before !== null || after === null : row.operation === 'DELETE' ? before === null || after !== null : row.operation === 'UPDATE' ? before === null || after === null || JSON.stringify(before) === JSON.stringify(after) : true) fail('SOURCE_CONFLICT');
 if (row.wallet !== before?.wallet && row.wallet !== after?.wallet) fail('SOURCE_CONFLICT');
 if (row.source_id !== (after ?? before)!.wallet) fail('SOURCE_CONFLICT');
 return { eventId: row.id, observedAt: row.observed_at, operation: row.operation as MiningSeekerLinkChange['operation'], before, after };
}

export async function readMiningSeekerLinkHistory(db: Db, value: unknown) {
 const parsed = request.safeParse(value); if (!parsed.success) fail('INVALID_INPUT');
 const { wallet, day, policyVersion } = parsed.data, start = Date.parse(`${day}T00:00:00.000Z`);
 if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) fail('INVALID_INPUT');
 const startAt = `${day}T00:00:00.000000Z`, endAt = new Date(start + DAY_MS).toISOString().replace('.000Z', '.000000Z');
 try {
  const snapshot = await db.transaction(async tx => {
   await tx.execute(sql`set local statement_timeout='2000ms'`);
   await tx.execute(sql`lock table public.players,public.seeker_links,public.mining_free_coverage,public.mining_free_cohort_events,public.mining_seeker_link_coverage in share mode nowait`);
   const [clock] = await tx.execute<{ closed: boolean; isolation: string }>(sql`select public.shardkeep_mining_free_clock()>=${endAt}::timestamptz closed,current_setting('transaction_isolation') isolation`);
   if (clock?.isolation !== 'read committed') fail('SOURCE_UNAVAILABLE'); if (!clock.closed) fail('DAY_OPEN');
   const [sources] = await tx.execute<{ valid: boolean }>(sql`select public.shardkeep_mining_seeker_link_sources_valid() valid`);
   if (sources?.valid !== true) fail('SOURCE_UNAVAILABLE');
   const births = await tx.execute<{ id: string; valid: boolean; born_at: string; observed_at: string; coverage_at: string; original_coverage_at: string }>(sql`
    select e.id::text,(e.operation='INSERT' and e.source_id=${wallet} and e.before_state is null
     and jsonb_typeof(e.after_state)='object' and (select count(*) from jsonb_object_keys(e.after_state))=2 and e.after_state->>'wallet'=${wallet}
     and isfinite(c.started_at) and isfinite(e.observed_at) and isfinite((e.after_state->>'created_at')::timestamptz)
     and e.id>sc.birth_event_floor and sc.started_at<=e.observed_at
     and sc.started_at<=(e.after_state->>'created_at')::timestamptz and c.started_at<=(e.after_state->>'created_at')::timestamptz and (e.after_state->>'created_at')::timestamptz<=e.observed_at
     and e.observed_at<${startAt}::timestamptz) is true valid,
     to_char((e.after_state->>'created_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') born_at,
     to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,
     to_char(sc.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') coverage_at,
     to_char(c.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') original_coverage_at
    from public.mining_free_cohort_events e cross join public.mining_free_coverage c cross join public.mining_seeker_link_coverage sc where c.id and sc.id and e.wallet=${wallet}
     and e.source_table='players' and e.observed_at<${endAt}::timestamptz order by e.id limit 2`);
   const birth = births[0]; if (births.length !== 1 || !birth || !birth.valid) fail('IDENTITY_COVERAGE_UNAVAILABLE');
   if ((start - Date.parse(birth.born_at.slice(0, 10))) / DAY_MS > MAX_DAYS) fail('TOO_LARGE');
   const target = await boundedRows(tx, sql`e.wallet=${wallet} and e.source_table='seeker_links' and e.observed_at<${endAt}::timestamptz`, MAX_BYTES);
   return { birth, target };
  });
  // All payload decoding and cross-wallet searches happen after the live player
  // and link barrier. Original journal rows are immutable and the cutoff closed.
  const { birth, target } = snapshot, events = target.rows.map(decode);
  let current: MiningRecordedSeekerLink | null = null, openingLink: MiningRecordedSeekerLink | null = null, opened = false;
  const changes: MiningSeekerLinkChange[] = [], mints = new Set<string>(), seekers = new Set<string>();
  for (const event of events) {
   if (event.observedAt < birth.observed_at) fail('SOURCE_CONFLICT');
   if (!opened && event.observedAt >= startAt) { openingLink = current; opened = true; }
   const before = event.before?.wallet === wallet ? event.before : null, after = event.after?.wallet === wallet ? event.after : null;
   if (JSON.stringify(current) !== JSON.stringify(before)) fail('SOURCE_CONFLICT');
   current = after;
   for (const link of [before, after]) if (link) { mints.add(link.sgtMint); seekers.add(link.seekerWallet); }
   if (event.observedAt >= startAt) changes.push(event);
  }
  if (!opened) openingLink = current;
  const status = changes.length ? 'changed_link' as const : current === null ? 'no_link' as const : 'continuous_link' as const;
  const byCredential = new Map<string, { sgtMint: string; seekerWallet: string; gameWallets: Set<string>; eventIds: Set<string> }>();
  const mintWallets = new Map<string, Set<string>>(), seekerWallets = new Map<string, Set<string>>();
  if (mints.size || seekers.size) {
   const cross = await db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout='2000ms'`);
    return boundedRows(tx, sql`e.source_table='seeker_links' and e.observed_at<${endAt}::timestamptz and
     (e.operation='TRUNCATE' or e.before_state->>'sgt_mint' in (select jsonb_array_elements_text(${JSON.stringify([...mints])}::jsonb))
      or e.after_state->>'sgt_mint' in (select jsonb_array_elements_text(${JSON.stringify([...mints])}::jsonb))
      or e.before_state->>'seeker_wallet' in (select jsonb_array_elements_text(${JSON.stringify([...seekers])}::jsonb))
      or e.after_state->>'seeker_wallet' in (select jsonb_array_elements_text(${JSON.stringify([...seekers])}::jsonb)))`, MAX_BYTES - target.bytes);
   });
   for (const row of cross.rows) {
    const event = decode(row);
    for (const link of [event.before, event.after]) {
     if (!link || !mints.has(link.sgtMint) && !seekers.has(link.seekerWallet)) continue;
     const id = `${link.sgtMint}:${link.seekerWallet}`, claim = byCredential.get(id) ?? { sgtMint: link.sgtMint, seekerWallet: link.seekerWallet, gameWallets: new Set<string>(), eventIds: new Set<string>() };
     claim.gameWallets.add(link.wallet); claim.eventIds.add(event.eventId); byCredential.set(id, claim);
     const mint = mintWallets.get(link.sgtMint) ?? new Set<string>(); mint.add(link.wallet); mintWallets.set(link.sgtMint, mint);
     const seeker = seekerWallets.get(link.seekerWallet) ?? new Set<string>(); seeker.add(link.wallet); seekerWallets.set(link.seekerWallet, seeker);
    }
   }
  }
  const claims = [...byCredential.values()].sort((a, b) => a.sgtMint.localeCompare(b.sgtMint) || a.seekerWallet.localeCompare(b.seekerWallet))
   .map(row => ({ sgtMint: row.sgtMint, seekerWallet: row.seekerWallet, gameWallets: [...row.gameWallets].sort(), eventIds: [...row.eventIds].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1) }));
  const uniqueSinceCoverage = [...mints].every(mint => (mintWallets.get(mint)?.size ?? 0) === 1) && [...seekers].every(seeker => (seekerWallets.get(seeker)?.size ?? 0) === 1);
  return { wallet, day, policyVersion, status, openingLink, closingLink: current, changes,
   activeThroughout: status === 'continuous_link' && current?.revokedAt === null,
   identity: { birthEventId: birth.id, bornAt: birth.born_at, observedBirthAt: birth.observed_at },
   credentialHistory: { coverageStartedAt: birth.coverage_at, recordedHistoryStartedAt: birth.original_coverage_at, priorHistory: 'unknown' as const, uniqueSinceCoverage, claims },
   sourceUniverse: 'recorded-seeker-link-events' as const, historicalChainOwnership: 'unknown' as const,
   continuityAuthority: 'recorded-source-observations' as const, atomicTransactionHistory: 'unavailable' as const,
   bonusAuthorized: false as const, eligibilityAuthorized: false as const, allocationAuthorized: false as const, publicationAuthorized: false as const,
  };
 } catch (error) {
  const e = error as { code?: string; cause?: { code?: string } }, code = e.code ?? e.cause?.code;
  if (code === '55P03') fail('BUSY'); if (code === '57014') fail('SOURCE_UNAVAILABLE');
  if (code === '22007' || code === '22008') fail('SOURCE_CONFLICT'); throw error;
 }
}
