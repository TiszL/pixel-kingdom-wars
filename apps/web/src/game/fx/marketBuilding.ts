/**
 * Market building presentation controller (C3): owns one Market sprite's
 * texture once its selected family — ordinary `pe_market_t<T>` or the applied
 * Artisan Awning in `pe_cosmetics` — is resident, exactly as WareBuildingFx
 * owns an M22 body. P5 drives the ordinary Workshop and Lodge bodies through
 * the same controller (their `MarketArtChoice.family`); a clip's authored
 * `playbackFrameIndices` select the frames played (the Workshop working grid
 * excludes its duplicate endpoint, construction/collapse hold theirs).
 * Both scenes drive it from real state only:
 *
 *  - home: idle loop; an initial build or a current upgrade shows the tier's
 *    authored construction one-shot and holds its scaffold (the tier is the
 *    COMPLETED level's — a queued level never selects next-tier art);
 *  - combat: damaged below half HP, the collapse one-shot on destruction, then
 *    the pack's own rubble cell. No working/ready state is ever invented here
 *    (the authored clips exist; no Market production job does).
 *
 * The texture is the ONLY thing this controller touches: seat, depth, hit area
 * and footprint stay with the scene's positioning code and shared constants.
 */
import type Phaser from 'phaser';
import type { V2Ticker } from '../v2/ticker';
import {
  marketArtClipId, marketArtGroup, type MarketArtChoice, type MarketArtState, type MarketArtTable,
} from '../world/marketArt';

export interface MarketBuildingDeps {
  ticker: V2Ticker;
  art: MarketArtTable;
  choice: MarketArtChoice;
  /** Base ambience only; one-shots keep their authored clock. */
  restLoopSpeed?: number;
  /** prefers-reduced-motion: every state rests on its authored reduced frame. */
  reducedMotion?: boolean;
}

export type MarketJobKind = 'build' | 'upgrade' | null;

export class MarketBuildingFx {
  readonly atlas: string;
  private token = 0;
  private jobKind: MarketJobKind = null;
  private damaged = false;
  private collapsed = false;

  constructor(
    private deps: MarketBuildingDeps,
    private sprite: Phaser.GameObjects.Sprite,
  ) {
    this.atlas = marketArtGroup(deps.choice);
    this.rest();
  }

  private clip(state: MarketArtState) {
    return this.deps.art.clips[marketArtClipId(this.deps.choice, state)];
  }

  /** Register one state with the per-clip ticker. Statics (fps 0) and reduced
   *  motion display a single held frame; the ticker sets the texture itself. */
  private play(
    state: MarketArtState, loop: boolean, onComplete?: () => void, hold?: { atlas: string; frame: string },
  ): boolean {
    const clip = this.clip(state);
    if (!clip || !this.sprite.active) return false;
    const base = marketArtClipId(this.deps.choice, state);
    if (this.deps.reducedMotion || clip.fps <= 0) {
      const frame = clip.frames[clip.reducedMotionFrame] ?? clip.frames[0]!;
      this.deps.ticker.play(this.sprite, { atlas: clip.atlas, base, seq: [frame], fps: 0, loop: false });
      if (hold) this.sprite.setTexture(hold.atlas, hold.frame);
      onComplete?.();
      return true;
    }
    const seq = clip.playbackFrameIndices ? clip.playbackFrameIndices.map((index) => clip.frames[index]!) : [...clip.frames];
    this.deps.ticker.play(this.sprite, {
      atlas: clip.atlas, base, seq,
      fps: clip.fps * (loop ? this.deps.restLoopSpeed ?? 1 : 1),
      loop,
      onComplete,
      hold,
    });
    return true;
  }

  private rest(): void {
    if (this.collapsed || !this.sprite.active) return;
    if (this.damaged) {
      if (!this.play('damaged', false)) this.play('idle', true);
      return;
    }
    if (this.jobKind !== null) {
      // One-shot scaffold held on its authored final frame for the job's life.
      if (this.play('construction', false)) return;
    }
    this.play('idle', true);
  }

  /** Home only: an initial build or a current-level upgrade in progress. */
  setJob(kind: string | null): void {
    const next: MarketJobKind = kind === 'build' || kind === 'upgrade' ? kind : null;
    if (this.jobKind === next) return;
    this.jobKind = next;
    this.rest();
  }

  setDamaged(damaged: boolean): void {
    if (this.damaged === damaged) return;
    this.damaged = damaged;
    this.rest();
  }

  /** Combat destruction: the authored collapse, then the pack's rubble cell.
   *  Later rest requests cannot repaint the ruin (stale idle is refused). */
  collapse(): void {
    if (this.collapsed || !this.sprite.active) return;
    this.collapsed = true;
    this.token++;
    const rubble = this.clip('destroyed');
    const hold = rubble ? { atlas: rubble.atlas, frame: rubble.frames[rubble.reducedMotionFrame] ?? rubble.frames[0]! } : undefined;
    // A family without an authored collapse rests straight on its rubble cell.
    if (!this.play('collapse', false, undefined, hold) && hold) this.sprite.setTexture(hold.atlas, hold.frame);
  }

  destroy(): void {
    this.token++;
    this.collapsed = true;
    this.deps.ticker.unregister(this.sprite);
  }
}

/** Static cell for a seek/resume or an art-less fallback: the frame a state
 *  rests on, or null when the family lacks it. Used without a controller. */
export function marketStaticFrame(
  art: MarketArtTable, choice: MarketArtChoice, state: 'damaged' | 'destroyed' | 'idle',
): { atlas: string; frame: string } | null {
  const clip = art.clips[marketArtClipId(choice, state)];
  if (!clip) return null;
  return { atlas: clip.atlas, frame: clip.frames[clip.reducedMotionFrame] ?? clip.frames[0]! };
}
