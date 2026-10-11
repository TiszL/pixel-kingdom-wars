package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
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
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftDrawable
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.mapDrawable
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.voyageDrawable
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * Design component: the art of hub round 2 (design/final/hub/SPEC.md R2.1 Daily Cache, R2.2 event, part two RIGHT NOW
 * cards) at a whole number of device px per art px, nearest sampled ([FilterQuality.None]).
 *
 * Names: `r2:cache-chest` and `r2:cache-open-1..3` (the round-2 byte copies, ASSET-COPIES-r2-hub.md), `r2:banner-event`
 * (the authored `pkw_web_banner_event`, 96 × 24), `goldforge-t3-idle` (112 px), and the other clusters' copies by their
 * own prefixes (`voyage:`, `craft:`, `site:`); every other name goes to [HubArt] unchanged.
 *
 * Why a second resolver: `hubDrawable` (HubArt.kt) is the committed hub file and is not edited; and its scale rounds to
 * the NEAREST whole number, which overflows a box (112 px art in a 112 dp box at 2.625 px/dp draws at 3×). This one picks
 * the largest whole scale that FITS the box, so wide art (the event banner, the 112 px buildings) never bleeds.
 */

/** The drawable of a round-2 hub art name, or null to hand the name to [HubArt]. */
internal fun hubR2Drawable(name: String): Int? = when {
    name == "r2:cache-chest" -> R.drawable.pkw_ui_cache_chest
    name == "r2:cache-open-1" -> R.drawable.pkw_ui_cache_open_f1
    name == "r2:cache-open-2" -> R.drawable.pkw_ui_cache_open_f2
    name == "r2:cache-open-3" -> R.drawable.pkw_ui_cache_open_f3
    name == "r2:banner-event" -> R.drawable.pkw_web_banner_event
    name == "goldforge-t3-idle" -> R.drawable.pkw_ui_goldforge_t3_idle
    name.startsWith("voyage:") -> voyageDrawable(name)
    name.startsWith("craft:") -> craftDrawable(name)
    name.startsWith("site:") -> mapDrawable(name)
    else -> null
}

/** The largest whole scale at which [art] px fit [boxPx] (at least 1). Pure; JVM-tested. */
fun fitArtScale(boxPx: Float, art: Int): Int = if (art <= 0) 1 else maxOf(1, floor(boxPx / art).toInt())

/** Draws [name] centred in a [size] × [height] box at the largest fitting whole scale; unknown names go to [HubArt]. */
@Composable fun R2HubArt(name: String, size: Dp, modifier: Modifier = Modifier, height: Dp = size, contentDescription: String? = null,
    alpha: Float = 1f) {
    val id = hubR2Drawable(name)
    if (id == null) { HubArt(name, size, modifier, height, contentDescription, alpha); return }
    val bitmap = gg.pixelkingdomwars.nativeclient.ui.kit.kitImageResource(id)
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size, height).then(described)) {
        val k = minOf(fitArtScale(this.size.width, bitmap.width), fitArtScale(this.size.height, bitmap.height))
        val w = bitmap.width * k; val h = bitmap.height * k
        drawImage(bitmap, IntOffset.Zero, IntSize(bitmap.width, bitmap.height),
            IntOffset(((this.size.width - w) / 2f).roundToInt(), ((this.size.height - h) / 2f).roundToInt()), IntSize(w, h),
            alpha = alpha, filterQuality = FilterQuality.None)
    }
}
