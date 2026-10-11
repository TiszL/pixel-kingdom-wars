/**
 * GET /leagues/season: the read-only weekly season projection behind the
 * Leagues PRIZE tab. Players read these places and amounts as "who would win if
 * the week closed now", so the ordering, the one-kingdom-per-wallet rule and the
 * per-place SKR math must match the reviewed allocation (D153.285/.286), and a
 * pot that is not configured must never surface as a number.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { LEAGUE_SEASON_TEST_POT, LEAGUES, PHASE_E_LEAGUE_REWARDS } from '@shardkeep/shared';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { baseProfiles, bases, players, raids } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import {
  defaultSeasonPrizePolicy, getLeagueSeasonView, rankSeason, seasonPayoutTable,
  seasonPlaceAmountRaw, seasonYouReason, type SeasonCandidate,
} from '../src/game/leagueSeason';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, TEST_CONFIG } from './helpers';

const SKR = PHASE_E_LEAGUE_REWARDS.v1.skr;
const POT = 10_000_000_000n;
const MIN = LEAGUES.rewardMinAttackerRaids;

function candidate(over: Partial<SeasonCandidate> & { baseId: string }): SeasonCandidate {
  return {
    ownerWallet: `wallet-${over.baseId}`, name: over.baseId, trophies: 100, keepLevel: 5,
    ratedAttacks: MIN, weeklyScore: 10, ...over,
  };
}

describe('season payout table', () => {
  it('pays each place exactly what the reviewed allocation pays, flooring per place', () => {
    // Independent vectors: band 1 is the per-place share, bands 2 and 3 split
    // their whole share equally across every place in the band, filled or not.
    expect(seasonPlaceAmountRaw(1, POT)).toBe(POT * 600n / 10_000n);
    expect(seasonPlaceAmountRaw(10, POT)).toBe(POT * 170n / 10_000n);
    expect(seasonPlaceAmountRaw(11, POT)).toBe(POT * 3_500n / (10_000n * 90n));
    expect(seasonPlaceAmountRaw(100, POT)).toBe(POT * 3_500n / (10_000n * 90n));
    expect(seasonPlaceAmountRaw(101, POT)).toBe(POT * 3_500n / (10_000n * 400n));
    expect(seasonPlaceAmountRaw(500, POT)).toBe(POT * 3_500n / (10_000n * 400n));
    expect(() => seasonPlaceAmountRaw(0, POT)).toThrow(RangeError);
    expect(() => seasonPlaceAmountRaw(SKR.maxPlaces + 1, POT)).toThrow(RangeError);
  });

  it('covers places 1..maxPlaces contiguously, never pays more than the pot, and shares sum to the whole', () => {
    const table = seasonPayoutTable(POT);
    expect(table[0]!.fromPlace).toBe(1);
    expect(table.at(-1)!.toPlace).toBe(SKR.maxPlaces);
    for (let i = 1; i < table.length; i += 1) expect(table[i]!.fromPlace).toBe(table[i - 1]!.toPlace + 1);
    expect(table.reduce((sum, row) => sum + row.shareBps, 0)).toBe(SKR.basisPoints);
    const paid = table.reduce((sum, row) => sum + BigInt(row.amountRawEach!) * BigInt(row.toPlace - row.fromPlace + 1), 0n);
    expect(paid).toBeLessThanOrEqual(POT);
  });

  it('has no amounts at all when no pot is configured', () => {
    expect(seasonPayoutTable(null).every((row) => row.amountRawEach === null)).toBe(true);
  });

  it('shows the test pot only on devnet with the explicit switch on', () => {
    const prior = process.env['LEAGUE_SEASON_TEST_POT_ENABLED'];
    try {
      delete process.env['LEAGUE_SEASON_TEST_POT_ENABLED'];
      expect(defaultSeasonPrizePolicy('devnet').testPotEnabled).toBe(false);
      process.env['LEAGUE_SEASON_TEST_POT_ENABLED'] = 'true';
      expect(defaultSeasonPrizePolicy('devnet').testPotEnabled).toBe(true);
      expect(defaultSeasonPrizePolicy('mainnet-beta').testPotEnabled).toBe(false);
    } finally {
      if (prior === undefined) delete process.env['LEAGUE_SEASON_TEST_POT_ENABLED'];
      else process.env['LEAGUE_SEASON_TEST_POT_ENABLED'] = prior;
    }
  });
});

describe('season ranking', () => {
  it('orders by weekly score, then total trophies, then base id', () => {
    const ranked = rankSeason([
      candidate({ baseId: 'c', weeklyScore: 5, trophies: 50 }),
      candidate({ baseId: 'b', weeklyScore: 9, trophies: 10 }),
      candidate({ baseId: 'a', weeklyScore: 5, trophies: 50 }),
      candidate({ baseId: 'd', weeklyScore: 5, trophies: 70 }),
    ]);
    expect(ranked.map((row) => [row.baseId, row.place])).toEqual([['b', 1], ['d', 2], ['a', 3], ['c', 4]]);
  });

  it('places only reward candidates with a positive weekly score', () => {
    const ranked = rankSeason([
      candidate({ baseId: 'no-trophies', trophies: 0 }),
      candidate({ baseId: 'few-attacks', ratedAttacks: MIN - 1 }),
      candidate({ baseId: 'flat-week', weeklyScore: 0 }),
      candidate({ baseId: 'lost-week', weeklyScore: -4 }),
      candidate({ baseId: 'ok' }),
    ]);
    expect(ranked.map((row) => row.baseId)).toEqual(['ok']);
  });

  it('places one kingdom per wallet, the wallet reward candidate, even when another kingdom scored more', () => {
    const higherTier = candidate({ baseId: 'main', ownerWallet: 'w1', trophies: LEAGUES.thresholds[3]!, weeklyScore: 2 });
    const alt = candidate({ baseId: 'alt', ownerWallet: 'w1', trophies: LEAGUES.thresholds[1]!, weeklyScore: 30 });
    const ranked = rankSeason([alt, higherTier]);
    expect(ranked.map((row) => row.baseId)).toEqual(['main']);
    expect(seasonYouReason(alt, ranked, [alt, higherTier])).toBe('another_kingdom');
    expect(seasonYouReason(higherTier, ranked, [alt, higherTier])).toBe('placed');
  });

  it('says what the selected kingdom still needs', () => {
    const none: never[] = [];
    expect(seasonYouReason(candidate({ baseId: 'x', trophies: 0 }), none, [])).toBe('needs_trophies');
    const fewer = candidate({ baseId: 'x', ratedAttacks: MIN - 1 });
    expect(seasonYouReason(fewer, none, [fewer])).toBe('needs_rated_attacks');
    const flat = candidate({ baseId: 'x', weeklyScore: 0 });
    expect(seasonYouReason(flat, none, [flat])).toBe('needs_weekly_score');
  });

  it('never places more than maxPlaces kingdoms', () => {
    const many = Array.from({ length: SKR.maxPlaces + 3 }, (_, i) => candidate({ baseId: `b${String(i).padStart(4, '0')}` }));
    expect(rankSeason(many)).toHaveLength(SKR.maxPlaces);
  });
});

const conn = connectTestDb();
const db = conn.db;
const DAY_MS = 86_400_000;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
let sequence = 0;

/** A Monday far beyond every other fixture's raids, so only this file's raids count. */
function isolatedWeek(): Date {
  // A different far-future year on every run, so a re-run never meets its own old raids.
  const year = 3000 + Math.floor(Date.now() / 1_000) % 6_000;
  const jan8 = new Date(Date.UTC(year, 0, 8));
  return new Date(jan8.getTime() - ((jan8.getUTCDay() + 6) % 7) * DAY_MS);
}

async function landedBase(trophies: number, name: string): Promise<{ wallet: string; baseId: string }> {
  const wallet = bs58.encode(await getPublicKeyAsync(utils.randomSecretKey()));
  await db.insert(players).values({ wallet });
  await db.update(players).set({ name }).where(eq(players.wallet, wallet));
  await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  await ensureStartingBase(db, wallet);
  const baseId = await ensureWalletBaseIdentity(db, wallet);
  if (!baseId) throw new Error('fixture base identity missing');
  const deed = `league-season-fixture-${baseId}`;
  await db.update(bases).set({
    deedAssetId: deed, deedMintAssetId: deed, landPaidAt: new Date(), status: 'active', keepLevel: 7,
  }).where(eq(bases.id, baseId));
  await db.insert(baseProfiles).values({ baseId, trophies })
    .onConflictDoUpdate({ target: baseProfiles.baseId, set: { trophies } });
  return { wallet, baseId };
}

async function ratedRaid(
  attacker: { wallet: string; baseId: string }, defender: { wallet: string; baseId: string },
  resolvedAt: Date, attackerDelta: number,
): Promise<void> {
  await db.insert(raids).values({
    attackerWallet: attacker.wallet, attackerBaseId: attacker.baseId,
    defenderWallet: defender.wallet, defenderBaseId: defender.baseId,
    seed: BigInt(Date.now()) * 1_000n + BigInt(++sequence),
    snapshot: {}, armySnapshot: {}, ordersDeadlineAt: resolvedAt, status: 'resolved', resolvedAt,
    result: { stars: attackerDelta > 0 ? 2 : 0, destructionPct: 50, keepDestroyed: false, lootShards: 0,
      attackerTrophyDelta: attackerDelta, defenderTrophyDelta: -attackerDelta },
  });
}

afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  await conn.sql.end();
});

describe('league season view (database)', () => {
  beforeAll(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });

  it('projects this week from resolved rated raids and prices places only with a pot', async () => {
    const monday = isolatedWeek();
    const at = (minutes: number) => new Date(monday.getTime() + minutes * 60_000);
    const winner = await landedBase(400, 'Season winner');
    const runnerUp = await landedBase(300, 'Season runner up');
    const victim = await landedBase(200, 'Season victim');
    for (let i = 0; i < MIN; i += 1) {
      await ratedRaid(winner, victim, at(10 + i), 9);
      await ratedRaid(runnerUp, victim, at(20 + i), 4);
    }
    // Last week's raid is outside the season and must not count.
    await ratedRaid(runnerUp, victim, new Date(monday.getTime() - 60_000), 50);
    const now = at(60 * 24 * 3);

    const dark = await getLeagueSeasonView(db, winner.wallet, winner.baseId, { testPotEnabled: false }, now);
    expect(dark.season.startsAt).toBe(monday.toISOString());
    expect(dark.season.closesAt).toBe(new Date(monday.getTime() + 7 * DAY_MS).toISOString());
    expect(dark.prize).toMatchObject({ status: 'unset', potRaw: null, decimals: null });
    expect(dark.standings.leaders.map((row) => [row.baseId, row.place, row.weeklyScore])).toEqual([
      [winner.baseId, 1, 9 * MIN], [runnerUp.baseId, 2, 4 * MIN],
    ]);
    expect(dark.standings.leaders.every((row) => row.amountRaw === null)).toBe(true);
    expect(dark.standings.you).toMatchObject({ baseId: winner.baseId, place: 1, reason: 'placed', amountRaw: null });
    expect(dark.tierRewards.keepLevel).toBe(7);
    expect(dark.tierRewards.tiers.map((row) => row.fromTrophies)).toEqual([...LEAGUES.thresholds]);

    const lit = await getLeagueSeasonView(db, victim.wallet, victim.baseId, { testPotEnabled: true }, now);
    const pot = BigInt(LEAGUE_SEASON_TEST_POT.potRaw);
    expect(lit.prize).toMatchObject({ status: 'devnet_test', potRaw: pot.toString(), decimals: LEAGUE_SEASON_TEST_POT.decimals });
    expect(lit.standings.leaders[0]!.amountRaw).toBe(seasonPlaceAmountRaw(1, pot).toString());
    expect(lit.standings.leaders[1]!.amountRaw).toBe(seasonPlaceAmountRaw(2, pot).toString());
    // The raided kingdom lost trophies this week: listed as you, never placed.
    expect(lit.standings.you).toMatchObject({ baseId: victim.baseId, place: null, amountRaw: null });
    expect(lit.standings.leaders.some((row) => row.baseId === victim.baseId)).toBe(false);
  });
});

describe('GET /leagues/season route', () => {
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    process.env['MULTI_BASE_ENABLED'] = 'false';
    app = await buildApp({ ...TEST_CONFIG }, db);
  });
  afterAll(async () => {
    await app?.close();
    process.env['MULTI_BASE_ENABLED'] = 'true';
  });

  it('is authenticated, read-only and shows no pot unless configured', async () => {
    expect((await app!.inject({ method: 'GET', url: '/leagues/season' })).statusCode).toBe(401);
    const secretKey = utils.randomSecretKey();
    const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
    const challenge = await app!.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
    const message = (challenge.json() as { message: string }).message;
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
    const verified = await app!.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
    const cookie = verified.cookies.find(({ name }) => name === SESSION_COOKIE)!.value;
    const response = await app!.inject({ method: 'GET', url: '/leagues/season', cookies: { [SESSION_COOKIE]: cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ prize: { currency: 'SKR', ranking: 'weekly_net', maxPlaces: SKR.maxPlaces } });
    if (process.env['LEAGUE_SEASON_TEST_POT_ENABLED'] !== 'true') {
      expect(body.prize).toMatchObject({ status: 'unset', potRaw: null });
    }
  });
});
