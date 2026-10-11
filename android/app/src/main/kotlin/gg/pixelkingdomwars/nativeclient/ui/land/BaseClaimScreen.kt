package gg.pixelkingdomwars.nativeclient.ui.land

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.BaseClaimRepository
import gg.pixelkingdomwars.nativeclient.data.BaseClaimState
import gg.pixelkingdomwars.nativeclient.data.SavedBaseClaim
import gg.pixelkingdomwars.nativeclient.model.BaseClaimOffer
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.AccountCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.NoteLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteCardPage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteConfirmDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RouteNoticeRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkeletonRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait
import kotlinx.coroutines.launch

/** The claim page's lead (the previous screen's own words): what a claim is and that nothing is paid. */
internal const val BASE_CLAIM_INTRO = "Claim the base attached to a deed already in your wallet. No SOL payment is requested. The seller's balances stay with the seller."

/** Why no deed can be claimed, by the server's `reason` (`null` = the claim service did not answer, a 404). */
internal fun baseClaimReasonLine(reason: String?): String = when (reason) {
    "none" -> "No unclaimed deed was found."
    "not_transferable" -> "This deed cannot be transferred."
    else -> "Deed claims are unavailable. Check again later."
}

/**
 * The offer the page draws: the live one, except while a status check is running, when the last answered offer stays on
 * screen (a routine check never blanks what the player was reading; `BaseClaimRepository.offer()` clears its own copy at
 * the start of every read). Null while nothing was answered yet.
 */
internal fun baseClaimShownOffer(state: BaseClaimState, lastAnswered: BaseClaimOffer?): BaseClaimOffer? =
    if (state.busy) state.offer ?: lastAnswered else state.offer

/** A long identifier as "1a2b3c…9f0e" for a confirm line; the full value stays selectable on the card behind it. */
internal fun shortClaimId(id: String): String = if (id.length > 12) "${id.take(6)}…${id.takeLast(4)}" else id

/**
 * CLAIM A DEED: a friend's deed already in this wallet becomes one of the player's bases. Owner 2026-10-06 (screenshot 2):
 * the old dark "CLAIM TRANSFERRED DEED" page is replaced by the designed card ([RouteCardPage]), the same family as
 * Profile > KINGDOMS ("A DEED FROM A FRIEND?" > CLAIM opens this page). The owner is unchanged: [BaseClaimRepository] is
 * auth-only transfer recovery (no SOL payment, no signing); its review / confirm / retry / cancel / finish run exactly as
 * before, and every consequence sentence is the previous screen's own.
 *
 * States: first read → skeleton row (never the "unavailable" line before the server answered); offer → the deed card +
 * green REVIEW DEED CLAIM; none → the server's reason + CHECK AGAIN; a saved request → its proof, its outcome and the step
 * that resolves it (RETRY / CANCEL, or FINISH REVIEW once the account is refreshed); failure → the blood row with RETRY.
 */
@Composable fun BaseClaimScreen(repository: BaseClaimRepository, onBack: () -> Unit, onBases: () -> Unit) {
    val state by repository.state.collectAsState(); val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var cancel by remember { mutableStateOf(false) }; var retry by remember { mutableStateOf(false) }
    var lastAnswered by remember(repository) { mutableStateOf<BaseClaimOffer?>(null) }
    LaunchedEffect(repository, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { repository.refresh() } }
    DisposableEffect(repository, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) { repository.dismiss(); cancel = false; retry = false }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); repository.dismiss() }
    }
    // Remember the last answered offer (a settled read) so the next check keeps drawing it.
    LaunchedEffect(state.busy, state.offer, state.loaded) { if (!state.busy && state.loaded) lastAnswered = state.offer }
    BackHandlerAt(BackPriority.CONFIRM, state.review != null || cancel || retry) { repository.dismiss(); cancel = false; retry = false }
    BackHandlerAt(BackPriority.SCREEN, state.review == null && !cancel && !retry) { onBack() }
    val check: () -> Unit = { if (!repository.state.value.busy) scope.launch { repository.refresh() } }
    val saved = state.saved
    val offer = baseClaimShownOffer(state, lastAnswered)
    val candidate = offer?.candidate
    val finishReady = saved != null && (saved.cancelled || saved.receipt != null && state.hydrated)
    Box(Modifier.fillMaxSize()) {
        RouteCardPage("CLAIM A DEED", "itm_deed_earth", onBack, footer = {
            SecondaryButton("YOUR BASES", onBases, Modifier.width(132.dp), enabled = !state.busy)
            when {
                finishReady -> PrimaryButton("FINISH REVIEW", { if (!repository.state.value.busy) scope.launch { repository.finish() } },
                    Modifier.weight(1f), verb = Verb.GREEN, state = if (state.busy) CommandState.BUSY else CommandState.ENABLED)
                saved == null && candidate != null && offer?.enabled == true -> PrimaryButton("REVIEW DEED CLAIM",
                    { if (!repository.state.value.busy) scope.launch { repository.review() } },
                    Modifier.weight(1f), verb = Verb.GREEN, state = if (state.busy) CommandState.BUSY else CommandState.ENABLED)
                else -> StoneBusyButton("CHECK AGAIN", state.busy, check, Modifier.weight(1f))
            }
        }) {
            CardRow(height = 72.dp) {
                Well("itm_deed_earth", size = 52.dp, light = true, iconSize = 32.dp)
                RowText("A deed sent to you", "Its base joins your kingdoms")
            }
            NoteLine(BASE_CLAIM_INTRO, maxLines = 5)
            state.error?.let { RouteNoticeRow(it, error = true, retrying = state.busy, onRetry = check) }
            if (saved != null) SavedClaim(saved, state, onRetry = { retry = true }, onCancel = { cancel = true })
            else when {
                candidate != null -> {
                    SectionHeader("DEED IN YOUR WALLET")
                    AccountCard(Modifier.fillMaxWidth(), rim = PkwTokens.Colors.gold.face) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Well(keepPortrait(1), size = 64.dp, iconSize = 56.dp)
                            Column(Modifier.weight(1f)) {
                                PkwText("A KINGDOM TO CLAIM", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                                PkwText("Its base becomes yours", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                            }
                            if (state.busy) StatusTag("CHECKING", Verb.STONE, dots = true)
                        }
                        SelectionContainer { Column {
                            NoteLine("Base: ${candidate.baseId}", maxLines = 2)
                            NoteLine("Deed: ${candidate.deedAssetId}", maxLines = 2)
                        } }
                    }
                }
                // An answered "no deed" stays drawn through the next check; an unanswered page waits for the server.
                offer != null || state.loaded && !state.busy && state.error == null ->
                    CardRow(variant = RowVariant.DIM, height = 72.dp) {
                        Well("itm_deed_earth", size = 52.dp, light = true, iconSize = 32.dp, alpha = .5f)
                        PkwText(baseClaimReasonLine(offer?.reason), PkwTokens.Type.body, Modifier.weight(1f),
                            color = PkwTokens.Colors.textOnParch, maxLines = 3)
                    }
                state.error == null || state.busy -> SkeletonRow(height = 72.dp)
            }
        }
        val confirm = when {
            state.review != null -> state.review?.let { review -> RouteConfirmUi("CLAIM THIS EXACT DEED?",
                listOf("Your existing free base and pending land payments are unchanged.",
                    "Base ${shortClaimId(review.request.baseId)} · Deed ${shortClaimId(review.request.deedAssetId)}"),
                "CLAIM DEED", Verb.GREEN, "CANCEL", icon = "itm_deed_earth") }
            cancel -> RouteConfirmUi("CANCEL UNACCEPTED CLAIM?", listOf("The server will seal this request only if it was never accepted.",
                "An accepted transfer returns its original receipt."), "CONFIRM", Verb.RED)
            retry -> RouteConfirmUi("RETRY ORIGINAL CLAIM?", listOf("Send the same saved request for the same base and deed after checking its status.",
                "No payment is involved."), "CONFIRM", Verb.GREEN)
            else -> null
        }
        RouteConfirmDialog(confirm, onConfirm = {
            val review = repository.state.value.review
            when {
                repository.state.value.busy -> Unit
                review != null -> scope.launch { repository.confirm(review) }
                cancel || retry -> { val closing = cancel; cancel = false; retry = false; scope.launch { if (closing) repository.cancel() else repository.retry() } }
            }
        }, onBack = { repository.dismiss(); cancel = false; retry = false }, modifier = Modifier.fillMaxSize())
    }
}

/** The saved request's proof (selectable), its outcome in the previous screen's words, and the step that resolves it. */
@Composable private fun SavedClaim(saved: SavedBaseClaim, state: BaseClaimState, onRetry: () -> Unit, onCancel: () -> Unit) {
    val receipt = saved.receipt
    SectionHeader("YOUR SAVED CLAIM")
    AccountCard(Modifier.fillMaxWidth(), rim = if (receipt != null) PkwTokens.Colors.green.face else PkwTokens.Colors.gold.face) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well("itm_deed_earth", size = 52.dp, light = true, iconSize = 32.dp)
            PkwText(when {
                saved.cancelled -> "Request cancelled"
                receipt == null -> "Being checked"
                receipt.outcome == "claimed" -> "Transfer accepted"
                else -> "Already yours"
            }, PkwTokens.Type.label, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
            when {
                state.busy -> StatusTag("CHECKING", Verb.STONE, dots = true)
                saved.cancelled -> StatusTag("CLOSED", Verb.STONE)
                receipt != null -> StatusTag("ACCEPTED", Verb.GREEN)
            }
        }
        SelectionContainer { Column {
            NoteLine("Original base: ${saved.request.baseId}", maxLines = 2)
            NoteLine("Original deed: ${saved.request.deedAssetId}", maxLines = 2)
            NoteLine("Request: ${saved.request.idempotencyKey}", maxLines = 2)
            receipt?.transferId?.let { NoteLine("Original transfer: $it", maxLines = 2) }
        } }
    }
    when {
        saved.cancelled -> NoteLine("The server cancelled this unaccepted request. This key cannot claim a deed later.", maxLines = 3)
        receipt != null -> {
            NoteLine(if (receipt.outcome == "claimed") "Transfer accepted" else "This base was already yours at acceptance", maxLines = 2)
            NoteLine(if (receipt.active) "The base was active when accepted." else "The base was inactive when accepted.", maxLines = 2)
            NoteLine("Today's ownership, active slot and selected base come from Your bases.", maxLines = 3)
            if (!state.hydrated) NoteLine("Receipt saved. Check status to refresh account and deed ownership before finishing.", maxLines = 3)
        }
        else -> {
            NoteLine("This request is unresolved. An empty status does not prove it failed. Its original deed remains fixed.", maxLines = 4)
            SecondaryButton("RETRY ORIGINAL CLAIM", onRetry, Modifier.fillMaxWidth(), enabled = !state.busy)
            SecondaryButton("CANCEL IF UNACCEPTED", onCancel, Modifier.fillMaxWidth(), verb = Verb.RED, enabled = !state.busy)
        }
    }
}
