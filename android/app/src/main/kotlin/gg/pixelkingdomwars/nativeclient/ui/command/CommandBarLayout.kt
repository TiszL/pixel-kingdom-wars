package gg.pixelkingdomwars.nativeclient.ui.command

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/*
 * Design component: the placement rules of the selected-building surfaces (DESIGN-SYSTEM §6 CommandBar / NamePlate,
 * design/final/buildings/SPEC.md §1.3). Pure Kotlin, no Compose: every number here is a pixel, the caller passes the
 * density. JVM-tested in `CommandBarLayoutTest`.
 *
 * The rules, in one place:
 * - The bar lives in the bottom deck area (the band the deck slides out of): a 2-step shelf from H-163 dp to the bottom,
 *   secondaries 68 × 68 at x 16 + i × 88 with their tops at H-107, the 120 × 92 primary at W-136 with its top at H-127,
 *   a cost pill 30 dp above a priced button and the hint pill 38 dp above the shelf (H = height above the bottom inset).
 * - It never covers the selected building: when the anchor (the sprite's visible bounds) reaches into that band, the bar
 *   flips to the top, below the resource stack. If both bands would cover it, the smaller overlap wins and the result
 *   says so ([CommandBarPlacement.coversAnchor]) so the caller can ease the camera.
 * - It never leaves the screen: on a narrow screen the pitch closes from 88 to 72 dp, then the right-most secondaries
 *   are dropped (INFO and the primary always stay; [CommandBarPlacement.dropped] names the rest, fail loud).
 * - The name plate sits 16 dp above the sprite, centred and clamped 8 dp from the edges; it moves left of the resource
 *   stack, then below the selection ring, and never over the anchor, the stack or the bar.
 */

/** A rectangle in pixels (screen space: the overlay root fills the screen, so its local pixels are screen pixels). */
data class PxRect(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
    val centerX: Float get() = (left + right) / 2f

    /** True when the two rectangles share some area (touching edges do not count). */
    fun intersects(other: PxRect): Boolean = left < other.right && other.left < right && top < other.bottom && other.top < bottom

    /** The shared area in px² (0 when they do not intersect). */
    fun overlapArea(other: PxRect): Float =
        max(0f, min(right, other.right) - max(left, other.left)) * max(0f, min(bottom, other.bottom) - max(top, other.top))

    /** True when this rectangle lies wholly inside [outer]. */
    fun within(outer: PxRect): Boolean = left >= outer.left && top >= outer.top && right <= outer.right && bottom <= outer.bottom
}

/** Safe-drawing insets in pixels (status bar, navigation / gesture bar, cut-outs). */
data class PxInsets(val left: Float = 0f, val top: Float = 0f, val right: Float = 0f, val bottom: Float = 0f)

/** Where the command bar sits. */
enum class BarSide {
    /** The bottom deck area (the default; the right thumb). */
    BOTTOM,
    /** Under the resource stack, because the selected building stands in the bottom band. */
    TOP,
}

/** What the layout needs to know about one command (in bar order, the primary last). */
data class CommandSlotSpec(val primary: Boolean, val priced: Boolean)

/**
 * One placed command. [index] is the command's index in the list given to [commandBarPlacement]; [button] is its chunky
 * face (68 × 68 or 120 × 92); [column] adds the cost pill above and, for a secondary, the caption below.
 */
data class CommandSlot(val index: Int, val button: PxRect, val column: PxRect)

/**
 * The bar's placement. [band] is the 36 % shelf band and [step] the 18 % step (both paint only, never touch targets);
 * [footprint] is everything the bar paints, hint included, and is what must not cover the anchor. [hintTop] is the hint
 * pill's top when a hint is shown; [pillTop] is where the hint (or a transient reason pill) goes on this side either
 * way. [dropped] lists the input indices that did not fit.
 */
data class CommandBarPlacement(
    val side: BarSide,
    val band: PxRect,
    val step: PxRect,
    val footprint: PxRect,
    val slots: List<CommandSlot>,
    val dropped: List<Int>,
    val hintTop: Float?,
    val coversAnchor: Boolean,
    val pillTop: Float,
)

/** Which side of the building the name plate took. */
enum class PlateSide { ABOVE, BELOW }

/** The name plate's rectangle, its 4 dp ink stem (height 0 when there is no room for one) and its side. */
data class NamePlatePlacement(val plate: PxRect, val stem: PxRect, val side: PlateSide, val coversAnchor: Boolean)

/** The design's geometry in dp (DESIGN-SYSTEM §6, buildings/SPEC.md §1.3, TOKENS.json `size`). */
object CommandBarMetrics {
    const val SIDE = 16f
    const val PITCH = 88f
    /** The tightest pitch: the 68 dp face plus a 4 dp gap. Below it secondaries are dropped, never overlapped. */
    const val MIN_PITCH = 72f
    const val BUTTON = 68f
    const val PRIMARY_W = 120f
    const val PRIMARY_H = 92f
    /** Space kept between the last secondary and the primary. */
    const val PRIMARY_GAP = 8f
    /** A cost pill's top sits this far above its button's top (TOKENS `costPillAbove`). */
    const val PILL_ABOVE = 30f
    /** Caption gap (5) plus one line of the caption style. */
    const val CAPTION = 29f
    /** The deck area: shelf top to the bottom inset. */
    const val BLOCK_H = 163f
    const val STEP_H = 16f
    /** Button tops measured up from the bottom inset (H-127, H-107). */
    const val PRIMARY_TOP_FROM_BOTTOM = 127f
    const val SECONDARY_TOP_FROM_BOTTOM = 107f
    /** The primary's top sits this far above a secondary's top (127 - 107). */
    const val PRIMARY_RISE = 20f
    const val HINT_ABOVE = 38f
    const val HINT_H = 32f
    /** The resource stack: 108 wide, 8 from the right, rows from y 10 to y 118 under the top inset. */
    const val STACK_TOP = 10f
    const val STACK_BOTTOM = 118f
    const val STACK_RIGHT = 8f
    const val STACK_W = 108f
    /** Breathing room between the stack (or a screen edge) and anything placed next to it. */
    const val MARGIN = 8f
    /** Name plate: 16 above the sprite top, a 4 dp stem that overlaps plate and roof by 2 dp each. */
    const val PLATE_GAP = 16f
    const val STEM_W = 4f
    const val STEM_OVERLAP = 2f
    const val STEM_INSET = 8f
    /** Selection ring (SPEC §1.3): width max(104, 1.45 × sprite width), height 0.53 × width, centred 12 above the sprite bottom. */
    const val RING_MIN_W = 104f
    const val RING_W_FACTOR = 1.45f
    const val RING_H_FACTOR = 0.53f
    const val RING_LIFT = 12f
}

/**
 * How many commands the bar may show on a [screenW] × [screenH] screen (design correction 7, design ruling 5ed31eb8
 * item 1): at most FOUR in portrait (INFO, up to two secondaries, the primary; a fifth action lives inside the INFO
 * sheet), up to five in landscape. A square screen counts as portrait. Feed it to `orderCommands(commands, max)`, which
 * keeps INFO first and the primary last.
 */
fun commandBarLimit(screenW: Float, screenH: Float): Int =
    if (screenH >= screenW) gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Budget.MAX_COMMANDS_PORTRAIT
    else gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Budget.MAX_COMMANDS

/** The resource stack's rectangle (DESIGN-SYSTEM §6 TopBar); the stack stays on screen while a building is selected. */
fun resourceStackRect(screenW: Float, density: Float, insets: PxInsets = PxInsets()): PxRect {
    val m = CommandBarMetrics
    val right = screenW - insets.right - m.STACK_RIGHT * density
    return PxRect(right - m.STACK_W * density, insets.top + m.STACK_TOP * density, right, insets.top + m.STACK_BOTTOM * density)
}

/**
 * Places the command bar for [specs] (already in bar order, see `orderCommands`) on a [screenW] × [screenH] px screen.
 * [anchor] is the selected sprite's visible bounds in the same px space (null: unknown, the bar stays at the bottom).
 * [previous] is the side used for the same building last time: it is kept while it still clears the anchor, so the
 * bar does not jump as the camera pans.
 */
fun commandBarPlacement(
    screenW: Float, screenH: Float, density: Float, insets: PxInsets, specs: List<CommandSlotSpec>,
    anchor: PxRect?, hint: Boolean, previous: BarSide? = null,
): CommandBarPlacement {
    val (slotsX, dropped) = horizontalSlots(screenW, density, insets, specs)
    val bottom = verticalFrame(BarSide.BOTTOM, screenW, screenH, density, insets, hint)
    val top = verticalFrame(BarSide.TOP, screenW, screenH, density, insets, hint)
    val frames = mapOf(BarSide.BOTTOM to bottom, BarSide.TOP to top)
    val order = listOfNotNull(previous, BarSide.BOTTOM, BarSide.TOP).distinct()
    val clear = if (anchor == null) order.first() else order.firstOrNull { !frames.getValue(it).footprint.intersects(anchor) }
    val side = clear ?: order.minByOrNull { frames.getValue(it).footprint.overlapArea(anchor!!) }!!
    val frame = frames.getValue(side)
    val slots = slotsX.map { (index, left, width) ->
        val spec = specs[index]
        val buttonTop = if (spec.primary) frame.primaryTop else frame.secondaryTop
        val button = PxRect(left, buttonTop, left + width, buttonTop + (if (spec.primary) CommandBarMetrics.PRIMARY_H else CommandBarMetrics.BUTTON) * density)
        val columnTop = if (spec.priced) buttonTop - CommandBarMetrics.PILL_ABOVE * density else buttonTop
        val columnBottom = if (spec.primary) button.bottom else button.bottom + CommandBarMetrics.CAPTION * density
        CommandSlot(index, button, PxRect(left, columnTop, left + width, columnBottom))
    }
    return CommandBarPlacement(side, frame.band, frame.step, frame.footprint, slots, dropped, frame.hintTop,
        coversAnchor = clear == null && anchor != null, pillTop = frame.pillTop)
}

/** (input index, left px, width px) for each command that fits, and the indices dropped. */
private fun horizontalSlots(screenW: Float, density: Float, insets: PxInsets, specs: List<CommandSlotSpec>): Pair<List<Triple<Int, Float, Float>>, List<Int>> {
    val m = CommandBarMetrics
    val left = insets.left + m.SIDE * density
    val right = screenW - insets.right - m.SIDE * density
    val primaryIndex = specs.indexOfLast { it.primary }
    val secondaries = specs.indices.filter { it != primaryIndex }
    val out = mutableListOf<Triple<Int, Float, Float>>()
    var limit = right
    if (primaryIndex >= 0) {
        val w = m.PRIMARY_W * density
        val x = max(insets.left, right - w)
        out += Triple(primaryIndex, x, w)
        limit = x - m.PRIMARY_GAP * density
    }
    val face = m.BUTTON * density
    // How many secondaries fit at the tightest pitch; INFO (the first) is kept first, the right-most go first.
    val room = limit - left - face
    val fit = if (room < 0f) 0 else min(secondaries.size, floor(room / (m.MIN_PITCH * density)).toInt() + 1)
    val kept = secondaries.take(fit)
    val pitch = if (kept.size <= 1) m.PITCH * density else min(m.PITCH * density, room / (kept.size - 1))
    kept.forEachIndexed { i, index -> out += Triple(index, left + i * pitch, face) }
    return out.sortedBy { it.first } to secondaries.drop(fit)
}

private class Frame(val band: PxRect, val step: PxRect, val footprint: PxRect, val primaryTop: Float, val secondaryTop: Float,
    val hintTop: Float?, val pillTop: Float)

private fun verticalFrame(side: BarSide, screenW: Float, screenH: Float, density: Float, insets: PxInsets, hint: Boolean): Frame {
    val m = CommandBarMetrics
    fun dp(v: Float) = v * density
    return when (side) {
        BarSide.BOTTOM -> {
            val base = screenH - insets.bottom
            val shelfTop = base - dp(m.BLOCK_H)
            val pillTop = shelfTop - dp(m.HINT_ABOVE)
            val hintTop = if (hint) pillTop else null
            Frame(band = PxRect(0f, shelfTop + dp(m.STEP_H), screenW, screenH), step = PxRect(0f, shelfTop, screenW, shelfTop + dp(m.STEP_H)),
                footprint = PxRect(0f, hintTop ?: shelfTop, screenW, screenH),
                primaryTop = base - dp(m.PRIMARY_TOP_FROM_BOTTOM), secondaryTop = base - dp(m.SECONDARY_TOP_FROM_BOTTOM), hintTop = hintTop,
                pillTop = pillTop)
        }
        BarSide.TOP -> {
            // The highest thing the bar paints (a priced primary's pill) starts a margin under the resource stack.
            val costTop = insets.top + dp(m.STACK_BOTTOM + m.MARGIN)
            val primaryTop = costTop + dp(m.PILL_ABOVE)
            val secondaryTop = primaryTop + dp(m.PRIMARY_RISE)
            val bandTop = costTop - dp(m.MARGIN)
            val bandBottom = secondaryTop + dp(m.BUTTON + m.CAPTION + m.MARGIN)
            val stepBottom = bandBottom + dp(m.STEP_H)
            val pillTop = stepBottom + dp(m.MARGIN)
            val hintTop = if (hint) pillTop else null
            Frame(band = PxRect(0f, bandTop, screenW, bandBottom), step = PxRect(0f, bandBottom, screenW, stepBottom),
                footprint = PxRect(0f, bandTop, screenW, if (hintTop != null) hintTop + dp(m.HINT_H) else stepBottom),
                primaryTop = primaryTop, secondaryTop = secondaryTop, hintTop = hintTop, pillTop = pillTop)
        }
    }
}

/** The selection ring's bottom edge for a sprite with visible bounds [anchor] (buildings/SPEC.md §1.3 Selection). */
fun selectionRingBottom(anchor: PxRect, density: Float): Float {
    val m = CommandBarMetrics
    val ringW = max(m.RING_MIN_W * density, m.RING_W_FACTOR * anchor.width)
    return anchor.bottom - m.RING_LIFT * density + m.RING_H_FACTOR * ringW / 2f
}

/**
 * Places a [plateW] × [plateH] px name plate for the sprite at [anchor]. Candidates, first that fits wins: above the roof
 * (centred, clamped 8 dp from the edges), above but moved left of whatever it hit in [avoid] (the resource stack), below
 * the selection ring, below and moved left. "Fits" = fully on screen inside the insets, not over the anchor, not over
 * anything in [avoid] (pass the resource stack and the bar's footprint). If nothing fits, the plate goes above, clamped
 * onto the screen, and [NamePlatePlacement.coversAnchor] says whether it now covers the sprite.
 */
fun namePlatePlacement(
    screenW: Float, screenH: Float, density: Float, insets: PxInsets, anchor: PxRect,
    plateW: Float, plateH: Float, avoid: List<PxRect>,
): NamePlatePlacement {
    val m = CommandBarMetrics
    fun dp(v: Float) = v * density
    val minX = insets.left + dp(m.MARGIN)
    val maxX = max(minX, screenW - insets.right - dp(m.MARGIN) - plateW)
    val minY = insets.top + dp(m.MARGIN)
    val maxY = max(minY, screenH - insets.bottom - dp(m.MARGIN) - plateH)
    val screen = PxRect(minX, minY, max(minX + plateW, screenW - insets.right - dp(m.MARGIN)), max(minY + plateH, screenH - insets.bottom - dp(m.MARGIN)))
    val x0 = (anchor.centerX - plateW / 2f).coerceIn(minX, maxX)
    val ringBottom = selectionRingBottom(anchor, density)
    fun at(x: Float, y: Float) = PxRect(x, y, x + plateW, y + plateH)
    fun shiftedLeft(rect: PxRect): PxRect? {
        val hit = avoid.filter { it.intersects(rect) }.minByOrNull { it.left } ?: return null
        val x = hit.left - dp(m.MARGIN) - plateW
        return if (x < minX) null else at(x, rect.top)
    }
    fun ok(rect: PxRect) = rect.within(screen) && !rect.intersects(anchor) && avoid.none { it.intersects(rect) }
    val above = at(x0, anchor.top - dp(m.PLATE_GAP) - plateH)
    val below = at(x0, ringBottom + dp(m.PLATE_GAP))
    val candidates = listOfNotNull(above to PlateSide.ABOVE, shiftedLeft(above)?.let { it to PlateSide.ABOVE },
        below to PlateSide.BELOW, shiftedLeft(below)?.let { it to PlateSide.BELOW })
    val chosen = candidates.firstOrNull { ok(it.first) }
    val (plate, side) = chosen ?: (at(x0, above.top.coerceIn(minY, maxY)) to PlateSide.ABOVE)
    val stemLeft = (anchor.centerX - dp(m.STEM_W) / 2f).coerceIn(plate.left + dp(m.STEM_INSET), max(plate.left + dp(m.STEM_INSET), plate.right - dp(m.STEM_INSET + m.STEM_W)))
    val stem = when (side) {
        PlateSide.ABOVE -> PxRect(stemLeft, plate.bottom - dp(m.STEM_OVERLAP), stemLeft + dp(m.STEM_W), max(plate.bottom - dp(m.STEM_OVERLAP), anchor.top + dp(m.STEM_OVERLAP)))
        PlateSide.BELOW -> PxRect(stemLeft, min(plate.top + dp(m.STEM_OVERLAP), ringBottom - dp(m.STEM_OVERLAP)), stemLeft + dp(m.STEM_W), plate.top + dp(m.STEM_OVERLAP))
    }
    val noStem = chosen == null
    return NamePlatePlacement(plate, if (noStem) stem.copy(bottom = stem.top) else stem, side, coversAnchor = plate.intersects(anchor))
}

/** How one stretch of a name plate's state line is tinted (DESIGN-SYSTEM §6 NamePlate line 2, buildings/SPEC.md §1.5). */
enum class StateTone {
    /** The words around the numbers (muted). */
    MUTED,
    /** A count or ratio ("2/3", "8,400", "2>3"). */
    VALUE,
    /** A time left ("6h 20m", "0:42"): gold. */
    TIME,
    /** A leading "Ready": green. */
    READY,
    /** A leading "Spent": danger. */
    DANGER,
}

/** One tinted stretch of a state line. */
data class StateRun(val text: String, val tone: StateTone)

private val STATE_TIME = Regex("""\b\d+h(?: \d+m)?\b|\b\d+m(?: \d+s)?\b|\b\d+:\d{2}\b|\b\d+s\b""")
private val STATE_VALUE = Regex("""[^\s·]*\d[^\s·]*""")
private val STATE_LEAD = Regex("""^(Ready|Spent)\b""")

/**
 * Splits a server-formatted state line into tinted runs, so "Smelted 2/3 · pool 6h 20m" reads like the mock (muted words,
 * the count in text colour, the time in gold). The text itself is never changed: joining the runs gives the line back.
 */
fun stateLineRuns(line: String): List<StateRun> {
    if (line.isEmpty()) return emptyList()
    val tones = Array(line.length) { StateTone.MUTED }
    STATE_VALUE.findAll(line).forEach { m -> for (i in m.range) tones[i] = StateTone.VALUE }
    STATE_TIME.findAll(line).forEach { m -> for (i in m.range) tones[i] = StateTone.TIME }
    STATE_LEAD.find(line)?.let { m -> val t = if (m.value == "Spent") StateTone.DANGER else StateTone.READY; for (i in m.range) tones[i] = t }
    val runs = mutableListOf<StateRun>()
    var start = 0
    for (i in 1..line.length) {
        if (i == line.length || tones[i] != tones[start]) { runs += StateRun(line.substring(start, i), tones[start]); start = i }
    }
    return runs
}
