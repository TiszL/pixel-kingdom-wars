/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../../lib/version';
import { GameLoading } from './GameLoading';
import { LoadingStage } from './LoadingStage';

vi.mock('./AtlasClip', () => ({
  AtlasClip: () => <span data-testid="atlas-clip" />,
}));

let root: Root, host: HTMLDivElement;
const css = readFileSync('src/ui/loading/gameLoading.css', 'utf8');
const rule = (selector: string): string => new RegExp(`${selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('docks the strip at the bottom of the screen above the safe area, never as a centred card', async () => {
  // WHY (D-193, teammate 2026-09-28): "minimize the opening kingdom bar and
  // place it on the bottom of the screen. This way players can enjoy the view
  // of the graphics while the game loads". The wallpaper fills the screen; the
  // strip is a slim plate in the bottom band, 12 px + inset on phones, 24 px on
  // desktop, centred, at most 560 px wide with 16 px gutters.
  await act(async () => root.render(<LoadingStage><GameLoading title="Opening your kingdom…" tips /></LoadingStage>));
  const dock = host.querySelector('.sk-loading-dock')!;
  const strip = host.querySelector('.sk-game-loading')!;
  expect(strip.parentElement).toBe(dock);
  expect(host.querySelector('[data-brand-state] img')?.getAttribute('src')).toMatch(/\/brand\/brand_loading_bg_(?:portrait|landscape)\.png/);
  const dockRule = rule('.sk-loading-dock');
  expect(dockRule).toContain('position:absolute');
  expect(dockRule).toContain('bottom:0');
  expect(dockRule).toContain('flex-direction:column');
  expect(dockRule).toContain('align-items:center');
  expect(dockRule).toContain('calc(12px + env(safe-area-inset-bottom,0px))');
  expect(dockRule).toMatch(/padding:0 max\(16px,env\(safe-area-inset-right\)\)/);
  expect(dockRule).not.toMatch(/justify-content:(?:safe )?center/);
  expect(css).toMatch(/@media\(min-width:768px\) and \(min-height:500px\)\{\s*\.sk-loading-dock\{padding-bottom:24px\}/);
  // Nothing else is on the loading screen: wallpaper, the strip, the version label.
  expect(dock.children.length).toBe(2);
});

it('prints one product version, bottom-left, outside the strip, in the shared label format', async () => {
  // WHY (D-192): "web version is still 0.6.1 and native 0.6.5 inconsistent
  // versioning" — one number and one label on both clients:
  // "PIXEL KINGDOM WARS v<version>", one space, no dot.
  await act(async () => root.render(<LoadingStage><GameLoading title="Opening your kingdom…" /></LoadingStage>));
  const label = host.querySelector('.sk-loading-version')!;
  expect(label.textContent).toBe(`PIXEL KINGDOM WARS ${APP_VERSION}`);
  expect(label.textContent).toMatch(/^PIXEL KINGDOM WARS v\d/);
  expect(label.getAttribute('aria-label')).toBe(`Version ${APP_VERSION}`);
  expect(host.querySelector('.sk-game-loading')!.contains(label)).toBe(false);
  expect(label.nextElementSibling).toBe(host.querySelector('.sk-game-loading'));
  const labelRule = rule('.sk-loading-version');
  expect(labelRule).toContain('align-self:flex-start');
  expect(labelRule).toMatch(/font:13px/);
  expect(labelRule).toContain('background:rgba(16,14,20,.72)');
  // The desktop corner placement switches on at 960 px, NOT with the dock's 768 px
  // padding: the 167 px label plus two 16 px gutters must end before the centred
  // 560 px strip's left edge ((width − 560) / 2 ≥ 199 px ⇒ width ≥ 926 px). At
  // 768–925 px (iPad portrait, small windows) an absolute label painted over the
  // sprite (review 2026-09-28: 79 × 19 px overlap at 768 × 1024).
  expect(css).toMatch(/@media\(min-width:960px\) and \(min-height:500px\)\{\s*\.sk-loading-version\{position:absolute;left:max\(16px,env\(safe-area-inset-left\)\);bottom:24px\}/);
  expect(css).not.toMatch(/@media\(min-width:768px\) and \(min-height:500px\)\{[^}]*\}\s*\.sk-loading-version\{position:absolute/);
  const desktop768 = /@media\(min-width:768px\) and \(min-height:500px\)\{((?:[^{}]*\{[^}]*\})*)\s*\}/.exec(css)?.[1] ?? '';
  expect(desktop768).toContain('.sk-loading-dock{padding-bottom:24px}');
  expect(desktop768).not.toContain('sk-loading-version');
});

it('keeps the strip and the label where they are across a state change', async () => {
  // WHY (D-193): the box that failed and the box that was opening are the same
  // DOM node in the same dock slot; only words and an in-place button change.
  await act(async () => root.render(<LoadingStage><GameLoading title="Opening your kingdom…" tips /></LoadingStage>));
  const strip = host.querySelector('.sk-game-loading');
  const label = host.querySelector('.sk-loading-version');
  await act(async () => root.render(<LoadingStage>
    <GameLoading title="Couldn’t load your kingdom" failed detail="Check your connection and try again." tips>
      <button type="button">TRY AGAIN</button>
    </GameLoading>
  </LoadingStage>));
  expect(host.querySelector('.sk-game-loading')).toBe(strip);
  expect(host.querySelector('.sk-loading-version')).toBe(label);
  expect(strip!.querySelector('.sk-game-loading-actions button')?.textContent).toBe('TRY AGAIN');
  expect(rule('.sk-game-loading-actions button,.sk-game-loading-back')).toMatch(/min-width:48px!important;min-height:48px!important/);
});
