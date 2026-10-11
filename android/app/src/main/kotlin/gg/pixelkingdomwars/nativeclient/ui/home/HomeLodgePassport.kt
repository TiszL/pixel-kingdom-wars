package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
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
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.phasee.RealmPassportViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PassportUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.SourceState
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import java.time.ZoneId

/** The existing account Passport owner, hoisted above Home/Bases; no base/deed or money authority. */
internal class HomePassportOwner(val session: SessionGraph, val model: RealmPassportViewModel, val current: () -> Boolean) {
    suspend fun page(kind: String, next: Boolean, admitted: () -> Boolean): PassportSection<PassportExpeditions>? {
        if (!current() || !admitted()) return null
        model.awaitIdle()
        if (!current() || !admitted()) return null
        val job = model.readExpeditions(kind, next) ?: return null
        job.join()
        return model.state.value.expeditions.takeIf { !job.isCancelled && current() && admitted() }
    }
}

internal val LocalHomePassportOwner = staticCompositionLocalOf<HomePassportOwner?> { null }

/** Exactly one repository/model and one dismissal lifetime for the current authenticated account. */
@Composable internal fun HomePassportScope(graph: AppGraph, session: SessionGraph?, content: @Composable () -> Unit) {
    val owner = if (session == null) null else rememberHomePassportOwner(graph, session)
    CompositionLocalProvider(LocalHomePassportOwner provides owner, content = content)
}

@Composable private fun rememberHomePassportOwner(graph: AppGraph, session: SessionGraph): HomePassportOwner {
    val model = viewModel<RealmPassportViewModel>(key = "realm-passport-${System.identityHashCode(session)}",
        factory = viewModelFactory { initializer { RealmPassportViewModel(RealmPassportRepository(session.session, graph.holder, session.api)) } })
    val owner = remember(graph, session, model) { HomePassportOwner(session, model) {
        graph.sessionGraph.value === session && graph.holder.current === session.session
    } }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    return owner
}

/** Discovery alone is not a capability witness; only the verified expedition observation admits the command. */
internal fun homePassportFeatureFact(state: RealmPassportState?): GateFact {
    val section = state?.expeditions ?: return GateFact.Unknown
    return when {
        section.error != null -> GateFact.Denied("Passport records could not be refreshed.")
        section.observation?.unavailableReason == "NOT_CONFIGURED" -> GateFact.Denied("Passport is not open on this server yet")
        section.observation?.unavailableReason != null -> GateFact.Denied("Passport records are unavailable.")
        section.observation?.data != null -> GateFact.Allowed
        else -> GateFact.Unknown
    }
}

/** One admitted warm page makes the visible command truthful; no background polling. */
@Composable internal fun HomePassportWarmRead(owner: HomePassportOwner?, identity: HomeRouteIdentity?, canRead: () -> Boolean) {
    val admitted by rememberUpdatedState(canRead)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val observedKind = owner?.model?.state?.collectAsState()?.value?.expeditions?.observation?.data?.kind
    LaunchedEffect(owner, identity, lifecycle, observedKind) {
        if (owner == null || identity == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            snapshotFlow { admitted() }.first { it }
            recoverHomePassportStarter({ owner.model.state.value }, owner.current, { admitted() }, owner.model::awaitIdle) {
                owner.page("starter", false) { admitted() }
            }
            awaitCancellation()
        }
    }
}

/** A bounded recovery after a cancelled advanced page, using the same owner's serializer and live admission. */
internal suspend fun recoverHomePassportStarter(state: () -> RealmPassportState, current: () -> Boolean,
    admitted: () -> Boolean, awaitIdle: suspend () -> Unit, readStarter: suspend () -> Unit) {
    if (!current() || !admitted()) return
    awaitIdle()
    if (current() && admitted() && state().expeditions.observation?.data?.kind != "starter") readStarter()
}

/** Held pages belong only to this Home identity. Every repository page is folded before the next read starts. */
internal class HomePassportPages {
    var failure: PassportSection<PassportExpeditions>? by mutableStateOf(null)
        private set
    var starter: PassportReturns? by mutableStateOf(null)
        private set
    var advanced: PassportReturns? by mutableStateOf(null)
        private set
    fun observeKind(section: PassportSection<PassportExpeditions>, kind: String) {
        // Advanced expeditions are not live on every server; that is not a failure of starter history.
        if (kind == "advanced" && section.observation?.unavailableReason == "NOT_CONFIGURED") return
        observe(section)
    }
    fun observe(section: PassportSection<PassportExpeditions>) {
        if (section.error != null || section.observation?.unavailableReason != null) {
            if (failure == null || section.observation?.unavailableReason == "SOURCE_CONFLICT") failure = section
        }
        starter = accumulateReturns(starter, section, "starter")
        advanced = accumulateReturns(advanced, section, "advanced")
    }
    fun beginRefresh() { failure = null }
}

/** End on the starter capability witness; an optional advanced history cannot lock the whole Passport. */
internal suspend fun readHomePassportPages(held: HomePassportPages, admitted: () -> Boolean,
    read: suspend (kind: String, next: Boolean) -> PassportSection<PassportExpeditions>?) {
    for (kind in listOf("advanced", "starter"))
        readHomePassportKind(kind, admitted, { next -> read(kind, next) }, { held.observeKind(it, kind) })
}

internal suspend fun readHomePassportKind(kind: String, admitted: () -> Boolean,
    read: suspend (next: Boolean) -> PassportSection<PassportExpeditions>?, observe: (PassportSection<PassportExpeditions>) -> Unit) {
    var next = false
    val cursors = mutableSetOf<String>()
    while (admitted()) {
        val section = read(next) ?: return
        if (!admitted()) return
        observe(section)
        if (section.error != null || section.busy) return
        val page = section.observation?.data?.takeIf { it.kind == kind } ?: return
        val cursor = page.nextCursor ?: return
        if (!cursors.add(cursor)) return
        next = true
    }
}

/** The Lodge sheet's realm and Passport-availability facts. */
internal data class HomeLodgePassportFacts(val homeRealmId: String?, val available: Boolean)

/** Observed, not read once: a realm placed in the deed directory or a new Passport observation recomposes an open Lodge
 *  sheet (a `.value` read here left the PASSPORT tab stale until something else recomposed it). [passport] is null while
 *  there is no current Passport owner. */
@Composable internal fun homeLodgePassportFacts(account: StateFlow<AccountState>, baseId: String,
    passport: StateFlow<RealmPassportState>?): HomeLodgePassportFacts {
    val directory = account.collectAsState().value.directory
    val state = passport?.collectAsState()?.value
    return HomeLodgePassportFacts(directory?.bases?.firstOrNull { it.id == baseId }?.fantasyRealmId,
        state?.let(::homePassportFeatureFact) == GateFact.Allowed)
}

internal data class HomePassportPresentation(val ui: PassportUi, val refresh: () -> Unit)

@Composable internal fun homeLodgePassport(owner: HomePassportOwner?, identity: HomeRouteIdentity, active: Boolean,
    homeRealmId: String?, lodgeTier: Int, nowMs: Long, canRead: () -> Boolean): HomePassportPresentation {
    val emission = owner?.model?.state?.collectAsState()?.value
    val state = emission?.takeIf { owner != null && owner.current() && identity.session === owner.session.session }
    val held = remember(owner, identity) { HomePassportPages() }
    var refresh by remember(owner, identity) { mutableIntStateOf(0) }
    var loading by remember(owner, identity) { mutableStateOf(false) }
    val admitted by rememberUpdatedState(canRead)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(owner, identity, active, refresh, lifecycle) {
        if (owner == null || !active) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            snapshotFlow { admitted() }.first { it }
            loading = true
            held.beginRefresh()
            try {
                readHomePassportPages(held, { admitted() && owner.current() }) { kind, next ->
                    owner.page(kind, next) { admitted() }
                }
                owner.model.awaitIdle()
                if (admitted() && owner.current()) owner.model.refreshCurrent()?.join()
            } finally { loading = false }
            awaitCancellation()
        }
    }
    val mappedState = (state ?: RealmPassportState()).let { held.failure?.let { failed -> it.copy(expeditions = failed) } ?: it }
    val mapped = passportLiveUi(mappedState, held.starter, held.advanced, homeRealmId, lodgeTier, nowMs, ZoneId.systemDefault())
    val ui = mapped.copy(loading = mapped.loading || loading,
        sourceState = if (state == null) SourceState.UNAVAILABLE else mapped.sourceState)
    return HomePassportPresentation(ui) { if (admitted() && owner?.current() == true) refresh++ }
}
