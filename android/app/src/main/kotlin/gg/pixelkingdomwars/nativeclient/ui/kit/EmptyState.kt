package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftIcon

/**
 * Design component: EmptyState (DESIGN-SYSTEM §6, kit-2.png "EMPTY STATE"): on parchment, the 64 dp authored icon at 40 %,
 * a VT 20 headline, a VT 18 reason and a full-width blue "GO TO <place>" 48 tall (PS 11 outlined) that flies to where the
 * thing is made. Only the GO is a touch target.
 */
@Composable fun EmptyState(ui: EmptyStateUi, onGo: (FeatureId) -> Unit, modifier: Modifier = Modifier) {
    Plate(PlateKind.PARCHMENT, modifier.fillMaxWidth(), blocksScene = false) {
        Column(Modifier.fillMaxWidth().padding(vertical = 5.dp, horizontal = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            CraftIcon(ui.icon, 64.dp, alpha = 0.4f)
            PkwText(ui.headline, PkwTokens.Type.body, Modifier.padding(top = 4.dp), color = PkwTokens.Colors.textOnParch,
                textAlign = TextAlign.Center, maxLines = 2)
            PkwText(ui.reason, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center, maxLines = 3)
            val go = ui.go
            val label = ui.goLabel
            if (go != null && label != null) {
                ChunkyBox(PkwTokens.Colors.blue, { onGo(go) }, label, Modifier.padding(top = 8.dp).fillMaxWidth().height(48.dp)) {
                    PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
                }
            }
        }
    }
}

@Preview(name = "Empty state", widthDp = 300, heightDp = 300)
@Composable private fun EmptyStatePreview() {
    Box(Modifier.background(PkwTokens.Colors.wood).padding(8.dp)) {
        EmptyState(EmptyStateUi("ui:navigation-kit", "No boat yet", "Build one at the Berth to explore islands.", "GO TO BERTH", FeatureId("berth.fleet")), onGo = {})
    }
}
