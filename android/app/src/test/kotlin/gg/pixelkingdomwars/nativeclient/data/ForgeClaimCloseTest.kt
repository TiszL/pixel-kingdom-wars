package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/**
 * Owner 2026-10-06 dead-end sweep: a saved Forge claim the server has no record of refused every new collection for good, and
 * its lost POST also left the balance gate up, so COLLECT stayed off until a restart. Owner review the same day narrowed the
 * way out so it can neither double-pay nor hide a payout: the saved claim offers CLOSE only once its last attempt is
 * [SAVED_REQUEST_MIN_AGE_MS] old and the server answers `absent` for exactly that key; the close reads once more, honours an
 * acceptance found there, and otherwise ARCHIVES the claim on this device (re-read on every Home resume). Nothing is sent.
 */
class ForgeClaimCloseTest {
    @Test fun `a saved Forge claim the server has no record of is archived by CLOSE and collecting opens again`() = runBlocking {
        val f = ForgeClaimFixture(); val send = f.postHandler
        f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.claim() } }
        val saved = requireNotNull(f.saved()); assertTrue(saved.attempted); assertTrue(f.repo.state.value.refreshRequired)
        assertNull("no CLOSE before the server has answered", f.repo.state.value.serverUnknownKey)
        f.absentKeys += saved.idempotencyKey
        f.repo.refresh()
        assertNull("a fresh absent answer offers no CLOSE: the lost POST may still be running", f.repo.state.value.serverUnknownKey)
        f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        f.repo.refresh()
        assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKey)
        assertTrue(f.repo.close() is Receipt.Closed)
        assertNull(f.saved()); assertNull(f.repo.state.value.pending); assertEquals("closing sent nothing", 1, f.posts.size)
        assertEquals("archived on this device, never deleted", listOf(KeptIntent(saved, closed = true)), f.store.kept(WALLET))
        assertFalse("the balance gate the lost POST raised is lifted with the claim", f.repo.state.value.refreshRequired)
        assertNull(f.repo.state.value.serverUnknownKey)
        f.postHandler = send; f.claim()
        assertEquals("a new collection is admitted again", 2, f.posts.size)
        assertNull(f.saved()); assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep)
    }

    @Test fun `a Forge claim the server has not confirmed offers no CLOSE`() = runBlocking {
        // `receipt: null` is no matching evidence, not absence: the claim stays saved and shown with RETRY CHECK.
        val f = ForgeClaimFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.claim() } }
        val saved = requireNotNull(f.saved()); f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS)
        f.repo.refresh()
        assertNull(f.repo.state.value.serverUnknownKey)
        assertEquals("a close re-reads and keeps it", Receipt.Unknown, f.repo.close()); assertEquals(saved, f.saved())
        assertTrue(f.store.kept(WALLET).isEmpty()); assertEquals(1, f.posts.size)
    }

    @Test fun `a Forge claim close honours an acceptance its fresh read finds`() = runBlocking {
        val f = ForgeClaimFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.claim() } }
        val saved = requireNotNull(f.saved()); f.absentKeys += saved.idempotencyKey; f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS)
        f.repo.refresh(); assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKey)
        f.receipts[saved.idempotencyKey] = f.proof(saved) // the server committed after the card last looked
        assertTrue(f.repo.close() is Receipt.Accepted)
        assertNull(f.saved()); assertEquals("the accepted receipt is shown, not dropped", "777", f.repo.state.value.receipt!!.result.totalKeep)
        assertTrue(f.store.kept(WALLET).isEmpty()); assertEquals(1, f.posts.size)
    }
}
