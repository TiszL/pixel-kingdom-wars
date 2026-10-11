import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { isPortraitSize } from './ui/layout';
import { LOADING_STRIP } from './ui/loading/GameLoading';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

function parseDocument() {
  const window = new Window();
  window.document.write(html);
  return window.document;
}

describe('the pre-React boot fallback', () => {
  it('gives a clean install an accessible status over retained loading art before the module bundle executes', () => {
    const document = parseDocument();
    const root = document.querySelector('#root');
    const fallback = document.querySelector('[data-pre-react-boot]');

    expect(fallback?.parentElement).toBe(root);
    expect(fallback?.getAttribute('role')).toBe('status');
    expect(fallback?.getAttribute('aria-live')).toBe('polite');
    expect(fallback?.getAttribute('aria-atomic')).toBe('true');
    expect(fallback?.textContent).toContain('Loading game');
    expect(fallback?.textContent).not.toContain('PIXEL KINGDOM WARS');
    expect(fallback?.querySelector('.pre-react-boot__brand')).toBeNull();
    expect(fallback?.querySelector('img, picture, video, audio, source')).toBeNull();
    const picture = root?.querySelector('picture');
    // React's usePortrait rule (w <= 1.1h), not CSS orientation (w <= h); see
    // the agreement test below.
    expect(picture?.querySelector('source')?.getAttribute('media')).toBe('(max-aspect-ratio: 11/10)');
    // Owner 2026-09-24: loading surfaces use the bright loading wallpaper, not
    // the dark title backdrop, from the very first paint.
    expect(picture?.querySelector('source')?.getAttribute('srcset')).toContain('brand_loading_bg_portrait.png?v=__PKW_BUILD_SHA__');
    expect(picture?.querySelector('img')?.getAttribute('src')).toContain('brand_loading_bg_landscape.png?v=__PKW_BUILD_SHA__');
    expect(html).not.toContain('brand_title_bg_');
    expect(html).not.toContain('brightness(.45)');
    expect(picture?.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(html).not.toMatch(/brand_(?:logo|emblem|wordmark)/i);

    // React owns this same container, so its first render replaces the fallback.
    expect(mainSource).toContain("createRoot(document.getElementById('root')!).render(");
  });

  it('docks the boot status in a plate of the loading strip\'s size and place, never at the screen centre', () => {
    // WHY (D-193, review 2026-09-28): the pre-React status was a centred plate
    // and React's first frame replaced it with the bottom strip, so on every
    // cold load the loading words relocated from the centre to the bottom — the
    // one loading transition that still changed geometry, and the first thing
    // a player sees. The status is now a plate with the strip's own box, in the
    // strip's own band, so React draws its strip over the same pixels.
    const document = parseDocument();
    const strip = document.querySelector('[data-pre-react-boot] > .pre-react-boot__strip');
    expect(strip?.querySelector('.pre-react-boot__status')?.textContent).toBe('Loading game…');
    expect(strip?.querySelector('[data-pre-react-recovery]')).not.toBeNull();
    const rule = (selector: string): string => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(html)?.[1] ?? '';
    const boot = rule('.pre-react-boot');
    expect(boot).toContain('align-content: end');
    expect(boot).not.toMatch(/place-items|align-items: center/);
    expect(boot).toContain('calc(12px + env(safe-area-inset-bottom, 0px))');
    expect(html).toMatch(/@media \(min-width: 768px\) and \(min-height: 500px\) \{\s*\.pre-react-boot \{ padding-bottom: 24px; \}/);
    const plate = rule('.pre-react-boot__strip');
    expect(plate).toContain(`width: min(100%, ${LOADING_STRIP.maxWidth}px)`);
    expect(plate).toContain(`height: ${LOADING_STRIP.height.regular}px`);
    expect(plate).toContain('background: rgba(26, 23, 30, .82)');
    expect(plate).toContain('border: 1px solid #6b6354');
    expect(html).toMatch(new RegExp(`@media \\(max-height: 499px\\), \\(max-width: 359px\\) \\{\\s*\\.pre-react-boot__strip \\{ height: ${LOADING_STRIP.height.compact}px;`));
    // The weak-network help pops in above the plate; the plate itself never moves.
    const recovery = rule('.pre-react-boot__recovery');
    expect(recovery).toContain('position: absolute');
    expect(recovery).toContain('bottom: calc(100% + 8px)');
  });

  it('picks the same wallpaper orientation as React so the handoff never swaps files', () => {
    // WHY: if the pre-React media query and React's isPortraitSize disagree, a
    // near-square window (say 1050x1000) paints and downloads one ~0.5 MB
    // wallpaper, then React swaps to the other file with a dark gap between.
    const document = parseDocument();
    const aspect = (media: string, w: number, h: number): boolean => {
      const m = /^\((max|min)-aspect-ratio:\s*(\d+)\/(\d+)\)$/.exec(media);
      if (!m) throw new Error(`unexpected wallpaper media ${media}`);
      const [n, d] = [Number(m[2]), Number(m[3])];
      return m[1] === 'max' ? w * d <= h * n : w * d >= h * n;
    };
    const portraitSource = document.querySelector('picture source')!.getAttribute('media')!;
    const preload = (file: string): string => document
      .querySelector(`link[rel="preload"][href*="brand_loading_bg_${file}.png"]`)!.getAttribute('media')!;
    const sizes: [number, number][] = [[390, 844], [1000, 1000], [1050, 1000], [1100, 1000], [1101, 1000], [1110, 1000], [1280, 720], [844, 390]];
    for (const [w, h] of sizes) {
      const port = isPortraitSize(w, h);
      expect(aspect(portraitSource, w, h), `${w}x${h} picture`).toBe(port);
      expect(aspect(preload('portrait'), w, h), `${w}x${h} portrait preload`).toBe(port);
      // Only ratios strictly between 1.1 and 1.101 miss both preloads; there
      // the picture still falls back to the landscape img, as React does.
      expect(aspect(preload('landscape'), w, h), `${w}x${h} landscape preload`).toBe(!port);
    }
  });

  it('reveals weak-network help within a bounded delay and offers a real same-URL navigation retry', () => {
    const document = parseDocument();
    const recovery = document.querySelector('[data-pre-react-recovery]');
    const retry = recovery?.querySelector('a');
    const delay = /--boot-recovery-delay:\s*([\d.]+)s/.exec(html);

    expect(recovery?.textContent).toContain('Check your connection');
    expect(html).toContain('var(--boot-recovery-delay) forwards');
    expect(Number(delay?.[1])).toBeGreaterThanOrEqual(3);
    expect(Number(delay?.[1])).toBeLessThanOrEqual(10);
    expect(retry?.getAttribute('href')).toBe('');
    expect(retry?.textContent).toBe('RETRY');
  });

  it('does not depend on executable inline script for loading or recovery UI', () => {
    const document = parseDocument();
    const scripts = [...document.querySelectorAll('script')];

    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute('type')).toBe('module');
    expect(scripts[0]?.getAttribute('src')).toBe('/src/main.tsx');
    expect(scripts[0]?.textContent?.trim()).toBe('');
  });

  it('preloads only the matching orientation with the build-version placeholder', () => {
    const document = parseDocument();
    const preloads = [...document.querySelectorAll('link[rel="preload"][as="image"]')];

    expect(preloads).toHaveLength(2);
    // The 1.1 aspect split matches React's usePortrait, so the preloaded file
    // is the one React keeps showing (agreement is checked above).
    expect(preloads.map((link) => link.getAttribute('media'))).toEqual([
      '(max-aspect-ratio: 11/10)', '(min-aspect-ratio: 1101/1000)',
    ]);
    expect(preloads.every((link) => link.getAttribute('href')?.endsWith('?v=__PKW_BUILD_SHA__'))).toBe(true);
    expect(preloads.every((link) => link.getAttribute('fetchpriority') === 'high')).toBe(true);
  });

  it('migrates stale mobile Phantom selection before React initializes WalletProvider', () => {
    const migration = mainSource.indexOf('migrateMobilePhantomWalletStorage(caps.platform)');
    const render = mainSource.indexOf("createRoot(document.getElementById('root')!).render(");
    expect(migration).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(migration);
  });
});
