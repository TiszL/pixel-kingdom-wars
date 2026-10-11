import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { buildLayeredGroundPreview, layeredSha256, renderLayeredGroundPreview, acceptedLayeredGround, pinAcceptedLayeredGround, publishAcceptedLayeredGround } from './layered-ground';
import type { LayeredGroundManifest } from '../../packages/shared/src/layeredGround';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => fs.rm(r, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'layered-ground-')); roots.push(root);
  // At least one complete texel must fit inside the unchanged r3 clean crop.
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#123456' } }).webp({ lossless: true }).toBuffer();
  await fs.mkdir(path.join(root, 'art/pilot'), { recursive: true }); await fs.writeFile(path.join(root, 'art/pilot/ground.webp'), bytes);
  const sha256 = layeredSha256(bytes), asset = { id: 'ground', path: `atlas/fantasy/layered-ground/assets/${sha256}.webp`, sha256,
    size: bytes.length, width: 8, height: 8, frameWidth: 8, frameHeight: 8, frameCount: 1, frameDurationMs: 100,
    anchor: { x: 0, y: 0 }, reducedMotionFrame: 0 as const };
  const manifest: LayeredGroundManifest = { schemaVersion: 1, groundRevision: 3, realmId: 'thornwake', status: 'preview-only', tilePixels: 32,
    field: { x: -1088, y: -1088, width: 3136, height: 3136 }, protectedFrame: { x: -256, y: -256, width: 1472, height: 1472 },
    ground: { asset: 'ground', sampling: 'world' }, assets: [asset], placements: [] };
  return { root, manifest, sources: [{ asset: 'ground', source: 'art/pilot/ground.webp' }] };
}
it('publishes only an explicit verified preview and reuses identical immutable bytes', async () => {
  const f = await fixture(), output = path.join(f.root, 'out');
  const result = await buildLayeredGroundPreview(f.root, f.manifest, f.sources, output);
  expect(result.status).toBe('preview-only');
  expect(layeredSha256(await fs.readFile(path.join(output, result.manifestPath)))).toBe(result.sha256);
  expect((await buildLayeredGroundPreview(f.root, f.manifest, f.sources, output)).sha256).toBe(result.sha256);
  expect([...await renderLayeredGroundPreview(f.root, f.manifest, f.sources, 1, 1)]).toEqual([18, 52, 86, 255]);
});
it('refuses corrupt sources before any output and refuses overwritten immutable targets', async () => {
  const f = await fixture(), output = path.join(f.root, 'out');
  const result = await buildLayeredGroundPreview(f.root, f.manifest, f.sources, output);
  await fs.writeFile(path.join(output, result.manifestPath), 'corrupt');
  await expect(buildLayeredGroundPreview(f.root, f.manifest, f.sources, output)).rejects.toThrow('Immutable');
  await fs.writeFile(path.join(f.root, f.sources[0]!.source), 'bad source');
  const absent = path.join(f.root, 'must-not-publish');
  await expect(buildLayeredGroundPreview(f.root, f.manifest, f.sources, absent)).rejects.toThrow('digest');
  await expect(fs.stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves accepted admission and gives server images the same canonical frame-zero geometry', async () => {
  const f = await fixture(); f.manifest.status = 'accepted';
  f.manifest.protectedFrame = {x:-576,y:-576,width:2112,height:2112};
  const result = await buildLayeredGroundPreview(f.root, f.manifest, f.sources, path.join(f.root, 'out'));
  expect(result.status).toBe('accepted');
  expect(result.manifest.protectedFrame).toEqual(f.manifest.protectedFrame);
  expect([...await renderLayeredGroundPreview(f.root,f.manifest,f.sources,1,1)]).toEqual([18,52,86,255]);
});

it('pins approved descriptors before publication and refuses rewriting historical revision3 rows', async () => {
  const f = await fixture(); f.manifest.status = 'accepted';
  await fs.mkdir(path.join(f.root,'art/realm-environments-v5'),{recursive:true});
  await fs.writeFile(path.join(f.root,'art/realm-environments-v5/accepted.json'),JSON.stringify({schemaVersion:1,status:'accepted',manifests:[{realmId:'thornwake',manifest:'art/pilot/layered-manifest.json'}]}));
  await fs.writeFile(path.join(f.root,'art/pilot/layered-manifest.json'),JSON.stringify(f.manifest));
  await fs.writeFile(path.join(f.root,'art/pilot/layered-sources.json'),JSON.stringify(f.sources));
  await fs.mkdir(path.join(f.root,'packages/shared/src'),{recursive:true});
  await fs.writeFile(path.join(f.root,'packages/shared/src/layeredGroundCatalogue.ts'),'// BEGIN GENERATED REVISION3 DESCRIPTORS\n// END GENERATED REVISION3 DESCRIPTORS');
  const rows = await acceptedLayeredGround(f.root);
  expect(rows).toHaveLength(1);
  await expect(publishAcceptedLayeredGround(f.root,{})).rejects.toThrow('pinned');
  const descriptors = await pinAcceptedLayeredGround(f.root,{});
  const pinned = {thornwake:descriptors[0]!};
  expect((await publishAcceptedLayeredGround(f.root,pinned))[0]?.sha256).toBe(descriptors[0]?.sha256);
  await expect(pinAcceptedLayeredGround(f.root,{thornwake:{...descriptors[0]!,sha256:'a'.repeat(64)}})).rejects.toThrow('immutable');
  expect(await fs.readFile(path.join(f.root,'packages/shared/src/layeredGroundCatalogue.ts'),'utf8')).toContain(descriptors[0]!.sha256);
});

async function revision4Fixture() {
  const f = await fixture();
  const assets = [];
  const sources = [];
  for (const id of ['center', 'outer', 'far']) {
    const dimension = id === 'far' ? 2 : 6;
    const raw = Buffer.alloc(dimension * dimension * 4);
    for (let y = 0; y < dimension; y++) for (let x = 0; x < dimension; x++) {
      const edge = x === 0 || y === 0 || x === dimension - 1 || y === dimension - 1;
      raw.set([id === 'center' ? 50 : id === 'outer' ? 100 : 150, 20, 30, id === 'far' || !edge ? 255 : 0], (y * dimension + x) * 4);
    }
    const bytes = await sharp(raw, { raw: { width: dimension, height: dimension, channels: 4 } }).webp({ lossless: true }).toBuffer();
    const hash = layeredSha256(bytes), source = `art/pilot/${id}.webp`;
    await fs.writeFile(path.join(f.root, source), bytes);
    assets.push({ ...f.manifest.assets[0]!, id, path: `atlas/fantasy/layered-ground/assets/${hash}.webp`, sha256: hash,
      size: bytes.length, width: dimension, height: dimension, frameWidth: dimension, frameHeight: dimension });
    sources.push({ asset: id, source });
  }
  const manifest: import('../../packages/shared/src/layeredGround').LayeredGroundManifestV4 = {
    ...f.manifest, schemaVersion: 2, groundRevision: 4, status: 'accepted', assets,
    protectedFrame: { x: -320, y: -320, width: 1600, height: 1600 },
    ground: { asset: 'center', sampling: 'world', centerRect: { x: -1872, y: -1872, width: 4704, height: 4704 },
      exterior: { asset: 'outer', rect: { x: -4320, y: -4320, width: 9600, height: 9600 } },
      far: { asset: 'far', origin: { x: 0, y: 0 }, period: { width: 64, height: 64 } } },
  };
  return { root: f.root, manifest, sources };
}
it('publishes r4 transparencies and shared static composition without changing an r3 descriptor block', async () => {
  const f = await revision4Fixture();
  await fs.mkdir(path.join(f.root, 'art/realm-environments-v6'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'art/realm-environments-v6/accepted.json'), JSON.stringify({ schemaVersion: 1, status: 'accepted', manifests: [{ realmId: 'thornwake', manifest: 'art/pilot/layered-manifest.json' }] }));
  await fs.writeFile(path.join(f.root, 'art/pilot/layered-manifest.json'), JSON.stringify(f.manifest));
  await fs.writeFile(path.join(f.root, 'art/pilot/layered-sources.json'), JSON.stringify(f.sources));
  await fs.mkdir(path.join(f.root, 'packages/shared/src'), { recursive: true });
  const historical = '// BEGIN GENERATED REVISION3 DESCRIPTORS\nimmutable historical bytes\n// END GENERATED REVISION3 DESCRIPTORS';
  const file = path.join(f.root, 'packages/shared/src/layeredGroundCatalogue.ts');
  await fs.writeFile(file, `${historical}\n// BEGIN GENERATED REVISION4 DESCRIPTORS\n// END GENERATED REVISION4 DESCRIPTORS`);
  const descriptors = await pinAcceptedLayeredGround(f.root, {}, 4);
  expect(await fs.readFile(file, 'utf8')).toContain(historical);
  const pinned = { thornwake: descriptors[0]! };
  const published = await publishAcceptedLayeredGround(f.root, pinned, 4);
  expect(published[0]!.manifest.groundRevision).toBe(4);
  expect([...await renderLayeredGroundPreview(f.root, f.manifest, f.sources, 1, 1, 0, 0)]).toEqual([50, 20, 30, 255]);
  await expect(pinAcceptedLayeredGround(f.root, { thornwake: { ...descriptors[0]!, size: 99 } }, 4)).rejects.toThrow('immutable');
});
it('an absent r4 inventory is inert and rejects published rows missing their sources', async () => {
  const f = await fixture();
  expect(await acceptedLayeredGround(f.root, 4)).toEqual([]);
  expect(await publishAcceptedLayeredGround(f.root, {}, 4)).toEqual([]);
  await expect(publishAcceptedLayeredGround(f.root, { thornwake: { realmId: 'thornwake', manifestPath: 'unused', sha256: 'a'.repeat(64), size: 1 } }, 4)).rejects.toThrow('pinned revision4');
});
it('rejects nontransparent collars before creating any immutable r4 output', async () => {
  const f = await revision4Fixture(), a = f.manifest.assets[0]!;
  const bytes = await sharp({ create: { width: 6, height: 6, channels: 4, background: '#123456' } }).webp({ lossless: true }).toBuffer();
  a.sha256 = layeredSha256(bytes); a.size = bytes.length; a.path = `atlas/fantasy/layered-ground/assets/${a.sha256}.webp`;
  await fs.writeFile(path.join(f.root, f.sources[0]!.source), bytes);
  const output = path.join(f.root, 'not-created');
  await expect(buildLayeredGroundPreview(f.root, f.manifest, f.sources, output)).rejects.toThrow('Invalid layered');
  await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
});

// ---------------------------------------------------------------------------
// Revision 5: the tile-based realm kit shares the registry/publisher family (REALM-KIT-PLAN E-2)
// ---------------------------------------------------------------------------
import { buildRealmKit, writeRealmKitBuild } from './realm-kit';
import { writeSyntheticRealm } from './realm-kit-synthetic';
async function revision5Fixture(status: 'preview-only' | 'accepted') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'layered-ground-r5-')); roots.push(root);
  await fs.mkdir(path.join(root, 'art/realm-kit-v1'), { recursive: true });
  await fs.writeFile(path.join(root, 'art/realm-kit-v1/accepted.json'), JSON.stringify({ schemaVersion: 1, manifests: [{ realmId: 'thornwake', manifest: 'art/realm-kit-v1/thornwake/layered-manifest.json', status }] }));
  const dir = await writeSyntheticRealm(root);
  await writeRealmKitBuild(dir, await buildRealmKit(dir));
  await fs.mkdir(path.join(root, 'packages/shared/src'), { recursive: true });
  const historical = '// BEGIN GENERATED REVISION3 DESCRIPTORS\nimmutable r3\n// END GENERATED REVISION3 DESCRIPTORS\n// BEGIN GENERATED REVISION4 DESCRIPTORS\nimmutable r4\n// END GENERATED REVISION4 DESCRIPTORS';
  await fs.writeFile(path.join(root, 'packages/shared/src/layeredGroundCatalogue.ts'), `${historical}\n// BEGIN GENERATED REVISION5 DESCRIPTORS\n// END GENERATED REVISION5 DESCRIPTORS`);
  return { root, dir, historical };
}
it('revision 5: a missing registry and preview-only rows are inert, so kit work under review never touches the asset build', async () => {
  const f = await revision5Fixture('preview-only');
  expect(await acceptedLayeredGround(f.root, 5)).toEqual([]);
  expect(await publishAcceptedLayeredGround(f.root, {}, 5)).toEqual([]);
  expect((JSON.parse(await fs.readFile(path.join(f.dir, 'layered-manifest.json'), 'utf8')) as { status: string }).status).toBe('preview-only');
  await fs.rm(path.join(f.root, 'art/realm-kit-v1/accepted.json'));
  expect(await acceptedLayeredGround(f.root, 5)).toEqual([]);
  // A preview-only row is skipped before its files are read: a dangling path does not fail the build.
  await fs.writeFile(path.join(f.root, 'art/realm-kit-v1/accepted.json'), JSON.stringify({ schemaVersion: 1, manifests: [{ realmId: 'crownlands', manifest: 'art/realm-kit-v1/nowhere/layered-manifest.json', status: 'preview-only' }] }));
  expect(await acceptedLayeredGround(f.root, 5)).toEqual([]);
  await fs.writeFile(path.join(f.root, 'art/realm-kit-v1/accepted.json'), JSON.stringify({ schemaVersion: 1, manifests: [{ realmId: 'thornwake', manifest: 'art/realm-kit-v1/thornwake/layered-manifest.json', status: 'shipped' }] }));
  await expect(acceptedLayeredGround(f.root, 5)).rejects.toThrow('registry status');
}, 60_000);
it('revision 5: an accepted row is verified with the realm-kit validators, pinned into its own catalogue block and published hash-addressed like r4, never rewriting r3/r4 rows', async () => {
  const f = await revision5Fixture('accepted');
  const rows = await acceptedLayeredGround(f.root, 5);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.manifest.groundRevision).toBe(5); expect(rows[0]!.manifest.status).toBe('accepted');
  await expect(publishAcceptedLayeredGround(f.root, {}, 5)).rejects.toThrow('pinned revision5');
  const descriptors = await pinAcceptedLayeredGround(f.root, {}, 5);
  const catalogue = await fs.readFile(path.join(f.root, 'packages/shared/src/layeredGroundCatalogue.ts'), 'utf8');
  expect(catalogue).toContain(f.historical);
  expect(catalogue).toContain(`export const BASE_LAYERED_GROUND_V5: Readonly<Partial<Record<RealmId, LayeredGroundDescriptor>>> = Object.freeze({\n  "thornwake"`);
  expect(catalogue).toContain(descriptors[0]!.sha256);
  const published = await publishAcceptedLayeredGround(f.root, { thornwake: descriptors[0]! }, 5);
  expect(published[0]!.manifest.groundRevision).toBe(5);
  expect(published[0]!.manifestPath).toBe(descriptors[0]!.manifestPath);
  for (const asset of published[0]!.files) expect(layeredSha256(await fs.readFile(path.join(f.root, 'apps/web/public', asset.path)))).toBe(asset.sha256);
  expect(layeredSha256(await fs.readFile(path.join(f.root, 'apps/web/public', descriptors[0]!.manifestPath)))).toBe(descriptors[0]!.sha256);
  await expect(pinAcceptedLayeredGround(f.root, { thornwake: { ...descriptors[0]!, size: 1 } }, 5)).rejects.toThrow('immutable');
  // A semi-transparent texel is refused at admission even when the manifest digest is updated to match it
  // (E-13 binary alpha, the realm-kit pixel rule), and a stale digest is refused before decoding.
  const tileset = rows[0]!.sources.find(s => s.asset === 'tileset')!;
  const png = await sharp(path.join(f.root, tileset.source)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  png.data[3] = 128;
  const bytes = await sharp(png.data, { raw: { width: png.info.width, height: png.info.height, channels: 4 } }).png().toBuffer();
  await fs.writeFile(path.join(f.root, tileset.source), bytes);
  await expect(acceptedLayeredGround(f.root, 5)).rejects.toThrow('digest');
  const manifestFile = path.join(f.root, 'art/realm-kit-v1/thornwake/layered-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as { assets: Array<{ id: string; sha256: string; size: number; path: string }> };
  const asset = manifest.assets.find(a => a.id === 'tileset')!;
  asset.sha256 = layeredSha256(bytes); asset.size = bytes.length; asset.path = `atlas/fantasy/layered-ground/assets/${asset.sha256}.png`;
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await expect(acceptedLayeredGround(f.root, 5)).rejects.toThrow('Invalid realm kit manifest');
}, 60_000);
