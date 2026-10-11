/** D153.33 explicit unpaid source selection. Provider injection stays dark. */
import { TWOFA } from '@shardkeep/shared';
import { HARVESTER_FEATURE, HarvesterSourceRequestSchema, HarvesterUuidSchema, HarvesterViewSchema } from '@shardkeep/shared/harvesterApi';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { harvestersEnabled, multiBaseEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { getBaseState } from './base';
import { assertFreshLockedBaseAuthority, requireFreshBaseAuthority } from './baseOwnership';
import { prefetchOperatingExpeditionTermReader } from './operatingExpeditionTermReader';
import { assertHarvesterSelectionsEnabled, harvesterSourceEnvelope, matchHarvesterSourceCommand,
  readHarvesterSourceCommand, selectHarvesterSourceCommand } from './harvesterCommands';
import { HarvesterStorageCapacityError } from './harvesterSettlement';
import type { StarterExpeditionProvider } from './starterExpeditionRoutes';
import type { WorkshopRouteDeps } from './workshopRoutes';

export interface HarvesterRouteDeps extends WorkshopRouteDeps { provider?: StarterExpeditionProvider | null }
function pendingSettlement(error: unknown): never {
  if (error instanceof HarvesterStorageCapacityError)
    throw new HttpError(409, 'Accepted Harvester earning is pending storage capacity', 'HARVESTER_SETTLEMENT_PENDING');
  throw error;
}
export function registerHarvesterRoutes(app: FastifyInstance, db: Db, deps: HarvesterRouteDeps = {}): void {
  const authenticated = { preHandler: [app.authenticate], onSend: async (_req: unknown,
    reply: { header: (key: string, value: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store'); return payload;
  } };
  const lockedAuthority = async (tx: DbTx, wallet: string, baseId: string) => {
    await assertFreshLockedBaseAuthority(tx, wallet, baseId);
  };
  const authority = async (wallet: string, baseId: string) => {
    if (!multiBaseEnabled()) throw new HttpError(409, 'Harvester selections require an explicit stable base', 'BASE_ID_REQUIRED');
    await requireFreshBaseAuthority(db, wallet, baseId, deps.market?.finalizedDeedReader ?? null, deps.market?.deedCollection ?? null);
  };
  app.get('/harvesters', authenticated, async req => {
    const { baseId } = parse(z.object({ baseId: HarvesterUuidSchema }).strict(), req.query ?? {});
    await authority(req.wallet, baseId);
    try {
      const state = await getBaseState(db, req.wallet, new Date(), baseId, lockedAuthority);
      if (!state.harvesters || !state.rawStock) throw new Error('Authorized Harvester snapshot missing');
      return HarvesterViewSchema.parse({ wallet: req.wallet, baseId, features: { harvesters: HARVESTER_FEATURE },
        acceptingSelections: harvestersEnabled() && !!deps.provider, ...state.harvesters, rawStock: state.rawStock });
    } catch (error) { return pendingSettlement(error); }
  });
  app.post('/harvesters/sources', { ...authenticated,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  }, async (req, reply) => {
    const request = parse(HarvesterSourceRequestSchema, req.body);
    const original = await readHarvesterSourceCommand(db, req.wallet, request.idempotencyKey, true);
    if (original) {
      matchHarvesterSourceCommand(original, request);
      return harvesterSourceEnvelope(db, req.wallet, request.idempotencyKey);
    }
    assertHarvesterSelectionsEnabled();
    if (!deps.provider) throw new HttpError(503, 'Genuine Harvester term provider unavailable', 'EXPEDITION_TERM_UNAVAILABLE');
    await authority(req.wallet, request.baseId);
    const reader = await prefetchOperatingExpeditionTermReader(deps.provider.connect, deps.provider.policy);
    try {
      await selectHarvesterSourceCommand(db, req.wallet, request, { baseId: request.baseId, assertAuthority: lockedAuthority }, { reader });
    } catch (error) { return pendingSettlement(error); }
    return reply.status(201).send(await harvesterSourceEnvelope(db, req.wallet, request.idempotencyKey));
  });
  app.get('/harvesters/sources/by-key/:key', authenticated, async req => {
    const { key } = parse(z.object({ key: HarvesterUuidSchema }).strict(), req.params);
    return harvesterSourceEnvelope(db, req.wallet, key);
  });
}
