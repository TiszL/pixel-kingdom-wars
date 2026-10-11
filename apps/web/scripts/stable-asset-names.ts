import type { Rolldown } from 'vite';

/** Check source identities before SVG filenames stop carrying their basenames.
 * Keep the post-build checks in size-check.mjs and emit-asset-pack.mjs too. */
export function stableAssetFileNames(asset: Pick<Rolldown.PreRenderedAsset, 'names' | 'originalFileNames'>): string {
  const names = [...asset.names, ...asset.originalFileNames];
  for (const name of names) {
    const basename = name.replaceAll('\\', '/').split('/').at(-1) ?? '';
    const stem = basename.replace(/\.[^.]+$/, '');
    if (/(?:trp_wyrmling|fx_breath_wyrm)/i.test(basename)
      || (stem.startsWith('brand_') && stem !== 'brand_token_logo' && stem !== 'brand_logo_wordmark')) {
      throw new Error(`retired runtime asset cannot be emitted: ${basename}`);
    }
  }
  // Vite/Rolldown names duplicate content after whichever source finishes first.
  // It supplies singleton names here, so sorting aliases cannot stabilize that
  // choice. Native content hashes also keep referring JS chunks byte-stable.
  return names.some((name) => name.endsWith('.svg'))
    ? 'assets/svg-[hash][extname]'
    : 'assets/[name]-[hash][extname]';
}
