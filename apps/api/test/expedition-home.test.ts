/** A3a authority only. Synthetic DB fixtures cannot bypass the production
 * helper's authority/provenance checks; there is no dispatch or stock writer. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { PHASE_E_STARTER_ACCESS } from '@shardkeep/shared';
import { fantasyTiles, FANTASY_CATALOG_HASH, FANTASY_WORLD_ID } from '@shardkeep/shared/fantasyWorld';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseAbandons, baseRaidLocks, bases, baseSlots, deposits, deedOwnershipObservations, expeditionFreeHomes, fantasyLandClaims, fantasyRetirementExclusions, fantasyWorldCatalog, fantasyWorldTiles, ledgerTransactions, players, raids } from '../src/db/schema';
import { assertFreshLockedBaseAuthority, registerOwnedDeed, transferStableBase } from '../src/game/baseOwnership';
import { ExpeditionHomeEvidenceSchema, readExpeditionHomePreview, resolveExpeditionHome } from '../src/game/expeditionHome';
import { installFantasyCatalog } from '../src/game/fantasyLocation';
import { fantasyBaseFixture } from './fantasy-fixtures';
import { isolatedFantasyTestDb } from './fantasy-test-db';
import { createTestPlayer } from './helpers';

const conn = isolatedFantasyTestDb(), db = conn.db;
beforeAll(async () => { await conn.prepare(); await db.transaction(installFantasyCatalog); }, 120_000);
afterAll(() => conn.dispose());
const authority = (baseId: string) => ({ baseId, assertAuthority: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], wallet: string, id: string) => { await assertFreshLockedBaseAuthority(tx, wallet, id); } });
const home = (f: { wallet: string; baseId: string }) => resolveExpeditionHome(db, f.wallet, authority(f.baseId));
const preview = (f: { wallet: string; baseId: string }) => db.transaction(async tx => {
  await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
  const [base] = await tx.select().from(bases).where(and(eq(bases.id, f.baseId), eq(bases.ownerWallet, f.wallet), eq(bases.status, 'active'))).for('update');
  const [slot] = await tx.select().from(baseSlots).where(and(eq(baseSlots.baseId, f.baseId), eq(baseSlots.wallet, f.wallet), eq(baseSlots.active, true))).for('update');
  if (!base || !slot) throw new Error('Preview fixture lacks current custody');
  await assertFreshLockedBaseAuthority(tx, f.wallet, f.baseId);
  return readExpeditionHomePreview(tx, base);
});
async function free() {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
  await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });
  return { wallet, baseId: base!.id };
}
async function purchaseClaim(f: { wallet: string; baseId: string }, options: { held?: boolean; dev?: boolean; world?: string } = {}) {
  const used = new Set((await db.select().from(fantasyLandClaims)).map(c => c.tileId));
  const tile = [...fantasyTiles('elderwood')].find(t => t.allocation === 'ordinary' && !used.has(t.tileId))!;
  const [deposit] = await db.insert(deposits).values({ playerWallet: f.wallet, kind: 'entry',
    reference: `home-test:${randomUUID()}`, status: options.held ? 'pending' : 'credited',
    payload: { baseId: f.baseId, ...(options.dev ? { devFixture: true } : {}) },
  }).returning();
  const [claim] = await db.insert(fantasyLandClaims).values({ baseId: f.baseId, source: 'purchase', depositId: deposit!.id,
    worldId: options.world ?? tile.worldId, tileId: tile.tileId, state: options.held ? 'held' : 'assigned',
    assignedAt: options.held ? null : new Date() }).returning();
  return { claim: claim!, deposit: deposit!, tile };
}

describe('authenticated explicit home authority', () => {
  it('previews free policy without assigning a home, then projects only public persisted evidence', async () => {
    const f = await free();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await preview(f)).toEqual({ source: 'free_policy_preview', version: PHASE_E_STARTER_ACCESS.policyVersion,
        realmId: PHASE_E_STARTER_ACCESS.freeHomeRealm });
      expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toEqual([]);
    }
    const accepted = await home(f);
    expect(await preview(f)).toEqual({ source: 'free_assignment', version: accepted.evidence.version, realmId: accepted.realmId });
    expect((await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId)))[0]!.id).toBe(accepted.evidence.id);
  });

  it('lazily assigns one immutable Crownlands home under concurrent commands and reauthorizes every read', async () => {
    const f = await free();
    expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toEqual([]);
    const all = await Promise.all(Array.from({ length: 4 }, () => home(f)));
    expect(all.every(e => e.evidence.id === all[0]!.evidence.id)).toBe(true);
    expect(all[0]).toMatchObject({ baseId: f.baseId, custodyWallet: f.wallet, source: 'free_assignment', realmId: PHASE_E_STARTER_ACCESS.freeHomeRealm,
      evidence: { version: PHASE_E_STARTER_ACCESS.policyVersion, assignedWallet: f.wallet } });
    expect(await resolveExpeditionHome(db, f.wallet, authority(f.baseId.toUpperCase()))).toEqual(all[0]);
    await expect(resolveExpeditionHome(db, f.wallet, { baseId: f.baseId, assertAuthority: async () => { throw new Error('unavailable'); } })).rejects.toThrow('unavailable');
    expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toHaveLength(1);
  });

  it.each(['wallet', 'slot', 'inactive', 'authority'] as const)('refuses %s before any new assignment', async failure => {
    const f = await free();
    let wallet = f.wallet;
    if (failure === 'wallet') wallet = (await createTestPlayer(db)).wallet;
    if (failure === 'slot') await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    if (failure === 'inactive') await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    const context = authority(f.baseId);
    if (failure === 'authority') context.assertAuthority = async () => { throw new Error('finalized unavailable'); };
    await expect(resolveExpeditionHome(db, wallet, context)).rejects.toThrow();
    expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toEqual([]);
  });

  it.each(['paid', 'mint', 'minting'] as const)('does not reuse prior free home when %s identity is incomplete', async state => {
    const f = await free(), original = await home(f);
    if (state === 'minting') {
      // 0072 rejects timestamp-only writers. Exercise a lawful in-progress
      // exact mint, not a fixture update that fails before home admission.
      await expect(db.update(bases).set({ deedMintingAt: new Date() }).where(eq(bases.id, f.baseId))).rejects.toThrow();
      await db.transaction(async tx => {
        await tx.execute(sql`select set_config('shardkeep.fixed_deed_mint_claim', 'on', true)`);
        await tx.update(bases).set({ deedMintAssetId: Keypair.generate().publicKey.toBase58(), deedMintingAt: new Date() })
          .where(eq(bases.id, f.baseId));
      });
    } else await db.update(bases).set(state === 'paid' ? { landPaidAt: new Date() }
      : { deedMintAssetId: Keypair.generate().publicKey.toBase58() }).where(eq(bases.id, f.baseId));
    await expect(home(f)).rejects.toThrow();
    // Pending exact mint recovery quarantines current reads before the home
    // projection. Paid-but-unminted land without that identity is unavailable.
    if (state === 'paid') expect(await preview(f)).toBeNull();
    else await expect(preview(f)).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect((await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId)))[0]!.id).toBe(original.evidence.id);
  });

  it('does not infer a realm from missing real deed location or another owned deed', async () => {
    const f = await fantasyBaseFixture(db), assigned = await fantasyBaseFixture(db, { installClaim: true });
    await home(assigned);
    await expect(home(f)).rejects.toMatchObject({ code: 'EXPEDITION_HOME_UNAVAILABLE' });
    // Move the unrelated deed into the same wallet: only f.baseId matters.
    await transferStableBase(db, assigned.baseId, assigned.wallet, f.wallet, assigned.mintId, { owner: f.wallet, collection: 'test', frozen: false, delegate: null, slot: 101, observedAtMs: Date.now() });
    await expect(home(f)).rejects.toMatchObject({ code: 'EXPEDITION_HOME_UNAVAILABLE' });
  });

  it('uses a real assigned purchase with nullable expectedMint, never a held destination', async () => {
    const f = await fantasyBaseFixture(db), p = await purchaseClaim(f);
    expect(p.claim.expectedMint).toBeNull();
    expect(await home(f)).toMatchObject({ source: 'deed_location', realmId: p.tile.realmId,
      evidence: { id: p.claim.id, deedAssetId: f.mintId, worldId: FANTASY_WORLD_ID, tileId: p.tile.tileId, catalogHash: FANTASY_CATALOG_HASH } });
    expect(await preview(f)).toEqual({ source: 'deed_location', version: 1, realmId: p.tile.realmId });
    const held = await fantasyBaseFixture(db); await purchaseClaim(held, { held: true });
    await expect(home(held)).rejects.toMatchObject({ code: 'EXPEDITION_HOME_UNAVAILABLE' });
    expect(await preview(held)).toBeNull();
  });

  it('rejects development purchase provenance without depending on NODE_ENV', async () => {
    const f = await fantasyBaseFixture(db); await purchaseClaim(f, { dev: true });
    await expect(home(f)).rejects.toMatchObject({ code: 'EXPEDITION_HOME_UNAVAILABLE' });
    expect(await preview(f)).toBeNull();
  });

  it('refuses a raided free base before assignment', async () => {
    const f = await free(), attacker = await free();
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet,
      attackerBaseId: attacker.baseId, defenderWallet: f.wallet, defenderBaseId: f.baseId,
      seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: 9, ordersDeadlineAt: new Date(Date.now() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, expiresAt: new Date(Date.now() + 60_000) });
    expect(await preview(f)).toEqual({ source: 'free_policy_preview', version: PHASE_E_STARTER_ACCESS.policyVersion,
      realmId: PHASE_E_STARTER_ACCESS.freeHomeRealm });
    await expect(home(f)).rejects.toMatchObject({ code: 'BASE_BEING_RAIDED' });
    expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toEqual([]);
  });

  it('refuses a positively retired base even if its stale active slot remains', async () => {
    const f = await fantasyBaseFixture(db), now = new Date();
    const [receipt] = await db.insert(ledgerTransactions).values({ type: 'retire.scripted-deed',
      idempotencyKey: `home-retire:${randomUUID()}`, metadata: { wallet: f.wallet }, createdAt: now }).returning();
    const [abandon] = await db.insert(baseAbandons).values({ playerWallet: f.wallet, priorKeepLevel: 1,
      priorExpansions: 0, buildingsDeleted: 0, obstaclesTombstoned: 0, jobsDeleted: 0, createdAt: now }).returning();
    await db.insert(fantasyRetirementExclusions).values({ baseId: f.baseId, mintId: f.mintId,
      receiptId: receipt!.id, abandonReceiptId: abandon!.id, evidenceHash: '0'.repeat(64) });
    await expect(home(f)).rejects.toMatchObject({ code: 'EXPEDITION_HOME_UNAVAILABLE' });
    expect(await preview(f)).toBeNull();
  });

  it('cannot persist a purchase claim bound to a different mint and then infer a home', async () => {
    const f = await fantasyBaseFixture(db);
    const used = new Set((await db.select().from(fantasyLandClaims)).map(c => c.tileId));
    const tile = [...fantasyTiles('elderwood')].find(t => t.allocation === 'ordinary' && !used.has(t.tileId))!;
    const [deposit] = await db.insert(deposits).values({ playerWallet: f.wallet, kind: 'entry',
      reference: `home-test:${randomUUID()}`, status: 'credited', payload: { baseId: f.baseId } }).returning();
    await expect(db.insert(fantasyLandClaims).values({ baseId: f.baseId, source: 'purchase', depositId: deposit!.id,
      worldId: tile.worldId, tileId: tile.tileId, state: 'assigned', assignedAt: new Date(),
      expectedMint: Keypair.generate().publicKey.toBase58() })).rejects.toThrow();
    await expect(home(f)).rejects.toMatchObject({ code: 'EXPEDITION_HOME_UNAVAILABLE' });
  });

  it('first-land upgrade uses the new actual realm and retains immutable free evidence', async () => {
    const f = await free(), original = await home(f), mint = Keypair.generate().publicKey.toBase58();
    const upgraded = await registerOwnedDeed(db, f.wallet, mint);
    expect(upgraded.id).toBe(f.baseId);
    await db.insert(deedOwnershipObservations).values({ baseId: f.baseId, assetId: mint, owner: f.wallet, slot: 100n,
      checkedAt: new Date(), status: 'owned', source: 'rpc-finalized', auditHash: randomUUID() });
    const p = await purchaseClaim(f);
    expect(await home(f)).toMatchObject({ source: 'deed_location', realmId: 'elderwood', evidence: { id: p.claim.id } });
    const [stored] = await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId));
    expect(stored).toMatchObject({ id: original.evidence.id, realmId: 'crownlands', assignedWallet: f.wallet });
    await expect(db.update(expeditionFreeHomes).set({ realmId: 'elderwood' }).where(eq(expeditionFreeHomes.baseId, f.baseId))).rejects.toThrow();
    await expect(db.delete(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).rejects.toThrow();
  });

  it('real deed transfer changes custody, not the home, and refuses the original owner', async () => {
    const f = await fantasyBaseFixture(db, { installClaim: true }), original = await home(f);
    // Finalized transfer proof requires a signable wallet, not arbitrary 32 bytes.
    const buyer = { wallet: Keypair.generate().publicKey.toBase58() };
    await db.insert(players).values(buyer);
    await transferStableBase(db, f.baseId, f.wallet, buyer.wallet, f.mintId, { owner: buyer.wallet, collection: 'test', frozen: false, delegate: null, slot: 101, observedAtMs: Date.now() });
    const next = await home({ baseId: f.baseId, wallet: buyer.wallet });
    expect(next.realmId).toBe(original.realmId); expect(next.evidence).toEqual(original.evidence); expect(next.custodyWallet).toBe(buyer.wallet);
    await expect(home(f)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
  });

  it('rolls back a lazy assignment when the future surrounding command fails', async () => {
    const f = await free();
    await expect(db.transaction(async tx => {
      await resolveExpeditionHome(tx, f.wallet, authority(f.baseId)); throw new Error('dispatch refused');
    })).rejects.toThrow('dispatch refused');
    expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toEqual([]);
  });

  it('refuses a forged persisted world even when its tile FK and paid claim are structurally valid', async () => {
    const f = await fantasyBaseFixture(db), world = `forged-${randomUUID()}`;
    const used = new Set((await db.select().from(fantasyLandClaims)).map(c => c.tileId));
    const tile = [...fantasyTiles('elderwood')].find(t => t.allocation === 'ordinary' && !used.has(t.tileId))!;
    await db.insert(fantasyWorldCatalog).values({ worldId: world, catalogHash: '0'.repeat(64), tileCount: 1 });
    await db.insert(fantasyWorldTiles).values({ worldId: world, tileId: tile.tileId, realmId: tile.realmId, allocation: 'ordinary' });
    await purchaseClaim(f, { world });
    await expect(home(f)).rejects.toThrow('frozen catalog');
    await expect(preview(f)).rejects.toThrow('frozen catalog');
  });

  it('strict evidence rejects unknown fields and noncanonical range, realm or reserved land', async () => {
    const f = await fantasyBaseFixture(db, { installClaim: true }), valid = await home(f);
    expect(ExpeditionHomeEvidenceSchema.safeParse({ ...valid, yields: 99 }).success).toBe(false);
    if (valid.source !== 'deed_location') throw new Error('expected deed');
    for (const tileId of [-1, 0, Number.MAX_SAFE_INTEGER, 1.5, [...fantasyTiles('seeker-reach')][0]!.tileId]) {
      expect(ExpeditionHomeEvidenceSchema.safeParse({ ...valid, evidence: { ...valid.evidence, tileId } }).success).toBe(false);
    }
    expect(ExpeditionHomeEvidenceSchema.safeParse({ ...valid, realmId: 'unknown' }).success).toBe(false);
    expect(ExpeditionHomeEvidenceSchema.safeParse({ ...valid, realmId: 'elderwood' }).success).toBe(false);
  });
});
