/** Public HTTP + real admitted fleet PNGs. Owner/facility/Core/finality inputs
 * are explicit local synthetic fixtures; lifecycle and painting are real.
 * Controlled renderer wrappers are used only for observed race ordering. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
import { BuildingType } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { bases, baseSlots, buildings, players } from '../src/db/schema';
import * as painter from '../src/game/baseRender';
import * as capture from '../src/game/deedFleetCapture';
import { assertFreshLockedBaseAuthority, transferStableBase } from '../src/game/baseOwnership';
import { claimRect, footprintOf } from '../src/game/footprints';
import { installStarterFleet } from '../src/game/starterFleet';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { createVehicleServiceApplications } from '../src/game/vehicleServiceApplications';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceBuilding } from './fixtures/vehicleService';
import { vehicleServiceConsentFixture } from './fixtures/vehicleServicePreparation';
import { ADMIN_DATABASE_URL } from './db-url';
import { TEST_CONFIG } from './helpers';

const conn = resourceClaimsDatabase(), db = conn.db;
const evidence = process.env['P6B_DIRECT_HTTP_EVIDENCE_DIR'];
let app: Awaited<ReturnType<typeof buildApp>>;
let databaseName: string | undefined;
beforeAll(async () => {
  await conn.setup();
  databaseName = String((await conn.sql`select current_database() name`)[0]!.name);
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    const location = new URL(ADMIN_DATABASE_URL);
    await writeFile(`${evidence}/database.json`, JSON.stringify({ databaseName, host: location.hostname, port: location.port, state: 'running-owned' }));
  }
  app = await buildApp(TEST_CONFIG, db);
}, 180000);
afterAll(async () => {
  await app?.close();
  await conn.close();
  if (evidence) await writeFile(`${evidence}/database.json`, JSON.stringify({ databaseName, state: 'closed-owned-database-dropped' }));
});
beforeEach(() => {
  for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(flag, 'true');
  vi.stubEnv('FANTASY_WORLD_ENABLED', 'false');
  vi.stubEnv('DEV_LOGIN_REALM', '');
  vi.stubEnv('REALM_KIT_PREVIEW_REALMS', '');
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

async function installed() {
  const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn });
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
async function deed(f: { baseId: string; deedAssetId: string }) {
  await db.update(bases).set({ deedAssetId: f.deedAssetId, deedMintAssetId: f.deedAssetId, landPaidAt: new Date() }).where(eq(bases.id, f.baseId));
}
const assetUrl = (asset: string) => `/deed/asset/${asset}.png`;
const walletUrl = (wallet: string) => `/deed/${wallet}.png`;
const urls = (f: Pick<Fixture, 'actor' | 'deedAssetId'>) => [assetUrl(f.deedAssetId), walletUrl(f.actor)];
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');
async function pixels(png: Buffer) { return (await import('sharp')).default(png).ensureAlpha().raw().toBuffer(); }
async function ordinaryBase(actor: string, status: 'active' | 'inactive' = 'active') {
  const baseId = randomUUID(), deedAssetId = Keypair.generate().publicKey.toBase58();
  await db.insert(bases).values({ id: baseId, ownerWallet: actor, status, deedAssetId, deedMintAssetId: deedAssetId, landPaidAt: new Date() });
  await db.insert(buildings).values({ playerWallet: actor, baseId, type: 'keep', tx: 10, ty: 10 });
  return { actor, baseId, deedAssetId };
}

it('serves both normal unauthenticated routes as real fleet PNGs and follows one canonical applied tier change', async () => {
  expect(painter.baseRenderAvailable(), 'accepted generated primary art is required').toBe(true);
  const art = painter.baseRenderFleetArtFingerprint(); expect(art).toMatch(/^[0-9a-f]{64}$/);
  const f = await installed(), consent = await vehicleServiceConsentFixture(f);
  const prepared = await consent.preparations.prepare(f.actor, consent.intent.id);
  await deed(f);
  const packet = (await capture.captureDeedFleetDrawing(db, f.actor, f.baseId, f.deedAssetId, art!))!;
  expect(packet.servicePresentation.berths.find(b => b.installation)?.installation?.family).toBe('starter');
  expect(packet.advancedServicePresentation.berths.find(b => b.installation)?.installation?.tier).toBe(1);
  const expected = (await painter.renderBasePng(db, f.actor, f.baseId, undefined, undefined, packet))!;
  const absent = (await painter.renderBasePng(db, f.actor, f.baseId))!;
  const observations: Array<Record<string, unknown>> = [];
  const first: Buffer[] = [];
  for (const [i, url] of urls(f).entries()) {
    const response = await app.inject({ url }); // Deliberately no token/cookie/session.
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(await pixels(response.rawPayload)).toEqual(await pixels(expected));
    first.push(response.rawPayload);
    observations.push({ stage: 'tier1', url, status: response.statusCode, contentType: response.headers['content-type'], cacheControl: response.headers['cache-control'], bodySha256: sha(response.rawPayload) });
    if (evidence) await writeFile(`${evidence}/tier1-${i === 0 ? 'asset' : 'wallet'}.png`, response.rawPayload);
  }
  expect(first[0]).toEqual(first[1]);
  const sharp = (await import('sharp')).default, tile = 32, origin = claimRect(0).min - 1, berth = footprintOf(BuildingType.Berth);
  for (const seat of [f.advancedSeat, f.starterSeat]) {
    const region = { left: (seat.tx - origin) * tile, top: (seat.ty - origin - 1) * tile, width: berth.fw * tile, height: (berth.fh + 1) * tile };
    expect((await sharp(first[0]!).extract(region).raw().toBuffer()).equals(await sharp(absent).extract(region).raw().toBuffer()), 'each fleet seat contains actual pixels').toBe(false);
  }
  consent.finalizeService(prepared);
  await createVehicleServiceApplications(db, { verifyBurn: consent.reader.verify }).recover(f.actor, consent.intent.id);
  const upgraded = (await capture.captureDeedFleetDrawing(db, f.actor, f.baseId, f.deedAssetId, art!))!;
  expect(upgraded.advancedServicePresentation.berths.find(b => b.installation)?.installation?.tier).toBe(2);
  const upgradedExpected = (await painter.renderBasePng(db, f.actor, f.baseId, undefined, undefined, upgraded))!;
  for (const [i, url] of urls(f).entries()) {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(200);
    expect(await pixels(response.rawPayload)).toEqual(await pixels(upgradedExpected));
    expect((await pixels(response.rawPayload)).equals(await pixels(first[i]!))).toBe(false);
    observations.push({ stage: 'tier2', url, status: response.statusCode, bodySha256: sha(response.rawPayload) });
    if (evidence) await writeFile(`${evidence}/tier2-${i === 0 ? 'asset' : 'wallet'}.png`, response.rawPayload);
  }
  if (evidence) await writeFile(`${evidence}/http-provenance.json`, JSON.stringify({
    scope: 'normal public buildApp.inject, actual admitted art and current captured painter; no authentication headers',
    limits: 'Owner DB fixture connection, synthetic completed facilities/owner-attested registry/encoded Core/finality and locally signed burn. No restricted request LOGIN, network socket, live R2, browser, Android or live mint provenance.',
    art, baseId: f.baseId, deedAssetId: f.deedAssetId, advancedSeat: f.advancedSeat, starterSeat: f.starterSeat, observations,
  }, null, 2));
}, 60000);

it('holds an actual overdue unreturned starter without settlement and keeps optional unavailability distinct from mandatory errors', async () => {
  const starter = await createStarterExpeditionFixture(db);
  const trip = await starter.dispatch(), deedAssetId = Keypair.generate().publicKey.toBase58();
  await deed({ baseId: starter.baseId, deedAssetId });
  const before = await conn.sql`select to_jsonb(e) row from starter_expeditions e where id=${trip.id}`;
  const stocks = await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${starter.baseId} order by resource_id`;
  const ledger = await conn.sql`select count(*)::integer n from ledger_transactions`;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(+trip.returnsAt + 1));
  for (const url of [assetUrl(deedAssetId), walletUrl(starter.wallet)]) {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(404); expect(response.json().error.message).toBe('renderer unavailable');
  }
  expect(await conn.sql`select to_jsonb(e) row from starter_expeditions e where id=${trip.id}`).toEqual(before);
  expect(await conn.sql`select id from starter_expedition_returns where expedition_id=${trip.id}`).toHaveLength(0);
  expect(await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${starter.baseId} order by resource_id`).toEqual(stocks);
  expect(await conn.sql`select count(*)::integer n from ledger_transactions`).toEqual(ledger);
  vi.useRealTimers();
  const f = await installed(); await deed(f);
  const art = vi.spyOn(painter, 'baseRenderFleetArtFingerprint').mockReturnValue(null);
  for (const url of urls(f)) expect((await app.inject({ url })).statusCode).toBe(404);
  art.mockRestore();
  await conn.sql`alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) rename to owned_direct_absent_advanced`;
  try { for (const url of urls(f)) expect((await app.inject({ url })).statusCode).toBe(404); }
  finally { await conn.sql`alter function public.owned_direct_absent_advanced(text,uuid,jsonb,timestamptz) rename to shardkeep_current_advanced_presentation`; }
  await conn.sql`alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) immutable`;
  try { for (const url of urls(f)) expect((await app.inject({ url })).statusCode).toBe(500); }
  finally { await conn.sql`alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) volatile`; }
});

it('keeps exact asset routing, all-owned-base ambiguity and existing unpaid or invalid guards without choosing another identity', async () => {
  const f = await installed(); await deed(f);
  const second = await ordinaryBase(f.actor, 'inactive');
  expect((await app.inject({ url: walletUrl(f.actor) })).statusCode).toBe(404);
  for (const asset of [f.deedAssetId, second.deedAssetId]) expect((await app.inject({ url: assetUrl(asset) })).statusCode).toBe(200);
  for (const url of [assetUrl('invalid'), walletUrl('invalid'), assetUrl(Keypair.generate().publicKey.toBase58()), walletUrl(Keypair.generate().publicKey.toBase58())]) {
    const response = await app.inject({ url }); expect(response.statusCode).toBe(404); expect(response.json().error.message).toBe('no such deed');
  }
  await db.update(bases).set({ landPaidAt: null }).where(eq(bases.id, f.baseId));
  expect((await app.inject({ url: assetUrl(f.deedAssetId) })).statusCode).toBe(404);
  await deed(f);
  // A sole paid berth base without exact deed identity cannot borrow another
  // asset or mint reservation. Keep the old no-berth path separate below.
  const missing = await installed(); await deed(missing);
  await db.update(bases).set({ deedAssetId: null }).where(eq(bases.id, missing.baseId));
  expect((await app.inject({ url: walletUrl(missing.actor) })).statusCode).toBe(404);
  // Seed an initially noncanonical legacy identity on a separate fixture;
  // never rewrite the previous base's immutable reserved mint to test this.
  const malformed = await installed();
  await db.update(bases).set({ deedAssetId: 'not-a-canonical-deed', deedMintAssetId: 'not-a-canonical-deed', landPaidAt: new Date() }).where(eq(bases.id, malformed.baseId));
  expect((await app.inject({ url: walletUrl(malformed.actor) })).statusCode).toBe(404);
  await db.update(players).set({ entryPaidAt: new Date(), deedAssetId: f.deedAssetId }).where(eq(players.wallet, f.actor));
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  for (const url of urls(f)) {
    const response = await app.inject({ url }); expect(response.statusCode).toBe(404); expect(response.json().error.message).toBe('renderer unavailable');
  }
});

it('preserves real stable and legacy no-berth bytes and refuses a newly appeared berth through the actual painter sentinel', async () => {
  const actor = Keypair.generate().publicKey.toBase58(); await db.insert(players).values({ wallet: actor, entryPaidAt: new Date() });
  const f = await ordinaryBase(actor);
  await db.insert(baseSlots).values({ wallet: actor, baseId: f.baseId, slot: 1 });
  await db.update(players).set({ deedAssetId: f.deedAssetId }).where(eq(players.wallet, actor));
  const art = vi.spyOn(painter, 'baseRenderFleetArtFingerprint'), read = vi.spyOn(capture, 'captureDeedFleetDrawing');
  const actualRender = painter.renderBasePng;
  for (const stable of [true, false]) {
    vi.stubEnv('MULTI_BASE_ENABLED', String(stable));
    const expected = (await actualRender(db, actor, stable ? f.baseId : undefined))!;
    for (const url of urls(f)) {
      const response = await app.inject({ url }); expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(expected);
      expect(response.headers['cache-control']).toBe('public, max-age=60');
    }
  }
  expect(art).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  vi.stubEnv('MULTI_BASE_ENABLED', 'true');
  vi.spyOn(painter, 'renderBasePng').mockImplementationOnce(async (...args) => {
    expect(args[5]).toBeNull();
    await db.insert(buildings).values({ playerWallet: actor, baseId: f.baseId, type: 'berth', level: 0, tx: 15, ty: 10 });
    return actualRender(...args);
  });
  const crossed = await app.inject({ url: assetUrl(f.deedAssetId) });
  expect(crossed.statusCode).toBe(404); expect(crossed.json().error.message).toBe('renderer unavailable');
  expect(art).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

it('refuses actual custody or wallet ambiguity changes after real painting and then resolves the buyers exact deed', async () => {
  const f = await installed(); await deed(f);
  const buyer = Keypair.generate().publicKey.toBase58(); await db.insert(players).values({ wallet: buyer });
  const actualRender = painter.renderBasePng;
  let drawn: Buffer | null = null;
  const render = vi.spyOn(painter, 'renderBasePng').mockImplementationOnce(async (...args) => {
    drawn = await actualRender(...args);
    await transferStableBase(db, f.baseId, f.actor, buyer, f.deedAssetId, {
      owner: buyer, collection: Keypair.generate().publicKey.toBase58(), frozen: false, delegate: null,
      slot: 100, observedAtMs: Date.now(),
    }, () => new Date());
    return drawn;
  });
  const stale = await app.inject({ url: assetUrl(f.deedAssetId) });
  expect(drawn).not.toBeNull(); expect(stale.statusCode).toBe(404); expect(stale.json().error.message).toBe('renderer unavailable');
  expect((await app.inject({ url: walletUrl(f.actor) })).statusCode).toBe(404);
  const current = await app.inject({ url: assetUrl(f.deedAssetId) });
  expect(current.statusCode).toBe(200); expect(current.rawPayload).toEqual(drawn);
  expect(render.mock.calls.at(-1)![1]).toBe(buyer); expect(render.mock.calls.at(-1)![2]).toBe(f.baseId);
  render.mockImplementationOnce(async (...args) => {
    const png = await actualRender(...args);
    await ordinaryBase(buyer, 'inactive');
    return png;
  });
  const ambiguous = await app.inject({ url: walletUrl(buyer) });
  expect(ambiguous.statusCode).toBe(404); expect(ambiguous.json().error.message).toBe('no such deed');
});
