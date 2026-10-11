import type {BoundCosmeticCollection} from './boundCosmeticCollection';
/** D153.29 ordinary raw/refined conversion. Auth precedes every gate; accepted
 * originals recover without flags, current custody, facilities or chain RPC. */
import { TWOFA } from '@shardkeep/shared';
import { currentOrdinaryCraftingRecipes, ORDINARY_CRAFTING_FEATURE, OrdinaryCraftingRequestSchema,
  OrdinaryCraftingUuidSchema, OrdinaryCraftingViewSchema, OrdinaryCraftingViewQuerySchema } from '@shardkeep/shared/ordinaryCraftingApi';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { multiBaseEnabled, ordinaryCraftingEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { getBaseState } from './base';
import { assertFreshLockedBaseAuthority, requireFreshBaseAuthority } from './baseOwnership';
import { assertOrdinaryCraftingStartsEnabled, matchOrdinaryCraftingCommand, readOrdinaryCrafting, startOrdinaryCrafting } from './ordinaryCrafting';
import { ordinaryCraftingEnvelope, readOrdinaryCraftingEnvelope } from './ordinaryCraftingView';
import type { WorkshopRouteDeps } from './workshopRoutes';

export function registerOrdinaryCraftingRoutes(app: FastifyInstance, db: Db, deps: WorkshopRouteDeps & {cosmeticCollection?:BoundCosmeticCollection|null} = {}): void {
  const noStore = async (_req: unknown, reply: { header: (key: string, value: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store'); return payload;
  };
  const authenticated = { preHandler: [app.authenticate], onSend: noStore };
  const lockedAuthority = async (tx: DbTx, wallet: string, baseId: string): Promise<void> => {
    await assertFreshLockedBaseAuthority(tx, wallet, baseId);
  };
  const authority = (baseId: string) => ({ baseId, assertAuthority: lockedAuthority });
  const prefetch = async (wallet: string, baseId: string) => {
    if (!multiBaseEnabled()) throw new HttpError(409, 'Ordinary crafting requires an explicit stable base', 'BASE_ID_REQUIRED');
    // Reuse the foreground reader owned by registerGameRoutes; no new RPC pool.
    await requireFreshBaseAuthority(db, wallet, baseId, deps.market?.finalizedDeedReader ?? null, deps.market?.deedCollection ?? null);
  };
  app.get('/ordinary-crafting', authenticated, async req => {
    const { baseId, catalogueVersion } = parse(OrdinaryCraftingViewQuerySchema, req.query ?? {});
    const catalogue = catalogueVersion === '2' ? 2 : 1;
    await prefetch(req.wallet, baseId);
    const state = await getBaseState(db, req.wallet, new Date(), baseId, lockedAuthority, () => new Date(), catalogue,
      deps.cosmeticCollection ? () => deps.cosmeticCollection!.collectForBaseRead(req.wallet, baseId) : undefined);
    if (!state.rawStock || !state.craftingStock || !state.ordinaryCrafting) throw new Error('Authorized ordinary inventory missing');
    return OrdinaryCraftingViewSchema.parse({ wallet: req.wallet, baseId,
      features: { ordinaryCrafting: ORDINARY_CRAFTING_FEATURE }, acceptingJobs: ordinaryCraftingEnabled(),
      ...(catalogue === 2 ? { catalogueVersion: 2, shardsAvailable: state.craftingShardsAvailable } : {}),
      ...currentOrdinaryCraftingRecipes(catalogue), rawStock: state.rawStock, craftingStock: state.craftingStock,
      ...state.ordinaryCrafting });
  });
  app.post('/ordinary-crafting/jobs', { ...authenticated,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  }, async (req, reply) => {
    const body = parse(OrdinaryCraftingRequestSchema, req.body);
    const command = { id: body.idempotencyKey, baseId: body.baseId, recipeId: body.recipeId,
      recipeVersion: body.recipeVersion, quantity: body.quantity };
    const original = await readOrdinaryCrafting(db, command.id);
    if (original) {
      matchOrdinaryCraftingCommand(original, req.wallet, command);
      return ordinaryCraftingEnvelope(req.wallet, command.id, original);
    }
    assertOrdinaryCraftingStartsEnabled();
    await prefetch(req.wallet, command.baseId);
    await deps.cosmeticCollection?.collectForBaseRead(req.wallet, command.baseId);
    const proof = await startOrdinaryCrafting(db, req.wallet, command, authority(command.baseId));
    return reply.status(201).send(ordinaryCraftingEnvelope(req.wallet, command.id, proof));
  });
  app.get('/ordinary-crafting/jobs/by-key/:key', authenticated, async req => {
    const { key } = parse(z.object({ key: OrdinaryCraftingUuidSchema }).strict(), req.params);
    return readOrdinaryCraftingEnvelope(db, req.wallet, key);
  });
}
