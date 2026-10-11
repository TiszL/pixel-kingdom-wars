package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.EquipmentState
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.phasee.equipmentCanCraft
import gg.pixelkingdomwars.nativeclient.ui.phasee.equipmentHasUnresolved
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import java.time.Instant

/** Presentation of the existing equipment owner. Review and recovery remain with that owner's frozen records.
 * A stock reservation proves its count, not a fleet destination or return time. No missing trip read becomes empty.
 */
internal fun equipmentWorkshopSheetUi(
    state: EquipmentState, identity: StarterIdentity, selectedBaseId: String?,
    current: Boolean, readCurrent: Boolean, actionsAllowed: Boolean,
    running: Boolean = false, notice: String? = null, noticeError: Boolean = false,
    serverOffsetMs: Long? = null,
): WorkshopSheetUi {
    val identityMatches = state.journal?.identity == identity && runCatching { identity.validate() }.isSuccess
    val admitted = current && identityMatches
    val frame = CraftFrameUi("WORKSHOP", null, null, admitted, workshopTabs(), WorkshopTab.EQUIPMENT)
    fun unavailable(message: String, loading: Boolean = false) = WorkshopSheetUi(frame, CraftHeaderUi(null),
        observation = WorkshopObservationUi(message, loading = loading,
            canRetry = admitted && !running && !state.busy && state.review == null), destinationsAvailable = false)
    if (!admitted) return unavailable("Return to the current kingdom's Workshop. Original equipment receipts stay with their account.")
    if (state.error != null || noticeError) return unavailable(state.error ?: notice ?: "Equipment information could not be refreshed.")
    if (running || state.busy) return unavailable("Checking Workshop tools and materials…", loading = true)
    if (!readCurrent) return unavailable("Checking current Workshop stock…", loading = true)
    val view = state.view ?: return unavailable("Tools information is unavailable. Refresh this kingdom's stock or open its original receipts.")
    return runCatching {
        view.validate()
        require(view.wallet == identity.wallet && view.baseId == selectedBaseId)
        require(view.pendingJobs.size <= 1 && (view.pendingJobs.isEmpty() || serverOffsetMs != null))
        require(view.recipes.any { it.output.itemId == state.item })
        fun label(id: String) = id.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
        val recipes = view.recipes.map { recipe ->
            require(recipe.quantity == 1 && recipe.output.quantity == "1")
            ToolRecipeUi(recipe.recipeId, recipe.output.itemId, label(recipe.output.itemId),
                if (recipe.output.itemId == "route_compass") "COMPASS" else "LENS",
                if (recipe.output.itemId == "route_compass") "Faster return, a bit less cargo." else "Swap some cargo for a second material.",
                craftItemIcon(recipe.output.itemId), recipe.inputs.map {
                    RecipeInputUi(InputKind.CRAFTING, it.itemId, it.quantity.toLong())
                }, recipe.durationSec)
        }
        val reserved = view.equipmentStock.fold(0L) { sum, stock -> Math.addExact(sum, stock.reserved.toLong()) }
        // The record under the in-sheet review is that review's own recovery; it becomes a waiting request only after BACK.
        val reviewing = state.review?.key
        val saved = state.journal?.let { journal -> journal.pending.firstOrNull { record ->
            record.key != reviewing && equipmentHasUnresolved(state.copy(journal = journal.copy(pending = listOf(record))), selectedBaseId)
        } }?.let { SavedOpUi(it.key, line = "Open original receipts before starting another craft or expedition.") }
        val itemIds = recipes.flatMap { it.inputs.map(RecipeInputUi::itemId) }.toSet()
        val items = itemIds.associateWith { CraftItemUi(it, label(it), craftItemIcon(it), "Refine at the Workshop") }
        val tools = WorkshopToolsUi(recipes,
            view.equipmentStock.associate { it.itemId to Math.addExact(it.available.toLong(), it.reserved.toLong()) },
            travelling = emptyList(),
            job = view.pendingJobs.singleOrNull()?.let { job ->
                BenchJobUi(job.jobId, job.recipe.recipeId, 1L, Instant.parse(job.readyAt).toEpochMilli(),
                    startedAtMs = Instant.parse(job.startedAt).toEpochMilli())
            }, acceptingJobs = view.acceptingJobs, saved = saved,
            selectedRecipeId = recipes.single { it.itemId == state.item }.recipeId,
            stock = view.craftingStock.associate { it.itemId to StockUi(it.available.toLong(), pendingOutput = it.pendingOutput.toLong()) },
            items = items,
            actionsAllowed = actionsAllowed && state.review == null && equipmentCanCraft(state, selectedBaseId, true),
            serverOffsetMs = serverOffsetMs ?: 0L,
            tripsDoor = equipmentTripsDoor(reserved))
        WorkshopSheetUi(frame, CraftHeaderUi(null), tools = tools, destinationsAvailable = false)
    }.getOrElse { unavailable("Current tools or their timing could not be represented. Check the original equipment records.") }
}

/** The TRIPS door (SPEC §2.6 TravelRow; GO opens the owner's expeditions). Reserved stock proves only a count, so the
 * away row never invents a return time; with nothing reserved the row carries the tab's purpose line instead. */
internal fun equipmentTripsDoor(reserved: Long): DoorRowUi = if (reserved > 0) DoorRowUi(TOOLS_TRIPS_AWAY, "ui:lodge-menu",
    "${groupDigits(reserved)} ${if (reserved == 1L) "tool is" else "tools are"} reserved for trips.",
    "Return times are unavailable here.", "Open equipment expeditions")
else DoorRowUi(TOOLS_TRIPS_FIT, "ui:lodge-menu", "Fit it on Lodge trips",
    "Compare each fitted route before departing.", "Open equipment expeditions")

/** SPEC §5 loading without blanking: while the owner is actually reading (a refresh, a review or a confirm), the last
 * current TOOLS snapshot of this same presentation keeps drawing with unknown counts and a busy primary. A failed,
 * foreign or unadmitted read keeps its own reason, and an idle unread state keeps its TRY AGAIN door. */
internal fun equipmentRetainedSheetUi(fresh: WorkshopSheetUi, last: WorkshopToolsUi?, reading: Boolean): WorkshopSheetUi {
    if (!reading || last == null || fresh.observation?.loading != true) return fresh
    return fresh.copy(observation = null, tools = last.copy(hydration = CraftHydration.Loading, actionsAllowed = false))
}
