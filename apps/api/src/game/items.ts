/**
 * Items (ITEMS-LOOTBOX-MARKETPLACE-PLAN §6/§11). The catalog lives in
 * @shardkeep/shared ITEMS (game numbers rule); this module owns inventory +
 * purchase + use + hero equip.
 *
 * Money rules: purchases charge Gems (player_gems − / gems_sink +) or, for a
 * legacy client, KEEP (player_keep − / emission_pool + — 100% recycle), inside ONE
 * transaction with the inventory grant, so a charge can never land without the
 * item or vice-versa. Consumables STACK (qty increments). USE decrements qty
 * atomically WITH its effect — an inapplicable effect (e.g. no eligible build
 * job) rolls the whole use back, item kept.
 *
 * The keep-skin cosmetics (the only account cosmetics) were removed from the
 * game (owner 2026-08-15, M23 a8) with a D-009 ledger refund — see
 * skinRefunds.ts. players.keep_skin remains as a DEAD column (additive
 * discipline, no schema migration); the refund sweep NULLs it.
 */
import {
  GEAR_SLOTS,
  HERO_KEYS,
  HERO_LEVELING,
  HEROES,
  INVENTORY,
  ITEMS,
  isEliteTroop,
  type GearModifierStat,
  type GearSlot,
  type HeroCombatLoadout,
  type HeroCombatModifiers,
  type HeroKey,
  type ItemId,
  type ItemSpec,
  fmtDur,
} from '@shardkeep/shared';
import { createHash } from 'node:crypto';
import type { ItemPurchaseConsent } from '@shardkeep/shared/itemPurchase';
import { and, asc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  baseCampaignProgress,
  baseHeroEquipment,
  baseHeroLoadouts,
  baseHeroProgress,
  baseItems,
  baseProfiles,
  builderJobs,
  campaignProgress,
  heroEquipment,
  heroLevels,
  heroLoadouts,
  itemUses,
  bases,
  playerItems,
  players,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import { forgeIngotsEnabled, heroGearCombatEnabled, multiBaseEnabled } from '../config';
import { listHeroes, recruitedHeroesOf } from './heroes';
import { eliteUnlocksOf } from './troopUnlocks';
import { spendGameCurrency } from './spend';
import { ITEM_PURCHASE_FEATURE, assertItemPurchaseScope, itemPurchaseEvidence, itemPurchaseIntent,
  itemPurchaseLedgerKey, itemPurchaseQuote, replayItemPurchase } from './itemPurchaseReceipt';
import {
  lockStablePrerequisiteBase,
  requireActiveStablePrerequisiteBase,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';
import { invalidateShieldMapValley, shieldMapValleyId } from './baseShields';

export function isItemId(id: string): id is ItemId {
  return Object.prototype.hasOwnProperty.call(ITEMS, id);
}

export function isGearSlot(slot: string): slot is GearSlot {
  return (GEAR_SLOTS as readonly string[]).includes(slot);
}

function itemSpec(itemId: string): ItemSpec | undefined {
  return (ITEMS as Record<string, ItemSpec | undefined>)[itemId];
}

function emptyModifiers(): Record<GearModifierStat, number> {
  return Object.fromEntries(
    Object.keys(INVENTORY.modifierCapsBps).map((stat) => [stat, 0]),
  ) as Record<GearModifierStat, number>;
}

function resolvedModifiers(itemIds: readonly string[]): {
  modifiers: Record<GearModifierStat, number>;
  wardenPieces: number;
  setActive: boolean;
} {
  const modifiers = emptyModifiers();
  let wardenPieces = 0;
  for (const id of itemIds) {
    const spec = itemSpec(id);
    if (!spec || spec.kind !== 'gear') continue;
    if (spec.set === 'warden') wardenPieces++;
    for (const modifier of spec.modifiers ?? []) modifiers[modifier.stat] += modifier.value;
  }
  const setActive = wardenPieces >= INVENTORY.wardenSet.equippedPieces;
  if (setActive) {
    for (const modifier of INVENTORY.wardenSet.modifiers) modifiers[modifier.stat] += modifier.value;
  }
  for (const stat of Object.keys(modifiers) as GearModifierStat[]) {
    const cap = INVENTORY.modifierCapsBps[stat];
    modifiers[stat] = Math.max(-cap, Math.min(cap, modifiers[stat]));
  }
  return { modifiers, wardenPieces, setActive };
}

/** Integer basis-point application — exported so listHeroes' roster gear view
 * (heroes.ts, via dynamic import to dodge the module cycle) computes the exact
 * numbers this inventory view and the sim's applyBps produce. */
export function applyBps(value: number, bps: number): number {
  return Math.floor((value * (10_000 + bps)) / 10_000);
}

export interface ResolvedHeroLoadout {
  hero: HeroKey;
  catalogRevision: number;
  version: number;
  hash: string;
  equipment: Partial<Record<GearSlot, ItemId>>;
  itemIds: ItemId[];
  modifiers: HeroCombatModifiers;
  wardenPieces: number;
  setActive: boolean;
}

/** One canonical read + resolution path for inventory views, raid freezing and
 * scouts. The loadout row and all slots come from one SQL statement, avoiding a
 * version/equipment tear across concurrent equip commits. */
export async function resolveHeroLoadouts(
  db: DbOrTx,
  wallet: string,
  baseId?: string,
): Promise<Record<HeroKey, ResolvedHeroLoadout>> {
  const rows = baseId
    ? await db.select({
      hero: baseHeroLoadouts.hero,
      version: baseHeroLoadouts.version,
      slot: baseHeroEquipment.slot,
      itemId: baseHeroEquipment.itemId,
    }).from(baseHeroLoadouts)
      .leftJoin(baseHeroEquipment, and(
        eq(baseHeroEquipment.baseId, baseHeroLoadouts.baseId),
        eq(baseHeroEquipment.hero, baseHeroLoadouts.hero),
      ))
      .where(eq(baseHeroLoadouts.baseId, baseId))
    : await db.select({
      hero: heroLoadouts.hero,
      version: heroLoadouts.version,
      slot: heroEquipment.slot,
      itemId: heroEquipment.itemId,
    }).from(heroLoadouts)
      .leftJoin(heroEquipment, and(
        eq(heroEquipment.playerWallet, heroLoadouts.playerWallet),
        eq(heroEquipment.hero, heroLoadouts.hero),
      ))
      .where(eq(heroLoadouts.playerWallet, wallet));

  const byHero = Object.fromEntries(HERO_KEYS.map((hero) => [hero, {
    version: 0,
    equipment: {} as Partial<Record<GearSlot, ItemId>>,
  }])) as Record<HeroKey, { version: number; equipment: Partial<Record<GearSlot, ItemId>> }>;
  for (const row of rows) {
    const hero = row.hero as HeroKey;
    byHero[hero].version = row.version;
    if (row.slot === null || row.itemId === null) continue;
    const spec = itemSpec(row.itemId);
    if (!spec || spec.kind !== 'gear' || spec.slot !== row.slot) {
      throw new Error(`invalid equipped gear ${row.itemId} in ${hero}.${row.slot}`);
    }
    byHero[hero].equipment[row.slot] = row.itemId as ItemId;
  }

  return Object.fromEntries(HERO_KEYS.map((hero) => {
    const state = byHero[hero];
    const equipment = Object.fromEntries(GEAR_SLOTS.flatMap((slot) => {
      const itemId = state.equipment[slot];
      return itemId ? [[slot, itemId] as const] : [];
    })) as Partial<Record<GearSlot, ItemId>>;
    const itemIds = GEAR_SLOTS.flatMap((slot) => {
      const itemId = equipment[slot];
      return itemId ? [itemId] : [];
    });
    const resolved = resolvedModifiers(itemIds);
    const canonical = JSON.stringify({
      catalogRevision: INVENTORY.catalogRevision,
      hero,
      version: state.version,
      equipment: GEAR_SLOTS.map((slot) => [slot, equipment[slot] ?? null]),
    });
    const value: ResolvedHeroLoadout = {
      hero,
      catalogRevision: INVENTORY.catalogRevision,
      version: state.version,
      hash: createHash('sha256').update(canonical).digest('hex'),
      equipment,
      itemIds,
      modifiers: resolved.modifiers,
      wardenPieces: resolved.wardenPieces,
      setActive: resolved.setActive,
    };
    return [hero, value];
  })) as Record<HeroKey, ResolvedHeroLoadout>;
}

/** Server-side raid/scout helper; no wallet join can tear state after a sale. */
export async function resolveBaseHeroLoadouts(
  db: DbOrTx,
  baseId: string,
): Promise<Record<HeroKey, ResolvedHeroLoadout>> {
  return resolveHeroLoadouts(db, '', baseId);
}

/** Raid projection. Empty loadouts are omitted by callers to preserve historical
 * replay bytes; this helper deliberately contains no live feature-flag read. */
export function toHeroCombatLoadout(loadout: ResolvedHeroLoadout): HeroCombatLoadout {
  return {
    catalogRevision: loadout.catalogRevision,
    version: loadout.version,
    hash: loadout.hash,
    modifiers: { ...loadout.modifiers },
  };
}

/** Stored-unit usage. Shop purchases are admission-controlled against the cap.
 * Restoration/earned paths (unequip, market cancel/paid settle, Forge drop)
 * never destroy an owed item: they may produce `overflow: true`, which blocks
 * later shop acquisitions until the player frees space. */
function inventoryUsage(
  owned: readonly { itemId: string; qty: number }[],
  equipped: readonly { itemId: string }[],
): number {
  const equippedCount = new Map<string, number>();
  for (const row of equipped) equippedCount.set(row.itemId, (equippedCount.get(row.itemId) ?? 0) + 1);
  let used = 0;
  for (const row of owned) {
    const spec = itemSpec(row.itemId);
    if (!spec) continue;
    const stored = Math.max(0, row.qty - (equippedCount.get(row.itemId) ?? 0));
    used += stored * spec.weight;
  }
  return used;
}

export interface BaseItemQuantity {
  itemId: ItemId;
  qty: number;
}

/** Raid/Forge integration read of deed-owned inventory. */
export async function baseItemQuantities(
  db: DbOrTx,
  baseId: string,
  itemIds?: readonly ItemId[],
): Promise<BaseItemQuantity[]> {
  const rows = await db.select({ itemId: baseItems.itemId, qty: baseItems.qty })
    .from(baseItems)
    .where(itemIds && itemIds.length > 0
      ? and(eq(baseItems.baseId, baseId), inArray(baseItems.itemId, [...itemIds]))
      : eq(baseItems.baseId, baseId));
  return rows.flatMap((row) => isItemId(row.itemId)
    ? [{ itemId: row.itemId, qty: row.qty }]
    : []);
}

/** Atomic internal consumer for accepted raid/effect commands. */
export async function consumeBaseItem(
  db: DbOrTx,
  baseId: string,
  itemId: ItemId,
  quantity = 1,
): Promise<number> {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError('quantity must be a positive integer');
  const [row] = await db.update(baseItems)
    .set({ qty: sql`${baseItems.qty} - ${quantity}` })
    .where(and(
      eq(baseItems.baseId, baseId),
      eq(baseItems.itemId, itemId),
      gte(baseItems.qty, quantity),
    ))
    .returning({ qty: baseItems.qty });
  if (!row) throw new HttpError(422, `not enough ${itemId}`);
  return row.qty;
}

/** Catalog + this player's inventory (with stack counts) + equipped slots. */
export async function getItems(db: Db, wallet: string, baseId?: string, now = new Date()) {
  const stableBaseId = multiBaseEnabled() ? baseId : undefined;
  if (multiBaseEnabled() && !stableBaseId) {
    throw new HttpError(409, 'baseId is required while multi-base is active', 'BASE_ID_REQUIRED');
  }
  if (stableBaseId) await requireActiveStablePrerequisiteBase(db, wallet, stableBaseId);
  const stableRows = stableBaseId
    ? await db.select({ itemId: baseItems.itemId, qty: baseItems.qty, seenAt: baseItems.seenAt })
      .from(baseItems).where(eq(baseItems.baseId, stableBaseId))
    : null;
  const walletRows = await db.select({ itemId: playerItems.itemId, qty: playerItems.qty, seenAt: playerItems.seenAt })
    .from(playerItems).where(eq(playerItems.playerWallet, wallet));
  // All playable inventory follows the deed in stable mode; the wallet book is
  // the flag-off compatibility path only (account cosmetics retired, M23 a8).
  const itemRows = stableRows ?? walletRows;
  const [resolvedLoadouts, heroView, p, deedRows, eliteUnlocks] = await Promise.all([
    resolveHeroLoadouts(db, wallet, stableBaseId),
    listHeroes(db, wallet, now, baseId),
    db.select({ deedAssetId: players.deedAssetId, keepLevel: players.keepLevel })
      .from(players).where(eq(players.wallet, wallet)),
    db.select({
      baseId: bases.id, assetId: bases.deedAssetId, status: bases.status,
      keepLevel: bases.keepLevel,
    }).from(bases).where(and(eq(bases.ownerWallet, wallet), isNull(bases.deedMintingAt))),
    eliteUnlocksOf(db, wallet),
  ]);
  const heroLoadoutViews = heroView.heroes.map((hero) => {
    const resolved = resolvedLoadouts[hero.hero];
    return {
      hero: hero.hero,
      recruited: hero.recruited,
      level: hero.level,
      recoveryUntil: hero.recoveryUntil,
      available: hero.available,
      version: resolved.version,
      hash: resolved.hash,
      equipment: resolved.equipment,
      itemIds: resolved.itemIds,
      modifiers: resolved.modifiers,
      setBonus: {
        id: 'warden', pieces: resolved.wardenPieces,
        required: INVENTORY.wardenSet.equippedPieces, active: resolved.setActive,
      },
      baseStats: { hp: hero.hp, basicDamage: hero.dps, skillDamageSeed: hero.dps },
      effectiveStats: {
        hp: applyBps(hero.hp, resolved.modifiers.hero_hp_bps),
        basicDamage: applyBps(hero.dps, resolved.modifiers.hero_damage_bps),
        skillDamageSeed: applyBps(
          hero.dps,
          resolved.modifiers.hero_damage_bps + resolved.modifiers.ability_damage_bps,
        ),
      },
    };
  });
  const equippedRows = HERO_KEYS.flatMap((hero) => resolvedLoadouts[hero].itemIds.map((itemId) => ({ itemId })));
  const used = inventoryUsage(itemRows, equippedRows);
  return {
    catalogRevision: INVENTORY.catalogRevision,
    features: { itemPurchase: ITEM_PURCHASE_FEATURE },
    // The screen renders combat stats from this server flag. Equipped gear can
    // be managed before rollout without implying its modifiers affect raids.
    heroGearCombatEnabled: heroGearCombatEnabled(),
    // Earned drop-only items are not purchasable, but an owned one still needs
    // its catalog spec so the dedicated inventory can render/select/use it.
    // Hide only unowned drops; buyItem remains the authoritative sale guard.
    catalog: Object.entries(ITEMS)
      .filter(([id, it]) => !(it as { dropOnly?: boolean }).dropOnly
        || itemRows.some((row) => row.itemId === id && row.qty > 0))
      // A dark Workshop hides new materials, but pausing starts must not hide
      // inventory from a previously paid job (including collection while paused).
      .filter(([id, it]) => (it as { acquisition?: { type?: string } }).acquisition?.type !== 'craft'
        || forgeIngotsEnabled() || itemRows.some((row) => row.itemId === id && row.qty > 0))
      .map(([id, it]) => {
        // An unused tradable item and its activated benefit are different
        // state. Never infer activation from bag quantity (D-058/D-110).
        const hero = HERO_KEYS.find((key) => HEROES[key].recruitItemId === id);
        const effect = (it as ItemSpec).effect;
        const activation = hero ? {
          kind: 'hero' as const,
          active: heroView.heroes.some((row) => row.hero === hero && row.recruited),
          // Placement still honors the legacy wallet-stock fallback. Do not
          // merge it into deed inventory or offer it for sale from this base.
          availableContracts: (itemRows.find((row) => row.itemId === id)?.qty ?? 0)
            + (stableBaseId ? walletRows.find((row) => row.itemId === id)?.qty ?? 0 : 0),
        } : effect?.type === 'troop_unlock' && isEliteTroop(effect.troop) ? {
          kind: 'troop' as const, active: eliteUnlocks[effect.troop],
        } : undefined;
        return { id, ...it, paidPurchaseQuote: itemPurchaseQuote(it), ...(activation ? { activation } : {}) };
      }),
    owned: itemRows.filter((row) => row.qty > 0).map((row) => ({ itemId: row.itemId, qty: row.qty })),
    discovery: itemRows.filter((row) => row.seenAt !== null)
      .map((row) => ({ itemId: row.itemId, seenAt: row.seenAt!.toISOString() })),
    capacity: { used, max: INVENTORY.capacity, overflow: used > INVENTORY.capacity },
    heroLoadouts: heroLoadoutViews,
    // Deeds are authoritative stable-base/Core identities, never duplicated in
    // player_items. Inventory presents them as non-consumable assets while the
    // base selector remains the mutation/activation authority.
    deeds: (multiBaseEnabled()
      ? deedRows.flatMap((row) => row.assetId ? [{
        id: row.assetId, baseId: row.baseId, name: `EARTH LAND DEED · KEEP ${row.keepLevel}`,
        kind: 'deed' as const, asset: 'itm_deed_earth', status: row.status,
      }] : [])
      : p[0]?.deedAssetId ? [{
        id: p[0].deedAssetId, baseId: null, name: `EARTH LAND DEED · KEEP ${p[0].keepLevel}`,
        kind: 'deed' as const, asset: 'itm_deed_earth', status: 'active' as const,
      }] : []),
  };
}

async function assertAcquisitionGate(
  db: DbTx,
  wallet: string,
  spec: ItemSpec,
  keepLevel: number,
  baseId?: string,
): Promise<void> {
  const gate = spec.acquisition;
  if (gate.type === 'shop') return;
  if (gate.type === 'drop') throw new HttpError(422, 'this item is earned, not sold');
  // Crafted materials (E2-WORKSHOP-CONTRACT §2) enter base_items only through a
  // building job's collect; the system never sells them, at any price.
  if (gate.type === 'craft') throw new HttpError(422, 'this item is crafted, not sold');
  if (gate.type === 'keep_level') {
    if (keepLevel < gate.keepLevel) throw new HttpError(422, `requires Keep level ${gate.keepLevel}`);
    return;
  }
  const [stage] = baseId
    ? await db.select({ stars: baseCampaignProgress.bestStars }).from(baseCampaignProgress)
      .where(and(
        eq(baseCampaignProgress.baseId, baseId),
        eq(baseCampaignProgress.stage, gate.stage),
        gte(baseCampaignProgress.bestStars, 3),
      ))
    : await db.select({ stars: campaignProgress.bestStars }).from(campaignProgress)
      .where(and(
        eq(campaignProgress.playerWallet, wallet),
        eq(campaignProgress.stage, gate.stage),
        gte(campaignProgress.bestStars, 3),
      ));
  if (!stage) throw new HttpError(422, `requires 3 stars on campaign stage ${gate.stage}`);
  if (gate.requiresMaxHero) {
    const [maxHero] = baseId
      ? await db.select({ hero: baseHeroProgress.hero }).from(baseHeroProgress)
        .where(and(eq(baseHeroProgress.baseId, baseId), gte(baseHeroProgress.level, HERO_LEVELING.maxLevel)))
        .limit(1)
      : await db.select({ hero: heroLevels.hero }).from(heroLevels)
        .where(and(eq(heroLevels.playerWallet, wallet), gte(heroLevels.level, HERO_LEVELING.maxLevel)))
        .limit(1);
    if (!maxHero) throw new HttpError(422, `requires one level ${HERO_LEVELING.maxLevel} hero`);
  }
}

/** Buy a catalog item with KEEP. Consumables stack (+1 qty per purchase);
 *  gear respects maxOwned. Charge + grant commit atomically. */
export interface ItemMutationOpts {
  baseId?: string | undefined;
  authorizeBaseMutation?: ((tx: DbTx, wallet: string, baseId: string) => Promise<void>) | undefined;
}

function itemStableContext(opts: ItemMutationOpts): StableBaseMutationContext | undefined {
  return opts.baseId && opts.authorizeBaseMutation
    ? { baseId: opts.baseId, assertAuthority: opts.authorizeBaseMutation }
    : undefined;
}

export async function buyItem(
  db: Db, wallet: string, itemId: string, idempotencyKey: string,
  opts: ItemMutationOpts & { consent?: ItemPurchaseConsent | undefined } = {},
) {
  const request = itemPurchaseIntent(itemId, idempotencyKey, opts.baseId, opts.consent);
  const replay = await replayItemPurchase(db, wallet, request);
  if (replay) return replay;
  assertItemPurchaseScope(request, multiBaseEnabled());
  if (!isItemId(itemId)) throw new HttpError(404, 'unknown item', request ? 'ITEM_BUY_UNAVAILABLE' : undefined);
  const spec = ITEMS[itemId];
  // Drop-only items (e.g. the Warzone Aegis) are earned from the forge, never sold.
  if ((spec as { dropOnly?: boolean }).dropOnly) {
    throw new HttpError(422, 'this item is forged, not sold — win it from the Gold Forge', request ? 'ITEM_BUY_UNAVAILABLE' : undefined);
  }
  return db.transaction(async (tx) => {
    // The player row is the per-wallet acquisition lock. It serialises capacity,
    // max-owned and first-purchase rows even when player_items has no row yet.
    const [player] = await tx.select({ keepLevel: players.keepLevel }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    // Original acceptance wins even if a concurrent first purchase filled the
    // bag, consumed the item, or preceded an ownership/catalogue change.
    const lockedReplay = await replayItemPurchase(tx, wallet, request);
    if (lockedReplay) return lockedReplay;
    if (!player) throw new HttpError(404, 'player not found');
    let keepLevel = player.keepLevel;
    let stableBaseId: string | undefined;
    if (multiBaseEnabled()) {
      const context = itemStableContext(opts);
      if (!context) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
      const base = await lockStablePrerequisiteBase(tx, wallet, context);
      if (spec.acquisition.type === 'keep_level' && !base.landPaidAt) {
        throw new HttpError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');
      }
      stableBaseId = base.id;
      keepLevel = base.keepLevel;
    }
    if (request) {
      const quote = itemPurchaseQuote(spec);
      if (!quote) throw new HttpError(422, 'this item is not sold', 'ITEM_BUY_UNAVAILABLE');
      if ((stableBaseId ?? null) !== request.baseId || quote.catalogRevision !== request.consent.catalogRevision
        || BigInt(quote.maxCostKeep) > BigInt(request.consent.maxCostKeep))
        throw new HttpError(409, 'item catalogue or price changed; review again', 'ITEM_BUY_QUOTE_CHANGED');
    }
    try { await assertAcquisitionGate(tx, wallet, spec, keepLevel, stableBaseId); }
    catch (error) {
      if (request && error instanceof HttpError && error.statusCode === 422)
        throw new HttpError(422, error.message, 'ITEM_BUY_UNAVAILABLE');
      throw error;
    }

    // Charge first (throws on insufficient funds → whole tx rolls back), then
    // grant. A duplicate is returned BEFORE mutable capacity/max checks: a retry
    // remains successful even when its first grant filled the bag or maxOwned.
    // Key is NAMESPACED per wallet+op and the grant is GATED on a real charge
    // (security review 2026-07-24 #2): a reused key charges nothing, so it must
    // grant nothing — else retries stack free consumables and a cross-item
    // reuse buys a second item free.
    const posted = await spendGameCurrency(
      tx,
      wallet,
      BigInt(spec.costKeep),
      'item.buy',
      itemPurchaseLedgerKey(wallet, idempotencyKey, stableBaseId),
      { itemId, ...(stableBaseId ? { baseId: stableBaseId } : {}),
        ...(request ? { itemPurchase: { version: 1, request, result: { itemId, quantity: 1 } } } : {}) },
    );
    if (posted.duplicate) {
      const original = await itemPurchaseEvidence(tx, wallet, itemId, idempotencyKey, stableBaseId);
      if (!original) {
        throw new HttpError(409, 'idempotency key was already used for a different item');
      }
      // A duplicate reports the original actual amount, never today's price.
      return { itemId, costKeep: Number(original.amount), duplicate: true };
    }
    const rows = stableBaseId
      ? await tx.select({ itemId: baseItems.itemId, qty: baseItems.qty })
        .from(baseItems).where(eq(baseItems.baseId, stableBaseId))
      : await tx.select({ itemId: playerItems.itemId, qty: playerItems.qty })
        .from(playerItems).where(eq(playerItems.playerWallet, wallet));
    const equipment = stableBaseId
      ? await tx.select({ itemId: baseHeroEquipment.itemId }).from(baseHeroEquipment)
        .where(eq(baseHeroEquipment.baseId, stableBaseId))
      : await tx.select({ itemId: heroEquipment.itemId }).from(heroEquipment)
        .where(eq(heroEquipment.playerWallet, wallet));
    const current = rows.find((row) => row.itemId === itemId)?.qty ?? 0;
    if (spec.maxOwned !== null && current >= spec.maxOwned) {
      throw new HttpError(422, `maximum owned: ${spec.maxOwned}`, request ? 'ITEM_BUY_UNAVAILABLE' : undefined);
    }
    const used = inventoryUsage(rows, equipment);
    if (used > INVENTORY.capacity || used + spec.weight > INVENTORY.capacity) {
      throw new HttpError(422, `inventory full — ${used}/${INVENTORY.capacity} weight used`, request ? 'ITEM_BUY_UNAVAILABLE' : undefined);
    }
    // Provenance (D-152, E2-GEMS-CONTRACT §3): a Gems purchase is account-bound
    // (listItem refuses `shop_gems`), so the row records how it was paid. A
    // stack that already holds a shop_gems copy stays shop_gems whatever pays
    // for the next unit — the bound copy must not be laundered by a KEEP top-up.
    const acquiredVia = posted.currency === 'GEMS' ? 'shop_gems' : 'shop_keep';
    if (stableBaseId) {
      await tx.insert(baseItems).values({ baseId: stableBaseId, itemId, acquiredVia })
        .onConflictDoUpdate({
          target: [baseItems.baseId, baseItems.itemId],
          set: { qty: sql`${baseItems.qty} + 1`,
            acquiredVia: sql`CASE WHEN ${baseItems.acquiredVia} = 'shop_gems' THEN 'shop_gems' ELSE ${acquiredVia} END` },
        });
    } else {
      await tx.insert(playerItems).values({ playerWallet: wallet, itemId, acquiredVia })
        .onConflictDoUpdate({
          target: [playerItems.playerWallet, playerItems.itemId],
          set: { qty: sql`${playerItems.qty} + 1`,
            acquiredVia: sql`CASE WHEN ${playerItems.acquiredVia} = 'shop_gems' THEN 'shop_gems' ELSE ${acquiredVia} END` },
        });
    }
    return { itemId, costKeep: spec.costKeep, currency: posted.currency, duplicate: false };
  });
}

/**
 * USE one unit of a consumable: decrement qty atomically, then apply the
 * effect in the same transaction. Self-protecting on retries BECAUSE every
 * precondition is checked INSIDE the tx: an already-due job, or a warzone
 * shield you already hold, throws → the decrement rolls back with it, so a
 * refused use never costs the player the item.
 *
 * Double-SUBMITS are handled separately from retries: `idempotencyKey` claims a
 * row in `item_uses` inside the same transaction, so the same intent sent twice
 * consumes exactly one unit (E2, fixed 2026-07-26).
 */
export async function useItem(
  db: Db, wallet: string, itemId: string, idempotencyKey: string,
  opts: ItemMutationOpts & {
    jobId?: string | undefined;
  } = {}, now = new Date(),
) {
  if (!isItemId(itemId)) throw new HttpError(404, 'unknown item');
  const spec = ITEMS[itemId];
  // Hero contracts (D-058) are consumed by PLACING the hero's altar, never by
  // /items/use — recruitment needs the altar's 2×2 position, so the build tray
  // is the one consume path. Name that path instead of a generic refusal.
  if (Object.values(HEROES).some((hero) => hero.recruitItemId === itemId)) {
    throw new HttpError(422, 'a hero contract is used by placing the hero\'s altar (BUILD ▸ HEROES)');
  }
  // Widened read: hero contracts have no `effect` key at all, so the narrow
  // union type would reject the property access outright.
  const effect = (spec as ItemSpec).effect;
  if (spec.kind !== 'consumable' || !effect) throw new HttpError(422, 'item is not usable');
  let completedBaseId: string | undefined;

  const committed = await db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    let effectBaseId: string | undefined;
    if (multiBaseEnabled()) {
      const context = itemStableContext(opts);
      if (!context) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
      const base = await lockStablePrerequisiteBase(tx, wallet, context);
      effectBaseId = base.id;
      if (effect.type === 'finish_job') completedBaseId = base.id;
    }
    // Idempotency FIRST, inside the tx (E2, §4.3). The qty > 0 guard below stops
    // you spending units you don't own, but it cannot tell ONE intent submitted
    // twice from two real uses — and a unit is SOL-denominated value. Claiming
    // the key before the decrement means a duplicate conflicts here and rolls the
    // whole thing back, so a retry can never burn a second unit. Key is
    // NAMESPACED per wallet+op, matching buyItem's `item:${wallet}:${key}`.
    try {
      await tx.insert(itemUses).values({
        playerWallet: wallet,
        itemId,
        idempotencyKey: effectBaseId
          ? `use:${wallet}:${effectBaseId}:${idempotencyKey}`
          : `use:${wallet}:${idempotencyKey}`,
      });
    } catch (e) {
      // Drizzle wraps the pg error, so check the code on the error AND its cause,
      // plus the constraint name as a fallback (same shape as itemMarket.ts).
      const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      const msg = e instanceof Error ? e.message : '';
      if (code === '23505' || msg.includes('item_uses_idempotency_key_unique')) {
        throw new HttpError(409, 'duplicate use request — refresh your inventory');
      }
      throw e;
    }

    // Atomic take: qty > 0 guard means concurrent uses serialize on the row —
    // you can never consume more units than you own.
    const took = effectBaseId
      ? await tx.update(baseItems)
        .set({ qty: sql`${baseItems.qty} - 1` })
        .where(and(
          eq(baseItems.baseId, effectBaseId), eq(baseItems.itemId, itemId), gt(baseItems.qty, 0),
        ))
        .returning({ qty: baseItems.qty })
      : await tx.update(playerItems)
        .set({ qty: sql`${playerItems.qty} - 1` })
        .where(and(
          eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, itemId), gt(playerItems.qty, 0),
        ))
        .returning({ qty: playerItems.qty });
    if (took.length === 0) throw new HttpError(422, 'none left — buy one first');

    if (effect.type === 'finish_job') {
      // Target job: the caller's pick, or the SOONEST-finishing active job.
      // Eligibility (remaining ≤ bound) is enforced server-side — the bound is
      // what keeps consumables from bypassing the super-linear speed-up curve.
      const jobWhere = and(
        effectBaseId ? eq(builderJobs.baseId, effectBaseId) : eq(builderJobs.playerWallet, wallet),
        isNull(builderJobs.completedAt),
        ...(opts.jobId ? [eq(builderJobs.id, opts.jobId)] : []),
      );
      const [job] = await tx.select().from(builderJobs).where(jobWhere)
        .orderBy(asc(builderJobs.finishesAt)).limit(1);
      if (!job) throw new HttpError(422, 'no active build to finish');
      const remSec = Math.ceil((job.finishesAt.getTime() - now.getTime()) / 1000);
      // Job completion is LAZY (completeDueJobs runs post-commit and on /base polls),
      // so a row can sit finishesAt-in-the-past with completedAt still NULL. Without
      // this, USE happily "finishes" a build that was already completing for free and
      // destroys a 60-300 KEEP item for nothing — and a double-tap burned the second
      // unit the same way (security review 2026-07-26 F1). The throw rolls the qty
      // decrement back, so the refusal costs the player nothing.
      if (remSec <= 0) throw new HttpError(422, 'that build is already done — refresh your base');
      if (remSec > effect.maxRemainingSec) {
        throw new HttpError(422, `build has ${fmtDur(remSec)} left — this item finishes builds under ${fmtDur(effect.maxRemainingSec)}`);
      }
      await tx.update(builderJobs).set({ finishesAt: now }).where(eq(builderJobs.id, job.id));
      return {
        result: { used: itemId, left: took[0]!.qty, effect: { finishedJobId: job.id } },
        shieldMapValley: null,
      };
    }

    if (effect.type === 'troop_unlock') {
      // Permanent WALLET-scoped unlock (D-058). Refusing an already-unlocked
      // wallet INSIDE the tx rolls the qty decrement back — the writ is kept,
      // so the player can sell it on the market instead of burning it for
      // nothing (same self-protection rule as every other refused USE).
      const { grantTroopUnlock, hasTroopUnlock } = await import('./troopUnlocks');
      if (!isEliteTroop(effect.troop)) {
        throw new Error(`catalog bug: ${itemId} unlocks non-elite troop ${effect.troop}`);
      }
      if (await hasTroopUnlock(tx, wallet, effect.troop)) {
        throw new HttpError(422, `you can already train the ${effect.troop.toUpperCase()} — sell this writ on the market instead`);
      }
      // The grant must be REAL for the decrement to stand (security review
      // 2026-08-16 finding 3): the boot backfill runs pool-side with no player
      // lock, so a grandfather row can land between the check above and this
      // insert. onConflictDoNothing would then grant nothing while the writ —
      // market-sellable value — burned anyway; throwing rolls the qty back.
      const granted = await grantTroopUnlock(tx, wallet, effect.troop, 'item');
      if (!granted.granted) {
        throw new HttpError(422, `you can already train the ${effect.troop.toUpperCase()} — sell this writ on the market instead`);
      }
      return {
        result: { used: itemId, left: took[0]!.qty, effect: { troopUnlocked: effect.troop } },
        shieldMapValley: null,
      };
    }

    if (effect.type === 'raid_energy') {
      // grants purchasable energy (usable-cap re-enforced at spend, exactly
      // like the SOL purchase path).
      if (effectBaseId) {
        await tx.insert(baseProfiles).values({
          baseId: effectBaseId,
          purchasedEnergy: effect.amount,
        }).onConflictDoUpdate({
          target: baseProfiles.baseId,
          set: { purchasedEnergy: sql`${baseProfiles.purchasedEnergy} + ${effect.amount}`, updatedAt: now },
        });
      } else {
        const { grantPurchasedEnergy } = await import('./raids');
        for (let i = 0; i < effect.amount; i++) await grantPurchasedEnergy(tx, wallet);
      }
      return {
        result: { used: itemId, left: took[0]!.qty, effect: { energyGranted: effect.amount } },
        shieldMapValley: null,
      };
    }

    // warzone_shield — deploy a 48h WARZONE-source shield (the only protection
    // that holds during a warzone; outside one it protects like any shield). The
    // forge is the ONLY source (dropOnly), so this can't undercut the 10-SOL
    // warzone-shield sink at scale (one is forged a day, to a random contributor).
    const { grantWarzoneShield, hasActiveWarzoneShield } = await import('./warzoneShield');
    // NO STACKING (audit 2026-07-26): the SOL purchase path preflights this via
    // assertWarzoneShieldPurchasable, but this path granted unconditionally — so a
    // player already holding one could burn an 8 000-KEEP, one-forged-per-day relic
    // for a duplicate shields row that buys them nothing. Throwing here rolls the
    // whole tx back, INCLUDING the qty decrement above, so the relic is not lost.
    // Deliberately NOT reusing assertWarzoneShieldPurchasable: that also requires an
    // ACTIVE warzone, and using the relic outside one is intended (see above — it
    // then protects like any shield).
    if (await hasActiveWarzoneShield(tx, wallet, now, effectBaseId)) {
      throw new HttpError(422, 'you already have an active warzone shield — save this for when it lapses');
    }
    const { expiresAt } = await grantWarzoneShield(
      tx, wallet, now, effectBaseId, { deferMapInvalidation: true },
    );
    return {
      result: {
        used: itemId,
        left: took[0]!.qty,
        effect: { warzoneShieldUntil: expiresAt.toISOString() },
      },
      shieldMapValley: await shieldMapValleyId(tx, wallet, effectBaseId),
    };
  });

  invalidateShieldMapValley(committed.shieldMapValley);
  const result = committed.result;
  // Lazy completion AFTER commit (idempotent; the /base poll would do the same
  // on its next read) — completeDueJobs takes the pool handle, like speedupJob.
  if (effect.type === 'finish_job') {
    const { completeDueJobs } = await import('./base');
    await completeDueJobs(db, wallet, now, completedBaseId);
  }
  return result;
}

/** Clear an item's NEW marker. A qty-zero row deliberately persists discovery,
 * and later acquisition increments that same row instead of losing the marker. */
export async function markItemSeen(
  db: Db,
  wallet: string,
  itemId: string,
  now = new Date(),
  opts: ItemMutationOpts = {},
): Promise<{ itemId: ItemId; seenAt: string }> {
  if (!isItemId(itemId)) throw new HttpError(404, 'unknown item');
  await db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    if (multiBaseEnabled()) {
      const context = itemStableContext(opts);
      if (!context) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
      const base = await lockStablePrerequisiteBase(tx, wallet, context);
      await tx.insert(baseItems).values({ baseId: base.id, itemId, qty: 0, seenAt: now })
        .onConflictDoUpdate({
          target: [baseItems.baseId, baseItems.itemId],
          set: { seenAt: now },
        });
    } else {
      await tx.insert(playerItems).values({ playerWallet: wallet, itemId, qty: 0, seenAt: now })
        .onConflictDoUpdate({
          target: [playerItems.playerWallet, playerItems.itemId],
          set: { seenAt: now },
        });
    }
  });
  return { itemId, seenAt: now.toISOString() };
}

export interface EquipHeroItemResult {
  hero: HeroKey;
  slot: GearSlot;
  itemId: ItemId | null;
  version: number;
}

export interface EquipHeroItemOpts extends ItemMutationOpts {}

/** Equip/unequip one hero slot under player→item→loadout locks. The player
 * lock serialises two heroes competing for the same owned copy; expectedVersion
 * rejects every stale UI state. A same-state request at the current version is
 * a no-op and does not churn the version. */
export async function equipHeroItem(
  db: Db,
  wallet: string,
  hero: HeroKey,
  slot: GearSlot,
  itemId: string | null,
  expectedVersion: number,
  now = new Date(),
  opts: EquipHeroItemOpts = {},
): Promise<EquipHeroItemResult> {
  if (!(HERO_KEYS as readonly string[]).includes(hero)) throw new HttpError(404, 'unknown hero');
  if (!isGearSlot(slot)) throw new HttpError(404, 'unknown gear slot');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new HttpError(422, 'expectedVersion must be a non-negative integer');
  }
  if (itemId !== null) {
    if (!isItemId(itemId)) throw new HttpError(404, 'unknown item');
    const spec = ITEMS[itemId];
    if (spec.kind !== 'gear' || spec.slot !== slot) {
      throw new HttpError(422, `item does not fit ${slot}`);
    }
  }

  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');

    if (multiBaseEnabled()) {
      const context = itemStableContext(opts);
      if (!context) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
      const base = await lockStablePrerequisiteBase(tx, wallet, context);
      const { completeDueJobs } = await import('./base');
      await completeDueJobs(tx, wallet, now, base.id);
      if (itemId !== null) {
        const recruited = await recruitedHeroesOf(tx, wallet, base.id);
        if (!recruited.has(hero)) throw new HttpError(422, 'hero is not recruited');
      }

      let ownedQty = 0;
      if (itemId !== null) {
        const [owned] = await tx.select({ qty: baseItems.qty }).from(baseItems)
          .where(and(eq(baseItems.baseId, base.id), eq(baseItems.itemId, itemId)))
          .for('update');
        ownedQty = owned?.qty ?? 0;
        if (ownedQty <= 0) throw new HttpError(422, 'item not owned');
      }

      await tx.insert(baseHeroLoadouts).values({ baseId: base.id, hero }).onConflictDoNothing();
      const [loadout] = await tx.select({ version: baseHeroLoadouts.version }).from(baseHeroLoadouts)
        .where(and(eq(baseHeroLoadouts.baseId, base.id), eq(baseHeroLoadouts.hero, hero)))
        .for('update');
      if (!loadout) throw new Error('base loadout row disappeared after insert');
      const [current] = await tx.select({ itemId: baseHeroEquipment.itemId }).from(baseHeroEquipment)
        .where(and(
          eq(baseHeroEquipment.baseId, base.id),
          eq(baseHeroEquipment.hero, hero),
          eq(baseHeroEquipment.slot, slot),
        ));
      const currentItemId = current?.itemId ?? null;
      if (loadout.version !== expectedVersion) {
        throw new HttpError(409, `loadout changed — expected version ${expectedVersion}, current ${loadout.version}`);
      }
      if (currentItemId === itemId) {
        return { hero, slot, itemId: itemId as ItemId | null, version: loadout.version };
      }
      if (itemId !== null) {
        const rows = await tx.select({ hero: baseHeroEquipment.hero }).from(baseHeroEquipment)
          .where(and(eq(baseHeroEquipment.baseId, base.id), eq(baseHeroEquipment.itemId, itemId)));
        if (rows.length >= ownedQty) throw new HttpError(422, 'all owned copies are already equipped');
      }
      if (itemId === null) {
        await tx.delete(baseHeroEquipment).where(and(
          eq(baseHeroEquipment.baseId, base.id),
          eq(baseHeroEquipment.hero, hero),
          eq(baseHeroEquipment.slot, slot),
        ));
      } else {
        await tx.insert(baseHeroEquipment).values({
          baseId: base.id, hero, slot, itemId, equippedAt: now,
        }).onConflictDoUpdate({
          target: [baseHeroEquipment.baseId, baseHeroEquipment.hero, baseHeroEquipment.slot],
          set: { itemId, equippedAt: now },
        });
      }
      const [updated] = await tx.update(baseHeroLoadouts)
        .set({ version: sql`${baseHeroLoadouts.version} + 1`, updatedAt: now })
        .where(and(eq(baseHeroLoadouts.baseId, base.id), eq(baseHeroLoadouts.hero, hero)))
        .returning({ version: baseHeroLoadouts.version });
      return { hero, slot, itemId: itemId as ItemId | null, version: updated!.version };
    }

    if (itemId !== null) {
      const { completeDueJobs } = await import('./base');
      await completeDueJobs(tx, wallet, now);
      const recruited = await recruitedHeroesOf(tx, wallet);
      if (!recruited.has(hero)) throw new HttpError(422, 'hero is not recruited');
    }

    let ownedQty = 0;
    if (itemId !== null) {
      const [owned] = await tx.select({ qty: playerItems.qty }).from(playerItems)
        .where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, itemId)))
        .for('update');
      ownedQty = owned?.qty ?? 0;
      if (ownedQty <= 0) throw new HttpError(422, 'item not owned');
    }

    await tx.insert(heroLoadouts).values({ playerWallet: wallet, hero })
      .onConflictDoNothing();
    const [loadout] = await tx.select({ version: heroLoadouts.version }).from(heroLoadouts)
      .where(and(eq(heroLoadouts.playerWallet, wallet), eq(heroLoadouts.hero, hero)))
      .for('update');
    if (!loadout) throw new Error('loadout row disappeared after insert');
    const [current] = await tx.select({ itemId: heroEquipment.itemId }).from(heroEquipment)
      .where(and(
        eq(heroEquipment.playerWallet, wallet),
        eq(heroEquipment.hero, hero),
        eq(heroEquipment.slot, slot),
      ));
    const currentItemId = current?.itemId ?? null;
    if (loadout.version !== expectedVersion) {
      throw new HttpError(409, `loadout changed — expected version ${expectedVersion}, current ${loadout.version}`);
    }
    if (currentItemId === itemId) {
      return { hero, slot, itemId: itemId as ItemId | null, version: loadout.version };
    }

    if (itemId !== null) {
      const rows = await tx.select({ hero: heroEquipment.hero }).from(heroEquipment)
        .where(and(eq(heroEquipment.playerWallet, wallet), eq(heroEquipment.itemId, itemId)));
      if (rows.length >= ownedQty) throw new HttpError(422, 'all owned copies are already equipped');
    }

    if (itemId === null) {
      await tx.delete(heroEquipment).where(and(
        eq(heroEquipment.playerWallet, wallet),
        eq(heroEquipment.hero, hero),
        eq(heroEquipment.slot, slot),
      ));
    } else {
      await tx.insert(heroEquipment).values({ playerWallet: wallet, hero, slot, itemId, equippedAt: now })
        .onConflictDoUpdate({
          target: [heroEquipment.playerWallet, heroEquipment.hero, heroEquipment.slot],
          set: { itemId, equippedAt: now },
        });
    }
    const [updated] = await tx.update(heroLoadouts)
      .set({ version: sql`${heroLoadouts.version} + 1`, updatedAt: now })
      .where(and(eq(heroLoadouts.playerWallet, wallet), eq(heroLoadouts.hero, hero)))
      .returning({ version: heroLoadouts.version });
    return { hero, slot, itemId: itemId as ItemId | null, version: updated!.version };
  });
}
