import { requiredFixture } from './helpers';
/**
 * Explicit one-parcel disclosure: enough public state to inspect a deed and
 * choose scout/attack, without turning the bulk globe into a roster or leaking
 * presence timestamps, exact balances, army, or a base layout. Shield timing is
 * intentionally public on this one selected parcel so protection is legible.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import {
  approximateLootRange, BuildingType, ECONOMY, LOOT, pvpMinDefenderKeep, STRUCTURES,
} from '@shardkeep/shared';
import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { buildings, players, plots, shields, valleys } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { availableParcelLootRanges, ensurePlotAssigned, getParcelDetail } from '../src/game/world';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts } from '../src/ledger';
import { TEST_CONFIG, connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const NOW = new Date('2026-08-11T12:00:00.000Z');
let app: FastifyInstance;
let key = 0;
const idem = (): string => `parcel-detail-${++key}-${Math.random().toString(36).slice(2)}`;
const oldLocationFlag = process.env['DEED_LOCATION_V2'];

interface Fixture {
  wallet: string;
  earthCell: number;
  siteId: number;
  x: number;
  y: number;
}

async function landowner(opts: {
  trophies?: number;
  keepLevel?: number;
  deed?: boolean;
  lootSurplus?: bigint;
  summaryBuildings?: boolean;
} = {}): Promise<Fixture> {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await db.update(players).set({
    entryPaidAt: new Date('2026-01-02T00:00:00.000Z'),
    trophies: opts.trophies ?? 500,
    keepLevel: opts.keepLevel ?? 4,
    name: `PARCEL_${p.wallet.slice(0, 8)}`,
    deedAssetId: opts.deed === false ? null : `deed-${p.wallet}`,
    lastSeenAt: new Date('2020-01-01T00:00:00.000Z'),
  }).where(eq(players.wallet, p.wallet));
  await ensurePlotAssigned(db, p.wallet);

  if (opts.summaryBuildings) {
    await db.insert(buildings).values([
      { playerWallet: p.wallet, type: BuildingType.Vault, level: 1, tx: 17, ty: 14 },
      { playerWallet: p.wallet, type: BuildingType.Cannon, level: 2, tx: 18, ty: 14 },
      { playerWallet: p.wallet, type: BuildingType.Wall, level: 1, tx: 19, ty: 14 },
    ]);
  }
  if ((opts.lootSurplus ?? 0n) > 0n) {
    const vault = opts.summaryBuildings ? BigInt(STRUCTURES.vault.capacity[0]!) : 0n;
    await rewardShards(db, p.wallet, vault + opts.lootSurplus!, 'test.parcel.loot', idem());
  }

  const [place] = await db.select({
    earthCell: plots.earthCell,
    siteId: valleys.siteId,
    x: plots.x,
    y: plots.y,
  }).from(plots).innerJoin(valleys, eq(valleys.id, plots.valleyId))
    .where(eq(plots.playerWallet, p.wallet));
  return { wallet: p.wallet, ...place!, earthCell: requiredFixture(place!.earthCell), x: requiredFixture(place!.x), y: requiredFixture(place!.y) };
}

async function session(): Promise<{ wallet: string; cookie: string }> {
  const secret = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secret));
  const challenge = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = challenge.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secret));
  const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  return {
    wallet,
    cookie: verified.cookies.find((c) => c.name === SESSION_COOKIE)!.value,
  };
}

beforeAll(async () => {
  process.env['DEED_LOCATION_V2'] = 'true';
  await bootstrapSystemAccounts(db);
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
});

afterAll(async () => {
  if (oldLocationFlag === undefined) delete process.env['DEED_LOCATION_V2'];
  else process.env['DEED_LOCATION_V2'] = oldLocationFlag;
  await app.close();
  await conn.sql.end();
});

describe('getParcelDetail', () => {
  it('uses the frozen address and canonical deed traits, with bounded base/loot/action state', async () => {
    const viewer = await landowner({ keepLevel: 4, trophies: 500 });
    const target = await landowner({
      keepLevel: 6,
      trophies: 520,
      lootSurplus: 20_000n,
      summaryBuildings: true,
    });

    const detail = await getParcelDetail(db, viewer.wallet, target.earthCell, NOW);
    expect(detail.parcel).toMatchObject({
      earthCell: target.earthCell,
      siteId: target.siteId,
      x: target.x,
      y: target.y,
    });
    expect(detail.parcel.country).not.toBeNull();
    expect(detail.player).toMatchObject({ wallet: target.wallet, keepLevel: 6, trophies: 520 });
    expect(detail.player.avatarUrl).toBeNull();
    expect(detail.deed.status).toBe('minted');
    expect(detail.deed.metadata.attributes).toContainEqual({
      trait_type: 'Tile', value: `Earth · ${target.earthCell}`,
    });
    expect(detail.base).toEqual({
      completedStructures: 4, // starter Keep + the three rows above
      defenses: 1,
      walls: 1,
      landWidth: 14,
    });
    expect(detail.shielded).toBe(false);
    expect(detail.warzone).toEqual({ active: false, boundaryAt: null, remainingMs: null });
    // keepReach carries the two levels the D-099 gate compared and the bar it
    // applied, so the client's "L6 vs your L4" line is the server's arithmetic.
    expect(detail.actions).toEqual({
      scout: { allowed: true, blockedBy: null },
      attack: {
        allowed: true, blockedBy: null,
        keepReach: { attackerKeep: 4, defenderKeep: 6, minDefenderKeep: pvpMinDefenderKeep(4) },
      },
    });
    const balance = 20_000n + BigInt(ECONOMY.starterShards)
      + BigInt(STRUCTURES.vault.capacity[0]!);
    const balancePool = balance * BigInt(LOOT.balanceLootableBps) / 10_000n;
    expect(detail.availableLootRanges).toEqual(availableParcelLootRanges(balancePool, 0n, [1]));

    // Exact response keys are the privacy boundary. The canonical deed DESCRIPTION
    // may mention that balances/army do not transfer, so inspect keys rather than
    // substring-matching prose.
    const keys = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(keys);
      if (value === null || typeof value !== 'object') return [];
      return Object.entries(value as Record<string, unknown>)
        .flatMap(([k, v]) => [k, ...keys(v)]);
    };
    expect(keys(detail)).not.toEqual(expect.arrayContaining([
      'lastSeenAt', 'balance', 'army', 'buildings', 'obstacles',
    ]));
  });

  it('reports mint-pending land without hiding the parcel', async () => {
    const viewer = await landowner();
    const target = await landowner({ deed: false });
    const detail = await getParcelDetail(db, viewer.wallet, target.earthCell, NOW);
    expect(detail.deed.assetId).toBeNull();
    expect(detail.deed.status).toBe('pending');
    expect(detail.deed.metadata.name).toBe('Land Deed');
    expect(detail.parcel.earthCell).toBe(target.earthCell);
  });

  it('resolves the selected owner avatar without widening any bulk world payload', async () => {
    const viewer = await landowner();
    const target = await landowner();
    const hash = 'a'.repeat(64);
    const generation = randomUUID();
    await db.update(players).set({
      avatarHash: hash, avatarGeneration: generation, avatarUpdatedAt: NOW,
    })
      .where(eq(players.wallet, target.wallet));
    const detail = await getParcelDetail(
      db, viewer.wallet, target.earthCell, NOW, undefined, 'https://objects.example.test',
    );
    expect(detail.player.avatarUrl).toBe(`/api/avatars/${generation}.webp`);
    expect(detail.player.avatarUrl).not.toContain(target.wallet);
    expect(detail.player.avatarUrl).not.toContain(hash);
    expect(detail.player.avatarUrl).not.toContain('objects.example.test');

    await db.update(players).set({ avatarHash: null, avatarGeneration: null })
      .where(eq(players.wallet, target.wallet));
    const withoutAvatar = await getParcelDetail(db, viewer.wallet, target.earthCell, NOW);
    expect(withoutAvatar.player.avatarUrl).toBeNull();
  });

  it('shows the authoritative shield source + expiry, disables ATTACK and leaves SCOUT open', async () => {
    // WHY (D-099, owner: "everyone can scout everyone. it should not be gated by
    // shield or anything else. only attacks should"): the preview used to block
    // both buttons on a shield; a scout refused by a shield taught nothing.
    const viewer = await landowner();
    const target = await landowner();
    await db.insert(shields).values({
      playerWallet: target.wallet,
      source: 'warzone',
      expiresAt: new Date('2026-08-12T12:00:00.000Z'),
    });

    const detail = await getParcelDetail(db, viewer.wallet, target.earthCell, NOW);
    expect(detail.shielded).toBe(true);
    expect(detail.shield).toEqual({
      active: true,
      source: 'warzone',
      expiresAt: new Date('2026-08-12T12:00:00.000Z'),
      remainingMs: 24 * 3_600_000,
      suppressedByWarzone: false,
    });
    expect(detail.actions).toEqual({
      scout: { allowed: true, blockedBy: null },
      attack: {
        allowed: false, blockedBy: 'shielded',
        keepReach: { attackerKeep: 4, defenderKeep: 4, minDefenderKeep: pvpMinDefenderKeep(4) },
      },
    });
  });

  it('does not protect a base merely because its owner is online', async () => {
    const viewer = await landowner({ trophies: 500 });
    const target = await landowner({ trophies: 500 });
    await db.update(players).set({ lastSeenAt: NOW }).where(eq(players.wallet, target.wallet));

    const detail = await getParcelDetail(db, viewer.wallet, target.earthCell, NOW);
    expect(detail.actions.scout).toEqual({ allowed: true, blockedBy: null });
    expect(detail.actions.attack).toMatchObject({ allowed: true, blockedBy: null });
    expect(detail).not.toHaveProperty('lastSeenAt');
  });

  it('gates ATTACK by Keep asymmetry — never by trophies — and leaves scouting available', async () => {
    // WHY (D-099): "KEEP 10 cannot attack KEEP 1; KEEP 1 can attack KEEP 10".
    // Trophies are deliberately far apart in the DIRECTION the old ±20 % window
    // refused, so a surviving trophy rule would flip either assertion. The K9
    // viewer stays under K10 so this fixture is never a legal auto-match target
    // for another suite's Keep-isolated K20 attacker.
    const strong = await landowner({ trophies: 500, keepLevel: 9 });
    const weak = await landowner({ trophies: 900, keepLevel: 3 });
    expect(pvpMinDefenderKeep(9)).toBeGreaterThan(3);

    const down = await getParcelDetail(db, strong.wallet, weak.earthCell, NOW);
    expect(down.actions.scout).toEqual({ allowed: true, blockedBy: null });
    expect(down.actions.attack).toEqual({
      allowed: false, blockedBy: 'keep_too_far_below',
      keepReach: { attackerKeep: 9, defenderKeep: 3, minDefenderKeep: pvpMinDefenderKeep(9) },
    });

    // The weaker side can always attack up: the risk is the attacker's own.
    const up = await getParcelDetail(db, weak.wallet, strong.earthCell, NOW);
    expect(up.actions.attack).toEqual({
      allowed: true, blockedBy: null,
      keepReach: { attackerKeep: 3, defenderKeep: 9, minDefenderKeep: pvpMinDefenderKeep(3) },
    });
  });

  it('404s an unclaimed address instead of fabricating a tile owner', async () => {
    const viewer = await landowner();
    await expect(getParcelDetail(db, viewer.wallet, 2_000_000_000, NOW))
      .rejects.toMatchObject({ statusCode: 404, message: 'parcel not found' });
  });
});

describe('availableParcelLootRanges', () => {
  it('shows combined private-source ranges for every star tier with no attacker-Keep cap', () => {
    // D-065: the low end assumes the best Vault stands (L1 shields 1.5 of the
    // 50 lootable points → 97% of the pool); the high end assumes every Vault
    // and Mine falls.
    const ranges = availableParcelLootRanges(100_000n, 7_000n, [1]);
    expect(ranges.oneStar).toEqual({
      min: approximateLootRange(24_250n).min,
      max: approximateLootRange(32_000n).max,
    });
    expect(ranges.twoStars).toEqual({
      min: approximateLootRange(48_500n).min,
      max: approximateLootRange(57_000n).max,
    });
    expect(ranges.threeStars).toEqual({
      min: approximateLootRange(97_000n).min,
      max: approximateLootRange(107_000n).max,
    });
    // A max-level standing Vault leaves 40% of the pool exposed; no Vault exposes it all.
    expect(availableParcelLootRanges(100_000n, 0n, [20, 4]).oneStar.min)
      .toBe(approximateLootRange(10_000n).min);
    expect(availableParcelLootRanges(100_000n, 0n, []).oneStar.min)
      .toBe(approximateLootRange(25_000n).min);
  });
});

describe('GET /map/parcel/:earthCell', () => {
  it('requires authentication and land, then returns one no-store parcel response', async () => {
    const target = await landowner();
    expect((await app.inject({ method: 'GET', url: `/map/parcel/${target.earthCell}` })).statusCode).toBe(401);

    const caller = await session();
    const cookies = { [SESSION_COOKIE]: caller.cookie };
    const unpaid = await app.inject({ method: 'GET', url: `/map/parcel/${target.earthCell}`, cookies });
    expect(unpaid.statusCode).toBe(402);

    await ensureStartingBase(db, caller.wallet);
    await db.update(players).set({
      entryPaidAt: new Date('2026-01-01T00:00:00.000Z'),
      trophies: 500,
      lastSeenAt: new Date('2020-01-01T00:00:00.000Z'),
    }).where(eq(players.wallet, caller.wallet));
    await ensurePlotAssigned(db, caller.wallet);

    const paid = await app.inject({ method: 'GET', url: `/map/parcel/${target.earthCell}`, cookies });
    expect(paid.statusCode).toBe(200);
    expect(paid.headers['cache-control']).toBe('private, no-store');
    expect(paid.json()).toMatchObject({
      parcel: { earthCell: target.earthCell },
      player: { wallet: target.wallet },
    });
  });
});
