package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class GemsSpecsTest {
    private val base = "8d04db9d-1949-405a-8279-a4f9a8ca75f5"
    private val specs = listOf(GemsFromKeepSpec, GemsToShardsSpec, GemsTaskClaimSpec)
    private fun intent(spec: GemsSpec) = when (spec) {
        GemsFromKeepSpec -> GemsFromKeepSpec.intent("wallet", "gems-key-1", "10")
        GemsToShardsSpec -> GemsToShardsSpec.intent("wallet", base, "gems-key-1", "10")
        GemsTaskClaimSpec -> GemsTaskClaimSpec.intent("wallet", "one-time-task", "gems-key-1")
    }
    private fun proof(spec: GemsSpec, intent: PendingIntent) = buildJsonObject {
        put("version", 1); put("status", "accepted"); put("wallet", intent.wallet)
        put("receiptId", "2f79773d-dfbf-4c5e-84fc-28d29076eaed"); put("acceptedAt", "2026-09-21T00:00:00Z")
        put("request", if (spec == GemsTaskClaimSpec) JsonObject(intent.body + ("taskId" to JsonPrimitive("one-time-task"))) else intent.body)
        if (spec == GemsTaskClaimSpec) put("taskId", "one-time-task")
        else put("funding", buildJsonObject { put("currency", if (spec == GemsFromKeepSpec) "KEEP" else "GEMS"); put("amount", "10") })
        if (spec == GemsToShardsSpec) put("baseId", intent.baseId?.let(::JsonPrimitive) ?: JsonNull)
        put("result", buildJsonObject { put(if (spec == GemsToShardsSpec) "shards" else "gems", "20"); if (spec != GemsTaskClaimSpec) put("rate", 2) })
    }
    private fun envelope(spec: GemsSpec, intent: PendingIntent, proof: JsonObject) = if (spec == GemsToShardsSpec) proof else buildJsonObject {
        put("wallet", intent.wallet); put("idempotencyKey", intent.idempotencyKey); put("status", "accepted")
        put("serverNow", "2026-09-21T01:00:00Z"); put("receipt", proof)
    }
    private fun receipt(spec: GemsSpec, intent: PendingIntent) = envelope(spec, intent, proof(spec, intent))
    private fun unknown(spec: GemsSpec, intent: PendingIntent) = if (spec == GemsToShardsSpec) buildJsonObject {
        put("version", 1); put("status", "unknown"); put("idempotencyKey", intent.idempotencyKey)
    } else buildJsonObject {
        put("wallet", intent.wallet); put("idempotencyKey", intent.idempotencyKey); put("status", "unknown")
        put("receipt", JsonNull); put("serverNow", "2026-09-21T01:00:00Z")
    }
    @Test fun `three exact historical receipts bind identity and restore without present balance or task catalogue`() {
        specs.forEach { spec ->
            val intent = intent(spec); val raw = receipt(spec, intent)
            val accepted = spec.decodeReceipt(intent, raw) as Receipt.Accepted
            assertEquals("20", accepted.value.amount)
            assertEquals(accepted.value, spec.restore(intent, accepted.document))
            assertEquals(Receipt.Unknown, spec.decodeReceipt(intent, unknown(spec, intent)))
            val original = proof(spec, intent)
            val changes = listOf("wallet" to JsonPrimitive("different"), "request" to JsonObject(intent.body + ("idempotencyKey" to JsonPrimitive("other-key"))),
                "receiptId" to JsonPrimitive("bad-uuid"), "acceptedAt" to JsonPrimitive("not-time"))
            changes.forEach { changed -> assertThrows(ApiCompatibilityException::class.java) {
                spec.decodeReceipt(intent, envelope(spec, intent, JsonObject(original + changed)))
            } }
            assertFalse(InterruptedIntent(intent.copy(attempted = true), Receipt.Unknown).closable)
            assertFalse(InterruptedIntent(intent.copy(attempted = true), Receipt.Unknown).retryable)
        }
    }
    @Test fun `wrong currency base rate and credited quantity cannot prove conversion`() {
        listOf(GemsFromKeepSpec, GemsToShardsSpec).forEach { spec ->
            val intent = intent(spec); val original = proof(spec, intent)
            listOf(
                "funding" to buildJsonObject { put("currency", "SOL"); put("amount", "10") },
                "funding" to buildJsonObject { put("currency", if (spec == GemsFromKeepSpec) "KEEP" else "GEMS"); put("amount", "11") },
                "result" to buildJsonObject { put(if (spec == GemsToShardsSpec) "shards" else "gems", "19"); put("rate", 2) },
                "result" to buildJsonObject { put(if (spec == GemsToShardsSpec) "shards" else "gems", "20"); put("rate", "2") }
            ).forEach { changed -> assertThrows(ApiCompatibilityException::class.java) {
                spec.decodeReceipt(intent, envelope(spec, intent, JsonObject(original + changed)))
            } }
        }
        val intent = intent(GemsToShardsSpec)
        assertThrows(ApiCompatibilityException::class.java) { GemsToShardsSpec.decodeReceipt(intent, JsonObject(proof(GemsToShardsSpec, intent) + ("baseId" to JsonNull))) }
    }
    @Test fun `task and outer by-key envelopes cannot substitute another saved request`() {
        val spec = GemsTaskClaimSpec; val intent = intent(spec)
        listOf("taskId" to JsonPrimitive("different-task"), "request" to buildJsonObject { put("taskId", "different-task"); put("idempotencyKey", intent.idempotencyKey) }).forEach { changed ->
            assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(intent, envelope(spec, intent, JsonObject(proof(spec, intent) + changed))) }
        }
        listOf(GemsFromKeepSpec, GemsTaskClaimSpec).forEach { current ->
            val saved = intent(current)
            listOf("wallet" to JsonPrimitive("other"), "idempotencyKey" to JsonPrimitive("other-key"), "receipt" to proof(current, saved)).forEach { changed ->
                assertThrows(ApiCompatibilityException::class.java) { current.decodeReceipt(saved, JsonObject(unknown(current, saved) + changed)) }
            }
        }
    }
    @Test fun `requests normalize base scope and preserve legacy journals`() {
        assertEquals(base, GemsToShardsSpec.intent("wallet", base.uppercase(), "gems-key-1", "10").baseId)
        val legacy = KeepConversionSpec.intent("wallet", null, "legacy-key", "10")
        val memory = Memory(); val store = PendingIntentStore(memory)
        store.create(legacy); specs.forEach { store.create(intent(it)) }
        assertEquals(4, PendingIntentStore(memory).all("wallet").size)
        assertEquals(legacy, PendingIntentStore(memory).get(IntentKind.KEEP_CONVERSION, "wallet"))
        for (amount in listOf("0", "-1", "01", "1.1", "1e2", "9".repeat(33))) assertThrows(IllegalArgumentException::class.java) { GemsFromKeepSpec.intent("wallet", "gems-key-1", amount) }
        assertThrows(IllegalArgumentException::class.java) { GemsTaskClaimSpec.intent("wallet", "../tasks", "gems-key-1") }
    }
    @Test fun `guarded requests prove exact reviewed terms without constraining historical receipt lookup`() {
        specs.forEach { spec ->
            val old = intent(spec)
            val expected = buildJsonObject { put("rate", if (spec == GemsTaskClaimSpec) JsonNull else JsonPrimitive(2)); put("output", "20") }
            val saved = old.copy(body = JsonObject(old.body + ("expected" to expected)))
            spec.validateSend(saved)
            assertEquals(spec.receiptRequest(old), spec.receiptRequest(saved))
            assertEquals("20", (spec.decodeReceipt(saved, receipt(spec, saved)) as Receipt.Accepted).value.amount)
            val changed = buildJsonObject { put(if (spec == GemsToShardsSpec) "shards" else "gems", "30"); if (spec != GemsTaskClaimSpec) put("rate", 3) }
            assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(saved, envelope(spec, saved, JsonObject(proof(spec, saved) + ("result" to changed)))) }
            assertThrows(ApiCompatibilityException::class.java) { spec.decodeReceipt(saved, receipt(spec, old)) }
            for (invalid in listOf(JsonNull, JsonObject(expected + ("extra" to JsonPrimitive(true))),
                JsonObject(expected + ("output" to JsonPrimitive("020"))),
                JsonObject(expected + ("rate" to if (spec == GemsTaskClaimSpec) JsonPrimitive(2) else JsonNull)))) {
                assertThrows(IllegalArgumentException::class.java) { spec.validateSend(saved.copy(body = JsonObject(old.body + ("expected" to invalid)))) }
            }
        }
    }
    @Test fun `money key is durable before POST and failed hydration restores GET proof without another mutation`() = runBlocking {
        specs.forEach { spec ->
            val memory = Memory(); val store = PendingIntentStore(memory); val saved = intent(spec); var posts = 0; var reads = 0
            val transport = object : OpTransport {
                override suspend fun post(path: String, body: JsonObject): JsonObject {
                    posts++; assertEquals(saved.nextAttempt(), PendingIntentStore(memory).get(spec.kind, saved.wallet))
                    return buildJsonObject { put("gems", "20") }
                }
                override suspend fun get(path: String, query: Map<String, String>): JsonObject { reads++; assertEquals(spec.receiptRequest(saved), ReceiptRequest(path, query)); return receipt(spec, saved) }
            }
            val op = MoneyOp(spec, store, spec.verifiedTransport(transport))
            try { op.submit(saved) { throw IOException("snapshot unavailable") }; fail() } catch (_: IOException) {}
            assertNotNull(PendingIntentStore(memory).get(spec.kind, saved.wallet)?.receipt)
            val restored = MoneyOp(spec, PendingIntentStore(memory), spec.verifiedTransport(transport))
            assertTrue(restored.observe(saved.wallet) {} is Receipt.Accepted)
            assertNull(restored.pending(saved.wallet)); assertEquals(1, posts); assertEquals(1, reads)
        }
    }
    @Test fun `receipt failure after committed POST and unknown after restart stay pending without replay`() = runBlocking {
        specs.forEach { spec ->
            val memory = Memory(); val saved = intent(spec); var posts = 0; var receiptFailure = true
            val transport = object : OpTransport {
                override suspend fun post(path: String, body: JsonObject): JsonObject { posts++; return buildJsonObject {} }
                override suspend fun get(path: String, query: Map<String, String>): JsonObject {
                    if (receiptFailure) throw ApiException(401, null, "session expired")
                    return unknown(spec, saved)
                }
            }
            val op = MoneyOp(spec, PendingIntentStore(memory), spec.verifiedTransport(transport))
            try { op.submit(saved) { fail() }; fail() } catch (_: IOException) {}
            assertTrue(requireNotNull(op.pending(saved.wallet)).attempted)
            receiptFailure = false
            val restored = MoneyOp(spec, PendingIntentStore(memory), spec.verifiedTransport(transport))
            assertEquals(Receipt.Unknown, restored.observe(saved.wallet) { fail() })
            assertNotNull(restored.pending(saved.wallet)); assertEquals(1, posts)
        }
    }
    private class Memory : SecretStore {
        var text: String? = null
        override fun read() = text
        override fun write(value: String) { text = value }
        override fun clear() { text = null }
    }
}
