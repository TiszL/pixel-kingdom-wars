import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_LAYERED_REVISION_BY_REALM, currentBaseVisualForRealm, type BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { BASE_LAYERED_GROUND_V3, layeredGroundDescriptor } from '@shardkeep/shared/layeredGroundCatalogue';
import { assertLayeredGroundManifest } from '@shardkeep/shared/layeredGround';
import { renderBaseGroundPng } from '../src/game/baseRender';

const sourceRoot = path.resolve(process.cwd(), '../..');
const originalRoot = process.env['REPO_ROOT'];
const temporary: string[] = [];
afterEach(async () => {
  if (originalRoot === undefined) delete process.env['REPO_ROOT']; else process.env['REPO_ROOT'] = originalRoot;
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const context = (realmId: BaseVisualContext['realmId']): BaseVisualContext => ({
  version: 1, artVersion: 2, groundRevision: 3, realmId,
});
async function published(realm: BaseVisualContext) {
  const descriptor = layeredGroundDescriptor(realm);
  const publicRoot = path.join(sourceRoot, 'apps/web/public');
  const bytes = await readFile(path.join(publicRoot, descriptor.manifestPath));
  const manifest: unknown = JSON.parse(bytes.toString('utf8'));
  assertLayeredGroundManifest(manifest);
  return { descriptor, publicRoot, manifest };
}

describe('accepted layered ground in actual server PNGs', () => {
  it('rejects a public request burst without queuing extra decode or PNG jobs, then permits retry', async () => {
    process.env['REPO_ROOT'] = sourceRoot;
    const jobs = ['frostveil', 'elderwood', 'sunscar', 'frostveil', 'thornwake', 'cinderfall'] as const;
    const results = await Promise.allSettled(jobs.map(realm => renderBaseGroundPng(context(realm), 32, 0)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    for (const result of results.slice(2)) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ statusCode: 503, code: 'DEED_RENDER_BUSY' });
    }
    // Overflow did not poison the realm cache or retain a permit. Retrying all
    // requested realms serially works after the first image jobs finish.
    for (const realm of jobs) expect((await sharp(await renderBaseGroundPng(context(realm), 1, 0)).metadata()).width).toBe(1);
  });

  it('keeps the published revision-4 painting of all eight realms renderable at frozen world coordinates while every current context is the revision-5 kit', async () => {
    process.env['REPO_ROOT'] = sourceRoot;
    expect(Object.keys(BASE_LAYERED_GROUND_V3)).toHaveLength(8);
    for (const descriptor of Object.values(BASE_LAYERED_GROUND_V3)) {
      // Since the owner flip (D-184) every realm's current context is the revision-5 kit,
      // which the realm-kit renderer draws (realm-kit-render.test.ts). Revision 4 stays
      // published for every realm: old native renderers are served it (E-12) and frozen
      // contexts keep it, so its crops must stay at the same world coordinates.
      expect(currentBaseVisualForRealm(descriptor.realmId)).toEqual({ ...context(descriptor.realmId), groundRevision: 5 });
      expect(CURRENT_LAYERED_REVISION_BY_REALM[descriptor.realmId]).toBe(5);
      const realm: BaseVisualContext = { ...context(descriptor.realmId), groundRevision: 4 };
      const { manifest, publicRoot } = await published(realm);
      const asset = manifest.assets.find(a => a.id === manifest.ground.asset)!;
      const source = await sharp(await readFile(path.join(publicRoot, asset.path))).ensureAlpha().raw().toBuffer();
      const clean = manifest.protectedFrame;
      // The centre painting is addressed by its own rectangle: the field for r3,
      // the explicit centerRect for r4 (which contains the field).
      const paint = manifest.groundRevision === 4 ? manifest.ground.centerRect : manifest.field;
      for (const [x, y] of [[clean.x, clean.y], [clean.x + clean.width - 1, clean.y + clean.height - 1], [0, 0]]) {
        const result = await sharp(await renderBaseGroundPng(realm, 1, x!, y!)).raw().toBuffer();
        // Independent source-image address: expansion cannot stretch or shift
        // the ground under a fixed building coordinate, on either side of zero.
        const sx = Math.floor((x! - paint.x) * asset.width / paint.width);
        const sy = Math.floor((y! - paint.y) * asset.height / paint.height);
        const offset = (sy * asset.width + sx) * 4;
        expect(result.equals(source.subarray(offset, offset + 4)), `${descriptor.realmId} ${x},${y}`).toBe(true);
      }
      if (manifest.groundRevision === 4) {
        // Outside the painting an r4 realm composites exterior and far material:
        // every sample stays opaque, including far beyond the exterior rectangle.
        const f = manifest.field;
        for (const [ox, oy] of [[f.x - 1, f.y], [f.x + f.width, f.y + f.height], [-20000, -20000]]) {
          const edge = await sharp(await renderBaseGroundPng(realm, 1, ox!, oy!)).raw().toBuffer();
          expect(edge[3], `${descriptor.realmId} r4 edge ${ox},${oy}`).toBe(255);
        }
        continue;
      }
      // Independent two-dimensional material reference: once either coordinate
      // leaves the painting, neither sampled axis may retain scenic edge pixels.
      const cleanIndex = (world: number, start: number, span: number, pixels: number, cleanStart: number, cleanSpan: number) => {
        const index = Math.floor((world - start) * pixels / span);
        const first = Math.ceil((cleanStart - start) * pixels / span);
        const count = Math.floor((cleanStart + cleanSpan - start) * pixels / span) - first;
        return first + ((index - first) % count + count) % count;
      };
      const f = manifest.field;
      for (const [ox, oy] of [[f.x - 1, f.y], [f.x + f.width, f.y],
        [f.x, f.y - 2], [f.x, f.y + f.height], [f.x - f.width, f.y - f.height]]) {
        const edge = await sharp(await renderBaseGroundPng(realm, 2, ox!, oy!)).raw().toBuffer();
        const expected = [];
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
          const wx = ox! + x, wy = oy! + y;
          const outside = wx < f.x || wy < f.y || wx >= f.x + f.width || wy >= f.y + f.height;
          const sx = outside ? cleanIndex(wx, f.x, f.width, asset.width, clean.x, clean.width) : Math.floor((wx - f.x) * asset.width / f.width);
          const sy = outside ? cleanIndex(wy, f.y, f.height, asset.height, clean.y, clean.height) : Math.floor((wy - f.y) * asset.height / f.height);
          const offset = (sy * asset.width + sx) * 4;
          expected.push(source.subarray(offset, offset + 4));
        }
        expect(edge.equals(Buffer.concat(expected)), `${descriptor.realmId} edge ${ox},${oy}`).toBe(true);
      }
    }
  });

  it('refuses corrupt immutable manifests and textures, then recovers after the same bytes are repaired', async () => {
    const realm = context('frostveil');
    const { manifest, publicRoot, descriptor } = await published(realm);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pkw-layered-render-'));
    temporary.push(root);
    const copyRoot = path.join(root, 'apps/web/public');
    for (const filename of [descriptor.manifestPath, ...manifest.assets.map(a => a.path)]) {
      const target = path.join(copyRoot, filename);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(publicRoot, filename), target);
    }
    process.env['REPO_ROOT'] = root;
    const manifestPath = path.join(copyRoot, descriptor.manifestPath);
    await writeFile(manifestPath, '{}');
    await expect(renderBaseGroundPng(realm, 1, 0)).rejects.toThrow('manifest integrity');
    await copyFile(path.join(publicRoot, descriptor.manifestPath), manifestPath);
    const asset = manifest.assets[0]!;
    await writeFile(path.join(copyRoot, asset.path), 'corrupt');
    await expect(renderBaseGroundPng(realm, 1, 0)).rejects.toThrow('artwork integrity');
    await copyFile(path.join(publicRoot, asset.path), path.join(copyRoot, asset.path));
    const repaired = await renderBaseGroundPng(realm, 1, 0);
    expect((await sharp(repaired).metadata()).width).toBe(1);
  });
});
