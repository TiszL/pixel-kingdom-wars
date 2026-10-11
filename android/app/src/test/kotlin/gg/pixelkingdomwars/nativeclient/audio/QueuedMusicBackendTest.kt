package gg.pixelkingdomwars.nativeclient.audio

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class QueuedMusicBackendTest {
    private class Queue : CoroutineDispatcher() {
        val tasks = ArrayDeque<Runnable>()
        override fun dispatch(context: CoroutineContext, block: Runnable) { tasks.addLast(block) }
        fun drain() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    }
    private open class Device : MusicDevice {
        var plays = 0; var pauses = 0; var releases = 0
        var failed: ((Exception) -> Unit)? = null
        override fun prepare(file: File, volume: Float, ready: () -> Unit, failed: (Exception) -> Unit) { this.failed = failed; ready() }
        override fun play() { plays++ }
        override fun pause() { pauses++ }
        override fun close() { releases++ }
    }
    @Test fun `rapid play pause and close coalesce and a queued start cannot outlive background or replacement`() = runTest {
        val queue = Queue(); val device = Device(); val seats = Semaphore(2)
        val backend = QueuedMusicBackend({ queue }, seats) { device }
        val preparing = async { backend.prepare(File("track.mp3"), .4f) }; runCurrent(); queue.drain(); runCurrent()
        val voice = preparing.await()
        repeat(100) { voice.play(); voice.pause() }
        assertEquals(1, queue.tasks.size); queue.drain(); assertEquals(0, device.plays)
        voice.play(); queue.drain(); assertEquals(1, device.plays)
        voice.pause(); voice.play(); voice.close(); voice.close(); assertEquals(1, queue.tasks.size)
        queue.drain(); assertEquals(1, device.plays); assertEquals(1, device.releases); assertEquals(2, seats.availablePermits)
        assertThrows(IllegalStateException::class.java) { voice.play() }
    }
    @Test fun `cancel before worker setup creates no player and returns its seat`() = runTest {
        val queue = Queue(); val seats = Semaphore(2); var creates = 0
        val backend = QueuedMusicBackend({ queue }, seats) { creates++; Device() }
        val preparing = async { backend.prepare(File("track.mp3"), .4f) }; runCurrent()
        preparing.cancel(); runCurrent(); assertEquals(1, seats.availablePermits)
        queue.drain(); runCurrent(); assertEquals(0, creates); assertEquals(2, seats.availablePermits)
    }
    @Test fun `asynchronous media failure is terminal and explicit replacement can acquire the released seat`() = runTest {
        val queue = Queue(); val seats = Semaphore(1); val devices = mutableListOf<Device>()
        val backend = QueuedMusicBackend({ queue }, seats) { Device().also(devices::add) }
        val preparing = async { backend.prepare(File("track.mp3"), .4f) }; runCurrent(); queue.drain(); runCurrent()
        val old = preparing.await(); queue.tasks += Runnable { devices.single().failed!!(IllegalStateException("decode")) }; queue.drain()
        assertThrows(IllegalStateException::class.java) { old.play() }; assertEquals(1, devices.single().releases)
        var released = 0; old.close { released++ }; assertEquals(0, released); queue.drain(); assertEquals(1, released)
        val next = async { backend.prepare(File("track.mp3"), .4f) }; runCurrent(); queue.drain(); runCurrent()
        next.await().close(); queue.drain(); assertEquals(2, devices.size); assertEquals(1, seats.availablePermits)
    }
    @Test fun `controller retains the content lease until asynchronous music release completes`() = runTest {
        val queue = Queue(); val device = Device(); var released = 0
        val backend = QueuedMusicBackend({ queue }, Semaphore(2)) { device }
        val source = AudioAssetSource { _, paths -> AudioAssetLease(File("/verified"), paths) { released++ } }
        val focus = object : GameAudioFocus { override fun request(changed: (Boolean) -> Unit) = true; override fun abandon() {} }
        val controller = MusicController(this, source, backend, focus)
        controller.update(MusicContext(audioPack(), Any(), "base", true)); runCurrent(); queue.drain(); runCurrent(); queue.drain()
        assertEquals(1, device.plays)
        controller.close(); assertEquals(0, released); assertEquals(0, device.releases)
        queue.drain(); assertEquals(1, released); assertEquals(1, device.releases)
    }
    @Test fun `blocked setup cancellation keeps bytes pinned and all device calls off the caller thread`(): Unit = runBlocking {
        val thread = AtomicReference<Thread>(); val worker = Executors.newSingleThreadExecutor { Thread(it, "music-test").also(thread::set) }.asCoroutineDispatcher()
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val retired = CountDownLatch(1)
        var leaseClosed = false; var starts = 0
        val backend = QueuedMusicBackend({ worker }, Semaphore(2)) {
            assertSame(thread.get(), Thread.currentThread())
            object : Device() {
                override fun prepare(file: File, volume: Float, ready: () -> Unit, failed: (Exception) -> Unit) {
                    assertSame(thread.get(), Thread.currentThread()); entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); ready()
                }
                override fun play() { starts++; assertSame(thread.get(), Thread.currentThread()) }
                override fun close() { assertSame(thread.get(), Thread.currentThread()); retired.countDown() }
            }
        }
        val preparing = async { try { backend.prepare(File("leased.mp3"), .4f) } finally { leaseClosed = true } }
        try {
            assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
            preparing.cancel(); yield(); assertFalse(leaseClosed)
            // The caller continues while setDataSource/prepare is still blocked on the worker.
            withTimeout(1_000) { yield() }; assertEquals(1L, release.count)
            release.countDown(); preparing.join(); assertTrue(leaseClosed); assertTrue(retired.await(5, TimeUnit.SECONDS)); assertEquals(0, starts)
        } finally { release.countDown(); preparing.cancelAndJoin(); worker.close() }
    }
    @Test fun `stalled platform release cannot block caller or create unbounded replacement players`(): Unit = runBlocking {
        val worker = Executors.newSingleThreadExecutor().asCoroutineDispatcher(); val seats = Semaphore(2)
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val creates = AtomicInteger(); val closes = AtomicInteger()
        val backend = QueuedMusicBackend({ worker }, seats) { creates.incrementAndGet(); object : Device() {
            override fun close() { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); closes.incrementAndGet() }
        } }
        val a = backend.prepare(File("a.mp3"), .4f); val b = backend.prepare(File("b.mp3"), .4f)
        val bytesReleased = AtomicInteger()
        try {
            a.close { bytesReleased.incrementAndGet() }; assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
            repeat(100) { a.close(); b.play(); b.pause() }; b.close { bytesReleased.incrementAndGet() }
            repeat(30) {
                val pending = async { backend.prepare(File("replacement.mp3"), .4f) }; yield(); pending.cancelAndJoin()
            }
            assertEquals(2, creates.get()); assertEquals(0, bytesReleased.get()); assertEquals(0, seats.availablePermits)
            release.countDown(); withTimeout(5_000) { while (seats.availablePermits != 2 || bytesReleased.get() != 2) delay(1) }
            assertEquals(2, closes.get()); assertEquals(2, bytesReleased.get())
        } finally { release.countDown(); a.close(); b.close(); worker.close() }
    }
    @Test fun `setup callbacks playback pause and release share one worker thread`(): Unit = runBlocking {
        val thread = AtomicReference<Thread>()
        val worker = Executors.newSingleThreadExecutor { Thread(it, "single-music-owner").also(thread::set) }.asCoroutineDispatcher()
        val played = CountDownLatch(1); val paused = CountDownLatch(1); val released = CountDownLatch(1)
        val backend = QueuedMusicBackend({ worker }, Semaphore(1)) {
            assertSame(thread.get(), Thread.currentThread())
            object : Device() {
                override fun prepare(file: File, volume: Float, ready: () -> Unit, failed: (Exception) -> Unit) {
                    assertSame(thread.get(), Thread.currentThread()); ready()
                }
                override fun play() { assertSame(thread.get(), Thread.currentThread()); played.countDown() }
                override fun pause() { assertSame(thread.get(), Thread.currentThread()); paused.countDown() }
                override fun close() { assertSame(thread.get(), Thread.currentThread()); released.countDown() }
            }
        }
        val voice = backend.prepare(File("track.mp3"), .4f)
        try {
            voice.play(); assertTrue(withContext(Dispatchers.IO) { played.await(5, TimeUnit.SECONDS) })
            voice.pause(); assertTrue(withContext(Dispatchers.IO) { paused.await(5, TimeUnit.SECONDS) })
            val complete = CompletableDeferred<Unit>(); voice.close { complete.complete(Unit) }
            withTimeout(5_000) { complete.await() }; assertEquals(0L, released.count)
            val late = CompletableDeferred<Unit>()
            voice.close { assertSame(thread.get(), Thread.currentThread()); late.complete(Unit) }
            withTimeout(5_000) { late.await() }
        } finally { voice.close(); worker.close() }
    }
    @Test fun `pause and close remain responsive during an already executing platform start`(): Unit = runBlocking {
        val worker = Executors.newSingleThreadExecutor().asCoroutineDispatcher(); val seats = Semaphore(1)
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val starts = AtomicInteger(); val closes = AtomicInteger()
        val backend = QueuedMusicBackend({ worker }, seats) { object : Device() {
            override fun play() { starts.incrementAndGet(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            override fun close() { closes.incrementAndGet() }
        } }
        val voice = backend.prepare(File("track.mp3"), .4f)
        try {
            voice.play(); assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
            voice.pause(); voice.close(); withTimeout(1_000) { yield() }; assertEquals(0, closes.get())
            release.countDown(); withTimeout(5_000) { while (seats.availablePermits != 1) delay(1) }
            assertEquals(1, starts.get()); assertEquals(1, closes.get())
        } finally { release.countDown(); voice.close(); worker.close() }
    }
}
