/** @vitest-environment happy-dom */
/**
 * HERO ROSTER gear-delta display (D-059, owner 2026-08-16: "items equiped on
 * heroes I think does not change stats … if not then it should be displayed on
 * UI"). WHY these pins: the roster must render the SERVER's gear bonus next to
 * the base stat ("HP 1,400 +84") so an equipped item is visibly causal, and it
 * must render NO bonus marker when the server sent none — a client-invented
 * delta would claim combat effects the raid snapshot never froze.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { id, identity } from '../../lib/heroProgression/fixtures.test-support';
import { useApp } from '../../state/store';
import type { HeroDto } from './heroes';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('../../lib/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  idemKey: () => 'test-intent-key',
}));
// heroes.tsx pulls reloadBase from the sheet module, which reaches wallet
// adapters through the purchase hooks — this display suite never navigates.
vi.mock('../sheets', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/heroProgression/context', () => ({ useHeroProgressionView: () => null }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
import { HeroTray } from './heroes';

function hero(overrides: Partial<HeroDto>): HeroDto {
  return {
    hero: 'vex', name: 'Vex', title: 'Blade of Dawn', altar: 'heroaltar',
    unlockKeepLevel: 5, recruitCostKeep: '3000', recruitItemId: 'item_hero_vex',
    recruited: true, level: 4, tier: 1, tierName: 'Initiate',
    hp: 1_400, dps: 95, recoveryUntil: null, available: true, gear: null,
    recoveryFinishNow: null, maxLevel: 20,
    next: { level: 5, tier: 1, tierName: 'Initiate', hp: 1_600, dps: 110, costKeep: '1000' },
    affordable: true,
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true);
  useApp.setState({ screen: 'build', selectedBaseId: id(1), baseSelectionEpoch: 0, selectedBuildingId: null, buildCategory: 'her' });
  mocks.get.mockReset();
  mocks.post.mockReset().mockResolvedValue({});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.restoreAllMocks(); useApp.getState().setAuth(null);
  useApp.setState({ base: null, selectedBaseId: null });
});

describe('hero roster gear deltas are the server’s numbers', () => {
  it('renders base stat + signed gear bonus for a geared hero and no marker without gear', async () => {
    mocks.get.mockResolvedValue({
      keepBalance: '0', keepLevel: 10,
      heroes: [
        hero({ gear: { hp: 1_484, dps: 101, hpBonus: 84, dpsBonus: 6 } }),
        hero({
          hero: 'theodor', name: 'Theodor', title: 'Siegemaster', altar: 'siegestool',
          hp: 4_200, dps: 38, gear: null,
          next: { level: 5, tier: 1, tierName: 'Initiate', hp: 4_600, dps: 41, costKeep: '1000' },
        }),
      ],
    });
    await act(async () => root.render(<HeroTray />));

    // Vex: base value stays primary, the server delta rides beside it.
    expect(host.textContent).toContain('1,400');
    expect(host.textContent).toContain('+84');
    expect(host.textContent).toContain('95');
    expect(host.textContent).toContain('+6');
    // Theodor sent gear:null — his stat lines must carry no bonus marker at
    // all, so a dark rollout or an empty loadout can never look active.
    expect(host.textContent).toContain('4,200');
    expect(host.textContent).not.toContain('+4,600');
    expect((host.textContent!.match(/\+/g) ?? []).length).toBe(2);
  });

  it('shows a harmful net delta signed negative, never disguised as a gain', async () => {
    mocks.get.mockResolvedValue({
      keepBalance: '0', keepLevel: 10,
      heroes: [hero({ gear: { hp: 1_330, dps: 95, hpBonus: -70, dpsBonus: 0 } })],
    });
    await act(async () => root.render(<HeroTray />));

    expect(host.textContent).toContain('-70');
    // dpsBonus 0 must render nothing — zero is "no effect", not "+0".
    expect(host.textContent).not.toContain('+0');
  });
});
