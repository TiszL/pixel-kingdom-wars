package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.integerArtScale
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/**
 * Design component: the craft cluster's pixel art (DESIGN-SYSTEM §4 Pixel art; craft/SPEC.md §6 assets).
 *
 * [CraftIcon] draws `craft:<name>` art (the byte copies in `res/drawable-nodpi/pkw_ui_<name>.png`, listed in
 * design/impl/ASSET-COPIES-craft.md) with nearest sampling at a whole number of device pixels per art pixel, and hands
 * every other name to the kit's [PkwIcon]. It exists because the committed kit resolves only its own 16 `ui:` icons; a
 * one-line kit hook (`craftDrawable` in `kitDrawable`) would let kit parts (ItemTile, Seal, PriceChip) draw these too.
 *
 * [CraftAtlasFrame] / [CraftAtlasLoop] draw one frame of a sprite atlas ([CraftAtlases]) the same way. Neither takes
 * touches.
 */
@Composable fun CraftIcon(name: String, size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null,
    alpha: Float = 1f, tint: Color = PkwTokens.Colors.text) {
    if (!name.startsWith("craft:")) {
        PkwIcon(name, size, modifier, contentDescription, alpha, tint)
        return
    }
    val id = craftDrawable(name)
    if (id == null) {
        // Fail loud but harmless: an unknown craft name draws the "?" glyph, never another item's art.
        PkwIcon("shape:unknown", size, modifier, contentDescription, alpha, PkwTokens.Colors.textOnParch2)
        return
    }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(id)
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size).then(described)) {
        val k = minOf(integerArtScale(this.size.width, bitmap.width), integerArtScale(this.size.height, bitmap.height))
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, srcOffset = IntOffset.Zero, srcSize = IntSize(bitmap.width, bitmap.height),
            dstOffset = IntOffset(((this.size.width - w) / 2f).roundToInt(), ((this.size.height - h) / 2f).roundToInt()),
            dstSize = IntSize(w, h), alpha = alpha, filterQuality = FilterQuality.None)
    }
}

/** One frame of [atlas] in a [size] box, at a whole-number scale, centred. */
@Composable fun CraftAtlasFrame(atlas: CraftAtlas, frame: Int, size: Dp, modifier: Modifier = Modifier, alpha: Float = 1f,
    contentDescription: String? = null) {
    val id = craftDrawable(atlas.art)
    if (id == null) {
        PkwIcon("shape:unknown", size, modifier, contentDescription, alpha, PkwTokens.Colors.textOnParch2)
        return
    }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(id)
    val (sx, sy) = atlasFrameOrigin(atlas, frame)
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size).then(described)) {
        val k = integerArtScale(minOf(this.size.width, this.size.height), atlas.cell)
        val w = atlas.cell * k
        drawImage(bitmap, srcOffset = IntOffset(sx, sy), srcSize = IntSize(atlas.cell, atlas.cell),
            dstOffset = IntOffset(((this.size.width - w) / 2f).roundToInt(), ((this.size.height - w) / 2f).roundToInt()),
            dstSize = IntSize(w, w), alpha = alpha, filterQuality = FilterQuality.None)
    }
}

/**
 * [atlas] played at [fps] (looping, or [once] holding the last frame). Reduced motion and previews draw [still] (or the
 * last frame of a once-only play), with no loop.
 */
@Composable fun CraftAtlasLoop(atlas: CraftAtlas, fps: Int, size: Dp, modifier: Modifier = Modifier, still: String? = null,
    once: Boolean = false, alpha: Float = 1f, contentDescription: String? = null) {
    val reduced = LocalReducedMotion.current || LocalInspectionMode.current
    if (reduced && still != null && !once) {
        CraftIcon(still, size, modifier, contentDescription, alpha)
        return
    }
    val last = (atlas.frames - 1).coerceAtLeast(0)
    val frame by produceState(if (reduced && once) last else 0, atlas, fps, once, reduced) {
        if (reduced) { value = if (once) last else 0; return@produceState }
        var i = 0
        while (true) {
            value = i
            if (once && i >= last) break
            delay(1000L / fps.coerceAtLeast(1))
            i = if (once) i + 1 else (i + 1) % atlas.frames.coerceAtLeast(1)
        }
    }
    CraftAtlasFrame(atlas, frame, size, modifier, alpha, contentDescription)
}

/** The drawable of a `craft:<name>` icon, or null for an unknown name. Names = file names minus `pkw_ui_`. */
internal fun craftDrawable(name: String): Int? = when (name.removePrefix("craft:")) {
    "awning_t1" -> R.drawable.pkw_ui_awning_t1
    "awning_t2" -> R.drawable.pkw_ui_awning_t2
    "awning_t3" -> R.drawable.pkw_ui_awning_t3
    "awning_t4" -> R.drawable.pkw_ui_awning_t4
    "fx_craft_success" -> R.drawable.pkw_ui_fx_craft_success
    "fx_ingot_casting" -> R.drawable.pkw_ui_fx_ingot_casting
    "fx_ingot_ready" -> R.drawable.pkw_ui_fx_ingot_ready
    "fx_reward_claim" -> R.drawable.pkw_ui_fx_reward_claim
    "harv_cinderfall_t1_construction" -> R.drawable.pkw_ui_harv_cinderfall_t1_construction
    "harv_cinderfall_t1_idle" -> R.drawable.pkw_ui_harv_cinderfall_t1_idle
    "harv_cinderfall_t1_ready" -> R.drawable.pkw_ui_harv_cinderfall_t1_ready
    "harv_cinderfall_t2_construction" -> R.drawable.pkw_ui_harv_cinderfall_t2_construction
    "harv_cinderfall_t2_idle" -> R.drawable.pkw_ui_harv_cinderfall_t2_idle
    "harv_cinderfall_t2_ready" -> R.drawable.pkw_ui_harv_cinderfall_t2_ready
    "harv_cinderfall_t3_construction" -> R.drawable.pkw_ui_harv_cinderfall_t3_construction
    "harv_cinderfall_t3_idle" -> R.drawable.pkw_ui_harv_cinderfall_t3_idle
    "harv_cinderfall_t3_ready" -> R.drawable.pkw_ui_harv_cinderfall_t3_ready
    "harv_cinderfall_t4_construction" -> R.drawable.pkw_ui_harv_cinderfall_t4_construction
    "harv_cinderfall_t4_idle" -> R.drawable.pkw_ui_harv_cinderfall_t4_idle
    "harv_cinderfall_t4_ready" -> R.drawable.pkw_ui_harv_cinderfall_t4_ready
    "harv_crownlands_t1_construction" -> R.drawable.pkw_ui_harv_crownlands_t1_construction
    "harv_crownlands_t1_idle" -> R.drawable.pkw_ui_harv_crownlands_t1_idle
    "harv_crownlands_t1_ready" -> R.drawable.pkw_ui_harv_crownlands_t1_ready
    "harv_crownlands_t2_construction" -> R.drawable.pkw_ui_harv_crownlands_t2_construction
    "harv_crownlands_t2_idle" -> R.drawable.pkw_ui_harv_crownlands_t2_idle
    "harv_crownlands_t2_ready" -> R.drawable.pkw_ui_harv_crownlands_t2_ready
    "harv_crownlands_t3_construction" -> R.drawable.pkw_ui_harv_crownlands_t3_construction
    "harv_crownlands_t3_idle" -> R.drawable.pkw_ui_harv_crownlands_t3_idle
    "harv_crownlands_t3_ready" -> R.drawable.pkw_ui_harv_crownlands_t3_ready
    "harv_crownlands_t4_construction" -> R.drawable.pkw_ui_harv_crownlands_t4_construction
    "harv_crownlands_t4_idle" -> R.drawable.pkw_ui_harv_crownlands_t4_idle
    "harv_crownlands_t4_ready" -> R.drawable.pkw_ui_harv_crownlands_t4_ready
    "harv_elderwood_t1_construction" -> R.drawable.pkw_ui_harv_elderwood_t1_construction
    "harv_elderwood_t1_idle" -> R.drawable.pkw_ui_harv_elderwood_t1_idle
    "harv_elderwood_t1_ready" -> R.drawable.pkw_ui_harv_elderwood_t1_ready
    "harv_elderwood_t2_construction" -> R.drawable.pkw_ui_harv_elderwood_t2_construction
    "harv_elderwood_t2_idle" -> R.drawable.pkw_ui_harv_elderwood_t2_idle
    "harv_elderwood_t2_ready" -> R.drawable.pkw_ui_harv_elderwood_t2_ready
    "harv_elderwood_t3_construction" -> R.drawable.pkw_ui_harv_elderwood_t3_construction
    "harv_elderwood_t3_idle" -> R.drawable.pkw_ui_harv_elderwood_t3_idle
    "harv_elderwood_t3_ready" -> R.drawable.pkw_ui_harv_elderwood_t3_ready
    "harv_elderwood_t4_construction" -> R.drawable.pkw_ui_harv_elderwood_t4_construction
    "harv_elderwood_t4_idle" -> R.drawable.pkw_ui_harv_elderwood_t4_idle
    "harv_elderwood_t4_ready" -> R.drawable.pkw_ui_harv_elderwood_t4_ready
    "harv_frostveil_t1_construction" -> R.drawable.pkw_ui_harv_frostveil_t1_construction
    "harv_frostveil_t1_idle" -> R.drawable.pkw_ui_harv_frostveil_t1_idle
    "harv_frostveil_t1_ready" -> R.drawable.pkw_ui_harv_frostveil_t1_ready
    "harv_frostveil_t2_construction" -> R.drawable.pkw_ui_harv_frostveil_t2_construction
    "harv_frostveil_t2_idle" -> R.drawable.pkw_ui_harv_frostveil_t2_idle
    "harv_frostveil_t2_ready" -> R.drawable.pkw_ui_harv_frostveil_t2_ready
    "harv_frostveil_t3_construction" -> R.drawable.pkw_ui_harv_frostveil_t3_construction
    "harv_frostveil_t3_idle" -> R.drawable.pkw_ui_harv_frostveil_t3_idle
    "harv_frostveil_t3_ready" -> R.drawable.pkw_ui_harv_frostveil_t3_ready
    "harv_frostveil_t4_construction" -> R.drawable.pkw_ui_harv_frostveil_t4_construction
    "harv_frostveil_t4_idle" -> R.drawable.pkw_ui_harv_frostveil_t4_idle
    "harv_frostveil_t4_ready" -> R.drawable.pkw_ui_harv_frostveil_t4_ready
    "harv_seeker_reach_t1_construction" -> R.drawable.pkw_ui_harv_seeker_reach_t1_construction
    "harv_seeker_reach_t1_idle" -> R.drawable.pkw_ui_harv_seeker_reach_t1_idle
    "harv_seeker_reach_t1_ready" -> R.drawable.pkw_ui_harv_seeker_reach_t1_ready
    "harv_seeker_reach_t2_construction" -> R.drawable.pkw_ui_harv_seeker_reach_t2_construction
    "harv_seeker_reach_t2_idle" -> R.drawable.pkw_ui_harv_seeker_reach_t2_idle
    "harv_seeker_reach_t2_ready" -> R.drawable.pkw_ui_harv_seeker_reach_t2_ready
    "harv_seeker_reach_t3_construction" -> R.drawable.pkw_ui_harv_seeker_reach_t3_construction
    "harv_seeker_reach_t3_idle" -> R.drawable.pkw_ui_harv_seeker_reach_t3_idle
    "harv_seeker_reach_t3_ready" -> R.drawable.pkw_ui_harv_seeker_reach_t3_ready
    "harv_seeker_reach_t4_construction" -> R.drawable.pkw_ui_harv_seeker_reach_t4_construction
    "harv_seeker_reach_t4_idle" -> R.drawable.pkw_ui_harv_seeker_reach_t4_idle
    "harv_seeker_reach_t4_ready" -> R.drawable.pkw_ui_harv_seeker_reach_t4_ready
    "harv_stormcairn_t1_construction" -> R.drawable.pkw_ui_harv_stormcairn_t1_construction
    "harv_stormcairn_t1_idle" -> R.drawable.pkw_ui_harv_stormcairn_t1_idle
    "harv_stormcairn_t1_ready" -> R.drawable.pkw_ui_harv_stormcairn_t1_ready
    "harv_stormcairn_t2_construction" -> R.drawable.pkw_ui_harv_stormcairn_t2_construction
    "harv_stormcairn_t2_idle" -> R.drawable.pkw_ui_harv_stormcairn_t2_idle
    "harv_stormcairn_t2_ready" -> R.drawable.pkw_ui_harv_stormcairn_t2_ready
    "harv_stormcairn_t3_construction" -> R.drawable.pkw_ui_harv_stormcairn_t3_construction
    "harv_stormcairn_t3_idle" -> R.drawable.pkw_ui_harv_stormcairn_t3_idle
    "harv_stormcairn_t3_ready" -> R.drawable.pkw_ui_harv_stormcairn_t3_ready
    "harv_stormcairn_t4_construction" -> R.drawable.pkw_ui_harv_stormcairn_t4_construction
    "harv_stormcairn_t4_idle" -> R.drawable.pkw_ui_harv_stormcairn_t4_idle
    "harv_stormcairn_t4_ready" -> R.drawable.pkw_ui_harv_stormcairn_t4_ready
    "harv_sunscar_t1_construction" -> R.drawable.pkw_ui_harv_sunscar_t1_construction
    "harv_sunscar_t1_idle" -> R.drawable.pkw_ui_harv_sunscar_t1_idle
    "harv_sunscar_t1_ready" -> R.drawable.pkw_ui_harv_sunscar_t1_ready
    "harv_sunscar_t2_construction" -> R.drawable.pkw_ui_harv_sunscar_t2_construction
    "harv_sunscar_t2_idle" -> R.drawable.pkw_ui_harv_sunscar_t2_idle
    "harv_sunscar_t2_ready" -> R.drawable.pkw_ui_harv_sunscar_t2_ready
    "harv_sunscar_t3_construction" -> R.drawable.pkw_ui_harv_sunscar_t3_construction
    "harv_sunscar_t3_idle" -> R.drawable.pkw_ui_harv_sunscar_t3_idle
    "harv_sunscar_t3_ready" -> R.drawable.pkw_ui_harv_sunscar_t3_ready
    "harv_sunscar_t4_construction" -> R.drawable.pkw_ui_harv_sunscar_t4_construction
    "harv_sunscar_t4_idle" -> R.drawable.pkw_ui_harv_sunscar_t4_idle
    "harv_sunscar_t4_ready" -> R.drawable.pkw_ui_harv_sunscar_t4_ready
    "harv_thornwake_t1_construction" -> R.drawable.pkw_ui_harv_thornwake_t1_construction
    "harv_thornwake_t1_idle" -> R.drawable.pkw_ui_harv_thornwake_t1_idle
    "harv_thornwake_t1_ready" -> R.drawable.pkw_ui_harv_thornwake_t1_ready
    "harv_thornwake_t2_construction" -> R.drawable.pkw_ui_harv_thornwake_t2_construction
    "harv_thornwake_t2_idle" -> R.drawable.pkw_ui_harv_thornwake_t2_idle
    "harv_thornwake_t2_ready" -> R.drawable.pkw_ui_harv_thornwake_t2_ready
    "harv_thornwake_t3_construction" -> R.drawable.pkw_ui_harv_thornwake_t3_construction
    "harv_thornwake_t3_idle" -> R.drawable.pkw_ui_harv_thornwake_t3_idle
    "harv_thornwake_t3_ready" -> R.drawable.pkw_ui_harv_thornwake_t3_ready
    "harv_thornwake_t4_construction" -> R.drawable.pkw_ui_harv_thornwake_t4_construction
    "harv_thornwake_t4_idle" -> R.drawable.pkw_ui_harv_thornwake_t4_idle
    "harv_thornwake_t4_ready" -> R.drawable.pkw_ui_harv_thornwake_t4_ready
    "ingot_crate" -> R.drawable.pkw_ui_ingot_crate
    "ingot_mold_empty" -> R.drawable.pkw_ui_ingot_mold_empty
    "ingot_stack" -> R.drawable.pkw_ui_ingot_stack
    "inv_crown_iron_ore" -> R.drawable.pkw_ui_inv_crown_iron_ore
    "inv_crownsteel" -> R.drawable.pkw_ui_inv_crownsteel
    "inv_ember_nodules" -> R.drawable.pkw_ui_inv_ember_nodules
    "inv_embercore" -> R.drawable.pkw_ui_inv_embercore
    "inv_forge_ingot" -> R.drawable.pkw_ui_inv_forge_ingot
    "inv_frost_quartz" -> R.drawable.pkw_ui_inv_frost_quartz
    "inv_frostglass" -> R.drawable.pkw_ui_inv_frostglass
    "inv_heartwood_beams" -> R.drawable.pkw_ui_inv_heartwood_beams
    "inv_heartwood_logs" -> R.drawable.pkw_ui_inv_heartwood_logs
    "inv_prismstone_lens" -> R.drawable.pkw_ui_inv_prismstone_lens
    "inv_rough_prism" -> R.drawable.pkw_ui_inv_rough_prism
    "inv_storm_ore" -> R.drawable.pkw_ui_inv_storm_ore
    "inv_stormalloy" -> R.drawable.pkw_ui_inv_stormalloy
    "inv_sunstone_blocks" -> R.drawable.pkw_ui_inv_sunstone_blocks
    "inv_sunstone_rubble" -> R.drawable.pkw_ui_inv_sunstone_rubble
    "inv_thorn_fibre" -> R.drawable.pkw_ui_inv_thorn_fibre
    "inv_thornsilk" -> R.drawable.pkw_ui_inv_thornsilk
    "item_aurora_wake" -> R.drawable.pkw_ui_item_aurora_wake
    "item_awning" -> R.drawable.pkw_ui_item_awning
    "item_route_compass" -> R.drawable.pkw_ui_item_route_compass
    "item_survey_lens" -> R.drawable.pkw_ui_item_survey_lens
    "keep_24" -> R.drawable.pkw_ui_keep_24
    "keep_48" -> R.drawable.pkw_ui_keep_48
    "market_t1_idle" -> R.drawable.pkw_ui_market_t1_idle
    "market_t1_working" -> R.drawable.pkw_ui_market_t1_working
    "market_t2_idle" -> R.drawable.pkw_ui_market_t2_idle
    "market_t2_working" -> R.drawable.pkw_ui_market_t2_working
    "market_t3_idle" -> R.drawable.pkw_ui_market_t3_idle
    "market_t3_working" -> R.drawable.pkw_ui_market_t3_working
    "market_t4_idle" -> R.drawable.pkw_ui_market_t4_idle
    "market_t4_working" -> R.drawable.pkw_ui_market_t4_working
    "workshop_t1_construction" -> R.drawable.pkw_ui_workshop_t1_construction
    "workshop_t1_idle" -> R.drawable.pkw_ui_workshop_t1_idle
    "workshop_t1_ready" -> R.drawable.pkw_ui_workshop_t1_ready
    "workshop_t1_working" -> R.drawable.pkw_ui_workshop_t1_working
    "workshop_t1_working_loop" -> R.drawable.pkw_ui_workshop_t1_working_loop
    "workshop_t2_construction" -> R.drawable.pkw_ui_workshop_t2_construction
    "workshop_t2_idle" -> R.drawable.pkw_ui_workshop_t2_idle
    "workshop_t2_ready" -> R.drawable.pkw_ui_workshop_t2_ready
    "workshop_t2_working" -> R.drawable.pkw_ui_workshop_t2_working
    "workshop_t2_working_loop" -> R.drawable.pkw_ui_workshop_t2_working_loop
    "workshop_t3_construction" -> R.drawable.pkw_ui_workshop_t3_construction
    "workshop_t3_idle" -> R.drawable.pkw_ui_workshop_t3_idle
    "workshop_t3_ready" -> R.drawable.pkw_ui_workshop_t3_ready
    "workshop_t3_working" -> R.drawable.pkw_ui_workshop_t3_working
    "workshop_t3_working_loop" -> R.drawable.pkw_ui_workshop_t3_working_loop
    "workshop_t4_construction" -> R.drawable.pkw_ui_workshop_t4_construction
    "workshop_t4_idle" -> R.drawable.pkw_ui_workshop_t4_idle
    "workshop_t4_ready" -> R.drawable.pkw_ui_workshop_t4_ready
    "workshop_t4_working" -> R.drawable.pkw_ui_workshop_t4_working
    "workshop_t4_working_loop" -> R.drawable.pkw_ui_workshop_t4_working_loop
    else -> null
}

@Preview(name = "Craft art", widthDp = 412, heightDp = 260)
@Composable private fun CraftArtPreview() {
    androidx.compose.foundation.layout.Column(Modifier.background(PkwTokens.Colors.parchment).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf("frostglass", "frost_quartz", "crownsteel", "heartwood_beams", "forge_ingot", "route_compass", "aurora_wake", "navigation_kit")
                .forEach { CraftIcon(craftItemIcon(it), 32.dp) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CraftIcon(workshopSprite(2, BenchSprite.IDLE), 112.dp)
            CraftIcon(marketSprite(2), 112.dp)
            CraftIcon(harvesterSprite("crownlands", 2, HarvesterSprite.READY) ?: "craft:missing", 112.dp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CraftAtlasFrame(CraftAtlases.workshopWorking(2), 4, 56.dp)
            CraftAtlasFrame(CraftAtlases.ingotReady, 8, 64.dp)
            CraftAtlasLoop(CraftAtlases.craftSuccess, 12, 64.dp, once = true)
            CraftIcon("craft:keep_48", 48.dp)
        }
    }
}
