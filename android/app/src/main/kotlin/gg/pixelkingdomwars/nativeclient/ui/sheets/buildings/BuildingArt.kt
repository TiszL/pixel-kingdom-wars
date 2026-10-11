package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.iconBitmapSize
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * Design component: the buildings cluster's art parts (buildings/SPEC.md §2.1 wells, §3.1 BuildCard well, §4.1 ghost,
 * §5 Assets) that the committed kit does not have. Added here, inside the cluster, rather than editing the kit:
 * - [BuildingArt]: Phase E building tier art (112 × 112, copied as `pkw_ui_*`, see ASSET-COPIES-buildings.md) drawn at a
 *   whole number of device pixels per art pixel with nearest sampling, optionally greyed (LOCKED) or outlined (ghost).
 *   Any other name is handed to the kit's `PkwIcon` (kit icons, shapes, existing GameArt names such as
 *   `ui_portrait_barracks_t3`), while the BUILD tray uses transparent ordinary-building identities.
 * - [drawGrassWell]: the dark well a tier sprite stands in (ink S rim 2 dp, grass, 4 dp darker bottom band). SPEC §5 asks
 *   for a crop of base-overview.png; a crop is not a byte copy, so the grass is a small code-drawn pixel speckle instead.
 * - [drawStepArrow]: the gold "now → next" step arrow (drawn; no art).
 * None of these takes touches.
 */

/** Existing authored identity sprites for discovery only; never scene or construction admission. */
internal fun ordinaryBuildTrayPortrait(type: String): String? = when (type) {
    "mine", "vault", "barracks", "forge", "camp", "clanhall" -> "ui:$type-t1-identity"
    "archertower", "dragonnest", "electrictower", "lasertower", "powdermine" -> "ui:$type-t1-identity"
    else -> null
}

/** The cluster's own drawables. Names: `ui:<building>-t<n>-idle`, `ui:harv-<realm>-t<n>-idle`, `ui:berth-starter-intact`,
 *  or the resource name itself (`pkw_ui_workshop_t1_idle`). Null hands the name to the kit. */
internal fun buildingArtDrawable(name: String): Int? {
    val key = when {
        name.startsWith("ui:") -> name.removePrefix("ui:").replace('-', '_')
        name.startsWith("pkw_ui_") -> name.removePrefix("pkw_ui_")
        else -> return null
    }
    return when (key) {
        "archertower_t1_identity" -> R.drawable.pkw_ui_archertower_t1_identity
        "dragonnest_t1_identity" -> R.drawable.pkw_ui_dragonnest_t1_identity
        "electrictower_t1_identity" -> R.drawable.pkw_ui_electrictower_t1_identity
        "lasertower_t1_identity" -> R.drawable.pkw_ui_lasertower_t1_identity
        "powdermine_t1_identity" -> R.drawable.pkw_ui_powdermine_t1_identity
        "mine_t1_identity" -> R.drawable.pkw_ui_mine_t1_identity
        "vault_t1_identity" -> R.drawable.pkw_ui_vault_t1_identity
        "barracks_t1_identity" -> R.drawable.pkw_ui_barracks_t1_identity
        "forge_t1_identity" -> R.drawable.pkw_ui_forge_t1_identity
        "camp_t1_identity" -> R.drawable.pkw_ui_camp_t1_identity
        "clanhall_t1_identity" -> R.drawable.pkw_ui_clanhall_t1_identity

        "workshop_t1_idle" -> R.drawable.pkw_ui_workshop_t1_idle
        "workshop_t2_idle" -> R.drawable.pkw_ui_workshop_t2_idle
        "workshop_t3_idle" -> R.drawable.pkw_ui_workshop_t3_idle
        "workshop_t4_idle" -> R.drawable.pkw_ui_workshop_t4_idle
        "lodge_t1_idle" -> R.drawable.pkw_ui_lodge_t1_idle
        "lodge_t2_idle" -> R.drawable.pkw_ui_lodge_t2_idle
        "lodge_t3_idle" -> R.drawable.pkw_ui_lodge_t3_idle
        "lodge_t4_idle" -> R.drawable.pkw_ui_lodge_t4_idle
        "market_t1_idle" -> R.drawable.pkw_ui_market_t1_idle
        "market_t2_idle" -> R.drawable.pkw_ui_market_t2_idle
        "market_t3_idle" -> R.drawable.pkw_ui_market_t3_idle
        "market_t4_idle" -> R.drawable.pkw_ui_market_t4_idle
        "goldforge_t1_idle" -> R.drawable.pkw_ui_goldforge_t1_idle
        "goldforge_t2_idle" -> R.drawable.pkw_ui_goldforge_t2_idle
        "goldforge_t3_idle" -> R.drawable.pkw_ui_goldforge_t3_idle
        "goldforge_t4_idle" -> R.drawable.pkw_ui_goldforge_t4_idle
        "berth_starter_intact" -> R.drawable.pkw_ui_berth_starter_intact
        "berth_survey_balloon_intact" -> R.drawable.pkw_ui_berth_survey_balloon_intact
        "berth_cargo_cutter_intact" -> R.drawable.pkw_ui_berth_cargo_cutter_intact
        "berth_courier_airship_intact" -> R.drawable.pkw_ui_berth_courier_airship_intact
        "berth_expedition_barge_intact" -> R.drawable.pkw_ui_berth_expedition_barge_intact
        "harv_cinderfall_t1_idle" -> R.drawable.pkw_ui_harv_cinderfall_t1_idle
        "harv_cinderfall_t2_idle" -> R.drawable.pkw_ui_harv_cinderfall_t2_idle
        "harv_cinderfall_t3_idle" -> R.drawable.pkw_ui_harv_cinderfall_t3_idle
        "harv_cinderfall_t4_idle" -> R.drawable.pkw_ui_harv_cinderfall_t4_idle
        "harv_crownlands_t1_idle" -> R.drawable.pkw_ui_harv_crownlands_t1_idle
        "harv_crownlands_t2_idle" -> R.drawable.pkw_ui_harv_crownlands_t2_idle
        "harv_crownlands_t3_idle" -> R.drawable.pkw_ui_harv_crownlands_t3_idle
        "harv_crownlands_t4_idle" -> R.drawable.pkw_ui_harv_crownlands_t4_idle
        "harv_elderwood_t1_idle" -> R.drawable.pkw_ui_harv_elderwood_t1_idle
        "harv_elderwood_t2_idle" -> R.drawable.pkw_ui_harv_elderwood_t2_idle
        "harv_elderwood_t3_idle" -> R.drawable.pkw_ui_harv_elderwood_t3_idle
        "harv_elderwood_t4_idle" -> R.drawable.pkw_ui_harv_elderwood_t4_idle
        "harv_frostveil_t1_idle" -> R.drawable.pkw_ui_harv_frostveil_t1_idle
        "harv_frostveil_t2_idle" -> R.drawable.pkw_ui_harv_frostveil_t2_idle
        "harv_frostveil_t3_idle" -> R.drawable.pkw_ui_harv_frostveil_t3_idle
        "harv_frostveil_t4_idle" -> R.drawable.pkw_ui_harv_frostveil_t4_idle
        "harv_seeker_reach_t1_idle" -> R.drawable.pkw_ui_harv_seeker_reach_t1_idle
        "harv_seeker_reach_t2_idle" -> R.drawable.pkw_ui_harv_seeker_reach_t2_idle
        "harv_seeker_reach_t3_idle" -> R.drawable.pkw_ui_harv_seeker_reach_t3_idle
        "harv_seeker_reach_t4_idle" -> R.drawable.pkw_ui_harv_seeker_reach_t4_idle
        "harv_stormcairn_t1_idle" -> R.drawable.pkw_ui_harv_stormcairn_t1_idle
        "harv_stormcairn_t2_idle" -> R.drawable.pkw_ui_harv_stormcairn_t2_idle
        "harv_stormcairn_t3_idle" -> R.drawable.pkw_ui_harv_stormcairn_t3_idle
        "harv_stormcairn_t4_idle" -> R.drawable.pkw_ui_harv_stormcairn_t4_idle
        "harv_sunscar_t1_idle" -> R.drawable.pkw_ui_harv_sunscar_t1_idle
        "harv_sunscar_t2_idle" -> R.drawable.pkw_ui_harv_sunscar_t2_idle
        "harv_sunscar_t3_idle" -> R.drawable.pkw_ui_harv_sunscar_t3_idle
        "harv_sunscar_t4_idle" -> R.drawable.pkw_ui_harv_sunscar_t4_idle
        "harv_thornwake_t1_idle" -> R.drawable.pkw_ui_harv_thornwake_t1_idle
        "harv_thornwake_t2_idle" -> R.drawable.pkw_ui_harv_thornwake_t2_idle
        "harv_thornwake_t3_idle" -> R.drawable.pkw_ui_harv_thornwake_t3_idle
        "harv_thornwake_t4_idle" -> R.drawable.pkw_ui_harv_thornwake_t4_idle
        else -> null
    }
}

/** LOCKED cards: grayscale at 55 % brightness (SPEC §3.1). Rec. 709 luma weights. */
private const val LOCKED_BRIGHTNESS = 0.55f
private val LOCKED_FILTER = ColorFilter.colorMatrix(ColorMatrix(floatArrayOf(
    0.2126f * LOCKED_BRIGHTNESS, 0.7152f * LOCKED_BRIGHTNESS, 0.0722f * LOCKED_BRIGHTNESS, 0f, 0f,
    0.2126f * LOCKED_BRIGHTNESS, 0.7152f * LOCKED_BRIGHTNESS, 0.0722f * LOCKED_BRIGHTNESS, 0f, 0f,
    0.2126f * LOCKED_BRIGHTNESS, 0.7152f * LOCKED_BRIGHTNESS, 0.0722f * LOCKED_BRIGHTNESS, 0f, 0f,
    0f, 0f, 0f, 1f, 0f,
)))

/**
 * A building's tier art in a [size] box, centred, at a whole number of device px per art px (nearest sampling). [dim] greys
 * it to 55 % (LOCKED); [outline] draws a 2 dp outline in that colour behind it (four offset draws, the placement ghost).
 * Names the cluster does not own go to the kit's `PkwIcon` (no outline there; [dim] becomes 55 % alpha).
 */
@Composable fun BuildingArt(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null,
    alpha: Float = 1f, dim: Boolean = false, outline: Color? = null) {
    // The shared building art rule (BuildingIconArt.kt): an old `building-<type>` glyph, a pack tier sprite and the
    // Keep's realm-kit strip are drawn here too, never handed to the old atlas portrait.
    val art = legacyBuildingGlyphArt(name) ?: name
    packBuildingRef(art)?.let { PackBuildingArt(it, size, modifier, contentDescription, alpha, dim, outline); return }
    val id = buildingArtDrawable(art)
    if (id == null) {
        if ((art.startsWith("ui:") || art.startsWith("pkw_ui_")) && r2ArtDrawable(art) != null) {
            R2Art(art, size, size, modifier, contentDescription, alpha, if (dim) LOCKED_BRIGHTNESS else null)
            return
        }
        PkwIcon(art, size, modifier, contentDescription, alpha = if (dim) alpha * LOCKED_BRIGHTNESS else alpha)
        return
    }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(id)
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size).then(described)) { drawArt(bitmap, alpha, if (dim) LOCKED_FILTER else null, outline) }
}

/**
 * A pack tier sprite ([PackSprites], decoded off the main thread once per content generation). Until it is decoded,
 * or when no pack is in scope (previews, tests), the bundled tier-1 identity draws for the types that have one, else an
 * empty well of the same size: never an old portrait. A level change keeps the previous sprite until the next one is
 * ready, so a refresh never blanks a shown sprite.
 */
@Composable private fun PackBuildingArt(ref: PackBuildingRef, size: Dp, modifier: Modifier, contentDescription: String?,
    alpha: Float, dim: Boolean, outline: Color?) {
    val source = LocalPackArt.current
    val frame = packBuildingFrame(ref.type, ref.tier)
    val key = if (source != null && frame != null) PackSprites.key(source, frame) else null
    val loaded by produceState(key?.let { PackSprites.cached(it) }, key) {
        value = if (source == null || frame == null || key == null) null
            else PackSprites.cached(key) ?: withContext(Dispatchers.IO) { PackSprites.load(source, frame) }
    }
    val bitmap = loaded
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    if (bitmap == null) {
        val identity = ordinaryBuildTrayPortrait(ref.type)
        if (identity != null) BuildingArt(identity, size, modifier, contentDescription, alpha, dim, outline)
        else Box(modifier.size(size).then(described))
        return
    }
    Canvas(modifier.size(size).then(described)) { drawArt(bitmap, alpha, if (dim) LOCKED_FILTER else null, outline) }
}

private fun DrawScope.drawArt(bitmap: ImageBitmap, alpha: Float, filter: ColorFilter?, outline: Color?) {
    // Whole device px per art px; art larger than its box (a building drawn as a small icon) shrinks to fit instead of
    // spilling over its neighbours.
    val fitted = iconBitmapSize(bitmap.width, bitmap.height, size.width, size.height)
    if (fitted.width <= 0 || fitted.height <= 0) return
    val w = fitted.width; val h = fitted.height
    val x = ((size.width - w) / 2f).roundToInt(); val y = ((size.height - h) / 2f).roundToInt()
    val src = IntSize(bitmap.width, bitmap.height); val dst = IntSize(w, h)
    if (outline != null) {
        val o = (2.dp.toPx()).roundToInt().coerceAtLeast(1)
        val tint = ColorFilter.tint(outline)
        listOf(IntOffset(-o, 0), IntOffset(o, 0), IntOffset(0, -o), IntOffset(0, o)).forEach { d ->
            drawImage(bitmap, IntOffset.Zero, src, IntOffset(x + d.x, y + d.y), dst, alpha = alpha, colorFilter = tint, filterQuality = FilterQuality.None)
        }
    }
    drawImage(bitmap, IntOffset.Zero, src, IntOffset(x, y), dst, alpha = alpha, colorFilter = filter, filterQuality = FilterQuality.None)
}

/** Grass well colours, sampled from the design's grass patch (base-overview.png (735,680)-(791,736)). */
private val GRASS = Color(0xFF3F6A35)
private val GRASS_LIGHT = Color(0xFF4D7B3F)
private val GRASS_DARK = Color(0xFF345A2C)
private val GRASS_BAND = Color(0xFF2C4C25)

/**
 * The well a tier sprite stands in (SPEC §2.1 / §3.1): ink S rim 2 dp, flat grass with a fixed pixel speckle (cells of 2
 * art px at the sheet scale, the same pattern every frame), a 4 dp darker bottom band, and an optional 3 dp gold inner rim
 * (the "next tier" well).
 */
internal fun DrawScope.drawGrassWell(goldRim: Boolean = false) {
    val w = size.width; val h = size.height
    fillStepped(0f, 0f, w, h, CornerProfiles.S, PkwTokens.Colors.ink)
    val i = 2.dp.toPx()
    insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
        drawRect(GRASS)
        val cell = (2f * density).roundToInt().coerceAtLeast(2).toFloat()
        val cols = (w / cell).toInt() + 1; val rows = (h / cell).toInt() + 1
        for (gy in 0 until rows) for (gx in 0 until cols) {
            val hash = ((gx * 73856093) xor (gy * 19349663)) and 0xFF
            val color = when { hash < 20 -> GRASS_LIGHT; hash < 36 -> GRASS_DARK; else -> null } ?: continue
            drawRect(color, Offset(gx * cell, gy * cell), Size(cell, cell))
        }
        band(i, w - i, h - i - 4.dp.toPx(), 4.dp.toPx(), GRASS_BAND)
        if (goldRim) {
            val r = 3.dp.toPx(); val c = PkwTokens.Colors.gold.face
            drawRect(c, Offset(i, i), Size(w - 2 * i, r)); drawRect(c, Offset(i, h - i - r), Size(w - 2 * i, r))
            drawRect(c, Offset(i, i), Size(r, h - 2 * i)); drawRect(c, Offset(w - i - r, i), Size(r, h - 2 * i))
        }
    }
}

/** The gold step arrow (a pixel triangle pointing right, ink-rimmed) filling the DrawScope: "now → next". */
internal fun DrawScope.drawStepArrow(color: Color = PkwTokens.Colors.gold.face) {
    val w = size.width; val h = size.height
    val path = Path().apply { moveTo(0f, 0f); lineTo(w, h / 2f); lineTo(0f, h); close() }
    drawPath(path, color)
}

/** A [width] × [height] step arrow (gold by default). Decorative: not announced, not a touch target. */
@Composable internal fun StepArrow(width: Dp, height: Dp, modifier: Modifier = Modifier, color: Color = PkwTokens.Colors.gold.face) {
    Canvas(modifier.size(width, height)) { drawStepArrow(color) }
}

@Preview(name = "Building art: wells, greyed, outlined", widthDp = 412, heightDp = 160)
@Composable private fun BuildingArtPreview() {
    Row(Modifier.background(PkwTokens.Colors.parchment).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(118.dp).drawBehind { drawGrassWell() }, contentAlignment = Alignment.Center) { BuildingArt("ui:workshop-t2-idle", 112.dp) }
        StepArrow(24.dp, 28.dp)
        Box(Modifier.size(118.dp).drawBehind { drawGrassWell(goldRim = true) }, contentAlignment = Alignment.Center) { BuildingArt("ui:workshop-t3-idle", 112.dp) }
        Box(Modifier.size(118.dp).drawBehind { drawGrassWell() }, contentAlignment = Alignment.Center) {
            BuildingArt("ui:market-t1-idle", 112.dp, dim = true)
        }
    }
}
