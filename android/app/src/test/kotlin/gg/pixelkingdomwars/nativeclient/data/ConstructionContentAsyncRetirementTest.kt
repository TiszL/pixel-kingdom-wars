package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import java.util.IdentityHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** Additive f4fd259e tests, pinned to MS-C interface SHA 505a2b5e377bcadb314837c2097ee13ccc36107eefa68d5f66996e1ce8274a6a.
 * No IO or acquisition: real source types, synthetic owner cleanup. At most one bounded
 * daemon worker per test; no sleeps, readers, polling, Main dispatcher replacement or device.
 * The 12 original admission and 7 synchronous retirement tests remain byte-identical.
 * Failure cases deliberately do not decide whether a staged positive may publish after failure. */
class ConstructionContentAsyncRetirementTest {
    private class Fixture {
        val sink = ConstructionContentAdmissions()
        val owner = Any()
        val job = SupervisorJob()
        val account = AccountSession("synthetic-wallet", "https://example.invalid", testToken())
        val content = ContentState()
        val source = ServiceContentSession(job, {}) { _, _ -> error("No acquisition") }
        private val sources = IdentityHashMap<Any, ServiceContentSession>().apply { put(owner, source) }

        fun begin(token: Any = owner) {
            val next = synchronized(sources) {
                sources[token] ?: ServiceContentSession(job, {}) { _, _ -> error("No acquisition") }
                    .also { sources[token] = it }
            }
            sink.beginOwner(token)
            sink.setSource(token, account, content, next)
            sink.permission(token, true)
        }

        fun close() {
            val owned = synchronized(sources) { sources.entries.map { it.key to it.value } }
            owned.forEach { (token, session) -> sink.clear(token); session.close() }
            job.cancel()
        }
    }

    private class Worker(block: () -> Unit) {
        private val failure = AtomicReference<Throwable?>()
        private val thread = Thread({
            try { block() } catch (error: Throwable) { failure.set(error) }
        }, "construction-retirement-test").apply { isDaemon = true; start() }

        fun finish() {
            thread.join(5_000)
            assertFalse("Bounded test worker must finish", thread.isAlive)
            failure.get()?.let { throw AssertionError("Test worker failed", it) }
        }
    }

    private fun await(latch: CountDownLatch) {
        assertTrue("Bounded test handshake must complete", latch.await(5, TimeUnit.SECONDS))
    }

    private suspend fun assertFailed(result: Deferred<Unit>) {
        var failure: Exception? = null
        try { result.await() } catch (error: Exception) { failure = error }
        assertNotNull("Retirement failure must be observable", failure)
        assertTrue(result.isCompleted)
    }

    @Test fun `callback return alone keeps retirement and the staged positive pending`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val next = Any()
        val order = mutableListOf<String>()
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val listener = f.sink.onInvalidated { order += "invalidate" }
            try {
                val done = requireNotNull(f.sink.retire(f.owner, cleanup) {
                    order += "schedule"; f.begin(next); assertNull(f.sink.state.value)
                })
                assertEquals(listOf("invalidate", "schedule"), order)
                assertFalse(done.isCompleted); assertTrue(cleanup.isActive)
                assertNull(f.sink.state.value); assertFalse(f.sink.isCurrent(old))
                order += "cleanup"; f.source.close(); cleanup.complete(Unit)
                done.await()
                val current = requireNotNull(f.sink.state.value)
                assertSame(next, current.ownerToken); assertTrue(f.sink.isCurrent(current))
                assertEquals(listOf("invalidate", "schedule", "cleanup"), order)
            } finally { listener.close() }
        } finally { f.close() }
    }

    @Test fun `precompleted owner token cannot publish before callback return`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>().apply { complete(Unit) }; val next = Any()
        var duringCallback: Deferred<Unit>? = null
        try {
            f.begin()
            val done = requireNotNull(f.sink.retire(f.owner, cleanup) {
                f.begin(next)
                duringCallback = f.sink.retire(f.owner, CompletableDeferred<Unit>()) { fail("Duplicate callback") }
                assertFalse(requireNotNull(duringCallback).isCompleted)
                assertNull(f.sink.state.value)
            })
            assertSame(done, duringCallback); done.await()
            assertSame(next, requireNotNull(f.sink.state.value).ownerToken)
        } finally { f.close() }
    }

    @Test fun `reentrant token completion still waits for the running callback to return`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val next = Any()
        val order = mutableListOf<String>()
        try {
            f.begin()
            val done = requireNotNull(f.sink.retire(f.owner, cleanup) {
                order += "enter"; f.begin(next); cleanup.complete(Unit)
                val joined = f.sink.retire(f.owner, CompletableDeferred<Unit>()) { fail("Duplicate callback") }
                assertFalse(requireNotNull(joined).isCompleted); assertNull(f.sink.state.value)
                order += "leave"
            })
            done.await(); assertEquals(listOf("enter", "leave"), order)
            assertSame(next, requireNotNull(f.sink.state.value).ownerToken)
        } finally { f.close() }
    }

    @Test fun `concurrent retire and clear join an outstanding listener before callback and token admission`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val next = Any()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val order = CopyOnWriteArrayList<String>(); val callbacks = AtomicInteger()
        f.begin(); val old = requireNotNull(f.sink.state.value)
        val first = f.sink.onInvalidated { order += "first-enter"; entered.countDown(); await(release); order += "first-leave" }
        val second = f.sink.onInvalidated { order += "second" }
        val worker = Worker { f.sink.permission(f.owner, false) }
        try {
            await(entered)
            val done = requireNotNull(f.sink.retire(f.owner, cleanup) { callbacks.incrementAndGet(); order += "callback" })
            f.sink.clear(f.owner); f.begin(next)
            val duplicate = f.sink.retire(f.owner, CompletableDeferred<Unit>().apply { complete(Unit) }) { fail("Duplicate callback") }
            assertSame(done, duplicate); assertFalse(done.isCompleted); assertEquals(0, callbacks.get())
            assertFalse(f.sink.isCurrent(old)); assertNull(f.sink.state.value)
            cleanup.complete(Unit)
            assertFalse(done.isCompleted); assertEquals(0, callbacks.get()); assertNull(f.sink.state.value)
            release.countDown(); worker.finish(); done.await()
            assertEquals(listOf("first-enter", "first-leave", "second", "callback"), order.toList())
            assertEquals(1, callbacks.get()); assertSame(next, requireNotNull(f.sink.state.value).ownerToken)
        } finally { release.countDown(); worker.finish(); first.close(); second.close(); f.close() }
    }

    @Test fun `reentrant retire and clear inside a listener retain the asynchronous barrier`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val next = Any()
        val order = mutableListOf<String>(); var done: Deferred<Unit>? = null
        try {
            f.begin()
            val first = f.sink.onInvalidated {
                order += "enter"
                done = f.sink.retire(f.owner, cleanup) { order += "callback"; f.begin(next) }
                f.sink.clear(f.owner)
                assertFalse(requireNotNull(done).isCompleted); assertNull(f.sink.state.value)
                order += "leave"
            }
            val second = f.sink.onInvalidated { order += "second" }
            try {
                f.sink.permission(f.owner, false)
                assertEquals(listOf("enter", "leave", "second", "callback"), order)
                assertFalse(requireNotNull(done).isCompleted); assertNull(f.sink.state.value)
                cleanup.complete(Unit); requireNotNull(done).await()
                assertSame(next, requireNotNull(f.sink.state.value).ownerToken)
            } finally { first.close(); second.close() }
        } finally { f.close() }
    }

    @Test fun `owner token can complete on a bounded worker after the callback returned`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val next = Any()
        val caller = Thread.currentThread(); val completedOn = AtomicReference<Thread?>()
        try {
            f.begin()
            val done = requireNotNull(f.sink.retire(f.owner, cleanup) { f.begin(next) })
            assertFalse(done.isCompleted); assertNull(f.sink.state.value)
            val worker = Worker {
                completedOn.set(Thread.currentThread())
                f.source.close(); cleanup.complete(Unit)
            }
            try { worker.finish(); done.await() } finally { worker.finish() }
            assertNotSame(caller, completedOn.get())
            val current = requireNotNull(f.sink.state.value)
            assertSame(next, current.ownerToken); assertTrue(f.sink.isCurrent(current))
        } finally { f.close() }
    }

    @Test fun `cancelling a returned observer neither cancels owner cleanup nor opens admission early`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val ignored = CompletableDeferred<Unit>(); val next = Any()
        var callbacks = 0
        try {
            f.begin()
            val done = requireNotNull(f.sink.retire(f.owner, cleanup) { callbacks++; f.begin(next) })
            done.cancel()
            val joined = f.sink.retire(f.owner, ignored) { fail("Duplicate callback") }
            assertSame(done, joined); assertEquals(1, callbacks)
            assertTrue(cleanup.isActive); assertTrue(ignored.isActive); assertNull(f.sink.state.value)
            f.source.close(); cleanup.complete(Unit)
            val current = requireNotNull(f.sink.state.first { it?.ownerToken === next })
            assertTrue(f.sink.isCurrent(current)); assertFalse(cleanup.isCancelled); assertTrue(ignored.isActive)
        } finally { f.close() }
    }

    @Test fun `duplicate retirement ignores a replacement completed token and callback`() = runTest {
        val f = Fixture(); val first = CompletableDeferred<Unit>(); val ignored = CompletableDeferred<Unit>().apply { complete(Unit) }
        val next = Any(); var callbacks = 0
        try {
            f.begin()
            val done = requireNotNull(f.sink.retire(f.owner, first) { callbacks++; f.begin(next) })
            val joined = f.sink.retire(f.owner, ignored) { fail("Replacement callback must not run") }
            assertSame(done, joined); assertEquals(1, callbacks)
            assertFalse(done.isCompleted); assertNull(f.sink.state.value)
            first.complete(Unit); done.await()
            assertEquals(1, callbacks); assertSame(next, requireNotNull(f.sink.state.value).ownerToken)
        } finally { f.close() }
    }

    @Test fun `stale retirement leaves the supplied token and replacement owner untouched`() = runTest {
        val f = Fixture(); val ignored = CompletableDeferred<Unit>(); val next = Any()
        try {
            f.begin(); f.begin(next); val current = requireNotNull(f.sink.state.value)
            assertNull(f.sink.retire(f.owner, ignored) { fail("Stale callback must not run") })
            assertSame(current, f.sink.state.value); assertTrue(f.sink.isCurrent(current)); assertTrue(ignored.isActive)
            ignored.complete(Unit)
            assertSame(current, f.sink.state.value); assertTrue(f.sink.isCurrent(current))
        } finally { f.close() }
    }

    @Test fun `callback failure remains pending until owner cleanup completes and preserves finally ordering`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val next = Any()
        val order = mutableListOf<String>()
        try {
            f.begin()
            val first = f.sink.onInvalidated { order += "first" }
            val second = f.sink.onInvalidated { order += "second" }
            try {
                val done = requireNotNull(f.sink.retire(f.owner, cleanup) {
                    try {
                        order += "callback"; f.begin(next); throw IllegalStateException("Synthetic scheduling failure")
                    } finally { order += "callback-finally" }
                })
                assertFalse(done.isCompleted); assertNull(f.sink.state.value)
                order += "owner-cleanup"; f.source.close(); cleanup.complete(Unit)
                assertFailed(done)
                assertEquals(listOf("first", "second", "callback", "callback-finally", "owner-cleanup"), order)
                // Post-failure staged-positive policy awaits a separate ruling.
            } finally { first.close(); second.close() }
        } finally { f.close() }
    }

    @Test fun `owner token failure follows all owned cleanup and resolves retirement exceptionally`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val next = Any()
        val order = mutableListOf<String>()
        try {
            f.begin()
            val done = requireNotNull(f.sink.retire(f.owner, cleanup) { order += "callback"; f.begin(next) })
            assertFalse(done.isCompleted); assertNull(f.sink.state.value)
            var error: Exception? = null
            try { order += "host"; throw IllegalStateException("Synthetic host cleanup failure") }
            catch (failure: Exception) { error = failure }
            finally { order += "permission"; order += "source"; f.source.close() }
            order += "complete"; cleanup.completeExceptionally(requireNotNull(error))
            assertFailed(done)
            assertEquals(listOf("callback", "host", "permission", "source", "complete"), order)
            // Only exception/ordering is asserted after failure, not replacement admission.
        } finally { f.close() }
    }

    @Test fun `already failed token still cannot end retirement inside its running callback`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>().apply {
            completeExceptionally(IllegalStateException("Synthetic previous cleanup failure"))
        }
        val next = Any(); val order = mutableListOf<String>()
        try {
            f.begin()
            val done = requireNotNull(f.sink.retire(f.owner, cleanup) {
                order += "enter"; f.begin(next)
                val joined = f.sink.retire(f.owner, CompletableDeferred<Unit>()) { fail("Duplicate callback") }
                assertFalse(requireNotNull(joined).isCompleted); assertNull(f.sink.state.value)
                order += "leave"
            })
            assertFailed(done); assertEquals(listOf("enter", "leave"), order)
        } finally { f.close() }
    }

    @Test fun `callback and token failures do not finish before both sides settle or repeat cleanup`() = runTest {
        val f = Fixture(); val cleanup = CompletableDeferred<Unit>(); val next = Any()
        val order = mutableListOf<String>(); var callbacks = 0
        try {
            f.begin()
            val done = requireNotNull(f.sink.retire(f.owner, cleanup) {
                callbacks++; f.begin(next)
                try { order += "callback"; throw IllegalStateException("Synthetic callback failure") }
                finally { order += "callback-finally" }
            })
            val joined = f.sink.retire(f.owner, CompletableDeferred<Unit>().apply { complete(Unit) }) { fail("Duplicate callback") }
            assertSame(done, joined); assertFalse(done.isCompleted); assertNull(f.sink.state.value)
            try { order += "cleanup" }
            finally { order += "cleanup-finally"; f.source.close() }
            cleanup.completeExceptionally(IllegalStateException("Synthetic cleanup failure"))
            assertFailed(done); assertEquals(1, callbacks)
            assertEquals(listOf("callback", "callback-finally", "cleanup", "cleanup-finally"), order)
        } finally { f.close() }
    }
}
