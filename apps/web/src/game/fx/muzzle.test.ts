/**
 * Defence firing visuals.
 *
 * WHAT MAKES THIS WORTH TESTING: every failure here is silent. The sim emits a
 * shot but never a "stopped firing", so the hold is inferred — get it wrong and
 * the archer tower simply never looks idle again, or the mortar strobes, and
 * nothing errors. A stale timer repainting rubble as a tower is a texture write
 * that Phaser is perfectly happy to make. And the muzzle point is now derived
 * per type from art that grew to 4.3 tiles: a wrong fraction fires the arrow out
 * of the tower's wall, which reads as "the projectile looks a bit off" rather
 * than as a bug anyone reports.
 */
import { B13_DEFENCES, DEFENSES } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  cancelDefenceFire, clearMuzzleFx, defenceFire, fireHoldMs, muzzleFlash, muzzleY,
} from './muzzle';

/** Firing cadence of a defence, in ms — whichever of the two the sim gives it. */
function cadenceMs(type: string): number {
  const d = DEFENSES as Record<string, { fireIntervalSec?: number; spawnIntervalSec?: number }>;
  const sec = d[type]?.fireIntervalSec ?? d[type]?.spawnIntervalSec;
  if (sec === undefined) throw new Error(`${type} has no cadence in DEFENSES`);
  return sec * 1000;
}

class FakeSprite {
  active = true;
  x = 640;
  y = 1280; // origin is bottom-centre, so y is the ground line
  depth = 0;
  flipX = false;
  /** Every texture write, in order: `atlas/frame`. */
  readonly writes: string[] = [];
  constructor(public displayHeight = 274) {}
  setTexture(atlas: string, frame: string): this {
    this.writes.push(`${atlas}/${frame}`);
    return this;
  }
  setFlipX(v: boolean): this {
    this.flipX = v;
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  destroy(): void {
    this.active = false;
  }
}

/** Scene with a hand-cranked clock: timers fire in due order, once each. */
class FakeScene {
  now = 0;
  private timers: Array<{ at: number; fn: () => void }> = [];
  readonly images: FakeSprite[] = [];
  readonly tweenTargets: unknown[] = [];
  readonly tweenConfigs: Array<{ targets: unknown; x?: number; onComplete?: () => void }> = [];

  time = {
    delayedCall: (ms: number, fn: () => void): unknown => {
      this.timers.push({ at: this.now + ms, fn });
      return {};
    },
  };

  tweens = {
    add: (cfg: { targets: unknown; x?: number; onComplete?: () => void }): unknown => {
      this.tweenTargets.push(cfg.targets);
      this.tweenConfigs.push(cfg);
      return {};
    },
  };

  add = {
    image: (x: number, y: number, atlas: string, frame: string): FakeSprite => {
      const s = new FakeSprite();
      s.x = x;
      s.y = y;
      s.writes.push(`${atlas}/${frame}`);
      this.images.push(s);
      return s;
    },
  };

  advanceTo(ms: number): void {
    for (;;) {
      const due = this.timers.filter((t) => t.at <= ms).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const next = due[0]!;
      this.timers = this.timers.filter((t) => t !== next);
      this.now = next.at;
      next.fn();
    }
    this.now = ms;
  }
}

const scene = (): Phaser.Scene & FakeScene => new FakeScene() as never;

describe('fireHoldMs', () => {
  it('stays strictly under every batch-13 defence own firing cadence', () => {
    // THE invariant: there is no "stopped firing" event, so the hold is the only
    // thing that returns a defence to idle. At or above the interval the 0.5s
    // archer tower re-enters its fire frames before it ever gets back — it would
    // never once look idle in a whole raid.
    for (const type of B13_DEFENCES) {
      expect(fireHoldMs(type), type).toBeGreaterThan(0);
      expect(fireHoldMs(type), type).toBeLessThan(cadenceMs(type));
    }
  });

  it('caps slow weapons instead of scaling with them', () => {
    // The mortar fires every 4s. A hold proportional to that would leave it
    // sitting in its recoil pose for seconds — it reads as jammed, not as a big
    // gun — so a discrete puff and back to idle.
    expect(cadenceMs('mortar')).toBe(4000);
    expect(fireHoldMs('mortar')).toBeLessThan(1000);
    // ...and the fast one is NOT capped up to the same value: its shot has to
    // fit inside a 500ms cadence.
    expect(fireHoldMs('archertower')).toBeLessThan(fireHoldMs('mortar'));
  });

  it('gives the Dragon Nest a hold even though it has no fire interval', () => {
    // It has no direct-fire weapon at all; its cadence is the spawn loop.
    expect((DEFENSES.dragonnest as { fireIntervalSec?: number }).fireIntervalSec).toBeUndefined();
    expect(fireHoldMs('dragonnest')).toBeGreaterThan(0);
  });
});

/** Packed-meta stand-in: `${idleKey}_fire_fN`-presence is ALL defenceFire
 *  reads from it. Mirrors the real pack — the six older defences ship 2 fire
 *  frames, the v2 electric tower 4. */
function fireMeta(idleKey: string, frames: number): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (let f = 1; f <= frames; f++) m[`${idleKey}_fire_f${f}`] = {};
  return m;
}

describe('defenceFire', () => {
  const IDLE = 'bld_archertower_l20';
  const META = fireMeta(IDLE, 2);

  it('plays f1 then f2 then returns to idle, all from the blddef atlas', () => {
    const s = scene();
    const sprite = new FakeSprite() as never as Phaser.GameObjects.Sprite;
    defenceFire(s, sprite, 'archertower', IDLE, META);
    const hold = fireHoldMs('archertower');
    const writes = (sprite as never as FakeSprite).writes;
    expect(writes).toEqual([`blddef/${IDLE}_fire_f1`]);
    s.advanceTo(hold / 2);
    expect(writes).toEqual([`blddef/${IDLE}_fire_f1`, `blddef/${IDLE}_fire_f2`]);
    s.advanceTo(hold);
    expect(writes).toEqual([
      `blddef/${IDLE}_fire_f1`, `blddef/${IDLE}_fire_f2`, `blddef/${IDLE}`,
    ]);
  });

  it('plays ALL FOUR electric discharge frames inside the hold, then idle', () => {
    // v2: the electric tower is the one defence with a 4-frame fire clip. The
    // pre-v2 hardcoded f1→f2 schedule would silently skip _fire_f3/_f4 —
    // exactly the bug the meta-probed clip length exists to prevent.
    const idle = 'bld_electrictower_l3';
    const s = scene();
    const sprite = new FakeSprite();
    defenceFire(s, sprite as never, 'electrictower', idle, fireMeta(idle, 4));
    const hold = fireHoldMs('electrictower');
    s.advanceTo(hold);
    expect(sprite.writes).toEqual([
      `blddef/${idle}_fire_f1`,
      `blddef/${idle}_fire_f2`,
      `blddef/${idle}_fire_f3`,
      `blddef/${idle}_fire_f4`,
      `blddef/${idle}`,
    ]);
  });

  it('leaves every non-defence building type completely alone', () => {
    // Only the seven reworked defences have `_fire_*` masters. Asking for one
    // on anything else would swap in a frame that does not exist — Phaser draws
    // NOTHING for a missing frame, so the building would vanish mid-raid.
    const s = scene();
    for (const type of ['keep', 'wall', 'spiketrap', 'goldforge']) {
      const sprite = new FakeSprite();
      const idle = `bld_${type}_l3`;
      defenceFire(s, sprite as never, type, idle, fireMeta(idle, 2));
      s.advanceTo(s.now + 5000);
      expect(sprite.writes, type).toEqual([]);
    }
  });

  it('fails safe to NO animation when the meta lacks the fire family', () => {
    // Same missing-frame reasoning, other direction: a defence whose meta rows
    // never arrived must idle rather than swap to a nonexistent frame.
    const s = scene();
    const sprite = new FakeSprite();
    defenceFire(s, sprite as never, 'archertower', IDLE, {});
    s.advanceTo(5000);
    expect(sprite.writes).toEqual([]);
  });

  it('lets a new shot supersede the one still playing', () => {
    // The archer tower fires every 500ms and holds for 350, so an overlap needs
    // a re-sim or a lag spike — but when it happens, the FIRST shot's reset must
    // not drop the tower back to idle in the middle of the second shot.
    const s = scene();
    const sprite = new FakeSprite();
    const hold = fireHoldMs('archertower');
    defenceFire(s, sprite as never, 'archertower', IDLE, META);
    s.advanceTo(100);
    defenceFire(s, sprite as never, 'archertower', IDLE, META);
    s.advanceTo(hold + 20); // the first shot's reset is due here
    expect(sprite.writes.at(-1)).toBe(`blddef/${IDLE}_fire_f2`);
    s.advanceTo(100 + hold);
    expect(sprite.writes.at(-1)).toBe(`blddef/${IDLE}`);
  });

  it('cancels a shot in flight so it cannot repaint rubble as a tower', () => {
    const s = scene();
    const sprite = new FakeSprite();
    defenceFire(s, sprite as never, 'mortar', 'bld_mortar_l7', fireMeta('bld_mortar_l7', 2));
    cancelDefenceFire(sprite as never);
    sprite.setTexture('fx', 'fx_rubble_2x2'); // the scene's collapse
    s.advanceTo(5000);
    expect(sprite.writes.at(-1)).toBe('fx/fx_rubble_2x2');
  });

  it('never writes to a destroyed sprite', () => {
    const s = scene();
    const sprite = new FakeSprite();
    defenceFire(s, sprite as never, 'cannon', 'bld_cannon_l1', fireMeta('bld_cannon_l1', 2));
    const afterStart = sprite.writes.length;
    sprite.destroy();
    s.advanceTo(5000);
    expect(sprite.writes.length).toBe(afterStart);
  });

  it('restores a durable defence to its authoritative seat when verdict cleanup kills recoil', () => {
    // WHY: BattleScene keeps building sprites across jumpToEnd, while Phaser's
    // killAll() stops a yoyo tween wherever it happens to be. Cancellation must
    // therefore restore the remembered home X or the final battlefield leaves
    // an archer tower visibly shifted after the verdict.
    const s = scene();
    const sprite = new FakeSprite();
    const homeX = sprite.x;
    muzzleFlash(s, sprite as never, 'archertower', homeX + 200);
    const recoilX = s.tweenConfigs[0]!.x!;
    expect(recoilX).not.toBe(homeX);
    sprite.x = recoilX; // model killAll halfway through the outbound/yoyo leg

    cancelDefenceFire(sprite as never);

    expect(sprite.x).toBe(homeX);
    sprite.x = homeX + 20; // later authoritative placement (or scene teardown)
    s.tweenConfigs[0]!.onComplete?.(); // stale Phaser completion must be inert
    expect(sprite.x).toBe(homeX + 20);
  });

  it('destroys a timer-owned muzzle overlay when verdict cleanup clears its timer', () => {
    // WHY: the overlay has no tween target. Once jumpToEnd removes its destroy
    // timer, only the explicit scene registry can prevent a permanent muzzle
    // flash behind the verdict.
    const s = scene();
    const sprite = new FakeSprite();
    muzzleFlash(s, sprite as never, 'archertower', sprite.x + 100);
    const overlay = s.images[0]!;
    expect(overlay.active).toBe(true);

    clearMuzzleFx(s);
    clearMuzzleFx(s); // SHUTDOWN after verdict is deliberately idempotent

    expect(overlay.active).toBe(false);
  });
});

describe('muzzleY', () => {
  /**
   * The band, as a fraction of sprite height above the ground, where each
   * defence's `_fire_f1` master actually differs from its idle master — i.e.
   * where the art itself says the shot happens. Measured off blddef@2x.png at L1
   * and L20 and intersected, so a fraction inside this band is on the weapon at
   * EVERY level. These are art facts; if the masters are redrawn they move.
   */
  const FIRE_BAND: Record<string, [number, number]> = {
    archertower: [0.72, 0.79],
    magetower: [0.80, 0.91],
    lasertower: [0.73, 0.98],
    cannon: [0.25, 0.89],
    mortar: [0.14, 0.93],
    // v2 electric: the fire-vs-idle diff is nearly the whole mast (bolt +
    // flares + bloom), so its band is the CROWN the bolt departs from — the
    // top rows of a canvas the art fills completely (topmost opaque row is 0
    // at L1/L10/L20, measured from the pack masters, idle and fire alike).
    electrictower: [0.83, 0.99],
  };

  it('puts the shot inside the band where the art draws it firing', () => {
    for (const [type, [lo, hi]] of Object.entries(FIRE_BAND)) {
      const sprite = new FakeSprite(274) as never as Phaser.GameObjects.Sprite;
      const frac = (sprite.y - muzzleY(sprite, type)) / sprite.displayHeight;
      expect(frac, type).toBeGreaterThan(lo);
      expect(frac, type).toBeLessThan(hi);
    }
  });

  it('scales with the sprite, so an L20 tower fires higher than an L1 one', () => {
    const l1 = new FakeSprite(144) as never as Phaser.GameObjects.Sprite;
    const l20 = new FakeSprite(274) as never as Phaser.GameObjects.Sprite;
    expect(muzzleY(l20, 'archertower')).toBeLessThan(muzzleY(l1, 'archertower'));
    // and never off the sprite in either direction
    for (const s of [l1, l20]) {
      expect(s.y - muzzleY(s, 'archertower')).toBeGreaterThan(0);
      expect(s.y - muzzleY(s, 'archertower')).toBeLessThan(s.displayHeight);
    }
  });

  it('leaves genuinely untouched defence types on the historical fraction', () => {
    // The Dragon Nest never fires a projectile, but muzzleY must still answer
    // something sane for it (its spawn plays fire art) — the default 0.6.
    const sprite = new FakeSprite(196) as never as Phaser.GameObjects.Sprite;
    expect(sprite.y - muzzleY(sprite, 'dragonnest')).toBeCloseTo(196 * 0.6, 6);
  });
});

describe('muzzleFlash', () => {
  it('flips the defence toward a target to its west', () => {
    const s = scene();
    const east = new FakeSprite();
    const west = new FakeSprite();
    muzzleFlash(s, east as never, 'archertower', east.x + 500);
    muzzleFlash(s, west as never, 'archertower', west.x - 500);
    expect(east.flipX).toBe(false);
    expect(west.flipX).toBe(true);
  });

  it('drops the engine recoil only where the batch-13 art kicks itself', () => {
    // Measured: the cannon's fire frames redraw rows 16-151 of 158 and the
    // mortar's 12-183 of 192 — the whole gun moves. Kicking the sprite as well
    // would double the motion. The other towers only repaint their weapon (the
    // archer tower repaints rows 56-83 of 274), so the engine kick is the only
    // thing that moves them at all.
    for (const type of ['cannon', 'mortar'] as const) {
      const s = scene();
      muzzleFlash(s, new FakeSprite() as never, type, 0);
      expect(s.tweenTargets, type).toEqual([]);
    }
    for (const type of ['archertower', 'magetower'] as const) {
      const s = scene();
      const sprite = new FakeSprite();
      muzzleFlash(s, sprite as never, type, 0);
      expect(s.tweenTargets, type).toEqual([sprite]);
    }
  });

  it('hangs the overlay on the muzzle point', () => {
    // v2 note: the electric tower has NO overlay any more (its discharge is
    // baked into `_fire_f1.._f4`), so there is no top-anchored exception left
    // to pin — muzzleFlash is simply never called for it.
    const s = scene();
    const tower = new FakeSprite();
    muzzleFlash(s, tower as never, 'archertower', tower.x + 10);
    expect(s.images[0]!.y).toBeCloseTo(muzzleY(tower as never, 'archertower'), 6);
  });
});
