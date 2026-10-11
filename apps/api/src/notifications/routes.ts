/**
 * M33 Web Push subscription routes (D-101). Cookie-authenticated like
 * /mail/status; the wallet on the session owns every row it touches.
 *
 *   GET    /notifications/vapid       { publicKey } — null while push is OFF
 *   POST   /notifications/subscribe   upsert by endpoint, retire previousEndpoint,
 *                                     evict the oldest beyond subscriptionMaxPerWallet
 *   DELETE /notifications/subscribe   retire one endpoint
 *
 * Subscribe is called on EVERY boot (UPDATE NOW unregisters the service worker,
 * which destroys the browser's PushSubscription), so it must be idempotent and
 * cheap. Rows are retired (disabled_at), never deleted, so a stale endpoint the
 * push service later reports as 410 stays recognisable.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { players, pushSubscriptions } from '../db/schema';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { enforceSubscriptionCap } from './subscriptions';

const trustedPushHost = (host: string): boolean => host === 'fcm.googleapis.com'
  || host === 'push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com')
  || host === 'updates.push.services.mozaws.net'
  || host === 'push.apple.com' || host.endsWith('.push.apple.com')
  || host === 'notify.windows.com' || host.endsWith('.notify.windows.com');

/** Push endpoints are outbound request capabilities. Keep the allowlist to
 * browser push providers, not arbitrary authenticated user-supplied hosts. */
const Endpoint = z.string().max(2048).transform((raw, ctx) => {
  let url: URL;
  try { url = new URL(raw); } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid push endpoint' });
    return z.NEVER;
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || (url.port && url.port !== '443')
      || !trustedPushHost(host)) {
    ctx.addIssue({ code: 'custom', message: 'untrusted push endpoint' });
    return z.NEVER;
  }
  url.hostname = host;
  url.port = '';
  return url.toString();
});

const canonicalKey = (bytes: number, uncompressedPoint = false) => z.string().max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'key must be unpadded base64url')
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === bytes && decoded.toString('base64url') === value
      && (!uncompressedPoint || decoded[0] === 0x04);
  }, `key must decode to ${bytes} bytes${uncompressedPoint ? ' and begin with 0x04' : ''}`);
const SubscribeBody = z.object({
  endpoint: Endpoint,
  keys: z.object({ p256dh: canonicalKey(65, true), auth: canonicalKey(16) }),
  previousEndpoint: Endpoint.optional(),
  userAgent: z.string().max(256).optional(),
});
const UnsubscribeBody = z.object({ endpoint: Endpoint });

export function registerNotificationRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const enabled = config.PUSH_NOTIFICATIONS_ENABLED === 'true';
  const player = {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  };
  const noStore = (reply: { header: (name: string, value: string) => unknown }): void => {
    reply.header('cache-control', 'no-store, private');
  };
  const requireEnabled = (): void => {
    if (!enabled) throw new HttpError(503, 'push notifications are not enabled', 'PUSH_DISABLED');
  };

  app.get('/notifications/vapid', player, async (_req, reply) => {
    noStore(reply);
    return { publicKey: enabled ? config.VAPID_PUBLIC_KEY ?? null : null };
  });

  app.post('/notifications/subscribe', player, async (req, reply) => {
    noStore(reply);
    requireEnabled();
    const body = parse(SubscribeBody, req.body ?? {});
    const wallet = req.wallet;
    const now = new Date();
    await db.transaction(async (tx) => {
      // Serialize the cap decision for this wallet. Without a row lock, six
      // simultaneous boot-syncs can all observe four live rows, all insert,
      // and leave ten subscriptions despite the five-device contract.
      const [owner] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).limit(1).for('update');
      if (!owner) throw new HttpError(401, 'invalid or expired session');
      const inserted = await tx.insert(pushSubscriptions)
        .values({
          wallet,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent: body.userAgent ?? null,
          createdAt: now,
          enabledAt: now,
        })
        .onConflictDoNothing({ target: pushSubscriptions.endpoint })
        .returning({ id: pushSubscriptions.id });
      let id = inserted[0]?.id;
      if (!id) {
        const [existing] = await tx.select().from(pushSubscriptions)
          .where(eq(pushSubscriptions.endpoint, body.endpoint)).limit(1).for('update');
        if (!existing || existing.wallet !== wallet) {
          throw new HttpError(409, 'push endpoint belongs to another wallet', 'PUSH_ENDPOINT_OWNED');
        }
        id = existing.id;
        await tx.update(pushSubscriptions).set({
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent: body.userAgent ?? null,
          failures: 0,
          disabledAt: null,
          // Re-enabling is new consent; an ordinary live boot sync is not.
          enabledAt: existing.disabledAt ? now : existing.enabledAt,
        }).where(and(eq(pushSubscriptions.id, existing.id), eq(pushSubscriptions.wallet, wallet)));
      }
      if (body.previousEndpoint && body.previousEndpoint !== body.endpoint) {
        await tx.update(pushSubscriptions)
          .set({ disabledAt: now })
          .where(and(
            eq(pushSubscriptions.endpoint, body.previousEndpoint),
            eq(pushSubscriptions.wallet, wallet),
            isNull(pushSubscriptions.disabledAt),
          ));
      }
      await enforceSubscriptionCap(tx, wallet, { channel: 'web', id }, now);
    });
    return reply.status(204).send();
  });

  app.delete('/notifications/subscribe', player, async (req, reply) => {
    noStore(reply);
    requireEnabled();
    const body = parse(UnsubscribeBody, req.body ?? {});
    await db.update(pushSubscriptions)
      .set({ disabledAt: new Date() })
      .where(and(
        eq(pushSubscriptions.endpoint, body.endpoint),
        eq(pushSubscriptions.wallet, req.wallet),
        isNull(pushSubscriptions.disabledAt),
      ));
    return reply.status(204).send();
  });
}
