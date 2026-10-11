package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.FreeBasePurchaseRepository
import gg.pixelkingdomwars.nativeclient.data.FreeBasePurchaseReview
import gg.pixelkingdomwars.nativeclient.freebase.FreeBasePurchaseJournal
import gg.pixelkingdomwars.nativeclient.freebase.FreeBasePurchaseTerms
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.Job

class FreeBasePurchaseViewModel(private val repository: FreeBasePurchaseRepository) : ScreenViewModel() {
    val state = repository.state
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit) = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action { repository.awaitIdle(); repository.refresh() }
    fun review() = action { repository.reviewPurchase() }
    fun confirm(review: FreeBasePurchaseReview) = action { repository.confirm(review) }
    fun check() = action { repository.check() }
    fun close(expected: FreeBasePurchaseJournal) = action { repository.close(expected) }
    fun dismiss() = repository.dismiss()
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun FreeBasePurchaseScreen(model: FreeBasePurchaseViewModel, selectedBase: String?, actionsAllowed: Boolean, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val busy = running || state.busy; val operation = state.journal.operation
    val view = state.view?.takeIf { it.sourceBaseId == selectedBase || (it.sourceBaseId == null && it.receipt != null) }
    val receipt = operation?.receipt ?: view?.receipt
    val canReview = !running && freeBasePurchaseCanReview(state, selectedBase, actionsAllowed)
    val noticeLocation = remember { BringIntoViewRequester() }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    val back = { model.dismiss(); onBack() }
    DisposableEffect(model) { onDispose { model.dismiss() } }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, state.review != null) { model.dismiss() }
    DesignedPage("SECOND FREE KINGDOM", back) {
        Text("Room for another kingdom", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
        Text("Spend SHARDS from your developed free kingdom to create an additional free kingdom. Your existing kingdom stays with you.", color = SurfaceInk.muted)
        if (busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("Updating purchase details…", color = SurfaceInk.muted) }
        notice?.let { Text(it.message, Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
        if (!actionsAllowed || view?.enabled == false) Text("New purchases are paused. Saved receipts can still be checked.", color = SurfaceInk.muted)
        if (view == null) PaymentPlate("Selected source kingdom") {
            Text(if (selectedBase == null) "Choose your source kingdom" else "Current terms unavailable", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            Text(if (selectedBase == null) "Select your developed free kingdom to review a purchase. Saved receipt recovery remains available."
                else "Refresh to check this kingdom's eligibility and cost. Original purchase terms stay saved below.", color = SurfaceInk.muted)
        }
        view?.let { v -> PaymentPlate("Current purchase terms", pill = PaymentPill(if (receipt != null) "PURCHASED" else if (canReview) "READY" else "UNAVAILABLE",
            if (receipt != null) PaymentTone.DONE else if (canReview) PaymentTone.OPEN else PaymentTone.CLOSED),
            details = listOfNotNull(v.sourceBaseId?.let { PaymentDetail("Source kingdom", it) }, PaymentDetail("Policy version", v.terms.policyVersion.toString()))) {
            Text("${fmtN(v.terms.costShards)} SHARDS", style = MaterialTheme.typography.headlineMedium, color = SurfaceInk.goldHi)
            Text("Charged once from the reviewed source kingdom.", color = SurfaceInk.muted)
            FreeBaseRequirements(v.terms)
            Text(freeBaseAdmissionMessage(v.admission.reason), color = SurfaceInk.muted)
            if (operation == null && receipt == null) Button(onClick = { model.review() }, enabled = canReview,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REVIEW KINGDOM PURCHASE") }
        } }
        operation?.let { saved -> PaymentPlate("Saved purchase", pill = freeBaseSavedPill(saved), details = freeBaseCommandDetails(saved.command)) {
            Text("${fmtN(saved.command.terms.costShards)} SHARDS", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
            Text(when {
                saved.receipt != null -> "Original purchase confirmed. The receipt below records the kingdom created and exact charge."
                saved.attemptRevision != null -> "This purchase may have completed. Checking its receipt never sends another purchase."
                else -> "Your reviewed source kingdom and cost remain saved when you close this page."
            }, color = SurfaceInk.muted)
            if (saved.command.request.sourceBaseId != selectedBase) Text("This request belongs to another source kingdom. You can still check its receipt here.", color = SurfaceInk.muted)
            if (saved.receipt == null && receipt == null) Button(onClick = { model.review() }, enabled = canReview,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(if (saved.attemptRevision != null) "REVIEW SAME REQUEST AGAIN" else "REVIEW SAVED REQUEST")
            }
            OutlinedButton(onClick = { model.check() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("CHECK SAVED RECEIPT") }
            if (saved.receipt == null && receipt == null) {
                Text("If the server has no record of this request, CLOSE it to review a new purchase. CLOSE checks first and never sends a purchase.", color = SurfaceInk.muted)
                OutlinedButton(onClick = { model.close(state.journal) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CLOSE SAVED REQUEST") }
            }
        } }
        receipt?.let { r -> PaymentPlate("Kingdom purchase receipt", pill = PaymentPill("ACCEPTED", PaymentTone.DONE), details = freeBaseReceiptDetails(r)) {
            Text("Additional kingdom created", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
            Text("${fmtN(r.shardsCharged)} SHARDS charged", style = MaterialTheme.typography.titleMedium)
            Text("Accepted: ${r.acceptedAt} (UTC)", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            Text("Return to your kingdom list to see current ownership and availability. This historical receipt does not change your selection.", color = SurfaceInk.muted)
        } }
        OutlinedButton(onClick = { model.refresh() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("REFRESH TERMS & RECEIPT") }
    }
    state.review?.let { review -> AlertDialog(onDismissRequest = model::dismiss, title = { Text("REVIEW SECOND KINGDOM") }, text = {
        PaymentPlate("Original purchase", details = freeBaseCommandDetails(review.command)) {
            Text("${fmtN(review.command.terms.costShards)} SHARDS", style = MaterialTheme.typography.headlineMedium, color = SurfaceInk.goldHi)
            Text("From your reviewed source kingdom", style = MaterialTheme.typography.titleMedium)
            Text("Create an additional free kingdom and keep your existing kingdom. This purchase is recorded once for your wallet.", color = SurfaceInk.muted)
            FreeBaseRequirements(review.command.terms)
            if (operation?.attemptRevision != null) Text("This explicitly retries the same saved request after checking its receipt.", color = SurfaceInk.muted)
        }
    }, confirmButton = { Button(onClick = { model.confirm(review) }, enabled = canReview, modifier = Modifier.heightIn(min = 48.dp)) { Text(freeBaseConfirmation(review.command)) } },
        dismissButton = { TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL REVIEW") } }) }
}

@Composable private fun FreeBaseRequirements(terms: FreeBasePurchaseTerms) {
    Text("Completed building requirements", style = MaterialTheme.typography.titleSmall)
    Text("Keep level ${terms.minKeepLevel} · Workshop level ${terms.minWorkshopLevel} · Gold Forge level ${terms.minGoldForgeLevel}", color = SurfaceInk.muted)
    Text("Kingdom limits: ${terms.maxFreeBases} free · ${terms.maxActiveBases} active total", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
}
