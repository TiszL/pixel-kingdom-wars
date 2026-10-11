package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID
import java.io.IOException

/** Transport details (including DNS hostnames) are diagnostics, not player-facing recovery instructions. */
fun battleFailureMessage(error: Exception): String =
    if (error is IOException && error !is ApiException && error !is ApiCompatibilityException && error !is SecretStorageException)
        "Can't connect to the game. Check your connection and try again."
    else error.message ?: "Battle request interrupted. Your saved request is safe."

/** D153.333 (a): the refusals after which no raid can exist for the saved create key, on ANY attempt. 403/404/422 are
 * answered after createRaid's idempotent fast path would have returned a committed raid; 409 RAID_IDEMPOTENCY_MISMATCH
 * says this exact body can never succeed under its key. 401, 429, any other 409, 5xx and a lost answer stay uncertain. */
fun isTerminalRaidCreateRefusal(error: Throwable): Boolean = error is ApiException &&
    (error.status in setOf(403, 404, 422) || (error.status == 409 && error.code == "RAID_IDEMPOTENCY_MISMATCH"))

enum class BattlePhase { EMPTY, RECOVERY, STAGING, RUNNING, RESULT, EXPIRED, UNSUPPORTED }
/** Ephemeral presentation only; callbacks never determine request or receipt state. */
interface BattleCommandFeedback {
    fun notEnqueued()
    fun enqueued(id:String)
    fun refused(id:String)
}
data class LiveBattleState(val phase: BattlePhase = BattlePhase.EMPTY, val pending: PendingBattle? = null,
    val presentation: JsonObject? = null, val clock: BattleClock? = null, val commands: List<JsonObject> = emptyList(),
    val result: JsonObject? = null, val candidates: List<JsonObject> = emptyList(), val connected: Boolean = false,
    val error: String? = null, val blocked: Boolean = false, val inFlight: Set<String> = emptySet(), val creating: Boolean = false,
    val expired: Boolean = false,
    /** In-memory admission while awaiting durable storage; never eligible for POST/retry by itself. */
    val preparingWrites: List<PendingBattleWrite> = emptyList()) {
    val terminal: Boolean get() = result != null || expired
    /** Web RaidUI.liveDeployEndsAtMs: the server order deadline includes the battle duration.
     * Display only. The canonical clock wins; an explicit catalogue duration supports staging before its arrival.
     * Missing/old metadata stays unavailable, and this value never determines command acceptance or expiry. */
    fun deployEndsAtMs(catalogueBattleDurationMs: Long? = null): Long? {
        if (phase != BattlePhase.STAGING || terminal || clock?.value?.anchorWallAt != null) return null
        val deadline = battleOrdersDeadlineEpochMs(pending?.ordersDeadlineAt) ?: return null
        val duration = (clock?.value?.durationMs ?: catalogueBattleDurationMs)?.takeIf { it > 0 } ?: return null
        return runCatching { Math.subtractExact(deadline, duration) }.getOrNull()
    }
    /** Web `canChooseNextTarget` (RaidUI.tsx): NEXT TARGET re-rolls the automatic match only while nothing has been
     * committed — a stable PvP defender, protocol 2, staged (the clock never anchored), no accepted or reserved
     * command, no unresolved write, and a live connection. Deploying anything makes the entry final. */
    val canChooseNextTarget: Boolean get() = pending?.pvpDefenderBaseId != null && phase == BattlePhase.STAGING && presentation != null &&
        presentation.string("raidProtocolVersion") == "2" && clock?.value?.anchorWallAt == null && commands.isEmpty() &&
        pending.writes.isEmpty() && preparingWrites.isEmpty() && inFlight.isEmpty() && connected && !blocked && !creating
    /** An attempted retreat whose acknowledgement was lost: the exact request the player may resend. */
    val unresolvedRetreat: PendingBattleWrite? get() = pending?.writes?.firstOrNull { it.path.endsWith("/finish") && it.body.flag("retreat") }
    /** A result/retreat send may already have settled on the server. Do not allocate another FINISH while unknown. */
    val unresolvedFinish: PendingBattleWrite? get() = (pending?.writes.orEmpty() + preparingWrites).firstOrNull { it.path.endsWith("/finish") }
    fun reserved(kind: String, field: String? = null, value: String? = null): Boolean {
        fun matches(command: JsonObject) = command.string("kind") == kind && (field == null || (command["payload"] as? JsonObject)?.string(field) == value)
        return commands.any(::matches) || (pending?.writes.orEmpty() + preparingWrites).any { (it.body["command"] as? JsonObject)?.let(::matches) == true }
    }
    fun available(troop: String): Int {
        val total = (presentation?.get("armySnapshot") as? JsonObject)?.get("counts")?.jsonObject?.string(troop)?.toIntOrNull() ?: 0
        val accepted = commands.count { it.string("kind") == "deploy" && (it["payload"] as? JsonObject)?.string("troop") == troop }
        val acceptedIds = commands.mapNotNull { it.string("clientCommandId") }.toSet()
        val reserved = (pending?.writes.orEmpty() + preparingWrites).distinctBy { it.id }.filterNot { it.id in acceptedIds }.count {
            (it.body["command"] as? JsonObject)?.let { command -> command.string("kind") == "deploy" && (command["payload"] as? JsonObject)?.string("troop") == troop } == true
        }
        return (total - accepted - reserved).coerceAtLeast(0)
    }
}

/** Web `RaidTarget` kinds a create can name (`kind:'campaign'` | `kind:'pvp'`); PvE camps are not native yet. */
sealed interface RaidCreateTarget {
    data class Campaign(val stage: Int) : RaidCreateTarget { init { require(stage > 0) } }
    /** Null defender = FIND ME A TARGET; a defender = map pick / revenge; [excludeBaseId] = NEXT TARGET after a
     * confirmed retreat. The server refuses exclusion combined with an explicit defender, so the client does too. */
    data class Pvp(val defenderWallet: String? = null, val defenderBaseId: String? = null, val excludeBaseId: String? = null, val name: String? = null) : RaidCreateTarget {
        init { require(excludeBaseId == null || (defenderWallet == null && defenderBaseId == null)) { "target exclusion cannot be combined with an explicit defender" } }
    }
}

/** A pending or created raid row names its defender; a campaign stage names none (web `targetForResumedRaid`). */
internal fun raidTargetOf(raid: JsonObject): PendingRaidTarget? =
    if (raid.string("campaignStage") != null) null else PendingRaidTarget(raid.string("defenderWallet"), raid.string("defenderBaseId"))

// UI freshness cadence for a saved create's status reads (D153.333 c), not a game rule: 5 s doubling to a 30 s cap.
internal const val PENDING_RAID_POLL_MS = 5_000L
internal const val PENDING_RAID_POLL_MAX_MS = 30_000L
/** Wait before unprompted status read number [polls] (0-based): 5, 10, 20, 30, 30 … */
internal fun pendingRaidPollMs(polls: Int): Long = (PENDING_RAID_POLL_MS shl polls.coerceAtMost(3)).coerceAtMost(PENDING_RAID_POLL_MAX_MS)

/** One instance per authenticated wallet/deed, owned by the ViewModel. The caller
 * collects runForeground in repeatOnLifecycle; cancellation stops reads. User
 * mutation calls use that ViewModel's scope, never a global worker or POST retry.
 * Close/cancel the owning scope on account change before constructing another. */
class BattleCoordinator internal constructor(
    val wallet: String, val baseId: String, private val simVersion: Int, private val store: PendingBattleStore,
    private val get: suspend (String, Map<String, String>) -> JsonObject,
    private val post: suspend (String, JsonObject) -> JsonObject,
    private val presentation: (String) -> Flow<JsonObject>,
    private val now: () -> Long = System::nanoTime,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    val sessionToken: SessionToken? = null,
    private val timing: BattleCommandTiming? = null,
    /** The observer this coordinator wakes after an acknowledged command (see [BattlePresentationWake]). */
    private val wake: BattlePresentationWake? = null,
    private val pendingPollMs: (Int) -> Long = ::pendingRaidPollMs,
) {
    constructor(wallet: String, baseId: String, simVersion: Int, store: PendingBattleStore, api: GameApi,
                session: SessionToken = api.sessionToken(), timing: BattleCommandTiming? = null,
                wake: BattlePresentationWake = BattlePresentationWake()) :
        this(wallet, baseId, simVersion, store, { path, query -> api.get(path, query, session = session) },
            { path, body -> api.postBattle(path, body, session, timing) },
            BattlePresentation({ path, query -> api.get(path, query, session = session) }, simVersion,
                beginPreparation = { timing?.preparation() },
                observedGet = { path, query, observer -> api.getPresentation(path, query, session, observer) }, wake = wake,
                retryRateLimits = false)::observe,
            sessionToken = session, timing = timing, wake = wake)
    companion object {
        /** A coordinator over a caller-supplied transport (repository tests, alternative sessions); the persist-before-POST,
         * no-retry and GET-only recovery policy above is unchanged. */
        fun withTransport(wallet: String, baseId: String, simVersion: Int, store: PendingBattleStore,
                          get: suspend (String, Map<String, String>) -> JsonObject, post: suspend (String, JsonObject) -> JsonObject,
                          presentation: (String) -> Flow<JsonObject>): BattleCoordinator = BattleCoordinator(wallet, baseId, simVersion, store, get, post, presentation)
        /** The same coordinator sharing a [wake] with the caller's presentation observer. */
        fun withTransport(wallet: String, baseId: String, simVersion: Int, store: PendingBattleStore,
                          get: suspend (String, Map<String, String>) -> JsonObject, post: suspend (String, JsonObject) -> JsonObject,
                          presentation: (String) -> Flow<JsonObject>, wake: BattlePresentationWake): BattleCoordinator =
            BattleCoordinator(wallet, baseId, simVersion, store, get, post, presentation, wake = wake)
    }
    private val gate = Mutex()
    private val foreground = Mutex()
    private val entryRefresh = Channel<Unit>(Channel.CONFLATED)
    /** Monotonic read backoff survives foreground cancellation/reentry; a Retry tap cannot shorten it. */
    private var readBackoff: Pair<Long, Long>? = null
    private var finishBackoff: Pair<Long, Long>? = null
    private var pendingPolls = 0
    private val flight = mutableSetOf<String>()
    private var saved = store.get(wallet, baseId)
    private val accepted = sortedMapOf<Int, JsonObject>()
    private val _state = MutableStateFlow(LiveBattleState(pending = saved, phase = if (saved == null) BattlePhase.EMPTY else BattlePhase.RECOVERY))
    val state: StateFlow<LiveBattleState> = _state.asStateFlow()

    fun beginInputTiming(): BattleInputTiming? = runCatching { timing?.input() }.getOrNull()
    private fun timed(id: String, stage: BattleCommandStage) { runCatching { timing?.stage(id, stage) } }

    /** Foreground recovery performs reads only. An unknown create response needs
     * explicit retry of its saved identity; it never silently starts another raid. */
    suspend fun runForeground() {
        if (!foreground.tryLock()) return
        pendingPolls = 0
        try {
            while (currentCoroutineContext().isActive) {
                try {
                    readBackoff?.let { (started, duration) ->
                        val remaining = duration - (now() - started)
                        if (remaining > 0) delay(remaining / 1_000_000 + 1)
                        readBackoff = null
                    }
                    val raid = gate.withLock { saved?.raidId }
                    if (raid == null) {
                        val pending = get("/raids/pending", emptyMap()).objects("raids").filter { it.string("attackerBaseId") == baseId }
                        gate.withLock { _state.update { it.copy(candidates = pending, connected = true, error = null) } }
                        awaitPendingPoll()
                    } else {
                        presentation(raid).takeWhile { applyPresentation(raid, it); !state.value.terminal && !state.value.blocked }.collect()
                        if (state.value.terminal || state.value.blocked) return
                        delay(500)
                    }
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    gate.withLock { _state.update { it.copy(connected = false, error = battleFailureMessage(error),
                        blocked = it.blocked || error is IllegalArgumentException || error is ApiCompatibilityException ||
                            (error is ApiException && error.status in setOf(401, 403))) } }
                    // The owner invalidates only this request's session. Losing
                    // authentication never discards an uncertain saved order.
                    if (error is ApiException && error.status == 401) throw error
                    if (state.value.blocked || error is ApiCompatibilityException || error is IllegalArgumentException) return
                    // Explicit retries cannot bypass the server's read backoff.
                    if (error is ApiException && error.status == 429) {
                        val seconds = error.retryAfterSeconds?.takeIf { it > 0 } ?: 2L
                        readBackoff = now() to (seconds.coerceAtMost(Long.MAX_VALUE / 1_000_000_000) * 1_000_000_000)
                    } else if (gate.withLock { saved?.raidId } == null) awaitPendingPoll() else awaitEntryRefresh(2_000)
                }
            }
        } finally { foreground.unlock() }
    }

    suspend fun createCampaign(stage: Int) = createRaid(RaidCreateTarget.Campaign(stage))

    /** Ask the single foreground observer for a fresh read. Never run a competing presentation collector or
     * infer a saved create's identity from an arbitrary pending row. Repeated taps coalesce; no POST is sent. */
    suspend fun refreshEntry() { entryRefresh.trySend(Unit) }

    private suspend fun awaitEntryRefresh(delayMs: Long): Boolean = withTimeoutOrNull(delayMs) { entryRefresh.receive() } != null

    /** (c) With nothing saved the reader parks until a create, retry, resume, discard or CHECK wakes it and reads once;
     * a saved create re-reads on [pendingPollMs]'s schedule, which any wake restarts. 429 Retry-After still wins first. */
    private suspend fun awaitPendingPoll() {
        if (gate.withLock { saved == null }) { entryRefresh.receive(); pendingPolls = 0 }
        else if (awaitEntryRefresh(pendingPollMs(pendingPolls++))) pendingPolls = 0
    }

    /** Web `raidCreateRequest` (RaidUI.tsx): one create per logical target — `/campaign/:stage/raid` for a stage,
     * `/raids` for PvP with an explicit defender (map pick, revenge) or the automatic match, optionally excluding
     * the deed a confirmed NEXT TARGET retreat just left. The idempotency key is persisted before the POST. */
    suspend fun createRaid(target: RaidCreateTarget) {
        gate.withLock {
            check(!state.value.creating && saved == null && !state.value.blocked) { "Recover the existing march before starting another" }
            // Guard navigation/content activation before the first read suspends.
            _state.update { it.copy(creating = true, error = null) }
        }
        try {
            val capabilities = get("/native/capabilities", emptyMap())
            require(capabilities.string("simVersion")?.toIntOrNull() == simVersion)
            require((capabilities["presentation"] as? JsonObject)?.flag("enabled") == true) { "Native battles are unavailable on this server" }
            val pending = get("/raids/pending", emptyMap()).objects("raids").filter { it.string("attackerBaseId") == baseId }
            gate.withLock { _state.update { it.copy(candidates = pending) } }
            val write = gate.withLock {
                check(saved == null && !state.value.blocked && state.value.candidates.isEmpty()) { "Recover the existing march before starting another" }
                val id = newId()
                val request = when (target) {
                    is RaidCreateTarget.Campaign -> PendingBattleWrite(id, "/campaign/${target.stage}/raid", buildJsonObject {
                        put("idempotencyKey", id); put("attackerBaseId", baseId); put("raidProtocolVersion", 2)
                    })
                    is RaidCreateTarget.Pvp -> PendingBattleWrite(id, "/raids", buildJsonObject {
                        put("attackerBaseId", baseId); put("idempotencyKey", id); put("raidProtocolVersion", 2)
                        target.defenderWallet?.let { put("defenderWallet", it) }
                        target.defenderBaseId?.let { put("defenderBaseId", it) }
                        target.excludeBaseId?.let { put("excludeBaseId", it) }
                    })
                }
                persist(PendingBattle(wallet, baseId, stage = (target as? RaidCreateTarget.Campaign)?.stage, create = request,
                    target = (target as? RaidCreateTarget.Pvp)?.let { PendingRaidTarget(it.defenderWallet, it.defenderBaseId, it.excludeBaseId, it.name) }))
                publish()
                request
            }
            send(write.id, creation = true)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            gate.withLock { _state.update { it.copy(error = battleFailureMessage(error), blocked = it.blocked || error is ApiCompatibilityException) } }
            throw error
        } finally {
            withContext(NonCancellable) { gate.withLock { _state.update { it.copy(creating = false) } }; refreshEntry() }
        }
    }

    suspend fun resumeRaid(raidId: String) {
        val response = get("/raids/pending/$raidId", emptyMap())
        val raid = requireNotNull(response["raid"] as? JsonObject) { "This march is no longer pending; recover its saved result" }
        require(raid.string("id") == raidId && raid.string("attackerBaseId") == baseId)
        require(raid.string("simVersion")?.toIntOrNull() == simVersion && raid.string("raidProtocolVersion") == "2") { "This march requires legacy recovery" }
        gate.withLock {
            check(saved == null || saved?.raidId == raidId) { "Recover the saved request before selecting another march" }
            val record = saved ?: PendingBattle(wallet, baseId, raidId, raid.string("campaignStage")?.toIntOrNull(), target = raidTargetOf(raid))
            persist(record.copy(ordersDeadlineAt = battleOrdersDeadlineAt(raid["ordersDeadlineAt"])))
            publish()
        }
        refreshEntry()
    }

    suspend fun deploy(troop: String, x: Int, y: Int, feedback:BattleCommandFeedback?=null, inputTiming:BattleInputTiming?=null) = command("deploy", buildJsonObject { put("troop", troop); put("tx", x); put("ty", y) },feedback,inputTiming)
    suspend fun hero(hero: String, x: Int, y: Int, feedback:BattleCommandFeedback?=null, inputTiming:BattleInputTiming?=null) = command("hero", buildJsonObject { put("hero", hero); put("tx", x); put("ty", y) },feedback,inputTiming)
    suspend fun rally(x: Int, y: Int) = command("rally", buildJsonObject { put("tx", x); put("ty", y) })
    suspend fun buff(buff: String) = command("buff", jsonBody("buff" to buff))
    private suspend fun command(kind: String, payload: JsonObject, feedback:BattleCommandFeedback?=null, inputTiming:BattleInputTiming?=null) {
        val id = enqueue(feedback,inputTiming) { current, raid, id ->
            if (kind == "deploy") check(current.available(requireNotNull(payload.string("troop"))) > 0) { "No unreserved troops remain" }
            if (kind == "hero") check(!current.reserved(kind, "hero", payload.string("hero"))) { "That hero is already reserved" }
            if (kind == "buff") check(!current.reserved(kind, "buff", payload.string("buff"))) { "That buff is already reserved" }
            if (kind == "rally") check(!current.reserved(kind)) { "The rally point is already reserved" }
            PendingBattleWrite(id, "/raids/$raid/commands", buildJsonObject {
                put("clientCommandId", id); put("command", buildJsonObject { put("kind", kind); put("payload", payload) })
            })
        }
        // A presentation observer cannot prevent a saved command from following
        // the existing send/recovery contract, nor turn acceptance into failure.
        runCatching { feedback?.enqueued(id) }
        send(id,feedback=feedback)
    }
    suspend fun start() = control("start", null)
    suspend fun speed(rate: Int) { require(rate in 1..2); control("speed", rate) }
    private suspend fun control(kind: String, rate: Int?) {
        val id = enqueue { current, raid, id -> PendingBattleWrite(id, "/raids/$raid/$kind", buildJsonObject {
            put("clientCommandId", id); put("expectedClockRevision", requireNotNull(current.clock).value.revision)
            rate?.let { put("rate", it) }
        }) }
        send(id)
    }
    suspend fun retreat() {
        val id = enqueue { _, raid, id -> PendingBattleWrite(id, "/raids/$raid/finish", buildJsonObject { put("retreat", true); put("clientCommandId", id) }) }
        send(id)
    }
    /** Server proves early completion or returns RAID_CLOCK_NOT_DUE. Never infer
     * rewards from a predicted last event or mark Home available on a timer. */
    suspend fun finish() {
        gate.withLock { requireFinishAvailable() }
        val id = enqueue { current, raid, id ->
            check(current.unresolvedFinish == null) { "Check the saved battle request before asking for another result." }
            PendingBattleWrite(id, "/raids/$raid/finish", buildJsonObject {})
        }
        send(id)
    }
    private fun requireFinishAvailable() {
        val remaining = finishBackoff?.let { (started, duration) -> duration - (now() - started) } ?: 0
        check(remaining <= 0) { "Please wait ${(remaining / 1_000_000_000) + 1} seconds before checking the result again." }
        finishBackoff = null
    }
    suspend fun retry(id: String) {
        val creation = gate.withLock {
            val isCreation = saved?.create?.id == id
            if (isCreation) {
                check(!state.value.creating) { "The raid request is already being sent" }
                _state.update { it.copy(creating = true) }
            }
            isCreation
        }
        try { send(id, creation) }
        finally { if (creation) withContext(NonCancellable) { gate.withLock { _state.update { it.copy(creating = false) } }; refreshEntry() } }
    }
    suspend fun home() = gate.withLock {
        check(!state.value.creating && state.value.terminal) { "Wait for the server's battle result or expiry before returning home" }
        saved?.let { clearPersisted(it) }; accepted.clear()
        _state.value = LiveBattleState()
    }
    /** D153.333 (d): forget an unconfirmed create on this device by the player's confirmed choice. Nothing is sent. The server's
     * pending list stays the ground truth: a raid it did commit under this key is resumed from there (recoverOnEntry, raid log). */
    suspend fun discardCreate(id: String) = gate.withLock {
        val record = checkNotNull(saved) { "There is no saved raid request to discard" }
        check(record.raidId == null && record.create?.id == id) { "There is no saved raid request to discard" }
        check(!state.value.creating && id !in flight) { "The raid request is already being sent" }
        clearPersisted(record); accepted.clear()
        _state.value = LiveBattleState(); refreshEntry()
    }

    private suspend fun enqueue(feedback: BattleCommandFeedback? = null, inputTiming: BattleInputTiming? = null,
                                make: (LiveBattleState, String, String) -> PendingBattleWrite): String {
        // Admission cannot wait behind Keystore or fsync: reserve against one CAS
        // snapshot before entering the durable journal gate. IDs are allocated once,
        // outside the CAS retry; no input event can create a second logical order.
        val write = try {
            currentCoroutineContext().ensureActive()
            val id = newId()
            var admitted: PendingBattleWrite? = null
            _state.update { current ->
                val raid = requireNotNull(current.pending?.raidId)
                check(!current.terminal && !current.blocked && current.presentation != null) { "Reconnect before submitting battle orders" }
                check(current.pending.writes.size + current.preparingWrites.size < CLIENT_COMMAND_CEILING) { "Wait for pending battle orders" }
                make(current, raid, id).also { admitted = it }.let { current.copy(preparingWrites = current.preparingWrites + it) }
            }
            requireNotNull(admitted)
        } catch (error: Exception) { runCatching { feedback?.notEnqueued() }; throw error }
        runCatching { inputTiming?.admitted(write.id) }
        var storageStarted = false
        try {
            gate.withLock {
                currentCoroutineContext().ensureActive()
                val record = requireNotNull(saved)
                check(write.path.startsWith("/raids/${record.raidId}/") && !state.value.terminal && !state.value.blocked) { "This battle no longer accepts orders" }
                storageStarted = true
                persist(record.copy(writes = record.writes + write))
                timed(write.id, BattleCommandStage.INTENT_DURABLE)
                publish(completedAdmission = write.id)
            }
            return write.id
        } catch (error: Exception) {
            if (!storageStarted) {
                _state.update { it.copy(preparingWrites = it.preparingWrites.filterNot { pending -> pending.id == write.id }) }
                runCatching { feedback?.notEnqueued() }
            }
            // Any error after the write began is uncertain. persist fails closed;
            // retain this exact admission until a new coordinator reads the journal.
            throw error
        }
    }
    private suspend fun send(id: String, creation: Boolean = false, feedback:BattleCommandFeedback?=null) {
        currentCoroutineContext().ensureActive()
        val pair = gate.withLock {
            val record = requireNotNull(saved)
            val request = if (creation) requireNotNull(record.create).also { require(it.id == id) } else record.writes.single { it.id == id }
            if (request.path.endsWith("/finish")) requireFinishAvailable()
            check(!state.value.terminal && !state.value.blocked && flight.add(id)) { "That battle request cannot be sent" }
            try {
                val attempted = request.copy(attempted = true)
                if (!request.attempted) persist(if (creation) record.copy(create = attempted) else record.copy(writes = record.writes.map { if (it.id == id) attempted else it }))
                timed(id, BattleCommandStage.ATTEMPT_DURABLE)
                publish(); request to record.raidId
            } catch (error: Exception) { flight.remove(id); throw error }
        }
        val request = pair.first
        try {
            currentCoroutineContext().ensureActive()
            gate.withLock { check(!state.value.terminal && !state.value.blocked) { "This battle no longer accepts orders" } }
            timed(id, BattleCommandStage.POST_BEGIN)
            val response = post(request.path, request.body)
            val receipt = now()
            timed(id, BattleCommandStage.RESPONSE)
            // The acknowledgement proves the server revision moved: the observer's long-poll must not sit out the
            // server's own poll cadence before the deployed troop's canonical timeline can arrive. Wake it now,
            // not after the receipt's durable bookkeeping below (a Keystore write and fsync under the gate, queued
            // behind every other order being saved). The wake only makes the observer read sooner; whichever of
            // that presentation and this receipt takes the gate first, the other finds its work already done
            // (applyPresentation and this block both key on the command id and sequence), exactly as when an
            // ordinary poll happened to return in this window.
            if (!creation && (response["command"] is JsonObject || response["result"] is JsonObject)) wake?.wake()
            gate.withLock {
                val record = saved ?: return@withLock
                if(state.value.expired) return@withLock // A delayed acknowledgement cannot reopen server-confirmed expiry.
                if (creation) {
                    val raid = requireNotNull(response["raid"] as? JsonObject)
                    require(raid.string("attackerBaseId") == baseId && raid.string("simVersion")?.toIntOrNull() == simVersion && raid.string("raidProtocolVersion") == "2")
                    val raidId = requireNotNull(raid.string("id")); require(raidId.matches(Regex("[0-9a-fA-F-]{36}")))
                    // The server's chosen defender is the identity NEXT TARGET excludes and revenge names; keep it with the march.
                    persist(record.copy(raidId = raidId, create = null, ordersDeadlineAt = battleOrdersDeadlineAt(raid["ordersDeadlineAt"]), target = record.target?.let { requested ->
                        requested.copy(defenderWallet = raid.string("defenderWallet") ?: requested.defenderWallet, defenderBaseId = raid.string("defenderBaseId") ?: requested.defenderBaseId)
                    }))
                    timed(id, BattleCommandStage.RECEIPT_DURABLE)
                } else if (record.raidId == pair.second) {
                    (response["command"] as? JsonObject)?.let { require(it.string("clientCommandId") == id); accepted[it.battleInt("sequence")] = it }
                    (response["clock"] as? JsonObject)?.let { acceptClock(BattleClock.read(it, receipt)) }
                    val result = response["result"] as? JsonObject
                    check(response["command"] is JsonObject || result != null) { "Battle acknowledgement is incomplete" }
                    persist(record.copy(writes = record.writes.filterNot { it.id == id }))
                    timed(id, BattleCommandStage.RECEIPT_DURABLE)
                    if (result != null) _state.update { it.copy(result = result) }
                }
                _state.update { it.copy(error = null) }; publish()
            }
        } catch (error: Exception) {
            // Cancellation can occur after commit too. The already persisted
            // request remains exact until a receipt or explicit retry resolves it.
            withContext(NonCancellable) { gate.withLock {
                if (request.path.endsWith("/finish") && error is ApiException && error.status == 429) {
                    val seconds = error.retryAfterSeconds?.takeIf { it > 0 } ?: 2L
                    finishBackoff = now() to (seconds.coerceAtMost(Long.MAX_VALUE / 1_000_000_000) * 1_000_000_000)
                }
                val record = saved
                if (record != null && !state.value.expired && ((creation && record.create?.id == id) || (!creation && record.raidId == pair.second))) {
                    val definite = (!request.attempted && error is ApiException && error.status in 400..499) || (creation && isTerminalRaidCreateRefusal(error))
                    if (definite) {
                        if (creation) clearPersisted(record)
                        else persist(record.copy(writes = record.writes.filterNot { it.id == id }))
                        runCatching { feedback?.refused(id) }
                    }
                    if (error is ApiException && error.code == "RAID_CLOCK_STALE")
                        (error.details["clock"] as? JsonObject)?.let { runCatching { acceptClock(BattleClock.read(it, now())) } }
                    _state.update { it.copy(error = battleFailureMessage(error), blocked = it.blocked || (error is ApiException &&
                        (error.status in setOf(401, 403) || error.code == "DEED_OWNERSHIP_CHANGED"))) }
                    publish()
                }
            } }
            throw error
        } finally { withContext(NonCancellable) { gate.withLock { flight.remove(id); publish() } } }
    }
    private suspend fun applyPresentation(raid: String, value: JsonObject) = gate.withLock {
        if (saved?.raidId != raid) return@withLock
        if(state.value.expired) return@withLock
        require(value.string("raidId") == raid && value.string("simVersion")?.toIntOrNull() == simVersion)
        if (value.string("source") == "live" && value.string("raidProtocolVersion") != "2") {
            _state.update { it.copy(phase = BattlePhase.UNSUPPORTED, blocked = true) }; return@withLock
        }
        val status=value.string("status")
        val source=value.string("source")
        if((source=="live" && status !in setOf("pending_orders","resolving","resolved","expired")) ||
            (source=="archive" && status!="resolved") || source !in setOf("live","archive")) {
            _state.update { it.copy(phase=BattlePhase.UNSUPPORTED,blocked=true,error="This battle status requires a compatible app") }
            return@withLock
        }
        if(status=="expired") {
            // Current source expiry closes an unstarted reservation under the raid lock.
            // The complete terminal journal proves omitted writes cannot later commit;
            // it does not prove any specific refund or award a battle result.
            val commands=requireExpiredReservation(value,state.value)
            val record=requireNotNull(saved)
            persist(record.copy(writes=emptyList()))
            accepted.clear();commands.forEach { accepted[it.battleInt("sequence")]=it }
            _state.update { it.copy(presentation=value,expired=true,clock=null,result=null,connected=true,error=null) }
            publish();return@withLock
        }
        val commands = value.objects("commands")
        for (command in commands) accepted[command.battleInt("sequence")] = command
        val ids = commands.mapNotNull { it.string("clientCommandId") }.toSet()
        val record = requireNotNull(saved)
        val remaining = record.writes.filterNot { it.id in ids }
        if (remaining.size != record.writes.size) {
            persist(record.copy(writes = remaining))
            record.writes.filter { it.id in ids }.forEach { timed(it.id, BattleCommandStage.RECEIPT_DURABLE) }
        }
        val receipt = requireNotNull(value["_clientFirstPageReceivedAtNanos"]?.jsonPrimitive?.longOrNull)
        (value["clock"] as? JsonObject)?.let { acceptClock(BattleClock.read(it, receipt)) }
        val result = if (value.string("source") == "archive" || value.string("status") == "resolved") value["result"] as? JsonObject else null
        _state.update { it.copy(presentation = value, result = result ?: it.result, connected = true, error = null) }
        publish()
    }
    private fun acceptClock(clock: BattleClock) { if (clock.newerThan(state.value.clock)) _state.update { it.copy(clock = clock) } }
    // Keystore encryption and atomic disk writes stay off the UI/render threads.
    // Complete a started local write even when lifecycle cancellation interrupts
    // it, then check cancellation before sending any network mutation.
    private suspend fun persist(value: PendingBattle) {
        if (value == saved) return
        try {
            withContext(NonCancellable + Dispatchers.IO) {
                check(store.replace(saved, value)) { "Saved battle changed; reopen its recovery" }
                saved = value
            }
        } catch (error: Exception) {
            _state.update { it.copy(blocked = true, error = "Battle recovery could not be saved. Reopen the game before sending more orders.") }
            throw error
        }
    }
    private suspend fun clearPersisted(value: PendingBattle) {
        try {
            withContext(NonCancellable + Dispatchers.IO) {
                check(store.clear(wallet, baseId, value)); saved = null
            }
        } catch (error: Exception) {
            _state.update { it.copy(blocked = true, error = "Battle recovery could not be saved. Reopen the game before sending more orders.") }
            throw error
        }
    }
    private fun publish(completedAdmission: String? = null) { _state.update { it.copy(pending = saved,
        preparingWrites = if (completedAdmission == null) it.preparingWrites else it.preparingWrites.filterNot { pending -> pending.id == completedAdmission },
        commands = accepted.values.toList(), inFlight = flight.toSet(), phase = when {
        it.blocked -> BattlePhase.UNSUPPORTED
        it.expired -> BattlePhase.EXPIRED
        it.result != null -> BattlePhase.RESULT
        saved == null -> BattlePhase.EMPTY
        saved?.raidId == null || it.presentation == null -> BattlePhase.RECOVERY
        it.clock?.value?.anchorWallAt == null -> BattlePhase.STAGING
        else -> BattlePhase.RUNNING
    }) } }
}
