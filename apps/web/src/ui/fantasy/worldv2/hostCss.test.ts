/**
 * The host world's element-level button rules (world.css, written for the CPU globe's chrome) must never reach World v2.
 *
 * Why: `.fantasy-world button` (specificity 0,1,1) outranks the HUD's own `.hud-x` / `.hud-btn` / `.hud-filter` /
 * `.wv2-grip` rules (0,1,0). Before the round-3 integration it replaced their background shorthand, so every panel's
 * close button lost its icon and showed as an empty bordered square, the sheet grip became a bordered bar, and the
 * HUD buttons took the host's padding, 42 px height and colours instead of the native look (SwiftShader captures,
 * 2026-09-27). The host rules stay for the CPU-globe fallback (G5), guarded by `:where(:not(.wv2-root *))`, which adds
 * no specificity, so the fallback chrome renders exactly as before.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'world.css'), 'utf8');
const GUARD = ':where(:not(.wv2-root *))';

describe('host world.css versus the World v2 HUD', () => {
  it('every .fantasy-world button rule is guarded away from .wv2-root', () => {
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap(m => m[1]!.split(',')).map(s => s.trim())
      .filter(s => /^\.fantasy-world button\b/.test(s));
    // the fallback's plain, disabled, focus and pressed button rules all exist (a rename must not pass silently)
    expect(selectors.length).toBeGreaterThanOrEqual(4);
    expect(selectors.filter(s => !s.startsWith(`.fantasy-world button${GUARD}`))).toEqual([]);
  });
});
