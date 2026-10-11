package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterEvent
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterIdentity
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterJournal
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterOperation
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterSummary
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterView
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketCatalogue
import gg.pixelkingdomwars.nativeclient.ui.economy.starterLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.BuildingFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.shortfall
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftFrameUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftLiveUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftReviewUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.DoorRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.DayBarUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HaulGroupUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HaulKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HaulRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvestRecordUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterArrivedUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterHistoryUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterHistoryTabUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterIntervalUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterPolicyUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSprite
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterYieldUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.IntervalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedOpUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.StockUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SubmitStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SubmitUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.harvesterSprite
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.harvesterTabs
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * Live mapper of the Harvester tall sheet (`K/ui/sheets/craft/HarvesterSheet.kt`: `HarvesterSheetUi` /
 * `HarvesterSheetActions`; YIELD gathering · ARRIVED · COLLECT, and the round-1 HISTORY list). Reads `HarvesterState`
 * (`HarvesterRepository.state`, observed today as `HarvesterViewModel.state` in `ui/economy/HarvesterScreen.kt`) and the
 * Harvester building's `BuildingFacts` (`LiveBuildingFactsReader`) for its level and UPGRADE price. Every quantity,
 * cadence and time is the server's (`HarvesterView.policy`, the source's `admittedAt` / `leaseExpiresAt`, the saved
 * settlement events); nothing is projected into an amount. COLLECT is the client-only "seen" acknowledgement (craft SPEC
 * 0.2): hauls are delivered by the server on their own, so no server call and no charge exists here.
 */

/** Realm → its raw home resource. Identities, not tuning: a copy of `starterResourceRealms` (network
 *  `starter/StarterValues.kt`, module-internal there) reversed; craft SPEC §4.1 table. */
private val HOME_RESOURCE = mapOf(
    "frostveil" to "frost_quartz", "elderwood" to "heartwood_logs", "sunscar" to "sunstone_rubble", "crownlands" to "crown_iron_ore",
    "seeker-reach" to "rough_prism", "stormcairn" to "storm_ore", "thornwake" to "thorn_fibre", "cinderfall" to "ember_nodules",
)

/** Raw resource → the refined item the Workshop makes from it (network `ordinarycrafting/OrdinaryCraftingProtocol.kt`
 *  `refinedInputs`, private there, reversed). The Workshop recipe id is `refine_<item>` (`ordinaryRecipeIds`). */
private val REFINED_FROM = mapOf(
    "frost_quartz" to "frostglass", "heartwood_logs" to "heartwood_beams", "sunstone_rubble" to "sunstone_blocks",
    "crown_iron_ore" to "crownsteel", "rough_prism" to "prismstone_lens", "storm_ore" to "stormalloy",
    "thorn_fibre" to "thornsilk", "ember_nodules" to "embercore",
)

private val RECORD_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM · HH:mm", Locale.US).withZone(ZoneOffset.UTC)

/** Every saved request of the journal, current first. */
private fun operations(journal: HarvesterJournal): List<HarvesterOperation> =
    listOfNotNull(journal.operation) + journal.archives.map { it.operation }

/** The server-observed earning events of [sourceId], read from whichever saved request accepted it (current request or
 *  archive). Null when no saved receipt covers that source (selected on another device, or not yet checked): the
 *  arrivals are then UNKNOWN, never zero. */
internal fun harvesterSourceEvents(journal: HarvesterJournal, sourceId: String): List<HarvesterEvent>? =
    operations(journal).firstOrNull { it.proof?.originalReceipt?.source?.sourceId == sourceId }?.proof?.settlement?.events

/** True once the server recorded the source's closure (replacement, lease end, custody change…). */
internal fun harvesterSourceClosed(journal: HarvesterJournal, sourceId: String): Boolean =
    operations(journal).firstOrNull { it.proof?.originalReceipt?.source?.sourceId == sourceId }?.proof?.settlement?.closure != null

/** The newest observed wallet sequence of [sourceId]: what COLLECT stores as the client-only seen marker (per account). */
internal fun harvesterLatestSequence(journal: HarvesterJournal, sourceId: String): String? =
    harvesterSourceEvents(journal, sourceId)?.mapNotNull { e -> liveBig(e.walletSequence)?.let { it to e.walletSequence } }
        ?.maxByOrNull { it.first }?.second

/**
 * The haul that arrived and is not yet acknowledged: the delivered (net) quantity of every observed event after
 * [seenThrough], and when the last of them settled. With no marker ([seenThrough] null) nothing counts as unseen: the host
 * seeds the marker with [harvesterLatestSequence] on first observation, so a first open never invents an arrival.
 */
internal fun harvesterArrived(events: List<HarvesterEvent>?, seenThrough: String?): HarvesterArrivedUi {
    val seen = liveBig(seenThrough) ?: return HarvesterArrivedUi(0L, null)
    val fresh = events.orEmpty().filter { e -> liveBig(e.walletSequence)?.let { it > seen } == true }
    val total = liveSum(fresh.map { it.netQuantity }) ?: 0L
    return HarvesterArrivedUi(total, fresh.maxByOrNull { liveInstantMs(it.settledAt) ?: Long.MIN_VALUE }?.settledAt)
}

/** Units delivered (net, after the island pool) during the server's current UTC day ([serverNow]); null when the events
 *  or the server time are unknown. */
internal fun harvesterTodayArrived(events: List<HarvesterEvent>?, serverNow: String?): Long? {
    val known = events ?: return null
    val now = serverNow?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return null
    val day = now.truncatedTo(ChronoUnit.DAYS)
    return liveSum(known.filter { e -> runCatching { Instant.parse(e.utcDay) }.getOrNull() == day }.map { it.netQuantity })
}

/**
 * The earning interval of this kingdom's source. NONE without a source; ENDED once the server recorded its closure or
 * [nowServerMs] reached its `leaseExpiresAt`; else RUNNING with the next earning moment on the server's own grid
 * (`earnedAt = admittedAt + ordinal × cadenceSec`, `HarvesterEvent.validate`), or null past the lease end.
 */
internal fun harvesterInterval(source: HarvesterSummary?, closed: Boolean, cadenceSec: Long?, nowServerMs: Long): HarvesterIntervalUi {
    source ?: return HarvesterIntervalUi(IntervalState.NONE, null, null)
    val start = liveInstantMs(source.admittedAt)
    val end = liveInstantMs(source.leaseExpiresAt)
    if (closed || (end != null && nowServerMs >= end)) return HarvesterIntervalUi(IntervalState.ENDED, start, null)
    val cadenceMs = cadenceSec?.takeIf { it > 0 }?.let { it * 1000L }
    if (start == null || end == null || cadenceMs == null) return HarvesterIntervalUi(IntervalState.RUNNING, start, null)
    val next = start + ((nowServerMs - start).coerceAtLeast(0L) / cadenceMs + 1L) * cadenceMs
    return HarvesterIntervalUi(IntervalState.RUNNING, start, next.takeIf { it <= end })
}

/** The completed Harvester a START review selects: the selected building when the server lists it as completed, else
 *  the kingdom's only completed one; null when none is completed (or the choice is ambiguous). */
internal fun harvesterStartTarget(view: HarvesterView?, buildingId: String?): String? {
    val facilities = view?.facilities ?: return null
    return (facilities.firstOrNull { it.harvesterId == buildingId } ?: facilities.singleOrNull())?.harvesterId
}

/** The saved request's recovery row (craft SPEC §5). An accepted source that is still gathering does not block anything,
 *  so it is not shown (its receipt waits in History). [checking] while a check runs. */
internal fun harvesterSaved(op: HarvesterOperation?, interval: IntervalState, checking: Boolean): SavedOpUi? {
    op ?: return null
    if (op.proof != null && interval == IntervalState.RUNNING) return null
    val (title, line) = when {
        op.proof != null -> "Your last selection was accepted" to "Archive its receipt before starting another"
        op.refusal != null -> "A request from earlier was declined" to "Check it and archive it before starting another"
        op.attemptRevision != null -> "A request from earlier is waiting" to "Check it before starting another"
        else -> "A saved request is waiting" to "Review or archive it before starting another"
    }
    return SavedOpUi(op.command.key, title, line, checking)
}

/** True when the saved request is this kingdom's unproven, unrefused selection: REVIEW SAVED REQUEST re-reviews its exact
 *  key in place (the owner's `reviewSaved`), never a new command. Accepted or declined requests stay with CHECK / History. */
internal fun harvesterSavedReviewable(op: HarvesterOperation?, selectedBase: String?): Boolean =
    op != null && selectedBase != null && op.proof == null && op.refusal == null && op.command.request.baseId == selectedBase

/** The "Spare ore · Sell it at the Market" door (craft SPEC §4.1), only when the KEEP Market lists [resourceId]
 *  ([marketItems] = `KeepEquipmentMarketCatalogue.itemIds`); otherwise null, so GO never leads to a market that cannot sell it. */
internal fun harvesterSellDoor(resourceId: String?, marketItems: Set<String>): DoorRowUi? =
    resourceId?.takeIf { it in marketItems }?.let { id ->
        DoorRowUi(id, "ui:market-menu", "Spare ore", "Sell it at the Market", "Go to the Market to sell spare ${starterLabel(id)}")
    }

/** The START request's stage. A sent request with no answer is CHECKING (never "nothing was spent"); the store keeps only
 *  definitive server refusals (`harvesterRefusalDefinitive`), so a refusal is REFUSED. */
internal fun harvesterSubmit(op: HarvesterOperation?, confirming: Boolean): SubmitUi = when {
    confirming -> SubmitUi(SubmitStage.SENDING, "Starting")
    op != null && op.proof == null && op.refusal == null && op.attemptRevision != null -> SubmitUi(SubmitStage.CHECKING)
    op?.refusal != null -> SubmitUi(SubmitStage.REFUSED, message = "The server declined this selection. Nothing was spent.")
    else -> SubmitUi()
}

/** The UPGRADE price from the Harvester building's facts; null hides UPGRADE (no facts, max level, no upgrade shown). A
 *  SOL-priced step is a money path: it stays UNAVAILABLE (drawn disabled, never a number) until MS-M3 wires it. */
internal fun harvesterUpgradeCost(b: BuildingFacts?): PriceUi? {
    b ?: return null
    if (b.level >= b.maxLevel || !b.canShowUpgrade) return null
    if (b.paidStep) return PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE, description = MONEY_WIRING_PENDING)
    val shown = b.upgradeCost
    if (!b.upgradePriced || shown == null) return PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE, description = "Price unavailable")
    val short = shortfall(b.shardsBalance, b.upgradeCostRaw) != null
    return PriceUi(Currency.SHARDS, shown, if (short) PriceStatus.SHORT else PriceStatus.OK, description = "$shown Shards")
}

/** Where the sheet's data stands. A refresh (busy, no review open) is Loading; a failed one is Error with its message; no
 *  current view for this wallet and kingdom is Error with the reason today's screen gives. */
internal fun harvesterHydration(view: HarvesterView?, loading: Boolean, error: String?, selectedBase: String?): CraftHydration = when {
    error != null -> CraftHydration.Error(error)
    loading -> CraftHydration.Loading
    view != null -> CraftHydration.Ready
    selectedBase == null -> CraftHydration.Error("Choose a kingdom to see its Harvester.")
    else -> CraftHydration.Error("Harvester details are unavailable. Try again.")
}

/** HISTORY (round 1): every server-observed haul in the saved receipts, newest first ("+11", UTC time, realm). */
internal fun harvesterRecords(journal: HarvesterJournal): List<HarvestRecordUi> =
    operations(journal).flatMap { op ->
        val source = op.proof?.originalReceipt?.source ?: return@flatMap emptyList()
        op.proof?.settlement?.events.orEmpty().map { e -> e to starterLabel(source.realmId) }
    }.sortedByDescending { (e, _) -> liveBig(e.walletSequence) ?: java.math.BigInteger.ZERO }.map { (e, realm) ->
        val time = liveInstantMs(e.earnedAt)?.let { "${RECORD_TIME.format(Instant.ofEpochMilli(it))} UTC" } ?: UNKNOWN
        HarvestRecordUi("${e.sourceId}:${e.ordinal}", time, groupedAmount(e.netQuantity)?.let { "+$it" } ?: UNKNOWN, realm)
    }

private data class HistoryReceiptRow(val at: Instant, val sequence: java.math.BigInteger?, val row: HaulRowUi)

/** Round-2 HISTORY from validated saved receipts for exactly one account, kingdom, Harvester and resource.
 *
 * A saved source receipt is not an authoritative seven-day ledger: other devices, earlier sources and unsettled
 * earning observations may be absent. Consequently the chart and week total stay unknown, even on days with rows.
 * Only server instants are used, shown explicitly in UTC; a device clock never manufactures a fresh-check age.
 * Only a validated current view names today's date; retained receipt times never stand in for the current day.
 * Loading or a failed refresh retains admitted receipts, while a stale owner or different identity hides them.
 */
internal fun harvesterHistoryLiveUi(
    state: HarvesterState,
    identity: HarvesterIdentity,
    selectedBase: String?,
    selectedHarvesterId: String?,
    current: Boolean,
    running: Boolean,
    error: String?,
): HarvesterHistoryTabUi {
    val identityMatches = state.journal.identity == identity && state.journal.version == 1 &&
        state.journal.revision >= 0 && runCatching { identity.validate() }.isSuccess
    val identityCurrent = current && identityMatches
    val view = state.view?.takeIf { identityCurrent && it.wallet == identity.wallet && it.baseId == selectedBase &&
        runCatching { it.validate() }.isSuccess }
    val harvester = selectedHarvesterId ?: view?.source?.harvesterId
    val scoped = if (!identityCurrent || selectedBase == null || harvester == null) emptyList() else
        operations(state.journal).mapNotNull { op ->
            op.proof?.takeIf { proof ->
                proof.status == "accepted" && runCatching { proof.validate(identity, op.command) }.isSuccess &&
                    proof.originalReceipt?.source?.let { it.baseId == selectedBase && it.harvesterId == harvester } == true
            }
        }
    val resource = view?.source?.takeIf { it.harvesterId == harvester }?.resourceId
        ?: view?.home?.realmId?.let { HOME_RESOURCE[it] }
        ?: scoped.mapNotNull { it.originalReceipt?.source?.resourceId }.distinct().singleOrNull()
    // Duplicate snapshots are safe only when a complete observation preserves all earlier observations. Conflicting
    // quantities or frozen source receipts are withheld; selecting the newest timestamp alone would conceal a conflict.
    val proofs = scoped.filter { it.originalReceipt?.source?.resourceId == resource }
        .groupBy { it.originalReceipt!!.source.sourceId }.values.mapNotNull { snapshots ->
            snapshots.filter { candidate -> snapshots.all { prior ->
                candidate.originalReceipt == prior.originalReceipt && candidate.settlement!!.preserves(prior.settlement!!)
            } }.maxByOrNull { Instant.parse(it.serverNow) }
        }
    val receiptTime = proofs.maxOfOrNull { Instant.parse(it.serverNow) }
    val today = view?.serverNow?.let(Instant::parse)?.atOffset(ZoneOffset.UTC)?.toLocalDate()
    val dayLabel = DateTimeFormatter.ofPattern("EEE", Locale.US)
    val days = (6 downTo 0).map { ago ->
        val date = today?.minusDays(ago.toLong())
        DayBarUi(if (date == null) UNKNOWN else if (ago == 0) "Today" else dayLabel.format(date),
            total = null, today = today != null && ago == 0, amount = null)
    }
    val clock = DateTimeFormatter.ofPattern("HH:mm", Locale.US).withZone(ZoneOffset.UTC)
    val receiptRows = proofs.flatMap { proof ->
        val source = proof.originalReceipt!!.source
        val settlement = proof.settlement!!
        settlement.events.map { event ->
            val at = Instant.parse(event.earnedAt)
            HistoryReceiptRow(at, liveBig(event.walletSequence), HaulRowUi(clock.format(at),
                groupedAmount(event.netQuantity) ?: UNKNOWN, HaulKind.HAUL, "into your stores", "${event.sourceId}:${event.ordinal}"))
        } + listOfNotNull(settlement.closure?.let { closure ->
            val at = Instant.parse(closure.cutoffAt)
            HistoryReceiptRow(at, null, HaulRowUi(clock.format(at), "", HaulKind.PAUSED,
                "Gathering stopped · START AGAIN on YIELD", "${source.sourceId}:closed"))
        })
    }.sortedWith(compareByDescending<HistoryReceiptRow> { it.at }.thenByDescending { it.sequence })
    val groupLabel = DateTimeFormatter.ofPattern("EEEE · d MMM uuuu 'UTC'", Locale.US)
    val groups = receiptRows.groupBy { it.at.atOffset(ZoneOffset.UTC).toLocalDate() }.map { (date, rows) ->
        HaulGroupUi(if (date == today) "TODAY · UTC" else groupLabel.format(date).uppercase(Locale.US), rows.map { it.row })
    }
    val available = identityCurrent && selectedBase != null && harvester != null && resource != null
    val busy = state.busy || running
    val shownAt = receiptTime?.let { "${RECORD_TIME.format(it)} UTC" }
    val problem = when {
        !identityMatches -> "Harvester history is unavailable for the current account."
        !current -> "History is paused while another review or read finishes."
        error != null -> error
        selectedBase == null -> "Choose a kingdom to see its Harvester history."
        harvester == null || resource == null -> "Choose a Harvester to see its saved earning receipts."
        else -> null
    }
    return HarvesterHistoryTabUi(
        resourceId = resource.orEmpty(), days = days, weekTotal = null, groups = groups,
        refreshedAgo = null, nextCursor = null,
        resourceName = resource?.let(::starterLabel) ?: UNKNOWN,
        resourceIcon = resource?.let(::craftItemIcon) ?: "shape:unknown",
        load = when { problem != null -> CraftHydration.Error(problem); busy -> CraftHydration.Loading; else -> CraftHydration.Ready },
        checking = busy, errorShowing = shownAt.takeIf { problem != null },
        emptyReason = problem ?: "Saved receipts may not include every haul. CHECK asks the realm for earning observations.",
        coverageNote = "Saved receipts shown in UTC. Daily and weekly totals are unavailable.",
        emptyTitle = if (available) "No saved hauls" else "History unavailable",
        updatedAt = shownAt, checkAllowed = available && !busy && state.review == null,
    )
}

/**
 * The Harvester sheet from today's state.
 *
 * @param tab the Destination tab (`HarvesterTab.YIELD` / `HISTORY`); anything else opens YIELD.
 * @param state `HarvesterViewModel.state.value`.
 * @param wallet / [selectedBase] the session wallet and selected kingdom: a view for another one is ignored, as
 *   HarvesterScreen does.
 * @param building the Harvester building's facts (`LiveBuildingFactsReader`); null hides UPGRADE and reads the level "…".
 * @param artKey the server art key of this Harvester (`seeker-reach`…); never derived here (SPEC §4.1 mismatch).
 * @param tier the art tier from the server building art map; null draws tier 1 art.
 * @param seenThroughSequence the client-only seen marker the host stores per account ([harvesterLatestSequence]).
 * @param running `HarvesterViewModel.busy.value`; [error] the view model's error notice, if any.
 * @param nowMs device ms; [serverOffsetMs] server − device ms.
 * @param shardsRow the Shards row the host draws top-right (`HarvesterSheetUi.spend`).
 */
internal fun harvesterLiveUi(
    tab: String?,
    state: HarvesterState,
    wallet: String,
    selectedBase: String?,
    building: BuildingFacts?,
    artKey: String?,
    tier: Int?,
    seenThroughSequence: String?,
    actionsAllowed: Boolean,
    running: Boolean,
    error: String?,
    nowMs: Long,
    serverOffsetMs: Long,
    shardsRow: ResourceChipUi? = null,
): HarvesterSheetUi {
    val view = state.view?.takeIf { it.wallet == wallet && it.baseId == selectedBase }
    val busy = state.busy || running
    val reviewOpen = state.review != null
    val source = view?.source
    val events = source?.let { harvesterSourceEvents(state.journal, it.sourceId) }
    val cadenceSec = view?.policy?.cadenceSec
    val interval = harvesterInterval(source, source?.let { harvesterSourceClosed(state.journal, it.sourceId) } == true,
        cadenceSec, nowMs + serverOffsetMs)
    val arrived = harvesterArrived(events, seenThroughSequence)
    val realmId = source?.realmId ?: view?.home?.realmId
    val resourceId = source?.resourceId ?: realmId?.let { HOME_RESOURCE[it] }
    val target = harvesterStartTarget(view, building?.buildingId)
    val complete = view == null || target != null
    val operation = state.journal.operation
    val allowed = if (interval.state == IntervalState.RUNNING) actionsAllowed && building?.readOnly != true
        else actionsAllowed && view?.acceptingSelections == true && view?.home != null
    val stockRow = resourceId?.let { id -> view?.rawStock?.firstOrNull { it.resourceId == id } }
    val refined = resourceId?.let { REFINED_FROM[it] }
    val level = building?.level
    val sprite = when {
        !complete || building?.job?.kind in setOf("build", "upgrade") -> HarvesterSprite.CONSTRUCTION
        arrived.unseenQuantity > 0L -> HarvesterSprite.READY
        else -> HarvesterSprite.IDLE
    }
    val yieldUi = HarvesterYieldUi(
        realmId = realmId.orEmpty(),
        artKey = artKey,
        resourceId = resourceId.orEmpty(),
        level = level,
        tier = tier,
        policy = HarvesterPolicyUi(liveCount(view?.policy?.grossPerCadence), cadenceSec),
        interval = interval,
        arrived = arrived,
        todayArrived = harvesterTodayArrived(events, view?.serverNow),
        stock = StockUi(liveCount(stockRow?.available), liveCount(stockRow?.reserved), liveCount(stockRow?.total)),
        nextLevelDelta = null,
        upgradeCost = harvesterUpgradeCost(building),
        actionsAllowed = allowed,
        saved = harvesterSaved(operation, interval.state, busy && !reviewOpen),
        realmName = realmId?.let(::starterLabel) ?: UNKNOWN,
        resourceName = resourceId?.let(::starterLabel) ?: UNKNOWN,
        resourceIcon = resourceId?.let(::craftItemIcon) ?: "shape:unknown",
        arrivedNoun = resourceId?.let { starterLabel(it).lowercase(Locale.US) } ?: "units",
        complete = complete,
        refineDoor = refined?.let { out ->
            val name = starterLabel(out)
            DoorRowUi("refine_$out", craftItemIcon(out), name, "Refine it at the Workshop", "Go to the Workshop, refine $name")
        },
        sellDoor = harvesterSellDoor(resourceId, KeepEquipmentMarketCatalogue.itemIds),
        hydration = harvesterHydration(view, busy && !reviewOpen, error, selectedBase),
        submit = harvesterSubmit(operation, busy && reviewOpen),
        serverOffsetMs = serverOffsetMs,
        savedReviewable = harvesterSavedReviewable(operation, selectedBase),
    )
    val selected = if (tab == HarvesterTab.HISTORY) HarvesterTab.HISTORY else HarvesterTab.YIELD
    val fallbackLive = when (interval.state) {
        IntervalState.NONE -> CraftLiveUi("ui:harvester-menu", "Not gathering yet")
        IntervalState.ENDED -> CraftLiveUi("ui:harvester-menu", "Gathering stopped")
        IntervalState.RUNNING -> null
    }
    return HarvesterSheetUi(
        frame = CraftFrameUi("HARVESTER", level?.let { "LV $it" } ?: UNKNOWN, fallbackLive, history = false, tabs = harvesterTabs(),
            selectedTab = selected, stackedTabs = false),
        header = CraftHeaderUi(harvesterSprite(artKey, tier, sprite)),
        harvest = yieldUi,
        history = HarvesterHistoryUi(harvesterRecords(state.journal), checking = busy,
            hydration = if (busy && !reviewOpen) CraftHydration.Loading else CraftHydration.Ready),
        review = state.review?.let { r ->
            CraftReviewUi("START GATHERING",
                if (r.command.replacedSource != null) "This closes your current source and starts a new interval. Earned units stay owed to their kingdom."
                else "This starts a new interval. Earned units stay owed to their kingdom.",
                confirmLabel = "START", sending = busy)
        },
        // The HAUL ARRIVED party exists only after a COLLECT tap: the host computes it with harvesterArrivedCelebration.
        celebration = null,
        spend = shardsRow,
    )
}

/**
 * The Harvester sheet's callbacks (Actions stub for MS-C3). Nothing here moves money: START opens today's review and
 * its confirm is the existing `HarvesterViewModel.confirm(review)` (a source selection, no payment); COLLECT is the
 * client-only seen marker; UPGRADE only opens the system Upgrade half sheet (a SOL-priced step is drawn disabled by
 * [harvesterUpgradeCost] and never reaches it).
 *
 * @param reviewStart `HarvesterViewModel.start(harvesterStartTarget(view, buildingId))`.
 * @param markSeen store `harvesterLatestSequence(journal, sourceId)` as the account's seen marker, then re-map.
 * @param refresh `HarvesterViewModel.refresh()` (also checks every unclosed saved receipt: today's CHECK EARNING
 *   OBSERVATIONS for the archives).
 * @param checkReceipt `HarvesterViewModel.check()` (today's CHECK ORIGINAL RECEIPT).
 * @param reviewSaved REVIEW SAVED REQUEST: re-review the saved request's exact key; defaults to [reviewStart] for a host
 *   without its own saved re-review.
 * @param celebrationDone the HAUL ARRIVED dismissal (NICE, a tap or its timer); defaults to [markSeen] for a host that
 *   does not move the marker on the COLLECT tap itself.
 */
internal fun harvesterLiveActions(
    close: () -> Unit,
    switchTab: (String) -> Unit,
    reviewStart: () -> Unit,
    markSeen: () -> Unit,
    openUpgrade: () -> Unit,
    openWorkshop: (recipeId: String) -> Unit,
    openMarketSell: (itemId: String) -> Unit,
    refresh: () -> Unit,
    needMore: (PriceUi) -> Unit,
    checkReceipt: () -> Unit,
    dismissReview: () -> Unit,
    confirmReview: () -> Unit,
    reviewSaved: () -> Unit = reviewStart,
    celebrationDone: () -> Unit = markSeen,
): HarvesterSheetActions = HarvesterSheetActions(
    onClose = close,
    onTab = switchTab,
    onStart = reviewStart,
    onCollectSeen = markSeen,
    onUpgrade = openUpgrade,
    onGoWorkshop = openWorkshop,
    onGoMarketSell = openMarketSell,
    onRetry = refresh,
    onNeedMore = needMore,
    onCheckSaved = { checkReceipt() },
    onReviewBack = dismissReview,
    onReviewConfirm = confirmReview,
    onCheckObservations = refresh,
    onCelebrationDone = { celebrationDone() },
    onReviewSaved = reviewSaved,
)
