@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.battle

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import kotlinx.serialization.json.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.CancellationException

/** A replacement revision cannot display an old index while its canonical health ledger is prepared. */
@Composable internal fun rememberBattleHudProgress(scene: BattleScene?, catalogue: JsonObject?): BattleHudProgress? {
    val result = remember(scene?.revision, scene?.base, catalogue) { mutableStateOf<BattleHudProgress?>(null) }
    LaunchedEffect(result) {
        if (scene != null) result.value = withContext(Dispatchers.Default) {
            val context = currentCoroutineContext()
            try { BattleHudProgress(scene, catalogue) { context.ensureActive() } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
        }
    }
    return result.value
}

/** Display-only HP ledger from canonical server damage, matching BattleScene.emitProgress.
 * No local combat stats, damage, projected rewards, or future events enter the HUD. */
internal class BattleHudProgress(scene: BattleScene, catalogue: JsonObject?, checkpoint: () -> Unit = {}) {
    private val health = BuildingHealthVisualModel(scene.base.buildings, scene.revision.events, null, checkpoint)
    private val buildings = if ((catalogue?.get("constants") as? JsonObject)?.get("DEFENSES") is JsonObject)
        scene.base.buildings.filter { building -> building.type?.let { it != "wall" && !isTrapType(requireNotNull(catalogue), it) } == true }
        else emptyList()
    private val stars = scene.revision.events.filter { it.e == "star" }.map { event ->
        event.t to (Json.parseToJsonElement(event.json) as? JsonObject)?.get("n")?.jsonPrimitive?.intOrNull
    }
    /** Attacker bodies on the field per tick (web RaidUI D-106 fight-open band): `deploy` on the attacker's side
     * and `troopSpawn` summons enter, their `troopDeath` leaves. Defender nest spawns and defender heroes never count. */
    data class Field(val deployed: Int, val alive: Int)
    private val field: List<Pair<Int, Field>> = buildList {
        val attackers = mutableSetOf<Int>(); var deployed = 0; var alive = 0
        for (event in scene.revision.events) {
            if (event.e !in setOf("deploy", "troopSpawn", "troopDeath")) continue
            checkpoint()
            val data = Json.parseToJsonElement(event.json) as? JsonObject ?: continue
            val id = data["id"]?.jsonPrimitive?.intOrNull ?: continue
            if (event.e == "troopDeath") { if (!attackers.remove(id)) continue; alive-- }
            else { if (data["side"]?.jsonPrimitive?.contentOrNull == "defender" || !attackers.add(id)) continue; deployed++; alive++ }
            add(event.t to Field(deployed, alive))
        }
    }
    fun fieldAt(tick: Float): Field {
        var low = 0; var high = field.size
        while (low < high) { val middle = (low + high) ushr 1; if (field[middle].first <= tick) low = middle + 1 else high = middle }
        return if (low == 0) Field(0, 0) else field[low - 1].second
    }
    fun at(tick: Float): Pair<Int, Int?> {
        var seen = 0
        for ((at, count) in stars) { if (at > tick) break; seen = count ?: seen + 1 }
        var total = 0.0; var lost = 0.0
        for (building in buildings) {
            val value = health.at(building.id, tick) ?: return seen.coerceIn(0, 3) to null
            total += value.maxHp.toDouble(); lost += (value.maxHp - value.hp).toDouble()
        }
        return seen.coerceIn(0, 3) to if (total > 0) kotlin.math.floor(lost * 100 / total).toInt().coerceIn(0, 100) else null
    }
}

internal fun battleHeroPortrait(catalogue: JsonObject?, hero: String, level: Int?): String {
    val base = when (hero) { "vex" -> "hero_vex_portrait"; "theodor" -> "hero_theo_portrait"; else -> return "" }
    val tier = if (catalogue != null && level != null) artTierOfLevel(catalogue, level) else null
    return if (tier == 4) "${base}_t4" else base
}

internal fun battleTimeLabel(playheadMs: Double, durationMs: Long?): String {
    fun time(ms: Long): String { val seconds = ms.coerceAtLeast(0) / 1000; return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}" }
    val elapsed = playheadMs.toLong().coerceAtLeast(0).let { if (durationMs != null) it.coerceAtMost(durationMs.coerceAtLeast(0)) else it }
    return "${time(elapsed)} / ${durationMs?.let(::time) ?: "—"}"
}

/** Web Pill on the source HUD kit's nine-slice plates: the ink `bar` plate, the gold-framed `keep` plate when
 * active (web's gold active edge), or the solid `gold` plate (ink text) for the one primary action. */
@Composable internal fun BattlePill(modifier: Modifier = Modifier, description: String? = null, active: Boolean = false,
    enabled: Boolean = true, onClick: (() -> Unit)? = null, kind: String = "bar", content: @Composable RowScope.() -> Unit) {
    val semantics = if (description == null) Modifier else Modifier.semantics { contentDescription = description }
    PixelPlate(if (active) "keep" else kind, modifier.heightIn(min = 36.dp).then(semantics).then(if (onClick != null) Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick) else Modifier)) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically, content = content)
    }
}

/** Fixed metric of the HUD hint slot; it scales with the font, never with the text (see [BattleHud]). */
private val HINT_LINE_HEIGHT = 16.sp

@Composable internal fun BattleHud(timer: String, running: Boolean, rate: Int?, stars: Int?, destroyed: Int?, result: JsonObject?,
    target: String?, onEnd: () -> Unit, endEnabled: Boolean, endLabel: String, onRate: (() -> Unit)?, rateEnabled: Boolean,
    modifier: Modifier = Modifier, buffs: @Composable RowScope.() -> Unit = {}, hint: String? = null, cameraControls: SceneCameraControls? = null) {
    var details by remember { mutableStateOf(false) }
    Column(modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            BattlePill(description = "Battle timer: $timer${if (running) " elapsed / maximum" else ""}") {
                GameArt("timer", Modifier.size(20.dp)); Text(timer, fontSize = 18.sp, color = Palette.text)
            }
            BattlePill(description = "${stars?.let { "$it stars" } ?: "Stars unavailable"}, ${destroyed?.toString() ?: "unknown"} percent destroyed") {
                repeat(3) { GameArt("star", Modifier.size(16.dp).alpha(if (stars != null && it < stars) 1f else .25f)) }
                Text("${destroyed?.toString() ?: "—"}%", color = Palette.goldHi, fontSize = 18.sp)
            }
            // The speed toggle names itself (owner 2026-09-17: a bare "1×" was not read as a control).
            rate?.let { BattlePill(description = "Battle speed $it×", enabled = rateEnabled, onClick = onRate, active = it == 2) {
                GameArt("replay", Modifier.size(18.dp)); Text("SPEED $it×", color = if (rateEnabled) Palette.goldHi else Palette.muted, fontSize = 18.sp)
            } }
            BattlePill(onClick = { details = true }, description = "Battle details, buffs and camera") { Text("⋯", color = Palette.text, fontSize = 22.sp) }
            BattlePill(onClick = onEnd, enabled = endEnabled, description = endLabel, kind = "gold") { Text(endLabel, color = Palette.ink, fontSize = 16.sp) }
        }
        // The one hint line sits in a slot whose height never follows its text: a hint that changes or goes
        // blank cannot move the pills or the camera insets (owner 2026-09-17). The live screen keeps the slot
        // for the whole battle, empty (no plate) once the first troop is committed; the spectator HUD has no
        // line and reserves nothing.
        hint?.let {
            val slotHeight = with(LocalDensity.current) { HINT_LINE_HEIGHT.toDp() } + 8.dp
            if (it.isEmpty()) Spacer(Modifier.height(slotHeight)) else PixelPlate("bar", Modifier.height(slotHeight)) {
                Text(it, Modifier.padding(horizontal = 10.dp, vertical = 4.dp), color = Palette.goldHi, fontSize = 13.sp,
                    lineHeight = HINT_LINE_HEIGHT, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    if (details) AlertDialog(onDismissRequest = { details = false }, title = { Text("BATTLE DETAILS") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            target?.let { Text("Target · $it") }
            hint?.takeIf { it.isNotEmpty() }?.let { Text(it) }
            val redacted = result?.flag("lootRedacted") == true
            val loot = result?.string("lootShards")
            Text(if (redacted) "Shard loot withheld" else loot?.let { "Shards looted · ${fmtN(it)}" } ?: "Loot appears after the battle.")
            result?.string("attackerTrophyDelta")?.let { Text("Trophy change · ${if (it.startsWith("-")) "" else "+"}${fmtN(it)}") }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = buffs)
            cameraControls?.let { BattleCameraButtons(it) }
        }
    }, confirmButton = { TextButton(onClick = { details = false }) { Text("DONE") } })
}

@Composable internal fun BattleDeployCard(portrait: String, label: String, count: Int?, selected: Boolean, depleted: Boolean, enabled: Boolean,
    hero: Boolean, shortLandscape: Boolean, desktop: Boolean, onClick: () -> Unit) {
    val width = (if (shortLandscape) 70.dp else if (desktop) 88.dp else 78.dp) * LocalDensity.current.fontScale.coerceAtLeast(1f)
    val height = if (shortLandscape) 64.dp else if (desktop) 88.dp else 78.dp
    val art = if (shortLandscape) 36.dp else if (desktop) 54.dp else 46.dp
    // Web TroopCard on the HUD kit: the gold-framed `keep` plate marks the selection, heroes sit on the `tab` plate.
    PixelPlate(if (selected) "keep" else if (hero) "tab" else "dock", Modifier.width(width).heightIn(min = height).alpha(if (depleted) .45f else 1f)
        .semantics { contentDescription = if (hero) "$label hero, ${if (depleted) "already fighting" else "ready"}" else "$label, $count remaining"; this.selected = selected }
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick)) {
        Box(Modifier.fillMaxWidth().heightIn(min = height).padding(5.dp)) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                GameArt(portrait, Modifier.size(art))
                // A deployed hero keeps its name: the dimmed card is the deployed state (the description says
                // "already fighting"). Swapping in a two-line "IN BATTLE" changed text on a deploy tap and could grow the tray.
                Text(label, Modifier.fillMaxWidth(), color = if (selected || hero) Palette.goldHi else Palette.text,
                    fontSize = 12.sp, lineHeight = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            }
            count?.let { PixelPlate("bar", Modifier.align(Alignment.TopEnd)) { Text("×$it", Modifier.padding(horizontal = 4.dp, vertical = 1.dp), color = Palette.goldHi, fontSize = 18.sp, lineHeight = 18.sp) } }
        }
    }
}

/** A thumb roster and its existing actions float independently; the layout gaps do not block GL. */
@Composable internal fun BattleDeployTray(shortLandscape: Boolean, modifier: Modifier = Modifier,
    cards: @Composable RowScope.() -> Unit, actions: @Composable RowScope.() -> Unit) {
    BoxWithConstraints(modifier) {
        val fontScale = LocalDensity.current.fontScale.coerceAtLeast(1f)
        val actionWidth = 300.dp * fontScale
        // Keep two selectable cards exposed beside readable actions. Larger text
        // moves actions below the roster instead of splitting words into letters.
        val rosterMinimum = 140.dp * fontScale + 6.dp
        if (shortLandscape && maxWidth >= actionWidth + rosterMinimum + 24.dp) Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            PixelPlate("dock-sunk", Modifier.weight(1f)) { Row(Modifier.horizontalScroll(rememberScrollState()).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), content = cards) }
            Row(Modifier.width(actionWidth), horizontalArrangement = Arrangement.spacedBy(6.dp), content = actions)
        } else Column(Modifier.fillMaxWidth().padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PixelPlate("dock-sunk", Modifier.fillMaxWidth()) { Row(Modifier.horizontalScroll(rememberScrollState()).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), content = cards) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), content = actions)
        }
    }
}

/** Camera actions remain reachable in Details when large text leaves no room for a floating rail. */
@Composable internal fun BattleCameraButtons(controls: SceneCameraControls) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = controls::zoomIn, enabled = controls.zoomStep != null) { Text("ZOOM IN") }
        TextButton(onClick = controls::zoomOut, enabled = controls.zoomStep != null) { Text("ZOOM OUT") }
        TextButton(onClick = controls::fit) { Text("FIT FIELD") }
    }
}

/** Measured screen-space chrome; null heights mean the reveal has not laid out its controls yet. */
internal data class BattleCameraRailPlacement(val horizontal: Boolean, val top: Float, val height: Float)
internal fun battleCameraRailPlacement(width: Float, height: Float, hud: Float?, footer: Float?, gap: Float): BattleCameraRailPlacement? {
    if (hud == null || footer == null || listOf(width, height, hud, footer, gap).any { !it.isFinite() || it < 0f }) return null
    val available = height - hud - footer - gap
    if (available < 48f) return null
    val horizontal = width > height * 1.1f && height <= 520f || available < 156f
    val railHeight = if (horizontal) 48f else 156f
    return BattleCameraRailPlacement(horizontal, height - footer - gap - railHeight, railHeight)
}

/** Measure chrome before composing its rail in the same layout pass. Size callbacks remain
 * useful for the scene's camera insets, but can never supply stale rail bounds on relayout. */
@Composable internal fun MeasuredBattleChrome(header: @Composable () -> Unit, footer: @Composable () -> Unit,
    rail: @Composable BoxScope.(Int, Int) -> Unit) {
    SubcomposeLayout(Modifier.fillMaxSize()) { constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val top = subcompose("header", header).single().measure(loose)
        val bottom = subcompose("footer", footer).single().measure(loose)
        val camera = subcompose("rail") { Box(Modifier.fillMaxSize()) { rail(top.height, bottom.height) } }.single().measure(constraints)
        layout(constraints.maxWidth, constraints.maxHeight) {
            top.placeRelative(0, 0)
            bottom.placeRelative(0, constraints.maxHeight - bottom.height)
            camera.placeRelative(0, 0)
        }
    }
}
