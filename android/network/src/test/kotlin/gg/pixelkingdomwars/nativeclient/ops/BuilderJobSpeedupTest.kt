package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

internal const val BUILDER_WALLET = "11111111111111111111111111111111"
internal const val BUILDER_BASE = "11111111-1111-4111-8111-111111111111"
internal const val BUILDER_JOB = "22222222-2222-4222-8222-222222222222"
internal fun builderTerms() = BuilderJobSpeedupIntent(BUILDER_JOB, BUILDER_BASE, "builder-original-key", GameCurrency.GEMS,
    BuilderJobSpeedupConsent("upgrade", BUILDER_BASE, null, "2030-01-01T11:00:00.000Z", "2030-01-01T12:00:00.000Z", "37"))
internal fun builderProof(t: BuilderJobSpeedupIntent = builderTerms()) = buildJsonObject {
    put("version", 1); put("status", "accepted"); put("wallet", BUILDER_WALLET); put("request", t.json)
    put("receiptId", BUILDER_BASE); put("acceptedAt", "2030-01-01T11:30:00.000Z")
    put("funding", buildJsonObject { put("currency", t.expectedCurrency.name); put("amount", "36") })
    put("result", buildJsonObject { put("jobId", t.jobId); put("kind", t.consent.kind)
        put("buildingId", t.consent.buildingId?.let(::JsonPrimitive) ?: JsonNull); put("obstacleId", t.consent.obstacleId?.let(::JsonPrimitive) ?: JsonNull)
        put("completedAt", "2030-01-01T11:30:00.000Z") })
}

class BuilderJobSpeedupTest {
    private fun json(s: String) = Json.parseToJsonElement(s).jsonObject
    private val terms = builderTerms()
    private val intent = ConstructionSpec.builderIntent(BUILDER_WALLET, terms)
    private val balances = json("""{"gems":"37","keep":"37","features":{"gameCurrency":{"version":1,"exactSpendCurrency":1},"gems":{"version":1,"receipts":1}}}""")
    private val caps = json("""{"economy":{"gameCurrency":{"version":1,"exactSpendCurrency":1}}}""")
    private fun base(t: BuilderJobSpeedupIntent = terms) = buildJsonObject {
        put("baseId", BUILDER_BASE); put("features", json("""{"builderJobSpeedup":{"version":1,"receipts":1}}"""))
        put("jobs", buildJsonArray { add(JsonObject(t.consent.json.filterKeys { it !in setOf("version", "maxCostKeep") } + mapOf(
            "id" to JsonPrimitive(t.jobId), "finishCostKeep" to JsonPrimitive(t.consent.maxCostKeep), "paidFinishQuote" to t.consent.json))) })
    }
    private fun prepare(b: JsonObject = base(), funds: JsonObject = balances, capabilities: JsonObject = caps) =
        BuilderJobSpeedup.prepare(BUILDER_JOB, BUILDER_BASE, terms.idempotencyKey, b, funds, capabilities)
    @Test fun `server quote binds the complete paid episode and one whole currency`() {
        assertEquals(terms, prepare())
        assertEquals(GameCurrency.KEEP, prepare(funds = JsonObject(balances + ("gems" to JsonPrimitive("36")))).expectedCurrency)
        assertThrows(Exception::class.java) { prepare(funds = JsonObject(balances + mapOf("gems" to JsonPrimitive("20"), "keep" to JsonPrimitive("20")))) }
        assertThrows(Exception::class.java) { prepare(capabilities = json("{}")) }
        for (bad in listOf(JsonObject(base() - "features"), JsonObject(base() + ("baseId" to JsonPrimitive(BUILDER_JOB))),
            JsonObject(base() + ("jobs" to JsonArray(emptyList()))))) assertThrows(Exception::class.java) { prepare(bad) }
        val job = base().getValue("jobs").jsonArray.single().jsonObject
        for (bad in listOf(JsonObject(job + ("startedAt" to JsonPrimitive("2030-01-01T10:00:00.000Z"))), JsonObject(job - "obstacleId"),
            JsonObject(job + ("finishCostKeep" to JsonPrimitive("36"))), JsonObject(job + ("paidFinishQuote" to JsonNull)))) {
            assertThrows(Exception::class.java) { prepare(JsonObject(base() + ("jobs" to JsonArray(listOf(bad))))) }
        }
    }
    @Test fun `free build zero cost noncanonical timestamps and ambiguous targets cannot become paid consent`() {
        for (bad in listOf(JsonObject(terms.consent.json + ("kind" to JsonPrimitive("build"))), JsonObject(terms.consent.json + ("maxCostKeep" to JsonPrimitive("0"))),
            JsonObject(terms.consent.json + ("maxCostKeep" to JsonPrimitive("9223372036854775808"))), JsonObject(terms.consent.json + ("obstacleId" to JsonPrimitive(BUILDER_JOB))),
            JsonObject(terms.consent.json + ("startedAt" to JsonPrimitive("2030-01-01T11:00:00Z"))), JsonObject(terms.consent.json + ("extra" to JsonNull)))) {
            assertThrows(Exception::class.java) { BuilderJobSpeedup.consent(bad) }
        }
        for (kind in listOf("repair", "clear_obstacle")) {
            val c = if (kind == "repair") terms.consent.copy(kind = kind) else terms.consent.copy(kind = kind, buildingId = null, obstacleId = BUILDER_JOB)
            assertEquals(c, BuilderJobSpeedup.parse(terms.copy(consent = c).json).consent)
        }
    }
    @Test fun `historical proof binds wallet original terms debit and completion without current state`() {
        for (baseId in listOf(BUILDER_BASE, null)) {
            val t = terms.copy(baseId = baseId)
            assertEquals("36", BuilderJobSpeedup.proof(builderProof(t), BUILDER_WALLET, t)!!.amount)
        }
        val proof = builderProof()
        val mutations = listOf(JsonObject(proof + ("wallet" to JsonPrimitive("22222222222222222222222222222222"))),
            JsonObject(proof + ("request" to terms.copy(expectedCurrency = GameCurrency.KEEP).json)),
            JsonObject(proof + ("request" to terms.copy(consent = terms.consent.copy(finishesAt = "2030-01-01T12:01:00.000Z")).json)),
            JsonObject(proof + ("result" to JsonObject(proof.getValue("result").jsonObject + ("jobId" to JsonPrimitive(BUILDER_BASE))))),
            JsonObject(proof + ("result" to JsonObject(proof.getValue("result").jsonObject + ("buildingId" to JsonPrimitive(BUILDER_JOB))))),
            JsonObject(proof + ("funding" to json("""{"currency":"GEMS","amount":"38"}"""))),
            JsonObject(proof + ("funding" to json("""{"currency":"KEEP","amount":"36"}"""))), JsonObject(proof + ("extra" to JsonNull))) +
            listOf("2030-01-01T10:59:59.999Z", terms.consent.finishesAt).map { at ->
                JsonObject(proof + ("result" to JsonObject(proof.getValue("result").jsonObject + ("completedAt" to JsonPrimitive(at))))) }
        mutations.forEach { assertThrows(Exception::class.java) { BuilderJobSpeedup.proof(it, BUILDER_WALLET, terms) } }
        assertNull(BuilderJobSpeedup.proof(json("""{"version":1,"status":"unknown","idempotencyKey":"${terms.idempotencyKey}"}"""), BUILDER_WALLET, terms))
        assertThrows(Exception::class.java) { BuilderJobSpeedup.proof(json("""{"version":1,"status":"unknown","idempotencyKey":"other-key"}"""), BUILDER_WALLET, terms) }
    }
    @Test fun `damaged modern records never downgrade and only original receipt provenance restores`() {
        for (bad in listOf(intent.copy(expectedCurrency = null), intent.copy(quote = null), intent.copy(path = "/base/jobs/$BUILDER_JOB/cancel"),
            intent.copy(body = JsonObject(intent.body - "consent")), intent.copy(baseId = null))) {
            assertThrows(Exception::class.java) { ConstructionSpec.validateSend(bad) }
            assertThrows(Exception::class.java) { ConstructionSpec.receiptRequest(bad) }
        }
        val receipt = ConstructionSpec.decodeReceipt(intent, builderProof()) as Receipt.Accepted
        assertEquals("GEMS", receipt.value.funding!!.currency)
        assertEquals(receipt.value, ConstructionSpec.restore(intent, receipt.document))
        assertThrows(Exception::class.java) { ConstructionSpec.restore(intent, ReceiptDocument.fromPost(builderProof())) }
        val legacy = intent.copy(quote = null, expectedCurrency = null, body = JsonObject(intent.body - "consent"))
        ConstructionSpec.validateSend(legacy); assertNull(ConstructionSpec.receiptRequest(legacy))
        assertNull(ConstructionSpec.acknowledge(legacy, json("""{"cost":"0"}""")).builderFinish)
    }
    @Test fun `receipt failures after successful POST preserve attempted original and block generic retry`() = runBlocking {
        val disk = object : SecretStore { var raw: String? = null; override fun read() = raw; override fun write(value: String) { raw = value }; override fun clear() { raw = null } }
        val store = PendingIntentStore(disk); var posts = 0; var reviewed = true
        val reads = object : OpTransport {
            override suspend fun get(path: String, query: Map<String, String>): JsonObject { assertEquals(BuilderJobSpeedup.RECEIPT, path); assertEquals(terms.query, query); throw ApiException(401, null, "lost receipt") }
            override suspend fun post(path: String, body: JsonObject): JsonObject = error("No ordinary fallback")
        }
        val op = MoneyOp(ConstructionSpec, store, BuilderSpeedupCurrencyTransport(reads) { sent, _ -> check(reviewed); assertEquals(intent.nextAttempt(), sent); posts++ })
        assertThrows(IOException::class.java) { runBlocking { op.submit(intent) {} } }
        assertEquals(intent.nextAttempt(), store.get(IntentKind.CONSTRUCTION, BUILDER_WALLET)); reviewed = false
        assertThrows(Exception::class.java) { runBlocking { op.retry(BUILDER_WALLET) {} } }; assertEquals(1, posts)
        assertEquals(intent.nextAttempt().nextAttempt(), store.get(IntentKind.CONSTRUCTION, BUILDER_WALLET))
    }
}
