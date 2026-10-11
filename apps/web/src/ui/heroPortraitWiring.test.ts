import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('hero portrait consumer wiring', () => {
  it('passes authoritative or frozen levels on every level-aware card', () => {
    // WHY: a single resolver is not enough if one surface forgets the level or
    // a replay reads today's level. These are the exact ownership boundaries:
    // GET /heroes, GET /base, GET /items, and the immutable raid snapshot.
    expect(source('./screens/heroes.tsx')).toContain('heroPortrait(h.hero, h.level)');
    expect(source('./screens/inventory.tsx')).toContain('heroPortrait(entry.hero, entry.level)');
    expect(source('./sheets.tsx')).toContain('sheetPortrait(b.type, b.level, heroState?.level)');
    expect(source('./RaidUI.tsx')).toContain(
      'heroPortrait(h, raid.armySnapshot.heroLevels?.[h])',
    );
    expect(source('./RaidUI.tsx')).toContain('heroPortrait(hero.hero, hero.level)');
  });

  it('keeps generic unlock and recruitment cards on the base portrait', () => {
    expect(source('./BuildingInfo.tsx')).toContain('heroPortrait(u.id as HeroKey)');
    expect(source('./sheets.tsx')).toContain("heroPortrait('vex')");
    expect(source('./sheets.tsx')).toContain("heroPortrait('theodor')");
  });

  it('contains no retired hero portrait ternary in the migrated surfaces', () => {
    for (const path of [
      './screens/heroes.tsx', './screens/inventory.tsx', './sheets.tsx',
      './RaidUI.tsx', './BuildingInfo.tsx',
    ]) {
      expect(source(path), path).not.toMatch(
        /\?\s*['"]hero_vex_portrait['"]\s*:\s*['"]hero_theo_portrait['"]/,
      );
    }
  });
});
