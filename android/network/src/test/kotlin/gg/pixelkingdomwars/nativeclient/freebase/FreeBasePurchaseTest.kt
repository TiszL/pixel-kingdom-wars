package gg.pixelkingdomwars.nativeclient.freebase

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class FreeBasePurchaseTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val identity = StarterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private val terms = FreeBasePurchaseTerms(1, "98765", 6, 2, 3, 2, 5)
    private fun view() = FreeBasePurchaseView(1, identity.wallet, true, id(1), terms, FreeBasePurchaseAdmission(true, "ready"), null)
    private fun command() = FreeBasePurchaseCommand.review(identity, view(), id(2))
    private fun receipt() = FreeBasePurchaseReceipt(1, identity.wallet, id(2), id(1), id(3), 2, terms.costShards,
        id(4), FreeBasePurchaseDevelopment(id(5), 6, id(6), 2, id(7), 3), "2026-09-25T00:00:00.000Z")
    private inline fun <reified T> raw(value: T) = freeBaseJson.encodeToJsonElement(value).jsonObject
    private fun rejects(block: () -> Unit) = assertTrue(runCatching(block).isFailure)
    private class Memory : SecretStore {
        var bytes: String? = null; var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("storage unavailable"); bytes = value }
        override fun clear() { error("purchase history cannot be discarded") }
    }
    private inner class Port : FreeBasePurchasePort {
        var posts = 0; var accepted = false
        var answer: ((JsonObject) -> Unit) -> JsonObject = { retain -> raw(receipt()).also(retain) }
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().receiptPath, path)
            return raw(FreeBasePurchaseEnvelope(if (accepted) receipt() else null)).also(retain)
        }
        override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().request.body(), body); posts++; return answer(retain)
        }
    }
    @Test fun `wire parsing rejects coerced amounts scalars unknown versions and inconsistent admission`() {
        FreeBasePurchaseView.from(raw(view()))
        for (amount in listOf("01", "0", "1.2", "9223372036854775808", "-1")) rejects { terms.copy(costShards = amount).validate() }
        rejects { FreeBasePurchaseView.from(JsonObject(raw(view()) + ("enabled" to JsonPrimitive("true")))) }
        rejects { view().copy(version = 2).validate() }
        rejects { view().copy(enabled = false).validate() }
        rejects { view().copy(admission = FreeBasePurchaseAdmission(false, "ready")).validate() }
        rejects { FreeBasePurchaseView.from(JsonObject(raw(view()) + ("callerScore" to JsonPrimitive(1)))) }
    }
    @Test fun `original receipt is bound to wallet source request reviewed price and development policy`() {
        receipt().validate(identity, command())
        for (changed in listOf(receipt().copy(wallet = "11111111111111111111111111111112"), receipt().copy(sourceBaseId = id(8)),
            receipt().copy(idempotencyKey = id(8)), receipt().copy(shardsCharged = "1"), receipt().copy(version = 2),
            receipt().copy(baseId = id(1)), receipt().copy(development = receipt().development.copy(keepLevel = 1)))) {
            rejects { changed.validate(identity, command()) }
        }
        rejects { command().admit(identity, view().copy(terms = terms.copy(costShards = "99999"))) }
    }
    @Test fun `intent and attempt persist before any POST and restart recovery is GET only`() = runBlocking {
        val memory = Memory(); val store = FreeBasePurchaseStore(memory, identity); val port = Port(); val transport = FreeBasePurchaseTransport(store, port)
        val saved = transport.begin(command(), view()) {}; assertNotNull(memory.bytes); assertEquals(0, port.posts)
        port.answer = { assertNotNull(store.read().operation!!.attemptRevision); throw IOException("lost response") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; assertEquals(1, port.posts)
        val restarted = FreeBasePurchaseTransport(FreeBasePurchaseStore(memory, identity), port)
        restarted.check {}; restarted.check {}; assertEquals(1, port.posts)
        port.accepted = true; restarted.check {}; assertEquals(receipt(), store.read().operation!!.receipt)
    }
    @Test fun `paused original receipt recovers before current availability is needed`() = runBlocking {
        val store = FreeBasePurchaseStore(Memory(), identity); val port = Port(); val transport = FreeBasePurchaseTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.accepted = true
        transport.confirm(saved, { error("paused server must not require current admission") }) {}
        assertEquals(0, port.posts); assertEquals(receipt(), store.read().operation!!.receipt)
    }
    @Test fun `late owned acceptance survives cancellation and cannot replace another receipt`() = runBlocking {
        val store = FreeBasePurchaseStore(Memory(), identity); val port = Port(); val transport = FreeBasePurchaseTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        port.answer = { retain -> retain(raw(receipt())); throw CancellationException("view retired") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        assertEquals(receipt(), store.read().operation!!.receipt)
        rejects { store.accept(command(), receipt().copy(baseId = id(9))) }
    }
    @Test fun `failed persistence refuses POST and malformed storage is preserved`() = runBlocking {
        val memory = Memory(); val store = FreeBasePurchaseStore(memory, identity); val port = Port(); val transport = FreeBasePurchaseTransport(store, port)
        val saved = transport.begin(command(), view()) {}; memory.fail = true
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; assertEquals(0, port.posts)
        memory.fail = false; memory.bytes = "corrupt encrypted payload"
        rejects { store.read() }; assertEquals("corrupt encrypted payload", memory.bytes)
    }
    @Test fun `same-key explicit retry checks exact terms and enqueue guard after attempt persistence`() = runBlocking {
        val store = FreeBasePurchaseStore(Memory(), identity); val port = Port(); val transport = FreeBasePurchaseTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.answer = { throw IOException("ambiguous") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        rejects { runBlocking { transport.confirm(store.read(), { view().copy(terms = terms.copy(minKeepLevel = 7)) }) {} } }
        assertEquals(1, port.posts)
        port.answer = { retain -> raw(receipt()).also(retain) }
        transport.confirm(store.read(), ::view) {}; assertEquals(2, port.posts)
        assertEquals(command(), store.read().operation!!.command)
    }
}
