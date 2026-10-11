/**
 * PROTOTYPE only, owner island/permit amendment 2026-09-20. No runtime caller.
 * Prices/rate/terms below are owner-specified simulation inputs, not live game
 * constants; implementation must promote approved parameters to shared/constants.
 * Latest owner: one global Seeker island / 100 spots; tax pooled equally by spot;
 * KEEP tax = 10% gross recycled + 10% spot pool; market = 10% burn.
 * Only SOL access receipts split 50/50 owner/developer.
 */
import { REALM_IDS, type RealmId } from '@shardkeep/shared/baseVisual';

export const ISLAND_MODEL_PARAMS = {
  spotCount: 100, kingSpots: 20, normalSpots: 80, salesPerSpotDay: 10,
  // PROPOSED daily quota timezone: authoritative UTC day, not device clock.
  utcDaySeconds: 86_400n, auctionSeconds: 86_400n,
  earnedTaxBps: 2_000n, equalShareBps: 5_000n, marketBurnBps: 1_000n, permitLamports: 10_000_000n,
  permitSeconds: 7n * 24n * 60n * 60n, occupationSeconds: 7n * 24n * 60n * 60n,
  // PROPOSED retained on-chain design §8 minimum, not a new owner lock.
  marketMinFillAtoms: 1_000_000n,
} as const;
const BPS = 10_000n;
const nonnegative = (n: bigint, label: string): void => {
  if (n < 0n) throw new Error(`${label} must be nonnegative`);
};
const remainder = (n: bigint): void => {
  if (n < 0n || n >= BPS) throw new Error('carry outside [0,10000)');
};

export type ResourceOrigin = 'new-earnings' | 'existing-transfer' | 'conversion' | 'tax-receipt' | 'refund';
export interface TaxResult {
  gross: bigint; net: bigint; tax: bigint;
  /** Persist atomically with the source reward receipt, never reset on collect. */
  carry: bigint;
}
/** PROPOSED carry scope: stable wallet + resource + tax-rate-policy lineage,
 * shared by all bases/collects/expeditions. Realm/lease changes must not reset it.
 * Input origin classification and carry persistence must be server-authoritative.
 * bigint has no arithmetic overflow; storage representation bounds remain a gate.
 */
export function assessEarnedTax(gross: bigint, carry: bigint, origin: ResourceOrigin): TaxResult {
  nonnegative(gross, 'gross'); remainder(carry);
  if (origin !== 'new-earnings') return { gross, net: gross, tax: 0n, carry };
  const numerator = gross * ISLAND_MODEL_PARAMS.earnedTaxBps + carry;
  const tax = numerator / BPS;
  return { gross, net: gross - tax, tax, carry: numerator % BPS };
}

export interface RevenueSplit { owner: bigint; remainderRecipient: bigint; carry: bigint }
/** Internal integer split helper. Owner-locked ledger wrappers below supply the
 * rates; callers cannot override those ledger policies. PROPOSED mining split
 * carry scope: global KEEP tax stream + split-policy lineage, spanning source
 * wallets/leases. This helper splits recycling/island, not resource-owner/dev.
 * Sum always equals original tax/fee; receiving tax is not new taxable issuance.
 */
export function splitRevenue(amount: bigint, ownerShareBps: bigint, carry: bigint): RevenueSplit {
  nonnegative(amount, 'amount'); remainder(carry);
  if (ownerShareBps < 0n || ownerShareBps > BPS) throw new Error('invalid share');
  const numerator = amount * ownerShareBps + carry;
  const owner = numerator / BPS;
  return { owner, remainderRecipient: amount - owner, carry: numerator % BPS };
}

export interface ResourceTaxCarry { earned: bigint }
export interface MiningTaxCarry extends ResourceTaxCarry { recycleShare: bigint }

/** LOCKED latest clarification: 80% earner, 20% global-island equal-spot tax pool, zero dev. */
export function resourceEarningsLedger(gross: bigint, carry: ResourceTaxCarry,
  origin: ResourceOrigin = 'new-earnings') {
  const assessed = assessEarnedTax(gross, carry.earned, origin);
  return { gross, net: assessed.net, tax: assessed.tax, islandPool: assessed.tax,
    developer: 0n, carry: { earned: assessed.carry } };
}

/** LOCKED: 80% miner, 10% returned emission reserve, 10% island equal-spot pool, zero dev.
 * Reserve recycling is not a burn or island income and not an extra budget for
 * same-day issuance. Existing wallet-model outputs are PRE-TAX gross accrual.
 */
export function miningEarningsLedger(gross: bigint, carry: MiningTaxCarry,
  origin: ResourceOrigin = 'new-earnings') {
  const assessed = assessEarnedTax(gross, carry.earned, origin);
  const recycle = splitRevenue(assessed.tax, ISLAND_MODEL_PARAMS.equalShareBps, carry.recycleShare);
  return { gross, net: assessed.net, tax: assessed.tax, recycled: recycle.owner,
    islandPool: recycle.remainderRecipient, developer: 0n,
    carry: { earned: assessed.carry, recycleShare: recycle.carry } };
}

/** LOCKED ordinary KEEP market: seller 90%, actual burn 10%; no island/dev fee.
 * This sale is an existing-token transfer, never a new-mining earnings event.
 */
export function marketKeepLedger(gross: bigint) {
  nonnegative(gross, 'gross');
  if (gross < ISLAND_MODEL_PARAMS.marketMinFillAtoms) throw new Error('below proposed market minimum');
  // Retained §8 rail: round seller DOWN, burn UP, for every quoted partial fill.
  const seller = gross * (BPS - ISLAND_MODEL_PARAMS.marketBurnBps) / BPS;
  return { gross, seller, burned: gross - seller };
}

/** LOCKED 0.01 SOL permit: 0.005 SOL owner + 0.005 SOL developer. */
export function permitRevenueLedger(paidLamports: bigint) {
  if (paidLamports !== ISLAND_MODEL_PARAMS.permitLamports) throw new Error('wrong permit amount');
  const owner = paidLamports * ISLAND_MODEL_PARAMS.equalShareBps / BPS;
  return { gross: paidLamports, owner, developer: paidLamports - owner };
}

export interface RealmPermit {
  wallet: string; targetRealm: string; startsAt: bigint; expiresAt: bigint;
  /** Freezes purchased terms; seven-day selling-spot changes cannot cancel it. */
  purchaseTermsId: string;
}
/** Pure price/interval primitive; quota/realm authorization is issueSpotPermit below. */
export function purchaseRealmPermit(wallet: string, targetRealm: string, now: bigint,
  paidLamports: bigint, purchaseTermsId: string): RealmPermit {
  nonnegative(now, 'time');
  permitRevenueLedger(paidLamports);
  return { wallet, targetRealm, startsAt: now,
    expiresAt: now + ISLAND_MODEL_PARAMS.permitSeconds, purchaseTermsId };
}
export interface OccupationSnapshot {
  kind: 'king' | 'normal'; realmOffers: readonly RealmId[];
  siteId: string; ownerWallet: string; startsAt: bigint; endsAt: bigint;
  assignmentId: string; termsId: string;
}
export interface DispatchInput {
  wallet: string;
  /** Verified deed realms; which owned/active deeds qualify is still unresolved. */
  deedRealms: readonly string[];
  targetRealm: string;
  vehicleEligible: boolean;
  now: bigint; durationSeconds: bigint;
  permit?: RealmPermit;
  /** Global tax-pool snapshot, independent of destination realm or permit seller. */
  occupation: GlobalOccupationSnapshot;
  rewardTableVersion: string;
}
export interface ExpeditionAdmission {
  wallet: string; targetRealm: string; departedAt: bigint; returnsAt: bigint;
  access: 'deed-realm' | 'paid-permit';
  permitTermsId: string | null;
  /** PROPOSED dispatch-time equal-spot pool snapshot; accrual timing still open. */
  occupation: GlobalOccupationSnapshot;
  rewardTableVersion: string;
}
/** Permission is checked at dispatch; completion honors that frozen entitlement.
 * Never substitute permit payment for vehicle eligibility. Unavailable owner data
 * must be rejected upstream, not represented as an empty successful snapshot.
 */
export function admitExpedition(input: DispatchInput): ExpeditionAdmission {
  nonnegative(input.now, 'time'); nonnegative(input.durationSeconds, 'duration');
  if (input.durationSeconds === 0n) throw new Error('empty expedition');
  if (!input.vehicleEligible) throw new Error('vehicle ineligible');
  const home = input.deedRealms.includes(input.targetRealm);
  const permit = input.permit;
  const paidAccess = permit !== undefined && permit.wallet === input.wallet
    && permit.targetRealm === input.targetRealm && permit.startsAt <= input.now
    && input.now < permit.expiresAt;
  if (!home && !paidAccess) throw new Error('realm access missing');
  const occupation = input.occupation;
  if (!occupation) throw new Error('global pool snapshot unavailable');
  validateGlobalSnapshot(occupation, input.now);
  if (occupation.spots.length === 0) throw new Error('no winning spots: activation held');
  return {
    wallet: input.wallet, targetRealm: input.targetRealm, departedAt: input.now,
    returnsAt: input.now + input.durationSeconds, access: home ? 'deed-realm' : 'paid-permit',
    permitTermsId: !home && permit ? permit.purchaseTermsId : null,
    occupation: { ...occupation, spots: occupation.spots.map((spot) => ({ ...spot, realmOffers: [...spot.realmOffers] })) },
    rewardTableVersion: input.rewardTableVersion,
  };
}
/** A deterministic due-time predicate, NOT persistent once-only settlement. */
export function expeditionDue(expedition: ExpeditionAdmission, now: bigint): boolean {
  return now >= expedition.returnsAt;
}


export interface GlobalOccupationSnapshot {
  jurisdiction: 'global'; snapshotId: string; termsId: string;
  termStartsAt: bigint; termEndsAt: bigint;
  /** LOCKED: unsold spots are blocked for the whole term and earn no share. */
  vacancyPolicy: 'winning-spots-only';
  spots: readonly OccupationSnapshot[];
}

export function validateSpot(spot: OccupationSnapshot, now: bigint): void {
  if (spot.startsAt > now || now >= spot.endsAt
    || spot.endsAt - spot.startsAt !== ISLAND_MODEL_PARAMS.occupationSeconds) {
    throw new Error('invalid occupation snapshot');
  }
  const realms = new Set(spot.realmOffers);
  if (realms.size !== spot.realmOffers.length || [...realms].some((r) => !REALM_IDS.includes(r))) {
    throw new Error('invalid realm offer');
  }
  if (spot.kind === 'king' ? realms.size !== REALM_IDS.length
    : spot.kind !== 'normal' || realms.size < 1 || realms.size > 4) {
    throw new Error('invalid spot offer count');
  }
}

export function validateGlobalSnapshot(snapshot: GlobalOccupationSnapshot, now: bigint): void {
  if (snapshot.jurisdiction !== 'global' || snapshot.vacancyPolicy !== 'winning-spots-only') {
    throw new Error('unsupported global pool policy');
  }
  if (snapshot.termStartsAt > now || now >= snapshot.termEndsAt
    || snapshot.termEndsAt - snapshot.termStartsAt !== ISLAND_MODEL_PARAMS.occupationSeconds
    || snapshot.spots.some((s) => s.startsAt !== snapshot.termStartsAt || s.endsAt !== snapshot.termEndsAt)) {
    throw new Error('mixed or invalid global term');
  }
  const ids = new Set(snapshot.spots.map((s) => s.siteId));
  if (ids.size !== snapshot.spots.length) throw new Error('duplicate spot');
  if (snapshot.spots.length > ISLAND_MODEL_PARAMS.spotCount
    || snapshot.spots.filter((s) => s.kind === 'king').length > ISLAND_MODEL_PARAMS.kingSpots
    || snapshot.spots.filter((s) => s.kind === 'normal').length > ISLAND_MODEL_PARAMS.normalSpots) {
    throw new Error('spot catalogue limit');
  }
  snapshot.spots.forEach((s) => validateSpot(s, now));
}

/** LOCKED denominator: this term's winning spots only. Zero winners hold all.
 * One resource/currency at a time. The time argument is the source earning time,
 * NOT the processing clock, so delayed settlement preserves historical owners. Dust remains attached to this frozen snapshot,
 * never silently handed to the next week's owners. Persist pool receipt once.
 */
export function allocateIslandTaxPool(amount: bigint, snapshot: GlobalOccupationSnapshot,
  earnedAt: bigint, poolReceiptId: string) {
  nonnegative(amount, 'amount'); validateGlobalSnapshot(snapshot, earnedAt);
  const share = snapshot.spots.length === 0 ? 0n : amount / BigInt(snapshot.spots.length);
  const receipts = snapshot.spots.map((s) => ({ poolReceiptId, snapshotId: snapshot.snapshotId,
    termsId: snapshot.termsId, siteId: s.siteId, ownerWallet: s.ownerWallet,
    assignmentId: s.assignmentId, amount: share }));
  const wallets = new Map<string, bigint>();
  for (const receipt of receipts) wallets.set(receipt.ownerWallet,
    (wallets.get(receipt.ownerWallet) ?? 0n) + receipt.amount);
  return { amount, receipts, wallets, retained: amount - share * BigInt(snapshot.spots.length),
    retainedSnapshotId: snapshot.snapshotId, held: snapshot.spots.length === 0 };
}

export interface SpotSaleCounter { siteId: string; utcDay: bigint; sold: number }
/** Pure transition only: caller must atomically verify finalized receipt, reserve
 * slot, credit exact selling owner/dev, issue permit and persist counter once.
 * Counter is SPOT/day, not owner/day or realm/day, so turnover cannot reset it.
 */
export function issueSpotPermit(input: { spot: OccupationSnapshot; counter: SpotSaleCounter;
  wallet: string; targetRealm: RealmId; now: bigint; paidLamports: bigint; purchaseTermsId: string }) {
  nonnegative(input.now, 'time'); validateSpot(input.spot, input.now);
  if (!input.spot.realmOffers.includes(input.targetRealm)) throw new Error('realm not offered');
  if (input.counter.siteId !== input.spot.siteId || !Number.isInteger(input.counter.sold)
    || input.counter.sold < 0 || input.counter.sold > ISLAND_MODEL_PARAMS.salesPerSpotDay) {
    throw new Error('invalid sale counter');
  }
  const day = input.now / ISLAND_MODEL_PARAMS.utcDaySeconds;
  if (input.counter.utcDay < 0n || input.counter.utcDay > day) throw new Error('counter clock regression');
  const sold = input.counter.utcDay === day ? input.counter.sold : 0;
  if (sold >= ISLAND_MODEL_PARAMS.salesPerSpotDay) throw new Error('spot daily contracts exhausted');
  const permit = purchaseRealmPermit(input.wallet, input.targetRealm, input.now,
    input.paidLamports, input.purchaseTermsId);
  return { permit, sellingSpot: input.spot.siteId, sellerWallet: input.spot.ownerWallet,
    sellerAssignmentId: input.spot.assignmentId, revenue: permitRevenueLedger(input.paidLamports),
    counter: { siteId: input.spot.siteId, utcDay: day, sold: sold + 1 } };
}

/** PROPOSED balanced fixture, not approved realm catalogue: 20 kings; 20 normal
 * of each offer-count 1/2/3/4. Rotated groups yield exactly 25 normal offers/realm.
 */
export function balancedSpotCatalogue(): Array<{ siteId: string; kind: 'king' | 'normal'; realmOffers: readonly RealmId[] }> {
  const catalogue: Array<{ siteId: string; kind: 'king' | 'normal'; realmOffers: readonly RealmId[] }> = [];
  for (let i = 0; i < ISLAND_MODEL_PARAMS.kingSpots; i++) {
    catalogue.push({ siteId: `king-${i}`, kind: 'king', realmOffers: [...REALM_IDS] });
  }
  for (let group = 0; group < 20; group++) {
    let offset = group * 10;
    for (let count = 1; count <= 4; count++) {
      catalogue.push({ siteId: `normal-${group}-${count}`, kind: 'normal',
        realmOffers: Array.from({ length: count }, (_, i) => REALM_IDS[(offset + i) % REALM_IDS.length]!) });
      offset += count;
    }
  }
  return catalogue;
}


/** LOCKED: full seven-day operations; next24h auction overlaps the final day.
 * Epoch origin is a persisted authoritative schedule anchor, never device time.
 */
export function islandCycleAt(origin: bigint, now: bigint) {
  nonnegative(origin, 'origin');
  if (now < origin) throw new Error('before cycle origin');
  const index = (now - origin) / ISLAND_MODEL_PARAMS.occupationSeconds;
  const startsAt = origin + index * ISLAND_MODEL_PARAMS.occupationSeconds;
  const endsAt = startsAt + ISLAND_MODEL_PARAMS.occupationSeconds;
  const nextAuctionStartsAt = endsAt - ISLAND_MODEL_PARAMS.auctionSeconds;
  return { index, startsAt, endsAt, nextAuctionStartsAt, nextAuctionEndsAt: endsAt,
    nextAuctionOpen: now >= nextAuctionStartsAt };
}
