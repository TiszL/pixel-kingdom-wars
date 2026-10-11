/** DARK original-term persistence, not an issuer or proof of auction authority.
 * No raw JSON insert API: admission calls the server reader, then pins its
 * parsed snapshot. Default reader is unavailable; there is no fixture fallback.
 * Future dispatch calls inside its own base-locked transaction (base→term).
 * This helper never acquires player/base locks. */
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { expeditionTermSnapshots } from '../db/schema';
import { hashExpeditionTermSnapshot, parseExpeditionTermObservation, requireCurrentExpeditionTermPolicy, requireExpeditionTermIdentity,
  serializeExpeditionTermSnapshot, unavailableExpeditionTermReader,
  type ExpeditionTermReader, type ExpeditionTermSnapshot, type ExpeditionTermObservation } from './expeditionTerms';

import { parseHistoricalShardsTermCertificate, hashHistoricalShardsTermCertificate,
  type HistoricalShardsTermCertificate } from '../mining/shardsTaxObstacleEvidence';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const hash = z.string().length(64).regex(/^[0-9a-f]{64}$/);
export interface StoredExpeditionTerm {
  readonly snapshot: ExpeditionTermSnapshot;
  readonly hash: string;
}

function decode(row: typeof expeditionTermSnapshots.$inferSelect): StoredExpeditionTerm {
  const snapshot = requireExpeditionTermIdentity(row.snapshot, row.termId, row.snapshotHash);
  if (serializeExpeditionTermSnapshot(snapshot) !== row.canonical
    || snapshot.source.genesisHash !== row.genesisHash || snapshot.source.programId !== row.programId
    || snapshot.source.auctionConfig !== row.auctionConfig || snapshot.source.round !== row.round
    || snapshot.startsAt !== row.startsAt.toISOString() || snapshot.endsAt !== row.endsAt.toISOString()) {
    throw new Error('Stored expedition term is not canonical original evidence');
  }
  return Object.freeze({ snapshot, hash: row.snapshotHash });
}

/** Private historical integrity read; no provider, current interval, gameplay
 * flag or current owner required. Future public callers must authenticate scope. */
export async function readStoredExpeditionTerm(db: DbOrTx, termId: string, expectedHash: string): Promise<StoredExpeditionTerm | null> {
  termId = uuid.parse(termId); expectedHash = hash.parse(expectedHash);
  const [row] = await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, termId));
  if (!row) return null;
  const proof = decode(row);
  if (proof.hash !== expectedHash) throw new Error('Expedition term hash differs from original reference');
  return proof;
}

/** serverDispatchAt is sampled by server admission under its own base/vehicle
 * locks. Finality must already have been observed by this sample: a cold RPC
 * answer observed later refuses, never gets backdated. Future admission can
 * prefetch and revalidate an already verified cache under its locks.
 * Reader injection belongs to server wiring, never command body/config.
 * One source scope per admission; future multi-source callers must order locks. */
export async function pinOperatingExpeditionTerm(
  db: DbOrTx, serverDispatchAt: Date, reader: ExpeditionTermReader = unavailableExpeditionTermReader,
): Promise<StoredExpeditionTerm> {
  const { snapshot, hash } = await pinObservedOperatingExpeditionTerm(db, serverDispatchAt, reader);
  return Object.freeze({ snapshot, hash });
}

/** SAME validated observation as the pinned term, for atomic dispatch capture.
 * Historical reads deliberately do not fabricate an observation. */
export async function pinObservedOperatingExpeditionTerm(
  db: DbOrTx, serverDispatchAt: Date, reader: ExpeditionTermReader = unavailableExpeditionTermReader,
): Promise<StoredExpeditionTerm & { readonly finality: ExpeditionTermObservation['finality'] }> {
  const dispatchAt = serverDispatchAt.toISOString();
  const value = await reader.readOperatingTerm(dispatchAt);
  if (value === null) throw new Error('Authoritative operating expedition term unavailable');
  const { snapshot, finality } = parseExpeditionTermObservation(value, dispatchAt);
  requireCurrentExpeditionTermPolicy();
  const proof = await persistSnapshot(db, snapshot);
  return Object.freeze({ ...proof, finality });
}

/** One private writer keeps operating and historical metadata on the same source
 * lock, round identity and interval fences. It grants no earning authority. */
async function persistSnapshot(db: DbOrTx, snapshot: ExpeditionTermSnapshot): Promise<StoredExpeditionTerm> {
  const canonical = serializeExpeditionTermSnapshot(snapshot), snapshotHash = hashExpeditionTermSnapshot(snapshot);
  const source = snapshot.source;
  return (db as Db).transaction(async tx => {
    // A repeatable-read outer transaction could keep the pre-lock snapshot and
    // admit a concurrent overlapping round. Require the canonical fresh-read
    // isolation instead of silently weakening the source-interval fence.
    const [mode] = await tx.execute(sql`select current_setting('transaction_isolation') as isolation`) as unknown as Array<{ isolation: string }>;
    if (mode?.isolation !== 'read committed') throw new Error('Expedition term pinning requires read committed isolation');
    // Canonical service overlap fence, distinct from database uniqueness. This
    // new SELECT after the advisory lock sees any prior committed interval.
    // Hash collisions only serialize unrelated sources; they grant no access.
    const scope = JSON.stringify([source.genesisHash, source.programId, source.auctionConfig]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`expedition-term:${scope}`}, 0))`);
    const [prior] = await tx.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, snapshot.termId));
    if (prior) {
      const proof = decode(prior);
      if (proof.hash !== snapshotHash || prior.canonical !== canonical) throw new Error('Expedition term identity conflict');
      return proof;
    }
    const sameSource = and(eq(expeditionTermSnapshots.genesisHash, source.genesisHash),
      eq(expeditionTermSnapshots.programId, source.programId), eq(expeditionTermSnapshots.auctionConfig, source.auctionConfig));
    const [round] = await tx.select({ id: expeditionTermSnapshots.termId }).from(expeditionTermSnapshots)
      .where(and(sameSource, eq(expeditionTermSnapshots.round, source.round)));
    if (round) throw new Error('Expedition source round already has a different term identity');
    const [overlap] = await tx.select({ id: expeditionTermSnapshots.termId }).from(expeditionTermSnapshots)
      .where(and(sameSource, lt(expeditionTermSnapshots.startsAt, new Date(snapshot.endsAt)), gt(expeditionTermSnapshots.endsAt, new Date(snapshot.startsAt))));
    if (overlap) throw new Error('Expedition source operating intervals overlap');
    const [inserted] = await tx.insert(expeditionTermSnapshots).values({ termId: snapshot.termId, snapshotHash,
      canonical, snapshot, genesisHash: source.genesisHash, programId: source.programId,
      auctionConfig: source.auctionConfig, round: source.round, startsAt: new Date(snapshot.startsAt), endsAt: new Date(snapshot.endsAt),
    }).onConflictDoNothing().returning();
    if (inserted) return decode(inserted);
    // Same UUID may concurrently arrive under a different source lock. Never
    // treat the losing INSERT as admission of its conflicting body or round.
    const proof = await readStoredExpeditionTerm(tx, snapshot.termId, snapshotHash);
    if (!proof || serializeExpeditionTermSnapshot(proof.snapshot) !== canonical) throw new Error('Expedition term identity conflict');
    return proof;
  });
}

/** Server-owned injection only; no request body or certificate JSON is a reader.
 * Real chain verification must finish before a caller enters gameplay locks.
 * Missing authority has no stored-snapshot or all-unsold fallback. */
export interface HistoricalShardsTermReader {
  readHistoricalTerm(): Promise<HistoricalShardsTermCertificate | null>;
}
export interface StoredHistoricalShardsTerm extends StoredExpeditionTerm {
  readonly certificate: HistoricalShardsTermCertificate;
  readonly historicalCertificateHash: string;
  readonly sourceVerified: false;
  readonly postingAuthorized: false;
  readonly payoutAuthorized: false;
  readonly operatingAdmissionAuthorized: false;
}

/** Historical metadata, not current operating admission or an issuance capability.
 * Only the immutable snapshot is stored here. A future issuer must independently
 * authenticate the original earning and retain the complete certificate with its
 * source record; this return's reader-supplied provenance is structural evidence.
 * Frozen v1 history remains decodable after today's Seeker policy changes. */
export async function pinHistoricalShardsTerm(
  db: DbOrTx, reader?: HistoricalShardsTermReader,
): Promise<StoredHistoricalShardsTerm> {
  if (!reader || typeof reader.readHistoricalTerm !== 'function')
    throw new Error('Authoritative historical SHARDS term unavailable');
  const raw = await reader.readHistoricalTerm();
  if (raw === null) throw new Error('Authoritative historical SHARDS term unavailable');
  const certificate = parseHistoricalShardsTermCertificate(raw);
  const historicalCertificateHash = hashHistoricalShardsTermCertificate(certificate);
  const proof = await persistSnapshot(db, certificate.snapshot);
  return Object.freeze({ ...proof, certificate, historicalCertificateHash, sourceVerified: false,
    postingAuthorized: false, payoutAuthorized: false, operatingAdmissionAuthorized: false });
}
