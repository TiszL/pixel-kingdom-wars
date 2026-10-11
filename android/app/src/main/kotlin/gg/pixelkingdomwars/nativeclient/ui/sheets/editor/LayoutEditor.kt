package gg.pixelkingdomwars.nativeclient.ui.sheets.editor

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.kit.stateRamp
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.abs
import kotlin.math.roundToInt

/*
 * Design component: the layout editor (DESIGN-SYSTEM §6 "Layout editor", editor.png; owner addenda 2-3; design correction 6).
 * The scene comes first: a 52 dp veil bar at the top (red X, "LAYOUT", the two layouts HOME and FARM; correction 6: the
 * wall stock is in the drag tooltip, not the bar), a one-line hint 8 dp under it, the live stroke tooltip floating above
 * the finger ("7 TO PLACE / 13 walls left", the count in the text colour; after the lift
 * it keeps the run's numbers and offers keep / drop), the selected-run nudge pad, and one compact tool row at the bottom:
 * WALLS, ERASE, MOVE, UNDO (red count badge) and one green SAVE with the change count. The drag itself is the scene's
 * (the same wall stroke sampler as BUILD); this file never reads a pointer except through its painted buttons.
 */

/** One layout slot button (the data lane's server slots: HOME and FARM). */
@Immutable data class LayoutSlotUi(
    /** The slot id handed back by [LayoutEditorActions.onSlot] ("HOME", "FARM"). */
    val id: String,
    /** The label on the button. */
    val label: String,
    /** False: the slot cannot be switched to now (locked, or the server has not offered it). */
    val enabled: Boolean = true,
)

/** One wall level the WALLS tool can paint (the tray's wall groups by level). */
@Immutable data class WallLevelUi(
    /** The wall level (handed back by [LayoutEditorActions.onPaintLevel]). */
    val level: Int,
    /** Its art (an existing GameArt name, e.g. `wall5_t3_straight_intact_f1`). */
    val art: String,
    /** How many of this level are in storage ("…" is not possible here: the tray is local, so it is always known). */
    val available: Int,
)

/** The live stroke (data lane `LayoutWallProposalUi` + whether it awaits the explicit confirm). */
@Immutable data class WallStrokeUi(
    /** Walls the stroke would place (WALLS) or put back (ERASE): the data lane's `affectedCount`. */
    val count: Int,
    /** Tiles the finger covered: `sampledCount` (more than [count] when the owned walls ran out). */
    val requested: Int,
    /** WALLS: owned walls of this level still in storage after this stroke (`wallsLeftAtLevel`); null when unknown. */
    val wallsLeft: Int?,
    /** True after the finger lifted: the run waits for keep (confirm) or drop (cancel); nothing is in the draft yet. */
    val pending: Boolean,
    /** Where the finger is (or where the run ended), in window px; null floats the tooltip above the tool strip. */
    val anchor: IntOffset? = null,
)

/** Everything the editor chrome draws. Counts arrive from the data lane; null is unknown and draws "…", never 0. */
@Immutable data class LayoutEditorUi(
    /** HOME and FARM (data lane `slotIds`). */
    val slots: List<LayoutSlotUi>,
    /** The slot being edited (`activeSlot`). */
    val activeSlot: String,
    /** Walls the player owns (`ownedWallCount`). */
    val ownedWalls: Int?,
    /** Owned walls in storage (`trayedWallCount`). */
    val trayedWalls: Int?,
    /** The tool (data lane PAINT → WALLS, ERASE → ERASE, SELECT → MOVE); null = no tool, the drag pans the camera. */
    val tool: EditorTool?,
    /** The wall level WALLS paints (`paintLevel`). */
    val paintLevel: Int?,
    /** The levels in storage; a picker shows above the strip while WALLS is on and there is more than one. */
    val wallLevels: List<WallLevelUi>,
    /** The art on the WALLS tool and in the tooltip (the paint level's wall). */
    val wallArt: String,
    /** The live stroke, or null. */
    val stroke: WallStrokeUi?,
    /** Walls in the selected run (`selectedRunCount`); > 0 shows the move pad. */
    val selectedRunCount: Int,
    /** Confirmed steps UNDO can pop (`undoCount`); the badge. */
    val undoCount: Int,
    /** Changes against the saved layout (`changeCount`). */
    val changeCount: Int,
    /** The server allows a save of this draft (`canSave`). */
    val canSave: Boolean,
    /** Why SAVE is off when [canSave] is false (e.g. "Place the Keep first"); spoken and shown in the pill on tap. */
    val saveBlockedReason: String? = null,
    /** Where the save stands. */
    val saveState: EditorSaveState = EditorSaveState.IDLE,
    /** An explicit wall-operation refusal (`refusal`), shown in the pill in the danger colour. */
    val refusal: String? = null,
    /** Informational / success copy (`notice`). */
    val notice: String? = null,
    /** First use: show the hint pill. */
    val showHint: Boolean = true,
    /** The discard confirm is up (the data lane's `discardOpen`). */
    val discardOpen: Boolean = false,
    /** The owner may have drafts in more than the displayed slot. */
    val discardMessage: String? = null,
)

/** The editor's callbacks; names follow the data lane's `LayoutEditorViewModel` (see MOUNT-EDITOR.md). */
class LayoutEditorActions(
    /** Red X / Back: `close()` (it raises the discard confirm itself when the draft is dirty). */
    val onClose: () -> Unit,
    /** HOME / FARM: `selectSlot(id)`. */
    val onSlot: (String) -> Unit,
    /** WALLS: `setWallTool(PAINT)`. */
    val onPaint: () -> Unit,
    /** ERASE: `setWallTool(ERASE)`. */
    val onErase: () -> Unit,
    /** MOVE: `setWallTool(SELECT)` (drag along a run to select it). */
    val onSelectRun: () -> Unit,
    /** The active tool tapped again, or the move pad's X: `clearWallPaint()` (no tool: the drag pans the camera). */
    val onPan: () -> Unit,
    /** A wall level chip: `toggleWallPaint(level)`. */
    val onPaintLevel: (Int) -> Unit,
    /** Keep the lifted run: `confirmWallStroke()` (one undo step; nothing is saved until SAVE). */
    val onConfirm: () -> Unit,
    /** Drop the lifted run: `cancelWallStroke()`. */
    val onCancel: () -> Unit,
    /** UNDO: `undo()` (pops the last confirmed run, or drops a pending one). */
    val onUndo: () -> Unit,
    /** The move pad: `moveSelectedWallRun(dx, dy)`. */
    val onMove: (dx: Int, dy: Int) -> Unit,
    /** SAVE: `save(...)`. Only called when [saveLook] says it sends. */
    val onSave: () -> Unit,
    /** The discard confirm's DISCARD: `confirmDiscard()`. */
    val onConfirmDiscard: () -> Unit,
    /** The discard confirm's KEEP EDITING, its scrim, Back: `cancelDiscard()`. */
    val onCancelDiscard: () -> Unit,
    /** "BUILD more" when the owned walls ran out: navigation to the BUILD tray's walls (never a purchase here). */
    val onBuildMore: () -> Unit = {},
    /** A tap on an off SAVE: show this sentence (toast). */
    val onExplain: (String) -> Unit = {},
    /** A tap on HOME / FARM that cannot switch now (locked, a lifted run, an action in flight): the slot id. The bar keeps
     *  the button tappable so it is never a dead door; the default only says so. */
    val onSlotRefused: (String) -> Unit = { onExplain("That layout can't be opened right now") },
)

/** The editor's cool tint (DESIGN-SYSTEM: "a 18 % cool tint ... fade in (220 ms)"). */
private val EDITOR_TINT = Color(0x2E141E28)
/** The tool strip's shelf (editor.html `rgba(16,14,20,.40)`). */
private val SHELF = Color(0x66100E14)
private val TOP_BAR_H = 52.dp
/** The hint pill's gap under the bar (editor.html: bar 8..60, pill at 68). */
private val PILL_GAP = 8.dp
/** The tool faces stand this far below SAVE's top (editor.html: SAVE at 826, faces at 836). */
private val TOOL_DROP = 10.dp
private val TOOL_FACE = 56.dp
private val SAVE_H = 72.dp
/** Tool row height incl. captions (editor.png ~89 dp). */
private val STRIP_H = 89.dp

/**
 * The layout editor chrome over the live kingdom (editor.png). Enter: the tint fades in and the bar drops 8 dp in 220 ms
 * (`out`); the tool strip rises from below in the same 220 ms. Reduced motion: a 120 ms cross-fade, nothing slides.
 *
 * Pointer rule: the root is a full-size, transparent layout with NO clickable, pointerInput, draggable or scrim; the tint
 * and the shelf are paint only. Only the painted top bar, its buttons, the tool buttons, SAVE, the lifted run's keep / drop
 * plate and the move pad take touches, so a drag anywhere else reaches the scene (paint, erase, select, pan, pinch). The
 * live tooltip during a drag is paint only (it must not fence the finger's stroke). The one scrim is the discard
 * confirm's, composed only while [LayoutEditorUi.discardOpen].
 */
@Composable fun LayoutEditor(ui: LayoutEditorUi, on: LayoutEditorActions, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    val enter = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        enter.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.EDITOR_ENTER, easing = PkwTokens.Motion.Out))
    }
    val nav = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val pending = ui.stroke?.pending == true
    val idle = ui.saveState == EditorSaveState.IDLE && !ui.discardOpen
    val lit = activeTool(ui.tool, ui.selectedRunCount)

    BoxWithConstraints(modifier.fillMaxSize().drawBehind { drawRect(EDITOR_TINT, alpha = enter.value) }) {
        // Top: the bar, then one pill (refusal > notice > first-use hint).
        Column(Modifier.align(Alignment.TopCenter).fillMaxWidth().statusBarsPadding().padding(start = 8.dp, top = 8.dp, end = 8.dp)
            .graphicsLayer {
                alpha = enter.value
                if (!reduced) translationY = (1f - enter.value) * -8.dp.toPx()
            }, horizontalAlignment = Alignment.CenterHorizontally) {
            EditorTopBar(ui, on, slotsEnabled = idle && !pending)
            Spacer(Modifier.height(PILL_GAP))
            val pill = ui.refusal ?: ui.notice ?: if (ui.showHint || pending || ui.selectedRunCount > 0) editorHint(ui.tool, ui.selectedRunCount, pending) else null
            if (pill != null) HintPill(pill, danger = ui.refusal != null)
        }

        // The live tooltip / lifted run plate (floats above the finger).
        val stroke = ui.stroke
        val tip = stroke?.let { strokeTooltip(ui.tool ?: EditorTool.WALLS, it.count, it.requested, it.wallsLeft) }
        if (stroke != null && tip != null) {
            StrokeTooltipLayer(stroke, tip, ui.wallArt, on, topLimit = top + 8.dp + TOP_BAR_H + PILL_GAP + 34.dp + 6.dp,
                bottomLimit = nav + STRIP_H + 16.dp)
        }

        // Why the pad and the level chips wait while a save is in flight (they answer a tap with it).
        val waitReason = toolRefusal(undo = false, undoCount = ui.undoCount, strokePending = pending, save = ui.saveState, discardOpen = ui.discardOpen)

        // The selected run's move pad, above the strip.
        if (ui.selectedRunCount > 0 && !pending) {
            MovePad(ui.selectedRunCount, on, enabled = idle, waitReason, Modifier.align(Alignment.BottomCenter).padding(bottom = nav + STRIP_H + 16.dp))
        }

        // Wall level picker (only while WALLS is on and there is a choice).
        if (ui.tool == EditorTool.WALLS && ui.wallLevels.size > 1 && !pending) {
            LevelPicker(ui.wallLevels, ui.paintLevel, on.onPaintLevel, enabled = idle, waitReason, on.onExplain,
                Modifier.align(Alignment.BottomStart).padding(start = 4.dp, bottom = nav + STRIP_H + 12.dp))
        }

        // The tool strip.
        val widths = toolStripWidths(maxWidth.value)
        Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().graphicsLayer {
            if (reduced) { alpha = enter.value } else { translationY = (1f - enter.value) * (STRIP_H + nav).toPx() }
        }) {
            // The shelf starts level with SAVE's top (editor.html: both at 826).
            Box(Modifier.align(Alignment.BottomStart).shelf(STRIP_H + nav + 8.dp))
            ToolStrip(ui, on, lit, pending, idle, widths, Modifier.align(Alignment.BottomStart).padding(start = 4.dp, end = 8.dp, bottom = nav + 6.dp))
        }

        if (ui.discardOpen) {
            ModalScrim(PkwTokens.Scrim.SEAL, on.onCancelDiscard)
            DiscardConfirm(ui, on, Modifier.align(Alignment.Center))
        }
    }
}

/** The shelf under the strip: paint only, no pointer handling (KIT-API: "The shelf is paint only"). */
private fun Modifier.shelf(height: Dp): Modifier = this.fillMaxWidth().height(height).background(SHELF)

/**
 * The 52 dp veil bar (editor.html): red X, "LAYOUT" (PS 12; the wall stock is spoken only, the tooltip shows it while
 * painting), HOME / FARM 84 wide (48 tall: the tap-target floor). A slot that cannot switch now stays tappable and says
 * why ([LayoutEditorActions.onSlotRefused]); the active one is the current state.
 */
@Composable private fun EditorTopBar(ui: LayoutEditorUi, on: LayoutEditorActions, slotsEnabled: Boolean) {
    val c = PkwTokens.Colors
    Plate(PlateKind.VEIL, Modifier.fillMaxWidth().height(TOP_BAR_H), contentPadding = PaddingValues(horizontal = 4.dp, vertical = 2.dp)) {
        Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CloseSquare(on.onClose, contentDescription = "Close the layout editor")
            val count = wallCountLine(ui.ownedWalls, ui.trayedWalls)
            Box(Modifier.weight(1f).padding(start = 4.dp).semantics(mergeDescendants = true) { heading(); contentDescription = "Layout. $count" }) {
                PkwText("LAYOUT", PkwTokens.Type.label, color = c.label, outline = 1.dp)
            }
            ui.slots.forEach { slot ->
                val active = slot.id == ui.activeSlot
                val can = slotsEnabled && slot.enabled && !active
                ChunkyBox(PkwTokens.ramp(if (active) Verb.GOLD else Verb.CHARCOAL),
                    { if (can) on.onSlot(slot.id) else if (!active) on.onSlotRefused(slot.id) },
                    if (active) "${slot.label} layout, editing" else "Edit the ${slot.label} layout",
                    Modifier.size(width = 84.dp, height = 48.dp)) {
                    PkwText(slot.label, PkwTokens.Type.label, color = if (slot.enabled || active) c.label else c.muted, outline = 1.dp)
                }
            }
        }
    }
}

/** The ink 86 % hint / notice / refusal pill (VT 20). Paint only; announced politely. */
@Composable private fun HintPill(text: String, danger: Boolean) {
    val c = PkwTokens.Colors
    Box(Modifier.background(c.ink.copy(alpha = 0.86f), PixelShapes.S).padding(start = 12.dp, top = 5.dp, end = 12.dp, bottom = 4.dp)
        .clearAndSetSemantics { contentDescription = text; liveRegion = LiveRegionMode.Polite }) {
        PkwText(text, PkwTokens.Type.body, color = if (danger) c.danger else c.text, textAlign = TextAlign.Center, maxLines = 2)
    }
}

/**
 * The stroke plate, placed by [tooltipTopLeft] about 40 dp above the finger with a 4 × 18 ink stem down to it. While the
 * finger is down it is paint only (never a scene-input region, so it cannot fence the stroke); once the run is lifted
 * ([WallStrokeUi.pending]) it becomes a painted panel with DROP (red) and KEEP (green) and, when the walls ran out, BUILD more.
 */
@Composable private fun StrokeTooltipLayer(stroke: WallStrokeUi, tip: StrokeTooltip, wallArt: String, on: LayoutEditorActions,
    topLimit: Dp, bottomLimit: Dp) {
    val c = PkwTokens.Colors
    val headColour = if (tip.out) c.danger else if (tip.headline.endsWith("REMOVE")) c.red.hi else c.green.hi
    Layout(content = {
        Plate(PlateKind.CHARCOAL, Modifier.widthIn(max = 380.dp).semantics(mergeDescendants = !stroke.pending) {
            contentDescription = "${tip.headline}. ${tip.detail}"; liveRegion = LiveRegionMode.Polite
        }, contentPadding = PaddingValues(start = 8.dp, top = 6.dp, end = 8.dp, bottom = 8.dp), blocksScene = stroke.pending) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwIcon(wallArt, 32.dp)
                Column {
                    PkwText(tip.headline, PkwTokens.Type.title, color = headColour, outline = 1.dp)
                    // editor.png: "13 walls left" with the count in the text colour; "0 left" stays all danger.
                    val split = if (tip.out) null else leadingCount(tip.detail)
                    if (split == null) PkwText(tip.detail, PkwTokens.Type.body, color = if (tip.out) c.danger else c.muted)
                    else Row {
                        PkwText(split.first, PkwTokens.Type.body, color = c.text)
                        PkwText(split.second, PkwTokens.Type.body, color = c.muted)
                    }
                }
                if (stroke.pending) {
                    if (tip.out) QuietButton("BUILD more", on.onBuildMore, contentDescription = "Build more walls")
                    IconSquare("shape:close", Verb.RED, on.onCancel, "Drop this run")
                    IconSquare("shape:check", Verb.GREEN, on.onConfirm, "Keep this run")
                }
            }
        }
        Box(Modifier.size(4.dp, 18.dp).background(c.ink))
    }, modifier = Modifier.fillMaxSize()) { measurables, constraints ->
        val free = Constraints(maxWidth = constraints.maxWidth, maxHeight = constraints.maxHeight)
        val plate = measurables[0].measure(free)
        val stem = measurables[1].measure(Constraints())
        val w = constraints.maxWidth.toFloat(); val h = constraints.maxHeight.toFloat()
        val anchor = stroke.anchor
        val margin = 8.dp.toPx()
        val ax = anchor?.x?.toFloat() ?: (w / 2f)
        val ay = anchor?.y?.toFloat() ?: (h - bottomLimit.toPx())
        val lift = if (anchor != null) 40.dp.toPx() else 0f
        val (x, y) = tooltipTopLeft(ax, ay, plate.width.toFloat(), plate.height.toFloat(), lift, margin, w - margin,
            topLimit.toPx(), h - bottomLimit.toPx())
        val stemShown = anchor != null && abs(y + plate.height - (ay - lift)) < 1f
        layout(constraints.maxWidth, constraints.maxHeight) {
            plate.place(x.roundToInt(), y.roundToInt())
            if (stemShown) stem.place((ax - stem.width / 2f).roundToInt(), (y + plate.height).roundToInt())
        }
    }
}

/** The selected run's pad: "n WALLS" + "tap a tile to move", ← ↑ ↓ → (one tile each) and X (deselect). While a save is in
 *  flight the buttons draw off and answer a tap with [reason]. */
@Composable private fun MovePad(count: Int, on: LayoutEditorActions, enabled: Boolean, reason: String, modifier: Modifier) {
    val c = PkwTokens.Colors
    Plate(PlateKind.CHARCOAL, modifier, contentPadding = PaddingValues(start = 8.dp, top = 6.dp, end = 8.dp, bottom = 10.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }) {
                PkwText(if (count == 1) "1 WALL" else "$count WALLS", PkwTokens.Type.title, color = c.gold.hi, outline = 1.dp)
                PkwText("tap a tile to move", PkwTokens.Type.body, color = c.muted)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                NUDGE_STEPS.forEach { (dx, dy, turns) ->
                    ChunkyBox(PkwTokens.ramp(if (enabled) Verb.STONE else Verb.OFF), { if (enabled) on.onMove(dx, dy) else on.onExplain(reason) },
                        nudgeDescription(dx, dy), Modifier.size(PkwTokens.Dims.minTap), stateDescription = if (enabled) null else reason) {
                        EditorGlyph(arrowGlyph(turns), 24.dp, c.label)
                    }
                }
                Spacer(Modifier.width(8.dp))
                ChunkyBox(PkwTokens.ramp(if (enabled) Verb.RED else Verb.OFF), { if (enabled) on.onPan() else on.onExplain(reason) },
                    "Let go of the run", Modifier.size(PkwTokens.Dims.minTap), stateDescription = if (enabled) null else reason) {
                    PkwIcon("shape:close", 24.dp, tint = c.label)
                }
            }
        }
    }
}

/** The wall level chips (each 64 × 48: wall art + "×n" in storage). A chip that cannot be picked (none in storage, or a
 *  save in flight: [reason]) draws off and says why on a tap. */
@Composable private fun LevelPicker(levels: List<WallLevelUi>, selected: Int?, onPick: (Int) -> Unit, enabled: Boolean, reason: String,
    onExplain: (String) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        levels.forEach { level ->
            val on = level.level == selected
            val why = when { !enabled -> reason; level.available <= 0 -> "No level ${level.level} walls in storage"; else -> null }
            ChunkyBox(PkwTokens.ramp(if (why != null) Verb.OFF else if (on) Verb.GOLD else Verb.STONE),
                { if (why == null) onPick(level.level) else onExplain(why) },
                "Level ${level.level} walls, ${level.available} in storage${if (on) ", painting" else ""}",
                Modifier.size(width = 64.dp, height = 48.dp), stateDescription = why) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    PkwIcon(level.art, 24.dp)
                    PkwText("×${level.available}", PkwTokens.Type.caption, color = c.label, outline = 1.dp)
                }
            }
        }
    }
}

/** WALLS, ERASE, MOVE, UNDO (4 dp apart) and SAVE. */
@Composable private fun ToolStrip(ui: LayoutEditorUi, on: LayoutEditorActions, lit: EditorTool?, pending: Boolean, idle: Boolean,
    widths: ToolStripWidths, modifier: Modifier) {
    val c = PkwTokens.Colors
    val cell = widths.cell.dp
    val toolsOn = idle && !pending
    fun pick(tool: EditorTool, action: () -> Unit): () -> Unit = { if (lit == tool) on.onPan() else action() }
    val toolReason = toolRefusal(undo = false, undoCount = ui.undoCount, strokePending = pending, save = ui.saveState, discardOpen = ui.discardOpen)
    // editor.html: SAVE's top is the strip's top; the tool faces stand TOOL_DROP lower, captions under them.
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        ToolButton("WALLS", lit == EditorTool.WALLS, toolsOn, null, "Paint walls", cell, pick(EditorTool.WALLS, on.onPaint), toolReason, on.onExplain) {
            PkwIcon(ui.wallArt, 40.dp)
        }
        Spacer(Modifier.width(4.dp))
        ToolButton("ERASE", lit == EditorTool.ERASE, toolsOn, null, "Erase walls", cell, pick(EditorTool.ERASE, on.onErase), toolReason, on.onExplain) {
            EditorGlyph(GLYPH_ERASE, 32.dp, ERASER_PINK)
        }
        Spacer(Modifier.width(4.dp))
        ToolButton("MOVE", lit == EditorTool.MOVE, toolsOn, null, "Move a wall run", cell, pick(EditorTool.MOVE, on.onSelectRun), toolReason, on.onExplain) {
            EditorGlyph(GLYPH_MOVE, 32.dp, c.label)
        }
        Spacer(Modifier.width(4.dp))
        val undoOn = undoEnabled(ui.undoCount, pending, ui.saveState) && !ui.discardOpen
        ToolButton("UNDO", false, undoOn, badgeCount(ui.undoCount), "Undo the last run. ${ui.undoCount} to undo", cell, on.onUndo,
            toolRefusal(undo = true, undoCount = ui.undoCount, strokePending = pending, save = ui.saveState, discardOpen = ui.discardOpen), on.onExplain) {
            EditorGlyph(GLYPH_UNDO, 32.dp, c.label)
        }
        Spacer(Modifier.weight(1f).widthIn(min = 6.dp))
        val look = saveLook(ui.changeCount, ui.canSave, pending, ui.saveState, ui.saveBlockedReason)
        SaveButton(look, widths.save.dp) { if (look.sends) on.onSave() else if (look.state != CommandState.BUSY) on.onExplain(look.spoken) }
    }
}

/**
 * A 56 dp tool face (gold when on, stone, off when it cannot act), its PS caption 3 dp below, an optional red count badge
 * (editor.html: 4 dp past the face's right edge, 8 dp above it). An off tool still answers a tap with [reason] through
 * [onExplain], so it is never a dead door.
 */
@Composable private fun ToolButton(label: String, active: Boolean, enabled: Boolean, badge: String?, description: String, cell: Dp,
    onClick: () -> Unit, reason: String, onExplain: (String) -> Unit, icon: @Composable () -> Unit) {
    val c = PkwTokens.Colors
    Column(Modifier.width(cell).padding(top = TOOL_DROP), horizontalAlignment = Alignment.CenterHorizontally) {
        Box {
            ChunkyBox(PkwTokens.ramp(if (!enabled) Verb.OFF else if (active) Verb.GOLD else Verb.STONE),
                { if (enabled) onClick() else onExplain(reason) },
                if (active) "$description, on" else description, Modifier.size(TOOL_FACE),
                stateDescription = if (enabled) null else reason) { icon() }
            if (badge != null) Badge(BadgeUi(badge, BadgeTone.COUNT, "$badge to undo"), Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-8).dp))
        }
        PkwText(label, PkwTokens.Type.caption, Modifier.padding(top = 3.dp), color = c.label, outline = 1.dp)
    }
}

/** The green SAVE (126 × 72): PS "SAVE" over the VT sub-line; stone dots while saving or being checked; off with a reason. */
@Composable private fun SaveButton(look: SaveLook, width: Dp, onClick: () -> Unit) {
    val c = PkwTokens.Colors
    ChunkyBox(stateRamp(Verb.GREEN, look.state), onClick, look.spoken, Modifier.size(width, SAVE_H), enabled = look.state != CommandState.BUSY) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (look.state == CommandState.BUSY) BusyDots()
            else PkwText("SAVE", PkwTokens.Type.primary, color = if (look.state == CommandState.DISABLED) c.text else c.label, outline = 2.dp)
            PkwText(look.sub, PkwTokens.Type.small, color = c.label, outline = 1.dp)
        }
    }
}

/** "Discard changes?" with KEEP EDITING (stone) and DISCARD (red). The saved layout is not touched. */
@Composable private fun DiscardConfirm(ui: LayoutEditorUi, on: LayoutEditorActions, modifier: Modifier) {
    val c = PkwTokens.Colors
    Plate(PlateKind.CHARCOAL, modifier.padding(horizontal = 24.dp).widthIn(max = 360.dp)) {
        Column(Modifier.padding(6.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            PkwText("DISCARD CHANGES?", PkwTokens.Type.title, Modifier.semantics { heading() }, color = c.gold.hi, outline = 1.dp)
            PkwText(ui.discardMessage ?: ("${changesLabel(ui.changeCount).replaceFirstChar { it.uppercase() }} to ${ui.activeSlot} will be lost. " +
                "Your saved layout stays as it was."), PkwTokens.Type.body, color = c.text, maxLines = 3)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("KEEP EDITING", on.onCancelDiscard, Modifier.weight(1f))
                SecondaryButton("DISCARD", on.onConfirmDiscard, Modifier.weight(1f), verb = Verb.RED, contentDescription = "Discard the changes")
            }
        }
    }
}

// ---- Previews (sample data only; the real Ui comes from Codex's mapper) ----

private val previewActions = LayoutEditorActions(onClose = {}, onSlot = {}, onPaint = {}, onErase = {}, onSelectRun = {}, onPan = {},
    onPaintLevel = {}, onConfirm = {}, onCancel = {}, onUndo = {}, onMove = { _, _ -> }, onSave = {}, onConfirmDiscard = {}, onCancelDiscard = {})

private val sampleEditor = LayoutEditorUi(
    slots = listOf(LayoutSlotUi("HOME", "HOME"), LayoutSlotUi("FARM", "FARM")), activeSlot = "HOME",
    ownedWalls = 34, trayedWalls = 20, tool = EditorTool.WALLS, paintLevel = 3,
    wallLevels = listOf(WallLevelUi(3, "wall5_t3_straight_intact_f1", 20)), wallArt = "wall5_t3_straight_intact_f1",
    stroke = WallStrokeUi(count = 7, requested = 7, wallsLeft = 13, pending = false, anchor = IntOffset(708, 1132)),
    selectedRunCount = 0, undoCount = 2, changeCount = 2, canSave = true,
)

@Composable private fun EditorPreviewFrame(ui: LayoutEditorUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) { LayoutEditor(ui, previewActions) }
}

@Preview(name = "Editor: painting, live count (editor.png)", widthDp = 412, heightDp = 915)
@Composable private fun EditorPaintingPreview() = EditorPreviewFrame(sampleEditor)

@Preview(name = "Editor: run lifted, keep or drop", widthDp = 412, heightDp = 915)
@Composable private fun EditorPendingPreview() = EditorPreviewFrame(sampleEditor.copy(stroke = sampleEditor.stroke?.copy(pending = true)))

@Preview(name = "Editor: out of owned walls", widthDp = 412, heightDp = 915)
@Composable private fun EditorOutPreview() = EditorPreviewFrame(sampleEditor.copy(trayedWalls = 0,
    stroke = WallStrokeUi(count = 4, requested = 9, wallsLeft = 0, pending = true, anchor = IntOffset(400, 1000))))

@Preview(name = "Editor: erase", widthDp = 412, heightDp = 915)
@Composable private fun EditorErasePreview() = EditorPreviewFrame(sampleEditor.copy(tool = EditorTool.ERASE,
    stroke = WallStrokeUi(count = 5, requested = 6, wallsLeft = null, pending = false, anchor = IntOffset(300, 900))))

@Preview(name = "Editor: run selected, move pad", widthDp = 412, heightDp = 915)
@Composable private fun EditorMovePreview() = EditorPreviewFrame(sampleEditor.copy(tool = null, stroke = null, selectedRunCount = 6))

@Preview(name = "Editor: no tool, two levels, nothing to save", widthDp = 412, heightDp = 915)
@Composable private fun EditorIdlePreview() = EditorPreviewFrame(sampleEditor.copy(stroke = null, undoCount = 0, changeCount = 0,
    wallLevels = listOf(WallLevelUi(2, "wall5_t2_straight_intact_f1", 6), WallLevelUi(3, "wall5_t3_straight_intact_f1", 14)), showHint = false))

@Preview(name = "Editor: saving, then answer lost (being checked)", widthDp = 412, heightDp = 915)
@Composable private fun EditorCheckingPreview() = EditorPreviewFrame(sampleEditor.copy(stroke = null, saveState = EditorSaveState.CHECKING,
    notice = "Checking whether the layout was saved."))

@Preview(name = "Editor: refusal + counts unknown", widthDp = 412, heightDp = 915)
@Composable private fun EditorRefusalPreview() = EditorPreviewFrame(sampleEditor.copy(stroke = null, ownedWalls = null, trayedWalls = null,
    refusal = "WALL STROKE CHANGED — TRY AGAIN", canSave = false, saveBlockedReason = "Place the Keep first"))

@Preview(name = "Editor: discard confirm", widthDp = 412, heightDp = 915)
@Composable private fun EditorDiscardPreview() = EditorPreviewFrame(sampleEditor.copy(stroke = null, discardOpen = true))

@Preview(name = "Editor: narrow phone (360 dp)", widthDp = 360, heightDp = 780)
@Composable private fun EditorNarrowPreview() = EditorPreviewFrame(sampleEditor)
