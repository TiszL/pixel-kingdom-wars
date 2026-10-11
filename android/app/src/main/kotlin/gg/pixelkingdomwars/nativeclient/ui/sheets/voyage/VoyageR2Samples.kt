package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi

/**
 * Preview data for the voyage cluster's round-2 frames (the mock values of passport.png, send-paid.png,
 * send-advanced.png, berth-install.png and berth-service.png). Every number here is a placeholder (SPEC E1.4: route →
 * realm pairs other than Glasswake → Elderwood are placeholders too); in the app all values come from the server,
 * already formatted. Not used outside @Preview functions.
 */
internal object VoyageR2Samples {
    private val routes = previewRoutes()
    private val glasswake = routes[2]
    private val emberwake = routes[5]
    private val rimeholm = routes[10]

    private val cutter = VehicleUi(VehicleFamily.CARGO_CUTTER, 2, "inst-cutter", "berth-cutter", VehicleStatus.DOCKED, 7, 10, null, 2)
    private val airship = VehicleUi(VehicleFamily.COURIER_AIRSHIP, 3, "inst-airship", "berth-airship", VehicleStatus.DOCKED, 4, 10, null, 3)
    private val balloonEmpty = VehicleUi(VehicleFamily.SURVEY_BALLOON, null, null, "berth-balloon", VehicleStatus.EMPTY, null, null, null, 0)
    private val starter = VehicleUi(VehicleFamily.STARTER, null, "inst-starter", "berth-starter", VehicleStatus.DOCKED, null, null, null, 0)
    private val bargeEmpty = VehicleUi(VehicleFamily.EXPEDITION_BARGE, null, null, "berth-barge", VehicleStatus.EMPTY, null, null, null, 0)
    private val quay = listOf(starter, balloonEmpty, cutter.copy(tripsLeft = 1), airship.copy(status = VehicleStatus.AWAY, returnsAt = "1h 12m"), bargeEmpty)

    // ---------------------------------------------------------------------------------------------------------- seals

    /** berth-install.png: Survey Balloon T2 into its berth, network cost in the fine print. */
    val installSeal: VoyageSealV2Ui = installSealV2(VehicleFamily.SURVEY_BALLOON, OwnedVehicleUi("asset-b2", 2), "0.00002", VoyageSealState.ARMED, 0L)

    /** berth-service.png: RESTORE a Cargo Cutter T2. */
    val service = BerthServiceUi(listOf(cutter.copy(tripsLeft = 1), airship.copy(status = VehicleStatus.AWAY, returnsAt = "1h 12m")), "inst-cutter",
        listOf(ServiceOptionUi(ServiceOp.RESTORE_USES, true, null, null, 10), ServiceOptionUi(ServiceOp.UPGRADE, true, null, 3, null)),
        ServiceOp.RESTORE_USES, OwnedVehicleUi("asset-cutter-2", 2), 1, "0.00002", VoyageSealState.IDLE)

    val restoreSeal: VoyageSealV2Ui = serviceSealV2(service, 0L)!!

    /** send-paid.png: a 7-day Cinderfall permit sold by Seeker spot 14. */
    val permit = PermitSealUi("Cinderfall", PriceUi(Currency.SOL, "0.01", PriceStatus.OK), 7, 14,
        "half to Spot 14 on Seeker Island, half to the game.", "Cutter", 0L, route = emberwake)

    // ---------------------------------------------------------------------------------------------------------- Berth

    /** berth-install.png picker: two balloons found. */
    val install = InstallUi(VehicleFamily.SURVEY_BALLOON, listOf(OwnedVehicleUi("asset-b1", 1), OwnedVehicleUi("asset-b2", 2)), null,
        "asset-b2", "0.00002", VoyageSealState.ARMED)

    val installArgs = InstallSealArgs(OwnedVehicleUi("asset-b2", 2), 0L)

    /** A Berth sheet on FLEET (with the picker when [install] is set) or SERVICE. */
    fun berth(install: InstallUi? = null, tab: String = BerthSheetUi.TAB_FLEET, service: BerthServiceUi = this.service): BerthSheetUi =
        BerthSheetUi("LV 5", tab, quay, if (install != null) install.family else VehicleFamily.CARGO_CUTTER,
            BerthFleetUi("LV 5", quay, VehicleFamily.CARGO_CUTTER, mapOf(VehicleFamily.SURVEY_BALLOON to 2), ordersAllowed = true),
            StarterFleetUi(available = true, installed = true, reason = null, pending = false), install, service)

    // ---------------------------------------------------------------------------------------------------------- Lodge

    private val preview = PreviewUi("4h 10m", "22:30", "96", "10", "86", listOf(
        SupplyUi("thorn_fibre", "voyage:thorn-fibre", "Thorn Fibre", "6", "46", false),
        SupplyUi("ember_nodules", "voyage:ember-nodules", "Ember Nodules", "2", "18", false)),
        null, PermitUi(PriceUi(Currency.SOL, "0.01", PriceStatus.OK), "Cinderfall"), "voyage:ember-nodules", "Ember Nodules")

    private val trips = LodgeTripsUi(emptyList(), listOf(cutter), emptyList(), CollectState.IDLE)

    private val baseLodge = LodgeSheetUi("LV 4", LodgeSheetUi.TAB_SEND,
        VoyageChartUi(ChartMode.ROUTE, emberwake, cutter, TimerUi("4h 10m", "Back in 4 hours 10 minutes"), description = "Cargo Cutter to Emberwake Isles 2"),
        LodgeSendUi(routes, emberwake.routeId, listOf(cutter, airship, starter), cutter.installationId, preview, PreviewState.READY, null,
            ordersAllowed = true, pending = null),
        null, null, trips)

    /** send-paid.png: SEND on a permit route (the permit Seal is composed over it). */
    val lodgeSendPaid = LodgeSheetR2Ui(baseLodge, craftedOffered = true, permitDays = 7)

    private val routeRows = listOf(
        RouteRowUi(rimeholm.copy(displayName = "Lumenreef 4", realmName = "Frostveil", grade = 3), "voyage:frost-quartz", "140", "5h 40m", false, null),
        RouteRowUi(glasswake, "voyage:heartwood-logs", "108", "3h 20m", false, null),
        RouteRowUi(routes[1].copy(displayName = "Aurora Shoals 2", realmName = "Crownlands", grade = 1), "voyage:crown-iron-ore", "60", "1h 50m", false, null),
        RouteRowUi(routes[6].copy(displayName = "Emberwake Reach 5", grade = 3), "voyage:ember-nodules", null, null, true, null, permitLine = "0.01 SOL · 7d"),
        RouteRowUi(routes[15].copy(displayName = "Prismforge 4", realmName = "Solana Reach", grade = 4), "voyage:rough-prism", null, null, false, "Needs T4"),
    )

    /** send-advanced.png: the Courier Airship T3 (4/10 trips), Lumenreef 4 selected, Route Compass fitted. */
    val advanced = AdvancedSendUi(airship, routeRows, routeRows[0].route.routeId,
        PreviewUi("5h 40m", "03:20", "156", "16", "140", emptyList(), null, null, "voyage:frost-quartz", "Frost Quartz"),
        FittingUi("voyage:route-compass", "+ a survey find", "Route Compass fitted"), permitDays = 7)

    val lodgeAdvanced = LodgeSheetR2Ui(baseLodge.copy(chart = VoyageChartUi(ChartMode.ROUTE, rimeholm, airship,
        TimerUi("5h 40m", "Back in 5 hours 40 minutes"), description = "Courier Airship to Lumenreef 4")),
        mode = LodgeSendMode.CRAFTED, craftedOffered = true, advanced = advanced, permitDays = 7)

    /** passport.png: 4 of 8 realms, 120 renown, 21 trips, 14 days. */
    val passport = PassportUi("120", "21", "14", listOf(
        StampUi("crownlands", "Crownlands", "voyage:crown-iron-ore", 9, home = true),
        StampUi("elderwood", "Elderwood", "voyage:heartwood-logs", 6, home = false),
        StampUi("frostveil", "Frostveil", "voyage:frost-quartz", 4, home = false),
        StampUi("thornwake", "Thornwake", "voyage:thorn-fibre", 2, home = false),
        StampUi("sunscar", "Sunscar", "voyage:sunstone-rubble", 0, home = false),
        StampUi("cinderfall", "Cinderfall", "voyage:ember-nodules", 0, home = false),
        StampUi("stormcairn", "Stormcairn", "voyage:storm-ore", 0, home = false),
        StampUi("seeker-reach", "Solana Reach", "voyage:rough-prism", 0, home = false),
    ), listOf(
        ReturnRowUi(glasswake.routeId, "Glasswake Keys 3", "Cutter T2", "yesterday 21:40", route = glasswake),
        ReturnRowUi("aurora-2", "Aurora Shoals 2", "Starter boat", "Tue 09:10", route = routes[1]),
    ), "2 min ago", SourceState.OK, lodgeTier = 4)

    val lodgePassport = LodgeSheetR2Ui(baseLodge.copy(tab = LodgeSheetUi.TAB_PASSPORT), passport = passport)
}
