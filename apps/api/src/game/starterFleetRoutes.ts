/** Explicit free starter installation only; no provider or departure activation. */
import { TWOFA } from '@shardkeep/shared';
import { STARTER_FLEET_FEATURE, StarterFleetRequestSchema, StarterFleetUuidSchema,
  StarterFleetViewSchema } from '@shardkeep/shared/starterFleetApi';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { multiBaseEnabled, starterExpeditionsEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { getBaseState } from './base';
import { assertFreshLockedBaseAuthority, requireFreshBaseAuthority } from './baseOwnership';
import { assertStarterInstallationsEnabled, installStarterFleetCommand, matchStarterFleetCommand,
  readStarterFleetCommand, starterFleetEnvelope } from './starterFleetCommands';
import type { WorkshopRouteDeps } from './workshopRoutes';

export function registerStarterFleetRoutes(app: FastifyInstance, db: Db, deps: WorkshopRouteDeps = {}): void {
  const authenticated = { preHandler: [app.authenticate], onSend: async (_req: unknown,
    reply: { header: (key: string, value: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store'); return payload;
  } };
  const lockedAuthority = async (tx: DbTx, wallet: string, baseId: string): Promise<void> => {
    await assertFreshLockedBaseAuthority(tx, wallet, baseId);
  };
  const prefetch = async (wallet: string, baseId: string) => {
    if (!multiBaseEnabled()) throw new HttpError(409, 'Starter fleet requires an explicit stable base', 'BASE_ID_REQUIRED');
    await requireFreshBaseAuthority(db, wallet, baseId, deps.market?.finalizedDeedReader ?? null, deps.market?.deedCollection ?? null);
  };
  app.get('/starter-fleet', authenticated, async req => {
    const { baseId } = parse(z.object({ baseId: StarterFleetUuidSchema }).strict(), req.query ?? {});
    await prefetch(req.wallet, baseId);
    const state = await getBaseState(db, req.wallet, new Date(), baseId, lockedAuthority);
    if (!state.starterFleet) throw new Error('Authorized starter fleet missing');
    return StarterFleetViewSchema.parse({ wallet: req.wallet, baseId, features: { starterFleet: STARTER_FLEET_FEATURE },
      acceptingInstallations: starterExpeditionsEnabled(), ...state.starterFleet });
  });
  app.post('/starter-fleet/installations', { ...authenticated,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  }, async (req, reply) => {
    const request = parse(StarterFleetRequestSchema, req.body);
    const original = await readStarterFleetCommand(db, req.wallet, request.idempotencyKey, true);
    if (original) return starterFleetEnvelope(req.wallet, request.idempotencyKey, matchStarterFleetCommand(original, request));
    assertStarterInstallationsEnabled();
    await prefetch(req.wallet, request.baseId);
    const proof = await installStarterFleetCommand(db, req.wallet, request, { baseId: request.baseId, assertAuthority: lockedAuthority });
    return reply.status(201).send(starterFleetEnvelope(req.wallet, request.idempotencyKey, proof));
  });
  app.get('/starter-fleet/installations/by-key/:key', authenticated, async req => {
    const { key } = parse(z.object({ key: StarterFleetUuidSchema }).strict(), req.params);
    return starterFleetEnvelope(req.wallet, key, await readStarterFleetCommand(db, req.wallet, key));
  });
}
