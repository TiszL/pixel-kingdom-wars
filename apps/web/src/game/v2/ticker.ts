/**
 * V2Ticker — per-clip-fps playback for the rework-v2 sprites.
 *
 * The legacy AnimTicker (game/anim.ts) is ONE global 260ms clock, which is
 * exactly right for the batch-13 art (authored to a house cadence) and stays
 * in place for every legacy sprite. The v2 pack instead ships a per-clip fps
 * in its manifest (idle 3fps … muzzle 20fps), so v2 sprites need a per-sprite
 * accumulator advanced from the scene's real elapsed dt — a global tick would
 * play a 3fps idle and a 20fps flash at the same wrong speed.
 *
 * Mirrors AnimTicker's lifecycle: one instance per scene, attach(scene) wires
 * the update/shutdown events, sprites register and are dropped on destroy.
 *
 * PHASE-PRESERVING DIRECTION SWAPS. anim.ts documents the "dizzy shuffle"
 * bug: a walker that merely TURNS gets a new sequence, and resetting the frame
 * index restarts the gait mid-stride — re-registered every frame by a wobbling
 * heading, the sprite pins near frame 1 forever. Same clip + same length with
 * only a NEW ROW is the same gait in a new direction: keep the frame index and
 * the accumulator. Anything else (a different clip, a different length) is a
 * different animation and legitimately starts over.
 */
import type Phaser from 'phaser';

/** Phaser.Scenes.Events.UPDATE / SHUTDOWN, spelled out so this module needs
 *  only a type import of phaser (atlasLoader.ts precedent). */
const SCENE_UPDATE = 'update';
const SCENE_SHUTDOWN = 'shutdown';

export interface V2Play {
  atlas: string;
  /** clip base key, e.g. 'v2_trp_giant_t1_walk'. */
  base: string;
  /** ordered frame names of the row being played. */
  seq: string[];
  fps: number;
  loop: boolean;
  /** called ONCE each time a frame is entered (1-based frame number) — the
   *  fxAt hook. Fired for frame 1 synchronously on registration. */
  onFrame?: ((frame1: number) => void) | undefined;
  /** one-shots only: fired when the last frame's dwell time has elapsed. The
   *  sprite HOLDS the last frame; the entry is dropped before the callback so
   *  onComplete may immediately register the follow-up loop. */
  onComplete?: (() => void) | undefined;
  /** one-shots only: the cell the sprite rests on INSTEAD of the authored
   *  final frame, applied both on natural completion (before onComplete) and
   *  when a verdict settles the field. For packs whose collapse is a sink
   *  with no ruin cell (ware/ruin.ts); `frame` omitted = the texture's base. */
  hold?: { atlas: string; frame?: string } | undefined;
}

interface Entry extends V2Play {
  i: number;
  /** ms accumulated toward the next frame step. */
  acc: number;
  done: boolean;
  /** First tick generation allowed to advance this entry. An onComplete
   * callback can insert into the live Map without being charged the finishing
   * clip's already-consumed delta. */
  eligibleTick: number;
}

export interface V2Phase { index: number; accumulatedMs: number }

export class V2Ticker {
  private entries = new Map<Phaser.GameObjects.Sprite, Entry>();
  private handler: ((time: number, delta: number) => void) | null = null;
  private tickGeneration = 0;
  private ticking = false;
  private timeScale = 1;

  attach(scene: Phaser.Scene): void {
    this.handler = (_time: number, delta: number) => this.tick(delta);
    scene.events.on(SCENE_UPDATE, this.handler);
    scene.events.once(SCENE_SHUTDOWN, () => {
      if (this.handler) scene.events.off(SCENE_UPDATE, this.handler);
      this.handler = null;
      this.entries.clear();
      this.timeScale = 1;
    });
  }

  /**
   * Register (or replace) a sprite's clip. Identical registration is a no-op;
   * same base + same length with a different seq (a row change) keeps phase.
   */
  play(sprite: Phaser.GameObjects.Sprite, p: V2Play, initialPhase?: V2Phase | null): void {
    if (p.seq.length === 0) return;
    if (p.fps <= 0) {
      // K-053(2): an authored `fps: 0` clip is a STATIC state sheet — the
      // damaged walls deliberately ship fps 0 — so display frame 0 and hold.
      // The old refusal returned before setting a texture, which left the
      // intact body on screen while the controller believed damage was shown.
      this.entries.delete(sprite);
      sprite.setTexture(p.atlas, p.seq[0]!);
      p.onFrame?.(1);
      return;
    }
    const cur = this.entries.get(sprite);
    if (cur && cur.base === p.base && cur.seq.join() === p.seq.join() && !cur.done) {
      return; // identical — keep playing exactly as-is
    }
    if (cur && cur.base === p.base && cur.seq.length === p.seq.length && !cur.done) {
      // Phase-preserving row swap: same clip, new facing — keep the stride.
      cur.seq = p.seq;
      cur.onFrame = p.onFrame;
      cur.onComplete = p.onComplete;
      sprite.setTexture(p.atlas, p.seq[cur.i]!);
      return;
    }
    const i = initialPhase
      ? ((initialPhase.index % p.seq.length) + p.seq.length) % p.seq.length
      : 0;
    const e: Entry = {
      ...p, i, acc: initialPhase?.accumulatedMs ?? 0, done: false,
      eligibleTick: this.tickGeneration + (this.ticking ? 1 : 0),
    };
    this.entries.set(sprite, e);
    sprite.setTexture(p.atlas, p.seq[i]!);
    sprite.once('destroy', () => {
      if (this.entries.get(sprite) === e) this.entries.delete(sprite);
    });
    p.onFrame?.(i + 1);
  }

  unregister(sprite: Phaser.GameObjects.Sprite): void {
    this.entries.delete(sprite);
  }

  phase(sprite: Phaser.GameObjects.Sprite): V2Phase | null {
    const entry = this.entries.get(sprite);
    return entry ? { index: entry.i, accumulatedMs: entry.acc } : null;
  }

  /** Keep authored V2 clips on the same clock as Phaser timers/tweens while a
   * hidden-tab debt is repaid. The scale is presentation-only. */
  setTimeScale(scale: number): void {
    this.timeScale = Number.isFinite(scale) && scale >= 0 ? scale : 1;
  }

  /** A verdict owns a stable field, never controllers still advancing behind
   * it. One-shots hold their authored final frame; loops simply stop. */
  settle(): void {
    for (const [sprite, entry] of this.entries) {
      if (sprite.active && !entry.loop) {
        if (entry.hold) sprite.setTexture(entry.hold.atlas, entry.hold.frame);
        else sprite.setTexture(entry.atlas, entry.seq.at(-1)!);
      }
    }
    this.entries.clear();
  }

  get size(): number { return this.entries.size; }

  /** Advance every entry by `dtMs` of real elapsed time. Generation-gated: an
   *  entry registered DURING this pass (an onComplete chaining fire→reload)
   *  starts fresh next tick — advancing it now would double-count the dt that
   *  the finishing clip already consumed. This avoids allocating a complete
   *  `[...Map]` snapshot on every rendered frame. */
  tick(dtMs: number): void {
    const generation = ++this.tickGeneration;
    this.ticking = true;
    try {
      for (const [sprite, e] of this.entries) {
        if (this.entries.get(sprite) !== e || e.eligibleTick > generation) continue;
        if (!sprite.active) {
          this.entries.delete(sprite);
          continue;
        }
        if (e.done) continue;
        e.acc += dtMs * this.timeScale;
        const step = 1000 / e.fps;
        const elapsedSteps = Math.floor(e.acc / step);
        if (elapsedSteps === 0) continue;
        e.acc -= elapsedSteps * step;

        // A finite action contains at most one authored pass. Visit every
        // remaining frame so its fxAt hooks still happen exactly once, then
        // complete; work is O(sequence length), even after a ten-minute sleep.
        if (!e.loop) {
          const remainingSteps = e.seq.length - e.i;
          for (let n = 0; n < Math.min(elapsedSteps, remainingSteps); n++) {
            if (e.i + 1 < e.seq.length) {
              e.i++;
              sprite.setTexture(e.atlas, e.seq[e.i]!);
              e.onFrame?.(e.i + 1);
              continue;
            }
            e.done = true;
            this.entries.delete(sprite);
            if (e.hold) sprite.setTexture(e.hold.atlas, e.hold.frame);
            e.onComplete?.();
            break;
          }
          continue;
        }

        // Replaying expired loop cycles on foreground resume creates thousands
        // of texture writes and repeated muzzle/footstep FX. A normal delta of
        // at most one cycle retains frame-by-frame cadence; a larger gap jumps
        // directly to the current phase and emits only that visible frame.
        if (elapsedSteps >= e.seq.length) {
          e.i = (e.i + elapsedSteps) % e.seq.length;
          sprite.setTexture(e.atlas, e.seq[e.i]!);
          e.onFrame?.(e.i + 1);
          continue;
        }
        for (let n = 0; n < elapsedSteps; n++) {
          e.i = (e.i + 1) % e.seq.length;
          sprite.setTexture(e.atlas, e.seq[e.i]!);
          e.onFrame?.(e.i + 1);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
