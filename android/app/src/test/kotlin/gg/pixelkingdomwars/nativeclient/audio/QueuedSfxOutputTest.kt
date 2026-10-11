package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
class QueuedSfxOutputTest {
    @Test fun `full device buffer suspends IO and close flushes without waiting for buffer space`() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val mixer = SfxMixer(audioRuntime()); val clip = pcm(PcmBudget(16))
        mixer.loop("loop", clip, AudioDefinition("loop", "loop.wav"), 1f)
        var writes = 0; var flushes = 0; var drains = 0; var failures = 0
        val output = QueuedSfxOutput(this, mixer, { object : PcmOutputDevice {
            override val sampleRate = 4; override val bufferSamples = 4
            override fun play() {}
            override fun write(output: FloatArray, offset: Int, count: Int): Int { writes++; return 0 }
            override fun drain() { drains++ }
            override fun close() { flushes++ }
        } }, { failures++ }, dispatcher, dispatcher)
        output.wake(); runCurrent(); assertEquals(1, writes)
        output.close(); output.wake(); runCurrent()
        // Cancellation resumes the suspended writer immediately, without advancing the 2ms
        // backoff or waiting for a driver buffer. It flushes rather than draining stale cues.
        assertEquals(0, testScheduler.currentTime)
        assertEquals(1, flushes); assertEquals(0, drains); assertEquals(0, failures)
        advanceUntilIdle(); assertEquals(1, writes)
        mixer.stopAll(); clip.close()
    }

    @Test fun `slow platform teardown cannot strand Main or start another sound after close`() = runBlocking {
        val outputThread = java.util.concurrent.atomic.AtomicReference<Thread>()
        val worker = Executors.newSingleThreadExecutor { Thread(it, "test-sfx-output").also(outputThread::set) }.asCoroutineDispatcher()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val closeEntered = CountDownLatch(1); val finishClose = CountDownLatch(1); val closed = CountDownLatch(1)
        val firstWrite = CountDownLatch(1); val mixer = SfxMixer(audioRuntime())
        val clip = pcm(PcmBudget(16)); mixer.loop("loop", clip, AudioDefinition("loop", "loop.wav"), 1f)
        var writes = 0
        val output = QueuedSfxOutput(scope, mixer, { object : PcmOutputDevice {
            override val sampleRate = 4; override val bufferSamples = 4
            override fun play() { assertSame(outputThread.get(), Thread.currentThread()) }
            override fun write(output: FloatArray, offset: Int, count: Int): Int { writes++; firstWrite.countDown(); return 0 }
            override fun drain() { fail("Lifecycle loss must flush, not drain") }
            override fun close() {
                assertSame(outputThread.get(), Thread.currentThread())
                closeEntered.countDown()
                try { check(finishClose.await(5, TimeUnit.SECONDS)) } finally { closed.countDown() }
            }
        } }, { fail("Close is not an output failure") }, worker, Dispatchers.Unconfined)
        try {
            output.wake(); assertTrue(firstWrite.await(5, TimeUnit.SECONDS))
            output.close(); assertTrue(closeEntered.await(5, TimeUnit.SECONDS))
            // The fake platform is still inside pause/flush. Main/control work has returned.
            val before = writes; repeat(20) { output.wake(); output.close() }
            mixer.stopAll(); assertEquals(0, mixer.activeCount()); assertEquals(before, writes)
        } finally {
            finishClose.countDown(); assertTrue(closed.await(5, TimeUnit.SECONDS))
            scope.cancel(); worker.close(); clip.close()
        }
    }
}
