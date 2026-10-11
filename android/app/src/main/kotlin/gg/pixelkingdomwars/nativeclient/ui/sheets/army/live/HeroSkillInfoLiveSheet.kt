package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize

/** Read-only HALF sheet. Only its painted frame intercepts scene input; no second full-screen
 * scrim and no upgrade/spend callback. Closing restores the selected hero and tab in its host. */
@Composable internal fun HeroSkillInfoLiveSheet(ui: HeroSkillInfoUi, onClose: () -> Unit) {
    val c = PkwTokens.Colors
    BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
        SheetFrame(SheetFrameUi("SKILL INFO", null, SheetSize.HALF, emptyList(), null), onClose,
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(maxHeight * .5f).padding(horizontal = 4.dp, vertical = 6.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (ui.icon.isNotBlank()) PkwIcon(ui.icon, 32.dp)
                Column(Modifier.weight(1f)) {
                    PkwText(ui.name, PkwTokens.Type.label, color = c.textOnParch)
                    PkwText(if (ui.unlocked) "Ready · opens at Lv ${ui.unlockLevel}" else "Opens at Lv ${ui.unlockLevel}",
                        PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
            val frequency = if (ui.oncePerBattle) "Once a battle" else ui.cooldown
            frequency?.let { PkwText(it, PkwTokens.Type.small, Modifier.padding(horizontal = 6.dp), color = c.textOnParch2) }
            PkwText("Skill values by tier", PkwTokens.Type.body, Modifier.padding(horizontal = 6.dp), color = c.textOnParch)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                (1..4).forEach { tier ->
                    Plate(PlateKind.CREAM,
                        Modifier.weight(1f).semantics { contentDescription = "Tier $tier${if (tier == ui.currentTier) ", current" else ""}" },
                        contentPadding = PaddingValues(6.dp), tint = if (tier == ui.currentTier) c.selectedTint else null,
                        blocksScene = false) {
                        PkwText("T$tier", PkwTokens.Type.caption, color = c.textOnParch)
                    }
                }
            }
            ui.metrics.forEach { metric ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    PkwText(metric.label, PkwTokens.Type.small, color = c.textOnParch2)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        metric.values.forEachIndexed { index, value ->
                            PkwText(value, PkwTokens.Type.body, Modifier.weight(1f)
                                .background(if (index + 1 == ui.currentTier) c.selectedTint else c.cream)
                                .padding(horizontal = 4.dp, vertical = 3.dp), color = c.textOnParch)
                        }
                    }
                }
            }
        }
    }
}
