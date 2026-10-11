package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.tileCount
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * Design component: Workshop › REFINE (craft/SPEC.md §2.1 workshop-refine.png, §2.2 workshop-short.png, §2.3
 * workshop-working.png, §2.4 workshop-done.png): the refine and kit tile strips, the RecipeCard, the YOU NEED rows, the
 * bench card while working, and the footer's stepper + REFINE / CRAFT primary. The sheet frame, review half sheet and
 * celebration are WorkshopSheet's.
 *
 * Pointer rule: drawn inside the Workshop sheet's painted panel; only tiles, rows' GO, steppers and the primary take
 * touches.
 */

/** A recipe's group (SPEC §2.1 `group(REFINE|KIT)`). */
enum class RecipeGroup { REFINE, KIT }

/** One recipe (SPEC §2.1 `RecipeUi`). */
@Immutable data class RecipeUi(
    /** Server recipe id. */
    val recipeId: String,
    /** Server recipe version (sent back with the start request by the mapper; not drawn). */
    val recipeVersion: String,
    /** REFINE (raw → refined) or KIT (refined → kit). */
    val group: RecipeGroup,
    /** Catalogue id of the output. */
    val outputItemId: String,
    /** Output units per recipe unit. */
    val outputPerUnit: Long,
    /** Inputs per unit; SHARDS inputs become the cost pill. */
    val inputs: List<RecipeInputUi>,
    /** Seconds per unit; null = unknown ("takes …"). */
    val secondsPerUnit: Long?,
    /** What the output is for, one sentence ("For Survey Lens and Navigation Kit."). */
    val usedFor: String,
    /** Non-null = locked at this Workshop level. */
    val locked: LockReasonUi?,
)

/** One job on the bench (SPEC §2.1 `pendingJobs[{jobId, recipeId, quantity, readyAt}]`). */
@Immutable data class BenchJobUi(
    val jobId: String,
    val recipeId: String,
    val quantity: Long,
    /** Server epoch ms the job is ready. "Left" = readyAt − (device now + serverOffsetMs). */
    val readyAtMs: Long,
    /** The local clock time it is done ("14:32"), formatted by the mapper; blank draws none. */
    val doneAt: String = "",
    /** Server epoch ms it started, if known (else the bar uses quantity × secondsPerUnit). */
    val startedAtMs: Long? = null,
)

/** Workshop › REFINE state (SPEC §2.1 `WorkshopUiState.Refine`; fields after `hydration` were added). */
@Immutable data class WorkshopRefineUi(
    /** Every refine and kit recipe from the server; empty draws the empty state. */
    val recipes: List<RecipeUi>,
    /** Stock by catalogue id. */
    val stock: Map<String, StockUi>,
    /** The most units one batch may make (server). */
    val maxBatch: Int,
    /** False = the server is not accepting new jobs ("New refining is paused"). */
    val acceptingJobs: Boolean,
    /** Jobs on the bench. */
    val pendingJobs: List<BenchJobUi>,
    /** False = read-only base ("Orders are paused on this base"). */
    val actionsAllowed: Boolean,
    /** The selected recipe (null = the first). */
    val selectedRecipeId: String?,
    /** The chosen quantity (clamped to 1..maxBatch when drawn). */
    val quantity: Int,
    /** A saved request from earlier (recovery); the primary is off until it is checked. */
    val savedOperation: SavedOpUi?,
    /** Loading keeps the last view with "…" counts; Error offers "Try again". */
    val hydration: CraftHydration,
    /** Names, icons and sources of every item the recipes mention. */
    val items: Map<String, CraftItemUi> = emptyMap(),
    /** The Shards balance (for a Shards input's SHORT pill); null = unknown. */
    val shards: Long? = null,
    /** Bench capacity (server; default 1: one batch at a time). */
    val benchCapacity: Int = 1,
    /** Server clock − device clock, ms. */
    val serverOffsetMs: Long = 0L,
    /** The start request's state. */
    val submit: SubmitUi = SubmitUi(),
)

/** Workshop › REFINE callbacks (SPEC §2.1). `onGo`, `onHistory`, `onClose` are the sheet's ([WorkshopSheetActions]). */
@Immutable data class WorkshopRefineActions(
    /** Selects a recipe (tile tap, or a missing ingredient's GO when this Workshop makes it). */
    val onSelectRecipe: (String) -> Unit = {},
    /** ±1; the view model clamps to 1..maxBatch. */
    val onQty: (Int) -> Unit = {},
    /** Opens the review half sheet; START there calls [WorkshopSheetActions.onReviewConfirm]. */
    val onStart: (recipeId: String, quantity: Int) -> Unit = { _, _ -> },
)

/** The REFINE body. */
@Composable internal fun ColumnScope.WorkshopRefineBody(ui: WorkshopRefineUi, on: WorkshopSheetActions, nowMs: Long,
    destinationsAvailable: Boolean = true) {
    val c = PkwTokens.Colors
    if (ui.recipes.isEmpty() && ui.hydration != CraftHydration.Loading) {
        EmptyState(EmptyStateUi("ui:workshop-menu", "The Workshop has no recipes yet", "Recipes come with the next update.", null, null), onGo = {})
        return
    }
    ui.savedOperation?.let {
        RecoveryRow(it, on.onCheckSaved)
        on.savedDoor?.let { door -> SavedDoorButton(door) }
    }
    val reduced = LocalReducedMotion.current
    val job = ui.pendingJobs.minByOrNull { it.readyAtMs }
    if (job != null) {
        val recipe = ui.recipes.firstOrNull { it.recipeId == job.recipeId }
        val out = recipe?.let { ui.items[it.outputItemId] }
        val firstInput = recipe?.inputs?.firstOrNull { it.kind != InputKind.SHARDS }
        val inputIcon = firstInput?.let { ui.items[it.itemId]?.icon ?: craftItemIcon(it.itemId) } ?: "shards"
        val outName = (if (job.quantity == 1L) out?.name else out?.pluralName) ?: recipe?.outputItemId ?: "…"
        SectionLabel("ON THE BENCH", right = slotLine(ui.pendingJobs.size, ui.benchCapacity))
        BenchCard(
            title = "${if (recipe?.group == RecipeGroup.KIT) "CRAFT" else "REFINE"} ${groupDigits(job.quantity)} ${outName.uppercase(Locale.US)}",
            tag = "WORKING", tagVerb = Verb.GOLD,
            input = { CraftIcon(inputIcon, 32.dp) },
            outputIcon = out?.icon ?: craftItemIcon(recipe?.outputItemId.orEmpty()),
            outputBadge = "x" + tileCount(job.quantity * (recipe?.outputPerUnit ?: 1L)),
            progress = jobProgress(job.startedAtMs, job.readyAtMs, recipe?.secondsPerUnit?.let { it * job.quantity }, nowMs, ui.serverOffsetMs,
                if (reduced) 60_000L else 1L),
            leftText = countdownText(secondsLeft(job.readyAtMs, nowMs, ui.serverOffsetMs)),
            doneLine = if (job.doneAt.isBlank()) "left" else "left · done at ${job.doneAt}",
            appearKey = job.jobId)
    }
    val refine = recipeTiles(ui, RecipeGroup.REFINE)
    val kits = recipeTiles(ui, RecipeGroup.KIT)
    if (refine.isNotEmpty()) {
        SectionLabel("REFINE", "raw in, refined out", stripCount(refine.size))
        TileStrip(refine, on.refine.onSelectRecipe)
    }
    if (kits.isNotEmpty()) {
        SectionLabel("KITS", "refined in, kit out", stripCount(kits.size))
        TileStrip(kits, on.refine.onSelectRecipe)
    }
    // While the bench works the tiles stay browsable; the card and the rows return when it is free (SPEC §2.3).
    if (job != null) return
    val recipe = selectedRecipe(ui) ?: return
    val out = ui.items[recipe.outputItemId]
    val name = out?.name ?: recipe.outputItemId
    RecipeCard(out?.icon ?: craftItemIcon(recipe.outputItemId), name, if (recipe.group == RecipeGroup.REFINE) "REFINED" else null,
        recipe.usedFor, craftDuration(recipe.secondsPerUnit), dim = recipe.locked != null)
    recipe.locked?.let { PkwText(it.line, PkwTokens.Type.small, color = c.textOnParch2) }
    val lines = refineLines(ui)
    if (lines.isNotEmpty()) {
        val units = refineQuantity(ui) * recipe.outputPerUnit
        SectionLabel("YOU NEED", "for ${groupDigits(units)} ${if (units == 1L) name else out?.pluralName ?: name}")
        // A missing input made at this Workshop selects its recipe in place (no destination needed, SPEC §2.2).
        lines.forEach { line ->
            IngredientRow(line, showGo = destinationsAvailable || line.goRecipeId != null, onGo = { l ->
                val here = l.goRecipeId
                if (here != null) on.refine.onSelectRecipe(here) else on.onGo(l.itemId)
            })
        }
    }
}

/** The REFINE footer: stepper + primary (the bench-busy primary is full width), and the note. */
@Composable internal fun ColumnScope.WorkshopRefineFooter(ui: WorkshopRefineUi, on: WorkshopSheetActions, primary: CraftPrimaryUi?) {
    val recipe = selectedRecipe(ui) ?: return
    if (primary == null) return
    val qty = refineQuantity(ui)
    val benchBusy = ui.pendingJobs.isNotEmpty() && primary.state == CommandState.BUSY
    val stepper = !benchBusy && recipe.locked == null && ui.hydration !is CraftHydration.Error && primary.action != PrimaryAction.NONE
    val outName = ui.items[recipe.outputItemId]?.name ?: recipe.outputItemId
    val lines = refineLines(ui)
    // workshop-short.png: the missing-ingredient reason is the red line under the primary, then the grey note.
    val shortLine = shortReason(lines)?.takeIf { it == primary.reason }
    Row(Modifier.fillMaxWidth().padding(top = if (primary.price != null) 14.dp else 0.dp), verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (stepper) QtyStepper(qty.toString(), "max ${ui.maxBatch}", { on.refine.onQty(-1) }, { on.refine.onQty(1) }, outName,
            minusEnabled = qty > 1, plusEnabled = qty < ui.maxBatch)
        CraftPrimaryButton(if (shortLine != null) primary.copy(reason = null) else primary, { action ->
            when (action) {
                PrimaryAction.START -> on.refine.onStart(recipe.recipeId, qty)
                PrimaryAction.RETRY -> on.onRetry()
                PrimaryAction.NEED_MORE -> primary.price?.let(on.onNeedMore)
                else -> Unit
            }
        }, Modifier.weight(1f))
    }
    val notice = submitNotice(ui.submit) ?: (ui.hydration as? CraftHydration.Error)?.message
    when {
        notice != null -> FooterNote(notice, danger = true)
        benchBusy -> FooterNote("Browse recipes while you wait. The bench takes one batch at a time.")
        shortLine != null -> {
            FooterNote(shortLine, danger = true)
            FooterNote("Nothing is spent until you start.")
        }
        lines.any { it.short } -> FooterNote("Nothing is spent until you start.")
        else -> {
            val spent = lines.singleOrNull()?.name?.let { "$it is spent when you start." }
                ?: if (lines.isEmpty()) "Shards are spent when you start." else "The inputs are spent when you start."
            FooterNote("$spent $outName goes straight to your stores.")
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Workshop › REFINE ready (workshop-refine.png)", widthDp = 412, heightDp = 811)
@Composable private fun RefineReadyPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine))

@Preview(name = "Workshop › REFINE short (workshop-short.png)", widthDp = 412, heightDp = 811)
@Composable private fun RefineShortPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refineShort))

@Preview(name = "Workshop › REFINE working (workshop-working.png)", widthDp = 412, heightDp = 811)
@Composable private fun RefineWorkingPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refineWorking, working = true))

@Preview(name = "Workshop › REFINE batch done (workshop-done.png)", widthDp = 412, heightDp = 811)
@Composable private fun RefineDonePreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine).copy(celebration = CraftSamples.batchDone))

@Preview(name = "Workshop › REFINE review half sheet", widthDp = 412, heightDp = 811)
@Composable private fun RefineReviewPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine).copy(review = CraftSamples.refineReview))

@Preview(name = "Workshop › REFINE starting (success sequence)", widthDp = 412, heightDp = 811)
@Composable private fun RefineStartingPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine.copy(submit = SubmitUi(SubmitStage.SENDING))))

@Preview(name = "Workshop › REFINE loading (last view, … counts)", widthDp = 412, heightDp = 811)
@Composable private fun RefineLoadingPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine.copy(hydration = CraftHydration.Loading)))

@Preview(name = "Workshop › REFINE error", widthDp = 412, heightDp = 811)
@Composable private fun RefineErrorPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine.copy(
    hydration = CraftHydration.Error("The Workshop can't reach the server. Try again."))))

@Preview(name = "Workshop › REFINE uncertain (being checked + recovery)", widthDp = 412, heightDp = 811)
@Composable private fun RefineCheckingPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine.copy(
    submit = SubmitUi(SubmitStage.CHECKING), savedOperation = SavedOpUi("op-7"))))

@Preview(name = "Workshop › REFINE locked recipe", widthDp = 412, heightDp = 811)
@Composable private fun RefineLockedPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine.copy(selectedRecipeId = "refine_embercore")))

@Preview(name = "Workshop › REFINE paused (read-only base)", widthDp = 412, heightDp = 811)
@Composable private fun RefinePausedPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine.copy(actionsAllowed = false)))

@Preview(name = "Workshop › REFINE empty", widthDp = 412, heightDp = 811)
@Composable private fun RefineEmptyPreview() = WorkshopPreviewHost(CraftSamples.workshop(CraftSamples.refine.copy(recipes = emptyList())))
