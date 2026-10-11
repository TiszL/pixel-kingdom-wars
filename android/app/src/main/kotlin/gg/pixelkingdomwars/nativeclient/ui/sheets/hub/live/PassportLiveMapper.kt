package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.PassportExpedition
import gg.pixelkingdomwars.nativeclient.data.PassportExpeditions
import gg.pixelkingdomwars.nativeclient.data.PassportSection
import gg.pixelkingdomwars.nativeclient.data.RealmPassportState
import gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds
import gg.pixelkingdomwars.nativeclient.ui.economy.starterLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PassportActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PassportUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ReturnRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.SourceState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.StampUi
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * Live mapper of Lodge › PASSPORT (`PassportUi` / `PassportActions`, K/ui/sheets/voyage/LodgePassportTab.kt, mounted via
 * `LodgeSheetR2Ui.passport`). State source: `RealmPassportRepository.state` (`RealmPassportState`, exposed today as
 * `RealmPassportViewModel.state` and observed by `K/ui/phasee/RealmPassportScreen.kt`).
 *
 * The passport is a RECORD (SPEC E1.1): completed returns, published renown and participation days. Nothing here buys,
 * claims or unlocks anything. Honesty rules kept:
 * - the repository holds ONE page of ONE expedition kind at a time, so per-realm stamp counts are drawn only once both
 *   kinds' histories were paged to the end ([PassportReturns.complete]); until then the stamps are not drawn (header
 *   "… realms") instead of a false "not yet", and trips reads "20+" (a lower bound), never a short total;
 * - renown / days come only from the server's published current observation; unknown is "…".
 */

/** One expedition kind's returns accumulated across the repository's pages (`starter` or `advanced`). The host keeps one
 *  per kind and feeds every new page through [accumulateReturns]. */
internal data class PassportReturns(val kind: String, val rows: List<PassportExpedition>, val complete: Boolean)

/** The realm → raw resource icon of the stamps (craft SPEC §4 table; the same pairs as the network module's
 *  `starterResourceRealms`, which is `internal` there). Presentation only. */
internal val PASSPORT_REALM_RESOURCE: Map<String, String> = linkedMapOf(
    "frostveil" to "voyage:frost-quartz",
    "elderwood" to "voyage:heartwood-logs",
    "sunscar" to "voyage:sunstone-rubble",
    "crownlands" to "voyage:crown-iron-ore",
    "seeker-reach" to "voyage:rough-prism",
    "stormcairn" to "voyage:storm-ore",
    "thornwake" to "voyage:thorn-fibre",
    "cinderfall" to "voyage:ember-nodules",
)

/** How many LAST RETURNS rows the tab lists (passport.png shows a short list; the full history is one tap away). */
internal const val PASSPORT_RECENT_ROWS = 3

/**
 * Folds one repository [section] of [kind] into [previous] (the repository's NEXT page replaces its own page, so the
 * host must keep the union). The history is append-only and the repository always pages from the start, so every page is
 * merged by `expeditionId` (re-emitting a page while a busy flag flips changes nothing) and [PassportReturns.complete]
 * follows the page just read: true only on the last page (`nextCursor == null`). An unread or unavailable page keeps the
 * last good rows (SPEC: error = last good + REFRESH STAMPS); a page of the other kind changes nothing. Reset the held
 * value to null when the account changes.
 */
internal fun accumulateReturns(previous: PassportReturns?, section: PassportSection<PassportExpeditions>, kind: String): PassportReturns? {
    val held = previous?.takeIf { it.kind == kind }
    val page = section.observation?.data ?: return held
    if (page.kind != kind) return held
    val rows = (held?.rows.orEmpty() + page.rows).distinctBy { it.expeditionId }.sortedBy { it.expeditionId }
    return PassportReturns(kind, rows, complete = page.nextCursor == null)
}

/** Where the records come from: a conflict anywhere wins, then an unavailable / failed read, then a server that has not
 *  configured the expedition history. The mining-current source being off only leaves renown / days at "…". */
internal fun passportLiveSource(state: RealmPassportState): SourceState {
    val reasons = listOfNotNull(state.expeditions.observation?.unavailableReason, state.current.observation?.unavailableReason)
    return when {
        "SOURCE_CONFLICT" in reasons -> SourceState.CONFLICT
        "SOURCE_UNAVAILABLE" in reasons || state.expeditions.error != null || state.current.error != null -> SourceState.UNAVAILABLE
        state.expeditions.observation?.unavailableReason == "NOT_CONFIGURED" -> SourceState.NOT_CONFIGURED
        else -> SourceState.OK
    }
}

/** The eight stamps in the game's realm order with complete counts; empty while either kind is not fully read. */
internal fun passportStamps(returns: List<PassportReturns?>, homeRealmId: String?): List<StampUi> {
    if (returns.size < 2 || returns.any { it == null || !it.complete }) return emptyList()
    val counts = returns.filterNotNull().flatMap { it.rows }.groupingBy { it.realmId }.eachCount()
    return paidStarterRealmIds.map { realm ->
        StampUi(realm, liveRealmName(realm), PASSPORT_REALM_RESOURCE[realm] ?: "shape:unknown", counts[realm] ?: 0, home = realm == homeRealmId)
    }
}

/** The trips stat: the exact total once both kinds are complete, "n+" while pages remain, "…" before any read. */
internal fun passportTripsText(returns: List<PassportReturns?>): String {
    val known = returns.filterNotNull()
    if (known.isEmpty()) return UNKNOWN
    val total = known.sumOf { it.rows.size }
    val exact = returns.size >= 2 && returns.all { it != null && it.complete }
    return if (exact) compactAmount(total.toString()) else "${compactAmount(total.toString())}+"
}

/** "Glasswake Keys 3" from an ordinary route id ("glasswake-keys-3"); starter routes use the native alias
 *  ("common_crownlands" → "Common Crownlands"). */
internal fun passportRouteName(kind: String, routeId: String): String {
    if (kind == "advanced") {
        val number = routeId.substringAfterLast('-', "")
        val chain = routeId.substringBeforeLast('-', routeId)
        val words = chain.split('-').filter { it.isNotEmpty() }.joinToString(" ") { w -> w.replaceFirstChar { it.uppercaseChar() } }
        return if (number.all(Char::isDigit) && number.isNotEmpty()) "$words $number" else words
    }
    return starterLabel(routeId)
}

/** The vehicle words of a return row. The record carries the kind only (no family / tier), so a crafted trip is named
 *  generically rather than guessed. */
internal fun passportVehicle(kind: String): String = if (kind == "advanced") "Crafted vehicle" else "Starter boat"

/** "today 21:40", "yesterday 21:40", "Tue 09:10" (this week), "3 Oct" (older); "…" for a bad instant. */
internal fun returnTimeLabel(iso: String, nowMs: Long, zone: ZoneId): String {
    val at = runCatching { Instant.parse(iso).atZone(zone) }.getOrNull() ?: return UNKNOWN
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    val days = ChronoUnit.DAYS.between(at.toLocalDate(), today)
    val time = at.format(DateTimeFormatter.ofPattern("HH:mm", Locale.US))
    return when {
        days <= 0L -> "today $time"
        days == 1L -> "yesterday $time"
        days < 7L -> "${at.format(DateTimeFormatter.ofPattern("EEE", Locale.US))} $time"
        else -> at.format(DateTimeFormatter.ofPattern("d MMM", Locale.US))
    }
}

/** The realm whose stamp was just earned (0 → >0 between two maps of the same player), for the 180 ms pop; null when
 *  none or when either side has no complete stamps. */
internal fun newStampRealm(previous: List<StampUi>, next: List<StampUi>): String? {
    if (previous.isEmpty() || next.isEmpty()) return null
    val before = previous.associate { it.realmId to it.trips }
    return next.firstOrNull { it.trips > 0 && (before[it.realmId] ?: 0) == 0 }?.realmId
}

/**
 * What the passport repository holds → the PASSPORT tab.
 *
 * [starter] / [advanced] are the host's accumulated pages ([accumulateReturns]); null = that kind not read yet.
 * [homeRealmId] is the playing base's `BaseSummary.fantasyRealmId` (green HOME tag); [lodgeTier] the Lodge's art tier
 * (header only); [previousStamps] the stamps of the last map (drives [PassportUi.newStampRealmId]).
 */
internal fun passportLiveUi(state: RealmPassportState, starter: PassportReturns?, advanced: PassportReturns?, homeRealmId: String?,
    lodgeTier: Int, nowMs: Long, zone: ZoneId, previousStamps: List<StampUi> = emptyList()): PassportUi {
    val returns = listOf(starter, advanced)
    val published = state.current.observation?.data?.published
    val stamps = passportStamps(returns, homeRealmId)
    val recent = returns.filterNotNull().flatMap { it.rows }
        .sortedByDescending { runCatching { Instant.parse(it.returnedAt) }.getOrNull() ?: Instant.EPOCH }
        .take(PASSPORT_RECENT_ROWS)
        .map { row ->
            ReturnRowUi(routeId = row.routeId, routeName = passportRouteName(row.kind, row.routeId), vehicle = passportVehicle(row.kind),
                at = returnTimeLabel(row.returnedAt, nowMs, zone), id = row.returnId, route = null)
        }
    return PassportUi(
        renown = compactAmount(published?.cumulativeRenown),
        trips = passportTripsText(returns),
        days = compactAmount(published?.cumulativeDays),
        stamps = stamps,
        recent = recent,
        refreshedAgo = agoLabel(state.expeditions.observation?.serverNow ?: state.current.observation?.serverNow, nowMs),
        sourceState = passportLiveSource(state),
        loading = state.expeditions.busy || state.current.busy,
        newStampRealmId = newStampRealm(previousStamps, stamps),
        lodgeTier = lodgeTier.coerceIn(1, 4),
    )
}

/**
 * The PASSPORT callbacks. Nothing here spends: REFRESH STAMPS re-reads (`RealmPassportViewModel.refresh`), SEND A TRIP is
 * navigation to the SEND tab, a return row opens History. The per-realm trips half sheet of `onStamp` is not built, so a
 * stamp tap explains that instead of doing nothing.
 */
internal fun passportLiveActions(refresh: () -> Unit, openSendTab: () -> Unit, openHistory: (returnId: String) -> Unit,
    explain: (String) -> Unit): PassportActions = PassportActions(
    onStamp = { realmId -> explain("${liveRealmName(realmId)}: a trip list per realm is not built yet.") },
    onRefreshStamps = refresh,
    onSendTrip = openSendTab,
    onReturn = openHistory,
)
