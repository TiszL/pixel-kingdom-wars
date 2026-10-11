package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import java.io.IOException

/** What the server is known to have done with a saved intent. */
sealed interface Receipt<out T> {
    /** No proof either way: the intent stays saved and blocks new intents of its kind. */
    data object Unknown : Receipt<Nothing>
    /** This server offers no receipt route for the intent (older or unported backend). */
    data object Unsupported : Receipt<Nothing>
    /** The server proves it holds no ledger row for this wallet and exact key (`{version:1,status:"absent",
     * idempotencyKey}`), or an existing read proves the order left no effect. Unlike [Unknown] ("no matching evidence"),
     * only this lets CLOSE archive the request (owner review 2026-10-06, M1). */
    data object Absent : Receipt<Nothing>
    data class Accepted<T>(val value: T, val document: JsonObject) : Receipt<T>
    data class Closed(val closedAt: String) : Receipt<Nothing>
}

/** The persisted proof of acceptance: which route produced it and the verbatim server document. */
object ReceiptDocument {
    const val SOURCE_POST = "post"
    const val SOURCE_RECEIPT = "receipt"
    /** A definitive rejection whose details named the server's existing resolution of this intent. */
    const val SOURCE_REJECTION = "rejection"
    fun fromPost(response: JsonObject): JsonObject = buildJsonObject { put("source", SOURCE_POST); put("document", response) }
    fun fromReceiptRoute(response: JsonObject): JsonObject = buildJsonObject { put("source", SOURCE_RECEIPT); put("document", response) }
    fun fromRejection(details: JsonObject): JsonObject = buildJsonObject { put("source", SOURCE_REJECTION); put("document", details) }
    fun source(document: JsonObject): String = requireNotNull((document["source"] as? JsonPrimitive)?.contentOrNull) { "Saved receipt is malformed" }
    fun payload(document: JsonObject): JsonObject = requireNotNull(document["document"] as? JsonObject) { "Saved receipt is malformed" }
}

data class ReceiptRequest(val path: String, val query: Map<String, String>)

/** The way out a saved request of an operation has. Owner rules 2026-10-06: no saved request blocks a door forever; a
 * player is never charged twice; a real charge is never hidden. A never-sent request (attempted is false; the flag is
 * durable before any byte leaves) is always closable. Nothing is ever deleted after a send: CLOSE archives it on this
 * device and every Home resume re-reads kept requests, so a late acceptance surfaces. */
enum class SavedRequestExit {
    /** The server offers an explicit closure route for an unknown key (training batch). */
    SERVER_CLOSE,
    /** A key-scoped receipt (or an absence proof through an existing read). CLOSE archives it only on [Receipt.Absent]
     * once its last attempt is older than [SAVED_REQUEST_MIN_AGE_MS]; an `unknown` answer keeps it shown but, after that
     * age, it no longer blocks its door ([MoneyOpSpec.unblocksAfterCheck]). */
    FORGET_AFTER_SERVER_ABSENT,
    /** No read can resolve it; the server replays the same key. It blocks until an explicit TRY AGAIN is refused with a
     * code the spec proves is raised AFTER the server's key lookup ([MoneyOpSpec.refusedAfterKeyLookup]); never on a
     * status the server can raise before it (401/403/404/409/429...). Then it stays shown and a new order parks it. */
    PARK_AFTER_RETRY_REFUSED,
    /** No GET can resolve it and it cannot be retried (a legacy request with no server key): it never blocks; a new
     * explicit order parks it (kept, never resent). */
    NEVER_BLOCKS,
    UNDECLARED,
}

/** Everything one money operation contributes: where its receipt lives and how to read it. */
interface MoneyOpSpec<T> {
    val kind: String
    /** Reject unsupported original terms before a new or explicit retry POST. Never rewrites the intent. */
    fun validateSend(intent: PendingIntent) {}
    /** GET route that observes the saved intent, or null when the server offers none. */
    fun receiptRequest(intent: PendingIntent): ReceiptRequest?
    /** Strict decode of the receipt route; malformed data throws [ApiCompatibilityException]. */
    fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<T>
    /** Strict decode of the POST acknowledgement into an accepted result. */
    fun acknowledge(intent: PendingIntent, response: JsonObject): T
    /** Some transports follow a successful POST with the exact receipt GET before acknowledging. */
    fun acknowledgementDocument(response: JsonObject): JsonObject = ReceiptDocument.fromPost(response)
    /** Re-reads the result from a persisted [ReceiptDocument]. */
    fun restore(intent: PendingIntent, document: JsonObject): T
    /** Explicit permanent closure of an unknown key, when the server offers one. */
    fun closeRequest(intent: PendingIntent): Pair<String, JsonObject>? = null
    /** Where the server offers no closure route ([closeRequest] is null): may the player's explicit CLOSE forget this saved
     * intent on this device once a fresh GET of its receipt route answered `unknown` for exactly this key (the server
     * holds no record of it)? Nothing is sent. Owner 2026-10-06 (Seeker 08:30Z): without it a construction the server
     * never recorded blocked every BUILD with no way out. Only for an operation whose receipt route is keyed by the
     * original idempotency key, so `unknown` really is that key's server answer; never a heuristic observation. */
    fun forgetsOnServerAbsent(intent: PendingIntent): Boolean = savedRequestExit == SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    /** After a read that found no acceptance ([Receipt.Unknown], [Receipt.Absent] or [Receipt.Unsupported]) and once the
     * last attempt is older than [SAVED_REQUEST_MIN_AGE_MS], may this saved request stop blocking its door (it stays shown
     * with RETRY CHECK and a newer order parks it)? Default: a key-scoped operation, on `unknown` or `absent`. Never for an
     * operation whose new order could charge the player again for a commit no read can see. */
    fun unblocksAfterCheck(intent: PendingIntent, answer: Receipt<*>): Boolean =
        savedRequestExit == SavedRequestExit.FORGET_AFTER_SERVER_ABSENT && (answer == Receipt.Unknown || answer == Receipt.Absent)
    /** A coded refusal of an explicit retry that the server provably raises AFTER its key lookup, so the original key was
     * never committed. Default: none (an unproven code never unblocks a door: it could double-charge). */
    fun refusedAfterKeyLookup(intent: PendingIntent, error: ApiException): Boolean = false
    /** Owner 2026-10-06 ("fix root causes for that kind of every case"): how a saved request of this operation can never
     * block play forever on this device. Every production spec declares one; SavedRequestExitTest fails for a spec that
     * does not, so a new journal cannot ship without its way out. Per-intent nuance stays in the functions below. */
    val savedRequestExit: SavedRequestExit get() = SavedRequestExit.UNDECLARED
    /** For an intent with no receipt route: an existing read-only GET whose answer can prove the original order left no
     * effect on the server (the target job still runs, the walls are still at their quoted level...). Null when none. */
    fun absenceRequest(intent: PendingIntent): ReceiptRequest? = null
    /** True only when [response] (the [absenceRequest] answer) proves this saved order is not on the server: read as
     * [Receipt.Absent]. A false or a throw keeps the request Unsupported. */
    fun provesAbsence(intent: PendingIntent, response: JsonObject): Boolean = false
    /** The [absenceRequest] answer shows this order's effect (an upgrade done or running): the charge is real, so it is an
     * ACCEPTANCE (hydrated, never hidden). Null when the answer does not show it. */
    fun effectAcceptance(intent: PendingIntent, response: JsonObject): Receipt.Accepted<T>? = null
    /** No read or retry can ever resolve this saved request: a NEW explicit order of the same kind parks it (kept on the
     * device, never resent) instead of being refused, so its door never stays shut. A new order is a new, deliberate
     * player action with a new key. */
    fun supersededByNewOrder(intent: PendingIntent): Boolean = savedRequestExit == SavedRequestExit.NEVER_BLOCKS
    /** A definitive rejection that carries the server's own resolution of this exact intent (for
     * example a 409 naming the reservation it already holds for the wallet). Null for an ordinary
     * refusal. The result is persisted as the receipt, hydrated and only then retired, exactly like
     * an acceptance; it must never be used to swallow a refusal that leaves the outcome unknown. */
    fun resolveRejection(intent: PendingIntent, error: ApiException): Receipt.Accepted<T>? = null
    /** A coded refusal the server raises before any write for this operation on every attempt (a
     * disabled feature, a required client update), so it proves this intent was never accepted —
     * even on a retry, unlike the status-only rule. Never true for a status that can follow a commit. */
    fun disprovesAcceptance(error: ApiException): Boolean = false
    /** Explicit opt-in for original HTTP evidence before session/cancellation rejection. Never status-only. */
    fun observedInitialRejection(intent: PendingIntent, error: ApiException): Boolean = false
    /** Only the initial POST can establish a new key was refused. Narrower contracts override the
     * legacy status policy; a later rejection never disproves an earlier ambiguous attempt. */
    fun definitiveInitialRejection(intent: PendingIntent, error: ApiException): Boolean = isDefinitiveRejection(error.status)
}

interface OpTransport {
    suspend fun get(path: String, query: Map<String, String>): JsonObject
    suspend fun post(path: String, body: JsonObject): JsonObject
    /** A transport must explicitly support durable command options; silently dropping consent is unsafe. */
    suspend fun post(intent: PendingIntent): JsonObject {
        check(intent.expectedCurrency == null) { "This transport cannot enforce the saved currency." }
        return post(intent.path, intent.body)
    }
    /** Only the actual POST may invoke this callback, before any receipt reads or session guards. */
    suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit): JsonObject = post(intent)
}

/** A server read answering for exactly this saved key that it holds no ledger row (owner review 2026-10-06, M1; night/server:
 * GET /base/buildings/receipt and /items/buy/receipt answer exactly `{version:1,status:"absent",idempotencyKey,absentAsOf}`
 * once the player's row lock shows nothing claims the key). Any other shape, an unknown extra key or an unreadable
 * `absentAsOf` is left to the spec's own strict decoder. */
fun absentAnswer(intent: PendingIntent, response: JsonObject): Boolean =
    response.keys.all { it in ABSENT_KEYS } && response["version"] == JsonPrimitive(1) && response["status"] == JsonPrimitive("absent") &&
        response["idempotencyKey"] == JsonPrimitive(intent.idempotencyKey) && (response["absentAsOf"] == null || absentAsOf(response) != null)
private val ABSENT_KEYS = setOf("version", "status", "idempotencyKey", "absentAsOf")
/** The server time an `absent` answer was taken under the player's row lock, in epoch milliseconds. */
fun absentAsOf(response: JsonObject): Long? = (response["absentAsOf"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    ?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }

/** Owner review 2026-10-06 (M2): the server can still be processing a lost POST long after the client gave up (no request
 * or statement timeout; the receipt is written in the same transaction as the effect, so a read sees nothing while it
 * runs). A saved request never stops blocking and is never closed before its last attempt is this old. */
const val SAVED_REQUEST_MIN_AGE_MS: Long = 5 * 60 * 1000L

/** The read answer persisted in [SavedRequestFacts.answer], as a [Receipt]. */
fun factsAnswer(facts: SavedRequestFacts): Receipt<Nothing>? = when (facts.answer) {
    SavedRequestFacts.UNKNOWN -> Receipt.Unknown
    SavedRequestFacts.ABSENT -> Receipt.Absent
    SavedRequestFacts.UNSUPPORTED -> Receipt.Unsupported
    else -> null
}

/** Owner field result 2026-10-06 (Seeker build 880a7e7a): a sent request with no recorded dispatch time was written by an
 * older build, so it was sent before this build was installed (an install restarts the app and drops any request in
 * flight on the device). It counts as sent long ago, never as "now": stamping it at its first read made a request sent
 * hours earlier keep BUILD shut for five more minutes after every upgrade. */
const val SENT_BY_OLDER_BUILD_MS: Long = 0L

/** The last dispatch time this device knows for a sent request ([SENT_BY_OLDER_BUILD_MS] when an older build sent it). */
fun lastSendMs(facts: SavedRequestFacts): Long = facts.attemptedAtMs ?: SENT_BY_OLDER_BUILD_MS

/** The last attempt is old enough that a lost POST can no longer be mid-flight on any sane server ([SAVED_REQUEST_MIN_AGE_MS]). */
fun settled(facts: SavedRequestFacts, nowMs: Long): Boolean = nowMs - lastSendMs(facts) >= SAVED_REQUEST_MIN_AGE_MS

/** A read answer exists and was itself taken at least [SAVED_REQUEST_MIN_AGE_MS] after the last attempt (client clock): only
 * such an answer may stop a request blocking or let CLOSE archive it. An answer read while the POST could still be on its
 * way proves nothing about where it ends; the next read (RETRY CHECK, every Home resume) settles it. A request an older
 * build sent is settled by its first answer ([SENT_BY_OLDER_BUILD_MS]). */
fun answeredSettled(facts: SavedRequestFacts): Boolean {
    val answered = facts.answeredAtMs ?: return false
    return answered - lastSendMs(facts) >= SAVED_REQUEST_MIN_AGE_MS
}

/** Owner 2026-10-06 ("it should be working"): a day after its last send, a request the server still answers `unknown` (or
 * `absent`) for is not worth a shut door. It no longer blocks and its CLOSE archives it on this device: kept, re-read on
 * every Home resume, so a late acceptance still surfaces. */
const val STALE_REQUEST_MS: Long = 24 * 60 * 60 * 1000L

/** The server's settled answer for a sent request is still `unknown`/`absent` [STALE_REQUEST_MS] after its last send, for an
 * operation that declares a client-side way out (never training's server closure, never an undeclared operation). */
fun staleUnanswered(spec: MoneyOpSpec<*>, intent: PendingIntent, facts: SavedRequestFacts, nowMs: Long): Boolean =
    intent.attempted && intent.receipt == null && answeredSettled(facts) && nowMs - lastSendMs(facts) >= STALE_REQUEST_MS &&
        (facts.answer == SavedRequestFacts.UNKNOWN || facts.answer == SavedRequestFacts.ABSENT) &&
        spec.savedRequestExit in setOf(SavedRequestExit.FORGET_AFTER_SERVER_ABSENT, SavedRequestExit.PARK_AFTER_RETRY_REFUSED)

/** Owner 2026-10-06: a saved request that no longer refuses a new order of its kind (it stays shown; a new order parks it).
 * Never a proven acceptance, never a never-sent request (CLOSE is its way out), never on an answer read before
 * [answeredSettled]. M3: a spec that
 * throws while describing the request fails CLOSED (keeps blocking, visible). */
fun supersedable(spec: MoneyOpSpec<*>, intent: PendingIntent, facts: SavedRequestFacts, nowMs: Long): Boolean = try {
    when {
        intent.receipt != null || !intent.attempted -> false
        spec.supersededByNewOrder(intent) -> true
        facts.retryRefused && spec.savedRequestExit == SavedRequestExit.PARK_AFTER_RETRY_REFUSED -> settled(facts, nowMs)
        !answeredSettled(facts) -> false
        staleUnanswered(spec, intent, facts, nowMs) -> true
        else -> factsAnswer(facts)?.let { spec.unblocksAfterCheck(intent, it) } ?: false
    }
} catch (error: CancellationException) { throw error } catch (_: Exception) { false }

/** A sent request (active or kept) that CLOSE may archive on this device: the server's absent answer (or an absence proof)
 * read once [answeredSettled] for an operation that forgets on absence, or [staleUnanswered]. */
fun archivable(spec: MoneyOpSpec<*>?, intent: PendingIntent, facts: SavedRequestFacts, nowMs: Long): Boolean = try {
    spec != null && intent.attempted && intent.receipt == null && (
        facts.answer == SavedRequestFacts.ABSENT && answeredSettled(facts) && spec.forgetsOnServerAbsent(intent) ||
            staleUnanswered(spec, intent, facts, nowMs))
} catch (error: CancellationException) { throw error } catch (_: Exception) { false }

/** CLOSE may archive this saved request: never sent; or [archivable]; or, for training, the server's own closure route on
 * `unknown`/`absent` (that route closes the key on the server and answers with the acceptance instead when the original won
 * the race, so it needs no client-side age). */
fun closableRequest(spec: MoneyOpSpec<*>?, intent: PendingIntent, facts: SavedRequestFacts, nowMs: Long): Boolean = try {
    intent.receipt == null && (!intent.attempted || archivable(spec, intent, facts, nowMs) || intent.kind == IntentKind.TRAINING_BATCH &&
        (facts.answer == SavedRequestFacts.UNKNOWN || facts.answer == SavedRequestFacts.ABSENT))
} catch (error: CancellationException) { throw error } catch (_: Exception) { false }

/** Canonical validation/auth/rate-limit failures reject before commit or roll back. A timeout
 * (408), an unfamiliar status or a server failure cannot disprove acceptance. 402 is the land gate
 * (`LAND_NOT_OWNED`, `requireLandOwned` / `lockActiveBase` in apps/api/src/game/routes.ts): raised in the
 * route's preHandler or the base lock, before any key is recorded, so nothing was charged. Owner's
 * Seeker 2026-10-06: a Gold Forge placed on a deedless base left an "Interrupted request · Build
 * goldforge" card that nothing could close, because this set did not know 402. */
fun isDefinitiveRejection(status: Int): Boolean = status in setOf(400, 401, 402, 403, 404, 409, 422, 429)

/**
 * One mechanism for every money-changing request:
 * 1. the intent (idempotency key + exact body) is persisted before the POST leaves the device;
 * 2. the POST is sent exactly once — the spec's definitive initial refusal retires the intent, any
 *    other failure keeps it as Unknown;
 * 3. recovery is GET-only through the operation's receipt route;
 * 4. an accepted result is persisted as a receipt, then [hydrate] re-reads the domain snapshot,
 *    and only then is the intent retired — a failed hydration keeps the proof and retries without
 *    any further POST;
 * 5. a saved Unknown intent blocks new intents of the same kind until it is observed or closed.
 */
class MoneyOp<T>(val spec: MoneyOpSpec<T>, private val store: PendingIntentStore, private val transport: OpTransport,
    private val clock: () -> Long = System::currentTimeMillis) {
    private val admission = Mutex()

    fun pending(wallet: String): PendingIntent? = store.get(spec.kind, wallet)

    /** The saved request that refuses a new order of this kind, or null: a request [supersedable] never blocks. */
    fun blocking(wallet: String): PendingIntent? = pending(wallet)?.takeUnless { supersedable(spec, it, store.facts(it), clock()) }

    /** The saved request's card may offer CLOSE ([closableRequest]): never sent, or a settled server `absent` answer. */
    fun closable(wallet: String): Boolean = pending(wallet)?.let { closableRequest(spec, it, store.facts(it), clock()) } ?: false

    /** Persists then sends a new intent. Throws [IllegalStateException] when a blocking one is already saved; a
     * [supersedable] saved request is parked first (kept on the device, never resent), so its door never stays shut. */
    suspend fun submit(intent: PendingIntent, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt.Accepted<T> {
        require(intent.kind == spec.kind && !intent.attempted && intent.receipt == null)
        return admitted {
            val created = io { store.create(intent) || supersede(intent) }
            check(created) { "Resolve the interrupted ${spec.kind} request before starting another" }
            send(intent, hydrate)
        }
    }

    /** Parks the exact saved record (compare-and-swap, kept and shown, never resent) only when it no longer blocks. */
    private fun supersede(next: PendingIntent): Boolean {
        val saved = store.get(spec.kind, next.wallet) ?: return false
        if (!supersedable(spec, saved, store.facts(saved), clock())) return false
        return store.park(saved) && store.create(next)
    }

    /** Re-sends an attempted intent by explicit player choice only; a rejection cannot retire it. */
    suspend fun retry(wallet: String, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt.Accepted<T> = admitted {
        val saved = requireNotNull(pending(wallet)) { "No saved ${spec.kind} request to retry" }
        check(saved.receipt == null) { "This request was already accepted; refresh instead of resending" }
        send(saved, hydrate)
    }

    /** GET-only observation of the saved intent, or null when nothing is saved for the wallet. */
    suspend fun observe(wallet: String, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt<T>? = admitted {
        val saved = pending(wallet) ?: return@admitted null
        observeSaved(saved, hydrate)
    }

    /**
     * CLOSE (owner review 2026-10-06). Never refunds or hides an acceptance, never sends an order:
     * - never sent ([PendingIntent.attempted] false, durable before any byte leaves): a read runs first when one exists (a
     *   proof found is applied), then the record is removed;
     * - sent: one more read; [Receipt.Absent] for a spec that [MoneyOpSpec.forgetsOnServerAbsent] ARCHIVES the record on
     *   this device (kept, re-read on every Home resume so a late acceptance surfaces), refused until the last attempt is
     *   [settled]; training uses its server closure route on `unknown`/`absent`; anything else is returned unchanged.
     */
    suspend fun close(wallet: String, confirmed: Boolean, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt<T>? {
        require(confirmed) { "Closing an interrupted request requires confirmation" }
        return admitted {
            val saved = pending(wallet) ?: return@admitted null
            if (!saved.attempted && saved.receipt == null) {
                val read = try { observeSaved(saved, hydrate) } catch (error: CancellationException) { throw error } catch (_: Exception) { null }
                if (read is Receipt.Accepted) return@admitted read
                return@admitted remove(saved)
            }
            val current = observeSaved(saved, hydrate)
            if (current != Receipt.Unknown && current != Receipt.Absent) return@admitted current
            val request = spec.closeRequest(saved) ?: return@admitted run {
                // The server's own closure route (training) is race-safe by itself; a client-side archive waits out the age
                // (absent) or a day (unknown, owner 2026-10-06), and the archive is re-read on every Home resume.
                val facts = io { store.facts(saved) }
                if (current == Receipt.Absent && spec.forgetsOnServerAbsent(saved)) check(answeredSettled(facts)) {
                    "Wait a few minutes before closing: the original request may still be on its way. Check it again later."
                }
                if (archivable(spec, saved, facts, clock())) archive(saved) else current
            }
            val attempted = saved.nextAttempt()
            io { check(store.replaceIfMatching(saved, attempted)) { "Saved request changed before closure" } }
            val response = try { transport.post(request.first, request.second) }
            catch (error: CancellationException) { throw error }
            catch (error: ApiException) { if (error.status < 500) throw error; return@admitted observeSaved(attempted, hydrate) }
            catch (_: IOException) { return@admitted observeSaved(attempted, hydrate) }
            accept(attempted, spec.decodeReceipt(attempted, response), hydrate)
        }
    }

    /** Re-reads a KEPT request (parked or closed), GET-only (owner review 2026-10-06, M2: a lost POST can commit after
     * CLOSE). An acceptance is hydrated (a failed hydration does not hide it) and the kept record released; any other
     * answer is recorded and the record stays kept. */
    suspend fun observeKept(kept: PendingIntent, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt<T> = admitted {
        require(kept.kind == spec.kind)
        val answer: Receipt<T> = read(kept)
        when (answer) {
            is Receipt.Accepted -> {
                try { hydrate(answer) } catch (error: CancellationException) { throw error } catch (_: Exception) { }
                io { store.releaseKept(kept) }
            }
            Receipt.Unknown, Receipt.Absent, Receipt.Unsupported -> io { store.recordAnswer(kept, answerName(answer), clock()) }
            is Receipt.Closed -> {}
        }
        answer
    }

    /** CLOSE of a request a newer order parked (owner 2026-10-06: two saved placements of one kind): one more GET-only read;
     * an acceptance is hydrated and released; [archivable] archives it (hidden, still re-read on every Home resume);
     * anything else is returned and it stays kept and shown. */
    suspend fun closeKept(kept: PendingIntent, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt<T> = admitted {
        require(kept.kind == spec.kind)
        val answer: Receipt<T> = read(kept)
        when (answer) {
            is Receipt.Accepted -> {
                try { hydrate(answer) } catch (error: CancellationException) { throw error } catch (_: Exception) { }
                io { store.releaseKept(kept) }
                return@admitted answer
            }
            Receipt.Unknown, Receipt.Absent, Receipt.Unsupported -> io { store.recordAnswer(kept, answerName(answer), clock()) }
            is Receipt.Closed -> {}
        }
        if (!archivable(spec, kept, io { store.facts(kept) }, clock())) return@admitted answer
        io { check(store.archiveKept(kept)) { "The saved ${spec.kind} request changed" } }
        Receipt.Closed(java.time.Instant.ofEpochMilli(clock()).toString())
    }

    private suspend fun send(intent: PendingIntent, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt.Accepted<T> {
        spec.validateSend(intent)
        val attempted = intent.nextAttempt()
        val before = if (intent.attempted) io { store.facts(intent) } else null
        // The attempted flag is durable before any bytes leave: a later rejection of a retry can
        // never be mistaken for a first-attempt rejection. Its time starts the minimum age (M2), and a new dispatch makes
        // the outcome open again: an earlier answer or refused-retry mark is cleared (m1).
        io { check(store.markAttempted(intent, attempted, clock())) { "The saved ${spec.kind} request changed" } }
        var refusalObserved = false
        val response = try { transport.postObserved(attempted) { error ->
            if (!refusalObserved && !intent.attempted && spec.observedInitialRejection(intent, error)) {
                // The transport calls synchronously on IO after parsing the original response.
                // Only this frozen wallet/key/attempt may retire; no UI or current-session reads.
                check(store.clearIfMatching(attempted)) { "Saved request changed before refusal evidence" }
                refusalObserved = true
            }
        } }
        catch (error: CancellationException) { throw error }
        catch (error: ApiException) {
            val resolved = if (isDefinitiveRejection(error.status)) spec.resolveRejection(intent, error) else null
            if (resolved != null) {
                val proven = attempted.copy(receipt = resolved.document)
                io { check(store.replaceIfMatching(attempted, proven)) { "The saved ${spec.kind} request changed" } }
                publish(proven, resolved, hydrate)
                return resolved
            }
            if (!refusalObserved && (spec.disprovesAcceptance(error) || (!intent.attempted && spec.definitiveInitialRejection(intent, error)))) io { store.clearIfMatching(attempted) }
            // Owner review 2026-10-06 (B1): only a code the spec PROVES is raised after the server's key lookup marks a refused
            // retry. 401/403/404/409/429 can come before it (rate limiter, session, base gates): the original may have
            // committed, so a new key could charge the player twice. Those keep blocking.
            else if (!refusalObserved && intent.attempted && spec.savedRequestExit == SavedRequestExit.PARK_AFTER_RETRY_REFUSED &&
                spec.refusedAfterKeyLookup(attempted, error)) io { store.recordRetryRefused(attempted) }
            // Owner 2026-10-06 (field: TRY AGAIN kept BUILD shut): the server answered this retry with a refusal, so THIS
            // dispatch is not in flight and cannot commit later. The earlier send time and checked answer stand again, so a
            // refused TRY AGAIN never restarts the minimum age. An ambiguous failure (timeout, 5xx) keeps the new send time.
            if (!refusalObserved && before?.answer != null && isDefinitiveRejection(error.status)) io { store.restoreFacts(attempted, before) }
            throw error
        }
        val value = try { spec.acknowledge(attempted, response) } catch (_: Exception) { throw ApiCompatibilityException(intent.path) }
        val accepted = Receipt.Accepted(value, spec.acknowledgementDocument(response))
        val proven = attempted.copy(receipt = accepted.document)
        io { check(store.replaceIfMatching(attempted, proven)) { "The saved ${spec.kind} request changed" } }
        publish(proven, accepted, hydrate)
        return accepted
    }

    private suspend fun observeSaved(saved: PendingIntent, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt<T> {
        saved.receipt?.let { document ->
            val accepted = Receipt.Accepted(spec.restore(saved, document), document)
            publish(saved, accepted, hydrate)
            return accepted
        }
        return accept(saved, read(saved), hydrate)
    }

    /** One GET-only read of a saved key: the key-scoped receipt route (a server `absent` answer for exactly this key reads as
     * [Receipt.Absent]), else the spec's absence proof through an existing read. Writes nothing. */
    private suspend fun read(saved: PendingIntent): Receipt<T> {
        val request = spec.receiptRequest(saved)
        if (request != null) {
            val response = try { transport.get(request.path, request.query) }
            catch (error: ApiException) { if (error.status == 404) return Receipt.Unsupported; throw error }
            if (absentAnswer(saved, response)) {
                // night/server: `absent` is final only once absentAsOf (server time, taken under the row lock) is the minimum
                // age after the last moment this request could have been sent; earlier it may still be in transit or admission.
                val asOf = absentAsOf(response) ?: return Receipt.Absent
                val sent = lastSendMs(io { store.facts(saved) })
                return if (asOf - sent >= SAVED_REQUEST_MIN_AGE_MS) Receipt.Absent else Receipt.Unknown
            }
            return spec.decodeReceipt(saved, response)
        }
        val probe = spec.absenceRequest(saved) ?: return Receipt.Unsupported
        val response = try { transport.get(probe.path, probe.query) }
        catch (error: ApiException) { if (error.status == 404) return Receipt.Unsupported; throw error }
        // B2: an effect that shows the order happened is an acceptance (hydrated), never an absence.
        runCatching { spec.effectAcceptance(saved, response) }.getOrNull()?.let { return it }
        return if (runCatching { spec.provesAbsence(saved, response) }.getOrDefault(false)) Receipt.Absent else Receipt.Unsupported
    }

    private suspend fun accept(saved: PendingIntent, receipt: Receipt<T>, hydrate: suspend (Receipt.Accepted<T>) -> Unit): Receipt<T> {
        when (receipt) {
            is Receipt.Accepted -> {
                val proven = saved.copy(attempted = true, receipt = receipt.document)
                io { check(store.replaceIfMatching(saved, proven)) { "The saved ${spec.kind} request changed" } }
                publish(proven, receipt, hydrate)
            }
            is Receipt.Closed -> io { check(store.clearIfMatching(saved)) { "The saved ${spec.kind} request changed" } }
            Receipt.Unknown, Receipt.Unsupported, Receipt.Absent -> io {
                check(store.get(saved.kind, saved.wallet) == saved) { "The saved ${spec.kind} request changed" }
                // Persisted so the answer (and with it CLOSE / a door that no longer blocks) survives a restart.
                store.recordAnswer(saved, answerName(receipt), clock())
            }
        }
        return receipt
    }

    private fun answerName(receipt: Receipt<*>): String = when (receipt) {
        Receipt.Absent -> SavedRequestFacts.ABSENT
        Receipt.Unsupported -> SavedRequestFacts.UNSUPPORTED
        else -> SavedRequestFacts.UNKNOWN
    }

    /** CLOSE of a sent request on a server `absent` answer (M2): the exact saved record is ARCHIVED on this device, never
     * deleted: it is re-read on every Home resume, so a late acceptance surfaces. Nothing is sent or hydrated. */
    private suspend fun archive(saved: PendingIntent): Receipt<T> {
        io { check(store.park(saved, closed = true)) { "The saved ${spec.kind} request changed" } }
        return Receipt.Closed(java.time.Instant.ofEpochMilli(clock()).toString())
    }

    /** CLOSE of a never-sent request: the server cannot know its key, so the exact record is removed. */
    private suspend fun remove(saved: PendingIntent): Receipt<T> {
        io { check(store.clearIfMatching(saved)) { "The saved ${spec.kind} request changed" } }
        return Receipt.Closed(java.time.Instant.ofEpochMilli(clock()).toString())
    }

    /** Hydrate first; retire the proven intent only after the snapshot was re-read with the same session. */
    private suspend fun publish(proven: PendingIntent, accepted: Receipt.Accepted<T>, hydrate: suspend (Receipt.Accepted<T>) -> Unit) {
        hydrate(accepted)
        io { check(store.clearIfMatching(proven)) { "The saved ${spec.kind} request changed" } }
    }

    private suspend fun <R> admitted(block: suspend () -> R): R {
        check(admission.tryLock()) { "This ${spec.kind} request is already being checked or sent" }
        try { return block() } finally { admission.unlock() }
    }
    // Keystore work stays off Main; a started journal write completes even if the caller is cancelled.
    private suspend fun <R> io(block: () -> R): R = withContext(NonCancellable + Dispatchers.IO) { block() }
}
