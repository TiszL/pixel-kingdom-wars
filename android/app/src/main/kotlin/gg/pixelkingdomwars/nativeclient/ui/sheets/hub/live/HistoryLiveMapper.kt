package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.SavedGemsBuy
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptFamily
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptRow
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptSource
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryDetailUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryFieldUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryGroupUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * History (design/final/hub/history.png, SPEC §2.8): history only, never new work. No aggregate history endpoint exists,
 * so this projects what the existing owners already retain: the Workshop, refining, Berth starter fleet, Lodge starter
 * expedition and Harvester journals and views ([gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptRows]), the
 * saved mail claim and the saved Gems requests. Nothing here reads, submits or retries.
 *
 * - NEEDS YOU: every saved original that is still the owner's current operation (PENDING), every saved mail claim and
 *   every saved Gems request. Money moved is money honoured: these rows show under every filter and every load state
 *   until the owner archives them as final, and OPEN leads to the owning building's recovery.
 * - Day groups: archived originals and server observations, filtered by the chip, grouped TODAY / YESTERDAY / EARLIER
 *   by when they happened.
 * - Copy never says receipt or transaction (DS §9).
 * A family with no retained journal draws nothing: the card shows its designed empty state, never an invented row.
 */

internal const val HISTORY_ALL = "ALL"
internal const val HISTORY_GOLDFORGE = "GOLDFORGE"
internal const val HISTORY_WORKSHOP = "WORKSHOP"
internal const val HISTORY_LODGE = "LODGE"
internal const val HISTORY_BERTH = "BERTH"

/** The chip ids, in strip order, ALL first. Only the places whose retained history this card projects get a chip: the
 * design's MARKET, ISLANDS and PURCHASES have no projected journal here yet, so they are not drawn (an always-empty chip
 * would tell a trader "Nothing here yet" about trades that exist). */
internal val HISTORY_FILTERS: Set<String> = linkedSetOf(HISTORY_ALL, HISTORY_GOLDFORGE, HISTORY_WORKSHOP, HISTORY_LODGE, HISTORY_BERTH)

/** The only doors NEEDS YOU › OPEN emits: each owning building's recovery state. */
internal val HISTORY_RECOVERY_DOORS: Set<String> =
    setOf("workshop.craft", "refining.open", "harvester.harvest", "berth.fleet", "lodge.expedition", "hud.mail", "goldforge.gems")

/** The chip a `Destination.WalletHistory(home)` opens on. "all" and every home without a chip here ("market", "islands",
 * "purchases", anything unknown) open ALL. A chip id passed back in maps to itself. */
internal fun historyFilterFor(home: String): String = when (home.trim().lowercase(Locale.ROOT).replace(" ", "").replace("_", "")) {
    "goldforge" -> HISTORY_GOLDFORGE
    "workshop" -> HISTORY_WORKSHOP
    "lodge" -> HISTORY_LODGE
    "berth" -> HISTORY_BERTH
    else -> HISTORY_ALL
}

/** The filter strip (SPEC §2.8): ALL · GOLD FORGE (KEEP token) · WORKSHOP (workshop-menu) · LODGE · BERTH. */
internal fun historyFilterChips(): List<FilterChipUi> = listOf(
    FilterChipUi(HISTORY_ALL, "ALL"),
    FilterChipUi(HISTORY_GOLDFORGE, "GOLD FORGE", icon = "keep"),
    FilterChipUi(HISTORY_WORKSHOP, "WORKSHOP", icon = "ui:workshop-menu"),
    FilterChipUi(HISTORY_LODGE, "LODGE", icon = "ui:lodge-menu"),
    FilterChipUi(HISTORY_BERTH, "BERTH"),
)

/** Where a projected family lives: its chip (null = ALL only), its place name, its icon and its recovery door. */
private class HistoryFamilyPlace(val chip: String?, val name: String, val icon: String, val door: String)

private fun historyPlace(family: PhaseEReceiptFamily): HistoryFamilyPlace? = when (family) {
    PhaseEReceiptFamily.WORKSHOP -> HistoryFamilyPlace(HISTORY_WORKSHOP, "Workshop", "ui:workshop-menu", "workshop.craft")
    PhaseEReceiptFamily.REFINING -> HistoryFamilyPlace(HISTORY_WORKSHOP, "Workshop", "ui:workshop-menu", "refining.open")
    PhaseEReceiptFamily.STARTER_FLEET -> HistoryFamilyPlace(HISTORY_BERTH, "Berth", "ui:expedition-kit", "berth.fleet")
    PhaseEReceiptFamily.STARTER_EXPEDITION -> HistoryFamilyPlace(HISTORY_LODGE, "Exploration Lodge", "ui:lodge-menu", "lodge.expedition")
    // The Harvester keeps its own HISTORY tab and has no chip in the design: its rows show under ALL.
    PhaseEReceiptFamily.HARVESTER -> HistoryFamilyPlace(null, "Harvester", "ui:harvester-menu", "harvester.harvest")
    // Not projected by this card (their owners are registration-scoped); the hub never passes them.
    PhaseEReceiptFamily.AWNING, PhaseEReceiptFamily.WAKE, PhaseEReceiptFamily.EQUIPMENT, PhaseEReceiptFamily.VEHICLE,
    PhaseEReceiptFamily.MARKET -> null
}

/** The place name of a projected family, for "can't open … history" lines; null for families this card does not project. */
internal fun historyPlaceName(family: PhaseEReceiptFamily): String? = historyPlace(family)?.name

/** Final words the owners write, drawn as DONE (moss): the thing happened, or the order closed without moving anything. */
private val HISTORY_FINAL_DONE = setOf("COLLECTED", "COMPLETED", "INSTALLED", "CLOSED", "DECLINED", "SAVED DRAFT")

/** A projected row's status Tag. A saved original that is still the owner's current operation (PENDING) is NEEDS YOU;
 * an archived accepted order was SENT; a server row still moving (READY, REFINING, OBSERVED, an accepted expedition in
 * flight) and any status this list does not know stay PENDING, never claimed done. */
internal fun historyStatus(source: PhaseEReceiptSource, status: String): HistoryStatus = when {
    source == PhaseEReceiptSource.PENDING -> HistoryStatus.NEEDS_YOU
    status == "RETURNED" -> HistoryStatus.RETURNED
    status in HISTORY_FINAL_DONE -> HistoryStatus.DONE
    status == "ACCEPTED" && source == PhaseEReceiptSource.ARCHIVED -> HistoryStatus.SENT
    else -> HistoryStatus.PENDING
}

/** DS §9: player copy never says receipt or transaction. */
internal fun historyPlain(text: String): String = text
    .replace("RECEIPT", "RECORD").replace("Receipt", "Record").replace("receipt", "record")
    .replace("TRANSACTION", "PAYMENT").replace("Transaction", "Payment").replace("transaction", "payment")

private fun historyStatusWord(status: String): String =
    if (status == "SAVED DRAFT") "Not sent" else historyPlain(status.lowercase(Locale.ROOT).replaceFirstChar { it.titlecase(Locale.ROOT) })

/** The detail labels that say when something happened (a ready-at, lease expiry or scheduled return is a future time). */
private val HISTORY_HAPPENED_AT = setOf("Started at", "Collected at", "Completed at", "Installed at", "Departed at", "Returned at",
    "Admitted at", "Closed at", "Recorded at")

private fun historyInstant(value: String): Instant? =
    runCatching { Instant.parse(value) }.getOrNull() ?: runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()

/** When [row] last happened, from its own detail times; null when it carries none (a saved draft). */
internal fun historyHappenedAt(row: PhaseEReceiptRow): Instant? =
    row.details.filter { it.label in HISTORY_HAPPENED_AT }.mapNotNull { historyInstant(it.value) }.maxOrNull()

private enum class HistoryDayGroup(val id: String, val title: String) {
    TODAY("today", "TODAY"), YESTERDAY("yesterday", "YESTERDAY"), EARLIER("earlier", "EARLIER")
}

private fun historyDay(at: Instant?, today: LocalDate, zone: ZoneId): HistoryDayGroup {
    val date = at?.atZone(zone)?.toLocalDate() ?: return HistoryDayGroup.EARLIER
    return when {
        !date.isBefore(today) -> HistoryDayGroup.TODAY
        date == today.minusDays(1) -> HistoryDayGroup.YESTERDAY
        else -> HistoryDayGroup.EARLIER
    }
}

private val HISTORY_CLOCK = DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)
private val HISTORY_DAY = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)
private val HISTORY_FULL = DateTimeFormatter.ofPattern("d MMM yyyy HH:mm", Locale.ENGLISH)

private fun historyValue(value: String, zone: ZoneId): String = historyInstant(value)?.let { HISTORY_FULL.format(it.atZone(zone)) } ?: historyPlain(value)

private fun historyDoor(id: String) = HubLink(FeatureId(id))

private fun historyIntentStage(intent: PendingIntent): String = when {
    intent.receipt != null -> "accepted, finishing"
    intent.attempted -> "sent, being checked"
    else -> "not sent yet"
}

private fun historyGemsTitle(kind: String): String = when (kind) {
    IntentKind.GEMS_FROM_KEEP -> "Gems from KEEP not finished"
    IntentKind.GEMS_TO_SHARDS -> "Gems to Shards not finished"
    IntentKind.GEMS_TASK_CLAIM -> "Gems reward not finished"
    else -> "Gems request not finished"
}

/**
 * NEEDS YOU rows for the saved requests outside the five journals: the mail claim ([mailClaim], keyed by the letter) and
 * the Gems requests ([gems] from the Gems owner, [gemsBuy] the wallet purchase). Each stays while its owner still holds
 * it; OPEN goes to Mail or to the Gold Forge's Gems recovery.
 */
internal fun historyNeeds(mailClaim: PendingIntent?, gems: List<PendingIntent>, gemsBuy: SavedGemsBuy?): List<HistoryRowUi> = buildList {
    mailClaim?.let { add(HistoryRowUi("mail:${it.idempotencyKey}", "shape:mail", "Mail reward not finished", "Mail · ${historyIntentStage(it)}",
        HistoryStatus.NEEDS_YOU, historyDoor("hud.mail"))) }
    gems.forEach { add(HistoryRowUi("gems:${it.kind}:${it.idempotencyKey}", "gem-32", historyGemsTitle(it.kind), "Gold Forge · ${historyIntentStage(it)}",
        HistoryStatus.NEEDS_YOU, historyDoor("goldforge.gems"))) }
    gemsBuy?.let { saved ->
        val stage = when {
            saved.observed?.receipt != null -> "credited, finishing"
            saved.attempted || saved.signature != null -> "sent, being checked"
            else -> "not sent yet"
        }
        add(HistoryRowUi("gemsbuy:${saved.draft.idempotencyKey}", "gem-32", "Gems purchase not finished", "Gold Forge · $stage",
            HistoryStatus.NEEDS_YOU, historyDoor("goldforge.gems")))
    }
}

/**
 * A routine refresh must not blank what was shown: an owner's refresh clears its server view while it reads (and a
 * failed read leaves it cleared), so while [refreshing] (the hub also passes true after its read failed) and the live
 * projection has lost its server rows, the last shown server rows stay. Saved originals (PENDING, ARCHIVED) always come
 * from the live journal, which a refresh never clears.
 */
internal fun keptHistoryRows(previous: List<PhaseEReceiptRow>?, live: List<PhaseEReceiptRow>, refreshing: Boolean): List<PhaseEReceiptRow> {
    if (!refreshing || previous == null || live.any { it.source == PhaseEReceiptSource.SERVER }) return live
    return live + previous.filter { it.source == PhaseEReceiptSource.SERVER }
}

/** What the History card draws, and the read-only detail of every row it draws (by row id). */
internal class HistoryView(val ui: HistoryUi, val details: Map<String, HistoryDetailUi>)

/**
 * The History card from retained [rows] (the five projected families) and [needs] ([historyNeeds]), under [filter]
 * (an unknown id is ALL) and [load]. [nowMs] and [zone] place each row in TODAY / YESTERDAY / EARLIER; rows without a time
 * go last in EARLIER. No paging: everything retained is shown, so there is never a MORE row.
 */
internal fun liveHistoryUi(rows: List<PhaseEReceiptRow>, needs: List<HistoryRowUi>, filter: String, load: LoadState,
                           nowMs: Long, zone: ZoneId): HistoryView {
    val active = filter.takeIf { it in HISTORY_FILTERS } ?: HISTORY_ALL
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    val needsYou = needs.toMutableList()
    val dated = mutableListOf<Triple<HistoryDayGroup, Instant?, HistoryRowUi>>()
    val details = LinkedHashMap<String, HistoryDetailUi>()
    for (row in rows) {
        val place = historyPlace(row.family) ?: continue
        val status = historyStatus(row.source, row.status)
        val word = historyStatusWord(row.status)
        val title = historyPlain(row.title)
        if (status == HistoryStatus.NEEDS_YOU) {
            // Money moved is money honoured: never filtered and never dimmed, until the owner archives it as final.
            needsYou += HistoryRowUi(row.id, place.icon, "$title not finished", "${place.name} · ${word.lowercase(Locale.ROOT)}",
                status, historyDoor(place.door))
            continue
        }
        if (active != HISTORY_ALL && place.chip != active) continue
        val at = historyHappenedAt(row)
        val day = historyDay(at, today, zone)
        val time = at?.let { (if (day == HistoryDayGroup.EARLIER) HISTORY_DAY else HISTORY_CLOCK).format(it.atZone(zone)) }
        dated += Triple(day, at, HistoryRowUi(row.id, place.icon, title, listOfNotNull(place.name, word, time).joinToString(" · "), status, null))
        details[row.id] = HistoryDetailUi(row.id, title.uppercase(Locale.ROOT), place.icon, status,
            listOf(HistoryFieldUi("Where", place.name), HistoryFieldUi("Status", word)) +
                row.details.map { HistoryFieldUi(historyPlain(it.label), historyValue(it.value, zone)) })
    }
    val groups = HistoryDayGroup.values().map { day ->
        HistoryGroupUi(day.id, day.title, dated.filter { it.first == day }.sortedByDescending { it.second }.map { it.third })
    }.filter { it.rows.isNotEmpty() }
    return HistoryView(HistoryUi(active, historyFilterChips(), needsYou, groups, hasMore = false, load = load), details)
}
