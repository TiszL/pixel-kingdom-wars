import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import type { LayeredGroundDescriptor } from '@shardkeep/shared/layeredGroundCatalogue';
import type { LayeredGroundManifestV4 } from '@shardkeep/shared/layeredGround';
import { renderBaseGroundPng } from '../src/game/baseRender';
import { NativeVisualContextSchema } from '../src/native/contracts';

const fixture = vi.hoisted(() => ({ descriptor: undefined as LayeredGroundDescriptor | undefined }));
vi.mock('@shardkeep/shared/layeredGroundCatalogue', async importOriginal => {
  const actual = await importOriginal<typeof import('@shardkeep/shared/layeredGroundCatalogue')>();
  return { ...actual, layeredGroundDescriptor: (context: Parameters<typeof actual.layeredGroundDescriptor>[0]) =>
    context.groundRevision === 4 && fixture.descriptor ? fixture.descriptor : actual.layeredGroundDescriptor(context) };
});
const originalRoot = process.env['REPO_ROOT'], roots: string[] = [];
const context = { version: 1, artVersion: 2, groundRevision: 4, realmId: 'thornwake' } as const;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
afterEach(async () => {
  if (originalRoot === undefined) delete process.env['REPO_ROOT']; else process.env['REPO_ROOT'] = originalRoot;
  fixture.descriptor = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function publish(revisionMismatch = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pkw-v4-png-')); roots.push(root);
  process.env['REPO_ROOT'] = root;
  const publicRoot = path.join(root, 'apps/web/public');
  const assets: LayeredGroundManifestV4['assets'] = [];
  for (const [index, id] of ['center', 'outer', 'far'].entries()) {
    const width = id === 'far' ? 2 : 16, rgba = Buffer.alloc(width * width * 4);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const border = x === 0 || y === 0 || x === width - 1 || y === width - 1;
      rgba.set(id === 'center' ? [0, 0, 180, border ? 0 : 255]
        : id === 'outer' ? [0, 150, 0, border ? 0 : 255] : [x ? 79 : 31, y ? 61 : 19, index, 255], (y * width + x) * 4);
    }
    const bytes = await sharp(rgba, { raw: { width, height: width, channels: 4 } }).png().toBuffer(), sha256 = hash(bytes);
    const assetPath = `atlas/fantasy/layered-ground/assets/${sha256}.png`;
    await mkdir(path.dirname(path.join(publicRoot, assetPath)), { recursive: true });
    await writeFile(path.join(publicRoot, assetPath), bytes);
    assets.push({ id, path: assetPath, sha256, size: bytes.length, width, height: width,
      frameWidth: width, frameHeight: width, frameCount: 1, frameDurationMs: 100, anchor: { x: 0, y: 0 }, reducedMotionFrame: 0 });
  }
  const manifest: LayeredGroundManifestV4 = { schemaVersion: 2, groundRevision: 4, status: 'accepted', realmId: 'thornwake', tilePixels: 32,
    field: { x: -1088, y: -1088, width: 3136, height: 3136 }, protectedFrame: { x: -320, y: -320, width: 1600, height: 1600 },
    ground: { asset: 'center', sampling: 'world', centerRect: { x: -1312, y: -1312, width: 3584, height: 3584 },
      exterior: { asset: 'outer', rect: { x: -4000, y: -4000, width: 9600, height: 9600 } },
      far: { asset: 'far', origin: { x: 0, y: 0 }, period: { width: 64, height: 64 } } }, assets, placements: [] };
  const value = revisionMismatch ? { ...manifest, schemaVersion: 1, groundRevision: 3, ground: { asset: 'center', sampling: 'world' } } : manifest;
  const bytes = Buffer.from(JSON.stringify(value) + '\n'), sha256 = hash(bytes);
  const manifestPath = `atlas/fantasy/layered-ground/${sha256}/manifest.json`;
  await mkdir(path.dirname(path.join(publicRoot, manifestPath)), { recursive: true });
  await writeFile(path.join(publicRoot, manifestPath), bytes);
  fixture.descriptor = { realmId: 'thornwake', manifestPath, sha256, size: bytes.length };
}
it('renders r4 centre, alpha exterior and negatively phased far ground through the actual PNG path', async () => {
  await publish();
  const pixel = async (x: number, y: number) => [...await sharp(await renderBaseGroundPng(context, 1, x, y)).raw().toBuffer()];
  expect(await pixel(-320, -320)).toEqual([0, 0, 180, 255]);
  expect(await pixel(1279, 1279)).toEqual([0, 0, 180, 255]);
  expect(await pixel(-2400, 0)).toEqual([0, 150, 0, 255]);
  expect(await pixel(-20001, -20001)).toEqual([31, 19, 2, 255]);
  expect(await pixel(-20001 + 64, -20001 + 64)).toEqual(await pixel(-20001, -20001));
});
it('rejects a hash-valid historical manifest offered for a revision4 context', async () => {
  await publish(true);
  await expect(renderBaseGroundPng(context, 1, 0, 0)).rejects.toThrow('realm is not accepted');
});
it('admits explicit revision4 native contexts without changing historical or unknown-version admission', () => {
  expect(NativeVisualContextSchema.safeParse(context).success).toBe(true);
  expect(NativeVisualContextSchema.safeParse({ ...context, groundRevision: 3 }).success).toBe(true);
  // Revision 5 (the realm kit, docs/REALM-KIT-PLAN.md E-2/E-12) is now a published
  // layered revision the server may emit; this line previously pinned it as
  // unknown. Old native renderers are served revision 4 by the client-presentation
  // hook, not by rejecting the context here (realm-kit-visual.test.ts).
  expect(NativeVisualContextSchema.safeParse({ ...context, groundRevision: 5 }).success).toBe(true);
  expect(NativeVisualContextSchema.safeParse({ ...context, groundRevision: 6 }).success).toBe(false);
  expect(NativeVisualContextSchema.safeParse({ ...context, groundRevision: 5, artVersion: 1 }).success).toBe(false);
  expect(NativeVisualContextSchema.safeParse({ ...context, artVersion: 1 }).success).toBe(false);
});
