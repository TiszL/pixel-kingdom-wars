package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.DevTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.NoteLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteCardPage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteConfirmDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteNoticeRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.FaucetRepository
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.land.LandNotice
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.launch
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

/** SOL FAUCET (D-098): the server's grant policy read back as a game page; every number here is server state.
 * The page title is the plain game name; DEVNET is a tag chip, not a shouted header (owner 2026-09-17).
 * Owner 2026-10-06 ("UI unfinished"): TEST SOL on the land gate and the Profile WALLET tab opens this page, so it is the
 * designed card ([RouteCardPage]) now, not the old dark page. The owner ([FaucetRepository]: a server grant, no wallet
 * signature, no payment), its checks and every sentence are unchanged; a status refresh keeps the last status drawn. */
@Composable fun FaucetScreen(repository: FaucetRepository, onBack: () -> Unit) {
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var review by remember { mutableStateOf(false) }
    BackHandlerAt(BackPriority.SCREEN, !review, onBack)
    BackHandlerAt(BackPriority.CONFIRM, review) { review = false }
    LaunchedEffect(repository, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { repository.foreground(false) } }
    val requestHold = when {
        !state.available -> "The faucet is available only on devnet."
        state.status == null -> "Refresh the status first."
        state.status?.eligible != true -> state.status?.reason?.replace('_', ' ')?.replaceFirstChar { it.uppercase() } ?: "Not eligible right now."
        else -> null
    }
    Box(Modifier.fillMaxSize()) {
        RouteCardPage("SOL FAUCET", "sol", onBack, footer = {
            StoneBusyButton("REFRESH", state.busy, { if (state.available) scope.launch { repository.refresh() } }, Modifier.width(120.dp))
            PrimaryButton("REQUEST DEVNET SOL", { if (requestHold == null && !repository.state.value.busy) review = true },
                Modifier.weight(1f), verb = Verb.GREEN,
                state = when { state.busy -> CommandState.BUSY; requestHold != null -> CommandState.DISABLED; else -> CommandState.ENABLED },
                reason = requestHold, reasonOnDark = true)
        }) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DevTag()
                PkwText("PLAYTEST FUNDS ONLY", PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
            }
            NoteLine("Playtest funds only. The game requests one grant automatically per session while you are in your base if the server says you are eligible. A manual request below uses the same server limits. No wallet signature or payment is required.", maxLines = 7)
            if (!state.available) LandNotice("The faucet is available only on devnet.")
            state.error?.let { RouteNoticeRow(it, error = true, onDismiss = repository::dismissError) }
            state.arrival?.let { RouteNoticeRow("Server confirmed ${it.lamports} lamports sent to your wallet.", onDismiss = repository::dismissArrival) }
            val status = state.status
            if (status == null) { if (state.available && state.error == null) SkeletonRow(height = 72.dp) }
            else {
                AccountCard(Modifier.fillMaxWidth(), rim = if (status.eligible) PkwTokens.Colors.green.face else null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Well("sol", size = 52.dp, light = true, iconSize = 32.dp)
                        PkwText("GRANT ${status.grantSol} SOL", PkwTokens.Type.label, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch)
                        StatusTag(if (status.eligible) "ELIGIBLE" else status.reason.replace('_', ' ').uppercase(),
                            if (status.eligible) Verb.GREEN else Verb.STONE, dots = state.busy)
                    }
                    FaucetStat("RECEIVED", "${status.grantedSol} / ${status.lifetimeCapSol} SOL LIFETIME")
                    FaucetStat("BELOW", "${status.minBalanceSol} SOL · COOLDOWN ${status.cooldownHours} H")
                    status.nextEligibleAt?.let { FaucetStat("NEXT ELIGIBLE", it) }
                }
                status.last?.let { grant ->
                    SectionHeader("LATEST WALLET GRANT", right = grant.status.uppercase())
                    AccountCard(Modifier.fillMaxWidth()) {
                        SelectionContainer { NoteLine("ID: ${grant.id}", maxLines = 2) }
                        NoteLine("${grant.lamports} lamports · requested ${grant.requestedAt}", maxLines = 2)
                        grant.sentAt?.let { NoteLine("Updated $it", maxLines = 2) }
                        grant.signature?.let { SelectionContainer { NoteLine("Transaction: $it", maxLines = 3) } }
                    }
                }
            }
            if (state.uncertain) NoteLine("The last request response was interrupted. Latest wallet grant details are server state; they do not prove which request created it. Status checks never submit another claim.", maxLines = 6)
            state.saved?.takeIf { it.id != state.status?.last?.id }?.let { NoteLine("Saved grant ${it.id}: ${it.status}. Its current result is absent from the latest wallet grant. It will not be marked sent from another grant or a balance change.", maxLines = 6) }
        }
        RouteConfirmDialog(if (review) RouteConfirmUi("REQUEST A DEVNET GRANT?",
            if (state.uncertain || state.saved != null) listOf("This starts a new request after rechecking eligibility.",
                "Your earlier response remains uncertain; the server enforces pending grants, cooldown and lifetime limits.")
            else listOf("The server will recheck eligibility and queue its displayed grant amount.", "Keep checking this screen for the grant's status."),
            "REQUEST", Verb.GREEN, "CANCEL", icon = "sol") else null,
            onConfirm = { if (!repository.state.value.busy) { review = false; scope.launch { repository.claim() } } },
            onBack = { review = false }, modifier = Modifier.fillMaxSize())
    }
}

@Composable private fun FaucetStat(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
        PkwText(value, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
    }
}

/** The player-menu faucet slot: a plate row like every other menu cell (owner 2026-09-17: the bare
 * "DEVNET SOL FAUCET" line looked unstyled), with the status as the value line. */
@Composable fun FaucetBanner(repository: FaucetRepository, onOpen: () -> Unit) {
    val state by repository.state.collectAsState()
    if (!state.available) return
    val value = when {
        state.arrival != null -> "SOL ARRIVED · VIEW GRANT"
        state.uncertain -> "RESPONSE INTERRUPTED · CHECK STATUS"
        state.status?.last?.status == "requested" -> "GRANT ON ITS WAY · VIEW STATUS"
        else -> "CHECK ELIGIBILITY · ONCE PER SESSION"
    }
    PixelPlate("shard", Modifier.fillMaxWidth().heightIn(min = 56.dp)
        .semantics { contentDescription = "SOL faucet · devnet · $value" }
        .clickable(role = Role.Button, onClick = onOpen), PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            GameArt("sol", Modifier.size(22.dp))
            Column(Modifier.weight(1f)) {
                Text("SOL FAUCET · DEVNET", style = MaterialTheme.typography.labelSmall, color = Palette.muted, maxLines = 1)
                Text(value, style = MaterialTheme.typography.bodyMedium, color = Palette.goldHi, maxLines = 2)
            }
        }
    }
}
