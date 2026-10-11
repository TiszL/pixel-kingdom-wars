/** Observed custody epochs must survive the real ownership writer's two-step
 * delivery and its raid-time deferral. These are database-history fixtures,
 * not evidence of unobserved continuous chain custody or a mint capability. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { baseArmy, bases, players } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity, refreshBaseOwnership, transferStableBase } from '../src/game/baseOwnership';
import { executeBaseClaim } from '../src/game/baseClaimCommands';
import { createCampaignRaid, compensatePendingRaid } from '../src/game/raids';
import { createClanCharterCustodyEpochs } from '../src/game/clanCharterCustodyEpochs';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';

let f: ReturnType<typeof resourceClaimsDatabase>;
const key = () => Keypair.generate().publicKey.toBase58();
beforeEach(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'true');
  vi.stubEnv('BASE_CLAIM_V1_ENABLED', 'true');
  f = resourceClaimsDatabase(); await f.setup();
}, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); }, 120_000);

async function fixture() {
  // Real signable wallets: random ledger-byte fixtures may be off curve and
  // are deliberately refused by the actual deed ownership verifier.
  async function player() {
    const wallet = key(); await f.db.insert(players).values({ wallet });
    await getOrCreatePlayerAccount(f.db, wallet, 'player_keep'); return { wallet };
  }
  const payer = await player(), buyer = await player();
  await ensureStartingBase(f.db, payer.wallet);
  const baseId = (await ensureWalletBaseIdentity(f.db, payer.wallet))!;
  const deed = key(), collection = key(), paidAt = new Date();
  await f.db.update(bases).set({ deedAssetId: deed, landPaidAt: paidAt }).where(eq(bases.id, baseId));
  await f.db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, payer.wallet));
  vi.stubEnv('MULTI_BASE_ENABLED', 'true');
  const proof = (owner = payer.wallet, slot = 100) => ({ owner, slot, collection, frozen: false, delegate: null });
  const refresh = (owner = payer.wallet, slot = 100) => refreshBaseOwnership(f.db, baseId, async () => proof(owner, slot), collection);
  expect(await refresh()).toBe('owned');
  const store = createClanCharterCustodyEpochs(f.db), original = await store.enroll(payer.wallet, baseId);
  expect(original.authority).toBe('current');
  return { payer, buyer, baseId, deed, collection, proof, refresh, store, original };
}
async function pendingCampaign(baseId: string, wallet: string) {
  await f.db.insert(baseArmy).values({ baseId, troop: 'plunderer', count: 1 });
  return createCampaignRaid(f.db, wallet, 1, randomUUID(), new Date(), {
    attackerBaseId: baseId, authorizeAttackerBase: async () => {},
  });
}
const owner = async (baseId: string) => (await f.db.select().from(bases).where(eq(bases.id, baseId)))[0]!.ownerWallet;

it('records an actual explicit transfer exactly once and leaves the original epoch immutable', async () => {
  const x = await fixture();
  await transferStableBase(f.db, x.baseId, x.payer.wallet, x.buyer.wallet, x.deed,
    { ...x.proof(x.buyer.wallet, 101), observedAtMs: Date.now() });
  const next = await x.store.read(x.baseId);
  expect(next).toMatchObject({ ownerWallet: x.buyer.wallet, ordinal: '2', authority: 'current' });
  expect(next!.id).not.toBe(x.original.id);
  expect(await owner(x.baseId)).toBe(x.buyer.wallet);
  const rows = await f.sql`select * from charter_custody_epochs order by ordinal`;
  expect(rows).toHaveLength(2);
  await x.refresh(x.buyer.wallet, 102);
  expect((await x.store.read(x.baseId))!.id).toBe(next!.id);
  expect(await f.sql`select * from charter_custody_epochs order by ordinal`).toEqual(rows);
});

it('captures A-to-B-to-A while an actual outgoing campaign keeps the database owner A', async () => {
  const x = await fixture(); await pendingCampaign(x.baseId, x.payer.wallet);
  expect(await x.refresh(x.buyer.wallet, 101)).toBe('mismatch');
  expect(await owner(x.baseId)).toBe(x.payer.wallet);
  const away = await x.store.read(x.baseId);
  expect(away).toMatchObject({ ownerWallet: x.buyer.wallet, ordinal: '2', authority: 'unavailable' });
  expect(await x.refresh(x.payer.wallet, 102)).toBe('owned');
  const returned = await x.store.read(x.baseId);
  expect(returned).toMatchObject({ ownerWallet: x.payer.wallet, ordinal: '3', authority: 'current' });
  expect(returned!.id).not.toBe(x.original.id);
  expect(returned!.evidenceCommitment).not.toBe(x.original.evidenceCommitment);
  expect(await owner(x.baseId)).toBe(x.payer.wallet);
});

it('deduplicates later delivery after actual campaign compensation while preserving the earlier positive loss', async () => {
  const x = await fixture(), raid = await pendingCampaign(x.baseId, x.payer.wallet);
  await x.refresh(x.buyer.wallet, 101);
  const deferred = await x.store.read(x.baseId);
  expect(await compensatePendingRaid(f.db, raid, false)).toBe(true);
  expect(await x.refresh(x.buyer.wallet, 102)).toBe('mismatch');
  expect(await owner(x.baseId)).toBe(x.buyer.wallet);
  // First mismatch is the custody epoch, not the later delivery transaction.
  expect(await x.store.read(x.baseId)).toMatchObject({ id: deferred!.id, ordinal: '2' });
  expect(await f.sql`select * from charter_custody_epochs`).toHaveLength(2);
});

it('keeps the independently committed custody loss when actual claim delivery rolls back', async () => {
  const x = await fixture();
  await f.sql`alter table base_transfers add constraint b6i_fixture_delivery_failure check (false) not valid`;
  try {
    await expect(executeBaseClaim(f.db, {
      ownerOf: async () => x.proof(x.buyer.wallet, 101), ownedDeeds: async () => [x.deed], collection: x.collection,
    }, x.buyer.wallet, { idempotencyKey: randomUUID(), baseId: x.baseId, deedAssetId: x.deed })).rejects.toBeDefined();
  } finally { await f.sql`alter table base_transfers drop constraint b6i_fixture_delivery_failure`; }
  expect(await owner(x.baseId)).toBe(x.payer.wallet);
  expect(await x.store.read(x.baseId)).toMatchObject({ ownerWallet: x.buyer.wallet, ordinal: '2', authority: 'unavailable' });
  expect(await f.sql`select * from base_claim_commands`).toHaveLength(0);
  expect(await f.sql`select * from base_transfers`).toHaveLength(0);
  expect(await x.refresh(x.payer.wallet, 102)).toBe('owned');
  expect(await x.store.read(x.baseId)).toMatchObject({ ownerWallet: x.payer.wallet, ordinal: '3', authority: 'current' });
});

it('keeps an epoch through RPC and null-read unavailability, without treating either as a proven transfer', async () => {
  const x = await fixture();
  expect(await refreshBaseOwnership(f.db, x.baseId, async () => { throw new Error('fixture RPC unavailable'); }, x.collection)).toBe('unavailable');
  // The existing writer preserves a still-fresh accepted proof on RPC failure.
  expect((await x.store.read(x.baseId))!.id).toBe(x.original.id);
  expect(await refreshBaseOwnership(f.db, x.baseId, async () => null, x.collection)).toBe('unavailable');
  expect(await x.store.read(x.baseId)).toMatchObject({ id: x.original.id, authority: 'unavailable' });
  expect(await x.refresh(x.payer.wallet, 101)).toBe('owned');
  expect(await x.store.read(x.baseId)).toEqual(x.original);
  expect(await f.sql`select * from charter_custody_epochs`).toHaveLength(1);
});

it('invalidates on actual positive ineligibility and refuses to revive the same epoch on recovery', async () => {
  const x = await fixture();
  expect(await refreshBaseOwnership(f.db, x.baseId, async () => ({ ...x.proof(x.payer.wallet, 101), frozen: true }), x.collection)).toBe('ineligible');
  const invalid = await x.store.read(x.baseId);
  expect(invalid).toMatchObject({ ordinal: '2', authority: 'unavailable' });
  expect(await x.refresh(x.payer.wallet, 102)).toBe('owned');
  const recovered = await x.store.read(x.baseId);
  expect(recovered).toMatchObject({ ownerWallet: x.payer.wallet, ordinal: '3', authority: 'current' });
  expect(recovered!.id).not.toBe(x.original.id);
});
