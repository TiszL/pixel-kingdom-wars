package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.ScoutPreview
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ScoutActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ScoutOverlay
import kotlinx.serialization.json.JsonObject

/** Presentation bridge only: the screen retains the scene, countdown, camera and attack/recovery owner. */
@Composable internal fun ScoutLiveOverlay(preview: ScoutPreview, current: ScoutPreview?, catalogue: JsonObject?,
    busy: Boolean, loading: Boolean, secondsLeft: Int?, message: String?, graphicsRetry: (() -> Unit)?,
    onAttack: () -> Unit, onClose: () -> Unit, onCamera: () -> Unit,
    onHeaderMeasured: (Int) -> Unit, onFooterMeasured: (Int) -> Unit) {
    val ui = scoutLiveUi(preview, current, catalogue, busy, loading, secondsLeft)
    var refusal by remember(preview, ui.attack.reason) { mutableStateOf<String?>(null) }
    // SKIP is never drawn here (no current scout source offers a next base: skip = null); should one appear before a
    // search owner exists, its tap explains instead of doing nothing.
    ScoutOverlay(ui, ScoutActions(onAttack = onAttack, onSkip = { refusal = "There is no next base to skip to from this scout." },
        onHome = onClose, onTapBuilding = {},
        onRefused = { refusal = it.reason }), onHeaderMeasured = onHeaderMeasured, onFooterMeasured = onFooterMeasured) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                if ((preview.previewSec ?: 0) > 0 && secondsLeft != null) {
                    PkwText("Preview · ${secondsLeft.coerceAtLeast(0)}s", PkwTokens.Type.small,
                        color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                }
                PkwText("Read-only preview. Deployment opens when you attack.", PkwTokens.Type.small,
                    color = PkwTokens.Colors.text, outline = 1.dp, maxLines = 2)
            }
            QuietButton("CAMERA", onCamera, contentDescription = "Preview camera controls")
        }
        listOfNotNull(ui.attack.reason, refusal, message).distinct().forEach { explanation ->
            PkwText(explanation, PkwTokens.Type.small, color = PkwTokens.Colors.text, outline = 1.dp, maxLines = 3)
        }
        graphicsRetry?.let { retry ->
            QuietButton("TRY AGAIN", retry, contentDescription = "Couldn’t update the preview. Try again")
        }
    }
}
