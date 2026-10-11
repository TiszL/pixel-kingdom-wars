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
import gg.pixelkingdomwars.nativeclient.data.FreeBasePurchaseState
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.awaitCancellation

fun freeBasePurchaseEntryAvailable(state: FreeBasePurchaseState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.view?.enabled == true || it.view?.receipt != null || it.journal.operation != null } == true

fun freeBasePurchaseCanReview(state: FreeBasePurchaseState, selectedBase: String?, actionsAllowed: Boolean): Boolean {
    val view = state.view ?: return false
    val saved = state.journal.operation
    return !state.busy && actionsAllowed && view.enabled && view.admission.allowed && view.receipt == null &&
        view.sourceBaseId == selectedBase && selectedBase != null && saved?.receipt == null &&
        (saved == null || (saved.command.request.sourceBaseId == selectedBase && saved.command.terms == view.terms))
}

/** Single Phase E mount beside the unchanged bases screen. Discovery/recovery only GETs. N-C5 GAMEPLAY-UI-A: the
 *  PhaseEActivityScope and the vehicle/equipment/paid-starter owners now live above the Home/Bases split (FleetCommandScope in
 *  PkwApp); the ActivityHost below still exposes their entries through that one scope. */
@Composable fun PhaseERegistration(graph: AppGraph, session: SessionGraph, wallet: WalletLogin?, bases: @Composable () -> Unit) {
    RealmPassportRegistration(graph, session) {
    DivineFragmentRegistration(graph, session) {
    DivineTrialRegistration(graph, session) {
    TournamentRegistration(graph, session, wallet) {
    CharterRegistration(graph, session, wallet) {
    RealmSalesRegistration(graph, session, wallet) {
    MiningClaimsRegistration(graph, session, wallet) {
    MiningTaxClaimsRegistration(graph, session, wallet, independentPins = graph.chainPins?.miningTax) {
    SeekerShardsClaimsRegistration(graph, session) {
    SeekerResourceClaimsRegistration(graph, session, wallet) {
    val account by graph.account.state.collectAsState()
    val content by graph.content.state.collectAsState()
    val interlock by session.interlock.state.collectAsState()
    val allowed = content.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed
    val opened = remember(session) { runCatching { session.freeBasePurchase } }
    val repository = opened.getOrNull()
    val model = repository?.let { viewModel<FreeBasePurchaseViewModel>(key = "free-base-${System.identityHashCode(session)}",
        factory = viewModelFactory { initializer { FreeBasePurchaseViewModel(it) } }) }
    val state = model?.state?.collectAsState()?.value
    var show by rememberSaveable(session.session.wallet) { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model?.dismiss() }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer); model?.dismiss() }
    }
    LaunchedEffect(model, lifecycle, account.baseSelectionGeneration) {
        model?.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model?.foreground(); awaitCancellation() }
    }
    LaunchedEffect(allowed) { if (!allowed) model?.dismiss() }
    if (show) {
        if (model == null) PhaseEDesignedNotice("FREE KINGDOM PURCHASE", "Kingdom purchase",
            "Saved purchase storage is unavailable. It has been preserved; restore access before continuing.", { show = false })
        else FreeBasePurchaseScreen(model, account.selectedBaseId, allowed) { model.dismiss(); show = false }
    } else Column(Modifier.fillMaxSize()) {
        if (freeBasePurchaseEntryAvailable(state, opened.isFailure)) PhaseEActivityEntry(PhaseEActivity.FREE_KINGDOM, onClick = { show = true })
        Box(Modifier.weight(1f)) { PhaseEActivityHost { bases() } }
    }
}
}
}
}
}
}
}
}
}
}
}
