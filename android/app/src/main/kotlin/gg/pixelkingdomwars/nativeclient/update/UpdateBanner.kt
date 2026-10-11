package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.boot.BootStrip
import gg.pixelkingdomwars.nativeclient.ui.boot.LoadingStripContent
import gg.pixelkingdomwars.nativeclient.ui.boot.STRIP_BUTTON_SP
import gg.pixelkingdomwars.nativeclient.ui.boot.LocalNarrowStrip
import gg.pixelkingdomwars.nativeclient.ui.boot.stripButtonSize
import gg.pixelkingdomwars.nativeclient.ui.boot.StripMeter
import gg.pixelkingdomwars.nativeclient.ui.boot.bootStripContent
import gg.pixelkingdomwars.nativeclient.ui.boot.heldFraction
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.HeraldPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton

import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect

/** Mounted once at the app root (PkwApp), so they run on every screen the update is driven from, the boot gate included,
 * and never twice. */
@Composable fun NativeUpdateEffects() {
    val repository = NativeUpdateRuntime.repository ?: return
    val state by repository.state.collectAsState()
    val context = LocalContext.current
    // Returning from the unknown-sources setting resumes the install when the grant was given.
    LifecycleResumeEffect(repository) { repository.onForeground(); onPauseOrDispose {} }
    // The installer's confirmation is shown as soon as Android asks for it; every update surface keeps a button to reopen it.
    val confirmation = (state as? UpdateState.AwaitingUserAction)?.prompt
    LaunchedEffect(confirmation) { confirmation?.launch(context) }
}

/** Title and Home mount: nothing is drawn unless this process holds an eligible offer. A required update is drawn by
 * [NativeUpdateScreen] over the whole screen instead; the resume and installer effects live in [NativeUpdateEffects]. */
@Composable fun NativeUpdateBanner(modifier: Modifier = Modifier) {
    val repository = NativeUpdateRuntime.repository ?: return
    val state by repository.state.collectAsState()
    val mandatory by repository.isMandatoryBlocking.collectAsState()
    val context = LocalContext.current
    val confirmation = (state as? UpdateState.AwaitingUserAction)?.prompt
    if (updatePresentation(state, mandatory) != UpdatePresentation.Banner) return
    UpdateBanner(state, modifier, onDownload = { repository.startDownload(it) }, onInstall = { repository.install() },
        onDecline = repository::decline, onCancel = repository::cancel,
        onOpenSettings = { (state as? UpdateState.AwaitingPermission)?.prompt?.launch(context) },
        onConfirm = { confirmation?.launch(context) })
}

internal fun megabytes(bytes: Long) = "${(bytes + 512 * 1024) / (1024 * 1024)} MB"

internal fun failureCopy(kind: UpdateFailureKind) = when (kind) {
    UpdateFailureKind.NETWORK -> "The download stopped. Try again when your connection is steady; it continues where it left off."
    UpdateFailureKind.STORAGE -> "There is not enough free space for the update, or it could not be saved."
    UpdateFailureKind.ORIGIN -> "The update server answered in an unexpected way, so nothing was installed."
    UpdateFailureKind.HASH -> "The downloaded file did not match the published update and was deleted."
    UpdateFailureKind.PACKAGE -> "The downloaded file is not this app and was deleted."
    UpdateFailureKind.SIGNER -> "The downloaded file is not signed by this app's publisher and was deleted."
    UpdateFailureKind.VERSION -> "The downloaded file is not the offered version and was deleted."
    UpdateFailureKind.PERMISSION -> "Android did not allow this app to install updates."
    UpdateFailureKind.INSTALL -> "Android did not install the update."
}

/**
 * The optional update on Title and Home (a required one is [NativeUpdateGate]): the designed herald line (hub SPEC §3.1,
 * source "update ready"; was the old dark Notice + "UPDATE" text button) and, on a tap, the designed optional gate (SPEC
 * §3.7 update.png, "A NEW VERSION IS READY", stone LATER + gold UPDATE; was the old dark AlertDialog). Every decision
 * stays with the update helpers: UPDATE runs [runGateUpdate] (the same forward action the dialog's first button ran);
 * LATER is the dialog's second button ([updateDialogActions]): NOT NOW declines an offer not yet started, LATER only
 * closes while the download or hand-off carries on. Back and LATER are the same.
 */
@Composable fun UpdateBanner(state: UpdateState, modifier: Modifier = Modifier, onDownload: (consentToMetered: Boolean) -> Unit, onInstall: () -> Unit,
                             onDecline: () -> Unit, onOpenSettings: () -> Unit, onCancel: () -> Unit = {}, onConfirm: () -> Unit = {}) {
    val offer = state.offer ?: return
    if (state is UpdateState.Declined || state is UpdateState.Installed) return
    var open by remember { mutableStateOf(false) }
    val line = updateHeraldLine(state, offer)
    HeraldPlate(modifier.padding(start = 8.dp, top = 4.dp, end = 8.dp)
        .semantics(mergeDescendants = true) { role = Role.Button; contentDescription = line; liveRegion = LiveRegionMode.Polite }
        .clickable(role = Role.Button, onClickLabel = "Update details") { open = true }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HubArt("info", 24.dp)
            PkwText(line, PkwTokens.Type.body, color = PkwTokens.Colors.gold.hi, maxLines = 2)
        }
    }
    if (!open) return
    val close = { open = false }
    val later = updateDialogActions(state, offer.mandatory).getOrNull(1)
    val putAway: () -> Unit = { close(); if (later == UpdateAction.NOT_NOW) onDecline() }
    Dialog(onDismissRequest = putAway, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        // The gate draws its own 70 % dim; the window adds none and spans the cut-out like the rest of the game.
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        DisposableEffect(window) {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            if (window != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            onDispose { }
        }
        GateCard(bannerUpdateGateUi(state), GateActions(
            onUpdate = {
                val calls = UpdateGateCalls(onDownload = onDownload, onInstall = onInstall, onCancel = onCancel, onConfirm = onConfirm,
                    onOpenSettings = onOpenSettings, onCheckAgain = { Toasts.post(GATE_STORE_ONLY) })
                if (!runGateUpdate(state, calls)) Toasts.post(GATE_BUSY)
            },
            onLater = putAway,
        ))
    }
}

/** The herald's one line: the offer's existing headline, or the dialog's own short progress sentence while bytes move. */
internal fun updateHeraldLine(state: UpdateState, offer: NativeUpdateOffer): String = when (state) {
    is UpdateState.Downloading, is UpdateState.Verifying, is UpdateState.Installing -> updateStateMessage(state, offer)
    else -> null
} ?: if (offer.mandatory) "Update ${offer.versionName} required · ${megabytes(offer.sizeBytes)}"
    else "Update ${offer.versionName} available · ${megabytes(offer.sizeBytes)}"

/** The optional gate for the banner's state: the dialog's own sentence (and the required note when the offer says so),
 *  the dApp Store line when UPDATE can only check again, and busy dots while the update moves on its own. Null without
 *  an offer. WHAT'S NEW stays hidden: the offer carries no release notes. */
internal fun bannerUpdateGateUi(state: UpdateState): GateUi? {
    val offer = state.offer ?: return null
    val tap = gateUpdateTap(state) ?: return null
    val body = listOfNotNull(MANDATORY_UPDATE_NOTE.takeIf { offer.mandatory }, updateStateMessage(state, offer),
        STORE_FALLBACK.takeIf { tap == GateUpdateTap.CheckAgain }).joinToString(" ")
    return GateUi(GateKind.UPDATE_OPTIONAL, if (offer.mandatory) "UPDATE TO KEEP PLAYING" else "A NEW VERSION IS READY", body,
        notes = emptyList(), sizeLine = gateSizeLine(state, offer), etaLine = null, nextCheckIn = null,
        updating = tap == GateUpdateTap.Busy)
}

/** Every button the update chrome can draw. The helpers below decide which exist, so the set is tested without Compose. */
enum class UpdateAction { DOWNLOAD, DOWNLOAD_ANYWAY, CANCEL, INSTALL, OPEN_INSTALLER, OPEN_SETTINGS, TRY_AGAIN, NOT_NOW, LATER, UPDATE_NOW }

/** The one forward action for [state]; null while the file is checked or handed to Android, and after a failure that
 * retrying cannot fix. Never a way to postpone: the required-update screen draws only this. No else branch. */
fun updateForwardAction(state: UpdateState): UpdateAction? = when (state) {
    is UpdateState.Offered, is UpdateState.WaitingForBattle -> UpdateAction.DOWNLOAD
    is UpdateState.NeedsMeteredConsent -> UpdateAction.DOWNLOAD_ANYWAY
    is UpdateState.Downloading -> UpdateAction.CANCEL
    is UpdateState.ReadyToInstall -> UpdateAction.INSTALL
    is UpdateState.AwaitingUserAction -> UpdateAction.OPEN_INSTALLER
    is UpdateState.AwaitingPermission -> UpdateAction.OPEN_SETTINGS
    is UpdateState.Failed -> if (state.retryable) UpdateAction.TRY_AGAIN else null
    UpdateState.Idle, is UpdateState.Verifying, is UpdateState.Installing, is UpdateState.Installed, is UpdateState.Declined -> null
}

/** The dialog's buttons, forward action first, then exactly one way to put the dialog away: NOT NOW declines an optional
 * offer; LATER only closes the dialog while the download or hand-off carries on. [mandatory] offers cannot be declined.
 * Empty for the states the banner does not draw. */
fun updateDialogActions(state: UpdateState, mandatory: Boolean): List<UpdateAction> = when (state) {
    UpdateState.Idle, is UpdateState.Declined, is UpdateState.Installed -> emptyList()
    else -> listOfNotNull(updateForwardAction(state), if (state is UpdateState.Offered && !mandatory) UpdateAction.NOT_NOW else UpdateAction.LATER)
}

/** The dialog and the required-update screen say the same thing: shared copy, never a second wording. */
internal const val MANDATORY_UPDATE_NOTE = "This update is required. Orders are paused until it installs; your kingdom and account stay available."
/** The boot gate's required update (owner 2026-09-27): this build does not open the game at all until it is replaced. */
internal const val BOOT_REQUIRED_NOTE = "This version can no longer open the game. Install the update to continue; your kingdom and progress are kept on the server."
/** Always true, and the way out when the in-app update itself cannot finish. */
internal const val STORE_FALLBACK = "You can also install the latest Pixel Kingdom Wars from the Solana dApp Store."
@Composable internal fun MandatoryUpdateNote(text: String = MANDATORY_UPDATE_NOTE) = Text(text, color = Palette.gold)

/** After PackageInstaller finishes, Android returns to the launcher; nothing relaunches the game, so never promise it. */
internal const val REOPEN_AFTER_INSTALL = "Once it finishes, open Pixel Kingdom Wars again; your progress is kept on the server."

/** The sentence [state] shows in the dialog and on the required-update screen; null where it shows none. */
internal fun updateStateMessage(state: UpdateState, offer: NativeUpdateOffer): String? = when (state) {
    is UpdateState.Offered -> "${megabytes(offer.sizeBytes)} download from this game's server. Android asks you to confirm the install. Your progress is kept on the server."
    is UpdateState.WaitingForBattle -> "Finish the battle or replay first, then download the update."
    is UpdateState.NeedsMeteredConsent -> "You are on a metered connection. The update is ${megabytes(offer.sizeBytes)}."
    is UpdateState.Downloading -> "Downloading ${megabytes(state.bytes)} of ${megabytes(state.total)}"
    is UpdateState.Verifying -> "Checking the downloaded file…"
    is UpdateState.ReadyToInstall -> "The update is verified. Android asks you to confirm the install. $REOPEN_AFTER_INSTALL"
    is UpdateState.AwaitingUserAction -> "Confirm the install in the Android dialog. $REOPEN_AFTER_INSTALL"
    is UpdateState.AwaitingPermission -> "Android needs your permission for this app to install its updates. Allow it in Settings, then come back here."
    is UpdateState.Installing -> "Handing the update to Android…"
    is UpdateState.Failed -> failureCopy(state.kind)
    else -> null
}

/** Progress, consent, permission and failure copy for [state]; its children join the caller's column. */
@Composable internal fun UpdateStateCopy(state: UpdateState, offer: NativeUpdateOffer) {
    updateStateMessage(state, offer)?.let { Text(it) }
    when (state) {
        is UpdateState.Downloading ->
            LinearProgressIndicator(progress = if (state.total > 0) (state.bytes.toFloat() / state.total).coerceIn(0f, 1f) else 0f, modifier = Modifier.fillMaxWidth())
        is UpdateState.Verifying, is UpdateState.Installing -> LinearProgressIndicator(Modifier.fillMaxWidth())
        is UpdateState.Failed ->
            if (state.kind == UpdateFailureKind.INSTALL) state.detail?.let { Text(it, color = Palette.muted, style = MaterialTheme.typography.labelSmall) }
        else -> Unit
    }
}

/** Draws one [UpdateAction]; [updateForwardAction] and [updateDialogActions] decide which exist. */
@Composable internal fun UpdateActionButton(action: UpdateAction, state: UpdateState, onDownload: (consentToMetered: Boolean) -> Unit,
                                            onInstall: () -> Unit, onCancel: () -> Unit, onConfirm: () -> Unit, onOpenSettings: () -> Unit,
                                            modifier: Modifier = Modifier, onDecline: () -> Unit = {}, onClose: () -> Unit = {},
                                            /** The boot strip's 16 sp; the dialog keeps the button font. */
                                            fontSize: TextUnit = TextUnit.Unspecified) {
    val narrow = LocalNarrowStrip.current
    val goldPadding = if (narrow) PaddingValues(horizontal = 8.dp, vertical = 6.dp)
        else PaddingValues(start = 18.dp, top = 8.dp, end = 18.dp, bottom = 12.dp)
    val lineHeight = if (narrow) STRIP_BUTTON_SP.sp else TextUnit.Unspecified
    when (action) {
        UpdateAction.DOWNLOAD -> Button(onClick = { onDownload(false) }, modifier, contentPadding = goldPadding) { Text("DOWNLOAD", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.DOWNLOAD_ANYWAY -> Button(onClick = { onDownload(true) }, modifier, contentPadding = goldPadding) { Text("DOWNLOAD ANYWAY", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.CANCEL -> TextButton(onClick = onCancel, modifier) { Text("CANCEL", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.INSTALL -> Button(onClick = onInstall, modifier, contentPadding = goldPadding) { Text("INSTALL", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.OPEN_INSTALLER -> Button(onClick = onConfirm, modifier, contentPadding = goldPadding) { Text("OPEN INSTALLER", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.OPEN_SETTINGS -> Button(onClick = onOpenSettings, modifier, contentPadding = goldPadding) { Text("OPEN SETTINGS", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.TRY_AGAIN -> Button(onClick = { if ((state as? UpdateState.Failed)?.kind == UpdateFailureKind.INSTALL) onInstall() else onDownload(false) }, modifier, contentPadding = goldPadding) { Text("TRY AGAIN", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.NOT_NOW -> TextButton(onClick = onDecline, modifier) { Text("NOT NOW", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.LATER -> TextButton(onClick = onClose, modifier) { Text("LATER", fontSize = fontSize, lineHeight = lineHeight) }
        UpdateAction.UPDATE_NOW -> Button(onClick = { onDownload(false) }, modifier, contentPadding = goldPadding) { Text("UPDATE NOW", fontSize = fontSize, lineHeight = lineHeight) }
    }
}

/** SHARDKEEP D-193 (4): the boot update strip's words and meter for [state]; the buttons stay with [bootCardActions],
 * [updateForwardAction] and [bootRetryOffered], so the gate's behaviour is untouched and only the presentation moved.
 * Title: an optional offer names its version and size ("Update 0.6.6 · 251 MB": the decision's "Update 0.6.6 available
 * · 251 MB" is 304 dp at the title's 22 sp, wider than a portrait phone's 272 dp column and than a desktop's column
 * beside two buttons, and a title that loses its size to an ellipsis is worse than one without "available"; review
 * 2026-09-28); a [required] one says "Update required". Line 2: the download's measured percent while bytes move
 * ("Downloading · N%"), else the dialog's own sentence for the state (with the installer's detail after an install
 * failure, and the dApp Store line once CHECK AGAIN is offered); a required offer not yet moving carries the boot note;
 * an optional one merely on offer keeps the tip. A line is a [LoadingStripContent.reason] unless it is progress or a
 * transient status (downloading, verifying, installing). Meter: [held] (the highest measured fraction so far in this
 * transfer, D-193 rule 3) while downloading, full once every byte is in (verifying, ready, waiting for Android's
 * confirmation or permission), the sweep while Android installs, still otherwise. */
fun updateStripContent(state: UpdateState, offer: NativeUpdateOffer, required: Boolean, retryOffered: Boolean, held: Float): LoadingStripContent {
    val title = if (required) "Update required" else "Update ${offer.versionName} · ${megabytes(offer.sizeBytes)}"
    val measured = state is UpdateState.Downloading && (state.total > 0 || held > 0f)
    val meter = when (state) {
        is UpdateState.Downloading -> if (measured) StripMeter.Measured(held) else StripMeter.Sweep
        is UpdateState.Verifying, is UpdateState.ReadyToInstall, is UpdateState.AwaitingUserAction, is UpdateState.AwaitingPermission -> StripMeter.Measured(1f)
        is UpdateState.Installing -> StripMeter.Sweep
        UpdateState.Idle, is UpdateState.Offered, is UpdateState.WaitingForBattle, is UpdateState.NeedsMeteredConsent,
        is UpdateState.Installed, is UpdateState.Declined, is UpdateState.Failed -> StripMeter.Still
    }
    val words = when {
        measured -> "Downloading · ${(held.coerceIn(0f, 1f) * 100).toInt()}%"
        state is UpdateState.Offered -> if (required) BOOT_REQUIRED_NOTE else null
        state is UpdateState.Failed && state.kind == UpdateFailureKind.INSTALL && state.detail != null -> "${failureCopy(state.kind)} ${state.detail}"
        else -> updateStateMessage(state, offer) ?: if (required) BOOT_REQUIRED_NOTE else null
    }
    val line = if (!retryOffered) words else if (words == null) STORE_FALLBACK else "$words $STORE_FALLBACK"
    val transient = state is UpdateState.Downloading || state is UpdateState.Verifying || state is UpdateState.Installing
    return LoadingStripContent(title, meter, line, reason = line != null && !transient)
}

/** The strip's held fraction across states (D-193 rule 3): raised while [state] downloads, kept while the file is
 * checked, handed to Android or waiting on it (every byte is in), and back to 0 once the transfer is over — a failure,
 * a cancel, the offer back on the table — so the next transfer starts at its own measured 0%, never at the old percent
 * (review 2026-09-28: a re-download after a HASH failure read "Downloading · 100%" throughout). No else branch. */
fun transferHeldFraction(held: Float, state: UpdateState): Float = when (state) {
    is UpdateState.Downloading -> heldFraction(held, state.bytes, state.total)
    is UpdateState.Verifying, is UpdateState.ReadyToInstall, is UpdateState.AwaitingUserAction, is UpdateState.AwaitingPermission, is UpdateState.Installing -> held
    UpdateState.Idle, is UpdateState.Offered, is UpdateState.WaitingForBattle, is UpdateState.NeedsMeteredConsent,
    is UpdateState.Installed, is UpdateState.Declined, is UpdateState.Failed -> 0f
}

/** The held fraction for [state], a high-water mark per offer kept outside the snapshot (no state written during
 * composition, no extra recomposition per progress event). */
@Composable internal fun rememberHeldFraction(state: UpdateState): Float {
    val holder = remember(state.offer) { FloatArray(1) }
    holder[0] = transferHeldFraction(holder[0], state)
    return holder[0]
}

/** The boot screen's optional-update strip (owner 2026-09-27; D-193 moved it from a card to the strip): UPDATE NOW
 * downloads (the gate's background start usually already has) and hands the verified file to Android; LATER opens the
 * game and the Title/Home banner keeps the offer. Without an offer (a frame between decisions) the loading strip stays. */
@Composable fun bootUpdateStrip(repository: UpdateRepository, onLater: () -> Unit): BootStrip {
    val state by repository.state.collectAsState()
    val requested by repository.installRequested.collectAsState()
    val offer = state.offer ?: return BootStrip(bootStripContent(null, false))
    val context = LocalContext.current
    val held = rememberHeldFraction(state)
    return BootStrip(updateStripContent(state, offer, required = false, retryOffered = false, held = held)) {
        for (action in bootCardActions(state, requested)) UpdateActionButton(action, state, onDownload = { repository.updateNow(it) },
            onInstall = { repository.updateNow() }, onCancel = repository::cancel,
            onConfirm = { (state as? UpdateState.AwaitingUserAction)?.prompt?.launch(context) },
            onOpenSettings = { (state as? UpdateState.AwaitingPermission)?.prompt?.launch(context) }, Modifier.stripButtonSize(), onClose = onLater,
            fontSize = STRIP_BUTTON_SP.sp)
    }
}
