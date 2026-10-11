package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Supplemental review regressions; accepted identities/wires come from the same actual P5 vectors. */
class SkrFaucetAttemptRecoveryReviewTest {
    private val base = "11111111-1111-4111-8111-111111111111"
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-api-vectors.json")
        assertNotNull("MISSING: vector from P5 frozen route-test output", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    private fun wire(): String {
        val input = javaClass.getResourceAsStream("/skr-faucet-signed-vector.json")
        assertNotNull("MISSING: real P5-verified player-signed wire", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue("signedTransaction").jsonPrimitive.content
    }
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), session.wallet, session.origin, "devnet")
        val grant = SkrFaucetGrant.from(vector("prepare").getValue("grant").jsonObject)
        var prompts = 0
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(grant.mint, grant.decimals) },
            { SkrFaucetBounds(5000, "1000") }, { base },
            { _, _, _ -> prompts++; error("No signing prompt belongs to these recovery cases") }, {})
        fun saveSigned(): SkrFaucetRecord {
            val intent = journal.begin(base)
            val saved = intent.copy(grant = grant, attemptId = grant.attempt!!.id, signedTransaction = wire())
            journal.replace(intent, saved)
            return saved
        }
        fun status(currentGrant: JsonObject = grant.raw, reason: String = "pending", enabled: Boolean = true) {
            api.onGet("/devnet-skr-faucet/status") {
                JsonObject(vector("status") + mapOf("today" to currentGrant, "reason" to JsonPrimitive(reason),
                    "enabled" to JsonPrimitive(enabled), "eligible" to JsonPrimitive(false)))
            }
        }
    }
    @Test fun `proven terminal attempts release only stale wire and retain the requested grant for explicit prepare`() = runBlocking {
        for (phase in listOf("failed", "expired", "abandoned")) {
            val f = Fixture(); val saved = f.saveSigned()
            val terminalAttempt = JsonObject(f.grant.raw.getValue("attempt").jsonObject + ("phase" to JsonPrimitive(phase)))
            f.status(JsonObject(f.grant.raw + ("attempt" to terminalAttempt)), reason = "sign_required")
            f.repo.refresh()
            val retained = requireNotNull(f.journal.read())
            assertEquals(saved.intentId, retained.intentId); assertEquals(saved.baseId, retained.baseId)
            assertEquals(f.grant.id, retained.grant!!.id); assertTrue(retained.grant.status.isValue("requested"))
            assertTrue(retained.grant.attempt!!.phase.isValue(phase)); assertNull(retained.signedTransaction)
            assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.prompts)
        }
    }
    @Test fun `daily limit with a requested grant never prepares another wallet's deed allocation`() = runBlocking {
        val f = Fixture(); f.status(reason = "daily_limit")
        f.repo.prepareAndSign()
        assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.prompts); assertNull(f.journal.read())
    }
    @Test fun `disabled status preserves signed evidence without resubmitting its prepared attempt`() = runBlocking {
        val f = Fixture(); val saved = f.saveSigned(); f.status(enabled = false)
        f.repo.recover()
        assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.prompts)
        assertEquals(saved.signedTransaction, f.journal.read()!!.signedTransaction)
        assertEquals(saved.intentId, f.journal.read()!!.intentId)
    }
    @Test fun `production beginIfEmpty cannot overwrite an already durable intent`() {
        val disk = MemoryStore(); val journal = SkrFaucetJournal(disk, WALLET, "https://localhost:18443", "devnet")
        val original = journal.beginIfEmpty(base); val originalBytes = disk.value
        assertThrows(IllegalStateException::class.java) { journal.beginIfEmpty("22222222-2222-4222-8222-222222222222") }
        assertEquals(original, journal.read()); assertEquals(originalBytes, disk.value)
    }

    @Test fun `operator chain failure retains the requested grant without claiming arrival or signing again`() = runBlocking {
        val f = Fixture(); val saved = f.saveSigned()
        val failedAttempt = JsonObject(f.grant.raw.getValue("attempt").jsonObject + ("phase" to JsonPrimitive("failed")))
        val retryable = JsonObject(f.grant.raw + mapOf("error" to JsonPrimitive("chain_failed"), "attempt" to failedAttempt))
        f.status(retryable, reason = "sign_required")
        f.repo.refresh()
        val retained = requireNotNull(f.journal.read())
        assertEquals(saved.intentId, retained.intentId); assertEquals(saved.baseId, retained.baseId)
        assertEquals(saved.claimDay, retained.claimDay); assertEquals(saved.attemptId, retained.attemptId)
        assertEquals("chain_failed", retained.grant!!.error); assertEquals(retryable, retained.grant.raw)
        assertTrue(retained.grant.status.isValue("requested")); assertTrue(retained.grant.attempt!!.phase.isValue("failed"))
        assertNull(retained.signedTransaction); assertFalse(retained.preparePending)
        assertEquals(retained.grant, f.repo.state.value.grant); assertNull(f.repo.state.value.arrival)
        assertFalse(f.repo.state.value.canClaim); assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.prompts)
    }
    @Test fun `operator exhausted attempt closes only the failed grant with no arrival or automatic claim`() = runBlocking {
        val f = Fixture(); f.saveSigned()
        val failedAttempt = JsonObject(f.grant.raw.getValue("attempt").jsonObject + ("phase" to JsonPrimitive("failed")))
        val exhausted = JsonObject(f.grant.raw + mapOf("status" to JsonPrimitive("failed"),
            "error" to JsonPrimitive("max_attempts"), "attempt" to failedAttempt))
        f.status(exhausted, reason = "daily_limit")
        f.repo.refresh()
        assertNull(f.journal.read()); assertTrue(f.repo.state.value.grant!!.status.isValue("failed"))
        assertEquals("max_attempts", f.repo.state.value.grant!!.error)
        assertEquals(exhausted, f.repo.state.value.grant!!.raw)
        assertNull(f.repo.state.value.arrival); assertFalse(f.repo.state.value.canClaim)
        assertFalse(f.repo.state.value.uncertain); assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.prompts)
    }

}
