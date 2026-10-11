package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.*
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Receipt decoders are strict: a receipt retires money intent only when every identity, amount and
 * ordering claim matches the saved request. Ported from the pre-shell coordinator tests. */
class TrainingBatchSpecTest {
    private val intent = trainingIntent().copy(attempted = true)
    @Test fun `receipt recovers original purchase after current deed queue and balance changed`() {
        val result = TrainingBatchSpec.decodeReceipt(intent, trainingReceipt()) as Receipt.Accepted
        assertEquals("9007199254740993", result.value.costShards)
        assertEquals(ReceiptDocument.SOURCE_RECEIPT, ReceiptDocument.source(result.document))
        assertEquals(result.value, TrainingBatchSpec.restore(intent, result.document))
    }
    @Test fun `legacy omitted base recovers only an explicit null original base`() {
        val legacy = trainingIntent(trainingBody(baseId = null)).copy(attempted = true)
        val receipt = JsonObject(trainingReceipt(trainingBody(baseId = null)) + ("baseId" to JsonNull))
        assertTrue(TrainingBatchSpec.decodeReceipt(legacy, receipt) is Receipt.Accepted)
        assertThrows(ApiCompatibilityException::class.java) { TrainingBatchSpec.decodeReceipt(legacy, JsonObject(receipt - "baseId")) }
    }
    @Test fun `version two saved consent still recovers the immutable version one receipt`() {
        val consented = trainingIntent(JsonObject(trainingBody() + ("consent" to Json.parseToJsonElement("""{"version":2,"queue":[],"unitDurations":[{"troop":"highlander","durationMs":7500}]}""")))).copy(attempted = true)
        assertTrue(TrainingBatchSpec.decodeReceipt(consented, trainingReceipt()) is Receipt.Accepted)
    }
    @Test fun `Postgres lowercase UUID receipt recovers an uppercase saved base without normalizing the key`() {
        val upper = trainingIntent(JsonObject(trainingBody() + ("baseId" to JsonPrimitive("ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456")))).copy(attempted = true)
        val receipt = JsonObject(trainingReceipt() + ("baseId" to JsonPrimitive("abcdef12-abcd-4abc-8abc-abcdef123456")))
        assertTrue(TrainingBatchSpec.decodeReceipt(upper, receipt) is Receipt.Accepted)
        assertThrows(ApiCompatibilityException::class.java) { TrainingBatchSpec.decodeReceipt(upper, JsonObject(receipt + ("idempotencyKey" to JsonPrimitive("ORIGINAL-RECEIPT")))) }
    }
    @Test fun `mismatched identity amount ordered composition and malformed receipts never clear money intent`() {
        val valid = trainingReceipt(); val request = valid.getValue("request").jsonObject
        val invalid = listOf(
            JsonObject(valid + ("idempotencyKey" to JsonPrimitive("different-receipt"))),
            JsonObject(valid + ("baseId" to JsonNull)), JsonObject(valid - "baseId"),
            JsonObject(valid + ("acceptedAt" to JsonPrimitive("yesterday"))),
            JsonObject(valid + ("request" to JsonObject(request + ("confirmedCostShards" to JsonPrimitive("1"))))),
            JsonObject(valid + ("request" to JsonObject(request + ("composition" to buildJsonArray {})))),
            JsonObject(valid + ("result" to JsonObject(valid.getValue("result").jsonObject + ("queue" to buildJsonArray {})))),
        )
        for (reply in invalid) assertThrows(ApiCompatibilityException::class.java) { TrainingBatchSpec.decodeReceipt(intent, reply) }
        assertEquals(Receipt.Unsupported, TrainingBatchSpec.decodeReceipt(intent, JsonObject(trainingReceipt() + ("version" to JsonPrimitive(2)))))
        assertEquals(Receipt.Unsupported, TrainingBatchSpec.decodeReceipt(intent, JsonObject(trainingReceipt() + ("status" to JsonPrimitive("exotic")))))
    }
    @Test fun `an acknowledgement must repeat the quoted price exactly`() {
        assertEquals("9007199254740993", TrainingBatchSpec.acknowledge(intent, buildJsonObject { put("costShards", "9007199254740993") }).costShards)
        assertThrows(IllegalArgumentException::class.java) { TrainingBatchSpec.acknowledge(intent, buildJsonObject { put("costShards", "9007199254740992") }) }
        assertThrows(Exception::class.java) { TrainingBatchSpec.acknowledge(intent, buildJsonObject {}) }
    }
}

class ConstructionSpecTest {
    @Test fun `signed original placement recovery needs exact persisted supported geometry`() {
        val body = JsonObject(placementBody() + mapOf("tx" to JsonPrimitive(-10), "ty" to JsonPrimitive(39)))
        val old = placementIntent(body)
        assertNull(ConstructionSpec.receiptRequest(old))
        val plot = gg.pixelkingdomwars.nativeclient.model.PlotGeometry.supported(2)
        val saved = old.copy(quote = buildJsonObject { put("plotGeometry", plot.json) })
        assertEquals("-10", ConstructionSpec.receiptRequest(saved)!!.query["tx"])
        assertEquals(old.idempotencyKey, saved.idempotencyKey)
        assertTrue(ConstructionSpec.decodeReceipt(saved, placementAccepted(body)) is Receipt.Accepted)
        val forged = saved.copy(quote = buildJsonObject { put("plotGeometry", JsonObject(plot.json + ("min" to JsonPrimitive(-11)))) })
        assertNull(ConstructionSpec.receiptRequest(forged))
        assertNull(ConstructionSpec.receiptRequest(saved.copy(body=JsonObject(body + ("tx" to JsonPrimitive(40))))))
    }

    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }

    @Test fun `one real HTTPS GET preserves the original query and decodes the acceptance`() = runBlocking {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try {
            val api = GameApi(server.url("/").toString(), SessionCookieJar(server.url("/"), Memory()), "placement-test", transport)
            val store = PendingIntentStore(MemoryStore()); store.create(placementIntent().copy(attempted = true))
            server.enqueue(MockResponse().setBody(placementAccepted().toString()))
            val op = MoneyOp(ConstructionSpec, store, object : OpTransport {
                override suspend fun get(path: String, query: Map<String, String>) = api.get(path, query)
                override suspend fun post(path: String, body: JsonObject) = error("Observation must never POST")
            })
            val result = op.observe(WALLET) {} as Receipt.Accepted
            assertEquals("9007199254740993", result.value.funding!!.amount)
            val request = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("GET", request.method); assertEquals("/api/base/buildings/receipt", request.requestUrl!!.encodedPath)
            placementBody().forEach { (key, value) -> assertEquals(value.jsonPrimitive.content, request.requestUrl!!.queryParameter(key)) }
            assertEquals(1, server.requestCount); assertNull(store.get(IntentKind.CONSTRUCTION, WALLET))
        } finally { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }
    @Test fun `unknown unsupported and old backend preserve the saved purchase`() {
        val intent = placementIntent().copy(attempted = true)
        assertEquals(Receipt.Unknown, ConstructionSpec.decodeReceipt(intent, placementUnknown()))
        assertEquals(Receipt.Unsupported, ConstructionSpec.decodeReceipt(intent, JsonObject(placementAccepted() + ("version" to JsonPrimitive(2)))))
        assertEquals(Receipt.Unsupported, ConstructionSpec.decodeReceipt(intent, buildJsonObject { put("version", 1); put("status", "exotic") }))
    }
    @Test fun `changed request malformed funding and missing historical identity cannot retire intent`() {
        val intent = placementIntent().copy(attempted = true); val reply = placementAccepted(); val body = placementBody()
        val invalid = listOf(
            JsonObject(reply + ("request" to JsonObject(body + ("tx" to JsonPrimitive(12))))),
            JsonObject(reply + ("request" to JsonObject(body + ("idempotencyKey" to JsonPrimitive("different-key"))))),
            JsonObject(reply - "baseId"), JsonObject(reply + ("baseId" to JsonNull)),
            JsonObject(reply + ("receiptId" to JsonPrimitive("not-a-uuid"))),
            JsonObject(reply + ("acceptedAt" to JsonPrimitive("yesterday"))),
            JsonObject(reply + ("funding" to buildJsonObject { put("currency", "SOL"); put("amount", "12") })),
            JsonObject(reply + ("funding" to buildJsonObject { put("currency", "KEEP"); put("amount", "01") })),
            JsonObject(reply + ("funding" to buildJsonObject { put("currency", "SHARDS"); put("amount", 12) })),
            JsonObject(placementUnknown() + ("idempotencyKey" to JsonPrimitive("different-key"))),
        )
        for (value in invalid) assertThrows(ApiCompatibilityException::class.java) { ConstructionSpec.decodeReceipt(intent, value) }
    }
    @Test fun `legacy null and canonical UUID casing keep distinct original request semantics`() {
        val legacy = placementIntent(placementBody(baseId = null)).copy(attempted = true)
        assertTrue(ConstructionSpec.decodeReceipt(legacy, placementAccepted(placementBody(baseId = null))) is Receipt.Accepted)
        val upperBody = JsonObject(placementBody() + ("baseId" to JsonPrimitive("A0000000-0000-4000-8000-000000000001")))
        val upper = placementIntent(upperBody).copy(attempted = true)
        assertTrue(ConstructionSpec.decodeReceipt(upper, JsonObject(placementAccepted(upperBody) + ("baseId" to JsonPrimitive("a0000000-0000-4000-8000-000000000001")))) is Receipt.Accepted)
    }
    @Test fun `upgrade and unsupported saved bodies never become placement queries`() {
        assertNull(ConstructionSpec.receiptRequest(placementIntent(buildJsonObject { put("idempotencyKey", "upgrade-key-1") }, "/base/buildings/00000000-0000-4000-8000-000000000002/upgrade")))
        assertNull(ConstructionSpec.receiptRequest(placementIntent(JsonObject(placementBody() + ("heroContractOnly" to JsonPrimitive(true))))))
        assertNull(ConstructionSpec.receiptRequest(placementIntent(JsonObject(placementBody() + ("baseId" to JsonNull)))))
        assertEquals(mapOf("baseId" to "a0000000-0000-4000-8000-000000000001", "idempotencyKey" to "receipt/key with spaces", "type" to "mine", "tx" to "11", "ty" to "8"),
            ConstructionSpec.receiptRequest(placementIntent())!!.query)
    }
}

class TrainingCancelSpecTest {
    private val intent = cancelIntent()
    @Test fun `a cancellation intent is bound to one exact server row and refund`() {
        assertEquals("/army/train/$QUEUE/cancel", intent.path)
        assertEquals(buildJsonObject { put("idempotencyKey", "cancel-original-key"); put("baseId", CANCEL_BASE) }, intent.body)
        assertEquals("/army/train/$QUEUE/cancel/receipt", TrainingCancelSpec.receiptRequest(intent).path)
        assertEquals(mapOf("idempotencyKey" to "cancel-original-key", "baseId" to CANCEL_BASE), TrainingCancelSpec.receiptRequest(intent).query)
        assertFalse("baseId" in TrainingCancelSpec.receiptRequest(cancelIntent(baseId = null)).query)
        assertThrows(IllegalArgumentException::class.java) { TrainingCancelSpec.intent(WALLET, CANCEL_BASE, QUEUE, "k", "highlander", "12") }
        assertThrows(IllegalArgumentException::class.java) { TrainingCancelSpec.intent(WALLET, CANCEL_BASE, "bad", "cancel-original-key", "highlander", "12") }
        assertThrows(IllegalArgumentException::class.java) { TrainingCancelSpec.intent(WALLET, CANCEL_BASE, QUEUE, "cancel-original-key", "highlander", "1.5") }
    }
    @Test fun `the POST result is bound to the request actually sent and keeps its replayed flag`() {
        val accepted = TrainingCancelSpec.acknowledge(intent, cancelResult(replayed = false))
        assertEquals("90071992547409931234567890123456", accepted.refundShards); assertFalse(accepted.replayed)
        assertEquals(accepted, TrainingCancelSpec.restore(intent, ReceiptDocument.fromPost(cancelResult(replayed = false))))
        assertThrows(Exception::class.java) { TrainingCancelSpec.acknowledge(intent, buildJsonObject {}) }
        assertThrows(Exception::class.java) { TrainingCancelSpec.acknowledge(intent, JsonObject(cancelResult() + ("refundShards" to JsonPrimitive("12")))) }
    }
    @Test fun `a receipt route reply must be a replayed acceptance for this exact row`() {
        val accepted = TrainingCancelSpec.decodeReceipt(intent, cancelReceipt()) as Receipt.Accepted
        assertTrue(accepted.value.replayed)
        assertEquals(Receipt.Unknown, TrainingCancelSpec.decodeReceipt(intent, cancelReceipt(status = "unknown")))
        assertEquals(Receipt.Unsupported, TrainingCancelSpec.decodeReceipt(intent, JsonObject(cancelReceipt() + ("version" to JsonPrimitive(2)))))
        val malformed = listOf(JsonObject(cancelReceipt() - "baseId"), JsonObject(cancelReceipt() + ("queueId" to JsonPrimitive("33333333-3333-4333-8333-333333333333"))),
            JsonObject(cancelReceipt() + ("result" to JsonObject(cancelResult() + ("replayed" to JsonPrimitive(false))))),
            JsonObject(cancelReceipt() + ("result" to JsonObject(cancelResult() + ("refundShards" to JsonPrimitive("12"))))))
        for (reply in malformed) assertThrows(ApiCompatibilityException::class.java) { TrainingCancelSpec.decodeReceipt(intent, reply) }
    }
    @Test fun `compatible additive fields and a legacy null base preserve the exact decimal refund`() {
        val legacy = cancelIntent(baseId = null)
        val response = JsonObject(cancelReceipt(legacy) + ("futureCompatibleField" to buildJsonObject { put("ignored", true) }))
        val observed = TrainingCancelSpec.decodeReceipt(legacy, response) as Receipt.Accepted
        assertEquals("90071992547409931234567890123456", observed.value.refundShards)
        assertEquals(observed.value, TrainingCancelSpec.restore(legacy, observed.document))
    }
}

class ResearchAndFinishSpecTest {
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
    private val idle = json("""{"levels":{"unit":1},"research":[],"features":{"researchConsent":{"version":1}}}""")
    private fun active() = JsonObject(idle + mapOf("research" to Json.parseToJsonElement("""[{"troop":"unit","episodeId":"episode-a","toLevel":2,"finishesAt":"2030-01-01T00:00:20Z"}]""")))
    private val target = json("""{"action":"start","troop":"unit","level":"1","toLevel":2,"price":"91","baseId":"base-a"}""")
    private val research = PendingIntent(IntentKind.RESEARCH, WALLET, "base-a", "fixed-order-key", "/army/research",
        json("""{"baseId":"base-a","troop":"unit","idempotencyKey":"fixed-order-key"}"""), "Research unit", target, attempted = true)

    @Test fun `research recovery observes the Forge state and never repeats the order`() {
        assertEquals(mapOf("baseId" to "base-a"), ResearchSpec.receiptRequest(research).query)
        assertTrue(ResearchSpec.decodeReceipt(research, active()) is Receipt.Accepted)
        assertEquals(Receipt.Unknown, ResearchSpec.decodeReceipt(research, idle))
        assertEquals(Receipt.Unknown, ResearchSpec.decodeReceipt(research, buildJsonObject {}))
        assertEquals(ResearchAcceptance("start", "unit"), ResearchSpec.acknowledge(research, buildJsonObject {}))
    }
    @Test fun `accepted reply loss is resolved by observation through the money op`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); val transport = ScriptedTransport(); val op = MoneyOp(ResearchSpec, store, transport)
        transport.onPost = { _, _ -> throw java.io.IOException("lost reply") }
        assertThrows(java.io.IOException::class.java) { runBlocking { op.submit(research.copy(attempted = false)) {} } }
        transport.onGet = { _, _ -> active() }
        assertTrue(op.observe(WALLET) {} is Receipt.Accepted)
        assertEquals(1, transport.posts.size); assertEquals(1, transport.gets.size); assertNull(store.get(IntentKind.RESEARCH, WALLET))
    }
    @Test fun `finish all recovery treats an emptied consented queue as completion`() {
        val consent = json("""{"version":2,"queue":[{"id":"22222222-2222-4222-8222-222222222222","startedAt":"2030-01-01T00:00:00Z","finishesAt":"2030-01-01T00:00:12Z"}],"maxCostKeep":"0"}""")
        val body = buildJsonObject { put("baseId", BASE); put("idempotencyKey", "finish-all-key"); put("consent", consent); put("freeOffer", "first_troops") }
        val intent = PendingIntent(IntentKind.TRAINING_FINISH, WALLET, BASE, "finish-all-key", TrainingFinishSpec.PATH, body, "Finish all", attempted = true)
        // The acknowledgement is bound to the consent: a free finish costs exactly 0 and completes rows inside the consented queue.
        val accepted = TrainingFinishSpec.acknowledge(intent, json("""{"cost":"0","completed":[{"troop":"highlander","count":1}]}"""))
        assertTrue(accepted.free); assertEquals("0", accepted.costKeep); assertEquals(listOf("highlander" to 1), accepted.completed)
        for (bad in listOf("""{}""", """{"cost":"1","completed":[{"troop":"highlander","count":1}]}""", """{"cost":"0","completed":[]}""",
            """{"cost":"0","completed":[{"troop":"highlander","count":2}]}""", """{"cost":"0","completed":[{"troop":"highlander","count":0}]}""")) {
            assertThrows("Refused: $bad", Exception::class.java) { TrainingFinishSpec.acknowledge(intent, json(bad)) }
        }
        val paid = intent.copy(body = JsonObject(body - "freeOffer" + ("consent" to JsonObject(consent + ("maxCostKeep" to JsonPrimitive("7"))))))
        assertEquals("5", TrainingFinishSpec.acknowledge(paid, json("""{"cost":"5","completed":[{"troop":"highlander","count":1}]}""")).costKeep)
        assertThrows("A charge above the approved ceiling is refused", Exception::class.java) {
            TrainingFinishSpec.acknowledge(paid, json("""{"cost":"8","completed":[{"troop":"highlander","count":1}]}"""))
        }
        assertEquals(Receipt.Unknown, TrainingFinishSpec.decodeReceipt(intent, json("""{"queue":[{"id":"22222222-2222-4222-8222-222222222222"}]}""")))
        val recovered = TrainingFinishSpec.decodeReceipt(intent, json("""{"queue":[]}""")) as Receipt.Accepted
        assertTrue(recovered.value.free); assertTrue(recovered.value.completed.isEmpty())
        assertEquals("The recovered paid acceptance carries only the approved ceiling", "7", (TrainingFinishSpec.decodeReceipt(paid, json("""{"queue":[]}""")) as Receipt.Accepted).value.costKeep)
        assertEquals(recovered.value, TrainingFinishSpec.restore(intent, recovered.document))
        assertEquals(Receipt.Unsupported, TrainingFinishSpec.decodeReceipt(intent.copy(body = JsonObject(body - "consent")), json("""{"queue":[]}""")))
    }
}

class ReceiptObserverTest {
    @Test fun `interrupted intents are published per wallet and a check records its observation`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); val transport = ScriptedTransport(); val observer = ReceiptObserver(store)
        val op = MoneyOp(TrainingBatchSpec, store, transport); observer.register(op) {}
        store.create(trainingIntent().copy(attempted = true)); store.create(trainingIntent().copy(wallet = "other", attempted = true))
        observer.refresh(WALLET)
        assertEquals(listOf(IntentKind.TRAINING_BATCH), observer.interrupted.value.map { it.kind })
        assertTrue(observer.blocks(IntentKind.TRAINING_BATCH)); assertFalse(observer.blocks(IntentKind.CONSTRUCTION))
        transport.onGet = { _, _ -> trainingReceipt(status = "unknown") }
        assertEquals(Receipt.Unknown, observer.check(IntentKind.TRAINING_BATCH, WALLET))
        assertTrue(observer.interrupted.value.single().closable)
        transport.onGet = { _, _ -> trainingReceipt(status = "closed") }
        observer.close(IntentKind.TRAINING_BATCH, WALLET)
        assertTrue(observer.interrupted.value.isEmpty()); assertTrue(transport.posts.isEmpty())
        assertEquals("The other wallet's intent is untouched", 1, store.all("other").size)
    }
    @Test fun `a proven intent is reported as recoverable without a network read`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(store)
        store.create(cancelIntent().copy(attempted = true, receipt = ReceiptDocument.fromReceiptRoute(cancelReceipt())))
        observer.refresh(WALLET)
        val item = observer.interrupted.value.single()
        assertTrue(item.proven); assertFalse(item.retryable); assertFalse(item.closable)
        store.create(placementIntent().copy(attempted = true)); observer.refresh(WALLET)
        assertTrue(observer.interrupted.value.first { it.kind == IntentKind.CONSTRUCTION }.retryable)
    }
}
