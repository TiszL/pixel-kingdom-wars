/** Lightweight wall presentation mapping. Geometry remains on ./wallRender. */
import { WALL_ART } from './constants';
import type { WallShape } from './wallConnect';

export type WallArtTier = 1 | 2 | 3 | 4 | 5;
/** 0 intact; 1 light; 2 heavy; 3 collapsed (not a live connection). */
export type WallDamageStage = 0 | 1 | 2 | 3;

export function wallTierOfLevel(level: number): WallArtTier {
  const safe = Number.isNaN(level) ? 1 : Math.max(1, Math.floor(level));
  return Math.min(WALL_ART.tiers, Math.ceil(safe / WALL_ART.levelsPerTier)) as WallArtTier;
}

export function wallDamageStage(hp: number, maxHp: number): WallDamageStage {
  if (hp <= 0) return 3;
  if (!(maxHp > 0) || !Number.isFinite(maxHp) || !Number.isFinite(hp)) return 0;
  if (hp < maxHp * WALL_ART.heavyDamageBelow) return 2;
  if (hp < maxHp * WALL_ART.lightDamageBelow) return 1;
  return 0;
}

export function wallFrameKey(
  level: number, shape: WallShape = 'post', state: 'intact' | 'damaged' | 'collapse' = 'intact', frame = 1,
): string {
  return `wall5_t${wallTierOfLevel(level)}_${shape}_${state}_f${frame}`;
}
