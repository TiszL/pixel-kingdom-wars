package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure rules of the voyage cluster's round-2 frames (design/final/voyage/SPEC.md "Round 2 additions"). */
class VoyageR2LogicTest {
    private val route = RouteUi("emberwake-2", "emberwake", 1, "Emberwake Isles 2", "cinderfall", "Cinderfall", "ember_nodules", 2,
        Access.PAID_REALM, null)
    private val homeRoute = route.copy(routeId = "glasswake-3", realmId = "elderwood", access = Access.HOME)
    private val airship = VehicleUi(VehicleFamily.COURIER_AIRSHIP, 3, "inst-a", "berth-a", VehicleStatus.DOCKED, 4, 10, null, 3)
    private val preview = PreviewUi("5h 40m", "03:20", "156", "16", "140", emptyList(), null, null)
    private val rows = listOf(
        RouteRowUi(homeRoute, "voyage:heartwood-logs", "140", "5h 40m", false, null),
        RouteRowUi(route, "voyage:ember-nodules", null, null, true, null, "0.01 SOL · 7d"),
        RouteRowUi(route.copy(routeId = "prismdeep-4", grade = 4), "voyage:rough-prism", null, null, false, "Needs T4"),
    )
    private val advanced = AdvancedSendUi(airship, rows, "glasswake-3", preview, null, permitDays = 7)

    // Part two: the network cost lives only in the Seal's fine print; unknown says "being checked", never 0.
    @Test fun `the network cost is fine print and never a guessed number`() {
        assertEquals("Paid from your wallet with a tiny network cost (about 0.00002 SOL). You sign once.", networkCostLine("0.00002"))
        assertEquals("Paid from your wallet (network cost being checked). You sign once.", networkCostLine(null))
        assertEquals("Paid from your wallet (network cost being checked). You sign once.", networkCostLine("…"))
    }

    @Test fun `the install Seal waits for the fee review and says the wallet item is used up`() {
        val seal = installSealV2(VehicleFamily.SURVEY_BALLOON, OwnedVehicleUi("a", 2), "0.00002", VoyageSealState.ARMED, 0L)
        assertEquals("INSTALL SURVEY BALLOON", seal.title)
        assertEquals("Balloon T2 goes into this Berth for good. The wallet item is used up.", seal.lines.single())
        assertEquals("0.00002", seal.network?.feeSol)
        assertEquals(SealV2Primary.ARMING, sealV2Primary(seal))
        assertEquals(SealV2Primary.CHECKING, sealV2Primary(installSealV2(VehicleFamily.SURVEY_BALLOON, OwnedVehicleUi("a", 2), null,
            VoyageSealState.ARMED, 0L)))
    }

    // Design correction 7: an uncertain result offers CHECK (by-key read), never a second request; only a definite refusal RETRYs.
    @Test fun `the Seal primary never re-sends an uncertain request`() {
        val seal = installSealV2(VehicleFamily.CARGO_CUTTER, OwnedVehicleUi("a", 2), "0.00002", VoyageSealState.ERROR, 0L)
        assertEquals(SealV2Primary.CHECK, sealV2Primary(seal))
        assertEquals(SealV2Primary.CHECK, sealV2Primary(seal.copy(error = VoyageMoneyErrorUi("lost", authoritative = false))))
        assertEquals(SealV2Primary.RETRY, sealV2Primary(seal.copy(error = VoyageMoneyErrorUi("declined", authoritative = true))))
        assertEquals(SealV2Primary.LOCKED, sealV2Primary(seal.copy(pausedReason = "Installs are paused.")))
        assertEquals(SealV2Primary.MONEY, sealV2Primary(seal.copy(state = VoyageSealState.SENDING)))
        assertEquals(SealV2Primary.SHORT, sealV2Primary(seal.copy(state = VoyageSealState.ARMED, shortLine = "Need about 0.00002 more SOL in your wallet")))
    }

    // berth-service.png: the primary says what you give; the fee moved into the Seal.
    @Test fun `the service primary says what is used up, not the fee`() {
        val look = servicePrimaryV2(ServiceOp.RESTORE_USES, true, null, null, true, "Cargo Cutter T2", false, null)!!
        assertEquals("RESTORE TRIPS", look.label)
        assertEquals("uses up 1 Cargo Cutter T2", look.sub)
        assertFalse(look.sub!!.contains("SOL"))
        assertEquals("UPGRADE TO T3", servicePrimaryV2(ServiceOp.UPGRADE, true, null, 3, true, "Cargo Cutter T2", false, null)!!.label)
        assertEquals(CommandState.DISABLED, servicePrimaryV2(ServiceOp.RESTORE_USES, true, null, null, false, "Cargo Cutter T2", false, null)!!.state)
        assertEquals(CommandState.LOCKED, servicePrimaryV2(ServiceOp.UPGRADE, false, "Max tier", null, true, "x", false, null)!!.state)
        assertNull(servicePrimaryV2(null, true, null, null, true, "x", false, null))
    }

    @Test fun `the service Seal restores or upgrades with the cost in the fine print`() {
        val ui = BerthServiceUi(listOf(airship.copy(tripsLeft = 1)), "inst-a", listOf(ServiceOptionUi(ServiceOp.RESTORE_USES, true, null, null, 10),
            ServiceOptionUi(ServiceOp.UPGRADE, true, null, 4, null)), ServiceOp.RESTORE_USES, OwnedVehicleUi("x", 3), 1, null, VoyageSealState.IDLE)
        val restore = serviceSealV2(ui, 0L)!!
        assertEquals("RESTORE COURIER AIRSHIP", restore.title)
        assertEquals("1 → 10 trips", restore.gets?.text)
        assertFalse("fee not reviewed yet: the Seal does not arm", restore.quoteReady)
        assertEquals(4, serviceSealV2(ui.copy(selectedOp = ServiceOp.UPGRADE), 0L)!!.gets?.tier)
        assertNull(serviceSealV2(ui.copy(selectedOp = null), 0L))
    }

    // E1.2: the sheet says "with a 7-day permit"; the price and the split appear only in the Seal.
    @Test fun `the permit Seal carries the price and the split, the sheet only the length`() {
        val p = PermitSealUi("Cinderfall", PriceUi(Currency.SOL, "0.01", PriceStatus.OK), 7, 14, "half to Spot 14 on Seeker Island, half to the game.",
            "Cutter", 0L)
        val seal = permitSealV2(p)
        assertEquals("PERMIT FOR CINDERFALL", seal.title)
        assertEquals("0.01", seal.pay.text)
        assertEquals("7 DAYS", seal.gets?.text)
        assertEquals("The realm's cut:", seal.cut?.lead)
        assertEquals("0.01 SOL", seal.confirmSub)
        assertEquals(SealV2Primary.ARMING, sealV2Primary(seal))
        assertEquals(SealV2Primary.CHECKING, sealV2Primary(permitSealV2(p.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING)))))
        assertEquals("…", permitSealV2(p.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING))).pay.text)
        val unavailable = permitSealV2(p.copy(price = PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE)))
        assertEquals("No spot sells Cinderfall permits today", unavailable.unavailable?.line)
        assertEquals(SealV2Primary.UNAVAILABLE, sealV2Primary(unavailable))
        assertEquals(SealV2Primary.SHORT, sealV2Primary(permitSealV2(p.copy(price = PriceUi(Currency.SOL, "0.01", PriceStatus.SHORT)))))
        assertEquals("with a 7-day permit", permitSubLine(7))
        assertEquals("with a permit", permitSubLine(null))
    }

    @Test fun `SEND on a permit route drops the SOL amount from the sheet`() {
        val send = LodgeSendUi(listOf(route), route.routeId, listOf(airship), airship.installationId,
            preview.copy(permit = PermitUi(PriceUi(Currency.SOL, "0.01", PriceStatus.OK), "Cinderfall")), PreviewState.READY, null,
            ordersAllowed = true, pending = null)
        val look = sendLookV2(send, 7)
        assertEquals("with a 7-day permit", look.sub)
        assertEquals(CommandState.ENABLED, look.state)
        assertEquals("back at 03:20", sendLookV2(send.copy(preview = preview), 7).sub)
    }

    // E1.1: stamps are a record; the eighth realm keeps its full name; refresh only in the error state.
    @Test fun `passport stamps record trips and unlock nothing`() {
        val stamps = listOf(StampUi("crownlands", "Crownlands", "", 9, true), StampUi("seeker-reach", "Solana Reach", "", 0, false))
        assertEquals("×9", stampCaption(stamps[0]))
        assertEquals("not yet", stampCaption(stamps[1]))
        assertEquals("1 of 2 realms", passportRealmsLine(stamps))
        assertEquals("… realms", passportRealmsLine(emptyList()))
        assertTrue(stampNameNeedsTightTracking("Solana Reach"))
        assertFalse(stampNameNeedsTightTracking("Sunscar"))
        assertNull(passportSourceLine(SourceState.OK))
        assertEquals("These records could not be verified. Check again later.", passportSourceLine(SourceState.UNAVAILABLE))
        assertTrue(passportShowsRefresh(SourceState.CONFLICT))
        assertFalse(passportShowsRefresh(SourceState.OK))
        val ui = PassportUi("0", "0", "0", stamps.map { it.copy(trips = 0) }, emptyList(), null, SourceState.OK)
        assertTrue(passportIsEmpty(ui))
        assertFalse(passportIsEmpty(ui.copy(loading = true)))
    }

    @Test fun `route rows put a block first, then the selection, then the permit tag`() {
        assertEquals(RouteRowState.SELECTED, routeRowState(rows[0], "glasswake-3"))
        assertEquals(RouteRowState.PERMIT, routeRowState(rows[1], "glasswake-3"))
        assertEquals(RouteRowState.BLOCKED, routeRowState(rows[2], "prismdeep-4"))
        assertEquals("Grade III or lower", vehicleGradeLine(airship))
        assertEquals("Starter routes only", vehicleGradeLine(airship.copy(maxGrade = 0)))
        assertEquals("+140", yieldText("140"))
        assertEquals("…", yieldText(null))
    }

    // E1.3 states: a saved departure is never re-sent; worn out offers RESTORE; a permit route opens the permit Seal.
    @Test fun `advanced SEND follows the states in order`() {
        val ok = advancedSendLook(advanced)!!
        assertEquals("SEND AIRSHIP", ok.look.label)
        assertEquals("uses 1 trip · back at 03:20", ok.look.sub)
        assertEquals(AdvancedAction.SEND, ok.action)
        assertEquals(AdvancedAction.PERMIT, advancedSendLook(advanced.copy(selectedRouteId = route.routeId))!!.action)
        assertEquals("with a 7-day permit", advancedSendLook(advanced.copy(selectedRouteId = route.routeId))!!.look.sub)
        assertEquals("Needs T4", advancedSendLook(advanced.copy(selectedRouteId = "prismdeep-4"))!!.look.reason)
        val away = advancedSendLook(advanced.copy(vehicle = airship.copy(status = VehicleStatus.AWAY, returnsAt = "1h 12m")))!!
        assertEquals("Back in 1h 12m", away.look.reason)
        val worn = advancedSendLook(advanced.copy(vehicle = airship.copy(tripsLeft = 0)))!!
        assertTrue(worn.restore)
        assertEquals(CommandState.DISABLED, worn.look.state)
        assertEquals(CommandState.BUSY, advancedSendLook(advanced.copy(pending = PendingDepartureUi("x")))!!.look.state)
        assertEquals(AdvancedAction.CHECK, advancedSendLook(advanced.copy(previewState = PreviewState.ERROR, preview = null))!!.action)
        assertEquals(CommandState.BUSY, advancedSendLook(advanced.copy(previewState = PreviewState.LOADING))!!.look.state)
        assertNull(advancedSendLook(advanced.copy(vehicle = null)))
    }
}
