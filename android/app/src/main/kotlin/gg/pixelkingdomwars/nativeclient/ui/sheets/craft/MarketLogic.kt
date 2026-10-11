package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyName
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.sign

/*
 * The pure rules of the Market sheet (craft/SPEC.md §3): base-unit amounts, lot quantity bounds, the BUY / SELL / ORDERS
 * primaries, the BUY Seal's content, listing proceeds and the money-honest failure copy. No Compose. JVM-tested in
 * `MarketLogicTest`.
 *
 * Every amount the server sends is an integer in base units with its `decimals`; the UI never holds a float price. What
 * the player pays rounds UP and what the player gets rounds DOWN, so a figure on screen never flatters the player.
 */

/** [amount] base units with [decimals] as a short decimal ("1.8", "18", "0.25"), at most [maxFraction] places, trailing
 *  zeros dropped. [roundUp] for amounts the player pays. Null is "…". */
fun formatUnits(amount: Long?, decimals: Int, maxFraction: Int = 4, roundUp: Boolean = false): String {
    if (amount == null) return UNKNOWN
    val scale = decimals.coerceAtLeast(0)
    val value = BigDecimal.valueOf(amount, scale)
        .setScale(minOf(scale, maxFraction.coerceAtLeast(0)), if (roundUp) RoundingMode.UP else RoundingMode.DOWN)
    return if (value.signum() == 0) "0" else value.stripTrailingZeros().toPlainString()
}

/** The market fee as a percentage ("5%", "2.5%"); null is "…". */
fun feePercent(feeBps: Int?): String = if (feeBps == null) UNKNOWN else
    BigDecimal.valueOf(feeBps.toLong(), 2).stripTrailingZeros().toPlainString() + "%"

// -------------------------------------------------------------------------------------------------------------------- BUY

/** The selected lot, or the first (cheapest: the server orders them). */
fun selectedOffer(ui: MarketBuyUi): MarketOfferUi? = ui.offers.firstOrNull { it.offerId == ui.selectedOfferId } ?: ui.offers.firstOrNull()

/** A lot's quantity bounds: at least its `minimumPurchase` (≥ 1), at most what it holds. */
fun buyBounds(offer: MarketOfferUi): Pair<Long, Long> {
    val max = offer.quantity.coerceAtLeast(1L)
    return offer.minimumPurchase.coerceIn(1L, max) to max
}

/** The BUY quantity clamped to the lot's bounds. */
fun buyQuantity(ui: MarketBuyUi, offer: MarketOfferUi): Long {
    val (min, max) = buyBounds(offer)
    return ui.quantity.coerceIn(min, max)
}

/** quantity × unit price in base units; null on overflow. */
fun lotTotal(unitPrice: Long, quantity: Long): Long? = try { Math.multiplyExact(unitPrice, quantity) } catch (e: ArithmeticException) { null }

/** The wallet balance in the lot's currency, base units; null = unknown. */
private fun balanceFor(wallet: MarketWalletUi, currency: Currency): Long? = when (currency) {
    Currency.KEEP -> wallet.keepBaseUnits
    Currency.SOL -> wallet.solBaseUnits
    else -> null
}

/**
 * The BUY primary (SPEC §3.1 footer, states, §3.2 money sequence): gold "BUY 10" / "for 18 KEEP" opens the Seal (the
 * host raises it); then stone "Check wallet", stone dots "Sending", moss "BOUGHT" (after the receipt), or red RETRY.
 * Null hides it: no lot, or the player's own lot.
 */
fun buyPrimary(ui: MarketBuyUi): CraftPrimaryUi? {
    val offer = selectedOffer(ui) ?: return null
    if (offer.isMine) return null
    val qty = buyQuantity(ui, offer)
    val total = lotTotal(offer.unitPrice, qty)
    val unit = currencyName(offer.currency)
    val label = "BUY ${groupDigits(qty)}"
    val sub = "for ${formatUnits(total, offer.decimals, roundUp = true)} $unit"
    when (ui.money) {
        MoneyStage.CHECK_WALLET -> return busyPrimary("Check wallet")
        MoneyStage.SENDING -> return busyPrimary("Sending")
        MoneyStage.SENT -> return CraftPrimaryUi("BOUGHT", null, CommandState.ENABLED, Verb.MOSS, null, null, PrimaryAction.NONE)
        MoneyStage.FAILED -> return CraftPrimaryUi("RETRY", sub, CommandState.ENABLED, Verb.RED, null, null, PrimaryAction.START)
        MoneyStage.READY -> Unit
    }
    if (ui.hydration is CraftHydration.Error) return CraftPrimaryUi("Try again", null, CommandState.ENABLED, Verb.STONE, null, null, PrimaryAction.RETRY)
    if (!ui.wallet.linked) return CraftPrimaryUi("Link a wallet to buy", null, CommandState.LOCKED, Verb.CHARCOAL, null, null, PrimaryAction.LINK_WALLET)
    if (!ui.paymentsAvailable) return offPrimary(label, sub, "Wallet payments are not available in this build.")
    val balance = balanceFor(ui.wallet, offer.currency)
    if (total != null && balance != null && balance < total) {
        val price = PriceUi(offer.currency, formatUnits(total, offer.decimals, roundUp = true), PriceStatus.SHORT)
        return CraftPrimaryUi(label, sub, CommandState.SHORT, Verb.GOLD, null, price, PrimaryAction.NEED_MORE)
    }
    return CraftPrimaryUi(label, sub, CommandState.ENABLED, Verb.GOLD, null, null, PrimaryAction.START)
}

/** The system Seal for buying [quantity] of [offer] (SPEC §3.2): pay → get, "Paid from your wallet. You sign once.",
 *  BACK + BUY. [armedAtMs] is the wall-clock time the host raises it. */
fun buySeal(offer: MarketOfferUi, quantity: Long, item: CraftItemUi?, armedAtMs: Long): SealUi {
    val total = lotTotal(offer.unitPrice, quantity)
    val name = item?.name ?: offer.itemId
    val unit = currencyName(offer.currency)
    val pay = formatUnits(total, offer.decimals, roundUp = true)
    return SealUi(
        title = "BUY ${groupDigits(quantity)} ${name.uppercase(Locale.US)}",
        lines = listOf(
            if (offer.currency == Currency.SOL) "Paid from your wallet in SOL. You sign once." else "Paid from your wallet. You sign once.",
            "Goes to this kingdom's stores."),
        price = PriceUi(offer.currency, if (total == null) null else pay, if (total == null) PriceStatus.CHECKING else PriceStatus.OK,
            description = "Pay $pay $unit"),
        confirmLabel = "BUY",
        armedAtMs = armedAtMs,
        gets = PriceUi(Currency.ITEM, groupDigits(quantity), PriceStatus.OK, icon = item?.icon ?: craftItemIcon(offer.itemId),
            description = "Get ${groupDigits(quantity)} ${if (quantity == 1L) name else item?.pluralName ?: name}"),
    )
}

/** The blood toast after a failed buy. "Nothing was sent" only when the failure is AUTHORITATIVE (the wallet refused
 *  before signing); a lost answer says it is being checked (design correction 7). */
fun buyFailureCopy(authoritative: Boolean): String =
    if (authoritative) "Wallet didn't answer. Nothing was sent." else "No answer yet. Checking whether it went through."

/** The lot card's lines (SPEC §3.1 LotCard): "1.8 KEEP each · from Ashford" and "You hold 14. For tools and kits.", or
 *  "Your lot · manage it in ORDERS" for the player's own. */
fun lotLines(offer: MarketOfferUi, held: Long?, item: CraftItemUi?): Pair<String, String> {
    val each = "${formatUnits(offer.unitPrice, offer.decimals, roundUp = true)} ${currencyName(offer.currency)} each · from ${offer.sellerName}"
    if (offer.isMine) return each to "Your lot · manage it in ORDERS"
    return each to listOfNotNull("You hold ${groupDigits(held)}.", item?.usedFor).joinToString(" ")
}

// ------------------------------------------------------------------------------------------------------------------- SELL

/** The selected sellable item, or the first. */
fun selectedSellable(ui: MarketSellUi): SellableUi? = ui.sellable.firstOrNull { it.itemId == ui.selectedItemId } ?: ui.sellable.firstOrNull()

/** The SELL quantity: 1..available (reserved units are never sellable). */
fun sellQuantity(ui: MarketSellUi): Long {
    val available = selectedSellable(ui)?.available ?: return ui.qty.coerceAtLeast(1L)
    return ui.qty.coerceIn(1L, available.coerceAtLeast(1L))
}

/** One PRICE EACH press: ± one server tick, never under one tick. */
fun stepPrice(current: Long?, direction: Int, tick: Long?): Long? {
    if (tick == null || tick <= 0L) return current
    val base = current ?: return tick
    return (base + direction.sign * tick).coerceAtLeast(tick)
}

/** What a listing pays out: gross, the fee (rounded UP), and net = gross − fee. */
data class SellProceeds(val gross: Long, val fee: Long, val net: Long)

/** Proceeds of [quantity] at [unitPrice] with the server's [feeBps]; null while either is unknown or on overflow. */
fun sellProceeds(quantity: Long, unitPrice: Long?, feeBps: Int?): SellProceeds? {
    if (unitPrice == null || feeBps == null) return null
    val gross = lotTotal(unitPrice, quantity) ?: return null
    val scaled = try { Math.multiplyExact(gross, feeBps.toLong()) } catch (e: ArithmeticException) { return null }
    val fee = (scaled + 9_999L) / 10_000L
    return SellProceeds(gross, fee, gross - fee)
}

/** The ProceedsRow lines: "You get 18 KEEP" and "19 total, market fee 5%" ("…" while unknown). */
fun proceedsLines(ui: MarketSellUi): Pair<String, String> {
    val unit = currencyName(ui.currency)
    val p = sellProceeds(sellQuantity(ui), ui.unitPrice, ui.feeBps)
    val royalty = ui.royaltyBps?.let { ", ${feePercent(it)} royalty" }.orEmpty()
    return "You get ${formatUnits(p?.net, ui.decimals)} $unit" to
        "${formatUnits(p?.gross, ui.decimals)} total, market fee ${feePercent(ui.feeBps)}$royalty"
}

/** The SELL primary (SPEC §3.3): gold "LIST 10" opens the review half sheet (no Seal: no money moves at listing). */
fun sellPrimary(ui: MarketSellUi): CraftPrimaryUi? {
    val item = selectedSellable(ui) ?: return null
    val qty = sellQuantity(ui)
    val name = ui.items[item.itemId]?.name ?: item.itemId
    val label = "LIST ${groupDigits(qty)}"
    val sub = "$name at ${formatUnits(ui.unitPrice, ui.decimals)} each"
    commonGate(ui.hydration, ui.submit, null, label, sub)?.let { return it }
    if (!ui.listingAllowed) return CraftPrimaryUi("Pick a kingdom you own to list.", null, CommandState.LOCKED, Verb.CHARCOAL, null, null, PrimaryAction.SHAKE)
    val slots = ui.slots
    if (slots != null && slots.used >= slots.max) return CraftPrimaryUi(label, sub, CommandState.DISABLED, Verb.GOLD,
        "All ${slots.max} slots are in use. Take one back in ORDERS.", null, PrimaryAction.OPEN_ORDERS)
    if (item.available == 0L) return offPrimary(label, sub, "None left to list.")
    if (ui.unitPrice == null) return offPrimary(label, sub, "Set a price first.")
    return CraftPrimaryUi(label, sub, CommandState.ENABLED, Verb.GOLD, null, null, PrimaryAction.START)
}

/** The LIST review half sheet: "LIST 10 FROSTGLASS" at the unit price; no money moves at listing. */
fun listReview(ui: MarketSellUi, sending: Boolean = false): CraftReviewUi? {
    val item = selectedSellable(ui) ?: return null
    val qty = sellQuantity(ui)
    val name = ui.items[item.itemId]?.let { if (qty == 1L) it.name else it.pluralName } ?: item.itemId
    return CraftReviewUi("LIST ${groupDigits(qty)} ${name.uppercase(Locale.US)}",
        "At ${formatUnits(ui.unitPrice, ui.decimals)} ${currencyName(ui.currency)} each. They leave your stores until sold or taken back.",
        confirmLabel = "LIST", sending = sending)
}

// ----------------------------------------------------------------------------------------------------------------- ORDERS

/** The ORDERS primary: gold "SELL MORE" that switches to SELL. */
fun ordersPrimary(): CraftPrimaryUi = CraftPrimaryUi("SELL MORE", "opens SELL", CommandState.ENABLED, Verb.GOLD, null, null, PrimaryAction.OPEN_SELL)

/** "CROWNSTEEL x6" (the count is left out for a single item such as a deed). */
fun orderTitle(name: String, quantity: Long): String = name.uppercase(Locale.US) + if (quantity > 1L) " x${groupDigits(quantity)}" else ""

/** A sold row's line: "14.4 KEEP · 2h ago". */
fun soldLine(order: SoldOrderUi): String = "${order.proceeds} ${currencyName(order.currency)} · ${order.at}"

/** An open row's line: "4 sold · 1.9 each", "none sold · 4.0 each", or "2.5 SOL · buyer paying". */
fun openLine(order: OpenOrderUi): String =
    if (order.state == OpenOrderState.PAYING) "${order.unitPrice} ${currencyName(order.currency)} · buyer paying"
    else "${if (order.sold <= 0L) "none" else groupDigits(order.sold)} sold · ${order.unitPrice} each"

/** Sold / listed for the row's bar. */
fun openProgress(order: OpenOrderUi): Float = if (order.listed <= 0L) 0f else (order.sold.toFloat() / order.listed).coerceIn(0f, 1f)

/** "2 free slots. List from SELL."; null when the server has no slot limit (the FREE SLOTS box is hidden). */
fun freeSlotsLine(slots: MarketSlotsUi?): String? = slots?.let {
    val free = (it.max - it.used).coerceAtLeast(0)
    "$free free slot${if (free == 1) "" else "s"}. List from SELL."
}

/** The take-back review (SPEC §3.4 TAKE BACK flow): "Take back 6 Frostglass? They return to your stores." */
fun takeBackReview(order: OpenOrderUi, item: CraftItemUi?, sending: Boolean = false): CraftReviewUi {
    val left = (order.listed - order.sold).coerceAtLeast(0L)
    val name = if (left == 1L) item?.name ?: order.itemId else item?.pluralName ?: order.itemId
    return CraftReviewUi("TAKE BACK", "Take back ${groupDigits(left)} $name? They return to your stores.", confirmLabel = "TAKE BACK", sending = sending)
}
