/** MF-1 regression tests authored before implementation. Offline CAS/RPC mocks only. */
import { describe, expect, it } from 'vitest';
import { SKR_FAUCET } from '@shardkeep/shared';
import { makeSkrFaucetService, processSkrFaucetGrant } from '../src/devnet-only/skrFaucet';
import { createSkrReconcileGate, reconciliationBinding, readSkrReconciliation, skrRpcBudget,
  type SkrReconcileBinding, type SkrReconcileStorage } from '../src/devnet-only/skrFaucetReconciliation';
import { faucet, policy, signPrepared, testRpc, testStore, wallet } from './skr-faucet-fixtures';

const limits = SKR_FAUCET.devnet;
function controlStore() {
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
async function submitted() {
  let at = new Date('2026-10-02T12:00:00Z'); const now = () => new Date(at);
  const db = testStore(at), chain = testRpc(), grant = db.makeGrant(), control = controlStore();
  const service = makeSkrFaucetService(policy, db.store, chain.rpc, { now, reference: db.reference,
    eligibility: async () => ({ reason: 'ok', deed: grant.deedAssetId }), refreshDeed: async () => grant.deedAssetId });
  const prepared = await service.prepare(wallet, grant.id);
  await service.submit(wallet, prepared.grant.attempt!.id, signPrepared(prepared.unsignedTransaction));
  const work = (budget = skrRpcBudget(() => at.getTime())) => processSkrFaucetGrant(policy, db.store,
    chain.rpc, faucet, grant.id, now, { gate: control.gate, budget });
  await work();
  const attempt = db.attempts.get(prepared.grant.attempt!.id)!;
  const binding = reconciliationBinding(grant, attempt);
  return { ...control, db, chain, grant, attempt, binding, now, work,
    advance: (ms = limits.reconcileBackoffMaxMs) => { at = new Date(at.getTime() + ms); } };
}
async function expectReservation(f: Awaited<ReturnType<typeof submitted>>) {
  const totals = await f.db.store.withGrant(f.grant.id, null, (unit) => unit.tallies(f.grant.mint, '2026-10-03'));
  expect(totals).toEqual({ reservedAllRaw: BigInt(f.grant.amountRaw), reservedDayRaw: 0n, sentTodayRaw: 0n });
  expect(f.db.attempts.get(f.attempt.id)?.phase).toBe('submitted');
  expect(f.db.attempts.get(f.attempt.id)?.faucetWire).toEqual(f.attempt.faucetWire);
  expect(f.db.attempts.size).toBe(1);
}
const fixedBinding: SkrReconcileBinding = { grantId: 'offline-grant', attemptId: 'offline-attempt', mint: 'offline-mint',
  signature: 'offline-signature', wireSha256: 'a'.repeat(64) };

describe('P5 MF-1 evidence strikes are separate from transient backoff', () => {
  it('four or more unavailable outcomes remain active through the maximum backoff and retain every reserved byte', async () => {
    const f = await submitted();
    f.chain.methods.getSignatureStatuses.mockRejectedValue(new Error('offline provider timeout'));
    f.chain.methods.sendRawTransaction.mockClear();
    const checks = Math.max(limits.reconcileParkAfter + 1,
      Math.ceil(Math.log2(limits.reconcileBackoffMaxMs / limits.reconcileBackoffMs)) + 1);
    for (let n = 0; n < checks; n++) {
      const before = f.db.events.length, checkedAt = f.now().getTime();
      await f.work();
      expect(f.db.events).toHaveLength(before);
      const retained = await f.gate.read(f.binding);
      expect(retained).toMatchObject({ state: 'active', failures: 0, lastReason: 'unavailable', backoffFailures: n + 1 });
      expect(retained!.nextCheckAt - checkedAt).toBe(Math.min(limits.reconcileBackoffMaxMs, limits.reconcileBackoffMs * 2 ** (n + 1)));
      f.advance();
    }
    expect(f.chain.methods.getSignatureStatuses).toHaveBeenCalledTimes(checks);
    expect(f.chain.methods.sendRawTransaction).not.toHaveBeenCalled();
    await expectReservation(f);
  });

  it('a submitted grant starting with one shared RPC call left backs off without a strike', async () => {
    const f = await submitted(), budget = skrRpcBudget(() => f.now().getTime());
    const earlier = budget.wrap(f.chain.rpc);
    for (let n = 0; n < limits.reconcileSweepRpcBudget - 1; n++) await earlier.getGenesisHash();
    for (const method of Object.values(f.chain.methods)) method.mockClear();
    const before = f.db.events.length;
    await f.work(budget);
    expect(f.chain.methods.getGenesisHash).toHaveBeenCalledTimes(1);
    expect(f.chain.methods.getSignatureStatuses).not.toHaveBeenCalled();
    expect(f.db.events).toHaveLength(before);
    expect(await f.gate.read(f.binding)).toMatchObject({ state: 'active', failures: 0, backoffFailures: 1, lastReason: 'budget' });
    await expectReservation(f);
  });

  it('a sweep deadline reached during an in-flight call backs off without a strike or another RPC start', async () => {
    const f = await submitted(); let clock = 0;
    const genesis = await f.chain.rpc.getGenesisHash();
    f.chain.methods.getGenesisHash.mockImplementation(async () => { clock = limits.reconcileSweepMs; return genesis; });
    for (const method of Object.values(f.chain.methods)) method.mockClear();
    await f.work(skrRpcBudget(() => clock));
    expect(f.chain.methods.getGenesisHash).toHaveBeenCalledTimes(1);
    expect(f.chain.methods.getSignatureStatuses).not.toHaveBeenCalled();
    expect(await f.gate.read(f.binding)).toMatchObject({ state: 'active', failures: 0, backoffFailures: 1, lastReason: 'deadline' });
    await expectReservation(f);
  });

  it('three per-attempt scan caps park while preserving floor liability and the only signed attempt', async () => {
    const f = await submitted(); f.chain.state.height = 201;
    f.chain.methods.getSignaturesForAddress.mockImplementation(async (_key, options) =>
      Array.from({ length: options!.limit! }, (_, i) => ({ signature: 'offline-cap-' + i, slot: 100,
        err: null, memo: null, blockTime: 1, confirmationStatus: 'finalized' })));
    for (let n = 0; n < limits.reconcileParkAfter; n++) {
      for (const method of Object.values(f.chain.methods)) method.mockClear();
      const before = f.db.events.length;
      await f.work();
      expect(Object.values(f.chain.methods).reduce((sum, method) => sum + method.mock.calls.length, 0)).toBe(limits.reconcileAttemptRpcBudget);
      expect(f.db.events).toHaveLength(before);
      expect(await f.gate.read(f.binding)).toMatchObject({ failures: n + 1, lastReason: 'scan_cap',
        state: n + 1 === limits.reconcileParkAfter ? 'parked' : 'active' });
      f.advance();
    }
    for (const method of Object.values(f.chain.methods)) method.mockClear();
    await f.work();
    expect(Object.values(f.chain.methods).every((method) => method.mock.calls.length === 0)).toBe(true);
    const read = await readSkrReconciliation(f.db.store, createSkrReconcileGate(f.backend), f.grant.id);
    expect(read.attempts[0]?.control).toMatchObject({ state: 'parked', failures: limits.reconcileParkAfter, lastReason: 'scan_cap' });
    expect(JSON.stringify(read)).not.toContain(f.attempt.faucetWire!.toString('base64'));
    await expectReservation(f);
  });

  it('a shared limit takes precedence over a simultaneous per-attempt cap', async () => {
    const chain = testRpc(), budget = skrRpcBudget(() => 0), other = budget.wrap(chain.rpc);
    for (let n = 0; n < limits.reconcileSweepRpcBudget - limits.reconcileAttemptRpcBudget; n++) await other.getGenesisHash();
    const scan = budget.scan(chain.rpc);
    for (let n = 0; n < limits.reconcileAttemptRpcBudget; n++) await scan.rpc.getGenesisHash();
    await expect(scan.rpc.getGenesisHash()).rejects.toThrow('SKR_RPC_BUDGET');
    expect(scan.exhausted()).toBe(true);
    expect(scan.exhaustionReason()).toBe('budget');
    expect(chain.methods.getGenesisHash).toHaveBeenCalledTimes(limits.reconcileSweepRpcBudget);
  });

  it('the backoff counter survives restart without turning transient results into evidence strikes', async () => {
    const f = controlStore(); let now = 0;
    await f.gate.register(fixedBinding, now);
    const transient = ['unavailable', 'budget', 'deadline', 'unavailable'] as const;
    for (let n = 0; n < transient.length; n++) {
      const gate = createSkrReconcileGate(f.backend), ticket = await gate.claim(fixedBinding, now);
      expect(ticket).not.toBeNull();
      await gate.finish(ticket!, transient[n]!, now);
      const value = await gate.read(fixedBinding);
      expect(value).toMatchObject({ state: 'active', failures: 0, backoffFailures: n + 1 });
      now = value!.nextCheckAt;
    }
    const ticket = await f.gate.claim(fixedBinding, now);
    await f.gate.finish(ticket!, 'incomplete', now);
    expect(await f.gate.read(fixedBinding)).toMatchObject({ state: 'active', failures: 1 });
  });

  it('capped and incomplete observations still strike, and pending resets both counters', async () => {
    for (const reason of ['capped', 'incomplete'] as const) {
      const f = controlStore(); let now = 0;
      await f.gate.register(fixedBinding, now);
      for (let n = 0; n < limits.reconcileParkAfter - 1; n++) {
        const ticket = await f.gate.claim(fixedBinding, now); await f.gate.finish(ticket!, reason, now);
        now = (await f.gate.read(fixedBinding))!.nextCheckAt;
      }
      const pending = await f.gate.claim(fixedBinding, now); await f.gate.finish(pending!, 'pending', now);
      const value = await f.gate.read(fixedBinding);
      expect(value).toMatchObject({ state: 'active', failures: 0, backoffFailures: 0, lastReason: 'pending' });
      expect(value!.nextCheckAt - now).toBe(limits.reconcileBackoffMs);
    }
  });

  it('transient observations do not erase earlier evidence strikes or allow a parked record to reopen', async () => {
    const f = controlStore(); let now = 0;
    await f.gate.register(fixedBinding, now);
    for (let n = 0; n < limits.reconcileParkAfter; n++) {
      const ticket = await f.gate.claim(fixedBinding, now); await f.gate.finish(ticket!, 'incomplete', now);
      now = (await f.gate.read(fixedBinding))!.nextCheckAt;
      if (n + 1 < limits.reconcileParkAfter) {
        const unavailable = await f.gate.claim(fixedBinding, now); await f.gate.finish(unavailable!, 'unavailable', now);
        expect(await f.gate.read(fixedBinding)).toMatchObject({ state: 'active', failures: n + 1 });
        now = (await f.gate.read(fixedBinding))!.nextCheckAt;
      }
    }
    await f.gate.register(fixedBinding, now);
    expect(await f.gate.claim(fixedBinding, now)).toBeNull();
    expect(await f.gate.read(fixedBinding)).toMatchObject({ state: 'parked', failures: limits.reconcileParkAfter });
  });

  it('legacy or malformed backoff counters fail closed without rebuilding control or freeing submitted money', async () => {
    const f = await submitted(), [key, raw] = [...f.values.entries()][0]!;
    for (const counter of [undefined, -1, '1', Number.MAX_SAFE_INTEGER + 1]) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (counter === undefined) delete value.backoffFailures; else value.backoffFailures = counter;
      f.values.set(key, JSON.stringify(value));
      for (const method of Object.values(f.chain.methods)) method.mockClear();
      await f.work();
      expect(await f.gate.read(f.binding)).toBeNull();
      expect(Object.values(f.chain.methods).every((method) => method.mock.calls.length === 0)).toBe(true);
      expect(f.values.get(key)).toBe(JSON.stringify(value));
      await expectReservation(f);
    }
  });
});
