/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GameLoading, isCompactLoading, LOADING_STRIP } from './GameLoading';

vi.mock('./AtlasClip', () => ({
  AtlasClip: () => <span data-testid="atlas-clip" />,
}));

let root: Root, host: HTMLDivElement;
const css = (): string => readFileSync('src/ui/loading/gameLoading.css', 'utf8');
const rule = (selector: string): string => new RegExp(`${selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(css())?.[1] ?? '';
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('keeps unknown local work honest and changes only measured transfer progress', async () => {
  await act(async () => root.render(<GameLoading title="Opening the world…" />));
  const bar = () => host.querySelector('[role="progressbar"]')!;
  expect(bar().hasAttribute('aria-valuenow')).toBe(false);
  expect(host.textContent).not.toContain('Downloading');
  await act(async () => root.render(<GameLoading title="Opening the world…" transferPercent={15.9} />));
  expect(bar().getAttribute('aria-valuenow')).toBe('15');
  expect(host.textContent).toContain('Downloading · 15%');
  await act(async () => root.render(<GameLoading title="Opening the world…" transferPercent={null} />));
  expect(host.textContent).not.toContain('%');
});

it('never lets a measured percent fall back while the transfer stays measured', async () => {
  // WHY (D-193): a meter that ticks backwards reads as the download restarting.
  // Resumed byte reports can arrive out of order; the strip holds the high
  // mark until the transfer ends (null), which releases it for the next one.
  const bar = () => host.querySelector('[role="progressbar"]')!;
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" transferPercent={40} />));
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" transferPercent={31} />));
  expect(bar().getAttribute('aria-valuenow')).toBe('40');
  expect(host.textContent).toContain('Downloading · 40%');
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" transferPercent={63} />));
  expect(bar().getAttribute('aria-valuenow')).toBe('63');
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" transferPercent={null} />));
  expect(bar().hasAttribute('aria-valuenow')).toBe(false);
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" transferPercent={5} />));
  expect(bar().getAttribute('aria-valuenow')).toBe('5');
});

it('preserves recovery actions and stops progress animation when a load fails', async () => {
  await act(async () => root.render(<GameLoading title="Couldn’t open the world" failed detail="Check your connection and try again."><button>TRY AGAIN</button></GameLoading>));
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  // The reason takes the tip line; the button sits in the actions area at the right.
  expect(host.querySelector('.sk-game-loading-tip[data-notice]')?.textContent).toBe('Check your connection and try again.');
  expect(host.querySelector('.sk-game-loading-actions button')?.textContent).toBe('TRY AGAIN');
});

it('announces a paused optional download on the tip line without failing the strip', async () => {
  // WHY: the Solana Mobile pack is background work (D-050); its pause must not
  // present the whole opening as failed, but the player still needs the reason
  // and a retry. One strip carries both without a second alert box.
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" detail="Download paused. Please try again." tips><button>TRY AGAIN</button></GameLoading>));
  expect(host.querySelector('section')?.getAttribute('role')).toBe('status');
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(host.querySelector('.sk-game-loading-tip[data-notice]')?.getAttribute('role')).toBe('alert');
  // The sprite stays; only the tip's words yield to the notice.
  expect(host.querySelector('[data-tip-sprite]')).not.toBeNull();
  expect(host.querySelectorAll('.sk-game-loading-tip').length).toBe(1);
});

it('supports the game motion setting without losing the loading status', async () => {
  await act(async () => root.render(<GameLoading title="Entering battle…" reduceMotion />));
  expect(host.querySelector('[data-reduced-motion="true"]')).not.toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Entering battle');
  const reduced = css();
  expect(reduced).toContain('.sk-game-loading[data-reduced-motion] .sk-game-loading-meter>span{animation:none;transition:none}');
  expect(reduced).toContain('.sk-game-loading[data-reduced-motion] .sk-game-loading-tiptext{animation:none}');
  expect(reduced).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\.sk-game-loading,\.sk-game-loading-meter>span,\.sk-game-loading-tiptext\{animation:none!important/);
});

it('keeps one strip node across title and progress changes so its sweep never restarts', async () => {
  // WHY: remounting the strip restarts the meter sweep (and used to replay a
  // fade-in), which the owner saw as the loader flicking.
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" tips />));
  const strip = host.querySelector('.sk-game-loading');
  const meter = host.querySelector('.sk-game-loading-meter');
  const tip = host.querySelector('[data-testid="loading-tip"]');
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" transferPercent={40} tips />));
  await act(async () => root.render(<GameLoading title="Entering battle…" transferPercent={null} tips />));
  expect(host.querySelector('.sk-game-loading')).toBe(strip);
  expect(host.querySelector('.sk-game-loading-meter')).toBe(meter);
  expect(host.querySelector('[data-testid="loading-tip"]')).toBe(tip);
});

it('renders every state into one fixed box: reserved head line, reserved tip line, fixed heights', async () => {
  // WHY: owner 2026-09-27 "web during loading still has flickering or dizzying
  // on loading box"; D-193 "the strip never moves or resizes after it appears".
  // The old card grew a line for measured bytes (139 <-> 175 px on a 390 px
  // phone). The strip keeps its head line and tip line in the DOM at all
  // times, and its height is fixed in CSS, so a percent, a reason or a button
  // can only change words inside the same box.
  const detail = (): Element => host.querySelector('.sk-game-loading-detail')!;
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" />));
  const reserved = detail();
  expect(reserved.hasAttribute('data-reserved')).toBe(true);
  expect(reserved.getAttribute('aria-hidden')).toBe('true');
  expect(reserved.textContent).toBe('\u00a0');
  expect(host.querySelector('.sk-game-loading-tip[data-reserved]')?.getAttribute('aria-hidden')).toBe('true');
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" transferPercent={24} />));
  expect(detail()).toBe(reserved);
  expect(detail().hasAttribute('data-reserved')).toBe(false);
  expect(detail().hasAttribute('aria-hidden')).toBe(false);
  expect(detail().textContent).toBe('Downloading · 24%');
  const strip = rule('.sk-game-loading');
  expect(strip).toContain(`height:${LOADING_STRIP.height.regular}px`);
  expect(strip).toContain(`width:min(100%,${LOADING_STRIP.maxWidth}px)`);
  expect(strip).toContain('grid-template-areas:"sprite head actions" "sprite meter actions" "sprite tip actions"');
  expect(rule('.sk-game-loading[data-compact]')).toContain(`height:${LOADING_STRIP.height.compact}px`);
  // The reserved head line keeps its row but no width: on a 390 px phone its
  // blank plus the head gap cost the title the last character of "Couldn’t
  // load your kingdom" next to a TRY AGAIN button.
  expect(css()).toContain('.sk-game-loading-detail[data-reserved]{visibility:hidden;width:0;margin:0;overflow:hidden}');
  expect(css()).toContain('.sk-game-loading-tip[data-reserved]{visibility:hidden}');
  // The tip line is clamped, never taller than its two lines.
  expect(rule('.sk-game-loading-tiptext')).toContain('-webkit-line-clamp:2');
});

it('is compact only on short or narrow viewports, so a phone strip stays one row of content', () => {
  expect(isCompactLoading({ w: 390, h: 844 })).toBe(false);
  expect(isCompactLoading({ w: 844, h: 390 })).toBe(true);
  expect(isCompactLoading({ w: 320, h: 640 })).toBe(true);
  expect(isCompactLoading({ w: 1280, h: 800 })).toBe(false);
});

it('does not fade the strip in or move it on appear, because every loading-surface handoff mounts a new one', () => {
  // WHY: owner 2026-09-27. The pre-React boot, LoadingScreen and PhaserGame's
  // preparation cover each show their own strip; a 0.18 s fade replayed on each
  // one blinked the box out and back mid-load (30-40 faded frames per load in
  // a SwiftShader capture). D-193 adds: no transform on appear either.
  const strip = rule('.sk-game-loading');
  expect(strip).toContain('background:');
  expect(strip).not.toMatch(/animation|transition|transform/);
  expect(css()).not.toContain('sk-loading-appear');
  // The plate is the HUD's: no rounded corners, no drop shadow.
  expect(strip).not.toMatch(/border-radius|box-shadow/);
});

it('sweeps the indeterminate meter one way at constant speed instead of ping-ponging', () => {
  // WHY: owner 2026-09-24 "fix dizzy loading animation flicking strangely on
  // web". The eased alternate bounce was the dizzy motion; a width transition
  // left running while indeterminate made mode switches jump.
  const sweep = rule('.sk-game-loading-meter[data-indeterminate]>span');
  expect(sweep).toContain('animation:sk-game-loading-travel');
  expect(sweep).toMatch(/\blinear infinite\b/);
  expect(sweep).not.toMatch(/alternate|ease/);
  expect(sweep).toContain('transition:none');
  const keyframes = /@keyframes sk-game-loading-travel\{(.*?\})\}/.exec(css())?.[1] ?? '';
  expect(keyframes).toContain('0%{transform:translateX(-100%);opacity:0}');
  expect(keyframes).toContain('100%{transform:translateX(455%);opacity:0}');
});

it('leaves the version label to the stage: nothing else is on the strip', async () => {
  // WHY (D-193): the strip is title, meter, tip and actions. The version line
  // lives in the screen's bottom-left corner (LoadingStage), outside the strip.
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" tips />));
  expect(host.textContent).not.toContain('PIXEL KINGDOM WARS');
  expect(host.querySelector('.sk-game-loading')!.contains(host.querySelector('[data-testid="loading-tip"]'))).toBe(true);
});

it('keeps every column in place on narrow strips and keeps the clipped "Downloading" prefix readable to assistive tech', async () => {
  // WHY (review 2026-09-28 on D-193): on strips under 440 px (every portrait
  // phone) the 22 px title cannot share the column with the sprite AND a
  // measured detail or a button. The first cut hid the "Downloading · " prefix
  // with display:none (which also removes it from the accessibility tree, so a
  // screen reader heard a bare "47%") and dropped the sprite whenever a notice
  // showed, shifting the title, meter and tip 68 px left and back — content
  // moving inside the box D-193 had just fixed. Now the prefix is clipped, not
  // removed; the sprite column stays in every state; a FAILED title takes the
  // compact 18 px and the button may wrap, so the words still fit whole.
  const narrow = /@media\(max-width:439px\)\{((?:[^{}]*\{[^}]*\})*)\s*\}/.exec(css())?.[1] ?? '';
  expect(narrow).toContain('.sk-game-loading-detail>span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}');
  expect(narrow).not.toContain('display:none');
  expect(narrow).not.toMatch(/grid-template|sprite/);
  expect(narrow).toContain('.sk-game-loading[data-failed] h2{font-size:18px}');
  expect(narrow).toContain('.sk-game-loading-actions button{white-space:normal;width:min-content}');
  // Same specificity as the base nowrap rule, so the narrow block must come AFTER it or nowrap wins the tie
  // (the first cut lost that tie: "TRY AGAIN" overflowed a 64 px box and the column shrank to 188 px).
  expect(css().indexOf('@media(max-width:439px)')).toBeGreaterThan(css().indexOf('.sk-game-loading-actions button,.sk-game-loading-back{'));
  await act(async () => root.render(<GameLoading title="Opening your kingdom…" transferPercent={47} tips />));
  expect(host.querySelector('.sk-game-loading-detail')?.textContent).toBe('Downloading · 47%');
  expect(host.querySelector('.sk-game-loading')!.hasAttribute('data-failed')).toBe(false);
  await act(async () => root.render(<GameLoading title="Couldn’t load your kingdom" failed detail="Check your connection and try again." tips><button>TRY AGAIN</button></GameLoading>));
  expect(host.querySelector('.sk-game-loading')!.getAttribute('data-failed')).toBe('true');
  expect(host.querySelector('[data-tip-sprite]')).not.toBeNull();
});
