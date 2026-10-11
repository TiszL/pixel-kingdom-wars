package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/** Future immutable authenticated-session adapter. Call guard again immediately before actual enqueue, after
 * IO/auth suspensions. Once the authenticated response body is explicitly owned, drain/validate its full bounded
 * body and call retain/refusal before cancellation or session rejection. Partial bodies supply no evidence.
 * A callback/storage exception fails closed; never swallow it or install obsolete response cookies. No app adapter
 * or network retry is supplied by this foundation. */
interface StarterFleetPort {
    suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject
    suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject
}

/** Current review is used only for a new explicit POST; historical GET recovery never needs current flags,
 * berths, custody or selected base. Receipts are never published as current inventory. */
class StarterFleetTransport(private val store: StarterFleetStore, private val port: StarterFleetPort) {
    private suspend fun observe(command: StarterFleetCommand, guard: () -> Unit): StarterFleetProof {
        guard()
        fun retain(raw: JsonObject) {
            val proof = StarterFleetProof.from(raw, store.identity, command)
            if (proof.status == "accepted") store.accept(command, proof) else {
                val journal = store.read()
                val original = journal.operation?.takeIf { it.command.key == command.key }
                    ?: journal.archives.single { it.operation.command.key == command.key }.operation
                check(original.command == command && original.proof == null) { "Original accepted starter proof disappeared." }
            }
        }
        val raw = port.get(command.receiptPath, guard, ::retain); retain(raw)
        guard(); return StarterFleetProof.from(raw, store.identity, command)
    }
    suspend fun begin(command: StarterFleetCommand, current: StarterFleetView, guard: () -> Unit): StarterFleetJournal = store.requests.withLock {
        guard(); command.admit(store.identity, current); store.begin(store.read(), command)
    }
    suspend fun check(guard: () -> Unit): StarterFleetJournal = store.requests.withLock {
        guard(); store.read().operation?.let { observe(it.command, guard) }; store.read()
    }
    suspend fun checkArchived(key: String, guard: () -> Unit): StarterFleetJournal = store.requests.withLock {
        guard(); val original = store.read().archives.single { it.operation.command.key == key }
        observe(original.operation.command, guard); store.read()
    }
    /** Exactly one POST per explicit confirmation. Every retry first observes unknown for the SAME original key
     * and rechecks that full original berth against the caller's current review at the actual enqueue boundary. */
    suspend fun confirm(expected: StarterFleetJournal, current: () -> StarterFleetView, guard: () -> Unit): StarterFleetJournal = store.requests.withLock {
        guard(); check(store.read() == expected); val original = requireNotNull(expected.operation)
        val observed = observe(original.command, guard)
        if (observed.status == "accepted") return@withLock store.read()
        val saved = store.read(); check(saved.operation?.command == original.command); check(saved.operation?.refusal == null)
        val first = saved.operation?.attemptRevision == null
        val enqueue = { guard(); original.command.admit(store.identity, current()) }
        enqueue(); val attempt = store.attempt(saved); enqueue()
        val retain: (JsonObject) -> Unit = { raw ->
            val proof = StarterFleetProof.from(raw, store.identity, original.command); require(proof.status == "accepted")
            store.accept(original.command, proof)
        }
        val refusal: (ApiException) -> Unit = { error ->
            if (first && starterFleetRefusalDefinitive(error.status, error.code))
                store.refuse(attempt, StarterFleetRefusal(error.status, requireNotNull(error.code)))
        }
        val raw = try { port.post("/starter-fleet/installations", original.command.request.body(), enqueue, retain, refusal) }
            catch (error: ApiException) { refusal(error); throw error }
        retain(raw); guard(); store.read()
    }
    /** Archive accepted proof only after separately hydrating the current authorized base. Failed hydration
     * preserves the original proof. Historical checks never publish inventory or create a Collect action. */
    suspend fun finish(expected: StarterFleetJournal, guard: () -> Unit, hydrate: suspend () -> Unit): StarterFleetJournal = store.requests.withLock {
        check(store.read() == expected); val original = requireNotNull(expected.operation)
        check(observe(original.command, guard).status == "accepted"); val retained = store.read()
        hydrate(); guard(); store.archive(retained, "accepted", null)
    }
    /** Owner 2026-10-06 (dead-end audit): no saved request may block installation forever. Any unproven request closes
     * only after this action's fresh by-key GET answers `unknown` for exactly its key (an acceptance found there is
     * retained and refuses the close). An attempted, unrefused request closes as "unknown"; a later acceptance still
     * merges into its archive through checkArchived. Never a POST. */
    suspend fun archiveUnsentOrRefused(expected: StarterFleetJournal, guard: () -> Unit): StarterFleetJournal = store.requests.withLock {
        check(store.read() == expected); val original = requireNotNull(expected.operation)
        check(original.proof == null)
        val proof = observe(original.command, guard); check(proof.status == "unknown"); guard()
        store.archive(store.read(), when { original.refusal != null -> "refused"; original.attemptRevision == null -> "unattempted"; else -> "unknown" }, proof)
    }
}
