package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: ProgressBar and Ring (DESIGN-SYSTEM §6). Bar: 12-14 dp, ink S rim, #3A2F28 track, a [verb] fill with a
 * 2 dp highlight, and queued / pending work as green stripes at 75 %. Ring: 48 dp, a 3 dp gold arc on a dark track with
 * a VT number inside. An unknown progress (null) draws an empty track and says so; it never draws as zero done.
 * Neither takes touches.
 */
@Composable fun ProgressBar(progress: Float?, description: String, modifier: Modifier = Modifier, verb: Verb = Verb.GREEN,
    pending: Float? = null, height: Dp = PkwTokens.Dims.progressBarH) {
    val ramp = PkwTokens.ramp(verb)
    Canvas(modifier.fillMaxWidth().height(height).clearAndSetSemantics {
        contentDescription = description
        progressBarRangeInfo = if (progress == null) ProgressBarRangeInfo.Indeterminate else ProgressBarRangeInfo(progress.coerceIn(0f, 1f), 0f..1f)
    }) {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 2.dp.toPx(); val l = i; val t = i; val w = size.width - 2 * i; val h = size.height - 2 * i
        if (w <= 0f || h <= 0f) return@Canvas
        drawRect(PkwTokens.Colors.track, Offset(l, t), Size(w, h))
        val done = (progress ?: 0f).coerceIn(0f, 1f)
        val queued = (pending ?: done).coerceIn(done, 1f)
        if (queued > done) {
            val stripe = 4.dp.toPx()
            val brush = Brush.linearGradient(0f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.face,
                1f to PkwTokens.Colors.green.face, start = Offset.Zero, end = Offset(stripe * 2, stripe * 2), tileMode = TileMode.Repeated)
            drawRect(brush, Offset(l + w * done, t), Size(w * (queued - done), h), alpha = 0.75f)
        }
        if (progress != null && done > 0f) {
            drawRect(ramp.face, Offset(l, t), Size(w * done, h))
            drawRect(ramp.hi, Offset(l, t), Size(w * done, minOf(2.dp.toPx(), h)))
        }
    }
}

/** The 48 dp ring: a 3 dp gold arc for [progress] (null draws the track only) and [text] inside. */
@Composable fun ProgressRing(progress: Float?, text: String, description: String, modifier: Modifier = Modifier) {
    Box(modifier.size(PkwTokens.Dims.progressRing).clearAndSetSemantics {
        contentDescription = description
        progressBarRangeInfo = if (progress == null) ProgressBarRangeInfo.Indeterminate else ProgressBarRangeInfo(progress.coerceIn(0f, 1f), 0f..1f)
    }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.matchParentSize()) {
            val stroke = 3.dp.toPx()
            val inset = stroke / 2f + 1.dp.toPx()
            val arcSize = Size(size.width - 2 * inset, size.height - 2 * inset)
            drawCircle(PkwTokens.Colors.ink, radius = size.minDimension / 2f)
            drawArc(PkwTokens.Colors.track, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
            if (progress != null) drawArc(PkwTokens.Colors.gold.face, -90f, 360f * progress.coerceIn(0f, 1f), false, Offset(inset, inset), arcSize, style = Stroke(stroke))
        }
        PkwText(text, PkwTokens.Type.small, color = PkwTokens.Colors.text)
    }
}

@Preview(name = "Progress", widthDp = 320, heightDp = 140)
@Composable private fun ProgressPreview() {
    Column(Modifier.background(PkwTokens.Colors.bg).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ProgressBar(0.6f, "96 trained, 6 queued, of 120", pending = 0.8f)
        ProgressBar(null, "Progress unknown")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ProgressRing(0.7f, "70", "70 percent")
            ProgressRing(null, UNKNOWN, "Progress unknown")
        }
    }
}
