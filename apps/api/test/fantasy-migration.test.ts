import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { crownlandsMigrationTiles, fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fantasyManifestHash, planFantasyMigration, rehearseFantasyMigration } from '../src/db/fantasyMigration';
import { baseAbandons, bases, baseSlots, fantasyLandClaims, fantasyWorldTiles, ledgerTransactions, plots } from '../src/db/schema';
import { activateHeldFantasyLocation, assertFantasyCatalogContents, getFantasyClaim, requireOrdinaryFantasyTile, resolveFantasyLocation } from '../src/game/fantasyLocation';
import { createTestValley, seedPlot } from './helpers';
import { fantasyBaseFixture } from './fantasy-fixtures';
import { isolatedFantasyTestDb } from './fantasy-test-db';

const conn = isolatedFantasyTestDb(); const db = conn.db;
beforeAll(async () => conn.prepare());
afterAll(async () => conn.dispose());
const identity = () => ({ baseId: randomUUID(), mintId: Keypair.generate().publicKey.toBase58(), ownerWallet: Keypair.generate().publicKey.toBase58() });

describe('frozen fantasy migration foundation', () => {
  it('ranks stable base IDs, preserves prior assignments, and reserves inactive capacity after active deeds', () => {
    const a = identity(); const b = identity(); const dormant = identity(); const snapshotAt = new Date().toISOString();
    const input = { snapshotAt, active: [a, b], inactive: [dormant], exclusions: [] };
    const first = planFantasyMigration(input);
    const reversed = planFantasyMigration({ ...input, active: [b, a] });
    expect(fantasyManifestHash(first)).toBe(fantasyManifestHash(reversed));
    expect(first.entries.map((e) => e.tileId)).toEqual(crownlandsMigrationTiles().slice(0, 3).map((tile) => tile.tileId));
    expect(first.entries[2]?.state).toBe('held');
    const rerun = planFantasyMigration({ ...input, existing: first.entries });
    expect(rerun.entries).toEqual(first.entries);
  });

  it('never turns Solana reservations or ocean/islands into ordinary deeds', () => {
    for (const tile of fantasyTiles('seeker-reach')) expect(() => requireOrdinaryFantasyTile(tile.tileId)).toThrow();
    expect(() => requireOrdinaryFantasyTile(-1)).toThrow();
    expect(() => requireOrdinaryFantasyTile(0)).toThrow();
  });

  it('rejects duplicate non-null retirement mints while allowing distinct deedless exclusions', () => {
    const mintId = identity().mintId;
    const exclusions = [0, 1].map(() => ({ baseId: randomUUID(), mintId, receiptId: randomUUID(), abandonReceiptId: randomUUID() }));
    const input = { snapshotAt: new Date().toISOString(), active: [], inactive: [], exclusions };
    expect(() => planFantasyMigration(input)).toThrow('duplicate positive');
    expect(planFantasyMigration({ ...input, exclusions: exclusions.map(row => ({ ...row, mintId: null })) }).exclusions).toHaveLength(2);
  });

  it('rejects a same-count forged catalog and keeps persisted terrain identities immutable', async () => {
    const correct = [...fantasyTiles()];
    const forged = correct.map((tile, index) => index === 0 ? { ...tile, realmId: 'cinderfall' } : tile);
    expect(() => assertFantasyCatalogContents(forged)).toThrow('differs');
    const reserved = correct.findIndex((tile) => tile.allocation === 'genesis');
    expect(() => assertFantasyCatalogContents(correct.map((tile, i) => i === reserved ? { ...tile, allocation: 'ordinary' } : tile))).toThrow('differs');
    const fixture = await fantasyBaseFixture(db, { installClaim: true });
    const claim = (await getFantasyClaim(db, fixture.baseId))!;
    await expect(db.update(fantasyWorldTiles).set({ realmId: 'cinderfall' }).where(eq(fantasyWorldTiles.tileId, claim.tileId))).rejects.toThrow();
    await expect(db.update(fantasyLandClaims).set({ tileId: crownlandsMigrationTiles()[100]!.tileId }).where(eq(fantasyLandClaims.id, claim.id))).rejects.toThrow();
    await expect(db.delete(fantasyLandClaims).where(eq(fantasyLandClaims.id, claim.id))).rejects.toThrow();
    const another = await fantasyBaseFixture(db);
    await expect(db.insert(plots).values({ baseId: another.baseId, playerWallet: another.wallet,
      addressKind: 'fantasy', fantasyWorldId: claim.worldId, fantasyTileId: claim.tileId })).rejects.toThrow();
  });

  it('keeps paid identity, balances/gameplay roots and legacy plots stable on rehearsal and rerun', async () => {
    const fixture = await fantasyBaseFixture(db);
    const valley = await createTestValley(db, { name: `fantasy-${randomUUID()}` });
    await seedPlot(db, { baseId: fixture.baseId, playerWallet: fixture.wallet, valleyId: valley.id, x: 2, y: 2 });
    const before = await db.select().from(plots).where(eq(plots.baseId, fixture.baseId));
    const used = (await db.select().from(fantasyLandClaims)).map((claim) => claim.tileId);
    const manifest = planFantasyMigration({ snapshotAt: fixture.now.toISOString(), active: [fixture], inactive: [], exclusions: [], unavailableTileIds: used });
    const hash = fantasyManifestHash(manifest);
    await expect(rehearseFantasyMigration(db, manifest, '0'.repeat(64))).rejects.toThrow('hash mismatch');
    expect(await rehearseFantasyMigration(db, manifest, hash)).toMatchObject({ inserted: 1, retained: 0 });
    expect(await rehearseFantasyMigration(db, manifest, hash)).toMatchObject({ inserted: 0, retained: 1 });
    expect(await db.select().from(plots).where(eq(plots.baseId, fixture.baseId))).toEqual(before);
    expect(await resolveFantasyLocation(db, fixture.baseId)).toMatchObject({ realmId: 'crownlands', tileId: manifest.entries[0]!.tileId });
    const [base] = await db.select().from(bases).where(eq(bases.id, fixture.baseId));
    expect(base).toMatchObject({ deedAssetId: fixture.mintId, ownerWallet: fixture.wallet, landPaidAt: fixture.now });
  });

  it('holds inactive land privately until finalized authority and an active owner slot permit activation', async () => {
    const fixture = await fantasyBaseFixture(db, { inactive: true, installClaim: true });
    const held = (await getFantasyClaim(db, fixture.baseId))!;
    expect(held).toMatchObject({ state: 'held' });
    const original = planFantasyMigration({ snapshotAt: fixture.now.toISOString(), active: [], inactive: [fixture], exclusions: [],
      existing: [{ baseId: fixture.baseId, tileId: held.tileId, state: 'held' }] });
    const premature = { ...original, entries: original.entries.map(row => ({ ...row, state: 'assigned' as const })) };
    await expect(rehearseFantasyMigration(db, premature, fantasyManifestHash(premature))).rejects.toThrow('reshuffled');
    expect(await resolveFantasyLocation(db, fixture.baseId)).toBeNull();
    await expect(db.transaction((tx) => activateHeldFantasyLocation(tx, fixture.wallet, fixture.baseId, fixture.now))).rejects.toThrow();
    await db.update(bases).set({ status: 'active' }).where(eq(bases.id, fixture.baseId));
    await db.insert(baseSlots).values({ baseId: fixture.baseId, wallet: fixture.wallet, slot: 1 });
    expect(await db.transaction((tx) => activateHeldFantasyLocation(tx, fixture.wallet, fixture.baseId, fixture.now))).toMatchObject({ realmId: 'crownlands' });
    expect(await getFantasyClaim(db, fixture.baseId)).toMatchObject({ state: 'assigned' });
    expect(await rehearseFantasyMigration(db, original, fantasyManifestHash(original))).toMatchObject({ inserted: 0, retained: 1 });
  });

  it('serializes two bases competing for one destination, retaining exactly one winning claim', async () => {
    const a = await fantasyBaseFixture(db); const b = await fantasyBaseFixture(db);
    const unavailable = (await db.select().from(fantasyLandClaims)).map((c) => c.tileId);
    const plan = (f: typeof a) => planFantasyMigration({ snapshotAt: f.now.toISOString(), active: [f], inactive: [], exclusions: [], unavailableTileIds: unavailable });
    const pa = plan(a); const pb = plan(b);
    const outcomes = await Promise.allSettled([rehearseFantasyMigration(db, pa, fantasyManifestHash(pa)), rehearseFantasyMigration(db, pb, fantasyManifestHash(pb))]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(fantasyLandClaims).where(and(eq(fantasyLandClaims.tileId, pa.entries[0]!.tileId), eq(fantasyLandClaims.state, 'assigned')))).toHaveLength(1);
  });

  it('requires positive receipt identity for retirement, never mere inactive status', async () => {
    const retired = await fantasyBaseFixture(db, { inactive: true });
    const now = new Date(Date.now() + 1_000);
    const [receipt] = await db.insert(ledgerTransactions).values({ type: 'retire.scripted-deed',
      idempotencyKey: `fantasy-test:${randomUUID()}`, metadata: { wallet: retired.wallet }, createdAt: now }).returning();
    const [abandon] = await db.insert(baseAbandons).values({ playerWallet: retired.wallet,
      priorKeepLevel: 1, priorExpansions: 0, buildingsDeleted: 0, obstaclesTombstoned: 0, jobsDeleted: 0, createdAt: now }).returning();
    const manifest = planFantasyMigration({ snapshotAt: now.toISOString(), active: [], inactive: [], exclusions: [{
      baseId: retired.baseId, mintId: retired.mintId, receiptId: receipt!.id, abandonReceiptId: abandon!.id,
    }] });
    await rehearseFantasyMigration(db, manifest, fantasyManifestHash(manifest));
    const unavailable = (await db.select().from(fantasyLandClaims)).map((c) => c.tileId);
    const illicit = planFantasyMigration({ snapshotAt: now.toISOString(), active: [], inactive: [retired], exclusions: [], unavailableTileIds: unavailable });
    await expect(rehearseFantasyMigration(db, illicit, fantasyManifestHash(illicit))).rejects.toThrow();
    const wrong = { ...manifest, exclusions: [{ ...manifest.exclusions[0]!, mintId: Keypair.generate().publicKey.toBase58() }] };
    await expect(rehearseFantasyMigration(db, wrong, fantasyManifestHash(wrong))).rejects.toThrow('Retirement mint');
  });
});
