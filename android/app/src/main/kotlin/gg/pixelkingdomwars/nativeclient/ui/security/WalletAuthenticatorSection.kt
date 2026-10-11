package gg.pixelkingdomwars.nativeclient.ui.security

import androidx.compose.ui.Alignment
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteFieldLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteTextInput
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ToggleSwitch

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.WalletAuthenticatorRepository
import kotlinx.coroutines.launch

/** Parent SecurityScreen owns FLAG_SECURE. Sensitive state never uses SavedState/rememberSaveable. */
@Composable fun WalletAuthenticatorSection(repository: WalletAuthenticatorRepository) {
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope(); val owner = LocalLifecycleOwner.current; val uri = LocalUriHandler.current
    var acknowledge by remember { mutableStateOf(false) }
    var code by remember(state.setup) { mutableStateOf("") }
    DisposableEffect(repository, owner) {
        val active = owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        repository.setForeground(active)
        if (active) scope.launch { repository.refresh() }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) { repository.setForeground(true); scope.launch { repository.refresh() } }
            if (event == Lifecycle.Event.ON_STOP) { repository.setForeground(false); code = ""; acknowledge = false }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); repository.setForeground(false); code = ""; acknowledge = false }
    }
    if (state.embedded == false) return
    // Owner 2026-10-06 ("UI unfinished"): drawn as the designed section (header, cream card, kit doors, the masked field)
    // inside ACCOUNT SECURITY. The repository, the acknowledgement guard and every sentence are unchanged.
    SectionHeader("PRIVY WALLET AUTHENTICATOR")
    AccountCard(Modifier.fillMaxWidth(), contentPadding = 10.dp) { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SecurityLine("This is separate from your Pixel Kingdom Wars login authenticator. If it is lost, neither Privy nor Pixel Kingdom Wars can reset it. Signing, key export and new-device recovery need it. Keep its setup key somewhere safe.")
        state.message?.let { SecurityLine(it) }
        if (state.busy) StatusTag("CHECKING", Verb.STONE, dots = true)
        when (state.enrolled) {
            true -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusTag("ON", Verb.GREEN); SecurityLine("Wallet authenticator enabled")
            }
            null -> SecurityButton("Refresh wallet security", !state.busy, "A security request is finishing. Please wait.") { scope.launch { repository.refresh() } }
            false -> {
                val setup = state.setup
                if (setup == null) {
                    // The acknowledgement in full (it is the consent to a key that cannot be reset), with the kit switch.
                    CardRow(height = 60.dp, onClick = { if (!state.busy) acknowledge = !acknowledge },
                        description = "I understand this wallet authenticator cannot be reset. ${if (acknowledge) "on" else "off"}", enabled = !state.busy) {
                        PkwText("I understand this wallet authenticator cannot be reset.", PkwTokens.Type.body, Modifier.weight(1f),
                            color = PkwTokens.Colors.textOnParch, maxLines = 3)
                        ToggleSwitch(acknowledge, !state.busy)
                    }
                    SecurityButton("Set up wallet authenticator", acknowledge && !state.busy,
                        if (state.busy) "A security request is finishing. Please wait." else "Confirm that you understand it cannot be reset first.", Verb.GREEN) {
                        scope.launch { repository.start(acknowledge) } }
                } else {
                    SecurityLine("Add this setup key to your authenticator using time-based, 6-digit codes. Save the key securely before verifying.")
                    SelectionContainer { PkwText(setup.secret, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = 3) }
                    RouteFieldLabel("PRIVY AUTHENTICATOR CODE")
                    RouteTextInput(code, { code = it }, "Privy authenticator code", enabled = !state.busy, secret = true)
                    SecurityButton("Verify wallet authenticator", !state.busy && code.matches(Regex("[0-9]{6}")),
                        if (state.busy) "A security request is finishing. Please wait." else "Enter the six-digit code first.", Verb.GREEN) {
                        val entered = code; code = ""; scope.launch { repository.verify(setup, entered) } }
                    QuietButton("Discard setup", { if (!state.busy) { code = ""; repository.dismissSetup() } }, onParchment = true)
                }
            }
        }
        SecurityLine("Private-key export is available in the web game's Account Security. Sign in there with this same game wallet; the key stays inside Privy's export screen.")
        SecurityButton("Open web game for key export", !state.busy, "A security request is finishing. Please wait.", Verb.BLUE) {
            runCatching { uri.openUri("https://play.pixelkingdomwars.com") } }
        QuietButton("Contact support", { runCatching { uri.openUri("mailto:support@pixelkingdomwars.com") } }, onParchment = true)
    } }
}
