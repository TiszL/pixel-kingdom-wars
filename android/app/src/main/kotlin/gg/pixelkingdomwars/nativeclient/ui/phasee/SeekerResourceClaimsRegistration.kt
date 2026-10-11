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
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.awaitCancellation

/** Single Phase E mount beside the unchanged bases screen. Discovery/recovery only GETs. */
@Composable fun SeekerResourceClaimsRegistration(graph: AppGraph, session: SessionGraph, wallet: WalletLogin?, bases: @Composable () -> Unit) {
    val account by graph.account.state.collectAsState()
    val content by graph.content.state.collectAsState()
    val interlock by session.interlock.state.collectAsState()
    val allowed = content.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed
    val opened = remember(session) { runCatching { session.seekerResourceClaims } }
    val repository = opened.getOrNull()
    val model = repository?.let { viewModel<SeekerResourceClaimsViewModel>(key = "seeker-resource-${System.identityHashCode(session)}",
        factory = viewModelFactory { initializer { SeekerResourceClaimsViewModel(it) } }) }
    val state = model?.state?.collectAsState()?.value
    var show by rememberSaveable(session.session.wallet) { mutableStateOf(false) }
    // Another ISLAND REWARDS tab: closed here, then opened by its own registration once it has registered.
    var sibling by remember { mutableStateOf<PhaseEActivity?>(null) }
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
        if (model == null) PhaseEDesignedNotice("SEEKER RESOURCE SHARES", "Resource shares",
            "Saved resource claim storage is unavailable. It has been preserved; restore access before continuing.", { show = false })
        else SeekerResourceRewardsHome(model, account.selectedBaseId, allowed,
            onSibling = { sibling = it; model.dismiss(); show = false }) { model.dismiss(); show = false }
    } else Column(Modifier.fillMaxSize()) {
        PhaseEPendingLaunch(sibling) { launched -> if (!launched) Toasts.post(PHASE_E_NOT_OPEN_LINE, true); sibling = null }
        if (seekerResourceEntryAvailable(state, opened.isFailure)) PhaseEActivityEntry(PhaseEActivity.RESOURCES, onClick = { show = true })
        Box(Modifier.weight(1f)) { bases() }
    }
}
