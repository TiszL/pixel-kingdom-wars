package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * The pure rules of the craft cluster's round-2 frames (design/final/craft/SPEC.md "Round 2 additions (2026-10-03)" and
 * "Round 2 critic fixes (2026-10-03, second pass)"): Market OWNED (market-owned.png), the SOL stall (market-sol.png),
 * OFFERS as a stall (market-orders.png, re-done), SELL with the realm's cut (market-sell.png, re-done) and Harvester
 * HISTORY (harvester-history.png). No Compose. JVM-tested in `CraftR2LogicTest`.
 *
 * Money copy (design correction 7): only an authoritative refusal may say nothing was spent; an uncertain result says it
 * is being checked and keeps CHECK on screen.
 */

// ------------------------------------------------------------------------------------------------------------------ tabs

/**
 * The Market's round-2 stacked tabs: BUY · SELL · OFFERS · OWNED. The registry / Destination ids are unchanged
 * (`MarketTab.ORDERS` = "MY ORDERS", `MarketTab.OWNED` = "COLLECTION"); only the visible word of the third tab is OFFERS
 * ("an order is your offer", SPEC Part two). OFFERS carries the green "!" when a lot sold since the last visit.
 */
fun marketTabsR2(soldSinceLastVisit: Boolean = false): List<TabUi> =
    marketTabs(soldSinceLastVisit).map { if (it.id == MarketTab.ORDERS) it.copy(label = "OFFERS") else it }

/** The BUY section id of the SOL stall (`Destination.Market(BUY, section = "sol")`, registry row 77). */
const val SOL_STALL_SECTION = "sol"

// ----------------------------------------------------------------------------------------------------------------- OWNED

/** The right-hand tag of an OwnedRow (SPEC E1.1): text and verb, or null while a listing is being made (stone dots). */
fun ownedTag(state: OwnedState): Pair<String, Verb>? = when (state) {
    OwnedState.CAN_SELL, OwnedState.OUTSIDE_ONLY -> "CAN SELL" to Verb.GREEN
    OwnedState.IN_USE -> "IN USE" to Verb.STONE
    OwnedState.INSTALLED -> "INSTALLED" to Verb.STONE
    OwnedState.ON_SALE -> "ON SALE" to Verb.BLUE
    OwnedState.LISTING -> null
}

/** Where the OWNED primary goes for the selected row. */
enum class OwnedRoute {
    /** SELL tab in SOL mode with the price stepper (`onSell`). */
    SELL,
    /** The deed trades only on outside marketplaces: the system browser (`onOpenOutside`). */
    OPEN_OUTSIDE,
    /** Nothing to sell here: show the reason ([ownedReason]). */
    EXPLAIN,
}

/** The OWNED primary's route for the selected row's [state] (null = nothing selected). */
fun ownedRoute(state: OwnedState?): OwnedRoute = when (state) {
    OwnedState.CAN_SELL -> OwnedRoute.SELL
    OwnedState.OUTSIDE_ONLY -> OwnedRoute.OPEN_OUTSIDE
    else -> OwnedRoute.EXPLAIN
}

/** Why the selected row cannot be sold from here (SPEC E1.1 tags: the home deed, an applied awning, an installed vehicle). */
fun ownedReason(state: OwnedState?): String? = when (state) {
    null -> "Choose something to sell first."
    OwnedState.IN_USE -> "It is in use, so it can't be sold."
    OwnedState.INSTALLED -> "It is installed at the Berth. Take it out to sell."
    OwnedState.ON_SALE -> "It is already on your stall. See OFFERS."
    OwnedState.LISTING -> "It is being put on your stall."
    OwnedState.CAN_SELL, OwnedState.OUTSIDE_ONLY -> null
}

/** True when OWNED shows its EmptyState: nothing in the stores and nothing in a linked wallet, and not loading. */
fun ownedIsEmpty(ui: OwnedUi): Boolean =
    ui.load !is CraftHydration.Loading && ui.stores.isEmpty() && (!ui.walletLinked || ui.wallet.isEmpty())

// ------------------------------------------------------------------------------------------------------------- SOL stall

/** What the SOL stall's footer primary does. */
enum class SolAction { BUY, LINK_WALLET, NEED_MORE, CHECK, RETRY, EXPLAIN, NONE }

/** The SOL stall primary's look and route. */
data class SolPrimary(val label: String, val sub: String?, val verb: Verb, val state: CommandState, val reason: String?, val action: SolAction)

/** The selected lot, or the first one (the server orders them). */
fun selectedSolLot(ui: SolStallUi): SolLotUi? = ui.lots.firstOrNull { it.id == ui.selected } ?: ui.lots.firstOrNull()

/**
 * The SOL stall's footer primary (SPEC E1.2 states): no wallet → LOCKED "Link a wallet to buy"; the money sequence
 * (Check wallet → Sending → moss BOUGHT after the receipt); an uncertain result → stone CHECK, never a fresh BUY; an
 * authoritative refusal → red RETRY; a SHORT price → Need-more; UNAVAILABLE → disabled; a CHECKING price stays enabled
 * navigation (the Seal re-quotes). Null = nothing to buy (closed stall, no lots).
 */
fun solBuyPrimary(ui: SolStallUi): SolPrimary? {
    if (!ui.available) return null
    val lot = selectedSolLot(ui) ?: return null
    val price = priceText(lot.price)
    val sub = if (lot.price.status == PriceStatus.UNAVAILABLE) "${lot.name} · price unavailable" else "${lot.name} · $price ${currencyName(Currency.SOL)}"
    when (ui.stage) {
        MoneyStage.CHECK_WALLET -> return SolPrimary("Check wallet", null, Verb.STONE, CommandState.BUSY, null, SolAction.NONE)
        MoneyStage.SENDING -> return SolPrimary("Sending", null, Verb.STONE, CommandState.BUSY, null, SolAction.NONE)
        MoneyStage.SENT -> return SolPrimary("BOUGHT", null, Verb.MOSS, CommandState.ENABLED, null, SolAction.NONE)
        MoneyStage.FAILED -> {
            val outcome = ui.outcome
            return if (outcome != null && outcome.authoritative) SolPrimary("RETRY", sub, Verb.RED, CommandState.ENABLED, null, SolAction.RETRY)
            // Not known to be a refusal: it is being checked. Offer the by-key CHECK, never a second payment.
            else SolPrimary("CHECK", null, Verb.STONE, CommandState.ENABLED, null, SolAction.CHECK)
        }
        MoneyStage.READY -> Unit
    }
    if (!ui.walletLinked) return SolPrimary("Link a wallet to buy", null, Verb.CHARCOAL, CommandState.LOCKED, null, SolAction.LINK_WALLET)
    return when (lot.price.status) {
        PriceStatus.SHORT -> SolPrimary("BUY", sub, Verb.GOLD, CommandState.SHORT, null, SolAction.NEED_MORE)
        PriceStatus.UNAVAILABLE -> SolPrimary("BUY", sub, Verb.GOLD, CommandState.DISABLED, "The price is unavailable right now.", SolAction.EXPLAIN)
        else -> SolPrimary("BUY", sub, Verb.GOLD, CommandState.ENABLED, null, SolAction.BUY)
    }
}

/** The line under the SOL stall primary for an outcome (SPEC E1.2): the refusal sentence, or "Being checked · …". */
fun solOutcomeLine(outcome: SolOutcomeUi?): String? = when {
    outcome == null -> null
    outcome.authoritative -> outcome.line
    else -> "Being checked · ${outcome.line.removePrefix("Being checked · ")}"
}

/** "5% of the price, taken from the seller's share." from the server's fee basis points (never a client constant). */
fun realmCutOfPrice(feeBps: Int?): String = "${feePercent(feeBps)} of the price, taken from the seller's share."

/**
 * The SOL stall BUY Seal (SPEC E1.2; market-sol.png): pay SOL → get the vehicle, the seller line, the realm's cut in a
 * cream fine-print box (the only place it appears), "Paid from your wallet. You sign once." and BUY with the price on
 * its face. It is raised before any wallet step; [armedAtMs] = when the quote landed (a CHECKING price waits).
 */
fun solBuySeal(lot: SolLotUi, feeBps: Int?, armedAtMs: Long): MarketSealUi {
    val price = priceText(lot.price)
    return MarketSealUi(
        title = "BUY ${lot.name.uppercase(Locale.US)}",
        pay = SealSideUi("sol", 48, price, currencyName(Currency.SOL), "Pay $price SOL"),
        gets = SealSideUi(lot.art, 56, lot.tier, lot.tripsLeft, "Get ${lot.name}"),
        lines = listOf("From ${lot.seller}. It goes to your wallet; install it at the Berth."),
        finePrint = MarketFinePrintUi("ui:market-menu", "The realm's cut:", realmCutOfPrice(feeBps)),
        note = "Paid from your wallet. You sign once.",
        confirmLabel = "BUY",
        confirmSub = "$price SOL",
        armedAtMs = armedAtMs,
        quoteReady = lot.price.status == PriceStatus.OK,
    )
}

// ---------------------------------------------------------------------------------------------------------- OFFERS (stall)

/** A free place of the stall grid (dashed, plus, "Free place / from SELL"). */
fun freeStallPlace(index: Int): StallPlaceUi =
    StallPlaceUi("", "shape:plus", "", null, StallPlaceState.FREE, "Free place", null, listingId = "free-$index")

/**
 * The stall grid (SPEC Part two: two rows of three places, each row on a wooden counter): the server's taken places
 * first, then FREE places up to [maxPlaces]; with no server limit only the FREE places the server listed are shown.
 * The last row is padded with null (no place drawn), never with an invented free place.
 */
fun stallGrid(places: List<StallPlaceUi>, maxPlaces: Int?, perRow: Int = 3): List<List<StallPlaceUi?>> {
    val taken = places.filter { it.state != StallPlaceState.FREE }
    val free = if (maxPlaces != null) (maxPlaces - taken.size).coerceAtLeast(0) else places.count { it.state == StallPlaceState.FREE }
    val all = taken + List(free) { freeStallPlace(it) }
    if (all.isEmpty()) return emptyList()
    val n = perRow.coerceAtLeast(1)
    return all.chunked(n).map { row -> row + List(n - row.size) { null } }
}

/** "2 free places" / "1 free place" / "…" (unknown is never 0). */
fun freePlacesLine(freePlaces: Int?): String = when (freePlaces) {
    null -> "$UNKNOWN free places"
    1 -> "1 free place"
    else -> "$freePlaces free places"
}

/** The OFFERS primary (SPEC Part two footer): gold SELL MORE with the free places; off when every place is taken. */
fun offersPrimary(ui: MarketOffersUi): CraftPrimaryUi = when {
    ui.load is CraftHydration.Error -> CraftPrimaryUi("Try again", null, CommandState.ENABLED, Verb.STONE, null, null, PrimaryAction.RETRY)
    ui.freePlaces == 0 -> CraftPrimaryUi("SELL MORE", freePlacesLine(0), CommandState.DISABLED, Verb.GOLD,
        "Every place is taken. Take one back first.", null, PrimaryAction.SHAKE)
    else -> CraftPrimaryUi("SELL MORE", freePlacesLine(ui.freePlaces), CommandState.ENABLED, Verb.GOLD, null, null, PrimaryAction.OPEN_SELL)
}

/** The OFFERS footnote: a sale being paid can't be taken back. */
fun offersFootnote(places: List<StallPlaceUi>): String =
    if (places.any { it.state == StallPlaceState.PAYING }) "A sale in progress can't be taken back." else "Take back unsold offers any time."

/** True when every place is FREE (or none is known yet): "Nothing on your stall yet". */
fun stallIsEmpty(ui: MarketOffersUi): Boolean = ui.load !is CraftHydration.Loading && ui.places.none { it.state != StallPlaceState.FREE }

// --------------------------------------------------------------------------------------------------------- SELL (re-done)

/**
 * The earnings card (critic fix): "You get 18 KEEP" and "the realm's cut is 1 of 19". The mapper sends both lines
 * server-formatted ([MarketSellV2Ui.earnLine], [MarketSellV2Ui.cutLine]); while it has not, they are derived from the
 * server's feeBps with [sellProceeds] (the fee rounds up, so "You get" never flatters). Unknown parts read "…".
 */
fun realmCutLines(ui: MarketSellV2Ui): Pair<String, String> {
    val sell = ui.sell
    val unit = currencyName(sell.currency)
    val p = sellProceeds(sellQuantity(sell), sell.unitPrice, sell.feeBps)
    val earn = ui.earnLine ?: "You get ${formatUnits(p?.net, sell.decimals)} $unit"
    val cut = ui.cutLine ?: "the realm's cut is ${formatUnits(p?.fee, sell.decimals, roundUp = true)} of ${formatUnits(p?.gross, sell.decimals)}"
    return earn to cut
}

/** The blue tag "Others sell it for about 1.8": hidden when nobody sells it; while loading it keeps the last good value,
 *  or shows "…" inside the tag when there is none yet. */
fun othersTagText(hint: String?, loading: Boolean): String? = when {
    hint != null -> "Others sell it for about $hint"
    loading -> "Others sell it for about $UNKNOWN"
    else -> null
}

/**
 * The LIST Seal (SPEC Part two; specified, not rendered): "LIST 10 FROSTGLASS", 10 Frostglass → your stall, "Buyers pay
 * 1.9 KEEP each.", the realm's cut in the fine print ("The realm keeps a cut of each sale (5%). You get 18 KEEP if all
 * 10 sell.") + "Paid out to your wallet as they sell.", BACK + LIST (arms 450 ms). Listing moves no money from the
 * player; the fee percentage is the server's. Null when nothing is selected.
 */
fun listSeal(ui: MarketSellUi, armedAtMs: Long, sending: Boolean = false): MarketSealUi? {
    val item = selectedSellable(ui) ?: return null
    val qty = sellQuantity(ui)
    val craftItem = ui.items[item.itemId]
    val name = craftItem?.let { if (qty == 1L) it.name else it.pluralName } ?: item.itemId
    val unit = currencyName(ui.currency)
    val p = sellProceeds(qty, ui.unitPrice, ui.feeBps)
    val all = if (qty == 1L) "if it sells" else "if all ${groupDigits(qty)} sell"
    return MarketSealUi(
        title = "LIST ${groupDigits(qty)} ${name.uppercase(Locale.US)}",
        pay = SealSideUi(craftItem?.icon ?: craftItemIcon(item.itemId), 48, groupDigits(qty), name, "List ${groupDigits(qty)} $name"),
        gets = SealSideUi("ui:market-menu", 48, null, "your stall", "Onto your stall"),
        lines = listOf("Buyers pay ${formatUnits(ui.unitPrice, ui.decimals)} $unit each."),
        finePrint = MarketFinePrintUi(null, null,
            "The realm keeps a cut of each sale (${feePercent(ui.feeBps)}). You get ${formatUnits(p?.net, ui.decimals)} $unit $all."),
        note = "Paid out to your wallet as they sell.",
        confirmLabel = "LIST",
        confirmSub = null,
        armedAtMs = armedAtMs,
        stage = if (sending) MarketSealStage.BUSY else MarketSealStage.READY,
        quoteReady = ui.unitPrice != null && ui.feeBps != null,
    )
}

// ------------------------------------------------------------------------------------------------------ Harvester HISTORY

/**
 * The 7-day bars (SPEC E1.3: server day totals, no axis): each day's height in dp as its share of the busiest day, at
 * least 2 dp for any haul so a small day never looks empty. A day the server did not report is null (no bar, "…"
 * label), never 0. A known zero is 0.
 */
fun dayBarHeights(days: List<DayBarUi>, maxDp: Int): List<Int?> {
    val top = days.mapNotNull { it.amount }.maxOrNull() ?: return days.map { null }
    return days.map { d ->
        val a = d.amount ?: return@map null
        when {
            a <= 0L || top <= 0L -> 0
            else -> ((a * maxDp + top - 1) / top).toInt().coerceIn(2, maxDp)
        }
    }
}

/** A haul's quantity as drawn: "+12", or "…" when unknown (never "+0" for an unknown, never "++12"). */
fun haulQuantityText(quantity: String?): String {
    val q = quantity?.trim().orEmpty()
    if (q.isEmpty() || q == UNKNOWN) return UNKNOWN
    return if (q.startsWith("+") || q.startsWith("-")) q else "+$q"
}

/** The recovery row's two lines (SPEC E1.3 footer / error state): "Updated 2 min ago" + "Hauls are counted by the
 *  realm", or "Couldn't check · showing 14:20" after a failed CHECK (the last good list stays). */
fun historyRecoveryLines(refreshedAgo: String?, errorShowing: String?): Pair<String, String> = when {
    errorShowing != null -> "Couldn't check · showing $errorShowing" to "The last list stays on screen"
    refreshedAgo != null -> "Updated $refreshedAgo" to "Hauls are counted by the realm"
    else -> "Not checked yet" to "Hauls are counted by the realm"
}

/** "288 in all" (or "… in all"). */
fun weekTotalLine(weekTotal: String?): String = "${weekTotal?.takeIf { it.isNotBlank() } ?: UNKNOWN} in all"
