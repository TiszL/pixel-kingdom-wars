package gg.pixelkingdomwars.nativeclient.ui.more

import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.QuestBonusUi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Where each quest's GO goes (hub SPEC §2.3: "in progress: GoButton → the quest's place"). Before this, only the six
 * tutorial templates had a door, so every daily quest in progress was drawn LOCKED with "This quest destination is not
 * connected yet" (a padlock on almost every row; owner 2026-10-06 "UI unfinished"). The server's daily pool
 * (`QUESTS.dailyTemplates`, constants.ts) is grouped by the place where its progress is earned; the template ids are
 * frozen server keys, so a prefix rule keeps new templates of the same family routed. Navigation only: a door never
 * claims, signs or pays.
 */
internal object QuestDoorIds {
    /** The raid chooser (MATCH): every PvP raid, deploy, steal, star and scout quest. */
    const val RAID = "hud.attack"
    const val CAMPAIGN = "raid.campaign"
    const val BUILD = "hud.build"
    const val TRAIN = "barracks.train"
    const val LAND = "profile.land"
    /** The base's first Mine, selected (the same id the Home herald uses). */
    const val MINE = "mine.collect"
    /** The Gold Forge, selected ("Smelt Shards in the Gold Forge"). */
    const val FORGE = "goldforge.smelt"
    /** Back to the base itself: the DAILY edge button and the obstacles live there. */
    const val HOME = "home.base"
}

private val CAMPAIGN_CODES = setOf("first_raid", "clear_ruined_keep", "clear_2_keeps", "clear_5_keeps")
private val BUILD_CODES = setOf("first_camp", "first_mine", "first_barracks", "defend_success")
private val RAID_CODES = setOf("raid_3_times", "two_keg_runners", "all_3_buffs", "vault_buster", "hero_untouched")
private val RAID_PREFIXES = listOf("win_", "steal_", "use_", "deploy_", "earn_", "scout_")

/** The door id for [templateCode], or null for a template this client does not know (it stays LOCKED, never guessed). */
internal fun questDoorId(templateCode: String): String? = when {
    templateCode == "first_land" -> QuestDoorIds.LAND
    templateCode == "first_troops" || templateCode.startsWith("train_") -> QuestDoorIds.TRAIN
    templateCode in CAMPAIGN_CODES || templateCode.startsWith("campaign_") -> QuestDoorIds.CAMPAIGN
    templateCode == "collect_mines" || templateCode == "collect_1000_mined" -> QuestDoorIds.MINE
    templateCode == "forge_smelt" -> QuestDoorIds.FORGE
    templateCode == "claim_daily_cache" || templateCode == "clear_obstacle" -> QuestDoorIds.HOME
    templateCode in BUILD_CODES || templateCode.startsWith("upgrade_") || templateCode.startsWith("place_") ||
        templateCode.startsWith("spend_") -> QuestDoorIds.BUILD
    templateCode in RAID_CODES || RAID_PREFIXES.any { templateCode.startsWith(it) } -> QuestDoorIds.RAID
    else -> null
}

/** The place's icon for the quest's light Well (quests.png: swords for raids, Shards for mines, a troop for training). */
internal fun questDoorIcon(templateCode: String): String? = when (questDoorId(templateCode)) {
    QuestDoorIds.RAID -> "attack"
    QuestDoorIds.CAMPAIGN -> "star"
    QuestDoorIds.BUILD -> "shape:hammer"
    QuestDoorIds.TRAIN -> "ui_portrait_highlander_t2"
    QuestDoorIds.LAND -> "map"
    QuestDoorIds.MINE -> "shards"
    QuestDoorIds.FORGE -> "keep"
    QuestDoorIds.HOME -> if (templateCode == "claim_daily_cache") "shards" else "shape:hammer"
    else -> null
}

/** Every quest on [board] with a known door, keyed by template code (the mapper's `destinations`). */
internal fun questDoorLinks(board: QuestBoard?): Map<String, HubLink> =
    board?.quests.orEmpty().mapNotNull { quest -> questDoorId(quest.templateCode)?.let { quest.templateCode to HubLink(FeatureId(it)) } }.toMap()

/** Every quest on [board] with a known place icon, keyed by template code (the mapper's `icons`). */
internal fun questDoorIcons(board: QuestBoard?): Map<String, String> =
    board?.quests.orEmpty().mapNotNull { quest -> questDoorIcon(quest.templateCode)?.let { quest.templateCode to it } }.toMap()

/** The catalogue's `QUESTS.dailyBonusAt` (constants.ts: the bonus pays when this many dailies are claimed in one UTC
 *  day); null when the pack does not carry it. Never a Kotlin copy of the number. */
internal fun questBonusTarget(catalogue: JsonObject?): Int? =
    (((catalogue?.get("constants") as? JsonObject)?.get("QUESTS") as? JsonObject)?.get("dailyBonusAt") as? JsonPrimitive)
        ?.content?.toIntOrNull()?.takeIf { it > 0 }

/**
 * The DAILY BONUS card (quests.png "DAILY BONUS 4/6" + pips + shard pill): the dailies the server says are claimed
 * today, out of the catalogue's [target], and the server's own `allThreeBonus` pill. Unknown parts stay unknown ("…",
 * no pips); a count is never invented. The reset line stays hidden: the board carries no reset time.
 */
internal fun questBonusUi(board: QuestBoard?, target: Int?): QuestBonusUi {
    val claimed = board?.quests?.count { it.scope == "daily" && it.claimed }
    val reward = board?.allThreeBonus?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }?.let {
        PriceUi(Currency.SHARDS, groupedAmount(it), if (it == "0") PriceStatus.SERVER_ZERO else PriceStatus.OK)
    }
    return QuestBonusUi(if (target != null && claimed != null) minOf(claimed, target) else null, target, reward, null)
}
