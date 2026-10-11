import type Phaser from 'phaser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deploySpriteBodyBounds, opaqueTexelBounds } from './deployPreviewBounds';

// Atlas logical-upscale math is independently pinned in atlasTexels.test.ts.
vi.mock('./atlasTexels', () => ({
  atlasTexelStep: (texture: { step: number }) => texture.step,
  frameTexelRect: () => ({ x: 20, y: 30, w: 4, h: 4 }),
}));
afterEach(() => vi.unstubAllGlobals());

function spriteFixture(step = 1) {
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  rgba[(1 * 4 + 1) * 4 + 3] = 1; // soft pixels still belong to the body
  rgba[(2 * 4 + 2) * 4 + 3] = 255;
  const draw = vi.fn();
  const read = vi.fn(() => ({ data: rgba }));
  vi.stubGlobal('document', { createElement: () => ({
    getContext: () => ({ drawImage: draw, getImageData: read }),
  }) });
  const sprite = {
    x: 100, y: 100, texture: { step },
    frame: { source: { image: {} }, x: 0, y: 0, realWidth: 4 * step, realHeight: 4 * step },
    flipX: false, flipY: false, displayOriginX: 2 * step, displayOriginY: 2 * step,
    getBounds: () => ({ left: 0, top: 0, right: 200, bottom: 200 }),
    getWorldTransformMatrix: () => ({ transformPoint: (x: number, y: number) => ({ x: 100 + x * 2, y: 100 + y * 2 }) }),
  };
  return { sprite, read, draw, rgba, bounds: () => deploySpriteBodyBounds(sprite as unknown as Phaser.GameObjects.Sprite) };
}

describe('visible deployment content, not transparent atlas cells', () => {
  it('keeps soft edges and uses exclusive right/bottom texel bounds', () => {
    const { rgba } = spriteFixture();
    expect(opaqueTexelBounds(rgba, 4, 4)).toEqual({ left: 1, top: 1, right: 3, bottom: 3 });
    expect(opaqueTexelBounds(new Uint8Array(64), 4, 4)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
  it.each([1, 2])('excludes transparent borders at logical texel step %s without shrinking visible art', (step) => {
    const fixture = spriteFixture(step);
    expect(fixture.bounds()).toEqual({ left: 100 - step * 2, top: 100 - step * 2, right: 100 + step * 2, bottom: 100 + step * 2 });
    fixture.bounds();
    expect(fixture.read).toHaveBeenCalledOnce(); // held deployment does not decode every tap
    expect(fixture.draw).toHaveBeenCalledWith({}, 20, 30, 4, 4, 0, 0, 4, 4);
  });
  it('uses the current frame identity and mirrors content before world rotation/scale', () => {
    const f = spriteFixture();
    f.rgba.fill(0); f.rgba[3] = 255;
    f.sprite.flipX = true;
    f.sprite.getWorldTransformMatrix = () => ({ transformPoint: (x: number, y: number) => ({ x: 100 - y * 2, y: 100 + x * 2 }) });
    expect(f.bounds()).toEqual({ left: 102, top: 102, right: 104, bottom: 104 });
    f.sprite.frame = { ...f.sprite.frame };
    f.rgba.fill(255);
    expect(f.bounds()).toEqual({ left: 96, top: 96, right: 104, bottom: 104 });
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('applies a trimmed frame offset before vertical flipping', () => {
    const f = spriteFixture();
    f.sprite.frame.x = 3; f.sprite.frame.y = 5;
    f.sprite.frame.realWidth = 12; f.sprite.frame.realHeight = 16;
    f.sprite.displayOriginX = 6; f.sprite.displayOriginY = 8;
    f.sprite.flipY = true;
    expect(f.bounds()).toEqual({ left: 96, top: 100, right: 100, bottom: 104 });
  });
  it('retains conservative geometry when image pixels cannot be read', () => {
    const f = spriteFixture(); f.read.mockImplementation(() => { throw new Error('tainted'); });
    expect(f.bounds()).toEqual(f.sprite.getBounds());
  });
});
