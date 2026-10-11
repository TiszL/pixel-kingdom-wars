package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import kotlin.math.min

/*
 * K-night-A11 (owner 2026-10-06, Seeker): "hero altar and clan building sheets show cut-offs". The game follows the
 * user's rotation (e81d17d2, the owner demos in landscape over scrcpy), and a phone in landscape is about 400 dp tall.
 * A framed TALL / FULL sheet (kit SheetFrame, hub HubCard, the BUILD tray) stacks fixed parts (the 110-136 dp living
 * header, the tab row, the pinned action row) around a body that takes what is left; in a 270-330 dp landscape slot that
 * is nothing, so the body and the action row were cut off. Portrait is untouched (every portrait slot on the Seeker is
 * over 800 dp).
 *
 * The rule: a shell whose own height is under [SheetFit.FRAMED_MIN_DP] is COMPACT. Its header and tabs then scroll away
 * with the body (an upward drag collapses the header first), the body keeps a full page of the visible height with its
 * own scroll, and the action row (CREATE YOUR OWN, ATTACK, CLAIM ...) stays pinned at the bottom, always visible. Every
 * designed size is kept; only the bounding changes. A shell at or over the minimum keeps its designed tree exactly.
 */

/** Pure geometry of the compact rule, in dp. JVM-tested in SheetFitTest. */
object SheetFit {
    /** The living header (PkwTokens.Dims.sheetHeaderH; SheetFrame and HubFrame LivingHeader). */
    const val HEADER_DP = SheetGeometry.HEADER_DP
    /** The tab row with its gap: the hub's stacked tabs (56 dp) under a 10 dp gap; the kit TabStrip (48 + 8) is shorter. */
    const val TABS_DP = 66
    /** The pinned footer: an 8 dp gap and the 60 dp sheet primary (PkwTokens.Dims.sheetPrimaryH). */
    const val FOOTER_DP = 68
    /** The frame's own padding: HubCard wood 6 + 8 and parchment 8 + 8 (SheetFrame's living wood 3 + 10 and parchment
     *  5 + 6 are less). */
    const val FRAME_DP = 30
    /** The least body that still reads: the 52 dp status / refresh row (PkwTokens.Dims.secondaryH) and two 56 dp rows,
     *  6 dp apart. */
    const val BODY_MIN_DP = 52 + 6 + 2 * 56 + 6
    /** The shortest shell that keeps its designed geometry: 476 dp. */
    const val FRAMED_MIN_DP = HEADER_DP + TABS_DP + FOOTER_DP + FRAME_DP + BODY_MIN_DP

    /** Whether a framed TALL / FULL shell [heightDp] tall is compact. Unbounded or unknown (not finite) is never compact. */
    fun compact(heightDp: Float): Boolean = heightDp.isFinite() && heightDp < FRAMED_MIN_DP

    /** How much of a drag the collapsing header takes before the body sees it, in px. [availableY] is the drag (negative:
     *  the finger moves up, the content moves up); [remainingPx] is how much header is still showing. An upward drag
     *  scrolls the header away first; a downward drag is left to the body, which returns to its own top before the
     *  header comes back (the body's scroll hands what it does not use to the outer scroll). */
    fun collapseFirstPx(availableY: Float, remainingPx: Float): Float =
        if (!availableY.isFinite() || availableY >= 0f || !remainingPx.isFinite() || remainingPx <= 0f) 0f
        else min(-availableY, remainingPx)
}

/** Measures the space a framed TALL / FULL shell is given and tells [content] whether it is compact ([SheetFit.compact]).
 *  Layout only: no pointer handling (the pointer rule). Never use it around a HALF sheet, which wraps its content. */
@Composable fun SheetFitBox(modifier: Modifier = Modifier, content: @Composable (compact: Boolean) -> Unit) {
    BoxWithConstraints(modifier) { content(constraints.hasBoundedHeight && SheetFit.compact(maxHeight.value)) }
}

/**
 * The compact layout of a framed shell (see the file header): [collapsing] (header and tabs) and the [page] scroll
 * together, the [footer] is pinned under them. [page] gets a modifier with the full visible height, so once the header
 * has scrolled away the body fills the window; the body's own scroll works inside it. Give [modifier] a bounded height.
 */
@Composable fun CollapsingSheetColumn(modifier: Modifier = Modifier, collapsing: @Composable ColumnScope.() -> Unit,
    footer: (@Composable ColumnScope.() -> Unit)? = null, page: @Composable (Modifier) -> Unit) {
    Column(modifier) {
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val visible = maxHeight
            val outer = rememberScrollState()
            val collapseFirst = remember(outer) { CollapseHeaderFirst(outer) }
            Column(Modifier.fillMaxSize().nestedScroll(collapseFirst).verticalScroll(outer)) {
                collapsing()
                page(Modifier.fillMaxWidth().height(visible))
            }
        }
        footer?.invoke(this)
    }
}

/** An upward drag inside the body scrolls the header away first ([SheetFit.collapseFirstPx]). */
private class CollapseHeaderFirst(private val outer: ScrollState) : NestedScrollConnection {
    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
        val take = SheetFit.collapseFirstPx(available.y, (outer.maxValue - outer.value).toFloat())
        return if (take == 0f) Offset.Zero else Offset(0f, -outer.dispatchRawDelta(take))
    }
}
