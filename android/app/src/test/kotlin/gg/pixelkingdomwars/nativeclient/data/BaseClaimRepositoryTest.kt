package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

private const val CLAIM_KEY = "00000000-0000-4000-8000-000000000001"
private const val CLAIM_DEED = "33333333333333333333333333333333"
private const val CLAIM_PATH = "/base/claims/v1"
private class ClaimFixture(val disk: SecretStore = MemoryStore()) {
    val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
    val journal = BaseClaimJournal(disk, WALLET, session.origin, "devnet")
    var enabled = true; var candidate = BaseClaimCandidate(BASE_ID, CLAIM_DEED)
    var hasCandidate = true; var serverReceipt: JsonObject? = null; var tombstone = false; var hydrated = 0
    var hydrate: suspend () -> Unit = {}
    val repository = BaseClaimRepository(session, holder, api, journal, {
        assertNotNull("Receipt must be durable before account hydration", journal.read()!!.receipt)
        hydrated++; hydrate()
    }, { CLAIM_KEY })
    fun request() = BaseClaimRequest(CLAIM_KEY, BASE_ID, CLAIM_DEED)
    fun offer() = buildJsonObject {
        put("version", 1); put("wallet", WALLET); put("enabled", enabled)
        put("reason", if (!enabled) "unavailable" else if (hasCandidate) "ok" else "none")
        put("candidate", if (enabled && hasCandidate) buildJsonObject { put("baseId", candidate.baseId); put("deedAssetId", candidate.deedAssetId) } else JsonNull)
    }
    fun receipt(request: BaseClaimRequest = request(), outcome: String = "claimed", active: Boolean = false) = buildJsonObject {
        put("version", 1); put("actor", WALLET); put("idempotencyKey", request.idempotencyKey); put("request", request.json())
        put("outcome", outcome); put("active", active); put("transferId", if (outcome == "claimed") JsonPrimitive(CLAIM_KEY) else JsonNull)
        put("fromWallet", if (outcome == "claimed") JsonPrimitive("2".repeat(32)) else JsonNull)
        put("ownership", buildJsonObject { put("owner", WALLET); put("collection", "4".repeat(32)); put("slot", "42") })
        put("createdAt", "2026-09-13T00:00:00.000Z")
    }
    fun status() = buildJsonObject { put("version", 1); put("wallet", WALLET); put("idempotencyKey", CLAIM_KEY); put("enabled", enabled); put("receipt", serverReceipt ?: JsonNull) }
    fun cancellation(cancelled: Boolean = serverReceipt == null) = JsonObject(status() - "enabled" + ("cancelled" to JsonPrimitive(cancelled)))
    init {
        api.onGet("$CLAIM_PATH/claimable") { offer() }
        api.onGet("$CLAIM_PATH/$CLAIM_KEY") { status() }
        api.onPost(CLAIM_PATH) { body ->
            assertEquals("Exact intent precedes POST", body, journal.read()!!.request.json())
            check(!tombstone); serverReceipt = receipt(BaseClaimRequest.from(body)); serverReceipt!!
        }
        api.onPost("$CLAIM_PATH/$CLAIM_KEY/cancel-unaccepted") { body ->
            assertTrue(body.isEmpty()); if (serverReceipt == null) tombstone = true; cancellation()
        }
    }
    suspend fun submit() { repository.review(); repository.state.value.review?.let { repository.confirm(it) } }
    suspend fun loseReply(accepted: Boolean = false) {
        api.onPost(CLAIM_PATH) { if (accepted) serverReceipt = receipt(); throw IOException("lost response") }; submit()
    }
}

class BaseClaimRepositoryTest {
    @Test fun `foreground and dismissed review never transfer or abandon a base`() = runBlocking {
        val f = ClaimFixture(); f.repository.refresh(); f.repository.review(); f.repository.dismiss(); f.repository.refresh()
        assertTrue(f.api.posts.isEmpty()); assertNull(f.journal.read()); assertEquals(0, f.hydrated)
    }
    @Test fun `one exact request precedes POST and acceptance precedes identity hydration`() = runBlocking {
        val f = ClaimFixture(); f.submit()
        assertEquals(listOf(CLAIM_PATH to f.request().json()), f.api.posts)
        assertEquals(f.request(), f.journal.read()!!.receipt!!.request); assertTrue(f.repository.state.value.hydrated)
        assertEquals(1, f.hydrated); assertFalse(f.journal.read()!!.receipt!!.active)
    }
    @Test fun `changed candidate between review and confirmation cannot retarget consent`() = runBlocking {
        val f = ClaimFixture(); f.repository.review(); val review = f.repository.state.value.review!!
        f.candidate = f.candidate.copy(deedAssetId = "5".repeat(32)); f.repository.confirm(review)
        assertNull(f.journal.read()); assertTrue(f.api.posts.isEmpty()); assertNotNull(f.repository.state.value.error)
    }
    @Test fun `missing or disabled contract has no legacy claim fallback`() = runBlocking {
        for (missing in listOf(false, true)) {
            val f = ClaimFixture(); f.enabled = false
            if (missing) f.api.onGet("$CLAIM_PATH/claimable") { throw ApiException(404, null, "old server") }
            f.repository.refresh(); f.submit(); assertTrue(f.api.posts.isEmpty()); assertNull(f.journal.read())
        }
    }
    @Test fun `lost accepted reply recovers original receipt by GET after restart and deed loss`() = runBlocking {
        val disk = MemoryStore(); val first = ClaimFixture(disk); first.loseReply(accepted = true)
        val second = ClaimFixture(disk); second.enabled = false; second.hasCandidate = false; second.serverReceipt = first.serverReceipt
        second.repository.refresh()
        assertEquals(listOf("$CLAIM_PATH/$CLAIM_KEY"), second.api.gets.map { it.first }); assertTrue(second.api.posts.isEmpty())
        assertEquals(CLAIM_DEED, second.journal.read()!!.receipt!!.request.deedAssetId)
        assertFalse(second.journal.read()!!.receipt!!.active); assertTrue(second.repository.state.value.hydrated)
    }
    @Test fun `empty status cannot unlock Finish replacement or infer cancellation`() = runBlocking {
        val f = ClaimFixture(); f.loseReply(); val before = f.journal.read()
        repeat(3) { f.repository.refresh() }; f.repository.finish(); f.repository.review()
        assertEquals(before, f.journal.read()); assertEquals(1, f.api.posts.size); assertEquals(0, f.hydrated)
        assertFalse(f.journal.read()!!.cancelled)
    }
    @Test fun `explicit retry first reads status then sends only the same original body`() = runBlocking {
        val f = ClaimFixture(); val accept = f.api.postHandlers.getValue(CLAIM_PATH); f.loseReply()
        f.candidate = BaseClaimCandidate(CLAIM_KEY, "5".repeat(32)); f.api.onPost(CLAIM_PATH, accept)
        f.repository.retry()
        assertEquals(2, f.api.posts.size); assertEquals(f.api.posts[0], f.api.posts[1]); assertEquals(CLAIM_DEED, f.journal.read()!!.receipt!!.request.deedAssetId)
    }
    @Test fun `retry discovers prior acceptance without POST even when new claims are disabled`() = runBlocking {
        val f = ClaimFixture(); f.loseReply(true); f.enabled = false; f.repository.retry()
        assertEquals(1, f.api.posts.size); assertNotNull(f.journal.read()!!.receipt); assertTrue(f.repository.state.value.hydrated)
    }
    @Test fun `disabled unknown retry stays pending but explicit cancellation still works`() = runBlocking {
        val f = ClaimFixture(); f.loseReply(); f.enabled = false; f.repository.retry()
        assertEquals(1, f.api.posts.size); f.repository.cancel(); assertTrue(f.journal.read()!!.cancelled); assertTrue(f.tombstone)
        f.repository.retry(); f.repository.refresh(); assertEquals(2, f.api.posts.size)
        f.repository.finish(); assertNull(f.journal.read())
    }
    @Test fun `late cancellation returns accepted transfer and never labels it cancelled`() = runBlocking {
        val f = ClaimFixture(); f.loseReply(true); f.repository.cancel()
        assertFalse(f.journal.read()!!.cancelled); assertNotNull(f.journal.read()!!.receipt); assertTrue(f.repository.state.value.hydrated)
        assertEquals(2, f.api.posts.size); f.repository.finish(); assertNull(f.journal.read())
    }
    @Test fun `lost cancellation reply and null GET remain unknown until explicit cancellation retry`() = runBlocking {
        val f = ClaimFixture(); f.loseReply(); val close = "$CLAIM_PATH/$CLAIM_KEY/cancel-unaccepted"
        val accept = f.api.postHandlers.getValue(close)
        f.api.onPost(close) { f.tombstone = true; throw IOException("lost cancellation") }; f.repository.cancel(); f.repository.refresh()
        assertFalse(f.journal.read()!!.cancelled); f.repository.finish(); assertNotNull(f.journal.read())
        f.api.onPost(close, accept); f.repository.cancel(); assertTrue(f.journal.read()!!.cancelled)
    }
    @Test fun `malformed or foreign cancellation proof cannot clear the original pending intent`() = runBlocking {
        for (change in listOf("wallet" to JsonPrimitive("2".repeat(32)), "cancelled" to JsonPrimitive(false))) {
            val f = ClaimFixture(); f.loseReply(); val saved = f.journal.read()
            f.api.onPost("$CLAIM_PATH/$CLAIM_KEY/cancel-unaccepted") { JsonObject(f.cancellation() + change) }
            f.repository.cancel(); assertEquals(saved, f.journal.read()); assertNotNull(f.repository.state.value.error)
        }
    }
    @Test fun `accepted proof survives failed hydration and must hydrate before Finish`() = runBlocking {
        val f = ClaimFixture(); f.hydrate = { throw IOException("directory unavailable") }; f.submit()
        val saved = f.journal.read(); assertNotNull(saved!!.receipt); assertFalse(f.repository.state.value.hydrated)
        f.repository.finish(); assertEquals(saved, f.journal.read())
        f.hydrate = {}; f.repository.refresh(); assertTrue(f.repository.state.value.hydrated); assertEquals(1, f.api.posts.size)
    }
    @Test fun `another base deed actor or transfer receipt is rejected without replacing durable proof`() = runBlocking {
        for (change in listOf("request" to ClaimFixture().request().copy(deedAssetId = "5".repeat(32)).json(),
            "actor" to JsonPrimitive("2".repeat(32)), "idempotencyKey" to JsonPrimitive(BASE_ID))) {
            val f = ClaimFixture(); f.loseReply(); val saved = f.journal.read(); f.serverReceipt = JsonObject(f.receipt() + change)
            f.repository.refresh(); assertEquals(saved, f.journal.read()); assertEquals(0, f.hydrated)
        }
    }
    @Test fun `a vanished or changed immutable receipt cannot erase original acceptance after restart`() = runBlocking {
        val disk = MemoryStore(); val first = ClaimFixture(disk); first.submit(); val original = first.journal.read()
        for (receipt in listOf(null, JsonObject(first.receipt() + ("active" to JsonPrimitive(true))))) {
            val second = ClaimFixture(disk); second.serverReceipt = receipt; second.repository.refresh(); second.repository.finish()
            assertEquals(original, second.journal.read()); assertFalse(second.repository.state.value.hydrated)
        }
    }
    @Test fun `late response after same-wallet session replacement cannot publish accept or cancellation`() = runBlocking {
        for (cancelling in listOf(false, true)) {
            val f = ClaimFixture(); val gate = CompletableDeferred<Unit>()
            if (cancelling) f.loseReply() else f.repository.review()
            val path = if (cancelling) "$CLAIM_PATH/$CLAIM_KEY/cancel-unaccepted" else CLAIM_PATH
            f.api.onPost(path) { gate.await(); if (cancelling) f.cancellation() else f.receipt() }
            val job = launch { if (cancelling) f.repository.cancel() else f.repository.confirm(f.repository.state.value.review!!) }; yield()
            val before = f.journal.read(); signedIn(f.holder); gate.complete(Unit); job.join()
            assertEquals(before, f.journal.read()); assertEquals(0, f.hydrated)
        }
    }
    @Test fun `dismissal during a retry status read cannot authorize a later POST`() = runBlocking {
        val f = ClaimFixture(); f.loseReply(); val gate = CompletableDeferred<Unit>()
        f.api.onGet("$CLAIM_PATH/$CLAIM_KEY") { gate.await(); f.status() }
        val job = launch { f.repository.retry() }; yield(); f.repository.dismiss(); gate.complete(Unit); job.join()
        assertEquals(1, f.api.posts.size); assertNull(f.journal.read()!!.receipt)
    }
    @Test fun `concurrent confirmation and cancellation cannot create two POST owners`() = runBlocking {
        val f = ClaimFixture(); f.repository.review(); val review = f.repository.state.value.review!!; val gate = CompletableDeferred<Unit>()
        f.api.onPost(CLAIM_PATH) { gate.await(); f.receipt() }
        val job = launch { f.repository.confirm(review) }; yield()
        f.repository.confirm(review); f.repository.cancel(); f.repository.refresh(); assertEquals(1, f.api.posts.size)
        gate.complete(Unit); job.join(); assertNotNull(f.journal.read()!!.receipt)
    }
    @Test fun `corrupt or foreign scoped storage stays untouched and blocks every network request`() = runBlocking {
        val disk = MemoryStore(); val valid = ClaimFixture(disk); valid.journal.begin(valid.request()); val original = disk.value
        for (journal in listOf(BaseClaimJournal(disk, "2".repeat(32), valid.session.origin, "devnet"),
            BaseClaimJournal(disk, WALLET, "https://other.invalid", "devnet"), BaseClaimJournal(disk, WALLET, valid.session.origin, "mainnet-beta"))) {
            assertTrue(runCatching { journal.read() }.isFailure); assertEquals(original, disk.value)
        }
        disk.value = "corrupt"; val f = ClaimFixture(disk); f.repository.refresh(); f.submit(); f.repository.cancel()
        assertTrue(f.api.posts.isEmpty() && f.api.gets.isEmpty()); assertEquals("corrupt", disk.value); assertFalse(f.repository.state.value.loaded)
    }
    @Test fun `intent disk failure stops POST and receipt disk failure remains GET-recoverable`() = runBlocking {
        for (failAt in listOf(1, 2)) {
            val memory = MemoryStore(); var writes = 0
            val disk = object : SecretStore { override fun read() = memory.read(); override fun clear() = memory.clear()
                override fun write(value: String) { if (++writes == failAt) throw IOException("disk write"); memory.write(value) } }
            val f = ClaimFixture(disk); f.submit()
            assertEquals(if (failAt == 1) 0 else 1, f.api.posts.size)
            if (failAt == 2) { assertNull(f.journal.read()!!.receipt); f.repository.refresh(); assertNotNull(f.journal.read()!!.receipt) }
        }
    }
    @Test fun `acceptance racing the cancel request returns its receipt instead of a local tombstone`() = runBlocking {
        val f = ClaimFixture(); f.loseReply(); val gate = CompletableDeferred<Unit>()
        f.api.onPost("$CLAIM_PATH/$CLAIM_KEY/cancel-unaccepted") { gate.await(); f.cancellation() }
        val job = launch { f.repository.cancel() }; yield()
        f.serverReceipt = f.receipt(); gate.complete(Unit); job.join()
        assertNotNull(f.journal.read()!!.receipt); assertFalse(f.journal.read()!!.cancelled)
        assertTrue(f.repository.state.value.hydrated); assertEquals(2, f.api.posts.size)
    }
    @Test fun `identity changes during hydration retain durable acceptance without publishing completion`() = runBlocking {
        val f = ClaimFixture(); f.hydrate = { signedIn(f.holder) }
        val job = launch { f.submit() }; job.join()
        assertNotNull(f.journal.read()!!.receipt); assertFalse(f.repository.state.value.hydrated)
        assertEquals(1, f.api.posts.size)
    }
    @Test fun `journal cannot seal accepted proof or replace it with another immutable receipt`() = runBlocking {
        val f = ClaimFixture(); f.submit(); val original = f.journal.read()
        assertTrue(runCatching { f.journal.cancel(f.request()) }.isFailure)
        assertTrue(runCatching { f.journal.accept(BaseClaimReceipt.from(f.receipt(active = true))) }.isFailure)
        assertEquals(original, f.journal.read())
    }
}
