package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

/** A participant's read-only view of a raid (web `RaidTarget.kind:'live'`, the defender's WATCH LIVE): the same
 * canonical presentation the attacker plays, without orders and without any persisted intent. The server's
 * participant authority decides who may watch; a refusal blocks the view rather than retrying. */
class BattleSpectator internal constructor(
    val raidId: String,
    private val simVersion: Int,
    private val presentation: (String) -> Flow<JsonObject>,
    private val pause: suspend (Long) -> Unit = { delay(it) },
) {
    constructor(raidId: String, simVersion: Int, api: GameApi, session: SessionToken) :
        this(raidId, simVersion, BattlePresentation({ path, query -> api.get(path, query, session = session) }, simVersion)::observe)
    init { require(raidId.matches(Regex("[0-9a-fA-F-]{36}"))) }
    companion object {
        /** A spectator over a caller-supplied presentation source (repository tests). */
        fun withTransport(raidId: String, simVersion: Int, presentation: (String) -> Flow<JsonObject>): BattleSpectator = BattleSpectator(raidId, simVersion, presentation)
    }
    private val foreground = Mutex()
    private val _state = MutableStateFlow(LiveBattleState(phase = BattlePhase.RECOVERY))
    val state: StateFlow<LiveBattleState> = _state.asStateFlow()

    /** Reads only, collected while the battle screen is STARTED; stops at the canonical result or a refusal. */
    suspend fun runForeground() {
        if (!foreground.tryLock()) return
        try {
            while (currentCoroutineContext().isActive) {
                try {
                    presentation(raidId).takeWhile { apply(it); !state.value.terminal && !state.value.blocked }.collect()
                    if (state.value.terminal || state.value.blocked) return
                    pause(500)
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    _state.update { it.copy(connected = false, error = error.message, blocked = it.blocked || error is IllegalArgumentException ||
                        error is ApiCompatibilityException || (error is ApiException && error.status in setOf(401, 403, 404))) }
                    if (error is ApiException && error.status == 401) throw error
                    if (state.value.blocked || error is ApiCompatibilityException || error is IllegalArgumentException) return
                    pause(2_000)
                }
            }
        } finally { foreground.unlock() }
    }

    private fun apply(value: JsonObject) {
        require(value.string("raidId") == raidId && value.string("simVersion")?.toIntOrNull() == simVersion)
        val source = value.string("source"); val status = value.string("status")
        if (source == "live" && value.string("raidProtocolVersion") != "2") { _state.update { it.copy(phase = BattlePhase.UNSUPPORTED, blocked = true) }; return }
        if ((source == "live" && status !in setOf("pending_orders", "resolving", "resolved", "expired")) || (source == "archive" && status != "resolved") || source !in setOf("live", "archive")) {
            _state.update { it.copy(phase = BattlePhase.UNSUPPORTED, blocked = true, error = "This battle status requires a compatible app") }; return
        }
        val receipt = requireNotNull(value["_clientFirstPageReceivedAtNanos"]?.jsonPrimitive?.longOrNull)
        val clock = (value["clock"] as? JsonObject)?.let { BattleClock.read(it, receipt) }
        val result = if (source == "archive" || status == "resolved") value["result"] as? JsonObject else null
        val expired = status == "expired"
        _state.update { previous ->
            val next = clock?.takeIf { it.newerThan(previous.clock) } ?: previous.clock
            previous.copy(presentation = value, commands = value.objects("commands"), clock = if (expired) null else next, result = result ?: previous.result,
                expired = expired, connected = true, error = null, phase = when {
                    expired -> BattlePhase.EXPIRED
                    (result ?: previous.result) != null -> BattlePhase.RESULT
                    next?.value?.anchorWallAt == null -> BattlePhase.STAGING
                    else -> BattlePhase.RUNNING
                })
        }
    }
}
