package gg.pixelkingdomwars.nativeclient.ui.chrome

import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.ui.Palette

/** Progress is supplied by completed work, never an elapsed-time estimate. Unknown work stays indeterminate. */
@Composable fun LoadingCard(title: String, detail: String = "", modifier: Modifier = Modifier, art: String = "profile",
    progress: Float? = null, progressLabel: String? = null, error: String? = null, retrying: Boolean = false,
    retryLabel: String = "TRY AGAIN", onRetry: (() -> Unit)? = null) {
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    PixelPanel(modifier.widthIn(max = 380.dp).fillMaxWidth()) {
        Column(Modifier.background(Palette.ink).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt(art, Modifier.size(36.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(title, color = Palette.goldHi, style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    if (detail.isNotBlank() && (error == null || retrying)) Text(detail, color = Palette.muted, style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (error == null || retrying) {
                if (progress != null) LinearProgressIndicator(progress = progress, modifier = Modifier.height(8.dp))
                else if (lifecycle.isAtLeast(Lifecycle.State.STARTED)) LinearProgressIndicator(modifier = Modifier.height(8.dp))
                else Box(Modifier.fillMaxWidth().height(8.dp).background(Palette.border)
                    .semantics { progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate })
                progressLabel?.let { Text(it, color = Palette.muted, style = MaterialTheme.typography.labelSmall) }
            }
            error?.let {
                if (!retrying) Text(it, color = Palette.muted, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
                onRetry?.let { retry -> Button(onClick = retry, enabled = !retrying, modifier = Modifier.fillMaxWidth()) {
                    Text(if (retrying) "TRYING AGAIN…" else retryLabel, fontSize = 18.sp)
                } }
            }
        }
    }
}

/** Opaque first-entry shell. Scene-transitions spec §1.2: never over a Home scene area — Home shows its postcard or the
 * realm wallpaper (ui/kingdom/ScenePresentation.kt). Remaining uses: a render failure with no picture, and the battle,
 * replay, scout and world openings until their own transitions land (spec V2 steps 8–9). Available space stays scrollable
 * in landscape and with enlarged text. */
@Composable fun LoadingOverlay(title: String, modifier: Modifier = Modifier, art: String = "profile",
    progress: Float? = null, progressLabel: String? = null, error: String? = null,
    onRetry: (() -> Unit)? = null, topBar: (@Composable () -> Unit)? = null) {
    Column(modifier.fillMaxSize().background(Palette.backdrop).blockSceneInput()
        .windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        topBar?.invoke()
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            LoadingCard(title = title, art = art, progress = progress, progressLabel = progressLabel,
                error = error, onRetry = onRetry,
                modifier = Modifier.align(Alignment.Center).heightIn(max = maxHeight).verticalScroll(rememberScrollState()))
        }
    }
}
