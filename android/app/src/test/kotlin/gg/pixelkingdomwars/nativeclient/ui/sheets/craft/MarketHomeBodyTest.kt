package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.data.MarketBrowseState
import gg.pixelkingdomwars.nativeclient.data.MarketRepository
import gg.pixelkingdomwars.nativeclient.data.MarketTradeState
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketState
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketRecord
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketJournal
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketCatalogue
import gg.pixelkingdomwars.nativeclient.model.MarketBook
import gg.pixelkingdomwars.nativeclient.model.MarketOffer
import gg.pixelkingdomwars.nativeclient.model.OwnMarketListing
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Authored before the mount; execution belongs to Cedar3. Browse observations never authorize money commands. */
class MarketHomeBodyTest {
    private val wallet = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val seller = "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
    private val base = "00000000-0000-4000-8000-000000000005"
    private val listing = "00000000-0000-4000-8000-000000000002"
    private fun browse() = MarketBrowseState(
        book = MarketBook(500, listOf(MarketOffer(listing, seller, base, "sword", "9007199254740993", "2026-10-03T07:00:00Z")), emptyList()),
        own = listOf(OwnMarketListing(listing, "sword", base, "9007199254740993", "active")),
        fresh = setOf(MarketRepository.BOOK, MarketRepository.OWN),
    )
    private fun project(browse: MarketBrowseState? = browse(), current: Boolean = true, tab: String = MarketTab.BUY,
        trade: MarketTradeState? = null) = marketHomeSheetUi(tab = tab, solItems = true, browse = browse,
            trade = trade, walletAddress = wallet, selectedBaseId = base, current = current)

    @Test fun `mount preserves exact live item book and never relabels it as a vehicle stall`() {
        val ui = project()
        assertEquals("SOL ITEMS", ui.base.buy!!.categories.single().label)
        assertEquals(9_007_199_254_740_993L, ui.base.buy!!.offers.single().unitPrice)
        assertEquals(Currency.SOL, ui.base.buy!!.offers.single().currency)
        assertNotEquals(SOL_STALL_SECTION, ui.section)
        assertNull(ui.solStall)
        assertTrue(ui.observation!!.message.contains("vehicle", ignoreCase = true))
    }
    @Test fun `lost owner admission removes retained rows and current stock`() {
        val ui = project(current = false)
        assertTrue(ui.base.buy!!.offers.isEmpty())
        assertTrue(ui.offers!!.places.isEmpty())
        assertTrue(ui.owned!!.stores.isEmpty())
        assertTrue(ui.owned!!.wallet.isEmpty())
        assertFalse(ui.observation!!.canRefresh)
    }
    @Test fun `empty or unrefreshed book is unknown rather than an empty ready market`() {
        val ui = project(browse = null)
        assertEquals(CraftHydration.Loading, ui.base.buy!!.hydration)
        assertFalse(ui.owned!!.storesKnown)
        assertFalse(ui.owned!!.walletKnown)
        assertNull(ui.offers!!.maxPlaces)
        assertNull(ui.offers!!.freePlaces)
    }
    @Test fun `own active listing is an observed stall place without take back authority`() {
        val place = project(tab = MarketTab.ORDERS).offers!!.places.single()
        assertEquals(StallPlaceState.ON_TABLE, place.state)
        assertEquals("9007199.254740993", place.price!!.amount)
        assertNull(place.action)
        assertFalse(place.checking)
        assertEquals(listing, place.listingId)
    }
    @Test fun `reserved listing means paying never sold or delivered`() {
        val state = browse().copy(own = browse().own!!.map { it.copy(status = "reserved") })
        val place = project(state, tab = MarketTab.ORDERS).offers!!.places.single()
        assertEquals(StallPlaceState.PAYING, place.state)
        assertNull(place.action)
        assertFalse(place.line.contains("sold", ignoreCase = true))
    }
    @Test fun `stale own rows are withheld instead of shown as current offers`() {
        val ui = project(browse().copy(fresh = setOf(MarketRepository.BOOK), errors = mapOf(MarketRepository.OWN to "offline")))
        assertTrue(ui.offers!!.places.isEmpty())
        assertTrue(ui.offers!!.load is CraftHydration.Error)
    }
    @Test fun `busy owners disable the read refresh control`() {
        assertFalse(project(browse().copy(loading = true)).observation!!.canRefresh)
        assertFalse(project(trade = MarketTradeState(busy = true)).observation!!.canRefresh)
    }
    @Test fun `every tab retains explicit presentation and no payment affordance`() {
        for (tab in listOf(MarketTab.BUY, MarketTab.SELL, MarketTab.ORDERS, MarketTab.OWNED)) {
            val ui = project(tab = tab)
            assertEquals(tab, ui.base.frame.selectedTab)
            assertNotNull(ui.observation)
            assertFalse(ui.base.buy!!.paymentsAvailable)
            assertNull(ui.base.review)
            assertNull(ui.base.spend)
            assertNull(ui.sellV2?.listSeal)
            assertNull(ui.owned!!.primary)
            assertNull(ui.owned!!.secondary)
        }
    }
    @Test fun `unknown tab normalizes through the existing canonical tab contract`() {
        assertEquals(MarketTab.BUY, project(tab = "not-a-tab").base.frame.selectedTab)
    }
    @Test fun `original receipts remain reachable without a current local saved request`() {
        val sol = project(browse = null, trade = MarketTradeState())
        assertEquals("ORIGINAL MARKET", sol.observation!!.recoveryLabel)
        assertFalse(sol.base.frame.history)
        val keep = marketHomeSheetUi(solItems = false, walletAddress = wallet, current = true)
        assertEquals("RECEIPTS", keep.observation!!.recoveryLabel)
        assertFalse(keep.base.frame.history)
        assertFalse(project(current = false).base.frame.history)
        assertNull(project(current = false).observation!!.recoveryLabel)
    }
    @Test fun `failed empty and retained books preserve an explicit observation error`() {
        for (book in listOf(null, browse().book)) {
            val ui = project(browse().copy(book = book, fresh = emptySet(),
                errors = mapOf(MarketRepository.BOOK to "offline")))
            assertTrue(ui.base.buy!!.hydration is CraftHydration.Error)
            assertEquals("The Market needs a refresh.", marketObservationError(ui))
            assertTrue(ui.observation!!.canRefresh)
        }
        assertNull(marketObservationError(project()))
        assertNull(marketObservationError(project(browse = null)))
    }
    @Test fun `sell read errors survive the read only footer without becoming empty stock`() {
        val ui = project(tab = MarketTab.SELL)
        val sell = sellUi().copy(sellable = emptyList(), hydration = CraftHydration.Error("Stock is unavailable."))
        assertEquals("Stock is unavailable.", marketObservationError(ui.copy(base = ui.base.copy(sell = sell),
            sellV2 = MarketSellV2Ui(sell))))
        assertNull(marketObservationError(ui.copy(observation = null)))
    }
    @Test fun `owned stock resolves its own category before opening sell`() {
        assertEquals("tools", marketHomeCategoryForItem("route_compass"))
        assertEquals("fragments", marketHomeCategoryForItem("crystal_fragment"))
        for (item in KeepEquipmentMarketCatalogue.resourceIds - "crystal_fragment")
            assertEquals("materials", marketHomeCategoryForItem(item))
        for (item in KeepEquipmentMarketCatalogue.itemIds.filter { KeepEquipmentMarketCatalogue.category(it) == "items" })
            assertEquals("tools", marketHomeCategoryForItem(item))
        assertNull(marketHomeCategoryForItem("not-a-market-item"))
    }
    @Test fun `ordinary crafted stock opens selected in tools using the current catalogue category`() {
        val state = ordinaryCraftMarketState()
        val ui = marketHomeSheetUi(tab = MarketTab.SELL, solItems = false,
            section = requireNotNull(marketHomeCategoryForItem("navigation_kit")), keepMarket = state,
            walletAddress = wallet, selectedBaseId = base, selectedItemId = "navigation_kit", current = true)
        val sell = requireNotNull(ui.base.sell)
        assertEquals(CraftHydration.Ready, sell.hydration)
        assertEquals("navigation_kit", selectedSellable(sell)!!.itemId)
        assertEquals(7L, selectedSellable(sell)!!.available)
        assertEquals(setOf("navigation_kit"), sell.sellable.map { it.itemId }.toSet())
        assertEquals("navigation_kit", ui.base.buy!!.offers.single().itemId)
        assertFalse(sell.listingAllowed)
        assertFalse(ui.base.buy!!.paymentsAvailable)
        assertNull(ui.base.review)
        assertNull(ui.base.spend)
        val differentBase = marketHomeSheetUi(solItems = false, section = "tools", keepMarket = state,
            walletAddress = wallet, selectedBaseId = "00000000-0000-4000-8000-000000000099", current = true)
        assertTrue(differentBase.base.sell!!.sellable.isEmpty())
        assertFalse(differentBase.owned!!.storesKnown)
    }
    @Test fun `recorded sell refresh error stays an error when current stock is unavailable`() {
        val state = ordinaryCraftMarketState().copy(stock = null, error = "Stock refresh failed.")
        val ui = marketHomeSheetUi(tab = MarketTab.SELL, solItems = false, section = "tools", keepMarket = state,
            walletAddress = wallet, selectedBaseId = base, current = true)
        val sell = requireNotNull(ui.base.sell)
        assertTrue(sell.hydration is CraftHydration.Error)
        assertFalse(sell.hydration == CraftHydration.Loading)
        assertTrue(sell.sellable.isEmpty())
        assertNotNull(marketObservationError(ui))
        assertFalse(ui.owned!!.storesKnown)
        assertTrue(ui.observation!!.canRefresh)
        assertFalse(sell.listingAllowed)
        assertNull(ui.base.review)
    }
    @Test fun `sell quantity uses the visible first item before an explicit selection`() {
        val ui = project(tab = MarketTab.SELL).base.copy(sell = sellUi())
        assertEquals(2L, marketHomeStepQuantity(ui, 1L))
        assertEquals(1L, marketHomeStepQuantity(ui, -1L))
        assertEquals(3L, marketHomeStepQuantity(ui.copy(sell = sellUi(selected = "survey_lens", quantity = 2L)), 1L))
    }
    @Test fun `sell quantity follows current displayed stock after removal or shrink`() {
        val ui = project(tab = MarketTab.SELL).base
        assertEquals(2L, marketHomeStepQuantity(ui.copy(sell = sellUi(selected = "removed")), 1L))
        assertEquals(4L, marketHomeStepQuantity(ui.copy(sell = sellUi(quantity = 99L)), -1L))
        val unknown = sellUi(quantity = 3L).copy(sellable = listOf(SellableUi("route_compass", null, null)))
        assertEquals(3L, marketHomeStepQuantity(ui.copy(sell = unknown), 1L))
        val large = sellUi(quantity = Long.MAX_VALUE).copy(sellable = listOf(SellableUi("route_compass", Long.MAX_VALUE, 0L)))
        assertEquals(Long.MAX_VALUE, marketHomeStepQuantity(ui.copy(sell = large), 1L))
    }
    @Test fun `original SOL owner remains visible for each live purchase phase and restored latch`() {
        assertFalse(marketOriginalRequired())
        assertTrue(marketOriginalRequired(review = true))
        assertTrue(marketOriginalRequired(buying = true))
        assertTrue(marketOriginalRequired(saved = true))
        assertTrue(marketOriginalRequired(paying = true))
        assertTrue(marketOriginalRequired(mfa = true))
        assertTrue(marketOriginalRequired(pending = true))
        assertTrue(marketOriginalRequired(legacyPending = true))
        // Clearing review after confirmation must not unmount a purchase awaiting wallet MFA.
        assertTrue(marketOriginalRequired(review = false, buying = true, paying = true, mfa = true))
        assertTrue(marketOriginalRequired(recovery = true))
        val source = source("ui/sheets/craft/MarketHomeBody.kt")
        assertTrue(source.contains("rememberSaveable(wallet, initialItemId)"))
        assertTrue(source.contains("model.trades?.buying?.collectAsState()"))
        assertTrue(source.contains("purchaseWallet?.mfa?.collectAsState()"))
        assertTrue(source.contains("model.trades?.legacyState?.collectAsState()"))
    }
    @Test fun `KEEP original owner remains visible across reviews MFA and saved purchase recovery`() {
        assertFalse(keepMarketOriginalRequired())
        // Rewritten 2026-10-06 (night/ui-craft S4) to the new in-place rule: a fresh command review (no send, consent or
        // payment evidence) now stays on the designed sheet with the designed Seal over it; a review that carries
        // evidence still goes to the original, and payment review / MFA / saved purchases below still do.
        assertFalse(keepMarketOriginalRequired(commandReview = true, freshCommandReview = true))
        assertTrue(keepMarketOriginalRequired(commandReview = true))
        assertTrue(keepMarketOriginalRequired(paymentReview = true))
        assertTrue(keepMarketOriginalRequired(mfa = true))
        assertTrue(keepMarketOriginalRequired(savedRecord = true))
        assertTrue(keepMarketOriginalRequired(recovery = true))
        assertTrue(source("ui/sheets/craft/MarketHomeBody.kt").contains("rememberSaveable(wallet)"))
    }
    @Test fun `every KEEP pending or selected record retains original recovery regardless of command kind`() {
        assertFalse(keepMarketHasSavedRecord(KeepEquipmentMarketState()))
        val identity = StarterIdentity("https://example.invalid", "devnet", wallet)
        val policy = requireNotNull(ordinaryCraftMarketState().policy)
        for (kind in listOf("listing", "fill", "cancellation")) {
            val request = buildJsonObject {
                put("idempotencyKey", listing)
                if (kind == "listing") {
                    put("baseId", base); put("itemId", "navigation_kit"); put("quantity", "1"); put("unitPriceBaseUnits", "2000000000")
                } else {
                    put("listingId", "00000000-0000-4000-8000-000000000004")
                    if (kind == "fill") { put("buyerBaseId", base); put("quantity", "1") }
                }
            }
            val record = KeepEquipmentMarketRecord(kind, listing, request, policy)
            val pending = KeepEquipmentMarketState(journal = KeepEquipmentMarketJournal(identity = identity, pending = listOf(record)))
            assertTrue(kind, keepMarketHasSavedRecord(pending))
            val archived = pending.copy(journal = KeepEquipmentMarketJournal(identity = identity,
                archives = listOf(record.copy(discardedUnsent = true))))
            assertFalse(kind, keepMarketHasSavedRecord(archived))
            assertTrue(kind, keepMarketHasSavedRecord(archived.copy(selectedKey = listing)))
        }
    }
    @Test fun `inventory sell deep link goes immediately to the original owner`() {
        assertTrue(marketOriginalRequired(initialItemId = "sword"))
        assertFalse(marketOriginalRequired(initialItemId = null))
        val source = source("ui/sheets/craft/MarketHomeBody.kt")
        assertTrue(source.contains("MarketScreen(model, wallet, catalogue, landOwned, initialItemId"))
    }
    @Test fun `unobserved or failed stalls never enter the ready empty body`() {
        val unknown = project(browse = null, tab = MarketTab.ORDERS)
        assertNotNull(marketObservationBodyNotice(unknown))
        val failed = project(browse().copy(errors = mapOf(MarketRepository.OWN to "offline")), tab = MarketTab.ORDERS)
        assertNotNull(marketObservationBodyNotice(failed))
        val knownEmpty = project(browse().copy(own = emptyList()), tab = MarketTab.ORDERS)
        assertNull(marketObservationBodyNotice(knownEmpty))
        assertNull(marketObservationBodyNotice(project(tab = MarketTab.ORDERS)))
    }
    @Test fun `KEEP incomplete stall points to receipts without a retry that cannot complete it`() {
        val ui = marketHomeSheetUi(tab = MarketTab.ORDERS, solItems = false, keepMarket = ordinaryCraftMarketState(),
            walletAddress = wallet, selectedBaseId = base, current = true)
        assertTrue(marketObservationBodyNotice(ui)!!.contains("RECEIPTS"))
        assertFalse(ui.observation!!.canRefresh)
        assertEquals("RECEIPTS", ui.observation!!.recoveryLabel)
    }
    @Test fun `owned and sell lots count only positively held current stock`() {
        val state = ordinaryCraftMarketState()
        val ui = marketHomeSheetUi(tab = MarketTab.OWNED, solItems = false, keepMarket = state,
            walletAddress = wallet, selectedBaseId = base, current = true)
        assertEquals(listOf("navigation_kit"), ui.owned!!.stores.map { it.id })
        assertEquals(1, ui.owned!!.storesTotal)
        assertEquals("×7", ui.owned!!.stores.single().count)
        assertEquals(listOf("navigation_kit"), ui.base.sell!!.sellable.map { it.itemId })
        val unknown = marketHomeSheetUi(tab = MarketTab.OWNED, solItems = false, keepMarket = state.copy(stock = null),
            walletAddress = wallet, selectedBaseId = base, current = true)
        assertFalse(unknown.owned!!.storesKnown)
        assertNull(unknown.owned!!.storesTotal)
    }
    @Test fun `failed undiscovered KEEP market is unavailable without claiming a server switch or offering CHECK`() {
        for (tab in listOf(MarketTab.BUY, MarketTab.SELL, MarketTab.ORDERS, MarketTab.OWNED)) {
            val ui = marketHomeSheetUi(tab = tab, solItems = false, keepMarket = KeepEquipmentMarketState(error = "Unavailable"),
                walletAddress = wallet, selectedBaseId = base, current = true)
            assertNotNull(ui.observation!!.unavailable)
            assertNotNull(marketObservationBodyNotice(ui))
            assertNull(marketObservationError(ui))
            assertFalse(ui.observation!!.canRefresh)
            assertEquals("RECEIPTS", ui.observation!!.recoveryLabel)
            assertFalse(ui.observation!!.unavailable!!.contains("switch", ignoreCase = true))
        }
        val pending = marketHomeSheetUi(solItems = false, keepMarket = KeepEquipmentMarketState(),
            walletAddress = wallet, current = true)
        assertNull(pending.observation!!.unavailable)
        val stockError = marketHomeSheetUi(solItems = false, keepMarket = ordinaryCraftMarketState().copy(stock = null, error = "offline"),
            walletAddress = wallet, selectedBaseId = base, current = true)
        assertNull(stockError.observation!!.unavailable)
        assertTrue(stockError.observation!!.canRefresh)
    }
    @Test fun `wallet custody only book remains visibly partial rather than ready empty`() {
        val custody = browse().book!!.offers.single().copy(id = "00000000-0000-4000-8000-000000000006", baseId = null)
        val ui = project(browse().copy(book = browse().book!!.copy(offers = listOf(custody))))
        assertTrue(ui.base.buy!!.offers.isEmpty())
        assertEquals(1, ui.observation!!.omittedWalletLots)
        assertTrue(ui.observation!!.message.contains("Partial book"))
        assertTrue(marketObservationBodyNotice(ui)!!.contains("ORIGINAL MARKET"))
        val mixed = project(browse().copy(book = browse().book!!.copy(offers = browse().book!!.offers + custody)))
        assertEquals(1, mixed.base.buy!!.offers.size)
        assertEquals(1, mixed.observation!!.omittedWalletLots)
        assertNull(marketObservationBodyNotice(mixed))
    }
    @Test fun `unconfirmed book never reports a current omitted lot count`() {
        val custody = browse().copy(book = browse().book!!.copy(offers = listOf(browse().book!!.offers.single().copy(baseId = null))))
        for (state in listOf(custody.copy(loading = true), custody.copy(fresh = emptySet()),
            custody.copy(errors = mapOf(MarketRepository.BOOK to "offline"))))
            assertNull(project(state).observation!!.omittedWalletLots)
        assertNull(project(custody, current = false).observation!!.omittedWalletLots)
        assertEquals(0, project().observation!!.omittedWalletLots)
    }
    private fun sellUi(selected: String? = null, quantity: Long = 1L) = MarketSellUi(
        sellable = listOf(SellableUi("route_compass", 5L, 0L), SellableUi("survey_lens", 3L, 1L)),
        selectedItemId = selected, qty = quantity, unitPrice = null, tick = null, lowestOffer = null,
        feeBps = null, slots = null, listingAllowed = false,
    )
    private fun ordinaryCraftMarketState(): KeepEquipmentMarketState {
        val policy = buildJsonObject {
            put("version", 1); put("decimals", 9); put("minFillBaseUnits", "2000000000")
            put("sellerBps", 9500); put("basisPoints", 10000); put("reviewMaxAgeMs", 30000)
        }
        val stock = buildJsonObject {
            put("catalogueVersion", 4); put("baseId", base); put("wallet", wallet)
            put("serverNow", "2026-10-03T07:00:00.000Z"); put("policy", policy)
            put("items", JsonArray(KeepEquipmentMarketCatalogue.itemIds.map { id -> buildJsonObject {
                put("itemId", id); put("available", if (id == "navigation_kit") "7" else "0")
                put("reserved", "0"); put("pendingOutput", "0"); put("marketOutgoing", "0"); put("marketIncoming", "0")
            } }))
        }
        val offer = buildJsonObject {
            put("id", listing); put("sellerWallet", seller); put("sellerBaseId", "00000000-0000-4000-8000-000000000004")
            put("itemId", "navigation_kit"); put("quantity", "7"); put("unitPriceBaseUnits", "2000000000")
            put("createdAt", "2026-10-03T07:00:00.000Z"); put("availableQuantity", "7")
            put("reservedQuantity", "0"); put("cancelledQuantity", "0")
        }
        return KeepEquipmentMarketState(policy = policy, stock = stock, listings = buildJsonObject {
            put("items", JsonArray(listOf(offer))); put("nextCursor", JsonNull)
        })
    }
    @Test fun `generic item route mounts round two while keeping only original recovery entry`() {
        val source = source("ui/sheets/craft/MarketHomeBody.kt")
        assertTrue(source.contains("MarketSheetR2("))
        assertTrue(source.contains("MarketScreen(model"))
        assertTrue(source.contains("KeepEquipmentMarketScreen(model"))
        assertTrue(source.contains("repeatOnLifecycle(Lifecycle.State.STARTED)"))
        // Rewritten 2026-10-06 (night/ui-craft S4): the SOL body stays read-only, while the KEEP body now performs the
        // owner's reservation / listing / return REVIEWS in place (buy, list, cancel, then confirm from the Seal, dismiss
        // on its BACK, select + archive for saved records). Wallet payment entries (reviewPayment, approve, send, command,
        // release) and saved-draft recovery (retry, reviewSaved, discard) must still never be called from here: they
        // stay on the original KeepEquipmentMarketScreen, where their consent and recovery wording lives.
        // These are existing owner entry points. Refresh/foreground may settle an already attempted payment.
        val keepStart = source.indexOf("@Composable fun KeepMarketHomeBody(")
        assertTrue(keepStart > 0)
        val readOnly = setOf("foreground", "refresh", "browse", "page")
        val keepAllowed = readOnly + setOf("buy", "list", "cancel", "confirm", "dismiss", "select", "archive")
        val directCalls = Regex("""\b(model|owner|trade|trades|purchaseWallet|wallet)\s*(?:\?\.|\.)\s*(\w+)\s*\(""")
        val references = Regex("""\b(model|owner|trade|trades|purchaseWallet|wallet)\s*::\s*(\w+)""")
        for ((part, modelAllowed) in listOf(source.substring(0, keepStart) to readOnly, source.substring(keepStart) to keepAllowed)) {
            val allowed = mapOf("model" to modelAllowed, "owner" to setOf("foreground"), "trade" to emptySet(),
                "trades" to emptySet(), "purchaseWallet" to emptySet(), "wallet" to emptySet())
            for (match in directCalls.findAll(part) + references.findAll(part)) {
                val receiver = match.groupValues[1]; val method = match.groupValues[2]
                assertTrue("Unexpected owner entry $receiver.$method", method in allowed.getValue(receiver))
            }
        }
        val keep = source.substring(keepStart)
        for (payment in listOf("reviewPayment", "approve", "send", "command", "release", "retry", "reviewSaved", "discard"))
            assertFalse("KEEP payment/recovery entry $payment must stay on the original owner", keep.contains("model.$payment("))
    }
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
}
