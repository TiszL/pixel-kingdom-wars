package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketJournal
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketRecord
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketState
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketCatalogue
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CHECKING_TEXT
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketOfferUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketSellUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.PrimaryAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SOL_STALL_SECTION
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SellableUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.StallPlaceState
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.keepMarketFreshCommandReview
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.keepMarketOriginalRequired
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.marketHomeSheetUi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The KEEP Market sheet now performs BUY's reservation, LIST and TAKE BACK in place (night/ui-craft S4). These cases pin
 * WHY each presentation decision holds: the designed Seal may only confirm a review with no evidence behind it, wallet
 * payment must keep the original owner (its consent, incl. the seller-account rent cap, lives only there), and nothing
 * the sheet shows or sends is a client-invented price, step, place or quantity. No owner, wallet or transport runs here.
 */
class KeepMarketCommandMapperTest {
    private val wallet = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val seller = "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
    private val base = "00000000-0000-4000-8000-000000000005"
    private val otherBase = "00000000-0000-4000-8000-000000000004"
    private val foreignLot = "00000000-0000-4000-8000-000000000002"
    private val ownLot = "00000000-0000-4000-8000-000000000003"
    private val key = "00000000-0000-4000-8000-000000000009"
    private val identity = StarterIdentity("https://example.invalid", "devnet", wallet)
    private val policy = buildJsonObject {
        put("version", 1); put("decimals", 9); put("minFillBaseUnits", "2000000000")
        put("sellerBps", 9500); put("basisPoints", 10000); put("reviewMaxAgeMs", 30000)
    }

    private fun lot(id: String, sellerWallet: String, sellerBaseId: String, item: String, price: String,
        quantity: String, available: String, reserved: String) = buildJsonObject {
        put("id", id); put("sellerWallet", sellerWallet); put("sellerBaseId", sellerBaseId); put("itemId", item)
        put("quantity", quantity); put("unitPriceBaseUnits", price); put("createdAt", "2026-10-03T07:00:00.000Z")
        put("availableQuantity", available); put("reservedQuantity", reserved); put("cancelledQuantity", "0")
    }

    private fun listings(vararg rows: JsonObject, next: Boolean = false) = buildJsonObject {
        put("items", JsonArray(rows.toList()))
        if (next) put("nextCursor", buildJsonObject { put("before", "2026-10-03T07:00:00.000Z"); put("beforeId", foreignLot) })
        else put("nextCursor", JsonNull)
    }

    private val book = listings(
        lot(foreignLot, seller, otherBase, "navigation_kit", "2000000000", "7", "7", "0"),
        lot(ownLot, wallet, base, "route_compass", "1900000000", "4", "3", "1"),
    )

    private fun stock() = buildJsonObject {
        put("catalogueVersion", 4); put("baseId", base); put("wallet", wallet)
        put("serverNow", "2026-10-03T07:00:00.000Z"); put("policy", policy)
        put("items", JsonArray(KeepEquipmentMarketCatalogue.itemIds.map { id -> buildJsonObject {
            put("itemId", id); put("available", when (id) { "navigation_kit" -> "7"; "crystal_fragment" -> "3"; else -> "0" })
            put("reserved", "0"); put("pendingOutput", "0"); put("marketOutgoing", "0"); put("marketIncoming", "0")
        } }))
    }

    private fun market(journal: KeepEquipmentMarketJournal? = null, selectedKey: String? = null,
        commandReview: KeepEquipmentMarketRecord? = null) = KeepEquipmentMarketState(policy = policy, stock = stock(),
        listings = book, journal = journal, selectedKey = selectedKey, commandReview = commandReview)

    private fun record(kind: String = "listing") = KeepEquipmentMarketRecord(kind, key, buildJsonObject {
        put("idempotencyKey", key)
        when (kind) {
            "listing" -> { put("baseId", base); put("itemId", "navigation_kit"); put("quantity", "1"); put("unitPriceBaseUnits", "2000000000") }
            "fill" -> { put("listingId", foreignLot); put("buyerBaseId", base); put("quantity", "1") }
            else -> put("listingId", ownLot)
        }
    }, policy)

    private fun journal(vararg pending: KeepEquipmentMarketRecord) = KeepEquipmentMarketJournal(identity = identity, pending = pending.toList())

    private fun project(state: KeepEquipmentMarketState = market(), tab: String = MarketTab.BUY, section: String = "tools",
        selectedBase: String? = base, command: KeepMarketCommandContext? = KeepMarketCommandContext(true, true, "2.5"),
        current: Boolean = true) = marketHomeSheetUi(tab = tab, solItems = false, section = section,
        keepMarket = state, walletAddress = wallet, selectedBaseId = selectedBase, current = current,
        level = 2, tier = 1, command = command)

    // ------------------------------------------------------------------------------------------- which presentation

    @Test fun `fresh command review stays on the designed sheet under the designed Seal`() {
        val review = record("fill")
        val state = market(journal(review), selectedKey = key, commandReview = review)
        val saved = keepMarketSavedRecords(state)
        assertTrue(keepMarketReviewWithoutEvidence(state))
        assertFalse(saved.forcesOriginal)
        // The review on screen is the Seal's, never a "request from earlier" that would block its own confirm.
        assertNull(saved.waiting)
        assertFalse(keepMarketOriginalRequired(commandReview = true, savedRecord = saved.forcesOriginal,
            freshCommandReview = keepMarketReviewWithoutEvidence(state)))
        assertEquals(review, keepMarketFreshCommandReview(state))
    }

    @Test fun `a review published before its journal waits for the Seal instead of latching the original owner`() {
        // The repository publishes commandReview before it republishes the journal; the original screen latches, so a
        // flip here would strand the player on the old screen for a review the designed Seal should confirm.
        val review = record("listing")
        val state = market(journal(), selectedKey = key, commandReview = review)
        assertNull(keepMarketFreshCommandReview(state))
        assertFalse(keepMarketOriginalRequired(commandReview = true, savedRecord = keepMarketSavedRecords(state).forcesOriginal,
            freshCommandReview = keepMarketReviewWithoutEvidence(state)))
    }

    @Test fun `saved purchase payment review MFA held and recovery keep the original owner because payment consent lives there`() {
        val reserved = record("fill").copy(response = buildJsonObject { put("fill", buildJsonObject { put("id", key) }) })
        assertTrue(keepMarketRecordForcesOriginal(reserved))
        assertTrue(keepMarketSavedRecords(market(journal(reserved))).forcesOriginal)
        val paying = market(journal(record("fill")), selectedKey = key).copy(paymentReview = buildJsonObject { })
        assertTrue(keepMarketSavedRecords(paying).forcesOriginal)
        assertFalse(keepMarketReviewWithoutEvidence(paying.copy(commandReview = record("fill"))))
        assertTrue(keepMarketRecordForcesOriginal(record("listing").copy(held = true)))
        assertTrue(keepMarketOriginalRequired(mfa = true, freshCommandReview = true))
        assertTrue(keepMarketOriginalRequired(recovery = true, freshCommandReview = true))
        // A review that already carries a send attempt is evidence, not a fresh consent.
        val attempted = record("listing").copy(attempts = listOf("post:0"))
        assertFalse(keepMarketReviewWithoutEvidence(market(journal(attempted), key, attempted)))
    }

    @Test fun `unsent draft or lost answer shows the recovery row and blocks a new command`() {
        for (draft in listOf(record("listing"), record("fill"), record("cancellation").copy(attempts = listOf("post:0")))) {
            val saved = keepMarketSavedRecords(market(journal(draft), selectedKey = key))
            assertFalse(draft.kind, saved.forcesOriginal)
            assertEquals(draft.kind, key, saved.waiting?.key)
            assertEquals(KEEP_MARKET_WAITING, keepMarketCommandBlock(base, true, saved.waiting != null))
        }
        assertFalse(keepMarketRecordWaiting(record().copy(discardedUnsent = true)))
        val ui = project(market(journal(record("listing")), selectedKey = key))
        assertEquals(key, ui.command!!.waiting!!.opId)
        assertEquals(KEEP_MARKET_WAITING, ui.command!!.buyBlock)
    }

    @Test fun `completed listing keeps the designed sheet and offers its archive only for the selected record`() {
        // Branch C: a terminal listing does not block a new review, but holds a journal place that only an explicit
        // archive frees (RECEIPTS has no archive), so the selected one is offered; an unselected one is never nagged.
        val listed = record("listing").copy(response = buildJsonObject { put("id", key) })
        assertTrue(keepMarketRecordCompleted(listed))
        val selected = keepMarketSavedRecords(market(journal(listed), selectedKey = key))
        assertFalse(selected.forcesOriginal)
        assertNull(selected.waiting)
        assertEquals(key, selected.completed?.key)
        assertNull(keepMarketSavedRecords(market(journal(listed), selectedKey = "another")).completed)
        assertFalse(keepMarketRecordCompleted(listed.copy(held = true)))
        assertFalse(keepMarketRecordCompleted(record("fill").copy(response = buildJsonObject { })))
    }

    // ----------------------------------------------------------------------------------------------------- the entry

    @Test fun `entry opens BUY SELL or a known SELL item and anything else opens BUY`() {
        assertEquals(KeepMarketEntry(MarketTab.BUY, null), keepMarketEntry("BUY"))
        assertEquals(KeepMarketEntry(MarketTab.SELL, null), keepMarketEntry("SELL"))
        assertEquals(KeepMarketEntry(MarketTab.SELL, "navigation_kit"), keepMarketEntry("SELL:navigation_kit"))
        // An item the KEEP stall cannot trade never becomes a selection.
        assertEquals(KeepMarketEntry(MarketTab.SELL, null), keepMarketEntry("SELL:not-an-item"))
        assertEquals(KeepMarketEntry(MarketTab.BUY, null), keepMarketEntry("MY ORDERS"))
        assertEquals(KeepMarketEntry(MarketTab.BUY, null), keepMarketEntry(null))
    }

    // -------------------------------------------------------------------------------------------------------- gating

    @Test fun `BUY is refused without payments a kingdom or open orders and outside the lot bounds`() {
        val offer = MarketOfferUi(foreignLot, "navigation_kit", 7, 2_000_000_000, 9, Currency.KEEP, otherBase, seller, 2, false)
        val raw = book["items"].let { (it as JsonArray)[0] as JsonObject }
        assertNull(keepMarketBuyRefusal(offer, 2, raw, base, true, true, true, false))
        assertEquals(KEEP_MARKET_NO_PAYMENTS, keepMarketBuyRefusal(offer, 2, raw, base, true, false, true, false))
        assertEquals(KEEP_MARKET_NO_KINGDOM, keepMarketBuyRefusal(offer, 2, raw, null, true, true, true, false))
        assertEquals(KEEP_MARKET_PAUSED, keepMarketBuyRefusal(offer, 2, raw, base, false, true, true, false))
        assertEquals(KEEP_MARKET_WAITING, keepMarketBuyRefusal(offer, 2, raw, base, true, true, true, true))
        assertEquals(CHECKING_TEXT, keepMarketBuyRefusal(offer, 2, raw, base, true, true, false, false))
        // Below the server's minimum fill, above the lot, the player's own lot, or a row no longer on the page.
        assertEquals(KEEP_MARKET_QUANTITY, keepMarketBuyRefusal(offer, 1, raw, base, true, true, true, false))
        assertEquals(KEEP_MARKET_QUANTITY, keepMarketBuyRefusal(offer, 8, raw, base, true, true, true, false))
        assertEquals(KEEP_MARKET_QUANTITY, keepMarketBuyRefusal(offer.copy(isMine = true), 2, raw, base, true, true, true, false))
        assertEquals(KEEP_MARKET_QUANTITY, keepMarketBuyRefusal(offer, 2, null, base, true, true, true, false))
    }

    @Test fun `BUY primary keeps the designed states and turns a blocked command into an explained X`() {
        val ui = project()
        val buy = ui.base.buy!!
        assertTrue(buy.paymentsAvailable)
        assertEquals(PrimaryAction.START, keepMarketBuyPrimary(buy, null, false)!!.action)
        val blocked = keepMarketBuyPrimary(buy, KEEP_MARKET_PAUSED, false)!!
        assertEquals(CommandState.DISABLED, blocked.state)
        assertEquals(KEEP_MARKET_PAUSED, blocked.reason)
        assertEquals(CommandState.BUSY, keepMarketBuyPrimary(buy, null, true)!!.state)
        // Payments unavailable in this build is the designed X, whatever else blocks.
        val off = keepMarketBuyPrimary(project(command = KeepMarketCommandContext(false, true)).base.buy!!, KEEP_MARKET_PAUSED, false)!!
        assertEquals(KEEP_MARKET_NO_PAYMENTS, off.reason)
    }

    @Test fun `LIST is refused without a deeded selected kingdom a price or free units`() {
        val stock = SellableUi("navigation_kit", 7, null)
        assertNull(keepMarketListRefusal(stock, 3, "2500000000", true, true, true, false))
        assertEquals("Pick a kingdom you own to list.", keepMarketListRefusal(stock, 3, "2500000000", false, true, true, false))
        assertEquals(KEEP_MARKET_PAUSED, keepMarketListRefusal(stock, 3, "2500000000", true, false, true, false))
        assertEquals(KEEP_MARKET_WAITING, keepMarketListRefusal(stock, 3, "2500000000", true, true, true, true))
        assertEquals("Set a price first.", keepMarketListRefusal(stock, 3, null, true, true, true, false))
        assertEquals("None left to list.", keepMarketListRefusal(stock, 8, "2500000000", true, true, true, false))
        assertFalse(project(selectedBase = null, tab = MarketTab.SELL).base.sell?.listingAllowed == true)
        val locked = keepMarketSellPrimary(MarketSellUi(listOf(stock), null, 1, 2_500_000_000, null, null, 500, null, false), null)!!
        assertEquals(CommandState.LOCKED, locked.state)
    }

    @Test fun `take back only returns own free units of this kingdom`() {
        val own = lot(ownLot, wallet, base, "route_compass", "1900000000", "4", "3", "1")
        assertNull(keepMarketTakeBackRefusal(own, base, wallet, true, true, false))
        assertNotNull(keepMarketTakeBackRefusal(own, otherBase, wallet, true, true, false))
        assertNotNull(keepMarketTakeBackRefusal(lot(ownLot, seller, base, "route_compass", "1900000000", "4", "3", "1"), base, wallet, true, true, false))
        assertEquals("A sale in progress can't be taken back.",
            keepMarketTakeBackRefusal(lot(ownLot, wallet, base, "route_compass", "1900000000", "4", "0", "4"), base, wallet, true, true, false))
        assertEquals(KEEP_MARKET_PAUSED, keepMarketTakeBackRefusal(own, base, wallet, false, true, false))
    }

    // ------------------------------------------------------------------------------------------------------ the price

    @Test fun `typed price rejects zero negatives over precision and more than 64 bits`() {
        assertEquals("1900000000", keepMarketTypedPriceUnits("1.9", 9))
        assertEquals(1_900_000_000L, keepMarketTypedPrice("1.9", 9))
        for (bad in listOf("", "0", "0.000000000", "-1", "1.", ".5", "1.0000000001", "abc"))
            assertNull(bad, keepMarketTypedPriceUnits(bad, 9))
        // 2^64 fails the owner's 64-bit bound; 2^63 passes it but is not a signed Long the sheet can show.
        assertNull(keepMarketTypedPriceUnits("18446744073709551616", 0))
        assertNull(keepMarketTypedPriceUnits("9223372036854775808", 0))
        assertEquals("9223372036854775807", keepMarketTypedPriceUnits("9223372036854775807", 0))
        assertNull(keepMarketTypedPriceUnits("1.9", null))
        assertTrue(keepMarketPriceInput("12.5"))
        assertFalse(keepMarketPriceInput("1.2.3"))
        assertFalse(keepMarketPriceInput("-1"))
        assertFalse(keepMarketPriceInput("1".repeat(41)))
    }

    // ------------------------------------------------------------------------------------------------- projections

    @Test fun `offer places come only from this kingdom and wallet with free units`() {
        val rows = listings(
            lot(ownLot, wallet, base, "route_compass", "1900000000", "4", "3", "1"),
            lot("00000000-0000-4000-8000-000000000006", wallet, otherBase, "survey_lens", "1000000000", "2", "2", "0"),
            lot("00000000-0000-4000-8000-000000000007", seller, base, "survey_lens", "1000000000", "2", "2", "0"),
            lot("00000000-0000-4000-8000-000000000008", wallet, base, "survey_lens", "1000000000", "2", "0", "2"),
        )
        val place = keepMarketOfferPlaces(rows, 9, base, wallet, null).single()
        assertEquals(ownLot, place.listingId)
        assertEquals(StallPlaceState.ON_TABLE, place.state)
        assertEquals("1.9", place.price!!.amount)
        assertEquals("x3", place.count)
        // reservedQuantity also counts buyers still paying, so it is never called "sold".
        assertEquals("1 of 4 reserved", place.line)
        assertEquals(CommandState.ENABLED, place.action!!.state)
        assertEquals("BACK", place.action!!.caption)
        val blocked = keepMarketOfferPlaces(rows, 9, base, wallet, KEEP_MARKET_PAUSED).single().action!!
        assertEquals(CommandState.DISABLED, blocked.state)
        assertEquals(KEEP_MARKET_PAUSED, blocked.reason)
        assertTrue(keepMarketOfferPlaces(rows, 9, null, wallet, null).isEmpty())
        assertTrue(keepMarketOfferPlaces(rows, null, base, wallet, null).isEmpty())
    }

    @Test fun `command projection drops the observation footer and enables the designed primaries`() {
        val ui = project(tab = MarketTab.SELL)
        assertNull(ui.observation)
        assertNotNull(ui.command)
        assertTrue(ui.base.frame.history)
        assertEquals("LV 2", ui.base.frame.titleTag)
        assertNotNull(ui.base.header.sprite)
        // Two lots on a complete page: the header's live sentence counts them; a paged book would not claim a count.
        assertEquals("2 lots listed", ui.base.frame.live!!.text)
        assertNull(project(market().copy(listings = listings(*arrayOf(lot(foreignLot, seller, otherBase, "navigation_kit",
            "2000000000", "7", "7", "0")), next = true))).base.frame.live)
        val sell = ui.base.sell!!
        assertTrue(sell.listingAllowed)
        assertEquals(2_500_000_000L, sell.unitPrice)
        // The stores strip mixes categories (market-sell.png); only positively held units are listed.
        assertEquals(setOf("navigation_kit", "crystal_fragment"), sell.sellable.map { it.itemId }.toSet())
        assertEquals("2.5", ui.sellV2!!.priceEntry)
        assertEquals("Navigation Kit", sell.items["navigation_kit"]!!.name)
        val place = ui.offers!!.places.single()
        assertEquals(ownLot, place.listingId)
        assertFalse(ui.offers!!.placeDetails)
        assertNotNull(ui.offers!!.partialNotice)
        val buy = ui.base.buy!!
        assertTrue(buy.offers.single { it.offerId == ownLot }.isMine)
        assertFalse(buy.offers.single { it.offerId == foreignLot }.sellerName.contains(seller))
    }

    @Test fun `stale or undiscovered owners stay observed with no command affordance`() {
        val stale = project(current = false)
        assertNotNull(stale.observation)
        assertNull(stale.command)
        assertFalse(stale.base.buy!!.paymentsAvailable)
        val undiscovered = project(KeepEquipmentMarketState(error = "Unavailable"))
        assertNotNull(undiscovered.observation!!.unavailable)
        assertNull(undiscovered.command)
        // Without the command context the KEEP mount is the read-only observation it was.
        assertNotNull(project(command = null).observation)
        assertNull(project(command = null).command)
    }

    @Test fun `SOL STALL in command mode stays an unavailable frame with no Seal or lots`() {
        val ui = project(section = SOL_STALL_SECTION)
        val stall = ui.solStall!!
        assertFalse(stall.available)
        assertEquals("Vehicle trading is unavailable in this app.", stall.unavailableReason)
        assertNull(stall.seal)
        assertTrue(stall.lots.isEmpty())
        assertNull(ui.observation)
    }

    @Test fun `others price hint ignores own lots and unknown items`() {
        assertEquals("2", keepMarketOthersPrice(book, "navigation_kit", wallet, 9))
        assertNull(keepMarketOthersPrice(book, "route_compass", wallet, 9))
        assertNull(keepMarketOthersPrice(book, null, wallet, 9))
        assertNull(keepMarketOthersPrice(book, "navigation_kit", wallet, null))
    }

    @Test fun `book completeness and the lots sentence never invent a count`() {
        assertTrue(keepMarketBookComplete(book))
        assertFalse(keepMarketBookComplete(listings(next = true)))
        assertFalse(keepMarketBookComplete(null))
        assertNull(keepMarketLotsLive(null))
        assertEquals("1 lot listed", keepMarketLotsLive(1)!!.text)
        assertEquals("0 lots listed", keepMarketLotsLive(0)!!.text)
    }

    @Test fun `entry item and catalogue names come from the KEEP catalogue only`() {
        val items = keepMarketCraftItems()
        assertEquals(KeepEquipmentMarketCatalogue.itemIds, items.keys)
        assertEquals(listOf("crystal_fragment"), keepMarketSellable(mapOf("crystal_fragment" to 3L, "navigation_kit" to 0L)).map { it.itemId })
    }

    @Test fun `failed read keeps the last good book page for the projection`() {
        // A refresh error is shown as an error, never as a ready empty market.
        val ui = project(market().copy(error = "offline"))
        assertTrue(ui.base.buy!!.hydration is CraftHydration.Error)
        assertEquals(2, ui.base.buy!!.offers.size)
        assertNotNull(ui.command)
    }
}
