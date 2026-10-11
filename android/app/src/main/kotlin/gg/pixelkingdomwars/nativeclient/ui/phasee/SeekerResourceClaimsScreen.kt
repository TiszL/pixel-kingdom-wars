package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
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
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceEntitlement
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimJournal
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.Job

fun seekerResourceEntryAvailable(state: SeekerResourceClaimsState?, storageUnavailable: Boolean = false) = storageUnavailable || state?.let {
    it.view?.claimsEnabled == true || it.view?.rows?.isNotEmpty() == true || it.view?.nextCursor != null || it.view?.status == "unavailable" || it.journal.operation != null || it.journal.archives.isNotEmpty()
} == true
fun seekerResourceCanReview(state: SeekerResourceClaimsState, selectedBase: String?, actionsAllowed: Boolean) =
    !state.busy && actionsAllowed && selectedBase != null && state.view?.claimsEnabled == true && state.view.status == "available" && state.journal.operation == null

class SeekerResourceClaimsViewModel(private val repository: SeekerResourceClaimsRepository) : ScreenViewModel() {
    val state = repository.state; private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit) = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh(cursor: String? = null) = action { repository.awaitIdle(); repository.refresh(cursor) }
    fun review(row: SeekerResourceEntitlement) = action { repository.reviewClaim(row) }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: SeekerResourceReview) = action { repository.confirm(review) }
    fun check() = action { repository.check() }
    fun checkArchive(key: String) = action { repository.checkArchive(key) }
    fun finish() = action { repository.finish() }
    fun abandon() = action { repository.abandonDraft() }
    fun archiveUnknown(expected: SeekerResourceClaimJournal) = action { repository.archiveUnknown(expected) }
    fun dismiss() = repository.dismiss()
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun SeekerResourceClaimsScreen(model: SeekerResourceClaimsViewModel, selectedBase: String?, allowed: Boolean, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val busy = running || state.busy; val operation = state.journal.operation; val view = state.view
    var showHistory by rememberSaveable(state.journal.identity) { mutableStateOf(false) }
    val noticeLocation = remember { BringIntoViewRequester() }
    val back = { model.dismiss(); onBack() }
    DisposableEffect(model) { onDispose { model.dismiss() } }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    BackHandlerAt(BackPriority.SCREEN) { back() }; BackHandlerAt(BackPriority.CONFIRM, state.review != null) { model.dismiss() }
    DesignedPage("ISLAND RESOURCE SHARES", back) {
        PaymentPlate("Your resource shares", art = "bag") {
            Text("Collect shares from your winning spots into a kingdom you own.", color = SurfaceInk.text)
            Text("Earlier terms remain yours. KEEP and SHARDS are claimed separately.", color = SurfaceInk.muted)
            if (!allowed || view?.claimsEnabled == false) Text("New claims are paused. Your shares and saved receipts remain available.", color = SurfaceInk.goldHi)
            if (selectedBase == null) Text("Select a kingdom before reviewing a new claim.", color = SurfaceInk.muted)
        }
        if (busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("Checking shares and saved receipts…", color = SurfaceInk.muted) }
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }) {
            notice?.let { Text(it.message, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
        }
        if (view == null || view.status == "unavailable") Text("Resource history is unavailable. Claimable amounts could not be verified; saved claims remain below.", color = SurfaceInk.muted)
        islandResourcePageTotals(view)?.takeIf { it.isNotEmpty() }?.let { totals ->
            PaymentPlate("Claimable on this page", art = "bag") {
                totals.forEach { (id, quantity) -> Text("$quantity ${islandShareResource(id)}", Modifier.fillMaxWidth(), style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi) }
                if (view?.cursor != null || view?.nextCursor != null) Text("Other terms may have additional shares. Browse the pages to see them.", color = SurfaceInk.muted)
            }
        }
        view?.rows?.forEach { row ->
            PaymentPlate("${islandShareResource(row.resourceId)} · Spot ${row.spotId + 1}", art = "bag", details = listOf(
                PaymentDetail("Term", row.termId), PaymentDetail("Term begins (UTC)", row.startsAt), PaymentDetail("Term ends (UTC)", row.endsAt))) {
                Text("${seekerShardsAmount(row.dueQuantity)} available", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
                Text("Term: ${islandShareTime(row.startsAt)} – ${islandShareTime(row.endsAt)}", color = SurfaceInk.muted)
                Text("Already claimed: ${seekerShardsAmount(row.claimedTotal)}", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                Button(onClick = { model.review(row) }, enabled = !running && row.dueQuantity != "0" && seekerResourceCanReview(state, selectedBase, allowed),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("REVIEW CLAIM") }
            }
        }
        if (view?.status == "available" && view.rows.isEmpty()) Text(if (view.nextCursor == null) "No resource shares on this page." else "No resource shares on this page. More terms are available.", color = SurfaceInk.muted)
        view?.nextCursor?.let { cursor -> OutlinedButton(onClick = { model.refresh(cursor) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("NEXT SHARE PAGE") } }
        operation?.let { saved ->
            PaymentPlate("Saved ${islandShareResource(saved.command.request.resourceId)} claim", art = "bag", pill = islandResourcePill(saved), details = listOfNotNull(
                PaymentDetail("Request", saved.command.key), PaymentDetail("Original destination", saved.command.request.baseId),
                PaymentDetail("Term", saved.command.request.termId), saved.receipt?.let { PaymentDetail("Claimed at (UTC)", it.claimedAt) })) {
                Text("Spot ${saved.command.request.spotId + 1}", color = SurfaceInk.muted)
                saved.receipt?.let {
                    Text("${seekerShardsAmount(it.quantity)} ${islandShareResource(it.resourceId)} delivered", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
                    Text("${islandShareTime(it.claimedAt)} · original kingdom receipt", color = SurfaceInk.muted)
                }
                if (saved.receipt != null) Button(onClick = { model.finish() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("REFRESH KINGDOM & SAVE RECEIPT") }
                else if (saved.attemptRevision == null) {
                    Button(onClick = { model.reviewSaved() }, enabled = !busy && allowed && saved.command.request.baseId == selectedBase, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("REVIEW SAVED CLAIM") }
                    TextButton(onClick = { model.abandon() }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL UNSUBMITTED REVIEW") }
                } else {
                    Text("The claim outcome is unknown. Check its original receipt; this request will not be submitted again.", color = SurfaceInk.goldHi)
                    Text("If the server has no record of it, CLOSE checks once more and moves it to history so you can claim again.", color = SurfaceInk.muted)
                    OutlinedButton(onClick = { model.archiveUnknown(state.journal) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CLOSE SAVED CLAIM") }
                }
                OutlinedButton(onClick = { model.check() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK SAVED RECEIPT") }
            }
        }
        state.hydration?.let { Text(if (it == SeekerResourceHydration.ORIGINAL_BASE_UNAVAILABLE) "The original kingdom is no longer available. Its delivery receipt is saved." else "Kingdom stock refreshed from the server.", color = SurfaceInk.muted) }
        DisclosurePlate("CLAIM HISTORY (${state.journal.archives.size})", showHistory, { showHistory = !showHistory }) {
            if (state.journal.archives.isEmpty()) Text("Saved claims and cancelled reviews will appear here.", color = SurfaceInk.muted)
            state.journal.archives.asReversed().forEach { archive ->
                val saved = archive.operation
                PaymentPlate(if (saved.receipt != null) "${islandShareResource(saved.command.request.resourceId)} delivered" else if (archive.reason == "server-unknown") "Closed · no server record" else "Review cancelled", art = "bag", details = listOfNotNull(
                    PaymentDetail("Request", saved.command.key), PaymentDetail("Original destination", saved.command.request.baseId),
                    PaymentDetail("Term", saved.command.request.termId), saved.receipt?.let { PaymentDetail("Claimed at (UTC)", it.claimedAt) })) {
                    Text("Spot ${saved.command.request.spotId + 1}", color = SurfaceInk.muted)
                    saved.receipt?.let { Text("${seekerShardsAmount(it.quantity)} ${islandShareResource(it.resourceId)} · ${islandShareTime(it.claimedAt)}", color = SurfaceInk.goldHi) }
                    TextButton(onClick = { model.checkArchive(saved.command.key) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("CHECK HISTORICAL RECEIPT") }
                }
            }
        }
        OutlinedButton(onClick = { model.refresh() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REFRESH SHARE HISTORY") }
    }
    state.review?.let { review -> AlertDialog(onDismissRequest = model::dismiss, title = { Text("CLAIM RESOURCE SHARE") }, text = {
        PaymentPlate("${islandShareResource(review.row.resourceId)} · Spot ${review.row.spotId + 1}", art = "bag", details = listOf(
            PaymentDetail("Destination kingdom", review.command.request.baseId), PaymentDetail("Term", review.row.termId),
            PaymentDetail("Term begins (UTC)", review.row.startsAt), PaymentDetail("Term ends (UTC)", review.row.endsAt))) {
            Text("${seekerShardsAmount(review.row.dueQuantity)} currently available", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
            Text("${islandShareTime(review.row.startsAt)} – ${islandShareTime(review.row.endsAt)}", color = SurfaceInk.muted)
            Text("Destination: ${review.command.request.baseId}", style = MaterialTheme.typography.bodySmall)
            Text("The server calculates the current share when accepted. No wallet approval is needed.", color = SurfaceInk.muted)
        }
    }, confirmButton = { Button(onClick = { model.confirm(review) }, enabled = !busy && allowed, modifier = Modifier.heightIn(min = 54.dp)) { Text("CLAIM RESOURCES") } },
        dismissButton = { TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("BACK") } }) }
}
