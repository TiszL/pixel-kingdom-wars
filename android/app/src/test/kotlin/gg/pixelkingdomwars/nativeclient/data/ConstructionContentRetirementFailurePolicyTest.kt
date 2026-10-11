package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import java.util.IdentityHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** Additive B/C failure-discharge agreement: MS-C 0560c081 under review e613ec93,
 * retaining the exact three-argument API in MS-C interface SHA 505a2b5e377bcadb314837c2097ee13ccc36107eefa68d5f66996e1ce8274a6a.
 * Failure discards staged owner AND observation only after every retirement has settled.
 * Pure synthetic lifecycle tests: no acquisition, worker, IO, polling or automatic retry. */
class ConstructionContentRetirementFailurePolicyTest {
    private class Fixture {
        val sink = ConstructionContentAdmissions()
        val owner = Any()
        private val job = SupervisorJob()
        private val account = AccountSession("synthetic-wallet", "https://example.invalid", testToken())
        private val content = ContentState()
        private val sources = IdentityHashMap<Any, ServiceContentSession>()

        private fun source(token: Any): ServiceContentSession = sources[token]
            ?: ServiceContentSession(job, {}) { _, _ -> error("No acquisition") }.also { sources[token] = it }

        fun publish(token: Any) {
            sink.setSource(token, account, content, source(token)); sink.permission(token, true)
        }

        fun begin(token: Any = owner) { sink.beginOwner(token); publish(token) }
        fun closeSource(token: Any) { sources[token]?.close() }

        fun assertDiscardedThenRecover(discarded: Any, old: ConstructionContentAdmission) {
            assertNull(sink.state.value); assertFalse(sink.isCurrent(old))
            publish(discarded)
            sink.permission(discarded, false); sink.permission(discarded, true)
            assertNull("Discarded activeOwner must not survive as a hidden publication capability", sink.state.value)
            val fresh = Any()
            begin(fresh)
            val current = requireNotNull(sink.state.value)
            assertSame(fresh, current.ownerToken); assertTrue(sink.isCurrent(current))
            publish(discarded)
            assertSame("Late discarded-owner results cannot replace explicit recovery", current, sink.state.value)
            assertTrue(sink.isCurrent(current)); assertFalse(sink.isCurrent(old))
        }

        fun close() {
            sources.forEach { (token, session) -> sink.clear(token); session.close() }
            job.cancel()
        }
    }

    private suspend fun assertFailure(result: Deferred<Unit>) {
        assertTrue("All retirement work must settle before the result is final", result.isCompleted)
        var failure: Exception? = null
        try { result.await() } catch (error: Exception) { failure = error }
        assertNotNull("Failed retirement must remain exceptional", failure)
    }

    @Test fun `callback failure discards an independently staged positive and requires explicit recovery`() = runTest {
        val f = Fixture(); val token = CompletableDeferred<Unit>(); val staged = Any()
        val order = mutableListOf<String>()
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val done = requireNotNull(f.sink.retire(f.owner, token) {
                try {
                    order += "callback"; f.begin(staged)
                    throw IllegalStateException("Synthetic callback failure")
                } finally { order += "source-finally"; f.closeSource(f.owner) }
            })
            assertEquals(listOf("callback", "source-finally"), order)
            assertFalse(done.isCompleted); assertNull(f.sink.state.value)
            order += "owner-complete"; token.complete(Unit)
            assertFailure(done)
            assertEquals(listOf("callback", "source-finally", "owner-complete"), order)
            f.assertDiscardedThenRecover(staged, old)
            assertEquals("Recovery must not retry failed cleanup", 3, order.size)
        } finally { f.close() }
    }

    @Test fun `token failure completes all owned cleanup then discards the staged independent owner`() = runTest {
        val f = Fixture(); val token = CompletableDeferred<Unit>(); val staged = Any()
        val order = mutableListOf<String>()
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val done = requireNotNull(f.sink.retire(f.owner, token) { order += "schedule"; f.begin(staged) })
            assertFalse(done.isCompleted); assertNull(f.sink.state.value)
            var cleanupFailure: Exception? = null
            try { order += "host"; throw IllegalStateException("Synthetic host cleanup failure") }
            catch (error: Exception) { cleanupFailure = error }
            finally { order += "permission"; order += "source"; f.closeSource(f.owner) }
            order += "complete"; token.completeExceptionally(requireNotNull(cleanupFailure))
            assertFailure(done)
            assertEquals(listOf("schedule", "host", "permission", "source", "complete"), order)
            f.assertDiscardedThenRecover(staged, old)
            assertEquals("Recovery must not schedule an automatic retry", 5, order.size)
        } finally { f.close() }
    }

    @Test fun `a settled failure remains on the drain until another pending retirement completes`() = runTest {
        val f = Fixture(); val firstToken = CompletableDeferred<Unit>(); val secondToken = CompletableDeferred<Unit>()
        val secondOwner = Any(); val staged = Any(); val order = mutableListOf<String>()
        var secondResult: Deferred<Unit>? = null
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val firstResult = requireNotNull(f.sink.retire(f.owner, firstToken) {
                order += "first-callback"; f.begin(secondOwner)
                secondResult = f.sink.retire(secondOwner, secondToken) { order += "second-callback"; f.begin(staged) }
            })
            val second = requireNotNull(secondResult)
            assertEquals(listOf("first-callback", "second-callback"), order)
            assertFalse(firstResult.isCompleted); assertFalse(second.isCompleted)
            f.closeSource(f.owner)
            firstToken.completeExceptionally(IllegalStateException("Synthetic first cleanup failure"))
            assertFailure(firstResult)
            assertFalse("One failed retirement must not bypass another cleanup token", second.isCompleted)
            f.publish(staged)
            assertNull(f.sink.state.value); assertFalse(f.sink.isCurrent(old))
            order += "second-finally"; f.closeSource(secondOwner); secondToken.complete(Unit)
            assertTrue(second.isCompleted); second.await()
            assertEquals(listOf("first-callback", "second-callback", "second-finally"), order)
            f.assertDiscardedThenRecover(staged, old)
            assertEquals(3, order.size)
        } finally { f.close() }
    }

    @Test fun `result observer cannot evade failed discharge by beginning a successor reentrantly`() = runTest {
        val f = Fixture(); val token = CompletableDeferred<Unit>(); val staged = Any()
        val order = mutableListOf<String>()
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val done = requireNotNull(f.sink.retire(f.owner, token) { order += "callback" })
            val observer = done.invokeOnCompletion { failure ->
                assertNotNull(failure)
                order += "observer"; f.begin(staged)
                assertNull("The observer still runs inside the failed drain barrier", f.sink.state.value)
            }
            try {
                f.closeSource(f.owner)
                token.completeExceptionally(IllegalStateException("Synthetic cleanup failure"))
                assertFailure(done)
                assertEquals(listOf("callback", "observer"), order)
                f.assertDiscardedThenRecover(staged, old)
                assertEquals("No cleanup or observer is automatically retried", 2, order.size)
            } finally { observer.dispose() }
        } finally { f.close() }
    }
}
