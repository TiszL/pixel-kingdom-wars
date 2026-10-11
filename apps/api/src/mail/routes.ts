import { MAIL } from '@shardkeep/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import {
  assertFreshLockedBaseAuthority, makeFinalizedDeedReader, requireFreshBaseAuthority,
  type FinalizedDeedReader,
} from '../game/baseOwnership';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { WITHDRAWAL_IDEMPOTENCY_KEY_RE } from '../auth/session';
import {
  adminKeepCampaignPolicyFromConfig, adminRewardMailIntentSummary, archiveMail,
  broadcastAdminInfoMail, claimMailReward, deliverAdminMail, getMail, getMailStatus,
  listMail, markMailRead,
  type MailAttachmentInput,
} from './service';

const Wallet = z.string().min(32).max(44);
const UuidParams = z.object({ id: z.uuid() });
const DeliveryKey = z.string().regex(WITHDRAWAL_IDEMPOTENCY_KEY_RE);
const Attachment = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('KEEP'),
    amount: z.string().regex(/^\d+$/).max(String(MAIL.rewardKeepMax).length),
  }),
  z.object({
    kind: z.literal('SHARDS'),
    amount: z.string().regex(/^\d+$/).max(String(MAIL.rewardShardsMax).length),
  }),
  z.object({
    kind: z.literal('ITEM'),
    itemId: z.string().min(1).max(128),
    qty: z.number().int().positive().max(MAIL.rewardConsumableQtyMax),
  }),
]);
const SingleBody = z.object({
  recipientWallet: Wallet,
  idempotencyKey: DeliveryKey,
  subject: z.string().min(1).max(MAIL.subjectMaxChars * 2),
  body: z.string().min(1).max(MAIL.bodyMaxChars * 2),
  attachments: z.array(Attachment).max(MAIL.maxAttachments).optional(),
});
const BroadcastBody = z.object({
  idempotencyKey: DeliveryKey,
  subject: z.string().min(1).max(MAIL.subjectMaxChars * 2),
  body: z.string().min(1).max(MAIL.bodyMaxChars * 2),
});
const ListQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().positive().max(MAIL.listLimitMax).optional(),
  archived: z.enum(['true', 'false']).optional(),
});
const ClaimBody = z.object({ baseId: z.uuid().optional() });

function decodeAttachments(rows: z.infer<typeof Attachment>[]): MailAttachmentInput[] {
  return rows.map((attachment) => attachment.kind === 'ITEM'
    ? attachment
    : { kind: attachment.kind, amount: BigInt(attachment.amount) });
}

export interface MailRouteDeps {
  rpcUrl?: string | undefined;
  deedCollection?: string | undefined;
  finalizedDeedReader?: FinalizedDeedReader | undefined;
}

export function registerMailRoutes(
  app: FastifyInstance,
  config: Config,
  db: Db,
  deps: MailRouteDeps = {},
): void {
  const player = { preHandler: app.authenticate };
  const adminKeepCampaign = adminKeepCampaignPolicyFromConfig(config);
  const noStore = (reply: { header: (name: string, value: string) => unknown }): void => {
    reply.header('cache-control', 'no-store, private');
  };
  const finalizedReader = deps.finalizedDeedReader ?? makeFinalizedDeedReader({
    rpcUrl: deps.rpcUrl,
    deedCollection: deps.deedCollection,
  });
  const authority = {
    prepare: async (database: Db, wallet: string, baseId: string, now: Date) => {
      await requireFreshBaseAuthority(
        database, wallet, baseId, finalizedReader, deps.deedCollection ?? null, now,
      );
    },
    assertLocked: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], wallet: string, baseId: string, now: Date) => {
      await assertFreshLockedBaseAuthority(tx, wallet, baseId, now);
    },
  };

  app.get('/mail/status', player, async (req, reply) => {
    noStore(reply);
    return getMailStatus(db, req.wallet);
  });
  app.get('/mail', player, async (req, reply) => {
    noStore(reply);
    const query = parse(ListQuery, req.query);
    return listMail(db, req.wallet, {
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
      archived: query.archived === 'true',
    });
  });
  app.get('/mail/:id', player, async (req, reply) => {
    noStore(reply);
    return getMail(db, req.wallet, parse(UuidParams, req.params).id);
  });
  app.post('/mail/:id/read', player, async (req, reply) => {
    noStore(reply);
    return markMailRead(db, req.wallet, parse(UuidParams, req.params).id);
  });
  app.post('/mail/:id/archive', player, async (req, reply) => {
    noStore(reply);
    return archiveMail(db, req.wallet, parse(UuidParams, req.params).id);
  });
  app.post('/mail/:id/claim', player, async (req, reply) => {
    noStore(reply);
    const { id } = parse(UuidParams, req.params);
    const { baseId } = parse(ClaimBody, req.body ?? {});
    return claimMailReward(db, req.wallet, id, baseId, authority);
  });

  async function requireAdmin(req: Parameters<typeof app.authenticate>[0], reply: Parameters<typeof app.authenticate>[1]) {
    if (!config.ADMIN_WALLETS) throw new HttpError(404, 'not found');
    await app.authenticate(req, reply);
    if (!config.ADMIN_WALLETS.includes(req.wallet)) throw new HttpError(403, 'admin access required');
  }
  const admin = {
    preHandler: requireAdmin,
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  };

  app.post('/admin/mail/send', admin, async (req, reply) => {
    noStore(reply);
    const body = parse(SingleBody, req.body);
    const attachments = decodeAttachments(body.attachments ?? []);
    const input = {
      recipientWallet: body.recipientWallet,
      deliveryKey: body.idempotencyKey,
      subject: body.subject,
      body: body.body,
      attachments,
    };
    if (attachments.length > 0) {
      const summary = adminRewardMailIntentSummary(input);
      await app.assertRecentAuth(req, 'admin_mail_reward', {
        recipientWallet: body.recipientWallet,
        idempotencyKey: body.idempotencyKey,
        ...summary,
      });
    }
    const result = await deliverAdminMail(db, req.wallet, input, {
      keepCampaign: adminKeepCampaign,
    });
    return { id: result.message.id, duplicate: result.duplicate };
  });

  app.post('/admin/mail/broadcast', admin, async (req, reply) => {
    noStore(reply);
    const body = parse(BroadcastBody, req.body);
    return broadcastAdminInfoMail(db, req.wallet, {
      deliveryKey: body.idempotencyKey, subject: body.subject, body: body.body,
    });
  });
}
