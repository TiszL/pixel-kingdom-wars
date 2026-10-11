import { describe, expect, it } from 'vitest';
import { stripMwaExternalFonts } from '../../scripts/offline-mwa-fonts';

const moduleId = '/repo/node_modules/@solana-mobile/wallet-standard-mobile/lib/esm/index.browser.js';
const upstreamMarkup = `
const fonts = \`
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight&display=swap" rel="stylesheet">
\`;
const registerMwa = () => 'wallet behavior remains';
`;

describe('offline MWA dependency transform', () => {
  it('removes only the three external font links and preserves wallet code', () => {
    const transformed = stripMwaExternalFonts(upstreamMarkup, moduleId);
    expect(transformed).not.toContain('fonts.googleapis.com');
    expect(transformed).not.toContain('fonts.gstatic.com');
    expect(transformed).toContain("const registerMwa = () => 'wallet behavior remains'");
  });

  it('does not rewrite unrelated modules', () => {
    expect(stripMwaExternalFonts(upstreamMarkup, '/repo/src/mwa.ts')).toBeNull();
  });

  it('fails loudly if upstream changes the embedded font markup', () => {
    expect(() => stripMwaExternalFonts(upstreamMarkup.replace('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n', ''), moduleId))
      .toThrow('expected 3 MWA Google Font links');
  });
});
