package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetTitlePlate
import gg.pixelkingdomwars.nativeclient.ui.kit.countUpText
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.iconBitmapSize
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Design component: the parts the buildings cluster's round 2 frames share (buildings/SPEC.md R2.1-R2.5, E1.1-E1.2) that
 * neither the kit nor the round 1 files expose: the half-sheet header row (charcoal title plate + right VT line + red
 * close), the clickable cream card with an inner rim (builder rows), the 14 dp job bar (striped while queued / under
 * construction), the cream quote chip, the 2 dp stone loading line, a counting figure, and [R2Art], which draws the wall
 * pieces, construction sprites and realm-kit Keep strips at a whole number of device px per art px.
 * Pointer rule: only [TapCard] takes touches (a painted card, a scene-input region); everything else is paint.
 */

/** Wall tiers (`pkw_web_wall_t<n>`, also the GameArt names `wall5_t<n>_straight_intact_f1`), the Phase E construction
 *  sprites (`ui:<building>-t<n>-construction`, `ui:harv-<realm>-t<n>-construction`) and the realm-kit Keep idle strips
 *  (`ui:keep-l<n>-idle`, frame 0 of 3). Null: not ours (handed to [BuildingArt]). */
internal fun r2ArtDrawable(name: String): Int? {
    if (name == "builder" || name == "pkw_web_builder") return R.drawable.pkw_web_builder
    WALL.matchEntire(name)?.let { m ->
        return when (m.groupValues[1].ifEmpty { m.groupValues[2] }) {
            "1" -> R.drawable.pkw_web_wall_t1; "2" -> R.drawable.pkw_web_wall_t2; "3" -> R.drawable.pkw_web_wall_t3
            "4" -> R.drawable.pkw_web_wall_t4; "5" -> R.drawable.pkw_web_wall_t5; else -> null
        }
    }
    KEEP.matchEntire(name)?.let { return keepIdleDrawable(it.groupValues[1].toIntOrNull() ?: return null) }
    val key = when {
        name.startsWith("ui:") -> name.removePrefix("ui:").replace('-', '_')
        name.startsWith("pkw_ui_") -> name.removePrefix("pkw_ui_")
        else -> return null
    }
    return constructionDrawable(key)
}

private val WALL = Regex("^(?:pkw_web_wall_t([1-5])|wall5_t([1-5])_straight_intact_f1)$")
private val KEEP = Regex("^(?:ui:keep-l|pkw_ui_keep_l)(\\d{1,2})(?:-idle|_idle)$")

/** True for the realm-kit Keep strips: 3 frames side by side, frame 0 is drawn. */
private fun isStrip(name: String): Boolean = KEEP.matches(name)

/** The realm-kit Keep idle strip for a Keep level (1..20; clamped). Byte copies, see ASSET-COPIES-r2-buildings-army.md. */
internal fun keepIdleDrawable(level: Int): Int = when (level.coerceIn(1, 20)) {
    1 -> R.drawable.pkw_ui_keep_l1_idle; 2 -> R.drawable.pkw_ui_keep_l2_idle; 3 -> R.drawable.pkw_ui_keep_l3_idle
    4 -> R.drawable.pkw_ui_keep_l4_idle; 5 -> R.drawable.pkw_ui_keep_l5_idle; 6 -> R.drawable.pkw_ui_keep_l6_idle
    7 -> R.drawable.pkw_ui_keep_l7_idle; 8 -> R.drawable.pkw_ui_keep_l8_idle; 9 -> R.drawable.pkw_ui_keep_l9_idle
    10 -> R.drawable.pkw_ui_keep_l10_idle; 11 -> R.drawable.pkw_ui_keep_l11_idle; 12 -> R.drawable.pkw_ui_keep_l12_idle
    13 -> R.drawable.pkw_ui_keep_l13_idle; 14 -> R.drawable.pkw_ui_keep_l14_idle; 15 -> R.drawable.pkw_ui_keep_l15_idle
    16 -> R.drawable.pkw_ui_keep_l16_idle; 17 -> R.drawable.pkw_ui_keep_l17_idle; 18 -> R.drawable.pkw_ui_keep_l18_idle
    19 -> R.drawable.pkw_ui_keep_l19_idle; else -> R.drawable.pkw_ui_keep_l20_idle
}

private fun constructionDrawable(key: String): Int? = when (key) {
    "workshop_t1_construction" -> R.drawable.pkw_ui_workshop_t1_construction
    "workshop_t2_construction" -> R.drawable.pkw_ui_workshop_t2_construction
    "workshop_t3_construction" -> R.drawable.pkw_ui_workshop_t3_construction
    "workshop_t4_construction" -> R.drawable.pkw_ui_workshop_t4_construction
    "harv_cinderfall_t1_construction" -> R.drawable.pkw_ui_harv_cinderfall_t1_construction
    "harv_cinderfall_t2_construction" -> R.drawable.pkw_ui_harv_cinderfall_t2_construction
    "harv_cinderfall_t3_construction" -> R.drawable.pkw_ui_harv_cinderfall_t3_construction
    "harv_cinderfall_t4_construction" -> R.drawable.pkw_ui_harv_cinderfall_t4_construction
    "harv_crownlands_t1_construction" -> R.drawable.pkw_ui_harv_crownlands_t1_construction
    "harv_crownlands_t2_construction" -> R.drawable.pkw_ui_harv_crownlands_t2_construction
    "harv_crownlands_t3_construction" -> R.drawable.pkw_ui_harv_crownlands_t3_construction
    "harv_crownlands_t4_construction" -> R.drawable.pkw_ui_harv_crownlands_t4_construction
    "harv_elderwood_t1_construction" -> R.drawable.pkw_ui_harv_elderwood_t1_construction
    "harv_elderwood_t2_construction" -> R.drawable.pkw_ui_harv_elderwood_t2_construction
    "harv_elderwood_t3_construction" -> R.drawable.pkw_ui_harv_elderwood_t3_construction
    "harv_elderwood_t4_construction" -> R.drawable.pkw_ui_harv_elderwood_t4_construction
    "harv_frostveil_t1_construction" -> R.drawable.pkw_ui_harv_frostveil_t1_construction
    "harv_frostveil_t2_construction" -> R.drawable.pkw_ui_harv_frostveil_t2_construction
    "harv_frostveil_t3_construction" -> R.drawable.pkw_ui_harv_frostveil_t3_construction
    "harv_frostveil_t4_construction" -> R.drawable.pkw_ui_harv_frostveil_t4_construction
    "harv_seeker_reach_t1_construction" -> R.drawable.pkw_ui_harv_seeker_reach_t1_construction
    "harv_seeker_reach_t2_construction" -> R.drawable.pkw_ui_harv_seeker_reach_t2_construction
    "harv_seeker_reach_t3_construction" -> R.drawable.pkw_ui_harv_seeker_reach_t3_construction
    "harv_seeker_reach_t4_construction" -> R.drawable.pkw_ui_harv_seeker_reach_t4_construction
    "harv_stormcairn_t1_construction" -> R.drawable.pkw_ui_harv_stormcairn_t1_construction
    "harv_stormcairn_t2_construction" -> R.drawable.pkw_ui_harv_stormcairn_t2_construction
    "harv_stormcairn_t3_construction" -> R.drawable.pkw_ui_harv_stormcairn_t3_construction
    "harv_stormcairn_t4_construction" -> R.drawable.pkw_ui_harv_stormcairn_t4_construction
    "harv_sunscar_t1_construction" -> R.drawable.pkw_ui_harv_sunscar_t1_construction
    "harv_sunscar_t2_construction" -> R.drawable.pkw_ui_harv_sunscar_t2_construction
    "harv_sunscar_t3_construction" -> R.drawable.pkw_ui_harv_sunscar_t3_construction
    "harv_sunscar_t4_construction" -> R.drawable.pkw_ui_harv_sunscar_t4_construction
    "harv_thornwake_t1_construction" -> R.drawable.pkw_ui_harv_thornwake_t1_construction
    "harv_thornwake_t2_construction" -> R.drawable.pkw_ui_harv_thornwake_t2_construction
    "harv_thornwake_t3_construction" -> R.drawable.pkw_ui_harv_thornwake_t3_construction
    "harv_thornwake_t4_construction" -> R.drawable.pkw_ui_harv_thornwake_t4_construction
    else -> null
}

/** Grayscale at [brightness] (the hire line's builder: SPEC R2.1 "grayscale 45%"). */
internal fun greyFilter(brightness: Float): ColorFilter {
    val m = ColorMatrix().apply { setToSaturation(0f) }
    m.timesAssign(ColorMatrix().apply { setToScale(brightness, brightness, brightness, 1f) })
    return ColorFilter.colorMatrix(m)
}

/**
 * Pixel art in a [width] × [height] box at a whole number of device px per art px (nearest sampling), bottom-centred (the
 * sprite stands on the box floor). Wall pieces, construction sprites and Keep strips are ours; any other name goes to
 * [BuildingArt] (Phase E tier art), which hands the rest to the kit's `PkwIcon`. [grey] draws it grayscale at that
 * brightness. Decorative unless [contentDescription] is given.
 */
@Composable internal fun R2Art(name: String, width: Dp, height: Dp, modifier: Modifier = Modifier, contentDescription: String? = null,
    alpha: Float = 1f, grey: Float? = null) {
    val id = r2ArtDrawable(name)
    if (id == null) {
        Box(modifier.size(width, height), contentAlignment = Alignment.BottomCenter) {
            BuildingArt(name, minOf(width, height), contentDescription = contentDescription, alpha = alpha, dim = grey != null)
        }
        return
    }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(id)
    val frames = if (isStrip(name)) 3 else 1
    val described = if (contentDescription == null) Modifier.clearAndSetSemantics { } else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(width, height).then(described)) {
        val fw = bitmap.width / frames; val fh = bitmap.height
        // Whole px per art px; a strip larger than its box (the Keep as a small icon) shrinks to fit instead of spilling.
        val fitted = iconBitmapSize(fw, fh, size.width, size.height)
        if (fitted.width <= 0 || fitted.height <= 0) return@Canvas
        val w = fitted.width; val h = fitted.height
        val x = ((size.width - w) / 2f).roundToInt(); val y = (size.height - h).roundToInt()
        drawImage(bitmap, IntOffset.Zero, IntSize(fw, fh), IntOffset(x, y), IntSize(w, h), alpha = alpha,
            colorFilter = grey?.let(::greyFilter), filterQuality = FilterQuality.None)
    }
}

/**
 * The half-sheet header row (buildings/SPEC.md R2.1 / R2.2 / R2.4): a charcoal plate with an optional 30 dp [icon], the PS 13
 * gold-hi [title] (or the kit's level transition with [tag] / [tagTo]) and a VT 20 muted [right] line; the 48 dp red close.
 */
@Composable internal fun HalfSheetHeader(title: String, onClose: () -> Unit, modifier: Modifier = Modifier, icon: String? = null,
    right: String? = null, tag: String? = null, tagTo: String? = null, closeEnabled: Boolean = true) {
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (icon == null && right == null) SheetTitlePlate(title, Modifier.weight(1f), tag, tagTo)
        else Plate(PlateKind.CHARCOAL, Modifier.weight(1f).heightIn(min = 44.dp)
            .semantics(mergeDescendants = true) { heading(); contentDescription = listOfNotNull(title, right).joinToString(", ") }, blocksScene = false) {
            Row(Modifier.align(Alignment.CenterStart).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (icon != null) PkwIcon(icon, 30.dp)
                PkwText(title, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                if (right != null) PkwText(right, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.muted,
                    textAlign = androidx.compose.ui.text.style.TextAlign.End)
            }
        }
        IconSquare("shape:close", Verb.RED, onClose, "Close", enabled = closeEnabled)
    }
}

/**
 * A cream card (DESIGN-SYSTEM §5 CreamCard, the mocks' `kcard`) with an optional [rim] inside the ink shell ([rimWidth]),
 * a [body] tint (`creamLo` dimmed, `selectedTint`), and, with [onClick], its own button: ≥ 48 dp, labelled
 * [description], pressing it moves the card 3 dp. Nested buttons keep their own taps.
 */
@Composable internal fun TapCard(modifier: Modifier = Modifier, body: Color? = null, rim: Color? = null, rimWidth: Dp = 3.dp,
    padding: PaddingValues = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 8.dp),
    onClick: (() -> Unit)? = null, description: String? = null, content: @Composable BoxScope.() -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = LocalReducedMotion.current
    val press by animateFloatAsState(if (pressed && onClick != null) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE), label = "card")
    val touch = if (onClick == null) {
        if (description != null) Modifier.clearAndSetSemantics { contentDescription = description } else Modifier
    } else Modifier.heightIn(min = PkwTokens.Dims.minTap).sceneInputRegion()
        .semantics(mergeDescendants = false) {
            contentDescription = description ?: ""; role = Role.Button
            this.onClick(label = null, action = { onClick(); true })
        }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
    Box(modifier.then(touch).graphicsLayer { translationY = 3.dp.toPx() * press }.drawBehind {
        drawPlate(PlateKind.CREAM, body)
        if (rim != null) {
            val i = 2.dp.toPx(); val r = rimWidth.toPx(); val w = size.width; val h = size.height
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                drawRect(rim, Offset(i, i), Size(w - 2 * i, r)); drawRect(rim, Offset(i, h - i - r), Size(w - 2 * i, r))
                drawRect(rim, Offset(i, i), Size(r, h - 2 * i)); drawRect(rim, Offset(w - i - r, i), Size(r, h - 2 * i))
            }
        }
    }.padding(padding), content = content)
}

/** The job bar (SPEC R2.1 "14 dp ProgressBar, green fill = elapsed share, striped while queued"): ink S rim, dark track,
 *  green done part (diagonal green stripes when [striped]); null progress draws an empty track, never "0 % done". */
@Composable internal fun JobBar(progress: Float?, striped: Boolean, modifier: Modifier = Modifier, height: Dp = 14.dp) {
    Box(modifier.fillMaxWidth().height(height).clearAndSetSemantics { }.drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        drawRect(PkwTokens.Colors.track, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
        val done = progress?.coerceIn(0f, 1f) ?: return@drawBehind
        if (done <= 0f) return@drawBehind
        val w = (size.width - 2 * i) * done; val h = size.height - 2 * i
        if (striped) {
            val s = 4.dp.toPx()
            drawRect(Brush.linearGradient(0f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.face,
                1f to PkwTokens.Colors.green.face, start = Offset.Zero, end = Offset(2 * s, 2 * s), tileMode = TileMode.Repeated), Offset(i, i), Size(w, h))
        } else {
            drawRect(PkwTokens.Colors.green.face, Offset(i, i), Size(w, h))
            drawRect(PkwTokens.Colors.green.hi, Offset(i, i), Size(w, 2.dp.toPx()))
        }
    })
}

/** A 30 dp cream quote chip (ink S rim, cream body): icon + PS caption (time, builders). Paint only. */
@Composable internal fun QuoteChip(icon: String, iconSize: Dp, text: String, spoken: String, modifier: Modifier = Modifier) {
    Row(modifier.heightIn(min = 30.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx()
        fillStepped(i, i, size.width - i, size.height - i, CornerProfiles.S, PkwTokens.Colors.cream)
    }.padding(start = 3.dp, end = 7.dp).clearAndSetSemantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwIcon(icon, iconSize)
        PkwText(text, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
    }
}

/** The 2 dp stone line under a header or tabs while a refresh runs (SPEC "loading: last good view + 2 dp stone line"). */
@Composable internal fun LoadingLine(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(2.dp).background(PkwTokens.Colors.stone.face).clearAndSetSemantics { contentDescription = "Updating" })
}

/**
 * A figure that counts from its previous value to [target] over `COUNT_UP` (600 ms, `out`) when the server value changes
 * ("11,457 more" counting down when a collect lands). Reduced motion and previews show the final value at once. Only
 * whole numbers count (kit `countUpText`); anything else ("…") shows as given.
 */
@Composable internal fun CountingText(target: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current || LocalInspectionMode.current
    var from by remember { mutableStateOf(target) }
    var shownTarget by remember { mutableStateOf(target) }
    val t = remember { Animatable(1f) }
    LaunchedEffect(target) {
        if (target == shownTarget) return@LaunchedEffect
        from = countUpText(from, shownTarget, t.value)
        shownTarget = target
        if (reduced) { t.snapTo(1f); return@LaunchedEffect }
        t.snapTo(0f)
        t.animateTo(1f, tween(PkwTokens.Motion.COUNT_UP, easing = PkwTokens.Motion.Out))
    }
    PkwText(countUpText(from, shownTarget, t.value), style, modifier, color = color)
}

/** The grass ground of a building-sheet living header (SPEC E1.1 2026-10-03: one ground for all building sheets). Drawn
 *  here as flat grass with darker rows (the craft cluster's `grass-tile-3x.png` is a crop, not a byte copy). */
internal fun androidx.compose.ui.graphics.drawscope.DrawScope.drawHeaderGrass() {
    drawRect(HEADER_GRASS)
    var y = 18.dp.toPx()
    while (y < size.height) { drawRect(HEADER_GRASS_LO, Offset(0f, y), Size(size.width, 2.dp.toPx())); y += 26.dp.toPx() }
    drawRect(PkwTokens.Colors.ink, Offset(0f, size.height - 3.dp.toPx()), Size(size.width, 3.dp.toPx()))
}

private val HEADER_GRASS = Color(0xFF3F6A35)
private val HEADER_GRASS_LO = Color(0xFF355C2D)

/** A preview-only wrapper: the kingdom's grass behind a half sheet pinned to the bottom (the SheetHost's job in the app). */
@Composable internal fun HalfSheetPreviewFrame(content: @Composable (Modifier) -> Unit) {
    Box(Modifier.size(412.dp, 915.dp).background(HEADER_GRASS), contentAlignment = Alignment.BottomCenter) {
        Column(Modifier.fillMaxWidth()) { content(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) }
    }
}
