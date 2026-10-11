/** Tap-an-author card (owner 2026-09-18). The card exists to show "how many
 * kingdoms and the highest Keep" WITHOUT turning global chat into a way to
 * identify, locate or time an attack on the person who spoke. These tests pin
 * the disclosure boundary and the ownership notion, not just the happy path. */
import { createHash, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { CHAT } from '@shardkeep/shared';
import { ChatAuthorCardSchema } from '@shardkeep/shared/chatAuthorCard';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  CHAT_AUTHOR_CARD_RATE_LIMIT, CHAT_READ_RATE_LIMIT, registerChatRoutes,
} from '../src/chat/routes';
import { setGlobalChatEnabled } from '../src/chat/service';
import {
  baseProfiles, bases, baseSlots, clanMembers, clans, globalChatBlocks, globalChatMessages, players,
} from '../src/db/schema';
import { HttpError } from '../src/lib/errors';
import { TEST_CONFIG, connectTestDb } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;

type Identity = { wallet: string; cookie: string; name: string };

async function signIn(): Promise<Identity> {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const challenge = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = challenge.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  const name = `P${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await db.update(players).set({ name, nameKey: name.toLowerCase() }).where(eq(players.wallet, wallet));
  return { wallet, name, cookie: verified.cookies.find((item) => item.name === SESSION_COOKIE)!.value };
}

async function addBase(owner: Identity, input: {
  slot: number | null; keepLevel: number; paid: boolean; trophies?: number;
}): Promise<string> {
  const [base] = await db.insert(bases).values({
    ownerWallet: owner.wallet, keepLevel: input.keepLevel,
    status: input.slot === null ? 'inactive' : 'active',
    landPaidAt: input.paid ? new Date() : null,
  }).returning({ id: bases.id });
  if (input.slot !== null) {
    await db.insert(baseSlots).values({ wallet: owner.wallet, slot: input.slot, baseId: base!.id });
  }
  if (input.trophies !== undefined) {
    await db.insert(baseProfiles).values({ baseId: base!.id, trophies: input.trophies });
  }
  return base!.id;
}

/** A stored message is all the card needs; the send path (deed gate, cooldown,
 * hourly buckets) is covered by chat.test.ts and would only add shared-DB
 * rate-bucket coupling here. */
async function say(author: Identity, createdAt = new Date()): Promise<string> {
  const text = `card ${randomUUID()}`;
  const [message] = await db.insert(globalChatMessages).values({
    authorWallet: author.wallet, clientMessageId: randomUUID(), text,
    textHash: createHash('sha256').update(text).digest('hex'),
    authorNameAtSend: author.name, authorSeekerVerifiedAtSend: false, createdAt,
  }).returning({ id: globalChatMessages.id });
  return message!.id.toString();
}

const card = (viewer: Identity, messageId: string) => app.inject({
  method: 'GET', url: `/chat/messages/${messageId}/author`, cookies: { [SESSION_COOKIE]: viewer.cookie },
});

beforeAll(async () => {
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  await conn.sql.end();
});

describe('chat author card disclosure boundary', () => {
  it('is an authenticated chat read with a decimal message id', async () => {
    const author = await signIn();
    const messageId = await say(author);
    const anonymous = await app.inject({ method: 'GET', url: `/chat/messages/${messageId}/author` });
    const status = await app.inject({ method: 'GET', url: '/chat/status' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual(status.json());
    // The card is addressed by message only: a wallet in the path is a malformed
    // request, so the route can never become a wallet -> profile lookup.
    expect((await card(author, author.wallet)).statusCode).toBe(400);
  });

  it('describes a multi-kingdom owner by count and highest Keep, never by wallet, base id or place', async () => {
    const owner = await signIn();
    const viewer = await signIn();
    const baseIds = [
      await addBase(owner, { slot: 1, keepLevel: 3, paid: true, trophies: 120 }),
      await addBase(owner, { slot: 2, keepLevel: 9, paid: true, trophies: 340 }),
      // A sixth-deed style INACTIVE holding is not on the public world map, so
      // its higher Keep must not be advertised either.
      await addBase(owner, { slot: null, keepLevel: 15, paid: true, trophies: 900 }),
    ];
    await db.update(players).set({ seekerVerified: true }).where(eq(players.wallet, owner.wallet));
    const clanName = `Clan ${randomUUID().slice(0, 8)}`;
    const clanTag = randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase();
    const [clan] = await db.insert(clans).values({ name: clanName, tag: clanTag, leaderWallet: owner.wallet })
      .returning({ id: clans.id });
    await db.insert(clanMembers).values({ playerWallet: owner.wallet, clanId: clan!.id });
    const messageId = await say(owner);

    const res = await card(viewer, messageId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toEqual({
      version: 1, name: owner.name, avatarUrl: null, seekerVerified: true,
      bases: 2, highestKeepLevel: 9, trophies: 340, clan: { name: clanName, tag: clanTag },
    });
    // The allowlist IS the feature ("do not overdo it"): a new field must be a
    // deliberate contract change, not a spread that happened to compile.
    expect(ChatAuthorCardSchema.safeParse({ ...res.json<object>(), wallet: owner.wallet }).success).toBe(false);
    // Nothing that identifies or locates the player: not the wallet, not a
    // recognisable head/tail of it (the leaderboard's short-wallet form), not a
    // base id a raider could feed to scout/attack reads.
    const wire = res.body;
    for (const secret of [owner.wallet, owner.wallet.slice(0, 6), owner.wallet.slice(-6), ...baseIds]) {
      expect(wire).not.toContain(secret);
    }
    // A player may open their own card from their own message.
    const own = await card(owner, messageId);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual(res.json());
  });

  it('describes a landless player by the free starter base', async () => {
    const starter = await signIn();
    const viewer = await signIn();
    const baseId = await addBase(starter, { slot: 1, keepLevel: 4, paid: false });
    const res = await card(viewer, await say(starter));
    expect(res.statusCode, res.body).toBe(200);
    // Unpaid land is not a kingdom on the world map, so it is not counted — but
    // the Keep they have built is still the honest answer to "how far along".
    expect(res.json()).toMatchObject({ bases: 0, highestKeepLevel: 4, trophies: 0, clan: null });
    expect(res.body).not.toContain(baseId);
  });

  it('stops counting a sold kingdom the moment bases.ownerWallet moves', async () => {
    const seller = await signIn();
    const buyer = await signIn();
    const flagship = await addBase(seller, { slot: 1, keepLevel: 7, paid: true, trophies: 500 });
    const outpost = await addBase(seller, { slot: 2, keepLevel: 2, paid: true, trophies: 10 });
    const messageId = await say(seller);
    expect((await card(buyer, messageId)).json()).toMatchObject({ bases: 2, highestKeepLevel: 7, trophies: 500 });

    // The finalized-deed observer's transfer: slot released, owner rewritten.
    await db.delete(baseSlots).where(eq(baseSlots.baseId, flagship));
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, flagship));
    expect((await card(buyer, messageId)).json()).toMatchObject({ bases: 1, highestKeepLevel: 2, trophies: 10 });

    // A stale slot row must not keep advertising land the seller no longer
    // owns — the same authority boundary that revokes their send permission.
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, outpost));
    const soldOut = await card(buyer, messageId);
    expect(soldOut.statusCode, soldOut.body).toBe(200);
    expect(soldOut.json()).toMatchObject({ bases: 0, highestKeepLevel: null, trophies: 0 });
  });

  it('answers a blocked author, a removed message and an expired message exactly like an unknown id', async () => {
    const author = await signIn();
    const blocker = await signIn();
    const stranger = await signIn();
    await addBase(author, { slot: 1, keepLevel: 5, paid: true });
    await addBase(blocker, { slot: 1, keepLevel: 5, paid: true });
    const messageId = await say(author);
    const unknown = await card(blocker, '999999999999999');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'CHAT_MESSAGE_NOT_FOUND' } });

    expect((await card(blocker, messageId)).statusCode).toBe(200);
    await db.insert(globalChatBlocks).values({ blockerWallet: blocker.wallet, blockedWallet: author.wallet });
    const blocked = await card(blocker, messageId);
    // No oracle: a byte-identical refusal, or a hidden message id could be
    // probed to learn "this exists and I blocked its author".
    expect(blocked.statusCode).toBe(404);
    expect(blocked.body).toBe(unknown.body);
    // The block is the VIEWER's filter only, exactly like message history: other
    // players still see the card, and the blocked author still sees the blocker's.
    expect((await card(stranger, messageId)).statusCode).toBe(200);
    expect((await card(author, await say(blocker))).statusCode).toBe(200);

    const removed = await say(author);
    await db.update(globalChatMessages).set({ redactedAt: new Date() })
      .where(eq(globalChatMessages.id, BigInt(removed)));
    const removedRes = await card(stranger, removed);
    expect(removedRes.statusCode).toBe(404);
    expect(removedRes.body).toBe(unknown.body);

    const expired = await say(author, new Date(Date.now() - (CHAT.visibleRetentionDays + 1) * 86_400_000));
    try {
      const expiredRes = await card(stranger, expired);
      expect(expiredRes.statusCode).toBe(404);
      expect(expiredRes.body).toBe(unknown.body);
    } finally {
      // API files share one database. Leave no deliberately expired row for
      // the retention contract's global purge to count as its own fixture.
      await db.delete(globalChatMessages).where(eq(globalChatMessages.id, BigInt(expired)));
    }
  });

  it('answers an id above the signed 64-bit range exactly like an unknown id, never a 500', async () => {
    const viewer = await signIn();
    const unknown = await card(viewer, '999999999999999');
    expect(unknown.statusCode).toBe(404);
    // A positive decimal PostgreSQL cannot bind as bigint is still only "a
    // message that does not exist". A generic 500 here broke the documented
    // contract and made the refusal depend on the id's magnitude.
    // 100 digits is the longest id the router hands to this route at all.
    for (const id of ['9223372036854775807', '9223372036854775808', '9'.repeat(100)]) {
      const res = await card(viewer, id);
      expect(res.statusCode, `${id}: ${res.body}`).toBe(404);
      expect(res.body).toBe(unknown.body);
    }
    // Longer still never matches the route: the router's own 404, decided by the
    // URL's length alone (no auth, no query), so it says nothing about any id.
    expect((await card(viewer, '9'.repeat(101))).statusCode).toBe(404);
  });

  it('shows the name the message was sent under, never the name the author changed to afterwards', async () => {
    const author = await signIn();
    const viewer = await signIn();
    await addBase(author, { slot: 1, keepLevel: 6, paid: true, trophies: 50 });
    const messageId = await say(author);
    // A rename is how a harassed player gets away: the world/map search matches
    // only the CURRENT name, so a days-old message must not hand out that key.
    const renamed = `R${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await db.update(players).set({ name: renamed, nameKey: renamed.toLowerCase() })
      .where(eq(players.wallet, author.wallet));

    const history = await app.inject({
      method: 'GET', url: '/chat/messages', cookies: { [SESSION_COOKIE]: viewer.cookie },
    });
    const shown = history.json<{ messages: { id: string; author: { name: string } }[] }>()
      .messages.find((message) => message.id === messageId);
    expect(shown?.author.name).toBe(author.name);

    const res = await card(viewer, messageId);
    expect(res.statusCode, res.body).toBe(200);
    // The card says exactly what the tapped message already says...
    expect(res.json()).toMatchObject({ name: shown!.author.name, bases: 1, highestKeepLevel: 6 });
    // ...and the new name is nowhere on the wire, in any casing.
    expect(res.body.toLowerCase()).not.toContain(renamed.toLowerCase());
  });

  it('obeys the global chat kill switch like the other chat reads', async () => {
    const author = await signIn();
    const messageId = await say(author);
    await setGlobalChatEnabled({ db, actorWallet: author.wallet, enabled: false, reason: 'author card test' });
    try {
      const res = await card(author, messageId);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: { code: 'CHAT_DISABLED' } });
    } finally {
      await setGlobalChatEnabled({ db, actorWallet: author.wallet, enabled: true, reason: 'author card test' });
    }
  });
});

describe('chat author card polling abuse', () => {
  it('declares its own finite fail-closed wallet bucket', () => {
    expect(CHAT_AUTHOR_CARD_RATE_LIMIT).toMatchObject({
      max: CHAT.authorCardsPerWalletMinute, timeWindow: 60_000, skipOnError: false,
    });
    const req = { wallet: 'viewer' } as never;
    expect(CHAT_AUTHOR_CARD_RATE_LIMIT.keyGenerator(req)).toBe('chat-author-card-wallet:viewer');
    expect(CHAT_AUTHOR_CARD_RATE_LIMIT.keyGenerator(req)).not.toBe(CHAT_READ_RATE_LIMIT.keyGenerator(req));
    // A tap budget, deliberately far below the polling budget it must not eat.
    expect(CHAT.authorCardsPerWalletMinute).toBeLessThan(CHAT.readsPerWalletMinute);
  });

  it('limits card reads per wallet on the real route without starving the chat poll', async () => {
    // buildApp skips the limiter plugin in NODE_ENV=test, so the REAL chat routes
    // are mounted on a production-like app with the plugin present.
    const limited = Fastify();
    await limited.register(rateLimit, { global: false, max: 10_000, timeWindow: 60_000 });
    limited.decorateRequest('wallet', '');
    limited.decorate('authenticate', async (req: FastifyRequest) => {
      const wallet = req.headers['x-wallet'];
      if (typeof wallet !== 'string' || wallet === '') throw new HttpError(401, 'unauthenticated');
      req.wallet = wallet;
    });
    limited.setErrorHandler((err, _req, reply) => err instanceof HttpError
      ? reply.status(err.statusCode).send({ error: { message: err.message, code: err.code } })
      : reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { message: 'error' } }));
    registerChatRoutes(limited, TEST_CONFIG, db);
    await limited.ready();
    try {
      const author = await signIn();
      const viewer = await signIn();
      const neighbour = await signIn();
      const url = `/chat/messages/${await say(author)}/author`;
      for (let i = 0; i < CHAT.authorCardsPerWalletMinute; i++) {
        const ok = await limited.inject({ method: 'GET', url, headers: { 'x-wallet': viewer.wallet } });
        expect(ok.statusCode, ok.body).toBe(200);
      }
      const over = await limited.inject({ method: 'GET', url, headers: { 'x-wallet': viewer.wallet } });
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({ error: { code: 'CHAT_RATE_LIMITED' } });
      // Same NAT/IP, different account: fairness is per wallet.
      const other = await limited.inject({ method: 'GET', url, headers: { 'x-wallet': neighbour.wallet } });
      expect(other.statusCode, other.body).toBe(200);
      // Exhausting profile taps must not freeze the viewer's own live chat.
      const poll = await limited.inject({ method: 'GET', url: '/chat/status', headers: { 'x-wallet': viewer.wallet } });
      expect(poll.statusCode, poll.body).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
