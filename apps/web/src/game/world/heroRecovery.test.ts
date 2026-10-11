import { AMBIENCE } from '@shardkeep/shared';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import { HeroRecoveryLayer, recoveryCountdown } from './heroRecovery';

vi.mock('../scenes/BootScene', async () => {
  const { atlasGroupFor } = await import('@shardkeep/shared');
  return { atlasFor: atlasGroupFor };
});

class FakeDisplay {
  active = true;
  visible = true;
  x: number;
  y: number;
  width = 10;
  height = 20;
  originX = 0;
  originY = 0;
  scale = 1;
  depth = 0;
  text = '';
  setTextCalls = 0;
  setSizeCalls = 0;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  setOrigin(x: number, y: number): this { this.originX = x; this.originY = y; return this; }
  setScale(scale: number): this { this.scale = scale; return this; }
  setDepth(depth: number): this { this.depth = depth; return this; }
  setStrokeStyle(): this { return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setSize(width: number, height: number): this {
    this.setSizeCalls++;
    this.width = width; this.height = height;
    return this;
  }
  setText(text: string): this {
    this.setTextCalls++;
    this.text = text;
    this.width = Math.max(...text.split('\n').map((line) => line.length * 8));
    this.height = text.includes('\n') ? 40 : 20;
    return this;
  }
  setVisible(visible: boolean): this { this.visible = visible; return this; }
  destroy(): void { this.active = false; }
}

interface SpriteReq { atlas: string; frame: string; display: FakeDisplay }

function setup(): {
  layer: HeroRecoveryLayer;
  sprites: SpriteReq[];
  rectangles: FakeDisplay[];
  texts: FakeDisplay[];
} {
  const sprites: SpriteReq[] = [];
  const rectangles: FakeDisplay[] = [];
  const texts: FakeDisplay[] = [];
  const scene = {
    add: {
      sprite: (x: number, y: number, atlas: string, frame: string) => {
        const display = new FakeDisplay(x, y);
        sprites.push({ atlas, frame, display });
        return display;
      },
      rectangle: (x: number, y: number) => {
        const display = new FakeDisplay(x, y);
        rectangles.push(display);
        return display;
      },
      text: (x: number, y: number) => {
        const display = new FakeDisplay(x, y);
        texts.push(display);
        return display;
      },
    },
  } as never as Phaser.Scene;
  return { layer: new HeroRecoveryLayer(scene, 64), sprites, rectangles, texts };
}

const footprint = (): { fw: number; fh: number } => ({ fw: 2, fh: 2 });
const altar = {
  id: 'altar', type: 'heroaltar', level: 1, tx: 4, ty: 5, underConstruction: false,
};
const siege = {
  id: 'siege', type: 'siegestool', level: 1, tx: 8, ty: 9, underConstruction: false,
};

describe('HeroRecoveryLayer', () => {
  it('rests each recovering hero in its shipped final defeat pose at its completed altar', () => {
    const { layer, sprites, texts } = setup();
    const deadline = new Date(3_665_000).toISOString();
    layer.sync([
      { hero: 'vex', recoveryUntil: deadline, available: false },
      { hero: 'theodor', recoveryUntil: deadline, available: false },
    ], [altar, siege] as never, footprint, 0);

    expect(sprites.map(({ atlas, frame }) => `${atlas}/${frame}`)).toEqual([
      'hero/hero_vex_defeat_f3',
      'hero/hero_theo_defeat_f4',
    ]);
    expect(sprites[0]?.display.x).toBe((altar.tx + 1) * 64);
    expect(sprites[0]?.display.y).toBe((altar.ty + 2) * 64);
    expect(sprites[0]?.display.originX).toBe(0.5);
    expect(sprites[0]?.display.originY).toBe(1);
    expect(sprites[0]?.display.scale).toBe(AMBIENCE.heroPatrolScale);
    expect(texts.map((display) => display.text)).toEqual([
      'VEX · RECOVERING\n1H 1M',
      'THEODOR · RECOVERING\n1H 1M',
    ]);
  });

  it('uses the live deadline, pools the hero, and waits for server-confirmed recovery', () => {
    const { layer, sprites, rectangles, texts } = setup();
    layer.sync([
      { hero: 'theodor', recoveryUntil: new Date(65_000).toISOString(), available: false },
    ], [siege] as never, footprint, 0);
    const hero = sprites[0]!.display;
    const chip = rectangles[0]!;
    const label = texts[0]!;

    layer.update(1_000);
    expect(label.text).toBe('THEODOR · RECOVERING\n1M 4S');
    layer.sync([
      { hero: 'theodor', recoveryUntil: new Date(125_000).toISOString(), available: false },
    ], [{ ...siege, tx: 10 }] as never, footprint, 1_000);
    expect(sprites).toHaveLength(1);
    expect(hero.x).toBe(11 * 64);
    expect(label.text).toBe('THEODOR · RECOVERING\n2M 4S');

    layer.update(125_000);
    expect(label.text).toBe('THEODOR · RECOVERING\nVERIFYING');
    expect(hero.active).toBe(true);

    layer.sync([
      { hero: 'theodor', recoveryUntil: new Date(125_000).toISOString(), available: true },
    ], [siege] as never, footprint, 125_000);
    expect(hero.active).toBe(false);
    expect(chip.active).toBe(false);
    expect(label.active).toBe(false);
  });

  it('hides all recovery visuals with their altar drag and restores on cancel', () => {
    const { layer, sprites, rectangles, texts } = setup();
    layer.sync([
      { hero: 'vex', recoveryUntil: new Date(60_000).toISOString(), available: false },
    ], [altar] as never, footprint, 0);

    layer.hide(altar.id);
    expect([sprites[0]!.display.visible, rectangles[0]!.visible, texts[0]!.visible])
      .toEqual([false, false, false]);
    layer.show(altar.id);
    expect([sprites[0]!.display.visible, rectangles[0]!.visible, texts[0]!.visible])
      .toEqual([true, true, true]);
  });

  it('renders only future deadlines backed by completed matching altars and cleans up', () => {
    const { layer, sprites } = setup();
    const future = new Date(60_000).toISOString();
    layer.sync([
      { hero: 'vex', recoveryUntil: future, available: false },
      { hero: 'theodor', recoveryUntil: new Date(0).toISOString(), available: true },
    ], [{ ...altar, underConstruction: true }, siege] as never, footprint, 1);
    expect(sprites).toHaveLength(0);

    layer.sync([
      { hero: 'vex', recoveryUntil: future, available: false },
    ], [altar] as never, footprint, 1);
    expect(sprites).toHaveLength(1);
    layer.destroy();
    expect(sprites[0]?.display.active).toBe(false);
  });
});

/**
 * M33 package D (D-101): the chip's setText rasterises a canvas and setSize is
 * a layout write; per downed hero per frame that was pure waste on the Seeker
 * for a label that can only change on a second boundary.
 */
describe('HeroRecoveryLayer cadence', () => {
  it('writes each chip once per wall-clock second and still ticks at the boundary', () => {
    const { layer, rectangles, texts } = setup();
    layer.sync([
      { hero: 'vex', recoveryUntil: new Date(65_000).toISOString(), available: false },
      { hero: 'theodor', recoveryUntil: new Date(65_000).toISOString(), available: false },
    ], [altar, siege] as never, footprint, 0);
    const before = texts.map((t) => t.setTextCalls);
    const beforeBg = rectangles.map((r) => r.setSizeCalls);

    for (let frame = 0; frame < 60; frame++) layer.update(1_000 + frame * 16);
    expect(texts.map((t, i) => t.setTextCalls - before[i]!)).toEqual([1, 1]);
    expect(rectangles.map((r, i) => r.setSizeCalls - beforeBg[i]!)).toEqual([1, 1]);
    expect(texts[0]!.text).toBe('VEX · RECOVERING\n1M 4S');

    layer.update(2_000);
    expect(texts.map((t, i) => t.setTextCalls - before[i]!)).toEqual([2, 2]);
    expect(texts[0]!.text).toBe('VEX · RECOVERING\n1M 3S');
  });
});

describe('recoveryCountdown', () => {
  it('labels units so 1h 1m and 1m 5s can never be confused (owner: no bare m:ss)', () => {
    expect(recoveryCountdown(3_665_000, 0)).toBe('1H 1M');
    expect(recoveryCountdown(65_000, 0)).toBe('1M 5S');
    expect(recoveryCountdown(0, 0)).toBeNull();
  });
});
