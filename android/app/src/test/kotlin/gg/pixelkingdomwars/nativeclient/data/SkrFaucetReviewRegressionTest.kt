package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SkrFaucetReviewRegressionTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-api-vectors.json")
        assertNotNull("MISSING: P5 route response vectors", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    @Test fun `unknown reason preserves the original saved grant bytes`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), WALLET, session.origin, "devnet")
        val grant = SkrFaucetGrant.from(vector("prepare").getValue("grant").jsonObject)
        val initial = journal.begin("11111111-1111-4111-8111-111111111111")
        val retained = initial.copy(grant = grant, attemptId = grant.attempt!!.id, preparePending = true)
        journal.replace(initial, retained)
        api.onGet("/devnet-skr-faucet/status") { JsonObject(vector("status") + mapOf("today" to grant.raw,
            "eligible" to JsonPrimitive(false), "reason" to JsonPrimitive("future_reason"))) }
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(grant.mint, grant.decimals) },
            { SkrFaucetBounds(5000, "1000") }, { initial.baseId }, { _, _, _ -> error("no sign") }, {})
        repo.refresh(); assertEquals(retained, journal.read()); assertTrue(api.posts.isEmpty())
    }
    @Test fun `selection epoch changes refuse awaited private state even when selected base returns to same ID`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); var epoch = 0L
        val grant = SkrFaucetGrant.from(vector("claim").getValue("grant").jsonObject)
        api.onGet("/devnet-skr-faucet/status") { epoch++; vector("status") }
        val repo = SkrFaucetRepository(session, holder, api, SkrFaucetJournal(MemoryStore(), WALLET, session.origin, "devnet"),
            { SkrIdentity(grant.mint, grant.decimals) }, { SkrFaucetBounds(5000, "1000") },
            { "11111111-1111-4111-8111-111111111111" }, { _, _, _ -> error("no sign") }, {}, actionEpoch = { epoch })
        repo.claim(); assertNull(repo.state.value.status); assertTrue(api.posts.isEmpty())
    }
}
