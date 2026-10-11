/** Actual installed sources and custody; per-case painter spies prove ordering.
 * The final case restores the real accessor/painter and retains actual PNGs.
 * All chain/facility originals are explicit local synthetic fixtures, not live R2. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
import { BuildingType } from '@shardkeep/shared';
import { fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bases, baseSlots, buildings, obstacles, players } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger';
import * as painter from '../src/game/baseRender';
import * as capture from '../src/game/deedFleetCapture';
import { type CapturedDeedDrawing } from '../src/game/deedFleetCapture';
import { assertFreshLockedBaseAuthority, transferStableBase } from '../src/game/baseOwnership';
import { resolveBaseVisual } from '../src/game/baseVisual';
import { sweepDeedMetadata, type ObjectPutter } from '../src/game/deedR2';
import * as locations from '../src/game/fantasyLocationRead';
import { claimRect, footprintOf } from '../src/game/footprints';
import { installStarterFleet } from '../src/game/starterFleet';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { createVehicleServiceApplications } from '../src/game/vehicleServiceApplications';
import { ADMIN_DATABASE_URL } from './db-url';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceBuilding } from './fixtures/vehicleService';
import { vehicleServiceConsentFixture } from './fixtures/vehicleServicePreparation';

const databaseName = `p6broot_${randomUUID().replaceAll('-', '')}_test`;
const url = new URL(ADMIN_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('P6b fixture requires a local owned database');
url.pathname = `/${databaseName}`;
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
const connection = createDb(url.toString(), { max: 4 });
let created = false;
const conn = {
  ...connection,
  reopen: () => createDb(url.toString(), { max: 4 }),
  async setup() {
    await admin.unsafe(`create database ${databaseName}`);
    created = true;
    await runMigrations(connection.db);
    await bootstrapSystemAccounts(connection.db);
  },
  async close() {
    await connection.sql.end();
    try { if (created) await admin.unsafe(`drop database ${databaseName} with (force)`); }
    finally { await admin.end(); }
  },
};
const db = conn.db;
const evidence = process.env['P6B_ROOT_EVIDENCE_DIR'];
const ownedBases: string[] = [];
const ownedWallets: string[] = [];
const publicUrl = 'https://deed-p6b.invalid';
// Only ordering tests use this declared synthetic art identity. The real case
// obtains the admitted retained working set's fingerprint without a spy.
const orderingArt = 'ab'.repeat(32);

beforeAll(async () => {
  if (evidence) await mkdir(evidence, { recursive: true });
  await conn.setup();
  if (evidence) await writeFile(`${evidence}/database.json`, JSON.stringify({ databaseName, host: url.hostname, port: url.port, state: 'running-owned' }));
}, 180000);
afterAll(async () => {
  await conn.close();
  if (evidence) await writeFile(`${evidence}/database.json`, JSON.stringify({ databaseName, host: url.hostname, port: url.port, state: 'closed-owned-database-dropped' }));
});
beforeEach(() => {
  for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(flag, 'true');
  vi.stubEnv('FANTASY_WORLD_ENABLED', 'false');
  vi.stubEnv('DEV_LOGIN_REALM', '');
  vi.stubEnv('REALM_KIT_PREVIEW_REALMS', '');
  vi.stubEnv('DEED_IMAGE_URL', undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  // Only this suite's unique DB and rows: later cases must not sweep a prior
  // fixture. Keep originals intact; remove only their synthetic deed listing.
  if (ownedBases.length) await db.update(bases).set({ deedAssetId: null, deedMintAssetId: null, landPaidAt: null }).where(inArray(bases.id, ownedBases.splice(0)));
  if (ownedWallets.length) await db.update(players).set({ deedAssetId: null, entryPaidAt: null }).where(inArray(players.wallet, ownedWallets.splice(0)));
});

async function installed() {
  const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn });
  ownedBases.push(f.baseId);
  f.finalizeBurn();
  await createVehicleInstallations(db, { verifyBurn: f.reader.verify }).recover(f.actor, f.reservation.id);
  const berthId = await vehicleServiceBuilding(f, 'berth');
  const authority = { baseId: f.baseId, assertAuthority: async (...args: Parameters<typeof assertFreshLockedBaseAuthority>) => {
    await assertFreshLockedBaseAuthority(...args);
  } };
  const starter = await installStarterFleet(db, f.actor, berthId, authority);
  const claim = claimRect(0), berth = footprintOf(BuildingType.Berth);
  const advancedSeat = { tx: claim.min + 1, ty: claim.min + 2 };
  const starterSeat = { tx: advancedSeat.tx + berth.fw + 2, ty: advancedSeat.ty };
  expect(starterSeat.tx + berth.fw).toBeLessThanOrEqual(claim.max);
  await db.update(buildings).set(advancedSeat).where(eq(buildings.id, f.berthId));
  await db.update(buildings).set(starterSeat).where(eq(buildings.id, starter.berthId));
  return { ...f, starter, advancedSeat, starterSeat, deedAssetId: Keypair.generate().publicKey.toBase58() };
}
type Fixture = Awaited<ReturnType<typeof installed>>;
async function deed(f: Pick<Fixture, 'baseId' | 'deedAssetId'>) {
  await db.update(bases).set({ deedAssetId: f.deedAssetId, deedMintAssetId: f.deedAssetId, landPaidAt: new Date() }).where(eq(bases.id, f.baseId));
}
async function pendingUpgrade(f: Fixture) {
  const consent = await vehicleServiceConsentFixture(f);
  const prepared = await consent.preparations.prepare(f.actor, consent.intent.id);
  return async () => {
    consent.finalizeService(prepared);
    return createVehicleServiceApplications(db, { verifyBurn: consent.reader.verify }).recover(f.actor, consent.intent.id);
  };
}
function cache() {
  const puts = new Map<string, { body: string | Buffer; contentType: string | undefined }>();
  const lastPushed = new Map<string, string>(), lastImageHash = new Map<string, string>(), pngKnown = new Map<string, boolean>();
  const put: ObjectPutter = async (key, body, contentType) => { puts.set(key, { body: Buffer.isBuffer(body) ? Buffer.from(body) : body, contentType }); };
  return { puts, lastPushed, lastImageHash, pngKnown, put };
}
type Cache = ReturnType<typeof cache>;
const pngKey = (f: Pick<Fixture, 'deedAssetId'>) => `deed/asset/${f.deedAssetId}.png`;
const imageUrl = (c: Cache, f: Pick<Fixture, 'deedAssetId'>) => (JSON.parse(c.puts.get(`deed/asset/${f.deedAssetId}.json`)!.body.toString()) as { image: string }).image;
const sweep = (c: Cache, extra: Partial<NonNullable<Parameters<typeof sweepDeedMetadata>[3]>> = {}) => sweepDeedMetadata(db, c.put, c.lastPushed, {
  publicBaseUrl: publicUrl, lastImageHash: c.lastImageHash, pngKnown: c.pngKnown, ...extra,
});
function ordering() {
  const art = vi.spyOn(painter, 'baseRenderFleetArtFingerprint').mockReturnValue(orderingArt);
  vi.spyOn(painter, 'baseRenderAvailable').mockReturnValue(true);
  const render = vi.spyOn(painter, 'renderBasePng').mockImplementation(async (_db, wallet, baseId, context, appearance, packet) => Buffer.from(JSON.stringify({ wallet, baseId, context, appearance, packet })));
  return { art, render };
}
// Pins the accepted ordinary art version, not an invented gameplay number.
const pictureHash = (packet: CapturedDeedDrawing) => createHash('sha256').update(JSON.stringify({ a: 5, fleetDrawing: capture.deedDrawingFingerprint(packet) })).digest('hex');

it('publishes the exact immutable packet, skips identical drawings, then follows actual geometry and applied tier changes', async () => {
  const f = await installed(), apply = await pendingUpgrade(f);
  await deed(f);
  const { render } = ordering(), c = cache();
  await sweep(c);
  const first = render.mock.calls[0]![5]!;
  expect(render.mock.calls[0]!.slice(3, 5)).toEqual([undefined, undefined]);
  expect(first.servicePresentation.berths.find(b => b.installation)?.installation?.family).toBe('starter');
  expect(first.advancedServicePresentation.berths.find(b => b.installation)?.installation).toEqual({ family: 'survey_balloon', tier: 1, presence: 'occupied' });
  expect(c.lastImageHash.get(f.baseId)).toBe(pictureHash(first));
  expect(imageUrl(c, f)).toBe(`${publicUrl}/${pngKey(f)}?v=${pictureHash(first)}`);
  await sweep(c);
  expect(render).toHaveBeenCalledTimes(1);
  const movedTx = f.advancedSeat.tx + 1;
  render.mockImplementationOnce(async (_db, _wallet, _baseId, _context, _appearance, packet) => {
    await db.update(buildings).set({ tx: movedTx }).where(eq(buildings.id, f.berthId));
    return Buffer.from(JSON.stringify(packet));
  });
  c.lastImageHash.delete(f.baseId);
  await sweep(c);
  const painted = JSON.parse(c.puts.get(pngKey(f))!.body.toString()) as CapturedDeedDrawing;
  expect(painted.buildings.find(b => b.id === f.berthId)?.tx).toBe(f.advancedSeat.tx);
  expect(c.lastImageHash.get(f.baseId)).toBe(pictureHash(first));
  await sweep(c);
  const movedHash = c.lastImageHash.get(f.baseId);
  expect(movedHash).not.toBe(pictureHash(first));
  await apply();
  await sweep(c);
  expect(render.mock.calls.at(-1)![5]!.advancedServicePresentation.berths.find(b => b.installation)?.installation?.tier).toBe(2);
  expect(c.lastImageHash.get(f.baseId)).not.toBe(movedHash);
});

it('keeps both stable and legacy no-berth predecessor hashes and passes the explicit null sentinel without fleet reads', async () => {
  const actor = Keypair.generate().publicKey.toBase58(), baseId = randomUUID(), asset = Keypair.generate().publicKey.toBase58();
  ownedBases.push(baseId); ownedWallets.push(actor);
  await db.insert(players).values({ wallet: actor, entryPaidAt: new Date(), deedAssetId: asset });
  await db.insert(bases).values({ id: baseId, ownerWallet: actor });
  await db.insert(baseSlots).values({ wallet: actor, baseId, slot: 1 });
  await db.insert(buildings).values({ playerWallet: actor, baseId, type: 'keep', tx: 10, ty: 10 });
  await deed({ baseId, deedAssetId: asset });
  const { render, art } = ordering(), read = vi.spyOn(capture, 'captureDeedFleetDrawing');
  for (const stable of [true, false]) {
    vi.stubEnv('MULTI_BASE_ENABLED', String(stable));
    const b = await db.select({ type: buildings.type, level: buildings.level, tx: buildings.tx, ty: buildings.ty }).from(buildings)
      .where(stable ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, actor)).orderBy(buildings.tx, buildings.ty, buildings.type);
    const o = await db.select({ k: obstacles.spriteKey, tx: obstacles.tx, ty: obstacles.ty }).from(obstacles)
      .where(and(stable ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, actor), isNull(obstacles.clearedAt))).orderBy(obstacles.tx, obstacles.ty);
    const visualContext = await resolveBaseVisual(db, stable ? baseId : undefined);
    const oldHash = createHash('sha256').update(JSON.stringify({ b, o, e: 0, a: 5, visualContext })).digest('hex').slice(0, 8);
    const c = cache(); await sweep(c);
    expect(c.lastImageHash.get(stable ? baseId : actor)).toBe(oldHash);
    expect(render.mock.calls.at(-1)![5]).toBeNull();
    const restarted = cache(), head = vi.fn(async () => true);
    await sweep(restarted, { renderAvailable: false, head });
    expect(imageUrl(restarted, { deedAssetId: asset })).toContain(`?v=${oldHash}`);
    expect(restarted.lastImageHash.size).toBe(0);
    // Predecessor behavior: the plain no-berth branch can recompute its URL
    // from DB layout even when rendering is unavailable and an older hash is
    // cached. Fleet/Market branches require the published hash instead.
    await db.update(buildings).set({ tx: 11 }).where(eq(buildings.baseId, baseId));
    const changedHash = createHash('sha256').update(JSON.stringify({ b: b.map(row => ({ ...row, tx: 11 })), o, e: 0, a: 5, visualContext })).digest('hex').slice(0, 8);
    c.lastPushed.clear(); await sweep(c, { renderAvailable: false });
    expect(c.lastImageHash.get(stable ? baseId : actor)).toBe(oldHash);
    expect(imageUrl(c, { deedAssetId: asset })).toContain(`?v=${changedHash}`);
    await db.update(buildings).set({ tx: 10 }).where(eq(buildings.baseId, baseId));
  }
  expect(art).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

it('retains the published image for unavailable sources, renderer refusals, identity errors and failed PUT, then waits for successful PUT', async () => {
  const f = await installed(); await deed(f);
  const { render, art } = ordering(), c = cache(); await sweep(c);
  const published = c.lastImageHash.get(f.baseId)!;
  await db.update(buildings).set({ tx: f.advancedSeat.tx + 1 }).where(eq(buildings.id, f.berthId));
  const ordinaryRender = render.getMockImplementation()!, ordinaryPut = c.put;
  for (const failure of ['art', 'source-null', 'source-error', 'render-null', 'render-error', 'identity-error', 'put-error']) {
    c.puts.clear(); c.lastPushed.clear();
    if (failure === 'art') art.mockReturnValue(null);
    if (failure === 'source-null') await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId));
    if (failure === 'source-error') await conn.sql`alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) immutable`;
    if (failure === 'render-null') render.mockResolvedValue(null);
    if (failure === 'render-error') render.mockRejectedValue(new Error('Owned renderer refusal'));
    const identity = failure === 'identity-error' ? vi.spyOn(capture, 'deedDrawingIdentityCurrent').mockRejectedValue(new Error('Owned identity query failure')) : null;
    if (failure === 'put-error') c.put = async (key, ...args) => { if (key.endsWith('.png')) throw new Error('Owned PUT refusal'); await ordinaryPut(key, ...args); };
    try {
      await sweep(c);
      expect(c.lastImageHash.get(f.baseId), failure).toBe(published);
      expect(c.puts.has(pngKey(f)), failure).toBe(false);
      expect(imageUrl(c, f), failure).toContain(`?v=${published}`);
    } finally {
      art.mockReturnValue(orderingArt); render.mockImplementation(ordinaryRender); identity?.mockRestore(); c.put = ordinaryPut;
      if (failure === 'source-null') await db.update(baseSlots).set({ active: true }).where(eq(baseSlots.baseId, f.baseId));
      if (failure === 'source-error') await conn.sql`alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) volatile`;
    }
  }
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  c.put = async (key, ...args) => { if (key === pngKey(f)) { entered(); await gate; } await ordinaryPut(key, ...args); };
  const running = sweep(c);
  try { await ready; expect(c.lastImageHash.get(f.baseId)).toBe(published); expect(c.puts.has(pngKey(f))).toBe(false); }
  finally { release(); await running; }
  expect(c.lastImageHash.get(f.baseId)).not.toBe(published);
  expect(c.pngKnown.get(f.baseId)).toBe(true);
});

it('does not certify a candidate fleet hash from HEAD, including unavailable art, and probes only once per cache', async () => {
  const f = await installed(); await deed(f);
  const { render, art } = ordering();
  for (const available of [true, false]) {
    art.mockReturnValue(available ? orderingArt : null);
    const c = cache(), head = vi.fn(async () => true);
    await sweep(c, { renderAvailable: false, head });
    expect(c.pngKnown.get(f.baseId)).toBe(true);
    expect(c.lastImageHash.has(f.baseId)).toBe(false);
    expect(imageUrl(c, f)).not.toContain('?v=');
    expect(c.puts.has(pngKey(f))).toBe(false);
    await sweep(c, { renderAvailable: false, head });
    expect(head).toHaveBeenCalledTimes(1);
  }
  expect(render).not.toHaveBeenCalled();
  // Controlled negative coordinator seam only, not an admitted land claim:
  // unavailable fleet source must not release a fantasy publication fence,
  // even when a prior hash or HEAD establishes an older picture's existence.
  const tile = [...fantasyTiles('crownlands')].find(row => row.allocation === 'ordinary')!;
  vi.spyOn(locations, 'resolveFantasyLocation').mockResolvedValue(tile);
  art.mockReturnValue(null);
  for (const prior of [undefined, 'ef'.repeat(32)]) {
    const fenced = cache();
    if (prior) fenced.lastImageHash.set(f.baseId, prior);
    await sweep(fenced, { renderAvailable: false, head: async () => true });
    expect(fenced.puts.size).toBe(0);
    expect(fenced.lastPushed.size).toBe(0);
    expect(fenced.lastImageHash.get(f.baseId)).toBe(prior);
  }
});

it('refuses a genuine transfer observed before PUT and next publishes the buyer using the same stable base', async () => {
  const f = await installed(); await deed(f);
  const { render } = ordering(), c = cache();
  const prior = 'cd'.repeat(32); c.lastImageHash.set(f.baseId, prior);
  const buyer = Keypair.generate().publicKey.toBase58(); await db.insert(players).values({ wallet: buyer });
  let original: CapturedDeedDrawing | undefined;
  render.mockImplementationOnce(async (_db, _wallet, _baseId, _context, _appearance, packet) => {
    original = packet!;
    await transferStableBase(db, f.baseId, f.actor, buyer, f.deedAssetId, {
      owner: buyer, collection: Keypair.generate().publicKey.toBase58(), frozen: false, delegate: null,
      slot: 100, observedAtMs: Date.now(),
    }, () => new Date());
    return Buffer.from('old-owner-result');
  });
  await sweep(c);
  expect(c.puts.has(pngKey(f))).toBe(false); expect(c.lastImageHash.get(f.baseId)).toBe(prior);
  expect(await capture.deedDrawingIdentityCurrent(db, original!)).toBe(false);
  await sweep(c);
  expect(render.mock.calls.at(-1)![1]).toBe(buyer);
  expect(render.mock.calls.at(-1)![2]).toBe(f.baseId);
  expect(render.mock.calls.at(-1)![5]!.identity.deedAssetId).toBe(f.deedAssetId);
  expect(c.puts.has(pngKey(f))).toBe(true);
});

it('combines real admitted art, actual current capture, real PNG painting and sweep publication with exact hashes', async () => {
  // No hoisted module mock exists in this file. Earlier per-case spies have
  // been restored by afterEach; all three production exports execute here.
  expect(vi.isMockFunction(painter.renderBasePng)).toBe(false);
  expect(vi.isMockFunction(painter.baseRenderFleetArtFingerprint)).toBe(false);
  expect(painter.baseRenderAvailable(), 'actual primary generated art is required').toBe(true);
  const art = painter.baseRenderFleetArtFingerprint();
  expect(art, 'actual admitted fleet working set is required').toMatch(/^[0-9a-f]{64}$/);
  const f = await installed(), apply = await pendingUpgrade(f); await deed(f);
  const first = (await capture.captureDeedFleetDrawing(db, f.actor, f.baseId, f.deedAssetId, art!))!;
  expect(first).not.toBeNull();
  const reference = await painter.renderBasePng(db, f.actor, f.baseId, undefined, undefined, first);
  const omitted = await painter.renderBasePng(db, f.actor, f.baseId);
  expect(reference).not.toBeNull(); expect(omitted).not.toBeNull();
  const sharp = (await import('sharp')).default;
  const pixels = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
  const c = cache(); await sweep(c);
  const actual = c.puts.get(pngKey(f))!;
  expect(actual.contentType).toBe('image/png'); expect(Buffer.isBuffer(actual.body)).toBe(true);
  expect(await pixels(actual.body as Buffer)).toEqual(await pixels(reference!));
  // Both non-overlapping fixture seats must actually alter the old omitted
  // picture. This guards a nominal PNG proof whose fleet sits outside claim.
  const origin = claimRect(0).min - 1, tile = 32, berth = footprintOf(BuildingType.Berth);
  for (const seat of [f.advancedSeat, f.starterSeat]) {
    const region = { left: (seat.tx - origin) * tile, top: (seat.ty - origin - 1) * tile, width: berth.fw * tile, height: (berth.fh + 1) * tile };
    const visible = await sharp(actual.body as Buffer).extract(region).raw().toBuffer();
    const absent = await sharp(omitted!).extract(region).raw().toBuffer();
    expect(visible.equals(absent), 'each in-claim starter/advanced seat contains rendered fleet pixels').toBe(false);
  }
  expect(c.lastImageHash.get(f.baseId)).toBe(pictureHash(first));
  expect(imageUrl(c, f)).toBe(`${publicUrl}/${pngKey(f)}?v=${pictureHash(first)}`);
  if (evidence) {
    await writeFile(`${evidence}/occupied-tier1.png`, actual.body);
    await writeFile(`${evidence}/occupied-tier1.json`, c.puts.get(`deed/asset/${f.deedAssetId}.json`)!.body);
  }
  c.puts.clear(); await sweep(c); expect(c.puts.has(pngKey(f))).toBe(false);
  await apply(); await sweep(c);
  const second = (await capture.captureDeedFleetDrawing(db, f.actor, f.baseId, f.deedAssetId, art!))!;
  expect(second.advancedServicePresentation.berths.find(b => b.installation)?.installation?.tier).toBe(2);
  const upgraded = c.puts.get(pngKey(f))!.body as Buffer;
  expect((await pixels(upgraded)).equals(await pixels(actual.body as Buffer))).toBe(false);
  expect(c.lastImageHash.get(f.baseId)).toBe(pictureHash(second));
  expect(c.lastImageHash.get(f.baseId)).not.toBe(pictureHash(first));
  if (evidence) {
    await writeFile(`${evidence}/occupied-tier2.png`, upgraded);
    await writeFile(`${evidence}/occupied-tier2.json`, c.puts.get(`deed/asset/${f.deedAssetId}.json`)!.body);
    await writeFile(`${evidence}/combined-provenance.json`, JSON.stringify({
      scope: 'actual admitted accessor + canonical original capture + real PNG painter + sweep with in-memory object transport',
      limits: 'Synthetic owner-attested registry, encoded Core/finality, signed local burn and completed facility fixtures. No live R2, HTTP, browser, Android or independently verified mint provenance.',
      art, baseId: f.baseId, deedAssetId: f.deedAssetId, advancedSeat: f.advancedSeat, starterSeat: f.starterSeat,
      firstPictureHash: pictureHash(first), secondPictureHash: pictureHash(second),
      firstPngSha256: createHash('sha256').update(actual.body).digest('hex'), secondPngSha256: createHash('sha256').update(upgraded).digest('hex'),
    }, null, 2));
  }
}, 60000);
