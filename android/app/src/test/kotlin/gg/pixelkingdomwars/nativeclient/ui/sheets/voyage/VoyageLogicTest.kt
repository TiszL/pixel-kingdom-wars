package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

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

/** The pure rules behind the Lodge and Berth sheets (design/final/voyage/SPEC.md). */
class VoyageLogicTest {
    private fun vehicle(family: VehicleFamily, tier: Int?, id: String, status: VehicleStatus = VehicleStatus.DOCKED, left: Int? = 7,
        max: Int? = 10, returnsAt: String? = null) = VehicleUi(family, tier, id, "berth-$id", status, left, max, returnsAt, tier ?: 0)

    private fun route(id: String, realm: String, grade: Int, access: Access = Access.HOME, myTrip: TripRef? = null, permitReason: String? = null) =
        RouteUi(id, "chain", grade - 1, id, realm, realm.replaceFirstChar { it.uppercase() }, "res", grade, access, myTrip, permitReason = permitReason)

    private fun trip(id: String, state: TripState, secondsLeft: Long?, reward: String = "40") = TripUi(id, vehicle(VehicleFamily.CARGO_CUTTER, 2, "v-$id"),
        null, "coastal_survey", null, null, state, listOf(RewardUi("heartwood_logs", reward, RewardUi.Kind.CARGO, "", "Heartwood Logs")), null,
        title = id, secondsLeft = secondsLeft)

    private val preview = PreviewUi("3h 20m", "21:40", "120", "12", "108", emptyList(), null, null)

    // Unknown server values must never read as a real number (DESIGN-SYSTEM §9: unknown is "…", never 0).
    @Test fun `unknown trips and tiers render as the ellipsis, never zero`() {
        assertEquals("…/10 left", tripsLeftShort(null, 10))
        assertEquals("7 of … trips left", tripsLeftLong(7, null))
        assertNull("an unknown meter is an empty track, not 0 % done", tripsFraction(null, 10))
        assertNull(tripsFraction(3, 0))
        assertEquals("T…", tierTag(null))
        assertEquals("…", gradeNumeral(7))
        assertEquals("Cargo Cutter T…", vehicleTitle(vehicle(VehicleFamily.CARGO_CUTTER, null, "c")))
        assertEquals("Starter Boat", vehicleTitle(vehicle(VehicleFamily.STARTER, null, "s")))
    }

    // SPEC §7 / §9: the meter warns (gold) when two trips or fewer remain, so service comes before a dead vehicle.
    @Test fun `the trips meter turns gold at two trips left`() {
        assertEquals(Verb.GOLD, tripsMeterVerb(2))
        assertEquals(Verb.GOLD, tripsMeterVerb(0))
        assertEquals(Verb.GREEN, tripsMeterVerb(3))
        assertEquals(Verb.GREEN, tripsMeterVerb(null))
        assertEquals(0.7f, tripsFraction(7, 10)!!, 1e-6f)
    }

    // SPEC §3 table: a vehicle at sea is AWAY whatever else is true; worn out reads "Service" before a tier problem, because
    // service is the fix; the starter on an island route is "Coast only"; a tier below the grade is "Needs Tn".
    @Test fun `vehicle card states follow the SPEC priority`() {
        val awayAndWorn = vehicle(VehicleFamily.CARGO_CUTTER, 1, "a", VehicleStatus.AWAY, left = 0)
        assertEquals(VehicleCardState.AWAY, vehicleCardState(awayAndWorn, null, 3))
        val wornLowTier = vehicle(VehicleFamily.CARGO_CUTTER, 1, "w", left = 0)
        assertEquals(VehicleCardState.WORN_OUT, vehicleCardState(wornLowTier, null, 3))
        assertEquals(VehicleCardState.COAST_ONLY, vehicleCardState(vehicle(VehicleFamily.STARTER, null, "s"), null, 1))
        assertEquals(VehicleCardState.TOO_LOW_TIER, vehicleCardState(vehicle(VehicleFamily.SURVEY_BALLOON, 1, "b"), null, 2))
        assertEquals(VehicleCardState.SELECTED, vehicleCardState(vehicle(VehicleFamily.CARGO_CUTTER, 2, "c"), "c", 2))
        assertEquals(VehicleCardState.ELIGIBLE, vehicleCardState(vehicle(VehicleFamily.CARGO_CUTTER, 3, "c"), "x", 2))
        assertEquals("Needs T2", vehicleCardLine(vehicle(VehicleFamily.SURVEY_BALLOON, 1, "b"), VehicleCardState.TOO_LOW_TIER, 2))
        assertEquals("1h 12m", vehicleCardLine(vehicle(VehicleFamily.COURIER_AIRSHIP, 3, "a", VehicleStatus.AWAY, returnsAt = "1h 12m"), VehicleCardState.AWAY, 2))
        assertFalse(canSelect(VehicleCardState.AWAY))
        assertTrue(canSelect(VehicleCardState.ELIGIBLE))
    }

    // SPEC §3 item 6: never spend a stronger vehicle than the island needs; among equals keep the one with most trips left.
    @Test fun `the default vehicle is the lowest tier that reaches the grade, then most trips left`() {
        val t3 = vehicle(VehicleFamily.COURIER_AIRSHIP, 3, "t3")
        val t2few = vehicle(VehicleFamily.CARGO_CUTTER, 2, "t2few", left = 2)
        val t2many = vehicle(VehicleFamily.SURVEY_BALLOON, 2, "t2many", left = 9)
        val t1 = vehicle(VehicleFamily.SURVEY_BALLOON, 1, "t1")
        val awayT2 = vehicle(VehicleFamily.EXPEDITION_BARGE, 2, "awayT2", VehicleStatus.AWAY, left = 10)
        val wornT2 = vehicle(VehicleFamily.EXPEDITION_BARGE, 2, "wornT2", left = 0)
        val starter = vehicle(VehicleFamily.STARTER, null, "s")
        val all = listOf(t3, t2few, t2many, t1, awayT2, wornT2, starter)
        assertEquals("t2many", defaultVehicle(all, 2)?.installationId)
        assertEquals("t1", defaultVehicle(all, 1)?.installationId)
        assertNull("nothing docked reaches Grade IV", defaultVehicle(all, 4))
        assertEquals("a starter route defaults to the starter", "s", defaultVehicle(all, null)?.installationId)
    }

    // SPEC §4: CAN SAIL counts what a docked vehicle reaches; counts are "…" while loading, never a guessed 0.
    @Test fun `picker filters and counts`() {
        val routes = (1..4).map { route("home-$it", "elderwood", it) } + (1..4).map { route("paid-$it", "cinderfall", it, Access.PAID_REALM) }
        assertEquals(8, filterRoutes(routes, RouteFilter.ALL, 2).size)
        assertEquals(4, filterRoutes(routes, RouteFilter.CAN_SAIL, 2).size)
        assertEquals(0, filterRoutes(routes, RouteFilter.CAN_SAIL, null).size)
        assertEquals(4, filterRoutes(routes, RouteFilter.HOME, null).size)
        assertEquals("…", filterCount(routes, RouteFilter.ALL, 2, loading = true))
        assertEquals("4", filterCount(routes, RouteFilter.CAN_SAIL, 2, loading = false))
    }

    // SPEC §4 item 4: the home realm leads, the rest are alphabetical, islands by grade.
    @Test fun `realm blocks put home first then alphabetical`() {
        val routes = listOf(route("f2", "frostveil", 2), route("c1", "cinderfall", 1), route("e3", "elderwood", 3), route("e1", "elderwood", 1))
        val blocks = realmBlocks(routes, "elderwood")
        assertEquals(listOf("elderwood", "cinderfall", "frostveil"), blocks.map { it.realmId })
        assertEquals(listOf(1, 3), blocks.first().routes.map { it.grade })
    }

    // SPEC §4 tile table: my own trip is a door (TRIPS / collect) even on a locked island; locks come before selection.
    @Test fun `island tile states`() {
        assertEquals(IslandTileState.MY_TRIP_BACK, islandTileState(route("r", "x", 4, myTrip = TripRef("t", TripState.READY)), 1, "r"))
        assertEquals(IslandTileState.MY_TRIP_AWAY, islandTileState(route("r", "x", 4, myTrip = TripRef("t", TripState.AT_SEA)), 1, null))
        assertEquals(IslandTileState.LOCKED_TIER, islandTileState(route("r", "x", 3), 2, "r"))
        assertEquals(IslandTileState.LOCKED_PERMIT, islandTileState(route("r", "x", 1, Access.PAID_REALM, permitReason = "Permits sold out"), 2, null))
        assertEquals(IslandTileState.AVAILABLE, islandTileState(route("r", "x", 1, Access.PAID_REALM), 2, null))
        assertEquals(IslandTileState.SELECTED, islandTileState(route("r", "x", 2), 2, "r"))
    }

    // SPEC §4 item 3: the header tells the player when a vehicle that unlocks the grade comes back.
    @Test fun `grade header shows when an away vehicle unlocks a grade`() {
        assertEquals("needs T2+" to false, gradeHeaderLine(2, 2, mapOf(3 to "1h")))
        assertEquals("T3+ in 1h" to true, gradeHeaderLine(3, 2, mapOf(3 to "1h", 4 to "5h")))
        assertEquals("the lowest away tier that reaches the grade wins", "T3+ in 1h" to true, gradeHeaderLine(3, null, mapOf(4 to "5h", 3 to "1h")))
        assertEquals("needs T4+" to false, gradeHeaderLine(4, 2, mapOf(3 to "1h")))
    }

    // SPEC §5a: READY first (collect is one tap), then the soonest return; unknown times last.
    @Test fun `trips order, summary and the TRIPS primary`() {
        val trips = listOf(trip("late", TripState.AT_SEA, 9000), trip("unknown", TripState.AT_SEA, null), trip("back", TripState.READY, null),
            trip("soon", TripState.AT_SEA, 60), trip("done", TripState.COLLECTED, null))
        assertEquals(listOf("back", "soon", "late", "unknown"), orderTrips(trips).map { it.tripId })
        assertEquals("3 at sea · 1 back", tripsSummary(trips))
        assertEquals(TripsPrimary.COLLECT, tripsPrimary(trips, emptyList()))
        val atSea = trips.filter { it.state == TripState.AT_SEA }
        assertEquals(TripsPrimary.SEND_ANOTHER, tripsPrimary(atSea, listOf(vehicle(VehicleFamily.SURVEY_BALLOON, 1, "b"))))
        assertEquals("a worn vehicle cannot be sent", TripsPrimary.NONE, tripsPrimary(atSea, listOf(vehicle(VehicleFamily.SURVEY_BALLOON, 1, "b", left = 0))))
        assertEquals("+40 Heartwood Logs", collectSubLine(trips))
        assertEquals("2 trips back", collectSubLine(trips + trip("back2", TripState.READY, null)))
    }

    @Test fun `trips tab badge is green when back, red count at sea, none when idle`() {
        assertEquals("!" to true, tripsTabBadge(listOf(trip("a", TripState.READY, null), trip("b", TripState.AT_SEA, 5))))
        assertEquals("2" to false, tripsTabBadge(listOf(trip("a", TripState.AT_SEA, 1), trip("b", TripState.AT_SEA, 5))))
        assertNull(tripsTabBadge(emptyList()))
    }

    // SPEC §3 states: a departure in flight is checked, never re-sent; LOCKED/DISABLED always carry a reason.
    @Test fun `SEND look follows the SPEC priority`() {
        fun look(previewState: PreviewState = PreviewState.READY, p: PreviewUi? = preview, orders: Boolean = true, locked: String? = null,
            busy: Boolean = false, pending: Boolean = false, route: Boolean = true) =
            sendLook(route, true, previewState, p, orders, null, locked, busy, pending, null)
        assertEquals(CommandState.BUSY, look(pending = true, busy = true).state)
        assertEquals("Checking departure", look(pending = true).label)
        assertEquals(CommandState.LOCKED, look(locked = "Expeditions are not open on this server yet").state)
        assertEquals("This base is read-only", look(orders = false).reason)
        assertEquals("Sending", look(busy = true).label)
        assertEquals("Choose an island first", look(route = false).reason)
        assertEquals("Checking route", look(previewState = PreviewState.LOADING).label)
        assertEquals(CommandState.DISABLED, look(previewState = PreviewState.ERROR, p = null).state)
        val short = preview.copy(supplies = listOf(SupplyUi("thorn_fibre", "", "Thorn Fibre", "6", "2", true, "Need 4 more Thorn Fibre")))
        assertEquals("Need 4 more Thorn Fibre", look(p = short).reason)
        assertEquals(CommandState.ENABLED, look().state)
        assertEquals("back at 21:40", look().sub)
    }

    // M48 / money honesty: a permit the server has not priced is never shown as free.
    @Test fun `an unpriced permit reads as the ellipsis`() {
        val unpriced = preview.copy(permit = PermitUi(PriceUi(Currency.SOL, null, PriceStatus.CHECKING), "Cinderfall"))
        assertEquals("permit about … SOL", sendLook(true, true, PreviewState.READY, unpriced, true, null, null, false, false, null).sub)
        assertEquals("0.03 SOL", permitAmount(PermitUi(PriceUi(Currency.SOL, "0.03", PriceStatus.OK), "Cinderfall")))
    }

    // SPEC §7 item 7: an install in flight offers CHECK (by-key recovery), never a second INSTALL.
    @Test fun `fleet primary per selection`() {
        val empty = VehicleUi(VehicleFamily.SURVEY_BALLOON, null, null, "b", VehicleStatus.EMPTY, null, null, null, 0)
        assertEquals(FleetAction.CHECK, fleetPrimary(empty, pendingInstall = true, null, walletLinked = true, ordersAllowed = true).action)
        assertEquals(CommandState.LOCKED, fleetPrimary(empty, false, null, walletLinked = false, ordersAllowed = true).look?.state)
        assertEquals("INSTALL BALLOON", fleetPrimary(empty, false, null, true, true).look?.label)
        assertEquals(CommandState.LOCKED, fleetPrimary(empty, false, "Vehicles are not open on this server yet", true, true).look?.state)
        assertEquals(FleetAction.NONE, fleetPrimary(vehicle(VehicleFamily.COURIER_AIRSHIP, 3, "a", VehicleStatus.AWAY), false, null, true, true).action)
        assertEquals(FleetAction.SERVICE, fleetPrimary(vehicle(VehicleFamily.CARGO_CUTTER, 2, "c", left = 0), false, null, true, true).action)
        val docked = fleetPrimary(vehicle(VehicleFamily.CARGO_CUTTER, 2, "c"), false, null, true, true)
        assertEquals(FleetAction.SEND_FROM_LODGE, docked.action)
        assertEquals("navigation is blue", Verb.BLUE, docked.look?.verb)
    }

    @Test fun `berth rows and the service badge`() {
        assertEquals("EMPTY" to Verb.STONE, berthRowTag(VehicleUi(VehicleFamily.SURVEY_BALLOON, null, null, "b", VehicleStatus.EMPTY, null, null, null, 0)))
        assertEquals("SERVICE" to Verb.RED, berthRowTag(vehicle(VehicleFamily.CARGO_CUTTER, 2, "c", left = 0)))
        assertEquals("AWAY" to Verb.BLUE, berthRowTag(vehicle(VehicleFamily.CARGO_CUTTER, 2, "c", VehicleStatus.AWAY)))
        assertEquals("At sea · 7 of 10 trips left", berthRowLine(vehicle(VehicleFamily.COURIER_AIRSHIP, 3, "a", VehicleStatus.AWAY)))
        assertEquals("Coast trips · always free", berthRowLine(vehicle(VehicleFamily.STARTER, null, "s")))
        assertEquals("Empty · flies to Grade I+", berthRowLine(VehicleUi(VehicleFamily.SURVEY_BALLOON, null, null, "b", VehicleStatus.EMPTY, null, null, null, 0)))
        // The starter is never serviced; unknown trips do not count; one trip left does.
        val berths = listOf(vehicle(VehicleFamily.STARTER, null, "s", left = 0), vehicle(VehicleFamily.CARGO_CUTTER, 2, "c", left = 1),
            vehicle(VehicleFamily.COURIER_AIRSHIP, 3, "a", left = null), vehicle(VehicleFamily.SURVEY_BALLOON, 1, "b", left = 2))
        assertEquals(1, serviceBadgeCount(berths))
    }

    @Test fun `service primary needs the hand-in and says the fee`() {
        val missing = servicePrimary(ServiceOp.RESTORE_USES, true, null, null, handInPresent = false, "Cargo Cutter T2", "0.00002", false, null)
        assertEquals(CommandState.DISABLED, missing?.state)
        assertEquals("You need a Cargo Cutter T2 in your wallet", missing?.reason)
        val ok = servicePrimary(ServiceOp.UPGRADE, true, null, 3, true, "Cargo Cutter T2", null, false, null)
        assertEquals("UPGRADE TO T3", ok?.label)
        assertEquals("an unreviewed fee is never 0", "network fee about … SOL", ok?.sub)
        assertEquals(CommandState.LOCKED, servicePrimary(ServiceOp.UPGRADE, false, "Max tier", null, true, "x", "1", false, null)?.state)
        assertNull(servicePrimary(null, true, null, null, true, "x", "1", false, null))
    }

    // Design correction 7: only an authoritative refusal may say nothing was sent; an uncertain result is being checked.
    @Test fun `money errors never claim nothing was sent unless the refusal is authoritative`() {
        assertEquals("Wallet didn't answer. Your request is being checked.", moneyErrorLine(VoyageMoneyErrorUi("Wallet didn't answer.", authoritative = false)))
        assertEquals("You declined in the wallet. Nothing was sent.", moneyErrorLine(VoyageMoneyErrorUi("You declined in the wallet", authoritative = true)))
        assertTrue(VoyageMoneyErrorUi("x", authoritative = false).recoverable)
        assertFalse(VoyageMoneyErrorUi("x", authoritative = true).recoverable)
        assertEquals(MoneyStage.READY, moneyStage(VoyageSealState.ARMED))
        assertEquals(MoneyStage.FAILED, moneyStage(VoyageSealState.ERROR))
        assertEquals(MoneyStage.SENT, moneyStage(VoyageSealState.SENT))
    }

    // SPEC §0.4: art is drawn at a whole number of device pixels per art pixel (k is written at density 2.0).
    @Test fun `pixel art scale and windows are whole device pixels`() {
        assertEquals(2, deviceArtScale(2, 2f))
        assertEquals(3, deviceArtScale(2, 3f))
        assertEquals(4, deviceArtScale(2, 3.5f))
        assertEquals(1, deviceArtScale(1, 1f))
        assertEquals("never below one", 1, deviceArtScale(1, 0.5f))
        // A bottom-anchored berth: art row 94 sits on the window's bottom edge.
        // x: 41 − 48 × 2 = −55 (art x 48 on the window's centre); y: 114 − 94 × 2 = −74.
        assertEquals(Pair(-55, -74), spriteOrigin(82, 114, 2, 48f, 0f, bottomArtY = 94))
        // A centred sprite: the art point lands on the window centre.
        assertEquals(Pair(0, 0), spriteOrigin(112, 112, 2, 28f, 28f))
        val box = vehicleBbox(VehicleFamily.STARTER)
        assertEquals(listOf(47, 71, 65, 105), box.toList())
    }

    @Test fun `dim matrix keeps colour at zero grey and greys fully at one`() {
        val identity = dimMatrix(0f, 1f)
        assertEquals(1f, identity[0], 1e-6f); assertEquals(0f, identity[1], 1e-6f); assertEquals(1f, identity[6], 1e-6f); assertEquals(1f, identity[18], 1e-6f)
        val grey = dimMatrix(1f, 0.5f)
        // Every colour row is the same luma row, scaled by brightness; alpha untouched.
        assertEquals(grey[0], grey[5], 1e-6f); assertEquals(grey[1], grey[11], 1e-6f)
        assertEquals(0.2126f * 0.5f, grey[0], 1e-6f)
        assertEquals(1f, grey[18], 1e-6f)
        assertEquals(20, grey.size)
    }

    // SPEC §3 item 2: the route runs across, then up or down, then across; a vehicle sits on it by share of length.
    @Test fun `stepped route points`() {
        assertEquals(0f to 100f, steppedRoutePoint(0f, 100f, 100f, 60f, 0f))
        assertEquals(100f to 60f, steppedRoutePoint(0f, 100f, 100f, 60f, 1f))
        // Length 50 + 40 + 50 = 140; half way (70) is 20 up the vertical leg at x 50.
        assertEquals(50f to 80f, steppedRoutePoint(0f, 100f, 100f, 60f, 0.5f))
        assertEquals(0f to 0f, steppedRoutePoint(0f, 0f, 0f, 0f, 0.5f))
    }

    // send.html turns the header route 50 dp past the Lodge door, not at the midpoint; vehicles placed by progress must ride
    // the line that is actually drawn, so the turn is shared.
    @Test fun `stepped route points follow a turn that is not the midpoint`() {
        // Legs 20 + 40 + 80 = 140; half way (70) is 10 along the top leg, which starts at the turn (x 20).
        assertEquals(30f to 60f, steppedRoutePoint(0f, 100f, 100f, 60f, 0.5f, turnX = 20f))
        // A quarter (35) is 15 up the vertical leg, which stands at the turn.
        assertEquals(20f to 85f, steppedRoutePoint(0f, 100f, 100f, 60f, 0.25f, turnX = 20f))
        assertEquals("no turn given keeps the midpoint", steppedRoutePoint(0f, 100f, 100f, 60f, 0.5f), steppedRoutePoint(0f, 100f, 100f, 60f, 0.5f, null))
    }
}
