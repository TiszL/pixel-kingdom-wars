package gg.pixelkingdomwars.nativeclient.data

import java.io.Closeable
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.InternalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.NonDisposableHandle
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One service open's logical fence and physical lifetime. The caller injects its existing
 * Main.immediate cleanup scope; neither the account Job nor a waiting collector owns the token. */
internal class ServiceContentOwner(
    private val retireAdmission: (Deferred<Unit>, () -> Unit) -> Deferred<Unit>?,
    private val launchCleanup: (suspend () -> Unit) -> Unit,
    private val onFailure: (Throwable) -> Unit = {},
) : ServiceContentRetirement {
    private class Source(val revoke: () -> Unit, val close: () -> Unit) {
        var revocationClaimed = false
    }

    private sealed interface CleanupStep {
        data class Wait(val settled: Deferred<Unit>) : CleanupStep
        data class Close(val callback: () -> Unit) : CleanupStep
        data class Finish(val failures: List<Throwable>) : CleanupStep
    }

    private val lock = Any()
    private val cleanupComplete = CompletableDeferred<Unit>()
    // Consumers can await/observe the barrier, but only real cleanup may complete it. A public
    // Deferred also exposes cancel(); shield that operation from both callers and the sink.
    private val completion: Deferred<Unit> = object : Deferred<Unit> by cleanupComplete, CoroutineContext.Element {
        override val key: CoroutineContext.Key<*> get() = Job
        override fun cancel(cause: CancellationException?) = Unit
        // This token is an observation, not a parent scope. Match NonCancellable's inert child
        // attachment: an observer's failed/live child cannot cancel or hold the owned completer.
        // Coroutine 1.10.1 requires overriding this deprecated Job hook to protect parent use.
        @Suppress("DEPRECATION_ERROR")
        @OptIn(InternalCoroutinesApi::class)
        override fun attachChild(child: kotlinx.coroutines.ChildJob): kotlinx.coroutines.ChildHandle = NonDisposableHandle
        // Context lookup/composition must also retain this view, never expose the private Job.
        override fun <E : CoroutineContext.Element> get(key: CoroutineContext.Key<E>): E? =
            super<CoroutineContext.Element>.get(key)
        override fun <R> fold(initial: R, operation: (R, CoroutineContext.Element) -> R): R =
            operation(initial, this)
        override fun minusKey(key: CoroutineContext.Key<*>): CoroutineContext =
            super<CoroutineContext.Element>.minusKey(key)
        override fun plus(context: CoroutineContext): CoroutineContext =
            super<CoroutineContext.Element>.plus(context)
    }
    private val admissionReturned = CompletableDeferred<Unit>()
    private val sources = ArrayDeque<Source>()
    private val beforeSource = ArrayDeque<() -> Unit>()
    private val failures = mutableListOf<Throwable>()
    private var openTickets = 0
    private var revokers = 0
    private var settled = CompletableDeferred<Unit>().apply { complete(Unit) }
    private var ownerBound = false
    private var cleanupScheduled = false
    private var terminal = false

    @Volatile
    override var requested: Boolean = false
        private set

    /** Reserve before installing the cancellation watcher; late open results must register before close. */
    fun beginOpen(): Closeable {
        synchronized(lock) {
            check(!requested) { "Service retirement already requested" }
            reserveWorkLocked()
            openTickets++
        }
        var closed = false
        return Closeable {
            val signal = synchronized(lock) {
                if (closed) null else {
                    closed = true
                    openTickets--
                    settledSignalLocked()
                }
            }
            // Completing a Deferred may immediately resume cleanup; never do it under our lock.
            signal?.complete(Unit)
        }
    }

    /** Exactly one existing-style account watcher. Its finally only requests retirement, never joins it. */
    fun bindOwner(owner: Job) {
        synchronized(lock) {
            check(!ownerBound) { "Service owner already bound" }
            check(openTickets > 0 && !terminal) { "Reserve the open ticket before binding its owner" }
            ownerBound = true
        }
        val watcher = CoroutineScope(owner + Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { requestRetirement() }
        }
        try {
            beforeSourceClose { watcher.cancel() }
        } catch (failure: Throwable) {
            watcher.cancel()
            throw failure
        }
    }

    override fun registerSource(revoke: () -> Unit, close: () -> Unit) {
        val source = Source(revoke, close)
        val revokeNow = synchronized(lock) {
            check(!terminal) { "Service source registered after retirement completed" }
            sources.addLast(source)
            if (requested) {
                claimRevokerLocked(source)
                true
            } else false
        }
        if (revokeNow) revokeSource(source)
    }

    override fun beforeSourceClose(close: () -> Unit) {
        synchronized(lock) {
            check(!terminal) { "Service cleanup registered after retirement completed" }
            beforeSource.addLast(close)
        }
    }

    override fun requestRetirement(): Deferred<Unit> {
        val revocations = synchronized(lock) {
            if (requested) return completion
            // Both the fence and the stable completion exist before any reentrant callback sees us.
            requested = true
            sources.filterNot { it.revocationClaimed }.onEach(::claimRevokerLocked)
        }
        revocations.forEach(::revokeSource)
        try {
            // A stale sink invokes nothing. Its owner-tagged resources still need the same cleanup.
            val sinkResult = retireAdmission(completion, ::scheduleCleanup)
            if (sinkResult == null) scheduleCleanup()
            // Never await or inherit cancellation from the sink result: it depends on our token.
        } catch (failure: Throwable) {
            recordFailure(failure)
            scheduleCleanup()
        } finally {
            // A reentrant callback may dispatch immediately. Include an admission-call failure before
            // it can complete the token, without making that callback wait for its own return.
            admissionReturned.complete(Unit)
        }
        return completion
    }

    /** Called only with lock held; a new work interval gets its own unparented wake-up signal. */
    private fun reserveWorkLocked() {
        if (openTickets == 0 && revokers == 0) settled = CompletableDeferred()
    }

    private fun claimRevokerLocked(source: Source) {
        check(!source.revocationClaimed)
        source.revocationClaimed = true
        reserveWorkLocked()
        revokers++
    }

    private fun settledSignalLocked(): CompletableDeferred<Unit>? =
        settled.takeIf { openTickets == 0 && revokers == 0 }

    private fun revokeSource(source: Source) {
        try {
            source.revoke()
        } catch (failure: Throwable) {
            recordFailure(failure)
        } finally {
            val signal = synchronized(lock) {
                revokers--
                settledSignalLocked()
            }
            signal?.complete(Unit)
        }
    }

    private fun scheduleCleanup() {
        synchronized(lock) {
            if (cleanupScheduled) return
            cleanupScheduled = true
        }
        try {
            launchCleanup {
                withContext(NonCancellable) {
                    admissionReturned.await()
                    drainCleanup()
                }
            }
        } catch (failure: Throwable) {
            // Failed dispatch is not completed cleanup. Report it, but never release admission by
            // completing the token while owned resources are still live.
            recordFailure(failure)
        }
    }

    private suspend fun drainCleanup() {
        while (true) {
            val step = synchronized(lock) {
                when {
                    openTickets != 0 || revokers != 0 -> CleanupStep.Wait(settled)
                    beforeSource.isNotEmpty() -> CleanupStep.Close(beforeSource.removeFirst())
                    sources.isNotEmpty() -> CleanupStep.Close(sources.removeFirst().close)
                    else -> {
                        // Registration races this exact lock boundary: accepted callbacks are drained;
                        // later registrations fail explicitly rather than disappearing after a snapshot.
                        terminal = true
                        CleanupStep.Finish(failures.toList())
                    }
                }
            }
            when (step) {
                is CleanupStep.Wait -> step.settled.await()
                is CleanupStep.Close -> try { step.callback() } catch (failure: Throwable) { recordFailure(failure) }
                is CleanupStep.Finish -> {
                    val first = step.failures.firstOrNull()
                    if (first == null) cleanupComplete.complete(Unit) else {
                        step.failures.drop(1).filter { it !== first }.forEach(first::addSuppressed)
                        cleanupComplete.completeExceptionally(first)
                    }
                    return
                }
            }
        }
    }

    private fun recordFailure(failure: Throwable) {
        synchronized(lock) { failures.add(failure) }
        try {
            onFailure(failure)
        } catch (reportFailure: Throwable) {
            // A diagnostics failure must not interrupt later physical closes or recurse into itself.
            synchronized(lock) { failures.add(reportFailure) }
        }
    }
}
