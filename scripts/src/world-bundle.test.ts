import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { drift, EXPORT_DIR, INDEX, publishWorldBundle, PUBLISH_DIR, readIndex, WORLD_V2_EXPORT, type WorldPin } from './world-bundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('the tracked world v2 export is native\'s pinned bundle', () => {
  // The web must draw exactly the bytes native 0.6.0 draws (D-176/D-168): one pinned content.json, every file by sha.
  const exportDir = path.join(ROOT, EXPORT_DIR, WORLD_V2_EXPORT.packVersion);

  it('matches native content.json byte for byte, and every file matches content.json', () => {
    const index = readIndex(exportDir);
    expect(drift(exportDir, index)).toEqual([]);
    expect(index.totals).toEqual({ files: 166, bytes: 31_793_761 });
  });

  it('names the same pin as the GLSL lock, so the web never pairs these packs with other shaders', () => {
    const index = readIndex(exportDir);
    expect(index.pin).toBe('02e9da8414156b9e0000df1653de6273b196cca6');
    expect(index.manifest).toEqual({
      path: 'concepts/globe3d-2026-09-23/pack-manifest.json',
      sha256: 'ac241498c956d8da3309ddfa5228b6cb147ad751ee40d9a75b31f4f9069c9007',
      packVersion: 'pm1-cb8faa56909faa31',
    });
  });

  it('is pinned to the same commit as the realm-map and globe GLSL locks the web ships', () => {
    // Why: the pack's baked fields and the realm shaders are one pair (D-168: one shader source, D-176: the web follows
    // native). If either side is re-pinned alone the web draws these bytes with shaders they were not baked for, and no
    // sha check on either side notices. Re-pin both together.
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/src/ui/fantasy/worldv2/realm/glsl.lock.json'), 'utf8')) as { pin: string; native: { packVersion: string; contentManifestSha256: string } };
    expect(lock.pin).toBe(WORLD_V2_EXPORT.pin);
    expect(WORLD_V2_EXPORT.pin.startsWith('02e9da84')).toBe(true);
    expect(lock.native.packVersion).toBe(WORLD_V2_EXPORT.packVersion);
    expect(lock.native.contentManifestSha256).toBe(WORLD_V2_EXPORT.manifestSha256);
    // The flat globe's shader stages (chunk A) are locked to the same native release lock.
    const globe = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/src/ui/fantasy/worldv2/globe/goldens/stages.lock.json'), 'utf8')) as { commit: string };
    expect(globe.commit).toBe(WORLD_V2_EXPORT.pin);
  });

  it('carries the 8 realms and the Phase E islands, and none of the FAR chart16 pages native skips', () => {
    const index = readIndex(exportDir);
    expect(index.realms.map(r => r.id)).toEqual(['cinderfall', 'crownlands', 'elderwood', 'frostveil', 'seeker-reach', 'stormcairn', 'sunscar', 'thornwake']);
    expect(index.phaseEIslands).toBe(true);
    for (const island of ['seeker-island', 'solana-island', 'divine-isle']) {
      expect(index.files.map(f => f.path)).toEqual(expect.arrayContaining([`${island}.webp`, `globe-v2/phase-e/sel-${island}.png`]));
    }
    // D-186: chart16 is skipped for parity and size. Adding it back is a recorded decision, not a drive-by re-export.
    expect(index.files.filter(f => /chart16/.test(f.path))).toEqual([]);
  });
});

describe('pnpm assets:world', () => {
  function fixture(files: Record<string, string> = { 'globe-v2/globe-v2.json': '{"a":1}\n', 'realm/crownlands/fieldsA.png': 'png bytes', 'crownlands.webp': 'webp bytes' }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-world-bundle-'));
    created.push(root);
    const packVersion = 'pm1-test';
    const dir = path.join(root, EXPORT_DIR, packVersion);
    const entries = Object.entries(files).map(([rel, body]) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
      return { path: rel, sha256: sha256(body), bytes: Buffer.byteLength(body) };
    });
    const pinCommit = 'a'.repeat(40), manifestSha256 = 'b'.repeat(64);
    const index = `${JSON.stringify({
      schema: 1, kind: 'pkw-world-debug-content', pin: pinCommit,
      manifest: { path: 'pack-manifest.json', sha256: manifestSha256, packVersion },
      phaseEIslands: true, realms: [], totals: { files: entries.length, bytes: entries.reduce((s, e) => s + e.bytes, 0) }, files: entries,
    }, null, 2)}\n`;
    fs.writeFileSync(path.join(dir, INDEX), index);
    const pin: WorldPin = { packVersion, contentSha256: sha256(index), pin: pinCommit, manifestSha256 };
    const published = path.join(root, PUBLISH_DIR, packVersion);
    return { root, dir, pin, published };
  }

  it('publishes an exact copy with its content.json, and a second run changes nothing', () => {
    const f = fixture();
    expect(publishWorldBundle(f.root, f.pin)).toMatchObject({ files: 3, changed: true });
    expect(fs.readFileSync(path.join(f.published, 'realm/crownlands/fieldsA.png'), 'utf8')).toBe('png bytes');
    expect(fs.readFileSync(path.join(f.published, INDEX)).equals(fs.readFileSync(path.join(f.dir, INDEX)))).toBe(true);
    const before = fs.statSync(path.join(f.published, 'crownlands.webp'));
    expect(publishWorldBundle(f.root, f.pin)).toMatchObject({ changed: false });
    expect(fs.statSync(path.join(f.published, 'crownlands.webp')).ino).toBe(before.ino);
    // no staging directory is left where a web build or git could pick it up
    expect(fs.readdirSync(path.join(f.root, 'apps/web')).filter(n => n.startsWith('.world-v2'))).toEqual([]);
  });

  it.each([
    ['a changed byte of the same size', (dir: string) => fs.writeFileSync(path.join(dir, 'crownlands.webp'), 'webp bytez'), 'sha256 crownlands.webp'],
    ['a truncated file', (dir: string) => fs.writeFileSync(path.join(dir, 'crownlands.webp'), 'webp'), 'size crownlands.webp: 4 != 10'],
    ['a missing file', (dir: string) => fs.rmSync(path.join(dir, 'realm/crownlands/fieldsA.png')), 'missing realm/crownlands/fieldsA.png'],
    ['a file content.json does not list', (dir: string) => fs.writeFileSync(path.join(dir, 'chart16-0.webp'), 'extra'), 'unlisted chart16-0.webp'],
  ])('refuses %s in the export loudly and leaves the published copy alone', (_label, damage, problem) => {
    const f = fixture();
    publishWorldBundle(f.root, f.pin);
    damage(f.dir);
    expect(() => publishWorldBundle(f.root, f.pin)).toThrow(problem);
    expect(fs.readFileSync(path.join(f.published, 'crownlands.webp'), 'utf8')).toBe('webp bytes');
    expect(fs.existsSync(path.join(f.published, 'chart16-0.webp'))).toBe(false);
  });

  it('refuses a content.json that is not the pinned one before trusting any of its entries', () => {
    const f = fixture();
    const index = path.join(f.dir, INDEX);
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('"phaseEIslands": true', '"phaseEIslands": false'));
    expect(() => publishWorldBundle(f.root, f.pin)).toThrow('is not the pinned index');
    expect(fs.existsSync(path.join(f.root, PUBLISH_DIR))).toBe(false);
  });

  it('repairs a tampered published file and retires an older pack version, so dist ships exactly one generation', () => {
    const f = fixture();
    publishWorldBundle(f.root, f.pin);
    fs.writeFileSync(path.join(f.published, 'crownlands.webp'), 'tampered!!');
    fs.mkdirSync(path.join(f.root, PUBLISH_DIR, 'pm0-old'));
    fs.writeFileSync(path.join(f.root, PUBLISH_DIR, 'pm0-old', 'crownlands.webp'), 'old');
    expect(publishWorldBundle(f.root, f.pin)).toMatchObject({ changed: true });
    expect(fs.readdirSync(path.join(f.root, PUBLISH_DIR))).toEqual(['pm1-test']);
    expect(fs.readFileSync(path.join(f.published, 'crownlands.webp'), 'utf8')).toBe('webp bytes');
  });

  it('keeps the 32 MB client-only world pack out of the api image, which copies apps/web/public/atlas', () => {
    const dockerIgnore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
    expect(dockerIgnore).toMatch(/^apps\/web\/public\/atlas\/world-v2$/m);
    expect(fs.readFileSync(path.join(ROOT, 'apps/api/Dockerfile'), 'utf8')).toContain('COPY apps/web/public/atlas ./apps/web/public/atlas');
  });
});
