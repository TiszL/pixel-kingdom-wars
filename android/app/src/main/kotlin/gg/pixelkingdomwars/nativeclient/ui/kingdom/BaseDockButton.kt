package gg.pixelkingdomwars.nativeclient.ui.kingdom

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate

/** Secondary floating base tools keep at least a48dp touch target. */
@Composable internal fun BaseDockButton(label: String, art: String, description: String, enabled: Boolean = true,
    counter: String? = null, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val density=LocalDensity.current
    val measurer=rememberTextMeasurer()
    val labelStyle=MaterialTheme.typography.labelMedium.copy(fontSize=11.sp,lineHeight=11.sp,letterSpacing=.5.sp)
    val counterStyle=MaterialTheme.typography.bodyMedium.copy(fontSize=15.sp,lineHeight=15.sp)
    val labelSize=measurer.measure(label,labelStyle,maxLines=1,softWrap=false).size
    val counterSize=counter?.let { measurer.measure(it,counterStyle,maxLines=1,softWrap=false).size }
    val iconSize=if(counter==null)18.dp else 24.dp
    val tileWidth=with(density) { maxOf(52.dp,labelSize.width.toDp()+6.dp,iconSize+(counterSize?.width?.toDp()?.plus(3.dp) ?: 0.dp)+6.dp) }
    val tileHeight=with(density) { maxOf(48.dp,maxOf(iconSize,counterSize?.height?.toDp() ?: 0.dp)+labelSize.height.toDp()+6.dp) }
    PixelPlate(if (pressed) "dock-sunk" else "dock", Modifier.size(tileWidth, tileHeight)
        .semantics { contentDescription = description+counter?.let { ", $it" }.orEmpty() }
        .clickable(enabled = enabled, role = Role.Button, interactionSource = interaction, indication = null, onClick = onClick)) {
        Column(Modifier.fillMaxSize().offset(y = if (pressed) 1.dp else 0.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                GameArt(art, Modifier.size(iconSize))
                counter?.let { Text(it, style=counterStyle, maxLines=1, softWrap=false, color = if (enabled) Palette.text else Palette.muted) }
            }
            Text(label, style=labelStyle, maxLines = 1, softWrap=false, color = Palette.textFaint)
        }
    }
}
