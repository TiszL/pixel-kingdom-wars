/**
 * Floating HP bars (HANDOFF §4.1): Night-Ink backing, fill Meadow >50% /
 * Vault Gold >25% / Ember below. Troop bars float ~32×6 world px above the
 * sprite and deplete per `hit`; building bars are persistent once damaged.
 *
 * Scenes render 1 game px = 2 world px, so the App's 5px bar → ~10px tall here;
 * the brief's "32×6 world px" troop bar is honoured directly in world units.
 * Bars are drawn as a 3-rect stack (outline / bg / fill) parented to the
 * entity each frame via an updater the scene calls; they never accept input.
 */
import type Phaser from 'phaser';

const INK = 0x1a171e; // Night Ink
const MEADOW = 0x8cb36e; // >50%
const GOLD = 0xe3ae3c; // >25%
const EMBER = 0xc75a2e; // below

const TROOP_W = 32;
const TROOP_H = 6;
const BLD_W = 48;
const BLD_H = 8;

function fillColor(frac: number): number {
  if (frac > 0.5) return MEADOW;
  if (frac > 0.25) return GOLD;
  return EMBER;
}

export class HpBar {
  private g: Phaser.GameObjects.Graphics;
  private readonly w: number;
  private readonly h: number;
  private readonly yOff: number;
  /** Last drawn (cx, topY, frac): draw() is driven EVERY frame for every entity
   *  (BattleScene.update), but a bar only changes on movement or damage —
   *  early-outing the clear()+refill drops hundreds of per-frame Graphics
   *  command-list rebuilds (Seeker perf audit). NaN ≠ NaN, so the first draw
   *  always paints. */
  private lastCx = NaN;
  private lastTopY = NaN;
  private lastFrac = NaN;

  constructor(scene: Phaser.Scene, kind: 'troop' | 'building', depth: number, yOff: number) {
    this.w = kind === 'troop' ? TROOP_W : BLD_W;
    this.h = kind === 'troop' ? TROOP_H : BLD_H;
    this.yOff = yOff;
    this.g = scene.add.graphics().setDepth(depth);
  }

  /** Redraw at (cx, topY) with a 0..1 fill fraction; cx/topY are world px. */
  draw(cx: number, topY: number, frac: number): void {
    const f = Math.max(0, Math.min(1, frac));
    if (cx === this.lastCx && topY === this.lastTopY && f === this.lastFrac) return;
    this.lastCx = cx;
    this.lastTopY = topY;
    this.lastFrac = f;
    const x = cx - this.w / 2;
    const y = topY - this.yOff - this.h;
    this.g.clear();
    // outline + bg in Night Ink, fill in HP-band color
    this.g.fillStyle(INK, 0.92);
    this.g.fillRect(x - 1, y - 1, this.w + 2, this.h + 2);
    this.g.fillStyle(fillColor(f), 1);
    if (f > 0) this.g.fillRect(x, y, Math.max(1, Math.round(this.w * f)), this.h);
  }

  setVisible(v: boolean): void {
    this.g.setVisible(v);
  }

  destroy(): void {
    this.g.destroy();
  }
}
