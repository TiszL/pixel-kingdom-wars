package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.core.graphics.withSave

/**
 * The HUD's small glows and hard drops (HUD-STYLE §4–§9), drawn the way CSS draws an outer `box-shadow`: the element's
 * rect grown by the spread, moved by the offset, blurred with the CSS Gaussian ([cssBlurToSkiaRadius]), and painted only
 * OUTSIDE the element's own box, so glass stays glass. Skia draws a blurred rect analytically (one quad, no offscreen
 * pass), and the paints are built once per size.
 *
 * Only small glows are drawn (a button, a chip, a pip, the lit panel edge, the minimap frame). The panels' large drop
 * shadows and accent glows (`0 18px 48px`, `0 0 48px -10px`, the sheet's `0 -14px 40px`) are left out on purpose: each is
 * 1.5–3.8 MP of blended fill, and the HUD window is redrawn with every GL frame that moves a map label, on the GPU the
 * world draws with (D-167.2, smoothness first). Backdrop blur is left out because the UI window cannot sample the GL
 * SurfaceView under it.
 */
internal fun Modifier.hudShadows(vararg layers: HudShadow?): Modifier {
    val list = layers.filterNotNull()
    if (list.isEmpty()) return this
    return drawWithCache {
        val paints = list.map { l -> shadowPaint(l, cssBlurToSkiaRadius(l.blur * density)) }
        onDrawBehind { drawShadowRects(list, paints, Rect(0f, 0f, size.width, size.height), clipOutside = true) }
    }
}

internal fun shadowPaint(layer: HudShadow, radiusPx: Float): android.graphics.Paint =
    android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = layer.color.toArgb()
        if (radiusPx > 0f) maskFilter = android.graphics.BlurMaskFilter(radiusPx, android.graphics.BlurMaskFilter.Blur.NORMAL)
    }

/**
 * Paint [layers] (first-listed on top, the CSS order) for the box [box] (px). [clipOutside] keeps them off the box itself
 * (an outer shadow); otherwise they are clipped INTO [clip] (a glow inside a panel that clips its content).
 */
internal fun DrawScope.drawShadowRects(layers: List<HudShadow>, paints: List<android.graphics.Paint>, box: Rect, clipOutside: Boolean, clip: Rect? = null) {
    val px = density // read here: inside withSave `density` would be android.graphics.Canvas's bitmap density
    drawIntoCanvas { c ->
        c.nativeCanvas.withSave {
            if (clipOutside) clipOutRect(box.left, box.top, box.right, box.bottom)
            clip?.let { clipRect(it.left, it.top, it.right, it.bottom) }
            for (i in layers.indices.reversed()) {
                val l = layers[i]; val s = l.spread * px; val dx = l.dx * px; val dy = l.dy * px
                drawRect(box.left + dx - s, box.top + dy - s, box.right + dx + s, box.bottom + dy + s, paints[i])
            }
        }
    }
}
