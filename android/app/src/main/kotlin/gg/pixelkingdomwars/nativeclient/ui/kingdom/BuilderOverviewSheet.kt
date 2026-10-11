@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.kingdom

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer
import gg.pixelkingdomwars.nativeclient.network.basePurchaseOffer
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal enum class BuilderSlotStatus { WORKING, RESTING, NEXT, LOCKED }
internal data class BuilderSlot(val number: Int, val status: BuilderSlotStatus, val priceSol: String?)
internal data class BuilderOverview(val owned: Int, val free: Int, val maximum: Int,
    val slots: List<BuilderSlot>, val hireOffer: BasePurchaseOffer?)

/** Builders are interchangeable. As on web BuildersScreen, the lowest owned slots display WORKING;
 * the server's free count determines that display, not an invented assignment or the job list length. */
internal fun builderOverview(catalogue: JsonObject?, base: BaseSnapshot): BuilderOverview? {
    val admitted = catalogue ?: return null
    val constants = admitted["constants"] as? JsonObject ?: return null
    val caps = constants["CAPS"] as? JsonObject ?: return null
    val maximum = caps.string("buildersMax")?.toIntOrNull()?.takeIf { it > 0 } ?: return null
    val owned = base.player.builders?.takeIf { it in 1..maximum } ?: return null
    val free = base.freeBuilders.takeIf { it in 0..owned } ?: return null
    val prices = caps["builderPricesSol"] as? JsonArray
    val working = owned - free
    val slots = (1..maximum).map { number ->
        BuilderSlot(number, when {
            number <= working -> BuilderSlotStatus.WORKING
            number <= owned -> BuilderSlotStatus.RESTING
            number == owned + 1 -> BuilderSlotStatus.NEXT
            else -> BuilderSlotStatus.LOCKED
        }, if (number == 1) null else (prices?.getOrNull(number - 2) as? JsonPrimitive)?.contentOrNull)
    }
    return BuilderOverview(owned, free, maximum, slots,
        if (owned < maximum) basePurchaseOffer(admitted, base, "builder") else null)
}

@Composable internal fun BuilderOverviewSheet(base: BaseSnapshot, catalogue: JsonObject?, now: Long,
    canHire: Boolean, onHire: () -> Unit, onViewJob: (BaseJob) -> Unit, onClose: () -> Unit) {
    val overview = builderOverview(catalogue, base)
    AlertDialog(onDismissRequest = onClose, title = { Text("BUILDERS") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (overview == null) Text("Builder details are unavailable. Refresh your kingdom to load its current roster.", color = Palette.muted)
            else {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${overview.owned} / ${overview.maximum} OWNED", style = MaterialTheme.typography.titleSmall, color = Palette.goldHi)
                    Text("${overview.owned - overview.free} WORKING · ${overview.free} RESTING", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
                }
                overview.slots.forEach { slot ->
                    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            GameArt("builder", Modifier.size(36.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text("BUILDER ${slot.number}", style = MaterialTheme.typography.labelLarge, color = Palette.text)
                                if (slot.number == 1) Text("CAME WITH THE KEEP", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                                else slot.priceSol?.let { Text("$it SOL · ONE-TIME", style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
                            }
                        }
                        when (slot.status) {
                            BuilderSlotStatus.WORKING -> Text("WORKING", style = MaterialTheme.typography.labelMedium, color = Palette.goldHi)
                            BuilderSlotStatus.RESTING -> Text("RESTING", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
                            BuilderSlotStatus.LOCKED -> Text("HIRE BUILDER ${slot.number - 1} FIRST", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                            BuilderSlotStatus.NEXT -> overview.hireOffer?.let { offer ->
                                Button(onClick = onHire, enabled = canHire, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                                    GameArt("sol", Modifier.size(20.dp))
                                    Text("HIRE · ${basePurchaseSol(offer.amountLamports)} SOL", style = MaterialTheme.typography.labelLarge)
                                }
                            } ?: Text("Hire offer unavailable", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                        }
                    } }
                }
                if (overview.owned == overview.maximum) Text("ALL BUILDER SLOTS OWNED", style = MaterialTheme.typography.labelMedium, color = Palette.goldHi)
                Text("Each builder works one job: construction, upgrades or clearing. Hired builders are permanent.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            }
            if (base.jobs.isNotEmpty()) {
                Text("ACTIVE JOBS", style = MaterialTheme.typography.titleMedium, color = Palette.goldHi)
                base.jobs.forEach { job ->
                    val building = base.buildings.firstOrNull { it.id == job.buildingId }
                    val obstacle = base.obstacles.firstOrNull { it.id == job.obstacleId }
                    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(listOfNotNull(building?.type?.let(::trayLabel), job.kind.uppercase()).joinToString(" · "), style = MaterialTheme.typography.labelMedium)
                        baseJobProgress(job.startedAt, job.finishesAt, now)?.let { progress ->
                            Text(progress.remaining, style = MaterialTheme.typography.labelMedium, color = Palette.goldHi)
                            LinearProgressIndicator(progress.fraction, Modifier.fillMaxWidth())
                        }
                        if (building != null || obstacle != null || job.kind == "clear_obstacle") TextButton(onClick = { onViewJob(job) }) { Text("VIEW JOB", style = MaterialTheme.typography.labelMedium) }
                    } }
                }
            }
        } }, confirmButton = { TextButton(onClick = onClose) { Text("DONE") } })
}
