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
import gg.pixelkingdomwars.nativeclient.data.MiningClaimsLifecycle
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.awaitCancellation

/** Readable from wallet/RPC workers. Closing invalidates admission, never the durable evidence callback. */
class MiningClaimsViewLifetime {
    private var active = true; private var visible = false; private var open = false; private var epoch = 0L
    @Synchronized fun start() { if (active && !visible) { visible = true; advance() } }
    @Synchronized fun setOpen(value: Boolean) { if (active && open != value) { open = value; advance() } }
    @Synchronized fun stop() { visible = false; advance() }
    @Synchronized fun invalidate() { advance() }
    @Synchronized fun dispose() { active = false; visible = false; open = false; advance() }
    private fun advance() { epoch = Math.addExact(epoch, 1L) }
    @Synchronized fun snapshot(actionsAllowed: Boolean, contentReady: Boolean, contentIdentity: String?, battleActive: Boolean) =
        MiningClaimsLifecycle(active, visible, epoch, open && actionsAllowed, contentReady, contentIdentity, battleActive)
}

fun miningClaimsActionsAllowed(configured: Boolean, page: MiningClaimsLifecycle): Boolean = configured && page.active && page.visible &&
    page.actionsAllowed && page.contentReady && !page.contentIdentity.isNullOrBlank() && !page.battleActive

/** The single Phase E registration owns discovery and recovery, independent of any selected base. */
@Composable fun MiningClaimsRegistration(graph: AppGraph, session: SessionGraph, wallet: WalletLogin?, bases: @Composable () -> Unit) {
    val content by graph.content.state.collectAsState()
    val interlock by session.interlock.state.collectAsState()
    val battle by session.battle.state.collectAsState()
    val lifetime = remember(session, wallet) { MiningClaimsViewLifetime() }
    var show by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    val opened = remember(lifetime) { runCatching {
        graph.miningClaimsClient(session, wallet, lifecycle = {
            val current = graph.content.state.value; val currentBattle = session.battle.state.value
            lifetime.snapshot(current.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed,
                current.ready, current.manifest?.contentVersion,
                currentBattle.battleVisible || currentBattle.replay != null || currentBattle.spectator != null)
        }, independentPins = graph.chainPins?.miningClaim)
    } }
    val client = opened.getOrNull()
    val model = client?.let { viewModel<MiningClaimsViewModel>(key = "mining-claims-${System.identityHashCode(lifetime)}",
        factory = viewModelFactory { initializer { MiningClaimsViewModel(it.repository, it.wallet) } }) }
    val state = model?.state?.collectAsState()?.value
    DisposableEffect(lifetime, model, lifecycle) {
        lifetime.setOpen(show)
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
    LaunchedEffect(model, lifecycle, show, content.ready, content.manifest?.contentVersion, orders, battleActive) {
        lifetime.invalidate(); model?.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model?.foreground(); awaitCancellation() }
    }
    val close = { lifetime.setOpen(false); model?.dismiss(); show = false }
    val allowed = foreground && miningClaimsActionsAllowed(client?.newActionsConfigured == true,
        lifetime.snapshot(orders, content.ready, content.manifest?.contentVersion, battleActive))
    if (show) {
        if (model == null) PhaseEDesignedNotice("KEEP MINING", "Mining claims",
            "Saved mining claim storage is unavailable. It has been preserved; restore access before continuing.", close)
        else MiningClaimsScreen(model, allowed, close)
    } else Column(Modifier.fillMaxSize()) {
        if (miningClaimsEntryAvailable(state, opened.isFailure)) PhaseEActivityEntry(PhaseEActivity.MINING, onClick = { lifetime.setOpen(true); show = true })
        Box(Modifier.weight(1f)) { bases() }
    }
}
