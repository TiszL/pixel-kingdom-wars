/**
 * Hero leveling (D-Q1, owner 2026-07-28) — the KEEP sink that was specced but
 * never wired: Vex and Theodor were recruited by building their altar and then
 * stuck at level 1 forever.
 *
 * Rules enforced here (server is authoritative — the client only renders):
 * - a hero is RECRUITED when its altar building exists AND its build job is
 *   finished (same definition raids.ts freezes into the armySnapshot);
 * - levels run 1..HERO_LEVELING.maxLevel; level N→N+1 costs
 *   HERO_LEVELING.upgradeCostKeep[hero][N-1] KEEP — the spec pages price hero
 *   upgrades in KEEP, like TROOP_LEVELING research;
 * - stats come from the SNAPSHOTTED integer tables (HERO_LEVELING.hp/dps), never
 *   from the HEROES spec formulas, so no Math.pow reaches a hot path.
 *
 * Money path: the debit (spendGameCurrency: Gems → gems_sink, or the legacy KEEP
 * leg → emission_pool, ECONOMY.md
 * §4b) and the level bump commit in ONE transaction under a player-row FOR
 * UPDATE lock, with a namespaced idempotency key. That combination is what makes
 * "two concurrent upgrades" resolve to exactly one level and exactly one charge.
 */
import {
  HERO_KEYS,
  HERO_LEVELING,
  HEROES,
  heroTier,
  speedupCostKeep,
  type HeroKey,
} from '@shardkeep/shared';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { baseHeroProgress, heroLevels, ledgerTransactions, players } from '../db/schema';
import { gemsEnabled, heroGearCombatEnabled, multiBaseEnabled } from '../config';
import { getOrCreatePlayerAccount } from '../ledger/accounts';
import { HttpError } from '../lib/errors';
import { completeDueJobs } from './base';
import { spendGameCurrency } from './spend';
import { assertHeroLevel, assertHeroPrice, assertHeroRecovery, type HeroUpgradeConsent, type HeroRecoveryConsent } from './heroConsent';
import { getHeroRecoveryReceipt, heroLedgerKey, heroUpgradeEvidence, heroRecoveryEvidence } from './heroReceipt';
import {
  lockStablePrerequisiteBase,
  requireActiveStablePrerequisiteBase,
  requireStableBaseMutationContext,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';

/** Tier display name for a level (T1 L1–5 … T4 L16–20 — HEROES[hero].tiers). */
function tierNameOf(hero: HeroKey, level: number): string {
  return HEROES[hero].tiers[heroTier(level) - 1]!.name;
}

/** Clamp a stored level into the table's range so a bad row can never index
 *  out of bounds (a NaN/undefined stat would silently reach the client). */
function clampLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1) return 1;
  return Math.min(level, HERO_LEVELING.maxLevel);
}

/** KEEP cost of level → level+1, or null at max level. */
export function heroUpgradeCost(hero: HeroKey, level: number): bigint | null {
  if (level >= HERO_LEVELING.maxLevel) return null;
  const cost = HERO_LEVELING.upgradeCostKeep[hero][level - 1];
  return cost === undefined ? null : BigInt(cost);
}

/**
 * Which heroes are recruited: a COMPLETED altar (no unfinished `build` job).
 * Deliberately the same predicate raids.ts uses when it freezes
 * `armySnapshot.heroes`, so "can deploy" and "can upgrade" never disagree.
 */
export async function recruitedHeroesOf(
  db: DbOrTx,
  wallet: string,
  baseId?: string,
): Promise<Set<HeroKey>> {
  const basePredicate = baseId === undefined
    ? sql`b.player_wallet = ${wallet}`
    : sql`b.base_id = ${baseId}`;
  const rows = await db.execute(sql`
    SELECT b.type FROM buildings b
    WHERE ${basePredicate} AND b.type IN (${sql.join(HERO_KEYS.map((h) => sql`${HEROES[h].altar}`), sql`, `)})
      AND NOT EXISTS (
        SELECT 1 FROM builder_jobs j
        WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
      )
  `) as unknown as Array<{ type: string }>;
  const out = new Set<HeroKey>();
  for (const r of rows) {
    for (const hero of HERO_KEYS) if (HEROES[hero].altar === r.type) out.add(hero);
  }
  return out;
}

export interface RecruitedHeroPlacement {
  hero: HeroKey;
  level: number;
  /** Integer guard tile at the deterministic centre tile of the 2x2 altar. */
  guardTx: number;
  guardTy: number;
  recoveryUntil: Date | null;
  available: boolean;
}

/** Completed altar placements plus paid levels, in canonical HERO_KEYS order.
 * Raid defence and scout use this same read model so disclosed guards cannot
 * disagree with the frozen battle snapshot. */
export async function recruitedHeroPlacementsOf(
  db: DbOrTx,
  wallet: string,
  now = new Date(),
  baseId?: string,
): Promise<RecruitedHeroPlacement[]> {
  // Stable-base transfers preserve a base's buildings while ownership changes.
  // Callers that know the selected base therefore anchor altar geometry by
  // base_id; hero level/recovery still belongs to the current owner wallet.
  const basePredicate = baseId === undefined
    ? sql`b.player_wallet = ${wallet}`
    : sql`b.base_id = ${baseId}`;
  const rows = await db.execute(sql`
    SELECT b.type, b.tx, b.ty FROM buildings b
    WHERE ${basePredicate} AND b.type IN (${sql.join(HERO_KEYS.map((h) => sql`${HEROES[h].altar}`), sql`, `)})
      AND NOT EXISTS (
        SELECT 1 FROM builder_jobs j
        WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
      )
  `) as unknown as Array<{ type: string; tx: number; ty: number }>;
  const states = await heroStatesOf(db, wallet, baseId);
  return HERO_KEYS.flatMap((hero) => {
    const altar = rows.find((row) => row.type === HEROES[hero].altar);
    const state = states[hero];
    return altar ? [{
      hero,
      level: state.level,
      guardTx: altar.tx + 1,
      guardTy: altar.ty + 1,
      recoveryUntil: state.recoveryUntil,
      available: state.recoveryUntil === null || state.recoveryUntil <= now,
    }] : [];
  });
}

/** Stored levels/recovery. Stable reads are deed-scoped; a missing row is L1. */
export async function heroStatesOf(
  db: DbOrTx,
  wallet: string,
  baseId?: string,
): Promise<Record<HeroKey, { level: number; recoveryUntil: Date | null }>> {
  const out = Object.fromEntries(HERO_KEYS.map((h) => [h, {
    level: 1, recoveryUntil: null,
  }])) as Record<HeroKey, { level: number; recoveryUntil: Date | null }>;
  if (baseId) {
    const rows = await db.select().from(baseHeroProgress)
      .where(eq(baseHeroProgress.baseId, baseId));
    for (const r of rows) out[r.hero as HeroKey] = {
      level: clampLevel(r.level), recoveryUntil: r.recoveryUntil,
    };
  } else {
    const rows = await db.select().from(heroLevels).where(eq(heroLevels.playerWallet, wallet));
    for (const r of rows) out[r.hero as HeroKey] = {
      level: clampLevel(r.level), recoveryUntil: r.recoveryUntil,
    };
  }
  return out;
}

/** Raid snapshot helper: the deed is the complete hero-state authority. */
export async function baseHeroRaidState(
  db: DbOrTx,
  baseId: string,
  now = new Date(),
): Promise<{
  heroes: HeroKey[];
  heroLevels: Record<HeroKey, number>;
  placements: RecruitedHeroPlacement[];
}> {
  const placements = await recruitedHeroPlacementsOf(db, '', now, baseId);
  const states = await heroStatesOf(db, '', baseId);
  return {
    heroes: placements.filter((hero) => hero.available).map((hero) => hero.hero),
    heroLevels: Object.fromEntries(HERO_KEYS.map((hero) => [hero, states[hero].level])) as Record<HeroKey, number>,
    placements,
  };
}

/** Submit-time recovery check for a deed's frozen hero deploys. */
export async function recoveringBaseHeroes(
  db: DbOrTx,
  baseId: string,
  heroes: readonly HeroKey[],
  now = new Date(),
): Promise<HeroKey[]> {
  if (heroes.length === 0) return [];
  const rows = await db.select({ hero: baseHeroProgress.hero }).from(baseHeroProgress)
    .where(and(
      eq(baseHeroProgress.baseId, baseId),
      inArray(baseHeroProgress.hero, [...heroes]),
      gt(baseHeroProgress.recoveryUntil, now),
    ));
  return rows.map((row) => row.hero as HeroKey);
}

export interface BaseHeroRecovery {
  hero: HeroKey;
  recoveryUntil: Date;
}

/** Resolution helper. Recovery follows base_id and therefore survives a sale. */
export async function applyBaseHeroRecoveries(
  db: DbOrTx,
  baseId: string,
  recoveries: readonly BaseHeroRecovery[],
  updatedAt = new Date(),
): Promise<void> {
  for (const recovery of recoveries) {
    await db.insert(baseHeroProgress).values({
      baseId,
      hero: recovery.hero,
      level: 1,
      recoveryUntil: recovery.recoveryUntil,
      updatedAt,
    }).onConflictDoUpdate({
      target: [baseHeroProgress.baseId, baseHeroProgress.hero],
      set: {
        recoveryUntil: sql`GREATEST(COALESCE(${baseHeroProgress.recoveryUntil}, '-infinity'::timestamptz), ${recovery.recoveryUntil.toISOString()}::timestamptz)`,
        updatedAt,
      },
    });
  }
}

export interface HeroView {
  hero: HeroKey;
  name: string;
  title: string;
  altar: string;
  /** Keep level that unlocks building the altar (the "how to unlock" line). */
  unlockKeepLevel: number;
  /** KEEP price charged at altar placement when no contract item is consumed
   *  (D-058, owner 2026-08-16). String — KEEP amounts are bigint on the wire. */
  recruitCostKeep: string;
  /** The tradeable hero-contract item altar placement consumes instead. */
  recruitItemId: string;
  recruited: boolean;
  level: number;
  tier: number;
  tierName: string;
  hp: number;
  dps: number;
  recoveryUntil: string | null;
  available: boolean;
  /** Gear-modified combat stats (D-059) — effective values plus the delta vs
   * hp/dps so the roster renders "HP 1400 +84" without client math. Null while
   * the combat rollout is dark or nothing is equipped, so the screen can never
   * imply an inactive bonus. */
  gear: { hp: number; dps: number; hpBonus: number; dpsBonus: number } | null;
  /** Exact server-priced KEEP finish for a currently recovering hero. */
  recoveryFinishNow: { remainingSec: number; costKeep: string; affordable: boolean } | null;
  maxLevel: number;
  /** Null at max level. Costs are strings — KEEP amounts are bigint on the wire. */
  next: { level: number; tier: number; tierName: string; hp: number; dps: number; costKeep: string } | null;
  /** Server-computed: the player can pay `next.costKeep` right now. */
  affordable: boolean;
}

/** Read model for the BUILD ▸ HEROES panel. Server-authoritative: the client
 *  displays these numbers rather than recomputing costs. */
export async function listHeroes(
  db: Db, wallet: string, now = new Date(), baseId?: string,
): Promise<{ heroes: HeroView[]; keepBalance: string; keepLevel: number; features: { heroConsent: { version: 1 }; heroReceipts: { version: 1 } } }> {
  // A forward client may send baseId during a rolling flag-off deployment; the
  // compatibility path must remain wallet-scoped until the server flips.
  const stableBaseId = multiBaseEnabled() ? baseId : undefined;
  // Legacy keeps the historical lazy completion. Stable reads are deliberately
  // non-mutating: /base completes exact-base jobs. Completing here after an
  // unlocked route precheck let a seller race a transfer and settle buyer jobs.
  if (!stableBaseId) await completeDueJobs(db, wallet, now);
  const selectedBase = stableBaseId
    ? await requireActiveStablePrerequisiteBase(db, wallet, stableBaseId)
    : undefined;
  const [recruited, levels, keepAccount, gemsAccount, playerRow] = await Promise.all([
    recruitedHeroesOf(db, wallet, stableBaseId),
    heroStatesOf(db, wallet, stableBaseId),
    getOrCreatePlayerAccount(db, wallet, 'player_keep'),
    gemsEnabled() ? getOrCreatePlayerAccount(db, wallet, 'player_gems') : null,
    db.select({ keepLevel: players.keepLevel }).from(players).where(eq(players.wallet, wallet)),
  ]);
  // D-152: the shim charges whichever single currency covers the price, so a
  // hero is affordable when EITHER balance does (never a split).
  const balance = keepAccount.balance;
  const gemsBalance = gemsAccount?.balance ?? 0n;
  const covers = (cost: bigint) => balance >= cost || gemsBalance >= cost;
  // D-059: the roster shows the gear bonus next to base HP/DPS while the combat
  // rollout is on. Same dynamic-import shape as the quests hook in upgradeHero —
  // items.ts statically imports listHeroes, so a static import here would cycle.
  const { resolveHeroLoadouts, applyBps } = await import('./items');
  const loadouts = heroGearCombatEnabled()
    ? await resolveHeroLoadouts(db, wallet, stableBaseId)
    : null;

  const heroes = HERO_KEYS.map((hero): HeroView => {
    const state = levels[hero];
    const level = state.level;
    const cost = heroUpgradeCost(hero, level);
    const hp = HERO_LEVELING.hp[hero][level - 1]!;
    const dps = HERO_LEVELING.dps[hero][level - 1]!;
    const loadout = loadouts?.[hero];
    const gear = loadout && loadout.itemIds.length > 0
      ? {
        hp: applyBps(hp, loadout.modifiers.hero_hp_bps),
        dps: applyBps(dps, loadout.modifiers.hero_damage_bps),
        hpBonus: applyBps(hp, loadout.modifiers.hero_hp_bps) - hp,
        dpsBonus: applyBps(dps, loadout.modifiers.hero_damage_bps) - dps,
      }
      : null;
    return {
      hero,
      name: HEROES[hero].name,
      title: HEROES[hero].title,
      altar: HEROES[hero].altar,
      unlockKeepLevel: HEROES[hero].unlockKeepLevel,
      recruitCostKeep: String(HEROES[hero].recruitCostKeep),
      recruitItemId: HEROES[hero].recruitItemId,
      recruited: recruited.has(hero),
      level,
      tier: heroTier(level),
      tierName: tierNameOf(hero, level),
      hp,
      dps,
      recoveryUntil: state.recoveryUntil?.toISOString() ?? null,
      available: state.recoveryUntil === null || state.recoveryUntil <= now,
      gear,
      recoveryFinishNow: state.recoveryUntil !== null && state.recoveryUntil > now
        ? (() => {
          const remainingSec = Math.max(1, Math.ceil((state.recoveryUntil!.getTime() - now.getTime()) / 1_000));
          const recoveryCost = BigInt(speedupCostKeep(remainingSec));
          return { remainingSec, costKeep: recoveryCost.toString(), affordable: covers(recoveryCost) };
        })()
        : null,
      maxLevel: HERO_LEVELING.maxLevel,
      next: cost === null ? null : {
        level: level + 1,
        tier: heroTier(level + 1),
        tierName: tierNameOf(hero, level + 1),
        hp: HERO_LEVELING.hp[hero][level]!,
        dps: HERO_LEVELING.dps[hero][level]!,
        costKeep: cost.toString(),
      },
      affordable: cost !== null && covers(cost),
    };
  });

  return {
    heroes,
    features: { heroConsent: { version: 1 }, heroReceipts: { version: 1 } },
    keepBalance: balance.toString(),
    keepLevel: selectedBase?.keepLevel ?? playerRow[0]?.keepLevel ?? 1,
  };
}

export interface HeroRecoverySpeedupResult {
  hero: HeroKey;
  spentKeep: string;
  duplicate: boolean;
  recoveryUntil: null;
}

/**
 * Finish one attacker recovery with the same shared super-linear KEEP curve as
 * builder jobs (owner 2026-08-14: "speed up recovery of heroes with KEEP tokens
 * just like buildings"). Authority, exact price, debit and recovery release are
 * one locked transaction; a retried intent returns success without another debit.
 */
export async function speedupHeroRecovery(
  db: Db, wallet: string, hero: HeroKey, idempotencyKey: string, now?: Date,
  baseContext?: StableBaseMutationContext, consent?: HeroRecoveryConsent,
): Promise<HeroRecoverySpeedupResult> {
  if (!(HERO_KEYS as readonly string[]).includes(hero)) throw new HttpError(404, `unknown hero: ${hero}`);
  const stableContext = multiBaseEnabled()
    ? requireStableBaseMutationContext(baseContext)
    : undefined;
  const ledgerKey = stableContext
    ? `herorecover:${wallet}:${stableContext.baseId}:${hero}:${idempotencyKey}`
    : `herorecover:${wallet}:${hero}:${idempotencyKey}`;

  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!locked) throw new HttpError(404, 'player not found');
    const selectedBase = stableContext
      ? await lockStablePrerequisiteBase(tx, wallet, stableContext)
      : undefined;

    const [row] = selectedBase
      ? await tx.select().from(baseHeroProgress).where(and(
        eq(baseHeroProgress.baseId, selectedBase.id), eq(baseHeroProgress.hero, hero),
      )).for('update')
      : await tx.select().from(heroLevels).where(and(
        eq(heroLevels.playerWallet, wallet), eq(heroLevels.hero, hero),
      )).for('update');
    // A dropped successful response is a read of the already-committed intent,
    // but only while that same completed episode is still the current state.
    // If a later battle started a NEW recovery, reusing the old key is a
    // collision—not a successful recovery of the new episode.
    const [prior] = await tx.select({ type: ledgerTransactions.type }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, ledgerKey));
    if (prior) {
      if (prior.type !== 'hero.recovery.speedup' || row?.recoveryUntil !== null
        || !await heroRecoveryEvidence(tx, wallet, hero, idempotencyKey, stableContext?.baseId)) {
        throw new HttpError(409, 'idempotency key collision');
      }
      if (consent) {
        const receipt = await getHeroRecoveryReceipt(tx, wallet, {
          hero, idempotencyKey, ...(stableContext ? { baseId: stableContext.baseId } : {}), ...consent,
        });
        if (receipt.status !== 'accepted') throw new HttpError(409, 'idempotency key collision');
      }
      return { hero, spentKeep: '0', duplicate: true, recoveryUntil: null };
    }
    assertHeroRecovery(row?.recoveryUntil, consent);
    // Production price time is sampled only AFTER the authority and recovery
    // locks. A request can wait behind another mutation long enough for the
    // hero to recover naturally; pricing from route-entry time would then take
    // KEEP for an already-ready hero. Explicit `now` is only the deterministic
    // test seam used throughout this module.
    const [clock] = now === undefined
      ? await tx.select({ now: sql<Date>`clock_timestamp()` }).from(players)
        .where(eq(players.wallet, wallet)).limit(1)
      : [];
    const pricedAt = now ?? new Date(clock!.now);
    if (!row?.recoveryUntil || row.recoveryUntil <= pricedAt) {
      throw new HttpError(409, `${HEROES[hero].name} is not recovering`, 'HERO_NOT_RECOVERING');
    }
    const remainingSec = Math.max(1, Math.ceil((row.recoveryUntil.getTime() - pricedAt.getTime()) / 1_000));
    const cost = BigInt(speedupCostKeep(remainingSec));
    assertHeroPrice(cost, consent?.maxCostKeep);
    const posted = await spendGameCurrency(tx, wallet, cost, 'hero.recovery.speedup', ledgerKey, {
      hero, remainingSec, recoveryUntil: row.recoveryUntil.toISOString(), ...(selectedBase ? { baseId: selectedBase.id } : {}),
    });
    if (posted.duplicate) return { hero, spentKeep: '0', duplicate: true, recoveryUntil: null };

    if (selectedBase) {
      await tx.update(baseHeroProgress).set({ recoveryUntil: null, updatedAt: pricedAt }).where(and(
        eq(baseHeroProgress.baseId, selectedBase.id), eq(baseHeroProgress.hero, hero),
      ));
    } else {
      await tx.update(heroLevels).set({ recoveryUntil: null, updatedAt: pricedAt }).where(and(
        eq(heroLevels.playerWallet, wallet), eq(heroLevels.hero, hero),
      ));
    }
    return { hero, spentKeep: cost.toString(), duplicate: false, recoveryUntil: null };
  });
}

export interface HeroUpgradeResult {
  hero: HeroKey;
  level: number;
  tier: number;
  tierName: string;
  hp: number;
  dps: number;
  /** KEEP actually debited by THIS call — "0" when the key was a replay. */
  spentKeep: string;
  /** True when the idempotency key had already been consumed (no new charge). */
  duplicate: boolean;
}

/**
 * Buy exactly one hero level. Rejections (all before any ledger movement):
 *   404 unknown hero · 422 not recruited · 422 already max level ·
 *   422 insufficient KEEP (raised by the ledger's non-negative player floor).
 *
 * Concurrency: the whole read-decide-charge-write runs inside one transaction
 * that first takes the player row FOR UPDATE — the codebase's per-wallet
 * serialization point (placeBuilding / createRaid / contributeToForge). The
 * hero row itself cannot be the lock: on a hero's FIRST upgrade there is no row
 * to lock yet, so two racing calls would both read "level 1", both price L1→2
 * and both upsert. With the player lock, the loser re-reads the committed level
 * AFTER the winner commits; because the key is namespaced per (wallet, hero,
 * client key), a genuine double-submit lands in the duplicate branch and buys
 * nothing, and a deliberate second request with a fresh key correctly buys the
 * NEXT level at the NEXT price.
 */
export async function upgradeHero(
  db: Db, wallet: string, hero: HeroKey, idempotencyKey: string, now = new Date(),
  baseContext?: StableBaseMutationContext, consent?: HeroUpgradeConsent,
): Promise<HeroUpgradeResult> {
  if (!(HERO_KEYS as readonly string[]).includes(hero)) throw new HttpError(404, `unknown hero: ${hero}`);
  const stableContext = multiBaseEnabled()
    ? requireStableBaseMutationContext(baseContext)
    : undefined;
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!locked) throw new HttpError(404, 'player not found');

    // The immutable paid level belongs to this key even after further upgrades
    // or altar removal. Resolve it before any mutable roster/level gate, without
    // replaying the effect or ticking its quest again.
    const ledgerKey = heroLedgerKey('upgrade', wallet, hero, idempotencyKey, stableContext?.baseId);
    const [prior] = await tx.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, ledgerKey));
    if (prior) {
      const evidence = await heroUpgradeEvidence(tx, wallet, hero, idempotencyKey, stableContext?.baseId);
      if (!evidence) throw new HttpError(409, 'idempotency key collision');
      assertHeroLevel(evidence.from, consent);
      assertHeroPrice(evidence.cost, consent?.maxCostKeep);
      return view(hero, evidence.to, '0', true);
    }
    const selectedBase = stableContext
      ? await lockStablePrerequisiteBase(tx, wallet, stableContext)
      : undefined;
    await completeDueJobs(tx, wallet, now, selectedBase?.id);

    const recruited = await recruitedHeroesOf(tx, wallet, selectedBase?.id);
    if (!recruited.has(hero)) {
      throw new HttpError(422, `recruit ${HEROES[hero].name} first — build the ${HEROES[hero].altar} (Keep level ${HEROES[hero].unlockKeepLevel})`, 'HERO_NOT_RECRUITED');
    }

    const [row] = selectedBase
      ? await tx.select().from(baseHeroProgress).where(and(
        eq(baseHeroProgress.baseId, selectedBase.id), eq(baseHeroProgress.hero, hero),
      ))
      : await tx.select().from(heroLevels)
        .where(and(eq(heroLevels.playerWallet, wallet), eq(heroLevels.hero, hero)));
    const current = clampLevel(row?.level ?? 1);
    assertHeroLevel(current, consent);
    const cost = heroUpgradeCost(hero, current);
    if (cost === null) throw new HttpError(422, `${HEROES[hero].name} is already at max level ${HERO_LEVELING.maxLevel}`);

    assertHeroPrice(cost, consent?.maxCostKeep);

    // Namespaced client key (security review 2026-07-24 #3): a raw client key
    // must never collide with another subsystem's key — and including `hero`
    // keeps one key usable for each hero independently.
    const posted = await spendGameCurrency(
      tx, wallet, cost, 'hero.upgrade',
      ledgerKey,
      { hero, from: current, to: current + 1, ...(selectedBase ? { baseId: selectedBase.id } : {}) },
    );
    // A duplicate post moved NO KEEP. The debit and the level bump commit in
    // this same transaction, so a consumed key PROVES the bump already happened
    // — bumping again here would hand out a free level.
    if (posted.duplicate) {
      return view(hero, current, '0', true);
    }
    const next = current + 1;
    if (selectedBase) {
      await tx.insert(baseHeroProgress)
        .values({ baseId: selectedBase.id, hero, level: next, updatedAt: now })
        .onConflictDoUpdate({
          target: [baseHeroProgress.baseId, baseHeroProgress.hero],
          set: { level: next, updatedAt: now },
        });
    } else {
      await tx.insert(heroLevels)
        .values({ playerWallet: wallet, hero, level: next, updatedAt: now })
        .onConflictDoUpdate({
          target: [heroLevels.playerWallet, heroLevels.hero],
          set: { level: next, updatedAt: now },
        });
    }
    // M23 a15: the level bump and the KEEP debit commit in this same tx; the
    // duplicate-post early-return above keeps a replayed key from re-ticking.
    const { progressQuestBatch } = await import('./quests');
    await progressQuestBatch(tx, wallet, [['upgrade_hero', 1]], now, selectedBase?.id);
    return view(hero, next, cost.toString(), false);
  });
}

function view(hero: HeroKey, level: number, spentKeep: string, duplicate: boolean): HeroUpgradeResult {
  return {
    hero,
    level,
    tier: heroTier(level),
    tierName: tierNameOf(hero, level),
    hp: HERO_LEVELING.hp[hero][level - 1]!,
    dps: HERO_LEVELING.dps[hero][level - 1]!,
    spentKeep,
    duplicate,
  };
}
