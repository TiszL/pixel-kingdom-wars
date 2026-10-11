/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_VERSION } from '@shardkeep/sim';
import { ApiError } from '../lib/api';
import { bus } from '../lib/events';
import { useApp, type BaseStateDto } from '../state/store';

/**
 * D-096 "battle clock". A batch/campaign raid is posted from `battle:done`,
 * which BattleScene schedules on Phaser's scene clock — and Phaser PAUSES that
 * clock while the tab is hidden. A player who switched tabs mid-fight came back
 * to a HUD that already said 100 % (RaidUI's progress timers are wall-clock),
 * a late battle:done, and a POST the server refused with 422 'deploy window
 * expired' because its 130 s orders deadline had passed: campaign progress was
 * never written. These tests run the RaidUI side of the fix under fake timers
 * with NO scene at all — the scene's only job here is to be absent or late.
 */
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

const attackerBaseId = '00000000-0000-4000-8000-000000000001';
const raidId = '00000000-0000-4000-8000-000000000003';
/** Sim playback clock — mirrors RaidUI/BattleScene TICK_MS. */
const TICK_MS = 100;
/** The local stream's last tick decides the battle end both RaidUI's wall-clock
 *  timers and BattleScene's `battle:done` are scheduled from: (maxTick + 10) ticks. */
const MAX_TICK = 40;
const BATTLE_END_MS = (MAX_TICK + 10) * TICK_MS;
const localEvents = [
  { t: 0, e: 'deploy', id: 1, troop: 'highlander', x: 0, y: 0 },
  { t: MAX_TICK, e: 'destroyed', id: 'keep' },
];
const won = { stars: 2, destructionPct: 71, keepDestroyed: true, lootShards: 0, attackerTrophyDelta: 0 };

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

/** A campaign raid (campaignStage set) is the BATCH path: no live command
 *  stream, so the whole order list is posted once at the battle end. The
 *  roster defaults to the ONE unit `fight()` throws: with a reserve still in
 *  the tray the fight stays open to the TRUE clock end instead (D-106). */
function campaignRaid(counts: Record<string, number> = { highlander: 1 }) {
  return {
    id: raidId,
    attackerBaseId,
    defenderBaseId: null,
    defenderWallet: 'campaign',
    pveCampId: null,
    campaignStage: 1,
    snapshot: { buildings: [], claimMin: 4, claimMax: 18 },
    armySnapshot: { counts, levels: { highlander: 1 }, heroes: [] },
    ordersDeadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    seed: 7,
    simVersion: SIM_VERSION,
  };
}

/** Let the fake clock hand out due timers and let promise chains settle. Two
 *  passes: an api mock resolves in one microtask, its `.then` that sets React
 *  state in the next. */
async function flush(): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const ordersPosts = (): unknown[][] => mocks.postRaw.mock.calls
  .filter(([path]) => String(path) === `/raids/${raidId}/orders`);

describe('batch raid commit is wall-clock authoritative (D-096)', () => {
  let host: HTMLDivElement;
  let root: Root;

  /** Deploy one troop in the pre-battle window and press ATTACK, which starts
   *  the local sim playback and the wall-clock battle timers. */
  async function fight(): Promise<void> {
    await act(async () => bus.emit('battle:tap', { tx: 0, ty: 0 }));
    const attack = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ATTACK'));
    expect(attack).toBeDefined();
    await act(async () => attack!.click());
    await flush();
    expect(mocks.simulateRaid).toHaveBeenCalledOnce();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    mocks.get.mockReset(); mocks.post.mockReset(); mocks.postRaw.mockReset();
    mocks.simulateRaid.mockReset();
    mocks.idemKey.mockReset().mockReturnValue('stable-commit-key');
    mocks.get.mockRejectedValue(new Error('unexpected GET'));
    mocks.simulateRaid.mockReturnValue({
      events: localEvents, stars: won.stars, destructionPct: won.destructionPct, keepDestroyed: true,
    });
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
    vi.useRealTimers();
  });

  it('a batch raid commits at the wall-clock battle end even if the scene never emits battle:done', async () => {
    // WHY: with the tab hidden Phaser's clock is paused, so battle:done — the
    // only thing that used to post the raid — arrives after the server's
    // 130 s orders deadline and the raid expires unrecorded. The wall clock
    // keeps running in a hidden tab; the commit must ride on it.
    mocks.postRaw.mockImplementation((path: string) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid() });
      if (path === `/raids/${raidId}/orders`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    await act(async () => root.render(<RaidUI />));
    await flush();
    await fight();

    await advance(BATTLE_END_MS - 1);
    expect(ordersPosts()).toHaveLength(0);
    await advance(1);
    expect(ordersPosts()).toHaveLength(1);
    expect(ordersPosts()[0]![1]).toMatchObject({
      deploys: [{ troop: 'highlander', tx: 0, ty: 0 }],
      idempotencyKey: 'stable-commit-key',
    });

    // No scene, so no battle:done: the result is held, the verdict is not
    // rendered off it (the field may still be catching up), and nothing
    // posts a second time however long the scene stays silent.
    await advance(30_000);
    expect(ordersPosts()).toHaveLength(1);
    expect(host.textContent).not.toContain('VICTORY');
    expect(host.textContent).not.toContain('DEFEAT');

    // The late battle:done finds the result already there and shows it —
    // without another POST (commitRaid's committedRef guard).
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('VICTORY');
    expect(ordersPosts()).toHaveLength(1);
  });

  it('battle:done after a wall-clock commit waits for the result instead of showing an empty verdict', async () => {
    // WHY: on a visible tab the wall-clock timer and the scene's battle:done
    // fire within a frame of each other, so battle:done routinely lands while
    // the POST is still in flight. Rendering `(result?.stars ?? 0) > 0` against
    // a null result is exactly what once showed DEFEAT on a won raid.
    let answer!: (value: { result: typeof won }) => void;
    const inFlight = new Promise<{ result: typeof won }>((resolve) => { answer = resolve; });
    mocks.postRaw.mockImplementation((path: string) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid() });
      if (path === `/raids/${raidId}/orders`) return inFlight;
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    await act(async () => root.render(<RaidUI />));
    await flush();
    await fight();

    await advance(BATTLE_END_MS);
    expect(ordersPosts()).toHaveLength(1);

    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('RESOLVING RAID…');
    expect(host.textContent).not.toContain('VICTORY');
    expect(host.textContent).not.toContain('DEFEAT');

    answer({ result: won });
    await flush();
    expect(host.textContent).toContain('VICTORY');
    expect(ordersPosts()).toHaveLength(1);
  });

  it('a mid-battle reserve that extends the fight moves the wall-clock commit to the new end', async () => {
    // WHY: the first stream ends when the first wave dies. A reserve dropped
    // before that re-feeds a LONGER stream (the sim's prefix invariant), and
    // the battle:done commit followed the new end for free. The wall-clock
    // commit must follow it too, or it posts mid-fight and every order placed
    // after the old end is silently missing from the authoritative result.
    mocks.postRaw.mockImplementation((path: string) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid({ highlander: 2 }) });
      if (path === `/raids/${raidId}/orders`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    await act(async () => root.render(<RaidUI />));
    await flush();
    await fight();

    const reserveAtMs = 1_000; // tick 10
    await advance(reserveAtMs);
    const extendedMaxTick = MAX_TICK * 2;
    mocks.simulateRaid.mockReturnValue({
      events: [...localEvents, { t: extendedMaxTick, e: 'destroyed', id: 'tower' }],
      stars: won.stars, destructionPct: won.destructionPct, keepDestroyed: true,
    });
    await act(async () => bus.emit('battle:tap', { tx: 1, ty: 1 }));
    expect(mocks.simulateRaid).toHaveBeenCalledTimes(2);

    // The FIRST stream's end passes without a post…
    await advance(BATTLE_END_MS - reserveAtMs);
    expect(ordersPosts()).toHaveLength(0);
    // …and the extended stream's end, rebased from the reserve's tick, posts
    // BOTH orders.
    const reserveTick = reserveAtMs / TICK_MS;
    const newEndMs = reserveAtMs + (extendedMaxTick - reserveTick + 10) * TICK_MS;
    await advance(newEndMs - BATTLE_END_MS);
    expect(ordersPosts()).toHaveLength(1);
    expect(ordersPosts()[0]![1]).toMatchObject({
      deploys: [{ troop: 'highlander', tx: 0, ty: 0 }, { troop: 'highlander', tx: 1, ty: 1, tMs: reserveAtMs }],
    });
  });

  it('a batch fight with a reserve in the tray stays open past its stream end; the reserve released later is carried by the one whole-list POST (D-106)', async () => {
    // WHY (ferdblabla 2026-09-04: "when those troops died it immediate end
    // the raid"): the first wave dying ends the STREAM, not the fight, while
    // a unit is still in the tray and the clock is running. The wall-clock
    // commit therefore waits at the TRUE clock end (90 s + the 10-tick tail);
    // a reserve released after the old end empties the tray, so the commit
    // returns to that stream's end and posts BOTH deploys.
    mocks.postRaw.mockImplementation((path: string) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid({ highlander: 2 }) });
      if (path === `/raids/${raidId}/orders`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    mocks.simulateRaid.mockReturnValue({
      events: [localEvents[0]!, { t: MAX_TICK, e: 'troopDeath', id: 1 }],
      stars: 0, destructionPct: 30, keepDestroyed: false,
    });
    await act(async () => root.render(<RaidUI />));
    await flush();
    await fight();

    // The stream's end passes and a second more: nothing is posted, the
    // field is held open and says so, the tray and RETREAT are still there.
    await advance(BATTLE_END_MS + 1_000);
    expect(ordersPosts()).toHaveLength(0);
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(ordersPosts()).toHaveLength(0);
    expect(host.textContent).toContain('THE FIGHT IS STILL ON');
    expect(host.textContent).not.toContain('VICTORY');
    expect(host.textContent).not.toContain('DEFEAT');
    expect(host.textContent).not.toContain('RESOLVING RAID');
    expect(host.querySelector('[data-testid="raid-deploy-roster"]')).not.toBeNull();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('RETREAT'))).toBe(true);

    // The last unit is released at 6 s (tick 60) and dies at tick 100: the
    // tray is empty, so that stream's end (tick 110) is the fight's end.
    const reserveAtMs = BATTLE_END_MS + 1_000;
    const reserveTick = reserveAtMs / TICK_MS;
    mocks.simulateRaid.mockReturnValue({
      events: [
        localEvents[0]!, { t: MAX_TICK, e: 'troopDeath', id: 1 },
        { t: reserveTick, e: 'deploy', id: 2, troop: 'highlander', x: 1, y: 1 },
        { t: reserveTick + MAX_TICK, e: 'troopDeath', id: 2 },
      ],
      stars: 0, destructionPct: 45, keepDestroyed: false,
    });
    await act(async () => bus.emit('battle:tap', { tx: 1, ty: 1 }));
    expect(mocks.simulateRaid).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('THE FIGHT IS STILL ON');
    const secondEndMs = (MAX_TICK + 10) * TICK_MS;
    await advance(secondEndMs - 1);
    expect(ordersPosts()).toHaveLength(0);
    await advance(1);
    expect(ordersPosts()).toHaveLength(1);
    expect(ordersPosts()[0]![1]).toMatchObject({
      deploys: [
        { troop: 'highlander', tx: 0, ty: 0, tMs: 0 },
        { troop: 'highlander', tx: 1, ty: 1, tMs: reserveAtMs },
      ],
    });
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('VICTORY');
    expect(ordersPosts()).toHaveLength(1);
  });

  it('an expired raid says so honestly and offers no retry that cannot succeed', async () => {
    // WHY: once the server answers 'deploy window expired' the row is already
    // `expired` and the energy refunded — every further POST 422s the same
    // way. Offering RETRY would loop the player on a dead raid, and a bare
    // server string does not tell them what happened to their stage.
    mocks.postRaw.mockImplementation((path: string) => {
      if (path === '/campaign/1/raid') return Promise.resolve({ raid: campaignRaid() });
      if (path === `/raids/${raidId}/orders`) return Promise.reject(new ApiError(422, 'deploy window expired'));
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    await act(async () => root.render(<RaidUI />));
    await flush();
    await fight();

    await advance(BATTLE_END_MS);
    await flush();
    expect(ordersPosts()).toHaveLength(1);
    expect(host.textContent).toContain('BATTLE TIMED OUT — RESULT NOT RECORDED · ENERGY REFUNDED');
    expect(host.textContent).not.toContain('RETRY');
    expect(host.textContent).toContain('BACK TO BASE');

    // battle:done must not re-post a raid the server has already closed.
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(ordersPosts()).toHaveLength(1);
    expect(host.textContent).toContain('BATTLE TIMED OUT');
  });

  it('shows CATCHING UP… beside the timer only while the scene reports an 8× catch-up, and never past the verdict (D-099)', async () => {
    // WHY: a return DURING the fight replays the missed span at 8× (D-096);
    // unlabeled, that fast-forward read as a broken fight (player report,
    // D-099). The pill follows the scene's 'battle:catchup' signal — and it
    // is scene-owned state, so battle:done must clear it itself: a verdict,
    // or the next raid's deploy HUD, must never inherit a pill whose closing
    // `false` was lost with the scene.
    mocks.postRaw.mockImplementation((path: string) => {
      // NEXT STAGE below creates the stage-2 raid through the same path.
      if (path === '/campaign/1/raid' || path === '/campaign/2/raid') return Promise.resolve({ raid: campaignRaid() });
      if (path === `/raids/${raidId}/orders`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    await act(async () => root.render(<RaidUI />));
    await flush();
    await fight();
    expect(host.textContent).not.toContain('CATCHING UP…');

    await act(async () => bus.emit('battle:catchup', { active: true }));
    expect(host.textContent).toContain('CATCHING UP…');
    await act(async () => bus.emit('battle:catchup', { active: false }));
    expect(host.textContent).not.toContain('CATCHING UP…');

    // The scene's closing `false` never arrives: the verdict still clears it.
    await act(async () => bus.emit('battle:catchup', { active: true }));
    await advance(BATTLE_END_MS);
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('VICTORY');
    expect(host.textContent).not.toContain('CATCHING UP…');

    // NEXT STAGE re-creates a raid and brings the deploy HUD back — with the
    // timer pill, and without a pill inherited from the last fight.
    const next = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('NEXT STAGE'));
    expect(next).toBeDefined();
    await act(async () => next!.click());
    await flush();
    expect(host.textContent).toContain('END');
    expect(host.textContent).not.toContain('CATCHING UP…');
  });
  it('Next Raid starts one fresh automatic create and shows an empty queue instead of the old victory', async () => {
    useApp.setState({ raidTarget: null });
    let keyNumber = 0;
    mocks.idemKey.mockImplementation(() => `intent-${++keyNumber}`);
    const automaticRaid = { ...campaignRaid(), campaignStage: null, defenderWallet: 'defender' };
    const createKeys: string[] = [];
    let rejectNext: ((error: Error) => void) | undefined;
    mocks.postRaw.mockImplementation((path: string, body: { idempotencyKey?: string }) => {
      if (path === '/raids') {
        createKeys.push(body.idempotencyKey!);
        // A real server idempotently returns the old raid for its old key.
        if (createKeys.length === 1 || body.idempotencyKey === createKeys[0]) {
          return Promise.resolve({ raid: automaticRaid });
        }
        return new Promise((_resolve, reject) => { rejectNext = reject; });
      }
      if (path === `/raids/${raidId}/orders`) return Promise.resolve({ result: won });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    const exited = vi.fn();
    const off = bus.on('battle:exit', exited);
    await act(async () => root.render(<RaidUI />));
    await flush();
    await fight();
    await advance(BATTLE_END_MS);
    await act(async () => bus.emit('battle:done', undefined));
    await flush();
    expect(host.textContent).toContain('VICTORY');
    const next = [...host.querySelectorAll('button')].find((button) => button.textContent === 'NEXT RAID');
    expect(next).toBeDefined();
    await act(async () => { next!.click(); next!.click(); });
    await flush();
    expect(createKeys).toHaveLength(2);
    expect(createKeys[1]).not.toBe(createKeys[0]);
    expect(exited).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('FINDING A TARGET');
    expect(host.textContent).not.toContain('VICTORY');
    await act(async () => rejectNext!(new ApiError(404, 'NO OTHER TARGET AVAILABLE', 'no_targets')));
    await flush();
    expect(host.textContent).toContain('NO OTHER TARGET AVAILABLE');
    expect(host.textContent).toContain('WORLD MAP');
    expect(host.textContent).not.toContain('RESOLVING');
    expect(ordersPosts()).toHaveLength(1); // no settlement or charge replay
    off();
  });

  it('measures deployment guidance with the HUD so it cannot conceal a valid north-edge drop', async () => {
    mocks.postRaw.mockResolvedValue({ raid: campaignRaid() });
    await act(async () => root.render(<RaidUI />));
    await flush();
    const hint = host.querySelector('[data-testid="raid-deployment-hint"]');
    expect(hint?.closest('[data-testid="battle-hud"]')).not.toBeNull();
    expect(hint?.textContent).toContain('TAP THE FIELD TO DEPLOY');
    expect((hint as HTMLElement).style.position).not.toBe('absolute');
  });

});
