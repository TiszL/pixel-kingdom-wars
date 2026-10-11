import { readAdvancedServicePresentation } from './advancedServicePresentation';
import { readCurrentAdvancedIdentity, type AdvancedFleetIdentity } from './currentAdvancedIdentity';
import {readServiceActivity} from './serviceActivity';
import { withHarvesterActivity } from './harvesterActivity';
import {readBoundCosmeticBase} from './boundCosmeticPresentation';
import { MinePurchaseIntentSchema, type MinePurchaseIntent } from '@shardkeep/shared/minePurchase';
import { MINE_PURCHASE_FEATURE, additionalMineQuote, assertMinePurchaseScope, replayMinePurchase } from './constructionReceipt';
import { clientCurrencyContext } from './clientCurrency';
import type { BuilderJobSpeedupConsent } from '@shardkeep/shared/builderJobSpeedup';
import { BUILDER_JOB_SPEEDUP_FEATURE, builderJobPaidQuote, builderJobSpeedupIntent, assertBuilderJobSpeedupScope, replayBuilderJobSpeedup } from './builderJobSpeedupReceipt';
import { plotVersionForClaim } from '@shardkeep/shared';
import type { BasePurchaseRequest } from '@shardkeep/shared/basePurchases';
/**
 * Base state service (PLAN.md 4a/4b — GDD §3.0/§3.1, Addendum B5/B7,
 * HANDOFF §3). Server-authoritative: every cost, gate, cap and geometry rule
 * is enforced here; the client only renders.
 *
 * Decisions documented here (flagged at extraction, decided for alpha):
 * - Wall cap band by Keep level: L1–2→20, L3–4→40, L5→60 (shared
 *   wallCapForKeepLevel). No per-type building caps beyond walls/traps.
 * - Wall tier upgrades are instant (cost only, no builder) — GDD gives no
 *   wall upgrade time; matches per-segment upgrade UX.
 * - Builder jobs complete LAZILY: any read/mutation first materializes due
 *   completions (no background timer to drift from the db).
 * - Under-construction buildings exist as rows immediately but are excluded
 *   from raid snapshots until their build job completes.
 * - Obstacles use the reference App's deterministic coordinate hash (same
 *   pattern for every player — prototype contract, docs/research
 *   read-app-data-model.md §genObs), generated once at base creation on the
 *   rings outside the initial claim plus the claim fringe. Legacy mode enforces
 *   "once" per wallet; multi-base mode enforces it by stable base id so a deed
 *   transfer cannot regenerate terrain into the purchased base.
 */
import {
  BATTLE_HISTORY,
  BUILD_COSTS,
  artTierOfLevel,
  buildCountCapForKeep,
  effectiveBuildCountCapForKeep,
  BuildingType,
  CAPS,
  DEFENSE_LEVELING,
  DRAGON_NEST_ENABLED,
  ECONOMY,
  GRID,
  HEROES,
  HERO_KEYS,
  MINING,
  NEW_DEFENSE_TYPES,
  NEW_ROSTER_ENABLED,
  OBSTACLES,
  OBSTACLE_REMNANT_DAYS,
  PHASE_E_BUILDINGS,
  RAID_ENERGY,
  speedupCostKeep, wallRowThrough, type WallRowUpgradeQuote, type WallRowUpgradeResult,
  STRUCTURES,
  TROOP_TYPES,
  TRAP_REPAIR,
  TRAP_TYPES,
  UPGRADE_CANCELLATION,
  UPGRADE_COSTS,
  UPGRADE_TIMES_SEC,
  upgradeSolLamports, PLAYTEST, DEVNET_FAUCET,
} from '@shardkeep/shared';
import type { WallBatchRequest } from '@shardkeep/shared/wallBatch';
import { HeroRecruitmentReceiptSchema, type HeroRecruitmentRequest, type HeroRecruitmentFunding } from '@shardkeep/shared/heroRecruitment';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, exists, gt, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { accounts, baseBattleRecords, baseHeroProgress, baseItems, baseRaidLocks, bases, baseSlots, baseTransfers, builderJobs, buildings, heroLevels, itemUses, ledgerEntries, ledgerTransactions, obstacles, playerItems, players, raids } from '../db/schema';
import { multiBaseEnabled, phaseEArtEnabled, phaseEBuildingsEnabled, phaseEVehiclesEnabled } from '../config';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../ledger/accounts';
import { InsufficientFundsError, postTransaction } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import { getArmyState } from './army';
import { hasLand } from './land';
import { resolveBaseVisual } from './baseVisual';
import { ensureMineState, markBuildAction, reanchorMineAccrual, utcDay } from './emission';
import {
  ensureBaseMineState, reanchorBaseMineAccrual, rescheduleBaseMineFullChecks,
} from './baseMining';
import { getBaseShardBalance, rewardBaseShards, spendBaseShards } from './baseEconomy';
import { progressQuestBatch } from './quests';
import { getRaidEnergy } from './raids';
import { ensureBaseProfile } from './baseProfiles';
import { claimRect, footprintOf, insideClaim, overlaps, type Rect } from './footprints';
import { syncKitObstacles } from './kitObstacles';
import { rewardShards, spendGameCurrency, spendShards } from './spend';
import { getEffectiveShieldStatus } from './baseShields';
import { getGameConfig } from './gameConfig';
import { acceptWelcomeGems, firstWalletBaseSetup, hasWelcomeHistory, retryWelcomeGems } from './welcomeGems';
import { warzoneStatus } from './warzone';
import { settleDueStarterExpeditions } from './starterExpeditionReturns';
// C5 (K252): root's redaction of THIS read's newly settled starter returns into transient journey callbacks.
import { readNewStarterReturnJourneyEvents } from './fleetJourneyPresentation';
import type { FleetJourneyEventBatch } from '@shardkeep/shared/fleetJourneyPresentation';
import { readProtectedCraftingStock, settleDueOrdinaryCrafting } from './ordinaryCrafting';
import { readStarterFleetView } from './starterFleetView';
// Phase E P3: optional starter rendering facts; custody and originals stay canonical.
import { readStarterServicePresentation } from './starterServicePresentation';
// End Phase E P3 presentation import.
import { readStarterExpeditionView } from './starterExpeditionView';
import { readHarvesterView } from './harvesterView';
import { readPendingOrdinaryCrafting } from './ordinaryCraftingView';
import { readRaidExposedRawStock } from './resourceStock';
import { settleDueHarvesterSources } from './harvesterSettlement';

// Keep spawn, DERIVED from the centered claim so it can never drift from the plot
// geometry again (a hardcoded coord is exactly what desynced when the plot grew
// 18→30 and produced the deploy-zone bug). claimRect(0) is [8,22); centering the
// 2×2 keep inside it gives (14,14). Existing bases were re-centered by migration
// 0018 (owner 2026-07-20 CoC layout).
const KEEP_START = ((): { tx: number; ty: number } => {
  const { min } = claimRect(0);
  const off = Math.floor((CAPS.claimTilesByExpansion[0]! - STRUCTURES.keep.footprint[0]) / 2);
  return { tx: min + off, ty: min + off };
})();

/**
 * BUILDINGS THAT REQUIRE LAND (docs/LAND-DEED-ONBOARDING-PLAN.md §2.2, R2).
 *
 * ROUTE GATING CANNOT DO THIS, and that is the whole reason this set exists. The
 * Gold Forge is not only the six `/forge/*` routes — it is a placeable
 * `BuildingType` (costShards 2_500, requiresKeepLevel 3) raised through
 * POST /base/buildings, which is FREE. A landless player who owns a forge owns
 * the only shards→KEEP faucet in the game, and KEEP is the only withdrawable
 * currency, so the free tier would print real money. The check therefore lives
 * with the PLACEMENT, next to the other per-type gates, where every path that
 * can create or level a forge has to pass it.
 *
 * FORGE ONLY, deliberately (decided 2026-08-09). Every other buildable type is
 * either pure base progress or already priced in something a landless player
 * cannot mint: mines past the first require SOL through the deposit flow, mine
 * upgrades require SOL, and everything else spends SHARDS, which are not
 * withdrawable (money/withdrawals.ts only ever touches `player_keep`). If a
 * future building mints or moves KEEP, add it here in the same commit.
 */
const LAND_GATED_BUILDINGS: ReadonlySet<string> = new Set<string>([BuildingType.GoldForge]);

/** 402 LAND_NOT_OWNED for a landless player touching a land-gated building.
 *  Same status + code as the route gate, so the client's one 402 handler routes
 *  to the buy-land screen whether the refusal came from the router or from here. */
function assertLandForBuilding(type: string, player: { entryPaidAt: Date | null }): void {
  if (!LAND_GATED_BUILDINGS.has(type)) return;
  if (hasLand(player)) return;
  throw new HttpError(402, 'the Gold Forge needs land — buy your parcel first', 'LAND_NOT_OWNED');
}

type ObstacleTier = keyof typeof OBSTACLES.tiers;

function obstacleTierOf(spriteKey: string): ObstacleTier {
  for (const [tier, def] of Object.entries(OBSTACLES.tiers) as Array<[ObstacleTier, { kinds: readonly string[] }]>) {
    if ((def.kinds as readonly string[]).includes(spriteKey)) return tier;
  }
  throw new HttpError(500, `unknown obstacle sprite: ${spriteKey}`);
}

function obstacleRect(spriteKey: string, tx: number, ty: number): Rect {
  const size = OBSTACLES.tiers[obstacleTierOf(spriteKey)].sizeTiles;
  return { tx, ty, fw: size, fh: size };
}

/** The reference App's coordinate hash (read-app-data-model.md): 34% density, large <6. */
function obsHash(tx: number, ty: number): number {
  return Math.abs(((tx + 7) * 73856093) ^ ((ty + 5) * 19349663)) % 100;
}

// ---------------------------------------------------------------------------
// Starting base + obstacles
// ---------------------------------------------------------------------------

export type LockedBaseAuthority = (tx: DbTx, wallet: string, baseId: string) => Promise<void>;

export async function ensureStartingBase(
  db: Db, wallet: string, baseId?: string, authorizeBase?: LockedBaseAuthority,
): Promise<void> {
  return db.transaction(async (tx) => {
    // One wallet can race auth restore, GET /base and deposit verification. Lock
    // its player row so Keep creation, terrain and the v2 starter posting are one
    // all-or-nothing initialization rather than three crash windows.
    const [player] = await tx.select({ entryPaidAt: players.entryPaidAt }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    if (baseId) {
      const [base] = await tx.select({ id: bases.id }).from(baseSlots)
        .innerJoin(bases, eq(bases.id, baseSlots.baseId)).where(and(
          eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
          eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
        )).for('update');
      if (!base) throw new HttpError(404, 'base not owned', 'BASE_NOT_OWNED');
      if (authorizeBase) await authorizeBase(tx, wallet, baseId);
    }
    await ensureStartingBaseLocked(tx, wallet, player.entryPaidAt, baseId);
  });
}

async function ensureStartingBaseLocked(
  db: DbOrTx, wallet: string, entryPaidAt: Date | null, baseId?: string,
): Promise<void> {
  // Previously accepted wallet aid must retry before either populated-base
  // early return, including after a base transfer or while new grants are paused.
  let welcomeReward = await retryWelcomeGems(db, wallet);
  const existing = await db.select({ id: buildings.id }).from(buildings)
    .where(and(
      baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet),
      eq(buildings.type, 'keep'),
    )).limit(1);
  if (existing.length > 0) {
    // A populated stable base already carries whatever balance its deed owns.
    // In migration the wallet starter is moved into the deterministic primary
    // base; minting another per-base starter here would duplicate live funds.
    if (baseId) return;
    // Owner 2026-08-11: compensate only deedless wallets that actually received
    // the historical 500-SHARD starter posting. The v2 key makes this safe on
    // every lazy base read; landowners receive no retroactive grant.
    const [historical, toppedUp] = await Promise.all([
      db.select({ delta: ledgerEntries.delta }).from(ledgerTransactions)
        .innerJoin(ledgerEntries, eq(ledgerEntries.txnId, ledgerTransactions.id))
        .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
        .where(and(
          eq(ledgerTransactions.idempotencyKey, `starter:${wallet}`),
          eq(accounts.ownerWallet, wallet), eq(accounts.kind, 'player_shards'),
        )).then((r) => r[0]),
      db.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, `starter:topup:v2:${wallet}`)).then((r) => r[0]),
    ]);
    if (!historical) {
      // A first-time wallet may receive an already-populated deed/base before
      // its first game login. Grant wallet state once without touching the
      // purchased base; this is the normal starter idempotency key.
      await rewardShards(db, wallet, BigInt(ECONOMY.starterShards),
        'base.starter_grant', `starter:${wallet}`,
        { version: 2, amount: ECONOMY.starterShards });
    } else if (!entryPaidAt && !toppedUp && historical.delta === BigInt(ECONOMY.starterShardsV1)) {
      await rewardShards(db, wallet, BigInt(ECONOMY.starterShards - ECONOMY.starterShardsV1),
        'base.starter_topup', `starter:topup:v2:${wallet}`,
        { from: ECONOMY.starterShardsV1, to: ECONOMY.starterShards });
    }
    return;
  }

  const firstSetup = await firstWalletBaseSetup(db, wallet);

  await db.insert(buildings).values({
    playerWallet: wallet,
    baseId,
    type: BuildingType.Keep,
    level: 1,
    tx: KEEP_START.tx,
    ty: KEEP_START.ty,
  });

  /**
   * TERRAIN IS GENERATED ONCE PER WALLET, EVER (security review 2026-08-09 F5 —
   * a proved net-positive resource loop).
   *
   * The generator below is a pure function of the tile coordinates, so it produces
   * the SAME set every time it runs. Clearing a small obstacle costs
   * OBSTACLES.tiers.small.costKeep (10) and pays OBSTACLES.clearRewardShards (15),
   * i.e. +5 net, and the reward's idempotency key is the JOB id — so a freshly
   * generated obstacle pays again. `abandonFreeBase` deletes the Keep, which is
   * what this function's early-return keys on, so before this guard the loop
   * abandon → GET /base → clear the small obstacles → abandon minted shards with no
   * cooldown and no per-wallet limit: an unbounded faucet.
   *
   * MEASURED, so the size claim is honest: a plot is 189 obstacles (73 small / 84
   * medium / 32 large), but `clearObstacle` refuses tiles outside the claim and
   * abandon resets `expansions` to 0, so a REPEAT cycle can only reach the 4 tiles
   * of the initial claim — exactly one small, i.e. +5 a cycle, not the +365 a
   * whole-plot reading gives. A landowner cannot abandon at all. The rate is
   * therefore small; being unbounded and repeatable is what makes it a defect.
   *
   * The fix is NOT to reprice the tiers. ECONOMY.md lists every income line —
   * mining quota, daily cache, raid loot, quests/leagues/referrals — and obstacle
   * clearing is not one of them, because the App's "+15 SHARDS FOUND" is a ONE-TIME
   * bonus for improving your own land, not an income source. Repricing would break
   * the App-derived numbers (authority chain: reference App) to fix a bug that is
   * really about terrain being resurrected. So terrain becomes non-renewable
   * instead: `abandonFreeBase` TOMBSTONES obstacles (clearedAt) rather than
   * deleting them, and any surviving row — standing or cleared — means this land
   * has already been generated and must never be generated again. The one-time
   * lifetime bonus on a wallet's first base (up to +365, and only as SOL-bought
   * expansions unlock the outer rings) is unchanged behaviour, and it is bounded.
   *
   * A SALE ALSO EMPTIES THE ROW CHECK, WHICH IS WHY IT IS NOT THE ONLY CHECK
   * (security review 2026-08-09 F5, second half — the first pass claimed
   * "once per wallet, ever" while `transferBase` falsified it). Selling a base moves
   * EVERY obstacle row, tombstones included, onto the buyer (baseTransfer.ts) and
   * leaves the seller with no Keep — so the seller's next `GET /base` found zero rows
   * and regenerated all 189 tiles, restoring the +5 net small clear inside the reset
   * (expansions → 0) claim. Bounded by the price of a base rather than unbounded, but
   * it is the same defect and the same one-line shape.
   *
   * `base_transfers` is the permanent, append-only trace of that move (it records
   * `from_wallet` in the same transaction as the move), so "this wallet has had
   * terrain" survives the rows leaving. Read only when there are no obstacle rows,
   * i.e. once per wallet on the path that would generate — never on a hot route.
   * The guarantee this pair must keep TRUE: terrain is generated at most once per
   * wallet, for the lifetime of the wallet, whatever happens to the base afterwards.
   */
  const priorTerrain = await db.select({ id: obstacles.id }).from(obstacles)
    .where(baseId ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, wallet)).limit(1);
  // Stable bases carry terrain through a transfer. Legacy wallet mode still
  // needs the permanent sale audit because its rows were historically rewritten.
  const soldABase = baseId || priorTerrain.length > 0 ? [] : await db.select({ id: baseTransfers.id })
    .from(baseTransfers).where(eq(baseTransfers.fromWallet, wallet)).limit(1);
  if (priorTerrain.length === 0 && soldABase.length === 0) {
    // Deterministic obstacles on tiles outside the INITIAL claim (the rings a
    // player unlocks by expanding) + sparse fringe inside. Row-major; larger
    // obstacles skip when they'd overlap one already placed or leave the plot.
    const { min: claimMin, max: claimMax } = claimRect(0);
    const placed: Rect[] = [];
    const rows: Array<typeof obstacles.$inferInsert> = [];
    for (let ty = 0; ty < GRID.plotTiles; ty++) {
      for (let tx = 0; tx < GRID.plotTiles; tx++) {
        const insideInitialClaim = tx >= claimMin && tx < claimMax && ty >= claimMin && ty < claimMax;
        const onFringe = insideInitialClaim &&
          (tx === claimMin || tx === claimMax - 1 || ty === claimMin || ty === claimMax - 1);
        const h = obsHash(tx, ty);
        // outside the claim: outsideDensityPct density; on the fringe: sparse
        // starters below fringeStarterMax (all tuning in OBSTACLES.generation).
        const gen = OBSTACLES.generation;
        if (insideInitialClaim ? !(onFringe && h < gen.fringeStarterMax) : h >= gen.outsideDensityPct) continue;
        const tier: ObstacleTier = !insideInitialClaim && h < gen.largeThreshold ? 'large' : h % 2 === 0 ? 'small' : 'medium';
        const kinds = OBSTACLES.tiers[tier].kinds;
        const spriteKey = kinds[h % kinds.length]!;
        const rect = obstacleRect(spriteKey, tx, ty);
        if (rect.tx + rect.fw > GRID.plotTiles || rect.ty + rect.fh > GRID.plotTiles) continue;
        const keepRect: Rect = { ...KEEP_START, fw: 2, fh: 2 };
        if (overlaps(rect, keepRect) || placed.some((p) => overlaps(p, rect))) continue;
        placed.push(rect);
        rows.push({ playerWallet: wallet, baseId, spriteKey, tx, ty });
      }
    }
    if (rows.length > 0) await db.insert(obstacles).values(rows);

    // Accept independently of mail delivery. B4 used a KEEP-mail fallback on
    // budget failure; those old recipients are explicitly excluded, so retry
    // cannot grant Gems on top of their still-claimable KEEP attachment.
    const priorWelcome = await hasWelcomeHistory(db, wallet);
    if (!welcomeReward) {
      await acceptWelcomeGems(db, wallet, firstSetup);
      welcomeReward = await retryWelcomeGems(db, wallet);
    }
    // Mail is optional; the accepted wallet promise is not. Both delivery and
    // grant run in savepoints, so an unavailable optional lane cannot abort base
    // founding or discard the obligation that a later game access will retry.
    try {
      const { deliverSystemMail } = await import('../mail');
      const devnet = (process.env['SOLANA_CLUSTER'] ?? 'devnet') === 'devnet';
      const welcomeKeepMail = devnet && !welcomeReward && !priorWelcome;
      // Playtest welcome (owner 2026-08-22): devnet players get the 5,000 KEEP
      // welcome reward attached (claim from MAIL) and learn that devnet SOL is
      // funded automatically in-game. D-098: the in-game faucet is the only one
      // the mail stands by — the public faucet is named once, as a caveat.
      // The deliveryKey is unchanged, so wallets that already received the older
      // welcome never get a second one (and never a second KEEP reward).
      await deliverSystemMail(db as Db, {
        recipientWallet: wallet,
        deliveryKey: `welcome:${wallet}`,
        subject: devnet ? '⚔ WELCOME TO THE PLAYTEST' : '⚔ WELCOME TO PIXEL KINGDOM WARS',
        body: (devnet ? [
          'Welcome, Keeper — your Keep stands and the realm is live.',
          '',
          ...(welcomeReward ? (welcomeReward.granted ? [
            `YOUR WELCOME REWARD: ${welcomeReward.gems.toLocaleString('en-US')} GEMS are already in your balance.`,
            'Spend them in the SHOP, on elite troops, or convert them to SHARDS.',
          ] : [
            `YOUR WELCOME REWARD: ${welcomeReward.gems.toLocaleString('en-US')} GEMS are pending.`,
            'Your reward is saved. Return to your base after funding is available; it will appear automatically.',
          ]) : welcomeKeepMail ? [
            `YOUR WELCOME REWARD: ${PLAYTEST.welcomeKeep.toLocaleString('en-US')} KEEP is attached to this mail — tap CLAIM.`,
            'Spend it in the SHOP, on elite troops, or smelt shards in the Gold Forge.',
          ] : []),
          '',
          'DEVNET SOL: this playtest runs on Solana DEVNET, so SOL here is free',
          `test SOL. The in-game faucet funds your wallet automatically (${DEVNET_FAUCET.grantSol} SOL`,
          `whenever you drop below ${DEVNET_FAUCET.minBalanceSol} SOL), up to ${DEVNET_FAUCET.lifetimeCapSol} SOL per wallet,`,
          `${DEVNET_FAUCET.cooldownHours} h apart. Running low? The land screen has a CLAIM DEVNET SOL`,
          'button. The public faucet at faucet.solana.com may ask for a mainnet',
          'SOL balance on the same wallet, so the in-game faucet is the one to use.',
        ] : [
          'Welcome, Keeper — your Keep stands and the realm is live.',
          '',
          'Review every on-chain SOL quote in your wallet before signing.',
        ]).concat([
          '',
          `WHAT SOL IS FOR: your Land Deed (${ECONOMY.entryFeeSol} SOL) — a permanent spot on the`,
          'pixel Earth that YOU pick on the globe — plus late Mine and Gold',
          'Forge upgrades. Everything else is earned by playing: mine SHARDS,',
          'raid for loot, forge KEEP.',
          '',
          'Build, raid, and hold the line.',
        ]).join('\n'),
        ...(welcomeKeepMail ? { attachments: [{ kind: 'KEEP' as const, amount: BigInt(PLAYTEST.welcomeKeep) }] } : {}),
      });
    } catch (e) {
      // Mail is optional; the base is not — but a silently missing welcome
      // (dry emission pool, disabled lane) must be visible in the logs.
      console.warn(`[welcome-mail] skipped for ${wallet}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Keep the original wallet-lifetime key: abandoning or selling a base must
  // never create another starter faucet. A brand-new wallet posts 2,000; an old
  // wallet gets its original 500 back as a duplicate and, only while deedless,
  // receives the same one-time +1,500 compensating posting used above.
  const starter = baseId
    ? await rewardBaseShards(db, baseId, BigInt(ECONOMY.starterShards),
      'base.starter_grant', `starter:base:${baseId}`,
      { version: 3, amount: ECONOMY.starterShards })
    : await rewardShards(db, wallet, BigInt(ECONOMY.starterShards),
      'base.starter_grant', `starter:${wallet}`,
      { version: 2, amount: ECONOMY.starterShards });
  const historicalAmount = starter.entries.find((e) => e.delta > 0n)?.delta;
  if (!baseId && !entryPaidAt && starter.duplicate && historicalAmount === BigInt(ECONOMY.starterShardsV1)) {
    await rewardShards(db, wallet, BigInt(ECONOMY.starterShards - ECONOMY.starterShardsV1),
      'base.starter_topup', `starter:topup:v2:${wallet}`,
      { from: ECONOMY.starterShardsV1, to: ECONOMY.starterShards });
  }
}

// ---------------------------------------------------------------------------
// Lazy job completion
// ---------------------------------------------------------------------------

/**
 * Building type → the onboarding step finishing it completes. The three
 * structures the owner named for the first-run path (2026-08-28: "First level
 * camp, mine, barracks"); every other type maps to nothing and ticks nothing.
 */
const ONBOARDING_BUILD_STEPS: Readonly<Record<string, string>> = {
  [BuildingType.Camp]: 'first_camp',
  [BuildingType.Mine]: 'first_mine',
  [BuildingType.Barracks]: 'first_barracks',
};

export async function completeDueJobs(db: DbOrTx, wallet: string, now = new Date(), baseId?: string): Promise<void> {
  const due = await db.select().from(builderJobs).where(and(
    baseId ? eq(builderJobs.baseId, baseId) : eq(builderJobs.playerWallet, wallet),
    isNull(builderJobs.completedAt),
    lte(builderJobs.finishesAt, now),
  ));
  for (const job of due) {
    await db.transaction(async (tx) => {
      let builtType: string | null = null;
      // claim the job (idempotent under concurrency)
      const claimed = await tx.update(builderJobs)
        .set({ completedAt: now })
        .where(and(eq(builderJobs.id, job.id), isNull(builderJobs.completedAt)))
        .returning({ id: builderJobs.id });
      if (claimed.length === 0) return;

      if (job.kind === 'upgrade' && job.buildingId) {
        // A Mine or Keep upgrade RAISES the summed mining quota (mine level ×, or
        // the keep multiplier). Settle the accrual buffer at the pre-upgrade rate
        // BEFORE the level bumps, so the higher rate never applies retroactively
        // (security review 2026-07-19 over-credit fix).
        const [before] = await tx.select({ type: buildings.type }).from(buildings)
          .where(eq(buildings.id, job.buildingId));
        if (before?.type === 'mine' || before?.type === 'keep') {
          if (job.baseId) await reanchorBaseMineAccrual(tx, job.baseId, now);
          else await reanchorMineAccrual(tx, wallet, now);
        }
        await tx.update(buildings)
          .set({ level: sql`${buildings.level} + 1` })
          .where(eq(buildings.id, job.buildingId));
        const [b] = await tx.select().from(buildings).where(eq(buildings.id, job.buildingId));
        if (b) await creditCompletedUpgradeQuests(tx, wallet, job, b.level);
        if (b?.type === 'keep') {
          if (job.baseId) {
            await tx.update(bases).set({ keepLevel: b.level, updatedAt: now }).where(eq(bases.id, job.baseId));
            await tx.execute(sql`update players set keep_level=${b.level}
              where wallet=${wallet} and (select count(*) from bases where owner_wallet=${wallet}) = 1`);
          } else {
            await tx.update(players).set({ keepLevel: b.level }).where(eq(players.wallet, wallet));
          }
        }
        if (job.baseId && (before?.type === 'mine' || before?.type === 'keep')) {
          await rescheduleBaseMineFullChecks(tx, job.baseId, now);
        }
      } else if (job.kind === 'clear_obstacle' && job.obstacleId) {
        // Tombstone, not delete: the job row references it, and cleared
        // obstacles must never respawn (HANDOFF §3.9).
        await tx.update(obstacles).set({ clearedAt: now }).where(eq(obstacles.id, job.obstacleId));
      } else if (job.kind === 'build' && job.buildingId) {
        // A completed Mine build starts producing NOW. The build job is already
        // marked done above, so this mine would otherwise count immediately at the
        // OLD accrual anchor — back-crediting income for the whole pre-build window.
        // Re-anchor first, EXCLUDING this mine (settle at the prior quota + clock to
        // now), then ensure the anchor exists for the very first mine.
        const [b] = await tx.select({ type: buildings.type }).from(buildings)
          .where(eq(buildings.id, job.buildingId));
        // Inside the claimed-job branch, so the onboarding tick below fires
        // exactly once per finished building however often this is called.
        builtType = b?.type ?? null;
        if (b?.type === 'mine') {
          if (job.baseId) {
            await reanchorBaseMineAccrual(tx, job.baseId, now, job.buildingId);
            await ensureBaseMineState(tx, job.buildingId, job.finishesAt);
          } else {
            await reanchorMineAccrual(tx, wallet, now, job.buildingId);
            await ensureMineState(tx, wallet, now);
          }
        }
      } else if (job.kind === 'repair' && job.buildingId) {
        // The trap stays spent (and is omitted from raid snapshots) for the full
        // builder timer. Only the claimed due job rearms it (owner 2026-08-15/M22).
        await tx.update(buildings).set({ trapSpentAt: null })
          .where(eq(buildings.id, job.buildingId));
      }

      if (job.kind === 'clear_obstacle') {
        // "+15 SHARDS FOUND" (App) — literally shards post-split; idempotent on job id.
        if (job.baseId) {
          await rewardBaseShards(tx, job.baseId, BigInt(OBSTACLES.clearRewardShards),
            'obstacle.clear_reward', `obstacle-reward:${job.id}`);
        } else {
          await rewardShards(tx, wallet, BigInt(OBSTACLES.clearRewardShards),
            'obstacle.clear_reward', `obstacle-reward:${job.id}`);
        }
        // M23 a15: the claimed-job guard above makes this exactly-once per job.
        await progressQuestBatch(tx, wallet, [['clear_obstacle', 1]], now, job.baseId ?? undefined);
      }
      // ONBOARDING CHAIN (owner 2026-08-28): the first Camp, Mine and Barracks.
      // Ticked on COMPLETION, not on placement — the step says "build an Army
      // Camp", and a player watching a builder timer has not built one yet. Level-1
      // builds are short enough that the payoff still lands inside the first
      // session. `first_camp` and friends are no-ops once claimed (LEAST clamp),
      // so this fires unconditionally like every other tick volley.
      const onboardingBuild = builtType ? ONBOARDING_BUILD_STEPS[builtType] : undefined;
      if (onboardingBuild) {
        await progressQuestBatch(tx, wallet, [[onboardingBuild, 1]], now, job.baseId ?? undefined);
      }
    });
  }
}

async function activeJobs(db: DbOrTx, wallet: string, baseId?: string) {
  return db.select().from(builderJobs).where(and(
    baseId ? eq(builderJobs.baseId, baseId) : eq(builderJobs.playerWallet, wallet),
    isNull(builderJobs.completedAt),
  ));
}

/** The attacker's own row of the same battle: its frozen ownerWalletAtBattle is
 * the identity the raid log names and REVENGE attacks, so the HUD must not
 * substitute a different wallet for the same fight. */
const attackerRecords = alias(baseBattleRecords, 'base_defence_attacker');

/**
 * The newest defences of one deed for the HUD's RAIDED chip and base-load toast
 * (D-099, owner 2026-09-02: "no notification that you have been raided"). One
 * read on base_battle_records_history_idx, capped by BATTLE_HISTORY
 * .hudRecentDefences; the raid log remains the paged, loot-bearing record, so
 * nothing monetary travels here. The deedless starter has no deed history and
 * gets the empty shape rather than a wallet-keyed guess.
 */
async function recentDefences(db: DbOrTx, baseId: string | null) {
  if (!baseId) return { lastAt: null, recent: [] };
  const rows = await db.select({
    raidId: baseBattleRecords.raidId,
    createdAt: baseBattleRecords.createdAt,
    attackerBaseId: baseBattleRecords.counterpartyBaseId,
    attackerWallet: attackerRecords.ownerWalletAtBattle,
    attackerName: players.name,
    stars: baseBattleRecords.stars,
    destructionPct: baseBattleRecords.destructionPct,
  }).from(baseBattleRecords)
    .leftJoin(attackerRecords, and(
      eq(attackerRecords.raidId, baseBattleRecords.raidId),
      eq(attackerRecords.role, 'attacker'),
    ))
    .leftJoin(players, eq(players.wallet, attackerRecords.ownerWalletAtBattle))
    .where(and(eq(baseBattleRecords.baseId, baseId), eq(baseBattleRecords.role, 'defender')))
    .orderBy(desc(baseBattleRecords.createdAt), desc(baseBattleRecords.raidId))
    .limit(BATTLE_HISTORY.hudRecentDefences);
  const recent = rows.map((row) => ({
    raidId: row.raidId,
    createdAt: row.createdAt.toISOString(),
    attackerBaseId: row.attackerBaseId,
    attackerWallet: row.attackerWallet,
    attackerName: row.attackerName,
    stars: row.stars,
    destructionPct: row.destructionPct,
  }));
  return { lastAt: recent[0]?.createdAt ?? null, recent };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `GET /base` `clearedObstacles[]` (docs/REALM-KIT-PLAN.md E-11, D-173): the
 * remnant a cleared obstacle leaves on the terrain — a stump for a tree, rubble
 * for a rock — keyed by the row's original `spriteKey` so the client draws the
 * kit's remnant twin at the same tile. Presentation only: the row is tombstoned,
 * the tile is buildable and nothing here is a clear target or a reward. */
export interface ClearedObstacleDto { spriteKey: string; tx: number; ty: number; clearedAt: Date }

/** Obstacles the PLAYER cleared (a completed `clear_obstacle` builder job) within
 * OBSTACLE_REMNANT_DAYS. Rows tombstoned wholesale — abandon, transfer, ops
 * retirement — have no completed clear job and leave no remnant: nobody felled
 * those trees. Additive to `obstacles[]`, which keeps listing only standing rows. */
async function recentlyClearedObstacles(db: DbOrTx, wallet: string, now: Date, baseId?: string): Promise<ClearedObstacleDto[]> {
  const obstacleScope = baseId ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, wallet);
  const cutoff = new Date(now.getTime() - OBSTACLE_REMNANT_DAYS * 86_400_000);
  const rows = await db.select({ spriteKey: obstacles.spriteKey, tx: obstacles.tx, ty: obstacles.ty, clearedAt: obstacles.clearedAt })
    .from(obstacles)
    .where(and(obstacleScope, isNotNull(obstacles.clearedAt), gte(obstacles.clearedAt, cutoff),
      exists(db.select({ id: builderJobs.id }).from(builderJobs).where(and(
        eq(builderJobs.obstacleId, obstacles.id), eq(builderJobs.kind, 'clear_obstacle'), isNotNull(builderJobs.completedAt))))))
    .orderBy(obstacles.clearedAt, obstacles.tx, obstacles.ty);
  return rows.map((row) => ({ spriteKey: row.spriteKey, tx: row.tx, ty: row.ty, clearedAt: row.clearedAt! }));
}

class OrdinaryCollectionRequired extends HttpError {
  constructor() { super(503, 'Workshop completion is pending. Refresh and try again.', 'ORDINARY_CRAFTING_COLLECTION_REQUIRED'); }
}

export async function getBaseState(
  db: DbOrTx, wallet: string, now = new Date(), baseId?: string,
  authorizeBase?: LockedBaseAuthority,
  // Stable event time must be sampled after locks, not captured before a wait.
  // Legacy callers retain the third-argument clock semantics below.
  clock: () => Date = () => new Date(),
  craftingCatalogueVersion?: 1 | 2,
  // An owner collector may run only after this whole protected read rolls back.
  collectOrdinary?: () => Promise<unknown>,
): Promise<Awaited<ReturnType<typeof getBaseStateLocked>> & {
  craftingShardsAvailable?: string;
  craftingStock?: Awaited<ReturnType<typeof readProtectedCraftingStock>>;
  rawStock?: Awaited<ReturnType<typeof readRaidExposedRawStock>>;
  starterFleet?: Awaited<ReturnType<typeof readStarterFleetView>> & { serverNow: string };
  starterExpeditions?: Awaited<ReturnType<typeof readStarterExpeditionView>>;
  // Phase E P3: omitted on unprotected/legacy reads; null means source unavailable.
  servicePresentation?: Awaited<ReturnType<typeof readStarterServicePresentation>>;
  // Current service animation evidence only; legacy/frozen reads omit.
  serviceActivity?: Awaited<ReturnType<typeof readServiceActivity>>;
  advancedServicePresentation?: Awaited<ReturnType<typeof readAdvancedServicePresentation>>;
  // Current-only installed reservation identities from the SAME locked read as the appearance; legacy/frozen reads omit,
  // an unavailable appearance omits (never a mint/berth/event-derived substitute).
  advancedFleetIdentity?: AdvancedFleetIdentity;
  harvesters?: Awaited<ReturnType<typeof readHarvesterView>>;
  ordinaryCrafting?: { pendingJobs: Awaited<ReturnType<typeof readPendingOrdinaryCrafting>>; serverNow: string };
  // C5: present only when THIS protected read settled a return; never on legacy/frozen reads, never replayed.
  fleetJourneyEvents?: FleetJourneyEventBatch;
}> {
  if (collectOrdinary && 'rollback' in db) throw new Error('Owner collection requires a top-level base read');
  if (baseId && authorizeBase) {
    const read = () => db.transaction(async (tx) => {
      await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      // Explicit player → base → slot, matching custody transfer. A joined
      // FOR UPDATE leaves base/slot acquisition order to the query planner.
      const [base] = await tx.select().from(bases).where(and(
        eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      )).for('update');
      if (!base) throw new HttpError(404, 'base not owned', 'BASE_NOT_OWNED');
      const [slot] = await tx.select({ baseId: baseSlots.baseId }).from(baseSlots).where(and(
        eq(baseSlots.baseId, base.id), eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
      )).for('update');
      if (!slot) throw new HttpError(404, 'base not owned', 'BASE_NOT_OWNED');
      await authorizeBase(tx, wallet, base.id);
      const cutoff = new Date(clock().getTime());
      if (!Number.isFinite(cutoff.getTime())) throw new Error('Invalid stable base event clock');
      // Restricted completion would run a deferred owner-only proof at COMMIT.
      // Refuse before any settlement writes; never catch arbitrary SQL errors.
      const [collection] = await tx.execute<{required:boolean}>(sql`select
        current_user::regrole::oid<>(select relowner from pg_class where oid='public.ordinary_crafting_jobs'::regclass)
        and exists(select 1 from public.ordinary_crafting_jobs where base_id=${base.id}::uuid and completed_at is null
          and ready_at<=${cutoff.toISOString()}::timestamptz) required`);
      if (collection?.required === true) throw new OrdinaryCollectionRequired();
      // Read authority does not prohibit materializing accepted returns during
      // an incoming raid. Existing snapshots/reservations remain immutable.
      await completeDueJobs(tx, wallet, cutoff, base.id);
      const starterReturns = await settleDueStarterExpeditions(tx, base.id, cutoff);
      // C5 (K252): the return proofs this read just inserted, redacted by root's helper
      // inside the same locked owner transaction. Settlement itself is unchanged.
      const fleetJourneyEvents = await readNewStarterReturnJourneyEvents(tx, wallet, base.id, starterReturns);
      await settleDueOrdinaryCrafting(tx, base.id, cutoff);
      const harvesterSources = await settleDueHarvesterSources(tx, base.id, cutoff);
      const state = await getBaseStateLocked(tx, wallet, cutoff, base.id);
      const fleet = await readStarterFleetView(tx, base.id);
      const pendingCrafting = await readPendingOrdinaryCrafting(tx, base.id);
      const newerCrafting = pendingCrafting.some(job => job.recipe.recipeVersion !== 1);
      if (craftingCatalogueVersion === 1 && newerCrafting)
        throw new HttpError(409, 'A newer crafting job is pending. Update your client to review it.', 'ORDINARY_CRAFTING_CLIENT_UPDATE_REQUIRED');
      return { ...state, ...(craftingCatalogueVersion === 2 ? { craftingShardsAvailable: (await getBaseShardBalance(tx, base.id)).toString() } : {}),
        craftingStock: await readProtectedCraftingStock(tx, base.id, craftingCatalogueVersion ?? 1),
        rawStock: await readRaidExposedRawStock(tx, base.id),
        starterFleet: { ...fleet, serverNow: cutoff.toISOString() },
        starterExpeditions: await readStarterExpeditionView(tx, base, cutoff, fleet),
        // Phase E P3: all canonical reads above remain mandatory.
        servicePresentation: await readStarterServicePresentation(tx, base.id, state.buildings, fleet, cutoff),
        // Current service projection shares the locked post-settlement cutoff.
        serviceActivity: await withHarvesterActivity(tx, wallet, base.id, state.buildings, cutoff,
          await readServiceActivity(tx,wallet,base.id,state.buildings,cutoff), harvesterSources),
        // ONE combined locked read: the unchanged appearance plus its installed reservation identities (no second independent read).
        ...await readCurrentAdvancedIdentity(tx, wallet, base.id, state.buildings, cutoff).then(advanced => ({
          advancedServicePresentation: advanced.presentation,
          ...(advanced.identity ? { advancedFleetIdentity: advanced.identity } : {}) })),
        harvesters: await readHarvesterView(tx, base, cutoff),
        ...(fleetJourneyEvents.length > 0 ? { fleetJourneyEvents: { version: 1 as const, events: fleetJourneyEvents } } : {}),
        ...(!newerCrafting || craftingCatalogueVersion === 2 ? { ordinaryCrafting: { pendingJobs: pendingCrafting, serverNow: cutoff.toISOString() } } : {}) };
    });
    try { return await read(); }
    catch (error) {
      if (!(error instanceof OrdinaryCollectionRequired) || !collectOrdinary || 'rollback' in db) throw error;
      await collectOrdinary(); // No request transaction or its locks survive here.
      return read(); // One retry only; a second crossing remains an explicit hold.
    }
  }
  // No return writer on an unprotected root/legacy read. Existing builder
  // behavior and caller-supplied now are preserved.
  await completeDueJobs(db, wallet, now, baseId);
  return getBaseStateLocked(db, wallet, now, baseId);
}

async function getBaseStateLocked(db: DbOrTx, wallet: string, now: Date, baseId?: string) {
  const [player] = await db.select().from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found');
  const [stableBase] = baseId
    ? await db.select().from(bases).where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet)))
    : [undefined];
  if (baseId && !stableBase) throw new HttpError(404, 'base not owned', 'BASE_NOT_OWNED');
  const stableProfile = stableBase ? await ensureBaseProfile(db, stableBase.id) : null;
  const buildingScope = baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet);
  const obstacleScope = baseId ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, wallet);
  const visualContext = await resolveBaseVisual(db, stableBase?.id);
  // E-11 expansion obstacles: on revision-5 ground, seat the kit props this base's
  // expansions have reached as clearable rows BEFORE the rows are read, so the same
  // GET /base that shows the new land shows its trees as obstacles (kitObstacles.ts).
  await syncKitObstacles(db, wallet, stableBase?.expansions ?? player.expansions, visualContext, baseId);
  const currentWarzone = warzoneStatus(await getGameConfig(db), now);
  const warzoneActive = currentWarzone.active;
  const [bs, obs, clearedObstacles, jobs, activeShield, heroRecoveryRows] = await Promise.all([
    db.select().from(buildings).where(buildingScope),
    db.select().from(obstacles)
      .where(and(obstacleScope, isNull(obstacles.clearedAt))),
    recentlyClearedObstacles(db, wallet, now, baseId),
    activeJobs(db, wallet, baseId),
    getEffectiveShieldStatus(db, wallet, now, warzoneActive, baseId),
    baseId
      ? db.select({
        hero: baseHeroProgress.hero,
        level: baseHeroProgress.level,
        recoveryUntil: baseHeroProgress.recoveryUntil,
      })
        .from(baseHeroProgress).where(eq(baseHeroProgress.baseId, baseId))
      : db.select({
        hero: heroLevels.hero,
        level: heroLevels.level,
        recoveryUntil: heroLevels.recoveryUntil,
      })
        .from(heroLevels).where(eq(heroLevels.playerWallet, wallet)),
  ]);
  const underConstruction = new Set(jobs.filter((j) => j.kind === 'build' && j.buildingId).map((j) => j.buildingId));
  const shieldUntil = activeShield.expiresAt;

  // Raid energy (ECONOMY.md §4, v3 + owner 2026-07-26): 6 free/day regenerating +
  // SOL-bought energy that stockpiles, with NO daily raid ceiling. `max` is the
  // free allowance the HUD fills; purchased energy stacks on top of it.
  // Delegated to raids.ts getRaidEnergy — the ONE formula —
  // which also expires abandoned raids first. The old inline copy here counted
  // 'expired' rows (getRaidEnergy's pvpRaidsToday excludes them, #58), so an
  // abandoned/RETREATed raid showed as spent energy in the HUD all day even
  // though createRaid would happily accept the attack (verification 2026-07-26,
  // critic major: the "/base poll heals it" comment was dead code until this call).
  const energy = await getRaidEnergy(db as Db, wallet, now, stableBase?.id);
  // The trained army roster for the camp garrison (#56), WITH each troop's
  // researched level so the base view can render levelled art — the client may
  // never invent a game number. Sourced via getArmyState, the SAME derivation
  // that freezes armySnapshot.{counts,levels} at raid creation (raids.ts), so
  // the garrison and a raid snapshot can never disagree; it also completes due
  // training/research first, so a just-finished research shows here without
  // opening the army screen (unresearched troops default to level 1 in army.ts).
  const armyState = await getArmyState(db as Db, wallet, now, baseId);
  const armyRows = TROOP_TYPES.filter((t) => armyState.counts[t] > 0)
    .map((t) => ({ troop: t, count: armyState.counts[t], level: armyState.levels[t] }));
  const readyTroopCount = TROOP_TYPES.reduce(
    (total, troop) => total + armyState.counts[troop],
    0,
  );
  const queueDeadlines = armyState.queue
    .map((row) => row.finishesAt.getTime())
    .filter(Number.isFinite);
  const defences = await recentDefences(db, stableBase?.id ?? null);
  const claim = claimRect(stableBase?.expansions ?? player.expansions);
  const plotVersion = plotVersionForClaim(claim);
  return {
    ...(plotVersion === 2 ? { plotVersion } : {}),
    baseId: stableBase?.id ?? null,
    constructionCapacity: { version: 1 as const, berth: {
      max: effectiveBuildCountCapForKeep('berth', stableBase?.keepLevel ?? player.keepLevel, phaseEVehiclesEnabled())!,
    } },
    visualContext,
    ...(stableBase ? { boundCosmetics: await readBoundCosmeticBase(db, stableBase.id, player.wallet) } : {}),
    player: {
      wallet: player.wallet,
      name: player.name,
      keepLevel: stableBase?.keepLevel ?? player.keepLevel,
      trophies: stableProfile?.trophies ?? player.trophies,
      league: stableProfile?.league ?? player.league,
      builders: stableBase?.builders ?? player.builders,
      expansions: stableBase?.expansions ?? player.expansions,
    },
    energy: {
      used: energy.used,
      free: Math.max(0, energy.free),
      max: energy.max,
    },
    // Active shield (GDD §3.3): hours remaining, or null when unshielded.
    shield: shieldUntil
      ? {
        active: activeShield.active,
        activeUntil: shieldUntil,
        expiresAt: shieldUntil,
        hoursLeft: Math.ceil(activeShield.remainingMs / 3_600_000),
        remainingMs: activeShield.remainingMs,
        source: activeShield.source,
        suppressedByWarzone: activeShield.suppressedByWarzone,
      }
      : null,
    // Public scheduled boundary used by the home client to refresh the shield
    // presentation exactly when ordinary protection becomes suppressed or
    // effective again. A dormant purge exposes no future boundary.
    warzone: {
      active: currentWarzone.active,
      boundaryAt: (currentWarzone.active
        ? currentWarzone.endsAt
        : currentWarzone.mode === 'scheduled'
          ? currentWarzone.startsAt ?? currentWarzone.nextStartsAt
          : null)?.toISOString() ?? null,
      remainingMs: currentWarzone.remainingMs,
    },
    claim,
    buildings: bs.map((b) => ({ ...b, underConstruction: underConstruction.has(b.id) })),
    /** Trained army for the camp garrison (#56): troop, count and the
     * researched troop level (server-owned game number — default 1). */
    army: armyRows,
    /**
     * Base-wide readiness shown over every completed Barracks and Army Camp.
     * Queue rows are not assigned to physical buildings, so this aggregate is
     * deliberately explicit rather than inventing per-building ownership.
     * All figures come from the same army state frozen into raids.
     */
    armyStatus: {
      readyTroopCount,
      readyPts: armyState.rosterPts,
      campCapacityPts: armyState.campCapacityPts,
      trainingTroopCount: armyState.queue.length,
      trainingPts: armyState.queuedPts,
      barracksQueuePts: armyState.barracksQueuePts,
      nextReadyAt: queueDeadlines.length > 0
        ? new Date(Math.min(...queueDeadlines)).toISOString()
        : null,
      allReadyAt: queueDeadlines.length > 0
        ? new Date(Math.max(...queueDeadlines)).toISOString()
        : null,
    },
    /** Recruited heroes and their authoritative recovery state. This mirrors
     * the completed-altar + stored-deadline contract used by raid snapshots;
     * tests pin both reads so the home view cannot depict a downed defender as
     * ready merely because their altar still exists. */
    heroes: HERO_KEYS.flatMap((hero) => {
      const recruited = bs.some((building) => (
        building.type === HEROES[hero].altar && !underConstruction.has(building.id)
      ));
      if (!recruited) return [];
      const progress = heroRecoveryRows.find((row) => row.hero === hero);
      const recoveryUntil = progress?.recoveryUntil ?? null;
      return [{
        hero,
        // A recruited hero with no progress row is authoritatively level 1;
        // both progress tables use that same default and require no migration.
        level: progress?.level ?? 1,
        recoveryUntil: recoveryUntil?.toISOString() ?? null,
        available: recoveryUntil === null || recoveryUntil <= now,
      }];
    }),
    obstacles: obs,
    features: { builderJobSpeedup: BUILDER_JOB_SPEEDUP_FEATURE, minePurchase: MINE_PURCHASE_FEATURE,
      // IW5 discovery only; clients still require their admitted art and each
      // normal placement/action gate remains authoritative. Production stays dark.
      phaseEBuildings: { version: 1 as const, enabledTypes: phaseEBuildingsEnabled() ? [...PHASE_E_BUILDINGS.types] : [] },
      phaseEArt: { version: 1 as const, enabled: phaseEArtEnabled() && phaseEBuildingsEnabled() },
    },
    additionalMineQuote: additionalMineQuote(bs.filter(b => b.type === 'mine').length, maxMinesForKeep(stableBase?.keepLevel ?? player.keepLevel)),
    /** Remnants of obstacles cleared within OBSTACLE_REMNANT_DAYS (E-11); see
     * ClearedObstacleDto. Older clients ignore the field. */
    clearedObstacles,
    jobs: jobs.map((j) => ({
      id: j.id, kind: j.kind, buildingId: j.buildingId, obstacleId: j.obstacleId,
      startedAt: j.startedAt, finishesAt: j.finishesAt,
      finishCostKeep: builderJobFinishCostKeep(j, now).toString(),
      paidFinishQuote: builderJobPaidQuote(j, builderJobFinishCostKeep(j, now)),
      // Server verdict on the CANCEL control: only a running shard-paid upgrade
      // with a recorded receipt; SOL-priced steps and pre-receipt jobs hide it.
      canCancel: j.kind === 'upgrade' && j.paidShardCost !== null && j.debitLedgerTxnId !== null,
      refundShards: j.kind === 'upgrade' && j.paidShardCost !== null ? j.paidShardCost.toString() : null,
    })),
    freeBuilders: (stableBase?.builders ?? player.builders) - jobs.length,
    /** Newest defences of this deed (D-099): `lastAt` is what the client's
     * device-local seen stamp is compared against; `recent` is capped by
     * BATTLE_HISTORY.hudRecentDefences and names the attacker for REVENGE. */
    defences,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Per-type level ceiling. EXPORTED so a test can pin that it covers every type
 *  with an UPGRADE_COSTS table — the `?? 1` lookup below fails OPEN, so a missing
 *  key silently caps that building at L1 instead of erroring (the Gold Forge bug,
 *  owner report 2026-07-26). */
export const MAX_LEVEL: Record<string, number> = {
  keep: STRUCTURES.keep.maxLevel,
  mine: STRUCTURES.mine.maxLevel,
  vault: STRUCTURES.vault.maxLevel,
  barracks: STRUCTURES.barracks.maxLevel,
  forge: STRUCTURES.forge.maxLevel,
  // The Gold Forge was MISSING here, so `MAX_LEVEL[type] ?? 1` resolved to 1 and
  // every upgrade of a level-1 forge threw 'already at max level' — leaving its
  // full 19-step UPGRADE_COSTS table unreachable (owner report 2026-07-26).
  goldforge: STRUCTURES.goldforge.maxLevel,
  camp: STRUCTURES.camp.maxLevel,
  wall: STRUCTURES.wall.maxTier,
  cannon: DEFENSE_LEVELING.maxLevel,
  archertower: DEFENSE_LEVELING.maxLevel,
  mortar: DEFENSE_LEVELING.maxLevel,
  airdefence: DEFENSE_LEVELING.maxLevel,
  // Pixel Kingdom Wars epic defenses (level to 20 like every other defense).
  electrictower: DEFENSE_LEVELING.maxLevel,
  magetower: DEFENSE_LEVELING.maxLevel,
  lasertower: DEFENSE_LEVELING.maxLevel,
  dragonnest: DEFENSE_LEVELING.maxLevel,
  spiketrap: DEFENSE_LEVELING.maxLevel,
  powdermine: DEFENSE_LEVELING.maxLevel,
  pitfall: DEFENSE_LEVELING.maxLevel,
  airmine: DEFENSE_LEVELING.maxLevel,
  clanhall: STRUCTURES.clanhall.maxLevel,
  // Phase E commit A (D-152 §5, dark): the five service buildings carry their
  // STRUCTURES ceiling from day one so the fail-open `?? 1` lookup can never
  // pin them at L1 when PHASE_E_BUILDINGS_ENABLED flips (the Gold Forge bug).
  workshop: STRUCTURES.workshop.maxLevel,
  lodge: STRUCTURES.lodge.maxLevel,
  market: STRUCTURES.market.maxLevel,
  harvester: STRUCTURES.harvester.maxLevel,
  berth: STRUCTURES.berth.maxLevel,
};

function isTrapType(type: string): type is keyof typeof TRAP_REPAIR {
  return (TRAP_TYPES as readonly string[]).includes(type);
}

async function geometryCheck(
  db: DbOrTx, wallet: string, rect: Rect, expansions: number,
  ignoreBuildingId?: string, baseId?: string,
) {
  if (!insideClaim(rect, expansions)) throw new HttpError(422, 'outside the buildable claim');
  const [bs, obs] = await Promise.all([
    db.select().from(buildings).where(baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet)),
    db.select().from(obstacles)
      .where(and(baseId ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, wallet), isNull(obstacles.clearedAt))),
  ]);
  for (const b of bs) {
    if (b.id === ignoreBuildingId) continue;
    const fp = footprintOf(b.type as BuildingType);
    if (overlaps(rect, { tx: b.tx, ty: b.ty, ...fp })) throw new HttpError(422, 'overlaps another building');
  }
  for (const o of obs) {
    if (overlaps(rect, obstacleRect(o.spriteKey, o.tx, o.ty))) throw new HttpError(422, 'blocked by an obstacle');
  }
}

interface MutationBaseContext {
  player: typeof players.$inferSelect;
  baseId?: string;
  keepLevel: number;
  builders: number;
  expansions: number;
  landPaidAt: Date | null;
}

export interface StableBaseMutationContext {
  baseId: string;
  assertAuthority: (tx: DbOrTx, wallet: string, baseId: string) => Promise<void>;
}

/** Every base mutation takes locks in one order: wallet player first, then its
 * active stable base. Flag-off remains the exact wallet-keyed legacy contract. */
async function lockMutationBase(
  tx: DbOrTx, wallet: string, requestedBaseId?: string, frozenPaidBase = false,
  stableContext?: StableBaseMutationContext,
): Promise<MutationBaseContext> {
  const [player] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
  if (!player) throw new HttpError(404, 'player not found');
  if (frozenPaidBase && requestedBaseId) {
    const [stable] = await tx.select().from(bases).where(eq(bases.id, requestedBaseId)).for('update');
    if (!stable) throw new HttpError(404, 'frozen paid base not found', 'BASE_NOT_OWNED');
    return {
      player, baseId: stable.id, keepLevel: stable.keepLevel,
      builders: stable.builders, expansions: stable.expansions,
      landPaidAt: stable.landPaidAt,
    };
  }
  // A server-frozen stable target is authoritative in both flag states. The
  // feature flag controls legacy request shape, not whether a supplied base id
  // may silently fall back to wallet-level compatibility scalars.
  if (requestedBaseId) {
    if (stableContext && stableContext.baseId !== requestedBaseId) {
      throw new HttpError(409, 'base authority context does not match target', 'BASE_NOT_OWNED');
    }
    // Public stable-base mutations carry a route-frozen authority context. Lock
    // in transfer-compatible player -> base -> slot order, then re-check the
    // finalized deed evidence inside this exact transaction. The earlier RPC
    // refresh is only evidence acquisition; it is not authority to write after
    // an arbitrary row-lock wait.
    const [base] = await tx.select().from(bases).where(and(
      eq(bases.id, requestedBaseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    )).for('update');
    if (!base) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
    const [slot] = await tx.select({ baseId: baseSlots.baseId }).from(baseSlots).where(and(
      eq(baseSlots.baseId, base.id), eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
    )).for('update');
    if (!slot) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
    const [raidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
      .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, base.id)).for('update');
    if (raidLock) {
      throw new HttpError(
        423,
        'You are being raided, please wait to continue playing or watch it live',
        'BASE_BEING_RAIDED',
      );
    }
    if (stableContext) await stableContext.assertAuthority(tx, wallet, base.id);
    return {
      player, baseId: base.id, keepLevel: base.keepLevel,
      builders: base.builders, expansions: base.expansions,
      landPaidAt: base.landPaidAt,
    };
  }
  if (!multiBaseEnabled()) {
    return {
      player, keepLevel: player.keepLevel, builders: player.builders,
      expansions: player.expansions, landPaidAt: player.entryPaidAt,
    };
  }
  const rows = await tx.select({ base: bases }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), eq(bases.status, 'active'),
    )).for('update');
  if (rows.length !== 1) {
    throw new HttpError(409, 'baseId is required when multiple active bases exist', 'BASE_ID_REQUIRED');
  }
  const stable = rows[0]!.base;
  const [raidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
    .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, stable.id)).for('update');
  if (raidLock) {
    throw new HttpError(
      423,
      'You are being raided, please wait to continue playing or watch it live',
      'BASE_BEING_RAIDED',
    );
  }
  return {
    player, baseId: stable.id, keepLevel: stable.keepLevel,
    builders: stable.builders, expansions: stable.expansions,
    landPaidAt: stable.landPaidAt,
  };
}

const buildingScope = (wallet: string, baseId?: string) =>
  baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet);
const obstacleScope = (wallet: string, baseId?: string) =>
  baseId ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, wallet);
const jobScope = (wallet: string, baseId?: string) =>
  baseId ? eq(builderJobs.baseId, baseId) : eq(builderJobs.playerWallet, wallet);

/** Max mines a player may own at their Keep level (MINING.MAX_MINES_BY_KEEP:
 *  L1→2 … L5→6, owner 2026-07-19). */
export function maxMinesForKeep(keepLevel: number): number {
  return MINING.MAX_MINES_BY_KEEP[Math.min(keepLevel, MINING.MAX_MINES_BY_KEEP.length) - 1]
    ?? MINING.MAX_MINES_BY_KEEP[MINING.MAX_MINES_BY_KEEP.length - 1]!;
}

/** Keep ledger account identifiers private; the locked mutation branch knows
 * the actual price and currency. An unrelated rollback is not a funds error. */
function basePaymentError(error: unknown, currency: 'KEEP' | 'SHARDS' | 'GEMS', cost: bigint, action = 'build'): never {
  const seen = new Set<unknown>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    if (cause instanceof InsufficientFundsError) throw new HttpError(422,
      `Not enough ${currency}. This ${action} costs ${cost.toLocaleString('en-US')} ${currency}.`,
      `INSUFFICIENT_${currency}`);
    seen.add(cause);
    cause = cause.cause;
  }
  throw error;
}

export async function placeBuilding(
  db: Db, wallet: string, type: BuildingType, tx: number, ty: number,
  idempotencyKey: string, now = new Date(), requestedBaseId?: string,
  stableContext?: StableBaseMutationContext,
  heroContractOnly = false,
) {
  return (await placeBuildingWithEvidence(db, wallet, type, tx, ty, idempotencyKey, now,
    requestedBaseId, stableContext, heroContractOnly)).building;
}

/** Modern paid placement returns immutable acceptance, never today's building.
 * The canonical placer retains all legacy callers and its original return type. */
export async function executeMinePurchase(db: Db, wallet: string, raw: MinePurchaseIntent, now = new Date(), stableContext?: StableBaseMutationContext) {
  const request = MinePurchaseIntentSchema.parse(raw);
  const replay = await replayMinePurchase(db, wallet, request); if (replay) return replay;
  return db.transaction(async tx => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    const prior = await replayMinePurchase(tx, wallet, request); if (prior) return prior;
    assertMinePurchaseScope(request, multiBaseEnabled());
    if (clientCurrencyContext().expectedCurrency !== request.expectedCurrency)
      throw new HttpError(400, 'Mine purchase needs its exact currency context', 'INVALID_CURRENCY_CONSENT');
    await placeBuildingWithEvidence(tx, wallet, BuildingType.Mine, request.tx, request.ty, request.idempotencyKey,
      now, request.baseId ?? undefined, stableContext, false, undefined, request);
    const receipt = await replayMinePurchase(tx, wallet, request);
    if (!receipt) throw new Error('Mine placement omitted original acceptance');
    return receipt;
  });
}

/** The v1 command owns the outer transaction and persists this exact evidence
 * with the canonical placement. Acceptance is not job completion or readiness. */
export async function placeHeroRecruitment(
  db: DbTx, wallet: string, request: HeroRecruitmentRequest, now: Date,
  stableContext?: StableBaseMutationContext,
) {
  const result = await placeBuildingWithEvidence(db, wallet, request.type as BuildingType, request.tx, request.ty,
    request.idempotencyKey, now, request.baseId ?? undefined, stableContext, request.heroContractOnly, BigInt(request.maxCostKeep));
  const hero = HERO_KEYS.find(key => HEROES[key].altar === request.type);
  if (!result.job || !result.heroFunding || !hero) throw new Error('canonical hero construction omitted acceptance evidence');
  const { building, job } = result;
  return HeroRecruitmentReceiptSchema.parse({ version: 1, actor: wallet, idempotencyKey: request.idempotencyKey, request, hero,
    building: { id: building.id, baseId: building.baseId, type: building.type, level: building.level, tx: building.tx, ty: building.ty },
    job: { id: job.id, buildingId: job.buildingId, startedAt: job.startedAt.toISOString(), finishesAt: job.finishesAt.toISOString() },
    funding: result.heroFunding, createdAt: now.toISOString(),
  });
}

/** Pausing Phase E stops new construction, never completion of accepted work. */
function assertPhaseEBuildingStartEnabled(type: string): void {
  if ((PHASE_E_BUILDINGS.types as readonly string[]).includes(type) && !phaseEBuildingsEnabled()) {
    throw new HttpError(503, 'Phase E buildings are not enabled', 'PHASE_E_DISABLED');
  }
}

async function placeBuildingWithEvidence(
  db: DbOrTx, wallet: string, type: BuildingType, tx: number, ty: number,
  idempotencyKey: string, now: Date, requestedBaseId?: string,
  stableContext?: StableBaseMutationContext, heroContractOnly = false, maxHeroCostKeep?: bigint, minePurchase?: MinePurchaseIntent,
) {
  if (type === BuildingType.Keep) throw new HttpError(422, 'the Keep comes with the base');
  const costs = BUILD_COSTS[type as keyof typeof BUILD_COSTS];
  if (!costs) throw new HttpError(422, `not a buildable type: ${type}`);
  assertPhaseEBuildingStartEnabled(type);
  // Pixel Kingdom Wars epic defenses ship DARK — statted + engine-ready, but
  // placement is gated OFF until the combat mechanics + balance land (owner 2026-07-20).
  if (!NEW_ROSTER_ENABLED && (NEW_DEFENSE_TYPES as readonly string[]).includes(type)) {
    throw new HttpError(422, 'this defense is coming soon');
  }
  // The Dragon Nest stays dark behind its OWN flag even after NEW_ROSTER_ENABLED
  // flips: its spawner sim model + balance are a separate follow-up (Phase 2b-2).
  if (!DRAGON_NEST_ENABLED && type === BuildingType.DragonNest) {
    throw new HttpError(422, 'this defense is coming soon');
  }

  // Serialize the WHOLE placement per-wallet under a player-row FOR UPDATE lock.
  // The cap/gate/builder checks below read counts that the insert then changes, so
  // without this two concurrent placements interleave and BOTH pass — e.g. two mine
  // builds both read count=0, both take the KEEP-only 1st-mine price, minting a free
  // 2nd mine with no SOL and past the cap (security review 2026-07-19 FINDING).
  // The paid additional-mine path (applyMineBuild) locks the same row, so a KEEP
  // 1st-mine and a SOL 2nd-mine credit also serialize against each other. The spend
  // + inserts then commit atomically with the lock.
  return db.transaction(async (trx) => {
    const ctx = await lockMutationBase(trx, wallet, requestedBaseId, false, stableContext);
    // The flag can pause while this request waits for the canonical locks.
    assertPhaseEBuildingStartEnabled(type);
    await completeDueJobs(trx, wallet, now, ctx.baseId);

    // R2: the Gold Forge needs LAND, not just a Keep level. Inside the lock and
    // before any spend, exactly like the Keep-level gate beside it.
    assertLandForBuilding(type, { entryPaidAt: ctx.landPaidAt });

    const gate = (costs as { requiresKeepLevel?: number }).requiresKeepLevel;
    if (gate && ctx.keepLevel < gate) throw new HttpError(422, `requires Keep level ${gate}`);

    const owned = await trx.select({ type: buildings.type }).from(buildings)
      .where(buildingScope(wallet, ctx.baseId));
    if (isTrapType(type)) {
      const count = owned.filter((b) => isTrapType(b.type)).length;
      const cap = CAPS.trapsByKeepLevel[ctx.keepLevel - 1] ?? 0;
      if (count >= cap) throw new HttpError(422, 'trap cap reached');
    }
    // Per-building count cap by KEEP LEVEL (owner 2026-07-20 — counts grow with the
    // Keep, walls to 250). Covers cannon/archer/mortar/epics/barracks/camp/vault/
    // forge/wall; mines + the aggregate trap family use their own Keep arrays above.
    const countCap = effectiveBuildCountCapForKeep(type, ctx.keepLevel, phaseEVehiclesEnabled());
    if (countCap !== undefined) {
      const count = owned.filter((b) => b.type === type).length;
      if (count >= countCap) throw new HttpError(422, `${type} cap reached — max ${countCap} at Keep level ${ctx.keepLevel}`);
    }

    // Mines: additive-income assets with a Keep-gated count cap and PROGRESSIVE
    // pricing. D-057 (owner 2026-08-16 "we should not gate miners with sol at
    // start"): NO mine build costs SOL any more. The 1st mine keeps its
    // onboarding price (progressive index 0, charged as SHARDS exactly as
    // before); every ADDITIONAL mine charges the progressive MINE_BUILD_KEEP
    // in KEEP (recycled to emission_pool) — the same non-SOL charge the
    // retired 'mine_build' deposit flow applied on credit — right here instead
    // of through a payment intent.
    let costShards = BigInt(costs.costShards);
    let progressiveMineKeep: bigint | null = null;
    let mineIndex = 0;
    if (type === BuildingType.Mine) {
      mineIndex = owned.filter((b) => b.type === 'mine').length;
      if (minePurchase && mineIndex !== minePurchase.mineConsent.mineIndex)
        throw new HttpError(409, 'Mine count changed; review its current price', 'MINE_PURCHASE_INDEX_CHANGED');
      const max = maxMinesForKeep(ctx.keepLevel);
      if (mineIndex >= max) throw new HttpError(422, `mine cap reached — ${max} mines at Keep level ${ctx.keepLevel}`);
      const progressive = MINING.MINE_BUILD_KEEP[mineIndex];
      if (progressive === undefined) throw new HttpError(422, 'no price defined for this mine index');
      if (mineIndex === 0) costShards = BigInt(progressive);
      else progressiveMineKeep = BigInt(progressive);
      if (minePurchase && (progressiveMineKeep === null || progressiveMineKeep > BigInt(minePurchase.mineConsent.maxCostKeep)))
        throw new HttpError(409, 'Mine price increased; review again', 'MINE_PURCHASE_PRICE_CHANGED');
    }

    // Walls are fully instant (owner 2026-07-20): placement and upgrades use no
    // builder job. Upgrade cost remains the progression gate (upgradeBuilding).
    const isWall = type === BuildingType.Wall;
    const jobs = await activeJobs(trx, wallet, ctx.baseId);
    if (!isWall && jobs.length >= ctx.builders) throw new HttpError(422, 'all builders are busy');

    const rect: Rect = { tx, ty, ...footprintOf(type) };
    await geometryCheck(trx, wallet, rect, ctx.expansions, undefined, ctx.baseId);

    // HERO RECRUIT (D-058, owner 2026-08-16: "Vex hero cost is 3000 KEEP,
    // Theodor 10,000 KEEP … heroes are also items"). Placing an altar is THE
    // one recruitment act; its fee has two funding legs inside this same
    // transaction: consume 1 hero-contract item from the placing inventory if
    // one is owned (an item bought with KEEP or on the SOL market), otherwise
    // charge HEROES[hero].recruitCostKeep through the sink shim (Gems, or the
    // legacy KEEP leg recycling to emission_pool). The item leg is tried first — the
    // contract was already paid for, so holding it while paying again would
    // only ever hurt the player. Duplicate submits are safe either way: the
    // second attempt serializes behind the player lock and dies on the
    // 1-per-base altar cap above before it can consume or charge anything.
    const altarHero = HERO_KEYS.find(hero => HEROES[hero].altar === type);
    let heroFunding: HeroRecruitmentFunding | null = null;
    if (altarHero) {
      const contractId = HEROES[altarHero].recruitItemId;
      // Stable mode tries the deed book first (D-035 custody), then falls back
      // to the wallet book: a contract bought before the cutover — or settled
      // by the legacy market lane into player_items — must still count as the
      // prepaid fee, not silently double-charge KEEP (security review
      // 2026-08-16 finding 5). Legacy mode only ever has the wallet book.
      let consumed = ctx.baseId
        ? await trx.update(baseItems)
          .set({ qty: sql`${baseItems.qty} - 1` })
          .where(and(
            eq(baseItems.baseId, ctx.baseId), eq(baseItems.itemId, contractId), gt(baseItems.qty, 0),
          ))
          .returning({ qty: baseItems.qty })
        : [];
      const contractSourceBaseId = consumed.length > 0 ? ctx.baseId ?? null : null;
      if (consumed.length === 0) {
        consumed = await trx.update(playerItems)
          .set({ qty: sql`${playerItems.qty} - 1` })
          .where(and(
            eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, contractId), gt(playerItems.qty, 0),
          ))
          .returning({ qty: playerItems.qty });
      }
      if (consumed.length > 0) {
        // Audit record for the item leg (security review 2026-08-16 finding
        // 4): the consume posts no ledger row, so without this the only trace
        // of a burned 10,000-KEEP-class contract would be a qty decrement.
        // The unique key also hard-stops any replay that somehow slipped past
        // the 1-per-base altar cap above.
        try {
          const [use] = await trx.insert(itemUses).values({
            playerWallet: wallet,
            itemId: contractId,
            idempotencyKey: ctx.baseId
              ? `build:${wallet}:${ctx.baseId}:${idempotencyKey}`
              : `build:${wallet}:${idempotencyKey}`,
          }).returning({ id: itemUses.id });
          heroFunding = { kind: 'contract', itemId: contractId, itemUseId: use!.id,
            sourceBaseId: contractSourceBaseId, quantity: 1 };
        } catch (e) {
          const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
          const msg = e instanceof Error ? e.message : '';
          if (code === '23505' || msg.includes('item_uses_idempotency_key_unique')) {
            throw new HttpError(409, 'duplicate build request — refresh your base');
          }
          throw e;
        }
      } else {
        if (heroContractOnly) throw new HttpError(409,
          'Hero contract is no longer available. Review the KEEP price before placing.',
          'HERO_CONTRACT_UNAVAILABLE');
        if (maxHeroCostKeep !== undefined && BigInt(HEROES[altarHero].recruitCostKeep) > maxHeroCostKeep) {
          throw new HttpError(409, 'Hero recruitment price changed. Review the current KEEP price.', 'HERO_RECRUIT_PRICE_CHANGED');
        }
        // D-152: the price is charged in ONE currency by the sink shim (Gems for a
        // Gems-aware client, custodial KEEP for a legacy one; never split). The
        // consent ceiling `maxHeroCostKeep` stays valid because Gems are 1:1.
        const posted = await spendGameCurrency(
          trx, wallet, BigInt(HEROES[altarHero].recruitCostKeep), 'hero.recruit',
          `build:${wallet}:${idempotencyKey}`,
          { type, hero: altarHero, tx, ty, ...(ctx.baseId ? { baseId: ctx.baseId } : {}) },
        ).catch(error => basePaymentError(error, 'KEEP', BigInt(HEROES[altarHero].recruitCostKeep)));
        if (posted.duplicate) throw new HttpError(409, 'duplicate build request — refresh your base');
        heroFunding = posted.currency === 'GEMS'
          ? { kind: 'gems', amount: String(HEROES[altarHero].recruitCostKeep), ledgerTransactionId: posted.transaction.id }
          : { kind: 'keep', amount: String(HEROES[altarHero].recruitCostKeep), ledgerTransactionId: posted.transaction.id };
      }
    } else {
      // Namespaced key + duplicate gate (security review 2026-07-24 #5): a reused
      // key charges nothing, so it must never place a free building.
      // Additional mines (D-057) charge their progressive price in KEEP →
      // emission_pool ('build.mine' — the identical posting shape the retired
      // paid path used in applyMineBuild), under the SAME namespaced key rules.
      const posted = await (progressiveMineKeep !== null
        ? spendGameCurrency(trx, wallet, progressiveMineKeep, 'build.mine', `build:${wallet}:${idempotencyKey}`, { type, tx, ty, baseId: ctx.baseId, mineIndex, ...(minePurchase ? { minePurchase: { version: 1, request: minePurchase } } : {}) })
        : ctx.baseId
          ? spendBaseShards(trx, ctx.baseId, costShards, 'build.place', `build:${wallet}:${idempotencyKey}`, { type, tx, ty })
          : spendShards(trx, wallet, costShards, 'build.place', `build:${wallet}:${idempotencyKey}`, { type, tx, ty }))
        .catch(error => basePaymentError(error, progressiveMineKeep !== null ? minePurchase?.expectedCurrency ?? 'KEEP' : 'SHARDS', progressiveMineKeep ?? costShards));
      if (posted.duplicate) throw new HttpError(409, 'duplicate build request — refresh your base');
    }
    await markBuildAction(trx, wallet, now, ctx.baseId);
    if (isWall) {
      await progressQuestBatch(trx, wallet, [
        ['place_5_walls', 1], ['place_10_walls', 1],
      ], now, ctx.baseId);
    }
    const [row] = await trx.insert(buildings)
      .values({ playerWallet: wallet, baseId: ctx.baseId, type, level: 1, tx, ty })
      .returning();
    let job: typeof builderJobs.$inferSelect | undefined;
    if (!isWall) {
      [job] = await trx.insert(builderJobs).values({
        playerWallet: wallet, baseId: ctx.baseId,
        kind: 'build',
        buildingId: row!.id,
        startedAt: now,
        finishesAt: new Date(now.getTime() + costs.buildSec * 1000),
      }).returning();
    }
    return { building: row!, job, heroFunding };
  });
}

/**
 * Place MANY walls in ONE action — swipe/drag to lay a whole run at once (#59,
 * owner 2026-07-20). Walls only (instant, no builder/job). Charges
 * count × BUILD_COSTS.wall in ONE idempotent spend, enforces the Keep-level wall
 * count cap over owned + new, and geometry-checks every tile (vs the DB + against
 * duplicates in the batch). All-or-nothing: if any tile is invalid the whole batch
 * rolls back, so the client's shown cost always matches the charge (the client only
 * paints valid tiles, so this only trips on a rare race). Serialized per-wallet by
 * the player-row FOR UPDATE lock, like placeBuilding.
 */
export async function placeWallsBatch(
  db: Db, wallet: string, tiles: Array<{ tx: number; ty: number }>, idempotencyKey: string,
  now = new Date(), requestedBaseId?: string, stableContext?: StableBaseMutationContext,
) {
  const { buildings, cost } = await placeWallsBatchWithEvidence(db, wallet, tiles, idempotencyKey, now, requestedBaseId, stableContext);
  return { buildings, cost };
}

/** Operation prefix precedes the actor; a legacy free-form build key cannot collide. */
export const wallBatchLedgerKey = (wallet: string, key: string) => `wallbatch.v1:${wallet}:${key}`;

/** Called only by the v1 owner inside its actor-locked outer transaction. */
export async function placeWallBatchCommand(
  db: DbTx, wallet: string, request: WallBatchRequest, now: Date, context?: StableBaseMutationContext,
) {
  return placeWallsBatchWithEvidence(db, wallet, request.tiles, request.idempotencyKey, now,
    request.baseId ?? undefined, context, request);
}

async function placeWallsBatchWithEvidence(
  db: DbOrTx, wallet: string, tiles: Array<{ tx: number; ty: number }>, idempotencyKey: string,
  now: Date, requestedBaseId?: string, stableContext?: StableBaseMutationContext, request?: WallBatchRequest,
) {
  // Dedup identical tiles in the request (distinct 1×1 walls can't otherwise overlap).
  const uniq = Array.from(new Map(tiles.map((t) => [`${t.tx},${t.ty}`, t])).values());
  if (uniq.length === 0) throw new HttpError(422, 'no wall tiles to place');

  return (db as Db).transaction(async (trx) => {
    const ctx = await lockMutationBase(trx, wallet, requestedBaseId, false, stableContext);
    await completeDueJobs(trx, wallet, now, ctx.baseId);

    const owned = await trx.select({ id: buildings.id }).from(buildings)
      .where(and(buildingScope(wallet, ctx.baseId), eq(buildings.type, BuildingType.Wall)));
    const cap = buildCountCapForKeep(BuildingType.Wall, ctx.keepLevel) ?? 0;
    if (owned.length + uniq.length > cap) {
      throw new HttpError(422, `wall cap reached — max ${cap} at Keep level ${ctx.keepLevel}`);
    }

    const fp = footprintOf(BuildingType.Wall);
    for (const t of uniq) {
      await geometryCheck(trx, wallet, { tx: t.tx, ty: t.ty, ...fp }, ctx.expansions, undefined, ctx.baseId);
    }

    const cost = BigInt(BUILD_COSTS.wall.costShards) * BigInt(uniq.length);
    if (request && cost > BigInt(request.maxCostShards)) {
      throw new HttpError(409, 'Wall placement price changed. Review the current SHARDS total.', 'WALL_BATCH_PRICE_CHANGED');
    }
    const ledgerKey = request ? wallBatchLedgerKey(wallet, request.idempotencyKey) : `build:${wallet}:${idempotencyKey}`;
    const metadata = request ? { wallBatchV1: { actor: wallet, request } } : { type: 'wall', count: uniq.length };
    // Namespaced + duplicate-gated (security review 2026-07-24 #5).
    const posted = ctx.baseId
      ? await spendBaseShards(trx, ctx.baseId, cost, 'build.place', ledgerKey, metadata)
      : await spendShards(trx, wallet, cost, 'build.place', ledgerKey, metadata);
    if (posted.duplicate) throw new HttpError(409, 'duplicate build request — refresh your base');
    await markBuildAction(trx, wallet, now, ctx.baseId);
    await progressQuestBatch(trx, wallet, [
      ['place_5_walls', uniq.length], ['place_10_walls', uniq.length],
    ], now, ctx.baseId);
    const rows = await trx.insert(buildings)
      .values(uniq.map((t) => ({ playerWallet: wallet, baseId: ctx.baseId, type: BuildingType.Wall, level: 1, tx: t.tx, ty: t.ty })))
      .returning();
    return { buildings: rows, cost: cost.toString(), receiptId: posted.transaction.id };
  });
}

/** Layout editing is free and instant (GDD §3.9 / HANDOFF §5). */
export async function moveBuilding(
  db: Db, wallet: string, buildingId: string, tx: number, ty: number, requestedBaseId?: string,
  stableContext?: StableBaseMutationContext,
) {
  return db.transaction(async (trx) => {
    const ctx = await lockMutationBase(trx, wallet, requestedBaseId, false, stableContext);
    const [b] = await trx.select().from(buildings)
      .where(and(eq(buildings.id, buildingId), buildingScope(wallet, ctx.baseId))).for('update');
    if (!b) throw new HttpError(404, 'building not found');
    const rect: Rect = { tx, ty, ...footprintOf(b.type as BuildingType) };
    await geometryCheck(trx, wallet, rect, ctx.expansions, buildingId, ctx.baseId);
    await trx.update(buildings).set({ tx, ty })
      .where(and(eq(buildings.id, buildingId), buildingScope(wallet, ctx.baseId)));
    return { ...b, tx, ty };
  });
}

/**
 * Move a whole LINE of walls together (#61) — free + instant, like moveBuilding but
 * for a set. A rigid translation shifts each wall onto its neighbour's vacated tile,
 * so ALL moving walls are excluded from the overlap check (not just one); each new
 * tile is validated vs the claim + the STATIC (non-moving) buildings/obstacles. The
 * moves preserve distinctness (same delta), so they can't collide with each other.
 * All-or-nothing under the player-row lock.
 */
export async function moveWallsBatch(
  db: Db, wallet: string, moves: Array<{ id: string; tx: number; ty: number }>, requestedBaseId?: string,
  stableContext?: StableBaseMutationContext,
) {
  if (moves.length === 0) throw new HttpError(422, 'no walls to move');
  return db.transaction(async (trx) => {
    const ctx = await lockMutationBase(trx, wallet, requestedBaseId, false, stableContext);
    const [allB, obs] = await Promise.all([
      trx.select().from(buildings).where(buildingScope(wallet, ctx.baseId)),
      trx.select().from(obstacles).where(and(obstacleScope(wallet, ctx.baseId), isNull(obstacles.clearedAt))),
    ]);
    const byId = new Map(allB.map((b) => [b.id, b]));
    for (const m of moves) {
      const b = byId.get(m.id);
      if (!b || b.type !== 'wall') throw new HttpError(422, 'can only line-move your own walls');
    }
    const moving = new Set(moves.map((m) => m.id));
    const staticB = allB.filter((b) => !moving.has(b.id));
    const fp = footprintOf(BuildingType.Wall);
    for (const m of moves) {
      const rect: Rect = { tx: m.tx, ty: m.ty, ...fp };
      if (!insideClaim(rect, ctx.expansions)) throw new HttpError(422, 'a wall would leave the buildable claim');
      for (const b of staticB) {
        if (overlaps(rect, { tx: b.tx, ty: b.ty, ...footprintOf(b.type as BuildingType) })) {
          throw new HttpError(422, 'a wall would overlap a building');
        }
      }
      for (const o of obs) {
        if (overlaps(rect, obstacleRect(o.spriteKey, o.tx, o.ty))) {
          throw new HttpError(422, 'a wall would be blocked by an obstacle');
        }
      }
    }
    for (const m of moves) await trx.update(buildings).set({ tx: m.tx, ty: m.ty })
      .where(and(eq(buildings.id, m.id), buildingScope(wallet, ctx.baseId)));
    return { moved: moves.length };
  });
}

async function wallRowQuoteLocked(
  tx: DbOrTx, wallet: string, selectedWallId: string, ctx: MutationBaseContext,
): Promise<WallRowUpgradeQuote> {
  const [authority] = ctx.baseId
    ? await tx.select({ keepLevel: bases.keepLevel }).from(bases).where(eq(bases.id, ctx.baseId))
    : await tx.select({ keepLevel: players.keepLevel }).from(players).where(eq(players.wallet, wallet));
  const keepLevel = authority!.keepLevel;
  const allWalls = await tx.select().from(buildings).where(and(
    buildingScope(wallet, ctx.baseId), eq(buildings.type, BuildingType.Wall),
  )).for('update');
  const row = wallRowThrough(allWalls, selectedWallId);
  if (!row.length) throw new HttpError(404, 'wall not found');
  const jobs = await activeJobs(tx, wallet, ctx.baseId);
  const busy = new Set(jobs.map((job) => job.buildingId));
  const walls: WallRowUpgradeQuote['walls'] = row.map((wall) => {
    const excluded = wall.level >= MAX_LEVEL.wall! ? 'max_level' as const
      : wall.level + 1 > keepLevel ? 'keep_level' as const
        : busy.has(wall.id) ? 'busy' as const : null;
    const cost = excluded ? 0 : UPGRADE_COSTS.wall[wall.level - 1];
    if (cost === undefined) throw new HttpError(422, 'no wall upgrade price defined');
    return { id: wall.id, tx: wall.tx, ty: wall.ty, level: wall.level,
      targetLevel: excluded ? null : wall.level + 1, costShards: cost, excluded };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const totalCostShards = walls.reduce((sum, wall) => sum + wall.costShards, 0);
  const purchase = { wallet, baseId: ctx.baseId ?? null, selectedWallId, keepLevel, walls, totalCostShards };
  const quoteId = createHash('sha256').update(JSON.stringify(purchase)).digest('hex');
  const account = ctx.baseId
    ? await getOrCreateBaseAccount(tx, ctx.baseId, 'base_shards')
    : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
  return { baseId: ctx.baseId ?? null, selectedWallId, keepLevel,
    walls, totalCostShards, quoteId, balanceShards: account.balance.toString(),
    canAfford: account.balance >= BigInt(totalCostShards) };
}

export async function quoteWallRowUpgrade(
  db: Db, wallet: string, selectedWallId: string, requestedBaseId?: string,
  stableContext?: StableBaseMutationContext,
): Promise<WallRowUpgradeQuote> {
  return db.transaction(async (tx) => {
    const ctx = await lockMutationBase(tx, wallet, requestedBaseId, false, stableContext);
    await completeDueJobs(tx, wallet, new Date(), ctx.baseId);
    return wallRowQuoteLocked(tx, wallet, selectedWallId, ctx);
  });
}

/** One quoted purchase, one durable ledger receipt, all wall levels or none. */
export async function upgradeWallRow(
  db: Db, wallet: string, selectedWallId: string, quoteId: string, idempotencyKey: string,
  requestedBaseId?: string, stableContext?: StableBaseMutationContext,
): Promise<WallRowUpgradeResult> {
  return db.transaction(async (tx) => {
    const ctx = await lockMutationBase(tx, wallet, requestedBaseId, false, stableContext);
    const key = `wall-row:${wallet}:${idempotencyKey}`;
    const binding = { baseId: ctx.baseId ?? null, selectedWallId, quoteId };
    const [prior] = await tx.select({ metadata: ledgerTransactions.metadata }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key));
    if (prior) {
      const receipt = prior.metadata as { binding: typeof binding; result: WallRowUpgradeResult };
      if (receipt.binding?.baseId !== binding.baseId
        || receipt.binding.selectedWallId !== binding.selectedWallId || receipt.binding.quoteId !== binding.quoteId) {
        throw new HttpError(409, 'idempotency key belongs to another wall purchase', 'WALL_ROW_KEY_REUSED');
      }
      return { ...receipt.result, duplicate: true };
    }
    const now = new Date();
    await completeDueJobs(tx, wallet, now, ctx.baseId);
    const quote = await wallRowQuoteLocked(tx, wallet, selectedWallId, ctx);
    if (quote.quoteId !== quoteId) {
      throw new HttpError(409, 'Wall row changed. Review the updated purchase.', 'WALL_ROW_QUOTE_CHANGED', { quote });
    }
    const eligible = quote.walls.filter((wall) => wall.targetLevel !== null);
    if (!eligible.length) throw new HttpError(422, 'No wall in this row can upgrade.', 'WALL_ROW_UNAVAILABLE', { quote });
    if (!quote.canAfford) throw new HttpError(409, 'Not enough SHARDS for the whole quoted row.', 'WALL_ROW_FUNDS_CHANGED', { quote });
    const result: WallRowUpgradeResult = {
      upgraded: eligible.map((wall) => ({ id: wall.id, level: wall.targetLevel! })),
      costShards: quote.totalCostShards, duplicate: false,
    };
    const metadata = { wallet, baseId: ctx.baseId, binding, result };
    if (ctx.baseId) await spendBaseShards(tx, ctx.baseId, BigInt(result.costShards), 'build.upgrade', key, metadata);
    else await spendShards(tx, wallet, BigInt(result.costShards), 'build.upgrade', key, metadata);
    for (const wall of eligible) {
      const [updated] = await tx.update(buildings).set({ level: wall.targetLevel! }).where(and(
        eq(buildings.id, wall.id), buildingScope(wallet, ctx.baseId), eq(buildings.level, wall.level),
      )).returning({ id: buildings.id });
      if (!updated) throw new HttpError(409, 'wall changed mid-upgrade — retry');
    }
    await markBuildAction(tx, wallet, now, ctx.baseId);
    const progress: Array<readonly [string, number]> = [
      ['upgrade_any', eligible.length], ['upgrade_2_buildings', eligible.length],
    ];
    const levelThree = eligible.filter((wall) => wall.targetLevel! >= 3).length;
    if (levelThree > 0) progress.push(['upgrade_to_level_3', levelThree]);
    await progressQuestBatch(tx, wallet, progress, now, ctx.baseId);
    return result;
  });
}

export async function upgradeBuilding(
  db: Db, wallet: string, buildingId: string, idempotencyKey: string, now = new Date(),
  // Positional placeholder kept so requestedBaseId callers stay unchanged. The
  // old { solPaid } escape hatch is gone (D-057): whether a step needs SOL is
  // decided ONLY by upgradeSolLamports, and the paid path never enters here —
  // it applies through creditDeposit → applyPaidUpgrade.
  _opts: Record<string, never> = {}, requestedBaseId?: string,
  stableContext?: StableBaseMutationContext,
) {
  const ledgerKey = `upg:${wallet}:${idempotencyKey}`;
  // Preserve the caller's observed version across the lock wait. In particular,
  // two wall double-taps carry two keys but must not silently buy two tiers: the
  // loser sees that the level changed and retries from fresh server state.
  const observed = await db.transaction(async (pre) => {
    const ctx = await lockMutationBase(pre, wallet, requestedBaseId, false, stableContext);
    const [target] = await pre.select({ type: buildings.type }).from(buildings)
      .where(and(eq(buildings.id, buildingId), buildingScope(wallet, ctx.baseId)));
    if (!target) throw new HttpError(404, 'building not found');
    if ((PHASE_E_BUILDINGS.types as readonly string[]).includes(target.type) && !phaseEBuildingsEnabled()) {
      // Check before this preflight can COMMIT lazy completions. Only an actual
      // accepted upgrade on this building may cross the pause for replay.
      const [prior] = await pre.select({ metadata: ledgerTransactions.metadata }).from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, ledgerKey));
      if (!prior) assertPhaseEBuildingStartEnabled(target.type);
      if (prior && (prior.metadata as { buildingId?: unknown }).buildingId !== buildingId)
        throw new HttpError(409, 'idempotency key belongs to another building');
    }
    await completeDueJobs(pre, wallet, now, ctx.baseId);
    const [building] = await pre.select({ level: buildings.level }).from(buildings)
      .where(and(eq(buildings.id, buildingId), buildingScope(wallet, ctx.baseId)));
    if (!building) throw new HttpError(404, 'building not found');
    return { ...building, baseId: ctx.baseId };
  });
  return db.transaction(async (tx) => {
    // Player lock serializes the wallet-wide builder-cap check; building lock
    // serializes level and active-job decisions for this target.
    const ctx = await lockMutationBase(tx, wallet, observed.baseId, false, stableContext);
    await completeDueJobs(tx, wallet, now, ctx.baseId);
    const [b] = await tx.select().from(buildings)
      .where(and(eq(buildings.id, buildingId), buildingScope(wallet, ctx.baseId))).for('update');
    if (!b) throw new HttpError(404, 'building not found');

    const [prior] = await tx.select({ metadata: ledgerTransactions.metadata }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, ledgerKey));
    if (prior) {
      const metadata = prior.metadata as { buildingId?: unknown; to?: unknown };
      if (metadata.buildingId !== buildingId) throw new HttpError(409, 'idempotency key belongs to another building');
      // A later upgrade on the same building must not be misreported as THIS
      // retry's job. The original job is active only while its target is exactly
      // the next level from the locked building row.
      const [job] = metadata.to === b.level + 1
        ? await tx.select().from(builderJobs).where(and(
          jobScope(wallet, ctx.baseId), eq(builderJobs.buildingId, buildingId), isNull(builderJobs.completedAt),
        )).orderBy(desc(builderJobs.startedAt)).limit(1)
        : [];
      return { building: b, job: job ? jobResponse(job) : null, duplicate: true };
    }
    // Recheck after the second lock wait, after original receipt recovery but
    // before any new debit/job. A refusal rolls back this transaction's work.
    assertPhaseEBuildingStartEnabled(b.type);
    if (b.level !== observed.level) throw new HttpError(409, 'building changed mid-upgrade — refresh and retry');

    if (isTrapType(b.type) && b.trapSpentAt) {
      throw new HttpError(422, 'spent traps must be repaired before upgrading');
    }
    // D-057 (owner 2026-08-16): SOL gates only the PRICED target levels — Mine
    // upgrades to L5+ and Gold Forge upgrades to L2+. Mine L2–L4 (and every
    // other building) is a plain shard upgrade through this route.
    if (upgradeSolLamports(b.type, b.level + 1) > 0) {
      throw new HttpError(422, `${b.type} upgrades to level ${b.level + 1} require SOL — use POST /deposits { kind: "mine", buildingId }`);
    }
    const max = MAX_LEVEL[b.type] ?? 1;
    if (b.level >= max) throw new HttpError(422, 'already at max level');
    const cost = UPGRADE_COSTS[b.type as keyof typeof UPGRADE_COSTS]?.[b.level - 1];
    if (cost === undefined) throw new HttpError(422, `no upgrade cost defined for ${b.type}`);
    assertLandForBuilding(b.type, { entryPaidAt: ctx.landPaidAt });
    if (b.type !== 'keep' && b.level + 1 > ctx.keepLevel) throw new HttpError(422, 'upgrade gated by Keep level');

    const jobs = await activeJobs(tx, wallet, ctx.baseId);
    if (jobs.some((j) => j.buildingId === buildingId)) throw new HttpError(422, 'a job is already running on this building');
    // A timed upgrade is CANCELLABLE (tester request 2026-09-04), so its debit
    // is snapshotted onto the job as a refund receipt (jobId + costShards in the
    // ledger metadata, mirrored on the row), and its quests — the upgrade
    // quests AND the SHARD-spend quests — are credited only when the level
    // actually lands (completeDueJobs), exactly like v2 troop training: a
    // start → cancel → refund loop must never farm quest progress. Walls upgrade
    // instantly, cannot be cancelled, and keep their at-start rule.
    const timed = b.type !== 'wall';
    const jobId = randomUUID();
    const debitMetadata = {
      buildingId, baseId: ctx.baseId, to: b.level + 1,
      ...(timed ? { jobId, costShards: cost } : {}),
    };
    const posted = ctx.baseId
      ? await spendBaseShards(tx, ctx.baseId, BigInt(cost), 'build.upgrade', ledgerKey, debitMetadata,
        { progressQuests: !timed })
      : await spendShards(tx, wallet, BigInt(cost), 'build.upgrade', ledgerKey, debitMetadata,
        { progressQuests: !timed });

    if (b.type === 'wall') {
      const [updated] = await tx.update(buildings).set({ level: b.level + 1 })
        .where(and(eq(buildings.id, buildingId), eq(buildings.level, b.level))).returning();
      if (!updated) throw new HttpError(409, 'wall changed mid-upgrade — retry');
      await markBuildAction(tx, wallet, now, ctx.baseId);
      await progressQuestBatch(tx, wallet, [
        ['upgrade_any', 1], ['upgrade_2_buildings', 1],
        // Walls upgrade instantly, so the reached tier is authoritative here.
        ...(updated.level >= 3 ? [['upgrade_to_level_3', 1] as const] : []),
      ], now, ctx.baseId);
      return { building: updated, job: null, duplicate: false };
    }

    if (jobs.length >= ctx.builders) throw new HttpError(422, 'all builders are busy');
    const seconds = UPGRADE_TIMES_SEC[b.type as keyof typeof UPGRADE_TIMES_SEC]?.[b.level - 1];
    if (seconds === undefined) throw new HttpError(422, `no upgrade time defined for ${b.type}`);
    const [job] = await tx.insert(builderJobs).values({
      id: jobId, playerWallet: wallet, baseId: ctx.baseId, kind: 'upgrade', buildingId, startedAt: now,
      finishesAt: new Date(now.getTime() + seconds * 1000),
      paidShardCost: BigInt(cost), debitLedgerTxnId: posted.transaction.id,
    }).returning();
    await markBuildAction(tx, wallet, now, ctx.baseId);
    // Upgrade + spend quests tick when the level LANDS (completeDueJobs), never
    // here: the job is refundable until then.
    return { building: b, job: jobResponse(job!), duplicate: false };
  });
}

/** The started job as the route returns it: the receipt is a decimal string
 * (a bigint cannot be JSON-serialised — the first live upgrade after D-104
 * committed its job and then answered 500), mirroring the base DTO's
 * `refundShards`. */
function jobResponse<T extends { paidShardCost: bigint | null }>(job: T): Omit<T, 'paidShardCost'> & { refundShards: string | null } {
  const { paidShardCost, ...rest } = job;
  return { ...rest, refundShards: paidShardCost === null ? null : paidShardCost.toString() };
}

/** Quest credit for a landed cancellable upgrade — the receipt-carrying twin of
 * the wall's at-start ticks. Runs inside the completion claim, so it fires
 * exactly once per finished job and never for a cancelled one. Rotation
 * follows the job's due time (a paid FINISH rewrites finishesAt to its own
 * moment), the same rule v2 training uses for its ready event. */
async function creditCompletedUpgradeQuests(
  tx: DbOrTx, wallet: string,
  job: { finishesAt: Date; paidShardCost: bigint | null; baseId: string | null },
  reachedLevel: number,
): Promise<void> {
  if (job.paidShardCost === null) return; // pre-receipt job: credited at start
  const spend = Number(job.paidShardCost);
  if (!Number.isSafeInteger(spend)) {
    throw new HttpError(409, 'upgrade receipt is outside the supported range', 'UPGRADE_RECEIPT_INVALID');
  }
  await progressQuestBatch(tx, wallet, [
    ['upgrade_any', 1], ['upgrade_2_buildings', 1],
    ...(reachedLevel >= 3 ? [['upgrade_to_level_3', 1] as const] : []),
    ['spend_200', spend], ['spend_500', spend],
  ], job.finishesAt, job.baseId ?? undefined);
}

export interface CancelUpgradeResult {
  id: string;
  buildingId: string;
  refundShards: string;
  cancelledAt: Date;
  replayed: boolean;
}

type CancellableJobRow = typeof builderJobs.$inferSelect;

/** Validate the immutable upgrade debit before creating its exact inverse. No
 * cost table is consulted: the refund is the job's snapshotted receipt and its
 * linked append-only ledger post, or nothing. */
async function requireUpgradeDebit(
  tx: DbOrTx, job: CancellableJobRow, wallet: string, baseId?: string,
) {
  if (job.paidShardCost === null || job.paidShardCost <= 0n || job.debitLedgerTxnId === null) {
    // Distinguish the two uncancellable shapes for the player: a SOL-priced
    // step (D-057) was paid on-chain and is never unwound here; anything else
    // without a receipt predates refundable upgrades.
    const [b] = job.buildingId
      ? await tx.select({ type: buildings.type, level: buildings.level }).from(buildings)
        .where(eq(buildings.id, job.buildingId))
      : [];
    if (b && upgradeSolLamports(b.type, b.level + 1) > 0) {
      throw new HttpError(409, 'SOL-paid upgrades cannot be cancelled; it will finish normally', 'UPGRADE_PAID_IN_SOL');
    }
    throw new HttpError(
      409, 'this upgrade was started before refundable upgrades; it will finish normally',
      'UPGRADE_NOT_REFUNDABLE',
    );
  }
  const cost = job.paidShardCost;
  if (!Number.isSafeInteger(Number(cost))) {
    throw new HttpError(409, 'upgrade debit receipt is outside the supported range', 'UPGRADE_RECEIPT_INVALID');
  }
  const [debit] = await tx.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.id, job.debitLedgerTxnId));
  const debitEntries = await tx.select().from(ledgerEntries)
    .where(eq(ledgerEntries.txnId, job.debitLedgerTxnId));
  const metadata = debit?.metadata as Record<string, unknown> | undefined;
  const sys = await bootstrapSystemAccounts(tx);
  const owner = baseId
    ? await getOrCreateBaseAccount(tx, baseId, 'base_shards')
    : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
  const validDebit = debit?.type === 'build.upgrade'
    && metadata?.['jobId'] === job.id
    && metadata?.['buildingId'] === job.buildingId
    && metadata?.['costShards'] === Number(cost)
    && (baseId ? metadata?.['baseId'] === baseId : metadata?.['wallet'] === wallet)
    && debitEntries.length === 2
    && debitEntries.some((entry) => entry.accountId === owner.id && entry.delta === -cost)
    && debitEntries.some((entry) => entry.accountId === sys.shard_burn && entry.delta === cost);
  if (!validDebit) {
    throw new HttpError(409, 'upgrade debit receipt does not match this job', 'UPGRADE_RECEIPT_INVALID');
  }
  return { sys, owner, cost };
}

async function assertUpgradeRefundReceipt(
  tx: DbOrTx, job: CancellableJobRow, wallet: string, refundTxnId: string | null,
  context: Awaited<ReturnType<typeof requireUpgradeDebit>>, baseId?: string,
): Promise<void> {
  if (!refundTxnId) throw new HttpError(409, 'upgrade refund receipt is missing', 'UPGRADE_REFUND_INVALID');
  const [refundTxn] = await tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, refundTxnId));
  const refundEntries = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, refundTxnId));
  const refundMetadata = refundTxn?.metadata as Record<string, unknown> | undefined;
  const validRefund = refundTxn?.idempotencyKey === `build-upgrade-cancel:${job.id}`
    && refundTxn.type === 'build.upgrade.cancel'
    && refundMetadata?.['jobId'] === job.id
    && refundMetadata?.['debitLedgerTxnId'] === job.debitLedgerTxnId
    && (baseId ? refundMetadata?.['baseId'] === baseId : refundMetadata?.['wallet'] === wallet)
    && refundEntries.length === 2
    && refundEntries.some((entry) => entry.accountId === context.sys.shard_burn && entry.delta === -context.cost)
    && refundEntries.some((entry) => entry.accountId === context.owner.id && entry.delta === context.cost);
  if (!validRefund) {
    throw new HttpError(409, 'upgrade refund receipt does not match this job', 'UPGRADE_REFUND_INVALID');
  }
}

type CancellationQuota = { day: string | null; count: number };

function nextCancellationCount(quota: CancellationQuota, day: string, max: number, code: string, what: string): number {
  const count = quota.day === day ? quota.count : 0;
  if (count >= max) throw new HttpError(429, `daily ${what} cancellation limit reached`, code);
  return count + 1;
}

/** Spend the durable successful-refund budgets while the caller holds the
 * player (and, in stable mode, base) row locks. Shares the refund transaction,
 * so a failed ledger post or terminal job write restores the counters. */
async function consumeUpgradeCancellationQuota(
  tx: DbOrTx, wallet: string, now: Date, baseId?: string,
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const [player] = await tx.select({ day: players.upgradeCancelDay, count: players.upgradeCancelCount })
    .from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found', 'PLAYER_NOT_FOUND');
  const playerCount = nextCancellationCount(
    player, day, UPGRADE_CANCELLATION.maxRefundsPerWalletUtcDay, 'UPGRADE_CANCEL_RATE_LIMITED', 'upgrade',
  );
  let baseCount: number | undefined;
  if (baseId) {
    const [base] = await tx.select({ day: bases.upgradeCancelDay, count: bases.upgradeCancelCount })
      .from(bases).where(eq(bases.id, baseId));
    if (!base) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
    baseCount = nextCancellationCount(
      base, day, UPGRADE_CANCELLATION.maxRefundsPerBaseUtcDay, 'UPGRADE_CANCEL_RATE_LIMITED', 'upgrade',
    );
  }
  await tx.update(players).set({ upgradeCancelDay: day, upgradeCancelCount: playerCount })
    .where(eq(players.wallet, wallet));
  if (baseId && baseCount !== undefined) {
    await tx.update(bases).set({ upgradeCancelDay: day, upgradeCancelCount: baseCount })
      .where(eq(bases.id, baseId));
  }
}

/**
 * Cancel one RUNNING upgrade job: free its builder, leave the level where it
 * is, and compensate the exact SHARD debit the job recorded when it started
 * (never KEEP, never SOL; a speed-up already paid stays paid). Stable mode
 * refunds the deed account, so a transfer never redirects deed value to either
 * wallet. Mirrors cancelTraining: row lock, exact receipt both ways, idempotent
 * replay by cancel key, durable UTC-day ceilings, one refund per job enforced
 * by the ledger key.
 */
export async function cancelUpgrade(
  db: Db, wallet: string, jobId: string, idempotencyKey: string,
  now = new Date(), requestedBaseId?: string, stableContext?: StableBaseMutationContext,
): Promise<CancelUpgradeResult> {
  // Refusals decided BEFORE any money moves are returned, not thrown, so the
  // lazy completion that made them true (an elapsed job landing its level)
  // commits with them — the same outcome shape cancelTraining uses.
  type Outcome = { result: CancelUpgradeResult } | { error: HttpError };
  const outcome = await db.transaction<Outcome>(async (tx) => {
    const ctx = await lockMutationBase(tx, wallet, requestedBaseId, false, stableContext);
    // Settle due work first: a job whose timer already elapsed lands its level
    // here and is then honestly "already finished" below, never refunded.
    await completeDueJobs(tx, wallet, now, ctx.baseId);
    const [job] = await tx.select().from(builderJobs)
      .where(and(eq(builderJobs.id, jobId), jobScope(wallet, ctx.baseId))).for('update');
    if (!job) return { error: new HttpError(404, 'job not found', 'JOB_NOT_FOUND') };
    let refundContext: Awaited<ReturnType<typeof requireUpgradeDebit>>;
    try {
      if (job.cancelledAt && job.cancelIdempotencyKey === idempotencyKey && job.paidShardCost !== null) {
        const context = await requireUpgradeDebit(tx, job, wallet, ctx.baseId);
        await assertUpgradeRefundReceipt(tx, job, wallet, job.refundLedgerTxnId, context, ctx.baseId);
        return { result: {
          id: job.id, buildingId: job.buildingId!, refundShards: job.paidShardCost.toString(),
          cancelledAt: job.cancelledAt, replayed: true,
        } };
      }
      if (job.completedAt) throw new HttpError(409, 'upgrade already finished or was cancelled', 'JOB_NOT_ACTIVE');
      if (job.kind !== 'upgrade' || !job.buildingId) {
        throw new HttpError(409, 'only a running upgrade can be cancelled', 'JOB_NOT_CANCELLABLE');
      }
      // The unique index is (player_wallet, cancel_idempotency_key) across every
      // base a wallet owns, so the reuse check must look as wide as the index —
      // otherwise the same key on a sibling base surfaces as a 500, not a 409.
      const [keyOwner] = await tx.select({ id: builderJobs.id }).from(builderJobs)
        .where(and(eq(builderJobs.playerWallet, wallet), eq(builderJobs.cancelIdempotencyKey, idempotencyKey)));
      if (keyOwner && keyOwner.id !== job.id) {
        throw new HttpError(409, 'cancellation key was already used for another job', 'JOB_CANCEL_KEY_REUSED');
      }
      refundContext = await requireUpgradeDebit(tx, job, wallet, ctx.baseId);
    } catch (error) {
      if (error instanceof HttpError) return { error };
      throw error;
    }
    await consumeUpgradeCancellationQuota(tx, wallet, now, ctx.baseId);
    const posted = await postTransaction(tx, {
      idempotencyKey: `build-upgrade-cancel:${job.id}`,
      type: 'build.upgrade.cancel',
      entries: [
        { account: refundContext.sys.shard_burn, delta: -refundContext.cost },
        { account: refundContext.owner.id, delta: refundContext.cost },
      ],
      metadata: {
        wallet, ...(ctx.baseId ? { baseId: ctx.baseId } : {}),
        jobId: job.id, buildingId: job.buildingId, debitLedgerTxnId: job.debitLedgerTxnId,
      },
    });
    await assertUpgradeRefundReceipt(tx, job, wallet, posted.transaction.id, refundContext, ctx.baseId);
    // completedAt too: every active-job predicate (builder slot, lazy
    // completion, DTO) reads isNull(completedAt), so this one write frees the
    // builder and guarantees the level never lands.
    const [cancelled] = await tx.update(builderJobs).set({
      completedAt: now, cancelledAt: now, cancelIdempotencyKey: idempotencyKey,
      refundLedgerTxnId: posted.transaction.id,
    }).where(and(
      eq(builderJobs.id, job.id), jobScope(wallet, ctx.baseId),
      isNull(builderJobs.completedAt), isNull(builderJobs.cancelledAt),
    )).returning({ id: builderJobs.id });
    if (!cancelled) throw new HttpError(409, 'upgrade changed before cancellation', 'JOB_CHANGED');
    return { result: {
      id: job.id, buildingId: job.buildingId, refundShards: refundContext.cost.toString(),
      cancelledAt: now, replayed: posted.duplicate,
    } };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

/**
 * Rearm one spent trap through a builder-timed, idempotent SHARD spend.
 * The spend is bound to the exact spent episode so an old client key can never
 * repair a trap triggered by a later raid for free (owner 2026-08-15/M22).
 */
export async function repairTrap(
  db: Db, wallet: string, buildingId: string, idempotencyKey: string,
  now = new Date(), requestedBaseId?: string, stableContext?: StableBaseMutationContext,
) {
  return db.transaction(async (tx) => {
    const ctx = await lockMutationBase(tx, wallet, requestedBaseId, false, stableContext);
    await completeDueJobs(tx, wallet, now, ctx.baseId);
    const [trap] = await tx.select().from(buildings)
      .where(and(eq(buildings.id, buildingId), buildingScope(wallet, ctx.baseId))).for('update');
    if (!trap) throw new HttpError(404, 'building not found');
    if (!isTrapType(trap.type)) throw new HttpError(422, 'building is not a trap');

    const ledgerKey = `repair:${wallet}:${idempotencyKey}`;
    const [prior] = await tx.select({ metadata: ledgerTransactions.metadata }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, ledgerKey));
    if (prior) {
      const metadata = prior.metadata as { buildingId?: unknown; spentAt?: unknown; cost?: unknown };
      if (metadata.buildingId !== buildingId) {
        throw new HttpError(409, 'idempotency key belongs to another building');
      }
      if (trap.trapSpentAt && metadata.spentAt !== trap.trapSpentAt.toISOString()) {
        throw new HttpError(409, 'idempotency key belongs to an earlier trap activation');
      }
      const [job] = await tx.select().from(builderJobs).where(and(
        jobScope(wallet, ctx.baseId), eq(builderJobs.buildingId, buildingId),
        eq(builderJobs.kind, 'repair'), isNull(builderJobs.completedAt),
      )).orderBy(desc(builderJobs.startedAt)).limit(1);
      return { building: trap, job: job ?? null, costShards: Number(metadata.cost ?? 0), duplicate: true };
    }
    if (!trap.trapSpentAt) throw new HttpError(422, 'trap is already armed');

    const jobs = await activeJobs(tx, wallet, ctx.baseId);
    if (jobs.some((job) => job.buildingId === buildingId)) {
      throw new HttpError(422, 'a job is already running on this building');
    }
    if (jobs.length >= ctx.builders) throw new HttpError(422, 'all builders are busy');

    const repair = TRAP_REPAIR[trap.type];
    const tier = artTierOfLevel(trap.level);
    const costShards = repair.costShardsByTier[tier - 1];
    if (costShards === undefined) throw new HttpError(422, `no repair cost defined for ${trap.type}`);
    const spentAt = trap.trapSpentAt.toISOString();
    const metadata = { buildingId, baseId: ctx.baseId, spentAt, tier, cost: costShards };
    const posted = ctx.baseId
      ? await spendBaseShards(tx, ctx.baseId, BigInt(costShards), 'build.repair', ledgerKey, metadata)
      : await spendShards(tx, wallet, BigInt(costShards), 'build.repair', ledgerKey, metadata);
    if (posted.duplicate) throw new HttpError(409, 'duplicate repair request — refresh your base');

    const [job] = await tx.insert(builderJobs).values({
      playerWallet: wallet, baseId: ctx.baseId, kind: 'repair', buildingId,
      startedAt: now, finishesAt: new Date(now.getTime() + repair.repairSec * 1000),
    }).returning();
    await markBuildAction(tx, wallet, now, ctx.baseId);
    return { building: trap, job: job!, costShards, duplicate: false };
  });
}

/** The two building types whose deep upgrades charge SOL (D-057): Mine L5+ and
 *  Gold Forge L2+. The historical deposit kind for BOTH is 'mine' — the wire/db
 *  enum predates the forge gate and adding an enum value needs a migration the
 *  payment flow does not otherwise require. */
export type SolGatedBuildingType = 'mine' | 'goldforge';
export function isSolGatedBuildingType(type: string): type is SolGatedBuildingType {
  return type === 'mine' || type === 'goldforge';
}

/** Preflight for a SOL-priced upgrade (Mine L5+ / Gold Forge L2+ — D-057), run
 *  when the 'mine'-kind deposit intent is minted so a player is never asked to
 *  pay SOL for an upgrade that can't apply. Mirrors upgradeBuilding's gates
 *  (not maxed, land for the forge, Keep-level, builder availability, SHARD
 *  affordability). Returns the SOL price (lamports) for the NEXT level; a step
 *  the table prices at 0 is refused — free steps go through the normal route. */
export async function assertPaidUpgradeable(
  db: DbOrTx, wallet: string, buildingId: string, now = new Date(), requestedBaseId?: string,
): Promise<{ solLamports: number; buildingType: 'mine' | 'goldforge'; fromLevel: number; costShards: number }> {
  return db.transaction(async (tx) => {
    const ctx = await lockMutationBase(tx, wallet, requestedBaseId);
    await completeDueJobs(tx, wallet, now, ctx.baseId);
    const [b] = await tx.select().from(buildings)
      .where(and(eq(buildings.id, buildingId), buildingScope(wallet, ctx.baseId)));
    if (!b) throw new HttpError(404, 'building not found');
    if (!isSolGatedBuildingType(b.type)) throw new HttpError(422, 'this building type has no SOL-priced upgrades');
    const max = MAX_LEVEL[b.type] ?? 1;
    if (b.level >= max) throw new HttpError(422, `${b.type} is already at max level`);
    const sol = upgradeSolLamports(b.type, b.level + 1);
    if (sol <= 0) throw new HttpError(422, 'this upgrade costs no SOL — use POST /base/buildings/:id/upgrade');
    const shardCost = UPGRADE_COSTS[b.type][b.level - 1];
    const seconds = UPGRADE_TIMES_SEC[b.type][b.level - 1];
    if (shardCost === undefined || seconds === undefined) {
      throw new HttpError(422, `no upgrade defined for this ${b.type} level`);
    }
    assertLandForBuilding(b.type, { entryPaidAt: ctx.landPaidAt });
    if (b.level + 1 > ctx.keepLevel) throw new HttpError(422, 'upgrade gated by Keep level');
    const jobs = await activeJobs(tx, wallet, ctx.baseId);
    if (jobs.some((j) => j.buildingId === buildingId)) throw new HttpError(422, 'a job is already running on this building');
    if (jobs.length >= ctx.builders) throw new HttpError(422, 'all builders are busy');
    // Stable gameplay wealth belongs to the deed, not its current wallet. The
    // base row is already locked by lockMutationBase, and the ledger posting in
    // applyPaidUpgrade locks this same account before debiting it.
    const shards = ctx.baseId
      ? await getOrCreateBaseAccount(tx, ctx.baseId, 'base_shards')
      : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
    if (shards.balance < BigInt(shardCost)) throw new HttpError(422, `not enough SHARDS (need ${shardCost}) for the upgrade`);
    return { solLamports: sol, buildingType: b.type, fromLevel: b.level, costShards: shardCost };
  });
}

/** Apply a paid SOL-gated upgrade (Mine L5+ / Gold Forge L2+ — D-057) — called
 *  from creditDeposit INSIDE its transaction once the on-chain SOL payment is
 *  verified at finalized. Burns the SHARD cost and starts the upgrade job; the
 *  level bumps when the job completes (completeDueJobs), exactly like a normal
 *  upgrade. Re-validates so a race can't over-apply; if the player no longer
 *  affords the SHARDS the ledger throws and the whole credit rolls back (the
 *  deposit stays pending and self-heals on the next verify). */
export async function applyPaidUpgrade(
  tx: DbOrTx, wallet: string, buildingId: string, idempotencyKey: string, now: Date,
  requestedBaseId?: string, frozenPaidBase = false,
  consent?: Extract<BasePurchaseRequest, { kind: 'mine' }>,
): Promise<void> {
  // Lock the wallet-wide builder owner, then the building. The player lock
  // prevents two paid upgrades on DIFFERENT buildings from both observing one
  // free builder; the building lock prevents two same-level credits from
  // advancing one building twice at the old price.
  const ctx = await lockMutationBase(tx, wallet, requestedBaseId, frozenPaidBase);
  const [b] = await tx.select().from(buildings)
    .where(and(eq(buildings.id, buildingId), buildingScope(wallet, ctx.baseId)))
    .for('update');
  if (!b || !isSolGatedBuildingType(b.type)) throw new HttpError(422, 'not a SOL-priced building');
  const max = MAX_LEVEL[b.type] ?? 1;
  if (b.level >= max) throw new HttpError(422, `${b.type} is already at max level`);
  const shardCost = UPGRADE_COSTS[b.type][b.level - 1];
  const seconds = UPGRADE_TIMES_SEC[b.type][b.level - 1];
  if (shardCost === undefined || seconds === undefined) throw new HttpError(422, `no upgrade defined for this ${b.type} level`);
  if (consent && (consent.baseId !== ctx.baseId || consent.buildingId !== b.id
    || consent.buildingType !== b.type || consent.fromLevel !== b.level || consent.toLevel !== b.level + 1
    || BigInt(shardCost) > BigInt(consent.maxCostShards))) {
    throw new HttpError(409, 'paid upgrade no longer matches original consent', 'BASE_PURCHASE_CHANGED');
  }
  // The forge is land-gated on EVERY mutation (mirrors upgradeBuilding).
  assertLandForBuilding(b.type, { entryPaidAt: ctx.landPaidAt });
  if (b.level + 1 > ctx.keepLevel) throw new HttpError(422, 'upgrade gated by Keep level');
  const jobs = await activeJobs(tx, wallet, ctx.baseId);
  if (jobs.some((j) => j.buildingId === buildingId)) throw new HttpError(422, 'a job is already running on this building');
  if (jobs.length >= ctx.builders) throw new HttpError(422, 'all builders are busy');

  // Dual-currency split: the paid step still charges its SHARDS like every
  // building upgrade (burned — soft currency has no pool to recycle into).
  const sys = await bootstrapSystemAccounts(tx);
  const acct = ctx.baseId
    ? await getOrCreateBaseAccount(tx, ctx.baseId, 'base_shards')
    : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
  await postTransaction(tx, {
    idempotencyKey,
    type: b.type === 'mine' ? 'build.upgrade_mine' : 'build.upgrade_goldforge',
    entries: [
      { account: acct.id, delta: -BigInt(shardCost) },
      { account: sys.shard_burn, delta: BigInt(shardCost) },
    ],
    metadata: { wallet, baseId: ctx.baseId, buildingId, to: b.level + 1 },
  });
  await tx.insert(builderJobs).values({
    playerWallet: wallet, baseId: ctx.baseId, kind: 'upgrade', buildingId,
    startedAt: now, finishesAt: new Date(now.getTime() + seconds * 1000),
  });
}

/** Apply a paid additional Mine — IN-FLIGHT COMPATIBILITY ONLY since D-057
 *  (owner 2026-08-16: mine builds are SOL-free; new mines of any count go
 *  through placeBuilding and new 'mine_build' intents are refused at creation).
 *  This stays so a pre-D-057 intent whose SOL payment was already broadcast
 *  still credits: called from creditDeposit INSIDE its tx once the payment
 *  (100% to liquidity) is verified at finalized. Every MINE_BUILD_SOL_LAMPORTS
 *  price is now 0, so any observed paid amount passes the price check and the
 *  paid player is never stranded. Locks the player row so two concurrent
 *  credits can't both slip past the count cap; charges the progressive KEEP
 *  (recycles 100% to emission_pool) and starts the build job (the mine appears
 *  when the job completes, exactly like the 1st mine). */
export async function applyMineBuild(
  tx: DbOrTx, wallet: string, txTile: number, tyTile: number, paidLamports: bigint,
  idempotencyKey: string, now: Date, requestedBaseId?: string, frozenPaidBase = false,
  expectedMines?: number,
): Promise<void> {
  // No building row exists yet, so serialize on the PLAYER row — else two credits
  // both read the same mine count and both build, exceeding the Keep-gated cap.
  const ctx = await lockMutationBase(tx, wallet, requestedBaseId, frozenPaidBase);
  const mines = await tx.select({ id: buildings.id }).from(buildings)
    .where(and(buildingScope(wallet, ctx.baseId), eq(buildings.type, 'mine')));
  const count = mines.length;
  // Re-check the FROZEN slot under this lock (security review 2026-08-16
  // finding 2): creditDeposit's own expectedMines comparison runs on an
  // unlocked read, so a concurrent free-route placeBuilding could commit a
  // mine between that check and this lock. Pre-D-057 the SOL re-price below
  // caught the interleaving (a later slot cost more than was paid); with every
  // build price now 0 this equality is the only guard, so it must hold HERE.
  // A single-threaded test cannot falsify this line — do not read a passing
  // suite as evidence the race is covered elsewhere.
  if (expectedMines !== undefined && count !== expectedMines) {
    throw new HttpError(409, 'mine-build slot changed before payment verification');
  }
  if (count === 0) throw new HttpError(422, 'the first mine is KEEP-only');
  if (count >= maxMinesForKeep(ctx.keepLevel)) throw new HttpError(422, 'mine cap reached');
  const keepCost = MINING.MINE_BUILD_KEEP[count];
  const solPrice = MINING.MINE_BUILD_SOL_LAMPORTS[count];
  if (keepCost === undefined || solPrice === undefined) throw new HttpError(422, 'no price for this mine index');
  // The SERVER is the price authority: the paid SOL (observed on-chain, to the
  // liquidity wallet) must meet the Nth-mine price for the count at credit time.
  if (paidLamports < BigInt(solPrice)) throw new HttpError(422, 'mine build underpaid');
  await geometryCheck(tx, wallet, { tx: txTile, ty: tyTile, ...footprintOf(BuildingType.Mine) }, ctx.expansions, undefined, ctx.baseId);
  const jobs = await activeJobs(tx, wallet, ctx.baseId);
  if (jobs.length >= ctx.builders) throw new HttpError(422, 'all builders are busy');

  // KEEP recycles 100% to emission_pool (ECONOMY.md §4b), so the mining treasury
  // never runs dry — heavy mine-builders pump MORE KEEP back into the pool.
  const sys = await bootstrapSystemAccounts(tx);
  const acct = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
  await postTransaction(tx, {
    idempotencyKey,
    type: 'build.mine',
    entries: [
      { account: acct.id, delta: -BigInt(keepCost) },
      { account: sys.emission_pool, delta: BigInt(keepCost) },
    ],
    metadata: { wallet, baseId: ctx.baseId, tx: txTile, ty: tyTile, mineIndex: count, recycled: true },
  });
  const [row] = await tx.insert(buildings)
    .values({ playerWallet: wallet, baseId: ctx.baseId, type: BuildingType.Mine, level: 1, tx: txTile, ty: tyTile })
    .returning();
  await tx.insert(builderJobs).values({
    playerWallet: wallet, baseId: ctx.baseId, kind: 'build', buildingId: row!.id,
    startedAt: now, finishesAt: new Date(now.getTime() + BUILD_COSTS.mine.buildSec * 1000),
  });
}

export async function clearObstacle(
  db: Db, wallet: string, obstacleId: string, idempotencyKey: string,
  now = new Date(), requestedBaseId?: string, stableContext?: StableBaseMutationContext,
) {
  return db.transaction(async (tx) => {
    const ctx = await lockMutationBase(tx, wallet, requestedBaseId, false, stableContext);
    await completeDueJobs(tx, wallet, now, ctx.baseId);
    const [o] = await tx.select().from(obstacles)
      .where(and(eq(obstacles.id, obstacleId), obstacleScope(wallet, ctx.baseId))).for('update');
    if (!o) throw new HttpError(404, 'obstacle not found');

    const ledgerKey = `obst:${wallet}:${idempotencyKey}`;
    const [prior] = await tx.select({ metadata: ledgerTransactions.metadata }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, ledgerKey));
    if (prior) {
      const metadata = prior.metadata as { obstacleId?: unknown };
      if (metadata.obstacleId !== obstacleId) throw new HttpError(409, 'idempotency key belongs to another obstacle');
      const [job] = await tx.select().from(builderJobs)
        .where(and(jobScope(wallet, ctx.baseId), eq(builderJobs.obstacleId, obstacleId)))
        .orderBy(desc(builderJobs.startedAt)).limit(1);
      if (!job) throw new HttpError(409, 'clear posting exists without its job');
      return job;
    }
    if (o.clearedAt) throw new HttpError(404, 'obstacle not found');
    const rect = obstacleRect(o.spriteKey, o.tx, o.ty);
    if (!insideClaim(rect, ctx.expansions)) throw new HttpError(422, 'expand your land to clear this');

    const jobs = await activeJobs(tx, wallet, ctx.baseId);
    if (jobs.length >= ctx.builders) throw new HttpError(422, 'all builders are busy');
    if (jobs.some((j) => j.obstacleId === obstacleId)) throw new HttpError(422, 'already clearing');
    const tier = OBSTACLES.tiers[obstacleTierOf(o.spriteKey)];
    if (ctx.baseId) {
      await spendBaseShards(tx, ctx.baseId, BigInt(tier.costKeep), 'obstacle.clear', ledgerKey, {
        obstacleId, baseId: ctx.baseId,
      }).catch(error => basePaymentError(error, 'SHARDS', BigInt(tier.costKeep), 'clearing'));
    } else {
      await spendShards(tx, wallet, BigInt(tier.costKeep), 'obstacle.clear', ledgerKey, {
        obstacleId, baseId: ctx.baseId,
      }).catch(error => basePaymentError(error, 'SHARDS', BigInt(tier.costKeep), 'clearing'));
    }
    const [job] = await tx.insert(builderJobs).values({
      playerWallet: wallet, baseId: ctx.baseId, kind: 'clear_obstacle', obstacleId, startedAt: now,
      finishesAt: new Date(now.getTime() + tier.clearSec * 1000),
    }).returning();
    return job!;
  });
}

/** Owner 2026-09-05: every initial L1 construction can finish free, including
 * running jobs created before this release. All `build` writers create level 1;
 * upgrade, repair and clearing keep the normal premium price. An overdue job
 * has no remaining time to sell. This quote is shared by the DTO and mutation. */
export function builderJobFinishCostKeep(
  job: { kind: string; finishesAt: Date }, now: Date,
): bigint {
  const remainingSec = Math.max(0, Math.ceil((job.finishesAt.getTime() - now.getTime()) / 1000));
  return job.kind === 'build' || remainingSec === 0 ? 0n : BigInt(speedupCostKeep(remainingSec));
}

/** FINISH uses the server quote and the ordinary atomic completion path. */
export async function speedupJob(
  db: Db, wallet: string, jobId: string, idempotencyKey: string,
  now = new Date(), requestedBaseId?: string, stableContext?: StableBaseMutationContext, consent?: BuilderJobSpeedupConsent,
) {
  const enteredAt = Date.now();
  const request = builderJobSpeedupIntent(jobId, idempotencyKey, requestedBaseId, consent);
  const replay = await replayBuilderJobSpeedup(db, wallet, request);
  if (replay) return replay;
  assertBuilderJobSpeedupScope(request, multiBaseEnabled());
  // Charge + speed-up + completion are ONE transaction (E3, §4.3). As three
  // autocommit statements a crash after the charge left the player's Gems/KEEP gone and
  // the job still ticking — the PAID twin of the finish_job bug. Nothing here may
  // observe a charged-but-unsped state, so it all commits or none of it does.
  return db.transaction(async (tx) => {
    if (request) {
      // Replay again under the transfer-compatible wallet lock, before mutable
      // base/job checks. Concurrent acceptance cannot finish a replacement job.
      await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
      const lockedReplay = await replayBuilderJobSpeedup(tx, wallet, request);
      if (lockedReplay) return lockedReplay;
    }
    const ctx = await lockMutationBase(tx, wallet, requestedBaseId, false, stableContext);
    const [job] = await tx.select().from(builderJobs)
      .where(and(eq(builderJobs.id, jobId), jobScope(wallet, ctx.baseId)))
      .for('update');
    const pricedAt = request ? new Date(now.getTime() + Date.now() - enteredAt) : now;
    if (request && (!job || job.cancelledAt || job.completedAt || job.finishesAt <= pricedAt))
      throw new HttpError(404, 'paid builder job is no longer running', 'BUILDER_JOB_NOT_RUNNING');
    if (!job || job.cancelledAt) throw new HttpError(404, 'job not found or already done');
    if (job.completedAt) {
      // Owner 2026-09-08: a second Finish click or lost response must acknowledge
      // successful initial construction. The locked job is its receipt; do not
      // rewrite completion, repeat quest credit or extend this to paid upgrades.
      if (job.kind === 'build') return { cost: 0n };
      throw new HttpError(404, 'job not found or already done');
    }
    const remSec = Math.max(0, Math.ceil((job.finishesAt.getTime() - pricedAt.getTime()) / 1000));
    const cost = builderJobFinishCostKeep(job, pricedAt);
    if (request) {
      const current = builderJobPaidQuote(job, cost);
      if (!current || (job.baseId ?? null) !== request.baseId || current.kind !== request.consent.kind || current.buildingId !== request.consent.buildingId
        || current.obstacleId !== request.consent.obstacleId || current.startedAt !== request.consent.startedAt
        || current.finishesAt !== request.consent.finishesAt || pricedAt < job.startedAt
        || cost > BigInt(request.consent.maxCostKeep))
        throw new HttpError(409, 'builder job or price changed; review again', 'BUILDER_SPEEDUP_QUOTE_CHANGED');
    }
    // Namespaced + duplicate-gated (security review 2026-07-24 #5): a reused key
    // charges nothing, so it must never instant-finish a job for free.
    // A free finish claims the job itself as its exactly-once boundary. The
    // ledger rejects zero-value transfers and must not acquire a fake debit.
    if (cost > 0n) {
      const posted = await spendGameCurrency(tx, wallet, cost, 'build.speedup', `speedup:${wallet}:${idempotencyKey}`, {
        jobId, remSec, ...(ctx.baseId ? { baseId: ctx.baseId } : {}),
        ...(request ? { builderJobSpeedup: { version: 1, request, result: { jobId, kind: job.kind,
          buildingId: job.buildingId, obstacleId: job.obstacleId, completedAt: pricedAt.toISOString() } } } : {}),
      });
      if (posted.duplicate) throw new HttpError(409, 'duplicate speedup request — refresh your base');
    }
    // Re-claim the job UNDER the transaction: between the read above and here a
    // concurrent completeDueJobs (or a second speedup) may have finished it, and
    // paying to speed up an already-done job is money for nothing.
    const sped = await tx.update(builderJobs).set({ finishesAt: pricedAt })
      .where(and(eq(builderJobs.id, jobId), jobScope(wallet, ctx.baseId), isNull(builderJobs.completedAt)))
      .returning({ id: builderJobs.id });
    if (sped.length === 0) throw new HttpError(409, 'job already finished — refresh your base');
    await completeDueJobs(tx, wallet, pricedAt, ctx.baseId);
    return { cost };
  });
}


// Phase E: atomic second-free-base founding. The purchase service holds the
// player and sorted base/slot locks and owns the outer debit/receipt transaction.
export async function initializePurchasedFreeBase(tx: DbTx, wallet: string, baseId: string): Promise<void> {
  const [player] = await tx.select({ entryPaidAt: players.entryPaidAt }).from(players)
    .where(eq(players.wallet, wallet)).for('update');
  const [base] = await tx.select().from(bases).where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet))).for('update');
  const [slot] = await tx.select({ baseId: baseSlots.baseId }).from(baseSlots)
    .where(and(eq(baseSlots.baseId, baseId), eq(baseSlots.wallet, wallet), eq(baseSlots.active, true))).for('update');
  if (!player || !base || !slot || base.status !== 'active' || base.landPaidAt !== null
    || base.deedAssetId !== null || base.deedMintAssetId !== null || base.deedMintingAt !== null) {
    throw new HttpError(409, 'purchased free base is not ready for initialization', 'FREE_BASE_INITIALIZATION_CONFLICT');
  }
  await ensureStartingBaseLocked(tx, wallet, player.entryPaidAt, baseId);
}
