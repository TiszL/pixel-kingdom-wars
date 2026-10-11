import type { Plugin } from 'vite';

const MWA_BROWSER_MODULE = '/@solana-mobile/wallet-standard-mobile/lib/esm/index.browser.js';
const EXTERNAL_GOOGLE_FONT_URLS = ['fonts.googleapis.com', 'fonts.gstatic.com'] as const;
const GOOGLE_FONT_LINK = /^[ \t]*<link\b[^>\n]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\r?\n?/gm;

/**
 * wallet-standard-mobile 0.5.3 injects three Google Fonts links into the closed
 * shadow root used by its optional fallback modal. PKW supplies its own
 * onWalletNotFound handler, but the links still survive tree-shaking and would
 * make an installed Solana Mobile build reach the network after its asset pack
 * was verified. Remove only those links while keeping every MWA code path intact.
 *
 * The exact count is deliberate: an upstream markup change must fail the build
 * for review instead of silently reintroducing an external runtime dependency.
 */
export function stripMwaExternalFonts(code: string, id: string): string | null {
  const moduleId = id.split('?', 1)[0]!.replaceAll('\\', '/');
  if (!moduleId.endsWith(MWA_BROWSER_MODULE)) return null;

  const matches = code.match(GOOGLE_FONT_LINK) ?? [];
  if (matches.length !== 3) {
    throw new Error(`expected 3 MWA Google Font links, found ${matches.length}`);
  }

  const offlineCode = code.replace(GOOGLE_FONT_LINK, '');
  for (const origin of EXTERNAL_GOOGLE_FONT_URLS) {
    if (offlineCode.includes(origin)) {
      throw new Error(`MWA browser bundle still references external font origin: ${origin}`);
    }
  }
  return offlineCode;
}

export function offlineMwaFonts(): Plugin {
  let transformed = false;
  return {
    name: 'pkw-offline-mwa-fonts',
    enforce: 'pre',
    transform(code, id) {
      const offlineCode = stripMwaExternalFonts(code, id);
      if (offlineCode === null) return null;
      transformed = true;
      return { code: offlineCode, map: null };
    },
    buildEnd(error) {
      if (!error && !transformed) {
        this.error('MWA browser module was not transformed; offline font contract cannot be verified');
      }
    },
  };
}
