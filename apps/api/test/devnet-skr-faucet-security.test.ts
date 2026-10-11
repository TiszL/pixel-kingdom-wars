/** Author4 M1/M2 tests first. Offline mocks; not a Redis/Postgres proof. */
import { describe, expect, it } from 'vitest';
import { SKR_FAUCET } from '@shardkeep/shared';
import { makeSkrFaucetService, processSkrFaucetGrant, treasuryAdmission } from '../src/devnet-only/skrFaucet';
import { createSkrReconcileGate, skrRpcBudget, reconciliationBinding, readSkrReconciliation,
  type SkrReconcileStorage } from '../src/devnet-only/skrFaucetReconciliation';
import { faucet, policy, signPrepared, testRpc, testStore, wallet } from './skr-faucet-fixtures';

function storage() {
  const values = new Map<string, string>();
  const backend: SkrReconcileStorage = {
    get: async (key) => values.get(key) ?? null,
    compareAndSet: async (key, expected, next) => {
      if ((values.get(key) ?? null) !== expected) return false;
      values.set(key, next); return true;
    },
  };
  return { values, backend, gate: createSkrReconcileGate(backend) };
}
async function fixture() {
  let at = new Date('2026-10-02T12:00:00Z'); const now = () => new Date(at);
  const db = testStore(at), chain = testRpc(), grant = db.makeGrant(), control = storage();
  const service = makeSkrFaucetService(policy, db.store, chain.rpc, { now, reference: db.reference,
    eligibility: async () => ({ reason: 'ok', deed: grant.deedAssetId }), refreshDeed: async () => grant.deedAssetId });
  const prepared = await service.prepare(wallet, grant.id);
  await service.submit(wallet, prepared.grant.attempt!.id, signPrepared(prepared.unsignedTransaction));
  const work = (budget = skrRpcBudget(() => at.getTime())) => processSkrFaucetGrant(policy, db.store, chain.rpc,
    faucet, grant.id, now, { gate: control.gate, budget });
  await work();
  const attempt = db.attempts.get(prepared.grant.attempt!.id)!;
  return { ...control, db, chain, grant, attempt, now, work,
    advance: (ms = SKR_FAUCET.devnet.reconcileBackoffMaxMs) => { at = new Date(at.getTime() + ms); } };
}

describe('P5 M1 retained reconciliation isolation', () => {
  it('reads outcome RPC outside every DB transaction and settles without the mint lock', async () => {
    const f = await fixture(); const lockArgs: Array<string | undefined> = [];
    const original = f.db.store.withGrant;
    f.db.store.withGrant = async (id, owner, run, mint) => { lockArgs.push(mint); return original(id, owner, run, mint); };
    f.chain.methods.getSignatureStatuses.mockImplementation(async () => {
      expect(f.db.events.at(-1)).toBe('commit'); expect(lockArgs).toHaveLength(0);
      return { context: { slot: 105 }, value: [{ slot: 101, confirmations: null, err: null, confirmationStatus: 'finalized' }] };
    });
    await f.work(); expect(lockArgs).toEqual([undefined]);
    expect(f.db.grants.get(f.grant.id)?.status).toBe('sent');
  });
  it('a capped budget backs off with zero RPC and no transaction on the immediate second sweep', async () => {
    const f = await fixture(); f.chain.state.height = 201;
    f.chain.methods.getSignaturesForAddress.mockImplementation(async (_key, options) =>
      Array.from({ length: options?.limit ?? 16 }, (_, i) => ({ signature: 'spam-'+i, slot: 100, err: null, memo: null, blockTime: 1, confirmationStatus: 'finalized' })));
    await f.work(); const before = f.db.events.length;
    for (const method of Object.values(f.chain.methods)) method.mockClear();
    await f.work();
    expect(Object.values(f.chain.methods).every((method) => method.mock.calls.length === 0)).toBe(true);
    expect(f.db.events).toHaveLength(before); expect(f.db.attempts.get(f.attempt.id)?.phase).toBe('submitted');
  });
  it('parks repeated bounded/incomplete scans, survives a gate restart and retains floor liability', async () => {
    const f = await fixture(); f.chain.state.height = 201;
    f.chain.methods.getSignaturesForAddress.mockResolvedValue([{ signature: 'incomplete', slot: 100, err: null, memo: null, blockTime: 1, confirmationStatus: 'finalized' }]);
    for (let n = 0; n < SKR_FAUCET.devnet.reconcileParkAfter; n++) { await f.work(); f.advance(); }
    const restarted = createSkrReconcileGate(f.backend);
    expect(await restarted.claim(reconciliationBinding(f.grant, f.attempt), f.now().getTime())).toBeNull();
    const read = await readSkrReconciliation(f.db.store, restarted, f.grant.id);
    expect(read.attempts[0]?.control?.state).toBe('parked');
    expect(JSON.stringify(read)).not.toContain(f.attempt.faucetWire!.toString('base64'));
    const totals = await f.db.store.withGrant(f.grant.id, null, (unit) => unit.tallies(f.grant.mint, '2026-10-03'));
    expect(totals.reservedAllRaw).toBe(BigInt(f.grant.amountRaw)); expect(totals.reservedDayRaw).toBe(0n);
    expect(f.db.attempts.get(f.attempt.id)?.faucetWire).toEqual(f.attempt.faucetWire);
  });
  it('a missing, malformed or unavailable retained gate refuses scanning and never frees submitted money', async () => {
    const f = await fixture(); const original = new Map(f.values);
    for (const replacement of [null, '{bad-json']) {
      f.values.clear(); if (replacement) for (const key of original.keys()) f.values.set(key, replacement);
      const before = f.chain.methods.getGenesisHash.mock.calls.length;
      await f.work(); expect(f.chain.methods.getGenesisHash).toHaveBeenCalledTimes(before);
      expect(f.db.attempts.get(f.attempt.id)?.phase).toBe('submitted');
    }
    const broken = createSkrReconcileGate({ get: async () => { throw new Error('private redis'); }, compareAndSet: async () => false });
    await expect(processSkrFaucetGrant(policy, f.db.store, f.chain.rpc, faucet, f.grant.id, f.now,
      { gate: broken, budget: skrRpcBudget() })).rejects.toThrow();
    expect(f.db.attempts.get(f.attempt.id)?.phase).toBe('submitted');
  });
  it('cannot apply an outside-lock outcome to a replaced or already terminal attempt', async () => {
    for (const replacement of ['signature', 'terminal'] as const) {
      const f = await fixture();
      f.chain.methods.getSignatureStatuses.mockImplementation(async () => {
        f.db.attempts.set(f.attempt.id, replacement === 'signature'
          ? { ...f.attempt, signature: 'replacement' } : { ...f.attempt, phase: 'failed', settledAt: f.now() });
        return { context: { slot: 105 }, value: [{ slot: 101, confirmations: null, err: null, confirmationStatus: 'finalized' }] };
      });
      await f.work(); expect(f.db.grants.get(f.grant.id)?.status).toBe('requested');
      expect(f.db.attempts.get(f.attempt.id)?.phase).toBe(replacement === 'signature' ? 'submitted' : 'failed');
    }
  });
  it('bounds all RPC methods across a shared sweep and separately bounds one scan', async () => {
    let clock = 0; const chain = testRpc(), budget = skrRpcBudget(() => clock);
    const rpc = budget.wrap(chain.rpc);
    for (let n = 0; n < SKR_FAUCET.devnet.reconcileSweepRpcBudget; n++) await rpc.getGenesisHash();
    await expect(rpc.getGenesisHash()).rejects.toThrow('SKR_RPC_BUDGET');
    expect(chain.methods.getGenesisHash).toHaveBeenCalledTimes(SKR_FAUCET.devnet.reconcileSweepRpcBudget);
    const timed = skrRpcBudget(() => clock).wrap(chain.rpc); clock = SKR_FAUCET.devnet.reconcileSweepMs;
    await expect(timed.getGenesisHash()).rejects.toThrow('SKR_RPC_BUDGET');
    const limited = skrRpcBudget(() => 0).scan(chain.rpc);
    for (let n = 0; n < SKR_FAUCET.devnet.reconcileAttemptRpcBudget; n++) await limited.rpc.getGenesisHash();
    await expect(limited.rpc.getGenesisHash()).rejects.toThrow('SKR_RPC_BUDGET'); expect(limited.exhausted()).toBe(true);
  });
  it('claims one cross-worker ticket and refuses stale finish or changed immutable binding', async () => {
    const f = await fixture(), binding = reconciliationBinding(f.grant, f.attempt);
    const [one, two] = await Promise.all([f.gate.claim(binding, f.now().getTime()), f.gate.claim(binding, f.now().getTime())]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    const ticket = one ?? two!; await f.gate.finish(ticket, 'incomplete', f.now().getTime());
    await expect(f.gate.finish(ticket, null, f.now().getTime())).rejects.toThrow('SKR_RECONCILE_CHANGED');
    expect(await f.gate.claim({ ...binding, wireSha256: 'f'.repeat(64) }, f.now().getTime())).toBeNull();
  });
});

describe('P5 M2 day-bound reservation accounting', () => {
  it('a prior-day submitted amount lowers floor headroom but never consumes today budget', async () => {
    const f = await fixture();
    const totals = await f.db.store.withGrant(f.grant.id, null, (unit) => unit.tallies(f.grant.mint, '2026-10-03'));
    expect(totals).toEqual({ reservedAllRaw: 1_000_000_000n, reservedDayRaw: 0n, sentTodayRaw: 0n });
    expect(treasuryAdmission({ ...totals, decimals: 6, balanceRaw: 3_000_000_000n, floorSkr: 1000, dailyBudgetSkr: 1000 })).toBe('ok');
    expect(treasuryAdmission({ ...totals, decimals: 6, balanceRaw: 2_999_999_999n, floorSkr: 1000, dailyBudgetSkr: 1000 })).toBe('treasury_low');
    const today = await f.db.store.withGrant(f.grant.id, null, (unit) => unit.tallies(f.grant.mint, '2026-10-02'));
    expect(today.reservedDayRaw).toBe(1_000_000_000n);
    expect(treasuryAdmission({ ...today, decimals: 6, balanceRaw: 3_000_000_000n, floorSkr: 1000, dailyBudgetSkr: 1000 })).toBe('daily_budget');
  });
});
