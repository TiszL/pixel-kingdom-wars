import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSET_PACK_TRANSFER } from '@shardkeep/shared';
import { WORLD_V2_PACK_ROOT } from '../ui/fantasy/worldv2/packUrl';

const script = new URL('../../scripts/emit-asset-pack.mjs', import.meta.url);
const roots = ['assets', 'atlas', 'audio', 'brand', 'icons'];
const fixtureNames: Record<string, string> = {
  assets: 'assets.js', atlas: 'atlas.json', audio: 'audio.mp3', brand: 'brand.png', icons: 'icons.png',
};
const fixtureTypes: Record<string, string> = {
  assets: 'text/javascript; charset=utf-8',
  atlas: 'application/json; charset=utf-8',
  audio: 'audio/mpeg',
  brand: 'image/png',
  icons: 'image/png',
};
const created: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pkw-asset-pack-'));
  created.push(dir);
  for (const root of roots) {
    mkdirSync(join(dir, root));
    writeFileSync(join(dir, root, fixtureNames[root]!), root);
  }
  writeFileSync(join(dir, 'version.json'), '{"gitSha":"build-test"}\n');
  writeFileSync(join(dir, 'private-api-response.json'), 'must never ship');
  return dir;
}

afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('asset-pack build inventory', () => {
  it('marks the Android TWA start URL without changing ordinary web entry URLs', () => {
    const config = JSON.parse(readFileSync(new URL('../../../../mobile/twa.config.json', import.meta.url), 'utf8')) as { startUrl: string };
    expect(config.startUrl).toBe('/?client=solana-mobile');
  });

  it('is exact, sorted, deterministic and excludes every file outside approved static roots', () => {
    const dir = fixture();
    execFileSync(process.execPath, [script.pathname, dir]);
    const raw = readFileSync(join(dir, 'asset-pack.json'), 'utf8');
    const payload = JSON.parse(raw) as {
      schema: number; build: string; totalBytes: number;
      files: Array<{ path: string; bytes: number; sha256: string; contentType: string; tier: 'core' | 'full' }>;
    };
    expect(payload.schema).toBe(2);
    expect(payload.build).toBe('build-test');
    expect(payload.files.map((file) => file.path)).toEqual(roots.map((root) => `/${root}/${fixtureNames[root]}`).sort());
    expect(raw).not.toContain('private-api-response');
    for (const file of payload.files) {
      const body = file.path.split('/').at(-2)!;
      expect(file.sha256).toBe(createHash('sha256').update(body).digest('hex'));
      expect(file.bytes).toBe(Buffer.byteLength(body));
      expect(file.contentType).toBe(fixtureTypes[body]);
      expect(file.tier).toBe(['assets', 'brand', 'icons'].includes(body) ? 'core' : 'full');
    }
    const coreDigests = new Map(payload.files.filter((file) => file.tier === 'core').map((file) => [file.sha256, file.bytes]));
    expect([...coreDigests.values()].reduce((sum, bytes) => sum + bytes, 0))
      .toBeLessThanOrEqual(ASSET_PACK_TRANSFER.coreTierMaxBytes);
    const first = raw;
    execFileSync(process.execPath, [script.pathname, dir]);
    expect(readFileSync(join(dir, 'asset-pack.json'), 'utf8')).toBe(first);
  });

  it('inventories a lossless WebP as a lazy full-tier asset while retaining its PNG', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'atlas', 'floor.webp'), 'lossless transport');
    writeFileSync(join(dir, 'atlas', 'floor.png'), 'canonical source');
    execFileSync(process.execPath, [script.pathname, dir]);
    const payload = JSON.parse(readFileSync(join(dir, 'asset-pack.json'), 'utf8')) as {
      files: Array<{ path: string; contentType: string; tier: string; sha256: string }>;
    };
    expect(payload.files.find(file => file.path.endsWith('.webp'))).toMatchObject({
      path: '/atlas/floor.webp', contentType: 'image/webp', tier: 'full',
      sha256: createHash('sha256').update('lossless transport').digest('hex'),
    });
    expect(payload.files.some(file => file.path === '/atlas/floor.png' && file.contentType === 'image/png')).toBe(true);
  });

  it('pins the self-hosted mobile font MIME so the service worker can replay it offline', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'assets', 'VT323-test.woff2'), 'font bytes');
    execFileSync(process.execPath, [script.pathname, dir]);
    const payload = JSON.parse(readFileSync(join(dir, 'asset-pack.json'), 'utf8')) as {
      files: Array<{ path: string; contentType: string; bytes: number; sha256: string; tier: 'core' | 'full' }>;
    };
    expect(payload.files.find((file) => file.path.endsWith('.woff2'))).toEqual({
      path: '/assets/VT323-test.woff2', contentType: 'font/woff2',
      bytes: Buffer.byteLength('font bytes'), sha256: createHash('sha256').update('font bytes').digest('hex'),
      tier: 'core',
    });
  });

  it('keeps server-only retired NFT image receipts out of mobile downloads', () => {
    const dir = fixture();
    const archive = join(dir, 'atlas', 'retired-deeds');
    mkdirSync(archive);
    writeFileSync(join(archive, 'manifest.sha256'), 'server integrity receipt');
    writeFileSync(join(archive, 'original.png'), 'preserved NFT image');
    execFileSync(process.execPath, [script.pathname, dir]);
    const payload = readFileSync(join(dir, 'asset-pack.json'), 'utf8');
    expect(payload).not.toContain('retired-deeds');
    expect(readFileSync(join(archive, 'original.png'), 'utf8')).toBe('preserved NFT image');
  });

  it('preserves rejected study bytes without admitting them to the installable realm pack', () => {
    const dir = fixture();
    const study = join(dir, 'atlas', 'fantasy', 'ground-v4');
    const accepted = join(dir, 'atlas', 'fantasy', 'layered-ground');
    mkdirSync(study, { recursive: true });
    mkdirSync(accepted, { recursive: true });
    writeFileSync(join(study, 'thornwake.png'), 'rejected study');
    writeFileSync(join(accepted, 'accepted.png'), 'accepted realm');
    execFileSync(process.execPath, [script.pathname, dir]);
    const payload = readFileSync(join(dir, 'asset-pack.json'), 'utf8');
    expect(payload).not.toContain('/ground-v4/');
    expect(payload).toContain('/layered-ground/accepted.png');
    expect(readFileSync(join(study, 'thornwake.png'), 'utf8')).toBe('rejected study');
  });

  it('keeps the on-demand world v2 pack out of the inventory so no TWA background-downloads it', () => {
    const dir = fixture();
    // The exact root the world renderer fetches from, so a moved root cannot slip past the skip.
    const world = join(dir, WORLD_V2_PACK_ROOT.slice(1));
    mkdirSync(join(world, 'globe-v2'), { recursive: true });
    writeFileSync(join(world, 'globe-v2', 'a1024-0.webp'), 'globe face');
    writeFileSync(join(world, 'content.json'), '{}');
    execFileSync(process.execPath, [script.pathname, dir]);
    const payload = readFileSync(join(dir, 'asset-pack.json'), 'utf8');
    expect(payload).not.toContain('/atlas/world-v2/');
    expect(payload).toContain('/atlas/atlas.json');
    expect(readFileSync(join(world, 'globe-v2', 'a1024-0.webp'), 'utf8')).toBe('globe face');
  });

  it('puts the build shell and low-density base atlases before high-density/full media', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'atlas', 'meta.json'), '{}');
    writeFileSync(join(dir, 'atlas', 'bld@1x.png'), 'base 1x');
    writeFileSync(join(dir, 'atlas', 'bld@2x.png'), 'base 2x');
    writeFileSync(join(dir, 'audio', 'bgmusic-world.mp3'), 'world music');
    execFileSync(process.execPath, [script.pathname, dir]);
    const payload = JSON.parse(readFileSync(join(dir, 'asset-pack.json'), 'utf8')) as {
      files: Array<{ path: string; tier: 'core' | 'full' }>;
    };
    const tiers = new Map(payload.files.map((file) => [file.path, file.tier]));
    expect(tiers.get('/assets/assets.js')).toBe('core');
    expect(tiers.get('/atlas/meta.json')).toBe('core');
    expect(tiers.get('/atlas/bld@1x.png')).toBe('core');
    expect(tiers.get('/audio/bgmusic-world.mp3')).toBe('core');
    expect(tiers.get('/atlas/bld@2x.png')).toBe('full');
    expect(tiers.get('/audio/audio.mp3')).toBe('full');
  });

  it('serves every verified static pack root as build-bound immutable content', () => {
    const caddy = readFileSync(new URL('../../../../infra/Caddyfile.vps', import.meta.url), 'utf8');
    // Old URLs now select immutable release bytes instead of merely using a
    // cache-busting query against whichever build occupies the current root.
    const matcher = caddy.slice(caddy.indexOf('@versionedStatic {'), caddy.indexOf('handle @versionedStatic'));
    for (const root of roots) expect(matcher).toContain(`/${root}/*`);
    expect(matcher).toContain("{query.v}.matches('^[0-9a-f]{40}$')");
    const handler = caddy.slice(caddy.indexOf('handle @versionedStatic'), caddy.indexOf('@invalidStaticVersion'));
    expect(handler).toContain('root * /srv/www/_releases/{query.v}');
    expect(handler).toContain('@existing file {path}');
    expect(handler).toContain('header @existing Cache-Control "public, max-age=31536000, immutable"');
    expect(handler).toContain('file_server');
    expect(handler).not.toContain('try_files');
  });

  it.each(['Caddyfile.vps', 'Caddyfile.single-origin'])('keeps missing brand art out of the SPA fallback in %s', (file) => {
    const caddy = readFileSync(new URL(`../../../../infra/${file}`, import.meta.url), 'utf8');
    const selectors = file === 'Caddyfile.vps'
      ? ['handle @versionedStatic', 'handle @static'] : ['handle /brand/*'];
    if (file === 'Caddyfile.vps') {
      expect(caddy).toMatch(/@static path[^\n]*\/brand\/\*/);
      const versionMatcher = caddy.slice(caddy.indexOf('@versionedStatic {'), caddy.indexOf('handle @versionedStatic'));
      expect(versionMatcher).toContain('/brand/*');
    }
    for (const selector of selectors) {
      const start = caddy.indexOf(selector);
      const end = caddy.indexOf('\n\t}', start);
      const handler = caddy.slice(start, end);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(handler).toContain('@missing not file {path}');
      expect(handler).toContain('header @missing Cache-Control no-store');
      expect(handler).toContain('file_server');
      expect(handler).not.toContain('try_files');
    }
    expect(caddy.slice(caddy.indexOf('# Everything else'))).toContain('try_files {path} /index.html');
  });

  it('fails the release if a deprecated brand frame reaches dist', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'brand', 'brand_emblem_pulse_f1.png'), 'old logo');
    expect(() => execFileSync(process.execPath, [script.pathname, dir], { stdio: 'pipe' })).toThrow();
    expect(() => readFileSync(join(dir, 'asset-pack.json'))).toThrow();
  });

  it('also rejects the deprecated high-density pulse frame', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'brand', 'brand_emblem_pulse_f1@2x.png'), 'old logo at 2x');
    expect(() => execFileSync(process.execPath, [script.pathname, dir], { stdio: 'pipe' })).toThrow();
  });

  it('fails if the old eager brand glob leaks a hashed master into Vite assets', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'assets', 'brand_app_icon-deadbeef.svg'), 'old app icon');
    expect(() => execFileSync(process.execPath, [script.pathname, dir], { stdio: 'pipe' })).toThrow();
  });

  it('fails if a retired runtime key survives inside a packaged text index', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'atlas', 'atlas.json'), '{"keys":["brand_emblem_pulse_f1"]}');
    expect(() => execFileSync(process.execPath, [script.pathname, dir], { stdio: 'pipe' })).toThrow();
  });

  it.each(['fonts.googleapis.com', 'fonts.gstatic.com'])(
    'fails if the MWA bundle retains the external font origin %s',
    (origin) => {
      const dir = fixture();
      writeFileSync(join(dir, 'assets', 'mwa.js'), `const font = "https://${origin}/external-font";`);
      expect(() => execFileSync(process.execPath, [script.pathname, dir], { stdio: 'pipe' })).toThrow();
      expect(() => readFileSync(join(dir, 'asset-pack.json'))).toThrow();
    },
  );
});
