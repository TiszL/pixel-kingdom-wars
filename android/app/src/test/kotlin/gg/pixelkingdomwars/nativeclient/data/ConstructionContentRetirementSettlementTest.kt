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

/** Two additive settlement regressions for MS-C interface SHA
 * 505a2b5e377bcadb314837c2097ee13ccc36107eefa68d5f66996e1ce8274a6a.
 * No source acquisition, IO, worker, clock, new public API or post-failure positive-admission policy. */
class ConstructionContentRetirementSettlementTest {
    private class Fixture {
        val sink = ConstructionContentAdmissions()
        val owner = Any()
        val job = SupervisorJob()
        private val account = AccountSession("synthetic-wallet", "https://example.invalid", testToken())
        private val content = ContentState()
        private val sources = IdentityHashMap<Any, ServiceContentSession>()

        fun begin(token: Any = owner) {
            val source = sources[token] ?: ServiceContentSession(job, {}) { _, _ -> error("No acquisition") }
                .also { sources[token] = it }
            sink.beginOwner(token); sink.setSource(token, account, content, source); sink.permission(token, true)
        }

        fun close() {
            sources.forEach { (token, source) -> sink.clear(token); source.close() }
            job.cancel()
        }
    }

    @Test fun `same callback and token exception settles without self suppression or stranding another retirement`() = runTest {
        val f = Fixture(); val firstToken = CompletableDeferred<Unit>(); val secondToken = CompletableDeferred<Unit>()
        val sameFailure = IllegalStateException("Synthetic shared cleanup failure")
        val next = Any(); val order = mutableListOf<String>(); var secondResult: Deferred<Unit>? = null
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val firstResult = requireNotNull(f.sink.retire(f.owner, firstToken) {
                order += "first-callback"
                f.begin(next)
                secondResult = f.sink.retire(next, secondToken) { order += "second-callback" }
                throw sameFailure
            })
            assertEquals(listOf("first-callback", "second-callback"), order)
            val second = requireNotNull(secondResult)
            assertFalse(firstResult.isCompleted); assertFalse(second.isCompleted)
            assertNull(f.sink.state.value); assertFalse(f.sink.isCurrent(old))

            // Exercise both completion paths even if a broken drainer surfaces a notification
            // exception, so the checks below distinguish settlement from an already failed result.
            val completionErrors = mutableListOf<Exception>()
            try { firstToken.completeExceptionally(sameFailure) } catch (error: Exception) { completionErrors += error }
            try { secondToken.complete(Unit) } catch (error: Exception) { completionErrors += error }
            assertTrue("Shared exception must settle its first result", firstResult.isCompleted)
            assertTrue("Later token must still wake and finish the drain", second.isCompleted)
            assertTrue("Self-suppression must not throw through token completion", completionErrors.isEmpty())
            var resultFailure: Exception? = null
            try { firstResult.await() } catch (error: Exception) { resultFailure = error }
            // await may copy an exception for coroutine stack-trace recovery; its original
            // cause must remain reachable, rather than a self-suppression exception replacing it.
            assertTrue("Preserve the original failure as the result or its recovered cause",
                generateSequence<Throwable>(resultFailure) { it.cause }.take(8).any { it === sameFailure })
            second.await()
            assertEquals(listOf("first-callback", "second-callback"), order)
            assertFalse(f.sink.isCurrent(old)); assertFalse(f.sink.state.value?.ownerToken === f.owner)
        } finally { f.close() }
    }

    @Test fun `throwing result observer cannot abort a reentrantly queued cleanup or change the completed result`() = runTest {
        val f = Fixture(); val firstToken = CompletableDeferred<Unit>()
        val secondToken = CompletableDeferred<Unit>().apply { complete(Unit) }
        val observerFailure = IllegalStateException("Synthetic result observer failure")
        val next = Any(); val order = mutableListOf<String>(); var secondResult: Deferred<Unit>? = null
        try {
            f.begin(); val old = requireNotNull(f.sink.state.value)
            val firstResult = requireNotNull(f.sink.retire(f.owner, firstToken) { order += "first-callback" })
            val handler = firstResult.invokeOnCompletion {
                order += "observer"
                f.begin(next)
                secondResult = f.sink.retire(next, secondToken) { order += "second-callback" }
                throw observerFailure
            }
            try {
                var surfaced: Exception? = null
                try { firstToken.complete(Unit) } catch (error: Exception) { surfaced = error }
                // kotlinx-coroutines 1.10.1 wraps a throwing completion handler in
                // CompletionHandlerException. That notification exception is distinct from
                // the successfully completed Deferred value. Do not import its internal type
                // or require a new reporting policy: propagation is tolerated ONLY with this
                // exact wrapper/cause, and ONLY if every queued cleanup still completes.
                surfaced?.let { error ->
                    assertEquals("kotlinx.coroutines.CompletionHandlerException", error.javaClass.name)
                    assertTrue("Notification failure must retain the injected cause",
                        generateSequence(error as Throwable) { it.cause }.take(8).any { it === observerFailure })
                }
                assertTrue("Original result has completed despite its observer", firstResult.isCompleted)
                val second = requireNotNull(secondResult)
                assertTrue("Observer failure must not strand reentrant cleanup", second.isCompleted)
                firstResult.await(); second.await()
                assertEquals(listOf("first-callback", "observer", "second-callback"), order)
                assertFalse(f.sink.isCurrent(old)); assertFalse(f.sink.state.value?.ownerToken === f.owner)
            } finally { handler.dispose() }
        } finally { f.close() }
    }
}
