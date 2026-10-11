import type { HeroKey } from '@shardkeep/shared';

// Inventory is a React surface, so it cannot sample the Phaser hero atlas.
// Import the exact PNG masters selected by the strict game-v4 overlay instead
// of letting icons.ts's broad assets-v3 glob choose a pre-overlay SVG body.
import theodor from '../../../../art/game-v4/actors/theo/idle/f1.png';
import vex from '../../../../art/game-v4/actors/legacy-hero_vex_idle_f1.png';

const HERO_BODY_ART: Readonly<Record<HeroKey, string>> = { vex, theodor };

/** Resolve the current in-game standing body for React-only hero surfaces. */
export function heroBodyArt(hero: HeroKey): string {
  return HERO_BODY_ART[hero];
}
