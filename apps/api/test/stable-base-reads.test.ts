import { requiredFixture } from './helpers';
/**
 * Stable deed ownership is a base-id handoff, never a rewrite of legacy child
 * wallet columns. These assertions pin the failure mode that motivated the
 * multi-base read cutover: every public surface must show the buyer and the
 * purchased structures even while those denormalized columns still name the
 * seller, and unrelated buyer rows must never leak into the purchased base.
 */
import { BuildingType } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseProfiles, bases, baseSlots, buildings, players, plots, shields } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { buildDeedMetadata, buildDeedMetadataForAsset } from '../src/game/deedMetadata';
import { sweepDeedMetadata, type ObjectPutter } from '../src/game/deedR2';
import { globeContext } from '../src/game/globe';
import { getItems } from '../src/game/items';
import { ensureWalletBaseIdentity, transferStableBase } from '../src/game/baseOwnership';
import { ensurePlotAssigned, getMapChunk, getParcelDetail, scoutBase, searchPlayers } from '../src/game/world';
import { bootstrapSystemAccounts } from '../src/ledger';
import { resetGlobeCache } from '../src/lib/globeCache';
import { resetMapCache } from '../src/lib/mapCache';
import { connectTestDb, createTestPlayer, createTestValley, seedPlots } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
const priorLocation = process.env['DEED_LOCATION_V2'];

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});

afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  if (priorLocation === undefined) delete process.env['DEED_LOCATION_V2'];
  else process.env['DEED_LOCATION_V2'] = priorLocation;
  resetMapCache();
  resetGlobeCache();
  await conn.sql.end();
});

describe('stable-base public reads', () => {
  it('follows a sold deed to its buyer without rewriting or mixing child wallet rows', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'false';
    process.env['DEED_LOCATION_V2'] = 'true';

    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const viewer = await createTestPlayer(db);
    const deed = `stable-read-deed-${seller.wallet}`;

    await ensureStartingBase(db, seller.wallet);
    await db.update(players).set({
      name: `STALE_SELLER_${seller.wallet.slice(0, 6)}`,
      keepLevel: 6,
      expansions: 2,
      trophies: 777,
      deedAssetId: deed,
      entryPaidAt: new Date('2026-01-02T00:00:00.000Z'),
    }).where(eq(players.wallet, seller.wallet));
    const place = await ensurePlotAssigned(db, seller.wallet);
    const soldBaseId = await ensureWalletBaseIdentity(db, seller.wallet);
    expect(soldBaseId).not.toBeNull();
    const [soldPlot] = await db.select({ earthCell: plots.earthCell }).from(plots)
      .where(eq(plots.baseId, soldBaseId!));

    const [soldCannon] = await db.insert(buildings).values({
      playerWallet: seller.wallet,
      baseId: soldBaseId!,
      type: BuildingType.Cannon,
      level: 4,
      tx: 18,
      ty: 18,
    }).returning({ id: buildings.id });
    const [buyerDecoy] = await db.insert(buildings).values({
      playerWallet: buyer.wallet,
      type: BuildingType.Wall,
      level: 1,
      tx: 9,
      ty: 9,
    }).returning({ id: buildings.id });
    await db.insert(buildings).values({
      playerWallet: buyer.wallet,
      type: BuildingType.SiegeStool,
      level: 1,
      tx: 6,
      ty: 6,
    });
    await db.insert(buildings).values({
      playerWallet: seller.wallet,
      baseId: soldBaseId!,
      type: BuildingType.HeroAltar,
      level: 1,
      tx: 12,
      ty: 12,
    });
    await db.insert(shields).values({
      playerWallet: seller.wallet,
      baseId: soldBaseId!,
      source: 'loss',
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });

    await ensureStartingBase(db, viewer.wallet);
    await db.update(players).set({
      name: `STABLE_VIEWER_${viewer.wallet.slice(0, 6)}`,
      entryPaidAt: new Date('2026-01-03T00:00:00.000Z'),
      deedAssetId: `viewer-deed-${viewer.wallet}`,
      trophies: 500,
    }).where(eq(players.wallet, viewer.wallet));
    await ensurePlotAssigned(db, viewer.wallet);
    await ensureWalletBaseIdentity(db, viewer.wallet);

    await db.update(players).set({
      name: `CURRENT_BUYER_${buyer.wallet.slice(0, 6)}`,
      // A decoy wallet score proves public surfaces read the deed profile.
      trophies: 999,
    }).where(eq(players.wallet, buyer.wallet));
    await db.insert(baseProfiles).values({ baseId: soldBaseId!, trophies: 333 })
      .onConflictDoUpdate({ target: baseProfiles.baseId, set: { trophies: 333 } });
    await transferStableBase(db, soldBaseId!, seller.wallet, buyer.wallet, deed);

    // This is the invariant: transfer changes only stable authority. Reintroducing
    // a wallet join would therefore show the seller or the unrelated buyer wall.
    const [child] = await db.select({ wallet: buildings.playerWallet }).from(buildings)
      .where(eq(buildings.id, soldCannon!.id));
    expect(child!.wallet).toBe(seller.wallet);
    const [owner] = await db.select({ wallet: bases.ownerWallet }).from(bases)
      .where(eq(bases.id, soldBaseId!));
    expect(owner!.wallet).toBe(buyer.wallet);

    process.env['MULTI_BASE_ENABLED'] = 'true';
    resetMapCache();
    resetGlobeCache();

    const map = await getMapChunk(db, buyer.wallet, {
      valleyId: place.valleyId,
      x0: 0,
      y0: 0,
      x1: 24,
      y1: 19,
    });
    const marker = map.markers.find((m) => m.kind === 'player' && m.baseId === soldBaseId);
    expect(marker).toMatchObject({
      kind: 'player',
      baseId: soldBaseId,
      wallet: buyer.wallet,
      name: `CURRENT_BUYER_${buyer.wallet.slice(0, 6)}`,
      keepLevel: 6,
      trophies: 333,
      shielded: true,
    });
    expect(map.markers.some((m) => m.kind === 'player' && m.wallet === seller.wallet)).toBe(false);

    // The map assertion above proves the active shield follows the sold base.
    // Inspect the same stable geometry after that shield expires; scouting an
    // actively shielded base is correctly forbidden.
    const scout = await scoutBase(db, viewer.wallet, soldBaseId!, new Date('2027-01-02T00:00:00.000Z'));
    expect(scout).toMatchObject({ wallet: buyer.wallet, baseId: soldBaseId, keepLevel: 6 });
    expect(scout.buildings.map((row) => row.id)).toContain(soldCannon!.id);
    expect(scout.buildings.map((row) => row.id)).not.toContain(buyerDecoy!.id);
    const inventory = await getItems(db, buyer.wallet, soldBaseId!);
    expect(inventory.heroLoadouts.find((hero) => hero.hero === 'vex')?.recruited).toBe(true);
    expect(inventory.heroLoadouts.find((hero) => hero.hero === 'theodor')?.recruited).toBe(false);

    const detail = await getParcelDetail(db, viewer.wallet, requiredFixture(soldPlot!.earthCell));
    expect(detail.player).toMatchObject({ wallet: buyer.wallet, keepLevel: 6, trophies: 333 });
    expect(detail.base.id).toBe(soldBaseId);
    expect(detail.deed.assetId).toBe(deed);
    expect(detail.deed.metadata.attributes).toContainEqual({ trait_type: 'Keep Level', value: 6 });
    expect(detail.deed.metadata.attributes).toContainEqual({
      trait_type: 'Location', value: `Earth Cell ${soldPlot!.earthCell}`,
    });
    expect(JSON.stringify(detail.deed.metadata)).not.toContain(`${place.x},${place.y}`);

    const metadata = await buildDeedMetadataForAsset(db, deed);
    expect(metadata?.attributes).toContainEqual({ trait_type: 'Keep Level', value: 6 });
    expect(metadata?.attributes.find((trait) => trait.trait_type === 'Buildings')?.value)
      .toBe(scout.buildings.length);

    const globe = await globeContext(db, buyer.wallet);
    expect(globe.me.valleyId).toBe(place.valleyId);
    expect(globe.me.parcel?.earthCell).toBe(soldPlot!.earthCell);
    const found = await searchPlayers(db, `CURRENT_BUYER_${buyer.wallet.slice(0, 6)}`);
    expect(found.results).toContainEqual(expect.objectContaining({
      baseId: soldBaseId,
      wallet: buyer.wallet,
      keepLevel: 6,
    }));

    const [sellerState, buyerState] = await Promise.all([
      db.select({ name: players.name, trophies: players.trophies }).from(players)
        .where(eq(players.wallet, seller.wallet)).then((rows) => rows[0]),
      db.select({ name: players.name, trophies: players.trophies }).from(players)
        .where(eq(players.wallet, buyer.wallet)).then((rows) => rows[0]),
    ]);
    expect(sellerState).toMatchObject({
      name: `STALE_SELLER_${seller.wallet.slice(0, 6)}`,
      trophies: 777,
    });
    expect(buyerState).toMatchObject({
      name: `CURRENT_BUYER_${buyer.wallet.slice(0, 6)}`,
      trophies: 999,
    });
  });

  it('publishes one canonical image per deed and refuses an ambiguous wallet alias', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'false';
    const owner = await createTestPlayer(db);
    const firstDeed = `stable-image-a-${owner.wallet}`;
    const secondDeed = `stable-image-b-${owner.wallet}`;
    await db.update(players).set({
      entryPaidAt: new Date('2026-02-01T00:00:00.000Z'), deedAssetId: firstDeed,
    }).where(eq(players.wallet, owner.wallet));
    await ensureStartingBase(db, owner.wallet);
    const firstBaseId = await ensureWalletBaseIdentity(db, owner.wallet);
    expect(firstBaseId).not.toBeNull();
    const [secondBase] = await db.insert(bases).values({
      ownerWallet: owner.wallet,
      deedAssetId: secondDeed,
      keepLevel: 2,
      landPaidAt: new Date('2026-02-02T00:00:00.000Z'),
    }).returning({ id: bases.id });
    await db.insert(baseSlots).values({ wallet: owner.wallet, slot: 2, baseId: secondBase!.id });

    process.env['MULTI_BASE_ENABLED'] = 'true';
    // A wallet-keyed document cannot pick one of two conveyed bases honestly.
    expect(await buildDeedMetadata(db, owner.wallet)).toBeNull();

    const puts = new Map<string, string>();
    const put: ObjectPutter = async (key, body) => { puts.set(key, body.toString()); };
    await sweepDeedMetadata(db, put, new Map(), {
      publicBaseUrl: 'https://deeds.test',
      lastImageHash: new Map(),
      renderAvailable: false,
      pngKnown: new Map([[firstBaseId!, true], [secondBase!.id, true]]),
    });

    const first = JSON.parse(puts.get(`deed/asset/${firstDeed}.json`)!) as { image: string };
    const second = JSON.parse(puts.get(`deed/asset/${secondDeed}.json`)!) as { image: string };
    expect(first.image).toContain(`/deed/asset/${firstDeed}.png?v=`);
    expect(second.image).toContain(`/deed/asset/${secondDeed}.png?v=`);
    expect(first.image).not.toBe(second.image);
    expect(puts.has(`deed/${owner.wallet}.json`)).toBe(false);
  });

  it('binds map and globe home context to the requested active base, never slot order', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'true';
    resetMapCache();
    resetGlobeCache();

    const owner = await createTestPlayer(db);
    const paidAt = new Date('2026-03-01T00:00:00.000Z');
    const [first, second, inactive] = await db.insert(bases).values([
      { ownerWallet: owner.wallet, keepLevel: 3, landPaidAt: paidAt },
      { ownerWallet: owner.wallet, keepLevel: 7, landPaidAt: paidAt },
      {
        ownerWallet: owner.wallet, keepLevel: 5, landPaidAt: paidAt,
        status: 'inactive',
      },
    ]).returning({ id: bases.id });
    await db.insert(baseSlots).values([
      { wallet: owner.wallet, slot: 1, baseId: first!.id },
      { wallet: owner.wallet, slot: 2, baseId: second!.id },
    ]);
    const firstValley = await createTestValley(db, { name: `selected-a-${owner.wallet}` });
    const secondValley = await createTestValley(db, { name: `selected-b-${owner.wallet}` });
    const inactiveValley = await createTestValley(db, { name: `inactive-${owner.wallet}` });
    await seedPlots(db, [
      {
        valleyId: firstValley.id, x: 4, y: 5,
        playerWallet: owner.wallet, baseId: first!.id,
      },
      {
        valleyId: secondValley.id, x: 8, y: 9,
        playerWallet: owner.wallet, baseId: second!.id,
      },
      {
        valleyId: inactiveValley.id, x: 12, y: 13,
        playerWallet: owner.wallet, baseId: inactive!.id,
      },
    ]);

    // WHY: slot 1 is capacity, not selection. A bare read from a two-base
    // wallet must fail loudly instead of making every device show the first deed.
    await expect(getMapChunk(db, owner.wallet, {
      x0: 0, y0: 0, x1: 24, y1: 19,
    })).rejects.toMatchObject({ code: 'BASE_ID_REQUIRED' });
    await expect(globeContext(db, owner.wallet))
      .rejects.toMatchObject({ code: 'BASE_ID_REQUIRED' });

    const firstMap = await getMapChunk(db, owner.wallet, {
      baseId: first!.id, x0: 0, y0: 0, x1: 24, y1: 19,
    });
    const secondMap = await getMapChunk(db, owner.wallet, {
      baseId: second!.id, x0: 0, y0: 0, x1: 24, y1: 19,
    });
    expect(firstMap).toMatchObject({ valleyId: firstValley.id, visiting: false });
    expect(secondMap).toMatchObject({ valleyId: secondValley.id, visiting: false });
    expect(firstMap.markers.find((m) => m.kind === 'player' && m.isMe))
      .toMatchObject({ baseId: first!.id, keepLevel: 3 });
    expect(secondMap.markers.find((m) => m.kind === 'player' && m.isMe))
      .toMatchObject({ baseId: second!.id, keepLevel: 7 });

    const firstGlobe = await globeContext(db, owner.wallet, new Date(), first!.id);
    const secondGlobe = await globeContext(db, owner.wallet, new Date(), second!.id);
    expect(firstGlobe.me.valleyId).toBe(firstValley.id);
    expect(secondGlobe.me.valleyId).toBe(secondValley.id);
    expect(firstGlobe.me.parcel).toMatchObject({ x: 4, y: 5 });
    expect(secondGlobe.me.parcel).toMatchObject({ x: 8, y: 9 });

    // WHY: selected base is a Home camera choice, never an ownership filter.
    // Opening either active base must yield the same complete deed overlay, and a
    // paid deed that does not consume an active slot remains owned and visible.
    expect(firstGlobe.me.ownedParcels).toEqual(secondGlobe.me.ownedParcels);
    expect(firstGlobe.me.ownedParcels).toHaveLength(3);
    expect(firstGlobe.me.ownedParcels.map((owned) => owned.baseId).sort())
      .toEqual([first!.id, second!.id, inactive!.id].sort());
    expect(firstGlobe.me.ownedParcels.find((owned) => owned.baseId === first!.id))
      .toMatchObject({ active: true, valleyId: firstValley.id, parcel: { x: 4, y: 5 } });
    expect(firstGlobe.me.ownedParcels.find((owned) => owned.baseId === second!.id))
      .toMatchObject({ active: true, valleyId: secondValley.id, parcel: { x: 8, y: 9 } });
    expect(firstGlobe.me.ownedParcels.find((owned) => owned.baseId === inactive!.id))
      .toMatchObject({ active: false, valleyId: inactiveValley.id, parcel: { x: 12, y: 13 } });
  });
});
