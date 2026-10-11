/**
 * Pure runtime view of M22's `wareClips` atlas sidecar.
 *
 * The owner pack uses the same row/column framing as rework-v2 but a distinct
 * namespace and progression rule. Runtime identities (`archertower`, `forge`,
 * `wyrmling`) deliberately remain stable; this module is the only place that
 * translates them to pack identities (`archer`, `alchemylab`, `hatchling`).
 */
import {
  WARE_BUILDING_ART, WARE_TRAP_ART, artTierOfLevel, atlasGroupFor,
  wareWorldPresentationForPackUnit,
  type WareBuildingUnit, type WareTrapUnit,
} from '@shardkeep/shared';
import {
  V2_DRAW_SCALE, clipFrames, facingRow, frameName, type Facing8, type V2Clip,
} from '../v2/clips';

export interface WareClip extends V2Clip {
  unit?: string;
  state?: string;
  tier?: number;
  level?: number;
  kind?: string;
  piece?: string;
  mask?: number;
}

export type WareClipMap = Record<string, WareClip>;

export interface WareMeta {
  clips: WareClipMap;
  currentArtAliases: Readonly<Record<string, string>>;
  atlasBytes: Readonly<Record<string, number>>;
}

export interface WareSeat {
  origin: readonly [number, number];
  scale: number;
  /** Presentation-only correction in the authored 32-px game space. */
  offsetGamePx?: readonly [number, number];
}

const FRAME_SUFFIX = /(?:_d\d+)?_f\d+$/;

export function wareFrameClipBase(frame: string): string | null {
  if (!frame.startsWith('ware_') || !FRAME_SUFFIX.test(frame)) return null;
  return frame.replace(FRAME_SUFFIX, '');
}

export function wareBuildingClipKey(
  unit: WareBuildingUnit,
  level: number,
  state: string,
): string {
  const art = WARE_BUILDING_ART[unit];
  const n = art.progression === 'level'
    ? Math.max(1, Math.min(20, level))
    : artTierOfLevel(level);
  return `ware_bld_${art.packUnit}_${art.progression === 'level' ? 'l' : 't'}${n}_${state}`;
}

export function wareTrapClipKey(unit: WareTrapUnit, level: number, state: string): string {
  return `ware_trp_${unit}_t${artTierOfLevel(level)}_${state}`;
}

export function wareHatchlingClipKey(level: number, state: string): string {
  return `ware_unt_hatchling_t${artTierOfLevel(level)}_${state}`;
}

export function wareClipFrames(
  clips: WareClipMap,
  base: string,
  row = 0,
): string[] {
  const clip = clips[base];
  return clip ? clipFrames(base, clip, row) : [];
}

export function wareFacingFrames(
  clips: WareClipMap,
  base: string,
  facing: Facing8,
): string[] {
  const clip = clips[base];
  return clip ? clipFrames(base, clip, facingRow(clip, facing)) : [];
}

export function wareFrame(
  clips: WareClipMap,
  base: string,
  row: number,
  frame1: number,
): string | null {
  const clip = clips[base];
  return clip ? frameName(base, clip, row, frame1) : null;
}

export function wareAtlasGroupForClip(base: string): string {
  return atlasGroupFor(`${base}_f1`);
}

export function wareBuildingAtlasGroup(unit: WareBuildingUnit, level: number): string {
  return wareAtlasGroupForClip(wareBuildingClipKey(unit, level, 'idle'));
}

export function wareTrapAtlasGroup(unit: WareTrapUnit, level: number): string {
  return wareAtlasGroupForClip(wareTrapClipKey(unit, level, WARE_TRAP_ART[unit]));
}

/**
 * Pack anchor -> Phaser seat (ORIGIN and draw scale only). Grid buildings and
 * traps publish a pixel anchor; walls intentionally encode a fractional
 * `[0.5,1]`, which is not a half-pixel coordinate — hence the range test.
 *
 * WHERE the sprite sits is NOT here: every family seats its drawn bottom edge
 * on the footprint's south edge (`v2/clips.ts#buildingSeatY`). This used to
 * publish `footprintFrac: 0.5` for the pixel-anchored families, which put the
 * anchor on the footprint's middle row and floated the whole pack above its
 * plots — see buildingSeatY for the measurements and the owner report.
 */
export function wareSeat(clips: WareClipMap, frame: string): WareSeat | null {
  const base = wareFrameClipBase(frame);
  const clip = base ? clips[base] : undefined;
  if (!clip?.anchorPx) return null;
  const fractional = clip.anchorPx[0] >= 0 && clip.anchorPx[0] <= 1
    && clip.anchorPx[1] >= 0 && clip.anchorPx[1] <= 1;
  const presentation = wareWorldPresentationForPackUnit(clip.unit);
  return {
    origin: fractional
      ? [clip.anchorPx[0], clip.anchorPx[1]]
      : [clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH],
    scale: V2_DRAW_SCALE * (presentation?.sourceScale ?? 1),
    ...(presentation ? { offsetGamePx: presentation.offsetGamePx } : {}),
  };
}

export function isWareBuildingUnit(value: string): value is WareBuildingUnit {
  return Object.prototype.hasOwnProperty.call(WARE_BUILDING_ART, value);
}

export function isWareTrapUnit(value: string): value is WareTrapUnit {
  return Object.prototype.hasOwnProperty.call(WARE_TRAP_ART, value);
}
