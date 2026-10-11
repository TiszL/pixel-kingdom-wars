package gg.pixelkingdomwars.nativeclient.renderer

import java.util.concurrent.Executor
import org.junit.Test
import kotlin.test.*

class LatestPreparationTest {
    @Test fun `closing during active work drops pending closures and never rearms the executor`() {
        val tasks = ArrayDeque<Runnable>()
        val preparation = LatestPreparation(Executor(tasks::addLast))
        var stale = false
        preparation.submit(0) {
            preparation.submit(1) { stale = true }
            preparation.close()
            preparation.submit(2) { stale = true }
        }
        tasks.removeFirst().run()
        assertFalse(stale); assertTrue(tasks.isEmpty()); assertEquals(0,preparation.depth())
        val queued = LatestPreparation(Executor(tasks::addLast))
        queued.submit(0) { stale = true }; queued.close(); tasks.removeFirst().run()
        assertFalse(stale)
    }
    @Test fun `a dense stream keeps the running revision and only its newest replacement`() {
        val tasks = ArrayDeque<Runnable>()
        val preparation = LatestPreparation(Executor(tasks::addLast))
        val seen = mutableListOf<Int>()
        preparation.submit(0) {
            seen += 0
            repeat(100) { revision -> preparation.submit(revision + 1L) { seen += revision + 1 } }
            assertEquals(2, preparation.depth())
            assertTrue(tasks.isEmpty(), "revisions must not form an executor queue")
        }
        assertEquals(1, tasks.size)
        tasks.removeFirst().run()
        assertEquals(1,tasks.size,"the replacement yields the worker to catalogue/lifecycle tasks")
        tasks.removeFirst().run()
        assertEquals(listOf(0,100), seen)
        assertEquals(0, preparation.depth())
        preparation.submit(101) { seen += 101 }; tasks.removeFirst().run()
        assertEquals(101, seen.last(), "idle preparation must rearm")
    }

    @Test fun `a late GL repair cannot evict a newer scene admitted by Main`() {
        val tasks = ArrayDeque<Runnable>()
        val preparation = LatestPreparation(Executor(tasks::addLast))
        val seen = mutableListOf<String>()
        preparation.submit(7) {
            // Main publishes B after GL checks A, but before GL can enqueue A's painting repair.
            preparation.submit(8) { seen += "newer scene B" }
            preparation.submit(7) { seen += "stale repair A" }
        }
        tasks.removeFirst().run(); tasks.removeFirst().run()
        assertEquals(listOf("newer scene B"),seen)
        preparation.submit(7) { seen += "late stale A" }
        assertTrue(tasks.isEmpty(),"Completed newer work must not let an obsolete repair rearm the queue")
        preparation.submit(8) { seen += "same generation repair B" }; tasks.removeFirst().run()
        assertEquals(listOf("newer scene B","same generation repair B"),seen)
    }

    @Test fun `wall activation yields between bounded batches and replaces stale pending uploads`() {
        var now = 0L
        val queue = FrameUploadQueue<Int> { now }
        val uploaded = mutableListOf<Int>()
        queue.replace((0 until 1000).toList())
        queue.advance { uploaded += it }
        assertEquals(8, uploaded.size)
        queue.advance { uploaded += it; now += 2_000_000 }
        assertEquals(9, uploaded.size, "one slow upload must yield immediately after it completes")
        queue.replace(listOf(2000,2001))
        queue.advance { uploaded += it }
        assertEquals(listOf(2000,2001), uploaded.takeLast(2))
        assertEquals(0, queue.size)
    }
}
