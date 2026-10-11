/**
 * sprite() must resolve portraits from BOTH master roots — the frozen art/source/assets-v2/
 * AND "art/source/expanded-assets/characters/" (the new roster: dragon/giant/troll/mage/
 * bilgewraith). A single-root glob left the new portraits blank on the UI (owner
 * 2026-07-20). This encodes the fix so a regression to a single root fails loudly.
 * Runs through Vite (vitest), so import.meta.glob resolves exactly as at runtime.
 */
import { ART_V2, LEVELED_TROOPS, WARE_PORTRAIT_ART } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { ICONS, sprite, troopPortrait } from './icons';
import { versionedPublicAsset } from '../lib/version';

describe('sprite() resolves master SVGs from both asset roots', () => {
  it('resolves an assets-v2 (old roster) portrait', () => {
    expect(sprite('trp_highlander_portrait')).not.toBe('');
  });

  it('resolves the NEW-roster portraits (the fix) — none blank', () => {
    for (const key of ['dragon', 'giant', 'troll', 'mage', 'bilgewraith']) {
      expect(sprite(`trp_${key}_portrait`), `trp_${key}_portrait`).not.toBe('');
    }
  });

  it('routes all 76 WARE portraits to generated current-pack PNGs', () => {
    for (const key of Object.keys(WARE_PORTRAIT_ART)) {
      for (let tier = 1; tier <= 4; tier++) {
        const name = `ui_portrait_${key}_t${tier}`;
        expect(sprite(name), name).toBe(versionedPublicAsset(`/brand/ware/${name}.png`));
      }
    }
  });

  it('does not expose replaced building masters while retaining the authored current wall preview', () => {
    for (const key of ['bld_keep_l3', 'bld_vault_l5', 'bld_archertower_l1']) {
      expect(sprite(key), key).toBe('');
    }
    for (let tier = 1; tier <= 5; tier++) {
      expect(sprite(`wall5_t${tier}_straight_intact_f1`)).not.toBe('');
      expect(sprite(`wall5_t${tier}_straight_intact_f1`)).not.toContain('art/source/assets-v2');
      expect(sprite(`wall5_t${tier}_straight_intact_f1`)).not.toContain('art/source/buildings-rework');
      expect(sprite(`wall5_t${tier}_straight_intact_f1`)).toContain('art/source/walls-five-tier');
    }
    // Previous runtime keys must not resurrect immutable source masters.
    expect(sprite('bld_wall_straight_t1')).toBe('');
  });

  it('resolves all hero portrait bands from the approved game-v4 PNG masters', () => {
    // WHY: the React overlay does not sample Phaser atlases. Leaving the broad
    // assets-v3 glob in charge would make every wired card silently show the
    // superseded SVG even though the release overlay selected the right PNG.
    for (const key of [
      'hero_vex_portrait', 'hero_vex_portrait_t4',
      'hero_theo_portrait', 'hero_theo_portrait_t4',
    ]) {
      expect(sprite(key), key).toContain('art/game-v4/portraits/');
      expect(sprite(key), key).not.toContain('art/source/assets-v3');
    }
  });

  it('never exposes prior app-brand masters while retaining the current KEEP token mark', () => {
    for (const key of [
      'brand_app_icon', 'brand_emblem', 'brand_emblem_pulse_f1',
      'brand_logo_main', 'brand_logo_wordmark', 'brand_profile_pic',
    ]) {
      expect(sprite(key), key).toBe('');
    }
    expect(sprite('brand_token_logo')).not.toBe('');
    expect(sprite('brand_token_logo')).not.toContain('art/source/assets-v2');
  });

  it('uses the same approved civilian builder in the HUD and hiring portraits', () => {
    expect(ICONS.builder).toContain('art/source/builder-workman/south.png');
    expect(sprite('ui_builder_workman')).toBe(ICONS.builder);
    // The civilian replacement must not retire the actual Tunneler troop.
    expect(sprite(troopPortrait('tunneler', 20))).not.toBe('');
  });

  it('returns empty string for a genuinely missing sprite', () => {
    expect(sprite('trp_does_not_exist_zzz')).toBe('');
  });

  it('never resolves the retired Mortar body family while current portraits still resolve', () => {
    // D-039 keeps the owner masters as provenance only. If a future broad glob
    // exposes one again, React can flash the superseded tower during upgrades
    // even while Phaser is correctly using the exact-current fallback.
    for (let level = 1; level <= 20; level++) {
      for (const suffix of ['', '_work_f1', '_fire_f1', '_fire_f2']) {
        expect(sprite(`bld_mortar_l${level}${suffix}`)).toBe('');
      }
    }
    for (let tier = 1; tier <= 4; tier++) {
      expect(sprite(`ui_portrait_mortar_t${tier}`)).not.toBe('');
    }
  });

  // The batch-13 pack glob was narrowed to `bld_*` until a screen showed
  // per-level troop art; the army screens now do. These pins exist because the
  // narrowing regression is SILENT — sprite() returns '' and <Sprite> renders
  // an empty span, so a reverted glob ships blank dragon/giant cards without
  // failing any build.
  it('resolves the per-level dragon/giant portraits (batch-13 pack root)', () => {
    for (const troop of LEVELED_TROOPS) {
      for (const l of [1, 7, 20]) {
        expect(sprite(`trp_${troop}_l${l}_portrait`), `trp_${troop}_l${l}_portrait`).not.toBe('');
      }
    }
  });

  it('legacy masters may coexist in shared roots, but no runtime ART_V2 helper selects them', () => {
    for (const troop of LEVELED_TROOPS) {
      expect(sprite(`trp_${troop}_portrait`), `trp_${troop}_portrait`).not.toBe('');
      expect(troopPortrait(troop)).not.toBe(`trp_${troop}_portrait`);
    }
  });
});

// troopPortrait encodes the level RULE (see icons.ts): a real server level maps
// to its authored tier. ART_V2 generic/no-level paths use the current tier-1
// owner portrait as a visual baseline, not as a claim about player progression.
// Rework-v2 (locked owner decision 5, 2026-08-08): for giant/dragon the level
// now routes through artTierOfLevel — the 4 tier portraits REPLACE the 40
// per-level ones for exactly these units.
describe('troopPortrait() level keying', () => {
  it('routes a real level through the shared v2 tier map for giant/dragon', () => {
    // ceil(level/5): the deed renderer and the canvas key by the SAME helper,
    // so a portrait, a base sprite and a deed can never disagree on tier.
    expect(troopPortrait('dragon', 7)).toBe('ui_portrait_dragon_t2');
    expect(troopPortrait('giant', 1)).toBe('ui_portrait_giant_t1');
    expect(troopPortrait('giant', 5)).toBe('ui_portrait_giant_t1'); // tier edge: L5 is still t1
    expect(troopPortrait('giant', 6)).toBe('ui_portrait_giant_t2');
  });

  it('no level passed → current generic tier-1 art without inventing a player level', () => {
    expect(troopPortrait('dragon')).toBe('ui_portrait_dragon_t1');
    expect(troopPortrait('giant')).toBe('ui_portrait_giant_t1');
    expect(troopPortrait('highlander')).toBe('ui_portrait_highlander_t1');
  });

  it('routes the expanded troop roster through the same four art tiers', () => {
    expect(troopPortrait('highlander', 7)).toBe('ui_portrait_highlander_t2');
    expect(troopPortrait('bilgewraith', 20)).toBe('ui_portrait_bilgewraith_t4');
  });

  it('clamps to the shipped art range; non-finite uses the generic current portrait', () => {
    expect(troopPortrait('dragon', 99)).toBe('ui_portrait_dragon_t4'); // top tier, never a blank
    expect(troopPortrait('giant', 0)).toBe('ui_portrait_giant_t1');
    expect(troopPortrait('dragon', Number.NaN)).toBe('ui_portrait_dragon_t1');
  });

  it('every key troopPortrait can emit resolves to a real master (helper ↔ glob contract)', () => {
    for (const troop of LEVELED_TROOPS) {
      for (const l of [1, 7, 20]) {
        expect(sprite(troopPortrait(troop, l)), `${troop} l${l}`).not.toBe('');
      }
      expect(sprite(troopPortrait(troop)), `${troop} generic`).not.toBe('');
    }
  });

  it('reverse guard: every runtime ART_V2 portrait path stays out of legacy families', () => {
    for (const troop of ART_V2.troops) {
      for (const level of [undefined, Number.NaN, 1, 7, 20, 99]) {
        const key = troopPortrait(troop, level);
        expect(key, `${troop} @ ${String(level)}`)
          .toMatch(new RegExp(`^ui_portrait_${troop}_t[1-4]$`));
        expect(key, `${troop} @ ${String(level)}`).not.toMatch(/^trp_/);
        expect(sprite(key), key).not.toBe('');
      }
    }
  });

  it('routes the defender-only Wyrmling through current Hatchling portraits', () => {
    expect(troopPortrait('wyrmling')).toBe('ui_portrait_wyrmling_t1');
    expect(troopPortrait('wyrmling', 7)).toBe('ui_portrait_wyrmling_t2');
    expect(sprite(troopPortrait('wyrmling', 20)))
      .toBe(versionedPublicAsset('/brand/ware/ui_portrait_wyrmling_t4.png'));
    expect(sprite('trp_wyrmling_portrait')).toBe('');
    expect(sprite('trp_wyrmling_fly_e_f1')).toBe('');
  });
});

// Both v2 pack paths are owner-authored spellings; a glob typo is silent —
// sprite() returns '' and <Sprite> renders an empty span — so the 16 tier
// portraits (troops AND the two defences the tray/codex name directly) are
// pinned against the real glob.
describe('rework-v2 tier portraits resolve (pack-root glob contract)', () => {
  it('all 68 ui_portrait_<unit>_t<n> masters resolve', () => {
    for (const unit of ART_V2.units) {
      for (let t = 1; t <= 4; t++) {
        expect(sprite(`ui_portrait_${unit}_t${t}`), `ui_portrait_${unit}_t${t}`).not.toBe('');
      }
    }
  });
});
