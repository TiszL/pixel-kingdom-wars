package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*

/** The host's actual read outcome, independent of whether retained values are still admitted. */
internal enum class HomeWorkshopReadStatus { LOADING, READY, FAILED }

internal data class HomeWorkshopInventoryRow(val label: String, val value: String)
internal data class HomeWorkshopDisplay(val section: String, val status: String,
    val inventory: List<HomeWorkshopInventoryRow> = emptyList(), val canRetry: Boolean = false,
    val canOpenOriginal: Boolean = false, val hasObservedBody: Boolean = false, val canOpenControls: Boolean = false)

/** Pure display projection. No kit primary, prices, review, Seal or callback is carried into this model. */
internal fun homeWorkshopDisplay(observation: WorkshopSheetUi?, readStatus: HomeWorkshopReadStatus,
    admittedView: Boolean, requestedTab: String, originalRequestPending: Boolean = false): HomeWorkshopDisplay {
    val section = when (requestedTab) {
        WorkshopTab.REFINE -> "REFINE"
        WorkshopTab.INGOTS -> "INGOTS"
        WorkshopTab.EQUIPMENT -> "TOOLS"
        WorkshopTab.COSMETICS -> "STYLE"
        else -> "WORKSHOP"
    }
    fun message(text: String, retry: Boolean = false, original: Boolean = false) =
        HomeWorkshopDisplay(section, text, canRetry = retry, canOpenOriginal = original)
    if (readStatus == HomeWorkshopReadStatus.LOADING) return message("Loading Workshop information…")
    if (readStatus == HomeWorkshopReadStatus.FAILED) return message("Workshop information could not be refreshed. Try again.", true)
    if (!admittedView) return message("Workshop information is not current.")
    if (originalRequestPending) return message("A saved Workshop request needs attention. Its original receipt is preserved.", original = true)
    if (observation == null) return message("Workshop inventory and jobs are unavailable.")
    if (observation.review != null) return message("An existing Workshop review needs attention.")
    if (observation.ingots?.saved != null || observation.refine?.savedOperation != null ||
        observation.tools?.saved != null || observation.style?.saved != null) {
        return message("A saved Workshop request needs attention. Its original receipt is preserved.", original = true)
    }
    if (section == "WORKSHOP") return message("Workshop: choose a section.")
    if (requestedTab == WorkshopTab.REFINE && observation.frame.tabs.any { it.id == requestedTab }) {
        val refine = observation.refine
        if (refine != null && refine.hydration == CraftHydration.Ready && refine.submit.stage == SubmitStage.IDLE) {
            return HomeWorkshopDisplay(section,
                if (refine.pendingJobs.isNotEmpty()) "A batch is in progress. Output arrives automatically."
                else "Workshop recipes and materials", hasObservedBody = true, canOpenControls = true)
        }
    }
    if (requestedTab != WorkshopTab.INGOTS) {
        return message(when (requestedTab) {
            WorkshopTab.REFINE -> "Refining information is unavailable. Recipes and stock have not been observed."
            WorkshopTab.EQUIPMENT -> "Tools information is unavailable. Equipment and trips have not been observed."
            else -> "Style information is unavailable. Owned appearances have not been observed."
        })
    }
    if (observation.frame.tabs.none { it.id == requestedTab }) return message("This Workshop section is unavailable.")
    val ingots = observation.ingots ?: return message(
        if (observation.frame.live?.ready == true) "Forge Ingots are ready. Collection review is unavailable."
        else "Workshop inventory and jobs are unavailable.")
    if (ingots.hydration != CraftHydration.Ready) return message("Workshop inventory and jobs are unavailable.")
    if (ingots.submit.stage == SubmitStage.SENDING || ingots.submit.stage == SubmitStage.CHECKING ||
        ingots.collect == CollectStage.COLLECTING || ingots.job?.state == IngotJobState.COLLECTING) {
        return message("A Workshop request is in progress. Its original receipt is preserved.")
    }
    val values = listOf("Ingots held" to ingots.inventory.held, "Ingots being cast" to ingots.inventory.pending,
        "Daily allowance remaining" to ingots.allowance.daily.remaining, "Holding room remaining" to ingots.allowance.holding.remaining)
    val rows = values.map { (label, value) -> HomeWorkshopInventoryRow(label, groupDigits(value?.takeIf { it >= 0 })) }
    val status = when {
        ingots.job?.state == IngotJobState.READY -> "A batch is ready in the Workshop."
        ingots.job?.state == IngotJobState.RUNNING -> "A batch is in progress."
        values.any { it.second == null || it.second!! < 0 } -> "Workshop inventory is partly unknown."
        else -> "Workshop inventory"
    }
    return HomeWorkshopDisplay(section, status, rows, hasObservedBody = true,
        canOpenControls = ingots.submit.stage == SubmitStage.IDLE && ingots.collect == CollectStage.IDLE)
}

/** An observation is copied into a closed presentation contract, never into an actionable kit state. All four
 * design tabs remain navigable; missing sibling-owner observations stay unknown. Currentness and a completed read
 * are independent of a retained snapshot. Neither reviews nor celebrations are copied into the mounted sheet.
 */
internal fun homeWorkshopSheetUi(observation: WorkshopSheetUi?, readStatus: HomeWorkshopReadStatus,
    admittedView: Boolean, requestedTab: String, originalRequestPending: Boolean = false): WorkshopSheetUi {
    val shown = homeWorkshopDisplay(observation, readStatus, admittedView, requestedTab, originalRequestPending)
    val tabs = workshopTabs()
    val selected = requestedTab.takeIf { id -> tabs.any { it.id == id } }.orEmpty()
    val ingots = observation?.ingots?.takeIf { shown.inventory.isNotEmpty() }?.let { observed ->
        fun count(value: Long?) = value?.takeIf { it >= 0 }
        observed.copy(
            inventory = IngotInventoryUi(count(observed.inventory.held), count(observed.inventory.pending)),
            allowance = observed.allowance.copy(
                daily = observed.allowance.daily.let { IngotDailyUi(count(it.used), count(it.cap), count(it.remaining)) },
                holding = observed.allowance.holding.let { IngotHoldingUi(count(it.held), count(it.pending), count(it.cap), count(it.remaining)) }),
            actionsAllowed = false, submit = SubmitUi(), collect = CollectStage.IDLE)
    }
    val refine = observation?.refine?.takeIf { selected == WorkshopTab.REFINE && shown.hasObservedBody }
        ?.copy(actionsAllowed = false, submit = SubmitUi())
    val bodyPresent = ingots != null || refine != null
    return WorkshopSheetUi(
        frame = CraftFrameUi("WORKSHOP", observation?.frame?.titleTag.takeIf { bodyPresent },
            observation?.frame?.live.takeIf { bodyPresent }, false, tabs, selected),
        header = observation?.header?.takeIf { bodyPresent } ?: CraftHeaderUi(null),
        ingots = ingots, refine = refine,
        observation = WorkshopObservationUi(shown.status, readStatus == HomeWorkshopReadStatus.LOADING,
            shown.canRetry, shown.canOpenOriginal, shown.canOpenControls),
    )
}

/** Existing-owner callbacks only. C3 rechecks the current lease/identity when each callback runs. */
internal fun homeWorkshopActions(ui: WorkshopSheetUi, onTab: (String) -> Unit, onRetry: () -> Unit,
    onLegacy: () -> Unit, onClose: () -> Unit, onRefineSelect: (String) -> Unit = {},
    onRefineQty: (Int) -> Unit = {}): WorkshopSheetActions = WorkshopSheetActions(
    onClose = onClose,
    onTab = { tab -> if (ui.frame.tabs.any { it.id == tab }) onTab(tab) },
    onRetry = { if (ui.observation?.canRetry == true) onRetry() },
    onOpenOriginal = onLegacy.takeIf { ui.observation?.canOpenOriginal == true },
    onOpenControls = onLegacy.takeIf { ui.observation?.canOpenControls == true },
    refine = WorkshopRefineActions(
        onSelectRecipe = { id -> if (ui.refine?.recipes?.any { it.recipeId == id } == true) onRefineSelect(id) },
        onQty = { delta -> if (ui.refine != null && delta in listOf(-1, 1)) onRefineQty(delta) }),
)

/** Designed Home observation body. C3 owns the bounded slot, exact read admission and callback guards. New
 * commands remain unavailable here. Healthy current reads can navigate to their existing designed owner; the
 * separate original-request door remains attached only to an admitted saved request.
 */
@Composable internal fun HomeWorkshopBody(
    observation: WorkshopSheetUi?,
    readStatus: HomeWorkshopReadStatus,
    admittedView: Boolean,
    requestedTab: String,
    onRetry: () -> Unit,
    onLegacy: () -> Unit,
    onClose: () -> Unit,
    onTab: (String) -> Unit,
    originalRequestPending: Boolean = false,
    onRefineSelect: (String) -> Unit = {},
    onRefineQty: (Int) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val ui = homeWorkshopSheetUi(observation, readStatus, admittedView, requestedTab, originalRequestPending)
    WorkshopSheet(ui, homeWorkshopActions(ui, onTab, onRetry, onLegacy, onClose, onRefineSelect, onRefineQty), modifier)
}
