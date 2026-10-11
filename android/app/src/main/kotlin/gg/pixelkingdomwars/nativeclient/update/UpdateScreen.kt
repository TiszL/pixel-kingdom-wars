package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.boot.BootStrip
import gg.pixelkingdomwars.nativeclient.ui.boot.STRIP_BUTTON_SP
import gg.pixelkingdomwars.nativeclient.ui.boot.StripButton
import gg.pixelkingdomwars.nativeclient.ui.boot.stripButtonSize
import gg.pixelkingdomwars.nativeclient.ui.boot.bootStripContent
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.LoadingBackdrop
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Title and Home root mount, drawn over the whole screen only while [updatePresentation] says so. [NativeUpdateBanner],
 * mounted in the same screen, keeps the resume and installer-confirmation effects, so neither fires twice. */
@Composable fun NativeUpdateScreen() {
    val repository = NativeUpdateRuntime.repository ?: return
    val state by repository.state.collectAsState()
    val mandatory by repository.isMandatoryBlocking.collectAsState()
    if (updatePresentation(state, mandatory) != UpdatePresentation.FullScreen) return
    val context = LocalContext.current
    UpdateScreen(state, onDownload = { repository.startDownload(it) }, onInstall = { repository.install() }, onCancel = repository::cancel,
        onOpenSettings = { (state as? UpdateState.AwaitingPermission)?.prompt?.launch(context) },
        onConfirm = { (state as? UpdateState.AwaitingUserAction)?.prompt?.launch(context) })
}

/** The boot gate's required update (owner 2026-09-27; D-193 moved it from a card to the boot strip): the gate has
 * already started the download, which goes to Android's installer once verified; the forward action is the strip's
 * button, and CHECK AGAIN ([onRetry], with the dApp Store line on line 2) appears whenever the update itself has no way
 * forward, and for the rest of the launch once it has failed ([bootRetryOffered]), so the launch is never a dead end.
 * Without an offer (a frame between decisions) the loading strip stays. */
@Composable fun bootRequiredUpdateStrip(repository: UpdateRepository, gate: BootUpdateGate, onRetry: () -> Unit): BootStrip {
    val state by repository.state.collectAsState()
    val failures by repository.failures.collectAsState()
    val context = LocalContext.current
    val offer = state.offer ?: return BootStrip(bootStripContent(null, false))
    val held = rememberHeldFraction(state)
    val retryOffered = bootRetryOffered(state, gate.failedThisLaunch(failures))
    return BootStrip(updateStripContent(state, offer, required = true, retryOffered = retryOffered, held = held)) {
        // Verifying, installing and an unretryable failure have no forward action; nothing replaces it.
        updateForwardAction(state)?.let { action -> UpdateActionButton(action, state, onDownload = { repository.updateNow(it) }, onInstall = { repository.updateNow() },
            onCancel = repository::cancel, onConfirm = { (state as? UpdateState.AwaitingUserAction)?.prompt?.launch(context) },
            onOpenSettings = { (state as? UpdateState.AwaitingPermission)?.prompt?.launch(context) }, Modifier.stripButtonSize(), fontSize = STRIP_BUTTON_SP.sp) }
        if (retryOffered) StripButton("CHECK AGAIN", onRetry, ghost = true)
    }
}

/** The Title/Home required update ([NativeUpdateScreen]) owns the screen: the loading wallpaper behind a boot-style
 * card, the dialog's own copy and forward action, and no dismiss control. The painted surface blocks the kingdom and
 * title controls underneath. The boot gate's required update is [bootRequiredUpdateStrip], not this. */
@Composable fun UpdateScreen(state: UpdateState, modifier: Modifier = Modifier, onDownload: (consentToMetered: Boolean) -> Unit,
                             onInstall: () -> Unit, onOpenSettings: () -> Unit, onCancel: () -> Unit = {}, onConfirm: () -> Unit = {}) {
    val offer = state.offer ?: return
    BoxWithConstraints(modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Palette.surface, Palette.backdrop))).blockSceneInput()) {
        LoadingBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .9f)
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 20.dp, vertical = 16.dp)
            .verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            PixelPanel(Modifier.widthIn(max = 380.dp).fillMaxWidth()) {
                Column(Modifier.background(Palette.ink).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        GameArt("profile", Modifier.size(36.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("UPDATE REQUIRED", color = Palette.goldHi, style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                            Text("Version ${offer.versionName} · ${megabytes(offer.sizeBytes)}", color = Palette.muted, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    CompositionLocalProvider(LocalContentColor provides Palette.text) {
                        ProvideTextStyle(MaterialTheme.typography.bodyMedium) {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                MandatoryUpdateNote()
                                UpdateStateCopy(state, offer)
                            }
                        }
                    }
                    // Verifying, installing and an unretryable failure have no forward action; nothing replaces it.
                    updateForwardAction(state)?.let { UpdateActionButton(it, state, onDownload, onInstall, onCancel, onConfirm, onOpenSettings, Modifier.fillMaxWidth()) }
                }
            }
        }
    }
}
