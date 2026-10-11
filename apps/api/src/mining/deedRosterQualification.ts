/** Paid-deed roster-day source facts only. A candidate is not an earning unit,
 * Genesis class, Seeker member, score, replacement permission or allocation. */
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { PHASE_E_MINING_SCORE_POLICY as POLICY } from '@shardkeep/shared';
import { readDeedMiningWalletEvidence, type DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import type { Db } from '../db/client';
import { readMiningRosterHistory } from './rosterHistory';

const key = z.string().min(32).max(44).refine(value => {
 if (value.length < 32 || value.length > 44) return false;
 try { return new PublicKey(value).toBase58() === value; } catch { return false; }
});
const requestSchema = z.object({ wallet: key, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), policyVersion: z.literal(POLICY.version) }).strict();
export interface DeedMiningRosterSource {
 /** Configured by the application, never by an untrusted request. Genesis
  * matching does not authenticate a provider's exhaustive address index. */
 source: DeedMiningWalletReader | ((signal: AbortSignal) => DeedMiningWalletReader);
 collection: string;
 expectedGenesisHash: string;
}
type Code = 'INVALID_INPUT' | 'SOURCE_CONFIGURATION_INVALID' | 'SOURCE_CONFLICT';
export class DeedMiningRosterQualificationError extends Error {
 constructor(readonly code: Code) { super(`Deed roster qualification refused: ${code}`); this.name = 'DeedMiningRosterQualificationError'; }
}
function fail(code: Code): never { throw new DeedMiningRosterQualificationError(code); }
export interface DeedMiningRosterCandidate { baseId: string; assetId: string; slot: number }
export type DeedMiningRosterExclusionReason = 'registered_roster_changed' | 'inactive_or_unslotted' | 'not_paid_before_day' | 'deed_not_finalized' | 'deed_not_in_collection' | 'deed_not_continuously_owned';
export interface DeedMiningRosterExclusion { baseId: string; assetId: string | null; reason: DeedMiningRosterExclusionReason }

export async function qualifyDeedMiningRosterDay(db: Db, source: DeedMiningRosterSource, value: unknown) {
 const parsed = requestSchema.safeParse(value); if (!parsed.success) fail('INVALID_INPUT');
 const { wallet, day, policyVersion } = parsed.data, startAt = new Date(`${day}T00:00:00.000Z`);
 if (!Number.isFinite(+startAt) || startAt.toISOString().slice(0, 10) !== day) fail('INVALID_INPUT');
 const endAt = new Date(+startAt + 86_400_000);
 if (!source || !key.safeParse(source.collection).success || !key.safeParse(source.expectedGenesisHash).success) fail('SOURCE_CONFIGURATION_INVALID');
 const reader = source.source, collection = source.collection, expectedGenesisHash = source.expectedGenesisHash;
 // The closed-day replay releases its locks before provider work. Its immutable
 // first-mutation journal, rather than current registry state, defines the day.
 const roster = await readMiningRosterHistory(db, { wallet, day, policyVersion });
 if (roster.wallet !== wallet || roster.day !== day || roster.policyVersion !== policyVersion) fail('SOURCE_CONFLICT');
 type Base = (typeof roster.open.bases)[number];
 const open = new Map(roster.open.bases.map(base => [base.id, base])), close = new Map(roster.close.bases.map(base => [base.id, base]));
 const all = new Map<string, Base>(), assetBases = new Map<string, string>(), registeredAssets = new Set<string>();
 const observe = (base: Base) => {
  if (base.deed_asset_id !== null && !key.safeParse(base.deed_asset_id).success) fail('SOURCE_CONFLICT');
  if (base.deed_asset_id !== null && base.deed_mint_asset_id !== null && base.deed_asset_id !== base.deed_mint_asset_id) fail('SOURCE_CONFLICT');
  for (const id of [base.deed_asset_id, base.deed_mint_asset_id]) {
   if (id === null) continue;
   const existing = assetBases.get(id); if (existing !== undefined && existing !== base.id) fail('SOURCE_CONFLICT');
   assetBases.set(id, base.id);
  }
  if (base.deed_asset_id !== null) registeredAssets.add(base.deed_asset_id);
  all.set(base.id, base);
 };
 for (const base of roster.open.bases) observe(base);
 for (const event of roster.changes) for (const state of [event.beforeState, event.afterState]) if (state && 'id' in state) observe(state);
 for (const base of roster.close.bases) observe(base);
 const deeds = await readDeedMiningWalletEvidence(reader, { collection, expectedGenesisHash, targetWallet: wallet, startAt, endAt });
 if (deeds.targetWallet !== wallet || deeds.collection !== collection || deeds.genesisHash !== expectedGenesisHash
  || +deeds.startAt !== +startAt || +deeds.endAt !== +endAt || deeds.throughBlockTime * 1000 < +endAt
  || deeds.deedlessThroughout !== (deeds.heldDuringIntervalAssetIds.length === 0)) fail('SOURCE_CONFLICT');
 const inventory = new Set(deeds.evidence.assets.map(asset => asset.assetId)), continuous = new Set(deeds.continuouslyHeldAssetIds);
 if (inventory.size !== deeds.evidence.assets.length || continuous.size !== deeds.continuouslyHeldAssetIds.length
  || [...continuous].some(id => !inventory.has(id))) fail('SOURCE_CONFLICT');
 const broken = new Set(roster.continuityBrokenBaseIds), candidates: DeedMiningRosterCandidate[] = [], excludedBases: DeedMiningRosterExclusion[] = [];
 for (const [baseId, last] of all) {
  const before = open.get(baseId), after = close.get(baseId), assetId = after?.deed_asset_id ?? before?.deed_asset_id ?? last.deed_asset_id;
  const beforeSlots = roster.open.slots.filter(slot => slot.base_id === baseId), afterSlots = roster.close.slots.filter(slot => slot.base_id === baseId);
  let reason: DeedMiningRosterExclusionReason | undefined;
  if (!before || !after || broken.has(baseId) || JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(beforeSlots) !== JSON.stringify(afterSlots)) reason = 'registered_roster_changed';
  else if (before.owner_wallet !== wallet || before.status !== 'active' || beforeSlots.length !== 1 || beforeSlots[0]!.wallet !== wallet || !beforeSlots[0]!.active) reason = 'inactive_or_unslotted';
  else if (before.land_paid_at === null || Date.parse(before.land_paid_at) >= +startAt) reason = 'not_paid_before_day';
  else if (assetId === null || before.deed_minting_at !== null) reason = 'deed_not_finalized';
  else if (!inventory.has(assetId)) reason = 'deed_not_in_collection';
  else if (!continuous.has(assetId)) reason = 'deed_not_continuously_owned';
  if (reason !== undefined) excludedBases.push({ baseId, assetId, reason });
  else candidates.push({ baseId, assetId: assetId!, slot: beforeSlots[0]!.slot });
 }
 candidates.sort((a, b) => a.slot - b.slot);
 excludedBases.sort((a, b) => a.baseId.localeCompare(b.baseId));
 return {
  wallet, day, policyVersion, candidates, excludedBases,
  unregisteredHeldAssetIds: deeds.heldDuringIntervalAssetIds.filter(id => !registeredAssets.has(id)).sort(),
  sourceQualification: 'complete' as const, sources: { registeredRoster: roster, deeds },
  eligibilityAuthorized: false as const, scoringAuthorized: false as const, allocationReady: false as const,
  publicationAuthorized: false as const, replacementAuthorized: false as const,
 };
}
