/** @vitest-environment happy-dom */
/**
 * THE GUIDED FIRST RUN (owner 2026-08-29: "quests should be directing player by
 * guiding to do directive like lockin but they should be able to skip tutorial
 * if they dont want to").
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. The failure this lane exists to fix was
 * not a crash and not a wrong number — it was a flow that INFORMED without
 * GUIDING, and every one of its gaps passed the old tests. So what is pinned
 * here is the guiding itself:
 *
 *  - the mark lands on the control the player must press RIGHT NOW, and moves
 *    deeper as they act (nav → tab → card → PLACE) rather than restating the
 *    objective;
 *  - it FOLLOWS them across screens instead of vanishing when they navigate,
 *    which is the property a coach mark bolted to one screen never has;
 *  - it switches to the CLAIM control the moment the step completes;
 *  - SKIP is on screen at every step and on every guided screen, it ends the
 *    flow through the server (so a reload cannot undo the player's choice), and
 *    it leaves the quests alone.
 *
 * The DOM here uses the same stable data hooks as the real HUD and build tray.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECONOMY, QUESTS } from '@shardkeep/shared';
import { api } from '../../lib/api';
import { useApp, type BaseStateDto } from '../../state/store';
import type { OnboardingStep } from '../onboardingChain';
import { hasGuideCues } from './guideCues';
import OnboardingGuide from './OnboardingGuide';

// The objective strip pulls `reloadBase` out of ui/sheets, and that module
// reaches the wallet-purchase hooks and, through them, the Privy SDK — which
// does not resolve under the test runner. Nothing in this file is about
// reloading the base, so the one function it needs is stubbed rather than the
// component being replaced: the strip's own markup (its SKIP, its cue line, its
// anchors) is exactly what these tests assert on.
vi.mock('../sheets', () => ({ reloadBase: () => Promise.resolve() }));

vi.mock('../useSolBalance', () => ({ useSolBalance: () => 0 }));

let host: HTMLDivElement;
let root: Root;

const step = (over: Partial<OnboardingStep> = {}): OnboardingStep => ({
  questId: 'q1', templateCode: 'first_camp', target: 1, rewardShards: 15,
  progress: 0, completed: false, claimed: false, ...over,
});

/** A control the guide can anchor on, outside the React tree — the real ones
 *  live in the HUD, the build tray and the raid chooser. */
const anchor = (attrs: Record<string, string>, text = ''): HTMLElement => {
  const el = document.createElement('button');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.textContent = text;
  document.body.append(el);
  return el;
};

beforeEach(() => {
  // happy-dom does not lay out controls. Model actual, hittable geometry so
  // these cue tests cannot accidentally endorse a zero-size anchor.
  let measured: Element | null = null;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    measured = this;
    return { x: 40, y: 180, left: 40, top: 180, right: 200, bottom: 224,
      width: 160, height: 44, toJSON: () => ({}) };
  });
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => measured);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ authed: true, wallet: 'wallet', screen: 'base', base: null, placing: null,
    selectedBuildingId: null, selectedObstacleId: null, selectedBaseId: null, entryPaid: false, mapTab: 'world' });
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

const render = async (s: OnboardingStep = step()): Promise<void> => {
  await act(async () => {
    root.render(<OnboardingGuide step={s} onDone={() => {}} onState={() => {}} />);
    await Promise.resolve();
  });
};

/** Move the player, then let the 260ms cue poll re-resolve. */
const go = async (screen: string): Promise<void> => {
  await act(async () => {
    useApp.setState({ screen: screen as never });
    await new Promise((r) => setTimeout(r, 350));
  });
};

/** Let the cue poll run without changing anything else. */
const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
};

const skipButton = (): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'SKIP');
  expect(found, 'a SKIP control must be on screen').toBeTruthy();
  return found!;
};

describe('the guided chain points at the control the player must press', () => {
  it('rings the objective strip\'s own action on the base screen', async () => {
    await render();
    expect(host.textContent).toContain('TAP BUILD TO RAISE YOUR ARMY CAMP');
    // The strip's action button carries the anchor, so the ring has a target.
    expect(host.querySelector('[data-onboarding-cta]')).toBeTruthy();
    expect(document.querySelector('[data-tutorial-ring]')).toBeTruthy();
  });

  it('gives the action its own row at 320px so objective copy stays readable', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    await render();
    const action = host.querySelector('[data-onboarding-cta]') as HTMLElement;
    expect(action.style.flexBasis).toBe('100%');
    expect((action.querySelector('button') as HTMLElement).style.width).toBe('100%');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('moves DEEPER as the player acts — tab, then card, then PLACE', async () => {
    // This is the whole difference between guiding and informing: the objective
    // never changes, but what to tap does, four times, and the mark keeps up.
    await render();
    await go('build');
    const tab = anchor({ 'data-tutorial-target': 'buildings-tab' });
    await settle();
    expect(host.textContent).toContain('OPEN THE BUILDINGS TAB');

    // The player opened the tab; the Camp card is now in the tray.
    const card = anchor({ 'data-build-type': 'camp' });
    await settle();
    expect(host.textContent).toContain('TAP THE ARMY CAMP CARD');

    // They tapped it: the tray is replaced by the placement confirm bar.
    tab.remove(); card.remove();
    anchor({ 'data-tutorial-target': 'place-building' });
    await settle();
    expect(host.textContent).toContain('PICK A FREE TILE, THEN PLACE YOUR ARMY CAMP');
  });

  it('waits on the authoritative build job instead of asking for a duplicate', async () => {
    await render();
    await go('build');
    anchor({ 'data-build-type': 'camp' });
    const job = anchor({ 'data-onboarding-job': 'mine camp' });
    await settle();
    expect(host.textContent).toContain('OPEN YOUR ARMY CAMP AND TAP FINISH');
    expect(document.querySelector('[data-tutorial-ring]')).toBeTruthy();
    job.remove();
  });

  it('follows the player across screens instead of vanishing', async () => {
    // The shipped flow lost the player the moment they navigated: the strip was
    // base-only and nothing replaced it. Guidance that stops at the screen edge
    // is not guidance.
    await render();
    expect(host.textContent).toContain('ARMY CAMP');
    await go('quests');
    expect(host.textContent).toContain('ARMY CAMP');
    await go('build');
    expect(host.textContent).toContain('ARMY CAMP');
  });

  it('says what the step wants even where none of its controls exist', async () => {
    // No ring rather than a mark on nothing — the fail-soft rule the whole
    // tutorial anchor system is built on.
    await render(step({ templateCode: 'first_raid' }));
    await go('map');
    expect(host.textContent).toContain('PICK A CAMPAIGN STAGE AND WIN IT');
    expect(document.querySelector('[data-tutorial-ring]')).toBeNull();
  });

  it('switches to CLAIM the moment the step completes', async () => {
    // The step is not over until the reward is taken (the server's own rule in
    // getOnboardingStep), so the mark has to move rather than disappear.
    await render(step({ completed: true, progress: 1 }));
    expect(host.textContent).toContain('TAP CLAIM TO TAKE YOUR REWARD');
    expect(host.querySelector('[data-onboarding-claim]')).toBeTruthy();
  });

  it('walks a completed build out of the tray before pointing at CLAIM', async () => {
    await render(step({ completed: true, progress: 1 }));
    await go('build');
    anchor({ 'aria-label': 'Close build tray' });
    await settle();
    expect(host.textContent).toContain('CLOSE BUILD, THEN CLAIM YOUR REWARD');
    expect(document.querySelector('[data-tutorial-ring]')).toBeTruthy();
  });

  it('leaves the game playable — the spotlight takes no taps', async () => {
    // "Lock in" means focus, not a cage: a player who ignores the mark must be
    // able to press anything on the screen underneath it.
    await render();
    const dims = [...document.querySelectorAll('[data-tutorial-dim]')];
    expect(dims.length).toBeGreaterThan(0);
    for (const d of dims) {
      expect((d as HTMLElement).style.pointerEvents).toBe('none');
    }
    expect((document.querySelector('[data-tutorial-ring]') as HTMLElement).style.pointerEvents)
      .toBe('none');
  });

  it('knows a cue for EVERY step in the shared chain', async () => {
    // A gap here is a step where the guidance silently stops guiding — the exact
    // failure this lane was opened to fix, one template later.
    for (const t of QUESTS.onboardingTemplates) {
      expect(hasGuideCues(t.id), `${t.id} has no guide cues`).toBe(true);
    }
  });
});

describe('SKIP ends the guided flow', () => {
  it('is on screen on the base screen AND on every screen the guide follows to', async () => {
    // "From any step, from any screen" is the owner's requirement; a skip that
    // only exists on the strip would be missing exactly where the flow is most
    // insistent — inside the build tray.
    await render();
    expect(skipButton()).toBeTruthy();
    await go('build');
    expect(skipButton()).toBeTruthy();
    await go('quests');
    expect(skipButton()).toBeTruthy();
  });

  it('posts the server route and hides the guidance immediately', async () => {
    const done = { step: 3, completedAt: '2026-08-29T00:00:00.000Z', guideSkipped: true };
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue(done);
    const onState = vi.fn();
    await act(async () => {
      root.render(<OnboardingGuide step={step()} onDone={() => {}} onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      skipButton().click();
      await Promise.resolve();
    });
    // SERVER-STORED, which is what makes it survive a reload — a local flag
    // would be undone by the next page load, and the player would be right back
    // in the flow they just dismissed.
    expect(post).toHaveBeenCalledWith('/tutorial/guide/skip', {});
    expect(onState).toHaveBeenCalledWith(done);
    expect(host.textContent).toBe('');
    expect(document.querySelector('[data-tutorial-ring]')).toBeNull();
  });

  it('stays gone when the network refuses the skip', async () => {
    // Guidance is guidance. Leaving a player who tapped the exit twice still
    // being pointed at things because their connection blinked protects nothing.
    vi.spyOn(api, 'postRaw').mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => {
      skipButton().click();
      await Promise.resolve();
    });
    expect(host.textContent).toBe('');
  });

  it('does not claim, cancel or otherwise touch the quest behind it', async () => {
    // The distinction the owner drew: a skipper keeps the objectives and their
    // rewards on the board. SKIP therefore posts exactly one request, and it is
    // not a claim.
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue({ step: 3, completedAt: 'x', guideSkipped: true });
    const plainPost = vi.spyOn(api, 'post').mockResolvedValue({});
    await render(step({ completed: true, progress: 1 }));
    await act(async () => {
      skipButton().click();
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(plainPost).not.toHaveBeenCalled();
  });
});

it('keeps the objective strip away from an open selected-building sheet', async () => {
  useApp.setState({ selectedBuildingId: 'camp-1' });
  anchor({ 'aria-label': 'Close sheet' });
  await render();
  await settle();
  expect(host.querySelector('[data-onboarding-strip]')).toBeNull();
  expect(host.querySelector('[data-onboarding-bubble]')).toBeTruthy();
  expect(host.textContent).toContain('CLOSE THIS PANEL');
});

it('labels the reward as a gain so it cannot be mistaken for the building price', async () => {
  await render();
  expect(host.textContent).toContain('+15');
});

it('keeps the land price and live funding status on the BUY objective', async () => {
  await render(step({ templateCode: 'first_land' }));
  expect(host.textContent).toContain(`PRICE ${ECONOMY.entryFeeSol} SOL + NETWORK FEE`);
  expect(host.textContent).toContain('WALLET 0.0000 SOL');
  expect(host.textContent).toContain('ADD SOL TO CONTINUE');
});

it.each(['entry', 'campaign'])('places guidance and SKIP in the %s layout slot without covering its controls', async (slotName) => {
  useApp.setState({ screen: slotName === 'entry' ? 'entry' : 'map', mapTab: 'campaign' });
  const slot = document.createElement('div');
  slot.dataset.onboardingCaptionSlot = slotName;
  document.body.append(slot);
  await render(step({ templateCode: slotName === 'entry' ? 'first_land' : 'first_raid' }));
  const bubble = slot.querySelector<HTMLElement>('[data-onboarding-bubble]');
  expect(bubble).toBeTruthy();
  expect(bubble!.style.position).toBe('relative');
  expect([...slot.querySelectorAll('button')].some((button) => button.textContent === 'SKIP')).toBe(true);
  expect(host.querySelector('[data-onboarding-bubble]')).toBeNull();
});

it('waits for a lazy entry layout slot instead of briefly covering payment controls', async () => {
  useApp.setState({ screen: 'entry' });
  await render(step({ templateCode: 'first_land' }));
  expect(document.querySelector('[data-onboarding-bubble]')).toBeNull();
  const slot = document.createElement('div');
  slot.dataset.onboardingCaptionSlot = 'entry';
  await act(async () => { document.body.append(slot); });
  expect(slot.querySelector('[data-onboarding-bubble]')).toBeTruthy();
});

it('rings MAX ahead of the troop card, and the card once MAX is disabled', async () => {
  // The +10 / MAX steppers (2026-09-16) make one tap fill the L1 camp the
  // first_troops objective asks for, so the cue names MAX. MAX is disabled when
  // the camp or queue has no room; the card is the honest fallback then.
  anchor({ 'data-train-troop': 'highlander' });
  const max = anchor({ 'data-train-max': 'highlander' }, 'MAX');
  await render(step({ templateCode: 'first_troops', target: 20 }));
  expect(host.textContent).toContain('TAP MAX ON A TROOP TO FILL YOUR FIRST ARMY');
  expect(document.querySelector('[data-tutorial-ring]')).toBeTruthy();
  max.setAttribute('disabled', '');
  await settle();
  expect(host.textContent).toContain('TAP A TROOP TO ADD IT TO YOUR FIRST ARMY');
  expect(host.textContent).not.toContain('TAP MAX');
});

it('does not ring a troop card when the Barracks queue is full below the Camp target', async () => {
  anchor({ 'data-train-troop': 'highlander' });
  anchor({ 'data-training-queue': '' });
  useApp.setState({ selectedBuildingId: 'barracks', base: {
    buildings: [], jobs: [], army: [], armyStatus: { readyTroopCount: 0, readyPts: 0,
      trainingTroopCount: 3, trainingPts: 10, barracksQueuePts: 10, campCapacityPts: 20 },
  } as unknown as BaseStateDto });
  await render(step({ templateCode: 'first_troops', target: 20 }));
  expect(host.textContent).toContain('YOUR TROOPS ARE TRAINING');
  expect(document.querySelector('[data-tutorial-ring]')).toBeNull();
});

it('keeps a pending placement oriented without ringing its disabled action', async () => {
  const placing = anchor({ 'data-tutorial-target': 'place-building', 'aria-busy': 'true', disabled: '' }, 'PLACING…');
  useApp.setState({ placing: 'camp' });
  await render();
  expect(host.textContent).toContain('PLACING YOUR BUILDING — WAITING FOR CONFIRMATION');
  expect(host.textContent).not.toContain('GO BACK TO YOUR BASE');
  expect(document.querySelector('[data-tutorial-ring]')).toBeNull();
  // A failed attempt returning to an enabled PLACE restores actionable guidance.
  placing.setAttribute('aria-busy', 'false');
  placing.removeAttribute('disabled');
  await settle();
  expect(document.querySelector('[data-tutorial-ring]')).toBeTruthy();
  expect(host.textContent).not.toContain('WAITING FOR CONFIRMATION');
});

it.each([
  ['wallet-approval', 'CONFIRM OR CANCEL THE PAYMENT IN YOUR WALLET'],
  ['signing', 'SIGNING YOUR PAYMENT — PLEASE WAIT'],
])('keeps %s guidance on the pending payment without suggesting another action', async (phase, message) => {
  const slot = document.createElement('div');
  slot.dataset.onboardingCaptionSlot = 'entry';
  document.body.append(slot);
  anchor({ 'data-tutorial-target': 'land-pay', 'data-tutorial-pending': phase, disabled: '' });
  useApp.setState({ screen: 'entry' });
  await render(step({ templateCode: 'first_land' }));
  expect(slot.textContent).toContain(message);
  expect(document.querySelector('[data-tutorial-ring]')).toBeNull();
  expect(slot.textContent).not.toContain('CLAIM YOUR LAND ON THIS SCREEN');
});

it('guides an early land purchase instead of asking for an off-screen build claim', async () => {
  const slot = document.createElement('div');
  slot.dataset.onboardingCaptionSlot = 'entry';
  document.body.append(slot);
  anchor({ 'data-tutorial-target': 'land-funding' });
  useApp.setState({ screen: 'entry' });
  await render(step({ completed: true, progress: 1 }));
  expect(slot.textContent).not.toContain('TAP CLAIM');
  expect(slot.textContent).toContain('SOL');
});

// K-195: on the world map the land step must point somewhere. CHOOSE LAND sits in the world panel, never inside
// the stage, so the old cue (a CHOOSE LAND button INSIDE land-globe-cell) never matched and the player got a
// generic line. A deed on the canvas is no DOM target (World v2 or the CPU globe), so the cue rings the stage until
// a parcel's CHOOSE LAND exists, then the confirm.
it('rings the world stage until a parcel is chosen, then its CHOOSE LAND (K-195)', async () => {
  useApp.setState({ screen: 'map', mapTab: 'world' });
  const stage = document.createElement('section');
  stage.setAttribute('data-tutorial-target', 'land-globe-cell');
  stage.append(document.createElement('canvas'));
  document.body.append(stage);
  await render(step({ templateCode: 'first_land' }));
  await settle();
  expect(document.body.textContent).toContain('CHOOSE AN AVAILABLE PARCEL ON THE GLOBE');
  expect(document.querySelector('[data-tutorial-ring]')).not.toBeNull();
  const confirm = document.createElement('div');
  confirm.setAttribute('data-tutorial-target', 'land-globe-confirm');
  const choose = document.createElement('button');
  choose.setAttribute('aria-label', 'CHOOSE LAND');
  confirm.append(choose);
  document.body.append(confirm);
  await settle();
  expect(document.body.textContent).toContain('CONFIRM THIS LAND TO RETURN TO YOUR RESERVATION');
  expect(document.body.textContent).not.toContain('CHOOSE AN AVAILABLE PARCEL ON THE GLOBE');
});

it('guides Review, Add to Queue and a free finish even when the Barracks queue is full', async () => {
  const troop = anchor({ 'data-train-troop': 'bowman' });
  const review = anchor({ 'data-tutorial-target': 'training-review' });
  await render(step({ templateCode: 'first_troops', target: 20 }));
  expect(host.textContent).toContain('TAP REVIEW TRAINING');
  const add = anchor({ 'data-tutorial-target': 'training-add-to-queue' });
  await settle(); expect(host.textContent).toContain('TAP ADD TO QUEUE');
  troop.remove(); review.remove(); add.remove();
  anchor({ 'data-training-queue': '' });
  anchor({ 'data-tutorial-target': 'training-free-finish' });
  useApp.setState({ base: { buildings: [], jobs: [], army: [], armyStatus: { readyTroopCount: 0, readyPts: 0,
    trainingTroopCount: 10, trainingPts: 10, barracksQueuePts: 10, campCapacityPts: 20 } } as unknown as BaseStateDto });
  await settle();
  expect(host.textContent).toContain('TAP FINISH ALL · FREE — NO KEEP NEEDED');
  expect(document.querySelector('[data-tutorial-ring]')).not.toBeNull();
});

it('prioritizes purchase recovery over a new draft or free queue finish', async () => {
  anchor({ 'data-tutorial-target': 'training-review' });
  anchor({ 'data-tutorial-target': 'training-free-finish' });
  anchor({ 'data-tutorial-target': 'training-purchase-recovery' });
  await render(step({ templateCode: 'first_troops', target: 20 }));
  expect(host.textContent).toContain('CHECK YOUR ORIGINAL PURCHASE BEFORE TRAINING AGAIN');
});

it('keeps review guidance inside a short dialog when Add to Queue needs scrolling', async () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('data-training-confirmation', '');
  const slot = document.createElement('div'); slot.setAttribute('data-onboarding-caption-slot', 'training');
  const add = document.createElement('button'); add.setAttribute('data-tutorial-target', 'training-add-to-queue');
  dialog.append(slot, add); document.body.append(dialog);
  vi.spyOn(add, 'getBoundingClientRect').mockReturnValue({ x: 40, y: 2000, left: 40, top: 2000,
    right: 200, bottom: 2044, width: 160, height: 44, toJSON: () => ({}) });
  await render(step({ templateCode: 'first_troops', target: 20 }));
  expect(slot.textContent).toContain('REVIEW THE SHARDS COST, THEN SCROLL DOWN TO ADD TO QUEUE');
  expect(slot.textContent).toContain('SKIP');
  expect(slot.textContent).not.toContain('TRAIN YOUR ARMY AT THE BARRACKS');
});
