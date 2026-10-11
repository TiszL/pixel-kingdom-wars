package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import org.junit.Test
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess
import kotlin.test.assertEquals

/**
 * P0 (2026-09-26): the owner's Seeker runs the world on a 256 MB Java heap, shared with the globe, the game and the
 * uploader's buffers; its world-load workers died of OutOfMemoryError inside a realm's cold load. One realm's cold load
 * (the first set, then GROUND, LIFE and BASES on the host's two world-load threads, the uploader filling behind them)
 * must fit a heap of [HEAP_MB]: a child JVM with exactly that heap (a small young generation, so the old one holds the
 * peak) dives into the largest realm (frostveil) and the most-visited one (crownlands) until every lane has its art.
 * Before the fix they needed 123 MB and 107 MB (the decoder held ~3.1x its output; LIFE and BASES kept every mip chain;
 * the lanes loaded side by side).
 */
class RealmLoadPeakTest {
    private companion object {
        /**
         * The smallest heap both loads pass in reliably, plus 8 MB (measured 2026-09-26 on this harness, 8 runs each):
         * frostveil 57 MB (at 55 MB 4 of 8 runs fit), crownlands 49 MB. HotSpot sizes a SerialGC heap with -Xmn8m in 8 MB
         * steps (maxMemory 55, 63, 71 MB for -Xmx 49–55, 57–64, 65–72), so this budget is one step above the smallest.
         */
        const val HEAP_MB = 65
    }

    private fun load(realm: String, heapMb: Int): Pair<Int, String> {
        val java = File(System.getProperty("java.home"), "bin/java").path
        val p = ProcessBuilder(java, "-Xmx${heapMb}m", "-Xmn8m", "-XX:+UseSerialGC", "-cp", System.getProperty("java.class.path"),
            RealmLoadPeakMain::class.java.name, realm)
            .directory(File(".").absoluteFile).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        check(p.waitFor(120, TimeUnit.SECONDS)) { "the $realm load did not finish" }
        return p.exitValue() to out.trim()
    }

    @Test fun aColdLoadOfTheLargestRealmFitsTheHeapBudget() {
        val (rc, out) = load("frostveil", HEAP_MB)
        assertEquals(0, rc, "frostveil's cold load in -Xmx${HEAP_MB}m: $out")
    }

    @Test fun aColdLoadOfCrownlandsFitsTheHeapBudget() {
        val (rc, out) = load("crownlands", HEAP_MB)
        assertEquals(0, rc, "crownlands' cold load in -Xmx${HEAP_MB}m: $out")
    }
}

/** The child JVM: one realm's cold load as the host runs it (exit 0 when every lane settled, 2 on OutOfMemoryError, 3
 *  when a world-load thread died, 4 when it did not settle, 5 when a lane settled without its art, e.g. on a caught
 *  OutOfMemoryError). Also run by hand to find the smallest heap that fits. */
object RealmLoadPeakMain {
    @JvmStatic fun main(args: Array<String>) {
        val realm = args[0]
        val pool = Executors.newFixedThreadPool(2) { r ->
            Thread(r, "world-load").apply { isDaemon = true; setUncaughtExceptionHandler { _, e -> println("DIED $e"); Runtime.getRuntime().halt(3) } }
        }
        try {
            val w = RealWorld(pool)
            check(w.engine.prepare(realm))
            fun busy() = (pool as ThreadPoolExecutor).let { it.activeCount > 0 || it.queue.isNotEmpty() }
            // a pinch dive with nothing prefetched: globe frames until dive-ready, then the realm's frames until settled
            var n = 0
            while (!w.engine.ready && w.engine.status != RealmMapEngine.STATUS_FAILED && n < 20_000) { w.globeFrame(); n++; Thread.sleep(1) }
            if (!w.engine.ready) { println("NOT READY $realm status ${w.engine.status} ${w.engine.stats.failure}"); exitProcess(4) }
            val g = w.engine.grid!!
            check(w.engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
            n = 0
            while (!(w.settled() && !busy() && w.uploads.waiting == 0) && n < 20_000) { w.realmFrame(); n++; Thread.sleep(1) }
            val lanes = "ground ${w.ground.stats.status} life ${w.life.stats.why} bases ${w.bases.stats.why}"
            if (!w.settled()) { println("NOT SETTLED $realm $lanes"); exitProcess(4) }
            // a lane that settled on a caught OutOfMemoryError (or any failure) did not fit: every lane must be loaded
            if (w.ground.stats.status != "ready" || !w.life.stats.loaded || !w.bases.stats.loaded) { println("FAILED $realm $lanes"); exitProcess(5) }
            val rt = Runtime.getRuntime()
            println("OK $realm ground ${w.ground.stats.status} life ${w.life.stats.why} bases ${w.bases.stats.why} heap ${(rt.totalMemory() - rt.freeMemory()) shr 20} MB of ${rt.maxMemory() shr 20}")
            exitProcess(0)
        } catch (e: OutOfMemoryError) { println("OOM $realm"); Runtime.getRuntime().halt(2) }
    }
}
