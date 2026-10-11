package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** Additive review regressions; the 887d7ec5 test snapshot remains immutable. */
class SkrFaucetM3RefusalScopeTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-discovery-vectors.json")
        assertNotNull("MISSING: actual authenticated P5 discovery route vectors", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val disk = MemoryStore()
        val journal = SkrFaucetJournal(disk, session.wallet, session.origin, "devnet")
        val target = SkrFaucetGrant.from(vector("pendingPage").getValue("items").jsonArray.single().jsonObject)
        val day = Instant.parse(target.requestedAt).atOffset(ZoneOffset.UTC).toLocalDate()
        val base = "11111111-1111-4111-8111-111111111111"; var prompts = 0
        val repo = SkrFaucetRepository(session, holder, api, journal,
            { SkrIdentity(target.mint, target.decimals) }, { SkrFaucetBounds(5000, "1000", 20) }, { base },
            { _, _, _ -> prompts++ }, {})
        fun status(nextDay: Boolean = false, reason: String = "ok") = JsonObject(vector("beforeClaimStatus") + mapOf(
            "day" to JsonPrimitive((if (nextDay) day.plusDays(1) else day).toString()),
            "nextEligibleAt" to JsonPrimitive("${day.plusDays(if (nextDay) 2L else 1L)}T00:00:00.000Z"),
            "enabled" to JsonPrimitive(true), "eligible" to JsonPrimitive(reason == "ok"),
            "today" to JsonNull, "reason" to JsonPrimitive(reason)))
        fun refuseOwnership() { api.onGet("/devnet-skr-faucet/grants/${target.id}") {
            throw ApiException(404, "SKR_FAUCET_NOT_OWNED", "not owned")
        } }
        fun assertRetained(before: String?) {
            assertNotNull(before); assertEquals(before, disk.value); assertNotNull(journal.read())
            assertTrue(repo.state.value.uncertain); assertFalse(repo.state.value.canClaim)
            assertNull(repo.state.value.discoveryNextCursor); assertEquals(0, prompts)
        }
    }
    @Test fun `unknown status alone retains original bytes despite a terminal empty page being available`() = runBlocking {
        val f = Fixture(); f.journal.beginIfEmpty(f.base, f.day.toString()); val before = f.disk.value
        f.api.onGet("/devnet-skr-faucet/status") { f.status(nextDay = true, reason = "future_reason") }
        // This handler never replaces the journal: an erroneous absence proof would clear the original bytes.
        f.api.onGet("/devnet-skr-faucet/grants") { vector("emptyPage") }
        f.repo.refresh(); f.assertRetained(before)
        assertEquals(0, f.api.gets.count { it.first == "/devnet-skr-faucet/grants" }); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `daily limit code with a noncanonical status cannot use owned refusal to release`() = runBlocking {
        for (httpStatus in listOf(400, 409, 503)) {
            val f = Fixture(); var before: String? = null
            f.api.onGet("/devnet-skr-faucet/status") { f.status() }; f.refuseOwnership()
            f.api.onPost("/devnet-skr-faucet/claim") {
                before = f.disk.value
                throw ApiException(httpStatus, "SKR_FAUCET_DAILY_LIMIT", "wrong status",
                    details = buildJsonObject { put("today", f.target.raw) })
            }
            f.repo.claim(); f.assertRetained(before); assertEquals(1, f.api.posts.size)
            assertEquals(0, f.api.gets.count { it.first.startsWith("/devnet-skr-faucet/grants/") })
        }
    }
    @Test fun `daily limit with an unknown grant or attempt state cannot release through owned refusal`() = runBlocking {
        for (unknownAttempt in listOf(false, true)) {
            val f = Fixture(); var before: String? = null
            val today = if (unknownAttempt) JsonObject(f.target.raw + ("attempt" to JsonObject(
                f.target.raw.getValue("attempt").jsonObject + ("phase" to JsonPrimitive("future_phase")))))
                else JsonObject(f.target.raw + ("status" to JsonPrimitive("future_status")))
            f.api.onGet("/devnet-skr-faucet/status") { f.status() }; f.refuseOwnership()
            f.api.onPost("/devnet-skr-faucet/claim") {
                before = f.disk.value
                throw ApiException(429, "SKR_FAUCET_DAILY_LIMIT", "reserved",
                    details = buildJsonObject { put("today", today) })
            }
            f.repo.claim(); f.assertRetained(before); assertEquals(1, f.api.posts.size)
            assertEquals(0, f.api.gets.count { it.first.startsWith("/devnet-skr-faucet/grants/") })
        }
    }
}
