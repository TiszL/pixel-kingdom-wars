/**
 * V2Ticker — per-clip-fps playback.
 *
 * WHY these matter: the manifest fps range spans 3fps (idle) to 20fps
 * (muzzle), so a wrong step plays a flash as a slideshow or an idle as a
 * strobe; a one-shot that never completes strands a defence mid-fire forever
 * (no follow-up reload/idle registration); and a row swap that resets the
 * frame index is the anim.ts "dizzy shuffle" bug in its third incarnation —
 * a wobbling heading re-registers every frame and pins the gait at frame 1.
 */
import { readFileSync } from 'node:fs';
import { atlasGroupFor } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';
import { WareHatchlingFx } from '../ware/hatchling';
import { wareFacingFrames, wareHatchlingClipKey, type WareClipMap } from '../ware/clips';
import type { Facing8 } from './clips';
import { V2Ticker } from './ticker';

class FakeSprite {
  active = true;
  readonly writes: string[] = [];
  setTexture(atlas: string, frame: string): this {
    this.writes.push(`${atlas}/${frame}`);
    return this;
  }
  once(): this { return this; }
  destroy(): void { this.active = false; }
}

const seq = (base: string, row: number, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${base}_d${row}_f${i + 1}`);

function make(): { ticker: V2Ticker; sprite: FakeSprite; sp: Phaser.GameObjects.Sprite } {
  const sprite = new FakeSprite();
  return { ticker: new V2Ticker(), sprite, sp: sprite as never };
}

describe('V2Ticker playback', () => {
  it('shows frame 1 immediately and steps at the CLIP fps, not a house clock', () => {
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'walk', seq: seq('walk', 0, 4), fps: 10, loop: true });
    expect(sprite.writes).toEqual(['a/walk_d0_f1']);
    ticker.tick(99); // 10fps = 100ms/frame — a hair early must NOT advance
    expect(sprite.writes).toHaveLength(1);
    ticker.tick(1);
    expect(sprite.writes.at(-1)).toBe('a/walk_d0_f2');
  });

  it('advances at the playback catch-up scale used by the scene clock', () => {
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'fly', seq: seq('fly', 0, 8), fps: 10, loop: true });
    ticker.setTimeScale(8);
    ticker.tick(100);
    expect(sprite.writes.at(-1)).toBe('a/fly_d0_f1');
    ticker.tick(12.5);
    expect(sprite.writes.at(-1)).toBe('a/fly_d0_f2');
    ticker.setTimeScale(1);
    ticker.tick(100);
    expect(sprite.writes.at(-1)).toBe('a/fly_d0_f3');
  });

  it('settles one-shots on their final frame and leaves no generation work', () => {
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'death', seq: seq('death', 0, 4), fps: 10, loop: false });
    ticker.settle();
    expect(sprite.writes.at(-1)).toBe('a/death_d0_f4');
    expect(ticker.size).toBe(0);
  });

  it('rests a one-shot on its hold cell instead of the authored final frame, on completion AND on settle', () => {
    // WHY: the camp pack's collapse is a sink whose last cell is a dirt sliver
    // (owner 2026-09-17 "camp destroyed state looks awful"). The rubble the
    // player sees for the rest of the raid must come from the hold cell on
    // BOTH exits — a verdict that settles mid-sink used to freeze the sliver.
    const live = make();
    live.ticker.play(live.sp, {
      atlas: 'a', base: 'collapse', seq: seq('collapse', 0, 3), fps: 10, loop: false,
      hold: { atlas: 'ware_ruin_camp' },
    });
    live.ticker.tick(200);
    expect(live.sprite.writes.at(-1)).toBe('a/collapse_d0_f3'); // the sink still plays out
    live.ticker.tick(100);
    expect(live.sprite.writes.at(-1)).toBe('ware_ruin_camp/undefined');
    expect(live.ticker.size).toBe(0);

    const settled = make();
    settled.ticker.play(settled.sp, {
      atlas: 'a', base: 'collapse', seq: seq('collapse', 0, 3), fps: 10, loop: false,
      hold: { atlas: 'ware_ruin_camp' },
    });
    settled.ticker.tick(100);
    settled.ticker.settle();
    expect(settled.sprite.writes.at(-1)).toBe('ware_ruin_camp/undefined');
    expect(settled.ticker.size).toBe(0);
  });

  it('loops a loop clip and wraps back to frame 1', () => {
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'idle', seq: seq('idle', 0, 2), fps: 10, loop: true });
    for (let i = 0; i < 4; i++) ticker.tick(100);
    expect(sprite.writes).toEqual([
      'a/idle_d0_f1', 'a/idle_d0_f2', 'a/idle_d0_f1', 'a/idle_d0_f2', 'a/idle_d0_f1',
    ]);
  });

  it('one-shots hold the LAST frame, drop the entry, then fire onComplete (chaining works)', () => {
    const { ticker, sprite, sp } = make();
    let completed = 0;
    ticker.play(sp, {
      atlas: 'a', base: 'fire', seq: seq('fire', 0, 3), fps: 10, loop: false,
      onComplete: () => {
        completed++;
        // The follow-up registration a defence does (fire → reload) must be
        // legal from inside the callback.
        ticker.play(sp, { atlas: 'a', base: 'reload', seq: seq('reload', 0, 2), fps: 10, loop: true });
      },
    });
    ticker.tick(200); // f2, f3
    expect(completed).toBe(0); // the last frame gets its full dwell
    ticker.tick(100);
    expect(completed).toBe(1);
    expect(sprite.writes.at(-1)).toBe('a/reload_d0_f1');
    // The live Map iterator may observe an entry inserted by onComplete. The
    // generation gate must leave that new loop on frame 1 until the NEXT tick,
    // without rebuilding a snapshot array every rendered frame.
    expect(sprite.writes.filter((write) => write.startsWith('a/reload'))).toEqual([
      'a/reload_d0_f1',
    ]);
    ticker.tick(100);
    expect(sprite.writes.at(-1)).toBe('a/reload_d0_f2');
    ticker.tick(1000);
    expect(completed).toBe(1); // one-shot means once
  });

  it('fires onFrame for every frame ENTERED — including catch-up after a long dt', () => {
    // A GC pause must not skip an fxAt frame: the boulder launch or the
    // muzzle flash would silently never spawn.
    const { ticker, sp } = make();
    const seen: number[] = [];
    ticker.play(sp, {
      atlas: 'a', base: 'throw', seq: seq('throw', 0, 6), fps: 12, loop: false,
      onFrame: (f) => seen.push(f),
    });
    ticker.tick(1000); // one giant dt spanning the whole clip
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('bounds looping catch-up after a backgrounded tab and suppresses expired FX bursts', () => {
    const { ticker, sprite, sp } = make();
    const seen: number[] = [];
    ticker.play(sp, {
      atlas: 'a', base: 'fly', seq: seq('fly', 0, 8), fps: 12, loop: true,
      onFrame: (frame) => seen.push(frame),
    });
    ticker.tick(10 * 60_000);
    expect(sprite.writes.length).toBeLessThanOrEqual(2); // initial + one resume phase
    expect(seen.length).toBeLessThanOrEqual(2);
  });

  it('skips one fully expired loop instead of replaying every frame and its FX', () => {
    const { ticker, sprite, sp } = make();
    const seen: number[] = [];
    ticker.play(sp, {
      atlas: 'a', base: 'fly', seq: seq('fly', 0, 8), fps: 8, loop: true,
      onFrame: (frame) => seen.push(frame),
    });
    ticker.tick(1_000);
    expect(sprite.writes.length).toBe(2); // initial frame + resumed visible phase
    expect(seen).toEqual([1, 1]);
  });

  it('preserves the frame index on a same-clip row swap (the dizzy-shuffle guard)', () => {
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'walk', seq: seq('walk', 0, 8), fps: 10, loop: true });
    ticker.tick(300); // now on f4
    expect(sprite.writes.at(-1)).toBe('a/walk_d0_f4');
    ticker.play(sp, { atlas: 'a', base: 'walk', seq: seq('walk', 3, 8), fps: 10, loop: true });
    // Same clip, same length, new row: the stride carries — frame 4, row 3.
    expect(sprite.writes.at(-1)).toBe('a/walk_d3_f4');
    ticker.tick(100);
    expect(sprite.writes.at(-1)).toBe('a/walk_d3_f5');
  });

  it('an identical re-registration is a no-op (a per-frame caller must not reset phase)', () => {
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'walk', seq: seq('walk', 0, 8), fps: 10, loop: true });
    ticker.tick(250);
    const writes = sprite.writes.length;
    ticker.play(sp, { atlas: 'a', base: 'walk', seq: seq('walk', 0, 8), fps: 10, loop: true });
    expect(sprite.writes).toHaveLength(writes); // not even a redundant setTexture
    ticker.tick(50); // the 250ms of accumulated phase still counts
    expect(sprite.writes.at(-1)).toBe('a/walk_d0_f4');
  });

  it('holds frame 0 of an authored fps:0 clip instead of refusing to draw (K-053)', () => {
    // WHY: the damaged wall sheets deliberately ship `fps: 0` — a static state,
    // not an animation. The old guard returned before setting a texture, so the
    // intact body stayed on screen while the controller believed damage showed.
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'walk', seq: seq('walk', 0, 4), fps: 10, loop: true });
    const seen: number[] = [];
    ticker.play(sp, {
      atlas: 'w', base: 'damaged', seq: seq('damaged', 3, 2), fps: 0, loop: true,
      onFrame: (frame1) => seen.push(frame1),
    });
    expect(sprite.writes.at(-1)).toBe('w/damaged_d3_f1');
    expect(seen).toEqual([1]); // the fxAt hook still fires for the held frame
    const before = sprite.writes.length;
    ticker.tick(1_000); // the replaced walk entry is gone — nothing may advance
    expect(sprite.writes).toHaveLength(before);
    // An empty sequence stays a refusal: there is no frame to hold.
    ticker.play(sp, { atlas: 'w', base: 'empty', seq: [], fps: 0, loop: true });
    expect(sprite.writes).toHaveLength(before);
  });

  it('a DIFFERENT clip restarts at frame 1 — walk→idle is a new animation', () => {
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'walk', seq: seq('walk', 0, 8), fps: 10, loop: true });
    ticker.tick(300);
    ticker.play(sp, { atlas: 'a', base: 'idle', seq: seq('idle', 0, 4), fps: 6, loop: true });
    expect(sprite.writes.at(-1)).toBe('a/idle_d0_f1');
  });

  it('drops a destroyed sprite instead of writing to it', () => {
    const { ticker, sprite, sp } = make();
    ticker.play(sp, { atlas: 'a', base: 'walk', seq: seq('walk', 0, 4), fps: 10, loop: true });
    sprite.destroy();
    ticker.tick(1000);
    expect(sprite.writes).toEqual(['a/walk_d0_f1']); // nothing after death
  });
});

describe('current packed Hatchling lifecycle loops', () => {
  const { wareClips } = JSON.parse(readFileSync(
    new URL('../../../public/atlas/meta.json', import.meta.url), 'utf8',
  )) as { wareClips: WareClipMap };

  it.each([1, 6, 11, 16])('plays every hover/fly frame for multiple cycles at level %i', (level) => {
    class HatchlingSprite extends FakeSprite {
      x = 320;
      y = 240;
      setOrigin(): this { return this; }
      setScale(): this { return this; }
      setDepth(): this { return this; }
    }
    const sprite = new HatchlingSprite();
    const ticker = new V2Ticker();
    const atlas = atlasGroupFor(`${wareHatchlingClipKey(level, 'hover')}_d0_f1`);
    const packed = JSON.parse(readFileSync(
      new URL(`../../../public/atlas/${atlas}@1x.json`, import.meta.url), 'utf8',
    )) as { textures: Array<{ frames: Array<{ filename: string }> }> };
    const packedFrames = new Set(packed.textures.flatMap((texture) => texture.frames.map((f) => f.filename)));
    let arrive: (() => void) | undefined;
    const scene = {
      textures: { exists: (key: string) => key === atlas },
      add: { sprite: () => sprite },
      tweens: {
        killTweensOf: () => undefined,
        add: (config: { onComplete: () => void }) => { arrive = config.onComplete; return {}; },
      },
    };
    const fx = new WareHatchlingFx(scene as never, {
      ticker, clips: wareClips, level, rich: true,
    }, sprite.x, sprite.y, sprite.y);
    expect(fx.rich).toBe(true);
    const spawn = wareClips[wareHatchlingClipKey(level, 'spawn')]!;
    ticker.tick(spawn.frames * 1000 / spawn.fps! + 0.01);

    function assertTwoLoops(state: 'hover' | 'fly', facing: Facing8): void {
      const base = wareHatchlingClipKey(level, state);
      const clip = wareClips[base]!;
      const frames = wareFacingFrames(wareClips, base, facing);
      expect(clip.loop, `${base} remains an authored loop`).toBe(true);
      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames) expect(packedFrames.has(frame), `${frame} exists in the packed atlas`).toBe(true);
      const expected = frames.map((frame) => `${atlas}/${frame}`);
      expect(sprite.writes.at(-1)).toBe(expected[0]);
      const start = sprite.writes.length - 1;
      // Drive frame-sized deltas, not a large catch-up jump that could conceal
      // a frozen intermediate frame or a controller accidentally using once.
      for (let frame = 0; frame < frames.length * 2; frame++) ticker.tick(1000 / clip.fps! + 0.01);
      expect(sprite.writes.slice(start)).toEqual([...expected, ...expected, expected[0]]);
    }

    assertTwoLoops('hover', 's');
    fx.onPos(sprite.x + 100, sprite.y, 10_000);
    assertTwoLoops('fly', 'e');
    expect(arrive).toBeTypeOf('function');
    arrive!();
    assertTwoLoops('hover', 'e');
    fx.destroy();
    expect(ticker.size).toBe(0);
  });
});
