/**
 * The Keep-dominance rule extended from BUILDINGS to ACTORS, pinned against the
 * published world fits.
 *
 * Owner 2026-08-30, playing their own base: "troops are very big". The rule
 * `packages/shared/src/buildingFit.test.ts` already enforces for structures —
 * THE KEEP IS THE VISUALLY DOMINANT THING ON A BASE — was being broken by the
 * troops, for the identical reason it had been broken by the two v2 towers a
 * few hours earlier: every WARE family publishes a world fit, the v2 pack
 * published none, so `v2TroopDrawScale` returned the raw @1x→@2x pack
 * conversion and every reworked unit drew at full authored size. Measured in
 * the running scene, a giant's body stood 138 world px on a base whose Keep is
 * 108 px at L1 and 154 px at L20 — and 210 px in a raid.
 *
 * WHY IT CAN BE CHECKED WITHOUT A BROWSER: a body's rendered size is
 * `publishedFit × authoredInk`, and every renderer applies the same fit, so a
 * comparison BETWEEN two families is decidable from the constants plus one
 * table of art measurements. The scene-dependent factors are constants too —
 * `AMBIENCE.garrisonScale` in the base view, `BATTLE_SCALE.troop` in a raid —
 * so both scenes can be checked, and the BATTLE is the binding one (0.8 > 0.66:
 * every troop is 1.21x larger there than on the base it was tuned against).
 *
 * WHY IT LIVES HERE and not beside `buildingFit.test.ts`: the lever it guards
 * is `v2TroopDrawScale` in this directory, and this file must be able to fail
 * when either the fit table OR that composition changes.
 *
 * INK is the opaque bounding box of a family's body in authored pack px,
 * measured off the shipped atlas across EVERY row and EVERY frame of its stand
 * and move clips at all four art tiers — i.e. the largest the base view or a
 * raid can ever make it, not one lucky south-facing still. ⚠ These are ART
 * FACTS: if the pack is re-authored they must be re-measured and every fit in
 * `ART_V2.troopSourceScale` re-derived.
 */
import {
  ACTOR_WORLD_SCALE, AMBIENCE, ART_V2, BATTLE_SCALE, WARE_WORLD_PRESENTATION,
} from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { V2_DRAW_SCALE } from './clips';
import { v2TroopDrawScale, V2_TROOP_PROFILES } from './troop';

/** Keep opaque ink (w, h) in authored px at the first level of each art band. */
const KEEP_INK: Record<number, readonly [number, number]> = {
  1: [81, 86], 6: [90, 91], 11: [97, 106], 16: [109, 115],
};
/** The Keep at its maximum, for the "even a fully upgraded base" case. */
const KEEP_INK_L20: readonly [number, number] = [117, 123];

/** Troop body ink (w, h) in authored pack px — the max over every tier. */
const TROOP_INK: Record<string, readonly [number, number]> = {
  highlander: [70, 77],
  bowman: [53, 82],
  kegrunner: [78, 84],
  tunneler: [81, 86],
  turrider: [81, 90],
  plunderer: [58, 69],
  giant: [98, 105],
  troll: [75, 82],
  dragon: [120, 81],
  mage: [68, 80],
  bilgewraith: [82, 84],
  gloamfang: [143, 118],
  direwyvern: [304, 208],
  hexbarrow: [98, 96],
  barrowling: [53, 51],
};

/**
 * Exempt on WIDTH — and only on width — are the families whose ink width is an
 * outstretched SPAN rather than upright bulk. A wingspan is not a footprint:
 * both dragons hover clear of the ground line with their wings out to either
 * side, and demanding they be narrower than a castle would shrink them below
 * the troll they are supposed to dwarf. Neither is a quadruped's nose-to-tail
 * LENGTH: measured off the shipped atlas the Gloamfang is 143×118 pack px, a
 * long low beast whose widest frame is a side-on prowl from snout to tail tip,
 * and its shoulder mass is a fraction of that. Gloamfang joined this set on
 * 2026-08-30 with the owner's ×1.5 — the identical argument the two fliers were
 * already admitted on, applied to the identical kind of measurement.
 *
 * HEIGHT is never exempt, because height is what stacks against the skyline.
 */
const SPAN_WIDTH = new Set(['dragon', 'direwyvern', 'gloamfang']);

/** World px per authored pack px, per scene. */
const BASE_VIEW = AMBIENCE.garrisonScale;
const BATTLE = BATTLE_SCALE.troop;
const keepWorld = ([w, h]: readonly [number, number]): readonly [number, number] => {
  const fit = WARE_WORLD_PRESENTATION.keep.sourceScale * V2_DRAW_SCALE;
  return [w * fit, h * fit];
};
const bodyWorld = (unit: string, scene: number): readonly [number, number] => {
  const [w, h] = TROOP_INK[unit]!;
  const s = v2TroopDrawScale(unit) * scene;
  return [w * s, h * s];
};

describe('actor world fit', () => {
  /**
   * The bug was not a wrong number, it was a MISSING one: `v2TroopDrawScale`
   * had nowhere to read a fit from, so it drew the raw pack conversion. A new
   * art root delivered tomorrow must fail here rather than ship at full size.
   */
  it('publishes a world fit for every troop root in the pack', () => {
    const fit: Record<string, number> = ART_V2.troopSourceScale;
    expect(Object.keys(fit).sort()).toEqual([...ART_V2.troops].sort());
    expect(Object.keys(V2_TROOP_PROFILES).sort()).toEqual([...ART_V2.troops].sort());
    for (const unit of ART_V2.troops) {
      expect(Object.prototype.hasOwnProperty.call(TROOP_INK, unit), `${unit} measured`)
        .toBe(true);
      // Every root was over-scale. A fit of 1 is the unfitted state, not a fit.
      expect(fit[unit], `${unit} fit`).toBeGreaterThan(0);
      expect(fit[unit], `${unit} fit`).toBeLessThan(1);
    }
  });

  /**
   * THE RULE, in the scene the owner states it in: ON THE BASE, nothing the
   * player fields reaches the Keep — and the SMALLEST Keep, so it holds from
   * the first minute of a new account. Asserted on BOTH axes, because the
   * Mortar — the report that started all of this — never out-grew the Keep in
   * height, it out-grew it in width.
   *
   * REWRITTEN 2026-08-30 (owner, second pass: "gloamfang ×1.5", "dragon up",
   * "direwyvern must end LARGER than dragon", "let NOTHING reach the Keep").
   * The first pass stated the rule in the BATTLE scene against the Keep at each
   * tier's band start, i.e. tier 1 against a level-1 Keep. That comparison has
   * a property nobody noticed while it was passing: the Keep it compares
   * against does not move with the unit, so for EVERY family it reduces to one
   * flat ceiling — 88.7 base-view world px — and the giant was already at 82 of
   * it. Three more rungs of ladder cannot be expressed in 6 px, so a rule that
   * cannot describe the roster the owner asked for is the wrong rule, not the
   * roster. The ceiling therefore moved to the base view, where the owner
   * stated it and where they play; the raid keeps its own guard below.
   *
   * SUPERSEDED 2026-08-30 (size contract, owner: "raids must hold the same
   * correspondence"). This comment used to end by conceding that in a raid the
   * apex bodies DO out-size a level-1 Keep, because troops were drawn 1.21×
   * larger there. They no longer are — ACTOR_WORLD_SCALE gives a family one
   * size in both scenes — so the base ceiling this test pins is now the ceiling
   * everywhere, and the raid guard below is the same rule rather than a weaker
   * one.
   */
  it('keeps every troop under the smallest Keep on the base view', () => {
    // The premise of "the SMALLEST Keep" is that L1 really is the binding case.
    // KEEP_INK is measured art, so check the measurement is monotonic across the
    // bands rather than assuming it: a mis-measured band would silently move
    // which Keep this rule is actually held against.
    const bands = [1, 6, 11, 16].map((level) => keepWorld(KEEP_INK[level]!)[1]);
    expect(bands).toEqual([...bands].sort((a, b) => a - b));
    expect(keepWorld(KEEP_INK_L20)[1]).toBeGreaterThan(bands.at(-1)!);

    const [kw, kh] = keepWorld(KEEP_INK[1]!);
    for (const unit of Object.keys(TROOP_INK)) {
      const [tw, th] = bodyWorld(unit, BASE_VIEW);
      expect(th, `${unit} height on the base`).toBeLessThan(kh);
      if (SPAN_WIDTH.has(unit)) continue;
      expect(tw, `${unit} width on the base`).toBeLessThan(kw);
    }
  });

  /**
   * A RAID IS THE SAME WORLD, AT THE SAME SCALE.
   *
   * REWRITTEN 2026-08-30 for the owner's "raids must hold the same
   * correspondence". This case used to open with `expect(BASE_VIEW)
   * .toBeLessThan(BATTLE)` and then prove that the raid's enlargement was at
   * least UNIFORM across troops — which it was, and which was never the
   * complaint. The complaint is that it was not uniform across FAMILIES: a
   * building carries no battle factor at all, so drawing troops 1.21× larger
   * in a raid moved every troop-to-building relationship the base view had been
   * tuned for, and that is why the ladder did not survive combat.
   *
   * So the assertion is now equality, and it is deliberately stated as one
   * about the CONSTANTS as well as about the bodies: BATTLE_SCALE is a view on
   * ACTOR_WORLD_SCALE, not a second opinion about it. Restoring a raid-only
   * multiplier means re-opening that decision in constants.ts with the owner,
   * not editing a number here.
   */
  it('draws every actor at the same size in a raid as on the base', () => {
    expect(BATTLE).toBe(BASE_VIEW);
    expect(BATTLE_SCALE.troop).toBe(ACTOR_WORLD_SCALE.troop);
    expect(BATTLE_SCALE.hero).toBe(ACTOR_WORLD_SCALE.hero);
    expect(AMBIENCE.garrisonScale).toBe(ACTOR_WORLD_SCALE.troop);
    expect(AMBIENCE.heroPatrolScale).toBe(ACTOR_WORLD_SCALE.hero);
    const units = Object.keys(TROOP_INK);
    const byHeight = (scene: number) => [...units]
      .sort((a, b) => bodyWorld(a, scene)[1] - bodyWorld(b, scene)[1]);
    expect(byHeight(BATTLE)).toEqual(byHeight(BASE_VIEW));
    for (const unit of units) {
      expect(bodyWorld(unit, BATTLE)[1], unit).toBe(bodyWorld(unit, BASE_VIEW)[1]);
    }
  });

  /**
   * A townsfolk is a person, not a soldier — and, until this contract, was
   * drawn 9% LARGER than the guard walking beside them, because
   * `AMBIENCE.villagerScale` (0.72) multiplied the SAME `v2TroopDrawScale`
   * product the garrison's 0.66 does. The intent was always the opposite; this
   * pins the intent rather than the factor.
   */
  it('draws a townsfolk smaller than the soldier beside them', () => {
    expect(AMBIENCE.villagerScale).toBe(ACTOR_WORLD_SCALE.villager);
    expect(AMBIENCE.villagerScale).toBeLessThan(ACTOR_WORLD_SCALE.troop);
    // Clearly a civilian, but still a person on the same ground: not a doll.
    const ratio = AMBIENCE.villagerScale / ACTOR_WORLD_SCALE.troop;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(0.95);
  });

  /**
   * THE HERO, in both scenes at once. `BATTLE_SCALE.hero` was 1.6 against a
   * base patrol of 1.05, so Theodor grew by half again on entering a raid and
   * measured 137.6×160 world px there — taller than a fully upgraded Keep
   * (146×154) and half again the height of a starter one. He is now one size,
   * and that size is the owner-tuned patrol number.
   */
  it('keeps the hero heroic and still under the Keep, in both scenes', () => {
    // Measured off the live `hero` @2x master, south walk pose: 86x100 px,
    // drawn 1:1 per world px at scale 1.
    const heroWorldH = 100 * ACTOR_WORLD_SCALE.hero;
    expect(heroWorldH).toBeLessThan(keepWorld(KEEP_INK[1]!)[1]);
    expect(heroWorldH).toBeLessThan(keepWorld(KEEP_INK_L20)[1]);
    // Still reads as a hero: clearly above the rank-and-file body.
    expect(heroWorldH / bodyWorld('highlander', BASE_VIEW)[1]).toBeGreaterThan(2);
  });

  /**
   * …and the other half of the owner's sentence, which a uniform shrink would
   * have silently thrown away: "keep the giant reading as a giant". The pack
   * authors him only 1.36x the rank-and-file's body; every art generation that
   * shipped before the rework put him at 2.2–2.4x, and that ladder is what the
   * per-unit fits restore. Ratios, not heights, so an owner retune of the whole
   * table keeps this honest.
   */
  it('keeps the roster size ladder legible', () => {
    const h = (unit: string): number => bodyWorld(unit, BASE_VIEW)[1];
    const rank = h('highlander');
    expect(h('giant') / rank, 'giant vs rank-and-file').toBeGreaterThan(1.8);
    expect(h('troll') / rank, 'troll vs rank-and-file').toBeGreaterThan(1.4);
    expect(h('turrider') / rank, 'mounted vs foot').toBeGreaterThan(1.3);
    expect(h('barrowling') / rank, 'brood minion vs a soldier').toBeLessThan(1);
    expect(h('direwyvern')).toBeGreaterThan(h('dragon')); // "much stronger than dragon"
    // A rank-and-file soldier is about half a tile — the genre bar, the pack's
    // own drawn barracks-yard soldier, and the shipped ladder all agree on it.
    expect(rank).toBeGreaterThan(64 * 0.4);
    expect(rank).toBeLessThan(64 * 0.75);
  });

  /**
   * THE APEX, ordered (owner 2026-08-30). Written as an ordering rather than as
   * four heights so an owner retune of the whole table keeps it honest, and
   * separately from the ladder above because this half is the request itself:
   * the Gloamfang went up by half, the Dragon went up, the Direwyvern stayed
   * above the Dragon, and every rung stays legibly apart.
   */
  it('orders the apex: giant < dragon < gloamfang < direwyvern', () => {
    const h = (unit: string): number => bodyWorld(unit, BASE_VIEW)[1];
    const w = (unit: string): number => bodyWorld(unit, BASE_VIEW)[0];
    expect(h('dragon')).toBeGreaterThan(h('giant'));
    expect(h('gloamfang')).toBeGreaterThan(h('dragon'));
    expect(h('direwyvern')).toBeGreaterThan(h('gloamfang'));
    // Each rung is separated enough to read as a rung and not as noise.
    for (const [big, small] of [['dragon', 'giant'], ['gloamfang', 'dragon'],
      ['direwyvern', 'gloamfang']] as const) {
      expect(h(big) - h(small), `${big} clears ${small}`).toBeGreaterThan(4);
    }
    // The Gloamfang out-tops the Dragon on its raised spines alone; the Dragon
    // still covers more of the screen, which is why a beast standing taller
    // than a dragon does not read as one outranking it.
    expect(h('gloamfang') * w('gloamfang'))
      .toBeLessThan(h('dragon') * w('dragon'));
    // The owner's ×1.5, pinned at the source: the Gloamfang's fit against the
    // 0.4 it was raised from.
    expect(ART_V2.troopSourceScale.gloamfang).toBeCloseTo(0.4 * 1.5, 10);
  });

  /**
   * Even at Keep L20, on a fully upgraded base, nothing the player fields is
   * the biggest thing on screen. This is the case the owner's screenshot was:
   * their own base, their own Keep, a giant standing taller than it.
   */
  it('never lets a troop out-size a fully upgraded Keep', () => {
    const [, kh] = keepWorld(KEEP_INK_L20);
    for (const unit of Object.keys(TROOP_INK)) {
      expect(bodyWorld(unit, BATTLE)[1], `${unit} vs Keep L20`).toBeLessThan(kh);
    }
  });

});
