import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { ECONOMY } from '@shardkeep/shared';
import { FANTASY_WORLD_ID, fantasyTiles, getFantasyTile } from '@shardkeep/shared/fantasyWorld';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bases, deposits, fantasyLandClaims, fantasyPurchaseCutover, players, plotReservations, plots } from '../src/db/schema';
import { fantasyPurchasesCutOver, getFantasyClaim, installFantasyCatalog, resolveFantasyLocation, seedDevFantasyLocation } from '../src/game/fantasyLocation';
import { activateBase, transferStableBase } from '../src/game/baseOwnership';
import { createDepositIntent, creditDeposit, getDeposit, type VerifiedPayment } from '../src/money/deposits';
import { DepositVerificationIndeterminateError, verifyDepositNow } from '../src/money/depositWatcher';
import { createTestPlayer } from './helpers';
import { fantasyBaseFixture } from './fantasy-fixtures';
import { isolatedFantasyTestDb } from './fantasy-test-db';

const conn = isolatedFantasyTestDb(); const db = conn.db;
const originalFantasy = process.env['FANTASY_WORLD_ENABLED']; const originalMulti = process.env['MULTI_BASE_ENABLED'];
let legacyPending: { wallet: string; id: string; baseId: string; earthCell: number; payload: unknown };
beforeAll(async () => {
  await conn.prepare(); await db.transaction(installFantasyCatalog);
  expect(await fantasyPurchasesCutOver(db)).toBe(false);
  // A quote genuinely issued before the one-way native cutover, not a test
  // backdoor that resets the permanent latch between cases.
  process.env['FANTASY_WORLD_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'true';
  const p = await createTestPlayer(db); const legacy = await createDepositIntent(db, p.wallet, 'entry');
  if (!('baseId' in legacy) || !legacy.baseId || !('earthCell' in legacy) || legacy.earthCell === undefined) throw new Error('Expected legacy quote');
  legacyPending = { wallet: p.wallet, id: legacy.id, baseId: legacy.baseId, earthCell: legacy.earthCell,
    payload: (await db.select().from(deposits).where(eq(deposits.id, legacy.id)))[0]!.payload };
});
afterEach(() => { process.env['FANTASY_WORLD_ENABLED'] = 'true'; });
afterAll(async () => {
  if (originalFantasy === undefined) delete process.env['FANTASY_WORLD_ENABLED']; else process.env['FANTASY_WORLD_ENABLED'] = originalFantasy;
  if (originalMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = originalMulti;
  await conn.dispose();
});
async function buyer() {
  process.env['FANTASY_WORLD_ENABLED'] = 'true'; process.env['MULTI_BASE_ENABLED'] = 'true';
  return createTestPlayer(db);
}
async function quote(wallet: string, tileId?: number, now = new Date()) {
  const result = await createDepositIntent(db, wallet, 'entry', { landAddress: {
    kind: 'fantasy', worldId: FANTASY_WORLD_ID, ...(tileId === undefined ? {} : { tileId }),
  } }, now);
  if (!('baseId' in result) || !result.baseId || !('landAddress' in result) || result.landAddress.kind !== 'fantasy') throw new Error('Expected concrete native quote');
  return { ...result, baseId: result.baseId, landAddress: result.landAddress };
}
function payment(wallet: string): VerifiedPayment {
  return { wallet, kind: 'entry', txSignature: `fantasy-test-${randomUUID()}`,
    lamports: BigInt(Math.round(ECONOMY.entryFeeSol * 1e9)), finalized: true };
}

describe('native fantasy land payments', () => {
  it('reserves one concrete tile, returns it on retry, and credits it once while new sales are paused', async () => {
    const p = await buyer(); const intent = await quote(p.wallet); const again = await quote(p.wallet);
    expect(await fantasyPurchasesCutOver(db)).toBe(true);
    expect(await getFantasyClaim(db, legacyPending.baseId)).toMatchObject({ state: 'held', source: 'purchase', depositId: legacyPending.id });
    expect(again.id).toBe(intent.id); expect(again.landAddress).toEqual(intent.landAddress);
    expect(intent.earthCell).toBeUndefined(); expect(intent.countryA3).toBeUndefined();
    const [reservation] = await db.select().from(plotReservations).where(eq(plotReservations.depositId, intent.id));
    expect(reservation).toMatchObject({ addressKind: 'fantasy', earthCell: null, countryA3: null, siteId: null, x: null, y: null });
    process.env['FANTASY_WORLD_ENABLED'] = 'false';
    const paid = payment(p.wallet);
    const results = await Promise.all([creditDeposit(db, intent.id, paid), creditDeposit(db, intent.id, paid)]);
    expect(results.filter((r) => r.credited)).toHaveLength(1);
    const [plot] = await db.select().from(plots).where(eq(plots.baseId, intent.baseId));
    expect(plot).toMatchObject({ addressKind: 'fantasy', fantasyTileId: intent.landAddress.tileId,
      earthCell: null, countryA3: null, valleyId: null, x: null, y: null });
    expect(await resolveFantasyLocation(db, intent.baseId)).toMatchObject({ tileId: intent.landAddress.tileId });
    expect(await getDeposit(db, p.wallet, intent.id)).toMatchObject({ status: 'credited', landAddress: intent.landAddress });
  });

  it('makes concurrent selection of the same tile have exactly one winner', async () => {
    const a = await buyer(); const b = await buyer();
    const used = new Set((await db.select().from(fantasyLandClaims)).map((claim) => claim.tileId));
    const tile = [...fantasyTiles()].find((candidate) => candidate.allocation === 'ordinary' && !used.has(candidate.tileId))!;
    const result = await Promise.allSettled([quote(a.wallet, tile.tileId), quote(b.wallet, tile.tileId)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(fantasyLandClaims).where(eq(fantasyLandClaims.tileId, tile.tileId))).toHaveLength(1);
  });

  it('rejects reserved Solana tiles, non-deeded terrain and new Earth-only clients before payment', async () => {
    const p = await buyer(); const solana = [...fantasyTiles('seeker-reach')][0]!;
    await expect(quote(p.wallet, solana.tileId)).rejects.toMatchObject({ code: 'FANTASY_TILE_UNAVAILABLE' });
    expect(getFantasyTile(0)).toBeNull();
    await expect(quote(p.wallet, 0)).rejects.toMatchObject({ code: 'FANTASY_TILE_UNAVAILABLE' });
    await expect(createDepositIntent(db, p.wallet, 'entry')).rejects.toMatchObject({ code: 'WORLD_UPDATE_REQUIRED' });
    await expect(createDepositIntent(db, p.wallet, 'entry', { earthCell: 1, landAddress: {
      kind: 'fantasy', worldId: FANTASY_WORLD_ID,
    } })).rejects.toMatchObject({ code: 'INVALID_LAND_ADDRESS' });
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, p.wallet))).toHaveLength(0);
  });

  it('preserves a legacy pending payment payload and Earth binding while settling its held Crownlands destination', async () => {
    const legacy = legacyPending;
    // A paused cutover still recovers issued Earth intents into Crownlands.
    process.env['FANTASY_WORLD_ENABLED'] = 'false';
    const retry = await createDepositIntent(db, legacy.wallet, 'entry', { landAddress: { kind: 'fantasy', worldId: FANTASY_WORLD_ID } });
    expect(retry.id).toBe(legacy.id);
    expect((await db.select().from(deposits).where(eq(deposits.id, legacy.id)))[0]?.payload).toEqual(legacy.payload);
    await creditDeposit(db, legacy.id, payment(legacy.wallet));
    const [plot] = await db.select().from(plots).where(eq(plots.baseId, legacy.baseId));
    expect(plot).toMatchObject({ addressKind: 'legacy-earth', earthCell: legacy.earthCell });
    expect(await resolveFantasyLocation(db, legacy.baseId)).toMatchObject({ realmId: 'crownlands' });
  });

  it('never reopens Earth allocation after cutover even while new purchases are paused', async () => {
    const p = await buyer(); process.env['FANTASY_WORLD_ENABLED'] = 'false';
    await expect(createDepositIntent(db, p.wallet, 'entry')).rejects.toMatchObject({ code: 'LAND_PURCHASES_PAUSED' });
    await expect(quote(p.wallet)).rejects.toMatchObject({ code: 'LAND_PURCHASES_PAUSED' });
    await expect(db.delete(fantasyPurchaseCutover)).rejects.toThrow();
    await expect(db.update(fantasyPurchaseCutover).set({ activatedAt: new Date() })).rejects.toThrow();
    // Old binaries cannot bypass the API guard by inserting another reservation.
    const [prior] = await db.select().from(plotReservations).where(eq(plotReservations.depositId, legacyPending.id));
    await expect(db.transaction(async (tx) => {
      const b = { wallet: Keypair.generate().publicKey.toBase58() };
      await tx.insert(players).values(b);
      const [base] = await tx.insert(bases).values({ ownerWallet: b.wallet, status: 'inactive' }).returning();
      const [deposit] = await tx.insert(deposits).values({ playerWallet: b.wallet, kind: 'entry', reference: randomUUID() }).returning();
      await tx.insert(plotReservations).values({ depositId: deposit!.id, baseId: base!.id,
        earthCell: prior!.earthCell, countryA3: prior!.countryA3, siteId: prior!.siteId,
        x: prior!.x, y: prior!.y, expiresAt: new Date(Date.now() + 60_000) });
    })).rejects.toThrow();
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, p.wallet))).toHaveLength(0);
  });

  it('requires credited payment for direct assignment and proven unpaid expiry for release', async () => {
    const p = await buyer(); const intent = await quote(p.wallet);
    await expect(db.update(fantasyLandClaims).set({ state: 'assigned', assignedAt: new Date() })
      .where(eq(fantasyLandClaims.depositId, intent.id))).rejects.toThrow();
    await expect(db.update(fantasyLandClaims).set({ state: 'released', releasedAt: new Date() })
      .where(eq(fantasyLandClaims.depositId, intent.id))).rejects.toThrow();
    // Address tampering must roll back the whole credit, including its status.
    await db.update(deposits).set({ payload: sql`jsonb_set(payload, '{landAddress,tileId}', '0'::jsonb)` }).where(eq(deposits.id, intent.id));
    await expect(creditDeposit(db, intent.id, payment(p.wallet))).rejects.toThrow('address changed');
    expect((await db.select().from(deposits).where(eq(deposits.id, intent.id)))[0]?.status).toBe('pending');
    expect(await getFantasyClaim(db, intent.baseId)).toMatchObject({ state: 'held', tileId: intent.landAddress.tileId });
  });

  it('releases only proven unsigned expiry; ambiguous verification keeps the exact held destination', async () => {
    const p = await buyer(); const old = new Date(Date.now() - (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    const intent = await quote(p.wallet, undefined, old);
    await db.update(deposits).set({ createdAt: old }).where(eq(deposits.id, intent.id));
    await expect(verifyDepositNow(db, async () => { throw new DepositVerificationIndeterminateError(intent.reference); }, p.wallet, intent.id)).rejects.toThrow();
    expect(await getFantasyClaim(db, intent.baseId)).toMatchObject({ state: 'held', tileId: intent.landAddress.tileId });
    expect(await verifyDepositNow(db, async () => null, p.wallet, intent.id)).toEqual({ action: 'expired' });
    expect(await getFantasyClaim(db, intent.baseId)).toBeNull();
    expect((await db.select().from(fantasyLandClaims).where(eq(fantasyLandClaims.depositId, intent.id)))[0]?.state).toBe('released');
  });

  it('retains a paid-but-failed destination for explicit reconciliation', async () => {
    const p = await buyer(); const intent = await quote(p.wallet);
    const old = new Date(Date.now() - (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    await db.update(deposits).set({ createdAt: old }).where(eq(deposits.id, intent.id));
    const paid = { ...payment(p.wallet), lamports: 1n };
    expect(await verifyDepositNow(db, async () => paid, p.wallet, intent.id)).toEqual({ action: 'failed' });
    expect(await getFantasyClaim(db, intent.baseId)).toMatchObject({ state: 'held', tileId: intent.landAddress.tileId });
    expect((await db.select().from(bases).where(eq(bases.id, intent.baseId)))[0]?.landPaidAt).toBeNull();
  });

  it('consumes the same held tile through activation and through a finalized transfer that activates the recipient', async () => {
    await buyer();
    const dormant = await fantasyBaseFixture(db, { inactive: true, installClaim: true });
    const reserved = (await getFantasyClaim(db, dormant.baseId))!;
    process.env['FANTASY_WORLD_ENABLED'] = 'false';
    await activateBase(db, dormant.wallet, dormant.baseId);
    expect(await resolveFantasyLocation(db, dormant.baseId)).toMatchObject({ tileId: reserved.tileId });
    const transferred = await fantasyBaseFixture(db, { inactive: true, installClaim: true });
    const prior = (await getFantasyClaim(db, transferred.baseId))!;
    const recipient = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet: recipient });
    expect(await transferStableBase(db, transferred.baseId, transferred.wallet, recipient, transferred.mintId, {
      owner: recipient, collection: 'test-collection', frozen: false, delegate: null, slot: 101, observedAtMs: Date.now(),
    })).toMatchObject({ active: true });
    expect(await resolveFantasyLocation(db, transferred.baseId)).toMatchObject({ tileId: prior.tileId });
  });

  it('keeps development payment bypass local and creates no NFT while preserving native placement repair', async () => {
    const fixture = await fantasyBaseFixture(db);
    const before = process.env['DEV_LOGIN']; const priorEnvironment = process.env['NODE_ENV'];
    try {
      process.env['DEV_LOGIN'] = 'false';
      await expect(seedDevFantasyLocation(db, fixture.wallet, fixture.baseId)).rejects.toThrow('non-production');
      process.env['DEV_LOGIN'] = 'true'; process.env['NODE_ENV'] = 'production';
      await expect(seedDevFantasyLocation(db, fixture.wallet, fixture.baseId)).rejects.toThrow('non-production');
      process.env['NODE_ENV'] = 'test';
      const tile = await seedDevFantasyLocation(db, fixture.wallet, fixture.baseId, 'frostveil');
      expect(tile.realmId).toBe('frostveil');
      expect(await seedDevFantasyLocation(db, fixture.wallet, fixture.baseId)).toEqual(tile);
      expect((await db.select().from(bases).where(eq(bases.id, fixture.baseId)))[0]?.deedAssetId).toBe(fixture.mintId);
      expect((await db.select().from(deposits).where(eq(deposits.reference, `dev-fantasy:${fixture.baseId}`)))[0]).toMatchObject({ amount: 0n });
    } finally {
      if (before === undefined) delete process.env['DEV_LOGIN']; else process.env['DEV_LOGIN'] = before;
      if (priorEnvironment === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = priorEnvironment;
    }
  });
});
