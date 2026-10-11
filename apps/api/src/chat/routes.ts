import { CHAT } from '@shardkeep/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import {
  CHAT_REPORT_REASONS, assertGlobalChatEnabled, getChatEvents, getChatMessages, getChatStatus,
  blockChatMessageAuthor, getChatMessageAuthorCard, listChatBlocks, listChatReports, muteChatAccount,
  redactChatMessage, reportChatMessage, resolveChatReport, sendChatMessage,
  setGlobalChatEnabled, unblockChatAuthor, unmuteChatAccount,
} from './service';

/** PostgreSQL bigint ceiling. Chat ids are bigserial, so a larger decimal can
 * only name a row that does not exist. It is folded onto the ceiling (just as
 * nonexistent) BEFORE any query, so each route answers with its ordinary
 * not-found; unfolded, the bind fails and the client gets an opaque 500 whose
 * difference from the 404 depends on nothing but the id's magnitude. */
const INT64_MAX = 9_223_372_036_854_775_807n;
const DecimalId = z.string().regex(/^[1-9][0-9]*$/)
  .transform((value) => { const id = BigInt(value); return id > INT64_MAX ? INT64_MAX : id; });
const Cursor = z.string().regex(/^(?:0|[1-9][0-9]*)$/).transform((value) => BigInt(value));
const PageQuery = z.object({
  before: DecimalId.optional(),
  limit: z.coerce.number().int().positive().max(CHAT.pageSize).default(CHAT.pageSize),
});
const EventQuery = z.object({
  after: Cursor.optional(),
  limit: z.coerce.number().int().positive().max(CHAT.pageSize).default(CHAT.pageSize),
});
const ReportQuery = PageQuery.extend({
  state: z.enum(['unresolved', 'resolved']).default('unresolved'),
});
const SendBody = z.object({ clientMessageId: z.uuid(), text: z.string() });
const MessageParams = z.object({ id: DecimalId });
const ReportBody = z.object({ reason: z.enum(CHAT_REPORT_REASONS) });
const ReasonBody = z.object({ reason: z.string().trim().min(1).max(CHAT.maxGraphemes) });
const MuteBody = z.object({
  wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  mutedUntil: z.iso.datetime().nullable(),
  reason: z.string().trim().min(1).max(CHAT.maxGraphemes),
});
const WalletParams = z.object({ wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) });
const ToggleBody = z.object({
  enabled: z.boolean(), reason: z.string().trim().min(1).max(CHAT.maxGraphemes),
});
const ResolveReportBody = z.object({
  resolution: z.literal('dismissed'),
  reason: z.string().trim().min(1).max(CHAT.maxGraphemes),
});

function noStore(reply: { header(name: string, value: string): unknown }) {
  reply.header('Cache-Control', 'private, no-store');
}

/** Chat polling replaces the global per-IP bucket with this authenticated
 * wallet bucket. Mobile carrier NATs therefore share no chat-read capacity,
 * while Redis failure remains fail-closed on this hot public-content read. */
export const CHAT_READ_RATE_LIMIT = {
  max: CHAT.readsPerWalletMinute,
  timeWindow: 60_000,
  keyGenerator: (req: FastifyRequest): string => `chat-read-wallet:${req.wallet}`,
  skipOnError: false,
};
export const CHAT_READ_IP_RATE_LIMIT = {
  max: CHAT.readsPerIpMinute,
  timeWindow: 60_000,
  hook: 'onRequest' as const,
  keyGenerator: (req: FastifyRequest): string => `chat-read-ip:${req.ip}`,
  skipOnError: false,
};

/** Author-card taps spend their OWN wallet bucket: opening profiles must not
 * starve the 2 s event poll, and a scripted walk over message ids stays bounded
 * per account however many IPs it rotates through. */
export const CHAT_AUTHOR_CARD_RATE_LIMIT = {
  max: CHAT.authorCardsPerWalletMinute,
  timeWindow: 60_000,
  keyGenerator: (req: FastifyRequest): string => `chat-author-card-wallet:${req.wallet}`,
  skipOnError: false,
};

export function registerChatRoutes(app: FastifyInstance, config: Config, db: Db): void {
  const auth = { preHandler: app.authenticate };
  const chatReadWalletLimiter = app.hasDecorator('createRateLimit')
    ? app.createRateLimit(CHAT_READ_RATE_LIMIT)
    : null;
  const enforceChatReadWalletLimit = async (req: FastifyRequest): Promise<void> => {
    if (chatReadWalletLimiter === null) return;
    const limit = await chatReadWalletLimiter(req);
    if (!limit.isAllowed && limit.isExceeded) {
      throw new HttpError(429, `chat read limit reached; try again in ${limit.ttlInSeconds}s`, 'CHAT_RATE_LIMITED');
    }
  };
  const chatRead = {
    preHandler: [app.authenticate, enforceChatReadWalletLimit],
    // Finite pre-auth IP admission + independent post-auth wallet fairness.
    config: { rateLimit: CHAT_READ_IP_RATE_LIMIT },
  };
  const chatAuthorCardLimiter = app.hasDecorator('createRateLimit')
    ? app.createRateLimit(CHAT_AUTHOR_CARD_RATE_LIMIT)
    : null;
  const enforceChatAuthorCardLimit = async (req: FastifyRequest): Promise<void> => {
    if (chatAuthorCardLimiter === null) return;
    const limit = await chatAuthorCardLimiter(req);
    if (!limit.isAllowed && limit.isExceeded) {
      throw new HttpError(429, `player card limit reached; try again in ${limit.ttlInSeconds}s`, 'CHAT_RATE_LIMITED');
    }
  };
  const chatAuthorCardRead = {
    preHandler: [app.authenticate, enforceChatAuthorCardLimit],
    config: { rateLimit: CHAT_READ_IP_RATE_LIMIT },
  };
  const requireChatEnabled = async () => assertGlobalChatEnabled(db);
  const chatMutation = { preHandler: [app.authenticate, requireChatEnabled] };
  const requireAdmin = async (req: { wallet: string }) => {
    if (!config.ADMIN_WALLETS?.includes(req.wallet)) throw new HttpError(404, 'not found');
  };
  const admin = { preHandler: [app.authenticate, requireAdmin] };

  app.get('/chat/status', chatRead, async (req, reply) => {
    noStore(reply);
    return getChatStatus(db, req.wallet);
  });
  app.get('/chat/messages', chatRead, async (req, reply) => {
    noStore(reply);
    await assertGlobalChatEnabled(db);
    const query = parse(PageQuery, req.query);
    return getChatMessages(db, req.wallet, query.before, query.limit);
  });
  app.get('/chat/events', chatRead, async (req, reply) => {
    noStore(reply);
    await assertGlobalChatEnabled(db);
    const query = parse(EventQuery, req.query);
    return getChatEvents(db, req.wallet, query.after, query.limit);
  });
  // The card is addressed by MESSAGE id: a wallet is neither accepted nor
  // returned, so chat cannot be turned into a wallet → profile lookup.
  app.get('/chat/messages/:id/author', chatAuthorCardRead, async (req, reply) => {
    noStore(reply);
    await assertGlobalChatEnabled(db);
    const { id } = parse(MessageParams, req.params);
    return getChatMessageAuthorCard(db, req.wallet, id);
  });
  app.post('/chat/messages', { ...chatMutation, bodyLimit: CHAT.requestBodyMaxBytes }, async (req, reply) => {
    noStore(reply);
    const body = parse(SendBody, req.body);
    const result = await sendChatMessage({
      db, wallet: req.wallet, ip: req.ip, secret: config.JWT_SECRET,
      clientMessageId: body.clientMessageId, rawText: body.text,
    });
    return reply.status(result.replay ? 200 : 201).send(result.message);
  });
  app.post('/chat/messages/:id/report', { ...chatMutation, bodyLimit: CHAT.requestBodyMaxBytes }, async (req, reply) => {
    noStore(reply);
    const { id } = parse(MessageParams, req.params);
    const { reason } = parse(ReportBody, req.body);
    await reportChatMessage({
      db, wallet: req.wallet, ip: req.ip, secret: config.JWT_SECRET,
      messageId: id, reason,
    });
    return reply.status(204).send();
  });
  app.post('/chat/messages/:id/block', { ...chatMutation, bodyLimit: CHAT.requestBodyMaxBytes }, async (req, reply) => {
    noStore(reply);
    const { id } = parse(MessageParams, req.params);
    const result = await blockChatMessageAuthor({
      db, blockerWallet: req.wallet, secret: config.JWT_SECRET, messageId: id,
    });
    return reply.status(result.replay ? 200 : 201).send({ block: result.block });
  });
  app.get('/chat/blocks', auth, async (req, reply) => {
    noStore(reply);
    await assertGlobalChatEnabled(db);
    const query = parse(PageQuery, req.query);
    return listChatBlocks(db, req.wallet, query.before, query.limit);
  });
  app.delete('/chat/blocks/:id', chatMutation, async (req, reply) => {
    noStore(reply);
    const { id } = parse(MessageParams, req.params);
    await unblockChatAuthor(db, req.wallet, config.JWT_SECRET, id);
    return reply.status(204).send();
  });

  app.get('/admin/chat/reports', admin, async (req, reply) => {
    noStore(reply);
    const query = parse(ReportQuery, req.query);
    return listChatReports(db, query.state, query.before, query.limit);
  });
  app.post('/admin/chat/reports/:id/resolve', { ...admin, bodyLimit: CHAT.requestBodyMaxBytes }, async (req, reply) => {
    noStore(reply);
    const { id } = parse(MessageParams, req.params);
    const body = parse(ResolveReportBody, req.body);
    await resolveChatReport({ db, actorWallet: req.wallet, reportId: id, reason: body.reason });
    return reply.status(204).send();
  });
  app.get('/admin/chat/status', admin, async (req, reply) => {
    noStore(reply);
    const status = await getChatStatus(db, req.wallet);
    return { enabled: status.enabled };
  });
  app.put('/admin/chat/status', { ...admin, bodyLimit: CHAT.requestBodyMaxBytes }, async (req, reply) => {
    noStore(reply);
    const body = parse(ToggleBody, req.body);
    return setGlobalChatEnabled({ db, actorWallet: req.wallet, ...body });
  });
  app.post('/admin/chat/messages/:id/redact', { ...admin, bodyLimit: CHAT.requestBodyMaxBytes }, async (req, reply) => {
    noStore(reply);
    const { id } = parse(MessageParams, req.params);
    const { reason } = parse(ReasonBody, req.body);
    await redactChatMessage(db, req.wallet, id, reason);
    return reply.status(204).send();
  });
  app.post('/admin/chat/mutes', { ...admin, bodyLimit: CHAT.requestBodyMaxBytes }, async (req, reply) => {
    noStore(reply);
    const body = parse(MuteBody, req.body);
    const mutedUntil = body.mutedUntil === null ? null : new Date(body.mutedUntil);
    if (mutedUntil && mutedUntil <= new Date()) throw new HttpError(400, 'mute expiry must be in the future');
    await muteChatAccount({
      db, actorWallet: req.wallet, targetWallet: body.wallet, mutedUntil, reason: body.reason,
    });
    return reply.status(204).send();
  });
  app.delete('/admin/chat/mutes/:wallet', { ...admin, bodyLimit: CHAT.requestBodyMaxBytes }, async (req, reply) => {
    noStore(reply);
    const { wallet } = parse(WalletParams, req.params);
    const { reason } = parse(ReasonBody, req.body);
    await unmuteChatAccount(db, req.wallet, wallet, reason);
    return reply.status(204).send();
  });
}
