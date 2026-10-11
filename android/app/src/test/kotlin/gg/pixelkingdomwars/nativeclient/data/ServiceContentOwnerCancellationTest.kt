package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

/** Direct public Deferred.cancel() must not complete the actual cleanup barrier. */
class ServiceContentOwnerCancellationTest {
    private class Fixture(holdListeners: Boolean = false) {
        val failures = mutableListOf<Throwable>()
        val queued = ArrayDeque<suspend () -> Unit>()
        lateinit var suppliedToken: Deferred<Unit>
        private lateinit var afterListeners: () -> Unit
        var cleanupResult: Result<Unit>? = null
            private set
        val owner = ServiceContentOwner(
            retireAdmission = { token, afterInvalidated ->
                suppliedToken = token
                afterListeners = afterInvalidated
                if (!holdListeners) afterInvalidated()
                CompletableDeferred<Unit>()
            },
            launchCleanup = { queued.addLast(it) },
            onFailure = { failures += it },
        )

        fun drainListeners() = afterListeners()

        fun startCleanup() {
            queued.removeFirst().startCoroutine(object : Continuation<Unit> {
                override val context = EmptyCoroutineContext
                override fun resumeWith(result: Result<Unit>) { cleanupResult = result }
            })
        }
    }

    @Test fun `cancelling returned completion cannot bypass outstanding admission listeners`() = runBlocking<Unit> {
        val f = Fixture(holdListeners = true)
        var closes = 0
        f.owner.registerSource({}, { closes++ })
        val done = f.owner.requestRetirement()
        assertSame(f.suppliedToken, done)

        done.cancel()

        assertFalse(f.suppliedToken.isCompleted)
        assertFalse(done.isCancelled)
        assertEquals(0, closes)
        assertTrue(f.queued.isEmpty())
        assertSame(done, f.owner.requestRetirement())
        f.drainListeners()
        f.startCleanup()
        assertEquals(1, closes)
        assertTrue(f.cleanupResult?.isSuccess == true)
        assertTrue(done.isCompleted)
        done.await()
    }

    @Test fun `cancelling returned completion cannot bypass an unfinished open ticket`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        var closes = 0
        var completions = 0
        f.owner.registerSource({}, { closes++ })
        val done = f.owner.requestRetirement()
        assertSame(f.suppliedToken, done)
        done.invokeOnCompletion { completions++ }
        f.startCleanup()

        done.cancel()

        assertFalse(f.suppliedToken.isCompleted)
        assertFalse(done.isCancelled)
        assertEquals(0, completions)
        assertEquals(0, closes)
        assertNull(f.cleanupResult)
        ticket.close()
        assertEquals(1, closes)
        assertEquals(1, completions)
        assertTrue(f.cleanupResult?.isSuccess == true)
        assertTrue(done.isCompleted)
        done.await()
    }

    @Test fun `ignored observer cancellation does not hide actual cleanup failure`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        val failure = IllegalStateException("source cleanup failed")
        var closes = 0
        f.owner.registerSource({}, { closes++; throw failure })
        f.owner.registerSource({}, { closes++ })
        val done = f.owner.requestRetirement()
        assertSame(f.suppliedToken, done)

        done.cancel()
        f.startCleanup()

        assertFalse(f.suppliedToken.isCompleted)
        assertEquals(0, closes)
        assertNull(f.cleanupResult)
        ticket.close()
        assertEquals(2, closes)
        assertTrue(f.cleanupResult?.isSuccess == true)
        assertTrue(done.isCompleted)
        val actual = runCatching { done.await() }.exceptionOrNull()
        assertTrue(actual is IllegalStateException)
        assertEquals(failure.message, actual?.message)
        assertTrue(f.failures.any { it === failure })
        assertSame(done, f.owner.requestRetirement())
    }
}
