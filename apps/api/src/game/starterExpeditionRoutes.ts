/** Authenticated transport; private composition supplies fitted admission. */
import { TWOFA } from '@shardkeep/shared';
import { PaidStarterExpeditionQuerySchema } from '@shardkeep/shared/paidStarterExpeditionApi';
import { StarterExpeditionRequestSchema, StarterExpeditionUuidSchema } from '@shardkeep/shared/starterExpeditionApi';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { parse } from '../lib/validation';
import { createUnfittedStarterExpeditionWorkflow, StarterExpeditionViewQuerySchema,
  type StarterExpeditionWorkflow, type StarterExpeditionWorkflowDeps } from './starterExpeditionWorkflow';
export type { StarterExpeditionProvider } from './starterExpeditionWorkflow';
export type { StarterExpeditionAccessProvider } from './paidStarterExpeditionView';
export type StarterExpeditionRouteDeps = StarterExpeditionWorkflowDeps;
export function registerStarterExpeditionRoutes(app: FastifyInstance, db: Db, deps: StarterExpeditionRouteDeps = {}, provider?: StarterExpeditionWorkflow | null): void {
  const workflow = provider ?? createUnfittedStarterExpeditionWorkflow(db, deps);
  const authenticated = { preHandler: [app.authenticate], onSend: async (_req: unknown,
    reply: { header: (key: string, value: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store'); return payload;
  } };
  app.get('/starter-expeditions/paid-route', { ...authenticated,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  }, req => workflow.paidView(req.wallet, parse(PaidStarterExpeditionQuerySchema, req.query ?? {})));
  app.get('/starter-expeditions', authenticated,
    req => workflow.view(req.wallet, parse(StarterExpeditionViewQuerySchema, req.query ?? {})));
  app.post('/starter-expeditions', { ...authenticated,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  }, async (req, reply) => {
    const result = await workflow.start(req.wallet, parse(StarterExpeditionRequestSchema, req.body));
    // Phase E transient presentation: older servers' 201 did not distinguish a locked replay.
    if (result.created) reply.header('x-pkw-journey-created', '1');
    return reply.status(result.created ? 201 : 200).send(result.envelope);
  });
  app.get('/starter-expeditions/by-key/:key', authenticated, req => {
    const { key } = parse(z.object({ key: StarterExpeditionUuidSchema }).strict(), req.params);
    return workflow.read(req.wallet, key);
  });
}
