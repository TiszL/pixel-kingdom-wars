import { describe, expect, it } from 'vitest';
import {
  buildField, composeCollapse, composeWall, captureCollapse, COLLAPSE_DURATION,
  wallDamageStage, wallTierOfLevel,
} from '@shardkeep/shared/wallRender';
import { WallLayer, type WallSpriteInput } from './walls';

class Sprite {
  active = true;
  texture = '';
  scale = 0;
  origin: number[] = [];
  writes = 0;
  setTexture(texture: string): this { this.texture = texture; this.writes++; return this; }
  setOrigin(...origin: number[]): this { this.origin = origin; return this; }
  setScale(scale: number): this { this.scale = scale; return this; }
}

function harness(clock: () => number = () => 0, guardLiveFrames = false, upload: () => void = () => {}) {
  const watched = new Set<Sprite>();
  const textures = new Map<string, Uint8ClampedArray>();
  const destroyed: string[] = [];
  const scene = {
    textures: {
      createCanvas(key: string) {
        return {
          context: {
            createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
            putImageData: (pixels: { data: Uint8ClampedArray }) => textures.set(key, pixels.data),
          },
          add() {}, setFilter() {}, refresh: upload,
        };
      },
      remove(key: string) {
        if (guardLiveFrames && [...watched].some(sprite => sprite.active && sprite.texture === key)) {
          throw new Error('destroyed a Frame still referenced by a live sprite');
        }
        destroyed.push(key); textures.delete(key);
      },
    },
  };
  const commits: string[] = [];
  const layer = new WallLayer(scene as never, (row) => { commits.push(row.id); watched.add(row.sprite as unknown as Sprite); }, clock);
  const pixels = (row: WallSpriteInput) => textures.get((row.sprite as unknown as Sprite).texture);
  const finish = () => { let count = 0; while (layer.preparing && count++ < 1000) layer.update(); expect(layer.preparing).toBe(false); };
  return { layer, textures, destroyed, commits, pixels, finish };
}

function row(id: string, tx: number, ty: number, level = 1, hp = 100): WallSpriteInput {
  return { id, tx, ty, level, hp, maxHp: 100, sprite: new Sprite() as never };
}

function full(inputs: WallSpriteInput[]) {
  const grid = new Map(inputs.map((input) => {
    const stage = wallDamageStage(input.hp ?? 100, input.maxHp ?? 100);
    return [`${input.tx},${input.ty}`, {
      tier: wallTierOfLevel(input.level), damage: stage > 0, damageStage: stage > 1 ? 2 as const : 1 as const,
    }] as const;
  }));
  const field = buildField(grid);
  return inputs.map((input) => composeWall(grid, input.tx, input.ty, field)!.data);
}

function expectFull(h: ReturnType<typeof harness>, inputs: WallSpriteInput[]) {
  const expected = full(inputs);
  for (let i = 0; i < inputs.length; i++) expect(h.pixels(inputs[i]!)).toEqual(expected[i]);
}

describe('scene-owned contextual wall textures', () => {
  it.each([false, true])('recovers collapse upload failure from its frozen snapshot (final rubble: %s)', (final) => {
    let fail = false;
    const h = harness(() => 0, false, () => { if (fail) throw new Error('collapse upload failed'); });
    const input = row('wall', 0, 0);
    h.layer.sync([input]); h.finish();
    fail = true;
    expect(() => h.layer.collapse(input.id, final)).not.toThrow();
    expect(h.layer.diagnostics.error).toBe('collapse upload failed');
    h.layer.sync([]); // authoritative destruction retires adjacency while covered
    fail = false;
    h.layer.retryPreparation(); h.layer.update();
    expect(h.layer.diagnostics.error).toBe('');
    const snapshot = captureCollapse(new Map([['0,0', { tier: 1 }]]), 0, 0, 0)!;
    expect(h.pixels(input)).toEqual(composeCollapse(snapshot, final ? COLLAPSE_DURATION : 0).data);
    h.layer.destroy(); expect(h.textures.size).toBe(0);
  });

  it('turns a failed upload into recoverable preparation and releases its partial texture', async () => {
    let fail = true;
    const h = harness(() => 0, false, () => { if (fail) throw new Error('GPU upload failed'); });
    const inputs = [row('wall', 0, 0)];
    h.layer.sync(inputs);
    const settled = h.layer.ready();
    h.layer.update();
    expect(() => h.layer.update()).not.toThrow();
    await settled;
    expect(h.layer.diagnostics.error).toBe('GPU upload failed');
    expect(h.textures.size).toBe(0);
    expect(h.commits).toEqual([]);
    fail = false;
    h.layer.retryPreparation();
    h.finish();
    expect(h.layer.diagnostics.error).toBe('');
    expectFull(h, inputs);
    expect(h.layer.diagnostics.textureCount).toBe(1);
    h.layer.destroy();
    expect(h.textures.size).toBe(0);
  });

  it('yields after field setup and publishes the completed neighborhood together', () => {
    const h = harness();
    const inputs = [row('wood', 0, 0), row('crown', 1, 0, 17), row('stone', 0, 1, 5)];
    h.layer.sync(inputs);
    h.layer.update();
    expect(h.layer.preparing).toBe(true);
    expect(h.commits).toEqual([]);
    // Field resolution must not be combined with the first expensive compose/upload,
    // even when the fake clock leaves enough room to process this entire small base.
    expect(h.textures.size).toBe(0);
    expect(h.layer.diagnostics.compositions).toBe(0);
    h.finish();
    expect(h.commits).toEqual(inputs.map((input) => input.id));
    expectFull(h, inputs);
    for (const input of inputs) {
      expect((input.sprite as unknown as Sprite).scale).toBe(2);
      expect((input.sprite as unknown as Sprite).origin).toEqual([0.5, 1]);
    }
  });

  it('counts upload cost before starting another cell and still progresses when one cell exceeds budget', () => {
    for (const uploadMs of [2.5, 6]) {
      let time = 0;
      const h = harness(() => time, false, () => { time += uploadMs; });
      const inputs = [row('a', 0, 0), row('b', 1, 0, 17), row('c', 2, 0, 5)];
      h.layer.sync(inputs); h.layer.update();
      for (let completed = 1; completed <= inputs.length; completed++) {
        h.layer.update();
        // At 2.5ms, starting a second cell would overrun 4ms. At 6ms, the
        // non-preemptible first cell must still run rather than starve forever.
        expect(h.layer.diagnostics.compositions).toBe(completed);
        expect(h.layer.diagnostics.maxPreparationMs).toBe(uploadMs);
        expect(h.layer.diagnostics.maxCellPreparationMs).toBe(uploadMs);
        expect(h.commits).toEqual(completed < inputs.length ? [] : inputs.map(input => input.id));
      }
      expect(h.layer.preparing).toBe(false);
      expectFull(h, inputs);
    }
  });

  it('keeps collapse motion advancing during a field-only preparation frame', () => {
    const h = harness();
    const wood = row('wood', 0, 0), crown = row('crown', 1, 0, 17);
    h.layer.sync([wood, crown]); h.finish();
    const snapshot = captureCollapse(new Map([['0,0', { tier: 1 }], ['1,0', { tier: 5 }]]), 0, 0)!;
    h.layer.collapse('wood'); h.layer.sync([crown]);
    const before = h.layer.diagnostics.compositions;
    h.layer.update(COLLAPSE_DURATION / 4 + 0.001);
    expect(h.layer.diagnostics.compositions).toBe(before);
    expect(h.pixels(wood)).toEqual(composeCollapse(snapshot, COLLAPSE_DURATION / 3).data);
    h.finish(); expectFull(h, [crown]);
  });

  it.each([2.5, 6])('bounds repeated collapse uploads fairly and retains exact final rubble at %sms per upload', (uploadMs) => {
    let time = 0;
    const h = harness(() => time, false, () => { time += uploadMs; });
    const inputs = [row('wood', 0, 0), row('stone', 1, 0, 5), row('crown', 2, 0, 17), row('survivor', 3, 0, 13)];
    h.layer.sync(inputs); h.finish();
    const grid = new Map(inputs.map(input => [`${input.tx},0`, { tier: wallTierOfLevel(input.level) }]));
    const snapshots = inputs.slice(0, 3).map(input => captureCollapse(grid, input.tx, input.ty)!);
    for (const input of inputs.slice(0, 3)) h.layer.collapse(input.id);
    h.layer.sync([inputs[3]!]); h.finish(); expectFull(h, [inputs[3]!]);
    h.commits.length = 0;
    for (let i = 0; i < 3; i++) {
      const before = h.layer.diagnostics.collapseCompositions;
      h.layer.update(COLLAPSE_DURATION / 4 + 0.001);
      expect(h.layer.diagnostics.collapseCompositions - before).toBe(1);
      expect(h.commits).toEqual(inputs.slice(0, i + 1).map(input => input.id));
    }
    h.layer.update(COLLAPSE_DURATION);
    h.layer.update(0); h.layer.update(0);
    for (let i = 0; i < 3; i++) expect(h.pixels(inputs[i]!)).toEqual(composeCollapse(snapshots[i]!, COLLAPSE_DURATION).data);
    expect(h.layer.diagnostics.maxCollapsePreparationMs).toBe(uploadMs);
    expect(h.layer.diagnostics.maxCollapseCellMs).toBe(uploadMs);
    expect(h.layer.diagnostics.maxCollapseInitialMs).toBe(uploadMs);
    const writes = h.layer.diagnostics.collapseCompositions;
    for (let i = 0; i < 60; i++) h.layer.update(16);
    expect(h.layer.diagnostics.collapseCompositions).toBe(writes);
    expect(h.textures.size).toBe(4); h.layer.destroy(); expect(h.textures.size).toBe(0);
  });

  it('updates only the affected 3×3 neighborhood and matches fresh composition through every edit', () => {
    const h = harness();
    let inputs = Array.from({ length: 25 }, (_, i) => row(String(i), i % 5, Math.floor(i / 5), i % 20 + 1));
    h.layer.sync(inputs); h.finish();
    const before = h.layer.diagnostics.compositions;
    inputs[12]!.level = 17;
    h.layer.sync(inputs); h.finish();
    expect(h.layer.diagnostics.compositions - before).toBe(9);
    expectFull(h, inputs);
    inputs[12]!.hp = 24;
    h.layer.sync(inputs); h.finish(); expectFull(h, inputs);
    inputs = inputs.filter((input) => input.id !== '12');
    h.layer.sync(inputs); h.finish(); expectFull(h, inputs);
    inputs[0]!.tx = -1;
    h.layer.sync(inputs); h.finish(); expectFull(h, inputs);
    inputs.push(row('fill', 2, 2, 9));
    h.layer.sync(inputs); h.finish(); expectFull(h, inputs);
    expect(h.textures.size).toBe(inputs.length);
  }, 15_000); // Full native-pixel comparison stays bounded under whole-workspace CPU contention.

  it('keeps an invalid timber drag separate from the occupied shard wall at the same tile', () => {
    const h = harness();
    const crown = row('crown', 4, 4, 17);
    const wood = row('carried', 4, 4, 1);
    wood.detached = true;
    h.layer.sync([crown, wood]); h.finish();
    expect(h.pixels(crown)).toEqual(full([crown])[0]);
    expect(h.pixels(wood)).toEqual(full([wood])[0]);
    expect(h.pixels(crown)).not.toEqual(h.pixels(wood));
    // A valid adjacent drop rejoins the same atomic grid without stale detached pixels.
    wood.tx = 5; delete wood.detached;
    h.layer.sync([crown, wood]); h.finish();
    expectFull(h, [crown, wood]);
    expect(h.textures.size).toBe(2);
  });

  it('cancels unfinished generations without publishing old levels after an upgrade', () => {
    let time = 0;
    const h = harness(() => time += 3);
    const inputs = [row('a', 0, 0, 16), row('b', 1, 0, 1), row('c', 2, 0, 1)];
    h.layer.sync(inputs); h.layer.update(); h.layer.update();
    expect(h.commits).toEqual([]);
    inputs[0]!.level = 17;
    h.layer.sync(inputs); h.finish();
    expectFull(h, inputs);
    expect(h.textures.size).toBe(3);
    expect(h.destroyed.length).toBeGreaterThan(0);
  });

  it('captures collapse geometry before the breach and holds material-appropriate rubble', () => {
    const h = harness();
    const inputs = [row('wood', 0, 0), row('crown', 1, 0, 17)];
    h.layer.sync(inputs); h.finish();
    const grid = new Map([['0,0', { tier: 1 }], ['1,0', { tier: 5 }]]);
    const snapshot = captureCollapse(grid, 0, 0)!;
    h.layer.collapse('wood');
    h.layer.sync([inputs[1]!]); h.finish();
    h.layer.update(COLLAPSE_DURATION);
    expect(h.pixels(inputs[0]!)).toEqual(composeCollapse(snapshot, COLLAPSE_DURATION).data);
    expectFull(h, [inputs[1]!]);
    expect(h.textures.size).toBe(2);
  });

  it('publishes detached pixels before isolated removal, including final seek rubble', () => {
    for (const final of [false, true]) {
      const h = harness();
      const input = row('solo', 0, 0, 17);
      h.layer.sync([input]); h.finish();
      h.layer.collapse('solo', final);
      h.layer.sync([]);
      // No update is allowed here: zero-neighbor removal publishes immediately.
      expect(h.pixels(input)).toBeDefined();
      const snapshot = captureCollapse(new Map([['0,0', { tier: 5 }]]), 0, 0)!;
      expect(h.pixels(input)).toEqual(composeCollapse(snapshot, final ? COLLAPSE_DURATION : 0).data);
      h.layer.destroy();
    }
  });

  it('uses the same four collapse samples as the accepted baseline sheets at 12fps', () => {
    const h = harness();
    const input = row('solo', 0, 0, 1);
    h.layer.sync([input]); h.finish();
    const snapshot = captureCollapse(new Map([['0,0', { tier: 1 }]]), 0, 0)!;
    h.layer.collapse('solo'); h.layer.sync([]);
    for (let frame = 0; frame < 4; frame++) {
      if (frame) h.layer.update(COLLAPSE_DURATION / 4 + 0.001);
      expect(h.pixels(input)).toEqual(composeCollapse(snapshot, frame * COLLAPSE_DURATION / 3).data);
    }
    h.layer.update(COLLAPSE_DURATION);
    expect(h.pixels(input)).toEqual(composeCollapse(snapshot, COLLAPSE_DURATION).data);
  });

  it('parks hidden tray sprites on valid accepted frames before releasing contextual textures', () => {
    const h = harness(() => 0, true);
    const input = row('tray', 4, 4, 17);
    h.layer.sync([input]); h.finish();
    h.layer.sync([]);
    // A hidden sprite is still active. Restoring/cancelling may read its Frame
    // immediately, before another staged batch is allowed to run.
    expect((input.sprite as unknown as Sprite).texture).toBe('wall5');
    expect(h.textures.size).toBe(0);
    h.layer.sync([input]);
    expect((input.sprite as unknown as Sprite).texture).toBe('wall5');
    h.finish(); expectFull(h, [input]);
    (input.sprite as unknown as Sprite).active = false;
    h.layer.destroy();
  });

  it('rebinds restarted replay identities, clears collapse, and releases every scene texture', () => {
    const h = harness();
    const original = row('same', 2, 2, 20);
    h.layer.sync([original]); h.finish();
    const replacement = row('same', 2, 2, 20);
    h.layer.sync([replacement]);
    expect(h.pixels(replacement)).toEqual(h.pixels(original));
    h.layer.collapse('same', true); h.layer.sync([]); h.layer.update();
    const restarted = row('same', 2, 2, 20);
    h.layer.sync([restarted]); h.finish();
    expectFull(h, [restarted]);
    expect(h.textures.size).toBe(1);
    h.layer.destroy(); h.layer.destroy();
    expect(h.textures.size).toBe(0);
    expect(h.layer.diagnostics.textureCount).toBe(0);
  });

  it('retains exactly one texture per wall after a legal maximum 250-wall initial build', () => {
    const h = harness();
    const inputs = Array.from({ length: 250 }, (_, i) => row(String(i), i % 25, Math.floor(i / 25), i % 20 + 1));
    h.layer.sync(inputs); h.finish();
    expect(h.textures.size).toBe(250);
    const composed = h.layer.diagnostics.compositions;
    h.layer.sync(inputs); h.layer.update();
    expect(h.layer.diagnostics.compositions).toBe(composed);
    expect([...h.textures.values()].reduce((sum, pixels) => sum + pixels.byteLength, 0)).toBe(1_920_000);
    h.layer.destroy();
    expect(h.textures.size).toBe(0);
  }, 15_000); // The legal-maximum raster audit shares CPU with the full workspace gate.
});
