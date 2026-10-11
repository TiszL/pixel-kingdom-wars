/**
 * THE CHAIN'S DESTINATIONS (owner 2026-08-28: onboarding must "direct them to do
 * things", not describe them).
 *
 * A quest that names an action but strands the player on the screen they were
 * already on is worse than the tutorial card it replaced — the card at least
 * pointed at a button. So the contract these pin is: EVERY chain step this build
 * knows about has an action, and that action lands on the screen where the step
 * can actually be completed.
 *
 * The store is the assertion target rather than a rendered button because the
 * route IS the behaviour: which screen `setScreen` ends on is the whole promise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTS } from '@shardkeep/shared';
import { useApp, type BaseStateDto } from '../state/store';
import { api } from '../lib/api';
import { reloadCurrentBaseSnapshot } from '../state/baseSnapshot';
vi.mock('../state/baseSnapshot', () => ({ reloadCurrentBaseSnapshot: vi.fn().mockResolvedValue(true) }));
import { createPanelSession, type PanelDismissRequest } from './pk/panelSession';
import { isOnboardingStep, onboardingAction } from './onboardingChain';

beforeEach(() => {
  useApp.setState({ screen: 'base', landPrompt: null, landPurchase: null, raidChooserPending: false,
    base: null, placing: null, entryPaid: false, selectedBaseId: null, baseFocusRequest: null, trainingRequested: false });
  vi.clearAllMocks();
});

describe('the onboarding chain routes every step somewhere real', () => {
  it('knows an action for EVERY template in the shared chain', () => {
    // A gap here is a dead button on the first screen a new player ever sees.
    for (const t of QUESTS.onboardingTemplates) {
      expect(isOnboardingStep(t.id), `${t.id} has no client action`).toBe(true);
      expect(onboardingAction(t.id), `${t.id} has no client action`).not.toBeNull();
    }
  });

  it('the three build steps open the BUILD tray', () => {
    // Camp, Mine and Barracks are all raised from the same tray; the step must
    // land the player in it rather than pre-picking the building for them.
    for (const id of ['first_camp', 'first_mine', 'first_barracks']) {
      useApp.setState({ screen: 'base' });
      onboardingAction(id)!.go();
      expect(useApp.getState().screen, `${id} should open the build tray`).toBe('build');
      expect(useApp.getState().buildCategory).toBe('bld');
    }
  });

  it('CLAIM YOUR LAND opens the one screen that can take the payment', () => {
    // ENTRY is the only screen with the pay/claim/deposit logic (Overlay's
    // LandGateHost routes there for the same reason). Arriving anywhere else
    // means the step cannot be finished from its own button.
    onboardingAction('first_land')!.go();
    const s = useApp.getState();
    expect(s.screen).toBe('entry');
    expect(s.landPurchase).toEqual({ kind: 'entry', earthCell: null });
    // The land-gate PROMPT is cleared: the sheet and the entry screen must never
    // both be up, which is the double-refusal menu.tsx's buyLand also avoids.
    expect(s.landPrompt).toBeNull();
  });

  it('WIN YOUR FIRST RAID returns to the base and asks for the raid chooser', () => {
    // The chooser is local state inside the base HUD, so the request must
    // survive the quest-board tree unmounting before BaseHud mounts.
    useApp.setState({ screen: 'quests' });
    onboardingAction('first_raid')!.go();
    expect(useApp.getState().screen).toBe('base');
    expect(useApp.getState().raidChooserPending).toBe(true);
  });

  it('an unknown template is fail-soft, never a crash or a dead tap', () => {
    // A server given a sixth chain step before this bundle ships must render a
    // readable row with no button — the same rule the coach-mark anchor lookup
    // follows.
    expect(onboardingAction('first_dragon_ride')).toBeNull();
    expect(isOnboardingStep('first_dragon_ride')).toBe(false);
  });

  it('every step carries a verb and a hint the player can act on', () => {
    for (const t of QUESTS.onboardingTemplates) {
      const a = onboardingAction(t.id)!;
      expect(a.verb, `${t.id} verb`).toMatch(/^[A-Z]+$/); // board style: uppercase
      expect(a.hint.length, `${t.id} hint`).toBeGreaterThan(20);
    }
  });
});

/** Nothing above should have needed a network. */
it('routes without touching the API', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  onboardingAction('first_camp')!.go();
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

const base = (overrides: Partial<BaseStateDto> = {}): BaseStateDto => ({
  buildings: [], jobs: [], army: [], freeBuilders: 1, ...overrides,
} as BaseStateDto);
const camp = { id: 'camp-1', type: 'camp', level: 1, tx: 1, ty: 1, underConstruction: true };
const construction = { id: 'job-1', kind: 'build', buildingId: camp.id, obstacleId: null,
  startedAt: '2026-01-01', finishesAt: '2099-01-01', finishCostKeep: '0' };

it('finishes the existing construction for the server zero quote without placing another', async () => {
  useApp.setState({ base: base({ buildings: [camp], jobs: [construction] }) });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ cost: '0' });
  const action = onboardingAction('first_camp')!;
  expect(action.verb).toBe('FINISH');
  await action.go();
  expect(post).toHaveBeenCalledWith('/base/jobs/job-1/speedup', {});
  expect(useApp.getState().baseFocusRequest).toEqual({ kind: 'building', id: camp.id });
  expect(reloadCurrentBaseSnapshot).toHaveBeenCalled();
  post.mockRestore();
});

it('a paid or legacy quote only opens the job HUD for its existing confirmation', async () => {
  useApp.setState({ base: base({ buildings: [camp], jobs: [{ ...construction, finishCostKeep: '2' }] }) });
  const post = vi.spyOn(api, 'post');
  await onboardingAction('first_camp')!.go();
  expect(post).not.toHaveBeenCalled();
  expect(useApp.getState().baseFocusRequest).toEqual({ kind: 'building', id: camp.id });
  post.mockRestore();
});

it('busy builders direct the player to the occupying job without buying a builder or finishing a paid upgrade', async () => {
  useApp.setState({ base: base({ freeBuilders: 0, jobs: [{ ...construction, kind: 'upgrade', buildingId: 'keep' }] }) });
  const post = vi.spyOn(api, 'post');
  const action = onboardingAction('first_camp')!;
  expect(action.verb).toBe('VIEW');
  await action.go();
  expect(useApp.getState().baseFocusRequest).toEqual({ kind: 'building', id: 'keep' });
  expect(post).not.toHaveBeenCalled();
  post.mockRestore();
});

it('empty armies route the first raid objective to real Barracks training', () => {
  useApp.setState({ base: base({ buildings: [{ ...camp, type: 'barracks', underConstruction: false }] }) });
  expect(onboardingAction('first_raid')!.verb).toBe('TRAIN');
  onboardingAction('first_raid')!.go();
  expect(useApp.getState().trainingRequested).toBe(true);
  expect(useApp.getState().baseFocusRequest).toEqual({ kind: 'building', id: camp.id });
});

it('a paid land objective cannot reopen payment while its reward probe catches up', () => {
  useApp.setState({ entryPaid: true, screen: 'base' });
  onboardingAction('first_land')!.go();
  expect(useApp.getState().screen).toBe('base');
  expect(useApp.getState().landPurchase).toBeNull();
});

it('a full Barracks queue waits even while the Camp has room, then returns to training after timers finish', () => {
  const status = { readyTroopCount: 0, readyPts: 0, campCapacityPts: 20,
    trainingTroopCount: 3, trainingPts: 10, barracksQueuePts: 10, nextReadyAt: null, allReadyAt: null };
  useApp.setState({ base: base({ armyStatus: status }) });
  expect(onboardingAction('first_troops')!.verb).toBe('WAIT');
  expect(onboardingAction('first_raid')!.verb).toBe('WAIT');
  expect(onboardingAction('first_troops')!.hint).toContain('0/20');
  useApp.setState({ base: base({ armyStatus: { ...status, readyTroopCount: 1, readyPts: 7, trainingTroopCount: 2, trainingPts: 3 } }) });
  expect(onboardingAction('first_troops')!.verb).toBe('TRAIN');
});


// Actual onboarding producers: flags, route and transport belong to one gate.
describe('onboarding whole-command policy', () => {
  function hold() {
    const panel = { kind: 'hub' as const, featureId: 'hub.draft' };
    useApp.setState({ basePanel: panel, screen: 'base', buildCategory: 'def' });
    const pending: PanelDismissRequest[] = [];
    const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel,
      canMutate: () => false, canRecover: () => false });
    const off = session.mount(); session.setDismissPolicy(request => { pending.push(request); });
    return { panel, pending, off };
  }
  it.each(['first_camp', 'first_land', 'first_raid', 'first_troops'] as const)('holds all %s route effects until confirmation', async code => {
    const h = hold();
    try {
      const completion = onboardingAction(code)!.go();
      expect(h.pending).toHaveLength(1); expect(useApp.getState().basePanel).toBe(h.panel);
      expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().buildCategory).toBe('def');
      expect(useApp.getState().landPurchase).toBeNull(); expect(useApp.getState().raidChooserPending).toBe(false);
      expect(useApp.getState().trainingRequested).toBe(false);
      expect(h.pending[0]?.proceed()).toBe(true); expect(h.pending[0]?.proceed()).toBe(false);
      await completion;
      if (code === 'first_land') expect(useApp.getState().screen).toBe('entry');
      else if (code === 'first_raid') expect(useApp.getState().raidChooserPending).toBe(true);
      else expect(useApp.getState().screen).toBe('build');
    } finally { h.off(); useApp.setState({ basePanel: null }); }
  });
  it('holds the real focus and free-speedup POST together, then runs them once', async () => {
    useApp.setState({ base: base({ buildings: [camp], jobs: [construction] }) });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ cost: '0' }); const h = hold();
    try {
      const completion = onboardingAction('first_camp')!.go();
      expect(h.pending).toHaveLength(1); expect(post).not.toHaveBeenCalled();
      expect(useApp.getState().baseFocusRequest).toBeNull(); expect(reloadCurrentBaseSnapshot).not.toHaveBeenCalled();
      expect(h.pending[0]?.proceed()).toBe(true); expect(h.pending[0]?.proceed()).toBe(false);
      await completion;
      await Promise.resolve(); await Promise.resolve();
      expect(post).toHaveBeenCalledTimes(1); expect(post).toHaveBeenCalledWith('/base/jobs/job-1/speedup', {});
      expect(useApp.getState().baseFocusRequest).toEqual({ kind: 'building', id: camp.id });
    } finally { h.off(); post.mockRestore(); useApp.setState({ basePanel: null }); }
  });
  it.each(['wallet', 'job-removed', 'quote-changed'] as const)('refuses the full retained job command after %s', async change => {
    useApp.setState({ base: base({ buildings: [camp], jobs: [construction] }) });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ cost: '0' }); const h = hold();
    try {
      const completion = onboardingAction('first_camp')!.go();
      if (change === 'wallet') useApp.setState({ wallet: 'another-wallet' });
      if (change === 'job-removed') useApp.setState({ base: base({ buildings: [camp], jobs: [] }) });
      if (change === 'quote-changed') useApp.setState({ base: base({ buildings: [camp], jobs: [{ ...construction, finishCostKeep: '2' }] }) });
      expect(h.pending[0]?.proceed()).toBe(false); expect(await completion).toBe(false); expect(post).not.toHaveBeenCalled();
      expect(useApp.getState().baseFocusRequest).toBeNull();
    } finally { h.off(); post.mockRestore(); useApp.setState({ basePanel: null }); }
  });
  it('keeps caller busy until a retained free-speedup rejection reaches catch/finally', async () => {
    useApp.setState({ base: base({ buildings: [camp], jobs: [construction] }) });
    const failure = new Error('speedup offline'); let rejectPost!: (error: Error) => void;
    const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise((_, reject) => { rejectPost = reject; }));
    const h = hold(); let busy = true; const caught = vi.fn();
    try {
      const completion = Promise.resolve(onboardingAction('first_camp')!.go()).catch(caught).finally(() => { busy = false; });
      await Promise.resolve(); expect(busy).toBe(true); expect(post).not.toHaveBeenCalled(); expect(caught).not.toHaveBeenCalled();
      expect(h.pending[0]?.proceed()).toBe(true); expect(busy).toBe(true);
      rejectPost(failure); await completion;
      expect(caught).toHaveBeenCalledTimes(1); expect(caught).toHaveBeenCalledWith(failure); expect(busy).toBe(false);
      expect(post).toHaveBeenCalledTimes(1); expect(post).toHaveBeenCalledWith('/base/jobs/job-1/speedup', {});
    } finally { h.off(); post.mockRestore(); useApp.setState({ basePanel: null }); }
  });
});
