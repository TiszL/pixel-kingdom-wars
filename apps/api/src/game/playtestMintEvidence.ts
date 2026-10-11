/** Worker-only, read-only chain reconciliation. No minting, transfers or payouts. */
import { Connection } from '@solana/web3.js';
import { readDeedMintInventory, readDeedMintProof, readDeedOwnerAtClose, DeedMintInventoryError, type MintInventoryConnection, type MintInventoryDiagnostics } from '@shardkeep/chain';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { playtestCampaigns, playtestCloseDeedEvidence } from '../db/playtestCampaignSchema';
import { requiredCampaignCloseDeeds } from './playtestCampaigns';
import { playtestMintStatus } from '../db/playtestMintStatusSchema';
import type { Db } from '../db/client';
import { bases, playtestMintEvidence as evidence, playtestMintInventory as inventory } from '../db/schema';

export interface MintReconciliationResult {
  complete: boolean; assets: number;
  diagnostics: MintInventoryDiagnostics | { reason: 'proof_unresolved'; assetCount: number; attempts: number };
}
/** A failed provider attestation or scan removes only current completeness;
 * immutable verified mint/close proofs and the last successful time survive. */
export async function invalidateMintEvidenceInventory(db: Db, safe: DeedMintInventoryError): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('playtest-mint-inventory',0))`);
    await tx.delete(inventory).where(eq(inventory.id, 'land-deeds'));
    const value = { id: 'land-deeds', state: 'unavailable' as const, lastAttemptAt: new Date(), reason: safe.diagnostics.reason, diagnostics: safe.diagnostics };
    await tx.insert(playtestMintStatus).values(value).onConflictDoUpdate({ target: playtestMintStatus.id, set: value });
  });
}

export async function reconcilePlaytestMintEvidence(db: Db, connection: Connection, collection: string, inventoryConnection: MintInventoryConnection = connection): Promise<MintReconciliationResult> {
  let scan: Awaited<ReturnType<typeof readDeedMintInventory>>;
  try {
    scan = await readDeedMintInventory(inventoryConnection, collection);
  } catch (error) {
    const safe = error instanceof DeedMintInventoryError ? error : new DeedMintInventoryError({ reason: 'rpc_error', stage: 'collection_before', attempts: 0, contextRetries: 0 });
    // Sanitized error: RPC URLs may contain credentials. Surface an unresolved
    // inventory in admin; do not manufacture a successful partial scan receipt.
    await invalidateMintEvidenceInventory(db, safe);
    throw safe;
  }
  const known = await db.select({ assetId: bases.deedAssetId }).from(bases);
  const assets = [...new Set([...scan.assets, ...known.flatMap(row => row.assetId ? [row.assetId] : [])])];
  const existing = await db.select().from(evidence);
  const verified = new Set(existing.filter(row => row.verifiedAt).map(row => row.assetId));
  for (const assetId of assets) {
    if (verified.has(assetId)) continue;
    try {
      const proof = await readDeedMintProof(connection, assetId, collection);
      await db.insert(evidence).values({ ...proof, verifiedAt: new Date(), error: null })
        .onConflictDoUpdate({ target: evidence.assetId, set: { ...proof, verifiedAt: new Date(), error: null }, setWhere: isNull(evidence.verifiedAt) });
    } catch {
      await db.insert(evidence).values({ assetId, error: 'Original mint transaction, confirmation time or block order is unresolved.' })
        .onConflictDoNothing();
    }
  }
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('playtest-mint-inventory',0))`);
    const rows = await tx.select().from(evidence);
    const complete = assets.length === scan.assets.length && rows.length === assets.length
      && rows.every(row => row.verifiedAt && row.slot && BigInt(row.slot) <= BigInt(scan.throughSlot));
    if (!complete) {
      await tx.delete(inventory).where(eq(inventory.id, 'land-deeds'));
      const value = { id: 'land-deeds', state: 'unavailable' as const, lastAttemptAt: new Date(), reason: 'proof_unresolved', diagnostics: { reason: 'proof_unresolved' as const, assetCount: assets.length, attempts: scan.diagnostics.attempts } };
      await tx.insert(playtestMintStatus).values(value).onConflictDoUpdate({ target: playtestMintStatus.id, set: value });
      return { complete: false, assets: assets.length, diagnostics: value.diagnostics };
    }
    const receipt = { id: 'land-deeds', throughSlot: scan.throughSlot, assetCount: assets.length, completedAt: scan.completedAt };
    await tx.insert(inventory).values(receipt).onConflictDoUpdate({ target: inventory.id, set: receipt });
    const value = { id: 'land-deeds', state: 'complete' as const, lastAttemptAt: new Date(), lastSuccessAt: scan.completedAt, reason: null, diagnostics: scan.diagnostics };
    await tx.insert(playtestMintStatus).values(value).onConflictDoUpdate({ target: playtestMintStatus.id, set: value });
    return { complete: true, assets: assets.length, diagnostics: scan.diagnostics };
  });
}

/** Ended Founding campaigns need chain proof in addition to server eligibility. */
export async function reconcileCampaignCloseEvidence(db: Db, connection: Connection, collection: string) {
  const ended = await db.select().from(playtestCampaigns).where(and(eq(playtestCampaigns.kind, 'founding'),
    lte(playtestCampaigns.endAt, new Date()), isNull(playtestCampaigns.finalizedAt), isNull(playtestCampaigns.cancelledAt)));
  for (const campaign of ended) {
    const deeds = await requiredCampaignCloseDeeds(db, campaign.id);
    for (const deed of deeds) {
      const [existing] = await db.select().from(playtestCloseDeedEvidence).where(and(
        eq(playtestCloseDeedEvidence.campaignId, campaign.id), eq(playtestCloseDeedEvidence.assetId, deed.assetId)));
      if (existing?.verifiedAt) continue;
      try {
        if (!deed.observation?.slot || !deed.observation.owner || deed.observation.status !== 'owned') throw new Error('no finalized anchor');
        const proof = await readDeedOwnerAtClose(connection, { assetId: deed.assetId, collection,
          owner: deed.observation.owner, priorSlot: deed.observation.slot, endAt: campaign.endAt! });
        const value = { campaignId: campaign.id, assetId: deed.assetId, ...proof, verifiedAt: new Date(), error: null };
        await db.insert(playtestCloseDeedEvidence).values(value).onConflictDoUpdate({
          target: [playtestCloseDeedEvidence.campaignId, playtestCloseDeedEvidence.assetId], set: value,
          setWhere: isNull(playtestCloseDeedEvidence.verifiedAt),
        });
      } catch {
        const value = { campaignId: campaign.id, assetId: deed.assetId,
          error: 'Finalized close-time ownership history is unresolved; reconciliation required.' };
        await db.insert(playtestCloseDeedEvidence).values(value).onConflictDoUpdate({
          target: [playtestCloseDeedEvidence.campaignId, playtestCloseDeedEvidence.assetId], set: value,
          setWhere: isNull(playtestCloseDeedEvidence.verifiedAt),
        });
      }
    }
  }
  return { campaigns: ended.length };
}
