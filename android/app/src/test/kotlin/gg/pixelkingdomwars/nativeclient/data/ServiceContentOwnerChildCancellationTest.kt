package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

/** A consumer's ordinary child must not turn the owned cleanup barrier into a cancellable parent. */
class ServiceContentOwnerChildCancellationTest {
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

    @Test fun `observer child failure cannot bypass outstanding admission listeners`() = runBlocking<Unit> {
        val f = Fixture(holdListeners = true)
        var closes = 0
        f.owner.registerSource({}, { closes++ })
        val done = f.owner.requestRetirement()
        assertSame(f.suppliedToken, done)

        CompletableDeferred<Unit>(done).completeExceptionally(IllegalStateException("observer"))

        assertFalse(f.suppliedToken.isCompleted)
        assertFalse(done.isCancelled)
        assertEquals(0, closes)
        assertTrue(f.queued.isEmpty())
        f.drainListeners()
        f.startCleanup()
        assertEquals(1, closes)
        assertTrue(f.cleanupResult?.isSuccess == true)
        assertTrue(done.isCompleted)
        done.await()
        assertSame(done, f.owner.requestRetirement())
        assertEquals(1, closes)
    }

    @Test fun `observer child failure cannot settle a barrier waiting for an open ticket`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        var closes = 0
        var completions = 0
        f.owner.registerSource({}, { closes++ })
        val done = f.owner.requestRetirement()
        assertSame(f.suppliedToken, done)
        done.invokeOnCompletion { completions++ }
        f.startCleanup()

        CompletableDeferred<Unit>(done).completeExceptionally(IllegalStateException("observer"))

        assertFalse(f.suppliedToken.isCompleted)
        assertFalse(done.isCancelled)
        assertEquals(0, completions)
        assertEquals(0, closes)
        assertNull(f.cleanupResult)
        ticket.close()
        ticket.close()
        assertEquals(1, closes)
        assertEquals(1, completions)
        assertTrue(f.cleanupResult?.isSuccess == true)
        assertTrue(done.isCompleted)
        done.await()
    }

    @Test fun `isolated observer child failure cannot replace the real cleanup failure`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        val cleanupFailure = IllegalStateException("source cleanup failed")
        var closes = 0
        f.owner.registerSource({}, { closes++; throw cleanupFailure })
        f.owner.registerSource({}, { closes++ })
        val done = f.owner.requestRetirement()
        assertSame(f.suppliedToken, done)
        f.startCleanup()

        CompletableDeferred<Unit>(done).completeExceptionally(IllegalArgumentException("observer"))

        assertFalse(f.suppliedToken.isCompleted)
        assertEquals(0, closes)
        assertNull(f.cleanupResult)
        ticket.close()
        assertEquals(2, closes)
        assertTrue(f.cleanupResult?.isSuccess == true)
        assertTrue(done.isCompleted)
        val actual = runCatching { done.await() }.exceptionOrNull()
        assertTrue(actual is IllegalStateException)
        assertEquals(cleanupFailure.message, actual?.message)
        assertTrue(f.failures.any { it === cleanupFailure })
        assertSame(done, f.owner.requestRetirement())
        assertEquals(2, closes)
    }
}
