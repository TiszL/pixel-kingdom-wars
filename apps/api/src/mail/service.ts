/** Private wallet mail and escrow-backed reward lifecycle (M22). */
import { createHash } from 'node:crypto';
import { MAIL } from '@shardkeep/shared';
import {
  and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, lte, or, sql,
} from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import {
  baseItems, ledgerEntries, ledgerTransactions, mailAttachments, mailMessages, players,
} from '../db/schema';
import type { Config } from '../config';
import { HttpError } from '../lib/errors';
import {
  bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount,
} from '../ledger/accounts';
import { postTransaction } from '../ledger/ledger';

export const MAIL_DELIVERY_DISABLED = 'MAIL_DELIVERY_DISABLED';
export const MAINNET_KEEP_MAIL_DISABLED = 'MAINNET_KEEP_MAIL_DISABLED';
export const MAINNET_KEEP_MAIL_MISCONFIGURED = 'MAINNET_KEEP_MAIL_MISCONFIGURED';
export const MAINNET_KEEP_MAIL_BUDGET_EXCEEDED = 'MAINNET_KEEP_MAIL_BUDGET_EXCEEDED';

export function mailDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MAIL_DELIVERY_ENABLED'] === 'true';
}

export type MailAttachmentInput =
  | { kind: 'KEEP'; amount: bigint }
  | { kind: 'SHARDS'; amount: bigint }
  | { kind: 'ITEM'; itemId: string; qty: number };

export interface MailDeliveryInput {
  recipientWallet: string;
  deliveryKey: string;
  subject: string;
  body: string;
  attachments?: readonly MailAttachmentInput[];
}

export interface MailClaimAuthority {
  prepare: (db: Db, wallet: string, baseId: string, now: Date) => Promise<void>;
  assertLocked: (tx: DbTx, wallet: string, baseId: string, now: Date) => Promise<void>;
}

export type CanonicalMailAttachment =
  | { kind: 'KEEP' | 'SHARDS'; amount: string }
  | { kind: 'ITEM'; itemId: string; qty: number };

interface Sender {
  kind: 'system' | 'admin';
  wallet: string | null;
}

export interface AdminKeepCampaignPolicy {
  cluster: Config['SOLANA_CLUSTER'];
  enabled: boolean;
  campaignId: string | null;
  /** Cumulative authorization in whole-KEEP ledger units. */
  budget: bigint | null;
}

type AdminKeepCampaignConfig = Pick<
  Config,
  'SOLANA_CLUSTER' | 'MAINNET_COMMUNITY_KEEP_MAIL_ENABLED'
  | 'MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID' | 'MAINNET_COMMUNITY_KEEP_MAIL_BUDGET'
>;

/** Convert boot-validated config into the narrow value the custody path uses. */
export function adminKeepCampaignPolicyFromConfig(
  config: AdminKeepCampaignConfig,
): AdminKeepCampaignPolicy {
  const rawBudget = config.MAINNET_COMMUNITY_KEEP_MAIL_BUDGET;
  return {
    cluster: config.SOLANA_CLUSTER,
    enabled: config.MAINNET_COMMUNITY_KEEP_MAIL_ENABLED === 'true',
    campaignId: config.MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID ?? null,
    budget: rawBudget && /^[1-9]\d*$/.test(rawBudget) ? BigInt(rawBudget) : null,
  };
}

/** Defense in depth for code-only callers. Routes pass the parsed Config, but
 * an internal caller may not bypass the mainnet campaign gate by omission. */
function liveAdminKeepCampaignPolicy(
  env: NodeJS.ProcessEnv = process.env,
): AdminKeepCampaignPolicy {
  const cluster = env['SOLANA_CLUSTER'] ?? 'devnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw new HttpError(503, 'Solana cluster configuration is invalid', MAINNET_KEEP_MAIL_MISCONFIGURED);
  }
  const rawBudget = env['MAINNET_COMMUNITY_KEEP_MAIL_BUDGET']?.trim();
  return {
    cluster,
    enabled: env['MAINNET_COMMUNITY_KEEP_MAIL_ENABLED'] === 'true',
    campaignId: env['MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID']?.trim() || null,
    budget: rawBudget && /^[1-9]\d*$/.test(rawBudget) ? BigInt(rawBudget) : null,
  };
}

const PG_INTEGER_MAX = 2_147_483_647; // PostgreSQL integer storage bound, not gameplay policy.
const approvedConsumables = new Set<string>(MAIL.approvedStackableConsumableIds);

function charCount(value: string): number {
  return [...value].length;
}

function normalizedDelivery(input: MailDeliveryInput): Required<MailDeliveryInput> {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || charCount(subject) > MAIL.subjectMaxChars) {
    throw new HttpError(422, `mail subject must be 1–${MAIL.subjectMaxChars} characters`);
  }
  if (!body || charCount(body) > MAIL.bodyMaxChars) {
    throw new HttpError(422, `mail body must be 1–${MAIL.bodyMaxChars} characters`);
  }
  if (!input.deliveryKey || input.deliveryKey.length > 128) {
    throw new HttpError(422, 'mail delivery key must be 1–128 characters');
  }
  const attachments = [...(input.attachments ?? [])];
  if (attachments.length > MAIL.maxAttachments) {
    throw new HttpError(422, `mail may contain at most ${MAIL.maxAttachments} attachments`);
  }
  const identities = new Set<string>();
  let keep = 0n;
  let shards = 0n;
  const itemTotals = new Map<string, number>();
  for (const attachment of attachments) {
    const identity = attachment.kind === 'ITEM' ? `ITEM:${attachment.itemId}` : attachment.kind;
    if (identities.has(identity)) throw new HttpError(422, 'duplicate mail attachment');
    identities.add(identity);
    if (attachment.kind === 'KEEP') {
      if (attachment.amount <= 0n) throw new HttpError(422, 'KEEP attachment must be positive');
      keep += attachment.amount;
    } else if (attachment.kind === 'SHARDS') {
      if (attachment.amount <= 0n) throw new HttpError(422, 'SHARDS attachment must be positive');
      shards += attachment.amount;
    } else {
      if (!approvedConsumables.has(attachment.itemId)) {
        throw new HttpError(422, 'item is not an approved stackable mail consumable');
      }
      if (!Number.isSafeInteger(attachment.qty) || attachment.qty <= 0) {
        throw new HttpError(422, 'item attachment quantity must be a positive integer');
      }
      itemTotals.set(attachment.itemId, (itemTotals.get(attachment.itemId) ?? 0) + attachment.qty);
    }
  }
  if (keep > BigInt(MAIL.rewardKeepMax)) throw new HttpError(422, 'KEEP mail reward exceeds the cap');
  if (shards > BigInt(MAIL.rewardShardsMax)) throw new HttpError(422, 'SHARDS mail reward exceeds the cap');
  if ([...itemTotals.values()].some((qty) => qty > MAIL.rewardConsumableQtyMax)) {
    throw new HttpError(422, 'consumable mail reward exceeds the cap');
  }
  return { ...input, subject, body, attachments };
}

function canonicalAttachment(attachment: MailAttachmentInput): readonly unknown[] {
  return attachment.kind === 'ITEM'
    ? [attachment.kind, attachment.itemId, attachment.qty]
    : [attachment.kind, attachment.amount.toString()];
}

function canonicalAttachmentSummary(attachment: MailAttachmentInput): CanonicalMailAttachment {
  return attachment.kind === 'ITEM'
    ? { kind: attachment.kind, itemId: attachment.itemId, qty: attachment.qty }
    : { kind: attachment.kind, amount: attachment.amount.toString() };
}

function contentHash(normalized: Required<MailDeliveryInput>): string {
  return createHash('sha256').update(JSON.stringify([
    normalized.recipientWallet,
    normalized.deliveryKey,
    normalized.subject,
    normalized.body,
    normalized.attachments.map(canonicalAttachment),
  ])).digest('hex');
}

/** Exact digest used by the admin recent-auth capability and the send route. */
export function adminRewardMailContentHash(input: MailDeliveryInput): string {
  const normalized = normalizedDelivery(input);
  if (normalized.attachments.length === 0) throw new HttpError(422, 'reward mail requires an attachment');
  return contentHash(normalized);
}

/** Human-readable fields shown beside the exact full-payload digest. */
export function adminRewardMailIntentSummary(input: MailDeliveryInput): {
  subject: string;
  attachments: CanonicalMailAttachment[];
  contentHash: string;
} {
  const normalized = normalizedDelivery(input);
  if (normalized.attachments.length === 0) throw new HttpError(422, 'reward mail requires an attachment');
  return {
    subject: normalized.subject,
    attachments: normalized.attachments.map(canonicalAttachmentSummary),
    contentHash: contentHash(normalized),
  };
}

function sameAttachment(
  stored: typeof mailAttachments.$inferSelect,
  requested: MailAttachmentInput,
): boolean {
  if (stored.kind !== requested.kind) return false;
  if (requested.kind === 'ITEM') return stored.itemId === requested.itemId && stored.qty === requested.qty;
  return stored.amount === requested.amount;
}

async function existingMatches(
  tx: DbTx,
  row: typeof mailMessages.$inferSelect,
  sender: Sender,
  input: Required<MailDeliveryInput>,
): Promise<boolean> {
  if (row.senderKind !== sender.kind || row.senderWallet !== sender.wallet
    || row.subject !== input.subject || row.body !== input.body
    || row.kind !== (input.attachments.length > 0 ? 'reward' : 'info')) return false;
  const attachments = await tx.select().from(mailAttachments)
    .where(eq(mailAttachments.messageId, row.id)).orderBy(asc(mailAttachments.position));
  return attachments.length === input.attachments.length
    && attachments.every((attachment, index) => sameAttachment(attachment, input.attachments[index]!));
}

interface CampaignReservation {
  id: string;
  budget: bigint;
  keep: bigint;
}

function requireMainnetCampaign(
  policy: AdminKeepCampaignPolicy,
  keep: bigint,
): CampaignReservation | null {
  if (keep === 0n || policy.cluster !== 'mainnet-beta') return null;
  if (!policy.enabled) {
    throw new HttpError(
      503, 'admin KEEP campaign delivery is disabled on mainnet', MAINNET_KEEP_MAIL_DISABLED,
    );
  }
  if (!policy.campaignId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(policy.campaignId)
    || policy.budget === null || policy.budget <= 0n) {
    throw new HttpError(
      503, 'admin KEEP campaign configuration is incomplete', MAINNET_KEEP_MAIL_MISCONFIGURED,
    );
  }
  return { id: policy.campaignId, budget: policy.budget, keep };
}

/** Serialize one campaign across API replicas, then count its actual historical
 * emission-pool debits. Expiry posts never enter this sum, so returning escrow
 * to the pool cannot recreate campaign authorization. */
async function reserveCampaignBudget(
  tx: DbTx,
  campaign: CampaignReservation,
  emissionPoolAccountId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(
    hashtextextended(${`mail-community-keep:${campaign.id}`}, 0)
  )`);
  const [usage] = await tx.select({
    used: sql<string>`coalesce(sum(-${ledgerEntries.delta}), 0)::text`,
  }).from(ledgerEntries).innerJoin(
    ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId),
  ).where(and(
    eq(ledgerTransactions.type, 'mail.reward.reserve'),
    eq(ledgerEntries.accountId, emissionPoolAccountId),
    sql`${ledgerEntries.delta} < 0`,
    sql`${ledgerTransactions.metadata} ->> 'communityKeepCampaignId' = ${campaign.id}`,
  ));
  const used = BigInt(usage?.used ?? '0');
  if (used + campaign.keep > campaign.budget) {
    throw new HttpError(
      409,
      `community KEEP campaign budget exhausted (${used}/${campaign.budget} KEEP reserved)`,
      MAINNET_KEEP_MAIL_BUDGET_EXCEEDED,
    );
  }
}

async function sendMailTx(
  tx: DbTx,
  sender: Sender,
  raw: MailDeliveryInput,
  now: Date,
  adminKeepCampaign?: AdminKeepCampaignPolicy,
) {
  const input = normalizedDelivery(raw);
  const [recipient] = await tx.select({ wallet: players.wallet }).from(players)
    .where(eq(players.wallet, input.recipientWallet));
  if (!recipient) throw new HttpError(404, 'mail recipient not found');
  const reward = input.attachments.length > 0;
  const inserted = await tx.insert(mailMessages).values({
    recipientWallet: input.recipientWallet,
    senderKind: sender.kind,
    senderWallet: sender.wallet,
    kind: reward ? 'reward' : 'info',
    dedupeKey: input.deliveryKey,
    subject: input.subject,
    body: input.body,
    rewardState: reward ? 'pending' : null,
    createdAt: now,
    expiresAt: reward
      ? new Date(now.getTime() + MAIL.rewardExpiryDays * 86_400_000)
      : null,
  }).onConflictDoNothing({
    target: [mailMessages.recipientWallet, mailMessages.dedupeKey],
  }).returning();

  const row = inserted[0];
  if (!row) {
    const [existing] = await tx.select().from(mailMessages).where(and(
      eq(mailMessages.recipientWallet, input.recipientWallet),
      eq(mailMessages.dedupeKey, input.deliveryKey),
    ));
    if (!existing || !await existingMatches(tx, existing, sender, input)) {
      throw new HttpError(409, 'mail delivery key was already used for different content');
    }
    // A byte-identical retry creates no message and reserves no value, so it is
    // safe even after a campaign closes. Returning here before the campaign
    // admission check is what makes retry semantics stable without restoring
    // or consuming any authorization.
    return { message: existing, duplicate: true };
  }

  if (reward) {
    const keep = input.attachments.reduce(
      (sum, attachment) => sum + (attachment.kind === 'KEEP' ? attachment.amount : 0n), 0n,
    );
    const shards = input.attachments.reduce(
      (sum, attachment) => sum + (attachment.kind === 'SHARDS' ? attachment.amount : 0n), 0n,
    );
    const campaign = sender.kind === 'admin' && adminKeepCampaign
      ? requireMainnetCampaign(adminKeepCampaign, keep)
      : null;
    const sys = keep > 0n || shards > 0n ? await bootstrapSystemAccounts(tx) : null;
    if (campaign) await reserveCampaignBudget(tx, campaign, sys!.emission_pool);

    await tx.insert(mailAttachments).values(input.attachments.map((attachment, position) => (
      attachment.kind === 'ITEM'
        ? { messageId: row.id, position, kind: attachment.kind, itemId: attachment.itemId, qty: attachment.qty }
        : { messageId: row.id, position, kind: attachment.kind, amount: attachment.amount }
    )));
    if (keep > 0n || shards > 0n) {
      const entries = [
        ...(keep > 0n ? [
          { account: sys!.emission_pool, delta: -keep },
          { account: sys!.mail_keep_escrow, delta: keep },
        ] : []),
        ...(shards > 0n ? [
          { account: sys!.shard_genesis, delta: -shards },
          { account: sys!.mail_shards_escrow, delta: shards },
        ] : []),
      ];
      const reserved = await postTransaction(tx, {
        idempotencyKey: `mail:reserve:${row.id}`,
        type: 'mail.reward.reserve',
        entries,
        metadata: {
          messageId: row.id,
          recipientWallet: input.recipientWallet,
          ...(campaign ? {
            communityKeepCampaignId: campaign.id,
            communityKeepCampaignBudget: campaign.budget.toString(),
            communityKeepReserved: campaign.keep.toString(),
            campaignAdminWallet: sender.wallet,
          } : {}),
        },
      });
      await tx.update(mailMessages).set({ reserveLedgerTxnId: reserved.transaction.id })
        .where(eq(mailMessages.id, row.id));
      row.reserveLedgerTxnId = reserved.transaction.id;
    }
  }
  return { message: row, duplicate: false };
}

function assertDeliveryEnabled(): void {
  if (!mailDeliveryEnabled()) {
    throw new HttpError(503, 'new mail delivery is disabled', MAIL_DELIVERY_DISABLED);
  }
}

/** Code-only idempotent system delivery. There is intentionally no system-send route. */
export async function deliverSystemMail(
  db: Db, input: MailDeliveryInput, now = new Date(),
) {
  assertDeliveryEnabled();
  return db.transaction((tx) => sendMailTx(tx, { kind: 'system', wallet: null }, input, now));
}

export async function deliverAdminMail(
  db: Db,
  adminWallet: string,
  input: MailDeliveryInput,
  options: { now?: Date; keepCampaign?: AdminKeepCampaignPolicy } = {},
) {
  assertDeliveryEnabled();
  const policy = options.keepCampaign ?? liveAdminKeepCampaignPolicy();
  return db.transaction((tx) => sendMailTx(
    tx, { kind: 'admin', wallet: adminWallet }, input, options.now ?? new Date(), policy,
  ));
}

export async function broadcastAdminInfoMail(
  db: Db,
  adminWallet: string,
  input: Omit<MailDeliveryInput, 'recipientWallet' | 'attachments'>,
  now = new Date(),
) {
  assertDeliveryEnabled();
  const recipients = await db.select({ wallet: players.wallet }).from(players)
    .orderBy(asc(players.wallet)).limit(MAIL.maxInformationalBroadcastRecipients + 1);
  if (recipients.length > MAIL.maxInformationalBroadcastRecipients) {
    throw new HttpError(422, 'informational broadcast recipient cap exceeded');
  }
  return db.transaction(async (tx) => {
    let delivered = 0;
    let duplicates = 0;
    for (const recipient of recipients) {
      const result = await sendMailTx(tx, { kind: 'admin', wallet: adminWallet }, {
        ...input,
        recipientWallet: recipient.wallet,
        attachments: [],
      }, now);
      if (result.duplicate) duplicates++;
      else delivered++;
    }
    return { recipients: recipients.length, delivered, duplicates };
  });
}

const attachmentSelection = {
  ...getTableColumns(mailAttachments),
  retired: sql<boolean>`case when ${mailAttachments.kind} = 'KEEP'
    then public.shardkeep_mail_keep_retired(${mailAttachments.id}) else false end`,
};
type MailAttachmentWithRetirement = typeof mailAttachments.$inferSelect & { retired: boolean };

function hasRetiredKeep(attachments: readonly MailAttachmentWithRetirement[]): boolean {
  return attachments.some((attachment) => attachment.kind === 'KEEP' && attachment.retired);
}

function attachmentDto(row: MailAttachmentWithRetirement) {
  return row.kind === 'ITEM'
    ? { kind: 'ITEM' as const, itemId: row.itemId!, qty: row.qty! }
    : { kind: row.kind as 'KEEP' | 'SHARDS', amount: row.amount!.toString(),
      ...(row.kind === 'KEEP' && row.retired ? { retired: true as const } : {}) };
}

function messageDto(
  row: typeof mailMessages.$inferSelect,
  attachments: readonly MailAttachmentWithRetirement[],
) {
  return {
    id: row.id,
    sender: row.senderKind,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    attachments: attachments.map(attachmentDto),
    rewardState: row.rewardState,
    claimBaseId: row.claimBaseId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    readAt: row.readAt,
    archivedAt: row.archivedAt,
    claimedAt: row.claimedAt,
    expiredAt: row.expiredAt,
  };
}

export async function listMail(
  db: Db,
  wallet: string,
  opts: { cursor?: string; limit?: number; archived?: boolean },
) {
  const limit = Math.min(opts.limit ?? MAIL.listLimitDefault, MAIL.listLimitMax);
  let cursor: { id: string; createdAt: Date } | undefined;
  if (opts.cursor) {
    [cursor] = await db.select({ id: mailMessages.id, createdAt: mailMessages.createdAt })
      .from(mailMessages).where(and(
        eq(mailMessages.id, opts.cursor), eq(mailMessages.recipientWallet, wallet),
      ));
    if (!cursor) throw new HttpError(404, 'mail cursor not found');
  }
  const rows = await db.select().from(mailMessages).where(and(
    eq(mailMessages.recipientWallet, wallet),
    opts.archived ? isNotNull(mailMessages.archivedAt) : isNull(mailMessages.archivedAt),
    ...(cursor ? [or(
      lt(mailMessages.createdAt, cursor.createdAt),
      and(eq(mailMessages.createdAt, cursor.createdAt), lt(mailMessages.id, cursor.id)),
    )!] : []),
  )).orderBy(desc(mailMessages.createdAt), desc(mailMessages.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const attachments = page.length === 0 ? [] : await db.select(attachmentSelection).from(mailAttachments)
    .where(inArray(mailAttachments.messageId, page.map((row) => row.id)))
    .orderBy(asc(mailAttachments.position));
  const byMessage = new Map<string, typeof attachments>();
  for (const attachment of attachments) {
    const current = byMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    byMessage.set(attachment.messageId, current);
  }
  return {
    messages: page.map((row) => messageDto(row, byMessage.get(row.id) ?? [])),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}

export async function getMail(db: Db, wallet: string, messageId: string) {
  const [row] = await db.select().from(mailMessages).where(and(
    eq(mailMessages.id, messageId), eq(mailMessages.recipientWallet, wallet),
  ));
  if (!row) throw new HttpError(404, 'mail not found');
  const attachments = await db.select(attachmentSelection).from(mailAttachments)
    .where(eq(mailAttachments.messageId, row.id)).orderBy(asc(mailAttachments.position));
  return messageDto(row, attachments);
}

export async function markMailRead(db: Db, wallet: string, messageId: string, now = new Date()) {
  const rows = await db.update(mailMessages).set({ readAt: now }).where(and(
    eq(mailMessages.id, messageId), eq(mailMessages.recipientWallet, wallet),
    isNull(mailMessages.readAt),
  )).returning({ id: mailMessages.id });
  if (rows.length === 0) {
    const [existing] = await db.select({ id: mailMessages.id }).from(mailMessages).where(and(
      eq(mailMessages.id, messageId), eq(mailMessages.recipientWallet, wallet),
    ));
    if (!existing) throw new HttpError(404, 'mail not found');
  }
  return getMail(db, wallet, messageId);
}

export async function archiveMail(db: Db, wallet: string, messageId: string, now = new Date()) {
  const rows = await db.update(mailMessages).set({ archivedAt: now }).where(and(
    eq(mailMessages.id, messageId), eq(mailMessages.recipientWallet, wallet),
    isNull(mailMessages.archivedAt),
  )).returning({ id: mailMessages.id });
  if (rows.length === 0) {
    const [existing] = await db.select({ id: mailMessages.id }).from(mailMessages).where(and(
      eq(mailMessages.id, messageId), eq(mailMessages.recipientWallet, wallet),
    ));
    if (!existing) throw new HttpError(404, 'mail not found');
  }
  return getMail(db, wallet, messageId);
}

export async function getMailStatus(db: Db, wallet: string) {
  const [counts] = await db.select({
    total: sql<number>`count(*)::int`,
    unread: sql<number>`count(*) filter (where ${mailMessages.readAt} is null)::int`,
    pendingRewards: sql<number>`count(*) filter (where ${mailMessages.rewardState} = 'pending')::int`,
  }).from(mailMessages).where(and(
    eq(mailMessages.recipientWallet, wallet), isNull(mailMessages.archivedAt),
  ));
  return { total: counts?.total ?? 0, unread: counts?.unread ?? 0, pendingRewards: counts?.pendingRewards ?? 0 };
}

async function attachmentsForUpdate(tx: DbTx, messageId: string) {
  return tx.select(attachmentSelection).from(mailAttachments).where(eq(mailAttachments.messageId, messageId))
    .orderBy(asc(mailAttachments.position)).for('update');
}

async function unwindLockedReward(
  tx: DbTx,
  row: typeof mailMessages.$inferSelect,
  now: Date,
): Promise<boolean> {
  if (row.rewardState !== 'pending') return false;
  const attachments = await attachmentsForUpdate(tx, row.id);
  // Retirement leaves the original attachments intact. Its proven KEEP leg
  // pauses expiry of the remaining SHARDS/items until they are claimed.
  if (hasRetiredKeep(attachments)) return false;
  const keep = attachments.reduce((sum, a) => sum + (a.kind === 'KEEP' && !a.retired ? a.amount! : 0n), 0n);
  const shards = attachments.reduce((sum, a) => sum + (a.kind === 'SHARDS' ? a.amount! : 0n), 0n);
  let ledgerTxnId: string | null = null;
  if (keep > 0n || shards > 0n) {
    const sys = await bootstrapSystemAccounts(tx);
    const posted = await postTransaction(tx, {
      idempotencyKey: `mail:expire:${row.id}`,
      type: 'mail.reward.expire',
      entries: [
        ...(keep > 0n ? [
          { account: sys.mail_keep_escrow, delta: -keep },
          { account: sys.emission_pool, delta: keep },
        ] : []),
        ...(shards > 0n ? [
          { account: sys.mail_shards_escrow, delta: -shards },
          { account: sys.shard_genesis, delta: shards },
        ] : []),
      ],
      metadata: { messageId: row.id, recipientWallet: row.recipientWallet },
    });
    ledgerTxnId = posted.transaction.id;
  }
  await tx.update(mailMessages).set({
    rewardState: 'expired', expiredAt: now, unwindLedgerTxnId: ledgerTxnId,
  }).where(and(eq(mailMessages.id, row.id), eq(mailMessages.rewardState, 'pending')));
  return true;
}

export async function claimMailReward(
  db: Db,
  wallet: string,
  messageId: string,
  baseId: string | undefined,
  authority: MailClaimAuthority,
  now = new Date(),
) {
  // Inspect under the same locks used by claim/expiry before doing any deed
  // RPC. Terminal outcomes and due escrow unwinds must remain available when a
  // base was sold, baseId is omitted, or finalized RPC is unavailable.
  const inspected = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(mailMessages).where(and(
      eq(mailMessages.id, messageId), eq(mailMessages.recipientWallet, wallet),
    )).for('update');
    if (!row) throw new HttpError(404, 'mail not found');
    if (row.kind !== 'reward') throw new HttpError(422, 'mail has no reward');
    const attachments = await attachmentsForUpdate(tx, row.id);
    if (row.rewardState === 'claimed' || row.rewardState === 'expired') {
      return { terminal: messageDto(row, attachments), needsBase: false };
    }
    if (row.rewardState !== 'pending') throw new Error(`invalid reward state for ${row.id}`);
    if (!hasRetiredKeep(attachments) && (!row.expiresAt || row.expiresAt.getTime() <= now.getTime())) {
      await unwindLockedReward(tx, row, now);
      const [expired] = await tx.select().from(mailMessages).where(eq(mailMessages.id, row.id));
      return { terminal: messageDto(expired!, attachments), needsBase: false };
    }
    return {
      terminal: null,
      needsBase: attachments.some((a) => a.kind === 'SHARDS' || a.kind === 'ITEM'),
    };
  });
  if (inspected.terminal) return inspected.terminal;
  if (inspected.needsBase && !baseId) {
    throw new HttpError(422, 'baseId is required for base-owned mail rewards', 'BASE_ID_REQUIRED');
  }
  if (inspected.needsBase) await authority.prepare(db, wallet, baseId!, now);

  return db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    const [row] = await tx.select().from(mailMessages).where(and(
      eq(mailMessages.id, messageId), eq(mailMessages.recipientWallet, wallet),
    )).for('update');
    if (!row) throw new HttpError(404, 'mail not found');
    if (row.kind !== 'reward') throw new HttpError(422, 'mail has no reward');
    const attachments = await attachmentsForUpdate(tx, row.id);
    if (row.rewardState === 'claimed') {
      return messageDto(row, attachments);
    }
    if (row.rewardState === 'expired') {
      return messageDto(row, attachments);
    }
    if (row.rewardState !== 'pending') throw new Error(`invalid reward state for ${row.id}`);
    if (!hasRetiredKeep(attachments) && (!row.expiresAt || row.expiresAt.getTime() <= now.getTime())) {
      await unwindLockedReward(tx, row, now);
      const [expired] = await tx.select().from(mailMessages).where(eq(mailMessages.id, row.id));
      return messageDto(expired!, attachments);
    }

    const needsBase = attachments.some((a) => a.kind === 'SHARDS' || a.kind === 'ITEM');
    if (needsBase && !baseId) {
      throw new HttpError(422, 'baseId is required for base-owned mail rewards', 'BASE_ID_REQUIRED');
    }
    // Only a still-pending, unexpired mutation needs present deed authority.
    // Terminal retries return the committed outcome even after a later sale;
    // expiry can always return escrow to its source without deed authority.
    if (needsBase) await authority.assertLocked(tx, wallet, baseId!, new Date());
    const keep = attachments.reduce((sum, a) => sum + (a.kind === 'KEEP' && !a.retired ? a.amount! : 0n), 0n);
    const shards = attachments.reduce((sum, a) => sum + (a.kind === 'SHARDS' ? a.amount! : 0n), 0n);
    let ledgerTxnId: string | null = null;
    if (keep > 0n || shards > 0n) {
      const sys = await bootstrapSystemAccounts(tx);
      const playerKeep = keep > 0n ? await getOrCreatePlayerAccount(tx, wallet, 'player_keep') : null;
      const baseShards = shards > 0n ? await getOrCreateBaseAccount(tx, baseId!, 'base_shards') : null;
      const posted = await postTransaction(tx, {
        idempotencyKey: `mail:claim:${row.id}`,
        type: 'mail.reward.claim',
        entries: [
          ...(keep > 0n ? [
            { account: sys.mail_keep_escrow, delta: -keep },
            { account: playerKeep!.id, delta: keep },
          ] : []),
          ...(shards > 0n ? [
            { account: sys.mail_shards_escrow, delta: -shards },
            { account: baseShards!.id, delta: shards },
          ] : []),
        ],
        metadata: { messageId: row.id, recipientWallet: wallet, ...(baseId ? { baseId } : {}) },
      });
      ledgerTxnId = posted.transaction.id;
    }

    for (const attachment of attachments) {
      if (attachment.kind !== 'ITEM') continue;
      const claimed = await tx.insert(baseItems).values({
        baseId: baseId!, itemId: attachment.itemId!, qty: attachment.qty!, acquiredAt: now,
      }).onConflictDoUpdate({
        target: [baseItems.baseId, baseItems.itemId],
        set: { qty: sql`${baseItems.qty} + ${attachment.qty!}`, acquiredAt: now },
        setWhere: sql`${baseItems.qty} <= ${PG_INTEGER_MAX - attachment.qty!}`,
      }).returning({ id: baseItems.id });
      if (claimed.length === 0) throw new HttpError(409, 'item stack cannot hold this mail reward', 'ITEM_STACK_OVERFLOW');
    }

    await tx.update(mailMessages).set({
      rewardState: 'claimed', claimLedgerTxnId: ledgerTxnId,
      claimBaseId: needsBase ? baseId! : null, claimedAt: now, readAt: row.readAt ?? now,
    }).where(and(eq(mailMessages.id, row.id), eq(mailMessages.rewardState, 'pending')));
    const [claimed] = await tx.select().from(mailMessages).where(eq(mailMessages.id, row.id));
    return messageDto(claimed!, attachments);
  });
}

/** Race-safe worker sweep. Claim and unwind contend on the same message row. */
export async function expireDueMailRewards(
  db: Db, now = new Date(), limit: number = MAIL.expiryBatchSize,
) {
  const candidates = await db.select({ id: mailMessages.id }).from(mailMessages).where(and(
    eq(mailMessages.rewardState, 'pending'), isNotNull(mailMessages.expiresAt),
    lte(mailMessages.expiresAt, now),
    // Filter before LIMIT so paused messages cannot starve ordinary expiry.
    sql`not exists (select 1 from ${mailAttachments}
      where ${mailAttachments.messageId} = ${mailMessages.id}
      and ${mailAttachments.kind} = 'KEEP'
      and public.shardkeep_mail_keep_retired(${mailAttachments.id}))`,
  )).orderBy(asc(mailMessages.expiresAt), asc(mailMessages.id)).limit(limit);
  let expired = 0;
  for (const candidate of candidates) {
    const didExpire = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(mailMessages).where(eq(mailMessages.id, candidate.id)).for('update');
      if (!row || row.rewardState !== 'pending' || !row.expiresAt || row.expiresAt > now) return false;
      return unwindLockedReward(tx, row, now);
    });
    if (didExpire) expired++;
  }
  return { scanned: candidates.length, expired };
}
