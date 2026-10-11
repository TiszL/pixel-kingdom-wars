package gg.pixelkingdomwars.nativeclient.audio

import java.io.Closeable
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore

/** Creation, methods and callbacks all belong to the same worker Looper. */
internal interface MusicDevice : Closeable {
    fun prepare(file: File, volume: Float, ready: () -> Unit, failed: (Exception) -> Unit)
    fun play()
    fun pause()
}

/** Bounded streamed players. Control callers never acquire a lock held by platform work.
 * One pending desired-state message per voice replaces obsolete play/pause requests. */
internal class QueuedMusicBackend(
    private val worker: suspend () -> CoroutineDispatcher,
    private val capacity: Semaphore,
    private val open: () -> MusicDevice,
) : MusicBackend {
    override suspend fun prepare(file: File, volume: Float): MusicVoice {
        capacity.acquire()
        var voice: Voice? = null
        try {
            val dispatcher = worker()
            currentCoroutineContext().ensureActive()
            val value = Voice(dispatcher, capacity::release).also { voice = it }
            value.begin(file, volume)
            return value.ready.await()
        } catch (error: Exception) {
            val value = voice
            if (value == null) capacity.release()
            else {
                value.close()
                // A canceled caller still owns the content lease. It may release the
                // bytes only once the worker has finished reading/releasing the player.
                withContext(NonCancellable) { value.released.await() }
            }
            throw error
        }
    }

    private inner class Voice(private val dispatcher: CoroutineDispatcher, private val releaseSlot: () -> Unit) : MusicVoice {
        val ready = CompletableDeferred<MusicVoice>()
        val released = CompletableDeferred<Unit>()
        private val closed = AtomicBoolean(false)
        private val desired = AtomicReference(false)
        private val posted = AtomicBoolean(false)
        private var device: MusicDevice? = null // Worker only.
        private var prepared = false
        private var playing = false
        private var retired = false

        private fun post(block: () -> Unit) = dispatcher.dispatch(EmptyCoroutineContext, Runnable(block))
        fun begin(file: File, volume: Float) = post {
            try {
                if (closed.get()) { retire(); return@post }
                device = open()
                if (closed.get()) { retire(); return@post }
                requireNotNull(device).prepare(file, volume, ready = {
                    if (closed.get()) retire()
                    else { prepared = true; ready.complete(this) }
                }, failed = ::fail)
            } catch (error: Exception) { fail(error) }
        }
        override fun play() { check(!closed.get()) { "Optional music is unavailable" }; desired.set(true); schedule() }
        override fun pause() { check(!closed.get()) { "Optional music is unavailable" }; desired.set(false); schedule() }
        override fun close() { closed.set(true); desired.set(false); schedule() }
        override fun close(onReleased: () -> Unit) {
            released.invokeOnCompletion { post { runCatching(onReleased) } }
            close()
        }
        private fun schedule() {
            if (released.isCompleted || !posted.compareAndSet(false, true)) return
            post {
                posted.set(false)
                if (closed.get()) { retire(); return@post }
                if (!prepared) return@post
                val requested = desired.get()
                try {
                    // A platform call already executing cannot be preempted. Closing
                    // invalidates every queued start without waiting for that call.
                    if (closed.get()) retire()
                    else if (requested != playing) {
                        if (requested) requireNotNull(device).play() else requireNotNull(device).pause()
                        playing = requested
                    }
                } catch (error: Exception) { fail(error) }
                if (closed.get()) retire()
                else if (requested != desired.get()) schedule()
            }
        }
        private fun fail(error: Exception) {
            closed.set(true); ready.completeExceptionally(error); retire()
        }
        private fun retire() {
            if (retired) return
            retired = true; closed.set(true)
            ready.completeExceptionally(IllegalStateException("Optional music closed before preparation finished"))
            try { runCatching { device?.close() } }
            finally { device = null; releaseSlot(); released.complete(Unit) }
        }
    }
}
