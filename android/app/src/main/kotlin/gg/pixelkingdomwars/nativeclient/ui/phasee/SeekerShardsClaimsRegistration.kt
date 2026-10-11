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
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

/** Foreground discovery is GET-only; all new effects require the open current game panel. */
@Composable fun SeekerShardsClaimsRegistration(graph: AppGraph, session: SessionGraph, bases: @Composable () -> Unit) {
    val account by graph.account.state.collectAsState(); val content by graph.content.state.collectAsState()
    val interlock by session.interlock.state.collectAsState(); val battle by session.battle.state.collectAsState()
    val policy = seekerShardsClaimsPolicy(content.catalogue)
    val saved = remember(session) { runCatching { graph.seekerShardsClaimsStored(session) }.getOrDefault(true) }
    val lifetime = remember(session, policy) { SeekerShardsViewLifetime() }
    var show by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    // Another ISLAND REWARDS tab: closed here, then opened by its own registration once it has registered.
    var sibling by remember { mutableStateOf<PhaseEActivity?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val opened = remember(lifetime) { runCatching {
        if (policy == null) null else graph.seekerShardsClaimsClient(session) {
            val current = graph.content.state.value; val combat = session.battle.state.value
            lifetime.snapshot(current.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed &&
                !combat.battleVisible && combat.replay == null && combat.spectator == null,
                current.ready, current.manifest?.contentVersion)
        }
    } }
    val binding = opened.getOrNull()
    val model = binding?.let { viewModel<SeekerShardsClaimsViewModel>(key = "seeker-shards-${System.identityHashCode(lifetime)}",
        factory = viewModelFactory { initializer { SeekerShardsClaimsViewModel(it) } }) }
    val state = model?.state?.collectAsState()?.value
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    DisposableEffect(lifetime, model, lifecycle) {
        lifetime.setOpen(show); if (foreground) lifetime.start()
        val observer = LifecycleEventObserver { _, event -> when (event) {
            Lifecycle.Event.ON_START -> { lifetime.start(); foreground = true }
            Lifecycle.Event.ON_STOP -> { lifetime.stop(); foreground = false; model?.dismiss() }
            else -> Unit
        } }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer); lifetime.dispose(); model?.dismiss()
            graph.appScope.launch(start = CoroutineStart.UNDISPATCHED) { model?.close() }
        }
    }
    val orders = content.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed && !battle.battleVisible && battle.replay == null && battle.spectator == null
    LaunchedEffect(model, lifecycle, show, account.baseSelectionGeneration, orders, content.ready, content.manifest?.contentVersion) {
        lifetime.invalidate(); model?.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model?.foreground(); awaitCancellation() }
    }
    val close = { lifetime.setOpen(false); model?.dismiss(); show = false }
    if (show) {
        if (model == null) PhaseEDesignedNotice("SEEKER SHARDS", "Saved claims preserved",
            "Share access is unavailable. Restore content or storage access to continue.", close)
        else SeekerShardsRewardsHome(model, account.selectedBaseId, foreground && orders && policy != null,
            onSibling = { sibling = it; close() }, onBack = close)
    } else Column(Modifier.fillMaxSize()) {
        PhaseEPendingLaunch(sibling) { launched -> if (!launched) Toasts.post(PHASE_E_NOT_OPEN_LINE, true); sibling = null }
        if (seekerShardsEntryAvailable(state, opened.isFailure || saved && binding == null)) PhaseEActivityEntry(PhaseEActivity.SHARDS, onClick = { lifetime.setOpen(true); show = true })
        Box(Modifier.weight(1f)) { bases() }
    }
}
