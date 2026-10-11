package gg.pixelkingdomwars.nativeclient.ui.boot

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import gg.pixelkingdomwars.nativeclient.ui.world.HudInsets
import gg.pixelkingdomwars.nativeclient.ui.world.HudRect
import gg.pixelkingdomwars.nativeclient.ui.world.HudType
import kotlin.math.max
import kotlin.math.min

/**
 * SHARDKEEP D-193 (owner 2026-09-28, relaying a teammate: "minimize the opening kingdom bar and place it on the bottom
 * of the screen, this way players can enjoy the view of the graphics while the game loads"): the loading UI is ONE slim
 * strip at the bottom of the screen, above the safe area, never a centred card. The bright wallpaper is the point.
 *
 * This planner is pure (dp, no Compose) so `LoadingStripPlanTest` pins the geometry per viewport class the way
 * `RealmHudPlanTest` pins the realm HUD: the strip's rect, the version label's rect, the fixed heights, that nothing
 * sits over the wallpaper's centre, and that the title and line 2 keep their width beside the widest buttons.
 * `LoadingStrip` places itself exactly here.
 *
 * Actions sit beside the column. Portrait uses a vertical action stack with two 48 dp touch targets,
 * keeping its fixed plate at 96 dp without an empty reserved row below the tip. Narrow text reserves
 * two title lines; a 32 dp sprite leaves room for the reason beside the action stack.
 * The version label stays at the bottom-left corner, outside the strip.
 */
class LoadingStripPlan private constructor(
    val compact: Boolean, val wide: Boolean,
    /** The strip's plate, in dp from the top-left of the screen. */
    val strip: HudRect,
    /** The version label's plate at the bottom-left corner; [labelBeside] when it shares the strip's baseline, else it sits under the strip. */
    val label: HudRect, val labelBeside: Boolean,
    val padding: Float, val sprite: Float, val gap: Float,
    /** Text sizes in sp (Compose scales them by the font scale); [titleLine] and [tipLine] are the scaled dp lines. */
    val titleSp: Float, val titleLine: Float, val titleLines: Int, val tipSp: Float, val tipLineSp: Float, val tipLine: Float, val categorySp: Float,
    /** Line 2's reserved height: two tip lines, on every layout. */
    val lineSlot: Float,
    /** The meter block: [meterGap] above and below the 4 dp track. */
    val meterGap: Float,
    /** The column's width: the strip less its padding, the sprite and the gap. The buttons beside the
     * text take their width from it: one fixed-width portrait stack, or a row on wide layouts. */
    val column: Float,
) {
    companion object {
        const val GUTTER = 16f
        const val MAX_WIDTH = 560f
        const val BOTTOM_GAP_PHONE = 12f
        const val BOTTOM_GAP_DESKTOP = 24f
        /** The pixel-stepped meter: a 1 dp ink border around 4 dp blocks (owner 2026-10-06 "improve visually"). */
        const val METER = 6f
        /** Owner 2026-10-06: one 8 dp padding on every layout (it was 6 / 8 / 10), inside the kit plate's rim and lip. */
        const val PADDING = 8f
        const val TAP = 48f
        const val LABEL_SP = 12f
        const val LABEL_H = 16f            // 12 sp line + 2 dp plate padding top and bottom
        const val LABEL_GAP = 4f
        const val ACTIONS_GAP = 8f

        /** A strip button's width: its label at [STRIP_BUTTON_SP] with the chrome's 1 sp letter-spacing, plus the
         * forged plate's 18 + 18 dp padding or the ghost plate's 10 + 10 (ui/chrome/Controls.kt). */
        fun buttonWidth(label: String, ghost: Boolean): Float = HudType.textWidth(label.length, STRIP_BUTTON_SP, 1f) + if (ghost) 20f else 36f

        fun of(width: Float, height: Float, safe: HudInsets, versionLabel: String, fontScale: Float = 1f): LoadingStripPlan {
            val compact = height < 500f || width < 360f
            val wide = width >= 600f
            val padding = PADDING
            val sprite = if (!wide) 32f else if (compact) 44f else 56f
            val gap = if (!wide || compact) 8f else 10f
            val titleSp = if (!wide || compact) 18f else 22f
            val tipSp = if (!wide || compact) 13f else 15f
            val categorySp = 12f
            val titleLines = if (wide) 1 else 2
            val titleLine = titleSp * fontScale * titleLines
            val tipLineSp = if (!wide || compact) 14f else 16f
            val tipLine = tipLineSp * fontScale
            val meterGap = if (!wide || compact) 1f else 3f
            val lineSlot = 2f * tipLine
            val h = max(if (wide) 0f else 2f * max(TAP, 32f * fontScale + 12f), 2f * padding + titleLine + 2f * meterGap + METER + lineSlot)
            val left = safe.left + GUTTER; val right = width - safe.right - GUTTER
            val w = min(MAX_WIDTH, right - left)
            val x = left + (right - left - w) / 2f
            val bottomGap = if (wide && !compact) BOTTOM_GAP_DESKTOP else BOTTOM_GAP_PHONE
            // The label is the corner: the left gutter, the bottom gap above the safe inset.
            val labelW = HudType.textWidth(versionLabel.length, LABEL_SP, 1f) + 12f
            val labelH = LABEL_H * fontScale
            val label = HudRect(left, height - safe.bottom - bottomGap - labelH, labelW, labelH)
            // Beside (D-193 rule 2: "on desktop it may sit left of the strip's row") only on a desktop-class layout with room.
            val beside = wide && !compact && label.right + ACTIONS_GAP <= x
            val bottom = if (beside) height - safe.bottom - bottomGap else label.y - LABEL_GAP
            val strip = HudRect(x, bottom - h, w, h)
            return LoadingStripPlan(compact, wide, strip, label, beside, padding, sprite, gap, titleSp, titleLine, titleLines, tipSp, tipLineSp, tipLine, categorySp,
                lineSlot, meterGap, column = w - 2f * padding - sprite - gap)
        }
    }
}

/** The 4 dp meter: a measured fraction, the one-way sweep, or a still track (nothing is moving, nothing is measured). */
sealed interface StripMeter {
    data object Sweep : StripMeter
    data object Still : StripMeter
    data class Measured(val fraction: Float) : StripMeter
}

/** What one boot state puts in the strip. [line] replaces the rotating tip on line 2 (a reason, a status); null keeps
 * the tip. [reason] marks a line the player must read or act on (a failure, a note, a prompt), which a screen reader
 * hears at once; a progress or transient status line is not one (the meter carries progress). The buttons are a
 * Compose slot: every decision about which exist stays in the update helpers. */
data class LoadingStripContent(val title: String, val meter: StripMeter, val line: String? = null, val reason: Boolean = false)

/** D-193 rule 3: a measured percent never decreases and never falls back to the sweep mid-download. [held] is the
 * highest fraction shown for this transfer so far; the caller keeps it per transfer. */
fun heldFraction(held: Float, bytes: Long, total: Long): Float =
    if (total > 0) max(held, (bytes.toFloat() / total).coerceIn(0f, 1f)) else held

/** The loading and content-failed destinations. Retrying hides the reason and keeps the sweep, as the old card did. */
fun bootStripContent(error: String?, retrying: Boolean): LoadingStripContent {
    val failed = error != null && !retrying
    return LoadingStripContent(
        title = if (failed) "Couldn't open your kingdom" else "Opening your kingdom…",
        meter = if (failed) StripMeter.Still else StripMeter.Sweep,
        line = if (failed) "Please try again in a moment." else null,
        reason = failed)
}

/** A decorative tip: the category in gold caps and the sentence. Non-numeric copy only (no game number lives here). */
data class BootTip(val category: String, val text: String, val art: String)

/** One fixed plate; actions consume horizontal space only. The portrait stack has no empty row below the tip. */
internal val LocalNarrowStrip = staticCompositionLocalOf { false }
internal const val NARROW_ACTION_WIDTH = 112f
@Composable internal fun LoadingStrip(plan: LoadingStripPlan, content: LoadingStripContent, tip: BootTip,
                                      actions: (@Composable () -> Unit)?, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    // Owner 2026-10-06 ("improve visually"): a finished kit plate — the CHARCOAL material's ink rim, banded face, inner frame
    // and lip, plus a 1 dp inner shadow — instead of a flat translucent box with a 1 dp line.
    val plate = modifier.absoluteOffset(plan.strip.x.dp, plan.strip.y.dp).size(plan.strip.w.dp, plan.strip.h.dp)
        .drawBehind { drawStripFrame() }
        .padding(horizontal = plan.padding.dp)
    Row(plate, horizontalArrangement = Arrangement.spacedBy(plan.gap.dp), verticalAlignment = Alignment.CenterVertically) {
        // The portrait sits in its own pixel frame (the kit VEIL chip), the frame at the plan's sprite size.
        Box(Modifier.size(plan.sprite.dp).drawBehind { drawPlate(PlateKind.VEIL) }.padding(STRIP_ICON_INSET.dp)) {
            GameArt(tip.art, Modifier.fillMaxSize())
        }
        // Unbounded measurement avoids rounding the second reason line out on high-density screens.
        Column(Modifier.weight(1f).wrapContentHeight(Alignment.CenterVertically, unbounded = true)) { StripLines(plan, content, tip, reduced) }
        if (actions != null) CompositionLocalProvider(LocalNarrowStrip provides !plan.wide) {
            if (plan.wide) Row(horizontalArrangement = Arrangement.spacedBy(LoadingStripPlan.ACTIONS_GAP.dp),
                verticalAlignment = Alignment.CenterVertically) { actions() }
            else Column(Modifier.width(NARROW_ACTION_WIDTH.dp)) { actions() }
        }
    }
}

/** The column every layout shares: the one reserved title line, the meter block and the two reserved lines of line 2. */
@Composable private fun ColumnScope.StripLines(plan: LoadingStripPlan, content: LoadingStripContent, tip: BootTip, reduced: Boolean) {
    // The kit title style at the plan's size in the strip's accent (the realm's light where it is known); a changed title
    // cross-fades over 0.5 s (none under reduced motion).
    val accent = LocalStripAccent.current
    Crossfade(content.title, animationSpec = if (reduced) snap() else tween(TITLE_CROSSFADE_MS), label = "title") { title ->
        Text(title, color = accent, style = PkwTokens.Type.title, fontSize = plan.titleSp.sp, lineHeight = plan.titleSp.sp, letterSpacing = 1.sp,
            minLines = plan.titleLines, maxLines = plan.titleLines, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    }
    Spacer(Modifier.height(plan.meterGap.dp))
    Meter(content.meter, reduced)
    Spacer(Modifier.height(plan.meterGap.dp))
    // Line 2's height is its two reserved lines (minLines = maxLines = 2), never a dp box that can round short of them; the
    // plan's lineSlot is the same two lines, for the strip's box arithmetic.
    LineText(plan, content, tip, reduced, Modifier.fillMaxWidth())
}

/** Line 2: the tip (category + sentence) or the state's own line. Both are two reserved lines with an ellipsis, so a
 * change of text never changes the height. The crossfade is keyed on the tip's own words (the copy fading out keeps
 * them) and on ONE key for every state line, so "Downloading · 31%" replaces "Downloading · 30%" in place with no fade
 * (review 2026-09-28: the percent was perpetually half-faded; D-193 rule 3 reserves the crossfade for the tip); tip →
 * line and line → tip still fade. Only a [LoadingStripContent.reason] is a live region: a ticking percent is not read aloud. */
private data class Line(val category: String?, val text: String?)
private val STATE_LINE = Line(null, null)
@Composable private fun LineText(plan: LoadingStripPlan, content: LoadingStripContent, tip: BootTip, reduced: Boolean, modifier: Modifier) {
    // The latest state line, outside the snapshot: the copy fading out after line → tip keeps its words too.
    val latest = remember { arrayOfNulls<String>(1) }
    content.line?.let { latest[0] = it }
    val shownLine = content.line ?: latest[0] ?: ""
    val key = if (content.line != null) STATE_LINE else Line(tip.category, tip.text)
    Crossfade(key, modifier, animationSpec = if (reduced) snap() else tween(200), label = "tip") { drawn ->
        val text = buildAnnotatedString {
            if (drawn.category != null) {
                withStyle(SpanStyle(color = PkwTokens.Colors.gold.face, fontSize = plan.categorySp.sp, letterSpacing = 1.sp)) { append("${drawn.category} TIP") }
                append("  ")
                append(drawn.text ?: "")
            } else append(shownLine)
        }
        Text(text, color = PkwTokens.Colors.muted, style = PkwTokens.Type.small, fontSize = plan.tipSp.sp, lineHeight = plan.tipLineSp.sp, minLines = 2, maxLines = 2,
            overflow = TextOverflow.Ellipsis, modifier = if (drawn === STATE_LINE && content.reason) Modifier.semantics { liveRegion = LiveRegionMode.Assertive } else Modifier)
    }
}

/**
 * The pixel-stepped meter (owner 2026-10-06: "that yellow moving line goes beyond its box … improve visually too").
 * [METER_BLOCKS] hard-edged gold blocks on the kit's dark track inside a 1 dp ink border. Measured: blocks light left to
 * right (the next one at 35 % while it fills). Sweep: a 3-block head with a 2-block tail at 60 % / 30 %, entering at the left
 * and leaving at the right, one way, restarting. Reduced motion: every block half-lit, still. Still: the bare track.
 *
 * Why it overflowed: the old sweep drew a 30 % rect offset by one segment width before the track, i.e. from −30 % to 100 % of the track
 * width, on a Canvas that does not clip — so it painted past both ends into the plate. Now every lit thing is a block index
 * in 0 until [METER_BLOCKS] laid out inside the border ([meterBlockRect]), and the Canvas clips to its bounds besides.
 * Frames are read in the draw phase, never a recomposition.
 */
internal const val METER_BLOCKS = 8
private const val SWEEP_TAIL = 2
private const val SWEEP_HEAD = 3
private val SWEEP_ALPHAS = floatArrayOf(.3f, .6f, 1f, 1f, 1f)

/** Per-block alpha for [meter] at sweep [phase] (0..1; null = reduced motion). Pure: one value per block, nothing else. */
internal fun meterBlockAlphas(meter: StripMeter, phase: Float?): FloatArray {
    val alphas = FloatArray(METER_BLOCKS)
    when (meter) {
        is StripMeter.Measured -> {
            val filled = meter.fraction.coerceIn(0f, 1f) * METER_BLOCKS
            val full = filled.toInt().coerceAtMost(METER_BLOCKS)
            for (i in 0 until full) alphas[i] = 1f
            if (full < METER_BLOCKS && filled > full) alphas[full] = .35f
        }
        StripMeter.Sweep -> if (phase == null) alphas.fill(.5f) else {
            val positions = METER_BLOCKS + SWEEP_TAIL + SWEEP_HEAD // the comet enters whole and leaves whole
            val front = (phase.coerceIn(0f, 1f) * positions).toInt().coerceAtMost(positions - 1)
            for (j in SWEEP_ALPHAS.indices) {
                val block = front - SWEEP_ALPHAS.size + j
                if (block in 0 until METER_BLOCKS) alphas[block] = SWEEP_ALPHAS[j]
            }
        }
        StripMeter.Still -> Unit
    }
    return alphas
}

/** Block [index]'s (left, top, right, bottom) inside a [width] × [height] track with a [border] and [gap] (px): always within
 *  (border, width − border) × (border, height − border), whatever the index or size. */
internal fun meterBlockRect(index: Int, width: Float, height: Float, border: Float, gap: Float): FloatArray {
    val i = index.coerceIn(0, METER_BLOCKS - 1)
    val innerW = (width - 2 * border).coerceAtLeast(0f)
    val cell = ((innerW - gap * (METER_BLOCKS - 1)) / METER_BLOCKS).coerceAtLeast(0f)
    val left = (border + i * (cell + gap)).coerceAtMost(width - border)
    return floatArrayOf(left, border, (left + cell).coerceAtMost(width - border), (height - border).coerceAtLeast(border))
}

@Composable private fun Meter(meter: StripMeter, reduced: Boolean) {
    val phase: State<Float>? = if (meter is StripMeter.Sweep && !reduced) {
        rememberInfiniteTransition(label = "sweep").animateFloat(0f, 1f, infiniteRepeatable(tween(1600, easing = LinearEasing), RepeatMode.Restart), label = "sweep")
    } else null
    Canvas(Modifier.fillMaxWidth().height(LoadingStripPlan.METER.dp).clipToBounds().semantics {
        progressBarRangeInfo = when (meter) {
            is StripMeter.Measured -> ProgressBarRangeInfo(meter.fraction.coerceIn(0f, 1f), 0f..1f)
            else -> ProgressBarRangeInfo.Indeterminate
        }
    }) {
        val border = 1.dp.toPx(); val gap = 1.dp.toPx()
        drawRect(PkwTokens.Colors.ink)
        drawRect(PkwTokens.Colors.track, Offset(border, border), Size((size.width - 2 * border).coerceAtLeast(0f), (size.height - 2 * border).coerceAtLeast(0f)))
        val alphas = meterBlockAlphas(meter, phase?.value)
        for (i in 0 until METER_BLOCKS) {
            if (alphas[i] <= 0f) continue
            val r = meterBlockRect(i, size.width, size.height, border, gap)
            drawRect(PkwTokens.Colors.gold.face.copy(alpha = alphas[i]), Offset(r[0], r[1]), Size(r[2] - r[0], r[3] - r[1]))
            if (alphas[i] >= 1f) drawRect(PkwTokens.Colors.gold.hi, Offset(r[0], r[1]), Size(r[2] - r[0], min(border, r[3] - r[1])))
        }
    }
}

/** The strip's plate: the kit CHARCOAL material and a 1 dp inner shadow under its inner frame (DESIGN-SYSTEM §5). */
internal fun androidx.compose.ui.graphics.drawscope.DrawScope.drawStripFrame() {
    drawPlate(PlateKind.CHARCOAL)
    val inset = 5.dp.toPx(); val shade = 1.dp.toPx()
    if (size.width > 2 * inset && size.height > 2 * inset) {
        drawRect(PkwTokens.Colors.ink.copy(alpha = .55f), Offset(inset, inset), Size(size.width - 2 * inset, shade))
        drawRect(PkwTokens.Colors.ink.copy(alpha = .55f), Offset(inset, inset), Size(shade, size.height - 2 * inset - 4.dp.toPx()))
    }
}
internal const val STRIP_ICON_INSET = 4f
internal const val TITLE_CROSSFADE_MS = 500

/** The accent the strip's title wears: the realm's light where a host knows it (HudRealms), else the kit's bright gold. */
internal val LocalStripAccent = staticCompositionLocalOf { PkwTokens.Colors.gold.hi }

/** The insets the strip keeps clear: the safe drawing area and, at the bottom, the system gesture area too, so the strip's
 *  buttons never sit where a swipe-up goes home (owner 2026-10-06). */
internal fun stripBottomInset(safeBottom: Float, gestureBottom: Float): Float = max(safeBottom, gestureBottom)
@Composable internal fun stripInsets(): HudInsets {
    val safe = WindowInsets.safeDrawing.asPaddingValues()
    val gestures = WindowInsets.systemGestures.asPaddingValues()
    val direction = androidx.compose.ui.platform.LocalLayoutDirection.current
    return HudInsets(safe.calculateTopPadding().value, safe.calculateRightPadding(direction).value,
        stripBottomInset(safe.calculateBottomPadding().value, gestures.calculateBottomPadding().value), safe.calculateLeftPadding(direction).value)
}

/** A slight stepped vignette over the bottom of a wallpaper, behind the strip, so the strip never fights the art: bands of
 *  the kit's ink, darker toward the bottom (pixel bands, no smooth gradient). */
@Composable internal fun StripVignette(modifier: Modifier = Modifier) {
    Canvas(modifier.fillMaxSize()) {
        val top = size.height * (1f - VIGNETTE_HEIGHT)
        val band = size.height * VIGNETTE_HEIGHT / VIGNETTE_BANDS
        for (i in 0 until VIGNETTE_BANDS)
            drawRect(PkwTokens.Colors.ink.copy(alpha = VIGNETTE_MAX_ALPHA * (i + 1) / VIGNETTE_BANDS), Offset(0f, top + i * band), Size(size.width, band + 1f))
    }
}
internal const val VIGNETTE_HEIGHT = .3f
internal const val VIGNETTE_BANDS = 6
internal const val VIGNETTE_MAX_ALPHA = .42f

@androidx.compose.ui.tooling.preview.Preview(name = "Loading strip", widthDp = 412, heightDp = 360)
@Composable private fun LoadingStripPreview() {
    val plan = LoadingStripPlan.of(412f, 180f, HudInsets(), "PIXEL KINGDOM WARS v0.6.6")
    val tip = BootTip("TROOPS", "Archers shoot over walls; keep them behind your tanks.", "profile")
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.surface)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            StripVignette()
            LoadingStrip(plan, LoadingStripContent("Opening your kingdom…", StripMeter.Sweep), tip, null)
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LoadingStrip(plan, LoadingStripContent("Shaping the realms…", StripMeter.Measured(.45f), "Downloading · 45%"), tip, null)
        }
    }
}

/** A strip button: the forged plate (or the ghost one) at the strip's 48 dp tap height with a 16 sp label, so a title
 * and two buttons share a phone's width. Every button on the boot screen is one of these. */
internal const val STRIP_BUTTON_SP = 16f
@Composable internal fun Modifier.stripButtonSize(): Modifier = this.heightIn(min = LoadingStripPlan.TAP.dp).then(
        if (LocalNarrowStrip.current) Modifier.width(NARROW_ACTION_WIDTH.dp).heightIn(min = max(LoadingStripPlan.TAP, 32f * LocalDensity.current.fontScale + 12f).dp) else Modifier)
@Composable internal fun StripButton(label: String, onClick: () -> Unit, enabled: Boolean = true, ghost: Boolean = false) {
    val narrow = LocalNarrowStrip.current
    val text: @Composable RowScope.() -> Unit = { Text(label, fontSize = STRIP_BUTTON_SP.sp, lineHeight = STRIP_BUTTON_SP.sp) }
    if (ghost) TextButton(onClick, Modifier.stripButtonSize(), enabled, content = text)
    else Button(onClick, Modifier.stripButtonSize(), enabled, contentPadding = if (narrow) PaddingValues(horizontal = 8.dp, vertical = 6.dp)
        else PaddingValues(start = 18.dp, top = 8.dp, end = 18.dp, bottom = 12.dp), content = text)
}

/** "PIXEL KINGDOM WARS v0.6.6" (SHARDKEEP D-192: one product version on both clients, one label format), at the
 * bottom-left corner outside the strip on a thin plate for readability over the bright wallpaper. */
@Composable internal fun BootVersionLabel(plan: LoadingStripPlan, versionLabel: String, versionName: String, modifier: Modifier = Modifier) {
    Box(modifier.absoluteOffset(plan.label.x.dp, plan.label.y.dp).height(plan.label.h.dp).background(BootPlate).padding(horizontal = 6.dp),
        contentAlignment = Alignment.CenterStart) {
        Text(versionLabel, color = Palette.textFaint, fontSize = LoadingStripPlan.LABEL_SP.sp, lineHeight = LoadingStripPlan.LABEL_SP.sp, letterSpacing = 1.sp,
            maxLines = 1, modifier = Modifier.semantics { contentDescription = "Version $versionName" })
    }
}
