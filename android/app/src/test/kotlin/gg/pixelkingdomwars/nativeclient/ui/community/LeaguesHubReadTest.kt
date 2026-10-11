package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HubLeagueScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class LeaguesHubReadTest {
    private val session = AccountSession("wallet", "https://localhost:18443", testToken())
    private val owner = HubLeagueScope(session, "base", 3)
    private val state = CommunityState(leagueBaseId = "base", leagueSelectionGeneration = 3)

    @Test fun `one stable read returns exact observed snapshot`() = runBlocking {
        var calls = 0
        val result = readCurrentLeagues(owner, { owner }) { calls++; state }
        assertSame(state, result)
        assertEquals(1, calls)
    }
    @Test fun `stale owner is refused before repository call`() = runBlocking {
        var calls = 0
        try { readCurrentLeagues(owner, { null }) { calls++; state }; fail("stale read admitted") }
        catch (_: CancellationException) { }
        assertEquals(0, calls)
    }
    @Test fun `generation changing during await cannot publish`() = runBlocking {
        var current = owner
        try { readCurrentLeagues(owner, { current }) { current = owner.copy(selectionGeneration = 5); state }; fail("old read published") }
        catch (_: CancellationException) { }
    }
    @Test fun `replacement session during await cannot publish`() = runBlocking {
        var current = owner
        try { readCurrentLeagues(owner, { current }) {
            current = owner.copy(session = AccountSession("wallet", "https://localhost:18443", testToken())); state
        }; fail("old session published") } catch (_: CancellationException) { }
    }
    @Test fun `repository scope mismatch is refused without retry`() = runBlocking {
        var calls = 0
        try { readCurrentLeagues(owner, { owner }) { calls++; state.copy(leagueSelectionGeneration = 2) }; fail("wrong generation published") }
        catch (_: IllegalStateException) { }
        assertEquals(1, calls)
    }
    @Test fun `failure is returned without automatic mutation or read retry`() = runBlocking {
        // readCurrentLeagues itself never retries. The one SPEC §3.6 automatic retry is the card's, scheduled by
        // leagueAutoRetryDelay after this failure surfaces; this case still pins that the reader adds none.
        var calls = 0
        val failure = IllegalStateException("connection")
        try { readCurrentLeagues(owner, { owner }) { calls++; throw failure }; fail("failure hidden") }
        catch (caught: IllegalStateException) { assertSame(failure, caught) }
        assertEquals(1, calls)
    }

    // ---- SPEC §3.4: the in-card read ends after the loading timeout ----

    @Test fun `a read that does not answer is stopped at the loading timeout`() = runBlocking {
        // A hung GET must not leave the card on skeletons forever; false switches it to the error state.
        assertFalse(readBeforeLoadingTimeout(timeoutMs = 20) { awaitCancellation() })
    }
    @Test fun `a read that answers in time is accepted once`() = runBlocking {
        var calls = 0
        assertTrue(readBeforeLoadingTimeout(timeoutMs = 5_000) { calls++ })
        assertEquals(1, calls)
    }
    @Test fun `a failed read inside the timeout is reported as a failure not a timeout`() = runBlocking {
        val failure = IllegalStateException("connection")
        try { readBeforeLoadingTimeout(timeoutMs = 5_000) { throw failure }; fail("failure hidden as a timeout") }
        catch (caught: IllegalStateException) {
            // withTimeoutOrNull is a coroutine boundary: with assertions on (every Gradle test JVM) kotlinx-coroutines
            // stack-trace recovery rethrows a copy whose cause is the original. The original read failure must surface.
            assertTrue("the read's own failure surfaces", generateSequence<Throwable>(caught) { it.cause }.take(8).any { it === failure })
        }
    }
    @Test fun `an owner change during a timed read is not mistaken for a timeout`() = runBlocking {
        // Only the timeout's own cancellation becomes the error state; a stale owner must stay a silent cancellation.
        var current: HubLeagueScope? = owner
        try {
            readBeforeLoadingTimeout(timeoutMs = 5_000) {
                readCurrentLeagues(owner, { current }) { current = null; state }
            }
            fail("stale read reported as an answer or a timeout")
        } catch (_: CancellationException) { }
    }
}
