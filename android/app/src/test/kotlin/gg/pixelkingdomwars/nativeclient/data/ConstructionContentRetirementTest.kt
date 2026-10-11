package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** b649fbbd orchestration contract only; fake source never acquires files. No device proof. */
class ConstructionContentRetirementTest {
    private class Fixture {
        val sink = ConstructionContentAdmissions()
        val owner = Any()
        val job = SupervisorJob()
        val account = AccountSession("synthetic-wallet", "https://example.invalid", testToken())
        val content = ContentState()
        val source = ServiceContentSession(job, {}) { _, _ -> error("No IO") }
        fun begin(token: Any = owner) {
            sink.beginOwner(token); sink.setSource(token, account, content, source); sink.permission(token, true)
        }
        fun close() { sink.clear(owner); source.close(); job.cancel() }
    }

    @Test fun `retirement continuation follows every listener exactly once while admission stays closed`() {
        val f = Fixture(); val order = mutableListOf<String>()
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val a = f.sink.onInvalidated { order += "a"; assertFalse(f.sink.isCurrent(old)); assertTrue(f.source.assets.isCurrent()) }
            val b = f.sink.onInvalidated { order += "b"; assertNull(f.sink.state.value) }
            try {
                val done = f.sink.retire(f.owner) { order += "close"; assertNull(f.sink.state.value); f.source.close() }
                assertEquals(listOf("a", "b", "close"), order); assertTrue(requireNotNull(done).isCompleted)
                assertNull(f.sink.state.value); assertFalse(f.sink.isCurrent(old))
                assertNull(f.sink.retire(f.owner) { fail("Completed stale owner must not close again") })
            } finally { a.close(); b.close() }
        } finally { f.close() }
    }

    @Test fun `concurrent retirement joins active invalidation without waiting or closing the source early`() {
        val f = Fixture(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>(); var closes = 0
        f.begin(); val old = requireNotNull(f.sink.state.value)
        val listener = f.sink.onInvalidated { entered.countDown(); check(release.await(2, TimeUnit.SECONDS)) }
        val worker = Thread { try { f.sink.permission(f.owner, false) } catch (t: Throwable) { failure.set(t) } }.apply { isDaemon = true }
        try {
            worker.start(); assertTrue(entered.await(1, TimeUnit.SECONDS))
            val done = requireNotNull(f.sink.retire(f.owner) { closes++; f.source.close() })
            assertFalse(done.isCompleted); assertEquals(0, closes); assertTrue(f.source.assets.isCurrent())
            assertNull(f.sink.state.value); assertFalse(f.sink.isCurrent(old))
            val joined = f.sink.retire(f.owner) { fail("Joined callback must not run") }
            assertSame(done, joined)
            release.countDown(); worker.join(2_000); assertFalse(worker.isAlive); assertNull(failure.get())
            assertTrue(done.isCompleted); assertEquals(1, closes)
        } finally { release.countDown(); worker.join(2_000); listener.close(); f.close() }
    }

    @Test fun `reentrant retire and clear inside listener defer close until the listener returns`() {
        val f = Fixture(); val order = mutableListOf<String>(); var done: Deferred<Unit>? = null
        try {
            f.begin()
            val listener = f.sink.onInvalidated {
                order += "enter"
                done = f.sink.retire(f.owner) { order += "close"; f.source.close() }
                f.sink.clear(f.owner)
                assertFalse(requireNotNull(done).isCompleted); assertTrue(f.source.assets.isCurrent())
                order += "leave"
            }
            try { f.sink.permission(f.owner, false) } finally { listener.close() }
            assertEquals(listOf("enter", "leave", "close"), order); assertTrue(requireNotNull(done).isCompleted)
        } finally { f.close() }
    }

    @Test fun `new positive owner is withheld through the retiring continuation`() {
        val f = Fixture(); val next = Any(); val order = mutableListOf<String>()
        try {
            f.begin()
            val listener = f.sink.onInvalidated { order += "invalidated"; f.begin(next); assertNull(f.sink.state.value) }
            try {
                f.sink.retire(f.owner) { order += "retired"; assertNull(f.sink.state.value) }
                val current = requireNotNull(f.sink.state.value)
                assertSame(next, current.ownerToken); assertTrue(f.sink.isCurrent(current))
                assertEquals(listOf("invalidated", "retired"), order)
            } finally { listener.close(); f.sink.clear(next) }
        } finally { f.close() }
    }

    @Test fun `new retirement requested from a continuation drains before publishing its successor`() {
        val f = Fixture(); val next = Any(); val last = Any(); val order = mutableListOf<String>()
        try {
            f.begin()
            f.sink.retire(f.owner) {
                order += "old"; f.begin(next); assertNull(f.sink.state.value)
                val joined = f.sink.retire(next) { order += "next"; assertNull(f.sink.state.value); f.begin(last) }
                assertFalse(requireNotNull(joined).isCompleted)
            }
            assertEquals(listOf("old", "next"), order)
            assertSame(last, requireNotNull(f.sink.state.value).ownerToken)
            f.sink.clear(last)
        } finally { f.close() }
    }

    @Test fun `stale owner cannot register cleanup or clear the current owner`() {
        val f = Fixture(); val next = Any()
        try {
            f.begin(); f.begin(next); val current = requireNotNull(f.sink.state.value)
            assertNull(f.sink.retire(f.owner) { fail("stale cleanup") })
            assertSame(current, f.sink.state.value); assertTrue(f.sink.isCurrent(current))
            f.sink.clear(next)
        } finally { f.close() }
    }

    @Test fun `owner begun before async source open can retire exactly once without an observation`() {
        val f = Fixture(); var calls = 0
        try {
            f.sink.beginOwner(f.owner)
            val done = f.sink.retire(f.owner) { calls++; assertNull(f.sink.state.value) }
            assertEquals(1, calls); assertTrue(requireNotNull(done).isCompleted)
            f.sink.setSource(f.owner, f.account, f.content, f.source); f.sink.permission(f.owner, true)
            assertNull(f.sink.state.value)
        } finally { f.close() }
    }
}
