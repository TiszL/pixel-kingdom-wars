package gg.pixelkingdomwars.nativeclient.ui.profile

import androidx.compose.ui.Alignment
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.NoteLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteCardPage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteConfirmDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteFieldLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteNoticeRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteTextInput
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.wallet.SeekerProofWallet
import kotlinx.coroutines.*

@Composable fun SeekerScreen(repository: SeekerRepository, wallet: SeekerProofWallet?, gameWallet: String,
    bounds: SeekerBounds?, onBack: () -> Unit) {
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope(); val lifecycle = LocalLifecycleOwner.current.lifecycle
    val uri = LocalUriHandler.current
    var domain by rememberSaveable(gameWallet) { mutableStateOf("") }
    var confirmUnlink by remember(repository) { mutableStateOf(false) }
    var job by remember(repository) { mutableStateOf<Job?>(null) }
    fun action(block: suspend () -> Unit) { if (job?.isActive != true) job = scope.launch { block() } }
    fun back() { job?.cancel(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, confirmUnlink) { confirmUnlink = false }
    DisposableEffect(repository, lifecycle) {
        repository.interaction.setForeground(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        val observer = LifecycleEventObserver { _, event ->
            repository.interaction.onLifecycleEvent(event)
            if (event == Lifecycle.Event.ON_STOP) { confirmUnlink = false }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); repository.interaction.close(); job?.cancel() }
    }
    LaunchedEffect(repository, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { repository.refresh() } }
    val enabled = state.loaded && !state.busy && state.pending == null
    val status = state.status
    // Owner 2026-10-06 ("UI unfinished"): the old dark SEEKER page is the designed card ([RouteCardPage]) in the Profile
    // grammar (the lime SEEKER #n tag of hub.png / profile-kingdoms.png). [SeekerRepository] owns the link, the wallet's
    // link-message signature and the unlink exactly as before; every sentence is the previous page's own.
    Box(Modifier.fillMaxSize()) {
        RouteCardPage("SEEKER", "skr", ::back, footer = {
            StoneBusyButton("RE-CHECK", state.busy, { action { repository.refresh(true) } }, Modifier.width(132.dp))
            when {
                status?.linked == true -> SecondaryButton("UNLINK SEEKER", { if (enabled) confirmUnlink = true }, Modifier.weight(1f),
                    verb = Verb.RED, enabled = enabled)
                status != null -> PrimaryButton("CONNECT & VERIFY", {
                    val name = domain
                    if (enabled && wallet != null && bounds != null) action { repository.link(requireNotNull(wallet), name) }
                }, Modifier.weight(1f), verb = Verb.GREEN,
                    state = when { state.busy -> CommandState.BUSY; enabled && wallet != null && bounds != null -> CommandState.ENABLED; else -> CommandState.DISABLED },
                    reason = when {
                        bounds == null -> "Update game content before linking a Seeker wallet."
                        wallet == null -> "A wallet app is needed to approve this link."
                        state.pending != null -> "Check current server status first."
                        else -> null
                    }, reasonOnDark = true)
                else -> Spacer(Modifier.weight(1f))
            }
        }) {
            SectionHeader("YOUR GAME WALLET")
            SelectionContainer { NoteLine(gameWallet, maxLines = 2) }
            state.error?.let { RouteNoticeRow(it, error = true, retrying = state.busy, onRetry = { action { repository.refresh(true) } }) }
            state.notice?.let { RouteNoticeRow(it) }
            state.pending?.let { RouteNoticeRow("A $it request was interrupted or is awaiting refresh. Check current server status before another action.") }
            if (status?.linked == true) {
                AccountCard(Modifier.fillMaxWidth(), rim = if (status.verified) PkwTokens.Colors.green.face else PkwTokens.Colors.gold.face) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Well("skr", size = 52.dp, light = true, iconSize = 32.dp)
                        PkwText(if (status.verified) "Verified Seeker" else "Seeker link retained · verification stale", PkwTokens.Type.label,
                            Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
                        if (status.verified) StatusTag("SEEKER${status.memberNumber?.let { " #$it" } ?: ""}", Verb.GREEN, lime = true)
                        else if (state.busy) StatusTag("CHECKING", Verb.STONE, dots = true)
                    }
                    SelectionContainer { Column {
                        NoteLine("Seeker wallet: ${status.seekerWallet}", maxLines = 2)
                        NoteLine("Genesis token: ${status.sgtMint}", maxLines = 2)
                        NoteLine("Verified at: ${status.verifiedAt}", maxLines = 2)
                        status.skrDomain?.let { NoteLine("Domain: $it", maxLines = 2) }
                    } }
                }
                NoteLine("Mainnet verification sources: ${status.verificationSources}")
                if (status.unconfirmed) NoteLine("The server reports that this result is not corroborated by multiple sources.")
                if (status.stale) NoteLine("The server cannot currently confirm the badge. The existing link is retained.")
                bounds?.let { NoteLine("The server reuses fresh checks for up to ${it.recheckHours} hours.") }
                QuietButton("View Genesis token on mainnet", { runCatching { uri.openUri("https://explorer.solana.com/address/${status.sgtMint}") } }, onParchment = true)
                if (status.skrDomain == null) {
                    SectionHeader(".SKR DOMAIN")
                    NoteLine("Find a server-verified .skr domain for this wallet. It is cosmetic and may supply a username when eligible; it never changes the game wallet.", maxLines = 4)
                    SecondaryButton("FIND MY .SKR", { action { repository.adoptDomain() } }, Modifier.fillMaxWidth(), verb = Verb.BLUE, enabled = enabled)
                }
            } else if (status != null) {
                SectionHeader("LINK YOUR SEEKER")
                CardRow(height = 72.dp) {
                    Well("skr", size = 52.dp, light = true, iconSize = 32.dp)
                    PkwText("Own a Solana Mobile Seeker on another wallet?", PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 3)
                }
                NoteLine("Connect the wallet holding your Genesis Token. It signs only a link message, with no transaction, spending permission or fee. Your game and payment wallet stay the same.", maxLines = 5)
                RouteFieldLabel("OPTIONAL .SKR DOMAIN")
                RouteTextInput(domain, { if (it.length <= SeekerIdentityStatus.DOMAIN_MAX) domain = it }, "Optional .skr domain", enabled = enabled)
                NoteLine("Leave blank for server discovery. A domain alone grants no badge.")
            } else if (state.error == null) SkeletonRow(height = 72.dp)
        }
        RouteConfirmDialog(if (confirmUnlink) RouteConfirmUi("UNLINK SEEKER?",
            listOf("This removes the badge. The Genesis Token remains bound to this game account and can only be relinked here.",
                "Your username and game wallet are kept. Automatic detection may find a token held by your game wallet again later."),
            "UNLINK", Verb.RED, "KEEP LINK", icon = "skr") else null,
            onConfirm = { confirmUnlink = false; action { repository.unlink() } }, onBack = { confirmUnlink = false }, modifier = Modifier.fillMaxSize())
    }
}
