package gg.pixelkingdomwars.nativeclient.ui.sheets.editor

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState

/*
 * Design component: the pure rules of the layout editor (DESIGN-SYSTEM §6 "Layout editor", editor.png, design correction 6,
 * owner addenda 2-3): the top bar's wall count, the SAVE look, the live stroke tooltip's words, the hint line, where the
 * tooltip floats, the tool strip widths on narrow phones, and the glyph rotation the nudge arrows use. No Compose;
 * JVM-tested in `EditorLogicTest`. Composables only call these; the mapper (Codex) may call them too.
 */

/** The three tools tonight (design correction 6). GROUP / box-select and ROTATE are a later addition and are not here. */
enum class EditorTool {
    /** Paint owned walls along a drag (data lane `LayoutWallTool.PAINT`). */
    WALLS,
    /** Drag across walls to put them back in storage (`LayoutWallTool.ERASE`). */
    ERASE,
    /** Drag along a wall run to select it, then tap a tile or nudge to move it (`LayoutWallTool.SELECT`). */
    MOVE,
}

/** Where SAVE stands. CHECKING is the uncertain outcome (a lost answer): it is never re-sendable (design correction 7). */
enum class EditorSaveState { IDLE, SAVING, CHECKING }

/** The top bar's second line: "34 walls · 6 stored". Unknown counts are "…", never 0. */
fun wallCountLine(owned: Int?, trayed: Int?): String {
    val o = owned?.takeIf { it >= 0 }?.let { if (it == 1) "1 wall" else "$it walls" } ?: "$UNKNOWN walls"
    val t = trayed?.takeIf { it >= 0 }?.let { "$it stored" } ?: "$UNKNOWN stored"
    return "$o · $t"
}

/** SAVE's sub-line: "1 change", "2 changes". */
fun changesLabel(count: Int): String = if (count == 1) "1 change" else "${count.coerceAtLeast(0)} changes"

/** How SAVE draws and whether a tap may save. [sub] is the VT line inside the button (≤ 13 glyphs at 126 dp). */
data class SaveLook(val state: CommandState, val sub: String, val sends: Boolean, val spoken: String)

/**
 * SAVE (editor.png: green 126 × 72, "n changes"). It saves only with changes, no unconfirmed stroke (the data lane's save
 * rejects pending wall proposals), the server's go-ahead ([canSave]) and nothing in flight. A lost answer ([EditorSaveState.CHECKING])
 * keeps dots and says it is being checked; it never offers a second save until the server says what happened.
 */
fun saveLook(changeCount: Int, canSave: Boolean, strokePending: Boolean, save: EditorSaveState, blockedReason: String? = null): SaveLook = when {
    save == EditorSaveState.SAVING -> SaveLook(CommandState.BUSY, "saving", false, "Saving the layout")
    save == EditorSaveState.CHECKING -> SaveLook(CommandState.BUSY, "checking", false, "Checking whether the layout was saved")
    strokePending -> SaveLook(CommandState.DISABLED, "confirm run", false, "Keep or drop the wall run before saving")
    changeCount <= 0 -> SaveLook(CommandState.DISABLED, "no changes", false, "Nothing to save yet")
    !canSave -> SaveLook(CommandState.DISABLED, "can't save", false, blockedReason?.takeIf { it.isNotBlank() } ?: "This layout can't be saved yet")
    else -> changesLabel(changeCount).let { SaveLook(CommandState.ENABLED, it, true, "Save layout, $it") }
}

/** The live stroke tooltip (editor.png "7 TO PLACE / 13 walls left"). [out] turns the count red: no owned walls left. */
data class StrokeTooltip(val headline: String, val detail: String, val out: Boolean)

/**
 * The tooltip's words for a stroke of [count] affected walls out of [requested] sampled tiles (design correction 6: walls
 * to place and walls left only; no "blocked" figure, the server's is unknown). ERASE says the walls go back to storage.
 * MOVE (selection) and no tool have no tooltip: null.
 */
fun strokeTooltip(tool: EditorTool?, count: Int, requested: Int, wallsLeft: Int?): StrokeTooltip? = when (tool) {
    EditorTool.WALLS -> {
        val out = wallsLeft == 0
        val detail = when {
            wallsLeft == null -> "$UNKNOWN walls left"
            out && requested > count -> "0 left · BUILD more"
            wallsLeft == 1 -> "1 wall left"
            else -> "$wallsLeft walls left"
        }
        StrokeTooltip("${count.coerceAtLeast(0)} TO PLACE", detail, out)
    }
    EditorTool.ERASE -> StrokeTooltip("${count.coerceAtLeast(0)} TO REMOVE", "back to storage", false)
    EditorTool.MOVE, null -> null
}

/** The tool the strip lights: the data lane drops the SELECT tool once a run is picked, but MOVE is still what the player is doing. */
fun activeTool(tool: EditorTool?, selectedRunCount: Int): EditorTool? = tool ?: if (selectedRunCount > 0) EditorTool.MOVE else null

/** The one-line hint pill under the top bar (editor.png "Drag across tiles to paint walls you own"). */
fun editorHint(tool: EditorTool?, selectedRunCount: Int, strokePending: Boolean): String = when {
    strokePending -> "Keep this run or drop it"
    selectedRunCount > 0 -> "Tap a tile to move the run"
    tool == EditorTool.WALLS -> "Drag across tiles to paint walls you own"
    tool == EditorTool.ERASE -> "Drag across walls to put them in storage"
    tool == EditorTool.MOVE -> "Drag along a wall run to pick it up"
    else -> "Pick a tool. Drag the ground to look around"
}

/** UNDO works when there is a confirmed step to pop, or a pending run to drop (the data lane's undo cancels it first). */
fun undoEnabled(undoCount: Int, strokePending: Boolean, save: EditorSaveState): Boolean =
    save == EditorSaveState.IDLE && (undoCount > 0 || strokePending)

/**
 * What an off tool says when tapped (an off button is never a dead door): a save in flight first (in SAVE's own words),
 * then the discard confirm, then a lifted run (the paint tools wait for keep / drop; UNDO drops it, so it is not refused
 * for that), then UNDO with nothing to pop.
 */
fun toolRefusal(undo: Boolean, undoCount: Int, strokePending: Boolean, save: EditorSaveState, discardOpen: Boolean): String = when {
    save == EditorSaveState.SAVING -> "Saving the layout"
    save == EditorSaveState.CHECKING -> "Checking whether the layout was saved"
    discardOpen -> "Finish the discard confirmation first"
    !undo && strokePending -> "Keep or drop the wall run first"
    undo && undoCount <= 0 && !strokePending -> "Nothing to undo yet"
    else -> "Not available right now"
}

/** Why a HOME / FARM tap did not switch layouts: a locked layout points at its unlock, a lifted run must be kept or
 *  dropped first, anything else waits for the action in flight. */
fun slotRefusal(label: String, locked: Boolean, strokePending: Boolean): String = when {
    locked -> "$label is locked. Unlock it in BUILDINGS & PRESETS"
    strokePending -> "Keep or drop the wall run first"
    else -> "Finish the current layout action first"
}

/** The tooltip detail's leading count and the rest ("13 walls left" → "13", " walls left"), so the count can take the
 *  text colour as editor.png draws it; null when the line does not start with a number ("… walls left"). */
fun leadingCount(detail: String): Pair<String, String>? {
    val count = detail.takeWhile { it.isDigit() || it == ',' }
    if (count.isEmpty() || !count.first().isDigit()) return null
    return count to detail.drop(count.length)
}

/**
 * Top-left (px) of the stroke tooltip: centred over the finger at ([anchorX], [anchorY]), [liftPx] above it, kept inside
 * [minX]..[maxX] and [minY]..[maxY]. When there is no room above (the finger is high on the screen) it goes below.
 */
fun tooltipTopLeft(anchorX: Float, anchorY: Float, width: Float, height: Float, liftPx: Float,
    minX: Float, maxX: Float, minY: Float, maxY: Float): Pair<Float, Float> {
    val x = (anchorX - width / 2f).coerceIn(minX, (maxX - width).coerceAtLeast(minX))
    val above = anchorY - liftPx - height
    val y = if (above >= minY) above else (anchorY + liftPx).coerceIn(minY, (maxY - height).coerceAtLeast(minY))
    return x to y
}

/** One tool cell's width and SAVE's width in dp for a strip [widthDp] wide (editor.png: 62 / 126 on the 412 dp phone). */
data class ToolStripWidths(val cell: Float, val save: Float)

/**
 * The tool strip: four cells (WALLS, ERASE, MOVE, UNDO, 4 dp apart, 4 dp from the left) and SAVE (6 dp gap, 8 dp from the
 * right). At 412 dp they are 62 and 126; on a narrower phone SAVE gives way first (to 104), then the cells shrink, never
 * under the 56 dp face plus nothing (a 48 dp target is always kept).
 */
fun toolStripWidths(widthDp: Float): ToolStripWidths {
    val fixed = 4f + 3 * 4f + 6f + 8f
    val full = fixed + 4 * 62f + 126f
    if (widthDp >= full) return ToolStripWidths(62f, 126f)
    val save = (widthDp - fixed - 4 * 56f).coerceIn(104f, 126f)
    val cell = ((widthDp - fixed - save) / 4f).coerceIn(48f, 62f)
    return ToolStripWidths(cell, save)
}

/** A square glyph grid turned clockwise [quarterTurns] times (the nudge pad's ← ↓ → from the kit's "up"). */
fun rotateGlyph(rows: List<String>, quarterTurns: Int): List<String> {
    val n = rows.size
    require(rows.all { it.length == n }) { "glyph must be square" }
    var out = rows
    repeat(((quarterTurns % 4) + 4) % 4) {
        val src = out
        out = List(n) { y -> String(CharArray(n) { x -> src[n - 1 - x][y] }) }
    }
    return out
}

/** The nudge pad's four steps (dx, dy) and the clockwise turns of the "up" glyph that point each way. */
val NUDGE_STEPS: List<Triple<Int, Int, Int>> = listOf(Triple(-1, 0, 3), Triple(0, -1, 0), Triple(0, 1, 2), Triple(1, 0, 1))

/** "Move the run left one tile". */
fun nudgeDescription(dx: Int, dy: Int): String = "Move the run " + when {
    dx < 0 -> "left"; dx > 0 -> "right"; dy < 0 -> "up"; else -> "down"
} + " one tile"
