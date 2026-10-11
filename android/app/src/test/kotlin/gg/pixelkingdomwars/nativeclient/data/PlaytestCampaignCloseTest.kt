package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Dead-end audit 2026-10-06 (shape A). One saved campaign request (a lost participate/submission reply) blocked every
 * new campaign request with RETRY as the only door. `GET /playtest/campaigns/{id}/me` lists this wallet's participation
 * and every submission for the campaign, so a same-action read without the exact record may close it on this device. */
class PlaytestCampaignCloseTest {
    private val founding = "founding-kingdoms"
    private val rewarded = "rewarded-playtest"
    private val stamp = "2026-09-12T00:00:00.000Z"
    private val url = "https://video.example/post"
    private val cfg = PlaytestBounds(founding, rewarded, "Founding", "Rewarded", 14, 30000, 3, 25, 1, mapOf("feedback" to 40))
    private fun submission(key: String, link: String = url) = json("""{"id":"$WALLET:$key","campaignId":"$rewarded","wallet":"$WALLET","kind":"video",
        "url":${JsonPrimitive(link)},"reportId":null,"createdAt":"$stamp"}""")
    private fun campaign(submissions: List<JsonObject> = emptyList()) = json("""{
        "id":"$rewarded","kind":"rewarded","name":"Test campaign","phase":"running","startAt":"$stamp","endAt":"2026-09-26T00:00:00.000Z",
        "registrationOpen":true,"revision":1,"reconciledAt":null,"snapshotAt":null,"checkpoint":null,"spots":null,"stale":false,"measurementSince":null,
        "participant":{"campaignId":"$rewarded","wallet":"$WALLET","joinedAt":"$stamp","disqualifiedAt":null,"disqualificationReason":null,"bonusAt":null},
        "standings":[],"founders":[],"winners":[],"prizes":[],"ownSubmissions":[${submissions.joinToString(",")}] }""")
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val disk = MemoryStore()
        val outbox = CampaignOutbox(disk, WALLET, session.origin)
        val repo = LivePlaytestRepository(session, holder, api, outbox, { cfg }, { null })
        var latest = campaign(); var lose = true
        init {
            api.onGet("/playtest/campaigns/$rewarded/me") { latest }
            api.onPost("/playtest/campaigns/$rewarded/submissions") { body ->
                if (lose) throw IOException("Reply lost")
                submission(body.getValue("requestId").jsonPrimitive.content).also { latest = campaign(listOf(it)) }
            }
        }
        suspend fun submit() = runCatching { repo.submitVideo(requireNotNull(repo.state.value.campaign), url) }
    }

    @Test fun `a saved submission the campaign does not list closes after its own read so a new one can be sent`(): Unit = runBlocking {
        val f = Fixture(); f.repo.open(rewarded); assertTrue(f.submit().isFailure); val saved = requireNotNull(f.outbox.read()); assertTrue(saved.attempted)
        assertTrue("the door was dead while the saved request waited", f.submit().isFailure); assertEquals(1, f.api.posts.size)
        val reads = f.api.gets.size; f.repo.closeUnrecorded()
        assertEquals("closing is one fresh read of this campaign, never a POST", listOf("/playtest/campaigns/$rewarded/me"), f.api.gets.drop(reads).map { it.first })
        assertEquals(1, f.api.posts.size); assertNull(f.outbox.read()); assertEquals(LivePlaytestRepository.CLOSED_NOTICE, f.repo.state.value.notice)
        f.lose = false; assertTrue(f.submit().isSuccess); assertEquals(2, f.api.posts.size)
        assertNotEquals("the new request has a new key", saved.requestId, f.api.posts.last().second.getValue("requestId").jsonPrimitive.content)
    }
    @Test fun `close is refused when the campaign lists the saved submission`(): Unit = runBlocking {
        // The listing holds the exact id but contradicts the saved request: nothing is closed and the request stays saved.
        val f = Fixture(); f.repo.open(rewarded); assertTrue(f.submit().isFailure); val saved = requireNotNull(f.outbox.read())
        f.latest = campaign(listOf(submission(saved.requestId, link = "https://video.example/other")))
        assertTrue(runCatching { f.repo.closeUnrecorded() }.isFailure); assertEquals(saved, f.outbox.read())
        assertNotEquals(LivePlaytestRepository.CLOSED_NOTICE, f.repo.state.value.notice)
        // The listing holds its matching receipt: it resolves with that proof, never as a close.
        f.latest = campaign(listOf(submission(saved.requestId))); f.repo.closeUnrecorded()
        assertNull(f.outbox.read()); assertEquals("Your video submission is recorded for this campaign.", f.repo.state.value.notice)
        assertEquals(1, f.api.posts.size)
    }
}
