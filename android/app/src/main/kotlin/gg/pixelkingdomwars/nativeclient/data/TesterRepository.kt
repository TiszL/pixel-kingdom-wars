package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

data class TesterBounds(val refreshMinMs: Long, val leaderboardLimit: Int) {
    init { require(refreshMinMs > 0 && leaderboardLimit > 0) }
    companion object { fun from(catalogue: JsonObject?): TesterBounds? = runCatching {
        val raw = (catalogue?.get("constants") as? JsonObject)?.get("TESTER_PROGRAM") as? JsonObject ?: return null
        TesterBounds(requireNotNull(raw.string("recomputeMinIntervalMs")?.toLongOrNull()), requireNotNull(raw.string("leaderboardLimit")?.toIntOrNull()))
    }.getOrNull() }
}
data class TesterState(val progress: TesterProgress? = null, val board: TesterBoard? = null,
    val loadingProgress: Boolean = false, val loadingBoard: Boolean = false, val awardNotice: String? = null)

/** A single session-owned reader: /tester/me may award points during its bounded server
 * recompute. Foreground readers share its snapshot, and only a fresh response announces. */
class LiveTesterRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val bounds: () -> TesterBounds?, private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() }) {
    private val mutable = MutableStateFlow(TesterState())
    val state = mutable.asStateFlow()
    private val progressLock = Mutex()
    private val boardLock = Mutex()
    private var fetchedAt: Long? = null
    private var progressRead = 0L
    private var lastFailure: Exception? = null
    private fun current() = holder.requireCurrent(session)
    private inline fun <T> decode(path: String, read: () -> T): T = try { read() } catch (_: Exception) { throw ApiCompatibilityException(path) }

    suspend fun refreshProgress(force: Boolean = false) {
        current(); val readAtEntry = progressRead
        progressLock.withLock {
            current()
            // A reader which waited for the current request observes that same outcome,
            // including failure. A deliberate later retry starts a new read.
            if (readAtEntry != progressRead) { lastFailure?.let { throw it }; return }
            val limit = requireNotNull(bounds()) { "Tester program limits are unavailable. Update game content." }
            val age = fetchedAt?.let { now() - it }
            if (!force && mutable.value.progress != null && age != null && age >= 0 && age < limit.refreshMinMs) return
            mutable.update { it.copy(loadingProgress = true) }
            try {
                val raw = api.get("/tester/me"); current()
                val next = decode("/tester/me") { TesterProgress.from(raw).also {
                    // The DTO deliberately shortens this field. Authentication is established
                    // by the session epoch, never by a shortened wallet collision on the board.
                    val walletLabel = if (session.wallet.length <= 10) session.wallet else session.wallet.take(4) + "…" + session.wallet.takeLast(4)
                    require(it.wallet == walletLabel)
                } }
                val positive = next.justEarned.filter { it.points > 0 }
                val titles = (next.daily.catalog.sources + next.daily.catalog.streaks).associate { it.key to it.title } + next.milestones.associate { it.key to it.title }
                val notice = positive.takeIf { it.isNotEmpty() }?.joinToString("\n") { "+${it.points} tester points — ${titles[it.key] ?: it.key}" }
                fetchedAt = now(); lastFailure = null
                mutable.update { it.copy(progress = next, awardNotice = notice) }
            } catch (failure: Exception) { current(); fetchedAt = null; lastFailure = failure; throw failure }
            finally { progressRead++; if (holder.isCurrent(session)) mutable.update { it.copy(loadingProgress = false) } }
        }
    }
    fun dismissAward() { current(); mutable.update { it.copy(awardNotice = null) } }
    suspend fun refreshBoard() = boardLock.withLock {
        current(); val limit = requireNotNull(bounds()) { "Tester program limits are unavailable. Update game content." }
        mutable.update { it.copy(loadingBoard = true) }
        try {
            val raw = api.get("/tester/leaderboard"); current()
            val board = decode("/tester/leaderboard") { TesterBoard.from(raw).also { require(it.entries.size <= limit.leaderboardLimit) } }
            mutable.update { it.copy(board = board) }
        } finally { if (holder.isCurrent(session)) mutable.update { it.copy(loadingBoard = false) } }
    }
}
