package gg.pixelkingdomwars.nativeclient.ui.title

import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import gg.pixelkingdomwars.nativeclient.data.SeekerState
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.*
import gg.pixelkingdomwars.nativeclient.wallet.SocialProvider

/** Presentation admission only; the existing view model and repositories own every sign-in attempt. */
internal fun titleEntryAllowed(account: AccountState, working: Boolean): Boolean =
    account.phase == AccountPhase.SIGNED_OUT && !account.busy && !working

internal fun titleProvider(id: String): SocialProvider? = when (id) {
    "google" -> SocialProvider.GOOGLE
    "x" -> SocialProvider.X
    "email" -> SocialProvider.EMAIL
    else -> null
}

internal fun liveTitleUi(
    account: AccountState, social: SocialUiState, working: Boolean, walletAvailable: Boolean,
    socialConfigured: Boolean, version: String, error: String? = null, walletConnecting: Boolean = false,
): TitleUi {
    val idle = titleEntryAllowed(account, working)
    val providers = if (walletAvailable && socialConfigured) listOf(
        SignInProviderUi("google", "Continue with Google", "G", social.inFlight == SocialProvider.GOOGLE, idle),
        SignInProviderUi("x", "Continue with X", "X", social.inFlight == SocialProvider.X, idle),
        SignInProviderUi("email", "Continue with email", "@", social.inFlight == SocialProvider.EMAIL, idle),
    ) else emptyList()
    return TitleUi(
        version, walletAvailable, lastWalletLabel = null, socialProviders = providers,
        busy = when {
            idle -> null
            walletConnecting && social.inFlight == null -> TitleBusy.WALLET_CHECK
            else -> TitleBusy.SOCIAL
        },
        error = error ?: account.error, leaving = account.phase == AccountPhase.SIGNED_IN,
        showAnotherWallet = walletAvailable && account.phase == AccountPhase.SIGNED_OUT,
        walletUnavailable = if (!walletAvailable) "Wallet sign-in is unavailable in this mode." else null,
        socialUnavailable = when {
            !walletAvailable -> "Sign-in is unavailable in this mode."
            !socialConfigured -> "Google, X and email sign-in are not configured in this build."
            else -> null
        },
    )
}

internal fun titleTotpReady(account: AccountState, working: Boolean, code: String): Boolean =
    account.phase == AccountPhase.TOTP && !account.busy && !working && code.length == 6 && code.all { it in '0'..'9' }

/** SEND CODE reaches the e-mail owner only for an address with an '@' while nothing is running (the old field's rule). */
internal fun titleEmailReady(email: String, idle: Boolean): Boolean = idle && email.contains('@')

/** CONFIRM reaches the e-mail owner only with six ASCII digits while nothing is running (the 2-step card's rule). */
internal fun titleEmailCodeReady(code: String, idle: Boolean): Boolean =
    idle && code.length == TOTP_CELLS && code.all { it in '0'..'9' }

/**
 * The settings square's sheet: this device's sound preferences (rows hidden when the title has none), the account doors
 * only while signed out and idle (they say why they wait otherwise), and the claim door only when the host offers one.
 */
internal fun titleSettingsUi(device: DeviceSettings?, idle: Boolean, claimDeed: Boolean, network: String = Copy.NETWORK): TitleSettingsUi =
    TitleSettingsUi(music = device?.music, soundFx = device?.soundFx, accountIdle = idle, claimDeed = claimDeed, network = network)

internal fun liveAdmissionTitleUi(state: SeekerState, version: String): TitleUi = TitleUi(
    version, walletAdapterAvailable = false, lastWalletLabel = null, socialProviders = emptyList(),
    stage = TitleStage.ADMISSION, error = state.error,
    admission = AdmissionUi(
        if (state.pending != null) "An interrupted link is saved. Check access; the signed request will not be repeated."
        else state.notice ?: "The server checks this wallet for existing access or a Seeker Genesis Token. Gameplay has not opened yet.",
        state.busy,
    ),
    settingsAvailable = false, legalAvailable = false, reportAvailable = false,
)

internal fun admissionLinkAvailable(state: SeekerState, walletAvailable: Boolean, boundsAvailable: Boolean): Boolean =
    state.loaded && !state.busy && state.pending == null && state.status?.linked == false && walletAvailable && boundsAvailable
