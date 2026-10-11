import { describe, expect, it } from 'vitest';
import { CORE_ASSET_PATHS, assetPackTier } from './asset-pack-core.mjs';

describe('hosted core battle animation residency', () => {
  it('ships every Dragon tier body and local FX before playback can begin', () => {
    for (const tier of [1, 2, 3, 4]) {
      for (const group of [
        `v2trp_dragon_t${tier}_combatcore`,
        `v2trp_dragon_t${tier}_compactfx`,
      ]) {
        for (const ext of ['json', 'png']) {
          const path = `/atlas/${group}@1x.${ext}`;
          expect(CORE_ASSET_PATHS.has(path), path).toBe(true);
          expect(assetPackTier(path)).toBe('core');
        }
      }
    }
  });

  it('ships the complete compact combat roster, including Dire local FX', () => {
    expect([...CORE_ASSET_PATHS].filter((path) => path.endsWith('_combatcore@1x.json')))
      .toHaveLength(15 * 4);
    for (const tier of [1, 2, 3, 4]) {
      expect(assetPackTier(`/atlas/v2trp_direwyvern_t${tier}_fx@1x.png`)).toBe('core');
      for (const unit of [
        'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'giant',
        'troll', 'dragon', 'mage', 'bilgewraith', 'gloamfang', 'hexbarrow',
      ]) {
        const kind = unit === 'hexbarrow' ? 'bld' : 'trp';
        expect(assetPackTier(`/atlas/v2${kind}_${unit}_t${tier}_compactfx@1x.png`))
          .toBe('core');
      }
    }
  });

  it('ships every tiered Dragon Nest body and Hatchling lifecycle with WARE FX', () => {
    const groups = ['warefx'];
    for (const tier of [1, 2, 3, 4]) {
      groups.push(`ware_dragonnest_${tier}`, `ware_hatchling_${tier}`);
    }
    const expected = [];
    for (const group of groups) {
      for (const ext of ['json', 'png']) {
        const path = `/atlas/${group}@1x.${ext}`;
        expected.push(path);
        expect(CORE_ASSET_PATHS.has(path), path).toBe(true);
        expect(assetPackTier(path)).toBe('core');
      }
    }
    const actual = [...CORE_ASSET_PATHS]
      .filter((path) => groups.some((group) => path.startsWith(`/atlas/${group}@1x.`)))
      .sort();
    expect(actual).toEqual(expected.sort());
  });
});
