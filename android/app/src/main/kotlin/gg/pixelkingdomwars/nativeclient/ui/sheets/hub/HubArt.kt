package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.integerArtScale
import kotlin.math.roundToInt

/**
 * Design component: pixel art at an integer scale for the hub's large art (design/final/hub/SPEC.md §5.8 "integer scale
 * cases": league crest 40 → 80, `pkw_web_alert` 16 → 32, Gold Forge 112 → 168, dwarf 64 → 128, the logo on its 4 × 4
 * block grid) and the two art files this cluster bundles (ASSET-COPIES-hub.md).
 *
 * The kit's PkwIcon draws its own bundle at an integer scale but hands every other name to GameArt, which does not round
 * its scale to a whole number; at 80-168 dp that shows. So the names below are drawn here with nearest sampling at a
 * whole number of device pixels per art pixel (per 4 × 4 block for the logo); every other name goes to PkwIcon unchanged.
 */

/** One drawable the hub draws itself: [frames] side by side in one strip; [grid] art pixels per logical pixel. */
@Immutable internal data class HubDrawable(val id: Int, val frames: Int = 1, val grid: Int = 1)

/** The hub's own lookup; null hands the name to the kit's PkwIcon. */
internal fun hubDrawable(name: String): HubDrawable? = when (name) {
    "league-bronze", "league_bronze", "pkw_web_league_bronze" -> HubDrawable(R.drawable.pkw_web_league_bronze)
    "league-silver", "league_silver", "pkw_web_league_silver" -> HubDrawable(R.drawable.pkw_web_league_silver)
    "league-gold", "league_gold", "pkw_web_league_gold" -> HubDrawable(R.drawable.pkw_web_league_gold)
    "league-sol", "league_sol", "pkw_web_league_sol" -> HubDrawable(R.drawable.pkw_web_league_sol)
    "alert", "pkw_web_alert" -> HubDrawable(R.drawable.pkw_web_alert)
    "logo", "pkw_web_logo" -> HubDrawable(R.drawable.pkw_web_logo, grid = 4)
    "ui_portrait_keep_t1", "pkw_web_portrait_keep_t1" -> HubDrawable(R.drawable.pkw_web_portrait_keep_t1)
    "ui_portrait_keep_t2", "pkw_web_portrait_keep_t2" -> HubDrawable(R.drawable.pkw_web_portrait_keep_t2)
    "ui_portrait_keep_t3", "pkw_web_portrait_keep_t3" -> HubDrawable(R.drawable.pkw_web_portrait_keep_t3)
    "ui_portrait_keep_t4", "pkw_web_portrait_keep_t4" -> HubDrawable(R.drawable.pkw_web_portrait_keep_t4)
    // The new Gold Forge, tier 3 idle (112 px): the update gate header at 168 dp.
    "goldforge-t3-idle" -> HubDrawable(R.drawable.pkw_ui_goldforge_t3_idle)
    // The Gold Forge dwarf smith: 16 frames of 64 px in one 1024 × 64 strip (maintenance gate, 128 dp, 12 fps).
    "gf-dwarf-smith" -> HubDrawable(R.drawable.pkw_ui_gf_dwarf_smith, frames = 16)
    else -> null
}

/** The Keep portrait art name for a Keep tier (1..4; anything else clamps). */
fun keepPortrait(tier: Int): String = "ui_portrait_keep_t${tier.coerceIn(1, 4)}"

/**
 * Draws [name] centred in a [size] × [height] box at a whole number of device pixels per art pixel, nearest sampled
 * ([FilterQuality.None]). [frame] picks one frame of a strip. Names the hub does not own go to the kit's PkwIcon.
 */
@Composable fun HubArt(name: String, size: Dp, modifier: Modifier = Modifier, height: Dp = size, contentDescription: String? = null,
    alpha: Float = 1f, frame: Int = 0) {
    val art = hubDrawable(name)
    if (art == null) {
        PkwIcon(name, size, modifier, contentDescription, alpha)
        return
    }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(art.id)
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size, height).then(described)) {
        val frameW = bitmap.width / art.frames
        val frameH = bitmap.height
        val logicalW = (frameW / art.grid).coerceAtLeast(1)
        val logicalH = (frameH / art.grid).coerceAtLeast(1)
        val k = minOf(integerArtScale(this.size.width, logicalW), integerArtScale(this.size.height, logicalH))
        val w = logicalW * k
        val h = logicalH * k
        val f = frame.mod(art.frames)
        drawImage(bitmap, srcOffset = IntOffset(f * frameW, 0), srcSize = IntSize(frameW, frameH),
            dstOffset = IntOffset(((this.size.width - w) / 2f).roundToInt(), ((this.size.height - h) / 2f).roundToInt()),
            dstSize = IntSize(w, h), alpha = alpha, filterQuality = FilterQuality.None)
    }
}
