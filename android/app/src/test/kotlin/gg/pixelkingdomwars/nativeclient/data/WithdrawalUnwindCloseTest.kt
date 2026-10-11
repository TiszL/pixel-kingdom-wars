package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/**
 * Owner 2026-10-06 dead-end sweep: a saved cancel/refund the server never applied (the withdrawal history still shows the row
 * unsettled) refused every other withdrawal action for good. Rewritten the same day (owner review M1/M2): an unsettled row is
 * "not confirmed", not proof the server holds no record, so it never offers CLOSE. Instead, once the saved action's last
 * attempt is [SAVED_REQUEST_MIN_AGE_MS] old and a check found nothing, it stops blocking: it stays saved and shown, and a new
 * action parks it (kept on this device, never resent). The server still refuses an unwind of a settled row, so the new action
 * can never move the withdrawal twice.
 */
class WithdrawalUnwindCloseTest {
    @Test fun `a saved withdrawal action the server has not confirmed stops blocking once settled and the withdrawal can be managed again`() = runBlocking {
        val f = WithdrawalUnwindFixture(); val send = f.postHandler
        f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.unwind() } }
        val saved = requireNotNull(f.saved()); assertTrue(saved.attempted)
        f.repo.refresh()
        assertNull("not confirmed is not absent: no CLOSE", f.repo.state.value.serverUnknownKey)
        assertThrows("a fresh check keeps the door shut", IllegalStateException::class.java) { runBlocking { f.unwind() } }
        f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        f.repo.refresh()
        assertNull(f.repo.state.value.serverUnknownKey)
        f.postHandler = send; f.unwind()
        assertEquals("a new cancellation is admitted again", 2, f.posts.size)
        assertNull(f.saved()); assertEquals("cancelled", f.repo.state.value.outcome!!.status)
        assertEquals("the original stays on this device, parked and never resent", listOf(saved), f.store.parked(WALLET))
    }

    @Test fun `a withdrawal close honours a terminal row its fresh read finds`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.unwind() } }
        val saved = requireNotNull(f.saved()); f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS)
        f.repo.refresh(); assertNull(f.repo.state.value.serverUnknownKey)
        f.status = "cancelled" // the server cancelled after the card last looked
        assertTrue(f.repo.close() is Receipt.Accepted)
        assertNull(f.saved()); assertTrue("the terminal outcome is shown, not dropped", f.repo.state.value.outcome!!.returnedToWallet)
        assertEquals(1, f.posts.size)
    }
}
