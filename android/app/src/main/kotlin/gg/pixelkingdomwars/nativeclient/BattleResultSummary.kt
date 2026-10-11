package gg.pixelkingdomwars.nativeclient

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.attack.raidWon
import kotlinx.serialization.json.*

/** Only the persisted server result supplies these values. Missing historical
 * rewards are unknown; this view never infers a credit from stars or balances. */
internal data class BattleResultSummary(
    val stars: String?,
    val destruction: String?,
    val lootShards: String?,
    val lootRedacted: Boolean,
    val trophyDelta: String?,
    val retreated: Boolean,
    val keepDestroyed: Boolean = false,
) {
    /** Web results.tsx: VICTORY when the raid earned at least one star. */
    val won: Boolean get() = raidWon(stars)
    companion object {
        fun read(result: JsonObject): BattleResultSummary {
            fun decimal(key: String, signed: Boolean = false): String? {
                val value=(result[key] as? JsonPrimitive)?.contentOrNull ?: return null
                val pattern=if(signed) Regex("-?[0-9]+") else Regex("[0-9]+")
                return value.takeIf(pattern::matches)
            }
            val redacted=(result["lootRedacted"] as? JsonPrimitive)?.booleanOrNull==true
            val percent=(result["destructionPct"] as? JsonPrimitive)?.contentOrNull
                ?.takeIf { Regex("[0-9]+(?:\\.[0-9]+)?").matches(it) }
            return BattleResultSummary(decimal("stars"),percent,
                if(redacted) null else decimal("lootShards"),redacted,
                decimal("attackerTrophyDelta",signed=true),
                (result["retreated"] as? JsonPrimitive)?.booleanOrNull==true,
                (result["keepDestroyed"] as? JsonPrimitive)?.booleanOrNull==true)
        }
    }
}

/** The compact card a spectator or history reader sees; the attacker's verdict is [RaidResultPanel]. */
@Composable internal fun BattleResultCard(result: JsonObject) {
    val summary=BattleResultSummary.read(result)
    Card(Modifier.fillMaxWidth().padding(horizontal=12.dp,vertical=8.dp)) {
        Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(4.dp)) {
            Text(if(summary.retreated) "Retreated" else "Battle complete",style=MaterialTheme.typography.titleLarge)
            Text("${summary.stars ?: "—"} stars · ${summary.destruction ?: "—"}% destruction")
            Text(when {
                summary.lootRedacted -> "Raid loot: redacted"
                summary.lootShards!=null -> "Raid loot: ${summary.lootShards} SHARDS"
                else -> "Raid loot: unavailable"
            },style=MaterialTheme.typography.titleMedium)
            summary.trophyDelta?.let { Text("Trophies: ${if(it!="0" && !it.startsWith("-")) "+" else ""}$it") }
        }
    }
}

/** Web results.tsx VICTORY / DEFEAT modals. The numbers come from the resolved raid, never hardcoded; KEEP EARNED and
 * SHARDS LOST stay hidden exactly as on the web because the result DTO does not carry them. [nextLabel] is NEXT RAID
 * for PvP, NEXT STAGE / CAMPAIGN MAP for a campaign; [homePrimary] makes HOME gold during the first-raid onboarding. */
@Composable internal fun RaidResultPanel(result: JsonObject, nextLabel: String, homePrimary: Boolean, busy: Boolean,
                                         onHome: () -> Unit, onNext: () -> Unit, onTrain: () -> Unit, onRaidLog: () -> Unit,
                                         presentation: gg.pixelkingdomwars.nativeclient.ui.battle.LiveResultUi?=null) {
    val summary = BattleResultSummary.read(result)
    val stars = summary.stars?.toIntOrNull() ?: 0
    Dialog(onDismissRequest = { if (!busy) onHome() }, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false)) {
    PixelPanel(Modifier.padding(16.dp).widthIn(max = 420.dp).fillMaxWidth()) {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            PixelPlate("bar", Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp)) {
                Text(if (summary.won) Copy.VICTORY else Copy.DEFEAT, fontSize = 32.sp, letterSpacing = 6.sp,
                    textAlign = TextAlign.Center, color = if (summary.won) Palette.goldHi else Palette.textFaint, modifier = Modifier.fillMaxWidth())
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(7.dp)) {
            if(presentation?.art!=null)gg.pixelkingdomwars.nativeclient.ui.battle.ResultStarRow(presentation,if(summary.won)stars else 0)
            else Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterHorizontally)) {
                repeat(3) { index -> GameArt("star", Modifier.size(48.dp).offset(y = if (index == 1) (-10).dp else 0.dp).alpha(if (summary.won && index < stars) 1f else .25f), "${if (summary.won && index < stars) "Earned" else "Empty"} star") }
            }
            presentation?.error?.let { Text(it,color=Palette.muted) }
            Text(if (summary.won) "${summary.destruction ?: "—"}% DESTROYED${if (summary.keepDestroyed) " · ${Copy.KEEP_FELL}" else ""}"
                else "${summary.destruction ?: "—"}% DESTROYED · ${Copy.WALLS_HELD}", color = Palette.textFaint, fontSize = 18.sp, textAlign = TextAlign.Center)
            if (summary.won) PixelPlate("shard", Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 7.dp)) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt("shard", Modifier.size(22.dp)); Text(Copy.SHARDS_LOOTED, Modifier.weight(1f)); Text(if (summary.lootRedacted) Copy.REDACTED else fmtN(summary.lootShards ?: "0"), color = if (summary.lootRedacted) Palette.muted else Palette.gold, fontWeight = FontWeight.Bold)
            }
            }
            PixelPlate("shard", Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 7.dp)) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt("trophy", Modifier.size(22.dp)); Text(Copy.TROPHIES, Modifier.weight(1f))
                val delta = summary.trophyDelta ?: "0"
                Text(if (summary.won && !delta.startsWith("-")) "+$delta" else delta, color = if (summary.won) Palette.gold else MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold)
            }
            }
            if (!summary.won) TextButton(onClick = onRaidLog, enabled = !busy) { Text("${Copy.REPLAY_SAVED} · OPEN ›") }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (summary.won) {
                    if (homePrimary) Button(onClick = onHome, enabled = !busy, modifier = Modifier.weight(1f)) { Text(Copy.HOME) }
                    else OutlinedButton(onClick = onHome, enabled = !busy, modifier = Modifier.weight(1f)) { Text(Copy.HOME) }
                    if (homePrimary) OutlinedButton(onClick = onNext, enabled = !busy, modifier = Modifier.weight(1f)) { Text(nextLabel) }
                    else Button(onClick = onNext, enabled = !busy, modifier = Modifier.weight(1f)) { Text(nextLabel) }
                } else {
                    OutlinedButton(onClick = onHome, enabled = !busy, modifier = Modifier.weight(1f)) { Text(Copy.HOME) }
                    Button(onClick = onRaidLog, enabled = !busy, modifier = Modifier.weight(1f)) { Text(Copy.RAID_LOG) }
                }
            }
            OutlinedButton(onClick = onTrain, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(Copy.TRAIN_ARMY) }
            }
        }
    }
    }
}
