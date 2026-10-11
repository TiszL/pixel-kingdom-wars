/** @vitest-environment happy-dom */
/**
 * The two ARMY entry points that spend KEEP — BARRACKS ⚡ FINISH ALL and
 * FORGE ⚡ FINISH — must ask before they charge (player report 2026-08-29: "I
 * accidentally spent KEEP to instantly finish a building because there was no
 * confirmation warning before the purchase").
 *
 * WHY pinned here rather than in army.test.tsx's helper suite: the accident is
 * a WIRING fact, not a pricing one. The helpers were always right about the
 * cost; what was missing was that a single tap reached the server. So these
 * tests assert POST counts around a real render — no confirmation, no dialog
 * text, or a Cancel that still posts would each restore the reported bug.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setKeepConfirm } from '../../lib/keepConfirm';
import { useApp } from '../../state/store';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), begin: vi.fn(), history: vi.fn(), researchEnabled: true, trainingBegin: vi.fn(), trainingHistory: vi.fn(), trainingEnabled: true }));
vi.mock('../../lib/trainingFinish/context', () => ({ useTrainingFinishView: () => ({ begin: mocks.trainingBegin, openHistory: mocks.trainingHistory, actionsEnabled: mocks.trainingEnabled, state: { busy: false, loaded: true }, snapshotRevision: 0 }) }));
vi.mock('../../lib/researchSpeedup/context', () => ({ useResearchSpeedupView: () => ({ begin: mocks.begin, openHistory: mocks.history, actionsEnabled: mocks.researchEnabled, state: { busy: false, loaded: true }, snapshotRevision: 0 }) }));

vi.mock('../../lib/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  idemKey: () => 'test-intent-key',
}));
// army.tsx pulls reloadBase from the sheet module, which reaches wallet
// adapters through the purchase hooks — these suites never buy anything.
vi.mock('../sheets', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
import { ResearchTray, TrainTray } from './army';

let host: HTMLDivElement;
let root: Root;

/** 85 s of remaining time keeps ceil(remaining/30) at 3 units for the whole
 *  run, so every asserted price equals speedupCostKeep for every tick a test
 *  can observe. */
const REM_SEC = 85;
const at = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();

function armyState(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    counts: {}, levels: {}, research: [], queue: [],
    rosterPts: 0, campCapacityPts: 200, barracksQueuePts: 200,
    eliteUnlocks: {}, features: {},
    ...overrides,
  };
}

const keepDialog = (): HTMLElement | null => document.querySelector('[role="alertdialog"]');
function trayBtn(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')]
    .find((button) => button.textContent?.includes(label));
  if (!found) throw new Error(`no ${label} button in the tray`);
  return found;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  mocks.get.mockReset(); mocks.begin.mockReset(); mocks.history.mockReset(); mocks.researchEnabled = true; mocks.trainingBegin.mockReset(); mocks.trainingHistory.mockReset(); mocks.trainingEnabled = true;
  mocks.post.mockReset().mockResolvedValue({});
  localStorage.clear(); // the KEEP-confirm opt-out is a localStorage preference
  // A known-fat balance keeps finishShortfall from disabling FINISH for a
  // reason unrelated to what these tests are about.
  useApp.setState({ balances: { shards: '0', keep: '9999999', keepRate: 0 } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useApp.setState({ base: null, balances: null, selectedBaseId: null });
});

describe('BARRACKS paid Finish All delegates to durable currency review', () => {
  const baseId = '00000000-0000-4000-8000-000000000123';
  const queued = () => armyState({ queue: [{ id: 'q1', troop: 'bowman', startedAt: at(-30_000), finishesAt: at(REM_SEC * 1000) }] });
  it('asks for a fresh server quote without paying or displaying a local KEEP price', async () => {
    useApp.getState().setSelectedBaseId(baseId, false); mocks.get.mockResolvedValue(queued());
    await act(async () => root.render(<TrainTray />));
    expect(trayBtn('FINISH ALL').textContent).toContain('REVIEW');
    await act(async () => trayBtn('FINISH ALL').click());
    expect(mocks.trainingBegin).toHaveBeenCalledExactlyOnceWith({ baseId }); expect(mocks.post).not.toHaveBeenCalled(); expect(keepDialog()).toBeNull();
  });
  it('paused payment admission keeps saved history reachable without a new review', async () => {
    useApp.getState().setSelectedBaseId(baseId, false); mocks.trainingEnabled = false; mocks.get.mockResolvedValue(queued());
    await act(async () => root.render(<TrainTray />));
    expect(trayBtn('FINISH ALL').disabled).toBe(true); await act(async () => trayBtn('TRAINING PAYMENTS').click());
    expect(mocks.trainingHistory).toHaveBeenCalledOnce(); expect(mocks.trainingBegin).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it('legacy KEEP opt-out never bypasses the new explicit currency review', async () => {
    useApp.getState().setSelectedBaseId(baseId, false); setKeepConfirm(false); mocks.get.mockResolvedValue(queued());
    await act(async () => root.render(<TrainTray />)); await act(async () => trayBtn('FINISH ALL').click());
    expect(mocks.trainingBegin).toHaveBeenCalledOnce(); expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('Alchemy Lab research uses durable exact-currency review', () => {
  const researching = (): Record<string, unknown> => armyState({
    levels: { bowman: 3 },
    research: [{ troop: 'bowman', toLevel: 4, finishesAt: at(REM_SEC * 1000) }],
  });
  const baseId = '00000000-0000-4000-8000-000000000123';

  it('hands the original troop and selected kingdom to review without directly paying', async () => {
    useApp.getState().setSelectedBaseId(baseId, false);
    mocks.get.mockResolvedValue(researching());
    await act(async () => root.render(<ResearchTray />));
    await act(async () => trayBtn('FINISH · REVIEW').click());
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith({ troop: 'bowman', baseId });
    expect(keepDialog()).toBeNull(); expect(mocks.post).not.toHaveBeenCalled();
  });

  it('paused admission leaves history reachable without allowing a new review', async () => {
    useApp.getState().setSelectedBaseId(baseId, false); mocks.researchEnabled = false;
    mocks.get.mockResolvedValue(researching());
    await act(async () => root.render(<ResearchTray />));
    expect(trayBtn('FINISH · REVIEW').disabled).toBe(true);
    await act(async () => trayBtn('RESEARCH PAYMENTS & RECEIPTS').click());
    expect(mocks.history).toHaveBeenCalledOnce(); expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });

  it('legacy KEEP opt-out and zero KEEP never bypass review or block an affordable Gems choice', async () => {
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.setState({ balances: { shards: '0', keep: '0', gems: '9999', keepRate: 1 } });
    setKeepConfirm(false);
    mocks.get.mockResolvedValue(researching());
    await act(async () => root.render(<ResearchTray />));
    expect(trayBtn('FINISH · REVIEW').disabled).toBe(false);
    await act(async () => trayBtn('FINISH · REVIEW').click());
    await act(async () => trayBtn('FINISH · REVIEW').click());
    expect(mocks.begin).toHaveBeenCalledTimes(2); expect(mocks.post).not.toHaveBeenCalled();
  });

  it('leaves the separate SHARDS research start one tap away', async () => {
    // Scope discipline: the reporter contrasts KEEP with "normal building
    // resources". Confirming an ordinary shard spend would be the friction they
    // did NOT ask for, so RESEARCH (spendShards, army.research) must still post
    // on the first tap.
    mocks.get.mockResolvedValue(armyState({ levels: { bowman: 1 } }));
    useApp.setState({
      base: {
        player: { wallet: 'w', name: 'K', keepLevel: 10, trophies: 0, league: 'Bronze', builders: 1, expansions: 0 },
        claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
        buildings: [{ id: 'forge-1', type: 'forge', level: 9, tx: 4, ty: 4, underConstruction: false }],
        obstacles: [], army: [], jobs: [], freeBuilders: 1,
      } as never,
    });
    await act(async () => root.render(<ResearchTray />));

    const researchRow = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('· L2'));
    expect(researchRow).toBeDefined();
    await act(async () => researchRow!.click());
    expect(keepDialog()).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]![0]).toBe('/army/research');
  });
});

describe('sequential paid Finish All admission', () => {
  it.each([null, '00000000-0000-4000-8000-000000000123'])('requires an explicit selected base %s before fresh review', async baseId => {
    useApp.getState().setSelectedBaseId(baseId, false);
    mocks.get.mockResolvedValue(armyState({ queue: [{ id: 'q1', troop: 'bowman', startedAt: at(-30000), finishesAt: at(85000) }] }));
    await act(async () => root.render(<TrainTray />)); await act(async () => trayBtn('FINISH ALL').click());
    expect(mocks.trainingBegin).toHaveBeenCalledTimes(baseId ? 1 : 0); expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each(['missing', 'future'] as const)('does not turn a stale %s tray quote into a payment body', async kind => {
    const baseId = '00000000-0000-4000-8000-000000000123'; useApp.getState().setSelectedBaseId(baseId, false);
    mocks.get.mockResolvedValue(armyState({ queue: [{ id: 'q1', troop: 'bowman', startedAt: at(-30000), finishesAt: at(85000) }], finishAllQuote: kind === 'missing' ? undefined : { version: 99 } }));
    await act(async () => root.render(<TrainTray />)); await act(async () => trayBtn('FINISH ALL').click());
    expect(mocks.trainingBegin).toHaveBeenCalledExactlyOnceWith({ baseId }); expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('first-army free Finish All', () => {
  const freeArmy = (): Record<string, unknown> => {
    const row = { id: '00000000-0000-4000-8000-000000000001', troop: 'bowman', startedAt: at(-1000), finishesAt: at(85_000), canCancel: true, refundShards: '10' };
    const consent = { version: 2, queue: [{ id: row.id, startedAt: row.startedAt, finishesAt: row.finishesAt }], maxCostKeep: '0' };
    return armyState({ queue: [row], freeFinishAllOffer: { offer: 'first_troops', consent }, finishAllQuote: { ...consent, maxCostKeep: '9' } });
  };
  it('offers FREE at zero KEEP and posts explicit free consent without a KEEP dialog', async () => {
    useApp.setState({ wallet: 'free-wallet', selectedBaseId: null, balances: { shards: '0', keep: '0', keepRate: 0 } });
    mocks.get.mockResolvedValue(freeArmy()); mocks.post.mockResolvedValue({ cost: '0', completed: [{ troop: 'bowman', count: 1 }] });
    await act(async () => root.render(<TrainTray />));
    const button = trayBtn('FINISH ALL');
    expect(button.textContent).toContain('FREE'); expect(button.disabled).toBe(false);
    await act(async () => { button.click(); button.click(); });
    expect(keepDialog()).toBeNull(); expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledWith('/army/train/speedup', expect.objectContaining({
      idempotencyKey: expect.any(String), freeOffer: 'first_troops', consent: expect.objectContaining({ maxCostKeep: '0' }),
    }));
  });
  it('retains the original free request after response loss and never converts it into paid consent', async () => {
    useApp.setState({ wallet: 'free-recovery-wallet', selectedBaseId: null, balances: { shards: '0', keep: '0', keepRate: 0 } });
    const state = freeArmy(); mocks.get.mockResolvedValue(state); mocks.post.mockResolvedValue({ cost: '0', completed: [{ troop: 'bowman', count: 1 }] }).mockRejectedValueOnce(new Error('network interrupted'));
    await act(async () => root.render(<TrainTray />));
    await act(async () => trayBtn('FINISH ALL').click());
    const original = mocks.post.mock.calls[0]![1];
    mocks.get.mockResolvedValue({ ...state, freeFinishAllOffer: null });
    await act(async () => root.render(<TrainTray />));
    await act(async () => trayBtn('CHECK FREE FINISH').click());
    expect(mocks.post).toHaveBeenCalledTimes(2); expect(mocks.post.mock.calls[1]![1]).toEqual(original);
    expect(keepDialog()).toBeNull();
  });
  it('labels historical eligibility review honestly without calling the gift used or stopping ordinary timers', async () => {
    useApp.setState({ wallet: 'review-wallet', selectedBaseId: null, balances: { shards: '0', keep: '0', keepRate: 0 } });
    mocks.get.mockResolvedValue({ ...freeArmy(), freeFinishAllOffer: null, freeFinishAllReviewRequired: true });
    await act(async () => root.render(<TrainTray />));
    expect(host.textContent).toContain('YOUR FREE FINISH ELIGIBILITY REQUIRES REVIEW. YOUR TROOPS STILL TRAIN NORMALLY.');
    expect(host.textContent).toContain('ALL READY IN');
    expect(host.textContent).not.toContain('already been used');
    expect(host.querySelector('[data-tutorial-target="training-free-finish"]')).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('storage failure blocks a free request before transport', async () => {
    useApp.setState({ wallet: 'free-storage-wallet', selectedBaseId: null, balances: { shards: '0', keep: '0', keepRate: 0 } });
    mocks.get.mockResolvedValue(freeArmy());
    await act(async () => root.render(<TrainTray />));
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw new Error('storage unavailable'); }, removeItem: storage.removeItem.bind(storage) });
    await act(async () => trayBtn('FINISH ALL').click());
    expect(mocks.post).not.toHaveBeenCalled(); expect(keepDialog()).toBeNull(); vi.unstubAllGlobals();
  });
});
