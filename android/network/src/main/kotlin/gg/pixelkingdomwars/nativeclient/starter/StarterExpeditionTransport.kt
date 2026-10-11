package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.fleetjourney.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/** Future immutable authenticated-session adapter. Call guard again immediately before actual enqueue, after
 * IO/auth suspensions. Once the authenticated response body is explicitly owned, drain/validate its full bounded
 * body and call retain/refusal before cancellation or session rejection. Partial bodies supply no evidence.
 * A callback/storage exception fails closed; never swallow it or install obsolete response cookies. No app adapter
 * or network retry is supplied by this foundation. */
interface StarterExpeditionPort {
    suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject
    suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject
    /** Old adapters provide no live HTTP provenance and therefore cannot emit. */
    suspend fun postWithDeparture(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit,
        refusal: (ApiException) -> Unit, created: (FreshFleetDeparture) -> Unit): JsonObject = post(path, body, guard, retain, refusal)
}

/** Current review is used only for a new explicit POST; historical GET recovery never needs current flags,
 * routes, custody or selected base. Receipts are never published as current inventory. */
class StarterExpeditionTransport(private val store: StarterExpeditionStore, private val port: StarterExpeditionPort,
    private val captureDeparture: FleetDepartureCapture = { _, _ -> null }) {
    private suspend fun observe(command: StarterExpeditionCommand, guard: () -> Unit): StarterExpeditionProof {
        guard()
        fun retain(raw: JsonObject) {
            val proof = StarterExpeditionProof.from(raw, store.identity, command)
            if (proof.status == "accepted") store.accept(command, proof) else {
                val journal = store.read()
                val original = journal.operation?.takeIf { it.command.key == command.key }
                    ?: journal.archives.single { it.operation.command.key == command.key }.operation
                check(original.command == command && original.proof == null) { "Original accepted starter proof disappeared." }
            }
        }
        val raw = port.get(command.receiptPath, guard, ::retain); retain(raw)
        guard(); return StarterExpeditionProof.from(raw, store.identity, command)
    }
    suspend fun begin(command: StarterExpeditionCommand, current: StarterExpeditionView, guard: () -> Unit): StarterExpeditionJournal = store.requests.withLock {
        guard(); command.admit(store.identity, current); store.begin(store.read(), command)
    }
    suspend fun beginPaid(command: StarterExpeditionCommand, current: StarterExpeditionView, selected: PaidStarterExpeditionView, guard: () -> Unit): StarterExpeditionJournal = store.requests.withLock {
        guard(); command.admitPaid(store.identity, current, selected); store.begin(store.read(), command)
    }
    suspend fun check(guard: () -> Unit): StarterExpeditionJournal = store.requests.withLock {
        guard(); store.read().operation?.let { observe(it.command, guard) }; store.read()
    }
    suspend fun checkArchived(key: String, guard: () -> Unit): StarterExpeditionJournal = store.requests.withLock {
        guard(); val original = store.read().archives.single { it.operation.command.key == key }
        observe(original.operation.command, guard); store.read()
    }
    /** Exactly one POST per explicit confirmation. Every retry first observes unknown for the SAME original key
     * and rechecks that full original route against the caller's current review at the actual enqueue boundary. */
    suspend fun confirm(expected: StarterExpeditionJournal, current: () -> StarterExpeditionView, guard: () -> Unit): StarterExpeditionJournal =
        confirmReviewed(expected, guard) { command -> command.admit(store.identity, current()) }
    suspend fun confirmPaid(expected: StarterExpeditionJournal, current: () -> StarterExpeditionView, selected: () -> PaidStarterExpeditionView, guard: () -> Unit): StarterExpeditionJournal =
        confirmReviewed(expected, guard) { command -> command.admitPaid(store.identity, current(), selected()) }
    private suspend fun confirmReviewed(expected: StarterExpeditionJournal, guard: () -> Unit, admit: (StarterExpeditionCommand) -> Unit): StarterExpeditionJournal = store.requests.withLock {
        guard(); check(store.read() == expected); val original = requireNotNull(expected.operation)
        val observed = observe(original.command, guard)
        if (observed.status == "accepted") return@withLock store.read()
        val saved = store.read(); check(saved.operation?.command == original.command); check(saved.operation?.refusal == null)
        val first = saved.operation?.attemptRevision == null
        val enqueue = { guard(); admit(original.command) }
        enqueue(); val attempt = store.attempt(saved); enqueue()
        val retain: (JsonObject) -> Unit = { raw ->
            val proof = StarterExpeditionProof.from(raw, store.identity, original.command); require(proof.status == "accepted")
            store.accept(original.command, proof)
        }
        val refusal: (ApiException) -> Unit = { error ->
            if (first && starterExpeditionRefusalDefinitive(error.status, error.code))
                store.refuse(attempt, StarterExpeditionRefusal(error.status, requireNotNull(error.code)))
        }
        val body = original.command.request.body()
        val observer = captureFleetDeparture(captureDeparture, "POST", "/starter-expeditions", body, guard)
        var departure: FreshFleetDeparture? = null
        val raw = try { port.postWithDeparture("/starter-expeditions", body, enqueue, retain, refusal) { departure = it } }
            catch (error: ApiException) { refusal(error); throw error }
        retain(raw); guard()
        val retained = store.read()
        deliverFleetDeparture(departure?.takeIf { it.original == raw }, guard, observer)
        retained
    }
    /** Archive accepted proof only after separately hydrating the current authorized base. Failed hydration
     * preserves the original proof. Historical checks never publish inventory or create a Collect action. */
    suspend fun finish(expected: StarterExpeditionJournal, guard: () -> Unit, hydrate: suspend () -> Unit): StarterExpeditionJournal = store.requests.withLock {
        check(store.read() == expected); val original = requireNotNull(expected.operation)
        check(observe(original.command, guard).status == "accepted"); val retained = store.read()
        hydrate(); guard(); store.archive(retained, "accepted", null)
    }
    /** Owner 2026-10-06 (dead-end audit): no saved request may block departures forever. A paid departure is never
     * retried, so an attempted one with no outcome could otherwise never clear. Any unproven request closes only after
     * this action's fresh by-key GET answers `unknown` for exactly its key (an acceptance found there is retained and
     * refuses the close). An attempted, unrefused request closes as "unknown"; a later acceptance still merges into its
     * archive through checkArchived. Never a POST. */
    suspend fun archiveUnsentOrRefused(expected: StarterExpeditionJournal, guard: () -> Unit): StarterExpeditionJournal = store.requests.withLock {
        check(store.read() == expected); val original = requireNotNull(expected.operation)
        check(original.proof == null)
        val proof = observe(original.command, guard); check(proof.status == "unknown"); guard()
        store.archive(store.read(), when { original.refusal != null -> "refused"; original.attemptRevision == null -> "unattempted"; else -> "unknown" }, proof)
    }
}
