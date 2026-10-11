import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORLD_V2_PACK_ROOT, WORLD_V2_PACK_VERSION, worldPackUrl } from './packUrl';

// The tracked export `pnpm assets:world` publishes. If the web asked for another generation, every world fetch would 404.
const content = JSON.parse(readFileSync(new URL(`../../../../../../art/world-v2/${WORLD_V2_PACK_VERSION}/content.json`, import.meta.url), 'utf8')) as {
  manifest: { packVersion: string }; files: Array<{ path: string }>;
};

describe('world v2 pack URLs', () => {
  it('name the generation the tracked export carries', () => {
    expect(content.manifest.packVersion).toBe(WORLD_V2_PACK_VERSION);
    expect(WORLD_V2_PACK_ROOT).toBe(`/atlas/world-v2/${WORLD_V2_PACK_VERSION}/`);
  });

  it('resolve every exported file under the pack root with no build query, which Caddy and the worker would refuse', () => {
    for (const { path } of content.files) {
      const url = worldPackUrl(path);
      expect(url).toBe(`${WORLD_V2_PACK_ROOT}${path}`);
      expect(url).not.toMatch(/[?#]/);
    }
    expect(worldPackUrl('realm/crownlands/fieldsA.png')).toBe('/atlas/world-v2/pm1-cb8faa56909faa31/realm/crownlands/fieldsA.png');
  });

  it.each(['../atlas/meta.json', '/atlas/meta.json', 'realm/../../x.png', 'globe-v2/a256-0.webp?v=1', 'realm/index.js', ''])(
    'refuse %j, which is not a pack file and could escape the pack root',
    (bad) => { expect(() => worldPackUrl(bad)).toThrow('not a world pack path'); },
  );
});
