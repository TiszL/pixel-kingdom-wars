package gg.pixelkingdomwars.nativeclient.ui.kingdom

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.WallBatchState
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.HERALD_PLATE_MAX_W
import gg.pixelkingdomwars.nativeclient.ui.kit.HeraldPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Owner 2026-10-06 (screenshots 1, 3 and 4: "I should not see any even 1 of old screens", "none of screens should overlay
 * each other"): the Home pieces that were still drawn on the old dark web chrome (an ink column, Material cards, ghost
 * text buttons) now use the kit. Every piece keeps its owner callbacks, guards and words exactly; only the look changed:
 *
 * - [RecoveryPlate]: a saved request or receipt that needs the player's hand (saved builder payment, hero altar receipt,
 *   wall batch receipt) on the same herald plate as the interrupted-request line (Theme.kt InterruptedBanner, hub SPEC
 *   §3.1), 336 dp at most so it stays clear of the QUESTS edge button.
 * - [ContentApplyButton]: the content APPLY door as a kit gold button.
 * - [LegacyPlacementBand]: the placement band (buildings/placement.png grammar: hint pill, shelf, red CANCEL, charcoal
 *   plate) for the drafts the designed band does not take (a wall stroke, a hero offer without its price words, a
 *   non-Shards build whose consent is still the tile dialog). It replaces the ink panel with Material text.
 */

/** One recovery door: [label] in the kit's PS caps, [verb] face, off (and silent, the plate says why) while not [enabled]. */
@Immutable internal data class RecoveryAction(val label: String, val onClick: () -> Unit, val enabled: Boolean = true,
    val verb: Verb = Verb.STONE, /** What a screen reader says (the old button's sentence-case words where they existed). */ val spoken: String = label)

/**
 * A recovery line on the kit herald plate: the queue mark, [title] in gold-hi, [lines] in VT, [details] (ids a player may
 * need to quote to support) selectable in muted VT, an optional [more] block, then the [actions]. [onDismiss] draws the
 * stone X; pass it only where the old card had one (a resolved receipt, never a pending money intent).
 *
 * Pointer rule: the plate is a painted panel (HeraldPlate registers its scene-input region); nothing else takes touches.
 */
@Composable internal fun RecoveryPlate(title: String, lines: List<String>, actions: List<RecoveryAction>, modifier: Modifier = Modifier,
    details: List<String> = emptyList(), onDismiss: (() -> Unit)? = null, dismissLabel: String = "Dismiss",
    more: (@Composable ColumnScope.() -> Unit)? = null) {
    HeraldPlate(modifier.padding(horizontal = 8.dp, vertical = 3.dp).semantics { liveRegion = LiveRegionMode.Polite }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon("ui:queue-status", 30.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(title, PkwTokens.Type.body, color = PkwTokens.Colors.gold.hi, maxLines = 2)
                lines.forEach { line -> PkwText(line, PkwTokens.Type.small, maxLines = 4) }
                if (details.isNotEmpty()) SelectionContainer {
                    Column { details.forEach { line -> PkwText(line, PkwTokens.Type.small, color = PkwTokens.Colors.muted, maxLines = 3) } }
                }
            }
            onDismiss?.let { IconSquare("shape:close", Verb.STONE, it, dismissLabel) }
        }
        more?.invoke(this)
        RecoveryActions(actions)
    }
}

/** Two short doors share a row (like the interrupted line's RETRY CHECK / TRY AGAIN); longer labels stack full width so a
 *  PS caption is never cut. */
@Composable private fun RecoveryActions(actions: List<RecoveryAction>) {
    if (actions.isEmpty()) return
    if (recoveryActionsInRow(actions.map { it.label })) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        actions.forEach { action -> SecondaryButton(action.label, action.onClick, Modifier.weight(1f), verb = action.verb, enabled = action.enabled,
            contentDescription = action.spoken) }
    } else Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        actions.forEach { action -> SecondaryButton(action.label, action.onClick, Modifier.fillMaxWidth(), verb = action.verb, enabled = action.enabled,
            contentDescription = action.spoken) }
    }
}

/** Whether the doors share one row: at most two, each at most [RECOVERY_ROW_LABEL_MAX] glyphs (half of a 336 dp plate). */
internal fun recoveryActionsInRow(labels: List<String>): Boolean =
    labels.size <= 2 && labels.all { it.length <= RECOVERY_ROW_LABEL_MAX }

internal const val RECOVERY_ROW_LABEL_MAX = 12

/** The content update's APPLY door (Copy.CONTENT_APPLY), a kit gold button at the herald plate's width. */
@Composable internal fun ContentApplyButton(busy: Boolean, onApply: () -> Unit) {
    SecondaryButton(Copy.CONTENT_APPLY.uppercase(), onApply,
        Modifier.padding(horizontal = 8.dp, vertical = 3.dp).widthIn(max = HERALD_PLATE_MAX_W).fillMaxWidth(),
        verb = Verb.GOLD, enabled = !busy)
}

/** A wall stroke's band lines, the words WallBatchDraft printed: the stroke and its price, the cap and balance, and
 *  whether the whole stroke is over either (release then submits nothing). Null while no stroke session is open. */
internal data class WallStrokeLines(val stroke: String, val budget: String, val exceeds: Boolean)

internal fun wallStrokeLines(state: WallBatchState): WallStrokeLines? {
    val drawing = state.drawing ?: return null
    val count = state.preview.size
    val cost = if (count == 0) "0" else runCatching { drawing.terms.cost(count) }.getOrNull()
    val available = drawing.availableShards.toLongOrNull()
    val exceeds = count > drawing.remaining || cost == null || available == null || cost.toLong() > available
    return WallStrokeLines(
        stroke = "$count walls · ${cost?.let(::fmtN) ?: "Amount too large"} SHARDS · ${fmtN(drawing.terms.unitCostShards)} each",
        budget = "${drawing.remaining} walls remaining in this base's cap · ${fmtN(drawing.availableShards)} SHARDS available",
        exceeds = exceeds)
}

/** The wall stroke guidance (WallBatchDraft's first line, unchanged). */
internal const val WALL_STROKE_HINT =
    "Draw walls with one finger. Release to build the whole green stroke. Pinch cancels the stroke and moves the camera."

/** The over-budget warning (WallBatchDraft's, unchanged). */
internal const val WALL_STROKE_EXCEEDS = "This entire stroke exceeds the cap or balance. Release will not submit a partial batch."

/**
 * The placement band for a draft the designed band (LivePlacementHost) does not take, in the placement.png grammar: the
 * hint pill under the resource stack, the shelf, red CANCEL (x 16, 68 dp) and the charcoal plate from x 98 to the right
 * gutter with [name] in gold-hi, [lines] and an optional [warning] in danger. There is no PLACE here: a wall stroke
 * submits on release (the hint says so) and the other drafts confirm on the tile dialog, which stays their consent.
 *
 * Pointer rule: the root is a full-size transparent layout with no pointer handling; the shelf and the pill are paint
 * only, so a drag or pinch anywhere else still reaches the kingdom. Only CANCEL and the plate take touches.
 */
@Composable internal fun LegacyPlacementBand(name: String, hint: String, lines: List<String>, warning: String?, onCancel: () -> Unit,
    modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val nav = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Box(modifier.fillMaxSize()) {
        // The hint pill (VT 20 on ink 86 %), under the resource stack so it never sits on the pills.
        Box(Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = LEGACY_BAND_HINT_TOP.dp, start = 16.dp, end = 16.dp)
            .background(c.ink.copy(alpha = 0.86f)).padding(horizontal = 12.dp, vertical = 4.dp)
            .clearAndSetSemantics { contentDescription = hint; liveRegion = LiveRegionMode.Polite }) {
            PkwText(hint, PkwTokens.Type.body, color = c.text, textAlign = TextAlign.Center, maxLines = 3)
        }
        // The shelf, as the command bar and the placement band draw it: ink 18 % for 16 dp, then 36 % with a 2 dp line.
        Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(163.dp + nav).drawBehind {
            val step = 16.dp.toPx()
            drawRect(c.ink.copy(alpha = 0.18f), Offset.Zero, Size(size.width, step))
            drawRect(c.ink.copy(alpha = PkwTokens.Scrim.COMMAND_SHELF), Offset(0f, step), Size(size.width, size.height - step))
            drawRect(c.ink.copy(alpha = 0.5f), Offset(0f, step), Size(size.width, 2.dp.toPx()))
        })
        Column(Modifier.align(Alignment.BottomStart).padding(start = 16.dp, bottom = nav + 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            ChunkyBox(c.red, onCancel, "Cancel placement", Modifier.size(PkwTokens.Dims.command)) {
                PkwIcon("shape:close", 36.dp, tint = c.label)
            }
            PkwText("CANCEL", PkwTokens.Type.caption, Modifier.padding(top = 5.dp), color = c.label, outline = 1.dp)
        }
        Plate(PlateKind.CHARCOAL, Modifier.align(Alignment.BottomStart).padding(start = 98.dp, end = 16.dp, bottom = nav + 37.dp)
            .fillMaxWidth().heightIn(min = 72.dp)
            .clearAndSetSemantics { contentDescription = (listOf(name) + lines + listOfNotNull(warning)).joinToString(". ") },
            contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(name, PkwTokens.Type.label, color = c.gold.hi, outline = 1.dp)
                lines.forEach { line -> PkwText(line, PkwTokens.Type.small, color = c.text, maxLines = 2) }
                warning?.let { PkwText(it, PkwTokens.Type.small, color = c.danger, maxLines = 3) }
            }
        }
    }
}

/** The band's hint pill top under the status bar: below the four-row resource stack (y 10..120), like the herald. */
internal const val LEGACY_BAND_HINT_TOP = 128

/** The band for the current legacy draft: a wall stroke ([wall] non-null) or another type named [name]. */
@Composable internal fun LegacyPlacementHost(type: String, name: String, wall: WallBatchState?, builderBusy: Boolean, onCancel: () -> Unit,
    modifier: Modifier = Modifier) {
    val ui = legacyPlacementBandUi(type, name, wall, builderBusy)
    LegacyPlacementBand(ui.name, ui.hint, ui.lines, ui.warning, onCancel, modifier)
}

/** What [LegacyPlacementBand] shows for a draft. Pure. */
internal data class LegacyPlacementBandUi(val name: String, val hint: String, val lines: List<String>, val warning: String?)

internal fun legacyPlacementBandUi(type: String, name: String, wall: WallBatchState?, builderBusy: Boolean): LegacyPlacementBandUi {
    if (type == "wall") {
        val stroke = wall?.let(::wallStrokeLines)
        return LegacyPlacementBandUi(name.uppercase(), WALL_STROKE_HINT, listOfNotNull(stroke?.stroke, stroke?.budget),
            if (stroke?.exceeds == true) WALL_STROKE_EXCEEDS else null)
    }
    // The old panel's words: where to tap, and the builder line (the band's own "No free builder" words).
    return LegacyPlacementBandUi(name.uppercase(), "Tap a location for $name. Pinch to zoom; drag to explore.", emptyList(),
        if (builderBusy) "No free builder" else null)
}

/**
 * Whether Home's recovery column shows: it steps aside with the top-left cluster while a building is selected or a
 * draft is being placed (buildings/SPEC.md §1.2 item 5, §4.1), so it never sits on the name plate or the placement hint
 * (owner screenshots 3 and 4). It returns, unchanged, the moment the selection or the draft ends.
 */
internal fun homeStatusShown(selected: Boolean, placing: Boolean): Boolean = !selected && !placing

/** The column's end inset: each plate pads 8 dp itself, so the plates end where the herald ends, clear of QUESTS. */
internal const val HOME_STATUS_END_DP = gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry.HERALD_END - 8

/** The Kingdom's open / load state ("Your base is loading", "Couldn’t open your kingdom.") on a kit charcoal plate, with a
 *  stone RETRY when there is a [retry]; was a bare Material line and a ghost button on the backdrop. */
@Composable internal fun KingdomOpenNotice(text: String, retry: (() -> Unit)?, busy: Boolean, modifier: Modifier = Modifier) {
    Plate(PlateKind.CHARCOAL, modifier.padding(24.dp).widthIn(max = HERALD_PLATE_MAX_W)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText(text, PkwTokens.Type.body, textAlign = TextAlign.Center, maxLines = 3)
            if (retry != null) SecondaryButton("RETRY", retry, enabled = !busy, contentDescription = "Retry")
        }
    }
}

/** A failed scene refresh over a kingdom still drawn: one kit toast when it fails (the base stays drawn), instead of a
 *  Material card left in the middle of the base. */
@Composable internal fun KingdomRefreshFailedToast(failed: Boolean) {
    androidx.compose.runtime.LaunchedEffect(failed) {
        if (failed) gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Couldn’t refresh your kingdom. Try again shortly.")
    }
}
