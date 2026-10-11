package gg.pixelkingdomwars.nativeclient.ui.profile


import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.ui.title.liveAdmissionTitleUi
import gg.pixelkingdomwars.nativeclient.ui.title.admissionLinkAvailable
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.TitleScreen as DesignedTitleScreen
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.TitleActions
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.wallet.SeekerProofWallet
import kotlinx.coroutines.*

@Composable fun AdmissionSeekerScreen(repository: AdmissionSeekerRepository, wallet: SeekerProofWallet?, gameWallet: String,
    bounds: SeekerBounds?, onSignOut: () -> Unit, onExit: () -> Unit) {
    val state by repository.state.collectAsState(); val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var domain by rememberSaveable(gameWallet) { mutableStateOf("") }
    var job by remember(repository) { mutableStateOf<Job?>(null) }
    fun action(block: suspend () -> Unit) { if (job?.isActive != true) job = scope.launch { block() } }
    BackHandlerAt(BackPriority.SCREEN) { job?.cancel(); onExit() }
    DisposableEffect(repository, lifecycle) {
        repository.interaction.setForeground(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        val observer = LifecycleEventObserver { _, event ->
            repository.interaction.onLifecycleEvent(event)
            if (event == Lifecycle.Event.ON_STOP) { Unit }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); repository.interaction.close(); job?.cancel() }
    }
    LaunchedEffect(repository, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { repository.refresh() } }
    Box(Modifier.fillMaxSize()) {
        DesignedTitleScreen(liveAdmissionTitleUi(state, "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"),
            TitleActions(
                onAdmissionRecheck = { action { repository.refresh() } },
                onUseAnotherWallet = { job?.cancel(); onSignOut() },
            ),
            header = { gg.pixelkingdomwars.nativeclient.update.NativeUpdateBanner() },
            extras = {
                PkwText("Signed in with your game wallet", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                SelectionContainer { PkwText(gameWallet, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3) }
                if (state.pending != null) state.notice?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 6) }
                if (state.status?.linked != true) {
                    PkwText("Own a Seeker on another wallet? Connect its Genesis Token wallet below. It signs only a purpose-scoped message with no payment or fee. Your game and payment wallet remain unchanged.",
                        PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 8)
                    // Owner 2026-10-06 ("UI unfinished"): the old outlined field is the designed parchment field (same rule, same words).
                    gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteFieldLabel("OPTIONAL .SKR DOMAIN")
                    gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteTextInput(domain, { if (it.length <= SeekerIdentityStatus.DOMAIN_MAX) domain = it },
                        "Optional .skr domain", enabled = !state.busy)
                    PkwText("Blank allows server discovery. Naming is cosmetic.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                    SecondaryButton("VERIFY SEEKER WALLET", {
                        if (admissionLinkAvailable(repository.state.value, wallet != null, bounds != null)) {
                            val name = domain; action { repository.link(requireNotNull(wallet), name) }
                        }
                    }, Modifier.fillMaxWidth(), enabled = admissionLinkAvailable(state, wallet != null, bounds != null))
                    if (bounds == null) PkwText("Update game content before linking a Seeker wallet.", PkwTokens.Type.small, color = PkwTokens.Colors.shortText, maxLines = 3)
                    if (wallet == null) PkwText("Seeker wallet verification is unavailable in this mode.", PkwTokens.Type.small, color = PkwTokens.Colors.shortText, maxLines = 3)
                } else PkwText("A Seeker link exists. Access is still decided by the server. Contact support@pixelkingdomwars.com if you need help.",
                    PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 5)
                SecondaryButton("BACK", { job?.cancel(); onExit() }, Modifier.fillMaxWidth())
            })
        gg.pixelkingdomwars.nativeclient.update.NativeUpdateScreen()
    }
}
