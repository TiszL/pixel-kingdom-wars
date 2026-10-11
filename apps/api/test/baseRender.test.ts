/**
 * Base renderer (owner 2026-07-26: the deed NFT pictures the ACTUAL base).
 * Renders against the real generated atlases — the exact assets the client
 * ships — so a frame-name or geometry drift breaks HERE, not in wallets.
 * Atlases are generated + gitignored; when absent the suite SAYS so via a
 * skip (fail-loud rule) instead of green-lighting nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ART_V2,
  DEFENSES,
  STRUCTURES,
  WARE_WORLD_PRESENTATION,
  atlasGroupFor,
} from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildings as buildingsTable, players } from '../src/db/schema';
import { ensureStartingBase, placeBuilding } from '../src/game/base';
import {
  baseRenderAvailable, baseRenderStructureDepth, renderBasePng,
} from '../src/game/baseRender';

import { sweepDeedMetadata, type ObjectPutter } from '../src/game/deedR2';
import { bootstrapSystemAccounts } from '../src/ledger';
import { rewardShards } from '../src/game/spend';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

describe('deed painter order', () => {
  it('matches the live wall/building south-edge rule including equal ties', () => {
    const building = baseRenderStructureDepth('building', 10, 2);
    expect(baseRenderStructureDepth('wall', 10, 1)).toBeLessThan(building);
    expect(baseRenderStructureDepth('wall', 11, 1)).toBeLessThan(building);
    expect(baseRenderStructureDepth('wall', 12, 1)).toBeGreaterThan(building);
  });
});

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `render-${++key}-${Math.random().toString(36).slice(2)}`;
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

const atlasReady = baseRenderAvailable();

const DEED_TILE = 32;
const DEED_FRAME_ORIGIN_TILE = 7; // claim min 8 minus the renderer's one-tile margin

interface RawPng { data: Buffer; width: number; height: number; channels: number }
interface SpriteFixture {
  buf: Buffer;
  nativeWidth: number;
  nativeHeight: number;
  width: number;
  height: number;
  anchor: [number, number];
  anchorAtFootprintCentre: boolean;
  sourceScale: number | undefined;
  offsetGamePx: readonly [number, number] | undefined;
  opaque: { x0: number; y0: number; x1: number; y1: number };
}

const atlasDir = path.join(
  process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..'),
  'apps', 'web', 'public', 'atlas',
);

async function rawPng(png: Buffer): Promise<RawPng> {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

async function spriteFixture(key: string): Promise<SpriteFixture> {
  const sharp = (await import('sharp')).default;
  const group = atlasGroupFor(key);
  const sheet = JSON.parse(readFileSync(path.join(atlasDir, `${group}@1x.json`), 'utf8')) as {
    textures: Array<{ frames: Array<{
      filename: string;
      frame: { x: number; y: number; w: number; h: number };
    }> }>;
  };
  const metaJson = JSON.parse(readFileSync(path.join(atlasDir, 'meta.json'), 'utf8')) as {
    sprites: Record<string, {
      anchor: [number, number];
      anchorAtFootprintCentre?: boolean;
      sourceScale?: number;
      offsetGamePx?: readonly [number, number];
    }>;
  };
  const frame = sheet.textures[0]!.frames.find((candidate) => candidate.filename === key)?.frame;
  const meta = metaJson.sprites[key];
  if (!frame || !meta) throw new Error(`missing generated deed fixture for ${key}`);
  const width = Math.max(1, Math.round(frame.w * (meta.sourceScale ?? 1)));
  const height = Math.max(1, Math.round(frame.h * (meta.sourceScale ?? 1)));
  let buf = await sharp(path.join(atlasDir, `${group}@1x.png`))
    .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
    .png().toBuffer();
  if (width !== frame.w || height !== frame.h) {
    buf = await sharp(buf).resize({ width, height, kernel: sharp.kernel.nearest }).png().toBuffer();
  }
  const art = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < art.info.height; y++) for (let x = 0; x < art.info.width; x++) {
    if (art.data[(y * art.info.width + x) * art.info.channels + 3]! <= 8) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0 || y1 < 0) throw new Error(`generated deed fixture is transparent: ${key}`);
  return {
    buf,
    nativeWidth: frame.w,
    nativeHeight: frame.h,
    width,
    height,
    anchor: meta.anchor,
    anchorAtFootprintCentre: meta.anchorAtFootprintCentre === true,
    sourceScale: meta.sourceScale,
    offsetGamePx: meta.offsetGamePx,
    opaque: { x0, y0, x1, y1 },
  };
}

function spriteTopLeft(
  tx: number,
  ty: number,
  footprint: readonly [number, number],
  art: SpriteFixture,
): { left: number; top: number } {
  const [fw, fh] = footprint;
  const [offsetX, offsetY] = art.offsetGamePx ?? [0, 0];
  const frameOrigin = DEED_FRAME_ORIGIN_TILE * DEED_TILE;
  // THE SEAT, mirroring apps/web `game/v2/clips.ts#buildingSeatY`: the drawn
  // BOTTOM EDGE sits on the south edge of the footprint, so the top is that
  // edge less the drawn height and the anchor cancels out of the vertical
  // placement entirely. It still decides the horizontal one. This used to seat
  // a footprint-centre anchor on the footprint's MIDDLE row, which floated
  // every WARE/v2 building above its plot in the deed and the base alike
  // (owner 2026-08-30: buildings "need to fit into its tiles").
  return {
    left: Math.round((tx + fw / 2) * DEED_TILE + offsetX - art.anchor[0] * art.width) - frameOrigin,
    top: Math.round((ty + fh) * DEED_TILE + offsetY - art.height) - frameOrigin,
  };
}

async function isolatedBuildingRender(
  type: (typeof buildingsTable.$inferInsert)['type'],
  level: number,
  tx: number,
  ty: number,
): Promise<{ before: Buffer; after: Buffer }> {
  const p = await createTestPlayer(db);
  const before = await renderBasePng(db, p.wallet);
  await db.insert(buildingsTable).values({ playerWallet: p.wallet, type, level, tx, ty });
  const after = await renderBasePng(db, p.wallet);
  if (!before || !after) throw new Error('generated atlases unexpectedly unavailable');
  return { before, after };
}

async function deededPlayer() {
  const p = await createTestPlayer(db);
  await db.update(players)
    .set({ entryPaidAt: new Date(), deedAssetId: `asset-${p.wallet.slice(0, 8)}` })
    .where(eq(players.wallet, p.wallet));
  await ensureStartingBase(db, p.wallet);
  return p;
}

describe('base renderer', () => {
  it.skipIf(!atlasReady)('renders a starting base to a claim-sized PNG', async () => {
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);

    const png = await renderBasePng(db, p.wallet);
    expect(png).not.toBeNull();
    // PNG magic — this is a real image, not an empty buffer.
    expect(png!.subarray(0, 4).toString('hex')).toBe('89504e47');
    // Frame = claim (14 tiles at 0 expansions) + 1-tile margin each side, 32px/tile.
    const side = (14 + 2) * 32;
    // IHDR width/height live at fixed offsets in a PNG.
    expect(png!.readUInt32BE(16)).toBe(side);
    expect(png!.readUInt32BE(20)).toBe(side);
  });

  it.skipIf(!atlasReady)('draws the exact-current WARE Keep in the deed image', async () => {
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);

    const withKeep = await renderBasePng(db, p.wallet);
    await db.delete(buildingsTable).where(and(
      eq(buildingsTable.playerWallet, p.wallet),
      eq(buildingsTable.type, 'keep' as never),
    ));
    const withoutKeep = await renderBasePng(db, p.wallet);
    expect(withKeep).not.toBeNull();
    expect(withoutKeep).not.toBeNull();
    expect(withKeep!.equals(withoutKeep!),
      'a missing warefallback group silently omits the Keep from both renders').toBe(false);

    const atlasDir = path.join(
      process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..'),
      'apps', 'web', 'public', 'atlas',
    );
    const sheet = JSON.parse(readFileSync(path.join(atlasDir, 'bld@1x.json'), 'utf8')) as {
      textures: Array<{ frames: Array<{ filename: string }> }>;
    };
    const meta = JSON.parse(readFileSync(path.join(atlasDir, 'meta.json'), 'utf8')) as {
      sprites: Record<string, { anchorAtFootprintCentre?: boolean }>;
    };
    expect(sheet.textures[0]!.frames.some((frame) => frame.filename === 'bld_keep_l1')).toBe(true);
    // The published ART FACT the client reads as the sprite ORIGIN. It is no
    // longer a seating rule on either side (see spriteTopLeft), but it is still
    // what tells a WARE alias apart from a legacy bottom-anchored one, and the
    // deed and the base must keep reading the same manifest.
    expect(meta.sprites['bld_keep_l1']?.anchorAtFootprintCentre,
      'the deed and the base read one manifest anchor').toBe(true);
  });

  const wareFitCases = [
    {
      label: 'Keep L20', type: 'keep', level: 20, key: 'bld_keep_l20',
      footprint: STRUCTURES.keep.footprint,
      presentation: WARE_WORLD_PRESENTATION.keep,
    },
    {
      label: 'Mine L1', type: 'mine', level: 1, key: 'bld_mine_l1',
      footprint: STRUCTURES.mine.footprint,
      presentation: WARE_WORLD_PRESENTATION.mine,
    },
    {
      label: 'Barracks L1', type: 'barracks', level: 1, key: 'bld_barracks_l1',
      footprint: STRUCTURES.barracks.footprint,
      presentation: WARE_WORLD_PRESENTATION.barracks,
    },
    {
      label: 'Dragon Nest L14', type: 'dragonnest', level: 14, key: 'bld_dragonnest_l14',
      footprint: DEFENSES.dragonnest.footprint,
      presentation: WARE_WORLD_PRESENTATION.dragonnest,
    },
  ] as const;

  it.skipIf(!atlasReady).each(wareFitCases)(
    '$label uses the WARE fit contract and its audited horizontal envelope',
    async ({ type, level, key: spriteKey, footprint, presentation }) => {
      const sharp = (await import('sharp')).default;
      const tx = 12;
      const ty = 12;
      const { before, after } = await isolatedBuildingRender(type, level, tx, ty);
      const art = await spriteFixture(spriteKey);

      expect(
        { sourceScale: art.sourceScale, offsetGamePx: art.offsetGamePx },
        'generated meta must carry the same fit contract consumed by the web world',
      ).toEqual({
        sourceScale: presentation.sourceScale,
        offsetGamePx: presentation.offsetGamePx,
      });
      expect({ width: art.width, height: art.height }).toEqual({
        width: Math.max(1, Math.round(art.nativeWidth * presentation.sourceScale)),
        height: Math.max(1, Math.round(art.nativeHeight * presentation.sourceScale)),
      });

      const { left, top } = spriteTopLeft(tx, ty, footprint, art);
      const expected = await sharp(before).composite([{ input: art.buf, left, top }]).png().toBuffer();
      const [actualRaw, expectedRaw] = await Promise.all([rawPng(after), rawPng(expected)]);
      expect(actualRaw.data.equals(expectedRaw.data),
        'the deed must composite the resized crop at its recomputed scaled anchor').toBe(true);

      const footprintLeft = (tx - DEED_FRAME_ORIGIN_TILE) * DEED_TILE;
      const footprintRight = footprintLeft + footprint[0] * DEED_TILE - 1;
      const horizontalAllowance = 'maxHorizontalOverhangGamePx' in presentation
        ? presentation.maxHorizontalOverhangGamePx
        : 0;
      expect(left + art.opaque.x0, 'steady art exceeds its audited west envelope')
        .toBeGreaterThanOrEqual(footprintLeft - horizontalAllowance);
      expect(left + art.opaque.x1, 'steady art exceeds its audited east envelope')
        .toBeLessThanOrEqual(footprintRight + horizontalAllowance);

      if (type === 'keep') {
        const footprintBottom = (ty - DEED_FRAME_ORIGIN_TILE + footprint[1]) * DEED_TILE - 1;
        expect(art.sourceScale, 'deeds must retain the readable 2x2 Keep midpoint')
          .toBe(WARE_WORLD_PRESENTATION.keep.sourceScale);
        expect(top + art.opaque.y1, 'the taller Keep may rise north but never overflow south')
          .toBeLessThanOrEqual(footprintBottom);
      }

      if (type === 'mine') {
        const withoutCorrection = spriteTopLeft(tx, ty, footprint, {
          ...art,
          offsetGamePx: [0, 0],
        });
        expect(art.offsetGamePx).toEqual([1, 0]);
        expect(left, 'the WARE2 Mine body uses the recentered +1 px deed correction')
          .toBe(withoutCorrection.left + 1);
      }
    },
  );

  it.skipIf(!atlasReady)('leaves a legacy sprite with no presentation fields at native size and placement', async () => {
    const sharp = (await import('sharp')).default;
    const tx = 12;
    const ty = 12;
    const { before, after } = await isolatedBuildingRender('heroaltar', 1, tx, ty);
    const art = await spriteFixture('bld_heroaltar');
    expect(art.sourceScale).toBeUndefined();
    expect(art.offsetGamePx).toBeUndefined();
    expect({ width: art.width, height: art.height })
      .toEqual({ width: art.nativeWidth, height: art.nativeHeight });

    const { left, top } = spriteTopLeft(tx, ty, STRUCTURES.heroaltar.footprint, art);
    const expected = await sharp(before).composite([{ input: art.buf, left, top }]).png().toBuffer();
    const [actualRaw, expectedRaw] = await Promise.all([rawPng(after), rawPng(expected)]);
    expect(actualRaw.data.equals(expectedRaw.data),
      'missing presentation metadata must retain the historical native deed path').toBe(true);
  });

  it.skipIf(!atlasReady)('shows a triggered trap as spent in the deed image', async () => {
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);
    await rewardShards(db, p.wallet, 1_000n, 'test.fund.shards', k());
    await placeBuilding(db, p.wallet, 'spiketrap' as never, 10, 10, k());

    const armed = await renderBasePng(db, p.wallet);
    await db.update(buildingsTable).set({ trapSpentAt: new Date() }).where(and(
      eq(buildingsTable.playerWallet, p.wallet),
      eq(buildingsTable.type, 'spiketrap' as never),
    ));
    const spent = await renderBasePng(db, p.wallet);
    expect(armed).not.toBeNull();
    expect(spent).not.toBeNull();
    expect(armed!.equals(spent!),
      'spent persistence must select the authored sprung alias, not the armed frame').toBe(false);
  });

  it.skipIf(!atlasReady)('image re-renders when the LAYOUT changes, even if traits do not', async () => {
    const p = await createTestPlayer(db);
    const cursor = `render-layout-${p.wallet}-`;
    const deed = `${cursor}deed`;
    await db.update(players)
      .set({ entryPaidAt: new Date(), deedAssetId: deed })
      .where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);
    await fundTestKeep(db, p.wallet, 100_000n, 'test.fund', k());
    await rewardShards(db, p.wallet, 100_000n, 'test.fund.shards', k());

    const puts: string[] = [];
    const put: ObjectPutter = async (key2) => { puts.push(key2); };
    const lastPushed = new Map<string, string>();
    const lastImageHash = new Map<string, string>();
    // The shared test DB contains other suites' deeds. Exercise real rendering
    // for this fixture without paying their accumulated cold-render cost.
    const visited: string[] = [];
    const opts = { publicBaseUrl: 'https://pub.test.r2.dev', lastImageHash,
      after: cursor, limit: 1, onVisit: (assetId: string) => visited.push(assetId) };

    await sweepDeedMetadata(db, put, lastPushed, opts);
    expect(puts).toContain(`deed/${p.wallet}.png`);      // first sweep renders the image
    expect(puts).toContain(`deed/asset/${deed}.json`);   // and the JSON embeds its URL
    const v1 = lastImageHash.get(p.wallet)!;

    // Quiet sweep: same layout → NO second image render, NO json push.
    puts.length = 0;
    await sweepDeedMetadata(db, put, lastPushed, opts);
    expect(puts).toEqual([]);

    // A new WALL changes the picture AND the building count — but the deeper
    // contract is the cache-buster: the json's image URL must change with the
    // layout hash, or wallets keep showing the stale cached PNG forever.
    await placeBuilding(db, p.wallet, 'wall' as never, 9, 9, k());
    await sweepDeedMetadata(db, put, lastPushed, opts);
    expect(puts).toContain(`deed/${p.wallet}.png`);
    expect(lastImageHash.get(p.wallet)).not.toBe(v1);
    expect(lastPushed.get(deed)).toContain(`?v=${lastImageHash.get(p.wallet)}`);
    expect(visited).toEqual([deed, deed, deed]);
  });

  it.skipIf(!atlasReady)('draws the defences out of their real groups — cannon rides v2bld now', async () => {
    // Batch 13 moved the six reworked defences out of the `bld` atlas into
    // `blddef`; rework v2 (Phase D) moved the cannon/mortar again, into the
    // per-tier `v2bld_<unit>_t<n>` groups with anchors in v2Clips. This
    // renderer OMITS any sprite whose frame it cannot find (a deliberate
    // degrade), so a wrong group/key/anchor publishes deed images of bases
    // with no towers on them and NOTHING reports it — not a throw, not a
    // warning, not a failing test. Nothing else in the suite could see it:
    // ensureStartingBase places only a Keep, and the two image tests above use
    // keep/wall/spiketrap, all of which now route through the separately pinned
    // WARE fallback path above. The cannon below is
    // therefore the pin for the WHOLE v2 deed path (key → group → halved
    // crop → anchorPx placement).
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);
    await rewardShards(db, p.wallet, 500_000n, 'test.fund.shards', k());
    await fundTestKeep(db, p.wallet, 500_000n, 'test.fund', k());

    const sharp = (await import('sharp')).default;
    const raw = async (): Promise<{ data: Buffer; width: number; ch: number }> => {
      const png = await renderBasePng(db, p.wallet);
      const { data, info } = await sharp(png!).raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, ch: info.channels };
    };
    const region = (r: Awaited<ReturnType<typeof raw>>, x0: number, y0: number): string => {
      const out: number[] = [];
      for (let y = y0; y < y0 + 32; y++) for (let x = x0; x < x0 + 32; x++) {
        out.push(...r.data.subarray((y * r.width + x) * r.ch, (y * r.width + x) * r.ch + 3));
      }
      return out.join(',');
    };

    const before = await raw();
    await placeBuilding(db, p.wallet, 'cannon' as never, 10, 10, k());
    const after = await raw();
    // Frame origin is tile 7, so tile (10,10) is the 32×32 block at frame px
    // (96,96). The renderer draws grass and sprites and nothing else, so if the
    // cannon resolved this block is different and if it was omitted the block is
    // byte-identical bare grass. That is the whole failure mode, pinned.
    expect(region(after, 96, 96)).not.toBe(region(before, 96, 96));

    /*
     * …and WHERE + HOW BIG, which the block test above cannot see. Two ways to
     * get this wrong were both live:
     *  - SCALE. The v2 pack is authored at 32 game px per tile, which is exactly
     *    this renderer's TILE — so the @2x half of the web scale has no
     *    counterpart here, but the unit's PUBLISHED WORLD FIT does apply on both
     *    sides. Two ways to break that have now each been live: an early halving
     *    read the pack as 64px/tile and drew the deed's cannon at half the base's
     *    size, and drawing NATIVE (no fit at all) left the deed showing the
     *    oversized Cannon the base stopped drawing when it was fitted under the
     *    Keep (owner 2026-08-30).
     *  - SEAT. (56,104) is the CENTRE of the cannon's footprint, not a ground
     *    line, so the position point is the footprint's middle row — half a tile
     *    north of the south edge every other building seats on.
     * Both are pinned by DERIVING the expected pixel box from the atlas frame
     * itself (its opaque bounds) plus the seat, and comparing with the box that
     * actually changed. Under the halving the box was ~20×20 near (102,114);
     * under the south-edge seat it sat 16px lower. Nothing about the derivation
     * is hand-typed except the anchor the pack publishes.
     */
    const changed = ((): { x0: number; y0: number; x1: number; y1: number } => {
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      const h = before.data.length / (before.width * before.ch);
      for (let y = 0; y < h; y++) for (let x = 0; x < before.width; x++) {
        const i = (y * before.width + x) * before.ch;
        if (before.data[i] === after.data[i]
          && before.data[i + 1] === after.data[i + 1]
          && before.data[i + 2] === after.data[i + 2]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return { x0, y0, x1, y1 };
    })();
    // The drawn art occupies a sub-box of the 112×120 idle cell; measured from
    // the packed atlas so a re-delivery of the art needs no numbers re-typed
    // here. Read exactly the way baseRender reads it (same dir resolution).
    const atlasDir = path.join(
      process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..'),
      'apps', 'web', 'public', 'atlas',
    );
    const sheet = JSON.parse(readFileSync(path.join(atlasDir, 'v2bld_cannon_t1@1x.json'), 'utf8')) as {
      textures: Array<{ frames: Array<{ filename: string; frame: { x: number; y: number; w: number; h: number } }> }>;
    };
    const cell = sheet.textures[0]!.frames
      .find((f) => f.filename === 'v2_bld_cannon_t1_idle_d0_f1')!.frame;
    const art = await sharp(path.join(atlasDir, 'v2bld_cannon_t1@1x.png'))
      .extract({ left: cell.x, top: cell.y, width: cell.w, height: cell.h })
      .raw().toBuffer({ resolveWithObject: true });
    let ax0 = Infinity, ay0 = Infinity, ax1 = -1, ay1 = -1;
    for (let y = 0; y < art.info.height; y++) for (let x = 0; x < art.info.width; x++) {
      if (art.data[(y * art.info.width + x) * art.info.channels + 3]! <= 8) continue;
      if (x < ax0) ax0 = x; if (x > ax1) ax1 = x;
      if (y < ay0) ay0 = y; if (y > ay1) ay1 = y;
    }
    const TILE = 32;
    const OX = 7 * TILE;               // frame origin: (claim.min − margin) tiles
    const [fw, fh] = [1, 1];           // cannon stays 1×1 (locked owner decision)
    // The FIT the deed must apply — the same published number the web seat
    // multiplies in (game/v2/clips.ts#v2BldDrawScale). Read, never re-typed.
    const fit = ART_V2.buildingSourceScale.cannon;
    expect(fit, 'the Cannon is fitted DOWN, not drawn native').toBeLessThan(1);
    const width = Math.max(1, Math.round(cell.w * fit));
    const height = Math.max(1, Math.round(cell.h * fit));
    expect({ w: cell.w, h: cell.h }, 'the packed cell itself is unchanged')
      .toEqual({ w: 112, h: 120 });
    // Re-measure the opaque bounds AFTER the same nearest-neighbour fit the
    // renderer applies: a downscale moves the ink box, and deriving it any
    // other way would be re-typing the renderer's arithmetic rather than
    // checking its output.
    const fitted = await sharp(path.join(atlasDir, 'v2bld_cannon_t1@1x.png'))
      .extract({ left: cell.x, top: cell.y, width: cell.w, height: cell.h })
      .resize({ width, height, kernel: sharp.kernel.nearest })
      .raw().toBuffer({ resolveWithObject: true });
    let fx0 = Infinity, fy0 = Infinity, fx1 = -1, fy1 = -1;
    for (let y = 0; y < fitted.info.height; y++) for (let x = 0; x < fitted.info.width; x++) {
      if (fitted.data[(y * fitted.info.width + x) * fitted.info.channels + 3]! <= 8) continue;
      if (x < fx0) fx0 = x; if (x > fx1) fx1 = x;
      if (y < fy0) fy0 = y; if (y > fy1) fy1 = y;
    }
    // The fit really did shrink the drawn body — otherwise this test would keep
    // passing against a renderer that silently dropped the fit again.
    expect(fx1 - fx0).toBeLessThan(ax1 - ax0);
    // Published anchor (56,104) as a FRACTION of the cell decides the
    // HORIZONTAL placement of the fitted crop; the vertical seat is the drawn
    // bottom edge on the footprint's south edge, so the anchor cancels there.
    const left = Math.round((10 + fw / 2) * TILE - (56 / cell.w) * width) - OX;
    const top = Math.round((10 + fh) * TILE - height) - OX;
    expect(changed).toEqual({ x0: left + fx0, y0: top + fy0, x1: left + fx1, y1: top + fy1 });
  });

  /**
   * THE MORTAR, i.e. the same v2 deed path with a 2×2 GAME footprint.
   *
   * The cannon above cannot see the footprint arithmetic at all: at 1×1 the
   * centre seat `ty + fh*0.5` and the width term `tx + fw/2` are both half a tile,
   * so a renderer that used the pack's own [2,2] VISUAL footprint, or that seated
   * on the south edge, or that dropped the `fh *` factor entirely, still lands the
   * cannon within a few px of correct. On the mortar those mistakes are a WHOLE
   * TILE each and in different directions. Since the cannon and the mortar publish
   * the same cell and the same anchor, this test is the only thing separating "the
   * seat formula is right" from "the numbers happen to cancel".
   */
  it.skipIf(!atlasReady)('seats a 2×2 mortar by its footprint, not by the pack\'s visual one', async () => {
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);
    await rewardShards(db, p.wallet, 500_000n, 'test.fund.shards', k());
    await fundTestKeep(db, p.wallet, 500_000n, 'test.fund', k());
    // The mortar is Keep L3+ gated (STRUCTURES/DEFENSE costs, GDD §14) — the gate
    // reads players.keepLevel, so lift both it and the Keep's own level.
    await db.update(players).set({ keepLevel: 3 }).where(eq(players.wallet, p.wallet));
    await db.update(buildingsTable).set({ level: 3 })
      .where(and(eq(buildingsTable.playerWallet, p.wallet), eq(buildingsTable.type, 'keep' as never)));

    const sharp = (await import('sharp')).default;
    const raw = async (): Promise<{ data: Buffer; width: number; ch: number }> => {
      const png = await renderBasePng(db, p.wallet);
      const { data, info } = await sharp(png!).raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, ch: info.channels };
    };
    const before = await raw();
    await placeBuilding(db, p.wallet, 'mortar' as never, 10, 10, k());
    const after = await raw();
    const changed = ((): { x0: number; y0: number; x1: number; y1: number } => {
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      const h = before.data.length / (before.width * before.ch);
      for (let y = 0; y < h; y++) for (let x = 0; x < before.width; x++) {
        const i = (y * before.width + x) * before.ch;
        if (before.data[i] === after.data[i]
          && before.data[i + 1] === after.data[i + 1]
          && before.data[i + 2] === after.data[i + 2]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return { x0, y0, x1, y1 };
    })();
    expect(changed.x1, 'the mortar drew SOMETHING').toBeGreaterThan(0);

    const atlasDir = path.join(
      process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..'),
      'apps', 'web', 'public', 'atlas',
    );
    const sheet = JSON.parse(readFileSync(path.join(atlasDir, 'v2bld_mortar_t1@1x.json'), 'utf8')) as {
      textures: Array<{ frames: Array<{ filename: string; frame: { x: number; y: number; w: number; h: number } }> }>;
    };
    const cell = sheet.textures[0]!.frames
      .find((f) => f.filename === 'v2_bld_mortar_t1_idle_d0_f1')!.frame;
    const art = await sharp(path.join(atlasDir, 'v2bld_mortar_t1@1x.png'))
      .extract({ left: cell.x, top: cell.y, width: cell.w, height: cell.h })
      .raw().toBuffer({ resolveWithObject: true });
    let ax0 = Infinity, ay0 = Infinity, ax1 = -1, ay1 = -1;
    for (let y = 0; y < art.info.height; y++) for (let x = 0; x < art.info.width; x++) {
      if (art.data[(y * art.info.width + x) * art.info.channels + 3]! <= 8) continue;
      if (x < ax0) ax0 = x; if (x > ax1) ax1 = x;
      if (y < ay0) ay0 = y; if (y > ay1) ay1 = y;
    }
    // The anchor comes from the PACK (meta.json v2Clips), read the same way the
    // renderer reads it — nothing about the expected box is hand-typed except the
    // tile the mortar was placed on.
    const meta = JSON.parse(readFileSync(path.join(atlasDir, 'meta.json'), 'utf8')) as {
      v2Clips: Record<string, { cellW: number; cellH: number; anchorPx: [number, number] }>;
    };
    const idle = meta.v2Clips['v2_bld_mortar_t1_idle']!;
    const TILE = 32;
    const OX = 7 * TILE;                       // frame origin: (claim.min − margin)
    const [fw, fh] = DEFENSES.mortar.footprint; // 2×2 in the SIM/DB, not the pack's visual
    expect([fw, fh]).toEqual([2, 2]);
    expect({ w: cell.w, h: cell.h }, 'the packed cell is the cannon\'s cell')
      .toEqual({ w: idle.cellW, h: idle.cellH });
    // Same published world fit the base view applies — the Mortar is the tower
    // the owner reported as bigger than the Keep, and a deed that kept drawing
    // it native would show the very tower the base no longer does.
    const fit = ART_V2.buildingSourceScale.mortar;
    expect(fit).toBeLessThan(1);
    const width = Math.max(1, Math.round(cell.w * fit));
    const height = Math.max(1, Math.round(cell.h * fit));
    const fitted = await sharp(path.join(atlasDir, 'v2bld_mortar_t1@1x.png'))
      .extract({ left: cell.x, top: cell.y, width: cell.w, height: cell.h })
      .resize({ width, height, kernel: sharp.kernel.nearest })
      .raw().toBuffer({ resolveWithObject: true });
    let fx0 = Infinity, fy0 = Infinity, fx1 = -1, fy1 = -1;
    for (let y = 0; y < fitted.info.height; y++) for (let x = 0; x < fitted.info.width; x++) {
      if (fitted.data[(y * fitted.info.width + x) * fitted.info.channels + 3]! <= 8) continue;
      if (x < fx0) fx0 = x; if (x > fx1) fx1 = x;
      if (y < fy0) fy0 = y; if (y > fy1) fy1 = y;
    }
    expect(fx1 - fx0).toBeLessThan(ax1 - ax0);
    const left = Math.round(
      (10 + fw / 2) * TILE - (idle.anchorPx[0] / idle.cellW) * width,
    ) - OX;
    const top = Math.round((10 + fh) * TILE - height) - OX;
    expect(changed).toEqual({ x0: left + fx0, y0: top + fy0, x1: left + fx1, y1: top + fy1 });
    // The seat really does read the 2×2 GAME footprint — a tile further south
    // than the 1×1 cannon's, which is exactly what the cannon cannot show. And
    // the bottom edge lands ON the south edge, not a half-footprint north of it
    // (the old anchor-on-the-middle-row seat, 32 deed px higher, which is the
    // float the owner read off the selection box on 2026-08-30).
    expect(top + height, 'bottom edge on the south edge of the 2×2')
      .toBe((10 + fh) * TILE - OX);
    expect(top).toBe(Math.round((10 + 1) * TILE - height) - OX + TILE);
  });

  it('degrades to null (placeholder image) for a wallet with no player row', async () => {
    expect(await renderBasePng(db, 'nobody-here')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Verify-workflow regressions (2026-07-26): three confirmed findings, each
// pinned so it cannot silently return.
// ---------------------------------------------------------------------------
describe('verify-wf regressions', () => {
  it.skipIf(!atlasReady)('honors the meta.json anchor — a spiketrap lands where the GAME draws it', async () => {
    // The M22 trap replacement publishes a new non-default anchor. Derive the
    // expected opaque box from the generated frame + meta rather than retaining
    // the retired trap's [0,0] coordinates in this contract test.
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);
    await rewardShards(db, p.wallet, 500_000n, 'test.fund.shards', k());
    await fundTestKeep(db, p.wallet, 500_000n, 'test.fund', k());

    const sharp = (await import('sharp')).default;
    const raw = async (): Promise<{ data: Buffer; width: number; ch: number }> => {
      const png = await renderBasePng(db, p.wallet);
      const { data, info } = await sharp(png!).raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, ch: info.channels };
    };
    const before = await raw();
    await placeBuilding(db, p.wallet, 'spiketrap' as never, 10, 10, k());
    const after = await raw();
    const changed = ((): { x0: number; y0: number; x1: number; y1: number } => {
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      const h = before.data.length / (before.width * before.ch);
      for (let y = 0; y < h; y++) for (let x = 0; x < before.width; x++) {
        const i = (y * before.width + x) * before.ch;
        if (before.data[i] === after.data[i]
          && before.data[i + 1] === after.data[i + 1]
          && before.data[i + 2] === after.data[i + 2]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return { x0, y0, x1, y1 };
    })();

    const atlasDir = path.join(
      process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..'),
      'apps', 'web', 'public', 'atlas',
    );
    const sheet = JSON.parse(readFileSync(path.join(atlasDir, 'bld@1x.json'), 'utf8')) as {
      textures: Array<{ frames: Array<{ filename: string; frame: { x: number; y: number; w: number; h: number } }> }>;
    };
    const frame = sheet.textures[0]!.frames
      .find((candidate) => candidate.filename === 'bld_spiketrap_l1')!.frame;
    const art = await sharp(path.join(atlasDir, 'bld@1x.png'))
      .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
      .raw().toBuffer({ resolveWithObject: true });
    let ax0 = Infinity, ay0 = Infinity, ax1 = -1, ay1 = -1;
    for (let y = 0; y < art.info.height; y++) for (let x = 0; x < art.info.width; x++) {
      if (art.data[(y * art.info.width + x) * art.info.channels + 3]! <= 8) continue;
      if (x < ax0) ax0 = x; if (x > ax1) ax1 = x;
      if (y < ay0) ay0 = y; if (y > ay1) ay1 = y;
    }
    const meta = JSON.parse(readFileSync(path.join(atlasDir, 'meta.json'), 'utf8')) as {
      sprites: Record<string, { anchor: [number, number]; footprint: [number, number] }>;
    };
    const trap = meta.sprites['bld_spiketrap_l1']!;
    const TILE = 32;
    const OX = 7 * TILE;
    // The anchor is what centres the trap on its tile — [0,0] on some trap
    // aliases, and hardcoding [0.5,1] here put them half a tile out (verify wf).
    // Vertically it sits like every other building: bottom edge on the south
    // edge. Its 0.773 anchor used to hang the art a fifth of its height BELOW
    // that edge, so a trap crossed the tile line the game draws it inside.
    const left = Math.round((10 + trap.footprint[0] / 2) * TILE - trap.anchor[0] * frame.w) - OX;
    const top = Math.round((10 + trap.footprint[1]) * TILE - frame.h) - OX;
    expect(changed).toEqual({ x0: left + ax0, y0: top + ay0, x1: left + ax1, y1: top + ay1 });
  });

  it('a restarted, render-less process must NOT revert published images to the placeholder', async () => {
    // Fresh deploy: atlases not generated (renderAvailable=false), in-memory
    // maps empty, but the bucket already holds deed/<wallet>.png from the
    // previous run. The boot sweep re-PUTs all JSON (maps empty) — it must keep
    // pointing at the published PNG via the DB-computable layout hash, not fall
    // back to the placeholder. The DB is shared across tests, so every
    // assertion is scoped to THIS wallet.
    const p = await deededPlayer();
    const lastPushed = new Map<string, string>();
    const lastImageHash = new Map<string, string>(); // empty = "just restarted"
    const puts: Array<{ key: string; body: string }> = [];
    const put: ObjectPutter = async (key, body) => { puts.push({ key, body: body.toString() }); };
    const headKeys: string[] = [];
    const head = async (key: string): Promise<boolean> => { headKeys.push(key); return true; };
    const pngKnown = new Map<string, boolean>();
    const opts = { publicBaseUrl: 'https://pub.test.r2.dev', lastImageHash, head, pngKnown, renderAvailable: false };

    await sweepDeedMetadata(db, put, lastPushed, opts);
    const json = puts.find((x) => x.key === `deed/${p.wallet}.json`);
    expect(json).toBeDefined();
    expect(json!.body).toContain(`https://pub.test.r2.dev/deed/${p.wallet}.png?v=`);
    expect(json!.body).not.toContain('pixelkingdomwars.com/deed.png'); // the placeholder
    expect(puts.some((x) => x.key === `deed/${p.wallet}.png`)).toBe(false); // no render happened

    // The probe is once-per-process-per-wallet, not once-per-sweep.
    await sweepDeedMetadata(db, put, lastPushed, opts);
    expect(headKeys.filter((k2) => k2 === `deed/${p.wallet}.png`).length).toBe(1);
  });

  it('a failing image leg never starves the JSON trait updates', async () => {
    const p = await deededPlayer();
    const cursor = `render-put-${p.wallet}-`;
    const deed = `${cursor}deed`;
    await db.update(players).set({ deedAssetId: deed }).where(eq(players.wallet, p.wallet));
    const lastPushed = new Map<string, string>();
    const lastImageHash = new Map<string, string>();
    const pngKeys: string[] = [];
    const jsonKeys: string[] = [];
    // PNG PUTs blow up every time (repeatable R2 rejection); JSON PUTs succeed.
    const put: ObjectPutter = async (key) => {
      if (key.endsWith('.png')) {
        pngKeys.push(key);
        throw new Error('R2 rejects this key');
      }
      jsonKeys.push(key);
    };
    // Render this deed, not every earlier suite's accumulated fixtures. Keep
    // the real PNG failure and JSON continuation within the normal deadline.
    const visited: string[] = [];
    await sweepDeedMetadata(db, put, lastPushed, {
      publicBaseUrl: 'https://pub.test.r2.dev', lastImageHash,
      after: cursor, limit: 1, onVisit: (assetId) => visited.push(assetId),
    });
    expect(visited).toEqual([deed]);
    expect(pngKeys).toEqual([`deed/${p.wallet}.png`]);
    // THE POINT: this wallet's JSON still published — traits are what wallets
    // display, and the old code let the image throw skip the JSON leg forever.
    expect(jsonKeys).toContain(`deed/${p.wallet}.json`);
    expect(jsonKeys).toContain(`deed/asset/${deed}.json`);
  });
});
