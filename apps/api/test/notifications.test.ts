/**
 * M33 Web Push server contract (D-101).
 *
 * These tests use the real migrated Postgres schema because the invariants are
 * cross-table: lazy completion sources, the (kind, ref_id) claim ledger,
 * rolling logical-push caps, and subscription retirement must agree in SQL.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NOTIFICATIONS } from '@shardkeep/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE } from '../src/auth/session';
import {
  baseTrainingQueue,
  bases,
  baseSlots,
  builderJobs,
  ledgerTransactions,
  mailMessages,
  players,
  pushEvents,
  pushSubscriptions,
  pveCamps,
  raids,
  sessions,
  trainingQueue,
} from '../src/db/schema';
import {
  sendToSubscription,
  sweepDueNotifications,
  type PushDeliveryTarget,
  type PushPayload,
  type PushSendOptions,
  type PushTransport,
} from '../src/notifications';
import {
  TEST_CONFIG,
  connectTestDb,
  createTestPlayer,
  createTestValley,
} from './helpers';

const conn = connectTestDb();
const db = conn.db;
const PUSH_CONFIG = {
  ...TEST_CONFIG,
  PUSH_NOTIFICATIONS_ENABLED: 'true' as const,
  // Routes only return this public value. Delivery tests inject a transport and
  // never contact a push service or expose production VAPID material.
  VAPID_PUBLIC_KEY: 'test-public-key',
  VAPID_PRIVATE_KEY: 'test-private-key',
  VAPID_SUBJECT: 'mailto:test@example.com',
};
let enabledApp: FastifyInstance;
let disabledApp: FastifyInstance;

const endpoint = (label: string): string =>
  `https://fcm.googleapis.com/fcm/send/${label}/${randomUUID()}`;
const pushKeys = (seed: number | string = 1) => {
  const byte = typeof seed === 'number' ? seed : [...seed].reduce((n, c) => n + c.charCodeAt(0), 0);
  return {
    p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, byte & 0xff)]).toString('base64url'),
    auth: Buffer.alloc(16, (byte + 1) & 0xff).toString('base64url'),
  };
};

async function cookieFor(wallet: string): Promise<string> {
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    wallet,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return issueSessionJwt(PUSH_CONFIG, wallet, id);
}

async function addSubscription(
  wallet: string,
  label: string,
  values: Partial<typeof pushSubscriptions.$inferInsert> = {},
): Promise<typeof pushSubscriptions.$inferSelect> {
  const [row] = await db.insert(pushSubscriptions).values({
    wallet,
    endpoint: endpoint(label),
    ...pushKeys(label),
    // Millisecond precision matches route writes and makes the consent epoch
    // usable as an exact optimistic-concurrency fence in transport tests.
    enabledAt: new Date(),
    ...values,
  }).returning();
  return row!;
}

beforeAll(async () => {
  enabledApp = await buildApp(PUSH_CONFIG, db);
  disabledApp = await buildApp(TEST_CONFIG, db);
  await Promise.all([enabledApp.ready(), disabledApp.ready()]);
});

afterAll(async () => {
  await Promise.all([enabledApp.close(), disabledApp.close()]);
  await conn.sql.end();
});

describe.sequential('notification subscription routes', () => {
  it('keeps VAPID cookie-authenticated and reports the disabled state without caching', async () => {
    const player = await createTestPlayer(db);
    const cookie = await cookieFor(player.wallet);

    expect((await enabledApp.inject({ method: 'GET', url: '/notifications/vapid' })).statusCode)
      .toBe(401);
    const enabled = await enabledApp.inject({
      method: 'GET', url: '/notifications/vapid', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ publicKey: PUSH_CONFIG.VAPID_PUBLIC_KEY });
    expect(enabled.headers['cache-control']).toBe('no-store, private');

    const disabled = await disabledApp.inject({
      method: 'GET', url: '/notifications/vapid', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ publicKey: null });
    const rejected = await disabledApp.inject({
      method: 'POST', url: '/notifications/subscribe',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { endpoint: endpoint('disabled'), keys: { p256dh: 'abc', auth: 'def' } },
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toMatchObject({ error: { code: 'PUSH_DISABLED' } });
  });

  it('refreshes boot state without moving an endpoint across wallets', async () => {
    const first = await createTestPlayer(db);
    const second = await createTestPlayer(db);
    const [firstCookie, secondCookie] = await Promise.all([
      cookieFor(first.wallet), cookieFor(second.wallet),
    ]);
    const oldEndpoint = endpoint('old');
    const liveEndpoint = endpoint('live');
    const subscribe = (cookie: string, payload: Record<string, unknown>) => enabledApp.inject({
      method: 'POST', url: '/notifications/subscribe',
      cookies: { [SESSION_COOKIE]: cookie }, payload,
    });

    expect((await subscribe(firstCookie, {
      endpoint: oldEndpoint, keys: pushKeys('old'),
    })).statusCode).toBe(204);
    expect((await subscribe(firstCookie, {
      endpoint: liveEndpoint, previousEndpoint: oldEndpoint,
      keys: pushKeys('new'), userAgent: 'Seeker test',
    })).statusCode).toBe(204);
    const [beforeBoot] = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, liveEndpoint));
    // Boot retry refreshes keys in place rather than creating a duplicate.
    expect((await subscribe(firstCookie, {
      endpoint: liveEndpoint, keys: pushKeys('fresh'),
    })).statusCode).toBe(204);

    const [old] = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, oldEndpoint));
    const [live] = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, liveEndpoint));
    expect(old?.disabledAt).not.toBeNull();
    expect(live).toMatchObject({
      wallet: first.wallet, ...pushKeys('fresh'), failures: 0,
    });
    expect(live?.enabledAt).toEqual(beforeBoot?.enabledAt);
    expect(await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, liveEndpoint))).toHaveLength(1);

    // Endpoint possession is not authority to move another wallet's capability,
    // even after that wallet disables it.
    const conflict = await subscribe(secondCookie, {
      endpoint: liveEndpoint, keys: pushKeys('second'),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'PUSH_ENDPOINT_OWNED' } });
    const [unchanged] = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, liveEndpoint));
    expect(unchanged).toEqual(live);
    expect((await enabledApp.inject({
      method: 'DELETE', url: '/notifications/subscribe',
      cookies: { [SESSION_COOKIE]: firstCookie }, payload: { endpoint: liveEndpoint },
    })).statusCode).toBe(204);
    const [disabled] = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, liveEndpoint));
    const gapAt = new Date(disabled!.disabledAt!.getTime() + 1);
    const [gapMail] = await db.insert(mailMessages).values({
      recipientWallet: first.wallet, senderKind: 'system', kind: 'info',
      dedupeKey: `route-gap:${randomUUID()}`, subject: 'While off', body: 'No backfill.',
      createdAt: gapAt,
    }).returning();
    expect((await subscribe(secondCookie, {
      endpoint: liveEndpoint, keys: pushKeys('second'),
    })).statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect((await subscribe(firstCookie, {
      endpoint: liveEndpoint, keys: pushKeys('revived'),
    })).statusCode).toBe(204);
    const [revived] = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, liveEndpoint));
    expect(revived!.enabledAt.getTime()).toBeGreaterThan(live!.enabledAt.getTime());
    expect(revived!.enabledAt.getTime()).toBeGreaterThan(gapAt.getTime());
    const afterAt = new Date(revived!.enabledAt.getTime() + 1);
    const [afterMail] = await db.insert(mailMessages).values({
      recipientWallet: first.wallet, senderKind: 'system', kind: 'info',
      dedupeKey: `route-after:${randomUUID()}`, subject: 'After revival', body: 'Deliver.',
      createdAt: afterAt,
    }).returning();
    const delivered: string[] = [];
    expect(await sweepDueNotifications(db, async (target) => { delivered.push(target.id); },
      new Date(afterAt.getTime() + 1))).toMatchObject({ claimed: 1, sent: 1 });
    expect(delivered).toEqual([revived!.id]);
    expect(await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mail'), eq(pushEvents.refId, gapMail!.id),
    ))).toHaveLength(0);
    expect(await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mail'), eq(pushEvents.refId, afterMail!.id),
    ))).toHaveLength(1);
    const secondEndpoint = endpoint('second-distinct');
    expect((await subscribe(secondCookie, {
      endpoint: secondEndpoint, keys: pushKeys('second-distinct'),
    })).statusCode).toBe(204);
    // DELETE is deliberately retry-safe.
    expect((await enabledApp.inject({
      method: 'DELETE', url: '/notifications/subscribe',
      cookies: { [SESSION_COOKIE]: firstCookie }, payload: { endpoint: liveEndpoint },
    })).statusCode).toBe(204);
    expect((await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, liveEndpoint)))[0]?.disabledAt).not.toBeNull();
  });

  it('accepts only canonical provider endpoints and browser-generated key shapes', async () => {
    const player = await createTestPlayer(db);
    const cookie = await cookieFor(player.wallet);
    const subscribe = (url: string, keys = pushKeys(url)) => enabledApp.inject({
      method: 'POST', url: '/notifications/subscribe', cookies: { [SESSION_COOKIE]: cookie },
      payload: { endpoint: url, keys }, remoteAddress: '198.51.100.10',
    });
    const accepted = [
      `https://fcm.googleapis.com.:443/fcm/send/${randomUUID()}`,
      `https://push.services.mozilla.com/wpush/${randomUUID()}`,
      `https://eu.push.services.mozilla.com/wpush/${randomUUID()}`,
      `https://web.push.apple.com/Q${randomUUID()}`,
      `https://db5.notify.windows.com/w/?token=${randomUUID()}`,
    ];
    for (const url of accepted) expect((await subscribe(url)).statusCode).toBe(204);
    const stored = await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.wallet, player.wallet));
    expect(stored.some((r) => r.endpoint.includes('.com./'))).toBe(false);
    expect(stored.some((r) => r.endpoint.includes(':443'))).toBe(false);

    const rejected = [
      'https://evil-fcm.googleapis.com/x', 'https://push.apple.com.evil.test/x',
      'https://localhost/x', 'https://127.0.0.1/x', 'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x', 'https://example.com/x', 'http://fcm.googleapis.com/x',
      'https://fcm.googleapis.com/x#ignored-identity',
    ];
    for (const url of rejected) expect((await subscribe(url)).statusCode).toBe(400);
    const valid = pushKeys('shape');
    for (const keys of [
      { ...valid, auth: `${valid.auth}=` },
      { ...valid, auth: Buffer.alloc(15).toString('base64url') },
      { ...valid, p256dh: Buffer.alloc(65, 3).toString('base64url') },
      { ...valid, p256dh: '***' },
    ]) expect((await subscribe(endpoint('bad-key'), keys)).statusCode).toBe(400);
  });

  it('serializes concurrent boot syncs and keeps at most five live devices', async () => {
    const player = await createTestPlayer(db);
    const cookie = await cookieFor(player.wallet);
    const attempts = Array.from({ length: NOTIFICATIONS.subscriptionMaxPerWallet + 4 }, (_, i) =>
      enabledApp.inject({
        method: 'POST', url: '/notifications/subscribe',
        cookies: { [SESSION_COOKIE]: cookie },
        payload: {
          endpoint: endpoint(`cap-${i}`),
          keys: pushKeys(i + 20),
        },
      }));
    const responses = await Promise.all(attempts);
    expect(responses.every((r) => r.statusCode === 204)).toBe(true);
    const live = await db.select().from(pushSubscriptions).where(and(
      eq(pushSubscriptions.wallet, player.wallet), isNull(pushSubscriptions.disabledAt),
    ));
    expect(live).toHaveLength(NOTIFICATIONS.subscriptionMaxPerWallet);
  });
});

describe.sequential('notification delivery bookkeeping', () => {
  it('retires 404/410 immediately, disables the fifth ordinary failure, and resets on success', async () => {
    const player = await createTestPlayer(db);
    const payload: PushPayload = {
      kind: 'mail', title: 'NEW MAIL', body: 'Test', tag: 'mail', url: '/?screen=mail',
    };
    const opts: PushSendOptions = {
      ttl: NOTIFICATIONS.ttlSec.mail,
      urgency: 'normal',
      topic: 'mail',
      timeout: NOTIFICATIONS.deliveryTimeoutMs,
    };
    const now = new Date('2030-01-01T00:00:00.000Z');

    for (const statusCode of [404, 410]) {
      const row = await addSubscription(player.wallet, `gone-${statusCode}`);
      const target: PushDeliveryTarget = row;
      const gone: PushTransport = async () => {
        throw Object.assign(new Error('gone'), { statusCode });
      };
      expect(await sendToSubscription(db, gone, target, payload, opts, now)).toBe('disabled');
      expect((await db.select().from(pushSubscriptions)
        .where(eq(pushSubscriptions.id, row.id)))[0]?.disabledAt).toEqual(now);
    }

    const flaky = await addSubscription(player.wallet, 'flaky');
    const failure: PushTransport = async () => { throw new Error('offline'); };
    for (let i = 1; i < NOTIFICATIONS.disableAfterFailures; i++) {
      expect(await sendToSubscription(db, failure, flaky, payload, opts, now)).toBe('failed');
      const [stored] = await db.select().from(pushSubscriptions)
        .where(eq(pushSubscriptions.id, flaky.id));
      expect(stored?.failures).toBe(i);
      expect(stored?.disabledAt).toBeNull();
    }
    expect(await sendToSubscription(db, failure, flaky, payload, opts, now)).toBe('disabled');
    expect((await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, flaky.id)))[0]).toMatchObject({
      failures: NOTIFICATIONS.disableAfterFailures, disabledAt: now,
    });

    const recovered = await addSubscription(player.wallet, 'recovered', { failures: 3 });
    const success: PushTransport = async () => {};
    expect(await sendToSubscription(db, success, recovered, payload, opts, now)).toBe('sent');
    expect((await db.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, recovered.id)))[0]).toMatchObject({
      failures: 0, disabledAt: null, lastSuccessAt: now,
    });
  });

  it('does not apply stale success, failure, or gone outcomes to a re-keyed consent epoch', async () => {
    const player = await createTestPlayer(db);
    const payload: PushPayload = {
      kind: 'mail', title: 'NEW MAIL', body: 'Test', tag: 'mail', url: '/?screen=mail',
    };
    const opts: PushSendOptions = {
      ttl: NOTIFICATIONS.ttlSec.mail, urgency: 'normal', topic: 'mail',
      timeout: NOTIFICATIONS.deliveryTimeoutMs,
    };
    for (const result of ['success', 'failure', 'gone'] as const) {
      const row = await addSubscription(player.wallet, `stale-${result}`, { failures: 2 });
      let announce!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { announce = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const transport: PushTransport = async () => {
        announce();
        await blocked;
        if (result !== 'success') {
          throw Object.assign(new Error(result), result === 'gone' ? { statusCode: 410 } : { statusCode: 500 });
        }
      };
      const pending = sendToSubscription(db, transport, row, payload, opts, new Date());
      await started;
      const newKeys = pushKeys(`revived-${result}`);
      const enabledAt = new Date(row.enabledAt.getTime() + 1_000);
      await db.update(pushSubscriptions).set({ ...newKeys, enabledAt, failures: 0, disabledAt: null })
        .where(eq(pushSubscriptions.id, row.id));
      release();
      await pending;
      expect((await db.select().from(pushSubscriptions)
        .where(eq(pushSubscriptions.id, row.id)))[0]).toMatchObject({
        ...newKeys, enabledAt, failures: 0, disabledAt: null, lastSuccessAt: null,
      });
    }
  });
});

describe.sequential('notification source sweep', () => {
  it('notifies PvP/mail, waits for a two-minute work batch, includes lazy completions, and claims once', async () => {
    const now = new Date('2031-02-03T04:05:06.000Z');
    const due = new Date(now.getTime() - 30_000);
    const victim = await createTestPlayer(db);
    const attacker = await createTestPlayer(db);
    await db.update(players).set({ name: 'BLACKBEARD' }).where(eq(players.wallet, attacker.wallet));
    const subscription = await addSubscription(victim.wallet, 'sweep');
    const [victimBase] = await db.insert(bases).values({ ownerWallet: victim.wallet }).returning();
    const [attackerBase] = await db.insert(bases).values({ ownerWallet: attacker.wallet }).returning();
    // The retained stable-defender capture requires the same active slot as
    // ordinary base registration. Notification assertions still use this raid.
    await db.insert(baseSlots).values({ wallet: victim.wallet, slot: 1, baseId: victimBase!.id });

    const [pvp] = await db.insert(raids).values({
      attackerWallet: attacker.wallet,
      attackerBaseId: attackerBase!.id,
      defenderWallet: victim.wallet,
      defenderBaseId: victimBase!.id,
      seed: 1n,
      snapshot: { buildings: [] },
      armySnapshot: { troops: [] },
      ordersDeadlineAt: due,
      status: 'resolved',
      resolvedAt: due,
    }).returning();
    const valley = await createTestValley(db, {
      name: `PUSH PVE ${randomUUID()}`,
      createdAt: new Date('2000-01-01T00:00:00.000Z'),
    });
    const [camp] = await db.insert(pveCamps).values({
      valleyId: valley.id, x: 0, y: 0, tier: 1, snapshot: { buildings: [] }, lootKeep: 1n,
    }).returning();
    const [pve] = await db.insert(raids).values({
      attackerWallet: victim.wallet,
      pveCampId: camp!.id,
      seed: 2n,
      snapshot: { buildings: [] },
      armySnapshot: { troops: [] },
      ordersDeadlineAt: due,
      status: 'resolved',
      resolvedAt: due,
    }).returning();
    const [mail] = await db.insert(mailMessages).values({
      recipientWallet: victim.wallet,
      senderKind: 'system',
      kind: 'info',
      dedupeKey: `push:${randomUUID()}`,
      subject: 'Your scouts returned',
      body: 'Open the report.',
      createdAt: due,
    }).returning();
    const [build] = await db.insert(builderJobs).values({
      playerWallet: victim.wallet,
      baseId: victimBase!.id,
      kind: 'build',
      startedAt: new Date(due.getTime() - 60_000),
      finishesAt: due,
      // A foreground read may have lazily completed this between source time
      // and the sweep; the event still happened and must not disappear.
      completedAt: due,
    }).returning();
    const [walletTraining] = await db.insert(trainingQueue).values({
      playerWallet: victim.wallet,
      troop: 'highlander',
      startedAt: new Date(due.getTime() - 60_000),
      finishesAt: due,
      // Natural lazy completion records at/after the promised finish and still
      // represents elapsed work.
      completedAt: new Date(due.getTime() + 1_000),
    }).returning();
    const [baseTraining] = await db.insert(baseTrainingQueue).values({
      baseId: victimBase!.id,
      troop: 'bowman',
      startedAt: new Date(due.getTime() - 60_000),
      finishesAt: due,
    }).returning();
    const [futureTraining] = await db.insert(baseTrainingQueue).values({
      baseId: victimBase!.id,
      troop: 'mage',
      startedAt: due,
      finishesAt: new Date(now.getTime() + 60_000),
    }).returning();

    // Paid speed-up completes before the original finishes_at. That future
    // timestamp is historical pricing input, not a second completion event.
    const [spedWallet] = await db.insert(trainingQueue).values({
      playerWallet: victim.wallet, troop: 'mage',
      startedAt: new Date(due.getTime() - 60_000), finishesAt: due,
      completedAt: new Date(due.getTime() - 10_000),
    }).returning();
    const [spedBase] = await db.insert(baseTrainingQueue).values({
      baseId: victimBase!.id, troop: 'tunneler',
      startedAt: new Date(due.getTime() - 60_000), finishesAt: due,
      completedAt: new Date(due.getTime() - 10_000),
    }).returning();

    // A cancelled v2 row is terminal history, not a completion event.
    const [debit, refund] = await db.insert(ledgerTransactions).values([
      { idempotencyKey: `push-debit:${randomUUID()}`, type: 'test.push.cancel.debit' },
      { idempotencyKey: `push-refund:${randomUUID()}`, type: 'test.push.cancel.refund' },
    ]).returning();
    const [cancelled] = await db.insert(trainingQueue).values({
      playerWallet: victim.wallet,
      troop: 'tunneler',
      startedAt: new Date(due.getTime() - 60_000),
      finishesAt: due,
      completedAt: due,
      economyVersion: 2,
      paidShardCost: 1n,
      debitLedgerTxnId: debit!.id,
      refundLedgerTxnId: refund!.id,
      cancelledAt: due,
      cancelIdempotencyKey: randomUUID(),
      questCreditedAt: null,
    }).returning();

    const deliveries: Array<{ target: PushDeliveryTarget; payload: PushPayload; opts: PushSendOptions }> = [];
    const transport: PushTransport = async (target, payload, opts) => {
      deliveries.push({ target, payload, opts });
    };
    const first = await sweepDueNotifications(db, transport, now);
    expect(first).toEqual({ claimed: 2, sent: 2, failed: 0, capped: 0, held: 1 });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.payload.kind)).toEqual(['raided', 'mail']);
    expect(deliveries[0]).toMatchObject({
      target: { id: subscription.id },
      payload: { body: 'BLACKBEARD attacked your base.', url: '/?screen=raidlog' },
      opts: {
        urgency: 'high', topic: 'raided', timeout: NOTIFICATIONS.deliveryTimeoutMs,
      },
    });

    const batchedAt = new Date(now.getTime() + 90_000);
    const second = await sweepDueNotifications(db, transport, batchedAt);
    expect(second).toEqual({ claimed: 4, sent: 1, failed: 0, capped: 0, held: 0 });
    expect(deliveries).toHaveLength(3);
    expect(deliveries[2]?.payload).toEqual({
      kind: 'build',
      title: 'BUILD & TRAINING FINISHED',
      body: '1 builder job and 3 troops are ready.',
      tag: 'build',
      url: '/?screen=base',
    });

    // The source rows remain visible forever; only the composite ledger keeps
    // a worker restart or repeat sweep from notifying twice.
    expect(await sweepDueNotifications(db, transport, batchedAt)).toEqual({
      claimed: 0, sent: 0, failed: 0, capped: 0, held: 0,
    });
    expect(deliveries).toHaveLength(3);
    const events = await db.select().from(pushEvents)
      .where(eq(pushEvents.wallet, victim.wallet))
      .orderBy(asc(pushEvents.kind), asc(pushEvents.refId));
    expect(events).toHaveLength(6);
    expect(events.map((e) => `${e.kind}:${e.refId}`)).toEqual(expect.arrayContaining([
      `raided:${pvp!.id}`,
      `mail:${mail!.id}`,
      `build:${build!.id}`,
      `training:training_queue:${walletTraining!.id}`,
      `training:base_training_queue:${baseTraining!.id}`,
      `training:base_training_queue:${futureTraining!.id}`,
    ]));
    expect(events.some((e) => e.refId === pve!.id)).toBe(false);
    expect(events.some((e) => e.refId.endsWith(cancelled!.id))).toBe(false);
    expect(events.some((e) => e.refId.endsWith(spedWallet!.id))).toBe(false);
    expect(events.some((e) => e.refId.endsWith(spedBase!.id))).toBe(false);
    const workDeliveries = new Set(events
      .filter((e) => e.kind === 'build' || e.kind === 'training')
      .map((e) => e.deliveryId));
    expect(workDeliveries.size).toBe(1);
    expect([...workDeliveries][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses consent epochs for both candidate discovery and delivery targets', async () => {
    const eventAt = new Date('2031-05-01T00:01:00.000Z');
    const afterEnable = new Date(eventAt.getTime() + 1_000);
    const now = new Date(eventAt.getTime() + 3_000);
    const revived = await createTestPlayer(db);
    const revivedSub = await addSubscription(revived.wallet, 'revived-boundary', { enabledAt: afterEnable });
    const [offGap] = await db.insert(mailMessages).values({
      recipientWallet: revived.wallet, senderKind: 'system', kind: 'info',
      dedupeKey: `gap:${randomUUID()}`, subject: 'While off', body: 'Do not backfill.', createdAt: eventAt,
    }).returning();
    const [after] = await db.insert(mailMessages).values({
      recipientWallet: revived.wallet, senderKind: 'system', kind: 'info',
      dedupeKey: `after:${randomUUID()}`, subject: 'After opt in', body: 'Deliver.',
      createdAt: new Date(afterEnable.getTime() + 1_000),
    }).returning();

    const boundary = await createTestPlayer(db);
    const oldSub = await addSubscription(boundary.wallet, 'old-boundary', {
      enabledAt: new Date(eventAt.getTime() - 1_000),
    });
    await addSubscription(boundary.wallet, 'new-boundary', { enabledAt: afterEnable });
    await db.insert(mailMessages).values({
      recipientWallet: boundary.wallet, senderKind: 'system', kind: 'info',
      dedupeKey: `boundary:${randomUUID()}`, subject: 'Boundary', body: 'Old consent only.', createdAt: eventAt,
    });

    const targets: string[] = [];
    const summary = await sweepDueNotifications(db, async (target) => { targets.push(target.id); }, now);
    expect(summary).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
    expect(targets).toEqual(expect.arrayContaining([revivedSub.id, oldSub.id]));
    expect(targets).toHaveLength(2);
    expect(await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mail'), eq(pushEvents.refId, offGap!.id),
    ))).toHaveLength(0);
    expect(await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mail'), eq(pushEvents.refId, after!.id),
    ))).toHaveLength(1);
  });

  it('anchors batching to the oldest due source so a work chain cannot slide forever', async () => {
    const firstDue = new Date('2031-06-01T00:00:00.000Z');
    const player = await createTestPlayer(db);
    await addSubscription(player.wallet, 'fixed-window', {
      enabledAt: new Date(firstDue.getTime() - 1_000),
    });
    const [base] = await db.insert(bases).values({ ownerWallet: player.wallet }).returning();
    for (const offset of [0, 90_000, 180_000]) {
      await db.insert(builderJobs).values({
        playerWallet: player.wallet, baseId: base!.id, kind: 'build',
        startedAt: new Date(firstDue.getTime() - 60_000),
        finishesAt: new Date(firstDue.getTime() + offset),
      });
    }
    let calls = 0;
    expect(await sweepDueNotifications(db, async () => { calls++; },
      new Date(firstDue.getTime() + 30_000))).toMatchObject({ held: 1, claimed: 0 });
    expect(await sweepDueNotifications(db, async () => { calls++; },
      new Date(firstDue.getTime() + NOTIFICATIONS.batchWindowMs + 1))).toMatchObject({
      held: 0, claimed: 2, sent: 1,
    });
    expect(calls).toBe(1);
  });

  it('never retries a source whose at-most-once claim was interrupted before outcome', async () => {
    const now = new Date('2031-07-01T00:00:01.000Z');
    const player = await createTestPlayer(db);
    await addSubscription(player.wallet, 'claimed-null', { enabledAt: new Date(now.getTime() - 10_000) });
    const [mail] = await db.insert(mailMessages).values({
      recipientWallet: player.wallet, senderKind: 'system', kind: 'info',
      dedupeKey: `claimed:${randomUUID()}`, subject: 'Claimed', body: 'No duplicate.',
      createdAt: new Date(now.getTime() - 1_000),
    }).returning();
    await db.insert(pushEvents).values({ kind: 'mail', refId: mail!.id, wallet: player.wallet });
    let calls = 0;
    expect(await sweepDueNotifications(db, async () => { calls++; }, now)).toEqual({
      claimed: 0, sent: 0, failed: 0, capped: 0, held: 0,
    });
    expect(calls).toBe(0);
    expect((await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mail'), eq(pushEvents.refId, mail!.id),
    )))[0]).toMatchObject({ outcome: null, sentAt: null });
  });

  it('ignores history outside six hours and records cap overflow without sending', async () => {
    expect(NOTIFICATIONS.hourlyWindowMs).toBe(60 * 60 * 1000);
    const now = new Date('2032-03-04T05:06:07.000Z');
    const player = await createTestPlayer(db);
    await addSubscription(player.wallet, 'cap-window');
    const [oldMail] = await db.insert(mailMessages).values({
      recipientWallet: player.wallet,
      senderKind: 'system', kind: 'info', dedupeKey: `old:${randomUUID()}`,
      subject: 'Old history', body: 'Never flood this on first deploy.',
      createdAt: new Date(now.getTime() - NOTIFICATIONS.sweepLookbackMs - 1),
    }).returning();
    const [dueMail] = await db.insert(mailMessages).values({
      recipientWallet: player.wallet,
      senderKind: 'system', kind: 'info', dedupeKey: `due:${randomUUID()}`,
      subject: 'Current mail', body: 'This event is in range.',
      createdAt: new Date(now.getTime() - 1_000),
    }).returning();
    const stamp = new Date(now.getTime() - 10_000);
    await db.insert(pushEvents).values(Array.from(
      { length: NOTIFICATIONS.perWalletHourlyCap },
      () => ({
        kind: 'mail', refId: randomUUID(), wallet: player.wallet,
        createdAt: stamp, sentAt: stamp, deliveryId: randomUUID(), outcome: 'sent',
      }),
    ));
    // One much older delivery proves the cap query is rolling, not lifetime.
    await db.insert(pushEvents).values({
      kind: 'mail', refId: randomUUID(), wallet: player.wallet,
      createdAt: new Date(now.getTime() - NOTIFICATIONS.hourlyWindowMs - 10_000),
      sentAt: new Date(now.getTime() - NOTIFICATIONS.hourlyWindowMs - 10_000),
      deliveryId: randomUUID(), outcome: 'sent',
    });

    let calls = 0;
    const summary = await sweepDueNotifications(db, async () => { calls++; }, now);
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 0, capped: 1, held: 0 });
    expect(calls).toBe(0);
    expect((await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mail'), eq(pushEvents.refId, dueMail!.id),
    )))[0]).toMatchObject({ outcome: 'capped', sentAt: null, deliveryId: null });
    expect(await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mail'), eq(pushEvents.refId, oldMail!.id),
    ))).toHaveLength(0);
  });
});

describe('migration 0100 query plan contract', () => {
  it('installs the claim constraints and every global due-time index', async () => {
    const indexes = await conn.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY(${[
        'push_events_wallet_sent_idx',
        'push_subscriptions_live_wallet_idx',
        'base_training_queue_notification_due_idx',
        'builder_jobs_notification_due_idx',
        'mail_messages_notification_due_idx',
        'raids_notification_due_idx',
        'training_queue_notification_due_idx',
      ]}::text[])
      ORDER BY indexname
    `;
    expect(indexes.map((r) => r.indexname)).toEqual([
      'base_training_queue_notification_due_idx',
      'builder_jobs_notification_due_idx',
      'mail_messages_notification_due_idx',
      'push_events_wallet_sent_idx',
      'push_subscriptions_live_wallet_idx',
      'raids_notification_due_idx',
      'training_queue_notification_due_idx',
    ]);
    const constraints = await conn.sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname = ANY(${[
        'push_events_kind_ref_id_pk',
        'push_events_kind_ck',
        'push_events_outcome_ck',
        'push_subscriptions_endpoint_unique',
        'push_subscriptions_failures_nonnegative_ck',
      ]}::text[])
      ORDER BY conname
    `;
    expect(constraints.map((r) => r.conname)).toEqual([
      'push_events_kind_ck',
      'push_events_kind_ref_id_pk',
      'push_events_outcome_ck',
      'push_subscriptions_endpoint_unique',
      'push_subscriptions_failures_nonnegative_ck',
    ]);
    const [epoch] = await conn.sql<{ is_nullable: string; column_default: string }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'push_subscriptions'
        AND column_name = 'enabled_at'
    `;
    expect(epoch).toMatchObject({ is_nullable: 'NO', column_default: 'now()' });
    const [liveIndex] = await conn.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'push_subscriptions_live_wallet_idx'
    `;
    expect(liveIndex?.indexdef).toContain('(wallet, enabled_at)');
  });

  it('installs the Mine cycle, due/bootstrap indexes, and resumable flood-safe latch', async () => {
    const columns = await conn.sql<{
      column_name: string; is_nullable: string; column_default: string | null;
    }[]>`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mine_accrual_states'
        AND column_name IN (
          'full_notification_cycle', 'full_notification_check_at',
          'full_notification_bootstrap_pending'
        )
      ORDER BY column_name
    `;
    const byName = new Map(columns.map((column) => [column.column_name, column]));
    expect(byName.get('full_notification_check_at')).toMatchObject({
      column_name: 'full_notification_check_at', is_nullable: 'YES', column_default: null,
    });
    expect(byName.get('full_notification_cycle')).toMatchObject({
      column_name: 'full_notification_cycle', is_nullable: 'NO', column_default: '0',
    });
    expect(byName.get('full_notification_bootstrap_pending')).toMatchObject({
      column_name: 'full_notification_bootstrap_pending',
      is_nullable: 'NO',
      column_default: 'false',
    });
    const indexes = await conn.sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'mine_accrual_states_full_notification_due_idx',
          'mine_accrual_states_full_notification_bootstrap_idx'
        )
    `;
    const dueIndex = indexes.find((row) => row.indexname
      === 'mine_accrual_states_full_notification_due_idx');
    expect(dueIndex?.indexdef).toContain('(full_notification_check_at)');
    expect(dueIndex?.indexdef).toContain('WHERE (full_notification_check_at IS NOT NULL)');
    const bootstrapIndex = indexes.find((row) => row.indexname
      === 'mine_accrual_states_full_notification_bootstrap_idx');
    expect(bootstrapIndex?.indexdef).toContain('(mine_building_id)');
    expect(bootstrapIndex?.indexdef).toContain('full_notification_bootstrap_pending = true');

    const constraints = await conn.sql<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = ANY(${[
        'mine_accrual_states_full_notification_cycle_nonnegative_ck',
        'push_events_kind_ck',
        'push_events_outcome_ck',
      ]}::text[])
      ORDER BY conname
    `;
    expect(constraints.find((row) => row.conname
      === 'mine_accrual_states_full_notification_cycle_nonnegative_ck')?.definition)
      .toContain('full_notification_cycle >= 0');
    expect(constraints.find((row) => row.conname === 'push_events_kind_ck')?.definition)
      .toContain("'mine_full'");
    expect(constraints.find((row) => row.conname === 'push_events_outcome_ck')?.definition)
      .toContain("'suppressed'");

    const migration = readFileSync(
      new URL('../drizzle/0101_mine_full_notifications.sql', import.meta.url), 'utf8',
    );
    expect(migration).toContain('"full_notification_bootstrap_pending" boolean DEFAULT true NOT NULL');
    expect(migration).toContain(
      'ALTER COLUMN "full_notification_bootstrap_pending" SET DEFAULT false',
    );
    // SQL cannot reproduce the live quota/referral projection. Existing rows
    // remain pending for the exact TypeScript classifier instead of receiving
    // a blanket cycle-0 suppression that would lose their future fill.
    expect(migration).not.toContain('INSERT INTO "push_events"');
  });
});

describe('notification deploy preflight', () => {
  it('checks the rollout flag and complete VAPID trio before maintenance without logging values', () => {
    const deploy = readFileSync(new URL('../../../infra/deploy.sh', import.meta.url), 'utf8');
    const start = deploy.indexOf("const pushEnabled = valueOf('PUSH_NOTIFICATIONS_ENABLED')");
    const end = deploy.indexOf("const withdrawalsEnabled = valueOf('WITHDRAWALS_ENABLED')", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const pushPreflight = deploy.slice(start, end);
    expect(pushPreflight).toContain("if (pushEnabled === 'true')");
    expect(pushPreflight).toContain("vapidKey('VAPID_PUBLIC_KEY', 65, true)");
    expect(pushPreflight).toContain("vapidKey('VAPID_PRIVATE_KEY', 32)");
    expect(pushPreflight).toContain('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not one matching pair');
    expect(pushPreflight).toContain("valueOf('VAPID_SUBJECT')");
    expect(pushPreflight).toContain('VAPID_SUBJECT must be a mailto: or https: URL');
    expect(pushPreflight).toContain("valueOf('MINE_FULL_NOTIFICATIONS_ENABLED')");
    expect(pushPreflight).toContain(
      'MINE_FULL_NOTIFICATIONS_ENABLED must be the exact literal true or false',
    );
    expect(pushPreflight).toContain(
      'MINE_FULL_NOTIFICATIONS_ENABLED=true requires PUSH_NOTIFICATIONS_ENABLED=true',
    );
    expect(pushPreflight).toContain("valueOf('LIVE_RAID_V2_ENABLED')");
    expect(pushPreflight).toContain(
      'LIVE_RAID_V2_ENABLED must be the exact literal true or false',
    );
    expect(pushPreflight).not.toMatch(/console\.(log|info|warn|error)/);

    for (const relative of ['../../../.env.example', '../../../infra/.env.prod.example']) {
      const example = readFileSync(new URL(relative, import.meta.url), 'utf8');
      for (const name of [
        'PUSH_NOTIFICATIONS_ENABLED', 'MINE_FULL_NOTIFICATIONS_ENABLED',
        'LIVE_RAID_V2_ENABLED',
        'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',
      ]) {
        expect(example.match(new RegExp(`^${name}=`, 'gm'))).toHaveLength(1);
      }
    }
  });
});
