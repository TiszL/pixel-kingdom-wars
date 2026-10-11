package gg.pixelkingdomwars.nativeclient.ui.boot

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.BootLoading
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.BootLoadingUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateKind
import gg.pixelkingdomwars.nativeclient.update.GATE_BUSY
import gg.pixelkingdomwars.nativeclient.update.UpdateGateCalls
import gg.pixelkingdomwars.nativeclient.update.UpdateState
import gg.pixelkingdomwars.nativeclient.update.bootRetryOffered
import gg.pixelkingdomwars.nativeclient.update.runGateUpdate
import gg.pixelkingdomwars.nativeclient.update.updateGateUi

/**
 * The designed boot route (design/final/hub/loading.png, update.png; SPEC §3.4, §3.7): the boot loading card while the
 * launch loads, and the update gate over it when the launch's update gate decides REQUIRED or OPTIONAL. The decisions
 * stay with [bootDestination] and the update helpers; this file only picks the designed surface for each destination.
 *
 * LEADER CONFIRMS AT MOUNT: [BootLoading] draws the approved logo at the top. SHARDKEEP D-193 says the boot screen is the
 * wallpaper, one strip and the version label, "nothing else"; the hub SPEC §3.4 adds the logo. The two conflict, so the
 * owner's yes is needed before this replaces [BootScreen] for LOADING (if refused, keep BootScreen there).
 * MOUNTED 2026-10-05 WITHOUT THAT YES: D-193 is a locked owner decision, so the loading surface (and the background under
 * the update gate) stays the D-193 [BootScreen] strip with its tip; the designed gate card is drawn over it. Once the owner
 * says yes, swap the [BootScreen] call below for `BootLoading(loading, onFinished = {})` with
 * `val loading = remember { bootLoadingUi(VERSION_LABEL_PREFIX + BuildConfig.VERSION_NAME) }`.
 */

/** Which designed surface a boot destination draws. */
internal enum class BootSurface { LOADING, UPDATE_REQUIRED, UPDATE_OPTIONAL, CONTENT_FAILED }

internal fun bootSurface(destination: BootDestination): BootSurface = when (destination) {
    BootDestination.UPDATE_REQUIRED -> BootSurface.UPDATE_REQUIRED
    BootDestination.UPDATE_AVAILABLE -> BootSurface.UPDATE_OPTIONAL
    BootDestination.CONTENT_FAILED -> BootSurface.CONTENT_FAILED
    // The route navigates away from these on the next frame; until then the launch is still loading.
    BootDestination.LOADING, BootDestination.PREVIEW, BootDestination.TITLE, BootDestination.TOTP, BootDestination.ALPHA,
    BootDestination.HOME -> BootSurface.LOADING
}

/** The boot card's words: the strip's own loading step, the tips' sentences and the version label (D-192 format). The
 * boot meter is a sweep with nothing measured, so there is no percent and no fill: never a fabricated number. */
internal fun bootLoadingUi(version: String, tips: List<BootTip> = BOOT_TIPS): BootLoadingUi = BootLoadingUi(
    step = bootStripContent(null, false).title, percent = null, progress = null, tips = tips.map { it.text }, version = version)

/**
 * The boot route body for [destination] (replaces the route's one BootScreen call).
 * - LOADING (and the destinations the route is about to leave for): [BootLoading].
 * - UPDATE_REQUIRED: [BootLoading] behind the required [GateCard]; no LATER and no Back dismissal. UPDATE runs the update's
 *   forward action with the boot strip's callbacks, shows busy dots while it moves, and otherwise runs CHECK AGAIN
 *   (`checkAgain`: the content retry when content did not open, else a fresh check), so the launch is never a dead end.
 *   Without an offer (a frame between decisions) the loading card stays.
 * - UPDATE_AVAILABLE: the optional gate; LATER and Back open the game ([gg.pixelkingdomwars.nativeclient.update.BootUpdateGate.later]).
 * - CONTENT_FAILED has no designed frame (BootLoading has no action or failure slot): exactly the D-193 strip with TRY AGAIN.
 * The loading card sits in the same place for every update destination, so a LOADING to UPDATE hand-off keeps the
 * wallpaper and only the gate fades in.
 */
@Composable fun BootGateScreen(graph: AppGraph, destination: BootDestination, contentError: String?, bootBusy: Boolean, onRetryBoot: () -> Unit) {
    val surface = bootSurface(destination)
    if (surface == BootSurface.CONTENT_FAILED) {
        BootScreen(bootLoadingStrip(contentError, retrying = bootBusy, onRetryBoot), rememberBootTip())
        return
    }
    val updates = graph.updates
    val state by updates.state.collectAsState()
    val failures by updates.failures.collectAsState()
    val context = LocalContext.current
    val gate = when (surface) {
        BootSurface.UPDATE_REQUIRED -> updateGateUi(state, required = true,
            retryOffered = bootRetryOffered(state, graph.bootUpdates.failedThisLaunch(failures)))
        BootSurface.UPDATE_OPTIONAL -> updateGateUi(state, required = false, retryOffered = false)
        BootSurface.LOADING, BootSurface.CONTENT_FAILED -> null
    }
    // Only the optional gate is dismissible (SPEC §3.7); the required one leaves Back as the boot screen always had it.
    BackHandlerAt(BackPriority.CONFIRM, enabled = gate?.kind == GateKind.UPDATE_OPTIONAL) { graph.bootUpdates.later() }
    Box(Modifier.fillMaxSize()) {
        BootScreen(bootLoadingStrip(null, retrying = false, onRetryBoot), rememberBootTip())
        GateCard(gate, GateActions(
            onUpdate = {
                val now = updates.state.value
                // The boot strips' own callbacks: UPDATE NOW downloads if needed and hands the verified file to Android.
                val calls = UpdateGateCalls(onDownload = { updates.updateNow(it) }, onInstall = { updates.updateNow() },
                    onCancel = updates::cancel,
                    onConfirm = { (now as? UpdateState.AwaitingUserAction)?.prompt?.launch(context) },
                    onOpenSettings = { (now as? UpdateState.AwaitingPermission)?.prompt?.launch(context) },
                    onCheckAgain = {
                        val content = graph.content.state.value
                        graph.bootUpdates.checkAgain(content.error != null && !content.ready, onRetryBoot)
                    })
                if (!runGateUpdate(now, calls)) Toasts.post(GATE_BUSY)
            },
            onLater = { graph.bootUpdates.later() },
        ))
    }
}
