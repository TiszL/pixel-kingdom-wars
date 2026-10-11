@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Web `ClaimScreen` (screens/menu.tsx): the streak-ladder cache, SEPARATE from mining. Every value is the
 * server's `/mine/status.cache`; the 7-day track length is `DAILY_CACHE.consistencyStreakDays` and the
 * day-7 bonus `MINING.CONSISTENCY_BPS / BPS_ONE` from the catalogue. */
@Composable fun DailyCacheDialog(catalogue: JsonObject?, mine: MineStatus?, busy: Boolean, now: Long, onClaim: () -> Unit, onClose: () -> Unit) {
    val constants = catalogue?.get("constants") as? JsonObject
    val days = (constants?.get("DAILY_CACHE") as? JsonObject)?.string("consistencyStreakDays")?.toIntOrNull()
    val mining = constants?.get("MINING") as? JsonObject
    val bonus = mining?.get("CONSISTENCY_BPS")?.let { (it as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull() }?.let { bps -> mining.string("BPS_ONE")?.toDoubleOrNull()?.takeIf { it > 0 }?.let { one -> bps / one } }
    val cache = mine?.cache
    val lit = cache?.currentDay ?: 0
    val claimable = cache?.claimable == true
    val countdown = cache?.nextClaimAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }?.let { fmtClock(maxOf(0L, (it - now) / 1000)) } ?: "--:--:--"
    AlertDialog(onDismissRequest = onClose, title = { Text("DAILY SHARD CACHE", color = Palette.gold) }, text = {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().background(Palette.ink).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt("shards", Modifier.size(48.dp))
                Column(Modifier.weight(1f)) {
                    Text("TODAY'S REWARD", color = Palette.muted, style = MaterialTheme.typography.labelSmall)
                    Text("+${cache?.cacheShards?.let(::fmtN) ?: "…"} SHARDS", color = Palette.goldHi, style = MaterialTheme.typography.headlineSmall)
                }
            }
            if (days != null) {
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    (1..days).forEach { d ->
                        Column(Modifier.widthIn(min = 36.dp).background(Palette.ink).border(1.dp, if (d <= lit) Palette.gold else Palette.border).padding(5.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            GameArt(if (d <= lit) "streak" else "shards", Modifier.size(18.dp))
                            Text("D$d", color = if (d <= lit) Palette.gold else Palette.muted, style = MaterialTheme.typography.labelSmall, fontWeight = if (d <= lit) FontWeight.Bold else null)
                        }
                    }
                }
                Text("DAY ${maxOf(1, lit)} OF $days" + (bonus?.let { " · ×${if (it == Math.floor(it)) it.toLong().toString() else it.toString()} BONUS AT D$days" } ?: ""), style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            } else Text("GAME CONTENT UPDATE NEEDED — THIS PACK LACKS DAILY_CACHE.consistencyStreakDays.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            Text(if (claimable) "READY TO CLAIM" else "NEXT CACHE · $countdown", style = MaterialTheme.typography.bodySmall, color = if (claimable) Palette.goldHi else Palette.muted)
        }
    }, confirmButton = { Button(onClick = onClaim, enabled = !busy && claimable) { Text(if (claimable) "CLAIM" else "CLAIMED TODAY") } },
        dismissButton = { TextButton(onClick = onClose) { Text("CLOSE") } })
}

/** Web `ExpandScreen`: canonical claim and Keep gate; the price button opens the one confirm plate, then the wallet. */
@Composable fun ExpandDialog(catalogue: JsonObject?, expansions: Int, keepLevel: Int, onClose: () -> Unit,
    purchase: BasePurchaseOffer? = null, enabled: Boolean = false, testExpansion: Boolean = false, onReview: () -> Unit = {}) {
    val offer = catalogue?.let { expansionOffer(it, expansions) }
    val gated = offer?.requiredKeepLevel?.let { keepLevel < it } == true
    AlertDialog(onDismissRequest = onClose, title = { Text("EXPAND LAND", color = Palette.gold) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (offer == null) { Text("Please update the game to view land expansions.", color = Palette.muted); return@Column }
            Row(Modifier.fillMaxWidth().background(Palette.ink).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt("map", Modifier.size(42.dp))
                Column {
                    Text("CURRENT CLAIM", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                    Text("${offer.size} × ${offer.size} TILES", color = Palette.text, style = MaterialTheme.typography.titleLarge)
                }
            }
            if (offer.maxed) Text("MAX CLAIM REACHED — THE LAND ALLOWS NO MORE", color = Palette.muted)
            else {
                Text("EXPAND TO ${offer.next} × ${offer.next} TILES", color = Palette.goldHi, style = MaterialTheme.typography.titleMedium)
                Text("Make more room for buildings around your kingdom. Your buildings stay in place. Recorded on your land deed.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                if (gated) Text("REQUIRES KEEP LEVEL ${offer.requiredKeepLevel}", color = Palette.gold, style = MaterialTheme.typography.bodySmall)
                Text(if (testExpansion) "This test kingdom expands for free. No SOL payment or wallet approval is needed."
                    else "Your wallet asks you to approve the payment.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            }
        }
    }, confirmButton = { if (offer != null && !offer.maxed) Button(onClick = onReview, enabled = enabled && !gated && purchase != null) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(if (testExpansion) "EXPAND" else "EXPAND · ${purchase?.amountLamports?.let(::basePurchaseSol) ?: offer.priceSol ?: "?"} SOL", style = MaterialTheme.typography.labelLarge)
            if (testExpansion) Text("FREE · TEST ONLY", style = MaterialTheme.typography.labelSmall)
        } } },
        dismissButton = { TextButton(onClick = onClose) { Text("CLOSE") } })
}
