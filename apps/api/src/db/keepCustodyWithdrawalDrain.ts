/** Private disposable-fixture drain only. No HTTP, CLI or worker export. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { cancelWithdrawal } from '../money/withdrawals';
import { lockWithdrawalGlobalTx, lockWithdrawalWalletTx } from '../money/withdrawalLock';
import { createDb, type Db, type DbTx } from './client';

export interface FixtureWithdrawalDrainRequest {
  fixtureId: string;
  asOf: string;
  withdrawalIds: string[];
}
export interface FixtureWithdrawalDrainResult {
  fixtureOnly: true;
  retirementAuthorized: false;
  fixtureId: string;
  /** Original completion postcondition; historical replay does not reopen W. */
  phase: 'withdrawals_closed';
  cancelled: {
    withdrawalId: string; wallet: string; keep: string;
    requestLedgerTxnId: string; cancelLedgerTxnId: string;
  }[];
  totalKeepReturned: string;
}
export type FixtureWithdrawalDrainConnect = (url: string) => { db: Db; close: () => Promise<void> };

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const requestSchema = z.object({ fixtureId: uuid, asOf: z.string().refine(value =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  withdrawalIds: z.array(uuid).min(1),
}).strict();
const positive = z.string().regex(/^[1-9][0-9]*$/);
const resultSchema = z.object({ fixtureOnly: z.literal(true), retirementAuthorized: z.literal(false),
  fixtureId: uuid, phase: z.literal('withdrawals_closed'), totalKeepReturned: positive,
  cancelled: z.array(z.object({ withdrawalId: uuid, wallet: z.string(), keep: positive,
    requestLedgerTxnId: uuid, cancelLedgerTxnId: uuid }).strict()).min(1),
}).strict();
const fail = (suffix: string): never => { throw new Error('CUSTODY_WITHDRAWAL_' + suffix); };
const read = async <T extends Record<string, unknown>>(tx: DbTx, query: ReturnType<typeof sql>) =>
  await tx.execute<T>(query) as unknown as T[];
function result(value: unknown, request: FixtureWithdrawalDrainRequest): FixtureWithdrawalDrainResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return fail('JOURNAL_CONFLICT');
  const saved = parsed.data;
  if (saved.fixtureId !== request.fixtureId || saved.cancelled.length !== request.withdrawalIds.length
    || saved.cancelled.some((row, index) => row.withdrawalId !== request.withdrawalIds[index])
    || saved.cancelled.reduce((total, row) => total + BigInt(row.keep), 0n).toString() !== saved.totalKeepReturned)
    return fail('JOURNAL_CONFLICT');
  return saved;
}

export async function applyFixtureUnbondingWithdrawalDrain(
  request: FixtureWithdrawalDrainRequest,
  env: NodeJS.ProcessEnv,
  connect: FixtureWithdrawalDrainConnect = url => {
    const connection = createDb(url, { max: 1 });
    return { db: connection.db, close: () => connection.sql.end() };
  },
): Promise<FixtureWithdrawalDrainResult> {
  // Check the disposable target before opening a connection. No production
  // URL, CLI route or operator declaration can turn this into a cutover tool.
  if (env['HOLD_BEFORE_MIGRATE'] !== '1' || !env['TEST_DATABASE_URL']) return fail('FIXTURE_REQUIRED');
  let url: URL;
  try { url = new URL(env['TEST_DATABASE_URL']); } catch { return fail('FIXTURE_REQUIRED'); }
  const database = url.pathname.slice(1);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^shardkeep_custody_apply_[0-9a-f]{32}_test$/.test(database) || url.search || url.hash)
    return fail('FIXTURE_REQUIRED');
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success || new Set(parsed.data.withdrawalIds).size !== parsed.data.withdrawalIds.length)
    return fail('INPUT_INVALID');
  // Own the entire request before the first await, including its canonical set.
  const bound = { ...parsed.data, withdrawalIds: [...parsed.data.withdrawalIds].sort() };
  const wire = JSON.stringify(bound), ids = sql.join(bound.withdrawalIds.map(id => sql`${id}::uuid`), sql`, `);
  const connection = connect(url.toString());
  try {
    if ('rollback' in connection.db) return fail('FIXTURE_REQUIRED');
    return await connection.db.transaction(async tx => {
      await tx.execute(sql`set local search_path=pg_catalog,public,pg_temp`);
      await tx.execute(sql`set local time zone 'UTC'`);
      await tx.execute(sql`select public.shardkeep_withdrawal_drain_rc()`);
      const [identity] = await read<{ database: string; operator: string; owner: boolean }>(tx, sql`
        select current_database() as database,current_user as operator,current_user=session_user and
          not exists(select 1 from pg_class where oid in ('public.keep_custody_withdrawal_drains'::regclass,
            'public.keep_custody_withdrawal_sources'::regclass,'public.keep_custody_cutover_state'::regclass)
            and relowner<>current_user::regrole::oid) as owner`);
      if (!identity?.owner || identity.database !== database) return fail('FIXTURE_REQUIRED');
      // This full NOWAIT barrier precedes every latch, domain and money lock.
      await tx.execute(sql`lock table public.ledger_transactions,public.accounts,public.ledger_entries,
        public.players,public.bases,public.base_slots,public.deed_ownership_observations,public.base_forge_positions,
        public.forge_contributions,public.raid_loot_reservations,public.base_raid_locks,public.mail_messages,
        public.mail_attachments,public.base_league_entitlements,public.withdrawals,public.withdrawal_attempts,
        public.withdrawal_payout_reservations,public.withdrawal_authorizations,public.deposits,public.player_items,
        public.item_listings,public.keep_custody_journal,public.mail_keep_retirements,public.keep_custody_league_bridge,
        public.keep_custody_league_weeks,public.keep_custody_league_retirements,
        public.keep_custody_withdrawal_drains,public.keep_custody_withdrawal_sources,
        public.keep_custody_source_observations,public.keep_custody_source_windows in access exclusive mode nowait`);
      await tx.execute(sql`select public.shardkeep_withdrawal_drain_hooks()`);
      const [saved] = await read<{ matches: boolean; result: unknown }>(tx, sql`
        select request=${wire}::jsonb and input_hash=encode(sha256(convert_to(${wire}::jsonb::text,'UTF8')),'hex')
          and operation='fixture:unbonding-withdrawal-drain' and database_name=current_database()
          and operator_name=current_user as matches,result
        from public.keep_custody_withdrawal_drains where id=${bound.fixtureId}::uuid`);
      if (saved) {
        if (!saved.matches) return fail('JOURNAL_CONFLICT');
        await tx.execute(sql`select public.shardkeep_assert_fixture_withdrawal_drain(${bound.fixtureId}::uuid)`);
        return result(saved.result, bound);
      }
      const [adopted] = await read<{ present: boolean }>(tx, sql`select exists(select 1
        from public.keep_custody_withdrawal_sources where withdrawal_id in (${ids})) as present`);
      if (adopted?.present) return fail('SOURCE_CONFLICT');
      const named = await read<{ id: string; wallet: string; amount: string; held: boolean }>(tx, sql`
        select w.id,w.player_wallet as wallet,w.amount::text as amount,
          w.status::text<>'unbonding' or w.tx_signature is not null or w.mint is not null
          or w.payout_ledger_txn_id is not null or w.refund_ledger_txn_id is not null or w.completed_at is not null
          or exists(select 1 from public.withdrawal_attempts a where a.withdrawal_id=w.id) as held
        from public.withdrawals w where w.id in (${ids}) order by w.id`);
      if (named.length !== bound.withdrawalIds.length || named.some(row => row.held)) return fail('HELD');
      const [scope] = await read<{ valid: boolean }>(tx, sql`select
        not exists(select 1 from public.withdrawals where status::text in ('unbonding','processing','failed') and id not in (${ids}))
        and not exists(select 1 from public.withdrawal_attempts where status::text in ('prepared','broadcast'))
        and not exists(select 1 from public.withdrawal_payout_reservations where status='reserved' and withdrawal_id not in (${ids})) as valid`);
      if (!scope?.valid) return fail('SCOPE_CONFLICT');
      const [opening] = await read<{ gross: string; valid: boolean }>(tx, sql`select
        (select coalesce(sum(amount),0)::text from public.withdrawals where id in (${ids})) as gross,
        (select count(*) from public.accounts where kind::text='withdrawal_escrow' and currency::text='KEEP'
          and owner_wallet is null and base_id is null)=1
        and (select balance from public.accounts where kind::text='withdrawal_escrow')=
          (select sum(amount) from public.withdrawals where id in (${ids}))
        and not exists(select 1 from public.accounts a where a.balance<>coalesce(
          (select sum(e.delta) from public.ledger_entries e where e.account_id=a.id),0)) as valid`);
      if (!opening?.valid || !positive.safeParse(opening.gross).success) return fail('SOURCE_CONFLICT');
      // Canonical advisory namespaces are defined in withdrawalLock.ts. A
      // holder that has not yet touched a table must not deadlock our barrier.
      const busy = () => { throw Object.assign(new Error('CUSTODY_WITHDRAWAL_BUSY'), { code: '55P03' }); };
      const [global] = await read<{ locked: boolean }>(tx, sql`select pg_try_advisory_xact_lock(hashtext('shardkeep:withdrawal')) as locked`);
      if (!global?.locked) busy();
      await lockWithdrawalGlobalTx(tx);
      for (const wallet of [...new Set(named.map(row => row.wallet))].sort()) {
        const [held] = await read<{ locked: boolean }>(tx, sql`select pg_try_advisory_xact_lock(
          hashtext('shardkeep:withdrawal-wallet'),hashtext(${wallet})) as locked`);
        if (!held?.locked) busy();
        await lockWithdrawalWalletTx(tx, wallet);
      }
      const [phase] = await read<{ phase: string }>(tx, sql`select phase from public.keep_custody_cutover_state where id for update`);
      if (phase?.phase !== 'fenced') return fail('PHASE_REQUIRED');
      for (const row of named) {
        await tx.execute(sql`select public.shardkeep_prepare_fixture_withdrawal_drain(
          ${row.id}::uuid,${bound.fixtureId}::uuid,${bound.asOf}::timestamptz)`);
        // This helper only calls transaction(): on DbTx that creates a nested
        // savepoint. It cannot escape this outer transaction or its rollback.
        await cancelWithdrawal(tx as unknown as Db, row.wallet, row.id, { now: new Date(bound.asOf) });
      }
      await tx.execute(sql`select public.shardkeep_withdrawal_drain_zero()`);
      await tx.execute(sql`insert into public.keep_custody_withdrawal_drains
        (id,operation,database_name,operator_name,input_hash,request,receipts,result,before_state,after_state,opening_xid)
        values(${bound.fixtureId}::uuid,'fixture:unbonding-withdrawal-drain',current_database(),current_user,
          encode(sha256(convert_to(${wire}::jsonb::text,'UTF8')),'hex'),${wire}::jsonb,
          public.shardkeep_withdrawal_drain_receipts(${bound.fixtureId}::uuid),
          public.shardkeep_withdrawal_drain_result(${bound.fixtureId}::uuid),
          jsonb_build_object('phase','fenced','unbonding',${named.length}::integer,'withdrawalEscrow',${opening.gross}::text),
          jsonb_build_object('phase','withdrawals_closed','unresolvedWithdrawals',0,'unresolvedAttempts',0,
            'reservedAllowances',0,'withdrawalEscrow','0'),txid_current())`);
      await tx.execute(sql`select public.shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`);
      await tx.execute(sql`select public.shardkeep_assert_fixture_withdrawal_drain(${bound.fixtureId}::uuid)`);
      const [completed] = await read<{ result: unknown }>(tx, sql`select result
        from public.keep_custody_withdrawal_drains where id=${bound.fixtureId}::uuid`);
      return result(completed?.result, bound);
    }, { isolationLevel: 'read committed' });
  } finally { await connection.close(); }
}
