package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure rules of the craft cluster's round-2 frames (design/final/craft/SPEC.md "Round 2 additions" + critic fixes). */
class CraftR2LogicTest {
    private val keep = 1_000_000_000L
    private val frostglass = CraftItemUi("frostglass", "Frostglass", craftItemIcon("frostglass"), "Refine here")
    private val sell = MarketSellUi(listOf(SellableUi("frostglass", 14, 0)), "frostglass", 10, 19 * keep / 10, keep / 10, 18 * keep / 10,
        500, null, listingAllowed = true, items = mapOf("frostglass" to frostglass))
    private val lot = SolLotUi("lot-1", "voyage:veh-survey-balloon-t2", "T2", PriceUi(Currency.SOL, "0.08", PriceStatus.OK), "Rook of Ashford",
        "10/10 trips", "Survey Balloon T2")
    private val stall = SolStallUi("sol", listOf(lot), "lot-1", null)

    // Copy rule "an order is your offer": only the visible word changes; the registry / Destination ids stay.
    @Test fun `the third Market tab reads OFFERS but keeps its Destination id`() {
        val tabs = marketTabsR2()
        assertEquals(listOf("BUY", "SELL", "OFFERS", "OWNED"), tabs.map { it.label })
        assertEquals(listOf(MarketTab.BUY, MarketTab.SELL, MarketTab.ORDERS, MarketTab.OWNED), tabs.map { it.id })
        assertEquals("!", marketTabsR2(soldSinceLastVisit = true)[2].badge?.text)
    }

    // E1.1: only CAN SELL sells in the stall; an outside-only deed opens the system browser; the rest explain why not.
    @Test fun `OWNED routes the primary by the selected thing's state and never sells what is in use`() {
        assertEquals(OwnedRoute.SELL, ownedRoute(OwnedState.CAN_SELL))
        assertEquals(OwnedRoute.OPEN_OUTSIDE, ownedRoute(OwnedState.OUTSIDE_ONLY))
        listOf(OwnedState.IN_USE, OwnedState.INSTALLED, OwnedState.ON_SALE, OwnedState.LISTING, null).forEach {
            assertEquals(OwnedRoute.EXPLAIN, ownedRoute(it))
            assertTrue(ownedReason(it)!!.isNotBlank())
        }
        assertEquals("CAN SELL" to Verb.GREEN, ownedTag(OwnedState.OUTSIDE_ONLY))
        assertEquals("INSTALLED" to Verb.STONE, ownedTag(OwnedState.INSTALLED))
        assertEquals("ON SALE" to Verb.BLUE, ownedTag(OwnedState.ON_SALE))
        assertNull("a listing in flight draws dots, not a tag", ownedTag(OwnedState.LISTING))
    }

    @Test fun `OWNED is empty only when nothing at all can be shown and it is not loading`() {
        val none = OwnedUi(emptyList(), 0, emptyList(), null, null, null, walletLinked = true)
        assertTrue(ownedIsEmpty(none))
        assertFalse(ownedIsEmpty(none.copy(load = CraftHydration.Loading)))
        assertFalse(ownedIsEmpty(none.copy(stores = listOf(LotUi("frostglass", "", "×14", "")))))
        assertTrue("an unlinked wallet hides wallet rows", ownedIsEmpty(none.copy(walletLinked = false,
            wallet = listOf(OwnedRowUi("a", "", "", "", OwnedState.CAN_SELL)))))
    }

    // E1.2 states + design correction 7: a CHECKING price is enabled navigation, UNAVAILABLE off, SHORT need-more; an
    // uncertain result offers CHECK and never a second BUY; only an authoritative refusal may RETRY.
    @Test fun `the SOL stall primary follows the money rules`() {
        assertEquals(SolAction.BUY, solBuyPrimary(stall)!!.action)
        assertEquals("Survey Balloon T2 · 0.08 SOL", solBuyPrimary(stall)!!.sub)
        val checking = stall.copy(lots = listOf(lot.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING))))
        assertEquals(CommandState.ENABLED, solBuyPrimary(checking)!!.state)
        assertEquals("Survey Balloon T2 · … SOL", solBuyPrimary(checking)!!.sub)
        val unavailable = stall.copy(lots = listOf(lot.copy(price = PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE))))
        assertEquals(CommandState.DISABLED, solBuyPrimary(unavailable)!!.state)
        val short = stall.copy(lots = listOf(lot.copy(price = PriceUi(Currency.SOL, "0.08", PriceStatus.SHORT))))
        assertEquals(SolAction.NEED_MORE, solBuyPrimary(short)!!.action)
        assertEquals(SolAction.LINK_WALLET, solBuyPrimary(stall.copy(walletLinked = false))!!.action)
        assertEquals(CommandState.BUSY, solBuyPrimary(stall.copy(stage = MoneyStage.SENDING))!!.state)
        assertEquals(SolAction.CHECK, solBuyPrimary(stall.copy(stage = MoneyStage.FAILED))!!.action)
        assertEquals(SolAction.CHECK, solBuyPrimary(stall.copy(stage = MoneyStage.FAILED, outcome = SolOutcomeUi(false, "x")))!!.action)
        assertEquals(SolAction.RETRY, solBuyPrimary(stall.copy(stage = MoneyStage.FAILED, outcome = SolOutcomeUi(true, "x")))!!.action)
        assertNull(solBuyPrimary(stall.copy(available = false)))
        assertNull(solBuyPrimary(stall.copy(lots = emptyList())))
    }

    @Test fun `an uncertain SOL result says it is being checked, never that nothing was spent`() {
        val line = solOutcomeLine(SolOutcomeUi(false, "the balloon appears in OWNED when the realm confirms"))!!
        assertTrue(line.startsWith("Being checked"))
        assertFalse(line.contains("Nothing was spent"))
        assertEquals("Sold to someone else. Nothing was spent.", solOutcomeLine(SolOutcomeUi(true, "Sold to someone else. Nothing was spent.")))
        assertNull(solOutcomeLine(null))
    }

    // The realm's cut is named only inside the Seal, from the server's fee basis points; a quote still checking never arms.
    @Test fun `the SOL BUY Seal carries the cut in its fine print and waits for the quote`() {
        val seal = solBuySeal(lot, 500, 1_000L)
        assertEquals("BUY SURVEY BALLOON T2", seal.title)
        assertEquals("The realm's cut:", seal.finePrint!!.lead)
        assertEquals("5% of the price, taken from the seller's share.", seal.finePrint!!.text)
        assertEquals("0.08 SOL", seal.confirmSub)
        assertTrue(seal.quoteReady)
        assertFalse(solBuySeal(lot.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING)), 500, 0L).quoteReady)
        assertEquals("… of the price, taken from the seller's share.", realmCutOfPrice(null))
    }

    // Part two: two rows of three places on counters; free places fill up to the server's limit, never invented.
    @Test fun `the stall grid pads with free places up to the server limit`() {
        val taken = listOf(StallPlaceUi("A", "", "x1", null, StallPlaceState.SOLD, "", null, "a"),
            StallPlaceUi("B", "", "x1", null, StallPlaceState.ON_TABLE, "", null, "b"))
        val grid = stallGrid(taken, 6)
        assertEquals(2, grid.size)
        assertEquals(listOf(StallPlaceState.SOLD, StallPlaceState.ON_TABLE, StallPlaceState.FREE), grid[0].map { it!!.state })
        assertTrue(grid[1].all { it!!.state == StallPlaceState.FREE })
        val noLimit = stallGrid(taken, null)
        assertEquals(1, noLimit.size)
        assertNull("no server limit: the row is padded with nothing, not a made-up free place", noLimit[0][2])
        assertTrue(stallGrid(emptyList(), null).isEmpty())
    }

    @Test fun `SELL MORE counts free places and is off when the stall is full`() {
        val ui = MarketOffersUi(emptyList(), 2, 6)
        assertEquals("2 free places", offersPrimary(ui).sub)
        assertEquals(PrimaryAction.OPEN_SELL, offersPrimary(ui).action)
        assertEquals("1 free place", freePlacesLine(1))
        assertEquals("… free places", freePlacesLine(null))
        assertEquals(CommandState.DISABLED, offersPrimary(ui.copy(freePlaces = 0)).state)
        assertEquals(PrimaryAction.RETRY, offersPrimary(ui.copy(load = CraftHydration.Error("x"))).action)
        assertEquals("A sale in progress can't be taken back.",
            offersFootnote(listOf(StallPlaceUi("D", "", "", null, StallPlaceState.PAYING, "", null))))
    }

    // Critic fix: "You get 18 KEEP / the realm's cut is 1 of 19"; the fee rounds up so "You get" never flatters.
    @Test fun `the earnings card names the realm's cut and prefers the server lines`() {
        val derived = realmCutLines(MarketSellV2Ui(sell))
        assertEquals("You get 18.05 KEEP", derived.first)
        assertEquals("the realm's cut is 0.95 of 19", derived.second)
        val server = realmCutLines(MarketSellV2Ui(sell, earnLine = "You get 18.0 KEEP", cutLine = "the realm's cut is 1.0 of 19.0"))
        assertEquals("You get 18.0 KEEP" to "the realm's cut is 1.0 of 19.0", server)
        assertEquals("the realm's cut is … of …", realmCutLines(MarketSellV2Ui(sell.copy(feeBps = null))).second)
    }

    @Test fun `others' price tag hides when nobody sells and shows the ellipsis only while loading with nothing to keep`() {
        assertEquals("Others sell it for about 1.8", othersTagText("1.8", loading = true))
        assertEquals("Others sell it for about …", othersTagText(null, loading = true))
        assertNull(othersTagText(null, loading = false))
    }

    @Test fun `the LIST Seal repeats the cut from the server fee`() {
        val seal = listSeal(sell, 0L)!!
        assertEquals("LIST 10 FROSTGLASS", seal.title)
        assertEquals(listOf("Buyers pay 1.9 KEEP each."), seal.lines)
        assertEquals("The realm keeps a cut of each sale (5%). You get 18.05 KEEP if all 10 sell.", seal.finePrint!!.text)
        assertEquals("Paid out to your wallet as they sell.", seal.note)
        assertFalse(listSeal(sell.copy(feeBps = null), 0L)!!.quoteReady)
        assertEquals(MarketSealStage.BUSY, listSeal(sell, 0L, sending = true)!!.stage)
        assertNull(listSeal(sell.copy(sellable = emptyList()), 0L))
    }

    // E1.3: server day totals, no axis; an unknown day is no bar, never a zero bar; a small day still shows.
    @Test fun `day bars scale to the busiest day and never turn unknown into zero`() {
        val days = listOf(DayBarUi("Fri", "36", false, 36), DayBarUi("Sat", "48", false, 48), DayBarUi("Sun", null, false, null),
            DayBarUi("Mon", "1", false, 1), DayBarUi("Tue", "0", false, 0))
        assertEquals(listOf(48, 64, null, 2, 0), dayBarHeights(days, 64))
        assertEquals(listOf<Int?>(null, null), dayBarHeights(listOf(DayBarUi("a", null, false, null), DayBarUi("b", null, true, null)), 64))
    }

    @Test fun `haul quantities get one plus sign and unknown stays an ellipsis`() {
        assertEquals("+12", haulQuantityText("12"))
        assertEquals("+12", haulQuantityText("+12"))
        assertEquals("…", haulQuantityText(""))
        assertEquals("…", haulQuantityText(null))
        assertEquals("288 in all", weekTotalLine("288"))
        assertEquals("… in all", weekTotalLine(null))
    }

    @Test fun `the recovery row keeps the last list after a failed check`() {
        assertEquals("Updated 2 min ago" to "Hauls are counted by the realm", historyRecoveryLines("2 min ago", null))
        assertEquals("Couldn't check · showing 14:20", historyRecoveryLines("2 min ago", "14:20").first)
    }
}
