package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize

/*
 * Full-screen sheets (owner, 2026-10-06 05:05 UTC, OWNER-FEEDBACK-0450Z): "none of screens should overlay each other on
 * interface and should be fully solana mobile optimized, like dark overlap on camera place is ugly and unprofessional,
 * make it full screen". This supersedes DESIGN-SYSTEM §6 "Tall: from y 104 to the bottom, 40% scrim, the world keeps
 * rendering" and "Full card: 60% scrim" on a phone: a TALL or FULL sheet is one opaque card from the screen's top edge
 * (behind the camera cut-out) to its bottom edge, with no dimmed kingdom anywhere.
 *
 * Geometry of the card, top to bottom, on the Seeker (1200 x 2670 px, about 412 x 917 dp):
 *  1. the safe-drawing top inset (the camera cut-out strip): backdrop only, nothing interactive;
 *  2. the SHELF: one 26 dp row of the lifted resource pills, right-aligned, 6 dp above and below ([shelfDp]). This is
 *     where DESIGN-SYSTEM §6 TopBar "Tall sheets: the stack shows only the currency that sheet spends" now lives, so a
 *     pill can never draw over a sheet header (owner screenshot 8, phone/hub-trophy-031752.png). No pills, no shelf;
 *  3. the sheet's own wood frame with its living header art band, tabs, body and footer, full width, down to the
 *     safe-drawing bottom inset.
 * A HALF sheet is unchanged (no scrim, the kingdom above it stays live), and a wide window (tablet, landscape) keeps the
 * framed card over its scrim, because a 900 dp parchment body is not the design.
 */

/** Pure geometry of a full-screen sheet, in dp. JVM-tested in FullScreenSheetTest. */
object FullScreenSheetGeometry {
    /** Below this window width (Android's compact width class) TALL and FULL sheets fill the screen. */
    const val COMPACT_MAX_WIDTH_DP = 600f
    /** Space above and below the shelf's pill row. */
    const val SHELF_PAD_DP = 6
    /** One resource pill row (TOKENS.json `resourceRow` height). */
    const val PILL_H_DP = 26
    /** The widest pill (TOKENS.json `resourceRow` width); pills shrink evenly when four do not fit. */
    const val PILL_MAX_W_DP = 108
    /** Space between two pills on the shelf. */
    const val PILL_GAP_DP = 4
    /** The shelf's side gutter (TOKENS.json `space.screenGutter`). */
    const val GUTTER_DP = 8

    /** Whether a sheet of [size] fills the screen in a window [windowWidthDp] wide. Only TALL and FULL ever do. */
    fun fillsScreen(size: SheetSize?, windowWidthDp: Float): Boolean =
        (size == SheetSize.TALL || size == SheetSize.FULL) && windowWidthDp.isFinite() && windowWidthDp < COMPACT_MAX_WIDTH_DP

    /** The shelf height for [pills] lifted resource rows: none for zero, otherwise one padded pill row (38 dp). */
    fun shelfDp(pills: Int): Int = if (pills <= 0) 0 else SHELF_PAD_DP + PILL_H_DP + SHELF_PAD_DP

    /** One pill's width when [pills] share a shelf [availableWidthDp] wide (the safe width; gutters are taken here). */
    fun pillWidthDp(pills: Int, availableWidthDp: Float): Float {
        if (pills <= 0 || !availableWidthDp.isFinite()) return 0f
        val room = availableWidthDp - 2f * GUTTER_DP - (pills - 1) * PILL_GAP_DP
        return (room / pills).coerceIn(0f, PILL_MAX_W_DP.toFloat())
    }

    /** Where the sheet panel sits inside the window: below the safe top and the shelf, above the safe bottom, between
     *  the safe sides. Negative or non-finite inputs count as zero. */
    fun panelEdges(safeTopDp: Float, safeBottomDp: Float, safeStartDp: Float, safeEndDp: Float, shelfDp: Float): FullScreenSheetEdges {
        fun clean(value: Float) = if (value.isFinite()) value.coerceAtLeast(0f) else 0f
        return FullScreenSheetEdges(clean(safeTopDp) + clean(shelfDp), clean(safeBottomDp), clean(safeStartDp), clean(safeEndDp))
    }
}

/** The panel's distance from each window edge, in dp ([FullScreenSheetGeometry.panelEdges]). */
data class FullScreenSheetEdges(val topDp: Float, val bottomDp: Float, val startDp: Float, val endDp: Float)

/** The opaque fill under a full-screen sheet: the camera cut-out strip and the shelf read as the dark end grain of the
 *  sheet's own wood frame (TOKENS.json wood lo), never as a dimmed kingdom. */
val FullScreenSheetBackdropColor: Color get() = PkwTokens.Colors.woodLo

/**
 * The Home root's record of which full-screen sheets are showing, and the shelf height they must leave for the lifted
 * resource pills. HomeScaffold provides one ([LocalFullScreenSheets]); every host that paints a full-screen sheet
 * registers while it is shown ([FullScreenSheetEffect]); HomeScaffold then draws the pills as the one-row shelf
 * ([FullScreenResourceShelf]) instead of the four-row stack, hides the rest of the Home HUD, and publishes [shelf].
 * Outside Home (a route screen) nothing is provided: a sheet there fills the screen with no shelf.
 */
@Stable class FullScreenSheets {
    private val open = mutableStateListOf<Any>()

    /** True while at least one full-screen sheet is shown (entering, shown or leaving). */
    val active: Boolean get() = open.isNotEmpty()

    /** The shelf a full-screen sheet leaves under the safe top for the lifted pills; 0 when no pill is drawn. */
    var shelf: Dp by mutableStateOf(0.dp)

    /** Extra shelf height taken by a host notice drawn under the pill row (the Gold Forge notice / error toast, which
     *  had the world strip before); 0 when none. The notice reports its own measured height and clears it on leaving. */
    var notice: Dp by mutableStateOf(0.dp)

    fun register(token: Any) { if (open.none { it === token }) open.add(token) }
    fun unregister(token: Any) { open.removeAll { it === token } }
}

val LocalFullScreenSheets = staticCompositionLocalOf<FullScreenSheets?> { null }

/** Registers the calling host's full-screen sheet with the Home root while [active]. No-op outside Home. */
@Composable fun FullScreenSheetEffect(active: Boolean) {
    val sheets = LocalFullScreenSheets.current
    val token = remember { Any() }
    DisposableEffect(sheets, active) {
        if (active) sheets?.register(token)
        onDispose { sheets?.unregister(token) }
    }
}

/** The shelf height a full-screen sheet leaves under the safe top here (pill row plus any host notice): the Home root's
 *  value, 0 outside Home. */
@Composable fun fullScreenSheetShelf(): Dp = LocalFullScreenSheets.current?.let { it.shelf + it.notice } ?: 0.dp

/**
 * The opaque backdrop of a full-screen sheet, filling its parent. It is a painted panel (a scene-input region) that
 * swallows taps, so no touch reaches the kingdom behind a full-screen sheet and nothing behind it is ever seen. It is
 * not a close target (the sheet's X and Back close), and it is silent for screen readers.
 */
@Composable fun FullScreenSheetBackdrop(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(FullScreenSheetBackdropColor).sceneInputRegion().clearAndSetSemantics { }
        .pointerInput(Unit) { detectTapGestures { } })
}

/**
 * The lifted resource pills as one right-aligned row on the shelf of a full-screen sheet (see the file header), drawn
 * by the Home root at `PkwTokens.Z.RESOURCE_STACK` inside the safe-drawing insets. Up to four rows of the Home stack,
 * left to right in stack order; they shrink evenly when four do not fit at 108 dp. Read-only: the resource drawer
 * lives on Home under the sheet, so a pill here is an amount, not a door (no touch target, no drawer caret); every
 * price inside the sheet keeps its own SHORT / GO door. Screen readers hear each amount.
 */
@Composable fun FullScreenResourceShelf(rows: List<ResourceChipUi>, modifier: Modifier = Modifier) {
    val shown = rows.take(PkwTokens.Budget.MAX_RESOURCE_ROWS)
    if (shown.isEmpty()) return
    BoxWithConstraints(modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        val pill = FullScreenSheetGeometry.pillWidthDp(shown.size, maxWidth.value)
        Row(Modifier.align(Alignment.TopEnd).padding(top = FullScreenSheetGeometry.SHELF_PAD_DP.dp, end = FullScreenSheetGeometry.GUTTER_DP.dp),
            horizontalArrangement = Arrangement.spacedBy(FullScreenSheetGeometry.PILL_GAP_DP.dp)) {
            shown.forEach { row ->
                key(row.id.value) { ResourceChip(row.copy(drawerHandle = false, badge = null), Modifier.width(pill.dp)) }
            }
        }
    }
}

/**
 * Lays this node out over the [insets] its mount already applied, on every side, so a full-screen sheet reaches the
 * screen edges (behind the camera cut-out) although its parent is the safe-drawing viewport. The node keeps reporting
 * its parent's size, so siblings do not move. Use it only where the parent applied exactly these insets once (the Home
 * overlay root applies `WindowInsets.safeDrawing`); children must then pad by the same insets themselves. Drawing and
 * touch reach the extended area because no ancestor of the Home overlay clips.
 */
fun Modifier.bleedOver(insets: WindowInsets): Modifier = layout { measurable, constraints ->
    if (!constraints.hasBoundedWidth || !constraints.hasBoundedHeight) {
        val placeable = measurable.measure(constraints)
        layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    } else {
        val left = insets.getLeft(this, layoutDirection).coerceAtLeast(0)
        val top = insets.getTop(this).coerceAtLeast(0)
        val right = insets.getRight(this, layoutDirection).coerceAtLeast(0)
        val bottom = insets.getBottom(this).coerceAtLeast(0)
        val placeable = measurable.measure(Constraints.fixed(constraints.maxWidth + left + right, constraints.maxHeight + top + bottom))
        layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(-left, -top) }
    }
}
