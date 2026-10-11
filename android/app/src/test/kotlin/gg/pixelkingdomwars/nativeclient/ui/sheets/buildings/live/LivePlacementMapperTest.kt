package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.ui.unit.IntOffset
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlaceTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlacementState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlateTone
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.placeLook
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live placement band (PlacementFacts -> PlacementUi) and the construction plates. Why it matters: PLACE spends Shards
 * and a builder. It may send only where the current dialog's ✓ PLACE was enabled; walls, hero recruitment and KEEP-priced
 * builds keep their own reviewed flows; the spot's validity stays the server's (no locally invented "taken" tiles); and a
 * construction timer never shows "0 % done" for a deadline it cannot read.
 */
class LivePlacementMapperTest {
    private fun facts(type: String = "barracks", tile: Pair<Int, Int>? = 4 to 7, currency: String? = "SHARDS", amount: String? = "1,500",
        raw: String? = "1500", balance: String? = "40943", freeBuilders: Int = 1, available: Boolean = true, readOnly: Boolean = false,
        blocked: Boolean = false, busy: Boolean = false, heroOffer: Boolean = false) = PlacementFacts(
        type, "BARRACKS", "ui_portrait_barracks_t1", 3, tile, currency, amount, raw, "2h", balance, freeBuilders, 2, "2h 14m",
        available, readOnly, blocked, busy, heroOffer)

    @Test fun `a picked tile with a payable Shards price is VALID and PLACE sends`() {
        val ui = livePlacementUi(facts())!!
        assertEquals(PlacementState.VALID, ui.state)
        assertEquals(IntOffset(4, 7), ui.tile)
        assertEquals("1,500", ui.price.amount)
        assertTrue("validity is the server's: no local taken tiles", ui.takenTiles.isEmpty())
        assertEquals(PlaceTap.PLACE, placeLook(ui.state, ui.price, ui.reason).tap)
    }

    @Test fun `walls, hero recruitment and KEEP prices keep their current flow`() {
        assertNull(livePlacementUi(facts(type = "wall")))
        assertNull(livePlacementUi(facts(heroOffer = true)))
        assertNull(livePlacementUi(facts(type = "mine", currency = "KEEP")))
    }

    @Test fun `PLACE cannot send in every case the current dialog disabled it`() {
        fun tap(f: PlacementFacts) = livePlacementUi(f)!!.let { placeLook(it.state, it.price, it.reason).tap }
        assertEquals("no tile yet", PlaceTap.NONE, tap(facts(tile = null)))
        assertEquals("no price", PlaceTap.NONE, tap(facts(amount = null, raw = null, currency = null)))
        assertEquals("not available", PlaceTap.NONE, tap(facts(available = false)))
        assertEquals("busy", PlaceTap.NONE, tap(facts(busy = true)))
        assertEquals("saved payment", PlaceTap.NONE, tap(facts(blocked = true)))
        assertEquals("paused base", PlaceTap.NONE, tap(facts(readOnly = true)))
        assertEquals("no free builder routes to Builders", PlaceTap.BUILDERS, tap(facts(freeBuilders = 0)))
        assertEquals("short routes to Need-more", PlaceTap.NEED_MORE, tap(facts(balance = "10")))
    }

    @Test fun `every off state says why and the hint says what to do next`() {
        val noTile = livePlacementUi(facts(tile = null))!!
        assertEquals("Tap a spot first", noTile.reason)
        assertTrue(noTile.hint!!.startsWith("Tap where the barracks goes"))
        assertEquals("Orders are paused here", livePlacementUi(facts(readOnly = true))!!.reason)
        assertEquals("free in 2h 14m", livePlacementUi(facts(freeBuilders = 0))!!.builders)
        val noPrice = livePlacementUi(facts(amount = null, raw = null, currency = null))!!
        assertEquals(PriceStatus.UNAVAILABLE, noPrice.price.status)
        assertNull(noPrice.price.amount)
    }

    @Test fun `short placement offers the Mines, unknown balance never claims short`() {
        assertEquals("1,490", livePlacementNeedMore(facts(balance = "10"), MineFact("mine-1", null))?.blocks?.single()?.more)
        assertEquals(PlacementState.VALID, livePlacementUi(facts(balance = null))!!.state)
        assertNull(livePlacementNeedMore(facts(balance = null), MineFact("mine-1", null)))
    }

    @Test fun `construction plates show builds and upgrades, soonest first, unknown never zero`() {
        val sites = liveConstructionSites(listOf(
            ConstructionJobFact("a", "BARRACKS", "upgrade", 4_320, "1h 12m", 0.4f),
            ConstructionJobFact("b", "CANNON", "build", 9, "9s", 0.97f),
            ConstructionJobFact("c", "MINE", "upgrade", null, null, null),
            ConstructionJobFact("d", "VAULT", "repair", 30, "30s", 0.5f),
        ))
        assertEquals(listOf("b", "a", "c"), sites.map { it.buildingId })
        assertEquals("Cannon: being built, 9s left", sites[0].description)
        assertEquals("Mine: upgrading, time unknown", sites[2].description)
        assertNull("an unknown progress is an empty meter, not zero", sites[2].progress)
        assertTrue(sites.all { it.tone == PlateTone.STRIPE })
    }

    @Test fun `only anchored sites are drawn, and none while something else owns the screen`() {
        val sites = liveConstructionSites(listOf(ConstructionJobFact("a", "BARRACKS", "build", 60, "1m", 0.5f),
            ConstructionJobFact("b", "CANNON", "build", 90, "1m 30s", 0.2f)))
        val anchor = PxRect(10f, 20f, 50f, 60f)
        val layer = liveConstructionLayer(sites, mapOf("a" to anchor), hidden = false)
        assertEquals(listOf("a"), layer.sites.map { it.buildingId })
        assertEquals(anchor, layer.sites.single().anchor)
        assertTrue(layer.visible)
        assertFalse(liveConstructionLayer(sites, mapOf("a" to anchor), hidden = true).visible)
    }
}
