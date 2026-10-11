package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PlaytestCampaignRepositoryTest {
    private val founding = "founding-kingdoms"
    private val rewarded = "rewarded-playtest"
    private val reportId = "e6a7e153-ddaf-43c8-ab97-f05ef927ca74"
    private val stamp = "2026-09-12T00:00:00.000Z"
    private val url = "https://video.example/post"
    private val cfg = PlaytestBounds(founding, rewarded, "Founding", "Rewarded", 14, 30000, 3, 25, 1, mapOf("feedback" to 40))
    private val feedbackCfg = FeedbackBounds(listOf("bug"), 80, 10, 2000, 2000, 2, 384, 120, 8, 100, 100, 64, 4096)
    private fun participant(id: String = rewarded, wallet: String = WALLET) = json("""{"campaignId":"$id","wallet":"$wallet","joinedAt":"$stamp","disqualifiedAt":null,"disqualificationReason":null,"bonusAt":null}""")
    private fun submission(key: String, kind: String = "video", link: String? = url, report: String? = null, id: String = rewarded, wallet: String = WALLET) = json("""{
        "id":"$wallet:$key","campaignId":"$id","wallet":"$wallet","kind":"$kind","url":${link?.let { JsonPrimitive(it).toString() } ?: "null"},"reportId":${report?.let { JsonPrimitive(it).toString() } ?: "null"},"createdAt":"$stamp"}""")
    private fun campaign(id: String = rewarded, phase: String = "running", joined: Boolean = false, submissions: List<JsonObject> = emptyList(), revision: Int = 1) = json("""{
        "id":"$id","kind":"${if (id == founding) "founding" else "rewarded"}","name":"Test campaign","phase":"$phase","startAt":"$stamp","endAt":"2026-09-26T00:00:00.000Z",
        "registrationOpen":true,"revision":$revision,"reconciledAt":null,"snapshotAt":null,"checkpoint":null,"spots":null,"stale":false,"measurementSince":null,
        "participant":${if (joined) participant(id) else "null"},"standings":[],"founders":[],"winners":[],"prizes":[],"ownSubmissions":[${submissions.joinToString(",")}] }""")
    private fun reportPage(cursor: String? = null) = json("""{"feedback":[{"id":"$reportId","category":"bug","title":"Report","body":"Something went wrong","status":"new",
        "importance":null,"points":0,"createdAt":"$stamp","fixedAt":null,"fixedRef":null}],"nextCursor":${cursor?.let { JsonPrimitive(it).toString() } ?: "null"}}""")
    private class GateStore : SecretStore {
        val delegate = MemoryStore()
        var onRead: (() -> Unit)? = null
        var onWrite: ((Int) -> Unit)? = null
        var writes = 0
        override fun read(): String? { onRead?.invoke(); return delegate.read() }
        override fun write(value: String) { delegate.write(value); onWrite?.invoke(++writes) }
        override fun clear() { delegate.clear() }
    }
    private inner class Fixture(val disk: SecretStore = MemoryStore(), feedback: FeedbackBounds = feedbackCfg) {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val outbox = CampaignOutbox(disk, WALLET, session.origin)
        val repo = LivePlaytestRepository(session, holder, api, outbox, { cfg }, { feedback })
        var latest = campaign()
        init {
            api.onGet("/playtest/campaigns/$rewarded/me") { latest }
            api.onGet("/playtest/campaigns/$founding/me") { campaign(founding) }
            api.onGet("/tester/feedback/page") { reportPage() }
            api.onPost("/playtest/campaigns/$rewarded/participate") { assertTrue(it.isEmpty()); latest = campaign(joined = true); participant() }
            api.onPost("/playtest/campaigns/$rewarded/submissions") { body ->
                val receipt = submission(body.string("requestId")!!, body.string("kind")!!, body.string("url"), body.string("reportId"))
                latest = campaign(joined = true, submissions = listOf(receipt)); receipt
            }
        }
        suspend fun open(joined: Boolean = false) { latest = campaign(joined = joined); repo.open(rewarded) }
    }
    @Test fun `opening and foreground refresh never submit participation or infer awards`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(founding); f.repo.refresh()
        assertTrue(f.api.posts.isEmpty()); assertNull(f.outbox.read()); assertNull(f.repo.state.value.campaign!!.participant)
        assertFalse(f.repo.state.value.campaign!!.canEnter); assertTrue(f.repo.state.value.campaign!!.winners.isEmpty())
    }
    @Test fun `participation journals before empty POST and retires only server membership proof`(): Unit = runBlocking {
        val f = Fixture(); f.open()
        f.api.onPost("/playtest/campaigns/$rewarded/participate") { body ->
            assertTrue(body.isEmpty()); val saved = f.outbox.read()!!; assertTrue(saved.attempted); assertEquals(rewarded, saved.campaignId)
            f.latest = campaign(joined = true); participant()
        }
        f.repo.participate(f.repo.state.value.campaign!!)
        assertNull(f.outbox.read()); assertEquals(WALLET, f.repo.state.value.campaign!!.participant!!.wallet)
        assertTrue(f.repo.state.value.notice!!.contains("Participation is recorded"))
    }
    @Test fun `unknown participation survives process loss and matching membership recovers through GET only`(): Unit = runBlocking {
        val f = Fixture(); f.open(); f.api.onPost("/playtest/campaigns/$rewarded/participate") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.participate(f.repo.state.value.campaign!!) } }
        val restored = Fixture(f.disk); restored.latest = campaign(joined = true); restored.repo.open(rewarded)
        assertNull(restored.outbox.read()); assertTrue(restored.api.posts.isEmpty()); assertNotNull(restored.repo.state.value.campaign!!.participant)
    }
    @Test fun `first definitive refusal permits explicit fresh key but uncertainty keeps original after refusal`(): Unit = runBlocking {
        val f = Fixture(); f.open(); val keys = mutableListOf<String>()
        f.api.onPost("/playtest/campaigns/$rewarded/participate") { keys += f.outbox.read()!!.requestId; throw ApiException(409, null, "closed") }
        assertThrows(ApiException::class.java) { runBlocking { f.repo.participate(f.repo.state.value.campaign!!) } }; assertNull(f.outbox.read())
        f.api.onPost("/playtest/campaigns/$rewarded/participate") { keys += f.outbox.read()!!.requestId; throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.participate(f.repo.state.value.campaign!!) } }; assertNotEquals(keys[0], keys[1])
        f.api.onPost("/playtest/campaigns/$rewarded/participate") { throw ApiException(409, null, "closed") }
        assertThrows(ApiException::class.java) { runBlocking { f.repo.retry() } }; assertEquals(keys[1], f.outbox.read()!!.requestId)
    }
    @Test fun `saved video URL and key stay exact through unknown replay after campaign closes`(): Unit = runBlocking {
        val f = Fixture(); f.open(true); f.api.onPost("/playtest/campaigns/$rewarded/submissions") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submitVideo(f.repo.state.value.campaign!!, "  $url  ") } }
        val saved = f.outbox.read()!!; assertEquals(url, saved.url)
        val restored = Fixture(f.disk); restored.latest = campaign(phase = "ended", joined = true); restored.repo.open(rewarded)
        restored.api.onPost("/playtest/campaigns/$rewarded/submissions") {
            val receipt = submission(saved.requestId); restored.latest = campaign(phase = "ended", joined = true, submissions = listOf(receipt)); receipt
        }
        restored.repo.retry(); assertEquals(f.api.posts.single(), restored.api.posts.single()); assertNull(restored.outbox.read())
    }
    @Test fun `same URL with a different receipt key is not delivery proof`(): Unit = runBlocking {
        val f = Fixture(); f.open(true); f.api.onPost("/playtest/campaigns/$rewarded/submissions") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submitVideo(f.repo.state.value.campaign!!, url) } }
        val saved = f.outbox.read()!!; f.latest = campaign(joined = true, submissions = listOf(submission("someone-else-key")))
        f.repo.checkPending(); assertEquals(saved, f.outbox.read()); assertFalse(f.repo.state.value.notice!!.contains("is recorded"))
        assertEquals(1, f.api.posts.size)
    }
    @Test fun `exact submission GET receipt recovers process death without another POST`(): Unit = runBlocking {
        val f = Fixture(); f.open(true); f.api.onPost("/playtest/campaigns/$rewarded/submissions") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submitVideo(f.repo.state.value.campaign!!, url) } }
        val saved = f.outbox.read()!!; val restored = Fixture(f.disk)
        restored.latest = campaign(joined = true, submissions = listOf(submission(saved.requestId))); restored.repo.checkPending()
        assertNull(restored.outbox.read()); assertTrue(restored.api.posts.isEmpty()); assertNull(restored.repo.state.value.campaign)
    }
    @Test fun `POST acknowledgement is durable when hydration fails and retry performs GET only`(): Unit = runBlocking {
        val f = Fixture(); f.open(true)
        f.api.onPost("/playtest/campaigns/$rewarded/submissions") { body ->
            val receipt = submission(body.string("requestId")!!); f.latest = campaign(joined = true, submissions = listOf(receipt))
            f.api.onGet("/playtest/campaigns/$rewarded/me") { throw IOException("offline after acknowledgement") }; receipt
        }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submitVideo(f.repo.state.value.campaign!!, url) } }
        assertNotNull(f.outbox.read()!!.submissionReceipt)
        f.api.onGet("/playtest/campaigns/$rewarded/me") { f.latest }; f.repo.retry()
        assertEquals(1, f.api.posts.size); assertNull(f.outbox.read())
    }
    @Test fun `acknowledged request remains recoverable until latest campaign includes its exact receipt`(): Unit = runBlocking {
        val f = Fixture(); f.open(true)
        f.api.onPost("/playtest/campaigns/$rewarded/submissions") { submission(it.string("requestId")!!) }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.submitVideo(f.repo.state.value.campaign!!, url) } }
        val saved = f.outbox.read()!!; assertNotNull(saved.submissionReceipt)
        f.latest = campaign(joined = true, submissions = listOf(submission(saved.requestId))); f.repo.refresh()
        assertNull(f.outbox.read()); assertEquals(1, f.api.posts.size)
    }
    @Test fun `changed immutable fields in an exact-key receipt fail closed`(): Unit = runBlocking {
        val f = Fixture(); f.open(true); f.api.onPost("/playtest/campaigns/$rewarded/submissions") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submitVideo(f.repo.state.value.campaign!!, url) } }
        val saved = f.outbox.read()!!; f.latest = campaign(joined = true, submissions = listOf(submission(saved.requestId, link = "https://different.example/post")))
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repo.checkPending() } }; assertEquals(saved, f.outbox.read())
    }
    @Test fun `changed campaign revision requires new review before journaling or POST`(): Unit = runBlocking {
        val f = Fixture(); f.open(); val consent = f.repo.state.value.campaign!!; f.latest = campaign(revision = 2)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.participate(consent) } }
        assertEquals(2, f.repo.state.value.campaign!!.revision); assertNull(f.outbox.read()); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `captured campaign cannot retarget to a different selected campaign`(): Unit = runBlocking {
        val f = Fixture(); f.open(); val consent = f.repo.state.value.campaign!!; f.repo.open(founding)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.participate(consent) } }
        assertTrue(f.api.posts.isEmpty()); assertNull(f.outbox.read())
    }
    @Test fun `Back during preflight sends nothing and Back after acknowledgement keeps detail closed`(): Unit = runBlocking {
        for (afterPost in listOf(false, true)) {
            val f = Fixture(); f.open(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
            if (afterPost) f.api.onPost("/playtest/campaigns/$rewarded/participate") { started.complete(Unit); finish.await(); f.latest = campaign(joined = true); participant() }
            else f.api.onGet("/playtest/campaigns/$rewarded/me") { started.complete(Unit); finish.await(); f.latest }
            val job = launch { f.repo.participate(f.repo.state.value.campaign!!) }; started.await(); f.repo.close(); finish.complete(Unit); job.join()
            assertNull(f.repo.state.value.campaign); assertNull(f.repo.state.value.selectedId); assertNull(f.outbox.read())
            assertEquals(if (afterPost) 1 else 0, f.api.posts.size)
        }
    }
    @Test fun `late refusal after same-wallet identity replacement cannot clear a replacement journal`(): Unit = runBlocking {
        val f = Fixture(); f.open(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.api.onPost("/playtest/campaigns/$rewarded/participate") { started.complete(Unit); finish.await(); throw ApiException(409, null, "late refusal") }
        val job = launch { f.repo.participate(f.repo.state.value.campaign!!) }; started.await(); signedIn(f.holder)
        val original = f.outbox.read()!!; val replacement = original.copy(requestId = "da8ed87b-ce56-48d9-a9d8-729e3b58b08e", attempted = false)
        f.outbox.clear(original); f.outbox.create(replacement); finish.complete(Unit); job.join()
        assertTrue(job.isCancelled); assertEquals(replacement, f.outbox.read())
    }
    @Test fun `private participant or submission from another wallet cannot populate own state`(): Unit = runBlocking {
        val f = Fixture(); f.latest = JsonObject(campaign() + ("participant" to participant(wallet = "foreign")))
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repo.open(rewarded) } }; assertNull(f.repo.state.value.campaign)
    }
    @Test fun `report selection uses own paged reports and duplicate campaign entries are refused before POST`(): Unit = runBlocking {
        val f = Fixture(); f.open(true)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.submitReport(f.repo.state.value.campaign!!, reportId) } }
        f.repo.reports(); f.repo.submitReport(f.repo.state.value.campaign!!, reportId)
        assertEquals(reportId, f.api.posts.single().second.string("reportId")); assertNull(f.api.posts.single().second["url"])
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.submitReport(f.repo.state.value.campaign!!, reportId) } }; assertEquals(1, f.api.posts.size)
    }
    @Test fun `structural video validation rejects unsafe URLs without copying server length bound`(): Unit = runBlocking {
        val f = Fixture(); f.open(true)
        for (link in listOf("http://video.example/post", "https://user:password@video.example/post", "https://localhost/post")) {
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.submitVideo(f.repo.state.value.campaign!!, link) } }
        }
        assertTrue(f.api.posts.isEmpty()); assertNull(f.outbox.read()); assertEquals(url + "/".repeat(2500), campaignVideoUrl(url + "/".repeat(2500)))
    }
    @Test fun `report pages retain opaque cursor and reject repeated cursors`(): Unit = runBlocking {
        val f = Fixture(); f.open(true); f.api.onGet("/tester/feedback/page") { reportPage("opaque-cursor") }; f.repo.reports()
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repo.reports(true) } }
        assertEquals("opaque-cursor", f.api.gets.last().second["cursor"]); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `installed campaign report picker sends canonical limit on first and subsequent pages`(): Unit = runBlocking {
        // Code24 sends the packed FEEDBACK_THREADS.pageSize; the reporter API must accept this existing query contract.
        val f = Fixture(feedback = feedbackCfg.copy(pageSize = 50)); f.open(true)
        f.api.onGet("/tester/feedback/page") { query ->
            assertEquals(mapOf("limit" to "50"), query); reportPage("opaque-cursor")
        }
        f.repo.reports()
        f.api.onGet("/tester/feedback/page") { query ->
            assertEquals(mapOf("limit" to "50", "cursor" to "opaque-cursor"), query); reportPage()
        }
        f.repo.reports(true)
        assertEquals(reportId, f.repo.state.value.reports!!.feedback.single().id)
        assertNull(f.repo.state.value.reports!!.nextCursor); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `Back during initial journal or attempted marker write preserves unsent certainty and sends nothing`(): Unit = runBlocking {
        for (blockedWrite in listOf(1, 2)) {
            val store = GateStore(); val f = Fixture(store); f.open()
            val started = CompletableDeferred<Unit>(); val release = CountDownLatch(1)
            store.onWrite = { number -> if (number == blockedWrite) { started.complete(Unit); check(release.await(5, TimeUnit.SECONDS)) } }
            val job = launch { f.repo.participate(f.repo.state.value.campaign!!) }
            started.await(); f.repo.close(); release.countDown(); job.join()
            assertTrue(job.isCancelled); assertTrue(f.api.posts.isEmpty()); assertFalse(f.outbox.read()!!.attempted)
        }
    }
    @Test fun `Back during retry journal read or marker write preserves earlier uncertainty without another POST`(): Unit = runBlocking {
        for (blockRead in listOf(true, false)) {
            val store = GateStore(); val f = Fixture(store); f.open()
            f.api.onPost("/playtest/campaigns/$rewarded/participate") { throw IOException("lost") }
            assertThrows(IOException::class.java) { runBlocking { f.repo.participate(f.repo.state.value.campaign!!) } }
            val saved = f.outbox.read()!!; val started = CompletableDeferred<Unit>(); val release = CountDownLatch(1)
            fun block() { started.complete(Unit); check(release.await(5, TimeUnit.SECONDS)) }
            if (blockRead) store.onRead = { store.onRead = null; block() }
            else { val next = store.writes + 1; store.onWrite = { number -> if (number == next) block() } }
            val job = launch { f.repo.retry() }; started.await(); f.repo.close(); release.countDown(); job.join()
            assertTrue(job.isCancelled); assertEquals(1, f.api.posts.size); assertEquals(saved, f.outbox.read()); assertTrue(f.outbox.read()!!.attempted)
        }
    }
    @Test fun `queued retry cannot adopt a new view ticket after Back`(): Unit = runBlocking {
        val f = Fixture(); f.open(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.api.onPost("/playtest/campaigns/$rewarded/participate") { started.complete(Unit); finish.await(); throw IOException("lost") }
        val first = launch { runCatching { f.repo.participate(f.repo.state.value.campaign!!) } }; started.await()
        val queued = launch(start = CoroutineStart.UNDISPATCHED) { f.repo.retry() }
        f.repo.close(); finish.complete(Unit); first.join(); queued.join()
        assertTrue(queued.isCancelled); assertEquals(1, f.api.posts.size); assertTrue(f.outbox.read()!!.attempted)
    }
    // The screen polls standings every pollMs (30 s) while open. A field that follows busy is disabled
    // on every poll, which drops focus, closes the keyboard and discards what a participant is typing.
    @Test fun `standings poll in flight holds campaign actions but never closes the video URL field`(): Unit = runBlocking {
        val f = Fixture(); f.open(true); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        assertTrue(f.repo.state.value.canType); assertTrue(f.repo.state.value.canAct)
        f.api.onGet("/playtest/campaigns/$rewarded/me") { started.complete(Unit); finish.await(); f.latest }
        val poll = launch { f.repo.refresh() }; started.await()
        assertTrue(f.repo.state.value.busy); assertFalse(f.repo.state.value.canAct)
        assertTrue(f.repo.state.value.canType)
        finish.complete(Unit); poll.join()
        assertTrue(f.repo.state.value.canType); assertTrue(f.repo.state.value.canAct)
        // A saved request must be resolved before another is written: that, not busy, closes the field.
        f.api.onPost("/playtest/campaigns/$rewarded/submissions") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submitVideo(f.repo.state.value.campaign!!, url) } }
        assertFalse(f.repo.state.value.busy); assertFalse(f.repo.state.value.canType); assertFalse(f.repo.state.value.canAct)
    }
}
