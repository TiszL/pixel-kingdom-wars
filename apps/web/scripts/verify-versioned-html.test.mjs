import { describe, expect, it } from 'vitest';
import { verifyVersionedHtml } from './verify-versioned-html.mjs';

// WHY: first paint must fetch the versioned loading wallpaper (owner
// 2026-09-24 replaced the dark title backdrop on loading surfaces).
function transformedHtml(buildSha) {
  const version = encodeURIComponent(buildSha);
  return `
    <link href="/brand/brand_loading_bg_portrait.png?v=${version}">
    <link href="/brand/brand_loading_bg_landscape.png?v=${version}">
    <source srcset="/brand/brand_loading_bg_portrait.png?v=${version}">
    <img src="/brand/brand_loading_bg_landscape.png?v=${version}">
  `;
}

describe('built loading backdrop identity', () => {
  it('accepts a final transformed document whose preload and srcset share one encoded build', () => {
    expect(() => verifyVersionedHtml(transformedHtml('release/sha 1'), 'release/sha 1')).not.toThrow();
  });

  it('rejects a first paint that still points at the title backdrop', () => {
    const stale = transformedHtml('abc123').replaceAll('brand_loading_bg_', 'brand_title_bg_');
    expect(() => verifyVersionedHtml(stale, 'abc123')).toThrow('found 0');
  });

  it('rejects the partial transform that previously left the portrait srcset unstamped', () => {
    const partial = transformedHtml('abc123').replace(
      '<source srcset="/brand/brand_loading_bg_portrait.png?v=abc123">',
      '<source srcset="/brand/brand_loading_bg_portrait.png?v=__PKW_BUILD_SHA__">',
    );
    expect(() => verifyVersionedHtml(partial, 'abc123')).toThrow(
      'built index.html still contains __PKW_BUILD_SHA__',
    );
  });
});
