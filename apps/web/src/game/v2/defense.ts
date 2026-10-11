/**
 * V2DefenseFx — the rework-v2 cannon/mortar battle controller (Phase D; lab
 * reference `_lab.js` combat scenes: directional fire → reload on one clock).
 *
 * The building is drawn at ONE fixed camera — rows are the turret's AIM
 * direction only, the base never rotates (HANDOFF-V2: "for the cannon, rows
 * are the AIM direction, not the building's rotation"). On a sim `fire`
 * event: select the target row, then play the complete fire clip with its
 * manifest fxAt effects — muzzle/mortarflash + the projectile
 * leaving the PUBLISHED emitter pixel rotated to the published axis, powder
 * smoke a frame later — then reload, then back to the resting loop.
 *
 * Resting loop is idle@3fps, or the damaged 2f loop once the HP mirror drops
 * below half (BattleScene owns the mirror and calls setDamaged). Destruction
 * plays the building's OWN collapse clip and holds its final rubble frame —
 * these two types only; every other defence keeps the generic fx_rubble.
 *
 * BAKED_RECOIL semantics from fx/muzzle.ts carry over by construction: the
 * v2 fire frames animate the whole gun, so there is NO engine recoil tween
 * anywhere in this path.
 */
import type Phaser from 'phaser';
import { haptic, shake } from '../../lib/juice';
import {
  clipFrames, clipKey, facing8, facingRow, parseFxAt, v2BldArtFit, v2BldDrawScale,
  type V2Clip, type V2ClipMap,
} from './clips';
import { emitterWorld, launchV2Projectile, playV2MuzzleFx } from './projectiles';
import type { V2Ticker } from './ticker';

export interface V2DefenseDeps {
  ticker: V2Ticker;
  clips: V2ClipMap;
  unit: 'cannon' | 'mortar';
  tier: number;
}

export class V2DefenseFx {
  /** Monotone shot token — the cancelDefenceFire idea: a collapse mid-shot
   *  must strand every scheduled continuation, or a late reload frame would
   *  repaint the rubble as a tower. */
  private token = 0;
  private damaged = false;
  private collapsed = false;
  /** Row the turret is currently laid on. Idle art points south (row 0). */
  private aimRow = 0;
  private readonly atlas: string;

  constructor(
    private scene: Phaser.Scene,
    private deps: V2DefenseDeps,
    /** The building sprite BattleScene already placed AND re-seated on the
     *  footprint CENTRE for these two types (adoptV2Defenses, via v2BldSeat).
     *  Adopted: texture + origin + draw scale are re-keyed to the v2 idle
     *  master here; the position is the scene's, since only it knows the tile. */
    private sprite: Phaser.GameObjects.Sprite,
  ) {
    this.atlas = `v2bld_${deps.unit}_t${deps.tier}`;
    const idle = this.clip('idle');
    if (idle) {
      // Every cannon/mortar clip shares the cell + anchor (112×120 at (56,104)),
      // so the idle master's origin is right for aim/fire/reload/damaged/
      // collapse too — the manifest is uniform per unit, verified.
      const [ax, ay] = idle.anchorPx ?? [56, 104];
      this.sprite.setOrigin(ax / idle.cellW, ay / idle.cellH);
    }
    // @1x pack in an @2x world, TIMES the unit's published world fit — the same
    // product v2BldSeat hands the base view and the deed. A bare V2_DRAW_SCALE
    // here would re-inflate the tower the moment a raid adopted it, so the same
    // Cannon would be one size on the base and another in the battle.
    this.sprite.setScale(v2BldDrawScale(deps.unit));
    this.rest();
  }

  private base(state: string): string {
    return clipKey('bld', this.deps.unit, this.deps.tier, state);
  }

  private clip(state: string): V2Clip | undefined {
    return this.deps.clips[this.base(state)];
  }

  /** The resting loop: idle, or the damaged 2f loop below half HP. */
  private rest(): void {
    if (this.collapsed || !this.sprite.active) return;
    const state = this.damaged ? 'damaged' : 'idle';
    const clip = this.clip(state);
    if (!clip) return;
    this.deps.ticker.play(this.sprite, {
      atlas: this.atlas,
      base: this.base(state),
      seq: clipFrames(this.base(state), clip, Math.min(this.aimRow, clip.rows - 1)),
      fps: clip.fps ?? 3,
      loop: true,
    });
  }

  /** HP mirror crossing the half line (either way — a replay rebase can heal). */
  setDamaged(damaged: boolean): void {
    if (this.damaged === damaged) return;
    this.damaged = damaged;
    // Mid-sequence the change lands when the sequence next rests; at rest it
    // lands now.
    if (this.token === this.restingToken) this.rest();
  }

  /** Token value while at rest — bumped by fire() and collapse(). */
  private restingToken = 0;

  /**
   * A sim `fire` event at impact point (ix, iy): shoot on the target row, then
   * reload. The projectile is the tiered heading-row travel set — cannonball
   * (18% arc) or shell (55% lob + tumble + the legacy landing juice).
   */
  fire(ix: number, iy: number): void {
    if (this.collapsed || !this.sprite.active) return;
    const fire = this.clip('fire');
    if (!fire) return;
    const token = ++this.token;
    const row = facingRow(fire, facing8(ix - this.sprite.x, iy - this.sprite.y));
    const startFire = (): void => {
      if (this.token !== token || !this.sprite.active) return;
      const fxAt = parseFxAt(fire.fxAt);
      const fired = new Set<string>();
      this.deps.ticker.play(this.sprite, {
        atlas: this.atlas,
        base: this.base('fire'),
        seq: clipFrames(this.base('fire'), fire, row),
        fps: fire.fps ?? 14,
        loop: false,
        onFrame: (f) => {
          if (this.token !== token) return;
          for (const e of fxAt) {
            if (!e.frames.includes(f) || fired.has(e.fx)) continue;
            fired.add(e.fx);
            // Muzzle points are pack px: they must ride the body's ACTUAL
            // fitted scale, or a refitted tower fires from beside itself
            // (the same detachment the WARE towers hit — ware/building.ts
            // wareEmitterWorld). `fit` is the tower's published world fit
            // alone; emitterWorld applies the @1x→@2x conversion itself, and
            // projectiles.ts applies it to the shot's own art.
            const fit = v2BldArtFit(this.deps.unit);
            const at = emitterWorld(this.sprite, fire, 'muzzle', row, f - 1, fit);
            if (e.fx === 'muzzle' || e.fx === 'mortarflash' || e.fx === 'smoke') {
              playV2MuzzleFx(
                this.scene, this.deps.clips, `v2_fx_${e.fx}_t${this.deps.tier}`,
                at.x, at.y, at.axisDeg, this.sprite.depth + 1, fit,
              );
            } else if (e.fx === 'cannonball' || e.fx === 'shell') {
              launchV2Projectile(
                this.scene, this.deps.clips, e.fx, this.deps.tier,
                at.x, at.y, ix, iy,
                e.fx === 'shell'
                  ? () => {
                    // The landing IS the explosion (no sim event) — the exact
                    // §3.10 keg/mortar budget legacy shells apply.
                    shake(this.scene, 150, 0.004);
                    haptic('medium');
                  }
                  : undefined,
                undefined,
                // A defence fires from a BUILDING, not a troop, so it inherits
                // the tower's published fit and NOT `BATTLE_SCALE.troop` — the
                // same number that already placed the muzzle, so the flash, the
                // round, its shadow and its crater all leave a 0.55 Cannon at
                // 0.55 and a 0.625 Mortar at 0.625.
                fit,
              );
            }
          }
        },
        onComplete: () => {
          if (this.token !== token || !this.sprite.active) return;
          const reload = this.clip('reload');
          if (!reload) {
            this.restingToken = token;
            this.rest();
            return;
          }
          this.deps.ticker.play(this.sprite, {
            atlas: this.atlas,
            base: this.base('reload'),
            seq: clipFrames(this.base('reload'), reload, row),
            fps: reload.fps ?? 8,
            loop: false,
            onComplete: () => {
              if (this.token !== token || !this.sprite.active) return;
              this.restingToken = token;
              this.rest();
            },
          });
        },
      });
    };
    // D-034's fire event starts the published attack clock. Its 143ms release
    // offset is exactly fire@2 at 14fps and contains no pre-aim allowance.
    // Inserting the 333ms aim clip on a newly acquired heading made the visible
    // round land after authoritative damage. Direction is therefore selected
    // immediately; the complete fire and reload clips still play at authored
    // speed, and idle keeps the selected row between shots.
    this.aimRow = row;
    startFire();
  }

  /** Destroyed: the building's OWN collapse clip (single-row), final frame
   *  held as the rubble. Cancels anything mid-flight via the token. */
  collapse(): void {
    if (this.collapsed || !this.sprite.active) return;
    this.collapsed = true;
    this.token++;
    const clip = this.clip('collapse');
    if (!clip) return;
    this.deps.ticker.play(this.sprite, {
      atlas: this.atlas,
      base: this.base('collapse'),
      seq: clipFrames(this.base('collapse'), clip, 0),
      fps: clip.fps ?? 8,
      loop: false,
      // no onComplete: the ticker holds the last frame — that IS the rubble.
    });
  }

  destroy(): void {
    this.token++;
    this.deps.ticker.unregister(this.sprite);
  }
}
