/** @vitest-environment happy-dom */
/**
 * The lazy tutorial overlay (M23 a6). What these tests pin:
 *  - the card renders from the shared step order with dots + NEXT + SKIP;
 *  - EVERY advance goes through the server and the component adopts the
 *    SERVER's returned state (never its own increment);
 *  - SKIP ends the complete guided flow through /tutorial/guide/skip;
 *  - a missing anchor element degrades to the card alone — no ring, no crash
 *    (the fail-soft rule: the tutorial is guidance, never a gate);
 *  - a real FIT signal advances immediately.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TUTORIAL_STEPS } from '@shardkeep/shared';
import { api } from '../../lib/api';
import { bus } from '../../lib/events';
import { useApp } from '../../state/store';
import TutorialOverlay from './TutorialOverlay';

let host: HTMLDivElement;
let root: Root;

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
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useApp.setState({ screen: 'base' });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const render = async (step: number, onState: (s: { step: number; completedAt: string | null }) => void = () => {}): Promise<void> => {
  await act(async () => {
    root.render(<TutorialOverlay step={step} onState={onState} />);
    await Promise.resolve();
  });
};

const button = (label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label);
  expect(found, `button "${label}"`).toBeTruthy();
  return found!;
};

describe('tutorial overlay card', () => {
  it('renders the welcome step with dots, NEXT and SKIP — and no ring without an anchor', async () => {
    await render(0);
    expect(host.textContent).toContain('WELCOME, KEEPER');
    // One dot per content step; 'done' is terminal, not a card.
    expect(host.querySelector(`[aria-label="Tutorial step 1 of ${TUTORIAL_STEPS.count - 1}"]`)).toBeTruthy();
    expect(button('NEXT')).toBeTruthy();
    expect(button('SKIP TUTORIAL')).toBeTruthy();
    expect(document.querySelector('[data-tutorial-ring]')).toBeNull();
  });

  it('NEXT posts the advance and adopts the SERVER state — never its own increment', async () => {
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue({ step: 1, completedAt: null });
    const onState = vi.fn();
    await render(0, onState);
    await act(async () => {
      button('NEXT').click();
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledWith('/tutorial/advance', { step: 1 });
    expect(onState).toHaveBeenCalledWith({ step: 1, completedAt: null });
  });

  it('a refused advance re-reads the server truth instead of guessing', async () => {
    vi.spyOn(api, 'postRaw').mockRejectedValue(new Error('409'));
    const get = vi.spyOn(api, 'get').mockResolvedValue({ step: 4, completedAt: null });
    const onState = vi.fn();
    await render(0, onState);
    await act(async () => {
      button('NEXT').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledWith('/tutorial');
    expect(onState).toHaveBeenCalledWith({ step: 4, completedAt: null });
  });

  it('SKIP ends the entire guided flow', async () => {
    const done = { step: TUTORIAL_STEPS.count - 1, completedAt: '2026-08-15T00:00:00.000Z' };
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue(done);
    const onState = vi.fn();
    await render(0, onState);
    await act(async () => {
      button('SKIP TUTORIAL').click();
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledWith('/tutorial/guide/skip', {});
    expect(onState).toHaveBeenCalledWith(done);
  });

  it('rings a present anchor and falls back to the card alone when it is missing', async () => {
    // camera step (index 1) anchors on the FIT pill's aria-label.
    await render(1);
    expect(host.textContent).toContain('LOOK AROUND');
    expect(document.querySelector('[data-tutorial-ring]')).toBeNull(); // missing → card alone

    const fit = document.createElement('button');
    fit.setAttribute('aria-label', 'Fit base to screen');
    document.body.append(fit);
    // Remount the step so the measurer runs with the anchor present.
    await render(0);
    await render(1);
    expect(document.querySelector('[data-tutorial-ring]')).toBeTruthy();
  });

  it('rings the player-menu opener while FIT BASE and QUESTS are inside the closed menu', async () => {
    // Floating HUD (2026-09-17): FIT BASE and QUESTS are rows of the player
    // menu, so with the panel closed neither control is in the DOM. A card that
    // only knew the row would show no ring and tell the player to tap something
    // they cannot see; both cards must fall back to the keep-icon opener.
    const opener = document.createElement('button');
    opener.setAttribute('data-tutorial-target', 'player-menu');
    document.body.append(opener);
    await render(1); // camera
    expect(host.textContent).toContain('FIT BASE');
    expect(document.querySelector('[data-tutorial-ring]')).toBeTruthy();
    await render(0);
    await render(2); // quests
    expect(host.textContent).toContain('QUESTS');
    expect(document.querySelector('[data-tutorial-ring]')).toBeTruthy();
  });

  it('auto-advances immediately on a real FIT signal', async () => {
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue({ step: 2, completedAt: null });
    await render(1); // camera: auto = 'base:camera'
    await act(async () => {
      bus.emit('base:camera', { op: 'fit' });
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledWith('/tutorial/advance', { step: 2 });
  });

  /**
   * THE DECK GOT SHORTER (owner 2026-08-28: 14 content cards → 3, the rest are
   * quests). The server stores progress as an INDEX into that list, so real
   * players were mid-run on indexes that no longer exist.
   *
   * Without a settle they are STRANDED, and silently: the overlay finds no copy
   * and renders nothing, the host still believes the run is unfinished, `advance`
   * cannot reach the final step from an index past it, and there is no card to
   * press. Nothing errors and nothing shows — the worst shape a bug can take.
   */
  it('settles a step that no longer exists instead of stranding the player', async () => {
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue({
      step: TUTORIAL_STEPS.count - 1, completedAt: '2026-08-28T00:00:00.000Z',
    });
    const onState = vi.fn();
    // Index 9 was 'raid' in the 14-card deck; it is past the end of the new one.
    await render(9, onState);
    await act(async () => { await Promise.resolve(); });
    expect(post).toHaveBeenCalledWith('/tutorial/guide/skip', {});
    // And it renders nothing while doing so — no half-card, no crash.
    expect(host.textContent).toBe('');
  });

  it('does not settle a step it DOES have copy for', async () => {
    // The guard is "no copy", not "high index": a legitimate step must never be
    // silently completed out from under the player.
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue({ step: 1, completedAt: null });
    await render(0);
    await act(async () => { await Promise.resolve(); });
    expect(post).not.toHaveBeenCalled();
  });

  it('finishes the deck and opens the real quest board in one action', async () => {
    const done = { step: TUTORIAL_STEPS.count - 1, completedAt: '2026-08-30T00:00:00.000Z' };
    vi.spyOn(api, 'postRaw').mockResolvedValue(done);
    await render(TUTORIAL_STEPS.count - 2);
    await act(async () => {
      button('OPEN QUESTS').click();
      await Promise.resolve();
    });
    expect(useApp.getState().screen).toBe('quests');
  });
});

it('the highlighted QUESTS rail action completes the same intro step as OPEN QUESTS', async () => {
  const done = { step: TUTORIAL_STEPS.count - 1, completedAt: '2026-09-05T00:00:00.000Z' };
  const post = vi.spyOn(api, 'postRaw').mockResolvedValue(done);
  const adopted = vi.fn();
  await render(TUTORIAL_STEPS.count - 2, adopted);
  await act(async () => { useApp.setState({ screen: 'quests' }); });
  expect(post).toHaveBeenCalledWith('/tutorial/advance', { step: TUTORIAL_STEPS.count - 1 });
  expect(adopted).toHaveBeenCalledWith(done);
});
