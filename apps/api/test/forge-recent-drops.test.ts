/**
 * GET /forge/drops/recent — the PUBLIC relics-won feed (tester 69arc, report
 * 0d1b6d9d "RELICS WON DISPLAY"). What these tests pin, and why:
 *  - it is reachable WITHOUT a session: transparency that drops really
 *    happen is the whole point, so a logged-out visitor may read it;
 *  - only SETTLED positions publish (an open cycle's composition is an
 *    economic secret — getForgeGlobalDay's contract);
 *  - the winner is the owner AT SETTLEMENT, abbreviated server-side: the
 *    full wallet never leaves, or the feed becomes a one-request harvester;
 *  - the page is bounded by FORGE.recentDropsMaxPageSize no matter what
 *    `limit` asks for, and the in-process cache serves one query per window.
 *
 * Fixture rows are inserted directly: rolls are hash-deterministic on
 * (day, baseId) and settleForgeDay is global per day, so driving real
 * settlement here would couple this file to every other Forge suite's days.
 */
import { randomUUID } from 'node:crypto';
import { FORGE, ITEMS } from '@shardkeep/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { baseForgePositions, bases, players } from '../src/db/schema';
import { getRecentForgeDrops, resetRecentForgeDropsCache } from '../src/game/forge';
import { connectTestDb, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;

const NAMED = { wallet: randomWallet(), name: `RelicHunter${randomUUID().slice(0, 6)}` };
const UNNAMED = { wallet: randomWallet(), name: '' };
/** The api suite shares one database and other files settle positions dated as far out as
 * 2033, so "newest first" is only deterministic if this file's rows sit past every other
 * fixture: a fixed anchor in 2200 (the service orders by settled_at and never bounds it by now). */
const T0 = Date.UTC(2200, 0, 1);

async function settledDrop(owner: { wallet: string }, day: string, items: string[], settledAt: Date) {
  const [base] = await db.insert(bases).values({
    ownerWallet: owner.wallet, status: 'active', landPaidAt: new Date(), keepLevel: 3,
  }).returning({ id: bases.id });
  await db.insert(baseForgePositions).values({
    day, baseId: base!.id, contributedShards: 500n, raidDebitedShards: 0n,
    countedShards: 0n, shardsRefunded: 0n, keepPaid: 0n,
    settlementOwnerWallet: owner.wallet, itemsDropped: items, settledAt,
  });
  return base!.id;
}

beforeAll(async () => {
  app = await buildApp(TEST_CONFIG, db);
  await db.insert(players).values([
    { wallet: NAMED.wallet, name: NAMED.name, nameKey: NAMED.name.toLowerCase(), seekerVerified: true },
    { wallet: UNNAMED.wallet },
  ]);
  await settledDrop(NAMED, '2020-01-01', ['keg_of_haste'], new Date(T0 - 2_000));
  await settledDrop(UNNAMED, '2020-01-02', ['warzone_aegis', 'marchers_greaves'], new Date(T0 - 1_000));
  await settledDrop(NAMED, '2020-01-03', ['banner_of_nine'], new Date(T0));
  // An OPEN position with a (never-possible in production) drop list: it must
  // stay invisible until settlement, whatever the column says.
  const [open] = await db.insert(bases).values({
    ownerWallet: NAMED.wallet, status: 'active', landPaidAt: new Date(), keepLevel: 3,
  }).returning({ id: bases.id });
  await db.insert(baseForgePositions).values({
    day: '2020-01-04', baseId: open!.id, contributedShards: 500n, itemsDropped: ['item_troop_dragon'],
  });
  resetRecentForgeDropsCache();
});

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

describe('GET /forge/drops/recent', () => {
  it('serves settled relic drops, newest first, to a visitor with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/forge/drops/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(`public, max-age=${FORGE.recentDropsCacheSec}`);
    const body = res.json<{ drops: Array<Record<string, unknown>>; cacheSec: number }>();
    expect(body.cacheSec).toBe(FORGE.recentDropsCacheSec);
    expect(body.drops.slice(0, 4)).toEqual([
      {
        day: '2020-01-03', settledAt: new Date(T0).toISOString(), itemId: 'banner_of_nine',
        name: ITEMS.banner_of_nine.name, rarity: ITEMS.banner_of_nine.rarity,
        winner: { name: NAMED.name, walletShort: `${NAMED.wallet.slice(0, 4)}…${NAMED.wallet.slice(-4)}`, seeker: true },
      },
      {
        day: '2020-01-02', settledAt: new Date(T0 - 1_000).toISOString(), itemId: 'warzone_aegis',
        name: ITEMS.warzone_aegis.name, rarity: ITEMS.warzone_aegis.rarity,
        winner: { name: '', walletShort: `${UNNAMED.wallet.slice(0, 4)}…${UNNAMED.wallet.slice(-4)}`, seeker: false },
      },
      {
        day: '2020-01-02', settledAt: new Date(T0 - 1_000).toISOString(), itemId: 'marchers_greaves',
        name: ITEMS.marchers_greaves.name, rarity: ITEMS.marchers_greaves.rarity,
        winner: { name: '', walletShort: `${UNNAMED.wallet.slice(0, 4)}…${UNNAMED.wallet.slice(-4)}`, seeker: false },
      },
      {
        day: '2020-01-01', settledAt: new Date(T0 - 2_000).toISOString(), itemId: 'keg_of_haste',
        name: ITEMS.keg_of_haste.name, rarity: ITEMS.keg_of_haste.rarity,
        winner: { name: NAMED.name, walletShort: `${NAMED.wallet.slice(0, 4)}…${NAMED.wallet.slice(-4)}`, seeker: true },
      },
    ]);
  });

  it('never publishes an open position, a full wallet, a base id or claim state', async () => {
    const res = await app.inject({ method: 'GET', url: `/forge/drops/recent?limit=${FORGE.recentDropsMaxPageSize}` });
    const text = res.body;
    // The feed is global, so another test file's settled drops share it (the
    // api suite runs on one shardkeep_test DB): pin the OPEN fixture by ITS
    // winner and day, never by an item id another file may legitimately drop.
    const short = `${NAMED.wallet.slice(0, 4)}…${NAMED.wallet.slice(-4)}`;
    const ours = res.json<{ drops: Array<{ day: string; itemId: string; winner: { walletShort: string } }> }>().drops
      .filter((row) => row.winner.walletShort === short);
    expect(ours.map((row) => row.day)).not.toContain('2020-01-04');
    expect(ours.map((row) => row.itemId)).not.toContain('item_troop_dragon');
    expect(text).not.toContain(NAMED.wallet);
    expect(text).not.toContain(UNNAMED.wallet);
    for (const row of res.json<{ drops: Array<Record<string, unknown>> }>().drops) {
      expect(Object.keys(row).sort()).toEqual(['day', 'itemId', 'name', 'rarity', 'settledAt', 'winner']);
      expect(Object.keys(row['winner'] as object).sort()).toEqual(['name', 'seeker', 'walletShort']);
    }
  });

  it('clamps the page to FORGE.recentDropsMaxPageSize and rejects a non-positive limit', async () => {
    const bulkOwner = { wallet: randomWallet() };
    await db.insert(players).values({ wallet: bulkOwner.wallet });
    for (let i = 0; i < FORGE.recentDropsMaxPageSize + 5; i++) {
      await settledDrop(bulkOwner, `2019-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
        ['finishers_seal'], new Date(T0 + 1_000 + i));
    }
    // The route reads the cached page: prove the ceiling on a fresh read.
    const fresh = await getRecentForgeDrops(db, { limit: 5_000 }, T0 + FORGE.recentDropsCacheSec * 1000 + 10_000);
    expect(fresh.drops).toHaveLength(FORGE.recentDropsMaxPageSize);
    expect(fresh.drops.every((row) => row.itemId === 'finishers_seal')).toBe(true);
    const routed = await app.inject({ method: 'GET', url: '/forge/drops/recent?limit=5000' });
    expect(routed.statusCode).toBe(200);
    expect(routed.json<{ drops: unknown[] }>().drops.length).toBeLessThanOrEqual(FORGE.recentDropsMaxPageSize);
    const defaulted = await app.inject({ method: 'GET', url: '/forge/drops/recent' });
    expect(defaulted.json<{ drops: unknown[] }>().drops.length).toBeLessThanOrEqual(FORGE.recentDropsPageSize);
    for (const bad of ['0', '-1', 'abc']) {
      const res = await app.inject({ method: 'GET', url: `/forge/drops/recent?limit=${bad}` });
      expect(res.statusCode, bad).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, bad).toBeLessThan(500);
    }
  });

  it('serves one query per cache window — a new drop shows only after the window rolls', async () => {
    resetRecentForgeDropsCache();
    const clock = T0 + 10 * 60_000;
    const first = await getRecentForgeDrops(db, { limit: 1 }, clock);
    const late = { wallet: randomWallet() };
    await db.insert(players).values({ wallet: late.wallet, name: 'LateWinner', nameKey: 'latewinner' });
    await settledDrop(late, '2020-02-01', ['powder_charge'], new Date(clock));
    const cached = await getRecentForgeDrops(db, { limit: 1 }, clock + (FORGE.recentDropsCacheSec - 1) * 1000);
    expect(cached.drops[0]).toEqual(first.drops[0]);
    const rolled = await getRecentForgeDrops(db, { limit: 1 }, clock + FORGE.recentDropsCacheSec * 1000);
    expect(rolled.drops[0]).toMatchObject({ itemId: 'powder_charge', winner: { name: 'LateWinner' } });
  });
});
