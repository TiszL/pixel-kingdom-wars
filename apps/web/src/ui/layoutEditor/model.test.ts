import { describe, expect, it } from 'vitest';
import type { BaseStateDto } from '../../state/store';
import {
  LAYOUT_SLOT_LABELS, LAYOUT_UNDO_LIMIT, createDraft, legacyImportMarker, markLegacyImported,
  moveBuilding, moveToTray, nudgeSelected, paintWalls, pickUpAll,
  readLegacyLayout, selectBuilding, slotLabel, undoDraft, validateCompleteLayout,
  validatePlacement,
  type LayoutGeometry,
} from './model';
import type { LayoutSlot, LayoutSlotDto } from './types';

const ids = {
  keep: '00000000-0000-4000-8000-000000000001',
  mine: '00000000-0000-4000-8000-000000000002',
  wallA: '00000000-0000-4000-8000-000000000003',
  wallB: '00000000-0000-4000-8000-000000000004',
  wallC: '00000000-0000-4000-8000-000000000005',
};

const buildings: BaseStateDto['buildings'] = [
  { id: ids.keep, type: 'keep', level: 4, tx: 8, ty: 8, underConstruction: false },
  { id: ids.mine, type: 'mine', level: 3, tx: 10, ty: 8, underConstruction: false },
  { id: ids.wallA, type: 'wall', level: 2, tx: 11, ty: 8, underConstruction: false },
  { id: ids.wallB, type: 'wall', level: 2, tx: 12, ty: 8, underConstruction: false },
  { id: ids.wallC, type: 'wall', level: 3, tx: 13, ty: 8, underConstruction: false },
];

const home: LayoutSlotDto = {
  slot: 'HOME', locked: false, etag: `sha256:${'a'.repeat(64)}`,
  compatibility: 'ready', unplacedBuildingIds: [], removedBuildingIds: [],
  positions: buildings.map(({ id, tx, ty }) => ({ buildingId: id, tx, ty })),
};

const geometry: LayoutGeometry = {
  geometryVersion: 1,
  claim: { min: 8, max: 22 },
  buildings,
  obstacles: [{ id: 'obstacle', spriteKey: 'tree_old', tx: 15, ty: 15 }],
};

describe('layout draft identity and geometry', () => {
  it('admits the larger signed plot only with its explicit version and still blocks footprints', () => {
    const larger = { ...geometry, plotVersion: 2, claim: { min: -10, max: 40 } };
    for (const [tx, ty] of [[-10, -10], [39, -10], [-10, 39], [39, 39]]) {
      expect(validatePlacement(larger, home.positions, ids.wallA, tx!, ty!)).toBeNull();
    }
    expect(validatePlacement(larger, home.positions, ids.wallA, 15, 15)).toBe('AN OBSTACLE BLOCKS THOSE TILES');
    expect(validatePlacement({ ...larger, plotVersion: 1 }, home.positions, ids.wallA, -10, -10)).toBe('OUTSIDE THE ACTIVE CLAIM');
    expect(validatePlacement({ ...larger, plotVersion: 99 }, home.positions, ids.wallA, 15, 10)).toBe('UPDATE THE GAME TO EDIT THIS BASE');
    expect(validatePlacement(larger, home.positions, ids.wallA, 40, 39)).toBe('OUTSIDE THE ACTIVE CLAIM');
  });
  it('starts empty/repair slots from the authoritative live base instead of guessing missing ids', () => {
    const repair: LayoutSlotDto = {
      ...home, compatibility: 'needs_repair',
      positions: [{ buildingId: ids.keep, tx: 12, ty: 12 }],
      unplacedBuildingIds: [ids.mine, ids.wallA, ids.wallB],
    };
    expect(createDraft(buildings, repair)).toMatchObject({
      dirty: true,
      positions: expect.arrayContaining([
        { buildingId: ids.keep, tx: 8, ty: 8 },
        { buildingId: ids.mine, tx: 10, ty: 8 },
      ]),
    });
  });

  it('lets the Keep enter the identity tray while complete-layout validation still requires it', () => {
    const draft = createDraft(buildings, home);
    const keepTrayed = moveToTray(draft, buildings, ids.keep);
    expect(keepTrayed.error).toBeNull();
    expect(keepTrayed.draft.positions).not.toContainEqual(expect.objectContaining({ buildingId: ids.keep }));
    expect(keepTrayed.draft.trayIds).toEqual([ids.keep]);
    expect(validateCompleteLayout(geometry, keepTrayed.draft.positions))
      .toBe('LAYOUT MUST PLACE EVERY BUILDING');

    const picked = pickUpAll(draft, buildings);
    expect(picked.positions).toEqual([]);
    expect(picked.trayIds).toEqual([ids.keep, ids.mine, ids.wallA, ids.wallB, ids.wallC]);

    const replaced = moveBuilding(picked, geometry, ids.keep, 8, 8);
    expect(replaced.error).toBeNull();
    expect(replaced.draft.positions).toEqual([{ buildingId: ids.keep, tx: 8, ty: 8 }]);
    expect(replaced.draft.trayIds).toEqual([ids.mine, ids.wallA, ids.wallB, ids.wallC]);
    expect(validateCompleteLayout(geometry, replaced.draft.positions))
      .toBe('LAYOUT MUST PLACE EVERY BUILDING');
  });

  it('validates authoritative footprints, claim edges and obstacles before changing the draft', () => {
    const draft = createDraft(buildings, home);
    expect(moveBuilding(draft, geometry, ids.mine, 8, 8).error)
      .toBe('ANOTHER BUILDING OCCUPIES THOSE TILES');
    expect(moveBuilding(draft, geometry, ids.mine, 7, 8).error)
      .toBe('OUTSIDE THE ACTIVE CLAIM');
    expect(moveBuilding(draft, geometry, ids.mine, 15, 15).error)
      .toBe('AN OBSTACLE BLOCKS THOSE TILES');
    const moved = moveBuilding(draft, geometry, ids.mine, 13, 9);
    expect(moved.error).toBeNull();
    expect(moved.draft.positions).toContainEqual({ buildingId: ids.mine, tx: 13, ty: 9 });
    expect(validateCompleteLayout(geometry, moved.draft.positions)).toBeNull();
  });

  it('keeps exactly forty reversible snapshots and nudges one tile at a time', () => {
    let draft = selectBuilding(createDraft(buildings, home), ids.mine);
    for (let i = 0; i < LAYOUT_UNDO_LIMIT + 5; i++) {
      const x = 13 + i % 2;
      draft = moveBuilding(draft, geometry, ids.mine, x, 10).draft;
    }
    expect(draft.history).toHaveLength(LAYOUT_UNDO_LIMIT);
    const before = draft.positions.find((position) => position.buildingId === ids.mine)!;
    const nudged = nudgeSelected(draft, geometry, 0, 1).draft;
    expect(nudged.positions).toContainEqual({ ...before, ty: before.ty + 1 });
    expect(undoDraft(nudged).positions).toEqual(draft.positions);
  });

  it('wall paint consumes existing trayed wall ids in stable order and creates nothing', () => {
    let draft = createDraft(buildings, home);
    draft = moveToTray(draft, buildings, ids.wallA).draft;
    draft = moveToTray(draft, buildings, ids.wallB).draft;
    draft = moveToTray(draft, buildings, ids.wallC).draft;
    const historyBefore = draft.history.length;
    const painted = paintWalls(draft, geometry, 2, [
      { tx: 13, ty: 12 }, { tx: 13, ty: 12 }, { tx: 15, ty: 15 }, { tx: 14, ty: 12 },
    ]);
    expect(painted.error).toBeNull();
    expect(painted.draft.trayIds).toEqual([ids.wallC]);
    expect(painted.draft.history).toHaveLength(historyBefore + 1);
    expect(painted.draft.positions).toEqual(expect.arrayContaining([
      { buildingId: ids.wallA, tx: 13, ty: 12 },
      { buildingId: ids.wallB, tx: 14, ty: 12 },
    ]));
    expect(painted.draft.positions).toHaveLength(buildings.length - 1);
    expect(painted.draft.positions).not.toContainEqual(expect.objectContaining({ buildingId: ids.wallC }));
    expect(undoDraft(painted.draft).trayIds).toEqual([ids.wallA, ids.wallB, ids.wallC]);
  });
});

describe('slot labels are copy, slot ids are contracts', () => {
  // D-099 (owner 2026-09-02): "remove wording FARM … we have BASE". D-087 keeps
  // the wire id FARM (API path, zod enum, ledger reason), so the ONLY place a
  // slot becomes on-screen text is this map — and no label may say FARM.
  it('labels slot A HOME and slot B BASE, and no rendered label contains FARM', () => {
    expect(slotLabel('HOME')).toBe('HOME');
    expect(slotLabel('FARM')).toBe('BASE');
    for (const slot of Object.keys(LAYOUT_SLOT_LABELS) as LayoutSlot[]) {
      expect(slotLabel(slot)).not.toContain('FARM');
    }
  });
});

describe('one-release exact-id device import', () => {
  const preset = {
    A: { t: 1, b: buildings.map(({ id, tx, ty }) => ({ id, tx: tx + 2, ty: ty + 2 })) },
    B: { t: 2, b: buildings.map(({ id, tx, ty }) => ({ id, tx: tx + 3, ty: ty + 3 })) },
    C: { t: 3, b: buildings.map(({ id, tx, ty }) => ({ id, tx: tx + 4, ty: ty + 4 })) },
  };

  it('maps only A→HOME and B→FARM, refusing partial or foreign identities', () => {
    const values = new Map([['skp_layouts', JSON.stringify(preset)]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null };
    expect(readLegacyLayout(storage, 'base', 'HOME', buildings)?.[0]?.tx)
      .toBe(home.positions.slice().sort((a, b) => a.buildingId.localeCompare(b.buildingId))[0]!.tx + 2);
    expect(readLegacyLayout(storage, 'base', 'FARM', buildings)?.[0]?.tx)
      .toBe(home.positions.slice().sort((a, b) => a.buildingId.localeCompare(b.buildingId))[0]!.tx + 3);

    values.set('skp_layouts', JSON.stringify({ A: { b: preset.A.b.slice(1) } }));
    expect(readLegacyLayout(storage, 'base', 'HOME', buildings)).toBeNull();
    values.set('skp_layouts', JSON.stringify({ A: { b: [
      ...preset.A.b.slice(0, -1), { id: 'foreign', tx: 10, ty: 10 },
    ] } }));
    expect(readLegacyLayout(storage, 'base', 'HOME', buildings)).toBeNull();
  });

  it('ignores malformed JSON values without throwing during editor mount', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null };
    for (const malformed of ['null', '7', '"layout"', '[]', '{']) {
      values.set('skp_layouts', malformed);
      expect(readLegacyLayout(storage, 'base', 'HOME', buildings)).toBeNull();
    }
  });

  it('stops offering an exact preset only after a successful caller marks it imported', () => {
    const values = new Map([['skp_layouts', JSON.stringify(preset)]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(readLegacyLayout(storage, 'base', 'HOME', buildings)).not.toBeNull();
    markLegacyImported(storage, 'base', 'HOME');
    expect(values.get(legacyImportMarker('base', 'HOME'))).toBe('1');
    expect(readLegacyLayout(storage, 'base', 'HOME', buildings)).toBeNull();
  });
});
