package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class SkrFaucetUnknownIntentTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-discovery-vectors.json")
        assertNotNull("MISSING: actual authenticated P5 discovery route vectors", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    @Test fun `new day absence releases only proven unsigned intent and never continues the same prepare action`() = runBlocking {
        for (legacy in listOf(false, true)) {
            val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val disk = MemoryStore()
            val journal = SkrFaucetJournal(disk, session.wallet, session.origin, "devnet")
            val old = SkrFaucetGrant.from(vector("pendingPage").getValue("items").jsonArray.single().jsonObject)
            val today = vector("newerPage").getValue("items").jsonArray.first().jsonObject
            val day = Instant.parse(old.requestedAt).atOffset(ZoneOffset.UTC).toLocalDate().toString()
            val base = "11111111-1111-4111-8111-111111111111"
            journal.beginIfEmpty(base, if (legacy) null else day)
            api.onGet("/devnet-skr-faucet/status") {
                JsonObject(vector("nextDayStatus") + mapOf("today" to today, "reason" to JsonPrimitive("sign_required"),
                    "enabled" to JsonPrimitive(true), "eligible" to JsonPrimitive(false)))
            }
            api.onGet("/devnet-skr-faucet/grants") { vector("emptyPage") }
            var prompts = 0
            val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(old.mint, old.decimals) },
                { SkrFaucetBounds(5000, "1000", 20) }, { base }, { _, _, _ -> prompts++ }, {})
            repo.prepareAndSign()
            // review 8938311c M3 permits release, but no same-action prepare/sign may follow it.
            // Rewritten 2026-10-06 (dead-end audit): the legacy no-day intent is now released by the same complete
            // zero-pending scan instead of being retained forever; the no-follow-on-effect pin below is unchanged.
            assertNull(journal.read()); assertFalse(repo.state.value.uncertain)
            assertTrue(api.posts.isEmpty()); assertEquals(0, prompts); assertFalse(repo.state.value.canClaim)
        }
    }
}
