package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/** Supplemental commands already owned by LiveBattleScreen; no action or lifetime is created here. */
internal data class LiveBattleHudTool(val label: String, val enabled: Boolean, val onClick: () -> Unit,
    val verb: Verb = Verb.STONE)

/** A short, horizontally scrolling designed shelf retains START, speed, rally, next target and recovery doors. */
@Composable internal fun LiveBattleHudTools(tools: List<LiveBattleHudTool>, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().sceneInputRegion().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        tools.forEach { tool -> SecondaryButton(tool.label, tool.onClick, verb = tool.verb, enabled = tool.enabled) }
    }
}

/** Preserve the owner's quiet hint slot: a first deploy empties the words without moving the camera or deck. The slot
 *  has one fixed height (one or two lines, or none, never move the measured chrome), and the words sit in the designed
 *  hint pill (battle-hud.png: ink 86 %, at least 34 tall, centred, light VT text; no rounded corners). Paint only. */
@Composable internal fun LiveBattleHudHint(hint: String?, modifier: Modifier = Modifier) {
    if (hint == null) return
    Box(modifier.fillMaxWidth().height(LIVE_HINT_SLOT).padding(horizontal = 12.dp, vertical = 2.dp), contentAlignment = Alignment.Center) {
        if (hint.isNotEmpty()) Box(Modifier.background(PkwTokens.Colors.ink.copy(alpha = 0.86f)).heightIn(min = 34.dp)
            .padding(horizontal = 12.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
            PkwText(hint, PkwTokens.Type.small, color = PkwTokens.Colors.text, textAlign = TextAlign.Center, maxLines = 2)
        }
    }
}

/** Two VT 18 lines (2 × 20) in the pill's 4 dp padding plus the slot's own 2 dp: the hint never grows the slot. */
private val LIVE_HINT_SLOT = 52.dp
