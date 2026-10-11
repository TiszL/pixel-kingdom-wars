package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Dead-end audit 2026-10-06 (shape A, QA lane). A saved test expansion the server holds no quote for could only be
 * re-quoted (needs the original base still eligible) or cancelled by POST; `finish` refused it, so expansion stayed
 * blocked. It may be finished only when this same action's by-key GET answered `unquoted` for exactly its key. */
class CandidateExpansionUnquotedFinishTest {
    private val key = "00000000-0000-4000-8000-000000000031"
    private val request = BasePurchaseRequest.from(buildJsonObject { put("kind", "expansion"); put("idempotencyKey", key); put("baseId", BASE_ID); put("expectedExpansions", 0) })
    private fun expansionQuote(): JsonObject {
        val unsigned = buildJsonObject {
            put("version", 1); put("mode", CandidateExpansionContract.MODE); put("origin", CandidateExpansionContract.ORIGIN)
            put("sourceSha", "a".repeat(40)); put("wallet", WALLET); put("fixtureId", PAID_OTHER); put("request", request.raw)
            put("baseEpoch", buildJsonObject { put("landPaidAt", PAID_LAND); put("deedAssetId", JsonNull) })
            put("offer", buildJsonObject { put("expectedExpansions", request.expectedExpansions); put("fromClaimTiles", 14)
                put("toClaimTiles", 16); put("requiredKeepLevel", 3); put("referencePriceLamports", "150000000"); put("chargedLamports", "0") })
            put("createdAt", PAID_NOW)
        }
        return JsonObject(unsigned + ("quoteHash" to JsonPrimitive(CandidateExpansionContract.digest(unsigned))))
    }
    private fun expansionState(quote: JsonObject?) = buildJsonObject {
        put("version", 1); put("mode", CandidateExpansionContract.MODE); put("wallet", WALLET); put("idempotencyKey", key)
        put("status", if (quote == null) "unquoted" else "quoted"); put("quote", quote ?: JsonNull); put("receipt", JsonNull)
    }
    private inner class Fixture {
        val holder = testHolder(); val session = AccountSession(WALLET, CandidateExpansionContract.ORIGIN, testToken()).also { holder.replace(it) }
        val store = CandidateExpansionStore(MemoryStore(), WALLET, session.origin); val api = FakeApiClient()
        var answer = expansionState(null)
        init { api.onGet("${CandidateExpansionRepository.PATH}/$key") { answer }; store.draft(request) }
        val repository = CandidateExpansionRepository(session, holder, api, store, true, { BASE_ID }, { null }, ::paidCatalogue, { true }, {}, {})
    }

    @Test fun `a test expansion request the server holds no quote for can be finished after its own by-key read`() = runBlocking {
        val f = Fixture(); assertNull(f.store.read()?.state)
        f.repository.finish()
        assertEquals("finishing is one GET of exactly this key", listOf("${CandidateExpansionRepository.PATH}/$key"), f.api.gets.map { it.first })
        assertTrue("no POST of any kind", f.api.posts.isEmpty()); assertNull(f.repository.state.value.error)
        assertNull("the expansion door is open again", f.store.read()); assertNull(f.repository.state.value.saved)
    }
    @Test fun `finish is refused when the by-key read shows a quote and the request stays saved`() = runBlocking {
        val f = Fixture(); f.answer = expansionState(expansionQuote())
        f.repository.finish()
        assertNotNull(f.repository.state.value.error); assertTrue(f.api.posts.isEmpty())
        assertEquals("quoted", f.store.read()?.state?.status); assertEquals(key, f.store.read()?.request?.key)
    }
}
