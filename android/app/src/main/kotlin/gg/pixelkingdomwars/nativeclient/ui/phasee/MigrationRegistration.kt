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
import gg.pixelkingdomwars.nativeclient.data.migrationClient
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.awaitCancellation

/** Existing-clan registration with independent lifetime and saved original history. */
@Composable fun MigrationRegistration(graph: AppGraph, session: SessionGraph, wallet: WalletLogin?, contentPage: @Composable (() -> Unit, Boolean) -> Unit) {
    val account by graph.account.state.collectAsState(); val clans by session.clans.state.collectAsState(); val content by graph.content.state.collectAsState(); val interlock by session.interlock.state.collectAsState(); val battle by session.battle.state.collectAsState()
    val lifetime = remember(session, wallet) { CharterViewLifetime() }
    var show by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    val opened = remember(lifetime) { runCatching {
        graph.migrationClient(session, wallet, lifecycle = {
            val current = graph.content.state.value; val currentBattle = session.battle.state.value
            lifetime.snapshot(current.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed,
                current.ready, current.manifest?.contentVersion,
                currentBattle.battleVisible || currentBattle.replay != null || currentBattle.spectator != null,
                "${graph.account.state.value.baseSelectionGeneration}:${graph.account.state.value.selectedBaseId}")
        })
    } }
    val client = opened.getOrNull()
    val model = client?.let { viewModel<MigrationViewModel>(key = "migration-${System.identityHashCode(lifetime)}",
        factory = viewModelFactory { initializer { MigrationViewModel(it.repository, it.wallet) } }) }
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
    LaunchedEffect(model, lifecycle, show, content.ready, content.manifest?.contentVersion, orders, battleActive, account.baseSelectionGeneration) {
        lifetime.invalidate(); model?.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model?.foreground(); awaitCancellation() }
    }
    val close = { lifetime.setOpen(false); model?.dismiss(); show = false }
    val configured = client?.configured == true
    val allowed = foreground && charterActionsAllowed(configured,
        lifetime.snapshot(orders, content.ready, content.manifest?.contentVersion, battleActive))
    if (show) {
        if (model == null) PhaseEDesignedNotice("REGISTER CLAN CHARTER", "Clan charter", "Saved migration storage is unavailable. Restore access before continuing.", close)
        else MigrationScreen(model, allowed, close)
    } else contentPage({ lifetime.setOpen(true); show = true }, migrationEntryAvailable(state, configured, opened.isFailure) || clans.membership?.clan?.leaderWallet == session.session.wallet)
}
