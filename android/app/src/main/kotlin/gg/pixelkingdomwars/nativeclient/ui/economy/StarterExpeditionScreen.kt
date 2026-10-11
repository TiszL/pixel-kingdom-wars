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
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionHydration
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation

/** Server routes supply all quantities and times. Only the server can observe a return. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun StarterExpeditionScreen(model: StarterExpeditionViewModel, wallet: String, selectedBase: String?, generation: Long,
    actionsAllowed: Boolean, onFleet: () -> Unit, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var routeId by rememberSaveable(wallet, selectedBase) { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }; var history by rememberSaveable(wallet) { mutableStateOf(false) }
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
    DesignedPage("STARTER EXPEDITIONS", back) {
        // UI-R1: the review lives INSIDE this bounded scrolling page (never a display-wide dialog), with the exact reviewed command,
        // costs and consent; the CONFIRM-priority Back above dismisses it before the pane's SHEET close. Same model.confirm(review).
        review?.takeIf { !it.command.route.routeId.startsWith("paid_") }?.let { r ->
            Text("CONFIRM STARTER DEPARTURE", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            PaymentPlate("Original departure", details = expeditionCommandDetails(r.command)) {
                StarterRouteDetails(r.command.route)
                Text("No SOL, Gems, SHARDS or resource cost. This trip cannot be cancelled. Your fleet is occupied until it returns.")
                Text("Resources return automatically to the producing kingdom, including after a transfer.")
                Text("The destination is the original producing kingdom saved in this review. Its full identity is in Details.", color = SurfaceInk.muted)
                if (operation?.attemptRevision != null) Text("This explicitly resends the same saved departure only after its original receipt is checked.")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { model.confirm(r) }, enabled = canAct, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("CONFIRM DEPARTURE") }
                    TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL REVIEW") }
                }
            }
        }
        Text("Gather resources with your starter fleet", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
        Text("A completed Expedition Lodge and installed starter fleet are required. Returned resources arrive automatically in the producing kingdom.", color = SurfaceInk.muted)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { Text(it.message, Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
        if (!actionsAllowed) Text("Game orders are paused. Original departures and return history remain available.")
        if (view == null) Text(if (selectedBase == null) "Select an active kingdom for routes and current stock. Saved receipts remain available below."
            else "Current expedition details are unavailable. Refresh to check this kingdom's server support.")
        view?.let { v ->
            ExpeditionKingdomSummary(v)
            val route = v.routes.singleOrNull { it.routeId == routeId }
            val editable = canAct && operation == null && v.acceptingDepartures && v.installation != null && v.lodgeCompletedAt != null && v.flight == null
            PaymentPlate("Choose an expedition") {
                Text("Review the route and producing kingdom before confirming. No departure cost.", color = SurfaceInk.muted)
                Box {
                    OutlinedButton(onClick = { menu = true }, enabled = editable, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(route?.let { starterLabel(it.routeId) } ?: "CHOOSE ROUTE")
                    }
                    DropdownMenu(menu && editable, onDismissRequest = { menu = false }) {
                        v.routes.forEach { item -> DropdownMenuItem(text = { Text("${starterLabel(item.routeId)} · ${starterLabel(item.resourceId)}") },
                            onClick = { routeId = item.routeId; menu = false }) }
                    }
                }
                route?.let {
                    StarterRouteDetails(it)
                    Button(onClick = { model.start(it.routeId) }, enabled = editable, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REVIEW DEPARTURE") }
                }
            }
        }
        operation?.let { saved -> PaymentPlate("Saved departure", pill = expeditionSavedPill(saved), details = expeditionOriginalDetails(saved)) {
            ExpeditionOriginalDetails(saved)
            Text(if (saved.proof != null) "Historical proof only. Current stock is shown separately from the kingdom's server snapshot."
                else if (saved.attemptRevision != null && saved.refusal == null) "This departure may have been accepted. Checking its receipt never sends it again."
                else "Closing this review keeps the original route and kingdom saved.", color = SurfaceInk.muted)
            if (saved.command.request.baseId != selectedBase) Text("This saved departure belongs to another kingdom. Its original receipt remains available here.", color = SurfaceInk.muted)
            if (saved.proof == null && saved.refusal == null && !saved.command.route.routeId.startsWith("paid_")) OutlinedButton(onClick = { model.reviewSaved() },
                enabled = canAct && saved.command.request.baseId == selectedBase, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(if (saved.attemptRevision == null) "REVIEW SAVED REQUEST" else "REVIEW SAME REQUEST AGAIN")
            }
            if (saved.command.route.routeId.startsWith("paid_") && saved.proof == null && saved.refusal == null)
                Text(if (saved.attemptRevision == null) "Review this saved draft from Paid Realm Expeditions." else "Paid departure is held for its original receipt. It cannot be sent again.")
            OutlinedButton(onClick = { model.check() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK ORIGINAL RECEIPT") }
            if (saved.proof != null) OutlinedButton(onClick = { model.finish() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("ARCHIVE ACCEPTED DEPARTURE") }
            // Owner 2026-10-06 (dead-end audit): an attempted departure with no outcome can be closed too. The same archive
            // action reads its receipt again and closes it only if the server answers `unknown` for this key; never a POST.
            else OutlinedButton(onClick = { model.archiveUnusedOrRefused() }, enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(when { saved.refusal != null -> "ARCHIVE DECLINED REQUEST"
                    saved.attemptRevision == null -> "ARCHIVE UNUSED DRAFT"; else -> "CLOSE SAVED REQUEST" }) }
        } }
        if (state.hydration == StarterExpeditionHydration.ORIGINAL_BASE_UNAVAILABLE)
            Text("The original departure is archived. Its producing kingdom is unavailable here; no current stock is shown for it.")
        DisclosurePlate("EXPEDITION HISTORY (${state.journal.archives.size})", history, { history = !history }) {
            if (state.journal.archives.isEmpty()) Text("Accepted departures, declined requests and unused drafts appear here after archiving.", color = SurfaceInk.muted)
            state.journal.archives.asReversed().forEach { archive -> PaymentPlate(when (archive.reason) {
                "accepted" -> "Historical departure"; "refused" -> "Declined request"; "unknown" -> "Closed request"; else -> "Unused draft"
            }, pill = expeditionSavedPill(archive.operation), details = expeditionOriginalDetails(archive.operation)) {
                if (archive.reason != "accepted" && archive.operation.proof != null)
                    Text("Acceptance recovered after archival. The original archive reason is preserved.", color = SurfaceInk.muted)
                ExpeditionOriginalDetails(archive.operation)
                OutlinedButton(onClick = { model.checkArchived(archive.operation.command.key) }, enabled = !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK AUTOMATIC RETURN") }
            } }
        }
        OutlinedButton(onClick = { model.refresh() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REFRESH STOCK & RECEIPTS") }
        OutlinedButton(onClick = { model.dismiss(); onFleet() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("OPEN STARTER FLEET") }
    }
}
