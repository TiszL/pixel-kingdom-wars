package gg.pixelkingdomwars.nativeclient.ui.attack

import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.network.RaidCreateTarget
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.fmtN
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.math.BigDecimal

/** Where a RAID chooser row sends you (web RaidChooser.tsx `RaidChoiceId`). `preview` = a look, not a target picker. */
data class RaidChoice(val id: String, val title: String, val sub: String, val gold: Boolean = false, val preview: Boolean = false)

/** THE GATE, as data (web `raidChoices`): the landowner branch is production's three rows to the byte; the deedless
 * branch leads with CAMPAIGN because the landless pool starts empty, and never offers a target-picking affordance. */
fun raidChoices(landOwned: Boolean, onboarding: Boolean = false): List<RaidChoice> {
    if (landOwned && !onboarding) return listOf(
        RaidChoice("auto", "FIND ME A TARGET", "Auto-match a base near your trophies — the fastest fight.", gold = true),
        RaidChoice("map", "WORLD MAP", "Pick any base on the globe and scout it first — distance never matters."),
        RaidChoice("campaign", "CAMPAIGN", "Single-player stages. Free, no energy, your base is never at risk."),
    )
    return listOf(
        RaidChoice("campaign", "CAMPAIGN", "Single-player stages, always open. Free, no energy, your base is never at risk.", gold = true),
        RaidChoice("auto", "FIND ME A TARGET", if (landOwned) "Auto-match a base near your trophies." else "Auto-match another landless keep — your only PvP yet, and only when there is one free to fight."),
        RaidChoice("map", if (landOwned) "WORLD MAP" else "WORLD MAP — LOOK ONLY", preview = !landOwned,
            sub = if (landOwned) "Pick a base on the globe and scout it first." else "Look at a region you own no parcel in. Buying land deeds you a parcel of your own, puts you on the map, and lets you choose and scout targets."),
    )
}

/** Web `pvpAttackShardCostForKeepLevel`, read from the catalogue's `PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL` table: the
 * attacker's Keep level clamped to the table. Null when the pack lacks the table (the chooser then fails closed). */
fun pvpAttackShardCost(constants: JsonObject?, keepLevel: Int?): String? {
    val table = constants?.get("PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL") as? JsonArray ?: return null
    if (table.isEmpty() || keepLevel == null) return null
    val index = keepLevel.coerceIn(1, table.size) - 1
    return (table[index] as? JsonPrimitive)?.contentOrNull
}
/** Web `raidEntryCostLabel`: "1 ENERGY + N SHARDS" with `RAID_ENERGY.perRaid` from the catalogue; '—' for an unknown Keep. */
fun raidEntryCostLabel(constants: JsonObject?, keepLevel: Int?): String? {
    val perRaid = (constants?.get("RAID_ENERGY") as? JsonObject)?.string("perRaid") ?: return null
    val shards = pvpAttackShardCost(constants, keepLevel)
    if (keepLevel != null && shards == null) return null
    return "$perRaid ENERGY + ${shards?.let(::fmtN) ?: "—"} SHARDS"
}

/** Web `revengeTarget` (raidlog.tsx): a PvP defence row offers the counter-attack as EXACTLY the map's target, so
 * the server's createRaid stays the only attackability gate. PvE and campaign have no player to avenge. */
fun revengeTarget(row: BattleRecord): RaidCreateTarget.Pvp? {
    if (row.role != "defender" || row.mode != "pvp") return null
    val opponent = row.opponent ?: return null
    return RaidCreateTarget.Pvp(defenderWallet = opponent.wallet, defenderBaseId = opponent.baseId?.takeIf { it.isNotEmpty() }, name = opponent.name.takeIf { it.isNotEmpty() })
}
/** Web `revengeLabel`: inside `RAID_RULES.revengeLockHours` the server treats the counter-attack as revenge; after
 * that it is an ordinary attack and the button says so. Null when the pack lacks the rule. */
fun revengeLabel(row: BattleRecord, constants: JsonObject?, nowMs: Long): String? {
    val hours = (constants?.get("RAID_RULES") as? JsonObject)?.string("revengeLockHours")?.toLongOrNull() ?: return null
    val created = row.createdAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return "ATTACK BACK"
    return if (nowMs - created > hours * 3_600_000) "ATTACK BACK" else "REVENGE"
}
/** Web `settledLootLabel`: exact integer text (a deed can outlive the safe-integer range); redaction is deliberate. */
fun settledLootLabel(row: BattleRecord): String {
    if (row.lootRedacted || row.settledAmount == null) return "LOOT REDACTED"
    val value = row.settledAmount ?: row.lootDeltaShards ?: "0"
    val prefix = if (value.startsWith("-") || value == "0") "" else "+"
    return "$prefix${fmtN(value)} ${row.settledCurrency ?: "SHARDS"}"
}
fun shortWallet(wallet: String): String = if (wallet.length > 10) "${wallet.take(4)}…${wallet.takeLast(4)}" else wallet
/** Web `battleAttacker`: every row names the actual attacker, not merely an ambiguous "opponent". */
fun battleAttacker(row: BattleRecord): Pair<String, Boolean> {
    if (row.role == "attacker") return "YOU" to false
    val opponent = row.opponent ?: return "UNKNOWN" to false
    return (opponent.name.ifEmpty { shortWallet(opponent.wallet) }) to opponent.seeker
}
fun opponentLabel(row: BattleRecord): String = row.opponent?.let { it.name.ifEmpty { shortWallet(it.wallet) } } ?: row.opponentLabel ?: "UNKNOWN OPPONENT"
/** Web `relTime`: relative, uppercase, from raid createdAt. */
fun relTime(iso: String?, nowMs: Long): String {
    val created = iso?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return "JUST NOW"
    val ms = nowMs - created
    if (ms < 60_000) return "JUST NOW"
    val min = ms / 60_000; if (min < 60) return "${min}M AGO"
    val hr = min / 60; if (hr < 24) return "${hr}H AGO"
    return "${hr / 24}D AGO"
}
/** Web results.tsx: a raid is a victory when it earned at least one star. */
fun raidWon(stars: String?): Boolean = (stars?.toBigDecimalOrNull() ?: BigDecimal.ZERO) > BigDecimal.ZERO
