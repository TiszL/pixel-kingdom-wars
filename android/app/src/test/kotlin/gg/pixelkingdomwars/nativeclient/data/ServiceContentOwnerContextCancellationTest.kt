package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.Continuation
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

/** CoroutineContext operations must keep the protected view instead of exposing its completer. */
class ServiceContentOwnerContextCancellationTest {
    private class Fixture {
        private lateinit var cleanup: suspend () -> Unit
        lateinit var suppliedToken: Deferred<Unit>
        var closes = 0
            private set
        var cleanupResult: Result<Unit>? = null
            private set
        val owner = ServiceContentOwner(
            retireAdmission = { token, afterInvalidated ->
                suppliedToken = token
                afterInvalidated()
                CompletableDeferred<Unit>()
            },
            launchCleanup = { cleanup = it },
        )
        val ticket = owner.beginOpen()
        init { owner.registerSource({}, { closes++ }) }
        val done = owner.requestRetirement()

        fun startCleanup() {
            cleanup.startCoroutine(object : Continuation<Unit> {
                override val context = EmptyCoroutineContext
                override fun resumeWith(result: Result<Unit>) { cleanupResult = result }
            })
        }
    }

    @Test fun `job lookup cannot expose a cancellable cleanup completer`() = runBlocking<Unit> {
        val f = Fixture()
        f.startCleanup()
        val exposed = requireNotNull(f.done[Job])

        exposed.cancel()

        assertSame(f.done, exposed)
        assertSame(f.done, f.suppliedToken)
        assertFalse(f.suppliedToken.isCompleted)
        assertFalse(f.done.isCancelled)
        assertEquals(0, f.closes)
        assertNull(f.cleanupResult)
        f.ticket.close()
        assertEquals(1, f.closes)
        assertTrue(f.cleanupResult?.isSuccess == true)
        assertTrue(f.done.isCompleted)
        f.done.await()
    }

    @Test fun `context composition folding and key removal preserve the protected job`() = runBlocking<Unit> {
        val f = Fixture()
        f.startCleanup()
        val named = f.done + CoroutineName("cleanup observer")
        val folded = named.fold<CoroutineContext>(EmptyCoroutineContext) { context, element -> context + element }
        val withoutName = folded.minusKey(CoroutineName)

        requireNotNull(named[Job]).cancel()
        requireNotNull(folded[Job]).cancel()
        requireNotNull(withoutName[Job]).cancel()

        assertSame(f.done, named[Job])
        assertSame(f.done, folded[Job])
        assertSame(f.done, withoutName[Job])
        assertNull(withoutName[CoroutineName])
        assertNull(named.minusKey(Job)[Job])
        assertEquals("cleanup observer", named.minusKey(Job)[CoroutineName]?.name)
        assertSame(f.done, f.suppliedToken)
        assertFalse(f.suppliedToken.isCompleted)
        assertFalse(f.done.isCancelled)
        assertEquals(0, f.closes)
        assertNull(f.cleanupResult)
        f.ticket.close()
        assertEquals(1, f.closes)
        assertTrue(f.cleanupResult?.isSuccess == true)
        assertTrue(f.done.isCompleted)
        f.done.await()
    }
}
