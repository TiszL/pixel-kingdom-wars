package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Owner rule 2026-10-06 (dead-end audit): a saved referral code whose first send was lost, whose status shows no
 *  relationship for this wallet and whose same-code retry is refused must not block REVIEW REFERRAL forever. CLOSE
 *  re-reads the per-wallet status (one relationship per wallet) and forgets only that exact unresolved code. */
class ReferralCloseTest {
    private suspend fun stuck(f: ReferralFixture) {
        f.api.onPost(ReferralRepository.USE) { throw IOException("lost before the server recorded it") }; f.submit()
        f.api.onPost(ReferralRepository.USE) { throw ApiException(422, "REFERRAL_WINDOW_CLOSED", "window closed") }; f.repository.retry()
        assertEquals("a refused retry never clears the saved code", SavedReferral("KEEP-AB234"), f.journal.read())
        f.repository.refresh(); assertFalse(f.repository.state.value.canEnter)
    }

    @Test fun `a saved referral code the server does not know cannot block REVIEW REFERRAL forever`() = runBlocking {
        val f = ReferralFixture(); stuck(f); val posts = f.api.posts.size; val statusReads = f.api.gets.count { it.first == ReferralRepository.STATUS }
        f.repository.close()
        assertNull(f.journal.read()); assertEquals("CLOSE never sends a referral", posts, f.api.posts.size)
        assertTrue("CLOSE made its own fresh status read", f.api.gets.count { it.first == ReferralRepository.STATUS } > statusReads)
        assertTrue(f.repository.state.value.canEnter)
    }

    @Test fun `close is refused when the server shows the referral relationship`() = runBlocking {
        val f = ReferralFixture(); stuck(f); val posts = f.api.posts.size
        f.binding = f.relation(); f.repository.close()
        assertEquals("KEEP-AB234", f.journal.read()!!.code); assertNotNull(f.journal.read()!!.relationship)
        assertEquals(posts, f.api.posts.size); assertFalse(f.repository.state.value.canEnter)
    }
}
