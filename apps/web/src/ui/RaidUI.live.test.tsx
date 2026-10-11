/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RAID_RULES, type LiveRaidClock } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { ApiError, type BasesDto } from '../lib/api';
import { bus } from '../lib/events';
import { useApp, type BaseStateDto } from '../state/store';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postRaw: vi.fn(),
  simulateRaid: vi.fn(),
  idemKey: vi.fn(),
}));

vi.mock('@shardkeep/sim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shardkeep/sim')>();
  return { ...actual, simulateRaid: mocks.simulateRaid };
});
vi.mock('./raidSimulation', () => ({ RaidSimulationService: class {
  async simulate(input: import('./raidSimulation').RaidSimulationInput) {
    return mocks.simulateRaid(input.snapshot, input.orders, input.seed, input.options);
  }
  dispose() {}
} }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    idemKey: mocks.idemKey,
    api: { ...actual.api, get: mocks.get, post: mocks.post, postRaw: mocks.postRaw },
  };
});
vi.mock('../auth/useSolPurchase', () => ({
  useSolPurchase: () => ({ purchase: vi.fn(), phase: 'idle', error: null }),
}));
vi.mock('../state/baseSnapshot', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/audio', () => ({ playSfx: vi.fn(), stopAllLoops: vi.fn() }));
vi.mock('../lib/juice', () => ({ haptic: vi.fn() }));

import { RaidUI } from './RaidUI';
import type { LiveCommand } from './liveRaid';

const attackerBaseId = '00000000-0000-4000-8000-000000000001';
const defenderBaseId = '00000000-0000-4000-8000-000000000002';
const raidId = '00000000-0000-4000-8000-000000000003';
const raid = {
  id: raidId,
  attackerBaseId,
  defenderBaseId,
  defenderWallet: 'defender-wallet',
  pveCampId: null,
  campaignStage: null,
  snapshot: { buildings: [], claimMin: 4, claimMax: 18 },
  armySnapshot: { counts: { highlander: 1 }, levels: { highlander: 1 }, heroes: [] },
  ordersDeadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  seed: 7,
  simVersion: SIM_VERSION,
};
const directory: BasesDto = {
  enabled: true,
  maxActive: 5,
  nextLandPurchaseKind: 'deed',
  capabilities: { baseScopedReads: true, baseScopedMutations: true, cellReservations: true },
  bases: [],
};
const base = {
  baseId: attackerBaseId,
  player: {
    wallet: 'attacker-wallet', name: 'ATTACKER', keepLevel: 5, trophies: 100,
    league: 'bronze', builders: 2, expansions: 0,
  },
  claim: { min: 4, max: 18 },
  energy: { used: 0, free: 3, max: 6 },
  shield: null,
  buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 2,
} satisfies BaseStateDto;

function liveView(commands: unknown[] = []) {
  return {
    protocolVersion: 1,
    clock: {
      protocolVersion: 1, revision: 0, rate: 1,
      anchorWallAt: commands.length ? '2026-08-12T00:00:00.000Z' : null,
      simNowMs: 0, durationMs: 90_000,
    },
    startedAt: commands.length ? '2026-08-12T00:00:00.000Z' : null,
    battleEndsAt: commands.length ? '2026-08-12T00:01:30.000Z' : null,
    streamClosedAt: null,
    lastSequence: commands.length - 1,
    snapshot: raid.snapshot,
    armySnapshot: raid.armySnapshot,
    seed: raid.seed,
    simVersion: raid.simVersion,
    status: 'pending_orders',
    commands,
    hasMore: false,
  };
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('stable PvP accepted-command client', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    mocks.get.mockReset(); mocks.post.mockReset(); mocks.postRaw.mockReset();
    mocks.simulateRaid.mockReset();
    mocks.idemKey.mockReset().mockReturnValue('stable-command-id');
    mocks.post.mockResolvedValue({ raid });
    mocks.postRaw.mockImplementation((path: string) => {
      if (path === '/raids') return Promise.resolve({ raid });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidId}/live`)) return Promise.resolve(liveView());
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.simulateRaid.mockReturnValue({
      events: [{ t: 0, e: 'deploy', id: 1, troop: 'highlander', x: 0, y: 0 }],
      stars: 0, destructionPct: 0, keepDestroyed: false,
    });
    useApp.setState({
      screen: 'battle', baseDirectory: directory, selectedBaseId: attackerBaseId,
      base, raidTarget: { kind: 'pvp', wallet: 'defender-wallet', defenderBaseId },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<RaidUI />));
    await flush();
    // Creation now uses postRaw so the exact idempotency key can survive the
    // protocol-2 capability fallback. Command assertions own only later writes.
    mocks.postRaw.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useApp.setState({ screen: 'base', raidTarget: null, baseDirectory: null });
  });

  it('leaves transparent HUD row gaps untargetable while actual pills block canvas starts', () => {
    const hud = host.querySelector<HTMLElement>('[data-testid="battle-hud"]')!;
    const rows = [...hud.children].filter((child) => (child as HTMLElement).style.flexWrap === 'wrap') as HTMLElement[];
    expect(rows).toHaveLength(1);
    const windowStart = vi.fn();
    window.addEventListener('mousedown', windowStart);
    try {
      for (const row of rows) {
        // The HUD parent passes through empty space. A full-width auto row
        // used to silently swallow field taps between the visible pills.
        expect(row.style.pointerEvents).not.toBe('auto');
        const pill = row.querySelector<HTMLElement>('.interactive')!;
        expect(pill).not.toBeNull();
        pill.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
      expect(windowStart).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('mousedown', windowStart);
    }
  });

  it.each([
    { raw: { tx: 10, ty: -4, fx: 10.5, fy: -3.5 }, visible: ['10,-3'], destination: { tx: 10, ty: -3 } },
    { raw: { tx: 10, ty: -5, fx: 10.5, fy: -4.5 }, visible: ['9,-4', '11,-4'], destination: { tx: 9, ty: -4 } },
  ])('chooses a visible legal neighbor when the closest legal top tile is hidden: $raw.ty', async ({ raw, visible, destination }) => {
    mocks.postRaw.mockReturnValue(new Promise(() => {}));
    await act(async () => bus.emit('battle:tap', { ...raw, visibleTiles: visible }));
    expect(mocks.postRaw).toHaveBeenCalledExactlyOnceWith(`/raids/${raidId}/commands`, {
      clientCommandId: 'stable-command-id',
      command: { kind: 'deploy', payload: { troop: 'highlander', ...destination } },
    });
    expect(host.textContent).toContain('×0');
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
  });

  it('checks the final snapped destination before consuming a raw tap just outside the battlefield', async () => {
    // A visible raw tile -5 must reach its legal -4 neighbor; the raw tile's
    // visibility list cannot overrule the scene's final destination check.
    mocks.postRaw.mockReturnValue(new Promise(() => {}));
    const marks: unknown[] = [];
    const off = bus.on('battle:mark', (mark) => marks.push(mark));
    const previewVisible = vi.fn((destination: { tx: number; ty: number }) =>
      destination.tx === 10 && destination.ty === -4);
    await act(async () => bus.emit('battle:tap', {
      tx: 10, ty: -5, fx: 10.5, fy: -4.5, visibleTiles: [], previewVisible,
    }));
    expect(previewVisible).toHaveBeenCalledWith({ tx: 10, ty: -4 }, 'highlander', undefined);
    expect(mocks.postRaw).toHaveBeenCalledExactlyOnceWith(`/raids/${raidId}/commands`, {
      clientCommandId: 'stable-command-id',
      command: { kind: 'deploy', payload: { troop: 'highlander', tx: 10, ty: -4 } },
    });
    expect(marks).toEqual([{ troop: 'highlander', tx: 10, ty: -4 }]);
    expect(host.textContent).toContain('×0');
    expect(mocks.simulateRaid).not.toHaveBeenCalled(); // only server acceptance starts combat
    off();
  });

  it('keeps the card and sends nothing when the final snapped destination is hidden by the HUD', async () => {
    mocks.postRaw.mockReturnValue(new Promise(() => {}));
    const marks: unknown[] = [];
    const off = bus.on('battle:mark', (mark) => marks.push(mark));
    const previewVisible = vi.fn(() => false);
    const tap = { tx: 10, ty: -5, fx: 10.5, fy: -4.5, visibleTiles: ['10,-4'], previewVisible };
    await act(async () => bus.emit('battle:tap', tap));
    expect(previewVisible).toHaveBeenCalledWith({ tx: 10, ty: -4 }, 'highlander', undefined);
    expect(mocks.postRaw).not.toHaveBeenCalled();
    expect(marks).toEqual([]);
    expect(host.textContent).toContain('×1');
    // After the player pans, the same unspent troop is still available.
    previewVisible.mockReturnValue(true);
    await act(async () => bus.emit('battle:tap', tap));
    expect(mocks.postRaw).toHaveBeenCalledOnce();
    expect(marks).toHaveLength(1);
    off();
  });

  it('does not let visible artwork override an illegal deployment destination', async () => {
    const previewVisible = vi.fn(() => true);
    await act(async () => bus.emit('battle:tap', { tx: 10, ty: 10, previewVisible }));
    expect(previewVisible).not.toHaveBeenCalled(); // entire neighborhood is claim interior
    expect(mocks.postRaw).not.toHaveBeenCalled();
    expect(host.textContent).toContain('×1');
  });

  it('does not extend the snap radius to reach a visible tile farther than one tile away', async () => {
    await act(async () => bus.emit('battle:tap', { tx: 10, ty: -5, visibleTiles: ['10,-3'] }));
    expect(mocks.postRaw).not.toHaveBeenCalled();
    expect(host.textContent).toContain('×1');
  });

  it.each([[15, -7], [-34, 63], [63, -34], [10, 10]])(
    'submits empty SIM15 realm/claim tile (%s,%s) and reserves exactly one troop', async (tx, ty) => {
      const nextRaid = { ...raid, snapshot: { ...raid.snapshot, battlefieldVersion: 2 } };
      await act(async () => root.unmount());
      mocks.postRaw.mockImplementation((path: string) => path === '/raids'
        ? Promise.resolve({ raid: nextRaid }) : new Promise(() => {}));
      mocks.get.mockImplementation((path: string) => path.startsWith(`/raids/${raidId}/live`)
        ? Promise.resolve({ ...liveView(), snapshot: nextRaid.snapshot }) : Promise.reject(new Error(path)));
      root = createRoot(host);
      await act(async () => root.render(<RaidUI />));
      await flush();
      mocks.postRaw.mockClear();
      await act(async () => bus.emit('battle:tap', { tx, ty, previewVisible: () => true }));
      expect(mocks.postRaw).toHaveBeenCalledExactlyOnceWith(`/raids/${raidId}/commands`, {
        clientCommandId: 'stable-command-id',
        command: { kind: 'deploy', payload: { troop: 'highlander', tx, ty } },
      });
      expect(host.textContent).toContain('×0');
      expect(mocks.simulateRaid).not.toHaveBeenCalled();
    },
  );

  it.each([[5, 5], [6, 5], [5, 6], [6, 6]])('requires a clear v3square before snapping or consuming a troop (%s,%s)', async (tx, ty) => {
    const blockers = [
      { tx: -1, ty: -3, fw: 1, fh: 7 }, { tx: 1, ty: -3, fw: 1, fh: 7 },
      { tx: 4, ty: 4, fw: 4, fh: 1 }, { tx: 4, ty: 7, fw: 4, fh: 1 },
      { tx: 4, ty: 5, fw: 1, fh: 2 }, { tx: 7, ty: 5, fw: 1, fh: 2 },
    ];
    const nextRaid = { ...raid, snapshot: { ...raid.snapshot, battlefieldVersion: 3, deploymentBlockers: blockers } };
    await act(async () => root.unmount());
    mocks.postRaw.mockImplementation((path: string) => path === '/raids'
      ? Promise.resolve({ raid: nextRaid }) : new Promise(() => {}));
    mocks.get.mockImplementation((path: string) => path.startsWith(`/raids/${raidId}/live`)
      ? Promise.resolve({ ...liveView(), snapshot: nextRaid.snapshot }) : Promise.reject(new Error(path)));
    root = createRoot(host); await act(async () => root.render(<RaidUI />)); await flush(); mocks.postRaw.mockClear();
    const marks: unknown[] = []; const off = bus.on('battle:mark', (mark) => marks.push(mark));
    try {
      // All neighbors of this corridor tap are blocked or still one tile wide;
      // forgiving snapping must not turn it into an illegal server command.
      await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0, previewVisible: () => true }));
      expect(mocks.postRaw).not.toHaveBeenCalled(); expect(marks).toEqual([]); expect(host.textContent).toContain('×1');
      await act(async () => bus.emit('battle:tap', { tx, ty, previewVisible: () => true }));
      expect(mocks.postRaw).toHaveBeenCalledExactlyOnceWith(`/raids/${raidId}/commands`, {
        clientCommandId: 'stable-command-id', command: { kind: 'deploy', payload: { troop: 'highlander', tx, ty } },
      });
      expect(marks).toEqual([{ troop: 'highlander', tx, ty }]); expect(host.textContent).toContain('×0');
      expect(mocks.simulateRaid).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it('reserves the card and marks the tile at the tap, feeds the sim only once the server accepts', async () => {
    // WHY: a live tap used to change nothing on screen until its receipt came
    // back, so on a phone network the player re-tapped "because nothing
    // happened" and every extra tap was a real unit (teammate report
    // 2026-09-04: "3-4 Giants instead of two"). The count and the marker are
    // presentation; SIM input still waits for the accepted stream.
    let accept!: (value: unknown) => void;
    const commandResponse = new Promise((resolve) => { accept = resolve; });
    mocks.postRaw.mockImplementation((path: string) => {
      if (path.endsWith('/commands')) return commandResponse;
      if (path.endsWith('/finish')) return Promise.resolve({
        result: { stars: 0, destructionPct: 0, keepDestroyed: false, lootShards: 0, attackerTrophyDelta: -10 },
      });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    const marks: unknown[] = [];
    const offMark = bus.on('battle:mark', (mark) => { marks.push(mark); });

    expect(host.textContent).toContain('×1');
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    expect(mocks.postRaw).toHaveBeenCalledWith(`/raids/${raidId}/commands`, {
      clientCommandId: 'stable-command-id',
      command: { kind: 'deploy', payload: { troop: 'highlander', tx: 0, ty: 0 } },
    });
    expect(host.textContent, 'the tray count drops AT the tap').toContain('×0');
    expect(marks, 'the unit is visible on its tile before any receipt').toEqual([
      { troop: 'highlander', tx: 0, ty: 0 },
    ]);
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
    // The reservation is what stops a re-tap from queueing a second unit.
    await act(async () => bus.emit('battle:tap', { tx: 1, ty: 1 }));
    expect(mocks.postRaw).toHaveBeenCalledTimes(1);
    expect(marks).toHaveLength(1);
    offMark();

    accept({ command: {
      sequence: 0, clientCommandId: 'stable-command-id', kind: 'deploy',
      payload: { troop: 'highlander', tx: 0, ty: 0 }, serverOffsetMs: 0,
      acceptedAt: '2026-08-12T00:00:00.000Z',
    } });
    await flush();
    expect(host.textContent).toContain('×0');
    expect(mocks.simulateRaid).toHaveBeenCalledOnce();

    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(mocks.postRaw).toHaveBeenCalledWith(`/raids/${raidId}/finish`, {});
  });

  it('keeps a rejected troop available, takes its marker back and never feeds it into the local sim', async () => {
    mocks.postRaw.mockRejectedValue(new ApiError(422, 'not enough highlander'));
    const unmarks: unknown[] = [];
    const off = bus.on('battle:unmark', (mark) => { unmarks.push(mark); });
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await flush();
    off();
    expect(mocks.postRaw).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('×1');
    expect(host.textContent).toContain('NOT ENOUGH HIGHLANDER');
    // WHY: the optimistic marker is only truthful while the command can still
    // land. A definite rejection must remove exactly that marker, or a ghost
    // unit stays on the field for a deploy the server never fought.
    expect(unmarks).toEqual([{ troop: 'highlander', tx: 0, ty: 0 }]);
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
  });

  it('retries a potentially committed 500 with the exact same command id', async () => {
    const accepted = {
      sequence: 0, clientCommandId: 'stable-command-id', kind: 'deploy' as const,
      payload: { troop: 'highlander' as const, tx: 0, ty: 0 }, serverOffsetMs: 0,
      acceptedAt: '2026-08-12T00:00:00.000Z',
    };
    mocks.postRaw
      .mockRejectedValueOnce(new ApiError(500, 'response serialization failed'))
      .mockResolvedValueOnce({ command: accepted });

    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await flush();

    const commandCalls = mocks.postRaw.mock.calls.filter(([path]) => String(path).endsWith('/commands'));
    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[0]).toEqual(commandCalls[1]);
    expect(commandCalls[0]?.[1]).toMatchObject({ clientCommandId: 'stable-command-id' });
    expect(host.textContent).toContain('×0');
    expect(mocks.simulateRaid).toHaveBeenCalledOnce();
  });

  it('hydrates an ambiguously committed command by client id before releasing it', async () => {
    const accepted = {
      sequence: 0, clientCommandId: 'stable-command-id', kind: 'deploy' as const,
      payload: { troop: 'highlander' as const, tx: 0, ty: 0 }, serverOffsetMs: 350,
      acceptedAt: '2026-08-12T00:00:00.350Z',
    };
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidId}/live`)) return Promise.resolve(liveView([accepted]));
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.postRaw.mockRejectedValue(new ApiError(503, 'reply unavailable'));

    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await flush();

    const commandCalls = mocks.postRaw.mock.calls.filter(([path]) => String(path).endsWith('/commands'));
    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[0]).toEqual(commandCalls[1]);
    expect(mocks.get).toHaveBeenCalledWith(`/raids/${raidId}/live?afterSequence=-1`);
    expect(mocks.simulateRaid).toHaveBeenCalledWith(
      raid.snapshot,
      { deploys: [{ troop: 'highlander', tx: 0, ty: 0, tMs: 350 }], heroDeploys: [] },
      raid.seed,
      { troopLevels: raid.armySnapshot.levels },
    );
    expect(host.textContent).toContain('×0');
    expect(host.textContent).not.toContain('REPLY UNAVAILABLE');
  });

  it('checks the canonical id before treating a retry 422 as rejection', async () => {
    const accepted = {
      sequence: 0, clientCommandId: 'stable-command-id', kind: 'deploy' as const,
      payload: { troop: 'highlander' as const, tx: 0, ty: 0 }, serverOffsetMs: 80,
      acceptedAt: '2026-08-12T00:00:00.080Z',
    };
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidId}/live`)) return Promise.resolve(liveView([accepted]));
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.postRaw
      .mockRejectedValueOnce(new ApiError(500, 'first response lost after commit'))
      .mockRejectedValueOnce(new ApiError(422, 'raid already resolved'));

    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await flush();

    const commandCalls = mocks.postRaw.mock.calls.filter(([path]) => String(path).endsWith('/commands'));
    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[0]).toEqual(commandCalls[1]);
    expect(host.textContent).toContain('×0');
    expect(host.textContent).not.toContain('RAID ALREADY RESOLVED');
    expect(mocks.simulateRaid).toHaveBeenCalledOnce();
  });

  it('keeps the same command pending when the first canonical read has not caught up', async () => {
    const accepted = {
      sequence: 0, clientCommandId: 'stable-command-id', kind: 'deploy' as const,
      payload: { troop: 'highlander' as const, tx: 0, ty: 0 }, serverOffsetMs: 120,
      acceptedAt: '2026-08-12T00:00:00.120Z',
    };
    mocks.get.mockResolvedValue(liveView());
    mocks.postRaw
      .mockRejectedValueOnce(new ApiError(500, 'first reply failed'))
      .mockRejectedValueOnce(new ApiError(503, 'retry reply failed'))
      .mockResolvedValueOnce({ command: accepted });

    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_050)); });

    const commandCalls = mocks.postRaw.mock.calls.filter(([path]) => String(path).endsWith('/commands'));
    expect(commandCalls).toHaveLength(3);
    expect(commandCalls[1]).toEqual(commandCalls[0]);
    expect(commandCalls[2]).toEqual(commandCalls[0]);
    expect(mocks.idemKey).toHaveBeenCalledTimes(2); // create + one logical command
    expect(host.textContent).toContain('×0');
    expect(host.textContent).not.toContain('COMMAND STATUS UNKNOWN');
  });

  it('applies external canonical commands before releasing a definitely rejected tap', async () => {
    const external = {
      sequence: 0, clientCommandId: 'other-tab-command', kind: 'deploy' as const,
      payload: { troop: 'highlander' as const, tx: 1, ty: 1 }, serverOffsetMs: 80,
      acceptedAt: '2026-08-12T00:00:00.080Z',
    };
    mocks.get.mockImplementation((path: string) => {
      if (!path.startsWith(`/raids/${raidId}/live`)) {
        return Promise.reject(new Error(`unexpected GET ${path}`));
      }
      return Promise.resolve(liveView([external]));
    });
    mocks.postRaw
      .mockRejectedValueOnce(new ApiError(500, 'first reply failed'))
      .mockRejectedValueOnce(new ApiError(503, 'retry reply failed'))
      .mockRejectedValueOnce(new ApiError(422, 'not enough highlander'));

    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_050)); });

    const commandCalls = mocks.postRaw.mock.calls.filter(([path]) => String(path).endsWith('/commands'));
    expect(commandCalls).toHaveLength(3);
    expect(commandCalls[1]).toEqual(commandCalls[0]);
    expect(commandCalls[2]).toEqual(commandCalls[0]);
    expect(host.textContent).toContain('×0');
    expect(mocks.simulateRaid).toHaveBeenCalledWith(
      raid.snapshot,
      { deploys: [{ troop: 'highlander', tx: 1, ty: 1, tMs: 80 }], heroDeploys: [] },
      raid.seed,
      { troopLevels: raid.armySnapshot.levels },
    );
  });

  it('lets raid B command immediately and ignores raid A late rejection', async () => {
    const raidB = {
      ...raid,
      id: '00000000-0000-4000-8000-000000000004',
      defenderBaseId: '00000000-0000-4000-8000-000000000005',
    };
    let rejectRaidA!: (reason: unknown) => void;
    let nextCreate = raid;
    const raidAResponse = new Promise((_resolve, reject) => { rejectRaidA = reject; });
    mocks.postRaw.mockImplementation((path: string) => {
      if (path === '/raids') return Promise.resolve({ raid: nextCreate });
      if (path === `/raids/${raidId}/commands`) return raidAResponse;
      if (path === `/raids/${raidB.id}/commands`) return Promise.resolve({
        command: {
          sequence: 0, clientCommandId: 'stable-command-id', kind: 'deploy',
          payload: { troop: 'highlander', tx: 0, ty: 0 }, serverOffsetMs: 0,
          acceptedAt: '2026-08-12T00:00:00.000Z',
        },
      });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });

    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    expect(mocks.postRaw).toHaveBeenCalledWith(`/raids/${raidId}/commands`, expect.anything());

    const retreat = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('RETREAT'));
    expect(retreat).toBeDefined();
    await act(async () => retreat!.click());
    expect(host.textContent).toContain('Deployed troops and raid energy remain spent');
    const confirm = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'RETREAT');
    expect(confirm).toBeDefined();
    await act(async () => confirm!.click());

    nextCreate = raidB;
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidB.id}/live`)) return Promise.resolve(liveView());
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    await act(async () => useApp.setState({
      screen: 'battle',
      raidTarget: { kind: 'pvp', wallet: 'other-defender', defenderBaseId: raidB.defenderBaseId },
    }));
    await flush();

    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await flush();
    expect(mocks.postRaw).toHaveBeenCalledWith(`/raids/${raidB.id}/commands`, expect.anything());
    expect(host.textContent).toContain('×0');

    rejectRaidA(new ApiError(422, 'late A rejection'));
    await flush();
    expect(host.textContent).not.toContain('LATE A REJECTION');
    expect(host.textContent).toContain('×0');
  });

  it('gives a spectator an explicit reload control after worker failure without promising an automatic retry', async () => {
    await act(async () => root.unmount());
    mocks.simulateRaid.mockRejectedValue(new Error('worker delivery blocked'));
    mocks.get.mockImplementation((path: string) => path.startsWith(`/raids/${raidId}/live`)
      ? Promise.resolve(liveView([{ sequence: 0, clientCommandId: 'spectator-unit', kind: 'deploy',
        payload: { troop: 'highlander', tx: 0, ty: 0 }, serverOffsetMs: 0,
        acceptedAt: '2026-08-12T00:00:00.000Z' }])) : Promise.reject(new Error('unexpected GET')));
    useApp.setState({ screen: 'battle', raidTarget: { kind: 'live', raidId, replayBaseId: defenderBaseId } });
    root = createRoot(host);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    await act(async () => root.render(<RaidUI />)); await flush();
    expect(host.textContent).toContain('BATTLE DISPLAY UNAVAILABLE');
    expect(host.textContent).not.toContain('RETRYING');
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'RELOAD GAME')!;
    expect(button).toBeDefined(); expect(button.style.minHeight).toBe('44px');
    expect(mocks.postRaw).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
    await act(async () => button.click()); expect(reload).toHaveBeenCalledOnce();
  });

  it('spectates only the accepted v9 command prefix and hides loot until resolution', async () => {
    await act(async () => root.unmount());
    const accepted = {
      sequence: 0, clientCommandId: 'server-accepted', kind: 'deploy' as const,
      payload: { troop: 'highlander' as const, tx: 0, ty: 0 }, serverOffsetMs: 0,
      acceptedAt: '2026-08-12T00:00:00.000Z',
    };
    mocks.simulateRaid.mockClear();
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidId}/live`)) {
        return Promise.resolve({ ...liveView([accepted]), result: { lootShards: 777_777 } });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    useApp.setState({
      screen: 'battle',
      raidTarget: { kind: 'live', raidId, replayBaseId: defenderBaseId },
    });
    root = createRoot(host);
    await act(async () => root.render(<RaidUI />));
    await flush();

    expect(mocks.simulateRaid).toHaveBeenCalledWith(
      raid.snapshot,
      {
        deploys: [{ troop: 'highlander', tx: 0, ty: 0, tMs: 0 }],
        heroDeploys: [],
      },
      raid.seed,
      { troopLevels: raid.armySnapshot.levels },
    );
    // Hidden live loot stays hidden even after the player expands statistics.
    await act(async () => host.querySelector<HTMLElement>('[aria-label="Battle details"]')!.click());
    expect(host.textContent).toContain('+0');
    expect(host.textContent).not.toContain('777,777');
    expect(mocks.get.mock.calls.some(([path]) => String(path).includes('/battles/'))).toBe(false);
  });
});

describe('protocol-2 stable PvP attacker and defender clocks', () => {
  const startedAtMs = Date.parse('2026-09-04T12:00:00.000Z');
  const durationMs = RAID_RULES.battleDurationSec * 1_000;
  const verdict = {
    stars: 1, destructionPct: 52, keepDestroyed: false,
    lootShards: 777, attackerTrophyDelta: 5,
  };
  const events = [
    { t: 0, e: 'deploy', id: 1, troop: 'highlander', x: 0, y: 0 },
    { t: 600, e: 'destroyed', id: 'keep' },
  ];
  let host: HTMLDivElement;
  let root: Root;

  function clock(rate: 1 | 2 = 1, revision = 0, anchorWallAt: string | null = null, anchorSimMs = 0): LiveRaidClock {
    const anchorMs = anchorWallAt === null ? null : Date.parse(anchorWallAt);
    return {
      protocolVersion: 2, revision, rate, anchorWallAt, anchorSimMs,
      serverNow: new Date().toISOString(), durationMs,
      simNowMs: anchorMs === null ? 0 : Math.min(durationMs, anchorSimMs + Math.max(0, Date.now() - anchorMs) * rate),
      battleEndsAt: anchorMs === null ? null
        : new Date(anchorMs + Math.ceil((durationMs - anchorSimMs) / rate)).toISOString(),
    };
  }

  function serveV2() {
    const currentRaid = {
      ...raid, raidProtocolVersion: 2 as const,
      armySnapshot: { ...raid.armySnapshot, counts: { highlander: 3 } },
      ordersDeadlineAt: new Date(startedAtMs + durationMs + RAID_RULES.deployWindowSec * 1_000).toISOString(),
    };
    const server = {
      clock: clock(),
      lastReadClock: null as LiveRaidClock | null,
      commands: [] as LiveCommand[],
      status: 'pending_orders',
      currentClock(): LiveRaidClock {
        return clock(this.clock.rate, this.clock.revision, this.clock.anchorWallAt, this.clock.anchorSimMs);
      },
      deploy(clientCommandId: string, tx: number, ty: number) {
        if (this.clock.anchorWallAt === null) {
          this.clock = clock(1, 1, new Date().toISOString());
        }
        const current = this.currentClock();
        const command: LiveCommand = {
          sequence: this.commands.length, clientCommandId, kind: 'deploy',
          payload: { troop: 'highlander', tx, ty },
          serverOffsetMs: current.simNowMs, acceptedAt: new Date().toISOString(),
        };
        this.commands.push(command);
        return { command, clock: current };
      },
      speed(clientCommandId: string, rate: 1 | 2) {
        const before = this.currentClock();
        this.clock = clock(rate, before.revision + 1, new Date().toISOString(), before.simNowMs);
        const command: LiveCommand = {
          sequence: this.commands.length, clientCommandId, kind: 'speed',
          payload: { expectedClockRevision: before.revision, rate },
          serverOffsetMs: before.simNowMs, acceptedAt: new Date().toISOString(),
        };
        this.commands.push(command);
        return { command, clock: this.currentClock() };
      },
    };
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidId}/live?afterSequence=`)) {
        const current = server.currentClock();
        server.lastReadClock = current;
        const afterSequence = Number(path.split('afterSequence=')[1]);
        return Promise.resolve({
          ...liveView(server.commands.filter((row) => row.sequence > afterSequence)),
          protocolVersion: 2, clock: current, armySnapshot: currentRaid.armySnapshot,
          startedAt: current.anchorWallAt, battleEndsAt: current.battleEndsAt,
          lastSequence: server.commands.length - 1, status: server.status,
        });
      }
      if (path === `/bases/${defenderBaseId}/battles/${raidId}/replay`
        || path === `/bases/${attackerBaseId}/battles/${raidId}/replay`) {
        return Promise.resolve({
          result: verdict, snapshot: currentRaid.snapshot,
          armySnapshot: currentRaid.armySnapshot, simVersion: SIM_VERSION, events,
        });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.postRaw.mockImplementation((path: string, body: {
      clientCommandId: string; expectedClockRevision?: number; rate?: 1 | 2;
      command?: { kind: string; payload: { tx: number; ty: number } };
    }) => {
      if (path === '/raids') return Promise.resolve({ raid: {
        ...currentRaid, live: { startedAt: null, clock: server.currentClock() },
      } });
      if (path === `/raids/${raidId}/commands` && body.command?.kind === 'deploy') {
        return Promise.resolve(server.deploy(body.clientCommandId, body.command.payload.tx, body.command.payload.ty));
      }
      if (path === `/raids/${raidId}/speed` && body.rate) {
        expect(body.expectedClockRevision).toBe(server.clock.revision);
        return Promise.resolve(server.speed(body.clientCommandId, body.rate));
      }
      if (path === `/raids/${raidId}/finish`) {
        server.status = 'resolved';
        return Promise.resolve({ result: verdict });
      }
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    return server;
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    }
  }
  async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }
  async function render(): Promise<void> {
    await act(async () => root.render(<RaidUI />));
    await settle();
  }
  function speedControl(): HTMLElement | undefined {
    return [...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => /^[12]×$/.test(node.textContent ?? ''));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startedAtMs);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    mocks.get.mockReset(); mocks.post.mockReset(); mocks.postRaw.mockReset();
    mocks.simulateRaid.mockReset().mockReturnValue({
      events, stars: 1, destructionPct: 52, keepDestroyed: false,
    });
    let sequence = 0;
    mocks.idemKey.mockReset().mockImplementation(() => `v2-command-${++sequence}`);
    useApp.setState({
      screen: 'battle', baseDirectory: directory, selectedBaseId: attackerBaseId,
      base, raidTarget: { kind: 'pvp', wallet: 'defender-wallet', defenderBaseId },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useApp.setState({ screen: 'base', raidTarget: null, baseDirectory: null });
    vi.useRealTimers();
  });

  it('starts stable PvP at the first accepted unit in 1x, then stamps an accepted 2x reserve canonically', async () => {
    const server = serveV2();
    const ordinaryPost = mocks.postRaw.getMockImplementation()!;
    let acceptFirst!: () => void;
    let first = true;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path.endsWith('/commands') && first) {
        first = false;
        return new Promise((resolve) => { acceptFirst = () => resolve(ordinaryPost(path, body)); });
      }
      return ordinaryPost(path, body);
    });
    await render();
    expect(mocks.postRaw).toHaveBeenCalledWith('/raids', expect.objectContaining({
      raidProtocolVersion: 2, attackerBaseId, defenderBaseId,
    }));
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await settle();
    expect(server.clock.anchorWallAt).toBeNull();
    // The tap reserves its card at once (the player must see what a slow
    // receipt already owes them); only the canonical clock and the simulator
    // wait for acceptance.
    expect(host.textContent).toContain('×2');
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
    acceptFirst();
    await settle();
    expect(server.clock).toMatchObject({ rate: 1, revision: 1, anchorWallAt: new Date(startedAtMs).toISOString() });
    expect(host.textContent).toContain('×2');
    expect(speedControl()?.textContent).toBe('1×');
    expect(mocks.postRaw.mock.calls.some(([path]) => String(path).endsWith('/start'))).toBe(false);
    await advance(1_000);
    await act(async () => speedControl()!.click());
    await settle();
    expect(speedControl()?.textContent).toBe('2×');
    expect(server.clock).toMatchObject({ rate: 2, revision: 2, anchorSimMs: 1_000 });
    await advance(750);
    await act(async () => bus.emit('battle:tap', { tx: 1, ty: 1 }));
    await settle();
    const writes = mocks.postRaw.mock.calls.filter(([path]) => String(path).endsWith('/commands'));
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1]).toMatchObject({ command: {
      kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 },
    } });
    expect(writes[1]?.[1].command.payload).not.toHaveProperty('tMs');
    expect(server.commands.at(-1)?.serverOffsetMs).toBe(2_500);
    expect(mocks.simulateRaid.mock.calls.at(-1)?.[1]).toMatchObject({ deploys: [
      { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
      { troop: 'highlander', tx: 1, ty: 1, tMs: 2_500 },
    ] });
    expect(host.textContent).toContain('×1');
    expect(mocks.postRaw.mock.calls.filter(([path]) => String(path).endsWith('/finish'))).toHaveLength(0);
  });

  it('keeps polling while a spectator worker is delayed and resumes at the latest 2x clock', async () => {
    const server = serveV2();
    server.deploy('attacker-first', 0, 0);
    server.speed('attacker-speed-2', 2);
    let finish!: (value: unknown) => void;
    mocks.simulateRaid.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    useApp.setState({ raidTarget: { kind: 'live', raidId, replayBaseId: defenderBaseId } });
    const plays: Array<{ fromTick?: number }> = [];
    const off = bus.on('battle:play', (payload) => plays.push(payload));
    try {
      await render();
      expect(host.textContent).toContain('CATCHING UP');
      expect(host.textContent).not.toContain('ATTACKER IS PREPARING');
      await advance(2_001);
      expect(mocks.get.mock.calls.filter(([path]) => String(path).includes('/live?'))).toHaveLength(3);
      expect(mocks.simulateRaid, 'clock-only reads must not starve the same calculation').toHaveBeenCalledOnce();
      await act(async () => finish({ events, ...verdict })); await settle(); await advance(1);
      expect(plays.at(-1)?.fromTick).toBe(40);
      expect(host.textContent).not.toContain('CATCHING UP');
      expect(mocks.postRaw).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it('keeps the v2 defender read-only while following attacker rate, reserves and canonical terminal replay', async () => {
    const server = serveV2();
    useApp.setState({ raidTarget: { kind: 'live', raidId, replayBaseId: defenderBaseId } });
    const rates: number[] = [];
    const plays: Array<{ fromTick?: number; events: Array<{ t: number; e: string }> }> = [];
    const offRate = bus.on('battle:rate', ({ rate }) => rates.push(rate));
    const offPlay = bus.on('battle:play', (payload) => plays.push(payload));
    try {
      await render();
      expect(host.textContent).toContain('ATTACKER IS PREPARING');
      expect(speedControl()).toBeUndefined();
      server.deploy('attacker-first', 0, 0);
      // Include the nested zero-delay playback publish after the polling tick.
      await advance(1_001);
      expect(host.textContent).not.toContain('ATTACKER IS PREPARING');
      expect(rates.at(-1)).toBe(1);
      expect(plays.at(-1)?.fromTick).toBe(10);
      server.speed('attacker-speed-2', 2);
      await advance(1_000);
      expect(rates.at(-1)).toBe(2);
      expect(host.textContent).toContain('2×');
      expect(speedControl()).toBeUndefined();
      expect(plays.at(-1)?.fromTick).toBe(Math.floor(server.lastReadClock!.simNowMs / 100));
      const reserveOffset = server.currentClock().simNowMs;
      server.deploy('attacker-reserve', 1, 1);
      await advance(1_000);
      expect(mocks.simulateRaid.mock.calls.at(-1)?.[1]).toMatchObject({ deploys: [
        { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: reserveOffset },
      ] });
      await act(async () => bus.emit('battle:tap', { tx: 2, ty: 2 }));
      await act(async () => bus.emit('battle:done', undefined));
      expect(host.textContent).not.toContain('LIVE BATTLE SETTLED');
      expect(host.textContent).not.toContain('+777');
      server.speed('attacker-speed-1', 1);
      await advance(1_000);
      expect(rates.at(-1)).toBe(1);
      expect(host.textContent).toContain('1×');
      expect(speedControl()).toBeUndefined();
      server.clock = clock(1, server.clock.revision, new Date().toISOString(), durationMs);
      server.status = 'resolved';
      await advance(1_000);
      expect(mocks.get).toHaveBeenCalledWith(`/bases/${defenderBaseId}/battles/${raidId}/replay`);
      expect(plays.at(-1)).toMatchObject({ events, fromTick: durationMs / 100 });
      await act(async () => bus.emit('battle:done', undefined));
      await settle();
      expect(host.textContent).toContain('LIVE BATTLE SETTLED');
      expect(host.textContent).toContain('52%');
      expect(host.textContent).not.toContain('VICTORY');
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.postRaw, 'a defender never creates, starts, changes speed, deploys or finishes the attacker raid').not.toHaveBeenCalled();
    } finally { offRate(); offPlay(); }
  });
});

/**
 * The teammate report (2026-09-04, on a phone): "you want to deploy two Bowmen
 * and a Giant, it glitches and doesn't immediately give your army, and by the
 * time it responds you have 3-4 Giant deployed instead of two." A live raid
 * serialises one POST per tap and, before this block, showed NOTHING until each
 * receipt returned — so every impatient re-tap was a real unit. These tests
 * simulate that slow network: taps land while earlier commands are in flight,
 * and the selection changes before any receipt arrives.
 */
describe('live raid deploy feedback under a slow round-trip', () => {
  let host: HTMLDivElement;
  let root: Root;
  const army = { ...raid, armySnapshot: { counts: { bowman: 2, giant: 3 }, levels: { bowman: 1, giant: 1 }, heroes: [] } };
  type Write = { clientCommandId: string; command: { kind: string; payload: Record<string, unknown> } };
  const marks: Array<{ troop: string; tx: number; ty: number }> = [];
  const unmarks: Array<{ troop: string; tx: number; ty: number }> = [];
  let offMark = (): void => undefined;
  let offUnmark = (): void => undefined;
  /** One resolver per command POST, in send order, so a test controls the acks. */
  let pendingReceipts: Array<{ body: Write; accept: (sequence: number) => void; reject: (cause: unknown) => void }> = [];

  const card = (label: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="raid-troop-card"]')]
      .find((b) => b.getAttribute('aria-label')?.startsWith(`${label},`));
    expect(found, `${label} card`).toBeDefined();
    return found!;
  };
  const remaining = (label: string): number =>
    Number(/, (\d+) remaining/.exec(card(label).getAttribute('aria-label') ?? '')?.[1]);
  const commandPosts = (): Write[] => mocks.postRaw.mock.calls
    .filter(([path]) => String(path).endsWith('/commands'))
    .map(([, body]) => body as Write);
  const accepted = (body: Write, sequence: number) => ({
    sequence, clientCommandId: body.clientCommandId, kind: body.command.kind,
    payload: body.command.payload, serverOffsetMs: 0, acceptedAt: '2026-08-12T00:00:00.000Z',
  });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    mocks.get.mockReset(); mocks.post.mockReset(); mocks.postRaw.mockReset();
    mocks.simulateRaid.mockReset();
    let keys = 0;
    mocks.idemKey.mockReset().mockImplementation(() => `tap-${++keys}`);
    pendingReceipts = [];
    marks.length = 0; unmarks.length = 0;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/raids') return Promise.resolve({ raid: army });
      if (path.endsWith('/commands')) {
        return new Promise((resolve, reject) => {
          const write = body as Write;
          pendingReceipts.push({
            body: write,
            accept: (sequence) => resolve({ command: accepted(write, sequence) }),
            reject,
          });
        });
      }
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidId}/live`)) return Promise.resolve({ ...liveView(), armySnapshot: army.armySnapshot });
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.simulateRaid.mockReturnValue({
      events: [{ t: 0, e: 'deploy', id: 1, troop: 'bowman', x: 0, y: 0 }],
      stars: 0, destructionPct: 0, keepDestroyed: false,
    });
    useApp.setState({
      screen: 'battle', baseDirectory: directory, selectedBaseId: attackerBaseId,
      base, raidTarget: { kind: 'pvp', wallet: 'defender-wallet', defenderBaseId },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    offMark = bus.on('battle:mark', (mark) => { marks.push(mark); });
    offUnmark = bus.on('battle:unmark', (mark) => { unmarks.push(mark); });
    await act(async () => root.render(<RaidUI />));
    await flush();
    mocks.postRaw.mockClear();
  });

  afterEach(async () => {
    offMark(); offUnmark();
    await act(async () => root.unmount());
    host.remove();
    useApp.setState({ screen: 'base', raidTarget: null, baseDirectory: null });
  });

  it('shows every quick tap on the card and the field while the first command is still in flight', async () => {
    // (i) two taps on one troop before any receipt: the second must not wait
    // for the first to be visible, and neither may pile up invisibly.
    await act(async () => { card('BOWMAN').click(); });
    expect(remaining('BOWMAN')).toBe(2);
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    expect(remaining('BOWMAN'), 'the first tap is reserved before its receipt').toBe(1);
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 1 }));
    expect(remaining('BOWMAN'), 'the second tap is reserved while the first is in flight').toBe(0);
    expect(marks).toEqual([{ troop: 'bowman', tx: 0, ty: 0 }, { troop: 'bowman', tx: 0, ty: 1 }]);
    // The queue is serial: one POST out, one waiting behind it.
    expect(commandPosts()).toHaveLength(1);
    // A third tap cannot exceed what the card shows — nothing is queued for it.
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 2 }));
    expect(marks).toHaveLength(2);

    pendingReceipts[0]!.accept(0);
    await flush();
    expect(commandPosts()).toHaveLength(2);
    pendingReceipts[1]!.accept(1);
    await flush();
    // Exactly the two intentional taps reach the simulator, in tap order.
    expect(mocks.simulateRaid).toHaveBeenLastCalledWith(
      raid.snapshot,
      { deploys: [
        { troop: 'bowman', tx: 0, ty: 0, tMs: 0 },
        { troop: 'bowman', tx: 0, ty: 1, tMs: 0 },
      ], heroDeploys: [] },
      raid.seed,
      { troopLevels: army.armySnapshot.levels },
    );
    expect(remaining('BOWMAN')).toBe(0);
    expect(unmarks).toEqual([]);
  });

  it('commits the troop selected AT each tap when the selection changes before any receipt', async () => {
    // (iv) Bowman, tap, tap, switch to Giant, tap — all before the first ack.
    // The report's "3-4 Giants instead of two" is exactly what a late-bound
    // selection or an invisible queue would produce; each tap must bind to
    // what the player had selected when the finger landed.
    await act(async () => { card('BOWMAN').click(); });
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 1 }));
    await act(async () => { card('GIANT').click(); });
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 2 }));
    expect(remaining('BOWMAN')).toBe(0);
    expect(remaining('GIANT')).toBe(2);
    expect(marks).toEqual([
      { troop: 'bowman', tx: 0, ty: 0 }, { troop: 'bowman', tx: 0, ty: 1 }, { troop: 'giant', tx: 0, ty: 2 },
    ]);

    for (let sequence = 0; sequence < 3; sequence++) {
      expect(pendingReceipts, `command ${sequence} is sent behind its predecessor`).toHaveLength(sequence + 1);
      pendingReceipts[sequence]!.accept(sequence);
      await flush();
    }
    expect(commandPosts().map((write) => write.command.payload)).toEqual([
      { troop: 'bowman', tx: 0, ty: 0 }, { troop: 'bowman', tx: 0, ty: 1 }, { troop: 'giant', tx: 0, ty: 2 },
    ]);
    expect(new Set(commandPosts().map((write) => write.clientCommandId)).size, 'one idempotent id per tap').toBe(3);
    expect(mocks.simulateRaid).toHaveBeenLastCalledWith(
      raid.snapshot,
      expect.objectContaining({ deploys: [
        { troop: 'bowman', tx: 0, ty: 0, tMs: 0 },
        { troop: 'bowman', tx: 0, ty: 1, tMs: 0 },
        { troop: 'giant', tx: 0, ty: 2, tMs: 0 },
      ] }),
      raid.seed,
      expect.anything(),
    );
    expect(remaining('BOWMAN')).toBe(0);
    expect(remaining('GIANT')).toBe(2);
  });

  it.each([false, true])('explains a rejected tap during battle without blocking settlement (reconciling=%s)', async (reconciling) => {
    const toasts: unknown[] = []; const offToast = bus.on('ui:toast', event => toasts.push(event));
    try {
      mocks.simulateRaid.mockReturnValue({
        events: [{ t: 0, e: 'deploy', id: 1, troop: 'giant', x: 0, y: 0 }],
        stars: 3, destructionPct: 100, keepDestroyed: true,
      });
      await act(async () => { card('GIANT').click(); });
      await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
      await act(async () => bus.emit('battle:tap', { tx: 0, ty: 1 }));
      expect(remaining('GIANT')).toBe(1);
      pendingReceipts[0]!.accept(0);
      await flush();
      if (reconciling) {
        pendingReceipts[1]!.reject(new ApiError(500, 'first reply lost'));
        await flush();
        pendingReceipts[2]!.reject(new ApiError(503, 'retry reply unavailable'));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_050)); });
      }
      pendingReceipts[reconciling ? 3 : 1]!.reject(new ApiError(422, 'not enough giant in camp'));
      await flush();
      expect(remaining('GIANT'), 'one accepted, one handed back').toBe(2);
      expect(unmarks, 'only the rejected tile loses its marker').toEqual([{ troop: 'giant', tx: 0, ty: 1 }]);
      // The battle is running, so the pre-battle inline error is absent. A
      // visible explanation must accompany rollback without posting another drop.
      expect(toasts).toEqual([{ msg: 'NOT ENOUGH GIANT IN CAMP' }]);
      const expectedAttempts = reconciling ? 4 : 2;
      expect(commandPosts()).toHaveLength(expectedAttempts);
      expect(new Set(commandPosts().map(write => write.clientCommandId)).size,
        'reconciliation retries the same drop; rejection creates no replacement order').toBe(2);
      expect(host.textContent).not.toContain('GIANT×3');
      expect(mocks.simulateRaid).toHaveBeenLastCalledWith(
        raid.snapshot,
        expect.objectContaining({ deploys: [{ troop: 'giant', tx: 0, ty: 0, tMs: 0 }] }),
        raid.seed,
        expect.anything(),
      );
      let resolveFinish!: (value: unknown) => void;
      mocks.postRaw.mockImplementation((path: string) => path.endsWith('/finish')
        ? new Promise(resolve => { resolveFinish = resolve; })
        : Promise.reject(new Error(`unexpected POST ${path}`)));
      await act(async () => bus.emit('battle:done', undefined));
      await flush();
      expect(host.textContent, 'a rejected troop is not a settlement failure').toContain('RESOLVING RAID');
      resolveFinish({ result: { stars: 2, destructionPct: 71, keepDestroyed: true, lootShards: 0, attackerTrophyDelta: 0 } });
      await flush();
      expect(host.textContent).toContain('VICTORY');
      expect(mocks.postRaw.mock.calls.filter(([path]) => String(path).endsWith('/finish'))).toHaveLength(1);
      expect(commandPosts()).toHaveLength(expectedAttempts);
      expect(toasts).toHaveLength(1);
    } finally { offToast(); }
  });
});
