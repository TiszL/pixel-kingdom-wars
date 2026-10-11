/** @vitest-environment happy-dom */
/**
 * The eager tutorial probe (M23 a6). What these tests pin:
 *  - the overlay mounts ONLY from the server's answer (incomplete row), never
 *    from a client guess — and a completed row renders nothing at all;
 *  - non-base screens render nothing and do not even probe (first-paint and
 *    modal-safety both hang off this);
 *  - the settings REPLAY chip's bus republication re-arms the host with the
 *    server's reset state — the REPLAYABLE half of the owner's ask;
 *  - SKIP (owner 2026-08-29) silences the guided chain, survives a reload, and
 *    does not cost the player the onboarding quests behind it.
 *
 * The lazy chunk is MOCKED here on purpose: vitest's module runner resolves
 * a component-initiated dynamic import nondeterministically under `act`, and
 * this file is about the HOST's mount conditions — the real overlay's
 * behaviour has its own direct suite (TutorialOverlay.test.tsx).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { bus } from '../../lib/events';
import { useApp } from '../../state/store';
import { TutorialHost } from './TutorialHost';

vi.mock('./TutorialOverlay', () => ({
  default: ({ step }: { step: number }) => <div data-tutorial-stub>{`TUTORIAL STEP ${step}`}</div>,
}));
// The guided chain is stubbed for the same reason as the overlay: this file is
// about WHICH surface the host chooses, and the guide has its own behaviour
// (OnboardingGuide.test.tsx pins the ring, the cue and SKIP).
vi.mock('./OnboardingGuide', () => ({
  default: ({ step }: { step: { templateCode: string } }) => (
    <div data-onboarding-stub>{`OBJECTIVE ${step.templateCode}`}</div>
  ),
}));

/** A finished card deck — the precondition for the chain's strip to show. */
const DECK_DONE = { step: 3, completedAt: '2026-08-15T00:00:00.000Z' };
const STEP = {
  questId: 'q1', templateCode: 'first_camp', target: 1, rewardShards: 15,
  progress: 0, completed: false, claimed: false,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ authed: true, wallet: 'wallet', screen: 'base', selectedBaseId: null, playtestWelcomeOpen: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  useApp.setState({ authed: false, wallet: null, screen: 'title' });
  vi.restoreAllMocks();
});

const mount = async (): Promise<void> => {
  await act(async () => {
    root.render(<TutorialHost />);
    await Promise.resolve();
  });
};

/** Let the (mocked) lazy chunk land, then commit the suspense retry. */
const settle = async (marker = 'TUTORIAL STEP'): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    if (host.textContent?.includes(marker)) return;
    await new Promise((r) => setTimeout(r, 10));
    await act(async () => { await Promise.resolve(); });
  }
};

describe('tutorial host', () => {
  it('mounts the lazy overlay when the SERVER says the tutorial is incomplete', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ step: 2, completedAt: null });
    await mount();
    await settle();
    expect(api.get).toHaveBeenCalledWith('/tutorial');
    // The step rendered is the SERVER's, not a client default.
    expect(host.textContent).toContain('TUTORIAL STEP 2');
  });

  it('renders nothing for a completed tutorial', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      step: 9, completedAt: '2026-08-15T00:00:00.000Z',
    });
    await mount();
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain('TUTORIAL STEP');
  });

  it('does not even probe off the base screens, and never blocks them', async () => {
    useApp.setState({ screen: 'quests' });
    const get = vi.spyOn(api, 'get').mockResolvedValue({ step: 0, completedAt: null });
    await mount();
    expect(get).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');
  });

  it('keeps the CARD DECK on the base screens only, even when guidance follows the player', async () => {
    // The guided chain travels (see the chain suite below); the three cards do
    // not. They describe the base and one of them is about its camera, so a card
    // floating over the market or the world map would be describing a screen the
    // player is not looking at.
    vi.spyOn(api, 'get').mockResolvedValue({ step: 1, completedAt: null });
    await mount();
    await settle();
    expect(host.textContent).toContain('TUTORIAL STEP 1');
    await act(async () => {
      useApp.setState({ screen: 'market' });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('TUTORIAL STEP');
  });

  it('survives a failed probe by staying invisible — guidance, never a gate', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('404'));
    await mount();
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toBe('');
  });

  it('re-arms from the settings REPLAY chip via the bus, with server state', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      step: 9, completedAt: '2026-08-15T00:00:00.000Z',
    });
    await mount();
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain('TUTORIAL STEP');

    await act(async () => {
      bus.emit('tutorial:state', { step: 0, completedAt: null });
      await Promise.resolve();
    });
    await settle();
    expect(host.textContent).toContain('TUTORIAL STEP 0');
  });
});

/**
 * THE QUEST-DRIVEN HALF (owner 2026-08-28). The host is now the one owner of
 * first-run guidance, and its job is to pick the RIGHT surface:
 *
 *  - deck still running  → the cards, and NOTHING else. Two instruction surfaces
 *    at once is the card-stacking this lane was asked to remove.
 *  - deck done, chain live → the objective strip.
 *  - both done → nothing at all, which is what keeps a veteran's base screen
 *    clean and the first-paint graph empty for most sessions.
 */
describe('tutorial host — the onboarding chain', () => {
  it('shows the guided objective once the card deck is finished', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...DECK_DONE, onboarding: STEP });
    await mount();
    await settle('OBJECTIVE');
    expect(host.textContent).toContain('OBJECTIVE first_camp');
    // The deck is done, so its cards must not also be up.
    expect(host.textContent).not.toContain('TUTORIAL STEP');
  });

  /**
   * SKIP IS A CORRECTNESS RULE, NOT A NICETY (owner 2026-08-29: players "should
   * be able to skip tutorial if they dont want to"). The four properties it has
   * to hold are pinned across this file and OnboardingGuide.test.tsx:
   *  1. it ends the guided flow — here;
   *  2. it survives a reload — here, because the host's only source is the
   *     server's row and a fresh mount reads `guideSkipped` off it;
   *  3. it does NOT eat the quests — quests.test.tsx keeps the chain section on
   *     the board, and the host still receives the live step (asserted below);
   *  4. it is reversible — the resume case, below.
   */
  it('renders no guidance for a player who skipped, and does so on a fresh mount', async () => {
    // A RELOAD IS EXACTLY THIS: a new mount whose only input is the server row.
    vi.spyOn(api, 'get').mockResolvedValue({ ...DECK_DONE, onboarding: STEP, guideSkipped: true });
    await mount();
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toBe('');
  });

  it('a skipper still HAS the live chain step — the quests are not forfeited', async () => {
    // The distinction the owner drew: stop leading them, do not take the five
    // objectives and their rewards away. The host keeps receiving `onboarding`
    // and the board renders it; only this surface goes quiet. The proof that it
    // is still there is that turning guidance back on shows it with no refetch.
    const get = vi.spyOn(api, 'get')
      .mockResolvedValue({ ...DECK_DONE, onboarding: STEP, guideSkipped: true });
    await mount();
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { await Promise.resolve(); });
    const before = get.mock.calls.length;

    // RESUME, as the settings switch publishes it: the tutorial ROW alone, with
    // no chain field — every write on this route answers that shape.
    await act(async () => {
      bus.emit('tutorial:state', { ...DECK_DONE, guideSkipped: false });
      await Promise.resolve();
    });
    await settle('OBJECTIVE');
    expect(host.textContent).toContain('OBJECTIVE first_camp');
    // And it came back from state the host already held, not a new probe: a
    // partial answer must never blank the chain.
    expect(get.mock.calls.length).toBe(before);
  });

  it('keeps the strip hidden while the card deck is still running', async () => {
    // A live chain step AND an unfinished deck: the deck wins, alone.
    vi.spyOn(api, 'get').mockResolvedValue({ step: 1, completedAt: null, onboarding: STEP });
    await mount();
    await settle();
    expect(host.textContent).toContain('TUTORIAL STEP 1');
    expect(host.textContent).not.toContain('OBJECTIVE');
  });

  it('renders nothing once the chain is finished — a veteran sees no guidance', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...DECK_DONE, onboarding: null });
    await mount();
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toBe('');
  });

  it('survives a server that predates the chain — no field, no strip, no crash', async () => {
    // Rolling deploys mean an old API answers this probe for a while. Guidance
    // is never a gate: a missing field must read as "nothing to show".
    vi.spyOn(api, 'get').mockResolvedValue(DECK_DONE);
    await mount();
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toBe('');
  });

  it('re-reads the chain when the game says the base changed', async () => {
    // A chain step completes on the SERVER (a builder job finishing, a raid
    // settling) with no response the client can read it out of. Without this the
    // strip keeps offering a step the player has already finished.
    const get = vi.spyOn(api, 'get').mockResolvedValue({ ...DECK_DONE, onboarding: STEP });
    await mount();
    await settle('OBJECTIVE');
    const before = get.mock.calls.length;
    await act(async () => {
      bus.emit('base:refresh', undefined);
      await Promise.resolve();
    });
    expect(get.mock.calls.length).toBeGreaterThan(before);
  });

  it('does NOT re-read on base:refresh once the chain is done', async () => {
    // The listener is armed only while a step is live, so a veteran pays nothing
    // for a signal that fires constantly during normal play.
    const get = vi.spyOn(api, 'get').mockResolvedValue({ ...DECK_DONE, onboarding: null });
    await mount();
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { await Promise.resolve(); });
    const before = get.mock.calls.length;
    await act(async () => {
      bus.emit('base:refresh', undefined);
      await Promise.resolve();
    });
    expect(get.mock.calls.length).toBe(before);
  });

  it('names the selected deed on the probe — chain progress is per-deed', async () => {
    // quest_progress is per-base under multi-base, so a two-deed player must not
    // be shown deed A's objective while standing on deed B.
    useApp.setState({ selectedBaseId: 'base-2' });
    const get = vi.spyOn(api, 'get').mockResolvedValue({ ...DECK_DONE, onboarding: STEP });
    await mount();
    await settle('OBJECTIVE');
    expect(get.mock.calls.some(([url]) => String(url).includes('base-2'))).toBe(true);
    useApp.setState({ selectedBaseId: null });
  });
});

it('retries a transient first probe without needing a reload or a live chain', async () => {
  const get = vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ ...DECK_DONE, onboarding: STEP });
  await mount();
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await settle('OBJECTIVE');
  expect(get).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('OBJECTIVE first_camp');
});

it('automatically retries the initial transient failure in the current session', async () => {
  vi.useFakeTimers();
  const get = vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('temporarily unavailable'))
    .mockResolvedValue({ ...DECK_DONE, onboarding: STEP });
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(get).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('a slow former-deed probe cannot replace the selected deed objective', async () => {
  let resolveOld!: (value: unknown) => void;
  vi.spyOn(api, 'get').mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue({ ...DECK_DONE, onboarding: { ...STEP, templateCode: 'first_mine' } });
  useApp.setState({ selectedBaseId: 'deed-a' });
  await mount();
  await act(async () => { useApp.setState({ selectedBaseId: 'deed-b' }); });
  await settle('OBJECTIVE');
  await act(async () => { resolveOld({ ...DECK_DONE, onboarding: STEP }); });
  expect(host.textContent).toContain('OBJECTIVE first_mine');
  expect(useApp.getState().onboardingStepCode).toBe('first_mine');
});

it('logout invalidates a pending probe and its published objective', async () => {
  let resolveOld!: (value: unknown) => void;
  vi.spyOn(api, 'get').mockImplementation(() => new Promise((resolve) => { resolveOld = resolve; }));
  await mount();
  await act(async () => { useApp.setState({ authed: false, wallet: null }); });
  await act(async () => { resolveOld({ ...DECK_DONE, onboarding: STEP }); });
  expect(host.textContent).toBe('');
  expect(useApp.getState().onboardingStepCode).toBeNull();
});

it.each([
  [{ step: 0, completedAt: null }, 'TUTORIAL STEP 0'],
  [{ ...DECK_DONE, onboarding: STEP }, 'OBJECTIVE first_camp'],
])('waits for the playtest welcome to close before showing guidance (%s)', async (response, marker) => {
  useApp.setState({ playtestWelcomeOpen: true });
  const get = vi.spyOn(api, 'get').mockResolvedValue(response);
  await mount();
  expect(host.textContent).toBe('');
  await act(async () => { useApp.setState({ playtestWelcomeOpen: false }); });
  await settle(marker);
  expect(host.textContent).toContain(marker);
  expect(get).toHaveBeenCalledTimes(1);
});
