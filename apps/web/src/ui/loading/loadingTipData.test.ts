import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clipFramesOf } from './AtlasClip';
import { LOADING_TIPS, shuffleTips, tipAtlases } from './loadingTipData';

function rng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

describe('loading tip deck', () => {
  it('covers every approved gameplay category without a false Vault-capacity claim', () => {
    expect(new Set(LOADING_TIPS.map((tip) => tip.category))).toEqual(
      new Set(['BUILD', 'DEFENCE', 'TROOPS', 'HEROES', 'RAID']),
    );
    expect(new Set(LOADING_TIPS.map((tip) => tip.id)).size).toBe(LOADING_TIPS.length);
    const vaultCopy = LOADING_TIPS.filter((tip) => tip.text.includes('Vault')).map((tip) => tip.text).join(' ');
    expect(vaultCopy).not.toMatch(/capacity|holds|overflow|discard/i);
    expect(vaultCopy).toMatch(/standing Vault protects/i);
  });

  it('shows every card once before repeating and never mutates its source', () => {
    const before = LOADING_TIPS.map((tip) => tip.id);
    const deck = shuffleTips(LOADING_TIPS, rng(7));
    expect(new Set(deck.map((tip) => tip.id)).size).toBe(LOADING_TIPS.length);
    expect(deck.map((tip) => tip.id)).not.toEqual(before);
    expect(LOADING_TIPS.map((tip) => tip.id)).toEqual(before);
  });

  it('points every card at a real generated animation', () => {
    const atlases = new Map(tipAtlases().map((atlas) => {
      const path = new URL(`../../../public/atlas/${atlas}@1x.json`, import.meta.url);
      return [atlas, JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof clipFramesOf>[0]];
    }));
    const broken = LOADING_TIPS.flatMap((tip) => {
      const frames = clipFramesOf(atlases.get(tip.clip.atlas)!, tip.clip.stem);
      return frames.length > 1 ? [] : [`${tip.id}: ${tip.clip.atlas}/${tip.clip.stem}`];
    });
    expect(broken).toEqual([]);
  });

  it('keeps the production picture behind tips without reintroducing the logo or a stale board capture', () => {
    const overlay = readFileSync(new URL('../Overlay.tsx', import.meta.url), 'utf8');
    const loading = overlay.slice(
      overlay.indexOf('function LoadingScreen'),
      overlay.indexOf('// TITLE —'),
    );
    // The wallpaper + strip composition is the shared LoadingStage, which
    // PhaserGame's preparation cover also renders so the handoff between the
    // two surfaces does not move the strip (owner 2026-09-27: loading flicker).
    // The tips render INSIDE the strip (D-193: sprite at the left, the tip on
    // the strip's last line), so the strip carries them, not the stage.
    expect(loading).toContain('<LoadingStage');
    const stage = readFileSync(new URL('./LoadingStage.tsx', import.meta.url), 'utf8');
    const status = readFileSync(new URL('./GameLoading.tsx', import.meta.url), 'utf8');
    expect(stage).not.toContain('<LoadingTips');
    expect(status).toContain('<LoadingTips');
    expect(loading).toContain('<GameLoading');
    expect(loading).toMatch(/<GameLoading [^>]*\btips\b/);
    expect(status).toContain('role="progressbar"');
    // The shared status is part of the loading screen's presentation boundary.
    // A refactor must not reintroduce the removed logo/emblem through it.
    expect(status).not.toMatch(/BRAND_(?:LOGO|EMBLEM|WORDMARK)|<img|<Sprite|<BrandImage|✦/);
    // The player sees one concise retry label; each action still retries its
    // own operation. The owner removed the version footer from this screen.
    expect(loading).toContain("setRestore('hydrating');");
    expect(loading).toContain('onClick={retryPack}>TRY AGAIN');
    expect(loading).not.toContain('APP_VERSION');
    // Owner 2026-09-24: loading was too dark. It shows the bright loading key
    // art, lightly dimmed; the tips row and status card carry their own plates.
    // The wallpaper is the shared LoadingBackdrop, so the base-opening shell
    // in PhaserGame shows the same picture after this screen hands off.
    const backdrop = readFileSync(new URL('./LoadingBackdrop.tsx', import.meta.url), 'utf8');
    expect(stage).toContain('<LoadingBackdrop />');
    expect(backdrop).toContain("filter: 'brightness(.9)'");
    for (const source of [loading, stage]) {
      expect(source).not.toContain('brightness(.45)');
      expect(source).not.toMatch(/BRAND_(?:LOGO|EMBLEM|WORDMARK)/);
      expect(source).not.toMatch(/versionedPublicAsset\([^)]*(?:board|loading_board)/i);
    }
  });

  it('prioritizes both orientation backdrops without gating session restore on image decode', () => {
    const overlay = readFileSync(new URL('../Overlay.tsx', import.meta.url), 'utf8');
    const boot = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    // First paint prioritizes the same loading wallpaper React shows next, so
    // the backdrop does not swap artwork when React takes over.
    expect(boot).toContain('brand_loading_bg_portrait.png?v=__PKW_BUILD_SHA__');
    expect(boot).toContain('brand_loading_bg_landscape.png?v=__PKW_BUILD_SHA__');
    const backdrop = readFileSync(new URL('./LoadingBackdrop.tsx', import.meta.url), 'utf8');
    expect(backdrop).toContain("versionedPublicAsset('/brand/brand_loading_bg_portrait.png')");
    expect(backdrop).toContain("versionedPublicAsset('/brand/brand_loading_bg_landscape.png')");
    expect(backdrop).toContain('usePortrait()');
    // The pre-React media queries use React's 1.1 aspect rule (preReactBoot.test
    // checks they agree), not CSS orientation, which flips at 1.0.
    expect(boot).toContain('media="(max-aspect-ratio: 11/10)"');
    expect(boot).toContain('media="(min-aspect-ratio: 1101/1000)"');
    expect(backdrop).toContain('loading="eager"');
    expect(backdrop).toContain('decoding="sync"');
    expect(backdrop).toContain('fetchPriority="high"');
    expect(overlay).toContain('loading="eager"');
    expect(overlay).toContain('decoding="sync"');
    expect(overlay).toContain('fetchPriority="high"');
    expect(overlay).not.toMatch(/await\s+(?:decode|load).*BRAND_BG/i);
  });
});
