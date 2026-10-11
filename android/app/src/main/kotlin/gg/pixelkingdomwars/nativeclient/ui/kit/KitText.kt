package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Design component: kit text (DESIGN-SYSTEM §4 Type). Numerals and captions on the world or on a chunky face carry the
 * 2-pass outline: an ink stroke ([outline] dp outside the glyph), then the fill. Text on parchment is never outlined.
 * Use the [PkwTokens.Type] styles only; none of them is below the 18 sp body floor.
 */
@Composable fun PkwText(text: String, style: TextStyle, modifier: Modifier = Modifier, color: Color = PkwTokens.Colors.text,
    outline: Dp = 0.dp, textAlign: TextAlign? = null, maxLines: Int = 1) {
    val overflow = TextOverflow.Ellipsis
    if (outline <= 0.dp) {
        Text(text = text, modifier = modifier, color = color, textAlign = textAlign, overflow = overflow, softWrap = maxLines > 1,
            maxLines = maxLines, style = style)
        return
    }
    val strokePx = with(LocalDensity.current) { (outline * 2).toPx() }
    val stroke = style.copy(drawStyle = Stroke(width = strokePx, join = StrokeJoin.Miter, miter = 2f))
    val align = when (textAlign) { TextAlign.Center -> Alignment.Center; TextAlign.End, TextAlign.Right -> Alignment.CenterEnd; else -> Alignment.CenterStart }
    Box(modifier, contentAlignment = align) {
        // The stroke pass is decoration: screen readers hear the fill pass only.
        Text(text = text, modifier = Modifier.clearAndSetSemantics { }, color = PkwTokens.Colors.ink, textAlign = textAlign,
            overflow = overflow, softWrap = maxLines > 1, maxLines = maxLines, style = stroke)
        Text(text = text, color = color, textAlign = textAlign, overflow = overflow, softWrap = maxLines > 1, maxLines = maxLines, style = style)
    }
}

@Preview(name = "Kit type", widthDp = 320, heightDp = 360)
@Composable private fun KitTextPreview() {
    Column(Modifier.background(PkwTokens.Colors.bg).padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        PkwText("40,943", PkwTokens.Type.numeralL, color = PkwTokens.Colors.label, outline = 2.dp)
        PkwText("FORGE", PkwTokens.Type.primary, color = PkwTokens.Colors.label, outline = 2.dp)
        PkwText("GOLD FORGE", PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
        PkwText("UPGRADE", PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
        PkwText("ATTACK 3 NEW", PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
        PkwText("Sent straight to your wallet", PkwTokens.Type.lead)
        PkwText("Ready in 2h 14m at the Workshop", PkwTokens.Type.body)
        PkwText("Earned on Seeker Island", PkwTokens.Type.small, color = PkwTokens.Colors.muted)
    }
}
