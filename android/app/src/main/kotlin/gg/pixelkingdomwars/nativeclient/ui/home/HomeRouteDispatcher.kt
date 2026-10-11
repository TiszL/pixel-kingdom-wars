package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint
import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.data.WorkshopState
import gg.pixelkingdomwars.nativeclient.data.WorkshopRepository
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.data.VEHICLE_READ_FAILED
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.HomeWorkshopBody
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.HomeWorkshopReadStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopMoneySheetUi
import okhttp3.HttpUrl.Companion.toHttpUrl
import gg.pixelkingdomwars.nativeclient.ui.nav.HomeCommunityReads
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageLiveInputs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyagePolicyFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.vehicleUnavailableReason
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LodgeLocalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LodgeLiveCallbacks
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LodgeLiveDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.lodgeSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BerthLocalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BerthLiveCallbacks
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BerthLiveDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.berthSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.berthSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterLiveUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterLiveActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterLatestSequence
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureAction
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureResolution
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureScene
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import java.util.UUID
import java.util.WeakHashMap

/** In-memory lifecycle identity. [session] is the actual owner reference, never a token or cookie.
 * Even equal wallet/session values must not revive a request from a replaced session owner. */
data class HomeRouteIdentity(val session: Any, val baseId: String, val baseSelectionGeneration: Long) {
    init { require(baseId.isNotBlank()); require(baseSelectionGeneration >= 0) }

    override fun equals(other: Any?): Boolean = other is HomeRouteIdentity &&
        session === other.session && baseId == other.baseId && baseSelectionGeneration == other.baseSelectionGeneration

    override fun hashCode(): Int = 31 * (31 * System.identityHashCode(session) + baseId.hashCode()) +
        baseSelectionGeneration.hashCode()
}

/** Fresh, already admitted observations supplied by the existing owners. Missing facts stay unknown. */
data class HomeRouteContext(val identity: HomeRouteIdentity, val gates: GateContext)

// AccountSession is a final reference-identity owner. Rotation keeps that owner in AppGraph;
// sign-in/restoration or process recreation creates a new owner and therefore a new opaque ID.
// Weak keys and String values retain neither a retired account nor any credential-derived value.
private val homeRouteSessionIds = WeakHashMap<AccountSession, String>()

internal fun homeRouteSessionId(session: AccountSession): String = synchronized(homeRouteSessionIds) {
    homeRouteSessionIds.getOrPut(session) { UUID.randomUUID().toString() }
}

/** One instance per Home identity. Every required owner starts unknown; a callback belongs only
 * to its current mount registration. A retired composition cannot admit or block its replacement.
 * This observes existing reviews; it never closes them or grants permission to submit work. */
internal class HomeRouteReviewGate(requiredOwners: Set<String>) {
    private val requiredOwners = requiredOwners.toSet().also { owners ->
        require(owners.isNotEmpty() && owners.none { it.isBlank() })
    }
    private data class Observation(val token: Any, val blocked: Boolean)
    private val observations = mutableMapOf<String, Observation>()
    private var closed = false
    private val mutableBlocked = MutableStateFlow(true)
    val blocked: StateFlow<Boolean> = mutableBlocked.asStateFlow()

    class Registration internal constructor(
        private val reportValue: (Boolean) -> Unit,
        private val retire: () -> Unit,
    ) {
        fun report(blocked: Boolean) = reportValue(blocked)
        fun close() = retire()
    }

    @Synchronized fun register(owner: String): Registration {
        check(!closed) { "The Home review scope is closed" }
        require(owner in requiredOwners) { "Unknown Home review owner" }
        val token = Any()
        observations[owner] = Observation(token, blocked = true)
        recompute()
        return Registration({ blocked -> report(owner, token, blocked) }, { retire(owner, token) })
    }

    @Synchronized private fun report(owner: String, token: Any, blocked: Boolean) {
        if (closed || observations[owner]?.token !== token) return
        observations[owner] = Observation(token, blocked)
        recompute()
    }

    @Synchronized private fun retire(owner: String, token: Any) {
        if (closed || observations[owner]?.token !== token) return
        observations.remove(owner)
        recompute()
    }

    @Synchronized fun close() {
        closed = true
        observations.clear()
        mutableBlocked.value = true
    }

    private fun recompute() {
        mutableBlocked.value = closed || requiredOwners.any { observations[it]?.blocked != false }
    }
}

enum class HomeRouteDispatchResult { NOT_HEAD, STALE, HIDDEN, LOCKED, DISPATCHED, DEFERRED, REFUSED }

/** Navigation distinguishes a transient owner/admission change from a structurally unsupported route. */
enum class HomeNavigationResult { DISPATCHED, DEFERRED, REFUSED }

/** The existing hosts retain their admission, reviews and money confirmations. [dispatchBlocked]
 * means wait before calling an owner. A false callback is a terminal refusal with no effect;
 * a true callback consumes the head once. Navigation owners with a live admission re-check override
 * [navigateResult] so a blocker arriving after publication can still defer without a refusal.
 * Destinations are passed intact, including tabs, filters and nested handoff destinations. */
interface HomeRouteHost {
    /** Display-only fallback owned by the navigation host; false performs no navigation and does not explain. */
    fun openLegacyFeature(id: FeatureId): Boolean = false
    /** Used only after legacy also refused; capture restrictions must not block access to recovery. */
    fun legacyRefusalReason(id: FeatureId): String? = null
    fun didEnqueue(request: HomeRequest.Open) {}
    /** A partial mount must decline capture for bodies it does not own, preserving the legacy door. */
    fun canOpen(id: FeatureId, tab: HomeTab): Boolean = true
    /** A terminal, truthful refusal independent of warming owner admission. Legacy Bases doors are separate. */
    fun refusalReason(id: FeatureId): String? = null
    /** Read-only capability observations may still be warming before registry resolution. */
    fun prepareFeature(id: FeatureId): HomeNavigationResult = HomeNavigationResult.DISPATCHED
    /** Current owner admission, including private confirmation/Seal state that Back priority cannot
     * distinguish from a building sheet. Unknown/not mounted stays true. The actual body owners
     * must publish changes so HomeShell can retry a deferred head when their review closes. */
    val dispatchBlocked: StateFlow<Boolean>
    /** Compatibility callback for existing hosts; dispatcher navigation uses [navigateResult]. */
    fun navigate(destination: Destination, tab: HomeTab): Boolean
    fun navigateResult(destination: Destination, tab: HomeTab): HomeNavigationResult =
        if (navigate(destination, tab)) HomeNavigationResult.DISPATCHED else HomeNavigationResult.REFUSED
    fun action(action: FeatureAction): Boolean
    fun scene(scene: FeatureScene): Boolean
    fun worldHandoff(island: String, then: Destination?): Boolean
    fun homeHandoff(destination: Destination.FocusBuilding): Boolean
    fun locked(reason: String)
}

/** The HomeShell provides this inside its subtree; absent means keep the existing owner path. */
val LocalHomeRouteDispatcher = staticCompositionLocalOf<HomeRouteDispatcher?> { null }

/** Installed only with the actual destination consumers. A missing host keeps the legacy mount;
 * the dispatcher must never accept a destination which would render an invented placeholder. */
val LocalHomeRouteHost = staticCompositionLocalOf<HomeRouteHost?> { null }

/** Economy only captures a Home intent or opens its existing screen. It never renders or consumes a Home sheet. */
internal class HomeEconomyRouteHost(
    private val admitted: (FeatureId) -> Boolean,
    private val legacy: (FeatureId) -> Boolean,
    private val returnHome: () -> Unit,
    private val explain: (String) -> Unit,
) : HomeRouteHost {
    override val dispatchBlocked: StateFlow<Boolean> = MutableStateFlow(false)
    override fun canOpen(id: FeatureId, tab: HomeTab) = tab == HomeTab.KINGDOM && id.value in HOME_ECONOMY_FEATURES && admitted(id)
    override fun openLegacyFeature(id: FeatureId) = legacy(id)
    override fun legacyRefusalReason(id: FeatureId) = "This Economy screen is no longer current. Open Economy again."
    override fun didEnqueue(request: HomeRequest.Open) = returnHome()
    override fun navigate(destination: Destination, tab: HomeTab) = false
    override fun action(action: FeatureAction) = false
    override fun scene(scene: FeatureScene) = false
    override fun worldHandoff(island: String, then: Destination?) = false
    override fun homeHandoff(destination: Destination.FocusBuilding) = false
    override fun locked(reason: String) = explain(reason)
}

/** Aggregate Economy entry has no selected-building target. Existing buildings and server facts remain authoritative. */
internal fun homeEconomyRouteContext(identity: HomeRouteIdentity?, state: gg.pixelkingdomwars.nativeclient.data.BaseState,
    features: Map<String, gg.pixelkingdomwars.nativeclient.ui.features.GateFact>): HomeRouteContext? {
    val base = state.base ?: return null
    if (identity == null || state.loading || state.error != null || base.baseId != identity.baseId) return null
    val buildings = base.buildings.filter { it.id.isNotBlank() && it.type.isNotBlank() && it.level >= 0 }
        .groupBy { it.type }.mapValues { (_, rows) ->
            val completed = rows.filter { !it.underConstruction && it.level > 0 }
            gg.pixelkingdomwars.nativeclient.ui.features.BuildingGateState(
                (completed.ifEmpty { rows }).maxOf { it.level }, completed.isNotEmpty())
        }
    return HomeRouteContext(identity, GateContext(baseId = identity.baseId,
        keepLevel = base.player.keepLevel.takeIf { it >= 0 }, buildings = buildings, serverFeatures = features))
}

/** One transport into B's registry and the existing hosts. Capture never resolves a destination,
 * clears a selection, navigates or submits work. Consumption resolves against current observations. */
class HomeRouteDispatcher(
    private val requests: HomeRequests,
    private val registry: FeatureRegistry,
    private val current: () -> HomeRouteContext?,
    private val host: HomeRouteHost,
    private val entry: HomeRequestEntry = HomeRequestEntry.HOME,
) {
    fun openFeature(id: FeatureId, hostTab: HomeTab = HomeTab.KINGDOM): Boolean = enqueue(id, hostTab, null)

    /** True means this door belongs to the typed host, including while its identity is unknown.
     * Falling through in that case would bypass currentness/review gates through a legacy route. */
    fun handleFeatureDoor(id: FeatureId, hostTab: HomeTab = HomeTab.KINGDOM): Boolean {
        if (entry == HomeRequestEntry.ECONOMY) return openFeatureOrLegacy(id, hostTab)
        host.refusalReason(id)?.let { host.locked(it); return true }
        if (!host.canOpen(id, hostTab)) return false
        if (!openFeature(id, hostTab)) host.locked("This feature is waiting for your kingdom to finish loading.")
        return true
    }

    fun buildingCommandBar(building: gg.pixelkingdomwars.nativeclient.model.Building,
        presentation: gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandPresentation =
            gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandPresentation()): gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi? =
        context()?.let { gg.pixelkingdomwars.nativeclient.ui.command.buildingCommands(building, it.gates, registry, presentation) }

    fun openBuildingDoor(id: FeatureId, selection: BuildingSelection) {
        if (selection != currentSelection()) { host.locked("Select the current building before opening its controls."); return }
        val type = when (id.value) { "workshop.craft" -> "workshop"; "market.trade" -> "market"; "harvester.harvest" -> "harvester"; "lodge.expedition", "lodge.passport" -> "lodge"; "berth.fleet" -> "berth"; "clan.open", "clan.charter", "clan.tournament" -> "clanhall"; else -> null }
        if (type != selection.type) { host.locked("These controls do not belong to the selected building."); return }
        if (id.value == "market.trade") {
            val fresh = context()
            if (fresh == null) { host.locked("Select the current Market before opening its controls."); return }
            // The canonical default is KEEP. Its existing owner remains responsible for reads, reviews and receipts.
            when (val resolved = registry.resolve(id, fresh.gates)) {
                is FeatureResolution.Navigate -> if (resolved.destination != Destination.Market() ||
                    host.dispatchBlocked.value || !host.openLegacyFeature(id)) {
                    host.locked("Market controls are unavailable. Finish the current review or loading step, then reopen the Market.")
                }
                is FeatureResolution.Locked -> host.locked(resolved.reason)
                else -> host.locked("Market controls are unavailable for this kingdom.")
            }
            return
        }
        if (type == "clanhall") {
            val fresh = context() ?: return
            // Clan's typed body is separate from the existing economy fallback. Keep its actual
            // building and server gates; an unknown Charter/Tournament fact is never permission.
            when (val resolved = registry.resolve(id, fresh.gates)) {
                is FeatureResolution.Navigate -> if (!openFeature(id, HomeTab.KINGDOM))
                    host.locked("Clan is waiting for the current kingdom. Open its controls again.")
                is FeatureResolution.Locked -> host.locked(resolved.reason)
                else -> host.locked("These Clan controls are unavailable on this server.")
            }
            return
        }
        if (id.value == "lodge.passport") {
            val fresh = context() ?: return
            when (val resolved = registry.resolve(id, fresh.gates)) {
                is FeatureResolution.Navigate -> openFeature(id, HomeTab.KINGDOM)
                is FeatureResolution.Locked -> host.locked(resolved.reason)
                else -> host.locked("Passport records are unavailable.")
            }
            return
        }
        openFeatureOrLegacy(id, HomeTab.KINGDOM)
    }

    /** Shared by the selected-building producer and Economy. A fallback never bypasses its owner's live guard. */
    private fun openFeatureOrLegacy(id: FeatureId, tab: HomeTab): Boolean {
        val fresh = context()
        val pending = requests.pending.value as? HomeRequest.Open
        if (id.value in HOME_ECONOMY_FEATURES && pending != null && fresh != null &&
            pending.featureId == id && pending.identity == fresh.identity) {
            val title = when (id.value) {
                "harvester.harvest" -> "Harvester"
                "lodge.expedition" -> "Lodge"
                "berth.fleet" -> "Fleet"
                "workshop.craft" -> "Workshop"
                else -> "these controls"
            }
            host.locked("Opening $title. Please wait.")
            return true
        }
        if (id.value in HOME_ECONOMY_FEATURES && fresh != null && !host.dispatchBlocked.value && host.canOpen(id, tab)) {
            val gates = fresh.gates
            // Capture only: the request-specific GET still supplies the real fact before consume navigates.
            // Substitute this one unknown fact for eligibility, retaining every other registry gate.
            val captureGates = if (id.value == "harvester.harvest" &&
                (gates.serverFeatures["phaseE.harvesters"] == null ||
                    gates.serverFeatures["phaseE.harvesters"] == gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Unknown) &&
                host.prepareFeature(id) != HomeNavigationResult.REFUSED) {
                GateContext(baseId = gates.baseId, walletLinked = gates.walletLinked, keepLevel = gates.keepLevel,
                    buildings = gates.buildings, serverFeatures = gates.serverFeatures +
                        ("phaseE.harvesters" to gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Allowed),
                    ownerFacts = gates.ownerFacts, history = gates.history, selection = gates.selection)
            } else gates
            if (registry.resolve(id, captureGates) is FeatureResolution.Navigate && openFeature(id, tab)) return true
        }
        if (id.value in HOME_ECONOMY_FEATURES && host.openLegacyFeature(id)) return true
        host.locked(host.legacyRefusalReason(id)
            ?: "These controls are not available yet. Finish the current review or loading step, then try again.")
        return false
    }

    fun openResources(
        id: FeatureId,
        resources: Destination.Resources,
        hostTab: HomeTab = HomeTab.KINGDOM,
    ): Boolean = enqueue(id, hostTab, resources)

    /** B's rendered-door guard calls this at click time, never from a cached composition snapshot. */
    fun currentSelection(): BuildingSelection? = context()?.let { fresh ->
        fresh.gates.selection.building?.takeIf { it.baseId == fresh.identity.baseId }
    }

    private fun enqueue(id: FeatureId, hostTab: HomeTab, resources: Destination.Resources?): Boolean {
        host.refusalReason(id)?.let { host.locked(it); return false }
        if (!host.canOpen(id, hostTab)) return false
        val fresh = context() ?: return false
        val request = HomeRequest.Open(id, fresh.identity, fresh.gates.selection, hostTab, resources, entry)
        requests.request(request)
        host.didEnqueue(request)
        return true
    }

    fun consume(request: HomeRequest.Open): HomeRouteDispatchResult = requests.dispatchOpen(request) {
        val fresh = context()
        if (fresh == null || request.identity != fresh.identity ||
            (request.entry == HomeRequestEntry.HOME && request.selection != fresh.gates.selection)) {
            return@dispatchOpen HomeRouteDispatchResult.STALE
        }
        host.refusalReason(request.featureId)?.let { return@dispatchOpen locked(it) }
        if (host.dispatchBlocked.value) {
            if (request.featureId.value == "hud.quests") host.locked("Quests is waiting for the current review or read to finish.")
            return@dispatchOpen HomeRouteDispatchResult.DEFERRED
        }
        when (host.prepareFeature(request.featureId)) {
            HomeNavigationResult.DEFERRED -> return@dispatchOpen HomeRouteDispatchResult.DEFERRED
            HomeNavigationResult.REFUSED -> return@dispatchOpen locked("Feature details could not be refreshed. Open the door again to retry.")
            HomeNavigationResult.DISPATCHED -> Unit
        }
        when (val resolution = registry.resolve(request.featureId, fresh.gates)) {
            FeatureResolution.Hidden -> HomeRouteDispatchResult.HIDDEN
            is FeatureResolution.Locked -> locked(resolution.reason)
            else -> {
                // A resource readout may refine only a Resources row which the current registry admits.
                // In particular it cannot turn an action, scene or aggregate destination into a drawer.
                if (request.resources != null &&
                    (resolution !is FeatureResolution.Navigate || resolution.destination !is Destination.Resources)) {
                    return@dispatchOpen locked("This feature does not open resources")
                }
                val accepted = when (resolution) {
                    is FeatureResolution.Navigate -> when (host.navigateResult(request.resources ?: resolution.destination, request.hostTab)) {
                        HomeNavigationResult.DISPATCHED -> true
                        HomeNavigationResult.DEFERRED -> return@dispatchOpen HomeRouteDispatchResult.DEFERRED
                        HomeNavigationResult.REFUSED -> false
                    }
                    is FeatureResolution.Action -> host.action(resolution.action)
                    is FeatureResolution.Scene -> host.scene(resolution.scene)
                    is FeatureResolution.WorldHandoff -> host.worldHandoff(resolution.island, resolution.then)
                    is FeatureResolution.HomeHandoff -> host.homeHandoff(resolution.destination)
                    is FeatureResolution.Locked, FeatureResolution.Hidden -> error("Resolution already handled")
                }
                if (accepted) HomeRouteDispatchResult.DISPATCHED else {
                    host.locked("This feature is not available in the current Home view.")
                    HomeRouteDispatchResult.REFUSED
                }
            }
        }
    }

    private fun context(): HomeRouteContext? = current()?.takeIf { it.gates.baseId == it.identity.baseId }

    private fun locked(reason: String): HomeRouteDispatchResult {
        host.locked(reason)
        return HomeRouteDispatchResult.LOCKED
    }
}

/** The bounded Leagues/Harvester/Lodge/Berth mount. Other owners keep their existing paths.
 * Each attachment is leased to one live session/base/generation; a stale disposer cannot retire a new mount. */
internal class HomeSheetRouteHost(
    private val current: () -> HomeRouteIdentity?,
    private val admissionBlocked: () -> Boolean,
    private val explain: (String) -> Unit,
    private val reviewBlocked: () -> Boolean = { false },
    private val presentationCurrent: () -> HomeRouteIdentity? = current,
    private val bodyReady: (Destination) -> Boolean = { true },
    private val bodyReviewBlocked: () -> Boolean = { false },
    private val featureRead: (FeatureId) -> HomeNavigationResult = { HomeNavigationResult.DISPATCHED },
    private val bodyUnavailable: (Destination) -> String? = { null },
    private val legacyFeature: (FeatureId) -> Boolean = { false },
    private val enqueued: (HomeRequest.Open) -> Unit = {},
) : HomeRouteHost {
    override fun openLegacyFeature(id: FeatureId): Boolean = legacyFeature(id)
    override fun didEnqueue(request: HomeRequest.Open) = enqueued(request)
    private class Attachment(
        val identity: HomeRouteIdentity,
        val openLeague: (Destination.Leagues) -> Unit,
        val closeSceneSheet: () -> Boolean,
        val sceneCovered: () -> Boolean,
        val owner: Any,
        val openBody: ((Destination) -> Unit)?,
        var blocked: Boolean = true,
    )
    private var attachment: Attachment? = null
    private val mutableBlocked = MutableStateFlow(true)
    override val dispatchBlocked: StateFlow<Boolean> = mutableBlocked.asStateFlow()

    class Mount internal constructor(private val report: (Boolean) -> Unit, private val retire: () -> Unit) {
        fun reportBlocked(blocked: Boolean) = report(blocked)
        fun close() = retire()
    }

    fun attach(identity: HomeRouteIdentity, openLeague: (Destination.Leagues) -> Unit,
        closeSceneSheet: () -> Boolean, owner: Any = Any(), sceneCovered: () -> Boolean = { false },
        openBody: ((Destination) -> Unit)? = null): Mount {
        val next = Attachment(identity, openLeague, closeSceneSheet, sceneCovered, owner, openBody)
        attachment = next
        mutableBlocked.value = true
        return Mount({ blocked ->
            if (attachment === next) {
                next.blocked = blocked
                mutableBlocked.value = blocked || current() != identity || admissionBlocked()
            }
        }, {
            if (attachment === next) {
                attachment = null
                mutableBlocked.value = true
            }
        })
    }

    /** Commit-phase publication from the currently painted mount; abandoned/retired owners cannot report. */
    fun reportBlocked(owner: Any, blocked: Boolean) {
        val mounted = attachment?.takeIf { it.owner === owner } ?: return
        mounted.blocked = blocked
        mutableBlocked.value = blocked || current() != mounted.identity || admissionBlocked()
    }

    /** Dismissal belongs to the retained presentation, even during transient strict model lag. */
    fun isOwner(owner: Any): Boolean = attachment?.let {
        it.owner === owner && presentationCurrent() == it.identity
    } == true

    fun isCurrent(owner: Any): Boolean = isOwner(owner) && attachment?.identity == current()

    /** X/Back/Half share this pop path. A stale lease cannot edit history or the new owner's selection.
     * Selection clearing must not dismiss a higher-priority review owned by Kingdom. */
    fun closeOwnedSheet(owner: Any, clearSelection: () -> Unit, pop: () -> Unit): Boolean {
        if (!isOwner(owner)) { explain("This sheet is waiting for the current kingdom."); return false }
        if (bodyReviewBlocked()) { explain("Finish the current review before closing this sheet."); return false }
        pop()
        if (!reviewBlocked()) clearSelection()
        return true
    }

    /** Read-only tabs/links keep their lease and review guard during ordinary loading or layout work. */
    fun canUseReadControl(owner: Any): Boolean = isCurrent(owner) && !reviewBlocked() && !bodyReviewBlocked()

    /** Leaving for an existing form retires the whole sheet, rather than consuming only its nested Back. */
    fun handoffOwnedSheet(owner: Any, clearSelection: () -> Unit, pop: () -> Unit, open: () -> Unit): Boolean {
        if (!canUseReadControl(owner) || admissionBlocked()) { explainReadRefusal(owner); return false }
        if (!closeOwnedSheet(owner, clearSelection, pop)) return false
        open()
        return true
    }

    fun explainReadRefusal(owner: Any) = explain(homeReadRefusalReason(
        reviewBlocked() || bodyReviewBlocked(), isCurrent(owner)))

    /** Already-mounted display links do not need to invent capability facts for another registry door. */
    fun openMountedLink(owner: Any, feature: String): Boolean {
        if (!canUseReadControl(owner) || admissionBlocked()) { explainReadRefusal(owner); return false }
        val destination = when (feature) {
            "berth.starter" -> Destination.Berth(section = "starter")
            "berth.fleet" -> Destination.Berth()
            "berth.service" -> Destination.Berth("SERVICE")
            "berth.vehicles" -> Destination.Berth(section = "vehicles")
            "lodge.starter" -> Destination.Lodge(mode = "starter")
            "lodge.expedition" -> Destination.Lodge()
            else -> { explain("This link is not available in the current sheet."); return false }
        }
        if (navigateResult(destination, HomeTab.KINGDOM) == HomeNavigationResult.DISPATCHED) return true
        explain("Details are waiting for their current owner. Try again when it is ready.")
        return false
    }

    // Menu must retain its standalone recovery doors when Home cannot admit a sheet.
    override fun canOpen(id: FeatureId, tab: HomeTab): Boolean =
        id.value in HOME_MOUNTED_FEATURES && tab == HomeTab.KINGDOM &&
            (id.value != "hud.profile" || (current() != null && !admissionBlocked())) &&
            (id.value != "hud.quests" || (current() != null && !admissionBlocked() && !dispatchBlocked.value))

    override fun prepareFeature(id: FeatureId): HomeNavigationResult = featureRead(id)

    /** Direct legacy callers get no effect on any blocked path; dispatch uses the full result below. */
    override fun navigate(destination: Destination, tab: HomeTab): Boolean =
        navigateResult(destination, tab) == HomeNavigationResult.DISPATCHED

    override fun navigateResult(destination: Destination, tab: HomeTab): HomeNavigationResult {
        if (tab != HomeTab.KINGDOM || mountedHomeSheetFrame(gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(destination)) == null)
            return HomeNavigationResult.REFUSED
        bodyUnavailable(destination)?.let { explain(it); return HomeNavigationResult.REFUSED }
        val mounted = attachment ?: return HomeNavigationResult.DEFERRED
        if (mounted.blocked || !isCurrent(mounted.owner) || admissionBlocked() || bodyReviewBlocked() || !bodyReady(destination))
            return HomeNavigationResult.DEFERRED
        if (destination is Destination.Leagues) mounted.openLeague(destination)
        else (mounted.openBody ?: return HomeNavigationResult.DEFERRED)(destination)
        return HomeNavigationResult.DISPATCHED
    }

    fun beforeSceneTap(): Boolean {
        val mounted = attachment ?: return false
        // An admission blocker is not a painted overlay. Uncovered taps belong to Kingdom,
        // including the layout editor and ground taps that clear stale selection.
        if (!mounted.sceneCovered()) return false
        if (!isOwner(mounted.owner) || reviewBlocked() || bodyReviewBlocked()) return true
        mounted.closeSceneSheet() // Only a visible Half closes; Full/exit coverage consumes without closing.
        return true
    }

    override fun action(action: FeatureAction): Boolean = false
    override fun scene(scene: FeatureScene): Boolean = false
    override fun worldHandoff(island: String, then: Destination?): Boolean = false
    override fun homeHandoff(destination: Destination.FocusBuilding): Boolean = false
    override fun locked(reason: String) = explain(reason)
}

internal val HOME_LEAGUE_TABS = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.leaguesTabs().map { it.id }.toSet()
// The designed MailHub's chips, ARCHIVE included (the old raw archive strip is retired).
internal val HOME_MAIL_FILTERS = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_HUB_FILTERS
internal val HOME_MOUNTED_FEATURES = setOf("hud.profile", "hud.quests", "hud.leagues", "hud.mail", "harvester.harvest", "lodge.expedition", "lodge.starter",
    "lodge.underway", "lodge.passport", "berth.fleet", "berth.starter", "berth.vehicles", "berth.service",
    "workshop.craft", "goldforge.open", "goldforge.smelt", "goldforge.claim", "goldforge.gems", "goldforge.legacy", "hud.event",
    "clan.open", "clan.charter", "clan.tournament")
internal fun homeMountedBuildingType(type: String?): Boolean = type in setOf("harvester", "lodge", "berth", "clanhall")
internal fun homeMountedWorkshopBuildingType(type: String?): Boolean = type == "workshop"
internal fun homeMountedMarketBuildingType(type: String?): Boolean = type == "market"
private fun homeClanTab(tab: String): String = if (tab == "TOURNAMENT") "TOURNEY" else tab

internal fun homeLodgeSheetUi(inputs: gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageLiveInputs,
    local: gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LodgeLocalState, passportAvailable: Boolean = false) =
    gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.lodgeSheetUi(inputs, local).copy(passportLocked = !passportAvailable)

/** A frame is supplied only for an actual body. Restoration cannot activate an unsupported descendant. */
internal fun mountedHomeSheetFrame(entry: gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry):
    gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi? {
    val destination = entry.destination
    val title: String
    val initialTab: String
    val tabs: Set<String>
    when (destination) {
        is Destination.Profile -> {
            if (destination.section != null) return null
            title = "PROFILE"; initialTab = destination.tab; tabs = setOf("PROFILE", "KINGDOMS", "WALLET", "ACCOUNT")
        }
        // A clanless player's ClanHub draws the finder (FIND · CREATE · INVITES); its tab taps must stay on this sheet.
        is Destination.Clan -> { title = "CLAN"; initialTab = homeClanTab(destination.tab); tabs = setOf("CLAN", "MEMBERS", "CHARTER", "TOURNEY", "FIND", "CREATE", "INVITES") }
        is Destination.Quests -> { title = "QUESTS"; initialTab = destination.tab; tabs = setOf("DAILY", "KINGDOM") }
        is Destination.GoldForge -> { title = "GOLD FORGE"; initialTab = destination.tab ?: "SMELT"; tabs = setOf("SMELT", "CLAIM", "GEMS", "LEGACY") }
        is Destination.Leagues -> { title = "LEAGUES"; initialTab = destination.tab; tabs = HOME_LEAGUE_TABS }
        Destination.Mail -> { title = "MAIL"; initialTab = "ALL"; tabs = HOME_MAIL_FILTERS }
        is Destination.Workshop -> { title = "WORKSHOP"; initialTab = destination.tab ?: "INGOTS"; tabs = setOf("REFINE", "INGOTS", "EQUIPMENT", "COSMETICS") }
        is Destination.Harvester -> { title = "HARVESTER"; initialTab = destination.tab; tabs = setOf("YIELD", "HISTORY") }
        is Destination.Lodge -> {
            if (destination.mode !in setOf(null, "starter")) return null
            title = "LODGE"; initialTab = destination.tab; tabs = setOf("SEND", "UNDER_WAY", "PASSPORT")
        }
        is Destination.Berth -> {
            if (destination.section !in setOf(null, "starter", "vehicles", "install")) return null
            title = "BERTH"; initialTab = destination.tab; tabs = setOf("FLEET", "SERVICE")
        }
        is Destination.Settings -> {
            if (destination.section != null) return null
            title = "SETTINGS"; initialTab = destination.tab; tabs = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.settingsTabs().map { it.id }.toSet()
        }
        Destination.Feedback -> { title = "FEEDBACK"; initialTab = "NEW"; tabs = gg.pixelkingdomwars.nativeclient.ui.community.FEEDBACK_TABS.toSet() }
        is Destination.WalletHistory -> {
            title = "HISTORY"; initialTab = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.historyFilterFor(destination.home)
            tabs = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HISTORY_FILTERS
        }
        is Destination.Event -> { title = "FOUNDING KINGDOMS"; initialTab = destination.tab; tabs = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.eventTabs().map { it.id }.toSet() }
        // The devnet SKR faucet half sheet (account faucet.png); its host closes itself on mainnet.
        Destination.SkrFaucet -> { title = "DAILY TEST SKR"; initialTab = "FAUCET"; tabs = setOf("FAUCET") }
        else -> return null
    }
    val tab = (entry.selectedTab ?: initialTab).let { if (destination is Destination.Clan) homeClanTab(it) else it }
    if (initialTab !in tabs || tab !in tabs) return null
    return gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi(title, null,
        if (destination is Destination.Profile || destination is Destination.Clan || destination is Destination.Quests || destination is Destination.Leagues || destination == Destination.Mail ||
            destination is Destination.Settings || destination == Destination.Feedback || destination is Destination.WalletHistory || destination is Destination.Event) gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.FULL
        else if (destination == Destination.SkrFaucet) gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.HALF
        else gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.TALL,
        if (destination is Destination.Leagues) gg.pixelkingdomwars.nativeclient.ui.sheets.hub.leaguesTabs() else emptyList(), tab)
}

internal fun mountedHomeSheetStack(stack: gg.pixelkingdomwars.nativeclient.ui.sheets.SheetStack) =
    gg.pixelkingdomwars.nativeclient.ui.sheets.SheetStack(stack.entries.takeWhile { mountedHomeSheetFrame(it) != null })

/** One bounded observation of the existing Workshop owner. No receipt/command API is exposed here. */
internal class HomeWorkshopReadCapture(val identity: HomeRouteIdentity) {
    var snapshot: WorkshopState? by mutableStateOf(null)
        private set
    var load: LoadState by mutableStateOf(LoadState.Loading)
        private set
    var running by mutableStateOf(false)
        private set

    fun observed(state: WorkshopState?, current: Boolean): Boolean =
        current && !running && load == LoadState.Ready && state != null && state === snapshot

    suspend fun refresh(current: () -> Boolean, state: () -> WorkshopState?, read: suspend () -> Unit): Boolean {
        if (running) return false
        snapshot = null
        val before = state()
        if (!current() || before == null || before.busy || before.review != null) {
            load = LoadState.Error("Workshop is waiting for the current owner. Open its controls or try again.")
            return false
        }
        running = true; load = LoadState.Loading
        try {
            read()
            val after = state()
            if (!current() || after == null || after.busy || after.review != null) {
                load = LoadState.Error("Workshop changed while loading. Try again from the current kingdom.")
                return false
            }
            snapshot = after; load = LoadState.Ready
            return true
        } catch (cancelled: CancellationException) {
            load = LoadState.Error("Workshop information is not current."); throw cancelled
        } catch (_: Exception) {
            load = LoadState.Error("Workshop information could not be refreshed. Try again or open its original controls.")
            return false
        } finally { running = false }
    }
}

/** Discovery admits only the current advertised owner; saved originals keep their separate legacy recovery path. */
internal fun homeWorkshopEconomyObserved(proof: HomeEconomyReadCapture<WorkshopState>?, state: WorkshopState?,
    current: Boolean): Boolean = state != null && proof?.observed(state, current) == true &&
    !state.busy && state.review == null && state.advertised

internal fun homeWorkshopObservation(state: WorkshopState?, expected: WorkshopIdentity?, baseId: String,
    current: Boolean, readComplete: Boolean): gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetUi? {
    if (!current || !readComplete || state == null || state.busy || state.review != null || expected == null ||
        state.journal.identity != expected || runCatching { expected.validate() }.isFailure) return null
    return workshopMoneySheetUi(state, expected, baseId, repositoryCurrent = true, viewCurrent = true,
        balanceCurrent = false, availableTabs = if (state.advertised) listOf("INGOTS") else emptyList(), selectedTab = "INGOTS")
}

/** C3 supplies identity/read/lease admission; M3 owns the display-only body. Legacy owns every reviewed action. */
@Composable internal fun HomeWorkshopSheet(
    graph: AppGraph, session: SessionGraph, repository: WorkshopRepository?, identity: HomeRouteIdentity,
    entry: SheetEntry, modifier: Modifier, onClose: () -> Unit, onLegacy: () -> Unit,
    canRead: () -> Boolean, explain: (String) -> Unit, onTab: (String) -> Unit,
) {
    val state = repository?.state?.collectAsState()?.value
    val capture = remember(repository, identity) { HomeWorkshopReadCapture(identity) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifecycleState by lifecycle.currentStateFlow.collectAsState()
    val current by rememberUpdatedState<() -> Boolean> {
        lifecycle.currentState == Lifecycle.State.RESUMED && homeOwnerProjectionIdentity(graph, session) == identity && canRead()
    }
    val requestedTab = entry.selectedTab ?: (entry.destination as? Destination.Workshop)?.tab ?: "INGOTS"
    val ordinary = remember(session) { runCatching { session.ordinaryCrafting }.getOrNull() }
    val ordinaryState = ordinary?.state?.collectAsState()?.value
    val ordinaryCapture = remember(ordinary, identity) {
        HomeEconomyReadCapture<gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState>(identity)
    }
    var ordinaryLoad by remember(identity) { mutableStateOf<LoadState>(LoadState.Loading) }
    var ordinaryRunning by remember(identity) { mutableStateOf(false) }
    var ordinaryOffset by remember(identity) { mutableStateOf<Long?>(null) }
    var recipe by remember(identity) { mutableStateOf<String?>(null) }
    var quantity by remember(identity) { mutableIntStateOf(1) }
    var retry by remember(identity) { mutableIntStateOf(0) }
    var ingotForegroundReadCompleted by remember(repository, identity) { mutableStateOf(false) }
    LaunchedEffect(ordinary, identity, lifecycle, retry, requestedTab) {
        if (requestedTab == "REFINE") lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            ordinaryLoad = LoadState.Loading; ordinaryOffset = null; ordinaryRunning = true
            try {
                ordinaryCapture.refresh({ current() }) {
                    val borrowed = requireNotNull(ordinary)
                    check(!borrowed.state.value.busy && borrowed.state.value.review == null)
                    borrowed.refresh(waitForIdle = true)
                    check(current() && !borrowed.state.value.busy && borrowed.state.value.review == null)
                    borrowed.state.value.also { value ->
                        ordinaryOffset = value.view?.serverNow?.let { java.time.Instant.parse(it).toEpochMilli() - System.currentTimeMillis() }
                    }
                }
                ordinaryLoad = if (current()) LoadState.Ready else LoadState.Error("Refining information is not current.")
            } catch (cancelled: CancellationException) {
                ordinaryCapture.clear(); throw cancelled
            } catch (_: Exception) {
                ordinaryCapture.clear(); ordinaryLoad = LoadState.Error("Refining information could not be refreshed.")
            } finally { ordinaryRunning = false }
            try { kotlinx.coroutines.awaitCancellation() }
            finally { ordinaryCapture.clear(); ordinaryOffset = null }
        }
    }
    LaunchedEffect(repository, identity, lifecycle, retry) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            ingotForegroundReadCompleted = false
            try {
                ingotForegroundReadCompleted = capture.refresh({ current() }, { repository?.state?.value }) {
                    requireNotNull(repository).refresh(waitForIdle = true)
                }
                kotlinx.coroutines.awaitCancellation()
            } finally { ingotForegroundReadCompleted = false }
        }
    }
    val expected = remember(graph, session) { runCatching {
        WorkshopIdentity(graph.origin.toHttpUrl().toString().trimEnd('/'), graph.cluster.id, session.session.wallet)
    }.getOrNull() }
    val admitted = lifecycleState == Lifecycle.State.RESUMED && ingotForegroundReadCompleted && capture.observed(state, current())
    val ingotObservation = homeWorkshopObservation(state, expected, identity.baseId, current(), admitted)
    val ordinaryIdentity = remember(graph, session) { runCatching {
        gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingIdentity(
            graph.origin.toHttpUrl().toString().trimEnd('/'), graph.cluster.id, session.session.wallet)
    }.getOrNull() }
    val ordinaryAdmitted = lifecycleState == Lifecycle.State.RESUMED && ordinaryLoad == LoadState.Ready &&
        !ordinaryRunning && ordinaryCapture.observed(ordinaryState, current()) && ordinaryState?.journal?.identity == ordinaryIdentity
    val capacity = runCatching { session.boundCosmeticArt.maxConcurrentPerBase() }.getOrNull()
    val refine = gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopRefineTabUi(
        ordinaryState, ordinaryIdentity, identity.baseId, repositoryCurrent = current(), viewCurrent = ordinaryAdmitted,
        benchCapacity = capacity, quantity = quantity, selectedRecipeId = recipe, serverOffsetMs = ordinaryOffset)
    val observation = (ingotObservation ?: gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetUi(
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftFrameUi("WORKSHOP", null, null, false,
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopTabs(), requestedTab),
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi(null))).let { combined ->
        combined.copy(refine = refine, frame = combined.frame.copy(
            tabs = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopTabs(), selectedTab = requestedTab,
            titleTag = combined.frame.titleTag.takeIf { requestedTab == "INGOTS" },
            live = combined.frame.live.takeIf { requestedTab == "INGOTS" }),
            header = combined.header.takeIf { requestedTab == "INGOTS" }
                ?: gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi(null))
    }
    val status = when {
        requestedTab == "REFINE" && ordinaryLoad is LoadState.Error -> HomeWorkshopReadStatus.FAILED
        requestedTab == "REFINE" && (ordinaryRunning || ordinaryLoad == LoadState.Loading) -> HomeWorkshopReadStatus.LOADING
        requestedTab != "INGOTS" -> HomeWorkshopReadStatus.READY
        !current() -> HomeWorkshopReadStatus.READY
        capture.load is LoadState.Error -> HomeWorkshopReadStatus.FAILED
        capture.running || capture.load == LoadState.Loading -> HomeWorkshopReadStatus.LOADING
        else -> HomeWorkshopReadStatus.READY
    }
    val callbacksAllowed = { current() && !capture.running && !ordinaryRunning &&
        repository?.state?.value?.busy != true && repository?.state?.value?.review == null &&
        ordinary?.state?.value?.busy != true && ordinary?.state?.value?.review == null }
    HomeWorkshopBody(observation, status,
        if (requestedTab == "INGOTS") admitted else if (requestedTab == "REFINE") ordinaryAdmitted else current(), requestedTab,
        onRetry = { if (callbacksAllowed()) retry++ else explain("Finish the current read or review before trying again.") },
        onLegacy = { if (callbacksAllowed()) onLegacy() else explain("Finish the current read or review before opening Workshop controls.") },
        onClose = onClose, onTab = { tab -> if (current()) onTab(tab) }, modifier = modifier,
        originalRequestPending = requestedTab == "REFINE" && ordinaryAdmitted && ordinaryState?.journal?.operation != null,
        onRefineSelect = { id -> if (current() && refine?.recipes?.any { it.recipeId == id } == true) { recipe = id; quantity = 1 } },
        onRefineQty = { delta -> if (current() && refine != null) {
            quantity = (quantity.toLong() + delta).coerceIn(1L, refine.maxBatch.coerceAtLeast(1).toLong()).toInt()
        } })
}

/** Captured list observations only. The existing Home queue/repository owns serialization and receipts. */
internal class HomeMailReadCapture(val identity: HomeRouteIdentity) {
    var snapshot: CommunityState? by mutableStateOf(null)
        private set
    var load: LoadState by mutableStateOf(LoadState.Loading)
        private set
    var running by mutableStateOf(false)
        private set

    private suspend fun read(reads: HomeCommunityReads, current: () -> Boolean,
        operation: suspend (gg.pixelkingdomwars.nativeclient.data.CommunityRepository) -> Boolean): Boolean {
        if (running) return false
        if (!current()) { load = LoadState.Error("Mail is waiting for the current kingdom. Try again."); return false }
        running = true; load = LoadState.Loading
        try {
            var observed = false
            reads.read { repository -> if (current()) observed = operation(repository) }
            load = if (observed) LoadState.Ready else LoadState.Error("Mail could not be read for the current view. Try again.")
            return observed
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) {
            load = LoadState.Error("Mail could not be refreshed. Previously loaded letters are retained; try again.")
            return false
        } finally { running = false }
    }

    private fun observe(state: CommunityState, current: () -> Boolean): Boolean {
        if (!current() || state.archived || state.mailbox == null) return false
        snapshot = state
        return true
    }

    suspend fun refresh(reads: HomeCommunityReads, current: () -> Boolean): Boolean = read(reads, current) {
        it.refreshMail(false)
        observe(it.state.value, current)
    }

    suspend fun more(reads: HomeCommunityReads, current: () -> Boolean): Boolean = read(reads, current) { repository ->
        val page = snapshot?.mailbox
        if (page?.nextCursor == null) return@read page != null
        val shared = repository.state.value
        // Another existing owner may have replaced the chain while this request waited in the shared queue.
        if (shared.archived || shared.mailbox != page) repository.refreshMail(false) else repository.moreMail()
        observe(repository.state.value, current)
    }

    suspend fun open(reads: HomeCommunityReads, id: String, current: () -> Boolean, handoff: () -> Unit): Boolean {
        if (snapshot?.mailbox?.messages?.none { it.id == id } != false) return false
        return read(reads, current) { repository ->
            repository.openMail(id) // GET only; mark-read/archive/claim stay in CommunityScreen.
            if (current() && repository.state.value.detail?.id == id) { handoff(); true } else false
        }
    }
}

/** The repository stays session-owned. START borrows its exact reviewed callbacks in place; archival and the
 * full original-receipt controls retain their existing route. No ViewModel or command owner is created here. */
@Composable internal fun HomeHarvesterSheet(
    graph: AppGraph, session: SessionGraph, identity: HomeRouteIdentity, entry: SheetEntry, owners: HomeOwnerProjections,
    kingdom: KingdomUiState, modifier: Modifier, onTab: (String) -> Unit, onClose: () -> Unit, onLegacy: () -> Unit,
    canRead: () -> Boolean, explain: (String) -> Unit,
    reviewController: HomeHarvesterReviewController? = null,
) {
    val owner = owners.harvester
    val observed = owner?.projection?.state?.collectAsState()?.value
    val state = observed?.takeIf { owner?.projection?.currentState() != null }
    if (owner == null || state == null) {
        Column(modifier) { Text("Harvester recovery is unavailable. Saved receipts are preserved.")
            TextButton(onClick = { if (canRead()) onLegacy() }, enabled = canRead()) { Text("Original requests") }; TextButton(onClick = onClose) { Text("Close") } }
        return
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var retry by remember(identity) { mutableIntStateOf(0) }
    var refreshError by remember(identity) { mutableStateOf<String?>(null) }
    var refreshing by remember(identity) { mutableStateOf(false) }
    val currentCanRead by rememberUpdatedState(canRead)
    LaunchedEffect(owner, identity, lifecycle, retry, reviewController?.refreshRevision) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            // Returning from the in-place confirmation has the same one current read as reopening the original
            // screen. Wait for its own painted review/Back lease to retire; no source selection is retried here.
            if ((reviewController?.refreshRevision ?: 0) > 0) {
                snapshotFlow { currentCanRead() && reviewController?.holding != true }.first { it }
            }
            if (currentCanRead()) {
                refreshing = true; refreshError = null
                try {
                    if (!owner.refresh.invoke(Unit)) refreshError = homeReadRefusalReason(
                        owner.projection.reviewBlocked && owner.projection.currentState() != null, owner.projection.currentState() != null)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { refreshError = "Harvester could not be refreshed. Saved receipts are preserved; try again." }
                finally { refreshing = false }
            }
            kotlinx.coroutines.awaitCancellation()
        }
    }
    val context = LocalContext.current.applicationContext
    val seen = remember(session.session) {
        // Public account identity scopes this notification marker; no credential or journal is stored here.
        val accountKey = java.security.MessageDigest.getInstance("SHA-256")
            .digest("${session.session.origin}\n${session.session.wallet}".toByteArray()).joinToString("") { "%02x".format(it) }
        val preferences = context.getSharedPreferences(storageNamespace(session.session.origin, "harvester-seen-$accountKey"), android.content.Context.MODE_PRIVATE)
        HomeHarvesterSeen({ source -> preferences.getString(source, null) },
            { source, sequence -> preferences.edit().putString(source, sequence).apply() })
    }
    val view = state.view?.takeIf { it.wallet == session.session.wallet && it.baseId == identity.baseId }
    val sourceId = view?.source?.sourceId
    val latest = sourceId?.let { harvesterLatestSequence(state.journal, it) }
    var marker by remember(identity, sourceId) { mutableStateOf<String?>(null) }
    SideEffect { if (sourceId != null && canRead()) marker = seen.observe(sourceId, latest) }
    val now = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.rememberNow(clock = { System.currentTimeMillis() })
    val selected = kingdom.selectedBuilding?.takeIf { it.type == "harvester" }
        ?: kingdom.base?.buildings?.singleOrNull { it.type == "harvester" }
    val facts = selected?.takeIf { kingdom.base?.baseId == identity.baseId }?.let {
        gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readBuildingFacts(kingdom, it, state.busy, now)
    }
    val destination = entry.destination as Destination.Harvester
    val projectionCurrent = currentCanRead() && owner.projection.currentState() === state
    val historyIdentity = remember(graph, session) {
        gg.pixelkingdomwars.nativeclient.harvester.HarvesterIdentity(
            graph.origin.toHttpUrl().toString().trimEnd('/'), graph.cluster.id, session.session.wallet)
    }
    val history = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterHistoryLiveUi(
        state, historyIdentity, identity.baseId, facts?.buildingId, projectionCurrent, refreshing, refreshError)
    // Anchor the server clock once per observation so countdowns advance between reads. Receipt quantities and
    // delivery still require server proof; elapsed device time never creates a haul.
    val serverOffset = remember(view?.serverNow) {
        view?.let {
            runCatching { Math.subtractExact(java.time.Instant.parse(it.serverNow).toEpochMilli(), System.currentTimeMillis()) }.getOrNull()
        } ?: 0L
    }
    val canCheckNow = {
        val latestState = owner.projection.currentState()
        currentCanRead() && owner.projection.canRead() && !refreshing &&
            latestState != null && !latestState.busy && latestState.review == null
    }
    val ui = harvesterLiveUi(entry.selectedTab ?: destination.tab, state, session.session.wallet, identity.baseId,
        facts, artKey = null, tier = null, seenThroughSequence = marker, actionsAllowed = kingdom.ordersAllowed && kingdom.deedActionsAllowed,
        running = refreshing, error = refreshError, nowMs = now, serverOffsetMs = serverOffset).copy(review = null)
    val scope = rememberCoroutineScope()
    val checked: (() -> Unit) -> Unit = { action -> if (currentCanRead() && owner.projection.currentState() != null) action() }
    val openReview: (String?) -> Unit = { target ->
        if (canCheckNow()) scope.launch {
            try {
                if (reviewController?.open(target) != true) explain("This Harvester cannot be reviewed now. Check its saved request or refresh the current kingdom.")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { explain(error.message ?: "The Harvester review could not be opened. Its saved request is preserved.") }
        }
        else explain(homeReadRefusalReason(owner.projection.reviewBlocked, owner.projection.currentState() != null))
    }
    val actions = harvesterLiveActions(onClose, onTab, reviewStart = { openReview(facts?.buildingId) },
        markSeen = {
            checked {
                // Read the latest owner emission at click time; never acknowledge a replaced source/account.
                val current = owner.projection.currentState()
                val source = current?.view?.takeIf { it.wallet == session.session.wallet && it.baseId == identity.baseId }?.source?.sourceId
                if (current != null && source != null) marker = seen.acknowledge(source, harvesterLatestSequence(current.journal, source))
            }
        }, openUpgrade = { checked { explain("Select the Harvester building and open UPGRADE.") } },
        openWorkshop = { checked { explain("Open the Workshop to refine this resource.") } },
        openMarketSell = { checked { explain("Open the Market to sell this resource.") } },
        refresh = { if (canCheckNow()) retry++
            else explain(homeReadRefusalReason(owner.projection.reviewBlocked, owner.projection.currentState() != null)) }, needMore = { price -> checked { explain(price.description ?: "More resources are needed.") } },
        checkReceipt = { checked { scope.launch {
            try { if (!owner.check.invoke(Unit)) explain("Finish the current review before checking its receipt.") }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The original receipt could not be checked. Try again.") }
        }; Unit } },
        dismissReview = { reviewController?.cancel() },
        confirmReview = { /* The complete, exact owner review is confirmed only by its dedicated overlay. */ })
    Column(modifier) {
        state.journal.operation?.takeIf { it.proof == null && it.refusal == null && it.command.request.baseId == identity.baseId }?.let { saved ->
            TextButton(onClick = { openReview(saved.command.request.harvesterId) }, enabled = canCheckNow() && reviewController != null) {
                Text("REVIEW SAVED REQUEST")
            }
        }
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSheetR2(
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSheetR2Ui(ui, historyTab = history),
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSheetR2Actions(sheet = actions,
            history = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterHistoryTabActions(
                onCheck = { if (canCheckNow()) retry++
                    else explain(homeReadRefusalReason(owner.projection.reviewBlocked, owner.projection.currentState() != null)) },
                onTab = onTab,
                onOpenOriginal = if (projectionCurrent && canCheckNow()) ({ if (canCheckNow()) onLegacy() }) else null)), Modifier.weight(1f))
    }
}

/** Local presentation only; replacement bodies retire their own nested-Back lease. */
internal class HomeBodyBack {
    private var token: Any? = null
    private var handler: (() -> Boolean)? = null
    fun attach(lease: Any, onBack: () -> Boolean) { token = lease; handler = onBack }
    fun detach(lease: Any) { if (token === lease) { token = null; handler = null } }
    fun consume(): Boolean = handler?.invoke() == true
}

@Composable internal fun HomeBodyBackRegistration(back: HomeBodyBack, onBack: () -> Boolean) {
    val token = remember { Any() }
    val current by rememberUpdatedState(onBack)
    DisposableEffect(back, token) {
        back.attach(token) { current() }
        onDispose { back.detach(token) }
    }
}

internal fun homeLodgeLocal(destination: Destination.Lodge, starterInstallation: String?): LodgeLocalState =
    if (destination.mode == "starter") LodgeLocalState(tab = destination.tab, starterRouteId = destination.routeId,
        installationId = starterInstallation)
    else LodgeLocalState(tab = destination.tab, routeId = destination.routeId)

internal fun homeLodgeBack(local: LodgeLocalState): LodgeLocalState? = when {
    local.pickerOpen -> local.copy(pickerOpen = false)
    local.expandedTripId != null -> local.copy(expandedTripId = null)
    else -> null
}

internal fun homeBerthBack(local: BerthLocalState): BerthLocalState? =
    if (local.section != null) local.copy(section = null, installAssetId = null) else null

/** Presentation origin only; the owner retains admission, restoration validation and all live actions. */
internal fun homeVoyageVehicleOpen(destination: Destination, historyOnly: Boolean,
    open: (VehicleEntryPoint, Boolean) -> Unit) {
    val entry = when (destination) {
        is Destination.Lodge -> VehicleEntryPoint.LODGE
        is Destination.Berth -> VehicleEntryPoint.BERTH
        else -> return
    }
    open(entry, historyOnly)
}

/** Missing content is known before a read starts; a held service is an explicit repository observation. */
internal fun homeVoyageUnavailable(vehicles: VehicleState?, policyAvailable: Boolean): VehicleUnavailable? =
    if (!policyAvailable) VehicleUnavailable.MISSING_POLICY else vehicles?.unavailable

/** A missing/held service has no useful Retry; retryable failures use existing copy, never exception diagnostics. */
internal fun homeVoyageReadError(unavailable: VehicleUnavailable?, refreshError: String?, vehicleError: String?): String? =
    if (unavailable == null && (refreshError != null || vehicleError != null)) VEHICLE_READ_FAILED else null

internal fun homeVoyageVehicleControls(unavailable: VehicleUnavailable?, open: () -> Unit, explain: (String) -> Unit) {
    val reason = vehicleUnavailableReason(unavailable)
    if (reason != null) explain(reason) else open()
}

/** Borrowed voyage views. The existing StarterFleet owner supplies its free review; crafted money stays unavailable.
 * Ordinary starter departure remains admitted solely by its existing visible driver. */
@Composable internal fun HomeVoyageSheet(
    graph: AppGraph, session: SessionGraph, identity: HomeRouteIdentity, entry: SheetEntry, owners: HomeOwnerProjections,
    modifier: Modifier, onTab: (String) -> Unit, onClose: () -> Unit, onLegacy: () -> Unit, openVehicles: (VehicleEntryPoint?, Boolean) -> Unit,
    openFeature: (String) -> Unit,
    /** The craft-vehicle GO: the globe on Solana Island's Public Workshop sheet (`WorldEntry.SolanaIsland`), after this sheet. */
    openSolanaIsland: () -> Unit,
    canRead: () -> Boolean, explain: (String) -> Unit, nestedBack: HomeBodyBack,
    starterReview: HomeStarterFleetReviewController? = null,
    voyageOverlays: HomeVoyageOverlays, voyageCanAct: () -> Boolean,
    onStack: (List<gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi>?) -> Unit = {}, onBuildBerth: (() -> Unit)? = null,
    berthPlacement: HomeBerthPlacementDoor? = null,
) {
    val vehicleHistory = { homeVoyageVehicleOpen(entry.destination, true, openVehicles) }
    val base by session.base.state.collectAsState()
    val content by graph.content.state.collectAsState()
    val raid by session.interlock.state.collectAsState()
    val starterOwner = owners.starter
    val vehicleOwner = owners.vehicle
    val passportOwner = LocalHomePassportOwner.current
    val starterEmission = starterOwner?.projection?.state?.collectAsState()?.value
    val fleetEmission = owners.starterFleet?.projection?.state?.collectAsState()?.value
    val vehicleEmission = owners.vehicle?.projection?.state?.collectAsState()?.value
    val starter = starterEmission?.takeIf { owners.starter?.projection?.currentState() != null }
    val starterFleet = fleetEmission?.takeIf { owners.starterFleet?.projection?.currentState() != null }
    val vehicles = vehicleEmission?.takeIf { owners.vehicle?.projection?.currentState() != null }
    val policy = voyagePolicyFacts(vehicleOwner?.policy?.invoke())
    val unavailable = homeVoyageUnavailable(vehicles, policy.tiers != null)
    val vehicleControls = { homeVoyageVehicleControls(unavailable,
        { homeVoyageVehicleOpen(entry.destination, false, openVehicles) }, explain) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val currentCanRead by rememberUpdatedState(canRead)
    var refresh by remember(identity) { mutableIntStateOf(0) }
    var refreshError by remember(identity) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(owners, identity, lifecycle, refresh) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            if (currentCanRead()) {
                refreshError = null
                try {
                    val fleetRead = owners.starterFleet?.refresh?.invoke(Unit) == true
                    if (currentCanRead()) {
                        // Join the actual owner's read job before requesting its fleet; no parallel driver is started.
                        if (vehicleOwner?.refresh?.invoke(Unit) == true && currentCanRead())
                            vehicleOwner.fleet.invoke(identity.baseId)
                    }
                    if (!fleetRead) refreshError = "Fleet details are waiting for the current owner. Retry when its review closes."
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { refreshError = "Fleet details could not be refreshed. Original receipts remain available." }
            }
            kotlinx.coroutines.awaitCancellation()
        }
    }
    val now = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.rememberNow(clock = { System.currentTimeMillis() })
    // Voyage gap audit: the owners drop their view while they re-read (every open does); the sheet keeps the last one.
    val shown = retainVoyage(remember(identity) { VoyageSnapshotMemory(identity.baseId) }, starter, starterFleet, vehicles)
    HomeStarterDueRefresh(starterOwner, shown.starter?.view?.takeIf { it.baseId == identity.baseId }?.flight, now)
    val input = VoyageLiveInputs(base.base?.takeIf { it.baseId == identity.baseId }?.buildings, identity.baseId,
        shown.starter, shown.starterFleet, shown.vehicles, policy,
        ordersBlockedReason = if (!content.allowsGameOrders(graph.versionCode) || !raid.actionsAllowed) "Game orders are paused." else null,
        // This is only the existing owner's read-only fact; no signing capability leaves its form.
        walletLinked = owners.vehicle?.walletLinked?.invoke() == true, nowMs = now)
    val check: () -> Unit = {
        if (canRead()) scope.launch {
            try {
                if (unavailable == null) vehicleOwner?.check?.invoke(Unit)
                if (currentCanRead()) owners.starterFleet?.check?.invoke(Unit)
                if (currentCanRead() && starter?.journal?.operation != null && starterOwner?.check?.invoke(Unit) != true)
                    explain("Open Expedition controls to check the ordinary starter receipt.")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The original fleet receipt could not be checked. Try again.") }
        }
        Unit
    }
    // Island art for the route cards, picker tiles and header cutouts (voyage S5). The lease is refcounted per waiting
    // tile, so the Berth tab, which draws no island art, holds nothing.
    CompositionLocalProvider(gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LocalVoyageArt provides
        rememberHomeVoyageArt(graph, session) { vehicleOwner?.policy?.invoke()?.ordinaryRoutes }) {
    Column(modifier) {
        when (entry.destination) {
            is Destination.Lodge -> HomeLodgeLiveSheet(graph, session, identity, entry, input, owners, voyageOverlays,
                Modifier.weight(1f), onTab, onClose, vehicleHistory, openFeature, canRead, voyageCanAct, explain,
                nestedBack, checkPending = check, retry = {
                    if (canRead()) {
                        if (starterOwner?.projection?.canRead() == true) starterOwner.refresh.invoke(Unit)
                        refresh++
                    }
                }, readError = homeVoyageReadError(unavailable, refreshError, vehicles?.error),
                openSolanaIsland = openSolanaIsland, onBuildBerth = onBuildBerth, onStack = onStack)
            // The designed Berth body (berth-starter / fleet / install / service). Its HISTORY prefers the saved starter
            // outcome, then the receipt handoff; crafted install and service hand off to the existing Vehicle controls.
            is Destination.Berth -> HomeBerthLiveSheet(identity, entry, input, owners, Modifier.weight(1f), onTab, onClose, onLegacy,
                vehicleHistory, openVehicles, openFeature, canRead, explain, nestedBack, starterReview, checkPending = check,
                retry = { if (canRead()) refresh++ }, readError = homeVoyageReadError(unavailable, refreshError, vehicles?.error),
                unavailable = unavailable, berthPlacement = berthPlacement, openSolanaIsland = openSolanaIsland)
            else -> Unit
        }
    }
    }
}
