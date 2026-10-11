package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.BattleHistoryState
import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.attack.opponentLabel
import gg.pixelkingdomwars.nativeclient.ui.attack.relTime
import gg.pixelkingdomwars.nativeclient.ui.attack.revengeLabel
import gg.pixelkingdomwars.nativeclient.ui.attack.revengeTarget
import gg.pixelkingdomwars.nativeclient.ui.attack.settledLootLabel
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.*
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull

/** These are presentation keys, not replay routes. Resolve back to the original record before every callback. */
internal fun battleLogRowId(row: BattleRecord): String = "${row.replayAccess.orEmpty()}:${row.baseId.orEmpty()}:${row.raidId}"

internal fun battleLogRecord(history: BattleHistoryState, id: String): BattleRecord? =
    (history.deed + history.participant).firstOrNull { battleLogRowId(it) == id }

/** A stale deed must not lend either its rows or its unfinished march to a newly selected base. */
internal fun currentBattleHistory(history: BattleHistoryState, selectedBaseId: String?): BattleHistoryState =
    history.takeIf { it.baseId == selectedBaseId } ?: BattleHistoryState(baseId = selectedBaseId, loading = true)

internal fun battleLogShield(raw: JsonObject?): ShieldUi {
    if (raw == null || !raw.containsKey("shield")) return ShieldUi(false, null, "Shield information is unavailable.", UNKNOWN)
    if (raw["shield"] == JsonNull) return ShieldUi(false, null, "No active shield.", "none now")
    val shield = raw["shield"] as? JsonObject ?: return ShieldUi(false, null, "Shield information is unavailable.", UNKNOWN)
    val ms = shield.string("remainingMs")?.toBigDecimalOrNull()
        ?: shield.string("hoursLeft")?.toBigDecimalOrNull()?.multiply(BigDecimal(3_600_000))
    val seconds = ms?.let { runCatching { it.divide(BigDecimal(1_000), 0, RoundingMode.CEILING).longValueExact() }.getOrNull() }
    if (shield.string("suppressedByWarzone") == "true") return ShieldUi(false, seconds?.let(::fmtDur), "Shield is suppressed by the warzone.", "suppressed")
    if (seconds == null) return ShieldUi(false, null, "Shield information is unavailable.", UNKNOWN)
    if (seconds <= 0) return ShieldUi(false, null, "No active shield.", "none now")
    // defence-log.png's first sentence only: what a shield is. "Attacking ends it." is a rule the server has not
    // confirmed to this client (the same reason the REVENGE footer omits its shield sentence).
    return ShieldUi(true, fmtDur(seconds), "No one can raid you while it lasts.")
}

/** The EmptyState doors of the DEFENCE tab, routed by [BattleLogLiveHost]. */
internal val LOG_GO_WALLS = FeatureId("focus.wall")
internal val LOG_GO_LAND = FeatureId("land.open")

private fun rowTime(row: BattleRecord, nowMs: Long): String =
    if (row.createdAt?.let { runCatching { Instant.parse(it) }.getOrNull() } == null) UNKNOWN else relTime(row.createdAt, nowMs).lowercase()

/** No keep tier, clan, army, trophies, unseen or answered facts exist in BattleRecord. Never synthesize them. */
internal fun defenceLiveRow(row: BattleRecord, constants: JsonObject?, nowMs: Long, busyId: String? = null): DefenceEntryUi {
    val target = revengeTarget(row)
    val label = target?.let { revengeLabel(row, constants, nowMs) }
    val revenge = when (label) { "REVENGE" -> RevengeState.AVAILABLE; "ATTACK BACK" -> RevengeState.ATTACK_BACK; else -> RevengeState.UNAVAILABLE }
    val redacted = row.lootRedacted || row.settledAmount == null
    val amount = row.settledAmount?.takeIf { it.matches(Regex("-?(0|[1-9][0-9]*)")) }
    val pct = row.destructionPct?.toBigDecimalOrNull()?.takeIf { it >= BigDecimal.ZERO && it <= BigDecimal(100) }
    return DefenceEntryUi(
        id = battleLogRowId(row), attacker = opponentLabel(row), portrait = "shield", clanTag = null,
        seeker = row.opponent?.seeker == true, ago = rowTime(row, nowMs),
        outcome = if (row.result == "victory") Outcome.HELD else Outcome.LOST,
        stars = (row.stars ?: 0).coerceIn(0, 3), destructionPct = pct?.toInt() ?: 0,
        lootLost = if (redacted) null else amount?.let(::fmtN), lootRedacted = redacted,
        trophyDelta = UNKNOWN, army = emptyList(), replayId = battleLogRowId(row), revenge = revenge, unseen = false,
        action = if (busyId == battleLogRowId(row)) RowActionState.BUSY else RowActionState.IDLE,
        unavailableNote = if (target == null) "No player target for this raid." else if (label == null) "Revenge rules are unavailable." else null,
        outcomeKnown = row.result == "victory" || row.result == "defeat",
        starsKnown = row.stars?.let { it in 0..3 } == true,
        destructionLabel = pct?.stripTrailingZeros()?.toPlainString() ?: UNKNOWN,
        lootIcon = if (row.settledCurrency.equals("KEEP", ignoreCase = true)) "keep" else "shards",
    )
}

/** The DEFENCE tab's empty state (defence-log.png states): landless = the locked state; no deed selected = the existing
 *  copy; otherwise "No raids on you yet. Your walls are waiting.". A GO is drawn only when the host has that door
 *  ([wallsDoor] / [landDoor]); a button that could do nothing is never drawn. */
internal fun defenceEmptyState(history: BattleHistoryState, landless: Boolean, wallsDoor: Boolean, landDoor: Boolean): EmptyStateUi = when {
    landless -> EmptyStateUi("shield", "Claim land to be raided and to raid back", "",
        if (landDoor) "GO" else null, if (landDoor) LOG_GO_LAND else null)
    history.stable && !history.deedSelected -> EmptyStateUi("shield", "No deed selected.", "Choose your kingdom to see its defence history.", null, null)
    else -> EmptyStateUi("shield", "No raids on you yet.", "Your walls are waiting.",
        if (wallsDoor) "GO TO WALLS" else null, if (wallsDoor) LOG_GO_WALLS else null)
}

internal fun battleLogLiveUi(tab: String, history: BattleHistoryState, home: BaseState?, constants: JsonObject?, nowMs: Long,
    busy: Boolean, actionsAllowed: Boolean, busyId: String? = null, live: LiveDefenceUi? = null,
    landless: Boolean = false, wallsDoor: Boolean = false, landDoor: Boolean = false): BattleLogUi = BattleLogUi(
    tab = tab, shield = battleLogShield(home?.base?.raw), live = live,
    defences = history.deed.filter { it.role == "defender" }.map { defenceLiveRow(it, constants, nowMs, busyId) },
    attacks = history.deed.filter { it.role == "attacker" }.map { attackLiveRow(it, nowMs) },
    loading = history.loading, error = history.error,
    empty = defenceEmptyState(history, landless, wallsDoor, landDoor),
    windowCount = history.deed.count { it.role == "defender" }.takeUnless { history.loading },
    sectionTitle = if (history.stable) "SELECTED DEED" else "DEFENCE HISTORY",
    revengeGate = raidRevengeLiveUi(history, home, constants, nowMs, busy, actionsAllowed).gate,
    actionsEnabled = !busy,
)

/** The RECENT RAIDS loot words of raid.png: "LOOT REDACTED" verbatim, "defeat" for a lost raid that settled nothing,
 *  otherwise the exact signed settled amount with "Shards" in sentence case ("+8,200 Shards"); other currencies as sent. */
internal fun attackLootLabel(row: BattleRecord): String {
    val label = settledLootLabel(row)
    if (label == "LOOT REDACTED") return label
    if (row.result == "defeat" && row.settledAmount?.toBigDecimalOrNull()?.signum() == 0) return "defeat"
    return if (label.endsWith(" SHARDS")) label.removeSuffix(" SHARDS") + " Shards" else label
}

/** The trophy change is not in BattleRecord: it stays UNKNOWN and the rows omit it (never "0", never "…" forever). */
internal fun attackLiveRow(row: BattleRecord, nowMs: Long): RaidRecordUi =
    RaidRecordUi(battleLogRowId(row), opponentLabel(row), rowTime(row, nowMs), (row.stars ?: 0).coerceIn(0, 3),
        attackLootLabel(row), UNKNOWN, battleLogRowId(row), starsKnown = row.stars?.let { it in 0..3 } == true)

/** REVENGE uses the existing rule gate and exact catalogue energy cost; mutation eligibility remains server-owned. */
internal fun raidRevengeLiveUi(history: BattleHistoryState, home: BaseState?, constants: JsonObject?, nowMs: Long,
    busy: Boolean, actionsAllowed: Boolean, busyId: String? = null): RaidRevengeUi {
    val energy = home?.base?.energy
    val free = energy?.free
    val army = home?.base?.armyStatus
    val amount = (constants?.get("RAID_ENERGY") as? JsonObject)?.string("perRaid")
        ?.takeIf { it.matches(Regex("[1-9][0-9]*")) }
    val status = when {
        amount == null -> PriceStatus.UNAVAILABLE
        free == null || free < 0 -> PriceStatus.CHECKING
        free.toBigInteger() < amount.toBigInteger() -> PriceStatus.SHORT
        else -> PriceStatus.OK
    }
    val gate = when {
        busy -> "An action is in progress."
        !actionsAllowed -> ordersBlockedReason(true, false)
        history.pending.isNotEmpty() -> "Resume your unfinished march first."
        army?.readyTroopCount == 0 -> "No troops ready"
        status == PriceStatus.UNAVAILABLE -> "Energy cost unavailable."
        status == PriceStatus.CHECKING -> "Energy is still loading."
        status == PriceStatus.SHORT -> "Energy ${energy?.free} · not enough for this raid."
        army == null -> "Army information is still loading."
        else -> null
    }
    return RaidRevengeUi(
        rows = history.deed.filter { revengeTarget(it) != null }.map { defenceLiveRow(it, constants, nowMs, busyId) },
        energy = EnergyUi(energy?.free, energy?.max, null),
        energyPrice = amount?.let { PriceUi(Currency.ITEM, it, status, icon = "energy", description = "$it energy") },
        gate = gate, armyEmpty = army?.readyTroopCount == 0,
        // §6 / R2.2 copy when the history read and holds no raid on this deed at all; if raids exist but none can be
        // answered (campaign, PvE, no player target), or the read failed, "Your walls held." would be untrue.
        empty = EmptyStateUi("shield", "No one to answer.",
            if (history.error == null && history.deed.none { it.role == "defender" }) "Your walls held." else "No answerable defences in the loaded history.", null, null),
        loading = history.loading, shieldDropsOnAttack = false,
    )
}
