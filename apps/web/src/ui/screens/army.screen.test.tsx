/** @vitest-environment happy-dom */
/**
 * The ARMY screen behind the task rail (D-096 troop stock, owner 2026-09-02).
 *
 * The header is the one thing this screen adds over the camp tray, and it must
 * be the server's base-wide figures VERBATIM or nothing: a "0 READY" invented
 * while armyStatus is absent would be a fake number on a primary surface, and
 * any rounding or reinterpretation would put the client ahead of /base. It
 * also describes capacity only — never a raid verdict (D-094).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseStateDto } from '../../state/store';
import { useApp } from '../../state/store';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
import { ArmyScreen } from './army';

const BASE: BaseStateDto = {
  player: {
    wallet: 'wallet', name: 'KEEPER', keepLevel: 3, trophies: 120,
    league: 'wood', builders: 1, expansions: 0,
  },
  claim: { min: 0, max: 0 }, energy: { used: 0, free: 1, max: 1 },
  shield: null,
  warzone: { active: false, boundaryAt: null, remainingMs: null },
  buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
};
/** Deliberately NOT the roster's own totals: the header must quote /base,
 *  and the roster line below it quotes /army. Equal numbers would let a
 *  cross-wired read pass unnoticed. */
const ARMY_STATUS: NonNullable<BaseStateDto['armyStatus']> = {
  readyTroopCount: 42, readyPts: 210, campCapacityPts: 300,
  trainingTroopCount: 3, trainingPts: 15, barracksQueuePts: 60,
  nextReadyAt: null, allReadyAt: null,
};
const ROSTER = {
  counts: { bowman: 42 }, levels: { bowman: 1 }, research: [], queue: [],
  rosterPts: 205, campCapacityPts: 300, barracksQueuePts: 60,
  eliteUnlocks: {}, features: {},
};

let host: HTMLDivElement;
let root: Root;
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.get.mockReset().mockResolvedValue(ROSTER);
  mocks.post.mockReset();
  useApp.setState({ selectedBaseId: null, screen: 'army' });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useApp.getState().setBase(null);
  useApp.setState({ selectedBaseId: null, screen: 'base' });
});

describe('ArmyScreen header', () => {
  it('renders the /base figures verbatim over the roster', async () => {
    useApp.getState().setBase({ ...BASE, armyStatus: ARMY_STATUS });
    await act(async () => root.render(<ArmyScreen />)); await flush();
    expect(host.textContent).toContain('BASE ARMY · 42 READY · 210/300 PTS · 3 TRAINING');
    // The per-troop counts still come from the roster's own read, exactly as
    // the camp tray fetches them — the header adds no request of its own.
    expect(mocks.get).toHaveBeenCalledTimes(1);
    // The same roster read now rejects a response from an obsolete wallet/base
    // generation before publication; it still adds no extra header request.
    expect(mocks.get).toHaveBeenCalledWith('/army', { isCurrent: expect.any(Function) });
    expect(host.textContent).toContain('×42');
    expect(host.textContent).toContain('ARMY 205/300 PTS');
    // Capacity, not a verdict (D-094): the header never grades the army.
    expect(host.textContent).not.toMatch(/FULL|OVER|READY TO RAID/);
  });

  it('draws no header at all when /base carries no armyStatus', async () => {
    // An older API cut omits the block. Nothing here may stand in for it: a
    // "0 READY · 0/0 PTS" would be the client inventing a game number.
    useApp.getState().setBase(BASE);
    await act(async () => root.render(<ArmyScreen />)); await flush();
    expect(host.textContent).not.toContain('BASE ARMY');
    expect(host.textContent).not.toContain('TRAINING');
    expect(host.textContent).toContain('LIVES HERE BETWEEN RAIDS');
  });

  it('closes back to the base like every other modal screen', async () => {
    useApp.getState().setBase({ ...BASE, armyStatus: ARMY_STATUS });
    await act(async () => root.render(<ArmyScreen />)); await flush();
    const close = host.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close).toBeTruthy();
    await act(async () => close.click());
    expect(useApp.getState().screen).toBe('base');
  });
});

describe('the player menu ARMY count is the /base figure or nothing', () => {
  it('passes the optional server block intact and guards both ready and training counts', () => {
    // Opening the new secondary menu must not fabricate a zero for rolling APIs
    // which omit armyStatus. The existing menu render tests exercise the route.
    const directory = dirname(fileURLToPath(import.meta.url));
    const overlay = readFileSync(resolve(directory, '../Overlay.tsx'), 'utf8');
    const menu = readFileSync(resolve(directory, '../hudOverflow.tsx'), 'utf8');
    expect(overlay).toContain('armyStatus={base.armyStatus}');
    expect(menu).toContain("route === 'army' && p.armyStatus &&");
    expect(menu).toContain('{p.armyStatus.readyTroopCount} READY');
    expect(menu).toContain('{p.armyStatus.trainingTroopCount} TRAINING');
    expect(menu).not.toContain('readyTroopCount ?? 0');
  });
});
