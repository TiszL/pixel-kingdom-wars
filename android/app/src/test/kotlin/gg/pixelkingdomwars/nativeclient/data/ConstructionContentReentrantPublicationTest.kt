package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import java.util.IdentityHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import org.junit.Assert.*
import org.junit.Test

/** Additive regressions against reviewed source e3d25b3c, MS-C interface 505a2b5e.
 * Unconfined collectors deliberately resume inside a publishing call. No reflection,
 * acquisition, app dispatcher replacement or source execution seam is used. Worker probes
 * call only public isCurrent; each is bounded and joined after the outer operation unwinds.
 * These plain JUnit methods avoid a surrounding coroutine event loop deferring reentry. */
class ConstructionContentReentrantPublicationTest {
    private class Fixture {
        val sink = ConstructionContentAdmissions()
        val owner = Any()
        private val job = SupervisorJob()
        private val account = AccountSession("synthetic-wallet", "https://example.invalid", testToken())
        private val content = ContentState()
        private val sources = IdentityHashMap<Any, ServiceContentSession>()
        private val observerFailure = AtomicReference<Throwable?>()
        private val probeFailure = AtomicReference<Throwable?>()
        private val workers = mutableListOf<Thread>()
        val scope = CoroutineScope(job + Dispatchers.Unconfined + CoroutineExceptionHandler { _, error ->
            observerFailure.compareAndSet(null, error)
        })
        var probes = 0
            private set

        fun source(token: Any): ServiceContentSession = sources[token]
            ?: ServiceContentSession(job, {}) { _, _ -> error("No acquisition") }.also { sources[token] = it }

        fun begin(token: Any = owner) {
            sink.beginOwner(token); sink.setSource(token, account, content, source(token)); sink.permission(token, true)
        }

        fun denied(token: Any = owner) {
            sink.beginOwner(token); sink.setSource(token, account, content, source(token))
        }

        fun assertObserverHealthy() {
            observerFailure.get()?.let { throw AssertionError("Unconfined collector failed", it) }
        }

        fun assertLockFree(retired: ConstructionContentAdmission) {
            probes++
            val completed = CountDownLatch(1)
            val worker = Thread({
                try { assertFalse(sink.isCurrent(retired)) }
                catch (error: Throwable) { probeFailure.compareAndSet(null, error) }
                finally { completed.countDown() }
            }, "construction-sink-lock-probe").apply { isDaemon = true }
            workers += worker; worker.start()
            assertTrue("A second-thread isCurrent probe must finish while this callback runs",
                completed.await(5, TimeUnit.SECONDS))
            probeFailure.get()?.let { throw AssertionError("Lock probe failed", it) }
        }

        fun close() {
            job.cancel() // Stop the collectors before fixture teardown publishes anything.
            sources.forEach { (token, source) -> sink.clear(token); source.close() }
            workers.forEach { worker ->
                worker.join(5_000)
                assertFalse("Bounded lock probe must terminate after publisher unwinds", worker.isAlive)
            }
        }
    }

    @Test fun `null collector cannot publish a successor before retirement listeners or cleanup complete`() {
        val f = Fixture(); val next = Any(); val cleanup = CompletableDeferred<Unit>()
        var armed = false; var staged = false; var listeners = 0; var callbacks = 0
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val listener = f.sink.onInvalidated { listeners++; assertNull(f.sink.state.value) }
            val collector = f.scope.launch(start = CoroutineStart.UNDISPATCHED) {
                f.sink.state.collect { value ->
                    if (armed && value == null) {
                        armed = false; staged = true
                        assertEquals("Null reentry occurs before the outer listener pass", 0, listeners)
                        f.begin(next)
                        f.sink.state.value?.let { assertFalse("Staged successor must not be current", f.sink.isCurrent(it)) }
                        assertNull("Successor must stay unpublished during retirement", f.sink.state.value)
                        assertFalse(f.sink.isCurrent(old))
                    }
                }
            }
            try {
                armed = true
                val done = requireNotNull(f.sink.retire(f.owner, cleanup) { callbacks++ })
                f.assertObserverHealthy()
                assertTrue(staged); assertEquals(1, listeners); assertEquals(1, callbacks)
                assertFalse(done.isCompleted); assertNull(f.sink.state.value)
                cleanup.complete(Unit)
                f.assertObserverHealthy(); assertTrue(done.isCompleted)
                val current = requireNotNull(f.sink.state.value)
                assertSame(next, current.ownerToken); assertTrue(f.sink.isCurrent(current))
            } finally { collector.cancel(); listener.close() }
        } finally { f.close() }
    }

    @Test fun `successor publication collector retires with listeners and cleanup outside the outer sink lock`() {
        val f = Fixture(); val next = Any(); val firstCleanup = CompletableDeferred<Unit>()
        val nextCleanup = CompletableDeferred<Unit>().apply { complete(Unit) }
        var observed: ConstructionContentAdmission? = null; var secondResult: Deferred<Unit>? = null
        var reentered = false; val order = mutableListOf<String>()
        try {
            f.begin()
            val listener = f.sink.onInvalidated {
                observed?.let { order += "listener"; f.assertLockFree(it) }
            }
            val collector = f.scope.launch(start = CoroutineStart.UNDISPATCHED) {
                f.sink.state.collect { value ->
                    if (!reentered && value != null && value.ownerToken === next && value.permitted) {
                        reentered = true; observed = value; order += "publication"
                        secondResult = f.sink.retire(next, nextCleanup) {
                            order += "cleanup"; f.assertLockFree(requireNotNull(observed))
                        }
                    }
                }
            }
            try {
                val firstResult = requireNotNull(f.sink.retire(f.owner, firstCleanup) { f.begin(next) })
                assertFalse(firstResult.isCompleted); assertNull(f.sink.state.value)
                firstCleanup.complete(Unit)
                f.assertObserverHealthy()
                assertTrue(reentered); assertTrue(firstResult.isCompleted)
                assertTrue(requireNotNull(secondResult).isCompleted)
                assertEquals(listOf("publication", "listener", "cleanup"), order)
                assertEquals(2, f.probes); assertNull(f.sink.state.value)
                assertFalse(f.sink.isCurrent(requireNotNull(observed)))
            } finally { collector.cancel(); listener.close() }
        } finally { f.close() }
    }

    @Test fun `direct permission publication also defers reentrant retirement callbacks outside the publisher lock`() {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>().apply { complete(Unit) }
        var observed: ConstructionContentAdmission? = null; var result: Deferred<Unit>? = null
        var reentered = false; val order = mutableListOf<String>()
        try {
            f.denied()
            val listener = f.sink.onInvalidated {
                observed?.let { order += "listener"; f.assertLockFree(it) }
            }
            val collector = f.scope.launch(start = CoroutineStart.UNDISPATCHED) {
                f.sink.state.collect { value ->
                    if (!reentered && value != null && value.ownerToken === f.owner && value.permitted) {
                        reentered = true; observed = value; order += "publication"
                        result = f.sink.retire(f.owner, cleanup) {
                            order += "cleanup"; f.assertLockFree(requireNotNull(observed))
                        }
                    }
                }
            }
            try {
                f.sink.permission(f.owner, true)
                f.assertObserverHealthy()
                assertTrue(reentered); assertTrue(requireNotNull(result).isCompleted)
                assertEquals(listOf("publication", "listener", "cleanup"), order)
                assertEquals(2, f.probes); assertNull(f.sink.state.value)
                assertFalse(f.sink.isCurrent(requireNotNull(observed)))
            } finally { collector.cancel(); listener.close() }
        } finally { f.close() }
    }
}
