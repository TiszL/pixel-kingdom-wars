package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

internal const val TRAINING_WALLET = "11111111111111111111111111111111"
internal fun paidTrainingTerms(currency: GameCurrency = GameCurrency.GEMS) = PaidTrainingFinishIntent(BASE, "training-original-key", currency,
    listOf(QueueConsentRow(QUEUE, "2030-01-01T11:00:00.000Z", "2030-01-01T12:00:00.000Z")), "37")
internal fun paidTrainingProof(terms: PaidTrainingFinishIntent = paidTrainingTerms()) = buildJsonObject {
    put("version", 1); put("status", "accepted"); put("wallet", TRAINING_WALLET); put("request", terms.json)
    put("receiptId", BASE); put("acceptedAt", "2030-01-01T11:30:00.000Z")
    put("funding", buildJsonObject { put("currency", terms.expectedCurrency.name); put("amount", "36") })
    put("result", buildJsonObject {
        put("completedAt", "2030-01-01T11:30:00.000Z")
        put("paidRows", JsonArray(terms.queue.filter { it.finishesAt > "2030-01-01T11:30:00.000Z" }.map { JsonObject(TrainingFinish.rowJson(it) + ("troop" to JsonPrimitive("highlander"))) }))
        put("completed", buildJsonArray { add(buildJsonObject { put("troop", "highlander"); put("count", 1) }) })
    })
}

class PaidTrainingFinishTest {
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
    private val terms = paidTrainingTerms()
    private val catalogue = json("""{"constants":{"TROOPS":{"highlander":{}},"TRAINING_SCHEDULE":{"version":2,"lanesPerBase":1,"maxConsentQueueRows":2}}}""")
    private val balances = json("""{"keep":"37","gems":"37","features":{"gameCurrency":{"version":1,"exactSpendCurrency":1},"gems":{"version":1,"receipts":1}}}""")
    private val caps = json("""{"economy":{"gameCurrency":{"version":1,"exactSpendCurrency":1}}}""")
    private val army = buildJsonObject {
        put("features", json("""{"trainingFinishReceipts":{"version":1},"trainingScheduling":{"version":2,"mode":"sequential","lanes":1,"consentRequired":true}}"""))
        put("queue", buildJsonArray { add(JsonObject(TrainingFinish.rowJson(terms.queue.single()) + ("troop" to JsonPrimitive("highlander")))) })
        put("finishAllQuote", terms.consent); put("freeFinishAllOffer", JsonNull); put("freeFinishAllReviewRequired", false)
    }
    private fun prepare(a: JsonObject = army, b: JsonObject = balances, c: JsonObject = catalogue) = TrainingFinish.prepare(terms.baseId, terms.idempotencyKey, a, b, caps, c)
    @Test fun `new admission requires whole funds complete server quote catalogue and explicit free eligibility`() {
        assertEquals(terms, prepare()); assertEquals(GameCurrency.KEEP, prepare(b = JsonObject(balances + ("gems" to JsonPrimitive("36")))).expectedCurrency)
        assertThrows(Exception::class.java) { prepare(b = JsonObject(balances + mapOf("gems" to JsonPrimitive("20"), "keep" to JsonPrimitive("20")))) }
        for (bad in listOf(JsonObject(army - "freeFinishAllOffer"), JsonObject(army + ("freeFinishAllReviewRequired" to JsonPrimitive(true))),
            JsonObject(army + ("freeFinishAllOffer" to json("""{"offer":"first_troops"}"""))), JsonObject(army + ("freeFinishAllOffer" to JsonPrimitive(false))),
            JsonObject(army + ("queue" to JsonArray(emptyList()))), JsonObject(army - "features"))) assertThrows(Exception::class.java) { prepare(bad) }
        assertThrows(Exception::class.java) { prepare(c = buildJsonObject {}) }
        for (constants in listOf("""{"TROOPS":{},"TRAINING_SCHEDULE":{"version":2,"lanesPerBase":1,"maxConsentQueueRows":2}}""",
            """{"TROOPS":{"highlander":{}},"TRAINING_SCHEDULE":{"version":2,"lanesPerBase":1,"maxConsentQueueRows":0}}"""))
            assertThrows(Exception::class.java) { prepare(c = buildJsonObject { put("constants", json(constants)) }) }
    }
    @Test fun `strict terms reject queue mutation coercion bad time duplicate ids and overflow`() {
        for ((k, v) in listOf("maxCostKeep" to JsonPrimitive("0"), "maxCostKeep" to JsonPrimitive("9223372036854775808"), "maxCostKeep" to JsonPrimitive(37),
            "version" to JsonPrimitive("2"), "queue" to JsonArray(emptyList()), "queue" to JsonArray(terms.consent.getValue("queue").jsonArray + terms.consent.getValue("queue").jsonArray)))
            assertThrows(Exception::class.java) { TrainingFinish.parse(JsonObject(terms.json + ("consent" to JsonObject(terms.consent + (k to v))))) }
        for (finish in listOf("2030-01-01T12:00:00Z", "2030-01-01T11:00:00.000Z", "2030-02-30T12:00:00.000Z"))
            assertThrows(Exception::class.java) { terms.copy(queue = listOf(terms.queue.single().copy(finishesAt = finish))) }
        assertThrows(Exception::class.java) { TrainingFinish.parse(JsonObject(terms.json - "baseId")) }
        assertThrows(Exception::class.java) { TrainingFinish.parse(JsonObject(terms.json + ("freeOffer" to JsonPrimitive("first_troops")))) }
        assertFalse(terms.body.containsKey("expectedCurrency")); assertEquals(mapOf("idempotencyKey" to terms.idempotencyKey), terms.copy(baseId = null).query)
    }
    @Test fun `proof binds original terms currency wallet and every still running row with exact counts`() {
        for (currency in GameCurrency.entries) assertEquals(currency, TrainingFinish.proof(paidTrainingProof(paidTrainingTerms(currency)), TRAINING_WALLET, paidTrainingTerms(currency))?.intent?.expectedCurrency)
        val changes = listOf(terms.copy(baseId = null), terms.copy(idempotencyKey = "another-key"), terms.copy(expectedCurrency = GameCurrency.KEEP), terms.copy(maxCostKeep = "38"),
            terms.copy(queue = listOf(terms.queue.single().copy(startedAt = "2030-01-01T10:00:00.000Z"))))
        changes.forEach { assertThrows(Exception::class.java) { TrainingFinish.proof(paidTrainingProof(it), TRAINING_WALLET, terms) } }
        assertThrows(Exception::class.java) { TrainingFinish.proof(paidTrainingProof(), "22222222222222222222222222222222", terms) }
        val proof = paidTrainingProof(); val result = proof.getValue("result").jsonObject
        for ((key, value) in listOf("paidRows" to JsonArray(emptyList()), "paidRows" to JsonArray(result.getValue("paidRows").jsonArray + result.getValue("paidRows").jsonArray),
            "completed" to Json.parseToJsonElement("""[{"troop":"highlander","count":2}]"""), "completedAt" to JsonPrimitive("2030-01-01T12:00:00.000Z")))
            assertThrows(Exception::class.java) { TrainingFinish.proof(JsonObject(proof + ("result" to JsonObject(result + (key to value)))), TRAINING_WALLET, terms) }
        for (funding in listOf("""{"currency":"KEEP","amount":"36"}""", """{"currency":"GEMS","amount":"38"}""", """{"currency":"GEMS","amount":"0"}"""))
            assertThrows(Exception::class.java) { TrainingFinish.proof(JsonObject(proof + ("funding" to json(funding))), TRAINING_WALLET, terms) }
        val expired = QueueConsentRow("33333333-3333-4333-8333-333333333333", "2030-01-01T10:00:00.000Z", "2030-01-01T11:00:00.000Z")
        val original = terms.copy(queue = listOf(expired) + terms.queue)
        assertEquals(1, TrainingFinish.proof(paidTrainingProof(original), TRAINING_WALLET, original)?.completed?.single()?.second)
    }
    @Test fun `modern proof never uses current queue or legacy POST and cannot downgrade into free`() {
        val intent = TrainingFinishSpec.intent(TRAINING_WALLET, terms)
        assertThrows(ApiCompatibilityException::class.java) { TrainingFinishSpec.decodeReceipt(intent, json("""{"queue":[]}""")) }
        assertThrows(ApiCompatibilityException::class.java) { TrainingFinishSpec.acknowledge(intent, json("""{"cost":"37","completed":[{"troop":"highlander","count":1}]}""")) }
        assertThrows(Exception::class.java) { TrainingFinishSpec.restore(intent, ReceiptDocument.fromPost(paidTrainingProof())) }
        assertThrows(Exception::class.java) { TrainingFinishSpec.validateSend(intent.copy(expectedCurrency = null)) }
        assertThrows(Exception::class.java) { TrainingFinishSpec.validateSend(intent.copy(body = JsonObject(intent.body + ("freeOffer" to JsonPrimitive("first_troops"))))) }
        assertNull(ArmyState.from(json("""{"queue":[]}""")).features)
    }
    @Test fun `lost POST recovers only original receipt after reopen without live catalogue or current base`() = runBlocking {
        val disk = MemoryStore(); val original = TrainingFinishSpec.intent(TRAINING_WALLET, terms); var sends = 0
        val wire = ScriptedTransport(onGet = { path, query -> assertEquals(TrainingFinish.RECEIPT, path); assertEquals(terms.query, query); paidTrainingProof() })
        val transport = TrainingFinishCurrencyTransport(wire) { sent, _ -> assertEquals(original.nextAttempt(), sent); sends++; throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { MoneyOp(TrainingFinishSpec, PendingIntentStore(disk), transport).submit(original) {} } }
        MoneyOp(TrainingFinishSpec, PendingIntentStore(disk), transport).observe(TRAINING_WALLET) { assertEquals(terms, it.value.paid?.intent) }
        assertNull(PendingIntentStore(disk).get(IntentKind.TRAINING_FINISH, TRAINING_WALLET)); assertEquals(1, sends); assertEquals(1, wire.gets.size)
    }
    @Test fun `accepted historical proof survives failed hydration and never patches current counts or resends`() = runBlocking {
        val disk = MemoryStore(); val original = TrainingFinishSpec.intent(TRAINING_WALLET, terms); var sends = 0
        val wire = ScriptedTransport(onGet = { _, _ -> paidTrainingProof() })
        val transport = TrainingFinishCurrencyTransport(wire) { _, _ -> sends++ }
        assertThrows(IOException::class.java) { runBlocking { MoneyOp(TrainingFinishSpec, PendingIntentStore(disk), transport).submit(original) { throw IOException("current army unavailable") } } }
        val saved = requireNotNull(PendingIntentStore(disk).get(IntentKind.TRAINING_FINISH, TRAINING_WALLET))
        assertEquals(1L, saved.attemptRevision); assertEquals(ReceiptDocument.SOURCE_RECEIPT, ReceiptDocument.source(requireNotNull(saved.receipt)))
        MoneyOp(TrainingFinishSpec, PendingIntentStore(disk), transport).observe(TRAINING_WALLET) { assertEquals(terms, it.value.paid?.intent) }
        assertEquals(1, sends); assertEquals(1, wire.gets.size)
    }
}
