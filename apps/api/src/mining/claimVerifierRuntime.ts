/** Process-owned original-claim finality. No signer, relay or request capability.
 * Held originals advance the scan cursor and are retried after wraparound. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import type { MiningClaimReceiptReader, MiningClaimReceiptTrust } from '@shardkeep/chain/mining-claim-receipt';
import { createDb } from '../db/client';
import { createMiningClaimSettlement } from './claimSettlement';
import { createMiningClaimFailure } from './claimFailure';

export interface MiningClaimVerifierSources {
  receiptSource(signal: AbortSignal): MiningClaimReceiptReader;
  trust: MiningClaimReceiptTrust;
}
interface Cursor { claimId: string; ordinal: number }
interface Candidate extends Cursor, Record<string, unknown> { wallet: string }
export interface MiningClaimVerificationCounts { examined: number; settled: number; failed: number; held: number }
// Operational I/O limits; these do not change a gameplay reward or claim cap.
const BATCH_SIZE = 8, INTERVAL_MS = 15_000, TIMEOUT_MS = 30_000;

export async function createMiningClaimVerifierRuntime(databaseUrl: string, sources: MiningClaimVerifierSources,
  options: { batchSize?: number; intervalMs?: number; timeoutMs?: number } = {}) {
  const batchSize = options.batchSize ?? BATCH_SIZE, intervalMs = options.intervalMs ?? INTERVAL_MS,
    timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32 || !Number.isInteger(intervalMs) || intervalMs < 1_000
      || intervalMs > 60_000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) {
    throw Error('Invalid mining claim verifier operational limits');
  }
  const connect = sources.receiptSource, trust = { ...sources.trust,
    programId: new PublicKey(sources.trust.programId.toBytes()), keepMint: new PublicKey(sources.trust.keepMint.toBytes()),
    reserveOwner: new PublicKey(sources.trust.reserveOwner.toBytes()) };
  const connection = createDb(databaseUrl, { max: 1, connectTimeoutSeconds: 5, statementTimeoutMs: timeoutMs });
  const lifetime = new AbortController();
  let cursor: Cursor | null = null, flight: Promise<MiningClaimVerificationCounts> | null = null,
    timer: ReturnType<typeof setTimeout> | undefined, started = false, stopping = false, closing: Promise<void> | undefined;
  try {
    const [role] = await connection.db.execute<{ allowed: boolean }>(sql`select current_user=session_user
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_claim_receipts'::regclass)
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_claim_failures'::regclass) allowed`);
    if (!role?.allowed) throw Error('Mining claim verifier requires its private terminal owner');
  } catch (error) { await connection.sql.end({ timeout: 0 }); throw error; }

  async function scan(): Promise<MiningClaimVerificationCounts> {
    lifetime.signal.throwIfAborted();
    const after = cursor;
    const rows = await connection.db.execute<Candidate>(sql`select s.claim_id "claimId",s.ordinal,s.wallet
      from mining_claim_signed_wires s
      where not exists(select 1 from mining_claim_receipts r where r.claim_id=s.claim_id and r.ordinal=s.ordinal)
        and not exists(select 1 from mining_claim_failures f where f.claim_id=s.claim_id and f.ordinal=s.ordinal)
        ${after ? sql`and (s.claim_id,s.ordinal)>(${after.claimId}::uuid,${after.ordinal})` : sql``}
      order by s.claim_id,s.ordinal limit ${batchSize + 1}`);
    const counts = { examined: 0, settled: 0, failed: 0, held: 0 };
    for (const row of rows.slice(0, batchSize)) {
      if (stopping) break;
      const deadline = new AbortController(), signal = AbortSignal.any([deadline.signal, lifetime.signal]);
      const timeout = setTimeout(() => deadline.abort(), timeoutMs);
      // The owned HTTP source obeys this signal. Guards also stop late callbacks
      // from starting another RPC or handing a receipt to a terminal writer.
      const key = { wallet: row.wallet, claimId: row.claimId, ordinal: row.ordinal };
      let outcome: 'settled' | 'failed' | 'held' = 'held';
      try {
        const reader = new Proxy(connect(signal), { get(target, name, receiver) {
          const value = Reflect.get(target, name, receiver); if (typeof value !== 'function') return value;
          return async (...args: unknown[]) => { signal.throwIfAborted(); const result = await value.apply(target, args); signal.throwIfAborted(); return result; };
        } });
        try { await createMiningClaimSettlement(connection.db, { reader, trust, timeoutMs })(key); outcome = 'settled'; }
        catch {
          // An exact failed transaction is not a successful receipt. Independently
          // verify failure even when success returned RECEIPT_CONFLICT.
          if (!signal.aborted) try { await createMiningClaimFailure(connection.db, { reader, trust, timeoutMs })(key); outcome = 'failed'; } catch { /* Original stays pending. */ }
        }
      } catch { /* Unavailable source; keep the exact original. */ }
      finally { clearTimeout(timeout); deadline.abort(); }
      counts.examined++; counts[outcome]++; cursor = { claimId: row.claimId, ordinal: row.ordinal };
    }
    if (!stopping && rows.length <= batchSize) cursor = null;
    return counts;
  }
  function runOnce(): Promise<MiningClaimVerificationCounts> {
    if (stopping) return Promise.reject(Error('Mining claim verifier is closed'));
    if (!flight) flight = scan().finally(() => { flight = null; });
    return flight;
  }
  function schedule() {
    if (stopping) return;
    timer = setTimeout(() => { void runOnce().catch(() => {
      console.warn('[mining-claims] Finality scan unavailable; original claims remain pending');
    }).finally(schedule); }, intervalMs);
    timer.unref();
  }
  return Object.freeze({ runOnce,
    start() { if (started || stopping) return; started = true; void runOnce().catch(() => {
      console.warn('[mining-claims] Finality scan unavailable; original claims remain pending');
    }).finally(schedule); },
    close() { return closing ??= (async () => {
      stopping = true; lifetime.abort(); if (timer) clearTimeout(timer);
      // Own the dedicated pool: close stops any new/late SQL, while the original
      // uniquely keyed rows retain recovery if shutdown interrupts acknowledgement.
      await Promise.allSettled([flight, connection.sql.end({ timeout: 0 })]);
    })(); },
  });
}
