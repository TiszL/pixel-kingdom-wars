package gg.pixelkingdomwars.nativeclient.ui.world

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * The globe HUD mix (D-166; index.html + main.js at the pin) with the native F1 header set (GLOBE-NATIVE-PLAN §1.1,
 * §3.6), as a pure planner: every control's rect in dp for one screen and one HUD state.
 *
 * - Header: ‹ BASE, the title plate, owner search and CAMPAIGN in one row; the rail of the 8 realm destinations under it
 *   (short landscape: the rail joins the row, as index.html's `max-height:520px` rule does).
 * - The F1 modes (EXPLORE, WARZONE, BASES with its badge, MOTION) are square tools: a row under the rail, or a left
 *   column in short landscape. The web page has no such set; this is the native addition the plan requires.
 * - The globe tools (MY PARCEL, NIGHT, −, +) are a thumb-side bottom dock in portrait with zoom rightmost, and a
 *   right-edge column centred below the header in landscape. They hide while the realm panel is open. The web's WORLD
 *   tool (fly to the whole-world frame) is not on native: the owner (2026-09-26) found it does nothing on the world
 *   scene, where the player already is.
 * - The realm panel is a right-side panel in landscape (≤ 360 dp, ≤ 44 % of the width) and a 46 % bottom sheet in
 *   portrait with the web's peek / expand / close drag rules ([sheetDrag]).
 * - The hint pill rides above the portrait dock, or bottom-centre in landscape. (The web left-aligns it in short
 *   landscape; native keeps it centred because the F1 column owns the left edge there.)
 */
class GlobeHudPlan private constructor(val landscape: Boolean, val shortLandscape: Boolean, val controls: List<HudControl>,
    /** Header bottom edge (the web's `--hdr`). */
    val headerBottom: Float, val panel: HudRect?, val sheetFull: HudRect?, val peekTop: Float?,
    /** The rail's scrolling row; the destination rects inside it are at scroll 0. */
    val railRow: HudRect) {
    fun rect(id: String): HudRect? = controls.firstOrNull { it.id == id }?.rect
    /** main.js `uiRects()` plus the native F1 controls: what place labels keep clear of (and what the engine frames the
     *  globe inside). The header band spans the full width, as on the web. */
    fun labelRects(width: Float, height: Float): List<HudRect> = buildList {
        add(HudRect(0f, 0f, width, headerBottom))
        for (c in controls) if (c.id.startsWith("mode:") || c.id.startsWith("tool:") || c.id == "hint" || c.id == "results") add(c.rect)
        panel?.let { p -> add(if (landscape) HudRect.ltrb(p.x, p.y - 8f, width, height) else HudRect.ltrb(0f, p.y, width, height)) }
    }

    data class Input(
        val width: Float, val height: Float, val safe: HudInsets, val type: HudType,
        val back: Boolean = true, val campaign: Boolean = false,
        /** Destination labels in rail order, and which of them carry the realm-map icon. */
        val destinations: List<String> = emptyList(), val mapped: Set<Int> = emptySet(),
        val searchOpen: Boolean = false, val resultRows: Int = 0,
        val panelOpen: Boolean = false, val sheetPeek: Boolean = false,
        /** Portrait sheet: the grab header + CTA height (the web's `--peek`), measured. */
        val peekH: Float = 150f,
        val hint: String? = null, val diving: Boolean = false,
    )

    companion object {
        const val ROW_H = 48f
        const val RAIL_H = 53f               // 3 dp + a 44 dp well + 6 dp (index.html #rail padding)
        const val HEADER_GAP = 6f
        const val TOOL_H = 56f
        const val TOOL_ICON = 48f
        const val SHEET_FRACTION = 0.46f
        const val PANEL_MAX_W = 360f
        const val PANEL_W_FRACTION = 0.44f
        const val SEARCH_FIELD_W = 240f

        /** A labelled `.hud-tool` (icon over a caps label): ≥ 64 wide, ≥ 76 in the globe tool set (index.html). */
        fun toolWidth(label: String, t: HudType, min: Float = 64f): Float = ceil(max(min, 1f + 6f + max(24f, HudType.textWidth(label.length, t.cap, 1f)) + 6f + 1f))
        /** A `.hud-btn--sm` with an optional 24 dp icon. */
        fun smallButtonWidth(label: String, t: HudType, icon: Boolean): Float =
            ceil(1f + 12f + (if (icon) 24f + 8f else 0f) + HudType.textWidth(label.length, t.body, 1f) + 12f + 1f)
        /** A `.hud-filter.hud-dest` rail well: pip, optional map icon, VT323 caps label. */
        fun destWidth(label: String, t: HudType, mapped: Boolean): Float =
            ceil(max(44f, 1f + 12f + 6f + 7f + (if (mapped) 13f + 7f else 0f) + HudType.textWidth(label.length, t.body, 1f) + 12f + 1f))

        val MODES = listOf("EXPLORE", "WARZONE", "BASES", "MOTION")
        /** The labelled globe tools, in dock order (no WORLD: see the class note). */
        val TOOLS = listOf("MY PARCEL", "NIGHT")

        fun plan(i: Input): GlobeHudPlan {
            val W = i.width; val H = i.height; val sa = i.safe; val t = i.type
            val landscape = W > H; val short = landscape && H <= HudTokens.SHORT_LANDSCAPE_MAX_H
            val c = ArrayList<HudControl>()
            val left = sa.left + 12f; val right = W - sa.right - 12f
            val rowY = sa.top + 8f

            // ---- row A: ‹ BASE · title · [rail in short landscape] · search · CAMPAIGN ----
            var x = left
            if (i.back) { val w = smallButtonWidth("BASE", t, icon = true); c += HudControl("back", HudRect(x, rowY + 2f, w, 44f)); x += w + 8f }
            var end = right
            if (i.campaign) { val w = smallButtonWidth("CAMPAIGN", t, icon = false); c += HudControl("campaign", HudRect(end - w, rowY + 2f, w, 44f)); end -= w + 8f }
            val searchW = if (i.searchOpen && landscape) SEARCH_FIELD_W else TOOL_ICON
            val searchRect = if (i.searchOpen && !landscape) HudRect(left, rowY, right - left, ROW_H) else HudRect(end - searchW, rowY, searchW, ROW_H)
            c += HudControl("search", searchRect, overlay = i.searchOpen && !landscape)
            if (!(i.searchOpen && !landscape)) end -= searchW + 8f
            val titleW = if (short) ceil(max(96f, 2f + 18f + HudType.textWidth(9, t.body, 2f))) else max(0f, end - x)
            c += HudControl("title", HudRect(x, rowY + 8f, min(titleW, max(0f, end - x)), 32f))
            var headerBottom: Float
            val railRow: HudRect
            if (short) {
                val rx = x + titleW + 10f
                railRow = HudRect(rx, rowY, max(0f, end - rx), RAIL_H - 5f)
                headerBottom = rowY + ROW_H + 4f
            } else {
                railRow = HudRect(left, rowY + ROW_H + HEADER_GAP, right - left, RAIL_H)
                headerBottom = railRow.bottom + 4f
            }
            var dx = railRow.x + 2f
            i.destinations.forEachIndexed { index, label ->
                val w = destWidth(label, t, index in i.mapped)
                val r = HudRect(dx, railRow.y + 3f, w, 44f).clipX(railRow.x, railRow.right)
                if (!r.empty) c += HudControl("dest:$index", r)
                dx += w + HudStyle.gap
            }

            // ---- F1 modes: a row under the rail, or a left column in short landscape ----
            if (short) {
                var y = headerBottom + 8f
                for (m in MODES) { val w = toolWidth(m, t); c += HudControl("mode:$m", HudRect(left, y, w, TOOL_H)); y += TOOL_H + 6f }
            } else {
                var mx = left; val y = headerBottom - 4f + HEADER_GAP
                for (m in MODES) { val w = toolWidth(m, t); c += HudControl("mode:$m", HudRect(mx, y, w, TOOL_H)); mx += w + HudStyle.gap }
                headerBottom = y + TOOL_H + 4f
            }

            // ---- search results under the field ----
            if (i.searchOpen && i.resultRows != 0) {
                val s = searchRect
                val rows = if (i.resultRows < 0) 30f else i.resultRows * 48f + (i.resultRows - 1) * 4f
                val h = min(min(0.6f * H, 420f), 4f + 10f + rows + 8f); val w = min(330f, W - 20f)
                c += HudControl("results", HudRect(s.right - w, s.y + 54f, w, h), overlay = true)
            }

            // ---- globe tools (hidden while the panel is open or a dive runs) ----
            if (!i.panelOpen && !i.diving) {
                val gap = if (landscape && H <= 420f) 4f else 6f
                val widths = TOOLS.map { toolWidth(it, t, 76f) }
                if (landscape) {
                    val colW = widths.max()
                    val th = 2 * TOOL_ICON + TOOLS.size * TOOL_H + (1 + TOOLS.size) * gap
                    var y = ((H + headerBottom) / 2f - th / 2f).coerceAtLeast(headerBottom + 4f)
                    val cx = W - sa.right - 10f - colW
                    for (id in listOf("in", "out")) { c += HudControl("tool:$id", HudRect(cx + (colW - TOOL_ICON) / 2f, y, TOOL_ICON, TOOL_ICON)); y += TOOL_ICON + gap }
                    TOOLS.forEachIndexed { k, m -> c += HudControl("tool:${m}", HudRect(cx + (colW - widths[k]) / 2f, y, widths[k], TOOL_H)); y += TOOL_H + gap }
                } else {
                    val bottom = H - sa.bottom - 12f
                    var tx = W - sa.right - 10f
                    for (id in listOf("in", "out")) { tx -= TOOL_ICON; c += HudControl("tool:$id", HudRect(tx, bottom - TOOL_ICON, TOOL_ICON, TOOL_ICON)); tx -= gap }
                    for (k in TOOLS.indices.reversed()) { tx -= widths[k]; c += HudControl("tool:${TOOLS[k]}", HudRect(tx, bottom - TOOL_H, widths[k], TOOL_H)); tx -= gap }
                }
            }

            // ---- hint pill ----
            if (i.hint != null && !i.panelOpen && !i.diving) {
                val maxW = W - 32f
                val textW = HudType.textWidth(i.hint.length, t.body)
                val lines = ceil(textW / (maxW - 22f)).coerceAtLeast(1f)
                val w = min(maxW, ceil(textW + 22f)); val h = max(32f, ceil(lines * t.body * 1.15f + 9f))
                val bottom = if (landscape) sa.bottom + 18f else sa.bottom + 80f
                c += HudControl("hint", HudRect((W - w) / 2f, H - bottom - h, w, h))
            }

            // ---- realm panel / sheet ----
            var panel: HudRect? = null; var sheetFull: HudRect? = null; var peekTop: Float? = null
            if (i.panelOpen) {
                if (landscape) {
                    val pw = min(PANEL_MAX_W, PANEL_W_FRACTION * W); val y = headerBottom + 8f
                    panel = HudRect(W - sa.right - 12f - pw, y, pw, H - sa.bottom - 12f - y)
                } else {
                    val full = HudRect(0f, H - SHEET_FRACTION * H, W, SHEET_FRACTION * H)
                    sheetFull = full; peekTop = H - min(i.peekH, full.h)
                    panel = if (i.sheetPeek) HudRect(0f, peekTop, W, H - peekTop) else full
                }
                c += HudControl("panel", panel)
            }
            return GlobeHudPlan(landscape, short, c, headerBottom, panel, sheetFull, peekTop, railRow)
        }

        /** main.js sheet drag end: a tap (< 6 dp, < 300 ms) toggles peek; down > 70 peeks, or closes a peeked sheet;
         *  up > 30 expands. While dragging the sheet follows the finger (upward at 0.3×). */
        enum class SheetAction { NONE, TOGGLE_PEEK, PEEK, CLOSE, EXPAND }
        fun sheetDrag(dy: Float, ms: Long, peeked: Boolean): SheetAction = when {
            abs(dy) < 6f && ms < 300 -> SheetAction.TOGGLE_PEEK
            dy > 70f -> if (peeked) SheetAction.CLOSE else SheetAction.PEEK
            dy < -30f -> SheetAction.EXPAND
            else -> SheetAction.NONE
        }
        fun sheetFollow(dy: Float): Float = if (dy < 0f) dy * 0.3f else dy

        /**
         * main.js `placeLabel(s, w, h, rects, W, H)`: a name sits on its anchor, nudged at most half its width (+ 6) sideways
         * and 36 dp up or down off the screen edges, the UI rects and names already placed; null when nothing fits.
         * Rects are (x0, y0, x1, y1). Candidates are scanned in the web's order so ties resolve identically.
         */
        fun placeLabel(sx: Double, sy: Double, w: Double, h: Double, rects: List<DoubleArray>, W: Double, H: Double): DoubleArray? {
            val m = 4.0; val bx = sx - w / 2; val by = sy - h / 2
            val xs = ArrayList<Double>(2 + rects.size * 2).apply { add(0.0) }; val ys = ArrayList<Double>(2 + rects.size * 2).apply { add(0.0) }
            if (bx < m) xs += m - bx; if (bx + w > W - m) xs += W - m - w - bx
            if (by < m) ys += m - by; if (by + h > H - m) ys += H - m - h - by
            for (r in rects) { xs += r[0] - m - bx - w; xs += r[2] + m - bx; ys += r[1] - m - by - h; ys += r[3] + m - by }
            var best: DoubleArray? = null; var bd = Double.POSITIVE_INFINITY
            for (dx in xs) {
                if (abs(dx) > w / 2 + 6) continue
                for (dy in ys) {
                    if (abs(dy) > 36) continue
                    val dd = RealmHudModel.jsHypot(dx, dy * 1.5); if (dd >= bd) continue
                    val x0 = bx + dx; val y0 = by + dy; val x1 = x0 + w; val y1 = y0 + h
                    if (x0 < m || y0 < m || x1 > W - m || y1 > H - m) continue
                    if (rects.any { r -> x0 < r[2] + m && x1 > r[0] - m && y0 < r[3] + m && y1 > r[1] - m }) continue
                    best = doubleArrayOf(x0, y0); bd = dd
                }
            }
            return best
        }
    }
}
