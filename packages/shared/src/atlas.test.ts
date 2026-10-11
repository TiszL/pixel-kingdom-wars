/**
 * The grouping rule decides both where a sprite is PACKED and where it is
 * LOADED FROM. A disagreement between those two is invisible: Phaser renders
 * nothing rather than erroring. So the properties that matter here are less
 * "does it return the right string" than "can a sprite ever be packed into one
 * group and looked up in another".
 */
import { describe, expect, it } from 'vitest';
import { DEVICE_ART } from './constants';
import {
  ATLAS_PREFIXES, B13_DEFENCES, LEVELED_TROOPS,
  V2_COMPACT_TROOP_FX_STATES, V2_DIREWYVERN_FX_STATES,
  V2_DIREWYVERN_LIFECYCLE_STATES, V2_FALLBACK_ATLAS,
  V2_BUILDING_FALLBACKS, V2_FALLBACK_LOCOMOTION_STATES, V2_FALLBACK_STAND_STATES,
  atlasGroupFor, deviceAtlasScale, eagerAtlasScale, isRetiredRuntimeSpriteKey, isV2FallbackUnit,
  WARE_FALLBACK_ATLAS, isSupersededByWareAlias, isSupersededWareSourceSpriteKey,
  wareBuildingIdleFrameKey, wareBuildingStateFrameKey, wareCurrentArtAliases,
  wareHatchlingFallbackKey, wareHatchlingFallbackSourceFrameKey,
  warePortraitFrameKey, wareTrapFrameKey, wareTrapStateFrameKey,
  wareWorldPresentationForPackUnit,
  wareWallAliasKey, wareWallFrameKey, wareWallStateAliasKey, wareWallStateFrameKey,
  trpdgGroup, trpdgLevel,
  v2DirewyvernControllerAtlasGroups, v2DirewyvernCoreAtlasGroups,
  v2DirewyvernEnhancementAtlasGroups, v2DirewyvernFxAtlasGroup,
  v2BuildingFallbackFrameKey, v2DirewyvernFxFrameKey, v2FallbackFrameKey,
  v2DirewyvernLifecycleAtlasGroup, v2DirewyvernMaulAtlasGroup,
  v2LocomotionAtlasGroup, v2LocomotionStandFrameKey,
  v2TroopFallbackFxAtlasGroups, v2TroopFallbackFxBaseKey,
} from './atlas';
import { WARE_WORLD_PRESENTATION } from './constants';
import { wallFrame } from './wallConnect';

describe('atlasGroupFor', () => {
  it('routes only the delivered Harvester states per realm/tier at optional native density', () => {
    for (const realm of ['frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker_reach', 'stormcairn', 'thornwake', 'cinderfall']) for (const tier of [1, 2, 3, 4]) {
      const group = `pe_harvester_${realm}_t${tier}`;
      expect(ATLAS_PREFIXES).not.toContain(group); expect(eagerAtlasScale(group)).toBe(1);
      for (const profile of ['full', 'constrained'] as const) expect(deviceAtlasScale(group, profile)).toBe(1);
      for (const state of ['idle_f1', 'damaged_f1', 'ready_f1', 'destroyed_f1', 'working_f9', 'construction_f9', 'collapse_f9']) expect(atlasGroupFor(`${group}_${state}`)).toBe(group);
    }
    for (const key of ['pe_harvester_seeker-reach_t1_idle_f1', 'pe_harvester_seeker_t1_idle_f1', 'pe_harvester_frostveil_t5_idle_f1', 'pe_harvester_frostveil_t1_idle_f2', 'pe_harvester_frostveil_t1_ready_fx_f1', 'pe_harvester_frostveil_t1_working_f10', 'pe_harvester_frostveil_t1_rubble_f1']) expect(atlasGroupFor(key)).toBe('ui');
  });
  it('keeps advanced fleet berth families and vehicle tiers independently optional at native density', () => {
    for (const family of ['survey_balloon', 'cargo_cutter', 'courier_airship', 'expedition_barge']) {
      const berth = `pe_berth_${family}`;
      for (const state of ['intact_f1', 'damaged_f1', 'destroyed_f1', 'ambient_f8']) expect(atlasGroupFor(`${berth}_${state}`)).toBe(berth);
      for (const group of [berth, ...[1, 2, 3, 4].map(tier => `pe_veh_${family}_t${tier}`)]) {
        expect(ATLAS_PREFIXES).not.toContain(group);
        expect(eagerAtlasScale(group)).toBe(1);
        for (const profile of ['full', 'constrained'] as const) expect(deviceAtlasScale(group, profile)).toBe(1);
        if (group !== berth) for (const state of ['idle_f1', 'docked_f4', 'travel_f8', 'exhausted_f1'])
          expect(atlasGroupFor(`${group}_${state}`)).toBe(group);
      }
    }
    for (const key of ['pe_veh_cargo-cutter_t1_idle_f1', 'pe_veh_cargo_cutter_t5_idle_f1',
      'pe_berth_cargo_cutter_t1_intact_f1', 'pe_veh_cargo_cutter_t1_departure_f1', 'pe_veh_unknown_t1_idle_f1'])
      expect(atlasGroupFor(key)).toBe('ui');
    expect(atlasGroupFor('pe_veh_starter_idle_f1')).toBe('pe_fleet_starter');
    expect(atlasGroupFor('pe_workshop_t1_idle_f1')).toBe('pe_workshop_t1');
  });
  it('keeps source-only Workshop and Lodge tiers optional, native-density and separate from Market', () => {
    for (const family of ['workshop', 'lodge']) for (const tier of [1, 2, 3, 4]) {
      const group = `pe_${family}_t${tier}`;
      expect(ATLAS_PREFIXES).not.toContain(group);
      for (const state of ['idle_f1', 'working_f9', 'ready_f1', 'ready_fx_f8', 'destroyed_f1'])
        expect(atlasGroupFor(`${group}_${state}`)).toBe(group);
      expect(eagerAtlasScale(group)).toBe(1);
      expect(deviceAtlasScale(group, 'full')).toBe(1); expect(deviceAtlasScale(group, 'constrained')).toBe(1);
    }
    expect(atlasGroupFor('pe_workshop_t5_idle_f1')).toBe('ui');
    expect(atlasGroupFor('pe_lodge_t1_invented_f1')).toBe('ui');
    expect(atlasGroupFor('pe_market_t1_idle_f1')).toBe('pe_market_t1');
  });
  it('keeps only the admitted starter fleet and gate FX in one on-demand native-density group', () => {
    const group = 'pe_fleet_starter';
    expect(ATLAS_PREFIXES).not.toContain(group);
    for (const key of ['pe_veh_starter_idle_f1', 'pe_veh_starter_docked_f4', 'pe_veh_starter_travel_f8',
      'pe_berth_starter_intact_f1', 'pe_berth_starter_ambient_f8', 'pe_fx_departure_f8', 'pe_fx_return_still_f1'])
      expect(atlasGroupFor(key)).toBe(group);
    for (const key of ['pe_veh_starter_exhausted_f1', 'pe_veh_cargo_cutter_t5_idle_f1', 'pe_fx_reward_claim_f1'])
      expect(atlasGroupFor(key)).toBe('ui');
    expect(eagerAtlasScale(group)).toBe(1);
    expect(deviceAtlasScale(group, 'full')).toBe(1);
    expect(deviceAtlasScale(group, 'constrained')).toBe(1);
  });
  it('keeps each ordinary Market tier independently loadable at authored density', () => {
    for (let tier = 1; tier <= 4; tier++) {
      const group = `pe_market_t${tier}`;
      expect(ATLAS_PREFIXES).not.toContain(group);
      for (const state of ['idle_f1', 'construction_f9', 'destroyed_f1', 'ready_fx_f8'])
        expect(atlasGroupFor(`${group}_${state}`)).toBe(group);
      expect(eagerAtlasScale(group)).toBe(1);
      expect(deviceAtlasScale(group, 'full')).toBe(1);
      expect(deviceAtlasScale(group, 'constrained')).toBe(1);
    }
    expect(atlasGroupFor('pe_market_t5_idle_f1')).toBe('ui');
  });
  it('keeps admitted cosmetics on demand at authored 1x density for both device profiles', () => {
    expect(ATLAS_PREFIXES).not.toContain('pe_cosmetics');
    for (const key of ['pe_cos_market_t1_idle_f1', 'pe_cos_market_t4_collapse_f9', 'pe_cos_wake_f8', 'pe_cos_ready_fx_f1']) expect(atlasGroupFor(key)).toBe('pe_cosmetics');
    expect(eagerAtlasScale('pe_cosmetics')).toBe(1);
    expect(deviceAtlasScale('pe_cosmetics', 'full')).toBe(1);
    expect(deviceAtlasScale('pe_cosmetics', 'constrained')).toBe(1);
    expect(atlasGroupFor('pe_unknown_unadmitted_f1')).toBe('ui');
  });
  it('keeps civilian builder frames in a native on-demand group, separate from Tunneler troop art', () => {
    expect(ATLAS_PREFIXES).not.toContain('builder');
    for (const key of ['builder_idle_d0_f1', 'builder_walk_d7_f8', 'builder_work_d3_f6']) {
      expect(atlasGroupFor(key)).toBe('builder');
    }
    expect(deviceAtlasScale('builder', 'full')).toBe(1);
    expect(deviceAtlasScale('builder', 'constrained')).toBe(1);
    expect(atlasGroupFor('v2_trp_tunneler_t1_walk_d0_f1')).toBe('v2trp_tunneler_t1_locomotion');
  });
  describe('M22 ware rework', () => {
    it('routes namespaced clips by unit/progression without entering legacy groups', () => {
      expect(atlasGroupFor('ware_bld_keep_l20_idle_f1')).toBe('ware_keep_20');
      expect(atlasGroupFor('ware_bld_archer_t4_fire_d7_f3')).toBe('ware_archer_4');
      expect(atlasGroupFor('ware_unt_hatchling_t2_fly_d3_f1')).toBe('ware_hatchling_2');
      expect(atlasGroupFor('ware_ui_portrait_forge_t1_f1')).toBe('wareui');
      expect(atlasGroupFor('ware_fx_arrow_d0_f1')).toBe('warefx');
    });

    it('pins the full 2,123-source history but registers only 1,163 non-wall runtime aliases', () => {
      const aliases = wareCurrentArtAliases();
      expect(aliases).toHaveLength(2_123);
      expect(new Set(aliases.map(({ aliasKey }) => aliasKey)).size).toBe(2_123);
      for (const { aliasKey, sourceFrameKey } of aliases) {
        expect(sourceFrameKey).toMatch(/^ware_/);
        expect(isSupersededByWareAlias(aliasKey)).toBe(!aliasKey.startsWith('bld_wall_'));
        expect(isSupersededByWareAlias(sourceFrameKey)).toBe(false);
      }
      expect(wareCurrentArtAliases(false)).toHaveLength(1_163);
      expect(wareCurrentArtAliases(false).some(({ aliasKey }) => aliasKey.startsWith('bld_wall_'))).toBe(false);
      for (const key of ['bld_wall_straight_t1', 'bld_wall_cross_t20_damaged', 'ware_bld_wall_t4_collapse_d0_f4']) {
        expect(isRetiredRuntimeSpriteKey(key)).toBe(true);
        expect(atlasGroupFor(key)).toBe('retired');
      }
      expect(isRetiredRuntimeSpriteKey('wall5_t1_straight_intact_f1')).toBe(false);
      expect(wareBuildingIdleFrameKey('archertower', 20))
        .toBe('ware_bld_archer_t4_idle_d0_f1');
      expect(wareBuildingIdleFrameKey('forge', 6))
        .toBe('ware_bld_alchemylab_t2_idle_f1');
      expect(wareBuildingIdleFrameKey('keep', 20))
        .toBe('ware_bld_keep_l20_idle_f1');
      expect(wareWallFrameKey('tee_s', 19)).toBe('ware_bld_wall_tee_s_t4_f1');
      expect(wareTrapFrameKey('airmine', 12)).toBe('ware_trp_airmine_t3_drift_f1');
      expect(warePortraitFrameKey('wyrmling', 3))
        .toBe('ware_ui_portrait_hatchling_t3_f1');
      expect(wareBuildingStateFrameKey('airdefence', 20, 'damaged'))
        .toBe('ware_bld_airdefence_t4_damaged_d0_f2');
      expect(wareBuildingStateFrameKey('keep', 15, 'collapse'))
        .toBe('ware_bld_keep_l15_collapse_f5');
      expect(wareWallStateFrameKey('tee_s', 19, 'collapse'))
        .toBe('ware_bld_wall_t4_collapse_d14_f4');
      expect(wareTrapStateFrameKey('spiketrap', 9, 'hidden'))
        .toBe('ware_trp_spiketrap_t2_hidden_f1');
      expect(wareTrapStateFrameKey('airmine', 9, 'hidden'))
        .toBe('ware_trp_airmine_t2_drift_f1');
      expect(atlasGroupFor('bld_keep_l20_collapse')).toBe(WARE_FALLBACK_ATLAS);
      expect(atlasGroupFor('bld_spiketrap_hidden_l20')).toBe(WARE_FALLBACK_ATLAS);
      expect(eagerAtlasScale(WARE_FALLBACK_ATLAS)).toBe(1);
      expect(wareHatchlingFallbackKey(4)).toBe('ware_fallback_hatchling_t4');
      expect(wareHatchlingFallbackSourceFrameKey(4))
        .toBe('ware_unt_hatchling_t4_hover_d0_f1');
      expect(atlasGroupFor(wareHatchlingFallbackKey(4))).toBe(WARE_FALLBACK_ATLAS);
    });

    // The accepted five-tier pack replaces runtime WARE walls; historical alias
    // validation above remains solely to catch source-pack drift before retirement.
    it('routes every wall level to one five-tier source atlas without double compression', () => {
      const straightEW = { n: false, e: true, s: false, w: true };
      expect(ATLAS_PREFIXES).toContain('wall5');
      for (let level = 1; level <= 20; level++) {
        const tier = Math.ceil(level / 4), key = wallFrame(straightEW, level);
        expect(key).toBe(`wall5_t${tier}_straight_intact_f1`);
        expect(atlasGroupFor(key)).toBe('wall5');
        expect(eagerAtlasScale(atlasGroupFor(key))).toBe(1);
        expect(deviceAtlasScale(atlasGroupFor(key), 'constrained')).toBe(1);
        expect(atlasGroupFor(`wall5_t${tier}_cross_collapse_f4`)).toBe('wall5');
      }
    });

    it('fits every world family to its canonical tiles without scaling portraits or Hatchlings', () => {
      expect(Object.keys(WARE_WORLD_PRESENTATION).sort()).toEqual([
        'airdefence', 'airmine', 'archertower', 'barracks', 'camp', 'clanhall',
        'dragonnest', 'electrictower', 'forge', 'goldforge', 'keep', 'lasertower',
        'magetower', 'mine', 'pitfall', 'powdermine', 'spiketrap', 'vault', 'wall',
      ]);
      expect(wareWorldPresentationForPackUnit('keep')).toEqual({
        sourceScale: 0.625, offsetGamePx: [0, 0], maxHorizontalOverhangGamePx: 5,
      });
      expect(wareWorldPresentationForPackUnit('archer'))
        .toBe(WARE_WORLD_PRESENTATION.archertower);
      expect(wareWorldPresentationForPackUnit('alchemylab'))
        .toBe(WARE_WORLD_PRESENTATION.forge);
      expect(wareWorldPresentationForPackUnit('mine')).toEqual({
        sourceScale: 0.45, offsetGamePx: [1, 0],
      });
      expect(wareWorldPresentationForPackUnit('hatchling')).toBeNull();
      expect(wareWorldPresentationForPackUnit('portrait')).toBeNull();
    });

    it('filters every replaced historical building sibling while preserving Keep rubble', () => {
      for (const key of [
        'bld_keep_l1', 'bld_keep_l20_work_f1', 'bld_goldforge_l9_fire_f2',
        'bld_vault_l20', 'bld_barracks_l1_work_f1', 'bld_forge_l8',
        'bld_camp_l3', 'bld_archertower_l7_fire_f1', 'bld_electrictower_l20_f4',
        'bld_magetower_l5', 'bld_lasertower_l16_fire_f2', 'bld_mine_l4',
        'bld_clanhall_l12', 'bld_dragonnest_l19', 'bld_airdefence_l2',
        'bld_spiketrap_armed', 'bld_powdermine_hidden_l4', 'bld_pitfall_l9',
        'bld_airmine_spent_l20', 'bld_wall_cap_n_t3',
      ]) expect(isSupersededWareSourceSpriteKey(key), key).toBe(true);
      for (const key of [
        'bld_keep_ruined', 'bld_heroaltar_l1', 'bld_cannon_l20',
        'ware_bld_keep_l1_idle_f1', 'ui_portrait_keep_t1',
      ]) expect(isSupersededWareSourceSpriteKey(key), key).toBe(false);
    });
  });

  it('keeps every historical prefix on its own atlas', () => {
    expect(atlasGroupFor('tile_grass_1')).toBe('tile');
    expect(atlasGroupFor('trp_highlander_walk_s_f1')).toBe('trp');
    expect(atlasGroupFor('bld_keep_l4')).toBe('bld');
    expect(atlasGroupFor('hero_vex_walk_e_f1')).toBe('hero');
  });

  it('routes unknown prefixes to ui, as BootScene always has', () => {
    // Not an accident to preserve: several UI-only keys have no atlas prefix of
    // their own and have relied on this fallback since the first atlas build.
    expect(atlasGroupFor('somethingelse_x')).toBe('ui');
  });

  describe('batch-13 defences', () => {
    it('retires every superseded Mortar body frame without catching current art', () => {
      // D-039 is an absence contract: keeping the old masters on disk is useful
      // provenance, but making even one old level/state runtime-addressable can
      // flash a different tower during an upgrade or optional-atlas load.
      for (let level = 1; level <= 20; level++) {
        for (const suffix of ['', '_work_f1', '_fire_f1', '_fire_f2']) {
          expect(isRetiredRuntimeSpriteKey(`bld_mortar_l${level}${suffix}`)).toBe(true);
        }
      }
      for (const key of [
        'bld_mortar_l21', 'bld_mortar_l1_preview',
        'v2_fallback_bld_mortar_t1_idle_d0_f1',
        'v2_bld_mortar_t4_idle_d0_f1', 'ui_portrait_mortar_t1',
      ]) {
        expect(isRetiredRuntimeSpriteKey(key), key).toBe(false);
      }
    });

    it('retires every historical Wyrmling body and wyrm-breath spelling', () => {
      for (const key of [
        'trp_wyrmling', 'trp_wyrmling_fly_e_f1', 'trp_wyrmling_l20_attack_e_f4',
        'fx_breath_wyrm', 'fx_breath_wyrm_f3', 'fx_breath_wyrmling_f1',
      ]) expect(isRetiredRuntimeSpriteKey(key), key).toBe(true);
      for (const key of [
        'ware_unt_hatchling_t1_hover_d0_f1', 'ware_fallback_hatchling_t4',
        'ware_fx_hatchfire_t2_impact_f1', 'ui_portrait_wyrmling_t1',
      ]) expect(isRetiredRuntimeSpriteKey(key), key).toBe(false);
    });

    it('moves all seven off the bld atlas — the reason bld fits one texture again', () => {
      for (const d of B13_DEFENCES) {
        expect(atlasGroupFor(`bld_${d}_l1`), d).toBe('blddef');
        expect(atlasGroupFor(`bld_${d}_l20`), d).toBe('blddef');
      }
    });

    it('keeps a defence base frame and its animation frames in ONE group', () => {
      // A Phaser animation sequence cannot span two textures. If these ever
      // disagree the idle/fire loops silently render nothing. The suffixes are
      // each defence's REAL shipped states: the six older towers idle with a
      // single `_work_f1` swap frame and fire in 2 frames; the v2 electric
      // tower idles on a 4-frame crackle (`_f1..f4`, f1 == the bare key's art)
      // and discharges in 4 (`_fire_f1..f4`).
      const STATES: Record<string, string[]> = {
        default: ['_work_f1', '_fire_f1', '_fire_f2'],
        electrictower: [
          '_f1', '_f2', '_f3', '_f4',
          '_fire_f1', '_fire_f2', '_fire_f3', '_fire_f4',
        ],
      };
      for (const d of B13_DEFENCES) {
        for (const lv of [1, 7, 20]) {
          const base = `bld_${d}_l${lv}`;
          const group = atlasGroupFor(base);
          for (const suffix of STATES[d] ?? STATES['default']!) {
            expect(atlasGroupFor(`${base}${suffix}`), `${base}${suffix}`).toBe(group);
          }
        }
      }
    });

    it('routes bld_electrictower keys to blddef no matter which root shipped them', () => {
      // 'NEW assets' shipped 20 legacy `bld_electrictower_l<N>` masters that
      // used to pack into `bld`; the v2 pack ships new art under the SAME key
      // names. The shadow rule in loadManifest replaces the legacy entries
      // wholesale, so after v2 exactly one master survives per key — and this
      // module only ever sees key names, never source roots. Routing the key
      // to blddef is therefore CORRECT for both "sides" of the shadow: it is
      // what makes the art swap invisible to every `bld_${type}_l${level}`
      // call site. (Keeping legacy electric on `bld` would require grouping by
      // source root, which by design cannot be expressed here.)
      for (const lv of [1, 5, 20]) {
        expect(atlasGroupFor(`bld_electrictower_l${lv}`)).toBe('blddef');
      }
    });

    it('does not capture non-reworked buildings that merely share a prefix', () => {
      // `bld_barracks_l3` must NOT be swept into blddef by a loose regex.
      for (const k of ['bld_barracks_l3', 'bld_mine_l1', 'bld_vault_l20', 'bld_keep_l4']) {
        expect(atlasGroupFor(k), k).toBe('bld');
      }
      // Nor a name that merely STARTS like one.
      expect(atlasGroupFor('bld_cannonfoundry_l2')).toBe('bld');
    });
  });

  describe('per-level troop atlases', () => {
    it('routes each level of dragon/giant to its own group', () => {
      for (const t of LEVELED_TROOPS) {
        expect(atlasGroupFor(`trp_${t}_l1_fly_e_f1`)).toBe('trpdg_l1');
        expect(atlasGroupFor(`trp_${t}_l20_attack_e_f4`)).toBe('trpdg_l20');
        expect(atlasGroupFor(`trp_${t}_l7_portrait`)).toBe('trpdg_l7');
      }
    });

    it('puts dragon and giant of the SAME level in the same group', () => {
      // They are packed together (54 sprites/level) so one load serves both.
      expect(atlasGroupFor('trp_dragon_l9_fly_e_f1'))
        .toBe(atlasGroupFor('trp_giant_l9_walk_e_f1'));
    });

    it('keeps every state of one level together', () => {
      const keys = [
        'trp_dragon_l5_fly_e_f1', 'trp_dragon_l5_fly_n_f6', 'trp_dragon_l5_attack_e_f4',
        'trp_dragon_l5_death_f4', 'trp_dragon_l5_portrait',
      ];
      expect(new Set(keys.map(atlasGroupFor))).toEqual(new Set(['trpdg_l5']));
    });

    it('leaves LEGACY level-agnostic dragon/giant keys on the trp atlas', () => {
      // The old masters still ship; if these were routed to a trpdg group they
      // would be looked up in an atlas that is not loaded at boot.
      expect(atlasGroupFor('trp_dragon_walk_e_f1')).toBe('trp');
      expect(atlasGroupFor('trp_giant_attack_e_f1')).toBe('trp');
      expect(atlasGroupFor('trp_dragon_portrait')).toBe('trp');
    });

    it('does not capture other troops', () => {
      expect(atlasGroupFor('trp_wyrmling_fly_e_f1')).toBe('trp');
    });
  });

  describe('rework-v2 grid pack', () => {
    it('routes every deterministic current-art fallback alias to its eager @1x atlas', () => {
      for (const unit of Object.keys(V2_FALLBACK_STAND_STATES)) {
        expect(isV2FallbackUnit(unit)).toBe(true);
        for (const tier of [1, 2, 3, 4]) {
          expect(atlasGroupFor(v2FallbackFrameKey(unit as keyof typeof V2_FALLBACK_STAND_STATES, tier)))
            .toBe(V2_FALLBACK_ATLAS);
        }
      }
      expect(isV2FallbackUnit('wyrmling')).toBe(false);
      expect(Object.keys(V2_FALLBACK_STAND_STATES)).toHaveLength(15);
      expect(eagerAtlasScale(V2_FALLBACK_ATLAS)).toBe(1);
      expect(eagerAtlasScale('trp')).toBe(2);
    });

    it('routes approved Cannon/Mortar startup frames to the eager current-art atlas', () => {
      // Cannon joined Mortar on 2026-08-16 (owner: "old cannon loaded in
      // assets in campaign bases map instead of new one"): its eager alias was
      // the legacy batch-13 sprite, so any battle whose rich tier atlas the
      // texture budget rejected showed the OLD cannon for the whole fight.
      expect(V2_BUILDING_FALLBACKS).toEqual({
        cannon: { state: 'idle', frames: 2 },
        mortar: { state: 'idle', frames: 2 },
      });
      for (const unit of ['cannon', 'mortar'] as const) {
        for (const tier of [1, 2, 3, 4]) {
          for (const frame of [1, 2]) {
            expect(atlasGroupFor(v2BuildingFallbackFrameKey(unit, tier, frame)))
              .toBe(V2_FALLBACK_ATLAS);
          }
        }
      }
    });
    it('routes active locomotion separately while keeping every clip atomic', () => {
      // A clip's frames cannot span textures; collapse is single-row (no _d
      // token) and must still land with its building.
      expect(atlasGroupFor('v2_trp_giant_t1_walk_d0_f1'))
        .toBe(v2LocomotionAtlasGroup('giant', 1));
      expect(atlasGroupFor('v2_trp_giant_t1_throw_d7_f6')).toBe('v2trp_giant_t1');
      expect(atlasGroupFor('v2_trp_dragon_t4_breath_d3_f8')).toBe('v2trp_dragon_t4');
      expect(atlasGroupFor('v2_bld_cannon_t2_fire_d5_f2')).toBe('v2bld_cannon_t2');
      expect(atlasGroupFor('v2_bld_cannon_t2_collapse_f4')).toBe('v2bld_cannon_t2');
      expect(atlasGroupFor('v2_bld_mortar_t3_reload_d0_f8')).toBe('v2bld_mortar_t3');
    });

    it('gives every rendered v2 root a compact movement/pose atlas', () => {
      for (const [unit, states] of Object.entries(V2_FALLBACK_LOCOMOTION_STATES)) {
        const group = v2LocomotionAtlasGroup(unit as keyof typeof V2_FALLBACK_LOCOMOTION_STATES, 3);
        const kind = unit === 'hexbarrow' ? 'bld' : 'trp';
        for (const state of states) {
          expect(atlasGroupFor(`v2_${kind}_${unit}_t3_${state}_d7_f1`), `${unit} ${state}`)
            .toBe(group);
        }
        for (let row = 0; row < 8; row++) {
          expect(atlasGroupFor(v2LocomotionStandFrameKey(
            unit as keyof typeof V2_FALLBACK_LOCOMOTION_STATES, 3, row,
          ))).toBe(group);
        }
        const expectedDeath = unit === 'direwyvern'
          ? v2DirewyvernLifecycleAtlasGroup(3)
          : `v2${kind}_${unit}_t3`;
        expect(atlasGroupFor(`v2_${kind}_${unit}_t3_death_d7_f1`), `${unit} core`)
          .toBe(expectedDeath);
      }
    });

    it('routes fx, portraits and decals to the shared v2fx atlas', () => {
      expect(atlasGroupFor('v2_fx_boulder_t1_d3_f2')).toBe('v2fx');
      expect(atlasGroupFor('v2_fx_impact_crater_t2_f3')).toBe('v2fx');
      expect(atlasGroupFor('v2_fx_scorch_t1_f1')).toBe('v2fx');
      expect(atlasGroupFor('v2_fx_firestorm_t1_f1')).toBe('v2fx');
      expect(atlasGroupFor('v2_fx_burnfield_t1_f1')).toBe('v2fx');
      expect(atlasGroupFor('v2_fx_impact_slam_t1_f1')).toBe('v2fx');
      expect(atlasGroupFor('v2_ui_portrait_mortar_t2_f1')).toBe('v2fx');
      expect(atlasGroupFor('v2_fx_shadow_f3')).toBe('v2fx');
    });

    it('routes every compact fallback projectile/effect alias by unit and tier', () => {
      expect(V2_COMPACT_TROOP_FX_STATES).toEqual({
        highlander: ['sweep'],
        bowman: ['arrow', 'shadow', 'impact_burn'],
        kegrunner: ['keg_blast'],
        tunneler: ['pick_hit', 'soil'],
        turrider: ['lance_hit', 'dust'],
        plunderer: [],
        giant: ['impact_slam', 'dust', 'boulder', 'shadow', 'impact_rubble'],
        troll: ['sweep', 'impact_slam', 'dust'],
        dragon: ['breath', 'stream_root', 'stream_mid', 'stream_tip', 'impact_burn'],
        mage: ['castflash', 'bolt', 'bolt_hit'],
        bilgewraith: ['slash', 'soil'],
        gloamfang: ['howl', 'dust', 'rend'],
        hexbarrow: ['hexshot', 'shadow', 'impact_crater'],
        barrowling: [],
      });
      for (const [unit, states] of Object.entries(V2_COMPACT_TROOP_FX_STATES)) {
        for (const tier of [1, 2, 3, 4]) {
          const groups = v2TroopFallbackFxAtlasGroups(unit, tier);
          expect(groups, `${unit} t${tier} group`).toHaveLength(states.length > 0 ? 1 : 0);
          for (const fx of states) {
            const metaBase = fx === 'shadow' || fx === 'dust'
              ? `v2_fx_${fx}`
              : `v2_fx_${fx}_t${tier}`;
            const aliasBase = v2TroopFallbackFxBaseKey(unit, tier, metaBase);
            expect(aliasBase, `${unit} t${tier} ${fx} alias`).toBe(
              `v2_compact_fx_${unit}_t${tier}_${fx}`,
            );
            expect(atlasGroupFor(`${aliasBase}_f1`)).toBe(groups[0]);
            expect(atlasGroupFor(`${aliasBase}_d7_f1`)).toBe(groups[0]);
          }
        }
      }
      expect(v2TroopFallbackFxBaseKey('giant', 2, 'v2_fx_boulder_t1')).toBeNull();
      expect(v2TroopFallbackFxAtlasGroups('wyrmling', 1)).toEqual([]);
      expect(v2TroopFallbackFxBaseKey('wyrmling', 1, 'v2_fx_arrow_t1')).toBeNull();
      expect(atlasGroupFor('trp_wyrmling_fire_e_f1')).toBe('trp');
      expect(atlasGroupFor('hero_vex_attack_e_f1')).toBe('hero');
    });

    it('keeps Direwyvern on its existing local FX aliases through the generic API', () => {
      for (const tier of [1, 2, 3, 4]) {
        expect(v2TroopFallbackFxAtlasGroups('direwyvern', tier))
          .toEqual([v2DirewyvernFxAtlasGroup(tier)]);
        for (const fx of V2_DIREWYVERN_FX_STATES) {
          const metaBase = `v2_fx_${fx}_t${tier}`;
          expect(v2TroopFallbackFxBaseKey('direwyvern', tier, metaBase))
            .toBe(`v2_direwyvern_fx_${fx}_t${tier}`);
        }
      }
    });

    it('keeps Direwyvern required core distinct from optional lifecycle/hover', () => {
      // WHY: one Direwyvern tier is 19,222,528 raw cell pixels before packer
      // padding, already above the 16,777,216px texture cap. Firestorm is a
      // complete 64-frame clip, so splitting it preserves the stronger rule:
      // one animation clip never spans textures. Maul splits from lifecycle so
      // special attacks fit after protected defenses under the 96 MiB wall.
      for (const tier of [1, 2, 3, 4]) {
        const base = `v2trp_direwyvern_t${tier}`;
        expect(v2DirewyvernCoreAtlasGroups(tier)).toEqual([
          `${base}_locomotion`, `${base}_maul`, `${base}_firestorm`, `${base}_fx`,
        ]);
        expect(v2DirewyvernEnhancementAtlasGroups(tier)).toEqual([
          base, `${base}_lifecycle`,
        ]);
        expect(v2DirewyvernControllerAtlasGroups(tier)).toEqual([
          `${base}_locomotion`, `${base}_maul`, `${base}_firestorm`, `${base}_fx`,
          base, `${base}_lifecycle`,
        ]);
        expect(v2DirewyvernCoreAtlasGroups(tier)).not.toContain('v2fx');
        expect(v2DirewyvernControllerAtlasGroups(tier)).not.toContain('v2fx');
        for (const frame of [1, 3, 8]) {
          expect(atlasGroupFor(`v2_trp_direwyvern_t${tier}_firestorm_d7_f${frame}`))
            .toBe(`${base}_firestorm`);
          expect(atlasGroupFor(`v2_trp_direwyvern_t${tier}_glide_d7_f${frame}`))
            .toBe(`${base}_locomotion`);
        }
        expect(atlasGroupFor(`v2_trp_direwyvern_t${tier}_maul_d7_f1`))
          .toBe(v2DirewyvernMaulAtlasGroup(tier));
        for (const state of V2_DIREWYVERN_LIFECYCLE_STATES) {
          expect(atlasGroupFor(`v2_trp_direwyvern_t${tier}_${state}_d7_f1`), state)
            .toBe(v2DirewyvernLifecycleAtlasGroup(tier));
        }
        for (const fx of V2_DIREWYVERN_FX_STATES) {
          for (const frame of [1, 4]) {
            expect(atlasGroupFor(v2DirewyvernFxFrameKey(fx, tier, frame)), fx)
              .toBe(v2DirewyvernFxAtlasGroup(tier));
          }
        }
        expect(atlasGroupFor(`v2_trp_direwyvern_t${tier}_hover_d7_f1`))
          .toBe(base);
      }
      // A similarly named state on another troop stays in its unit-tier atlas.
      expect(atlasGroupFor('v2_trp_dragon_t2_firestorm_d0_f1')).toBe('v2trp_dragon_t2');
      expect(atlasGroupFor('v2_trp_dragon_t2_death_d0_f1')).toBe('v2trp_dragon_t2');
    });

    it('never sweeps a NON-v2 key into a v2 group, nor a v2 key into ui', () => {
      // The historical fallback sends unknown prefixes to 'ui'; before this
      // branch existed every v2_ key would have landed there and been looked
      // up in an atlas that never contains it.
      expect(atlasGroupFor('trp_giant_t1_walk_d0_f1')).toBe('trp');
      expect(atlasGroupFor('v2something_x')).toBe('ui'); // no `v2_` separator
      expect(atlasGroupFor('v2_unmatched_thing')).toBe('v2fx');
    });
  });

  it('never routes a sprite to a per-level group that is in the eager set', () => {
    // The eager set is loaded at boot; trpdg_* is loaded on demand. A key in
    // both would be packed once and looked for in the wrong place.
    for (const p of ATLAS_PREFIXES) expect(trpdgLevel(p)).toBeNull();
  });
});

describe('trpdgGroup / trpdgLevel', () => {
  it('round-trips every level the game supports', () => {
    for (let lv = 1; lv <= 20; lv++) expect(trpdgLevel(trpdgGroup(lv))).toBe(lv);
  });

  it('rejects anything that is not a per-level troop group', () => {
    for (const g of ['trp', 'blddef', 'trpdg', 'trpdg_l', 'trpdg_lx', 'bld_l1']) {
      expect(trpdgLevel(g), g).toBeNull();
    }
  });
});

/**
 * D-101 residency. The eager boot set is 141.7 MiB decoded at @2x and 64.5 MiB
 * at @1x; a constrained device fetches the @1x FILES while every consumer keeps
 * drawing in the @2x frame space (the web stitch doubles the rects). So the
 * only thing this function may change is which file is fetched — never the
 * @1x-only fallbacks, and never anything on the full profile.
 */
describe('deviceAtlasScale', () => {
  it('fetches the @1x file for every @2x group on a constrained device', () => {
    for (const group of [...ATLAS_PREFIXES, trpdgGroup(7)]) {
      if (eagerAtlasScale(group) === 2) {
        expect(deviceAtlasScale(group, 'constrained')).toBe(DEVICE_ART.constrainedEagerScale);
      }
    }
    expect(DEVICE_ART.constrainedEagerScale).toBe(1);
  });

  it('never touches the @1x-only current-art fallbacks (no @2x file exists to fall to)', () => {
    for (const group of [V2_FALLBACK_ATLAS, WARE_FALLBACK_ATLAS]) {
      expect(deviceAtlasScale(group, 'constrained')).toBe(1);
      expect(deviceAtlasScale(group, 'full')).toBe(1);
    }
  });

  it('leaves the full profile exactly on eagerAtlasScale (desktop unchanged)', () => {
    for (const group of [...ATLAS_PREFIXES, trpdgGroup(1), trpdgGroup(20), 'v2trp_giant_t2']) {
      expect(deviceAtlasScale(group, 'full')).toBe(eagerAtlasScale(group));
    }
  });
});
