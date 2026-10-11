package gg.pixelkingdomwars.nativeclient.scene.world

import android.content.res.AssetManager
import gg.pixelkingdomwars.nativeclient.renderer.gl3.DirectProgramCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeFiles
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Renderer
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine
import gg.pixelkingdomwars.nativeclient.scene.StagingUploader
import gg.pixelkingdomwars.nativeclient.ui.world.RealmGridInfo
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudEvent
import java.io.Closeable
import java.io.File
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0 (the 2026-09-26 Seeker OutOfMemoryError): the host's dispose is where a World visit gives its memory back. Two
 * defects made visits accumulate: a teardown step that threw skipped every step after it (a globe that threw left the
 * realm engine, the uploader, the core, the load pool and the chain leases alive), and the detail lanes were never
 * dropped (a lane load finishing after the dispose was held through them: +48.7 MB measured), while a disposed host stays
 * reachable (libGDX's `Gdx.app`, the HUD bridge). So: every step runs whatever the others do, and nothing heavy is
 * reachable from a disposed host.
 */
class WorldHostTeardownTest {
    private val ids = SharedIds()
    private val contexts = FakeWorkerContexts(ids)
    private val worker = WorldGlWorker(contexts, contexts.create("world-1")!!, { null }, "RealmView", 0)
    private val logged = CopyOnWriteArrayList<String>()

    @After fun tearDown() { worker.dispose() }

    @Test fun `a step that throws never skips the steps after it`() {
        val ran = ArrayList<String>()
        val failed = WorldTeardown.run({ logged += it },
            "globe" to { ran += "globe"; throw IllegalStateException("glDeleteBuffers after a lost context") },
            "realm" to { ran += "realm"; throw OutOfMemoryError("Failed to allocate a 5242896 byte allocation") },
            "core" to { ran += "core" },
            "resources" to { ran += "resources" })
        assertEquals("every step, in order", listOf("globe", "realm", "core", "resources"), ran)
        assertEquals(listOf("globe", "realm"), failed)
        assertTrue("each failure is logged by name: $logged", logged[0].startsWith("dispose: globe failed: IllegalStateException") &&
            logged[1].startsWith("dispose: realm failed: OutOfMemoryError"))
    }

    @Test fun `after a dispose whose steps throw, every step still ran and nothing heavy is reachable from the host`() {
        var closed = 0
        val assets = blank(AssetManager::class.java)
        val inputs = WorldHostInputs(assets, AssetWorldFiles(assets), NoFiles, null, null, 2.0, Closeable { closed++ }, null)
        val host = WorldEngineHost(inputs, { null }, NoCallbacks, File("build/tmp/world-programs"), 1L) { logged += it }
        val world = RecordingGl3("world", ids)
        val core = Gl3Core(world.gl, DirectProgramCompiler(ProgramBuilder(world.gl, null, "RealmView", 0)), 256 * 1024L, strict = true).apply { resize(8, 8) }
        core.texture2D(Gl3Pool.REALM, 64, 64, Gl3Format.RGBA8)
        val pool = Executors.newFixedThreadPool(1)
        // a globe and a realm engine whose own dispose throws (never-built stand-ins), an uploader whose decode pool
        // refuses to shut down: three of the six steps fail, the first two first
        set(host, "globe", blank(GlobeV2Renderer::class.java))
        set(host, "realm", blank(RealmMapEngine::class.java))
        set(host, "staging", StagingUploader(worker, RefusingShutdown(), DirectBufferPool.world()))
        set(host, "core", core)
        set(host, "loadPool", pool)
        set(host, "lanes", blank(Class.forName("gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineHost\$DetailLanes")))
        set(host, "mapIds", setOf("crownlands", "frostveil"))

        host.dispose() // never throws out of libGDX's GL-thread handshake

        assertTrue("the core's textures were deleted", world.count("deleteTexture") >= 1)
        assertEquals("the realm pool's tally is back to zero", 0L, core.stats.gpuBytes(Gl3Pool.REALM))
        assertTrue("the load pool is shut down", pool.isShutdown)
        assertEquals("the chain leases are closed", 1, closed)
        val failures = logged.filter { it.contains("dispose: ") }
        assertEquals(3, failures.size)
        assertTrue(failures.toString(), failures[0].contains("globe failed") && failures[1].contains("realm failed") && failures[2].contains("staging failed"))
        for (field in listOf("globe", "realm", "lanes", "staging", "core", "loadPool")) assertNull("$field is dropped", get(host, field))
        assertEquals("no realm ids are kept", emptySet<String>(), get(host, "mapIds"))
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

    /** A decode pool whose shutdown throws (the uploader's dispose step fails). */
    private class RefusingShutdown : AbstractExecutorService() {
        override fun execute(command: Runnable) {}
        override fun shutdown() { throw IllegalStateException("refused") }
        override fun shutdownNow(): MutableList<Runnable> = throw IllegalStateException("refused")
        override fun isShutdown(): Boolean = false
        override fun isTerminated(): Boolean = false
        override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = false
    }

    private companion object {
        fun field(name: String) = WorldEngineHost::class.java.getDeclaredField(name).apply { isAccessible = true }
        fun set(host: WorldEngineHost, name: String, value: Any?) = field(name).set(host, value)
        fun get(host: WorldEngineHost, name: String): Any? = field(name).get(host)

        /** An instance whose constructor never ran (every field null): a stand-in whose own dispose throws, or an
         *  android.jar class the JVM cannot construct. */
        fun <T> blank(type: Class<T>): T {
            val unsafeType = Class.forName("sun.misc.Unsafe")
            val unsafe = unsafeType.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
            return type.cast(unsafeType.getMethod("allocateInstance", Class::class.java).invoke(unsafe, type))
        }
    }
}
