/**
 * Deed renderer × Phase E Market art (C3): the ordinary `pe_market_t<T>` body
 * and the bound Artisan Awning from `pe_cosmetics`, drawn from the SAME
 * generated atlases the web client ships, at this renderer's density (32 px
 * tiles = half the 64 px web tile) on the same bottom-edge seat.
 *
 * The projection to draw is either the frozen fifth argument (used as-is,
 * today's preference never re-read) or root's current-base read. A base with
 * a completed Market whose projection is unavailable/refused, or whose Market
 * art is not generated, gets NO image (null) — never a picture asserting an
 * appearance nobody verified, and never a silently Market-less base.
 *
 * Runs on an owned disposable database (root's 0280/0281 SQL applied by the
 * migrator); skips loudly when the generated atlases are absent.
 */
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STRUCTURES, atlasGroupFor } from '@shardkeep/shared';
import type { BoundCosmeticBaseRead } from '@shardkeep/shared/boundCosmeticVisual';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { baseSlots, builderJobs, buildings as buildingsTable } from '../src/db/schema';
import {
  baseRenderAvailable, baseRenderAwningBinding, baseRenderMarketArtAvailable, baseRenderServiceArtAvailable, renderBasePng,
} from '../src/game/baseRender';
import { readBoundCosmeticBase } from '../src/game/boundCosmeticPresentation';
import { BLUEPRINT_TEST_FLAGS } from './fixtures/boundCosmeticBlueprint';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';

const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
const atlasDir = path.join(repoRoot, 'apps', 'web', 'public', 'atlas');
const evidenceDir = path.join(repoRoot, 'docs', 'evidence', '2026-09-30-bound-cosmetic-visuals');
const fixture = JSON.parse(readFileSync(path.join(evidenceDir, 'actual-presentation.fixture.json'), 'utf8')) as {
  currentBase: { boundCosmetics: { state: 'available'; visual: { version: 1; marketAwnings: Array<{ buildingId: string; appearance: Record<string, unknown> }> } } };
};
/** The actual API appearance for the tier-1 Awning, re-pointed at OUR Market row. */
const awningT1 = fixture.currentBase.boundCosmetics.visual.marketAwnings[0]!.appearance;
const available = (marketAwnings: Array<{ buildingId: string; appearance: Record<string, unknown> }>): BoundCosmeticBaseRead =>
  ({ state: 'available', visual: { version: 1, marketAwnings } }) as BoundCosmeticBaseRead;

const atlasReady = baseRenderAvailable();
// The starter fixture base owns a Lodge (test/fixtures/starterExpeditions.ts), so the
// deed needs the validated Workshop/Lodge set for EVERY picture of it (P5 rule):
// without the generated service groups this whole file is skipped like the rest of
// the generated-art gates, not failed one Market case at a time.
const serviceReady = baseRenderServiceArtAvailable();
const DEED_TILE = 32;
const DEED_FRAME_ORIGIN_TILE = 7; // claim min 8 minus the renderer's one-tile margin
const MARKET_DEED_SCALE = 0.5;    // 112 px cell authored at the web's 64 px tile

interface Crop {
  buf: Buffer; width: number; height: number; anchorX: number;
  /** Authored contact row (sourcePivot y) at deed density, zero-based. */
  contactY: number;
  opaque: { x0: number; y0: number; x1: number; y1: number };
}

/** The exact packed cell, cut and resized the way the renderer must (nearest). */
async function marketCrop(key: string): Promise<Crop> {
  const sharp = (await import('sharp')).default;
  const group = atlasGroupFor(key);
  const sheet = JSON.parse(readFileSync(path.join(atlasDir, `${group}@1x.json`), 'utf8')) as {
    textures: Array<{ frames: Array<{ filename: string; frame: { x: number; y: number; w: number; h: number } }> }>;
  };
  const meta = JSON.parse(readFileSync(path.join(atlasDir, 'meta.json'), 'utf8')) as {
    peMarket: { clips: Record<string, { cellW: number; cellH: number; anchorPx: [number, number]; sourcePivot: [number, number] }> };
    peCosmetics: { clips: Record<string, { cellW: number; cellH: number; anchorPx: [number, number]; sourcePivot: [number, number] }> };
    peServiceBuildings?: { clips: Record<string, { cellW: number; cellH: number; anchorPx: [number, number]; sourcePivot: [number, number] }> };
  };
  const frame = sheet.textures[0]!.frames.find((f) => f.filename === key)?.frame;
  const clipId = key.replace(/_f\d+$/, '');
  const clip = meta.peMarket.clips[clipId] ?? meta.peCosmetics.clips[clipId] ?? meta.peServiceBuildings?.clips[clipId];
  if (!frame || !clip) throw new Error(`missing generated Market fixture for ${key}`);
  expect([frame.w, frame.h], 'the packed cell is the authored 112 cell').toEqual([clip.cellW, clip.cellH]);
  const width = Math.round(frame.w * MARKET_DEED_SCALE);
  const height = Math.round(frame.h * MARKET_DEED_SCALE);
  const buf = await sharp(path.join(atlasDir, `${group}@1x.png`))
    .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
    .png().toBuffer()
    .then((native) => sharp(native).resize({ width, height, kernel: sharp.kernel.nearest }).png().toBuffer());
  const art = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < art.info.height; y++) for (let x = 0; x < art.info.width; x++) {
    if (art.data[(y * art.info.width + x) * art.info.channels + 3]! <= 8) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error(`generated Market fixture is transparent: ${key}`);
  expect(clip.anchorPx, 'full-cell bottom-centre anchor').toEqual([clip.cellW / 2, clip.cellH]);
  return {
    buf, width, height, anchorX: clip.anchorPx[0] / clip.cellW,
    contactY: Math.round(clip.sourcePivot[1] * MARKET_DEED_SCALE) - 1,
    opaque: { x0, y0, x1, y1 },
  };
}

/** apps/web game/v2/clips.ts#buildingSeatY at deed density: bottom edge on the
 *  footprint's south edge; the anchor only decides the horizontal centre. */
function seat(tx: number, ty: number, art: Crop): { left: number; top: number } {
  const [fw, fh] = STRUCTURES.market.footprint;
  const origin = DEED_FRAME_ORIGIN_TILE * DEED_TILE;
  return {
    left: Math.round((tx + fw / 2) * DEED_TILE - art.anchorX * art.width) - origin,
    top: Math.round((ty + fh) * DEED_TILE - art.height) - origin,
  };
}

async function raw(png: Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(png).raw().toBuffer();
}

async function expectComposite(actual: Buffer, before: Buffer, key: string, tx: number, ty: number, label: string, contactSlack = 0): Promise<void> {
  const sharp = (await import('sharp')).default;
  const art = await marketCrop(key);
  const { left, top } = seat(tx, ty, art);
  const expected = await sharp(before).composite([{ input: art.buf, left, top }]).png().toBuffer();
  expect((await raw(actual)).equals(await raw(expected)), label).toBe(true);
  // Source pixel/contact geometry: the half-density body stays inside its 2×2
  // tiles horizontally; the full cell's bottom sits on the south edge and the
  // authored contact pivot (sourcePivot row 104 of 112 → 52 at 0.5) is where
  // the opaque body ends — preserved, never applied as a seat correction.
  const footprintLeft = (tx - DEED_FRAME_ORIGIN_TILE) * DEED_TILE;
  const footprintBottom = (ty - DEED_FRAME_ORIGIN_TILE + STRUCTURES.market.footprint[1]) * DEED_TILE - 1;
  expect(left + art.opaque.x0).toBeGreaterThanOrEqual(footprintLeft);
  expect(left + art.opaque.x1).toBeLessThanOrEqual(footprintLeft + STRUCTURES.market.footprint[0] * DEED_TILE - 1);
  expect(top + art.height - 1, 'the full cell bottom is the south edge').toBe(footprintBottom);
  expect(top + art.opaque.y1, 'the opaque body ends on the authored contact row').toBeGreaterThanOrEqual(top + art.contactY - contactSlack);
  expect(top + art.opaque.y1, 'the opaque body never passes the authored contact row').toBeLessThanOrEqual(top + art.contactY);
  expect(top + art.opaque.y1).toBeLessThanOrEqual(footprintBottom);
}

describe.skipIf(!atlasReady || !serviceReady)('deed renderer: Phase E Market and Awning', () => {
  const conn = resourceClaimsDatabase();
  let wallet: string, baseId: string, marketId: string, before: Buffer;
  const tx = 12, ty = 12;

  beforeAll(async () => {
    for (const flag of BLUEPRINT_TEST_FLAGS) vi.stubEnv(flag, 'true');
    await conn.setup();
    const f = await createStarterExpeditionFixture(conn.db);
    wallet = f.wallet; baseId = f.baseId;
    const png = await renderBasePng(conn.db, wallet, baseId);
    if (!png) throw new Error('generated atlases unexpectedly unavailable');
    before = png;
  }, 300_000);
  afterAll(async () => { vi.unstubAllEnvs(); await conn.close(); }, 120_000);

  async function placeMarket(level: number, completed = true): Promise<void> {
    const [row] = await conn.db.insert(buildingsTable)
      .values({ playerWallet: wallet, baseId, type: 'market' as never, level, tx, ty }).returning();
    marketId = row!.id;
    const finishesAt = new Date('2035-01-01T00:00:00.000Z');
    await conn.db.insert(builderJobs).values({
      playerWallet: wallet, baseId, buildingId: marketId, kind: 'build',
      startedAt: new Date(finishesAt.getTime() - 60_000), finishesAt,
      completedAt: completed ? finishesAt : null,
    });
  }

  it('refuses a Market deed while the Phase E groups are absent, instead of a silently Market-less picture', async () => {
    // A sibling atlas dir with every generated file EXCEPT the pe_* groups.
    const partial = mkdtempSync(path.join(os.tmpdir(), 'pkw-c3-partial-atlas-'));
    mkdirSync(path.join(partial, 'apps', 'web', 'public', 'atlas'), { recursive: true });
    for (const file of readdirSync(atlasDir)) {
      if (file.startsWith('pe_')) continue;
      symlinkSync(path.join(atlasDir, file), path.join(partial, 'apps', 'web', 'public', 'atlas', file));
    }
    await placeMarket(1);
    vi.stubEnv('REPO_ROOT', partial);
    try {
      expect(baseRenderMarketArtAvailable(), 'readiness is false while the groups are absent').toBe(false);
      expect(baseRenderAwningBinding('artisan_market_awning_t1')).toBeNull();
      expect(await renderBasePng(conn.db, wallet, baseId)).toBeNull();
    } finally {
      vi.stubEnv('REPO_ROOT', repoRoot);
    }
    // The generated set recovers without a restart, and the readiness seam
    // reports exactly the bindings the deed will accept.
    expect(baseRenderMarketArtAvailable()).toBe(true);
    expect(baseRenderAwningBinding('artisan_market_awning_t1')).toEqual({
      sha256: awningT1['bindingSha256'], sourceManifestSha256: awningT1['sourceManifestSha256'], sourceIndexSha256: awningT1['sourceIndexSha256'],
    });
    for (const tier of [2, 3, 4]) expect(baseRenderAwningBinding(`artisan_market_awning_t${tier}`)?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(baseRenderAwningBinding('aurora_wake'), 'the wake has no delivered consumer here: never reported admitted').toBeNull();
    expect(baseRenderAwningBinding('artisan_market_awning_t9')).toBeNull();
  }, 120_000);

  it('draws the ordinary tier body at half density on the bottom-edge seat from the current verified-empty projection', async () => {
    expect(await readBoundCosmeticBase(conn.db, baseId, wallet)).toEqual({ state: 'available', visual: { version: 1, marketAwnings: [] } });
    const png = await renderBasePng(conn.db, wallet, baseId);
    expect(png).not.toBeNull();
    await expectComposite(png!, before, 'pe_market_t1_idle_f1', tx, ty, 'ordinary L1 Market = pe_market_t1 idle at 0.5 on the south edge');
  }, 120_000);

  it('draws the frozen Awning exactly as supplied, at the same seat, and keeps drawing it after the current read turns unavailable', async () => {
    const frozen = available([{ buildingId: marketId, appearance: awningT1 }]);
    const withAwning = await renderBasePng(conn.db, wallet, baseId, undefined, frozen);
    expect(withAwning).not.toBeNull();
    await expectComposite(withAwning!, before, 'pe_cos_market_t1_idle_f1', tx, ty, 'frozen tier-1 Awning = pe_cos_market_t1 idle at 0.5 on the south edge');
    const ordinary = await renderBasePng(conn.db, wallet, baseId);
    expect(withAwning!.equals(ordinary!), 'the Awning and ordinary bodies differ').toBe(false);
    // The current projection changes (the slot is no longer active → unavailable);
    // the frozen argument is used as-is and the current path refuses an image.
    await conn.db.update(baseSlots).set({ active: false }).where(and(eq(baseSlots.baseId, baseId), eq(baseSlots.wallet, wallet)));
    try {
      expect(await readBoundCosmeticBase(conn.db, baseId, wallet)).toEqual({ state: 'unavailable', visual: null });
      expect(await renderBasePng(conn.db, wallet, baseId), 'unavailable + completed Market ⇒ no image').toBeNull();
      const stillFrozen = await renderBasePng(conn.db, wallet, baseId, undefined, frozen);
      expect(stillFrozen!.equals(withAwning!), 'the frozen raid keeps its captured Awning').toBe(true);
    } finally {
      await conn.db.update(baseSlots).set({ active: true }).where(and(eq(baseSlots.baseId, baseId), eq(baseSlots.wallet, wallet)));
    }
  }, 120_000);

  it.each([
    ['an explicit unavailable projection', { state: 'unavailable', visual: null }],
    ['an Awning for an unowned next tier on a level-1 Market', available([{ buildingId: '', appearance: { ...awningT1, outputId: 'artisan_market_awning_t2' } }])],
    ['a binding hash the generated art does not carry', available([{ buildingId: '', appearance: { ...awningT1, bindingSha256: 'f'.repeat(64) } }])],
    ['a source manifest hash from another asset build', available([{ buildingId: '', appearance: { ...awningT1, sourceManifestSha256: '0'.repeat(64) } }])],
    ['an Awning naming a building that is not this Market', available([{ buildingId: '00000000-0000-4000-8000-000000000000', appearance: awningT1 }])],
  ] as const)('refuses %s: no image rather than a falsely plain or falsely applied one', async (_label, projection) => {
    const frozen = JSON.parse(JSON.stringify(projection).replaceAll('"buildingId":""', `"buildingId":"${marketId}"`)) as BoundCosmeticBaseRead;
    expect(await renderBasePng(conn.db, wallet, baseId, undefined, frozen)).toBeNull();
  }, 120_000);

  it('keeps the verified-empty projection ordinary, and a Market under initial construction keeps its tier body', async () => {
    const frozenEmpty = available([]);
    const png = await renderBasePng(conn.db, wallet, baseId, undefined, frozenEmpty);
    await expectComposite(png!, before, 'pe_market_t1_idle_f1', tx, ty, 'known-empty ⇒ ordinary body');
    // A pending initial build: the Awning matcher would refuse an entry for it,
    // but an empty projection still draws the ordinary body like every building.
    await conn.db.update(builderJobs).set({ completedAt: null }).where(eq(builderJobs.buildingId, marketId));
    try {
      const pending = await renderBasePng(conn.db, wallet, baseId);
      await expectComposite(pending!, before, 'pe_market_t1_idle_f1', tx, ty, 'under construction ⇒ ordinary tier body');
      expect(await renderBasePng(conn.db, wallet, baseId, undefined, available([{ buildingId: marketId, appearance: awningT1 }])),
        'an Awning on an unfinished Market is refused').toBeNull();
    } finally {
      await conn.db.update(builderJobs).set({ completedAt: new Date('2035-01-01T00:00:00.000Z') }).where(eq(builderJobs.buildingId, marketId));
    }
  }, 120_000);

  it.each([[5, 1], [6, 2], [11, 3], [16, 4], [20, 4]])('maps completed level %i to visual tier %i for both families', async (level, tier) => {
    await conn.db.update(buildingsTable).set({ level }).where(eq(buildingsTable.id, marketId));
    const ordinary = await renderBasePng(conn.db, wallet, baseId);
    await expectComposite(ordinary!, before, `pe_market_t${tier}_idle_f1`, tx, ty, `L${level} ordinary ⇒ tier ${tier}`);
    // Exactly the generated binding for that tier: output, source, hashes.
    const meta = JSON.parse(readFileSync(path.join(atlasDir, 'meta.json'), 'utf8')) as {
      peCosmetics: { bindings: Record<string, { sha256: string; value: { sourceId: string; sourceManifestSha256: string; sourceIndexSha256: string } }> };
    };
    const binding = meta.peCosmetics.bindings[`artisan_market_awning_t${tier}`]!;
    const appearance = {
      version: 1, outputId: `artisan_market_awning_t${tier}`, sourceId: binding.value.sourceId,
      sourceManifestSha256: binding.value.sourceManifestSha256, sourceIndexSha256: binding.value.sourceIndexSha256,
      bindingSha256: binding.sha256,
    };
    if (tier === 1) expect(appearance, 'the fixture appearance IS the generated tier-1 binding').toEqual(awningT1);
    const awning = await renderBasePng(conn.db, wallet, baseId, undefined, available([{ buildingId: marketId, appearance }]));
    await expectComposite(awning!, before, `pe_cos_market_t${tier}_idle_f1`, tx, ty, `L${level} Awning ⇒ tier ${tier}`);
  }, 120_000);

  it('does not consult the projection for a base with no Market: an unavailable read still renders the plain base', async () => {
    await conn.db.delete(builderJobs).where(eq(builderJobs.buildingId, marketId));
    await conn.db.delete(buildingsTable).where(eq(buildingsTable.id, marketId));
    await conn.db.update(baseSlots).set({ active: false }).where(and(eq(baseSlots.baseId, baseId), eq(baseSlots.wallet, wallet)));
    try {
      expect(await readBoundCosmeticBase(conn.db, baseId, wallet)).toEqual({ state: 'unavailable', visual: null });
      const png = await renderBasePng(conn.db, wallet, baseId);
      expect(png).not.toBeNull();
      expect((await raw(png!)).equals(await raw(before)), 'identical to the pre-Market picture').toBe(true);
    } finally {
      await conn.db.update(baseSlots).set({ active: true }).where(and(eq(baseSlots.baseId, baseId), eq(baseSlots.wallet, wallet)));
    }
  }, 120_000);

  // ── P5: the ordinary Workshop and Lodge families (peServiceBuildings) ──────
  const serviceIds: string[] = [];
  const lodgeTx = 12, lodgeTy = 15; // the Lodge sits south of the Workshop, both 2×2 inside the claim
  async function placeService(type: 'workshop' | 'lodge', level: number, at: [number, number], completed = true): Promise<string> {
    const [row] = await conn.db.insert(buildingsTable)
      .values({ playerWallet: wallet, baseId, type: type as never, level, tx: at[0], ty: at[1] }).returning();
    const finishesAt = new Date('2035-01-01T00:00:00.000Z');
    await conn.db.insert(builderJobs).values({
      playerWallet: wallet, baseId, buildingId: row!.id, kind: 'build',
      startedAt: new Date(finishesAt.getTime() - 60_000), finishesAt, completedAt: completed ? finishesAt : null,
    });
    serviceIds.push(row!.id);
    return row!.id;
  }
  async function clearServices(): Promise<void> {
    for (const id of serviceIds.splice(0)) {
      await conn.db.delete(builderJobs).where(eq(builderJobs.buildingId, id));
      await conn.db.delete(buildingsTable).where(eq(buildingsTable.id, id));
    }
  }

  it('P5: refuses a Workshop/Lodge deed while the service groups are absent — the Market set stays admitted and readiness recovers without a restart', async () => {
    expect(STRUCTURES.workshop.footprint, 'the seat helper assumes the Market footprint').toEqual(STRUCTURES.market.footprint);
    expect(STRUCTURES.lodge.footprint).toEqual(STRUCTURES.market.footprint);
    // The starter fixture base already owns a Lodge (outside the claim, at 5,2), so the
    // service set is consulted for every render of this base: with the eight groups absent
    // the whole picture is refused rather than a silently Lodge-less/Workshop-less one.
    const partial = mkdtempSync(path.join(os.tmpdir(), 'pkw-p5-partial-atlas-'));
    mkdirSync(path.join(partial, 'apps', 'web', 'public', 'atlas'), { recursive: true });
    for (const file of readdirSync(atlasDir)) {
      if (/^pe_(workshop|lodge)_t[1-4]@/.test(file)) continue;
      symlinkSync(path.join(atlasDir, file), path.join(partial, 'apps', 'web', 'public', 'atlas', file));
    }
    await placeService('workshop', 1, [tx, ty]);
    vi.stubEnv('REPO_ROOT', partial);
    try {
      expect(baseRenderServiceArtAvailable(), 'service readiness is false while the eight groups are absent').toBe(false);
      expect(baseRenderMarketArtAvailable(), 'the Market/Awning set is independent of the service pack').toBe(true);
      expect(await renderBasePng(conn.db, wallet, baseId), 'a Workshop/Lodge the deed cannot draw refuses the picture').toBeNull();
    } finally {
      vi.stubEnv('REPO_ROOT', repoRoot);
      await clearServices();
    }
    expect(baseRenderServiceArtAvailable(), 'recovers without a restart').toBe(true);
    const plain = await renderBasePng(conn.db, wallet, baseId);
    expect((await raw(plain!)).equals(await raw(before)), 'back to the plain picture').toBe(true);
  }, 120_000);

  it('P5: draws a completed Workshop and Lodge as their family tier idle cells at half density on the same bottom-edge seat as the Market', async () => {
    try {
      await placeService('workshop', 1, [tx, ty]);
      const workshop = await renderBasePng(conn.db, wallet, baseId);
      expect(workshop).not.toBeNull();
      await expectComposite(workshop!, before, 'pe_workshop_t1_idle_f1', tx, ty, 'completed L1 Workshop = pe_workshop_t1 idle at 0.5 on the south edge');
      const lodgeId = await placeService('lodge', 6, [lodgeTx, lodgeTy]);
      const both = await renderBasePng(conn.db, wallet, baseId);
      // Measured art fact (P5 evidence): the authored Lodge tier-2 idle cell's last opaque row
      // is 103 of 112 like every other cell, but the nearest-neighbour 0.5 sample of that row
      // is transparent, so the half-density body ends one row above the contact row. The
      // renderer output is still pixel-identical to the expected composite.
      await expectComposite(both!, workshop!, 'pe_lodge_t2_idle_f1', lodgeTx, lodgeTy, 'completed L6 Lodge = pe_lodge_t2 idle over the Workshop picture', 1);
      // The Market tier rule is the families' rule: L20 ⇒ tier 4; the ordinary bld_* sheet is never consulted for either family.
      await conn.db.update(buildingsTable).set({ level: 20 }).where(eq(buildingsTable.id, lodgeId));
      const t4 = await renderBasePng(conn.db, wallet, baseId);
      await expectComposite(t4!, workshop!, 'pe_lodge_t4_idle_f1', lodgeTx, lodgeTy, 'L20 Lodge ⇒ tier 4');
    } finally {
      await clearServices();
    }
  }, 120_000);

  it('P5 D4: a Workshop under initial construction keeps its tier idle body, exactly as the Market deed does', async () => {
    try {
      await placeService('workshop', 1, [tx, ty], false);
      const building = await renderBasePng(conn.db, wallet, baseId);
      expect(building).not.toBeNull();
      await expectComposite(building!, before, 'pe_workshop_t1_idle_f1', tx, ty, 'constructing Workshop = the same tier-1 idle cell');
    } finally {
      await clearServices();
    }
    const plain = await renderBasePng(conn.db, wallet, baseId);
    expect((await raw(plain!)).equals(await raw(before)), 'back to the plain picture once the rows are gone').toBe(true);
  }, 120_000);
});
