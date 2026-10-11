/**
 * THE LAND GATE (docs/LAND-DEED-ONBOARDING-PLAN.md §2.2 + LOCKED OWNER DECISIONS
 * 2026-08-09). Onboarding stops being a paywall; buying land (0.2 SOL, on-chain,
 * `players.entryPaidAt`) is what unlocks the Gold Forge, selling on the market,
 * raiding landowners, PvE bounties, clans and withdrawals.
 *
 * WHAT THESE TESTS ENCODE — the intent, not the mechanics:
 *
 *  1. THE DEED IS BOUGHT, NOT GIVEN. `mintDeedIfConfigured` is called from the
 *     now-FREE GET /base. Without the payment check in its claim WHERE, every
 *     visitor is minted a real, collection-verified, royalty-bearing Land Deed
 *     and the entire model inverts. This is the highest-consequence line in the
 *     change and the cheapest to lose in a merge.
 *  2. THE FORGE IS A BUILDING, NOT A ROUTE. `goldforge` is placed through the
 *     free POST /base/buildings, so gating the six /forge/* routes leaves the
 *     only shards→KEEP faucet reachable — and KEEP is the only withdrawable
 *     currency, so that would be a free-tier money printer.
 *  3. A FREE BASE IS NEVER OVERWRITTEN. baseTransfer's buyer-baseless test used
 *     to be one condition; free onboarding makes it reject every free builder,
 *     and "fixing" it by dropping the buildings check would merge a purchased
 *     base into theirs and destroy their work.
 *  4. NO LAND ⇒ NO PLOT ⇒ NO MAP ROW. The valley roster is
 *     `plots INNER JOIN players`, so a landless player is invisible to
 *     landowners. That absence IS the protection: no shield row, and NOTHING in
 *     the raid path reads deed or DAS state. Attackability is now
 *     `(base exists) × shield × warzone × sameLandTier(attacker, defender)`
 *     (game/land.ts) — INV-1's three-factor form is stale as of 2026-08-09 (F9),
 *     and the half that matters is intact: selling or listing a deed can never
 *     change who may attack you.
 *  5. THE KILL SWITCH RESTORES AUTHORIZATION AND EXISTENCE, NOT EVERY STRING.
 *     With FREE_ONBOARDING off, every route that flips is gated again, the
 *     always-auth-only ones stay auth-only, and no base/plot/starter grant exists
 *     before the entry credit. The 402's message and code are UNCONDITIONAL by
 *     design — asserted below in BOTH flag states, because config.ts and
 *     auth/session.ts both promise exactly that (security review F2).
 *  6. AN UNAUTHORIZED STRANGER CANNOT BUILD THE WORLD. Sign-in is deliberately
 *     not alpha-gated, so the starting base hangs off the first ALPHA-PASSING
 *     authenticated touch instead (F3).
 *  7. A PAID PURCHASE ALWAYS SETTLES, and key EXPORT is a custody right that
 *     survives losing your land (F6, F8).
 *
 * THE ROUTE TABLE IS DERIVED FROM THE REAL ROUTER, not hand-listed: `deriveGroups`
 * enumerates every registration with an `onRoute` hook in both flag states and
 * classifies it by whether its preHandler chain actually contains
 * `requireLandOwned`. The probe tables below must then cover that set EXACTLY —
 * a new route with no entry fails, an entry for a route that does not exist
 * fails, and a route whose group disagrees with the router fails. That is what
 * makes "a new route cannot quietly land on the wrong side of the gate" true
 * rather than aspirational (security review F14).
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { and, eq, isNull, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { BuildingType, MARKETPLACE, MINING, OBSTACLES, UPGRADE_COSTS, upgradeSolLamports } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The forge routes are registered only when FORGE_ENABLED !== 'false' (routes.ts).
// Pinned here so this suite asserts 402-vs-200 rather than accidentally asserting
// 404 for a surface the ops switch happened to have turned off.
process.env['FORGE_ENABLED'] = 'true';

import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import {
  alphaAccess, baseAbandons, bases, builderJobs, emailOtps, itemListings, mineState, obstacles, playerItems, players, plots,
} from '../src/db/schema';
import { RECENT_AUTH_HEADER, SESSION_COOKIE, type RecentAuthPurpose } from '../src/auth/session';
import { configureDeedMinter, mintDeedIfConfigured, type DeedMinter } from '../src/game/deed';
import { clearObstacle, ensureStartingBase, placeBuilding, upgradeBuilding, completeDueJobs } from '../src/game/base';
import { collectMine, ensureMineState } from '../src/game/emission';
import { abandonFreeBase, transferBase } from '../src/game/baseTransfer';
import { getMapChunk } from '../src/game/world';
import { registerGameRoutes } from '../src/game/routes';
import { registerWorkshopRoutes } from '../src/game/workshopRoutes';
import { createFreeBasePurchaseProvider, registerFreeBasePurchaseRoutes } from '../src/game/freeBasePurchaseRoutes';
import { createMiningContributionProvider } from '../src/game/miningContributionRoutes';
import { registerStarterFleetRoutes } from '../src/game/starterFleetRoutes';
import { registerStarterExpeditionRoutes } from '../src/game/starterExpeditionRoutes';
import { registerOrdinaryCraftingRoutes } from '../src/game/ordinaryCraftingRoutes';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';

// Exercise the new placement's admission while its independent rollout is ON.
// Missing/malformed/off rollout and historical recovery are covered separately.
const priorWallBatchFlag = process.env['WALL_BATCH_V1_ENABLED'];
beforeAll(() => { process.env['WALL_BATCH_V1_ENABLED'] = 'true'; });
afterAll(() => {
  if (priorWallBatchFlag === undefined) delete process.env['WALL_BATCH_V1_ENABLED'];
  else process.env['WALL_BATCH_V1_ENABLED'] = priorWallBatchFlag;
});
const priorHeroRecruitmentFlag = process.env['HERO_RECRUITMENT_ENABLED'];
beforeAll(() => { process.env['HERO_RECRUITMENT_ENABLED'] = 'true'; });
afterAll(() => {
  if (priorHeroRecruitmentFlag === undefined) delete process.env['HERO_RECRUITMENT_ENABLED'];
  else process.env['HERO_RECRUITMENT_ENABLED'] = priorHeroRecruitmentFlag;
});
import { rewardShards } from '../src/game/spend';
import { resetMapCache } from '../src/lib/mapCache';
import { TEST_CONFIG, connectTestDb, createTestPlayer, fundTestKeep, randomWallet } from './helpers';
import { isolateDeedTestFixtures } from './deed-fixtures';

const conn = connectTestDb();
const db = conn.db;
let marketSignatureNonce = 0;
const marketSignatureOf = (byte: number): string => {
  // Signatures are globally single-use across the shared item-listing table.
  // Include a per-call nonce so a broad sequential run cannot collide with the
  // item-market suite's own deterministic signature fixtures.
  const bytes = new Uint8Array(64).fill(byte);
  new DataView(bytes.buffer).setUint32(60, ++marketSignatureNonce);
  return bs58.encode(bytes);
};

/** A real signed session, the way the client gets one. */
async function signIn(app: FastifyInstance): Promise<{ wallet: string; cookie: string; secretKey: Uint8Array }> {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  expect(verify.statusCode).toBe(200);
  return { wallet, secretKey, cookie: verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
}

const buyLand = async (wallet: string): Promise<void> => {
  const paidAt = new Date();
  await db.transaction(async (tx) => {
    await tx.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    await tx.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
  });
};

const deedOf = async (wallet: string): Promise<string | null> => {
  const [p] = await db.select({ d: players.deedAssetId }).from(players).where(eq(players.wallet, wallet));
  return p?.d ?? null;
};

const mockDeedMinter = (
  asset: string,
  onMint: () => Promise<void> | void = () => {},
): DeedMinter => ({
  assetFor: () => asset,
  mint: async () => { await onMint(); return { asset }; },
});

const keepBalance = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
const shardBalance = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;

let restoreDeedFixtures = async () => {};
beforeAll(async () => {
  await bootstrapSystemAccounts(db);
  restoreDeedFixtures = await isolateDeedTestFixtures(db);
});
afterAll(async () => {
  try { await restoreDeedFixtures(); } finally { await conn.sql.end(); }
});

// ---------------------------------------------------------------------------
// TRAP 1 — the deed is what the 0.2 SOL buys
// ---------------------------------------------------------------------------

describe('TRAP 1: a landless player is never minted a Land Deed', () => {
  it('mints NOTHING for an unpaid wallet, with a working minter configured', async () => {
    // WHY: the payment precondition used to live only in the CALL SITES, and one
    // of them (GET /base) is now free. If this test fails, the game is giving
    // away the asset it is supposed to be selling.
    const p = await createTestPlayer(db);
    let mints = 0;
    configureDeedMinter(mockDeedMinter('FreeDeed1', () => { mints++; }));
    try {
      for (let i = 0; i < 5; i++) await mintDeedIfConfigured(db, p.wallet);
      expect(mints).toBe(0);
      expect(await deedOf(p.wallet)).toBeNull();

      // …and the mint is not merely DELAYED: paying is what releases it.
      await buyLand(p.wallet);
      await mintDeedIfConfigured(db, p.wallet);
      expect(mints).toBe(1);
      expect(await deedOf(p.wallet)).toBe('FreeDeed1');
    } finally {
      configureDeedMinter(null);
    }
  });

  it('leaves the mint CLAIM untouched for an unpaid wallet (no stale-claim damage)', async () => {
    // WHY: the check sits inside the conditional UPDATE that also stamps
    // deed_minting_at. A version that stamped the claim and only then noticed the
    // wallet was unpaid would park a live claim on the row and delay the real
    // mint by the whole staleness window once they pay.
    const p = await createTestPlayer(db);
    configureDeedMinter(mockDeedMinter('NeverMinted'));
    try {
      await mintDeedIfConfigured(db, p.wallet);
      const [row] = await db.select({ claim: players.deedMintingAt }).from(players)
        .where(eq(players.wallet, p.wallet));
      expect(row?.claim).toBeNull();
    } finally {
      configureDeedMinter(null);
    }
  });
});

// ---------------------------------------------------------------------------
// TRAP 2 — the Gold Forge is a building, not a route
// ---------------------------------------------------------------------------

describe('TRAP 2: the Gold Forge needs land, at the BUILDING level', () => {
  const readyToBuild = async (): Promise<string> => {
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    // Keep 3 (goldforge requiresKeepLevel) + shards to afford it.
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, p.wallet));
    await rewardShards(db, p.wallet, 1_000_000n, 'test.fund', `fund:${p.wallet}`);
    return p.wallet;
  };

  it('402 LAND_NOT_OWNED when a landless player tries to PLACE one', async () => {
    // WHY: this is the shards→KEEP faucet. Route gating the six /forge/* handlers
    // does not stop the building being raised through the free build route.
    const wallet = await readyToBuild();
    await expect(placeBuilding(db, wallet, BuildingType.GoldForge, 11, 8, `gf:${wallet}`))
      .rejects.toMatchObject({ statusCode: 402, code: 'LAND_NOT_OWNED' });
    // and nothing was charged / nothing was built
    const [row] = await db.select({ n: players.wallet }).from(players).where(eq(players.wallet, wallet));
    expect(row).toBeDefined();
  });

  it('402 LAND_NOT_OWNED when a landless player tries to UPGRADE one', async () => {
    // WHY: the faucet scales with forge level, and a forge can arrive on a base
    // whose holder has no land (a claimed base, or a deed sold on).
    // D-057 rewrite: forge upgrades to L2+ now travel the PAID rail (0.2 SOL +
    // shards), so the land fence is proven on BOTH doors — the free route
    // refuses the forge outright (SOL gate) and the paid preflight/apply must
    // still 402 a landless holder before any SOL is requested.
    const wallet = await readyToBuild();
    await buyLand(wallet);
    const b = await placeBuilding(db, wallet, BuildingType.GoldForge, 11, 8, `gf2:${wallet}`);
    await completeDueJobs(db, wallet, new Date(Date.now() + 30 * 24 * 3600 * 1000));
    // The land goes away (deed sold / base transferred clears entryPaidAt).
    await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, wallet));
    await expect(upgradeBuilding(db, wallet, b.id, `up:${wallet}`))
      .rejects.toMatchObject({ statusCode: 422 }); // free route: the D-057 SOL gate
    const { assertPaidUpgradeable, applyPaidUpgrade } = await import('../src/game/base');
    await expect(assertPaidUpgradeable(db, wallet, b.id))
      .rejects.toMatchObject({ statusCode: 402, code: 'LAND_NOT_OWNED' });
    await expect(db.transaction((tx) => applyPaidUpgrade(tx, wallet, b.id, `upx:${wallet}`, new Date())))
      .rejects.toMatchObject({ statusCode: 402, code: 'LAND_NOT_OWNED' });
  });

  it('a LANDOWNER places and upgrades one normally', async () => {
    // D-057 rewrite: "normally" for a forge now means the PAID rail — the
    // preflight quotes the 0.2 SOL L2 price and the verified-payment apply
    // starts the upgrade job.
    const wallet = await readyToBuild();
    await buyLand(wallet);
    const b = await placeBuilding(db, wallet, BuildingType.GoldForge, 11, 8, `gf3:${wallet}`);
    await completeDueJobs(db, wallet, new Date(Date.now() + 30 * 24 * 3600 * 1000));
    const { assertPaidUpgradeable, applyPaidUpgrade } = await import('../src/game/base');
    await expect(assertPaidUpgradeable(db, wallet, b.id))
      .resolves.toEqual({ solLamports: upgradeSolLamports('goldforge', 2), buildingType: 'goldforge',
        fromLevel: 1, costShards: UPGRADE_COSTS.goldforge[0] });
    await db.transaction((tx) => applyPaidUpgrade(tx, wallet, b.id, `up3:${wallet}`, new Date()));
    const [job] = await db.select().from(builderJobs)
      .where(and(eq(builderJobs.buildingId, b.id), isNull(builderJobs.completedAt)));
    expect(job).toBeDefined();
  });

  it('every OTHER buildable type stays free (the gate is forge-only, on purpose)', async () => {
    // WHY: the decision recorded in base.ts is "forge only" — everything else is
    // base progress paid in shards, which are not withdrawable. If someone widens
    // the set they should have to change this test deliberately.
    const wallet = await readyToBuild();
    for (const [i, type] of [BuildingType.Vault, BuildingType.Barracks, BuildingType.Cannon].entries()) {
      const b = await placeBuilding(db, wallet, type, 10 + i * 3, 18, `free:${type}:${wallet}`);
      expect(b.type).toBe(type);
      await completeDueJobs(db, wallet, new Date(Date.now() + 30 * 24 * 3600 * 1000));
    }
  });
});

// ---------------------------------------------------------------------------
// TRAP 3 — a free base is never silently overwritten
// ---------------------------------------------------------------------------

describe('TRAP 3: base transfer to a landless buyer', () => {
  const seller = async (): Promise<string> => {
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    await db.update(players).set({ entryPaidAt: new Date(), deedAssetId: `Deed-${p.wallet.slice(0, 8)}` })
      .where(eq(players.wallet, p.wallet));
    return p.wallet;
  };

  it('REFUSES a buyer who already has a free base — and leaves that base intact', async () => {
    // WHY: this is the whole risk. Loosening the check would let transferBase
    // re-point the seller's buildings onto a wallet that already has its own,
    // merging two bases and destroying work the player did for free. The refusal
    // carries a machine code so the client can offer the abandon step instead of
    // a dead end.
    const from = await seller();
    const buyer = await createTestPlayer(db);
    await ensureStartingBase(db, buyer.wallet);
    const before = await db.select({ id: players.wallet }).from(players).where(eq(players.wallet, buyer.wallet));
    expect(before).toHaveLength(1);

    await expect(transferBase(db, from, buyer.wallet, `Deed-${from.slice(0, 8)}`))
      .rejects.toMatchObject({ statusCode: 422, code: 'BUYER_HAS_FREE_BASE' });

    // The seller still holds everything; nothing moved, nothing merged.
    const [s] = await db.select({ paid: players.entryPaidAt, deed: players.deedAssetId })
      .from(players).where(eq(players.wallet, from));
    expect(s?.paid).not.toBeNull();
    expect(s?.deed).toBe(`Deed-${from.slice(0, 8)}`);
  });

  it('REFUSES a buyer who already owns land, with a DIFFERENT code (terminal)', async () => {
    // WHY: one wallet = one parcel, enforced on chain, so this refusal is not
    // recoverable by abandoning anything — the client must not offer that.
    const from = await seller();
    const buyer = await createTestPlayer(db);
    await buyLand(buyer.wallet);
    await expect(transferBase(db, from, buyer.wallet, `Deed-${from.slice(0, 8)}`))
      .rejects.toMatchObject({ statusCode: 422, code: 'BUYER_OWNS_LAND' });
  });

  it('SUCCEEDS after the buyer explicitly abandons their free base', async () => {
    // WHY: R4's other half — the free builder must have a way through, and it has
    // to be their own explicit act.
    const from = await seller();
    const buyer = await createTestPlayer(db);
    await ensureStartingBase(db, buyer.wallet);
    const balBefore = await shardBalance(buyer.wallet);

    const res = await abandonFreeBase(db, buyer.wallet);
    expect(res.buildings).toBeGreaterThan(0);

    // The deed conveys no currency, and abandoning destroys none either.
    expect(await shardBalance(buyer.wallet)).toBe(balBefore);

    const moved = await transferBase(db, from, buyer.wallet, `Deed-${from.slice(0, 8)}`);
    expect(moved.buildings).toBeGreaterThan(0);
    const [b] = await db.select({ paid: players.entryPaidAt, deed: players.deedAssetId })
      .from(players).where(eq(players.wallet, buyer.wallet));
    expect(b?.paid).not.toBeNull();
    expect(b?.deed).toBe(`Deed-${from.slice(0, 8)}`);
  });

  it('a fresh wallet with no base at all still transfers (the original contract)', async () => {
    const from = await seller();
    const buyer = await createTestPlayer(db);
    const moved = await transferBase(db, from, buyer.wallet, `Deed-${from.slice(0, 8)}`);
    expect(moved.buildings).toBeGreaterThan(0);
  });

  it('abandonFreeBase REFUSES a base that owns land, holds a deed, or holds a parcel', async () => {
    // WHY: it is the only destructive path in the game. It may only ever delete
    // work that was free — never an asset a deed conveys to a buyer.
    const owner = await createTestPlayer(db);
    await ensureStartingBase(db, owner.wallet);
    await buyLand(owner.wallet);
    await expect(abandonFreeBase(db, owner.wallet)).rejects.toMatchObject({ statusCode: 422 });

    const deeded = await createTestPlayer(db);
    await ensureStartingBase(db, deeded.wallet);
    await db.update(players).set({ deedAssetId: `D-${deeded.wallet.slice(0, 8)}` })
      .where(eq(players.wallet, deeded.wallet));
    await expect(abandonFreeBase(db, deeded.wallet)).rejects.toMatchObject({ statusCode: 422 });
  });
});

// ---------------------------------------------------------------------------
// ABANDON IS NOT A FAUCET, AND NOT A SILENT LOSS
// (security review 2026-08-09 F5 / F12 / F13)
// ---------------------------------------------------------------------------

const standingObstacles = (wallet: string) => db.select({ id: obstacles.id }).from(obstacles)
  .where(and(eq(obstacles.playerWallet, wallet), isNull(obstacles.clearedAt)));
const allObstacles = (wallet: string) => db.select({ id: obstacles.id }).from(obstacles)
  .where(eq(obstacles.playerWallet, wallet));

/**
 * Clear every NET-POSITIVE obstacle the player can currently reach and let the jobs
 * land. Only the `small` tier is net-positive (costKeep 10 → clearRewardShards 15 =
 * +5); medium and large are sinks, so a maximally greedy exploiter clears exactly
 * these. `clearObstacle` also requires the tile to be INSIDE the claim, so this
 * reaches only what the player's `expansions` unlocks. Returns how many it cleared.
 */
async function harvestNetPositiveObstacles(wallet: string, at: Date): Promise<number> {
  const smalls = OBSTACLES.tiers.small.kinds as readonly string[];
  const standing = await db.select().from(obstacles)
    .where(and(eq(obstacles.playerWallet, wallet), isNull(obstacles.clearedAt)));
  let cleared = 0;
  for (const o of standing) {
    if (!smalls.includes(o.spriteKey)) continue;
    try {
      await clearObstacle(db, wallet, o.id, `harvest:${o.id}`, at);
    } catch {
      continue; // outside the claim, or a builder is busy — not a mint either way
    }
    // Builders are capacity-limited (1 by default), so each job must land before
    // the next clear starts.
    await completeDueJobs(db, wallet, new Date(at.getTime() + OBSTACLES.tiers.small.clearSec * 1000 + 1_000));
    cleared++;
  }
  return cleared;
}

describe('abandon → rebuild → clear cannot mint net shards (F5)', () => {
  it('never regenerates terrain, so the +5 small clear is a one-time land bonus', async () => {
    /**
     * THE EXPLOIT THIS CLOSES: `abandonFreeBase` used to DELETE the obstacle rows,
     * and `ensureStartingBase` regenerates them from a pure function of the tile
     * coordinates whenever the Keep is missing — while the clear reward's
     * idempotency key is the JOB id, so a fresh row pays again. abandon → GET /base
     * → clear → abandon was therefore a net-positive resource loop with no cooldown
     * and no per-wallet limit, i.e. an unbounded shard faucet.
     *
     * MEASURED, because the numbers matter for the fix's shape: the deterministic set
     * is 189 obstacles (73 small / 84 medium / 32 large), but `clearObstacle` refuses
     * anything outside the claim and `abandonFreeBase` resets `expansions` to 0, so a
     * REPEAT cycle can only ever reach the 4 tiles of the initial claim — one small
     * (+5) and three mediums (−10 each). The realizable mint was therefore ~+5 per
     * cycle, not the +365 a whole-plot reading suggests, and a landowner cannot
     * abandon at all. Small, but unbounded and repeatable, which is what makes it a
     * defect rather than a tuning question — and the fix is non-renewable terrain
     * rather than repricing an App-derived number ECONOMY.md never made an income line.
     *
     * If either half is reverted (delete instead of tombstone, or dropping the
     * once-per-wallet generation guard), the balance grows on every cycle below.
     */
    const t0 = new Date('2026-08-09T00:00:00Z');
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);

    const terrain = (await allObstacles(p.wallet)).length;
    expect(terrain).toBeGreaterThan(0);

    // The FIRST harvest is legitimately net-positive — that is the App's "+15 SHARDS
    // FOUND" land bonus and it stays exactly as it was.
    const opening = await shardBalance(p.wallet);
    expect(await harvestNetPositiveObstacles(p.wallet, t0)).toBeGreaterThan(0);
    const afterFirstHarvest = await shardBalance(p.wallet);
    expect(afterFirstHarvest).toBeGreaterThan(opening);

    // …and every cycle after it mints nothing, forever.
    for (let cycle = 1; cycle <= 3; cycle++) {
      const at = new Date(t0.getTime() + cycle * 86_400_000);
      await abandonFreeBase(db, p.wallet, at);
      await ensureStartingBase(db, p.wallet); // what the next GET /base does

      expect((await allObstacles(p.wallet)).length).toBe(terrain); // no new rows, ever
      expect(await standingObstacles(p.wallet)).toHaveLength(0);   // all tombstoned
      expect(await harvestNetPositiveObstacles(p.wallet, at)).toBe(0);
      expect(await shardBalance(p.wallet)).toBe(afterFirstHarvest);
    }
  });

  it('a base SALE does not regenerate the seller\'s terrain either (the transfer half)', async () => {
    /**
     * THE HALF THE FIRST PASS MISSED, and it made the header comment in
     * `ensureStartingBase` FALSE: it claimed terrain is "generated once per wallet,
     * ever" while `transferBase` moves EVERY obstacle row — tombstones included —
     * onto the buyer and leaves the seller with no Keep. The seller's next GET /base
     * therefore found zero rows, regenerated all 189 tiles, and restored the +5 net
     * small clear inside the reset (expansions → 0) claim. Bounded by the price of a
     * base instead of unbounded, but the same defect: a tile that has already paid its
     * one-time land bonus must never be able to pay it again.
     *
     * THE GUARANTEE: terrain is generated at most ONCE PER WALLET for the lifetime of
     * the wallet, whatever happens to the base afterwards. The obstacle rows cannot
     * carry it on their own (a sale takes them away), so `base_transfers.from_wallet`
     * — written in the same transaction as the move — carries it instead. Drop that
     * second check from `ensureStartingBase` and the final two assertions below fail.
     */
    const t0 = new Date('2026-08-09T00:00:00Z');
    const seller = await createTestPlayer(db);
    await ensureStartingBase(db, seller.wallet);
    const terrain = (await allObstacles(seller.wallet)).length;
    expect(terrain).toBeGreaterThan(0);

    // Take the legitimate one-time bonus first, so what follows can only be a REPEAT.
    expect(await harvestNetPositiveObstacles(seller.wallet, t0)).toBeGreaterThan(0);
    const afterFirstHarvest = await shardBalance(seller.wallet);

    // Sell the base: land + deed, then hand it to a baseless buyer.
    await buyLand(seller.wallet);
    const deed = `D-sale-${seller.wallet.slice(0, 8)}`;
    await db.update(players).set({ deedAssetId: deed }).where(eq(players.wallet, seller.wallet));
    const buyer = await createTestPlayer(db);
    await transferBase(db, seller.wallet, buyer.wallet, deed);

    // The rows LEFT the seller — this is exactly what emptied the row-based guard.
    expect(await allObstacles(seller.wallet)).toHaveLength(0);
    expect((await allObstacles(buyer.wallet)).length).toBe(terrain);

    await ensureStartingBase(db, seller.wallet); // what the seller's next GET /base does
    expect(await allObstacles(seller.wallet)).toHaveLength(0); // never a second generation
    expect(await harvestNetPositiveObstacles(seller.wallet, t0)).toBe(0);
    expect(await shardBalance(seller.wallet)).toBe(afterFirstHarvest);
  });

  it('tombstones the terrain rather than deleting it, so a cleared tile stays cleared', async () => {
    // The mechanism, asserted directly: `clearedAt` is the EXISTING "cleared
    // obstacles never respawn" tombstone (HANDOFF §3.9) and every reader filters on
    // it, so nothing renders or blocks placement. Keeping the rows is also what
    // makes the claim path sound — transferBase re-points the seller's obstacles
    // onto this wallet, and a standing leftover could otherwise land under a
    // building the seller already built on that tile.
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    const before = (await allObstacles(p.wallet)).length;

    await abandonFreeBase(db, p.wallet);

    expect((await allObstacles(p.wallet)).length).toBe(before);
    expect(await standingObstacles(p.wallet)).toHaveLength(0);
  });
});

describe('abandon settles the mine clock first (F12)', () => {
  it('BANKS the accrued buffer instead of silently destroying it', async () => {
    /**
     * THE SAME OMISSION A PRIOR REVIEW ALREADY FIXED FOR `transferBase` 90 lines
     * above (2026-07-29 F1). mine_state is keyed by WALLET and `accrue` applies the
     * CURRENT quota across the whole elapsed window, so deleting the mines drops the
     * quota to 0 and: (a) everything earned since the last collect is never banked
     * (`accrue` returns the old buffer untouched at quota 0), and (b) `collectMine`
     * 422s on "build a Mine first", so even the already-banked buffer is
     * uncollectable. Both are silent losses on the path a player takes in order to
     * GAIN a base — on a flow whose whole promise is that no balance is destroyed.
     *
     * Anchored on MINE_QUOTA_BASE rather than a magic number: Keep L1 + Mine L1 +
     * no streak is exactly 500 shards/day (ECONOMY.md §2).
     */
    const t0 = new Date('2026-08-09T00:00:00Z');
    const oneDayLater = new Date(t0.getTime() + 86_400_000);
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    await rewardShards(db, p.wallet, 5_000n, 'test.fund.f12', `f12:${p.wallet}`);
    // Every clock in this test is `t0`-relative, INCLUDING the build: a mine whose
    // job has not completed is not counted by the quota, so a real-time placement
    // against a t0 completion would silently measure quota 0 and pass for the wrong
    // reason (it would then read 0 banked shards either way, fix or no fix).
    await placeBuilding(db, p.wallet, BuildingType.Mine, 11, 8, `f12-mine:${p.wallet}`, t0);
    await completeDueJobs(db, p.wallet, new Date(t0.getTime() + 120_000));
    await ensureMineState(db, p.wallet, t0);
    await db.update(mineState).set({ accruedShards: 0n, lastAccrualAt: t0 })
      .where(eq(mineState.playerWallet, p.wallet));

    await abandonFreeBase(db, p.wallet, oneDayLater);

    const [state] = await db.select().from(mineState).where(eq(mineState.playerWallet, p.wallet));
    // A full day at the L1/L1 quota, banked — NOT zero.
    expect(state!.accruedShards).toBe(BigInt(MINING.MINE_QUOTA_BASE));
    // …and the clock advanced, so the mine-less window cannot be back-credited when
    // a mine returns (which is the over-credit half of the same bug).
    expect(state!.lastAccrualAt.getTime()).toBe(oneDayLater.getTime());

    // It is genuinely collectable again, and for exactly the banked amount.
    await placeBuilding(db, p.wallet, BuildingType.Mine, 11, 8, `f12-mine2:${p.wallet}`, oneDayLater);
    await completeDueJobs(db, p.wallet, new Date(oneDayLater.getTime() + 120_000));
    const { amount } = await collectMine(db, p.wallet, new Date(oneDayLater.getTime() + 120_000));
    expect(amount).toBeGreaterThanOrEqual(BigInt(MINING.MINE_QUOTA_BASE));
  });
});

describe('abandon writes an audit row (F13)', () => {
  it('records the full prior state, append-only, like base_transfers does', async () => {
    // WHY: abandoning is the ONLY destructive route in the game — it deletes
    // buildings and jobs, tombstones terrain and resets keepLevel/expansions — and
    // it wrote nothing at all, so a "my base is gone" support case had no record to
    // answer from. `transferBase` writes one for exactly this reason.
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    await db.update(players).set({ keepLevel: 3 }).where(eq(players.wallet, p.wallet));

    const res = await abandonFreeBase(db, p.wallet);

    const rows = await db.select().from(baseAbandons)
      .where(eq(baseAbandons.playerWallet, p.wallet));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priorKeepLevel).toBe(3);
    expect(rows[0]!.priorExpansions).toBe(0);
    expect(rows[0]!.buildingsDeleted).toBe(res.buildings);
    expect(rows[0]!.obstaclesTombstoned).toBe(res.obstacles);
    expect(rows[0]!.jobsDeleted).toBe(res.jobs);
    expect(rows[0]!.buildingsDeleted).toBeGreaterThan(0);
    expect(rows[0]!.obstaclesTombstoned).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TRAP 4 + the route table, with the flag ON
// ---------------------------------------------------------------------------

/**
 * THE ROUTE TABLE, as data — but its COVERAGE is derived from the router (F14).
 *
 * `route` is the registration exactly as fastify holds it (`:param` and all): it is
 * the coverage key, checked against `deriveGroups()` below, so this table cannot
 * drift from the real router in either direction. `url` is the concrete path to
 * send when the pattern carries parameters.
 *
 * The behavioural assertions are "402" vs "not 402", never "200": several probes
 * carry deliberately invalid bodies, and a 400/422 from the validator proves the
 * request reached the handler, which is all a gate table is about. Reachability is
 * proven separately by the cookie-less 401 (only a real registration carrying
 * `authenticate` can answer that), so a 404 can never pass for "reached".
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Group = 'gated' | 'flip' | 'authOnly';

type Probe = {
  /** `${METHOD} ${registration pattern}` — the coverage key. */
  readonly route: `${Method} /${string}`;
  /** Concrete request path; defaults to the pattern (only params need this). */
  readonly url?: string;
  readonly payload?: Record<string, unknown>;
  /**
   * Set ONLY when a route must keep an auth-only preHandler so its HANDLER can
   * recover an existing protected operation before refusing a new landless
   * commitment. The string is the reason and is required, so this can never be
   * used to quietly paper over a route that got gated by accident.
   */
  readonly handlerNeedsLand?: string;
};

const methodOf = (p: Probe): Method => p.route.split(' ')[0] as Method;
const patternOf = (p: Probe): string => p.route.slice(p.route.indexOf(' ') + 1);
const urlOf = (p: Probe): string => p.url ?? patternOf(p);

/** One injected request, session-cookied. Payload omitted entirely when absent so
 *  a GET is a GET. */
const hit = (app: FastifyInstance, cookie: string, p: Probe) =>
  app.inject({
    method: methodOf(p), url: urlOf(p), cookies: { [SESSION_COOKIE]: cookie },
    ...(p.payload === undefined ? {} : { payload: p.payload }),
  });

const UUID = '00000000-0000-0000-0000-000000000000';
const KEY = 'k'.repeat(10);
// The route audit must exercise authorization with payment service availability
// proved, so an unrelated 503 cannot mask a missing handler-level land gate.
const market = { feeTreasury: randomWallet(),
  verifyPayment: async () => null,
  verifyPaymentCommit: async (p: { paymentSignature: string }) => ({ txSignature: p.paymentSignature }),
};
const configuredMarket = { market,
  miningContributionProvider: createMiningContributionProvider(db),
  freeBasePurchaseProvider: createFreeBasePurchaseProvider(db),
};

/** The deed unlocks these: extraction, aggression, and every KEEP valve. */
const GATED: readonly Probe[] = [
  { route: 'GET /map/me' },
  { route: 'GET /map/scout/:wallet', url: '/map/scout/So11111111111111111111111111111111111111112' },
  { route: 'GET /map/parcel/:earthCell', url: '/map/parcel/12345' },
  { route: 'GET /forge' },
  { route: 'GET /forge/global' },
  { route: 'POST /forge/contribute', payload: { shards: '10', idempotencyKey: KEY } },
  { route: 'POST /market/list', payload: { itemId: 'x', priceLamports: '1', idempotencyKey: 'land-gate-list-1' } },
  {
    route: 'POST /market/listings/:id/reserve',
    url: `/market/listings/${UUID}/reserve`,
    payload: {},
    handlerNeedsLand: 'the handler must return an existing buyer reservation before gating a new commitment',
  },
  { route: 'POST /market/v1/list',
    payload: { itemId: 'keg_of_haste', priceLamports: String(MARKETPLACE.itemMarket.minPriceLamports), idempotencyKey: KEY, baseId: null },
    handlerNeedsLand: 'an authenticated exact listing key recovers before the handler gates any new sale',
  },
  { route: 'POST /market/v1/listings/:id/reserve', url: `/market/v1/listings/${UUID}/reserve`,
    payload: { idempotencyKey: KEY, itemId: 'keg_of_haste', sourceBaseId: null, buyerBaseId: null,
      seller: 'So11111111111111111111111111111111111111112', priceLamports: String(MARKETPLACE.itemMarket.minPriceLamports) },
    handlerNeedsLand: 'an authenticated exact reservation key recovers before any new buyer commitment is gated',
  },
  { route: 'POST /withdrawals', payload: { amount: '1', destination: 'x'.repeat(40), idempotencyKey: KEY } },
  { route: 'GET /withdrawals/status' },
  { route: 'POST /withdrawals/prepare', payload: { amount: '1', destination: 'x'.repeat(40), idempotencyKey: KEY } },
  { route: 'POST /clans', payload: { name: 'n', tag: 't', idempotencyKey: KEY } },
  { route: 'POST /clans/:id/join', url: `/clans/${UUID}/join`, payload: {} },
  { route: 'POST /clans/leave', payload: {} },
  { route: 'POST /clans/kick', payload: { wallet: 'x'.repeat(40) } },
  { route: 'POST /clans/v1/leave', payload: { idempotencyKey: UUID, clanId: UUID, baseId: null } },
  { route: 'POST /clans/v1/kick', payload: { idempotencyKey: UUID, clanId: UUID, wallet: 'x'.repeat(40) } },
  { route: 'GET /clans/mine' },
  { route: 'GET /clans' },
];

/** BUILD, PROGRESS, LOOK — free when the flag is on, gated again when it is off. */
const FLIP: readonly Probe[] = [
  { route: 'GET /base' },
  { route: 'GET /base/layouts', url: `/base/layouts?baseId=${UUID}` },
  {
    route: 'POST /base/layouts/FARM/unlock',
    payload: { baseId: UUID, idempotencyKey: KEY },
  },
  {
    route: 'PUT /base/layouts/:slot',
    url: '/base/layouts/HOME',
    payload: {},
  },
  { route: 'POST /base/buildings', payload: { type: 'vault', tx: 10, ty: 18, idempotencyKey: KEY },
    handlerNeedsLand: 'exact modern Mine proof recovers before fresh placement is land-gated; the custom preHandler retains legacy admission' },
  { route: 'POST /heroes/recruit/v1', payload: { idempotencyKey: UUID, baseId: null, type: 'heroaltar', tx: 8, ty: 9, heroContractOnly: false, maxCostKeep: '1' },
    handlerNeedsLand: 'exact historical recruitment consent recovers before a fresh placement follows the free-onboarding land gate' },
  { route: 'POST /base/walls/batch/v1', payload: { idempotencyKey: UUID, baseId: null, tiles: [{ tx: 8, ty: 9 }], maxCostShards: '1' },
    handlerNeedsLand: 'immutable exact wall receipt recovers before a fresh placement follows the free-onboarding land gate' },
  { route: 'POST /base/buildings/batch', payload: { tiles: [{ tx: 9, ty: 19 }], idempotencyKey: 'k'.repeat(11) } },
  { route: 'POST /base/buildings/move-batch', payload: { moves: [] } },
  { route: 'PATCH /base/buildings/:id/move', url: `/base/buildings/${UUID}/move`, payload: { tx: 10, ty: 10 } },
  { route: 'POST /base/walls/:id/upgrade-quote', url: `/base/walls/${UUID}/upgrade-quote`, payload: {} },
  { route: 'POST /base/walls/:id/upgrade-row', url: `/base/walls/${UUID}/upgrade-row`, payload: { idempotencyKey: KEY, quoteId: '0'.repeat(64) } },
  { route: 'POST /base/buildings/:id/upgrade', url: `/base/buildings/${UUID}/upgrade`, payload: { idempotencyKey: KEY } },
  { route: 'POST /base/buildings/:id/repair', url: `/base/buildings/${UUID}/repair`, payload: {} },
  { route: 'POST /base/obstacles/:id/clear', url: `/base/obstacles/${UUID}/clear`, payload: { idempotencyKey: KEY } },
  { route: 'POST /base/jobs/:id/speedup', url: `/base/jobs/${UUID}/speedup`, payload: { idempotencyKey: KEY } },
  // D-104: cancelling a running upgrade is free-tier play like starting one.
  { route: 'POST /base/jobs/:id/cancel', url: `/base/jobs/${UUID}/cancel`, payload: { idempotencyKey: KEY } },
  { route: 'POST /mine/collect', payload: {} },
  { route: 'POST /mine/claim', payload: {} },
  { route: 'GET /mine/status' },
  { route: 'GET /economy/stats' },
  { route: 'GET /army' },
  // Presets and batch training are the same free-tier army workflow. They do
  // not unlock land-only extraction or change the existing training gate.
  { route: 'GET /army/presets' },
  { route: 'PUT /army/presets/:slot', url: '/army/presets/1', payload: {} },
  { route: 'DELETE /army/presets/:slot', url: '/army/presets/1' },
  { route: 'GET /army/previous' },
  { route: 'POST /army/training/quote', payload: {} },
  { route: 'POST /army/training/batch', payload: {} },
  { route: 'POST /army/train', payload: { troop: 'militia', idempotencyKey: KEY } },
  {
    route: 'POST /army/train/:queueId/cancel',
    url: `/army/train/${UUID}/cancel`,
    payload: { idempotencyKey: KEY },
  },
  { route: 'POST /army/train/speedup', payload: { idempotencyKey: KEY } },
  { route: 'POST /army/research', payload: { troop: 'militia', idempotencyKey: KEY } },
  { route: 'POST /army/research/speedup', payload: { troop: 'militia', idempotencyKey: KEY } },
  { route: 'POST /army/research/:troop/cancel', url: '/army/research/militia/cancel', payload: { idempotencyKey: KEY } },
  { route: 'GET /heroes' },
  { route: 'POST /heroes/:hero/upgrade', url: '/heroes/nope/upgrade', payload: {} },
  { route: 'POST /heroes/:hero/recovery/speedup', url: '/heroes/vex/recovery/speedup', payload: { idempotencyKey: KEY } },
  { route: 'PUT /heroes/:hero/equipment/:slot', url: '/heroes/vex/equipment/helm', payload: { itemId: null, expectedVersion: 0 } },
  { route: 'GET /raids' },
  { route: 'GET /raids/pending' },
  { route: 'GET /raids/pending/:id', url: `/raids/pending/${UUID}` },
  { route: 'GET /raids/:id/replay', url: `/raids/${UUID}/replay` },
  // Deedless players raid each other: auto-match is their ONLY PvP, so these stay
  // free and the tier partition (game/land.ts) is what seals the two pools.
  { route: 'POST /raids', payload: {} },
  { route: 'POST /raids/:id/orders', url: `/raids/${UUID}/orders`, payload: {} },
  { route: 'POST /raids/:id/commands', url: `/raids/${UUID}/commands`, payload: {} },
  { route: 'POST /raids/:id/start', url: `/raids/${UUID}/start`, payload: {} },
  { route: 'POST /raids/:id/speed', url: `/raids/${UUID}/speed`, payload: {} },
  { route: 'GET /raids/:id/live', url: `/raids/${UUID}/live` },
  { route: 'POST /raids/:id/finish', url: `/raids/${UUID}/finish`, payload: {} },
  { route: 'GET /bases/:baseId/active-raid', url: `/bases/${UUID}/active-raid` },
  { route: 'GET /bases/:baseId/raid-events', url: `/bases/${UUID}/raid-events` },
  { route: 'GET /bases/:baseId/battles', url: `/bases/${UUID}/battles` },
  {
    route: 'GET /bases/:baseId/battles/:raidId/replay',
    url: `/bases/${UUID}/battles/${UUID}/replay`,
  },
  // Fantasy exploration is free; exact parcel disclosure retains its own tier guard.
  { route: 'GET /globe/fantasy' },
  { route: 'GET /globe/fantasy/search', url: '/globe/fantasy/search?q=zzz' },
  { route: 'GET /globe/fantasy/parcels', url: '/globe/fantasy/parcels?x0=0&x1=0&y0=0&y1=0' },
  { route: 'GET /globe/fantasy/parcels/:tileId', url: '/globe/fantasy/parcels/0' },
  { route: 'GET /globe' },
  { route: 'GET /globe/sector/:id', url: '/globe/sector/0' },
  {
    route: 'GET /globe/parcels',
    url: '/globe/parcels?x0=0&x1=0&y0=0&y1=0',
  },
  { route: 'GET /map/search', url: '/map/search?q=zzz' },
  { route: 'GET /items' },
  { route: 'POST /items/buy', payload: {} },
  { route: 'POST /items/use', payload: {} },
  // POST /items/equip was DELETED with the keep-skin retirement (M23 a8/D-054):
  // it 404s for everyone now, so it no longer belongs in the paywall matrix.
  { route: 'POST /items/:itemId/seen', url: '/items/wardens_helm/seen', payload: {} },
  { route: 'GET /market/collection' },
  { route: 'GET /market/assets' },
  { route: 'GET /market/listings' },
  { route: 'GET /market/listings/mine' },
  { route: 'GET /campaign' },
  { route: 'GET /campaign/:stage/preview', url: '/campaign/1/preview' },
  { route: 'POST /campaign/:stage/raid', url: '/campaign/0/raid', payload: { idempotencyKey: KEY } },
  { route: 'GET /quests' },
  { route: 'POST /quests/:id/claim', url: '/quests/nope/claim', payload: {} },
  { route: 'GET /referrals/code' },
  // M23 a6: the tutorial is free-tier progression — the deedless free tier is
  // exactly who needs it, and the row is one integer per wallet, nothing
  // extractable. Full behaviour in test/tutorial.test.ts.
  { route: 'GET /tutorial' },
  { route: 'POST /tutorial/advance', payload: { step: 1 } },
  { route: 'POST /tutorial/skip', payload: {} },
  // The guided first run's on/off switch (owner 2026-08-29). Free for the same
  // reason as the rest of this block, and more so: the deedless free tier is the
  // whole audience of the guided flow, and being unable to turn it off would be
  // a worse gate than being unable to turn it on.
  { route: 'POST /tutorial/guide/skip', payload: {} },
  { route: 'POST /tutorial/guide/resume', payload: {} },
  { route: 'POST /tutorial/reset', payload: {} },
];

/**
 * AUTH-ONLY IN BOTH FLAG STATES. These were never part of the paywall (paying is
 * what they are FOR, or they are scoped to the caller's own row), so the kill
 * switch must not gate them either — F2's guarantee cuts both ways.
 */
const AUTH_ONLY: readonly Probe[] = [
  // Paid access is checked by the selected route; preview requires no land deed.
  { route: 'GET /starter-expeditions/paid-route', url: `/starter-expeditions/paid-route?baseId=${UUID}&realm=0` },
  // Phase E free-base acquisition and historical receipts require no paid deed.
  { route: 'GET /bases/free-purchases', url: `/bases/free-purchases?sourceBaseId=${UUID}` },
  { route: 'POST /bases/free-purchases', payload: { sourceBaseId: UUID, idempotencyKey: KEY } },
  { route: 'GET /bases/free-purchases/by-key/:key', url: `/bases/free-purchases/by-key/${KEY}` },
  { route: 'GET /items/buy/receipt', url: `/items/buy/receipt?itemId=powder_charge&idempotencyKey=${KEY}` },
  { route: 'GET /base/jobs/speedup/receipt', url: `/base/jobs/speedup/receipt?jobId=00000000-0000-4000-8000-000000000001&idempotencyKey=${KEY}` },
  // Policy inspection grants no base, balance or Phase E gameplay authority.
  { route: 'GET /game/phase-e/catalogue' },
  // Gems (D-152, E2-GEMS-CONTRACT §2) are the FREE tier's currency too: every
  // route is auth-only and dark-gated AFTER authentication (503 while
  // GEMS_ENABLED=false), never land-gated. Receipts are historical evidence.
  { route: 'GET /gems' },
  { route: 'POST /gems/from-keep', payload: { keep: '1', idempotencyKey: KEY } },
  { route: 'GET /gems/from-keep/by-key/:key', url: `/gems/from-keep/by-key/${KEY}` },
  { route: 'GET /gems/buy/by-key/:key', url: `/gems/buy/by-key/${KEY}` },
  { route: 'GET /gems/from-keep/receipt', url: `/gems/from-keep/receipt?idempotencyKey=${KEY}` },
  { route: 'POST /gems/to-shards', payload: { gems: '1', idempotencyKey: KEY } },
  { route: 'GET /gems/to-shards/receipt', url: `/gems/to-shards/receipt?idempotencyKey=${KEY}&gems=1` },
  { route: 'GET /gems/tasks' },
  { route: 'POST /gems/tasks/:taskId/claim', url: '/gems/tasks/first-light/claim', payload: { idempotencyKey: KEY } },
  { route: 'GET /gems/tasks/:taskId/claim/by-key/:key', url: `/gems/tasks/first-light/claim/by-key/${KEY}` },
  // Workshop refining (D-149 §5, E2-WORKSHOP-CONTRACT §4): the free tier's
  // deedless base refines too (its capacity is the wallet's free units), so
  // every route is auth-only and dark-gated AFTER authentication (503 while
  // FORGE_INGOTS_ENABLED=false), never land-gated. Registered by workshopRoutes.ts.
  { route: 'GET /starter-expeditions', url: `/starter-expeditions?baseId=${UUID}` },
  { route: 'POST /starter-expeditions', payload: { idempotencyKey: UUID, baseId: UUID, installationId: UUID, routeId: 'introduction', routeVersion: 1, rewardVersion: 1 } },
  { route: 'GET /starter-expeditions/by-key/:key', url: `/starter-expeditions/by-key/${UUID}` },
  { route: 'GET /starter-fleet', url: `/starter-fleet?baseId=${UUID}` },
  { route: 'POST /starter-fleet/installations', payload: { idempotencyKey: UUID, baseId: UUID, berthId: UUID } },
  { route: 'GET /starter-fleet/installations/by-key/:key', url: `/starter-fleet/installations/by-key/${UUID}` },
  { route: 'GET /ordinary-crafting', url: `/ordinary-crafting?baseId=${UUID}` },
  { route: 'POST /ordinary-crafting/jobs', payload: { idempotencyKey: UUID, baseId: UUID, recipeId: 'refine_frostglass', recipeVersion: 1, quantity: 1 } },
  { route: 'GET /ordinary-crafting/jobs/by-key/:key', url: `/ordinary-crafting/jobs/by-key/${UUID}` },
  // Resource mining accepts free bases; original receipts survive deed transfer.
  { route: 'GET /mining/contributions', url: `/mining/contributions?baseId=${UUID}` },
  { route: 'POST /mining/contributions', payload: { idempotencyKey: UUID, baseId: UUID, policyVersion: 2, expectedDay: '2026-09-29', lines: [{ resourceId: 'shards', quantity: '1' }] } },
  { route: 'GET /mining/contributions/by-key/:key', url: `/mining/contributions/by-key/${UUID}` },
  { route: 'GET /workshop', url: `/workshop?baseId=${UUID}` },
  { route: 'POST /workshop/jobs', payload: { idempotencyKey: KEY, baseId: UUID, ingots: 1, recipeVersion: 1 } },
  { route: 'GET /workshop/jobs/by-key/:key', url: `/workshop/jobs/by-key/${KEY}` },
  { route: 'POST /workshop/jobs/:jobId/collect', url: `/workshop/jobs/${UUID}/collect`, payload: { idempotencyKey: KEY } },
  { route: 'GET /workshop/jobs/:jobId/collect/by-key/:key', url: `/workshop/jobs/${UUID}/collect/by-key/${KEY}` },
  // Original SOL quote/payment recovery precedes present-day land authority.
  { route: 'GET /base/purchases/v1/:key', url: `/base/purchases/v1/${UUID}` },
  { route: 'GET /base/purchases/v1/energy/:key', url: `/base/purchases/v1/energy/${UUID}?kind=energy` },
  { route: 'GET /base/purchases/v1/shields/:key', url: `/base/purchases/v1/shields/${UUID}?kind=shield` },
  { route: 'POST /base/purchases/v1/quote', payload: {} },
  { route: 'POST /base/purchases/v1/:key/cancel-unquoted', url: `/base/purchases/v1/${UUID}/cancel-unquoted`, payload: {} },
  // Original money receipts must survive a deed sale and disabled extraction rails.
  { route: 'GET /forge/convert/receipt', url: `/forge/convert/receipt?idempotencyKey=${KEY}&keep=1` },
  { route: 'GET /forge/contribute/receipt', url: `/forge/contribute/receipt?idempotencyKey=${KEY}&shards=1` },
  { route: 'GET /withdrawals/receipt', url: `/withdrawals/receipt?idempotencyKey=${KEY}&grossAmount=1&feeBurned=0&netAmount=1&destination=11111111111111111111111111111111&mode=standard&cluster=devnet&keepMint=11111111111111111111111111111111` },
  { route: 'GET /heroes/:hero/upgrade/receipt', url: `/heroes/vex/upgrade/receipt?idempotencyKey=${KEY}&expectedLevel=1&maxCostKeep=99999` },
  { route: 'GET /heroes/:hero/recovery/speedup/receipt', url: `/heroes/vex/recovery/speedup/receipt?idempotencyKey=${KEY}&recoveryUntil=2026-09-12T10:00:00.000Z&maxCostKeep=99999` },
  { route: 'GET /base/buildings/receipt', url: `/base/buildings/receipt?idempotencyKey=${KEY}&type=mine&tx=11&ty=8` },
  // Receipt recovery cannot require the deed the original purchaser sold.
  { route: 'GET /army/training/receipt', url: `/army/training/receipt?idempotencyKey=${KEY}` },
  // Original paid research proof remains private and readable after a deed sale.
  { route: 'GET /army/train/speedup/receipt', url: `/army/train/speedup/receipt?idempotencyKey=${KEY}` },
  { route: 'GET /army/research/speedup/receipt', url: `/army/research/speedup/receipt?idempotencyKey=${KEY}&troop=militia&expectedCurrency=KEEP&currentLevel=1&toLevel=2&finishesAt=2026-09-21T12:00:00.000Z&episodeId=null&maxCostKeep=1` },
  // A cancellation actor must retain refund evidence after selling their last deed.
  { route: 'GET /army/train/:queueId/cancel/receipt', url: `/army/train/${UUID}/cancel/receipt?idempotencyKey=${KEY}&baseId=${UUID}` },
  { route: 'POST /army/training/close', payload: { idempotencyKey: KEY, confirmed: true } },
  // The handler returns 410 for every legacy tactical view in both flag states.
  // Authentication remains so this retired surface never becomes an oracle.
  { route: 'GET /map', url: `/map?valleyId=${UUID}` },
  { route: 'GET /balances' },
  { route: 'GET /bases' },
  // Reads the CALLER's own on-chain wallet; no land stake. Under TEST_CONFIG
  // it answers 503 (buildApp injects no walletHub in tests) — still not 402.
  { route: 'GET /wallet/balances' },
  // The caller's own KEEP deposit history (tester ask 6bec1435): a private
  // ledger read with no land stake, gated exactly like the balance read.
  { route: 'GET /wallet/keep-deposits' },
  // Private participant history survives selling the last deed. Deed-gating
  // either read would strand the seller's exact record/replay after transfer.
  { route: 'GET /battles/participated' },
  {
    route: 'GET /battles/participated/:raidId/replay',
    url: `/battles/participated/${UUID}/replay`,
  },
  { route: 'GET /forge/allocations' },
  { route: 'POST /forge/claim', payload: {} },
  { route: 'POST /forge/claims/v1', payload: { idempotencyKey: UUID, baseId: null, day: null } },
  { route: 'POST /forge/convert', payload: { keep: '1', idempotencyKey: KEY } },
  // Profile identity/security is available to every admitted account. Fresh
  // wallet re-auth guards every mutation; no route here can move KEEP.
  { route: 'GET /2fa/status' },
  { route: 'POST /2fa/step-up/email', payload: {} },
  { route: 'POST /2fa/totp/enroll', payload: {} },
  { route: 'POST /2fa/totp/verify', payload: { code: '123456' } },
  { route: 'POST /2fa/totp/disable', payload: { code: '123456' } },
  { route: 'POST /2fa/email/start', payload: { email: 'a@b.co' } },
  { route: 'POST /2fa/email/verify', payload: { code: '123456' } },
  { route: 'POST /2fa/totp/recovery/start', payload: { recoveryId: UUID } },
  { route: 'POST /2fa/totp/recovery/confirm', payload: { recoveryId: UUID, code: '123456' } },
  { route: 'POST /2fa/totp/recovery/cancel', payload: { recoveryId: UUID, code: '123456' } },
  { route: 'POST /2fa/totp/recovery/complete/send-code', payload: { recoveryId: UUID } },
  { route: 'POST /2fa/totp/recovery/complete', payload: { recoveryId: UUID, code: '123456' } },
  { route: 'GET /base/claimable' },
  { route: 'POST /base/claim', payload: {} },
  { route: 'GET /base/claims/v1/claimable' },
  { route: 'POST /base/claims/v1', payload: { idempotencyKey: UUID, baseId: UUID, deedAssetId: '11111111111111111111111111111111' } },
  { route: 'GET /base/claims/v1/:key', url: `/base/claims/v1/${UUID}` },
  { route: 'POST /base/claims/v1/:key/cancel-unaccepted', url: `/base/claims/v1/${UUID}/cancel-unaccepted`, payload: {} },
  // The only way a free builder can claim a base they bought (see TRAP 3).
  { route: 'POST /base/abandon', payload: {} },
  { route: 'POST /deposits', payload: {} },
  { route: 'GET /deposits/:id', url: `/deposits/${UUID}` },
  // K-night-A7: what a saved land reservation did, by key; read before the land it reserves is paid for.
  { route: 'GET /deposits/land/receipt', url: `/deposits/land/receipt?kind=entry&idempotencyKey=${KEY}` },
  { route: 'POST /deposits/:id/paid', url: `/deposits/${UUID}/paid`, payload: {} },
  { route: 'POST /deposits/:id/verify', url: `/deposits/${UUID}/verify`, payload: {} },
  /*
   * F6 — THE THREE ROUTES THAT COMPLETE AN ALREADY-PAID PURCHASE. Gate the CREATION
   * of a sale (POST /market/list, /reserve — both `gated`), never its completion:
   * once real SOL has moved, honouring the trade must not depend on EITHER party's
   * land state. `/cancel` is the landless SELLER's only way to release a stranded
   * listing; `/paid` and `/settle` are the landless BUYER's only way to pin and claim
   * a purchase they have already broadcast. Each is scoped to the caller's own row —
   * cancelListing 404s a listing that is not theirs, submitPayment and settleListing
   * 422 anyone who is not the reserver — so ungating grants nothing else.
   */
  { route: 'POST /market/listings/:id/cancel', url: `/market/listings/${UUID}/cancel`, payload: {} },
  { route: 'POST /market/listings/:id/paid', url: `/market/listings/${UUID}/paid`, payload: { signature: marketSignatureOf(1) } },
  { route: 'POST /market/listings/:id/settle', url: `/market/listings/${UUID}/settle`, payload: {} },
  // Private buyer recovery/history must stay reachable after their land changes.
  { route: 'GET /market/purchases/pending' },
  { route: 'GET /market/trades' },
  { route: 'POST /market/purchases/:id/check', url: `/market/purchases/${UUID}/check`,
    payload: { reference: 'So11111111111111111111111111111111111111112' } },
  // Immutable v1 reads and completion recover existing custody independently of
  // current land. The two creation handlers remain in GATED above.
  { route: 'GET /market/v1/list/by-key/:key', url: `/market/v1/list/by-key/${KEY}` },
  { route: 'GET /market/v1/listings/mine' },
  { route: 'GET /market/v1/reservations/by-key/:key', url: `/market/v1/reservations/by-key/${KEY}` },
  { route: 'GET /market/v1/cancellations/by-key/:key', url: `/market/v1/cancellations/by-key/${KEY}` },
  { route: 'POST /market/v1/reservations/:id/paid', url: `/market/v1/reservations/${UUID}/paid`,
    payload: { reference: 'So11111111111111111111111111111111111111112', signature: marketSignatureOf(1) } },
  { route: 'POST /market/v1/reservations/:id/settle', url: `/market/v1/reservations/${UUID}/settle`,
    payload: { reference: 'So11111111111111111111111111111111111111112' } },
  { route: 'POST /market/v1/listings/:id/cancel', url: `/market/v1/listings/${UUID}/cancel`,
    payload: { idempotencyKey: KEY, itemId: 'keg_of_haste', sourceBaseId: null,
      priceLamports: String(MARKETPLACE.itemMarket.minPriceLamports), status: 'active', reference: null } },
  /*
   * The SAME F6 rule, applied to the one path carrying withdrawable KEEP
   * (2026-08-09). CREATING a withdrawal is `gated`; UNWINDING one you already
   * created is not. Both routes only post the caller's OWN escrow back to the
   * caller's OWN play balance — nothing leaves the game — and there is no admin
   * surface, so this is the only route home for a stranded row. Left gated, a
   * player who withdrew and then sold their base could neither finish nor
   * unwind their own escrow: money stuck with no actor able to move it.
   * All three are scoped to the caller's own wallet/row (listWithdrawals,
   * cancelWithdrawal and refundFailedWithdrawal), so ungating grants nothing
   * else.
   */
  { route: 'POST /withdrawals/:id/cancel', url: `/withdrawals/${UUID}/cancel`, payload: {} },
  { route: 'POST /withdrawals/:id/refund', url: `/withdrawals/${UUID}/refund`, payload: {} },
  { route: 'GET /withdrawals' },
  { route: 'POST /referrals/use', payload: {} },
  // Attribution and its recovery remain available before land purchase, like the legacy route.
  { route: 'GET /referrals/v1/status' },
  { route: 'GET /clans/v1/commands/:key', url: `/clans/v1/commands/${UUID}` },
  { route: 'GET /forge/claims/v1/:key', url: `/forge/claims/v1/${UUID}` },
  { route: 'GET /base/walls/batch/v1/:key', url: `/base/walls/batch/v1/${UUID}` },
  { route: 'GET /heroes/recruit/v1/:key', url: `/heroes/recruit/v1/${UUID}` },
  { route: 'POST /referrals/v1/use', payload: {} },
  { route: 'GET /por/proof' },
];

/** Registered WITHOUT `authenticate` — public by design, and asserted as such so a
 *  new unauthenticated route cannot appear unnoticed. */
const PUBLIC: readonly string[] = [
  'GET /por',
  'GET /deed/:wallet.json',
  'GET /deed/:wallet.png',
  'GET /deed/asset/:assetId.json',
  'GET /deed/asset/:assetId.png',
  // Relics-won feed (tester 69arc, report 0d1b6d9d): transparency that drops
  // really happen is the point, so it is readable without a session. Bounded,
  // server-cached and abbreviated-wallet only — forge-recent-drops.test.ts.
  'GET /forge/drops/recent',
];

/**
 * WHAT THE ROUTER ACTUALLY SAYS. Registers the REAL route table into a bare
 * Fastify with identifiable stub decorators and records every registration's
 * preHandler chain, in both flag states. A route is `gated` when the chain holds
 * `requireLandOwned` with the flag ON, `flip` when it only holds it with the flag
 * OFF, `authOnly` when it never does, and `public` when it has no `authenticate`.
 *
 * HEAD is dropped: fastify auto-registers it for every GET, so it is not a
 * decision anyone makes and would double the table for no coverage.
 */
async function registrations(freeOn: boolean): Promise<Map<string, { authed: boolean; gated: boolean }>> {
  const prev = process.env['FREE_ONBOARDING'];
  if (freeOn) process.env['FREE_ONBOARDING'] = 'true';
  else delete process.env['FREE_ONBOARDING'];
  try {
    const bare = Fastify();
    const authenticate = async (): Promise<void> => undefined;
    const authenticateLoginRecovery = async (): Promise<void> => undefined;
    const requireLandOwned = async (): Promise<void> => undefined;
    bare.decorate('authenticate', authenticate);
    // Factor recovery also accepts purpose-limited login credentials; it stays
    // authenticated and land-independent, never part of the public surface.
    bare.decorate('authenticateLoginRecovery', authenticateLoginRecovery);
    bare.decorate('requireLandOwned', requireLandOwned);
    bare.decorateRequest('wallet', '');
    const out = new Map<string, { authed: boolean; gated: boolean }>();
    bare.addHook('onRoute', (r) => {
      const chain = [r.preHandler ?? []].flat() as unknown[];
      for (const m of (Array.isArray(r.method) ? r.method : [r.method])) {
        if (m === 'HEAD') continue;
        out.set(`${m} ${r.url}`, {
          authed: chain.includes(authenticate) || chain.includes(authenticateLoginRecovery),
          gated: chain.includes(requireLandOwned),
        });
      }
    });
    registerGameRoutes(bare as never, db, configuredMarket);
    // app.ts registers the Workshop family right after the game routes; the
    // probe must see the same authed surface buildApp exposes.
    registerWorkshopRoutes(bare as never, db);
    registerFreeBasePurchaseRoutes(bare as never, configuredMarket.freeBasePurchaseProvider);
    registerOrdinaryCraftingRoutes(bare as never, db);
    registerStarterFleetRoutes(bare as never, db);
    registerStarterExpeditionRoutes(bare as never, db);
    await bare.ready();
    await bare.close();
    return out;
  } finally {
    if (prev === undefined) delete process.env['FREE_ONBOARDING'];
    else process.env['FREE_ONBOARDING'] = prev;
  }
}

async function deriveGroups(): Promise<Map<string, Group | 'public'>> {
  const on = await registrations(true);
  const off = await registrations(false);
  const out = new Map<string, Group | 'public'>();
  for (const [key, r] of on) {
    if (!r.authed) { out.set(key, 'public'); continue; }
    out.set(key, r.gated ? 'gated' : (off.get(key)?.gated ? 'flip' : 'authOnly'));
  }
  return out;
}

describe('the probe table covers the REAL router, exactly (F14)', () => {
  it('classifies every registration, agrees with it, and invents nothing', async () => {
    // WHY: the header used to claim this table was "asserted TABLE-DRIVEN against
    // the real registrations", while GATED/FREE were hand-written literals that had
    // already fallen 12 registrations behind. A route table that can silently omit a
    // route is not a gate test — the omitted route is exactly the one that lands on
    // the wrong side. So the router is the authority for the SET and for each
    // route's GROUP; this file only supplies the probe and the intent.
    const derived = await deriveGroups();
    const declared = new Map<string, Group>();
    for (const [group, probes] of [['gated', GATED], ['flip', FLIP], ['authOnly', AUTH_ONLY]] as const) {
      for (const p of probes) {
        expect(declared.has(p.route), `${p.route} is declared twice`).toBe(false);
        declared.set(p.route, group);
      }
    }

    const authed = [...derived].filter(([, g]) => g !== 'public').map(([k]) => k);
    expect(authed.filter((k) => !declared.has(k)), 'registered but UNCLASSIFIED — pick a group').toEqual([]);
    expect([...declared.keys()].filter((k) => !derived.has(k)), 'declared but NOT REGISTERED').toEqual([]);
    for (const [key, group] of declared) {
      const probe = [...GATED, ...FLIP, ...AUTH_ONLY].find((p) => p.route === key);
      const registeredGroup = probe?.handlerNeedsLand ? 'authOnly' : group;
      expect(derived.get(key), `${key}: the router disagrees with this table`).toBe(registeredGroup);
    }
    // And the unauthenticated surface is a closed, deliberate set.
    expect([...derived].filter(([, g]) => g === 'public').map(([k]) => k).sort())
      .toEqual([...PUBLIC].sort());
  });

  it('a handler-gated route must state why its preHandler stays auth-only', () => {
    // Handler-gated recovery paths must name why a bare boolean cannot let a
    // genuinely mis-gated route hide behind the exception.
    for (const p of [...GATED, ...FLIP, ...AUTH_ONLY]) {
      if (p.handlerNeedsLand !== undefined) expect(p.handlerNeedsLand.length).toBeGreaterThan(20);
    }
  });
});

describe('FREE_ONBOARDING=true: the free tier', () => {
  let app: FastifyInstance;
  let wallet: string;
  let cookie: string;

  beforeAll(async () => {
    process.env['FREE_ONBOARDING'] = 'true';
    app = await buildApp(TEST_CONFIG, db, configuredMarket);
    await app.ready();
    ({ wallet, cookie } = await signIn(app));
    resetMapCache();
  });
  afterAll(async () => {
    await app.close();
    delete process.env['FREE_ONBOARDING'];
  });

  it('signing in creates a BASE but NO PARCEL (TRAP 4)', async () => {
    // WHY: the whole free tier is "a base, not a place". If a plot appears here,
    // the landless player joins the valley roster and becomes farmable by
    // landowners who they, by design, cannot raid back.
    const res = await app.inject({ method: 'GET', url: '/base', cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const state = res.json() as { buildings: Array<{ type: string }> };
    expect(state.buildings.some((b) => b.type === 'keep')).toBe(true);

    const plot = await db.select().from(plots).where(eq(plots.playerWallet, wallet));
    expect(plot).toHaveLength(0);
  });

  it('answers a plain 404 on the retired PvE route (D-152: the KEEP bounty is gone)', async () => {
    // WHY: POST /raids/pve was one of the four player_keep minters the land
    // gate had to close. D-152 deletes the route and its bounty outright, so
    // neither tier may reach a handler here — not 402, not 426, just absent.
    const res = await app.inject({
      method: 'POST', url: '/raids/pve', cookies: { [SESSION_COOKIE]: cookie },
      payload: { campId: UUID, idempotencyKey: KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lets a deedless authenticated player convert KEEP to non-withdrawable SHARDS', async () => {
    await fundTestKeep(db, wallet, 5n, 'test.convert_fund', `convert-fund:${wallet}`);
    const keepBefore = await keepBalance(wallet);
    const shardsBefore = await shardBalance(wallet);
    const res = await app.inject({
      method: 'POST', url: '/forge/convert', cookies: { [SESSION_COOKIE]: cookie },
      payload: { keep: '2', idempotencyKey: `convert-${wallet.slice(0, 12)}` },
    });
    expect(res.statusCode).toBe(201);
    expect(await keepBalance(wallet)).toBe(keepBefore - 2n);
    expect(await shardBalance(wallet)).toBe(shardsBefore + 2n);
  });

  it('produces NO map roster row — the landless base cannot be found (TRAP 4)', async () => {
    // WHY: the roster is `plots INNER JOIN players`, and that join is the ONLY
    // thing protecting a free base — no shield row, and no deed coupling. What
    // INV-1 forbids is intact: attackability reads no deed or DAS state. Its
    // three-factor form is stale though (F9) — the land partition added a factor, so
    // it is (base exists) × shield × warzone × sameLandTier (game/land.ts).
    const owner = await createTestPlayer(db);
    await ensureStartingBase(db, owner.wallet);
    await buyLand(owner.wallet);
    const { ensurePlotAssigned } = await import('../src/game/world');
    const home = await ensurePlotAssigned(db, owner.wallet);
    resetMapCache();

    const chunk = await getMapChunk(db, owner.wallet, {
      valleyId: home.valleyId, x0: 0, y0: 0, x1: 24, y1: 19,
    }) as { markers: Array<{ wallet?: string }> };
    expect(chunk.markers.some((m) => m.wallet === wallet)).toBe(false);
  });

  it('polling GET /base many times mints NO deed (TRAP 1, over the wire)', async () => {
    let mints = 0;
    configureDeedMinter(mockDeedMinter('WireDeed1', () => { mints++; }));
    try {
      for (let i = 0; i < 10; i++) {
        const r = await app.inject({ method: 'GET', url: '/base', cookies: { [SESSION_COOKIE]: cookie } });
        expect(r.statusCode).toBe(200);
      }
      // mintDeedIfConfigured is fire-and-forget on this route; give it a tick.
      await new Promise((r) => setTimeout(r, 50));
      expect(mints).toBe(0);
      expect(await deedOf(wallet)).toBeNull();
    } finally {
      configureDeedMinter(null);
    }
  });

  it('quarantines a paid flag-off wallet while an exact deed recovery is pending', async () => {
    // Null/null remains the supported "minter disabled" state. A reserved id is
    // evidence that the Core create may already have landed and transferred;
    // the old wallet must not retain extraction authority during that gap.
    const pending = await signIn(app);
    await db.update(players).set({
      entryPaidAt: new Date(), deedAssetId: null, deedMintAssetId: `pending-${pending.wallet}`,
    }).where(eq(players.wallet, pending.wallet));
    const blocked = await app.inject({
      method: 'GET', url: '/forge', cookies: { [SESSION_COOKIE]: pending.cookie },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({
      error: {
        code: 'DEED_AUTHORITY_UNAVAILABLE',
        message: 'deed mint is pending exact on-chain recovery; land authority is quarantined',
      },
    });
  });

  it('claiming a quest credits NO withdrawable KEEP for a landless player', async () => {
    // WHY: only `player_keep` is withdrawable, and quests are on the FREE side by
    // the locked owner decision — which is only safe because quest rewards are
    // denominated in SHARDS. If a quest ever pays KEEP again this must go red,
    // and the route must move to the `owned` group.
    const before = await keepBalance(wallet);
    const board = await app.inject({ method: 'GET', url: '/quests', cookies: { [SESSION_COOKIE]: cookie } });
    expect(board.statusCode).toBe(200);
    const { quests: qs } = board.json() as { quests: Array<{ id: string; progress: number; target: number }> };
    for (const q of qs) {
      await app.inject({
        method: 'POST', url: `/quests/${q.id}/claim`,
        cookies: { [SESSION_COOKIE]: cookie }, payload: {},
      });
    }
    expect(await keepBalance(wallet)).toBe(before);
  });

  for (const p of GATED) {
    it(`${p.route} → 402 LAND_NOT_OWNED`, async () => {
      const res = await hit(app, cookie, p);
      expect(res.statusCode, `answered ${res.statusCode}: ${res.body.slice(0, 200)}`).toBe(402);
      // The full 402 SHAPE, not just the status: the client branches on the code and
      // shows the message. Asserted identically with the flag OFF (see below), which
      // is what makes auth/session.ts's "both flag states say so" claim true.
      expect(res.json()).toMatchObject({
        error: { code: 'LAND_NOT_OWNED', message: 'buy your land to unlock this' },
      });
    });
  }

  for (const p of [...FLIP, ...AUTH_ONLY]) {
    it(`${p.route} is reachable without land`, async () => {
      // PROVE THE ROUTE EXISTS FIRST, or "not 402" is vacuous: a typo'd path
      // would 404 and sail through. Cookie-less must be 401, which only a real
      // registration carrying `authenticate` can answer. (A domain 404 — unknown
      // deposit id, unknown raid — is a legitimate answer for several of these,
      // so 404-vs-not cannot be the registration proof.)
      const anon = await app.inject({
        method: methodOf(p), url: urlOf(p),
        ...(p.payload === undefined ? {} : { payload: p.payload }),
      });
      expect(anon.statusCode, `${p.route} is not a registered authed route`).toBe(401);

      const res = await hit(app, cookie, p);
      expect(res.statusCode, `${p.route} was gated`).not.toBe(402);
    });
  }

  it('POST /base/abandon needs the typed confirmation and is NOT land-gated', async () => {
    // WHY: it is the only destructive route in the game and the only way a free
    // builder can claim a base they bought, so it must be reachable WITHOUT land
    // and unreachable by an accidental empty POST.
    const noConfirm = await app.inject({
      method: 'POST', url: '/base/abandon', cookies: { [SESSION_COOKIE]: cookie }, payload: {},
    });
    expect(noConfirm.statusCode).toBe(400); // lib/validation.parse → 400

    const s = await signIn(app);
    await ensureStartingBase(db, s.wallet);
    const ok = await app.inject({
      method: 'POST', url: '/base/abandon',
      cookies: { [SESSION_COOKIE]: s.cookie }, payload: { confirm: 'ABANDON' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { buildings: number }).buildings).toBeGreaterThan(0);
  });

  it('retires both legacy map views without assigning land; parcelBand remains read-only', async () => {
    // WHY: WORLD is the globe now. Bare and named-valley tactical reads must not
    // resurrect the retired board or assign a plot, while the narrow globe data
    // projection remains available during the rolling client transition.
    const own = await app.inject({ method: 'GET', url: '/map', cookies: { [SESSION_COOKIE]: cookie } });
    expect(own.statusCode).toBe(410);
    expect((own.json() as { error: { code?: string } }).error.code).toBe('VALLEY_VIEW_RETIRED');
    expect(await db.select().from(plots).where(eq(plots.playerWallet, wallet))).toHaveLength(0);

    const owner = await createTestPlayer(db);
    await buyLand(owner.wallet);
    const { ensurePlotAssigned } = await import('../src/game/world');
    const home = await ensurePlotAssigned(db, owner.wallet);
    const visit = await app.inject({
      method: 'GET', url: `/map?valleyId=${home.valleyId}`, cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(visit.statusCode).toBe(410);
    expect((visit.json() as { error: { code?: string } }).error.code).toBe('VALLEY_VIEW_RETIRED');
    const band = await app.inject({
      method: 'GET', url: `/map?valleyId=${home.valleyId}&parcelBand=1`,
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(band.statusCode).toBe(200);
    // Still no parcel: a visit never writes.
    expect(await db.select().from(plots).where(eq(plots.playerWallet, wallet))).toHaveLength(0);
  });

  it('GET /map/search gives a DEEDLESS caller no LOCATIONS (F11)', async () => {
    // WHY: free onboarding moved this route from the paid group to the free one, so
    // wallet + name + keepLevel + trophies + valleyId + x + y for every LANDOWNER
    // stopped costing 0.2 SOL to reach. valleyId/x/y are the only fields that LOCATE
    // another player's parcel; the client never reads them (map.tsx uses
    // wallet/name/seeker/keepLevel/trophies) and a deedless caller has no route that
    // can act on a landowner anyway — scouting and the own-valley map are land-gated
    // and the raid pools are sealed by land tier. So the coordinates stay on the paid
    // side of the line the 0.2 SOL used to draw, and the search box still works.
    const tag = `LGSEARCH${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const owner = await signIn(app);
    await buyLand(owner.wallet);
    await ensureStartingBase(db, owner.wallet);
    await db.update(players).set({ name: tag }).where(eq(players.wallet, owner.wallet));
    const { ensurePlotAssigned } = await import('../src/game/world');
    await ensurePlotAssigned(db, owner.wallet);

    type Hit = Record<string, unknown>;
    const search = async (c: string): Promise<Hit[]> => {
      const res = await app.inject({
        method: 'GET', url: `/map/search?q=${tag}`, cookies: { [SESSION_COOKIE]: c },
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { results: Hit[] }).results;
    };

    const asLandless = await search(cookie);
    expect(asLandless.map((r) => r['wallet'])).toEqual([owner.wallet]);
    expect(asLandless[0]).toMatchObject({ wallet: owner.wallet, name: tag });
    for (const field of ['valleyId', 'x', 'y']) {
      expect(asLandless[0], `${field} must not reach a deedless caller`).not.toHaveProperty(field);
    }

    // …and a LANDOWNER's payload is unchanged: this is a reduction, not a removal.
    const asOwner = await search(owner.cookie);
    expect(asOwner[0]).toHaveProperty('valleyId');
    expect(asOwner[0]).toHaveProperty('x');
    expect(asOwner[0]).toHaveProperty('y');
  });

  it('buying land opens every gated route (the gate is the ONLY thing standing there)', async () => {
    const paid = await signIn(app);
    await buyLand(paid.wallet);
    await ensureStartingBase(db, paid.wallet);
    for (const p of GATED) {
      const res = await hit(app, paid.cookie, p);
      expect(res.statusCode, `${p.route} still 402 after buying land`).not.toBe(402);
    }
  });
});

// ---------------------------------------------------------------------------
// THE KILL SWITCH — what FREE_ONBOARDING=false actually restores (F2)
// ---------------------------------------------------------------------------

/**
 * THE GUARANTEE, AS WRITTEN IN config.ts, AND NOTHING WIDER.
 *
 * This suite used to be titled "restores today's behaviour exactly" and only walked
 * the route table — which was the same overclaim the flag's own doc comment made
 * (security review F2): five behaviour changes are UNCONDITIONAL by design, so
 * "exactly today" was never true and is not what a kill switch needs to promise.
 * The narrowed promise has two halves, and both are asserted here:
 *
 *   1. AUTHORIZATION IS UNCHANGED. Every route that flips is gated again; every
 *      route that was auth-only before the split is STILL auth-only (the switch
 *      must not over-gate either); every gated route stays gated. Derived from the
 *      router, so this cannot fall behind the route table.
 *   2. NOTHING EXISTS BEFORE THE ENTRY CREDIT — no base, no buildings, no terrain,
 *      no plot, and no starter shard grant. That is what a rollback has to restore,
 *      and it is what deposit-watcher.test.ts's "NOW — and only now" depends on.
 *
 * And one thing that is deliberately NOT restored, asserted so the claim in
 * auth/session.ts ("asserts this shape with the flag OFF as well as ON") is true:
 * the 402 carries the same message and the same machine code in both states.
 */
describe('FREE_ONBOARDING=false restores AUTHORIZATION and EXISTENCE (F2)', () => {
  let app: FastifyInstance;
  let wallet: string;
  let cookie: string;

  beforeAll(async () => {
    delete process.env['FREE_ONBOARDING'];
    app = await buildApp(TEST_CONFIG, db, configuredMarket);
    await app.ready();
    ({ wallet, cookie } = await signIn(app));
  });
  afterAll(async () => { await app.close(); });

  it('signing in creates NO base, NO terrain, NO plot and NO starter grant', async () => {
    // WHY: R10 — deposit-watcher.test.ts asserts base+plot exist "NOW — and only
    // now". That assertion must keep holding while the flag is off, which is what
    // makes this whole change shippable dark. The shard balance is part of it: the
    // 500-shard `shard_genesis` posting is inside ensureStartingBase, so a base
    // created early would also mint currency early and inflate "ever minted".
    const { buildings } = await import('../src/db/schema');
    expect(await db.select().from(buildings).where(eq(buildings.playerWallet, wallet))).toHaveLength(0);
    expect(await allObstacles(wallet)).toHaveLength(0);
    expect(await db.select().from(plots).where(eq(plots.playerWallet, wallet))).toHaveLength(0);
    expect(await shardBalance(wallet)).toBe(0n);
  });

  it('polling GET /base does NOT create a base while the flag is off', async () => {
    // WHY: base creation hangs off GET /base, which is in the FREE group only when
    // the flag is on. If it ever creates a base from the OWNED group, the kill
    // switch stops being a kill switch.
    const res = await app.inject({ method: 'GET', url: '/base', cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(402);
    const { buildings } = await import('../src/db/schema');
    expect(await db.select().from(buildings).where(eq(buildings.playerWallet, wallet))).toHaveLength(0);
    expect(await shardBalance(wallet)).toBe(0n);
  });

  it('gates every flipping route again, and over-gates nothing', async () => {
    for (const p of [...GATED, ...FLIP]) {
      const res = await hit(app, cookie, p);
      expect(res.statusCode, `${p.route} leaked out of the paywall`).toBe(402);
    }
    for (const p of AUTH_ONLY) {
      const res = await hit(app, cookie, p);
      expect(res.statusCode, `${p.route} must stay auth-only`).not.toBe(402);
    }
  });

  it('keeps the named EXCEPTIONS ungated in this state too', async () => {
    // config.ts names the un-gatings that are NOT behind the flag, because each was a
    // bug and a fix that only applies when a flag is on is not a fix: the three
    // market routes that complete an already-paid purchase — cancel, paid and settle,
    // all asserted in the AUTH_ONLY loop above, where gating them stranded the
    // seller's listing AND the buyer's SOL — plus the key-export reads (custody).
    const status = await app.inject({
      method: 'GET', url: '/auth/export/status', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(status.statusCode).toBe(200);
    const send = await app.inject({
      method: 'POST', url: '/auth/export/send-code', cookies: { [SESSION_COOKIE]: cookie }, payload: {},
    });
    // 422 "verify an email first" — reached the handler, which is the point.
    expect(send.statusCode).not.toBe(402);
  });

  it('answers the SAME 402 message and code as the flag-on build', async () => {
    // WHY UNCONDITIONAL: the client needs ONE 402 contract to branch on, not one
    // per flag state, and making the hottest gate in the game read the env per
    // request would buy nothing. Both states want the same outcome from a landless
    // caller — go buy your land — so both must say so, in the same words.
    const res = await hit(app, cookie, { route: 'GET /forge' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({
      error: { code: 'LAND_NOT_OWNED', message: 'buy your land to unlock this' },
    });
  });
});

// ---------------------------------------------------------------------------
// F3 — sign-in must not be a base factory for unauthorized strangers
// ---------------------------------------------------------------------------

describe('F3: only an ALPHA-PASSING wallet can build the world', () => {
  /**
   * WHY THIS IS THE HIGH FINDING IT IS. `POST /auth/verify` is deliberately NOT
   * alpha-gated — a stranger with nothing but a keypair can sign in, and one
   * `players` row was the accepted cost of the invite model. Free onboarding briefly
   * put `ensureStartingBase` in that route, which changed the cost per stranger to a
   * keep + ~189 obstacle rows + two ledger accounts + a 500-shard `shard_genesis`
   * posting. At authRateLimit's 20/min/IP that is ~28,800 full bases per day per IP
   * with no invite code, each one inflating "shards ever minted" (game/economy.ts).
   *
   * `makeAuthenticate` runs `assertAlphaAccess`, and it is the FIRST thing that can
   * decide a wallet may exist in the world — so the world is built behind it, on the
   * first alpha-passing authenticated touch (`GET /base`, idempotent).
   */
  const ALPHA_ONLY: Config = { ...TEST_CONFIG, ALPHA_WALLETS: [randomWallet()] };
  let app: FastifyInstance;
  let stranger: { wallet: string; cookie: string };

  const worldOf = async (w: string): Promise<{
    buildings: number; obstacles: number; plots: number; shards: bigint; keep: bigint;
  }> => {
    const { buildings } = await import('../src/db/schema');
    return {
      buildings: (await db.select().from(buildings).where(eq(buildings.playerWallet, w))).length,
      obstacles: (await allObstacles(w)).length,
      plots: (await db.select().from(plots).where(eq(plots.playerWallet, w))).length,
      shards: await shardBalance(w),
      keep: await keepBalance(w),
    };
  };

  beforeAll(async () => {
    process.env['FREE_ONBOARDING'] = 'true';
    app = await buildApp(ALPHA_ONLY, db);
    await app.ready();
    stranger = await signIn(app);
  });
  afterAll(async () => {
    await app.close();
    delete process.env['FREE_ONBOARDING'];
  });

  it('lets a stranger SIGN IN (that is by design) but 403s every authed route', async () => {
    const base = await app.inject({ method: 'GET', url: '/base', cookies: { [SESSION_COOKIE]: stranger.cookie } });
    expect(base.statusCode).toBe(403);
    expect((base.json() as { error: { code?: string } }).error.code).toBe('ALPHA_GATED');
  });

  it('creates NO base, terrain, parcel or ledger posting for a stranger — on ANY free route', async () => {
    // The whole free surface, not just GET /base: if base creation ever moves to
    // another free route (or to verify again), this is what must go red.
    for (const p of [...FLIP, ...AUTH_ONLY]) {
      const res = await hit(app, stranger.cookie, p);
      expect(res.statusCode, `${p.route} answered ${res.statusCode} for a non-alpha wallet`).toBe(403);
    }
    expect(await worldOf(stranger.wallet)).toEqual({
      buildings: 0, obstacles: 0, plots: 0, shards: 0n, keep: 0n,
    });
  });

  it('builds the base on the first ALPHA-PASSING touch — the gate is the only thing missing', async () => {
    // WHY the positive half matters: "no base" would also be satisfied by a broken
    // free tier. Admitting the same wallet (an invite-code redemption lands exactly
    // this row) must make the base appear, with no other change.
    await db.insert(alphaAccess).values({ wallet: stranger.wallet, source: 'manual' })
      .onConflictDoNothing();
    const res = await app.inject({ method: 'GET', url: '/base', cookies: { [SESSION_COOKIE]: stranger.cookie } });
    expect(res.statusCode).toBe(200);
    const after = await worldOf(stranger.wallet);
    expect(after.buildings).toBeGreaterThan(0);
    expect(after.obstacles).toBeGreaterThan(0);
    expect(after.shards).toBeGreaterThan(0n); // the starter grant, now paid for by an invite
    expect(after.plots).toBe(0);              // …and still NO parcel: no land, no place
  });

  it('turns that admitted free base into deeded land only after the purchase stamp', async () => {
    // This is the whole onboarding order in one account: invite/Seeker admission
    // already happened above; the free base has no plot or deed; entryPaidAt is
    // the purchase authority; plot assignment + mint follow it; paid routes then
    // open. deposit-watcher.test.ts separately proves the verified 0.2 SOL credit
    // performs these calls — this test pins what the calls must produce together.
    expect(await deedOf(stranger.wallet)).toBeNull();
    expect(await db.select().from(plots).where(eq(plots.playerWallet, stranger.wallet)))
      .toHaveLength(0);

    configureDeedMinter(mockDeedMinter(`JourneyDeed-${stranger.wallet.slice(0, 8)}`));
    try {
      await buyLand(stranger.wallet);
      const { ensurePlotAssigned } = await import('../src/game/world');
      await ensurePlotAssigned(db, stranger.wallet);
      await mintDeedIfConfigured(db, stranger.wallet);

      expect(await db.select().from(plots).where(eq(plots.playerWallet, stranger.wallet)))
        .toHaveLength(1);
      expect(await deedOf(stranger.wallet)).toBe(`JourneyDeed-${stranger.wallet.slice(0, 8)}`);
      const forge = await app.inject({
        method: 'GET', url: '/forge', cookies: { [SESSION_COOKIE]: stranger.cookie },
      });
      expect(forge.statusCode).not.toBe(402);
    } finally {
      configureDeedMinter(null);
    }
  });
});

// ---------------------------------------------------------------------------
// F6 — a purchase that has been PAID for always settles (real SOL at risk)
// ---------------------------------------------------------------------------

describe('F6: losing your land cannot strand a buyer\'s SOL', () => {
  /**
   * THE BUG, EXACTLY. Item settlement is NON-CUSTODIAL: `reservePayload` sends 95%
   * straight to the seller's own wallet and 5% to the fee treasury, and the buyer
   * signs and broadcasts that themselves. The seller-owns-land check used to run on
   * `/reserve` AND `/settle`, so a buyer who reserved, signed and broadcast BEFORE
   * the seller's base transferred (which clears the seller's `entryPaidAt`) got a
   * 409 at settle: SOL gone, no item, no refund. `/cancel` was land-gated too, so
   * the now-landless seller could not release it either, and reserveListing's
   * settlePaidExpired rescue was unreachable because the route 409'd first.
   *
   * THE RULE: gate the CREATION of a sale, never the HONOURING of one already paid
   * for. Once money has moved the only honest answer is "settle".
   */
  const FEE = 'FeeTreasury1111111111111111111111111111111';
  let listN = 0;
  let app: FastifyInstance;
  let seller: { wallet: string; cookie: string };
  let buyer: { wallet: string; cookie: string };

  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url, cookies: { [SESSION_COOKIE]: cookie }, payload });

  /** A listing created while the seller still owned land. */
  const listOne = async (): Promise<string> => {
    await db.insert(playerItems).values({ playerWallet: seller.wallet, itemId: 'keg_of_haste', qty: 1 })
      .onConflictDoUpdate({
        target: [playerItems.playerWallet, playerItems.itemId],
        set: { qty: sql`${playerItems.qty} + 1` },
      });
    const res = await post(seller.cookie, '/market/list', {
      itemId: 'keg_of_haste', priceLamports: '1000000', idempotencyKey: `land-gate-list-live-${++listN}`,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  };

  const qtyOf = async (w: string, itemId = 'keg_of_haste'): Promise<number> => {
    const [r] = await db.select({ q: playerItems.qty }).from(playerItems)
      .where(and(eq(playerItems.playerWallet, w), eq(playerItems.itemId, itemId)));
    return r?.q ?? 0;
  };
  const statusOf = async (id: string): Promise<string> => {
    const [r] = await db.select({ s: itemListings.status }).from(itemListings).where(eq(itemListings.id, id));
    return r!.s;
  };
  /** Advance the test clock beyond the canonical timeout. A frozen public quote
   * must never be rewritten merely to arrange the historical rescue scenario. */
  const afterLapse = async (id: string, run: () => Promise<void>): Promise<void> => {
    const [row] = await db.select({ until: itemListings.reservedUntil }).from(itemListings).where(eq(itemListings.id, id));
    expect(row?.until).not.toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(row!.until!.getTime() + (MARKETPLACE.itemMarket.settleTimeoutSec + 1) * 1000));
    try { await run(); } finally { vi.useRealTimers(); }
  };
  const takeLandFrom = (w: string): Promise<unknown> =>
    db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, w));

  beforeAll(async () => {
    process.env['FREE_ONBOARDING'] = 'true';
    app = await buildApp(TEST_CONFIG, db, {
      market: {
        feeTreasury: FEE,
        verifyPayment: async (p) => ({ txSignature: p.paymentSignature ?? marketSignatureOf(8) }),
        verifyPaymentCommit: async (p) => ({ txSignature: p.paymentSignature }),
      },
    });
    await app.ready();
    seller = await signIn(app);
    buyer = await signIn(app);
    await buyLand(seller.wallet);
    await buyLand(buyer.wallet);
  });
  afterAll(async () => {
    await app.close();
    delete process.env['FREE_ONBOARDING'];
  });

  it('SETTLES a reserved-and-paid listing after the seller loses their land', async () => {
    const id = await listOne();
    expect((await post(buyer.cookie, `/market/listings/${id}/reserve`)).statusCode).toBe(201);
    expect((await post(buyer.cookie, `/market/listings/${id}/paid`, { signature: marketSignatureOf(2) })).statusCode).toBe(200);

    // The base transfers out from under the sale — exactly what transferBase does.
    await takeLandFrom(seller.wallet);

    const settle = await post(buyer.cookie, `/market/listings/${id}/settle`);
    expect(settle.statusCode, `settle answered ${settle.statusCode}: ${settle.body.slice(0, 200)}`).toBe(200);
    expect(await statusOf(id)).toBe('sold');
    expect(await qtyOf(buyer.wallet)).toBe(1); // the buyer got what they paid for
  });

  it('/paid rejects a non-canonical signature before it can pin the reservation', async () => {
    await buyLand(seller.wallet);
    await buyLand(buyer.wallet);
    const id = await listOne();
    expect((await post(buyer.cookie, `/market/listings/${id}/reserve`)).statusCode).toBe(201);
    const paid = await post(buyer.cookie, `/market/listings/${id}/paid`, { signature: 'not-base58-0OIl' });
    expect(paid.statusCode).toBe(400);
    const [row] = await db.select({ paymentSig: itemListings.paymentSig }).from(itemListings)
      .where(eq(itemListings.id, id));
    expect(row?.paymentSig).toBeNull();
  });

  it('lets the now-landless seller CANCEL their own listing', async () => {
    // WHY: the landless seller is precisely who needs to take a stranded listing off
    // the book. Gating cancel left the listing AND the money stuck.
    await buyLand(seller.wallet);
    const id = await listOne();
    await takeLandFrom(seller.wallet);
    const held = await qtyOf(seller.wallet);
    const res = await post(seller.cookie, `/market/listings/${id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(await statusOf(id)).toBe('cancelled');
    expect(await qtyOf(seller.wallet)).toBe(held + 1); // the held unit comes back
  });

  it('cancel by a landless seller still RESCUES a lapsed-but-paid reservation to the BUYER', async () => {
    // WHY: this is the path the 409 made unreachable. cancelListing runs
    // settlePaidExpired first, so a buyer who paid and then went away still gets the
    // item — the seller can never reclaim something someone paid for.
    await buyLand(seller.wallet);
    const id = await listOne();
    expect((await post(buyer.cookie, `/market/listings/${id}/reserve`)).statusCode).toBe(201);
    expect((await post(buyer.cookie, `/market/listings/${id}/paid`, { signature: marketSignatureOf(3) })).statusCode).toBe(200);
    await afterLapse(id, async () => {
      await takeLandFrom(seller.wallet);
      const before = await qtyOf(buyer.wallet);

      const res = await post(seller.cookie, `/market/listings/${id}/cancel`);
      expect(res.statusCode).toBe(409); // "a buyer already paid — the item went to them"
      expect(await statusOf(id)).toBe('sold');
      expect(await qtyOf(buyer.wallet)).toBe(before + 1);
    });
  });

  it('SETTLES after the BUYER loses their land mid-flight (the stranded payment)', async () => {
    /**
     * THE OTHER HALF OF F6, AND THE ONE THAT WAS STILL OPEN. The caller of /reserve,
     * /paid and /settle is the BUYER, so `requireLandOwned` on those routes gated the
     * buyer — and a buyer can stop being a landowner mid-purchase for exactly the same
     * reason a seller can: they sold their own base, and `transferBase` nulls
     * `entryPaidAt`. The sequence below was: reserve (ok, still a landowner) → sign and
     * broadcast the SOL → lose land → 402 on /paid, 402 on /settle, 404 on /cancel
     * (not their listing). Their SOL was in the seller's wallet, the item was not
     * theirs, and only a third party's reserve/cancel triggering `settlePaidExpired`
     * could rescue it.
     *
     * THE GUARANTEE THIS ENCODES: once real money has moved, honouring the trade
     * depends on NEITHER party's land state. Restore `requireLandOwned` to `paidRl` or
     * `settleRl` in game/routes.ts and this test fails on the 402.
     */
    await buyLand(seller.wallet);
    const id = await listOne();
    // The buyer reserves while they still own land — the gated, commitment moment.
    expect((await post(buyer.cookie, `/market/listings/${id}/reserve`)).statusCode).toBe(201);

    // …then sells their own base out from under themselves. Real SOL is already gone.
    await takeLandFrom(buyer.wallet);

    const paid = await post(buyer.cookie, `/market/listings/${id}/paid`, { signature: marketSignatureOf(4) });
    expect(paid.statusCode, `/paid answered ${paid.statusCode}: ${paid.body.slice(0, 200)}`).toBe(200);
    const before = await qtyOf(buyer.wallet);
    const settle = await post(buyer.cookie, `/market/listings/${id}/settle`);
    expect(settle.statusCode, `/settle answered ${settle.statusCode}: ${settle.body.slice(0, 200)}`).toBe(200);
    expect(await statusOf(id)).toBe('sold');
    expect(await qtyOf(buyer.wallet)).toBe(before + 1); // they got what they paid for
    await buyLand(buyer.wallet); // restore for the tests after this one
  });

  it('still gates the buyer\'s RESERVE — the commitment, where refusing is free', async () => {
    // The creation side of the rule, on the BUYER this time: ungating /paid and
    // /settle must not ungate the moment that STARTS a purchase, or a deedless wallet
    // could take listings out of the landowners' book. 402, because the problem is
    // the caller, not the listing (contrast the 409 below).
    await buyLand(seller.wallet);
    const id = await listOne();
    const landless = await signIn(app);
    const res = await post(landless.cookie, `/market/listings/${id}/reserve`);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: { code: 'LAND_NOT_OWNED' } });
    expect(await statusOf(id)).toBe('active');
  });

  it('still refuses a NEW buyer taking a landless seller\'s open listing (409, not 402)', async () => {
    // The creation side of the rule is intact: nothing has moved yet, so refusing
    // costs nobody money. 409 because the caller is the buyer and there is nothing
    // wrong with THEM — the listing is stale.
    await buyLand(seller.wallet);
    const id = await listOne();
    await takeLandFrom(seller.wallet);
    const stranger = await signIn(app);
    await buyLand(stranger.wallet);
    const res = await post(stranger.cookie, `/market/listings/${id}/reserve`);
    expect(res.statusCode).toBe(409);
    expect(await statusOf(id)).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// F8 — private-key export is a CUSTODY right, not a game feature
// ---------------------------------------------------------------------------

describe('F8: a deedless wallet can export its key but cannot withdraw', () => {
  /**
   * THE FINDING. The withdrawal code sender is `owned`, but the key-EXPORT flow
   * once read it too, so a wallet that PAID, enrolled 2FA and later sold its base
   * was locked out of its own private key. Money may be gated; custody may not.
   *
   * The fix gives export its OWN two ungated reads (`GET /auth/export/status`,
   * `POST /auth/export/send-code`) scoped to exactly what the challenge needs, and
   * leaves `/withdrawals/*` gated. Profile factor management is now independently
   * auth-only + fresh-wallet-gated for admitted deedless users; it cannot move funds.
   */
  const codes: string[] = [];
  const emailSender = async (_to: string, _subject: string, body: string): Promise<void> => {
    codes.push(body);
  };
  const latestCode = (): string => {
    const m = codes.at(-1)?.match(/\b\d{6}\b/);
    expect(m, 'no 6-digit code in the sent email').toBeTruthy();
    return m![0];
  };
  let app: FastifyInstance;
  let s: { wallet: string; cookie: string; secretKey: Uint8Array };
  const post = (url: string, payload: Record<string, unknown> = {}, grant?: string) =>
    app.inject({
      method: 'POST', url, cookies: { [SESSION_COOKIE]: s.cookie }, payload,
      ...(grant ? { headers: { [RECENT_AUTH_HEADER]: grant } } : {}),
    });
  const get = (url: string) =>
    app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: s.cookie } });
  const reauth = async (purpose: RecentAuthPurpose): Promise<string> => {
    const challenge = await post('/auth/reauth/challenge', { purpose });
    expect(challenge.statusCode).toBe(200);
    const c = challenge.json() as { challengeToken: string; message: string };
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(c.message), s.secretKey));
    const verified = await post('/auth/reauth/verify', { challengeToken: c.challengeToken, signature });
    expect(verified.statusCode).toBe(200);
    return (verified.json() as { grant: string }).grant;
  };
  let factorGrant: string;
  let exportGrant: string;

  beforeAll(async () => {
    process.env['FREE_ONBOARDING'] = 'true';
    app = await buildApp(TEST_CONFIG, db, { emailSender });
    await app.ready();
    s = await signIn(app);
    // The population this is about: paid, enrolled 2FA, THEN sold the base.
    await buyLand(s.wallet);
    factorGrant = await reauth('factor_change');
    expect((await post('/2fa/email/start', { email: 'owner@pixelkingdomwars.com' }, factorGrant)).statusCode).toBe(200);
    expect((await post('/2fa/email/verify', { code: latestCode() }, factorGrant)).statusCode).toBe(200);
    exportGrant = await reauth('key_export');
    await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, s.wallet));
  });
  afterAll(async () => {
    await app.close();
    delete process.env['FREE_ONBOARDING'];
  });

  it('completes the whole export challenge with no land', async () => {
    const status = await get('/auth/export/status');
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ emailVerified: true, gated: true });

    expect((await post('/auth/export/send-code')).statusCode).toBe(200);
    const done = await post('/auth/export/challenge', { method: 'email', code: latestCode() }, exportGrant);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ exportOk: true, gated: true });
  });

  it('still enforces the second factor — ungating did not weaken the challenge', async () => {
    // WHY: the point is to move the flow out of the LAND gate, not out of 2FA. A
    // hijacked session must not be able to export a key.
    expect((await post('/auth/export/challenge', {}, exportGrant)).statusCode).toBe(422);
    expect((await post('/auth/export/challenge', { method: 'email', code: '000000' }, exportGrant)).statusCode).toBe(422);
  });

  it('can manage account security without land, but cannot reach withdrawal money/code routes', async () => {
    expect((await get('/2fa/status')).statusCode).toBe(200);
    // Handler reached with no land 402; the missing fresh-wallet proof is the
    // only refusal. This is an account setting, not a deed privilege.
    const factorWithoutFreshProof = await post('/2fa/email/start', { email: 'replacement@pixelkingdomwars.com' });
    expect(factorWithoutFreshProof.statusCode).toBe(428);
    expect(factorWithoutFreshProof.json()).toMatchObject({ error: { code: 'RECENT_AUTH_REQUIRED' } });

    // The valve stays shut: real SPL KEEP leaves the hot wallet through these.
    for (const p of GATED) {
      if (!p.route.includes('/withdrawals')) continue;
      const res = await hit(app, s.cookie, p);
      expect(res.statusCode, `${p.route} must stay land-gated`).toBe(402);
    }
  });

  it('uses a session-bound factor email challenge, never the land-gated withdrawal sender', async () => {
    // Earlier export assertions issued the same DB purpose under a DIFFERENT
    // context. Clear this fixture wallet's spent rows only so resend cooldown
    // does not make the independent route test wait in real time.
    await db.delete(emailOtps).where(eq(emailOtps.playerWallet, s.wallet));
    const sent = await post('/2fa/step-up/email', {}, factorGrant);
    expect(sent.statusCode).toBe(200);
    const stepCode = latestCode();
    const change = await post('/2fa/email/start', {
      email: 'replacement@pixelkingdomwars.com',
      stepUp: { method: 'email', code: stepCode },
    }, factorGrant);
    expect(change.statusCode).toBe(200);
  });
});
