/** K-148 temporary devnet/pre-mining funding policy. This is an operator lane,
 * not a player endpoint. Gross funding consumes an original welcome cohort's
 * allowance forever; recycling or a new UTC day cannot renew that allowance. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAddresses } from '@shardkeep/chain';
import { GEMS, GEMS_TASKS } from '@shardkeep/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, DbTx } from './client';
import { latestMigrationInBuild } from './migrate';
import { accounts, economyChainIdentity, ledgerEntries, ledgerTransactions } from './schema';
import { postTransaction } from '../ledger/ledger';

export const WELCOME_BUDGET_POLICY = 'devnet-welcome-obligations-v1';
// D-153.13: 0138 only freezes Workshop start/collection facts and scope. It
// changes no welcome obligations, funding accounts, rates or mining writers.
// Any later migration still requires a new policy review, even if unrelated.
const FRONTIER = '0138_workshop_allowance';
const KEY_PREFIX = 'gems:budget:welcome:v1:';
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WHOLE = /^(0|[1-9][0-9]*)$/;
const SHA = /^[0-9a-f]{40}$/;

export interface WelcomeBudgetRequest {
  expectedDatabase: string;
  cluster: string;
  cohortDay: string;
  keep: bigint;
  maxKeep: bigint;
  idempotencyKey: string;
  buildSha: string;
  apply?: boolean;
}
export interface WelcomeBudgetCaps {
  cohortAccepted: bigint; cohortGrossFunded: bigint; cohortPending: bigint;
  globalPending: bigint; budget: bigint; emissionPool: bigint; maxKeep: bigint;
}
type WireCaps = { [K in keyof WelcomeBudgetCaps]: string } & { available: string };
interface ChainIdentity { cluster: string; keepMint: string; coreProgram: string; configPda: string }
interface FundingMetadata {
  policy: typeof WELCOME_BUDGET_POLICY; cohortDay: string; keep: string; maxKeep: string;
  databaseFingerprint: string; chainIdentity: ChainIdentity; serverTime: string; buildSha: string; capBefore: WireCaps;
}
export interface WelcomeBudgetResult {
  mode: 'dry-run' | 'applied' | 'replay'; receiptId: string | null; permitted: boolean;
  evidence: FundingMetadata;
}
function fail(message: string): never { throw new Error(`welcome Gems funding refused: ${message}`); }
export function validCohortDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
export function welcomeBudgetAvailable(c: WelcomeBudgetCaps): bigint {
  // Funding is pooled: another cohort's claimant can consume this cohort's
  // allowance first. Its remaining claims are diagnostic, not an earmark.
  const values = [c.cohortAccepted - c.cohortGrossFunded,
    c.globalPending - c.budget, c.maxKeep, c.emissionPool];
  const lowest = values.reduce((minimum, value) => value < minimum ? value : minimum);
  return lowest < 0n ? 0n : lowest;
}
function validateRequest(r: WelcomeBudgetRequest): void {
  if (r.cluster !== 'devnet') fail('this policy is devnet only');
  if (!r.expectedDatabase || !/^[A-Za-z0-9_-]+$/.test(r.expectedDatabase)) fail('explicit expected database required');
  if (!validCohortDay(r.cohortDay)) fail('invalid UTC cohort day');
  if (typeof r.keep !== 'bigint' || typeof r.maxKeep !== 'bigint' || r.keep <= 0n || r.maxKeep <= 0n
    || r.keep > 9_223_372_036_854_775_807n || r.maxKeep > 9_223_372_036_854_775_807n) fail('positive bigint amounts required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.idempotencyKey)) fail('invalid idempotency key');
  if (!SHA.test(r.buildSha)) fail('full application build SHA required');
  if (Object.keys(GEMS_TASKS).length !== 0 || GEMS.gemsPerKeep !== 1) fail('task catalogue/rate requires a new policy review');
}
function sameChain(a: ChainIdentity, b: ChainIdentity): boolean {
  return a.cluster === b.cluster && a.keepMint === b.keepMint && a.coreProgram === b.coreProgram && a.configPda === b.configPda;
}
function metadata(value: unknown): FundingMetadata {
  const m = value as FundingMetadata | null;
  if (!m || m.policy !== WELCOME_BUDGET_POLICY || !validCohortDay(m.cohortDay) || !WHOLE.test(m.keep) || BigInt(m.keep) <= 0n
    || !WHOLE.test(m.maxKeep) || BigInt(m.maxKeep) <= 0n || !/^[0-9a-f]{64}$/.test(m.databaseFingerprint)
    || !m.chainIdentity || !SHA.test(m.buildSha) || !Number.isFinite(Date.parse(m.serverTime)) || !m.capBefore) {
    fail('unclassified or malformed funding; reconcile historical postings separately');
  }
  const fields: Array<keyof WireCaps> = ['cohortAccepted', 'cohortGrossFunded', 'cohortPending', 'globalPending', 'budget', 'emissionPool', 'maxKeep', 'available'];
  if (fields.some((key) => typeof m.capBefore[key] !== 'string' || !WHOLE.test(m.capBefore[key]))) fail('malformed cap evidence');
  const caps = Object.fromEntries(fields.map((key) => [key, BigInt(m.capBefore[key])])) as unknown as WelcomeBudgetCaps;
  if (welcomeBudgetAvailable(caps).toString() !== m.capBefore.available || BigInt(m.keep) > BigInt(m.capBefore.available)
    || m.maxKeep !== m.capBefore.maxKeep || m.cohortDay > m.serverTime.slice(0, 10)) fail('invalid historical funding cap');
  return m;
}

async function validateFunding(
  tx: DbTx, row: typeof ledgerTransactions.$inferSelect, identity: ChainIdentity,
  fingerprint: string, poolId: string, budgetId: string,
): Promise<FundingMetadata> {
  const m = metadata(row.metadata);
  if (row.type !== 'gems.budget.fund' || !row.idempotencyKey.startsWith(KEY_PREFIX)
    || !sameChain(m.chainIdentity, identity) || m.databaseFingerprint !== fingerprint) fail('funding identity mismatch; reconciliation required');
  const entries = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, row.id));
  if (entries.length !== 2 || !entries.some((e) => e.accountId === poolId && e.delta === -BigInt(m.keep))
    || !entries.some((e) => e.accountId === budgetId && e.delta === BigInt(m.keep))) fail('funding is not the exact two-entry transfer');
  return m;
}

export async function fundWelcomeGemsBudget(db: Db, request: WelcomeBudgetRequest): Promise<WelcomeBudgetResult> {
  validateRequest(request);
  const latest = latestMigrationInBuild();
  if (latest.tag !== FRONTIER) fail('pre-mining schema frontier changed; policy review required');
  const registry = loadAddresses(REPO_ROOT, 'devnet');
  if (!registry) fail('selected devnet address registry missing');
  const selected: ChainIdentity = { cluster: 'devnet', keepMint: registry.keepMint, coreProgram: registry.coreProgram, configPda: registry.config };

  return db.transaction(async (tx) => {
    // Database owner credentials are deliberate: runtime logins may not use
    // this operator capability, even if they can post ordinary player grants.
    const [database] = await tx.execute<{
      name: string; oid: string; operator: boolean; server_time: Date;
    }>(sql`WITH RECURSIVE memberships(oid) AS (
        SELECT oid FROM pg_roles WHERE rolname = current_user
        UNION SELECT m.roleid FROM pg_auth_members m JOIN memberships p ON p.oid = m.member
      ) SELECT d.datname AS name, d.oid::text AS oid,
      (current_user = pg_get_userbyid(d.datdba) AND session_user = current_user
       AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('shardkeep_api_runtime', 'shardkeep_worker_runtime')
         AND r.oid IN (SELECT oid FROM memberships))) AS operator,
      transaction_timestamp() AS server_time FROM pg_database d WHERE d.datname = current_database()`);
    if (!database || database.name !== request.expectedDatabase) fail('connected database differs from expected database');
    if (!database.operator) fail('dedicated database-owner operator login required; runtime roles refused');
    const [system] = await tx.execute<{ system_identifier: string }>(sql`SELECT system_identifier::text FROM pg_control_system()`);
    if (!system?.system_identifier) fail('database system identity unavailable');
    const fingerprint = createHash('sha256').update(`${system.system_identifier}:${database.oid}:${database.name}`).digest('hex');
    const [migration] = await tx.execute<{ count: string; latest: string }>(sql`SELECT count(*)::text AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`);
    if (migration?.count !== '139' || migration.latest !== String(latest.when)) fail('database is not at the reviewed pre-mining schema frontier');
    const [pinned] = await tx.select().from(economyChainIdentity);
    if (!pinned || !sameChain(pinned, selected)) fail('existing database chain identity differs from selected registry');
    const existing = await tx.select().from(accounts).where(and(
      inArray(accounts.kind, ['emission_pool', 'gems_reward_budget']), isNull(accounts.ownerWallet), isNull(accounts.baseId),
    ));
    const pool = existing.find((a) => a.kind === 'emission_pool');
    const budget = existing.find((a) => a.kind === 'gems_reward_budget');
    if (existing.length !== 2 || !pool || !budget || pool.currency !== 'KEEP' || budget.currency !== 'KEEP') fail('pre-existing KEEP system accounts required');
    if (request.apply) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('shardkeep:gems-reward-budget'))`);

    // No fresh capacity/day checks before replay. The original exact transfer
    // is still the answer after grants consume it or midnight passes.
    const key = `${KEY_PREFIX}${request.idempotencyKey}`;
    const [prior] = await tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, key));
    if (prior) {
      const evidence = await validateFunding(tx, prior, selected, fingerprint, pool.id, budget.id);
      if (evidence.cohortDay !== request.cohortDay || evidence.keep !== request.keep.toString()
        || evidence.maxKeep !== request.maxKeep.toString()) fail('idempotency key request mismatch');
      return { mode: 'replay', receiptId: prior.id, permitted: true, evidence };
    }

    // Match postTransaction's UUID ordering. Grants cannot commit a budget
    // debit during the following aggregate+posting, and no player locks are
    // acquired here (the welcome caller already owns its own wallet lock).
    const accountQuery = tx.select().from(accounts).where(inArray(accounts.id, [pool.id, budget.id])).orderBy(asc(accounts.id));
    const locked = request.apply ? await accountQuery.for('update') : await accountQuery;
    const serverTime = new Date(database.server_time).toISOString();
    if (request.cohortDay > serverTime.slice(0, 10)) fail('cohort day is in the database UTC future');
    const history = await tx.select().from(ledgerTransactions).where(sql`
      ${ledgerTransactions.type} = 'gems.budget.fund'
      OR ${ledgerTransactions.metadata}->>'policy' = ${WELCOME_BUDGET_POLICY}
      OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e.txn_id = ${ledgerTransactions.id}
        AND e.account_id = ${budget.id} AND e.delta > 0)`);
    let grossFunded = 0n;
    for (const row of history) {
      const funding = await validateFunding(tx, row, selected, fingerprint, pool.id, budget.id);
      if (funding.cohortDay === request.cohortDay) grossFunded += BigInt(funding.keep);
    }
    const [totals] = await tx.execute<{ accepted: string; pending: string; global_pending: string }>(sql`
      SELECT coalesce(sum(o.gems) FILTER (WHERE (o.accepted_at AT TIME ZONE 'UTC')::date = ${request.cohortDay}::date), 0)::text AS accepted,
        coalesce(sum(o.gems) FILTER (WHERE (o.accepted_at AT TIME ZONE 'UTC')::date = ${request.cohortDay}::date AND g.id IS NULL), 0)::text AS pending,
        coalesce(sum(o.gems) FILTER (WHERE g.id IS NULL), 0)::text AS global_pending
      FROM welcome_gems_obligations o LEFT JOIN ledger_transactions g ON g.idempotency_key = 'grant:welcome:' || o.wallet
      -- Keep the authoritative cutoff in PostgreSQL: JS Date truncates the
      -- microseconds needed to include already-accepted same-millisecond rows.
      WHERE o.accepted_at <= transaction_timestamp()`);
    const caps: WelcomeBudgetCaps = { cohortAccepted: BigInt(totals!.accepted), cohortGrossFunded: grossFunded,
      cohortPending: BigInt(totals!.pending), globalPending: BigInt(totals!.global_pending),
      budget: locked.find((a) => a.id === budget.id)!.balance, emissionPool: locked.find((a) => a.id === pool.id)!.balance, maxKeep: request.maxKeep };
    const available = welcomeBudgetAvailable(caps);
    const evidence: FundingMetadata = { policy: WELCOME_BUDGET_POLICY, cohortDay: request.cohortDay,
      keep: request.keep.toString(), maxKeep: request.maxKeep.toString(), databaseFingerprint: fingerprint,
      chainIdentity: selected, serverTime, buildSha: request.buildSha,
      capBefore: { ...Object.fromEntries(Object.entries(caps).map(([name, value]) => [name, value.toString()])) as Omit<WireCaps, 'available'>, available: available.toString() } };
    if (!request.apply) return { mode: 'dry-run', receiptId: null, permitted: request.keep <= available, evidence };
    if (request.keep > available) fail(`requested amount exceeds available cap ${available}; rerun dry-run`);
    const posted = await postTransaction(tx, { idempotencyKey: key, type: 'gems.budget.fund',
      entries: [{ account: pool.id, delta: -request.keep }, { account: budget.id, delta: request.keep }], metadata: { ...evidence } });
    if (posted.duplicate) fail('unexpected concurrent non-governed key writer');
    return { mode: 'applied', receiptId: posted.transaction.id, permitted: true, evidence };
  }, request.apply ? { isolationLevel: 'read committed', accessMode: 'read write' }
    : { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
