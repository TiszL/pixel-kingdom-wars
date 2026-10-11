package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.WorkshopState
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopView
import java.time.Instant

/**
 * Observation-only INGOTS projection into the existing Workshop shell. The other tabs require their own repository
 * inputs and remain absent. [availableTabs] and [historyAvailable] come from owner-admitted navigation, never guesses;
 * an admitted saved original always adds and selects a recovery-only INGOTS tab, independent of new-command gates.
 * [headerTier] is an admitted server art-map tier, not the building level; absent art has no invented tier-one sprite.
 *
 * [repositoryCurrent] admits the current account's exact origin/cluster/wallet repository. [viewCurrent] separately
 * admits its current selected-base/generation observation; [balanceCurrent] separately admits its Shards read. Equality
 * alone cannot prove freshness after A -> B -> A. The owner clears admission on invalidation/refresh failure. Original
 * saved operations remain visible for the admitted repository even without a selected base or new-command capability.
 *
 * No controller, callback, request, Seal, receipt transition or celebration is created. Every mutation stays closed.
 * Ready jobs retain their observed bench and the kit's closed collection gate. The unit-price input is withheld until
 * funds are independently admitted. No fake pending request, in-flight stage or transport error is used as a gate.
 * Multiple active jobs also cannot be collapsed into the kit's single bench. A saved original uses a recovery-only
 * body, never a fabricated current-base inventory or completion state. Mounting/Seal/controller review is separate.
 * The host must bind recovery CHECK only to WorkshopRepository.check(), never reviewSaved()/confirm()/retry.
 * Home mounts omitted/recovery states with the explicit Workshop observation presentation, never generic Checking,
 * paused orders or an Empty bench. This does not admit a command-mode mount.
 */
internal fun workshopMoneySheetUi(
    state: WorkshopState? = null,
    identity: WorkshopIdentity? = null,
    selectedBaseId: String? = null,
    repositoryCurrent: Boolean = false,
    viewCurrent: Boolean = false,
    balanceCurrent: Boolean = false,
    availableTabs: Collection<String> = emptyList(),
    selectedTab: String? = null,
    quantity: Int = 1,
    serverOffsetMs: Long? = null,
    headerTier: Int? = null,
    historyAvailable: Boolean = false,
): WorkshopSheetUi {
    val repository = state?.takeIf {
        repositoryCurrent && identity != null && it.journal.identity == identity &&
            runCatching { identity.validate() }.isSuccess
    }
    val admitsIngots = WorkshopTab.INGOTS in availableTabs
    val view = repository?.takeIf { admitsIngots && viewCurrent && !it.busy && it.advertised }?.view?.takeIf {
        !selectedBaseId.isNullOrBlank() && it.inventory.baseId == selectedBaseId && runCatching { it.validate() }.isSuccess
    }
    val active = view?.jobs.orEmpty().filter { it.collectedAt == null }
    val ready = active.any { it.ready }
    val saved = repository?.journal?.operation
    val showIngots = admitsIngots || saved != null
    val validSaved = saved?.takeIf { runCatching { it.command.validate() }.isSuccess }
    val body = when {
        !showIngots -> null
        // Never treat an unreadable saved original as an empty journal or a new-action opportunity.
        saved != null && validSaved == null -> null
        validSaved != null -> recoveryOnlyIngots(SavedOpUi(validSaved.command.key,
            line = "A saved Workshop request needs attention.", checking = repository?.busy == true))
        view == null || active.size > 1 -> null
        else -> observedIngots(view, repository?.shards.takeIf { balanceCurrent }, quantity, serverOffsetMs)
    }
    val tabs = workshopTabs(if (saved != null) availableTabs + WorkshopTab.INGOTS else availableTabs,
        ingotsReady = ready)
    val tab = if (saved != null) WorkshopTab.INGOTS
        else tabs.firstOrNull { it.id == selectedTab }?.id ?: tabs.firstOrNull()?.id.orEmpty()
    val live = when {
        saved != null -> CraftLiveUi("timer", "Saved Workshop request needs attention")
        ready -> CraftLiveUi("ui:ready-status", "Forge Ingots ready", ready = true)
        view == null -> CraftLiveUi("timer", "Checking Workshop")
        active.size > 1 -> CraftLiveUi("timer", "Workshop batches need attention")
        active.isNotEmpty() -> CraftLiveUi("timer", "Casting")
        !view.acceptingJobs -> CraftLiveUi("timer", "Workshop paused")
        else -> CraftLiveUi("ui:ready-status", "Workshop idle")
    }
    val bench = when { ready -> BenchSprite.READY; active.isNotEmpty() -> BenchSprite.WORKING; else -> BenchSprite.IDLE }
    return WorkshopSheetUi(
        frame = CraftFrameUi("WORKSHOP", view?.let { "LV ${it.level}" }, live,
            historyAvailable && repository != null, tabs, tab),
        header = if (view != null && headerTier != null) workshopHeader(headerTier, bench) else CraftHeaderUi(null),
        ingots = body,
        refine = null, tools = null, style = null, review = null, celebration = null, spend = null,
    )
}

private fun observedIngots(view: WorkshopView, shards: String?, quantity: Int, offset: Long?): WorkshopIngotsUi {
    val limit = minOf(view.batch.size, view.allowance.daily.remaining, view.allowance.holding.remaining)
        .coerceAtMost(Int.MAX_VALUE.toLong()).coerceAtLeast(1).toInt()
    val qty = quantity.coerceIn(1, limit)
    val funds = shards?.takeIf(WORKSHOP_SHARDS::matches)?.toLongOrNull()
    val job = view.jobs.singleOrNull { it.collectedAt == null }
    val seconds = view.secPerIngot?.takeIf {
        productFits(it, qty.toLong()) && productFits(it, job?.ingots ?: 0)
    }
    return WorkshopIngotsUi(
        inventory = IngotInventoryUi(view.inventory.held, view.inventory.pending),
        allowance = IngotAllowanceUi(
            IngotDailyUi(view.allowance.daily.used, view.allowance.daily.cap, view.allowance.daily.remaining),
            IngotHoldingUi(view.allowance.holding.held, view.allowance.holding.pending,
                view.allowance.holding.cap, view.allowance.holding.remaining),
            observedEpoch(view.allowance.resetsAt, offset),
        ),
        shardsPerIngot = view.shardsPerIngot.takeIf { funds != null && productFits(it, qty.toLong()) },
        batch = IngotBatchUi(view.batch.size),
        job = job?.let { IngotJobUi(it.jobId, it.ingots, observedEpoch(it.readyAt, offset),
            if (it.ready) IngotJobState.READY else IngotJobState.RUNNING, observedEpoch(it.startedAt, offset)) },
        shards = funds,
        actionsAllowed = false,
        saved = null,
        quantity = qty,
        secondsPerIngot = seconds,
        hydration = CraftHydration.Ready,
        // A current view or saved proof never fabricates a mutation/receipt/celebration stage.
        submit = SubmitUi(), collect = CollectStage.IDLE,
        serverOffsetMs = offset ?: 0,
    )
}

private fun recoveryOnlyIngots(saved: SavedOpUi) = WorkshopIngotsUi(
    inventory = IngotInventoryUi(null, null),
    allowance = IngotAllowanceUi(IngotDailyUi(null, null, null), IngotHoldingUi(null, null, null, null), null),
    shardsPerIngot = null, batch = IngotBatchUi(null), job = null, shards = null,
    actionsAllowed = false, saved = saved, hydration = CraftHydration.Ready,
)

private fun observedEpoch(stamp: String, offset: Long?): Long? =
    if (offset == null) null else runCatching { Instant.parse(stamp).toEpochMilli() }.getOrNull()

private fun productFits(unit: Long, count: Long): Boolean = runCatching { Math.multiplyExact(unit, count) }.isSuccess

private val WORKSHOP_SHARDS = Regex("0|[1-9][0-9]*")
