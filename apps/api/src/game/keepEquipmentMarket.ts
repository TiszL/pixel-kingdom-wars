/** D153.190 listing escrow and permanent partial-fill reservations only.
 * Payment proof/delivery must extend these immutable originals, never reissue
 * inventory from a client receipt or release a possibly paid reservation. */
import { sql } from 'drizzle-orm';
import { PHASE_E_KEEP_EQUIPMENT_MARKET } from '@shardkeep/shared';
import {
  KeepEquipmentMarketListingRequestSchema, KeepEquipmentMarketFillRequestSchema, KeepEquipmentMarketCancelRequestSchema,
  type KeepEquipmentMarketItem, type KeepEquipmentMarketListingRequest, type KeepEquipmentMarketFillRequest, type KeepEquipmentMarketCancelRequest,
} from '@shardkeep/shared/keepEquipmentMarketApi';
import { OrdinaryEquipmentUuidSchema } from '@shardkeep/shared/ordinaryEquipmentApi';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import type { StableBaseMutationContext } from './stableBasePrerequisites';

export type KeepEquipmentMarketDeps = { clock?: () => Date; assertAdmission?: () => void };
export type KeepEquipmentListing = {
  id: string; sellerWallet: string; sellerBaseId: string; itemId: KeepEquipmentMarketItem;
  quantity: string; unitPriceBaseUnits: string; createdAt: string;
  availableQuantity: string; reservedQuantity: string; cancelledQuantity: string;
};
export type KeepEquipmentFill = {
  id: string; listingId: string; buyerWallet: string; buyerBaseId: string; quantity: string; totalBaseUnits: string; createdAt: string;
  sellerWallet: string; sellerBaseId: string; itemId: KeepEquipmentListing['itemId']; unitPriceBaseUnits: string;
};
export type KeepEquipmentCancellation = { id: string; listingId: string; actorWallet: string; quantity: string; createdAt: string };
type ListingRow = { id: string; seller_wallet: string; seller_base_id: string; item_id: KeepEquipmentListing['itemId'];
  quantity: string; unit_price_base_units: string; created_at: Date; reserved_quantity: string; cancelled_quantity: string };
type FillRow = { id: string; listing_id: string; buyer_wallet: string; buyer_base_id: string; quantity: string; total_base_units: string; created_at: Date;
  seller_wallet: string; seller_base_id: string; item_id: KeepEquipmentListing['itemId']; unit_price_base_units: string };
type CancellationRow = { id: string; listing_id: string; actor_wallet: string; quantity: string; created_at: Date };
const conflict = () => new HttpError(409, 'Market key belongs to another original command', 'IDEMPOTENCY_BODY_MISMATCH');
const missing = () => new HttpError(404, 'Equipment listing was not found', 'KEEP_EQUIPMENT_MARKET_NOT_FOUND');
function admission(deps: KeepEquipmentMarketDeps) {
  if (!deps.assertAdmission) throw new HttpError(503, 'Equipment market is paused', 'KEEP_EQUIPMENT_MARKET_DISABLED');
  deps.assertAdmission();
}
function now(deps: KeepEquipmentMarketDeps) {
  const at = new Date((deps.clock ?? (() => new Date()))().getTime());
  if (!Number.isFinite(+at)) throw new Error('Invalid equipment market clock');
  return at.toISOString();
}
function topLevel(db: Db) { if ('rollback' in db) throw new Error('Equipment market requires a top-level database'); }
function marketError(error: unknown): unknown {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    if ('code' in cause && cause.code === '23505') return conflict();
    if ('message' in cause && typeof cause.message === 'string') {
      const errors: Record<string, [number, string]> = {
        KEEP_EQUIPMENT_MARKET_STOCK: [422, 'Not enough available stock to list'],
        KEEP_EQUIPMENT_MARKET_CAPACITY: [409, 'The original kingdom has no room for this return'],
        KEEP_EQUIPMENT_MARKET_UNAVAILABLE: [409, 'This quantity is no longer available'],
        KEEP_EQUIPMENT_MARKET_AUTHORITY: [409, 'The original deed ownership changed'],
        KEEP_EQUIPMENT_MARKET_RAID: [423, 'A market kingdom is being raided'],
        KEEP_EQUIPMENT_MARKET_PRICE: [422, 'This purchase amount is outside the supported payment bounds'],
      };
      const found = errors[cause.message]; if (found) return new HttpError(found[0], found[1], cause.message);
    }
    cause = 'cause' in cause ? cause.cause : null;
  }
  return error;
}

export async function readKeepEquipmentListing(db: DbOrTx, id: string): Promise<KeepEquipmentListing | null> {
  const [row] = await db.execute<ListingRow>(sql`select l.*,l.quantity::text,l.unit_price_base_units::text,
    coalesce((select sum(f.quantity::numeric) from keep_equipment_fills f where f.listing_id=l.id),0)::text reserved_quantity,
    coalesce((select sum(c.quantity::numeric) from keep_equipment_listing_cancellations c where c.listing_id=l.id),0)::text cancelled_quantity
    from keep_equipment_listings l where l.id=${OrdinaryEquipmentUuidSchema.parse(id)}`);
  if (!row) return null;
  const available = BigInt(row.quantity) - BigInt(row.reserved_quantity) - BigInt(row.cancelled_quantity);
  if (available < 0n) throw new Error('Equipment market custody does not conserve listing quantity');
  return { id: row.id, sellerWallet: row.seller_wallet, sellerBaseId: row.seller_base_id, itemId: row.item_id,
    quantity: row.quantity, unitPriceBaseUnits: row.unit_price_base_units, createdAt: new Date(row.created_at).toISOString(),
    availableQuantity: available.toString(), reservedQuantity: row.reserved_quantity, cancelledQuantity: row.cancelled_quantity };
}
export async function readOwnedKeepEquipmentFill(db: DbOrTx, wallet: string, id: string): Promise<KeepEquipmentFill | null> {
  const [row] = await db.execute<FillRow>(sql`select f.*,f.quantity::text,f.total_base_units::text,l.seller_wallet,l.seller_base_id,l.item_id,l.unit_price_base_units::text
    from keep_equipment_fills f join keep_equipment_listings l on l.id=f.listing_id where f.id=${OrdinaryEquipmentUuidSchema.parse(id)} and f.buyer_wallet=${wallet}`);
  return row ? { id: row.id, listingId: row.listing_id, buyerWallet: row.buyer_wallet, buyerBaseId: row.buyer_base_id,
    quantity: row.quantity, totalBaseUnits: row.total_base_units, createdAt: new Date(row.created_at).toISOString(),
    sellerWallet: row.seller_wallet, sellerBaseId: row.seller_base_id, itemId: row.item_id, unitPriceBaseUnits: row.unit_price_base_units } : null;
}
export async function readOwnedKeepEquipmentCancellation(db: DbOrTx, wallet: string, id: string): Promise<KeepEquipmentCancellation | null> {
  const [row] = await db.execute<CancellationRow>(sql`select c.*,c.quantity::text from keep_equipment_listing_cancellations c
    where c.id=${OrdinaryEquipmentUuidSchema.parse(id)} and c.actor_wallet=${wallet}`);
  return row ? { id: row.id, listingId: row.listing_id, actorWallet: row.actor_wallet, quantity: row.quantity, createdAt: new Date(row.created_at).toISOString() } : null;
}
function matchListing(row: KeepEquipmentListing, wallet: string, request: KeepEquipmentMarketListingRequest) {
  if (row.sellerWallet !== wallet || row.sellerBaseId !== request.baseId || row.itemId !== request.itemId
    || row.quantity !== request.quantity || row.unitPriceBaseUnits !== request.unitPriceBaseUnits) throw conflict();
  return row;
}
function matchFill(row: KeepEquipmentFill, request: KeepEquipmentMarketFillRequest) {
  if (row.listingId !== request.listingId || row.buyerBaseId !== request.buyerBaseId || row.quantity !== request.quantity) throw conflict();
  return row;
}
function matchCancellation(row: KeepEquipmentCancellation, request: KeepEquipmentMarketCancelRequest) {
  if (row.listingId !== request.listingId) throw conflict(); return row;
}
type Participant = { wallet: string; context: StableBaseMutationContext };
async function lockPlayers(tx: DbTx, wallets: string[]) {
  await tx.execute(sql`select wallet from players where wallet in (${sql.join([...new Set(wallets)].map(w => sql`${w}`), sql`,`)}) order by wallet for update`);
}
async function lockParticipants(tx: DbTx, participants: Participant[]) {
  const sorted = [...participants].sort((a, b) => a.context.baseId.localeCompare(b.context.baseId));
  const ids = [...new Set(sorted.map(p => OrdinaryEquipmentUuidSchema.parse(p.context.baseId)))];
  const bases = await tx.execute<{ id: string; owner_wallet: string; status: string; land_paid_at: Date | null; deed_asset_id: string | null }>(sql`
    select id,owner_wallet,status,land_paid_at,deed_asset_id from bases where id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) order by id for update`);
  const slots = await tx.execute<{ base_id: string; wallet: string; active: boolean }>(sql`
    select base_id,wallet,active from base_slots where base_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) order by base_id,wallet for update`);
  const raids = await tx.execute(sql`select base_id from base_raid_locks where base_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) order by base_id for update`);
  if (raids.length) throw new HttpError(423, 'A market kingdom is being raided', 'BASE_BEING_RAIDED');
  for (const participant of sorted) {
    const base = bases.find(b => b.id === participant.context.baseId);
    if (!base || base.owner_wallet !== participant.wallet || base.status !== 'active'
      || !slots.some(s => s.base_id === base.id && s.wallet === participant.wallet && s.active)) throw new HttpError(409, 'Deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
    if (!base.land_paid_at || !base.deed_asset_id) throw new HttpError(409, 'A Land Deed is required to trade', 'KEEP_EQUIPMENT_MARKET_DEED_REQUIRED');
    await participant.context.assertAuthority(tx, participant.wallet, base.id);
  }
  return async () => { for (const participant of sorted) await participant.context.assertAuthority(tx, participant.wallet, participant.context.baseId); };
}
function contextMatches(context: StableBaseMutationContext | undefined, baseId: string) {
  if (!context || context.baseId !== baseId) throw new HttpError(409, 'The exact market kingdom authority is required', 'BASE_ID_REQUIRED');
}

export async function createKeepEquipmentListing(db: Db, wallet: string, raw: unknown, authority: StableBaseMutationContext, deps: KeepEquipmentMarketDeps = {}) {
  topLevel(db); const request = KeepEquipmentMarketListingRequestSchema.parse(raw);
  const old = await readKeepEquipmentListing(db, request.idempotencyKey); if (old) return matchListing(old, wallet, request);
  admission(deps); contextMatches(authority, request.baseId);
  return db.transaction(async tx => {
    await lockPlayers(tx, [wallet]);
    const existing = await readKeepEquipmentListing(tx, request.idempotencyKey); if (existing) return matchListing(existing, wallet, request);
    const recheck = await lockParticipants(tx, [{ wallet, context: authority }]);
    admission(deps);
    await tx.execute(sql`insert into keep_equipment_listings(id,seller_wallet,seller_base_id,item_id,quantity,unit_price_base_units,created_at)
      values(${request.idempotencyKey},${wallet},${request.baseId},${request.itemId},${request.quantity}::bigint,${request.unitPriceBaseUnits}::numeric,${now(deps)}::timestamptz)`);
    await recheck(); admission(deps);
    return (await readKeepEquipmentListing(tx, request.idempotencyKey))!;
  }).catch(error => { throw marketError(error); });
}
export async function reserveKeepEquipmentFill(db: Db, wallet: string, raw: unknown,
  authority: { buyer: StableBaseMutationContext; seller: StableBaseMutationContext }, deps: KeepEquipmentMarketDeps = {}) {
  topLevel(db); const request = KeepEquipmentMarketFillRequestSchema.parse(raw);
  const old = await readOwnedKeepEquipmentFill(db, wallet, request.idempotencyKey); if (old) return matchFill(old, request);
  const offer = await readKeepEquipmentListing(db, request.listingId); if (!offer) throw missing();
  admission(deps); contextMatches(authority?.buyer, request.buyerBaseId); contextMatches(authority?.seller, offer.sellerBaseId);
  if (wallet === offer.sellerWallet) throw new HttpError(422, 'You cannot buy your own listing', 'KEEP_EQUIPMENT_MARKET_SELF_BUY');
  const total = BigInt(request.quantity) * BigInt(offer.unitPriceBaseUnits);
  if (total < PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits || total > (1n << 64n) - 1n)
    throw new HttpError(422, 'This purchase amount is outside the supported payment bounds', 'KEEP_EQUIPMENT_MARKET_PRICE');
  return db.transaction(async tx => {
    await lockPlayers(tx, [wallet, offer.sellerWallet]);
    const existing = await readOwnedKeepEquipmentFill(tx, wallet, request.idempotencyKey); if (existing) return matchFill(existing, request);
    const recheck = await lockParticipants(tx, [{ wallet, context: authority.buyer }, { wallet: offer.sellerWallet, context: authority.seller }]);
    await tx.execute(sql`select id from keep_equipment_listings where id=${offer.id} for update`); admission(deps);
    await tx.execute(sql`insert into keep_equipment_fills(id,listing_id,buyer_wallet,buyer_base_id,quantity,created_at)
      values(${request.idempotencyKey},${request.listingId},${wallet},${request.buyerBaseId},${request.quantity}::bigint,${now(deps)}::timestamptz)`);
    await recheck(); admission(deps);
    return (await readOwnedKeepEquipmentFill(tx, wallet, request.idempotencyKey))!;
  }).catch(error => { throw marketError(error); });
}
export async function cancelKeepEquipmentListing(db: Db, wallet: string, raw: unknown, authority: StableBaseMutationContext, deps: KeepEquipmentMarketDeps = {}) {
  topLevel(db); const request = KeepEquipmentMarketCancelRequestSchema.parse(raw);
  const old = await readOwnedKeepEquipmentCancellation(db, wallet, request.idempotencyKey); if (old) return matchCancellation(old, request);
  const offer = await readKeepEquipmentListing(db, request.listingId); if (!offer) throw missing();
  admission(deps); contextMatches(authority, offer.sellerBaseId);
  return db.transaction(async tx => {
    await lockPlayers(tx, [wallet]);
    const existing = await readOwnedKeepEquipmentCancellation(tx, wallet, request.idempotencyKey); if (existing) return matchCancellation(existing, request);
    const recheck = await lockParticipants(tx, [{ wallet, context: authority }]);
    await tx.execute(sql`select id from keep_equipment_listings where id=${offer.id} for update`); admission(deps);
    await tx.execute(sql`insert into keep_equipment_listing_cancellations(id,listing_id,actor_wallet,created_at)
      values(${request.idempotencyKey},${request.listingId},${wallet},${now(deps)}::timestamptz)`);
    await recheck(); admission(deps);
    return (await readOwnedKeepEquipmentCancellation(tx, wallet, request.idempotencyKey))!;
  }).catch(error => { throw marketError(error); });
}
