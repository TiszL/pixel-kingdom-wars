/**
 * Public release feed (M47 §5). Two uncredentialed READS consumed server-to-server
 * by the pixelkingdomwars.com Functions (/changelog, /changelog.xml, /download):
 *   GET /public/releases?limit=N   recorded releases, newest first (1..50, default 20)
 *   GET /public/android            the stable Android channel rows, newest first
 *
 * Deliberately NOT in LANDING_READ_PATHS: the Functions fetch from Cloudflare's
 * edge, so no browser origin needs CORS, and keeping the landing CORS allowlist
 * unchanged keeps its test pinned. Nothing here writes: release rows come only
 * from the deploy-time CLI (releases/cli.ts), channel rows only from the operator
 * CLI (native/updateChannelCli.ts). Tester channel rows never leave the database
 * through this file (the query filters them in SQL).
 */
import type { FastifyInstance } from 'fastify';
import { RELEASE_FEED } from '@shardkeep/shared';
import type { Config } from './config';
import type { Db } from './db/client';
import { HttpError } from './lib/errors';
import {
  PublicAndroidResponseSchema, PublicReleasesResponseSchema, ReleasesQuerySchema,
} from './releases/contracts';
import { listPublicReleases, listStableAndroidReleases } from './releases/reader';
import { BUILD } from './version';

export const RELEASE_PUBLIC_PATHS = ['/public/releases', '/public/android'] as const;

/** A malformed BUILD_TIME stamp must degrade to null, never 500 the public page. */
function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function registerReleaseRoutes(app: FastifyInstance, config: Pick<Config, 'NATIVE_MIN_VERSION_CODE'>, db: Db): void {
  // Same per-IP budget as the other public board read (/playtest/stats).
  const publicLimit = { config: { rateLimit: { max: RELEASE_FEED.rateLimitPerMinute, timeWindow: 60_000 } } };
  const cacheControl = `public, max-age=${RELEASE_FEED.publicCacheSec}`;

  app.get('/public/releases', publicLimit, async (req, reply) => {
    const query = ReleasesQuerySchema.safeParse(req.query ?? {});
    if (!query.success) throw new HttpError(400, `limit must be an integer from 1 to ${RELEASE_FEED.maxLimit}`);
    const releases = await listPublicReleases(db, query.data.limit, (details, message) => req.log.error(details, message));
    const body = PublicReleasesResponseSchema.parse({
      releases,
      // The running build: correct even after a manual image rollback that
      // bypassed deploy.sh and therefore recorded no row.
      live: { gitSha: BUILD.gitSha, version: BUILD.version, builtAt: isoOrNull(BUILD.builtAt) },
      generatedAt: new Date().toISOString(),
    });
    reply.header('cache-control', cacheControl);
    return body;
  });

  app.get('/public/android', publicLimit, async (req, reply) => {
    const history = await listStableAndroidReleases(db, (details, message) => req.log.error(details, message));
    const body = PublicAndroidResponseSchema.parse({
      stable: history[0] ?? null,
      history,
      minimumVersionCode: config.NATIVE_MIN_VERSION_CODE ?? 0,
      generatedAt: new Date().toISOString(),
    });
    reply.header('cache-control', cacheControl);
    return body;
  });
}
