package gg.pixelkingdomwars.nativeclient.scene.world

import gg.pixelkingdomwars.nativeclient.renderer.gl3.DirectProgramCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import java.io.File
import java.lang.ref.WeakReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0 (the 2026-09-26 Seeker OutOfMemoryError): the JVM harness shows no per-visit growth inside one realm engine, yet the
 * Seeker's heap was full in a fresh host after six. The registry is how the lead sees, on the device, whether hosts,
 * engines or globes outlive their dispose: its counts must be exact (a count that includes collected objects would read
 * as a leak; one that forgets reachable ones would hide it), and a disposed object still reachable must be told apart.
 */
class WorldLiveInstancesTest {
    @Test fun `live counts are exact per kind, and a disposed but reachable host is counted as such`() {
        val r = WorldLiveRegistry()
        val a = Any(); val b = Any(); val engine = Any(); val globe = Any()
        r.track(WorldLiveRegistry.HOST, a); r.track(WorldLiveRegistry.HOST, b); r.track(WorldLiveRegistry.HOST, a)
        r.track(WorldLiveRegistry.ENGINE, engine); r.track(WorldLiveRegistry.GLOBE, globe)
        assertEquals("tracked once each", 2, r.live(WorldLiveRegistry.HOST))
        assertEquals(1, r.live(WorldLiveRegistry.ENGINE)); assertEquals(1, r.live(WorldLiveRegistry.GLOBE))
        r.disposed(a)
        assertEquals("the leak signal: disposed and still reachable", 1, r.liveDisposed(WorldLiveRegistry.HOST))
        assertEquals(2, r.live(WorldLiveRegistry.HOST))
        assertEquals(0, r.liveDisposed(WorldLiveRegistry.ENGINE))
        r.disposed(Any()) // never tracked: ignored
        assertEquals(1, r.liveDisposed(WorldLiveRegistry.HOST))
    }

    @Test fun `a collected object drops out of the counts, the registry never keeps it alive`() {
        val r = WorldLiveRegistry()
        val kept = Any()
        r.track(WorldLiveRegistry.HOST, kept)
        val gone = track(r) // tracked, disposed, and no strong reference left
        assertEquals(2, r.live(WorldLiveRegistry.HOST))
        var n = 0
        while (gone.get() != null && n++ < 50) { System.gc(); Thread.sleep(10) }
        assertTrue("the registry holds only weak references (else it would be the leak)", gone.get() == null)
        assertEquals(1, r.live(WorldLiveRegistry.HOST))
        assertEquals(0, r.liveDisposed(WorldLiveRegistry.HOST))
        r.disposed(kept) // (and [kept], reachable all along, is still the one counted)
        assertEquals(1, r.liveDisposed(WorldLiveRegistry.HOST))
    }

    private fun track(r: WorldLiveRegistry): WeakReference<Any> {
        val o = Any()
        r.track(WorldLiveRegistry.HOST, o); r.disposed(o)
        return WeakReference(o)
    }

    @Test fun `the line names the counts, the Java and native heaps and the GL tally per pool, in every locale`() {
        val r = WorldLiveRegistry()
        val host = Any(); r.track(WorldLiveRegistry.HOST, host); r.disposed(host)
        val gl = RecordingGl3("world")
        val core = Gl3Core(gl.gl, DirectProgramCompiler(ProgramBuilder(gl.gl, null, "RealmView", 0)), 256 * 1024L, strict = true).apply { resize(8, 8) }
        core.texture2D(Gl3Pool.REALM, 1024, 512, Gl3Format.RGBA8) // 2 MB of realm GL
        val runtime = Runtime.getRuntime()
        val line = r.line("dive crownlands", core, 45L shl 20, runtime)
        assertTrue(line, line.startsWith("[world-memory] dive crownlands hosts 1 (disposed 1) engines 0 (0) globes 0 (0) · java "))
        assertTrue(line, Regex(""" · java \d+\.\d/\d+\.\d MB · native 45\.0 MB · gl globe 0\.0 realm 2\.0 core 0\.0 MB$""").containsMatchIn(line))
        val was = java.util.Locale.getDefault()
        try { java.util.Locale.setDefault(java.util.Locale.GERMANY); assertTrue("a comma locale prints the same digits", r.line("x", core, 1L shl 20).contains("native 1.0 MB")) }
        finally { java.util.Locale.setDefault(was) }
        assertTrue("off the device the native heap is unknown, never a crash", r.line("x", null, -1).contains("native -1 MB"))
    }

    @Test fun `the host registers itself, its globe and its engine, and logs at create, dispose and every dive`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        assertTrue("init { WorldLiveInstances.track(WorldLiveRegistry.HOST, this) }" in host)
        assertTrue("WorldLiveInstances.track(WorldLiveRegistry.GLOBE, g)" in host)
        assertTrue("WorldLiveInstances.track(WorldLiveRegistry.ENGINE, it)" in host)
        val create = host.substring(host.indexOf("override fun create()"), host.indexOf("private fun start(world: WorldGraphics"))
        assertTrue("WorldLiveInstances.log(\"create\", core, log)" in create)
        val dispose = host.substring(host.indexOf("override fun dispose()"), host.indexOf("override fun render()"))
        assertTrue("for (o in listOfNotNull(g, r, this)) WorldLiveInstances.disposed(o)" in dispose && "WorldLiveInstances.log(\"dispose\", c, log)" in dispose)
        val dive = host.substring(host.indexOf("private fun beginDive"), host.indexOf("private fun diveStep"))
        assertTrue("WorldLiveInstances.log(\"dive \$realmId\", core, log)" in dive)
        val live = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldLiveInstances.kt").readText()
        assertTrue("release tracks and prints nothing: the gate is WorldLog's", "val enabled: Boolean get() = WorldLog.enabled" in live)
    }
}
