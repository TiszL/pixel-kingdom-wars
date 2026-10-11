import { describe, expect, it } from 'vitest';
import { heroPortrait } from './heroPortrait';

describe('heroPortrait', () => {
  it.each([
    [undefined, 'hero_vex_portrait'],
    [null, 'hero_vex_portrait'],
    [Number.NaN, 'hero_vex_portrait'],
    [1, 'hero_vex_portrait'],
    [5, 'hero_vex_portrait'],
    [15, 'hero_vex_portrait'],
    [16, 'hero_vex_portrait_t4'],
    [20, 'hero_vex_portrait_t4'],
  ])('keeps unknown/T1-T3 Vex on base and promotes only T4 (level %s)', (level, key) => {
    // WHY: only base and T4 masters are approved. Inferring nonexistent T2/T3
    // keys would make roster cards disappear even though the hero has valid art.
    expect(heroPortrait('vex', level)).toBe(key);
  });

  it('applies the same tier contract to Theodor', () => {
    expect(heroPortrait('theodor', 15)).toBe('hero_theo_portrait');
    expect(heroPortrait('theodor', 16)).toBe('hero_theo_portrait_t4');
  });
});
