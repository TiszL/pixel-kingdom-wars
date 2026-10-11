package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SkrFaucetRecoveryTest {
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
    @Test fun `restart resubmits identical saved wire only for the same prepared attempt`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), WALLET, session.origin, "devnet")
        val grant = SkrFaucetGrant.from(vector("prepare").getValue("grant").jsonObject)
        val intent = journal.begin(base)
        journal.replace(intent, intent.copy(grant = grant, attemptId = grant.attempt!!.id, signedTransaction = wire()))
        api.onGet("/devnet-skr-faucet/status") { JsonObject(vector("status") + mapOf("today" to grant.raw, "reason" to JsonPrimitive("pending"), "eligible" to JsonPrimitive(false))) }
        api.onPost("/devnet-skr-faucet/submit") { body ->
            assertEquals(setOf("attemptId", "signedTransaction"), body.keys)
            assertEquals(wire(), body.getValue("signedTransaction").jsonPrimitive.content)
            assertEquals(wire(), journal.read()!!.signedTransaction)
            vector("submit")
        }
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(grant.mint, grant.decimals) },
            { SkrFaucetBounds(5000, "1000") }, { base }, { _, _, _ -> error("must not prompt again") }, {})
        repo.recover(); assertEquals(1, api.posts.size)
    }
    @Test fun `another prepared attempt or submitted phase never resubmits stale wire`() = runBlocking {
        for (phase in listOf("prepared", "submitted", "future_phase")) {
            val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
            val journal = SkrFaucetJournal(MemoryStore(), WALLET, session.origin, "devnet")
            val grant = SkrFaucetGrant.from(vector("prepare").getValue("grant").jsonObject)
            val intent = journal.begin(base)
            journal.replace(intent, intent.copy(grant = grant, attemptId = grant.attempt!!.id, signedTransaction = wire()))
            val attempt = grant.raw.getValue("attempt").jsonObject
            val changedAttempt = JsonObject(attempt + mapOf("phase" to JsonPrimitive(phase),
                "id" to JsonPrimitive(if (phase == "prepared") "22222222-2222-4222-8222-222222222222" else grant.attempt!!.id)))
            val changed = JsonObject(grant.raw + ("attempt" to changedAttempt))
            api.onGet("/devnet-skr-faucet/status") { JsonObject(vector("status") + mapOf("today" to changed,
                "reason" to JsonPrimitive(if (phase == "prepared") "pending" else "submitted"), "eligible" to JsonPrimitive(false))) }
            val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(grant.mint, grant.decimals) },
                { SkrFaucetBounds(5000, "1000") }, { base }, { _, _, _ -> error("must not prompt") }, {})
            repo.recover(); assertTrue(api.posts.isEmpty()); assertNotNull(journal.read())
        }
    }

    // Defensive client regressions for accepted server-v3 operator refusal spellings.
    // Injecting a refusal here does not introduce a client operator route or prove route fixtures.
    @Test fun `operator refusals during status reads preserve the exact signed journal`() = runBlocking {
        for (code in listOf("SKR_OUTCOME_MISMATCH", "SKR_OPERATOR_CHANGED", "SKR_OPERATOR_EVIDENCE")) {
            val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
            val disk = MemoryStore(); val journal = SkrFaucetJournal(disk, WALLET, session.origin, "devnet")
            val grant = SkrFaucetGrant.from(vector("prepare").getValue("grant").jsonObject)
            val intent = journal.begin(base)
            val saved = intent.copy(grant = grant, attemptId = grant.attempt!!.id, signedTransaction = wire())
            journal.replace(intent, saved); val before = disk.value
            var prompts = 0; var walletReads = 0
            api.onGet("/devnet-skr-faucet/status") { throw ApiException(409, code, "operator proof refused") }
            val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(grant.mint, grant.decimals) },
                { SkrFaucetBounds(5000, "1000") }, { base }, { _, _, _ -> prompts++ }, { walletReads++ })
            repo.refresh(); repo.recover()
            assertEquals(code, before, disk.value); assertEquals(saved, journal.read())
            assertTrue(repo.state.value.available); assertFalse(repo.state.value.canClaim)
            assertFalse(repo.state.value.busy); assertNotNull(repo.state.value.error)
            assertNull(repo.state.value.arrival); assertNull(repo.state.value.networkFeeLamports)
            assertNull(repo.state.value.accountRentLamports)
            assertTrue(api.posts.isEmpty()); assertEquals(0, prompts); assertEquals(0, walletReads)
            assertEquals(listOf("/devnet-skr-faucet/status", "/devnet-skr-faucet/status"), api.gets.map { it.first })
        }
    }
    @Test fun `operator refusals on explicit recovery keep the signed wire and refresh never retries it`() = runBlocking {
        for (code in listOf("SKR_OUTCOME_MISMATCH", "SKR_OPERATOR_CHANGED", "SKR_OPERATOR_EVIDENCE")) {
            val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
            val disk = MemoryStore(); val journal = SkrFaucetJournal(disk, WALLET, session.origin, "devnet")
            val grant = SkrFaucetGrant.from(vector("prepare").getValue("grant").jsonObject)
            val intent = journal.begin(base)
            val saved = intent.copy(grant = grant, attemptId = grant.attempt!!.id, signedTransaction = wire())
            journal.replace(intent, saved); val before = disk.value
            var prompts = 0; var walletReads = 0
            api.onGet("/devnet-skr-faucet/status") { JsonObject(vector("status") + mapOf("today" to grant.raw,
                "reason" to JsonPrimitive("pending"), "eligible" to JsonPrimitive(false))) }
            api.onPost("/devnet-skr-faucet/submit") { body ->
                assertEquals(setOf("attemptId", "signedTransaction"), body.keys)
                assertEquals(saved.attemptId, body.getValue("attemptId").jsonPrimitive.content)
                assertEquals(saved.signedTransaction, body.getValue("signedTransaction").jsonPrimitive.content)
                assertEquals(before, disk.value)
                throw ApiException(409, code, "operator proof refused")
            }
            val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(grant.mint, grant.decimals) },
                { SkrFaucetBounds(5000, "1000") }, { base }, { _, _, _ -> prompts++ }, { walletReads++ })
            repo.recover()
            assertEquals(code, before, disk.value); assertEquals(saved, journal.read())
            assertNotNull(repo.state.value.error); assertFalse(repo.state.value.canClaim)
            assertNull(repo.state.value.arrival); assertEquals(1, api.posts.size)
            repo.refresh()
            assertEquals(before, disk.value); assertEquals(saved, journal.read())
            assertEquals(1, api.posts.size); assertEquals("/devnet-skr-faucet/submit", api.posts.single().first)
            assertEquals(0, prompts); assertEquals(0, walletReads); assertNull(repo.state.value.arrival)
            assertNull(repo.state.value.networkFeeLamports); assertNull(repo.state.value.accountRentLamports)
            assertFalse(repo.state.value.canClaim); assertFalse(repo.state.value.busy)
        }
    }

}
