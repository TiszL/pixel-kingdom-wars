package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticSelectedBase
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeSelectedBase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

internal fun phaseEDoorIdentity(graph: AppGraph): PhaseEDoorIdentity {
    val account = graph.account.state.value
    return PhaseEDoorIdentity(graph.sessionGraph.value, account.wallet.orEmpty(), account.selectedBaseId,
        account.baseSelectionGeneration, graph.content.state.value.manifest)
}

/** Existing repositories only. Discovery is GET-only and never runs while a routed command owns a review. */
@Composable internal fun PhaseERoutedBuildingScope(graph: AppGraph, session: SessionGraph?, discover: Boolean,
    onLaunch: (PhaseEActivity, String?) -> Unit, dispatcher: PhaseEBuildingDispatcher? = null,
    content: @Composable () -> Unit) {
    // This call site and its provider/Box survive boot restore, sign-in and expiry.
    CompositionLocalProvider(
        LocalPhaseEBaseSnapshot provides { session?.base?.state?.value?.base },
        LocalPhaseEBuildingDispatcher provides dispatcher,
    ) {
        Box(Modifier.fillMaxSize()) {
            content()
            if (session != null) PhaseERoutedBuildingSessionScope(graph, session, discover, onLaunch)
        }
    }
}

@Composable private fun PhaseERoutedBuildingSessionScope(graph: AppGraph, session: SessionGraph,
    discover: Boolean, onLaunch: (PhaseEActivity, String?) -> Unit) {
    val account by graph.account.state.collectAsState()
    val pack by graph.content.state.collectAsState()
    val battle by session.battle.state.collectAsState()
    val interlock by session.interlock.state.collectAsState()
    val baseState by session.base.state.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val workshop = remember(session) { runCatching { session.workshop }.getOrNull() }
    val refining = remember(session) { runCatching { session.ordinaryCrafting }.getOrNull() }
    val awnings = remember(session) { runCatching { session.boundCosmeticWorkshop }.getOrNull() }
    val wake = remember(session) { runCatching { session.boundCosmeticWakeWorkshop }.getOrNull() }
    val fleet = remember(session) { runCatching { session.starterFleet }.getOrNull() }
    val harvester = remember(session) { runCatching { session.harvester }.getOrNull() }
    val ws = workshop?.state?.collectAsState()?.value
    val rs = refining?.state?.collectAsState()?.value
    val aw = awnings?.state?.collectAsState()?.value
    val wk = wake?.state?.collectAsState()?.value
    val fs = fleet?.state?.collectAsState()?.value
    val hs = harvester?.state?.collectAsState()?.value
    val verified = remember(session) { mutableStateMapOf<String, PhaseEDoorIdentity>() }
    val captured = PhaseEDoorIdentity(session, session.session.wallet, account.selectedBaseId, account.baseSelectionGeneration, pack.manifest)
    val orders = pack.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed
    val battleActive = battle.battleVisible || battle.replay != null || battle.spectator != null
    var history by remember(session) { mutableStateOf<PhaseEActivity?>(null) }
    var historyBusy by remember(session) { mutableStateOf(false) }
    var historyError by remember(session) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(session, lifecycle, captured, discover, orders, battleActive, history) {
        verified.clear()
        if (!discover || !orders || battleActive || history != null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            verified.clear()
            suspend fun read(activity: String, action: suspend () -> Unit) {
                try {
                    action()
                    if (phaseEDoorIdentityCurrent(captured,phaseEDoorIdentity(graph))) verified[activity] = captured
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { verified.remove(activity) }
            }
            workshop?.let { read(PhaseEActivity.INGOT_WORKSHOP.name) { it.refresh(waitForIdle=true) } }
            refining?.let { read(PhaseEActivity.REFINING.name) { it.refresh(waitForIdle = true) } }
            awnings?.let { read("AWNING") { it.refresh(waitForIdle = true) } }
            wake?.let { read("WAKE") { it.refresh(waitForIdle = true) } }
            fleet?.let { read(PhaseEActivity.STARTER_FLEET.name) { it.refresh(waitForIdle = true) } }
            harvester?.let { read(PhaseEActivity.HARVESTERS.name) { it.refresh(waitForIdle = true) } }
            awaitCancellation()
        }
    }
    fun primary(activity: PhaseEActivity, type: String, advertised: () -> Boolean): () -> Boolean = {
        val liveBattle = session.battle.state.value
        phaseEDoorAdmitted(if(activity==PhaseEActivity.COSMETICS) verified["AWNING"] ?: verified["WAKE"] else verified[activity.name],phaseEDoorIdentity(graph),session.base.state.value.base,type,advertised(),
            lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED),
            liveBattle.battleVisible || liveBattle.replay != null || liveBattle.spectator != null,
            graph.content.state.value.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed)
    }
    val rows = when(history) {
        PhaseEActivity.INGOT_WORKSHOP -> ws?.let(PhaseEReceiptRows::workshop).orEmpty()
        PhaseEActivity.REFINING -> rs?.let(PhaseEReceiptRows::refining).orEmpty() + aw?.let(PhaseEReceiptRows::awnings).orEmpty() + wk?.let(PhaseEReceiptRows::wake).orEmpty()
        PhaseEActivity.COSMETICS -> aw?.let(PhaseEReceiptRows::awnings).orEmpty() + wk?.let(PhaseEReceiptRows::wake).orEmpty()
        PhaseEActivity.STARTER_FLEET -> fs?.let(PhaseEReceiptRows::starterFleet).orEmpty()
        PhaseEActivity.HARVESTERS -> hs?.let(PhaseEReceiptRows::harvester).orEmpty()
        else -> emptyList()
    }
    fun historyOpen(activity: PhaseEActivity, exists: Boolean): (() -> Unit)? = if (!exists) null else ({ historyError=null;history=activity })
    PhaseEDoorEntry(PhaseEActivity.INGOT_WORKSHOP,primary(PhaseEActivity.INGOT_WORKSHOP,"workshop") {
        workshop?.state?.value?.let { it.advertised && it.view?.inventory?.baseId == graph.account.state.value.selectedBaseId } == true
    }, historyOpen(PhaseEActivity.INGOT_WORKSHOP,ws?.let(PhaseEReceiptRows::workshop)?.isNotEmpty()==true)) { onLaunch(PhaseEActivity.INGOT_WORKSHOP,null) }
    PhaseEDoorEntry(PhaseEActivity.REFINING,primary(PhaseEActivity.REFINING,"workshop") {
        refining?.state?.value?.let { it.advertised && it.view?.baseId == graph.account.state.value.selectedBaseId } == true
    }, historyOpen(PhaseEActivity.REFINING,rs?.let(PhaseEReceiptRows::refining)?.isNotEmpty()==true || aw?.let(PhaseEReceiptRows::awnings)?.isNotEmpty()==true || wk?.let(PhaseEReceiptRows::wake)?.isNotEmpty()==true)) { onLaunch(PhaseEActivity.REFINING,null) }
    PhaseEDoorEntry(PhaseEActivity.COSMETICS,primary(PhaseEActivity.COSMETICS,"workshop") {
        val selected=graph.account.state.value.selectedBaseId
        val completed=session.base.state.value.base?.takeIf { it.baseId==selected }?.buildings.orEmpty().filter { !it.underConstruction && it.level>0 }
        val a=awnings?.state?.value;val w=wake?.state?.value
        (phaseEDoorIdentityCurrent(verified["AWNING"],phaseEDoorIdentity(graph)) && a?.advertised==true && a.view?.applicationReady==true && (a.view?.selectedBase as? BoundCosmeticSelectedBase.Available)?.baseId==selected && completed.any { it.type=="market" }) ||
            (phaseEDoorIdentityCurrent(verified["WAKE"],phaseEDoorIdentity(graph)) && w?.advertised==true && w.view?.applicationReady==true && (w.view?.selectedBase as? BoundCosmeticWakeSelectedBase.Available)?.baseId==selected && completed.any { it.type=="lodge" })
    }, historyOpen(PhaseEActivity.COSMETICS,aw?.let(PhaseEReceiptRows::awnings)?.isNotEmpty()==true || wk?.let(PhaseEReceiptRows::wake)?.isNotEmpty()==true)) { val selected=graph.account.state.value.selectedBaseId
        val a=awnings?.state?.value
        val awningCurrent=phaseEDoorIdentityCurrent(verified["AWNING"],phaseEDoorIdentity(graph)) && a?.advertised==true && a.view?.applicationReady==true &&
            (a.view?.selectedBase as? BoundCosmeticSelectedBase.Available)?.baseId==selected &&
            session.base.state.value.base?.takeIf { it.baseId==selected }?.buildings?.any { it.type=="market" && it.level>0 && !it.underConstruction }==true
        onLaunch(PhaseEActivity.COSMETICS,if(awningCurrent)"AWNINGS" else "AURORA") }
    PhaseEDoorEntry(PhaseEActivity.STARTER_FLEET,primary(PhaseEActivity.STARTER_FLEET,"berth") {
        fleet?.state?.value?.let { it.advertised && it.view?.baseId==graph.account.state.value.selectedBaseId }==true
    }, historyOpen(PhaseEActivity.STARTER_FLEET,fs?.let(PhaseEReceiptRows::starterFleet)?.isNotEmpty()==true)) { onLaunch(PhaseEActivity.STARTER_FLEET,null) }
    PhaseEDoorEntry(PhaseEActivity.HARVESTERS,primary(PhaseEActivity.HARVESTERS,"harvester") {
        harvester?.state?.value?.let { it.advertised && it.view?.baseId==graph.account.state.value.selectedBaseId }==true
    }, historyOpen(PhaseEActivity.HARVESTERS,hs?.let(PhaseEReceiptRows::harvester)?.isNotEmpty()==true)) { onLaunch(PhaseEActivity.HARVESTERS,null) }

    fun read(action: suspend () -> Unit) {
        if (historyBusy) return
        historyBusy=true;historyError=null
        scope.launch {
            try { action() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { historyError="Saved receipts could not be refreshed. Originals are preserved." }
            finally { historyBusy=false }
        }
    }
        history?.let { activity -> PhaseEReceiptHistoryScreen(activity.title,rows,historyBusy,historyError,
            onRefresh={read { when(activity) {
                PhaseEActivity.INGOT_WORKSHOP -> workshop?.check()
                PhaseEActivity.REFINING -> { refining?.refresh();awnings?.refresh();wake?.refresh() }
                PhaseEActivity.COSMETICS -> { awnings?.refresh();wake?.refresh() }
                PhaseEActivity.STARTER_FLEET -> fleet?.refresh()
                PhaseEActivity.HARVESTERS -> harvester?.refresh()
                else -> Unit
            } }}, onCheck={ check -> read {
                when(check.family) {
                    PhaseEReceiptFamily.WORKSHOP -> workshop?.check()
                    PhaseEReceiptFamily.REFINING -> if(check.source==PhaseEReceiptSource.PENDING) refining?.check() else refining?.checkArchived(check.id)
                    PhaseEReceiptFamily.STARTER_FLEET -> if(check.source==PhaseEReceiptSource.PENDING) fleet?.check() else fleet?.checkArchived(check.id)
                    PhaseEReceiptFamily.HARVESTER -> if(check.source==PhaseEReceiptSource.PENDING) harvester?.check() else harvester?.checkArchived(check.id)
                    PhaseEReceiptFamily.AWNING -> if(check.source==PhaseEReceiptSource.PENDING) awnings?.check() else awnings?.checkArchived(check.id)
                    PhaseEReceiptFamily.WAKE -> if(check.source==PhaseEReceiptSource.PENDING) wake?.check() else wake?.checkArchived(check.id)
                    else -> Unit
                }
            }}, onBack={history=null;historyError=null}) }
}
