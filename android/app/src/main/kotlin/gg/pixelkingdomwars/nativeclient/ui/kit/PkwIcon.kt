package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ownsBuildingArt
import kotlin.math.roundToInt

/**
 * Design component: the kit's icon (DESIGN-SYSTEM §4 Pixel art). Draws pixel art with nearest sampling, centred in a
 * [size] box. Oversized bitmaps shrink to fit; smaller art keeps the existing [integerArtScale] upscaling.
 *
 * Names: `ui:<id>` (or `pkw_ui_<id>`) for the bundled Phase E icons, `shape:<name>` for the drawn glyphs in
 * [KIT_GLYPHS] (plus the registry aliases `envelope`, `speech`, `chevron-up`; an unknown shape draws a visible "?"), and the currency / timer names the kit uses itself (`sol` is the code-drawn
 * [SolanaMark], not a bitmap). Any other GameArt name is handed to the existing
 * [GameArt] (its lookup is private), which samples nearest but does not round its scale to a whole number.
 */
@Composable fun PkwIcon(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null,
    alpha: Float = 1f, tint: Color = PkwTokens.Colors.text) {
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    if (name.startsWith("shape:")) {
        // An unknown shape draws the visible "?" glyph (glyphKey), never nothing (design ruling 092decf3 item 1).
        val glyph = KIT_GLYPHS.getValue(glyphKey(name))
        Canvas(modifier.size(size).then(described)) { drawGlyph(glyph, tint, alpha) }
        return
    }
    // SOL is the code-drawn Solana mark (SolanaMark.kt), not the bundled 24 px bitmap.
    if (isSolanaMark(name)) {
        SolanaMark(size, modifier, contentDescription, alpha)
        return
    }
    val id = kitDrawable(name)
    if (id == null) {
        // Building art (designed sprites, pack tier sprites, the Keep strip) draws through the one building art rule
        // (sheets/buildings/BuildingIconArt.kt), never through the old atlas portrait.
        if (ownsBuildingArt(name)) { BuildingArt(name, size, modifier, contentDescription, alpha); return }
        GameArt(name, modifier.size(size).alpha(alpha), contentDescription)
        return
    }
    val bitmap = kitImageResource(id)
    Canvas(modifier.size(size).then(described)) {
        val drawn = iconBitmapSize(bitmap.width, bitmap.height, this.size.width, this.size.height)
        if (drawn.width > 0 && drawn.height > 0) {
            drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
                dstOffset = IntOffset(((this.size.width - drawn.width) / 2f).roundToInt(), ((this.size.height - drawn.height) / 2f).roundToInt()),
                dstSize = drawn, alpha = alpha, filterQuality = FilterQuality.None)
        }
    }
}

/** Oversized source art fits its box; art already fitting keeps the existing integer upscaling. */
internal fun iconBitmapSize(width: Int, height: Int, boxWidth: Float, boxHeight: Float): IntSize {
    if (width <= 0 || height <= 0 || !boxWidth.isFinite() || !boxHeight.isFinite() || boxWidth <= 0f || boxHeight <= 0f)
        return IntSize.Zero
    if (width > boxWidth || height > boxHeight) {
        val scale = minOf(boxWidth.toDouble() / width, boxHeight.toDouble() / height)
        // Clamp rounded raster dimensions to the whole-pixel canvas bounds.
        return IntSize((width * scale).roundToInt().coerceAtMost(boxWidth.toInt()),
            (height * scale).roundToInt().coerceAtMost(boxHeight.toInt()))
    }
    val k = minOf(integerArtScale(boxWidth, width), integerArtScale(boxHeight, height))
    return IntSize(width * k, height * k)
}

/** The drawables the kit draws itself at an integer scale; null hands the name to [GameArt]. */
internal fun kitDrawable(name: String): Int? {
    val phaseE = when {
        name.startsWith("ui:") -> name.removePrefix("ui:")
        name.startsWith("pkw_ui_") -> name.removePrefix("pkw_ui_").replace('_', '-')
        else -> null
    }
    if (phaseE != null) return when (phaseE) {
        "climate-kit" -> R.drawable.pkw_ui_climate_kit
        "crystal-fragments" -> R.drawable.pkw_ui_crystal_fragments
        "divine-navigation" -> R.drawable.pkw_ui_divine_navigation
        "exhausted-status" -> R.drawable.pkw_ui_exhausted_status
        "exp" -> R.drawable.pkw_ui_exp
        "expedition-kit" -> R.drawable.pkw_ui_expedition_kit
        "harvester-menu" -> R.drawable.pkw_ui_harvester_menu
        "lodge-menu" -> R.drawable.pkw_ui_lodge_menu
        "market-menu" -> R.drawable.pkw_ui_market_menu
        "navigation-kit" -> R.drawable.pkw_ui_navigation_kit
        "realm-passport" -> R.drawable.pkw_ui_item_realm_passport
        "queue-status" -> R.drawable.pkw_ui_queue_status
        "ready-status" -> R.drawable.pkw_ui_ready_status
        "renown" -> R.drawable.pkw_ui_renown
        "seeker-navigation" -> R.drawable.pkw_ui_seeker_navigation
        "solana-navigation" -> R.drawable.pkw_ui_solana_navigation
        "workshop-menu" -> R.drawable.pkw_ui_workshop_menu
        "inv-forge-ingot" -> R.drawable.pkw_ui_inv_forge_ingot
        "gf-storage-crate" -> R.drawable.pkw_ui_gf_storage_crate
        else -> null
    }
    return when (name) {
        "skr" -> R.drawable.pkw_web_icon_skr
        "gem" -> R.drawable.gem_24
        "gem-32" -> R.drawable.gem_32
        "shards", "shard" -> R.drawable.pkw_web_icon_shard
        "keep" -> R.drawable.pkw_web_icon_keeptoken
        "sol" -> R.drawable.pkw_web_icon_sol
        "timer" -> R.drawable.pkw_web_icon_timer
        "builder" -> R.drawable.pkw_web_builder
        else -> null
    }
}

/** Draws a 12 × 12 [KIT_GLYPHS] grid at a whole number of device px per cell, centred. */
internal fun DrawScope.drawGlyph(rows: List<String>, tint: Color, alpha: Float) {
    val k = minOf(integerArtScale(size.width, GLYPH_CELLS), integerArtScale(size.height, GLYPH_CELLS)).toFloat()
    val x0 = ((size.width - GLYPH_CELLS * k) / 2f).roundToInt().toFloat()
    val y0 = ((size.height - GLYPH_CELLS * k) / 2f).roundToInt().toFloat()
    val hi = lerp(tint, Color.White, 0.45f)
    rows.forEachIndexed { y, row ->
        row.forEachIndexed { x, cell ->
            val color = when (cell) { '#' -> tint; 'h' -> hi; 'x' -> PkwTokens.Colors.ink; else -> null }
            if (color != null) drawRect(color, Offset(x0 + x * k, y0 + y * k), Size(k, k), alpha = alpha)
        }
    }
}

@Preview(name = "Kit icons", widthDp = 360, heightDp = 120)
@Composable private fun PkwIconPreview() {
    Row(Modifier.background(PkwTokens.Colors.bg).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwIcon("ui:ready-status", 32.dp)
        PkwIcon("ui:workshop-menu", 32.dp)
        PkwIcon("skr", 24.dp)
        PkwIcon("shards", 24.dp)
        PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
        PkwIcon("shape:close", 24.dp, tint = PkwTokens.Colors.label)
        PkwIcon("shape:chat", 24.dp, tint = PkwTokens.Colors.text)
        PkwIcon("shape:up", 24.dp, tint = PkwTokens.Colors.label)
    }
}

@Preview(name = "Registry shapes (chest, hammer, axe, anchor, envelope, speech, unknown)", widthDp = 360, heightDp = 80)
@Composable private fun RegistryShapesPreview() {
    Row(Modifier.background(PkwTokens.Colors.bg).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        PkwIcon("shape:chest", 36.dp, tint = PkwTokens.Colors.gold.face)
        PkwIcon("shape:hammer", 36.dp, tint = PkwTokens.Colors.stone.hi)
        PkwIcon("shape:axe", 36.dp, tint = PkwTokens.Colors.stone.hi)
        PkwIcon("shape:anchor", 36.dp, tint = PkwTokens.Colors.blue.hi)
        PkwIcon("shape:envelope", 36.dp, tint = PkwTokens.Colors.text)
        PkwIcon("shape:speech", 36.dp, tint = PkwTokens.Colors.text)
        PkwIcon("shape:not-a-shape", 36.dp, tint = PkwTokens.Colors.text)
    }
}
