import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./world.css', import.meta.url), 'utf8');

describe('owner search stays scrollable inside the visible game frame', () => {
  it('leaves only a compact touch control when details are collapsed', () => {
    const panel = css.match(/\.fantasy-world\.panel-closed \.fantasy-world-panel\{([^}]+)\}/)?.[1];
    expect(panel).toContain('width:max-content');
    expect(panel).toContain('left:auto');
    expect(panel).toContain('background:transparent');
    expect(panel).toContain('box-shadow:none');
    const toggle = css.match(/\.fantasy-world\.panel-closed \.fantasy-panel-toggle\{([^}]+)\}/)?.[1];
    expect(toggle).toContain('min-width:44px');
    expect(toggle).toContain('min-height:44px');
    const tools = css.match(/\.fantasy-world\.panel-closed \.fantasy-world-tools\{([^}]+)\}/)?.[1];
    expect(tools).toContain('max-width:calc(100% - 16px - env(safe-area-inset-left) - env(safe-area-inset-right))');
  });
  it('keeps focused owner results above the open mobile parcel panel', () => {
    const panel = Number(css.match(/\.fantasy-world-panel\{[^}]*z-index:(\d+)/)?.[1]);
    const focusedTools = Number(css.match(/\.fantasy-world-tools:focus-within\{z-index:(\d+)/)?.[1]);
    // A higher z-index on the results alone cannot escape a lower parent.
    expect(focusedTools).toBeGreaterThan(panel);
  });
  it.each([[844, 320, 0, 21], [568, 320, 0, 0], [844, 390, 0, 21], [390, 844, 47, 34]])(
    'keeps the bottom result reachable at %dx%d with safe areas', (width, height, safeTop, safeBottom) => {
      const rules = [...css.matchAll(/\.fantasy-owner-results\{([^}]+)\}/g)].map(match => match[1]!);
      const declaration = rules[width! <= 760 ? 1 : 0]!;
      const bound = declaration.match(/max-height:min\((\d+)px,calc\(var\(--game-viewport-height,100dvh\) - (\d+)px - env\(safe-area-inset-top\) - env\(safe-area-inset-bottom\)\)\)/);
      expect(bound).not.toBeNull();
      // The menu's longest supported anchor is desktop tools top124 +5px
      // padding +44px search. Short landscape and mobile anchors are lower.
      const anchor = (height! <= 480 && width! >= 600 ? 108 + 4 : width! <= 760 ? 116 + 3 : 124 + 5) + 44 + safeTop!;
      const maximum = Math.min(Number(bound![1]), height! - Number(bound![2]) - safeTop! - safeBottom!);
      expect(maximum).toBeGreaterThanOrEqual(44);
      expect(anchor + maximum).toBeLessThanOrEqual(height! - safeBottom!);
      expect(css).toContain('overscroll-behavior:contain');
    },
  );
});
