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
import gg.pixelkingdomwars.nativeclient.data.miningTaxClaimsPolicy
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

/** Missing alone hides history. Metadata errors/corrupt entries preserve recovery visibility. */
fun miningTaxClaimsEntryDiscovered(configured: Boolean, contains: () -> Boolean): Boolean =
    configured || runCatching(contains).getOrDefault(true)

/** Production defaults remain closed; opening a saved entry never derives its trust from storage. */
@Composable fun MiningTaxClaimsRegistration(graph: AppGraph, session: SessionGraph, wallet: WalletLogin?,
    independentPins: MiningTaxClaimsSigningTrust? = null, historicalPolicy: MiningTaxClaimsSigningPolicy? = null,
    miningEnabled: () -> Boolean = { false }, bases: @Composable () -> Unit) {
    val content by graph.content.state.collectAsState(); val interlock by session.interlock.state.collectAsState(); val battle by session.battle.state.collectAsState()
    val latestEnabled by rememberUpdatedState(miningEnabled)
    val configured = independentPins != null && latestEnabled()
    val discovered = remember(session, configured) { miningTaxClaimsEntryDiscovered(configured) { graph.miningTaxClaimsStored(session) } }
    val dayUnit = historicalPolicy ?: miningTaxClaimsPolicy(content.catalogue)?.signing()
    val lifetime = remember(session, wallet, independentPins, dayUnit, discovered) { MiningTaxClaimsViewLifetime() }
    var show by rememberSaveable(session.session.wallet, session.session.origin) { mutableStateOf(false) }
    // Another ISLAND REWARDS tab: closed here, then opened by its own registration once it has registered.
    var sibling by remember { mutableStateOf<PhaseEActivity?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    val opened = remember(lifetime) { runCatching {
        if (!discovered) null else graph.miningTaxClaimsClient(session, wallet, lifecycle = {
            val current = graph.content.state.value; val currentBattle = session.battle.state.value
            lifetime.snapshot(current.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed,
                current.ready, current.manifest?.contentVersion,
                currentBattle.battleVisible || currentBattle.replay != null || currentBattle.spectator != null)
        }, independentPins, dayUnit, miningEnabled = { latestEnabled() })
    } }
    val client = opened.getOrNull()
    val model = client?.let { viewModel<MiningTaxClaimsViewModel>(key = "mining-tax-${System.identityHashCode(lifetime)}",
        factory = viewModelFactory { initializer { MiningTaxClaimsViewModel(it.repository, it.wallet) } }) }
    DisposableEffect(lifetime, model, lifecycle) {
        lifetime.setOpen(show)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) lifetime.start()
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
    val battleActive = battle.battleVisible || battle.replay != null || battle.spectator != null
    val orders = content.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed
    LaunchedEffect(model, lifecycle, show, content.ready, content.manifest?.contentVersion, orders, battleActive, configured) {
        lifetime.invalidate(); model?.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model?.foreground(); awaitCancellation() }
    }
    val close = { lifetime.setOpen(false); model?.dismiss(); show = false }
    val policy = client?.policy?.invoke()
    val allowed = foreground && miningTaxClaimsActionsAllowed(configured && policy != null,
        lifetime.snapshot(orders, content.ready, content.manifest?.contentVersion, battleActive))
    if (show && discovered) {
        if (model == null) PhaseEDesignedNotice("KEEP TAX CLAIMS & RECEIPTS", "Tax claims",
            "Saved tax claims are preserved. Access is currently unavailable.", close)
        else MiningTaxRewardsHome(model, allowed, policy, onSibling = { sibling = it; close() }, onBack = close)
    } else Column(Modifier.fillMaxSize()) {
        PhaseEPendingLaunch(sibling) { launched -> if (!launched) Toasts.post(PHASE_E_NOT_OPEN_LINE, true); sibling = null }
        if (discovered) PhaseEActivityEntry(PhaseEActivity.MINING_TAX, onClick = { lifetime.setOpen(true); show = true })
        Box(Modifier.weight(1f)) { bases() }
    }
}
