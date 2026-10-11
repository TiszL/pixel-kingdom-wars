/**
 * Public playtest statistics route (D-103, M35 lane B).
 *
 * Uncredentialed READ consumed by pixelkingdomwars.com/leaderboard, opened to
 * the landing origin through the CORS delegate in app.ts exactly like the two
 * tester GETs (credentials:false, GET/HEAD only):
 *   GET /playtest/stats   latest worker snapshot (503 `no_snapshot` before the first)
 *
 * The route never computes: `computePlaytestStats` walks every large table,
 * so the worker snapshots it (jobs.ts) and this handler reads one row.
 */
import type { FastifyInstance } from 'fastify';
import { PLAYTEST_STATS } from '@shardkeep/shared';
import type { Db } from './db/client';
import { latestPlaytestStats } from './game/playtestStats';

export const PLAYTEST_PUBLIC_PATHS = ['/playtest/stats'] as const;

export function registerStatsRoutes(app: FastifyInstance, db: Db): void {
  const publicLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };

  app.get('/playtest/stats', publicLimit, async (_req, reply) => {
    const stats = await latestPlaytestStats(db);
    if (!stats) {
      // Not cacheable: the first snapshot lands within minutes of a worker boot
      // and a cached 503 would outlive it.
      reply.header('cache-control', 'no-store');
      return reply.status(503).send({ error: 'no_snapshot' });
    }
    reply.header('cache-control', `public, max-age=${PLAYTEST_STATS.publicCacheSec}`);
    return { ...stats, stale: Date.now() - Date.parse(stats.computedAt) > PLAYTEST_STATS.freshnessThresholdMs,
      freshness: { targetMs: PLAYTEST_STATS.freshnessThresholdMs, computedAt: stats.computedAt },
      definitions: { dau: 'Distinct eligible wallets with authoritative activity today UTC', wau: 'Distinct eligible wallets today and the previous six UTC dates', retention: 'Activity exactly N days after first qualifying play; completed target UTC days only' } };
  });
}
