/** Private recovery of saved publications. No signer, preparation or transport.
 * Projection records entitlements; claimability still requires the live finalized
 * chain Clock, delay, pause and backing checks in claimStatus. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import type { MiningPublicationReader, MiningPublicationTrust } from '@shardkeep/chain/mining-publication';
import { createDb } from '../db/client';
import { createMiningPublicationSettlement, createResourceMiningPublicationSettlement } from './publicationSettlement';
import { projectMiningClaimEntitlements } from './claimEntitlement';

export interface MiningPublicationVerifierSources {
  receiptSource(signal: AbortSignal): MiningPublicationReader;
  trust: MiningPublicationTrust;
}
export interface MiningPublicationVerificationCounts { examined: number; settled: number; projected: number; held: number }
export interface MiningPublicationVerifierOptions {
  enabled?: boolean; cluster?: string; batchSize?: number; intervalMs?: number; timeoutMs?: number;
  report?: (observation: Readonly<MiningPublicationVerificationCounts & { heldReasons: Readonly<Record<string, number>> }>) => void;
}
interface Cursor { epochId: string; sequence: string }
interface Candidate extends Cursor, Record<string, unknown> {
  attemptKey: string; signature: string; wireHex: string; resource: boolean;
}
// Technical I/O bounds, not gameplay policy.
const BATCH_SIZE = 8, INTERVAL_MS = 15_000, TIMEOUT_MS = 30_000;

export async function createMiningPublicationVerifierRuntime(databaseUrl: string | undefined,
  sources: MiningPublicationVerifierSources | undefined, options: MiningPublicationVerifierOptions = {}) {
  if (options.enabled !== true) return null;
  if (!databaseUrl || !sources || typeof sources.receiptSource !== 'function' || !sources.trust
      || !Number.isSafeInteger(sources.trust.reviewedDeploymentSlot) || sources.trust.reviewedDeploymentSlot < 0
      || !/^[0-9a-f]{64}$/.test(sources.trust.reviewedProgramDataSha256)) {
    throw Error('Mining publication verifier requires complete reviewed sources and private database');
  }
  if (options.cluster !== 'devnet' || sources.trust.expectedGenesisHash !== SOLANA_GENESIS_HASH.devnet) {
    throw Error('Mining publication verifier is restricted to an explicitly enabled devnet stack');
  }
  const batchSize = options.batchSize ?? BATCH_SIZE, intervalMs = options.intervalMs ?? INTERVAL_MS,
    timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32 || !Number.isInteger(intervalMs)
      || intervalMs < 1_000 || intervalMs > 60_000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) {
    throw Error('Invalid mining publication verifier operational limits');
  }
  const connect = sources.receiptSource, trust = Object.freeze({ ...sources.trust,
    programId: new PublicKey(sources.trust.programId.toBytes()), keepMint: new PublicKey(sources.trust.keepMint.toBytes()),
    reserveOwner: new PublicKey(sources.trust.reserveOwner.toBytes()) });
  const configAddress = miningConfigPda(trust.programId).toBase58();
  const connection = createDb(databaseUrl, { max: 1, connectTimeoutSeconds: 5, statementTimeoutMs: timeoutMs });
  const lifetime = new AbortController();
  const report = options.report ?? ((observation: unknown) => console.warn('[mining-publication-verifier]', observation));
  let lastReportedKey = '', lastReportedAt = -Infinity;
  let cursor: Cursor | null = null, flight: Promise<MiningPublicationVerificationCounts> | null = null,
    timer: ReturnType<typeof setTimeout> | undefined, started = false, stopping = false, closing: Promise<void> | undefined;
  try {
    const [role] = await connection.db.execute<{ allowed: boolean }>(sql`select current_user=session_user
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_publication_attempts'::regclass)
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_publication_manifests'::regclass)
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_publication_settlements'::regclass)
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_publication_signed_wires'::regclass)
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_publication_signing_reservations'::regclass)
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_claim_entitlement_headers'::regclass)
      and current_user::regrole::oid=(select relowner from pg_class where oid='public.mining_claim_entitlement_leaves'::regclass) allowed`);
    if (!role?.allowed) throw Error('Mining publication verifier requires its private publication owner');
  } catch (error) { await connection.sql.end({ timeout: 0 }); throw error; }

  async function scan(): Promise<MiningPublicationVerificationCounts> {
    lifetime.signal.throwIfAborted();
    const after = cursor;
    const rows = await connection.db.execute<Candidate>(sql`select r.epoch_id "epochId",r.sequence::text sequence,
      r.attempt_key "attemptKey",w.signature,encode(w.signed_transaction,'hex') "wireHex",a.contributions is not null resource
      from mining_publication_signing_reservations r
      join mining_publication_signed_wires w using(epoch_id)
      join mining_publication_attempts a using(epoch_id)
      join mining_publication_manifests m using(epoch_id)
      where r.genesis_hash=${trust.expectedGenesisHash} and r.program_id=${trust.programId.toBase58()}
        and r.config_address=${configAddress} and m.publication->>'keepMint'=${trust.keepMint.toBase58()}
        and m.publication->>'reserveOwner'=${trust.reserveOwner.toBase58()}
        and not exists(select 1 from mining_claim_entitlement_headers h where h.epoch_id=r.epoch_id)
        ${after ? sql`and (r.sequence,r.epoch_id)>(${after.sequence}::numeric,${after.epochId}::uuid)` : sql``}
      order by r.sequence,r.epoch_id limit ${batchSize + 1}`);
    const counts = { examined: 0, settled: 0, projected: 0, held: 0 };
    const heldReasons: Record<string, number> = Object.create(null);
    for (const row of rows.slice(0, batchSize)) {
      if (stopping) break;
      const deadline = new AbortController(), signal = AbortSignal.any([deadline.signal, lifetime.signal]);
      const timeout = setTimeout(() => deadline.abort(), timeoutMs);
      counts.examined++;
      try {
        signal.throwIfAborted();
        if (!/^(?:[0-9a-f]{2}){1,1232}$/.test(row.wireHex) || typeof row.resource !== 'boolean') throw Error('Invalid original');
        const raw = connect(signal);
        // Forward through a fresh target: wrapping frozen source methods on
        // their own object would violate nonconfigurable Proxy invariants.
        const reader = new Proxy({} as MiningPublicationReader, { get(_target, name) {
          const value = Reflect.get(raw, name, raw); if (typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            signal.throwIfAborted(); const result = await value.apply(raw, args); signal.throwIfAborted(); return result;
          };
        } });
        const settle = row.resource ? createResourceMiningPublicationSettlement : createMiningPublicationSettlement;
        await settle(connection.db, { reader, trust })({ epochId: row.epochId, attemptKey: row.attemptKey,
          signature: row.signature, signedTransaction: Buffer.from(row.wireHex, 'hex') });
        counts.settled++;
        signal.throwIfAborted();
        await projectMiningClaimEntitlements(connection.db, { epochId: row.epochId });
        counts.projected++;
      } catch (error) {
        counts.held++;
        const code = (error as { code?: unknown } | null)?.code;
        const reason = stopping ? 'CLOSED' : deadline.signal.aborted ? 'TIMEOUT'
          : typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SOURCE_UNAVAILABLE';
        heldReasons[reason] = (heldReasons[reason] ?? 0) + 1;
      }
      finally { clearTimeout(timeout); deadline.abort(); }
      cursor = { epochId: row.epochId, sequence: row.sequence };
    }
    if (!stopping && rows.length <= batchSize) cursor = null;
    if (counts.examined) {
      const observation = Object.freeze({ ...counts, heldReasons: Object.freeze(heldReasons) }), key = JSON.stringify(observation), now = Date.now();
      if (key !== lastReportedKey || now - lastReportedAt >= 60_000) {
        lastReportedKey = key; lastReportedAt = now;
        try { report(observation); } catch { console.warn('[mining-publication-verifier] Observation sink unavailable'); }
      }
    }
    return counts;
  }
  function runOnce(): Promise<MiningPublicationVerificationCounts> {
    if (stopping) return Promise.reject(Error('Mining publication verifier is closed'));
    // Keep the raw flight until it drains. A provider ignoring AbortSignal cannot
    // create overlapping scans or hand late evidence to a terminal writer.
    if (!flight) flight = scan().finally(() => { flight = null; });
    return flight;
  }
  function schedule() {
    if (stopping) return;
    timer = setTimeout(() => { void runOnce().catch(() => {
      console.warn('[mining-publications] Finality scan unavailable; saved originals retained');
    }).finally(schedule); }, intervalMs);
    timer.unref();
  }
  return Object.freeze({ runOnce,
    start() { if (started || stopping) return; started = true; void runOnce().catch(() => {
      console.warn('[mining-publications] Finality scan unavailable; saved originals retained');
    }).finally(schedule); },
    close() { return closing ??= (async () => {
      stopping = true; lifetime.abort(); if (timer) clearTimeout(timer);
      await Promise.allSettled([flight]);
      await connection.sql.end({ timeout: 0 });
    })(); },
  });
}
