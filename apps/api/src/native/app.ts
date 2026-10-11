import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Redis, { ReplyError } from 'ioredis';
import { sql } from 'drizzle-orm';
import type { NativeServiceConfig } from '../config';
import type { Db } from '../db/client';
import { makeAuthenticate } from '../auth/session';
import { HttpError } from '../lib/errors';
import { BUILD } from '../version';
import { registerNativeRoutes } from './routes';

/** A separate HTTP surface, never a second economy API or scheduler.
 * Canonical observation retains participant locks, but leaves automatic clock
 * starts to the existing web/worker. FOR UPDATE still requires SQL privileges;
 * do not describe this as a SELECT-only database role. */
export async function buildNativePresentationApp(config: NativeServiceConfig, db: Db): Promise<FastifyInstance> {
  if (config.NATIVE_PRESENTATION_SERVICE !== 'true' ||
    (config.NATIVE_PRESENTATION_ENABLED === 'true' && !config.NATIVE_PRESENTATION_WALLETS?.length)) {
    throw new Error('Native companion requires its service role and explicit tester list');
  }
  const app = Fastify({ logger: config.NODE_ENV !== 'test', trustProxy: 1 });
  let limiter: Redis | undefined;
  try {
    await app.register(cookie);
    if (config.NODE_ENV !== 'test') {
      const redis = new Redis(config.REDIS_URL, { connectTimeout: 500, commandTimeout: 500, maxRetriesPerRequest: 1,
        enableOfflineQueue: false, lazyConnect: true });
      limiter = redis;
      redis.on('error', () => app.log.warn('native rate-limit redis unavailable'));
      app.addHook('onClose', async () => { await redis.quit().catch(() => redis.disconnect()); });
      await redis.connect();
      await app.register(rateLimit, { global: true, max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS,
        redis, nameSpace: 'pkw-native-rl:', skipOnError: false });
    }
    app.decorateRequest('wallet', '');
    app.decorateRequest('sessionId', '');
    app.decorate('authenticate', makeAuthenticate(config, db));
    app.setErrorHandler((error, req, reply) => {
      if (error instanceof HttpError) return reply.status(error.statusCode)
        .send({ error: { ...error.details, message: error.message, code: error.code } });
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return reply.status(status).send({ error: { message: (error as Error).message } });
      }
      if (limiter && (limiter.status !== 'ready' || error instanceof ReplyError ||
        (error instanceof Error && (error.name === 'MaxRetriesPerRequestError' || error.message === 'Command timed out')))) {
        return reply.header('Retry-After', '1').status(503).send({ error: {
          code: 'NATIVE_LIMITER_UNAVAILABLE', message: 'native presentation is temporarily unavailable',
        } });
      }
      req.log.error({ name: error instanceof Error ? error.name : 'UnknownError' }, 'native presentation failed');
      return reply.status(500).send({ error: { message: 'Internal Server Error' } });
    });
    app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      await db.execute(sql`select 1`);
      return { ok: true, service: 'native-presentation', ...BUILD };
    });
    registerNativeRoutes(app, config, db);
    await app.ready();
    return app;
  } catch (error) { await app.close().catch(() => undefined); throw error; }
}
