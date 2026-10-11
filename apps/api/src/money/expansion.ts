import { CAPS, PLOT_GEOMETRY, STRUCTURES } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { bases, players } from '../db/schema';
import { HttpError } from '../lib/errors';

const unavailable = () => new HttpError(503, 'Land expansion rules are unavailable. Please try again later.', 'EXPANSION_RULES_UNAVAILABLE');

/** Validate the progression as a whole: a missing step must never become an
 * ungated purchase or an implicit jump over an unconfigured claim. Prices are
 * separate so a pricing outage cannot strand an already-frozen payment. */
function expansionStep(index: number) {
  const { expansionsMax, claimTilesByExpansion: claims, expansionReqKeepLevel: gates } = CAPS;
  const bounds = PLOT_GEOMETRY.boundsByVersion[PLOT_GEOMETRY.currentVersion];
  if (!Number.isInteger(expansionsMax) || expansionsMax < 1 || !Array.isArray(claims) || !Array.isArray(gates)
    || claims.length !== expansionsMax + 1 || gates.length !== expansionsMax
    || Array.from(claims).some((size, i) => !Number.isInteger(size) || size <= 0
      || size % 2 !== 0 || size > bounds.max - bounds.min || (i > 0 && size <= claims[i - 1]!))
    || Array.from(gates).some(gate => !Number.isInteger(gate) || gate < 1 || gate > STRUCTURES.keep.maxLevel)) throw unavailable();
  if (!Number.isInteger(index) || index < 0) throw unavailable();
  if (index >= expansionsMax) throw new HttpError(422, 'max land expansions reached');
  return { expectedExpansions: index, fromClaimTiles: claims[index]!, toClaimTiles: claims[index + 1]!, requiredKeepLevel: gates[index]! };
}

/** Canonical new-offer policy; no reference, receipt or payment is created here. */
export function expansionOffer(expansions: number, keepLevel: number) {
  const step = expansionStep(expansions);
  if (!Number.isInteger(keepLevel) || keepLevel < step.requiredKeepLevel) {
    throw new HttpError(422, `expansion ${expansions + 1} requires Keep level ${step.requiredKeepLevel}`);
  }
  const prices = CAPS.expansionPriceSolByIndex;
  if (!Array.isArray(prices) || prices.length !== CAPS.expansionsMax
    || Array.from(prices).some(price => typeof price !== 'number')) throw unavailable();
  const amounts = Array.from(prices, price => price * 1_000_000_000); // SOL denomination, not a game price.
  if (amounts.some(amount => !Number.isSafeInteger(amount) || amount <= 0)) throw unavailable();
  return { ...step, amountLamports: amounts[expansions]! };
}

export interface FrozenExpansion {
  expectedExpansions: number;
  baseId?: string | undefined;
  landPaidAt?: string | undefined;
  deedAssetId?: string | null | undefined;
}
type ExpansionBase = Pick<typeof bases.$inferSelect, 'id' | 'expansions' | 'keepLevel' | 'landPaidAt' | 'deedAssetId'>;

/** Caller must hold the payer/player and original base locks in one transaction
 * and authorize its receipt before calling. Production calls only AFTER exact
 * verified payment/immutable quote checks. This helper grants no payment proof,
 * chooses no current base and never re-prices the original accepted amount.
 * A deed transfer intentionally does not redirect an in-flight paid expansion. */
export async function applyLockedExpansion(
  tx: DbTx, base: ExpansionBase, frozen: FrozenExpansion, payerWallet: string, now: Date,
): Promise<number> {
  if (!frozen.landPaidAt || base.landPaidAt?.toISOString() !== frozen.landPaidAt
    || frozen.deedAssetId !== base.deedAssetId || (frozen.baseId !== undefined && frozen.baseId !== base.id)) {
    throw new HttpError(409, 'expansion deposit belongs to a different base epoch');
  }
  if (base.expansions !== frozen.expectedExpansions) throw new HttpError(409, 'expansion slot changed before payment verification');
  const step = expansionStep(frozen.expectedExpansions);
  if (!Number.isInteger(base.keepLevel) || base.keepLevel < step.requiredKeepLevel) {
    throw new HttpError(422, `expansion requires Keep level ${step.requiredKeepLevel}`);
  }
  const [updated] = await tx.update(bases)
    .set({ expansions: sql`${bases.expansions} + 1`, updatedAt: now })
    .where(and(eq(bases.id, base.id), eq(bases.expansions, frozen.expectedExpansions)))
    .returning({ expansions: bases.expansions });
  if (!updated) throw new HttpError(409, 'expansion slot changed before payment verification');
  const owned = await tx.select({ id: bases.id }).from(bases)
    .where(eq(bases.ownerWallet, payerWallet)).limit(2);
  if (owned.length === 1 && owned[0]!.id === base.id) {
    await tx.update(players).set({ expansions: updated.expansions }).where(eq(players.wallet, payerWallet));
  }
  return updated.expansions;
}
