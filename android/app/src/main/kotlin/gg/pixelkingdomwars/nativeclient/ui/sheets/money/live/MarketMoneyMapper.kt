package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.charter.charterText
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketState
import gg.pixelkingdomwars.nativeclient.data.MarketBrowseState
import gg.pixelkingdomwars.nativeclient.data.MarketRepository
import gg.pixelkingdomwars.nativeclient.data.MarketTradeState
import gg.pixelkingdomwars.nativeclient.data.intValueExactCompat
import gg.pixelkingdomwars.nativeclient.data.longValueExactCompat
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketCatalogue
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketProtocol
import gg.pixelkingdomwars.nativeclient.model.MarketContract
import gg.pixelkingdomwars.nativeclient.model.MarketOffer
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftFrameUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketBuyUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketOfferUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketSellUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketWalletUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SellableUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.marketHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.marketTabs
import java.math.BigDecimal
import java.math.BigInteger
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Observation-only adapter to the existing Opus sheet models. This is not a mounted money flow: BUY payments and
 * SELL listing are deliberately disabled, and no callback, review, Seal or payment-stage transition is created.
 * Existing controllers own their original intents, consent, signing and recovery. In particular, an error or a
 * changed listing never becomes a refusal, a retry authorization or proof of purchase here.
 *
 * KEEP and the existing single-item SOL market are separate contracts. Unsupported amounts are omitted when the
 * sheet's signed Long fields cannot express them exactly. No quantity, fee, decimal scale, tick or slot limit is
 * invented to make an unsupported observation actionable. Mounting and callback integration require their own
 * review. ORDERS stays absent because the existing model cannot express cancellation/recovery admission.
 *
 * WalletFunds can retain an earlier response after a failed refresh. Amounts require an explicit current read
 * admission and its wallet identity; the host must invalidate admission on refresh failure or identity change.
 * Token keys are symbols: exactly one case-insensitive KEEP entry can supply KEEP, never a caller-selected token.
 */
fun marketMoneySheetUi(
    tab: String = MarketTab.BUY,
    section: String? = null,
    browse: MarketBrowseState? = null,
    trade: MarketTradeState? = null,
    keepMarket: KeepEquipmentMarketState? = null,
    wallet: WalletFunds? = null,
    walletAddress: String? = null,
    selectedBaseId: String? = null,
    selectedOfferId: String? = null,
    quantity: Long = 1,
    level: Int? = null,
    tier: Int? = null,
    appliedAwningTier: Int? = null,
    walletCurrent: Boolean = false,
    walletObservedFor: String? = null,
): MarketSheetUi {
    val sol = section == "sol"
    val category = section ?: "materials"
    val policy = keepMarket?.policy?.let { runCatching { KeepEquipmentMarketProtocol.policy(it) }.getOrNull() }
    val decimals = policy?.getValue("decimals")?.jsonPrimitive?.content?.toInt()
    val listings = keepMarket?.listings?.let { runCatching { KeepEquipmentMarketProtocol.listings(it) }.getOrNull() }
    val stock = keepMarket?.takeIf { !it.busy && it.error == null }?.stock?.let { raw ->
        runCatching { KeepEquipmentMarketProtocol.stock(raw) }.getOrNull()?.takeIf {
            selectedBaseId != null && walletAddress != null && it.charterText("baseId") == selectedBaseId &&
                it.charterText("wallet") == walletAddress && policy != null && it["policy"] == policy
        }
    }
    val stockRows = stock?.getValue("items")?.jsonArray?.map { it.jsonObject }.orEmpty()
    val held = if (sol) emptyMap() else stockRows.associate { it.charterText("itemId") to it.charterText("available").toLong() }
    val offers = if (sol) browse?.book?.offers.orEmpty().mapNotNull { solOfferUi(it, walletAddress) } else {
        if (policy == null || listings == null) emptyList() else listings.getValue("items").jsonArray.mapNotNull {
            keepOfferUi(it.jsonObject, policy, category, quantity, walletAddress)
        }
    }
    val hydration = if (sol) solHydration(browse, MarketRepository.BOOK, browse?.book != null) else when {
        keepMarket == null || keepMarket.busy -> CraftHydration.Loading
        keepMarket.error != null -> CraftHydration.Error("The Market needs a refresh. Saved requests remain with their original recovery flow.")
        keepMarket.policy == null || keepMarket.listings == null -> CraftHydration.Loading
        policy == null || listings == null -> CraftHydration.Error("Market observations are unavailable.")
        else -> CraftHydration.Ready
    }
    val currentWallet = wallet?.takeIf {
        walletCurrent && !walletAddress.isNullOrBlank() && walletObservedFor == walletAddress
    }
    val keepAmount = currentWallet?.tokens?.entries?.filter { it.key.equals("KEEP", ignoreCase = true) }
        ?.singleOrNull()?.value?.let(::decimalText)
    val solAmount = currentWallet?.sol?.let(::decimalText)
    val walletUi = MarketWalletUi(
        linked = !walletAddress.isNullOrBlank(), keep = keepAmount, sol = solAmount,
        keepBaseUnits = decimals?.let { exactBaseUnits(keepAmount, it) }, solBaseUnits = exactBaseUnits(solAmount, 9),
    )
    val selected = offers.firstOrNull { it.offerId == selectedOfferId } ?: offers.firstOrNull()
    val selectedQuantity = selected?.let { quantity.coerceIn(it.minimumPurchase, it.quantity) } ?: quantity.coerceAtLeast(1)
    val buy = MarketBuyUi(
        category = category, offers = offers,
        // The controller retains the actual JSON cursor. The string is only its opaque presentation token.
        nextCursor = if (sol) null else listings?.get("nextCursor")?.takeUnless { it == JsonNull }?.toString(),
        selectedOfferId = selected?.offerId, quantity = selectedQuantity, held = held, wallet = walletUi,
        deliveryBaseId = selectedBaseId, paymentsAvailable = false,
        feeBps = if (sol) browse?.book?.feeBps?.takeIf { it in 0..10_000 } else policy?.let(::feeBasisPoints),
        totalLots = null, hydration = if (trade?.busy == true) CraftHydration.Loading else hydration,
        money = MoneyStage.READY,
    )
    val sell = if (sol || decimals == null) null else MarketSellUi(
        sellable = stockRows.filter { inCategory(it.charterText("itemId"), category) }.map {
            SellableUi(it.charterText("itemId"), it.charterText("available").toLong(), it.charterText("reserved").toLong())
        },
        selectedItemId = null, qty = quantity.coerceAtLeast(1), unitPrice = null, tick = null, lowestOffer = null,
        feeBps = policy?.let(::feeBasisPoints), slots = null, listingAllowed = false, decimals = decimals,
        currency = Currency.KEEP, hydration = when {
            hydration is CraftHydration.Error -> hydration
            stock == null -> CraftHydration.Loading
            else -> hydration
        },
    )
    val tabs = marketTabs()
    return MarketSheetUi(
        frame = CraftFrameUi("MARKET", level?.takeIf { it > 0 }?.let { "LV $it" }, null, true, tabs,
            tab.takeIf { candidate -> tabs.any { it.id == candidate } } ?: MarketTab.BUY),
        header = if (tier == null && appliedAwningTier == null) CraftHeaderUi(null) else marketHeader(tier, appliedAwningTier),
        buy = buy, sell = sell, orders = null,
        // No observed balance/listing becomes a consent, success, sold notification or resource-spend chip.
        review = null, spend = null,
    )
}

private fun keepOfferUi(
    row: JsonObject, policy: JsonObject, category: String, quantity: Long, walletAddress: String?,
): MarketOfferUi? = runCatching {
    val item = row.charterText("itemId")
    if (!inCategory(item, category)) return@runCatching null
    val available = row.charterText("availableQuantity").toLong()
    val unitPrice = row.charterText("unitPriceBaseUnits").toBigInteger().longValueExactCompat()
    require(available > 0 && unitPrice > 0)
    val minimumTotal = policy.charterText("minFillBaseUnits").toBigInteger()
    val price = BigInteger.valueOf(unitPrice)
    val minimumQuantity = minimumTotal.add(price).subtract(BigInteger.ONE).divide(price).longValueExactCompat()
    require(minimumQuantity in 1..available)
    // Opus's lotTotal is a signed Long. Do not display a selected total it cannot represent.
    Math.multiplyExact(unitPrice, quantity.coerceIn(minimumQuantity, available))
    MarketOfferUi(row.charterText("id"), item, available, unitPrice,
        policy.getValue("decimals").jsonPrimitive.content.toInt(), Currency.KEEP, row.charterText("sellerBaseId"),
        row.charterText("sellerWallet"), minimumQuantity, row.charterText("sellerWallet") == walletAddress)
}.getOrNull()

private fun solOfferUi(offer: MarketOffer, walletAddress: String?): MarketOfferUi? = runCatching {
    MarketContract.id(offer.id); MarketContract.address(offer.seller); MarketContract.item(offer.itemId)
    val base = requireNotNull(offer.baseId) // This sheet type has no wallet-custody destination representation.
    MarketContract.id(base)
    val price = MarketContract.amount(offer.priceLamports).toLong()
    MarketOfferUi(offer.id, offer.itemId, 1, price, 9, Currency.SOL, base, offer.seller, 1, offer.seller == walletAddress)
}.getOrNull()

private fun solHydration(browse: MarketBrowseState?, path: String, present: Boolean): CraftHydration = when {
    browse == null || browse.loading -> CraftHydration.Loading
    path in browse.errors -> CraftHydration.Error("The Market needs a refresh.")
    !present || path !in browse.fresh -> CraftHydration.Loading
    else -> CraftHydration.Ready
}

private fun inCategory(item: String, category: String): Boolean = when (category) {
    "tools" -> item in KeepEquipmentMarketCatalogue.itemIds && KeepEquipmentMarketCatalogue.category(item) == "items"
    "fragments" -> item == "crystal_fragment"
    "materials" -> item in KeepEquipmentMarketCatalogue.resourceIds && item != "crystal_fragment"
    // Repository category ids remain usable without pretending they are additional currencies.
    "items", "resources" -> item in KeepEquipmentMarketCatalogue.itemIds && KeepEquipmentMarketCatalogue.category(item) == category
    else -> false
}

/** A non-10,000 server denominator is accepted only when its fee is exactly expressible in sheet basis points. */
private fun feeBasisPoints(policy: JsonObject): Int? = runCatching {
    val denominator = policy.getValue("basisPoints").jsonPrimitive.content.toBigInteger()
    val seller = policy.getValue("sellerBps").jsonPrimitive.content.toBigInteger()
    val result = (denominator - seller).multiply(BigInteger.valueOf(10_000)).divideAndRemainder(denominator)
    require(result[1] == BigInteger.ZERO)
    result[0].intValueExactCompat().also { require(it in 0..10_000) }
}.getOrNull()

private fun decimalText(value: String): String? = value.takeIf {
    it.length in 1..512 && it.matches(Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?"))
}

private fun exactBaseUnits(value: String?, decimals: Int): Long? = value?.let {
    runCatching { BigDecimal(it).movePointRight(decimals).toBigIntegerExact().longValueExactCompat() }.getOrNull()
}
