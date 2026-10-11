/** Real request/cancel/worker/retirement composition in a named local DB. */
import { createHash, randomUUID } from 'node:crypto';
import { ECONOMY } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDb, type Db, type DbTx } from '../../src/db/client';
import { applyFixtureL1Retirement } from '../../src/db/keepCustodyJournal';
import { applyFixtureUnbondingWithdrawalDrain, type FixtureWithdrawalDrainRequest,
  type FixtureWithdrawalDrainConnect } from '../../src/db/keepCustodyWithdrawalDrain';
import { runMigrations } from '../../src/db/migrate';
import { withdrawalAuthorizations } from '../../src/db/schema';
import { bootstrapSystemAccounts } from '../../src/ledger';
import { currentKeepMint } from '../../src/money/mintDimension';
import { requestWithdrawal, processDueWithdrawals } from '../../src/money/withdrawals';
import { ADMIN_DATABASE_URL } from '../db-url';
import { createMigratedDatabase } from '../migratedTemplate';
import { createTestPlayer, fundTestKeep } from '../helpers';

export const DRAIN_GROSS = BigInt(ECONOMY.minWithdrawKeep) * 2n;
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export function leaf(error: unknown): { code?: string; message?: string } {
  let current = error as { cause?: unknown; code?: string; message?: string };
  while (current?.cause) current = current.cause as typeof current;
  return current;
}
/** Fail immediately on a rejecting stub instead of waiting for an unreachable hook. */
export async function entered(ready: ReturnType<typeof deferred>, operation: Promise<unknown>) {
  await Promise.race([ready.promise, operation.then(() => { throw Error('fixture hook was not reached'); })]);
}

export const drainBarrier = sql`lock table public.ledger_transactions,public.accounts,public.ledger_entries,
  public.players,public.bases,public.base_slots,public.deed_ownership_observations,public.base_forge_positions,
  public.forge_contributions,public.raid_loot_reservations,public.base_raid_locks,public.mail_messages,
  public.mail_attachments,public.base_league_entitlements,public.withdrawals,public.withdrawal_attempts,
  public.withdrawal_payout_reservations,public.withdrawal_authorizations,public.deposits,public.player_items,
  public.item_listings,public.keep_custody_journal,public.mail_keep_retirements,public.keep_custody_league_bridge,
  public.keep_custody_league_weeks,public.keep_custody_league_retirements,
  public.keep_custody_withdrawal_drains,public.keep_custody_withdrawal_sources in access exclusive mode nowait`;

export async function custodyWithdrawalDrainFixture() {
  const database = `shardkeep_custody_apply_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('local fixture required');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  await createMigratedDatabase(admin, database);
  const conn = createDb(url.toString(), { max: 6 });
  const dispose = async () => {
    await conn.sql.end();
    await admin.unsafe(`drop database if exists ${database} with (force)`);
    await admin.end();
  };
  try {
    await runMigrations(conn.db);
    const sys = await bootstrapSystemAccounts(conn.db);
    const env = { HOLD_BEFORE_MIGRATE: '1', TEST_DATABASE_URL: url.toString() };
    const fixtureId = randomUUID();
    const actors: { wallet: string; keepAccountId: string; withdrawal: Awaited<ReturnType<typeof requestWithdrawal>> }[] = [];
    async function actor() {
      const player = await createTestPlayer(conn.db);
      await fundTestKeep(conn.db, player.wallet, DRAIN_GROSS, 'test.withdrawal-drain.fund', randomUUID());
      const withdrawal = await requestWithdrawal(conn.db, player.wallet, DRAIN_GROSS,
        Keypair.generate().publicKey.toBase58(), randomUUID());
      const value = { ...player, withdrawal }; actors.push(value); return value;
    }
    const first = await actor();
    let asOf: string | undefined;
    const request = (ids = actors.map(a => a.withdrawal.id)): FixtureWithdrawalDrainRequest => ({
      fixtureId, asOf: asOf ??= new Date().toISOString(), withdrawalIds: [...ids],
    });
    const apply = (input = request(), connect?: FixtureWithdrawalDrainConnect) =>
      applyFixtureUnbondingWithdrawalDrain(input, env, connect);
    const phase = async () => (await conn.sql<{ phase: string }[]>`select phase from keep_custody_cutover_state`)[0]!.phase;
    const fence = () => conn.sql`select shardkeep_advance_keep_custody_phase('open','fenced')`;
    const balance = async (kind: string, wallet: string | null = null) => {
      const [row] = await conn.sql<{ total: string }[]>`select coalesce(sum(balance),0)::text total from accounts
        where kind::text=${kind} and owner_wallet is not distinct from ${wallet}::text`;
      return BigInt(row!.total);
    };
    const snapshot = async () => JSON.stringify(await conn.sql`select
      (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
      (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) headers,
      (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries,
      (select jsonb_agg(to_jsonb(w) order by id) from withdrawals w) withdrawals,
      (select jsonb_agg(to_jsonb(a) order by id) from withdrawal_attempts a) attempts,
      (select jsonb_agg(to_jsonb(r) order by withdrawal_id) from withdrawal_payout_reservations r) reservations,
      (select phase from keep_custody_cutover_state) phase`);
    const requestGraph = async () => JSON.stringify(await conn.sql`select
      (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t where type='withdrawal.request') headers,
      (select jsonb_agg(to_jsonb(e) order by e.id) from ledger_entries e join ledger_transactions t on t.id=e.txn_id where t.type='withdrawal.request') entries`);
    const receipt = (id: string) => conn.sql`select t.id,t.type,t.idempotency_key,t.metadata,a.kind::text,a.currency::text,
      a.owner_wallet,a.base_id,e.delta::text,e.balance_after::text from ledger_transactions t
      join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id where t.id=${id} order by a.kind::text`;
    const retire = (): ReturnType<typeof applyFixtureL1Retirement> => applyFixtureL1Retirement({
      fixtureId: randomUUID(), asOf: request().asOf,
      players: actors.map(a => ({ wallet: a.wallet, keep: DRAIN_GROSS.toString(), internal: false })),
    }, env);
    // Match money.test.ts's explicit post-verifier fixture boundary. The drain
    // never accepts this gate as refund authority; the worker persists it and
    // performs its real signed-attempt, allowance and finalized accounting path.
    const authorization: Parameters<typeof processDueWithdrawals>[3] = async w => {
      const keepMint = currentKeepMint()!;
      const digest = createHash('sha256').update(`fixture-withdrawal-drain:${w.id}`).digest('hex');
      await conn.db.insert(withdrawalAuthorizations).values({ withdrawalId: w.id,
        challengeToken: 'fixture-withdrawal-drain-authorization-token', walletSignature: '2'.repeat(88),
        cluster: 'devnet', keepMint }).onConflictDoNothing();
      await conn.db.update(withdrawalAuthorizations).set({ validatedDigest: digest, validatedAt: new Date() })
        .where(and(eq(withdrawalAuthorizations.withdrawalId, w.id), isNull(withdrawalAuthorizations.validatedDigest)));
      return { ok: true, digest, cluster: 'devnet', keepMint };
    };
    const dueAt = () => new Date(Math.max(...actors.map(a => a.withdrawal.unbondsAt.getTime())) + 1);
    const worker = (sender: Parameters<typeof processDueWithdrawals>[1], reserve: Parameters<typeof processDueWithdrawals>[2] = async () => DRAIN_GROSS * BigInt(actors.length)) =>
      processDueWithdrawals(conn.db, sender, reserve, authorization, true, dueAt());
    // Only transaction() is replaced. Every nested cancellation transaction is
    // a Drizzle savepoint on this actual connection, never a second pool call.
    const wrap = (after: (tx: DbTx) => Promise<void>): FixtureWithdrawalDrainConnect => () => ({
      db: { transaction: async (callback: (tx: DbTx) => Promise<unknown>) => conn.db.transaction(async tx => {
        const result = await callback(tx); await after(tx); return result;
      }) } as unknown as Db,
      close: async () => {},
    });
    return { ...conn, database, env, sys, first, actors, actor, request, apply, phase, fence,
      balance, snapshot, requestGraph, receipt, retire, authorization, worker, wrap, dispose };
  } catch (error) { await dispose(); throw error; }
}
export type CustodyWithdrawalDrainFixture = Awaited<ReturnType<typeof custodyWithdrawalDrainFixture>>;
