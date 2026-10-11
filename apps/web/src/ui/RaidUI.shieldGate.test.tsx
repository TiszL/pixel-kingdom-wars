/** @vitest-environment happy-dom */
/**
 * Shield-break consent before a PvP raid (tester report 2026-09-16: "the
 * attack begins immediately and the shield is permanently removed in the
 * background without any warning"). The server deletes the ATTACKER's shield on
 * the first accepted PvP deploy, so the client's only honest moment to ask is
 * BEFORE the create: these pin that a shielded base's PvP create waits for
 * PROCEED, that BACK posts nothing, and that campaign raids — which never break
 * a shield — are not gated at all.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_VERSION } from '@shardkeep/sim';
import { useApp, type BaseStateDto } from '../state/store';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), postRaw: vi.fn(), idemKey: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, idemKey: mocks.idemKey, api: { ...actual.api, get: mocks.get, post: mocks.post, postRaw: mocks.postRaw } };
});
vi.mock('./raidSimulation', () => ({ RaidSimulationService: class { async simulate() { throw new Error('unused'); } } }));
vi.mock('../auth/useSolPurchase', () => ({
  useSolPurchase: () => ({ purchase: vi.fn(), phase: 'idle', error: null }),
}));
vi.mock('../state/baseSnapshot', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/audio', () => ({ playSfx: vi.fn(), stopAllLoops: vi.fn() }));
vi.mock('../lib/juice', () => ({ haptic: vi.fn() }));

import { RaidUI } from './RaidUI';

const attackerBaseId = '00000000-0000-4000-8000-000000000001';
const raidId = '00000000-0000-4000-8000-000000000003';
const shielded = (): BaseStateDto => ({
  baseId: attackerBaseId,
  player: { wallet: 'attacker-wallet', name: 'ATTACKER', keepLevel: 5, trophies: 100, league: 'bronze', builders: 2, expansions: 0 },
  claim: { min: 4, max: 18 },
  energy: { used: 0, free: 3, max: 6 },
  shield: { activeUntil: new Date(Date.now() + 47 * 3_600_000).toISOString(), hoursLeft: 47, remainingMs: 47 * 3_600_000, active: true, source: 'loss' },
  buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 2,
});
const raid = (extra: Record<string, unknown>) => ({
  id: raidId, attackerBaseId, defenderBaseId: null, defenderWallet: 'defender', pveCampId: null, campaignStage: null,
  snapshot: { buildings: [], claimMin: 4, claimMax: 18 },
  armySnapshot: { counts: { highlander: 1 }, levels: { highlander: 1 }, heroes: [] },
  ordersDeadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(), seed: 7, simVersion: SIM_VERSION, ...extra,
});
const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
const creates = (): string[] => mocks.postRaw.mock.calls.map(([path]) => String(path)).filter((p) => p === '/raids' || p.startsWith('/campaign/'));
const button = (host: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('shield-break consent gates a fresh PvP create', () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.get.mockReset().mockRejectedValue(new Error('unexpected GET'));
    mocks.post.mockReset(); mocks.postRaw.mockReset(); mocks.idemKey.mockReset().mockReturnValue('key-1');
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove();
    useApp.setState({ screen: 'base', raidTarget: null, base: null, selectedBaseId: null });
  });

  it('auto-match with an active shield asks first, quotes the remaining time, and creates only on PROCEED', async () => {
    mocks.postRaw.mockImplementation((path: string) => path === '/raids'
      ? Promise.resolve({ raid: raid({}) }) : Promise.reject(new Error(`unexpected POST ${path}`)));
    useApp.setState({ screen: 'battle', baseDirectory: null, selectedBaseId: attackerBaseId, base: shielded(), raidTarget: null });
    await act(async () => root.render(<RaidUI />)); await flush();
    const warning = host.querySelector('[data-shield-break-warning]');
    expect(warning?.textContent).toContain('ATTACKING DROPS YOUR SHIELD');
    expect(warning?.textContent).toMatch(/1d 23h|47h/); // the server's remaining figure, formatted by the shared fmtDur
    expect(warning?.textContent).toContain('PROCEED?');
    expect(creates()).toHaveLength(0);
    await act(async () => button(host, 'PROCEED')!.click()); await flush();
    expect(creates()).toEqual(['/raids']);
    expect(host.querySelector('[data-shield-break-warning]')).toBeNull();
  });

  it('BACK TO BASE from the warning posts nothing and leaves the battle screen', async () => {
    mocks.postRaw.mockRejectedValue(new Error('must not create'));
    useApp.setState({ screen: 'battle', baseDirectory: null, selectedBaseId: attackerBaseId, base: shielded(), raidTarget: { kind: 'pvp', wallet: 'defender', defenderBaseId: 'b' } });
    await act(async () => root.render(<RaidUI />)); await flush();
    expect(host.querySelector('[data-shield-break-warning]')).not.toBeNull();
    await act(async () => button(host, 'BACK TO BASE')!.click()); await flush();
    expect(creates()).toHaveLength(0);
    expect(useApp.getState().screen).toBe('base');
  });

  it('a campaign stage never breaks a shield, so it is never gated', async () => {
    mocks.postRaw.mockImplementation((path: string) => path === '/campaign/1/raid'
      ? Promise.resolve({ raid: raid({ defenderWallet: 'campaign', campaignStage: 1 }) }) : Promise.reject(new Error(`unexpected POST ${path}`)));
    useApp.setState({ screen: 'battle', baseDirectory: null, selectedBaseId: attackerBaseId, base: shielded(), raidTarget: { kind: 'campaign', stage: 1 } });
    await act(async () => root.render(<RaidUI />)); await flush();
    expect(host.querySelector('[data-shield-break-warning]')).toBeNull();
    expect(creates()).toEqual(['/campaign/1/raid']);
  });

  it('an unshielded base is not asked anything (the pre-existing flow, byte for byte)', async () => {
    mocks.postRaw.mockImplementation((path: string) => path === '/raids'
      ? Promise.resolve({ raid: raid({}) }) : Promise.reject(new Error(`unexpected POST ${path}`)));
    useApp.setState({ screen: 'battle', baseDirectory: null, selectedBaseId: attackerBaseId, base: { ...shielded(), shield: null }, raidTarget: null });
    await act(async () => root.render(<RaidUI />)); await flush();
    expect(host.querySelector('[data-shield-break-warning]')).toBeNull();
    expect(creates()).toEqual(['/raids']);
  });
});
