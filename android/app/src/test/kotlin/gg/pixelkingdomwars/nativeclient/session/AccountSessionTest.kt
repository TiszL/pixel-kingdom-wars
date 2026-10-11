package gg.pixelkingdomwars.nativeclient.session

import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.signedIn
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.testToken
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

/** One identity, one scope: replacing the identity cancels everything the old one launched. */
class AccountSessionTest {
    @Test fun `replacing the session cancels the previous scope before the new one exists`() = runBlocking {
        val holder = testHolder()
        val first = signedIn(holder, "walletA")
        val scope = requireNotNull(holder.scopeOf(first))
        val started = CompletableDeferred<Unit>(); var cancelled: Throwable? = null
        val work = scope.launch { started.complete(Unit); try { awaitCancellation() } catch (e: CancellationException) { cancelled = e; throw e } }
        started.await()
        val second = signedIn(holder, "walletB")
        work.join()
        assertTrue("Old work ends with the supersession signal", cancelled is SessionSupersededException)
        assertFalse(scope.active); assertNull(holder.scopeOf(first)); assertNotNull(holder.scopeOf(second))
        assertSame(second, holder.current)
    }
    @Test fun `publish rule drops results captured for a stale identity`() {
        val holder = testHolder()
        val captured = signedIn(holder)
        assertEquals("applied", holder.publish(captured) { "applied" })
        signedIn(holder, "other")
        assertNull(holder.publish(captured) { "applied" })
        assertThrows(SessionSupersededException::class.java) { holder.requireCurrent(captured) }
    }
    @Test fun `sign out replaces with null and cancels the scope`() {
        val holder = testHolder()
        val session = signedIn(holder)
        val scope = requireNotNull(holder.scopeOf(session))
        assertNull(holder.replace(null))
        assertFalse(scope.active); assertNull(holder.current); assertNull(holder.session.value)
    }
    @Test fun `sessions are identity by reference even for the same wallet`() {
        val holder = testHolder()
        val first = signedIn(holder)
        val again = AccountSession(first.wallet, first.origin, testToken())
        holder.replace(again)
        assertFalse(holder.isCurrent(first)); assertTrue(holder.isCurrent(again))
        assertThrows(IllegalArgumentException::class.java) { AccountSession("", "https://x", testToken()) }
    }
    @Test fun `a scope child failure does not cancel sibling account work`() = runBlocking {
        val holder = testHolder()
        val scope = requireNotNull(holder.scopeOf(signedIn(holder)))
        val sibling = scope.async { delay(20); "done" }
        val failure = IllegalStateException("one poller died")
        val observed = CompletableDeferred<Throwable>()
        // Own the deliberately failed child; an unhandled test exception leaks into later runTest scopes.
        val failing = scope.launch(CoroutineExceptionHandler { _, error -> observed.complete(error) }) { throw failure }
        failing.join()
        assertSame(failure, observed.await()); assertTrue(failing.isCancelled)
        assertEquals("done", sibling.await()); assertTrue(scope.active)
        assertNull(holder.replace(null))
    }
}
