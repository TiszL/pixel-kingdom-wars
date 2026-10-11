package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Dead-end audit 2026-10-06 (shape B). A report whose acknowledgement was lost, and whose retry the server then
 * refused, held the one feedback slot forever: no GET lists a feedback requestId and nothing else cleared it. Feedback
 * moves no money, so the door no longer blocks: the uncertain request is kept on this phone with CONTINUE/RETRY under
 * its original requestId, and a new report is sent under a new one. */
class FeedbackKeepAsideTest {
    private val reportId = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    private val cfg = FeedbackBounds(listOf("bug", "idea"), 80, 10, 2000, 2000, 2, 384, 120, 2, 100, 100, 64, 4096)
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val disk = MemoryStore()
        val outbox = FeedbackOutbox(disk, WALLET, session.origin)
        val repo = LiveFeedbackRepository(session, holder, api, outbox, { cfg }, nativeBuild = "a".repeat(40))
        var lose = true; val sent = mutableListOf<String>()
        init {
            api.onGet("/tester/feedback/page") { json("""{"feedback":[],"nextCursor":null}""") }
            api.onPost("/tester/feedback") { body -> sent += body.getValue("requestId").jsonPrimitive.content
                if (lose) throw IOException("reply lost"); json("""{"id":"$reportId","basePoints":0,"dailyRemaining":7}""") }
        }
        suspend fun submit(title: String) = runCatching { repo.submit("bug", title, "Enough detail for a report") }
    }

    @Test fun `an uncertain saved report can be kept aside so a new report is sent under its own key`(): Unit = runBlocking {
        val f = Fixture(); assertTrue(f.submit("First").isFailure); val first = requireNotNull(f.outbox.read()); assertTrue(first.attempted)
        assertTrue("the door was dead while the uncertain report held the slot", f.submit("Second").isFailure); assertEquals(1, f.sent.size)
        f.repo.park()
        assertEquals("keeping aside sends nothing", 1, f.sent.size); assertNull(f.outbox.read()); assertEquals(listOf(first), f.outbox.parked())
        assertNull(f.repo.state.value.pending); assertEquals(listOf(first), f.repo.state.value.parked)
        f.lose = false; assertTrue(f.submit("Second").isSuccess)
        assertEquals("the new report has its own new key", 2, f.sent.distinct().size); assertEquals(listOf(first), f.outbox.parked())
        // CONTINUE moves the kept report back; RETRY resends exactly its original request.
        f.repo.unpark(first.requestId); assertEquals(first, f.outbox.read()); assertTrue(f.outbox.parked().isEmpty())
        f.repo.retry(); assertEquals(first.requestId, f.sent.last()); assertNull(f.outbox.read())
        assertNull("nothing is left on the phone", f.disk.value)
    }
    @Test fun `a request that can still finish on its own is never kept aside and older bytes still decode`(): Unit = runBlocking {
        val f = Fixture(); val fresh = SavedFeedback(WALLET, f.session.origin, "79e4fc02-6d61-4578-b7d3-ac7b32dd6a03", "report", "Enough detail for a report", "bug", "Unsent")
        f.disk.value = Json.encodeToString(SavedFeedback.serializer(), fresh)
        assertEquals("older single-request bytes decode", fresh, f.outbox.read()); assertTrue(f.outbox.parked().isEmpty())
        assertFalse(feedbackParkable(fresh)); assertTrue(runCatching { f.repo.park() }.isFailure); assertEquals(fresh, f.outbox.read())
        assertTrue(runCatching { f.outbox.park(fresh) }.isFailure); assertTrue(f.outbox.parked().isEmpty())
    }
}
