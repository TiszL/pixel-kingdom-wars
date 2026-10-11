/**
 * Building damage states (HANDOFF §3.6): HP-band-driven composited overlays,
 * never a redrawn cracked sprite.
 *
 *   ≤65% (stage 1): ovl_damage_{fp}_s1 over the footprint + ONE small fire
 *                   (fx_fire loop) at a footprint corner.
 *   ≤32% (stage 2): ovl_damage_{fp}_s2 + TWO fires (phase-staggered so they
 *                   don't flicker in sync) + an fx_smoke loop from the roof.
 *   destroyed     : rubble swap (handled by the scene) + a dying fire that
 *                   fades out ~10s after collapse.
 *
 * Overlays/fires anchor to the FOOTPRINT (top-left tile), not the sprite
 * height. Fire/smoke frames cycle on the scene's shared AnimTicker; staggered
 * phase is achieved by registering different start sequences (rotations of
 * f1,f2,f3) so co-located flames never sync.
 */
import type Phaser from 'phaser';
import { AnimTicker } from '../anim';
import { buildingDepth } from '../world/depth';

const FIRE_ROT: string[][] = [
  ['fx_fire_f1', 'fx_fire_f2', 'fx_fire_f3'],
  ['fx_fire_f2', 'fx_fire_f3', 'fx_fire_f1'],
  ['fx_fire_f3', 'fx_fire_f1', 'fx_fire_f2'],
];
const SMOKE_SEQ = ['fx_smoke_f1', 'fx_smoke_f2', 'fx_smoke_f3'];

type Stage = 0 | 1 | 2;

export class BuildingDamage {
  private stage: Stage = 0;
  private overlay: Phaser.GameObjects.Image | null = null;
  private fires: Phaser.GameObjects.Sprite[] = [];
  private smoke: Phaser.GameObjects.Sprite | null = null;
  private firePhase = 0;

  /**
   * @param tileX,tileY  footprint top-left tile
   * @param fw,fh        footprint cols/rows
   * @param tile         world px per tile
   * @param baseDepth    the building sprite's depth (overlays sit just above)
   */
  constructor(
    private scene: Phaser.Scene,
    private anim: AnimTicker,
    private tileX: number,
    private tileY: number,
    private fw: number,
    private fh: number,
    private tile: number,
    private baseDepth: number,
  ) {}

  private get left(): number {
    return this.tileX * this.tile;
  }
  private get top(): number {
    return this.tileY * this.tile;
  }
  private get bottom(): number {
    return (this.tileY + this.fh) * this.tile;
  }
  private get right(): number {
    return (this.tileX + this.fw) * this.tile;
  }

  private fpKey(): string {
    return this.fw === 2 && this.fh === 2 ? '2x2' : this.fw === 2 ? '2x1' : '1x1';
  }

  private addFire(x: number, y: number, scale = 1): void {
    const seq = FIRE_ROT[this.firePhase % FIRE_ROT.length]!;
    this.firePhase++;
    const s = this.scene.add
      .sprite(x, y, 'fx', seq[0]!)
      .setOrigin(0.5, 1)
      .setDepth(buildingDepth(this.bottom) + 2)
      .setScale(scale);
    this.anim.register(s, 'fx', seq);
    this.fires.push(s);
  }

  private clearTransient(): void {
    this.overlay?.destroy();
    this.overlay = null;
    this.fires.forEach((f) => {
      this.anim.unregister(f);
      f.destroy();
    });
    this.fires = [];
    this.smoke && this.anim.unregister(this.smoke);
    this.smoke?.destroy();
    this.smoke = null;
  }

  /** Re-evaluate against a 0..1 fraction; rebuilds overlays only on stage change. */
  update(frac: number): void {
    const next: Stage = frac > 0.65 ? 0 : frac > 0.32 ? 1 : 2;
    if (next === this.stage) return;
    this.stage = next;
    this.clearTransient();
    if (next === 0) return;

    this.overlay = this.scene.add
      .image(this.left, this.top, 'ovl', `ovl_damage_${this.fpKey()}_s${next}`)
      .setOrigin(0, 0)
      .setDepth(this.baseDepth + 1);

    if (next === 1) {
      // one small flame at a footprint corner
      this.addFire(this.left + this.tile * 0.3, this.bottom, 0.8);
    } else {
      // two staggered medium flames + roof smoke
      this.addFire(this.left + this.tile * 0.3, this.bottom, 1);
      this.addFire(this.right - this.tile * 0.3, this.bottom, 1);
      const sm = this.scene.add
        .sprite((this.left + this.right) / 2, this.top, 'fx', SMOKE_SEQ[0]!)
        .setOrigin(0.5, 1)
        .setDepth(buildingDepth(this.bottom) + 3)
        .setAlpha(0.85);
      this.anim.register(sm, 'fx', SMOKE_SEQ);
      this.smoke = sm;
    }
  }

  /** Collapse → drop overlays/fires/smoke and leave ONE dying fire fading ~10s. */
  collapse(): void {
    this.clearTransient();
    this.stage = 2;
    const dying = this.scene.add
      .sprite((this.left + this.right) / 2, this.bottom, 'fx', FIRE_ROT[0]![0]!)
      .setOrigin(0.5, 1)
      .setDepth(buildingDepth(this.bottom) + 2)
      .setScale(0.7);
    this.anim.register(dying, 'fx', FIRE_ROT[0]!);
    this.fires.push(dying);
    this.scene.tweens.add({
      targets: dying,
      alpha: 0,
      duration: 10_000,
      ease: 'Linear',
      onComplete: () => {
        this.anim.unregister(dying);
        dying.destroy();
      },
    });
  }

  destroy(): void {
    this.clearTransient();
  }
}
