package gg.pixelkingdomwars.nativeclient.update

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.Gate
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubMotion
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.checkCountdown
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.gateDismissible
import kotlinx.coroutines.delay

/**
 * The designed update and maintenance gates (design/final/hub/update.png, maintenance.png; SPEC §3.7) over the update
 * channel and the API routing gates. Every decision stays with the existing update helpers ([updateForwardAction],
 * [bootRetryOffered], [updatePresentation] and the update strips' copy); this file only maps their answers onto
 * [GateCard]'s one UPDATE button, LATER (optional only) and CHECK AGAIN (maintenance only). Owner 2026-09-27 and K-210: a
 * required update is never a dead end, so UPDATE always moves the update forward, shows that it is moving, or checks
 * again with the dApp Store line beside it.
 */

/** What the gate's one UPDATE button does for a state. */
internal sealed interface GateUpdateTap {
    /** The update's own forward action ([updateForwardAction]): download, consent, install, the installer or Settings. */
    data class Forward(val action: UpdateAction) : GateUpdateTap
    /** Bytes are moving, the file is being checked, or Android is installing: UPDATE shows busy dots and takes no tap. */
    data object Busy : GateUpdateTap
    /** Nothing moves the update forward: UPDATE runs the host's CHECK AGAIN and the body says so. */
    data object CheckAgain : GateUpdateTap
}

/** UPDATE for [state]: busy while the update moves on its own (downloading, verifying, installing), else the forward
 * action, else CHECK AGAIN. [bootRetryOffered] is true for every state that reaches CHECK AGAIN, so the gate offers it
 * exactly where the boot strip offered its CHECK AGAIN button. Null only without an offer, where the boot screen keeps
 * loading and the Title/Home gate draws nothing. */
internal fun gateUpdateTap(state: UpdateState): GateUpdateTap? = when {
    state.offer == null -> null
    state is UpdateState.Downloading || state is UpdateState.Verifying || state is UpdateState.Installing -> GateUpdateTap.Busy
    else -> updateForwardAction(state)?.let { GateUpdateTap.Forward(it) } ?: GateUpdateTap.CheckAgain
}

/** The exact callbacks [UpdateActionButton] receives where the gate is mounted (the boot strips: `updateNow`; the
 * Title/Home screen: `startDownload` and `install`), plus the host's CHECK AGAIN. */
internal class UpdateGateCalls(
    val onDownload: (consentToMetered: Boolean) -> Unit,
    val onInstall: () -> Unit,
    val onCancel: () -> Unit,
    val onConfirm: () -> Unit,
    val onOpenSettings: () -> Unit,
    val onCheckAgain: () -> Unit,
)

/** Runs UPDATE for [state] exactly as [UpdateActionButton] runs the same action. False when UPDATE has nothing to run
 * (busy dots, no offer), so the caller can say why instead of doing nothing. */
internal fun runGateUpdate(state: UpdateState, calls: UpdateGateCalls): Boolean {
    when (val tap = gateUpdateTap(state)) {
        null, GateUpdateTap.Busy -> return false
        GateUpdateTap.CheckAgain -> calls.onCheckAgain()
        is GateUpdateTap.Forward -> when (tap.action) {
            UpdateAction.DOWNLOAD, UpdateAction.UPDATE_NOW -> calls.onDownload(false)
            UpdateAction.DOWNLOAD_ANYWAY -> calls.onDownload(true)
            UpdateAction.CANCEL -> calls.onCancel()
            UpdateAction.INSTALL -> calls.onInstall()
            UpdateAction.OPEN_INSTALLER -> calls.onConfirm()
            UpdateAction.OPEN_SETTINGS -> calls.onOpenSettings()
            UpdateAction.TRY_AGAIN -> if ((state as? UpdateState.Failed)?.kind == UpdateFailureKind.INSTALL) calls.onInstall() else calls.onDownload(false)
            // Ways to put a dialog away; updateForwardAction never returns them.
            UpdateAction.NOT_NOW, UpdateAction.LATER -> return false
        }
    }
    return true
}

/** The body's sentence while UPDATE checks again. */
internal const val GATE_CHECK_LINE = "UPDATE checks again."
/** UPDATE with nothing to run (a tap racing the busy dots). */
internal const val GATE_BUSY = "The update is still working. Please wait."
/** The Title/Home CHECK AGAIN where no check is wired: the dApp Store is the way on. */
internal const val GATE_STORE_ONLY = "This update can't finish in the app right now. Install the latest Pixel Kingdom Wars from the Solana dApp Store."

/** The boot gate's update (owner 2026-09-27: found on the loading screen, before the game opens). [required] draws the
 * gate that cannot be dismissed; otherwise LATER opens the game. [retryOffered] is [bootRetryOffered] for the launch (the
 * boot strip's rule), which adds the dApp Store line. Null without an offer: the boot screen keeps loading. */
internal fun updateGateUi(state: UpdateState, required: Boolean, retryOffered: Boolean): GateUi? =
    designedUpdateGateUi(state, required, retryOffered, requiredNote = BOOT_REQUIRED_NOTE, canCheckAgain = true)

/** Title and Home (owner 2026-09-25): a required update covers the screen with the dialog's own note
 * ([MANDATORY_UPDATE_NOTE]: orders paused, the kingdom stays available). [canCheckAgain] is false where the host wired no
 * check; the body then ends on the dApp Store line and UPDATE says the same. */
internal fun inGameUpdateGateUi(state: UpdateState, canCheckAgain: Boolean): GateUi? =
    designedUpdateGateUi(state, required = true, retryOffered = bootRetryOffered(state, failedThisLaunch = false),
        requiredNote = MANDATORY_UPDATE_NOTE, canCheckAgain = canCheckAgain)

private fun designedUpdateGateUi(state: UpdateState, required: Boolean, retryOffered: Boolean, requiredNote: String, canCheckAgain: Boolean): GateUi? {
    val offer = state.offer ?: return null
    val tap = gateUpdateTap(state) ?: return null
    // The boot strip's own words for the state (one wording, never a second one); a measured download reads its percent.
    val words = updateStripContent(state, offer, required, retryOffered = false, held = transferHeldFraction(0f, state)).line
        ?.replace(BOOT_REQUIRED_NOTE, requiredNote) ?: updateStateMessage(state, offer)
    val checking = tap == GateUpdateTap.CheckAgain
    val body = listOfNotNull(words, GATE_CHECK_LINE.takeIf { checking && canCheckAgain },
        STORE_FALLBACK.takeIf { retryOffered || checking }).joinToString(" ")
    return GateUi(
        kind = if (required) GateKind.UPDATE_REQUIRED else GateKind.UPDATE_OPTIONAL,
        title = if (required) "UPDATE TO KEEP PLAYING" else "A NEW VERSION IS READY",
        body = body,
        // NativeUpdateOffer carries no release notes: WHAT'S NEW stays hidden rather than invented.
        notes = emptyList(),
        sizeLine = gateSizeLine(state, offer), etaLine = null, nextCheckIn = null,
        updating = tap == GateUpdateTap.Busy,
    )
}

/** "0.6.6 · 251 MB" under UPDATE: the offer's version, and its size only when the server sent one. */
internal fun gateSizeLine(state: UpdateState, offer: NativeUpdateOffer): String {
    val bytes = (state as? UpdateState.Offered)?.sizeBytes ?: offer.sizeBytes
    return if (bytes > 0) "${offer.versionName} · ${megabytes(bytes)}" else offer.versionName
}

/** Drop-in for [NativeUpdateScreen] on Title and Home: the same repository and the same full-screen condition
 * ([updatePresentation] == FullScreen, a mandatory offer), drawn as the designed required gate with
 * NativeUpdateScreen's own callbacks. [onCheckAgain] is the host's fresh check (for example the boot gate's
 * `onServerMovedOn`); without one, CHECK AGAIN says the dApp Store is the way on. [NativeUpdateEffects] keeps the
 * installer and Settings resume effects, so none fires twice. */
@Composable fun NativeUpdateGate(onCheckAgain: (() -> Unit)? = null) {
    val repository = NativeUpdateRuntime.repository ?: return
    val state by repository.state.collectAsState()
    val mandatory by repository.isMandatoryBlocking.collectAsState()
    val context = LocalContext.current
    val latestCheck by rememberUpdatedState(onCheckAgain)
    val ui = if (updatePresentation(state, mandatory) == UpdatePresentation.FullScreen)
        inGameUpdateGateUi(state, canCheckAgain = onCheckAgain != null) else null
    // SPEC §3.7: the required gate cannot be dismissed, and Back never acts on the kingdom it covers.
    BackHandlerAt(BackPriority.CONFIRM, enabled = ui != null) {}
    GateCard(ui, GateActions(onUpdate = {
        val now = repository.state.value
        val calls = UpdateGateCalls(onDownload = { repository.startDownload(it) }, onInstall = { repository.install() },
            onCancel = repository::cancel,
            onConfirm = { (now as? UpdateState.AwaitingUserAction)?.prompt?.launch(context) },
            onOpenSettings = { (now as? UpdateState.AwaitingPermission)?.prompt?.launch(context) },
            onCheckAgain = { val hostCheck = latestCheck; if (hostCheck != null) hostCheck() else Toasts.post(GATE_STORE_ONLY) })
        if (!runGateUpdate(now, calls)) Toasts.post(GATE_BUSY)
    }))
}

// ---- API routing gates (PkwApp `Gate.Update` from a 426 or unreadable response, `Gate.Maintenance`) ----

internal const val MAINTENANCE_TITLE = "RAISING THE DRAWBRIDGE"
/** The maintenance body when the server sent no words; GateCard adds "Back soon." because no ETA arrives. */
internal const val MAINTENANCE_FALLBACK = "The realm is being upgraded."
internal const val SERVER_UPDATE_TITLE = "UPDATE TO KEEP PLAYING"
/** The 426 dialog's own words. */
internal const val ORDERS_LOCKED = "Game orders are locked until the app is updated."
internal const val ACCOUNT_KEPT = "Your account is preserved."
/** UPDATE on a 426 gate while this device holds no offer: why it cannot act, and the way on. */
internal const val NO_OFFER_YET = "No update is offered to this device yet. $STORE_FALLBACK"

/**
 * The designed card for an API routing gate; null for the gates it does not draw (Alpha, Funds, Info stay where they are).
 * - [Gate.Update] keeps its dialog's "Continue browsing" in both cases (LATER), as the dialog did with and without an
 *   offer: [hasOffer] makes UPDATE start it; without one UPDATE explains and LATER continues, so it is never a dead end.
 * - [Gate.Maintenance] carries the server's words; its event has no ETA, so [GateUi.etaLine] is null and the card says
 *   "Back soon". [nextCheckIn] is the auto-check countdown.
 */
internal fun serverGateUi(gate: Gate, hasOffer: Boolean, nextCheckIn: String?): GateUi? = when (gate) {
    is Gate.Update -> GateUi(GateKind.UPDATE_OPTIONAL, SERVER_UPDATE_TITLE,
        listOfNotNull(gateSentence(gate.message), if (hasOffer) "$ORDERS_LOCKED $ACCOUNT_KEPT" else NO_OFFER_YET).joinToString(" "),
        notes = emptyList(), sizeLine = null, etaLine = null, nextCheckIn = null)
    is Gate.Maintenance -> GateUi(GateKind.MAINTENANCE, MAINTENANCE_TITLE, gateSentence(gate.message) ?: MAINTENANCE_FALLBACK,
        notes = emptyList(), sizeLine = null, etaLine = null, nextCheckIn = nextCheckIn)
    Gate.Alpha, is Gate.Funds, is Gate.Info -> null
}

/** One second of the maintenance countdown: the next value, and whether the auto-check is due now (the count restarts). */
internal fun maintenanceTick(remaining: Int): Pair<Int, Boolean> =
    if (remaining <= 1) HubMotion.MAINTENANCE_CHECK_SECONDS to true else (remaining - 1) to false

private fun gateSentence(text: String): String? =
    text.trim().takeIf { it.isNotEmpty() }?.let { if (it.last() in ".!?…") it else "$it." }

/**
 * The designed gate for an API routing [gate] (replaces GateDialog's Update and Maintenance branches). [dialogUpdate] is
 * the boot gate's `dialogUpdate` for the current state (null without an offer); [onDismiss] clears the gate ("Continue
 * browsing"); [onCheck] clears it and reads one existing GET, so a maintenance that persists raises the gate again. The
 * maintenance card auto-checks every [HubMotion.MAINTENANCE_CHECK_SECONDS] while the app is resumed. Any other gate
 * draws nothing.
 */
@Composable fun ServerGateCard(gate: Gate, dialogUpdate: (() -> Unit)?, onDismiss: () -> Unit, onCheck: () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latestCheck by rememberUpdatedState(onCheck)
    var remaining by remember(gate) { mutableIntStateOf(HubMotion.MAINTENANCE_CHECK_SECONDS) }
    if (gate is Gate.Maintenance) LaunchedEffect(gate, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                delay(1_000)
                val (next, due) = maintenanceTick(remaining)
                remaining = next
                if (due) latestCheck()
            }
        }
    }
    val ui = serverGateUi(gate, hasOffer = dialogUpdate != null,
        nextCheckIn = if (gate is Gate.Maintenance) checkCountdown(remaining) else null) ?: return
    // A gate sits over everything (SPEC §3.7): Back never reaches the screen under it. Only the 426 gate is dismissible
    // (LATER, the dialog's "Continue browsing"); maintenance swallows Back as its dialog did.
    BackHandlerAt(BackPriority.CONFIRM) { if (gateDismissible(ui.kind)) onDismiss() }
    GateCard(ui, GateActions(
        onUpdate = { val update = dialogUpdate; if (update != null) update() else Toasts.post(NO_OFFER_YET) },
        onLater = onDismiss,
        onCheck = onCheck,
    ))
}
