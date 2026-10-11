/**
 * Army chips (owner 2026-09-19). These tests REPLACE the ones that pinned the
 * former base-wide summary block — its three-line "BASE ARMY …" copy, its
 * lowest-row-id anchor, and the viewport/HUD clamp that let it slide off its
 * building. The owner rejected that block as a floating black box bigger than
 * the building it described, so every rule below encodes the new contract:
 * the figure lives on the building that owns it, stays glued to it, and never
 * outgrows it while the text is still legible.
 */
import { BUILD_COUNT_CAP_BY_KEEP } from '@shardkeep/shared';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import type { BaseStateDto } from '../../state/store';
import {
  ARMY_CHIP_FONT_STEPS, ARMY_CHIP_FOOTPRINT_RATIO, ARMY_CHIP_ICON_ROWS, ARMY_CHIP_TONES,
  ArmyStatusLayer, armyChipCarrier, armyChipLayout, armyChipWidth, armyStatusAnchorY,
  armyStatusChipScale, barracksChipContent, campChipContent,
} from './armyStatus';
import { spriteVisualTopY } from './worldChipGeometry';

type Building = BaseStateDto['buildings'][number];

class FakeObject {
  active = true;
  visible = true;
  x = 0;
  y = 0;
  scaleX = 1;
  depth = 0;
  setOrigin(): this { return this; }
  setDepth(depth: number): this { this.depth = depth; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setVisible(visible: boolean): this { this.visible = visible; return this; }
  setScale(scale: number): this { this.scaleX = scale; return this; }
  destroy(): void { this.active = false; }
}

class FakeText extends FakeObject {
  text = '';
  fontPx = 20;
  color = '';
  get width(): number { return [...this.text].length * this.fontPx * 0.4; }
  get height(): number { return this.fontPx; }
  setText(text: string): this { this.text = text; return this; }
  setFontSize(px: number): this { this.fontPx = px; return this; }
  setColor(color: string): this { this.color = color; return this; }
}

class FakePlate extends FakeObject {
  width = 0;
  height = 0;
  stroke = 0;
  setSize(width: number, height: number): this { this.width = width; this.height = height; return this; }
  setFillStyle(): this { return this; }
  setStrokeStyle(_width: number, color: number): this { this.stroke = color; return this; }
}

class FakeImage extends FakeObject {
  frame = '';
  tint = 0;
  constructor(frame: string) { super(); this.frame = frame; }
  setFrame(frame: string): this { this.frame = frame; return this; }
  setTint(tint: number): this { this.tint = tint; return this; }
}

class FakeContainer extends FakeObject {
  constructor(readonly children: FakeObject[]) { super(); }
  override destroy(): void { this.active = false; for (const child of this.children) child.destroy(); }
}

interface FakeChip { root: FakeContainer; plate: FakePlate; icon: FakeImage; label: FakeText }

function setup(zoom = 1): {
  layer: ArmyStatusLayer;
  chips: FakeChip[];
  camera: { zoom: number; scrollX: number; scrollY: number; width: number; height: number };
} {
  const chips: FakeChip[] = [];
  let plate: FakePlate | null = null, label: FakeText | null = null, icon: FakeImage | null = null;
  const camera = { zoom, scrollX: 0, scrollY: 0, width: 390, height: 844 };
  const scene = {
    add: {
      rectangle: () => (plate = new FakePlate()),
      text: () => (label = new FakeText()),
      image: (_x: number, _y: number, _key: string, frame: string) => (icon = new FakeImage(frame)),
      container: (_x: number, _y: number, children: FakeObject[]) => {
        const root = new FakeContainer(children);
        chips.push({ root, plate: plate!, icon: icon!, label: label! });
        return root;
      },
    },
    textures: { exists: () => true },
    cameras: { main: camera },
  } as never as Phaser.Scene;
  return { layer: new ArmyStatusLayer(scene), chips, camera };
}

const idle: NonNullable<BaseStateDto['armyStatus']> = {
  readyTroopCount: 12,
  readyPts: 42,
  campCapacityPts: 108,
  trainingTroopCount: 0,
  trainingPts: 0,
  barracksQueuePts: 65,
  nextReadyAt: null,
  allReadyAt: null,
};

const training: NonNullable<BaseStateDto['armyStatus']> = {
  ...idle,
  trainingTroopCount: 3,
  trainingPts: 6,
  nextReadyAt: new Date(65_000).toISOString(),
  allReadyAt: new Date(125_000).toISOString(),
};

const building = (id: string, type: string, level: number, tx: number, ty: number, underConstruction = false): Building => (
  { id, type, level, tx, ty, underConstruction }
);

const buildings: Building[] = [
  building('b-2', 'barracks', 1, 8, 8),
  building('b-1', 'barracks', 1, 4, 8),
  building('camp-1', 'camp', 1, 8, 12),
  building('camp-building', 'camp', 9, 12, 12, true),
  building('keep', 'keep', 1, 14, 14),
];

/** Camp 2×2 and Barracks 2×1 both stand on a 2-tile-wide footprint (T = 64). */
const FOOTPRINT = 128;
const anchor = (b: Building) => ({ x: b.tx * 64, y: b.ty * 64, footprintWidth: FOOTPRINT });
const chipOf = (chips: FakeChip[], frame: 'helm' | 'hourglass') => chips.find((c) => c.icon.frame === frame)!;

describe('army chip copy', () => {
  it('states the shared housing pool as used/capacity, counting troops still in training', () => {
    // A queued troop already owns its bed: the server refuses training past
    // ready + queued, so a chip that ignored the queue would promise room that
    // does not exist.
    expect(campChipContent({ ...idle, readyPts: 0 }).variants).toEqual(['0/108']);
    expect(campChipContent(idle)).toEqual({ icon: 'helm', tone: 'normal', variants: ['42/108'] });
    expect(campChipContent(training).variants).toEqual(['48/108']);
  });

  it('marks FULL and OVER in their own tones and keeps the bare word as the far-zoom form', () => {
    expect(campChipContent({ ...idle, readyPts: 108 }))
      .toEqual({ icon: 'helm', tone: 'full', variants: ['FULL 108/108', 'FULL'] });
    expect(campChipContent({ ...idle, readyPts: 102, trainingPts: 6 }).tone).toBe('full');
    expect(campChipContent({ ...idle, readyPts: 110 }))
      .toEqual({ icon: 'helm', tone: 'over', variants: ['OVER 110/108', 'OVER'] });
    // No camp capacity at all is not "full" — there is nothing to fill.
    expect(campChipContent({ ...idle, readyPts: 0, campCapacityPts: 0 }).tone).toBe('normal');
    expect(ARMY_CHIP_TONES.full.stroke).not.toBe(ARMY_CHIP_TONES.normal.stroke);
    expect(ARMY_CHIP_TONES.over.inkCss).not.toBe(ARMY_CHIP_TONES.normal.inkCss);
  });

  it('shows a Barracks chip only while something trains, in job-chip duration words', () => {
    expect(barracksChipContent(idle, 1_000)).toBeNull();
    expect(barracksChipContent(training, 1_000)).toEqual({
      icon: 'hourglass', tone: 'normal',
      variants: ['3 TRAINING · 2m 4s · 6/65', '3 TRAINING · 2m 4s', '3 · 2m 4s', '2m 4s'],
    });
    // D-070: days above 24 h, never stacked hours and never a battle-style m:ss.
    const long = { ...training, allReadyAt: new Date(1_000 + 90_000_000).toISOString() };
    expect(barracksChipContent(long, 1_000)!.variants.at(-1)).toBe('1d 1h');
  });

  it('waits for the server instead of announcing troops an elapsed local clock has not confirmed', () => {
    expect(barracksChipContent(training, 125_000)!.variants.at(-1)).toBe('VERIFYING');
    expect(barracksChipContent({ ...training, allReadyAt: null }, 1_000)!.variants.at(-1)).toBe('VERIFYING');
  });

  it('draws both icons on one 9×9 one-bit grid so web and native share the bitmap', () => {
    for (const rows of Object.values(ARMY_CHIP_ICON_ROWS)) {
      expect(rows).toHaveLength(9);
      for (const row of rows) expect(row).toMatch(/^[X.]{9}$/);
    }
  });
});

describe('army chip carrier', () => {
  it('puts the pool on ONE building: highest level, then stable id on both clients', () => {
    const camps = [
      building('z', 'camp', 3, 20, 20),
      building('a', 'camp', 5, 30, 30),
      building('m', 'camp', 5, 10, 30),
      building('k', 'camp', 5, 12, 18),
      building('under', 'camp', 9, 1, 1, true),
    ];
    expect(armyChipCarrier(camps, 'camp')?.id).toBe('a');
    // Row order in the /base read must not move the chip between refreshes.
    expect(armyChipCarrier([...camps].reverse(), 'camp')?.id).toBe('a');
    // Moving the chosen camp must not transfer the pool label to its neighbour.
    expect(armyChipCarrier(camps.map((b) => ({ ...b, tx: 40 - b.tx, ty: 40 - b.ty })), 'camp')?.id).toBe('a');
    expect(armyChipCarrier(camps, 'barracks')).toBeUndefined();
  });

  it('never carries on a structure still under construction: it houses and trains nothing yet', () => {
    expect(armyChipCarrier(buildings, 'camp')?.id).toBe('camp-1');
    expect(armyChipCarrier([building('only', 'camp', 1, 1, 1, true)], 'camp')).toBeUndefined();
  });
});

describe('army chip layout', () => {
  it.each([
    { label: 'claim-fit phone', zoom: 0.28 },
    { label: 'owner screenshot', zoom: 0.65 },
    { label: 'authored 1:1', zoom: 1 },
    { label: 'closest', zoom: 1.6 },
  ])('never outgrows 1.2× the footprint while a legible form fits ($label)', ({ zoom }) => {
    for (const content of [campChipContent(idle), campChipContent({ ...idle, readyPts: 108 }), barracksChipContent(training, 1_000)!]) {
      const layout = armyChipLayout(content.variants, FOOTPRINT, zoom);
      const worldWidth = armyChipWidth(layout.text, layout.fontPx) * layout.scale;
      const smallestEssential = armyChipWidth(content.variants.at(-1)!, ARMY_CHIP_FONT_STEPS.at(-1)!) * layout.scale;
      if (smallestEssential <= FOOTPRINT * ARMY_CHIP_FOOTPRINT_RATIO) {
        expect(worldWidth).toBeLessThanOrEqual(FOOTPRINT * ARMY_CHIP_FOOTPRINT_RATIO);
      } else {
        // Legibility outranks the cap: the essential form at the smallest size.
        expect(layout).toMatchObject({ text: content.variants.at(-1), fontPx: ARMY_CHIP_FONT_STEPS.at(-1) });
      }
      expect(content.variants).toContain(layout.text);
      expect(ARMY_CHIP_FONT_STEPS).toContain(layout.fontPx);
    }
  });

  it('is an order of magnitude smaller than the block it replaces at claim-fit zoom', () => {
    // The rejected summary was ~290 screen px wide and three lines tall over a
    // ~36 px Camp. One line, under two footprints, is the regression guard.
    const zoom = 0.28;
    const layout = armyChipLayout(campChipContent(idle).variants, FOOTPRINT, zoom);
    expect(armyChipWidth(layout.text, layout.fontPx) * layout.scale * zoom).toBeLessThan(FOOTPRINT * zoom * 2);
    expect(layout.text).not.toContain('\n');
  });

  it('sheds detail before shrinking the text, and queue points appear only with room to spare', () => {
    const variants = barracksChipContent(training, 1_000)!.variants;
    expect(armyChipLayout(variants, FOOTPRINT, 1.6).text).toBe('3 TRAINING · 2m 4s · 6/65');
    // At 1:1 the count and time fit at full size; the word TRAINING would force
    // a smaller face than the Camp chip beside it, so it waits for closer zoom.
    expect(armyChipLayout(variants, FOOTPRINT, 1)).toMatchObject({ text: '3 · 2m 4s', fontPx: 20 });
    expect(armyChipLayout(variants, FOOTPRINT, 0.65)).toMatchObject({ text: '3 · 2m 4s', fontPx: 18 });
    const far = armyChipLayout(variants, FOOTPRINT, 0.2);
    expect(far).toMatchObject({ text: '2m 4s', fontPx: 12 });
    // A bigger building earns the detail back at the same zoom.
    expect(armyChipLayout(variants, FOOTPRINT * 2, 1).text).toBe('3 TRAINING · 2m 4s · 6/65');
  });

  it('keeps text readable at claim-fit zoom and bounds invalid inputs', () => {
    expect(armyStatusChipScale(0.14)).toBeCloseTo(1 / 0.14, 5);
    expect(armyStatusChipScale(1)).toBe(1);
    expect(armyStatusChipScale(2)).toBe(0.7);
    expect(armyStatusChipScale(0)).toBe(1);
    expect(armyChipLayout(['1/2'], FOOTPRINT, Number.NaN).scale).toBe(1);

    const { layer, chips } = setup(0.14);
    layer.sync(idle, buildings, anchor, 1_000);
    // Text is re-rasterised at a smaller SIZE and drawn 1:1 on screen; a
    // fractional scale under NEAREST filtering would shred the glyphs.
    expect(chips[0]!.root.scaleX).toBeCloseTo(1 / 0.14, 5);
    expect(chips[0]!.label.fontPx).toBe(12);
  });
});

describe('ArmyStatusLayer', () => {
  it('puts housing on the Camp and nothing on an idle Barracks', () => {
    const { layer, chips } = setup();
    layer.sync(idle, buildings, anchor, 1_000);
    const shown = chips.filter((chip) => chip.root.visible);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ icon: { frame: 'helm' }, label: { text: '42/108' } });
    expect(shown[0]!.root).toMatchObject({ x: 8 * 64, y: 12 * 64 });
  });

  it('adds the Barracks chip while training and withdraws it when the queue drains', () => {
    const { layer, chips } = setup();
    layer.sync(training, buildings, anchor, 1_000);
    const barracks = chipOf(chips, 'hourglass');
    expect(barracks.root.visible).toBe(true);
    expect(barracks.label.text).toBe('3 · 2m 4s');
    // b-1 and b-2 share level and row; the westmost one carries.
    expect(barracks.root).toMatchObject({ x: 4 * 64, y: 8 * 64 });
    layer.sync(idle, buildings, anchor, 2_000);
    expect(barracks.root.visible).toBe(false);
    expect(chipOf(chips, 'helm').root.visible).toBe(true);
  });

  it('shows one pool chip and one queue chip on a maximum base instead of one per building', () => {
    const cap = (type: 'barracks' | 'camp') => Math.max(...BUILD_COUNT_CAP_BY_KEEP[type]!);
    const dense: Building[] = [
      ...Array.from({ length: cap('barracks') }, (_, i) => building(`b-${i}`, 'barracks', 20, 10 + i * 2, 10)),
      ...Array.from({ length: cap('camp') }, (_, i) => building(`c-${i}`, 'camp', 20, 10 + i * 2, 12)),
    ];
    expect(dense.length).toBeGreaterThan(2);
    const { layer, chips } = setup(0.14);
    layer.sync(training, dense, anchor, 1_000);
    // Camps share ONE pool (D-094): the same figure on four Camps reads as four pools.
    expect(chips).toHaveLength(2);
    expect(chips.filter((chip) => chip.root.visible)).toHaveLength(2);
  });

  it('reuses its pooled objects across refreshes and carrier changes', () => {
    const { layer, chips } = setup();
    layer.sync(idle, buildings, anchor, 1_000);
    const first = chipOf(chips, 'helm'), created = chips.length;
    const upgraded = [...buildings, building('camp-2', 'camp', 4, 20, 4)];
    layer.sync({ ...idle, readyPts: 43 }, upgraded, anchor, 2_000);
    layer.sync(training, upgraded, anchor, 3_000);
    layer.sync({ ...idle, readyPts: 43 }, upgraded, anchor, 4_000);
    expect(chips).toHaveLength(created); // never more than one object set per kind
    expect(first.root).toMatchObject({ active: true, x: 20 * 64, y: 4 * 64 });
    expect(first.label.text).toBe('43/108');
  });

  it('stays glued to its building through pans and HUD changes instead of clamping into view', () => {
    // The old block was clamped inside the HUD-safe rectangle, which is how it
    // ended up floating over open ground away from its building.
    const { layer, chips, camera } = setup();
    layer.sync(idle, buildings, anchor, 1_000);
    const chip = chips[0]!;
    for (const scrollX of [0, 380, 5_000, -5_000]) {
      Object.assign(camera, { scrollX, scrollY: scrollX, width: 320, height: 120 });
      layer.update(1_500);
      expect(chip.root).toMatchObject({ x: 8 * 64, y: 12 * 64, visible: true });
    }
  });

  it('does text work once a second, not per frame or per pan', () => {
    const { layer, chips, camera } = setup();
    layer.sync(training, buildings, anchor, 1_000);
    const label = chipOf(chips, 'hourglass').label;
    const setText = vi.spyOn(label, 'setText'), setFontSize = vi.spyOn(label, 'setFontSize');
    camera.scrollX = 200; layer.update(1_400); layer.update(1_900);
    expect(setText).not.toHaveBeenCalled();
    layer.update(2_000);
    expect(setText).toHaveBeenCalledTimes(1);
    expect(label.text).toBe('3 · 2m 3s');
    expect(setFontSize).not.toHaveBeenCalled();
  });

  it('follows zoom within the same second: rescales, and re-forms only when the form changes', () => {
    const { layer, chips, camera } = setup(1);
    layer.sync(idle, buildings, anchor, 1_000);
    const chip = chips[0]!;
    const setText = vi.spyOn(chip.label, 'setText');
    expect(chip.label.fontPx).toBe(20);
    camera.zoom = 0.5; layer.update(1_100);
    expect(chip.root.scaleX).toBe(2);
    expect(setText).not.toHaveBeenCalled();
    camera.zoom = 0.2; layer.update(1_200);
    expect(chip.label.fontPx).toBe(12);
    expect(chip.plate.width).toBeLessThan(80);
  });

  it('hides for placement, a carried carrier and an open sheet — without hopping to another Camp', () => {
    const twoCamps = [...buildings, building('camp-2', 'camp', 1, 20, 12)];
    const { layer, chips } = setup();
    layer.sync(training, twoCamps, anchor, 1_000);
    const camp = chipOf(chips, 'helm'), barracks = chipOf(chips, 'hourglass');

    layer.hide('camp-1');
    expect(camp.root.visible).toBe(false);
    expect(camp.root).toMatchObject({ x: 8 * 64, y: 12 * 64 }); // did not jump to camp-2
    expect(barracks.root.visible).toBe(true);
    layer.hide('camp-2'); layer.show('camp-2'); // a non-carrier drag changes nothing
    expect(camp.root.visible).toBe(false);
    layer.show('camp-1');
    expect(camp.root.visible).toBe(true);

    layer.hide('camp-1');
    layer.sync(training, twoCamps, anchor, 1_500);
    expect(camp.root.visible).toBe(true); // committed move refresh releases drag hide

    layer.setSelected('b-1');
    expect(barracks.root.visible).toBe(false);
    expect(camp.root.visible).toBe(true);
    layer.setSelected(null);
    expect(barracks.root.visible).toBe(true);

    layer.setSuppressed(true);
    expect(chips.every((chip) => !chip.root.visible)).toBe(true);
    layer.show('camp-1');
    expect(camp.root.visible).toBe(false);
    layer.setSuppressed(false);
    expect(chips.every((chip) => chip.root.visible)).toBe(true);
  });

  it('leaves no chip at the previous base after a base switch', () => {
    const { layer, chips } = setup();
    layer.sync(training, buildings, anchor, 1_000);
    const otherBase = [building('o-camp', 'camp', 2, 30, 30), building('o-keep', 'keep', 3, 20, 20)];
    layer.sync(idle, otherBase, anchor, 2_000);
    const camp = chipOf(chips, 'helm'), barracks = chipOf(chips, 'hourglass');
    expect(camp.root).toMatchObject({ x: 30 * 64, y: 30 * 64, visible: true });
    expect(barracks.root.visible).toBe(false); // the new base has no Barracks
    // A drag callback for the old base's building must not touch the new chip.
    layer.hide('camp-1');
    expect(camp.root.visible).toBe(true);

    // A sprite that is not on the map yet offers no anchor: show nothing
    // rather than the previous position.
    layer.sync(training, buildings, () => undefined, 2_500);
    expect(chips.every((chip) => !chip.root.visible)).toBe(true);

    layer.sync(idle, [building('o-keep', 'keep', 3, 20, 20)], anchor, 3_000);
    expect(chips.every((chip) => !chip.root.visible)).toBe(true);
    layer.sync(undefined, buildings, anchor, 4_000); // older API cut: no armyStatus
    expect(chips.every((chip) => !chip.root.visible)).toBe(true);

    layer.destroy();
    expect(chips.every((chip) => !chip.root.active && !chip.label.active)).toBe(true);
  });

  it('switches plate and ink with the housing state', () => {
    const { layer, chips } = setup();
    layer.sync({ ...idle, readyPts: 108 }, buildings, anchor, 1_000);
    const chip = chips[0]!;
    expect(chip.label.text).toBe('FULL 108/108');
    expect(chip.plate.stroke).toBe(ARMY_CHIP_TONES.full.stroke);
    layer.sync({ ...idle, readyPts: 120 }, buildings, anchor, 2_000);
    expect(chip.label.text).toBe('OVER 120/108');
    expect(chip).toMatchObject({
      plate: { stroke: ARMY_CHIP_TONES.over.stroke },
      label: { color: ARMY_CHIP_TONES.over.inkCss },
      icon: { tint: ARMY_CHIP_TONES.over.ink },
    });
  });

  it('stacks above an active upgrade/repair job instead of crossing its timer panel', () => {
    const legacyTop = spriteVisualTopY(1_000, 1, 120);
    const tierFourTop = spriteVisualTopY(1_000, 104 / 128, 128);
    expect(legacyTop).toBe(880);
    expect(tierFourTop).toBe(896);
    expect(armyStatusAnchorY(legacyTop, 900, false, 64)).toBe(872);
    expect(armyStatusAnchorY(tierFourTop, 900, false, 64)).toBe(888);
    // Busy anchoring ignores authored origin: JobLayer's panel top is
    // footprint top − 56 at T=64, followed by the exact 8-world-pixel gap.
    // The job chip wins the roofline; the army chip rides above it.
    expect(armyStatusAnchorY(legacyTop, 900, true, 64)).toBe(836);
    expect(armyStatusAnchorY(tierFourTop, 900, true, 64)).toBe(836);
  });
});
