package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SkrFaucetDailyLimitOwnershipTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-api-vectors.json")
        assertNotNull("MISSING: vector from P5 frozen route-test output", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    @Test fun `daily limit details require owned grant GET before attaching to durable intent`() = runBlocking {
        for (owned in listOf(false, true)) {
            val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
            val journal = SkrFaucetJournal(MemoryStore(), session.wallet, session.origin, "devnet")
            val grant = SkrFaucetGrant.from(vector("claim").getValue("grant").jsonObject)
            api.onGet("/devnet-skr-faucet/status") { vector("status") }
            api.onPost("/devnet-skr-faucet/claim") {
                throw ApiException(429, "SKR_FAUCET_DAILY_LIMIT", "reserved", details = buildJsonObject { put("today", grant.raw) })
            }
            api.onGet("/devnet-skr-faucet/grants/${grant.id}") {
                if (!owned) throw ApiException(404, "SKR_FAUCET_NOT_OWNED", "unavailable")
                buildJsonObject { put("grant", grant.raw) }
            }
            val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(grant.mint, grant.decimals) },
                { SkrFaucetBounds(5000, "1000") }, { "11111111-1111-4111-8111-111111111111" },
                { _, _, _ -> error("No signing prompt") }, {})
            repo.claim()
            assertEquals(1, api.posts.size)
            // review 8938311c M3: exact owned-GET 404 proves this coded refusal left no owned grant to adopt.
            if (owned) assertEquals(grant.id, requireNotNull(journal.read()).grant!!.id) else assertNull(journal.read())
            assertFalse(repo.state.value.uncertain); assertFalse(repo.state.value.canClaim)
        }
    }
}
