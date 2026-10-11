package gg.pixelkingdomwars.nativeclient.seekerresources

import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

interface SeekerResourceClaimPort {
    suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject
    suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject
}
class SeekerResourceClaimTransport(private val store: SeekerResourceClaimStore, private val port: SeekerResourceClaimPort) {
    private fun retain(command: SeekerResourceClaimCommand, raw: JsonObject, requireReceipt: Boolean = false) {
        val envelope = SeekerResourceClaimEnvelope.from(raw); check(envelope.wallet == store.identity.wallet)
        if (requireReceipt) check(envelope.receipt != null)
        envelope.receipt?.let { store.accept(command, it) } ?: run {
            val saved = store.read(); val op = saved.operation?.takeIf { it.command.key == command.key }
                ?: saved.archives.single { it.operation.command.key == command.key }.operation
            check(op.receipt == null) { "An accepted original receipt disappeared." }
        }
    }
    private suspend fun observe(command: SeekerResourceClaimCommand, guard: () -> Unit) {
        guard(); val raw = port.get(command.receiptPath, guard) { retain(command, it) }; retain(command, raw); guard()
    }
    suspend fun begin(command: SeekerResourceClaimCommand, current: SeekerResourceEntitlementView, guard: () -> Unit) = store.requests.withLock {
        guard(); command.admit(store.identity, current); store.begin(store.read(), command)
    }
    suspend fun check(guard: () -> Unit) = store.requests.withLock {
        guard(); store.read().operation?.let { observe(it.command, guard) }; store.read()
    }
    suspend fun checkArchive(key: String, guard: () -> Unit) = store.requests.withLock {
        observe(store.read().archives.single { it.operation.command.key == key }.operation.command, guard); store.read()
    }
    suspend fun confirm(expected: SeekerResourceClaimJournal, current: () -> SeekerResourceEntitlementView, guard: () -> Unit) = store.requests.withLock {
        guard(); check(store.read() == expected); val command = requireNotNull(expected.operation).command; observe(command, guard)
        val saved = store.read(); if (saved.operation?.receipt != null) return@withLock saved
        check(saved.operation?.attemptRevision == null) { "This request was already submitted. Check its saved receipt." }
        val enqueue = { guard(); command.admit(store.identity, current()) }
        enqueue(); store.attempt(saved); enqueue()
        val raw = port.post(command.request.body(), enqueue) { retain(command, it, true) }; retain(command, raw, true); guard(); store.read()
    }
    suspend fun finish(guard: () -> Unit, hydrate: suspend () -> Unit) = store.requests.withLock {
        guard(); val saved = store.read(); check(saved.operation?.receipt != null); hydrate(); guard(); store.archive(saved, "accepted")
    }
    /** Owner rule 2026-10-06 (no saved request blocks play forever): archives the attempted [expected] request as
     *  "server-unknown" only when a fresh by-key read in this same locked action answered no receipt for its key. A receipt
     *  found by that read is kept (accepted wins); a later receipt still merges into the archive. Never POSTs. */
    suspend fun archiveUnknown(expected: SeekerResourceClaimJournal, guard: () -> Unit) = store.requests.withLock {
        guard(); check(store.read() == expected); val op = requireNotNull(expected.operation); check(op.attemptRevision != null && op.receipt == null)
        observe(op.command, guard)
        val saved = store.read(); if (saved.operation?.receipt != null) return@withLock saved
        store.archive(expected, "server-unknown")
    }
    suspend fun abandonDraft(guard: () -> Unit) = store.requests.withLock {
        guard(); val op = requireNotNull(store.read().operation); check(op.attemptRevision == null && op.receipt == null)
        observe(op.command, guard); store.archive(store.read(), "unattempted")
    }
}
