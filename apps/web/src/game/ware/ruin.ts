/**
 * Rest frames for M22 buildings whose authored `collapse` clip has no ruin.
 *
 * Owner 2026-09-17: "camp destroyed state looks awful". The camp pack's
 * collapse is a five-frame SINK — the body squashes into the ground — and its
 * final cell is a 12-px sliver of dirt, not a ruin. Every other M22 building
 * (barracks, mine, alchemy lab …) authors real rubble as its last collapse
 * frame, so holding that frame is right for them and wrong only here. This
 * module supplies a generated rubble cell (same 104×96 cell, same [52,80]
 * anchor as the camp pack, palette-corrected to tier 1) that the sprite rests
 * on once the sink has played, so the seat and scale never change.
 *
 * The PNG is inlined into the lazy game chunk and registered straight into
 * the TextureManager: it never touches the on-demand loader (no scene-shutdown
 * transfer hazard, never swept by releaseUnusedAtlases) and never touches the
 * first-paint budget. Masters are untouched — this is not pack art.
 */
import type Phaser from 'phaser';
import type { WareBuildingUnit } from '@shardkeep/shared';
import campRuin from '../../assets/ware_ruin_camp.png?inline';

export interface WareRuinArt {
  /** Plain texture key; the sprite rests on its base frame. */
  key: string;
  /** data: URI of the PNG. */
  src: string;
}

export const WARE_RUIN_ART: Readonly<Partial<Record<WareBuildingUnit, WareRuinArt>>> = {
  camp: { key: 'ware_ruin_camp', src: campRuin },
};

export function wareRuinArt(unit: string): WareRuinArt | null {
  return Object.prototype.hasOwnProperty.call(WARE_RUIN_ART, unit)
    ? WARE_RUIN_ART[unit as WareBuildingUnit]!
    : null;
}

/** Texture key of the unit's ruin if it is drawable NOW, else null. The base64
 * decode is asynchronous, so a collapse racing the first frames of a scene
 * simply holds the authored cell as before — never a missing-texture box. */
export function wareRuinTexture(scene: Phaser.Scene, unit: string): string | null {
  const art = wareRuinArt(unit);
  return art && scene.textures.exists(art.key) ? art.key : null;
}

const pending = new WeakMap<Phaser.Textures.TextureManager, Set<string>>();

/** Register every ruin texture once per game. Idempotent across scenes and
 * across the async decode window (a second call before onload must not queue
 * a duplicate create, which Phaser reports as a key collision). */
export function ensureWareRuinTextures(scene: Phaser.Scene): void {
  const textures = scene.textures;
  let queued = pending.get(textures);
  if (!queued) {
    queued = new Set();
    pending.set(textures, queued);
  }
  for (const art of Object.values(WARE_RUIN_ART)) {
    if (textures.exists(art.key) || queued.has(art.key)) continue;
    queued.add(art.key);
    textures.addBase64(art.key, art.src);
  }
}
