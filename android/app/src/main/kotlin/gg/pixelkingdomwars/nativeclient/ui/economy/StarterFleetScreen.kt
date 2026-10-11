package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.StarterFleetHydration
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetCommand
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetOperation
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation

internal fun starterFleetSavedPill(operation: StarterFleetOperation) = when {
    operation.proof != null -> PaymentPill("CONFIRMED", PaymentTone.DONE)
    operation.refusal != null -> PaymentPill("DECLINED", PaymentTone.TROUBLE)
    operation.attemptRevision != null -> PaymentPill("CHECK OUTCOME", PaymentTone.TROUBLE)
    else -> PaymentPill("SAVED DRAFT", PaymentTone.OPEN)
}
internal fun starterFleetConfirmation(command: StarterFleetCommand) = if (command.installation == null) "INSTALL FREE FLEET" else "KEEP EXISTING FLEET"

/** The berth is positively advertised by the server; opening this page never installs a fleet. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun StarterFleetScreen(model: StarterFleetViewModel, wallet: String, selectedBase: String?, generation: Long,
    actionsAllowed: Boolean, onExpeditions: () -> Unit, onBack: () -> Unit) {
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
    DesignedPage("STARTER FLEET", back) {
        Text("Begin exploring", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
        Text("Complete a Vehicle Berth, then install your free starter fleet. It stays with its kingdom when ownership changes.", color = SurfaceInk.muted)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { Text(it.message, Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
        if (!actionsAllowed) Text("Game orders are paused. Original installation receipts remain available.", color = SurfaceInk.muted)
        if (view == null) Text(if (selectedBase == null) "Select an active kingdom to check its berth. Saved receipts remain available here."
            else "Refresh to load this kingdom's starter fleet and completed berths.", color = SurfaceInk.muted)
        view?.let { v -> PaymentPlate("Selected kingdom", pill = if (v.installation != null) PaymentPill("INSTALLED", PaymentTone.DONE) else PaymentPill("NOT INSTALLED", PaymentTone.OPEN),
            details = listOfNotNull(PaymentDetail("Kingdom", v.baseId), PaymentDetail("Server snapshot (UTC)", v.serverNow), v.installation?.let { PaymentDetail("Installed (UTC)", it.installedAt) }, v.installation?.let { PaymentDetail("Installed berth", it.berthId) })) {
            Text(if (v.installation == null) "Your first fleet" else "Starter fleet installed", style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
            Text(if (v.installation == null) "No SOL, Gems, SHARDS or resource cost." else "This kingdom already has its starter fleet. An installation request cannot create another.", color = SurfaceInk.muted)
            if (!v.acceptingInstallations) Text("New installation requests are paused.", color = SurfaceInk.muted)
            if (v.installation == null && v.eligibleBerths.isEmpty()) Text("Finish construction of a Vehicle Berth in this kingdom, then refresh to check eligibility.", color = SurfaceInk.muted)
        } }
        operation?.let { saved -> PaymentPlate("Saved installation request", pill = starterFleetSavedPill(saved), details = fleetOriginalDetails(saved)) {
            Text(if (saved.command.installation == null) "Free starter fleet installation" else "Existing starter fleet", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            Text(when {
                saved.proof != null -> "Original receipt confirmed. Current installation is shown separately above."
                saved.refusal != null -> "This request was declined. Check its original receipt before archiving."
                saved.attemptRevision != null -> "This request may have been accepted. Checking its receipt never sends it again."
                else -> "The original kingdom and berth stay saved after closing."
            }, color = SurfaceInk.muted)
            if (saved.command.request.baseId != selectedBase) Text("This request belongs to another kingdom. Receipt checks remain available here.", color = SurfaceInk.muted)
            if (saved.proof == null && saved.refusal == null) OutlinedButton(onClick = { model.reviewSaved() },
                enabled = canAct && saved.command.request.baseId == selectedBase, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(if (saved.attemptRevision == null) "REVIEW SAVED REQUEST" else "REVIEW SAME REQUEST AGAIN")
            }
            OutlinedButton(onClick = { model.check() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("CHECK ORIGINAL RECEIPT") }
            if (saved.proof != null) OutlinedButton(onClick = { model.finish() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("ARCHIVE ACCEPTED INSTALLATION") }
            // Owner 2026-10-06 (dead-end audit): an attempted request with no outcome can be closed too. The same archive
            // action reads its receipt again and closes it only if the server answers `unknown` for this key; never a POST.
            else OutlinedButton(onClick = { model.archiveUnusedOrRefused() }, enabled = !busy,
                modifier = Modifier.fillMaxWidth()) { Text(when { saved.refusal != null -> "ARCHIVE DECLINED REQUEST"
                    saved.attemptRevision == null -> "ARCHIVE UNUSED DRAFT"; else -> "CLOSE SAVED REQUEST" }) }
        } }
        view?.let { v -> v.eligibleBerths.forEachIndexed { index, berth -> PaymentPlate("Completed berth ${index + 1}", details = listOf(PaymentDetail("Berth", berth.berthId), PaymentDetail("Completed (UTC)", berth.berthCompletedAt))) {
            Text(if (v.installation == null) "Ready for your starter fleet" else "Review the existing installation", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            Text(if (v.installation == null) "Review the kingdom and berth before confirming the free installation." else "The original installation stays in place. This records a request for the existing fleet.", color = SurfaceInk.muted)
            Button(onClick = { model.start(berth.berthId) }, enabled = canAct && operation == null && v.acceptingInstallations,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (v.installation == null) "REVIEW FREE INSTALLATION" else "REVIEW EXISTING INSTALLATION") }
        } } }
        if (state.hydration == StarterFleetHydration.ORIGINAL_BASE_UNAVAILABLE) Text("The original receipt is archived. Its kingdom is unavailable here; no current installation is shown for it.", color = SurfaceInk.muted)
        OutlinedButton(onClick = { history = !history }, modifier = Modifier.fillMaxWidth().semantics { stateDescription = if (history) "Expanded" else "Collapsed" }) {
            Text("${if (history) "HIDE" else "SHOW"} INSTALLATION HISTORY (${state.journal.archives.size})")
        }
        if (history) {
            if (state.journal.archives.isEmpty()) Text("Confirmed installations, declined requests and unused drafts appear here after archiving.", color = SurfaceInk.muted)
            state.journal.archives.asReversed().forEach { archive -> PaymentPlate(when (archive.reason) { "accepted" -> "Historical installation"; "refused" -> "Declined request"; "unknown" -> "Closed request"; else -> "Unused draft" }, pill = starterFleetSavedPill(archive.operation), details = fleetOriginalDetails(archive.operation)) {
                if (archive.reason != "accepted" && archive.operation.proof != null) Text("Acceptance recovered after archival. The original archive reason is preserved.", color = SurfaceInk.muted)
                Text("Historical receipt. Current installation comes from the selected kingdom above.", color = SurfaceInk.muted)
                OutlinedButton(onClick = { model.checkArchived(archive.operation.command.key) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("CHECK ORIGINAL RECEIPT") }
            } }
        }
        OutlinedButton(onClick = { model.refresh() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("REFRESH FLEET & RECEIPTS") }
        OutlinedButton(onClick = { model.dismiss(); onExpeditions() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("OPEN STARTER EXPEDITIONS") }
    }
    review?.let { r ->
        AlertDialog(onDismissRequest = model::dismiss, title = { Text("REVIEW STARTER FLEET") }, text = {
            PaymentPlate("Original installation", details = listOf(PaymentDetail("Kingdom", r.command.request.baseId), PaymentDetail("Berth", r.command.berth.berthId), PaymentDetail("Berth completed (UTC)", r.command.berth.berthCompletedAt), PaymentDetail("Original request", r.command.key))) {
                Text(if (r.command.installation == null) "Install your free starter fleet" else "Keep the existing starter fleet", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
                Text(if (r.command.installation == null) "The fleet will attach to this completed berth." else "This records your request for the kingdom's existing fleet. It does not create an additional fleet.")
                Text("No SOL, Gems, SHARDS or resource cost. The fleet remains attached to this kingdom after a transfer.", color = SurfaceInk.muted)
                if (operation?.attemptRevision != null) Text("This explicitly resends the same saved request only after its original receipt is checked.", color = SurfaceInk.muted)
            }
        }, confirmButton = { Button(onClick = { model.confirm(r) }, enabled = canAct, modifier = Modifier.heightIn(min = 48.dp)) { Text(starterFleetConfirmation(r.command)) } },
            dismissButton = { TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL REVIEW") } })
    }
}
private fun fleetOriginalDetails(operation: StarterFleetOperation) = listOfNotNull(
    PaymentDetail("Original kingdom", operation.command.request.baseId), PaymentDetail("Original berth", operation.command.berth.berthId),
    PaymentDetail("Original request", operation.command.key), operation.proof?.receipt?.let { PaymentDetail("Installation", it.installation.installationId) },
    operation.proof?.receipt?.let { PaymentDetail("Installed (UTC)", it.installation.installedAt) }, operation.proof?.receipt?.let { PaymentDetail("Request accepted (UTC)", it.acceptedAt) })
