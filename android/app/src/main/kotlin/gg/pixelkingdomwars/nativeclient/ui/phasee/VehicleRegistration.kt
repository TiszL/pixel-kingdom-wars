package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.CharterLifecycle
import gg.pixelkingdomwars.nativeclient.data.vehicleClient
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandOwner
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*

/** Native vehicle installation, service, fleet and original receipt recovery. N-C5 GAMEPLAY-UI-A: this remains the ONE
 *  client/model/lifetime owner; it now returns its command owner (entry, open/close, form) to the common Home root instead of
 *  nesting the Bases content, and emits no UI of its own. */
@Composable fun VehicleRegistration(graph: AppGraph, session: SessionGraph, wallet: WalletLogin?, admit: () -> Boolean = { true }): FleetCommandOwner {
    val account by graph.account.state.collectAsState(); val base by session.base.state.collectAsState(); val content by graph.content.state.collectAsState(); val interlock by session.interlock.state.collectAsState(); val battle by session.battle.state.collectAsState()
    val lifetime = remember(session, wallet) { CharterViewLifetime() }
    var show by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    var historyOnly by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    var entryPoint by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf<VehicleEntryPoint?>(null) }
    // Inputs reset live remembers; this separate stamp also validates process-restored flags.
    var savedWallet by rememberSaveable { mutableStateOf("") }
    var savedOrigin by rememberSaveable { mutableStateOf("") }
    val actor = PhaseERegistrationActor(session.session.wallet, session.session.origin)
    fun currentPresentation() = phaseERegistrationPresentation(
        PhaseERegistrationActor(savedWallet, savedOrigin), actor, show, historyOnly, entryPoint)
    fun present(next: PhaseERegistrationPresentation) {
        savedWallet = actor.wallet; savedOrigin = actor.origin
        historyOnly = next.historyOnly; entryPoint = next.entryPoint; show = next.show
    }
    val presentation = currentPresentation()
    SideEffect {
        if (PhaseERegistrationActor(savedWallet, savedOrigin) != actor)
            present(PhaseERegistrationPresentation())
    }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    val opened = remember(lifetime) { runCatching {
        graph.vehicleClient(session, wallet, lifecycle = {
            val current = graph.content.state.value; val currentBattle = session.battle.state.value
            lifetime.snapshot(current.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed,
                current.ready, current.manifest?.contentVersion,
                currentBattle.battleVisible || currentBattle.replay != null || currentBattle.spectator != null,
                "${graph.account.state.value.baseSelectionGeneration}:${graph.account.state.value.selectedBaseId}")
        })
    } }
    val client = opened.getOrNull()
    val model = client?.let { viewModel<VehicleViewModel>(key = "vehicle-${System.identityHashCode(lifetime)}",
        factory = viewModelFactory { initializer { VehicleViewModel(it.repository, it.wallet, it.craft) } }) }
    val state = model?.state?.collectAsState()?.value
    val homeVisibility = remember(lifetime) { gg.pixelkingdomwars.nativeclient.ui.home.HomeVoyageVisibility() }
    val homeVisible = !presentation.show && homeVisibility.isCurrent(gg.pixelkingdomwars.nativeclient.ui.home.homeOwnerProjectionIdentity(graph, session))
    SideEffect { lifetime.setOpen(presentation.show || homeVisible) }
    val historyRows = state?.let(PhaseEReceiptRows::vehicles).orEmpty()
    DisposableEffect(lifetime, model, lifecycle) {
        lifetime.setOpen(presentation.show)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) lifetime.start()
        val observer = LifecycleEventObserver { _, event -> when (event) {
            Lifecycle.Event.ON_START -> { lifetime.start(); foreground = true }
            Lifecycle.Event.ON_STOP -> { lifetime.stop(); foreground = false; model?.dismiss() }
            else -> Unit
        } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); lifetime.dispose(); model?.dismiss() }
    }
    val battleActive = battle.battleVisible || battle.replay != null || battle.spectator != null
    val orders = content.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed
    LaunchedEffect(model, lifecycle, show, homeVisible, content.ready, content.manifest?.contentVersion, orders, battleActive, account.baseSelectionGeneration) {
        lifetime.invalidate(); model?.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model?.foreground(); awaitCancellation() }
    }
    val close = { lifetime.setOpen(false); model?.dismiss(); present(currentPresentation().close()) }
    val policy = client?.policy?.invoke(); val configured = client?.configured == true && policy != null
    val allowed = foreground && charterActionsAllowed(policy != null,
        lifetime.snapshot(orders, content.ready, content.manifest?.contentVersion, battleActive))
    val available = client != null || opened.isFailure
    fun ownerCurrent() = graph.sessionGraph.value === session && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    fun historyCurrent() = ownerCurrent() && currentPresentation().body == PhaseERegistrationBody.RECEIPTS
    val open: () -> Unit = { if (ownerCurrent() && admit()) { lifetime.setOpen(true); present(currentPresentation().openLive()) } }
    val openHistory: () -> Unit = { if (ownerCurrent() && admit()) { lifetime.setOpen(true); present(currentPresentation().openHistory()) } }
    val openEntry: (String) -> Unit = { name -> phaseEVehicleEntry(name)?.let { point ->
        if (ownerCurrent() && admit()) { lifetime.setOpen(true); present(currentPresentation().openEntry(point)) }
    }; Unit }
    val openHistoryEntry: (String) -> Unit = { name -> phaseEVehicleEntry(name)?.let { point ->
        if (ownerCurrent() && admit()) { lifetime.setOpen(true); present(currentPresentation().openHistory(point)) }
    }; Unit }
    if (available) PhaseEDoorEntry(PhaseEActivity.VEHICLES,canLaunch={ownerCurrent()},onHistory=openHistory,onLaunch=open)
    val owner = gg.pixelkingdomwars.nativeclient.ui.home.rememberHomeProjection(lifetime, model,
        gg.pixelkingdomwars.nativeclient.ui.home.homeOwnerProjectionIdentity(graph, session)) {
        model?.let { existing -> gg.pixelkingdomwars.nativeclient.ui.home.projectHomeOwner(graph, session, existing.state,
            admitted = {
                val snapshot = lifetime.snapshot(false, false, null, false)
                gg.pixelkingdomwars.nativeclient.ui.home.homeVehicleReadAdmitted(
                    lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED), snapshot.active, snapshot.visible,
                    existing.state.value.busy || existing.busy.value)
            }, reviewBlocked = { existing.state.value.review != null }) }?.let { p ->
            fun homeCurrent(baseId: String): Boolean {
                val currentBattle = session.battle.state.value
                val currentContent = graph.content.state.value
                return p.currentState() != null && p.identity.baseId == baseId && homeVisibility.isCurrent(p.identity) &&
                    !currentPresentation().show && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
                    model?.state?.value?.busy == false && model.busy.value == false && model.state.value.review == null &&
                    charterActionsAllowed(client?.policy?.invoke() != null, lifetime.snapshot(
                        currentContent.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed,
                        currentContent.ready, currentContent.manifest?.contentVersion,
                        currentBattle.battleVisible || currentBattle.replay != null || currentBattle.spectator != null))
            }
            gg.pixelkingdomwars.nativeclient.ui.home.HomeVehicleOwner(p,
                { if (p.currentState() == null) null else client?.policy?.invoke() },
                p.suspendReadAction({ model?.busy?.first { !it } }) { _: Unit -> model?.refresh()?.join() },
                p.suspendReadAction({ model?.busy?.first { !it } }) { baseId: String -> model?.fleet(baseId)?.join() },
                p.suspendReadAction({ model?.busy?.first { !it } }) { cursor: String? -> model?.assets(cursor)?.join() },
                p.suspendReadAction({ model?.busy?.first { !it } }) { _: Unit -> model?.check()?.join() },
                walletLinked = { p.currentState() != null && model?.wallet != null },
                voyage = gg.pixelkingdomwars.nativeclient.ui.home.HomeVehicleCommands(homeVisibility,
                    dispatch = { baseId, installation, route ->
                        if (!homeCurrent(baseId)) false else {
                            val action = model?.dispatch(baseId, installation, route)
                            action?.join(); action != null && !action.isCancelled && model?.notice?.value?.error != true
                        }
                    }, collect = { baseId ->
                        if (!homeCurrent(baseId)) false else {
                            val action = model?.collect(baseId)
                            action?.join(); action != null && !action.isCancelled && model?.notice?.value?.error != true
                        }
                    }))
        }
    }
    return FleetCommandOwner(FleetCommandDestination.VEHICLES, available, isOpen = presentation.show, open = open, close = close, vehicle = owner,
        openHistory = openHistory, openEntry = openEntry, openHistoryEntry = openHistoryEntry) {
        // Owner 2026-10-06 (screenshot 1): the old dark VEHICLES & EXPEDITIONS page is off the player path; every body here is
        // the designed sheet over the SAME model (VehicleDesignedSheet.kt). VehicleScreen stays in the tree, unused.
        if (model == null) PhaseEDesignedNotice("BERTH", "Vehicles", "Saved vehicle storage is unavailable. It has been preserved; restore access before continuing.", close)
        else if(presentation.body == PhaseERegistrationBody.RECEIPTS) {
            PhaseEReceiptHistoryScreen("VEHICLE RECEIPTS",historyRows,state?.busy==true,state?.error,
                onRefresh={if(historyCurrent())model.refresh()},onCheck={check ->
                    if(historyCurrent() && PhaseEReceiptRows.vehicles(model.state.value).any { it.check == check }) {
                        if(check.source==PhaseEReceiptSource.SERVER) {
                            (model.state.value.activity?.get("items") as? JsonArray)?.mapNotNull{it as? JsonObject}
                                ?.firstOrNull{(it["id"] as? JsonPrimitive)?.content==check.id}?.let{model.history(it)}
                        } else model.select(check.id)
                    }
                },onBack=close)
        } else {
            // Owner 2026-10-06: only vacant Berths. The old list offered every completed Berth, including the one holding the
            // starter boat, which the server refuses (VEHICLE_BERTH_OCCUPIED); a saved reservation keeps its Berth for good.
            val berths = gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.vacantBerthsForInstall(
                base.base?.takeIf { it.baseId == account.selectedBaseId },
                state?.journal?.records.orEmpty().filter { it.kind == "installation" }.mapNotNull { (it.request["berthId"] as? JsonPrimitive)?.content })
            // No route-art lease here: the designed Lodge SEND draws the island art; this sheet lists the server previews.
            VehicleDesignedSheet(model, allowed, configured, account.selectedBaseId, berths, close, policy, initialPage = presentation.initialPage)
        }
    }
}
