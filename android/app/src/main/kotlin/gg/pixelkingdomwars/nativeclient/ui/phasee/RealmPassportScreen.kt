package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

internal fun passportDayLabel(day: String): String = runCatching {
    LocalDate.ofEpochDay(day.toLong()).toString() + " UTC"
}.getOrElse { "Mining day $day" }
internal fun passportTimeLabel(time: String): String = runCatching {
    Instant.parse(time).atOffset(ZoneOffset.UTC).let { "${it.toLocalDate()} · ${it.toLocalTime().withNano(0)} UTC" }
}.getOrElse { time }
internal fun passportUnavailable(reason: String?): String = when (reason) {
    "NOT_CONFIGURED" -> "This history source is not available yet."
    "SOURCE_CONFLICT" -> "These records could not be verified. Check again later."
    else -> "This source is temporarily unavailable. Try again later."
}

@Composable fun RealmPassportScreen(model: RealmPassportViewModel, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val kind by model.kind.collectAsState()
    val busy = state.expeditions.busy || state.inclusions.busy || state.current.busy
    val close = { model.close(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { close() }
    DesignedPage("REALM PASSPORT", close) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            GameArt("ui_compass", Modifier.size(36.dp))
            Column(Modifier.weight(1f)) {
                Text("Your journey, recorded", color = SurfaceInk.goldHi, style = MaterialTheme.typography.titleLarge)
                Text("Completed expeditions and published mining history for this account.", color = SurfaceInk.muted)
            }
        }
        Text("This history grants no rewards or access. It stays with the original participant when a kingdom changes owners.", color = SurfaceInk.muted, style = MaterialTheme.typography.bodySmall)
        PassportAction("REFRESH PASSPORT", !busy) { model.refresh() }
        PaymentPlate("Completed expeditions") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("starter", "advanced").forEach { item ->
                    OutlinedButton({ model.selectKind(item) }, Modifier.weight(1f).heightIn(min = 48.dp), enabled = !busy) {
                        Text(if (kind == item) "${item.replaceFirstChar(Char::uppercase)} · selected" else item.replaceFirstChar(Char::uppercase))
                    }
                }
            }
            PassportStatus(state.expeditions, "Loading completed expeditions…")
            state.expeditions.observation?.data?.let { page ->
                if (page.rows.isEmpty()) Text("No verified ${page.kind} returns in this page. Pending expeditions appear after their return is recorded.", color = SurfaceInk.muted)
                page.rows.forEach { expedition -> key(expedition.expeditionId) {
                    PaymentPlate("${expedition.realmId.replace('-', ' ').replaceFirstChar(Char::uppercase)} · returned",
                        details = listOfNotNull(PaymentDetail("Expedition", expedition.expeditionId), PaymentDetail("Return receipt", expedition.returnId),
                            PaymentDetail("Original kingdom", expedition.originalBaseId), PaymentDetail("Route", expedition.routeId),
                            expedition.routeVersion?.let { PaymentDetail("Route catalogue version", it.toString()) },
                            expedition.policyVersion?.let { PaymentDetail("Advanced policy version", it.toString()) },
                            PaymentDetail("Departed", passportTimeLabel(expedition.departedAt)), PaymentDetail("Scheduled return", passportTimeLabel(expedition.scheduledReturnAt)))) {
                        Text(passportTimeLabel(expedition.returnedAt), color = SurfaceInk.goldHi)
                        Text(expedition.routeId.replace('_', ' ').replace('-', ' ').replaceFirstChar(Char::uppercase), color = SurfaceInk.muted)
                        Text("${expedition.kind.replaceFirstChar(Char::uppercase)} expedition completed", color = SurfaceInk.muted)
                    }
                } }
                if (page.nextCursor != null) PassportAction("NEXT EXPEDITIONS", !busy) { model.nextExpeditions() }
            }
            PassportAction("REFRESH EXPEDITIONS FROM START", !busy) { model.refreshExpeditions() }
            Text("Refresh from the start to find trips that finished since your last check.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        }
        PaymentPlate("Mining inclusion history") {
            Text("Published cumulative totals. A repeated total does not mean another day of participation.", color = SurfaceInk.muted)
            PassportStatus(state.inclusions, "Loading published history…")
            state.inclusions.observation?.data?.let { page ->
                if (page.rows.isEmpty()) Text("No verified mining inclusions in this page.", color = SurfaceInk.muted)
                page.rows.forEach { row -> key(row.sequence) {
                    PaymentPlate(passportDayLabel(row.day), details = passportInclusionDetails(row)) {
                        Text("Publication ${row.sequence}", color = SurfaceInk.goldHi, style = MaterialTheme.typography.titleMedium)
                        Text("${row.leaf.cumulativeRenown} Renown · ${row.leaf.cumulativeDays} cumulative days")
                        Text("Historical inclusion only. Open KEEP Mining separately for current claims.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                    }
                } }
                if (page.nextCursor != null) PassportAction("NEXT PUBLICATIONS", !busy) { model.nextInclusions() }
            }
            PassportAction("REFRESH MINING HISTORY FROM START", !busy) { model.refreshInclusions() }
        }
        PaymentPlate("Current participation") {
            Text("The latest verified observation is separate from historical pages.", color = SurfaceInk.muted)
            PassportStatus(state.current, "Checking current participation…")
            state.current.observation?.data?.let { current ->
                PaymentPlate("Published participation") {
                    Text("${current.published.cumulativeRenown} Renown · ${current.published.cumulativeDays} cumulative days", color = SurfaceInk.goldHi)
                    Text("Publication ${current.publicationSequence}", color = SurfaceInk.muted)
                }
                PaymentPlate("Already attested on chain", details = listOf(PaymentDetail("Observed slot", current.observedSlot.toString()),
                    PaymentDetail("Chain time (Unix seconds)", current.chainUnixTimestamp))) {
                    val record = current.attested
                    if (record == null) Text("No verified attested record was found. This does not mean zero participation.", color = SurfaceInk.muted)
                    else {
                        Text("${record.renownTotal} Renown · ${record.daysAttested} attested days", color = SurfaceInk.goldHi)
                        Text("Last attested publication ${record.lastSequence}", color = SurfaceInk.muted)
                    }
                }
            }
            PassportAction("CHECK CURRENT PARTICIPATION", !busy) { model.refreshCurrent() }
        }
    }
}

@Composable private fun PassportAction(label: String, enabled: Boolean, action: () -> Unit) {
    OutlinedButton(action, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = enabled) { Text(label) }
}
@Composable private fun <T> PassportStatus(section: PassportSection<T>, loading: String) {
    if (section.busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(loading, color = SurfaceInk.muted) }
    section.error?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = SurfaceInk.danger) }
    section.observation?.let { observation ->
        observation.unavailableReason?.let { Text(passportUnavailable(it), color = SurfaceInk.muted) }
        Text("Checked ${passportTimeLabel(observation.serverNow)}", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
    }
}
internal fun passportInclusionDetails(row: PassportInclusion): List<PaymentDetail> = listOf(
    PaymentDetail("Wallet", row.leaf.wallet), PaymentDetail("Publication root", row.root), PaymentDetail("Source hash", row.sourceHash),
    PaymentDetail("Publication signature", row.publicationSignature), PaymentDetail("Publication slot", row.publicationSlot.toString()),
    PaymentDetail("Genesis hash", row.genesisHash), PaymentDetail("Program", row.programId), PaymentDetail("Configuration", row.configAddress),
    PaymentDetail("KEEP mint", row.keepMint), PaymentDetail("Reserve owner", row.reserveOwner),
    PaymentDetail("Cumulative KEEP base units", row.leaf.cumulativeKeepBaseUnits), PaymentDetail("Publication total base units", row.totalCumulativeBaseUnits)
) + row.proof.mapIndexed { index, proof -> PaymentDetail("Proof ${index + 1} · ${if (proof.isLeft) "left" else "right"}", "${proof.hash} · ${proof.sumBaseUnits} base units") }
