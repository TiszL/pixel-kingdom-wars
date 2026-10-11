import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { applyFixtureUnbondingWithdrawalDrain } from '../src/db/keepCustodyWithdrawalDrain';
import { cancelWithdrawal } from '../src/money/withdrawals';
import { lockWithdrawalGlobalTx, lockWithdrawalWalletTx } from '../src/money/withdrawalLock';
import { custodyWithdrawalDrainFixture, DRAIN_GROSS, deferred, entered, drainBarrier, leaf,
  type CustodyWithdrawalDrainFixture } from './fixtures/custodyWithdrawalDrain';

let f: CustodyWithdrawalDrainFixture;
let activeFixture: CustodyWithdrawalDrainFixture | undefined;
beforeEach(async () => {
  activeFixture = undefined;
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('WITHDRAWALS_ENABLED', 'true');
  vi.stubEnv('PAYOUT_COVERAGE_OVERRIDE', 'false');
  f = await custodyWithdrawalDrainFixture();
  activeFixture = f;
}, 60_000);
afterEach(async () => {
  const current = activeFixture; activeFixture = undefined;
  try { await current?.dispose(); } finally { vi.unstubAllEnvs(); }
});

describe('private withdrawal drain provenance and atomicity', () => {
  it('rolls back real nested cancellation on trailing failure and refuses both directions of orphan journal pairing', async () => {
    await f.fence();
    const request = f.request(), a = f.first, before = await f.snapshot();
    let reached = false;
    let savedJournal: Record<string, unknown> | undefined;
    await expect(f.apply(request, f.wrap(async tx => {
      const [effect] = await tx.execute<{ status: string; entries: number; keep: string; escrow: string }>(sql`
        select w.status,(select count(*)::int from ledger_entries e join ledger_transactions t on t.id=e.txn_id
          where t.idempotency_key=${`withdrawal:${a.withdrawal.id}:cancel`}) as entries,
          (select balance::text from accounts where id=${a.keepAccountId}) keep,
          (select balance::text from accounts where id=${f.sys.withdrawal_escrow}) escrow
        from withdrawals w where id=${a.withdrawal.id}`);
      expect(effect).toEqual({ status: 'cancelled', entries: 2, keep: DRAIN_GROSS.toString(), escrow: '0' });
      const [row] = await tx.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(j) row from keep_custody_withdrawal_drains j`);
      savedJournal = row!.row; reached = true; throw Error('FIXTURE_AFTER_ACTUAL_CANCEL');
    })).catch(leaf)).resolves.toMatchObject({ message: 'FIXTURE_AFTER_ACTUAL_CANCEL' });
    expect(reached).toBe(true); expect(savedJournal).toBeDefined();
    expect(await f.snapshot()).toBe(before);
    expect(await f.sql`select * from keep_custody_withdrawal_drains`).toHaveLength(0);
    expect(await f.sql`select * from keep_custody_withdrawal_sources`).toHaveLength(0);

    for (const mode of ['prepare-only', 'cancel-only', 'malformed-journal']) {
      reached = false;
      await expect(f.db.transaction(async tx => {
        await tx.execute(drainBarrier);
        await lockWithdrawalGlobalTx(tx); await lockWithdrawalWalletTx(tx, a.wallet);
        await tx.execute(sql`select public.shardkeep_prepare_fixture_withdrawal_drain(
          ${a.withdrawal.id}::uuid,${request.fixtureId}::uuid,${request.asOf}::timestamptz)`);
        if (mode !== 'prepare-only') {
          // cancelWithdrawal uses only transaction(); the nested transaction
          // is the existing DbTx savepoint, proven above by the outer rollback.
          await cancelWithdrawal(tx as unknown as Db, a.wallet, a.withdrawal.id, { now: new Date(request.asOf) });
          const [effect] = await tx.execute<{ keep: string; escrow: string; entries: number }>(sql`select
            (select balance::text from accounts where id=${a.keepAccountId}) keep,
            (select balance::text from accounts where id=${f.sys.withdrawal_escrow}) escrow,
            (select count(*)::int from ledger_entries e join ledger_transactions t on t.id=e.txn_id
              where t.idempotency_key=${`withdrawal:${a.withdrawal.id}:cancel`}) entries`);
          expect(effect).toEqual({ keep: DRAIN_GROSS.toString(), escrow: '0', entries: 2 });
        }
        if (mode === 'malformed-journal') {
          // The FK exists in this vector; only the mandatory completion
          // validator can reject its missing requested-set evidence.
          await tx.execute(sql`insert into public.keep_custody_withdrawal_drains
            select * from jsonb_populate_record(null::public.keep_custody_withdrawal_drains,
              ${JSON.stringify(savedJournal)}::jsonb || jsonb_build_object('opening_xid',txid_current(),
                'request',${JSON.stringify(savedJournal!.request)}::jsonb-'withdrawalIds'))`);
          await tx.execute(sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`);
        }
        reached = true;
        // Omit the journal or supply a real but incomplete one; never omit
        // the actual balanced money in the two cancellation vectors.
      }).catch(leaf), mode).resolves.toMatchObject(mode !== 'prepare-only'
        ? { code: 'P0001', message: 'CUSTODY_WITHDRAWAL_INCOMPLETE' }
        : { code: '23503', constraint_name: 'keep_custody_withdrawal_sources_fixture_id_fkey',
          message: 'insert or update on table "keep_custody_withdrawal_sources" violates foreign key constraint "keep_custody_withdrawal_sources_fixture_id_fkey"' });
      expect(reached).toBe(true); expect(await f.snapshot()).toBe(before);
    }
    // An authentic-looking journal copied from the aborted operation cannot
    // manufacture its absent cancellation, prepared sources or closed phase.
    await expect(f.db.transaction(async tx => {
      await tx.execute(drainBarrier);
      await tx.execute(sql`insert into public.keep_custody_withdrawal_drains
        select * from jsonb_populate_record(null::public.keep_custody_withdrawal_drains,${JSON.stringify(savedJournal)}::jsonb)`);
    }).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_WITHDRAWAL_INCOMPLETE' });
    expect(await f.snapshot()).toBe(before);
    expect((await f.apply()).cancelled).toHaveLength(1);
  });

  it('keeps exact source/journal receipts immutable against runtime roles, GUCs, TEMP hooks and missing completion guards', async () => {
    const a = f.first, role = `drain_runtime_${randomUUID().replaceAll('-', '')}`;
    let result!: Awaited<ReturnType<typeof f.apply>>, before = '';
    const frozen = { code: 'P0001', message: 'CUSTODY_WITHDRAWAL_SOURCE_FROZEN' };
    const immutable = { code: 'P0001', message: 'CUSTODY_WITHDRAWAL_JOURNAL_IMMUTABLE' };
    await f.sql.unsafe(`create role ${role}`);
    try {
      await f.sql.unsafe(`grant usage on schema public to ${role}; grant select,insert,update on accounts,ledger_transactions,ledger_entries,withdrawals to ${role}; grant select on deed_economy_cutover_state to ${role}; grant usage,select on all sequences in schema public to ${role}`);
      // Ordinary runtime DML remains usable with no private storage/helper
      // grants, including before any drain source exists.
      await f.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        const [header] = await tx<{ id: string }[]>`insert into ledger_transactions(idempotency_key,type,metadata)
          values('fixture:drain-normal-role','test.fixture.normal-role','{}') returning id`;
        for (const [id, delta] of [[f.sys.keep_genesis, -1], [f.sys.emission_pool, 1]] as const) {
          const [account] = await tx<{ balance: string }[]>`update accounts set balance=balance+${delta} where id=${id} returning balance::text`;
          await tx`insert into ledger_entries(txn_id,account_id,delta,balance_after)
            values(${header!.id},${id},${delta},${account!.balance})`;
        }
      });
      expect(await f.balance('emission_pool')).toBe(1n);
      await f.fence();
      const ready = deferred(), release = deferred();
      const stale = f.sql.begin('isolation level repeatable read', async tx => {
        // Establish the snapshot without taking a protected table lock, so
        // the real barrier can commit enrollment before this old writer acts.
        await tx`select txid_current_snapshot()`; ready.resolve(); await release.promise;
        // Insert a previously absent row, avoiding an unrelated stale-row
        // serialization error before the RC-first source hook can execute.
        await tx`insert into withdrawal_payout_reservations(withdrawal_id,player_wallet,gross_keep)
          values(${a.withdrawal.id},${a.wallet},${DRAIN_GROSS.toString()}::bigint)`;
      }).catch(leaf);
      try { await entered(ready, stale); result = await f.apply(); }
      finally { release.resolve(); }
      expect(await stale).toMatchObject({ code: 'P0001', message: 'CUSTODY_WITHDRAWAL_READ_COMMITTED_REQUIRED' });
      before = await f.snapshot();
      for (const table of ['keep_custody_withdrawal_drains', 'keep_custody_withdrawal_sources']) {
        await expect(f.sql.begin(async tx => {
          await tx.unsafe(`set local role ${role}`); await tx.unsafe(`select * from public.${table}`);
        }).catch(leaf)).resolves.toMatchObject({ code: '42501' });
      }
      await expect(f.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select set_config('shardkeep.keep_custody_cutover','operator-settle',true)`;
        await tx`select public.shardkeep_prepare_fixture_withdrawal_drain(${a.withdrawal.id}::uuid,${randomUUID()}::uuid,now())`;
      }).catch(leaf)).resolves.toMatchObject({ code: '42501' });
      await expect(f.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`update withdrawals set status='unbonding' where id=${a.withdrawal.id}`;
      }).catch(leaf)).resolves.toMatchObject(frozen);
    } finally { await f.sql.unsafe(`drop owned by ${role}; drop role ${role}`); }
    for (const setting of ['operator-settle', 'late-credit', 'withdrawal-drain']) {
      await expect(f.sql.begin(async tx => {
        await tx`select set_config('shardkeep.keep_custody_cutover',${setting},true)`;
        await tx`update ledger_transactions set metadata='{}' where id=${result.cancelled[0]!.cancelLedgerTxnId}`;
      }).catch(leaf)).resolves.toMatchObject(frozen);
    }
    for (const action of [
      'update keep_custody_withdrawal_drains set request=\'{}\'::jsonb',
      'delete from keep_custody_withdrawal_drains',
      'truncate keep_custody_withdrawal_drains cascade',
      'truncate keep_custody_withdrawal_sources cascade',
    ]) await expect(f.sql.unsafe(action).catch(leaf)).resolves.toMatchObject(immutable);
    await expect(f.sql.begin(async tx => {
      await tx`create temporary table drain_copy (like public.ledger_transactions including all) on commit drop`;
      await tx.unsafe(`create trigger a_keep_custody_withdrawal_source before insert on drain_copy for each row
        execute function public.shardkeep_withdrawal_drain_source_guard()`);
      await tx`insert into drain_copy select * from public.ledger_transactions where id=${result.cancelled[0]!.cancelLedgerTxnId}`;
    }).catch(leaf)).resolves.toMatchObject(frozen);
    for (const broken of ['disabled', 'false-qualifier', 'restricted-columns']) {
      await expect(f.sql.begin(async tx => {
        if (broken === 'disabled') await tx`alter table keep_custody_withdrawal_sources disable trigger keep_custody_withdrawal_complete`;
        else if (broken === 'restricted-columns') {
          await tx`drop trigger a_keep_custody_withdrawal_source on withdrawals`;
          await tx.unsafe(`create trigger a_keep_custody_withdrawal_source before insert or update of last_error or delete
            on withdrawals for each row execute function public.shardkeep_withdrawal_drain_source_guard()`);
        } else {
          await tx`drop trigger keep_custody_withdrawal_complete on keep_custody_withdrawal_sources`;
          await tx.unsafe(`create constraint trigger keep_custody_withdrawal_complete after insert or update
            on keep_custody_withdrawal_sources deferrable initially deferred for each row when(false)
            execute function public.shardkeep_withdrawal_drain_complete()`);
        }
        await tx`select public.shardkeep_assert_fixture_withdrawal_drain(${f.request().fixtureId}::uuid)`;
      }).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_WITHDRAWAL_HOOKS_REQUIRED' });
    }
    for (const env of [{ ...f.env, HOLD_BEFORE_MIGRATE: '0' }, { ...f.env,
      TEST_DATABASE_URL: 'postgres://example.invalid/shardkeep_custody_apply_00000000000000000000000000000000_test' }]) {
      let connected = false;
      await expect(applyFixtureUnbondingWithdrawalDrain(f.request(), env, () => {
        connected = true; throw Error('must not connect');
      }).catch(leaf)).resolves.toMatchObject({ message: 'CUSTODY_WITHDRAWAL_FIXTURE_REQUIRED' });
      expect(connected).toBe(false);
    }
    const ddl = await readFile(new URL('../drizzle/0226_keep_custody_withdrawal_drain.sql', import.meta.url), 'utf8');
    const evidence = async () => JSON.stringify(await f.sql`select
      (select jsonb_agg(to_jsonb(j) order by id) from keep_custody_withdrawal_drains j) journal,
      (select jsonb_agg(to_jsonb(s) order by withdrawal_id) from keep_custody_withdrawal_sources s) sources`);
    const originalEvidence = await evidence();
    await f.sql.begin(async tx => {
      for (const statement of ddl.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);
    });
    expect(await evidence()).toBe(originalEvidence); expect(await f.apply()).toEqual(result);
    for (const alteration of [
      'alter table keep_custody_withdrawal_sources alter column original_withdrawal drop not null',
      'alter table keep_custody_withdrawal_sources drop constraint keep_custody_withdrawal_sources_cancel_ledger_id_key',
      "comment on table keep_custody_withdrawal_drains is 'untrusted copy'",
    ]) {
      await expect(f.sql.begin(async tx => {
        await tx.unsafe(alteration);
        for (const statement of ddl.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);
      }).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_WITHDRAWAL_SCHEMA_CONFLICT' });
    }
    expect(await evidence()).toBe(originalEvidence);
    expect(await f.snapshot()).toBe(before); expect(await f.apply()).toEqual(result);
  });
});
