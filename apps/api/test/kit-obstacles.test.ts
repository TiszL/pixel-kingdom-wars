/** E-11 expansion obstacles (docs/REALM-KIT-PLAN.md E-11, D-173 expansion obstacles).
 * WHY: the owner asked why the trees an expansion reaches are "not interactive like
 * in-base trees", and wants the world to look the same before and after the purchase.
 * On revision-5 ground GET /base seats a kit prop as a server obstacle row of the tier
 * the shared rule names THE MOMENT the shared hide rule (claim plus its one-tile edge
 * ring, realmKitPlacementHidden) stops every surface drawing the prop — row iff hidden —
 * so a tree on the claim edge never vanishes for one expansion tier and grows back at
 * the next (the claim grows two tiles a tier past 26; the ring is one). Ownership is the
 * clear flow's gate, as for the plot's own deploy-ring rows: a row on the ring or a 2×2
 * tree straddling the claim edge stands but refuses to clear until the land is bought.
 * Every pin here also guards the faucet: a seat yields ONE row for the life of the base
 * (re-reads, races and cleared tombstones never mint another) and props on the plot or
 * beyond the ring seat nothing. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CAPS, GRID, OBSTACLES } from '@shardkeep/shared';
import type { LayeredGroundDescriptor } from '@shardkeep/shared/layeredGroundCatalogue';
import { realmKitPlacementHidden, realmKitPlacementSeat, type RealmKitManifest, type RealmKitPlacement } from '@shardkeep/shared/realmKit';
import { realmKitObstacleKindFor, realmKitObstacleSeat } from '@shardkeep/shared/realmKitObstacles';
import { realmKitFixture, realmKitFixturePixels } from '../../../packages/shared/src/realmKit.fixture';
import { bases, buildings, obstacles } from '../src/db/schema';
import { clearObstacle, completeDueJobs, ensureStartingBase, getBaseState } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { currentBaseVisualHere } from '../src/game/baseVisual';
import { claimRect } from '../src/game/footprints';
import { kitObstacleCandidates, syncKitObstacles } from '../src/game/kitObstacles';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const fixture = vi.hoisted(() => ({ descriptor: undefined as LayeredGroundDescriptor | undefined }));
vi.mock('../src/game/realmKitCatalogue', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/game/realmKitCatalogue')>();
  return { ...actual, realmKitDescriptor: (context: Parameters<typeof actual.realmKitDescriptor>[0]) =>
    actual.realmKitDescriptorFrom(fixture.descriptor ? { crownlands: fixture.descriptor } : {}, context) };
});
const originalRoot = process.env['REPO_ROOT'], originalPreview = process.env['REALM_KIT_PREVIEW_REALMS'], roots: string[] = [];
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `kit-obs-${++key}-${Math.random().toString(36).slice(2)}`;
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });
afterEach(async () => {
  if (originalRoot === undefined) delete process.env['REPO_ROOT']; else process.env['REPO_ROOT'] = originalRoot;
  if (originalPreview === undefined) delete process.env['REALM_KIT_PREVIEW_REALMS']; else process.env['REALM_KIT_PREVIEW_REALMS'] = originalPreview;
  fixture.descriptor = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A fixture oak-sheet placement seated on (tx, ty): 1-wide props anchor at tx·32+16,
 * 2-wide at (tx)·32 (the seat is the right-hand tile), bottom on the footprint's south edge. */
function seated(id: string, tx: number, ty: number, extra: Partial<RealmKitPlacement> = {}): RealmKitPlacement {
  const [w] = extra.footprint ?? [1, 1];
  return { id, asset: 'oak', x: (tx - Math.floor(w / 2)) * 32 + Math.floor(w * 32 / 2), y: (ty + 1) * 32, width: 32, height: 48,
    layer: 1, phaseFrame: 0, animated: false, interactive: false, ...extra };
}
/** The fixture kit plus the props this suite reasons about (all outside the smallest
 * kingdom's ring, so the validator admits them; only 'plot-oak' sits on the legacy plot,
 * which the builder would refuse but a hand-made manifest can carry). */
function extraProps(m: RealmKitManifest): void {
  m.placements.push(
    seated('bush-east', 31, 10, { layer: 0 }),           // 1×1 low → bush (small)
    seated('oak-west', -1, 5),                             // 1×1 tall → parity pine (medium), west of the plot
    seated('hero-oak-east', 32, 20, { footprint: [2, 2] }), // 2×2 tall → tree_old (large), row at (31,19)
    seated('hero-oak-edge', -4, 25, { footprint: [2, 2] }), // 2×2 whose left column (−5) is the ring of a [-4,34) claim
    seated('plot-oak', 2, 2),                              // seated on the legacy plot: never a row
  );
}
/** Publish the shared synthetic kit the way the builder would (realm-kit-render.test.ts). */
async function publish(mutate: (m: RealmKitManifest) => void = extraProps, status: RealmKitManifest['status'] = 'accepted') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pkw-kit-obs-')); roots.push(root);
  process.env['REPO_ROOT'] = root;
  const publicRoot = path.join(root, 'apps/web/public');
  const manifest = realmKitFixture();
  mutate(manifest);
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
  process.env['REALM_KIT_PREVIEW_REALMS'] = 'crownlands';
  return manifest;
}
async function readyBase() {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await ensureWalletBaseIdentity(db, p.wallet);
  const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, p.wallet));
  await rewardBaseShards(db, base!.id, 100_000n, 'test.fund.base-shards', k());
  return { wallet: p.wallet, baseId: base!.id };
}
const expand = (baseId: string, expansions: number) => db.update(bases).set({ expansions }).where(eq(bases.id, baseId));
/** Rows off the legacy plot: only the kit can seat those. */
const offPlot = or(sql`${obstacles.tx} < 0`, sql`${obstacles.tx} >= ${GRID.plotTiles}`, sql`${obstacles.ty} < 0`, sql`${obstacles.ty} >= ${GRID.plotTiles}`);
const kitRows = (baseId: string) => db.select().from(obstacles).where(and(eq(obstacles.baseId, baseId), offPlot)).orderBy(obstacles.tx, obstacles.ty);
const tierOf = (spriteKey: string) => Object.values(OBSTACLES.tiers).find(t => (t.kinds as readonly string[]).includes(spriteKey))!;

describe('E-11 expansion obstacles on GET /base', () => {
  it('seats a row the moment the claim or its ring hides a kit prop — same species, tier by the shared rule — and nothing for the plot or beyond the ring', async () => {
    const manifest = await publish();
    const { wallet, baseId } = await readyBase();
    const plotRows = (await db.select().from(obstacles).where(eq(obstacles.baseId, baseId))).length;
    expect(plotRows).toBe(189);
    const byId = new Map(manifest.placements.map(p => [p.id, p]));
    const kind = (id: string) => realmKitObstacleKindFor(manifest, byId.get(id)!);
    // Six expansions: claim [2,28), ring [1,29) — every kit prop is still drawn, so no row.
    await expand(baseId, 6);
    expect(claimRect(6)).toEqual({ min: 2, max: 28 });
    await getBaseState(db, wallet, new Date(), baseId);
    expect(await kitRows(baseId)).toEqual([]);
    // Seven: claim [0,30), ring [-1,31). The frame oak on (30,15) and the west oak on (-1,5) are
    // in the RING: every surface stops drawing them now, so the rows must exist NOW — the same
    // tree keeps standing, as a row. 31 and 32 are beyond the ring; (2,2) is the plot's land.
    await expand(baseId, 7);
    expect(claimRect(7)).toEqual({ min: 0, max: 30 });
    await getBaseState(db, wallet, new Date(), baseId);
    const ring = await kitRows(baseId);
    expect(ring.map(r => [r.spriteKey, r.tx, r.ty])).toEqual([[kind('oak-west'), -1, 5], [kind('oak-frame-east'), 30, 15]]);
    expect(ring.map(r => r.spriteKey)).toEqual(['pine1', 'pine2']);
    for (const id of ['oak-west', 'oak-frame-east']) expect(realmKitPlacementHidden(byId.get(id)!, claimRect(7)), id).toBe(true);
    // A ring row stands on land the player does not own: drawn, tappable, refused — never a
    // gap in the woods, never a reward for unbought land.
    await expect(clearObstacle(db, wallet, ring[1]!.id, k(), new Date(), baseId)).rejects.toThrow('expand your land to clear this');
    // Eight: claim [-2,32), ring [-3,33). Seats 30/31/-1 are owned; the bush on (31,10) seats; the
    // 2×2 hero oak seated on (32,20) is in the ring, so its tree_old row at (31,19) exists although
    // tile 32 is not owned yet. The edge oak on (-4,25) is beyond the ring: still drawn, no row.
    await expand(baseId, 8);
    const state = await getBaseState(db, wallet, new Date(), baseId);
    const rows = await kitRows(baseId);
    expect(rows.map(r => [r.spriteKey, r.tx, r.ty])).toEqual([
      [kind('oak-west'), -1, 5], [kind('oak-frame-east'), 30, 15], [kind('bush-east'), 31, 10], [kind('hero-oak-east'), 31, 19]]);
    expect(rows.map(r => r.spriteKey)).toEqual(['pine1', 'pine2', 'bush', 'tree_old']);
    // Each row stands exactly on its prop's seat, the same tile the client hides the prop on.
    for (const id of ['oak-west', 'oak-frame-east', 'bush-east', 'hero-oak-east']) {
      const seat = realmKitPlacementSeat(byId.get(id)!);
      expect(rows.some(r => { const s = realmKitObstacleSeat(r.spriteKey, r.tx, r.ty); return s.tx === seat.tx && s.ty === seat.ty; }), id).toBe(true);
    }
    // GET /base lists them with the plot's rows: the client's ordinary tap-to-clear targets.
    expect(state.obstacles.filter(o => o.tx < 0 || o.tx >= GRID.plotTiles)).toHaveLength(4);
    expect((await db.select().from(obstacles).where(eq(obstacles.baseId, baseId))).length).toBe(plotRows + 4);
    const straddling = rows.find(r => r.spriteKey === 'tree_old')!;
    await expect(clearObstacle(db, wallet, straddling.id, k(), new Date(), baseId)).rejects.toThrow('expand your land to clear this');
    // Nine: claim [-4,34), ring [-5,35). The edge oak seated on (-4,25) is hidden now, so its
    // tree_old row at (-5,24) exists although tile −5 is the ring; the hero oak's whole rect
    // (31..32) is owned, so the row that was refused a tier ago clears through the plot's flow.
    await expand(baseId, 9);
    await getBaseState(db, wallet, new Date(), baseId);
    const grown = await kitRows(baseId);
    expect(grown.map(r => [r.spriteKey, r.tx, r.ty])).toEqual([
      ['tree_old', -5, 24], ['pine1', -1, 5], ['pine2', 30, 15], ['bush', 31, 10], ['tree_old', 31, 19]]);
    expect(kitObstacleCandidates(manifest, 9).map(c => c.spriteKey).sort()).toEqual(['bush', 'pine1', 'pine2', 'tree_old', 'tree_old']);
    await expect(clearObstacle(db, wallet, grown.find(r => r.tx === -5)!.id, k(), new Date(), baseId)).rejects.toThrow('expand your land to clear this');
    await expect(clearObstacle(db, wallet, straddling.id, k(), new Date(), baseId)).resolves.toMatchObject({ obstacleId: straddling.id });
    // Twelve ([-10,40)): the same five rows, one per seat; the plot-seated oak still never becomes a row.
    await expand(baseId, 12);
    await getBaseState(db, wallet, new Date(), baseId);
    const full = await kitRows(baseId);
    expect(full.some(r => r.tx === 2 && r.ty === 2)).toBe(false);
    expect(full.map(r => [r.spriteKey, r.tx, r.ty])).toEqual([['tree_old', -5, 24], ['pine1', -1, 5], ['pine2', 30, 15], ['bush', 31, 10], ['tree_old', 31, 19]]);
  });

  it('seats a candidate row on a seat exactly when the shared rule hides the prop, at every expansion tier (row iff hidden)', () => {
    // WHY: the clients hide a prop once its seat is inside the claim PLUS the ring, while a
    // row used to need the seat (and the whole rect) inside the claim alone. With the claim
    // growing two tiles a tier and the ring one, every prop on the claim edge vanished for a
    // tier and grew back as a row — 90 of Crownlands' 170 mapping props. The API asks the one
    // function the surfaces ask, so the two sets can never drift again.
    const manifest = realmKitFixture();
    extraProps(manifest);
    const onPlot = (t: { tx: number; ty: number }) => t.tx >= 0 && t.tx < GRID.plotTiles && t.ty >= 0 && t.ty < GRID.plotTiles;
    let seatedSomewhere = 0;
    for (let expansions = 0; expansions < CAPS.claimTilesByExpansion.length; expansions++) {
      const claim = claimRect(expansions), candidates = kitObstacleCandidates(manifest, expansions);
      const seats = candidates.map(c => realmKitObstacleSeat(c.spriteKey, c.tx, c.ty));
      expect(new Set(seats.map(s => `${s.tx},${s.ty}`)).size, 'one row per seat').toBe(candidates.length);
      for (const p of manifest.placements) {
        const seat = realmKitPlacementSeat(p);
        const expected = realmKitPlacementHidden(p, claim) && !onPlot(seat) && realmKitObstacleKindFor(manifest, p) !== undefined;
        const actual = seats.some(s => s.tx === seat.tx && s.ty === seat.ty);
        expect(actual, `${p.id} seat (${seat.tx},${seat.ty}) at ${expansions} expansions ${JSON.stringify(claim)}`).toBe(expected);
        if (actual) seatedSomewhere++;
      }
    }
    // The pins above are not vacuous: the fixture's ring seats and straddling 2×2 oaks do map.
    expect(seatedSomewhere).toBeGreaterThan(0);
    expect(kitObstacleCandidates(manifest, 7).map(c => c.tx)).toEqual(expect.arrayContaining([-1, 30]));
    expect(kitObstacleCandidates(manifest, 9)).toEqual(expect.arrayContaining([{ spriteKey: 'tree_old', tx: -5, ty: 24 }]));
  });

  it('is idempotent across re-reads and never recreates a row the player cleared — the tombstone is the faucet guard', async () => {
    await publish();
    const { wallet, baseId } = await readyBase();
    await expand(baseId, 8);
    await getBaseState(db, wallet, new Date(), baseId);
    await getBaseState(db, wallet, new Date(), baseId);
    const rows = await kitRows(baseId);
    expect(rows).toHaveLength(4);
    // Clear the frame oak through the plot's own flow: tier cost now, +15 on completion, row tombstoned.
    const oak = rows.find(r => r.tx === 30 && r.ty === 15)!, tier = tierOf(oak.spriteKey), t0 = new Date();
    const before = await getBaseShardBalance(db, baseId);
    await clearObstacle(db, wallet, oak.id, k(), t0, baseId);
    expect(await getBaseShardBalance(db, baseId)).toBe(before - BigInt(tier.costKeep));
    const done = new Date(t0.getTime() + tier.clearSec * 1000 + 1000);
    await completeDueJobs(db, wallet, done, baseId);
    expect(await getBaseShardBalance(db, baseId)).toBe(before - BigInt(tier.costKeep) + BigInt(OBSTACLES.clearRewardShards));
    const cleared = await getBaseState(db, wallet, done, baseId);
    expect(cleared.obstacles.some(o => o.id === oak.id)).toBe(false);
    expect(cleared.clearedObstacles).toEqual([{ spriteKey: oak.spriteKey, tx: 30, ty: 15, clearedAt: done }]);
    // Re-reads, and a larger claim, seat nothing new on (30,15): one row per seat for the life of the base.
    await getBaseState(db, wallet, done, baseId);
    await expand(baseId, 12);
    await getBaseState(db, wallet, done, baseId);
    const at = await db.select().from(obstacles).where(and(eq(obstacles.baseId, baseId), eq(obstacles.tx, 30), eq(obstacles.ty, 15)));
    expect(at).toHaveLength(1); expect(at[0]!.id).toBe(oak.id); expect(at[0]!.clearedAt).not.toBeNull();
    // A wholesale tombstone (abandon/transfer semantics) is honoured the same way.
    const bush = (await kitRows(baseId)).find(r => r.spriteKey === 'bush')!;
    await db.update(obstacles).set({ clearedAt: done }).where(and(eq(obstacles.id, bush.id), isNull(obstacles.clearedAt)));
    await getBaseState(db, wallet, done, baseId);
    expect(await db.select().from(obstacles).where(and(eq(obstacles.baseId, baseId), eq(obstacles.tx, bush.tx), eq(obstacles.ty, bush.ty)))).toHaveLength(1);
  });

  it('inserts one row per seat when two syncs race, and never touches the plot\'s own rows', async () => {
    await publish();
    const { wallet, baseId } = await readyBase();
    await expand(baseId, 8);
    const plotBefore = await db.select().from(obstacles).where(and(eq(obstacles.baseId, baseId), sql`not (${offPlot})`)).orderBy(obstacles.tx, obstacles.ty);
    const context = currentBaseVisualHere('crownlands');
    expect(context.groundRevision).toBe(5);
    const inserted = await Promise.all(Array.from({ length: 4 }, () => syncKitObstacles(db, wallet, 8, context, baseId)));
    expect(inserted.reduce((n, v) => n + v, 0)).toBe(4);
    expect(inserted.filter(v => v === 4)).toHaveLength(1);
    expect(await kitRows(baseId)).toHaveLength(4);
    const plotAfter = await db.select().from(obstacles).where(and(eq(obstacles.baseId, baseId), sql`not (${offPlot})`)).orderBy(obstacles.tx, obstacles.ty);
    expect(plotAfter).toEqual(plotBefore);
    expect(await syncKitObstacles(db, wallet, 8, context, baseId)).toBe(0);
  });

  it('seats nothing below revision 5, for an unpublished or preview-only kit, or under a building already standing on the tile', async () => {
    const { wallet, baseId } = await readyBase();
    await expand(baseId, 8);
    // Since the owner flip (D-184) every host presents revision 5, so a below-5 context can
    // only be a frozen (stored) visual: the seat guard is exercised with one directly — kit
    // rows must never be seated under revision-4 scenery, whatever the host presents.
    delete process.env['REALM_KIT_PREVIEW_REALMS'];
    expect(currentBaseVisualHere('crownlands').groundRevision).toBe(5);
    expect(await syncKitObstacles(db, wallet, 8, { ...currentBaseVisualHere('crownlands'), groundRevision: 4 }, baseId)).toBe(0);
    expect(await kitRows(baseId)).toEqual([]);
    // Revision 5 without a published kit: nothing to seat, and no error on the base read.
    process.env['REALM_KIT_PREVIEW_REALMS'] = 'crownlands';
    await getBaseState(db, wallet, new Date(), baseId);
    expect(await kitRows(baseId)).toEqual([]);
    // A preview-only kit shows no one its trees, so it seats no rows.
    await publish(extraProps, 'preview-only');
    await getBaseState(db, wallet, new Date(), baseId);
    expect(await kitRows(baseId)).toEqual([]);
    // Accepted kit, but a wall already stands on the bush's tile: that seat is skipped, the others are seated.
    await publish();
    await db.insert(buildings).values({ playerWallet: wallet, baseId, type: 'wall', level: 1, tx: 31, ty: 10 });
    await getBaseState(db, wallet, new Date(), baseId);
    expect((await kitRows(baseId)).map(r => [r.spriteKey, r.tx, r.ty])).toEqual([['pine1', -1, 5], ['pine2', 30, 15], ['tree_old', 31, 19]]);
  });
});
