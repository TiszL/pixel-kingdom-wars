import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import type { Db } from './db/client';
import type { Config } from './config';
import { parse } from './lib/validation';
import { HttpError } from './lib/errors';
import { administerCampaign, campaignState, adminCampaignState, exportCampaign, finalizePlaytestCampaign, ensurePlaytestCampaigns, participateInCampaign, submitCampaignEntry } from './game/playtestCampaigns';

export const CAMPAIGN_PUBLIC_PATHS = ['/playtest/campaigns'] as const;
const Id = z.object({ id: z.enum([RULES.foundingId, RULES.rewardedId]) });
const Wallet = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const RequestId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const Receipt = { requestId: RequestId, revision: z.number().int().positive() };
const Reason = z.string().trim().min(1).max(2000);
const Score = z.number().int().min(0).max(100);
const commands = {
  schedule: z.object({ ...Receipt, startAt: z.string().datetime(), registrationOpen: z.boolean() }).strict(),
  cancel: z.object({ ...Receipt, reason: Reason }).strict(),
  disqualify: z.object({ ...Receipt, wallet: Wallet, reason: Reason }).strict(),
  award: z.object({ ...Receipt, prizeId: z.string(), wallet: Wallet, submissionId: z.string(), reason: Reason,
    scores: z.object({ feedback: Score, evidence: Score, clarity: Score, coverage: Score }).strict().optional() }).strict(),
  payment: z.object({ ...Receipt, prizeId: z.string(), wallet: Wallet, reference: Reason }).strict(),
};
const Submission = z.discriminatedUnion('kind', [
  z.object({ requestId: RequestId, kind: z.literal('report'), reportId: z.string().uuid() }).strict(),
  z.object({ requestId: RequestId, kind: z.literal('video'), url: z.string().url().max(2000) }).strict(),
]);

export function registerPlaytestCampaignRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const internal = [...new Set([...(config.ALPHA_WALLETS ?? []), ...(config.ADMIN_WALLETS ?? [])])];
  const limit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };
  const privateHeaders = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Cookie, Authorization');
  };
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.ADMIN_WALLETS) throw new HttpError(404, 'not found');
    await app.authenticate(req, reply);
    if (!config.ADMIN_WALLETS.includes(req.wallet)) throw new HttpError(403, 'admin access required');
  };
  app.get('/playtest/campaigns', limit, async (_req, reply) => {
    await ensurePlaytestCampaigns(db);
    reply.header('Cache-Control', 'public, max-age=30');
    return { campaigns: await Promise.all([RULES.foundingId, RULES.rewardedId].map(id => campaignState(db, id, undefined, new Date(), false, internal))) };
  });
  app.get('/playtest/campaigns/:id/me', { ...limit, preHandler: app.authenticate, onRequest: privateHeaders }, async req =>
    campaignState(db, parse(Id, req.params).id, req.wallet, new Date(), false, internal));
  app.post('/playtest/campaigns/:id/participate', { ...limit, preHandler: app.authenticate, onRequest: privateHeaders }, async req =>
    participateInCampaign(db, parse(Id, req.params).id, req.wallet, undefined, internal));
  app.post('/playtest/campaigns/:id/submissions', { ...limit, preHandler: app.authenticate, onRequest: privateHeaders }, async req =>
    submitCampaignEntry(db, parse(Id, req.params).id, req.wallet, parse(Submission, req.body), undefined, internal));
  app.get('/admin/playtest/campaigns', { ...limit, preHandler: requireAdmin, onRequest: privateHeaders }, async () => {
    await ensurePlaytestCampaigns(db);
    return { campaigns: await Promise.all([RULES.foundingId, RULES.rewardedId].map(id => adminCampaignState(db, id, new Date(), internal))) };
  });
  app.get('/admin/playtest/campaigns/:id/export', { ...limit, preHandler: requireAdmin, onRequest: privateHeaders }, async req => exportCampaign(db, parse(Id, req.params).id, internal));
  app.post('/admin/playtest/campaigns/:id/finalize', { ...limit, preHandler: requireAdmin, onRequest: privateHeaders }, async req => {
    const receipt = parse(z.object(Receipt).strict(), req.body);
    return finalizePlaytestCampaign(db, parse(Id, req.params).id, req.wallet, receipt, internal);
  });
  for (const action of ['schedule', 'cancel', 'disqualify', 'award', 'payment'] as const) {
    app.post(`/admin/playtest/campaigns/:id/${action}`, { ...limit, preHandler: requireAdmin, onRequest: privateHeaders }, async req => {
      const id = parse(Id, req.params).id;
      // The server-owned route chooses the action; body validation cannot override it.
      if (action === 'schedule') { const { requestId, revision, ...body } = parse(commands.schedule, req.body); return administerCampaign(db, id, req.wallet, { requestId, revision }, { action, ...body }, undefined, internal); }
      if (action === 'cancel') { const { requestId, revision, ...body } = parse(commands.cancel, req.body); return administerCampaign(db, id, req.wallet, { requestId, revision }, { action, ...body }, undefined, internal); }
      if (action === 'disqualify') { const { requestId, revision, ...body } = parse(commands.disqualify, req.body); return administerCampaign(db, id, req.wallet, { requestId, revision }, { action, ...body }, undefined, internal); }
      if (action === 'award') { const { requestId, revision, ...body } = parse(commands.award, req.body); return administerCampaign(db, id, req.wallet, { requestId, revision }, { action, ...body }, undefined, internal); }
      const { requestId, revision, ...body } = parse(commands.payment, req.body); return administerCampaign(db, id, req.wallet, { requestId, revision }, { action: 'payment', ...body }, undefined, internal);
    });
  }
}
