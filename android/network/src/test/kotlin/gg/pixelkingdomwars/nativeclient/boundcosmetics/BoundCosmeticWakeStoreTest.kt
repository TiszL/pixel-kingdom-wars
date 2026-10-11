package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.rejects
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeFixtures.command
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeFixtures.identity
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeFixtures.pending
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeFixtures.completed
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BoundCosmeticWakeStoreTest {
    private class Memory : SecretStore {
        var bytes: String? = null
        override fun read() = bytes
        override fun write(value: String) { bytes = value }
        override fun clear() = error("Saved originals must never be cleared")
    }
    @Test fun `Wake unknown remains durable through reopen and cannot be replaced or silently archived`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity, BoundCosmeticMode.WAKE)
        val draft = store.begin(store.read(), command()); assertFalse(draft.operation!!.attempted)
        val attempted = store.attempt(draft); val bytes = memory.bytes
        val reopened = BoundCosmeticStore(memory, identity, BoundCosmeticMode.WAKE); assertEquals(attempted, reopened.read())
        rejects { reopened.archive(attempted) }
        rejects { reopened.begin(attempted, command().copy(request = command().request.copy(idempotencyKey = "00000000-0000-4000-8000-000000000019"))) }
        rejects { reopened.accept(command(), pending().copy(status = "unknown", receipt = null, completion = null)) }
        rejects { reopened.attempt(draft) }; assertEquals(bytes, memory.bytes)
    }
    @Test fun `actual pending original recovers completed receipt in archives without changing accepted terms`() {
        val store = BoundCosmeticStore(Memory(), identity, BoundCosmeticMode.WAKE); val c = command()
        store.begin(store.read(), c); val accepted = store.accept(c, pending()); val archive = store.archive(accepted)
        assertNull(archive.operation); assertNull(archive.archives.single().proof!!.completion)
        val recovered = store.accept(c, completed()); assertEquals(completed(), recovered.archives.single().proof)
        assertEquals(pending().receipt, recovered.archives.single().proof!!.receipt)
        assertNull(recovered.operation)
        rejects { store.accept(c, pending()) }
        val changed = completed().copy(receipt = completed().receipt!!.let { it.copy(blueprint = it.blueprint.copy(jobId = "00000000-0000-4000-8000-000000000020")) })
        rejects { store.accept(c, changed) }; assertEquals(recovered, store.read())
    }
    @Test fun `cross-family and foreign identity journals fail without rewriting bytes and Awning encoding stays unchanged`() {
        val awningMemory = Memory(); val awningIdentity = BoundCosmeticFixtures.identity; val awningCommand = BoundCosmeticFixtures.command()
        val awning = BoundCosmeticStore(awningMemory, awningIdentity); val draft = awning.begin(awning.read(), awningCommand)
        val expected = BoundCosmeticJournal(1, awningIdentity, 1, BoundCosmeticOperation(awningCommand, false, null), emptyList())
        assertEquals(cosmeticJson.encodeToString(BoundCosmeticJournal.serializer(), expected), awningMemory.bytes)
        assertEquals(setOf("version", "identity", "revision", "operation", "archives"), cosmeticJson.parseToJsonElement(awningMemory.bytes!!).jsonObject.keys)
        assertEquals(draft, BoundCosmeticStore(awningMemory, awningIdentity, BoundCosmeticMode.AWNING).read())
        val oldBytes = awningMemory.bytes; rejects { BoundCosmeticStore(awningMemory, awningIdentity, BoundCosmeticMode.WAKE).read() }; assertEquals(oldBytes, awningMemory.bytes)
        val wakeMemory = Memory(); val wake = BoundCosmeticStore(wakeMemory, identity, BoundCosmeticMode.WAKE)
        rejects { wake.begin(wake.read(), awningCommand) }; assertNull(wakeMemory.bytes)
        wake.begin(wake.read(), command()); val wakeBytes = wakeMemory.bytes
        rejects { BoundCosmeticStore(wakeMemory, identity).read() }
        rejects { BoundCosmeticStore(wakeMemory, identity.copy(cluster = "mainnet-beta"), BoundCosmeticMode.WAKE).read() }
        rejects { BoundCosmeticStore(wakeMemory, identity.copy(wallet = awningIdentity.wallet), BoundCosmeticMode.WAKE).read() }
        assertEquals(wakeBytes, wakeMemory.bytes)
    }
    @Test fun `caller supplied account mutex serializes separate family stores while persisted commands remain isolated`() = runBlocking {
        // The app factory owns fixed encrypted purposes. This proves only the common network mutex seam.
        val mutex = Mutex(); val awningMemory = Memory(); val wakeMemory = Memory()
        val awning = BoundCosmeticStore(awningMemory, identity, requests = mutex)
        val wake = BoundCosmeticStore(wakeMemory, identity, BoundCosmeticMode.WAKE, mutex)
        assertSame(awning.requests, wake.requests); assertEquals(BoundCosmeticMode.AWNING, awning.mode)
        assertEquals(BoundCosmeticMode.WAKE, wake.mode)
        awning.requests.lock()
        try { assertFalse(wake.requests.tryLock()) } finally { awning.requests.unlock() }
        assertTrue(wake.requests.tryLock()); wake.requests.unlock()
        wake.begin(wake.read(), command()); assertNull(awning.read().operation); assertNull(awningMemory.bytes)
    }
}
