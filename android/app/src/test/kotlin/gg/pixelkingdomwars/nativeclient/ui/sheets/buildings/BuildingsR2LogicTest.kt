package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The buildings cluster's round 2 rules (design/final/buildings/SPEC.md R2.1-R2.5, E1.1-E1.2, design correction 7). Why
 * they matter: FINISH, HIRE and EXPAND spend Gems and SOL; ROW and REMOVE spend Shards and builders. A CHECKING price must
 * stay a door into the Seal (never a dead button, never a spend), a SHORT price must route to Need-more (never
 * auto-spend), a lost answer must say "being checked" and keep the recovery action (never "nothing was spent"), and an
 * unknown number must read "…", never a "0" the player could act on.
 */
class BuildingsR2LogicTest {
    private fun price(status: PriceStatus, amount: String? = "38", currency: Currency = Currency.GEMS) = PriceUi(currency, amount, status)

    // ---- Prices ----

    @Test fun `a checking price is navigation, short goes to need-more, unavailable only explains`() {
        assertEquals(PriceTap.OPEN, priceTap(price(PriceStatus.CHECKING, null)))
        assertEquals(PriceTap.OPEN, priceTap(price(PriceStatus.OK)))
        assertEquals(PriceTap.OPEN, priceTap(null))
        assertEquals(PriceTap.NEED_MORE, priceTap(price(PriceStatus.SHORT)))
        assertEquals(PriceTap.EXPLAIN, priceTap(price(PriceStatus.UNAVAILABLE, null)))
    }

    // ---- Builders ----

    @Test fun `the builders header counts working and free, and never invents numbers`() {
        assertEquals("2 working · 1 free", buildersHeaderLine(owned = 3, free = 1))
        assertEquals("all free", buildersHeaderLine(owned = 2, free = 2))
        assertEquals("unknown counts read …", UNKNOWN, buildersHeaderLine(owned = 0, free = 0))
        assertEquals("impossible counts read …", UNKNOWN, buildersHeaderLine(owned = 2, free = 3))
    }

    @Test fun `FINISH stays a door while checking, waits while busy, and an uncertain row keeps FINISH`() {
        assertEquals(FinishKind.FINISH, finishLook(price(PriceStatus.CHECKING, null), busy = false, checking = false).kind)
        assertEquals(FinishKind.NEED_MORE, finishLook(price(PriceStatus.SHORT), busy = false, checking = false).kind)
        assertEquals(FinishKind.OFF, finishLook(price(PriceStatus.UNAVAILABLE, null), busy = false, checking = false).kind)
        assertEquals("busy wins: nothing can be sent twice", FinishKind.BUSY, finishLook(price(PriceStatus.OK), busy = true, checking = true).kind)
        val lost = finishLook(price(PriceStatus.OK), busy = false, checking = true)
        assertTrue("a lost answer says it is being checked", lost.beingChecked)
        assertEquals("and FINISH stays the recovery action", FinishKind.FINISH, lost.kind)
    }

    @Test fun `HIRE never pays on tap and follows the money sequence after the Seal`() {
        val sol = price(PriceStatus.OK, "0.25", Currency.SOL)
        assertEquals(HireKind.HIRE, hireKind(sol, MoneyStage.READY, checking = false))
        assertEquals(HireKind.MONEY, hireKind(sol, MoneyStage.SENDING, checking = false))
        assertEquals(HireKind.CHECKING, hireKind(sol, MoneyStage.SENDING, checking = true))
        assertEquals(HireKind.NEED_MORE, hireKind(sol.copy(status = PriceStatus.SHORT), MoneyStage.READY, checking = false))
        assertEquals(HireKind.OFF, hireKind(sol.copy(status = PriceStatus.UNAVAILABLE), MoneyStage.READY, checking = false))
        assertEquals("0.25 SOL once · paid from your wallet", hireSubLine(sol))
        assertEquals("a checking price never shows a number", "… SOL once · paid from your wallet", hireSubLine(sol.copy(status = PriceStatus.CHECKING)))
    }

    // ---- Need more ----

    @Test fun `the best door is the primary and is never repeated as a block button`() {
        val mines = NeedMoreDoorUi("shards", "GO TO MINES", "8,400 ready", FeatureId("mine.collect"))
        val gems = NeedMoreDoorUi("gem", "GEMS TO SHARDS", null, FeatureId("goldforge.gems"))
        val market = NeedMoreDoorUi("ui:market-menu", "MARKET", null, FeatureId("market.buy"))
        assertEquals(listOf(gems), blockDoors(listOf(gems, mines), mines))
        assertEquals("at most two doors per block", 2, blockDoors(listOf(gems, market, gems.copy(destination = FeatureId("x"))), mines).size)
        assertEquals("have 40,943 · need 52,400", haveNeedLine("40,943", "52,400"))
        assertEquals("have … · need …", haveNeedLine(null, ""))
    }

    // ---- Quotes ----

    @Test fun `a quote commits only at a payable price, and a lost answer keeps RETRY without claiming nothing was spent`() {
        val shards = PriceUi(Currency.SHARDS, "10,500", PriceStatus.OK)
        val ready = quoteLook(UpgradeState.READY, shards, null)
        assertEquals(QuoteKind.COMMIT, ready.kind); assertTrue(ready.sends)
        val checking = quoteLook(UpgradeState.READY, shards.copy(amount = null, status = PriceStatus.CHECKING), null)
        assertEquals("only the commit waits for the price", QuoteKind.WAIT_PRICE, checking.kind); assertFalse(checking.sends)
        assertEquals(QuoteKind.NEED_MORE, quoteLook(UpgradeState.SHORT, shards.copy(status = PriceStatus.SHORT), null).kind)
        assertEquals(QuoteKind.NEED_BUILDER, quoteLook(UpgradeState.NO_BUILDER, shards, null).kind)
        assertEquals(QuoteKind.STARTING, quoteLook(UpgradeState.BUSY, shards, null).kind)
        val lost = quoteLook(UpgradeState.VERIFYING, shards, null)
        assertEquals(QuoteKind.RETRY, lost.kind); assertTrue(lost.sends)
        assertEquals(BEING_CHECKED, lost.reason)
        assertFalse(lost.reason!!.contains("Nothing was spent"))
        val empty = quoteLook(UpgradeState.READY, shards, null, nothingToDo = true, emptyReason = "All walls are LV 4")
        assertEquals(QuoteKind.OFF, empty.kind); assertEquals("All walls are LV 4", empty.reason); assertFalse(empty.sends)
    }

    @Test fun `the unverified walls-stay-up sentence only shows when the server confirms it`() {
        assertEquals("Tap a wall in the row to leave it out.", wallRowHint(false))
        assertTrue(wallRowHint(true).endsWith("Walls stay up while they upgrade."))
        assertEquals("7 × 1,500", unitTimesCount(7, PriceUi(Currency.SHARDS, "1,500", PriceStatus.OK)))
        assertEquals(null, unitTimesCount(7, PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING)))
        assertEquals("10,500 Shards in all", inAllLine(PriceUi(Currency.SHARDS, "10,500", PriceStatus.OK)))
    }

    // ---- Under construction ----

    @Test fun `the plate turns solid in the last ten seconds and reads seconds, never m-ss`() {
        assertEquals(PlateLook("1h 12m", PlateTone.STRIPE), constructionPlateLook(4_320, "1h 12m"))
        assertEquals(PlateLook("9s", PlateTone.SOLID), constructionPlateLook(9, "0:09"))
        assertEquals(PlateLook("10s", PlateTone.SOLID), constructionPlateLook(10, null))
        assertEquals("unknown time is …, never 0s", PlateLook(UNKNOWN, PlateTone.STRIPE), constructionPlateLook(null, null))
    }

    // ---- Keep STORES ----

    @Test fun `the stores chip sums the active tab and refuses to guess when a count is unknown`() {
        fun item(count: String) = StoreItemUi("i$count", "timer", "X", count, null, false, "", null, null)
        val groups = listOf(StoreGroupUi("a", "timer", "USE NOW", "", null, listOf(item("3"), item("1"), item("2"), item("1"))),
            StoreGroupUi("b", "itm_helm", "HERO GEAR", "", null, listOf(item("1"), item("1"), item("2"), item("1"))),
            StoreGroupUi("c", "x", "WRITS", "", null, listOf(item("1"), item("1"))))
        assertEquals("14 in your bag", storesChipLine(StoresTab.BAG, groups))
        assertEquals("… in your bag", storesChipLine(StoresTab.BAG, groups + StoreGroupUi("d", "x", "X", "", null, listOf(item(UNKNOWN)))))
        assertEquals("×3", storesCount("3")); assertEquals(UNKNOWN, storesCount(UNKNOWN)); assertEquals(UNKNOWN, storesCount(""))
    }

    @Test fun `items that cannot be used from the Keep show only GO`() {
        val use = CommandUi(FeatureId("keep.use"), "", "USE", null, true, CommandState.ENABLED, null, null)
        val go = use.copy(id = FeatureId("focus.workshop"), caption = "GO", primary = false)
        assertEquals(StoresFooter.GO_AND_USE, storesFooter(use, go))
        assertEquals(StoresFooter.GO_ONLY, storesFooter(null, go))
        assertEquals(StoresFooter.NONE, storesFooter(null, null))
    }

    // ---- Keep EXPAND ----

    private val expand = ExpandUi(index = 0, max = 6, sizeNow = 14, sizeNext = 16, newTiles = null, obstaclesInRing = 9, reqKeepLevel = 12,
        keepLevel = 12, price = PriceUi(Currency.SOL, "0.15", PriceStatus.OK), nextReqKeepLevel = 14, ring = RectTiles(0, 0, 16, 16), saved = null)

    @Test fun `EXPAND is a door into the Seal even while the price is checked, and never at full size`() {
        assertEquals(ExpandPrimaryKind.EXPAND, expandPrimary(expand))
        assertEquals(ExpandPrimaryKind.EXPAND, expandPrimary(expand.copy(price = expand.price.copy(amount = null, status = PriceStatus.CHECKING))))
        assertEquals(ExpandPrimaryKind.UNAVAILABLE, expandPrimary(expand.copy(price = expand.price.copy(status = PriceStatus.UNAVAILABLE))))
        assertEquals(ExpandPrimaryKind.NEED_MORE, expandPrimary(expand.copy(price = expand.price.copy(status = PriceStatus.SHORT))))
        assertEquals(ExpandPrimaryKind.LOCKED, expandPrimary(expand.copy(keepLevel = 11)))
        assertEquals(ExpandPrimaryKind.HIDDEN, expandPrimary(expand.copy(index = 6, sizeNow = 26, sizeNext = null)))
        assertEquals(ExpandPrimaryKind.READ_ONLY, expandPrimary(expand.copy(readOnly = "No land deed")))
        assertEquals(ExpandPrimaryKind.MONEY, expandPrimary(expand.copy(saved = MoneyOp(MoneyStage.SENDING))))
        assertEquals("a lost answer is checked, never re-sent blind", ExpandPrimaryKind.CHECK,
            expandPrimary(expand.copy(saved = MoneyOp(MoneyStage.SENDING, uncertain = true))))
    }

    @Test fun `the table says room to build from the ring area and unknown obstacles read …`() {
        val rows = expandRows(expand)
        assertEquals(ExpandRow("map", "Land size", "14×14", "16×16"), rows[0])
        assertEquals("16² − 14² new tiles", "+60 tiles", rows[1].after)
        assertEquals("+9", rows[2].after)
        assertEquals("at Keep Lv 14", rows[3].after)
        assertEquals(UNKNOWN, expandRows(expand.copy(obstaclesInRing = null))[2].after)
        val full = expandRows(expand.copy(sizeNow = 26, sizeNext = null))
        assertEquals("full size keeps Land size only", 1, full.size)
        assertEquals(KeepTag("KEEP LV 12 ✓", true), expandKeepTag(expand))
        assertEquals(KeepTag("Needs Keep Lv 14", false), expandKeepTag(expand.copy(reqKeepLevel = 14)))
        assertEquals("1 OF 6", expandIndexTag(0, 6)); assertEquals("6 OF 6", expandIndexTag(6, 6))
    }
}
