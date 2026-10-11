package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.UUID
import gg.pixelkingdomwars.nativeclient.audio.BaseAudioAction
import gg.pixelkingdomwars.nativeclient.audio.UiAudioCue
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class ReviewedBuilderFinishSpend(val intent: PendingIntent, val generation: Long, val revision: Long)

data class BaseState(
    val base: BaseSnapshot? = null,
    val balances: Balances? = null,
    val tutorial: TutorialState? = null,
    val quests: QuestBoard? = null,
    val mine: MineStatus? = null,
    val layouts: Layouts? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val builderFinishReview: ReviewedBuilderFinishSpend? = null,
)

/** The atomic Home read: `/base` then `/balances` (+ optional `/tutorial`) pinned to one base. */
data class HomeSnapshot(val base: BaseSnapshot, val balances: Balances, val tutorial: TutorialState?,
    val rawBalances: JsonObject = buildJsonObject {}, val fleetJourneyEvents: JsonElement? = null)

/** Reads must succeed before any receipt is retired or any result published. A different base
 * answering the read is refused; optional guidance failure never strands a refreshed Home. */
/** GET /base answered 503 `VEHICLE_BERTH_VIEW_HELD`: the server's starter-fleet berth decoration failed, not the base. That
 * Phase E hook (apps/api/src/game/vehicleBerthOccupancy.ts, mounted on the QA chain lane) re-reads the player, base and slot
 * rows `for update nowait`, so the cold start's concurrent GET /base and GET /starter-fleet collide and one answers 503
 * "Fleet berths are temporarily unavailable…". Owner rule N-028 (2026-10-06): a fleet read the server holds is "not open
 * here", never a red error; it must never stop or delay the kingdom. Matched on the code only: any other 503 still speaks. */
internal fun berthViewHeld(error: Throwable): Boolean =
    error is ApiException && error.status == 503 && error.code == "VEHICLE_BERTH_VIEW_HELD"
/** One short pause before the single repeat of the Home GET (a read, never a mutation): the colliding read has finished. */
internal const val BERTH_VIEW_RETRY_MS = 250L
/** A Home read (`/base`, `/balances`) answered a transient server failure: the berth hold above, or a bare 502/503/504 (a
 *  proxy or gateway, no game code) that asks for no wait longer than a second. Coordinator 2026-10-06 (demo build): such a
 *  read is repeated once at once (after [BERTH_VIEW_RETRY_MS]) instead of a cadence tick later (10 s on the field run). A
 *  coded refusal (MAINTENANCE, a game rule) is never repeated and still speaks. */
internal fun transientHomeRead(error: Throwable): Boolean = berthViewHeld(error) ||
    (error is ApiException && error.status in 502..504 && error.code == null && (error.retryAfterSeconds ?: 0L) <= 1L)
private suspend fun homeGet(api: ApiClient, path: String, query: Map<String, String>): JsonObject =
    try { api.get(path, query) } catch (error: ApiException) {
        if (!transientHomeRead(error)) throw error
        kotlinx.coroutines.delay(BERTH_VIEW_RETRY_MS); api.get(path, query)
    }

private class HomeFirstRead(val raw: JsonObject, val base: BaseSnapshot, val query: Map<String, String>, val rawBalances: JsonObject)

suspend fun readHome(api: ApiClient, baseId: String?): HomeSnapshot {
    val baseAt = BootTimeline.clock()
    BootTimeline.stage(LoadEvent.BOOT_BASE_ASK)
    val baseQuery = baseId?.let { mapOf("baseId" to it) }.orEmpty()
    // Optional reads held since sign-in (HomeReadGate) go once /base and /balances have answered, or this read failed.
    val read = try {
        val raw = homeGet(api, "/base", baseQuery)
        BootTimeline.stage(LoadEvent.BOOT_BASE_READ, baseAt)
        val base = BaseSnapshot.from(raw)
        val resolved = requireNotNull(base.baseId?.takeIf { it.isNotBlank() }) { "The server did not identify your base" }
        check(baseId == null || resolved.equals(baseId, ignoreCase = true)) { "The selected base changed. Refresh your kingdom again." }
        val query = mapOf("baseId" to resolved)
        val balancesAt = BootTimeline.clock()
        val rawBalances = homeGet(api, "/balances", query)
        BootTimeline.stage(LoadEvent.BOOT_BALANCES, balancesAt)
        HomeFirstRead(raw, base, query, rawBalances)
    } finally { HomeReadGate.current.release() }
    val raw = read.raw; val base = read.base; val query = read.query; val rawBalances = read.rawBalances
    val balances = Balances.from(rawBalances)
    val tutorialAt = BootTimeline.clock()
    val tutorial = try { TutorialState.from(api.get("/tutorial", query)) }
    catch (error: CancellationException) { throw error }
    catch (error: Exception) { if (error is ApiException && error.status == 401) throw error else null }
    BootTimeline.stage(LoadEvent.BOOT_TUTORIAL, tutorialAt)
    return HomeSnapshot(base, balances, tutorial, rawBalances, raw["fleetJourneyEvents"])
}

/** `POST /base/walls/:id/upgrade-row` answered either with the purchase or with the server's replacement
 * quote (`WALL_ROW_QUOTE_CHANGED` | `WALL_ROW_FUNDS_CHANGED` | `WALL_ROW_UNAVAILABLE` carry `details.quote`). */
sealed interface WallRowOutcome {
    data class Upgraded(val acceptance: WallRowAcceptance) : WallRowOutcome
    data class Repriced(val quote: WallRowQuote, val message: String) : WallRowOutcome
}

/** One dropped piece of a home-scene carry (web `base:move` / `base:moveLine` moves). */
data class BuildingMove(val id: String, val tx: Int, val ty: Int)

interface BaseRepository {
    val state: StateFlow<BaseState>
    /** Invalidates cost observations at Home read start and at balance publication; negative means unsupported. */
    val balanceRevision: Long
    val construction: MoneyOp<ConstructionAcceptance>
    val wallRow: MoneyOp<WallRowAcceptance>
    val layoutUnlock: MoneyOp<LayoutUnlockAcceptance>
    suspend fun refresh()
    /** Accepted-domain/history hydration updates Home without warming or publishing journeys. */
    suspend fun refreshWithoutJourneys() = refresh()
    suspend fun refreshQuests()
    suspend fun refreshMine()
    suspend fun collectMine()
    suspend fun claimDailyCache()
    suspend fun claimQuest(questId: String)
    suspend fun tutorialAction(action: String)
    suspend fun place(type: String, tx: Int, ty: Int)
    suspend fun upgrade(buildingId: String)
    suspend fun finishJob(jobId: String)
    suspend fun reviewBuilderFinish(jobId: String) { error("Builder currency review is unavailable") }
    suspend fun reviewSavedBuilderFinish() { error("Builder currency review is unavailable") }
    suspend fun confirmBuilderFinish() { error("Builder currency review is unavailable") }
    fun dismissBuilderFinishReview() {}
    /** A close the screen makes for its own reasons (the raid interlock or the update gate flipping, a recomposed Home), not
     *  the player's CANCEL/Back on the review: it never withdraws a builder payment already in flight (see the live override). */
    fun retireBuilderFinishReview() = dismissBuilderFinishReview()
    suspend fun cancelJob(jobId: String)
    suspend fun repairTrap(buildingId: String)
    suspend fun clearObstacle(obstacleId: String)
    /** Web `Overlay` 'base:move': `PATCH /base/buildings/:id/move {tx, ty, baseId}`; the Home read that follows settles it. */
    suspend fun moveBuilding(buildingId: String, tx: Int, ty: Int): Unit = throw UnsupportedOperationException("Building moves are unavailable")
    /** Web `Overlay` 'base:moveLine' (#61): `POST /base/buildings/move-batch {moves, baseId}` for a selected wall line. */
    suspend fun moveWalls(moves: List<BuildingMove>): Unit = throw UnsupportedOperationException("Wall line moves are unavailable")
    suspend fun quoteWallRow(wallId: String): WallRowQuote
    suspend fun upgradeWallRow(quote: WallRowQuote): WallRowOutcome
    suspend fun refreshLayouts(): Layouts
    suspend fun unlockFarmLayout(): LayoutUnlockAcceptance
    suspend fun saveLayout(slot: String, mode: String, geometryVersion: Int, expectedSlotEtag: String, expectedActiveEtag: String?, positions: List<LayoutPosition>): LayoutSaveResult
    fun clearNotice()
}

class LiveBaseRepository(
    private val session: AccountSession,
    private val holder: AccountSessionHolder,
    private val api: ApiClient,
    intents: PendingIntentStore,
    private val observer: ReceiptObserver,
    private val baseId: () -> String?,
    private val newKey: () -> String = { UUID.randomUUID().toString() },
    private val catalogue: () -> JsonObject? = { null },
    private val refreshAccount: suspend () -> Unit = {},
    private val baseGeneration: () -> Long = { 0L },
    private val builderActionsAllowed: () -> Boolean = { false },
    private val fleetJourneys: FleetJourneyPublication? = null,
) : BaseRepository {
    private val _state = MutableStateFlow(BaseState())
    private val balanceReads = java.util.concurrent.atomic.AtomicLong()
    override val balanceRevision: Long get() = balanceReads.get()
    private val homeReads = java.util.concurrent.atomic.AtomicLong()
    private val builderRevision = java.util.concurrent.atomic.AtomicLong()
    private val builderAdmission = Mutex()
    private var builderEnqueueGuard: (() -> Unit)? = null
    override val state: StateFlow<BaseState> = _state.asStateFlow()
    private val builderTransport = BuilderSpeedupCurrencyTransport(api.asTransport()) { intent, refusal ->
        val review = requireNotNull(_state.value.builderFinishReview) { "Review the original builder finish first." }
        check(review.intent.nextAttempt() == intent)
        val freshGuard = requireNotNull(builderEnqueueGuard)
        val guard = { requireBuilderReview(review); freshGuard() }
        guard()
        api.postMoneyCommand(intent.path, intent.body, GameCurrency.valueOf(requireNotNull(intent.expectedCurrency)), refusal, guard)
    }
    override val construction = MoneyOp(ConstructionSpec, intents, builderTransport)
    override val wallRow = MoneyOp(WallRowSpec, intents, api.asTransport())
    override val layoutUnlock = MoneyOp(LayoutUnlockSpec, intents, api.asTransport())
    init {
        observer.register(construction) {
            val saved = requireNotNull(construction.pending(session.wallet))
            if (ConstructionSpec.modernBuilder(saved)) hydrateBuilderReceipt(saved) else hydrate(saved.baseId)
        }
        observer.register(wallRow) { hydrate(requireNotNull(wallRow.pending(session.wallet)).baseId) }
        observer.register(layoutUnlock) { hydrate(requireNotNull(layoutUnlock.pending(session.wallet)).baseId) }
    }

    private fun query() = baseId()?.let { mapOf("baseId" to it) }.orEmpty()
    private fun body(extra: JsonObject = buildJsonObject {}) = JsonObject(extra + buildJsonObject { baseId()?.let { put("baseId", it) } })

    private fun requireSelectedBase(expected: String?) {
        check(baseId().equals(expected, ignoreCase = true)) { "Select the original base before resolving this action." }
    }

    private suspend fun hydrate(requestedBaseId: String? = baseId(), publicationGuard: (() -> Unit)? = null,
        ticket: Long = homeReads.get(), publishJourneys: Boolean = false) {
        balanceReads.incrementAndGet()
        requireSelectedBase(requestedBaseId)
        // Only an ordinary live Home read may deliver transient returns. Original
        // receipt hydration never warms a scene or replays historical presentation.
        val journeyCapture = if (publishJourneys && requestedBaseId != null && fleetJourneys != null) {
            val journeyGeneration = baseGeneration()
            fleetJourneys.capture(requestedBaseId, _state.value.base) {
                holder.requireCurrent(session)
                check(baseId() == requestedBaseId && baseGeneration() == journeyGeneration)
                check(ticket == homeReads.get())
            }
        } else null
        val home = readHome(api, requestedBaseId)
        holder.requireCurrent(session)
        requireSelectedBase(requestedBaseId)
        if (ticket != homeReads.get()) throw CancellationException("Home balances superseded")
        _state.update {
            holder.requireCurrent(session); requireSelectedBase(requestedBaseId)
            if (ticket != homeReads.get()) throw CancellationException("Home balances superseded")
            // update may retry its CAS. Check original Workshop authority on every publication
            // attempt, not only after the network read or after the caller has already published.
            publicationGuard?.let { guard ->
                guard(); holder.requireCurrent(session); requireSelectedBase(requestedBaseId)
                if (ticket != homeReads.get()) throw CancellationException("Home balances superseded")
            }
            balanceReads.incrementAndGet()
            it.copy(base = home.base, balances = home.balances, tutorial = home.tutorial, error = null,
                loading = if (publicationGuard != null) false else it.loading)
        }
        // StateFlow's CAS lambda may retry; optional effects only follow its winning
        // publication and still bind the exact clean snapshot that actually survived.
        fleetJourneys?.publishReturns(home.fleetJourneyEvents, home.base, journeyCapture) {
            ticket == homeReads.get() && _state.value.base === home.base
        }
    }
    /** Workshop history keeps its original proof until this guarded snapshot is published.
     * Invalidate older Home reads before fetching post-acceptance values. Unlike the ordinary
     * screen refresh, failure cannot publish errors/loading into a superseded Workshop view. */
    suspend fun refreshForWorkshop(publicationGuard: () -> Unit) {
        balanceReads.incrementAndGet()
        holder.requireCurrent(session); publicationGuard()
        homeReads.incrementAndGet()
        hydrate(publicationGuard = publicationGuard)
    }
    /** Research uses the same guarded balance publication barrier as Workshop history. */
    suspend fun refreshForResearch(publicationGuard: () -> Unit) = refreshForWorkshop(publicationGuard)
    /** A claim refresh invalidates old reads, not any accepted construction or its saved intent. */
    fun invalidateForgeBalance() {
        balanceReads.incrementAndGet()
        holder.requireCurrent(session); homeReads.incrementAndGet()
        _state.update { balanceReads.incrementAndGet(); it.copy(balances = null) }
    }
    suspend fun refreshAfterForgeClaim() {
        balanceReads.incrementAndGet()
        holder.requireCurrent(session); val ticket = homeReads.get()
        _state.update { it.copy(loading = true) }
        try { hydrate() }
        finally { if (holder.isCurrent(session) && ticket == homeReads.get()) _state.update { it.copy(loading = false) } }
    }
    private suspend fun readMine() {
        val mine = MineStatus.from(api.get("/mine/status", query()))
        holder.requireCurrent(session); _state.update { it.copy(mine = mine) }
    }
    /** Presentation freshness after a mining action (web `useMineStatus` reload in `finally`): outside the
     * guard so the action's own message survives; a failed read keeps the last status. */
    private suspend fun refreshMineQuietly() {
        try { readMine() } catch (error: CancellationException) { throw error } catch (error: Exception) { if (error is ApiException && error.status == 401) throw error }
    }

    override suspend fun refresh() = refreshHome(publishJourneys = true)
    override suspend fun refreshWithoutJourneys() = refreshHome(publishJourneys = false)
    private suspend fun refreshHome(publishJourneys: Boolean) {
        balanceReads.incrementAndGet()
        holder.requireCurrent(session)
        // One read owns its publication and loading/error cleanup, even if another read starts.
        val ticket = homeReads.incrementAndGet()
        // A berth decoration still held after its one repeat keeps the last good Home, quietly (no error, no notice): the
        // next cadence tick reads again (berthViewHeld).
        try { guarded(ticket, routine = true) { hydrate(ticket = ticket, publishJourneys = publishJourneys) } }
        catch (error: ApiException) { if (!berthViewHeld(error)) throw error }
    }
    override suspend fun refreshQuests() = guarded(routine = true) {
        val board = QuestBoard.from(api.get("/quests", query()))
        holder.requireCurrent(session); _state.update { it.copy(quests = board) }
    }
    override suspend fun refreshMine() = guarded(routine = true) { readMine() }
    /** Web `MineCollect`: one POST settles every buffer on this deed; the toast is the server amount. */
    override suspend fun collectMine() = guarded {
        try {
            val requestedBase = baseId()
            val receipt = CollectReceipt.from(api.post("/mine/collect", body()))
            audioAccepted(requestedBase, listOf(if (receipt.amount.trimStart('0').isNotEmpty()) UiAudioCue.CONFIRM else UiAudioCue.TAP))
            hydrate()
            _state.update { it.copy(message = if (receipt.amount.trimStart('0').isNotEmpty()) "+${fmtN(receipt.amount)} SHARDS" else "NOTHING TO COLLECT YET") }
        } finally { refreshMineQuietly() }
    }
    /** Web `ClaimScreen`: the daily cache credits this deed's SHARDS; a lost reply is reconciled, never resent. */
    override suspend fun claimDailyCache() = guarded {
        try {
            val requestedBase = baseId()
            val claim = claimDailyCache(_state.value.mine, { api.get("/mine/status", query()) }) {
                api.post("/mine/claim", body()).also { response ->
                    DailyCacheClaim.from(response) // Same acknowledgement validation as the existing helper.
                    audioAccepted(requestedBase, listOf(UiAudioCue.CLAIM, UiAudioCue.COINS))
                }
            }
            hydrate()
            _state.update { it.copy(message = claim?.let { paid -> "+${fmtN(paid.amount)} SHARDS CLAIMED" } ?: "CLAIMED") }
        } finally { refreshMineQuietly() }
    }
    /** Claims use the permanent quest identity; a lost reply is reconciled by re-reading the board. */
    override suspend fun claimQuest(questId: String) = guarded {
        val requestedBase = baseId()
        val board = claimQuestReward(questId, { api.get("/quests", query()) }, {
            api.post("/quests/$questId/claim", body())
            audioAccepted(requestedBase, listOf(UiAudioCue.QUEST))
        })
        holder.requireCurrent(session)
        val quests = QuestBoard.from(board)
        _state.update { it.copy(quests = quests) }
        hydrate()
        // Web `screens/quests.tsx` claim toast: the chain's last step announces what comes next.
        val template = quests.quests.firstOrNull { it.questIdentity == questId }?.templateCode
        _state.update { it.copy(message = if (template == "first_raid") "FIRST STEPS COMPLETE — EXPLORE THE CAMPAIGN AND DAILY QUESTS" else "QUEST CLAIMED") }
    }
    override suspend fun tutorialAction(action: String) = guarded {
        require(action in setOf("advance", "skip", "guide/skip", "guide/resume", "reset"))
        val payload = if (action == "advance") buildJsonObject { put("step", requireNotNull(_state.value.tutorial?.step) + 1) } else buildJsonObject {}
        try { api.post("/tutorial/$action", payload) } finally {
            val tutorial = runCatching { TutorialState.from(api.get("/tutorial", query())) }.getOrNull()
            holder.requireCurrent(session); _state.update { it.copy(tutorial = tutorial) }
        }
    }

    override suspend fun place(type: String, tx: Int, ty: Int) = order(ConstructionSpec.PLACE, "Build $type", buildJsonObject { put("type", type); put("tx", tx); put("ty", ty) })
    // Owner review 2026-10-06 (B2): the level the player upgrades FROM is frozen on the saved request, so a lost reply can
    // later be told apart: still at that level with no job = never applied; above it or running = applied (a real charge).
    override suspend fun upgrade(buildingId: String) = order("/base/buildings/$buildingId/upgrade", "Upgrade building",
        frozen = _state.value.base?.buildings?.firstOrNull { it.id == buildingId }?.let { ConstructionSpec.upgradeQuote(buildingId, it.level) })
    override suspend fun finishJob(jobId: String) = order("/base/jobs/$jobId/speedup", "Finish construction")
    override fun dismissBuilderFinishReview() {
        builderRevision.incrementAndGet()
        _state.update { it.copy(builderFinishReview = null) }
    }
    // Owner Seeker 2026-10-06 16:45 ("The builder review closed. Check its original receipt." on a FINISH): every flip of the
    // raid interlock (the stream reconnects, Home re-entering STARTED resets it to unknown, its first snapshot) and every
    // re-entry of BuilderFinishLifecycle dismissed the review, which bumped the revision under a payment or an accepted
    // receipt still being read (~4 s per QA /base, K-night-07). Those closes are retired: deferred to the end of the builder
    // action in flight, and a no-op when no review is shown. The action's own guards still refuse a changed base, kingdom,
    // admission (raid / update gate) or price; only the player's CANCEL/Back ([dismissBuilderFinishReview]) withdraws consent.
    private val builderRetireLock = Any()
    private var builderRetirePending = false
    override fun retireBuilderFinishReview() {
        synchronized(builderRetireLock) { if (builderAdmission.isLocked) { builderRetirePending = true; return } }
        if (_state.value.builderFinishReview != null) dismissBuilderFinishReview()
    }
    private fun releaseBuilderAdmission() {
        val retire = synchronized(builderRetireLock) { builderRetirePending.also { builderRetirePending = false; builderAdmission.unlock() } }
        if (retire) retireBuilderFinishReview()
    }
    private fun builderCurrent(revision: Long) {
        holder.requireCurrent(session)
        check(builderRevision.get() == revision) { "The builder review closed. Check its original receipt." }
    }
    private fun builderScope(base: String?, generation: Long, revision: Long, admit: Boolean = true) {
        builderCurrent(revision); requireSelectedBase(base)
        check(baseGeneration() == generation) { "The selected kingdom changed. Review the builder job again." }
        if (admit) check(builderActionsAllowed()) { "Game orders are paused. Builder receipts remain available." }
    }
    private fun requireBuilderReview(review: ReviewedBuilderFinishSpend) {
        builderScope(review.intent.baseId, review.generation, review.revision)
        check(_state.value.builderFinishReview === review) { "Review the original builder finish again." }
    }
    private suspend fun builderAction(block: suspend (Long) -> Unit) {
        holder.requireCurrent(session); check(builderAdmission.tryLock()) { "A builder finish request is already running." }
        val revision = builderRevision.get(); val generation = baseGeneration()
        try {
            _state.update { builderCurrent(revision); it.copy(loading = true, error = null, message = null) }
            block(revision)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            _state.update { if (holder.isCurrent(session) && builderRevision.get() == revision && baseGeneration() == generation) it.copy(error = error.message) else it }
            throw error
        } finally {
            _state.update { if (holder.isCurrent(session)) it.copy(loading = false) else it }
            releaseBuilderAdmission()
        }
    }
    private data class BuilderFresh(val home: HomeSnapshot, val capabilities: JsonObject, val guard: () -> Unit)
    private suspend fun freshBuilder(base: String, generation: Long, revision: Long): BuilderFresh {
        balanceReads.incrementAndGet()
        builderScope(base, generation, revision)
        val ticket = homeReads.incrementAndGet()
        val guard = { builderScope(base, generation, revision); check(homeReads.get() == ticket) { "Home read superseded. Review again." } }
        refreshAccount(); guard()
        val capabilities = api.get("/native/capabilities"); guard()
        val home = readHome(api, base); guard()
        return BuilderFresh(home, capabilities, guard)
    }
    private fun builderTerms(fresh: BuilderFresh, jobId: String, key: String) = BuilderJobSpeedup.prepare(jobId,
        requireNotNull(fresh.home.base.baseId), key, fresh.home.base.raw, fresh.home.rawBalances, fresh.capabilities)
    private fun matchBuilder(intent: PendingIntent, fresh: BuilderFresh) {
        val original = ConstructionSpec.builderTerms(intent); val current = builderTerms(fresh, original.jobId, original.idempotencyKey)
        check(current.baseId == original.baseId && current.consent.copy(maxCostKeep = original.consent.maxCostKeep) == original.consent &&
            current.consent.maxCostKeep.toBigInteger() <= original.consent.maxCostKeep.toBigInteger()) { "Builder job or price changed. Keep the original receipt." }
        ExactGameCurrency.requireCovered(original.expectedCurrency, current.consent.maxCostKeep, fresh.home.rawBalances)
    }
    private fun publishBuilder(fresh: BuilderFresh, review: ReviewedBuilderFinishSpend) {
        _state.update { fresh.guard(); balanceReads.incrementAndGet(); it.copy(base = fresh.home.base, balances = fresh.home.balances, tutorial = fresh.home.tutorial, builderFinishReview = review) }
    }
    override suspend fun reviewBuilderFinish(jobId: String) {
        dismissBuilderFinishReview()
        builderAction { revision ->
            check(construction.blocking(session.wallet) == null) { "Check the interrupted construction before another payment." }
            val base = requireNotNull(baseId()); val generation = baseGeneration()
            val fresh = freshBuilder(base, generation, revision)
            val intent = ConstructionSpec.builderIntent(session.wallet, builderTerms(fresh, jobId, newKey()))
            publishBuilder(fresh, ReviewedBuilderFinishSpend(intent, generation, revision))
        }
    }
    override suspend fun reviewSavedBuilderFinish() {
        dismissBuilderFinishReview()
        builderAction { revision ->
            val original = construction.pending(session.wallet) ?: return@builderAction
            check(ConstructionSpec.modernBuilder(original)) { "Use the saved legacy construction recovery." }
            ConstructionSpec.builderTerms(original)
            construction.observe(session.wallet) { hydrateBuilderReceipt(requireNotNull(construction.pending(session.wallet))) }
            builderCurrent(revision)
            val saved = construction.pending(session.wallet) ?: return@builderAction
            check(saved.receipt == null)
            val generation = baseGeneration(); val fresh = freshBuilder(requireNotNull(saved.baseId), generation, revision)
            matchBuilder(saved, fresh)
            publishBuilder(fresh, ReviewedBuilderFinishSpend(saved, generation, revision))
        }
    }
    override suspend fun confirmBuilderFinish() = builderAction { _ ->
        val review = requireNotNull(_state.value.builderFinishReview) { "Review the builder finish first." }
        val guard = { requireBuilderReview(review) }
        try {
            guard()
            val fresh = freshBuilder(requireNotNull(review.intent.baseId), review.generation, review.revision)
            matchBuilder(review.intent, fresh); guard(); fresh.guard(); builderEnqueueGuard = fresh.guard
            val hydrate: suspend (Receipt.Accepted<ConstructionAcceptance>) -> Unit = { guard(); hydrateBuilderReceipt(review.intent, guard) }
            val saved = construction.pending(session.wallet)
            if (saved != null) { check(saved == review.intent); construction.retry(session.wallet, hydrate) }
            else { check(!review.intent.attempted); construction.submit(review.intent, hydrate) }
        } finally { builderEnqueueGuard = null; dismissBuilderFinishReview(); observer.refresh(session.wallet) }
    }
    private suspend fun hydrateBuilderReceipt(intent: PendingIntent, originalGuard: (() -> Unit)? = null) {
        balanceReads.incrementAndGet()
        ConstructionSpec.builderTerms(intent)
        val revision = builderRevision.get()
        val current = { builderCurrent(revision); originalGuard?.invoke(); Unit }
        current(); refreshAccount(); current()
        val selected = baseId(); val generation = baseGeneration(); val ticket = homeReads.incrementAndGet()
        val guard = { current(); builderScope(selected, generation, revision, admit = false); check(homeReads.get() == ticket) { "Home read superseded" } }
        guard()
        if (selected != null) hydrate(selected, guard)
        _state.update {
            guard()
            if (selected == null) balanceReads.incrementAndGet()
            if (selected == null) it.copy(base = null, balances = null, tutorial = null, message = "Earlier builder payment confirmed. Select a kingdom to refresh Home.")
            else it.copy(message = "Earlier builder payment confirmed in ${intent.expectedCurrency}.")
        }
        guard()
    }
    /** Web ActionSheet CANCEL → `UPGRADE CANCELLED · +n SHARDS` from the server's own refund. */
    override suspend fun cancelJob(jobId: String) = order("/base/jobs/$jobId/cancel", "Cancel upgrade") { response ->
        response.string("refundShards")?.let { "UPGRADE CANCELLED · +${fmtN(it)} SHARDS" }
    }
    override suspend fun repairTrap(buildingId: String) = order("/base/buildings/$buildingId/repair", "Repair trap")
    override suspend fun clearObstacle(obstacleId: String) = order("/base/obstacles/$obstacleId/clear", "Clear obstacle")
    /** A move is a plain order, not a money op: the web sends it once and re-reads; a refusal reverts through the read. */
    override suspend fun moveBuilding(buildingId: String, tx: Int, ty: Int) = guarded {
        val requestedBase = baseId()
        val wall = _state.value.base?.buildings?.firstOrNull { it.id == buildingId }?.type == "wall"
        api.patch("/base/buildings/$buildingId/move", body(buildJsonObject { put("tx", tx); put("ty", ty) }))
        audioAccepted(requestedBase, listOf(if (wall) UiAudioCue.WALL else UiAudioCue.PLACE))
        hydrate(requestedBase)
    }
    override suspend fun moveWalls(moves: List<BuildingMove>) = guarded {
        require(moves.isNotEmpty()) { "No walls to move" }
        val requestedBase = baseId()
        api.post("/base/buildings/move-batch", body(buildJsonObject {
            put("moves", JsonArray(moves.map { buildJsonObject { put("id", it.id); put("tx", it.tx); put("ty", it.ty) } }))
        }))
        audioAccepted(requestedBase, listOf(UiAudioCue.WALL))
        hydrate(requestedBase)
    }

    private suspend fun order(path: String, label: String, fields: JsonObject = buildJsonObject {}, frozen: JsonObject? = null,
        message: (JsonObject) -> String? = { null }) = guarded {
        val plotVersion = _state.value.base?.plotVersion ?: 1
        val plot = catalogue()?.let { PlotGeometry.from(it, plotVersion) } ?: run {
            check(plotVersion == 1) { "Load compatible content before placing on this plot." }
            PlotGeometry.supported(plotVersion)
        }
        if (path == ConstructionSpec.PLACE) require(plot.contains(fields.getValue("tx").jsonPrimitive.int, fields.getValue("ty").jsonPrimitive.int)) { "Choose a tile inside this plot." }
        val quote = if (path == ConstructionSpec.PLACE && plot.version != 1) buildJsonObject { put("plotGeometry", plot.json) } else frozen
        val key = newKey()
        val request = JsonObject(body(fields) + buildJsonObject { put("idempotencyKey", key) })
        val intent = PendingIntent(IntentKind.CONSTRUCTION, session.wallet, baseId(), key, path, request, label, quote)
        try {
            val accepted = construction.submit(intent) {
                // MoneyOp persisted the POST acknowledgement for this frozen intent before this callback.
                // A failed hydration retains its proof but cannot replay or reverse this sound.
                val cue = if (path == ConstructionSpec.PLACE) {
                    if (fields.string("type") == "wall") UiAudioCue.WALL else UiAudioCue.PLACE
                } else UiAudioCue.CONFIRM
                audioAccepted(intent.baseId, listOf(cue))
                hydrate(intent.baseId)
            }
            _state.update { it.copy(message = message(ReceiptDocument.payload(accepted.document)) ?: "${accepted.value.label} accepted") }
        } finally { observer.refresh(session.wallet) }
    }

    /** Web `WallRowUpgrade.preview`: the server quotes the row through this wall (`wallRowThrough`) and freezes it by `quoteId`. */
    override suspend fun quoteWallRow(wallId: String): WallRowQuote {
        var quote: WallRowQuote? = null
        guarded {
            quote = WallRowQuote.from(api.post("/base/walls/$wallId/upgrade-quote", body()))
            holder.requireCurrent(session)
        }
        return requireNotNull(quote)
    }
    /** Web `WallRowUpgrade.purchase`: the highlighted row is one explicit purchase. A re-priced refusal
     * re-presents the server's replacement quote; failed transport keeps the key for RETRY SAME UPGRADE. */
    override suspend fun upgradeWallRow(quote: WallRowQuote): WallRowOutcome {
        var outcome: WallRowOutcome? = null
        guarded {
            val intent = WallRowSpec.intent(session.wallet, baseId(), quote, newKey())
            try {
                val accepted = wallRow.submit(intent) { hydrate(intent.baseId) }
                _state.update { it.copy(message = "ROW UPGRADED") }
                outcome = WallRowOutcome.Upgraded(accepted.value)
            } catch (error: ApiException) {
                val replacement = if (error.code in WallRowSpec.REPRICED) (error.details["quote"] as? JsonObject)?.let { runCatching { WallRowQuote.from(it) }.getOrNull() } else null
                if (replacement == null) throw error
                outcome = WallRowOutcome.Repriced(replacement, error.message)
            } finally { observer.refresh(session.wallet) }
        }
        return requireNotNull(outcome)
    }

    private fun layoutBase(): String = requireNotNull(baseId()) { "SELECT AN ACTIVE DEEDED BASE FIRST." }
    override suspend fun refreshLayouts(): Layouts {
        var layouts: Layouts? = null
        guarded {
            val requestedBaseId = layoutBase()
            val read = Layouts.from(api.get("/base/layouts", mapOf("baseId" to requestedBaseId)))
            holder.requireCurrent(session)
            requireSelectedBase(requestedBaseId)
            check(read.baseId.equals(requestedBaseId, ignoreCase = true)) { "The layouts answered for another base." }
            _state.update { it.copy(layouts = read) }; layouts = read
        }
        return requireNotNull(layouts)
    }
    override suspend fun unlockFarmLayout(): LayoutUnlockAcceptance {
        var accepted: LayoutUnlockAcceptance? = null
        guarded {
            val intent = LayoutUnlockSpec.intent(session.wallet, layoutBase(), newKey())
            try { accepted = layoutUnlock.submit(intent) { hydrate(intent.baseId) }.value } finally { observer.refresh(session.wallet) }
        }
        return requireNotNull(accepted)
    }
    /** `PUT /base/layouts/:slot` (web `layoutClient.save`): coordinates only, fenced by the slot and active ETags the editor read. */
    override suspend fun saveLayout(slot: String, mode: String, geometryVersion: Int, expectedSlotEtag: String, expectedActiveEtag: String?, positions: List<LayoutPosition>): LayoutSaveResult {
        require(slot == "HOME" || slot == "FARM") { "Unknown layout slot" }
        require(mode == "save" || mode == "save_apply") { "Unknown layout save mode" }
        var result: LayoutSaveResult? = null
        guarded {
            val requestedBaseId = layoutBase()
            val payload = buildJsonObject {
                put("baseId", requestedBaseId); put("geometryVersion", geometryVersion); put("mode", mode); put("expectedSlotEtag", expectedSlotEtag)
                expectedActiveEtag?.let { put("expectedActiveEtag", it) }
                put("positions", JsonArray(positions.map { ApiJson.encodeToJsonElement(LayoutPosition.serializer(), it) }))
            }
            val saved = LayoutSaveResult.from(api.put("/base/layouts/$slot", payload))
            check(saved.baseId.equals(requestedBaseId, ignoreCase = true) && saved.slot == slot && saved.geometryVersion == geometryVersion) { "The saved layout differs from the request." }
            hydrate(requestedBaseId)
            result = saved
        }
        return requireNotNull(result)
    }

    override fun clearNotice() { _state.update { it.copy(error = null, message = null) } }

    private suspend fun audioAccepted(requestedBase: String?, cues: List<UiAudioCue>) {
        val context = currentCoroutineContext()
        if (context.isActive && holder.isCurrent(session) && baseId().equals(requestedBase, ignoreCase = true))
            context[BaseAudioAction]?.accepted(session, requestedBase, cues)
    }

    /** The Home on screen already belongs to the selected base (or to the server default when nothing is selected). */
    private fun showsSelectedBase(state: BaseState): Boolean {
        val shown = state.base?.baseId?.takeIf { it.isNotBlank() } ?: return false
        val requested = baseId()
        return requested == null || shown.equals(requested, ignoreCase = true)
    }

    /** [routine]: a re-read (cadence tick, sheet re-read, post-acceptance HUD refresh) over the base already shown does not
     * raise [BaseState.loading] (owner 2026-10-06 "always loading"): the last good Home stays drawn, its doors stay open and
     * the answer replaces it in place. The first read of a base, a base switch and every action still raise it. The
     * ticketed cleanup in `finally` is unchanged, so an older superseded action's flag is still released. */
    private suspend fun guarded(ticket: Long = homeReads.get(), routine: Boolean = false, block: suspend () -> Unit) {
        holder.requireCurrent(session)
        _state.update {
            holder.requireCurrent(session)
            if (ticket != homeReads.get()) throw CancellationException("Home balances superseded")
            it.copy(loading = it.loading || !routine || !showsSelectedBase(it), error = null, message = null)
        }
        try { block() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            // A refusal the land gate or the funds sheet already explains is not repeated here (web `isHandledGlobally`);
            // a held berth decoration is not an error of the kingdom at all (berthViewHeld: no red toast, no Report).
            if (holder.isCurrent(session) && ticket == homeReads.get() && !ApiRouting.handledGlobally(error) && !berthViewHeld(error)) {
                val context = currentCoroutineContext()
                val audio = context[BaseAudioAction]
                if (context.isActive && audio != null && baseId().equals(audio.baseId, ignoreCase = true)) audio.failed(session, audio.baseId)
                _state.update {
                    if (holder.isCurrent(session) && ticket == homeReads.get()) it.copy(error = error.message ?: "Connection interrupted. Please retry.") else it
                }
            }
            throw error
        } finally { _state.update { if (holder.isCurrent(session) && ticket == homeReads.get()) it.copy(loading = false) else it } }
    }
}
