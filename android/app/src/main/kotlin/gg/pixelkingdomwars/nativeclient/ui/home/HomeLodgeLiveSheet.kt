package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Complete Lodge player body. SEND and COLLECT borrow the retained owners and stay on this sheet.
 *  [openSolanaIsland] opens the globe on Solana Island's Public Workshop, [onBuildBerth] the build tray, and [onStack]
 *  receives the tall sheet's supply rows for the HUD stack (null hands the HUD back its own rows). */
@Composable internal fun HomeLodgeLiveSheet(graph: AppGraph, session: SessionGraph, identity: HomeRouteIdentity,
    entry: SheetEntry, input: VoyageLiveInputs, owners: HomeOwnerProjections, overlays: HomeVoyageOverlays,
    modifier: Modifier, onTab: (String) -> Unit, onClose: () -> Unit, onHistory: () -> Unit,
    openFeature: (String) -> Unit, canRead: () -> Boolean, canAct: () -> Boolean, explain: (String) -> Unit,
    nestedBack: HomeBodyBack, checkPending: () -> Unit, retry: () -> Unit, readError: String?,
    openSolanaIsland: (() -> Unit)? = null, onBuildBerth: (() -> Unit)? = null,
    onStack: (List<ResourceChipUi>?) -> Unit = {}) {
    val destination = entry.destination as Destination.Lodge
    val starterCommands = owners.starter?.voyage
    val vehicleCommands = owners.vehicle?.voyage
    HomeVoyageVisibilityLease(identity, starterCommands, vehicleCommands)
    // send-locked BERTH_LOCKED: the Keep gate is the catalogue's BUILD_COSTS row, read against this kingdom's Keep.
    val content by graph.content.state.collectAsState()
    val baseState by session.base.state.collectAsState()
    val sheetInput = input.copy(berthUnlockReason = homeBerthUnlockReason(content.catalogue,
        baseState.base?.takeIf { it.baseId == identity.baseId }?.player?.keepLevel?.takeIf { it >= 0 }, input.buildings))
    val starterInstallation = sheetInput.starterFleetView?.installation?.installationId ?: sheetInput.starterView?.installation?.installationId
    // SEND AGAIN reopens the route-first SEND (send.png); only the CRAFTED chip or Destination mode "advanced" opens E1.3.
    var mode by remember(identity, destination) { mutableStateOf(
        if (destination.mode == "advanced" && overlays.repeatTrip == null) LodgeSendMode.CRAFTED else LodgeSendMode.STARTER) }
    var local by remember(identity, destination) { mutableStateOf(homeLodgeLocal(destination, starterInstallation).let { seed ->
        overlays.repeatTrip?.let { trip -> homeLodgeRepeatLocal(trip, seed) } ?: homeLodgeStarterDefault(seed, mode, starterInstallation)
    }) }
    SideEffect {
        val defaulted = homeLodgeStarterDefault(local, mode, starterInstallation)
        if (defaulted != local) local = defaulted
    }
    HomeBodyBackRegistration(nestedBack) { homeLodgeBack(local)?.let { local = it; true } ?: false }
    val currentCanAct by rememberUpdatedState(canAct)
    val currentCanRead by rememberUpdatedState(canRead)
    val currentInput by rememberUpdatedState(sheetInput)
    val currentOnStack by rememberUpdatedState(onStack)
    val controller = remember(identity, starterCommands) {
        starterCommands?.let { commands -> owners.starter?.let { owner ->
            HomeStarterDepartureController(identity, { homeOwnerProjectionIdentity(graph, session) },
                { currentCanAct() && commands.current() }, { owner.projection.state.value }, commands.reviewRoute,
                commands.reviewSaved, commands.confirm, commands.dismiss, commands.finishAccepted, commands.archiveUnused)
        } }
    }
    DisposableEffect(overlays, controller) {
        overlays.starter = controller
        onDispose { if (overlays.starter === controller) { overlays.close(force = true); overlays.starter = null } }
    }
    DisposableEffect(overlays) {
        overlays.lodgeMounted = true
        onDispose { overlays.lodgeMounted = false }
    }
    // Exploration end to end: a departure accepted in an earlier visit (or app run) is still the saved request until the
    // owner archives it; opening the Lodge settles it (GET only) so the boat shows at sea and SEND is not refused.
    val provenDeparture = sheetInput.starter?.journal?.operation?.takeIf { it.proof != null }?.command?.key
    LaunchedEffect(controller, provenDeparture) {
        if (provenDeparture != null) try { controller?.settleAccepted() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* SEND re-checks the saved proof itself; nothing was sent. */ }
    }
    val scope = rememberCoroutineScope()
    val currentTab = entry.selectedTab ?: local.tab
    val passportOwner = LocalHomePassportOwner.current
    val passportFacts = homeLodgePassportFacts(graph.account.state, identity.baseId, passportOwner?.takeIf { it.current() }?.model?.state)
    val passport = homeLodgePassport(passportOwner, identity, currentTab == "PASSPORT", passportFacts.homeRealmId,
        sheetInput.buildings?.firstOrNull { it.type == "lodge" && !it.underConstruction }?.level ?: 1, sheetInput.nowMs, canRead)
    val passportAvailable = passportFacts.available
    val pendingCollect = voyageCollectNeedsCheck(sheetInput.vehicles, identity.baseId)
    val ui = homeLodgeSheetUi(sheetInput, local.copy(tab = currentTab,
        collectState = if (pendingCollect) CollectState.CHECK else local.collectState), passportAvailable)
    val advanced = lodgeAdvancedUi(sheetInput, local)
    // SPEC §0.2 item 4: the HUD stack shows the chosen trip's supplies (max 2) while SEND is open; leaving hands it back.
    SideEffect { onStack(homeLodgeSupplyStack(ui, currentTab)) }
    DisposableEffect(Unit) { onDispose { currentOnStack(null) } }

    fun update(change: (LodgeLocalState) -> LodgeLocalState) {
        if (!currentCanRead()) return
        val next = change(local.copy(tab = entry.selectedTab ?: local.tab))
        if (next.tab == "PASSPORT" && !passportAvailable) explain("Passport records are unavailable.")
        else { local = next; onTab(next.tab) }
    }
    // SEND AGAIN from the Home return bubble, also when this sheet is already open. It only clears the request and opens
    // the route-first SEND with the same island and vehicle; it never switches to CRAFTED.
    SideEffect { overlays.repeatTrip?.let { trip ->
        overlays.repeatTrip = null
        mode = LodgeSendMode.STARTER
        update { homeLodgeRepeatLocal(trip, it) }
    } }
    // SPEC §3 motion 4: after the server accepted a starter departure the sheet shows it under way (TRIPS), once.
    LaunchedEffect(overlays.departed) {
        if (overlays.departed != null) {
            overlays.departed = null
            if (currentCanRead()) { local = local.copy(tab = LodgeSheetUi.TAB_TRIPS, pickerOpen = false); onTab(LodgeSheetUi.TAB_TRIPS) }
        }
    }
    fun permit(installation: String, routeId: String) {
        if (!currentCanRead()) return
        val route = ui.send?.routes?.firstOrNull { it.routeId == routeId }
            ?: advanced.routes.firstOrNull { it.route.routeId == routeId }?.route ?: return explain("Check the current route before sending.")
        val vehicle = installedVehicles(currentInput).firstOrNull { it.installationId == installation }
            ?: return explain("Choose a vehicle that can sail there")
        // The shared RealmSales owner supplies the quote/sign/submit sequence. Never create a second money owner here.
        overlays.permit = homeLodgeUnavailablePermit(route, vehicle.family, System.currentTimeMillis())
        overlays.permitActions = PermitSealActions(onBack = { overlays.permit = null },
            onSeekerIsland = { overlays.permit = null; explain("Open Seeker Island on the World map to review the existing permit offer.") })
    }
    fun dispatch(installation: String, route: String) {
        if (!currentCanRead()) return
        val family = installedVehicles(currentInput).firstOrNull { it.installationId == installation }?.family
        scope.launch {
            try {
                if (vehicleCommands?.dispatch?.invoke(identity.baseId, installation, route) != true)
                    explain("The departure needs checking. Check its original receipt before sending again.")
                else {
                    // SPEC §3 motion 4 step 5, only after the server accepted. The camera flight and FX are scene work.
                    family?.let { Toasts.post(homeLodgeDepartureLine(it)) }
                    if (currentCanRead()) { local = local.copy(tab = LodgeSheetUi.TAB_TRIPS); onTab(LodgeSheetUi.TAB_TRIPS) }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The departure needs checking. Its original request has been kept.") }
        }
    }
    fun collect() {
        if (!currentCanRead() || local.collectState != CollectState.IDLE) return
        if (voyageCollectNeedsCheck(currentInput.vehicles, identity.baseId)) { checkPending(); return }
        local = local.copy(collectState = CollectState.BUSY)
        scope.launch {
            try {
                val collected = overlays.collector?.collect()
                if (currentCanRead()) {
                    if (collected != null) {
                        overlays.collectActions = CollectActions(onOk = overlays::dismissCollect,
                            onSendAgain = {
                                overlays.dismissCollect()
                                // SPEC §3 Entry / §5b: the route-first SEND with the same island and vehicle, never E1.3.
                                mode = LodgeSendMode.STARTER
                                val trip = collected.trips.firstOrNull()
                                update { if (trip != null) homeLodgeRepeatLocal(trip, it) else it.copy(tab = LodgeSheetUi.TAB_SEND, pickerOpen = false) }
                            }, onGoBerth = { overlays.dismissCollect(); openFeature("berth.service") })
                        overlays.collect = collected
                    } else explain("The return needs checking. Refresh the original trip receipts before collecting again.")
                } else explain("The return needs checking. Its original request has been kept.")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The return needs checking. Its original request has been kept.") }
            finally { local = local.copy(collectState = CollectState.IDLE) }
        }
    }
    val callbacks = LodgeLiveCallbacks(update = ::update, toast = explain,
        reviewStarterDeparture = { route -> if (currentCanRead()) scope.launch {
            try {
                // The Lodge re-reads its owner as it opens; a quick SEND waits for that read instead of being refused.
                controller?.awaitReady()
                if (controller?.open(route) != true) explain("Check the saved starter request or refresh routes before sending.")
            }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The departure review could not be opened. The saved request has been kept.") }
        }; Unit }, dispatchCrafted = ::dispatch, checkPending = checkPending, collectAll = ::collect, retryPreview = retry,
        go = { door, arg -> when (door) {
            LodgeLiveDoor.HISTORY -> onHistory()
            LodgeLiveDoor.BERTH_STARTER -> openFeature("berth.starter")
            LodgeLiveDoor.BERTH_FLEET -> openFeature("berth.fleet")
            LodgeLiveDoor.BERTH_SERVICE -> openFeature("berth.service")
            // send-locked NO_BERTH: the build tray's BUILDINGS tab (no request focuses the Berth card yet).
            LodgeLiveDoor.BUILD_BERTH -> onBuildBerth?.invoke() ?: explain("Open BUILD to place a Berth.")
            // Every resource is a door: it names the realm whose islands bring it home.
            LodgeLiveDoor.RESOURCE_DRAWER, LodgeLiveDoor.EARN_RESOURCE -> explain(homeLodgeResourceLine(arg))
            // Workshop › EQUIPMENT belongs to the existing fleet owner, not to this sheet.
            LodgeLiveDoor.WORKSHOP_EQUIPMENT -> explain("Fit a Route Compass in the Workshop's EQUIPMENT tab.")
            else -> explain("This is not open from the Lodge yet.")
        } }, close = onClose, dismissCollect = overlays::dismissCollect, reviewPermit = ::permit)
    fun switchMode(next: String) { if (currentCanRead()) {
        mode = next
        update { it.copy(tab = LodgeSheetUi.TAB_SEND, pickerOpen = false,
            installationId = if (next == LodgeSendMode.STARTER) starterInstallation else advanced.vehicle?.installationId,
            routeId = if (next == LodgeSendMode.STARTER) null else advanced.selectedRouteId) }
    } }
    LodgeSheetR2(LodgeSheetR2Ui(base = ui, mode = mode, craftedOffered = homeLodgeCraftedOffered(sheetInput),
        advanced = advanced, passport = passport.ui, readError = readError.takeUnless { currentTab == "PASSPORT" }),
        LodgeSheetR2Actions(base = lodgeSheetActions(ui, callbacks), onMode = ::switchMode,
            advanced = AdvancedSendActions(onMode = ::switchMode,
                onChangeVehicle = {
                    val fleet = installedVehicles(currentInput).filter { it.family != VehicleFamily.STARTER }
                    val index = fleet.indexOfFirst { it.installationId == advanced.vehicle?.installationId }
                    update { it.copy(installationId = fleet.getOrNull((index + 1) % fleet.size.coerceAtLeast(1))?.installationId) }
                }, onRoute = { route -> update { it.copy(routeId = route) } },
                onSend = { advanced.vehicle?.installationId?.let { installation -> advanced.selectedRouteId?.let { dispatch(installation, it) } } },
                onPermit = { advanced.vehicle?.installationId?.let { installation -> advanced.selectedRouteId?.let { permit(installation, it) } } },
                onRestore = { openFeature("berth.service") }, onCheck = { checkPending(); retry() },
                onCraftLink = { openSolanaIsland?.invoke() ?: explain("Open Solana Island on the World map to craft a vehicle.") },
                onBerthLink = { openFeature("berth.fleet") }, onRefused = { explain(it ?: "Check the current route before sending.") }),
            onRetry = retry, passport = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.passportLiveActions(passport.refresh,
                { update { it.copy(tab = LodgeSheetUi.TAB_SEND) } },
                { explain("This return is recorded in your Passport. Detailed return history is not available here yet.") }, explain)), modifier)
}
