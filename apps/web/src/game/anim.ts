/**
 * The single global animation clock (HANDOFF §4: ONE 260ms ticker drives every
 * data-anim sequence; walk cycles play f1,f2,f3,f2). Each scene owns one
 * AnimTicker; sprites register a sequence and the ticker swaps frames.
 *
 * Facing (HANDOFF §2.4): only s/n/e frames exist — west = flipX of east.
 */
import type Phaser from 'phaser';
import { LEVELED_TROOPS } from '@shardkeep/shared';

export const ANIM_TICK_MS = 260;

export type Dir = 's' | 'n' | 'e';

interface Entry {
  atlas: string;
  seq: string[];
  i: number;
}

export class AnimTicker {
  private entries = new Map<Phaser.GameObjects.Sprite, Entry>();
  private timer: Phaser.Time.TimerEvent | null = null;

  attach(scene: Phaser.Scene): void {
    // Scene instances can be restarted and attach again. Retire the prior
    // Clock owner first so one ticker never accumulates multiple loop timers.
    this.settle();
    this.timer = scene.time.addEvent({
      delay: ANIM_TICK_MS,
      loop: true,
      callback: () => this.tick(),
    });
    scene.events.once('shutdown', () => this.settle());
  }

  /** Stop the presentation loop and release its sprite inventory before a
   * large Scene Clock seek. The ticker remains reusable on the next attach. */
  settle(): void {
    this.timer?.remove();
    this.timer = null;
    this.entries.clear();
  }

  /** Register (or replace) a sprite's looping sequence. Frames must exist in `atlas`. */
  register(sprite: Phaser.GameObjects.Sprite, atlas: string, seq: string[], initialIndex = 0): void {
    if (seq.length === 0) return;
    const cur = this.entries.get(sprite);
    if (cur && cur.seq.join() === seq.join()) return; // identical — nothing to do
    // PHASE-PRESERVING SWAP. A walker that merely TURNS gets a different sequence
    // (hero_vex_walk_e_* -> hero_vex_walk_s_*) of the same length, and resetting
    // the index to 0 restarted its gait from frame 1 — mid-stride, on the spot.
    // patrol.ts calls walk() on EVERY update frame, so a facing that flaps
    // between two directions re-registered 60x/second and pinned the sprite near
    // frame 1: the "fast dribbling / dizzy shuffle" the owner reported, one frame
    // at a time and impossible to screenshot because each frame looks correct.
    // Same length = the same gait in a new direction: keep walking from where the
    // legs are. A different length is a different animation (walk <-> idle) and
    // legitimately starts over.
    const i = cur && cur.seq.length === seq.length
      ? cur.i
      : ((initialIndex % seq.length) + seq.length) % seq.length;
    this.entries.set(sprite, { atlas, seq, i });
    sprite.setTexture(atlas, seq[i]!);
    sprite.once('destroy', () => this.entries.delete(sprite));
  }

  unregister(sprite: Phaser.GameObjects.Sprite): void {
    this.entries.delete(sprite);
  }

  phase(sprite: Phaser.GameObjects.Sprite): number | null {
    return this.entries.get(sprite)?.i ?? null;
  }

  /** The looping sequence registered for `sprite`, or null when it has none. */
  sequence(sprite: Phaser.GameObjects.Sprite): readonly string[] | null {
    return this.entries.get(sprite)?.seq ?? null;
  }

  private tick(): void {
    for (const [sprite, e] of this.entries) {
      if (!sprite.active) {
        this.entries.delete(sprite);
        continue;
      }
      e.i = (e.i + 1) % e.seq.length;
      sprite.setTexture(e.atlas, e.seq[e.i]!);
    }
  }
}

/* ─────────────────────────── troop sequences ────────────────────────────
 * Everything below is ATLAS FACTS — which masters exist on disk and how they
 * were authored — not game numbers, so it lives here rather than in
 * packages/shared/src/constants.ts. Same precedent as HERO_WALK_FRAMES.
 *
 * There are two generic key families and they do NOT share frame counts:
 *   legacy  trp_<troop>_walk_e_f1     level-agnostic, on the `trp` atlas
 *   batch13 trp_dragon_l7_fly_e_f1    per-level, on the on-demand `trpdg_l7`
 * A `level` argument selects the second family and is only meaningful for the
 * troops that actually have per-level art; every other generic troop ignores
 * it and keeps rendering exactly what it rendered before batch 13. The Dragon
 * Nest's Wyrmling sim identity is deliberately rejected here: M22 renders that
 * unit exclusively through the WARE Hatchling controller.
 *
 * Getting a frame name wrong here is SILENT: Phaser draws nothing for a missing
 * frame rather than throwing. Hence the tests assert the literal strings.
 */

/** Troops with real per-level art. Taken from the shared grouping module so the
 *  packer, the on-demand loader and these sequences cannot disagree about who
 *  has `_l<N>_` keys. */
const LEVELED = new Set<string>(LEVELED_TROOPS);

const WARE_HATCHLING_REQUIRED =
  'Wyrmling must be rendered by the M22 WARE Hatchling adapter';

/** The retired generic Wyrmling keys remain in historical art masters, so an
 * accidental string build would still render instead of exposing the wiring
 * regression. Refuse the sim identity at every public generic entry point. */
function assertGenericTroop(troop: string): void {
  if (troop === 'wyrmling') throw new Error(WARE_HATCHLING_REQUIRED);
}

/** Levels of per-level art batch 13 shipped (20 masters per family on disk).
 *  An ATLAS bound, deliberately not the game's level cap: a troop levelled past
 *  the art renders the top tier instead of a missing texture. */
const LEVELED_ART_LEVELS = 20;

/** The art level to render, or null when this troop/level has no per-level art
 *  and must fall back to the legacy level-agnostic keys. Non-finite levels fall
 *  back too — legacy keys always exist, a `_lNaN_` key never would. */
function artLevel(troop: string, level?: number): number | null {
  if (level === undefined || !Number.isFinite(level)) return null;
  if (!LEVELED.has(troop)) return null;
  return Math.min(LEVELED_ART_LEVELS, Math.max(1, Math.trunc(level)));
}

/**
 * The sprite-key prefix every frame of a troop hangs off:
 * `trp_dragon_l7` when levelled, `trp_highlander` otherwise. Callers pair this
 * with atlasGroupFor() from @shardkeep/shared to find the texture it lives in.
 */
export function troopSpriteBase(troop: string, level?: number): string {
  assertGenericTroop(troop);
  const l = artLevel(troop, level);
  return l === null ? `trp_${troop}` : `trp_${troop}_l${l}`;
}

/** Locomotion art shape: how many masters, and whether the cycle has to be
 *  ping-ponged to close (f1,f2,f3,f2) or already closes itself (f6 -> f1). */
interface MoveArt {
  frames: number;
  pingpong: boolean;
}

/** House default on the `trp` atlas: 3 masters, App-parity ping-pong (HANDOFF §4). */
const LEGACY_MOVE: MoveArt = { frames: 3, pingpong: true };

/** Batch-13 dragon/giant: 6 masters authored as a TRUE cycle. Ping-ponging
 *  these would both drop frames and double up at each end. */
const LEVELED_MOVE: MoveArt = { frames: 6, pingpong: false };

/** Attack masters, east-only (west = flipX). Legacy troops ship 2 (HANDOFF §4);
 *  the batch-13 dragon/giant ship 4. */
const LEGACY_ATTACK_FRAMES = 2;
const LEVELED_ATTACK_FRAMES = 4;

/** Death masters, directionless. Legacy ships 2, batch-13 dragon/giant ship 4. */
const LEGACY_DEATH_FRAMES = 2;
const LEVELED_DEATH_FRAMES = 4;

/**
 * Levelled troops whose locomotion masters are named `fly_*` rather than
 * `walk_*`. The unlevelled Dragon still uses its historical walk family;
 * batch-13 levelled Dragon ships fly_ and Giant ships walk_.
 */
const LEVELED_FLY = new Set(['dragon']);

function moveSeq(base: string, art: MoveArt): string[] {
  const out = Array.from({ length: art.frames }, (_, i) => `${base}_f${i + 1}`);
  // ping-pong walks back down the interior frames: 3 -> f1,f2,f3,f2.
  if (art.pingpong) for (let i = art.frames - 1; i > 1; i--) out.push(`${base}_f${i}`);
  return out;
}

/** First locomotion frame for a troop, respecting the fly_/walk_ naming convention. */
export function firstMoveFrame(troop: string, dir: Dir = 's', level?: number): string {
  return walkSeq(troop, dir, level)[0]!;
}

export function walkSeq(troop: string, dir: Dir, level?: number): string[] {
  assertGenericTroop(troop);
  const l = artLevel(troop, level);
  if (l !== null) {
    const verb = LEVELED_FLY.has(troop) ? 'fly' : 'walk';
    return moveSeq(`trp_${troop}_l${l}_${verb}_${dir}`, LEVELED_MOVE);
  }
  return moveSeq(`trp_${troop}_walk_${dir}`, LEGACY_MOVE);
}

/** Per-hero walk-frame COUNTS — atlas facts (apps/web/public/atlas/hero@1x.json
 *  ships vex with 4 walk frames, theo with 8), not game numbers. */
const HERO_WALK_FRAMES: Record<'hero_vex' | 'hero_theo', number> = { hero_vex: 4, hero_theo: 8 };

/** Walk cycle for a HERO sprite on the 'hero' atlas (heroes have no west
 *  masters either — west flips east, same convention as troops). */
export function heroWalkSeq(skin: 'hero_vex' | 'hero_theo', dir: Dir): string[] {
  const d = dir === 'e' ? 'e' : dir;
  return Array.from({ length: HERO_WALK_FRAMES[skin] }, (_, i) => `${skin}_walk_${d}_f${i + 1}`);
}

/** Attack: east-only masters (HANDOFF §4), 2 frames legacy / 4 levelled. */
export function attackSeq(troop: string, level?: number): string[] {
  assertGenericTroop(troop);
  const l = artLevel(troop, level);
  const n = l === null ? LEGACY_ATTACK_FRAMES : LEVELED_ATTACK_FRAMES;
  const b = `${troopSpriteBase(troop, level)}_attack_e`;
  return Array.from({ length: n }, (_, i) => `${b}_f${i + 1}`);
}

/** Death: directionless masters, 2 frames legacy / 4 levelled. A death is a
 *  one-shot rather than a loop, so this only names the frames in order — the
 *  caller decides the timing and when to stop. */
export function deathSeq(troop: string, level?: number): string[] {
  assertGenericTroop(troop);
  const l = artLevel(troop, level);
  const n = l === null ? LEGACY_DEATH_FRAMES : LEVELED_DEATH_FRAMES;
  const b = `${troopSpriteBase(troop, level)}_death`;
  return Array.from({ length: n }, (_, i) => `${b}_f${i + 1}`);
}

/**
 * Facing from a movement delta: dominant axis wins; west = east + flipX.
 * Returns the frame direction and whether to flip.
 */
export function facing(dx: number, dy: number): { dir: Dir; flip: boolean } {
  if (Math.abs(dx) >= Math.abs(dy)) return { dir: 'e', flip: dx < 0 };
  return { dir: dy > 0 ? 's' : 'n', flip: false };
}
