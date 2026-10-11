package gg.pixelkingdomwars.nativeclient.seekerresources

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerResourceClaimsTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val identity = StarterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private val row = SeekerResourceEntitlement(id(1), "a".repeat(64), "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z", 20,
        "rough_prism", 3, "32", "10", "0", "10")
    private fun view() = SeekerResourceEntitlementView(1, identity.wallet, true, false, "available", null, null, null, listOf(row))
    private fun command() = SeekerResourceClaimCommand(SeekerResourceClaimRequest(id(2), id(3), row.termId, row.resourceId, row.spotId), row.termHash, null)
    private fun receipt() = SeekerResourceClaimReceipt(id(2), id(3), row.termId, row.resourceId, row.spotId, id(2), identity.wallet,
        row.termHash, 3, "32", "0", "10", "10", "7", "17", "2026-09-09T00:00:00.000Z", false)
    private inline fun <reified T> raw(v: T) = seekerResourceJson.encodeToJsonElement(v).jsonObject
    private fun rejects(block: () -> Unit) = assertTrue(runCatching(block).isFailure)
    private class Memory : SecretStore {
        var bytes: String? = null; var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("storage unavailable"); bytes = value }
        override fun clear() { error("history is permanent") }
    }
    private inner class Port : SeekerResourceClaimPort {
        var posts = 0; var accepted = false; var lose = false; var afterRetain: () -> Unit = {}
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); return raw(SeekerResourceClaimEnvelope(identity.wallet, if (accepted) receipt() else null)).also(retain)
        }
        override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().request.body(), body); posts++; accepted = true
            if (lose) throw IOException("lost response")
            return raw(SeekerResourceClaimEnvelope(identity.wallet, receipt())).also { retain(it); afterRetain() }
        }
    }
    @Test fun `wire refuses false zero malformed arithmetic coerced scalars and mismatched originals`() {
        SeekerResourceEntitlementView.from(raw(view())); receipt().validate(identity, command())
        rejects { view().copy(status = "unavailable", reason = "SOURCE_BOUNDS").validate() }
        rejects { row.copy(dueQuantity = "9").validate() }
        rejects { row.copy(poolTotal = "032").validate() }
        rejects { view().copy(rows = listOf(row, row)).validate() }
        rejects { SeekerResourceEntitlementView.from(JsonObject(raw(view()) + ("claimsEnabled" to JsonPrimitive("true")))) }
        rejects { receipt().copy(stockAfter = "18").validate(identity, command()) }
        rejects { receipt().copy(spotId = 0).validate(identity, command()) }
        rejects { receipt().copy(shardsIncluded = true).validate(identity, command()) }
    }
    @Test fun `intent and attempt are durable before POST and ambiguous restart is GET only`() = runBlocking {
        val memory = Memory(); val store = SeekerResourceClaimStore(memory, identity); val port = Port()
        val transport = SeekerResourceClaimTransport(store, port)
        transport.begin(command(), view()) {}; port.lose = true
        rejects { runBlocking { transport.confirm(store.read(), ::view) {} } }; assertEquals(1, port.posts)
        assertNotNull(store.read().operation!!.attemptRevision)
        port.accepted = false
        val restarted = SeekerResourceClaimTransport(SeekerResourceClaimStore(memory, identity), port)
        restarted.check {}; rejects { runBlocking { restarted.confirm(store.read(), ::view) {} } }
        assertEquals(1, port.posts); port.accepted = true; restarted.check {}
        assertEquals(receipt(), store.read().operation!!.receipt)
    }
    @Test fun `paused recovery retains late owned receipt after cancellation without new admission`() = runBlocking {
        val store = SeekerResourceClaimStore(Memory(), identity); val port = Port(); val transport = SeekerResourceClaimTransport(store, port)
        transport.begin(command(), view()) {}; port.afterRetain = { throw kotlinx.coroutines.CancellationException("view retired") }
        rejects { runBlocking { transport.confirm(store.read(), ::view) {} } }
        assertEquals(receipt(), store.read().operation!!.receipt)
        transport.check {}; assertEquals(1, port.posts)
        rejects { store.accept(command(), receipt().copy(baseId = id(7))) }
    }
    @Test fun `accepted history needs hydration before next claim and old keys remain reserved`() = runBlocking {
        val store = SeekerResourceClaimStore(Memory(), identity); val port = Port(); val transport = SeekerResourceClaimTransport(store, port)
        transport.begin(command(), view()) {}; transport.confirm(store.read(), ::view) {}
        rejects { runBlocking { transport.finish({}, { throw IOException("hydrate failed") }) } }
        assertNotNull(store.read().operation)
        transport.finish({}, {}); assertNull(store.read().operation); assertEquals(1, store.read().archives.size)
        rejects { runBlocking { transport.begin(command(), view()) {} } }
        transport.checkArchive(command().key) {}; assertEquals(1, port.posts)
    }
    @Test fun `failed storage prevents submission and corrupt bytes remain recoverable`() = runBlocking {
        val memory = Memory(); val store = SeekerResourceClaimStore(memory, identity); val port = Port(); val transport = SeekerResourceClaimTransport(store, port)
        transport.begin(command(), view()) {}; memory.fail = true
        rejects { runBlocking { transport.confirm(store.read(), ::view) {} } }; assertEquals(0, port.posts)
        memory.fail = false; memory.bytes = "broken"; rejects { store.read() }; assertEquals("broken", memory.bytes)
    }
    @Test fun `only an unattempted draft may be abandoned after checking the same original`() = runBlocking {
        val store = SeekerResourceClaimStore(Memory(), identity); val port = Port(); val transport = SeekerResourceClaimTransport(store, port)
        transport.begin(command(), view()) {}; transport.abandonDraft {}; assertNull(store.read().operation)
        assertEquals("unattempted", store.read().archives.single().reason); assertEquals(0, port.posts)
    }
}
