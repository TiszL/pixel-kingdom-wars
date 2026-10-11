package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

internal const val RESEARCH_WALLET = "11111111111111111111111111111111"
internal fun researchTerms(currency: GameCurrency = GameCurrency.GEMS, base: String? = BASE, episode: String? = QUEUE) =
    ResearchSpeedupIntent("highlander", base, "research-original-key", currency, 1, 2, "2030-01-01T12:00:00.000Z", episode, "37")
internal fun researchProof(terms: ResearchSpeedupIntent = researchTerms()) = buildJsonObject {
    put("version", 1); put("status", "accepted"); put("wallet", RESEARCH_WALLET); put("request", terms.json)
    put("receiptId", QUEUE); put("acceptedAt", "2030-01-01T11:59:59Z")
    put("funding", buildJsonObject { put("currency", terms.expectedCurrency.name); put("amount", "36") })
    put("result", buildJsonObject { put("troop", terms.troop); put("fromLevel", terms.currentLevel); put("toLevel", terms.toLevel) })
}

class ResearchSpeedupTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private val terms = researchTerms()
    private val catalogue = json("""{"constants":{"TROOPS":{"highlander":{}},"TROOP_LEVELING":{"maxLevel":3}}}""")
    private val balances = json("""{"gems":"37","keep":"37","features":{"gameCurrency":{"version":1,"exactSpendCurrency":1},"gems":{"version":1,"receipts":1}}}""")
    private val capabilities = json("""{"economy":{"gameCurrency":{"version":1,"exactSpendCurrency":1}}}""")
    private val army = buildJsonObject {
        put("levels", buildJsonObject { put(terms.troop, 1) })
        put("features", json("""{"researchConsent":{"version":1},"researchSpeedupReceipts":{"version":1}}"""))
        put("research", buildJsonArray { add(buildJsonObject {
            put("troop", terms.troop); put("toLevel", terms.toLevel); put("finishesAt", terms.finishesAt); put("episodeId", terms.episodeId)
            put("finishQuote", JsonObject(terms.json.filterKeys { it in setOf("currentLevel", "toLevel", "finishesAt", "episodeId", "maxCostKeep") }))
        }) })
    }
    private fun prepare(a: JsonObject = army, b: JsonObject = balances, c: JsonObject = catalogue, cap: JsonObject = capabilities) =
        ResearchSpeedup.prepare(terms.troop, terms.baseId, terms.idempotencyKey, a, b, cap, c)
    private fun row(field: String, value: JsonElement) = JsonObject(army + ("research" to buildJsonArray {
        add(JsonObject(army.getValue("research").jsonArray.single().jsonObject + (field to value)))
    }))
    @Test fun `only a versioned matching server quote and verified catalogue admit whole currency`() {
        assertEquals(terms, prepare())
        assertEquals(GameCurrency.KEEP, prepare(b = JsonObject(balances + ("gems" to JsonPrimitive("36")))).expectedCurrency)
        assertThrows(IllegalStateException::class.java) { prepare(b = JsonObject(balances + mapOf("gems" to JsonPrimitive("20"), "keep" to JsonPrimitive("20")))) }
        for (bad in listOf(buildJsonObject {}, json("""{"constants":{"TROOPS":{},"TROOP_LEVELING":{"maxLevel":3}}}"""),
            json("""{"constants":{"TROOPS":{"highlander":{}},"TROOP_LEVELING":{"maxLevel":1}}}"""))) {
            assertThrows(Exception::class.java) { prepare(c = bad) }
        }
        assertThrows(Exception::class.java) { prepare(cap = buildJsonObject {}) }
        assertThrows(Exception::class.java) { prepare(a = JsonObject(army + ("features" to json("""{"researchConsent":{"version":1},"researchSpeedupReceipts":{"version":"1"}}""")))) }
        for ((key, value) in listOf("finishQuote" to JsonNull, "episodeId" to JsonNull, "toLevel" to JsonPrimitive(3), "finishesAt" to JsonPrimitive("2031-01-01T12:00:00Z")))
            assertThrows(Exception::class.java) { prepare(a = row(key, value)) }
        assertThrows(Exception::class.java) { prepare(a = JsonObject(army + ("levels" to json("""{"highlander":2}""")))) }
    }
    @Test fun `strict original terms reject coercion overflow missing null and nonadjacent levels`() {
        val malformed = listOf("currentLevel" to JsonPrimitive("1"), "currentLevel" to JsonPrimitive(0), "currentLevel" to JsonPrimitive(Int.MAX_VALUE),
            "toLevel" to JsonPrimitive(3), "maxCostKeep" to JsonPrimitive("9223372036854775808"), "maxCostKeep" to JsonPrimitive("01"),
            "maxCostKeep" to JsonPrimitive(37), "episodeId" to JsonPrimitive(""), "baseId" to JsonPrimitive("BASE"),
            "troop" to JsonPrimitive("Bad troop"), "finishesAt" to JsonPrimitive("tomorrow"), "expectedCurrency" to JsonPrimitive("SHARDS"))
        malformed.forEach { (key, value) -> assertThrows(Exception::class.java) { ResearchSpeedup.parse(JsonObject(terms.json + (key to value))) } }
        assertThrows(Exception::class.java) { ResearchSpeedup.parse(JsonObject(terms.json - "episodeId")) }
        assertThrows(Exception::class.java) { ResearchSpeedup.parse(JsonObject(terms.json + ("extra" to JsonNull))) }
        val legacyEpisode = researchTerms(base = null, episode = null)
        assertEquals(legacyEpisode, ResearchSpeedup.parse(legacyEpisode.json)); assertEquals("null", legacyEpisode.query["episodeId"])
        assertFalse(legacyEpisode.query.containsKey("baseId")); assertFalse(legacyEpisode.body.containsKey("baseId"))
        assertFalse(terms.body.containsKey("expectedCurrency")); assertEquals("37", terms.query["maxCostKeep"])
    }
    @Test fun `proof binds original wallet all terms funding and result without consulting current catalogue`() {
        for (currency in GameCurrency.entries) {
            val original = researchTerms(currency, episode = null); val proof = researchProof(original)
            assertEquals(original, ResearchSpeedup.proof(proof, RESEARCH_WALLET, original)?.intent)
            assertThrows(Exception::class.java) { ResearchSpeedup.proof(proof, "22222222222222222222222222222222", original) }
        }
        val changedTerms = listOf(terms.copy(troop = "retired_troop"), terms.copy(baseId = null), terms.copy(idempotencyKey = "another-key"),
            terms.copy(expectedCurrency = GameCurrency.KEEP), terms.copy(currentLevel = 2, toLevel = 3), terms.copy(finishesAt = "2031-01-01T00:00:00Z"),
            terms.copy(episodeId = null), terms.copy(maxCostKeep = "38"))
        changedTerms.forEach { assertThrows(Exception::class.java) { ResearchSpeedup.proof(researchProof(it), RESEARCH_WALLET, terms) } }
        for (funding in listOf(json("""{"currency":"KEEP","amount":"36"}"""), json("""{"currency":"GEMS","amount":"38"}"""),
            json("""{"currency":"GEMS","amount":"0"}"""), json("""{"currency":"GEMS","amount":36}""")))
            assertThrows(Exception::class.java) { ResearchSpeedup.proof(JsonObject(researchProof() + ("funding" to funding)), RESEARCH_WALLET, terms) }
        assertThrows(Exception::class.java) { ResearchSpeedup.proof(JsonObject(researchProof() + ("result" to json("""{"troop":"highlander","fromLevel":1,"toLevel":3}"""))), RESEARCH_WALLET, terms) }
        // Admission depends on the live catalogue; persisted original proof does not.
        assertThrows(Exception::class.java) { prepare(c = buildJsonObject {}) }
        assertNotNull(ResearchSpeedup.proof(researchProof(), RESEARCH_WALLET, terms))
    }
    @Test fun `legacy DTO stays readable but natural advancement never proves a modern debit`() {
        val old = json("""{"levels":{"highlander":2},"research":[]}""")
        assertNull(ArmyState.from(old).features); assertThrows(Exception::class.java) { prepare(a = old) }
        val intent = ResearchSpec.intent(RESEARCH_WALLET, terms)
        assertThrows(ApiCompatibilityException::class.java) { ResearchSpec.decodeReceipt(intent, old) }
        assertThrows(ApiCompatibilityException::class.java) { ResearchSpec.acknowledge(intent, json("""{"cost":"37"}""")) }
        assertThrows(Exception::class.java) { ResearchSpec.restore(intent, ReceiptDocument.fromPost(researchProof())) }
        assertThrows(Exception::class.java) { ResearchSpec.validateSend(intent.copy(expectedCurrency = null)) }
        val legacy = PendingIntent(IntentKind.RESEARCH, RESEARCH_WALLET, BASE, "legacy-key", ResearchSpeedup.PATH, terms.body, "Legacy research",
            json("""{"action":"finish","troop":"highlander","level":"1","toLevel":2}"""))
        assertEquals("/army", ResearchSpec.receiptRequest(legacy).path)
        assertTrue(ResearchSpec.decodeReceipt(legacy, old) is Receipt.Accepted)
    }
    @Test fun `lost POST reopens frozen intent and GET only recovers while current features are absent`() = runBlocking {
        val disk = MemoryStore(); val store = PendingIntentStore(disk); val intent = ResearchSpec.intent(RESEARCH_WALLET, terms)
        var sends = 0; val wire = ScriptedTransport(onGet = { path, query -> assertEquals(ResearchSpeedup.RECEIPT, path); assertEquals(terms.query, query); researchProof() })
        val transport = ResearchCurrencyTransport(wire) { sent, _ -> sends++; assertEquals(intent.nextAttempt(), sent); throw IOException("lost acknowledgement") }
        assertThrows(IOException::class.java) { runBlocking { MoneyOp(ResearchSpec, store, transport).submit(intent) {} } }
        val restored = PendingIntentStore(disk); assertEquals(intent.nextAttempt(), restored.get(IntentKind.RESEARCH, RESEARCH_WALLET))
        var hydrated = false
        MoneyOp(ResearchSpec, restored, transport).observe(RESEARCH_WALLET) { hydrated = true; assertEquals(terms, it.value.finish?.intent) }
        assertTrue(hydrated); assertNull(restored.get(IntentKind.RESEARCH, RESEARCH_WALLET)); assertEquals(1, sends); assertEquals(1, wire.gets.size)
    }
    @Test fun `accepted proof survives failed hydration and reload never resends or switches currency`() = runBlocking {
        val disk = MemoryStore(); val store = PendingIntentStore(disk); val intent = ResearchSpec.intent(RESEARCH_WALLET, terms)
        var sends = 0; val wire = ScriptedTransport(onGet = { _, _ -> researchProof() })
        val transport = ResearchCurrencyTransport(wire) { _, _ -> sends++ }
        assertThrows(IOException::class.java) { runBlocking { MoneyOp(ResearchSpec, store, transport).submit(intent) { throw IOException("army unavailable") } } }
        val saved = requireNotNull(store.get(IntentKind.RESEARCH, RESEARCH_WALLET)); assertEquals(1L, saved.attemptRevision)
        assertEquals(ReceiptDocument.SOURCE_RECEIPT, ReceiptDocument.source(requireNotNull(saved.receipt)))
        MoneyOp(ResearchSpec, PendingIntentStore(disk), transport).observe(RESEARCH_WALLET) { assertEquals(terms, it.value.finish?.intent) }
        assertEquals(1, sends); assertEquals(1, wire.gets.size)
    }
}
