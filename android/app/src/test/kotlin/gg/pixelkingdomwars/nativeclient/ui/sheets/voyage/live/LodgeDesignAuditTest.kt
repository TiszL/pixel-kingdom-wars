package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.kitDrawable
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.AdvancedSendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ChartMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.GO_TO_BERTH_SUB
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeLockedVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgePickerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSendMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSheetR2Ui
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PASSPORT_TAB_ICON
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RewardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RouteFilter
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RouteRowState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripsEmpty
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.advancedSendLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.filterCount
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.filterRoutes
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.lodgeModeChipsShown
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.lodgePassportShown
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.lodgeTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.passportIsEmpty
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.passportRealmsLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.pickerShowsEmpty
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.routeRowState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.tripsEmpty
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.tripsFooterLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.vehicleCardDim
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Lodge panels measured against their design frames (design/final/voyage send, route-picker, trips, send-locked,
 * send-advanced, passport). Why it matters: these are the rules a player reads to decide where a boat can go and what
 * happens on a tap. A blocked route that names the wrong tier, a loading picker that says the archipelago is empty, a
 * "Next back in …" with nothing at sea or a button that promises a camera flight that never comes all tell the player
 * something untrue about the game.
 */
class LodgeDesignAuditTest {
    private val fx = VoyageFx

    private fun cutter(id: String = "inst-cut", status: VehicleStatus = VehicleStatus.DOCKED, left: Int? = 7) =
        VehicleUi(VehicleFamily.CARGO_CUTTER, 2, id, "berth-1", status, left, 10, null, 2)

    private fun trip(id: String, state: TripState, secondsLeft: Long?) = TripUi(id, cutter("v-$id", VehicleStatus.AWAY), null, null, null,
        if (state == TripState.AT_SEA) "1h 12m" else null, state, listOf(RewardUi("heartwood_logs", "40", RewardUi.Kind.CARGO, "", "Heartwood Logs")),
        null, title = id, secondsLeft = secondsLeft)

    /** No vehicle anywhere, a Berth built: the send-locked panel. [home] null = the home realm is not known yet. */
    private fun lockedSheet(home: String? = "elderwood") = lodgeSheetUi(fx.inputs(
        starter = fx.starter(fx.starterView(installation = null, home = home)), starterFleet = fx.starterFleet(installation = null),
        vehicles = fx.vehicles(fleet = fx.fleet())), LodgeLocalState())

    // send-advanced.png prints "Needs T4" on the Grade IV row a Tier 2 vehicle cannot reach; the vehicle cards on SEND use
    // the same "T<n>" (VoyageR2LogicTest pins it too). "Needs Tier 4" would be a second wording for the same rule.
    @Test fun `advanced rows above the vehicle tier read Needs T and the grade`() {
        val policy = fx.policy.copy(routes = fx.catalogue + OrdinaryRoute("prismforge-4", "prismforge", 3, "seeker-reach", 4))
        val inputs = fx.inputs(starter = fx.starter(fx.starterView(installation = null)), starterFleet = fx.starterFleet(installation = null),
            vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)),
                fx.routes("inst-cut", fx.preview("glasswake-1", "elderwood", "heartwood_logs", "home"),
                    fx.preview("prismforge-4", "seeker-reach", "rough_prism", "paid_realm"))), policy = policy)
        val ui = lodgeAdvancedUi(inputs, LodgeLocalState())
        val blocked = ui.routes.single { it.route.routeId == "prismforge-4" }
        assertEquals("Needs T4", blocked.blockedReason)
        assertEquals(RouteRowState.BLOCKED, routeRowState(blocked, ui.selectedRouteId))
        assertNull("a route the Cutter reaches is not blocked", ui.routes.single { it.route.routeId == "glasswake-1" }.blockedReason)
        assertEquals("the default is the first route it can sail, never the blocked one", "glasswake-1", ui.selectedRouteId)
        // Choosing the blocked row explains itself with the same words on the SEND primary.
        assertEquals("Needs T4", advancedSendLook(ui.copy(selectedRouteId = "prismforge-4"))!!.look.reason)
    }

    // SPEC §3 item 3: PASSPORT carries the realm-passport icon. The kit must resolve the name, or the tab draws nothing.
    @Test fun `the passport tab uses the realm passport icon`() {
        val ui = lodgeSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet()), LodgeLocalState())
        val passport = lodgeTabs(ui).single { it.id == LodgeSheetUi.TAB_PASSPORT }
        assertEquals("ui:realm-passport", passport.icon)
        assertEquals(PASSPORT_TAB_ICON, passport.icon)
        assertEquals(R.drawable.pkw_ui_item_realm_passport, kitDrawable(passport.icon))
    }

    // SPEC §4 loading: tiles render from the local catalogue at once; only counts and tags wait. "No islands match" is the
    // verdict of a loaded, filtered list, never of a list that has not arrived.
    @Test fun `a loading picker never says no islands match`() {
        val loading = LodgePickerUi(emptyList(), null, null, emptyMap(), RouteFilter.ALL, loading = true)
        assertFalse(pickerShowsEmpty(loading, emptyList()))
        val loaded = LodgePickerUi(lodgeSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet()), LodgeLocalState())
            .send!!.routes, "elderwood", null, emptyMap(), RouteFilter.CAN_SAIL)
        val shown = filterRoutes(loaded.routes, loaded.filter, loaded.bestDockedTier)
        assertTrue("with no docked tier nothing can sail: a loaded CAN SAIL filter is honestly empty", pickerShowsEmpty(loaded, shown))
    }

    // The picker's tiles come from the policy catalogue before any route preview arrives (SPEC §4 loading).
    @Test fun `the picker draws the catalogue islands before the route previews arrive`() {
        val ui = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)), starterFleet = fx.starterFleet(installation = null),
            vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)), routes = null)), LodgeLocalState())
        val picker = requireNotNull(ui.picker) { "crafted vehicles and no island chosen open the picker" }
        assertEquals(listOf("glasswake-1", "ashreef-2"), picker.routes.map { it.routeId })
        assertFalse("the home realm is known from the starter view, so nothing is waiting", picker.loading)
        assertFalse(pickerShowsEmpty(picker, filterRoutes(picker.routes, picker.filter, picker.bestDockedTier)))
    }

    // With the home realm unknown every island is held; the picker must not print "HOME 0" or call every realm PERMIT.
    @Test fun `while the home realm is unknown the picker counts and tags wait with the ellipsis`() {
        val ui = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null, home = null)), starterFleet = fx.starterFleet(installation = null),
            vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)), routes = null)), LodgeLocalState())
        val picker = ui.picker!!
        assertTrue(picker.loading)
        assertEquals("the tiles still draw from the catalogue", 2, picker.routes.size)
        assertEquals(UNKNOWN, filterCount(picker.routes, RouteFilter.HOME, picker.bestDockedTier, picker.loading))
    }

    // SPEC §5a item 7: "Next back in 1h 12m" only while something is at sea; with nothing out it would promise a return.
    @Test fun `TRIPS pins the next return only while something is at sea`() {
        assertNull("nothing at sea, nothing docked: no promise", tripsFooterLine(emptyList(), emptyList(), null))
        assertEquals("Next back in 1h 12m", tripsFooterLine(listOf(trip("a", TripState.AT_SEA, 4320)), emptyList(), "1h 12m"))
        assertEquals("an unknown time at sea is the ellipsis, never a guess", "Next back in $UNKNOWN",
            tripsFooterLine(listOf(trip("a", TripState.AT_SEA, null)), emptyList(), null))
        assertNull("COLLECT is the primary when one is back", tripsFooterLine(listOf(trip("r", TripState.READY, 0)), emptyList(), null))
        assertNull("SEND ANOTHER is the primary when a vehicle is docked", tripsFooterLine(listOf(trip("a", TripState.AT_SEA, 60)), listOf(cutter()), "1m"))
    }

    // SPEC §5a empty state: SEND only when a docked vehicle can sail; otherwise the door is the Berth (a SEND that can only
    // refuse would be a dead door).
    @Test fun `an empty TRIPS tab sends only when a vehicle can sail, else points to the Berth`() {
        assertEquals(TripsEmpty.SEND, tripsEmpty(emptyList(), listOf(cutter())))
        assertEquals(TripsEmpty.BERTH, tripsEmpty(emptyList(), listOf(cutter(left = 0))))
        assertEquals(TripsEmpty.BERTH, tripsEmpty(emptyList(), emptyList()))
        assertEquals(TripsEmpty.NONE, tripsEmpty(listOf(trip("a", TripState.AT_SEA, 60)), emptyList()))
    }

    // send-locked.png: the header shows the nearest home-realm Grade I island over the empty sea; an unknown home realm
    // shows the empty sea, never a guessed island.
    @Test fun `the locked SEND header shows the home Grade I island, or the empty sea while home is unknown`() {
        val locked = lockedSheet()
        assertEquals(LodgeLockedVariant.NO_VEHICLE, locked.locked?.variant)
        assertEquals(ChartMode.EMPTY, locked.chart.mode)
        assertEquals("glasswake-1", locked.chart.route?.routeId)
        assertNull(lockedSheet(home = null).chart.route)
    }

    // The shore draws the player's own Lodge tier (the passport header's rule), never a fixed tier.
    @Test fun `the header shore uses the Lodge's own tier`() {
        assertEquals(4, lockedSheet().chart.lodgeTier)
        assertEquals("authored art stops at tier 4", 4, lodgeArtTier(listOf(Building("l", "lodge", 9, 0, 0))))
        assertNull("a Lodge still being built has no tier yet", lodgeArtTier(listOf(Building("l", "lodge", 3, 0, 0, underConstruction = true))))
        assertNull(lodgeArtTier(null))
    }

    // Tonight GO TO BERTH opens the Berth sheet; the frame's "the camera flies there" would describe a flight that does not
    // happen (renderer work).
    @Test fun `GO TO BERTH says what the tap does`() {
        assertEquals("opens the Berth", GO_TO_BERTH_SUB)
        assertFalse(GO_TO_BERTH_SUB.contains("camera"))
    }

    // send-locked.png has no STARTER / CRAFTED chips: its one door is GO TO BERTH. A player already in CRAFTED keeps them.
    @Test fun `the mode chips stay off the locked SEND panel`() {
        val locked = lockedSheet()
        assertFalse(lodgeModeChipsShown(LodgeSheetR2Ui(locked, craftedOffered = true)))
        val crafted = LodgeSheetR2Ui(locked, mode = LodgeSendMode.CRAFTED, craftedOffered = true,
            advanced = AdvancedSendUi(null, emptyList(), null, null, null))
        assertTrue("CRAFTED keeps STARTER one tap away", lodgeModeChipsShown(crafted))
        assertFalse(lodgeModeChipsShown(LodgeSheetR2Ui(locked.copy(tab = LodgeSheetUi.TAB_TRIPS), craftedOffered = true)))
    }

    // SPEC E1.1 loading: before the first passport snapshot the tab draws "…" stats and skeleton stamps, not a blank body,
    // and it never claims "Your first trip stamps your home realm" before the records say so.
    @Test fun `a passport that has not arrived draws a loading skeleton`() {
        val shown = lodgePassportShown(LodgeSheetR2Ui(lockedSheet(), passport = null))
        assertTrue(shown.loading)
        assertEquals(listOf(UNKNOWN, UNKNOWN, UNKNOWN), listOf(shown.renown, shown.trips, shown.days))
        assertEquals("$UNKNOWN realms", passportRealmsLine(shown.stamps))
        assertFalse(passportIsEmpty(shown))
    }

    // send.html `.vc.dim`: every card that cannot be chosen is dimmed; the two that can are not.
    @Test fun `vehicle cards dim exactly when they cannot be chosen`() {
        val dim = VehicleCardState.entries.filter(::vehicleCardDim).toSet()
        assertEquals(setOf(VehicleCardState.AWAY, VehicleCardState.TOO_LOW_TIER, VehicleCardState.COAST_ONLY, VehicleCardState.WORN_OUT,
            VehicleCardState.BUSY), dim)
    }
}
