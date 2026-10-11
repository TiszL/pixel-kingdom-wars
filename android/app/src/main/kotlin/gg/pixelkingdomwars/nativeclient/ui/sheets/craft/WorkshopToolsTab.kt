package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * Design component: Workshop › TOOLS (craft/SPEC.md §2.6, workshop-tools.png): two ToolCards (Route Compass, Survey
 * Lens), the TravelRow when tools are away, YOU NEED, and a full-width CRAFT primary (quantity is fixed at 1, SPEC 0.9).
 * Output is auto-delivered (SPEC 0.2): the celebration uses the tool icon.
 *
 * Pointer rule: drawn inside the Workshop sheet's painted panel; only the cards, GOs and the primary take touches.
 */

/** One equipment recipe (SPEC §2.6 `recipes[craft_route_compass, craft_survey_lens]`). */
@Immutable data class ToolRecipeUi(
    val recipeId: String,
    /** Catalogue id of the tool ("route_compass"). */
    val itemId: String,
    /** Display name ("Route Compass"). */
    val name: String,
    /** The primary's word ("COMPASS", "LENS"). */
    val shortName: String,
    /** One-line effect ("Faster return, a bit less cargo."). */
    val effect: String,
    /** 64 px icon. */
    val icon: String,
    val inputs: List<RecipeInputUi>,
    /** Craft time; null = unknown. */
    val durationSec: Long?,
    val locked: LockReasonUi? = null,
)

/** A tool out on a Lodge trip (`travelling[{itemId, returnsAt, installationId}]`). */
@Immutable data class TravellingToolUi(val itemId: String, val returnsAtMs: Long, val installationId: String)

/** Workshop › TOOLS state (SPEC §2.6; fields after `saved` were added). */
@Immutable data class WorkshopToolsUi(
    val recipes: List<ToolRecipeUi>,
    /** Owned count by catalogue id; null = unknown. */
    val owned: Map<String, Long?>,
    val travelling: List<TravellingToolUi>,
    /** The bench job, if a tool is being crafted. */
    val job: BenchJobUi?,
    val acceptingJobs: Boolean,
    val saved: SavedOpUi?,
    val selectedRecipeId: String? = null,
    val stock: Map<String, StockUi> = emptyMap(),
    val items: Map<String, CraftItemUi> = emptyMap(),
    val shards: Long? = null,
    val actionsAllowed: Boolean = true,
    val hydration: CraftHydration = CraftHydration.Ready,
    val submit: SubmitUi = SubmitUi(),
    val serverOffsetMs: Long = 0L,
    /** Authoritative reserved stock when this owner does not expose complete fleet return times. */
    val travellingNotice: String? = null,
    /** The owner's trips door when [travelling] has no return times: tools reserved for trips ([TOOLS_TRIPS_AWAY], the
     *  #E8F1F8 TravelRow) or none away ([TOOLS_TRIPS_FIT]). Drawn only with [WorkshopToolsActions.onOpenTrips]. */
    val tripsDoor: DoorRowUi? = null,
)

/** [WorkshopToolsUi.tripsDoor] ids. */
const val TOOLS_TRIPS_AWAY = "trips-away"
const val TOOLS_TRIPS_FIT = "trips-fit"

/** Workshop › TOOLS callbacks (SPEC §2.6). A missing input's GO uses [WorkshopSheetActions.onGoRecipe]. */
@Immutable data class WorkshopToolsActions(
    val onSelectTool: (recipeId: String) -> Unit = {},
    /** Opens the review half sheet, then starts. */
    val onCraft: (recipeId: String) -> Unit = {},
    /** → `Destination.Lodge(tab = UNDER WAY)`. */
    val onGoLodge: () -> Unit = {},
    /** The owner's trips list for [WorkshopToolsUi.tripsDoor]; null hides that door, so it is never a dead GO. */
    val onOpenTrips: (() -> Unit)? = null,
)

/** The TOOLS body. */
@Composable internal fun ColumnScope.WorkshopToolsBody(ui: WorkshopToolsUi, on: WorkshopSheetActions, nowMs: Long,
    destinationsAvailable: Boolean = true) {
    ui.saved?.let { RecoveryRow(it, on.onCheckSaved) }
    SectionLabel("TOOLS", "fit one on a Lodge trip")
    val selected = selectedTool(ui)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ui.recipes.forEach { tool ->
            ToolCard(tool, if (ui.hydration == CraftHydration.Loading) null else ui.owned[tool.itemId], tool.recipeId == selected?.recipeId,
                on.tools.onSelectTool, Modifier.weight(1f))
        }
    }
    val away = travelSummary(ui, nowMs)
    val trips = on.tools.onOpenTrips
    val door = ui.tripsDoor
    if (away != null) {
        DoorRow(DoorRowUi("lodge", "ui:lodge-menu", away.first, away.second, "Go to the Lodge, trips under way"), { on.tools.onGoLodge() }, info = true)
    } else if (door != null && trips != null) {
        DoorRow(door, { trips() }, info = door.id == TOOLS_TRIPS_AWAY)
    } else ui.travellingNotice?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
    val job = ui.job
    if (job != null) {
        val tool = ui.recipes.firstOrNull { it.recipeId == job.recipeId }
        val reduced = LocalReducedMotion.current
        SectionLabel("ON THE BENCH", right = slotLine(1, 1))
        BenchCard(title = "CRAFT ${(tool?.name ?: "…").uppercase(Locale.US)}", tag = "WORKING", tagVerb = Verb.GOLD,
            input = { CraftIcon(tool?.inputs?.firstOrNull { it.kind != InputKind.SHARDS }?.let { craftItemIcon(it.itemId) } ?: "shards", 32.dp) },
            outputIcon = tool?.icon ?: "shape:unknown", outputBadge = "x1",
            progress = jobProgress(job.startedAtMs, job.readyAtMs, tool?.durationSec, nowMs, ui.serverOffsetMs, if (reduced) 60_000L else 1L),
            leftText = countdownText(secondsLeft(job.readyAtMs, nowMs, ui.serverOffsetMs)),
            doneLine = if (job.doneAt.isBlank()) "left" else "left · done at ${job.doneAt}", appearKey = job.jobId)
        return
    }
    val tool = selected ?: return
    tool.locked?.let { PkwText(it.line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
    val lines = toolLines(ui)
    if (lines.isNotEmpty()) {
        SectionLabel("YOU NEED", "for 1 ${tool.name}")
        lines.forEach { line ->
            IngredientRow(line, onGo = { l -> val here = l.goRecipeId; if (here != null) on.onGoRecipe(here) else on.onGo(l.itemId) },
                showGo = destinationsAvailable)
        }
    }
}

/** ToolCard (SPEC §2.6): CreamCard 150, a 72 well with the 64 icon, the name, the effect, the stone "x1" owned tag.
 *  Selected: gold rim on #FFF3C8. The card is its own target. */
@Composable private fun ToolCard(tool: ToolRecipeUi, owned: Long?, selected: Boolean, onSelect: (String) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    CreamCard(modifier.heightIn(min = 150.dp)
        .clearAndSetSemantics {
            contentDescription = "${tool.name}. ${tool.effect} You own ${groupDigits(owned)}."
            role = Role.Button; this.selected = selected
            onClick(label = null, action = { onSelect(tool.recipeId); true })
        }
        .clickable(role = Role.Button) { onSelect(tool.recipeId) },
        rim = if (selected) CardRim.SELECTED else CardRim.NONE, contentPadding = PaddingValues(start = 6.dp, top = 8.dp, end = 6.dp, bottom = 8.dp)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Box {
                Well(72.dp) { CraftIcon(tool.icon, 64.dp, alpha = if (tool.locked != null) 0.45f else 1f) }
                Tag("x${groupDigits(owned)}", Verb.STONE, Modifier.align(Alignment.TopEnd).offset(x = 30.dp, y = (-2).dp))
            }
            PkwText(tool.name.uppercase(Locale.US), PkwTokens.Type.caption, color = c.textOnParch, textAlign = TextAlign.Center)
            PkwText(tool.effect, PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
        }
    }
}

/** The TOOLS footer: the full-width primary and the note. */
@Composable internal fun ColumnScope.WorkshopToolsFooter(ui: WorkshopToolsUi, on: WorkshopSheetActions, primary: CraftPrimaryUi?) {
    val tool = selectedTool(ui) ?: return
    if (primary != null) {
        CraftPrimaryButton(primary, { action ->
            when (action) {
                PrimaryAction.START -> on.tools.onCraft(tool.recipeId)
                PrimaryAction.RETRY -> on.onRetry()
                PrimaryAction.NEED_MORE -> primary.price?.let(on.onNeedMore)
                else -> Unit
            }
        }, Modifier.fillMaxWidth())
    }
    val notice = submitNotice(ui.submit) ?: (ui.hydration as? CraftHydration.Error)?.message
    if (notice != null) FooterNote(notice, danger = true) else FooterNote("Tools never wear out. They come home with the boat.")
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Workshop › TOOLS (workshop-tools.png)", widthDp = 412, heightDp = 811)
@Composable private fun ToolsPreview() = WorkshopPreviewHost(CraftSamples.workshop(tools = CraftSamples.tools))

@Preview(name = "Workshop › TOOLS short", widthDp = 412, heightDp = 811)
@Composable private fun ToolsShortPreview() = WorkshopPreviewHost(CraftSamples.workshop(tools = CraftSamples.tools.copy(
    selectedRecipeId = "craft_survey_lens")))

@Preview(name = "Workshop › TOOLS crafting (busy)", widthDp = 412, heightDp = 811)
@Composable private fun ToolsBusyPreview() = WorkshopPreviewHost(CraftSamples.workshop(tools = CraftSamples.tools.copy(
    job = BenchJobUi("job-t", "craft_route_compass", 1, CraftSamples.NOW + 1_260_000L, "14:53"))))

@Preview(name = "Workshop › TOOLS paused", widthDp = 412, heightDp = 811)
@Composable private fun ToolsPausedPreview() = WorkshopPreviewHost(CraftSamples.workshop(tools = CraftSamples.tools.copy(acceptingJobs = false)))
