package gg.pixelkingdomwars.nativeclient.workshop

import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/** Immutable authenticated session adapter must execute guard immediately before actual enqueue,
 * including after IO/auth suspensions. This inactive foundation deliberately supplies no app adapter. */
interface WorkshopPort {
    suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject
    suspend fun post(path: String, body: JsonObject, guard: () -> Unit, refusal: (ApiException) -> Unit)
}
/** No automatic mutation, timer retry, or publication of receipt quantities as live inventory.
 * App integration supplies a new-command admission guard (session, base generation, lifecycle,
 * reviewed terms/day and live update interlocks). Recovery guard binds only wallet/session/lifecycle. */
class WorkshopTransport(private val store: WorkshopStore, private val port: WorkshopPort) {
    private suspend fun observe(expected: WorkshopJournal, guard: () -> Unit): Pair<WorkshopJournal, WorkshopProof> {
        val command = requireNotNull(expected.operation).command; guard()
        var retained = expected
        val retain: (JsonObject) -> Unit = { raw ->
            val proof = WorkshopProof.from(raw, store.identity, command)
            if (proof.status == "accepted") retained = store.accept(retained, proof)
            else { check(retained.operation?.proof == null) { "Original accepted proof disappeared." }; check(store.read() == retained) }
        }
        val raw = port.get(command.receiptPath, guard, retain); retain(raw)
        val proof = WorkshopProof.from(raw, store.identity, command)
        guard(); return retained to proof
    }
    suspend fun begin(command: WorkshopCommand, guard: () -> Unit): WorkshopJournal = store.requests.withLock {
        guard(); command.validate(); val old = store.read(); check(old.operation == null)
        var retained: WorkshopJournal? = null
        val retain: (JsonObject) -> Unit = { raw ->
            val proof = WorkshopProof.from(raw, store.identity, command)
            if (proof.status == "accepted") retained = retained?.let { store.accept(it, proof) } ?: store.begin(old, command, proof)
            else check(retained == null) { "Original accepted proof disappeared." }
        }
        val raw = port.get(command.receiptPath, guard, retain); retain(raw)
        guard(); retained ?: store.begin(old, command)
    }

    suspend fun check(guard: () -> Unit): WorkshopJournal = store.requests.withLock {
        guard(); val saved = store.read(); if (saved.operation == null) saved else observe(saved, guard).first
    }
    /** Explicit user consent only. The caller must supply current admission at the actual send
     * boundary. Every attempt checks the same original GET first and sends exactly its saved body. */
    suspend fun confirm(expected: WorkshopJournal, guard: () -> Unit): WorkshopJournal = store.requests.withLock {
        guard(); check(store.read() == expected); val (observed, proof) = observe(expected, guard)
        if (proof.status == "accepted") return@withLock observed
        val old = requireNotNull(observed.operation); check(old.refusal == null); val first = !old.attempted
        guard(); val marked = store.attempt(observed); guard()
        var retained: WorkshopJournal? = null
        val retainRefusal: (ApiException) -> Unit = { error ->
            if (first && workshopRefusalDefinitive(old.command.kind, error.status, error.code)) {
                val refusal = WorkshopRefusal(error.status, requireNotNull(error.code))
                // Called only for this original POST, possibly on IO before session rejection.
                // The same visible exception may reach catch below; it cannot write twice.
                val saved = retained
                if (saved == null) retained = store.refuse(marked, refusal)
                else check(saved.operation?.refusal == refusal && store.read() == saved)
            }
        }
        try { port.post(old.command.postPath, old.command.body(), guard, retainRefusal) }
        catch (e: ApiException) { retainRefusal(e); throw e }
        // A POST acknowledgement and any later GET error cannot prove completion/refusal.
        observe(marked, guard).first
    }
    /** Called only after fresh owned-base/balance hydration by the future repository. */
    suspend fun finish(expected: WorkshopJournal, guard: () -> Unit, hydrate: suspend () -> Unit): WorkshopJournal = store.requests.withLock {
        check(store.read() == expected); val (saved, proof) = observe(expected, guard); check(proof.status == "accepted")
        hydrate(); guard(); store.archive(saved, "accepted", null)
    }
    /** Owner 2026-10-06 (dead-end audit): no saved request may block Forge Ingots forever. Any unproven request closes
     * only after this action's fresh by-key GET answers `unknown` for exactly its key (an acceptance found there is
     * retained and refuses the close). An attempted, unrefused request closes as "unknown". Never a POST.
     * This journal keeps no archived-receipt recovery: a later acceptance is not merged into the closed record; its
     * job, charge or credit appears only in the server's current Workshop view and balances. */
    suspend fun archiveUnsentOrRefused(expected: WorkshopJournal, guard: () -> Unit): WorkshopJournal = store.requests.withLock {
        check(store.read() == expected); val old = requireNotNull(expected.operation)
        check(old.proof == null)
        val (saved, proof) = observe(expected, guard); check(proof.status == "unknown")
        guard(); store.archive(saved, when { old.refusal != null -> "refused"; !old.attempted -> "unattempted"; else -> "unknown" }, proof)
    }
}
