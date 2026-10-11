/**
 * Builder job visuals (read-app-engines §6, HANDOFF §3.10, App bRender lines
 * 199–201 + builderRender lines 710–720).
 *
 * Per active builder job the App renders three things:
 *  1. an animated fx_scaffold_f1/f2 overlay stretched over the target footprint
 *     (AnimTicker, depth 2200);
 *  2. a timer chip floating above the target: ⚒ + "6d 2h" / "36m 5s" countdown (VT323) and a
 *     38×5 App-px (→76×10 world-px) progress bar with a Vault-Gold fill, live;
 *  3. the accepted Builder Workman walks from the Keep gate to the site over
 *     1.2s, then loops its hammer animation facing the target. One civilian
 *     character serves every Keep level; its lazy atlas replaces the retired
 *     Tunneler stand-in without changing any job timing or troop art.
 *
 * The server is authoritative: each job row carries startedAt/finishesAt — we
 * derive progress and remaining from those (wall-clock is fine here; this is
 * pure presentation, not the sim). The layer pools sprites per job id so the
 * animation tickers keep phase across store refreshes.
 *
 * App coords are 1× game px; scene is 2× → ×(T/32). The keep-gate spawn and
 * site target offsets are ported verbatim from builderRender.
 */
import type Phaser from 'phaser';
import { fmtDur } from '../../lib/duration';
import { AMBIENCE } from '@shardkeep/shared';
import type { AnimTicker } from '../anim';
import { atlasFor, type MetaMap } from '../scenes/BootScene';
import {
  clipFrames, facing8, facingRow, V2_DIRS, type Facing8, type V2ClipMap,
} from '../v2/clips';
import type { V2Ticker } from '../v2/ticker';
import { actorDepth, buildingDepth, overlayDepth } from './depth';
import type { BaseStateDto } from '../../state/store';
import { jobChipTextTopOffset } from './worldChipGeometry';

type Job = BaseStateDto['jobs'][number];
type Building = BaseStateDto['buildings'][number];
type Obstacle = BaseStateDto['obstacles'][number];

// WORLD_DEPTH bands. The scaffold is a STRUCTURE, so it sorts in the building
// band on the site's own south edge — it used to sit at a flat 2200, above
// every building on the base. The timer chip is world UI. The builder is an
// ACTOR and now sorts on his feet like every other one: at the old flat 2230 he
// walked over the Keep he was standing behind.
const CHIP_DEPTH = overlayDepth(2210);
const WALK_MS = 1200; // App: keep→site in 1.2s linear (cutover at job age 1300ms)

interface Rect { tx: number; ty: number; fw: number; fh: number }

type BuilderState = 'walk' | 'work';

interface BuilderAnimationSpec {
  atlas: string;
  base: string;
  seq: string[];
  fps: number;
  origin: readonly [number, number];
}

/** Request and adoption share the same complete directional clip contract. */
export function requiredBuilderAtlasGroups(clips: V2ClipMap = {}): string[] {
  return builderSpec(clips, 'walk', 's') && builderSpec(clips, 'work', 's') ? ['builder'] : [];
}

function builderSpec(
  clips: V2ClipMap,
  state: BuilderState,
  facing: Facing8,
): BuilderAnimationSpec | null {
  const base = `builder_${state}`;
  const clip = clips[base];
  const anchor = clip?.anchorPx;
  if (!clip || !anchor || !anchor.every(Number.isFinite)
    || !Number.isInteger(clip.frames) || clip.frames <= 0
    || !(clip.cellW > 0) || !(clip.cellH > 0)
    || !(clip.fps && Number.isFinite(clip.fps) && clip.fps > 0)
    || clip.rows !== V2_DIRS.length || clip.rowOrder?.length !== V2_DIRS.length
    || !V2_DIRS.every(direction => clip.rowOrder!.includes(direction))) return null;
  return {
    atlas: 'builder', base,
    seq: clipFrames(base, clip, facingRow(clip, facing)),
    fps: clip.fps,
    origin: [anchor[0] / clip.cellW, anchor[1] / clip.cellH],
  };
}

interface JobVis {
  scaffold: Phaser.GameObjects.Sprite;
  chipBg: Phaser.GameObjects.Rectangle;
  chipText: Phaser.GameObjects.Text;
  barBg: Phaser.GameObjects.Rectangle;
  barFill: Phaser.GameObjects.Rectangle;
  builder: Phaser.GameObjects.Sprite | null;
  startMs: number;
  endMs: number;
  /** builder walk path in world px. */
  sx: number; sy: number; ex: number; ey: number;
  walking: boolean;
  /** site footprint, world px, for the bar/chip width + scaffold size. */
  rect: Rect;
  /** Widest label width, so the bar never shifts as the countdown shortens. */
  chipW: number;
}

export class JobLayer {
  private vis = new Map<string, JobVis>();
  private readonly builderClips: V2ClipMap;
  /** Wall-clock second the chips were last laid out for (armyStatus pattern).
   * NaN forces the next update() to re-lay every chip, which sync() uses after
   * it may have moved a chip or created one. */
  private lastSecond = Number.NaN;

  constructor(
    private scene: Phaser.Scene,
    private ticker: AnimTicker,
    private v2Ticker: V2Ticker,
    private meta: MetaMap,
    /** world px per tile (64). */
    private T: number,
  ) {
    this.builderClips = (this.scene.registry.get('builderClips') as V2ClipMap | undefined) ?? {};
  }

  private createBuilder(
    x: number,
    y: number,
    spec: BuilderAnimationSpec,
  ): Phaser.GameObjects.Sprite {
    return this.scene.add.sprite(x, y, spec.atlas, spec.seq[0]!)
      .setOrigin(...spec.origin)
      .setScale(AMBIENCE.builderScale * this.T / 32)
      .setDepth(actorDepth(y));
  }

  private builderFacing(v: JobVis, state: BuilderState): Facing8 {
    return state === 'walk' ? facing8(v.ex - v.sx, v.ey - v.sy)
      : facing8((v.rect.tx + v.rect.fw / 2) * this.T - v.ex,
        (v.rect.ty + v.rect.fh / 2) * this.T - v.ey);
  }

  private playBuilder(v: JobVis, state: BuilderState): void {
    if (!v.builder) return;
    const spec = builderSpec(this.builderClips, state, this.builderFacing(v, state));
    if (!spec) return;
    v.builder.setOrigin(...spec.origin).setScale(AMBIENCE.builderScale * this.T / 32);
    this.v2Ticker.play(v.builder, { ...spec, loop: true });
  }

  /** Late atlas arrival adopts the live job's current phase before the sweep.
   * Missing art never falls back to a different character or changes timers. */
  private syncBuilder(v: JobVis): void {
    if (!this.scene.textures.exists('builder') || requiredBuilderAtlasGroups(this.builderClips).length === 0) {
      if (v.builder) {
        this.v2Ticker.unregister(v.builder);
        v.builder.destroy();
        v.builder = null;
      }
      return;
    }
    const state = v.walking ? 'walk' : 'work';
    if (!v.builder) {
      const spec = builderSpec(this.builderClips, state, this.builderFacing(v, state));
      if (spec) v.builder = this.createBuilder(v.walking ? v.sx : v.ex, v.walking ? v.sy : v.ey, spec);
    }
    this.playBuilder(v, state);
  }

  /** Resolve a job's target footprint rect (building upgrade/new, or obstacle clear). */
  private targetRect(
    job: Job,
    buildings: Building[],
    obstacles: Obstacle[],
    footprintOf: (key: string) => { fw: number; fh: number },
    spriteKeyFor: (b: Building) => string,
  ): Rect | null {
    if (job.buildingId) {
      const b = buildings.find((x) => x.id === job.buildingId);
      if (!b) return null;
      const fp = footprintOf(spriteKeyFor(b));
      return { tx: b.tx, ty: b.ty, fw: fp.fw, fh: fp.fh };
    }
    if (job.obstacleId) {
      const o = obstacles.find((x) => x.id === job.obstacleId);
      if (!o) return null;
      const size = this.meta[`dec_${o.spriteKey}`]?.footprint?.[0] ?? 1;
      return { tx: o.tx, ty: o.ty, fw: size, fh: size };
    }
    return null;
  }

  /**
   * Rebuild from store: one visual set per active job. `keep` is the keep
   * building. Returns the footprint rects of jobs that disappeared since the
   * last sync (completed) so the caller can pop a dust puff over each.
   */
  sync(
    jobs: Job[],
    buildings: Building[],
    obstacles: Obstacle[],
    keep: Building | undefined,
    footprintOf: (key: string) => { fw: number; fh: number },
    spriteKeyFor: (b: Building) => string,
  ): Rect[] {
    const T = this.T;
    const s = T / 32;
    const seen = new Set<string>();
    for (const job of jobs) {
      const rect = this.targetRect(job, buildings, obstacles, footprintOf, spriteKeyFor);
      if (!rect) continue;
      seen.add(job.id);

      const left = rect.tx * T;
      const yB = (rect.ty + rect.fh) * T;
      const top = yB - rect.fh * T;
      // builder spawn (keep gate) + site target, App builderRender geometry
      const kx = keep ? (keep.tx + 1) * T - 12 * s : left; // (keep.tx+1)*32−12 App px
      const kFp = keep ? footprintOf(spriteKeyFor(keep)) : { fw: 2, fh: 2 };
      const ky = keep ? (keep.ty + kFp.fh) * T - 20 * s : top;
      // The scaled Workman's hammer reaches the scaffold from this foot-anchor gap.
      const ex = left - AMBIENCE.builderSiteGapPx * s;
      const ey = (rect.ty + rect.fh) * T - 26 * s; // (t.ty+fh)*32−26 App px
      const startMs = Date.parse(job.startedAt);
      const endMs = Date.parse(job.finishesAt);

      let v = this.vis.get(job.id);
      if (!v) {
        // 1. scaffold over the footprint (stretched), animated f1/f2
        const scaffold = this.scene.add
          .sprite(left, top, atlasFor('fx_scaffold_f1'), 'fx_scaffold_f1')
          .setOrigin(0, 0)
          .setDisplaySize(rect.fw * T, rect.fh * T)
          .setDepth(buildingDepth((rect.ty + rect.fh) * T));
        this.ticker.register(scaffold, atlasFor('fx_scaffold_f1'), ['fx_scaffold_f1', 'fx_scaffold_f2']);

        // 2. timer chip: bg panel + ⚒ fmtDur text ("6d 2h") + 76×10 progress bar
        const chipBg = this.scene.add
          .rectangle(0, 0, 10, 10, 0x14121a, 0.92)
          .setOrigin(0, 0)
          .setStrokeStyle(2, 0x3d3833)
          .setDepth(CHIP_DEPTH);
        const chipText = this.scene.add
          .text(0, 0, '', { fontFamily: 'VT323, monospace', fontSize: '20px', color: '#F4D77B' })
          .setOrigin(0, 0)
          .setDepth(CHIP_DEPTH + 1);
        // Measure the widest countdown once; the layout below never shrinks
        // below it, so the bar holds still as the label shortens.
        chipText.setText('⚒ 59m 59s');
        const chipW = chipText.width;
        chipText.setText('');
        const barBg = this.scene.add
          .rectangle(0, 0, 76, 10, 0x3d3833, 1)
          .setOrigin(0, 0)
          .setDepth(CHIP_DEPTH + 1);
        const barFill = this.scene.add
          .rectangle(0, 0, 0, 10, 0xe3ae3c, 1) // Vault Gold
          .setOrigin(0, 0)
          .setDepth(CHIP_DEPTH + 2);

        v = {
          scaffold, chipBg, chipText, chipW, barBg, barFill,
          builder: null,
          startMs, endMs, sx: kx, sy: ky, ex, ey, walking: true, rect,
        };
        this.vis.set(job.id, v);
      } else {
        // keep timings/positions current (target may have moved between syncs)
        v.startMs = startMs;
        v.endMs = endMs;
        v.sx = kx; v.sy = ky; v.ex = ex; v.ey = ey; v.rect = rect;
        v.scaffold.setPosition(left, top).setDisplaySize(rect.fw * T, rect.fh * T)
          .setDepth(buildingDepth((rect.ty + rect.fh) * T));
        // if the target moved after the walk finished, snap the builder onto the
        // new site so it never sits at the old footprint (R3; App builderRender
        // re-renders the work frame at the new target every render). Mid-walk
        // the lerp already drives toward the updated ex/ey.
        if (!v.walking) v.builder?.setPosition(ex, ey).setDepth(actorDepth(ey));
      }
      this.syncBuilder(v);
      // anchor the chip above the site top edge (App: top−26 App px)
      v.chipText.setPosition(left + 22 * s, top - jobChipTextTopOffset(T));
    }

    const completed: Rect[] = [];
    for (const [id, v] of this.vis) {
      if (!seen.has(id)) {
        completed.push(v.rect);
        this.disposeJob(id, v);
      }
    }
    // A chip may have been created or re-anchored above: lay it out on the
    // very next frame instead of waiting for the second boundary.
    this.lastSecond = Number.NaN;
    return completed;
  }

  /**
   * Per-frame: walk lerp + cutover to work. The countdown label and the
   * chip/bar layout change only on a wall-clock second boundary (D-101,
   * M33 package D): a Text.setText rasterises a canvas and each
   * Rectangle.setSize/setPosition is a layout write — at 60 fps that was the
   * remaining per-frame CPU cost of an idle base on the Seeker, for a label
   * whose value only changes once a second.
   */
  update(nowMs: number): void {
    const T = this.T;
    const s = T / 32;
    const second = Math.floor(nowMs / 1_000);
    const refreshChips = second !== this.lastSecond;
    if (refreshChips) this.lastSecond = second;
    for (const v of this.vis.values()) {
      // builder walk → work cutover
      const age = nowMs - v.startMs;
      if (v.walking) {
        const k = Math.min(1, Math.max(0, age / WALK_MS));
        const by = v.sy + (v.ey - v.sy) * k;
        v.builder?.setPosition(v.sx + (v.ex - v.sx) * k, by).setDepth(actorDepth(by));
        if (k >= 1) {
          v.walking = false;
          this.playBuilder(v, 'work');
        }
      }

      if (!refreshChips) continue;

      // live countdown + progress
      const remMs = Math.max(0, v.endMs - nowMs);
      const totalMs = Math.max(1, v.endMs - v.startMs);
      const prog = Math.min(1, Math.max(0, 1 - remMs / totalMs));
      const remSec = Math.ceil(remMs / 1000);
      v.chipText.setText(remSec > 0 ? `⚒ ${fmtDur(remSec)}` : '⚒ DONE');

      // Lay the bar to the right of the text, chip bg wrapping both. The label
      // is measured against its widest form ("⚒ 59m 59s") so the bar and the
      // chip edge hold still while the countdown shortens.
      const tx = v.chipText.x;
      const ty = v.chipText.y;
      const tw = Math.max(v.chipText.width, v.chipW);
      const barX = tx + tw + 6 * s;
      const barY = ty + (v.chipText.height - 10) / 2;
      v.barBg.setPosition(barX, barY).setSize(76, 10);
      v.barFill.setPosition(barX, barY).setSize(76 * prog, 10);
      v.chipBg
        .setPosition(tx - 6 * s, ty - 2 * s)
        .setSize(tw + 76 + 18 * s, v.chipText.height + 4 * s);
    }
  }

  private disposeJob(id: string, v: JobVis): void {
    this.ticker.unregister(v.scaffold);
    if (v.builder) this.v2Ticker.unregister(v.builder);
    v.scaffold.destroy();
    v.chipBg.destroy();
    v.chipText.destroy();
    v.barBg.destroy();
    v.barFill.destroy();
    v.builder?.destroy();
    this.vis.delete(id);
  }

  /** Job ids removed since last sync (completed) — caller pops a dust puff. */
  destroy(): void {
    for (const [id, v] of [...this.vis]) this.disposeJob(id, v);
  }
}
