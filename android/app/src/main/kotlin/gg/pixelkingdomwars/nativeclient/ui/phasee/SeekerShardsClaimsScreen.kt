package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.seeker.*
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.Job

fun seekerShardsEntryAvailable(state: SeekerShardsClaimsState?, storageUnavailable: Boolean = false) = storageUnavailable || state?.let {
    it.view?.claimsEnabled == true || it.view?.rows?.isNotEmpty() == true || it.view?.nextCursor != null || it.view?.status == "unavailable" || it.journal.operation != null || it.journal.archives.isNotEmpty()
} == true
fun seekerShardsCanReview(state: SeekerShardsClaimsState, selectedBase: String?, actionsAllowed: Boolean) =
    !state.busy && actionsAllowed && selectedBase != null && state.view?.claimsEnabled == true && state.view.status == "available" && state.journal.operation == null
fun seekerShardsAmount(value: String): String {
    require(value.matches(Regex("0|[1-9][0-9]{0,18}")) && value.toLongOrNull() != null)
    return value.reversed().chunked(3).joinToString(",").reversed()
}
fun seekerShardsPill(op: SeekerShardsClaimOperation) = when {
    op.receipt != null -> PaymentPill("CLAIMED", PaymentTone.DONE)
    op.attemptRevision != null -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    else -> PaymentPill("REVIEW", PaymentTone.OPEN)
}
class SeekerShardsClaimsViewModel(private val binding: SeekerShardsClaimsBinding) : ScreenViewModel() {
    private val repository = binding.repository
    val state = repository.state; private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit) = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh(cursor: String? = null) = action { repository.awaitIdle(); repository.refresh(cursor) }
    fun review(row: SeekerShardsEntitlement) = action { repository.reviewClaim(row) }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: SeekerShardsReview) = action { repository.confirm(review) }
    fun check() = action { repository.check() }
    fun checkArchive(key: String) = action { repository.checkArchive(key) }
    fun finish() = action { repository.finish() }
    fun abandon() = action { repository.abandonDraft() }
    fun archiveUnknown(expected: SeekerShardsClaimJournal) = action { repository.archiveUnknown(expected) }
    fun dismiss() = repository.dismiss()
    suspend fun close() = binding.close()
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun SeekerShardsClaimsScreen(model: SeekerShardsClaimsViewModel, selectedBase: String?, allowed: Boolean, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val busy = running || state.busy; val operation = state.journal.operation; val view = state.view
    var showHistory by rememberSaveable(state.journal.identity) { mutableStateOf(false) }
    val noticeLocation = remember { BringIntoViewRequester() }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    val back = { model.dismiss(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }; BackHandlerAt(BackPriority.CONFIRM, state.review != null) { model.dismiss() }
    DesignedPage("SEEKER SHARDS", back) {
        PaymentPlate("YOUR ISLAND SHARES", art = "shards", footnote = "Shares from your winning spots stay yours across earlier terms.") {
            Text("Bring your SHARDS share into a kingdom you own.", color = SurfaceInk.text)
            if (!allowed || view?.claimsEnabled == false) Text("New claims are paused. Your shares and receipts remain available.", color = SurfaceInk.goldHi)
            if (selectedBase == null) Text("Select a kingdom to review a claim.", style = MaterialTheme.typography.bodySmall)
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }) {
            notice?.let { Text(it.message, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
        }
        if (view == null || view.status == "unavailable") Text("Share history is unavailable. Your amounts are preserved.")
        view?.rows?.forEach { row ->
            PaymentPlate("SPOT ${row.spotId + 1}", art = "shards",
                details = listOf(PaymentDetail("Term", row.termId), PaymentDetail("Term begins (UTC)", row.startsAt), PaymentDetail("Term ends (UTC)", row.endsAt)),
                actions = listOf(PaymentAction("review", "REVIEW CLAIM", PaymentActionRole.PRIMARY, !running && row.dueQuantity != "0" && seekerShardsCanReview(state, selectedBase, allowed))),
                onAction = { model.review(row) }) {
                Text("${seekerShardsAmount(row.dueQuantity)} SHARDS available", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
                Text("Term: ${islandShareTime(row.startsAt)} – ${islandShareTime(row.endsAt)}", color = SurfaceInk.muted)
                Text("Already claimed: ${seekerShardsAmount(row.claimedTotal)}", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            }
        }
        if (view?.status == "available" && view.rows.isEmpty()) Text(if (view.nextCursor == null) "No SHARDS shares on this page." else "More share history is available on the next page.")
        view?.nextCursor?.let { cursor -> OutlinedButton(onClick = { model.refresh(cursor) }, enabled = !busy) { Text("NEXT HISTORY PAGE") } }
        operation?.let { saved ->
            val details = listOf(PaymentDetail("Request", saved.command.key), PaymentDetail("Original destination", saved.command.request.baseId), PaymentDetail("Term", saved.command.request.termId)) +
                listOfNotNull(saved.receipt?.let { PaymentDetail("Ledger receipt", it.ledgerTransactionId) }, saved.receipt?.let { PaymentDetail("Claimed at (UTC)", it.claimedAt) })
            PaymentPlate("SAVED CLAIM", art = "shards", pill = seekerShardsPill(saved),
                details = details, detailActions = listOf(PaymentAction("check", "CHECK RECEIPT", PaymentActionRole.SECONDARY, !busy)), onAction = { model.check() }) {
                Text("Spot ${saved.command.request.spotId + 1}", color = SurfaceInk.muted)
                saved.receipt?.let {
                    Text("${seekerShardsAmount(it.quantity)} SHARDS delivered", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
                    Text("${islandShareTime(it.claimedAt)} · original kingdom receipt", color = SurfaceInk.muted)
                }
                when {
                    saved.receipt != null -> Button(onClick = { model.finish() }, enabled = !busy) { Text("REFRESH KINGDOM & SAVE RECEIPT") }
                    saved.attemptRevision == null -> {
                        Button(onClick = { model.reviewSaved() }, enabled = !busy && allowed && saved.command.request.baseId == selectedBase) { Text("REVIEW SAVED CLAIM") }
                        TextButton(onClick = { model.abandon() }, enabled = !busy) { Text("CANCEL UNSUBMITTED REVIEW") }
                    }
                    else -> {
                        Text("Checking the original claim. It will not be submitted again.", color = SurfaceInk.goldHi)
                        Text("If the server has no record of it, CLOSE checks once more and moves it to history so you can claim again.", color = SurfaceInk.muted)
                        OutlinedButton(onClick = { model.archiveUnknown(state.journal) }, enabled = !busy) { Text("CLOSE SAVED CLAIM") }
                    }
                }
            }
        }
        state.hydration?.let { Text(if (it == SeekerShardsHydration.ORIGINAL_BASE_UNAVAILABLE) "The original kingdom is no longer available. Its receipt is kept." else "Kingdom balance refreshed from the server.") }
        DisclosurePlate("CLAIM HISTORY (${state.journal.archives.size})", showHistory, { showHistory = !showHistory }) {
            if (state.journal.archives.isEmpty()) Text("Saved claims and cancelled reviews will appear here.", color = SurfaceInk.muted)
            state.journal.archives.asReversed().forEach { archive ->
                val saved = archive.operation
                PaymentPlate(if (saved.receipt != null) "SHARDS CLAIMED" else if (archive.reason == "server-unknown") "CLOSED · NO SERVER RECORD" else "REVIEW CANCELLED", art = "shards",
                    details = listOfNotNull(PaymentDetail("Request", saved.command.key), PaymentDetail("Original destination", saved.command.request.baseId),
                        PaymentDetail("Term", saved.command.request.termId), saved.receipt?.let { PaymentDetail("Claimed at (UTC)", it.claimedAt) }),
                    detailActions = listOf(PaymentAction("check", "CHECK HISTORICAL RECEIPT", PaymentActionRole.SECONDARY, !busy)), onAction = { model.checkArchive(saved.command.key) }) {
                    Text("Spot ${saved.command.request.spotId + 1}", color = SurfaceInk.muted)
                    saved.receipt?.let { Text("${seekerShardsAmount(it.quantity)} SHARDS · ${islandShareTime(it.claimedAt)}", Modifier.fillMaxWidth(), color = SurfaceInk.goldHi) }
                }
            }
        }
        OutlinedButton(onClick = { model.refresh() }, enabled = !busy) { Text("REFRESH ALL HISTORY") }
    }
    state.review?.let { review -> AlertDialog(onDismissRequest = model::dismiss, title = { Text("CLAIM YOUR SHARDS SHARE") }, text = {
        PaymentPlate("Spot ${review.row.spotId + 1}", art = "shards", details = listOf(PaymentDetail("Term", review.row.termId),
            PaymentDetail("Term begins (UTC)", review.row.startsAt), PaymentDetail("Term ends (UTC)", review.row.endsAt))) {
            Text("${seekerShardsAmount(review.row.dueQuantity)} SHARDS currently available", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
            Text("${islandShareTime(review.row.startsAt)} – ${islandShareTime(review.row.endsAt)}", color = SurfaceInk.muted)
            Text("Destination: ${review.command.request.baseId}", style = MaterialTheme.typography.bodySmall)
            Text("The server calculates your current share when accepted. No wallet approval is needed.", color = SurfaceInk.muted)
        }
    }, confirmButton = { Button(onClick = { model.confirm(review) }, enabled = !busy && allowed, modifier = Modifier.heightIn(min = 54.dp)) { Text("CLAIM SHARDS") } },
        dismissButton = { TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("BACK") } }) }
}
