import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SKR_FAUCET } from '@shardkeep/shared';
import { HttpError } from '../lib/errors';
import type { makeSkrFaucetService } from './skrFaucet';

const statusQuery = z.object({ baseId: z.string().uuid().optional() }).strict();
const claimBody = z.object({ baseId: z.string().uuid() }).strict();
const prepareBody = z.object({ grantId: z.string().uuid() }).strict();
const submitBody = z.object({ attemptId: z.string().uuid(), signedTransaction: z.string().max(1644).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const grantsQuery = z.object({ after: z.string().uuid().optional() }).strict();
const grantParams = z.object({ grantId: z.string().uuid() }).strict();
const empty = z.object({}).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input); if (!result.success) throw new HttpError(400, 'invalid faucet request', 'SKR_FAUCET_INVALID_REQUEST'); return result.data;
}
export function registerSkrFaucetRoutes(app: FastifyInstance, service: ReturnType<typeof makeSkrFaucetService>) {
  const mutation = { preHandler: app.authenticate, config: { rateLimit: { max: SKR_FAUCET.devnet.claimRateLimitPerMin, timeWindow: 60_000 } } };
  async function safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'SKR faucet temporarily unavailable', 'SKR_FAUCET_UNAVAILABLE');
    }
  }
  app.get('/devnet-skr-faucet/status', { preHandler: app.authenticate }, async (req) => {
    const query = parse(statusQuery, req.query); return safe(() => service.status(req.wallet, query.baseId));
  });
  // K-night-03: the native client's owned-grant reads (lost-claim discovery, prior-day and daily-limit ownership proof).
  app.get('/devnet-skr-faucet/grants', { preHandler: app.authenticate }, async (req) => {
    const query = parse(grantsQuery, req.query); return safe(() => service.listGrants(req.wallet, query.after));
  });
  app.get('/devnet-skr-faucet/grants/:grantId', { preHandler: app.authenticate }, async (req) => {
    parse(empty, req.query); const params = parse(grantParams, req.params); return safe(() => service.readGrant(req.wallet, params.grantId));
  });
  app.post('/devnet-skr-faucet/claim', mutation, async (req) => {
    parse(empty, req.query); const body = parse(claimBody, req.body); return safe(() => service.claim(req.wallet, body.baseId));
  });
  app.post('/devnet-skr-faucet/prepare', mutation, async (req) => {
    parse(empty, req.query); const body = parse(prepareBody, req.body); return safe(() => service.prepare(req.wallet, body.grantId));
  });
  app.post('/devnet-skr-faucet/submit', mutation, async (req) => {
    parse(empty, req.query); const body = parse(submitBody, req.body); return safe(() => service.submit(req.wallet, body.attemptId, body.signedTransaction));
  });
}
