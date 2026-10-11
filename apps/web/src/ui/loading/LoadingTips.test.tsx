/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOADING_TIP_METRICS, LoadingTips, TIP_CROSSFADE_MS, TIP_ROTATE_MS } from './LoadingTips';
import type { LoadingTip } from './loadingTipData';

vi.mock('./AtlasClip', () => ({
  AtlasClip: ({ reduceMotion, size }: { reduceMotion?: boolean; size: number }) => (
    <span data-testid="atlas-clip" data-reduced={reduceMotion ? 'yes' : 'no'} data-size={size} />
  ),
}));

const TIPS: readonly LoadingTip[] = [
  { id: 'one', category: 'BUILD', text: 'First tip', clip: { atlas: 'a', stem: 'a' } },
  { id: 'two', category: 'DEFENCE', text: 'Second tip', clip: { atlas: 'b', stem: 'b' } },
  { id: 'three', category: 'RAID', text: 'Third tip', clip: { atlas: 'c', stem: 'c' } },
];
const zero = (): number => 0;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('loading tip presentation', () => {
  it('pins the sprite sizes of the strip: 56 px regular, 44 px compact, spanning the strip height', () => {
    // WHY (D-193): deriving assertions from the exported values alone would let
    // a future enlargement push the strip past its fixed 88 / 66 px box while
    // this suite stayed green. The sprite is the only tip metric outside CSS
    // because AtlasClip needs a whole-pixel backing size.
    expect(LOADING_TIP_METRICS.regular).toEqual({ sprite: 56 });
    expect(LOADING_TIP_METRICS.compact).toEqual({ sprite: 44 });
    expect(TIP_ROTATE_MS).toBe(6_000);
    expect(TIP_CROSSFADE_MS).toBe(200);
  });

  it('continues the tip on screen when a loading surface hands off, and shuffles afresh later', async () => {
    // WHY: owner 2026-09-27 ("flickering or dizzying on loading box").
    // LoadingScreen hands off to PhaserGame's preparation cover in one commit;
    // a freshly shuffled deck swapped the tip's words and sprite at that moment.
    const high = (): number => 0.999; // keeps the authored order: 'one' first
    const tipOf = (): string | null | undefined => host.querySelector('[data-testid="loading-tip"]')?.getAttribute('data-tip-id');
    // Overlay and PhaserGame share one React root: the screen change that
    // unmounts the loading screen mounts the cover in the same commit.
    const Surface = ({ cover }: { cover: boolean }): React.JSX.Element => (cover
      ? <div key="cover"><LoadingTips tips={TIPS} rng={high} /></div>
      : <section key="screen"><LoadingTips tips={TIPS} rng={zero} /></section>);
    await act(async () => root.render(<Surface cover={false} />));
    const shown = tipOf();
    expect(shown).not.toBe('one');
    await act(async () => root.render(<Surface cover />));
    expect(tipOf()).toBe(shown);
    // Nothing changes at the handoff: the continued text is not faded in.
    expect(host.querySelector('[data-enter]')).toBeNull();
    expect(host.querySelector('[data-leave]')).toBeNull();
    // With no surface on screen, a later one starts its own deck.
    await act(async () => root.render(null));
    await act(async () => root.render(<Surface cover />));
    expect(tipOf()).toBe('one');
  });

  it('shows every shuffled card before the deck repeats', async () => {
    await act(async () => root.render(
      <LoadingTips tips={TIPS} rng={zero} rotateMs={1_000} />,
    ));
    const shown = (): string => host.querySelector('[data-tip-id]')?.getAttribute('data-tip-id') ?? '';
    const cycle = [shown()];
    for (let i = 1; i < TIPS.length; i += 1) {
      await act(async () => vi.advanceTimersByTime(1_000));
      cycle.push(shown());
    }
    expect(new Set(cycle)).toEqual(new Set(TIPS.map((tip) => tip.id)));
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(shown()).toBe(cycle[0]);
  });

  it('crossfades only the text on rotation, in one cell, for 200 ms, and never on mount', async () => {
    // WHY (D-193): the tip rotates every 6 s with a 200 ms crossfade of the TEXT
    // only; a fade on mount would replay at every loading-surface handoff, and
    // a fade that changed the line's height would move the strip.
    await act(async () => root.render(<LoadingTips tips={TIPS} rng={zero} rotateMs={1_000} />));
    const texts = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.sk-game-loading-tiptext')];
    expect(texts().length).toBe(1);
    expect(texts()[0]!.hasAttribute('data-enter')).toBe(false);
    const before = texts()[0]!.textContent;
    await act(async () => vi.advanceTimersByTime(1_000));
    const during = texts();
    expect(during.length).toBe(2);
    expect(during[0]!.getAttribute('data-leave')).toBe('true');
    expect(during[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(during[0]!.textContent).toBe(before);
    expect(during[1]!.getAttribute('data-enter')).toBe('true');
    expect(during[1]!.textContent).not.toBe(before);
    // Both texts share the same tip line; the sprite is not part of the fade.
    expect(during[0]!.parentElement).toBe(during[1]!.parentElement);
    expect(during[0]!.parentElement?.className).toBe('sk-game-loading-tip');
    expect(host.querySelector('[data-tip-sprite]')?.hasAttribute('data-leave')).toBe(false);
    await act(async () => vi.advanceTimersByTime(TIP_CROSSFADE_MS));
    expect(texts().length).toBe(1);
    expect(texts()[0]!.hasAttribute('data-leave')).toBe(false);
  });

  it('commits the leaving and the entering text in ONE DOM commit, so no frame shows the new tip solid before it fades', async () => {
    // WHY (D-193 rule 3, review 2026-09-28): the rotation used to commit the
    // new text first and arm the crossfade from a passive effect, which React
    // may flush after the browser paints. Chromium could then paint the new
    // tip at full opacity for a frame and snap it to opacity 0 as the fade
    // began — a blink on the 6 s cadence, the flicker the owner reported.
    // Deriving `leaving` during render lands both spans, with their fade
    // attributes, in the same commit. A React-DOM node is created with its
    // attributes before insertion, so a same-commit crossfade leaves NO
    // `attributes` mutation for data-enter; the old two-commit path did.
    await act(async () => root.render(<LoadingTips tips={TIPS} rng={zero} rotateMs={1_000} />));
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(host, { subtree: true, childList: true, attributes: true });
    await act(async () => vi.advanceTimersByTime(1_000));
    records.push(...observer.takeRecords());
    observer.disconnect();
    const fadeAttributes = records.filter((r) => r.type === 'attributes' && (r.attributeName === 'data-enter' || r.attributeName === 'data-leave'));
    expect(fadeAttributes).toEqual([]);
    const texts = [...host.querySelectorAll<HTMLElement>('.sk-game-loading-tiptext')];
    expect(texts.map((t) => [t.getAttribute('data-leave'), t.getAttribute('data-enter')])).toEqual([['true', null], [null, 'true']]);
  });

  it('hard-switches the text under reduced motion and keeps the advice readable', async () => {
    await act(async () => root.render(
      <LoadingTips tips={TIPS} rng={zero} rotateMs={1_000} reduceMotion />,
    ));
    expect(host.querySelector('[data-testid="atlas-clip"]')?.getAttribute('data-reduced')).toBe('yes');
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(host.querySelectorAll('.sk-game-loading-tiptext').length).toBe(1);
    expect(host.querySelector('[data-leave]')).toBeNull();
    expect(host.querySelector('[data-enter]')).toBeNull();
    expect(host.textContent).toMatch(/TIP/);
  });

  it('prints the category in gold caps before the text on one line, and keeps only the sprite when asked', async () => {
    await act(async () => root.render(
      <LoadingTips tips={TIPS.slice(0, 1)} rng={zero} />,
    ));
    const card = host.querySelector('[data-testid="loading-tip"]') as HTMLElement;
    expect(card.dataset.tipCompact).toBe('false');
    expect(card.dataset.tipSpriteSize).toBe(String(LOADING_TIP_METRICS.regular.sprite));
    expect(host.querySelector('.sk-game-loading-tipcat')?.textContent).toBe('BUILD TIP');
    expect(host.querySelector('.sk-game-loading-tiptext')?.textContent).toBe('BUILD TIPFirst tip');
    expect(host.querySelector('[data-testid="atlas-clip"]')?.getAttribute('data-size')).toBe('56');

    await act(async () => root.render(
      <LoadingTips compact tips={TIPS.slice(0, 1)} rng={zero} text={false} />,
    ));
    expect(card.dataset.tipCompact).toBe('true');
    expect(card.dataset.tipSpriteSize).toBe(String(LOADING_TIP_METRICS.compact.sprite));
    expect(host.querySelector('[data-testid="atlas-clip"]')?.getAttribute('data-size')).toBe('44');
    // text={false}: the strip prints a notice on the tip line; the sprite stays.
    expect(host.querySelector('.sk-game-loading-tip')).toBeNull();
    expect(host.querySelector('[data-tip-sprite]')).not.toBeNull();
  });
});
