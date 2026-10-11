package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

internal class ReferralFixture(val disk: SecretStore = MemoryStore()) {
    val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
    val journal = ReferralJournal(disk, WALLET, session.origin, "devnet")
    val repository = ReferralRepository(session, holder, api, journal)
    var binding: JsonObject? = null
    fun relation(referrer: String = "2".repeat(32)) = json("""{"id":"00000000-0000-4000-8000-000000000001","refereeWallet":"$WALLET","referrerWallet":"$referrer","createdAt":"2026-09-13T00:00:00.000Z"}""")
    fun status() = buildJsonObject { put("version", 1); put("wallet", WALLET); put("relationship", binding ?: JsonNull) }
    fun response(code: String, outcome: String = "applied") = buildJsonObject {
        put("version", 1); put("wallet", WALLET); put("submittedCode", code); put("outcome", outcome); put("relationship", binding ?: relation())
    }
    init {
        api.onGet(ReferralRepository.STATUS) { status() }
        api.onPost(ReferralRepository.USE) { body ->
            val saved = requireNotNull(journal.read()); assertEquals(setOf("code"), body.keys)
            assertEquals(JsonPrimitive(saved.code), body["code"]); assertNull(saved.relationship)
            binding = relation(); response(requireNotNull(saved.code))
        }
    }
    suspend fun submit(input: String = " keep-ab234 ") {
        repository.review(input); repository.state.value.review?.let { repository.confirm(it) }
    }
}

class ReferralRepositoryTest {
    @Test fun `foreground and Back from normalized review never submit`() = runBlocking {
        val f = ReferralFixture(); f.repository.refresh(); assertTrue(f.repository.state.value.canEnter)
        f.repository.review("\ufeffkeep-ab234 "); assertEquals("KEEP-AB234", f.repository.state.value.review!!.code)
        f.repository.dismiss(); f.repository.refresh(); assertNull(f.journal.read()); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `exact code is durable before one POST and original attribution stays after Finish`() = runBlocking {
        val f = ReferralFixture(); f.submit(); assertEquals(1, f.api.posts.size)
        assertEquals("applied", f.journal.read()!!.outcome); assertEquals("KEEP-AB234", f.journal.read()!!.code)
        f.repository.finish(); assertNull(f.journal.read()!!.code); assertNotNull(f.journal.read()!!.relationship)
        f.repository.review("KEEP-OTHER"); assertEquals(1, f.api.posts.size); assertNull(f.repository.state.value.review)
    }
    @Test fun `old server status404 never offers entry POST or a legacy fallback`() = runBlocking {
        val f = ReferralFixture(); f.api.onGet(ReferralRepository.STATUS) { throw ApiException(404, null, "route missing") }
        f.repository.refresh(); f.submit(); f.repository.retry()
        assertFalse(f.repository.state.value.supported); assertTrue(f.api.posts.isEmpty()); assertNull(f.journal.read())
        assertTrue(f.api.gets.all { it.first == ReferralRepository.STATUS && it.second.isEmpty() })
    }
    @Test fun `unknown contract or another wallet cannot enable submission`() = runBlocking {
        for (change in listOf("version" to JsonPrimitive(2), "wallet" to JsonPrimitive("2".repeat(32)))) {
            val f = ReferralFixture(); f.api.onGet(ReferralRepository.STATUS) { JsonObject(f.status() + change) }
            f.repository.refresh(); f.submit(); assertFalse(f.repository.state.value.supported); assertTrue(f.api.posts.isEmpty())
        }
    }
    @Test fun `lost response then process restart resolves by positive GET without attributing the saved code`() = runBlocking {
        val disk = MemoryStore(); val first = ReferralFixture(disk)
        first.api.onPost(ReferralRepository.USE) { first.binding = first.relation(); throw IOException("lost") }
        first.submit(); assertEquals("KEEP-AB234", first.journal.read()!!.code)
        val second = ReferralFixture(disk); second.binding = first.binding; second.repository.refresh()
        assertTrue(second.api.posts.isEmpty()); assertEquals("observed", second.journal.read()!!.outcome)
        assertEquals("KEEP-AB234", second.journal.read()!!.code); assertNotNull(second.journal.read()!!.relationship)
    }
    @Test fun `null restart observation keeps exact code for explicit same code retry`() = runBlocking {
        val disk = MemoryStore(); val first = ReferralFixture(disk); first.api.onPost(ReferralRepository.USE) { throw IOException("lost") }; first.submit()
        val second = ReferralFixture(disk); repeat(3) { second.repository.refresh() }
        second.repository.review("KEEP-OTHER"); second.repository.finish()
        assertTrue(second.api.posts.isEmpty()); assertEquals("KEEP-AB234", second.journal.read()!!.code)
        second.repository.retry(); assertEquals(1, second.api.posts.size); assertEquals(JsonPrimitive("KEEP-AB234"), second.api.posts.single().second["code"])
    }
    @Test fun `each exact atomic first refusal permits an explicit corrected code`() = runBlocking {
        for ((status, code) in listOf(404 to "REFERRAL_CODE_UNKNOWN", 422 to "REFERRAL_SELF", 422 to "REFERRAL_WINDOW_CLOSED")) {
            val f = ReferralFixture(); val valid = f.api.postHandlers.getValue(ReferralRepository.USE)
            f.api.onPost(ReferralRepository.USE) { throw ApiException(status, code, "refused before writes") }; f.submit()
            assertNull(f.journal.read()); assertNotNull(f.repository.state.value.error)
            f.api.onPost(ReferralRepository.USE, valid); f.submit("KEEP-OTHER")
            assertEquals(2, f.api.posts.size); assertEquals("KEEP-OTHER", f.journal.read()!!.code); assertEquals("applied", f.journal.read()!!.outcome)
        }
    }
    @Test fun `a later atomic refusal can never disprove an earlier uncertain or restored attempt`() = runBlocking {
        for ((status, code) in listOf(404 to "REFERRAL_CODE_UNKNOWN", 422 to "REFERRAL_SELF", 422 to "REFERRAL_WINDOW_CLOSED")) {
            val disk = MemoryStore(); val first = ReferralFixture(disk); first.api.onPost(ReferralRepository.USE) { throw IOException("lost") }; first.submit()
            val second = ReferralFixture(disk); second.api.onPost(ReferralRepository.USE) { throw ApiException(status, code, "later refusal") }
            second.repository.refresh(); second.repository.retry(); second.repository.review("KEEP-OTHER")
            assertEquals("KEEP-AB234", second.journal.read()!!.code); assertEquals(1, second.api.posts.size)
            assertEquals(JsonPrimitive("KEEP-AB234"), second.api.posts.single().second["code"])
        }
    }
    @Test fun `generic refusal and mismatched codes stay uncertain even on the first attempt`() = runBlocking {
        for (error in listOf(ApiException(404, null, "unknown"), ApiException(422, null, "invalid"), ApiException(409, null, "conflict"),
            ApiException(503, "REFERRAL_CODE_UNKNOWN", "unavailable"))) {
            val f = ReferralFixture(); f.api.onPost(ReferralRepository.USE) { throw error }; f.submit()
            assertEquals("KEEP-AB234", f.journal.read()!!.code); assertNull(f.journal.read()!!.relationship)
        }
    }
    @Test fun `already bound reports actual attribution and rejects later missing or contradictory proof`() = runBlocking {
        val f = ReferralFixture(); f.api.onPost(ReferralRepository.USE) { f.binding = f.relation("3".repeat(32)); f.response("KEEP-AB234", "already_bound") }
        f.submit(); assertEquals("already_bound", f.journal.read()!!.outcome); val proof = f.journal.read()
        f.binding = null; f.repository.refresh(); assertEquals(proof, f.journal.read())
        f.binding = f.relation(); f.repository.refresh(); assertEquals(proof, f.journal.read()); assertFalse(f.repository.state.value.supported)
    }
    @Test fun `a positive initial relationship blocks code entry without issuing commands`() = runBlocking {
        val f = ReferralFixture(); f.binding = f.relation(); f.repository.refresh(); f.submit()
        assertEquals("observed", f.journal.read()!!.outcome); assertNull(f.journal.read()!!.code); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `mismatched response code wallet and relationship cannot retire the original intent`() = runBlocking {
        for (change in listOf("submittedCode" to JsonPrimitive("KEEP-OTHER"), "wallet" to JsonPrimitive("2".repeat(32)), "relationship" to JsonNull)) {
            val f = ReferralFixture(); f.api.onPost(ReferralRepository.USE) { JsonObject(f.response("KEEP-AB234") + change) }; f.submit()
            assertEquals("KEEP-AB234", f.journal.read()!!.code); assertNull(f.journal.read()!!.relationship)
        }
    }
    @Test fun `storage failure before POST and corruption never become an empty safe slot`() = runBlocking {
        val broken = object : SecretStore { override fun read(): String? = null; override fun write(value: String) { throw IOException("disk") }; override fun clear() = Unit }
        val write = ReferralFixture(broken); write.submit(); assertTrue(write.api.posts.isEmpty()); assertNotNull(write.repository.state.value.error)
        val disk = MemoryStore("corrupt"); val read = ReferralFixture(disk); read.repository.refresh(); read.submit()
        assertTrue(read.api.gets.isEmpty()); assertTrue(read.api.posts.isEmpty()); assertFalse(read.repository.state.value.loaded); assertEquals("corrupt", disk.value)
    }
    @Test fun `wallet origin and cluster mismatches preserve encrypted contents`() = runBlocking {
        val f = ReferralFixture(); f.journal.begin("KEEP-AB234"); val bytes = (f.disk as MemoryStore).value
        for (store in listOf(ReferralJournal(f.disk, "2".repeat(32), f.session.origin, "devnet"), ReferralJournal(f.disk, WALLET, "https://different.invalid", "devnet"),
            ReferralJournal(f.disk, WALLET, f.session.origin, "mainnet-beta"))) assertTrue(runCatching { store.read() }.isFailure)
        assertEquals(bytes, f.disk.value)
    }
    @Test fun `failed receipt persistence keeps original intent until a positive GET`() = runBlocking {
        val memory = MemoryStore(); var writes = 0
        val disk = object : SecretStore { override fun read() = memory.read(); override fun clear() = memory.clear()
            override fun write(value: String) { if (++writes == 2) throw IOException("receipt write interrupted"); memory.write(value) } }
        val f = ReferralFixture(disk); f.submit(); assertNull(f.journal.read()!!.relationship)
        f.repository.refresh(); assertEquals("observed", f.journal.read()!!.outcome); assertEquals(1, f.api.posts.size)
    }
    @Test fun `late session success and refusal cannot overwrite or clear the saved code`() = runBlocking {
        for (refused in listOf(false, true)) {
            val f = ReferralFixture(); val gate = CompletableDeferred<Unit>()
            f.api.onPost(ReferralRepository.USE) { gate.await(); if (refused) throw ApiException(404, "REFERRAL_CODE_UNKNOWN", "late") else f.response("KEEP-AB234") }
            f.repository.review("KEEP-AB234"); val review = f.repository.state.value.review!!
            val job = launch { f.repository.confirm(review) }; yield(); signedIn(f.holder); gate.complete(Unit); job.join()
            assertEquals("KEEP-AB234", f.journal.read()!!.code); assertNull(f.journal.read()!!.relationship)
        }
    }
    @Test fun `double confirm and cancellation preserve one attempted command for restart`() = runBlocking {
        val f = ReferralFixture(); val gate = CompletableDeferred<Unit>(); f.api.onPost(ReferralRepository.USE) { gate.await(); f.response("KEEP-AB234") }
        f.repository.review("KEEP-AB234"); val review = f.repository.state.value.review!!
        val job = launch { f.repository.confirm(review) }; yield(); f.repository.confirm(review); assertEquals(1, f.api.posts.size)
        job.cancelAndJoin(); assertEquals("KEEP-AB234", f.journal.read()!!.code); assertNull(f.journal.read()!!.relationship)
    }
    @Test fun `leaving during preflight invalidates approval before submission`() = runBlocking {
        val f = ReferralFixture(); f.repository.review("KEEP-AB234"); val review = f.repository.state.value.review!!
        val gate = CompletableDeferred<Unit>(); f.api.onGet(ReferralRepository.STATUS) { gate.await(); f.status() }
        val job = launch { f.repository.confirm(review) }; yield(); f.repository.dismiss(); gate.complete(Unit); job.join()
        assertTrue(f.api.posts.isEmpty()); assertNull(f.journal.read())
    }
}
