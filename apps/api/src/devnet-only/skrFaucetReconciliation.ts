/** M1 bounded reconciliation only. No signing, no terminal verdict from time,
 * no TTL on retained park records, and no operator mutation endpoint. */
import { createHash, randomUUID } from 'node:crypto';
import { SKR_FAUCET } from '@shardkeep/shared';
import type { SkrFaucetRpc } from '@shardkeep/chain/devnet-skr-faucet-transfer';
import type { SkrAttempt, SkrGrant, SkrFaucetStore } from './skrFaucetStore';

const limits = SKR_FAUCET.devnet;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface SkrReconcileBinding { grantId: string; attemptId: string; mint: string; signature: string; wireSha256: string }
export function reconciliationBinding(grant: SkrGrant, attempt: SkrAttempt): SkrReconcileBinding {
  if (!attempt.faucetWire || !attempt.signature || attempt.grantId !== grant.id) throw new Error('SKR_RECONCILE_BINDING');
  return { grantId: grant.id, attemptId: attempt.id, mint: grant.mint, signature: attempt.signature, wireSha256: sha(attempt.faucetWire) };
}
export interface SkrReconcileStorage {
  get(key: string): Promise<string | null>;
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
}
export const SKR_RECONCILE_CAS = `local old = redis.call('GET', KEYS[1])
if (ARGV[1] == 'missing' and old ~= false) or (ARGV[1] == 'value' and old ~= ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
return 1`;
type Reason = 'pending' | 'capped' | 'incomplete' | 'scan_cap' | 'unavailable' | 'budget' | 'deadline';
type RecordValue = { version: 1; binding: string; state: 'active' | 'parked' | 'settled';
  failures: number; backoffFailures: number; nextCheckAt: number; token: string | null; lastReason: Reason | null };
type Ticket = { key: string; raw: string; value: RecordValue };
const keyFor = (binding: SkrReconcileBinding) => 'shardkeep:skr-reconcile:v1:' + sha(JSON.stringify(binding));
function parsed(raw: string | null, binding: SkrReconcileBinding): RecordValue | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as RecordValue;
    if (value.version !== 1 || value.binding !== sha(JSON.stringify(binding)) || !['active','parked','settled'].includes(value.state)
      || !Number.isSafeInteger(value.failures) || value.failures < 0 || !Number.isSafeInteger(value.nextCheckAt) || value.nextCheckAt < 0
      // Legacy control without the separate counter needs operator reconciliation;
      // do not reinterpret old outage strikes or silently reopen a parked wire.
      || !Number.isSafeInteger(value.backoffFailures) || value.backoffFailures < 0
      || !(value.token === null || typeof value.token === 'string')
      || !(value.lastReason === null || ['pending','capped','incomplete','scan_cap','unavailable','budget','deadline'].includes(value.lastReason))) return null;
    return value;
  } catch { return null; }
}
export function createSkrReconcileGate(storage: SkrReconcileStorage) {
  return {
    /** Called only for a freshly committed submitted wire, before its first send.
     * Missing state on a recovered submitted attempt is NOT initialized here. */
    async register(binding: SkrReconcileBinding, now: number) {
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('SKR_RECONCILE_CLOCK');
      const key = keyFor(binding), value: RecordValue = { version: 1, binding: sha(JSON.stringify(binding)), state: 'active',
        failures: 0, backoffFailures: 0, nextCheckAt: now, token: null, lastReason: null };
      if (await storage.compareAndSet(key, null, JSON.stringify(value))) return;
      if (!parsed(await storage.get(key), binding)) throw new Error('SKR_RECONCILE_MISSING');
    },
    async claim(binding: SkrReconcileBinding, now: number): Promise<Ticket | null> {
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('SKR_RECONCILE_CLOCK');
      const key = keyFor(binding), raw = await storage.get(key), value = parsed(raw, binding);
      // Missing/corrupt state (including Redis loss) retains the money and needs operator reconciliation.
      if (!value || value.state !== 'active' || now < value.nextCheckAt) return null;
      const next: RecordValue = { ...value, token: randomUUID(), nextCheckAt: now + limits.reconcileLeaseMs };
      const encoded = JSON.stringify(next);
      return await storage.compareAndSet(key, raw, encoded) ? { key, raw: encoded, value: next } : null;
    },
    async finish(ticket: Ticket, reason: Reason | null, now: number) {
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('SKR_RECONCILE_CLOCK');
      const reset = reason === null || reason === 'pending';
      const strike = reason === 'capped' || reason === 'incomplete' || reason === 'scan_cap';
      const failures = reset ? 0 : strike ? Math.min(limits.reconcileParkAfter, ticket.value.failures + 1) : ticket.value.failures;
      const backoffFailures = reset ? 0 : Math.min(Number.MAX_SAFE_INTEGER, ticket.value.backoffFailures + 1);
      const maxExponent = Math.ceil(Math.log2(limits.reconcileBackoffMaxMs / limits.reconcileBackoffMs));
      const value: RecordValue = { ...ticket.value, failures, backoffFailures, token: null, lastReason: reason,
        state: reason === null ? 'settled' : failures >= limits.reconcileParkAfter ? 'parked' : 'active',
        nextCheckAt: now + Math.min(limits.reconcileBackoffMaxMs, limits.reconcileBackoffMs * 2 ** Math.min(backoffFailures, maxExponent)) };
      if (!await storage.compareAndSet(ticket.key, ticket.raw, JSON.stringify(value))) throw new Error('SKR_RECONCILE_CHANGED');
    },
    async read(binding: SkrReconcileBinding) { return parsed(await storage.get(keyFor(binding)), binding); },
  };
}
export type SkrReconcileGate = ReturnType<typeof createSkrReconcileGate>;
/** Local fallback for pure callers/tests. Live worker MUST inject the retained
 * queue-Redis gate; this store intentionally offers no restart-persistence claim. */
const localGates = new WeakMap<SkrFaucetStore, SkrReconcileGate>();
export function localSkrReconcileGate(store: SkrFaucetStore): SkrReconcileGate {
  let gate = localGates.get(store);
  if (!gate) {
    const values = new Map<string, string>();
    gate = createSkrReconcileGate({ get: async (key) => values.get(key) ?? null,
      compareAndSet: async (key, before, next) => {
        if ((values.get(key) ?? null) !== before) return false; values.set(key, next); return true;
      } });
    localGates.set(store, gate);
  }
  return gate;
}
type BudgetReason = 'budget' | 'deadline' | 'scan_cap';
class SkrRpcBudgetError extends Error {
  constructor(readonly reason: BudgetReason) { super('SKR_RPC_BUDGET'); }
}
export function skrRpcBudget(clock: () => number = Date.now) {
  let remaining = limits.reconcileSweepRpcBudget;
  const deadline = clock() + limits.reconcileSweepMs;
  const take = (scanCalls?: number) => {
    // Shared exhaustion says nothing about this attempt, even if its own cap
    // happens to coincide. Only an otherwise admissible scan-cap stop strikes.
    if (remaining <= 0) throw new SkrRpcBudgetError('budget');
    if (clock() >= deadline) throw new SkrRpcBudgetError('deadline');
    if (scanCalls !== undefined && scanCalls >= limits.reconcileAttemptRpcBudget) throw new SkrRpcBudgetError('scan_cap');
    remaining--;
  };
  const wrap = (rpc: SkrFaucetRpc, before: () => void = take): SkrFaucetRpc => new Proxy(rpc, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? async (...args: unknown[]) => { before(); return Reflect.apply(value, target, args); } : value;
    },
  });
  return {
    available: () => remaining > 0 && clock() < deadline,
    wrap,
    scan(rpc: SkrFaucetRpc) {
      let calls = 0, reason: BudgetReason | null = null;
      return { rpc: wrap(rpc, () => {
        try { take(calls); calls++; }
        catch (error) { if (error instanceof SkrRpcBudgetError) reason = error.reason; throw error; }
      }), exhausted: () => reason !== null, exhaustionReason: () => reason };
    },
  };
}
export type SkrReconcileContext = { gate: SkrReconcileGate; budget: ReturnType<typeof skrRpcBudget> };
/** Explicit operator-only read: immutable transaction identifiers/hashes and
 * retained status. No wallet HTTP route, wire, key, RPC, reset or settlement. */
export async function readSkrReconciliation(store: SkrFaucetStore, gate: SkrReconcileGate, grantId: string) {
  const row = await store.readReconciliation(grantId);
  if (!row) throw new Error('SKR_RECONCILE_NOT_FOUND');
  return { grantId: row.grant.id, day: row.grant.day, mint: row.grant.mint, amountRaw: row.grant.amountRaw, status: row.grant.status,
    attempts: await Promise.all(row.attempts.filter((a) => a.faucetWire !== null).map(async (a) => {
      const binding = reconciliationBinding(row.grant, a);
      return { attemptId: a.id, phase: a.phase, signature: a.signature, reference: a.reference,
        lastValidBlockHeight: a.lastValidBlockHeight.toString(), wireSha256: binding.wireSha256,
        messageSha256: sha(a.message), control: await gate.read(binding) };
    })) };
}
