/**
 * THE LAND PARTITION — deedless and landowning bases are two SEALED matchmaking
 * pools (locked owner decision 2026-08-09, docs/LAND-DEED-ONBOARDING-PLAN.md).
 *
 * WHY these tests exist and what they encode:
 * Free onboarding gives a player a base with NO parcel. A plotless base produces
 * no `plots INNER JOIN players` row, so it is invisible on the map — and that
 * invisibility is the ONLY thing protecting it, because the owner explicitly
 * rejected a standing shield row (it would have coupled protection to deed state
 * and broken INV-1). Invisibility is not enough on its own: `createRaid` and
 * `scoutBase` both look a defender up BY WALLET, not through the roster, so a
 * wallet obtained out-of-band would reach straight past the map. The partition is
 * what closes that, and these are the adversarial cases that would pass if it were
 * removed:
 *   - a deedless attacker naming a landowner's wallet explicitly,
 *   - a landowner naming a deedless wallet explicitly,
 *   - either side being handed the other by AUTO-MATCH,
 *   - a landowner scouting a deedless layout.
 * Each is asserted to fail with the SAME 404 as an unknown wallet, so the boundary
 * is not an existence oracle either.
 *
 * Trophy anchors are far above every other suite's values (max ~1,210) and unique
 * per test, so the nearest-rated candidate page always starts with this test's
 * own fixtures. Since D-099 trophies only ORDER that page — the Keep rule is the
 * filter — so every auto-match ATTACKER here is K20 (bar: defender ≥ K10) and
 * shielded from birth, and no other suite leaves an unshielded K≥10 base with a
 * Keep behind (raids.test.ts keeps its own high-Keep attackers shielded and its
 * auto-match defenders at K9). If a future suite needs one, shield it there.
 */
import { pvpMinDefenderKeep } from '@shardkeep/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bases, players, questProgress, quests, shields } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { hasLand, landTierFilter, sameLandTier } from '../src/game/land';
import { createRaid } from '../src/game/raids';
import { ensurePlotAssigned, scoutBase, searchPlayers } from '../src/game/world';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `lp-${++key}-${Math.random().toString(36).slice(2)}`;

const created: string[] = [];

/** A base at `trophies` and `keepLevel`. `land` stamps entryPaidAt — the ONE land
 *  predicate. The Keep is the D-099 attack gate's input. */
async function base(trophies: number, land: boolean, keepLevel = 1) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await rewardShards(db, p.wallet, 100_000n, 'test.fund.shards', k());
  await db.update(players)
    .set({ trophies, keepLevel, ...(land ? { entryPaidAt: new Date() } : {}) })
    .where(eq(players.wallet, p.wallet));
  created.push(p.wallet);
  return p.wallet;
}

/**
 * Retire every fixture after its test: a far-future shield plus trophies back to 0.
 *
 * The SHIELD is for this file — auto-match has no trophy band since D-099, so an
 * earlier test's K10 fixtures would be legal survivors for a later test's K20
 * attacker and the assertions would depend on execution order. A shield is the
 * game's own way of saying "not a candidate", so this parks them without
 * inventing a mechanism.
 *
 * The TROPHY RESET is for everyone else, and it is the courtesy this file owes the
 * shared DB: `runWeeklyLeagueReset` splits the KEEP prize pool EQUALLY among every
 * player in the gold/sol tiers, globally, so ~two dozen bases parked at 40k–90k
 * trophies would silently dilute social.test's per-player payout assertions. Back
 * at 0 they are bronze, which the reset does not pay.
 */
afterEach(async () => {
  const batch = created.splice(0);
  if (batch.length === 0) return;
  await db.insert(shields).values(batch.map((w) => ({
    playerWallet: w, source: 'loss' as const, expiresAt: new Date('2999-01-01T00:00:00Z'),
  })));
  await db.update(players).set({ trophies: 0, league: 'bronze' })
    .where(inArray(players.wallet, batch));
});

/** The error a rejected raid/scout throws, as { statusCode, message, code }. */
async function reject(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { statusCode?: number; message?: string; code?: string };
    return { statusCode: err.statusCode, message: err.message, code: err.code };
  }
  throw new Error('expected a rejection, got success');
}

/**
 * Isolation for the whole file: with trophies demoted to a SORT (D-099), any
 * unshielded K≥10 base another suite left behind is a legal survivor on this
 * file's candidate page, and the uniform pick among the nearest ten would make
 * every "expects exactly legit / expects a rejection" assertion depend on what
 * ran before. Park every pre-existing wallet behind a far-future shield for the
 * duration of this file — the game's own "not a candidate" — and lift it after.
 */
const parked: string[] = [];
beforeAll(async () => {
  await bootstrapSystemAccounts(db);
  // Stable-mode wallets carry their shields per BASE (the database refuses a
  // wallet-only shield for them: BASE_ID_REQUIRED); legacy wallets have no base
  // row and take the wallet-only shield the fixtures below also use.
  const far = new Date('2999-01-01T00:00:00Z');
  const baseRows = await db.select({ id: bases.id, owner: bases.ownerWallet }).from(bases);
  const withBase = new Set(baseRows.map((b) => b.owner));
  const others = await db.select({ wallet: players.wallet }).from(players);
  const values = [
    ...baseRows.map((b) => ({ playerWallet: b.owner, baseId: b.id, source: 'loss' as const, expiresAt: far })),
    ...others.filter((p) => !withBase.has(p.wallet))
      .map((p) => ({ playerWallet: p.wallet, source: 'loss' as const, expiresAt: far })),
  ];
  if (values.length > 0) {
    const rows = await db.insert(shields).values(values).returning({ id: shields.id });
    parked.push(...rows.map((r) => r.id));
  }
});
afterAll(async () => {
  if (parked.length > 0) await db.delete(shields).where(inArray(shields.id, parked));
  await conn.sql.end();
});

describe('land.ts — the one predicate', () => {
  it('reads entryPaidAt, and sameLandTier is symmetric on both sides', () => {
    // WHY entryPaidAt and not "has a plot": it is the AUTHORIZATION column the
    // route gate already reads. A second, derived predicate for the same concept
    // is how two sources of truth drift apart — and a paid player whose plot
    // assignment transiently failed must not fall into the free pool.
    expect(hasLand({ entryPaidAt: new Date() })).toBe(true);
    expect(hasLand({ entryPaidAt: null })).toBe(false);
    const owner = { entryPaidAt: new Date() };
    const free = { entryPaidAt: null };
    expect(sameLandTier(owner, owner)).toBe(true);
    expect(sameLandTier(free, free)).toBe(true);
    expect(sameLandTier(owner, free)).toBe(false);
    expect(sameLandTier(free, owner)).toBe(false);
  });

  it('the SQL filter selects one pool and never the other (not swapped)', async () => {
    // A swapped isNull/isNotNull would silently invert the whole partition while
    // every "cross-tier is refused" test still passed — so assert against real
    // rows, in both directions, rather than trusting the call site.
    const owner = await base(90_000, true);
    const free = await base(90_000, false);
    const owners = await db.select({ w: players.wallet }).from(players)
      .where(and(landTierFilter(true), inArray(players.wallet, [owner, free])));
    const frees = await db.select({ w: players.wallet }).from(players)
      .where(and(landTierFilter(false), inArray(players.wallet, [owner, free])));
    expect(owners.map((r) => r.w)).toEqual([owner]);
    expect(frees.map((r) => r.w)).toEqual([free]);
  });
});

describe('createRaid — explicitly named defenders cannot cross the boundary', () => {
  it('refuses a DEEDLESS attacker naming a LANDOWNER, with the unknown-wallet 404', async () => {
    // The adversarial case: POST /raids stays reachable by deedless players (auto-
    // match is their only PvP), so route gating cannot stop them from putting a
    // landowner's wallet in the body. If this check were removed, a free account
    // could farm paid bases it is not even allowed to see.
    const attacker = await base(40_000, false);
    const target = await base(40_000, true);
    const err = await reject(() => createRaid(db, attacker, { defenderWallet: target, idempotencyKey: k() }));
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('defender not found');
  });

  it('refuses a LANDOWNER naming a DEEDLESS base, with the unknown-wallet 404', async () => {
    // The reverse: a deedless base has no map row, so a landowner can only have
    // got the wallet out-of-band. It must read as "not in the world".
    const attacker = await base(41_000, true);
    const target = await base(41_000, false);
    const err = await reject(() => createRaid(db, attacker, { defenderWallet: target, idempotencyKey: k() }));
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('defender not found');
  });

  it('is indistinguishable from a wallet that does not exist (no existence oracle)', async () => {
    // The cross-tier refusal fires BEFORE the trophy/shield checks and reuses the
    // same message with no code, so probing cannot tell "deedless base" from
    // "no such player". A distinguishable error would make the invisible pool
    // enumerable, which is exactly what the no-map-row design is protecting.
    const attacker = await base(42_000, true);
    const deedless = await base(42_000, false);
    const missing = await reject(() => createRaid(db, attacker, { defenderWallet: 'nOtAwAlLeT', idempotencyKey: k() }));
    const crossed = await reject(() => createRaid(db, attacker, { defenderWallet: deedless, idempotencyKey: k() }));
    expect(crossed).toEqual(missing);
    expect(crossed.code).toBeUndefined();
  });

  it('still allows a raid INSIDE each pool (the partition is not a blanket ban)', async () => {
    const freeA = await base(43_000, false);
    const freeB = await base(43_000, false);
    const raid = await createRaid(db, freeA, { defenderWallet: freeB, idempotencyKey: k() });
    expect(raid.defenderWallet).toBe(freeB);

    const paidA = await base(44_000, true);
    const paidB = await base(44_000, true);
    const paidRaid = await createRaid(db, paidA, { defenderWallet: paidB, idempotencyKey: k() });
    expect(paidRaid.defenderWallet).toBe(paidB);
  });
});

/** The Keep every auto-match attacker below fights at, and the bar it implies
 *  for a defender (K20 → ≥ K10). One number, so the isolation argument in the
 *  header is checkable. */
const ATTACKER_KEEP = 20;
const BAR = pvpMinDefenderKeep(ATTACKER_KEEP);

/** An AUTO-MATCH attacker: K20 (bar: defender ≥ K10) and shielded from birth —
 *  a shield never stops its owner attacking, and it keeps this K20 base off
 *  every other test's candidate page while its own test is still running. */
async function raider(trophies: number, land: boolean) {
  const w = await base(trophies, land, ATTACKER_KEEP);
  await db.insert(shields).values({
    playerWallet: w, source: 'loss', expiresAt: new Date('2999-01-01T00:00:00Z'),
  });
  return w;
}

describe('createRaid — auto-match draws from one pool only', () => {
  it('never hands a DEEDLESS attacker a landowner, even as the only candidate on the page', async () => {
    // The pool is capped at autoMatchCandidatePool nearest-rated rows, which is
    // why the filter has to be in the SQL: a post-filter would burn the whole page
    // on the wrong pool and report a false "no eligible targets".
    const attacker = await raider(50_000, false);
    await base(50_000, true, ATTACKER_KEEP); // perfect rating AND Keep match — but on the other side of the line
    const err = await reject(() => createRaid(db, attacker, { idempotencyKey: k() }));
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('no_targets_deedless');
  });

  it('never hands a LANDOWNER a deedless base, even as the only candidate on the page', async () => {
    const attacker = await raider(51_000, true);
    await base(51_000, false, ATTACKER_KEEP);
    const err = await reject(() => createRaid(db, attacker, { idempotencyKey: k() }));
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('no_targets');
  });

  it('matches a deedless attacker to the deedless base and skips the landowner beside it', async () => {
    const attacker = await raider(52_000, false);
    const decoy = await base(52_000, true, ATTACKER_KEEP);   // nearer-rated, wrong pool
    const legit = await base(52_100, false, BAR);
    const raid = await createRaid(db, attacker, { idempotencyKey: k() });
    expect(raid.defenderWallet).toBe(legit);
    expect(raid.defenderWallet).not.toBe(decoy);
  });

  it('matches a landowner to the landowner and skips the deedless base beside it', async () => {
    const attacker = await raider(53_000, true);
    const decoy = await base(53_000, false, ATTACKER_KEEP);
    const legit = await base(53_100, true, BAR);
    const raid = await createRaid(db, attacker, { idempotencyKey: k() });
    expect(raid.defenderWallet).toBe(legit);
    expect(raid.defenderWallet).not.toBe(decoy);
  });

  it('never hands out a SHIELDED base, even when it is the only one at the bar', async () => {
    // WHY: with no trophy band (D-099) the shield filter is what keeps a base
    // that just lost from being farmed on repeat, in BOTH pools — and it is the
    // isolation every empty-pool assertion in this file leans on, so it is
    // proven here explicitly rather than assumed.
    const attacker = await raider(54_000, true);
    const parked = await base(54_000, true, BAR);
    await db.insert(shields).values({
      playerWallet: parked, source: 'loss', expiresAt: new Date(Date.now() + 3_600_000),
    });
    const err = await reject(() => createRaid(db, attacker, { idempotencyKey: k() }));
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('no_targets');
    const live = await base(54_100, true, BAR);
    const raid = await createRaid(db, attacker, { idempotencyKey: k() });
    expect(raid.defenderWallet).toBe(live);
    expect(raid.defenderWallet).not.toBe(parked);
  });

  it('applies the Keep gate INSIDE the pool, never across it', async () => {
    // D-099 replaced the trophy band (and its widening retry) with the Keep rule.
    // It must still be sealed: a free cohort with nobody above the bar is not a
    // reason to serve up a paid base that clears it. `low` shares the pool and the
    // rating but sits one level under the bar; `legit` clears it exactly.
    const anchor = 60_000;
    const attacker = await raider(anchor, false);
    await base(anchor, true, ATTACKER_KEEP);              // clears the bar, wrong pool
    const low = await base(anchor, false, BAR - 1);       // right pool, under the bar
    const empty = await reject(() => createRaid(db, attacker, { idempotencyKey: k() }));
    expect(empty.code).toBe('no_targets_deedless');
    expect(empty.message).toMatch(new RegExp(`KEEP ≥ ${BAR}`));
    const legit = await base(anchor + 100, false, BAR);
    const raid = await createRaid(db, attacker, { idempotencyKey: k() });
    expect(raid.defenderWallet).toBe(legit);
    expect(raid.defenderWallet).not.toBe(low);
  });

  it('tells the two empty pools apart — the deedless 404 never says "world map or PvE" — and both name the Keep bar', async () => {
    // The client shows this message. A deedless player has neither the world map
    // nor the PvE bounty (both are land-gated), so the landowner copy would send
    // them at two screens they cannot open. Both lines state the D-099 restriction
    // ("KEEP ≥ 10"): a bare "no eligible targets" reads as a quiet server when it
    // is a rule the player can act on.
    const freeAttacker = await raider(70_000, false);
    const paidAttacker = await raider(71_000, true);
    const free = await reject(() => createRaid(db, freeAttacker, { idempotencyKey: k() }));
    const paid = await reject(() => createRaid(db, paidAttacker, { idempotencyKey: k() }));
    expect(free.code).toBe('no_targets_deedless');
    expect(paid.code).toBe('no_targets');
    expect(free.message).not.toBe(paid.message);
    expect(free.message).not.toMatch(/world map/i);
    expect(paid.message).toMatch(/world map/i);
    expect(free.message).toMatch(new RegExp(`KEEP ≥ ${BAR}`));
    expect(paid.message).toMatch(new RegExp(`KEEP ≥ ${BAR}`));
  });
});

describe('scoutBase — target PICKING respects the same boundary', () => {
  it('refuses a landowner scouting a deedless layout, and the reverse', async () => {
    // scoutBase looks the target up by WALLET, not through the plots-joined
    // roster, so route gating cannot cover it: without this check a landowner
    // handed a deedless wallet could read that base's full building layout even
    // though it has no map row to click.
    const owner = await base(80_000, true);
    const free = await base(80_000, false);
    // Keep this synthetic quest off today's shared rotating board. Vitest files
    // share the test database and social.test owns the current-day count.
    const now = new Date('2099-01-02T12:00:00.000Z');
    const day = now.toISOString().slice(0, 10);
    await db.insert(quests).values({
      scope: 'daily', templateCode: 'scout_3', target: 3,
      rewardKeep: 10n, activeOn: day,
    }).onConflictDoNothing();
    const [scoutQuest] = await db.select().from(quests).where(and(
      eq(quests.scope, 'daily'), eq(quests.activeOn, day), eq(quests.templateCode, 'scout_3'),
    ));
    expect(scoutQuest).toBeDefined();

    await expect(scoutBase(db, owner, free, now)).rejects.toThrow(/player not found/);
    await expect(scoutBase(db, free, owner, now)).rejects.toThrow(/player not found/);
    const leaked = await db.select().from(questProgress).where(and(
      eq(questProgress.questId, scoutQuest!.id),
      inArray(questProgress.playerWallet, [owner, free]),
    ));
    // The partition uses a deliberately indistinguishable 404. Neither direction
    // may leak validity through the side effect of a newly progressed quest.
    expect(leaked).toHaveLength(0);
  });

  it('still scouts inside each pool', async () => {
    const a = await base(81_000, false);
    const b = await base(81_000, false);
    await expect(scoutBase(db, a, b)).resolves.toMatchObject({ wallet: b });
    const c = await base(82_000, true);
    const d = await base(82_000, true);
    await expect(scoutBase(db, c, d)).resolves.toMatchObject({ wallet: d });
  });
});

describe('GET /map/search cannot surface the invisible pool', () => {
  it('lists a base with a parcel and omits a plotless one, searched by name prefix', async () => {
    // WHY: searchPlayers used to LEFT JOIN plots, so a deedless base came back with
    // a null valleyId — handing out the one thing the no-map-row design withholds,
    // a wallet from the pool a landowner may not touch, by NAME PREFIX. It is now
    // an INNER JOIN, the same `plots INNER JOIN players` rule the valley roster
    // uses, so search and the map agree on who exists. The parcel is assigned
    // through the PRODUCTION path (never a hand-inserted valley — that would leave
    // a camp-less valley as "the newest with room" and hijack another suite's signup).
    const tag = `LPSEARCH${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const settled = await base(85_000, true);
    const plotless = await base(85_000, false);
    await db.update(players).set({ name: `${tag}_SETTLED` }).where(eq(players.wallet, settled));
    await db.update(players).set({ name: `${tag}_PLOTLESS` }).where(eq(players.wallet, plotless));
    await ensurePlotAssigned(db, settled);

    const { results } = await searchPlayers(db, tag);
    expect(results.map((r) => r.wallet)).toEqual([settled]);
  });
});

describe('INV-1 stays intact', () => {
  it('the raid path still reads no deed/NFT state', async () => {
    // The recorded "list-to-dodge-attacks" fix (ITEMS plan §8, MARKETPLACE spec
    // INV-1). What that fix forbids — attackability depending on deed or DAS state,
    // which now actually trades — is what this asserts, and it is the half that
    // matters. INV-1's three-factor FORM is stale as of 2026-08-09 (F9): the
    // predicate is (base exists) × shield × warzone × sameLandTier (src/game/land.ts),
    // because this partition added a factor. It is keyed on the PAYMENT column, not
    // on the NFT — hence the CI-able one-liner the plan asked for (risk R9).
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/game/raids.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/deedAssetId/);
    // AND NOT THE EARTH TILE EITHER (EARTH-TILES-PLAN R5). Since P5 every parcel
    // carries a real country, so "which country is your land in" is now a fact the
    // raid path could reach for — and the moment it does, attackability depends on
    // geography and a player can pick a country to dodge attacks. The partition is
    // the PAYMENT column and nothing else.
    expect(src).not.toMatch(/earth_?[Cc]ell/);
    // …NOR THE COUNTRY, which since D1 (2026-08-10) is its own column and therefore
    // its own temptation: `country_a3` is one join away from any raid query, and
    // "same country" is exactly the kind of factor that would let a player choose
    // where to live to dodge attacks. Same rule, second column.
    expect(src).not.toMatch(/country_?[Aa]3/);
  });
});
