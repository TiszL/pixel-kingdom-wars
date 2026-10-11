package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.ceil
import kotlin.math.roundToInt

/*
 * The account cluster's living header art band (SPEC §4 shared header, §2.1 land gate: "real base crop", rule 0.1
 * "backdrops are current art only"). The frames draw a crop of a real kingdom behind the 138 dp header; the app has no
 * live render of the player's own Keep area for a sheet header yet (that needs a renderer snapshot), so until one is
 * handed in as `snapshot` the header shows the owner-approved realm painting the title and loading screens use
 * (`pkw_web_loading_portrait`, 2026-09-25), cropped to its Keep and village, instead of a flat charcoal box. Nothing is
 * generated or edited: it is the same bundled master, drawn at a whole-number zoom with nearest sampling.
 */

/** Where the band sits in the painting (0 = top, 1 = bottom): its castle keep and the first village row. */
internal const val REALM_HEADER_FOCUS_Y = 0.27f

/** The decoded painting, shared by every header so a second open draws it on its first frame (no decode, no flash). */
private object RealmHeaderPainting {
    @Volatile var bitmap: ImageBitmap? = null
}

/** How many painting rows fill a band [heightPx] tall at zoom [zoom] (never more than the painting has). Pure; JVM-tested. */
internal fun realmHeaderRows(artHeight: Int, heightPx: Float, zoom: Int): Int =
    minOf(artHeight, ceil(heightPx / zoom.coerceAtLeast(1)).toInt().coerceAtLeast(1))

/** The first painting row of a band [rows] tall centred on [focusY], kept inside the painting. Pure; JVM-tested. */
internal fun realmHeaderTop(artHeight: Int, rows: Int, focusY: Float): Int =
    (artHeight * focusY - rows / 2f).roundToInt().coerceIn(0, (artHeight - rows).coerceAtLeast(0))

/** The smallest whole-number zoom at which a painting [artWidth] px wide covers [widthPx]. Pure; JVM-tested. */
internal fun realmHeaderZoom(artWidth: Int, widthPx: Float): Int = maxOf(1, ceil(widthPx / artWidth.coerceAtLeast(1)).toInt())

/**
 * The realm painting band behind a 138 dp living header. Decorative (no semantics). Until the painting is decoded (first
 * open of the session only, off the main thread) it draws the charcoal the header used before, never a blank frame.
 */
@Composable internal fun RealmHeaderArt(modifier: Modifier = Modifier, focusY: Float = REALM_HEADER_FOCUS_Y) {
    val resources = LocalContext.current.resources
    val painting by produceState(RealmHeaderPainting.bitmap, resources) {
        if (value == null) value = withContext(Dispatchers.IO) {
            runCatching { ImageBitmap.imageResource(resources, R.drawable.pkw_web_loading_portrait) }.getOrNull()
        }?.also { RealmHeaderPainting.bitmap = it }
    }
    val art = painting
    if (art == null) {
        Box(modifier.background(PkwTokens.Colors.charcoal))
        return
    }
    // Only primitives and inline value classes in the draw block: nothing is allocated per draw.
    Canvas(modifier.clearAndSetSemantics { }) {
        val zoom = realmHeaderZoom(art.width, size.width)
        val rows = realmHeaderRows(art.height, size.height, zoom)
        val top = realmHeaderTop(art.height, rows, focusY)
        val width = art.width * zoom
        drawImage(art, srcOffset = IntOffset(0, top), srcSize = IntSize(art.width, rows),
            dstOffset = IntOffset(((size.width - width) / 2f).roundToInt(), 0), dstSize = IntSize(width, rows * zoom),
            filterQuality = FilterQuality.None)
    }
}
