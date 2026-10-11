package gg.pixelkingdomwars.nativeclient.seeker

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerShardsClaimsFlowTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val identity = StarterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private val json = Json { encodeDefaults = true }
    private val fixture = json.parseToJsonElement(javaClass.getResource("/seeker/shards-claims.json")!!.readText()).jsonObject
    private val policy = SeekerShardsClaimsPolicy.from(fixture.getValue("policy").jsonObject)
    private val request = SeekerShardsClaimRequest.from(fixture.getValue("request").jsonObject, policy)
    private val row = SeekerShardsEntitlementView.from(fixture.getValue("entitlements").jsonObject, policy).rows.single()
    private fun view() = SeekerShardsEntitlementView.from(fixture.getValue("entitlements").jsonObject, policy).copy(claimsEnabled = true)
    private fun command() = SeekerShardsClaimCommand(request, row.termHash, null, policy)
    private fun receipt() = SeekerShardsClaimEnvelope.from(fixture.getValue("envelope").jsonObject, policy).receipt!!
    private inline fun <reified T> raw(v: T) = json.encodeToJsonElement(v).jsonObject
    private fun rejects(block: () -> Unit) = assertTrue(runCatching(block).isFailure)
    private class Memory : SecretStore {
        var bytes: String? = null; var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("storage unavailable"); bytes = value }
        override fun clear() { error("history is permanent") }
    }
    private inner class Port : SeekerShardsClaimPort {
        var gets = 0; var posts = 0; var accepted = false; var lose = false; var afterRetain: () -> Unit = {}
        override suspend fun get(path: String, query: Map<String, String>, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); gets++; return raw(SeekerShardsClaimEnvelope(identity.wallet, if (accepted) receipt() else null)).also(retain)
        }
        override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().request.body(policy), body); posts++; accepted = true
            if (lose) throw IOException("lost response")
            return raw(SeekerShardsClaimEnvelope(identity.wallet, receipt())).also { retain(it); afterRetain() }
        }
    }
    @Test fun `intent and attempt are durable before POST and ambiguous restart is GET only`() = runBlocking {
        val memory = Memory(); val store = SeekerShardsClaimStore(memory, identity, policy); val port = Port()
        val transport = SeekerShardsClaimTransport(store, port)
        transport.begin(command(), view()) {}; port.lose = true
        rejects { runBlocking { transport.confirm(store.read(), ::view) {} } }; assertEquals(1, port.posts)
        assertNotNull(store.read().operation!!.attemptRevision)
        port.accepted = false
        val restarted = SeekerShardsClaimTransport(SeekerShardsClaimStore(memory, identity, policy), port)
        restarted.check {}; rejects { runBlocking { restarted.confirm(store.read(), ::view) {} } }
        assertEquals(1, port.posts); port.accepted = true; restarted.check {}
        assertEquals(receipt(), store.read().operation!!.receipt)
    }
    @Test fun `paused recovery retains late owned receipt after cancellation without new admission`() = runBlocking {
        val store = SeekerShardsClaimStore(Memory(), identity, policy); val port = Port(); val transport = SeekerShardsClaimTransport(store, port)
        transport.begin(command(), view()) {}; port.afterRetain = { throw kotlinx.coroutines.CancellationException("view retired") }
        rejects { runBlocking { transport.confirm(store.read(), ::view) {} } }
        assertEquals(receipt(), store.read().operation!!.receipt)
        transport.check {}; assertEquals(1, port.posts)
        rejects { store.accept(command(), receipt().copy(baseId = id(7))) }
    }
    @Test fun `accepted history needs fresh GET and hydration before next claim and old keys remain reserved`() = runBlocking {
        val store = SeekerShardsClaimStore(Memory(), identity, policy); val port = Port(); val transport = SeekerShardsClaimTransport(store, port)
        transport.begin(command(), view()) {}; transport.confirm(store.read(), ::view) {}
        rejects { runBlocking { transport.finish({}, { throw IOException("hydrate failed") }) } }
        assertNotNull(store.read().operation)
        val gets = port.gets; transport.finish({}, {}); assertTrue(port.gets > gets); assertNull(store.read().operation); assertEquals(1, store.read().archives.size)
        rejects { runBlocking { transport.begin(command(), view()) {} } }
        transport.checkArchive(command().key) {}; assertEquals(1, port.posts)
    }
    @Test fun `failed storage prevents submission and corrupt bytes remain recoverable`() = runBlocking {
        val memory = Memory(); val store = SeekerShardsClaimStore(memory, identity, policy); val port = Port(); val transport = SeekerShardsClaimTransport(store, port)
        transport.begin(command(), view()) {}; memory.fail = true
        rejects { runBlocking { transport.confirm(store.read(), ::view) {} } }; assertEquals(0, port.posts)
        memory.fail = false; memory.bytes = "broken"; rejects { store.read() }; assertEquals("broken", memory.bytes)
    }
    @Test fun `term hash substitution and disappearing receipt cannot unlock archived funds`() = runBlocking {
        val memory = Memory(); val store = SeekerShardsClaimStore(memory, identity, policy); val port = Port(); val transport = SeekerShardsClaimTransport(store, port)
        transport.begin(command(), view()) {}
        rejects { store.accept(command(), receipt().copy(termHash = "b".repeat(64))) }
        transport.confirm(store.read(), ::view) {}; port.accepted = false
        rejects { runBlocking { transport.finish({}, {}) } }; assertNotNull(store.read().operation?.receipt)
        port.accepted = true; transport.finish({}, {}); val copy = Memory().also { it.bytes = memory.bytes }
        assertEquals(receipt(), SeekerShardsClaimStore(copy, identity, policy).read().archives.single().operation.receipt)
        rejects { (store.read().archives as MutableList<SeekerShardsClaimArchive>).clear() }
    }
    @Test fun `stale journal revision and malformed persisted primitives refuse without clearing`() = runBlocking {
        val memory = Memory(); val store = SeekerShardsClaimStore(memory, identity, policy); val port = Port(); val transport = SeekerShardsClaimTransport(store, port)
        val original = store.read(); transport.begin(command(), view()) {}
        rejects { store.begin(original, command()) }; memory.bytes = memory.bytes!!.replace("\"revision\":1", "\"revision\":\"1\"")
        rejects { store.read() }; assertTrue(memory.bytes!!.contains("\"revision\":\"1\""))
    }
    @Test fun `only an unattempted draft may be abandoned after checking the same original`() = runBlocking {
        val store = SeekerShardsClaimStore(Memory(), identity, policy); val port = Port(); val transport = SeekerShardsClaimTransport(store, port)
        transport.begin(command(), view()) {}; transport.abandonDraft {}; assertNull(store.read().operation)
        assertEquals("unattempted", store.read().archives.single().reason); assertEquals(0, port.posts)
    }
}
