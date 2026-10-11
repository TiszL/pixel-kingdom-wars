package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionHydration
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.economy.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority

fun paidStarterEntryAvailable(state: StarterExpeditionState?, storageUnavailable: Boolean = false): Boolean =
    starterExpeditionEntryAvailable(state, storageUnavailable)
data class PaidStarterControls(val reviewSaved: Boolean, val confirm: Boolean, val check: Boolean, val archive: Boolean, val finish: Boolean)
/** Display controls only. The repository rereads current server admission before an explicit first POST.
 *  Owner 2026-10-06 (dead-end audit): [PaidStarterControls.archive] also covers an attempted departure with no outcome. A
 *  paid departure is never sent again, so it could otherwise never clear; the archive action closes it only after its
 *  fresh by-key receipt answers `unknown` (an acceptance found there wins). */
fun paidStarterControls(state: StarterExpeditionState, selectedBase: String?, allowed: Boolean): PaidStarterControls {
    val op = state.journal.operation; val idle = !state.busy; val paid = op?.command?.route?.routeId?.startsWith("paid_") == true
    val draft = op != null && op.proof == null && op.refusal == null && op.attemptRevision == null
    val canReview = idle && allowed && paid && draft && op?.command?.request?.baseId == selectedBase
    return PaidStarterControls(canReview, canReview && state.review?.command == op?.command && state.review?.paidView != null,
        idle && op != null, idle && op != null && op.proof == null, idle && op?.proof != null)
}

/** Separate selected destination surface; the existing eleven HOME/common choices stay unchanged. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun PaidStarterExpeditionScreen(model: StarterExpeditionViewModel, wallet: String, selectedBase: String?, allowed: Boolean, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    var realm by rememberSaveable(wallet, selectedBase) { mutableStateOf<Int?>(null) }; var menu by remember { mutableStateOf(false) }
    var history by rememberSaveable(wallet) { mutableStateOf(false) }
    val noticeLocation = remember { BringIntoViewRequester() }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    val busy = state.busy || running; val controls = paidStarterControls(state.copy(busy = busy), selectedBase, allowed)
    val selected = state.paidView?.takeIf { it.wallet == wallet && it.baseId == selectedBase && it.realm == realm }
    val current = state.view?.takeIf { it.wallet == wallet && it.baseId == selectedBase }
    val original = state.journal.operation
    val review = state.review?.takeIf { it.command.route.routeId.startsWith("paid_") }
    val back = { model.dismiss(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }
    DesignedPage("PAID REALM EXPEDITIONS", back) {
        // UI-R1: the paid review lives INSIDE this bounded scrolling page (never a display-wide dialog): same facts, coverage/read-only
        // semantics and the same model.confirm(review); the CONFIRM-priority Back above dismisses it before the pane's SHEET close.
        review?.let { r ->
            Text("CONFIRM PAID REALM DEPARTURE", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            PaymentPlate("Original paid departure", details = expeditionCommandDetails(r.command)) {
                StarterRouteDetails(r.command.route)
                Text("This uses existing coverage and does not purchase or renew it. Your fleet stays occupied until its automatic return.")
                Text("Resources return to the producing kingdom, including after a transfer. This trip cannot be cancelled.")
                Text("The destination is the original producing kingdom saved in this review. Its full identity is in Details.", color = SurfaceInk.muted)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { model.confirm(r) }, enabled = controls.confirm, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("CONFIRM DEPARTURE") }
                    TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL REVIEW") }
                }
            }
        }
        Text("Travel with existing realm coverage", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
        Text("A completed Expedition Lodge and installed starter fleet are required. Coverage is checked at departure; accepted trips return automatically even after it expires.", color = SurfaceInk.muted)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { Text(it.message, Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
        if (!allowed) Text("New departures are paused. Saved receipts and automatic returns remain available.")
        if (selectedBase == null) Text("Select an active kingdom to check a destination. Original receipts remain available below.")
        current?.let { ExpeditionKingdomSummary(it) }
        if (current == null && selectedBase != null) Text("Refresh to load this kingdom's fleet, Lodge and stock.", color = SurfaceInk.muted)
        if (original == null && selectedBase != null) {
            PaymentPlate("Choose a paid realm") {
                Text("Use existing coverage. This screen does not purchase or renew a realm pass.", color = SurfaceInk.muted)
                Box {
                    OutlinedButton(onClick = { menu = true }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(realm?.let { starterLabel(paidStarterRealmIds[it]) } ?: "CHOOSE REALM")
                    }
                    DropdownMenu(menu && !busy, onDismissRequest = { menu = false }) {
                        paidStarterRealmIds.forEachIndexed { index, id -> DropdownMenuItem(text = { Text(starterLabel(id)) },
                            onClick = { realm = index; menu = false; model.dismiss(); model.selectPaid(index) }) }
                    }
                }
                realm?.let { index -> OutlinedButton(onClick = { model.selectPaid(index) }, enabled = !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK SELECTED REALM") } }
            }
            selected?.let { paid -> PaymentPlate("Selected destination", details = listOf(PaymentDetail("Producing kingdom", paid.baseId), PaymentDetail("Server snapshot (UTC)", paid.serverNow))) {
                StarterRouteDetails(paid.route)
                Text(when (paid.coverage.status) { "covered" -> "Realm coverage was present in this snapshot. Departure checks it again."
                    "blocked" -> if (paid.coverage.reason == "EXPIRED") "Realm coverage has expired." else "No realm coverage is available for this wallet."
                    else -> "Realm coverage is unavailable. Check again when the server can verify it." })
                paid.coverage.expiresAt?.let { value -> runCatching { java.time.Instant.ofEpochSecond(value.toLong()).toString() }.getOrNull()
                    ?.let { Text("Coverage expires: $it (UTC)", style = MaterialTheme.typography.bodySmall) } }
                if (!paid.acceptingDepartures) Text("New paid departures are paused.")
                val ready = allowed && !busy && paid.acceptingDepartures && paid.coverage.status == "covered"
                    && current?.acceptingDepartures == true && current.home != null && current.installation != null
                    && current.lodgeCompletedAt != null && current.flight == null
                Button(onClick = { model.startPaid(paid.realm) }, enabled = ready, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REVIEW PAID DEPARTURE") }
            } }
        }
        original?.let { saved -> PaymentPlate("Saved departure", pill = expeditionSavedPill(saved), details = expeditionOriginalDetails(saved)) {
            ExpeditionOriginalDetails(saved)
            Text(if (saved.proof != null) "Historical departure evidence. Current stock is refreshed separately."
                else if (saved.attemptRevision != null && saved.refusal == null) "The original request may have been accepted. Only its receipt is checked; this paid departure will not be sent again."
                else "Closing this screen preserves the original request.")
            if (saved.command.request.baseId != selectedBase) Text("This saved departure belongs to another kingdom. Its original receipt remains available here.", color = SurfaceInk.muted)
            if (!saved.command.route.routeId.startsWith("paid_") && saved.proof == null && saved.refusal == null)
                Text("Review this saved request from Starter Expeditions.")
            if (controls.reviewSaved) OutlinedButton(onClick = { model.reviewSaved() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REVIEW SAVED PAID REQUEST") }
            OutlinedButton(onClick = { model.check() }, enabled = controls.check, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK ORIGINAL RECEIPT") }
            if (controls.finish) OutlinedButton(onClick = { model.finish() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("ARCHIVE ACCEPTED DEPARTURE") }
            if (controls.archive) OutlinedButton(onClick = { model.archiveUnusedOrRefused() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(when { saved.refusal != null -> "ARCHIVE DECLINED REQUEST"; saved.attemptRevision == null -> "ARCHIVE UNUSED DRAFT"
                    else -> "CLOSE SAVED REQUEST" })
            }
        } }
        if (state.hydration == StarterExpeditionHydration.ORIGINAL_BASE_UNAVAILABLE)
            Text("The original producing kingdom is unavailable here. Its receipt is preserved; no current stock is shown for it.")
        DisclosurePlate("EXPEDITION HISTORY (${state.journal.archives.size})", history, { history = !history }) {
            if (state.journal.archives.isEmpty()) Text("Accepted departures, declined requests and unused drafts appear here after archiving.", color = SurfaceInk.muted)
            state.journal.archives.asReversed().forEach { archive -> PaymentPlate(when (archive.reason) {
                "accepted" -> "Historical departure"; "refused" -> "Declined request"; "unknown" -> "Closed request"; else -> "Unused draft"
            }, pill = expeditionSavedPill(archive.operation), details = expeditionOriginalDetails(archive.operation)) {
                if (archive.reason != "accepted" && archive.operation.proof != null)
                    Text("Acceptance recovered after archival. The original archive reason is preserved.", color = SurfaceInk.muted)
                ExpeditionOriginalDetails(archive.operation)
                OutlinedButton(onClick = { model.checkArchived(archive.operation.command.key) }, enabled = !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK ORIGINAL RETURN") }
            } }
        }
        OutlinedButton(onClick = { model.refresh() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REFRESH STOCK & RECEIPTS") }
    }
}
