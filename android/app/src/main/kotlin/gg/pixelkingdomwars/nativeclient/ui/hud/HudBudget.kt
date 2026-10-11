package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.DeckButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckToolUi
import gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceDrawerUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceRowUi

/*
 * Design component: the Home HUD space budget (owner addendum 5 and 6, DESIGN-SYSTEM §2 rule 1, `home-budget.png`).
 *
 * The owner's binding rule: on a 412 × 915 dp phone the permanent Home HUD covers at most 12 % of the screen with nothing
 * selected, and shows at most four permanent readouts. The design measured its mock at 11.9 % (44,790 of 376,980 dp²)
 * as the union of every painted HUD box. This file is that measurement as plain Kotlin, and the layout plan HomeHud
 * draws from, so what is measured is what is drawn:
 *
 * - [HudGeometry] holds every position and size of `home.html` in whole dp. HomeHud lays its zones out with these
 *   constants, so changing a size here changes both the drawing and the budget.
 * - [homeHudPlan] decides what is shown: at most 4 resource rows, right-edge buttons only while they carry a badge and
 *   only as many as fit the 12 % budget (the rest fold into the top one as "+n"), at most 2 left tabs, at most 4 deck
 *   buttons split into the two bottom corners. A selection hides the left cluster, the edges and the deck; the
 *   resource stack stays because costs are compared against it.
 * - [homeHudCoverage] is the covered fraction of the 412 × 915 screen. Window insets and transient pieces (herald,
 *   context chip, world markers, badges) are excluded exactly as the design's measurement excluded them; the transient
 *   context chip is measured apart by [homeHudTransientRects] (home-budget.png counts it cyan, not magenta).
 *
 * Pure: no Compose, no Android. JVM-tested in HudBudgetTest.
 */

/** Every Home HUD position and size of `design/final/home.html`, in dp on the 412 × 915 reference phone. */
object HudGeometry {
    const val SCREEN_W = 412
    const val SCREEN_H = 915

    /** Screen gutter (TOKENS.json `space.screenGutter`). */
    const val GUTTER = 8

    /** Level badge: 40 × 40 at (8, 10); its 48 dp touch target is centred on it. */
    const val LEVEL_X = 8
    const val LEVEL_Y = 10
    const val LEVEL = 40

    /** Status chip: one 30 dp veil at (44, 15), at most 238 wide (it wraps its segments; the budget counts the maximum).
     *  DESIGN-SYSTEM §6 says 238; the final home.html draws a 252 dp box, which this measurement would put at 12.09 %,
     *  over the owner's 12 %. The owner's budget wins, so the cap stays 238 (2026-10-06, noted for the owner). */
    const val STATUS_X = 44
    const val STATUS_Y = 15
    const val STATUS_W_MAX = 238
    const val STATUS_H = 30

    /** Resource stack: 108 wide, 26 dp rows 2 dp apart, top at y 10, 8 dp from the right edge. */
    const val STACK_TOP = 10
    const val STACK_W = 108
    const val ROW_H = 26
    const val ROW_GAP = 2

    /** Right edge buttons: 48 × 48, 12 dp from the right edge, the first at y 142; the outlined label pill sits 2 dp
     *  below, centred, at most 74 wide and 24 tall (the display-face caption fallback is 22 sp tall). */
    const val EDGE = 48
    const val EDGE_RIGHT = 12
    const val EDGE_TOP = 142
    const val EDGE_LABEL_GAP = 2
    const val EDGE_LABEL_H = 24
    const val EDGE_LABEL_W_MAX = 74
    const val EDGE_SPACING = 12

    /** Left edge tabs: 44 × 48 flush with the left edge, 4 dp apart; the lowest one ends 103 dp above the screen bottom
     *  (CHAT at y 764 in the mock, MAIL at 712). home.html `.chat`: an ink shell padded 3 top / 3 right / 5 bottom / 0
     *  left, square on the screen side, 4 dp stepped corners on the right; the badge's left edge sits 30 dp in, 10 dp up. */
    const val TAB_W = 44
    const val TAB_H = 48
    const val TAB_BADGE_X = 30
    const val TAB_BADGE_Y = -10
    const val TAB_GAP = 4
    const val TABS_BOTTOM = 103
    const val MAX_LEFT_TABS = 2

    /** Bottom deck: 14 dp above the bottom, 4 dp apart, 8 dp gutters. ATTACK 80 × 72, BUILD 72 × 72, ARMY / MAP 52 × 52. */
    const val DECK_BOTTOM = 14
    const val DECK_GAP = 4
    const val DECK_FIRST_W = 80
    const val DECK_PRIMARY = 72
    const val DECK_SMALL = 52
    const val MAX_DECK = 4

    /** Tools shelf (transient, the folded LAYOUT · EXPAND · FIT dock row): up to 3 small deck faces, 52 × 52, 4 dp apart,
     *  in one row 8 dp above BUILD's corner, flush with that corner's gutter. Shown only after a long-press on BUILD, so
     *  it is excluded from the permanent budget exactly like the drawer. */
    const val TOOL = DECK_SMALL
    const val TOOLS_GAP_ABOVE_DECK = 8
    const val MAX_TOOLS = 3

    /** Context chip (transient): 108 × 48, centred in the gap between the deck corners ([contextChipRect]). Its 32 dp icon
     *  box pokes out 6 dp left of and 8 dp above the card (home.html: icon at (150, 845), card at (156, 853)). */
    const val CONTEXT_W = 108
    const val CONTEXT_H = 48
    const val CONTEXT_ICON = 32
    const val CONTEXT_ICON_X = -6
    const val CONTEXT_ICON_Y = -8

    /** Herald banner (transient; hub SPEC §3.1, `hub/toasts.png`): 44 tall at (8, 128), under the top bar and the full
     *  four-row resource stack (which ends at y 120), one line wide. It ends [HERALD_END] short of the right edge, so it
     *  clears the QUESTS edge button (x 352) on any width: 336 wide on the 412 dp phone. (It was at y 56 beside the stack,
     *  280 wide, which wrapped "Buy land to join the world map" onto two lines; owner screenshot 2026-10-06.) */
    const val HERALD_TOP = 128
    const val HERALD_H = 44
    const val HERALD_END = EDGE_RIGHT + EDGE + GUTTER
    const val HERALD_W_MAX = SCREEN_W - GUTTER - HERALD_END
}

/** The owner's budget as a fraction (12 % → 0.12). */
const val HOME_HUD_BUDGET: Float = PkwTokens.Budget.HOME_PERMANENT_HUD_MAX_PCT / 100f

/** One painted HUD box in dp. */
data class HudRect(val left: Int, val top: Int, val width: Int, val height: Int) {
    val right: Int get() = left + width
    val bottom: Int get() = top + height
}

/** One bottom-deck button with its size and its corner (true = bottom-left group). */
data class DeckSlot(val button: DeckButtonUi, val width: Int, val height: Int, val leftCorner: Boolean)

/** What HomeHud draws at rest, after the budget rules. */
data class HomeHudPlan(
    /** Level badge + status chip. */
    val leftCluster: Boolean,
    /** The permanent readouts, top to bottom (≤ 4). */
    val resources: List<ResourceChipUi>,
    /** Right edge buttons shown, top to bottom. */
    val rightEdge: List<EdgeButtonUi>,
    /** How many badged right-edge buttons were folded into the top one ("+n"). */
    val rightEdgeFolded: Int,
    /** Left edge tabs, top to bottom (≤ 2). */
    val leftEdge: List<EdgeButtonUi>,
    /** Deck buttons, left to right on screen (mirroring applied). */
    val deck: List<DeckSlot>,
    /** The open tools shelf, left to right (≤ [HudGeometry.MAX_TOOLS]); empty while closed. Transient: not in [homeHudRects]. */
    val tools: List<DeckToolUi> = emptyList(),
    /** True when the shelf sits over the bottom-left corner (BUILD is there: the mirrored deck). */
    val toolsLeft: Boolean = false,
) {
    /** Permanent readouts on Home: the resource stack rows (owner addendum 6: three or four). */
    val permanentReadouts: Int get() = resources.size
}

/** Stack height for [rows] rows. */
fun stackHeight(rows: Int): Int = if (rows <= 0) 0 else rows * HudGeometry.ROW_H + (rows - 1) * HudGeometry.ROW_GAP

/** The y of right-edge button [index] (0 = top). */
fun edgeTop(index: Int): Int = HudGeometry.EDGE_TOP +
    index * (HudGeometry.EDGE + HudGeometry.EDGE_LABEL_GAP + HudGeometry.EDGE_LABEL_H + HudGeometry.EDGE_SPACING)

/** The y of left tab [index] (0 = top) when [count] tabs show; the lowest always ends [HudGeometry.TABS_BOTTOM] up. */
fun tabTop(index: Int, count: Int): Int = HudGeometry.SCREEN_H - HudGeometry.TABS_BOTTOM -
    (count - index) * HudGeometry.TAB_H - (count - 1 - index) * HudGeometry.TAB_GAP

/**
 * The deck in screen order. Sizes follow the button, not the corner: the first button of [deck] (ATTACK) is 80 × 72
 * when primary, any other primary (BUILD) 72 × 72, the rest 52 × 52. The first half (rounded up) sits in the bottom-left
 * corner, the rest in the bottom-right; [mirrored] (the left-handed setting) reverses the order.
 */
fun deckSlots(deck: List<DeckButtonUi>, mirrored: Boolean): List<DeckSlot> {
    val sized = deck.take(HudGeometry.MAX_DECK).mapIndexed { index, button ->
        val w = when { !button.primary -> HudGeometry.DECK_SMALL; index == 0 -> HudGeometry.DECK_FIRST_W; else -> HudGeometry.DECK_PRIMARY }
        val h = if (button.primary) HudGeometry.DECK_PRIMARY else HudGeometry.DECK_SMALL
        Triple(button, w, h)
    }
    val ordered = if (mirrored) sized.asReversed() else sized
    val leftCount = (ordered.size + 1) / 2
    return ordered.mapIndexed { i, (button, w, h) -> DeckSlot(button, w, h, i < leftCount) }
}

/**
 * The layout plan for [ui] (see the file comment). Right-edge buttons with no badge are never shown (DESIGN-SYSTEM §6
 * EdgeButton); of the badged ones at most [PkwTokens.Budget.MAX_EDGE_BUTTONS] show, then the lowest are folded into
 * the top one while the HUD would exceed [HOME_HUD_BUDGET]. The top one always shows, so a badge is never lost.
 */
fun homeHudPlan(ui: HomeHudUi): HomeHudPlan {
    val resources = ui.resources.take(PkwTokens.Budget.MAX_RESOURCE_ROWS)
    if (!ui.deckVisible) return HomeHudPlan(false, resources, emptyList(), 0, emptyList(), emptyList())
    // QUESTS remains a navigation door even when no reward badge is ready.
    val badged = ui.rightEdge.filter { it.badge != null || it.id == HudIds.QUESTS }
    val left = ui.leftEdge.take(HudGeometry.MAX_LEFT_TABS)
    val deck = deckSlots(ui.deck, ui.mirrored)
    var shown = badged.take(PkwTokens.Budget.MAX_EDGE_BUTTONS)
    // The shelf rides BUILD's corner (the right one unless the deck is mirrored); without a BUILD it has no door.
    val buildSlot = deck.firstOrNull { it.button.id == HudIds.BUILD }
    val tools = if (ui.toolsOpen && buildSlot != null) ui.tools.take(HudGeometry.MAX_TOOLS) else emptyList()
    fun plan() = HomeHudPlan(true, resources, shown, badged.size - shown.size, left, deck, tools, buildSlot?.leftCorner == true)
    while (shown.size > 1 && coveredFraction(plan()) > HOME_HUD_BUDGET) shown = shown.dropLast(1)
    return plan()
}

/** True when [ui] gives BUILD a long-press that opens the tools shelf: tools exist and BUILD is on the deck. */
fun hasDeckTools(ui: HomeHudUi): Boolean = ui.tools.isNotEmpty() && ui.deck.take(HudGeometry.MAX_DECK).any { it.id == HudIds.BUILD }

/** The open tools shelf's boxes in dp on the reference phone, left to right (empty while closed). Transient, so never
 *  part of [homeHudRects] / [homeHudCoverage]; HudBudgetTest checks it clears the deck and stays on screen. */
fun homeHudToolRects(plan: HomeHudPlan): List<HudRect> {
    if (plan.tools.isEmpty()) return emptyList()
    val g = HudGeometry
    val top = g.SCREEN_H - g.DECK_BOTTOM - g.DECK_PRIMARY - g.TOOLS_GAP_ABOVE_DECK - g.TOOL
    val width = plan.tools.size * g.TOOL + (plan.tools.size - 1) * g.DECK_GAP
    val left = if (plan.toolsLeft) g.GUTTER else g.SCREEN_W - g.GUTTER - width
    return plan.tools.indices.map { i -> HudRect(left + i * (g.TOOL + g.DECK_GAP), top, g.TOOL, g.TOOL) }
}

/**
 * Where the "+n" of [plan]'s folded right-edge buttons goes (design ruling 092decf3 item 6): [HomeHudUi.rightEdgeOverflow]
 * (the hub row at its notices, where every folded candidate is listed) while at least one badged button is folded and
 * an edge button is shown to carry it; null otherwise (then "+n" is not drawn as a door). The first shown button keeps
 * dispatching its own id either way.
 */
fun edgeOverflowTarget(plan: HomeHudPlan, ui: HomeHudUi): gg.pixelkingdomwars.nativeclient.ui.features.FeatureId? =
    ui.rightEdgeOverflow?.takeIf { plan.rightEdgeFolded > 0 && plan.rightEdge.isNotEmpty() }

/** Every painted permanent box of [plan], in dp on the reference phone. */
fun homeHudRects(plan: HomeHudPlan): List<HudRect> = buildList {
    val g = HudGeometry
    if (plan.leftCluster) {
        add(HudRect(g.LEVEL_X, g.LEVEL_Y, g.LEVEL, g.LEVEL))
        add(HudRect(g.STATUS_X, g.STATUS_Y, g.STATUS_W_MAX, g.STATUS_H))
    }
    if (plan.resources.isNotEmpty()) add(HudRect(g.SCREEN_W - g.GUTTER - g.STACK_W, g.STACK_TOP, g.STACK_W, stackHeight(plan.resources.size)))
    plan.rightEdge.indices.forEach { i ->
        val x = g.SCREEN_W - g.EDGE_RIGHT - g.EDGE
        val top = edgeTop(i)
        add(HudRect(x, top, g.EDGE, g.EDGE))
        add(HudRect(x + g.EDGE / 2 - g.EDGE_LABEL_W_MAX / 2, top + g.EDGE + g.EDGE_LABEL_GAP, g.EDGE_LABEL_W_MAX, g.EDGE_LABEL_H))
    }
    plan.leftEdge.indices.forEach { i -> add(HudRect(0, tabTop(i, plan.leftEdge.size), g.TAB_W, g.TAB_H)) }
    val base = g.SCREEN_H - g.DECK_BOTTOM
    var x = g.GUTTER
    plan.deck.filter { it.leftCorner }.forEach { add(HudRect(x, base - it.height, it.width, it.height)); x += it.width + g.DECK_GAP }
    var right = g.SCREEN_W - g.GUTTER
    plan.deck.filter { !it.leftCorner }.asReversed().forEach { add(HudRect(right - it.width, base - it.height, it.width, it.height)); right -= it.width + g.DECK_GAP }
}

/** The union area of [rects] clipped to the screen, in dp² (overlaps count once, as the design's pixel mask did). */
fun coveredArea(rects: List<HudRect>, screenW: Int = HudGeometry.SCREEN_W, screenH: Int = HudGeometry.SCREEN_H): Long {
    val clipped = rects.mapNotNull { r ->
        val l = r.left.coerceIn(0, screenW); val t = r.top.coerceIn(0, screenH)
        val rr = r.right.coerceIn(0, screenW); val b = r.bottom.coerceIn(0, screenH)
        if (rr > l && b > t) HudRect(l, t, rr - l, b - t) else null
    }
    val xs = clipped.flatMap { listOf(it.left, it.right) }.distinct().sorted()
    val ys = clipped.flatMap { listOf(it.top, it.bottom) }.distinct().sorted()
    var area = 0L
    for (i in 0 until xs.size - 1) for (j in 0 until ys.size - 1) {
        val cx = xs[i]; val cy = ys[j]
        if (clipped.any { cx >= it.left && cx < it.right && cy >= it.top && cy < it.bottom }) {
            area += (xs[i + 1] - xs[i]).toLong() * (ys[j + 1] - ys[j])
        }
    }
    return area
}

/** The covered fraction (0..1) of the 412 × 915 screen for [plan]. */
fun coveredFraction(plan: HomeHudPlan): Float =
    coveredArea(homeHudRects(plan)).toFloat() / (HudGeometry.SCREEN_W.toLong() * HudGeometry.SCREEN_H).toFloat()

/** The covered fraction (0..1) of the 412 × 915 screen the permanent Home HUD takes for [ui]. */
fun homeHudCoverage(ui: HomeHudUi): Float = coveredFraction(homeHudPlan(ui))

/**
 * The transient context chip's box on a [screenW] × [screenH] dp screen (DESIGN-SYSTEM §6 ContextChip, home.html `.next`):
 * on the deck baseline, centred in the gap between the two deck corner groups (x 156 on the 412 dp phone: ARMY ends at
 * 144, MAP starts at 276; not the screen centre, because ATTACK is wider than BUILD). When the gap cannot hold it with a
 * deck gap on each side (a narrow phone) it rises above the 52 dp deck buttons, centred, instead of covering a button.
 * Null without a deck. Transient: never part of [homeHudRects].
 */
fun contextChipRect(deck: List<DeckSlot>, screenW: Int = HudGeometry.SCREEN_W, screenH: Int = HudGeometry.SCREEN_H): HudRect? {
    if (deck.isEmpty()) return null
    val g = HudGeometry
    val leftEnd = g.GUTTER + cornerWidth(deck.filter { it.leftCorner })
    val rightStart = screenW - g.GUTTER - cornerWidth(deck.filter { !it.leftCorner })
    val gap = rightStart - leftEnd
    val baseline = screenH - g.DECK_BOTTOM
    return if (gap >= g.CONTEXT_W + 2 * g.DECK_GAP) HudRect(leftEnd + (gap - g.CONTEXT_W) / 2, baseline - g.CONTEXT_H, g.CONTEXT_W, g.CONTEXT_H)
    else HudRect((screenW - g.CONTEXT_W) / 2, baseline - g.DECK_SMALL - g.DECK_GAP - g.CONTEXT_H, g.CONTEXT_W, g.CONTEXT_H)
}

/** One deck corner group's width: its buttons plus the gaps between them. */
private fun cornerWidth(slots: List<DeckSlot>): Int =
    if (slots.isEmpty()) 0 else slots.sumOf { it.width } + (slots.size - 1) * HudGeometry.DECK_GAP

/**
 * The transient boxes Home draws at rest over the scene, in dp: the context chip and its icon poking out ([contextShown]),
 * measured apart from the permanent HUD exactly as home-budget.png does (cyan, not magenta). World markers are anchored
 * to sprites and capped by their own layers. Empty while a selection hides the deck.
 */
fun homeHudTransientRects(plan: HomeHudPlan, contextShown: Boolean): List<HudRect> {
    if (!contextShown) return emptyList()
    val chip = contextChipRect(plan.deck) ?: return emptyList()
    val g = HudGeometry
    return listOf(chip, HudRect(chip.left + g.CONTEXT_ICON_X, chip.top + g.CONTEXT_ICON_Y, g.CONTEXT_ICON, g.CONTEXT_ICON))
}

/** The dp size an edge or deck icon is drawn at: 64 px Phase E art (`ui:`) and 32 px items (`itm_`) at 32, 56 px
 *  portraits at 28, drawn glyphs (`shape:`) at 24, other 24 px art at 36 on edge buttons and big deck buttons, 24 on
 *  small deck buttons (DESIGN-SYSTEM §4 Pixel art: integer scales only). */
fun hudIconDp(icon: String, large: Boolean): Int = when {
    icon.startsWith("ui:") || icon.startsWith("pkw_ui_") || icon.startsWith("itm_") -> 32
    icon.contains("portrait") -> 28
    icon.startsWith("shape:") -> 24
    large -> 36
    else -> 24
}

/** The dp a deck face asks for its icon before [deckStack] fits it: [hudIconDp], except that a portrait over a fill
 *  meter on a small face asks for [hudIconDp]'s small-face size, 24, since the 52 dp face holds no 28 dp portrait above
 *  a meter and a caption (owner 2026-10-06, K-night-A10). */
fun deckIconDp(icon: String, large: Boolean, meter: Boolean): Int =
    if (meter && !large && icon.contains("portrait")) 24 else hudIconDp(icon, large)

/** Where [deckStack] puts a deck face's icon (an [icon] square), fill meter and caption: tops from the top of the face's
 *  room, in the unit the caller measured in (device px). */
data class DeckStack(val icon: Int, val iconTop: Int, val meterTop: Int, val captionTop: Int)

/**
 * Stacks a deck face's icon over its fill meter and caption inside [room], the face between its rim and its lip (owner
 * 2026-10-06, K-night-A10: ARMY's portrait was drawn above its button and the caption sank into the lip). The caption
 * and the meter keep their measured heights, so the caption is never squeezed; the icon is drawn at [icon] or at what the
 * face has left above them. A portrait rises [lift] into the face's top band (home.html ARMY `margin-top:-4px`) only
 * when the face still holds the whole stack lifted. The stack is centred; only a caption and meter taller than the face
 * itself (an extreme font scale, the icon already at 0) overflow it, evenly.
 */
fun deckStack(room: Int, icon: Int, lift: Int, meter: Int, caption: Int): DeckStack {
    val drawn = icon.coerceAtMost(room - meter - caption).coerceAtLeast(0)
    val stack = drawn + meter + caption
    val raised = if (stack + lift <= room) lift else 0
    // A lifted icon in a centred stack: the whole stack sits half the lift higher (as the old negative margin did).
    val top = (room - stack - raised).floorDiv(2)
    return DeckStack(drawn, top, top + drawn, top + drawn + meter)
}

/** The two left-edge tab marks home.html draws in code (no authored art exists for either). */
enum class EdgeTabMark {
    /** The cream envelope with a tan flap and a red seal. */
    MAIL,
    /** The cream speech pill with three ink dots. */
    CHAT,
}

/** The drawn mark an edge tab's icon names (the registry's `shape:envelope` / `shape:speech` and their `mail` / `chat`
 *  glyph aliases), or null for any other icon, which the tab draws with PkwIcon. */
fun edgeTabMark(icon: String): EdgeTabMark? = when (icon) {
    "shape:envelope", "shape:mail" -> EdgeTabMark.MAIL
    "shape:speech", "shape:chat" -> EdgeTabMark.CHAT
    else -> null
}

/** The drawer row the info card shows: the row with [ResourceDrawerUi.focusRowId], else the first row; null when the
 *  drawer has no rows at all. */
fun drawerFocus(ui: ResourceDrawerUi): ResourceRowUi? {
    val rows = ui.groups.flatMap { it.rows }
    return rows.firstOrNull { it.id == ui.focusRowId } ?: rows.firstOrNull()
}
