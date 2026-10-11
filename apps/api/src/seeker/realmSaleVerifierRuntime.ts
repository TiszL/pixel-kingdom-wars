/** Process-owned original realm-sale finality. No signer, relay or request capability.
 * Held originals advance the scan cursor and are retried after wraparound. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import type { SeekerRealmSaleFinalityRpc } from '@shardkeep/chain/seeker-realm-sale-finality';
import type { SeekerRealmAccessTrust } from '@shardkeep/chain/seeker-realm-access-snapshot';
import { createDb } from '../db/client';
import { createRealmSaleSettlement } from './realmSaleSettlement';
import { createRealmSaleFailure } from './realmSaleFailure';

export interface RealmSaleVerifierSources {
  receiptSource(signal: AbortSignal): SeekerRealmSaleFinalityRpc;
  trust: SeekerRealmAccessTrust;
}
interface Cursor { wallet: string; idempotencyKey: string }
interface Candidate extends Cursor, Record<string, unknown> {}
export interface RealmSaleVerificationCounts { examined: number; settled: number; failed: number; held: number }
// Operational I/O limits; these do not change a gameplay reward or claim cap.
const BATCH_SIZE = 8, INTERVAL_MS = 15_000, TIMEOUT_MS = 30_000;

export async function createRealmSaleVerifierRuntime(databaseUrl: string, sources: RealmSaleVerifierSources,
  options: { batchSize?: number; intervalMs?: number; timeoutMs?: number } = {}) {
  const batchSize = options.batchSize ?? BATCH_SIZE, intervalMs = options.intervalMs ?? INTERVAL_MS,
    timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32 || !Number.isInteger(intervalMs) || intervalMs < 1_000
      || intervalMs > 60_000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) {
    throw Error('Invalid realm sale verifier operational limits');
  }
  const connect = sources.receiptSource, trust = { ...sources.trust,
    programId: new PublicKey(sources.trust.programId.toBytes()), developer: new PublicKey(sources.trust.developer.toBytes()),
    upgradeAuthority: sources.trust.upgradeAuthority === null ? null : new PublicKey(sources.trust.upgradeAuthority.toBytes()) };
  const connection = createDb(databaseUrl, { max: 1, connectTimeoutSeconds: 5, statementTimeoutMs: timeoutMs });
  const lifetime = new AbortController();
  let cursor: Cursor | null = null, flight: Promise<RealmSaleVerificationCounts> | null = null,
    timer: ReturnType<typeof setTimeout> | undefined, started = false, stopping = false, closing: Promise<void> | undefined;
  try {
    const [role] = await connection.db.execute<{ allowed: boolean }>(sql`select current_user=session_user
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.seeker_realm_sale_receipts'::regclass)
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.seeker_realm_sale_failures'::regclass) allowed`);
    if (!role?.allowed) throw Error('Realm sale verifier requires its private terminal owner');
  } catch (error) { await connection.sql.end({ timeout: 0 }); throw error; }

  async function scan(): Promise<RealmSaleVerificationCounts> {
    lifetime.signal.throwIfAborted();
    const after = cursor;
    const rows = await connection.db.execute<Candidate>(sql`select s.wallet,s.idempotency_key "idempotencyKey"
      from seeker_realm_sale_signed_wires s
      where not exists(select 1 from seeker_realm_sale_receipts r where r.wallet=s.wallet and r.idempotency_key=s.idempotency_key)
        and not exists(select 1 from seeker_realm_sale_failures f where f.wallet=s.wallet and f.idempotency_key=s.idempotency_key)
        ${after ? sql`and (s.wallet,s.idempotency_key)>(${after.wallet},${after.idempotencyKey}::uuid)` : sql``}
      order by s.wallet,s.idempotency_key limit ${batchSize + 1}`);
    const counts = { examined: 0, settled: 0, failed: 0, held: 0 };
    for (const row of rows.slice(0, batchSize)) {
      if (stopping) break;
      const deadline = new AbortController(), signal = AbortSignal.any([deadline.signal, lifetime.signal]);
      const timeout = setTimeout(() => deadline.abort(), timeoutMs);
      // The owned HTTP source obeys this signal. Guards also stop late callbacks
      // from starting another RPC or handing a receipt to a terminal writer.
      const key = { wallet: row.wallet, idempotencyKey: row.idempotencyKey };
      let outcome: 'settled' | 'failed' | 'held' = 'held';
      try {
        const guardedSource = (ownedSignal: AbortSignal) => {
          const combined = AbortSignal.any([signal, ownedSignal]);
          combined.throwIfAborted();
          return new Proxy(connect(combined), { get(target, name, receiver) {
            const value = Reflect.get(target, name, receiver); if (typeof value !== 'function') return value;
            return async (...args: unknown[]) => { combined.throwIfAborted(); const result = await value.apply(target, args); combined.throwIfAborted(); return result; };
          } });
        };
        try { await createRealmSaleSettlement(connection.db, { connect: guardedSource, trust, timeoutMs })(key); outcome = 'settled'; }
        catch {
          // An exact failed transaction is not a successful receipt. Independently
          // verify failure even when success returned RECEIPT_CONFLICT.
          if (!signal.aborted) try { await createRealmSaleFailure(connection.db, { connect: guardedSource, trust, timeoutMs })(key); outcome = 'failed'; } catch { /* Original stays pending. */ }
        }
      } catch { /* Unavailable source; keep the exact original. */ }
      finally { clearTimeout(timeout); deadline.abort(); }
      counts.examined++; counts[outcome]++; cursor = { wallet: row.wallet, idempotencyKey: row.idempotencyKey };
    }
    if (!stopping && rows.length <= batchSize) cursor = null;
    return counts;
  }
  function runOnce(): Promise<RealmSaleVerificationCounts> {
    if (stopping) return Promise.reject(Error('Realm sale verifier is closed'));
    if (!flight) flight = scan().finally(() => { flight = null; });
    return flight;
  }
  function schedule() {
    if (stopping) return;
    timer = setTimeout(() => { void runOnce().catch(() => {
      console.warn('[realm-sales] Finality scan unavailable; original purchases remain pending');
    }).finally(schedule); }, intervalMs);
    timer.unref();
  }
  return Object.freeze({ runOnce,
    start() { if (started || stopping) return; started = true; void runOnce().catch(() => {
      console.warn('[realm-sales] Finality scan unavailable; original purchases remain pending');
    }).finally(schedule); },
    close() { return closing ??= (async () => {
      stopping = true; lifetime.abort(); if (timer) clearTimeout(timer);
      // Own the dedicated pool: close stops any new/late SQL, while the original
      // uniquely keyed rows retain recovery if shutdown interrupts acknowledgement.
      await Promise.allSettled([flight, connection.sql.end({ timeout: 0 })]);
    })(); },
  });
}
