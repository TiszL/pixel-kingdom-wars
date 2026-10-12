package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import kotlinx.coroutines.CancellationException
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.data.HarvesterRepository
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.data.StarterFleetState
import gg.pixelkingdomwars.nativeclient.data.StarterFleetRepository
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.first

/** A borrowed state flow and existing owner admission. This creates no model, store, job or lifetime.
 * The caller still owns disposal and the host still owns its matching presentation/review lease.
 * In particular, read admission is not permission to close a sheet or submit a command. */
class HomeOwnerProjection<S>(
    val state: StateFlow<S>,
    val identity: HomeRouteIdentity,
    private val current: () -> HomeRouteIdentity?,
    private val admitted: () -> Boolean,
    private val ownerReviewBlocked: () -> Boolean,
) {
    private fun isCurrent(): Boolean = current() == identity
    fun currentState(): S? = state.value.takeIf { isCurrent() }
    /** Owner report 2026-10-11 (Seeker, code 34): a projection whose identity is no longer current is not mine. It cannot read
     * or expose state ([currentState], [canRead]), and it no longer counts as a review: counting it held Home's body-review gate,
     * and so every HUD door and sheet close, shut with nothing on screen until the projection happened to be replaced. */
    val reviewBlocked: Boolean get() = isCurrent() && ownerReviewBlocked()
    fun canRead(): Boolean = isCurrent() && admitted() && !ownerReviewBlocked()

    /** Export only reads already implemented by the owner. No command callback belongs here. */
    fun <A> readAction(read: (A) -> Unit): HomeOwnerReadAction<A> =
        HomeOwnerReadAction(::canRead, read)

    fun <A> suspendReadAction(awaitOwnerIdle: suspend () -> Unit, read: suspend (A) -> Unit): HomeOwnerSuspendReadAction<A> =
        HomeOwnerSuspendReadAction(::canRead, awaitOwnerIdle, read)
}

class HomeOwnerReadAction<A> internal constructor(
    private val admitted: () -> Boolean,
    private val read: (A) -> Unit,
) {
    /** false means defer; the owner receives neither a read nor a synthetic success. */
    fun invoke(argument: A): Boolean {
        if (!admitted()) return false
        read(argument)
        return true
    }
}

/** Borrows the owner's existing serialization; no queue, coroutine scope or background driver. */
class HomeOwnerSuspendReadAction<A> internal constructor(
    private val admitted: () -> Boolean,
    private val awaitOwnerIdle: suspend () -> Unit,
    private val read: suspend (A) -> Unit,
) {
    suspend fun invoke(argument: A): Boolean {
        if (!admitted()) return false
        awaitOwnerIdle()
        if (!admitted()) return false
        read(argument)
        return true
    }
}

/** Re-read the actual holder/graph at callback time; wallet equality cannot revive an old owner. */
fun homeOwnerProjectionIdentity(graph: AppGraph, session: SessionGraph): HomeRouteIdentity? {
    if (graph.sessionGraph.value !== session || graph.holder.current !== session.session) return null
    val account = graph.account.state.value
    val base = account.selectedBaseId?.takeIf { it.isNotBlank() } ?: return null
    if (account.baseSelectionGeneration < 0) return null
    return HomeRouteIdentity(session.session, base, account.baseSelectionGeneration)
}

fun <S> projectHomeOwner(
    graph: AppGraph,
    session: SessionGraph,
    state: StateFlow<S>,
    admitted: () -> Boolean,
    reviewBlocked: () -> Boolean,
): HomeOwnerProjection<S>? = homeOwnerProjectionIdentity(graph, session)?.let { identity ->
    HomeOwnerProjection(state, identity, { homeOwnerProjectionIdentity(graph, session) }, admitted, reviewBlocked)
}

/** Stable publication for an unchanged owner; a changed base generation captures a fresh projection.
 * Existing producer effects and lifetime keys are deliberately untouched. */
@Composable fun <T> rememberHomeProjection(scope: Any?, model: Any?, identity: HomeRouteIdentity?, create: () -> T): T =
    remember(scope, model, identity) { create() }

fun homeVehicleReadAdmitted(started: Boolean, active: Boolean, visible: Boolean, busy: Boolean): Boolean =
    started && active && visible && !busy

data class HomeVehicleOwner(
    val projection: HomeOwnerProjection<VehicleState>,
    val policy: () -> VehiclePolicy?,
    val refresh: HomeOwnerSuspendReadAction<Unit>,
    val fleet: HomeOwnerSuspendReadAction<String>,
    val assets: HomeOwnerSuspendReadAction<String?>,
    val check: HomeOwnerSuspendReadAction<Unit>,
    val walletLinked: () -> Boolean = { false },
    val voyage: HomeVehicleCommands? = null,
)

/** The same ordinary owner remains the only driver while its retained form is visible. */
data class HomeStarterOwner(
    val projection: HomeOwnerProjection<StarterExpeditionState>,
    val refresh: HomeOwnerReadAction<Unit>,
    val check: HomeOwnerReadAction<Unit>,
    val voyage: HomeStarterCommands? = null,
)

data class HomeHarvesterOwner(
    val projection: HomeOwnerProjection<HarvesterState>,
    val refresh: HomeOwnerSuspendReadAction<Unit>,
    val check: HomeOwnerSuspendReadAction<Unit>,
)

data class HomeStarterFleetOwner(
    val projection: HomeOwnerProjection<StarterFleetState>,
    val refresh: HomeOwnerSuspendReadAction<Unit>,
    val check: HomeOwnerSuspendReadAction<Unit>,
)

/** The caller supplies the actual session-owned repository; this never constructs another owner. */
fun projectHomeHarvester(graph: AppGraph, session: SessionGraph, repository: HarvesterRepository,
    admitted: () -> Boolean): HomeHarvesterOwner? =
    projectHomeOwner(graph, session, repository.state, admitted, { repository.state.value.review != null })?.let { p ->
        HomeHarvesterOwner(p,
            p.suspendReadAction(repository::awaitIdle) { _: Unit ->
                val archives = repository.state.value.journal.archives
                    .filter { it.operation.proof != null && it.operation.proof?.settlement?.closure == null }
                    .map { it.operation.command.key }
                check(refreshHomeHarvester(archives, p::canRead, repository::checkArchived) { repository.refresh(waitForIdle = true) }) {
                    "Harvester read admission changed; refresh again from the current owner."
                }
            },
            p.suspendReadAction(repository::awaitIdle) { _: Unit -> repository.check() })
    }

fun projectHomeStarterFleet(graph: AppGraph, session: SessionGraph, repository: StarterFleetRepository,
    admitted: () -> Boolean): HomeStarterFleetOwner? =
    projectHomeOwner(graph, session, repository.state, admitted, { repository.state.value.review != null })?.let { p ->
        HomeStarterFleetOwner(p,
            p.suspendReadAction(repository::awaitIdle) { _: Unit -> repository.refresh(waitForIdle = true) },
            p.suspendReadAction(repository::awaitIdle) { _: Unit -> repository.check() })
    }

/** Optional read projections, never fabricated capability or action admission. */
data class HomeOwnerProjections(
    val vehicle: HomeVehicleOwner? = null,
    val starter: HomeStarterOwner? = null,
    val starterFleet: HomeStarterFleetOwner? = null,
    val harvester: HomeHarvesterOwner? = null,
)

/** Missing owners remain null. No empty journal or configured policy is manufactured by a host. */
val LocalHomeOwnerProjections = staticCompositionLocalOf { HomeOwnerProjections() }

/** Same archived-original ordering as HarvesterViewModel.refresh; recheck before every borrowed read. */
internal suspend fun refreshHomeHarvester(archives: List<String>, admitted: () -> Boolean,
    checkArchived: suspend (String) -> Unit, refresh: suspend () -> Unit): Boolean {
    for (key in archives) {
        if (!admitted()) return false
        checkArchived(key)
    }
    if (!admitted()) return false
    refresh()
    return true
}

/** Client-only acknowledgement. Storage is supplied by the Home account scope, never by a command owner.
 * Unknown observations stay unknown; first observation is seeded and explicit acknowledgement is monotonic. */
internal class HomeHarvesterSeen(
    private val read: (String) -> String? = { null },
    private val write: (String, String) -> Unit = { _, _ -> },
) {
    private val values = mutableMapOf<String, String>()
    private fun valid(value: String?): String? = value?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }
    private fun current(source: String): String? = values[source] ?: valid(read(source))?.also { values[source] = it }
    fun observe(source: String, latest: String?): String? = current(source) ?: valid(latest)?.also { save(source, it) }
    fun acknowledge(source: String, latest: String?): String? {
        val old = current(source); val next = valid(latest) ?: return old
        return if (old == null || next.toBigInteger() > old.toBigInteger()) next.also { save(source, it) } else old
    }
    private fun save(source: String, value: String) { values[source] = value; write(source, value) }
}

internal enum class HomeFeatureReadStatus { WAITING, READING, READY, FAILED }

/** A current Economy discovery result is a reference-bound observation, never an owner or capability default. */
internal class HomeEconomyReadCapture<S>(val identity: HomeRouteIdentity) {
    private var snapshot: S? by mutableStateOf(null)
    fun clear() { snapshot = null }
    fun observed(state: S?, current: Boolean): Boolean = current && state != null && state === snapshot
    suspend fun refresh(current: () -> Boolean, read: suspend () -> S) {
        clear()
        if (!current()) return
        val result = read()
        if (current()) snapshot = result
    }
}

/** Proof for a bounded host-requested GET, not an owner or background driver. */
internal class HomeFeatureReadCapture(val identity: HomeRouteIdentity) {
    private var attempt = 0L
    private var request: HomeRequest.Open? = null
    private var warmReadClaimed = false
    var status by mutableStateOf(HomeFeatureReadStatus.WAITING)
        private set
    /** Equal payloads on different taps are distinct attempts. A prior failure never refuses a new tap. */
    fun statusFor(value: HomeRequest.Open?): HomeFeatureReadStatus =
        if (value != null && request === value) status else HomeFeatureReadStatus.WAITING

    /** Called after admission, without suspension before refresh. An explicit request always owns its proof. */
    fun claimWarmRead(requestPending: Boolean): Boolean {
        if (requestPending || request != null) return false
        // The caller waits for cancellation after one attempt; FAILED can retry only on a new admitted resume.
        if (status == HomeFeatureReadStatus.FAILED) {
            warmReadClaimed = false
            status = HomeFeatureReadStatus.WAITING
        }
        if (warmReadClaimed || status != HomeFeatureReadStatus.WAITING) return false
        warmReadClaimed = true
        return true
    }

    suspend fun refreshFor(value: HomeRequest.Open, read: suspend () -> Boolean, current: () -> Boolean) {
        if (value.identity != identity || !current()) return
        if (request !== value) { request = value; attempt++; status = HomeFeatureReadStatus.WAITING }
        refresh(read) { request === value && current() }
    }
    suspend fun refresh(read: suspend () -> Boolean, current: () -> Boolean) {
        if (!current()) return
        val capturedAttempt = ++attempt
        status = HomeFeatureReadStatus.READING
        try {
            val accepted = read()
            if (capturedAttempt == attempt) status = when {
                !current() -> HomeFeatureReadStatus.WAITING
                accepted -> HomeFeatureReadStatus.READY
                else -> HomeFeatureReadStatus.FAILED // Retire this attempt; a fresh request can retry admission.
            }
        } catch (cancelled: CancellationException) {
            if (capturedAttempt == attempt) {
                status = HomeFeatureReadStatus.WAITING
                // A lifecycle-cancelled warm chain may finish on a later resume; a bound request still owns its proof.
                if (request == null) warmReadClaimed = false
            }
            throw cancelled
        } catch (_: Exception) {
            if (capturedAttempt == attempt) status = if (current()) HomeFeatureReadStatus.FAILED else HomeFeatureReadStatus.WAITING
        }
    }
}

internal fun homeHasCompletedHarvester(state: gg.pixelkingdomwars.nativeclient.data.BaseState,
    identity: HomeRouteIdentity): Boolean = !state.loading && state.error == null && state.base?.baseId == identity.baseId &&
    state.base?.buildings?.any { it.id.isNotBlank() && it.type == "harvester" && it.level > 0 && !it.underConstruction } == true

internal fun homeHarvesterLegacyNotice(status: HomeFeatureReadStatus?): String? =
    if (status == HomeFeatureReadStatus.FAILED) "Harvester details could not be refreshed. Opening the existing Harvester controls." else null

internal fun homeFeatureReadResult(proof: HomeFeatureReadCapture?, request: HomeRequest.Open?,
    ownerBusy: Boolean?): HomeNavigationResult = when (proof?.statusFor(request)) {
    HomeFeatureReadStatus.READY -> if (ownerBusy == false) HomeNavigationResult.DISPATCHED else HomeNavigationResult.DEFERRED
    HomeFeatureReadStatus.FAILED -> HomeNavigationResult.REFUSED
    else -> HomeNavigationResult.DEFERRED
}

/** StateFlow.value is not a Compose snapshot read. Subscribe to the actual owners as well as UI signals. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
internal suspend fun awaitHomeReadAdmission(signals: List<kotlinx.coroutines.flow.Flow<*>>, admitted: () -> Boolean) {
    require(signals.isNotEmpty())
    kotlinx.coroutines.flow.merge(*signals.map { flow -> flow.map { Unit } }.toTypedArray()).first { admitted() }
}

internal fun homeReadRefusalReason(reviewBlocked: Boolean, currentOwner: Boolean): String = when {
    reviewBlocked -> "Finish the current review, then refresh."
    !currentOwner -> "Details are waiting for the current kingdom. Retry when it is ready."
    else -> "Details are temporarily unavailable. Retry when the current screen is ready."
}

internal fun homeObservedFeatureFact(readComplete: Boolean, ownerCurrent: Boolean, advertised: Boolean): GateFact = when {
    !readComplete || !ownerCurrent -> GateFact.Unknown
    advertised -> GateFact.Allowed
    else -> GateFact.Denied("This feature is not currently offered by the server.")
}
