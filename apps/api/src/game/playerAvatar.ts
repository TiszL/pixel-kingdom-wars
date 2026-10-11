/**
 * Wallet-level public avatars.
 *
 * Uploads are decoded and re-encoded before publication: the original bytes,
 * filename and metadata never reach object storage. The database stores a
 * SHA-256 plus an immutable UUID generation, and that pointer moves only after
 * the generation's R2 PUT succeeds. An R2 outage can therefore reject a new
 * picture, but it cannot erase or replace the currently visible one.
 *
 * This module binds the existing bucket credentials to an `avatar/`-only
 * writer. It deliberately does not reuse or widen deedR2's putter: that writer
 * is structurally confined to `deed/`, and avatar input must never weaken the
 * guard protecting the token/deed objects in the shared bucket.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PROFILE_AVATAR } from '@shardkeep/shared';
import { AwsClient } from 'aws4fetch';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { Db, DbTx } from '../db/client';
import { outbox, players } from '../db/schema';
import { errorForStorage } from '../lib/errors';
import type { R2Config } from './deedR2';
import {
  identityValleysForWallet, publishWorldIdentityAfterCommit,
} from './worldIdentity';

export const AVATAR_MAX_UPLOAD_BYTES = PROFILE_AVATAR.maxUploadBytes;
export const AVATAR_MAX_DECODED_PIXELS = PROFILE_AVATAR.maxDecodedPixels;
export const AVATAR_SIZE_PX = PROFILE_AVATAR.outputSizePx;
export const AVATAR_MAX_NORMALIZED_BYTES = PROFILE_AVATAR.maxNormalizedBytes;
export const AVATAR_MAX_CONCURRENT_NORMALIZATIONS = PROFILE_AVATAR.maxConcurrentNormalizations;
/** Raw request bodies have the same hostile-memory concurrency ceiling as the
 * image decoders they feed. The request-level permit is held from onRequest
 * admission through response/error, so parsed 8 MiB buffers cannot queue behind
 * the normalization gate. */
export const AVATAR_MAX_CONCURRENT_RAW_UPLOADS = PROFILE_AVATAR.maxConcurrentNormalizations;
export const AVATAR_MAX_CONCURRENT_MUTATIONS = PROFILE_AVATAR.maxConcurrentMutations;
export const AVATAR_MAX_CONCURRENT_READS = PROFILE_AVATAR.maxConcurrentReads;
const AVATAR_KEY_RE = /^avatar\/[1-9A-HJ-NP-Za-km-z]{32,44}\/[0-9a-f]{64}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

const INPUT_FORMAT: Readonly<Record<string, 'jpeg' | 'png' | 'webp'>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class AvatarInputError extends Error {}
export class AvatarBusyError extends Error {}

export type AvatarObjectPutter = (
  key: string, body: Buffer, signal?: AbortSignal,
) => Promise<void>;
export type AvatarObjectDeleter = (key: string, signal?: AbortSignal) => Promise<void>;
export type AvatarObjectReader = (key: string, signal?: AbortSignal) => Promise<Buffer | null>;

export interface AvatarStorage {
  publicBaseUrl: string;
  put: AvatarObjectPutter;
  delete: AvatarObjectDeleter;
  /** Optional because API tests and write-only deployments may inject only the
   * mutation boundary. Production supplies this for opaque globe avatars. */
  read?: AvatarObjectReader | undefined;
}

/** Exact object namespace this request path may address. */
export function assertAvatarKey(key: string): string {
  if (!AVATAR_KEY_RE.test(key)) {
    throw new Error(
      `[avatar-r2] REFUSING to write "${key}": avatar uploads may only write `
      + 'avatar/<base58-wallet>/<lowercase-sha256>/<uuid-generation>.webp',
    );
  }
  return key;
}

/** Guard a fake or real putter at its credential boundary. */
export function avatarScopedPutter(put: AvatarObjectPutter): AvatarObjectPutter {
  return async (key, body, signal) => put(assertAvatarKey(key), body, signal);
}

export function avatarScopedDeleter(remove: AvatarObjectDeleter): AvatarObjectDeleter {
  return async (key, signal) => remove(assertAvatarKey(key), signal);
}

export function avatarScopedReader(read: AvatarObjectReader): AvatarObjectReader {
  return async (key, signal) => read(assertAvatarKey(key), signal);
}

export function avatarObjectKey(wallet: string, hash: string, generation: string): string {
  return assertAvatarKey(`avatar/${wallet}/${hash}/${generation}.webp`);
}

export function avatarPublicUrl(
  publicBaseUrl: string, wallet: string, hash: string, generation: string,
): string {
  return `${publicBaseUrl.replace(/\/$/, '')}/${avatarObjectKey(wallet, hash, generation)}`;
}

/** A separately-guarded writer using the same configured R2 bucket. */
export function makeR2AvatarStorage(cfg: R2Config): AvatarStorage {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const put = avatarScopedPutter(async (key, body, signal) => {
    const res = await aws.fetch(`${cfg.endpoint}/${cfg.bucket}/${key}`, {
      method: 'PUT',
      headers: {
        'content-type': 'image/webp',
        // The URL changes with the bytes, while the short cache bound ensures a
        // removed profile picture stops resolving soon after the guarded DELETE.
        // A DELETE/replace must stop resolving shortly after removal, including
        // from intermediary caches which previously learned the public URL.
        'cache-control': `public, max-age=${PROFILE_AVATAR.publicCacheSeconds}`,
      },
      body,
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`R2 PUT ${key}: ${res.status} ${await res.text().catch(() => '')}`);
    }
  });
  const remove = avatarScopedDeleter(async (key, signal) => {
    const res = await aws.fetch(`${cfg.endpoint}/${cfg.bucket}/${key}`, {
      method: 'DELETE', ...(signal ? { signal } : {}),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`R2 DELETE ${key}: ${res.status} ${await res.text().catch(() => '')}`);
    }
  });
  const read = avatarScopedReader(async (key, signal) => {
    const res = await aws.fetch(`${cfg.endpoint}/${cfg.bucket}/${key}`, {
      method: 'GET', ...(signal ? { signal } : {}),
    });
    return boundedAvatarResponse(res, `R2 GET ${key}`);
  });
  return { publicBaseUrl: cfg.publicBaseUrl.replace(/\/$/, ''), put, delete: remove, read };
}

let activeNormalizations = 0;
let activeRawUploads = 0;
let activeMutations = 0;
let activeReads = 0;

/** Acquire before Fastify parses the upload body. The returned release is
 * idempotent because both onError and onResponse can observe one failed request;
 * request-scoped hook wiring additionally removes it before invoking it. */
export function acquireAvatarRawUploadPermit(): () => void {
  if (activeRawUploads >= AVATAR_MAX_CONCURRENT_RAW_UPLOADS) {
    throw new AvatarBusyError('avatar upload capacity is busy; try again');
  }
  activeRawUploads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRawUploads -= 1;
  };
}

/** Bound hostile libvips work per API process. Redis-backed wallet/IP request
 * limits cap admission across processes; this fail-fast gate prevents admitted
 * parsed buffers from accumulating in an unbounded in-process wait queue. */
export async function withAvatarNormalizationSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeNormalizations >= AVATAR_MAX_CONCURRENT_NORMALIZATIONS) {
    throw new AvatarBusyError('avatar processing is busy; try again');
  }
  activeNormalizations += 1;
  try {
    return await work();
  } finally {
    activeNormalizations -= 1;
  }
}

/** Bound the transactions that hold a database connection across an R2 mutation.
 * This is intentionally fail-fast like normalization admission: a queue would
 * retain normalized image buffers and waiting pool work without a hard bound. */
export async function withAvatarMutationPermit<T>(work: () => Promise<T>): Promise<T> {
  if (activeMutations >= AVATAR_MAX_CONCURRENT_MUTATIONS) {
    throw new AvatarBusyError('avatar mutation capacity is busy; try again');
  }
  activeMutations += 1;
  try {
    return await work();
  } finally {
    activeMutations -= 1;
  }
}

/** Bound same-origin avatar proxy work independently from uploads. Failed-open
 * here would turn an R2 slowdown into an unbounded queue of authenticated map
 * image requests, so excess images fail fast and the web keeps its authored
 * Keep placeholder. */
export async function withAvatarReadPermit<T>(work: () => Promise<T>): Promise<T> {
  if (activeReads >= AVATAR_MAX_CONCURRENT_READS) {
    throw new AvatarBusyError('avatar read capacity is busy; try again');
  }
  activeReads += 1;
  try {
    return await work();
  } finally {
    activeReads -= 1;
  }
}

async function boundedAvatarResponse(res: Response, source: string): Promise<Buffer | null> {
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`${source}: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > AVATAR_MAX_NORMALIZED_BYTES) {
    throw new Error(`${source}: object exceeds normalized avatar bound`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > AVATAR_MAX_NORMALIZED_BYTES) {
    throw new Error(`${source}: object exceeds normalized avatar bound`);
  }
  return body;
}

/** Credential-independent read seam: existing avatars remain visible when the
 * API has a public R2 base URL but mutation credentials are temporarily absent. */
export async function readPublicAvatar(
  publicBaseUrl: string, key: string, signal: AbortSignal,
): Promise<Buffer | null> {
  assertAvatarKey(key);
  const res = await fetch(`${publicBaseUrl.replace(/\/$/, '')}/${key}`, { signal });
  return boundedAvatarResponse(res, `avatar public GET ${key}`);
}

/** Every object-store call made while a DB transaction is open must terminate.
 * The real R2 transport consumes this signal; Promise.race also bounds injected
 * test transports that accidentally ignore it. */
export async function withAvatarStorageDeadline<T>(
  operation: 'GET' | 'PUT' | 'DELETE', work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error(`avatar storage ${operation} timed out`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, PROFILE_AVATAR.storageMutationTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) {
      controller.abort(new Error(`avatar storage ${operation} completed`));
    }
  }
}

async function putAvatarObject(storage: AvatarStorage, key: string, body: Buffer): Promise<void> {
  await withAvatarStorageDeadline('PUT', (signal) => storage.put(key, body, signal));
}

async function deleteAvatarObject(
  storage: Pick<AvatarStorage, 'delete'>, key: string,
): Promise<void> {
  await withAvatarStorageDeadline('DELETE', (signal) => storage.delete(key, signal));
}

async function removeFailedUpload(
  storage: Pick<AvatarStorage, 'delete'>, key: string,
): Promise<boolean> {
  try {
    await deleteAvatarObject(storage, key);
    return true;
  } catch (err) {
    // The transaction did not commit this pointer. Cleanup is best effort because
    // its failure must not replace the original mutation error returned to callers.
    console.warn('[avatar-r2] failed-upload cleanup failed', err);
    return false;
  }
}

/** FIRST statement in every avatar pointer transaction. Fail-fast acquisition
 * prevents one wallet's waiter from occupying the second process-wide mutation
 * permit while another wallet could make progress. */
async function acquireAvatarMutationLock(tx: DbTx, wallet: string): Promise<void> {
  const [lock] = await tx.execute(sql<{ acquired: boolean }>`
    select pg_try_advisory_xact_lock(
      hashtextextended(${`avatar-mutation:${wallet}`}, 0)
    ) as acquired
  `);
  if (!lock?.acquired) throw new AvatarBusyError('avatar is already being updated; try again');
}

/** Serialize the global pending-retirement count across every API replica.
 * Call only after the wallet lock and only when this mutation will retire an
 * existing generation. Holding this short xact lock through the replacement
 * PUT makes a capacity rejection side-effect free and reserves the eventual
 * outbox slot until pointer + retirement commit atomically. */
async function acquireAvatarRetirementAdmission(tx: DbTx): Promise<void> {
  const [lock] = await tx.execute(sql<{ acquired: boolean }>`
    select pg_try_advisory_xact_lock(
      hashtextextended('avatar-retirement-admission:v1', 0)
    ) as acquired
  `);
  if (!lock?.acquired) {
    throw new AvatarBusyError('avatar retirement admission is busy; try again');
  }

  const [capacity] = await tx.select({
    pending: sql<number>`count(*)::integer`,
  }).from(outbox).where(and(
    eq(outbox.kind, 'avatar_delete'),
    eq(outbox.status, 'pending'),
  ));
  const pending = Number(capacity?.pending);
  if (!Number.isSafeInteger(pending) || pending < 0) {
    throw new AvatarBusyError('avatar retirement capacity is unavailable; try again');
  }
  if (pending >= PROFILE_AVATAR.retirementMaxPending) {
    throw new AvatarBusyError('avatar retirement backlog is full; try again');
  }
}

/** Decode only supported still-image formats and return one bounded, metadata-
 * free, orientation-correct sRGB WebP. The hash is computed after this step, so
 * semantically identical retries publish and select the same object. */
export async function normalizeAvatar(input: Buffer, declaredContentType: string): Promise<Buffer> {
  const expected = INPUT_FORMAT[declaredContentType.toLowerCase()];
  if (!expected) throw new AvatarInputError('avatar must be a JPEG, PNG or WebP image');
  if (input.length === 0) throw new AvatarInputError('avatar image is empty');
  if (input.length > AVATAR_MAX_UPLOAD_BYTES) throw new AvatarInputError('avatar image exceeds 8 MiB');

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: AVATAR_MAX_DECODED_PIXELS,
    }).metadata();
  } catch {
    throw new AvatarInputError('avatar image could not be decoded safely');
  }
  if (metadata.format !== expected) {
    throw new AvatarInputError('avatar bytes do not match the declared image type');
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new AvatarInputError('animated or multi-page avatars are not supported');
  }
  if (!metadata.width || !metadata.height
    || metadata.width * metadata.height > AVATAR_MAX_DECODED_PIXELS) {
    throw new AvatarInputError('avatar exceeds the 24 megapixel decoded limit');
  }

  let normalized: Buffer;
  try {
    normalized = await sharp(input, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: AVATAR_MAX_DECODED_PIXELS,
    })
      .rotate() // EXIF orientation is applied, then stripped with all metadata.
      .resize(AVATAR_SIZE_PX, AVATAR_SIZE_PX, { fit: 'cover', position: 'centre' })
      .toColourspace('srgb')
      .webp({ quality: 82, alphaQuality: 82, effort: 4, smartSubsample: true })
      .toBuffer();
  } catch {
    throw new AvatarInputError('avatar image could not be normalized safely');
  }
  if (normalized.length > AVATAR_MAX_NORMALIZED_BYTES) {
    // This should be unreachable for a lossy 256px WebP, but it is a hard
    // storage/response bound rather than an assumption about libwebp.
    throw new AvatarInputError('normalized avatar is unexpectedly large');
  }
  return normalized;
}

export interface AvatarIdentity {
  avatarUrl: string | null;
  avatarUpdatedAt: string | null;
}

export function serializeAvatar(
  publicBaseUrl: string | undefined,
  player: {
    wallet: string;
    avatarHash: string | null;
    avatarGeneration: string | null;
    avatarUpdatedAt: Date | null;
  },
): AvatarIdentity {
  return {
    avatarUrl: player.avatarHash && player.avatarGeneration && publicBaseUrl
      ? avatarPublicUrl(
          publicBaseUrl, player.wallet, player.avatarHash, player.avatarGeneration,
        )
      : null,
    avatarUpdatedAt: player.avatarUpdatedAt?.toISOString() ?? null,
  };
}

/** Normalize before admission, then serialize the wallet generation across every
 * API process. The first transaction statement is the advisory lock: no stale
 * pointer may be observed before this request owns the wallet mutation order. */
export async function uploadPlayerAvatar(
  db: Db,
  storage: AvatarStorage,
  wallet: string,
  input: Buffer,
  declaredContentType: string,
): Promise<AvatarIdentity> {
  // Resolve before mutation so cache publication itself cannot fail after the
  // pointer committed and make the client believe its previous avatar survived.
  const identityValleyIds = await identityValleysForWallet(db, wallet);
  const normalized = await withAvatarNormalizationSlot(
    () => normalizeAvatar(input, declaredContentType),
  );
  const hash = createHash('sha256').update(normalized).digest('hex');
  const candidateGeneration = randomUUID();
  const candidateKey = avatarObjectKey(wallet, hash, candidateGeneration);
  // True means a PUT may have reached R2 but its generation is not yet known to
  // have committed. A unique key makes cleanup incapable of deleting another
  // request's winner, including after an ambiguous transaction failure.
  let candidateMayExist = false;

  try {
    const result = await withAvatarMutationPermit(() => db.transaction(async (tx) => {
      // FIRST transaction statement. `hashtextextended` gives one cross-process
      // generation lock per wallet without trusting a process-local mutex.
      await acquireAvatarMutationLock(tx, wallet);
      const [before] = await tx.select({
        wallet: players.wallet,
        avatarHash: players.avatarHash,
        avatarGeneration: players.avatarGeneration,
        avatarUpdatedAt: players.avatarUpdatedAt,
      }).from(players).where(eq(players.wallet, wallet));
      if (!before) throw new Error('authenticated player row disappeared');

      // Re-PUT the SELECTED generation when normalized bytes are unchanged. It
      // self-heals a missing object without generating a key that the retirement
      // worker could mistake for obsolete content.
      if (before.avatarHash === hash && before.avatarGeneration) {
        await putAvatarObject(
          storage,
          avatarObjectKey(wallet, before.avatarHash, before.avatarGeneration),
          normalized,
        );
        return serializeAvatar(storage.publicBaseUrl, before);
      }

      // First uploads create no retirement and remain available even when old
      // generations are backpressured. Replacements reserve one global backlog
      // slot before producing another immutable object.
      if (before.avatarHash && before.avatarGeneration) {
        await acquireAvatarRetirementAdmission(tx);
      }

      try {
        // Mark before awaiting: a timeout is an ambiguous PUT, so cleanup must
        // still issue an idempotent DELETE for this never-reused generation.
        candidateMayExist = true;
        await putAvatarObject(storage, candidateKey, normalized);
        const [after] = await tx.update(players).set({
          avatarHash: hash,
          avatarGeneration: candidateGeneration,
          avatarUpdatedAt: new Date(),
        }).where(eq(players.wallet, wallet)).returning({
          wallet: players.wallet,
          avatarHash: players.avatarHash,
          avatarGeneration: players.avatarGeneration,
          avatarUpdatedAt: players.avatarUpdatedAt,
        });
        if (!after) throw new Error('authenticated player row disappeared');

        if (before.avatarHash && before.avatarGeneration) {
          await tx.insert(outbox).values({
            kind: 'avatar_delete',
            payload: {
              wallet,
              key: avatarObjectKey(wallet, before.avatarHash, before.avatarGeneration),
            },
          });
        }
        return serializeAvatar(storage.publicBaseUrl, after);
      } catch (err) {
        // Callback failure means this transaction will roll back. Cleanup while
        // the wallet lock is still held; a failed cleanup is retried once outside.
        if (candidateMayExist && await removeFailedUpload(storage, candidateKey)) {
          candidateMayExist = false;
        }
        throw err;
      }
    }));
    // Pointer and retirement row committed together; this generation is live.
    candidateMayExist = false;
    await publishWorldIdentityAfterCommit(db, wallet, identityValleyIds);
    return result;
  } catch (err) {
    if (candidateMayExist) {
      // A commit acknowledgement can fail after PostgreSQL committed. Prove the
      // candidate is not current before deleting it; if the recheck itself is
      // unavailable, leak one immutable object rather than erase a live avatar.
      try {
        const [current] = await db.select({
          wallet: players.wallet,
          avatarHash: players.avatarHash,
          avatarGeneration: players.avatarGeneration,
          avatarUpdatedAt: players.avatarUpdatedAt,
        }).from(players).where(eq(players.wallet, wallet));
        if (current?.avatarHash === hash
          && current.avatarGeneration === candidateGeneration) {
          await publishWorldIdentityAfterCommit(db, wallet, identityValleyIds);
          return serializeAvatar(storage.publicBaseUrl, current);
        }
        await removeFailedUpload(storage, candidateKey);
      } catch (recheckError) {
        console.warn('[avatar-r2] skipped ambiguous-commit cleanup', recheckError);
      }
    }
    throw err;
  }
}

/** Clear the pointer and queue its immutable generation in the SAME serialized
 * transaction. Object-store availability never enters this request; bounded
 * retirement admission can backpressure a clear rather than leave its public
 * object in an unbounded queue. */
export async function clearPlayerAvatar(
  db: Db, publicBaseUrl: string | undefined, wallet: string,
): Promise<AvatarIdentity> {
  const identityValleyIds = await identityValleysForWallet(db, wallet);
  const result = await withAvatarMutationPermit(() => db.transaction(async (tx) => {
    // FIRST transaction statement — shared with upload, so upload↔clear races
    // serialize across pools, processes and API replicas.
    await acquireAvatarMutationLock(tx, wallet);
    const [before] = await tx.select({
      wallet: players.wallet,
      avatarHash: players.avatarHash,
      avatarGeneration: players.avatarGeneration,
      avatarUpdatedAt: players.avatarUpdatedAt,
    }).from(players).where(eq(players.wallet, wallet));
    if (!before) throw new Error('authenticated player row disappeared');
    if (before.avatarHash === null && before.avatarUpdatedAt) {
      return serializeAvatar(publicBaseUrl, before);
    }
    if (before.avatarHash && before.avatarGeneration) {
      await acquireAvatarRetirementAdmission(tx);
    }

    const [after] = await tx.update(players).set({
      avatarHash: null,
      avatarGeneration: null,
      avatarUpdatedAt: new Date(),
    }).where(eq(players.wallet, wallet)).returning({
      wallet: players.wallet,
      avatarHash: players.avatarHash,
      avatarGeneration: players.avatarGeneration,
      avatarUpdatedAt: players.avatarUpdatedAt,
    });
    if (!after) throw new Error('authenticated player row disappeared');
    if (before.avatarHash && before.avatarGeneration) {
      await tx.insert(outbox).values({
        kind: 'avatar_delete',
        payload: {
          wallet,
          key: avatarObjectKey(wallet, before.avatarHash, before.avatarGeneration),
        },
      });
    }
    return serializeAvatar(publicBaseUrl, after);
  }));
  await publishWorldIdentityAfterCommit(db, wallet, identityValleyIds);
  return result;
}

interface AvatarRetirementPayload {
  wallet: string;
  key: string;
}

function parseAvatarRetirement(payload: unknown): AvatarRetirementPayload {
  if (!payload || typeof payload !== 'object') throw new Error('invalid avatar retirement payload');
  const { wallet, key } = payload as Record<string, unknown>;
  if (typeof wallet !== 'string' || typeof key !== 'string') {
    throw new Error('invalid avatar retirement payload');
  }
  assertAvatarKey(key);
  if (!key.startsWith(`avatar/${wallet}/`)) {
    throw new Error('avatar retirement key does not belong to its wallet');
  }
  return { wallet, key };
}

export interface AvatarRetirementResult {
  sent: number;
  retrying: number;
  terminal: number;
  skipped: number;
}

/** Durable exponential retry clock. Iterative doubling reaches the shared cap
 * without relying on an unbounded exponent from a hostile/corrupt row. */
export function avatarRetirementRetryAt(now: Date, attempts: number): Date {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('avatar retirement attempts must be a positive integer');
  }
  let delay: number = PROFILE_AVATAR.retirementRetryBaseMs;
  for (let i = 1; i < attempts && delay < PROFILE_AVATAR.retirementRetryMaxMs; i += 1) {
    delay = Math.min(
      delay * PROFILE_AVATAR.retirementRetryFactor,
      PROFILE_AVATAR.retirementRetryMaxMs,
    );
  }
  return new Date(now.getTime() + delay);
}

/** Drain bounded avatar-delete outbox work. Each row is locked across the
 * bounded DELETE so multiple worker replicas cannot race its attempt counter.
 * A current-key guard is checked immediately before every retry; immutable
 * generations make that guard remain true after the check. */
export async function relayAvatarRetirements(
  db: Db,
  remove: AvatarObjectDeleter,
  now = new Date(),
): Promise<AvatarRetirementResult> {
  const candidates = await db.select({ id: outbox.id }).from(outbox).where(and(
    eq(outbox.kind, 'avatar_delete'),
    eq(outbox.status, 'pending'),
    lte(outbox.nextAttemptAt, now),
  )).orderBy(asc(outbox.nextAttemptAt), asc(outbox.id))
    .limit(PROFILE_AVATAR.retirementBatchSize);

  let sent = 0;
  let retrying = 0;
  let terminal = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const outcome = await db.transaction(async (tx): Promise<
      'sent' | 'retrying' | 'terminal' | 'skipped'
    > => {
      const [row] = await tx.select().from(outbox).where(and(
        eq(outbox.id, candidate.id),
        eq(outbox.kind, 'avatar_delete'),
        eq(outbox.status, 'pending'),
        lte(outbox.nextAttemptAt, now),
      )).for('update', { skipLocked: true });
      if (!row) return 'skipped';

      let payload: AvatarRetirementPayload;
      try {
        payload = parseAvatarRetirement(row.payload);
      } catch (err) {
        await tx.update(outbox).set({
          attempts: row.attempts + 1,
          status: 'failed',
          lastError: errorForStorage(err),
        }).where(and(eq(outbox.id, row.id), eq(outbox.status, 'pending')));
        return 'terminal';
      }

      const [current] = await tx.select({
        avatarHash: players.avatarHash,
        avatarGeneration: players.avatarGeneration,
      }).from(players).where(eq(players.wallet, payload.wallet));
      const currentKey = current?.avatarHash && current.avatarGeneration
        ? avatarObjectKey(payload.wallet, current.avatarHash, current.avatarGeneration)
        : null;
      if (currentKey === payload.key) {
        await tx.update(outbox).set({
          attempts: row.attempts + 1,
          status: 'failed',
          lastError: 'refusing to retire the currently selected avatar generation',
        }).where(and(eq(outbox.id, row.id), eq(outbox.status, 'pending')));
        return 'terminal';
      }

      try {
        await withAvatarStorageDeadline('DELETE', (signal) => remove(payload.key, signal));
        // Successful avatar retirement has no audit/custody value after the
        // immutable object is confirmed absent. Compact it in this same locked
        // transaction so healthy profile churn cannot grow outbox forever.
        // If this DB delete rolls back after R2 succeeded, the pending row is
        // retried safely because object deletion is idempotent.
        await tx.delete(outbox).where(and(
          eq(outbox.id, row.id),
          eq(outbox.kind, 'avatar_delete'),
          eq(outbox.status, 'pending'),
        ));
        return 'sent';
      } catch (err) {
        const attempts = row.attempts + 1;
        const lastError = errorForStorage(err);
        await tx.update(outbox).set({
          attempts,
          status: 'pending',
          nextAttemptAt: avatarRetirementRetryAt(now, attempts),
          lastError,
        }).where(and(eq(outbox.id, row.id), eq(outbox.status, 'pending')));
        if (attempts >= PROFILE_AVATAR.retirementAlertAfterAttempts) {
          console.error(
            `[avatar-retirement-alert] delete has failed ${attempts} times for outbox ${row.id}: ${lastError}`,
          );
        }
        return 'retrying';
      }
    });
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'retrying') retrying += 1;
    else if (outcome === 'terminal') terminal += 1;
    else skipped += 1;
  }
  return { sent, retrying, terminal, skipped };
}

/** Drain more than one healthy batch without letting one scheduled invocation
 * become unbounded. Rows that retry move their due clock forward, terminal rows
 * leave pending work, and successful rows are compacted. A no-progress all-
 * SKIP-LOCKED pass stops early instead of selecting concurrently-owned rows. */
export async function drainAvatarRetirements(
  db: Db,
  remove: AvatarObjectDeleter,
  now = new Date(),
): Promise<AvatarRetirementResult> {
  const total: AvatarRetirementResult = {
    sent: 0,
    retrying: 0,
    terminal: 0,
    skipped: 0,
  };
  for (let batch = 0; batch < PROFILE_AVATAR.retirementMaxBatchesPerRun; batch += 1) {
    const result = await relayAvatarRetirements(db, remove, now);
    total.sent += result.sent;
    total.retrying += result.retrying;
    total.terminal += result.terminal;
    total.skipped += result.skipped;

    const selected = result.sent + result.retrying + result.terminal + result.skipped;
    const progressed = result.sent + result.retrying + result.terminal;
    if (selected < PROFILE_AVATAR.retirementBatchSize || progressed === 0) break;
  }
  return total;
}
