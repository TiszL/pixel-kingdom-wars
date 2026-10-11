package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Economy is an aggregate entry with no selected-building target. Both paths still re-resolve current gates. */
enum class HomeRequestEntry { HOME, ECONOMY, FORGE }
internal val HOME_ECONOMY_FEATURES = setOf("harvester.harvest", "lodge.expedition", "berth.fleet", "workshop.craft")

/** A destination inside Home requested from another screen (quest board, tutorial strip, funds
 * sheet). Persisted across the screen hand-off so mounting order can never eat it (web
 * `requestRaidChooser`/`requestTraining`); the screen it addresses consumes it exactly once. */
sealed interface HomeRequest {
    /** Registry intent, not resolved navigation or permission to spend. Only the Home dispatcher
     * consumes this request after checking the current session, base, selection and registry gates. */
    data class Open(
        val featureId: FeatureId,
        val identity: HomeRouteIdentity,
        val selection: FeatureSelection,
        val hostTab: HomeTab = HomeTab.KINGDOM,
        val resources: Destination.Resources? = null,
        val entry: HomeRequestEntry = HomeRequestEntry.HOME,
    ) : HomeRequest {
        init {
            require(hostTab == HomeTab.KINGDOM || hostTab == HomeTab.WORLD)
            require(entry != HomeRequestEntry.ECONOMY ||
                (featureId.value in HOME_ECONOMY_FEATURES && hostTab == HomeTab.KINGDOM && resources == null))
            require(entry != HomeRequestEntry.FORGE ||
                (featureId.value in setOf("goldforge.open", "goldforge.smelt", "goldforge.claim", "goldforge.gems", "goldforge.legacy") &&
                    hostTab == HomeTab.KINGDOM && resources == null))
        }
    }
    data class Tab(val tab: HomeTab) : HomeRequest
    data object BuildMenu : HomeRequest
    /** Return from Supplies to the selected construction category; navigation only. */
    data class BuildCategory(val tab: String) : HomeRequest
    data object HeroBuildMenu : HomeRequest
    data class FocusBuilding(val buildingId: String) : HomeRequest
    /** The ready-army roster over the retained Kingdom scene. */
    data object Army : HomeRequest
    /** Barracks and training objectives open the composer, rather than the ready-army roster. */
    data object Training : HomeRequest
    /** Web `requestRaidChooser`: the RAID destination chooser, consumed by the Kingdom Army sheet owner once it has mounted. */
    data object RaidChooser : HomeRequest
    /** Explicit campaign entry, distinct from the attack tab's raid log/recovery destination. */
    data object Campaign : HomeRequest
    /** The World tab opened for a purpose (choose land, find a rival, view deeds); consumed by the World screen. */
    data class World(val entry: gg.pixelkingdomwars.nativeclient.data.WorldEntry) : HomeRequest
    /** The HUD builders segment: the Kingdom screen's builder overview (jobs, VIEW JOB, HIRE). It replaced the BUILDERS
     *  dock button, so the HUD chip is the one builders door on Home. */
    data object Builders : HomeRequest
    /** A HUD deck tool (the folded LAYOUT · EXPAND · FIT dock row); the Kingdom screen runs it with its own rules. */
    data class BaseTool(val tool: HomeBaseTool) : HomeRequest
    /** BUILD refused by a saved construction (owner 2026-10-06): the Kingdom screen brings its recovery card into view
     *  (unfolds the herald, steps a selection aside). Presentation only; it is always consumed, so it never holds the queue. */
    data object ShowRecovery : HomeRequest

    /** The Home tab this request lives on: the build tray and a building focus are Kingdom-screen
     * requests, so the scaffold switches there before the Kingdom screen consumes them (web `openBuild`
     * sets the category and the screen together); Army, training and raid sheets retain the Kingdom scene. */
    val homeTab: HomeTab get() = when (this) { is Open -> hostTab; is Tab -> tab; Army, Training, RaidChooser, Campaign -> HomeTab.KINGDOM; is World -> HomeTab.WORLD; else -> HomeTab.KINGDOM }
}

/** The three base tools the HUD deck's tools shelf carries (formerly KingdomScreen's LAYOUT · EXPAND · FIT dock row). */
enum class HomeBaseTool { LAYOUT, EXPAND, FIT }

/** Requests are queued in order and [pending] exposes the head: a tab switch followed by a build-tray
 * request survives as two steps instead of the second overwriting the first. */
class HomeRequests {
    private val queue = ArrayDeque<HomeRequest>()
    private var dispatchingOpen = false
    private var deferredOpen: HomeRequest.Open? = null
    private val _pending = MutableStateFlow<HomeRequest?>(null)
    val pending: StateFlow<HomeRequest?> = _pending.asStateFlow()
    @Synchronized fun request(request: HomeRequest) {
        // A newer explicit command supersedes a waiting door; cross-tab navigation must never
        // sit behind a door whose host has just been abandoned. Other requests keep FIFO order.
        if (request !is HomeRequest.Open) while (true) {
            val head = queue.firstOrNull() as? HomeRequest.Open ?: break
            if (head !== deferredOpen && request.homeTab == head.hostTab) break
            finishOpen(head)
        }
        // A rapid repeat has the same destination. Keeping it would leave an equal StateFlow head
        // after consume(), so the destination's LaunchedEffect could not observe the second request.
        if (queue.lastOrNull() == request) return
        queue.addLast(request); _pending.value = queue.first()
    }
    /** Only the head can be consumed, and only by the screen that handled it. */
    @Synchronized fun consume(request: HomeRequest) {
        if (queue.firstOrNull() != request) return
        queue.removeFirst(); _pending.value = queue.firstOrNull()
        if (request === deferredOpen) deferredOpen = null
    }

    /** User tab selection expires mismatched intents, rather than reviving them on return.
     * Programmatic mounting of a newly requested host does not use this explicit-user seam. */
    @Synchronized fun selectHomeTab(tab: HomeTab, select: (HomeTab) -> Unit) {
        queue.removeAll { it is HomeRequest.Open && it.hostTab != tab }
        if (queue.firstOrNull() !== deferredOpen) deferredOpen = null
        _pending.value = queue.firstOrNull()
        select(tab)
    }

    @Synchronized internal fun deferOpen(request: HomeRequest.Open) {
        if (queue.firstOrNull() === request) deferredOpen = request
    }

    /** Keep head ownership through the synchronous dispatch. A callback may append requests, but
     * nested dispatchers cannot replay this head. Deferred owners retain it for a fresh gate check. */
    @Synchronized internal fun dispatchOpen(
        request: HomeRequest.Open,
        dispatch: () -> HomeRouteDispatchResult,
    ): HomeRouteDispatchResult {
        val head = queue.firstOrNull() ?: return HomeRouteDispatchResult.NOT_HEAD
        if (head != request) return HomeRouteDispatchResult.NOT_HEAD
        if (dispatchingOpen) return HomeRouteDispatchResult.DEFERRED
        dispatchingOpen = true
        try {
            val result = dispatch()
            if (result != HomeRouteDispatchResult.DEFERRED) finishOpen(head) else deferOpen(request)
            return result
        } catch (failure: Throwable) {
            // A host may have acted before throwing. Only an explicit no-effect DEFERRED may
            // retry; an ambiguous failure must never replay navigation or an owned action.
            finishOpen(head)
            throw failure
        } finally {
            dispatchingOpen = false
        }
    }

    private fun finishOpen(head: HomeRequest) {
        if (queue.firstOrNull() !== head) return
        if (head === deferredOpen) deferredOpen = null
        queue.removeFirst(); _pending.value = queue.firstOrNull()
    }
}
