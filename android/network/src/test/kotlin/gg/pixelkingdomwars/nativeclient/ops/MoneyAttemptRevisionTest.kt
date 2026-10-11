package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class MoneyAttemptRevisionTest {
    private val original = GemsFromKeepSpec.intent(WALLET, "attempt-revision-key", "10")
    @Test fun `legacy journals default to zero and every dispatch persists a new revision across reopen`() = runBlocking {
        val disk = MemoryStore(); var store = PendingIntentStore(disk)
        store.create(original.copy(attempted = true))
        assertFalse(disk.value!!.contains("attemptRevision"))
        repeat(2) { index ->
            store = PendingIntentStore(disk)
            val op = MoneyOp(GemsFromKeepSpec, store, ScriptedTransport(onPost = { _, _ ->
                assertEquals((index + 1).toLong(), PendingIntentStore(disk).get(original.kind, WALLET)!!.attemptRevision)
                throw IOException("Uncertain response")
            }))
            assertThrows(IOException::class.java) { runBlocking { op.retry(WALLET) {} } }
            assertEquals(original.copy(attempted = true, attemptRevision = (index + 1).toLong()), PendingIntentStore(disk).get(original.kind, WALLET))
        }
    }
    @Test fun `malformed revisions fail closed and overflow never sends or changes journal`() {
        val disk = MemoryStore(); PendingIntentStore(disk).create(original.copy(attempted = true))
        val legacy = Json.parseToJsonElement(disk.value!!).jsonObject
        for (bad in listOf<JsonElement>(JsonNull, JsonPrimitive("1"), JsonPrimitive(-1), JsonPrimitive(1.5), JsonPrimitive(true),
            Json.parseToJsonElement("9223372036854775808"), Json.parseToJsonElement("1e2"))) {
            val raw = legacy["intents"]!!.jsonArray.single().jsonObject
            val corrupt = JsonObject(legacy + ("intents" to JsonArray(listOf(JsonObject(raw + ("attemptRevision" to bad)))))).toString()
            val bytes = MemoryStore(corrupt); val store = PendingIntentStore(bytes)
            assertThrows(Exception::class.java) { store.all(WALLET) }; assertThrows(Exception::class.java) { store.create(original) }
            assertEquals(corrupt, bytes.value); assertEquals(0, bytes.writes)
        }
        val max = original.copy(attempted = true, attemptRevision = Long.MAX_VALUE)
        val store = PendingIntentStore(MemoryStore()); store.create(max); val wire = ScriptedTransport()
        assertThrows(IllegalStateException::class.java) { runBlocking { MoneyOp(GemsFromKeepSpec, store, wire).retry(WALLET) {} } }
        assertEquals(max, store.get(original.kind, WALLET)); assertTrue(wire.posts.isEmpty())
    }
    @Test fun `revision CAS rejects rollback skips and old same-key refusal after a newer attempt`() {
        val store = PendingIntentStore(MemoryStore()); val first = original.nextAttempt(); store.create(first)
        val second = first.nextAttempt(); assertTrue(store.replaceIfMatching(first, second))
        assertFalse(store.clearIfMatching(first)); assertFalse(store.replaceIfMatching(first, first.copy(receipt = buildJsonObject {})))
        assertThrows(IllegalArgumentException::class.java) { store.replaceIfMatching(second, first) }
        assertThrows(IllegalArgumentException::class.java) { store.replaceIfMatching(second, second.copy(attemptRevision = 4)) }
        assertEquals(second, store.get(original.kind, WALLET))
    }
    @Test fun `stale positive acknowledgement cannot replace a newer same-key dispatch`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); val entered = CompletableDeferred<Unit>(); val resume = CompletableDeferred<Unit>()
        val spec = object : MoneyOpSpec<JsonObject> {
            override val kind = original.kind
            override fun receiptRequest(intent: PendingIntent): ReceiptRequest? = null
            override fun acknowledge(intent: PendingIntent, response: JsonObject) = response
            override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<JsonObject> = Receipt.Unknown
            override fun restore(intent: PendingIntent, document: JsonObject) = document
        }
        val first = async { runCatching { MoneyOp(spec, store, ScriptedTransport(onPost = { _, _ -> entered.complete(Unit); resume.await(); buildJsonObject { put("accepted", true) } })).submit(original) { fail("Stale proof cannot hydrate") } } }
        entered.await()
        assertThrows(IOException::class.java) { runBlocking { MoneyOp(spec, store, ScriptedTransport(onPost = { _, _ -> throw IOException("Retry response lost") })).retry(WALLET) {} } }
        val newer = store.get(original.kind, WALLET)!!; assertEquals(2L, newer.attemptRevision)
        resume.complete(Unit); assertTrue(first.await().isFailure); assertEquals(newer, store.get(original.kind, WALLET)); assertNull(newer.receipt)
    }
}
