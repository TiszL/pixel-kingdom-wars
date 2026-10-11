package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class FeedbackIssuesTest {
    private val issueId = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    private val reportId = "c310a4a4-d7b5-424a-b8f8-cd77d01114a3"
    private val messageId = "79e4fc02-6d61-4578-b7d3-ac7b32dd6a03"
    private val cfg = FeedbackBounds(listOf("bug", "idea"), 80, 10, 2000, 2000, 2, 384, 120, 2, 100, 100, 64, 4096)
    private fun issue(id: String = issueId, status: String = "open", count: Int = 4, summary: String = "The current published summary") = json("""{
        "id":"$id","title":"Known problem","summary":${JsonPrimitive(summary)},"category":"bug","status":"$status","workaround":"Try reloading","fixedRelease":null,"affectedPlayerCount":$count}""")
    private fun receipt(reused: Boolean = false, recurrence: Boolean = false) = json("""{"reportId":"$reportId","messageId":${if (reused) "\"$messageId\"" else "null"},
        "reused":$reused,"recurrence":$recurrence,"issueRevision":3,"basePoints":0,"dailyRemaining":${if (reused) "null" else "7"}}""")
    private inner class Fixture(val disk: MemoryStore = MemoryStore(), build: String = "a".repeat(40)) {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        var upload: suspend (String) -> JsonObject = { error("Unexpected upload $it") }
        val client = object : ApiClient by api {
            override suspend fun upload(path: String, method: String, bytes: ByteArray, contentType: String): JsonObject { assertEquals("POST", method); return upload(path) }
        }
        val outbox = FeedbackOutbox(disk, WALLET, session.origin)
        val repo = LiveFeedbackRepository(session, holder, client, outbox, { cfg }, issueBounds = { FeedbackIssueBounds(160, 2, 250) }, nativeBuild = build)
        var currentIssue = issue()
        init {
            api.onGet("/tester/issues") { json("""{"issues":[$currentIssue]}""") }
            api.onGet("/tester/issues/$issueId") { currentIssue }
            api.onGet("/tester/feedback/page") { json("""{"feedback":[],"nextCursor":null}""") }
            api.onPost("/tester/issues/$issueId/confirm") { currentIssue }
            api.onPost("/tester/issues/$issueId/evidence") { receipt() }
        }
    }
    @Test fun `known issue search sends only canonical bounded filters and does not create reports`(): Unit = runBlocking {
        val f = Fixture(); f.repo.searchIssues("  crash  ", "bug")
        assertEquals(mapOf("query" to "crash", "category" to "bug"), f.api.gets.single().second)
        assertEquals(1, f.repo.state.value.issues.size); assertTrue(f.api.posts.isEmpty()); assertNull(f.outbox.read())
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.searchIssues("x".repeat(161), "bug") } }
        assertEquals(1, f.api.gets.size)
    }
    // The search runs while the player types the title. `busy` disables the form's fields, and a disabled
    // field drops focus, closes the keyboard and loses the characters typed meanwhile (0.5.4 on phones).
    @Test fun `known issue search while typing never marks the form busy or blocks sending the report`(): Unit = runBlocking {
        val f = Fixture(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.api.onGet("/tester/issues") { started.complete(Unit); finish.await(); json("""{"issues":[${issue()}]}""") }
        f.api.onPost("/tester/feedback") { json("""{"id":"$reportId","basePoints":0,"dailyRemaining":7}""") }
        val search = launch { f.repo.searchIssues("crash", "bug") }; started.await()
        assertFalse(f.repo.state.value.busy); assertTrue(f.repo.state.value.searching)
        f.repo.submit("bug", "Crash on load", "Enough detail for a report"); assertEquals("/tester/feedback", f.api.posts.single().first)
        finish.complete(Unit); search.join()
        assertFalse(f.repo.state.value.searching); assertFalse(f.repo.state.value.busy); assertEquals(1, f.repo.state.value.issues.size)
    }
    @Test fun `a search replaced by the next keystroke stops reporting itself as searching`(): Unit = runBlocking {
        val f = Fixture(); val started = CompletableDeferred<Unit>()
        f.api.onGet("/tester/issues") { started.complete(Unit); awaitCancellation() }
        val search = launch { f.repo.searchIssues("cra", "bug") }; started.await(); search.cancelAndJoin()
        assertFalse(f.repo.state.value.searching); assertFalse(f.repo.state.value.busy)
    }
    @Test fun `late search cannot restore issue choices after Back`(): Unit = runBlocking {
        val f = Fixture(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.api.onGet("/tester/issues") { started.complete(Unit); finish.await(); json("""{"issues":[${issue()}]}""") }
        val job = launch { f.repo.searchIssues("", "bug") }; started.await(); f.repo.closeIssue(); finish.complete(Unit); job.join()
        assertTrue(f.repo.state.value.issues.isEmpty())
    }
    @Test fun `merged issue GET requires review of canonical summary before POST`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); val consent = requireNotNull(f.repo.state.value.selectedIssue)
        f.currentIssue = issue(BASE_ID)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.confirmIssue(consent) } }
        assertEquals(BASE_ID, f.repo.state.value.selectedIssue!!.id); assertTrue(f.api.posts.isEmpty()); assertNull(f.outbox.read())
    }
    @Test fun `description change refuses prior consent but another affected count does not`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); val consent = f.repo.state.value.selectedIssue!!
        f.currentIssue = issue(summary = "A different problem")
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.confirmIssue(consent) } }; assertTrue(f.api.posts.isEmpty())
        f.currentIssue = issue(count = 5); f.repo.openIssue(issueId); f.repo.confirmIssue(consent)
        assertTrue(f.repo.state.value.confirmedIssues.contains(issueId)); assertEquals(JsonObject(emptyMap()), f.api.posts.single().second)
    }
    @Test fun `confirmation freezes original issue and never attributes aggregate count as receipt`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); f.api.onPost("/tester/issues/$issueId/confirm") { body ->
            assertTrue(body.isEmpty()); assertEquals(issueId, f.outbox.read()!!.issue!!.id); assertTrue(f.outbox.read()!!.attempted); throw IOException("lost")
        }
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmIssue(f.repo.state.value.selectedIssue!!) } }
        val restored = Fixture(f.disk); restored.currentIssue = issue(count = 10); restored.repo.searchIssues("", "bug")
        assertNotNull(restored.outbox.read()); assertTrue(restored.repo.state.value.confirmedIssues.isEmpty()); assertTrue(restored.api.posts.isEmpty())
        restored.repo.retry(); assertEquals(f.api.posts.single(), restored.api.posts.single()); assertTrue(restored.repo.state.value.confirmedIssues.contains(issueId))
    }
    @Test fun `merged confirmation retry stops original route without claiming personal attribution`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); f.api.onPost("/tester/issues/$issueId/confirm") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmIssue(f.repo.state.value.selectedIssue!!) } }
        f.api.onPost("/tester/issues/$issueId/confirm") { throw ApiException(409, "FEEDBACK_ISSUE_MERGED", "Merged") }; f.repo.retry()
        assertNull(f.outbox.read()); assertTrue(f.repo.state.value.confirmedIssues.isEmpty()); assertTrue(f.repo.state.value.notice!!.contains("may have been recorded"))
        assertTrue(f.api.posts.all { it.first == "/tester/issues/$issueId/confirm" })
    }
    @Test fun `fixed issue demands explicit recurrence before evidence or persistence`(): Unit = runBlocking {
        val f = Fixture(); f.currentIssue = issue(status = "fixed"); f.repo.openIssue(issueId)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.evidence(f.repo.state.value.selectedIssue!!, "Evidence", "This happened again", false) } }
        assertNull(f.outbox.read()); assertTrue(f.api.posts.isEmpty())
        f.api.onPost("/tester/issues/$issueId/evidence") { body -> assertEquals("recurrence", body.string("mode")); receipt(recurrence = true) }
        f.repo.evidence(f.repo.state.value.selectedIssue!!, "Evidence", "This happened again", true)
        assertTrue(f.repo.state.value.notice!!.contains("recurrence report"))
    }
    @Test fun `active evidence receipt distinguishes existing report from a newly created report`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); f.api.onPost("/tester/issues/$issueId/evidence") { body ->
            val saved = f.outbox.read()!!; assertEquals(saved.requestId, body.string("requestId")); assertEquals("evidence", body.string("mode"))
            assertEquals(BASE_ID, body.getValue("context").jsonObject.string("baseId")); assertFalse(body.containsKey("category")); receipt(reused = true)
                .also { assertEquals("a".repeat(40), saved.context.string("build")); assertEquals("feedback", saved.context.string("screen")) }
        }
        f.repo.evidence(f.repo.state.value.selectedIssue!!, "Private details", "My additional information", false, BASE_ID)
        assertTrue(f.repo.state.value.notice!!.contains("existing report")); assertNull(f.outbox.read())
    }
    @Test fun `unknown evidence keeps original issue mode context and UUID even after issue changes`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); f.api.onPost("/tester/issues/$issueId/evidence") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.evidence(f.repo.state.value.selectedIssue!!, "Evidence", "Private details here", false, BASE_ID) } }
        val restored = Fixture(f.disk, build = "b".repeat(40)); restored.currentIssue = issue(BASE_ID, "fixed")
        restored.repo.refresh(); assertTrue(restored.api.posts.isEmpty()); restored.repo.retry()
        assertEquals(f.api.posts.single(), restored.api.posts.single()); assertFalse(restored.api.gets.any { it.first.startsWith("/tester/issues/") })
        assertEquals("a".repeat(40), restored.api.posts.single().second.getValue("context").jsonObject.string("build"))
    }
    @Test fun `evidence acknowledgement survives offline hydration and repeats no POST`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); f.api.onGet("/tester/feedback/page") { throw IOException("offline") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.evidence(f.repo.state.value.selectedIssue!!, "Evidence", "Private details here", false) } }
        assertEquals(reportId, f.outbox.read()!!.evidenceReceipt!!.reportId)
        val restored = Fixture(f.disk); restored.repo.retry(); assertTrue(restored.api.posts.isEmpty()); assertNull(restored.outbox.read())
    }
    @Test fun `evidence terminal removed receipt retires only the saved exact request`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); f.api.onPost("/tester/issues/$issueId/evidence") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.evidence(f.repo.state.value.selectedIssue!!, "Evidence", "Private details here", false) } }
        f.api.onPost("/tester/issues/$issueId/evidence") { throw ApiException(409, "FEEDBACK_REPORT_TRASHED", "Removed") }; f.repo.retry()
        assertNull(f.outbox.read()); assertTrue(f.repo.state.value.notice!!.contains("was removed"))
    }
    @Test fun `identity supersession after confirmation cannot mark the next account affected`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); f.api.onPost("/tester/issues/$issueId/confirm") { signedIn(f.holder, "other-wallet"); issue() }
        assertThrows(CancellationException::class.java) { runBlocking { f.repo.confirmIssue(f.repo.state.value.selectedIssue!!) } }
        assertNotNull(f.outbox.read()); assertTrue(f.repo.state.value.confirmedIssues.isEmpty())
    }
    @Test fun `evidence reuses selected description after suggestion search changes`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId); val chosen = f.repo.state.value.selectedIssue!!
        f.repo.searchIssues("New report title", "bug"); assertNull(f.repo.state.value.selectedIssue)
        f.repo.evidence(chosen, "New report title", "Private details here", false); assertNull(f.outbox.read())
    }
    @Test fun `evidence screenshots attach to server returned existing private report not public issue`(): Unit = runBlocking {
        val f = Fixture(); f.repo.openIssue(issueId)
        f.api.onPost("/tester/issues/$issueId/evidence") { receipt(reused = true) }
        val attachment = json("""{"id":"$BASE_ID","width":1,"height":1,"byteLength":12,"contentType":"image/webp","expired":false}""")
        f.upload = { path ->
            assertTrue(path.startsWith("/tester/feedback/$reportId/screenshots/"))
            assertTrue(f.outbox.read()!!.evidenceReceipt!!.reused); attachment
        }
        f.api.onPost("/tester/feedback/$reportId/replies") { body ->
            assertEquals("", body.string("body")); assertEquals(BASE_ID, body.getValue("attachmentIds").jsonArray.single().jsonPrimitive.content)
            json("""{"id":"$messageId","revision":4,"body":"","kind":"reply","visibility":"reporter","authorRole":"reporter","createdAt":"2026-09-12T00:00:00Z","attachments":[$attachment]}""")
        }
        f.repo.evidence(f.repo.state.value.selectedIssue!!, "Private evidence", "My details here", false, images = listOf(FeedbackImage(byteArrayOf(1), "image/png")))
        assertNull(f.outbox.read()); assertTrue(f.repo.state.value.notice!!.contains("existing report"))
    }
}
