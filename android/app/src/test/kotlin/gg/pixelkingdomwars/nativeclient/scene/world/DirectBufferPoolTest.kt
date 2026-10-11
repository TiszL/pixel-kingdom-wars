package gg.pixelkingdomwars.nativeclient.scene.world

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.7/§5.8: decoded pixels live in pooled buffers with a hard cap (≤ 64 MB transient on the Seeker's
 * 8 GB), and a slow upload worker throttles decoding instead of letting decoded layers pile up in memory.
 */
class DirectBufferPoolTest {
    @Test fun `decoding blocks at the cap until the worker releases a buffer`() {
        val pool = DirectBufferPool(maxOutstandingBytes = 100, maxIdleBytes = 100)
        val first = pool.acquire(80)
        val acquired = CountDownLatch(1)
        val decoder = Thread { pool.acquire(40); acquired.countDown() }.apply { isDaemon = true; start() }
        assertFalse("80 + 40 is over the cap: the decode thread must wait", acquired.await(100, TimeUnit.MILLISECONDS))
        assertTrue(eventually { pool.waits == 1L })
        pool.release(first)
        assertTrue(acquired.await(5, TimeUnit.SECONDS))
        decoder.join(1_000)
        assertEquals(40L, pool.outstandingBytes)
    }

    @Test fun `a single layer larger than the cap is still served when nothing else is out`() {
        val pool = DirectBufferPool(maxOutstandingBytes = 16, maxIdleBytes = 0)
        val big = pool.acquire(64)
        assertEquals(64, big.limit()); assertEquals(0, big.position()); assertEquals(ByteOrder.nativeOrder(), big.order())
        pool.release(big)
        assertEquals(0L, pool.outstandingBytes)
    }

    /**
     * P0 (2026-09-26 Seeker OutOfMemoryError): on ART a direct buffer is a Java-heap array under the app's 256 MB growth
     * limit, so the world's staging holds at most 24 MB out and 4 MB idle (was 64 + 16 MB beside the decoders' peaks).
     * The biggest single fill the world makes (a 2048² RGBA8 near-art level, 16 MB; a frostveil GROUND class upload up to
     * ~19 MB) still passes, and one larger than the cap passes alone, or it could never upload.
     */
    @Test fun `the world's staging holds at most 24 MB out and 4 MB idle, and one oversize fill still passes alone`() {
        assertEquals(24L shl 20, DirectBufferPool.WORLD_MAX_OUTSTANDING_BYTES)
        assertEquals(4L shl 20, DirectBufferPool.WORLD_MAX_IDLE_BYTES)
        val host = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        assertTrue("the host stages through these caps", "DirectBufferPool.world()" in host)
        val pool = DirectBufferPool.world()
        val near = pool.acquire(16 shl 20); val layer = pool.acquire(8 shl 20)
        assertEquals("24 MB out: at the cap, nobody waited", 0L, pool.waits)
        val late = AtomicReference<ByteBuffer>()
        val served = CountDownLatch(1)
        Thread { late.set(pool.acquire(1 shl 20)); served.countDown() }.apply { isDaemon = true; start() }
        assertFalse("one more MB would pass the cap: the decode thread waits for the worker", served.await(100, TimeUnit.MILLISECONDS))
        pool.release(near) // 16 MB: over the idle cap, left to the GC
        assertTrue(served.await(5, TimeUnit.SECONDS))
        pool.release(layer); pool.release(late.get()) // 8 MB dropped; 1 MB kept for reuse
        assertEquals(0L, pool.outstandingBytes)
        val again = pool.acquire(16 shl 20)
        assertNotSame("never 16 MB of idle heap: a big buffer is allocated afresh, not kept", near, again)
        pool.release(again)
        assertSame("a small layer's buffer is reused", late.get(), pool.acquire(1 shl 20))
    }

    @Test fun `a fill larger than the world's cap is served when nothing else is out`() {
        val pool = DirectBufferPool.world()
        val big = pool.acquire(40 shl 20)
        assertEquals(40 shl 20, big.limit())
        pool.release(big)
        assertEquals(0L, pool.outstandingBytes)
    }

    @Test fun `idle buffers are reused and a double release cannot corrupt the tally`() {
        val pool = DirectBufferPool(maxOutstandingBytes = 1_000, maxIdleBytes = 1_000)
        val a = pool.acquire(256)
        a.position(100)
        pool.release(a)
        pool.release(a)
        assertEquals(0L, pool.outstandingBytes)
        val b = pool.acquire(200)
        assertSame("the idle 256-byte buffer serves a 200-byte request", a, b)
        assertEquals(200, b.limit()); assertEquals(0, b.position())
        assertEquals(200L, pool.outstandingBytes)
    }
}
