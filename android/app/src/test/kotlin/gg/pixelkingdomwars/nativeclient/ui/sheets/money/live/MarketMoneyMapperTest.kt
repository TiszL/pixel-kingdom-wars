package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketState
import gg.pixelkingdomwars.nativeclient.data.MarketBrowseState
import gg.pixelkingdomwars.nativeclient.data.MarketRepository
import gg.pixelkingdomwars.nativeclient.data.MarketReview
import gg.pixelkingdomwars.nativeclient.data.MarketTradeState
import gg.pixelkingdomwars.nativeclient.model.MarketBook
import gg.pixelkingdomwars.nativeclient.model.MarketOffer
import gg.pixelkingdomwars.nativeclient.model.OwnMarketListing
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketWalletUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.PrimaryAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.buyPrimary
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Author-only contract for the new projection; existing controllers retain consent and original recovery. */
class MarketMoneyMapperTest {
    private val walletId = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val seller = "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
    private val base = "00000000-0000-4000-8000-000000000005"
    private val sellerBase = "00000000-0000-4000-8000-000000000004"
    private val listingId = "00000000-0000-4000-8000-000000000002"
    private val keepSymbol = "KEEP"
    private val now = "2026-10-03T07:00:00.000Z"

    @Test fun `absent observations stay unknown and expose no spend or fabricated review`() {
        val sheet = marketMoneySheetUi()
        val buy = requireNotNull(sheet.buy)
        assertTrue(buy.offers.isEmpty())
        assertTrue(buy.held.isEmpty())
        assertNull(buy.feeBps)
        assertNull(buy.totalLots)
        assertNull(buy.wallet.keep)
        assertNull(buy.wallet.sol)
        assertNull(buy.wallet.keepBaseUnits)
        assertNull(buy.wallet.solBaseUnits)
        assertEquals(CraftHydration.Loading, buy.hydration)
        assertFalse(buy.wallet.linked)
        assertNoSpend(sheet)
    }

    @Test fun `KEEP lot projects server quantity price decimals and minimum fill exactly`() {
        val sheet = project(keep = keepState(), quantity = 7)
        val offer = requireNotNull(sheet.buy).offers.single()
        assertEquals(listingId, offer.offerId)
        assertEquals("route_compass", offer.itemId)
        assertEquals(10L, offer.quantity)
        assertEquals(600_000_000L, offer.unitPrice)
        assertEquals(9, offer.decimals)
        assertEquals(Currency.KEEP, offer.currency)
        assertEquals(4L, offer.minimumPurchase)
        assertEquals(sellerBase, offer.sellerBaseId)
        assertFalse(offer.isMine)
        assertEquals(500, sheet.buy!!.feeBps)
        assertEquals(7L, sheet.buy!!.quantity)
        assertNoSpend(sheet)
    }

    @Test fun `held stock includes available only and requires current base and wallet`() {
        val state = keepState(stock = stock())
        val current = project(keep = state).buy!!
        assertEquals(8L, current.held["route_compass"])
        assertEquals(2L, current.held["survey_lens"])
        assertTrue(project(keep = state, selectedBase = sellerBase).buy!!.held.isEmpty())
        assertTrue(project(keep = state, walletAddress = seller).buy!!.held.isEmpty())
        assertTrue(project(keep = state, selectedBase = null).buy!!.held.isEmpty())
    }

    @Test fun `admitted wallet decimal text remains exact and uses actual KEEP symbol`() {
        val funds = WalletFunds("0.000000001", mapOf(keepSymbol to "9007199.254740993", "USDC" to "999"), 42)
        val wallet = project(keep = keepState(), funds = funds).buy!!.wallet
        assertEquals("0.000000001", wallet.sol)
        assertEquals(1L, wallet.solBaseUnits)
        assertEquals("9007199.254740993", wallet.keep)
        assertEquals(9_007_199_254_740_993L, wallet.keepBaseUnits)
    }

    @Test fun `wallet precision and Long overflow are never truncated or saturated`() {
        val tooPrecise = project(keep = keepState(), funds = WalletFunds("0.0000000001", mapOf(keepSymbol to "1.0000000001"), 42)).buy!!.wallet
        assertNull(tooPrecise.solBaseUnits)
        assertNull(tooPrecise.keepBaseUnits)
        val tooLarge = project(keep = keepState(), funds = WalletFunds(null, mapOf(keepSymbol to "9223372036.854775808"), 42)).buy!!.wallet
        assertEquals("9223372036.854775808", tooLarge.keep)
        assertNull(tooLarge.keepBaseUnits)
    }

    @Test fun `supplied wallet funds remain unknown by default without current admission`() {
        val funds = WalletFunds("1.25", mapOf(keepSymbol to "12.5"), 42)
        val sheet = marketMoneySheetUi(wallet = funds, walletAddress = walletId, walletObservedFor = walletId,
            keepMarket = keepState())
        assertUnknownWallet(sheet.buy!!.wallet)
        assertNoSpend(sheet)
    }

    @Test fun `failed wallet refresh invalidates retained prior amounts`() {
        val retained = WalletFunds("1.25", mapOf(keepSymbol to "12.5"), 42)
        val sheet = project(keep = keepState(), funds = retained, walletCurrent = false)
        assertUnknownWallet(sheet.buy!!.wallet)
        assertNoSpend(sheet)
    }

    @Test fun `wallet identity shift invalidates current flag for another wallets observation`() {
        val retained = WalletFunds("1.25", mapOf(keepSymbol to "12.5"), 42)
        val sheet = project(keep = keepState(), funds = retained, walletAddress = seller, walletObservedFor = walletId)
        assertUnknownWallet(sheet.buy!!.wallet)
        assertNoSpend(sheet)
    }

    @Test fun `wallet admission without either current or observed identity stays unknown`() {
        val funds = WalletFunds("1.25", mapOf(keepSymbol to "12.5"), 42)
        assertUnknownWallet(project(keep = keepState(), funds = funds, walletObservedFor = null).buy!!.wallet)
        assertUnknownWallet(project(keep = keepState(), funds = funds, walletAddress = null).buy!!.wallet)
    }

    @Test fun `unique KEEP symbol is case insensitive without relabelling USDC`() {
        for (symbol in listOf("KEEP", "keep", "KeEp")) {
            val funds = WalletFunds("1", mapOf(symbol to "2.5", "USDC" to "999.0"), 42)
            val wallet = project(keep = keepState(), funds = funds).buy!!.wallet
            assertEquals("2.5", wallet.keep)
            assertEquals(2_500_000_000L, wallet.keepBaseUnits)
        }
    }

    @Test fun `missing null or ambiguous KEEP symbol never picks another token or casing`() {
        val tokenMaps: List<Map<String, String?>> = listOf(
            mapOf("USDC" to "999"),
            mapOf("KEEP" to null, "USDC" to "999"),
            mapOf("KEEP" to "2.5", "keep" to "7.5"),
            mapOf("KEEP" to "2.5", "keep" to "2.5"),
            mapOf("KEEP" to "2.5", "keep" to null),
        )
        for (tokens in tokenMaps) {
            val wallet = project(keep = keepState(), funds = WalletFunds("1", tokens, 42)).buy!!.wallet
            assertNull(wallet.keep)
            assertNull(wallet.keepBaseUnits)
            assertEquals("1", wallet.sol)
            assertEquals(1_000_000_000L, wallet.solBaseUnits)
        }
    }

    @Test fun `missing policy never supplies default KEEP decimals minimum or price`() {
        val sheet = project(keep = keepState().copy(policy = null))
        assertTrue(sheet.buy!!.offers.isEmpty())
        assertNull(sheet.buy!!.feeBps)
        assertNoSpend(sheet)
    }

    @Test fun `invalid policy fails closed instead of using partial JSON values`() {
        val malformed = JsonObject(policy() + ("decimals" to JsonPrimitive(256)))
        val sheet = project(keep = keepState(policy = malformed))
        assertTrue(sheet.buy!!.offers.isEmpty())
        assertNull(sheet.buy!!.feeBps)
        assertNoSpend(sheet)
    }

    @Test fun `uint64 KEEP price outside Opus signed Long representation fails closed`() {
        val sheet = project(keep = keepState(listing = listing(unitPrice = "9223372036854775808")))
        assertTrue(sheet.buy!!.offers.isEmpty())
        assertNoSpend(sheet)
    }

    @Test fun `selected quantity multiplication overflow fails closed`() {
        val sheet = project(keep = keepState(listing = listing(unitPrice = Long.MAX_VALUE.toString())), quantity = 2)
        assertTrue(sheet.buy!!.offers.isEmpty())
        assertNoSpend(sheet)
    }

    @Test fun `minimum fill larger than available stock never clamps into a buyable lot`() {
        val sheet = project(keep = keepState(listing = listing(available = "3")))
        assertTrue(sheet.buy!!.offers.isEmpty())
        assertNoSpend(sheet)
    }

    @Test fun `same wallet lots remain own even when another kingdom is selected`() {
        val sheet = project(keep = keepState(listing = listing(sellerWallet = walletId)))
        assertTrue(sheet.buy!!.offers.single().isMine)
        assertNull(buyPrimary(sheet.buy!!))
        assertNoSpend(sheet)
    }

    @Test fun `SOL listings remain single item SOL even when KEEP data is also present`() {
        val sheet = project(section = "sol", browse = browse(), keep = keepState())
        val offer = sheet.buy!!.offers.single()
        assertEquals(Currency.SOL, offer.currency)
        assertEquals(1L, offer.quantity)
        assertEquals(1L, offer.minimumPurchase)
        assertEquals(1L, offer.unitPrice)
        assertEquals(9, offer.decimals)
        assertEquals("sword", offer.itemId)
        assertNoSpend(sheet)
    }

    @Test fun `stale or refreshing SOL book does not masquerade as ready`() {
        val stale = project(section = "sol", browse = browse().copy(fresh = emptySet()))
        val refreshing = project(section = "sol", browse = browse().copy(loading = true))
        assertFalse(stale.buy!!.hydration == CraftHydration.Ready)
        assertEquals(CraftHydration.Loading, refreshing.buy!!.hydration)
        assertNoSpend(stale)
        assertNoSpend(refreshing)
    }

    @Test fun `uncertain error never becomes wallet refusal retry or purchase success`() {
        val trade = MarketTradeState(loaded = true, supported = true, error = "Response lost after submission")
        val sheet = project(section = "sol", browse = browse(), trade = trade)
        assertEquals(MoneyStage.READY, sheet.buy!!.money)
        assertNoSpend(sheet)
        assertFalse(sheet.review?.line.orEmpty().contains("Nothing was spent"))
    }

    @Test fun `saved pending intent and controller review remain original and are not replaced by a sheet review`() {
        val pending = PendingIntent(IntentKind.MARKET_RESERVE, walletId, base, "original-key-0001", "/market/reserve",
            buildJsonObject { put("listingId", listingId) }, "Buy original", attempted = true)
        val review = MarketReview.Purchase(walletId, base, solOffer())
        val trade = MarketTradeState(loaded = true, supported = true, review = review, pending = listOf(pending))
        val before = trade.copy()
        val sheet = project(section = "sol", browse = browse(), trade = trade)
        assertEquals(before, trade)
        assertSame(pending, trade.pending.single())
        assertSame(review, trade.review)
        assertNull(sheet.review)
        assertNoSpend(sheet)
    }

    @Test fun `fresh own SOL observations cannot expose cancellation without owner admission`() {
        val sheet = marketMoneySheetUi(tab = MarketTab.ORDERS, section = "sol",
            browse = ownBrowse(), trade = MarketTradeState(loaded = true, supported = true),
            walletAddress = walletId, selectedBaseId = base)
        assertNull(sheet.orders)
        assertNoSpend(sheet)
    }

    @Test fun `missing unsupported busy or pending trade cannot enable TAKE BACK from browse rows`() {
        val pending = PendingIntent(IntentKind.MARKET_CANCEL, walletId, base, "original-cancel-0001", "/market/cancel",
            buildJsonObject { put("listingId", listingId) }, "Cancel original", attempted = true)
        val states = listOf(null, MarketTradeState(), MarketTradeState(loaded = true, supported = false),
            MarketTradeState(loaded = true, supported = true, busy = true),
            MarketTradeState(loaded = true, supported = true, pending = listOf(pending)))
        for (trade in states) {
            val sheet = marketMoneySheetUi(tab = MarketTab.ORDERS, section = "sol", browse = ownBrowse(), trade = trade,
                walletAddress = walletId, selectedBaseId = base)
            assertNull(sheet.orders)
            assertNoSpend(sheet)
        }
    }

    @Test fun `own rows cannot imply cancellation authority after wallet or kingdom identity shift`() {
        for ((wallet, selected) in listOf(seller to base, walletId to sellerBase, null to base, walletId to null)) {
            val sheet = marketMoneySheetUi(tab = MarketTab.ORDERS, section = "sol", browse = ownBrowse(),
                trade = MarketTradeState(loaded = true, supported = true), walletAddress = wallet, selectedBaseId = selected)
            assertNull(sheet.orders)
            assertNoSpend(sheet)
        }
    }

    @Test fun `no live stock or policy field is invented for the SELL tab`() {
        val sheet = marketMoneySheetUi(tab = MarketTab.SELL, keepMarket = keepState(), walletAddress = walletId, selectedBaseId = base)
        sheet.sell?.let { sell ->
            assertFalse(sell.listingAllowed)
            assertNull(sell.tick)
            assertNull(sell.slots)
            assertNull(sell.unitPrice)
        }
        assertNoSpend(sheet)
    }

    private fun assertNoSpend(sheet: MarketSheetUi) {
        sheet.buy?.let { buy ->
            assertFalse(buy.paymentsAvailable)
            assertEquals(MoneyStage.READY, buy.money)
            assertFalse(buyPrimary(buy)?.action == PrimaryAction.START)
        }
        assertNull(sheet.review)
        assertNull(sheet.orders)
    }

    private fun assertUnknownWallet(wallet: MarketWalletUi) {
        assertNull(wallet.keep)
        assertNull(wallet.sol)
        assertNull(wallet.keepBaseUnits)
        assertNull(wallet.solBaseUnits)
    }

    private fun project(
        section: String = "tools",
        browse: MarketBrowseState? = null,
        trade: MarketTradeState? = null,
        keep: KeepEquipmentMarketState? = null,
        funds: WalletFunds? = null,
        selectedBase: String? = base,
        walletAddress: String? = walletId,
        quantity: Long = 1,
        walletCurrent: Boolean = true,
        walletObservedFor: String? = walletId,
    ): MarketSheetUi = marketMoneySheetUi(section = section, browse = browse, trade = trade, keepMarket = keep,
        wallet = funds, walletAddress = walletAddress, selectedBaseId = selectedBase, quantity = quantity,
        walletCurrent = walletCurrent, walletObservedFor = walletObservedFor)

    private fun policy(): JsonObject = buildJsonObject {
        put("version", 1); put("decimals", 9); put("minFillBaseUnits", "2000000000")
        put("sellerBps", 9500); put("basisPoints", 10000); put("reviewMaxAgeMs", 30000)
    }

    private fun listing(unitPrice: String = "600000000", available: String = "10", sellerWallet: String = seller): JsonObject = buildJsonObject {
        put("id", listingId); put("sellerWallet", sellerWallet); put("sellerBaseId", sellerBase)
        put("itemId", "route_compass"); put("quantity", available); put("unitPriceBaseUnits", unitPrice)
        put("createdAt", now); put("availableQuantity", available); put("reservedQuantity", "0"); put("cancelledQuantity", "0")
    }

    private fun keepState(policy: JsonObject = policy(), listing: JsonObject = listing(), stock: JsonObject? = null) =
        KeepEquipmentMarketState(policy = policy, stock = stock,
            listings = buildJsonObject { put("items", JsonArray(listOf(listing))); put("nextCursor", JsonNull) })

    private fun stock(): JsonObject = buildJsonObject {
        put("baseId", base); put("wallet", walletId); put("serverNow", now); put("policy", policy())
        put("items", JsonArray(listOf("route_compass" to "8", "survey_lens" to "2").map { (item, available) ->
            buildJsonObject {
                put("itemId", item); put("available", available); put("reserved", "3")
                put("pendingOutput", "4"); put("marketOutgoing", "5"); put("marketIncoming", "6")
            }
        }))
    }

    private fun solOffer() = MarketOffer(listingId, seller, sellerBase, "sword", "1", now)
    private fun browse() = MarketBrowseState(book = MarketBook(500, listOf(solOffer()), emptyList()), fresh = setOf(MarketRepository.BOOK))
    private fun ownBrowse() = browse().copy(own = listOf(
        OwnMarketListing(listingId, "sword", base, "1", "active"),
        OwnMarketListing("00000000-0000-4000-8000-000000000006", "shield", base, "200000000", "reserved"),
    ), fresh = setOf(MarketRepository.BOOK, MarketRepository.OWN))
}
