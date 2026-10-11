package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.liveMailHubUi
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/**
 * Owner 2026-10-06 dead-end sweep: a saved mail claim whose reward the server still shows `pending` refused every other reward
 * claim for good, and CHECK AGAIN only repeated it. Rewritten the same day (owner review M1/M2): a reward still `pending` is
 * "not confirmed", not proof the server holds no record, so it never offers CLOSE. Once the claim's last attempt is
 * [SAVED_REQUEST_MIN_AGE_MS] old and a check found nothing, it stops blocking: it stays on this device and a new claim parks
 * it. The key is the mail id, so a later claim of the same reward can never pay twice.
 * (Mail data mirrors CommunityRepositoryTest, whose fixture is private.)
 */
class MailClaimCloseTest {
    private val id = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    private fun mail(reward: String = "pending"): JsonObject = json("""{
        "id":"$id","sender":"system","kind":"reward","subject":"Gift","body":"Enjoy your reward",
        "attachments":[{"kind":"SHARDS","amount":"40"},{"kind":"ITEM","itemId":"keg_of_haste","qty":1}],
        "rewardState":"$reward","claimBaseId":${if (reward == "claimed") "\"$BASE_ID\"" else "null"},
        "createdAt":"2026-09-12T00:00:00Z","expiresAt":"2026-10-12T00:00:00Z","readAt":null,"archivedAt":null,
        "claimedAt":${if (reward == "claimed") "\"2026-09-12T00:00:01Z\"" else "null"},"expiredAt":null}
    """)
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val store = PendingIntentStore(MemoryStore())
        val repository = LiveCommunityRepository(session, holder, api, store, ReceiptObserver(store), { BASE_ID }, { MailBounds(20, 50) })
        var message = mail()
        init {
            api.onGet("/mail/$id") { message }
            api.onGet("/mail/status") { json("""{"total":1,"unread":1,"pendingRewards":1}""") }
            api.onGet("/mail") { json("""{"messages":[$message],"nextCursor":null}""") }
        }
        fun saved() = store.get(IntentKind.MAIL_CLAIM, WALLET)
        suspend fun lostClaim(): PendingIntent {
            repository.openMail(id)
            api.onPost("/mail/$id/claim") { throw IOException("lost") }
            assertThrows(IOException::class.java) { runBlocking { repository.claim(id, BASE_ID) } }
            return requireNotNull(saved()).also { assertTrue(it.attempted) }
        }
    }

    @Test fun `a saved mail claim the server has not confirmed stops blocking once settled and the reward can be claimed again`(): Unit = runBlocking {
        val f = Fixture(); val saved = f.lostClaim()
        assertNull("no CLOSE before the server has answered", f.repository.state.value.serverUnknownClaimKey)
        f.repository.checkClaim()
        assertNull("a reward still pending is not absent: no CLOSE", f.repository.state.value.serverUnknownClaimKey)
        assertFalse(liveMailHubUi(f.repository.state.value, selectedBaseId = BASE_ID).recovery!!.closeAllowed)
        f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        f.repository.checkClaim()
        assertNull(f.repository.state.value.serverUnknownClaimKey); assertEquals(saved, f.saved())
        f.api.onPost("/mail/$id/claim") { f.message = mail("claimed"); f.message }
        f.repository.claim(id, BASE_ID)
        assertEquals("a new claim of the same reward is admitted again", 2, f.api.posts.size)
        assertNull(f.saved()); assertEquals("claimed", f.repository.state.value.detail!!.rewardState)
        assertEquals("the original stays on this device, parked and never resent", listOf(saved), f.store.parked(WALLET))
    }

    @Test fun `a mail claim close honours a claimed reward its fresh read finds`(): Unit = runBlocking {
        val f = Fixture(); val saved = f.lostClaim(); f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS)
        f.repository.checkClaim(); assertNull(f.repository.state.value.serverUnknownClaimKey)
        f.message = mail("claimed") // the server applied the claim after the card last looked
        assertTrue(f.repository.closeClaim() is Receipt.Accepted)
        assertNull(f.saved()); assertEquals("the claimed reward is shown, not dropped", BASE_ID, f.repository.state.value.detail!!.claimBaseId)
        assertEquals(1, f.api.posts.size)
    }
}
