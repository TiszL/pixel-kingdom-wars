/**
 * P6b painter proof: the deed draws presented berths ONLY from a captured
 * packet (deedFleetCapture.ts) and ONLY from the retained admitted fleet working
 * set whose fingerprint the packet names. Real admitted art, real captured
 * packets over genuine local installations (synthetic encoded chain/burn/clock
 * fixtures, declared), actual pixels compared against sharp composites — never a
 * fake painter. Isolated owned Postgres (resourceClaimsDatabase on
 * TEST_ADMIN_DATABASE_URL), never the dev database.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';

/** Retained-JSON identity regression (root integration review): a sheet's JSON
 *  must be read ONCE and that same read must feed both the retained frame map
 *  and the digest. This mock answers the ORIGINAL bytes on the first read of a
 *  trapped file and DIFFERENT bytes on every later read; a loader that read the
 *  file twice would retain one file's rectangles under another file's digest. */
const readTrap: { path: string | null; reads: number; second: Buffer | null } = { path: null, reads: 0, second: null };
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    readFileSync: ((file: Parameters<typeof original.readFileSync>[0], options?: Parameters<typeof original.readFileSync>[1]) => {
      if (readTrap.path !== null && String(file) === readTrap.path) {
        readTrap.reads += 1;
        if (readTrap.reads > 1 && readTrap.second) return options ? readTrap.second.toString('utf8') : readTrap.second;
      }
      return original.readFileSync(file, options);
    }) as typeof original.readFileSync,
  };
});
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { STRUCTURES, atlasGroupFor } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bases, baseSlots, builderJobs, buildings as buildingsTable, players } from '../src/db/schema';
import {
  baseRenderAvailable, baseRenderFleetArtFingerprint, baseRenderMarketArtAvailable, renderBasePng,
} from '../src/game/baseRender';
import { captureDeedFleetDrawing, type CapturedDeedDrawing } from '../src/game/deedFleetCapture';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { installStarterFleet } from '../src/game/starterFleet';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { BLUEPRINT_TEST_FLAGS } from './fixtures/boundCosmeticBlueprint';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceBuilding } from './fixtures/vehicleService';

const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
const atlasDir = path.join(repoRoot, 'apps', 'web', 'public', 'atlas');
const atlasReady = baseRenderAvailable();
const fleetReady = baseRenderFleetArtFingerprint() !== null;
const DEED_TILE = 32;
const DEED_FRAME_ORIGIN_TILE = 7; // claim min 8 minus the renderer's one-tile margin
const DEED_SCALE = 0.5;           // 112 px cells authored at the web's 64 px tile

interface Crop { buf: Buffer; width: number; height: number }
interface Seat { key: string; tx: number; ty: number; ax: number; ay: number; dx: number; dy: number }

/** The exact packed cell, cut and resized the way the painter must (nearest, half density). */
async function fleetCrop(key: string): Promise<Crop> {
  const sharp = (await import('sharp')).default;
  const group = atlasGroupFor(key);
  const sheet = JSON.parse(readFileSync(path.join(atlasDir, `${group}@1x.json`), 'utf8')) as {
    textures: Array<{ frames: Array<{ filename: string; frame: { x: number; y: number; w: number; h: number } }> }>;
  };
  const frame = sheet.textures[0]!.frames.find((f) => f.filename === key)?.frame;
  if (!frame) throw new Error(`missing generated fleet fixture for ${key}`);
  const width = Math.round(frame.w * DEED_SCALE), height = Math.round(frame.h * DEED_SCALE);
  const buf = await sharp(path.join(atlasDir, `${group}@1x.png`))
    .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h }).png().toBuffer()
    .then((native) => sharp(native).resize({ width, height, kernel: sharp.kernel.nearest }).png().toBuffer());
  return { buf, width, height };
}
async function raw(png: Buffer): Promise<Buffer> { return (await import('sharp')).default(png).raw().toBuffer(); }
/** EXACTLY the painter's placement: berth bottom on the south edge; a vehicle hangs
 *  from its contact anchor at the authored origin-to-origin dock offset (half density). */
async function expectComposite(actual: Buffer, before: Buffer, seats: readonly Seat[], label: string): Promise<void> {
  const sharp = (await import('sharp')).default;
  const [fw, fh] = STRUCTURES.berth.footprint;
  const origin = DEED_FRAME_ORIGIN_TILE * DEED_TILE;
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const s of seats) {
    const art = await fleetCrop(s.key);
    layers.push({ input: art.buf,
      left: Math.round((s.tx + fw / 2) * DEED_TILE + s.dx - s.ax * art.width) - origin,
      top: Math.round((s.ty + fh) * DEED_TILE + s.dy - s.ay * art.height) - origin });
  }
  const expected = await sharp(before).composite(layers).png().toBuffer();
  expect((await raw(actual)).equals(await raw(expected)), label).toBe(true);
}

/** Authored geometry straight from the generated sidecar (the same bytes the painter admits). */
const meta = JSON.parse(readFileSync(path.join(atlasDir, 'meta.json'), 'utf8')) as {
  peStarterFleet: { geometry: { starter: { contactPx: [number, number]; dockOffsetPx: [number, number] }; berth: { horizontalPivot: number; sourceCellBottom: number } } };
  peAdvancedFleet: { clips: Record<string, { geometry: Record<string, unknown> }> };
};
function vehicleSeat(family: 'starter' | 'survey_balloon', tier: number, state: 'docked' | 'exhausted', tx: number, ty: number): Seat {
  const berth = family === 'starter' ? meta.peStarterFleet.geometry.berth
    : meta.peAdvancedFleet.clips[`pe_berth_${family}_intact`]!.geometry as unknown as { horizontalPivot: number; sourceCellBottom: number };
  const vehicle = family === 'starter' ? meta.peStarterFleet.geometry.starter
    : meta.peAdvancedFleet.clips[`pe_veh_${family}_t${tier}_${state}`]!.geometry as unknown as { contactPx: [number, number]; dockOffsetPx: [number, number] };
  const key = family === 'starter' ? 'pe_veh_starter_docked_f1' : `pe_veh_${family}_t${tier}_${state}_f1`;
  return { key, tx, ty, ax: vehicle.contactPx[0] / 112, ay: vehicle.contactPx[1] / 112,
    dx: (-berth.horizontalPivot + vehicle.dockOffsetPx[0] + vehicle.contactPx[0]) * DEED_SCALE,
    dy: (-berth.sourceCellBottom + vehicle.dockOffsetPx[1] + vehicle.contactPx[1]) * DEED_SCALE };
}
const berthSeat = (key: string, tx: number, ty: number): Seat => ({ key, tx, ty, ax: 0.5, ay: 1, dx: 0, dy: 0 });

/** A sibling atlas directory with every generated file symlinked except `omit`,
 *  plus optional replacement bytes for one file (same pixels, different bytes). */
async function siblingAtlasDir(prefix: string, omit: (file: string) => boolean, replace?: { file: string; bytes: Buffer }): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(root, 'apps', 'web', 'public', 'atlas');
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(atlasDir)) {
    if (omit(file)) continue;
    if (replace && file === replace.file) { writeFileSync(path.join(dir, file), replace.bytes); continue; }
    symlinkSync(path.join(atlasDir, file), path.join(dir, file));
  }
  return root;
}

describe.skipIf(!atlasReady || !fleetReady)('deed painter: Phase E fleet berths from a captured packet (P6b)', () => {
  const conn = resourceClaimsDatabase(), db = conn.db;
  let actor: string, baseId: string, deedAssetId: string, balloonBerthId: string, starterBerthId: string, lodgeId: string, before: Buffer;
  const BALLOON = { tx: 12, ty: 12 }, STARTER = { tx: 16, ty: 12 }, EMPTY = { tx: 18, ty: 16 }, SCAFFOLD = { tx: 20, ty: 18 };
  const authority = { baseId: '', assertAuthority: async (...args: Parameters<typeof assertFreshLockedBaseAuthority>) => { await assertFreshLockedBaseAuthority(...args); } };

  beforeAll(async () => {
    for (const flag of [...BLUEPRINT_TEST_FLAGS, 'MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(flag, 'true');
    await conn.setup();
    // Genuine advanced installation (accepted lifecycle code over a synthetic finalized burn), backdated as D242/D243 do.
    const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn, completedAt: new Date(Date.now() - 8 * 86400000) });
    f.finalizeBurn(); await createVehicleInstallations(db, { verifyBurn: f.reader.verify }).recover(f.actor, f.reservation.id);
    await conn.sql.begin(async (tx) => {
      await tx`set local session_replication_role=replica`;
      await tx`update vehicle_activation_reservations set reserved_at=reserved_at-interval '7 days' where id=${f.reservation.id}`;
      await tx`update vehicle_burn_consumptions set recorded_at=recorded_at-interval '7 days' where reservation_id=${f.reservation.id}`;
      await tx`update advanced_vehicle_installations set installed_at=installed_at-interval '7 days' where reservation_id=${f.reservation.id}`;
    });
    actor = f.actor; baseId = f.baseId; balloonBerthId = f.berthId; authority.baseId = baseId;
    // Genuine starter installation on a second completed berth; a lodge for the ordinary picture.
    lodgeId = await vehicleServiceBuilding(f, 'lodge');
    starterBerthId = await vehicleServiceBuilding(f, 'berth');
    await installStarterFleet(db, actor, starterBerthId, authority);
    // Synthetic placement inside the claim (declared); lifecycle facts untouched.
    await conn.sql`update buildings set tx=${BALLOON.tx}, ty=${BALLOON.ty} where id=${balloonBerthId}`;
    await conn.sql`update buildings set tx=${STARTER.tx}, ty=${STARTER.ty} where id=${starterBerthId}`;
    await conn.sql`update buildings set tx=8, ty=8 where id=${lodgeId}`;
    const emptyId = randomUUID(), scaffoldId = randomUUID();
    await conn.sql`insert into buildings(id,player_wallet,base_id,type,level,tx,ty) values (${emptyId},${actor},${baseId},'berth',1,${EMPTY.tx},${EMPTY.ty}),(${scaffoldId},${actor},${baseId},'berth',0,${SCAFFOLD.tx},${SCAFFOLD.ty})`;
    await conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values (${actor},${baseId},${emptyId},'build',now()-interval '9 days',now()-interval '8 days',now()-interval '8 days'),(${actor},${baseId},${scaffoldId},'build',now(),now()+interval '2 days',null)`;
    deedAssetId = Keypair.generate().publicKey.toBase58();
    await db.update(bases).set({ deedAssetId, deedMintAssetId: deedAssetId, landPaidAt: new Date() }).where(eq(bases.id, baseId));
    // Today's direct picture (undefined sixth argument): berth rows are omitted, the lodge draws.
    const png = await renderBasePng(db, actor, baseId);
    if (!png) throw new Error('generated atlases unexpectedly unavailable');
    before = png;
  }, 300_000);
  afterAll(async () => { vi.unstubAllEnvs(); await conn.close(); }, 120_000);

  const capture = () => captureDeedFleetDrawing(db, actor, baseId, deedAssetId, baseRenderFleetArtFingerprint()!);
  const paint = (packet: CapturedDeedDrawing | null | undefined, wallet = actor, base = baseId) => renderBasePng(db, wallet, base, undefined, undefined, packet);
  let occupiedPng: Buffer, occupiedPacket: CapturedDeedDrawing;

  it('1. draws a REAL captured packet: the advanced and starter berths with their docked vehicles at the authored dock seats; the empty and scaffold berths draw nothing', async () => {
    const packet = (await capture())!;
    expect(packet.admittedArtFingerprint).toBe(baseRenderFleetArtFingerprint());
    expect(packet.advancedServicePresentation.berths.find((b) => b.buildingId === balloonBerthId)?.installation).toEqual({ family: 'survey_balloon', tier: 1, presence: 'occupied' });
    expect(packet.servicePresentation.berths.find((b) => b.buildingId === starterBerthId)?.installation).toEqual({ family: 'starter', presence: 'occupied' });
    const png = await paint(packet);
    expect(png).not.toBeNull();
    await expectComposite(png!, before, [
      berthSeat('pe_berth_survey_balloon_intact_f1', BALLOON.tx, BALLOON.ty), vehicleSeat('survey_balloon', 1, 'docked', BALLOON.tx, BALLOON.ty),
      berthSeat('pe_berth_starter_intact_f1', STARTER.tx, STARTER.ty), vehicleSeat('starter', 1, 'docked', STARTER.tx, STARTER.ty),
    ], 'occupied balloon + occupied starter over the ordinary picture; empty/scaffold berths add nothing');
    occupiedPng = png!; occupiedPacket = packet;
  }, 120_000);

  it('2. a packet is the ONLY input: later geometry, obstacle, expansion and completion changes never reach a packet picture', async () => {
    const obstacleId = randomUUID();
    await conn.sql`update buildings set tx=9, ty=9 where id=${lodgeId}`;
    await conn.sql`update buildings set tx=10, ty=18 where id=${balloonBerthId}`;
    await conn.sql`insert into obstacles(id,player_wallet,base_id,sprite_key,tx,ty) values (${obstacleId},${actor},${baseId},'pine1',9,14)`;
    await conn.sql`update bases set expansions=1 where id=${baseId}`;
    await conn.sql`update builder_jobs set completed_at=now() where building_id in (select id from buildings where base_id=${baseId} and level=0)`;
    try {
      const live = await renderBasePng(db, actor, baseId);
      expect((await raw(live!)).equals(await raw(before)), 'the live picture moved with the lodge/obstacle/expansion').toBe(false);
      const packet = await paint(occupiedPacket);
      expect(packet!.length, 'the captured frame keeps its captured expansion').toBe(occupiedPng.length);
      expect((await raw(packet!)).equals(await raw(occupiedPng)), 'the captured picture did not change: rows, obstacles, expansions and construction come from the packet').toBe(true);
    } finally {
      await conn.sql`update buildings set tx=8, ty=8 where id=${lodgeId}`;
      await conn.sql`update buildings set tx=${BALLOON.tx}, ty=${BALLOON.ty} where id=${balloonBerthId}`;
      await conn.sql`delete from obstacles where id=${obstacleId}`;
      await conn.sql`update bases set expansions=0 where id=${baseId}`;
      await conn.sql`update builder_jobs set completed_at=null where building_id in (select id from buildings where base_id=${baseId} and level=0)`;
    }
  }, 120_000);

  it('3. the no-berth sentinel refuses ANY berth row before drawing and never consults the fleet set; undefined keeps today\'s picture; a berth-less base paints alike for null and undefined', async () => {
    const partial = await siblingAtlasDir('pkw-p6b-nofleet-', (file) => /^pe_(fleet_starter|berth_|veh_)/.test(file));
    vi.stubEnv('REPO_ROOT', partial);
    const log = vi.spyOn(console, 'log');
    try {
      expect(await paint(null), 'a berth row observed after a no-berth sweep refuses the picture').toBeNull();
      expect(log.mock.calls.some(([line]) => String(line).includes('Phase E fleet art')), 'the sentinel path never asked for the fleet set').toBe(false);
      const direct = await paint(undefined);
      expect(log.mock.calls.some(([line]) => String(line).includes('Phase E fleet art')), 'nor does the compatibility path').toBe(false);
      expect((await raw(direct!)).equals(await raw(before)), 'undefined = today\'s picture, berths omitted').toBe(true);
      const bare = Keypair.generate().publicKey.toBase58(), bareBase = randomUUID();
      await db.insert(players).values({ wallet: bare });
      await db.insert(bases).values({ id: bareBase, ownerWallet: bare });
      await db.insert(baseSlots).values({ wallet: bare, slot: 1, baseId: bareBase });
      const withNull = await renderBasePng(db, bare, bareBase, undefined, undefined, null);
      const withUndefined = await renderBasePng(db, bare, bareBase);
      expect(withNull).not.toBeNull();
      expect((await raw(withNull!)).equals(await raw(withUndefined!))).toBe(true);
    } finally { log.mockRestore(); vi.stubEnv('REPO_ROOT', repoRoot); }
  }, 120_000);

  it('4. refuses a packet for another wallet or base, a packet whose persisted identity is gone, a foreign fingerprint, and a transactional handle (loud)', async () => {
    expect(await paint(occupiedPacket, Keypair.generate().publicKey.toBase58())).toBeNull();
    expect(await paint(occupiedPacket, actor, randomUUID())).toBeNull();
    const buyer = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet: buyer });
    await db.update(bases).set({ ownerWallet: buyer }).where(eq(bases.id, baseId));
    try { expect(await paint(occupiedPacket), 'persisted custody changed after capture: refuse, no owner switch').toBeNull(); }
    finally { await db.update(bases).set({ ownerWallet: actor }).where(eq(bases.id, baseId)); }
    expect(await paint({ ...occupiedPacket, admittedArtFingerprint: 'ab'.repeat(32) })).toBeNull();
    await expect(db.transaction((tx) => renderBasePng(tx, actor, baseId, undefined, undefined, occupiedPacket))).rejects.toThrow(/top-level database/);
    // The packet above was unchanged: the real one still paints.
    expect(await paint(occupiedPacket)).not.toBeNull();
  }, 120_000);

  it('5. the fingerprint names the retained set: stable, null when a fleet group is absent while the Market set stays admitted, different for different bytes — and an older packet is then refused', async () => {
    const fingerprint = baseRenderFleetArtFingerprint()!;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(baseRenderFleetArtFingerprint()).toBe(fingerprint);
    const missing = await siblingAtlasDir('pkw-p6b-missing-', (file) => file.startsWith('pe_veh_cargo_cutter_t3@'));
    vi.stubEnv('REPO_ROOT', missing);
    try {
      expect(baseRenderFleetArtFingerprint(), 'one absent group ⇒ no admitted set').toBeNull();
      expect(baseRenderMarketArtAvailable(), 'the Market set is independent').toBe(true);
      expect(await paint(occupiedPacket), 'no admitted set ⇒ the packet cannot be painted').toBeNull();
    } finally { vi.stubEnv('REPO_ROOT', repoRoot); }
    expect(baseRenderFleetArtFingerprint(), 'recovers to the same value').toBe(fingerprint);
    // Same pixels, different bytes: a re-encoded berth sheet is a different working set.
    const sharp = (await import('sharp')).default;
    const original = readFileSync(path.join(atlasDir, 'pe_berth_survey_balloon@1x.png'));
    const reencoded = await sharp(original).png({ compressionLevel: 0 }).toBuffer();
    expect(reencoded.equals(original)).toBe(false);
    const altered = await siblingAtlasDir('pkw-p6b-bytes-', () => false, { file: 'pe_berth_survey_balloon@1x.png', bytes: reencoded });
    vi.stubEnv('REPO_ROOT', altered);
    try {
      const other = baseRenderFleetArtFingerprint();
      expect(other).not.toBeNull(); expect(other).not.toBe(fingerprint);
      expect(await paint(occupiedPacket), 'a packet captured against other bytes is refused, never painted from these').toBeNull();
    } finally { vi.stubEnv('REPO_ROOT', repoRoot); }
    expect(baseRenderFleetArtFingerprint()).toBe(fingerprint);
    // Cell granularity: one drawable clip missing, one anchor drifted, or one binding digest
    // not matching its value refuses the WHOLE set; a consistent 1 px geometry edit (same
    // digest strings, same bytes) is a DIFFERENT working set with a different fingerprint.
    const metaJson = JSON.parse(readFileSync(path.join(atlasDir, 'meta.json'), 'utf8')) as { peAdvancedFleet: { clips: Record<string, Record<string, unknown>>; bindings: Record<string, { sha256: string; value: Record<string, unknown> }> } };
    const edited = (mutate: (m: typeof metaJson) => void): Buffer => { const copy = JSON.parse(JSON.stringify(metaJson)) as typeof metaJson; mutate(copy); return Buffer.from(JSON.stringify(copy)); };
    const defects: Array<[string, Buffer, 'null' | 'different']> = [
      ['a missing drawable clip', edited((m) => { delete m.peAdvancedFleet.clips['pe_veh_cargo_cutter_t3_exhausted']; }), 'null'],
      ['an anchor that is not the authored contact', edited((m) => { m.peAdvancedFleet.clips['pe_veh_cargo_cutter_t3_docked']!['anchorPx'] = [56, 100]; }), 'null'],
      ['a binding digest that does not match its value', edited((m) => { (m.peAdvancedFleet.bindings['pe_berth_cargo_cutter']!.value as Record<string, unknown>)['sourceAssetId'] = 'hand-edited'; }), 'null'],
      ['a consistent 1 px geometry edit under the same digests', edited((m) => {
        for (const state of ['docked', 'exhausted']) {
          const clip = m.peAdvancedFleet.clips[`pe_veh_cargo_cutter_t3_${state}`]!; const g = clip['geometry'] as Record<string, unknown>;
          g['contactPx'] = [56, 107]; g['dockOffsetPx'] = [0, -29]; clip['anchorPx'] = [56, 107];
        }
      }), 'different'],
    ];
    for (const [label, bytes, outcome] of defects) {
      const dir = await siblingAtlasDir('pkw-p6b-meta-', () => false, { file: 'meta.json', bytes });
      vi.stubEnv('REPO_ROOT', dir);
      try {
        const value = baseRenderFleetArtFingerprint();
        if (outcome === 'null') expect(value, label).toBeNull(); else { expect(value, label).not.toBeNull(); expect(value, label).not.toBe(fingerprint); }
        expect(await paint(occupiedPacket), `${label}: the real packet is refused`).toBeNull();
      } finally { vi.stubEnv('REPO_ROOT', repoRoot); }
    }
    expect(baseRenderFleetArtFingerprint()).toBe(fingerprint);
  }, 120_000);

  it('7. retained-JSON identity (root review): a sheet\'s JSON is read once, and that one read feeds both the retained rectangles and the digest', async () => {
    const fingerprint = baseRenderFleetArtFingerprint()!;
    // A sibling directory (fresh admission) whose cargo-cutter t3 JSON answers the
    // original bytes once and a shifted-rectangle JSON on any later read.
    const dir = await siblingAtlasDir('pkw-p6b-json-', () => false);
    const target = path.join(dir, 'apps', 'web', 'public', 'atlas', 'pe_veh_cargo_cutter_t3@1x.json');
    const shifted = JSON.parse(readFileSync(path.join(atlasDir, 'pe_veh_cargo_cutter_t3@1x.json'), 'utf8')) as { textures: Array<{ frames: Array<{ frame: { x: number } }> }> };
    for (const f of shifted.textures[0]!.frames) f.frame.x += 1;
    readTrap.path = target; readTrap.reads = 0; readTrap.second = Buffer.from(JSON.stringify(shifted));
    vi.stubEnv('REPO_ROOT', dir);
    try {
      const admitted = baseRenderFleetArtFingerprint();
      expect(readTrap.reads, 'exactly one read of the sheet JSON per admission').toBe(1);
      expect(admitted, 'the digest is of the very bytes the retained rectangles came from — the normal fingerprint').toBe(fingerprint);
      // The retained set keeps painting from those rectangles; the later bytes never reach it.
      expect(await paint(occupiedPacket)).not.toBeNull();
      expect(readTrap.reads).toBe(1);
    } finally { readTrap.path = null; readTrap.second = null; vi.stubEnv('REPO_ROOT', repoRoot); }
    expect(baseRenderFleetArtFingerprint()).toBe(fingerprint);
  }, 120_000);

  it('6. presence drives the vehicle: away draws the berth alone, exhausted draws the authored still at the same dock seat (packets re-shaped from the real capture, identity and fingerprint intact)', async () => {
    const reshape = (presence: 'away' | 'exhausted'): CapturedDeedDrawing => ({
      ...occupiedPacket,
      advancedServicePresentation: { version: 1, berths: occupiedPacket.advancedServicePresentation.berths.map((b) =>
        b.installation ? { buildingId: b.buildingId, installation: { ...b.installation, presence } } : { buildingId: b.buildingId, installation: null }) },
    } as CapturedDeedDrawing);
    const away = await paint(reshape('away'));
    await expectComposite(away!, before, [
      berthSeat('pe_berth_survey_balloon_intact_f1', BALLOON.tx, BALLOON.ty),
      berthSeat('pe_berth_starter_intact_f1', STARTER.tx, STARTER.ty), vehicleSeat('starter', 1, 'docked', STARTER.tx, STARTER.ty),
    ], 'away balloon berth without its vehicle; the starter still docked');
    const exhausted = await paint(reshape('exhausted'));
    await expectComposite(exhausted!, before, [
      berthSeat('pe_berth_survey_balloon_intact_f1', BALLOON.tx, BALLOON.ty), vehicleSeat('survey_balloon', 1, 'exhausted', BALLOON.tx, BALLOON.ty),
      berthSeat('pe_berth_starter_intact_f1', STARTER.tx, STARTER.ty), vehicleSeat('starter', 1, 'docked', STARTER.tx, STARTER.ty),
    ], 'exhausted balloon on the same dock seat');
  }, 120_000);
});
