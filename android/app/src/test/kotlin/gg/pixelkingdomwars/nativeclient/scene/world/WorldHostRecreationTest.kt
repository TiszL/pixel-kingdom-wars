package gg.pixelkingdomwars.nativeclient.scene.world

import android.content.res.AssetManager
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeFiles
import gg.pixelkingdomwars.nativeclient.scene.StagingUploader
import gg.pixelkingdomwars.nativeclient.ui.world.RealmGridInfo
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudEvent
import java.io.Closeable
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0, by a path the GL teardown never runs: an activity recreation with the World tab open. MainActivity's configChanges
 * lists none of uiMode, fontScale, locale or density, so a dark-mode flip (an automatic night schedule too, while the app
 * sits in the background on World), a font-size or a locale change relaunches the activity. libGDX 1.13.1 destroys its
 * graphics, and so runs the host's dispose, only in `AndroidFragmentApplication.onPause`, and only while the fragment is
 * being removed or the activity is finishing (javap: no onDestroy override), which a relaunch is not. The host's
 * world-load and world-decode pools (core threads never time out) and its GL worker thread then ran on, and a live thread
 * is a GC root: the pool threads' exception handler held the host, so each recreation stranded a whole world (globe,
 * realm, lanes, staging, core; through the worker's EGL context the share group's GPU memory too) while the new activity
 * built another host. So: the fragment's view teardown releases, without GL, a host libGDX never disposed, and no pool
 * thread keeps a host alive.
 */
class WorldHostRecreationTest {
    private val ids = SharedIds()
    private val contexts = FakeWorkerContexts(ids)
    private val logged = CopyOnWriteArrayList<String>()
    private val started = CopyOnWriteArrayList<Any>()

    @After fun tearDown() {
        for (o in started) when (o) { is ExecutorService -> o.shutdownNow(); is WorldGlWorker -> o.dispose(); else -> Unit }
    }

    @Test fun `a host libGDX never disposed stops its threads, closes its leases and is collected after the view teardown`() {
        val closed = AtomicInteger()
        val built = build(closed) { it.releaseWithoutGl() }

        assertTrue("the world-load pool's threads end", built.load.awaitTermination(5, TimeUnit.SECONDS))
        assertTrue("the world-decode pool's threads end", built.decode.awaitTermination(5, TimeUnit.SECONDS))
        assertTrue("the GL worker stops (and destroys its context, which frees the share group's GPU memory)",
            eventually { built.worker.stopped })
        assertTrue("the worker destroyed its own context", eventually { contexts.created.all { it.destroyedOn != null } })
        assertEquals("the chain leases are closed once", 1, closed.get())
        assertTrue("with its threads gone, nothing keeps the host: it is collected", collected(built.host))
    }

    @Test fun `a pool thread never keeps a host alive, even one nothing tore down`() {
        // the recreation before this fix: no dispose and no release, the pool threads idle on their queues for good
        val built = build(AtomicInteger()) {}
        assertFalse("the scenario: the pools still run", built.load.isShutdown || built.decode.isShutdown)
        assertTrue("an idle pool thread (a GC root) must not reach the host through its exception handler", collected(built.host))
    }

    @Test fun `the release and a dispose run once between them, whichever comes first`() {
        // the normal leave: libGDX's destroy runs dispose on the GL thread inside onPause, then onDestroyView releases
        val closedA = AtomicInteger()
        val a = host(closedA)
        assertFalse(a.disposed)
        a.dispose(); a.releaseWithoutGl()
        assertTrue(a.disposed)
        assertEquals("a dispose then the view teardown close the leases once", 1, closedA.get())
        // a release first (a recreation), then any late dispose
        val closedB = AtomicInteger()
        val b = host(closedB)
        b.releaseWithoutGl(); b.dispose()
        assertEquals("a release then a dispose close the leases once", 1, closedB.get())
        assertTrue(b.disposed)
    }

    @Test fun `the release drops every heavy reference, as a dispose does`() {
        val h = host(AtomicInteger())
        val worker = WorldGlWorker(contexts, contexts.create("world-1")!!, { null }, "RealmView", 0).also { started += it }
        val decode = Executors.newFixedThreadPool(1).also { started += it }
        set(h, "staging", StagingUploader(worker, decode, DirectBufferPool.world()))
        set(h, "loadPool", Executors.newFixedThreadPool(1).also { started += it })
        val isle = Executors.newFixedThreadPool(1).also { started += it }
        set(h, "islePool", isle)
        set(h, "worker", worker)
        set(h, "mapIds", setOf("crownlands"))
        h.releaseWithoutGl()
        for (field in listOf("globe", "realm", "lanes", "staging", "core", "loadPool", "islePool", "worker")) assertNull("$field is dropped", get(h, field))
        assertTrue("the island lanes (2026-09-27) stop with the load pool", isle.isShutdown)
        assertEquals(emptySet<String>(), get(h, "mapIds"))
    }

    @Test fun `the World fragment's view teardown releases its host before letting it go`() {
        val surface = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineSurface.kt").readText()
        val fragment = surface.substring(surface.indexOf("class WorldEngineFragment"))
        val teardown = fragment.substring(fragment.indexOf("override fun onDestroyView()"))
        val release = teardown.indexOf("releaseWithoutGl()")
        assertTrue("onDestroyView releases the host: nothing else runs on a recreation", release >= 0)
        assertTrue("before the fragment forgets it", release < teardown.indexOf("host = null"))
    }

    // ---------------------------------------------------------------- the host as start() leaves it

    private class Built(val host: WeakReference<WorldEngineHost>, val load: ExecutorService, val decode: ExecutorService, val worker: WorldGlWorker)

    /** A host with what start() gives it off GL: both pools on the host's own thread factory with every core thread
     *  running, and a GL worker idle on its queue; then [teardown]. Only a weak reference to the host leaves here. */
    private fun build(closed: AtomicInteger, teardown: (WorldEngineHost) -> Unit): Built {
        val h = host(closed)
        val load = Executors.newFixedThreadPool(2, WorldEngineHost.workerThreads("world-load", h)).also { started += it }
        val decode = Executors.newFixedThreadPool(2, WorldEngineHost.workerThreads("world-decode", h)).also { started += it }
        val running = CountDownLatch(4)
        repeat(2) { load.execute { running.countDown() }; decode.execute { running.countDown() } }
        assertTrue(running.await(5, TimeUnit.SECONDS))
        val worker = WorldGlWorker(contexts, contexts.create("world-1")!!, { null }, "RealmView", 0).also { started += it }
        set(h, "loadPool", load)
        set(h, "staging", StagingUploader(worker, decode, DirectBufferPool.world()))
        set(h, "worker", worker)
        teardown(h)
        return Built(WeakReference(h), load, decode, worker)
    }

    private fun host(closed: AtomicInteger): WorldEngineHost {
        val assets = blank(AssetManager::class.java)
        val inputs = WorldHostInputs(assets, AssetWorldFiles(assets), NoFiles, null, null, 2.0, Closeable { closed.incrementAndGet() }, null)
        return WorldEngineHost(inputs, { null }, NoCallbacks, File("build/tmp/world-programs"), 1L) { logged += it }
    }

    private fun collected(ref: WeakReference<*>): Boolean {
        var n = 0
        while (ref.get() != null && n++ < 100) { System.gc(); Thread.sleep(10) }
        return ref.get() == null
    }

    private object NoFiles : GlobeFiles { override fun read(path: String): ByteArray? = null }

    private object NoCallbacks : WorldHostCallbacks {
        override fun ready() {}
        override fun failed(reason: String) {}
        override fun framePublished() {}
        override fun event(event: WorldHudEvent) {}
        override fun mapRealms(ids: Set<String>) {}
        override fun readiness(realmId: String, value: Float) {}
        override fun realmGrid(info: RealmGridInfo?) {}
        override fun loading(value: Float) {}
        override fun status(line: String) {}
        override fun bandGate(held: Boolean, band: Int, progress: Double) {}
        override fun detailRealms(ids: Set<String>) {}
    }

    private companion object {
        fun field(name: String) = WorldEngineHost::class.java.getDeclaredField(name).apply { isAccessible = true }
        fun set(host: WorldEngineHost, name: String, value: Any?) = field(name).set(host, value)
        fun get(host: WorldEngineHost, name: String): Any? = field(name).get(host)

        /** An android.jar class the JVM cannot construct, with every field null. */
        fun <T> blank(type: Class<T>): T {
            val unsafeType = Class.forName("sun.misc.Unsafe")
            val unsafe = unsafeType.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
            return type.cast(unsafeType.getMethod("allocateInstance", Class::class.java).invoke(unsafe, type))
        }
    }
}
