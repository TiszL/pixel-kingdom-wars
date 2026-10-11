package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.ops.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06 sweep of the other Home recovery cards: a hero altar or wall batch request the server has no record of
 * was the same dead end as the saved construction (CHECK answered nothing new, RETRY could be refused forever, and the saved
 * request kept refusing every new recruitment or wall stroke). Each card's owner closes it the same way. Owner review the
 * same day: CLOSE is drawn for a never-sent request, or for the server's no-row answer (these two GETs are locked reads, so
 * `receipt: null` is that proof) once it was read [SAVED_REQUEST_MIN_AGE_MS] after the last send. The close reads once more,
 * honours an acceptance found there, and otherwise removes a never-sent request or ARCHIVES a sent one, sending nothing.
 */
class ServerUnknownCardCloseTest {
    @Test fun `a wall batch the server does not know is closed from its card and wall strokes open again`() = runBlocking {
        val f = WallBatchFixture(); val saved = f.create()
        assertNull("no CLOSE before the server has answered", f.repo.state.value.serverUnknownKey)
        f.repo.refresh()
        assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKey)
        assertTrue(f.repo.close() is Receipt.Closed)
        assertNull(f.saved()); assertNull(f.repo.state.value.pending); assertTrue("closing sends nothing", f.posts.isEmpty())
        f.build()
        assertEquals("a new batch is admitted again", 1, f.posts.size); assertNull(f.saved()); assertNotNull(f.repo.state.value.receipt)
    }

    @Test fun `a wall batch close honours an acceptance its fresh read finds`() = runBlocking {
        val f = WallBatchFixture(); val saved = f.create()
        f.repo.refresh(); assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKey)
        f.receipts[saved.idempotencyKey] = f.proof(saved) // the server committed after the card last looked
        assertTrue(f.repo.close() is Receipt.Accepted)
        assertNull(f.saved()); assertNotNull("the accepted receipt is shown, not dropped", f.repo.state.value.receipt); assertTrue(f.posts.isEmpty())
    }

    @Test fun `a hero altar request the server has no record of is archived from its card and recruitment opens again`() = runBlocking {
        // Rewritten 2026-10-06 (owner review M1/M2): this pinned CLOSE right after the first read. The lost POST may still be
        // on its way then, so CLOSE now waits for a no-row read taken the minimum age after the send, and archives.
        val f = HeroRecruitmentFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.recruit(); fail() } catch (_: IOException) { }
        val saved = requireNotNull(f.saved())
        assertNull("no CLOSE before the server has answered", f.repo.state.value.serverUnknownKey)
        f.repo.refresh()
        assertNull("a no-row read right after the send offers no CLOSE yet", f.repo.state.value.serverUnknownKey)
        f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        f.repo.refresh()
        assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKey)
        assertTrue(f.repo.close() is Receipt.Closed)
        assertNull(f.saved()); assertNull(f.repo.state.value.pending); assertEquals("closing sent nothing", 1, f.posts.size)
        assertEquals("archived on this device, never deleted", listOf(KeptIntent(saved, closed = true)), f.store.kept(WALLET))
        f.postHandler = { _, _ -> val i = requireNotNull(f.saved()); f.proof(i).also { f.receipts[i.idempotencyKey] = it } }
        f.recruit()
        assertEquals("a new recruitment is admitted again", 2, f.posts.size); assertNull(f.saved()); assertNotNull(f.repo.state.value.receipt)
    }

    @Test fun `a sent wall batch the server has no record of is archived only once old enough`() = runBlocking {
        val f = WallBatchFixture(); val send = f.postHandler
        f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.build(); fail() } catch (_: IOException) { }
        val saved = requireNotNull(f.saved()); assertTrue(saved.attempted)
        f.repo.refresh(); assertNull("no CLOSE while the POST may still be on its way", f.repo.state.value.serverUnknownKey)
        f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        f.repo.refresh(); assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKey)
        assertTrue(f.repo.close() is Receipt.Closed)
        assertNull(f.saved()); assertEquals(listOf(KeptIntent(saved, closed = true)), f.store.kept(WALLET))
        f.postHandler = send; f.build()
        assertEquals("a new batch is admitted again", 2, f.posts.size); assertNull(f.saved()); assertNotNull(f.repo.state.value.receipt)
    }
}
