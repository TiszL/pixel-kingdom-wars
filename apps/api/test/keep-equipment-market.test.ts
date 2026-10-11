/** Real SQL custody and private authority boundaries. No mocked market service,
 * fabricated payment or delivery: fills only reserve original equipment. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { BASE_OWNERSHIP, BUILD_COSTS, BuildingType, PHASE_E_KEEP_EQUIPMENT_MARKET as POLICY, PHASE_E_ORDINARY_CRAFTING as C } from '@shardkeep/shared';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { ordinaryEquipmentRecipe } from '@shardkeep/shared/phaseEOrdinaryEquipment';
import { starterRoutePreview } from '@shardkeep/shared/phaseEExpeditions';
import { FANTASY_CATALOG_HASH, FANTASY_WORLD_ID, crownlandsMigrationTiles } from '@shardkeep/shared/fantasyWorld';
import { bases, baseSlots, buildings, builderJobs, craftingStocks } from '../src/db/schema';
import { fantasyManifestHash } from '../src/db/fantasyMigration';
import { assertFreshLockedBaseAuthority, refreshBaseOwnership, type FinalizedDeedReader } from '../src/game/baseOwnership';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { installFantasyCatalog } from '../src/game/fantasyLocation';
import { startOrdinaryCrafting, settleDueOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { startOrdinaryEquipment } from '../src/game/ordinaryEquipment';
import { dispatchStarterExpedition } from '../src/game/starterExpeditionDispatch';
import { settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import {
  createKeepEquipmentListing, reserveKeepEquipmentFill, cancelKeepEquipmentListing,
  readKeepEquipmentListing, readOwnedKeepEquipmentFill, readOwnedKeepEquipmentCancellation,
  type KeepEquipmentListing,
} from '../src/game/keepEquipmentMarket';
import { isolatedFantasyTestDb } from './fantasy-test-db';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';

// Fitted dispatch installs a permanent fantasy assignment and changes global
// presentation, so this suite must not enroll other suites' legacy world DB.
const conn = isolatedFantasyTestDb(), db = conn.db, price = POLICY.minFillBaseUnits.toString();
const key = () => Keypair.generate().publicKey.toBase58();
const enabled = () => undefined;
beforeAll(() => conn.prepare());
beforeEach(() => { for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'ORDINARY_CRAFTING_ENABLED']) vi.stubEnv(flag, 'true'); });
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => conn.dispose());
async function player() { const wallet = key(); await conn.sql`insert into players(wallet) values(${wallet})`; return wallet; }
async function deeded(wallet: string, baseId: string, clock: () => Date) {
  const deed = key(), collection = key();
  await conn.sql`update bases set deed_asset_id=${deed},land_paid_at=${clock().toISOString()}::timestamptz where id=${baseId}`;
  const reader: FinalizedDeedReader = vi.fn(async () => ({ owner: wallet, collection, frozen: false, delegate: null, slot: 100 }));
  expect(await refreshBaseOwnership(db, baseId, reader, collection, clock(), 'equipment-market-test', clock)).toBe('owned');
  expect(reader).toHaveBeenCalledWith(deed, undefined);
  const authority: StableBaseMutationContext = { baseId, assertAuthority: async (tx, actor, id) => { await assertFreshLockedBaseAuthority(tx, actor, id, clock()); } };
  return { deed, collection, authority };
}
async function fixture(quantity = '10', itemId: 'route_compass' | 'survey_lens' = 'route_compass', at = new Date('2035-01-01T01:00:00.000Z')) {
  const wallet = await player(), baseId: string = randomUUID(), now = new Date(at);
  await conn.sql`insert into bases(id,owner_wallet) values(${baseId},${wallet})`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  const f = { wallet, baseId, now, itemId }, authority = await deeded(wallet, baseId, () => f.now);
  await conn.sql`insert into ordinary_equipment_stocks(base_id,item_id,available) values(${baseId},${itemId},${quantity}::bigint)`;
  return Object.assign(f, authority);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const deps = (f: { now: Date }) => ({ clock: () => f.now, assertAdmission: enabled });
const listingRequest = (f: { baseId: string; itemId?: 'route_compass' | 'survey_lens' }, quantity = '10', unitPriceBaseUnits = price) =>
  ({ idempotencyKey: randomUUID(), baseId: f.baseId, itemId: f.itemId ?? 'route_compass', quantity, unitPriceBaseUnits });
const list = (f: Fixture, quantity = '10', unitPriceBaseUnits = price) => createKeepEquipmentListing(db, f.wallet, listingRequest(f, quantity, unitPriceBaseUnits), f.authority, deps(f));
const fillRequest = (buyer: Fixture, offer: KeepEquipmentListing, quantity = '1') => ({ idempotencyKey: randomUUID(), listingId: offer.id, buyerBaseId: buyer.baseId, quantity });
const fill = (seller: Fixture, buyer: Fixture, offer: KeepEquipmentListing, quantity = '1') => reserveKeepEquipmentFill(db, buyer.wallet, fillRequest(buyer, offer, quantity), { buyer: buyer.authority, seller: seller.authority }, deps(buyer));
const cancelRequest = (offer: KeepEquipmentListing) => ({ idempotencyKey: randomUUID(), listingId: offer.id });
const cancel = (seller: Fixture, offer: KeepEquipmentListing) => cancelKeepEquipmentListing(db, seller.wallet, cancelRequest(offer), seller.authority, deps(seller));
async function stock(baseId: string, itemId = 'route_compass') {
  return (await conn.sql`select available::text,reserved::text,pending_output::text,market_outgoing::text,market_incoming::text
    from ordinary_equipment_stocks where base_id=${baseId} and item_id=${itemId}`)[0];
}
async function workshop(wallet: string, baseId: string, at: Date) {
  const [building] = await db.insert(buildings).values({ baseId, playerWallet: wallet, type: BuildingType.Workshop, tx: 9, ty: 2 }).returning();
  const completedAt = new Date(+at - 1000);
  await db.insert(builderJobs).values({ baseId, playerWallet: wallet, buildingId: building!.id, kind: 'build',
    startedAt: new Date(+completedAt - BUILD_COSTS.workshop.buildSec * 1000), finishesAt: completedAt, completedAt });
}
async function changeOwner(f: Fixture) {
  const wallet = await player();
  expect(await refreshBaseOwnership(db, f.baseId, async () => ({ owner: wallet, collection: f.collection, frozen: false, delegate: null, slot: 200 }),
    f.collection, f.now, 'equipment-market-transfer', () => f.now)).toBe('mismatch');
  await conn.sql`update bases set status='active' where id=${f.baseId}`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${f.baseId})`;
  expect(await refreshBaseOwnership(db, f.baseId, async () => ({ owner: wallet, collection: f.collection, frozen: false, delegate: null, slot: 201 }),
    f.collection, f.now, 'equipment-market-new-owner', () => f.now)).toBe('owned');
  return { ...f, wallet };
}

it('earns and refines real route cargo, crafts a Compass, then escrows that exact stable-base unit without granting the buyer stock', async () => {
  // 2026-10-10: 0256/0279 refuse an equipment completion cutoff later than Postgres clock_timestamp(), which no test can
  // fake, so this earned-cargo calendar starts three real days ago instead of the fixture's 2035 default.
  const wallet = await player(), f = await createStarterExpeditionFixture(db, { wallet, now: new Date(Date.now() - 3 * 86_400_000) }); await workshop(wallet, f.baseId, f.now);
  for (const [routeId, recipeId] of [['common_seeker_reach', 'refine_prismstone_lens'], ['common_crownlands', 'refine_crownsteel']] as const) {
    const route = starterRoutePreview('crownlands', routeId), input = ordinaryEquipmentRecipe().inputs.find(i => i.itemId === recipeId.slice(7))!;
    const need = BigInt(C.v1.refining.rawPerOutput) * BigInt(input.quantity); let earned = 0n;
    while (earned < need) {
      const trip = await dispatchStarterExpedition(db, wallet, { ...f.command, id: randomUUID(), routeId, routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion }, f.authority, { reader: f.reader, clock: () => f.now });
      f.now = trip.returnsAt; await db.transaction(tx => settleDueStarterExpeditions(tx, f.baseId, f.now)); earned += trip.net;
    }
    const job = await startOrdinaryCrafting(db, wallet, { id: randomUUID(), baseId: f.baseId, recipeId, recipeVersion: C.currentRecipeVersion, quantity: Number(BigInt(input.quantity)) }, f.authority, { clock: () => f.now });
    f.now = job.job.readyAt; await db.transaction(tx => settleDueOrdinaryCrafting(tx, f.baseId, f.now));
  }
  const made = await startOrdinaryEquipment(db, wallet, { idempotencyKey: randomUUID(), baseId: f.baseId, recipeId: 'craft_route_compass', recipeVersion: 1, quantity: 1 }, f.authority, { clock: () => f.now });
  if (made.status !== 'accepted') throw Error('Expected actual crafted equipment');
  f.now = new Date(made.receipt.readyAt); await db.transaction(tx => settleDueOrdinaryCrafting(tx, f.baseId, f.now));
  const source = { ...f, ...(await deeded(wallet, f.baseId, () => f.now)), itemId: 'route_compass' as const }, buyer = await fixture('0', 'route_compass', f.now);
  const offer = await createKeepEquipmentListing(db, wallet, listingRequest(source, '1'), source.authority, deps(source));
  const reserved = await fill(source, buyer, offer);
  expect(reserved).toMatchObject({ sellerBaseId: f.baseId, buyerBaseId: buyer.baseId, quantity: '1', totalBaseUnits: price });
  expect(await stock(f.baseId)).toMatchObject({ available: '0', reserved: '0', pending_output: '0', market_outgoing: '1' });
  expect(await stock(buyer.baseId)).toMatchObject({ available: '0', market_incoming: '1' });
});

it.each(['route_compass', 'survey_lens'] as const)('%s partial fills and cancellation conserve all units without touching trip reservations', async itemId => {
  const seller = await fixture('10', itemId), a = await fixture('0', itemId), b = await fixture('0', itemId), offer = await list(seller);
  const first = await fill(seller, a, offer, '4'), second = await fill(seller, b, offer, '3');
  const request = cancelRequest(offer), cancelled = await cancelKeepEquipmentListing(db, seller.wallet, request, seller.authority, deps(seller));
  expect(cancelled.quantity).toBe('3');
  expect(await stock(seller.baseId, itemId)).toMatchObject({ available: '3', reserved: '0', pending_output: '0', market_outgoing: '7', market_incoming: '0' });
  expect(await stock(a.baseId, itemId)).toMatchObject({ available: '0', market_incoming: '4' });
  expect(await stock(b.baseId, itemId)).toMatchObject({ available: '0', market_incoming: '3' });
  expect(await readKeepEquipmentListing(db, offer.id)).toMatchObject({ availableQuantity: '0', reservedQuantity: '7', cancelledQuantity: '3' });
  expect(await cancelKeepEquipmentListing(db, seller.wallet, request, seller.authority)).toEqual(cancelled);
  await expect(cancel(seller, offer)).rejects.toMatchObject({ code: 'KEEP_EQUIPMENT_MARKET_UNAVAILABLE' });
  await expect(fill(seller, a, offer)).rejects.toMatchObject({ code: 'KEEP_EQUIPMENT_MARKET_UNAVAILABLE' });
  expect(await readOwnedKeepEquipmentFill(db, a.wallet, first.id)).toEqual(first); expect(await readOwnedKeepEquipmentFill(db, b.wallet, second.id)).toEqual(second);
  expect(await readOwnedKeepEquipmentCancellation(db, a.wallet, cancelled.id)).toBeNull();
});

it('same-key concurrent listing/fill retries move stock once and original recovery survives a pause', async () => {
  const seller = await fixture(), buyer = await fixture('0'), request = listingRequest(seller);
  const offers = await Promise.all([0, 1].map(() => createKeepEquipmentListing(db, seller.wallet, request, seller.authority, deps(seller))));
  expect(offers[0]).toEqual(offers[1]); const offer = offers[0]!, buy = fillRequest(buyer, offer, '3');
  const results = await Promise.all([0, 1].map(() => reserveKeepEquipmentFill(db, buyer.wallet, buy, { buyer: buyer.authority, seller: seller.authority }, deps(buyer))));
  expect(results[0]).toEqual(results[1]); expect(await stock(buyer.baseId)).toMatchObject({ available: '0', market_incoming: '3' });
  expect(await reserveKeepEquipmentFill(db, buyer.wallet, buy, { buyer: buyer.authority, seller: seller.authority })).toEqual(results[0]);
  await expect(reserveKeepEquipmentFill(db, buyer.wallet, { ...buy, quantity: '2' }, { buyer: buyer.authority, seller: seller.authority })).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  await expect(createKeepEquipmentListing(db, seller.wallet, { ...request, quantity: '9' }, seller.authority)).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  expect(await stock(seller.baseId)).toMatchObject({ available: '0', market_outgoing: '10' });
});

it('two buyers racing the same partial stock cannot over-reserve or leave capacity in the losing kingdom', async () => {
  const seller = await fixture('3'), a = await fixture('0'), b = await fixture('0'), offer = await list(seller, '3');
  const results = await Promise.allSettled([fill(seller, a, offer, '2'), fill(seller, b, offer, '2')]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'KEEP_EQUIPMENT_MARKET_UNAVAILABLE' } });
  expect(await readKeepEquipmentListing(db, offer.id)).toMatchObject({ availableQuantity: '1', reservedQuantity: '2' });
  expect(BigInt((await stock(a.baseId))!.market_incoming) + BigInt((await stock(b.baseId))!.market_incoming)).toBe(2n);
});

it.each(['fill', 'cancel'] as const)('refuses a stale repeatable-read %s snapshot after another reservation commits', async operation => {
  const seller = await fixture('1'), buyer = await fixture('0'), offer = await list(seller, '1');
  let ready!: () => void, resume!: () => void;
  const snapshot = new Promise<void>(done => { ready = done; }), committed = new Promise<void>(done => { resume = done; });
  const stale = conn.sql.begin('isolation level repeatable read', async tx => {
    expect(await tx`select * from keep_equipment_fills where listing_id=${offer.id}`).toHaveLength(0); ready(); await committed;
    if (operation === 'fill') await tx`insert into keep_equipment_fills(id,listing_id,buyer_wallet,buyer_base_id,quantity,created_at)
      values(${randomUUID()},${offer.id},${buyer.wallet},${buyer.baseId},1,${buyer.now.toISOString()}::timestamptz)`;
    else await tx`insert into keep_equipment_listing_cancellations(id,listing_id,actor_wallet,created_at) values(${randomUUID()},${offer.id},${seller.wallet},${seller.now.toISOString()}::timestamptz)`;
  }).then(() => null, error => error);
  await snapshot;
  try { await fill(seller, buyer, offer); } finally { resume(); }
  expect(await stale).toMatchObject({ message: 'KEEP_EQUIPMENT_MARKET_ISOLATION' });
  expect(await readKeepEquipmentListing(db, offer.id)).toMatchObject({ reservedQuantity: '1', cancelledQuantity: '0', availableQuantity: '0' });
  expect(await stock(buyer.baseId)).toMatchObject({ market_incoming: '1' });
});

it('a fill requires the v4 reservation identity supported by the signed payment protocol', async () => {
  const seller = await fixture('1'), buyer = await fixture('0'), offer = await list(seller, '1');
  await expect(conn.sql`insert into keep_equipment_fills(id,listing_id,buyer_wallet,buyer_base_id,quantity,created_at)
    values('00000000-0000-1000-8000-000000000001',${offer.id},${buyer.wallet},${buyer.baseId},1,${buyer.now.toISOString()}::timestamptz)`)
    .rejects.toMatchObject({ code: '23514' });
  expect(await readKeepEquipmentListing(db, offer.id)).toMatchObject({ availableQuantity: '1', reservedQuantity: '0' });
  expect((await stock(buyer.baseId))?.market_incoming).toBe('0');
});

it('cancellation racing a purchase has one winner and never releases the committed fill', async () => {
  const seller = await fixture('1'), buyer = await fixture('0'), offer = await list(seller, '1');
  const results = await Promise.allSettled([cancel(seller, offer), fill(seller, buyer, offer)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'KEEP_EQUIPMENT_MARKET_UNAVAILABLE' } });
  const source = (await stock(seller.baseId))!, incoming = BigInt((await stock(buyer.baseId))!.market_incoming);
  expect(BigInt(source.available) + incoming).toBe(1n); expect(BigInt(source.market_outgoing)).toBe(incoming);
});

it('selling races actual fitted dispatch for the same available unit without double custody', async () => {
  const wallet = await player(), f = await createStarterExpeditionFixture(db, { wallet }), authority = await deeded(wallet, f.baseId, () => f.now);
  await db.transaction(installFantasyCatalog);
  const used = await conn.sql`select tile_id from fantasy_land_claims where state in ('held','assigned')`;
  const tile = crownlandsMigrationTiles().find(t => !used.some(row => row.tile_id === t.tileId))!;
  const manifest = { version: 1 as const, worldId: FANTASY_WORLD_ID, catalogHash: FANTASY_CATALOG_HASH, snapshotAt: f.now.toISOString(),
    entries: [{ baseId: f.baseId, mintId: authority.deed, ownerWallet: wallet, tileId: tile.tileId, state: 'assigned' as const }], exclusions: [] };
  const hash = fantasyManifestHash(manifest);
  await conn.sql`insert into fantasy_migration_batches(manifest_hash,world_id,manifest) values(${hash},${FANTASY_WORLD_ID},${JSON.stringify(manifest)}::jsonb)`;
  await conn.sql`insert into fantasy_land_claims(world_id,tile_id,base_id,state,source,expected_mint,manifest_hash,assigned_at)
    values(${FANTASY_WORLD_ID},${tile.tileId},${f.baseId},'assigned','migration-active',${authority.deed},${hash},${f.now.toISOString()}::timestamptz)`;
  await conn.sql`insert into ordinary_equipment_stocks(base_id,item_id,available) values(${f.baseId},'route_compass',1)`;
  const route = starterRoutePreview('crownlands', 'coastal_survey');
  const results = await Promise.allSettled([
    createKeepEquipmentListing(db, wallet, listingRequest(f, '1'), authority.authority, deps(f)),
    dispatchStarterExpedition(db, wallet, { ...f.command, id: randomUUID(), routeId: route.routeId, routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion,
      fitting: { itemId: 'route_compass', policyVersion: 1 } }, authority.authority, { reader: f.reader, clock: () => f.now }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const row = (await stock(f.baseId))!; expect(row.available).toBe('0');
  expect(BigInt(row.reserved) + BigInt(row.market_outgoing)).toBe(1n);
  const rejected = results.find(r => r.status === 'rejected');
  expect(['KEEP_EQUIPMENT_MARKET_STOCK', 'COMPASS_UNAVAILABLE']).toContain(rejected?.status === 'rejected' ? rejected.reason.code : null);
});

it('seller transfer blocks new fills and old-actor writes while the new owner can return only unsold stock to the original base', async () => {
  const seller = await fixture(), buyer = await fixture('0'), offer = await list(seller), saved = await fill(seller, buyer, offer, '4');
  const next = await changeOwner(seller);
  await expect(fill(seller, buyer, offer)).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
  await expect(cancel(seller, offer)).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
  expect((await cancel(next, offer)).quantity).toBe('6');
  expect(await stock(seller.baseId)).toMatchObject({ available: '6', market_outgoing: '4' });
  expect(await readOwnedKeepEquipmentFill(db, buyer.wallet, saved.id)).toEqual(saved);
  expect(await readOwnedKeepEquipmentFill(db, next.wallet, saved.id)).toBeNull();
  expect((await readKeepEquipmentListing(db, offer.id))?.sellerWallet).toBe(seller.wallet);
});

it('buyer transfer leaves the exact original fill and incoming capacity with its receiving base', async () => {
  const seller = await fixture(), buyer = await fixture('0'), offer = await list(seller), request = fillRequest(buyer, offer, '2');
  const saved = await reserveKeepEquipmentFill(db, buyer.wallet, request, { buyer: buyer.authority, seller: seller.authority }, deps(buyer));
  const next = await changeOwner(buyer);
  expect(await reserveKeepEquipmentFill(db, buyer.wallet, request, { buyer: buyer.authority, seller: seller.authority })).toEqual(saved);
  expect(await readOwnedKeepEquipmentFill(db, next.wallet, saved.id)).toBeNull();
  expect(await stock(buyer.baseId)).toMatchObject({ available: '0', market_incoming: '2' });
});

it('an actual finalized deed transfer racing a fresh fill either preserves the prior commitment or rejects the old seller', async () => {
  const seller = await fixture('2'), buyer = await fixture('0'), offer = await list(seller, '2');
  const [purchase, transfer] = await Promise.allSettled([fill(seller, buyer, offer), changeOwner(seller)]);
  expect(transfer.status).toBe('fulfilled'); if (transfer.status !== 'fulfilled') throw transfer.reason;
  const committed = purchase.status === 'fulfilled' ? 1n : 0n;
  if (purchase.status === 'rejected') expect(purchase.reason).toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
  expect((await readKeepEquipmentListing(db, offer.id))?.reservedQuantity).toBe(committed.toString());
  expect((await stock(buyer.baseId))?.market_incoming).toBe(committed.toString());
  expect((await cancel(transfer.value, offer)).quantity).toBe((2n - committed).toString());
  expect(await stock(seller.baseId)).toMatchObject({ available: (2n - committed).toString(), market_outgoing: committed.toString() });
});

it('holds source return space and destination incoming space, rejecting overflow before payment or a competing craft', async () => {
  const seller = await fixture(RAW_RESOURCE_STORAGE_MAX.toString()), buyer = await fixture((RAW_RESOURCE_STORAGE_MAX - 1n).toString()), offer = await list(seller, '2');
  await expect(fill(seller, buyer, offer, '2')).rejects.toMatchObject({ code: 'KEEP_EQUIPMENT_MARKET_CAPACITY' });
  expect(await readKeepEquipmentListing(db, offer.id)).toMatchObject({ reservedQuantity: '0', availableQuantity: '2' });
  expect(await stock(buyer.baseId)).toMatchObject({ market_incoming: '0' });
  await fill(seller, buyer, offer, '1');
  await expect(conn.sql`update ordinary_equipment_stocks set available=available+1 where base_id=${seller.baseId}`).rejects.toMatchObject({ code: '23514' });
  expect((await cancel(seller, offer)).quantity).toBe('1');
  expect(await stock(seller.baseId)).toMatchObject({ available: (RAW_RESOURCE_STORAGE_MAX - 1n).toString(), market_outgoing: '1' });
  await workshop(buyer.wallet, buyer.baseId, buyer.now);
  for (const input of ordinaryEquipmentRecipe().inputs) await db.insert(craftingStocks).values({ baseId: buyer.baseId, itemId: input.itemId, available: BigInt(input.quantity) });
  const craftId = randomUUID();
  await expect(startOrdinaryEquipment(db, buyer.wallet, { idempotencyKey: craftId, baseId: buyer.baseId, recipeId: 'craft_route_compass', recipeVersion: 1, quantity: 1 }, buyer.authority, { clock: () => buyer.now })).rejects.toThrow();
  expect(await conn.sql`select * from ordinary_equipment_jobs where id=${craftId}`).toHaveLength(0);
  expect((await db.select().from(craftingStocks).where(eq(craftingStocks.baseId, buyer.baseId))).every(row => row.available === 2n)).toBe(true);
  expect(await stock(buyer.baseId)).toMatchObject({ available: (RAW_RESOURCE_STORAGE_MAX - 1n).toString(), market_incoming: '1', pending_output: '0' });
});

it('per-unit price may be below the minimum, but each fill must meet the shared minimum and u64 payment bound', async () => {
  const seller = await fixture(POLICY.minFillBaseUnits.toString()), buyer = await fixture('0'), offer = await list(seller, POLICY.minFillBaseUnits.toString(), '1');
  await expect(fill(seller, buyer, offer)).rejects.toMatchObject({ code: 'KEEP_EQUIPMENT_MARKET_PRICE' });
  expect((await fill(seller, buyer, offer, POLICY.minFillBaseUnits.toString())).totalBaseUnits).toBe(price);
  const large = await fixture('2'), huge = await list(large, '2', ((1n << 64n) - 1n).toString());
  await expect(fill(large, buyer, huge, '2')).rejects.toMatchObject({ code: 'KEEP_EQUIPMENT_MARKET_PRICE' });
  expect((await readKeepEquipmentListing(db, huge.id))?.reservedQuantity).toBe('0');
});

it('fresh writes fail closed without admission, a deed, or fresh finalized evidence; accepted originals still recover', async () => {
  const seller = await fixture(), request = listingRequest(seller, '1');
  await expect(createKeepEquipmentListing(db, seller.wallet, request, seller.authority)).rejects.toMatchObject({ code: 'KEEP_EQUIPMENT_MARKET_DISABLED' });
  await conn.sql`update bases set deed_asset_id=null,land_paid_at=null where id=${seller.baseId}`;
  await expect(createKeepEquipmentListing(db, seller.wallet, request, seller.authority, deps(seller))).rejects.toMatchObject({ code: 'KEEP_EQUIPMENT_MARKET_DEED_REQUIRED' });
  await conn.sql`update bases set deed_asset_id=${seller.deed},land_paid_at=${seller.now.toISOString()}::timestamptz where id=${seller.baseId}`;
  const saved = await createKeepEquipmentListing(db, seller.wallet, request, seller.authority, deps(seller));
  seller.now = new Date(+seller.now + BASE_OWNERSHIP.mutationFreshnessMs + 1);
  await expect(list(seller, '1')).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
  expect(await createKeepEquipmentListing(db, seller.wallet, request, seller.authority)).toEqual(saved);
});

it('the final locked authority and admission rechecks roll back the original listing and stock together', async () => {
  const seller = await fixture(), request = listingRequest(seller, '2'); let checks = 0;
  const authority = { ...seller.authority, assertAuthority: async (...args: Parameters<StableBaseMutationContext['assertAuthority']>) => {
    await seller.authority.assertAuthority(...args); if (++checks === 2) throw Error('Final deed proof expired');
  } };
  await expect(createKeepEquipmentListing(db, seller.wallet, request, authority, deps(seller))).rejects.toThrow('Final deed proof expired');
  expect(await readKeepEquipmentListing(db, request.idempotencyKey)).toBeNull(); expect((await stock(seller.baseId))?.available).toBe('10');
  let gates = 0;
  await expect(createKeepEquipmentListing(db, seller.wallet, request, seller.authority, { ...deps(seller), assertAdmission: () => { if (++gates === 3) throw Error('Market paused'); } })).rejects.toThrow('Market paused');
  expect(await readKeepEquipmentListing(db, request.idempotencyKey)).toBeNull(); expect((await stock(seller.baseId))?.market_outgoing).toBe('0');
});

it('immutable SQL originals, derived cancellation quantities and migration replay cannot duplicate or discard custody', async () => {
  const seller = await fixture(), buyer = await fixture('0'), offer = await list(seller), saved = await fill(seller, buyer, offer, '3');
  await expect(conn.sql`insert into keep_equipment_listing_cancellations(id,listing_id,actor_wallet,quantity,created_at) values(${randomUUID()},${offer.id},${seller.wallet},7,${seller.now.toISOString()}::timestamptz)`).rejects.toMatchObject({ message: 'KEEP_EQUIPMENT_MARKET_TERMS' });
  const before = await stock(seller.baseId);
  await conn.sql`insert into keep_equipment_listings(id,seller_wallet,seller_base_id,item_id,quantity,unit_price_base_units)
    values(${offer.id},${seller.wallet},${seller.baseId},'route_compass',1,${price}) on conflict(id) do nothing`;
  expect(await stock(seller.baseId)).toEqual(before);
  for (const table of ['keep_equipment_listings', 'keep_equipment_fills', 'keep_equipment_listing_cancellations']) {
    if (table === 'keep_equipment_listing_cancellations') await cancel(seller, offer);
    await expect(conn.sql.unsafe(`update ${table} set created_at=created_at where ${table === 'keep_equipment_listings' ? 'id' : 'listing_id'}=$1`, [offer.id])).rejects.toMatchObject({ message: 'KEEP_EQUIPMENT_MARKET_IMMUTABLE' });
    await expect(conn.sql.unsafe(`truncate ${table} cascade`)).rejects.toThrow();
  }
  const original = await readKeepEquipmentListing(db, offer.id), source = await stock(seller.baseId), destination = await stock(buyer.baseId);
  // D195 seals these shared market effects: an older migration may not roll them back.
  await expect(conn.sql.begin(async tx => { for (const statement of readFileSync(new URL('../drizzle/0243_keep_equipment_market.sql', import.meta.url), 'utf8').split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);await tx`select public.shardkeep_divine_fragment_source()`; })).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
  expect(await readKeepEquipmentListing(db, offer.id)).toEqual(original); expect(await readOwnedKeepEquipmentFill(db, buyer.wallet, saved.id)).toEqual(saved);
  expect(await stock(seller.baseId)).toEqual(source); expect(await stock(buyer.baseId)).toEqual(destination);
});
