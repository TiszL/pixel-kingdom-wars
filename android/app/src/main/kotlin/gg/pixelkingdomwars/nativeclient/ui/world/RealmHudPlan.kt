package gg.pixelkingdomwars.nativeclient.ui.world

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The approved realm-map HUD layout (D-167: `cc31561f` + `92a62466`, ui.js `layout()` and its STYLE sheet at the pin),
 * as a pure planner: every control's rect in dp for one screen and one HUD state. Compose places the controls exactly
 * here, the label layer keeps names and counters off these rects, and `RealmHudPlanTest` proves 0 tag/control
 * intersections on every Seeker row, portrait and landscape.
 *
 * Portrait phone (W < H and W < 700): the base card is a bottom sheet (≤ 42 % of the height), the minimap sits top-right
 * under the chips and folds while the card is open (its toggle pins it back), the exit is icon-only, the chips use their
 * short labels and search opens over the top bar. Otherwise ("wide"): the card is a right panel beside the tool column,
 * the minimap sits bottom-left and the chips use their long labels.
 *
 * N4 additions (GLOBE-NATIVE-PLAN §3.6, no redesign): the WARZONE chip in the top bar while a warzone is active (F16)
 * with its status panel dropping like the level panel, and in choose mode "Next open deed ▶" in the ◀ ▶ slot while no
 * card is open (with a card up it sits in the card's action bar).
 */
class RealmHudPlan private constructor(val portrait: Boolean, val controls: List<HudControl>, val safeBox: HudRect,
    /** The largest card height this layout allows (portrait: 42 % of the height; wide: the height less 136 and the insets). */
    val cardMaxH: Float, val miniShown: Boolean, val chipsRow: HudRect,
    /** The wide card's right offset (the tool column + gaps) and the chips' bottom edge (ui.js `cardR`, `focusTop`). */
    val cardR: Float, val focusTop: Float) {
    fun rect(id: String): HudRect? = controls.firstOrNull { it.id == id }?.rect
    /** ui.js `measureChrome`: what tags and counters must never cover, padded by 4 dp (chips clipped to their row). */
    fun chrome(): List<DoubleArray> = controls.map { it.rect.ltrb(RealmHudModel.PAD.toFloat()) }
    /** ui.js `focusOffset()`: where the camera centre sits from a selected base so it shows in the uncovered area. */
    fun focusOffset(cardOpen: Boolean): Pair<Float, Float> {
        if (!cardOpen) return 0f to 0f
        val card = rect("card") ?: return 0f to 0f
        return if (portrait) 0f to ((card.h - focusTop) / 2f).roundToFloat() else ((CARD_W + cardR) / 2f).roundToFloat() to 0f
    }

    data class Input(
        val width: Float, val height: Float, val safe: HudInsets, val type: HudType,
        /** The realm's deed grid (the minimap frame takes its aspect); null until the pack is read. */
        val realmCols: Int? = null, val realmRows: Int? = null,
        /** Default: the widest row the realm map shows (the Unshielded chip in), so the layout gates plan the worst case. */
        val chips: List<HudChip> = HudChips.realm(shieldFed = true),
        val levelLong: String = "Level 1–20", val levelShort: String = "Lv 1–20",
        val title: String = "", val subtitle: String = "",
        /** Measured card height (dp); 0 while no base is selected. */
        val cardH: Float = 0f,
        val miniOpen: Boolean = true, val miniPin: Boolean = false, val wholeRealm: Boolean = false,
        val levelOpen: Boolean = false, val searchOpen: Boolean = false,
        /** Search result rows showing (0 = none; -1 = the "No kingdom by that name" line). */
        val resultRows: Int = 0,
        val scaleBarW: Int = 60, val scaleLabel: String = "2 deeds",
        /** A warzone is active (F16): the top bar carries its chip; [warzoneOpen] drops its status panel. */
        val warzone: Boolean = false, val warzoneOpen: Boolean = false,
        /** Choose mode (GLOBE-PRODUCTION-PLAN §1.3): "Next open deed ▶" takes the ◀ ▶ slot while no card is open. */
        val choose: Boolean = false,
    )

    companion object {
        const val CARD_W = 330f
        const val EXIT_ICON_W = 48f
        const val TOP_ROW_Y = 8f
        const val CHIPS_Y = 64f
        const val CHIPS_H = 52f            // 2 dp top padding + a 44 dp chip + 6 dp bottom padding
        const val FOCUS_TOP_FROM_SAFE = CHIPS_Y + CHIPS_H
        const val LEVEL_Y = 120f
        const val TOOL_ICON = 48f
        const val NAV_W = 104f             // two 48 dp tools and an 8 dp gap
        const val SCALE_H = 32f
        const val RESULTS_TOP = 54f
        const val SEARCH_FIELD_W = 240f
        const val INPUT_H = 44f
        const val WARZONE_PANEL_H = 216f
        /** A small `.hud-btn` with a caps label (the WARZONE chip). */
        fun warzoneW(t: HudType): Float = (1f + 12f + HudType.textWidth(7, t.body, 1f) + 12f + 1f).roundUp()
        /** The "Next open deed ▶" button: a `.hud-btn` with its label and the 24 dp next glyph. */
        fun nextOpenW(t: HudType): Float = (1f + 16f + HudType.textWidth(14, t.ui, 1f) + 8f + 24f + 16f + 1f).roundUp()

        fun plan(i: Input): RealmHudPlan {
            val W = i.width; val H = i.height; val sa = i.safe; val t = i.type
            val portrait = W < H && W < 700f
            val controls = ArrayList<HudControl>()
            val safeBox = HudRect.ltrb(sa.left + 2f, sa.top + 2f, W - sa.right - 2f, H - sa.bottom - 2f)

            // ---- top bar (.rmx-top): exit, title plate, search ----
            val rowY = sa.top + TOP_ROW_Y; val left = sa.left + 10f; val right = W - sa.right - 10f
            val exitW = if (portrait) EXIT_ICON_W else 1f + 16f + 24f + 8f + HudType.textWidth(5, t.ui, 1f) + 16f + 1f
            val titleH = max(48f, 2f + 6f + t.cap * 1.08f + 3f + t.cap * 1.1f + 4f + 2f).roundUp()
            val searchW = if (portrait) TOOL_ICON else SEARCH_FIELD_W
            val searchH = if (portrait) TOOL_ICON else INPUT_H
            if (!(portrait && i.searchOpen)) {
                controls += HudControl("exit", HudRect(left, rowY + (titleH - 48f) / 2f, exitW, 48f))
                val titleX = left + exitW + 8f
                val titleNeed = 2f + 28f + max(HudType.textWidth(i.title.length, 16f, 0.64f), HudType.textWidth(i.subtitle.length, t.cap, 1f))
                val warW = if (i.warzone) warzoneW(t) else 0f
                val titleRoom = right - searchW - 8f - (if (warW > 0f) warW + 8f else 0f) - titleX
                controls += HudControl("title", HudRect(titleX, rowY, max(0f, min(titleNeed, titleRoom)).roundUp(), titleH))
                if (warW > 0f) controls += HudControl("warzone", HudRect(right - searchW - 8f - warW, rowY + (titleH - 44f) / 2f, warW, 44f))
                controls += HudControl("search", HudRect(right - searchW, rowY + (titleH - searchH) / 2f, searchW, searchH))
            } else controls += HudControl("search", HudRect(left, rowY, right - left, INPUT_H))
            if (i.searchOpen && i.resultRows != 0) {
                val s = controls.first { it.id == "search" }.rect
                val rows = if (i.resultRows < 0) 30f else i.resultRows * 48f + (i.resultRows - 1) * 4f
                val h = min(min(0.6f * H, 420f), 4f + 10f + rows + 8f)
                val w = min(330f, W - 20f)
                controls += HudControl("results", HudRect(s.right - w, s.y + RESULTS_TOP, w, h), overlay = true)
            }

            // ---- chips (.rmx-chips): a scrolling row; each chip's visible part is chrome ----
            val chipsRow = HudRect(left, sa.top + CHIPS_Y, right - left, CHIPS_H)
            var cx = chipsRow.x + 2f
            val pad = if (portrait) 7f else 12f; val gap = if (portrait) 3f else 6f
            for (chip in i.chips) {
                val label = when { chip.id == "lvl" -> if (portrait) i.levelShort else i.levelLong; portrait -> chip.short; else -> chip.long }
                val w = max(44f, 2f + 2 * pad + HudType.textWidth(label.length, t.body, 1f)).roundUp()
                val r = HudRect(cx, chipsRow.y + 2f, w, 44f).clipX(chipsRow.x, chipsRow.right)
                if (!r.empty) controls += HudControl("chip:${chip.id}", r)
                cx += w + gap
            }
            if (i.levelOpen) controls += HudControl("level", HudRect(left, sa.top + LEVEL_Y, min(320f, W - 20f), 10f + 44f + 44f + 6f + 4f), overlay = true)
            if (i.warzone && i.warzoneOpen) controls += HudControl("warzonePanel", HudRect(left, sa.top + LEVEL_Y, min(320f, W - 20f), WARZONE_PANEL_H), overlay = true)

            // ---- minimap and its toggle ----
            val cardOpen = i.cardH > 0f
            val miniShown = i.miniOpen && !i.wholeRealm && (!portrait || !cardOpen || i.miniPin)
            val (bw, bh) = if (portrait) 132f to 132f else 180f to 120f
            val ar = if (i.realmCols != null && i.realmRows != null && i.realmRows > 0) i.realmCols.toFloat() / i.realmRows else bw / bh
            var mw = bw; var mh = (bw / ar).roundToInt().toFloat(); if (mh > bh) { mh = bh; mw = (bh * ar).roundToInt().toFloat() }
            mw = max(72f, mw); mh = max(72f, mh)
            val m = if (portrait) HudRect(W - mw - 10f - sa.right, 122f + sa.top, mw, mh) else HudRect(10f + sa.left, H - mh - 12f - sa.bottom, mw, mh)
            if (miniShown) controls += HudControl("minimap", m)
            if (!i.wholeRealm) controls += HudControl("minimapToggle",
                if (portrait) HudRect(m.right - 48f, if (miniShown) m.bottom + 8f else m.y, 48f, 48f)
                else HudRect(if (miniShown) m.right + 8f else m.x, m.bottom - 48f, 48f, 48f))

            // ---- tools: +, −, MY BASE on the right edge, centred on whole dp, above the sheet ----
            val mineW = max(64f, 1f + 6f + max(24f, HudType.textWidth(7, t.cap, 1f)) + 6f + 1f).roundUp()
            val toolsW = max(TOOL_ICON, mineW)
            val mineH = max(56f, 1f + 4f + 24f + 4f + t.cap + 6f + 1f)
            val th = TOOL_ICON + 8f + TOOL_ICON + 8f + mineH
            // ui.js caps the wide card at 100% − 136 px under a top of safe+120; native also subtracts the safe insets, which
            // the web's landscape phones report as 0, so the card never runs under the navigation bar.
            val cardMax = if (portrait) 0.42f * H else H - 136f - sa.top - sa.bottom
            val cardH = if (cardOpen) min(i.cardH, cardMax) else 0f
            val cardTop = H - cardH
            val focusTop = sa.top + FOCUS_TOP_FROM_SAFE
            val toolsTop = max(focusTop + 8f, min(((H - th) / 2f).roundToInt().toFloat(), if (portrait && cardOpen) cardTop - th - 12f else H))
            val toolsX = W - sa.right - 10f - toolsW
            controls += HudControl("zoomIn", HudRect(toolsX + (toolsW - TOOL_ICON) / 2f, toolsTop, TOOL_ICON, TOOL_ICON))
            controls += HudControl("zoomOut", HudRect(toolsX + (toolsW - TOOL_ICON) / 2f, toolsTop + TOOL_ICON + 8f, TOOL_ICON, TOOL_ICON))
            controls += HudControl("myBase", HudRect(toolsX + (toolsW - mineW) / 2f, toolsTop + 2 * (TOOL_ICON + 8f), mineW, mineH))

            // ---- card: bottom sheet (portrait) or right panel beside the tool column (wide) ----
            val cardR = sa.right + 10f + toolsW + 12f
            if (cardOpen) controls += HudControl("card",
                if (portrait) HudRect(0f, cardTop, W, cardH) else HudRect(W - cardR - CARD_W, sa.top + 120f, CARD_W, cardH))

            // ---- next/previous (choose mode without a card: "Next open deed ▶"): above the card (portrait) or bottom-centre
            //      of the free map area (wide) ----
            val navBottom: Float
            val nextOpen = i.choose && !cardOpen
            val navId = if (nextOpen) "nextOpen" else "nav"
            val navW = if (nextOpen) nextOpenW(t) else NAV_W
            if (portrait) {
                navBottom = cardH + 10f + (if (cardOpen) 0f else sa.bottom)
                controls += HudControl(navId, HudRect(((W - navW) / 2f).roundToInt().toFloat(), H - navBottom - 48f, navW, 48f))
            } else {
                navBottom = 14f + sa.bottom
                val free = if (cardOpen) W - CARD_W - cardR else W
                val clearMini = m.x + (if (miniShown) m.w + 8f else 0f) + 48f + 12f + navW / 2f
                controls += HudControl(navId, HudRect((max(free / 2f, clearMini) - navW / 2f).roundToInt().toFloat(), H - navBottom - 48f, navW, 48f))
            }

            // ---- scale pill: above the ◀ ▶ row (portrait) or above the minimap (wide) ----
            val scaleW = (4f + 8f + 10f + (i.scaleBarW + 4f) + 8f + HudType.textWidth(i.scaleLabel.length, t.ui)).roundUp()
            val scaleBottom = if (portrait) navBottom + 48f + 8f else if (miniShown) H - m.y + 8f else 70f + sa.bottom
            controls += HudControl("scale", HudRect(if (portrait) 10f + sa.left else m.x, H - scaleBottom - SCALE_H, scaleW, SCALE_H))

            return RealmHudPlan(portrait, controls, safeBox, cardMax, miniShown, chipsRow, cardR, focusTop)
        }

        private fun Float.roundUp(): Float = kotlin.math.ceil(this)
    }
}

private fun Float.roundToFloat(): Float = roundToInt().toFloat()
