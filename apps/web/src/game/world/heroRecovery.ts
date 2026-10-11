/**
 * Server-authoritative hero recovery presentation for the home base.
 *
 * A recovering hero cannot patrol, attack, or defend. Keep that state visible
 * where the player recruited them: the shipped final defeat frame rests at the
 * completed altar while a compact chip counts down the server deadline. The
 * server `available` bit remains truth across device-clock skew; an elapsed
 * local countdown waits visibly for the next authoritative refresh.
 */
import { AMBIENCE } from '@shardkeep/shared';
import { fmtDur } from '../../lib/duration';
import type Phaser from 'phaser';
import type { BaseStateDto } from '../../state/store';
import { atlasFor } from '../scenes/BootScene';
import { actorDepth, overlayDepth } from './depth';

type Hero = NonNullable<BaseStateDto['heroes']>[number];
type HeroName = Hero['hero'];
type Building = BaseStateDto['buildings'][number];

/** The countdown chip is world UI above the altar, not part of the body. */
const CHIP_DEPTH = overlayDepth(2210);

const HERO_ART: Record<HeroName, { building: string; frame: string; label: string }> = {
  vex: { building: 'heroaltar', frame: 'hero_vex_defeat_f3', label: 'VEX' },
  theodor: { building: 'siegestool', frame: 'hero_theo_defeat_f4', label: 'THEODOR' },
};

interface RecoveryVis {
  hero: Phaser.GameObjects.Sprite;
  chipBg: Phaser.GameObjects.Rectangle;
  chipText: Phaser.GameObjects.Text;
  deadlineMs: number;
  label: string;
  buildingId: string;
}

/** Remaining recovery as a unit label ("1h 1m" / "1m 5s") — "1:01" read as minutes OR hours. */
export function recoveryCountdown(deadlineMs: number, nowMs: number): string | null {
  const remainingSec = Math.ceil((deadlineMs - nowMs) / 1_000);
  if (!Number.isFinite(remainingSec) || remainingSec <= 0) return null;
  return fmtDur(remainingSec).toUpperCase();
}

export class HeroRecoveryLayer {
  private readonly vis = new Map<HeroName, RecoveryVis>();
  /** Wall-clock second the chips were last rendered for (armyStatus pattern). */
  private lastSecond = Number.NaN;

  constructor(
    private readonly scene: Phaser.Scene,
    /** World pixels per tile (64 in the base scene). */
    private readonly T: number,
  ) {}

  /** Reconcile the visuals with the latest authoritative base snapshot. */
  sync(
    heroes: ReadonlyArray<Hero>,
    buildings: ReadonlyArray<Building>,
    footprintOf: (building: Building) => { fw: number; fh: number },
    nowMs = Date.now(),
  ): void {
    const seen = new Set<HeroName>();

    for (const state of heroes) {
      if (state.available) continue;
      const deadlineMs = state.recoveryUntil === null ? Number.NaN : Date.parse(state.recoveryUntil);

      const art = HERO_ART[state.hero];
      const altar = buildings
        .filter((building) => building.type === art.building && !building.underConstruction)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!altar) continue;

      seen.add(state.hero);
      const fp = footprintOf(altar);
      const x = (altar.tx + fp.fw / 2) * this.T;
      const feetY = (altar.ty + fp.fh) * this.T;
      const chipY = altar.ty * this.T;

      let current = this.vis.get(state.hero);
      if (!current) {
        const hero = this.scene.add.sprite(x, feetY, atlasFor(art.frame), art.frame)
          .setOrigin(0.5, 1)
          .setScale(AMBIENCE.heroPatrolScale)
          .setDepth(actorDepth(feetY));
        const chipBg = this.scene.add.rectangle(x, chipY, 10, 10, 0x1a0f12, 0.94)
          .setOrigin(0.5, 1)
          .setStrokeStyle(2, 0x923746)
          .setDepth(CHIP_DEPTH);
        const chipText = this.scene.add.text(x, chipY, '', {
          align: 'center',
          color: '#ffd6d6',
          fontFamily: 'VT323, monospace',
          fontSize: '18px',
          lineSpacing: -2,
        }).setOrigin(0.5, 1).setDepth(CHIP_DEPTH + 1);
        current = { hero, chipBg, chipText, deadlineMs, label: art.label, buildingId: altar.id };
        this.vis.set(state.hero, current);
      }

      current.deadlineMs = deadlineMs;
      current.label = art.label;
      current.buildingId = altar.id;
      current.hero
        .setPosition(x, feetY)
        .setScale(AMBIENCE.heroPatrolScale)
        .setDepth(actorDepth(feetY));
      current.chipText.setPosition(x, chipY).setDepth(CHIP_DEPTH + 1);
      current.chipBg.setPosition(x, chipY).setDepth(CHIP_DEPTH);
      this.updateVisual(current, nowMs);
    }

    for (const [hero, current] of [...this.vis]) {
      if (!seen.has(hero)) this.dispose(hero, current);
    }
    for (const current of this.vis.values()) this.setVisible(current, true);
    // The snapshot above wrote every chip for `nowMs`; the next update() re-checks
    // the boundary from scratch rather than trusting a caller-supplied clock.
    this.lastSecond = Number.NaN;
  }

  /**
   * Refresh the visible countdown once per wall-clock second (D-101, M33
   * package D): the label only changes on a second boundary, and every
   * setText rasterises a canvas while setSize is a layout write — per downed
   * hero per frame that was pure waste on the Seeker. Only a new server
   * snapshot retires recovery.
   */
  update(nowMs: number): void {
    const second = Math.floor(nowMs / 1_000);
    if (second === this.lastSecond) return;
    this.lastSecond = second;
    for (const current of this.vis.values()) this.updateVisual(current, nowMs);
  }

  private updateVisual(current: RecoveryVis, nowMs: number): void {
    const countdown = recoveryCountdown(current.deadlineMs, nowMs);
    current.chipText.setText(`${current.label} · RECOVERING\n${countdown ?? 'VERIFYING'}`);
    current.chipBg.setSize(current.chipText.width + 16, current.chipText.height + 8);
  }

  /** Hide the downed actor/chip while its owning altar is being dragged. */
  hide(buildingId: string): void {
    for (const current of this.vis.values()) {
      if (current.buildingId === buildingId) this.setVisible(current, false);
    }
  }

  /** Restore a hidden actor when a drag ends without an authoritative refresh. */
  show(buildingId: string): void {
    for (const current of this.vis.values()) {
      if (current.buildingId === buildingId) this.setVisible(current, true);
    }
  }

  private setVisible(current: RecoveryVis, visible: boolean): void {
    current.hero.setVisible(visible);
    current.chipBg.setVisible(visible);
    current.chipText.setVisible(visible);
  }

  private dispose(hero: HeroName, current: RecoveryVis): void {
    current.hero.destroy();
    current.chipBg.destroy();
    current.chipText.destroy();
    this.vis.delete(hero);
  }

  destroy(): void {
    for (const [hero, current] of [...this.vis]) this.dispose(hero, current);
  }
}
