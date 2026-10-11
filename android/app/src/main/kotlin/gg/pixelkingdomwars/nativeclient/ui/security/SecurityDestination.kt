package gg.pixelkingdomwars.nativeclient.ui.security

import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.SecurityRepository
import gg.pixelkingdomwars.nativeclient.data.SecurityWalletConfirmation
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteFieldLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteTextInput
import gg.pixelkingdomwars.nativeclient.wallet.PrivyMfaRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable fun SecurityDestination(repository: SecurityRepository, confirmations: SecurityWalletConfirmation,
                                    loginRecovery: Boolean, walletAuthenticator: gg.pixelkingdomwars.nativeclient.data.WalletAuthenticatorRepository, onBack: () -> Unit) {
    SecurityScreen(repository, loginRecovery, onBack) { WalletAuthenticatorSection(walletAuthenticator) }
    val request by confirmations.mfa.collectAsState()
    request?.let { pending -> SensitiveMfaDialog(pending, confirmations) }
}

@Composable internal fun SensitiveMfaDialog(request: PrivyMfaRequest, confirmations: SecurityWalletConfirmation) {
    SensitiveMfaDialog(request, submit = { code -> confirmations.submitMfa(request, code) }, cancelRequest = { confirmations.cancelMfa(request) })
}

/**
 * The wallet's Privy authenticator step. Owner 2026-10-06 ("UI unfinished"): the old dark square dialog is the designed
 * centred WoodFrame (hub SPEC §3.3 ConfirmDialog grammar) with the masked six-digit field, stone CANCEL and green VERIFY
 * WALLET. It still opens its own dialog window (it rises over money hosts that are not full-screen boxes), dismiss is
 * cancel, the code clears on stop, and the submit / cancel owners and every sentence are unchanged.
 */
@Composable internal fun SensitiveMfaDialog(request: PrivyMfaRequest, submit: suspend (String) -> Unit, cancelRequest: () -> Unit) {
    val scope = rememberCoroutineScope()
    val owner = LocalLifecycleOwner.current
    var code by remember(request) { mutableStateOf("") }
    var error by remember(request) { mutableStateOf<String?>(null) }
    var sending by remember(request) { mutableStateOf(false) }
    DisposableEffect(owner, request) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) code = "" }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); code = "" }
    }
    val cancel: () -> Unit = { runCatching { cancelRequest() }; Unit }
    val supported = "totp" in request.methods
    val ready = !sending && code.matches(Regex("[0-9]{6}"))
    val verify: () -> Unit = {
        if (supported && !sending && code.matches(Regex("[0-9]{6}"))) {
            val value = code; code = ""; sending = true; error = null
            scope.launch {
                try { submit(value) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { error = "Wallet verification failed or was rejected. Try a current code." }
                finally { sending = false }
            }
        } else if (supported && !sending) error = "Enter the six-digit code first."
    }
    // The same window as the old dialog: full display bounds, cutout included, so the centred card never slides off-screen.
    Dialog(cancel, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as DialogWindowProvider).window
        DisposableEffect(window) {
            val previous = window.attributes.layoutInDisplayCutoutMode
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            onDispose { window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = previous } }
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            // Sibling scrim (a tap outside is CANCEL), never a clickable ancestor of the code field or VERIFY.
            ModalScrim(PkwTokens.Scrim.SEAL, onTap = cancel)
            // The wood plate is a scene-input region: it takes the taps on the card, the scrim takes the rest.
            Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding().padding(horizontal = 24.dp, vertical = 16.dp),
                contentAlignment = Alignment.Center) {
                Plate(PlateKind.WOOD, Modifier.widthIn(max = 364.dp).fillMaxWidth()) {
                    Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                        Column(Modifier.fillMaxWidth().padding(8.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            PkwText("PRIVY WALLET AUTHENTICATOR", PkwTokens.Type.title, Modifier.fillMaxWidth().semantics { heading() },
                                color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                            SecurityLine(if (request.fresh) "Recovery needs a new verification of your Privy wallet authenticator before wallet confirmation. Enter its current code."
                                else "Your wallet requires its Privy authenticator code to confirm this action. This is separate from your PKW login authenticator.")
                            error?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.shortText, maxLines = 4) }
                            if (supported) {
                                RouteFieldLabel("PRIVY AUTHENTICATOR CODE")
                                RouteTextInput(code, { code = it }, "Privy authenticator code", enabled = !sending, secret = true)
                            } else SecurityLine("This wallet's verification method is not supported here. Complete the action in the web game.")
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                SecondaryButton("CANCEL", cancel, if (supported) Modifier.width(110.dp) else Modifier.fillMaxWidth())
                                // Its own window hides the app toasts, so a not-ready tap explains itself in the card ([verify]).
                                if (supported) ChunkyBox(PkwTokens.ramp(if (ready) Verb.GREEN else Verb.OFF), verify, "Verify wallet",
                                    Modifier.weight(1f).heightIn(min = PkwTokens.Dims.secondaryH)) {
                                    PkwText("VERIFY WALLET", PkwTokens.Type.label, color = PkwTokens.Colors.label, outline = 1.dp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
