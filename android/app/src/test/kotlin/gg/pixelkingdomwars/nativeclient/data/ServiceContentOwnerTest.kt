package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.Continuation
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

/** The injected queue models Main dispatch without a thread, dispatcher, launch or real source.
 * C owns cleanupComplete; the sink's result and an observing waiter's Job cannot cancel it. */
class ServiceContentOwnerTest {
    private class Completion<T>(override val context: CoroutineContext = EmptyCoroutineContext) : Continuation<T> {
        var result: Result<T>? = null
            private set
        override fun resumeWith(result: Result<T>) {
            check(this.result == null) { "Continuation completed twice" }
            this.result = result
        }
    }

    private class CleanupQueue {
        private val blocks = ArrayDeque<suspend () -> Unit>()
        val size: Int get() = blocks.size
        fun enqueue(block: suspend () -> Unit) { blocks.addLast(block) }
        fun startNext(): Completion<Unit> = Completion<Unit>().also { blocks.removeFirst().startCoroutine(it) }
    }

    private class Fixture(private val stale: Boolean = false, private val holdListeners: Boolean = false) {
        val events = mutableListOf<String>()
        val failures = mutableListOf<Throwable>()
        val cleanup = CleanupQueue()
        val sinkResult = CompletableDeferred<Unit>()
        var sinkCalls = 0
            private set
        lateinit var suppliedToken: Deferred<Unit>
            private set
        private var afterListeners: (() -> Unit)? = null
        lateinit var owner: ServiceContentOwner
            private set

        init {
            owner = ServiceContentOwner(
                retireAdmission = { token, afterInvalidated ->
                    sinkCalls++
                    assertTrue("Admission sees retirement already fenced", owner.requested)
                    suppliedToken = token
                    events += "admission:revoked"
                    if (stale) null else {
                        afterListeners = {
                            events += "listeners:drained"
                            afterInvalidated()
                        }
                        if (!holdListeners) drainListeners()
                        sinkResult
                    }
                },
                launchCleanup = { block -> events += "cleanup:scheduled"; cleanup.enqueue(block) },
                onFailure = { failures += it },
            )
        }

        fun drainListeners() {
            val callback = requireNotNull(afterListeners)
            afterListeners = null
            callback()
        }

        fun source(name: String) {
            owner.registerSource(
                revoke = { assertTrue(owner.requested); events += "$name:revoke" },
                close = { events += "$name:close" },
            )
        }
    }

    private suspend fun assertFinished(completion: Deferred<Unit>) {
        assertTrue("Actual cleanup must complete the token", completion.isCompleted)
        completion.await()
    }

    @Test fun `retirement revokes immediately but waits for every admission listener before dispatching cleanup`() = runBlocking<Unit> {
        val f = Fixture(holdListeners = true)
        f.source("source")
        f.owner.beforeSourceClose { f.events += "host:clear" }
        f.owner.beforeSourceClose { f.events += "permission:close" }

        val retirement: ServiceContentRetirement = f.owner
        val done = retirement.requestRetirement()
        assertTrue(retirement.requested)
        assertTrue(f.events.contains("source:revoke"))
        assertTrue(f.events.contains("admission:revoked"))
        assertFalse(done.isCompleted)
        assertEquals(0, f.cleanup.size)
        assertFalse(f.events.any { it.endsWith(":close") || it == "host:clear" })

        f.drainListeners()
        assertEquals(1, f.cleanup.size)
        assertFalse(done.isCompleted)
        assertEquals(listOf("listeners:drained", "cleanup:scheduled"), f.events.takeLast(2))
        val cleanup = f.cleanup.startNext()
        assertTrue(cleanup.result?.isSuccess == true)
        assertEquals(listOf("host:clear", "permission:close", "source:close"), f.events.takeLast(3))
        assertFinished(done)
    }

    @Test fun `the cleanup token stays pending while an open ticket has not settled`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        f.source("partial")
        f.owner.beforeSourceClose { f.events += "host:clear" }
        val done = f.owner.requestRetirement()
        assertSame("The owner returns the exact cleanup token supplied to the sink", f.suppliedToken, done)
        assertNotSame(f.sinkResult, done)
        val cleanup = f.cleanup.startNext()

        assertNull(cleanup.result)
        assertFalse(done.isCompleted)
        assertFalse(f.events.contains("host:clear"))
        assertFalse(f.events.contains("partial:close"))
        ticket.close()
        assertTrue(cleanup.result?.isSuccess == true)
        assertEquals(listOf("host:clear", "partial:close"), f.events.takeLast(2))
        assertFinished(done)
    }

    @Test fun `late source and permission registration cannot disappear after cleanup starts waiting for the open`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        f.owner.beforeSourceClose { f.events += "host:clear" }
        f.source("early")
        val done = f.owner.requestRetirement()
        val cleanup = f.cleanup.startNext()
        assertNull(cleanup.result)

        f.source("late")
        assertEquals("late:revoke", f.events.last())
        f.owner.beforeSourceClose { f.events += "permission:close" }
        assertFalse(done.isCompleted)
        assertFalse(f.events.contains("late:close"))
        ticket.close()

        assertEquals(listOf("host:clear", "permission:close", "early:close", "late:close"), f.events.takeLast(4))
        assertEquals(1, f.events.count { it == "late:revoke" })
        assertTrue(cleanup.result?.isSuccess == true)
        assertFinished(done)
    }

    @Test fun `duplicate requests and duplicate ticket close cannot dispatch or close resources twice`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        f.source("source")
        f.owner.beforeSourceClose { f.events += "permission:close" }
        val first = f.owner.requestRetirement()
        assertSame(first, f.owner.requestRetirement())
        assertEquals(1, f.sinkCalls)
        assertEquals(1, f.cleanup.size)
        val cleanup = f.cleanup.startNext()
        ticket.close()
        ticket.close()
        assertSame(first, f.owner.requestRetirement())

        assertEquals(1, f.events.count { it == "source:revoke" })
        assertEquals(1, f.events.count { it == "source:close" })
        assertEquals(1, f.events.count { it == "permission:close" })
        assertEquals(0, f.cleanup.size)
        assertTrue(cleanup.result?.isSuccess == true)
        assertFinished(first)
    }

    @Test fun `every physical cleanup runs after earlier cleanup throws and completion records failure`() = runBlocking<Unit> {
        val f = Fixture()
        val hostFailure = IllegalStateException("host cleanup failed")
        val sourceFailure = IllegalArgumentException("first source cleanup failed")
        f.owner.beforeSourceClose { f.events += "host:clear"; throw hostFailure }
        f.owner.beforeSourceClose { f.events += "permission:close" }
        f.owner.registerSource({}, { f.events += "first:close"; throw sourceFailure })
        f.source("second")
        val done = f.owner.requestRetirement()
        f.cleanup.startNext()

        assertEquals(listOf("host:clear", "permission:close", "first:close", "second:close"), f.events.takeLast(4))
        assertTrue(done.isCompleted)
        assertNotNull(runCatching { done.await() }.exceptionOrNull())
        assertTrue("Cleanup failure must be reported", f.failures.isNotEmpty())
        assertSame(done, f.owner.requestRetirement())
        assertEquals(1, f.events.count { it == "first:close" })
        assertEquals(1, f.events.count { it == "second:close" })
    }

    @Test fun `a throwing logical revoker cannot skip other revokers admission drain or physical cleanup`() = runBlocking<Unit> {
        val f = Fixture()
        val failure = IllegalStateException("logical revocation failed")
        f.owner.registerSource({ f.events += "first:revoke"; throw failure }, { f.events += "first:close" })
        f.source("second")
        val done = f.owner.requestRetirement()
        assertTrue(f.events.contains("second:revoke"))
        assertTrue(f.events.contains("listeners:drained"))
        assertEquals(1, f.cleanup.size)
        f.cleanup.startNext()

        assertEquals(listOf("first:close", "second:close"), f.events.takeLast(2))
        assertTrue(done.isCompleted)
        assertNotNull(runCatching { done.await() }.exceptionOrNull())
        assertTrue(f.failures.isNotEmpty())
    }

    @Test fun `a stale admission sink still retires its own resources after the open settles`() = runBlocking<Unit> {
        val f = Fixture(stale = true)
        val ticket = f.owner.beginOpen()
        var replacementCloses = 0
        val replacement = Fixture()
        replacement.owner.registerSource({}, { replacementCloses++ })
        f.source("stale")
        f.owner.beforeSourceClose { f.events += "old-host:clear" }
        val done = f.owner.requestRetirement()
        assertFalse(f.events.contains("listeners:drained"))
        assertEquals(1, f.cleanup.size)
        val cleanup = f.cleanup.startNext()
        assertNull(cleanup.result)
        ticket.close()

        assertEquals(listOf("old-host:clear", "stale:close"), f.events.takeLast(2))
        assertEquals(0, replacementCloses)
        assertFalse(replacement.owner.requested)
        assertFinished(done)
    }

    @Test fun `an already cancelled owner requests retirement with its reserved ticket still outstanding`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        val account = Job().also { it.cancel() }
        f.owner.bindOwner(account)

        assertTrue(f.owner.requested)
        assertEquals(1, f.sinkCalls)
        val done = f.owner.requestRetirement()
        val cleanup = f.cleanup.startNext()
        assertNull(cleanup.result)
        f.source("late-open")
        assertEquals("late-open:revoke", f.events.last())
        assertFalse(done.isCompleted)
        ticket.close()
        assertEquals(1, f.events.count { it == "late-open:close" })
        assertFinished(done)
    }

    @Test fun `owner cancellation fences sources synchronously and does not cancel the cleanup token`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        val account = Job()
        f.owner.bindOwner(account)
        f.source("source")
        account.cancel()

        assertTrue(f.owner.requested)
        assertTrue(f.events.contains("source:revoke"))
        val done = f.owner.requestRetirement()
        assertFalse(done.isCancelled)
        val cleanup = f.cleanup.startNext()
        assertNull(cleanup.result)
        ticket.close()
        assertFinished(done)
    }

    @Test fun `cancelling an observing waiter leaves cleanup pending and able to finish`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        f.source("source")
        val done = f.owner.requestRetirement()
        val observer = Job()
        val waiter = Completion<Unit>(observer)
        val observe: suspend () -> Unit = { done.await() }
        observe.startCoroutine(waiter)
        assertNull(waiter.result)
        observer.cancel()

        assertTrue(waiter.result?.exceptionOrNull() is CancellationException)
        assertFalse(done.isCompleted)
        assertFalse(done.isCancelled)
        assertSame(done, f.owner.requestRetirement())
        f.cleanup.startNext()
        ticket.close()
        assertEquals(1, f.events.count { it == "source:close" })
        assertFinished(done)
    }

    @Test fun `the sink result cannot substitute for or cancel the owners cleanup completion`() = runBlocking<Unit> {
        val f = Fixture()
        val ticket = f.owner.beginOpen()
        f.source("source")
        val done = f.owner.requestRetirement()
        f.sinkResult.cancel()

        assertNotSame(f.sinkResult, done)
        assertSame(f.suppliedToken, done)
        assertFalse(done.isCompleted)
        val cleanup = f.cleanup.startNext()
        assertNull(cleanup.result)
        ticket.close()
        assertFinished(done)
    }

    @Test fun `registration after terminal cleanup is rejected or disposed instead of silently retained`() = runBlocking<Unit> {
        val f = Fixture()
        val done = f.owner.requestRetirement()
        f.cleanup.startNext()
        assertFinished(done)
        var revoked = 0
        var closed = 0
        val registration = runCatching { f.owner.registerSource({ revoked++ }, { closed++ }) }

        if (registration.isSuccess) {
            assertEquals("Accepted late sources must be logically revoked", 1, revoked)
            assertEquals("Accepted late sources must be physically disposed", 1, closed)
        } else {
            assertNotNull(registration.exceptionOrNull())
        }
        assertSame(done, f.owner.requestRetirement())
        assertEquals(1, f.sinkCalls)
    }
}
