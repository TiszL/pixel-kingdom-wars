import { describe, expect, it } from 'vitest';
import { BreathStream } from './breath';
import { V2_DRAW_SCALE, type V2ClipMap } from './clips';
import { advanceCombatEffects, combatEffectCount, combatEffectPool } from './effects';

class FakeImage {
  active = true;
  origin: [number, number] = [0, 0];
  readonly writes: string[];
  constructor(public x: number, public y: number, atlas: string, frame: string) {
    this.writes = [`${atlas}/${frame}`];
  }
  setOrigin(x: number, y: number): this { this.origin = [x, y]; return this; }
  setTexture(atlas: string, frame: string): this { this.writes.push(`${atlas}/${frame}`); return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  destroy(): void { this.active = false; }
}

class FakeTile extends FakeImage {
  constructor(x: number, y: number, public width: number, public height: number,
    atlas: string, frame: string) { super(x, y, atlas, frame); }
  setSize(width: number, height: number): this {
    this.width = width; this.height = height; return this;
  }
}

class FakeContainer {
  depth = 0;
  scale = 1;
  rotation = 0;
  children: FakeImage[] = [];
  constructor(public x: number, public y: number) {}
  setDepth(v: number): this { this.depth = v; return this; }
  setScale(v: number): this { this.scale = v; return this; }
  setRotation(v: number): this { this.rotation = v; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  add(children: FakeImage[]): this { this.children.push(...children); return this; }
  destroy(destroyChildren: boolean): void {
    if (destroyChildren) this.children.forEach((child) => child.destroy());
  }
}

class FakeScene {
  readonly images: FakeImage[] = [];
  readonly tiles: FakeTile[] = [];
  readonly containers: FakeContainer[] = [];
  readonly textures = { exists: () => true };
  readonly add = {
    container: (x: number, y: number): FakeContainer => {
      const value = new FakeContainer(x, y); this.containers.push(value); return value;
    },
    image: (x: number, y: number, atlas: string, frame: string): FakeImage => {
      const value = new FakeImage(x, y, atlas, frame); this.images.push(value); return value;
    },
    tileSprite: (x: number, y: number, width: number, height: number,
      atlas: string, frame: string): FakeTile => {
      const value = new FakeTile(x, y, width, height, atlas, frame);
      this.tiles.push(value); return value;
    },
  };
}

const CLIPS: V2ClipMap = {
  v2_fx_stream_root_t1: { frames: 4, rows: 1, cellW: 32, cellH: 24, anchorPx: [4, 12], fps: 10 },
  v2_fx_stream_mid_t1: { frames: 4, rows: 1, cellW: 16, cellH: 24, anchorPx: [0, 12], fps: 10 },
  v2_fx_stream_tip_t1: { frames: 4, rows: 1, cellW: 48, cellH: 32, anchorPx: [0, 16], fps: 10 },
};

describe('BreathStream', () => {
  it('uses one connected root/middle/tip run whose tip reaches the target', () => {
    const scene = new FakeScene();
    const stream = new BreathStream(scene as never, CLIPS, 1, 0, 0, 200, 0);
    expect(scene.images).toHaveLength(2);
    expect(scene.tiles).toHaveLength(1);
    expect(scene.containers[0]!.children).toHaveLength(3);
    expect(scene.tiles[0]).toMatchObject({ x: 28, width: 72 });
    expect(scene.images[1]).toMatchObject({ x: 100 });
    expect(combatEffectCount(scene as never)).toBe(1);

    advanceCombatEffects(scene as never, 100);
    expect([...scene.images, ...scene.tiles].every((part) =>
      part.writes.at(-1)!.endsWith('_f2'))).toBe(true);

    stream.update(10, 20, 110, 120);
    expect(scene.containers[0]).toMatchObject({ x: 10, y: 20 });
    expect(scene.containers[0]!.rotation).toBeCloseTo(Math.PI / 4);
    expect(scene.images[1]!.x).toBeCloseTo(Math.hypot(100, 100) / V2_DRAW_SCALE);
    stream.destroy();
    expect(combatEffectCount(scene as never)).toBe(0);
    expect(scene.containers[0]!.children.every((part) => !part.active)).toBe(true);
  });

  it('keeps all three stream parts inside Dragon compact-current art', () => {
    const scene = new FakeScene();
    const stream = new BreathStream(
      scene as never, CLIPS, 1, 0, 0, 160, 0,
      (base) => base.replace('v2_fx_', 'v2_compact_fx_dragon_t1_').replace(/_t1$/, ''),
    );
    expect([...scene.images, ...scene.tiles].every((part) =>
      part.writes[0]!.startsWith('v2trp_dragon_t1_compactfx/v2_compact_fx_dragon_t1_stream_'),
    )).toBe(true);
    stream.destroy();
  });

  it('keeps the Dragon stream on the scaled catch-up clock', () => {
    const scene = new FakeScene();
    const stream = new BreathStream(scene as never, CLIPS, 1, 0, 0, 160, 0);
    combatEffectPool(scene as never).setTimeScale(8);
    advanceCombatEffects(scene as never, 25); // 200 ms of playback at 8×
    expect([...scene.images, ...scene.tiles].every((part) =>
      part.writes.at(-1)!.endsWith('_f3'))).toBe(true);
    stream.destroy();
  });

  it('destroys every Dragon stream part when verdict cleanup clears the pool', () => {
    const scene = new FakeScene();
    const stream = new BreathStream(scene as never, CLIPS, 1, 0, 0, 160, 0);
    combatEffectPool(scene as never).clear();
    expect(scene.containers[0]!.children.every((part) => !part.active)).toBe(true);
    expect(combatEffectCount(scene as never)).toBe(0);
    stream.update(20, 20, 200, 20); // disposed controller references are inert
    stream.destroy(); // idempotent lifecycle cleanup
  });
});
