package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.FantasyParcel
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFlight
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ArchipelagoPrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachAllocation
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachPrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.archipelagoPrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.isShort
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.reachLayout
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.Access
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageFx
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The World tab's archipelago island panel and Solana Reach Seeker-tile sheet. Why it matters: both replace old notes that
 * told players something false or nothing at all, and both sit next to money. A Reach price the server did not send, or an
 * UNLOCK with no owner behind it, would ask a player to pay for nothing; an island SEND without a real route would send the
 * player to the Lodge for a trip the server does not offer; and a base still loading must never read as "build a Lodge".
 */
class ArchipelagoReachMappersTest {
    private val fx = VoyageFx
    private val chains = listOf(
        json("""{"id":"glasswake","name":"Glasswake Keys","islands":[{},{},{},{}]}"""),
        json("""{"id":"aurora","name":"Aurora Shoals","islands":[{},{},{},{},{}]}"""))
    private val realmNames = mapOf("elderwood" to "Elderwood", "cinderfall" to "Cinderfall")

    private fun parcel(tileId: Int, allocation: String, availability: String) = FantasyParcel.from(json(
        """{"worldId":"fantasy-v1","tile":{"worldId":"fantasy-v1","tileId":$tileId,"realmId":"seeker-reach","allocation":"$allocation"},"availability":"$availability"}"""))

    private fun island(id: String, buildings: List<Building>? = fx.buildings, routes: List<OrdinaryRoute>? = fx.catalogue) =
        archipelagoPanelUi(id, chains, realmNames, buildings, fx.starter(), routes)

    // ---- Solana Reach ----

    @Test fun `a Seeker tile is always OFF with no price and no button, because no unlock owner exists and an amount must come from the server`() {
        val ui = reachTileUi(parcel(7 * 2048 + 1204, "seeker", "reserved"), 2048, hasDeed = true)
        assertEquals(ReachStatus.OFF, ui.status)
        assertEquals(ReachAllocation.SEEKER, ui.allocation)
        assertNull("no client-side price, ever", ui.price)
        assertNull("no client-side balance", ui.mySkr)
        assertFalse("the DEVNET PRICE tag only goes with a server price", ui.devnet)
        // holding a deed changes nothing: with no owner there is no UNLOCK, INFO or value card to draw
        val layout = reachLayout(ui.status, ui.hasDeed, isShort(ui.price, ui.mySkr))
        assertEquals(ReachPrimary.NONE, layout.primary); assertFalse(layout.info); assertFalse(layout.cards)
        assertEquals("Seeker tiles are not open on this server yet", layout.line)
    }

    @Test fun `the Seeker tile is named by its deed column and row, as the realm map's card names a deed`() {
        assertEquals("1204, 7", reachTileUi(parcel(7 * 2048 + 1204, "seeker", "reserved"), 2048, null).tileLabel)
        // with no grid known the label is still the tile, grouped, never a blank or a made-up spot
        assertEquals("15,540", reachTileUi(parcel(15_540, "seeker", "reserved"), 0, null).tileLabel)
    }

    @Test fun `only a reserved Seeker allocation opens the Reach sheet, every other tile keeps the parcel card`() {
        assertTrue(worldReachTileApplies(parcel(1, "seeker", "reserved")))
        assertFalse("a Genesis reserve is not a Reach tile", worldReachTileApplies(parcel(1, "genesis", "reserved")))
        assertFalse("open land is bought through the parcel card", worldReachTileApplies(parcel(1, "ordinary", "available")))
        assertFalse("a kingdom on a Seeker tile is a base: the parcel card shows it", worldReachTileApplies(parcel(1, "seeker", "occupied")))
        assertFalse("no read yet is not a Reach tile", worldReachTileApplies(null))
    }

    // ---- archipelago ----

    @Test fun `a catalogued island carries the server catalogue's grade, tier and realm, and SEND hands the player to the Lodge with no price`() {
        val ui = island("glasswake/0")
        assertEquals("the EXPLORE slot is 0-based, the route id 1-based", "glasswake-1", ui.route?.routeId)
        assertEquals("GLASSWAKE KEYS ISLE 1", ui.name)
        assertEquals("the starter read's home realm makes it a HOME island", Access.HOME, ui.route?.access)
        assertEquals(1, ui.grade); assertEquals(1, ui.minTier)
        assertEquals("Glasswake Keys, near Elderwood", ui.realmLine)
        assertEquals("Needs a tier 1 vehicle or better", ui.needsLine)
        assertEquals(CommandState.ENABLED, ui.send.state)
        assertNull("the island never prices a trip: the Lodge does", ui.send.price)
        assertEquals("from your Lodge", ui.send.sub)
        assertEquals(ArchipelagoPrimary.SEND, archipelagoPrimary(ui.hasLodge, ui.route != null))
    }

    @Test fun `an island the catalogue does not list, or no catalogue at all, has no route so SEND cannot appear`() {
        val unlisted = island("glasswake/3")
        assertNull(unlisted.route); assertNull(unlisted.grade); assertNull(unlisted.minTier); assertNull(unlisted.realmLine); assertNull(unlisted.needsLine)
        assertEquals("GLASSWAKE KEYS ISLE 4", unlisted.name)
        assertEquals(ArchipelagoPrimary.NONE, archipelagoPrimary(unlisted.hasLodge, unlisted.route != null))
        // a server whose catalogue carries no island list: no island is joined however the ids line up
        val unread = island("glasswake/0", routes = null)
        assertNull(unread.route)
        assertEquals(ArchipelagoPrimary.NONE, archipelagoPrimary(unread.hasLodge, unread.route != null))
        // an unknown chain still has a name to show
        assertEquals("REEFHOLD ISLE 2", island("reefhold/1").name)
    }

    @Test fun `the starter boat's coast loops never join an island, so its flight is never listed as a trip there`() {
        // Starter route ids are coast loops (`coastal_survey`, `common_<realm>`): listing one on an island would tell the
        // player their boat is somewhere it is not, even on an island the Lodge does sail to.
        val flight = StarterExpeditionFlight("exp-1", "inst-starter", fx.starterRoute("coastal_survey"), "2030-01-01T15:00:00.000Z",
            "2030-01-01T21:00:00.000Z", "term-1", "a".repeat(64))
        val ui = archipelagoPanelUi("glasswake/0", chains, realmNames, fx.buildings, fx.starter(fx.starterView(flight = flight)), fx.catalogue)
        assertEquals("the island itself is listed", "glasswake-1", ui.route?.routeId)
        assertTrue("the panel says No expeditions here yet", ui.trips.isEmpty())
        // and the starter routes alone (no island catalogue) never make an island route
        assertNull(archipelagoPanelUi("glasswake/0", chains, realmNames, fx.buildings, fx.starter(fx.starterView(flight = flight)), null).route)
    }

    @Test fun `unknown buildings keep the Lodge door while a loaded base without a Lodge offers BUILD A LODGE`() {
        assertTrue("a base still loading never claims there is no Lodge", island("glasswake/0", buildings = null).hasLodge)
        assertTrue(island("glasswake/0", buildings = listOf(Building("lodge-1", "lodge", 1, 0, 0, underConstruction = true))).hasLodge)
        val none = island("glasswake/0", buildings = listOf(Building("keep-1", "keep", 3, 0, 0)))
        assertFalse(none.hasLodge)
        assertEquals(ArchipelagoPrimary.BUILD_LODGE, archipelagoPrimary(none.hasLodge, none.route != null))
    }
}
