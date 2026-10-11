package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/** Troop details reuse the existing half-sheet frame; the host retains selected-tab and Back ownership. */
@Composable internal fun ArmyTroopInfoSheet(ui: ArmyTroopInfoUi, onClose: () -> Unit, onGo: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars)) {
        val height = if (maxHeight < 420.dp) maxHeight else maxHeight / 2
        SheetFrame(SheetFrameUi(ui.name.uppercase(), null, SheetSize.HALF, emptyList(), null, titleTag = ui.level), onClose,
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(max = height).padding(horizontal = 4.dp),
            footer = { ui.goLabel?.let { label -> SecondaryButton(label, onGo, Modifier.fillMaxWidth(), verb = Verb.BLUE) } }) {
            PkwIcon(ui.portrait, 56.dp, Modifier.align(Alignment.CenterHorizontally))
            ui.lockReason?.let { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2, maxLines = 3) }
            ui.stats.forEach { (label, value) ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText(label, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
                    PkwText(value, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
                }
            }
            ui.prose.forEach { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2, maxLines = 12) }
        }
    }
}
