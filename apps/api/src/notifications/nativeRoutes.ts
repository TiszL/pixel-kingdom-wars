/** D-134 native consent. Tokens are opaque delivery capabilities, never identity. */
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { nativePushRevocations, nativePushSubscriptions, players, sessions } from '../db/schema';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { enforceSubscriptionCap } from './subscriptions';

const Token = z.string().min(1).max(2048).regex(/^[!-~]+$/);
const Subscribe = z.object({
  token: Token,
  previousToken: Token.optional(),
  bindingId: z.uuid(),
  packageName: z.enum(['gg.pixelkingdomwars.twa', 'gg.pixelkingdomwars.twa.debug']),
}).strict();
const Unsubscribe = z.object({ token: Token, bindingId: z.uuid() }).strict();

export function registerNativeNotificationRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const player = { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: 60_000 } } };
  app.get('/native/notifications/v1', player, async (_req, reply) => {
    reply.header('cache-control', 'no-store, private');
    return { version: 1, enabled: config.FCM_NOTIFICATIONS_ENABLED === 'true' };
  });
  app.post('/native/notifications/v1/subscribe', player, async (req, reply) => {
    reply.header('cache-control', 'no-store, private');
    if (config.FCM_NOTIFICATIONS_ENABLED !== 'true') {
      throw new HttpError(503, 'native notifications are not enabled', 'FCM_DISABLED');
    }
    const body = parse(Subscribe, req.body ?? {});
    await db.transaction(async (tx) => {
      const [owner] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, req.wallet)).for('update');
      if (!owner) throw new HttpError(401, 'invalid or expired session');
      // Logout takes the same wallet root before revoking sessions/consent.
      // Recheck after it so an already-authenticated delayed POST cannot revive it.
      const [session] = await tx.select({ id: sessions.id }).from(sessions).where(and(
        eq(sessions.id, req.sessionId), eq(sessions.wallet, req.wallet), isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ));
      if (!session) throw new HttpError(401, 'invalid or expired session');
      const [revoked] = await tx.select({ bindingId: nativePushRevocations.bindingId }).from(nativePushRevocations)
        .where(and(eq(nativePushRevocations.wallet, req.wallet), eq(nativePushRevocations.bindingId, body.bindingId)));
      if (revoked) throw new HttpError(409, 'notification consent was revoked; enable with a new binding', 'FCM_BINDING_REVOKED');
      const now = new Date();
      const binding = await tx.select({ enabledAt: nativePushSubscriptions.enabledAt }).from(nativePushSubscriptions)
        .where(and(
          eq(nativePushSubscriptions.wallet, req.wallet), eq(nativePushSubscriptions.bindingId, body.bindingId),
          eq(nativePushSubscriptions.packageName, body.packageName), isNull(nativePushSubscriptions.disabledAt),
        )).for('update');
      // SDK token rotation within the same live installation is continuous
      // consent. A lost intermediate POST must not hide the original token.
      const enabledAt = binding.length ? new Date(Math.min(...binding.map((row) => row.enabledAt.getTime()))) : now;
      const [inserted] = await tx.insert(nativePushSubscriptions).values({
        wallet: req.wallet, token: body.token, bindingId: body.bindingId,
        packageName: body.packageName, createdAt: now, enabledAt,
      }).onConflictDoNothing({ target: nativePushSubscriptions.token })
        .returning({ id: nativePushSubscriptions.id });
      let id = inserted?.id;
      if (!id) {
        const [existing] = await tx.select().from(nativePushSubscriptions)
          .where(eq(nativePushSubscriptions.token, body.token)).for('update');
        if (!existing || existing.wallet !== req.wallet) {
          throw new HttpError(409, 'notification token belongs to another wallet', 'FCM_TOKEN_OWNED');
        }
        id = existing.id;
        await tx.update(nativePushSubscriptions).set({
          bindingId: body.bindingId, packageName: body.packageName, failures: 0, disabledAt: null,
          enabledAt: existing.disabledAt || existing.bindingId !== body.bindingId
            || existing.packageName !== body.packageName ? now : existing.enabledAt,
        }).where(eq(nativePushSubscriptions.id, id));
      }
      if (body.previousToken && body.previousToken !== body.token) {
        await tx.update(nativePushSubscriptions).set({ disabledAt: now }).where(and(
          eq(nativePushSubscriptions.wallet, req.wallet),
          eq(nativePushSubscriptions.token, body.previousToken), isNull(nativePushSubscriptions.disabledAt),
        ));
      }
      await tx.update(nativePushSubscriptions).set({ disabledAt: now }).where(and(
        eq(nativePushSubscriptions.wallet, req.wallet), eq(nativePushSubscriptions.bindingId, body.bindingId),
        eq(nativePushSubscriptions.packageName, body.packageName), ne(nativePushSubscriptions.token, body.token),
        isNull(nativePushSubscriptions.disabledAt),
      ));
      await enforceSubscriptionCap(tx, req.wallet, { channel: 'native', id }, now);
    });
    return { ok: true };
  });
  app.delete('/native/notifications/v1/subscribe', player, async (req, reply) => {
    reply.header('cache-control', 'no-store, private');
    const body = parse(Unsubscribe, req.body ?? {});
    // Cleanup stays available while paused and before the first POST lands.
    // A consent UUID is installation-scoped; retire SDK-rotated tokens too,
    // without touching any replacement binding on the supplied token.
    await db.transaction(async (tx) => {
      await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, req.wallet)).for('update');
      const now = new Date();
      await tx.insert(nativePushRevocations).values({ wallet: req.wallet, bindingId: body.bindingId, revokedAt: now }).onConflictDoNothing();
      await tx.update(nativePushSubscriptions).set({ disabledAt: now }).where(and(
        eq(nativePushSubscriptions.wallet, req.wallet), eq(nativePushSubscriptions.bindingId, body.bindingId),
        isNull(nativePushSubscriptions.disabledAt),
      ));
    });
    return reply.status(204).send();
  });
}
