package gg.pixelkingdomwars.nativeclient.ui.chrome

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.Palette

/** The insets every full-screen page with a text input owes the player: the safe area (bars, cutout)
 * and the soft keyboard. The activity is edge-to-edge, so a page without this draws its lower half
 * (fields, SUBMIT) under the keyboard and its header under the cutout. Inset padding
 * consumes what it applies, so the pair never pads the keyboard twice; put it before the page's
 * own padding and give the page a scrolling child so the focused field can be brought into view. */
fun Modifier.pageInsets(): Modifier = safeDrawingPadding().imePadding()

/** Web ScrollPage's fixed phead and square close target. Back ownership stays with the caller. */
@Composable fun GamePage(title: String, onClose: () -> Unit, modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxSize().background(Palette.card).pageInsets().blockSceneInput()) {
        GamePageHeader(title, onClose)
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

@Composable fun GamePageHeader(title: String, onClose: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().background(Palette.ink).blockSceneInput()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f).semantics { heading() }, color = Palette.gold, style = MaterialTheme.typography.titleLarge)
            Box(Modifier.size(48.dp).semantics { contentDescription = "Close" }
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClose),
                contentAlignment = Alignment.Center) { GameArt("close", Modifier.size(22.dp)) }
        }
        HorizontalDivider()
    }
}
