import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  bases, baseSlots, globalChatBlocks, globalChatEvents, globalChatMessages, globalChatRateLimits,
  globalChatReports, players,
} from '../src/db/schema';
import { normalizeChatText, purgeExpiredGlobalChat } from '../src/chat/service';
import { setUsername } from '../src/game/username';
import { TEST_CONFIG, connectTestDb } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;
let bootstrap: FastifyInstance;
let adminIdentity: Identity;

type Identity = { wallet: string; cookie: string };

async function signIn(target: FastifyInstance): Promise<Identity> {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const challenge = await target.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = challenge.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verified = await target.inject({
    method: 'POST', url: '/auth/verify', payload: { wallet, signature },
  });
  return { wallet, cookie: verified.cookies.find((item) => item.name === SESSION_COOKIE)!.value };
}

async function namePlayer(identity: Identity, name: string) {
  await db.update(players).set({ name, nameKey: name.toLowerCase() })
    .where(eq(players.wallet, identity.wallet));
}

async function giveChatAuthority(identity: Identity, name: string) {
  await namePlayer(identity, name);
  const [base] = await db.insert(bases).values({
    ownerWallet: identity.wallet,
    // Paid active land remains authoritative while its best-effort deed mint is pending.
    deedAssetId: null,
    landPaidAt: new Date(),
  }).returning({ id: bases.id });
  await db.insert(baseSlots).values({ wallet: identity.wallet, slot: 1, baseId: base!.id });
  return base!.id;
}

beforeAll(async () => {
  bootstrap = await buildApp(TEST_CONFIG, db);
  await bootstrap.ready();
  adminIdentity = await signIn(bootstrap);
  await bootstrap.close();
  app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [adminIdentity.wallet] }, db);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  await conn.sql.end();
});

describe('global chat text boundary', () => {
  it('normalizes NFC/line endings and rejects links, markup and invisible controls', () => {
    expect(normalizeChatText('  cafe\u0301\r\nhello  ')).toBe('café\nhello');
    expect(normalizeChatText('Family 👨‍👩‍👧‍👦')).toBe('Family 👨‍👩‍👧‍👦');
    for (const bad of ['https://example.com', '<script>alert(1)</script>', 'ab\u200bcd', 'ab\u200dcd', 'ab\u202ecd']) {
      expect(() => normalizeChatText(bad)).toThrowError(/unsupported content/);
    }
  });
});

describe('global chat HTTP contract', () => {
  it('is authenticated, deed/name gated, idempotent, cursor-safe and moderated', async () => {
    expect((await app.inject({ method: 'GET', url: '/chat/status' })).statusCode).toBe(401);
    const oversized = await app.inject({
      method: 'POST', url: '/chat/messages',
      payload: { clientMessageId: randomUUID(), text: 'a'.repeat(4_000) },
    });
    expect(oversized.statusCode).toBe(413);

    const user = await signIn(app);
    const other = await signIn(app);
    const admin = adminIdentity;
    const unnamed = await app.inject({
      method: 'GET', url: '/chat/status', cookies: { [SESSION_COOKIE]: user.cookie },
    });
    expect(unnamed.json()).toMatchObject({ canSend: false, sendBlockedReason: 'USERNAME_REQUIRED' });
    await namePlayer(user, `Chat${randomUUID().slice(0, 8)}`);
    const deedless = await app.inject({
      method: 'GET', url: '/chat/status', cookies: { [SESSION_COOKIE]: user.cookie },
    });
    expect(deedless.json()).toMatchObject({ canSend: false, sendBlockedReason: 'DEED_REQUIRED' });
    await giveChatAuthority(user, `Chat${randomUUID().slice(0, 8)}`);
    await giveChatAuthority(other, `Chat${randomUUID().slice(0, 8)}`);

    const initial = await app.inject({
      method: 'GET', url: '/chat/status', cookies: { [SESSION_COOKIE]: user.cookie },
    });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.headers['cache-control']).toBe('private, no-store');
    expect(initial.json()).toMatchObject({ enabled: true, canSend: true });
    const cursor = (initial.json() as { latestEventId: string }).latestEventId;

    const clientMessageId = randomUUID();
    const first = await app.inject({
      method: 'POST', url: '/chat/messages', cookies: { [SESSION_COOKIE]: user.cookie },
      payload: { clientMessageId, text: 'Hello kingdom' },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({
      clientMessageId, text: 'Hello kingdom',
      author: { name: expect.stringMatching(/^Chat/), avatarUrl: null },
    });
    expect(JSON.stringify(first.json())).not.toContain(user.wallet);

    const replay = await app.inject({
      method: 'POST', url: '/chat/messages', cookies: { [SESSION_COOKIE]: user.cookie },
      payload: { clientMessageId, text: 'Hello kingdom' },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const conflict = await app.inject({
      method: 'POST', url: '/chat/messages', cookies: { [SESSION_COOKIE]: user.cookie },
      payload: { clientMessageId, text: 'Different text' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'CHAT_IDEMPOTENCY_CONFLICT' } });

    const events = await app.inject({
      method: 'GET', url: `/chat/events?after=${cursor}`,
      cookies: { [SESSION_COOKIE]: other.cookie },
    });
    expect(events.statusCode, events.body).toBe(200);
    expect(events.json()).toMatchObject({
      events: [expect.objectContaining({ type: 'message', messageId: first.json().id })],
    });

    const messageId = (first.json() as { id: string }).id;
    const reported = await app.inject({
      method: 'POST', url: `/chat/messages/${messageId}/report`,
      cookies: { [SESSION_COOKIE]: other.cookie }, payload: { reason: 'spam' },
    });
    expect(reported.statusCode, reported.body).toBe(204);
    const [evidence] = await db.select().from(globalChatReports)
      .where(eq(globalChatReports.messageId, BigInt(messageId)));
    expect(evidence).toMatchObject({ evidenceText: 'Hello kingdom' });
    const forbiddenAdmin = await app.inject({
      method: 'GET', url: '/admin/chat/reports', cookies: { [SESSION_COOKIE]: other.cookie },
    });
    expect(forbiddenAdmin.statusCode).toBe(404);

    const redacted = await app.inject({
      method: 'POST', url: `/admin/chat/messages/${messageId}/redact`,
      cookies: { [SESSION_COOKIE]: admin.cookie }, payload: { reason: 'spam report upheld' },
    });
    expect(redacted.statusCode, redacted.body).toBe(204);
    const [preservedEvidence] = await db.select().from(globalChatReports)
      .where(eq(globalChatReports.messageId, BigInt(messageId)));
    expect(preservedEvidence).toMatchObject({ evidenceText: 'Hello kingdom' });
    const history = await app.inject({
      method: 'GET', url: '/chat/messages', cookies: { [SESSION_COOKIE]: other.cookie },
    });
    expect((history.json() as { messages: Array<{ id: string }> }).messages)
      .not.toContainEqual(expect.objectContaining({ id: messageId }));
    const redactionEvents = await app.inject({
      method: 'GET', url: `/chat/events?after=${(events.json() as { nextAfter: string }).nextAfter}`,
      cookies: { [SESSION_COOKIE]: other.cookie },
    });
    expect(redactionEvents.json()).toMatchObject({
      events: [expect.objectContaining({ type: 'redaction', messageId })],
    });

    const permanentMute = await app.inject({
      method: 'POST', url: '/admin/chat/mutes', cookies: { [SESSION_COOKIE]: admin.cookie },
      payload: { wallet: other.wallet, mutedUntil: null, reason: 'moderation test' },
    });
    expect(permanentMute.statusCode, permanentMute.body).toBe(204);
    const mutedStatus = await app.inject({
      method: 'GET', url: '/chat/status', cookies: { [SESSION_COOKIE]: other.cookie },
    });
    expect(mutedStatus.json()).toMatchObject({ canSend: false, sendBlockedReason: 'MUTED', mutedUntil: null });

    // A deed transfer removes send authority immediately; no session refresh is needed.
    const [userBase] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, user.wallet)).limit(1);
    await db.update(bases).set({ ownerWallet: other.wallet }).where(eq(bases.id, userBase!.id));
    const transferred = await app.inject({
      method: 'GET', url: '/chat/status', cookies: { [SESSION_COOKIE]: user.cookie },
    });
    expect(transferred.json()).toMatchObject({ canSend: false, sendBlockedReason: 'DEED_REQUIRED' });
  });

  it('blocks by message without exposing wallets, snapshots identity, resolves reports and obeys kill switch', async () => {
    const author = await signIn(app);
    const blocker = await signIn(app);
    const stranger = await signIn(app);
    const authorName = `A${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await giveChatAuthority(author, authorName);
    await giveChatAuthority(blocker, `B${randomUUID().replaceAll('-', '').slice(0, 10)}`);
    await giveChatAuthority(stranger, `C${randomUUID().replaceAll('-', '').slice(0, 10)}`);
    const before = await app.inject({
      method: 'GET', url: '/chat/status', cookies: { [SESSION_COOKIE]: blocker.cookie },
    });
    const after = (before.json() as { latestEventId: string }).latestEventId;
    const clientMessageId = randomUUID();
    const sent = await app.inject({
      method: 'POST', url: '/chat/messages', cookies: { [SESSION_COOKIE]: author.cookie },
      payload: { clientMessageId, text: 'Blockable history' },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ canBlock: false, author: { name: authorName } });
    const messageId = (sent.json() as { id: string }).id;
    const visible = await app.inject({
      method: 'GET', url: '/chat/messages', cookies: { [SESSION_COOKIE]: blocker.cookie },
    });
    expect(visible.json()).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ id: messageId, canBlock: true })]),
    });
    const live = await app.inject({
      method: 'GET', url: `/chat/events?after=${after}`,
      cookies: { [SESSION_COOKIE]: blocker.cookie },
    });
    expect(live.json()).toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({
        message: expect.objectContaining({ id: messageId, canBlock: true }),
      })]),
    });

    const renamed = `R${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await db.update(players).set({
      name: renamed, nameKey: renamed.toLowerCase(), seekerVerified: true,
    }).where(eq(players.wallet, author.wallet));
    const replay = await app.inject({
      method: 'POST', url: '/chat/messages', cookies: { [SESSION_COOKIE]: author.cookie },
      payload: { clientMessageId, text: 'Blockable history' },
    });
    expect(replay.json()).toMatchObject({
      canBlock: false, author: { name: authorName, seekerVerified: false },
    });

    const self = await app.inject({
      method: 'POST', url: `/chat/messages/${messageId}/block`,
      cookies: { [SESSION_COOKIE]: author.cookie }, payload: {},
    });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ error: { code: 'CHAT_SELF_BLOCK' } });
    const blocked = await app.inject({
      method: 'POST', url: `/chat/messages/${messageId}/block`,
      cookies: { [SESSION_COOKIE]: blocker.cookie }, payload: {},
    });
    expect(blocked.statusCode, blocked.body).toBe(201);
    expect(blocked.json()).toMatchObject({ block: { author: { name: renamed, seekerVerified: true } } });
    expect(JSON.stringify(blocked.json())).not.toContain(author.wallet);
    const blockId = (blocked.json() as { block: { id: string } }).block.id;
    const replayBlock = await app.inject({
      method: 'POST', url: `/chat/messages/${messageId}/block`,
      cookies: { [SESSION_COOKIE]: blocker.cookie }, payload: {},
    });
    expect(replayBlock.statusCode).toBe(200);
    expect(replayBlock.json()).toEqual(blocked.json());
    const hidden = await app.inject({
      method: 'GET', url: '/chat/messages', cookies: { [SESSION_COOKIE]: blocker.cookie },
    });
    expect((hidden.json() as { messages: Array<{ id: string }> }).messages)
      .not.toContainEqual(expect.objectContaining({ id: messageId }));
    const blocks = await app.inject({
      method: 'GET', url: '/chat/blocks', cookies: { [SESSION_COOKIE]: blocker.cookie },
    });
    expect(blocks.json()).toMatchObject({
      blocks: [expect.objectContaining({
        id: blockId, author: expect.objectContaining({ name: renamed }),
      })],
    });
    expect(JSON.stringify(blocks.json())).not.toContain(author.wallet);
    const foreignUnblock = await app.inject({
      method: 'DELETE', url: `/chat/blocks/${blockId}`,
      cookies: { [SESSION_COOKIE]: stranger.cookie },
    });
    expect(foreignUnblock.statusCode).toBe(404);
    const unblocked = await app.inject({
      method: 'DELETE', url: `/chat/blocks/${blockId}`,
      cookies: { [SESSION_COOKIE]: blocker.cookie },
    });
    expect(unblocked.statusCode, unblocked.body).toBe(204);
    expect(await db.select().from(globalChatBlocks).where(eq(globalChatBlocks.id, BigInt(blockId))))
      .toHaveLength(0);
    const restored = await app.inject({
      method: 'GET', url: '/chat/messages', cookies: { [SESSION_COOKIE]: blocker.cookie },
    });
    expect(restored.json()).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({
        id: messageId, canBlock: true,
        author: expect.objectContaining({ name: authorName, seekerVerified: false }),
      })]),
    });

    const report = await app.inject({
      method: 'POST', url: `/chat/messages/${messageId}/report`,
      cookies: { [SESSION_COOKIE]: blocker.cookie }, payload: { reason: 'other' },
    });
    expect(report.statusCode, report.body).toBe(204);
    const [evidence] = await db.select().from(globalChatReports)
      .where(eq(globalChatReports.messageId, BigInt(messageId)));
    expect(evidence).toMatchObject({
      evidenceAuthorName: authorName, evidenceSeekerVerified: false,
    });
    const unresolved = await app.inject({
      method: 'GET', url: '/admin/chat/reports',
      cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
    });
    const reportDto = (unresolved.json() as { reports: Array<{ id: string; messageId: string }> })
      .reports.find((row) => row.messageId === messageId)!;
    expect(reportDto).toBeDefined();
    const resolved = await app.inject({
      method: 'POST', url: `/admin/chat/reports/${reportDto.id}/resolve`,
      cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
      payload: { resolution: 'dismissed', reason: 'reviewed' },
    });
    expect(resolved.statusCode, resolved.body).toBe(204);
    const resolvedList = await app.inject({
      method: 'GET', url: '/admin/chat/reports?state=resolved',
      cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
    });
    expect(resolvedList.json()).toMatchObject({
      reports: expect.arrayContaining([expect.objectContaining({
        id: reportDto.id, resolution: 'dismissed', resolvedAt: expect.any(String),
        resolvedBy: expect.objectContaining({ name: expect.any(String) }),
      })]),
    });

    // Redaction is the terminal disposition even when a moderator dismissal
    // races it. The message-scoped advisory lock prevents either transaction
    // from leaving a report unresolved or labelled dismissed after takedown.
    const racedMessage = await app.inject({
      method: 'POST', url: '/chat/messages', cookies: { [SESSION_COOKIE]: stranger.cookie },
      payload: { clientMessageId: randomUUID(), text: 'Concurrent moderation target' },
    });
    expect(racedMessage.statusCode, racedMessage.body).toBe(201);
    const racedMessageId = (racedMessage.json() as { id: string }).id;
    const racedReport = await app.inject({
      method: 'POST', url: `/chat/messages/${racedMessageId}/report`,
      cookies: { [SESSION_COOKIE]: blocker.cookie }, payload: { reason: 'spam' },
    });
    expect(racedReport.statusCode, racedReport.body).toBe(204);
    const [racedReportRow] = await db.select({ id: globalChatReports.id })
      .from(globalChatReports).where(eq(globalChatReports.messageId, BigInt(racedMessageId)));
    const [dismissRace, redactRace] = await Promise.all([
      app.inject({
        method: 'POST', url: `/admin/chat/reports/${racedReportRow!.id}/resolve`,
        cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
        payload: { resolution: 'dismissed', reason: 'concurrent review' },
      }),
      app.inject({
        method: 'POST', url: `/admin/chat/messages/${racedMessageId}/redact`,
        cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
        payload: { reason: 'concurrent takedown' },
      }),
    ]);
    expect([204, 409]).toContain(dismissRace.statusCode);
    expect(redactRace.statusCode, redactRace.body).toBe(204);
    const [raceOutcome] = await db.select({
      resolvedAt: globalChatReports.resolvedAt, resolution: globalChatReports.resolution,
    }).from(globalChatReports).where(eq(globalChatReports.id, racedReportRow!.id));
    expect(raceOutcome).toMatchObject({ resolvedAt: expect.any(Date), resolution: 'redacted' });

    // Report admission takes the same message lock, so it cannot insert a new
    // unresolved evidence row after a takedown has committed.
    const reportRaceMessage = await app.inject({
      method: 'POST', url: '/chat/messages', cookies: { [SESSION_COOKIE]: blocker.cookie },
      payload: { clientMessageId: randomUUID(), text: 'Concurrent report target' },
    });
    expect(reportRaceMessage.statusCode, reportRaceMessage.body).toBe(201);
    const reportRaceMessageId = (reportRaceMessage.json() as { id: string }).id;
    const [reportRace, takedownRace] = await Promise.all([
      app.inject({
        method: 'POST', url: `/chat/messages/${reportRaceMessageId}/report`,
        cookies: { [SESSION_COOKIE]: stranger.cookie }, payload: { reason: 'other' },
      }),
      app.inject({
        method: 'POST', url: `/admin/chat/messages/${reportRaceMessageId}/redact`,
        cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
        payload: { reason: 'report admission race' },
      }),
    ]);
    expect([204, 404]).toContain(reportRace.statusCode);
    expect(takedownRace.statusCode, takedownRace.body).toBe(204);
    const reportRaceRows = await db.select({
      resolvedAt: globalChatReports.resolvedAt, resolution: globalChatReports.resolution,
    }).from(globalChatReports).where(eq(globalChatReports.messageId, BigInt(reportRaceMessageId)));
    expect(reportRaceRows.every((row) => row.resolvedAt !== null && row.resolution === 'redacted')).toBe(true);

    try {
      const disabled = await app.inject({
        method: 'PUT', url: '/admin/chat/status',
        cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
        payload: { enabled: false, reason: 'incident drill' },
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(disabled.json()).toEqual({ enabled: false });
      const status = await app.inject({
        method: 'GET', url: '/chat/status', cookies: { [SESSION_COOKIE]: blocker.cookie },
      });
      expect(status.json()).toMatchObject({
        enabled: false, canSend: false, sendBlockedReason: 'DISABLED', mutedUntil: null,
      });
      for (const url of ['/chat/messages', '/chat/events?after=0', '/chat/blocks']) {
        const response = await app.inject({
          method: 'GET', url, cookies: { [SESSION_COOKIE]: blocker.cookie },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ error: { code: 'CHAT_DISABLED' } });
      }
      const moderationStillWorks = await app.inject({
        method: 'GET', url: '/admin/chat/reports',
        cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
      });
      expect(moderationStillWorks.statusCode).toBe(200);
    } finally {
      await app.inject({
        method: 'PUT', url: '/admin/chat/status',
        cookies: { [SESSION_COOKIE]: adminIdentity.cookie },
        payload: { enabled: true, reason: 'incident drill complete' },
      });
    }
  });

  it('answers a message id above the signed 64-bit range like any unknown message, never a 500', async () => {
    const viewer = await signIn(app);
    // Every message-id route shares one validator. PostgreSQL cannot bind a
    // decimal above bigint, so these used to surface as an opaque 500: a broken
    // 404 contract, and a refusal that differed by nothing but the id's size.
    const routes = [
      { path: (id: string) => `/chat/messages/${id}/report`, who: viewer, payload: { reason: 'spam' } },
      { path: (id: string) => `/chat/messages/${id}/block`, who: viewer, payload: {} },
      { path: (id: string) => `/admin/chat/messages/${id}/redact`, who: adminIdentity, payload: { reason: 'range' } },
    ];
    for (const route of routes) {
      const call = (id: string) => app.inject({
        method: 'POST', url: route.path(id), cookies: { [SESSION_COOKIE]: route.who.cookie }, payload: route.payload,
      });
      const unknown = await call('999999999999999');
      expect(unknown.statusCode, unknown.body).toBe(404);
      expect(unknown.json()).toMatchObject({ error: { code: 'CHAT_MESSAGE_NOT_FOUND' } });
      for (const id of ['9223372036854775808', '1'.padEnd(40, '0')]) {
        const res = await call(id);
        expect(res.statusCode, `${route.path(id)}: ${res.body}`).toBe(404);
        expect(res.body).toBe(unknown.body);
      }
    }
    // The history cursor is the same validator: "before an impossible id" is
    // simply the newest page.
    const page = await app.inject({
      method: 'GET', url: '/chat/messages?before=9223372036854775808', cookies: { [SESSION_COOKIE]: viewer.cookie },
    });
    expect(page.statusCode, page.body).toBe(200);
  });

  it('deletes ordinary chat after 7 days but preserves reported evidence for 90 days', async () => {
    const subject = randomUUID().replaceAll('-', '');
    const now = new Date();
    const currentWindow = now;
    await db.insert(globalChatRateLimits).values([
      { kind: 'test', subjectHash: `${subject}-current`, windowStart: currentWindow, count: 1 },
      { kind: 'test', subjectHash: `${subject}-expired`, windowStart: new Date('2020-01-01'), count: 1 },
    ]);
    const oldAt = new Date(now.getTime() - 30 * 86_400_000);
    const ancientAt = new Date(now.getTime() - 100 * 86_400_000);
    const [oldUnreported, oldReported, ancientReported] = await db.insert(globalChatMessages).values([
      {
        authorWallet: adminIdentity.wallet, clientMessageId: randomUUID(), text: 'old ordinary',
        textHash: '1'.repeat(64), authorNameAtSend: 'Admin',
        authorSeekerVerifiedAtSend: false, createdAt: oldAt,
      },
      {
        authorWallet: adminIdentity.wallet, clientMessageId: randomUUID(), text: 'old reported',
        textHash: '2'.repeat(64), authorNameAtSend: 'Admin',
        authorSeekerVerifiedAtSend: false, createdAt: oldAt,
      },
      {
        authorWallet: adminIdentity.wallet, clientMessageId: randomUUID(), text: 'ancient reported',
        textHash: '3'.repeat(64), authorNameAtSend: 'Admin',
        authorSeekerVerifiedAtSend: false, createdAt: ancientAt,
      },
    ]).returning({ id: globalChatMessages.id });
    await db.insert(globalChatReports).values([
      {
        messageId: oldReported!.id, reporterWallet: adminIdentity.wallet, reason: 'spam',
        evidenceText: 'old reported', evidenceTextHash: '2'.repeat(64),
        evidenceAuthorWallet: adminIdentity.wallet, evidenceAuthorName: 'Admin',
        evidenceSeekerVerified: false, createdAt: oldAt,
      },
      {
        messageId: ancientReported!.id, reporterWallet: adminIdentity.wallet, reason: 'spam',
        evidenceText: 'ancient reported', evidenceTextHash: '3'.repeat(64),
        evidenceAuthorWallet: adminIdentity.wallet, evidenceAuthorName: 'Admin',
        evidenceSeekerVerified: false, createdAt: ancientAt,
      },
    ]);
    const current = await db.select({ id: globalChatMessages.id }).from(globalChatMessages)
      .orderBy(globalChatMessages.id).limit(1);
    const result = await purgeExpiredGlobalChat(db, now);
    expect(result.deletedMessages).toBe(2);
    expect(result.deletedReports).toBe(1);
    expect(result.deletedRateBuckets).toBe(1);
    expect(await db.select({ id: globalChatMessages.id }).from(globalChatMessages)
      .where(eq(globalChatMessages.id, current[0]!.id))).toHaveLength(1);
    expect(await db.select({ id: globalChatMessages.id }).from(globalChatMessages)
      .where(eq(globalChatMessages.id, oldUnreported!.id))).toHaveLength(0);
    expect(await db.select({ id: globalChatMessages.id }).from(globalChatMessages)
      .where(eq(globalChatMessages.id, oldReported!.id))).toHaveLength(1);
    expect(await db.select({ id: globalChatReports.id }).from(globalChatReports)
      .where(eq(globalChatReports.messageId, oldReported!.id))).toHaveLength(1);
    expect(await db.select({ id: globalChatMessages.id }).from(globalChatMessages)
      .where(eq(globalChatMessages.id, ancientReported!.id))).toHaveLength(0);
    expect(await db.select().from(globalChatRateLimits)
      .where(eq(globalChatRateLimits.subjectHash, `${subject}-current`))).toHaveLength(1);
    expect(await db.select().from(globalChatRateLimits)
      .where(eq(globalChatRateLimits.subjectHash, `${subject}-expired`))).toHaveLength(0);
  });
});

describe('verified send-time chat mentions', () => {
  it('binds canonical standalone names, preserves UUID replay after rename, and keeps identities private', async () => {
    const author = await signIn(app), recipient = await signIn(app), stranger = await signIn(app);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const authorName = `A${suffix}`, recipientName = `m${suffix}.skr`;
    await giveChatAuthority(author, authorName);
    await namePlayer(recipient, recipientName);
    const before = await app.inject({ method: 'GET', url: '/chat/status', cookies: { [SESSION_COOKIE]: recipient.cookie } });
    const cursor = before.json().latestEventId;
    const clientMessageId = randomUUID();
    const raw = `  cafe\u0301 👋 @${recipientName.toUpperCase()}, @${authorName}!  `;
    const normalized = raw.normalize('NFC').trim();
    const send = () => app.inject({ method: 'POST', url: '/chat/messages',
      cookies: { [SESSION_COOKIE]: author.cookie }, payload: { clientMessageId, text: raw,
        mentions: [{ start: 0, end: 1, wallet: stranger.wallet }], mentioned: true } });
    const first = await send();
    expect(first.statusCode, first.body).toBe(201);
    const message = first.json();
    expect(message).toMatchObject({ text: normalized, mentioned: false }); // self mention never pings
    expect(message.mentions).toEqual([
      { start: normalized.indexOf('@'), end: normalized.indexOf('@') + recipientName.length + 1 },
      { start: normalized.lastIndexOf('@'), end: normalized.lastIndexOf('@') + authorName.length + 1 },
    ]);
    for (const viewer of [author, recipient, stranger]) {
      const history = await app.inject({ method: 'GET', url: '/chat/messages', cookies: { [SESSION_COOKIE]: viewer.cookie } });
      const row = history.json().messages.find((m: { id: string }) => m.id === message.id);
      expect(row.mentioned).toBe(viewer === recipient);
      expect(JSON.stringify(row)).not.toContain(recipient.wallet);
      expect(JSON.stringify(row)).not.toContain(stranger.wallet);
      const events = await app.inject({ method: 'GET', url: `/chat/events?after=${cursor}`, cookies: { [SESSION_COOKIE]: viewer.cookie } });
      expect(events.json().events.find((e: { messageId: string }) => e.messageId === message.id)?.message.mentioned)
        .toBe(viewer === recipient);
    }
    await namePlayer(recipient, `N${suffix}`);
    await namePlayer(stranger, recipientName); // same name now belongs to somebody else
    const replay = await send();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(message);
    for (const viewer of [recipient, stranger]) {
      const events = await app.inject({ method: 'GET', url: `/chat/events?after=${cursor}`, cookies: { [SESSION_COOKIE]: viewer.cookie } });
      expect(events.json().events.find((e: { messageId: string }) => e.messageId === message.id)?.message.mentioned)
        .toBe(viewer === recipient);
    }
    await app.inject({ method: 'POST', url: `/chat/messages/${message.id}/block`, cookies: { [SESSION_COOKIE]: recipient.cookie }, payload: {} });
    const blocked = await app.inject({ method: 'GET', url: `/chat/events?after=${cursor}`, cookies: { [SESSION_COOKIE]: recipient.cookie } });
    expect(blocked.json().events.some((e: { messageId: string }) => e.messageId === message.id)).toBe(false);
    const redacted = await app.inject({ method: 'POST', url: `/admin/chat/messages/${message.id}/redact`,
      cookies: { [SESSION_COOKIE]: adminIdentity.cookie }, payload: { reason: 'mention regression' } });
    expect(redacted.statusCode, redacted.body).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/chat/events?after=${cursor}`, cookies: { [SESSION_COOKIE]: stranger.cookie } });
    expect(after.json().events.filter((e: { messageId: string }) => e.messageId === message.id))
      .toEqual([expect.objectContaining({ type: 'redaction', messageId: message.id })]);
    expect((await send()).json()).toMatchObject({ error: { code: 'CHAT_MESSAGE_REDACTED' } });
  });

  it('never exempts email, URL, port, path, or an unknown domain around a verified name', async () => {
    const author = await signIn(app), recipient = await signIn(app);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const name = `m${suffix}.skr`;
    await giveChatAuthority(author, `A${suffix}`);
    await namePlayer(recipient, name);
    for (const text of [`user@${name}`, `https://@${name}`, `@${name}/path`, `@${name}:443`,
      `@${name}?x=1`, `@${name}#anchor`, `@${name}.evil`, '@unknown-domain.skr']) {
      const result = await app.inject({ method: 'POST', url: '/chat/messages',
        cookies: { [SESSION_COOKIE]: author.cookie }, payload: { clientMessageId: randomUUID(), text } });
      expect(result.statusCode, text).toBe(400);
      expect(result.json()).toMatchObject({ error: { code: 'CHAT_TEXT_INVALID' } });
    }
    const valid = await app.inject({ method: 'POST', url: '/chat/messages',
      cookies: { [SESSION_COOKIE]: author.cookie },
      payload: { clientMessageId: randomUUID(), text: `(@${name}). @${name}: hello` } });
    expect(valid.statusCode, valid.body).toBe(201);
    expect(valid.json().mentions).toHaveLength(2);
  });

  it('binds NFKC-equivalent spelling while keeping original UTF-16 offsets', async () => {
    const author = await signIn(app), recipient = await signIn(app);
    const name = `m${randomUUID().replaceAll('-', '').slice(0, 8)}.skr`;
    const wide = [...name].map((char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0)).join('');
    await giveChatAuthority(author, `A${randomUUID().slice(0, 8)}`);
    // Exercise the real accepted registration fold, rather than writing a
    // non-canonical fixture directly to the identity table.
    expect((await setUsername(db, recipient.wallet, wide, { source: 'skr' })).name).toBe(name);
    const text = `👋 @${wide} @不存在`;
    const result = await app.inject({ method: 'POST', url: '/chat/messages',
      cookies: { [SESSION_COOKIE]: author.cookie }, payload: { clientMessageId: randomUUID(), text } });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json()).toMatchObject({ text, mentions: [{ start: 3, end: 4 + wide.length }] });
    const history = await app.inject({ method: 'GET', url: '/chat/messages',
      cookies: { [SESSION_COOKIE]: recipient.cookie } });
    expect(history.json().messages.find((row: { id: string }) => row.id === result.json().id).mentioned).toBe(true);
  });

  it('allows simultaneous cross-mentions without recipient lock cycles', async () => {
    const first = await signIn(app), second = await signIn(app);
    const suffix = randomUUID().slice(0, 8);
    const firstName = `A${suffix}`, secondName = `B${suffix}`;
    await giveChatAuthority(first, firstName);
    await giveChatAuthority(second, secondName);
    // Distinct IPs ensure the shared-IP rate lock cannot serialize this race.
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/chat/messages', remoteAddress: '192.0.2.11',
        cookies: { [SESSION_COOKIE]: first.cookie },
        payload: { clientMessageId: randomUUID(), text: `@${secondName}` } }),
      app.inject({ method: 'POST', url: '/chat/messages', remoteAddress: '192.0.2.12',
        cookies: { [SESSION_COOKIE]: second.cookie },
        payload: { clientMessageId: randomUUID(), text: `@${firstName}` } }),
    ]);
    for (const result of results) expect(result.statusCode, result.body).toBe(201);
    for (const [viewer, message] of [[second, results[0]!], [first, results[1]!]] as const) {
      const history = await app.inject({ method: 'GET', url: '/chat/messages',
        cookies: { [SESSION_COOKIE]: viewer.cookie } });
      expect(history.json().messages.find((row: { id: string }) => row.id === message.json().id).mentioned).toBe(true);
    }
  });

  it('commits one recipient binding and one event for simultaneous same-UUID sends', async () => {
    const author = await signIn(app), recipient = await signIn(app);
    const suffix = randomUUID().slice(0, 8), name = `m${suffix}.skr`;
    await giveChatAuthority(author, `A${suffix}`);
    await namePlayer(recipient, name);
    const clientMessageId = randomUUID();
    const send = () => app.inject({ method: 'POST', url: '/chat/messages',
      cookies: { [SESSION_COOKIE]: author.cookie }, payload: { clientMessageId, text: `@${name}` } });
    const results = await Promise.all([send(), send()]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 201]);
    expect(results[0]!.json()).toEqual(results[1]!.json());
    const rows = await db.select().from(globalChatMessages)
      .where(eq(globalChatMessages.clientMessageId, clientMessageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mentions).toEqual([{ start: 0, end: name.length + 1, wallet: recipient.wallet }]);
    expect(await db.select().from(globalChatEvents)
      .where(eq(globalChatEvents.messageId, rows[0]!.id))).toHaveLength(1);
  });
});
