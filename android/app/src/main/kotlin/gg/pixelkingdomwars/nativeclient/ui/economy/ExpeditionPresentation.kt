package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*

/** Presentation only: a due time never promotes a saved departure to a returned trip. */
internal fun expeditionSavedPill(operation: StarterExpeditionOperation) = when {
    operation.proof?.returned != null -> PaymentPill("RETURNED", PaymentTone.DONE)
    operation.proof != null -> PaymentPill("DEPARTED", PaymentTone.SENT)
    operation.refusal != null -> PaymentPill("DECLINED", PaymentTone.TROUBLE)
    operation.attemptRevision != null -> PaymentPill("CHECK OUTCOME", PaymentTone.TROUBLE)
    else -> PaymentPill("SAVED DRAFT", PaymentTone.OPEN)
}
/** Display alias from canonical packages/shared/src/baseVisual.ts REALM_NAMES; IDs stay unchanged. */
internal fun starterLabel(id: String): String = when {
    id == "seeker-reach" -> "Solana Reach"
    id == "common_seeker_reach" -> "Common Solana Reach"
    id.startsWith("paid_") -> "Realm expedition · ${starterLabel(id.removePrefix("paid_").replace('_', '-'))}"
    else -> id.replace('-', '_').split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
}
internal data class ExpeditionCargo(val resourceId: String, val gross: String, val pool: String, val net: String)
/** Keep every server cargo leg exact, including saved terms from an older policy. */
internal fun expeditionCargo(route: StarterExpeditionRoute) = listOf(ExpeditionCargo(route.resourceId, route.grossQuantity, route.islandPoolQuantity, route.netQuantity)) +
    listOfNotNull(route.secondaryOutput?.let { ExpeditionCargo(it.resourceId, it.grossQuantity, it.islandPoolQuantity, it.netQuantity) })
internal fun expeditionCommandDetails(command: StarterExpeditionCommand) = listOf(
    PaymentDetail("Producing kingdom", command.request.baseId), PaymentDetail("Installed fleet", command.installation.installationId),
    PaymentDetail("Original request", command.key), PaymentDetail("Route version", command.route.routeCatalogueVersion.toString()),
    PaymentDetail("Reward version", command.route.rewardTableVersion.toString()), PaymentDetail("Duration (seconds)", command.route.durationSec.toString()))
internal fun expeditionOriginalDetails(operation: StarterExpeditionOperation) = expeditionCommandDetails(operation.command) + listOfNotNull(
    operation.proof?.receipt?.let { PaymentDetail("Expedition", it.expeditionId) },
    operation.proof?.receipt?.let { PaymentDetail("Original Seeker term", it.termId) },
    operation.proof?.receipt?.let { PaymentDetail("Original term hash", it.termHash) },
    operation.refusal?.let { PaymentDetail("Original refusal", "${it.status} · ${it.code}") })

@Composable internal fun StarterRouteDetails(route: StarterExpeditionRoute) {
    Text(starterLabel(route.routeId), style = MaterialTheme.typography.titleMedium, color = Palette.goldHi)
    Text("${starterLabel(route.realmId)} · ${fmtDur(route.durationSec)}", style = MaterialTheme.typography.bodyMedium)
    expeditionCargo(route).forEach { cargo ->
        PixelPlate("shard", Modifier.fillMaxWidth(), PaddingValues(10.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(starterLabel(cargo.resourceId), style = MaterialTheme.typography.labelMedium, color = Palette.muted)
                Text("${fmtN(cargo.net)} to producing kingdom", style = MaterialTheme.typography.titleMedium, color = Palette.goldHi)
                Text("Gathered: ${fmtN(cargo.gross)} · Island pool: ${fmtN(cargo.pool)}", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            }
        }
    }
    route.fitting?.let { Text("Fitted: ${starterLabel(it.itemId)}", style = MaterialTheme.typography.bodySmall, color = Palette.muted) }
    Text(when (route.access?.kind) {
        "paid_realm" -> "Paid realm route · server checks coverage at departure"
        "starter_common" -> "Common route · no deed or pass purchase required"
        else -> "Home-realm route"
    }, style = MaterialTheme.typography.bodySmall, color = Palette.muted)
}

@Composable internal fun ExpeditionKingdomSummary(view: StarterExpeditionView) {
    var stock by rememberSaveable(view.wallet, view.baseId) { mutableStateOf(false) }
    PaymentPlate("Selected kingdom", details = listOfNotNull(PaymentDetail("Kingdom", view.baseId), PaymentDetail("Server snapshot (UTC)", view.serverNow),
        view.installation?.let { PaymentDetail("Installed fleet", it.installationId) }, view.lodgeCompletedAt?.let { PaymentDetail("Lodge completed (UTC)", it) })) {
        Text(when { view.flight != null -> "Fleet travelling"; view.installation != null -> "Starter fleet installed"; else -> "Install your starter fleet" },
            style = MaterialTheme.typography.titleLarge, color = Palette.goldHi)
        Text(if (view.installation == null) "Complete a Vehicle Berth, then install your starter fleet." else if (view.flight == null) "Fleet idle · choose a route below." else "The fleet stays occupied until its automatic return.", color = Palette.muted)
        Text(if (view.lodgeCompletedAt == null) "Expedition Lodge required · finish construction before departure." else "Expedition Lodge ready", color = Palette.muted)
        view.home?.let { Text("Home realm: ${starterLabel(it.realmId)}${if (it.source == "free_policy_preview") " (assigned at first departure)" else ""}", style = MaterialTheme.typography.bodySmall, color = Palette.muted) }
        if (!view.acceptingDepartures) Text("New departures are paused. Accepted trips still return automatically.", color = Palette.muted)
        DisclosurePlate("CURRENT RESOURCE STOCK", stock, { stock = !stock }) {
            Text("Current server stock includes reserved resources. Historical return receipts do not replace this balance.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            view.rawStock.forEach { row -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(starterLabel(row.resourceId), style = MaterialTheme.typography.titleSmall)
                Text("${fmtN(row.available)} available · ${fmtN(row.reserved)} reserved · ${fmtN(row.total)} total", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            } }
        }
    }
    view.flight?.let { flight -> PaymentPlate("Current expedition", pill = PaymentPill("TRAVELLING", PaymentTone.SENT),
        details = listOf(PaymentDetail("Expedition", flight.expeditionId), PaymentDetail("Producing kingdom", view.baseId))) {
        StarterRouteDetails(flight.route)
        Text("Due: ${flight.returnsAt} (UTC)", style = MaterialTheme.typography.bodySmall)
        Text("Refresh for the server's return observation.", color = Palette.muted)
    } }
}

@Composable internal fun ExpeditionOriginalDetails(operation: StarterExpeditionOperation) {
    StarterRouteDetails(operation.command.route)
    operation.proof?.let { proof ->
        proof.receipt?.let {
            Text("Departed: ${it.departedAt} (UTC)", style = MaterialTheme.typography.bodySmall)
            Text("Due: ${it.returnsAt} (UTC)", style = MaterialTheme.typography.bodySmall)
        }
        Text(proof.returned?.let { "Automatic return observed: ${it.returnedAt} (UTC)" }
            ?: "Departure accepted. Automatic return has not been observed; check the original receipt.", color = Palette.muted)
    }
}
