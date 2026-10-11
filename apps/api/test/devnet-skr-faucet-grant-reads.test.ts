/** K-night-03: the native faucet client recovers lost or prior-day claims through two authenticated reads that P5 did
 * not serve. Every answer here is passed through the port of the phone's own decoder (skr-faucet-native-decoder.ts):
 * a page it refuses leaves the player's saved claim stuck behind "Faucet unavailable", so the shape is the contract. */
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKR_FAUCET } from '@shardkeep/shared';
import { makeSkrFaucetService, utcWindow } from '../src/devnet-only/skrFaucet';
import { registerSkrFaucetRoutes } from '../src/devnet-only/routes-skr-faucet';
import { registerDevnetOnly } from '../src/devnet-only';
import { loadDevnetOnlyRoutes, type DevnetOnlyOptions } from '../src/devnetOnlyLoader';
import { HttpError } from '../src/lib/errors';
import type { SkrAttempt, SkrGrant } from '../src/devnet-only/skrFaucetStore';
import { mint, otherPlayer, policy, testRpc, testStore, wallet } from './skr-faucet-fixtures';
import { nativeDiscoveryScan, nativeGrant, nativeGrantPage } from './skr-faucet-native-decoder';

const size = SKR_FAUCET.devnet.grantReadPageSize, pin = { mint, decimals: 6 }, grantSkr = SKR_FAUCET.devnet.grantSkr;
const other = otherPlayer.publicKey.toBase58(), now = new Date('2026-10-06T12:00:00Z');
const open: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(open.splice(0).map((app) => app.close())); });

async function fixture() {
  const app = Fastify(); open.push(app); await app.register(rateLimit, { global: false });
  app.decorateRequest('wallet', '');
  // The session wallet comes only from authentication (header stands in for the cookie session here).
  app.decorate('authenticate', async (request: { wallet: string; headers: Record<string, unknown> }) => {
    const session = request.headers['x-test-session'];
    if (typeof session !== 'string') throw new HttpError(401, 'authentication required', 'AUTH_REQUIRED'); request.wallet = session;
  });
  // Same body shape as apps/api/src/app.ts's error handler.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: { ...error.details, message: error.message, code: error.code } });
    return reply.status(500).send({ error: { message: 'internal' } });
  });
  const fake = testStore(now), store = { ...fake.store, ownedRequested: vi.fn(fake.store.ownedRequested), readGrant: vi.fn(fake.store.readGrant) };
  const service = makeSkrFaucetService(policy, store, testRpc().rpc, { now: () => now,
    eligibility: async () => ({ reason: 'ok', deed: 'fixture-deed' }), refreshDeed: async () => 'fixture-deed' });
  registerSkrFaucetRoutes(app, service);
  const get = (url: string, session: string | null = wallet) => app.inject({ method: 'GET', url, headers: session === null ? {} : { 'x-test-session': session } });
  const day = (offset: number) => utcWindow(new Date(now.getTime() - offset * 86_400_000)).day;
  const attempt = (grant: SkrGrant, attemptNo: number, phase: SkrAttempt['phase']): SkrAttempt => {
    const row: SkrAttempt = { id: randomUUID(), grantId: grant.id, attemptNo, phase, message: Buffer.from([1]), reference: fake.reference(),
      recentBlockhash: fake.reference(), lastValidBlockHeight: 200n, playerWire: null, signature: null, mutation: null, faucetWire: null,
      landedSignature: null, createdAt: now, settledAt: phase === 'abandoned' ? now : null };
    fake.attempts.set(row.id, row); return row;
  };
  return { app, fake, store, service, get, day, attempt };
}

describe('GET /devnet-skr-faucet/grants (native lost-claim discovery)', () => {
  it('pages only the session wallet\'s requested grants, newest first, in the exact shape the phone decodes', async () => {
    const f = await fixture();
    const requested = Array.from({ length: size + 3 }, (_, n) => f.fake.makeGrant(wallet, f.day(n + 1), `deed-${n}`));
    const sent = f.fake.makeGrant(wallet, f.day(size + 10), 'deed-sent'); Object.assign(sent, { status: 'sent', sentAt: now });
    const failed = f.fake.makeGrant(wallet, f.day(size + 11), 'deed-failed'); Object.assign(failed, { status: 'failed', error: 'day_changed' });
    f.fake.makeGrant(other, f.day(1), 'other-deed'); f.fake.makeGrant(other, f.day(2), 'other-deed');
    const withAttempts = requested[2]!; f.attempt(withAttempts, 1, 'abandoned'); const latest = f.attempt(withAttempts, 2, 'prepared');

    const first = await f.get('/devnet-skr-faucet/grants'); expect(first.statusCode).toBe(200);
    const page1 = first.json(); expect(page1.items).toHaveLength(size); expect(page1.nextCursor).toBe(page1.items[size - 1].id);
    const second = await f.get(`/devnet-skr-faucet/grants?after=${page1.nextCursor}`); expect(second.statusCode).toBe(200);
    const page2 = second.json(); expect(page2.items).toHaveLength(3); expect(page2.nextCursor).toBeNull();
    // The whole head-to-tail sequence passes the phone's page, identity, order and completeness checks.
    const scan = nativeDiscoveryScan([page1, page2], size, pin, grantSkr);
    // Newest first; terminal grants and another wallet's grants never appear (they would break the absence proof).
    expect(scan.flatMap((page) => page.items.map((item) => item.id))).toEqual(requested.map((grant) => grant.id));
    const shown = [...page1.items, ...page2.items].find((item: { id: string }) => item.id === withAttempts.id);
    expect(shown.attempt).toMatchObject({ id: latest.id, phase: 'prepared', signature: null, lastValidBlockHeight: '200' });
    expect(Object.keys(shown).sort()).toEqual(['amountRaw', 'attempt', 'decimals', 'error', 'id', 'mint', 'requestedAt', 'sentAt', 'status']);
    expect(f.fake.events).toEqual([]); // read-only: no grant transaction opened
  });
  it('answers an empty or exactly-full wallet with no cursor, so the phone can complete its proof', async () => {
    const f = await fixture();
    const empty = (await f.get('/devnet-skr-faucet/grants')).json();
    expect(empty).toEqual({ items: [], nextCursor: null }); nativeDiscoveryScan([empty], size, pin, grantSkr);
    for (let n = 0; n < size; n++) f.fake.makeGrant(wallet, f.day(n + 1), `deed-${n}`);
    const full = (await f.get('/devnet-skr-faucet/grants')).json();
    expect(full.items).toHaveLength(size); expect(full.nextCursor).toBeNull(); nativeDiscoveryScan([full], size, pin, grantSkr);
  });
  it('takes its cursor only from the session wallet\'s own grants, and keeps paging past one that settled meanwhile', async () => {
    const f = await fixture();
    const mine = Array.from({ length: 4 }, (_, n) => f.fake.makeGrant(wallet, f.day(n + 1), `deed-${n}`));
    const foreign = f.fake.makeGrant(other, f.day(1), 'other-deed');
    for (const after of [foreign.id, randomUUID()]) {
      const refused = await f.get(`/devnet-skr-faucet/grants?after=${after}`);
      expect(refused.statusCode).toBe(404); expect(refused.json().error.code).toBe('SKR_FAUCET_NOT_OWNED');
    }
    Object.assign(mine[1]!, { status: 'sent', sentAt: now });
    const page = (await f.get(`/devnet-skr-faucet/grants?after=${mine[1]!.id}`)).json();
    expect(page.items.map((item: { id: string }) => item.id)).toEqual([mine[2]!.id, mine[3]!.id]); expect(page.nextCursor).toBeNull();
    nativeGrantPage(page, size);
  });
});

describe('GET /devnet-skr-faucet/grants/:grantId (native owned-grant read)', () => {
  it('returns the session wallet\'s grant in any status with its latest attempt; others are the coded 404 the phone releases on', async () => {
    const f = await fixture();
    const sent = f.fake.makeGrant(wallet, f.day(1), 'deed-a'); Object.assign(sent, { status: 'sent', sentAt: now });
    const first = f.attempt(sent, 1, 'abandoned'); const second = f.attempt(sent, 2, 'abandoned');
    const response = await f.get(`/devnet-skr-faucet/grants/${sent.id}`); expect(response.statusCode).toBe(200);
    const body = response.json(); expect(Object.keys(body)).toEqual(['grant']);
    const grant = nativeGrant(body.grant);
    expect(grant).toMatchObject({ id: sent.id, status: { raw: 'sent', known: true }, attempt: { id: second.id } });
    expect(grant.attempt!.id).not.toBe(first.id);
    const foreign = f.fake.makeGrant(other, f.day(1), 'other-deed');
    for (const id of [foreign.id, randomUUID()]) {
      const refused = await f.get(`/devnet-skr-faucet/grants/${id}`);
      // SkrFaucetRepository releases an unsigned intent only on exactly 404 + SKR_FAUCET_NOT_OWNED.
      expect(refused.statusCode).toBe(404); expect(refused.json().error.code).toBe('SKR_FAUCET_NOT_OWNED');
    }
  });
  it('proves ownership of the grant a 429 daily-limit claim names, with the same identity the phone compares', async () => {
    const f = await fixture(), baseId = randomUUID();
    const today = f.fake.makeGrant(wallet, utcWindow(now).day, 'fixture-deed');
    const limited = await f.service.claim(wallet, baseId).then(() => null, (error: unknown) => error as HttpError);
    expect(limited).toMatchObject({ statusCode: 429, code: 'SKR_FAUCET_DAILY_LIMIT' });
    const named = nativeGrant((limited!.details as { today: unknown }).today);
    const owned = nativeGrant((await f.get(`/devnet-skr-faucet/grants/${named.id}`)).json().grant);
    // SkrFaucetGrant.sameIdentity: id, mint, decimals, amountRaw and requestedAt.
    expect([owned.id, owned.mint, owned.decimals, owned.amountRaw, owned.requestedAtMs])
      .toEqual([today.id, named.mint, named.decimals, named.amountRaw, named.requestedAtMs]);
  });
});

describe('faucet grant reads: authentication, strict input and absence', () => {
  it('refuses unauthenticated reads and any caller-chosen wallet or malformed id before reading a grant', async () => {
    const f = await fixture(), id = randomUUID();
    for (const url of ['/devnet-skr-faucet/grants', `/devnet-skr-faucet/grants/${id}`]) expect((await f.get(url, null)).statusCode).toBe(401);
    for (const url of ['/devnet-skr-faucet/grants?wallet=attacker', '/devnet-skr-faucet/grants?after=not-a-uuid', '/devnet-skr-faucet/grants?after=',
      `/devnet-skr-faucet/grants?after=${id}&limit=500`, '/devnet-skr-faucet/grants/not-a-uuid', `/devnet-skr-faucet/grants/${id}?wallet=attacker`]) {
      const refused = await f.get(url); expect(refused.statusCode, url).toBe(400); expect(refused.json().error.code).toBe('SKR_FAUCET_INVALID_REQUEST');
    }
    expect(f.store.ownedRequested).not.toHaveBeenCalled(); expect(f.store.readGrant).not.toHaveBeenCalled();
  });
  it('hides a raw store failure behind the opaque 503 the phone keeps evidence on', async () => {
    const f = await fixture(); f.store.ownedRequested.mockRejectedValueOnce(new Error('postgres://user:secret@db.invalid/shardkeep'));
    const failed = await f.get('/devnet-skr-faucet/grants');
    expect(failed.statusCode).toBe(503); expect(failed.json().error.code).toBe('SKR_FAUCET_UNAVAILABLE'); expect(failed.body).not.toMatch(/secret|db\.invalid/);
  });
  it('serves no grant route while the faucet is disabled or off devnet (plain 404, as before)', async () => {
    const importer = vi.fn(async () => ({ registerDevnetOnly, registerDevnetOnlyJobs: async () => null }));
    for (const ctx of [{ cluster: 'devnet' as const, enabled: 'false' }, { cluster: 'devnet' as const, enabled: undefined }, { cluster: 'mainnet-beta' as const, enabled: 'true' }]) {
      const app = Fastify(); open.push(app); await loadDevnetOnlyRoutes(app, { ...ctx, importer });
      for (const url of ['/devnet-skr-faucet/grants', `/devnet-skr-faucet/grants/${randomUUID()}`]) expect((await app.inject(url)).statusCode).toBe(404);
    }
    expect(importer).not.toHaveBeenCalled();
    // The module's own gate refuses too, before it touches the database, queue or RPC.
    const app = Fastify(); open.push(app);
    await registerDevnetOnly(app, { config: { SOLANA_CLUSTER: 'devnet', DEVNET_SKR_FAUCET_ENABLED: 'false' } } as unknown as DevnetOnlyOptions);
    expect((await app.inject('/devnet-skr-faucet/grants')).statusCode).toBe(404);
  });
});
