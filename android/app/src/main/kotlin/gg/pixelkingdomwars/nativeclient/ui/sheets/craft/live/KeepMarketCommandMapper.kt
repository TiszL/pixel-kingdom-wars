package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.charter.charterText
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketRecord
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketState
import gg.pixelkingdomwars.nativeclient.data.longValueExactCompat
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketCatalogue
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.phasee.keepMarketAmount
import gg.pixelkingdomwars.nativeclient.ui.phasee.keepMarketName
import gg.pixelkingdomwars.nativeclient.ui.phasee.keepMarketPrice
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CHECKING_TEXT
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftItemUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftLiveUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftPrimaryUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketBuyUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketOfferUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketSellUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.PrimaryAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SellableUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.StallPlaceState
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.StallPlaceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.busyPrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.buyBounds
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.buyPrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.formatUnits
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.offPrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.sellPrimary
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/*
 * The pure decisions of the KEEP Market sheet's command mode (craft/SPEC.md §3.1–3.4, §5, E1.1; frames market-buy,
 * market-seal, market-sell, market-orders, market-owned). The sheet performs BUY's reservation, LIST and TAKE BACK in
 * place by calling the EXISTING owner (KeepEquipmentMarketViewModel buy / list / cancel, then confirm from the designed
 * Seal); nothing here signs, submits or pays. Wallet payment (prepare, review, approve with the seller-account rent-cap
 * consent, send), MFA, held evidence and saved-request recovery stay on the original KeepEquipmentMarketScreen, because
 * that consent and recovery wording lives only there. No Compose. JVM-tested in `KeepMarketCommandMapperTest`.
 *
 * Every amount is the server's (listing rows, the KEEP policy, kingdom stock); no price, tick, fee or cap is a client
 * number. The KEEP policy has no price tick, so the price is typed and validated by the owner's own `keepMarketPrice`.
 */

/** BUY needs a kingdom to deliver to; listing and taking back need the kingdom the stock lives in (existing wording). */
internal const val KEEP_MARKET_NO_KINGDOM = "Select a deeded kingdom to list or buy."
/** A read-only base or a paused content pack (the same sentence the Seal and SPEC §5 use). */
internal const val KEEP_MARKET_PAUSED = "Orders are paused on this base."
/** A saved request blocks a new one of its kind until it is checked (commonGate's sentence). */
internal const val KEEP_MARKET_WAITING = "Check the request from earlier first."
/** The owner refuses a fill without its installed wallet trust (KeepEquipmentMarketScreen, SPEC §3.1). */
internal const val KEEP_MARKET_NO_PAYMENTS = "Wallet payments are not available in this build."
/** The owner's own refusal for a quantity outside the lot's bounds (KeepEquipmentMarketRepository.reviewFill). */
internal const val KEEP_MARKET_QUANTITY = "Choose an available quantity that meets the minimum payment"

/** What the KEEP Home body hands the projection in command mode. [priceText] is the typed PRICE EACH, as typed. */
internal data class KeepMarketCommandContext(val configured: Boolean, val allowed: Boolean, val priceText: String = "")

// ------------------------------------------------------------------------------------------------- which presentation

/** A record whose next step is wallet payment or evidence checking: the original owner screen shows it, because the
 *  payment consent (incl. the seller-account rent cap) and the held/recovery wording live only there. */
internal fun keepMarketRecordForcesOriginal(r: KeepEquipmentMarketRecord): Boolean =
    !r.discardedUnsent && (r.held || r.signed != null || r.consent != null || (r.kind == "fill" && r.response != null))

/** A saved request with no server answer yet (an unsent draft after the Seal's BACK, or a lost answer). It blocks a new
 *  request of its kind for the same kingdom (KeepEquipmentMarketStore.begin), so the sheet shows the SPEC §5 recovery
 *  row and its CHECK opens the original owner, where REVIEW / RETRY / CLOSE UNSENT DRAFT live. */
internal fun keepMarketRecordWaiting(r: KeepEquipmentMarketRecord): Boolean =
    !r.discardedUnsent && !r.held && r.response == null

/**
 * A completed listing or return (terminal for the store: it has its server answer). Branch taken for SPEC decision (C),
 * after reading KeepEquipmentMarketStore.begin: a terminal record does NOT block a new review of its kind, BUT every
 * pending record holds one of the journal's limited places ("Saved market journal is full. Archive completed records
 * first") and the RECEIPTS screen has no archive control. So completed records keep the designed sheet, and the
 * SELECTED one (the request just finished here, or one opened by CHECK ORIGINAL RECEIPT in RECEIPTS) gets a designed
 * row with the existing ARCHIVE COMPLETED RECORD button; nothing is archived without that tap.
 */
internal fun keepMarketRecordCompleted(r: KeepEquipmentMarketRecord): Boolean =
    !r.discardedUnsent && !r.held && r.kind != "fill" && r.response != null

/** The command review the designed Seal may show: no evidence of a send, consent or payment review. While the
 *  repository has not yet republished its journal, the Seal waits (`keepMarketFreshCommandReview`), never the original. */
internal fun keepMarketReviewWithoutEvidence(state: KeepEquipmentMarketState): Boolean {
    val r = state.commandReview ?: return false
    return state.paymentReview == null && r.response == null && r.attempts.isEmpty() && r.signed == null &&
        r.consent == null && !r.held && !r.discardedUnsent
}

/** The saved-record facts the sheet presents: whether the original must show, the waiting request, the completed one. */
internal data class KeepMarketSavedRecords(
    val forcesOriginal: Boolean,
    val waiting: KeepEquipmentMarketRecord?,
    val completed: KeepEquipmentMarketRecord?,
)

/** Pending records decide (archived ones are settled history); the command review on screen is the Seal's, not a
 *  waiting request. Any saved purchase (fill) with a server answer keeps the original owner, exactly as before. */
internal fun keepMarketSavedRecords(state: KeepEquipmentMarketState): KeepMarketSavedRecords {
    val pending = state.journal?.pending.orEmpty()
    val review = state.commandReview
    val others = pending.filter { it.key != review?.key }
    val forces = state.paymentReview != null || others.any(::keepMarketRecordForcesOriginal) ||
        review?.let(::keepMarketRecordForcesOriginal) == true
    val waiting = others.firstOrNull { it.key == state.selectedKey && keepMarketRecordWaiting(it) }
        ?: others.firstOrNull(::keepMarketRecordWaiting)
    val completed = others.firstOrNull { it.key == state.selectedKey && keepMarketRecordCompleted(it) }
    return KeepMarketSavedRecords(forces, waiting, completed)
}

// ---------------------------------------------------------------------------------------------------------- the entry

/** Where `FleetCommandOwner.openEntry` opens the sheet: "BUY", "SELL" or "SELL:<itemId>"; anything else opens BUY. */
internal data class KeepMarketEntry(val tab: String, val itemId: String?)

internal fun keepMarketEntry(entry: String?): KeepMarketEntry = when {
    entry == "SELL" -> KeepMarketEntry(MarketTab.SELL, null)
    entry != null && entry.startsWith("SELL:") ->
        KeepMarketEntry(MarketTab.SELL, entry.removePrefix("SELL:").takeIf { it in KeepEquipmentMarketCatalogue.itemIds })
    else -> KeepMarketEntry(MarketTab.BUY, null)
}

// ------------------------------------------------------------------------------------------------------------ gating

/** Why a new KEEP command cannot start now; null = it can. The owner re-checks every one of these itself. */
internal fun keepMarketCommandBlock(selectedBase: String?, allowed: Boolean, waiting: Boolean): String? = when {
    selectedBase == null -> KEEP_MARKET_NO_KINGDOM
    !allowed -> KEEP_MARKET_PAUSED
    waiting -> KEEP_MARKET_WAITING
    else -> null
}

/** The BUY primary in command mode: the designed [buyPrimary] (link wallet, payments unavailable, money stages, errors)
 *  first; then busy dots while the owner works; then the command [block] as an X with its reason. */
internal fun keepMarketBuyPrimary(buy: MarketBuyUi, block: String?, busy: Boolean): CraftPrimaryUi? {
    val primary = buyPrimary(buy) ?: return null
    if (primary.action != PrimaryAction.START) return primary
    if (busy) return busyPrimary(CHECKING_TEXT)
    return block?.let { offPrimary(primary.label, primary.sub, it) } ?: primary
}

/** The SELL primary in command mode: the designed [sellPrimary] (loading, no deeded kingdom, none left, no price) first,
 *  then the command [block]. */
internal fun keepMarketSellPrimary(sell: MarketSellUi, block: String?): CraftPrimaryUi? {
    val primary = sellPrimary(sell) ?: return null
    if (primary.action != PrimaryAction.START) return primary
    return block?.let { offPrimary(primary.label, primary.sub, it) } ?: primary
}

/** The raw listing row the owner reviews against (it re-reads the listing from the server before saving anything). */
internal fun keepMarketRawListing(state: KeepEquipmentMarketState, listingId: String): JsonObject? =
    runCatching { state.listings?.getValue("items")?.jsonArray?.map { it.jsonObject }?.firstOrNull { it.charterText("id") == listingId } }.getOrNull()

/** BUY n: null when the reservation review may start; otherwise the sentence the tap shows. The quantity must lie in
 *  the bounds `keepOfferUi` derived from the server's minimum fill and the lot's available units. */
internal fun keepMarketBuyRefusal(
    offer: MarketOfferUi?, quantity: Long, raw: JsonObject?, selectedBase: String?, allowed: Boolean, configured: Boolean,
    idle: Boolean, waiting: Boolean,
): String? {
    if (!configured) return KEEP_MARKET_NO_PAYMENTS
    keepMarketCommandBlock(selectedBase, allowed, waiting)?.let { return it }
    if (!idle) return CHECKING_TEXT
    if (offer == null || raw == null || offer.isMine || offer.currency != Currency.KEEP) return KEEP_MARKET_QUANTITY
    val (min, max) = buyBounds(offer)
    return if (quantity in min..max) null else KEEP_MARKET_QUANTITY
}

/** LIST n: null when the listing review may start ([units] is the typed price in base units). */
internal fun keepMarketListRefusal(
    stock: SellableUi?, quantity: Long, units: String?, listingAllowed: Boolean, allowed: Boolean, idle: Boolean, waiting: Boolean,
): String? {
    if (!listingAllowed) return "Pick a kingdom you own to list."
    if (!allowed) return KEEP_MARKET_PAUSED
    if (waiting) return KEEP_MARKET_WAITING
    if (!idle) return CHECKING_TEXT
    val available = stock?.available ?: return "None left to list."
    if (quantity < 1L || quantity > available) return "None left to list."
    return if (units == null) "Set a price first." else null
}

/** TAKE BACK: only this kingdom's own unreserved units, through the owner's return review (RETURN Seal). */
internal fun keepMarketTakeBackRefusal(
    raw: JsonObject?, selectedBase: String?, wallet: String, allowed: Boolean, idle: Boolean, waiting: Boolean,
): String? {
    keepMarketCommandBlock(selectedBase, allowed, waiting)?.let { return it }
    if (!idle) return CHECKING_TEXT
    // The row left the current page (a refresh is due); nothing is sent without the server's own row.
    val row = raw ?: return CHECKING_TEXT
    val own = runCatching { row.charterText("sellerBaseId") == selectedBase && row.charterText("sellerWallet") == wallet }.getOrDefault(false)
    if (!own) return "Your listing · open the original kingdom to manage it."
    val available = runCatching { row.charterText("availableQuantity").toBigInteger() }.getOrNull()
    return if (available != null && available.signum() > 0) null else "A sale in progress can't be taken back."
}

// --------------------------------------------------------------------------------------------------------- the price

/** The typed PRICE EACH filter (the original owner's: digits and one decimal point, at most 40 characters). */
internal fun keepMarketPriceInput(text: String): Boolean =
    text.length <= 40 && text.all { it.isDigit() || it == '.' } && text.count { it == '.' } <= 1

/** The typed price in base units as the owner submits it (`keepMarketPrice`: positive, exact at [decimals], ≤ 64 bits);
 *  null for empty, zero, negative, over-precise or oversized input. */
internal fun keepMarketTypedPriceUnits(text: String, decimals: Int?): String? =
    decimals?.let { d -> keepMarketPrice(text.trim(), d) }?.takeIf { it.toLongOrNull() != null }

/** The same price as the sheet's signed Long base units (the earnings line and LIST sub); null when it cannot be one. */
internal fun keepMarketTypedPrice(text: String, decimals: Int?): Long? = keepMarketTypedPriceUnits(text, decimals)?.toLongOrNull()

// ------------------------------------------------------------------------------------------------------ projections

/** Catalogue names for the KEEP market's items (drawn names, never ids; no number is involved). */
internal fun keepMarketCraftItems(): Map<String, CraftItemUi> =
    KeepEquipmentMarketCatalogue.itemIds.associateWith { id -> CraftItemUi(id, keepMarketName(id), craftItemIcon(id), "") }

/** SELL lists every positively held stock unit of the selected kingdom (the frame's stores strip mixes categories). */
internal fun keepMarketSellable(held: Map<String, Long>): List<SellableUi> =
    held.filterValues { it > 0L }.map { (id, available) -> SellableUi(id, available, null) }

/** True when the listings page is the whole book of its category (no next cursor). */
internal fun keepMarketBookComplete(listings: JsonObject?): Boolean =
    listings != null && (listings["nextCursor"] == null || listings["nextCursor"] == JsonNull)

/** The header's live sentence: "{n} lots listed" for the category the sheet shows, only when its book is complete. */
internal fun keepMarketLotsLive(lots: Int?): CraftLiveUi? =
    lots?.let { CraftLiveUi("ui:queue-status", "$it ${if (it == 1) "lot" else "lots"} listed") }

/** "Others sell it for about 1.8": the cheapest other seller's unit price of [itemId] on the current page; null when
 *  nobody else lists it there (the tag hides). Rounded up like every price a buyer pays. */
internal fun keepMarketOthersPrice(listings: JsonObject?, itemId: String?, wallet: String, decimals: Int?): String? {
    if (itemId == null || decimals == null) return null
    val rows = runCatching { listings?.getValue("items")?.jsonArray?.map { it.jsonObject } }.getOrNull().orEmpty()
    val cheapest = rows.mapNotNull { row ->
        runCatching {
            row.takeIf { it.charterText("itemId") == itemId && it.charterText("sellerWallet") != wallet }
                ?.charterText("unitPriceBaseUnits")?.toBigInteger()?.longValueExactCompat()?.takeIf { it > 0L }
        }.getOrNull()
    }.minOrNull() ?: return null
    return formatUnits(cheapest, decimals, roundUp = true)
}

/**
 * OFFERS (market-orders.png): this kingdom's own lots on the current listings page, as ON THE TABLE places with the
 * backpack BACK. Only rows whose seller is this wallet AND this kingdom are places (the owner returns stock only to the
 * kingdom it came from). "4 of 10 sold" is not provable here (reservedQuantity also counts buyers still paying), so the
 * line names reservations; a row with no free units is not drawn (it cannot be taken back). [block] disables BACK with
 * its reason.
 */
internal fun keepMarketOfferPlaces(
    listings: JsonObject?, decimals: Int?, selectedBase: String?, wallet: String, block: String?,
): List<StallPlaceUi> {
    if (decimals == null || selectedBase == null) return emptyList()
    val rows = runCatching { listings?.getValue("items")?.jsonArray?.map { it.jsonObject } }.getOrNull().orEmpty()
    return rows.mapNotNull { row ->
        runCatching {
            if (row.charterText("sellerBaseId") != selectedBase || row.charterText("sellerWallet") != wallet) return@runCatching null
            val item = row.charterText("itemId")
            val listed = row.charterText("quantity").toBigInteger()
            val available = row.charterText("availableQuantity").toBigInteger()
            val reserved = row.charterText("reservedQuantity").toBigInteger()
            if (available.signum() <= 0) return@runCatching null
            val price = PriceUi(Currency.KEEP, keepMarketAmount(row.charterText("unitPriceBaseUnits"), decimals), PriceStatus.OK)
            val back = CommandUi(FeatureId("market.trade"), "backpack", "BACK", null, false,
                if (block == null) CommandState.ENABLED else CommandState.DISABLED, block, null)
            StallPlaceUi(keepMarketName(item), craftItemIcon(item), "x$available", price, StallPlaceState.ON_TABLE,
                if (reserved.signum() == 0) "none yet" else "$reserved of $listed reserved", back, listingId = row.charterText("id"))
        }.getOrNull()
    }
}
