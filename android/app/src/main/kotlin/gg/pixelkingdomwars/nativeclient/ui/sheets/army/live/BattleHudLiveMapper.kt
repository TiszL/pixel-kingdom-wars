package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.BattleRoster
import gg.pixelkingdomwars.nativeclient.network.BattlePhase
import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.army.trainingTroopLabel
import gg.pixelkingdomwars.nativeclient.ui.battle.battleHeroPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleHudUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ClockPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.DeckCardUi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** What a tap on a sent hero's card says: the battle has no hero ability owner yet (no endpoint, nothing to send). */
internal const val HERO_ABILITY_NOT_OPEN = "Hero abilities are not open yet."

/** Presentation only: the frozen reservation, canonical playhead and existing latched progress own all facts.
 * The target plate keeps "Lv …", the unknown crest and no loot line: the pending target (`PendingRaidTarget`) carries a
 * name only, so level, league and lootable Shards have no source here and are never guessed. */
internal fun liveBattleHudUi(live: LiveBattleState, catalogue: JsonObject?, selection: Pair<String, String>?,
    deploymentAllowed: Boolean, playheadMs: Double, durationMs: Long?, stagingClock: String,
    stars: Int?, destructionPct: Int?, hint: String?, endText: String, endEnabled: Boolean): BattleHudUi {
    val army = live.presentation?.get("armySnapshot") as? JsonObject
    val levels = army?.get("levels") as? JsonObject
    val heroLevels = army?.get("heroLevels") as? JsonObject
    val roster = BattleRoster.read(army)
    val allowed = deploymentAllowed && live.connected && !live.blocked && !live.terminal
    val deck = roster.troops.map { troop ->
        val count = live.available(troop)
        DeckCardUi("deploy:$troop", trainingTroopLabel(troop),
            armyPortrait(catalogue, troop, (levels?.get(troop) as? JsonPrimitive)?.intOrNull), count,
            enabled = allowed && count > 0)
    } + roster.heroes.map { hero ->
        val sent = live.reserved("hero", "hero", hero)
        DeckCardUi("hero:$hero", trainingTroopLabel(hero),
            battleHeroPortrait(catalogue, hero, (heroLevels?.get(hero) as? JsonPrimitive)?.intOrNull).ifBlank { "shape:unknown" },
            null, isHero = true, heroSent = sent, enabled = allowed && !sent,
            abilitySupported = false, statusText = if (sent) "SENT" else null,
            // No ability endpoint exists for this raid owner: the sent card says so instead of going silent.
            refusal = if (sent) HERO_ABILITY_NOT_OPEN else null)
    }
    val remaining = durationMs?.takeIf { it >= 0 && playheadMs.isFinite() }
        ?.let { (it.toDouble() - playheadMs.coerceAtLeast(0.0)).coerceAtLeast(0.0).toLong() }
    val clock = if (live.phase == BattlePhase.STAGING) stagingClock.takeIf { it.matches(Regex("[0-9]+:[0-5][0-9]")) }
        else remaining?.let { val seconds = it / 1000; "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}" }
    return BattleHudUi(
        targetName = live.pending?.stage?.let { "STAGE $it" } ?: live.pending?.target?.name?.takeIf { it.isNotBlank() } ?: "Kingdom",
        targetLevel = "Lv …", leagueCrest = "shape:unknown", lootLeft = null,
        clock = clock, clockPhase = when {
            live.phase == BattlePhase.STAGING -> ClockPhase.SCOUT
            live.phase == BattlePhase.RUNNING && remaining != null && remaining < 30_000 -> ClockPhase.LAST_30
            else -> ClockPhase.FIGHT
        }, stars = stars, destructionPct = destructionPct, deck = deck,
        selected = selection?.takeIf(roster::contains)?.let { "${it.first}:${it.second}" },
        showHint = !hint.isNullOrBlank(), hint = hint.orEmpty(), showDeployLine = false,
        // The existing repository owns retreat and its confirmation, including staging. No free-leave inference.
        canLeaveFree = false, endEnabled = endEnabled, endText = endText)
}

/** Resolve only IDs from this raid's frozen roster; display labels are never routing keys. */
internal fun liveBattleHudSelection(live: LiveBattleState, id: String): Pair<String, String>? {
    val roster = BattleRoster.read(live.presentation?.get("armySnapshot"))
    return roster.troops.firstOrNull { "deploy:$it" == id }?.let { "deploy" to it }
        ?: roster.heroes.firstOrNull { "hero:$it" == id }?.let { "hero" to it }
}
