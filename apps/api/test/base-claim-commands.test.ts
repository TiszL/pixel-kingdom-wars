import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { BASE_OWNERSHIP } from '@shardkeep/shared';
import { BaseClaimReceiptSchema, type BaseClaimRequest } from '@shardkeep/shared/baseClaims';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE } from '../src/auth/session';
import { accounts, baseClaimCommands, bases, baseSlots, baseTransfers, buildings, deedOwnershipObservations, players, raids, sessions } from '../src/db/schema';
import { cancelUnacceptedBaseClaim, executeBaseClaim, getBaseClaim, getClaimableBaseV1 } from '../src/game/baseClaimCommands';
import { observationHash, refreshBaseOwnership, registerOwnedDeed, transferStableBase } from '../src/game/baseOwnership';
import { claimBase, type DeedReaders } from '../src/game/baseClaim';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, fundTestKeep, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const now = new Date('2034-08-01T00:00:00.000Z');
const originalEnv = { claim: process.env['BASE_CLAIM_V1_ENABLED'], stable: process.env['MULTI_BASE_ENABLED'] };
beforeEach(() => { process.env['BASE_CLAIM_V1_ENABLED'] = 'true'; process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterEach(() => {
  for (const [key, value] of [['BASE_CLAIM_V1_ENABLED', originalEnv.claim], ['MULTI_BASE_ENABLED', originalEnv.stable]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
afterAll(async () => { await conn.sql.end(); });
const pubkey = () => Keypair.generate().publicKey.toBase58();
async function player() {
  const wallet = pubkey(); await db.insert(players).values({ wallet });
  const account = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  return { wallet, accountId: account.id };
}
async function fixture() {
  const seller = await player(); const buyer = await player();
  const deed = pubkey(); const collection = pubkey();
  const [base] = await db.insert(bases).values({ ownerWallet: seller.wallet, deedAssetId: deed, status: 'active', landPaidAt: now }).returning();
  await db.insert(baseSlots).values({ wallet: seller.wallet, baseId: base!.id, slot: 1 });
  const request: BaseClaimRequest = { idempotencyKey: randomUUID(), baseId: base!.id, deedAssetId: deed };
  const proof = { owner: buyer.wallet, collection, frozen: false, delegate: null, slot: 1000 };
  const ownerOf = vi.fn(async () => proof);
  const ownedDeeds = vi.fn(async () => [deed]);
  const readers: DeedReaders = { ownerOf, ownedDeeds, collection };
  const execute = (r = request, deps: DeedReaders | null = readers) => executeBaseClaim(db, deps, buyer.wallet, r, () => now);
  return { seller, buyer, deed, collection, baseId: base!.id, request, proof, readers, execute, ownerOf, ownedDeeds };
}
async function auth(wallet: string) {
  const [s] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + 3600_000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, s!.id) };
}
async function base(id: string) { return (await db.select().from(bases).where(eq(bases.id, id)))[0]!; }
async function audits(deed: string) { return db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, deed)); }
function barrier() {
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const wait = new Promise<void>(r => { release = r; });
  return { entered, release, ready, wait };
}

describe.sequential('exact transferred-deed commands', () => {
  it('pending-deed recovery cannot bypass the same stored floor or attach before proof admission', async () => {
    const seller = await player(); const buyer = await player(); const deed = pubkey(); const collection = pubkey();
    const [pending] = await db.insert(bases).values({ ownerWallet: seller.wallet, deedMintAssetId: deed,
      landPaidAt: now, status: 'active' }).returning();
    await db.insert(baseSlots).values({ wallet: seller.wallet, baseId: pending!.id, slot: 1 });
    await db.insert(deedOwnershipObservations).values({ baseId: pending!.id, assetId: deed, owner: seller.wallet,
      slot: 1001n, checkedAt: now, source: 'test', status: 'owned', auditHash: 'test' });
    const before = await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, pending!.id));
    const proof = { owner: buyer.wallet, collection, frozen: false, delegate: null, slot: 1000 };
    const recovery = { expectedCollection: collection, ownerOf: async () => proof };
    await expect(registerOwnedDeed(db, buyer.wallet, deed, recovery)).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect(await base(pending!.id)).toEqual(pending);
    expect((await db.select().from(baseSlots).where(eq(baseSlots.baseId, pending!.id)))[0]).toMatchObject({ wallet: seller.wallet, slot: 1 });
    expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, pending!.id))).toEqual(before);
    expect(await audits(deed)).toHaveLength(0);
    proof.slot = 1002;
    expect(await registerOwnedDeed(db, buyer.wallet, deed, recovery)).toMatchObject({ id: pending!.id, deedAssetId: deed, ownerWallet: buyer.wallet });
    expect((await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, pending!.id)))[0])
      .toMatchObject({ owner: buyer.wallet, slot: 1002n });
    expect(await audits(deed)).toHaveLength(1);
  });
  it('legacy audit failure rolls back custody while retaining the independent finalized loss fact', async () => {
    const f = await fixture(); await f.execute();
    const beforeBase = await base(f.baseId);
    const beforeSlots = await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    const beforeProof = await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId));
    f.ownerOf.mockResolvedValue({ ...f.proof, owner: f.seller.wallet, slot: 1001 });
    const refusedDeed = sql.raw("'" + f.deed.replaceAll("'", "''") + "'");
    // NOT VALID permits the original audit while rejecting the next insert.
    await db.execute(sql`ALTER TABLE base_transfers ADD CONSTRAINT base_claim_test_legacy_audit_failure CHECK (deed_asset_id <> ${refusedDeed}) NOT VALID`);
    try { await expect(claimBase(db, f.readers, f.seller.wallet, () => now)).rejects.toBeDefined(); }
    finally { await db.execute(sql`ALTER TABLE base_transfers DROP CONSTRAINT base_claim_test_legacy_audit_failure`); }
    expect(await base(f.baseId)).toEqual(beforeBase);
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId))).toEqual(beforeSlots);
    expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toEqual([
      { ...beforeProof[0], owner: f.seller.wallet, slot: 1001n, checkedAt: now,
        status: 'mismatch', source: 'harvester-custody-finalized',
        auditHash: observationHash(f.deed, f.seller.wallet, 'mismatch', 1001n, now) },
    ]);
    expect(await audits(f.deed)).toHaveLength(1);
  });
  it('legacy proof read before a concurrent newer native admission is fenced inside the transfer lock', async () => {
    const f = await fixture(); f.proof.slot = 1001; await f.execute();
    const gate = barrier(); const sellerProof = { ...f.proof, owner: f.seller.wallet, slot: 1002 };
    f.ownerOf.mockResolvedValueOnce(sellerProof).mockImplementationOnce(async () => { gate.entered(); await gate.wait; return sellerProof; });
    const waiting = claimBase(db, f.readers, f.seller.wallet); await gate.ready;
    const current = { ...f.proof, slot: 1003 };
    await f.execute({ ...f.request, idempotencyKey: randomUUID() }, { ...f.readers, ownerOf: async () => current });
    gate.release();
    await expect(waiting).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect((await base(f.baseId)).ownerWallet).toBe(f.buyer.wallet);
    expect((await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId)))[0]).toMatchObject({ slot: 1003n });
    expect(await audits(f.deed)).toHaveLength(1);
  });
  for (const path of ['legacy', 'native', 'observer'] as const) for (const outage of [false, true]) {
    it(`${path} refuses a conflicting equal-slot owner${outage ? ' after an unavailable observation' : ''}`, async () => {
      const f = await fixture(); f.proof.slot = 1001; const accepted = await f.execute();
      if (outage) expect(await refreshBaseOwnership(db, f.baseId, async () => null, f.collection)).toBe('unavailable');
      const before = await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId));
      const conflicting = { ...f.proof, owner: f.seller.wallet };
      f.ownerOf.mockResolvedValue(conflicting);
      if (path === 'observer') expect(await refreshBaseOwnership(db, f.baseId, async () => conflicting, f.collection)).toBe('unavailable');
      else if (path === 'legacy') await expect(claimBase(db, f.readers, f.seller.wallet)).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
      else await expect(executeBaseClaim(db, f.readers, f.seller.wallet, { ...f.request, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'BASE_CLAIM_UNAVAILABLE' });
      expect((await base(f.baseId)).ownerWallet).toBe(f.buyer.wallet);
      expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toEqual(before);
      expect(await audits(f.deed)).toHaveLength(1);
      expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toEqual(accepted);
    });
  }
  for (const path of ['legacy', 'native'] as const) it(`${path} accepts equal-slot proof matching the already observed recipient`, async () => {
    const f = await fixture();
    await db.insert(deedOwnershipObservations).values({ baseId: f.baseId, assetId: f.deed, owner: f.buyer.wallet,
      slot: 1000n, checkedAt: now, source: 'test', status: 'owned', auditHash: 'test' });
    if (path === 'legacy') expect(await claimBase(db, f.readers, f.buyer.wallet)).toMatchObject({ claimed: true, reason: 'ok' });
    else expect(await f.execute()).toMatchObject({ outcome: 'claimed' });
    expect((await base(f.baseId)).ownerWallet).toBe(f.buyer.wallet);
    expect(await audits(f.deed)).toHaveLength(1);
  });
  it('the observer accepts a same-owner equal-slot refresh but requires newer evidence after an outage', async () => {
    const f = await fixture(); await f.execute();
    expect(await refreshBaseOwnership(db, f.baseId, async () => f.proof, f.collection)).toBe('owned');
    expect(await refreshBaseOwnership(db, f.baseId, async () => null, f.collection)).toBe('unavailable');
    expect(await refreshBaseOwnership(db, f.baseId, async () => f.proof, f.collection)).toBe('unavailable');
    expect(await refreshBaseOwnership(db, f.baseId, async () => ({ ...f.proof, slot: 1001 }), f.collection)).toBe('owned');
  });
  it('accepted legacy proof advances the floor against a later stale native claim while preserving fresh transfers', async () => {
    const f = await fixture(); f.proof.slot = 1001; const original = await f.execute();
    f.ownerOf.mockResolvedValue({ ...f.proof, owner: f.seller.wallet, slot: 1002 });
    expect(await claimBase(db, f.readers, f.seller.wallet)).toMatchObject({ claimed: true, reason: 'ok', deedAssetId: f.deed });
    expect((await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId)))[0])
      .toMatchObject({ owner: f.seller.wallet, slot: 1002n });
    f.ownerOf.mockResolvedValue(f.proof);
    const freshKey = { ...f.request, idempotencyKey: randomUUID() };
    await expect(f.execute(freshKey)).rejects.toMatchObject({ code: 'BASE_CLAIM_UNAVAILABLE' });
    expect((await base(f.baseId)).ownerWallet).toBe(f.seller.wallet);
    expect(await audits(f.deed)).toHaveLength(2);
    f.ownerOf.mockResolvedValue({ ...f.proof, slot: 1003 });
    expect(await f.execute(freshKey)).toMatchObject({ outcome: 'claimed' });
    expect((await base(f.baseId)).ownerWallet).toBe(f.buyer.wallet);
    expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toEqual(original);
  });
  it('omitting proof cannot bypass an established floor at the shared transfer boundary', async () => {
    const f = await fixture(); await f.execute();
    await expect(transferStableBase(db, f.baseId, f.buyer.wallet, f.seller.wallet, f.deed))
      .rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    expect((await base(f.baseId)).ownerWallet).toBe(f.buyer.wallet);
    expect(await audits(f.deed)).toHaveLength(1);
  });
  it('legacy web claim cannot undo newer native ownership with an older finalized proof', async () => {
    const f = await fixture(); f.proof.slot = 1001;
    const accepted = await f.execute();
    const ownershipBefore = await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId));
    const slotsBefore = await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    // A failover RPC/DAS still reports the previous seller. Neither an old web
    // client nor a lost native reply may roll back the accepted ownership floor.
    f.ownerOf.mockResolvedValue({ ...f.proof, owner: f.seller.wallet, slot: 1000 });
    process.env['MULTI_BASE_ENABLED'] = 'false';
    const app = await buildApp(TEST_CONFIG, db, { market: { deedReaders: f.readers } });
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const response = await app.inject({ method: 'POST', url: '/base/claim', cookies: await auth(f.seller.wallet) });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'DEED_AUTHORITY_UNAVAILABLE' } });
      expect((await base(f.baseId)).ownerWallet).toBe(f.buyer.wallet);
      expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId))).toEqual(slotsBefore);
      expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toEqual(ownershipBefore);
      expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toEqual(accepted);
      expect(await audits(f.deed)).toHaveLength(1);
    } finally { await app.close(); }
  });
  it('a lost reply retries only the original deed and retains its historical outcome after resale and flag-off', async () => {
    const f = await fixture();
    const original = await f.execute();
    expect(BaseClaimReceiptSchema.parse(original)).toEqual(original);
    expect(original).toMatchObject({ actor: f.buyer.wallet, request: f.request, outcome: 'claimed', active: true,
      fromWallet: f.seller.wallet, ownership: { owner: f.buyer.wallet, collection: f.collection, slot: '1000' } });
    const next = await player();
    // Resale is a newer finalized transfer, not permission to bypass the
    // accepted native observation by omitting authority evidence.
    await transferStableBase(db, f.baseId, f.buyer.wallet, next.wallet, f.deed, { ...f.proof, owner: next.wallet, slot: 1001, observedAtMs: Date.now() });
    process.env['BASE_CLAIM_V1_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'false';
    f.ownerOf.mockImplementation(async () => { throw new Error('historical recovery must not read RPC'); });
    expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toEqual(original);
    expect(await f.execute(f.request, null)).toEqual(original);
    expect((await getBaseClaim(db, next.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    expect((await base(f.baseId)).ownerWallet).toBe(next.wallet);
    expect(await audits(f.deed)).toHaveLength(2);
  });
  it('concurrent identical retries transfer once, without candidate selection or a second audit', async () => {
    const f = await fixture();
    f.ownedDeeds.mockImplementation(async () => { throw new Error('POST cannot choose a new candidate'); });
    const accepted = await Promise.all([f.execute(), f.execute(), f.execute()]);
    accepted.forEach(r => expect(r).toEqual(accepted[0]));
    expect(await audits(f.deed)).toHaveLength(1);
    expect(await db.select().from(baseClaimCommands).where(eq(baseClaimCommands.actorWallet, f.buyer.wallet))).toHaveLength(1);
    expect(f.ownedDeeds).not.toHaveBeenCalled();
  });
  it('a reused key cannot silently retarget another deed or base', async () => {
    const f = await fixture(); const original = await f.execute();
    for (const request of [{ ...f.request, baseId: randomUUID() }, { ...f.request, deedAssetId: pubkey() }]) {
      await expect(f.execute(request)).rejects.toMatchObject({ code: 'BASE_CLAIM_MISMATCH' });
    }
    expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toEqual(original);
    expect(await audits(f.deed)).toHaveLength(1);
  });
  it('a fresh mismatched target cannot fall back to another eligible candidate', async () => {
    const f = await fixture();
    await expect(f.execute({ ...f.request, deedAssetId: pubkey() })).rejects.toMatchObject({ code: 'BASE_CLAIM_CHANGED' });
    await expect(f.execute({ ...f.request, baseId: randomUUID() })).rejects.toMatchObject({ code: 'BASE_CLAIM_CHANGED' });
    expect(f.ownerOf).not.toHaveBeenCalled(); expect(f.ownedDeeds).not.toHaveBeenCalled();
    expect((await base(f.baseId)).ownerWallet).toBe(f.seller.wallet);
  });
  it('an already-owned inactive base requires finalized authority and reports no invented transfer or activation', async () => {
    const f = await fixture();
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ ownerWallet: f.buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    const r = await f.execute();
    expect(r).toMatchObject({ outcome: 'already_owned', active: false, fromWallet: null, transferId: null });
    expect(f.ownerOf).toHaveBeenCalledOnce(); expect(await audits(f.deed)).toHaveLength(0);
  });
  it('a received deed remains inactive when all active slots are occupied', async () => {
    const f = await fixture();
    for (let slot = 1; slot <= BASE_OWNERSHIP.maxActive; slot++) {
      const [owned] = await db.insert(bases).values({ ownerWallet: f.buyer.wallet, status: 'active' }).returning();
      await db.insert(baseSlots).values({ wallet: f.buyer.wallet, baseId: owned!.id, slot });
    }
    expect(await f.execute()).toMatchObject({ outcome: 'claimed', active: false });
    expect(await base(f.baseId)).toMatchObject({ ownerWallet: f.buyer.wallet, status: 'inactive' });
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId))).toHaveLength(0);
  });
  it('the canonical transfer preserves the physical base children and each wallet KEEP balance', async () => {
    const f = await fixture();
    const [building] = await db.insert(buildings).values({ playerWallet: f.seller.wallet, baseId: f.baseId, type: 'keep', level: 1, tx: 14, ty: 14 }).returning();
    await fundTestKeep(db, f.seller.wallet, 111n, 'test.claim.seller', randomUUID());
    await fundTestKeep(db, f.buyer.wallet, 222n, 'test.claim.buyer', randomUUID());
    // `in (...)` returns rows in no defined order (CI 2026-10-10 shard 15 saw them swapped):
    // order both reads by id so the comparison is about the balances, not the scan plan.
    const balances = await db.select().from(accounts).where(sql`${accounts.id} in (${f.seller.accountId},${f.buyer.accountId})`).orderBy(accounts.id);
    await f.execute();
    expect((await db.select().from(buildings).where(eq(buildings.id, building!.id)))[0]).toEqual(building);
    expect(await db.select().from(accounts).where(sql`${accounts.id} in (${f.seller.accountId},${f.buyer.accountId})`).orderBy(accounts.id)).toEqual(balances);
  });
  for (const invalid of ['wrong-owner', 'frozen', 'delegated', 'wrong-collection', 'missing-slot', 'unsafe-slot', 'negative-slot'] as const) {
    it(`${invalid} evidence cannot move the base or write an accepted receipt`, async () => {
      const f = await fixture();
      const proof: Record<string, unknown> = { ...f.proof };
      if (invalid === 'wrong-owner') proof['owner'] = f.seller.wallet;
      if (invalid === 'frozen') proof['frozen'] = true;
      if (invalid === 'delegated') proof['delegate'] = pubkey();
      if (invalid === 'wrong-collection') proof['collection'] = pubkey();
      if (invalid === 'missing-slot') delete proof['slot'];
      if (invalid === 'unsafe-slot') proof['slot'] = Number.MAX_SAFE_INTEGER + 1;
      if (invalid === 'negative-slot') proof['slot'] = -1;
      const readers = { ...f.readers, ownerOf: async () => proof as unknown as typeof f.proof };
      await expect(f.execute(f.request, readers)).rejects.toMatchObject({ code: 'BASE_CLAIM_NOT_TRANSFERABLE' });
      expect((await base(f.baseId)).ownerWallet).toBe(f.seller.wallet);
      expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
      expect(await audits(f.deed)).toHaveLength(0);
    });
  }
  it('provider uncertainty leaves an unknown original intent, and GET cannot retry or mutate it', async () => {
    const f = await fixture(); f.ownerOf.mockRejectedValue(new Error('timeout'));
    await expect(f.execute()).rejects.toMatchObject({ statusCode: 503, code: 'BASE_CLAIM_UNAVAILABLE' });
    for (let i = 0; i < 3; i++) expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    expect(f.ownerOf).toHaveBeenCalledOnce(); expect(await audits(f.deed)).toHaveLength(0);
  });
  it('newer authoritative observation rejects an older finalized read', async () => {
    const f = await fixture();
    await db.insert(deedOwnershipObservations).values({ baseId: f.baseId, assetId: f.deed, owner: f.buyer.wallet,
      slot: 1001n, checkedAt: now, source: 'test', status: 'owned', auditHash: 'test' });
    await expect(f.execute()).rejects.toMatchObject({ code: 'BASE_CLAIM_UNAVAILABLE' });
    expect((await base(f.baseId)).ownerWallet).toBe(f.seller.wallet);
  });
  for (const outcome of ['claimed', 'already_owned'] as const) it(`${outcome} acceptance advances the canonical finalized high-water mark before another actor can claim`, async () => {
    const f = await fixture(); const next = await player();
    if (outcome === 'already_owned') {
      await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
      await db.update(bases).set({ ownerWallet: f.buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    }
    f.proof.slot = 1001;
    expect(await f.execute()).toMatchObject({ outcome, ownership: { slot: '1001' } });
    expect((await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId)))[0])
      .toMatchObject({ owner: f.buyer.wallet, assetId: f.deed, slot: 1001n, source: 'claim-finalized', status: 'owned' });
    const stale = { ...f.readers, ownerOf: async () => ({ ...f.proof, owner: next.wallet, slot: 1000 }) };
    const key = randomUUID();
    await expect(executeBaseClaim(db, stale, next.wallet, { ...f.request, idempotencyKey: key }, () => now))
      .rejects.toMatchObject({ code: 'BASE_CLAIM_UNAVAILABLE' });
    expect((await base(f.baseId)).ownerWallet).toBe(f.buyer.wallet);
    expect((await getBaseClaim(db, next.wallet, key)).receipt).toBeNull();
    expect(await audits(f.deed)).toHaveLength(outcome === 'claimed' ? 1 : 0);
  });
  it('the canonical outgoing-battle fence refuses deed movement and leaves recovery unknown', async () => {
    const f = await fixture();
    const [raid] = await db.insert(raids).values({ attackerWallet: f.seller.wallet, attackerBaseId: f.baseId,
      defenderWallet: f.buyer.wallet, seed: 1n, snapshot: {}, armySnapshot: {}, ordersDeadlineAt: now, status: 'pending_orders' }).returning();
    try {
      await expect(f.execute()).rejects.toMatchObject({ code: 'BASE_BUSY_ATTACKING' });
      expect((await base(f.baseId)).ownerWallet).toBe(f.seller.wallet); expect(await audits(f.deed)).toHaveLength(0);
      expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    } finally { await db.update(raids).set({ status: 'expired' }).where(eq(raids.id, raid!.id)); }
  });
  for (const flag of [undefined, 'false', 'TRUE', 'junk']) it(`fresh claims require exact true (${flag}); cancellation stays available`, async () => {
    const f = await fixture();
    if (flag === undefined) delete process.env['BASE_CLAIM_V1_ENABLED']; else process.env['BASE_CLAIM_V1_ENABLED'] = flag;
    await expect(f.execute()).rejects.toMatchObject({ code: 'BASE_CLAIM_DISABLED' });
    expect(f.ownerOf).not.toHaveBeenCalled();
    expect(await cancelUnacceptedBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).toMatchObject({ cancelled: true, receipt: null });
  });
  it('a seller change during the chain read cannot apply stale consent to a different owner', async () => {
    const f = await fixture(); const next = await player(); const gate = barrier();
    f.ownerOf.mockImplementation(async () => { gate.entered(); await gate.wait; return f.proof; });
    const waiting = f.execute(); await gate.ready;
    await transferStableBase(db, f.baseId, f.seller.wallet, next.wallet, f.deed); gate.release();
    await expect(waiting).rejects.toMatchObject({ code: 'BASE_CLAIM_CHANGED' });
    expect((await base(f.baseId)).ownerWallet).toBe(next.wallet);
    expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
  });
  it('a receipt insertion failure rolls back the entire canonical move and its audit', async () => {
    const f = await fixture();
    // PostgreSQL does not bind parameters in DDL. This test-generated UUID is
    // quoted as a literal; the production command still uses bound parameters.
    const refusedKey = sql.raw("'" + f.request.idempotencyKey.replaceAll("'", "''") + "'::uuid");
    await db.execute(sql`ALTER TABLE base_claim_commands ADD CONSTRAINT base_claim_test_receipt_failure CHECK (request_key <> ${refusedKey})`);
    try {
      await expect(f.execute()).rejects.toBeDefined();
      expect((await base(f.baseId)).ownerWallet).toBe(f.seller.wallet);
      expect((await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId)))[0]?.wallet).toBe(f.seller.wallet);
      expect(await audits(f.deed)).toHaveLength(0);
      expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
      // Receipt/custody still roll back; already proven external ownership loss
      // remains independently recorded so an earning cutoff cannot drift.
      expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toMatchObject([
        { owner: f.buyer.wallet, slot: BigInt(f.proof.slot), checkedAt: now, status: 'mismatch',
          auditHash: observationHash(f.deed, f.buyer.wallet, 'mismatch', BigInt(f.proof.slot), now) },
      ]);
    } finally { await db.execute(sql`ALTER TABLE base_claim_commands DROP CONSTRAINT base_claim_test_receipt_failure`); }
    expect(await f.execute()).toMatchObject({ outcome: 'claimed' });
  });
  it('cancellation before a delayed POST is retained and fences all late retries while allowing a new deliberate key', async () => {
    const f = await fixture(); const gate = barrier();
    f.ownerOf.mockImplementation(async () => { gate.entered(); await gate.wait; return f.proof; });
    const waiting = f.execute(); await gate.ready;
    const cancelled = await cancelUnacceptedBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey);
    expect(cancelled).toMatchObject({ cancelled: true, receipt: null }); gate.release();
    await expect(waiting).rejects.toMatchObject({ code: 'BASE_CLAIM_CANCELLED' });
    expect(await cancelUnacceptedBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).toEqual(cancelled);
    await expect(f.execute()).rejects.toMatchObject({ code: 'BASE_CLAIM_CANCELLED' });
    expect((await base(f.baseId)).ownerWallet).toBe(f.seller.wallet); expect(await audits(f.deed)).toHaveLength(0);
    expect(await f.execute({ ...f.request, idempotencyKey: randomUUID() })).toMatchObject({ outcome: 'claimed' });
  });
  it('cancellation after acceptance returns the original receipt and cannot undo a transfer', async () => {
    const f = await fixture(); const original = await f.execute();
    process.env['BASE_CLAIM_V1_ENABLED'] = 'false';
    expect(await cancelUnacceptedBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).toEqual({
      version: 1, wallet: f.buyer.wallet, idempotencyKey: f.request.idempotencyKey, cancelled: false, receipt: original,
    });
    expect(await f.execute()).toEqual(original); expect(await audits(f.deed)).toHaveLength(1);
  });
  it('accepted receipts, cancellation tombstones and referenced transfer audits cannot be rewritten or deleted', async () => {
    const f = await fixture(); const original = await f.execute(); const cancelledKey = randomUUID();
    await cancelUnacceptedBaseClaim(db, f.buyer.wallet, cancelledKey);
    for (const key of [f.request.idempotencyKey, cancelledKey]) {
      const where = and(eq(baseClaimCommands.actorWallet, f.buyer.wallet), eq(baseClaimCommands.requestKey, key));
      await expect(db.update(baseClaimCommands).set({ receipt: null }).where(where)).rejects.toBeDefined();
      await expect(db.delete(baseClaimCommands).where(where)).rejects.toBeDefined();
    }
    await expect(db.update(baseTransfers).set({ toWallet: f.seller.wallet }).where(eq(baseTransfers.id, original.transferId!))).rejects.toBeDefined();
    await expect(db.delete(baseTransfers).where(eq(baseTransfers.id, original.transferId!))).rejects.toBeDefined();
    await expect(db.execute(sql`TRUNCATE base_claim_commands`)).rejects.toBeDefined();
    expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toEqual(original);
  });
  it('SQL refuses fabricated activation, ownership, original target and transfer audit evidence', async () => {
    const f = await fixture(); const original = await f.execute();
    const [originalAudit] = await audits(f.deed);
    for (const changes of [{ active: !original.active }, { ownership: { ...original.ownership, owner: f.seller.wallet } },
      { request: { ...original.request, deedAssetId: pubkey() } }, { fromWallet: pubkey() }]) {
      // Give each malformed insertion an unreferenced audit so the unique
      // transfer index cannot accidentally stand in for the semantic guards.
      const [audit] = await db.insert(baseTransfers).values({ ...originalAudit!, id: randomUUID() }).returning();
      const key = randomUUID(); const r = { ...original, ...changes, transferId: audit!.id, idempotencyKey: key,
        request: { ...original.request, ...(changes as { request?: object }).request, idempotencyKey: key } };
      await expect(db.insert(baseClaimCommands).values({ actorWallet: f.buyer.wallet, requestKey: key,
        transferId: audit!.id, receipt: r, createdAt: now })).rejects.toBeDefined();
    }
    const key = randomUUID();
    await expect(db.insert(baseClaimCommands).values({ actorWallet: f.buyer.wallet, requestKey: key, transferId: original.transferId })).rejects.toBeDefined();
  });
  it('claimable discovery is bounded read-only consent and is unavailable while dark', async () => {
    const f = await fixture();
    expect(await getClaimableBaseV1(db, f.readers, f.buyer.wallet)).toEqual({ version: 1, wallet: f.buyer.wallet, enabled: true,
      candidate: { baseId: f.baseId, deedAssetId: f.deed }, reason: 'ok' });
    expect(await audits(f.deed)).toHaveLength(0);
    process.env['BASE_CLAIM_V1_ENABLED'] = 'false'; f.ownedDeeds.mockClear();
    expect(await getClaimableBaseV1(db, f.readers, f.buyer.wallet)).toMatchObject({ enabled: false, candidate: null, reason: 'unavailable' });
    expect(f.ownedDeeds).not.toHaveBeenCalled();
  });
  it('SQL acceptance requires the same committed observation rather than only a client-shaped proof object', async () => {
    const f = await fixture(); const accepted = await f.execute();
    await db.update(deedOwnershipObservations).set({ slot: 999n }).where(eq(deedOwnershipObservations.baseId, f.baseId));
    const key = randomUUID(); const r = { ...accepted, idempotencyKey: key, request: { ...f.request, idempotencyKey: key },
      outcome: 'already_owned', transferId: null, fromWallet: null };
    await expect(db.insert(baseClaimCommands).values({ actorWallet: f.buyer.wallet, requestKey: key, receipt: r, createdAt: now })).rejects.toBeDefined();
    expect((await getBaseClaim(db, f.buyer.wallet, f.request.idempotencyKey)).receipt).toEqual(accepted);
  });
  it('authenticated routes keep original history and cancellation available without land, flag or RPC', async () => {
    const f = await fixture();
    // Earlier adversarial fixtures deliberately leave mismatched/unobserved
    // deeds. Boot dark so this route test does not pretend that global fixture
    // inventory passed the separately tested observer activation preflight.
    process.env['MULTI_BASE_ENABLED'] = 'false';
    const app = await buildApp(TEST_CONFIG, db, { market: { deedReaders: f.readers } });
    process.env['MULTI_BASE_ENABLED'] = 'true';
    const cookie = await auth(f.buyer.wallet);
    try {
      const accepted = await app.inject({ method: 'POST', url: '/base/claims/v1', cookies: cookie, payload: f.request });
      expect(accepted.statusCode, accepted.body).toBe(200); expect(accepted.json().request).toEqual(f.request);
      process.env['BASE_CLAIM_V1_ENABLED'] = 'false'; const unknownKey = randomUUID();
      const unknown = await app.inject({ method: 'GET', url: `/base/claims/v1/${unknownKey}`, cookies: cookie });
      expect(unknown.statusCode).toBe(200); expect(unknown.json()).toMatchObject({ enabled: false, receipt: null });
      const read = await app.inject({ method: 'GET', url: `/base/claims/v1/${f.request.idempotencyKey}`, cookies: cookie });
      expect(read.statusCode).toBe(200); expect(read.json().receipt).toEqual(accepted.json());
      const cancel = await app.inject({ method: 'POST', url: `/base/claims/v1/${unknownKey}/cancel-unaccepted`, cookies: cookie, payload: {} });
      expect(cancel.statusCode).toBe(200); expect(cancel.json()).toMatchObject({ cancelled: true, receipt: null });
      const fresh = await app.inject({ method: 'POST', url: '/base/claims/v1', cookies: cookie, payload: { ...f.request, idempotencyKey: randomUUID() } });
      expect(fresh.statusCode).toBe(503);
      const unauth = await app.inject({ method: 'GET', url: `/base/claims/v1/${f.request.idempotencyKey}` });
      expect(unauth.statusCode).toBe(401);
      const invalid = await app.inject({ method: 'POST', url: '/base/claims/v1', cookies: cookie, payload: { ...f.request, actor: f.seller.wallet } });
      expect(invalid.statusCode).toBe(400);
      for (const response of [accepted, unknown, read, cancel, fresh, unauth, invalid]) expect(response.headers['cache-control']).toBe('private, no-store');
    } finally { await app.close(); }
  });
});
