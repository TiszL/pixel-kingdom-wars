import type { BasePurchaseQuote, BasePurchaseRequest, BasePurchaseNetwork } from '@shardkeep/shared/basePurchases';
import { freezeBasePurchaseQuote, assertBasePurchasePayment, allowBasePurchaseTerminal } from './basePurchases';
/**
 * Deposit watcher (PLAN.md 4g — GDD §4.9 "Deposits", ARCHITECTURE §5).
 *
 * Flow: the client asks for a deposit intent (we mint a fresh reference
 * pubkey), builds the on-chain tx (pay_entry / generic buy_sink / direct SOL —
 * each carries the reference as a no-op account), and submits it. The
 * watcher polls signatures FOR THE REFERENCE KEY, verifies the finalized
 * transaction invoked OUR program from the player's wallet, and credits
 * exactly once (idempotent on tx signature + deposit row state).
 *
 * Verification (fetch + decode) is separated from crediting so the credit
 * path is unit-testable; the verifier runs against devnet in e2e (Phase 6).
 */
import { BASE_OWNERSHIP, CAPS, DEPOSIT_VERIFICATION, ECONOMY, GEMS, RAID_ENERGY, SHIELD, TOKEN, upgradeSolLamports, VEND, WARZONE, vendLamportsForKeep } from '@shardkeep/shared';
import { isCanonicalSolanaSignature } from '@shardkeep/chain';
import { FANTASY_WORLD_ID, type LandAddress } from '@shardkeep/shared/fantasyWorld';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { randomUUID, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import bs58 from 'bs58';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { retainKeepCustodyConfirmed, type KeepCustodySourceProof } from '../db/keepCustodySource';
import {
  baseRaidLocks, bases, baseSlots, baseTransfers, buildings, deedEconomyCutoverState,
  basePurchaseShieldReceipts, deposits, earthCountries, fantasyLandClaims, players, plots, plotReservations, valleys,
} from '../db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../ledger/accounts';
import { depositMint } from './mintDimension';
import { postTransaction } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import { fantasyWorldEnabled, gemsWalletBuyEnabled, multiBaseEnabled } from '../config';
import { gemsReserveAta } from './economyIdentity';
import { gemsBuyDisclosure, originalGemsBuyIntent } from './gemsBuyReceipt';
import { depositPaymentRecoverable, recoverableDepositPaymentSql } from './depositRecovery';
import { assertConvertibleKeep } from '../game/gems';
import { activateFantasyPurchaseCutover, assignPaidFantasyClaim, fantasyPurchasesCutOver, getFantasyClaim, requireOrdinaryFantasyTile, reserveFantasyPurchase, stagePendingLegacyFantasyPurchases } from '../game/fantasyLocation';
import { ensureWalletBaseIdentity, reserveEarthCell } from '../game/baseOwnership';
import { chooseAvailableEarthParcel, ensureValleyAtSite } from '../game/world';
import { invalidateShieldMapValley, shieldMapValleyId } from '../game/baseShields';
import { applyLockedExpansion, expansionOffer } from './expansion';
import { closeHarvesterSources } from '../game/harvesterSettlement';

export type DepositKind = 'entry' | 'deed' | 'builder' | 'expansion' | 'energy' | 'energy_pack' | 'shield' | 'mine' | 'keep_deposit' | 'mine_build' | 'warzone_shield' | 'keep_vend' | 'gems_buy';

export const KEEP_VEND_UNAVAILABLE_CODE = 'KEEP_VEND_UNAVAILABLE';

/**
 * New SOL→KEEP sales stay dark until treasury moves matching reserve KEEP into
 * custody. Historical intents remain creditable, so this guard belongs only on
 * intent creation — never on creditDeposit.
 */
export function throwKeepVendUnavailable(): never {
  throw new HttpError(
    503,
    'KEEP purchases are temporarily unavailable while reserve funding is prepared',
    KEEP_VEND_UNAVAILABLE_CODE,
  );
}

/** Optional action payload per kind. Paid upgrades (kind 'mine': Mine L5+ /
 *  Gold Forge L2+ since D-057) target a building; a historical mine_build
 *  targets a tile (where the new mine goes); a keep_vend carries the whole-KEEP
 *  amount being bought (the server prices it). */
export interface DepositPayload {
  basePurchaseV1?: BasePurchaseQuote | undefined;
  landAddress?: LandAddress | { kind: 'fantasy'; worldId: 'fantasy-v1'; tileId?: number } | undefined;
  /** Stable land-intent eligibility fence. Version 1 means the canonical
   * player lock authorized this entry/deed rail when the payable reference was
   * created; later ownership changes must not strand that already-broadcast payment. */
  landPurchaseVersion?: 1 | undefined;
  /** Stable land identity. Builder/expansion quotes are never wallet-global. */
  baseId?: string | undefined;
  buildingId?: string | undefined;
  tx?: number | undefined;
  ty?: number | undefined;
  keepOut?: number | undefined;
  /** Frozen builder slot and exact quote. A builder payment must never float to
   * a later, more expensive slot after another intent resolves first. */
  expectedBuilders?: number | undefined;
  expectedExpansions?: number | undefined;
  expectedMines?: number | undefined;
  amountLamports?: number | undefined;
  /** Versioned energy grants retain the original SKU quantity across catalogue changes. */
  energyQuantity?: number | undefined;
  earthCell?: number | undefined;
  siteId?: number | undefined;
  countryA3?: string | undefined;
  /** Single-base compatibility epoch. Multi-base replaces this with baseId,
   * but a quote must already fail if the deed/land leaves this wallet. */
  landPaidAt?: string | undefined;
  deedAssetId?: string | null | undefined;
  /** gems_buy (E2-GEMS-CONTRACT §2): the client key that makes the intent
   * unique per wallet (`deposits_gems_buy_key_uq`), the whole KEEP the player
   * said they would send and the Gems that amount mints. A quote, not an
   * entitlement: the credit mints against the KEEP actually observed. */
  idempotencyKey?: string | undefined;
  keepIn?: number | undefined;
  gemsOut?: number | undefined;
  /** K-156: original token precision and expiry travel with new Gems quotes. */
  gemsBuyVersion?: 1 | undefined;
  decimals?: number | undefined;
  expiresAt?: string | undefined;
  /** gems_buy: the reserve token account and KEEP mint the SERVER quoted when
   * the intent was created (security review 2026-09-20 #1). The verifiers
   * prove the transfer against THESE, never against the env at verification
   * time, so a rotated or unset GEMS_RESERVE_ATA can neither strand a paid
   * intent nor let a transfer to a stale account credit. Immutable with the row. */
  destination?: string | undefined;
  mint?: string | undefined;
}

/** Exact, immutable intent snapshot proved at CONFIRMED before a wallet's
 * submitted signature may be persisted. Finalized verification still owns the
 * grant; this seam only prevents public-signature squatting. */
export interface DepositPaymentCommitIntent {
  basePurchaseV1?: BasePurchaseQuote | undefined;
  id: string;
  playerWallet: string;
  kind: DepositKind;
  reference: string;
  createdAt: Date;
  expectedLamports?: bigint | undefined;
  paymentSignature: string;
  /** gems_buy: server-frozen reserve ATA + mint (payload.destination / .mint). */
  destination?: string | undefined;
  mint?: string | undefined;
}

export type DepositPaymentCommitVerifier = (
  intent: DepositPaymentCommitIntent,
) => Promise<{ txSignature: string; keepCustodySource?: KeepCustodySourceProof } | null>;

export interface DepositStableAuthorityContext {
  baseId: string;
  assertAuthority: (tx: DbTx, wallet: string, baseId: string) => Promise<void>;
}

/** Rolling-upgrade bridge for a paid wallet created after the stable-base
 * migration but before entry credit began materializing the identity itself.
 * A wallet recorded as a deed seller is deliberately ineligible: its legacy
 * player scalars remain for compatibility and must never resurrect sold land. */
async function materializeLegacyDepositBase(db: Db, wallet: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [player] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const owned = await tx.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, wallet)).orderBy(asc(bases.createdAt)).limit(2).for('update');
    if (owned.length > 0) return;
    const [sale] = await tx.select({ id: baseTransfers.id }).from(baseTransfers)
      .where(eq(baseTransfers.fromWallet, wallet)).limit(1);
    const [deedElsewhere] = player.deedAssetId
      ? await tx.select({ id: bases.id }).from(bases).where(eq(bases.deedAssetId, player.deedAssetId)).limit(1)
      : [undefined];
    if (sale || deedElsewhere) {
      throw new HttpError(409, 'no owned base remains for this payment', 'BASE_NOT_OWNED');
    }
    if (!player.entryPaidAt) throw new HttpError(402, 'entry not paid');
    const [base] = await tx.insert(bases).values({
      ownerWallet: wallet,
      deedAssetId: player.deedAssetId,
      deedMintAssetId: player.deedMintAssetId ?? player.deedAssetId,
      keepLevel: player.keepLevel,
      builders: player.builders,
      expansions: player.expansions,
      landPaidAt: player.entryPaidAt,
      deedMintingAt: player.deedMintingAt,
    }).returning({ id: bases.id });
    await tx.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id, selectedAt: new Date() });
    // Only unbound rolling-upgrade rows move. Stable rows belonging to a sold
    // deed retain their original base id and can never be swept into this one.
    await tx.execute(sql`update buildings set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update obstacles set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update builder_jobs set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update layouts set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update shields set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update plots set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
  });
}

/** Player is already locked by the caller. Lock the active stable base next;
 * deposit rows are always locked third, giving quote and credit one order. */
async function lockDepositBase(tx: DbTx, wallet: string, requestedBaseId?: string) {
  const rows = await tx.select({ base: bases, slot: baseSlots.slot }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), eq(bases.status, 'active'),
      ...(requestedBaseId ? [eq(bases.id, requestedBaseId)] : []),
    )).orderBy(asc(baseSlots.slot)).for('update');
  if (requestedBaseId && rows.length === 0) {
    throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  }
  if (!requestedBaseId && rows.length !== 1) {
    throw new HttpError(409, 'baseId is required when multiple active bases exist', 'BASE_ID_REQUIRED');
  }
  return rows[0]!;
}

/** Stable quote boundary. The route refreshes finalized ownership before this
 * transaction; this lock/recheck is the authority to expose a payable reference. */
async function lockAuthorizedDepositBase(
  tx: DbTx, wallet: string, requestedBaseId: string | undefined,
  stableContext?: DepositStableAuthorityContext,
) {
  if (!stableContext) {
    const { base } = await lockDepositBase(tx, wallet, requestedBaseId);
    if (!base.landPaidAt) throw new HttpError(402, 'entry not paid');
    return { ...base, landPaidAt: base.landPaidAt };
  }
  if (!requestedBaseId || stableContext.baseId !== requestedBaseId) {
    throw new HttpError(409, 'base authority context does not match target', 'BASE_NOT_OWNED');
  }
  const [base] = await tx.select().from(bases).where(and(
    eq(bases.id, requestedBaseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
  )).for('update');
  if (!base) throw new HttpError(409, 'selected land base changed', 'DEED_OWNERSHIP_CHANGED');
  const [slot] = await tx.select({ baseId: baseSlots.baseId }).from(baseSlots).where(and(
    eq(baseSlots.baseId, requestedBaseId), eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
  )).for('update');
  if (!slot) throw new HttpError(409, 'selected land base changed', 'DEED_OWNERSHIP_CHANGED');
  if (!base.landPaidAt) throw new HttpError(402, 'entry not paid');
  const [raidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
    .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, requestedBaseId)).for('update');
  if (raidLock) {
    throw new HttpError(
      423,
      'You are being raided, please wait to continue playing or watch it live',
      'BASE_BEING_RAIDED',
    );
  }
  await stableContext.assertAuthority(tx, wallet, requestedBaseId);
  return { ...base, landPaidAt: base.landPaidAt };
}

/** Credit-time lock for a quote that already froze its stable identity. A deed
 * sale does not cancel a paid improvement: the same base receives it for its
 * new owner, provided every frozen epoch field still matches. */
async function lockFrozenDepositBase(tx: DbTx, baseId: string) {
  const [base] = await tx.select().from(bases).where(eq(bases.id, baseId)).for('update');
  if (!base) throw new HttpError(409, 'frozen deposit base no longer exists', 'BASE_NOT_OWNED');
  // A quote may be paid before a defender raid begins and finalize while its
  // immutable snapshot is live. Credit must therefore re-check the deed lock
  // BEFORE claiming the deposit/signature or applying any paid mutation. The
  // verified intent remains pending and the watcher retries it after release.
  const [raidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
    .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, baseId)).for('update');
  if (raidLock) {
    throw new HttpError(
      423,
      'You are being raided, please wait to continue playing or watch it live',
      'BASE_BEING_RAIDED',
    );
  }
  return base;
}

async function resolveStableDepositBase(db: Db, wallet: string, requestedBaseId?: string) {
  if (!requestedBaseId) await materializeLegacyDepositBase(db, wallet);
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const { base } = await lockDepositBase(tx, wallet, requestedBaseId);
    if (!base.landPaidAt) throw new HttpError(402, 'entry not paid');
    return base;
  });
}

/** On-chain price (lamports) the buy_sink payment must meet or exceed before the
 *  server grants a pay-per-action SOL sink. The program routes whatever `amount`
 *  the client sends across the treasuries, so the SERVER is the price authority:
 *  an underpaying client only wastes its own SOL and is granted nothing. */
const SINK_PRICE_LAMPORTS: Record<'energy' | 'energy_pack' | 'shield', bigint> = {
  energy: BigInt(RAID_ENERGY.solLamportsPerEnergy),
  // Per-unit pack pricing (owner 2026-07-26): 0.015 × 6 — see RAID_ENERGY.
  energy_pack: BigInt(RAID_ENERGY.packLamports),
  shield: BigInt(SHIELD.extendCostSolLamports),
};

const LAND_PRICE_LAMPORTS = Math.round(ECONOMY.entryFeeSol * 1_000_000_000);

/** Entry is an init-once rail. Stable land, a completed/terminal entry attempt,
 * or a prior deed sale means every later parcel must use the repeatable deed
 * rail even when the lossy player compatibility shadow is currently null. */
export async function entryPurchaseConsumed(
  db: DbOrTx, wallet: string, lockedEntryPaidAt?: Date | null,
): Promise<boolean> {
  let entryPaidAt = lockedEntryPaidAt;
  if (entryPaidAt === undefined) {
    const [player] = await db.select({ entryPaidAt: players.entryPaidAt })
      .from(players).where(eq(players.wallet, wallet));
    entryPaidAt = player?.entryPaidAt ?? null;
  }
  if (entryPaidAt) return true;
  const [[paidBase], [consumedEntry], [sold]] = await Promise.all([
    db.select({ id: bases.id }).from(bases).where(and(
      eq(bases.ownerWallet, wallet), isNotNull(bases.landPaidAt),
    )).limit(1),
    db.select({ id: deposits.id }).from(deposits).where(and(
      eq(deposits.playerWallet, wallet), eq(deposits.kind, 'entry'),
      inArray(deposits.status, ['credited', 'failed']),
    )).limit(1),
    db.select({ id: baseTransfers.id }).from(baseTransfers)
      .where(eq(baseTransfers.fromWallet, wallet)).limit(1),
  ]);
  return !!paidBase || !!consumedEntry || !!sold;
}

/** Server-authoritative checkout rail for the globe. The client must not infer
 * this from `players.entryPaidAt`: selling the last deed clears that shadow but
 * does not make the one-time entry program payable again. */
export async function nextLandPurchaseKind(db: Db, wallet: string): Promise<'entry' | 'deed'> {
  const [player] = await db.select({ entryPaidAt: players.entryPaidAt })
    .from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found');
  return await entryPurchaseConsumed(db, wallet, player.entryPaidAt) ? 'deed' : 'entry';
}

/** D-103: the reserved parcel must READ as land (country + cell) before any
 * wallet prompt, so the intent answers with the name of the country it froze.
 * The name comes from the `earth_countries` registry the deed itself reads
 * (migration 0054) — never from the client, never from a second country
 * list. `null` only for a code the registry does not carry; the cell and its
 * code stay frozen exactly as before. */
async function frozenCountryName(tx: DbOrTx, countryA3: string): Promise<string | null> {
  const [row] = await tx.select({ name: earthCountries.name }).from(earthCountries)
    .where(eq(earthCountries.a3, countryA3));
  return row?.name ?? null;
}

/** Server-owned signing and recovery deadlines, shared by fresh and resumed quotes. */
function landPaymentWindow(createdAt: Date, now = new Date()) {
  return {
    serverNow: now.toISOString(),
    payableUntil: new Date(createdAt.getTime()
      + (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000).toISOString(),
    retryAt: new Date(createdAt.getTime() + ECONOMY.depositPendingTtlMin * 60_000).toISOString(),
  };
}

async function landReservationAddress(db: DbOrTx, reservation: typeof plotReservations.$inferSelect) {
  if (reservation.addressKind === 'fantasy') {
    if (reservation.fantasyWorldId !== FANTASY_WORLD_ID || reservation.fantasyTileId === null) throw new Error('Native reservation has no frozen address');
    const tile = requireOrdinaryFantasyTile(reservation.fantasyTileId);
    return { landAddress: { kind: 'fantasy', worldId: tile.worldId, tileId: tile.tileId } as LandAddress,
      fantasyLocation: tile, earthCell: undefined, countryA3: undefined, countryName: undefined };
  }
  if (reservation.earthCell === null || reservation.countryA3 === null) throw new Error('Legacy reservation has no frozen Earth address');
  const claim = await getFantasyClaim(db, reservation.baseId);
  return { landAddress: { kind: 'legacy-earth', earthCell: reservation.earthCell } as LandAddress,
    ...(claim ? { fantasyLocation: requireOrdinaryFantasyTile(claim.tileId) } : {}),
    earthCell: reservation.earthCell, countryA3: reservation.countryA3,
    countryName: await frozenCountryName(db, reservation.countryA3) };
}

async function createLandPurchaseIntent(
  db: Db, wallet: string, kind: 'entry' | 'deed', legacyCell: number | undefined,
  requestedAddress: DepositPayload['landAddress'],
  now: Date,
  /** The client's key, recorded only on the row THIS request reserves (never on a replayed pending one), so
   * GET /deposits/land/receipt can prove what the key did (money/landReservationReceipt.ts). */
  idempotencyKey?: string,
) {
  const recordedKey = idempotencyKey === undefined ? {} : { idempotencyKey };
  if (legacyCell !== undefined && requestedAddress !== undefined) throw new HttpError(422, 'Use one land address', 'INVALID_LAND_ADDRESS');
  if (requestedAddress?.kind === 'fantasy' && requestedAddress.worldId !== FANTASY_WORLD_ID) {
    throw new HttpError(426, 'Update the game to use the current world', 'WORLD_UPDATE_REQUIRED');
  }
  const requestedCell = requestedAddress?.kind === 'legacy-earth' ? requestedAddress.earthCell : legacyCell;
  if (fantasyWorldEnabled() && requestedAddress?.kind === 'fantasy' && !await fantasyPurchasesCutOver(db)) {
    if (requestedAddress.tileId !== undefined) requireOrdinaryFantasyTile(requestedAddress.tileId);
    await stagePendingLegacyFantasyPurchases(db);
  }
  // A free-onboarding Keep may still be in the legacy wallet-keyed shape when
  // the payment route is the first stable-base-aware touch. Materialize it
  // before reserving land so entry reuses that exact base instead of creating a
  // second hidden identity beside the player's existing structures.
  try {
    await ensureWalletBaseIdentity(db, wallet);
  } catch (error) {
    // A seller with no remaining base is deliberately refused by the entry
    // guard below with ENTRY_PDA_CONSUMED; never let legacy materialization
    // recreate the conveyed land, but preserve that stable public error.
    if (!(error instanceof HttpError) || error.code !== 'BASE_NOT_OWNED') throw error;
  }
  return db.transaction(async (tx) => {
    const [player] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const entryConsumed = await entryPurchaseConsumed(tx, wallet, player.entryPaidAt);
    if (kind === 'entry' && entryConsumed) {
      throw new HttpError(409, 'entry payment was already consumed; use a deed purchase', 'ENTRY_PDA_CONSUMED');
    }
    if (kind === 'deed' && !entryConsumed) {
      throw new HttpError(409, 'buy the first entry deed before adding another', 'ENTRY_REQUIRED');
    }

    const [pending] = await tx.select().from(deposits).where(and(
      eq(deposits.playerWallet, wallet), eq(deposits.kind, kind), eq(deposits.status, 'pending'),
    )).orderBy(asc(deposits.createdAt)).limit(1).for('update');
    if (pending) {
      const [reservation] = await tx.select().from(plotReservations)
        .where(eq(plotReservations.depositId, pending.id)).for('update');
      if (reservation) {
        const fantasyCutover = fantasyWorldEnabled() || await fantasyPurchasesCutOver(tx);
        if (reservation.addressKind === 'legacy-earth' && fantasyCutover) {
          await reserveFantasyPurchase(tx, pending.id, reservation.baseId, undefined, { crownlandsOnly: true });
        }
        const address = await landReservationAddress(tx, reservation);
        if (requestedCell !== undefined && requestedCell !== reservation.earthCell) {
          throw new HttpError(409, 'this payment intent already reserves another Earth cell', 'RESERVATION_MISMATCH', {
            depositId: pending.id, earthCell: reservation.earthCell, ...landPaymentWindow(pending.createdAt, now),
          });
        }
        if (requestedAddress?.kind === 'fantasy' && requestedAddress.tileId !== undefined
          && requestedAddress.tileId !== address.fantasyLocation?.tileId) {
          throw new HttpError(409, 'This payment already reserves another tile', 'RESERVATION_MISMATCH', {
            depositId: pending.id, ...address, ...landPaymentWindow(pending.createdAt, now),
          });
        }
        const reusableIfCreatedAfter = new Date(
          now.getTime()
            - (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000,
        );
        if (pending.createdAt < reusableIfCreatedAfter) {
          throw new HttpError(
            409,
            'land payment window is closing; wait for verification',
            'PAYMENT_WINDOW_CLOSING',
            { depositId: pending.id, earthCell: reservation.earthCell, ...landPaymentWindow(pending.createdAt, now) },
          );
        }
        const existingPayload = pending.payload as DepositPayload | null;
        if (existingPayload?.landPurchaseVersion !== 1 && !fantasyCutover) {
          // A fresh reservation from the prior binary is safe to adopt because
          // this transaction just revalidated the requested rail under the
          // canonical player lock. Persist the eligibility fence before giving
          // its payable reference back during a rolling deployment.
          await tx.update(deposits).set({
            payload: { ...existingPayload, landPurchaseVersion: 1 } satisfies DepositPayload,
          }).where(eq(deposits.id, pending.id));
        }
        return {
          id: pending.id, reference: pending.reference, kind,
          ...landPaymentWindow(pending.createdAt, now), paymentSignature: pending.paymentSignature,
          amountLamports: LAND_PRICE_LAMPORTS,
          baseId: reservation.baseId, ...address,
        };
      }
    }

    if (!fantasyWorldEnabled() && await fantasyPurchasesCutOver(tx)) {
      throw new HttpError(409, 'New land purchases are paused; existing payments remain recoverable', 'LAND_PURCHASES_PAUSED');
    }
    if (fantasyWorldEnabled() && requestedAddress?.kind !== 'fantasy') {
      throw new HttpError(426, 'Update the game before choosing land in the fantasy world', 'WORLD_UPDATE_REQUIRED');
    }
    if (!fantasyWorldEnabled() && requestedAddress?.kind === 'fantasy') {
      throw new HttpError(503, 'New fantasy land purchases are paused', 'FANTASY_WORLD_NOT_READY');
    }

    const owned = await tx.select().from(bases).where(eq(bases.ownerWallet, wallet))
      .orderBy(asc(bases.createdAt)).for('update');
    const [slots, plotted, structured, liveReserved, fantasyReserved] = await Promise.all([
      tx.select({ baseId: baseSlots.baseId }).from(baseSlots).where(eq(baseSlots.wallet, wallet)),
      tx.select({ baseId: plots.baseId }).from(plots).where(sql`${plots.baseId} IS NOT NULL`),
      tx.select({ baseId: buildings.baseId }).from(buildings).where(sql`${buildings.baseId} IS NOT NULL`),
      tx.select({ baseId: plotReservations.baseId }).from(plotReservations)
        .where(inArray(plotReservations.state, ['reserved', 'paid', 'converted'])),
      tx.select({ baseId: fantasyLandClaims.baseId }).from(fantasyLandClaims)
        .where(inArray(fantasyLandClaims.state, ['held', 'assigned'])),
    ]);
    const slotIds = new Set(slots.map((row) => row.baseId));
    const plotIds = new Set(plotted.map((row) => row.baseId));
    const structuredIds = new Set(structured.map((row) => row.baseId));
    const reservedIds = new Set([...liveReserved, ...fantasyReserved].map((row) => row.baseId));
    let base = kind === 'entry'
      ? owned.find((candidate) => !candidate.landPaidAt && !candidate.deedAssetId && !reservedIds.has(candidate.id))
      : owned.find((candidate) => !candidate.landPaidAt && !candidate.deedAssetId
        && candidate.status === 'inactive' && !slotIds.has(candidate.id) && !plotIds.has(candidate.id)
        && !structuredIds.has(candidate.id) && !reservedIds.has(candidate.id));
    if (!base && kind === 'entry' && owned.length > 0) {
      throw new HttpError(
        409, 'the existing onboarding base is no longer eligible for an entry purchase', 'ENTRY_BASE_CHANGED',
      );
    }
    if (!base) {
      [base] = await tx.insert(bases).values({ ownerWallet: wallet, status: 'inactive' }).returning();
    }
    if (!base) throw new Error('land purchase base insert returned no row');

    const reference = pending?.reference ?? bs58.encode(randomBytes(32));
    const [deposit] = pending ? [pending] : await tx.insert(deposits).values({
      playerWallet: wallet, kind, reference, status: 'pending', payload: null,
    }).returning();

    if (requestedAddress?.kind === 'fantasy') {
      // The claim FK checks the frozen base before it is created. The concrete
      // tile is written once in this same transaction before any response.
      await tx.update(deposits).set({ payload: { landPurchaseVersion: 1, baseId: base.id,
        amountLamports: LAND_PRICE_LAMPORTS, ...recordedKey } satisfies DepositPayload }).where(eq(deposits.id, deposit!.id));
      const tile = await reserveFantasyPurchase(tx, deposit!.id, base.id, requestedAddress.tileId);
      const address: LandAddress = { kind: 'fantasy', worldId: tile.worldId, tileId: tile.tileId };
      await tx.update(deposits).set({ payload: { landPurchaseVersion: 1, baseId: base.id,
        amountLamports: LAND_PRICE_LAMPORTS, landAddress: address, ...recordedKey } satisfies DepositPayload }).where(eq(deposits.id, deposit!.id));
      await activateFantasyPurchaseCutover(tx, now);
      const [reservation] = await tx.insert(plotReservations).values({ depositId: deposit!.id, baseId: base.id,
        addressKind: 'fantasy', fantasyWorldId: tile.worldId, fantasyTileId: tile.tileId,
        expiresAt: new Date(now.getTime() + BASE_OWNERSHIP.reservationTtlMs) }).returning();
      return { id: deposit!.id, reference, kind, amountLamports: LAND_PRICE_LAMPORTS,
        ...landPaymentWindow(deposit!.createdAt, now), baseId: base.id, ...await landReservationAddress(tx, reservation!) };
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const parcel = await chooseAvailableEarthParcel(tx, requestedCell);
      const valleyId = await ensureValleyAtSite(tx, parcel.siteId);
      await tx.select({ id: valleys.id }).from(valleys).where(eq(valleys.id, valleyId)).for('update');
      const [occupied] = await tx.select({ id: plots.id }).from(plots)
        .where(eq(plots.earthCell, parcel.earthCell));
      if (occupied) {
        if (requestedCell !== undefined) {
          throw new HttpError(409, 'Earth cell is already occupied', 'EARTH_CELL_UNAVAILABLE');
        }
        continue;
      }
      try {
        const reservation = await reserveEarthCell(tx, deposit!.id, base.id, parcel, now);
        const frozen: DepositPayload = {
          landPurchaseVersion: 1,
          baseId: base.id, amountLamports: LAND_PRICE_LAMPORTS,
          earthCell: parcel.earthCell, siteId: parcel.siteId,
          tx: parcel.x, ty: parcel.y, countryA3: parcel.countryA3, ...recordedKey,
        };
        await tx.update(deposits).set({ payload: frozen }).where(eq(deposits.id, deposit!.id));
        return {
          id: deposit!.id, reference, kind, amountLamports: LAND_PRICE_LAMPORTS,
          ...landPaymentWindow(deposit!.createdAt, now),
          baseId: base.id, ...await landReservationAddress(tx, reservation),
        };
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== 'EARTH_CELL_UNAVAILABLE' || requestedCell !== undefined) {
          throw error;
        }
      }
    }
    throw new HttpError(409, 'could not reserve a free Earth cell', 'EARTH_CELL_UNAVAILABLE');
  });
}

/** What on-chain verification must establish before a credit. */
export interface VerifiedPayment {
  basePurchaseV1?: BasePurchaseQuote | undefined;
  txSignature: string;
  /** Wallet that signed the program instruction. */
  wallet: string;
  kind: DepositKind;
  lamports: bigint;
  finalized: true;
}

let activeDepositVerifications = 0;
const depositVerificationWaiters: Array<() => void> = [];
const depositVerificationAttempt = new AsyncLocalStorage<AbortSignal>();

export function currentDepositVerificationSignal(): AbortSignal | undefined {
  return depositVerificationAttempt.getStore();
}

export async function withDepositVerificationDeadline<T>(
  run: () => Promise<T>, message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await depositVerificationAttempt.run(controller.signal, async () => Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new HttpError(503, message);
          controller.abort(error);
          reject(error);
        }, DEPOSIT_VERIFICATION.rpcTimeoutMs);
      }),
    ]));
  } finally {
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new Error('deposit verification attempt ended'));
  }
}

/** Bound DB connections held across chain verification below the production
 * pool ceiling. FIFO admission prevents a request burst from starving older
 * paid intents; `finally` at every caller releases on RPC errors/timeouts. */
export async function acquireDepositVerificationPermit(): Promise<() => void> {
  if (activeDepositVerifications >= DEPOSIT_VERIFICATION.concurrency) {
    let waiter: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        waiter = resolve;
        depositVerificationWaiters.push(resolve);
        timer = setTimeout(
          () => reject(new HttpError(503, 'deposit verification is busy; retry shortly')),
          DEPOSIT_VERIFICATION.rpcTimeoutMs,
        );
      });
    } catch (error) {
      if (waiter) {
        const index = depositVerificationWaiters.indexOf(waiter);
        if (index >= 0) depositVerificationWaiters.splice(index, 1);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  activeDepositVerifications++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeDepositVerifications--;
    depositVerificationWaiters.shift()?.();
  };
}

/** Serialize every verifier and terminal transition for one deposit without
 * taking its row before an optional base/signature lock. This is an outer
 * serialization root; all row locks beneath it retain the canonical
 * player→optional base→signature→deposit order. */
export async function lockDepositVerification(tx: DbTx, depositId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'deposit-verification:' + depositId}))`);
}

/** Shared side of the deposit verification fence. `/paid` and finalized scans
 * may run together; either may durably pin/credit a positive proof. Never
 * upgrade this shared lock to exclusive in the same transaction. */
export async function lockDepositVerificationShared(tx: DbTx, depositId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${'deposit-verification:' + depositId}))`);
}

/** Serialize the cross-column signature identity. Separate UNIQUE constraints
 * cannot stop one row's submitted signature racing another row's credited
 * signature, so submit and credit share this advisory + union check. */
export async function lockUnusedDepositSignature(tx: DbTx, depositId: string, signature: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'deposit-signature:' + signature}))`);
  const [used] = await tx.select({ id: deposits.id }).from(deposits).where(and(
    ne(deposits.id, depositId),
    or(eq(deposits.paymentSignature, signature), eq(deposits.txSignature, signature)),
  )).limit(1).for('update');
  if (used) throw new HttpError(409, 'payment signature is already bound to another deposit');
}

/** Authenticated handoff of the wallet adapter's exact broadcast signature.
 * It extends no TTL and grants nothing; the ordinary finalized verifier remains
 * the only credit authority. Exact-confirmed proof runs under the shared outer
 * verification fence plus canonical player→signature→deposit locks, so
 * terminal expiry cannot win after proof but before persistence. */
export async function submitDepositPayment(
  db: Db, verifyCommit: DepositPaymentCommitVerifier | undefined,
  wallet: string, depositId: string, signature: string,
): Promise<{ committed: true }> {
  if (!isCanonicalSolanaSignature(signature)) {
    throw new HttpError(422, 'invalid Solana transaction signature');
  }
  if (!verifyCommit) throw new HttpError(503, 'deposit payment confirmation is not configured');

  const [quoted] = await db.select().from(deposits).where(and(
    eq(deposits.id, depositId), eq(deposits.playerWallet, wallet),
  ));
  if (!quoted) throw new HttpError(404, 'deposit not found');
  if (quoted.paymentSignature === signature || quoted.txSignature === signature) return { committed: true };
  if (!depositPaymentRecoverable(quoted)) throw new HttpError(409, 'deposit is already finalized with another payment');
  if (quoted.paymentSignature) throw new HttpError(409, 'deposit is already bound to another payment signature');
  const frozenAmount = (quoted.payload as DepositPayload | null)?.amountLamports;

  const releasePermit = await acquireDepositVerificationPermit();
  try {
    return await db.transaction(async (tx) => {
      await lockDepositVerificationShared(tx, depositId);
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) throw new HttpError(404, 'player not found');
      await lockUnusedDepositSignature(tx, depositId, signature);
      const [deposit] = await tx.select().from(deposits).where(and(
        eq(deposits.id, depositId), eq(deposits.playerWallet, wallet),
      )).for('update');
      if (!deposit) throw new HttpError(404, 'deposit not found');
      if (deposit.reference !== quoted.reference || deposit.kind !== quoted.kind
        || deposit.createdAt.getTime() !== quoted.createdAt.getTime()) {
        throw new HttpError(409, 'deposit intent changed while confirming payment');
      }
      if (!depositPaymentRecoverable(deposit)) {
        if (deposit.paymentSignature === signature || deposit.txSignature === signature) return { committed: true };
        throw new HttpError(409, 'deposit is already finalized with another payment');
      }
      if (deposit.paymentSignature) {
        if (deposit.paymentSignature === signature) return { committed: true };
        throw new HttpError(409, 'deposit is already bound to another payment signature');
      }
      const lockedAmount = (deposit.payload as DepositPayload | null)?.amountLamports;
      if (lockedAmount !== frozenAmount) throw new HttpError(409, 'deposit quote changed while confirming payment');
      const expectedLamports = Number.isSafeInteger(lockedAmount) && lockedAmount !== undefined
        ? BigInt(lockedAmount) : undefined;
      const proof = await withDepositVerificationDeadline(() => verifyCommit({
          id: deposit.id, playerWallet: deposit.playerWallet, kind: deposit.kind as DepositKind,
          reference: deposit.reference, createdAt: deposit.createdAt,
          ...(expectedLamports !== undefined ? { expectedLamports } : {}),
          paymentSignature: signature,
          ...((deposit.payload as DepositPayload | null)?.basePurchaseV1 ? { basePurchaseV1: (deposit.payload as DepositPayload).basePurchaseV1 } : {}),
          ...((deposit.payload as DepositPayload | null)?.destination ? { destination: (deposit.payload as DepositPayload).destination } : {}),
          ...((deposit.payload as DepositPayload | null)?.mint ? { mint: (deposit.payload as DepositPayload).mint } : {}),
        }), 'deposit payment confirmation timed out');
      if (!proof || proof.txSignature !== signature) {
        throw new HttpError(422, 'payment signature is not a confirmed exact deposit payment');
      }
      if ((deposit.payload as DepositPayload | null)?.basePurchaseV1) await allowBasePurchaseTerminal(tx, deposit.id);
      // Only positive exact CONFIRMED proof revives an expired Gems row so the
      // ordinary pending watcher can finish it. This is never signing admission.
      await tx.update(deposits).set({ paymentSignature: signature,
        ...(deposit.status === 'expired' && deposit.kind === 'gems_buy' ? { status: 'pending' as const } : {}),
      }).where(eq(deposits.id, depositId));
      if (proof.keepCustodySource) {
        if (deposit.kind !== 'keep_deposit') throw new Error('KEEP_SOURCE_KIND');
        await retainKeepCustodyConfirmed(tx, deposit.id, proof.keepCustodySource);
      }
      return { committed: true };
    });
  } catch (error) {
    // Permanent cross-consumer claims survive deletion of the original row.
    // Translate only that exact rejection after the transaction has rolled back.
    const constraint = (error as { cause?: unknown } | null)?.cause ?? error;
    if (constraint !== null && typeof constraint === 'object'
      && 'code' in constraint && constraint.code === '23505'
      && 'message' in constraint && constraint.message === 'PAYMENT_SIGNATURE_ALREADY_CLAIMED') {
      throw new HttpError(409, 'payment signature is already bound to another payment');
    }
    throw error;
  } finally {
    releasePermit();
  }
}

/**
 * A deposit intent: the reference key the client includes in the on-chain tx.
 *
 * For 'entry' this is IDEMPOTENT (incident 2026-07-18): a wallet gets at most
 * ONE open entry intent — a double-click on PAY reuses the pending row instead
 * of minting a new one each time (which previously piled up 5 dead intents).
 * The already-paid short-circuit lives in the route so this keeps a stable
 * `{id, reference, kind}` contract for every caller.
 */
export async function createDepositIntent(
  db: Db, wallet: string, kind: DepositKind, payload?: DepositPayload, now = new Date(),
  stableContext?: DepositStableAuthorityContext,
  basePurchase?: { request: BasePurchaseRequest; network: BasePurchaseNetwork },
) {
  // Owner 2026-08-16: buy-KEEP re-enabled on devnet behind KEEP_VEND_ENABLED
  // (default stays fail-closed per ONRAMP-WALLETS-PLAN; the credit rail below
  // never closed, so flipping this only opens NEW intents).
  if (kind === 'keep_vend' && process.env['KEEP_VEND_ENABLED'] !== 'true') throwKeepVendUnavailable();

  // An intent is only reusable while enough of its TTL remains to sign, land AND
  // finalize a payment. 'expired' is stamped lazily (verify/watcher), so age is
  // the only honest test here — a row idle past its TTL still reads 'pending'.
  const reusableIfCreatedAfter = new Date(
    now.getTime() - (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000,
  );

  if (kind === 'entry' || kind === 'deed') {
    return createLandPurchaseIntent(db, wallet, kind, payload?.earthCell, payload?.landAddress, now, payload?.idempotencyKey);
  }
  if (kind === 'gems_buy') return createGemsBuyIntent(db, wallet, payload, now);

  // Every paid gameplay quote names stable land. KEEP custody inflow is the
  // deliberate exception: depositing the wallet's own token stays auth-only.
  if (kind !== 'keep_deposit' && kind !== 'builder' && kind !== 'expansion') {
    const base = await resolveStableDepositBase(db, wallet, payload?.baseId);
    payload = {
      ...payload, baseId: base.id, landPaidAt: base.landPaidAt!.toISOString(),
      deedAssetId: base.deedAssetId,
    };
  }

  if (kind === 'builder') {
    if (!payload?.baseId) await materializeLegacyDepositBase(db, wallet);
    return db.transaction(async (tx) => {
      // Serialize quote creation with builder grants. Without this lock, a burst
      // of requests exposed many distinct payable references for the same slot;
      // only the first payment could grant and every later payment stranded SOL.
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) throw new HttpError(404, 'player not found');
      const base = await lockAuthorizedDepositBase(tx, wallet, payload?.baseId, stableContext);
      if (base.builders >= CAPS.buildersMax) throw new HttpError(422, 'builder cap already reached');
      const priceSol = CAPS.builderPricesSol[base.builders - 1];
      if (priceSol === undefined) throw new HttpError(422, 'no builder price defined');
      const amountLamports = Math.round(priceSol * 1_000_000_000);
      const expectedBuilders = base.builders;
      const landPaidAt = base.landPaidAt.toISOString();

      const pending = await tx.select().from(deposits).where(and(
        basePurchase ? or(sql`${deposits.payload}->>'baseId' = ${base.id}`,
          and(eq(deposits.playerWallet, wallet), sql`${deposits.payload}->>'baseId' IS NULL`)) : eq(deposits.playerWallet, wallet),
        eq(deposits.kind, 'builder'),
        eq(deposits.status, 'pending'),
      )).for('update');
      // Never mint a second payable reference while a pre-frozen-quote intent
      // is still being watched. Migration deliberately preserves these rows so
      // a transaction already in flight can still be recorded and reconciled.
      if (pending.some((row) => {
        const stored = row.payload as DepositPayload | null;
        return stored?.expectedBuilders === undefined || !stored.baseId;
      })) {
        throw new HttpError(409, 'an earlier builder payment is still pending verification');
      }
      const existing = pending.find((row) => {
        const stored = row.payload as DepositPayload | null;
        return stored?.baseId === base.id && stored.expectedBuilders === expectedBuilders;
      });
      if (existing) {
        if (basePurchase) throw new HttpError(409, 'another quote reserves this target', 'PAYMENT_TARGET_RESERVED');
        if (existing.createdAt >= reusableIfCreatedAfter) {
          const stored = existing.payload as DepositPayload | null;
          if (stored?.amountLamports !== amountLamports
            || stored.landPaidAt !== landPaidAt
            || stored.deedAssetId !== base.deedAssetId) {
            throw new HttpError(409, 'builder base or quote changed — wait for the pending intent to expire');
          }
          return { id: existing.id, reference: existing.reference, kind, amountLamports };
        }
        // The watcher owns the terminal transition because it checks the chain
        // before expiring. Creation must not race a finalized payment by
        // changing this row underneath creditDeposit.
        throw new HttpError(409, 'builder payment window is closing — retry after verification');
      }

      const reference = bs58.encode(randomBytes(32));
      const id = randomUUID();
      const [row] = await tx.insert(deposits).values({
        playerWallet: wallet,
        kind,
        reference,
        status: 'pending',
        ...(basePurchase ? { id, createdAt: now } : {}),
        payload: freezeBasePurchaseQuote(basePurchase, id, reference, wallet, {
          baseId: base.id, expectedBuilders, amountLamports, landPaidAt, deedAssetId: base.deedAssetId,
        }, now),
      }).returning();
      return { id: row!.id, reference, kind, amountLamports };
    });
  }

  if (kind === 'expansion') {
    if (!payload?.baseId) await materializeLegacyDepositBase(db, wallet);
    return db.transaction(async (tx) => {
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) throw new HttpError(404, 'player not found');
      const base = await lockAuthorizedDepositBase(tx, wallet, payload?.baseId, stableContext);
      const { expectedExpansions, amountLamports } = expansionOffer(base.expansions, base.keepLevel);
      const landPaidAt = base.landPaidAt.toISOString();

      const pending = await tx.select().from(deposits).where(and(
        basePurchase ? or(sql`${deposits.payload}->>'baseId' = ${base.id}`,
          and(eq(deposits.playerWallet, wallet), sql`${deposits.payload}->>'baseId' IS NULL`)) : eq(deposits.playerWallet, wallet),
        eq(deposits.kind, 'expansion'),
        eq(deposits.status, 'pending'),
      )).for('update');
      if (pending.some((row) => {
        const stored = row.payload as DepositPayload | null;
        return stored?.expectedExpansions === undefined || !stored.baseId;
      })) {
        throw new HttpError(409, 'an earlier expansion payment is still pending verification');
      }
      const existing = pending.find((row) => {
        const stored = row.payload as DepositPayload | null;
        return stored?.baseId === base.id && stored.expectedExpansions === expectedExpansions;
      });
      if (existing) {
        if (basePurchase) throw new HttpError(409, 'another quote reserves this target', 'PAYMENT_TARGET_RESERVED');
        if (existing.createdAt < reusableIfCreatedAfter) {
          throw new HttpError(409, 'expansion payment window is closing — retry after verification');
        }
        const stored = existing.payload as DepositPayload | null;
        if (stored?.amountLamports !== amountLamports
          || stored.landPaidAt !== landPaidAt
          || stored.deedAssetId !== base.deedAssetId) {
          throw new HttpError(409, 'expansion base or quote changed — wait for the pending intent to expire');
        }
        return { id: existing.id, reference: existing.reference, kind, amountLamports };
      }

      const reference = bs58.encode(randomBytes(32));
      const id = randomUUID();
      const [row] = await tx.insert(deposits).values({
        playerWallet: wallet,
        kind,
        reference,
        status: 'pending',
        ...(basePurchase ? { id, createdAt: now } : {}),
        payload: freezeBasePurchaseQuote(basePurchase, id, reference, wallet, {
          baseId: base.id, expectedExpansions, amountLamports, landPaidAt, deedAssetId: base.deedAssetId,
        }, now),
      }).returning();
      return { id: row!.id, reference, kind, amountLamports };
    });
  }

  // Pay-per-action SOL sinks (energy/shield/mine): preflight the in-game
  // eligibility BEFORE minting an intent, so a player is never prompted to pay
  // on-chain for something that can't be granted (dynamic import breaks the
  // game↔money cycle).
  let storedPayload: DepositPayload | null = payload?.baseId ? {
    baseId: payload.baseId, landPaidAt: payload.landPaidAt, deedAssetId: payload.deedAssetId,
  } : null;
  let extra: Record<string, unknown> = {};
  if (kind === 'energy' || kind === 'energy_pack') {
    const { assertEnergyPurchasable } = await import('../game/raids');
    await assertEnergyPurchasable(db, wallet, payload?.baseId);
    const amountLamports = Number(SINK_PRICE_LAMPORTS[kind]);
    storedPayload = { ...storedPayload, amountLamports,
      ...(basePurchase ? { energyQuantity: kind === 'energy_pack' ? RAID_ENERGY.packSize : 1 } : {}) };
    extra = { amountLamports };
  } else if (kind === 'shield') {
    const { assertShieldExtendable } = await import('../game/shop');
    await assertShieldExtendable(db, wallet, now, payload?.baseId);
    const amountLamports = Number(SINK_PRICE_LAMPORTS.shield);
    storedPayload = { ...storedPayload, amountLamports };
    extra = { amountLamports };
  } else if (kind === 'mine') {
    // 'mine' is the historical wire/db kind for EVERY SOL-gated building
    // upgrade — since D-057 that is Mine L5+ AND Gold Forge L2+ (adding a
    // 'goldforge' enum value would need a migration the flow doesn't
    // otherwise require; the buildingId names the real target).
    if (!payload?.buildingId) throw new HttpError(422, 'a paid upgrade needs a buildingId');
    return db.transaction(async (tx) => {
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) throw new HttpError(404, 'player not found');
      const base = await lockAuthorizedDepositBase(tx, wallet, payload!.baseId, stableContext);
      // Read the UUID column under lock and use the database's canonical value
      // everywhere below. Raw JSON text is not identity: PostgreSQL accepts
      // uppercase UUID input, while a text index would treat its casing as a
      // second payable target for the same building.
      const [target] = await tx.select({ id: buildings.id }).from(buildings).where(and(
        eq(buildings.id, payload!.buildingId!), eq(buildings.baseId, base.id),
      )).for('update');
      if (!target) throw new HttpError(404, 'building not found');
      const { assertPaidUpgradeable } = await import('../game/base');
      const { solLamports, buildingType, fromLevel, costShards } = await assertPaidUpgradeable(
        tx, wallet, target.id, now, base.id,
      );
      // buildingId is the rolling-version identity: pre-0071 rows do not have
      // baseId, but they may already have an on-chain payment using their
      // reference. Never mint a stable-base sibling for the same building.
      const existingRows = await tx.select().from(deposits).where(and(
        eq(deposits.status, 'pending'),
        sql`(${deposits.payload}->>'buildingId')::uuid = ${target.id}::uuid`,
      )).for('update');
      const frozen: DepositPayload = {
        baseId: base.id, buildingId: target.id, amountLamports: solLamports,
        landPaidAt: base.landPaidAt.toISOString(), deedAssetId: base.deedAssetId,
      };
      if (existingRows.length > 1) {
        throw new HttpError(409, 'multiple earlier upgrade payments need operator reconciliation');
      }
      const existing = existingRows[0];
      if (existing) {
        if (basePurchase) throw new HttpError(409, 'another quote reserves this target', 'PAYMENT_TARGET_RESERVED');
        if (existing.kind !== 'mine' || existing.playerWallet !== wallet) {
          throw new HttpError(
            409, 'the prior owner still has a pending payment for this building', 'PAYMENT_TARGET_RESERVED',
          );
        }
        const prior = existing.payload as DepositPayload | null;
        if (existing.createdAt < reusableIfCreatedAfter) {
          throw new HttpError(409, 'upgrade payment window is closing — retry after verification');
        }
        // A same-wallet legacy row is safe to return: preflight above proved
        // that this exact building is still upgradeable at solLamports. Credit
        // can resolve its missing base identity only while the wallet still has
        // exactly one active base, and it must be the base just authorized.
        if (!prior?.baseId) {
          const legacyBase = await lockDepositBase(tx, wallet);
          if (legacyBase.base.id !== base.id) {
            throw new HttpError(409, 'an earlier upgrade payment is still pending verification');
          }
          return { id: existing.id, reference: existing.reference, kind, amountLamports: solLamports };
        }
        if (prior.baseId !== base.id) {
          throw new HttpError(409, 'an earlier upgrade payment is still pending verification');
        }
        if (prior?.amountLamports !== solLamports || prior.landPaidAt !== frozen.landPaidAt
          || prior.deedAssetId !== frozen.deedAssetId) {
          throw new HttpError(409, 'an earlier upgrade payment is still pending verification');
        }
        return { id: existing.id, reference: existing.reference, kind, amountLamports: solLamports };
      }
      const reference = bs58.encode(randomBytes(32));
      const id = randomUUID();
      const [row] = await tx.insert(deposits).values({
        playerWallet: wallet, kind, reference, status: 'pending',
        ...(basePurchase ? { id, createdAt: now } : {}),
        payload: freezeBasePurchaseQuote(basePurchase, id, reference, wallet, frozen, now, { buildingType, fromLevel, costShards }),
      }).returning();
      return { id: row!.id, reference, kind, amountLamports: solLamports };
    });
  } else if (kind === 'mine_build') {
    // D-057 (owner 2026-08-16, verbatim: "we should not gate miners with sol
    // at start"): mines are built for game currency only — POST /base/buildings
    // charges the progressive KEEP for mines 2+ directly, so NO new SOL intent
    // may be minted here. The 'mine_build' CREDIT branch below deliberately
    // remains: a pre-D-057 intent whose payment was already broadcast still
    // verifies through GET/paid/verify and places the mine (applyMineBuild's
    // price check passes at any paid amount now that every price is 0) — an
    // already-paid player is never stranded by the cutover.
    throw new HttpError(
      422,
      'mines no longer cost SOL — build them via POST /base/buildings',
      'MINE_BUILD_SOL_RETIRED',
    );
  } else if (kind === 'warzone_shield') {
    // Warzone shield (#49): sold ONLY during an active warzone, no stacking.
    // Preflight so a player is never prompted to pay when it can't apply. Paid as
    // ONE tx with two legs — 50% direct to liquidity + 50% via buy_sink(40/35/25);
    // the client builds both from WARZONE constants. Return the total price; the
    // route attaches the liquidity destination (like mine_build/expansion).
    const { assertWarzoneShieldPurchasable } = await import('../game/warzoneShield');
    await assertWarzoneShieldPurchasable(db, wallet, now, storedPayload?.baseId);
    storedPayload = { ...storedPayload, amountLamports: WARZONE.shieldCostSolLamports };
    extra = { amountLamports: WARZONE.shieldCostSolLamports };
  }

  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const base = storedPayload?.baseId
      ? await lockAuthorizedDepositBase(tx, wallet, storedPayload.baseId, stableContext)
      : null;
    if (basePurchase && base && (kind === 'shield' || kind === 'warzone_shield')) {
      // Every fresh command shares the deed lock. An uncertain older reference,
      // including a legacy one, must be reconciled before creating another.
      const [pending] = await tx.select({ id: deposits.id }).from(deposits).where(and(
        eq(deposits.kind, kind), eq(deposits.status, 'pending'), sql`${deposits.payload}->>'baseId' = ${base.id}`,
      ));
      if (pending) throw new HttpError(409, 'an earlier shield payment needs verification', 'PAYMENT_TARGET_RESERVED');
      if (kind === 'shield') {
        const { assertBaseShieldExtendable } = await import('../game/baseShields');
        await assertBaseShieldExtendable(tx, wallet, base.id, now);
      } else {
        const { assertWarzoneShieldPurchasable } = await import('../game/warzoneShield');
        await assertWarzoneShieldPurchasable(tx as unknown as Db, wallet, now, base.id);
      }
    }
    const frozenPayload = base ? {
      ...storedPayload,
      baseId: base.id,
      landPaidAt: base.landPaidAt!.toISOString(),
      deedAssetId: base.deedAssetId,
    } satisfies DepositPayload : storedPayload;
    const reference = bs58.encode(randomBytes(32));
    const id = randomUUID();
    const [row] = await tx.insert(deposits)
      .values({ playerWallet: wallet, kind, reference, status: 'pending',
        ...(basePurchase ? { id, createdAt: now } : {}),
        payload: frozenPayload ? freezeBasePurchaseQuote(basePurchase, id, reference, wallet, frozenPayload, now) : frozenPayload })
      .returning();
    return { id: row!.id, reference, kind, ...extra };
  });
}

export const GEMS_WALLET_BUY_DISABLED_CODE = 'GEMS_WALLET_BUY_DISABLED';
export const INTENT_TERMINAL_CODE = 'INTENT_TERMINAL';

/** The `POST /deposits { kind: 'gems_buy' }` intent view (E2-GEMS-CONTRACT §2):
 *  `destination`/`mint` are the values FROZEN in the row (never re-read from
 *  the env); the route adds `source` and `decimals`. `expiresAt` is the same
 *  TTL the watcher expires an unpaid intent at. */
function gemsBuyIntentView(row: typeof deposits.$inferSelect, now: Date) {
  const original = originalGemsBuyIntent(row);
  return {
    ...original, status: row.status,
    serverNow: now.toISOString(),
  };
}

/**
 * Get Gems from a wallet (E2-GEMS-CONTRACT §2 `gems_buy`; GEMS-CURRENCY §4.4):
 * a wallet-signed plain KEEP transfer to the emission-reserve ATA, tagged with
 * the server-minted reference like a custody deposit. Creating an intent is
 * behind GEMS_WALLET_BUY_ENABLED and needs the reserve destination; the CREDIT
 * path (creditDeposit below) is flag-independent — money moved is money
 * honoured. One intent per (wallet, idempotencyKey): a replay returns the
 * original live row; terminal keys name their original deposit for recovery.
 * A replay naming a different amount is refused.
 */
async function createGemsBuyIntent(db: Db, wallet: string, payload: DepositPayload | undefined, now: Date) {
  if (!gemsWalletBuyEnabled()) {
    throw new HttpError(503, 'Get Gems from a wallet is not enabled', GEMS_WALLET_BUY_DISABLED_CODE);
  }
  // Only a finalized, database-pinned startup binding can quote a new target.
  // Verification and crediting still use the immutable destination in the row.
  const mint = payload?.mint;
  const destination = gemsReserveAta(db, mint);
  if (!destination || !mint) {
    throw new HttpError(503, 'Get Gems from a wallet is temporarily unavailable', GEMS_WALLET_BUY_DISABLED_CODE);
  }
  const idempotencyKey = payload?.idempotencyKey;
  if (!idempotencyKey) throw new HttpError(422, 'gems_buy requires an idempotencyKey');
  if (payload?.keepIn === undefined || !Number.isSafeInteger(payload.keepIn)) {
    throw new HttpError(422, 'gems_buy requires keepIn, a whole KEEP amount');
  }
  const keepIn = BigInt(payload.keepIn);
  assertConvertibleKeep(keepIn); // GEMS.minConvertKeep / maxConvertKeepPerTx → 422 D
  const gemsOut = keepIn * BigInt(GEMS.gemsPerKeep);
  // D-152 locks 1:1 backing. A future catalogue edit cannot reprice this rail.
  if (gemsOut !== keepIn) throw new Error('Wallet Gems purchases require the locked 1:1 backing');
  const stored: DepositPayload = { idempotencyKey, keepIn: Number(keepIn), gemsOut: Number(gemsOut), destination, mint,
    gemsBuyVersion: 1, decimals: TOKEN.decimals,
    expiresAt: new Date(now.getTime() + ECONOMY.depositPendingTtlMin * 60_000).toISOString() };
  const existingByKey = () => db.select().from(deposits).where(and(
    eq(deposits.playerWallet, wallet), eq(deposits.kind, 'gems_buy'),
    sql`${deposits.payload}->>'idempotencyKey' = ${idempotencyKey}`,
  )).limit(1);
  // A key whose row can no longer be paid (settled, failed, expired, or a
  // pending row too old to sign+land+finalize inside its TTL) must never come
  // back looking payable (security review 2026-09-20 #2): 409 INTENT_TERMINAL
  // is MoneyOp-definitive, names the row, and the client recovers through
  // GET /deposits/:id or mints a new key for a new purchase.
  const reusableIfCreatedAfter = now.getTime()
    - (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000;
  const replay = (row: typeof deposits.$inferSelect) => {
    const original = originalGemsBuyIntent(row);
    if (row.status !== 'pending' || row.createdAt.getTime() < reusableIfCreatedAfter
      || now.getTime() >= Date.parse(original.expiresAt) - ECONOMY.depositReuseMinRemainingMin * 60_000) {
      throw new HttpError(409, 'this intent can no longer be paid — use a new idempotencyKey', INTENT_TERMINAL_CODE,
        { depositId: row.id, status: row.status === 'pending' ? 'expired' : row.status });
    }
    if ((row.payload as DepositPayload | null)?.keepIn !== stored.keepIn) {
      throw new HttpError(409, 'idempotency key was already used with a different KEEP amount', 'IDEMPOTENCY_BODY_MISMATCH');
    }
    return gemsBuyIntentView(row, now);
  };
  const [existing] = await existingByKey();
  if (existing) return replay(existing);
  const [player] = await db.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found');
  try {
    const [row] = await db.insert(deposits)
      .values({ playerWallet: wallet, kind: 'gems_buy', reference: bs58.encode(randomBytes(32)), status: 'pending', payload: stored, createdAt: now })
      .returning();
    return gemsBuyIntentView(row!, now);
  } catch (error) {
    // Two concurrent posts with the same key: the partial unique index
    // `deposits_gems_buy_key_uq` keeps one row; answer with that row.
    const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code !== '23505') throw error;
    const [raced] = await existingByKey();
    if (!raced) throw error;
    return replay(raced);
  }
}

/** Whether the wallet's on-chain entry has been credited (route gate helper). */
export async function isEntryPaid(db: Db, wallet: string): Promise<boolean> {
  const [player] = await db.select({ paid: players.entryPaidAt })
    .from(players).where(eq(players.wallet, wallet));
  return !!player?.paid;
}

/**
 * Credit a verified payment. Idempotent: a deposit row is credited at most
 * once (status guard) and a tx signature can credit at most one deposit
 * (unique column). Side effects per kind: entry → entry_paid_at; builder →
 * builders+1 (≤6); expansion → expansions+1 (≤6).
 */
export async function creditDeposit(
  db: DbOrTx, depositId: string, payment: VerifiedPayment, now = new Date(),
  opts: { deferMapInvalidation?: boolean; eventClock?: () => Date } = {},
): Promise<{
  credited: boolean;
  entryStamped: boolean;
  landActivated: boolean;
  baseId?: string;
  shieldMapInvalidation?: { valleyId: string | null };
}> {
  const result = await db.transaction(async (tx) => {
    // Payload is immutable, so an unlocked preview may choose the canonical
    // locks. The authoritative row is re-read after player → base locks.
    const [preview] = await tx.select().from(deposits).where(eq(deposits.id, depositId));
    if (!preview || !depositPaymentRecoverable(preview)) {
      return { credited: false, entryStamped: false, landActivated: false };
    }
    // One lock root for EVERY rail, including generic KEEP/energy payments.
    // Later grants touch player-owned accounts/rows, so taking signature first
    // could deadlock `/paid` (player→signature) while a credit held signature
    // and waited on the player FK/account update.
    const [lockedPlayer] = await tx.select().from(players)
      .where(eq(players.wallet, preview.playerWallet)).for('update');
    if (!lockedPlayer) throw new HttpError(404, 'player not found');
    // A concurrent verifier may have credited while this request waited for
    // the canonical player lock. Re-read without taking deposit ahead of the
    // base/signature locks; an already-settled quote is an idempotent no-op.
    const [afterPlayerLock] = await tx.select({ kind: deposits.kind, status: deposits.status }).from(deposits)
      .where(eq(deposits.id, depositId));
    if (!afterPlayerLock || !depositPaymentRecoverable(afterPlayerLock)) return { credited: false, entryStamped: false, landActivated: false };
    const landPayment = preview.kind === 'entry' || preview.kind === 'deed';
    let lockedLandReservation: typeof plotReservations.$inferSelect | undefined;
    let lockedStableBase: typeof bases.$inferSelect | undefined;
    let signatureLocked = false;
    if (landPayment) {
      const frozenEligibility = (preview.payload as DepositPayload | null)?.landPurchaseVersion === 1;
      if (!frozenEligibility) {
        const entryConsumed = await entryPurchaseConsumed(
          tx, preview.playerWallet, lockedPlayer.entryPaidAt,
        );
        if (preview.kind === 'entry' && entryConsumed) {
          throw new HttpError(409, 'entry payment was already consumed; sold land cannot be recreated', 'ENTRY_PDA_CONSUMED');
        }
        if (preview.kind === 'deed' && !entryConsumed) {
          throw new HttpError(409, 'first entry deed has not been purchased', 'ENTRY_REQUIRED');
        }
      }
      const frozen = preview.payload as DepositPayload | null;
      if (!frozen?.baseId) throw new HttpError(422, 'land deposit is missing its frozen base');
      lockedStableBase = await lockFrozenDepositBase(tx, frozen.baseId);
      if (lockedStableBase.ownerWallet !== preview.playerWallet || lockedStableBase.landPaidAt
        || lockedStableBase.deedAssetId) {
        throw new HttpError(409, 'reserved land base changed before payment verification');
      }
      await lockUnusedDepositSignature(tx, depositId, payment.txSignature);
      signatureLocked = true;
      const [lockedDeposit] = await tx.select({ id: deposits.id }).from(deposits)
        .where(and(eq(deposits.id, depositId), eq(deposits.status, 'pending'))).for('update');
      if (!lockedDeposit) return { credited: false, entryStamped: false, landActivated: false };
      [lockedLandReservation] = await tx.select().from(plotReservations)
        .where(eq(plotReservations.depositId, depositId)).for('update');
      if (!lockedLandReservation) throw new HttpError(409, 'land reservation is missing');
      if (lockedLandReservation.state !== 'reserved' && lockedLandReservation.state !== 'paid') {
        throw new HttpError(409, 'land reservation is no longer payable');
      }
    }
    const baseOwnedPayment = preview.kind === 'builder' || preview.kind === 'expansion'
      || preview.kind === 'energy' || preview.kind === 'energy_pack'
      || preview.kind === 'mine' || preview.kind === 'mine_build' || preview.kind === 'shield'
      || preview.kind === 'warzone_shield';
    if (baseOwnedPayment) {
      const frozen = preview.payload as DepositPayload | null;
      if (frozen?.baseId) {
        lockedStableBase = await lockFrozenDepositBase(tx, frozen.baseId);
      } else {
        // Fenced is the only compatibility window in which a historical quote
        // may still resolve through the wallet's sole active base. Activation
        // refuses while any such row remains pending. Once ready, selecting a
        // current base here could apply an already-paid quote to a later deed.
        const [cutover] = await tx.select({ phase: deedEconomyCutoverState.phase })
          .from(deedEconomyCutoverState).where(eq(deedEconomyCutoverState.id, true));
        if (cutover?.phase !== 'fenced') {
          throw new HttpError(
            409,
            'base-owned deposit is missing its pre-cutover frozen base',
            'DEPOSIT_BASE_REQUIRED',
          );
        }
        lockedStableBase = (await lockDepositBase(tx, preview.playerWallet)).base;
      }
      await lockUnusedDepositSignature(tx, depositId, payment.txSignature);
      signatureLocked = true;
      const [lockedDeposit] = await tx.select().from(deposits)
        .where(eq(deposits.id, depositId)).for('update');
      if (!lockedDeposit || lockedDeposit.status !== 'pending') {
        return { credited: false, entryStamped: false, landActivated: false };
      }
    }
    if (!signatureLocked) await lockUnusedDepositSignature(tx, depositId, payment.txSignature);
    let shieldMapInvalidation: { valleyId: string | null } | undefined;
    await assertBasePurchasePayment(tx, preview, payment);
    const versioned = (preview.payload as DepositPayload | null)?.basePurchaseV1;
    if (versioned && (preview.kind === 'shield' || preview.kind === 'warzone_shield')
      && (!lockedStableBase || lockedStableBase.landPaidAt?.toISOString() !== versioned.baseEpoch.landPaidAt
        || lockedStableBase.deedAssetId !== versioned.baseEpoch.deedAssetId)) {
      throw new HttpError(409, 'original shield deed epoch changed', 'BASE_PURCHASE_CHANGED');
    }
    const claimed = await tx.update(deposits)
      .set({
        status: 'credited',
        txSignature: payment.txSignature,
        amount: payment.lamports,
        // WHICH token `amount` counts. Bookkeeping only — see money/mintDimension.ts
        // (the KEEP mint rotated twice with nothing in the books to attribute it).
        mint: depositMint(payment.kind),
        finalizedAt: now,
      })
      .where(and(eq(deposits.id, depositId), recoverableDepositPaymentSql()))
      .returning();
    if (claimed.length === 0) {
      return { credited: false, entryStamped: false, landActivated: false };
    }

    const dep = claimed[0]!;
    if (dep.playerWallet !== payment.wallet) {
      throw new HttpError(422, 'payment wallet does not match the deposit intent');
    }
    if (dep.kind !== payment.kind) {
      throw new HttpError(422, 'payment kind does not match the deposit intent');
    }
    if (baseOwnedPayment && lockedStableBase) {
      const frozen = dep.payload as DepositPayload | null;
      if (frozen?.baseId && (frozen.baseId !== lockedStableBase.id
        || frozen.landPaidAt !== lockedStableBase.landPaidAt?.toISOString()
        || frozen.deedAssetId !== lockedStableBase.deedAssetId)) {
        throw new HttpError(409, 'deposit belongs to a different base epoch');
      }
    }

    let entryStamped = false;
    let landActivated = false;
    let stableBaseId: string | undefined;
    if (payment.kind === 'entry' || payment.kind === 'deed') {
      const base = lockedStableBase;
      const reservation = lockedLandReservation;
      const frozen = dep.payload as DepositPayload | null;
      if (!base || !reservation || !frozen?.baseId || frozen.baseId !== base.id
        || reservation.baseId !== base.id
        || frozen.amountLamports !== LAND_PRICE_LAMPORTS) {
        throw new HttpError(409, 'land reservation identity changed');
      }
      const native = reservation.addressKind === 'fantasy';
      if (native ? (frozen.landAddress?.kind !== 'fantasy'
          || frozen.landAddress.worldId !== reservation.fantasyWorldId || frozen.landAddress.tileId !== reservation.fantasyTileId)
        : (frozen.landAddress?.kind === 'fantasy' || frozen.earthCell !== reservation.earthCell || frozen.siteId !== reservation.siteId
          || frozen.tx !== reservation.x || frozen.ty !== reservation.y || frozen.countryA3 !== reservation.countryA3)) {
        throw new HttpError(409, 'land reservation address changed');
      }
      if (payment.lamports !== BigInt(LAND_PRICE_LAMPORTS)) {
        throw new HttpError(422, 'land payment does not match the frozen quote');
      }
      const [valley] = native || reservation.siteId === null ? [] : await tx.select({ id: valleys.id }).from(valleys).where(and(
        eq(valleys.planetId, 0), eq(valleys.siteId, reservation.siteId),
      )).for('update');
      if (!native && !valley) throw new HttpError(409, 'reserved Earth region is missing');
      const existingPlot = await tx.select({ id: plots.id }).from(plots).where(native
        ? sql`${plots.baseId}=${base.id} OR (${plots.fantasyWorldId}=${reservation.fantasyWorldId} AND ${plots.fantasyTileId}=${reservation.fantasyTileId})`
        : sql`${plots.baseId} = ${base.id} OR ${plots.earthCell} = ${reservation.earthCell}
          OR (${plots.valleyId} = ${valley!.id} AND ${plots.x} = ${reservation.x} AND ${plots.y} = ${reservation.y})`);
      if (existingPlot.length > 0) throw new HttpError(409, 'reserved Earth parcel is no longer free');
      if (!native && (fantasyWorldEnabled() || await fantasyPurchasesCutOver(tx)) && !await getFantasyClaim(tx, base.id)) {
        await reserveFantasyPurchase(tx, dep.id, base.id, undefined, { crownlandsOnly: true });
      }

      if (payment.kind === 'entry') {
        const stamped = await tx.update(players).set({ entryPaidAt: now })
          .where(and(eq(players.wallet, payment.wallet), isNull(players.entryPaidAt)))
          .returning({ wallet: players.wallet });
        if (stamped.length === 0) throw new HttpError(409, 'entry was already credited');
        entryStamped = true;
      }
      stableBaseId = base.id;
      // ONBOARDING CHAIN (owner 2026-08-28): "direct them to buy land". Ticked
      // for BOTH kinds that hand a wallet ground — the entry purchase and a
      // further deed — because the step reads "claim your land" and a player who
      // arrived by deed has done exactly that. Idempotent regardless: the step's
      // target is 1 and the LEAST clamp absorbs every later purchase.
      // Dynamic import for the same reason emission/forge/spend use one — quests
      // reaches back into the ledger this module owns.
      //
      // The baseId argument is multiBaseEnabled()-gated exactly like every other
      // tick site: with the flag off getQuestBoard reads quest_progress by
      // WALLET, so passing a base id here would file the tick in a table the
      // board never looks at and the step would never complete.
      {
        const { progressQuestBatch } = await import('../game/quests');
        await progressQuestBatch(tx, payment.wallet, [['first_land', 1]], now,
          multiBaseEnabled() ? base.id : undefined);
      }
      // The free-home source ends at this locked boundary. Keep the verified
      // payment's original timestamp, but never reuse a pre-lock time as the
      // production cutoff after waiting on player/base/signature locks.
      await closeHarvesterSources(tx, base.id, (opts.eventClock ?? (() => new Date()))(), 'realm_change');
      await tx.update(bases).set({ landPaidAt: now, updatedAt: now }).where(eq(bases.id, base.id));
      const currentSlots = await tx.select().from(baseSlots)
        .where(and(eq(baseSlots.wallet, payment.wallet), eq(baseSlots.active, true)))
        .orderBy(asc(baseSlots.slot)).for('update');
      const alreadySlotted = currentSlots.some((slot) => slot.baseId === base.id);
      if (alreadySlotted) {
        await tx.update(bases).set({ status: 'active', updatedAt: now }).where(eq(bases.id, base.id));
      } else if (currentSlots.length < BASE_OWNERSHIP.maxActive) {
        const used = new Set(currentSlots.map((slot) => slot.slot));
        const slot = Array.from({ length: BASE_OWNERSHIP.maxActive }, (_, i) => i + 1)
          .find((candidate) => !used.has(candidate))!;
        await tx.insert(baseSlots).values({ wallet: payment.wallet, slot, baseId: base.id, selectedAt: now });
        await tx.update(bases).set({ status: 'active', updatedAt: now }).where(eq(bases.id, base.id));
      }
      const fantasyTile = await assignPaidFantasyClaim(tx, dep.id, base.id, now);
      if (native && (!fantasyTile || fantasyTile.tileId !== reservation.fantasyTileId
        || fantasyTile.worldId !== reservation.fantasyWorldId)) throw new Error('Credited native land has no matching claim');
      await tx.insert(plots).values(native ? {
        baseId: base.id, playerWallet: payment.wallet, addressKind: 'fantasy',
        fantasyWorldId: fantasyTile!.worldId, fantasyTileId: fantasyTile!.tileId,
      } : {
        baseId: base.id, valleyId: valley!.id, x: reservation.x, y: reservation.y,
        earthCell: reservation.earthCell, countryA3: reservation.countryA3,
        playerWallet: payment.wallet,
      });
      await tx.update(plotReservations).set({ state: 'converted' })
        .where(eq(plotReservations.id, reservation.id));
      const paidOwned = await tx.select().from(bases).where(and(
        eq(bases.ownerWallet, payment.wallet), sql`${bases.landPaidAt} IS NOT NULL`,
      )).limit(2);
      if (paidOwned.length === 1 && paidOwned[0]!.id === base.id) {
        await tx.update(players).set({
          entryPaidAt: now, keepLevel: base.keepLevel,
          builders: base.builders, expansions: base.expansions,
        }).where(eq(players.wallet, payment.wallet));
      }
      landActivated = true;
    } else if (payment.kind === 'builder') {
      const base = lockedStableBase;
      if (!base) throw new HttpError(404, 'base not found');
      const builderQuote = dep.payload as DepositPayload | null;
      const expectedBuilders = builderQuote?.expectedBuilders;
      const amountLamports = builderQuote?.amountLamports;
      if (!Number.isInteger(expectedBuilders) || expectedBuilders === undefined
        || !Number.isSafeInteger(amountLamports) || amountLamports === undefined) {
        throw new HttpError(422, 'builder deposit is missing its frozen quote');
      }
      if (!builderQuote?.landPaidAt || base.landPaidAt?.toISOString() !== builderQuote.landPaidAt
        || builderQuote.deedAssetId !== base.deedAssetId
        || (builderQuote.baseId !== undefined && builderQuote.baseId !== base.id)) {
        throw new HttpError(409, 'builder deposit belongs to a different base epoch');
      }
      if (base.builders !== expectedBuilders) {
        throw new HttpError(409, 'builder slot changed before payment verification');
      }
      if (payment.lamports !== BigInt(amountLamports)) {
        throw new HttpError(422, 'builder payment does not match the frozen quote');
      }
      const res = await tx.update(bases)
        .set({ builders: sql`${bases.builders} + 1`, updatedAt: now })
        .where(and(eq(bases.id, base.id), eq(bases.builders, expectedBuilders)))
        .returning({ builders: bases.builders });
      if (res.length === 0) throw new HttpError(409, 'builder count changed — retry verification');
      const owned = await tx.select({ id: bases.id }).from(bases)
        .where(eq(bases.ownerWallet, payment.wallet)).limit(2);
      if (owned.length === 1 && owned[0]!.id === base.id) {
        await tx.update(players).set({ builders: res[0]!.builders })
          .where(eq(players.wallet, payment.wallet));
      }
    } else if (payment.kind === 'expansion') {
      const base = lockedStableBase;
      if (!base) throw new HttpError(404, 'base not found');
      const quote = dep.payload as DepositPayload | null;
      const idx = quote?.expectedExpansions;
      const amountLamports = quote?.amountLamports;
      if (!Number.isInteger(idx) || idx === undefined
        || !Number.isSafeInteger(amountLamports) || amountLamports === undefined) {
        throw new HttpError(422, 'expansion deposit is missing its frozen quote');
      }
      if (payment.lamports !== BigInt(amountLamports)) {
        throw new HttpError(422, 'expansion payment does not match the frozen quote');
      }
      await applyLockedExpansion(tx, base, { ...quote, expectedExpansions: idx }, payment.wallet, now);
    } else if (payment.kind === 'energy' || payment.kind === 'energy_pack') {
      // Pay-per-action SOL sink: the program routes any amount, so the SERVER
      // enforces the price before granting — an underpaid tx grants nothing.
      // The pack grants packSize energies for one verified payment; the loop
      // stays inside THIS credit transaction, so a pack can never half-grant.
      const frozen = dep.payload as DepositPayload | null;
      const original = frozen?.basePurchaseV1;
      if (original ? payment.lamports !== BigInt(original.amountLamports) : payment.lamports < SINK_PRICE_LAMPORTS[payment.kind]) {
        throw new HttpError(422, original ? 'energy payment does not match the frozen quote' : 'energy payment underpaid');
      }
      // assertBasePurchasePayment validated the retained kind and quantity. Never
      // substitute today's SKU size for a historical versioned purchase.
      const qty = original ? original.energyQuantity! : payment.kind === 'energy_pack' ? RAID_ENERGY.packSize : 1;
      const { grantPurchasedEnergy } = await import('../game/raids');
      for (let i = 0; i < qty; i++) {
        await grantPurchasedEnergy(tx, payment.wallet, frozen?.baseId);
      }
    } else if (payment.kind === 'shield') {
      const frozen = dep.payload as DepositPayload | null;
      const exact = frozen?.amountLamports;
      if (Number.isSafeInteger(exact) && exact !== undefined
        ? payment.lamports !== BigInt(exact)
        : payment.lamports < SINK_PRICE_LAMPORTS.shield) {
        throw new HttpError(422, 'shield payment does not match the frozen quote');
      }
      const { grantShieldExtension } = await import('../game/shop');
      const grant = await grantShieldExtension(
        tx, payment.wallet, now, frozen?.baseId, { deferMapInvalidation: true },
      );
      if (frozen?.basePurchaseV1) await tx.insert(basePurchaseShieldReceipts).values({ depositId: dep.id, granted: grant.granted, expiresAt: grant.expiresAt });
      if (grant.granted) {
        shieldMapInvalidation = {
          valleyId: await shieldMapValleyId(tx, payment.wallet, frozen?.baseId),
        };
      }
    } else if (payment.kind === 'mine') {
      // SOL-gated building upgrade ('mine' is the historical wire kind; since
      // D-057 it covers Mine L5+ AND Gold Forge L2+). The SOL price depends on
      // the building's CURRENT level, so read it and enforce the per-target
      // table before applying the upgrade (SHARD charge + job) atomically
      // inside this credit transaction.
      const frozen = dep.payload as DepositPayload | null;
      const buildingId = frozen?.buildingId;
      if (!buildingId) throw new HttpError(422, 'upgrade deposit missing buildingId');
      const [b] = await tx.select().from(buildings)
        .where(and(eq(buildings.id, buildingId), frozen?.baseId
          ? eq(buildings.baseId, frozen.baseId)
          : eq(buildings.playerWallet, payment.wallet)));
      const { applyPaidUpgrade, isSolGatedBuildingType } = await import('../game/base');
      if (!b || !isSolGatedBuildingType(b.type)) throw new HttpError(422, 'paid-upgrade building not found');
      const expected = BigInt(upgradeSolLamports(b.type, b.level + 1));
      const exact = frozen?.amountLamports;
      if (Number.isSafeInteger(exact) && exact !== undefined) {
        // The payment must equal the intent's frozen quote exactly — the
        // player signs the shown amount, never more or less.
        if (payment.lamports !== BigInt(exact)) {
          throw new HttpError(422, 'upgrade payment does not match the frozen quote');
        }
        // …and the quote must still COVER the current table price for the step
        // being advanced. Equal is the normal path. GREATER means an in-flight
        // pre-D-057 intent quoted at the old (higher) price: honour it rather
        // than strand a paid player (D-057 in-flight rule; also how a payment
        // for a now-free step like Mine L1→2 still lands). LOWER means the
        // building levelled past the quoted step — grant nothing (409 keeps
        // the row pending for reconciliation, exactly the pre-D-057 rule).
        if (BigInt(exact) < expected) {
          throw new HttpError(409, 'building level changed after this payment was quoted');
        }
      } else if (payment.lamports < expected) {
        // Pre-0071 rows carry no frozen quote: the observed amount itself must
        // cover the current table price.
        throw new HttpError(422, 'upgrade payment does not match the frozen quote');
      }
      await applyPaidUpgrade(
        tx, payment.wallet, buildingId, `mine-up:${depositId}`, now,
        frozen.baseId, Boolean(frozen.baseId),
        frozen.basePurchaseV1?.request.kind === 'mine' ? frozen.basePurchaseV1.request : undefined,
      );
    } else if (payment.kind === 'keep_deposit') {
      // KEEP deposit: credit the OBSERVED on-chain KEEP (payment.lamports carries
      // base units for this kind) to the play balance, converted to whole KEEP.
      // Backed 1:1 by the hot wallet's ATA (Proof of Reserves): onchain_inflow
      // −amount / player_keep +amount. Sub-1-KEEP dust (base units not a whole
      // multiple) stays uncredited in custody — the client deposits whole KEEP.
      const wholeKeep = payment.lamports / (10n ** BigInt(TOKEN.decimals));
      if (wholeKeep <= 0n) throw new HttpError(422, 'deposit below 1 KEEP');
      const sys = await bootstrapSystemAccounts(tx);
      const player = await getOrCreatePlayerAccount(tx, payment.wallet, 'player_keep');
      await postTransaction(tx, {
        idempotencyKey: `deposit:${depositId}:credit`,
        type: 'deposit.keep',
        entries: [
          { account: sys.onchain_inflow, delta: -wholeKeep },
          { account: player.id, delta: wholeKeep },
        ],
        metadata: { wallet: payment.wallet, txSignature: payment.txSignature, baseUnits: payment.lamports.toString() },
      });
    } else if (payment.kind === 'gems_buy') {
      // Get Gems from a wallet (E2-GEMS-CONTRACT §1.2 `gems.buy`): the KEEP
      // observed landing in the emission-reserve ATA (payment.lamports = base
      // units) is floored to whole KEEP and mints Gems 1:1 in ONE posting —
      // `onchain_inflow −k / emission_pool +k` (the reserve now holds the KEEP,
      // recycled into future budgets, G-4) and `gems_mint −g / player_gems +g`.
      // The KEEP leg in the same row IS the G-3 backing the ledger enforces.
      // Sub-KEEP dust stays on-chain, is recorded in `amount` and disclosed by
      // GET /deposits/:id; a transfer below 1 KEEP never credits (strands as
      // paid-failed for ops like a custody deposit). Flag-independent on
      // purpose: money moved is money honoured, whatever the intent gate says.
      // GEMS.maxConvertKeepPerTx bounds the INTENT only (security review
      // 2026-09-20 #4, by design): an over-payment credits the observed whole
      // KEEP because every Gem is fully backed by that inflow — refusing it
      // would strand real money for a number that protects nothing here.
      const original = originalGemsBuyIntent(dep);
      const wholeKeep = payment.lamports / (10n ** BigInt(original.decimals));
      if (wholeKeep <= 0n) throw new HttpError(422, 'deposit below 1 KEEP');
      const rate = original.gemsOut / original.keepIn;
      const gems = wholeKeep * BigInt(rate);
      const sys = await bootstrapSystemAccounts(tx);
      const gemsAcct = await getOrCreatePlayerAccount(tx, payment.wallet, 'player_gems');
      await postTransaction(tx, {
        idempotencyKey: `deposit:${depositId}:credit`,
        type: 'gems.buy',
        entries: [
          { account: sys.onchain_inflow, delta: -wholeKeep },
          { account: sys.emission_pool, delta: wholeKeep },
          { account: sys.gems_mint, delta: -gems },
          { account: gemsAcct.id, delta: gems },
        ],
        metadata: {
          wallet: payment.wallet, depositId, txSignature: payment.txSignature,
          keepBaseUnits: payment.lamports.toString(), keep: wholeKeep.toString(), gems: gems.toString(),
          rate, source: 'wallet', mint: original.mint, destination: original.destination,
        },
      });
    } else if (payment.kind === 'mine_build') {
      // Additional mine: the SOL (payment.lamports, observed landing in the
      // LIQUIDITY wallet) is re-price-checked and the mine placed atomically here.
      const p = dep.payload as DepositPayload | null;
      if (p?.tx === undefined || p?.ty === undefined || !Number.isInteger(p.expectedMines)) {
        throw new HttpError(422, 'mine_build deposit missing frozen slot identity');
      }
      const mineCount = (await tx.select({ id: buildings.id }).from(buildings).where(and(
        p.baseId ? eq(buildings.baseId, p.baseId) : eq(buildings.playerWallet, payment.wallet),
        eq(buildings.type, 'mine'),
      ))).length;
      if (mineCount !== p.expectedMines) {
        throw new HttpError(409, 'mine-build slot changed before payment verification');
      }
      if (Number.isSafeInteger(p.amountLamports) && p.amountLamports !== undefined
        && payment.lamports !== BigInt(p.amountLamports)) {
        throw new HttpError(422, 'mine build payment does not match the frozen quote');
      }
      const { applyMineBuild } = await import('../game/base');
      await applyMineBuild(
        tx, payment.wallet, p.tx, p.ty, payment.lamports, `mine-build:${depositId}`, now,
        p.baseId, Boolean(p.baseId),
        // Frozen slot re-checked INSIDE the player-row lock — the count read
        // above is unlocked and the free build route can commit between it and
        // the lock (security review 2026-08-16 finding 2).
        p.expectedMines,
      );
    } else if (payment.kind === 'keep_vend') {
      // Buy-vend credit: the SOL (observed landing in the liquidity wallet) is
      // re-priced at CURRENT constants before granting — the stored intent is a
      // quote, not an entitlement. Ledger: onchain_inflow −keepOut / player_keep
      // +keepOut, the same posting shape as keep_deposit.
      // New intents are disabled above until real reserve KEEP funding exists.
      // This branch intentionally remains: a payment made against a historical
      // pending intent must still terminalize and credit exactly once, or the
      // fail-closed change itself would strand customer funds.
      const keepOut = (dep.payload as DepositPayload | null)?.keepOut;
      if (!Number.isInteger(keepOut) || keepOut === undefined || keepOut < VEND.minKeepPerPurchase || keepOut > VEND.maxKeepPerPurchase) {
        throw new HttpError(422, 'keep_vend deposit has an invalid amount');
      }
      if (payment.lamports < vendLamportsForKeep(keepOut)) {
        throw new HttpError(422, 'keep vend underpaid');
      }
      const sys = await bootstrapSystemAccounts(tx);
      const player = await getOrCreatePlayerAccount(tx, payment.wallet, 'player_keep');
      await postTransaction(tx, {
        idempotencyKey: `vend:${depositId}:credit`,
        type: 'vend.keep',
        entries: [
          { account: sys.onchain_inflow, delta: -BigInt(keepOut) },
          { account: player.id, delta: BigInt(keepOut) },
        ],
        metadata: { wallet: payment.wallet, txSignature: payment.txSignature, lamportsPaid: payment.lamports.toString() },
      });
    } else if (payment.kind === 'warzone_shield') {
      // The two-leg verifier already confirmed BOTH halves (each >= its 50% target)
      // at finalized; re-check the TOTAL price + the no-stacking rule under this
      // credit tx (closes the credit-time stacking race). Idempotency comes from
      // the deposit row's status-guard + unique txSignature (creditDeposit outer).
      const frozen = dep.payload as DepositPayload | null;
      if (frozen?.basePurchaseV1 ? payment.lamports !== BigInt(frozen.basePurchaseV1.amountLamports)
        : payment.lamports < BigInt(WARZONE.shieldCostSolLamports)) {
        throw new HttpError(422, 'warzone shield underpaid');
      }
      const { hasActiveWarzoneShield, grantWarzoneShield } = await import('../game/warzoneShield');
      if (!frozen?.baseId) throw new HttpError(422, 'warzone shield deposit is missing its frozen base');
      if (await hasActiveWarzoneShield(tx, payment.wallet, now, frozen.baseId)) {
        throw new HttpError(422, 'already have an active warzone shield');
      }
      const grant = await grantWarzoneShield(
        tx, payment.wallet, now, frozen.baseId, { deferMapInvalidation: true },
      );
      if (frozen.basePurchaseV1) await tx.insert(basePurchaseShieldReceipts).values({ depositId: dep.id, granted: true, expiresAt: grant.expiresAt });
      shieldMapInvalidation = {
        valleyId: await shieldMapValleyId(tx, payment.wallet, frozen.baseId),
      };
    } else {
      // Defensive: a future deposit kind must be handled explicitly, never
      // silently price-checked and granted as a shield (security review #3).
      throw new HttpError(422, `unhandled deposit kind: ${payment.kind}`);
    }
    return {
      credited: true,
      entryStamped,
      landActivated,
      ...(stableBaseId ? { baseId: stableBaseId } : {}),
      ...(shieldMapInvalidation ? { shieldMapInvalidation } : {}),
    };
  });
  if (result.shieldMapInvalidation && !opts.deferMapInvalidation) {
    invalidateShieldMapValley(result.shieldMapInvalidation.valleyId);
  }
  return result;
}

/** How many rows the DEPOSIT KEEP page's RECENT DEPOSITS list shows. A page
 * size, not a game number: nothing is priced or capped by it. */
const KEEP_DEPOSIT_HISTORY_LIMIT = 20;

/** The caller's own KEEP custody inflows, newest first (tester request
 * 2026-09-16: "add deposit KEEP txn history on its page"). Read-only and
 * caller-scoped like GET /withdrawals; `amount` is the OBSERVED base units and
 * `amountKeep` the whole KEEP the credit path posted (same TOKEN.decimals
 * division as the deposit.keep posting above), so the list can never quote a
 * number the ledger did not. Curated DTO: bigint columns must not reach
 * Fastify's serializer raw. */
export async function listKeepDeposits(db: Db, wallet: string, limit = KEEP_DEPOSIT_HISTORY_LIMIT) {
  const rows = await db.select().from(deposits)
    .where(and(eq(deposits.playerWallet, wallet), eq(deposits.kind, 'keep_deposit')))
    .orderBy(desc(deposits.createdAt))
    .limit(limit);
  return rows.map((d) => ({
    id: d.id,
    status: d.status,
    amount: d.amount === null ? null : d.amount.toString(),
    amountKeep: d.amount === null ? null : (d.amount / (10n ** BigInt(TOKEN.decimals))).toString(),
    txSignature: d.txSignature,
    createdAt: d.createdAt,
    finalizedAt: d.finalizedAt,
  }));
}

export async function getDeposit(db: Db, wallet: string, depositId: string) {
  const [d] = await db.select().from(deposits)
    .where(and(eq(deposits.id, depositId), eq(deposits.playerWallet, wallet)));
  if (!d) throw new HttpError(404, 'deposit not found');
  const [reservation] = d.kind === 'entry' || d.kind === 'deed'
    ? await db.select()
      .from(plotReservations).where(eq(plotReservations.depositId, d.id))
    : [undefined];
  // Curated DTO: `amount` is a bigint column — raw rows blow up Fastify's JSON
  // serialization the moment a credit sets it (found by the R9 devnet e2e).
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    reference: d.reference,
    txSignature: d.txSignature,
    paymentSignature: d.paymentSignature,
    amount: d.amount === null ? null : d.amount.toString(),
    ...(reservation ? {
      baseId: reservation.baseId, ...await landReservationAddress(db, reservation),
      amountLamports: (d.payload as DepositPayload | null)?.amountLamports ?? LAND_PRICE_LAMPORTS,
      ...landPaymentWindow(d.createdAt),
    } : {}),
    ...(d.kind === 'gems_buy' ? await gemsBuyDisclosure(db, d) : {}),
    createdAt: d.createdAt,
    finalizedAt: d.finalizedAt,
  };
}
