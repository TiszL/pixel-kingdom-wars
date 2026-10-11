package gg.pixelkingdomwars.nativeclient.miningcontribution

import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/** Immutable authenticated-session adapter. Call guard again immediately before actual enqueue, after
 * IO/auth suspensions. Once the authenticated response body is explicitly owned, drain/validate its full bounded
 * body and call retain/refusal before cancellation or session rejection. Partial bodies supply no evidence.
 * A callback/storage exception fails closed; never swallow it or install obsolete response cookies. The app adapter uses the existing bounded
 * original response transport and never retries a mutation. */
interface MiningContributionPort {
    suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject
    suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject
}

/** Current review is used only for a new explicit POST; historical GET recovery never needs current flags,
 * prices, custody or selected base. Receipts are never published as current inventory. */
class MiningContributionTransport(private val store: MiningContributionStore, private val port: MiningContributionPort) {
    private suspend fun observe(command: MiningContributionCommand, guard: () -> Unit): MiningContributionProof {
        guard()
        fun retain(raw: JsonObject) {
            val proof = MiningContributionProof.from(raw, store.identity, command)
            if (proof.status == "accepted") store.accept(command, proof) else {
                val journal = store.read()
                val original = journal.operation?.takeIf { it.command.key == command.key }
                    ?: journal.archives.single { it.operation.command.key == command.key }.operation
                check(original.command == command && original.proof == null) { "Original accepted contribution proof disappeared." }
            }
        }
        val raw = port.get(command.receiptPath, guard, ::retain); retain(raw)
        guard(); return MiningContributionProof.from(raw, store.identity, command)
    }
    suspend fun begin(command: MiningContributionCommand, current: MiningContributionView, guard: () -> Unit): MiningContributionJournal = store.requests.withLock {
        guard(); command.admit(store.identity, current); store.begin(store.read(), command)
    }
    suspend fun check(guard: () -> Unit): MiningContributionJournal = store.requests.withLock {
        guard(); store.read().operation?.let { observe(it.command, guard) }; store.read()
    }
    suspend fun checkArchived(key: String, guard: () -> Unit): MiningContributionJournal = store.requests.withLock {
        guard(); val original = store.read().archives.single { it.operation.command.key == key }
        observe(original.operation.command, guard); store.read()
    }
    /** Exactly one POST per explicit confirmation. Every retry first observes unknown for the SAME original key
     * and rechecks that full original basket against the caller's current review at the actual enqueue boundary. */
    suspend fun confirm(expected: MiningContributionJournal, current: () -> MiningContributionView, guard: () -> Unit): MiningContributionJournal = store.requests.withLock {
        guard(); check(store.read() == expected); val original = requireNotNull(expected.operation)
        val observed = observe(original.command, guard)
        if (observed.status == "accepted") return@withLock store.read()
        val saved = store.read(); check(saved.operation?.command == original.command); check(saved.operation?.refusal == null)
        val first = saved.operation?.attemptRevision == null
        val enqueue = { guard(); original.command.admit(store.identity, current()) }
        enqueue(); val attempt = store.attempt(saved); enqueue()
        val retain: (JsonObject) -> Unit = { raw ->
            val proof = MiningContributionProof.from(raw, store.identity, original.command); require(proof.status == "accepted")
            store.accept(original.command, proof)
        }
        val refusal: (ApiException) -> Unit = { error ->
            if (first && miningContributionRefusalDefinitive(error.status, error.code))
                store.refuse(attempt, MiningContributionRefusal(error.status, requireNotNull(error.code)))
        }
        val raw = try { port.post("/mining/contributions", original.command.request.body(), enqueue, retain, refusal) }
            catch (error: ApiException) { refusal(error); throw error }
        retain(raw); guard(); store.read()
    }
    /** Archive the accepted contribution after separately hydrating current authorized stock. A failed read preserves
     * the receipt; later daily settlement can still be observed with checkArchived. */
    suspend fun finish(expected: MiningContributionJournal, guard: () -> Unit, hydrate: suspend () -> Unit): MiningContributionJournal = store.requests.withLock {
        check(store.read() == expected); val original = requireNotNull(expected.operation)
        check(observe(original.command, guard).status == "accepted"); val retained = store.read()
        hydrate(); guard(); store.archive(retained, "accepted", null)
    }
    /** Owner rule 2026-10-06 (no saved request blocks play forever): an attempted request with no refusal, whose
     *  fresh by-key read in this same locked action answered `unknown`, archives as "server-unknown" with that read as
     *  evidence. An acceptance found by the read is kept instead (accepted wins). Never POSTs. */
    suspend fun archiveUnknown(expected: MiningContributionJournal, guard: () -> Unit): MiningContributionJournal = store.requests.withLock {
        check(store.read() == expected); val original = requireNotNull(expected.operation)
        check(original.attemptRevision != null && original.proof == null && original.refusal == null)
        val proof = observe(original.command, guard); if (proof.status != "unknown") return@withLock store.read()
        guard(); store.archive(expected, "server-unknown", proof)
    }
    suspend fun archiveUnsentOrRefused(expected: MiningContributionJournal, guard: () -> Unit): MiningContributionJournal = store.requests.withLock {
        check(store.read() == expected); val original = requireNotNull(expected.operation)
        check(original.proof == null && (original.refusal != null || original.attemptRevision == null))
        val proof = observe(original.command, guard); check(proof.status == "unknown"); guard()
        store.archive(store.read(), if (original.refusal != null) "refused" else "unattempted", proof)
    }
}
