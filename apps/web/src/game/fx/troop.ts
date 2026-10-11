/**
 * Per-troop animation controller (mission §1), driven entirely by the SimEvent
 * log and the scene's shared AnimTicker (apps/web/src/game/anim.ts).
 *
 *  - WALK : while a `pos` keyframe tween is running, play walkSeq for the
 *           movement direction (facing() from the delta; west = flipX).
 *  - ATTACK: when alive and NOT tweening (arrived / between keyframes), play the
 *           attack_e sequence flipped toward the nearest still-standing building.
 *  - DEATH: step the death frames 200ms apart, hold, fade out 400ms, destroy.
 *  - BURROW: hide the sprite, show a small travelling mound (fx_dust loop);
 *           EMERGE: 1s vulnerable look (alpha blink).
 *
 * The controller owns one sprite; the scene calls onPos/onDeath/onBurrow/
 * onEmerge from the corresponding events and tickAttack() each frame.
 *
 * `level` is the ART level, not the stat level: it selects the batch-13
 * dragon/giant masters in their own on-demand atlases. Every other generic
 * troop ignores it (anim.ts decides). The Wyrmling sim identity is not generic
 * in M22: construction fails unless BattleScene supplies WareHatchlingDeps.
 */
import type Phaser from 'phaser';
import { atlasGroupFor, BATTLE_SCALE, HERO_SKILLS, type TroopType } from '@shardkeep/shared';
import {
  ANIM_TICK_MS, AnimTicker, attackSeq, deathSeq, facing, firstMoveFrame, walkSeq,
} from '../anim';
import {
  V2TroopFx, v2FallbackDirectionalStandSpec, v2FallbackLocomotionSpec, v2FallbackSpec,
  v2TroopArtFit,
  type V2FallbackSpec, type V2TroopDeps, type V2TroopFallbackDeps,
} from '../v2/troop';
import {
  clipFrames, clipKey, facing8Stable, facingRow, parseFxAt, V2_DRAW_SCALE,
  type Facing8,
} from '../v2/clips';
import { WareHatchlingFx, type WareHatchlingDeps } from '../ware/hatchling';
import { actorDepth } from '../world/depth';

type State = 'idle' | 'walking' | 'melee' | 'skill' | 'burrowed' | 'emerging' | 'dying' | 'dead';

const DUST_SEQ = ['fx_dust_f1', 'fx_dust_f2'];

/** Death playback: one frame every DEATH_STEP_MS, hold the last for
 *  DEATH_HOLD_MS, then fade. Client feel, and deliberately per-frame rather than
 *  a fixed total — a 4-frame death played inside a 2-frame budget is a blur. */
const DEATH_STEP_MS = 200;
const DEATH_HOLD_MS = 400;

export class TroopFx {
  sprite: Phaser.GameObjects.Sprite;
  /**
   * Grid-pack delegate. Present ONLY when the scene handed over a v2 context
   * whose required tier atlases actually loaded (BattleScene gates that, same
   * freeze as artLevels)
   * and it is not wearing a hero skin (Theodor rides the giant's STATS, never
   * its rework art). When set, every method below forwards to it, so the
   * non-delegate body below owns either the eager current-art stand alias or,
   * when unavailable, the historical automatic fallback.
   */
  readonly v2: V2TroopFx | null = null;
  /** M22 Dragon-Nest defender. Even its minimum path is the eager authored
   * Hatchling pose, so the retired east-only Wyrmling family is unreachable. */
  readonly hatchling: WareHatchlingFx | null = null;
  /** Static eager current art used only until the full v2 delegate is granted. */
  private readonly fallback: V2FallbackSpec | null;
  /** Compact current-pack movement/pose atlas admitted after the full controller
   *  lost the residency-budget race. Undefined keeps the static alias path. */
  private readonly fallbackMotion: V2TroopFallbackDeps | null;
  private fallbackFacing: Facing8 = 's';
  private state: State = 'idle';
  /** Invalidates the completion callback of a superseded position segment.
   * Phaser does not guarantee that killing a tween suppresses a callback that
   * is already queued for this frame, so the callback must prove ownership. */
  private moveGeneration = 0;
  /** Invalidates a compact contact tween when a newer cue/lifecycle event wins. */
  private meleeGeneration = 0;
  private compactMeleeOrigin: { x: number; y: number } | null = null;
  /** Compact Gloam rend contact is a separate V2Ticker one-shot. The ticker's
   * verdict settle intentionally holds one-shot frames, so this facade must
   * retain and destroy the contact itself. */
  private compactContact: Phaser.GameObjects.Sprite | null = null;
  private flip = false;
  private mound: Phaser.GameObjects.Sprite | null = null;
  /** nearest standing building world-point, refreshed by the scene for attack
   *  facing (legacy reads .x only; the v2 8-way facing needs .y too). */
  private nearestBuilding: (() => { x: number; y: number } | null) | null = null;

  /** Hero skin (D4a): a hero unit renders with ITS art from the hero atlas —
   *  frame families verified present for both kits (walk e/n/s, attack_e,
   *  defeat, idle); west flips east like every troop master. */
  private skin: 'hero_vex' | 'hero_theo' | null = null;
  private heroLockToken = 0;
  private heroLocked = false;
  private heroVisualPriority = 0;
  private pendingHeroPos: { x: number; y: number; durMs: number } | null = null;
  /** Last authoritative position endpoint. A hidden-tab verdict can arrive
   * while Phaser is between tween frames; settle snaps here before killing the
   * tween so the final field cannot freeze midway through a move. */
  private positionTarget: { x: number; y: number };

  /** The texture every frame of this unit lives in. Resolved ONCE, from a real
   *  frame name rather than from the sprite-key base: the batch-13 groups are
   *  keyed by the full frame (`trp_dragon_l7_fly_e_f1` → `trpdg_l7`), and the
   *  base alone falls through to the historical `trp` atlas — where Phaser finds
   *  no such frame and silently draws nothing at all. */
  private readonly atlasKey: string;

  constructor(
    private scene: Phaser.Scene,
    private anim: AnimTicker,
    private troop: TroopType,
    x: number,
    y: number,
    depth: number,
    skin?: 'hero_vex' | 'hero_theo',
    private level?: number,
    v2?: V2TroopDeps,
    fallbackV2?: V2TroopFallbackDeps,
    hatchling?: WareHatchlingDeps,
  ) {
    this.positionTarget = { x, y };
    this.skin = skin ?? null;
    if (troop === 'wyrmling') {
      if (!hatchling || skin) {
        throw new Error('Wyrmling requires the M22 WARE Hatchling adapter');
      }
      this.fallback = null;
      this.fallbackMotion = null;
      this.hatchling = new WareHatchlingFx(scene, hatchling, x, y, depth);
      this.sprite = this.hatchling.sprite;
      this.atlasKey = this.hatchling.initialAtlas;
      return;
    }
    if (v2 && !skin) {
      this.fallback = null;
      this.fallbackMotion = null;
      // Rework-v2 unit: the delegate owns the sprite and the whole lifecycle.
      this.v2 = new V2TroopFx(scene, v2, x, y, depth);
      this.sprite = this.v2.sprite;
      this.atlasKey = this.v2.initialAtlas;
      return;
    }
    this.fallback = fallbackV2 && !skin
      ? v2FallbackSpec(fallbackV2.clips, fallbackV2.unit, fallbackV2.tier)
      : null;
    this.fallbackMotion = fallbackV2?.ticker && !skin
      && v2FallbackLocomotionSpec(fallbackV2.clips, fallbackV2.unit, fallbackV2.tier, 's')
      ? fallbackV2
      : null;
    this.atlasKey = this.fallback?.atlas ?? (skin ? 'hero' : atlasGroupFor(this.walkFrames('s')[0]!));
    this.sprite = scene.add
      .sprite(x, y, this.atlasKey, this.walkFrames('s')[0]!)
      .setOrigin(this.fallback?.origin[0] ?? 0.5, this.fallback?.origin[1] ?? 1)
      .setDepth(actorDepth(depth));
    // Owner 2026-07-28 ("fix in attack mode"): troops shrink, heroes read
    // clearly larger — both knobs live in BATTLE_SCALE, never here.
    // The eager current-art body carries the unit's PUBLISHED world fit
    // (v2TroopDrawScale) and then the same battle shrink as every other troop.
    // Multiplying rather than replacing is the point: while this branch used
    // the fit ALONE, the same unit rendered 1.21x larger here than through the
    // full v2 controller purely because the residency budget picked a different
    // art path — a size that moved with a download.
    this.sprite.setScale(this.fallback
      ? this.fallback.scale * BATTLE_SCALE.troop
      : (skin ? BATTLE_SCALE.hero : BATTLE_SCALE.troop));
    this.playIdleAttack(); // standing-still troops swing immediately
  }

  private walkFrames(dir: string): string[] {
    if (this.fallback) return [this.fallback.frame];
    if (!this.skin) return walkSeq(this.troop, dir as never, this.level);
    const d = dir === 'w' ? 'e' : dir;
    const n = this.skin === 'hero_vex' ? 4 : 8;
    return Array.from({ length: n }, (_, i) => `${this.skin}_walk_${d}_f${i + 1}`);
  }

  private attackFrames(): string[] {
    if (this.fallback) return [this.fallback.frame];
    if (!this.skin) return attackSeq(this.troop, this.level);
    return Array.from({ length: 6 }, (_, i) => `${this.skin}_attack_e_f${i + 1}`);
  }

  /** Play one of the compact current-pack loops at its authored cadence. */
  private playFallbackMotion(): boolean {
    const deps = this.fallbackMotion;
    if (!deps?.ticker) return false;
    const spec = v2FallbackLocomotionSpec(
      deps.clips, deps.unit, deps.tier, this.fallbackFacing,
    );
    if (!spec) return false;
    this.anim.unregister(this.sprite);
    this.sprite.setFlipX(false);
    deps.ticker.play(this.sprite, {
      atlas: spec.atlas,
      base: spec.base,
      seq: spec.seq,
      fps: spec.fps,
      loop: true,
    });
    return true;
  }

  private stopFallbackMotion(): void {
    this.fallbackMotion?.ticker?.unregister(this.sprite);
  }

  private clearCompactContact(): void {
    const contact = this.compactContact;
    if (!contact) return;
    this.compactContact = null;
    this.fallbackMotion?.ticker?.unregister(contact);
    if (contact.active) contact.destroy();
  }

  setNearestBuildingFn(fn: () => { x: number; y: number } | null): void {
    this.nearestBuilding = fn;
    this.v2?.setNearestBuildingFn(fn);
    this.hatchling?.setNearestBuildingFn(fn);
  }

  setMeleeDriven(): void {
    this.v2?.setMeleeDriven();
  }

  /** SIM7 authoritative non-hero contact. Full controllers own their authored
   * attack state; compact actors lunge with current art, while Gloam keeps its
   * reserved rend body/contact shard. */
  onMeleeAttack(
    target: 'troop' | 'building', ix: number, iy: number,
    technique?: 'strike' | 'slam' | 'rend',
  ): void {
    if (this.hatchling) return;
    if (this.v2) return this.v2.onMeleeAttack(target, ix, iy, technique);
    const deps = this.fallbackMotion;
    if (!this.alive) return;

    // Gloamfang's compact reservation deliberately includes the real rend body
    // and contact shard. Keep that specialization when both survived loading.
    if (deps?.ticker && deps.unit === 'gloamfang' && technique === 'rend') {
      const base = clipKey('trp', 'gloamfang', deps.tier, 'rend');
      const clip = deps.clips[base];
      const facing = facing8Stable(ix - this.sprite.x, iy - this.sprite.y, this.fallbackFacing);
      const seq = clip ? clipFrames(base, clip, facingRow(clip, facing)) : [];
      if (clip && seq.length > 0) {
        this.fallbackFacing = facing;
        const contactFrames = parseFxAt(clip.fxAt)
          .find((entry) => entry.fx === 'rend')?.frames ?? [];
        let contactPlayed = false;
        this.state = 'melee';
        this.anim.unregister(this.sprite);
        deps.ticker.play(this.sprite, {
          atlas: atlasGroupFor(seq[0]!), base, seq, fps: clip.fps ?? 10, loop: false,
          onFrame: (frame1) => {
            if (contactPlayed || !contactFrames.includes(frame1)) return;
            contactPlayed = true;
            const fxBase = `v2_fx_rend_t${deps.tier}`;
            const fxClip = deps.clips[fxBase];
            if (!fxClip) return;
            const fxSeq = clipFrames(fxBase, fxClip, 0);
            if (fxSeq.length === 0) return;
            const [ax, ay] = fxClip.anchorPx ?? [fxClip.cellW / 2, fxClip.cellH / 2];
            this.clearCompactContact();
            const contact = this.scene.add.sprite(ix, iy, atlasGroupFor(fxSeq[0]!), fxSeq[0]!)
              .setOrigin(ax / fxClip.cellW, ay / fxClip.cellH)
              // The compact body is drawn at the unit's fit, so its contact art
              // must be too — otherwise the identical unit's claw mark is one
              // size through the rich controller and another here, purely
              // because the residency budget picked a different art path.
              .setScale(V2_DRAW_SCALE * this.artFit)
              .setDepth(actorDepth(iy) + 1);
            this.compactContact = contact;
            contact.once('destroy', () => {
              if (this.compactContact === contact) this.compactContact = null;
            });
            deps.ticker!.play(contact, {
              atlas: atlasGroupFor(fxSeq[0]!), base: fxBase, seq: fxSeq,
              fps: fxClip.fps ?? 10, loop: false,
              onComplete: () => {
                if (this.compactContact === contact) this.clearCompactContact();
                else if (contact.active) contact.destroy();
              },
            });
          },
          onComplete: () => {
            if (this.state !== 'melee') return;
            this.state = 'idle';
            this.playIdleAttack();
          },
        });
        return;
      }
    }

    // A budget-rejected controller still owns an exact-current sprite. Give
    // every authoritative contact a short aimed lunge/pulse using that body;
    // no legacy frame or extra first-paint texture is introduced.
    if (!this.fallback) return;
    if (this.compactMeleeOrigin) {
      this.sprite.setPosition(this.compactMeleeOrigin.x, this.compactMeleeOrigin.y);
    }
    this.scene.tweens.killTweensOf(this.sprite);
    this.stopFallbackMotion();
    this.anim.unregister(this.sprite);
    this.sprite.setAlpha(1);
    const origin = { x: this.sprite.x, y: this.sprite.y };
    this.compactMeleeOrigin = origin;
    this.fallbackFacing = facing8Stable(ix - origin.x, iy - origin.y, this.fallbackFacing);
    const stand = deps && v2FallbackDirectionalStandSpec(
      deps.clips, deps.unit, deps.tier, this.fallbackFacing,
    );
    if (stand) this.sprite.setFlipX(false).setTexture(stand.atlas, stand.frame);
    else this.sprite.setFlipX(ix < origin.x);
    const dx = ix - origin.x;
    const dy = iy - origin.y;
    const distance = Math.hypot(dx, dy);
    const travel = Math.min(12, distance * 0.2);
    const generation = ++this.meleeGeneration;
    this.state = 'melee';
    this.scene.tweens.add({
      targets: this.sprite,
      x: origin.x + (distance > 0 ? (dx * travel) / distance : 0),
      y: origin.y + (distance > 0 ? (dy * travel) / distance : 0),
      alpha: 0.72,
      duration: 90,
      hold: 30,
      yoyo: true,
      ease: 'Sine.easeOut',
      onUpdate: () => this.sprite.setDepth(actorDepth(this.sprite.y)),
      onComplete: () => {
        if (generation !== this.meleeGeneration || this.state !== 'melee') return;
        this.sprite.setPosition(origin.x, origin.y).setAlpha(1).setDepth(actorDepth(origin.y));
        this.compactMeleeOrigin = null;
        this.state = 'idle';
        this.playIdleAttack();
      },
    });
  }

  get alive(): boolean {
    if (this.hatchling) return this.hatchling.alive;
    if (this.v2) return this.v2.alive;
    return this.state !== 'dying' && this.state !== 'dead';
  }

  /** True for every owner-reworked body, including the static/compact path
   * used when its rich controller loses admission. Scene handlers use this to
   * suppress historical troop-specific FX rather than mixing generations. */
  get usesCurrentV2Art(): boolean {
    return this.v2 !== null || this.fallback !== null || this.hatchling !== null;
  }

  /**
   * The fit this body lends to the art it emits — see `v2TroopArtFit`. The
   * scene owns projectile FLIGHT (troopFire is a sim render cue), so it needs
   * the same number the body uses, and it must be the same whether the rich
   * controller or the compact fallback drew the body. A non-v2 body (hero skin
   * or genuine legacy art) reports 1: it never reaches a v2 projectile.
   */
  get artFit(): number {
    return this.v2 || this.fallback ? v2TroopArtFit(this.troop) : 1;
  }

  /** A `pos` keyframe: tween there over `durMs`, walk-cycle facing the delta. */
  onPos(toX: number, toY: number, durMs: number): void {
    this.positionTarget = { x: toX, y: toY };
    if (this.hatchling) return this.hatchling.onPos(toX, toY, durMs);
    if (this.v2) return this.v2.onPos(toX, toY, durMs);
    if (!this.alive || this.state === 'burrowed') {
      // still tween position even while burrowed so the mound tracks the path
      if (this.state === 'burrowed') this.moveMound(toX, toY, durMs);
      return;
    }
    if (this.compactMeleeOrigin) {
      this.meleeGeneration++;
      this.scene.tweens.killTweensOf(this.sprite);
      this.sprite.setPosition(this.compactMeleeOrigin.x, this.compactMeleeOrigin.y).setAlpha(1);
      this.compactMeleeOrigin = null;
    }
    if (this.skin && this.heroLocked) {
      this.pendingHeroPos = { x: toX, y: toY, durMs };
      return;
    }
    if (this.fallback && !this.fallbackMotion) {
      // A one-frame current body cannot truthfully communicate locomotion.
      // Keep authoritative placement current by snapping to the event endpoint;
      // tweening the same pose would make it glide across the battlefield.
      this.moveGeneration++;
      this.scene.tweens.killTweensOf(this.sprite);
      this.anim.unregister(this.sprite);
      this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));
      this.playIdleAttack();
      return;
    }
    const dx = toX - this.sprite.x;
    const dy = toY - this.sprite.y;
    const generation = ++this.moveGeneration;
    // Position is authoritative and independent from the body clip. Replace
    // only the old transform segment; a stale completion may never choose idle
    // for the newer segment (the Giant/Mage intermittent freeze).
    this.scene.tweens.killTweensOf(this.sprite);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      this.playIdleAttack();
      return;
    }
    const f = facing(dx, dy);
    this.flip = f.flip;
    this.state = 'walking';
    this.fallbackFacing = facing8Stable(dx, dy, this.fallbackFacing);
    if (!this.playFallbackMotion()) {
      this.anim.register(this.sprite, this.atlasKey, this.walkFrames(f.dir));
      this.sprite.setFlipX(f.flip);
    }
    this.scene.tweens.add({
      targets: this.sprite,
      x: toX,
      y: toY,
      duration: durMs,
      ease: 'Linear',
      onUpdate: () => this.sprite.setDepth(actorDepth(this.sprite.y)),
      onComplete: () => {
        if (generation === this.moveGeneration && this.alive) {
          this.state = 'idle';
          this.playIdleAttack();
        }
      },
    });
  }

  /** Absolute replay seek. This owns every nested controller and any legacy
   * mound, avoiding Phaser's deferred 0.01 ms "zero-duration" tween. */
  snapPosition(toX: number, toY: number): void {
    this.positionTarget = { x: toX, y: toY };
    if (this.hatchling) return this.hatchling.snapPosition(toX, toY);
    if (this.v2) return this.v2.snapPosition(toX, toY);
    if (!this.alive) return;
    this.moveGeneration++;
    this.meleeGeneration++;
    this.pendingHeroPos = null;
    this.compactMeleeOrigin = null;
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));
    if (this.mound) {
      this.scene.tweens.killTweensOf(this.mound);
      this.mound.setPosition(toX, toY).setDepth(actorDepth(toY));
    }
  }

  /** Settle constructor-time spawn/action state for an actor materialized by
   * an elapsed replay prefix. Persistent underground state is preserved. */
  finishSeek(): void {
    if (this.hatchling) return this.hatchling.finishSeek();
    if (this.v2) return this.v2.finishSeek();
    if (!this.alive || this.state === 'burrowed') return;
    this.invalidateHeroLock();
    this.playIdleAttack();
  }

  /** Authoritative basic swing. The recovery lock prevents a same-tick pos
   * keyframe from replacing the attack before its authored frames complete. */
  onHeroAttack(ix: number, iy: number, recoveryMs: number): void {
    if (!this.skin || !this.alive || this.state === 'dying'
      || (this.heroLocked && this.heroVisualPriority > 2)) return;
    this.flip = ix < this.sprite.x;
    this.sprite.setFlipX(this.flip);
    this.playHeroBody(this.attackFrames(), recoveryMs, 2);
  }

  /** Exhaustive hero phase map. Death always wins because `alive` is false while
   * dying; fake-death/revive use their own bodies; every other skill locks above
   * attack/walk/idle until its exact phase duration expires. */
  onHeroSkill(skill: string, phase: string, lockMs: number, phaseElapsedMs = 0): void {
    if (!this.skin || this.state === 'dying' || this.state === 'dead') return;
    const vex = this.skin === 'hero_vex';
    const priority = phase === 'fakeDeath' || phase === 'revive' || phase === 'heads' ? 4 : 3;
    if (this.heroLocked && this.heroVisualPriority > priority) return;

    // The L20 contract is two visibly different wind-up stages. The sim gives
    // one authoritative lock covering both, so split that duration using the
    // shared 5s/3s constants without changing when the skill resolves.
    if (!vex && skill === 'silentButDeadly' && phase === 'windup') {
      const { eatWindupSec } = HERO_SKILLS.theodor.silentButDeadly;
      const eatRemainingMs = Math.max(0, eatWindupSec * 1000 - phaseElapsedMs);
      if (eatRemainingMs === 0) {
        this.playHeroBody(this.named('hero_theo_bloat', 5), lockMs, priority, true);
        return;
      }
      const swellAtMs = Math.max(1, Math.min(lockMs, eatRemainingMs));
      const token = this.playHeroBody(this.named('hero_theo_eat', 6), lockMs, priority);
      this.scene.time.delayedCall(swellAtMs, () => {
        if (!this.alive || token !== this.heroLockToken) return;
        this.anim.unregister(this.sprite);
        this.playHeroFramesOnce(
          this.named('hero_theo_bloat', 5), token, Math.max(1, lockMs - swellAtMs),
        );
      });
      return;
    }

    let once = false;
    const seq = (() => {
      if (!vex && skill === 'rageQuit' && phase === 'fakeDeath') {
        once = true;
        const frames = this.named('hero_theo_playdead', 5);
        return phaseElapsedMs > 0 ? [frames.at(-1)!] : frames;
      }
      if (!vex && skill === 'rageQuitWake' && phase === 'revive') {
        once = true;
        return this.named('hero_theo_getup', 4);
      }
      if (vex && skill === 'doubleOrNothingHeads') {
        once = true;
        return this.named('hero_vex_revive', 2);
      }
      if (skill === 'crimsonDash') {
        once = true;
        return this.named('hero_vex_dash_e', 3);
      }
      if (skill === 'moonsunderWave') {
        once = true;
        return this.named('hero_vex_cast_e', 3);
      }
      if (skill === 'omegaShardstorm') {
        once = true;
        return this.named('hero_vex_awaken', 3);
      }
      if (skill === 'degenAwakening') {
        once = true;
        return this.named('hero_vex_awaken', 3);
      }
      if (skill.startsWith('doubleOrNothing')) {
        once = true;
        return this.named('hero_vex_taunt', 3);
      }
      if (skill === 'cheekQuake') {
        // The impact lock is only 500ms. The shared ticker would expose just
        // two of the eight authored slam frames before the quake resolved.
        // Fit the complete visual body inside that existing lock; sim timing
        // and damage remain authoritative and unchanged.
        once = true;
        return this.named('hero_theo_slam', 8);
      }
      if (skill === 'snotRocket') {
        once = true;
        return this.named('hero_theo_snot', 6);
      }
      if (skill === 'cannonball') {
        once = true;
        return this.named('hero_theo_leap', 8);
      }
      if (skill === 'skillIssue') {
        once = true;
        return this.named('hero_theo_airtaunt', 3);
      }
      if (skill === 'bellyBounce') {
        once = true;
        return this.named('hero_theo_bounce', 4);
      }
      if (skill === 'brownNote') {
        once = true;
        return this.named('hero_theo_gaswall', 6);
      }
      if (skill === 'silentButDeadly' && phase === 'impact') {
        once = true;
        return this.named('hero_theo_blast', 4);
      }
      return this.attackFrames();
    })();
    this.playHeroBody(seq, lockMs, priority, once);
  }

  onHeroTravel(toX: number, toY: number, durationMs: number): void {
    if (!this.skin || !this.alive) return;
    this.positionTarget = { x: toX, y: toY };
    this.scene.tweens.killTweensOf(this.sprite);
    this.scene.tweens.add({
      targets: this.sprite, x: toX, y: toY, duration: Math.max(1, durationMs),
      ease: 'Sine.easeInOut', onUpdate: () => this.sprite.setDepth(actorDepth(this.sprite.y)),
    });
  }

  private named(base: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => `${base}_f${i + 1}`);
  }

  /** Timers can already be queued in Clock.update during a hidden-tab seek.
   * Invalidate ownership before teardown/settlement; a queued unlock must never
   * resume movement on a destroyed sprite or restart a settled hero's loop. */
  private invalidateHeroLock(): void {
    this.heroLockToken++;
    this.heroLocked = false;
    this.heroVisualPriority = 0;
    this.pendingHeroPos = null;
  }

  private playHeroBody(
    seq: string[], lockMs: number, priority: number, once = false,
  ): number {
    const token = ++this.heroLockToken;
    this.heroLocked = true;
    this.heroVisualPriority = priority;
    this.state = 'skill';
    this.stopFallbackMotion();
    // A looping body that is already the registered loop keeps its phase; only
    // a different body (or a once-played one) is re-registered from frame 1.
    // The SIM13 wall chew publishes a heroAttack cue every 100 ms tick, under
    // the 260 ms frame clock: unconditionally re-registering the six-frame
    // swing put the sprite back on frame 1 at every cue, so a chewing hero
    // never left it and "looked completely idle" (tester, 2026-09-04). The
    // recovery lock itself is always re-armed below with a fresh token.
    const continuing = !once && this.anim.sequence(this.sprite)?.join() === seq.join();
    if (!continuing) {
      this.anim.unregister(this.sprite);
      if (once) this.playHeroFramesOnce(seq, token, lockMs);
      else this.anim.register(this.sprite, this.atlasKey, seq);
    }
    this.scene.time.delayedCall(Math.max(1, lockMs), () => {
      if (!this.alive || token !== this.heroLockToken) return;
      this.heroLocked = false;
      this.heroVisualPriority = 0;
      const pending = this.pendingHeroPos;
      this.pendingHeroPos = null;
      this.state = 'idle';
      if (pending) this.onPos(pending.x, pending.y, pending.durMs);
      else this.playIdleAttack();
    });
    return token;
  }

  /** Play a bounded body once and hold its last frame until the existing visual
   * lock ends. This prevents fake death/get-up and contact bodies from looping
   * back to frame 1, while never extending the sim-authored phase duration. */
  private playHeroFramesOnce(seq: string[], token: number, durationMs: number): void {
    if (seq.length === 0) return;
    const stepMs = Math.max(1, Math.min(ANIM_TICK_MS, Math.floor(durationMs / seq.length)));
    this.sprite.setTexture(this.atlasKey, seq[0]!);
    for (let i = 1; i < seq.length; i++) {
      this.scene.time.delayedCall(stepMs * i, () => {
        if (!this.alive || token !== this.heroLockToken || !this.sprite.active) return;
        this.sprite.setTexture(this.atlasKey, seq[i]!);
      });
    }
  }

  /** Each scene frame: if idle, keep the attack swing aimed at the nearest target. */
  tickAttack(): void {
    if (this.hatchling) return this.hatchling.tickAttack();
    if (this.v2) return this.v2.tickAttack();
    if (this.state !== 'idle') return;
    const tgt = this.nearestBuilding?.();
    if (tgt && this.fallbackMotion) {
      const next = facing8Stable(
        tgt.x - this.sprite.x, tgt.y - this.sprite.y, this.fallbackFacing,
      );
      if (next !== this.fallbackFacing) {
        this.fallbackFacing = next;
        this.playIdleAttack();
      }
      return;
    }
    if (tgt) {
      const wantFlip = tgt.x < this.sprite.x;
      if (wantFlip !== this.flip) {
        this.flip = wantFlip;
        this.sprite.setFlipX(wantFlip);
      }
    }
  }

  private playIdleAttack(): void {
    this.state = 'idle';
    this.stopFallbackMotion();
    if (this.fallbackMotion) {
      const stand = v2FallbackDirectionalStandSpec(
        this.fallbackMotion.clips, this.fallbackMotion.unit,
        this.fallbackMotion.tier, this.fallbackFacing,
      );
      if (stand) {
        this.anim.unregister(this.sprite);
        this.sprite.setFlipX(false).setTexture(stand.atlas, stand.frame);
        return;
      }
    }
    this.anim.register(this.sprite, this.atlasKey, this.attackFrames());
    const tgt = this.nearestBuilding?.();
    if (tgt) {
      this.flip = tgt.x < this.sprite.x;
      this.sprite.setFlipX(this.flip);
    }
  }

  onBurrow(): void {
    if (this.hatchling) return;
    if (this.v2) return this.v2.onBurrow();
    if (!this.alive) return;
    this.moveGeneration++;
    if (this.compactMeleeOrigin) {
      this.meleeGeneration++;
      this.scene.tweens.killTweensOf(this.sprite);
      this.sprite.setPosition(this.compactMeleeOrigin.x, this.compactMeleeOrigin.y)
        .setAlpha(1).setDepth(actorDepth(this.compactMeleeOrigin.y));
      this.compactMeleeOrigin = null;
    }
    this.state = 'burrowed';
    this.stopFallbackMotion();
    this.anim.unregister(this.sprite);
    this.sprite.setVisible(false);
    // A budget-rejected rework body must not flash the historical dust mound.
    // Its authoritative hidden movement still runs below and the current stand
    // alias returns at emerge; rich admission owns the authored soil cycle.
    if (this.fallback) return;
    this.mound = this.scene.add
      .sprite(this.sprite.x, this.sprite.y, 'fx', DUST_SEQ[0]!)
      .setOrigin(0.5, 1)
      .setDepth(this.sprite.depth)
      .setAlpha(0.7);
    this.anim.register(this.mound, 'fx', DUST_SEQ);
  }

  /** Persistent state reconstruction for an expired burrow transition. */
  seekBurrowed(): void {
    if (this.hatchling) return;
    if (this.v2) return this.v2.seekBurrowed();
    if (!this.alive) return;
    this.onBurrow();
  }

  private moveMound(toX: number, toY: number, durMs: number): void {
    if (!this.mound) return;
    this.scene.tweens.add({ targets: this.mound, x: toX, y: toY, duration: durMs, ease: 'Linear' });
    this.scene.tweens.add({ targets: this.sprite, x: toX, y: toY, duration: durMs, ease: 'Linear' });
  }

  onEmerge(x?: number, y?: number): void {
    if (this.hatchling) return;
    if (x !== undefined && y !== undefined) this.positionTarget = { x, y };
    if (this.v2) return this.v2.onEmerge(x, y);
    if (x !== undefined && y !== undefined) {
      this.moveGeneration++;
      this.scene.tweens.killTweensOf(this.sprite);
      this.sprite.setPosition(x, y).setDepth(actorDepth(y));
      if (this.mound) this.scene.tweens.killTweensOf(this.mound);
    }
    if (this.mound) {
      this.anim.unregister(this.mound);
      this.mound.destroy();
      this.mound = null;
    }
    this.sprite.setVisible(true);
    this.state = 'emerging';
    this.stopFallbackMotion();
    this.sprite.setTexture(
      this.fallback?.atlas ?? 'trp',
      this.fallback?.frame ?? `trp_${this.troop}_emerge_f1`,
    );
    // 1s vulnerable blink, then resume attacking.
    this.scene.tweens.add({
      targets: this.sprite,
      alpha: 0.4,
      duration: 120,
      yoyo: true,
      repeat: 3,
      onComplete: () => {
        this.sprite.setAlpha(1);
        if (this.alive) this.playIdleAttack();
      },
    });
  }

  /** Persistent state reconstruction for an expired emerge transition. */
  seekEmerged(x?: number, y?: number): void {
    if (this.hatchling) {
      if (x !== undefined && y !== undefined) this.hatchling.snapPosition(x, y);
      return;
    }
    if (this.v2) return this.v2.seekEmerged(x, y);
    if (!this.alive) return;
    if (x !== undefined && y !== undefined) this.snapPosition(x, y);
    if (this.mound) {
      this.anim.unregister(this.mound);
      this.mound.destroy();
      this.mound = null;
    }
    this.sprite.setVisible(true).setAlpha(1);
    this.state = 'idle';
    this.playIdleAttack();
  }

  /** Optional grid-pack pre-detonation verb; legacy Keg Runner has no sheet. */
  onPrime(): void {
    if (this.hatchling) return;
    this.v2?.onPrime();
  }

  /** Cancel only the optional V2 anticipation verb; legacy has no equivalent. */
  cancelPrime(): void {
    if (this.hatchling) return;
    this.v2?.cancelPrime();
  }

  /** Verdict seek keeps the materialized frame but releases every controller
   * owned by this facade, including a legacy burrow mound. */
  settle(): void {
    this.invalidateHeroLock();
    this.cancelPrime();
    if (this.alive) this.snapPosition(this.positionTarget.x, this.positionTarget.y);
    // Facade-owned compact/legacy action tweens also animate alpha. A killed
    // lunge or emerge blink skips onComplete; normalize surfaced survivors but
    // preserve the intentional invisibility of an authoritative burrow.
    if (!this.v2 && !this.hatchling && this.alive && this.state !== 'burrowed') {
      this.sprite.setVisible(true).setAlpha(1);
    }
    this.clearCompactContact();
    // V2Ticker.settle deliberately holds the current frame. Controller-owned
    // firestorm fans, delayed maul impacts and breath streams must be destroyed
    // first or that held frame remains painted behind the verdict.
    this.v2?.cancelReplayAction();
    this.anim.unregister(this.sprite);
    if (this.mound) this.anim.unregister(this.mound);
  }

  onDeath(): void {
    if (this.hatchling) return this.hatchling.onDeath();
    if (this.v2) return this.v2.onDeath();
    if (this.state === 'dying' || this.state === 'dead') return;
    this.invalidateHeroLock();
    this.meleeGeneration++;
    this.moveGeneration++;
    if (this.compactMeleeOrigin) {
      this.sprite.setPosition(this.compactMeleeOrigin.x, this.compactMeleeOrigin.y)
        .setDepth(actorDepth(this.compactMeleeOrigin.y));
    }
    this.compactMeleeOrigin = null;
    this.clearCompactContact();
    this.scene.tweens.killTweensOf(this.sprite);
    this.state = 'dying';
    this.stopFallbackMotion();
    this.anim.unregister(this.sprite);
    if (this.mound) {
      this.anim.unregister(this.mound);
      this.mound.destroy();
      this.mound = null;
    }
    this.sprite.setVisible(true).setAlpha(1);
    // Heroes fall with their DEFEAT frames (the kits' downed pose — D4b's regen
    // loop revives from exactly this state later); every hero kit ships exactly
    // two, so this branch stays a pair while troops step whatever they have.
    // Troops do NOT: a legacy troop ships 2 death masters and a batch-13
    // dragon/giant ships 4, so the schedule steps the sequence rather than a
    // hardcoded f1/f2 — otherwise half of the new death animation never renders.
    const seq = this.skin
      ? Array.from({ length: this.skin === 'hero_vex' ? 3 : 4 },
        (_, i) => `${this.skin}_defeat_f${i + 1}`)
      : (this.fallback ? [this.fallback.frame] : deathSeq(this.troop, this.level));
    this.sprite.setTexture(this.atlasKey, seq[0]!);
    for (let i = 1; i < seq.length; i++) {
      this.scene.time.delayedCall(DEATH_STEP_MS * i, () => {
        if (this.sprite.active) this.sprite.setTexture(this.atlasKey, seq[i]!);
      });
    }
    // hold the last frame, then fade out over 400ms and destroy. Two frames land
    // on 600ms — the schedule this has always run.
    this.scene.time.delayedCall(DEATH_STEP_MS * (seq.length - 1) + DEATH_HOLD_MS, () => {
      if (!this.sprite.active) return;
      this.scene.tweens.add({
        targets: this.sprite,
        alpha: 0,
        duration: 400,
        onComplete: () => {
          this.state = 'dead';
          this.sprite.destroy();
        },
      });
    });
  }

  /** Incoming hit flinch — a v2-only clip; legacy troops keep the hit star
   *  + white flash the scene already draws (no flinch art shipped for them). */
  onHit(): void {
    if (this.hatchling) this.hatchling.onHit();
    else this.v2?.onHit();
  }

  /** Optional grid-pack verb; the sim still decides when the unit dies. */
  onDetonate(onBlast?: (at: { x: number; y: number }) => void): void {
    if (this.hatchling) return;
    if (this.v2) this.v2.onDetonate(onBlast);
    else onBlast?.({ x: this.sprite.x, y: this.sprite.y });
  }

  onRangedAttack(
    ix: number,
    iy: number,
    onRelease: (at: { x: number; y: number }) => void,
  ): void {
    if (this.hatchling) this.hatchling.onRangedAttack(ix, iy, onRelease);
    else if (this.v2) this.v2.onRangedAttack(ix, iy, onRelease);
    else {
      this.flip = ix < this.sprite.x;
      this.sprite.setFlipX(this.flip);
      this.anim.register(this.sprite, this.atlasKey, this.attackFrames());
      onRelease({ x: this.sprite.x, y: this.sprite.y });
    }
  }

  destroy(): void {
    this.state = 'dead';
    this.invalidateHeroLock();
    if (this.hatchling) return this.hatchling.destroy();
    if (this.v2) return this.v2.destroy();
    this.meleeGeneration++;
    this.moveGeneration++;
    this.compactMeleeOrigin = null;
    this.clearCompactContact();
    this.scene.tweens.killTweensOf(this.sprite);
    this.stopFallbackMotion();
    this.anim.unregister(this.sprite);
    this.sprite.destroy();
    if (this.mound) {
      this.anim.unregister(this.mound);
      this.mound.destroy();
    }
  }
}

/** Hero-specific construction keeps BattleScene from accidentally selecting a
 * donor troop skin. Lifecycle and priority remain centralized in TroopFx. */
export class HeroFx extends TroopFx {
  constructor(
    scene: Phaser.Scene,
    anim: AnimTicker,
    troop: TroopType,
    hero: 'vex' | 'theodor',
    x: number,
    y: number,
    depth: number,
  ) {
    super(scene, anim, troop, x, y, depth, hero === 'vex' ? 'hero_vex' : 'hero_theo');
  }
}
