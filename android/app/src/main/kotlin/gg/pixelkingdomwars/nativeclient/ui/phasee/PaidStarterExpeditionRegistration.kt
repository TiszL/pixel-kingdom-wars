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
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandOwner
import gg.pixelkingdomwars.nativeclient.ui.economy.paidStarterHousekeeps
import gg.pixelkingdomwars.nativeclient.ui.economy.starterDriver
import gg.pixelkingdomwars.nativeclient.ui.economy.StarterExpeditionViewModel
import kotlinx.coroutines.awaitCancellation

/** Reuses the existing session repository and encrypted journal for every starter departure. N-C5 GAMEPLAY-UI-A: returns
 *  its command owner to the common Home root (no nested content, no UI of its own). */
@Composable fun PaidStarterExpeditionRegistration(graph: AppGraph, session: SessionGraph, ordinaryVisible: Boolean = false, admit: () -> Boolean = { true }): FleetCommandOwner {
    val account by graph.account.state.collectAsState(); val content by graph.content.state.collectAsState()
    val interlock by session.interlock.state.collectAsState()
    val allowed = content.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed
    val opened = remember(session) { runCatching { session.starterExpedition } }; val repository = opened.getOrNull()
    val model = repository?.let { viewModel<StarterExpeditionViewModel>(key = "paid-starter-${System.identityHashCode(session)}",
        factory = viewModelFactory { initializer { StarterExpeditionViewModel(it) } }) }
    val state = model?.state?.collectAsState()?.value
    var show by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    var historyOnly by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    // Inputs reset live remembers; this separate stamp also validates process-restored flags.
    var savedWallet by rememberSaveable { mutableStateOf("") }
    var savedOrigin by rememberSaveable { mutableStateOf("") }
    val actor = PhaseERegistrationActor(session.session.wallet, session.session.origin)
    fun currentPresentation() = phaseERegistrationPresentation(
        PhaseERegistrationActor(savedWallet, savedOrigin), actor, show, historyOnly)
    fun present(next: PhaseERegistrationPresentation) {
        savedWallet = actor.wallet; savedOrigin = actor.origin
        historyOnly = next.historyOnly; show = next.show
    }
    val presentation = currentPresentation()
    SideEffect {
        if (PhaseERegistrationActor(savedWallet, savedOrigin) != actor)
            present(PhaseERegistrationPresentation())
    }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // UI-R1: ONE visible starter driver. While the ordinary form or the retained standalone route is visible, this owner — shown or
    // hidden — never refreshes or dismisses the SHARED starter repository (that would clear the visible ordinary review/view and
    // advance its epoch). Otherwise it drives as before (shown) or performs discovery housekeeping (hidden, nothing else visible).
    val drives = paidStarterHousekeeps(starterDriver(ordinaryVisible, show))
    DisposableEffect(model, lifecycle, drives) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP && drives) model?.dismiss() }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer); if (drives) model?.dismiss() }
    }
    LaunchedEffect(model, lifecycle, account.baseSelectionGeneration, content.manifest, drives) { // UI-R2: content-owner replacement retires the review while driving
        if (!drives) return@LaunchedEffect
        model?.dismiss(); lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model?.foreground(); awaitCancellation() }
    }
    LaunchedEffect(allowed, drives) { if (!allowed && drives) model?.dismiss() }
    val available = paidStarterEntryAvailable(state, opened.isFailure)
    val close = { model?.dismiss(); present(currentPresentation().close()) }
    fun ownerCurrent() = graph.sessionGraph.value === session && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    fun historyCurrent() = ownerCurrent() && currentPresentation().body == PhaseERegistrationBody.RECEIPTS
    val open: () -> Unit = { if (ownerCurrent() && admit()) present(currentPresentation().openLive()) }
    val openHistory: () -> Unit = { if (ownerCurrent() && admit()) present(currentPresentation().openHistory()) }
    val historyRows = state?.let(PhaseEReceiptRows::expeditions).orEmpty()
    if (available) PhaseEDoorEntry(PhaseEActivity.PAID_EXPEDITIONS,canLaunch={ownerCurrent()},onHistory=openHistory,onLaunch=open)
    return FleetCommandOwner(FleetCommandDestination.PAID_STARTER, available, isOpen = presentation.show, open = open, close = close, openHistory = openHistory) {
        if (model == null) PhaseEDesignedNotice("PAID REALM EXPEDITIONS", "Expeditions", "Saved expedition storage is unavailable. It has been preserved; restore access before continuing.", close)
        else if(presentation.body == PhaseERegistrationBody.RECEIPTS) PhaseEReceiptHistoryScreen("EXPEDITION RECEIPTS",historyRows,state?.busy==true,
            onRefresh={if(historyCurrent())model.refresh()},onCheck={check ->
                if(historyCurrent() && PhaseEReceiptRows.expeditions(model.state.value).any { it.check == check }) {
                    if(check.source==PhaseEReceiptSource.PENDING)model.check() else model.checkArchived(check.id)
                }
            },onBack=close)
        else PaidStarterExpeditionScreen(model, session.session.wallet, account.selectedBaseId, allowed, close)
    }
}
