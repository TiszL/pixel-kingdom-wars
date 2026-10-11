/** Explicit prospective physical Mine admission. Original history needs neither
 * today's provider nor current custody; new admissions recheck locked authority. */
import { TWOFA } from '@shardkeep/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { multiBaseEnabled, phaseEMiningEnabled } from '../config';
import type { Db } from '../db/client';
import { assertFreshLockedBaseAuthority, requireFreshBaseAuthority } from '../game/baseOwnership';
import { prefetchOperatingExpeditionTermReader } from '../game/operatingExpeditionTermReader';
import type { StarterExpeditionProvider } from '../game/starterExpeditionRoutes';
import type { WorkshopRouteDeps } from '../game/workshopRoutes';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { admitPhysicalMineTaxSources, readPhysicalMineTaxSource } from './shardsTaxMineSources';

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const request = z.object({ idempotencyKey: uuid, baseId: uuid }).strict();
const params = z.object({ key: uuid }).strict(), empty = z.object({}).strict();
interface MineSourceRouteDeps extends WorkshopRouteDeps { provider?: StarterExpeditionProvider | null }
function unavailable(error: unknown): never {
  if (error instanceof HttpError) throw error;
  throw new HttpError(503, 'Physical Mine source is unavailable; keep the original request', 'SHARDS_SOURCE_UNAVAILABLE');
}

export function registerShardsTaxMineRoutes(app: FastifyInstance, db: Db, deps: MineSourceRouteDeps = {}): void {
  const auth = { preHandler: [app.authenticate], onSend: async (_request: unknown,
    reply: { header: (name: string, value: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store'); return payload;
  } };
  app.get('/mining/shards/sources/by-key/:key', auth, async req => {
    const { key } = parse(params, req.params); parse(empty, req.query);
    try { return { wallet: req.wallet, source: await readPhysicalMineTaxSource(db, req.wallet, key) }; }
    catch (error) { unavailable(error); }
  });
  app.post('/mining/shards/sources', { ...auth, bodyLimit: 4096,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  }, async (req, reply) => {
    const body = parse(request, req.body); parse(empty, req.query);
    try {
      const prior = await readPhysicalMineTaxSource(db, req.wallet, body.idempotencyKey);
      if (prior) {
        if (prior.baseId !== body.baseId) throw new HttpError(409, 'Original Mine source request differs', 'SHARDS_SOURCE_CONFLICT');
        return { wallet: req.wallet, source: prior };
      }
      if (!phaseEMiningEnabled()) throw new HttpError(503, 'Mining source admission is paused', 'PHASE_E_DISABLED');
      if (!multiBaseEnabled()) throw new HttpError(409, 'Physical Mine admission requires a stable base', 'BASE_ID_REQUIRED');
      if (!deps.provider) throw new HttpError(503, 'Finalized term provider is unavailable', 'SHARDS_SOURCE_UNAVAILABLE');
      await requireFreshBaseAuthority(db, req.wallet, body.baseId, deps.market?.finalizedDeedReader ?? null, deps.market?.deedCollection ?? null);
      // Genuine network reads finish before the service takes player/base locks.
      const reader = await prefetchOperatingExpeditionTermReader(deps.provider.connect, deps.provider.policy);
      const source = await admitPhysicalMineTaxSources(db, req.wallet, body, { baseId: body.baseId,
        assertAuthority: async (tx, wallet, baseId) => { await assertFreshLockedBaseAuthority(tx, wallet, baseId); },
      }, { reader });
      return reply.code(201).send({ wallet: req.wallet, source });
    } catch (error) { unavailable(error); }
  });
}
