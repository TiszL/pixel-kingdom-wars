/**
 * The API image bakes apps/web/public/atlas and reads the pinned layered-ground
 * manifests from it at runtime (kitObstacles.ts). On 2026-09-25 the QA
 * candidate, built from atlases generated before the revision-5 pin, returned
 * 500 on every revision-5 base. deploy.sh must therefore verify every pinned
 * manifest right after `pnpm assets` and before `docker build`, and the
 * verifier must fail on a missing, truncated or altered manifest — and on a
 * missing or altered asset that manifest lists, because the renderer opens and
 * hash-checks every one of them too (baseRender.ts) and 500s the same way.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PINNED_GROUND_CATALOGUES, resolvePublicRoot, verifyPublishedGround } from './verify-published-ground.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => fs.rm(r, { recursive: true, force: true }))); });

async function publicRootWith(files: Record<string, Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'published-ground-')); roots.push(root);
  for (const [rel, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), bytes);
  }
  return root;
}
const assetBytes = Buffer.from('fixture ground artwork');
const assetSha256 = createHash('sha256').update(assetBytes).digest('hex');
const assetPath = `atlas/fantasy/layered-ground/assets/${assetSha256}.png`;
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, realmId: 'thornwake', status: 'accepted',
  assets: [{ id: 'ground', path: assetPath, sha256: assetSha256, size: assetBytes.length }] }));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifestPath = `atlas/fantasy/layered-ground/${sha256}/manifest.json`;
const catalogues = { revision5: { thornwake: { realmId: 'thornwake' as const, manifestPath, sha256, size: bytes.length } } };

describe('verifyPublishedGround', () => {
  it('passes when every pinned manifest is published byte-exactly', async () => {
    const report = await verifyPublishedGround(await publicRootWith({ [manifestPath]: bytes, [assetPath]: assetBytes }), catalogues);
    expect(report).toEqual({ checked: 1, perCatalogue: { revision5: 1 }, problems: [] });
  });
  it('names a missing asset of a byte-exact manifest: the renderer would 500 on it just the same', async () => {
    const report = await verifyPublishedGround(await publicRootWith({ [manifestPath]: bytes }), catalogues);
    expect(report.problems).toEqual([`revision5 thornwake: missing asset ${assetPath} (${manifestPath})`]);
  });
  it('rejects an altered asset even at its pinned size, and a truncated one', async () => {
    const altered = Buffer.from(assetBytes); altered[0] = altered[0]! ^ 0xff;
    expect((await verifyPublishedGround(await publicRootWith({ [manifestPath]: bytes, [assetPath]: altered }), catalogues)).problems)
      .toEqual([expect.stringMatching(new RegExp(`^revision5 thornwake: asset sha256 .* != pinned .*\\(${assetPath}\\)$`))]);
    expect((await verifyPublishedGround(await publicRootWith({ [manifestPath]: bytes, [assetPath]: assetBytes.subarray(1) }), catalogues)).problems)
      .toEqual([`revision5 thornwake: asset size ${assetBytes.length - 1} != pinned ${assetBytes.length} (${assetPath})`]);
  });
  it('names a missing manifest instead of trusting the pin', async () => {
    const report = await verifyPublishedGround(await publicRootWith({}), catalogues);
    expect(report.problems).toEqual([`revision5 thornwake: missing ${manifestPath}`]);
  });
  it('rejects altered bytes even at the pinned size, and a truncated file', async () => {
    const altered = Buffer.from(bytes); altered[0] = altered[0] === 0x7b ? 0x5b : 0x7b;
    expect((await verifyPublishedGround(await publicRootWith({ [manifestPath]: altered }), catalogues)).problems[0]).toMatch(/sha256 .* != pinned/);
    expect((await verifyPublishedGround(await publicRootWith({ [manifestPath]: bytes.subarray(1) }), catalogues)).problems[0]).toMatch(/size \d+ != pinned/);
  });
  it('checks every pinned revision the shared catalogue exports, so a revision-5 pin cannot be skipped', () => {
    expect(Object.keys(PINNED_GROUND_CATALOGUES)).toEqual(['revision3', 'revision4', 'revision5']);
  });
  it('resolves the public root against the repo by default and against INIT_CWD for a relative argument (pnpm runs in scripts/)', () => {
    expect(resolvePublicRoot(undefined, '/elsewhere', '/elsewhere/scripts')).toBe(path.join(ROOT, 'apps', 'web', 'public'));
    expect(resolvePublicRoot('apps/web/public', ROOT, path.join(ROOT, 'scripts'))).toBe(path.join(ROOT, 'apps', 'web', 'public'));
    expect(resolvePublicRoot('/abs/public', ROOT, path.join(ROOT, 'scripts'))).toBe('/abs/public');
  });
});

describe('infra/deploy.sh', () => {
  it('verifies the published manifests after pnpm assets and before the api image build, dying on failure', async () => {
    const deploy = await fs.readFile(path.join(ROOT, 'infra/deploy.sh'), 'utf8');
    const assets = deploy.indexOf('\npnpm assets\n');
    const verify = deploy.indexOf('pnpm --filter @shardkeep/scripts run --silent verify:published-ground \\\n');
    const build = deploy.indexOf('docker build \\\n  -f apps/api/Dockerfile');
    expect(assets).toBeGreaterThan(-1); expect(verify).toBeGreaterThan(assets); expect(build).toBeGreaterThan(verify);
    expect(deploy.slice(verify, verify + 400)).toMatch(/\|\| die "pinned layered-ground manifests are missing or altered/);
    const scripts = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts/package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(scripts.scripts['verify:published-ground']).toBe('tsx src/verify-published-ground.ts');
  });
});
