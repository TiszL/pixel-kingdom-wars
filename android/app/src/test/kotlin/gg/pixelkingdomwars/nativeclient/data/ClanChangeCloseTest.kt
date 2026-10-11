package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/**
 * Owner 2026-10-06 dead-end sweep: a saved v1 clan change the server has no record of refused every new leave or kick for
 * good. Owner review the same day: ClanHub offers CLOSE only on the server's `absent` answer for exactly that key, once the
 * last attempt is [SAVED_REQUEST_MIN_AGE_MS] old; the close reads once more, honours an acceptance found there, and otherwise
 * ARCHIVES the change on this device (re-read on every Home resume). `receipt: null` ("not confirmed") never offers CLOSE.
 * A legacy request (no server key) can never be read, so it is never offered CLOSE; it stays saved and no longer blocks.
 */
class ClanChangeCloseTest {
    @Test fun `a saved clan change the server has no record of is archived by CLOSE and clan changes open again`(): Unit = runBlocking {
        val f = ClanFixture(); val send = f.postHandler
        f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.leave() } }
        val saved = requireNotNull(f.saved()); assertTrue(saved.attempted)
        assertTrue("no CLOSE before the server has answered", f.repo.state.value.serverUnknownKeys.isEmpty())
        f.repo.checkChanges()
        assertTrue("not confirmed is not absent: no CLOSE", f.repo.state.value.serverUnknownKeys.isEmpty())
        f.absentKeys += saved.idempotencyKey; f.repo.checkChanges()
        assertTrue("a fresh absent answer offers no CLOSE yet", f.repo.state.value.serverUnknownKeys.isEmpty())
        f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        f.repo.checkChanges()
        assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKeys[IntentKind.CLAN_LEAVE])
        assertTrue(f.repo.close(IntentKind.CLAN_LEAVE) is Receipt.Closed)
        assertNull(f.saved()); assertTrue(f.repo.state.value.pending.isEmpty()); assertEquals("closing sent nothing", 1, f.posts.size)
        assertEquals("archived on this device, never deleted", listOf(KeptIntent(saved, closed = true)), f.store.kept(WALLET))
        assertTrue(f.repo.state.value.serverUnknownKeys.isEmpty())
        f.postHandler = send; f.leave()
        assertEquals("a new clan change is admitted again", 2, f.posts.size)
        assertNull(f.saved()); assertNotNull(f.repo.state.value.receipt)
    }

    @Test fun `a clan change close honours an acceptance its fresh read finds`(): Unit = runBlocking {
        val f = ClanFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.leave() } }
        val saved = requireNotNull(f.saved()); f.absentKeys += saved.idempotencyKey; f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS)
        f.repo.checkChanges(); assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKeys[IntentKind.CLAN_LEAVE])
        // The server committed after the card last looked.
        f.receipts[saved.idempotencyKey] = f.proof(saved); f.membership = json("""{"clan":null}""")
        assertTrue(f.repo.close(IntentKind.CLAN_LEAVE) is Receipt.Accepted)
        assertNull(f.saved()); assertEquals("the accepted receipt is shown, not dropped", "777", f.repo.state.value.receipt!!.payoutShards)
        assertEquals(1, f.posts.size)
    }

    @Test fun `a legacy clan request is never offered CLOSE yet no longer blocks a new change`(): Unit = runBlocking {
        val f = ClanFixture(); val legacy = f.legacy()
        f.repo.checkChanges()
        assertTrue("a legacy request reads Unsupported, never unknown", f.repo.state.value.serverUnknownKeys.isEmpty())
        assertTrue(f.repo.close(IntentKind.CLAN_LEAVE) is Receipt.Unsupported)
        assertEquals("it is kept, never forgotten", legacy, f.saved()); assertTrue(f.posts.isEmpty())
        f.leave()
        assertEquals("a new change parks it instead of being refused", 1, f.posts.size)
        assertTrue(legacy in f.store.parked(WALLET)); assertNotNull(f.repo.state.value.receipt)
    }
}
