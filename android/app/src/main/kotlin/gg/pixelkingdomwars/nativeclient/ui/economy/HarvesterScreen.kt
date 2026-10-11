package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.HarvesterHydration
import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.coroutines.awaitCancellation

/** Every earning quantity and interval comes from current or frozen server policy. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun HarvesterScreen(model: HarvesterViewModel, wallet: String, selectedBase: String?, generation: Long,
    actionsAllowed: Boolean, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var history by rememberSaveable(wallet) { mutableStateOf(false) }
    val noticeLocation = remember { BringIntoViewRequester() }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle, generation) {
        model.dismiss(); lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
    }
    LaunchedEffect(actionsAllowed) { if (!actionsAllowed) model.dismiss() }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    val back = { model.dismiss(); onBack() }; val busy = state.busy || running; val operation = state.journal.operation
    val view = state.view?.takeIf { it.wallet == wallet && it.baseId == selectedBase }; val review = state.review
    val canAct = actionsAllowed && !busy
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }
    DesignedPage("HARVESTERS", back) {
        Text("Gather your home resource", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
        Text("Choose a completed Harvester for an earning interval. Earned resources arrive automatically in the producing kingdom.", color = SurfaceInk.muted)
        if (busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("Checking stock and original receipts…", color = SurfaceInk.muted) }
        notice?.let { Text(it.message, Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
        if (!actionsAllowed) Text("Game orders are paused. Original sources and earning history remain available.", color = SurfaceInk.muted)
        if (view == null) PaymentPlate("Selected kingdom") {
            Text(if (selectedBase == null) "Choose a kingdom" else "Harvester details unavailable", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            Text(if (selectedBase == null) "Select an active kingdom for current stock and Harvester selection. Saved receipts remain below."
                else "Refresh to check this kingdom. Saved receipts remain available while current details are missing.", color = SurfaceInk.muted)
        }
        view?.let { v ->
            HarvesterKingdomSummary(v)
            v.walletSource?.let { source -> PaymentPlate("Current wallet selection", details = harvesterSourceDetails(source)) {
                HarvesterSourceSummary(source)
                if (source.baseId != selectedBase) Text("This source belongs to another kingdom. A new selection will replace it only after review.", color = SurfaceInk.muted)
                Text("The selection stays recorded until the server closes it, including after its interval ends. A new interval needs fresh confirmation.", color = SurfaceInk.muted)
            } }
        }
        operation?.let { saved -> PaymentPlate("Saved Harvester request", pill = harvesterSavedPill(saved), details = harvesterOriginalDetails(saved)) {
            HarvesterOriginalSummary(saved)
            if (saved.command.request.baseId != selectedBase) Text("This request belongs to another kingdom. Receipt checks remain available here.", color = SurfaceInk.muted)
            if (saved.proof == null && saved.refusal == null) OutlinedButton(onClick = { model.reviewSaved() },
                enabled = canAct && saved.command.request.baseId == selectedBase, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(if (saved.attemptRevision == null) "REVIEW SAVED REQUEST" else "REVIEW SAME REQUEST AGAIN")
            }
            OutlinedButton(onClick = { model.check() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("CHECK ORIGINAL RECEIPT") }
            if (saved.proof != null) OutlinedButton(onClick = { model.finish() }, enabled = !busy,
                modifier = Modifier.fillMaxWidth()) { Text("ARCHIVE ACCEPTED SOURCE") }
            // Owner 2026-10-06 (dead-end audit): an attempted request with no outcome can be closed too. The same archive
            // action reads its receipt again and closes it only if the server answers `unknown` for this key; never a POST.
            else OutlinedButton(onClick = { model.archiveUnusedOrRefused() }, enabled = !busy,
                modifier = Modifier.fillMaxWidth()) { Text(when { saved.refusal != null -> "ARCHIVE DECLINED REQUEST"
                    saved.attemptRevision == null -> "ARCHIVE UNUSED DRAFT"; else -> "CLOSE SAVED REQUEST" }) }
        } }
        view?.let { v ->
            v.facilities.forEachIndexed { index, facility -> PaymentPlate("Completed Harvester ${index + 1}", details = listOf(
                PaymentDetail("Harvester", facility.harvesterId), PaymentDetail("Completed (UTC)", facility.harvesterCompletedAt))) {
                Text(if (v.walletSource?.harvesterId == facility.harvesterId) "Review another earning interval" else "Ready for selection", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
                Text(v.home?.let { "Produces your ${starterLabel(it.realmId)} home resource." } ?: "Home-realm details must be available before selection.", color = SurfaceInk.muted)
                if (operation != null) Text("Finish or archive the saved request above before starting another.", color = SurfaceInk.muted)
                Button(onClick = { model.start(facility.harvesterId) }, enabled = harvesterSelectionReady(v, operation, actionsAllowed, busy),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(if (v.walletSource?.harvesterId == facility.harvesterId) "REVIEW NEW INTERVAL" else "REVIEW SELECTION")
                }
            } }
        }
        if (state.hydration == HarvesterHydration.ORIGINAL_BASE_UNAVAILABLE)
            Text("The original source is archived. Its kingdom is unavailable here; its receipt does not represent current stock.", color = SurfaceInk.muted)
        OutlinedButton(onClick = { history = !history }, modifier = Modifier.fillMaxWidth().semantics { stateDescription = if (history) "Expanded" else "Collapsed" }) {
            Text("${if (history) "HIDE" else "SHOW"} EARNING HISTORY (${state.journal.archives.size})")
        }
        if (history) {
            if (state.journal.archives.isEmpty()) Text("Accepted sources, declined requests and unused drafts appear here after archiving.", color = SurfaceInk.muted)
            state.journal.archives.asReversed().forEach { archive -> PaymentPlate(when (archive.reason) { "accepted" -> "Historical source"; "refused" -> "Declined request"; "unknown" -> "Closed request"; else -> "Unused draft" },
                pill = harvesterSavedPill(archive.operation), details = harvesterOriginalDetails(archive.operation)) {
                if (archive.reason != "accepted" && archive.operation.proof != null) Text("Acceptance recovered after archival. The original archive reason is preserved.", color = SurfaceInk.muted)
                HarvesterOriginalSummary(archive.operation)
                OutlinedButton(onClick = { model.checkArchived(archive.operation.command.key) }, enabled = !busy,
                    modifier = Modifier.fillMaxWidth()) { Text("CHECK EARNING OBSERVATIONS") }
            } }
        }
        OutlinedButton(onClick = { model.refresh() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("REFRESH STOCK & RECEIPTS") }
    }
    review?.let { r ->
        AlertDialog(onDismissRequest = model::dismiss, title = { Text("REVIEW HARVESTER SELECTION") }, text = {
            PaymentPlate("Original selection", details = harvesterCommandDetails(r.command)) {
                Text("${starterLabel(r.command.realmId)} home resource", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
                HarvesterPolicyDetails(r.command.policy)
                r.command.replacedSource?.let { previous ->
                    Text("This closes the previous source below and starts a new interval. Already earned units stay owed to their producing kingdom.", color = SurfaceInk.muted)
                    PaymentPlate("Source being replaced", details = harvesterSourceDetails(previous)) { HarvesterSourceSummary(previous) }
                } ?: Text("No existing wallet source will be replaced.", color = SurfaceInk.muted)
                Text("Earning may stop earlier when the operating term ends or kingdom authority changes. Future earnings are not spendable stock.", color = SurfaceInk.muted)
                if (operation?.attemptRevision != null) Text("This explicitly resends the same saved selection only after its original receipt is checked.", color = SurfaceInk.muted)
            }
        }, confirmButton = { Button(onClick = { model.confirm(r) }, enabled = canAct, modifier = Modifier.heightIn(min = 48.dp)) { Text("CONFIRM SELECTION") } },
            dismissButton = { TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL REVIEW") } })
    }
}
@Composable private fun HarvesterKingdomSummary(view: HarvesterView) {
    var stock by rememberSaveable(view.wallet, view.baseId) { mutableStateOf(false) }
    var policy by rememberSaveable(view.wallet, view.baseId) { mutableStateOf(false) }
    PaymentPlate("Selected kingdom", details = listOf(PaymentDetail("Kingdom", view.baseId), PaymentDetail("Server snapshot (UTC)", view.serverNow))) {
        Text(view.home?.let { starterLabel(it.realmId) } ?: "Home realm unavailable", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
        if (view.home?.source == "free_policy_preview") Text("Home realm will be assigned on selection.", color = SurfaceInk.muted)
        Text(if (view.facilities.isEmpty()) "Complete a Harvester in this kingdom, then refresh to select it." else "${view.facilities.size} completed Harvester${if (view.facilities.size == 1) "" else "s"}", color = SurfaceInk.muted)
        view.source?.let { source -> view.rawStock.singleOrNull { it.resourceId == source.resourceId }?.let { row ->
            Text("${fmtN(row.available)} ${starterLabel(row.resourceId)} available", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            Text("Current kingdom stock · ${fmtN(row.reserved)} reserved", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        } }
        if (!view.acceptingSelections) Text("New selections are paused. Original earning observations remain recoverable.", color = SurfaceInk.muted)
        Text("Resource delivery is automatic. Refresh to see the current stock; no separate collection action is needed.", color = SurfaceInk.muted)
        DisclosurePlate("CURRENT RESOURCE STOCK", stock, { stock = !stock }) {
            view.rawStock.forEach { row -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(starterLabel(row.resourceId), style = MaterialTheme.typography.titleSmall)
                Text("${fmtN(row.available)} available · ${fmtN(row.reserved)} reserved · ${fmtN(row.total)} total", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            } }
        }
        DisclosurePlate("EARNING LIMITS", policy, { policy = !policy }) {
            HarvesterPolicyDetails(view.policy)
            Text("Wallet-wide limits and tax rounding continue across kingdom and Harvester changes. Extra facilities do not raise them.", color = SurfaceInk.muted)
        }
    }
}
@Composable private fun HarvesterPolicyDetails(policy: HarvesterPolicy) {
    val percent = BigDecimal.valueOf(policy.islandPoolBps).multiply(BigDecimal.valueOf(100))
        .divide(BigDecimal.valueOf(policy.taxBasisPoints), 6, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()
    Text("Up to ${fmtN(policy.grossPerCadence)} gross every ${fmtDur(policy.cadenceSec)}", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
    Text("${fmtN(policy.grossPerWalletUtcDay)} gross per wallet per UTC day · ${percent}% to the island pool", color = SurfaceInk.muted)
    Text("${policy.producingSourcesPerWallet} producing source per wallet · up to ${fmtDur(policy.maxLeaseSec)} unattended. Only completed earning periods count.", color = SurfaceInk.muted)
}
@Composable private fun HarvesterSourceSummary(source: HarvesterSummary) {
    Text(starterLabel(source.resourceId), style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
    Text(starterLabel(source.realmId), color = SurfaceInk.muted)
    Text("Selected: ${source.admittedAt} (UTC)", style = MaterialTheme.typography.bodySmall)
    Text("Interval ends: ${source.leaseExpiresAt} (UTC)", style = MaterialTheme.typography.bodySmall)
}
@Composable private fun HarvesterOriginalSummary(operation: HarvesterOperation) {
    val proof = operation.proof
    if (proof == null) {
        HarvesterPolicyDetails(operation.command.policy)
        Text(when {
            operation.refusal != null -> "The original request was declined. Check its receipt before archiving."
            operation.attemptRevision != null -> "This selection may have been accepted. Checking its receipt never submits it again."
            else -> "The exact source and replacement consent stay saved after closing."
        }, color = SurfaceInk.muted)
    } else {
        proof.originalReceipt?.source?.let { HarvesterSourceSummary(it.summary()) }
        proof.settlement?.let { settlement ->
            val observed = harvesterObservedAmounts(settlement)
            Text("${fmtN(observed.delivered)} delivered in ${settlement.events.size} recorded earning periods", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            Text("Gross: ${fmtN(observed.gross)} · Island pool: ${fmtN(observed.pool)}", color = SurfaceInk.muted)
            Text("Historical delivery. Current spendable stock is shown separately above.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            Text(settlement.closure?.let { "Source closed: ${starterLabel(it.reason)} · ${it.cutoffAt} (UTC)" }
                ?: "Closure has not been observed. Check the original receipt for later earnings.", color = SurfaceInk.muted)
            var events by rememberSaveable(operation.command.key) { mutableStateOf(false) }
            DisclosurePlate("EARNING OBSERVATIONS", events, { events = !events }) {
                if (settlement.events.isEmpty()) Text("No completed earning periods have been observed.", color = SurfaceInk.muted)
                settlement.events.forEach { event -> Text("${event.earnedAt}: ${fmtN(event.grossQuantity)} gross · ${fmtN(event.netQuantity)} delivered · ${fmtN(event.islandPoolQuantity)} island pool", style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
