/**
 * Runtime controllers for the owner-authored M22 building/trap pack.
 *
 * The eager aliases guarantee that a current silhouette is drawable before an
 * optional atlas arrives. Once a complete unit+progression group is resident,
 * these controllers adopt the authored per-state clips without ever crossing
 * back through batch-13 or generic-rubble art.
 */
import {
  AUTHORED_ATTACK_TIMINGS,
  DEFENSE_PROJECTILE_TIMINGS,
  WARE_BUILDING_ART,
  WARE_TRAP_ART,
  artTierOfLevel,
  atlasGroupFor,
  type WareBuildingUnit,
  type WareTrapUnit,
} from '@shardkeep/shared';
import type Phaser from 'phaser';
import { combatEffectPool } from '../v2/effects';
import {
  V2_DRAW_SCALE,
  clipFrames,
  emitterPoint,
  facing8,
  facingRow,
  frameName,
  headingRow,
} from '../v2/clips';
import type { V2Ticker } from '../v2/ticker';
import {
  wareBuildingClipKey,
  wareClipFrames,
  wareFrame,
  wareHatchlingClipKey,
  wareSeat,
  wareTrapClipKey,
  type WareClip,
  type WareClipMap,
} from './clips';
import { overlayDepth } from '../world/depth';

export type WareShotKind =
  | 'arrow' | 'magebolt' | 'tesla' | 'laser' | 'harpoon'
  | 'trebuchet' | 'keepoil' | 'keepbolt' | 'hatchfire';

export interface WareFirePlan {
  states: readonly string[];
  releaseState: string;
  releaseFrame: number;
  shot: WareShotKind;
}

/** Pure, testable authored action selection. `nearKeep` chooses oil vs bolt;
 * both are the same authoritative close-battery hit in the simulator. */
export function wareFirePlan(
  unit: WareBuildingUnit,
  projectile: 'cannonball' | 'arrow' | 'shell' | 'beam',
  nearKeep = false,
): WareFirePlan | null {
  switch (unit) {
    case 'archertower':
      return { states: ['fire', 'reload'], releaseState: 'fire', releaseFrame: 2, shot: 'arrow' };
    case 'electrictower':
      return { states: ['charge', 'discharge'], releaseState: 'discharge', releaseFrame: 2, shot: 'tesla' };
    case 'magetower':
      return { states: ['cast', 'burst'], releaseState: 'burst', releaseFrame: 2, shot: 'magebolt' };
    case 'lasertower':
      return { states: ['charge', 'fire'], releaseState: 'fire', releaseFrame: 2, shot: 'laser' };
    case 'airdefence':
      return { states: ['track', 'fire', 'reel', 'reload'], releaseState: 'fire', releaseFrame: 3, shot: 'harpoon' };
    case 'keep':
      if (projectile === 'shell') {
        return { states: ['hr_load', 'hr_fire'], releaseState: 'hr_fire', releaseFrame: 2, shot: 'trebuchet' };
      }
      if (projectile === 'cannonball') {
        return {
          states: ['lr_fire'], releaseState: 'lr_fire', releaseFrame: 2,
          shot: nearKeep ? 'keepoil' : 'keepbolt',
        };
      }
      return null;
    default:
      return null;
  }
}

export interface WareShotRelease {
  kind: WareShotKind;
  row: number;
  clip: WareClip;
  frame1: number;
  targetX: number;
  targetY: number;
}

export interface WareBuildingDeps {
  ticker: V2Ticker;
  clips: WareClipMap;
  unit: WareBuildingUnit;
  level: number;
  /** Base ambience only. One-shot actions always retain their authored clock. */
  restLoopSpeed?: number;
  onShot?: (release: WareShotRelease) => void;
  /** Resident plain-texture key this unit rests on after its collapse clip,
   * resolved AT collapse time (ware/ruin.ts). Null/absent = hold the authored
   * final cell, which is right for every unit that authors real rubble. */
  ruinTexture?: () => string | null;
}

export class WareBuildingFx {
  private token = 0;
  private damaged = false;
  private collapsed = false;
  private working = false;
  private jobKind: 'build' | 'upgrade' | null = null;
  /** The owner pack defines `levelup` as a short shared flash, not an hours-long
   * upgrade scaffold. Keep its callback separate from combat's action token so
   * job refreshes can invalidate the flash without stranding an active shot. */
  private levelupToken = 0;
  private levelupPending = false;
  private levelupPlaying = false;
  private acting = false;
  private aimRow = 0;
  private keepRest: 'idle' | 'hr_idle' | 'lr_idle' = 'idle';
  readonly atlas: string;

  constructor(
    private deps: WareBuildingDeps,
    private sprite: Phaser.GameObjects.Sprite,
  ) {
    const idleBase = wareBuildingClipKey(deps.unit, deps.level, 'idle');
    this.atlas = atlasGroupFor(`${idleBase}_f1`);
    const first = wareFrame(deps.clips, idleBase, 0, 1);
    const seat = first ? wareSeat(deps.clips, first) : null;
    if (seat) sprite.setOrigin(seat.origin[0], seat.origin[1]).setScale(seat.scale);
    this.rest();
  }

  private base(state: string): string {
    return wareBuildingClipKey(this.deps.unit, this.deps.level, state);
  }

  private clip(state: string): WareClip | undefined {
    return this.deps.clips[this.base(state)];
  }

  private play(
    state: string,
    row: number,
    loop: boolean,
    onFrame?: (frame1: number, clip: WareClip) => void,
    onComplete?: () => void,
    hold?: { atlas: string; frame?: string },
  ): boolean {
    const clip = this.clip(state);
    if (!clip) return false;
    this.deps.ticker.play(this.sprite, {
      atlas: this.atlas,
      base: this.base(state),
      seq: wareClipFrames(this.deps.clips, this.base(state), Math.min(row, clip.rows - 1)),
      fps: (clip.fps ?? 8) * (loop ? this.deps.restLoopSpeed ?? 1 : 1),
      loop,
      onFrame: onFrame ? (frame1) => onFrame(frame1, clip) : undefined,
      onComplete,
      hold,
    });
    return true;
  }

  private rest(): void {
    if (this.collapsed || !this.sprite.active) return;
    if (this.levelupPending && this.jobKind === null) {
      this.levelupPending = false;
      const token = ++this.levelupToken;
      this.levelupPlaying = true;
      if (this.play('levelup', this.aimRow, false, undefined, () => {
        if (this.levelupToken !== token || this.collapsed || !this.sprite.active) return;
        this.levelupPlaying = false;
        this.rest();
      })) return;
      this.levelupPlaying = false;
    }
    let state = this.damaged ? 'damaged'
      : this.jobKind !== null ? 'build'
        : this.working ? 'work' : 'idle';
    if (!this.damaged && this.jobKind === null && !this.working && this.deps.unit === 'keep') {
      state = this.keepRest;
    }
    const loop = this.jobKind === null;
    if (!this.play(state, this.aimRow, loop) && state !== 'idle') {
      this.play('idle', this.aimRow, true);
    }
  }

  setWorking(working: boolean): void {
    if (this.working === working) return;
    this.working = working;
    if (!this.acting && !this.levelupPlaying) this.rest();
  }

  setJob(kind: string | null): void {
    const next = kind === 'build' || kind === 'upgrade' ? kind : null;
    if (this.jobKind === next) return;
    const prior = this.jobKind;
    this.jobKind = next;
    // Any job transition owns the sprite now. A late completion from an older
    // flash must not repaint a new scaffold or a newer presentation state.
    this.levelupToken++;
    this.levelupPlaying = false;
    this.levelupPending = prior === 'upgrade' && next === null;
    if (!this.acting) this.rest();
  }

  setDamaged(damaged: boolean): void {
    if (this.damaged === damaged) return;
    this.damaged = damaged;
    if (!this.acting && !this.levelupPlaying) this.rest();
  }

  fire(
    targetX: number,
    targetY: number,
    projectile: 'cannonball' | 'arrow' | 'shell' | 'beam',
    nearKeep = false,
  ): boolean {
    if (this.collapsed || !this.sprite.active) return false;
    const plan = wareFirePlan(this.deps.unit, projectile, nearKeep);
    if (!plan || plan.states.some((state) => !this.clip(state))) return false;
    this.levelupToken++;
    this.levelupPlaying = false;
    this.levelupPending = false;
    const token = ++this.token;
    this.acting = true;
    const directional = this.clip(plan.releaseState)!;
    this.aimRow = facingRow(
      directional,
      facing8(targetX - this.sprite.x, targetY - this.sprite.y),
    );
    if (this.deps.unit === 'keep') {
      this.keepRest = projectile === 'shell' ? 'hr_idle' : 'lr_idle';
    }
    let released = false;
    const next = (index: number): void => {
      if (this.token !== token || this.collapsed || !this.sprite.active) return;
      if (index >= plan.states.length) {
        this.acting = false;
        this.rest();
        return;
      }
      const state = plan.states[index]!;
      const clip = this.clip(state)!;
      const row = clip.rows > 1 ? this.aimRow : 0;
      this.play(
        state,
        row,
        false,
        (frame1, activeClip) => {
          if (!released && state === plan.releaseState && frame1 === plan.releaseFrame) {
            released = true;
            this.deps.onShot?.({
              kind: plan.shot, row, clip: activeClip, frame1,
              targetX, targetY,
            });
          }
        },
        () => next(index + 1),
      );
    };
    next(0);
    return true;
  }

  collapse(): void {
    if (this.collapsed || !this.sprite.active) return;
    this.collapsed = true;
    this.acting = false;
    this.levelupToken++;
    this.levelupPlaying = false;
    this.levelupPending = false;
    this.token++;
    // The camp's authored collapse sinks into the ground and leaves a sliver,
    // not a ruin (owner 2026-09-17). Rest on the generated rubble cell once the
    // sink has played; the cell shares the pack's size and anchor, so the seat
    // set by the constructor stays valid.
    const ruin = this.deps.ruinTexture?.() ?? null;
    this.play('collapse', 0, false, undefined, undefined, ruin ? { atlas: ruin } : undefined);
  }

  destroy(): void {
    this.token++;
    this.levelupToken++;
    this.deps.ticker.unregister(this.sprite);
  }
}

export interface WareTrapDeps {
  ticker: V2Ticker;
  clips: WareClipMap;
  unit: WareTrapUnit;
  level: number;
}

export class WareTrapFx {
  private token = 0;
  private spent = false;
  readonly atlas: string;

  constructor(
    private deps: WareTrapDeps,
    private sprite: Phaser.GameObjects.Sprite,
    private ownerView: boolean,
    initiallySpent = false,
  ) {
    const initial = initiallySpent ? 'sprung'
      : ownerView ? WARE_TRAP_ART[deps.unit]
        : deps.unit === 'airmine' ? 'drift' : 'hidden';
    const base = wareTrapClipKey(deps.unit, deps.level, initial);
    this.atlas = atlasGroupFor(`${base}_f1`);
    const first = wareFrame(deps.clips, base, 0, 1);
    const seat = first ? wareSeat(deps.clips, first) : null;
    if (seat) sprite.setOrigin(seat.origin[0], seat.origin[1]).setScale(seat.scale);
    this.spent = initiallySpent;
    this.play(initial, !initiallySpent && (initial === 'drift'));
  }

  /** Reconcile the persisted trap episode on every base refresh. Repair and
   * raid settlement can both change this while the same sprite/controller id
   * remains alive, so construction-time state is not sufficient. */
  setSpent(spent: boolean): void {
    if (this.spent === spent) return;
    this.spent = spent;
    this.token++;
    const state = spent ? 'sprung'
      : this.ownerView ? WARE_TRAP_ART[this.deps.unit]
        : this.deps.unit === 'airmine' ? 'drift' : 'hidden';
    this.play(state, !spent && state === 'drift');
  }

  private play(state: string, loop: boolean, onComplete?: () => void): boolean {
    const base = wareTrapClipKey(this.deps.unit, this.deps.level, state);
    const clip = this.deps.clips[base];
    if (!clip) return false;
    this.deps.ticker.play(this.sprite, {
      atlas: this.atlas,
      base,
      seq: clipFrames(base, clip, 0),
      fps: clip.fps ?? 8,
      loop,
      onComplete,
    });
    return true;
  }

  trigger(): void {
    if (this.spent || !this.sprite.active) return;
    this.spent = true;
    const token = ++this.token;
    const states = this.deps.unit === 'airmine'
      ? ['arm', 'trigger', 'sprung']
      : ['trigger', 'sprung'];
    const next = (index: number): void => {
      if (this.token !== token || !this.sprite.active) return;
      const state = states[index];
      if (!state) return;
      const last = index === states.length - 1;
      if (!this.play(state, false, last ? undefined : () => next(index + 1))) {
        next(index + 1);
      }
    };
    next(0);
  }

  destroy(): void {
    this.token++;
    this.deps.ticker.unregister(this.sprite);
  }
}

interface WareProjectileSpec {
  base: string;
  impact?: string;
  durationMs: number;
  emitter?: string;
}

export function wareProjectileSpec(kind: WareShotKind, tier: number): WareProjectileSpec | null {
  switch (kind) {
    case 'arrow': return { base: 'ware_fx_arrow', impact: 'ware_fx_arrow_hit', durationMs: DEFENSE_PROJECTILE_TIMINGS.archertower.flightMs };
    case 'magebolt': return { base: 'ware_fx_magebolt', impact: 'ware_fx_magehit', durationMs: DEFENSE_PROJECTILE_TIMINGS.magetower.flightMs };
    case 'tesla': return { base: '', impact: 'ware_fx_teslahit', durationMs: DEFENSE_PROJECTILE_TIMINGS.electrictower.flightMs };
    case 'laser': return { base: '', impact: 'ware_fx_laserhit', durationMs: DEFENSE_PROJECTILE_TIMINGS.lasertower.flightMs };
    case 'harpoon': return { base: `ware_fx_harpoon_t${tier}`, impact: `ware_fx_harpoon_hit_t${tier}`, durationMs: DEFENSE_PROJECTILE_TIMINGS.airdefence.flightMs, emitter: 'tip' };
    case 'trebuchet': return { base: 'ware_fx_trebuchet_shot', impact: 'ware_fx_trebuchet_hit', durationMs: DEFENSE_PROJECTILE_TIMINGS.mortar.flightMs };
    case 'keepoil': return { base: '', impact: 'ware_fx_keepoil', durationMs: DEFENSE_PROJECTILE_TIMINGS.cannon.flightMs };
    case 'keepbolt': return { base: 'ware_fx_keepbolt', durationMs: DEFENSE_PROJECTILE_TIMINGS.cannon.flightMs };
    case 'hatchfire': return {
      base: 'ware_fx_hatchfire', impact: 'ware_fx_hatchhit',
      durationMs: AUTHORED_ATTACK_TIMINGS.wyrmling.projectileTravelMs,
    };
  }
}

/** Defender Hatchling convenience route. It deliberately goes through the
 * same direction-baked M22 projectile player as tower shots and has no legacy
 * cone fallback when its optional warefx group is unavailable. */
export function launchWareHatchlingShot(
  scene: Phaser.Scene,
  clips: WareClipMap,
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
): boolean {
  const body = clips['ware_unt_hatchling_t1_attack'];
  if (!body) return false;
  return launchWareShot(scene, clips, {
    kind: 'hatchfire', row: 0, clip: body, frame1: 1, targetX, targetY,
  }, fromX, fromY, 1);
}

/** Play an authored direction-baked projectile. A missing current texture fails
 * closed; callers must never substitute a legacy projectile for an M22 body. */
export function launchWareShot(
  scene: Phaser.Scene,
  clips: WareClipMap,
  release: WareShotRelease,
  fromX: number,
  fromY: number,
  tier: number,
): boolean {
  const spec = wareProjectileSpec(release.kind, tier);
  if (!spec) return false;
  const impact = (): void => {
    if (spec.impact) playWareFx(scene, clips, spec.impact!, release.targetX, release.targetY);
  };
  // Tesla/laser/oil are baked into the body or are contact-only by contract.
  if (!spec.base) {
    if (release.kind === 'laser') drawWareBeam(scene, fromX, fromY, release.targetX, release.targetY);
    scene.time.delayedCall(spec.durationMs, impact);
    return true;
  }
  const clip = clips[spec.base];
  if (!clip) return false;
  const row = clip.rows > 1
    ? headingRow(release.targetX - fromX, (release.targetY - fromY) * 0.25)
    : 0;
  const seq = clipFrames(spec.base, clip, row);
  const atlas = atlasGroupFor(seq[0]!);
  if (!scene.textures.exists(atlas)) return false;
  const [ax, ay] = clip.anchorPx ?? [clip.cellW / 2, clip.cellH / 2];
  const projectile = scene.add.image(fromX, fromY, atlas, seq[0]!)
    .setOrigin(ax / clip.cellW, ay / clip.cellH)
    .setScale(V2_DRAW_SCALE)
    .setDepth(overlayDepth(2680));
  const frameMs = 1000 / (clip.fps ?? 12);
  let shown = 0;
  combatEffectPool(scene).add(
    spec.durationMs,
    (elapsed, t) => {
      if (!projectile.active) return;
      const frame = Math.floor(elapsed / frameMs) % seq.length;
      if (frame !== shown) {
        shown = frame;
        projectile.setTexture(atlas, seq[frame]!);
      }
      const x = fromX + (release.targetX - fromX) * t;
      const groundY = fromY + (release.targetY - fromY) * t;
      const lift = release.kind === 'trebuchet' ? Math.hypot(release.targetX - fromX, release.targetY - fromY) * 0.35 * 4 * t * (1 - t) : 0;
      projectile.setPosition(x, groundY - lift);
    },
    () => { projectile.destroy(); impact(); },
    () => projectile.destroy(),
  );
  return true;
}

export function wareEmitterWorld(
  sprite: Phaser.GameObjects.Sprite,
  release: WareShotRelease,
  name: string,
): { x: number; y: number } {
  const [ax, ay] = release.clip.anchorPx ?? [release.clip.cellW / 2, release.clip.cellH];
  const [ex, ey] = emitterPoint(release.clip, name, release.row, release.frame1 - 1);
  return {
    // Emit from the body's ACTUAL fitted scale. The old global ×2 detached
    // arrows/harpoons from reduced towers even though the sprite anchor moved
    // correctly with the art.
    x: sprite.x + (ex - ax) * sprite.scaleX,
    y: sprite.y + (ey - ay) * sprite.scaleY,
  };
}

export function playWareFx(
  scene: Phaser.Scene,
  clips: WareClipMap,
  base: string,
  x: number,
  y: number,
): Phaser.GameObjects.Image | null {
  const clip = clips[base];
  if (!clip) return null;
  const first = frameName(base, clip, 0, 1);
  const atlas = atlasGroupFor(first);
  if (!scene.textures.exists(atlas)) return null;
  const [ax, ay] = clip.anchorPx ?? [clip.cellW / 2, clip.cellH / 2];
  const image = scene.add.image(x, y, atlas, first)
    .setOrigin(ax / clip.cellW, ay / clip.cellH)
    .setScale(V2_DRAW_SCALE)
    .setDepth(overlayDepth(2685));
  const frameMs = 1000 / (clip.fps ?? 12);
  combatEffectPool(scene).add(
    frameMs * clip.frames,
    (elapsed) => {
      const frame1 = Math.min(clip.frames, Math.floor(elapsed / frameMs) + 1);
      if (image.active) image.setTexture(atlas, frameName(base, clip, 0, frame1));
    },
    () => image.destroy(),
    () => image.destroy(),
  );
  return image;
}

function drawWareBeam(
  scene: Phaser.Scene,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void {
  const beam = scene.add.graphics().setDepth(overlayDepth(2680));
  beam.lineStyle(3, 0xd7fbff, 0.95).lineBetween(fromX, fromY, toX, toY);
  beam.lineStyle(1, 0xffffff, 1).lineBetween(fromX, fromY, toX, toY);
  // CombatEffectPool has an explicit verdict-dispose path. A Phaser tween
  // killed mid-beam skips onComplete and would leave this Graphics painted.
  combatEffectPool(scene).add(
    100,
    (_elapsed, progress) => { if (beam.active) beam.setAlpha(1 - progress); },
    () => beam.destroy(),
    () => beam.destroy(),
  );
}

/** Stable helper used by the defender Wyrmling adapter. */
export function wareHatchlingBase(level: number, state: string): string {
  return wareHatchlingClipKey(level, state);
}
