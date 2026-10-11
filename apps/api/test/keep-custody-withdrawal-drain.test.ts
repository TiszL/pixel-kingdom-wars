import { randomUUID } from 'node:crypto';
import { GEMS } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spendGems } from '../src/game/spend';
import { postTransaction } from '../src/ledger';
import { cancelWithdrawal } from '../src/money/withdrawals';
import { lockWithdrawalGlobalTx } from '../src/money/withdrawalLock';
import { makeTestKeepSender, FINALITY_PENDING } from './withdrawalSender';
import { custodyWithdrawalDrainFixture, DRAIN_GROSS, deferred, entered, leaf,
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
const refused = (message: string) => ({ message });

describe('private pre-F unbonding withdrawal drain', () => {
  it('actually cancels coverage-held gross, releases its allowance, then retires L1 with exact G8 backing and no fee', async () => {
    const a = f.first;
    const prepare = vi.fn();
    expect(await f.worker(makeTestKeepSender({ prepare }), null)).toMatchObject({ sent: 0, failed: 0, held: 1 });
    expect(prepare).not.toHaveBeenCalled();
    await f.sql`select shardkeep_reserve_withdrawal_allowance(${a.withdrawal.id}::uuid,${a.wallet},${DRAIN_GROSS.toString()}::bigint,${DRAIN_GROSS.toString()}::bigint)`;
    const originalWithdrawal = (await f.sql`select to_jsonb(w) row from withdrawals w where id=${a.withdrawal.id}`)[0]!.row;
    const original = await f.requestGraph(); await f.fence();
    const result = await f.apply();
    expect(result).toEqual({ fixtureOnly: true, retirementAuthorized: false, fixtureId: f.request().fixtureId,
      phase: 'withdrawals_closed', totalKeepReturned: DRAIN_GROSS.toString(), cancelled: [{
        withdrawalId: a.withdrawal.id, wallet: a.wallet, keep: DRAIN_GROSS.toString(),
        requestLedgerTxnId: a.withdrawal.requestLedgerTxnId, cancelLedgerTxnId: expect.any(String),
      }] });
    expect(await f.phase()).toBe('withdrawals_closed');
    const terminal = (await f.sql`select to_jsonb(w) row,completed_at=${f.request().asOf}::timestamptz exact_time
      from withdrawals w where id=${a.withdrawal.id}`)[0]!;
    expect(terminal.row).toEqual({ ...originalWithdrawal, status: 'cancelled', completed_at: terminal.row.completed_at });
    expect(terminal.exact_time).toBe(true);
    expect(await f.balance('withdrawal_escrow')).toBe(0n);
    expect(await f.balance('player_keep', a.wallet)).toBe(DRAIN_GROSS);
    expect(await f.balance('burn')).toBe(0n); expect(await f.balance('onchain_outflow')).toBe(0n);
    expect(await f.sql`select status from withdrawal_payout_reservations where withdrawal_id=${a.withdrawal.id}`)
      .toEqual([{ status: 'released' }]);
    expect(await f.sql`select * from withdrawal_attempts`).toHaveLength(0);
    const legs = await f.receipt(result.cancelled[0]!.cancelLedgerTxnId);
    expect(legs.map(r => [r.kind, r.currency, r.owner_wallet, r.base_id, r.delta])).toEqual([
      ['player_keep', 'KEEP', a.wallet, null, DRAIN_GROSS.toString()],
      ['withdrawal_escrow', 'KEEP', null, null, (-DRAIN_GROSS).toString()],
    ]);
    expect(legs.every(r => r.type === 'withdrawal.cancel' && r.idempotency_key === `withdrawal:${a.withdrawal.id}:cancel`)).toBe(true);
    expect(legs.map(r => r.metadata)).toEqual(Array(2).fill({ wallet: a.wallet, withdrawalId: a.withdrawal.id }));
    expect(await f.requestGraph()).toBe(original);
    const retirement = await f.retire();
    expect(retirement).toMatchObject({ fixtureOnly: true, retirementAuthorized: false, measuredG8: true,
      totalKeepConverted: DRAIN_GROSS.toString(), sweptInternalKeep: '0' });
    expect(await f.balance('player_keep', a.wallet)).toBe(0n);
    expect(await f.balance('player_gems', a.wallet)).toBe(DRAIN_GROSS * BigInt(GEMS.gemsPerKeep));
    expect(await f.balance('emission_pool')).toBe(DRAIN_GROSS);
    expect(await f.balance('burn')).toBe(0n); expect(await f.balance('onchain_outflow')).toBe(0n);
    expect(await f.phase()).toBe('frozen');
  });

  it('recovers the immutable complete batch after retirement and Gems spending without another cancellation', async () => {
    await f.actor(); await f.fence();
    const request = f.request(f.actors.map(a => a.withdrawal.id).reverse());
    const result = await f.apply(request);
    expect(result.cancelled.map(r => r.withdrawalId)).toEqual([...request.withdrawalIds].sort());
    expect(result.totalKeepReturned).toBe((2n * DRAIN_GROSS).toString());
    await f.retire(); await spendGems(f.db, f.first.wallet, 1n, 'fixture.drain.gems-spend', randomUUID());
    const before = await f.snapshot();
    expect(await f.apply({ ...request, withdrawalIds: [...request.withdrawalIds].reverse() })).toEqual(result);
    expect(await f.snapshot()).toBe(before);
    expect(await f.sql`select * from ledger_transactions where type='withdrawal.cancel'`).toHaveLength(2);
    await expect(f.apply({ ...request, asOf: new Date(Date.parse(request.asOf) + 1).toISOString() }).catch(leaf))
      .resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_JOURNAL_CONFLICT'));
    await expect(f.apply({ ...request, fixtureId: randomUUID() }).catch(leaf))
      .resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_SOURCE_CONFLICT'));
    expect(await f.snapshot()).toBe(before);
  });

  it('rolls back a named subset and unexplained escrow rather than claiming whole withdrawal closure', async () => {
    await f.actor(); await f.fence();
    let before = await f.snapshot();
    await expect(f.apply(f.request([f.first.withdrawal.id])).catch(leaf))
      .resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_SCOPE_CONFLICT'));
    expect(await f.snapshot()).toBe(before); expect(await f.phase()).toBe('fenced');
    const extra = await postTransaction(f.db, { idempotencyKey: randomUUID(), type: 'fixture.unexplained-escrow',
      entries: [{ account: f.sys.keep_genesis, delta: -1n }, { account: f.sys.withdrawal_escrow, delta: 1n }] });
    before = await f.snapshot();
    await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_SOURCE_CONFLICT'));
    expect(await f.snapshot()).toBe(before);
    await postTransaction(f.db, { idempotencyKey: `${extra.transaction.id}:compensate`, type: 'fixture.compensate',
      entries: [{ account: f.sys.withdrawal_escrow, delta: -1n }, { account: f.sys.keep_genesis, delta: 1n }] });
    expect((await f.apply()).cancelled).toHaveLength(2);
  });

  it('holds legacy processing, ambiguous failed and sent rows without using state labels as absence proof', async () => {
    const w = f.first.withdrawal;
    await f.fence();
    for (const status of ['processing', 'failed', 'sent'] as const) {
      // Controlled legacy lifecycle corruption is the adversarial premise;
      // no attempt absence, null signature or old maturity authorizes a refund.
      await f.sql`update withdrawals set status=${status},last_error='legacy unknown outcome',tx_signature=null where id=${w.id}`;
      const before = await f.snapshot();
      await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_HELD'));
      expect(await f.snapshot()).toBe(before);
      await expect(f.sql.begin(async tx => {
        await tx`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`;
        await tx`select shardkeep_advance_keep_custody_phase('withdrawals_closed','frozen')`;
      }).catch(leaf))
        .resolves.toMatchObject({ code: 'P0001', message: 'KEEP_CUSTODY_LIABILITY_NONZERO' });
      expect(await f.phase()).toBe('fenced');
    }
  });

  it('rejects changed original request graphs and occupied cancellation keys, including already-cancelled rows', async () => {
    const a = f.first, w = a.withdrawal;
    await f.fence();
    const [original] = await f.sql<{ metadata: Record<string, unknown> }[]>`select metadata from ledger_transactions where id=${w.requestLedgerTxnId}`;
    await f.sql`update ledger_transactions set metadata=metadata||'{"destination":"not-original"}'::jsonb where id=${w.requestLedgerTxnId}`;
    let before = await f.snapshot();
    await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_SOURCE_CONFLICT'));
    expect(await f.snapshot()).toBe(before);
    await f.sql`update ledger_transactions set metadata=${JSON.stringify(original!.metadata)}::jsonb where id=${w.requestLedgerTxnId}`;
    await f.sql`update withdrawals set amount=amount+1 where id=${w.id}`;
    before = await f.snapshot();
    await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_SOURCE_CONFLICT'));
    expect(await f.snapshot()).toBe(before);
    await f.sql`update withdrawals set amount=${DRAIN_GROSS.toString()}::bigint where id=${w.id}`;
    for (const kind of ['cancel', 'refund', 'payout']) {
      const [collision] = await f.sql<{ id: string }[]>`insert into ledger_transactions(idempotency_key,type,metadata)
        values(${`withdrawal:${w.id}:${kind}`},${`withdrawal.${kind}`},${JSON.stringify({ wallet: a.wallet, withdrawalId: w.id })}::jsonb) returning id`;
      before = await f.snapshot();
      await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_SOURCE_CONFLICT'));
      expect(await f.snapshot()).toBe(before);
      // Remove the fixture-only collision row so the later genuine cancel can claim its key.
      // 0302 (K-night-E1) fixed the 0267 guard that silently skipped this DELETE; every ledger
      // guard runs, and the row must really be gone (a swallowed delete would leave it behind).
      expect((await f.sql`delete from ledger_transactions where id=${collision!.id}`).count).toBe(1);
      expect(await f.sql`select id from ledger_transactions where id=${collision!.id}`).toEqual([]);
    }
    await cancelWithdrawal(f.db, a.wallet, w.id);
    before = await f.snapshot();
    await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_HELD'));
    expect(await f.snapshot()).toBe(before);
    expect(await f.sql`select * from keep_custody_withdrawal_drains`).toHaveLength(0);
  });

  it('wins against a genuinely prepared-but-unpersisted worker without exposing or paying that stale candidate', async () => {
    await f.fence();
    const ready = deferred(), release = deferred();
    const broadcast = vi.fn();
    const work = f.worker(makeTestKeepSender({ prepare: async () => { ready.resolve(); await release.promise; },
      broadcast, reconcile: async () => FINALITY_PENDING }));
    let result;
    try {
      await entered(ready, work);
      expect(await f.sql`select * from withdrawal_attempts`).toHaveLength(0);
      expect(await f.sql`select status from withdrawal_payout_reservations`).toEqual([{ status: 'reserved' }]);
      result = await f.apply();
    } finally { release.resolve(); await work; }
    expect(result!.cancelled).toHaveLength(1);
    expect(broadcast).not.toHaveBeenCalled();
    expect(await f.sql`select * from withdrawal_attempts`).toHaveLength(0);
    expect(await f.balance('player_keep', f.first.wallet)).toBe(DRAIN_GROSS);
    expect(await f.balance('withdrawal_escrow')).toBe(0n);
    expect(await f.balance('onchain_outflow')).toBe(0n);
  });

  it('holds actual prepared/broadcast payout evidence and lets its original finalized payout win once', async () => {
    await f.fence();
    // Stop the actual worker after its prepared commit, before the broadcast
    // diagnostic update, by rejecting that UPDATE in a fixture-only trigger.
    await f.sql.unsafe(`create function fixture_stop_broadcast() returns trigger language plpgsql as $$begin
      if new.status::text='broadcast' then raise exception 'FIXTURE_PREPARED_COMMITTED'; end if; return new; end$$;
      create trigger z_fixture_stop_broadcast before update on withdrawal_attempts for each row execute function fixture_stop_broadcast()`);
    await expect(f.worker(makeTestKeepSender()).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'FIXTURE_PREPARED_COMMITTED' });
    await f.sql.unsafe('drop trigger z_fixture_stop_broadcast on withdrawal_attempts; drop function fixture_stop_broadcast()');
    expect(await f.sql`select status from withdrawal_attempts`).toEqual([{ status: 'prepared' }]);
    let before = await f.snapshot();
    await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_HELD'));
    expect(await f.snapshot()).toBe(before);
    expect(await f.worker(makeTestKeepSender({ reconcile: async () => FINALITY_PENDING }))).toMatchObject({ held: 1 });
    expect(await f.sql`select status from withdrawal_attempts`).toEqual([{ status: 'broadcast' }]);
    before = await f.snapshot();
    await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_HELD'));
    expect(await f.snapshot()).toBe(before);
    expect(await f.worker(makeTestKeepSender({ reconcile: async () => ({
      status: 'expired_unresolved', sources: ['fixture-pruned-a', 'fixture-pruned-b'],
    }) }))).toMatchObject({ held: 1 });
    before = await f.snapshot();
    await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_HELD'));
    expect(await f.snapshot()).toBe(before);
    expect(await f.worker(makeTestKeepSender())).toMatchObject({ sent: 1 });
    expect(await f.balance('withdrawal_escrow')).toBe(0n);
    expect(await f.balance('player_keep', f.first.wallet)).toBe(0n);
    expect(await f.balance('onchain_outflow')).toBe(DRAIN_GROSS - f.first.withdrawal.feeBurned);
    expect(await f.balance('burn')).toBe(f.first.withdrawal.feeBurned);
    expect(await f.sql`select * from ledger_transactions where type='withdrawal.cancel'`).toHaveLength(0);
    await expect(f.apply().catch(leaf)).resolves.toMatchObject(refused('CUSTODY_WITHDRAWAL_HELD'));
  });

  it('serializes drain with duplicate callers and the actual freeze barrier, then replays after the winning freeze', async () => {
    await f.fence();
    // A request can hold the advisory key before its first table access. The
    // drain's table barrier must not then wait on that key and deadlock it.
    const advisoryReady = deferred(), advisoryRelease = deferred();
    const advisory = f.db.transaction(async tx => {
      await lockWithdrawalGlobalTx(tx); advisoryReady.resolve(); await advisoryRelease.promise;
    });
    try {
      await entered(advisoryReady, advisory);
      const before = await f.snapshot();
      await expect(f.apply().catch(leaf)).resolves.toMatchObject({ code: '55P03' });
      expect(await f.snapshot()).toBe(before);
    } finally { advisoryRelease.resolve(); await advisory; }
    const ready = deferred(), release = deferred();
    const drain = f.apply(f.request(), f.wrap(async tx => {
      expect((await tx.execute<{ phase: string }>(sql`select phase from keep_custody_cutover_state`))[0]!.phase).toBe('withdrawals_closed');
      ready.resolve(); await release.promise;
    }));
    let result;
    try {
      await entered(ready, drain);
      await expect(f.apply().catch(leaf)).resolves.toMatchObject({ code: '55P03' });
      await expect(f.sql`select shardkeep_advance_keep_custody_phase('withdrawals_closed','frozen')`.catch(leaf))
        .resolves.toMatchObject({ code: '55P03' });
    } finally { release.resolve(); result = await drain; }
    const before = await f.snapshot();
    expect(await f.apply()).toEqual(result); expect(await f.snapshot()).toBe(before);
    await f.retire();
    expect(await f.apply()).toEqual(result);
    expect(await f.sql`select * from ledger_transactions where type='withdrawal.cancel'`).toHaveLength(1);
  });
});
