/** Server deed/thumbnail rendering of revision-5 realm-kit ground (docs/REALM-KIT-PLAN.md
 * E-10). WHY: the deed pictures the land the deed conveys, and on the kit that land
 * is the kingdom turf plus its boundary ring drawn from the claim — so the same base
 * must render differently after an expansion, and a revision-5 context with no
 * published kit must refuse rather than quietly painting an older ground. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { LayeredGroundDescriptor } from '@shardkeep/shared/layeredGroundCatalogue';
import { realmKitCell, realmKitPlacementSeat, realmKitSpriteSource, realmKitTileState, renderRealmKitPixels,
  type RealmKitManifest } from '@shardkeep/shared/realmKit';
import { FIXTURE_CELL, fixtureCellRgb, fixtureClaim, fixturePropInk, fixturePropRgb, realmKitFixture,
  realmKitFixturePixels } from '../../../packages/shared/src/realmKit.fixture';
import { obstacles, players } from '../src/db/schema';
import { baseRenderAvailable, renderBaseGroundPng, renderBasePng } from '../src/game/baseRender';
import { claimRect } from '../src/game/footprints';
import { realmKitDescriptorFrom } from '../src/game/realmKitCatalogue';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const fixture = vi.hoisted(() => ({ descriptor: undefined as LayeredGroundDescriptor | undefined }));
vi.mock('../src/game/realmKitCatalogue', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/game/realmKitCatalogue')>();
  // The real rule against a table that holds only the published fixture (or nothing).
  return { ...actual, realmKitDescriptor: (context: Parameters<typeof actual.realmKitDescriptor>[0]) =>
    actual.realmKitDescriptorFrom(fixture.descriptor ? { crownlands: fixture.descriptor } : {}, context) };
});
const originalRoot = process.env['REPO_ROOT'], roots: string[] = [];
const context = { version: 1, artVersion: 2, groundRevision: 5, realmId: 'crownlands' } as const;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
// The obstacle test composites over the REAL generated atlases (the deed's footprint
// and `dec_` fallback come from meta.json); when they are absent it SAYS so via a skip.
const atlasReady = baseRenderAvailable();
const conn = connectTestDb();
const db = conn.db;
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });
afterEach(async () => {
  if (originalRoot === undefined) delete process.env['REPO_ROOT']; else process.env['REPO_ROOT'] = originalRoot;
  fixture.descriptor = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
/** Publish the shared synthetic kit the way the builder would: real PNG bytes,
 * hash-addressed asset paths, a hash-pinned manifest under a throwaway REPO_ROOT. */
async function publish(status: RealmKitManifest['status'] = 'accepted') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pkw-r5-png-')); roots.push(root);
  process.env['REPO_ROOT'] = root;
  const publicRoot = path.join(root, 'apps/web/public');
  const manifest = realmKitFixture();
  const pixels = realmKitFixturePixels(manifest);
  for (const asset of manifest.assets) {
    const p = pixels.get(asset.id)!;
    const bytes = await sharp(Buffer.from(p.data), { raw: { width: p.width, height: p.height, channels: 4 } }).png().toBuffer();
    asset.sha256 = hash(bytes); asset.size = bytes.length; asset.path = `atlas/fantasy/layered-ground/assets/${asset.sha256}.png`;
    await mkdir(path.dirname(path.join(publicRoot, asset.path)), { recursive: true });
    await writeFile(path.join(publicRoot, asset.path), bytes);
  }
  manifest.status = status;
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n'), sha256 = hash(bytes);
  const manifestPath = `atlas/fantasy/layered-ground/${sha256}/manifest.json`;
  await mkdir(path.dirname(path.join(publicRoot, manifestPath)), { recursive: true });
  await writeFile(path.join(publicRoot, manifestPath), bytes);
  fixture.descriptor = { realmId: 'crownlands', manifestPath, sha256, size: bytes.length };
  return { manifest, pixels };
}
const raw = async (png: Buffer) => sharp(png).raw().toBuffer();

it('paints revision-5 ground from the claim: the kingdom grows with expansions and the picture changes', async () => {
  const { manifest, pixels } = await publish();
  const small = fixtureClaim(14), large = fixtureClaim(26);
  // A full-plot crop at the kit's own 32 px/tile, as the deed renderer frames it.
  const size = 30 * 32;
  const first = await raw(await renderBaseGroundPng(context, size, 0, 0, small));
  const grown = await raw(await renderBaseGroundPng(context, size, 0, 0, large));
  expect(first.equals(grown)).toBe(false);
  // Byte-identical to the shared canonical rasterizer: web, native and the deed draw one rule.
  expect(first.equals(Buffer.from(renderRealmKitPixels(manifest, pixels, small, size, size, 0, 0)))).toBe(true);
  expect(grown.equals(Buffer.from(renderRealmKitPixels(manifest, pixels, large, size, size, 0, 0)))).toBe(true);
  // Tile 4,4 is wilderness under claim 14 and kingdom turf under claim 26.
  const at = (data: Buffer, tx: number, ty: number) => [...data.subarray((ty * 32 * size + tx * 32) * 4, (ty * 32 * size + tx * 32) * 4 + 3)];
  expect(realmKitCell(manifest, small, 'base', 4, 4)).toBe(FIXTURE_CELL.meadow);
  expect(at(first, 4, 4)).toEqual(fixtureCellRgb(FIXTURE_CELL.meadow));
  const turf = realmKitCell(manifest, large, 'base', 4, 4);
  expect(manifest.ground.state.turf).toContain(turf);
  expect(at(grown, 4, 4)).toEqual(fixtureCellRgb(turf));
  // The same claim renders the same bytes again (deterministic, cached working set).
  expect((await raw(await renderBaseGroundPng(context, size, 0, 0, small))).equals(first)).toBe(true);
});

it('clears a baked frame prop from the deed once the claim plus its ring reaches the prop seat (E-6 amended)', async () => {
  const { manifest } = await publish();
  // 'oak-frame-east' stands on protected-frame tile (30,15) drawing sheet cell 3, a
  // colour no ground cell, far texel or other prop uses; crop the four tiles around
  // that seat (29..32 × 13..16) at the kit's own 32 px/tile, as a deed would.
  const oak = manifest.placements.find(p => p.id === 'oak-frame-east')!;
  expect(realmKitPlacementSeat(oak)).toEqual({ tx: 30, ty: 15 });
  const size = 4 * 32, originX = 29 * 32, originY = 13 * 32;
  const ink = fixturePropRgb(3);
  const inkPixels = (data: Buffer) => {
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === ink[0] && data[i + 1] === ink[1] && data[i + 2] === ink[2]) n++;
    return n;
  };
  // Under the 26-tile claim ([2,28), ring to 29) tile 30 is wilderness and the whole oak is drawn: every ink texel of its 32×48 cell.
  expect(realmKitTileState(fixtureClaim(26), 30, 15)).toBe('wilderness');
  const wild = await raw(await renderBaseGroundPng(context, size, originX, originY, fixtureClaim(26)));
  expect(inkPixels(wild)).toBe([...Array(32).keys()].filter(fixturePropInk).length * 48);
  // The 30-tile claim ([0,30)) puts tile 30 in its edge ring: owned land is cleared land, so not one oak texel survives.
  expect(realmKitTileState(fixtureClaim(30), 30, 15)).toBe('edge');
  const owned = await raw(await renderBaseGroundPng(context, size, originX, originY, fixtureClaim(30)));
  expect(inkPixels(owned)).toBe(0);
});

it.skipIf(!atlasReady)('derives the deed claim from the base\'s own expansions: the frame oak clears once that land reaches its seat', async () => {
  // WHY: paintBasePng computes claim = claimRect(expansions) and hands THAT to the
  // kit rasterizer. The crops above hand renderBaseGroundPng a claim of their own,
  // so a deed painter that forwarded claimRect(0) — or dropped the argument — would
  // picture the 14-tile kingdom on every expanded base (or 500) and stay green.
  // This one renders through renderBasePng against the player row itself.
  const { manifest } = await publish();
  const p = await createTestPlayer(db); // no rows: the deed is exactly the ground
  const oak = manifest.placements.find(pl => pl.id === 'oak-frame-east')!;
  expect(realmKitPlacementSeat(oak)).toEqual({ tx: 30, ty: 15 });
  const ink = fixturePropRgb(3);
  const inkPixels = (data: Buffer) => {
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === ink[0] && data[i + 1] === ink[1] && data[i + 2] === ink[2]) n++;
    return n;
  };
  const frame = (claim: { min: number; max: number }) => ({ side: (claim.max - claim.min + 2) * 32, origin: (claim.min - 1) * 32 });
  const deed = async () => raw((await renderBasePng(db, p.wallet, undefined, context))!);

  // Seven expansions: claim [0,30) — the deed frames tiles -1..30 and tile 30 is in the ring.
  await db.update(players).set({ expansions: 7 }).where(eq(players.wallet, p.wallet));
  const owned = claimRect(7), { side, origin } = frame(owned);
  expect(owned).toEqual(fixtureClaim(30));
  expect(realmKitTileState(owned, 30, 15)).toBe('edge');
  const picture = await deed();
  expect(picture.length).toBe(side * side * 4);
  expect(inkPixels(picture), 'owned land is cleared land: the deed must not draw the frame oak').toBe(0);
  expect(picture.equals(await raw(await renderBaseGroundPng(context, side, origin, origin, owned))),
    'the deed must be the shared rasterizer under the base\'s own claim').toBe(true);
  // The smallest kingdom in the SAME frame leaves the oak standing, so the zero above is the claim's doing.
  const smallest = await raw(await renderBaseGroundPng(context, side, origin, origin, claimRect(0)));
  expect(inkPixels(smallest)).toBeGreaterThan(0);
  expect(picture.equals(smallest)).toBe(false);

  // The claim is read from the row on every render, not fixed: six expansions
  // ([2,28)) frame tiles 1..28 — the oak's seat is out of the picture, the kingdom smaller.
  await db.update(players).set({ expansions: 6 }).where(eq(players.wallet, p.wallet));
  const shrunk = claimRect(6), small = frame(shrunk);
  expect(shrunk).toEqual(fixtureClaim(26));
  const shrunkPicture = await deed();
  expect(shrunkPicture.length).toBe(small.side * small.side * 4);
  expect(shrunkPicture.equals(await raw(await renderBaseGroundPng(context, small.side, small.origin, small.origin, shrunk)))).toBe(true);
});

it.skipIf(!atlasReady)('draws a standing obstacle row from the kit sheet the base shows, not the dec_ master (E-11 twins)', async () => {
  // WHY: REALM-KIT-PLAN §6 step 6 "deed thumbnail parity". BaseScene re-keys every
  // server obstacle row to `obstacleSprites` on revision-5 ground; a deed that kept
  // compositing `dec_tree_old` pictured a different base than the one the player sees.
  const { manifest, pixels } = await publish();
  const p = await createTestPlayer(db); // no buildings: the picture is ground + rows only
  const claim = claimRect(0), side = (claim.max - claim.min + 2) * 32, origin = (claim.min - 1) * 32;
  const ground = await renderBaseGroundPng(context, side, origin, origin, claim);
  const deed = async () => raw((await renderBasePng(db, p.wallet, undefined, context))!);

  // Mapped key: `tree_old` → the fixture's 'oak' sheet, still cell 0 (32×48, anchor
  // bottom-centre), seated exactly as the web/deed seat rule puts a 2×2 dec_ row:
  // anchor x on the footprint centre, bottom edge on its south edge.
  await db.insert(obstacles).values({ playerWallet: p.wallet, spriteKey: 'tree_old', tx: 10, ty: 10 });
  const oak = manifest.assets.find(a => a.id === manifest.obstacleSprites.tree_old!.intact)!, sheet = pixels.get(oak.id)!;
  const cell = realmKitSpriteSource(oak, 0);
  const still = await sharp(Buffer.from(sheet.data), { raw: { width: sheet.width, height: sheet.height, channels: 4 } })
    .extract({ left: cell.x, top: cell.y, width: cell.width, height: cell.height }).png().toBuffer();
  const left = Math.round((10 + 2 / 2) * 32 - oak.anchor.x / oak.frameWidth * cell.width) - origin;
  const top = Math.round((10 + 2) * 32 - cell.height) - origin;
  const expected = await raw(await sharp(ground).composite([{ input: still, left, top }]).png().toBuffer());
  const withOak = await deed();
  expect(withOak.equals(expected), 'the deed must composite the kit still at the shared obstacle seat').toBe(true);
  expect(withOak.equals(await raw(ground))).toBe(false);

  // Unmapped key: the fixture leaves `bush` to the frozen dec_ master (O-7), which
  // still draws — inside the bush's seat box, and never a texel of the oak's ink.
  await db.delete(obstacles).where(eq(obstacles.playerWallet, p.wallet));
  await db.insert(obstacles).values({ playerWallet: p.wallet, spriteKey: 'bush', tx: 12, ty: 12 });
  const withBush = await deed(), plain = await raw(ground), ink = fixturePropRgb(0);
  let changed = 0, inked = 0, x0 = side, x1 = -1, y0 = side, y1 = -1;
  for (let i = 0; i < plain.length; i += 4) {
    if (withBush[i] === ink[0] && withBush[i + 1] === ink[1] && withBush[i + 2] === ink[2]) inked++;
    if (withBush[i] === plain[i] && withBush[i + 1] === plain[i + 1] && withBush[i + 2] === plain[i + 2]) continue;
    changed++;
    const x = (i / 4) % side, y = Math.floor(i / 4 / side);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  expect(inked, 'an unmapped key must not borrow another row\'s kit sprite').toBe(0);
  expect(changed, 'the dec_ master must still draw for an unmapped key').toBeGreaterThan(0);
  const south = (12 + 1) * 32 - origin, centre = (12 + 1 / 2) * 32 - origin;
  expect(y1).toBeLessThan(south); expect(y0).toBeGreaterThanOrEqual(south - 64);
  expect(x0).toBeGreaterThanOrEqual(centre - 32); expect(x1).toBeLessThan(centre + 32);
});

it.skipIf(!atlasReady)('draws an expansion obstacle as the kit prop it was — the seated still, not the tier twin — so the deed shows the tree the player sees (E-11 expansion obstacles)', async () => {
  // WHY: syncKitObstacles seats the frame oak (sheet cell 3 on tile 30,15) as a pine2 row
  // once the claim owns tile 30. The fixture maps no pine2 twin, so a deed that asked
  // the twin table would fall back to `dec_pine_2`; the seat-aware rule draws the oak's
  // own cell 3 exactly where the ground rasterizer just stopped drawing it as a prop.
  const { manifest, pixels } = await publish();
  const p = await createTestPlayer(db);
  await db.update(players).set({ expansions: 8 }).where(eq(players.wallet, p.wallet));
  const claim = claimRect(8), side = (claim.max - claim.min + 2) * 32, origin = (claim.min - 1) * 32;
  expect(realmKitTileState(claim, 30, 15)).toBe('kingdom');
  const ground = await renderBaseGroundPng(context, side, origin, origin, claim);
  const ink = fixturePropRgb(3);
  const inkPixels = (data: Buffer) => {
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === ink[0] && data[i + 1] === ink[1] && data[i + 2] === ink[2]) n++;
    return n;
  };
  expect(inkPixels(await raw(ground)), 'the claim hides the prop itself').toBe(0);
  await db.insert(obstacles).values({ playerWallet: p.wallet, spriteKey: 'pine2', tx: 30, ty: 15 });
  const deed = await raw((await renderBasePng(db, p.wallet, undefined, context))!);
  const oak = manifest.assets.find(a => a.id === 'oak')!, sheet = pixels.get(oak.id)!;
  const cell = realmKitSpriteSource(oak, 3);
  const still = await sharp(Buffer.from(sheet.data), { raw: { width: sheet.width, height: sheet.height, channels: 4 } })
    .extract({ left: cell.x, top: cell.y, width: cell.width, height: cell.height }).png().toBuffer();
  const left = Math.round((30 + 1 / 2) * 32 - oak.anchor.x / oak.frameWidth * cell.width) - origin;
  const top = Math.round((15 + 1) * 32 - cell.height) - origin;
  const expected = await raw(await sharp(ground).composite([{ input: still, left, top }]).png().toBuffer());
  expect(inkPixels(deed), 'the row draws the oak\'s own cell').toBe([...Array(32).keys()].filter(fixturePropInk).length * 48);
  expect(deed.equals(expected), 'the deed composites the seated prop\'s still on the shared obstacle seat').toBe(true);
  // A row of another kind on that seat is not the oak's: the fixture leaves pine1 to the dec_ master.
  await db.delete(obstacles).where(eq(obstacles.playerWallet, p.wallet));
  await db.insert(obstacles).values({ playerWallet: p.wallet, spriteKey: 'pine1', tx: 30, ty: 15 });
  expect(inkPixels(await raw((await renderBasePng(db, p.wallet, undefined, context))!))).toBe(0);
});

it('refuses a revision-5 context without a claim or without a published, accepted kit — never a quiet older ground', async () => {
  // Unpublished realm: the catalogue seam throws by name before any file is opened.
  await expect(renderBaseGroundPng(context, 32, 0, 0, fixtureClaim(14))).rejects.toThrow('Realm kit artwork is not published: crownlands');
  expect(() => realmKitDescriptorFrom({}, context)).toThrow('not published: crownlands');
  expect(() => realmKitDescriptorFrom({}, { ...context, groundRevision: 4 })).toThrow('revision5 context');
  await publish();
  await expect(renderBaseGroundPng(context, 32, 0, 0)).rejects.toThrow('requires the base claim');
  await publish('preview-only');
  await expect(renderBaseGroundPng(context, 32, 0, 0, fixtureClaim(14))).rejects.toThrow('realm is not accepted');
});
