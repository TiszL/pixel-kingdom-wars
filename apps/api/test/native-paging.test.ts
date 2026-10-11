import { randomUUID } from 'node:crypto';
import type { SimEvent } from '@shardkeep/sim';
import { SIM_VERSION } from '@shardkeep/sim';
import { LIVE_RAID } from '@shardkeep/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NativePresentationPages, type NativePage } from '../src/native/paging';
import { NativePresentationPageSchema, NATIVE_PAGE_BYTES } from '../src/native/contracts';
import { registerNativeRoutes } from '../src/native/routes';
import { HttpError } from '../src/lib/errors';
import { bases, raids } from '../src/db/schema';
import { persistReplayTimeline } from '../src/game/raidReplayArchive';
import { recordBaseBattle } from '../src/game/baseBattleHistory';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const raidId = randomUUID();
const revision = (n: number) => n.toString(16).padStart(64, '0');
const state = { source: 'live' as const, status: 'pending_orders', simVersion: SIM_VERSION,
  raidProtocolVersion: 2, clock: null, lastSequence: 0, snapshot: {}, armySnapshot: {}, commands: [], result: null };
const events = (count: number): SimEvent[] => Array.from({ length: count }, (_, i) => ({ t: i, e: 'pos', id: 1, x: i, y: 0 }));
const store = (pageBytes = 1024) => new NativePresentationPages({ cacheBytes: 1_000_000, timelines: 8, generations: 16, pageBytes });
function collect(pages: NativePresentationPages, first: NativePage) {
  let page = first; const result = [...page.events];
  while (page.nextCursor) {
    const prior = page;
    page = pages.read('alice', raidId, page.nextCursor);
    expect(page.eventOffset).toBe(prior.eventOffset + prior.events.length);
    expect(page.state).toBeNull(); expect(page.generation).toBe(first.generation);
    expect(page.revision).toBe(first.revision); expect(page.parentRevision).toBe(first.parentRevision);
    expect(page.replaceFromTick).toBe(first.replaceFromTick);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024);
    result.push(...page.events);
  }
  expect(result.length).toBe(first.totalEvents);
  return result;
}

describe('native immutable pages and canonical replacement boundaries', () => {
  it('reassembles exact event bytes from bounded pages and retries a cursor idempotently', () => {
    const pages = store(); const input = events(100);
    const first = pages.create('alice', raidId, revision(1), state, input);
    expect(NativePresentationPageSchema.parse(first).protocolVersion).toBe(2);
    expect(first.parentRevision).toBeNull(); expect(first.replaceFromTick).toBe(0);
    expect(first.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1024);
    expect(pages.read('alice', raidId, first.nextCursor!)).toEqual(pages.read('alice', raidId, first.nextCursor!));
    expect(collect(pages, first)).toEqual(input);
    expect(pages.stats().timelines).toBe(1);
    pages.create('bob', raidId, revision(1), state, input);
    expect(pages.stats().timelines).toBe(1); // Share timeline, not serialized page copies.
  });

  it('replaces the whole earliest changed tick while retaining a proven earlier prefix', () => {
    const pages = store();
    const before: SimEvent[] = [{ t: 0, e: 'star', n: 1 }, { t: 5, e: 'hit', target: 1, dmg: 1 }, { t: 5, e: 'hit', target: 2, dmg: 1 }, { t: 9, e: 'star', n: 2 }];
    pages.create('alice', raidId, revision(1), state, before);
    const after = before.map((event, i) => i === 2 ? { t: 5, e: 'hit' as const, target: 2, dmg: 3 } : event);
    const next = pages.create('alice', raidId, revision(2), state, after, revision(1));
    expect(next.parentRevision).toBe(revision(1)); expect(next.replaceFromTick).toBe(5);
    expect([...before.filter((event) => event.t < next.replaceFromTick), ...collect(pages, next)]).toEqual(after);
  });

  it('captures a fresh canonical clock for a new viewer of the same revision while sharing events', () => {
    const pages = store(4096);
    const clock = { protocolVersion: 2 as const, revision: 1, rate: 1 as const,
      anchorWallAt: '2026-09-06T00:00:00.000Z', anchorSimMs: 0,
      serverNow: '2026-09-06T00:00:00.000Z', simNowMs: 0,
      battleEndsAt: '2026-09-06T00:02:00.000Z', durationMs: 120_000 };
    const before = pages.create('alice', raidId, revision(1), { ...state, clock }, events(100));
    const fresh = { ...clock, serverNow: '2026-09-06T00:00:05.000Z', simNowMs: 5000 };
    const after = pages.create('bob', raidId, revision(1), { ...state, clock: fresh }, events(100));
    expect(before.state!.clock).toEqual(clock);
    expect(after.state!.clock).toEqual(fresh);
    expect(pages.stats().timelines).toBe(1);
  });

  it('pages a legal maximum UTF-8 command journal before events without enlarging the response cap', () => {
    const pages = store(NATIVE_PAGE_BYTES);
    const commands = Array.from({ length: LIVE_RAID.maxCommands }, (_, sequence) => ({
      sequence, clientCommandId: `${String(sequence).padStart(4, '0')}${'界'.repeat(LIVE_RAID.clientCommandIdMaxLength - 4)}`,
      kind: 'deploy' as const, payload: { troop: 'highlander', tx: -1, ty: 14 }, serverOffsetMs: sequence,
      acceptedAt: '2026-09-06T00:00:00.000Z',
    }));
    expect(Buffer.byteLength(JSON.stringify(commands))).toBeGreaterThan(NATIVE_PAGE_BYTES);
    let page = pages.create('alice', raidId, revision(1), { ...state, commands, lastSequence: commands.length - 1 }, events(100));
    expect(page.state!.commands).toEqual([]);
    expect(page.events).toEqual([]); expect(page.nextCursor).not.toBeNull();
    const receivedCommands = [...page.commands]; const receivedEvents = [...page.events];
    while (page.nextCursor) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(NATIVE_PAGE_BYTES);
      page = pages.read('alice', raidId, page.nextCursor);
      expect(page.state).toBeNull();
      expect(page.commandOffset).toBe(receivedCommands.length); expect(page.eventOffset).toBe(receivedEvents.length);
      if (page.events.length) expect(page.commandOffset + page.commands.length).toBe(commands.length);
      receivedCommands.push(...page.commands); receivedEvents.push(...page.events);
    }
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(NATIVE_PAGE_BYTES);
    expect(receivedCommands).toEqual(commands); expect(receivedEvents).toEqual(events(100));
  });

  it('handles early-finish truncation, clock-only changes and changed frozen input', () => {
    const pages = store(); const before = events(10);
    pages.create('alice', raidId, revision(1), state, before);
    const trimmed = pages.create('alice', raidId, revision(2), { ...state, status: 'resolved' }, before.slice(0, 5), revision(1));
    expect(trimmed.replaceFromTick).toBe(5); expect(trimmed.totalEvents).toBe(0);
    const clockOnly = pages.create('alice', raidId, revision(3), { ...state, lastSequence: 1 }, before.slice(0, 5), revision(2));
    expect(clockOnly.replaceFromTick).toBe(5); expect(clockOnly.totalEvents).toBe(0);
    const incompatible = pages.create('alice', raidId, revision(4), { ...state, snapshot: { changed: true } }, before, revision(3));
    expect(incompatible.parentRevision).toBeNull(); expect(incompatible.replaceFromTick).toBe(0);
  });

  it('does not mix an in-flight generation with newer predictions or caller mutation', () => {
    const pages = store(); const before = events(100); const expected = structuredClone(before);
    const first = pages.create('alice', raidId, revision(1), state, before);
    before[50]!.t = 9999;
    pages.create('alice', raidId, revision(2), state, events(90), revision(1));
    expect(collect(pages, first)).toEqual(expected);
  });

  it('rejects forged, cross-wallet and cross-raid cursors', () => {
    const pages = store(); const first = pages.create('alice', raidId, revision(1), state, events(100));
    for (const task of [() => pages.read('bob', raidId, first.nextCursor!),
      () => pages.read('alice', randomUUID(), first.nextCursor!),
      () => pages.read('alice', raidId, first.nextCursor!.replace(/.$/, first.nextCursor!.endsWith('0') ? '1' : '0'))]) {
      expect(task).toThrowError(expect.objectContaining({ code: 'NATIVE_PAGE_INVALID' }));
    }
  });

  it('expires or evicts pages, bounds retained data and resets a missing parent', () => {
    let now = 0;
    const pages = new NativePresentationPages({ cacheBytes: 20_000, timelines: 2, generations: 2, pageBytes: 1024, ageMs: 100 }, () => now);
    const first = pages.create('alice', raidId, revision(1), state, events(100));
    pages.create('alice', raidId, revision(2), state, events(100));
    pages.create('alice', raidId, revision(3), state, events(100));
    expect(pages.stats().bytes).toBeLessThanOrEqual(20_000);
    expect(pages.stats().timelines).toBeLessThanOrEqual(2); expect(pages.stats().generations).toBeLessThanOrEqual(2);
    expect(() => pages.read('alice', raidId, first.nextCursor!)).toThrowError(expect.objectContaining({ code: 'NATIVE_PAGE_EXPIRED' }));
    expect(() => store().read('alice', raidId, first.nextCursor!)).toThrowError(expect.objectContaining({ code: 'NATIVE_PAGE_EXPIRED' }));
    const reset = pages.create('alice', raidId, revision(4), state, events(100), revision(1));
    expect(reset.parentRevision).toBeNull(); expect(reset.replaceFromTick).toBe(0);
    now = 101;
    expect(() => pages.read('alice', raidId, reset.nextCursor!)).toThrowError(expect.objectContaining({ code: 'NATIVE_PAGE_EXPIRED' }));
    expect(pages.stats().bytes).toBe(0);
  });

  it('refuses oversized metadata/events instead of creating unbounded or non-progressing pages', () => {
    const pages = store();
    expect(() => pages.create('alice', raidId, revision(1), { ...state, snapshot: { huge: 'x'.repeat(2000) } }, events(1)))
      .toThrowError(expect.objectContaining({ code: 'NATIVE_PRESENTATION_CAPACITY' }));
    expect(() => pages.create('alice', raidId, revision(2), state, [{ t: 0, e: 'destroyed', id: 'x'.repeat(2000) }]))
      .toThrowError(expect.objectContaining({ code: 'NATIVE_PRESENTATION_CAPACITY' }));
    expect(() => pages.create('alice', raidId, revision(3), state, [events(2)[1]!, events(2)[0]!]))
      .toThrowError(expect.objectContaining({ code: 'NATIVE_PRESENTATION_CAPACITY' }));
  });
});

const connection = connectTestDb();
const apps: FastifyInstance[] = [];
const originalMultiBase = process.env['MULTI_BASE_ENABLED'];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  if (originalMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = originalMultiBase;
});
afterAll(async () => { await connection.sql.end(); });

it('reauthorizes every archived page while keeping the default transport-1 route byte-equivalent', async () => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  const { db } = connection;
  const owner = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: owner.wallet, status: 'active', keepLevel: 5 }).returning();
  const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: owner.wallet,
    attackerBaseId: base!.id, seed: 7n, simVersion: SIM_VERSION, status: 'resolved', resolvedAt: new Date(),
    ordersDeadlineAt: new Date(), snapshot: {}, armySnapshot: {} }).returning();
  const canonicalEvents = events(10_000);
  await recordBaseBattle(db, { raidId: raid!.id, attackerBaseId: base!.id, attackerOwnerWallet: owner.wallet,
    stars: 1, destructionPct: 50, lootShards: 0n });
  await persistReplayTimeline(db, raid!.id, { snapshot: {}, armySnapshot: {}, orders: { deploys: [] },
    seed: 7, simVersion: SIM_VERSION, events: canonicalEvents, result: { lootShards: '9007199254740993' } }, 100);
  let allowed = true;
  const app = Fastify(); apps.push(app);
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async (req) => { if (!allowed) throw new HttpError(401, 'revoked'); req.wallet = owner.wallet; });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    throw error;
  });
  registerNativeRoutes(app, { ...TEST_CONFIG, NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_OPEN: 'true' }, db);
  await app.ready();
  const legacy = await app.inject(`/raids/${raid!.id}/presentation`);
  expect(legacy.statusCode).toBe(200); expect(legacy.json().protocolVersion).toBe(1);
  expect(legacy.json().replaceFromTick).toBe(0); expect(legacy.json().events).toEqual(canonicalEvents);
  const first = await app.inject(`/raids/${raid!.id}/presentation?protocolVersion=2`);
  expect(first.statusCode).toBe(200); expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(NATIVE_PAGE_BYTES);
  const page = NativePresentationPageSchema.parse(first.json());
  expect(page.nextCursor).not.toBeNull(); expect(page.state!.result).toEqual(legacy.json().result);
  expect(page.state!.result).toMatchObject({ lootShards: '9007199254740993' });
  allowed = false;
  expect((await app.inject(`/raids/${raid!.id}/presentation?protocolVersion=2&cursor=${page.nextCursor}`)).statusCode).toBe(401);
  allowed = true;
  const next = await app.inject(`/raids/${raid!.id}/presentation?protocolVersion=2&cursor=${page.nextCursor}`);
  expect(next.statusCode).toBe(200); expect(next.json().state).toBeNull();
  expect(next.json().eventOffset).toBe(page.events.length);
  expect((await app.inject(`/raids/${raid!.id}/presentation?cursor=${page.nextCursor}`)).statusCode).toBe(400);
});
