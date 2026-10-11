package gg.pixelkingdomwars.nativeclient.freebase

import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/** Authenticated adapters retain an owned bounded response before checking cancellation or session epoch. */
interface FreeBasePurchasePort {
    suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject
    suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject
}
class FreeBasePurchaseTransport(private val store: FreeBasePurchaseStore, private val port: FreeBasePurchasePort) {
    private suspend fun observe(command: FreeBasePurchaseCommand, guard: () -> Unit) {
        guard()
        fun retain(raw: JsonObject) {
            val receipt = FreeBasePurchaseEnvelope.from(raw).receipt
            if (receipt != null) store.accept(command, receipt)
            else check(store.read().operation?.receipt == null) { "The server omitted an already accepted receipt." }
        }
        val raw = port.get(command.receiptPath, guard, ::retain); retain(raw); guard()
    }
    suspend fun begin(command: FreeBasePurchaseCommand, current: FreeBasePurchaseView, guard: () -> Unit) = store.requests.withLock {
        guard(); command.admit(store.identity, current); store.begin(store.read(), command)
    }
    suspend fun check(guard: () -> Unit) = store.requests.withLock {
        guard(); store.read().operation?.let { observe(it.command, guard) }; store.read()
    }
    /** Owner rule 2026-10-06 (no saved request blocks play forever): an explicit CLOSE re-reads the by-key receipt in
     *  this same locked action and clears [expected] only when that read answered no receipt for exactly its key. A
     *  receipt found by the read is kept (accepted wins). Never POSTs. */
    suspend fun close(expected: FreeBasePurchaseJournal, guard: () -> Unit) = store.requests.withLock {
        guard(); check(store.read() == expected); val op = requireNotNull(expected.operation); check(op.receipt == null)
        observe(op.command, guard)
        val saved = store.read(); if (saved.operation?.receipt != null) return@withLock saved
        store.close(expected)
    }
    /** Only explicit confirmation can POST; every retry recovers the same key first. */
    suspend fun confirm(expected: FreeBasePurchaseJournal, current: () -> FreeBasePurchaseView, guard: () -> Unit) = store.requests.withLock {
        guard(); check(store.read() == expected); val command = requireNotNull(expected.operation).command
        observe(command, guard)
        val saved = store.read(); if (saved.operation?.receipt != null) return@withLock saved
        val enqueue = { guard(); command.admit(store.identity, current()) }
        enqueue(); store.attempt(saved); enqueue()
        val retain: (JsonObject) -> Unit = { raw -> store.accept(command, FreeBasePurchaseReceipt.from(raw)) }
        val raw = port.post(command.request.body(), enqueue, retain); retain(raw); guard(); store.read()
    }
}
