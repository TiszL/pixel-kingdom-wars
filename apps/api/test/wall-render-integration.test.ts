/** Five-tier walls must reach real deed PNGs and the existing publishing worker.
 * Fixtures use the isolated test database and actual generated terrain. Nothing
 * here simulates upgrades, grants land, or writes to an external object store. */
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_BASE_VISUAL, DEFAULT_BASE_VISUAL, type BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { WALL_ART } from '@shardkeep/shared';
import { drawWalls, wallTierOfLevel, type PixelSink, type WallGrid } from '@shardkeep/shared/wallRender';
import { bases, buildings } from '../src/db/schema';
import { baseRenderAvailable, renderBasePng } from '../src/game/baseRender';
import { buildDeedMetadataForAsset } from '../src/game/deedMetadata';
import { sweepDeedMetadata, type ObjectPutter } from '../src/game/deedR2';
import { claimRect } from '../src/game/footprints';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
beforeAll(async () => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  await bootstrapSystemAccounts(db);
  // An absent pack must fail this integration gate, never silently skip walls.
  expect(baseRenderAvailable(), 'run pnpm assets before real wall/deed integration tests').toBe(true);
});
afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  await conn.sql.end();
});

type Placement = { tx: number; ty: number; level: number };
interface RawImage { data: Buffer; width: number; height: number }
async function raw(png: Buffer | null): Promise<RawImage> {
  if (!png) throw new Error('actual generated deed renderer unexpectedly unavailable');
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function fixture(expansions = 0, frozenVisualContext?: BaseVisualContext) {
  const { wallet } = await createTestPlayer(db);
  const cursor = `wall-art-${randomUUID()}`;
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet, expansions,
    deedAssetId: `${cursor}-deed`, landPaidAt: new Date('2026-09-09T00:00:00.000Z'),
  }).returning();
  if (!base) throw new Error('failed to insert test base');
  const ground = await raw(await renderBasePng(db, wallet, base.id, frozenVisualContext));
  return { wallet, base, cursor, ground, frozenVisualContext };
}

async function seedWalls(wallet: string, baseId: string, walls: readonly Placement[]) {
  if (walls.length) await db.insert(buildings).values(walls.map(wall => ({ ...wall, playerWallet: wallet, baseId, type: 'wall' as const })));
}

/** Independent command sink, deliberately not composeWall or its RGBA adapter:
 * this checks API frame conversion, placement, crop, and painter ordering against
 * the same world-coordinate commands Phaser draws at twice the source scale. */
function expectedWallPixels(ground: RawImage, walls: readonly Placement[], expansions = 0): Buffer {
  const data = Buffer.from(ground.data);
  const origin = (claimRect(expansions).min - 1) * WALL_ART.sourceTileSize;
  const grid: WallGrid = new Map(walls.map(wall => [`${wall.tx},${wall.ty}`, { tier: wallTierOfLevel(wall.level) }]));
  const sink: PixelSink = {
    fillStyle: '',
    fillRect(x, y, width, height) {
      const rgb = Number.parseInt(this.fillStyle.slice(1), 16);
      for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
        const px = x + dx - origin, py = y + dy - origin;
        if (px < 0 || py < 0 || px >= ground.width || py >= ground.height) continue;
        const offset = (py * ground.width + px) * 4;
        data[offset] = rgb >>> 16 & 255;
        data[offset + 1] = rgb >>> 8 & 255;
        data[offset + 2] = rgb & 255;
        data[offset + 3] = 255;
      }
    },
  };
  drawWalls(sink, grid);
  return data;
}

async function assertActualPixels(f: Awaited<ReturnType<typeof fixture>>, walls: readonly Placement[]) {
  const image = await raw(await renderBasePng(db, f.wallet, f.base.id, f.frozenVisualContext));
  expect([image.width, image.height]).toEqual([f.ground.width, f.ground.height]);
  expect(digest(image.data)).toBe(digest(expectedWallPixels(f.ground, walls, f.base.expansions)));
  expect(digest(image.data), 'walls must visibly replace grass').not.toBe(digest(f.ground.data));
  return image;
}

describe('five-tier actual deed rendering', () => {
  it('renders every gameplay level with the shared timber-to-shard art and unchanged legacy ground', async () => {
    // Pin the varied historical terrain: a new quiet clearing must not weaken
    // coverage of walls preserving detailed ground beneath archived deed frames.
    // The remaining fixtures exercise current ground through normal resolution.
    const f = await fixture(0, DEFAULT_BASE_VISUAL);
    const walls = Array.from({ length: 20 }, (_, i) => ({ level: i + 1, tx: 9 + (i % 5) * 2, ty: 9 + Math.floor(i / 5) * 3 }));
    await seedWalls(f.wallet, f.base.id, walls);
    await assertActualPixels(f, walls);
    expect(new Set(f.ground.data).size, 'fixture uses real varied atlas terrain').toBeGreaterThan(20);
  });

  it('keeps all four timber/shard connection directions, loops and dense mixed platforms pixel-exact', async () => {
    const f = await fixture();
    const walls: Placement[] = [
      { tx: 10, ty: 10, level: 1 }, { tx: 10, ty: 9, level: 20 },
      { tx: 13, ty: 10, level: 1 }, { tx: 14, ty: 10, level: 20 },
      { tx: 17, ty: 9, level: 1 }, { tx: 17, ty: 10, level: 20 },
      { tx: 20, ty: 10, level: 1 }, { tx: 19, ty: 10, level: 20 },
    ];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) walls.push({ tx: 9 + x, ty: 15 + y, level: 1 + ((x + y * 3) % 5) * 4 });
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      if (x === 0 || y === 0 || x === 3 || y === 3) walls.push({ tx: 16 + x, ty: 15 + y, level: 1 + ((x + y) % 5) * 4 });
    }
    // Deliberately seed north/south out of order: SQL insertion cannot be the painter rule.
    await seedWalls(f.wallet, f.base.id, [...walls].reverse());
    await assertActualPixels(f, walls);
  });

  it('reflects persisted L16→17 completion in the wall and neighboring lower-tier shoulders', async () => {
    const f = await fixture();
    const walls = [{ tx: 12, ty: 11, level: 1 }, { tx: 12, ty: 12, level: 16 }, { tx: 13, ty: 12, level: 5 }];
    await seedWalls(f.wallet, f.base.id, walls);
    const before = await assertActualPixels(f, walls);
    // Look up the target by coordinates rather than relying on row order.
    const rows = await db.select().from(buildings).where(eq(buildings.baseId, f.base.id));
    const target = rows.find(row => row.tx === 12 && row.ty === 12);
    expect(target).toBeDefined();
    await db.update(buildings).set({ level: 17 }).where(eq(buildings.id, target!.id));
    walls[1]!.level = 17;
    const after = await assertActualPixels(f, walls);
    expect(digest(after.data)).not.toBe(digest(before.data));
    const reloaded = await raw(await renderBasePng(db, f.wallet, f.base.id));
    expect(digest(reloaded.data)).toBe(digest(after.data));
  });

  it('reconnects surviving deed walls after removal without retaining a stale context frame', async () => {
    const f = await fixture();
    const walls = [{ tx: 12, ty: 12, level: 1 }, { tx: 13, ty: 12, level: 20 }, { tx: 14, ty: 12, level: 1 }];
    await seedWalls(f.wallet, f.base.id, walls);
    await assertActualPixels(f, walls);
    const rows = await db.select().from(buildings).where(eq(buildings.baseId, f.base.id));
    await db.delete(buildings).where(eq(buildings.id, rows.find(row => row.tx === 13)!.id));
    await assertActualPixels(f, [walls[0]!, walls[2]!]);
  });

  it('keeps wall neighborhoods scoped to the deed when one wallet has overlapping base coordinates', async () => {
    const f = await fixture();
    const walls = [{ tx: 12, ty: 12, level: 1 }];
    await seedWalls(f.wallet, f.base.id, walls);
    const [other] = await db.insert(bases).values({ ownerWallet: f.wallet }).returning();
    await seedWalls(f.wallet, other!.id, [{ tx: 12, ty: 11, level: 20 }, { tx: 13, ty: 12, level: 20 }]);
    await assertActualPixels(f, walls);
    const outsider = await createTestPlayer(db);
    expect(await renderBasePng(db, outsider.wallet, f.base.id)).toBeNull();
  });

  it('revision5 republishes an unchanged revision4 deed picture exactly once through the normal worker', async () => {
    const f = await fixture();
    const walls = [{ tx: 12, ty: 12, level: 1 }, { tx: 13, ty: 12, level: 17 }];
    await seedWalls(f.wallet, f.base.id, walls);
    const b = await db.select({ type: buildings.type, level: buildings.level, tx: buildings.tx, ty: buildings.ty })
      .from(buildings).where(eq(buildings.baseId, f.base.id)).orderBy(buildings.tx, buildings.ty, buildings.type);
    const versionHash = (a: number) => createHash('sha256').update(JSON.stringify({ b, o: [], e: f.base.expansions, a, visualContext: a >= 5 ? CURRENT_BASE_VISUAL : DEFAULT_BASE_VISUAL })).digest('hex').slice(0, 8);
    const oldHash = versionHash(4), newHash = versionHash(5);
    const objectKey = `deed/asset/${f.base.deedAssetId}.png`, origin = 'https://wall-render.test';
    const oldDocument = await buildDeedMetadataForAsset(db, f.base.deedAssetId!, `${origin}/${objectKey}?v=${oldHash}`);
    expect(oldDocument).not.toBeNull();
    const lastPushed = new Map([[f.base.deedAssetId!, JSON.stringify(oldDocument)]]);
    const lastImageHash = new Map([[f.base.id, oldHash]]);
    const puts: Array<{ key: string; body: Buffer }> = [];
    const put: ObjectPutter = async (key, body) => { puts.push({ key, body: Buffer.from(body) }); };
    const options = { publicBaseUrl: origin, lastImageHash, after: f.cursor, limit: 1 };
    await sweepDeedMetadata(db, put, lastPushed, options);
    expect(puts.filter(item => item.key === objectKey)).toHaveLength(1);
    expect(lastImageHash.get(f.base.id)).toBe(newHash);
    const png = puts.find(item => item.key === objectKey)!.body;
    expect(digest((await raw(png)).data)).toBe(digest(expectedWallPixels(f.ground, walls)));
    const doc = puts.find(item => item.key === `deed/asset/${f.base.deedAssetId}.json`);
    expect(doc?.body.toString()).toContain(`${objectKey}?v=${newHash}`);
    const unchanged = await db.select({ type: buildings.type, level: buildings.level, tx: buildings.tx, ty: buildings.ty })
      .from(buildings).where(eq(buildings.baseId, f.base.id)).orderBy(buildings.tx, buildings.ty, buildings.type);
    expect(unchanged).toEqual(b);
    puts.length = 0;
    await sweepDeedMetadata(db, put, lastPushed, options);
    expect(puts).toEqual([]);
  });
});
