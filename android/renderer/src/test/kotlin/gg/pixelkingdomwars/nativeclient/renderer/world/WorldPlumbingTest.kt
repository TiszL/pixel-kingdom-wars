package gg.pixelkingdomwars.nativeclient.renderer.world

import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.test.*
import org.junit.Test

class WorldIntentsTest {
    @Test fun `intents reach the GL thread in order and every offer wakes the pacer`() {
        val wakes = AtomicInteger()
        val intents = WorldIntents { wakes.incrementAndGet() }
        intents.offer(WorldIntent.Select(WorldTarget.Realm("frostveil")))
        intents.offer(WorldIntent.FlyTo(WorldTarget.Deed("frostveil", 12, 40), d = 700.0))
        intents.offer(WorldIntent.Leave)
        val seen = ArrayList<WorldIntent>()
        assertEquals(3, intents.drain { seen += it })
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Realm("frostveil")), WorldIntent.FlyTo(WorldTarget.Deed("frostveil", 12, 40), 700.0), WorldIntent.Leave), seen)
        assertEquals(3, wakes.get(), "an intent without a frame after it would sit until the next touch")
        assertEquals(0, intents.drain { fail("drained twice") })
    }

    @Test fun `producers on several threads never lose or reorder their own intents`() {
        val intents = WorldIntents {}
        val start = CountDownLatch(1)
        val producers = (0 until 4).map { p -> thread { start.await(); repeat(5_000) { intents.offer(WorldIntent.FlyTo(WorldTarget.Tile("r$p", it, 0))) } } }
        val last = IntArray(4) { -1 }; var total = 0
        start.countDown()
        while (producers.any { it.isAlive } || !intents.isEmpty) intents.drain { intent ->
            val tile = ((intent as WorldIntent.FlyTo).target as WorldTarget.Tile)
            val p = tile.realmId.substring(1).toInt()
            assertTrue(tile.tileX > last[p], "producer $p reordered"); last[p] = tile.tileX; total++
        }
        assertEquals(20_000, total)
    }

    @Test fun `snapshots and rects are validated where the UI thread builds them`() {
        assertFailsWith<IllegalArgumentException> { WorldBases(1, "crownlands", IntArray(2), IntArray(2), IntArray(1), IntArray(2)) }
        assertFailsWith<IllegalArgumentException> { WorldBases(1, "crownlands", IntArray(2), IntArray(2), IntArray(2), IntArray(2), BooleanArray(1)) }
        assertFailsWith<IllegalArgumentException> { WorldIntent.SetUiRects(FloatArray(7), 2) }
    }
}

class WorldFrameExchangeTest {
    @Test fun `the reader gets the newest published frame and keeps it until it asks again`() {
        val exchange = WorldFrameExchange(4)
        assertEquals(0L, exchange.latest().sequence, "nothing published yet")
        exchange.back().band = 1; exchange.publish()
        exchange.back().band = 2; exchange.publish()
        val read = exchange.latest()
        assertEquals(2L, read.sequence); assertEquals(2, read.band)
        exchange.back().band = 3; exchange.publish()
        exchange.back().band = 4; exchange.publish()
        assertEquals(2, read.band, "the writer wrote into the frame the UI thread is laying out")
        assertEquals(4, exchange.latest().band)
        assertSame(exchange.latest(), exchange.latest())
    }

    @Test fun `a layout pass never sees a torn frame while the GL thread publishes`() {
        val exchange = WorldFrameExchange(64)
        val torn = AtomicReference<String?>(null)
        val done = CountDownLatch(1)
        val writer = thread {
            var n = 0
            while (done.count > 0) {
                val f = exchange.back(); n++
                f.anchorCount = 0; f.cameraX = n.toDouble()
                for (i in 0 until 64) f.addAnchor(n, n.toFloat(), n.toFloat())
                exchange.publish()
            }
        }
        var lastSequence = 0L
        repeat(200_000) {
            val f = exchange.latest()
            if (f.sequence == 0L) return@repeat
            val id = f.anchorIds[0]
            for (i in 0 until f.anchorCount) if (f.anchorIds[i] != id || f.anchorXY[i * 2] != id.toFloat()) torn.set("frame ${f.sequence} slot $i")
            if (f.cameraX != id.toDouble()) torn.set("camera of frame ${f.sequence}")
            if (f.sequence < lastSequence) torn.set("went back from $lastSequence to ${f.sequence}")
            lastSequence = f.sequence
        }
        done.countDown(); writer.join()
        assertNull(torn.get())
        assertTrue(lastSequence > 0)
    }

    @Test fun `a full anchor list refuses more anchors instead of overrunning`() {
        val frame = WorldFrame(1)
        assertTrue(frame.addAnchor(7, 1f, 2f))
        assertFalse(frame.addAnchor(8, 3f, 4f))
        assertEquals(1, frame.anchorCount)
    }
}
