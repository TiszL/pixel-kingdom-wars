/**
 * Viewer-local clock hands composited over an authored KEEP clock face.
 *
 * This is presentation only: it never enters a snapshot, order, replay, deed
 * render, or simulator input. Art owns the face and publishes an exact pivot;
 * this layer owns only the two tiny binary-alpha hands and local-time display.
 */
import Phaser from 'phaser';
import {
  KEEP_CLOCK_HAND_BYTES_PER_FRAME,
  KEEP_CLOCK_HAND_CELL_PX,
  KEEP_CLOCK_HAND_FRAME_COUNT,
  KEEP_CLOCK_HOUR_MASK_BASE64,
  KEEP_CLOCK_MINUTE_MASK_BASE64,
} from './keepClockHands.generated';

export const KEEP_CLOCK_META_REGISTRY_KEY = 'keepClockMeta';

export interface KeepClockFace {
  /** Pixel centre of the clock pin in the untrimmed authored source frame. */
  pivotPx: readonly [number, number];
  /** Exact source-frame canvas used to convert the pivot through Sprite origin. */
  canvasPx: readonly [number, number];
  /** Positive integer nearest-neighbour enlargement of the 17px hand cell. */
  handScale: number;
}

/** A runtime frame can own a face, explicitly occlude it, or alias the source
 * frame whose face it preserves (idle/work animation frames normally alias). */
export type KeepClockFrameBinding = KeepClockFace | { sourceFrame: string } | null;

export interface KeepClockLevelFace extends KeepClockFace {
  /** The one bare/source frame for which this level fallback is valid. */
  sourceFrame: string;
}

export interface KeepClockMetadata {
  /** Exact runtime frame keys. `null` is an intentional hidden/occluded face. */
  frames: Readonly<Record<string, KeepClockFrameBinding>>;
  /** Level metadata is fail-closed: it applies only to its exact sourceFrame. */
  levels: Readonly<Partial<Record<number, KeepClockLevelFace | null>>>;
}

export interface ResolvedKeepClockFace extends KeepClockFace {
  sourceFrame: string;
}

export const EMPTY_KEEP_CLOCK_METADATA: KeepClockMetadata = Object.freeze({
  frames: Object.freeze({}),
  levels: Object.freeze({}),
});

const isFinitePositiveInteger = (value: number): boolean =>
  Number.isInteger(value) && Number.isFinite(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

function validFace(face: KeepClockFace): boolean {
  return face.pivotPx.length === 2
    && face.canvasPx.length === 2
    && face.pivotPx.every(Number.isFinite)
    && face.canvasPx.every(isFinitePositiveInteger)
    && face.pivotPx[0] >= 0 && face.pivotPx[0] < face.canvasPx[0]
    && face.pivotPx[1] >= 0 && face.pivotPx[1] < face.canvasPx[1]
    && isFinitePositiveInteger(face.handScale);
}

function parseFace(value: unknown): KeepClockFace | null {
  if (!isRecord(value) || !hasExactKeys(value, ['pivotPx', 'canvasPx', 'handScale'])) return null;
  const pivotPx = value['pivotPx'];
  const canvasPx = value['canvasPx'];
  const handScale = value['handScale'];
  if (!Array.isArray(pivotPx) || pivotPx.length !== 2
    || !Array.isArray(canvasPx) || canvasPx.length !== 2
    || typeof handScale !== 'number') return null;
  const face: KeepClockFace = {
    pivotPx: [pivotPx[0] as number, pivotPx[1] as number],
    canvasPx: [canvasPx[0] as number, canvasPx[1] as number],
    handScale,
  };
  return validFace(face) ? face : null;
}

/** The atlas sidecar is downloaded JSON, not trusted TypeScript. One malformed
 * binding rejects the complete table so a partial parse can never put hands on
 * the wrong KEEP frame. */
export function parseKeepClockMetadata(value: unknown): KeepClockMetadata {
  if (!isRecord(value) || !hasExactKeys(value, ['frames', 'levels'])
    || !isRecord(value['frames']) || !isRecord(value['levels'])) {
    return EMPTY_KEEP_CLOCK_METADATA;
  }
  const frames: Record<string, KeepClockFrameBinding> = {};
  for (const [frame, raw] of Object.entries(value['frames'])) {
    if (!frame) return EMPTY_KEEP_CLOCK_METADATA;
    if (raw === null) {
      frames[frame] = null;
      continue;
    }
    if (isRecord(raw) && hasExactKeys(raw, ['sourceFrame'])) {
      if (typeof raw['sourceFrame'] !== 'string' || !raw['sourceFrame']) {
        return EMPTY_KEEP_CLOCK_METADATA;
      }
      frames[frame] = { sourceFrame: raw['sourceFrame'] };
      continue;
    }
    const face = parseFace(raw);
    if (!face) return EMPTY_KEEP_CLOCK_METADATA;
    frames[frame] = face;
  }
  const levels: Partial<Record<number, KeepClockLevelFace | null>> = {};
  for (const [levelKey, raw] of Object.entries(value['levels'])) {
    const level = Number(levelKey);
    if (!Number.isSafeInteger(level) || level <= 0 || String(level) !== levelKey) {
      return EMPTY_KEEP_CLOCK_METADATA;
    }
    if (raw === null) {
      levels[level] = null;
      continue;
    }
    if (!isRecord(raw) || !hasExactKeys(raw, [
      'sourceFrame', 'pivotPx', 'canvasPx', 'handScale',
    ]) || typeof raw['sourceFrame'] !== 'string' || !raw['sourceFrame']) {
      return EMPTY_KEEP_CLOCK_METADATA;
    }
    const face = parseFace({
      pivotPx: raw['pivotPx'], canvasPx: raw['canvasPx'], handScale: raw['handScale'],
    });
    if (!face) return EMPTY_KEEP_CLOCK_METADATA;
    levels[level] = { sourceFrame: raw['sourceFrame'], ...face };
  }
  return { frames, levels };
}

/** Resolve aliases without guessing. Missing, malformed, cyclic, damaged, or
 * collapse frames remain clockless until the art manifest explicitly maps them. */
export function resolveKeepClockFace(
  metadata: KeepClockMetadata,
  runtimeFrame: string,
  level: number,
): ResolvedKeepClockFace | null {
  const seen = new Set<string>();
  let frame = runtimeFrame;
  for (;;) {
    if (seen.has(frame)) return null;
    seen.add(frame);
    if (Object.prototype.hasOwnProperty.call(metadata.frames, frame)) {
      const binding = metadata.frames[frame];
      if (binding === null || binding === undefined) return null;
      if ('sourceFrame' in binding) {
        if (!binding.sourceFrame) return null;
        frame = binding.sourceFrame;
        continue;
      }
      return validFace(binding) ? { ...binding, sourceFrame: frame } : null;
    }
    const fallback = metadata.levels[level];
    if (!fallback || fallback.sourceFrame !== frame || !validFace(fallback)) return null;
    return { ...fallback, sourceFrame: frame };
  }
}

export interface KeepClockFrameIndices {
  hour: number;
  minute: number;
}

/** Uses the browser/device local fields deliberately (never UTC). The hour hand
 * advances in minute-sized steps, while the visual refresh remains once/minute. */
export function keepClockFrameIndices(localTime: Date): KeepClockFrameIndices {
  const minute = localTime.getMinutes();
  const hourMinute = (localTime.getHours() % 12) * 5 + minute / 12;
  return {
    hour: Math.round(hourMinute) % KEEP_CLOCK_HAND_FRAME_COUNT,
    minute,
  };
}

const TEXTURE_KEY = 'keep-clock-hands';
const HOUR_COLOR = [0x4c, 0x2d, 0x1a] as const;
const MINUTE_COLOR = [0xf4, 0xd7, 0x7b] as const;

function decodedMask(encoded: string): Uint8Array {
  const raw = atob(encoded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function paintMask(
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  row: number,
  color: readonly [number, number, number],
): void {
  const sheetWidth = KEEP_CLOCK_HAND_CELL_PX * KEEP_CLOCK_HAND_FRAME_COUNT;
  const framePixels = KEEP_CLOCK_HAND_CELL_PX * KEEP_CLOCK_HAND_CELL_PX;
  for (let frame = 0; frame < KEEP_CLOCK_HAND_FRAME_COUNT; frame++) {
    const frameOffset = frame * KEEP_CLOCK_HAND_BYTES_PER_FRAME;
    for (let pixel = 0; pixel < framePixels; pixel++) {
      if ((mask[frameOffset + (pixel >> 3)]! & (1 << (pixel & 7))) === 0) continue;
      const x = frame * KEEP_CLOCK_HAND_CELL_PX + pixel % KEEP_CLOCK_HAND_CELL_PX;
      const y = row * KEEP_CLOCK_HAND_CELL_PX + Math.floor(pixel / KEEP_CLOCK_HAND_CELL_PX);
      const out = (y * sheetWidth + x) * 4;
      rgba[out] = color[0];
      rgba[out + 1] = color[1];
      rgba[out + 2] = color[2];
      rgba[out + 3] = 255;
    }
  }
}

/** Register one game-global, two-row sprite sheet. Pixels are written directly;
 * no Canvas line, rotation, antialiasing, or gradient API is involved. */
function ensureKeepClockTexture(scene: Phaser.Scene): boolean {
  if (scene.textures.exists(TEXTURE_KEY)) return true;
  const width = KEEP_CLOCK_HAND_CELL_PX * KEEP_CLOCK_HAND_FRAME_COUNT;
  const height = KEEP_CLOCK_HAND_CELL_PX * 2;
  const texture = scene.textures.createCanvas(TEXTURE_KEY, width, height);
  if (!texture) return false;
  const context = texture.getContext();
  const image = context.createImageData(width, height);
  paintMask(image.data, decodedMask(KEEP_CLOCK_HOUR_MASK_BASE64), 0, HOUR_COLOR);
  paintMask(image.data, decodedMask(KEEP_CLOCK_MINUTE_MASK_BASE64), 1, MINUTE_COLOR);
  context.putImageData(image, 0, 0);
  for (let frame = 0; frame < KEEP_CLOCK_HAND_FRAME_COUNT; frame++) {
    const x = frame * KEEP_CLOCK_HAND_CELL_PX;
    texture.add(`hour_${frame}`, 0, x, 0, KEEP_CLOCK_HAND_CELL_PX, KEEP_CLOCK_HAND_CELL_PX);
    texture.add(
      `minute_${frame}`, 0, x, KEEP_CLOCK_HAND_CELL_PX,
      KEEP_CLOCK_HAND_CELL_PX, KEEP_CLOCK_HAND_CELL_PX,
    );
  }
  texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
  texture.refresh();
  return true;
}

interface ClockOverlay {
  body: Phaser.GameObjects.Sprite;
  level: number;
  hour: Phaser.GameObjects.Image | null;
  minute: Phaser.GameObjects.Image | null;
  lastMinuteStamp: number | null;
}

export type KeepClockNow = () => number | Date;

export class KeepClockLayer {
  private readonly overlays = new Map<string, ClockOverlay>();

  private readonly metadata: KeepClockMetadata;

  constructor(
    private readonly scene: Phaser.Scene,
    metadata: unknown = EMPTY_KEEP_CLOCK_METADATA,
    private readonly now: KeepClockNow = Date.now,
  ) {
    this.metadata = parseKeepClockMetadata(metadata);
  }

  /** Attach or refresh a live KEEP body. Repeated store/render sync is cheap and
   * preserves the hand sprites while the building swaps idle/work aliases. */
  sync(id: string, body: Phaser.GameObjects.Sprite, level: number): void {
    const current = this.overlays.get(id);
    if (current) {
      current.body = body;
      current.level = level;
    } else {
      this.overlays.set(id, {
        body, level, hour: null, minute: null, lastMinuteStamp: null,
      });
    }
    const overlay = this.overlays.get(id)!;
    this.refreshTransform(overlay);
    this.refreshClock(overlay, this.nowMs(), false);
  }

  /** Called every scene update. Placement/visibility is followed every frame
   * but written only when the body's transform actually changed (D-101, M33
   * package D); clock textures change at most once per local minute. */
  update(): void {
    for (const overlay of this.overlays.values()) this.refreshTransform(overlay);
    const nowMs = this.nowMs();
    for (const overlay of this.overlays.values()) this.refreshClock(overlay, nowMs, false);
  }

  /** Phaser WAKE and foreground resume must not wait for the next minute edge. */
  resume(): void {
    const nowMs = this.nowMs();
    for (const overlay of this.overlays.values()) {
      overlay.lastMinuteStamp = null;
      this.refreshTransform(overlay);
      this.refreshClock(overlay, nowMs, true);
    }
  }

  /** Collapse/removal owns a hard teardown, not an invisible orphan. */
  remove(id: string): void {
    const overlay = this.overlays.get(id);
    if (!overlay) return;
    overlay.hour?.destroy();
    overlay.minute?.destroy();
    this.overlays.delete(id);
  }

  destroy(): void {
    for (const id of [...this.overlays.keys()]) this.remove(id);
  }

  private ensureImages(overlay: ClockOverlay): boolean {
    if (overlay.hour && overlay.minute) return true;
    if (!ensureKeepClockTexture(this.scene)) return false;
    overlay.hour = this.scene.add.image(0, 0, TEXTURE_KEY, 'hour_0').setOrigin(0.5, 0.5);
    overlay.minute = this.scene.add.image(0, 0, TEXTURE_KEY, 'minute_0').setOrigin(0.5, 0.5);
    return true;
  }

  private hide(overlay: ClockOverlay): void {
    overlay.hour?.setVisible(false);
    overlay.minute?.setVisible(false);
  }

  private nowMs(): number {
    const value = this.now();
    return typeof value === 'number' ? value : value.getTime();
  }

  private refreshTransform(overlay: ClockOverlay): void {
    const body = overlay.body;
    const face = resolveKeepClockFace(this.metadata, String(body.frame.name), overlay.level);
    if (!face || !body.active || !body.visible || body.alpha <= 0 || !this.ensureImages(overlay)) {
      this.hide(overlay);
      return;
    }
    const hour = overlay.hour!;
    const minute = overlay.minute!;
    const [canvasWidth, canvasHeight] = face.canvasPx;
    let localX = face.pivotPx[0] - body.originX * canvasWidth;
    let localY = face.pivotPx[1] - body.originY * canvasHeight;
    if (body.flipX) localX = -localX;
    if (body.flipY) localY = -localY;
    const x = Math.round(body.x + localX * body.scaleX);
    const y = Math.round(body.y + localY * body.scaleY);
    const handScaleX = Math.abs(body.scaleX) * face.handScale;
    const handScaleY = Math.abs(body.scaleY) * face.handScale;
    // Dirty checks against the hands' own state: Phaser's Depth setter has no
    // equality check and every write queues a display-list sort, and the
    // transform/alpha setters each mark the render tree dirty. A KEEP that has
    // not moved must cost the scene nothing per frame.
    if (hour.x !== x || hour.y !== y) {
      hour.setPosition(x, y);
      minute.setPosition(x, y);
    }
    if (hour.scaleX !== handScaleX || hour.scaleY !== handScaleY) {
      hour.setScale(handScaleX, handScaleY);
      minute.setScale(handScaleX, handScaleY);
    }
    const hourDepth = body.depth + 0.1;
    const minuteDepth = body.depth + 0.2;
    if (hour.depth !== hourDepth) hour.setDepth(hourDepth);
    if (minute.depth !== minuteDepth) minute.setDepth(minuteDepth);
    if (hour.alpha !== body.alpha) {
      hour.setAlpha(body.alpha);
      minute.setAlpha(body.alpha);
    }
    if (!hour.visible || !minute.visible) {
      hour.setVisible(true);
      minute.setVisible(true);
    }

  }

  private refreshClock(overlay: ClockOverlay, nowMs: number, force: boolean): void {
    if (!overlay.hour || !overlay.minute || !overlay.hour.visible || !overlay.minute.visible) return;
    const minuteStamp = Math.floor(nowMs / 60_000);
    if (!force && overlay.lastMinuteStamp === minuteStamp) return;
    const localTime = new Date(nowMs);
    const frames = keepClockFrameIndices(localTime);
    overlay.hour.setTexture(TEXTURE_KEY, `hour_${frames.hour}`);
    overlay.minute.setTexture(TEXTURE_KEY, `minute_${frames.minute}`);
    overlay.lastMinuteStamp = minuteStamp;
  }
}
