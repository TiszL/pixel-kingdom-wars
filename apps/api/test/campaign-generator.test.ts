import {
  BUILD_COUNT_CAP_BY_KEEP, BuildingType, CAMPAIGN, CAMPAIGN_LAYOUT, CAPS, HEROES,
  MINING, TROOPS, TROOP_TYPES, wallCapForKeepLevel,
  type DeployOrder, type TroopType,
} from '@shardkeep/shared';
import { simulateRaid } from '@shardkeep/sim';
import { describe, expect, it } from 'vitest';
import { footprintOf } from '../src/game/footprints';
import { makeCampaignSnapshot } from '../src/game/world';

/** A deliberately simple, reproducible counter-army a player can actually own:
 * one current-level Camp, current-level research, and only troops unlocked at
 * that Keep. Flying damage handles walls while the remainder fills the exact
 * odd capacity. This is a balance witness, not an AI-only infinite army. */
const COUNTER_PRIORITY = [
  'dragon', 'mage', 'giant', 'troll', 'turrider', 'kegrunner', 'bowman',
] as const satisfies readonly TroopType[];

function troopKeepRequirement(troop: TroopType): number {
  return (TROOPS[troop] as { requiresKeepLevel?: number }).requiresKeepLevel ?? 1;
}

function armyOfPoints(keep: number, points: number): TroopType[] {
  const army: TroopType[] = [];
  for (const troop of COUNTER_PRIORITY) {
    const spec = TROOPS[troop];
    if (keep < troopKeepRequirement(troop)) continue;
    while (points >= spec.pts) {
      army.push(troop);
      points -= spec.pts;
    }
  }
  expect(points, `Keep ${keep} witness army must fill its points exactly`).toBe(0);
  return army;
}

function spreadCounterArmy(stage: number, army: readonly TroopType[]): DeployOrder[] {
  const snapshot = makeCampaignSnapshot(stage);
  const min = snapshot.claimMin!;
  const max = snapshot.claimMax!;
  const span = max - min;
  return army.map((troop, i) => {
    const side = i % 4;
    const along = min + ((Math.floor(i / 4) * 2 + 1) % span);
    if (side === 0) return { troop, tx: min - 1, ty: along, tMs: 0 };
    if (side === 1) return { troop, tx: max, ty: along, tMs: 0 };
    if (side === 2) return { troop, tx: along, ty: min - 1, tMs: 0 };
    return { troop, tx: along, ty: max, tMs: 0 };
  });
}

function troopLevelsAt(level: number): Partial<Record<TroopType, number>> {
  return Object.fromEntries(
    TROOP_TYPES.map((troop) => [troop, Math.max(1, level)]),
  ) as Partial<Record<TroopType, number>>;
}

const SEEDS = [1, 42, 0xffff_ffff] as const;

/** M23 a2 band shape (owner 2026-08-15: 100 stages = 5 per Keep band × 20
 * keeps, 10 acts of 10). Two OUTPOSTs ease into a band, two BREACHes turn the
 * screw, the FORTRESS caps it. */
const BAND_PROFILES = ['OUTPOST', 'OUTPOST', 'BREACH', 'BREACH', 'FORTRESS'] as const;

/** Every defense a campaign row may author, including the M22 air-defence. */
const CAMPAIGN_DEFENSE_BUILDINGS = [
  BuildingType.Cannon, BuildingType.ArcherTower, BuildingType.Mortar,
  BuildingType.AirDefence, BuildingType.ElectricTower, BuildingType.MageTower,
  BuildingType.LaserTower, BuildingType.DragonNest,
] as const;

const TRAP_BUILDINGS = [
  BuildingType.SpikeTrap, BuildingType.PowderMine, BuildingType.Pitfall, BuildingType.AirMine,
] as const;

// --- The density formula the authored rows must satisfy (owner 2026-08-16:
// "better complex more challenging bases in campaign … use build counts as the
// ceiling"). Re-deriving the rows here is the point: a future editor cannot
// silently thin a stage without failing this file.
const bandPosition = (stage: number): number => (stage - 1) % CAMPAIGN.stagesPerKeep;
const numeratorsFor = (keep: number): readonly number[] =>
  keep >= CAMPAIGN_LAYOUT.lateFromKeep
    ? CAMPAIGN_LAYOUT.lateDensityNumeratorByBandPosition
    : CAMPAIGN_LAYOUT.densityNumeratorByBandPosition;
const lagFor = (keep: number): readonly number[] =>
  keep >= CAMPAIGN_LAYOUT.lateFromKeep
    ? CAMPAIGN_LAYOUT.lateDefenseLevelLagByBandPosition
    : CAMPAIGN_LAYOUT.defenseLevelLagByBandPosition;
const defenseShare = (cap: number, keep: number, p: number): number =>
  Math.ceil((cap * numeratorsFor(keep)[p]!) / CAMPAIGN_LAYOUT.densityDenominator);
/** Mines round DOWN (min 1): they are skirt fodder outside the walls, and the
 * ceil-rounded extra mine was exactly what pushed the fresh-player stage-1 win
 * past the 90-second clock (world.test.ts pins that win). */
const mineShare = (keep: number, p: number): number =>
  Math.max(1, Math.floor(
    (MINING.MAX_MINES_BY_KEEP[keep - 1]! * numeratorsFor(keep)[p]!)
    / CAMPAIGN_LAYOUT.densityDenominator,
  ));

describe('100-stage campaign catalog', () => {
  it('is an explicit hundred-entry catalog with unique identity and gameplay signatures', () => {
    expect(CAMPAIGN.totalStages).toBe(100);
    expect(CAMPAIGN.stagesPerAct).toBe(10);
    expect(CAMPAIGN.stagesPerKeep).toBe(5);
    expect(CAMPAIGN.actNames).toHaveLength(10);
    expect(CAMPAIGN.encounters).toHaveLength(CAMPAIGN.totalStages);
    expect(new Set(CAMPAIGN.encounters.map((e) => e.name)).size).toBe(CAMPAIGN.totalStages);
    const signatures = CAMPAIGN.encounters.map((e) => JSON.stringify({
      keep: e.keepLevel, level: e.defenseLevel, formation: e.formation,
      profile: e.profile, rings: e.wallRings, traps: e.traps, mines: e.mines,
      defenses: e.defenses, hero: e.defenderHero ?? null,
    }));
    expect(new Set(signatures).size).toBe(CAMPAIGN.totalStages);
    const realizedLayouts = CAMPAIGN.encounters.map((encounter) => {
      const snapshot = makeCampaignSnapshot(encounter.stage);
      return JSON.stringify({
        buildings: snapshot.buildings.map(({ type, level, tx, ty }) => ({ type, level, tx, ty })),
        heroes: snapshot.defenderHeroes ?? [],
      });
    });
    expect(new Set(realizedLayouts).size).toBe(CAMPAIGN.totalStages);
    for (let i = 0; i < CAMPAIGN.encounters.length; i++) {
      const encounter = CAMPAIGN.encounters[i]!;
      expect(encounter.stage).toBe(i + 1);
      // The M23 a2 mapping: five stages exercise each Keep band.
      expect(encounter.keepLevel).toBe(Math.floor(i / CAMPAIGN.stagesPerKeep) + 1);
      expect(encounter.c).toBeGreaterThanOrEqual(0);
      expect(encounter.c).toBeLessThan(12);
      expect(encounter.r).toBeGreaterThanOrEqual(0);
      expect(encounter.r).toBeLessThan(22);
    }

    // WHY: an authored name is not enough to make a distinct fight. Within
    // every Keep band the OUTPOST,OUTPOST,BREACH,BREACH,FORTRESS ramp becomes
    // structurally harder even when a breach happens to produce a faster clear
    // for one particular army/seed.
    for (let keep = 1; keep <= 20; keep++) {
      const band = CAMPAIGN.encounters.slice(
        (keep - 1) * CAMPAIGN.stagesPerKeep, keep * CAMPAIGN.stagesPerKeep,
      );
      expect(band.map((e) => e.profile)).toEqual([...BAND_PROFILES]);
      for (let i = 1; i < band.length; i++) {
        const previous = band[i - 1]!;
        const current = band[i]!;
        const defenseCount = (e: typeof current): number =>
          Object.values(e.defenses).reduce((sum, count) => sum + (count ?? 0), 0);
        expect(current.defenseLevel).toBeGreaterThanOrEqual(previous.defenseLevel);
        expect(current.wallRings).toBeGreaterThanOrEqual(previous.wallRings);
        expect(current.traps).toBeGreaterThanOrEqual(previous.traps);
        expect(defenseCount(current)).toBeGreaterThanOrEqual(defenseCount(previous));
      }
    }
  });

  it('authors the dense-redesign density contract, so no stage can silently go sparse again', () => {
    // Owner 2026-08-16, after the stage-62 screenshot showed a thin unwalled
    // cluster: every stage fields its band-position share of EVERY defense,
    // trap and mine cap its Keep has unlocked, with the player build-count
    // caps as the ceiling. The FORTRESS exam (position 5) sits AT the caps.
    for (const e of CAMPAIGN.encounters) {
      const keep = e.keepLevel;
      const p = bandPosition(e.stage);
      if (e.stage === 1) {
        // The ONE authored exception: the tutorial opener drops its archer so
        // a fresh player's first four L1 turriders clear it with seed margin
        // (world.test.ts pins that win). Its tactic is literally the lane.
        expect(e.defenses).toEqual({ cannon: 1 });
      } else {
        for (const type of CAMPAIGN_DEFENSE_BUILDINGS) {
          const cap = BUILD_COUNT_CAP_BY_KEEP[type]![keep - 1]!;
          const expected = defenseShare(cap, keep, p);
          expect(e.defenses[type as keyof typeof e.defenses] ?? 0,
            `stage ${e.stage} ${type}`).toBe(expected);
        }
      }
      expect(e.traps, `stage ${e.stage} traps`)
        .toBe(defenseShare(CAPS.trapsByKeepLevel[keep - 1]!, keep, p));
      expect(e.mines, `stage ${e.stage} mines`).toBe(mineShare(keep, p));
      expect(e.defenseLevel, `stage ${e.stage} defenseLevel`)
        .toBe(Math.max(1, keep - lagFor(keep)[p]!));
      expect(e.wallRings, `stage ${e.stage} wallRings`)
        .toBe(CAMPAIGN_LAYOUT.wallRingsByKeep[keep - 1]);
    }
  });

  it('garrisons heroes on every boss finale and on late-act mini-bosses', () => {
    for (let act = 1; act <= 10; act++) {
      const first = (act - 1) * CAMPAIGN.stagesPerAct;
      const mid = CAMPAIGN.encounters[first + 4]!;
      expect(mid.threat).toBe('mini_boss');
      const finale = CAMPAIGN.encounters[first + 9]!;
      expect(finale.threat).toBe('boss');
      expect(finale.defenderHero).toBeDefined();
      // Bosses alternate the two heroes so both stay showcased across the tour;
      // hero level scales with the Keep band (keep − bossHeroLag, floored at 1).
      expect(finale.defenderHero!.hero).toBe(act % 2 === 1 ? 'vex' : 'theodor');
      expect(finale.defenderHero!.level)
        .toBe(Math.max(1, finale.keepLevel - CAMPAIGN_LAYOUT.bossHeroLag));
      expect(finale.defenderHero!.level).toBeLessThanOrEqual(HEROES[finale.defenderHero!.hero].maxLevel);
      // Dense-redesign rule: from miniBossHeroFromKeep the act midpoint fields
      // the act's OFF hero too — late acts are hero-garrisoned twice, which is
      // part of the anti-air answer a pure-dragon army has to face.
      if (mid.keepLevel >= CAMPAIGN_LAYOUT.miniBossHeroFromKeep) {
        expect(mid.defenderHero).toBeDefined();
        expect(mid.defenderHero!.hero).toBe(act % 2 === 1 ? 'theodor' : 'vex');
        expect(mid.defenderHero!.level)
          .toBe(Math.max(1, mid.keepLevel - CAMPAIGN_LAYOUT.miniBossHeroLag));
      } else {
        expect(mid.defenderHero).toBeUndefined();
      }
      const snapshot = makeCampaignSnapshot(finale.stage);
      expect(snapshot.defenderHeroes).toContainEqual(expect.objectContaining({
        hero: finale.defenderHero!.hero, level: finale.defenderHero!.level,
      }));
    }
    const bosses = CAMPAIGN.encounters.filter((e) => e.threat === 'boss');
    const miniBosses = CAMPAIGN.encounters.filter((e) => e.threat === 'mini_boss');
    expect(bosses).toHaveLength(10);
    expect(miniBosses).toHaveLength(10);
    // No hero outside the authored cadence.
    const heroed = CAMPAIGN.encounters.filter((e) => e.defenderHero);
    expect(heroed.every((e) => e.threat !== 'standard')).toBe(true);
  });

  it('maps the five-stage band to every Keep and realizes legal designed layouts', () => {
    // Builders are purchased base capacity and transient worker actors. There is
    // deliberately no fake destructible "builder hut" in the shared schema.
    expect(Object.values(BuildingType)).not.toContain('builderhut');
    for (let stage = 1; stage <= CAMPAIGN.totalStages; stage++) {
      const encounter = CAMPAIGN.encounters[stage - 1]!;
      // keepLevel comes from the AUTHORED row — the reward settlement reads the
      // same field, so this is the one mapping the whole game agrees on.
      const keep = encounter.keepLevel;
      const snapshot = makeCampaignSnapshot(stage);
      const claimMin = snapshot.claimMin!;
      const claimMax = snapshot.claimMax!;
      expect(snapshot.keepLevel).toBe(keep);
      expect(claimMax - claimMin).toBe(CAMPAIGN.claimTilesByKeep[keep - 1]);
      const occupied = new Set<string>();
      const counts = new Map<string, number>();
      for (const building of snapshot.buildings) {
        const { fw, fh } = footprintOf(building.type);
        expect(building.tx).toBeGreaterThanOrEqual(claimMin);
        expect(building.ty).toBeGreaterThanOrEqual(claimMin);
        expect(building.tx + fw).toBeLessThanOrEqual(claimMax);
        expect(building.ty + fh).toBeLessThanOrEqual(claimMax);
        for (let y = building.ty; y < building.ty + fh; y++) {
          for (let x = building.tx; x < building.tx + fw; x++) {
            const key = `${x},${y}`;
            expect(occupied.has(key), `stage ${stage} overlap at ${key}`).toBe(false);
            occupied.add(key);
          }
        }
        counts.set(building.type, (counts.get(building.type) ?? 0) + 1);
      }
      // Realized counts match the authored roster EXACTLY, and the roster in
      // turn matches the density formula (previous test) — so the placer can
      // never quietly drop a tower it failed to fit.
      for (const type of CAMPAIGN_DEFENSE_BUILDINGS) {
        const authored = encounter.defenses[type as keyof typeof encounter.defenses] ?? 0;
        expect(counts.get(type) ?? 0, `stage ${stage} ${type}`).toBe(authored);
        expect(authored).toBeLessThanOrEqual(BUILD_COUNT_CAP_BY_KEEP[type]![keep - 1]!);
      }
      const trapCount = TRAP_BUILDINGS
        .reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
      expect(trapCount, `stage ${stage} traps`).toBe(encounter.traps);
      expect(trapCount).toBeLessThanOrEqual(CAPS.trapsByKeepLevel[keep - 1]!);
      const isFortress = stage % CAMPAIGN.stagesPerKeep === 0;
      if (isFortress) {
        // A FORTRESS is the band's exam: it fields EVERY defense its Keep has
        // unlocked at the FULL player build cap — including the M22 air-defence,
        // which is what keeps an all-air counter-army honest from Keep 7 on —
        // and its aggregate trap budget sits at the Keep's cap.
        for (const type of CAMPAIGN_DEFENSE_BUILDINGS) {
          expect(counts.get(type) ?? 0, `stage ${stage} FORTRESS ${type}`)
            .toBe(BUILD_COUNT_CAP_BY_KEEP[type]![keep - 1]!);
        }
        expect(trapCount).toBe(CAPS.trapsByKeepLevel[keep - 1]!);
      }

      // WHY: campaign targets should read as ordinary bases, not sterile combat
      // fixtures. Each encounter carries every real support slot unlocked by its
      // Keep, derived from the same caps enforced for player placement — plus
      // the full Vault complement guarding its compartments.
      for (const type of [
        BuildingType.Barracks, BuildingType.Camp, BuildingType.Forge, BuildingType.GoldForge,
      ]) {
        const expected = BUILD_COUNT_CAP_BY_KEEP[type]![keep - 1]!;
        expect(counts.get(type) ?? 0, `stage ${stage} ${type} support count`).toBe(expected);
        for (const building of snapshot.buildings.filter((b) => b.type === type)) {
          expect(building.level).toBe(encounter.defenseLevel);
          expect(building.level).toBeLessThanOrEqual(keep);
        }
      }
      expect(counts.get(BuildingType.Vault) ?? 0, `stage ${stage} vaults`)
        .toBe(BUILD_COUNT_CAP_BY_KEEP['vault']![keep - 1]!);
      expect(counts.get(BuildingType.Mine) ?? 0, `stage ${stage} mines`).toBe(encounter.mines);
      expect(encounter.mines).toBeLessThanOrEqual(MINING.MAX_MINES_BY_KEEP[keep - 1]!);

      // Walls: never over the player cap, and a walled stage commits real wall
      // mass — the anti-"thin ring" floor. A single-ring Keep is floored by its
      // own sealed perimeter geometry (a stockade cannot spend more tiles than
      // its ring has); compartmented Keeps must spend at least half the cap.
      const walls = counts.get(BuildingType.Wall) ?? 0;
      expect(walls).toBeLessThanOrEqual(wallCapForKeepLevel(keep));
      if (encounter.wallRings >= 2) {
        expect(walls, `stage ${stage} wall floor`)
          .toBeGreaterThanOrEqual(Math.floor(wallCapForKeepLevel(keep) / 2));
      } else if (encounter.wallRings === 1) {
        const S = claimMax - claimMin;
        const sealedRing = 4 * (S - 2 * CAMPAIGN_LAYOUT.outerWallInset - 1);
        expect(walls, `stage ${stage} wall floor`)
          .toBeGreaterThanOrEqual(Math.floor((sealedRing * 3) / 5));
      }

      // A defending hero's recruitment building is part of the target base
      // (D-030). Campaign-only latitude: act-1's boss keeps a Vex altar at Keep
      // 2 even though players unlock it at Keep 3 — the fight needs its hero.
      const vexAltars = counts.get(BuildingType.HeroAltar) ?? 0;
      const theodorStools = counts.get(BuildingType.SiegeStool) ?? 0;
      expect(vexAltars).toBe(encounter.defenderHero?.hero === 'vex' ? 1 : 0);
      expect(theodorStools).toBe(encounter.defenderHero?.hero === 'theodor' ? 1 : 0);
    }
  });

  it('is deterministic and realizes the sealed/gated/stockade wall contracts by profile', () => {
    expect(makeCampaignSnapshot(100)).toEqual(makeCampaignSnapshot(100));
    const m = CAMPAIGN_LAYOUT.outerWallInset;
    for (let stage = 1; stage <= CAMPAIGN.totalStages; stage++) {
      const e = CAMPAIGN.encounters[stage - 1]!;
      if (e.wallRings < 1) continue; // Keep 1 stays an open camp
      const snapshot = makeCampaignSnapshot(stage);
      const A = snapshot.claimMin!;
      const B = snapshot.claimMax!;
      const wallCells = new Set(snapshot.buildings
        .filter((b) => b.type === BuildingType.Wall)
        .map((b) => `${b.tx},${b.ty}`));
      const a = A + m, b = B - 1 - m;
      const ring: Array<[number, number]> = [];
      for (let x = a; x <= b; x++) ring.push([x, a], [x, b]);
      for (let y = a + 1; y < b; y++) ring.push([a, y], [b, y]);
      const missing = ring.filter(([x, y]) => !wallCells.has(`${x},${y}`));
      if (e.profile === 'FORTRESS') {
        // Sealed: the exam ring has no free tile.
        expect(missing, `stage ${stage} FORTRESS must be sealed`).toHaveLength(0);
      } else if (e.profile === 'BREACH') {
        // One designed gate, exactly breachGateTiles wide, feeding the funnel.
        expect(missing, `stage ${stage} BREACH gate`)
          .toHaveLength(CAMPAIGN_LAYOUT.breachGateTiles);
      } else {
        // OUTPOST: a stockade with periodic entrances (roughly every Nth tile).
        const expected = Math.floor(ring.length / CAMPAIGN_LAYOUT.outpostGapEvery);
        expect(missing.length, `stage ${stage} OUTPOST stockade gaps`)
          .toBeGreaterThanOrEqual(expected - 2);
        expect(missing.length).toBeLessThanOrEqual(expected + 2);
      }
    }
  });

  it('pays first-clear rewards by the authored Keep band — stages 1-18 under the 100-stage mapping', () => {
    // M23 a2 NEW RULE (supersedes the 60-stage pin): the reward for a stage is
    // firstThreeStarShardsByKeep[the AUTHORED row's keepLevel − 1]. Stretching
    // each Keep band from 3 to 5 stages deliberately re-prices early stages —
    // stage 18 was Keep-6 money (3,000) and is now Keep-4 money (1,200). That
    // is intentional: rewards follow the difficulty band the player actually
    // fights, and already-claimed first-clear payouts are per-stage flags the
    // migration never revisits, so no live player is paid twice or clawed back.
    const rewards = Array.from({ length: 18 }, (_, i) =>
      CAMPAIGN.firstThreeStarShardsByKeep[CAMPAIGN.encounters[i]!.keepLevel - 1]!);
    expect(rewards).toEqual([
      ...Array<number>(5).fill(400),   // stages 1-5   → Keep 1
      ...Array<number>(5).fill(400),   // stages 6-10  → Keep 2
      ...Array<number>(5).fill(1_200), // stages 11-15 → Keep 3
      ...Array<number>(3).fill(1_200), // stages 16-18 → Keep 4
    ]);
    // The full tour still ends at Keep-20 money.
    expect(CAMPAIGN.firstThreeStarShardsByKeep[CAMPAIGN.encounters[99]!.keepLevel - 1])
      .toBe(10_000);
  });

  it('keeps every stage fully beatable: a legal same-Keep max army 3-stars all 100', () => {
    // The fairness floor under the dense redesign: first-3★ rewards stay
    // earnable at every stage by an army the stage's own Keep can field.
    // Keep the exhaustive stage/seed sweep; allow CPU headroom beyond the
    // shared 30-second test timeout on loaded CI runners.
    // 2026-09-19: 60 s was still too tight — the sweep takes ~11 s on a dev machine and crossed
    // 60 s on shared CI runners twice in one day (PR #104, PR #109), failing releases whose diff was a
    // version string. The time cap is not the rule this test protects; every stage and seed still runs.
    for (let stage = 1; stage <= CAMPAIGN.totalStages; stage++) {
      const keep = CAMPAIGN.encounters[stage - 1]!.keepLevel;
      const army = armyOfPoints(keep, CAMPAIGN.maxArmyPointsByKeep[keep - 1]!);
      const deploys = spreadCounterArmy(stage, army);
      for (const seed of SEEDS) {
        const outcome = simulateRaid(
          makeCampaignSnapshot(stage), { deploys }, seed, { troopLevels: troopLevelsAt(keep) },
        );
        expect(outcome.stars, `legal max stage ${stage}, seed ${seed}`).toBe(3);
        expect(outcome.destructionPct, `legal max stage ${stage}, seed ${seed}`).toBe(100);
      }
    }
  }, 240_000);

  it('holds the recommended-army star floors for every band position', () => {
    // The band's difficulty CONTRACT under the dense redesign, measured with a
    // one-Camp recommended army at K−1 research: the early tour keeps the old
    // OUTPOST-full-clear promise; from Keep 12 the wide dense claims plus the
    // D-060 anti-air rework turn the 90-second clock into a real opponent and
    // every position still promises a WIN (≥2★), with the FORTRESS exam
    // promising the Keep (≥1★). RETUNED 2026-08-16 (D-060/SIM11): the
    // full-clear band ended at Keep 12 under SIM10; the Keep-12 rows field the
    // first PAIR of air-defence batteries, and at their new 110 dps the
    // dragon-led witness legitimately loses its outpost full-clear one keep
    // earlier (56/57 measured 2★). The WIN promise is intact on all 100.
    // Like the max-army proof above, this runs all 100 stages × 3 seeds.
    // Keep every case and allow the same bounded CPU headroom on loaded CI.
    for (let keep = 1; keep <= 20; keep++) {
      const army = armyOfPoints(keep, CAMPAIGN.recommendedArmyPointsByKeep[keep - 1]!);
      const floors = keep <= 11 ? [3, 3, 2, 2, 1] : [2, 2, 2, 2, 1];
      for (let position = 0; position < CAMPAIGN.stagesPerKeep; position++) {
        const stage = (keep - 1) * CAMPAIGN.stagesPerKeep + position + 1;
        const deploys = spreadCounterArmy(stage, army);
        for (const seed of SEEDS) {
          const outcome = simulateRaid(
            makeCampaignSnapshot(stage), { deploys }, seed,
            { troopLevels: troopLevelsAt(keep - 1) },
          );
          expect(outcome.stars, `recommended stage ${stage}, seed ${seed}`)
            .toBeGreaterThanOrEqual(floors[position]!);
        }
      }
    }
  }, 240_000);

  it('stays hard: half the recommended army cannot 3-star the late campaign', () => {
    // The anti-triviality proof the owner's complaint demanded (2026-08-16 "100
    // rubbish easy battles"): from Keep 12 (stage 56) a HALF-strength
    // recommended army — every other troop, same K−1 research — must fail to
    // full-clear inside the 90-second battle. Measured on the tuned catalog
    // under SIM10, stages 60, 62 and 77 fell to the half witness; under the
    // SIM11/D-060 anti-air rework NONE do. The pinned bound stays ≤3 so a
    // future layout thinning still fails loudly: dozens of late stages would
    // flip to 3★ here and explode this count.
    const halfThreeStarred: number[] = [];
    for (let stage = 56; stage <= CAMPAIGN.totalStages; stage++) {
      const keep = CAMPAIGN.encounters[stage - 1]!.keepLevel;
      const full = armyOfPoints(keep, CAMPAIGN.recommendedArmyPointsByKeep[keep - 1]!);
      const half = full.filter((_, i) => i % 2 === 0);
      const deploys = spreadCounterArmy(stage, half);
      let best = 0;
      for (const seed of SEEDS) {
        const outcome = simulateRaid(
          makeCampaignSnapshot(stage), { deploys }, seed,
          { troopLevels: troopLevelsAt(keep - 1) },
        );
        best = Math.max(best, outcome.stars);
      }
      if (best >= 3) halfThreeStarred.push(stage);
    }
    expect(halfThreeStarred.length, `half-army 3★ stages: ${halfThreeStarred.join(',')}`)
      .toBeLessThanOrEqual(3);
    // The last act (stages 91-100) never falls to a half army.
    expect(halfThreeStarred.filter((stage) => stage >= 91)).toHaveLength(0);
  });

  it('K-030 is closed: an all-dragon army cannot 3-star any breach or fortress exam from Keep 12', () => {
    // The dominant-strategy regression pin (owner 2026-08-16: "fix it, also …
    // dragons should be attacked by heroes, by archers, air defence …, by
    // tesla tower and by mage tower too" → D-060/SIM11). Under SIM10 a
    // pure-dragon army — even at HALF the max points — 3-starred EVERY fortress
    // 5..100 while the tower it was dismantling fired zero shots (K-030).
    // The witness here is all-in on dragons at the same recommended budget and
    // K−1 research the difficulty floors use, so this is a strict same-budget
    // dominance statement: from the Keep-12 air-defence pair onward, the
    // screw-turn and exam stages deny the all-air composition its full clear
    // (best over the suite seeds ≤ 2★), while the floors above prove the
    // MIXED recommended witness still meets every promised star floor.
    for (let keep = 12; keep <= 20; keep++) {
      const pts = CAMPAIGN.recommendedArmyPointsByKeep[keep - 1]!;
      const dragons = Array<TroopType>(Math.floor(pts / TROOPS.dragon.pts)).fill('dragon');
      for (const position of [3, 4]) { // BREACH screw-turn + FORTRESS exam
        const stage = (keep - 1) * CAMPAIGN.stagesPerKeep + position + 1;
        const deploys = spreadCounterArmy(stage, dragons);
        let best = 0;
        for (const seed of SEEDS) {
          const outcome = simulateRaid(
            makeCampaignSnapshot(stage), { deploys }, seed,
            { troopLevels: troopLevelsAt(keep - 1) },
          );
          best = Math.max(best, outcome.stars);
        }
        expect(best, `all-dragon army at stage ${stage}`).toBeLessThanOrEqual(2);
      }
    }
  });
});
