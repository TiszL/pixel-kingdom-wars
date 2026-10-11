package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.BattleResultSummary
import gg.pixelkingdomwars.nativeclient.BattleRoster
import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import gg.pixelkingdomwars.nativeclient.network.RaidCreateTarget
import gg.pixelkingdomwars.nativeclient.network.artTierOfLevel
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.army.trainingTroopLabel
import gg.pixelkingdomwars.nativeclient.ui.battle.battleHeroPortrait
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyTileUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleResultV2Ui
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.LootMedalUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.MedalTone
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResultSettlement
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/*
 * The live battle result (result.png / result-defeat.png, army/SPEC.md §7 + "Round 2, part two" + the critic fixes) from
 * the persisted server result only. Nothing here is computed from constants or balances: stars, destruction, Shards and
 * trophies are the result's own fields ([BattleResultSummary]); the army spent is the frozen reservation's counts minus
 * what is still in camp. The result carries no post-battle balances and no campaign first-clear reward, so the
 * readouts stay empty and no third medallion is drawn (ui-army plan decision 7).
 */

/** The door ids the card routes by ([BattleResultV2Actions] callbacks, never a registry row). */
internal val RESULT_DOOR_RETRAIN = FeatureId("result.retrain")
internal val RESULT_DOOR_REPLAY = FeatureId("result.replay")
internal val RESULT_DOOR_NEXT = FeatureId("result.next")
internal val RESULT_DOOR_HOME = FeatureId("result.home")

/** result-defeat.png's hint chip, verbatim. */
internal const val RESULT_DEFEAT_HINT = "REPLAY shows what held them off."
/** The Shards medallion's context after a gain (critic fix: "stores", matching every other frame). */
internal const val RESULT_SHARDS_GAIN = "into your stores"
/** The Shards medallion's context when the server settled none (Round 2 "empty" state). */
internal const val RESULT_SHARDS_NONE = "nothing taken"
/** A medallion's context when the value is withheld or not carried (SPEC §7 LootRow context). */
internal const val RESULT_SETTLED = "Settled by the server"

/**
 * The celebration's state for the result [result] of the raid in [live]. [target] is the create the player asked for
 * (null after a resumed raid: the pending stage then names a campaign); [nextLabel] is the host's NEXT caption.
 * While [busy] every door is BUSY: a door's order is in flight and nothing may be sent twice.
 */
internal fun battleResultV2Ui(result: JsonObject, target: RaidCreateTarget?, nextLabel: String, live: LiveBattleState,
    catalogue: JsonObject?, busy: Boolean): BattleResultV2Ui {
    val summary = BattleResultSummary.read(result)
    val won = summary.won
    val campaign = target is RaidCreateTarget.Campaign || (target == null && live.pending?.stage != null)
    val stage = (target as? RaidCreateTarget.Campaign)?.stage ?: live.pending?.stage
    val name = ((target as? RaidCreateTarget.Pvp)?.name ?: live.pending?.target?.name)?.trim()?.takeIf { it.isNotEmpty() }
    // Stars count only on a victory (the old result panel's rule); the server's figure is capped to the three drawn.
    val stars = if (won) summary.stars?.toBigDecimalOrNull()?.min(3.toBigDecimal())?.toInt()?.coerceIn(0, 3) ?: 0 else 0
    val verdict = buildString {
        append("destroyed")
        when {
            !won -> append(" · ").append(Copy.WALLS_HELD.lowercase())
            campaign -> stage?.let { append(" · Stage ").append(it) }
            else -> name?.let { append(" · vs ").append(it) }
        }
        if (won && summary.keepDestroyed) append(" · ").append(Copy.KEEP_FELL.lowercase())
    }

    val army = live.presentation?.get("armySnapshot") as? JsonObject
    val counts = army?.get("counts") as? JsonObject
    val levels = army?.get("levels") as? JsonObject
    val heroLevels = army?.get("heroLevels") as? JsonObject
    val roster = BattleRoster.read(army)
    fun level(troop: String) = (levels?.get(troop) as? JsonPrimitive)?.intOrNull
    // Spent = the frozen reservation's count minus what is still in camp (accepted and reserved orders are out).
    val spent = roster.troops.mapNotNull { troop ->
        val reserved = (counts?.get(troop) as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
        val sent = reserved - live.available(troop)
        if (sent <= 0) null else troop to sent
    }
    val armySpent = spent.map { (troop, sent) ->
        val lv = level(troop)
        ArmyTileUi(troop, armyPortrait(catalogue, troop, lv), lv?.let { "L$it" } ?: UNKNOWN, sent.toString(),
            "$sent ${trainingTroopLabel(troop)}")
    }
    val heroesUsed = roster.heroes.filter { live.reserved("hero", "hero", it) }.map { hero ->
        battleHeroPortrait(catalogue, hero, (heroLevels?.get(hero) as? JsonPrimitive)?.intOrNull).ifBlank { "shape:unknown" }
    }
    val retrainCount = spent.sumOf { it.second }.takeIf { it > 0 }

    val state = if (busy) CommandState.BUSY else CommandState.ENABLED
    fun door(id: FeatureId, icon: String, caption: String, verb: Verb, primary: Boolean = false) =
        CommandUi(id, icon, caption, null, primary, state, null, null, verb = verb)
    val retrainIcon = armySpent.firstOrNull()?.portrait
        ?: roster.troops.firstOrNull()?.let { armyPortrait(catalogue, it, level(it)) } ?: "plus"
    val keepLevel = (army?.get("attackerKeepLevel") as? JsonPrimitive)?.intOrNull
    val keepTier = keepLevel?.let { lv -> catalogue?.let { artTierOfLevel(it, lv) } } ?: 1
    val raidId = live.pending?.raidId

    return BattleResultV2Ui(
        won = won,
        stars = stars,
        destroyedPct = summary.destruction?.toBigDecimalOrNull()?.toInt()?.coerceIn(0, 100),
        verdict = verdict,
        mode = if (campaign) BattleMode.CAMPAIGN else BattleMode.PVP,
        // live.result is the persisted server result: it is settled, or the server withheld the loot.
        settlement = if (summary.lootRedacted) ResultSettlement.REDACTED else ResultSettlement.SETTLED,
        medallions = listOf(shardsMedal(summary, won), trophyMedal(summary.trophyDelta)),
        readouts = emptyList(),
        armySpent = armySpent,
        heroesUsed = heroesUsed,
        retrain = door(RESULT_DOOR_RETRAIN, retrainIcon, "RETRAIN", Verb.BLUE),
        // The replay is the raid's own; without a raid id there is nothing to point at, so no door (SPEC: null = none).
        replay = raidId?.let { door(RESULT_DOOR_REPLAY, "replay", "REPLAY", Verb.STONE) },
        next = door(RESULT_DOOR_NEXT, "attack", nextLabel, Verb.STONE),
        home = door(RESULT_DOOR_HOME, keepPortrait(keepTier), Copy.HOME, Verb.GREEN, primary = true),
        retrainCount = retrainCount,
        defeatHint = RESULT_DEFEAT_HINT.takeIf { !won },
        replayId = raidId,
    )
}

/** Shards: the server's loot, "0" when it settled none, REDACTED when withheld, "…" when not carried (never 0). Only a
 *  victory's gain counts into the stores with the coin flight (result-defeat.png draws no counting tint). */
private fun shardsMedal(summary: BattleResultSummary, won: Boolean): LootMedalUi {
    val loot = summary.lootShards
    return when {
        summary.lootRedacted -> LootMedalUi("shards", Copy.REDACTED, MedalTone.ZERO, "Shards", RESULT_SETTLED, counting = false)
        loot == null -> LootMedalUi("shards", UNKNOWN, MedalTone.ZERO, "Shards", RESULT_SETTLED, counting = false)
        loot.trimStart('0').isEmpty() -> LootMedalUi("shards", "0", MedalTone.ZERO, "Shards", RESULT_SHARDS_NONE, counting = false)
        else -> LootMedalUi("shards", "+${fmtN(loot)}", MedalTone.GAIN, "Shards", RESULT_SHARDS_GAIN, counting = won)
    }
}

/** Trophies: the server's signed attacker delta ("+18", "−9" counting down in the loss red, "0"); "…" when not carried. */
private fun trophyMedal(delta: String?): LootMedalUi {
    if (delta == null) return LootMedalUi("trophy", UNKNOWN, MedalTone.ZERO, "Trophies", RESULT_SETTLED, counting = false)
    val magnitude = delta.removePrefix("-")
    return when {
        magnitude.trimStart('0').isEmpty() -> LootMedalUi("trophy", "0", MedalTone.ZERO, "Trophies", RESULT_SETTLED, counting = false)
        delta.startsWith("-") -> LootMedalUi("trophy", "−${fmtN(magnitude)}", MedalTone.LOSS, "Trophies", RESULT_SETTLED, counting = false)
        else -> LootMedalUi("trophy", "+${fmtN(magnitude)}", MedalTone.GAIN, "Trophies", RESULT_SETTLED, counting = false)
    }
}
