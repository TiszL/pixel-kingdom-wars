package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class FeedbackRepositoryTest {
    private val reportId = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    private val messageId = "c310a4a4-d7b5-424a-b8f8-cd77d01114a3"
    private val attachmentId = "79e4fc02-6d61-4578-b7d3-ac7b32dd6a03"
    private val cfg = FeedbackBounds(listOf("bug", "idea"), 80, 10, 2000, 2000, 2, 384, 120, 2, 100, 100, 64, 4096)
    private fun report(id: String = reportId, locked: Boolean = false) = json("""{"id":"$id","category":"bug","title":"Bug report","body":"Enough detail for a report","status":"new","importance":null,"points":0,"createdAt":"2026-09-12T00:00:00Z","fixedAt":null,"fixedRef":null,"locked":$locked,"closed":false,"unread":true}""")
    private fun attachment(id: String = attachmentId) = json("""{"id":"$id","width":32,"height":32,"byteLength":12,"contentType":"image/webp","expired":false}""")
    private fun message(revision: Int = 1, id: String = messageId, body: String = "My reply", shots: String = "[]", visibility: String = "reporter") = json("""{"id":"$id","revision":$revision,"body":${JsonPrimitive(body)},"kind":"reply","visibility":"$visibility","authorRole":"reporter","createdAt":"2026-09-12T00:00:00Z","attachments":$shots}""")
    private fun thread(messages: String = "[]", first: Int = 0, last: Int = 0, latest: Int = last, earlier: Boolean = false, id: String = reportId, locked: Boolean = false) = json("""{"report":${report(id, locked)},"messages":$messages,"hasMore":false,"oldestRevision":$first,"hasEarlier":$earlier,"nextRevision":$last,"latestRevision":$latest,"readRevision":0,"unread":true}""")
    private inner class Fixture(val disk: MemoryStore = MemoryStore(), build: String = "a".repeat(40)) {
        val holder = testHolder(); val session = signedIn(holder); val fake = FakeApiClient()
        var upload: suspend (String, ByteArray, String) -> JsonObject = { _, _, _ -> attachment() }
        var download: suspend (String, Int) -> ByteArray = { _, _ -> byteArrayOf(1, 2) }
        val uploads = mutableListOf<String>(); val downloads = mutableListOf<String>()
        val api = object : ApiClient by fake {
            override suspend fun upload(path: String, method: String, bytes: ByteArray, contentType: String): JsonObject {
                assertEquals("POST", method); uploads += path; return upload(path, bytes, contentType)
            }
            override suspend fun download(path: String, contentType: String, maxBytes: Int): ByteArray {
                assertEquals("image/webp", contentType); downloads += path; return download(path, maxBytes)
            }
        }
        val outbox = FeedbackOutbox(disk, WALLET, session.origin)
        val repo = LiveFeedbackRepository(session, holder, api, outbox, { cfg }, nativeBuild = build)
        init {
            fake.onGet("/tester/feedback/page") { json("""{"feedback":[${report()}],"nextCursor":null}""") }
            fake.onGet("/tester/feedback/$reportId/thread") { thread() }
            fake.onPost("/tester/feedback") { json("""{"id":"$reportId","basePoints":0,"dailyRemaining":7}""") }
            fake.onPost("/tester/feedback/$reportId/replies") { body -> message(body = requireNotNull(body.string("body")), shots = if (body["attachmentIds"]?.jsonArray?.isNotEmpty() == true) "[${attachment()}]" else "[]") }
        }
    }
    @Test fun `report context text and key are durable before POST with no invented reward`(): Unit = runBlocking {
        val f = Fixture()
        f.fake.onPost("/tester/feedback") { body ->
            val saved = requireNotNull(f.outbox.read()); assertTrue(saved.attempted); assertEquals(saved.requestId, body.string("requestId"))
            assertEquals("Bug report", saved.title); assertEquals(BASE_ID, saved.context.string("baseId"))
            assertEquals(setOf("screen", "build", "platform", "baseId"), saved.context.keys)
            assertEquals("feedback", saved.context.string("screen")); assertEquals("a".repeat(40), saved.context.string("build"))
            json("""{"id":"$reportId","basePoints":0,"dailyRemaining":7}""")
        }
        f.repo.submit("bug", " Bug report ", " Enough detail for a report ", BASE_ID)
        assertNull(f.outbox.read()); assertEquals(1, f.fake.posts.size); assertTrue(f.repo.state.value.notice!!.contains("after review"))
    }
    // Drafts outlive the screen. A report the server acknowledged must not come back as "Continue
    // draft report" (a duplicate), even when the screen's scope dies right after the POST.
    @Test fun `acknowledged report stops being a draft even when the screen is gone before delivery finishes`(): Unit = runBlocking(Dispatchers.IO) {
        val f = Fixture(); f.repo.drafts.keepReport(FeedbackReportDraft("bug", " Bug report", "Enough detail for a report ", includeBase = true))
        // IO keeps disk persistence inline: the test must not rely on an incidental dispatcher
        // handoff to stop delivery. The simulated hydration GET is the cancellation boundary.
        val hydrate = f.fake.getHandlers.getValue("/tester/feedback/page")
        f.fake.onGet("/tester/feedback/page") { query -> yield(); hydrate(query) }
        lateinit var screen: Job
        f.fake.onPost("/tester/feedback") { screen.cancel(); json("""{"id":"$reportId","basePoints":0,"dailyRemaining":7}""") }
        // Bind the Job before an IO worker can invoke the cancellation callback.
        screen = launch(start = CoroutineStart.LAZY) { f.repo.submit("bug", " Bug report", "Enough detail for a report ") }; screen.join()
        assertTrue(screen.isCancelled); assertEquals(FeedbackReportDraft(), f.repo.drafts.report)
        assertEquals(reportId, f.outbox.read()?.reportReceipt?.id)
        // Process death can restore the sent words into a new holder; finishing the acknowledged request retires them without a second POST.
        val restored = Fixture(f.disk); restored.repo.drafts.keepReport(FeedbackReportDraft("bug", "Bug report", "Enough detail for a report"))
        restored.repo.retry(); assertFalse(restored.repo.drafts.report.hasText); assertTrue(restored.fake.posts.isEmpty()); assertNull(restored.outbox.read())
    }
    @Test fun `a report that was not acknowledged keeps its draft`(): Unit = runBlocking {
        val f = Fixture(); val typed = FeedbackReportDraft("bug", "Bug report", "Enough detail for a report"); f.repo.drafts.keepReport(typed)
        f.fake.onPost("/tester/feedback") { throw ApiException(400, null, "Rejected") }
        assertThrows(ApiException::class.java) { runBlocking { f.repo.submit(typed.category, typed.title, typed.body) } }
        assertEquals(typed, f.repo.drafts.report)
    }
    @Test fun `sent reply forgets only the text that was sent`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId); f.repo.drafts.keepReply(reportId, " My reply ")
        f.repo.reply(reportId, " My reply "); assertEquals("", f.repo.drafts.reply(reportId))
        f.repo.drafts.keepReply(reportId, "My reply, and a follow-up"); f.repo.reply(reportId, "My reply")
        assertEquals("My reply, and a follow-up", f.repo.drafts.reply(reportId))
    }
    @Test fun `restart reads history without inferring a receipt from identical title`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onPost("/tester/feedback") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Bug report", "Enough detail for a report") } }
        val restored = Fixture(f.disk); restored.repo.refresh()
        assertNotNull(restored.repo.state.value.pending); assertTrue(restored.fake.posts.isEmpty())
        assertThrows(IllegalStateException::class.java) { runBlocking { restored.repo.submit("bug", "Another", "More than ten chars") } }
    }
    @Test fun `explicit retry preserves original request context across deed changes`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onPost("/tester/feedback") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Bug report", "Enough detail for a report", BASE_ID) } }
        val restored = Fixture(f.disk, build = "b".repeat(40)); restored.repo.retry()
        assertEquals(f.fake.posts.single().second, restored.fake.posts.single().second); assertNull(restored.outbox.read())
        assertEquals("a".repeat(40), restored.fake.posts.single().second.getValue("context").jsonObject.string("build"))
    }
    @Test fun `first definitive refusal retires but refusal after lost acknowledgement does not`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onPost("/tester/feedback") { throw ApiException(429, null, "Daily limit") }
        assertThrows(ApiException::class.java) { runBlocking { f.repo.submit("bug", "Bug report", "Enough detail for a report") } }
        // A first cap refusal is definitive. A later refusal is not proof against an earlier possible send.
        assertNull(f.outbox.read())
        val clean = Fixture(); clean.fake.onPost("/tester/feedback") { throw ApiException(400, null, "Rejected") }
        assertThrows(ApiException::class.java) { runBlocking { clean.repo.submit("bug", "Bug report", "Enough detail for a report") } }; assertNull(clean.outbox.read())
        clean.fake.onPost("/tester/feedback") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { clean.repo.submit("bug", "Bug report", "Enough detail for a report") } }
        clean.fake.onPost("/tester/feedback") { throw ApiException(409, "FEEDBACK_REQUEST_CONFLICT", "Changed") }
        assertThrows(ApiException::class.java) { runBlocking { clean.repo.retry() } }; assertNotNull(clean.outbox.read())
    }
    @Test fun `successful report acknowledgement survives offline hydration without a second POST`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onGet("/tester/feedback/page") { throw IOException("offline") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Bug report", "Enough detail for a report") } }
        assertEquals(reportId, f.outbox.read()!!.reportReceipt!!.id)
        val restored = Fixture(f.disk); restored.repo.retry(); assertTrue(restored.fake.posts.isEmpty()); assertNull(restored.outbox.read())
    }
    @Test fun `acknowledged report survives SQL timestamp page and restart then continues through ISO hydration without another POST`(): Unit = runBlocking {
        // Installed code24 already accepts ISO dates. A server serialization repair must recover its saved receipt, not resend it.
        for (field in listOf("createdAt", "fixedAt")) {
            val f = Fixture()
            val iso = JsonObject(report() + mapOf("createdAt" to JsonPrimitive("2026-09-19T18:22:19.186Z"),
                "reviewedAt" to JsonPrimitive("2026-09-19T18:23:19.186Z"), "fixedAt" to JsonPrimitive("2026-09-19T18:24:19.186Z"),
                "status" to JsonPrimitive("fixed")))
            val broken = JsonObject(iso + (field to JsonPrimitive("2026-09-19 18:22:19.186+00")))
            f.fake.onGet("/tester/feedback/page") { json("""{"feedback":[$broken],"nextCursor":null}""") }
            val failure = assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repo.submit("bug", "Bug report", "Enough detail for a report") } }
            assertTrue(failure.message!!.contains("/tester/feedback/page"))
            val saved = requireNotNull(f.outbox.read()); assertEquals(reportId, saved.reportReceipt!!.id)
            assertEquals(saved.requestId, f.fake.posts.single().second.string("requestId"))
            val restored = Fixture(f.disk)
            restored.fake.onGet("/tester/feedback/page") { json("""{"feedback":[$iso],"nextCursor":null}""") }
            restored.repo.refresh(); assertEquals(saved, restored.outbox.read())
            assertNotNull(restored.repo.state.value.pending); assertTrue(restored.fake.posts.isEmpty())
            restored.repo.retry() // The existing Continue saved request action performs this explicit recovery.
            assertNull(restored.outbox.read()); assertNull(restored.repo.state.value.pending)
            assertEquals("2026-09-19T18:24:19.186Z", restored.repo.state.value.reports.single().fixedAt)
            assertEquals(1, f.fake.posts.size + restored.fake.posts.size)
        }
    }
    @Test fun `exact-key removed report response retires pending without claiming it was unsent`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onPost("/tester/feedback") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Bug report", "Enough detail for a report") } }
        val restored = Fixture(f.disk); restored.fake.onPost("/tester/feedback") { throw ApiException(409, "FEEDBACK_REPORT_TRASHED", "Removed") }
        restored.repo.retry(); assertNull(restored.outbox.read()); assertTrue(restored.repo.state.value.notice!!.contains("was removed"))
        assertEquals(f.fake.posts.single().second, restored.fake.posts.single().second)
    }
    @Test fun `reply requires exact open unlocked report and never another report`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.reply(BASE_ID, "My reply") } }
        f.fake.onGet("/tester/feedback/$reportId/thread") { thread(locked = true) }; f.repo.open(reportId)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.reply(reportId, "My reply") } }; assertTrue(f.fake.posts.isEmpty())
    }
    @Test fun `lost reply acknowledgement retries original body and UUID after restart`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId); f.fake.onPost("/tester/feedback/$reportId/replies") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.reply(reportId, " My reply ") } }
        val restored = Fixture(f.disk); restored.repo.refresh(); assertTrue(restored.fake.posts.isEmpty()); restored.repo.retry()
        assertEquals(f.fake.posts.single(), restored.fake.posts.single()); assertNull(restored.outbox.read())
    }
    @Test fun `upload saves immutable hash and UUID before bytes and receipt before publishing reply`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId); val bytes = byteArrayOf(1, 2, 3)
        f.upload = { path, payload, type ->
            val saved = requireNotNull(f.outbox.read()); val file = saved.images.single()
            assertFalse(saved.attempted); assertTrue(path.endsWith(file.requestId)); assertEquals(feedbackImageHash(bytes), file.sha256)
            assertEquals("image/png", type); assertArrayEquals(bytes, payload); attachment()
        }
        f.fake.onPost("/tester/feedback/$reportId/replies") { body ->
            assertEquals(attachmentId, f.outbox.read()!!.images.single().attachment!!.id)
            assertEquals(listOf(JsonPrimitive(attachmentId)), body["attachmentIds"]!!.jsonArray.toList())
            message(body = "", shots = "[${attachment()}]")
        }
        f.repo.reply(reportId, "", listOf(FeedbackImage(bytes, "image/png"))); assertNull(f.outbox.read()); assertEquals(1, f.uploads.size)
    }
    @Test fun `unknown upload accepts only identical original bytes and reuses upload ID`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId); f.upload = { _, _, _ -> throw IOException("lost upload") }
        val image = FeedbackImage(byteArrayOf(1, 2, 3), "image/png")
        assertThrows(IOException::class.java) { runBlocking { f.repo.reply(reportId, "", listOf(image)) } }
        val restored = Fixture(f.disk)
        assertThrows(IllegalStateException::class.java) { runBlocking { restored.repo.retry(listOf(FeedbackImage(byteArrayOf(3, 2, 1), "image/png"))) } }
        assertTrue(restored.uploads.isEmpty()); assertTrue(restored.fake.posts.isEmpty())
        restored.repo.retry(listOf(image)); assertEquals(f.uploads.single(), restored.uploads.single()); assertNull(restored.outbox.read())
    }
    @Test fun `saved uploaded screenshot needs no original after process loss and lost reply ack`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId); f.fake.onPost("/tester/feedback/$reportId/replies") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.reply(reportId, "", listOf(FeedbackImage(byteArrayOf(1, 2, 3), "image/png"))) } }
        val restored = Fixture(f.disk); restored.repo.retry(); assertTrue(restored.uploads.isEmpty()); assertEquals(f.fake.posts.single().second, restored.fake.posts.single().second)
    }
    @Test fun `partial multi-image recovery skips acknowledged upload and preserves attachment order`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId)
        val first = FeedbackImage(byteArrayOf(1), "image/png"); val second = FeedbackImage(byteArrayOf(2), "image/png")
        f.upload = { _, payload, _ -> if (payload.single() == 1.toByte()) attachment() else throw IOException("second lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.reply(reportId, "My reply", listOf(first, second)) } }
        assertEquals(attachmentId, f.outbox.read()!!.images.first().attachment!!.id); assertTrue(f.fake.posts.isEmpty())
        val restored = Fixture(f.disk); restored.upload = { _, payload, _ -> assertArrayEquals(second.bytes, payload); attachment(BASE_ID) }
        restored.fake.onPost("/tester/feedback/$reportId/replies") { body ->
            assertEquals(listOf(attachmentId, BASE_ID), body.getValue("attachmentIds").jsonArray.map { it.jsonPrimitive.content })
            message(shots = "[${attachment()},${attachment(BASE_ID)}]")
        }
        restored.repo.retry(listOf(second)); assertEquals(listOf(f.uploads.last()), restored.uploads); assertNull(restored.outbox.read())
    }
    @Test fun `unsent upload draft may be discarded but possibly sent reply cannot`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId); f.upload = { _, _, _ -> throw IOException("lost upload") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.reply(reportId, "My reply", listOf(FeedbackImage(byteArrayOf(1), "image/png"))) } }
        f.repo.discardUnsentReply(); assertNull(f.outbox.read()); assertTrue(f.fake.posts.isEmpty())
        f.fake.onPost("/tester/feedback/$reportId/replies") { throw IOException("lost reply") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.reply(reportId, "My reply") } }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.discardUnsentReply() } }; assertNotNull(f.outbox.read())
    }
    @Test fun `identity change after POST cannot publish or clear original account intent`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onPost("/tester/feedback") { signedIn(f.holder, "other-wallet"); json("""{"id":"$reportId","basePoints":0,"dailyRemaining":7}""") }
        assertThrows(CancellationException::class.java) { runBlocking { f.repo.submit("bug", "Bug report", "Enough detail for a report") } }
        assertNotNull(f.outbox.read()); assertNull(f.repo.state.value.notice); assertTrue(f.fake.gets.isEmpty())
    }
    @Test fun `Back during slow open never reopens detail`(): Unit = runBlocking {
        val f = Fixture(); val waiting = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.fake.onGet("/tester/feedback/$reportId/thread") { waiting.complete(Unit); release.await(); thread() }
        val job = launch { f.repo.open(reportId) }; waiting.await(); f.repo.closeDetail(); release.complete(Unit); job.join()
        assertNull(f.repo.state.value.detail)
    }
    @Test fun `Back during reply hydration preserves completion without reopening detail`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(reportId); val waiting = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.fake.onPost("/tester/feedback/$reportId/replies") { waiting.complete(Unit); release.await(); message() }
        val job = launch { f.repo.reply(reportId, "My reply") }; waiting.await(); f.repo.closeDetail(); release.complete(Unit); job.join()
        assertNull(f.repo.state.value.detail); assertNull(f.outbox.read()); assertEquals("Reply sent.", f.repo.state.value.notice)
    }
    @Test fun `opaque report pagination preserves prior rows and rejects repeating cursor`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onGet("/tester/feedback/page") { query ->
            if (query.isEmpty()) json("""{"feedback":[${report()}],"nextCursor":"opaque_cursor"}""")
            else { assertEquals(mapOf("cursor" to "opaque_cursor"), query); json("""{"feedback":[${report(BASE_ID)}],"nextCursor":null}""") }
        }
        f.repo.refresh(); f.repo.refresh(true); assertEquals(2, f.repo.state.value.reports.size)
        f.fake.onGet("/tester/feedback/page") { json("""{"feedback":[],"nextCursor":"repeat"}""") }
        f.repo.refresh(); assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repo.refresh(true) } }
    }
    @Test fun `earlier thread page uses reporter revisions and merges visible order`(): Unit = runBlocking {
        val f = Fixture()
        f.fake.onGet("/tester/feedback/$reportId/thread") { query ->
            if (query.isEmpty()) thread("[${message(2)}]", 2, 2, 2, true)
            else { assertEquals(mapOf("beforeRevision" to "2"), query); thread("[${message(1, BASE_ID)}]", 1, 1, 2) }
        }
        f.repo.open(reportId); f.repo.earlier(); assertEquals(listOf(1L, 2L), f.repo.state.value.detail!!.messages.map { it.revision })
    }
    @Test fun `new staff reply discovered during older paging stays unread beyond loaded boundary`(): Unit = runBlocking {
        val f = Fixture(); f.repo.refresh()
        f.fake.onGet("/tester/feedback/$reportId/thread") { query ->
            if (query.isEmpty()) thread("[${message(2)}]", 2, 2, 2, true)
            else thread("[${message(1, BASE_ID)}]", 1, 1, 3)
        }
        f.repo.open(reportId); f.repo.earlier(); assertTrue(f.repo.state.value.detail!!.hasMore)
        f.fake.onPost("/tester/feedback/$reportId/read") { body -> assertEquals("2", body.string("revision")); json("""{"readRevision":2}""") }
        f.repo.markRead(); assertTrue(f.repo.state.value.detail!!.unread); assertTrue(f.repo.state.value.reports.single().unread)
    }
    @Test fun `missing thread mutation gates fail closed instead of inheriting list defaults`() {
        val raw = thread().toMutableMap(); val report = raw.getValue("report").jsonObject.toMutableMap(); report.remove("locked"); raw["report"] = JsonObject(report)
        assertThrows(IllegalArgumentException::class.java) { FeedbackThread.from(JsonObject(raw)) }
    }
    @Test fun `reporter DTO refuses private staff messages`() {
        assertThrows(IllegalArgumentException::class.java) { FeedbackMessage.from(message(visibility = "admin")) }
    }
    @Test fun `private screenshot uses report route bounds and is fenced after Back`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onGet("/tester/feedback/$reportId/thread") { thread("[${message(shots = "[${attachment()}]")}]", 1, 1) }; f.repo.open(reportId)
        val shot = FeedbackAttachment.from(attachment()); f.download = { path, max ->
            assertEquals("/tester/feedback/$reportId/screenshots/$attachmentId", path); assertEquals(cfg.downloadMax, max); f.repo.closeDetail(); byteArrayOf(1)
        }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.screenshot(reportId, shot) } }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.screenshot(BASE_ID, shot) } }; assertEquals(1, f.downloads.size)
    }
    @Test fun `mark read sends visible boundary and does not submit a reply`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onGet("/tester/feedback/$reportId/thread") { thread("[${message()}]", 1, 1) }; f.repo.open(reportId)
        f.fake.onPost("/tester/feedback/$reportId/read") { body -> assertEquals("1", body.string("revision")); json("""{"readRevision":1}""") }
        f.repo.markRead(); assertFalse(f.repo.state.value.detail!!.unread); assertEquals(1, f.fake.posts.size)
    }
    @Test fun `malformed and foreign outbox fail closed before report POST`(): Unit = runBlocking {
        val f = Fixture(); f.disk.value = "broken"
        assertThrows(Exception::class.java) { runBlocking { f.repo.submit("bug", "Bug report", "Enough detail for a report") } }; assertTrue(f.fake.posts.isEmpty())
        f.disk.value = Json.encodeToString(SavedFeedback(WALLET, "https://other", UUID.randomUUID().toString(), "report", "Details long enough", "bug", "Title"))
        assertThrows(IllegalStateException::class.java) { f.outbox.read() }
    }
    @Test fun `initial report checkpoints primary upload and screenshot reply before the next stage`(): Unit = runBlocking {
        val f = Fixture(); val image = FeedbackImage(byteArrayOf(1, 2, 3), "image/png")
        f.fake.onPost("/tester/feedback") { body ->
            val saved = f.outbox.read()!!; assertNotNull(saved.attachmentReplyId); assertEquals(1, saved.images.size)
            assertFalse(body.containsKey("images")); assertFalse(body.containsKey("attachmentIds")); assertTrue(f.uploads.isEmpty())
            json("""{"id":"$reportId","basePoints":0,"dailyRemaining":7}""")
        }
        f.upload = { _, _, _ -> assertEquals(reportId, f.outbox.read()!!.reportReceipt!!.id); attachment() }
        f.fake.onPost("/tester/feedback/$reportId/replies") { body ->
            val saved = f.outbox.read()!!; assertTrue(saved.attachmentReplyAttempted); assertEquals(saved.attachmentReplyId, body.string("requestId"))
            assertEquals("", body.string("body")); assertEquals(attachmentId, saved.images.single().attachment!!.id)
            message(body = "", shots = "[${attachment()}]")
        }
        f.repo.submit("bug", "Screenshot report", "Enough detail for a report", images = listOf(image))
        assertEquals(listOf("/tester/feedback", "/tester/feedback/$reportId/replies"), f.fake.posts.map { it.first }); assertNull(f.outbox.read())
    }
    @Test fun `lost primary report acknowledgement uploads nothing and replays original report first`(): Unit = runBlocking {
        val f = Fixture(); val image = FeedbackImage(byteArrayOf(1, 2), "image/png"); f.fake.onPost("/tester/feedback") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Screenshot report", "Enough detail for a report", images = listOf(image)) } }
        assertTrue(f.uploads.isEmpty()); assertNull(f.outbox.read()!!.reportReceipt)
        val restored = Fixture(f.disk); restored.repo.retry(listOf(image)); assertEquals(f.fake.posts.single().second, restored.fake.posts.first().second)
        assertEquals(1, restored.uploads.size); assertNull(restored.outbox.read())
    }
    @Test fun `unknown initial screenshot upload never creates a second primary report`(): Unit = runBlocking {
        val f = Fixture(); val image = FeedbackImage(byteArrayOf(1, 2), "image/png"); f.upload = { _, _, _ -> throw IOException("lost upload") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Screenshot report", "Enough detail for a report", images = listOf(image)) } }
        val restored = Fixture(f.disk); restored.repo.retry(listOf(image))
        assertEquals(listOf("/tester/feedback/$reportId/replies"), restored.fake.posts.map { it.first }); assertEquals(f.uploads.single(), restored.uploads.single())
    }
    @Test fun `lost initial attachment reply acknowledgement retries same reply without image originals`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onPost("/tester/feedback/$reportId/replies") { throw IOException("lost link") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Screenshot report", "Enough detail for a report", images = listOf(FeedbackImage(byteArrayOf(1), "image/png"))) } }
        val saved = f.outbox.read()!!; assertTrue(saved.attachmentReplyAttempted)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.finishWithoutScreenshots() } }
        val restored = Fixture(f.disk); restored.repo.retry()
        assertTrue(restored.uploads.isEmpty()); assertEquals(f.fake.posts.last(), restored.fake.posts.single()); assertNull(restored.outbox.read())
    }
    @Test fun `accepted screenshot reply survives failed hydration without repeated writes`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onGet("/tester/feedback/page") { throw IOException("offline") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Screenshot report", "Enough detail for a report", images = listOf(FeedbackImage(byteArrayOf(1), "image/png"))) } }
        assertNotNull(f.outbox.read()!!.attachmentReplyReceipt)
        val restored = Fixture(f.disk); restored.repo.retry(); assertTrue(restored.fake.posts.isEmpty()); assertTrue(restored.uploads.isEmpty()); assertNull(restored.outbox.read())
    }
    @Test fun `explicitly finishing saved report without unsent screenshots does not retract or resubmit it`(): Unit = runBlocking {
        val f = Fixture(); f.upload = { _, _, _ -> throw IOException("lost upload") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.submit("bug", "Screenshot report", "Enough detail for a report", images = listOf(FeedbackImage(byteArrayOf(1), "image/png"))) } }
        val restored = Fixture(f.disk); restored.repo.finishWithoutScreenshots()
        assertTrue(restored.fake.posts.isEmpty()); assertTrue(restored.uploads.isEmpty()); assertNull(restored.outbox.read())
    }
    @Test fun `first definitive screenshot reply refusal keeps saved report and allows finishing without images`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onPost("/tester/feedback/$reportId/replies") { throw ApiException(409, "FEEDBACK_THREAD_LOCKED", "Locked") }
        assertThrows(ApiException::class.java) { runBlocking { f.repo.submit("bug", "Screenshot report", "Enough detail for a report", images = listOf(FeedbackImage(byteArrayOf(1), "image/png"))) } }
        assertFalse(f.outbox.read()!!.attachmentReplyAttempted); assertEquals(reportId, f.outbox.read()!!.reportReceipt!!.id)
        f.repo.finishWithoutScreenshots(); assertNull(f.outbox.read()); assertEquals(2, f.fake.posts.size)
    }
    @Test fun `foreground resume and manual newer page preserve loaded history without POST or timer`(): Unit = runBlocking {
        val f = Fixture(); f.fake.onGet("/tester/feedback/$reportId/thread") { query ->
            if (query.isEmpty()) thread("[${message()}]", 1, 1)
            else { assertEquals(mapOf("afterRevision" to "1"), query); thread("[${message(2, BASE_ID)}]", 2, 2, 2, true) }
        }
        f.repo.open(reportId); f.repo.resume(); assertEquals(listOf(1L, 2L), f.repo.state.value.detail!!.messages.map { it.revision }); assertTrue(f.fake.posts.isEmpty())
        f.fake.onGet("/tester/feedback/$reportId/thread") { query -> assertEquals(mapOf("afterRevision" to "2"), query); thread(first = 2, last = 2, latest = 2, earlier = true) }
        f.repo.newer(); assertEquals(2, f.repo.state.value.detail!!.messages.size); assertTrue(f.fake.posts.isEmpty())
    }
    @Test fun `identity changes during initial image upload preserve primary receipt and block linking`(): Unit = runBlocking {
        val f = Fixture(); f.upload = { _, _, _ -> signedIn(f.holder, "other-wallet"); attachment() }
        assertThrows(CancellationException::class.java) { runBlocking { f.repo.submit("bug", "Screenshot report", "Enough detail for a report", images = listOf(FeedbackImage(byteArrayOf(1), "image/png"))) } }
        assertEquals(reportId, f.outbox.read()!!.reportReceipt!!.id); assertNull(f.outbox.read()!!.images.single().attachment)
        assertEquals(listOf("/tester/feedback"), f.fake.posts.map { it.first })
    }
}
