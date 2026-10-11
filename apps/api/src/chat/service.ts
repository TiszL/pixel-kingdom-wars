import { createHash, createHmac } from 'node:crypto';
import {
  CHAT, type ChatBlock, type ChatEvent, type ChatMessage, type ChatSendBlockedReason,
} from '@shardkeep/shared';
import { ChatAuthorCardSchema, type ChatAuthorCard } from '@shardkeep/shared/chatAuthorCard';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import {
  baseProfiles, bases, baseSlots, clanMembers, clans,
  globalChatBlocks, globalChatEvents, globalChatMessages, globalChatModerationAudit,
  globalChatMutes, globalChatRateLimits, globalChatReports, gameConfig, players,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import { GAME_CONFIG_ID, ensureGameConfig } from '../game/gameConfig';
import { alias } from 'drizzle-orm/pg-core';
import { usernameKey } from '../game/username';

export const CHAT_REPORT_REASONS = [
  'spam', 'harassment', 'hate', 'sexual', 'personal_info', 'other',
] as const;
export type ChatReportReason = (typeof CHAT_REPORT_REASONS)[number];
const reportResolver = alias(players, 'chat_report_resolver');

type MessageRow = {
  id: bigint;
  clientMessageId: string;
  text: string;
  createdAt: Date;
  name: string;
  avatarGeneration: string | null;
  seekerVerified: boolean;
  canBlock: boolean;
  mentions: Array<{ start: number; end: number; wallet: string }>;
  mentioned: boolean;
};

const dayMs = 86_400_000;
const utf8 = new TextEncoder();
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const forbiddenUnicode = /[\p{Cc}\p{Cf}]/u;
const pictograph = /\p{Extended_Pictographic}/gu;
const likelyUrl = /(?:\b(?:https?|ftp):\/\/|\bwww\.|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62})\.)+[\p{L}]{2,63}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b)/iu;
const markup = /(?:<[^>]*>|\[[^\]]*\]\([^)]*\)|`{1,3}|\*\*|__)/u;

function normalizeChatCharacters(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  const visibleControlProbe = text.replaceAll('\n', '');
  const safeEmojiJoiners = [...graphemes.segment(visibleControlProbe)].every(({ segment }) => {
    if (!segment.includes('\u200d')) return true;
    return (segment.match(pictograph)?.length ?? 0) >= 2
      && !forbiddenUnicode.test(segment.replaceAll('\u200d', ''));
  });
  if (!text) throw new HttpError(400, 'message is empty', 'CHAT_TEXT_INVALID');
  if (utf8.encode(text).byteLength > CHAT.maxUtf8Bytes
    || [...graphemes.segment(text)].length > CHAT.maxGraphemes
    || text.split('\n').length > CHAT.maxLines
    || !safeEmojiJoiners
    || forbiddenUnicode.test(visibleControlProbe.replaceAll('\u200d', ''))
    || markup.test(text)) {
    throw new HttpError(400, 'message contains unsupported content', 'CHAT_TEXT_INVALID');
  }
  return text;
}

/** Public strict validator remains useful without a database. New sends may
 * exempt only the exact spans resolved by resolveChatMentions below. */
export function normalizeChatText(raw: string): string {
  const text = normalizeChatCharacters(raw);
  rejectChatLinks(text, []);
  return text;
}

type StoredMention = MessageRow['mentions'][number];

function rejectChatLinks(text: string, mentions: readonly StoredMention[]): void {
  let unmentioned = '', cursor = 0;
  for (const mention of mentions) {
    unmentioned += text.slice(cursor, mention.start) + ' '.repeat(mention.end - mention.start);
    cursor = mention.end;
  }
  unmentioned += text.slice(cursor);
  if (likelyUrl.test(unmentioned)) {
    throw new HttpError(400, 'message contains unsupported content', 'CHAT_TEXT_INVALID');
  }
}

async function resolveChatMentions(tx: DbTx, text: string): Promise<StoredMention[]> {
  // Tokens must be standalone. A colon is punctuation only before whitespace
  // or end-of-text: @name.skr:443 must never exempt a domain with a port.
  const pattern = /(^|[\s([{"'])@([\p{L}\p{N}][\p{L}\p{N}_.．＿－-]*)(?=$|[\s,!;)\]}"']|[?:](?=\s|$))/gu;
  const candidates: Array<{ start: number; end: number; key: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const token = match[2]!.replace(/[.．]+$/, ''); // sentence-ending periods stay outside the span
    const start = match.index! + match[1]!.length;
    candidates.push({ start, end: start + token.length + 1, key: usernameKey(token) });
  }
  if (!candidates.length) return [];
  // Canonical keys use the same NFKC fold as username registration; text and
  // offsets stay NFC. The unique index binds recipients at this query snapshot.
  // Store those identities so a later rename cannot retarget a sent message;
  // recipient locks would unnecessarily couple simultaneous cross-mentions.
  const recipients = await tx.select({ wallet: players.wallet, key: players.nameKey })
    .from(players).where(inArray(players.nameKey, [...new Set(candidates.map((c) => c.key))]));
  const wallets = new Map(recipients.map((recipient) => [recipient.key, recipient.wallet]));
  return candidates.flatMap(({ start, end, key }) => {
    const wallet = wallets.get(key);
    return wallet ? [{ start, end, wallet }] : [];
  });
}

const mentionedByViewer = (wallet: string) => sql<boolean>`
  ${globalChatMessages.authorWallet} <> ${wallet}
  and ${globalChatMessages.mentions} @> ${JSON.stringify([{ wallet }])}::jsonb
`;

const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');
const subjectHash = (secret: string, kind: string, subject: string): string =>
  createHmac('sha256', secret).update(`${kind}\0${subject}`).digest('hex');

function publicMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id.toString(),
    clientMessageId: row.clientMessageId,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    author: {
      name: row.name,
      avatarUrl: row.avatarGeneration ? `/api/avatars/${row.avatarGeneration}.webp` : null,
      seekerVerified: row.seekerVerified,
    },
    canBlock: row.canBlock,
    mentions: row.mentions.map(({ start, end }) => ({ start, end })),
    mentioned: row.mentioned,
  };
}

function publicBlock(row: {
  id: bigint;
  createdAt: Date;
  name: string;
  avatarGeneration: string | null;
  seekerVerified: boolean;
}): ChatBlock {
  return {
    id: row.id.toString(),
    createdAt: row.createdAt.toISOString(),
    author: {
      name: row.name,
      avatarUrl: row.avatarGeneration ? `/api/avatars/${row.avatarGeneration}.webp` : null,
      seekerVerified: row.seekerVerified,
    },
  };
}

async function currentMessage(
  db: Db | DbTx, id: bigint, viewerWallet: string,
): Promise<ChatMessage | null> {
  const [row] = await db.select({
    id: globalChatMessages.id,
    clientMessageId: globalChatMessages.clientMessageId,
    text: globalChatMessages.text,
    createdAt: globalChatMessages.createdAt,
    name: globalChatMessages.authorNameAtSend,
    avatarGeneration: players.avatarGeneration,
    seekerVerified: globalChatMessages.authorSeekerVerifiedAtSend,
    canBlock: sql<boolean>`${globalChatMessages.authorWallet} <> ${viewerWallet}`,
    mentions: globalChatMessages.mentions,
    mentioned: mentionedByViewer(viewerWallet),
  }).from(globalChatMessages)
    .innerJoin(players, eq(players.wallet, globalChatMessages.authorWallet))
    .where(and(eq(globalChatMessages.id, id), isNull(globalChatMessages.redactedAt)))
    .limit(1);
  return row ? publicMessage(row) : null;
}

async function activeMute(db: Db | DbTx, wallet: string, now: Date) {
  const [mute] = await db.select({ mutedUntil: globalChatMutes.mutedUntil })
    .from(globalChatMutes)
    .where(and(eq(globalChatMutes.wallet, wallet), or(
      isNull(globalChatMutes.mutedUntil), gt(globalChatMutes.mutedUntil, now),
    )))
    .limit(1);
  return mute;
}

async function canUseDeedChat(db: Db | DbTx, wallet: string): Promise<boolean> {
  const [row] = await db.select({ id: bases.id }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
      eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      // A paid active base remains valid while its best-effort mint is pending.
      // Current owner + active slot are the authority boundary, not receipt state.
      isNotNull(bases.landPaidAt),
    )).limit(1);
  return row !== undefined;
}

async function playerState(db: Db | DbTx, wallet: string) {
  const [player] = await db.select({
    name: players.name, seekerVerified: players.seekerVerified,
  }).from(players)
    .where(eq(players.wallet, wallet)).limit(1);
  if (!player) throw new HttpError(401, 'unknown player');
  return player;
}

async function lockSubjects(tx: DbTx, subjects: string[]): Promise<void> {
  for (const subject of [...subjects].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${subject}, 0))`);
  }
}

async function spendRateBucket(
  tx: DbTx, kind: string, hash: string, windowStart: Date, max: number,
): Promise<void> {
  const [row] = await tx.select({ count: globalChatRateLimits.count })
    .from(globalChatRateLimits)
    .where(and(
      eq(globalChatRateLimits.kind, kind), eq(globalChatRateLimits.subjectHash, hash),
      eq(globalChatRateLimits.windowStart, windowStart),
    )).limit(1);
  if ((row?.count ?? 0) >= max) {
    throw new HttpError(429, 'chat rate limit reached', 'CHAT_RATE_LIMITED');
  }
  if (row) {
    await tx.update(globalChatRateLimits).set({ count: row.count + 1 }).where(and(
      eq(globalChatRateLimits.kind, kind), eq(globalChatRateLimits.subjectHash, hash),
      eq(globalChatRateLimits.windowStart, windowStart),
    ));
  } else {
    await tx.insert(globalChatRateLimits).values({ kind, subjectHash: hash, windowStart, count: 1 });
  }
}

export async function getChatStatus(db: Db, wallet: string, now = new Date()) {
  const [player, deed, mute, cursor, enabled] = await Promise.all([
    playerState(db, wallet), canUseDeedChat(db, wallet), activeMute(db, wallet, now),
    db.select({ id: sql<bigint>`coalesce(max(${globalChatEvents.id}), 0)::bigint` })
      .from(globalChatEvents).then((rows) => rows[0]!.id),
    isGlobalChatEnabled(db),
  ]);
  const sendBlockedReason: ChatSendBlockedReason | null = !enabled ? 'DISABLED' : !player.name
    ? 'USERNAME_REQUIRED'
    : !deed ? 'DEED_REQUIRED'
      : mute ? 'MUTED' : null;
  return {
    enabled,
    canSend: sendBlockedReason === null,
    sendBlockedReason,
    mutedUntil: enabled ? (mute?.mutedUntil?.toISOString() ?? null) : null,
    latestEventId: cursor.toString(),
    pollOpenMs: CHAT.pollOpenMs,
    pollClosedMs: CHAT.pollClosedMs,
  };
}

export async function isGlobalChatEnabled(db: Db | DbTx): Promise<boolean> {
  const [row] = await db.select({ enabled: gameConfig.globalChatEnabled })
    .from(gameConfig).where(eq(gameConfig.id, GAME_CONFIG_ID)).limit(1);
  return row?.enabled ?? true;
}

export async function assertGlobalChatEnabled(db: Db | DbTx): Promise<void> {
  if (!await isGlobalChatEnabled(db)) {
    throw new HttpError(503, 'global chat is temporarily disabled', 'CHAT_DISABLED');
  }
}

export async function setGlobalChatEnabled(input: {
  db: Db; actorWallet: string; enabled: boolean; reason: string; now?: Date;
}): Promise<{ enabled: boolean }> {
  const now = input.now ?? new Date();
  await input.db.transaction(async (tx) => {
    await ensureGameConfig(tx);
    await tx.update(gameConfig).set({ globalChatEnabled: input.enabled, updatedAt: now })
      .where(eq(gameConfig.id, GAME_CONFIG_ID));
    await tx.insert(globalChatModerationAudit).values({
      actorWallet: input.actorWallet, action: 'toggle_chat', reason: input.reason, createdAt: now,
    });
  });
  return { enabled: input.enabled };
}

export async function getChatMessages(
  db: Db, viewerWallet: string, before: bigint | undefined, limit: number, now = new Date(),
) {
  const cutoff = new Date(now.getTime() - CHAT.visibleRetentionDays * dayMs);
  const rows = await db.select({
    id: globalChatMessages.id,
    clientMessageId: globalChatMessages.clientMessageId,
    text: globalChatMessages.text,
    createdAt: globalChatMessages.createdAt,
    name: globalChatMessages.authorNameAtSend,
    avatarGeneration: players.avatarGeneration,
    seekerVerified: globalChatMessages.authorSeekerVerifiedAtSend,
    canBlock: sql<boolean>`${globalChatMessages.authorWallet} <> ${viewerWallet}`,
    mentions: globalChatMessages.mentions,
    mentioned: mentionedByViewer(viewerWallet),
  }).from(globalChatMessages)
    .innerJoin(players, eq(players.wallet, globalChatMessages.authorWallet))
    .where(and(
      isNull(globalChatMessages.redactedAt), gte(globalChatMessages.createdAt, cutoff),
      ...(before === undefined ? [] : [lt(globalChatMessages.id, before)]),
      notExists(db.select({ id: globalChatBlocks.id }).from(globalChatBlocks).where(and(
        eq(globalChatBlocks.blockerWallet, viewerWallet),
        eq(globalChatBlocks.blockedWallet, globalChatMessages.authorWallet),
      ))),
    ))
    .orderBy(desc(globalChatMessages.id)).limit(limit);
  return {
    messages: rows.map(publicMessage),
    nextBefore: rows.length === limit ? rows.at(-1)!.id.toString() : null,
  };
}

export async function getChatEvents(
  db: Db, viewerWallet: string, after: bigint | undefined, limit: number, now = new Date(),
) {
  if (after === undefined) {
    const rows = await db.select({ id: sql<bigint>`coalesce(max(${globalChatEvents.id}), 0)::bigint` })
      .from(globalChatEvents);
    return { events: [] as ChatEvent[], nextAfter: rows[0]!.id.toString() };
  }
  const cutoff = new Date(now.getTime() - CHAT.visibleRetentionDays * dayMs);
  const rows = await db.select({
    eventId: globalChatEvents.id,
    kind: globalChatEvents.kind,
    eventCreatedAt: globalChatEvents.createdAt,
    messageId: globalChatMessages.id,
    clientMessageId: globalChatMessages.clientMessageId,
    text: globalChatMessages.text,
    messageCreatedAt: globalChatMessages.createdAt,
    redactedAt: globalChatMessages.redactedAt,
    name: globalChatMessages.authorNameAtSend,
    avatarGeneration: players.avatarGeneration,
    seekerVerified: globalChatMessages.authorSeekerVerifiedAtSend,
    canBlock: sql<boolean>`${globalChatMessages.authorWallet} <> ${viewerWallet}`,
    mentions: globalChatMessages.mentions,
    mentioned: mentionedByViewer(viewerWallet),
    blocked: sql<boolean>`exists (
      select 1 from ${globalChatBlocks}
      where ${globalChatBlocks.blockerWallet} = ${viewerWallet}
        and ${globalChatBlocks.blockedWallet} = ${globalChatMessages.authorWallet}
    )`,
  }).from(globalChatEvents)
    .innerJoin(globalChatMessages, eq(globalChatMessages.id, globalChatEvents.messageId))
    .innerJoin(players, eq(players.wallet, globalChatMessages.authorWallet))
    // Read the RAW cursor page, then visibility-filter in memory. Advancing by
    // the raw last event prevents an expired/redacted-only span from being
    // rescanned forever by every open client.
    .where(gt(globalChatEvents.id, after))
    .orderBy(asc(globalChatEvents.id)).limit(limit);
  const events: ChatEvent[] = rows.flatMap((row): ChatEvent[] => {
    const common = {
      id: row.eventId.toString(), createdAt: row.eventCreatedAt.toISOString(),
      messageId: row.messageId.toString(),
    };
    if (row.blocked) return [];
    if (row.kind === 'redaction') return [{ ...common, type: 'redaction' }];
    // The redaction transaction always appends its own later tombstone event.
    // Do not transform the original message event too, or a reconnect that
    // spans both rows receives duplicate redactions.
    if (row.redactedAt) return [];
    if (row.messageCreatedAt < cutoff) return [];
    return [{
      ...common, type: 'message',
      message: publicMessage({
        id: row.messageId, clientMessageId: row.clientMessageId, text: row.text,
        createdAt: row.messageCreatedAt, name: row.name,
        avatarGeneration: row.avatarGeneration, seekerVerified: row.seekerVerified,
        canBlock: row.blocked ? false : row.canBlock,
        mentions: row.mentions, mentioned: row.mentioned,
      }),
    }];
  });
  return { events, nextAfter: rows.at(-1)?.eventId.toString() ?? after.toString() };
}

export async function sendChatMessage(input: {
  db: Db; wallet: string; ip: string; secret: string; clientMessageId: string; rawText: string; now?: Date;
}): Promise<{ message: ChatMessage; replay: boolean }> {
  const text = normalizeChatCharacters(input.rawText);
  const hash = textHash(text);
  const now = input.now ?? new Date();
  const walletHash = subjectHash(input.secret, 'wallet', input.wallet);
  const ipHash = subjectHash(input.secret, 'ip', input.ip);
  return input.db.transaction(async (tx) => {
    await lockSubjects(tx, [`chat:wallet:${walletHash}`, `chat:ip:${ipHash}`]);
    const [existing] = await tx.select({ id: globalChatMessages.id, textHash: globalChatMessages.textHash })
      .from(globalChatMessages).where(and(
        eq(globalChatMessages.authorWallet, input.wallet),
        eq(globalChatMessages.clientMessageId, input.clientMessageId),
      )).limit(1);
    if (existing) {
      if (existing.textHash !== hash) {
        throw new HttpError(409, 'client message id was already used', 'CHAT_IDEMPOTENCY_CONFLICT');
      }
      const message = await currentMessage(tx, existing.id, input.wallet);
      if (!message) throw new HttpError(409, 'message was removed', 'CHAT_MESSAGE_REDACTED');
      return { message, replay: true };
    }
    const player = await playerState(tx, input.wallet);
    if (!player.name) throw new HttpError(403, 'choose a username before chatting', 'CHAT_USERNAME_REQUIRED');
    if (!await canUseDeedChat(tx, input.wallet)) {
      throw new HttpError(403, 'an active owned deed is required to chat', 'CHAT_DEED_REQUIRED');
    }
    const mute = await activeMute(tx, input.wallet, now);
    if (mute) throw new HttpError(403, 'chat account is muted', 'CHAT_MUTED');
    const mentions = await resolveChatMentions(tx, text);
    rejectChatLinks(text, mentions);
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    await spendRateBucket(tx, 'send_wallet_hour', walletHash, hour, CHAT.sendsPerHour);
    await spendRateBucket(tx, 'send_ip_hour', ipHash, hour, CHAT.sendsPerIpHour);
    const [latest] = await tx.select({ createdAt: globalChatMessages.createdAt })
      .from(globalChatMessages).where(eq(globalChatMessages.authorWallet, input.wallet))
      .orderBy(desc(globalChatMessages.id)).limit(1);
    if (latest && now.getTime() - latest.createdAt.getTime() < CHAT.sendCooldownMs) {
      throw new HttpError(429, 'wait before sending another message', 'CHAT_RATE_LIMITED');
    }
    const [created] = await tx.insert(globalChatMessages).values({
      authorWallet: input.wallet, clientMessageId: input.clientMessageId, text, textHash: hash, mentions,
      authorNameAtSend: player.name,
      authorSeekerVerifiedAtSend: player.seekerVerified,
      createdAt: now,
    }).returning({ id: globalChatMessages.id });
    await tx.insert(globalChatEvents).values({ kind: 'message', messageId: created!.id, createdAt: now });
    const message = await currentMessage(tx, created!.id, input.wallet);
    if (!message) throw new Error('inserted chat message could not be read');
    return { message, replay: false };
  });
}

export async function reportChatMessage(input: {
  db: Db; wallet: string; ip: string; secret: string; messageId: bigint; reason: ChatReportReason; now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const walletHash = subjectHash(input.secret, 'wallet', input.wallet);
  const ipHash = subjectHash(input.secret, 'ip', input.ip);
  await input.db.transaction(async (tx) => {
    // Every report/redact/resolve path takes the MESSAGE lock first. The
    // secondary wallet/IP locks are sorted with it so distributed requests
    // cannot insert unresolved evidence after a redaction commits.
    await lockSubjects(tx, [
      `chat:message:${input.messageId}`,
      `chat:report-wallet:${walletHash}`,
      `chat:report-ip:${ipHash}`,
    ]);
    const day = new Date(Math.floor(now.getTime() / dayMs) * dayMs);
    await spendRateBucket(tx, 'report_wallet_day', walletHash, day, CHAT.reportsPerDay);
    await spendRateBucket(tx, 'report_ip_day', ipHash, day, CHAT.reportsPerIpDay);
    const cutoff = new Date(now.getTime() - CHAT.visibleRetentionDays * dayMs);
    const [message] = await tx.select({
      id: globalChatMessages.id, text: globalChatMessages.text,
      textHash: globalChatMessages.textHash, authorWallet: globalChatMessages.authorWallet,
      authorNameAtSend: globalChatMessages.authorNameAtSend,
      authorSeekerVerifiedAtSend: globalChatMessages.authorSeekerVerifiedAtSend,
    }).from(globalChatMessages).where(and(
      eq(globalChatMessages.id, input.messageId), isNull(globalChatMessages.redactedAt),
      gte(globalChatMessages.createdAt, cutoff),
    )).limit(1);
    if (!message) throw new HttpError(404, 'chat message not found', 'CHAT_MESSAGE_NOT_FOUND');
    const [existing] = await tx.select({ id: globalChatReports.id }).from(globalChatReports)
      .where(and(eq(globalChatReports.messageId, input.messageId), eq(globalChatReports.reporterWallet, input.wallet)))
      .limit(1);
    if (existing) throw new HttpError(409, 'message already reported', 'CHAT_ALREADY_REPORTED');
    await tx.insert(globalChatReports).values({
      messageId: message.id, reporterWallet: input.wallet, reason: input.reason,
      evidenceText: message.text, evidenceTextHash: message.textHash,
      evidenceAuthorWallet: message.authorWallet, createdAt: now,
      evidenceAuthorName: message.authorNameAtSend,
      evidenceSeekerVerified: message.authorSeekerVerifiedAtSend,
    });
  });
}

/** Resolve a public message to its internal author without ever returning that
 * wallet to the caller. The unique pair makes retries/concurrent taps safe. */
export async function blockChatMessageAuthor(input: {
  db: Db; blockerWallet: string; secret: string; messageId: bigint; now?: Date;
}): Promise<{ block: ChatBlock; replay: boolean }> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - CHAT.visibleRetentionDays * dayMs);
  return input.db.transaction(async (tx) => {
    const walletHash = subjectHash(input.secret, 'wallet', input.blockerWallet);
    await lockSubjects(tx, [`chat:block-wallet:${walletHash}`]);
    const [target] = await tx.select({
      blockedWallet: globalChatMessages.authorWallet,
      name: players.name,
      avatarGeneration: players.avatarGeneration,
      seekerVerified: players.seekerVerified,
    }).from(globalChatMessages)
      .innerJoin(players, eq(players.wallet, globalChatMessages.authorWallet))
      .where(and(
        eq(globalChatMessages.id, input.messageId),
        isNull(globalChatMessages.redactedAt),
        gte(globalChatMessages.createdAt, cutoff),
      )).limit(1);
    if (!target) throw new HttpError(404, 'chat message not found', 'CHAT_MESSAGE_NOT_FOUND');
    if (target.blockedWallet === input.blockerWallet) {
      throw new HttpError(409, 'you cannot block yourself', 'CHAT_SELF_BLOCK');
    }
    const [existing] = await tx.select({
      id: globalChatBlocks.id, createdAt: globalChatBlocks.createdAt,
    }).from(globalChatBlocks).where(and(
      eq(globalChatBlocks.blockerWallet, input.blockerWallet),
      eq(globalChatBlocks.blockedWallet, target.blockedWallet),
    )).limit(1);
    if (existing) return { replay: true, block: publicBlock({ ...existing, ...target }) };
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    await spendRateBucket(tx, 'block_wallet_hour', walletHash, hour, CHAT.blockMutationsPerHour);
    const [inserted] = await tx.insert(globalChatBlocks).values({
      blockerWallet: input.blockerWallet,
      blockedWallet: target.blockedWallet,
      createdAt: now,
    }).onConflictDoNothing({
      target: [globalChatBlocks.blockerWallet, globalChatBlocks.blockedWallet],
    }).returning({ id: globalChatBlocks.id, createdAt: globalChatBlocks.createdAt });
    const row = inserted;
    if (!row) throw new Error('chat block conflict did not resolve to a row');
    return {
      replay: false,
      block: publicBlock({ ...row, ...target }),
    };
  });
}

/** Tap-an-author card (owner 2026-09-18: "how many bases and the highest Keep,
 * such things — do not overdo it"). Like blocking, the author is resolved from
 * the public MESSAGE id and the wallet never leaves this function.
 *
 * Every refusal is the same 404 as an unknown id: a removed or expired message
 * and an author the viewer has blocked must not be distinguishable, or the card
 * becomes an oracle for moderation state and for who the viewer blocked. Chat
 * keeps a muted author's messages visible, so a mute does not hide the card.
 *
 * The name is the one the MESSAGE was sent under — the string the viewer just
 * tapped — never players.name. The world search matches only the current name,
 * so serving it here would let anyone turn a days-old message into the new name
 * of a player who renamed to get away from harassment.
 *
 * Two bounded reads, both on existing keys: message → player → clan by primary
 * key (+ the unique block pair), then at most BASE_OWNERSHIP.maxActive slot rows
 * by the base_slots (wallet, slot) primary key. The second read selects NO base
 * id on purpose, and the strict schema rejects any field added by accident. */
export async function getChatMessageAuthorCard(
  db: Db, viewerWallet: string, messageId: bigint, now = new Date(),
): Promise<ChatAuthorCard> {
  const cutoff = new Date(now.getTime() - CHAT.visibleRetentionDays * dayMs);
  const [author] = await db.select({
    wallet: globalChatMessages.authorWallet,
    nameAtSend: globalChatMessages.authorNameAtSend,
    avatarGeneration: players.avatarGeneration,
    seekerVerified: players.seekerVerified,
    clanName: clans.name,
    clanTag: clans.tag,
  }).from(globalChatMessages)
    .innerJoin(players, eq(players.wallet, globalChatMessages.authorWallet))
    .leftJoin(clanMembers, eq(clanMembers.playerWallet, players.wallet))
    .leftJoin(clans, eq(clans.id, clanMembers.clanId))
    .where(and(
      eq(globalChatMessages.id, messageId),
      isNull(globalChatMessages.redactedAt),
      gte(globalChatMessages.createdAt, cutoff),
      notExists(db.select({ id: globalChatBlocks.id }).from(globalChatBlocks).where(and(
        eq(globalChatBlocks.blockerWallet, viewerWallet),
        eq(globalChatBlocks.blockedWallet, globalChatMessages.authorWallet),
      ))),
    )).limit(1);
  if (!author) throw new HttpError(404, 'chat message not found', 'CHAT_MESSAGE_NOT_FOUND');
  // The same ownership boundary as canUseDeedChat and the public world roster:
  // an active slot AND the base row still naming this wallet. A sold deed moves
  // bases.ownerWallet first, so a stale slot row can never count as a kingdom.
  const held = await db.select({
    keepLevel: bases.keepLevel,
    paid: sql<boolean>`${bases.landPaidAt} is not null`,
    trophies: sql<number>`coalesce(${baseProfiles.trophies}, 0)::int`,
  }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
    .where(and(
      eq(baseSlots.wallet, author.wallet), eq(baseSlots.active, true),
      eq(bases.ownerWallet, author.wallet), eq(bases.status, 'active'),
    ));
  const kingdoms = held.filter((base) => base.paid);
  // A landless player is described by the free starter base instead.
  const described = kingdoms.length > 0 ? kingdoms : held;
  return ChatAuthorCardSchema.parse({
    version: 1,
    name: author.nameAtSend,
    avatarUrl: author.avatarGeneration ? `/api/avatars/${author.avatarGeneration}.webp` : null,
    seekerVerified: author.seekerVerified,
    bases: kingdoms.length,
    highestKeepLevel: described.length > 0 ? Math.max(...described.map((base) => base.keepLevel)) : null,
    trophies: Math.max(0, ...described.map((base) => base.trophies)),
    clan: author.clanName !== null && author.clanTag !== null
      ? { name: author.clanName, tag: author.clanTag } : null,
  });
}

export async function listChatBlocks(
  db: Db, blockerWallet: string, before: bigint | undefined, limit: number,
) {
  const rows = await db.select({
    id: globalChatBlocks.id,
    createdAt: globalChatBlocks.createdAt,
    name: players.name,
    avatarGeneration: players.avatarGeneration,
    seekerVerified: players.seekerVerified,
  }).from(globalChatBlocks)
    .innerJoin(players, eq(players.wallet, globalChatBlocks.blockedWallet))
    .where(and(
      eq(globalChatBlocks.blockerWallet, blockerWallet),
      ...(before === undefined ? [] : [lt(globalChatBlocks.id, before)]),
    )).orderBy(desc(globalChatBlocks.id)).limit(limit);
  return {
    blocks: rows.map(publicBlock),
    nextBefore: rows.length === limit ? rows.at(-1)!.id.toString() : null,
  };
}

export async function unblockChatAuthor(
  db: Db, blockerWallet: string, secret: string, blockId: bigint, now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const walletHash = subjectHash(secret, 'wallet', blockerWallet);
    await lockSubjects(tx, [`chat:block-wallet:${walletHash}`]);
    const [existing] = await tx.select({ id: globalChatBlocks.id }).from(globalChatBlocks).where(and(
      eq(globalChatBlocks.id, blockId), eq(globalChatBlocks.blockerWallet, blockerWallet),
    )).limit(1);
    if (!existing) throw new HttpError(404, 'chat block not found', 'CHAT_BLOCK_NOT_FOUND');
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    await spendRateBucket(tx, 'block_wallet_hour', walletHash, hour, CHAT.blockMutationsPerHour);
    await tx.delete(globalChatBlocks).where(and(
      eq(globalChatBlocks.id, blockId), eq(globalChatBlocks.blockerWallet, blockerWallet),
    ));
  });
}

export async function redactChatMessage(
  db: Db, actorWallet: string, messageId: bigint, reason: string, now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSubjects(tx, [`chat:message:${messageId}`]);
    const [message] = await tx.select({ redactedAt: globalChatMessages.redactedAt })
      .from(globalChatMessages).where(eq(globalChatMessages.id, messageId)).limit(1);
    if (!message) throw new HttpError(404, 'chat message not found', 'CHAT_MESSAGE_NOT_FOUND');
    if (!message.redactedAt) {
      await tx.update(globalChatMessages).set({ redactedAt: now }).where(eq(globalChatMessages.id, messageId));
      await tx.insert(globalChatEvents).values({ kind: 'redaction', messageId, createdAt: now });
    }
    await tx.update(globalChatReports).set({
      resolvedAt: now, resolvedBy: actorWallet, resolution: 'redacted',
    // Redaction is the terminal, stronger disposition. The shared message lock
    // makes it safe to overwrite an earlier concurrent dismissal and ensures a
    // redacted message can never retain a misleading "dismissed" report.
    }).where(eq(globalChatReports.messageId, messageId));
    await tx.insert(globalChatModerationAudit).values({
      actorWallet, action: 'redact', messageId, reason, createdAt: now,
    });
  });
}

export async function muteChatAccount(input: {
  db: Db; actorWallet: string; targetWallet: string; mutedUntil: Date | null; reason: string; now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.db.transaction(async (tx) => {
    const [target] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, input.targetWallet)).limit(1);
    if (!target) throw new HttpError(404, 'player not found');
    await tx.insert(globalChatMutes).values({
      wallet: input.targetWallet, mutedUntil: input.mutedUntil, reason: input.reason,
      actorWallet: input.actorWallet, createdAt: now,
    }).onConflictDoUpdate({
      target: globalChatMutes.wallet,
      set: { mutedUntil: input.mutedUntil, reason: input.reason, actorWallet: input.actorWallet, createdAt: now },
    });
    await tx.insert(globalChatModerationAudit).values({
      actorWallet: input.actorWallet, action: 'mute', targetWallet: input.targetWallet,
      reason: input.reason, createdAt: now,
    });
  });
}

export async function unmuteChatAccount(
  db: Db, actorWallet: string, targetWallet: string, reason: string, now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(globalChatMutes).where(eq(globalChatMutes.wallet, targetWallet));
    await tx.insert(globalChatModerationAudit).values({
      actorWallet, action: 'unmute', targetWallet, reason, createdAt: now,
    });
  });
}

export async function listChatReports(
  db: Db, state: 'unresolved' | 'resolved', before: bigint | undefined, limit: number,
) {
  const rows = await db.select({
    id: globalChatReports.id,
    messageId: globalChatReports.messageId,
    reporterWallet: globalChatReports.reporterWallet,
    reason: globalChatReports.reason,
    evidenceText: globalChatReports.evidenceText,
    evidenceTextHash: globalChatReports.evidenceTextHash,
    evidenceAuthorWallet: globalChatReports.evidenceAuthorWallet,
    evidenceAuthorName: globalChatReports.evidenceAuthorName,
    evidenceSeekerVerified: globalChatReports.evidenceSeekerVerified,
    createdAt: globalChatReports.createdAt,
    resolvedAt: globalChatReports.resolvedAt,
    resolution: globalChatReports.resolution,
    resolverName: reportResolver.name,
    resolverAvatarGeneration: reportResolver.avatarGeneration,
    resolverSeekerVerified: reportResolver.seekerVerified,
  }).from(globalChatReports)
    .leftJoin(reportResolver, eq(reportResolver.wallet, globalChatReports.resolvedBy))
    .where(and(
      state === 'unresolved' ? isNull(globalChatReports.resolvedAt) : isNotNull(globalChatReports.resolvedAt),
      ...(before === undefined ? [] : [lt(globalChatReports.id, before)]),
    ))
    .orderBy(desc(globalChatReports.id)).limit(limit);
  return {
    reports: rows.map((row) => ({
      ...row, id: row.id.toString(), messageId: row.messageId.toString(),
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedBy: row.resolverName === null ? null : {
        name: row.resolverName,
        avatarUrl: row.resolverAvatarGeneration
          ? `/api/avatars/${row.resolverAvatarGeneration}.webp` : null,
        seekerVerified: row.resolverSeekerVerified ?? false,
      },
    })),
    nextBefore: rows.length === limit ? rows.at(-1)!.id.toString() : null,
  };
}

export async function resolveChatReport(input: {
  db: Db; actorWallet: string; reportId: bigint; reason: string; now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.db.transaction(async (tx) => {
    const [report] = await tx.select({
      id: globalChatReports.id, messageId: globalChatReports.messageId,
      resolvedAt: globalChatReports.resolvedAt,
    }).from(globalChatReports).where(eq(globalChatReports.id, input.reportId)).limit(1);
    if (!report) throw new HttpError(404, 'chat report not found', 'CHAT_REPORT_NOT_FOUND');
    await lockSubjects(tx, [`chat:message:${report.messageId}`]);
    const updated = await tx.update(globalChatReports).set({
      resolvedAt: now, resolvedBy: input.actorWallet, resolution: 'dismissed',
    }).where(and(
      eq(globalChatReports.id, input.reportId), isNull(globalChatReports.resolvedAt),
    )).returning({ id: globalChatReports.id });
    if (updated.length === 0) {
      throw new HttpError(409, 'chat report is already resolved', 'CHAT_REPORT_ALREADY_RESOLVED');
    }
    await tx.insert(globalChatModerationAudit).values({
      actorWallet: input.actorWallet, action: 'resolve_report',
      messageId: report.messageId, reason: input.reason, createdAt: now,
    });
  });
}

/** Bounded half-hourly worker body: ordinary message bodies are removed at the
 * 7-day visible cutoff; reported rows remain only for the 90-day evidence TTL. */
export async function purgeExpiredGlobalChat(db: Db, now = new Date()) {
  const evidenceCutoff = new Date(now.getTime() - CHAT.evidenceRetentionDays * dayMs);
  const deletedReports = await db.execute(sql`
    delete from global_chat_reports
    where id in (
      select id from global_chat_reports
      where created_at < ${evidenceCutoff.toISOString()}::timestamptz
      order by created_at asc, id asc limit ${CHAT.retentionBatchSize}
    ) returning id
  `);
  const visibleCutoff = new Date(now.getTime() - CHAT.visibleRetentionDays * dayMs);
  const deleted = await db.execute(sql`
    delete from global_chat_messages
    where id in (
      select m.id from global_chat_messages m
      where m.created_at < ${visibleCutoff.toISOString()}::timestamptz
        and not exists (select 1 from global_chat_reports r where r.message_id = m.id)
      order by m.created_at asc, m.id asc limit ${CHAT.retentionBatchSize}
    ) returning id
  `);
  const rateCutoff = new Date(now.getTime() - CHAT.rateBucketRetentionDays * dayMs);
  const deletedRateBuckets = await db.execute(sql`
    delete from global_chat_rate_limits
    where ctid in (
      select ctid from global_chat_rate_limits
      where window_start < ${rateCutoff.toISOString()}::timestamptz
      order by window_start asc, kind asc, subject_hash asc
      limit ${CHAT.retentionBatchSize}
    ) returning kind
  `);
  return {
    deletedReports: deletedReports.count,
    deletedMessages: deleted.count,
    deletedRateBuckets: deletedRateBuckets.count,
  };
}

/** Drain several bounded batches on the isolated queue. This is still finite
 * per run, but its daily capacity stays above the supported alpha write bound. */
export async function drainExpiredGlobalChat(db: Db, now = new Date()) {
  const total = { deletedReports: 0, deletedMessages: 0, deletedRateBuckets: 0, batches: 0 };
  for (let batch = 0; batch < CHAT.retentionMaxBatchesPerRun; batch += 1) {
    const result = await purgeExpiredGlobalChat(db, now);
    total.deletedReports += result.deletedReports;
    total.deletedMessages += result.deletedMessages;
    total.deletedRateBuckets += result.deletedRateBuckets;
    total.batches += 1;
    if (result.deletedReports < CHAT.retentionBatchSize
      && result.deletedMessages < CHAT.retentionBatchSize
      && result.deletedRateBuckets < CHAT.retentionBatchSize) break;
  }
  return total;
}
