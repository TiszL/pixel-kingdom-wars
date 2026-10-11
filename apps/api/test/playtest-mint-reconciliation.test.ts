/** A transient RPC outage must never certify a founder snapshot or erase proof. */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Connection } from '@solana/web3.js';
import { DeedMintInventoryError, readDeedMintInventory, readDeedMintProof } from '@shardkeep/chain';
import { MINT_INVENTORY, PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import { randomWallet } from './helpers';
import type { Db } from '../src/db/client';
import { disposableMintTestDb } from './disposable-mint-db';
import { bases, players, sessions } from '../src/db/schema';
import { playtestMintEvidence as evidence, playtestMintInventory as inventory, playtestFounders, playtestCampaigns } from '../src/db/playtestCampaignSchema';
import { playtestMintStatus } from '../src/db/playtestMintStatusSchema';
import { invalidateMintEvidenceInventory, reconcilePlaytestMintEvidence } from '../src/game/playtestMintEvidence';
import { ensurePlaytestCampaigns, mintVerificationStatus, snapshotPlaytestFounders } from '../src/game/playtestCampaigns';

vi.mock('@shardkeep/chain', async original => ({ ...await original<typeof import('@shardkeep/chain')>(),
  readDeedMintInventory: vi.fn(), readDeedMintProof: vi.fn(),
}));
// Reconciliation intentionally checks the WHOLE collection, including deeds
// retained by other suites. A rollback alone cannot isolate an incomplete scan
// from those older rows. Keep production completeness strict and give these
// fixtures an independently migrated, disposable local database instead.
const conn = disposableMintTestDb('mint_reconciliation', 2);
const rpc = {} as Connection;
const NOW = new Date('2040-01-01T12:00:00Z');
const diagnostic = { stage: 'collection_after' as const, attempts: 1, contextRetries: 0 };
afterEach(() => vi.clearAllMocks());
beforeAll(() => conn.create());
afterAll(() => conn.close());
async function isolated(run: (db: Db) => Promise<void>) {
  const rollback = Symbol('rollback fixture');
  try { await conn.db.transaction(async tx => { await run(tx as unknown as Db); throw rollback; }); }
  catch (error) { if (error !== rollback) throw error; }
}
function proof(assetId = randomUUID()) {
  return { assetId, originalWallet: randomWallet(), confirmedAt: NOW, slot: '10', transactionIndex: 1, signature: randomUUID() };
}
async function seed(db: Db) {
  const original = proof();
  await db.insert(evidence).values({ ...original, verifiedAt: NOW });
  await db.insert(inventory).values({ id: 'land-deeds', throughSlot: '100', assetCount: 1, completedAt: NOW });
  await db.insert(playtestMintStatus).values({ id: 'land-deeds', lastAttemptAt: NOW, lastSuccessAt: NOW,
    state: 'complete', reason: null, diagnostics: diagnostic });
  return original;
}
function scanned(assets: string[], at = NOW) {
  return { throughSlot: '100', assets, completedAt: at, diagnostics: diagnostic };
}
it('adds a new finalized original once, keeping previously verified mint evidence immutable', () => isolated(async db => {
  const original = await seed(db), next = { ...proof(), transactionIndex: 2 };
  const prior = (await db.select().from(evidence).where(eq(evidence.assetId, original.assetId)))[0];
  vi.mocked(readDeedMintInventory).mockResolvedValue(scanned([original.assetId, next.assetId]));
  vi.mocked(readDeedMintProof).mockResolvedValue(next);
  expect(await reconcilePlaytestMintEvidence(db, rpc, 'collection')).toMatchObject({ complete: true, assets: 2 });
  await reconcilePlaytestMintEvidence(db, rpc, 'collection');
  expect(readDeedMintProof).toHaveBeenCalledExactlyOnceWith(rpc, next.assetId, 'collection');
  expect((await db.select().from(evidence).where(eq(evidence.assetId, original.assetId)))[0]).toEqual(prior);
  expect(await mintVerificationStatus(db, [], NOW)).toMatchObject({ complete: true, lastSuccessAt: NOW.toISOString() });
}));
it('invalidates current completeness on a transport outage while retaining last success and every proof', () => isolated(async db => {
  const original = await seed(db);
  const before = await db.select().from(evidence);
  const error = new DeedMintInventoryError({ ...diagnostic, attempts: 3, reason: 'rpc_rate_limit', httpStatus: 429 });
  vi.mocked(readDeedMintInventory).mockRejectedValue(error);
  await expect(reconcilePlaytestMintEvidence(db, rpc, 'collection')).rejects.toBe(error);
  expect(await db.select().from(inventory)).toHaveLength(0);
  expect(await db.select().from(evidence)).toEqual(before);
  expect(await mintVerificationStatus(db, [], NOW)).toMatchObject({ complete: false, status: 'unavailable',
    reason: 'rpc_rate_limit', lastSuccessAt: NOW.toISOString(), diagnostics: { attempts: 3, httpStatus: 429 } });
  vi.mocked(readDeedMintInventory).mockResolvedValue(scanned([original.assetId]));
  await reconcilePlaytestMintEvidence(db, rpc, 'collection');
  expect(await mintVerificationStatus(db, [], NOW)).toMatchObject({ complete: true, reason: null });
}));
it('withholds a receipt when a known deed is not yet in the finalized scan or its proof is unresolved', () => isolated(async db => {
  const original = await seed(db), next = proof();
  await db.insert(players).values({ wallet: next.originalWallet });
  await db.insert(bases).values({ ownerWallet: next.originalWallet, deedAssetId: next.assetId });
  vi.mocked(readDeedMintInventory).mockResolvedValue(scanned([original.assetId]));
  vi.mocked(readDeedMintProof).mockRejectedValue(new Error('private RPC URL and body'));
  expect(await reconcilePlaytestMintEvidence(db, rpc, 'collection')).toMatchObject({ complete: false });
  expect(await db.select().from(inventory)).toHaveLength(0);
  expect(await mintVerificationStatus(db, [], NOW)).toMatchObject({ complete: false, reason: 'proof_unresolved', unresolvedAssets: [next.assetId] });
  expect(JSON.stringify(await db.select().from(playtestMintStatus))).not.toContain('private RPC');
}));
it('dates completeness from the inventory scan, not from later proof hydration', () => isolated(async db => {
  const original = await seed(db), oldScan = new Date(NOW.getTime() - MINT_INVENTORY.receiptFreshnessMs - 1);
  vi.mocked(readDeedMintInventory).mockResolvedValue(scanned([original.assetId], oldScan));
  await reconcilePlaytestMintEvidence(db, rpc, 'collection');
  expect((await db.select().from(inventory))[0]?.completedAt).toEqual(oldScan);
  expect(await mintVerificationStatus(db, [], NOW)).toMatchObject({ complete: false, status: 'stale', reason: 'receipt_stale' });
  expect((await mintVerificationStatus(db, [], new Date(oldScan.getTime() + MINT_INVENTORY.receiptFreshnessMs))).complete).toBe(true);
  expect((await mintVerificationStatus(db, [], new Date(oldScan.getTime() - 1))).complete).toBe(false);
}));
it('freezes fifty only with fresh complete evidence and never changes the frozen snapshot after expiry', () => isolated(async db => {
  await ensurePlaytestCampaigns(db);
  const candidates = Array.from({ length: RULES.founderSpots }, (_, index) => ({ ...proof(), slot: String(index + 1), transactionIndex: index }));
  await db.insert(players).values(candidates.map(p => ({ wallet: p.originalWallet })));
  await db.insert(sessions).values(candidates.map(p => ({ wallet: p.originalWallet, scope: 'full', expiresAt: NOW })));
  await db.insert(bases).values(candidates.map(p => ({ ownerWallet: p.originalWallet, deedAssetId: p.assetId, landPaidAt: NOW })));
  await db.insert(evidence).values(candidates.map(p => ({ ...p, verifiedAt: NOW })));
  await db.insert(inventory).values({ id: 'land-deeds', throughSlot: '100', assetCount: candidates.length, completedAt: NOW });
  const expired = new Date(NOW.getTime() + MINT_INVENTORY.receiptFreshnessMs + 1);
  await snapshotPlaytestFounders(db, [], expired);
  expect(await db.select().from(playtestFounders)).toHaveLength(0);
  expect((await db.select().from(playtestCampaigns).where(eq(playtestCampaigns.id, RULES.foundingId)))[0]?.snapshotAt).toBeNull();
  await snapshotPlaytestFounders(db, [], NOW);
  const frozen = await db.select().from(playtestFounders);
  expect(frozen).toHaveLength(RULES.founderSpots);
  await snapshotPlaytestFounders(db, [], expired);
  expect(await db.select().from(playtestFounders)).toEqual(frozen);
}));


it('removes current completeness immediately after failed cluster attestation without changing verified history', () => isolated(async db => {
  await seed(db);
  const before = await db.select().from(evidence);
  await invalidateMintEvidenceInventory(db, new DeedMintInventoryError({ stage: 'cluster', attempts: 0,
    contextRetries: 0, reason: 'cluster_unavailable' }));
  expect(await db.select().from(inventory)).toHaveLength(0);
  expect(await db.select().from(evidence)).toEqual(before);
  expect(await mintVerificationStatus(db, [], NOW)).toMatchObject({ complete: false, status: 'unavailable',
    reason: 'cluster_unavailable', lastSuccessAt: NOW.toISOString() });
}));
