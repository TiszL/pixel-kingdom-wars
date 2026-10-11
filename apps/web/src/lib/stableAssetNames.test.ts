import { createHash } from 'node:crypto';
import { build, type Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { stableAssetFileNames } from '../../scripts/stable-asset-names';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path d="M0 0h8v8H0z"/></svg>';

/** Exercise the bundler's real deduplication and referring JS, with the same
 * imports but opposite asynchronous emission order. Callback-only tests miss
 * the singleton-name race that broke an immutable production generation. */
async function bundle(first: string, second: string, reverse: boolean, secondSource = SVG) {
  const references = new Map<string, string>();
  let releaseFast!: () => void;
  const fastEmitted = new Promise<void>((resolve) => { releaseFast = resolve; });
  const plugin: Plugin = {
    name: 'duplicate-svg-arrival-fixture',
    async buildStart() {
      await Promise.all([first, second].map(async (name, index) => {
        if (index === (reverse ? 0 : 1)) await fastEmitted;
        references.set(name, this.emitFile({
          type: 'asset', name, originalFileName: `fixture/${name}`,
          source: index === 0 ? SVG : secondSource,
        }));
        if (index === (reverse ? 1 : 0)) releaseFast();
      }));
      this.emitFile({ type: 'asset', name: 'portrait.png', source: new Uint8Array([137, 80, 78, 71]) });
    },
    resolveId(id) { if (id === 'virtual:entry') return '\0entry'; },
    load(id) {
      if (id === '\0entry') {
        return `console.log(import.meta.ROLLUP_FILE_URL_${references.get(first)}, import.meta.ROLLUP_FILE_URL_${references.get(second)});`;
      }
    },
  };
  const result = await build({
    configFile: false, envFile: false, publicDir: false, logLevel: 'silent', plugins: [plugin],
    build: {
      write: false, minify: false,
      rolldownOptions: {
        input: 'virtual:entry', output: { assetFileNames: stableAssetFileNames },
      },
    },
  });
  if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one emitted bundle');
  return result.output.map((file) => {
    const source = file.type === 'chunk' ? file.code : file.source;
    return {
      name: file.fileName,
      bytes: typeof source === 'string' ? Buffer.from(source) : Buffer.from(source),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

describe('stable emitted SVG identity', () => {
  it('preserves complete emitted filenames, bytes and referring JS when duplicate SVG arrival reverses', async () => {
    const forward = await bundle('walk_f1.svg', 'walk_f3.svg', false);
    const reverse = await bundle('walk_f1.svg', 'walk_f3.svg', true);
    expect(reverse).toEqual(forward);
    expect(forward.filter((file) => file.name.endsWith('.svg'))).toHaveLength(1);
    expect(forward.find((file) => file.name.endsWith('.svg'))?.name).toMatch(/^assets\/svg-[\w-]+\.svg$/);
    expect(forward.find((file) => file.name.endsWith('.png'))?.name).toMatch(/^assets\/portrait-[\w-]+\.png$/);
    expect(forward.some((file) => file.name.endsWith('.js'))).toBe(true);
  });

  it('gives distinct SVG bytes distinct identities while conserving source bytes', async () => {
    const different = SVG.replace('width="8"', 'width="9"');
    const files = (await bundle('walk_f1.svg', 'walk_f3.svg', false, different))
      .filter((file) => file.name.endsWith('.svg'));
    expect(files).toHaveLength(2);
    expect(new Set(files.map((file) => file.name)).size).toBe(2);
    const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
    expect(files.map((file) => digest(file.bytes)).sort()).toEqual([digest(SVG), digest(different)].sort());
  });

  it.each(['brand_emblem.svg', 'brand_banner.svg', 'trp_wyrmling_idle.svg', 'fx_breath_wyrm.svg'])(
    'rejects %s even when its bytes duplicate an allowed asset in either arrival order', async (retired) => {
      await expect(bundle('walk_f1.svg', retired, false)).rejects.toThrow(/retired runtime asset/);
      await expect(bundle('walk_f1.svg', retired, true)).rejects.toThrow(/retired runtime asset/);
    },
  );

  it('retains the approved KEEP token and wordmark exceptions', async () => {
    const forward = await bundle('brand_token_logo.svg', 'brand_logo_wordmark.svg', false);
    expect(await bundle('brand_token_logo.svg', 'brand_logo_wordmark.svg', true)).toEqual(forward);
  });

  it.each(['legacy/FX_BREATH_WYRM.svg', 'legacy\\brand_app_icon.svg'])(
    'rejects a retired original filename even when the emitted name is benign: %s', (original) => {
      expect(() => stableAssetFileNames({ names: ['safe.svg'], originalFileNames: [original] }))
        .toThrow(/retired runtime asset/);
    },
  );

  it.each(['style.css', 'offline-font.woff2'])(
    'preserves the existing non-SVG naming contract for %s', (name) => {
      expect(stableAssetFileNames({ names: [name], originalFileNames: [] }))
        .toBe('assets/[name]-[hash][extname]');
    },
  );
});
