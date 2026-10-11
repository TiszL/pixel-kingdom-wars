import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = path.join(ROOT, 'infra/retain-web-assets.mjs');
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(): { dir: string; old: string; next: string; live: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-retention-')); scratch.push(dir);
  return { dir, old: path.join(dir, 'old'), next: path.join(dir, 'next'), live: path.join(dir, 'live') };
}
function build(root: string, sha: string, wall = 'old stone', builtAt = '2026-09-09T10:00:00Z'): void {
  const files = [
    { path: '/atlas/wall@1x.png', body: wall },
    { path: `/assets/chunk-${sha[0]}.js`, body: `const build = '${sha}';` },
  ];
  fs.mkdirSync(root, { recursive: true });
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    fs.writeFileSync(path.join(root, file.path), file.body);
  }
  fs.writeFileSync(path.join(root, 'asset-pack.json'), JSON.stringify({ schema: 2, build: sha,
    files: files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.body), sha256: hash(file.body) })) }));
  fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ gitSha: sha, builtAt }));
  for (const file of ['index.html', 'sw.js', 'manifest.webmanifest']) fs.writeFileSync(path.join(root, file), `${file}:${sha}`);
}
function retain(f: ReturnType<typeof fixture>): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [HELPER, f.old, f.next, f.live], { encoding: 'utf8' });
}
const A = 'a'.repeat(40), B = 'b'.repeat(40);

describe('immutable static generations for already-open clients', () => {
  it('preserves different old/new wall bytes, core metadata and unversioned lazy chunks', () => {
    const f = fixture(); build(f.old, A); build(f.next, B, 'new timber');
    // Private/unlisted source files must not become public via a snapshot.
    fs.writeFileSync(path.join(f.old, '.env'), 'not public');
    expect(retain(f).status).toBe(0);
    for (const [sha, wall] of [[A, 'old stone'], [B, 'new timber']]) {
      const dir = path.join(f.live, '_releases', sha!);
      expect(fs.readFileSync(path.join(dir, 'atlas/wall@1x.png'), 'utf8')).toBe(wall);
      const receipt = fs.readFileSync(path.join(dir, 'retention.json'));
      expect(fs.readFileSync(path.join(dir, 'retention.sha256'), 'utf8').trim()).toBe(hash(receipt));
      expect(JSON.parse(receipt.toString()).files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining(['index.html', 'sw.js', 'asset-pack.json', 'version.json']));
      expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(f.live, '_assets/assets', `chunk-${sha![0]}.js`))).toBe(true);
    }
    expect(retain(f).status).toBe(0); // Identical rerun verifies, never rewrites.
  });

  it('rejects mismatched identities and corrupt current assets before any publication', () => {
    const f = fixture(); build(f.old, A); build(f.next, B);
    fs.writeFileSync(path.join(f.next, 'version.json'), JSON.stringify({ gitSha: A }));
    expect(retain(f).status).not.toBe(0); expect(fs.existsSync(f.live)).toBe(false);
    build(f.next, B); fs.writeFileSync(path.join(f.next, 'atlas/wall@1x.png'), 'corrupted');
    expect(retain(f).status).not.toBe(0); expect(fs.existsSync(f.live)).toBe(false);
  });

  it('refuses to overwrite an existing SHA or accept corrupted retained bytes', () => {
    const f = fixture(); build(f.old, A); build(f.next, B); expect(retain(f).status).toBe(0);
    build(f.next, B, 'different same SHA'); expect(retain(f).status).not.toBe(0);
    const target = path.join(f.live, '_releases', B, 'atlas/wall@1x.png');
    expect(fs.readFileSync(target, 'utf8')).toBe('old stone');
    build(f.next, B); fs.chmodSync(target, 0o644); fs.writeFileSync(target, 'damage');
    expect(retain(f).status).not.toBe(0);
  });

  it('rejects duplicate generation identities and reused chunk paths before writing', () => {
    const f = fixture(); build(f.old, A); build(f.next, A, 'different');
    expect(retain(f).status).not.toBe(0); expect(fs.existsSync(f.live)).toBe(false);
    build(f.next, B);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.next, 'asset-pack.json'), 'utf8'));
    manifest.files[1].path = '/assets/chunk-a.js';
    fs.renameSync(path.join(f.next, 'assets/chunk-b.js'), path.join(f.next, 'assets/chunk-a.js'));
    fs.writeFileSync(path.join(f.next, 'asset-pack.json'), JSON.stringify(manifest));
    expect(retain(f).status).not.toBe(0); expect(fs.existsSync(f.live)).toBe(false);
  });

  it('rejects manifest traversal, source symlinks and incomplete previous builds', () => {
    const f = fixture(); build(f.old, A); build(f.next, B);
    const manifestPath = path.join(f.next, 'asset-pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files[0].path = '/atlas/../version.json'; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(retain(f).status).not.toBe(0);
    build(f.next, B); fs.rmSync(path.join(f.next, 'atlas/wall@1x.png'));
    fs.symlinkSync(path.join(f.old, 'atlas/wall@1x.png'), path.join(f.next, 'atlas/wall@1x.png'));
    expect(retain(f).status).not.toBe(0);
    fs.rmSync(f.next, { recursive: true }); build(f.next, B); fs.rmSync(path.join(f.old, 'version.json'));
    expect(retain(f).status).not.toBe(0); expect(fs.existsSync(f.live)).toBe(false);
  });

  it('supports first deploy and stays Caddy-readable under restrictive deployment umask', () => {
    const f = fixture(); build(f.next, B);
    const script = `process.umask(0o077); const {retainWebAssets}=await import(${JSON.stringify(HELPER)}); retainWebAssets(...process.argv.slice(1));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.old, f.next, f.live]);
    expect(result.status).toBe(0);
    const root = path.join(f.live, '_releases', B);
    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, 'atlas')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, 'atlas/wall@1x.png')).mode & 0o777).toBe(0o444);
  });

  it('reuses the verified build timestamp after a later deployment gate fails', () => {
    const f = fixture(); build(f.old, A); build(f.next, B); expect(retain(f).status).toBe(0);
    const original = fs.readFileSync(path.join(f.live, '_releases', B, 'retention.json'));
    const retryTime = spawnSync(process.execPath, [HELPER, '--build-time', f.live, B, '2026-09-10T10:00:00Z'], { encoding: 'utf8' });
    expect(retryTime.status).toBe(0); expect(retryTime.stdout.trim()).toBe('2026-09-09T10:00:00Z');
    build(f.next, B, 'old stone', retryTime.stdout.trim());
    expect(retain(f).status).toBe(0);
    expect(fs.readFileSync(path.join(f.live, '_releases', B, 'retention.json'))).toEqual(original);
    // Reusing the timestamp never authorizes new config/art under the old SHA.
    build(f.next, B, 'changed art', retryTime.stdout.trim()); expect(retain(f).status).not.toBe(0);
    const deploy = fs.readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');
    const timestamp = deploy.indexOf('--build-time "$WEB_ROOT" "$SHA"');
    const buildStart = deploy.indexOf('say "building assets + web dist');
    expect(timestamp).toBeGreaterThanOrEqual(0); expect(buildStart).toBeGreaterThanOrEqual(0);
    expect(timestamp).toBeLessThan(buildStart);
  });

  it('refuses a timestamp from corrupted retained receipts or retained bytes', () => {
    const f = fixture(); build(f.old, A); build(f.next, B); expect(retain(f).status).toBe(0);
    const command = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath,
      [HELPER, '--build-time', f.live, B, '2026-09-10T10:00:00Z'], { encoding: 'utf8' });
    const receiptPath = path.join(f.live, '_releases', B, 'retention.sha256');
    const original = fs.readFileSync(receiptPath);
    fs.chmodSync(receiptPath, 0o644); fs.writeFileSync(receiptPath, '0'.repeat(64));
    expect(command().status).not.toBe(0);
    fs.writeFileSync(receiptPath, original);
    const art = path.join(f.live, '_releases', B, 'atlas/wall@1x.png');
    fs.chmodSync(art, 0o644); fs.writeFileSync(art, 'corrupt');
    expect(command().status).not.toBe(0);
  });

  it('bootstraps the timestamp from a verified same-SHA current deployment', () => {
    const f = fixture(); build(f.live, B);
    const result = spawnSync(process.execPath, [HELPER, '--build-time', f.live, B, '2026-09-10T10:00:00Z'], { encoding: 'utf8' });
    expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('2026-09-09T10:00:00Z');
    expect(fs.existsSync(path.join(f.live, '_releases'))).toBe(false); // Read-only preflight.
  });

  it('never publishes a partial union chunk and recovers cleanly after ENOSPC', () => {
    const f = fixture(); build(f.old, A); build(f.next, A); expect(retain(f).status).toBe(0);
    const published = path.join(f.live, '_assets/assets/chunk-a.js');
    const original = fs.readFileSync(published);
    build(f.next, B);
    const script = `
      import fs from 'node:fs';
      const {retainWebAssets}=await import(${JSON.stringify(HELPER)});
      const write=fs.writeFileSync;
      fs.writeFileSync=(filename,data,options)=>{
        if(String(filename).includes('/_releases/.lock/') && String(filename).endsWith('chunk-b.js')) {
          write(filename,Buffer.from(data).subarray(0,4),options);
          throw Object.assign(new Error('injected ENOSPC'),{code:'ENOSPC'});
        }
        return write(filename,data,options);
      };
      retainWebAssets(...process.argv.slice(1));`;
    const failure = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.old, f.next, f.live], { encoding: 'utf8' });
    expect(failure.status).not.toBe(0); expect(failure.stderr).toContain('injected ENOSPC');
    expect(fs.existsSync(path.join(f.live, '_assets/assets/chunk-b.js'))).toBe(false);
    expect(fs.existsSync(path.join(f.live, '_releases/.lock'))).toBe(false);
    expect(fs.readFileSync(published)).toEqual(original);
    expect(retain(f).status).toBe(0);
    expect(fs.readFileSync(path.join(f.live, '_assets/assets/chunk-b.js'))).toEqual(fs.readFileSync(path.join(f.next, 'assets/chunk-b.js')));
    expect(fs.readFileSync(published)).toEqual(original);
  });

  it('retains before draining and excludes only private retention roots from live replacement', () => {
    const deploy = fs.readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');
    const retention = deploy.indexOf('node infra/retain-web-assets.mjs');
    const maintenance = deploy.indexOf('say "entering maintenance');
    expect(retention).toBeGreaterThanOrEqual(0); expect(maintenance).toBeGreaterThanOrEqual(0);
    expect(retention).toBeLessThan(maintenance);
    expect(deploy).toContain(`rsync -a --delete --exclude '/_releases/' --exclude '/_assets/' apps/web/dist/ "$WEB_ROOT/"`);
    const caddy = fs.readFileSync(path.join(ROOT, 'infra/Caddyfile.vps'), 'utf8');
    expect(caddy).toContain("{query.v}.matches('^[0-9a-f]{40}$')");
    expect(caddy).toContain('root * /srv/www/_releases/{query.v}');
    expect(caddy).toContain('@retentionInternal path /_releases/* /_assets/*');
    const iconVersion = caddy.slice(caddy.indexOf('@invalidIconVersion {'), caddy.indexOf('# Vite chunks'));
    expect(iconVersion).toContain('path /icons/*');
    expect(iconVersion).toContain("{query.v} != '' && {query.v} != 'c0137365' && !{query.v}.matches('^[0-9a-f]{40}$')");
    expect(iconVersion).toContain('header Cache-Control no-store');
    expect(iconVersion).toContain('respond 404');
    const versionRoute = caddy.slice(caddy.indexOf('handle @versionedStatic'), caddy.indexOf('@invalidStaticVersion'));
    expect(versionRoute).not.toContain('try_files');
    expect(versionRoute).toContain('header @missing Cache-Control no-store');
  });
});
