package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.Closeable
import java.util.IdentityHashMap
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

/** A current lifecycle observation, not resident-file proof or construction authority. Identity
 * is by reference: a caller must not reconstruct an observation from structurally equal fields. */
internal class ConstructionContentAdmission internal constructor(
    val ownerToken: Any,
    val account: AccountSession,
    val content: ContentState,
    val serviceContent: ServiceContentSession,
    val permitted: Boolean,
)

/** A sink for the ONE existing service-content lifecycle and permission reader. It performs no
 * acquisition, IO or capability request. Admission is revoked immediately, before StateFlow
 * combines run; source owners use retire to order their cleanup after invalidation listeners. */
internal class ConstructionContentAdmissions {
    private val lock = Any()
    private val mutableState = MutableStateFlow<ConstructionContentAdmission?>(null)
    val state: StateFlow<ConstructionContentAdmission?> = mutableState.asStateFlow()
    private var activeOwner: Any? = null // lock; the newest requested owner, including during notification
    private var observation: ConstructionContentAdmission? = null // lock; newest requested publication
    private class Listener(val callback: () -> Unit) { val active = AtomicBoolean(true) }
    private val listeners = linkedSetOf<Listener>() // lock; bounded by registered consumer lifetimes
    private class Retirement(val owner: Any, val callback: () -> Unit) {
        val completion = CompletableDeferred<Unit>()
        var callbackReturned = false // lock; independent of observer completion/cancellation
        var callbackFailure: Throwable? = null // lock
        var cleanupCompleted = false // lock; the owner's separate completion token
        var cleanupFailure: Throwable? = null // lock
    }
    private class Invalidation(val listeners: List<Listener>) {
        val retirements = ArrayDeque<Retirement>() // lock; finite callbacks registered by existing owners
        val pending = linkedSetOf<Retirement>() // lock; callback return AND owner completion required
        var listenersFinished = false // lock
        var failed = false // lock; retained until the entire drain discharges
    }
    private sealed interface DrainWork {
        class Listeners(val transition: Invalidation) : DrainWork
        class Callback(val retirement: Retirement) : DrainWork
        class Settlement(val retirement: Retirement) : DrainWork
        object Next : DrainWork
    }
    private val retirements = IdentityHashMap<Any, Retirement>() // lock; in-flight only, no tombstones
    private var invalidation: Invalidation? = null // lock; identity fence, with state kept null while it drains
    private var driver: Any? = null // lock; one finite driver across reentrant publications

    /** Register the existing owner token BEFORE its asynchronous open. A late source cannot
     * self-register an old token; after clear a new explicit begin is required. No tombstones. */
    fun beginOwner(ownerToken: Any) {
        synchronized(lock) {
            if (activeOwner === ownerToken) return
            transition(ownerToken, null)
        }
        advance()
    }

    fun setSource(ownerToken: Any, account: AccountSession, content: ContentState, serviceContent: ServiceContentSession) {
        synchronized(lock) {
            if (activeOwner !== ownerToken) return
            val previous = observation
            if (previous != null && previous.account === account && previous.content === content &&
                previous.serviceContent === serviceContent) return
            transition(ownerToken, ConstructionContentAdmission(ownerToken, account, content, serviceContent, false))
        }
        advance()
    }

    /** An early positive without a published source is discarded, never carried across open. */
    fun permission(ownerToken: Any, permitted: Boolean) {
        synchronized(lock) {
            if (activeOwner !== ownerToken) return
            val previous = observation ?: return
            if (previous.permitted == permitted) return
            val next = ConstructionContentAdmission(ownerToken, previous.account, previous.content, previous.serviceContent, permitted)
            if (permitted) {
                // A positive follows a denied observation; no live construction must be revoked.
                observation = next
                if (invalidation == null) mutableState.value = next
            } else {
                transition(ownerToken, next)
            }
        }
        advance()
    }

    /** Revoke admission only. Source-closing owners must use retire directly: a concurrent or
     * reentrant clear does not wait for an already active listener drain. */
    fun clear(ownerToken: Any) {
        synchronized(lock) {
            if (activeOwner !== ownerToken) return
            transition(null, null)
        }
        advance()
    }

    /** Legacy synchronous cleanup: its private token completes only after the callback returns. */
    fun retire(ownerToken: Any, afterInvalidated: () -> Unit): Deferred<Unit>? {
        val cleanupComplete = CompletableDeferred<Unit>()
        return retire(ownerToken, cleanupComplete) {
            try { afterInvalidated() } finally { cleanupComplete.complete(Unit) }
        }
    }

    /** Revoke now, drain listeners, then invoke the owner's scheduling callback outside locks.
     * Admission stays dark until BOTH that callback returns and actual owner cleanup completes.
     * Duplicate requests join the first result/token/callback; stale requests do nothing.
     * Result cancellation is only an observer choice, never cleanup completion or admission.
     * No thread, coroutine, blocking wait or source owner is created here. */
    fun retire(ownerToken: Any, cleanupComplete: Deferred<Unit>, afterInvalidated: () -> Unit): Deferred<Unit>? {
        val (retirement, pending) = synchronized(lock) {
            retirements[ownerToken]?.let { return it.completion }
            if (activeOwner !== ownerToken) return null
            val next = Retirement(ownerToken, afterInvalidated)
            retirements[ownerToken] = next
            val previous = observation
            activeOwner = null
            observation = null
            val existing = invalidation
            val pending = existing ?: Invalidation(if (previous != null) listeners.toList() else emptyList())
                .also { invalidation = it }
            pending.retirements.addLast(next)
            pending.pending.add(next)
            // StateFlow collectors may reenter synchronously. Install the complete barrier
            // before emitting null, so their new owner/source writes can only be staged.
            mutableState.value = null
            next to pending
        }
        // Enroll before subscribing: completed tokens invoke this hook inline. It can only
        // mark its own pending retirement; it cannot bypass listeners or a running callback.
        cleanupComplete.invokeOnCompletion { error -> cleanupCompleted(pending, retirement, error) }
        advance()
        return retirement.completion
    }

    /** Caller guards also bind account holder/base selection/content. The existing source checks
     * its own account/content lifetime; this sink never promotes metadata membership to permission. */
    fun isCurrent(admission: ConstructionContentAdmission): Boolean {
        fun matches(): Boolean = synchronized(lock) {
            invalidation == null && activeOwner === admission.ownerToken &&
                observation === admission && mutableState.value === admission && admission.permitted
        }
        if (!matches()) return false
        val sourceCurrent = try { admission.serviceContent.assets.isCurrent() } catch (_: Exception) { false }
        return sourceCurrent && matches()
    }

    /** No initial notification: mount reads state for initial preparation. Invalidation listeners
     * must be cheap synchronous revokers, e.g. provider.update(null), not readers or IO workers. */
    fun onInvalidated(listener: () -> Unit): Closeable {
        val registration = Listener(listener)
        synchronized(lock) { listeners.add(registration) }
        return Closeable {
            if (registration.active.compareAndSet(true, false)) synchronized(lock) { listeners.remove(registration) }
        }
    }

    /** Called only under lock. An old captured admission is unusable BEFORE notification starts. */
    private fun transition(owner: Any?, next: ConstructionContentAdmission?) {
        val notify = observation != null
        activeOwner = owner
        observation = next
        // A reentrant/concurrent replacement changes only the desired publication. The earlier
        // drain still revokes every captured consumer before ANY new positive can be published.
        if (invalidation != null) return
        if (!notify) { mutableState.value = next; return }
        invalidation = Invalidation(listeners.toList())
        mutableState.value = null
    }

    private fun cleanupCompleted(transition: Invalidation, retirement: Retirement, error: Throwable?) {
        synchronized(lock) {
            if (invalidation !== transition || retirement !in transition.pending) return
            retirement.cleanupCompleted = true
            retirement.cleanupFailure = error
        }
        advance()
    }

    /** StateFlow resumes Unconfined collectors synchronously, even while its publisher holds
     * this lock. Such reentrant callers only stage work; the outer caller drives it after
     * unlocking. A single finite driver loops across replacement invalidations, so neither
     * listener/cleanup/result callbacks nor recursive drains run inside a publisher frame. */
    private fun advance() {
        if (Thread.holdsLock(lock)) return
        val ticket = Any()
        synchronized(lock) {
            if (driver != null) return
            driver = ticket
        }
        try {
        while (true) {
            val work = synchronized(lock) {
                val transition = invalidation ?: run { driver = null; return }
                if (!transition.listenersFinished) return@synchronized DrainWork.Listeners(transition)
                val settled = transition.pending.firstOrNull { it.callbackReturned && it.cleanupCompleted }
                if (settled != null) {
                    transition.pending.remove(settled)
                    if (settled.callbackFailure != null || settled.cleanupFailure != null) transition.failed = true
                    DrainWork.Settlement(settled)
                } else {
                    val callback = transition.retirements.pollFirst()
                    if (callback != null) return@synchronized DrainWork.Callback(callback)
                    if (transition.pending.isNotEmpty()) {
                        // Another owner's completion hook resumes this same drain later.
                        driver = null
                        return
                    }
                    // B/C0560c081: cleanup failure cannot certify an already-staged owner.
                    // A fresh beginOwner AFTER discharge is the only recovery entry.
                    if (transition.failed) { activeOwner = null; observation = null }
                    invalidation = null
                    mutableState.value = observation
                    // A collector may have created another invalidation during publication.
                    // Loop after unlocking; never call that new owner's callbacks here.
                    DrainWork.Next
                }
            }
            when (work) {
                is DrainWork.Listeners -> {
                    try {
                        work.transition.listeners.forEach { listener ->
                            if (listener.active.get()) try { listener.callback() }
                            catch (_: Exception) { /* One ordinary failure cannot skip another revoker. */ }
                        }
                    } finally {
                        synchronized(lock) { work.transition.listenersFinished = true }
                    }
                }
                is DrainWork.Callback -> {
                    var failure: Throwable? = null
                    try { work.retirement.callback() } catch (error: Throwable) { failure = error }
                    finally {
                        synchronized(lock) {
                            work.retirement.callbackFailure = failure
                            work.retirement.callbackReturned = true
                        }
                    }
                }
                is DrainWork.Settlement -> {
                    val retirement = work.retirement
                    val failure = retirement.callbackFailure ?: retirement.cleanupFailure
                    val secondary = retirement.cleanupFailure
                    // The same exception may describe both sides; self-suppression throws.
                    if (failure != null && secondary != null && failure !== secondary) failure.addSuppressed(secondary)
                    try {
                        if (failure == null) retirement.completion.complete(Unit)
                        else retirement.completion.completeExceptionally(failure)
                    } catch (_: Exception) {
                        // A throwing result observer cannot change the already-completed value
                        // or strand queued cleanup. It is not an owner cleanup failure.
                    } finally {
                        synchronized(lock) {
                            if (retirements[retirement.owner] === retirement) retirements.remove(retirement.owner)
                        }
                    }
                }
                DrainWork.Next -> Unit
            }
        }
        } finally {
            // Idle decisions above release ownership atomically with their last work check.
            // A completion may already have installed another driver before this finally.
            synchronized(lock) { if (driver === ticket) driver = null }
        }
    }
}
