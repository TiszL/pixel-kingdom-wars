package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.selects.select
import kotlinx.serialization.json.*
import java.io.IOException

/** V2 pages become one complete immutable timeline off GL. Rendering still uses
 * full resets; atomic transport assembly does not imply incremental GPU updates. */
class BattlePresentation internal constructor(
    private val get: suspend (String, Map<String, String>) -> JsonObject,
    private val simVersion: Int,
    private val pause: suspend (Long) -> Unit = { delay(it) },
    private val monotonicNanos: () -> Long = System::nanoTime,
    private val beginPreparation: () -> BattlePreparationTiming? = { null },
    private val observedGet: suspend (String, Map<String,String>, BattlePreparationTiming?) -> JsonObject = { path, query, _ -> get(path, query) },
    /** Shared with the coordinator that acknowledges commands; null keeps the plain long-poll. */
    private val wake: BattlePresentationWake? = null,
    /** A live coordinator owns visible, lifecycle-persistent rate-limit recovery. Other readers retain bounded retries. */
    private val retryRateLimits: Boolean = true,
) {
    constructor(api: GameApi, simVersion: Int) : this({ path, query -> api.get(path, query) }, simVersion)

    fun observe(raidId: String): Flow<JsonObject> = flow {
        require(raidId.matches(Regex("[0-9a-fA-F-]{36}")))
        val capabilities = readWithRetry("/native/capabilities", emptyMap())
        val presentation = capabilities["presentation"] as? JsonObject
        require(presentation?.flag("enabled") == true) { "Native live battles are not enabled on this server yet" }
        val protocols = (presentation["protocolVersions"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.intOrNull }.orEmpty()
        val protocol = if (2 in protocols) 2 else 1.also { require(1 in protocols) { "Update the native app for this battle protocol" } }
        val waitMs = presentation.battleInt("maxWaitMs").also { require(it in 0..15_000) }
        val maxEvents = if (protocol == 2) presentation.battleInt("maxEvents").also { require(it in 1..CLIENT_EVENT_CEILING) } else CLIENT_EVENT_CEILING
        val maxCommands = if (protocol == 2) presentation.battleInt("maxCommands").also { require(it in 1..CLIENT_COMMAND_CEILING) } else CLIENT_COMMAND_CEILING
        val maxPageBytes = if (protocol == 2) presentation.battleInt("maxPageBytes").also { require(it in 1..CLIENT_PAGE_BYTE_CEILING) } else CLIENT_PAGE_BYTE_CEILING
        var applied: JsonObject? = null
        var appliedTiming: BattlePreparationTiming? = null
        var forceReset = false
        var consecutiveRestarts = 0
        while (currentCoroutineContext().isActive) {
            val query = buildMap {
                put("waitMs", waitMs.toString())
                if (protocol == 2) put("protocolVersion", "2")
                if (!forceReset) applied?.string("revision")?.let { put("afterRevision", it) }
            }
            var timing: BattlePreparationTiming? = null
            try {
                val first = readOrWake("/raids/$raidId/presentation", query, waitMs) {
                    timing.end(BattlePreparationOutcome.FAILED)
                    timing = runCatching { beginPreparation() }.getOrNull()
                    timing
                }
                // A woken long-poll re-reads at once with the same cursor; like a 204 it changes nothing.
                if (first == null) { timing.end(BattlePreparationOutcome.UNCHANGED); continue }
                val firstPageReceivedAtNanos = monotonicNanos()
                if (first.isEmpty()) { timing.end(BattlePreparationOutcome.UNCHANGED); pause(100); continue } // 204 preserves the last complete state.
                val next = if (protocol == 1) {
                    validatePresentation(first, raidId, simVersion)
                    first
                } else {
                    val assembly = PresentationAssembly(raidId, simVersion, applied, maxEvents, maxPageBytes, maxCommands)
                    var page: JsonObject = first
                    while (true) {
                        val cursor = assembly.accept(page)
                        if (cursor == null) break
                        page = readWithRetry("/raids/$raidId/presentation", mapOf("protocolVersion" to "2", "cursor" to cursor))
                    }
                    assembly.complete()
                }
                runCatching { timing?.assembled(next.battleString("revision")) }
                timing.observe(BattlePreparationStage.ASSEMBLY_COMPLETE)
                forceReset = false
                consecutiveRestarts = 0
                // Local process-relative receipt metadata, never a server clock or
                // persisted start time. A live coordinator must anchor extrapolation
                // here rather than at completion of a potentially slow page download.
                val received = JsonObject(next + ("_clientFirstPageReceivedAtNanos" to JsonPrimitive(firstPageReceivedAtNanos)) +
                    (runCatching { timing?.let { mapOf("_clientPreparationOrdinal" to JsonPrimitive(it.ordinal)) } }.getOrNull() ?: emptyMap()))
                if (next.string("revision") != applied?.string("revision")) {
                    appliedTiming.end(BattlePreparationOutcome.SUPERSEDED)
                    appliedTiming = timing
                    emit(received); applied = received
                } else timing.end(BattlePreparationOutcome.UNCHANGED)
                if (next.string("status") in setOf("resolved","expired") || next.string("source") == "archive") break
            } catch (error: PresentationParentMismatch) {
                timing.end(BattlePreparationOutcome.SUPERSEDED)
                forceReset = true
                if (++consecutiveRestarts > MAX_READ_RETRIES) throw error
                pause(100)
            } catch (error: ApiException) {
                timing.end(BattlePreparationOutcome.FAILED)
                if (error.status != 410 || error.code != "NATIVE_PAGE_EXPIRED") throw error
                // Restart with the last fully applied parent, never a partial suffix.
                if (++consecutiveRestarts > MAX_READ_RETRIES) throw error
                pause(100)
            } catch (error: Exception) {
                timing.end(if (error is CancellationException) BattlePreparationOutcome.CANCELLED else BattlePreparationOutcome.FAILED)
                throw error
            }
        }
    }.flowOn(Dispatchers.Default)

    /** The long-poll read, abandoned (null) as soon as a command acknowledgement wakes the observer.
     * Only wakes after this read began count; page continuation and restarts never race the wake. */
    private suspend fun readOrWake(path: String, query: Map<String, String>, waitMs: Int, before: () -> BattlePreparationTiming?): JsonObject? {
        val wake = wake?.takeIf { waitMs > 0 } ?: return readWithRetry(path, query, before)
        val seen = wake.current()
        return coroutineScope {
            val read = async { readWithRetry(path, query, before) }
            val woken = launch { wake.awaitAfter(seen) }
            try { select<JsonObject?> { read.onAwait { it }; woken.onJoin { null } } }
            finally { read.cancel(); woken.cancel() }
        }
    }

    private suspend fun readWithRetry(path: String, query: Map<String, String>, before: (() -> BattlePreparationTiming?)? = null): JsonObject {
        var failures = 0
        while (true) {
            try { return if (before == null) get(path, query) else observedGet(path, query, before()) }
            catch (error: CancellationException) { throw error }
            catch (error: IOException) {
                val retryable = if (error is ApiException) (error.status == 429 && retryRateLimits) ||
                    (error.status == 503 && error.code in setOf("NATIVE_PRESENTATION_BUSY", "NATIVE_PRESENTATION_STALE"))
                    else error !is ApiCompatibilityException && error !is SecretStorageException
                if (!retryable || failures >= MAX_READ_RETRIES) throw error
                val backoff = (250L shl failures++).coerceAtMost(4_000)
                val requestedWait = (error as? ApiException)?.retryAfterSeconds ?: 0
                if (requestedWait > 30) throw error // A bounded attempt must not retry before the server's longer exclusion window.
                val retryAfter = requestedWait * 1_000
                pause(maxOf(backoff, retryAfter))
            }
        }
    }
}

private const val MAX_READ_RETRIES = 4

internal fun validatePresentation(value: JsonObject, raidId: String, supportedSimVersion: Int) {
    require(value.string("raidId") == raidId) { "Battle response belongs to a different raid" }
    require(value.battleInt("protocolVersion") == 1) { "Update the native app for this battle protocol" }
    require(value.battleInt("simVersion") == supportedSimVersion) { "Update the native app for this simulation version" }
    require(value.battleInt("replaceFromTick") == 0) { "Incremental battle revisions require a newer client" }
    require(value.battleString("revision").matches(PRESENTATION_REVISION))
    presentationEvents(value)
}
