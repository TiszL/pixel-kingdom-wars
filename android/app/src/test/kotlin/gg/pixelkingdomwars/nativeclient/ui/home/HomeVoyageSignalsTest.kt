package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFlight
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.ContextChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageFx
import org.junit.Assert.*
import org.junit.Test

/**
 * Home trip signals (voyage SPEC §2 `home-return.png`). Why it matters: the bubble is a one-tap collect of real cargo,
 * so the number on it must be the server's own net for the first returned trip (a client-side sum of several trips would
 * promise cargo nobody stated), the starter boat returns by itself and must never offer a COLLECT, and a herald that
 * says "is back" when nothing is back sends the player to an empty TRIPS tab.
 */
class HomeVoyageSignalsTest {
    private val fx = VoyageFx
    private val fleet = arrayOf(fx.row("inst-cut", "cargo_cutter", 2, 7), fx.row("inst-bal", "survey_balloon", 1, 9))

    /** A crafted trip whose scheduled return has passed and has no server return yet: READY. */
    private fun back(id: String, net: String, installationId: String = "inst-cut") =
        fx.expedition(id, installationId, "glasswake-1", "2030-01-01T15:00:00.000Z", "2030-01-01T18:00:00.000Z", net = net)

    /** A crafted trip still at sea (NOW is 18:20Z). */
    private fun sailing(id: String, installationId: String, returns: String) =
        fx.expedition(id, installationId, "glasswake-1", "2030-01-01T18:00:00.000Z", returns)

    private fun trips(vararg records: VehicleRecord): List<TripUi> =
        homeVoyageTrips(fx.inputs(vehicles = fx.vehicles(fx.fleet(*fleet), pending = records.toList())))

    @Test fun `ready bubble shows the receipted main cargo of the first returned trip`() {
        val ready = requireNotNull(voyageReturnMarkers(trips(back("e1", "40"))).ready) { "a READY crafted trip must raise the bubble" }
        assertEquals("the badge is the server's net cargo, signed", "+40", ready.mainReward)
        assertEquals(listOf("e1"), ready.tripIds)
        assertEquals("one trip back has no count badge", 0, ready.extraCount)
        assertEquals("ui:ready-status", ready.icon)
        val unknown = requireNotNull(voyageReturnMarkers(trips(back("e9", "not-a-number"))).ready)
        assertEquals("an unreadable amount stays unknown, never +0", UNKNOWN, unknown.mainReward)
    }

    @Test fun `several returns add a count badge instead of summing guesses`() {
        val ready = requireNotNull(voyageReturnMarkers(trips(back("e1", "40"), back("e2", "60"))).ready)
        assertEquals("the first trip's own cargo, not a client-side +100", "+40", ready.mainReward)
        assertEquals("SPEC 2 Several READY: a +n count beside it", 1, ready.extraCount)
        assertEquals("one tap collects every READY trip", listOf("e1", "e2"), ready.tripIds)
    }

    @Test fun `away plate shows only the soonest returning vehicle`() {
        val markers = voyageReturnMarkers(trips(sailing("e3", "inst-cut", "2030-01-01T21:00:00.000Z"),
            sailing("e4", "inst-bal", "2030-01-01T19:32:00.000Z")))
        assertNull("nothing is back yet", markers.ready)
        val away = requireNotNull(markers.away) { "a vehicle at sea must show its TimerPlate" }
        assertEquals("the balloon is back first, so it is the one on the Berth", VehicleFamily.SURVEY_BALLOON, away.family)
        assertEquals(1, away.tier)
        assertEquals("1h 12m", away.returnsIn)
        val progress = requireNotNull(away.progress) { "both instants are known, so the meter is known" }
        assertTrue("20 of 92 minutes sailed", progress > 0.2f && progress < 0.25f)
    }

    @Test fun `starter flight counts at sea but never becomes a ready bubble`() {
        // Past its scheduled time: the server credits starter returns itself, so it stays at sea until the next snapshot.
        val flight = StarterExpeditionFlight("exp-1", "inst-starter", fx.starterRoute("coastal_survey"), "2030-01-01T15:00:00.000Z",
            "2030-01-01T18:00:00.000Z", "term-1", "a".repeat(64))
        val trips = homeVoyageTrips(fx.inputs(starter = fx.starter(fx.starterView(flight = flight)), starterFleet = fx.starterFleet()))
        val markers = voyageReturnMarkers(trips)
        assertNull("a starter return is automatic: no COLLECT bubble", markers.ready)
        val away = requireNotNull(markers.away) { "the starter flight still counts at sea" }
        assertEquals(VehicleFamily.STARTER, away.family)
        assertNull("the starter has no tier", away.tier)
        assertEquals("Due back", away.returnsIn)
        assertNull("no herald for an automatic return", homeVoyageHerald(trips))
        assertNull(homeVoyageContextChip(trips))
    }

    @Test fun `herald names the returned vehicle and opens the TRIPS tab`() {
        val ready = homeVoyageReadyTrips(trips(back("e2", "60", "inst-bal"), back("e1", "40")))
        val herald = requireNotNull(homeVoyageHerald(ready))
        assertEquals("the first trip given is named", "Survey Balloon is back ▸", herald.text)
        assertEquals("ui:ready-status", herald.icon)
        assertEquals("the key is the whole READY set, sorted, so only a new return restarts the banner", "voyage:e1,e2", herald.key)
        assertEquals(FeatureId("lodge.underway"), herald.target)
        assertTrue("a herald door must reach a Home-mounted Lodge tab, never a dead row", "lodge.underway" in HOME_MOUNTED_FEATURES)
        val cutterFirst = requireNotNull(homeVoyageHerald(ready.sortedBy { it.tripId }))
        assertEquals("Cargo Cutter is back ▸", cutterFirst.text)
        assertEquals("SPEC 2 ContextChip: Ready, Lodge, and a tap flies the camera there",
            ContextChipUi(FeatureId("lodge.focus"), "ui:ready-status", "Ready", "Lodge ▸"), homeVoyageContextChip(ready))
    }

    @Test fun `no ready trip means no herald and no context chip`() {
        val atSea = trips(sailing("e3", "inst-cut", "2030-01-01T21:00:00.000Z"))
        assertNull(homeVoyageHerald(atSea))
        assertNull(homeVoyageContextChip(atSea))
        assertNull(homeVoyageHerald(emptyList()))
        assertNull(homeVoyageContextChip(emptyList()))
    }

    @Test fun `a collected trip is never announced or offered again`() {
        val collected = fx.expedition("e1", "inst-cut", "glasswake-1", "2030-01-01T15:00:00.000Z", "2030-01-01T18:00:00.000Z",
            returned = true, net = "40")
        val trips = trips(collected)
        assertNull("its cargo is already home: no bubble", voyageReturnMarkers(trips).ready)
        assertNull("and no herald saying it is back", homeVoyageHerald(trips))
    }
}
