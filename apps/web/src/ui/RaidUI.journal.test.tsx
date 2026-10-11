/** @vitest-environment happy-dom */
import { act } from 'react';
import { ApiError } from '../lib/api';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RAID_RULES } from '@shardkeep/shared';
import { fmtT } from './primitives';
import { SIM_VERSION } from '@shardkeep/sim';
import { bus } from '../lib/events';
import { clearRaidResumePointer, readRaidResumePointer } from '../lib/raidResume';
import { useApp, type BaseStateDto } from '../state/store';
import { createPanelSession, type PanelDismissRequest } from './pk/panelSession';
import { recoverBaseAuthority } from '../state/baseAuthorityRecovery';

/**
 * D-099 "raids finish without the client". A batch raid (PvE, campaign, legacy
 * PvP) used to keep every order in this component's memory until ONE POST at
 * the wall-clock battle end, so a closed tab, a crash or a reload lost the raid:
 * expired, refunded, nothing recorded. A server that advertises
 * `features.batchCommandJournal` now receives each order AS IT IS PLACED,
 * stamped with the client's own battle offset, and settles that journal itself
 * at the deadline when FINISH never arrives. These tests pin the client half:
 * what is journaled, when, at which offset; that FINISH replaces the whole-list
 * POST and waits for the journal; that a reload rebuilds the field from the
 * journal; and that an API without the capability keeps the old path.
 */
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postRaw: vi.fn(),
  simulateRaid: vi.fn(),
  disposeSimulation: vi.fn(),
  idemKey: vi.fn(),
  purchase: vi.fn(),
}));

vi.mock('@shardkeep/sim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shardkeep/sim')>();
  return { ...actual, simulateRaid: mocks.simulateRaid };
});
vi.mock('./raidSimulation', () => ({ RaidSimulationService: class {
  async simulate(input: import('./raidSimulation').RaidSimulationInput) {
    return mocks.simulateRaid(input.snapshot, input.orders, input.seed, input.options);
  }
  dispose() { mocks.disposeSimulation(); }
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
  useSolPurchase: () => ({ purchase: mocks.purchase, phase: 'idle', error: null }),
}));
vi.mock('../state/baseSnapshot', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/audio', () => ({ playSfx: vi.fn(), stopAllLoops: vi.fn() }));
vi.mock('../lib/juice', () => ({ haptic: vi.fn() }));

import { RaidUI } from './RaidUI';
import frozenGearRaid from './__fixtures__/stage100-frozen-raid.json';

const attackerBaseId = '00000000-0000-4000-8000-000000000001';
const raidId = '00000000-0000-4000-8000-000000000003';
/** Frozen wall clock: every offset below is exact arithmetic on it. */
const T0 = Date.parse('2026-09-02T12:00:00.000Z');
/** Sim playback clock — mirrors RaidUI/BattleScene TICK_MS. */
const TICK_MS = 100;
/** The local stream's last tick decides the battle end the wall-clock commit is
 *  scheduled from: (maxTick − fromTick + 10) ticks. */
const MAX_TICK = 40;
const BATTLE_END_MS = (MAX_TICK + 10) * TICK_MS;
const localEvents = [
  { t: 0, e: 'deploy', id: 1, troop: 'highlander', x: 0, y: 0 },
  { t: MAX_TICK, e: 'destroyed', id: 'keep' },
];
const won = { stars: 2, destructionPct: 71, keepDestroyed: true, lootShards: 0, attackerTrophyDelta: 0 };
const journalFeatures = {
  batchOrdersGraceSec: RAID_RULES.batchOrdersGraceSec,
  batchCommandJournal: true,
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

/** A campaign raid is the BATCH path; the frozen feature decides whether this
 *  client journals it or posts the whole list once. */
function campaignRaid(
  features: Record<string, unknown> = journalFeatures,
  counts: Record<string, number> = { highlander: 3 },
) {
  return {
    id: raidId,
    attackerBaseId,
    defenderBaseId: null,
    defenderWallet: 'campaign',
    pveCampId: null,
    campaignStage: 1,
    snapshot: { buildings: [], claimMin: 4, claimMax: 18 },
    armySnapshot: {
      counts, levels: Object.fromEntries(Object.keys(counts).map((troop) => [troop, 1])), heroes: [], features,
    },
    ordersDeadlineAt: new Date(T0 + 10 * 60_000).toISOString(),
    seed: 7,
    simVersion: SIM_VERSION,
  };
}

type JournalWrite = { clientCommandId: string; command: { kind: string; payload: Record<string, unknown> } };

/** The server's acknowledgement of a journal write: the same payload back,
 *  sequenced, with the client offset echoed as the stamp. */
function accepted(body: JournalWrite, sequence: number) {
  return {
    sequence,
    clientCommandId: body.clientCommandId,
    kind: body.command.kind,
    payload: body.command.payload,
    serverOffsetMs: Number(body.command.payload['tMs'] ?? 0),
    acceptedAt: new Date().toISOString(),
  };
}

/** A row already in the server journal when this client reloads. */
function journaled(
  sequence: number, payload: { troop: 'highlander'; tx: number; ty: number; tMs: number }, acceptedAtMs: number,
) {
  return {
    sequence, clientCommandId: `earlier-${sequence}`, kind: 'deploy' as const, payload,
    serverOffsetMs: payload.tMs, acceptedAt: new Date(acceptedAtMs).toISOString(),
  };
}

function liveView(commands: unknown[]) {
  return {
    protocolVersion: 1,
    startedAt: commands.length ? new Date(T0 - 60_000).toISOString() : null,
    battleEndsAt: commands.length ? new Date(T0 + 70_000).toISOString() : null,
    streamClosedAt: null,
    lastSequence: commands.length - 1,
    snapshot: campaignRaid().snapshot,
    armySnapshot: campaignRaid().armySnapshot,
    seed: 7,
    simVersion: SIM_VERSION,
    status: 'pending_orders',
    commands,
    hasMore: false,
  };
}

function v2Clock(rate: 1 | 2 = 1, revision = 0, anchorWallAt: string | null = null, anchorSimMs = 0) {
  const wallMs = anchorWallAt === null ? null : Date.parse(anchorWallAt);
  return {
    protocolVersion: 2 as const, revision, rate, anchorWallAt, anchorSimMs,
    serverNow: new Date().toISOString(),
    simNowMs: wallMs === null ? 0 : Math.min(90_000, anchorSimMs + Math.max(0, Date.now() - wallMs) * rate),
    battleEndsAt: wallMs === null ? null : new Date(wallMs + Math.ceil((90_000 - anchorSimMs) / rate)).toISOString(),
    durationMs: 90_000,
  };
}

const postsTo = (suffix: string): unknown[][] => mocks.postRaw.mock.calls
  .filter(([path]) => String(path) === `/raids/${raidId}/${suffix}`);
const commandPosts = (): JournalWrite[] => postsTo('commands').map(([, body]) => body as JournalWrite);

/** Let the fake clock hand out due timers and let promise chains settle. A
 *  journal write is a queued promise chain: three passes cover the queue hop,
 *  the mocked api and the state update its `.then` performs. */
async function flush(): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('batch raid journal client (D-099)', () => {
  let host: HTMLDivElement;
  let root: Root;

  /** Default server: create, accept every journal write in order, settle FINISH. */
  function serveJournal(): void {
    let sequence = 0;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid() });
      if (path === `/raids/${raidId}/commands`) {
        return Promise.resolve({ command: accepted(body as JournalWrite, sequence++) });
      }
      if (path === `/raids/${raidId}/finish`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
  }
  function serveV2Journal() {
    const server = {
      clock: v2Clock(),
      status: 'pending_orders',
      commands: [] as ReturnType<typeof accepted>[],
      currentClock() {
        const { rate, revision, anchorWallAt, anchorSimMs } = this.clock;
        return v2Clock(rate, revision, anchorWallAt, anchorSimMs);
      },
      view(afterSequence = -1) {
        const clock = this.currentClock();
        return {
          ...liveView(this.commands.filter((row) => row.sequence > afterSequence)),
          protocolVersion: 2, clock, status: this.status,
          startedAt: clock.anchorWallAt, battleEndsAt: clock.battleEndsAt,
          lastSequence: this.commands.length - 1,
        };
      },
    };
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidId}/live?afterSequence=`)) {
        return Promise.resolve(server.view(Number(path.split('afterSequence=')[1])));
      }
      if (path === `/bases/${attackerBaseId}/battles/${raidId}/replay`) {
        return Promise.resolve({ result: won, simVersion: SIM_VERSION, events: localEvents });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.postRaw.mockImplementation((path: string, body: JournalWrite & { rate?: 1 | 2 }) => {
      if (path === '/campaign/1/raid') return Promise.resolve({
        raid: { ...campaignRaid(), raidProtocolVersion: 2, live: { clock: server.currentClock(), startedAt: null } },
      });
      if (path === `/raids/${raidId}/finish`) return Promise.resolve({ result: won });
      const control = path === `/raids/${raidId}/start` ? 'start'
        : path === `/raids/${raidId}/speed` ? 'speed' : null;
      if (control || path === `/raids/${raidId}/commands`) {
        const before = server.currentClock();
        const command = {
          ...accepted(control ? { ...body, command: { kind: control, payload: {} } } : body, server.commands.length),
          serverOffsetMs: before.simNowMs,
        };
        server.commands.push(command);
        if (control) server.clock = v2Clock(body.rate ?? 1, before.revision + 1, new Date().toISOString(), before.simNowMs);
        return Promise.resolve({ command, clock: server.currentClock() });
      }
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    return server;
  }
  async function render(): Promise<void> {
    await act(async () => root.render(<RaidUI />));
    await flush();
  }
  function RaidScreenLifetime(): React.JSX.Element {
    const screen = useApp((state) => state.screen);
    return <RaidUI key={screen === 'battle' ? 'battle' : 'idle'} />;
  }
  async function tap(tx: number, ty: number): Promise<void> {
    await act(async () => bus.emit('battle:tap', { tx, ty }));
    await flush();
  }
  function button(label: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  }
  async function attack(): Promise<void> {
    const b = button('ATTACK');
    expect(b).toBeDefined();
    await act(async () => b!.click());
    await flush();
  }
  async function confirmRetreat(): Promise<void> {
    await act(async () => button('RETREAT')!.click());
    const confirm = [...host.querySelectorAll('[role="alertdialog"] button')]
      .find((b) => b.textContent === 'RETREAT') as HTMLButtonElement;
    expect(confirm).toBeDefined();
    await act(async () => confirm.click());
    await flush();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    mocks.get.mockReset(); mocks.post.mockReset(); mocks.postRaw.mockReset(); mocks.purchase.mockReset();
    mocks.simulateRaid.mockReset(); mocks.disposeSimulation.mockReset();
    let keys = 0;
    mocks.idemKey.mockReset().mockImplementation(() => `key-${++keys}`);
    mocks.get.mockRejectedValue(new Error('unexpected GET'));
    mocks.simulateRaid.mockReturnValue({
      events: localEvents, stars: won.stars, destructionPct: won.destructionPct, keepDestroyed: true,
    });
    serveJournal();
    useApp.setState({
      screen: 'battle', baseDirectory: null, selectedBaseId: attackerBaseId,
      base, raidTarget: { kind: 'campaign', stage: 1 },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useApp.setState({ screen: 'base', raidTarget: null, baseDirectory: null });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function serveNextTarget() {
    const server = serveV2Journal();
    const defaultPost = mocks.postRaw.getMockImplementation()!;
    const defenderBaseId = '00000000-0000-4000-8000-000000000002';
    const pvp = { ...campaignRaid(), armySnapshot: { ...campaignRaid().armySnapshot, heroes: ['vex'] },
      campaignStage: null, defenderBaseId,
      defenderWallet: 'defender', raidProtocolVersion: 2,
      live: { clock: server.currentClock(), startedAt: null } };
    useApp.setState({ raidTarget: null, baseDirectory: {
      enabled: true, maxActive: 5, nextLandPurchaseKind: 'deed', bases: [],
      capabilities: { baseScopedReads: true, baseScopedMutations: true, cellReservations: true },
    } });
    mocks.postRaw.mockImplementation((path: string, body: unknown) => path === '/raids'
      ? Promise.resolve({ raid: pvp }) : defaultPost(path, body));
    return { server, defenderBaseId, pvp };
  }
  it('shows a rejected raid reason and returns home without creating another raid', async () => {
    mocks.postRaw.mockRejectedValue(new ApiError(422, 'Not enough SHARDS to start this raid'));
    await render();
    expect(host.textContent).toContain('Not enough SHARDS');
    await act(async () => button('BACK TO BASE')!.click());
    await flush();
    expect(useApp.getState().screen).toBe('base');
    expect(useApp.getState().raidTarget).toBeNull();
    expect(mocks.postRaw).toHaveBeenCalledTimes(1);
  });

  it.each(['energy', 'energy_pack'] as const)('refilling %s requires a new explicit attack choice', async (kind) => {
    mocks.postRaw.mockRejectedValue(new ApiError(422, 'Out of raid energy'));
    mocks.purchase.mockImplementation(async (_kind, options: { onDone(): void }) => { options.onDone(); });
    await act(async () => root.render(<RaidScreenLifetime />));
    await flush();
    await act(async () => button(kind === 'energy' ? 'BUY 1' : 'BUY 6')!.click());
    await flush();
    expect(mocks.purchase).toHaveBeenCalledWith(kind, expect.any(Object));
    expect(useApp.getState().screen).toBe('base');
    expect(useApp.getState().raidTarget).toBeNull();
    expect(mocks.postRaw).toHaveBeenCalledTimes(1);
  });

  it('does not let a late energy receipt navigate a replacement screen', async () => {
    mocks.postRaw.mockRejectedValue(new ApiError(422, 'Out of raid energy'));
    let receipt: (() => void) | undefined;
    mocks.purchase.mockImplementation(async (_kind, options: { onDone(): void }) => { receipt = options.onDone; });
    await render();
    await act(async () => button('BUY 1')!.click());
    await act(async () => useApp.getState().setScreen('map'));
    await act(async () => receipt!());
    await flush();
    expect(useApp.getState().screen).toBe('map');
    expect(mocks.postRaw).toHaveBeenCalledTimes(1);
  });
  async function nextTarget(): Promise<HTMLButtonElement> {
    await act(async () => button('NEXT TARGET')!.click());
    const confirm = [...host.querySelectorAll('[role="alertdialog"] button')]
      .find((b) => b.textContent === 'NEXT TARGET' || b.textContent === 'RETRY NEXT TARGET') as HTMLButtonElement;
    expect(confirm).toBeDefined();
    return confirm;
  }

  it.each(['troop', 'hero'] as const)('keeps a hidden top-edge %s unreserved, then accepts a visible legal neighbor', async (kind) => {
    serveNextTarget();
    await render();
    if (kind === 'hero') {
      await act(async () => (host.querySelector('[aria-label="VEX HERO, ready"]') as HTMLButtonElement).click());
    }
    mocks.postRaw.mockReturnValue(new Promise(() => undefined));
    const marks: unknown[] = [];
    const messages: string[] = [];
    const offMark = bus.on('battle:mark', (mark) => marks.push(mark));
    const offToast = bus.on('ui:toast', ({ msg }) => messages.push(msg));
    const keysBefore = mocks.idemKey.mock.calls.length;
    const writesBefore = mocks.postRaw.mock.calls.length;
    const postsBefore = mocks.post.mock.calls.length;
    try {
      // Visibility never grants permission inside the defender's claim core,
      // for heroes or troops. Only legal candidates reach the preview hook.
      const visible = vi.fn(() => true);
      await act(async () => bus.emit('battle:tap', { tx: 10, ty: 10, previewVisible: visible }));
      await flush();
      expect(visible).not.toHaveBeenCalled();
      expect(commandPosts()).toEqual([]);
      expect(marks).toEqual([]);
      expect(mocks.idemKey).toHaveBeenCalledTimes(keysBefore);

      // Row -4 is legal, but none of the nearby destinations is exposed yet.
      // Refusing it must not reserve an actor, spend an order or start combat.
      await act(async () => bus.emit('battle:tap', { tx: 10, ty: -4, visibleTiles: [] }));
      await flush();
      expect(commandPosts()).toEqual([]);
      expect(marks).toEqual([]);
      expect(mocks.idemKey).toHaveBeenCalledTimes(keysBefore);
      expect(mocks.postRaw).toHaveBeenCalledTimes(writesBefore);
      expect(mocks.post).toHaveBeenCalledTimes(postsBefore);
      expect(mocks.simulateRaid).not.toHaveBeenCalled();
      expect(messages).toContain('PAN TO REVEAL THIS TILE');
      if (kind === 'hero') expect(host.querySelector('[aria-label="VEX HERO, ready"]')?.getAttribute('aria-disabled')).toBe('false');
      else expect(host.textContent).toContain('×3');

      // Panning exposes a one-tile neighbor, while the raw legal tile stays
      // hidden. Both channels must select the exposed destination before use.
      await act(async () => bus.emit('battle:tap', { tx: 10, ty: -4, visibleTiles: ['10,-3'] }));
      await flush();
      expect(commandPosts()).toHaveLength(1);
      expect(commandPosts()[0]!.command).toEqual(kind === 'hero'
        ? { kind: 'hero', payload: { hero: 'vex', tx: 10, ty: -3 } }
        : { kind: 'deploy', payload: { troop: 'highlander', tx: 10, ty: -3 } });
      expect(marks).toHaveLength(1);
      expect(mocks.simulateRaid).not.toHaveBeenCalled();
    } finally {
      offMark(); offToast();
    }
  });

  it('settles once before Next matchmaking, excludes the old opponent and blocks same-frame deploys', async () => {
    const { defenderBaseId, pvp } = serveNextTarget();
    await render();
    let finish!: (value: unknown) => void;
    mocks.postRaw.mockImplementation((path: string) => path.endsWith('/finish')
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ raid: { ...pvp, id: 'next-raid', defenderBaseId: 'another-base' } }));
    const confirm = await nextTarget();
    expect(host.textContent).toContain('1 ENERGY + 500 SHARDS');
    await act(async () => { confirm.click(); confirm.click(); bus.emit('battle:tap', { tx: 0, ty: 0 }); });
    await flush();
    expect(postsTo('finish')).toHaveLength(1);
    expect(commandPosts()).toHaveLength(0);
    expect(mocks.postRaw.mock.calls.filter(([path]) => path === '/raids')).toHaveLength(1);
    finish({ result: won });
    await flush();
    const creates = mocks.postRaw.mock.calls.filter(([path]) => path === '/raids');
    expect(creates).toHaveLength(2);
    expect(creates[1]?.[1]).toMatchObject({ attackerBaseId, excludeBaseId: defenderBaseId });
    expect(creates[1]?.[1]).not.toHaveProperty('defenderWallet');
  });

  it.each(['troop', 'hero'] as const)('blocks Next when a %s was queued after its confirmation opened', async (kind) => {
    serveNextTarget();
    await render();
    if (kind === 'hero') {
      await act(async () => (host.querySelector('[aria-label="VEX HERO, ready"]') as HTMLButtonElement).click());
    }
    const confirm = await nextTarget();
    mocks.postRaw.mockReturnValue(new Promise(() => undefined));
    await act(async () => { bus.emit('battle:tap', { tx: 0, ty: 0 }); confirm.click(); });
    await flush();
    expect(commandPosts()).toHaveLength(1);
    expect(postsTo('finish')).toHaveLength(0);
  });

  it('withdraws Next when a restored canonical clock has already started', async () => {
    const { server } = serveNextTarget();
    server.clock = v2Clock(1, 1, new Date(T0).toISOString());
    await render();
    expect(button('NEXT TARGET')).toBeUndefined();
    expect(postsTo('finish')).toHaveLength(0);
  });

  it('keeps an uncertain Next retreat locked and retries its exact settlement request', async () => {
    serveNextTarget();
    const defaultGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path: string) => path.endsWith('/replay')
      ? Promise.reject(new ApiError(409, 'still pending')) : defaultGet(path));
    await render();
    mocks.postRaw.mockRejectedValue(new TypeError('response lost'));
    const confirm = await nextTarget();
    await act(async () => confirm.click());
    await flush();
    const first = postsTo('finish')[0]?.[1];
    await tap(0, 0);
    expect(commandPosts()).toHaveLength(0);
    expect(mocks.postRaw.mock.calls.filter(([path]) => path === '/raids')).toHaveLength(1);
    const retry = [...host.querySelectorAll('[role="alertdialog"] button')]
      .find((b) => b.textContent === 'RETRY NEXT TARGET') as HTMLButtonElement;
    await act(async () => retry.click());
    await flush();
    expect(postsTo('finish')).toHaveLength(2);
    expect(postsTo('finish')[1]?.[1]).toEqual(first);
  });

  it('shows no other target without starting another raid and preserves exact matchmaking retries', async () => {
    serveNextTarget();
    await render();
    mocks.postRaw.mockImplementation((path: string) => path.endsWith('/finish')
      ? Promise.resolve({ result: won }) : Promise.reject(new ApiError(404, 'No other target available', 'no_other_targets')));
    const confirm = await nextTarget();
    await act(async () => confirm.click());
    await flush();
    expect(host.textContent).toContain('No other target available');
    const creates = () => mocks.postRaw.mock.calls.filter(([path]) => path === '/raids');
    expect(creates()).toHaveLength(2);
    const request = creates()[1]?.[1];
    await act(async () => button('TRY AGAIN')!.click());
    await flush();
    expect(creates()[2]?.[1]).toEqual(request);
    expect(postsTo('finish')).toHaveLength(1);
  });

  it('retires a forced-away battle without FINISH and starts the next raid with fresh local state', async () => {
    const enters = vi.fn(); const off = bus.on('battle:enter', enters);
    try {
      await act(async () => root.render(<RaidScreenLifetime />));
      await flush();
      await tap(0, 0);
      await attack();
      expect(enters).toHaveBeenCalledTimes(1);
      await act(async () => recoverBaseAuthority('DEED_OWNERSHIP_CHANGED'));
      expect(useApp.getState().screen).toBe('bases');
      await advance(BATTLE_END_MS + 60_000);
      expect(postsTo('finish'), 'departing presentation cannot settle the durable raid').toHaveLength(0);
      await act(async () => useApp.setState({ screen: 'base', base, selectedBaseId: attackerBaseId }));
      await act(async () => useApp.setState({ screen: 'battle', raidTarget: { kind: 'campaign', stage: 1 } }));
      await flush();
      expect(enters).toHaveBeenCalledTimes(2);
      expect(mocks.postRaw.mock.calls.filter(([path]) => path === '/campaign/1/raid')).toHaveLength(2);
      expect(host.textContent).toContain('ATTACK');
    } finally { off(); }
  });

  it('keeps one pending marker per accepted same-cell V2 command instead of adding static ghosts', async () => {
    serveV2Journal();
    const marks: unknown[] = []; const off = bus.on('battle:mark', (m) => marks.push(m));
    try {
      await render(); await tap(0, 0); await tap(0, 0);
      expect(commandPosts()).toHaveLength(2);
      expect(marks).toHaveLength(2); // both real units must remain visible at the shared cell
      await advance(100);
      expect(marks, 'journal acknowledgement must adopt each optimistic marker exactly once').toHaveLength(2);
    } finally { off(); }
  });

  it('adopts the same hero marker when a lost V2 receipt is recovered from the accepted journal', async () => {
    const server = serveV2Journal();
    const post = mocks.postRaw.getMockImplementation()!;
    mocks.postRaw.mockImplementation((path: string, body: JournalWrite) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: {
        ...campaignRaid(), raidProtocolVersion: 2,
        armySnapshot: { ...campaignRaid().armySnapshot, heroes: ['vex'], heroLevels: { vex: 1 } },
        live: { clock: server.currentClock(), startedAt: null },
      } });
      if (path === `/raids/${raidId}/commands`) {
        if (!server.commands.length) server.commands.push(accepted(body, 0));
        return Promise.reject(new ApiError(0, 'lost accepted receipt'));
      }
      return post(path, body);
    });
    const marks: unknown[] = []; const off = bus.on('battle:mark', (m) => marks.push(m));
    try {
      await render();
      await act(async () => (host.querySelector('button[aria-label="VEX HERO, ready"]') as HTMLButtonElement).click());
      await tap(0, 0); await advance(100);
      expect(server.commands).toHaveLength(1);
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ hero: 'vex', tx: 0, ty: 0 });
      expect(commandPosts()).toHaveLength(2); // same durable request, never a new deployment
      expect(commandPosts()[0]?.clientCommandId).toBe(commandPosts()[1]?.clientCommandId);
    } finally { off(); }
  });

  it('does not restore a stale pre-start marker after ATTACK has started V2 playback', async () => {
    const server = serveV2Journal();
    server.commands.push(journaled(0, { troop: 'highlander', tx: 0, ty: 0, tMs: 0 }, T0));
    const get = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path: string) => path === `/raids/pending/${raidId}`
      ? Promise.resolve({ raid: { ...campaignRaid(), raidProtocolVersion: 2,
        live: { clock: server.currentClock(), startedAt: null } } }) : get(path));
    useApp.setState({ raidTarget: { kind: 'campaign', stage: 1, raidId } });
    const marks: unknown[] = []; const off = bus.on('battle:mark', (m) => marks.push(m));
    try {
      await render();
      await attack(); // start before the recovery marker's old80ms callback
      await advance(100);
      expect(marks, 'started playback owns real actors; an older restoration may not add static markers').toHaveLength(0);
    } finally { off(); }
  });

  it.each([1, 2])('passes frozen hero equipment to the worker in protocol %s rather than dropping paid gear', async (protocol) => {
    const server = protocol === 2 ? serveV2Journal() : null;
    const post = mocks.postRaw.getMockImplementation()!;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => path === '/campaign/1/raid'
      ? Promise.resolve({ raid: { ...campaignRaid(), raidProtocolVersion: protocol,
        armySnapshot: { ...campaignRaid().armySnapshot, heroes: ['theodor'],
          heroLevels: frozenGearRaid.army.heroLevels, heroLoadouts: frozenGearRaid.army.heroLoadouts },
        ...(server ? { live: { clock: server.currentClock(), startedAt: null } } : {}),
      } }) : post(path, body));
    await render();
    await act(async () => (host.querySelector('button[aria-label="THEODOR HERO, ready"]') as HTMLButtonElement).click());
    await tap(0, 0); await attack();
    expect(mocks.simulateRaid.mock.calls.at(-1)?.[1].heroDeploys[0]).toMatchObject({
      hero: 'theodor', level: frozenGearRaid.army.heroLevels.theodor, loadout: frozenGearRaid.army.heroLoadouts.theodor,
    });
    expect(mocks.get.mock.calls.some(([path]) => String(path).includes('/items'))).toBe(false);
  });

  it('samples the current 2x clock after a delayed reserve calculation, not at request time', async () => {
    const server = serveV2Journal();
    const plays: Array<{ fromTick?: number }> = []; const off = bus.on('battle:play', (p) => plays.push(p));
    try {
      await render(); await tap(0, 0); await attack(); await advance(100);
      server.clock = v2Clock(2, 2, new Date(T0).toISOString());
      let resolve!: (value: unknown) => void;
      mocks.simulateRaid.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
      await tap(1, 1);
      expect(host.textContent).toContain('CATCHING UP');
      await advance(500);
      await act(async () => resolve({ events: localEvents, ...won })); await flush(); await advance(80);
      expect(plays.at(-1)?.fromTick).toBe(12); //600ms wall ×2 /100ms tick
      expect(commandPosts().at(-1)?.command.payload).not.toHaveProperty('tMs');
    } finally { off(); }
  });

  it('a superseded calculation cannot replace the newer accepted stream, even after its delayed publish timer', async () => {
    serveV2Journal();
    const plays: Array<{ events: unknown[] }> = []; const off = bus.on('battle:play', (p) => plays.push(p));
    try {
      await render(); await tap(0, 0); await attack(); await advance(100);
      let old!: (value: unknown) => void;
      mocks.simulateRaid.mockReturnValueOnce(new Promise((done) => { old = done; }));
      await tap(1, 1);
      const newest = { events: [{ t: 0, e: 'deploy', id: 77, troop: 'highlander', x: 0, y: 0 }], ...won };
      mocks.simulateRaid.mockReturnValueOnce(newest);
      await tap(2, 2); await advance(80);
      expect(plays.at(-1)?.events).toEqual(newest.events);
      const count = plays.length;
      await act(async () => old({ events: localEvents, ...won })); await flush(); await advance(100);
      expect(plays).toHaveLength(count);
      expect(mocks.simulateRaid.mock.calls.at(-1)?.[1].deploys).toHaveLength(3);
    } finally { off(); }
  });

  it.each(['wallet', 'base', 'raid', 'screen'] as const)('disposes a pending calculation and clears catch-up after changing %s', async (change) => {
    serveV2Journal();
    let resolve!: (value: unknown) => void;
    mocks.simulateRaid.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const plays = vi.fn(); const off = bus.on('battle:play', plays);
    try {
      await render(); await tap(0, 0); await attack();
      expect(host.textContent).toContain('CATCHING UP');
      await act(async () => {
        if (change === 'wallet') useApp.setState({ wallet: 'another-wallet' });
        else if (change === 'base') useApp.setState({ selectedBaseId: 'another-base' });
        else if (change === 'raid') useApp.setState({ raidTarget: { kind: 'campaign', stage: 2, raidId: 'another-raid' } });
        else useApp.setState({ screen: 'base' });
      });
      expect(mocks.disposeSimulation).toHaveBeenCalled();
      await act(async () => resolve({ events: localEvents, ...won })); await flush(); await advance(100);
      expect(plays).not.toHaveBeenCalled();
      expect(host.textContent).not.toContain('CATCHING UP');
    } finally { off(); }
  });

  it.each(['pending', 'failed'] as const)('clock-only polling cannot finish an old plan while its replacement worker is %s', async (state) => {
    serveV2Journal();
    await render(); await tap(0, 0); await attack(); await advance(100);
    if (state === 'pending') mocks.simulateRaid.mockReturnValueOnce(new Promise(() => undefined));
    else mocks.simulateRaid.mockRejectedValueOnce(new Error('replacement worker failed'));
    await tap(1, 1); // the old displayed plan exists, but this accepted prefix has no valid new plan yet
    await advance(RAID_RULES.battleDurationSec * 1_000 + 5_000);
    expect(mocks.get.mock.calls.some(([path]) => String(path).includes('/live?afterSequence='))).toBe(true);
    expect(postsTo('finish'), 'clock updates cannot turn a stale render plan into a settlement request').toHaveLength(0);
    expect(postsTo('orders')).toHaveLength(0);
  });

  it('rechecks a queued FINISH after a delayed command receipt starts replacement calculation', async () => {
    const server = serveV2Journal();
    await render(); await tap(0, 0); await attack(); await advance(88_000);
    const post = mocks.postRaw.getMockImplementation()!;
    let receipt!: (value: unknown) => void; let write!: JournalWrite;
    mocks.postRaw.mockImplementation((path: string, body: JournalWrite) => {
      if (path === `/raids/${raidId}/commands`) {
        write = body; return new Promise((resolve) => { receipt = resolve; });
      }
      return post(path, body);
    });
    let calculation!: (value: unknown) => void;
    mocks.simulateRaid.mockReturnValueOnce(new Promise((resolve) => { calculation = resolve; }));
    await tap(1, 1); await advance(3_000); // old deadline reaches FINISH, queued behind the in-flight receipt
    expect(postsTo('finish')).toHaveLength(0);
    const command = { ...accepted(write, server.commands.length), serverOffsetMs: 88_000 };
    server.commands.push(command);
    await act(async () => receipt({ command, clock: server.currentClock() })); await flush();
    expect(mocks.simulateRaid).toHaveBeenCalledTimes(2);
    expect(postsTo('finish'), 'queue completion cannot send while its newly accepted plan is still pending').toHaveLength(0);
    await act(async () => calculation({ events: [...localEvents,
      { t: 880, e: 'deploy', id: 2, troop: 'highlander', x: 256, y: 256 }], ...won }));
    await flush(); await advance(1_100);
    expect(postsTo('finish')).toHaveLength(1);
  });

  it('worker failure offers only explicit reload and never turns a render failure into settlement', async () => {
    serveV2Journal(); mocks.simulateRaid.mockRejectedValue(new Error('worker failed'));
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    await render(); await tap(0, 0); await attack();
    expect(host.textContent).toContain('BATTLE DISPLAY UNAVAILABLE');
    expect(button('RELOAD GAME')).toBeDefined();
    const calls = mocks.simulateRaid.mock.calls.length;
    await act(async () => bus.emit('battle:done', undefined)); await advance(2_000);
    expect(postsTo('finish')).toHaveLength(0); expect(postsTo('orders')).toHaveLength(0);
    expect(mocks.simulateRaid).toHaveBeenCalledTimes(calls);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => button('RELOAD GAME')!.click());
    expect(reload).toHaveBeenCalledOnce();
  });

  it('canonical terminal replay cancels a pending calculation and its late reply cannot replace results', async () => {
    const server = serveV2Journal();
    let resolve!: (value: unknown) => void;
    mocks.simulateRaid.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const plays: Array<{ terminal?: boolean }> = []; const off = bus.on('battle:play', (p) => plays.push(p));
    try {
      await render(); await tap(0, 0); await attack();
      server.status = 'resolved'; await advance(1_000);
      expect(plays.at(-1)?.terminal).toBe(true);
      await act(async () => bus.emit('battle:done', undefined));
      expect(button('HOME')).toBeDefined();
      const count = plays.length;
      await act(async () => resolve({ events: localEvents, ...won })); await flush(); await advance(100);
      expect(plays).toHaveLength(count); expect(postsTo('finish')).toHaveLength(0);
      expect(host.textContent).not.toContain('CATCHING UP');
    } finally { off(); }
  });

  it.each(['create', 'resume'] as const)('ignores a late %s response after a newer deed selection', async (kind) => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    if (kind === 'create') mocks.postRaw.mockReturnValue(pending);
    else {
      useApp.setState({ raidTarget: { kind: 'campaign', stage: 1, raidId } });
      mocks.get.mockReturnValue(pending);
    }
    const entered = vi.fn();
    const off = bus.on('battle:enter', entered);
    try {
      await render();
      await act(async () => useApp.setState({ selectedBaseId: 'newer-deed-selection' }));
      resolve({ raid: campaignRaid() });
      await flush();
      expect(entered, 'an old response must not install an army from the previous deed').not.toHaveBeenCalled();
      expect(useApp.getState().selectedBaseId).toBe('newer-deed-selection');
      expect(mocks.simulateRaid).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it('does not route over a newer screen when a departed raid create fails its land gate', async () => {
    let reject!: (cause: unknown) => void;
    mocks.postRaw.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    await render();
    await act(async () => useApp.setState({ screen: 'mail', raidTarget: null }));
    reject(new ApiError(402, 'Land required', 'LAND_NOT_OWNED'));
    await flush();
    expect(useApp.getState().screen).toBe('mail');
  });

  it('journals every pre-battle drop at t=0 so the army starts together', async () => {
    // WHY: the server can only settle what it was told, so a drop is journaled
    // the moment it lands — not at ATTACK, not at the end. And every pre-battle
    // drop carries the SAME offset: the old 150ms-per-drop stagger was
    // client-only and read as units hesitating (D-099 "deploys start together").
    await render();
    await tap(0, 0);
    await tap(1, 1);
    expect(commandPosts().map((write) => write.command)).toEqual([
      { kind: 'deploy', payload: { troop: 'highlander', tx: 0, ty: 0, tMs: 0 } },
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1, tMs: 0 } },
    ]);
    // One idempotent id per drop, so a retried write can never double a unit.
    expect(new Set(commandPosts().map((write) => write.clientCommandId)).size).toBe(2);
    // The optimistic field consumed both at once — no wait for the server.
    expect(host.textContent).toContain('×1');
    await attack();
    expect(mocks.simulateRaid).toHaveBeenCalledWith(
      campaignRaid().snapshot,
      { deploys: [
        { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: 0 },
      ] },
      7,
      { troopLevels: { highlander: 1 } },
    );
  });

  it('shows every quick tap at once while its journal write is still in flight, one id per tap', async () => {
    // WHY (teammate report 2026-09-04, phone): taps that pile up invisibly
    // behind a slow round-trip become units the player never meant. The batch
    // field is optimistic: unit and count never wait for the server, and the
    // serial journal queue still gives each tap its own idempotent write.
    const receipts: Array<() => void> = [];
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid() });
      if (path === `/raids/${raidId}/commands`) {
        return new Promise((resolve) => {
          const sequence = receipts.length;
          receipts.push(() => resolve({ command: accepted(body as JournalWrite, sequence) }));
        });
      }
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    const marks: unknown[] = [];
    const off = bus.on('battle:mark', (mark) => { marks.push(mark); });
    try {
      await render();
      await tap(0, 0);
      await tap(1, 1);
      expect(marks).toEqual([{ troop: 'highlander', tx: 0, ty: 0 }, { troop: 'highlander', tx: 1, ty: 1 }]);
      expect(host.textContent).toContain('×1');
      expect(commandPosts(), 'the second write waits behind the first, the field does not').toHaveLength(1);
      receipts[0]!();
      await flush();
      expect(commandPosts()).toHaveLength(2);
      receipts[1]!();
      await flush();
      expect(new Set(commandPosts().map((write) => write.clientCommandId)).size).toBe(2);
      expect(host.textContent).toContain('×1');
    } finally { off(); }
  });

  it('binds each tap to the troop selected when the finger landed, receipts still outstanding', async () => {
    // (iv) select Bowman, tap; switch to Highlander, tap, tap — before any ack.
    const receipts: Array<() => void> = [];
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid(journalFeatures, { highlander: 2, bowman: 1 }) });
      if (path === `/raids/${raidId}/commands`) {
        return new Promise((resolve) => {
          const sequence = receipts.length;
          receipts.push(() => resolve({ command: accepted(body as JournalWrite, sequence) }));
        });
      }
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    const card = (label: string): HTMLButtonElement => {
      const found = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="raid-troop-card"]')]
        .find((b) => b.getAttribute('aria-label')?.startsWith(`${label},`));
      expect(found, `${label} card`).toBeDefined();
      return found!;
    };
    const marks: unknown[] = [];
    const off = bus.on('battle:mark', (mark) => { marks.push(mark); });
    try {
      await render();
      await act(async () => { card('BOWMAN').click(); });
      await tap(0, 0);
      await act(async () => { card('HIGHLANDER').click(); });
      await tap(1, 1);
      await tap(2, 2);
      expect(marks).toEqual([
        { troop: 'bowman', tx: 0, ty: 0 }, { troop: 'highlander', tx: 1, ty: 1 }, { troop: 'highlander', tx: 2, ty: 2 },
      ]);
      expect(card('BOWMAN').getAttribute('aria-label')).toBe('BOWMAN, 0 remaining');
      expect(card('HIGHLANDER').getAttribute('aria-label')).toBe('HIGHLANDER, 0 remaining');
      while (receipts.length < 3) { receipts[receipts.length - 1]!(); await flush(); }
      receipts[2]!();
      await flush();
      expect(commandPosts().map((write) => write.command.payload)).toEqual([
        { troop: 'bowman', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: 0 },
        { troop: 'highlander', tx: 2, ty: 2, tMs: 0 },
      ]);
    } finally { off(); }
  });

  it('accepts a buff before units, does not buy it twice at ATTACK, and refuses late buffs', async () => {
    await render();
    await act(async () => (host.querySelector('[aria-label="Battle details"]') as HTMLElement).click());
    const buff = (name: string): HTMLElement => host.querySelector(`[aria-label^="${name} ·"]`)!;
    expect(buff('WAR HORN')).not.toBeNull();
    await act(async () => buff('WAR HORN').click());
    await flush();
    expect(commandPosts().map((body) => body.command)).toEqual([
      { kind: 'buff', payload: { buff: 'warhorn' } },
    ]);
    expect(buff('WAR HORN').getAttribute('aria-label')).toContain('ACTIVE');
    await tap(1, 1);
    await act(async () => buff('SWIFT BOOTS').click());
    await flush();
    expect(commandPosts().filter((body) => body.command.kind === 'buff')).toHaveLength(1);
    await attack();
    expect(commandPosts().filter((body) => body.command.kind === 'buff')).toHaveLength(1);
    expect(mocks.simulateRaid.mock.calls.at(-1)?.[1]).toMatchObject({ buffs: { warhorn: true } });
    expect(buff('SWIFT BOOTS').getAttribute('role')).toBeNull();
  });

  it('waits for an unresolved buff purchase before starting the journaled fight', async () => {
    let resolveBuff!: (value: unknown) => void;
    let pendingBuff!: JournalWrite;
    let sequence = 1;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid() });
      if (path.endsWith('/commands')) {
        const command = body as JournalWrite;
        if (command.command.kind === 'buff') {
          pendingBuff = command;
          return new Promise((resolve) => { resolveBuff = resolve; });
        }
        return Promise.resolve({ command: accepted(command, sequence++) });
      }
      return Promise.resolve({ result: won });
    });
    await render();
    await act(async () => (host.querySelector('[aria-label="Battle details"]') as HTMLElement).click());
    await act(async () => (host.querySelector('[aria-label^="WAR HORN ·"]') as HTMLElement).click());
    await flush();
    await tap(1, 1);
    await attack();
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
    await act(async () => resolveBuff({ command: accepted(pendingBuff, 0) }));
    await flush();
    expect(mocks.simulateRaid.mock.calls.at(-1)?.[1]).toMatchObject({ buffs: { warhorn: true } });
  });

  it('journals a mid-battle reserve at its real elapsed offset', async () => {
    // WHY: the worker replays the journal through the same simulator this
    // client ran, so the reserve must be stamped where the local fight landed
    // it — otherwise the recorded battle differs from the one watched.
    await render();
    await tap(0, 0);
    await attack();
    await advance(1_000);
    await tap(1, 1);
    expect(commandPosts().at(-1)?.command).toEqual({
      kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1, tMs: 1_000 },
    });
    expect(mocks.simulateRaid).toHaveBeenLastCalledWith(
      campaignRaid().snapshot,
      expect.objectContaining({ deploys: [
        { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: 1_000 },
      ] }),
      7,
      expect.anything(),
    );
  });

  it('feeds a hero dropped after ATTACK to the field at the tick the bar calls IN BATTLE', async () => {
    // WHY: tester Suga (build cee3869, campaign): a hero dropped after the
    // attack started read IN BATTLE on the bar while never appearing on the
    // field. The bar and the battlefield share ONE source — the re-fed stream —
    // so a hero the bar calls IN BATTLE must be in the stream the scene is
    // handed, at the offset the journal records, re-fed from the CURRENT tick
    // (appliedPrefix) rather than parked for a restart the scene never does.
    const serve = mocks.postRaw.getMockImplementation()!;
    const roster = {
      ...campaignRaid(),
      armySnapshot: { ...campaignRaid().armySnapshot, heroes: ['vex' as const], heroLevels: { vex: 1 } },
    };
    mocks.postRaw.mockImplementation((path: string, body: unknown) =>
      path === '/campaign/1/raid' ? Promise.resolve({ raid: roster }) : serve(path, body));
    const played: unknown[] = [];
    const off = bus.on('battle:play', (payload) => { played.push(payload); });
    try {
      await render();
      await tap(0, 0);
      await attack();
      await advance(1_000);
      const card = host.querySelector('button[aria-label="VEX HERO, ready"]') as HTMLButtonElement | null;
      expect(card).not.toBeNull();
      await act(async () => card!.click());
      await tap(1, 1);
      expect(commandPosts().at(-1)?.command).toEqual({
        kind: 'hero', payload: { hero: 'vex', tx: 1, ty: 1, tMs: 1_000 },
      });
      expect(mocks.simulateRaid).toHaveBeenLastCalledWith(
        roster.snapshot,
        expect.objectContaining({
          deploys: [{ troop: 'highlander', tx: 0, ty: 0, tMs: 0 }],
          heroDeploys: [{ hero: 'vex', tx: 1, ty: 1, tMs: 1_000, level: 1 }],
        }),
        7,
        expect.anything(),
      );
      expect(played.at(-1), 'the scene is re-fed from the hero\'s own tick, prefix kept').toMatchObject({
        fromTick: 10, appliedPrefix: true, events: localEvents,
      });
      expect(host.querySelector('button[aria-label="VEX HERO, already fighting"]')?.textContent)
        .toContain('IN BATTLE');
    } finally { off(); }
  });

  it.each(['accepted', 'rejected', 'other-tab'] as const)(
    'waits for a delayed 2x reserve receipt without speculative combat (%s)', async (outcome) => {
    // WHY: a tap timestamp is not an accepted deployment. The request travels
    // while the battle runs at 2x; only the locked server offset may enter SIM.
    const clock = (rate: 1 | 2, revision: number, anchorWallAt: string | null) => ({
      protocolVersion: 2 as const,
      revision,
      rate,
      anchorWallAt,
      anchorSimMs: 0,
      serverNow: new Date().toISOString(),
      simNowMs: anchorWallAt ? Math.max(0, Date.now() - T0) * rate : 0,
      battleEndsAt: anchorWallAt ? new Date(T0 + 90_000 / rate).toISOString() : null,
      durationMs: 90_000,
    });
    const raidV2 = {
      ...campaignRaid(),
      raidProtocolVersion: 2 as const,
      live: { clock: clock(1, 0, null), startedAt: null },
    };
    let sequence = 0;
    let held!: JournalWrite;
    let acceptHeld!: (value: unknown) => void;
    let rejectHeld!: (cause: unknown) => void;
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith(`/raids/${raidId}/live?afterSequence=`)) {
        // The background poll remains online while the reserve is in flight.
        // All existing rows have already arrived in POST receipts, so this
        // incremental response contains only the current authoritative clock.
        return Promise.resolve({
          ...liveView([]), lastSequence: sequence - 1, protocolVersion: 2,
          clock: clock(2, 2, new Date(T0).toISOString()),
        });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: raidV2 });
      if (path === `/raids/${raidId}/start`) {
        return Promise.resolve({
          command: { sequence: sequence++, clientCommandId: 'start', kind: 'start', payload: {},
            serverOffsetMs: 0, acceptedAt: new Date(T0).toISOString() },
          clock: clock(1, 1, new Date(T0).toISOString()),
        });
      }
      if (path === `/raids/${raidId}/speed`) {
        return Promise.resolve({
          command: { sequence: sequence++, clientCommandId: 'speed', kind: 'speed', payload: { rate: 2 },
            serverOffsetMs: 0, acceptedAt: new Date(T0).toISOString() },
          clock: clock(2, 2, new Date(T0).toISOString()),
        });
      }
      if (path === `/raids/${raidId}/commands`) {
        const write = body as JournalWrite;
        if (sequence > 1) {
          held = write;
          return new Promise((resolve, reject) => { acceptHeld = resolve; rejectHeld = reject; });
        }
        return Promise.resolve({
          command: {
            sequence: sequence++, clientCommandId: write.clientCommandId,
            kind: write.command.kind, payload: write.command.payload,
            serverOffsetMs: rateAtReceipt(), acceptedAt: new Date().toISOString(),
          },
          clock: sequence > 1
            ? clock(2, 2, new Date(T0).toISOString())
            : clock(1, 0, null),
        });
      }
      if (path === `/raids/${raidId}/finish`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    const rateAtReceipt = (): number => Math.max(0, Date.now() - T0) * (sequence > 1 ? 2 : 1);

    await render();
    await tap(0, 0);
    await attack();
    const ratePill = [...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === '1×');
    expect(ratePill).toBeDefined();
    await act(async () => ratePill!.click());
    await flush();
    await advance(1_000);
    mocks.simulateRaid.mockClear();
    await tap(1, 1);

    const reserve = commandPosts().at(-1);
    expect(reserve?.command).toEqual({
      kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 },
    });
    expect(mocks.simulateRaid, 'an unaccepted tap cannot change the combat stream').not.toHaveBeenCalled();
    // The card is reserved AT the tap (the player must see what a slow receipt
    // already owes them); only combat waits for the server's offset.
    expect(host.textContent).toContain('×1');
    await advance(300);
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
    if (outcome === 'rejected') {
      const toasts = vi.fn(); const offToast = bus.on('ui:toast', toasts);
      try {
        rejectHeld(new ApiError(400, 'RAID_DEPLOY_INVALID'));
        await flush();
        expect(host.textContent).toContain('×2');
        expect(mocks.simulateRaid.mock.calls.at(-1)?.[1].deploys).toEqual([
          { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        ]);
        expect(toasts, 'the playing tray has no inline rejection message')
          .toHaveBeenCalledExactlyOnceWith({ msg: 'RAID_DEPLOY_INVALID' });
        expect(commandPosts(), 'a refused reserve must never be retried as a new drop').toHaveLength(2);
        // The authoritative 2× clock closes the remaining fight. An old troop
        // refusal must neither own the resolving panel nor hide its verdict.
        await advance(45_000); await flush();
        expect(postsTo('finish')).toHaveLength(1);
        expect(host.textContent).toContain('VICTORY');
        expect(commandPosts()).toHaveLength(2);
        expect(toasts).toHaveBeenCalledTimes(1);
      } finally { offToast(); }
      return;
    }
    const otherTabCommand = outcome === 'other-tab' ? {
      sequence: sequence++, clientCommandId: 'other-tab-speed', kind: 'speed',
      payload: { rate: 2, expectedClockRevision: 2 }, serverOffsetMs: 2_100,
      acceptedAt: new Date(T0 + 1_050).toISOString(),
    } : null;
    const committed = {
      ...accepted(held, sequence++), serverOffsetMs: 2_400,
      acceptedAt: new Date(T0 + 1_200).toISOString(),
    };
    let recoverPrefix!: (value: unknown) => void;
    if (otherTabCommand) {
      mocks.get.mockImplementation((path: string) => {
        if (path === `/raids/${raidId}/live?afterSequence=-1`) {
          return new Promise((resolve) => { recoverPrefix = resolve; });
        }
        return Promise.reject(new Error(`unexpected GET ${path}`));
      });
    }
    acceptHeld({
      command: committed,
      // The server accepted at wall t=1200; its reply arrived at t=1300.
      clock: { ...clock(2, 2, new Date(T0).toISOString()),
        serverNow: new Date(T0 + 1_200).toISOString(), simNowMs: 2_400 },
    });
    await flush();
    if (otherTabCommand) {
      expect(mocks.simulateRaid, 'do not simulate a sequence with missing controls').not.toHaveBeenCalled();
      expect(host.textContent).toContain('×1'); // receipt is accepted; only its missing history is pending
      expect(commandPosts()).toHaveLength(2);
      recoverPrefix({
        ...liveView([otherTabCommand, committed]),
        lastSequence: committed.sequence,
        protocolVersion: 2,
        clock: clock(2, 2, new Date(T0).toISOString()),
      });
      await flush();
      expect(commandPosts(), 'a committed receipt needs hydration, never another unit POST').toHaveLength(2);
    }
    expect(host.textContent).toContain('×1');
    expect(mocks.simulateRaid).toHaveBeenLastCalledWith(
      raidV2.snapshot,
      expect.objectContaining({ deploys: [
        { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: 2_400 },
      ] }),
      7,
      expect.anything(),
    );
  });

  it.each([1, 2] as const)('keeps reserves and controls after a provisional wipe, then finishes on the accepted %sx clock', async (rate) => {
    // WHY: the only deployed actor dying is not a verdict while the server
    // still accepts reserves. A later speed change must move the real finish
    // boundary even when no further animation-completion event is emitted.
    const server = serveV2Journal();
    const ratePill = (label: string) => [...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === label);
    await render();
    await tap(0, 0);
    await attack();
    await advance(7_000);
    await act(async () => bus.emit('battle:done', undefined));
    expect(host.textContent).not.toContain('RESOLVING RAID');
    expect(button('RETREAT')).toBeDefined();
    expect(ratePill('1×')).toBeDefined();
    expect(host.textContent).toContain('×2');
    expect(postsTo('finish')).toHaveLength(0);

    await tap(1, 1);
    expect(commandPosts()).toHaveLength(2);
    expect(server.commands.at(-1)?.serverOffsetMs).toBe(7_000);
    expect(commandPosts().at(-1)?.command.payload).not.toHaveProperty('tMs');
    await act(async () => bus.emit('battle:done', undefined));
    if (rate === 2) {
      await act(async () => ratePill('1×')!.click());
      await flush();
      expect(postsTo('speed')).toHaveLength(1);
      expect(ratePill('2×')).toBeDefined();
    }
    const remainingWallMs = (server.currentClock().durationMs - 7_000) / rate;
    await advance(remainingWallMs - 250);
    expect(host.textContent).not.toContain('RESOLVING RAID');
    expect(button('RETREAT')).toBeDefined();
    expect(postsTo('finish')).toHaveLength(0);
    await advance(500);
    expect(postsTo('finish')).toEqual([[`/raids/${raidId}/finish`, {}]]);
    expect(host.textContent).toContain('VICTORY');
  });

  it.each([1, 2] as const)('requests authoritative results at 100 percent after the %sx stream ends, including a hidden tab', async (rate) => {
    serveV2Journal();
    mocks.simulateRaid.mockReturnValue({
      events: localEvents, stars: 3, destructionPct: 100, keepDestroyed: true,
    });
    await render(); await tap(0, 0); await attack();
    if (rate === 2) {
      const speed = [...host.querySelectorAll<HTMLElement>('[role="button"]')]
        .find((node) => node.textContent === '1×')!;
      await act(async () => speed.click()); await flush();
    }
    // No Phaser battle:done is emitted while hidden. The normal wall timer
    // still asks the server to verify completion; reserves must remain unused.
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      await advance(BATTLE_END_MS / rate + 250);
      expect(postsTo('finish')).toEqual([[`/raids/${raidId}/finish`, {}]]);
      expect(commandPosts()).toHaveLength(1);
      visibility.mockReturnValue('visible');
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => bus.emit('battle:done', undefined)); await flush();
      expect(host.textContent).toContain('VICTORY');
      expect(button('HOME')).toBeDefined();
      expect(postsTo('finish')).toHaveLength(1);
    } finally { visibility.mockRestore(); }
  });

  it('restores controls when a delayed other-tab slowdown makes the local finish premature', async () => {
    // WHY: a stale 2x clock must not strand reserves in RESOLVING after the
    // server corrects it to an active 1x raid. Authority, not extrapolation, wins.
    const server = serveV2Journal();
    const normalPost = mocks.postRaw.getMockImplementation()!;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path.endsWith('/finish') && server.currentClock().simNowMs < 90_000) {
        return Promise.reject(new ApiError(409, 'not due', 'RAID_CLOCK_NOT_DUE'));
      }
      return normalPost(path, body);
    });
    await render();
    await tap(0, 0);
    await attack();
    const speed = [...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === '1×')!;
    await act(async () => speed.click());
    await flush();
    await advance(10_000);
    await act(async () => bus.emit('battle:done', undefined));
    server.clock = v2Clock(1, 3, new Date().toISOString(), 20_000);
    const normalGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path: string) => {
      // Hold incremental polling, not the full read triggered by NOT_DUE.
      if (path.includes('/live?afterSequence=') && !path.endsWith('=-1')) return new Promise(() => undefined);
      return normalGet(path);
    });
    await advance(35_000);
    expect(postsTo('finish')).toHaveLength(1);
    await advance(500);
    expect(host.textContent).not.toContain('RESOLVING RAID');
    expect(host.textContent).toContain('1×');
    expect(button('RETREAT')).toBeDefined();
    await tap(1, 1);
    expect(commandPosts()).toHaveLength(2);
    expect(server.commands.at(-1)?.serverOffsetMs).toBe(55_500);
    expect(commandPosts().at(-1)?.command.payload).not.toHaveProperty('tMs');
    await advance(34_750);
    expect(postsTo('finish')).toHaveLength(2);
    expect(host.textContent).toContain('VICTORY');
  });

  it('learns an automatic start and remote speed changes without re-simulating unchanged orders', async () => {
    const server = serveV2Journal();
    await render();
    await tap(0, 0);
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
    server.clock = v2Clock(1, 1, new Date(T0).toISOString());
    server.commands.push(accepted({ clientCommandId: 'auto-start', command: { kind: 'start', payload: {} } }, 1));
    await advance(1_000);
    expect(mocks.simulateRaid).toHaveBeenCalledTimes(1);
    expect(button('ATTACK')).toBeUndefined();
    expect(postsTo('start'), 'the other tab/server already started this raid').toHaveLength(0);
    mocks.simulateRaid.mockClear();
    server.clock = v2Clock(2, 2, new Date().toISOString(), 1_000);
    server.commands.push(accepted({ clientCommandId: 'remote-speed-2', command: { kind: 'speed', payload: { rate: 2 } } }, 2));
    await advance(1_000);
    expect(host.textContent).toContain('2×');
    expect(mocks.simulateRaid, 'speed changes affect the clock, not SIM inputs').not.toHaveBeenCalled();
    server.clock = v2Clock(1, 3, new Date().toISOString(), 3_000);
    server.commands.push(accepted({ clientCommandId: 'remote-speed-1', command: { kind: 'speed', payload: { rate: 1 } } }, 3));
    await advance(1_000);
    expect(host.textContent).toContain('1×');
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
    expect(postsTo('speed'), 'observing another tab never writes a speed preference').toHaveLength(0);
  });

  it('merges a remote deployment once and leaves quiet polls allocation-light', async () => {
    const server = serveV2Journal();
    await render();
    await tap(0, 0);
    await attack();
    mocks.simulateRaid.mockClear();
    server.commands.push({
      ...accepted({ clientCommandId: 'remote-drop', command: {
        kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 },
      } }, 2), serverOffsetMs: 600,
    });
    await advance(1_000);
    expect(host.textContent).toContain('×1');
    expect(mocks.simulateRaid).toHaveBeenCalledTimes(1);
    expect(mocks.simulateRaid.mock.calls[0]?.[1].deploys).toEqual([
      { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
      { troop: 'highlander', tx: 1, ty: 1, tMs: 600 },
    ]);
    await advance(1_000);
    expect(mocks.simulateRaid).toHaveBeenCalledTimes(1);
    expect(mocks.get.mock.calls.at(-1)?.[0]).toBe(`/raids/${raidId}/live?afterSequence=2`);
  });

  it('pauses polling while hidden/offline and never overlaps a slow read', async () => {
    const server = serveV2Journal();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render();
    await advance(1_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await advance(3_000);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(mocks.get, 'timer and lifecycle wakeups share one in-flight read').toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => resolve(server.view()));
    await advance(3_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    online.mockReturnValue(false);
    await act(async () => window.dispatchEvent(new Event('offline')));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(2_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('RECONNECTING');
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await act(async () => resolve(server.view()));
    await flush();
    expect(host.textContent).not.toContain('RECONNECTING');
  });

  it('does not discard a newer POST receipt or clock when an older poll arrives', async () => {
    const server = serveV2Journal();
    await render();
    await tap(0, 0);
    await attack();
    const oldView = server.view(1);
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await advance(1_000);
    await tap(1, 1);
    const ratePill = [...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === '1×');
    await act(async () => ratePill!.click());
    await flush();
    mocks.simulateRaid.mockClear();
    await act(async () => resolve(oldView));
    await flush();
    expect(host.textContent).toContain('2×');
    expect(host.textContent).toContain('×1');
    expect(mocks.simulateRaid, 'an old empty read neither removes a unit nor rebuilds playback').not.toHaveBeenCalled();
    await advance(1_000);
    expect(mocks.get.mock.calls.at(-1)?.[0]).toBe(`/raids/${raidId}/live?afterSequence=3`);
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
  });

  it.each([0, 1_000])('shows the worker verdict without another FINISH or a stale playback (%dms)', async (delay) => {
    const server = serveV2Journal();
    const playback = vi.fn();
    const off = bus.on('battle:play', playback);
    try {
      await render();
      await tap(0, 0);
      await attack();
      server.status = 'resolved';
      server.clock = v2Clock(1, 1, new Date(T0).toISOString(), 90_000);
      if (delay > 0) await advance(delay);
      else {
        await act(async () => window.dispatchEvent(new Event('online')));
        await flush();
      }
      expect(mocks.get).toHaveBeenCalledWith(`/bases/${attackerBaseId}/battles/${raidId}/replay`);
      expect(playback.mock.calls.at(-1)?.[0]).toMatchObject({
        events: localEvents, simVersion: SIM_VERSION, terminal: true, appliedPrefix: true,
      });
      const publications = playback.mock.calls.length;
      await advance(100);
      expect(playback, 'a delayed pre-verdict 80ms scene cue must not restart the finished raid').toHaveBeenCalledTimes(publications);
      await act(async () => bus.emit('battle:done', undefined));
      await flush();
      expect(host.textContent).toContain('71%');
      expect(postsTo('finish')).toHaveLength(0);
      const reads = mocks.get.mock.calls.length;
      await advance(2_000);
      expect(mocks.get).toHaveBeenCalledTimes(reads);
    } finally { off(); }
  });

  it.each(['base', 'screen'] as const)('ignores a late attacker poll after changing %s', async (change) => {
    const server = serveV2Journal();
    await render();
    await tap(0, 0);
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await advance(1_000);
    server.clock = v2Clock(2, 2, new Date(T0).toISOString());
    await act(async () => useApp.setState(change === 'screen'
      ? { screen: 'base' } : { selectedBaseId: 'another-base' }));
    await act(async () => resolve(server.view()));
    await flush();
    expect(mocks.simulateRaid).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('2×');
  });

  it('commits rally with ATTACK, sequenced behind the drops', async () => {
    // WHY: the server refuses a modifier before a unit and the worker must
    // settle with the modifiers this local playback starts with, so ATTACK
    // journals them right after the drops already queued.
    await render();
    await tap(0, 0);
    const rally = button('RALLY');
    expect(rally).toBeDefined();
    await act(async () => rally!.click());
    await flush();
    await attack();
    expect(commandPosts().map((write) => write.command.kind)).toEqual(['deploy', 'rally']);
    // Anchored to the claim centre, at the battle's first tick.
    expect(commandPosts()[1]?.command.payload).toEqual({ tx: 11, ty: 11, tMs: 0 });
  });

  it('allows canonical HP correction to lower destruction without weakening ordinary monotonic progress', async () => {
    await render();
    await tap(0, 0);
    await attack();
    await act(async () => bus.emit('battle:progress', { pct: 80 }));
    expect(host.textContent).toContain('80%');
    await act(async () => bus.emit('battle:progress', { pct: 30 }));
    expect(host.textContent).toContain('80%');
    await act(async () => bus.emit('battle:progress', { pct: 40, corrected: true }));
    expect(host.textContent).toContain('40%');
    expect(host.textContent).not.toContain('80%');
  });

  it('posts FINISH at the wall-clock battle end — behind the journal, never the whole list', async () => {
    // WHY: once journaled, the server refuses the whole-list POST; FINISH just
    // closes the journal. And it must never overtake a write still in flight,
    // or the raid settles without the reserve the player actually threw.
    // The whole roster is thrown here: with a reserve still in the tray the
    // fight stays open to the TRUE clock end instead (D-106, pinned below).
    let acceptHeld!: () => void;
    let sequence = 0;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/campaign/1/raid') {
        return Promise.resolve({ raid: campaignRaid(journalFeatures, { highlander: 2 }) });
      }
      if (path === `/raids/${raidId}/commands`) {
        const ack = { command: accepted(body as JournalWrite, sequence++) };
        if (sequence === 2) return new Promise((resolve) => { acceptHeld = () => resolve(ack); });
        return Promise.resolve(ack);
      }
      if (path === `/raids/${raidId}/finish`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    await render();
    await tap(0, 0);
    await attack();
    await advance(1_000);
    await tap(1, 1); // the server holds this write
    await advance(BATTLE_END_MS);
    expect(postsTo('orders')).toHaveLength(0);
    expect(postsTo('finish')).toHaveLength(0);

    acceptHeld();
    await flush();
    expect(postsTo('finish')).toEqual([[`/raids/${raidId}/finish`, {}]]);
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('VICTORY');
    expect(postsTo('finish')).toHaveLength(1);
  });

  it.each([
    { protocolVersion: 1, pendingHasClock: false },
    { protocolVersion: 2, pendingHasClock: false },
    { protocolVersion: 2, pendingHasClock: true },
  ])('never expires a started v$protocolVersion reload while its journal is delayed (pending clock: $pendingHasClock)', async ({ protocolVersion, pendingHasClock }) => {
    // WHY: restoring defaults to deploying/zero orders. Past the old deploy
    // cutoff that must not dismiss a raid the server has already started.
    const clock = v2Clock(1, 3, new Date(T0 - 10_000).toISOString(), 2_000);
    const pendingRaid = {
      ...campaignRaid(), raidProtocolVersion: protocolVersion,
      ordersDeadlineAt: new Date(T0 + RAID_RULES.battleDurationSec * 1_000 - 1_000).toISOString(),
      ...(pendingHasClock ? { live: { clock, startedAt: clock.anchorWallAt } } : {}),
    };
    const journal = [
      journaled(0, { troop: 'highlander', tx: 0, ty: 0, tMs: 0 }, T0 - 12_000),
      journaled(1, { troop: 'highlander', tx: 1, ty: 1, tMs: 5_000 }, T0 - 5_000),
    ];
    let resolveJournal!: (value: unknown) => void;
    const pendingJournal = new Promise((resolve) => { resolveJournal = resolve; });
    mocks.get.mockImplementation((path: string) => {
      if (path === `/raids/pending/${raidId}`) return Promise.resolve({ raid: pendingRaid });
      if (path.startsWith(`/raids/${raidId}/live?afterSequence=`)) return pendingJournal;
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.simulateRaid.mockReturnValue({
      events: [{ ...localEvents[0], t: 0 }, { ...localEvents[1], t: 800 }],
      stars: won.stars, destructionPct: won.destructionPct, keepDestroyed: true,
    });
    useApp.setState({ raidTarget: { kind: 'campaign', stage: 1, raidId } });
    const exited = vi.fn();
    const toasts = vi.fn();
    const offExit = bus.on('battle:exit', exited);
    const offToast = bus.on('ui:toast', toasts);
    try {
      await render();
      await advance(2_500);
      expect(useApp.getState().screen).toBe('battle');
      expect(exited).not.toHaveBeenCalled();
      expect(postsTo('finish')).toHaveLength(0);
      resolveJournal({
        ...liveView(journal), protocolVersion,
        ...(protocolVersion === 2 ? { clock } : {}),
      });
      await flush();
      await advance(1_000);
      expect(useApp.getState().screen).toBe('battle');
      expect(button('ATTACK')).toBeUndefined();
      expect(mocks.simulateRaid).toHaveBeenCalled();
      expect(exited).not.toHaveBeenCalled();
      expect(toasts.mock.calls.some(([event]) => event.msg.includes('DEPLOY WINDOW CLOSED — CHECK YOUR ARMY'))).toBe(false);
      expect(mocks.postRaw.mock.calls.some(([path]) => path === '/campaign/1/raid')).toBe(false);
    } finally { offExit(); offToast(); }
  });

  it.each([1, 2])('waits for delayed v%s hydration to prove an expired raid is actually empty', async (protocolVersion) => {
    const pendingRaid = {
      ...campaignRaid(), raidProtocolVersion: protocolVersion,
      ordersDeadlineAt: new Date(T0 + RAID_RULES.battleDurationSec * 1_000 - 1_000).toISOString(),
    };
    let resolveJournal!: (value: unknown) => void;
    const pendingJournal = new Promise((resolve) => { resolveJournal = resolve; });
    mocks.get.mockImplementation((path: string) => {
      if (path === `/raids/pending/${raidId}`) return Promise.resolve({ raid: pendingRaid });
      if (path.startsWith(`/raids/${raidId}/live?afterSequence=`)) return pendingJournal;
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    useApp.setState({ raidTarget: { kind: 'campaign', stage: 1, raidId } });
    const toasts = vi.fn();
    const off = bus.on('ui:toast', toasts);
    try {
      await render();
      await advance(2_500);
      expect(useApp.getState().screen).toBe('battle');
      expect(toasts).not.toHaveBeenCalled();
      resolveJournal({
        ...liveView([]), protocolVersion,
        ...(protocolVersion === 2 ? { clock: v2Clock() } : {}),
      });
      await flush();
      await advance(1_000);
      expect(useApp.getState().screen).toBe('base');
      expect(toasts).toHaveBeenCalledExactlyOnceWith({ msg: 'DEPLOY WINDOW CLOSED — CHECK YOUR ARMY AT THE BARRACKS, THEN RETRY' });
      expect(postsTo('finish')).toHaveLength(0);
    } finally { off(); }
  });

  it('does not expire a v2 raid while a troop accepted at the cutoff awaits its receipt', async () => {
    // WHY: v2 renders accepted orders only, so its React order list remains
    // empty during a legitimate first deployment with a slow response.
    const server = serveV2Journal();
    const defaultPost = mocks.postRaw.getMockImplementation()!;
    let resolveDeployment!: (value: unknown) => void;
    let pendingWrite!: JournalWrite;
    mocks.postRaw.mockImplementation((path: string, body: JournalWrite) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: {
        ...campaignRaid(), raidProtocolVersion: 2,
        ordersDeadlineAt: new Date(T0 + RAID_RULES.battleDurationSec * 1_000 + 500).toISOString(),
        live: { clock: server.currentClock(), startedAt: null },
      } });
      if (path === `/raids/${raidId}/commands`) {
        pendingWrite = body;
        return new Promise((resolve) => { resolveDeployment = resolve; });
      }
      return defaultPost(path, body);
    });
    const exited = vi.fn();
    const off = bus.on('battle:exit', exited);
    try {
      await render();
      await tap(0, 0);
      expect(commandPosts()).toHaveLength(1);
      await advance(2_500);
      expect(useApp.getState().screen).toBe('battle');
      expect(exited).not.toHaveBeenCalled();
      const command = accepted(pendingWrite, 0);
      server.commands.push(command);
      server.clock = v2Clock(1, 1, new Date(T0 + 500).toISOString());
      resolveDeployment({ command, clock: server.currentClock() });
      await flush();
      await advance(1_000);
      expect(useApp.getState().screen).toBe('battle');
      expect(host.textContent).toContain('×2');
      expect(button('ATTACK')).toBeUndefined();
      expect(exited).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it.each([1, 2])('still expires a definitely empty new v%s raid at the normal cutoff', async (protocolVersion) => {
    if (protocolVersion === 2) serveV2Journal();
    const defaultPost = mocks.postRaw.getMockImplementation()!;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: {
        ...campaignRaid(), raidProtocolVersion: protocolVersion,
        ordersDeadlineAt: new Date(T0 + RAID_RULES.battleDurationSec * 1_000 + 1_000).toISOString(),
        ...(protocolVersion === 2 ? { live: { clock: v2Clock(), startedAt: null } } : {}),
      } });
      return defaultPost(path, body);
    });
    const toasts = vi.fn();
    const off = bus.on('ui:toast', toasts);
    try {
      await render();
      await advance(999);
      expect(useApp.getState().screen).toBe('battle');
      await advance(1);
      expect(useApp.getState().screen).toBe('base');
      expect(toasts).toHaveBeenCalledExactlyOnceWith({ msg: 'DEPLOY WINDOW CLOSED — CHECK YOUR ARMY AT THE BARRACKS, THEN RETRY' });
      expect(postsTo('finish')).toHaveLength(0);
      await advance(2_000);
      expect(toasts).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });

  it('a reload mid-battle rebuilds the field from the journal and keeps fighting', async () => {
    // WHY: before D-099 a reload mid-raid came back to an empty field and the
    // raid expired. The journal is the server's copy of what was placed; the
    // battle clock is recovered from its stamps (acceptedAt − offset) so the
    // next reserve lands at a truthful offset rather than at t≈0 again.
    const battleStart = T0 - 20_000;
    const journal = [
      journaled(0, { troop: 'highlander', tx: 0, ty: 0, tMs: 0 }, battleStart - 8_000),
      journaled(1, { troop: 'highlander', tx: 1, ty: 1, tMs: 5_000 }, battleStart + 5_000),
    ];
    mocks.get.mockImplementation((path: string) => {
      if (path === `/raids/pending/${raidId}`) return Promise.resolve({ raid: campaignRaid() });
      if (path === `/raids/${raidId}/live?afterSequence=-1`) return Promise.resolve(liveView(journal));
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    useApp.setState({ raidTarget: { kind: 'campaign', stage: 1, raidId } });
    await render();

    expect(mocks.postRaw.mock.calls.some(([path]) => path === '/campaign/1/raid')).toBe(false);
    expect(mocks.simulateRaid).toHaveBeenCalledWith(
      campaignRaid().snapshot,
      { deploys: [
        { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: 5_000 },
      ], heroDeploys: [] },
      7,
      { troopLevels: { highlander: 1 } },
    );
    expect(host.textContent).toContain('×1');
    expect(button('ATTACK')).toBeUndefined(); // the fight is on — RETREAT only
    expect(commandPosts()).toHaveLength(0); // restored drops are never journaled twice

    await tap(2, 2);
    expect(commandPosts().at(-1)?.command).toEqual({
      kind: 'deploy', payload: { troop: 'highlander', tx: 2, ty: 2, tMs: 20_000 },
    });
    // The recovered clock is already past the local stream's end, so the
    // commit rides the 10-tick tail and FINISH follows.
    await advance(10 * TICK_MS);
    await flush();
    expect(postsTo('finish')).toHaveLength(1);
  });

  it('a reload inside the deploy window puts the drops back and waits for ATTACK', async () => {
    // WHY: nothing but t=0 drops means ATTACK was never pressed. The field
    // shows them again and the deploy window carries on — the restored drops
    // are the server's already, so only NEW drops are journaled.
    const journal = [journaled(0, { troop: 'highlander', tx: 0, ty: 0, tMs: 0 }, T0 - 5_000)];
    mocks.get.mockImplementation((path: string) => {
      if (path === `/raids/pending/${raidId}`) return Promise.resolve({ raid: campaignRaid() });
      if (path === `/raids/${raidId}/live?afterSequence=-1`) return Promise.resolve(liveView(journal));
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    useApp.setState({ raidTarget: { kind: 'campaign', stage: 1, raidId } });
    const marks: unknown[] = [];
    const off = bus.on('battle:mark', (mark) => { marks.push(mark); });
    await render();

    expect(mocks.simulateRaid).not.toHaveBeenCalled();
    expect(host.textContent).toContain('×2');
    await advance(80);
    expect(marks).toEqual([{ troop: 'highlander', tx: 0, ty: 0 }]);
    off();

    await tap(1, 1);
    expect(commandPosts().map((write) => write.command.payload))
      .toEqual([{ troop: 'highlander', tx: 1, ty: 1, tMs: 0 }]);
    await attack();
    expect(mocks.simulateRaid).toHaveBeenCalledWith(
      campaignRaid().snapshot,
      { deploys: [
        { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: 0 },
      ] },
      7,
      { troopLevels: { highlander: 1 } },
    );
  });

  it('unlocks STAY after a queued retreat times out and never sends that retreat later', async () => {
    const server = serveV2Journal();
    const defaultPost = mocks.postRaw.getMockImplementation()!;
    let resolveDrop!: (value: unknown) => void;
    let drop!: JournalWrite;
    mocks.postRaw.mockImplementation((path: string, body: JournalWrite) => {
      if (path === `/raids/${raidId}/commands`) {
        drop = body;
        return new Promise((resolve) => { resolveDrop = resolve; });
      }
      return defaultPost(path, body);
    });
    await render();
    await tap(0, 0);
    await confirmRetreat();
    expect(host.textContent).toContain('CONFIRMING…');
    await advance(12_000);
    expect(host.textContent).not.toContain('CONFIRMING…');
    await act(async () => button('STAY')!.click());
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    const command = accepted(drop, 0);
    server.commands.push(command);
    resolveDrop({ command, clock: server.currentClock() });
    await flush();
    await advance(1_000);
    expect(postsTo('finish'), 'STAY revokes an unsent retreat even when the earlier troop later succeeds').toHaveLength(0);
    expect(useApp.getState().screen).toBe('battle');
    expect(host.textContent).toContain('×2');
  });

  it('keeps an in-flight retreat confirmation reachable when playback ends at the canonical deadline', async () => {
    serveV2Journal();
    const defaultPost = mocks.postRaw.getMockImplementation()!;
    await render();
    await tap(0, 0);
    await attack();
    await advance(85_000);
    mocks.postRaw.mockImplementation((path: string, body: unknown) => path.endsWith('/finish')
      ? new Promise(() => undefined) : defaultPost(path, body));
    await confirmRetreat();
    await advance(5_000);
    await act(async () => bus.emit('battle:done', undefined));
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(button('STAY')).toBeDefined();
    expect(host.textContent).toContain('CONFIRMING…');
    expect(host.textContent).not.toContain('RESOLVING RAID');
    expect(postsTo('finish')).toHaveLength(1);
  });

  it('preserves an uncertain sent retreat and shows its late canonical result without auto-exiting', async () => {
    serveV2Journal();
    const defaultPost = mocks.postRaw.getMockImplementation()!;
    const defaultGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path: string) => path.endsWith('/replay')
      ? Promise.reject(new ApiError(409, 'raid still pending')) : defaultGet(path));
    let resolveFinish!: (value: unknown) => void;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => path.endsWith('/finish')
      ? new Promise((resolve) => { resolveFinish = resolve; }) : defaultPost(path, body));
    const previousWallet = useApp.getState().wallet;
    useApp.setState({ wallet: 'attacker-wallet' });
    const exited = vi.fn();
    const off = bus.on('battle:exit', exited);
    try {
      await render();
      await confirmRetreat();
      expect(postsTo('finish')).toHaveLength(1);
      await advance(12_000);
      expect(host.textContent).not.toContain('CONFIRMING…');
      expect(readRaidResumePointer(localStorage, 'attacker-wallet', attackerBaseId)?.raidId).toBe(raidId);
      expect(mocks.get).toHaveBeenCalledWith(`/bases/${attackerBaseId}/battles/${raidId}/replay`);
      await act(async () => button('STAY')!.click());
      resolveFinish({ result: won });
      await flush();
      expect(useApp.getState().screen).toBe('battle');
      expect(host.textContent).toContain('VICTORY');
      expect(exited).not.toHaveBeenCalled();
      expect(readRaidResumePointer(localStorage, 'attacker-wallet', attackerBaseId)).toBeNull();
    } finally {
      off();
      clearRaidResumePointer(localStorage, 'attacker-wallet', attackerBaseId, raidId);
      useApp.setState({ wallet: previousWallet });
    }
  });

  it('retries uncertain retreat with the same command ID and ignores the older attempt response', async () => {
    serveV2Journal();
    const defaultPost = mocks.postRaw.getMockImplementation()!;
    const defaultGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path: string) => path.endsWith('/replay')
      ? Promise.reject(new ApiError(409, 'raid still pending')) : defaultGet(path));
    const completions: Array<(value: unknown) => void> = [];
    mocks.postRaw.mockImplementation((path: string, body: unknown) => path.endsWith('/finish')
      ? new Promise((resolve) => { completions.push(resolve); }) : defaultPost(path, body));
    await render();
    await confirmRetreat();
    await advance(12_000);
    const retry = [...host.querySelectorAll('[role="alertdialog"] button')]
      .find((b) => b.textContent === 'RETREAT') as HTMLButtonElement;
    await act(async () => retry.click());
    await flush();
    expect(postsTo('finish')).toHaveLength(2);
    expect(postsTo('finish')[1]?.[1]).toEqual(postsTo('finish')[0]?.[1]);
    expect(postsTo('finish')[0]?.[1]).toMatchObject({ retreat: true, clientCommandId: expect.any(String) });
    completions[0]!({ result: won });
    await flush();
    expect(host.textContent).toContain('CONFIRMING…');
    expect(useApp.getState().screen).toBe('battle');
    completions[1]!({ result: won });
    await flush();
    expect(useApp.getState().screen).toBe('base');
  });

  it.each(['screen', 'base', 'wallet', 'unmount'] as const)('fences a late retreat receipt after the %s context changes', async (context) => {
    serveV2Journal();
    const defaultPost = mocks.postRaw.getMockImplementation()!;
    let resolveFinish!: (value: unknown) => void;
    mocks.postRaw.mockImplementation((path: string, body: unknown) => path.endsWith('/finish')
      ? new Promise((resolve) => { resolveFinish = resolve; }) : defaultPost(path, body));
    const previousWallet = useApp.getState().wallet;
    useApp.setState({ wallet: 'attacker-wallet' });
    const exited = vi.fn();
    const off = bus.on('battle:exit', exited);
    try {
      await render();
      await confirmRetreat();
      if (context === 'screen') await act(async () => useApp.setState({ screen: 'mail' }));
      if (context === 'base') await act(async () => useApp.setState({ selectedBaseId: 'newer-base' }));
      if (context === 'wallet') await act(async () => useApp.setState({ wallet: 'newer-wallet' }));
      if (context === 'unmount') {
        await act(async () => root.unmount());
        root = createRoot(host);
      }
      resolveFinish({ result: won });
      await flush();
      await advance(12_000);
      expect(exited).not.toHaveBeenCalled();
      expect(useApp.getState().screen).toBe(context === 'screen' ? 'mail' : 'battle');
      expect(readRaidResumePointer(localStorage, 'attacker-wallet', attackerBaseId)?.raidId).toBe(raidId);
    } finally {
      off();
      clearRaidResumePointer(localStorage, 'attacker-wallet', attackerBaseId, raidId);
      useApp.setState({ wallet: previousWallet });
    }
  });

  it('keeps the whole-list POST when the API does not advertise the journal', async () => {
    // WHY: rolling deploys. An API that never announced the journal would 404
    // or refuse the command writes; the frozen capability is what tells this
    // client which contract the raid was created under.
    mocks.postRaw.mockImplementation((path: string) => {
      if (path === '/campaign/1/raid') {
        // Both units thrown: an empty tray posts at the stream's end (D-106).
        return Promise.resolve({
          raid: campaignRaid({ batchOrdersGraceSec: RAID_RULES.batchOrdersGraceSec }, { highlander: 2 }),
        });
      }
      if (path === `/raids/${raidId}/orders`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    await render();
    await tap(0, 0);
    await tap(1, 1);
    await attack();
    expect(commandPosts()).toHaveLength(0);
    await advance(BATTLE_END_MS);
    expect(postsTo('finish')).toHaveLength(0);
    // The whole list, and every pre-battle drop at the same t=0 here too.
    expect(postsTo('orders')[0]?.[1]).toMatchObject({
      deploys: [
        { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: 0 },
      ],
    });
  });

  /**
   * D-106 — ferdblabla (2026-09-04): "after i put some troops and start, when
   * those troops died it immediate end the raid. User might want release batch
   * by batch". The sim ends a stream when the deploys it was given are all
   * dead; that is the end of THIS batch, not of the fight. While the tray still
   * holds troops or heroes and the battle clock has time left, the field stays
   * open: clock running, tray and RETREAT live, nothing posted. The next
   * reserve re-feeds the stream from its real tick; the TRUE clock end (or an
   * empty tray, 100 %, or RETREAT) closes the fight.
   */
  /** The first batch dies at MAX_TICK; the base stands at 30 %. */
  const wipe = {
    events: [
      { t: 0, e: 'deploy', id: 1, troop: 'highlander', x: 0, y: 0 },
      { t: MAX_TICK, e: 'troopDeath', id: 1 },
    ],
    stars: 0, destructionPct: 30, keepDestroyed: false,
  };
  /** ATTACK at T0: the clock end is 90 s plus the scene's 10-tick verdict tail. */
  const TRUE_END_MS = RAID_RULES.battleDurationSec * 1_000 + 10 * TICK_MS;

  it('keeps a batch fight open after its deployed troops die while reserves remain, feeds the next reserve at its real tick, and finishes at the TRUE clock end (D-106)', async () => {
    // WHY: before this rule the wall-clock timer and battle:done both closed
    // the raid at the first stream's end (BATTLE_END_MS) with two units still
    // in the tray — the tester's "immediate end". The clock end is 90 s.
    mocks.simulateRaid.mockReturnValue(wipe);
    const plays: Array<{ fromTick?: number; fightOpen?: true; appliedPrefix?: true }> = [];
    const offPlay = bus.on('battle:play', (payload) => plays.push(payload));
    try {
      await render();
      await tap(0, 0);
      await attack();
      // The first stream's end (and a second past it) passes with NO post.
      await advance(BATTLE_END_MS + 1_000);
      expect(plays.at(-1), 'the scene is told the fight can outlive this stream').toMatchObject({ fightOpen: true });
      expect(plays.at(-1)?.fromTick ?? 0, 'the ATTACK stream starts at tick zero').toBe(0);
      expect(postsTo('finish')).toHaveLength(0);
      expect(postsTo('orders')).toHaveLength(0);
      await act(async () => bus.emit('battle:done', undefined));
      await flush();
      expect(host.textContent).not.toContain('RESOLVING RAID');
      expect(host.textContent).not.toContain('VICTORY');
      expect(host.textContent).not.toContain('DEFEAT');
      expect(host.textContent).toContain('THE FIGHT IS STILL ON');
      expect(button('RETREAT')).toBeDefined();
      expect(host.querySelector('[data-testid="raid-deploy-roster"]')).not.toBeNull();
      expect(postsTo('finish')).toHaveLength(0);
      // The battle clock keeps counting under the idle field.
      expect(host.textContent).toContain(`0:06 / ${fmtT(RAID_RULES.battleDurationSec)}`);
      expect(host.querySelector('[aria-label^="Battle timer:"]')?.getAttribute('aria-label')).toContain('elapsed / maximum');
      await advance(1_000);
      expect(host.textContent).toContain(`0:07 / ${fmtT(RAID_RULES.battleDurationSec)}`);

      // The next batch lands at the real elapsed offset, is journaled there,
      // and re-feeds the scene FROM that tick — not from the stream's old end.
      mocks.simulateRaid.mockReturnValue({
        events: [
          ...wipe.events,
          { t: 70, e: 'deploy', id: 2, troop: 'highlander', x: 1, y: 1 },
          { t: 70 + MAX_TICK, e: 'troopDeath', id: 2 },
        ],
        stars: 0, destructionPct: 45, keepDestroyed: false,
      });
      await tap(1, 1);
      expect(host.textContent).not.toContain('THE FIGHT IS STILL ON');
      expect(commandPosts().at(-1)?.command).toEqual({
        kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1, tMs: 7_000 },
      });
      expect(mocks.simulateRaid).toHaveBeenLastCalledWith(
        campaignRaid().snapshot,
        expect.objectContaining({ deploys: [
          { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
          { troop: 'highlander', tx: 1, ty: 1, tMs: 7_000 },
        ] }),
        7,
        expect.anything(),
      );
      expect(plays.at(-1), 'one highlander is still in the tray').toMatchObject({
        fromTick: 70, appliedPrefix: true, fightOpen: true,
      });
      // That batch dies too: one reserve left, clock still running — still open.
      await advance(BATTLE_END_MS);
      await act(async () => bus.emit('battle:done', undefined));
      await flush();
      expect(postsTo('finish')).toHaveLength(0);
      expect(host.textContent).toContain('THE FIGHT IS STILL ON');

      // Nothing more is released: the TRUE clock end closes the fight and
      // posts FINISH behind the journal, then the verdict follows.
      await advance(TRUE_END_MS - 7_000 - BATTLE_END_MS - 250);
      expect(postsTo('finish')).toHaveLength(0);
      expect(button('RETREAT')).toBeDefined();
      await advance(500);
      expect(postsTo('finish')).toEqual([[`/raids/${raidId}/finish`, {}]]);
      await flush();
      expect(host.textContent).toContain('VICTORY');
      expect(host.textContent).not.toContain('THE FIGHT IS STILL ON');
    } finally { offPlay(); }
  });

  it('closes a batch fight at its stream end when the tray is empty or the base is at 100 %, reserves or not (D-106 a/c)', async () => {
    // WHY: the hold exists only for a fight that can still change. An empty
    // tray keeps today's rule; a flattened base has nothing left to fight.
    mocks.simulateRaid.mockReturnValue({
      events: localEvents, stars: 3, destructionPct: 100, keepDestroyed: true,
    });
    await render();
    await tap(0, 0);
    await attack();
    await advance(BATTLE_END_MS);
    // Two units still in the tray, but 100 %: the wall-clock post is at the
    // stream's end, and battle:done shows the verdict.
    expect(postsTo('finish')).toEqual([[`/raids/${raidId}/finish`, {}]]);
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('VICTORY');
    expect(host.textContent).not.toContain('THE FIGHT IS STILL ON');
  });

  it.each(['available', 'busy', 'missing', 'loading'] as const)('TRAIN ARMY after results handles the %s Barracks destination without a hidden training request', async (destination) => {
    // The first completed Barracks may be upgrading. Its action sheet cannot
    // open training, so choose an idle one or explain the required next action.
    const previousWallet = useApp.getState().wallet;
    const notices: string[] = [];
    const focused: string[] = [];
    const offToast = bus.on('ui:toast', ({ msg }) => notices.push(msg));
    const offFocus = bus.on('base:focus', ({ id }) => focused.push(id));
    useApp.setState({ wallet: base.player.wallet, trainingRequested: false });
    mocks.simulateRaid.mockReturnValue({
      events: localEvents, stars: 3, destructionPct: 100, keepDestroyed: true,
    });
    try {
      await render(); await tap(0, 0); await attack(); await advance(BATTLE_END_MS);
      await act(async () => bus.emit('battle:done', undefined)); await flush();
      expect(host.textContent).toContain('VICTORY');
      const barracks = { id: 'upgrading-barracks', type: 'barracks', level: 1, tx: 5, ty: 5, underConstruction: false };
      const home: BaseStateDto = { ...base, buildings: destination === 'missing' ? [] : [barracks],
        jobs: destination === 'missing' ? [] : [{ id: 'upgrade', kind: 'upgrade', buildingId: barracks.id,
          obstacleId: null, startedAt: new Date(T0).toISOString(), finishesAt: new Date(T0 + 60_000).toISOString() }] };
      if (destination === 'available') home.buildings.push({ ...barracks, id: 'idle-barracks', tx: 8 });
      await act(async () => useApp.setState({ base: destination === 'loading' ? null : home }));
      const writesBefore = mocks.postRaw.mock.calls.length;
      await act(async () => button('TRAIN ARMY')!.click()); await flush();
      expect(useApp.getState().screen).toBe('base');
      expect(mocks.postRaw.mock.calls).toHaveLength(writesBefore); // navigation never buys troops or repeats settlement
      if (destination === 'available') {
        expect(useApp.getState().selectedBuildingId).toBe('idle-barracks');
        expect(useApp.getState().trainingRequested).toBe(true);
        expect(focused).toEqual(['idle-barracks']);
        expect(notices).toEqual([]);
      } else {
        expect(useApp.getState().trainingRequested).toBe(false);
        expect(notices).toEqual([destination === 'busy' ? 'FINISH BARRACKS WORK, THEN OPEN TRAINING'
          : destination === 'missing' ? 'BUILD A BARRACKS TO TRAIN TROOPS'
            : 'BASE IS LOADING — OPEN YOUR BARRACKS WHEN IT IS READY']);
      }
    } finally {
      offToast(); offFocus();
      useApp.setState({ wallet: previousWallet, trainingRequested: false });
    }
  });

  it.each(['available', 'busy'] as const)('defers the complete TRAIN ARMY result command for %s barracks', async destination => {
    const previousWallet = useApp.getState().wallet;
    useApp.setState({ wallet: base.player.wallet, trainingRequested: false });
    mocks.simulateRaid.mockReturnValue({ events: localEvents, stars: 3, destructionPct: 100, keepDestroyed: true });
    await render(); await tap(0, 0); await attack(); await advance(BATTLE_END_MS);
    await act(async () => bus.emit('battle:done', undefined)); await flush();
    const barracks = { id: 'train-target', type: 'barracks', level: 1, tx: 5, ty: 5, underConstruction: false };
    const panel = { kind: 'hub' as const, featureId: 'draft' }; const pending: PanelDismissRequest[] = [];
    await act(async () => useApp.setState({ basePanel: panel, base: { ...base, buildings: [barracks], jobs: destination === 'available' ? [] : [{ id: 'job', kind: 'upgrade', buildingId: barracks.id,
      obstacleId: null, startedAt: new Date(T0).toISOString(), finishesAt: new Date(T0 + 60_000).toISOString() }] } as BaseStateDto }));
    const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel, canMutate: () => false, canRecover: () => false });
    const off = session.mount(); session.setDismissPolicy(request => pending.push(request));
    const focused: string[] = []; const offFocus = bus.on('base:focus', ({ id }) => focused.push(id));
    try {
      const writesBefore = mocks.postRaw.mock.calls.length;
      await act(async () => button('TRAIN ARMY')!.click());
      expect(pending).toHaveLength(1); expect(pending[0]?.reason).toBe('navigate');
      expect(useApp.getState().screen).toBe('battle'); expect(useApp.getState().trainingRequested).toBe(false);
      expect(focused).toEqual([]); expect(useApp.getState().basePanel).toBe(panel);
      await act(async () => { expect(pending[0]?.proceed()).toBe(true); });
      expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().selectedBuildingId).toBe(barracks.id);
      expect(useApp.getState().trainingRequested).toBe(destination === 'available'); expect(focused).toEqual([barracks.id]);
      expect(pending[0]?.proceed()).toBe(false); expect(mocks.postRaw.mock.calls).toHaveLength(writesBefore);
    } finally { off(); offFocus(); useApp.setState({ wallet: previousWallet, trainingRequested: false, basePanel: null }); }
  });

  it('RETREAT from an open field commits the fight exactly as a retreat always has (D-106 d)', async () => {
    // WHY: the hold changes when a fight ENDS, never what ending means — a
    // started raid is posted on the way out, so the energy already spent
    // records the fight the player actually had.
    mocks.simulateRaid.mockReturnValue(wipe);
    await render();
    await tap(0, 0);
    await attack();
    await advance(BATTLE_END_MS + 1_000);
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('THE FIGHT IS STILL ON');
    expect(postsTo('finish')).toHaveLength(0);
    await confirmRetreat();
    expect(postsTo('finish')).toEqual([[`/raids/${raidId}/finish`, {}]]);
    expect(useApp.getState().screen).toBe('base');
  });

  it('an undropped hero alone keeps the field open (D-106 a counts heroes)', async () => {
    // WHY: heroes are first-class deploys everywhere else (ATTACK gate, the
    // POST); a hero card still lit is a reserve the player may want to release.
    const raid = campaignRaid(journalFeatures, { highlander: 1 });
    mocks.postRaw.mockImplementation((path: string, body: unknown) => {
      if (path === '/campaign/1/raid') {
        return Promise.resolve({ raid: { ...raid, armySnapshot: { ...raid.armySnapshot, heroes: ['vex'] } } });
      }
      if (path === `/raids/${raidId}/commands`) return Promise.resolve({ command: accepted(body as JournalWrite, 0) });
      if (path === `/raids/${raidId}/finish`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    mocks.simulateRaid.mockReturnValue(wipe);
    await render();
    await tap(0, 0);
    await attack();
    await advance(BATTLE_END_MS + 1_000);
    expect(postsTo('finish')).toHaveLength(0);
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('THE FIGHT IS STILL ON');
    expect(host.textContent).toContain('×0'); // the last highlander is gone…
    expect(host.textContent).toContain('VEX'); // …the hero card is what holds it
    expect(postsTo('finish')).toHaveLength(0);
  });
});
