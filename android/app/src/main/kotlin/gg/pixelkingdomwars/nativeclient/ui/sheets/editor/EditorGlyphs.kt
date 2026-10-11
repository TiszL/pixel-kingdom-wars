package gg.pixelkingdomwars.nativeclient.ui.sheets.editor

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import gg.pixelkingdomwars.nativeclient.ui.kit.GLYPH_CELLS
import gg.pixelkingdomwars.nativeclient.ui.kit.KIT_GLYPHS
import gg.pixelkingdomwars.nativeclient.ui.kit.drawGlyph

/*
 * Design component: the layout editor's tool glyphs (editor.png tool strip: eraser, four-way move, undo hook) and the
 * nudge arrows. The kit's glyph set (KitGlyphs.kt) has none of these and is not edited here, so they live with the
 * editor in the kit's own 12 × 12 grid grammar ('#' tint, 'h' highlight, 'x' ink, '.' empty) and are drawn by the kit's
 * `drawGlyph` at a whole number of device px per cell (pixel art, nearest, integer scale). Decorative: the button that
 * holds a glyph carries the label.
 */

/** The eraser of the ERASE tool (drawn in [ERASER_PINK]; the mock's pink block with a white tip band). */
internal val GLYPH_ERASE: List<String> = listOf(
    "............",
    ".....xxxxxx.",
    "....x#####x.",
    "...x#####xx.",
    "..x#####x#x.",
    ".xhhhhhx##x.",
    "xhhhhhx##x..",
    "xhhhhhx#x...",
    "xhhhhhxx....",
    "xxxxxxx.....",
    "............",
    "............",
)

/** The four-way arrow of the MOVE tool. */
internal val GLYPH_MOVE: List<String> = listOf(
    ".....##.....",
    "....####....",
    "...######...",
    ".....##.....",
    ".#...##...#.",
    "############",
    "############",
    ".#...##...#.",
    ".....##.....",
    "...######...",
    "....####....",
    ".....##.....",
)

/** The hooked arrow of UNDO. */
internal val GLYPH_UNDO: List<String> = listOf(
    "............",
    "...#........",
    "..##........",
    ".########...",
    "##########..",
    ".##########.",
    "..##.....##.",
    "...#.....##.",
    ".........##.",
    "........###.",
    "......####..",
    "......###...",
)

/** The eraser's pink (editor.html `#F3B3C0`). */
internal val ERASER_PINK = Color(0xFFF3B3C0)

/** Every editor glyph by name (tests check they are all [GLYPH_CELLS] square and use only the kit's cell letters). */
internal val EDITOR_GLYPHS: Map<String, List<String>> = mapOf("erase" to GLYPH_ERASE, "move" to GLYPH_MOVE, "undo" to GLYPH_UNDO)

/** The kit's "up" arrow turned [quarterTurns] clockwise (1 → right, 2 → down, 3 → left). */
internal fun arrowGlyph(quarterTurns: Int): List<String> = rotateGlyph(KIT_GLYPHS.getValue("up"), quarterTurns)

/** Draws [rows] in a [size] box (decorative; no semantics). */
@Composable internal fun EditorGlyph(rows: List<String>, size: Dp, tint: Color, modifier: Modifier = Modifier) {
    check(rows.size == GLYPH_CELLS)
    Canvas(modifier.size(size)) { drawGlyph(rows, tint, 1f) }
}
