/**
 * Public avatar uploads are hostile image parsing plus a public object write.
 * These tests pin the two security boundaries: only normalized still pixels
 * leave the API, and an object-store failure cannot move the live DB pointer.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { PROFILE_AVATAR } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { outbox, players, sessions } from '../src/db/schema';
import {
  acquireAvatarRawUploadPermit, assertAvatarKey, avatarObjectKey,
  avatarScopedDeleter, avatarScopedPutter,
  AvatarBusyError, clearPlayerAvatar, normalizeAvatar, uploadPlayerAvatar,
  avatarRetirementRetryAt, drainAvatarRetirements, relayAvatarRetirements,
  withAvatarMutationPermit, withAvatarNormalizationSlot, withAvatarStorageDeadline,
  withAvatarReadPermit,
  AVATAR_MAX_CONCURRENT_MUTATIONS, AVATAR_MAX_CONCURRENT_NORMALIZATIONS,
  AVATAR_MAX_CONCURRENT_RAW_UPLOADS, AVATAR_MAX_CONCURRENT_READS, AVATAR_MAX_UPLOAD_BYTES,
  type AvatarObjectPutter, type AvatarStorage,
} from '../src/game/playerAvatar';
import { TEST_CONFIG, connectTestDb, randomWallet } from './helpers';

const PUBLIC_BASE = 'https://public.example.test';
let conn: ReturnType<typeof connectTestDb>;
let raceConn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;
let stored: Array<{ key: string; body: Buffer }>;
let deleted: string[];
let put: AvatarObjectPutter;

async function sessionFor(wallet = randomWallet()): Promise<{ wallet: string; cookie: string }> {
  await conn.db.insert(players).values({ wallet });
  const id = randomUUID();
  await conn.db.insert(sessions).values({
    id,
    wallet,
    expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000),
  });
  return { wallet, cookie: await issueSessionJwt(TEST_CONFIG, wallet, id) };
}

async function jpeg(colour: { r: number; g: number; b: number }, width = 480, height = 320) {
  return sharp({ create: { width, height, channels: 3, background: colour } })
    // Deliberately include EXIF so the output test proves the API strips it.
    .withExif({ IFD0: { Artist: 'must-not-leave-the-api' } })
    .jpeg()
    .toBuffer();
}

beforeAll(async () => {
  conn = connectTestDb();
  // A distinct pool proves the advisory lock is a database generation lock, not
  // accidental serialization by one postgres.js connection.
  raceConn = connectTestDb();
  stored = [];
  deleted = [];
  put = async (key, body) => { stored.push({ key, body: Buffer.from(body) }); };
  app = await buildApp(TEST_CONFIG, conn.db, {
    avatarStorage: {
      publicBaseUrl: PUBLIC_BASE,
      put: avatarScopedPutter((key, body) => put(key, body)),
      delete: avatarScopedDeleter(async (key) => { deleted.push(key); }),
      read: async (key) => [...stored].reverse().find((entry) => entry.key === key)?.body ?? null,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raceConn.sql.end();
  await conn.sql.end();
});

describe('avatar object namespace', () => {
  it('accepts only content-addressed wallet keys and cannot reach deed/token objects', async () => {
    const wallet = randomWallet();
    const hash = 'a'.repeat(64);
    const generation = randomUUID();
    expect(assertAvatarKey(`avatar/${wallet}/${hash}/${generation}.webp`))
      .toBe(`avatar/${wallet}/${hash}/${generation}.webp`);
    for (const key of [
      'keep-token-logo.png',
      `avatar/${wallet}/../keep-token-logo.webp`,
      `deed/${wallet}.png`,
      `avatar/${wallet}/${'A'.repeat(64)}.webp`,
    ]) {
      await expect(avatarScopedPutter(async () => undefined)(key, Buffer.alloc(1)))
        .rejects.toThrow('REFUSING');
      await expect(avatarScopedDeleter(async () => undefined)(key))
        .rejects.toThrow('REFUSING');
    }
  });

  it('never runs more than the bounded number of hostile image jobs at once', async () => {
    let active = 0;
    let highWater = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs = Array.from({ length: AVATAR_MAX_CONCURRENT_NORMALIZATIONS }, () =>
      withAvatarNormalizationSlot(async () => {
        active += 1;
        highWater = Math.max(highWater, active);
        await gate;
        active -= 1;
      }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(highWater).toBe(AVATAR_MAX_CONCURRENT_NORMALIZATIONS);
    await expect(withAvatarNormalizationSlot(async () => undefined))
      .rejects.toBeInstanceOf(AvatarBusyError);
    release?.();
    await Promise.all(jobs);
    expect(highWater).toBe(AVATAR_MAX_CONCURRENT_NORMALIZATIONS);
  });

  it('admits at most two object-store mutations and times them out abortably', async () => {
    let active = 0;
    let highWater = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs = Array.from({ length: AVATAR_MAX_CONCURRENT_MUTATIONS }, () =>
      withAvatarMutationPermit(async () => {
        active += 1;
        highWater = Math.max(highWater, active);
        await gate;
        active -= 1;
      }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(highWater).toBe(AVATAR_MAX_CONCURRENT_MUTATIONS);
    await expect(withAvatarMutationPermit(async () => undefined))
      .rejects.toBeInstanceOf(AvatarBusyError);
    release?.();
    await Promise.all(jobs);

    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const timedOut = withAvatarStorageDeadline('PUT', (nextSignal) => {
        signal = nextSignal;
        return new Promise<void>(() => {});
      });
      // Attach the rejection observer before advancing the fake clock; otherwise
      // Node correctly reports the deadline as briefly unhandled between turns.
      const outcome = timedOut.then(
        () => null,
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(PROFILE_AVATAR.storageMutationTimeoutMs);
      await expect(outcome).resolves.toMatchObject({ message: 'avatar storage PUT timed out' });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds opaque avatar reads without queueing behind a slow object store', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reads = Array.from({ length: AVATAR_MAX_CONCURRENT_READS }, () =>
      withAvatarReadPermit(() => gate));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(withAvatarReadPermit(async () => undefined))
      .rejects.toBeInstanceOf(AvatarBusyError);
    release?.();
    await Promise.all(reads);
    await expect(withAvatarReadPermit(async () => 'available')).resolves.toBe('available');
  });

  it('makes raw-upload permit release idempotent', () => {
    const releases = Array.from(
      { length: AVATAR_MAX_CONCURRENT_RAW_UPLOADS },
      () => acquireAvatarRawUploadPermit(),
    );
    expect(() => acquireAvatarRawUploadPermit()).toThrow(AvatarBusyError);
    releases[0]!();
    releases[0]!();
    const replacement = acquireAvatarRawUploadPermit();
    replacement();
    for (const release of releases.slice(1)) release();
  });
});

describe('avatar normalization', () => {
  it('emits one 256px sRGB WebP with source metadata removed', async () => {
    const out = await normalizeAvatar(await jpeg({ r: 80, g: 120, b: 160 }), 'image/jpeg');
    const metadata = await sharp(out, { animated: true }).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 256, height: 256 });
    expect(metadata.pages ?? 1).toBe(1);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it('rejects forged media types, SVG and multi-page input', async () => {
    const realJpeg = await jpeg({ r: 1, g: 2, b: 3 });
    await expect(normalizeAvatar(realJpeg, 'image/png')).rejects.toThrow('do not match');
    await expect(normalizeAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'))
      .rejects.toThrow(/could not be decoded safely|do not match/);

    const sourceAnimation = readFileSync(path.resolve(
      import.meta.dirname, '../../../art/source/token-logo/keeptokenshine.gif',
    ));
    const animated = await sharp(sourceAnimation, { animated: true }).webp().toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBeGreaterThan(1);
    await expect(normalizeAvatar(animated, 'image/webp')).rejects.toThrow('multi-page');
  });
});

describe('avatar mutation generation', () => {
  it('fails a same-wallet contender fast, admits another wallet, then retries safely', async () => {
    const identity = await sessionFor();
    const other = await sessionFor();
    const firstBody = await jpeg({ r: 15, g: 30, b: 45 });
    const secondBody = await jpeg({ r: 180, g: 90, b: 20 });
    const events: string[] = [];
    const objects = new Set<string>();
    let releaseFirst: (() => void) | undefined;
    let sawFirstPut: (() => void) | undefined;
    const firstPut = new Promise<void>((resolve) => { sawFirstPut = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let blocked = false;
    const storage: AvatarStorage = {
      publicBaseUrl: PUBLIC_BASE,
      put: async (key) => {
        events.push(`PUT ${key}`);
        objects.add(key);
        if (!blocked && key.startsWith(`avatar/${identity.wallet}/`)) {
          blocked = true;
          sawFirstPut?.();
          await firstGate;
        }
      },
      delete: async (key) => {
        events.push(`DELETE ${key}`);
        objects.delete(key);
      },
    };

    const first = uploadPlayerAvatar(
      conn.db, storage, identity.wallet, firstBody, 'image/jpeg',
    );
    await firstPut;
    await expect(uploadPlayerAvatar(
      raceConn.db, storage, identity.wallet, secondBody, 'image/jpeg',
    )).rejects.toBeInstanceOf(AvatarBusyError);

    // The failed contender released its global permit immediately. A different
    // wallet can still finish while the first wallet's R2 PUT is deliberately held.
    const otherIdentity = await uploadPlayerAvatar(
      raceConn.db, storage, other.wallet,
      await jpeg({ r: 9, g: 100, b: 190 }), 'image/jpeg',
    );
    expect(otherIdentity.avatarUrl).toContain(`/avatar/${other.wallet}/`);
    releaseFirst?.();
    const firstIdentity = await first;
    const secondIdentity = await uploadPlayerAvatar(
      raceConn.db, storage, identity.wallet, secondBody, 'image/jpeg',
    );
    expect(firstIdentity.avatarUrl).not.toBe(secondIdentity.avatarUrl);
    expect(events.every((event) => event.startsWith('PUT '))).toBe(true);
    const finalKey = new URL(secondIdentity.avatarUrl!).pathname.slice(1);
    const firstKey = new URL(firstIdentity.avatarUrl!).pathname.slice(1);
    const [row] = await conn.db.select({
      hash: players.avatarHash, generation: players.avatarGeneration,
    })
      .from(players).where(eq(players.wallet, identity.wallet));
    expect(avatarObjectKey(identity.wallet, row!.hash!, row!.generation!)).toBe(finalKey);
    const retirementRows = await conn.db.select().from(outbox).where(and(
      eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'pending'),
    ));
    expect(retirementRows.some((entry) => (
      entry.payload as { wallet?: string; key?: string }
    ).key === firstKey)).toBe(true);

    const retired = await relayAvatarRetirements(
      conn.db, storage.delete, new Date(Date.now() + 1_000),
    );
    expect(retired.sent).toBeGreaterThanOrEqual(1);
    expect(objects.has(firstKey)).toBe(false);
    expect(objects.has(finalKey)).toBe(true);
  });

  it('commits pointer changes with retirements and never deletes in the request transaction', async () => {
    const identity = await sessionFor();
    const events: string[] = [];
    const objects = new Set<string>();
    const storage: AvatarStorage = {
      publicBaseUrl: PUBLIC_BASE,
      put: async (key) => { events.push(`PUT ${key}`); objects.add(key); },
      delete: async (key) => {
        events.push(`DELETE ${key}`);
        objects.delete(key);
      },
    };
    const original = await uploadPlayerAvatar(
      conn.db, storage, identity.wallet, await jpeg({ r: 40, g: 50, b: 60 }), 'image/jpeg',
    );
    const oldKey = new URL(original.avatarUrl!).pathname.slice(1);
    events.length = 0;

    const replacement = await uploadPlayerAvatar(
      conn.db, storage, identity.wallet, await jpeg({ r: 200, g: 5, b: 80 }), 'image/jpeg',
    );
    const newKey = new URL(replacement.avatarUrl!).pathname.slice(1);
    expect(events).toEqual([`PUT ${newKey}`]);
    const [afterReplace] = await raceConn.db.select({
      hash: players.avatarHash, generation: players.avatarGeneration,
    })
      .from(players).where(eq(players.wallet, identity.wallet));
    expect(avatarObjectKey(
      identity.wallet, afterReplace!.hash!, afterReplace!.generation!,
    )).toBe(newKey);

    await clearPlayerAvatar(conn.db, PUBLIC_BASE, identity.wallet);
    expect(events).toEqual([`PUT ${newKey}`]);
    const [afterClear] = await raceConn.db.select({
      hash: players.avatarHash, generation: players.avatarGeneration,
    })
      .from(players).where(eq(players.wallet, identity.wallet));
    expect(afterClear).toEqual({ hash: null, generation: null });
    const retirements = await conn.db.select().from(outbox).where(and(
      eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'pending'),
    ));
    const queuedKeys = retirements.map((entry) => (
      entry.payload as { key?: string }
    ).key);
    expect(queuedKeys).toEqual(expect.arrayContaining([oldKey, newKey]));

    const relayNow = new Date(Date.now() + 1_000);
    const unavailable = await relayAvatarRetirements(
      conn.db, async () => { throw new Error('R2 delete unavailable'); }, relayNow,
    );
    expect(unavailable.retrying).toBeGreaterThanOrEqual(2);
    expect(objects).toEqual(new Set([oldKey, newKey]));
    const recovered = await relayAvatarRetirements(
      conn.db, storage.delete,
      new Date(relayNow.getTime() + PROFILE_AVATAR.retirementRetryBaseMs),
    );
    expect(recovered.sent).toBeGreaterThanOrEqual(2);
    expect(objects).toEqual(new Set());
  });

  it('cleans a unique candidate when its database pointer cannot commit', async () => {
    const wallet = randomWallet();
    await conn.db.insert(players).values({ wallet });
    const objects = new Set<string>();
    let releasePut: (() => void) | undefined;
    let putStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { putStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releasePut = resolve; });
    const storage: AvatarStorage = {
      publicBaseUrl: PUBLIC_BASE,
      put: async (key) => {
        objects.add(key);
        putStarted?.();
        await gate;
      },
      delete: async (key) => { objects.delete(key); },
    };
    const upload = uploadPlayerAvatar(
      conn.db, storage, wallet, await jpeg({ r: 120, g: 130, b: 140 }), 'image/jpeg',
    );
    const outcome = upload.then(
      () => null,
      (err: unknown) => err,
    );
    await started;
    await raceConn.db.delete(players).where(eq(players.wallet, wallet));
    releasePut?.();
    await expect(outcome).resolves.toMatchObject({
      message: 'authenticated player row disappeared',
    });
    expect(objects).toEqual(new Set());
  });

  it('re-PUTs identical normalized bytes to self-heal a missing selected object', async () => {
    const identity = await sessionFor();
    const objects = new Set<string>();
    const putKeys: string[] = [];
    const storage: AvatarStorage = {
      publicBaseUrl: PUBLIC_BASE,
      put: async (key) => { putKeys.push(key); objects.add(key); },
      delete: async (key) => { objects.delete(key); },
    };
    const body = await jpeg({ r: 75, g: 85, b: 95 });
    const first = await uploadPlayerAvatar(
      conn.db, storage, identity.wallet, body, 'image/jpeg',
    );
    const selectedKey = new URL(first.avatarUrl!).pathname.slice(1);
    objects.delete(selectedKey); // simulate an object loss while the DB pointer survives

    const retry = await uploadPlayerAvatar(
      raceConn.db, storage, identity.wallet, body, 'image/jpeg',
    );
    expect(retry).toEqual(first); // generation/timestamp did not change
    expect(putKeys).toEqual([selectedKey, selectedKey]);
    expect(objects).toEqual(new Set([selectedKey]));
  });

  it('locks one retirement across workers and quarantines a current-key row', async () => {
    const identity = await sessionFor();
    const storage: AvatarStorage = {
      publicBaseUrl: PUBLIC_BASE,
      put: async () => undefined,
      delete: async () => undefined,
    };
    const first = await uploadPlayerAvatar(
      conn.db, storage, identity.wallet, await jpeg({ r: 1, g: 40, b: 80 }), 'image/jpeg',
    );
    await uploadPlayerAvatar(
      conn.db, storage, identity.wallet, await jpeg({ r: 2, g: 41, b: 81 }), 'image/jpeg',
    );
    const retiredKey = new URL(first.avatarUrl!).pathname.slice(1);
    let deleteCalls = 0;
    let releaseDelete: (() => void) | undefined;
    let deleteStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { deleteStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const relayNow = new Date(Date.now() + 1_000);
    const firstWorker = relayAvatarRetirements(conn.db, async (key) => {
      expect(key).toBe(retiredKey);
      deleteCalls += 1;
      deleteStarted?.();
      await gate;
    }, relayNow);
    await started;
    const secondWorker = await relayAvatarRetirements(raceConn.db, async () => {
      deleteCalls += 1;
    }, relayNow);
    expect(secondWorker.skipped).toBeGreaterThanOrEqual(1);
    releaseDelete?.();
    await firstWorker;
    expect(deleteCalls).toBe(1);

    const [current] = await conn.db.select({
      hash: players.avatarHash, generation: players.avatarGeneration,
    }).from(players).where(eq(players.wallet, identity.wallet));
    const currentKey = avatarObjectKey(identity.wallet, current!.hash!, current!.generation!);
    const [malicious] = await conn.db.insert(outbox).values({
      kind: 'avatar_delete', payload: { wallet: identity.wallet, key: currentKey },
    }).returning({ id: outbox.id });
    const [invalid] = await conn.db.insert(outbox).values({
      kind: 'avatar_delete', payload: { wallet: identity.wallet, key: 'deed/not-an-avatar' },
    }).returning({ id: outbox.id });
    const remove = vi.fn(async () => undefined);
    const poison = await relayAvatarRetirements(
      conn.db, remove, new Date(relayNow.getTime() + 2_000),
    );
    expect(poison.terminal).toBe(2);
    const quarantined = await conn.db.select().from(outbox).where(and(
      eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'failed'),
    ));
    expect(quarantined.find(({ id }) => id === malicious!.id)).toMatchObject({ attempts: 1 });
    expect(quarantined.find(({ id }) => id === malicious!.id)?.lastError)
      .toContain('currently selected');
    expect(quarantined.find(({ id }) => id === invalid!.id)).toMatchObject({ attempts: 1 });
    expect(remove).not.toHaveBeenCalled();
    expect(await relayAvatarRetirements(
      conn.db, remove, new Date(relayNow.getTime() + 3_000),
    )).toEqual({
      sent: 0, retrying: 0, terminal: 0, skipped: 0,
    });
  });

  it('compacts confirmed avatar retirements without touching durable failures or roots', async () => {
    // WHY: immutable avatar generations need durable retries only until R2
    // confirms deletion. Keeping every success as status=sent made ordinary
    // profile churn grow the shared transactional outbox without bound; root
    // publication rows remain permanent custody/audit evidence.
    await conn.db.update(outbox).set({ status: 'sent' }).where(and(
      eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'pending'),
    ));
    const wallet = randomWallet();
    await conn.db.insert(players).values({ wallet });
    const now = new Date('2034-01-01T00:00:00.000Z');
    const successKey = avatarObjectKey(wallet, 'c'.repeat(64), randomUUID());
    const failureKey = avatarObjectKey(wallet, 'd'.repeat(64), randomUUID());
    const [success] = await conn.db.insert(outbox).values({
      kind: 'avatar_delete', payload: { wallet, key: successKey },
      nextAttemptAt: new Date(now.getTime() - 2_000),
    }).returning({ id: outbox.id });
    const [failure] = await conn.db.insert(outbox).values({
      kind: 'avatar_delete', payload: { wallet, key: failureKey },
      nextAttemptAt: new Date(now.getTime() - 1_000),
    }).returning({ id: outbox.id });
    const rootPayload = { epoch: '99', root: 'ab'.repeat(32), totalBalance: '7' };
    const [root] = await conn.db.insert(outbox).values({
      kind: 'post_root', payload: rootPayload, status: 'sent',
      sentAt: now, txSignature: 'root-audit-sentinel',
    }).returning({ id: outbox.id });

    try {
      const result = await relayAvatarRetirements(conn.db, async (key) => {
        if (key === failureKey) throw new Error('R2 unavailable');
      }, now);
      expect(result).toEqual({ sent: 1, retrying: 1, terminal: 0, skipped: 0 });

      expect(await conn.db.select().from(outbox).where(eq(outbox.id, success!.id)))
        .toEqual([]);
      const [retry] = await conn.db.select().from(outbox)
        .where(eq(outbox.id, failure!.id));
      expect(retry).toMatchObject({
        kind: 'avatar_delete', status: 'pending', attempts: 1,
      });
      expect(retry?.lastError).toContain('R2 unavailable');
      const [rootAfter] = await conn.db.select().from(outbox)
        .where(eq(outbox.id, root!.id));
      expect(rootAfter).toMatchObject({
        kind: 'post_root', status: 'sent', payload: rootPayload,
        txSignature: 'root-audit-sentinel',
      });
    } finally {
      await conn.db.delete(outbox).where(eq(outbox.id, failure!.id));
      await conn.db.delete(outbox).where(eq(outbox.id, root!.id));
    }
  });

  it('retries beyond the alert threshold with capped backoff without starving newer rows', async () => {
    await conn.db.update(outbox).set({ status: 'sent' }).where(and(
      eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'pending'),
    ));
    const wallet = randomWallet();
    await conn.db.insert(players).values({ wallet });
    const now = new Date('2035-01-01T00:00:00.000Z');
    const oldRows = Array.from({ length: PROFILE_AVATAR.retirementBatchSize }, (_, index) => ({
      kind: 'avatar_delete',
      payload: {
        wallet,
        key: avatarObjectKey(wallet, index.toString(16).padStart(64, '0'), randomUUID()),
      },
      attempts: PROFILE_AVATAR.retirementAlertAfterAttempts,
      nextAttemptAt: new Date(now.getTime() - 2_000),
    }));
    await conn.db.insert(outbox).values(oldRows);
    const newerKey = avatarObjectKey(wallet, 'f'.repeat(64), randomUUID());
    await conn.db.insert(outbox).values({
      kind: 'avatar_delete', payload: { wallet, key: newerKey },
      nextAttemptAt: new Date(now.getTime() - 1_000),
    });

    const alert = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outage = await relayAvatarRetirements(
        conn.db, async () => { throw new Error('R2 outage'); }, now,
      );
      expect(outage).toMatchObject({
        sent: 0, retrying: PROFILE_AVATAR.retirementBatchSize,
      });
      expect(alert).toHaveBeenCalled();

      // Failed old rows moved into the future, so the next due pass reaches the
      // newer row even though its id sorts after a full batch of failures.
      const deleted: string[] = [];
      const fair = await relayAvatarRetirements(
        conn.db, async (key) => { deleted.push(key); }, now,
      );
      expect(fair.sent).toBe(1);
      expect(deleted).toEqual([newerKey]);

      const retryAt = avatarRetirementRetryAt(
        now, PROFILE_AVATAR.retirementAlertAfterAttempts + 1,
      );
      expect(retryAt.getTime() - now.getTime())
        .toBe(PROFILE_AVATAR.retirementRetryMaxMs);
      const recovered = await relayAvatarRetirements(
        conn.db, async (key) => { deleted.push(key); }, retryAt,
      );
      expect(recovered.sent).toBe(PROFILE_AVATAR.retirementBatchSize);
      expect(JSON.stringify(recovered)).toBe(
        JSON.stringify({
          sent: PROFILE_AVATAR.retirementBatchSize,
          retrying: 0,
          terminal: 0,
          skipped: 0,
        }),
      );
    } finally {
      alert.mockRestore();
    }
  });

  it('drains more than one due batch in one bounded worker invocation', async () => {
    // WHY: a one-batch minute worker admitted distributed replacements faster
    // than it could retire their immutable objects, so the public backlog could
    // grow without bound even while R2 was healthy.
    await conn.db.update(outbox).set({ status: 'sent' }).where(and(
      eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'pending'),
    ));
    const wallet = randomWallet();
    await conn.db.insert(players).values({ wallet });
    const count = PROFILE_AVATAR.retirementBatchSize + 1;
    const due = new Date('2036-01-01T00:00:00.000Z');
    await conn.db.insert(outbox).values(Array.from({ length: count }, (_, index) => ({
      kind: 'avatar_delete',
      payload: {
        wallet,
        key: avatarObjectKey(wallet, index.toString(16).padStart(64, '0'), randomUUID()),
      },
      nextAttemptAt: new Date(due.getTime() - 1_000),
    })));

    const removed: string[] = [];
    const result = await drainAvatarRetirements(
      conn.db, async (key) => { removed.push(key); }, due,
    );
    expect(result).toEqual({ sent: count, retrying: 0, terminal: 0, skipped: 0 });
    expect(removed).toHaveLength(count);
  });

  it('caps retirement admission without blocking a first upload', async () => {
    // WHY: per-wallet/IP request limits do not cap aggregate replicas. The DB
    // advisory admission lock makes this global count authoritative, while an
    // upload with no previous generation does not consume retirement capacity.
    await conn.db.update(outbox).set({ status: 'sent' }).where(and(
      eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'pending'),
    ));
    const firstWallet = randomWallet();
    const replaceWallet = randomWallet();
    const clearWallet = randomWallet();
    const replaceGeneration = randomUUID();
    const clearGeneration = randomUUID();
    await conn.db.insert(players).values([
      { wallet: firstWallet },
      {
        wallet: replaceWallet,
        avatarHash: 'a'.repeat(64),
        avatarGeneration: replaceGeneration,
        avatarUpdatedAt: new Date(),
      },
      {
        wallet: clearWallet,
        avatarHash: 'b'.repeat(64),
        avatarGeneration: clearGeneration,
        avatarUpdatedAt: new Date(),
      },
    ]);
    const fillerWallet = randomWallet();
    await conn.db.insert(players).values({ wallet: fillerWallet });
    await conn.db.insert(outbox).values(Array.from(
      { length: PROFILE_AVATAR.retirementMaxPending },
      (_, index) => ({
        kind: 'avatar_delete',
        payload: {
          wallet: fillerWallet,
          key: avatarObjectKey(
            fillerWallet, index.toString(16).padStart(64, '0'), randomUUID(),
          ),
        },
      }),
    ));
    const put = vi.fn(async () => undefined);
    const storage: AvatarStorage = {
      publicBaseUrl: PUBLIC_BASE,
      put,
      delete: async () => undefined,
    };

    try {
      const first = await uploadPlayerAvatar(
        conn.db, storage, firstWallet, await jpeg({ r: 10, g: 20, b: 30 }), 'image/jpeg',
      );
      expect(first.avatarUrl).toContain(`/avatar/${firstWallet}/`);
      expect(put).toHaveBeenCalledTimes(1);

      await expect(uploadPlayerAvatar(
        conn.db, storage, replaceWallet,
        await jpeg({ r: 200, g: 100, b: 50 }), 'image/jpeg',
      )).rejects.toThrow('retirement backlog is full');
      await expect(clearPlayerAvatar(conn.db, PUBLIC_BASE, clearWallet))
        .rejects.toThrow('retirement backlog is full');
      // Capacity rejection happens before another public object or pointer is produced.
      expect(put).toHaveBeenCalledTimes(1);
      const [unchangedReplace] = await conn.db.select({
        hash: players.avatarHash,
        generation: players.avatarGeneration,
      }).from(players).where(eq(players.wallet, replaceWallet));
      const [unchangedClear] = await conn.db.select({
        hash: players.avatarHash,
        generation: players.avatarGeneration,
      }).from(players).where(eq(players.wallet, clearWallet));
      expect(unchangedReplace).toEqual({
        hash: 'a'.repeat(64), generation: replaceGeneration,
      });
      expect(unchangedClear).toEqual({
        hash: 'b'.repeat(64), generation: clearGeneration,
      });
    } finally {
      await conn.db.update(outbox).set({ status: 'sent' }).where(and(
        eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'pending'),
      ));
    }
  });
});

describe('avatar HTTP lifecycle', () => {
  const assertAllRawUploadPermitsAvailable = (): void => {
    const releases = Array.from(
      { length: AVATAR_MAX_CONCURRENT_RAW_UPLOADS },
      () => acquireAvatarRawUploadPermit(),
    );
    try {
      expect(() => acquireAvatarRawUploadPermit()).toThrow(AvatarBusyError);
    } finally {
      for (const release of releases) release();
    }
  };

  it('rejects unauthenticated and over-cap uploads before parsing their bodies', async () => {
    // WHY: preHandler authentication occurs after Fastify buffers a parser body.
    // An oversized body distinguishes lifecycle order: 401/503 proves onRequest
    // rejected it before the scoped parser could return 413 or reach the handler.
    const oversized = Buffer.alloc(AVATAR_MAX_UPLOAD_BYTES + 1);
    const storedBefore = stored.length;
    const unauthorized = await app.inject({
      method: 'PATCH', url: '/me/avatar',
      headers: { 'content-type': 'image/jpeg' }, payload: oversized,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(stored).toHaveLength(storedBefore);

    const identity = await sessionFor();
    const releases = Array.from(
      { length: AVATAR_MAX_CONCURRENT_RAW_UPLOADS },
      () => acquireAvatarRawUploadPermit(),
    );
    try {
      const overCapacity = await app.inject({
        method: 'PATCH', url: '/me/avatar',
        cookies: { [SESSION_COOKIE]: identity.cookie },
        headers: { 'content-type': 'image/jpeg' }, payload: oversized,
      });
      expect(overCapacity.statusCode).toBe(503);
      expect(overCapacity.json()).toMatchObject({
        error: { message: 'avatar upload capacity is busy; try again' },
      });
      expect(stored).toHaveLength(storedBefore);
    } finally {
      for (const release of releases) release();
    }
    assertAllRawUploadPermitsAvailable();
  });

  it('releases raw-upload admission after success, parser error and handler error', async () => {
    const identity = await sessionFor();
    const success = await app.inject({
      method: 'PATCH', url: '/me/avatar',
      cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' },
      payload: await jpeg({ r: 8, g: 16, b: 24 }),
    });
    expect(success.statusCode).toBe(200);
    assertAllRawUploadPermitsAvailable();

    const parserError = await app.inject({
      method: 'PATCH', url: '/me/avatar',
      cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.alloc(AVATAR_MAX_UPLOAD_BYTES + 1),
    });
    expect(parserError.statusCode).toBe(413);
    assertAllRawUploadPermitsAvailable();

    const savedPut = put;
    put = async () => { throw new Error('R2 unavailable'); };
    try {
      const handlerError = await app.inject({
        method: 'PATCH', url: '/me/avatar',
        cookies: { [SESSION_COOKIE]: identity.cookie },
        headers: { 'content-type': 'image/jpeg' },
        payload: await jpeg({ r: 80, g: 160, b: 240 }),
      });
      expect(handlerError.statusCode).toBe(503);
      assertAllRawUploadPermitsAvailable();
    } finally {
      put = savedPut;
    }
  });

  it('aborts incomplete bodies at the receive deadline and admits a later upload', async () => {
    // WHY: Fastify's default requestTimeout is zero. Without a route-scoped
    // receive clock, two authenticated clients can drip bytes forever and hold
    // every raw-upload permit without ever reaching parsing or normalization.
    const identity = await sessionFor();
    const receiveTimeoutMs = 500;
    const slowApp = await buildApp(TEST_CONFIG, conn.db, {
      avatarUploadReceiveTimeoutMs: receiveTimeoutMs,
      avatarStorage: {
        publicBaseUrl: PUBLIC_BASE,
        put: avatarScopedPutter((key, body) => put(key, body)),
        delete: avatarScopedDeleter(async (key) => { deleted.push(key); }),
      },
    });
    await slowApp.ready();
    const origin = await slowApp.listen({ host: '127.0.0.1', port: 0 });
    const slowRequests: ReturnType<typeof httpRequest>[] = [];
    try {
      const aborted = Array.from({ length: AVATAR_MAX_CONCURRENT_RAW_UPLOADS }, () => (
        new Promise<Error>((resolve, reject) => {
          const request = httpRequest(new URL('/me/avatar', origin), {
            method: 'PATCH',
            headers: {
              cookie: `${SESSION_COOKIE}=${identity.cookie}`,
              'content-type': 'image/jpeg',
              'content-length': String(AVATAR_MAX_UPLOAD_BYTES),
            },
          });
          slowRequests.push(request);
          const guard = setTimeout(() => {
            request.destroy();
            reject(new Error('incomplete avatar upload was not aborted'));
          }, receiveTimeoutMs * 10);
          request.once('error', (err) => {
            clearTimeout(guard);
            resolve(err);
          });
          // Send a valid image prefix but deliberately never complete the body.
          request.write(Buffer.from([0xff, 0xd8, 0xff]));
        })
      ));

      // Wait until both actual HTTP requests own the two raw permits, then prove
      // a third authenticated request fails before its oversized body is parsed.
      await vi.waitFor(() => {
        let release: (() => void) | undefined;
        try {
          release = acquireAvatarRawUploadPermit();
        } catch (err) {
          expect(err).toBeInstanceOf(AvatarBusyError);
          return;
        }
        release();
        throw new Error('raw upload permits are not both occupied yet');
      }, { timeout: receiveTimeoutMs });
      const blocked = await slowApp.inject({
        method: 'PATCH', url: '/me/avatar',
        cookies: { [SESSION_COOKIE]: identity.cookie },
        headers: { 'content-type': 'image/jpeg' },
        payload: Buffer.alloc(AVATAR_MAX_UPLOAD_BYTES + 1),
      });
      expect(blocked.statusCode).toBe(503);

      const errors = await Promise.all(aborted);
      expect(errors).toHaveLength(AVATAR_MAX_CONCURRENT_RAW_UPLOADS);
      const later = await slowApp.inject({
        method: 'PATCH', url: '/me/avatar',
        cookies: { [SESSION_COOKIE]: identity.cookie },
        headers: { 'content-type': 'image/jpeg' },
        payload: await jpeg({ r: 30, g: 60, b: 90 }),
      });
      expect(later.statusCode).toBe(200);
      assertAllRawUploadPermitsAvailable();
    } finally {
      for (const request of slowRequests) request.destroy();
      await slowApp.close();
    }
  });

  it('uploads normalized bytes, serializes /me, retries idempotently and clears', async () => {
    const identity = await sessionFor();
    const body = await jpeg({ r: 20, g: 80, b: 30 });
    const storedBefore = stored.length;
    const first = await app.inject({
      method: 'PATCH',
      url: '/me/avatar',
      cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const profile = first.json() as { avatarUrl: string; avatarUpdatedAt: string };
    expect(profile.avatarUrl).toMatch(
      new RegExp(
        `^${PUBLIC_BASE}/avatar/${identity.wallet}/[0-9a-f]{64}/`
        + '[0-9a-f-]{36}\\.webp$',
      ),
    );
    expect(Number.isNaN(Date.parse(profile.avatarUpdatedAt))).toBe(false);
    expect(stored).toHaveLength(storedBefore + 1);
    expect((await sharp(stored[storedBefore]!.body).metadata()).format).toBe('webp');

    const firstGeneration = new URL(profile.avatarUrl).pathname.split('/').at(-1)!.replace('.webp', '');
    const opaque = await app.inject({
      url: `/avatars/${firstGeneration}.webp`,
      cookies: { [SESSION_COOKIE]: identity.cookie },
    });
    expect(opaque.statusCode).toBe(200);
    expect(opaque.headers['content-type']).toContain('image/webp');
    expect(opaque.headers['cache-control']).toContain('private');
    expect(opaque.rawPayload.equals(stored[storedBefore]!.body)).toBe(true);

    const me = await app.inject({
      url: '/me', cookies: { [SESSION_COOKIE]: identity.cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject(profile);

    const retry = await app.inject({
      method: 'PATCH', url: '/me/avatar', cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' }, payload: body,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(profile);
    // Same-byte retry still PUTs the content-addressed object: this repairs an
    // object-store loss without moving the stable DB generation.
    expect(stored).toHaveLength(storedBefore + 2);

    const replaced = await app.inject({
      method: 'PATCH', url: '/me/avatar', cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' }, payload: await jpeg({ r: 120, g: 20, b: 80 }),
    });
    expect(replaced.statusCode).toBe(200);
    const replacement = replaced.json() as { avatarUrl: string; avatarUpdatedAt: string };
    expect(replacement.avatarUrl).not.toBe(profile.avatarUrl);
    expect(deleted).not.toContain(new URL(profile.avatarUrl).pathname.slice(1));
    expect((await app.inject({
      url: `/avatars/${firstGeneration}.webp`,
      cookies: { [SESSION_COOKIE]: identity.cookie },
    })).statusCode).toBe(404);

    const replacementGeneration = new URL(replacement.avatarUrl).pathname
      .split('/').at(-1)!.replace('.webp', '');
    expect((await app.inject({
      url: `/avatars/${replacementGeneration}.webp`,
      cookies: { [SESSION_COOKIE]: identity.cookie },
    })).statusCode).toBe(200);

    const cleared = await app.inject({
      method: 'DELETE', url: '/me/avatar', cookies: { [SESSION_COOKIE]: identity.cookie },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().avatarUrl).toBeNull();
    expect(Date.parse(cleared.json().avatarUpdatedAt)).toBeGreaterThanOrEqual(
      Date.parse(profile.avatarUpdatedAt),
    );
    const [row] = await conn.db.select({ hash: players.avatarHash })
      .from(players).where(eq(players.wallet, identity.wallet));
    expect(row?.hash).toBeNull();
    expect(deleted).not.toContain(new URL(replacement.avatarUrl).pathname.slice(1));
    expect((await app.inject({
      url: `/avatars/${replacementGeneration}.webp`,
      cookies: { [SESSION_COOKIE]: identity.cookie },
    })).statusCode).toBe(404);

    const relayed = await relayAvatarRetirements(
      conn.db,
      avatarScopedDeleter(async (key) => { deleted.push(key); }),
      new Date(Date.now() + 1_000),
    );
    expect(relayed.sent).toBeGreaterThanOrEqual(2);
    expect(deleted).toContain(new URL(profile.avatarUrl).pathname.slice(1));
    expect(deleted).toContain(new URL(replacement.avatarUrl).pathname.slice(1));
  });

  it('preserves the old pointer when R2 fails and rejects disguised input', async () => {
    const identity = await sessionFor();
    const original = await jpeg({ r: 70, g: 40, b: 10 });
    const ok = await app.inject({
      method: 'PATCH', url: '/me/avatar', cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' }, payload: original,
    });
    expect(ok.statusCode).toBe(200);
    const [before] = await conn.db.select({
      hash: players.avatarHash,
      generation: players.avatarGeneration,
      updatedAt: players.avatarUpdatedAt,
    }).from(players).where(eq(players.wallet, identity.wallet));

    put = async () => { throw new Error('R2 unavailable'); };
    const failed = await app.inject({
      method: 'PATCH', url: '/me/avatar', cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' }, payload: await jpeg({ r: 1, g: 2, b: 250 }),
    });
    expect(failed.statusCode).toBe(503);
    const [after] = await conn.db.select({
      hash: players.avatarHash,
      generation: players.avatarGeneration,
      updatedAt: players.avatarUpdatedAt,
    }).from(players).where(eq(players.wallet, identity.wallet));
    expect(after).toEqual(before);
    put = async (key, image) => { stored.push({ key, body: Buffer.from(image) }); };

    const disguised = await app.inject({
      method: 'PATCH', url: '/me/avatar', cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/png' }, payload: original,
    });
    expect(disguised.statusCode).toBe(422);
  });

  it('clears and durably queues retirement when worker R2 credentials are absent', async () => {
    const identity = await sessionFor();
    const hash = 'b'.repeat(64);
    const generation = randomUUID();
    const key = avatarObjectKey(identity.wallet, hash, generation);
    await conn.db.update(players).set({
      avatarHash: hash, avatarGeneration: generation, avatarUpdatedAt: new Date(),
    }).where(eq(players.wallet, identity.wallet));
    const noStorageApp = await buildApp(TEST_CONFIG, conn.db, {
      avatarPublicBaseUrl: PUBLIC_BASE,
    });
    await noStorageApp.ready();
    try {
      const response = await noStorageApp.inject({
        method: 'DELETE', url: '/me/avatar',
        cookies: { [SESSION_COOKIE]: identity.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().avatarUrl).toBeNull();
      const rows = await conn.db.select().from(outbox).where(and(
        eq(outbox.kind, 'avatar_delete'), eq(outbox.status, 'pending'),
      ));
      expect(rows.some((entry) => (
        entry.payload as { key?: string }
      ).key === key)).toBe(true);
      expect((await relayAvatarRetirements(
        conn.db, async () => undefined, new Date(Date.now() + 1_000),
      )).sent)
        .toBeGreaterThanOrEqual(1);
    } finally {
      await noStorageApp.close();
    }
  });

  it('rejects unsupported upload media before image decoding', async () => {
    const identity = await sessionFor();
    const response = await app.inject({
      method: 'PATCH', url: '/me/avatar', cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/svg+xml' }, payload: '<svg/>',
    });
    expect(response.statusCode).toBe(415);
  });

  it('keeps raw image parsing exclusive to the avatar upload route', async () => {
    // WHY: a root-scoped parser made every route accept and buffer up to 8 MiB of
    // hostile image bytes before its own auth/validation hooks ran. `/me` is a real
    // JSON mutation in the same auth plugin and must reject the media type at the
    // content-type boundary; only PATCH `/me/avatar` may parse it as a Buffer.
    const identity = await sessionFor();
    const response = await app.inject({
      method: 'PATCH',
      url: '/me',
      cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: { message: 'Unsupported Media Type' } });

    const deleteWithImage = await app.inject({
      method: 'DELETE',
      url: '/me/avatar',
      cookies: { [SESSION_COOKIE]: identity.cookie },
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(deleteWithImage.statusCode).toBe(415);
  });
});

describe('migration 0079 deedless cleanup', () => {
  it('removes deedless plot ghosts without freeing a cell claimed by an extant deed', () => {
    const migration = readFileSync(
      path.resolve(import.meta.dirname, '../drizzle/0079_legal_titania.sql'), 'utf8',
    );
    expect(migration).toContain('"plots"."base_id" = "bases"."id"');
    expect(migration).toContain('"bases"."land_paid_at" IS NULL');
    expect(migration).toContain('"bases"."deed_asset_id" IS NULL');
    expect(migration).toContain('"bases"."deed_mint_asset_id" IS NULL');
    // Status must not enter this predicate: paid inactive deed/audit rows retain
    // their Earth cell, while an active unpaid/free row is exactly what leaves.
    expect(migration).not.toMatch(/DELETE[\s\S]*bases"\."status/i);
  });
});
