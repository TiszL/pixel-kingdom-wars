import { artTierOfLevel, type HeroKey } from '@shardkeep/shared';

const HERO_PORTRAIT_BASE: Readonly<Record<HeroKey, string>> = {
  vex: 'hero_vex_portrait',
  theodor: 'hero_theo_portrait',
};

/**
 * Resolve the one UI portrait identity for a hero.
 *
 * Portrait art intentionally has two bands, not four: unknown levels and
 * tiers 1–3 keep the base portrait, while authoritative art tier 4 uses the
 * approved T4 key. Callers rendering a raid must pass the frozen snapshot
 * level rather than the player's current level.
 */
export function heroPortrait(hero: HeroKey, level?: number | null): string {
  const base = HERO_PORTRAIT_BASE[hero];
  const tier = level !== null && level !== undefined && Number.isFinite(level)
    ? artTierOfLevel(level)
    : 1;
  return tier === 4 ? `${base}_t4` : base;
}
