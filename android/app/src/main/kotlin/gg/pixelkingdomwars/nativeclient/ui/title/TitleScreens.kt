package gg.pixelkingdomwars.nativeclient.ui.title

import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt

import android.content.Intent
import androidx.core.net.toUri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.update.NativeUpdateRuntime
import gg.pixelkingdomwars.nativeclient.update.UpdatePresentation
import gg.pixelkingdomwars.nativeclient.update.updatePresentation
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.TitleScreen as DesignedTitleScreen
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.*
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountRepository
import gg.pixelkingdomwars.nativeclient.data.DevicePreferences
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.wallet.PrivyMfaRequest
import gg.pixelkingdomwars.nativeclient.wallet.SocialLogin
import gg.pixelkingdomwars.nativeclient.wallet.SocialLoginMarker
import gg.pixelkingdomwars.nativeclient.wallet.SocialLoginMethod
import gg.pixelkingdomwars.nativeclient.wallet.SocialProvider
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class EmailStep { NONE, ADDRESS, CODE }

/** Title-screen social sign-in state: the email steps, which provider is mid-flight, whether the SDK's
 * browser round trip is open right now ([browser]: the only time the browser notice is true; a reused
 * Privy session signs in-process) and the Privy wallet-authenticator prompt the SDK raised for that attempt. */
data class SocialUiState(val emailStep: EmailStep = EmailStep.NONE, val email: String = "", val inFlight: SocialProvider? = null, val browser: Boolean = false, val mfa: PrivyMfaRequest? = null)

/** Wallet-first entry (plan decision 3): MWA sign-in against the unchanged challenge contract, plus the
 * social options the web offers through Privy (apps/web/src/ui/connectOptions.ts socialGroup) signing the
 * same challenge with the account's existing Privy embedded wallet. */
class TitleViewModel(
    private val accounts: AccountRepository,
    val socialConfigured: Boolean,
    private val socialLogin: () -> SocialLogin?,
    marker: SocialLoginMarker?,
    private val release: suspend (WalletLogin?, String?) -> Unit,
) : ScreenViewModel() {
    constructor(graph: AppGraph) : this(graph.account, graph.privy != null, graph::social, graph.socialMarker, graph::releaseLocalCredentials) {
        preferences = graph.preferences
    }

    /** This device's sound preferences for the title's settings sheet (the same store Settings writes); null in tests. */
    var preferences: DevicePreferences? = null
        private set

    val account = accounts.state
    private val _social = MutableStateFlow(SocialUiState())
    val social: StateFlow<SocialUiState> = _social.asStateFlow()

    init {
        // A process death or destroyed screen during the browser round trip leaves the marker behind; say so once
        // (web: apps/web/src/auth/socialLoginIntent.ts, consumed by useSocialAuth.ts after the redirect).
        // Not through [run]: the marker read must never occupy the action slot and swallow the first tap.
        if (marker != null) viewModelScope.launch {
            try { marker.consume()?.let { notify(Copy.socialInterrupted(it), error = true) } }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { notify(error.message ?: "Saved sign-in state could not be read.", error = true) }
        }
    }

    fun connect(wallet: WalletLogin) = run { accounts.connect(wallet) }
    /** Forgets the paired MWA wallet (saved token and cached wallet endpoint) so the next connect goes through the
     * Android chooser; nothing about the server account or the Privy options changes. */
    fun useAnotherWallet(forgetWallet: () -> Unit) = run { forgetWallet(); notify(Copy.WALLET_FORGOTTEN) }
    fun restore() = run { accounts.restore() }
    fun verifyTotp(code: String) = run { accounts.verifyTotp(code) }
    /** Leaves a pending login: the server login cookie and both device credentials of the pending wallet are released. */
    fun cancelSignIn(wallet: WalletLogin?) { val pending = account.value.pendingWallet; run { accounts.logout { release(wallet, pending) } } }

    fun continueWith(provider: SocialProvider) {
        when (provider) {
            SocialProvider.GOOGLE -> signInSocial(SocialLoginMethod.Google)
            SocialProvider.X -> signInSocial(SocialLoginMethod.X)
            SocialProvider.EMAIL -> if (!active) _social.update { it.copy(emailStep = EmailStep.ADDRESS) }
        }
    }
    fun sendEmailCode(email: String) = run {
        requireSocial().sendEmailCode(email)
        _social.update { it.copy(emailStep = EmailStep.CODE, email = email.trim()) }
    }
    fun verifyEmailCode(code: String) = signInSocial(SocialLoginMethod.Email(_social.value.email, code))
    fun changeEmail() { if (!active) _social.update { it.copy(emailStep = EmailStep.ADDRESS) } }
    fun cancelEmail() { if (!active) _social.update { it.copy(emailStep = EmailStep.NONE, email = "") } }

    /** The wallet authenticator prompt belongs to the running sign-in, so it cannot go through [run]. */
    fun submitPrivyMfa(code: String) {
        val request = _social.value.mfa ?: return
        viewModelScope.launch {
            try { requireSocial().submitMfaCode(request, code) }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { notify(error.message ?: "The wallet authenticator code was not accepted.", error = true) }
        }
    }
    /** Ends the running sign-in: the SDK resumes the blocked signature with a cancellation, so nothing reaches the server. */
    fun cancelPrivyMfa() { if (_social.value.mfa != null) { socialLogin()?.cancelMfa(); notify(Copy.PRIVY_MFA_CANCELLED, error = true) } }

    private fun signInSocial(method: SocialLoginMethod) {
        run {
            val login = requireSocial()
            _social.update { it.copy(inFlight = method.provider) }
            try {
                coroutineScope {
                    val prompt = launch { login.mfa.collect { request -> _social.update { it.copy(mfa = request) } } }
                    val browser = launch { login.handOff.collect { provider -> _social.update { it.copy(browser = provider != null) } } }
                    try { accounts.connectWith { token, guard -> login.signIn(method, token, guard) } } finally { prompt.cancel(); browser.cancel() }
                }
                // The repository reports sign-in failures in its own state; the email step stays open for a retry.
                if (account.value.phase != AccountPhase.SIGNED_OUT) _social.value = SocialUiState()
            } finally { _social.update { it.copy(inFlight = null, browser = false, mfa = null) } }
        }
    }
    private fun requireSocial(): SocialLogin = socialLogin() ?: throw IllegalStateException("Social sign-in is not configured in this build.")
}

@Composable fun Brand(local: Boolean) {
    Column {
        Text(Copy.APP_NAME, fontSize = 19.sp, fontWeight = FontWeight.Black, color = Palette.gold)
        Text(Copy.NETWORK, style = MaterialTheme.typography.labelSmall, color = Palette.muted)
        if (local) Text(Copy.LOCAL_SERVER, style = MaterialTheme.typography.labelSmall, color = Palette.gold)
    }
}

/** Provider and MFA windows must yield to the existing required-update surface. */
@Composable private fun titleUpdateBlocked(): Boolean {
    val repository = NativeUpdateRuntime.repository ?: return false
    val state by repository.state.collectAsState()
    val mandatory by repository.isMandatoryBlocking.collectAsState()
    return updatePresentation(state, mandatory) == UpdatePresentation.FullScreen
}

private fun titleUpdateBlocksActions(): Boolean = NativeUpdateRuntime.repository?.let {
    updatePresentation(it.state.value, it.isMandatoryBlocking.value) == UpdatePresentation.FullScreen
} ?: false

/** The existing login owners feed the designed pre-Home card; no login or wallet work lives in the sheet. */
@Composable fun TitleScreen(model: TitleViewModel, wallet: WalletLogin?, origin: String, local: Boolean, onAbout: () -> Unit, onClaimDeed: (() -> Unit)? = null) {
    val account by model.account.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val social by model.social.collectAsState()
    val device = model.preferences?.state?.collectAsState()?.value
    val context = LocalContext.current
    val updateBlocked = titleUpdateBlocked()
    val idle = titleEntryAllowed(account, busy)
    var entryOptions by remember { mutableStateOf(false) }
    var providers by remember { mutableStateOf(false) }
    var walletConnecting by remember { mutableStateOf(false) }
    LaunchedEffect(busy, account.busy) { if (!busy && !account.busy) walletConnecting = false }
    val ui = liveTitleUi(account, social, busy, wallet != null, model.socialConfigured,
        "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", notice?.message, walletConnecting)
    fun current() = !titleUpdateBlocksActions() && titleEntryAllowed(model.account.value, model.busy.value)
    Box(Modifier.fillMaxSize()) {
        DesignedTitleScreen(ui, TitleActions(
            onConnectWallet = { if (current()) wallet?.let { walletConnecting = true; model.connect(it) } },
            onUseAnotherWallet = { if (current()) wallet?.let { model.useAnotherWallet(it::forgetWallet) } },
            onPlayFree = { if (current() && wallet != null && model.socialConfigured) providers = true },
            onSettings = { entryOptions = true }, onTerms = { if (current()) onAbout() }, onPrivacy = { if (current()) onAbout() },
            onReport = { entryOptions = true },
        ), header = {
            gg.pixelkingdomwars.nativeclient.update.NativeUpdateBanner()
            if (social.browser) PkwText(Copy.SOCIAL_BROWSER_WAIT, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 4)
            if (local) PkwText(Copy.LOCAL_SERVER, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }, extras = {
            if (notice != null) QuietButton("DISMISS", model::dismissNotice, onParchment = true)
        })
        // The existing required-update owner still covers sign-in; optional updates stay inside the card.
        gg.pixelkingdomwars.nativeclient.update.NativeUpdateScreen()
    }
    // The settings square's designed half sheet replaces the old ACCOUNT & SUPPORT dialog: same doors, same guards.
    if (entryOptions && !updateBlocked) TitleSettings(titleSettingsUi(device, idle, onClaimDeed != null), TitleSettingsActions(
        onMusic = { on -> model.preferences?.music = on },
        onSoundFx = { on -> model.preferences?.soundFx = on },
        onRestore = { if (current()) { entryOptions = false; walletConnecting = false; model.restore() } },
        onClaimDeed = { val claim = onClaimDeed; if (claim != null && current()) { entryOptions = false; claim() } },
        onAbout = { if (current()) { entryOptions = false; onAbout() } },
        onPlayWeb = { context.startActivity(Intent(Intent.ACTION_VIEW, "$origin/?client=solana-mobile".toUri())) },
        onClose = { entryOptions = false },
    ))
    if (!updateBlocked) SocialOptions(model, social, idle, notice?.message ?: account.error, ui.socialProviders, providers) { providers = false }
    if (!updateBlocked) social.mfa?.let { request -> PrivyMfaDialog(request, onSubmit = model::submitPrivyMfa, onCancel = model::cancelPrivyMfa) }
}

/** Hosts the designed settings sheet as the title's half sheet (bottom, no scrim; a tap outside or Back closes it). */
@Composable private fun TitleSettings(ui: TitleSettingsUi, on: TitleSettingsActions) {
    val maxHeight = (LocalConfiguration.current.screenHeightDp * .85f).dp
    Popup(alignment = Alignment.BottomCenter, onDismissRequest = on.onClose, properties = PopupProperties(focusable = true)) {
        TitleSettingsSheet(ui, on, Modifier.fillMaxWidth().heightIn(max = maxHeight).verticalScroll(rememberScrollState()))
    }
}

/** Web social launcher with native provider choices in the same order. Expanding this panel is
 * presentation only; provider authorization and email address → code recovery remain unchanged. The e-mail steps are
 * the designed [EmailSignInStep] (kit field, then the 2-step card's six cells and green CONFIRM). While the game wallet
 * asks for its own code the sheet steps aside for [PrivyMfaDialog]. */
@Composable private fun SocialOptions(
    model: TitleViewModel, social: SocialUiState, idle: Boolean, error: String?,
    providers: List<SignInProviderUi>, expanded: Boolean, onClose: () -> Unit,
) {
    if (!expanded && social.emailStep == EmailStep.NONE) return
    if (social.mfa != null) return
    fun close() { if (titleEntryAllowed(model.account.value, model.busy.value)) { onClose(); model.cancelEmail() } }
    fun current() = titleEntryAllowed(model.account.value, model.busy.value)
    val maxHeight = (LocalConfiguration.current.screenHeightDp * .85f).dp
    Popup(alignment = Alignment.BottomCenter, onDismissRequest = ::close, properties = PopupProperties(focusable = true)) {
        SignInProvidersSheet(providers, SignInProvidersActions(
            onProvider = { id ->
                if (!titleUpdateBlocksActions() && titleEntryAllowed(model.account.value, model.busy.value)) titleProvider(id)?.let(model::continueWith)
            },
            onClose = ::close,
        ), Modifier.fillMaxWidth().heightIn(max = maxHeight).imePadding().verticalScroll(rememberScrollState()), extras = {
            error?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.shortText, maxLines = 6) }
            if (social.browser) NoteLine(Copy.SOCIAL_BROWSER_WAIT, maxLines = 4)
            when (social.emailStep) {
            EmailStep.NONE -> {}
            EmailStep.ADDRESS -> {
                var email by remember { mutableStateOf(social.email) }
                EmailSignInStep(EmailSignInUi(EmailSignInStage.ADDRESS, email, ready = titleEmailReady(email, idle), busy = !idle),
                    EmailSignInActions(onEmail = { email = it },
                        onSend = { if (titleEmailReady(email, current())) model.sendEmailCode(email) },
                        onCancel = { if (current()) model.cancelEmail() }))
            }
            EmailStep.CODE -> {
                var code by remember(social.email) { mutableStateOf("") }
                EmailSignInStep(EmailSignInUi(EmailSignInStage.CODE, social.email, code, ready = titleEmailCodeReady(code, idle), busy = !idle),
                    EmailSignInActions(onCode = { code = totpDraft(it) },
                        onConfirm = { if (titleEmailCodeReady(code, current())) { model.verifyEmailCode(code); code = "" } },
                        onChangeEmail = { if (current()) model.changeEmail() },
                        onCancel = { if (current()) model.cancelEmail() }))
            }
        }
        })
    }
}

/** Privy MFA guards the embedded wallet's signature; it is not the game's login code (docs/PRIVY_ANDROID.md). Drawn as
 * the designed [WalletCodeSheet] with the existing security copy; dismissing it cancels, exactly as the old dialog did. */
@Composable private fun PrivyMfaDialog(request: PrivyMfaRequest, onSubmit: (String) -> Unit, onCancel: () -> Unit) {
    val totp = "totp" in request.methods
    var code by remember(request) { mutableStateOf("") }
    Popup(alignment = Alignment.BottomCenter, onDismissRequest = onCancel, properties = PopupProperties(focusable = true)) {
        WalletCodeSheet(WalletCodeUi(Copy.PRIVY_MFA_TITLE, if (totp) Copy.PRIVY_MFA_DETAIL else Copy.PRIVY_MFA_UNSUPPORTED, totp, code,
            Copy.PRIVY_MFA_FIELD, Copy.PRIVY_MFA_SUBMIT, Copy.PRIVY_MFA_CANCEL),
            onCode = { code = totpDraft(it) },
            onConfirm = { if (totp && code.length == TOTP_CELLS) { onSubmit(code); code = "" } },
            onCancel = onCancel,
            modifier = Modifier.fillMaxWidth().imePadding())
    }
}

@Composable fun TotpScreen(model: TitleViewModel, wallet: WalletLogin?, onRecovery: () -> Unit) {
    val account by model.account.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    var code by remember(account.pendingWallet) { mutableStateOf("") }
    fun current() = model.account.value.phase == AccountPhase.TOTP && !model.account.value.busy && !model.busy.value
    val ui = TitleUi("${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", false, null, emptyList(),
        stage = TitleStage.TOTP, totp = TotpUi(code, notice?.message ?: account.error, busy || account.busy),
        settingsAvailable = false, legalAvailable = false, reportAvailable = false)
    Box(Modifier.fillMaxSize()) {
        DesignedTitleScreen(ui, TitleActions(
            onTotpCode = { if (current()) code = totpDraft(it) },
            onTotpConfirm = { if (titleTotpReady(model.account.value, model.busy.value, code)) { model.verifyTotp(code); code = "" } },
            onTotpBack = { if (current()) model.cancelSignIn(wallet) },
        ), header = { gg.pixelkingdomwars.nativeclient.update.NativeUpdateBanner() }, extras = {
            SecondaryButton("RECOVER 2-STEP CODE", { if (current()) { code = ""; onRecovery() } }, Modifier.fillMaxWidth(), enabled = !busy && !account.busy)
            PkwText("Lost your authenticator or need replacement setup?", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
        })
        gg.pixelkingdomwars.nativeclient.update.NativeUpdateScreen()
    }
}
