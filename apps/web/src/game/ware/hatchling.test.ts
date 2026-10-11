/**
 * M22 Hatchling renderer contract.
 *
 * WHY these matter: the Dragon Nest defender is spawned during battle, where
 * optional atlas groups may still be loading.  That gap must show the eager
 * current-art pose, never the retired Wyrmling.  Once admitted, attacks must
 * preserve all eight authored rows and launch from the exact numeric maw
 * coordinate on the shared release frame.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORED_ATTACK_TIMINGS, WARE_FALLBACK_ATLAS, wareHatchlingFallbackKey,
} from '@shardkeep/shared';
import { V2_DRAW_SCALE, type Facing8 } from '../v2/clips';
import { V2Ticker } from '../v2/ticker';
import { wareHatchlingClipKey, type WareClip, type WareClipMap } from './clips';
import { WareHatchlingFx } from './hatchling';

class FakeSprite {
  active = true;
  alpha = 1;
  depth = 0;
  originX = 0;
  originY = 0;
  scale = 1;
  readonly writes: string[] = [];

  constructor(public x: number, public y: number, atlas: string, frame: string) {
    this.writes.push(`${atlas}/${frame}`);
  }

  setTexture(atlas: string, frame: string): this {
    this.writes.push(`${atlas}/${frame}`);
    return this;
  }
  setOrigin(x: number, y: number): this { this.originX = x; this.originY = y; return this; }
  setScale(scale: number): this { this.scale = scale; return this; }
  setDepth(depth: number): this { this.depth = depth; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setAlpha(alpha: number): this { this.alpha = alpha; return this; }
  once(): this { return this; }
  destroy(): void { this.active = false; }
}

class FakeScene {
  readonly sprites: FakeSprite[] = [];
  readonly tweenConfigs: Array<{ onComplete?: () => void }> = [];
  readonly textures: { exists: (atlas: string) => boolean };

  constructor(textureExists = true) {
    this.textures = { exists: () => textureExists };
  }

  readonly add = {
    sprite: (x: number, y: number, atlas: string, frame: string): FakeSprite => {
      const sprite = new FakeSprite(x, y, atlas, frame);
      this.sprites.push(sprite);
      return sprite;
    },
  };

  readonly tweens = {
    killTweensOf: (_target: unknown): void => undefined,
    add: (config: { onComplete?: () => void }): object => {
      this.tweenConfigs.push(config);
      return {};
    },
  };
}

const ROW_ORDER: readonly Facing8[] = ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'];
const ANCHOR = [16, 24] as const;

function grid(frames: number, fps = 12, extra: Partial<WareClip> = {}): WareClip {
  return {
    frames, rows: 8, cellW: 64, cellH: 64, rowOrder: ROW_ORDER,
    anchorPx: ANCHOR, fps, loop: false, ...extra,
  };
}

function richClips(level = 1): WareClipMap {
  const prefix = (state: string): string => wareHatchlingClipKey(level, state);
  const maw = ROW_ORDER.map((_facing, row) => Array.from(
    { length: AUTHORED_ATTACK_TIMINGS.wyrmling.frames },
    (_unused, frame0) => [30 + row * 10 + frame0, 40 + row * 10 + frame0 * 2],
  ));
  return {
    [prefix('spawn')]: grid(2),
    [prefix('fly')]: grid(4, 12, { loop: true }),
    [prefix('hover')]: grid(4, 8, { loop: true }),
    [prefix('attack')]: grid(
      AUTHORED_ATTACK_TIMINGS.wyrmling.frames,
      AUTHORED_ATTACK_TIMINGS.wyrmling.fps,
      { emitters: { maw } },
    ),
    [prefix('hit')]: grid(2),
    [prefix('death')]: grid(4),
  };
}

function makeRich() {
  const scene = new FakeScene();
  const ticker = new V2Ticker();
  const clips = richClips();
  const fx = new WareHatchlingFx(
    scene as never, { ticker, clips, level: 1, rich: true }, 320, 240, 250,
  );
  ticker.tick(200); // finish the two-frame spawn and enter authored hover.
  return { scene, ticker, clips, fx, sprite: scene.sprites[0]! };
}

describe('M22 Hatchling admission and fallback', () => {
  it('uses only the eager current-art fallback whenever rich admission is unavailable', () => {
    const complete = richClips(6);
    const missingState = { ...complete };
    delete missingState[wareHatchlingClipKey(6, 'death')];
    const cases = [
      { rich: false, clips: complete, textureExists: true },
      { rich: true, clips: missingState, textureExists: true },
      { rich: true, clips: complete, textureExists: false },
    ];

    for (const candidate of cases) {
      const scene = new FakeScene(candidate.textureExists);
      const fx = new WareHatchlingFx(scene as never, {
        ticker: new V2Ticker(), clips: candidate.clips, level: 6, rich: candidate.rich,
      }, 320, 240, 250);
      const sprite = scene.sprites[0]!;

      expect(fx.rich).toBe(false);
      expect(fx.initialAtlas).toBe(WARE_FALLBACK_ATLAS);
      expect(sprite.writes).toEqual([
        `${WARE_FALLBACK_ATLAS}/${wareHatchlingFallbackKey(2)}`,
      ]);

      const releases: Array<{ x: number; y: number }> = [];
      fx.onRangedAttack(420, 240, (at) => releases.push(at));
      expect(releases).toHaveLength(1);
      expect(sprite.writes.join('|')).not.toMatch(/wyrmling|batch13|blddef|v2_/i);
    }
  });
});

describe('M22 rich Hatchling attacks', () => {
  it('snaps an in-flight defender immediately during replay seek', () => {
    const { scene, fx, sprite } = makeRich();
    fx.onPos(420, 340, 500);
    const beforeSeek = scene.tweenConfigs.length;
    fx.snapPosition(500, 360);
    expect(scene.tweenConfigs).toHaveLength(beforeSeek);
    expect(sprite).toMatchObject({ x: 500, y: 360 });
  });

  it('uses every authored facing row and releases once from that row\'s numeric maw', () => {
    const targetByFacing: Record<Facing8, readonly [number, number]> = {
      s: [0, 100], sw: [-100, 100], w: [-100, 0], nw: [-100, -100],
      n: [0, -100], ne: [100, -100], e: [100, 0], se: [100, 100],
    };

    for (const [row, facing] of ROW_ORDER.entries()) {
      const { ticker, fx, sprite } = makeRich();
      const [dx, dy] = targetByFacing[facing];
      const releases: Array<{ x: number; y: number }> = [];
      fx.onRangedAttack(320 + dx, 240 + dy, (at) => releases.push(at));

      const attack = wareHatchlingClipKey(1, 'attack');
      expect(sprite.writes.at(-1)).toMatch(new RegExp(`/${attack}_d${row}_f1$`));

      const stepMs = 1000 / AUTHORED_ATTACK_TIMINGS.wyrmling.fps;
      ticker.tick(stepMs * (AUTHORED_ATTACK_TIMINGS.wyrmling.releaseFrame - 1) - 1);
      expect(releases).toEqual([]);
      ticker.tick(2);

      const frame0 = AUTHORED_ATTACK_TIMINGS.wyrmling.releaseFrame - 1;
      const ex = 30 + row * 10 + frame0;
      const ey = 40 + row * 10 + frame0 * 2;
      expect(releases).toEqual([{
        x: 320 + (ex - ANCHOR[0]) * V2_DRAW_SCALE,
        y: 240 + (ey - ANCHOR[1]) * V2_DRAW_SCALE,
      }]);
      expect(sprite.writes.join('|')).not.toMatch(/wyrmling|batch13|blddef|v2_/i);
    }
  });
});
