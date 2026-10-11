package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean

internal interface PcmOutputDevice : Closeable {
    val sampleRate: Int
    val bufferSamples: Int
    fun play()
    /** Non-blocking platform write; zero means its bounded buffer is temporarily full. */
    fun write(output: FloatArray, offset: Int, count: Int): Int
    fun drain()
}

/** One IO-owned sink. Close fences new work immediately, then cancels the suspending writer
 * so pause/flush/release run on IO. Main never waits for the driver or PCM interpolation.
 * Only the already queued platform-minimum block can remain until teardown executes. */
internal class QueuedSfxOutput(
    scope: CoroutineScope, private val mixer: SfxMixer, open: () -> PcmOutputDevice,
    failed: () -> Unit, worker: CoroutineDispatcher = Dispatchers.IO,
    main: CoroutineDispatcher = Dispatchers.Main.immediate,
) : SfxOutput {
    private val closed = AtomicBoolean(false)
    private val signal = Channel<Unit>(Channel.CONFLATED)
    private val job = scope.launch(worker) {
        var device: PcmOutputDevice? = null
        var staging: FloatArray? = null
        try {
            for (ignored in signal) {
                ensureActive(); if (closed.get()) break
                val sink = device ?: open().also { device = it }
                require(sink.sampleRate > 0 && sink.bufferSamples > 0 && sink.bufferSamples % 2 == 0)
                val output = staging ?: FloatArray(sink.bufferSamples).also { staging = it }
                if (closed.get()) break
                if (mixer.activeCount() == 0) continue
                sink.play()
                while (!closed.get() && mixer.render(output, sink.sampleRate)) {
                    ensureActive()
                    var offset = 0
                    while (offset < output.size && !closed.get()) {
                        val written = sink.write(output, offset, output.size - offset)
                        if (closed.get()) break
                        check(written in 0..(output.size - offset)) { "Optional SFX output failed" }
                        // Technical IO backoff only. It does not advance any game/audio cursor.
                        if (written == 0) delay(2) else offset += written
                    }
                }
                // Natural completion preserves its last queued block; lifecycle cancellation
                // bypasses draining and flushes it in finally instead.
                if (!closed.get()) sink.drain()
            }
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { if (!closed.get()) withContext(main) { if (!closed.get()) failed() } }
        finally { runCatching { device?.close() } }
    }
    override fun wake() { if (!closed.get()) signal.trySend(Unit) }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        signal.close(); job.cancel()
    }
}
