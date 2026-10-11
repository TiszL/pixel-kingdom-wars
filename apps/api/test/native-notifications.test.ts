/** Real SQL invariants; every delivery is an injected in-memory transport. */
import { randomUUID } from 'node:crypto';
import { NOTIFICATIONS } from '@shardkeep/shared';
import { and, eq, isNull } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE } from '../src/auth/session';
import { builderJobs, mailMessages, nativePushSubscriptions, pushEvents, pushSubscriptions, raids, sessions, trainingQueue } from '../src/db/schema';
import { sweepDueNotifications } from '../src/notifications';
import { nativePushPayload, sendToNativeSubscription, type NativePushPayload, type NativePushTarget } from '../src/notifications/fcm';
import { registerNativeNotificationRoutes } from '../src/notifications/nativeRoutes';
import { HttpError } from '../src/lib/errors';
import { TEST_CONFIG, connectTestDb, createTestPlayer, insertActiveTestBase } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const config = { ...TEST_CONFIG, FCM_NOTIFICATIONS_ENABLED: 'true' as const, PUSH_NOTIFICATIONS_ENABLED: 'true' as const };
const path = '/native/notifications/v1/subscribe';
const packageName = 'gg.pixelkingdomwars.twa.debug';
const body = () => ({ token: `test:${randomUUID()}`, bindingId: randomUUID(), packageName });
let app: FastifyInstance;
let dark: FastifyInstance;
const cookies = (cookie: string) => ({ [SESSION_COOKIE]: cookie });
async function playerSession() {
  const player = await createTestPlayer(db);
  const id = randomUUID();
  await db.insert(sessions).values({ id, wallet: player.wallet, expiresAt: new Date(Date.now() + 600_000) });
  return { ...player, sessionId: id, cookie: await issueSessionJwt(config, player.wallet, id) };
}
async function subscription(wallet: string, enabledAt: Date, extra: Partial<typeof nativePushSubscriptions.$inferInsert> = {}) {
  const [row] = await db.insert(nativePushSubscriptions).values({ wallet, ...body(), enabledAt, ...extra }).returning();
  return row!;
}
async function mail(wallet: string, createdAt: Date) {
  const [row] = await db.insert(mailMessages).values({
    recipientWallet: wallet, senderKind: 'system', kind: 'info', dedupeKey: randomUUID(),
    subject: 'Scouts returned', body: 'Read the report', createdAt,
  }).returning();
  return row!;
}
const readToken = async (token: string) => (await db.select().from(nativePushSubscriptions).where(eq(nativePushSubscriptions.token, token)))[0]!;
const subscribe = (cookie: string, payload: object) => app.inject({ method: 'POST', url: path, cookies: cookies(cookie), payload });
const webBody = () => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
  keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
});

beforeAll(async () => {
  app = await buildApp(config, db);
  dark = await buildApp(TEST_CONFIG, db);
  await Promise.all([app.ready(), dark.ready()]);
});
afterAll(async () => { await Promise.all([app.close(), dark.close()]); await conn.sql.end(); });

describe.sequential('native notification consent', () => {
  it('is authenticated, land-independent, privately uncached and dark by default', async () => {
    const p = await playerSession();
    for (const [method, url] of [['GET', '/native/notifications/v1'], ['POST', path], ['DELETE', path]] as const) {
      expect((await app.inject({ method, url, ...(method === 'GET' ? {} : { payload: body() }) })).statusCode).toBe(401);
    }
    for (const [server, enabled] of [[app, true], [dark, false]] as const) {
      const response = await server.inject({ url: '/native/notifications/v1', cookies: cookies(p.cookie) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ version: 1, enabled });
      expect(response.headers['cache-control']).toBe('no-store, private');
    }
    expect((await dark.inject({ method: 'POST', url: path, cookies: cookies(p.cookie), payload: body() })).statusCode).toBe(503);
  });

  it('rejects unknown package, malformed capability/binding and unexpected fields without writing', async () => {
    const p = await playerSession();
    for (const bad of [{ token: '' }, { token: 'a b' }, { token: '\n' }, { token: 'a'.repeat(2049) },
      { bindingId: 'not-a-uuid' }, { packageName: 'gg.other.app' }, { wallet: p.wallet }]) {
      expect((await subscribe(p.cookie, { ...body(), ...bad })).statusCode).toBe(400);
    }
    expect(await db.select().from(nativePushSubscriptions).where(eq(nativePushSubscriptions.wallet, p.wallet))).toHaveLength(0);
  });

  it('preserves boot consent but resets it when the same token adopts a new binding', async () => {
    const p = await playerSession();
    const old = await subscription(p.wallet, new Date('2030-01-01'));
    // Use a historical consent timestamp so a millisecond-equal refresh cannot hide a regression.
    await db.update(nativePushSubscriptions).set({ enabledAt: new Date('2020-01-01') }).where(eq(nativePushSubscriptions.id, old.id));
    const request = { token: old.token, bindingId: old.bindingId, packageName: old.packageName };
    expect((await subscribe(p.cookie, request)).json()).toEqual({ ok: true });
    expect((await readToken(old.token)).enabledAt).toEqual(new Date('2020-01-01'));
    const newBinding = randomUUID();
    expect((await subscribe(p.cookie, { ...request, bindingId: newBinding })).statusCode).toBe(200);
    const rotated = await readToken(old.token);
    expect(rotated.bindingId).toBe(newBinding);
    expect(rotated.enabledAt.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
    const staleDelete = await dark.inject({ method: 'DELETE', url: path, cookies: cookies(p.cookie), payload: { token: old.token, bindingId: old.bindingId } });
    expect(staleDelete.statusCode).toBe(204);
    expect((await readToken(old.token)).disabledAt).toBeNull();
    expect((await dark.inject({ method: 'DELETE', url: path, cookies: cookies(p.cookie), payload: { token: old.token, bindingId: newBinding } })).statusCode).toBe(204);
    expect((await readToken(old.token)).disabledAt).not.toBeNull();
  });

  it('never assigns another wallet token, including a retired capability, or retires its previousToken', async () => {
    const a = await playerSession(); const b = await playerSession();
    const original = body();
    expect((await subscribe(a.cookie, original)).statusCode).toBe(200);
    expect((await subscribe(b.cookie, original)).statusCode).toBe(409);
    const own = body();
    expect((await subscribe(b.cookie, { ...own, previousToken: original.token })).statusCode).toBe(200);
    expect((await readToken(original.token)).disabledAt).toBeNull();
    await dark.inject({ method: 'DELETE', url: path, cookies: cookies(a.cookie), payload: { token: original.token, bindingId: original.bindingId } });
    expect((await subscribe(b.cookie, original)).statusCode).toBe(409);
    expect((await readToken(original.token)).wallet).toBe(a.wallet);
    await expect(db.update(nativePushSubscriptions).set({ wallet: b.wallet }).where(eq(nativePushSubscriptions.token, original.token))).rejects.toThrow();
  });

  it('atomically rotates the wallet own token and caps concurrent web plus native registrations at five', async () => {
    const p = await playerSession();
    const old = body(); const replacement = { ...body(), bindingId: old.bindingId, previousToken: old.token };
    await subscribe(p.cookie, old);
    await db.update(nativePushSubscriptions).set({ enabledAt: new Date('2020-01-01') }).where(eq(nativePushSubscriptions.token, old.token));
    await subscribe(p.cookie, replacement);
    expect((await readToken(old.token)).disabledAt).not.toBeNull();
    expect((await readToken(replacement.token)).enabledAt).toEqual(new Date('2020-01-01'));
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2
      ? subscribe(p.cookie, body())
      : app.inject({ method: 'POST', url: '/notifications/subscribe', cookies: cookies(p.cookie), payload: webBody() })));
    expect(replies.map((r) => r.statusCode).every((code) => code === 200 || code === 204)).toBe(true);
    const native = await db.select().from(nativePushSubscriptions).where(and(eq(nativePushSubscriptions.wallet, p.wallet), isNull(nativePushSubscriptions.disabledAt)));
    const web = await db.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.wallet, p.wallet), isNull(pushSubscriptions.disabledAt)));
    expect(native.length + web.length).toBe(NOTIFICATIONS.subscriptionMaxPerWallet);
  });

  it('full-session logout retires all wallet native tokens while other wallets remain subscribed', async () => {
    const a = await playerSession(); const b = await playerSession();
    const a1 = body(); const a2 = body(); const b1 = body();
    await subscribe(a.cookie, a1); await subscribe(a.cookie, a2); await subscribe(b.cookie, b1);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', cookies: cookies(a.cookie) })).statusCode).toBe(200);
    expect((await readToken(a1.token)).disabledAt).not.toBeNull();
    expect((await readToken(a2.token)).disabledAt).not.toBeNull();
    expect((await readToken(b1.token)).disabledAt).toBeNull();
    expect((await subscribe(a.cookie, a1)).statusCode).toBe(401);
  });

  it('A to lost B to C rotation retires A by stable binding without losing original consent', async () => {
    const p = await playerSession(); const original = body(); const anotherDevice = body();
    await subscribe(p.cookie, original); await subscribe(p.cookie, anotherDevice);
    await db.update(nativePushSubscriptions).set({ enabledAt: new Date('2020-01-01') }).where(eq(nativePushSubscriptions.token, original.token));
    const lostIntermediate = `test:${randomUUID()}`;
    const latest = { ...body(), bindingId: original.bindingId, previousToken: lostIntermediate };
    expect((await subscribe(p.cookie, latest)).statusCode).toBe(200);
    expect((await readToken(original.token)).disabledAt).not.toBeNull();
    expect((await readToken(latest.token)).enabledAt).toEqual(new Date('2020-01-01'));
    expect((await readToken(anotherDevice.token)).disabledAt).toBeNull();
    expect(await db.select().from(nativePushSubscriptions).where(and(
      eq(nativePushSubscriptions.wallet, p.wallet), eq(nativePushSubscriptions.bindingId, original.bindingId),
      isNull(nativePushSubscriptions.disabledAt),
    ))).toHaveLength(1);
  });

  it('explicit opt-out permanently revokes its binding, while a fresh UUID permits new consent', async () => {
    const p = await playerSession(); const original = body();
    await subscribe(p.cookie, original);
    await dark.inject({ method: 'DELETE', url: path, cookies: cookies(p.cookie), payload: { token: original.token, bindingId: original.bindingId } });
    for (const request of [original, { ...original, token: `test:${randomUUID()}` }]) {
      const result = await subscribe(p.cookie, request);
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({ error: { code: 'FCM_BINDING_REVOKED' } });
    }
    await expect(subscription(p.wallet, new Date(), { bindingId: original.bindingId })).rejects.toThrow();
    const fresh = { ...original, bindingId: randomUUID() };
    expect((await subscribe(p.cookie, fresh)).statusCode).toBe(200);
    // This old request may arrive after the token was rebound; historical
    // revocation survives that rebinding but cannot disable the new consent.
    await dark.inject({ method: 'DELETE', url: path, cookies: cookies(p.cookie), payload: { token: original.token, bindingId: original.bindingId } });
    expect(await readToken(original.token)).toMatchObject({ bindingId: fresh.bindingId, disabledAt: null });
  });

  for (const action of ['logout', 'DELETE-before-first-POST'] as const) {
  it(`a POST admitted before ${action} cannot revive revoked consent`, async () => {
    const p = await playerSession();
    let announce!: () => void; let release!: () => void;
    const admitted = new Promise<void>((resolve) => { announce = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const delayed = Fastify();
    // Deliberate middleware seam: this request has already passed authentication
    // before logout wins the wallet lock; only the transactional recheck can reject it.
    delayed.decorate('authenticate', async (req) => {
      req.wallet = p.wallet; req.sessionId = p.sessionId; announce(); await wait;
    });
    delayed.setErrorHandler((error, _req, reply) => reply.status(error instanceof HttpError ? error.statusCode : 500).send({ error: 'test' }));
    registerNativeNotificationRoutes(delayed, config, db);
    const registration = body();
    try {
      const pending = delayed.inject({ method: 'POST', url: path, payload: registration }).then((r) => r);
      await admitted;
      if (action === 'logout') {
        expect((await app.inject({ method: 'POST', url: '/auth/logout', cookies: cookies(p.cookie) })).statusCode).toBe(200);
      } else {
        expect((await dark.inject({ method: 'DELETE', url: path, cookies: cookies(p.cookie), payload: { token: registration.token, bindingId: registration.bindingId } })).statusCode).toBe(204);
      }
      release();
      expect((await pending).statusCode).toBe(action === 'logout' ? 401 : 409);
      expect(await db.select().from(nativePushSubscriptions).where(eq(nativePushSubscriptions.token, registration.token))).toHaveLength(0);
    } finally { release(); await delayed.close(); }
  });
  }
});

describe.sequential('one web and native event sweep', () => {
  it('native-only PvP warnings retain priority and standalone training retains its canonical kind', async () => {
    const p = await playerSession(); const attacker = await playerSession();
    const due = new Date('2039-01-01');
    await subscription(p.wallet, new Date(due.getTime() - 1000));
    const defenderBase = await insertActiveTestBase(db, { ownerWallet: p.wallet });
    const attackerBase = await insertActiveTestBase(db, { ownerWallet: attacker.wallet });
    await db.insert(raids).values({
      attackerWallet: attacker.wallet, attackerBaseId: attackerBase!.id,
      defenderWallet: p.wallet, defenderBaseId: defenderBase!.id,
      seed: 1n, snapshot: { buildings: [] }, armySnapshot: { troops: [] },
      ordersDeadlineAt: due, status: 'resolved', resolvedAt: due,
    });
    await db.insert(trainingQueue).values({ playerWallet: p.wallet, troop: 'highlander', finishesAt: due });
    const messages: Array<{ kind: string; url: string; urgency: string }> = [];
    await sweepDueNotifications(db, null, new Date(due.getTime() + NOTIFICATIONS.batchWindowMs), {
      fcmTransport: async (_target, payload, opts) => { messages.push({ kind: payload.kind, url: payload.url, urgency: opts.urgency }); },
    });
    expect(messages).toEqual([
      { kind: 'raided', url: '/?screen=raidlog', urgency: 'high' },
      { kind: 'training', url: '/?screen=base', urgency: 'normal' },
    ]);
  });

  it('claims a shared event once and uses one eventId for all native targets and the logical wallet cap', async () => {
    const p = await playerSession(); const at = new Date('2040-01-01');
    const first = await subscription(p.wallet, new Date(at.getTime() - 1000));
    await subscription(p.wallet, first.enabledAt);
    await db.insert(pushSubscriptions).values({ wallet: p.wallet, endpoint: webBody().endpoint, p256dh: 'key', auth: 'auth', enabledAt: first.enabledAt });
    const event = await mail(p.wallet, at);
    const messages: NativePushPayload[] = []; let webSends = 0;
    const send = async (_target: NativePushTarget, payload: NativePushPayload) => { messages.push(payload); };
    await Promise.all([1, 2].map(() => sweepDueNotifications(db, async () => { webSends++; }, at, { fcmTransport: send })));
    expect(webSends).toBe(1); expect(messages).toHaveLength(2);
    expect(new Set(messages.map((m) => m.eventId)).size).toBe(1);
    expect(messages[0]).toEqual({ version: '1', bindingId: expect.any(String), eventId: expect.any(String), kind: 'mail', title: 'NEW MAIL', body: 'Scouts returned', url: '/?screen=mail' });
    const [record] = await db.select().from(pushEvents).where(eq(pushEvents.refId, event.id));
    expect(record).toMatchObject({ outcome: 'sent', deliveryId: messages[0]!.eventId });
    expect((await sweepDueNotifications(db, null, at, { fcmTransport: send })).claimed).toBe(0);
  });

  it('native-only consent discovers lazy build and training in the existing batch', async () => {
    const p = await playerSession(); const due = new Date('2041-01-01');
    await subscription(p.wallet, new Date(due.getTime() - 1000));
    await db.insert(builderJobs).values({ playerWallet: p.wallet, kind: 'build', finishesAt: due });
    await db.insert(trainingQueue).values({ playerWallet: p.wallet, troop: 'highlander', finishesAt: due });
    const sent: NativePushPayload[] = [];
    const summary = await sweepDueNotifications(db, null, new Date(due.getTime() + NOTIFICATIONS.batchWindowMs), {
      fcmTransport: async (_target, payload) => { sent.push(payload); },
    });
    expect(summary).toMatchObject({ claimed: 2, sent: 1 });
    expect(sent).toEqual([expect.objectContaining({ kind: 'build', title: 'BUILD & TRAINING FINISHED', url: '/?screen=base' })]);
  });

  it('does not claim disabled-channel or pre-consent history and never retries ambiguous sends', async () => {
    const p = await playerSession(); const at = new Date('2042-01-01');
    const sub = await subscription(p.wallet, at);
    const old = await mail(p.wallet, new Date(at.getTime() - 1));
    const fresh = await mail(p.wallet, at);
    expect((await sweepDueNotifications(db, null, at)).claimed).toBe(0);
    expect((await sweepDueNotifications(db, async () => {}, at)).claimed).toBe(0);
    let attempts = 0;
    const transport = async () => { attempts++; throw new Error('response lost'); };
    expect((await sweepDueNotifications(db, null, at, { fcmTransport: transport })).failed).toBe(1);
    expect((await sweepDueNotifications(db, null, at, { fcmTransport: transport })).claimed).toBe(0);
    expect(attempts).toBe(1);
    expect(await db.select().from(pushEvents).where(eq(pushEvents.refId, old.id))).toHaveLength(0);
    expect((await db.select().from(pushEvents).where(eq(pushEvents.refId, fresh.id)))[0]?.outcome).toBe('failed');
    expect((await readToken(sub.token)).failures).toBe(1);
  });

  it('charges the existing hourly cap once per event across both channels', async () => {
    const p = await playerSession(); const at = new Date('2043-01-01');
    await subscription(p.wallet, new Date(at.getTime() - 1000));
    await db.insert(pushSubscriptions).values({ wallet: p.wallet, endpoint: webBody().endpoint, p256dh: 'key', auth: 'auth', enabledAt: new Date(at.getTime() - 1000) });
    for (let i = 0; i < NOTIFICATIONS.perWalletHourlyCap + 1; i++) await mail(p.wallet, at);
    let native = 0; let web = 0;
    const result = await sweepDueNotifications(db, async () => { web++; }, at, { fcmTransport: async () => { native++; } });
    expect(result).toMatchObject({ sent: NOTIFICATIONS.perWalletHourlyCap, capped: 1 });
    expect(native).toBe(NOTIFICATIONS.perWalletHourlyCap); expect(web).toBe(native);
  });
});

describe.sequential('native delivery snapshot fence', () => {
  const payload = { kind: 'mail', title: 'NEW MAIL', body: 'Read it', tag: 'mail', url: '/?screen=mail' } as const;
  const opts = { ttl: 3600, urgency: 'normal', topic: 'mail', timeout: 1000 } as const;
  it('rejects an already-retired target without calling the provider', async () => {
    const p = await playerSession(); const sub = await subscription(p.wallet, new Date());
    await db.update(nativePushSubscriptions).set({ disabledAt: new Date() }).where(eq(nativePushSubscriptions.id, sub.id));
    expect(await sendToNativeSubscription(db, async () => { throw new Error('must not send'); }, sub, nativePushPayload(sub, payload, randomUUID()), opts, new Date())).toBe('disabled');
  });

  for (const outcome of ['success', 'unregistered', 'failure'] as const) {
    it(`does not apply stale ${outcome} to a replacement binding`, async () => {
      const p = await playerSession(); const sub = await subscription(p.wallet, new Date('2020-01-01'));
      const replacement = randomUUID();
      const transport = async () => {
        await db.update(nativePushSubscriptions).set({ bindingId: replacement, enabledAt: new Date(), failures: 2 }).where(eq(nativePushSubscriptions.id, sub.id));
        if (outcome === 'unregistered') throw { code: 'messaging/registration-token-not-registered' };
        if (outcome === 'failure') throw new Error('unavailable');
      };
      await sendToNativeSubscription(db, transport, sub, nativePushPayload(sub, payload, randomUUID()), opts, new Date());
      expect(await readToken(sub.token)).toMatchObject({ bindingId: replacement, failures: 2, disabledAt: null, lastSuccessAt: null });
    });
  }

  it('retires proven invalid tokens immediately, counts other failures, and bounds an unresolved provider once', async () => {
    const p = await playerSession(); const invalid = await subscription(p.wallet, new Date());
    expect(await sendToNativeSubscription(db, async () => { throw { code: 'messaging/registration-token-not-registered' }; }, invalid,
      nativePushPayload(invalid, payload, randomUUID()), opts, new Date())).toBe('disabled');
    const pending = await subscription(p.wallet, new Date(), { failures: NOTIFICATIONS.disableAfterFailures - 1 });
    let attempts = 0;
    expect(await sendToNativeSubscription(db, async () => { attempts++; await new Promise(() => {}); }, pending,
      nativePushPayload(pending, payload, randomUUID()), { ...opts, timeout: 5 }, new Date())).toBe('disabled');
    expect(attempts).toBe(1);
    expect((await readToken(pending.token)).failures).toBe(NOTIFICATIONS.disableAfterFailures);
  });
});
