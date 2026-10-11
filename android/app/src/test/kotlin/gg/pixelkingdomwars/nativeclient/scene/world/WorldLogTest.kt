package gg.pixelkingdomwars.nativeclient.scene.world

import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.scene.WorldContextFactory
import java.io.File
import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Code 29 (the release integrator's request): the world engine's `PKWWorldGL` lines and its fps readout are the device
 * evidence for every candidate (engine line, `globe ready in`, no FALLBACK, `[world-perf]`, the D-173 band lines), and N5
 * runs the same engine in release builds, which must print none of it. Candidates are optimizedDebug: `DEBUG` is false
 * there, and R8 applies the wallet module's `-assumenosideeffects class android.util.Log`, which deletes any direct Log call.
 */
class WorldLogTest {
    @Test fun `debug builds and QA candidates print the world lines, release prints nothing`() {
        assertTrue("debug", WorldLog.enabledFor(debug = true, candidate = false))
        assertTrue("the optimizedDebug candidate (DEBUG false, NATIVE_CANDIDATE true)", WorldLog.enabledFor(debug = false, candidate = true))
        assertFalse("release (N5 runs the world there): silent", WorldLog.enabledFor(debug = false, candidate = false))
        assertEquals("this JVM run is the debug variant", BuildConfig.DEBUG || BuildConfig.NATIVE_CANDIDATE, WorldLog.enabled)
        // The on-screen readout is narrower than the lines: the owner's Seeker runs the candidate on stage (2026-10-06 the
        // "GL30 globe 27 fps · …" line sat under the globe), so only the unshrunk developer build may draw it.
        assertTrue("developer build: readout on screen", WorldLog.readoutFor(debug = true))
        assertFalse("the candidate on the owner's Seeker: logcat lines yes, readout no", WorldLog.readoutFor(debug = false))
        assertEquals(BuildConfig.DEBUG, WorldLog.readout)
        val seen = ArrayList<String>()
        WorldLog.gate(false) { seen += it }("[world-engine] FALLBACK to the legacy globe: x")
        assertTrue("a closed gate never reaches the sink", seen.isEmpty())
        WorldLog.gate(true) { seen += it }("[world-perf] {}")
        assertEquals(listOf("[world-perf] {}"), seen)
    }

    /** Review 2026-09-27 (minor 10): the near line showed the build's times but not the wait the player saw on the far
     *  layer; it now carries that blur and whether the build finished during the flight there. */
    @Test fun `the near line shows the blur the player waited through and whether the build finished in flight`() {
        assertEquals("[world-perf] near seeker-island decode 12 resample 98 mips 30 upload 41 total 910 blur 350 ms in-flight no (lanes ${WorldEngineHost.ISLE_HELPERS + 1})",
            WorldEngineHost.nearPerfLine("seeker-island", false, 12.4, 98.9, 30.0, 41.0, 910.2, 350.7, false))
        assertTrue(WorldEngineHost.nearPerfLine("solana-island", false, 1.0, 2.0, 3.0, 4.0, 5.0, 0.0, true).contains("blur 0 ms in-flight yes"))
        assertEquals("[world-perf] near divine-isle resident (no build) blur 0 ms", WorldEngineHost.nearPerfLine("divine-isle", true, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, false))
    }

    @Test fun `an enabled line reaches logcat through a call R8's Log rule cannot delete`() {
        // A wrong name or signature here would log nothing on the device, silently: the handle must be Log.println.
        val handle = requireNotNull(WorldLog.printlnHandle) { "Log.println(int, String, String) resolves" }
        assertEquals("android.util.Log", handle.declaringClass.name)
        assertEquals("println", handle.name)
        assertEquals(listOf(Int::class.javaPrimitiveType, String::class.java, String::class.java), handle.parameterTypes.toList())
        assertTrue(Modifier.isStatic(handle.modifiers))
        assertEquals("the tag the owner's logcat filter reads", "PKWWorldGL", WorldContextFactory.TAG)
        val log = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldLog.kt").readText()
        assertTrue("written with the world tag at INFO", "printlnHandle?.invoke(null, Log.INFO, WorldContextFactory.TAG, line)" in log)
        assertFalse("a direct Log call in the gate itself would be stripped from the candidate", DIRECT_LOG.containsMatchIn(code(log)))
    }

    @Test fun `every world engine line and the readout go through the one gate`() {
        val dir = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world")
        val sources = dir.listFiles { f -> f.name.endsWith(".kt") }!!.toList() +
            File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/WorldSurface.kt")
        for (f in sources) assertFalse("${f.name}: a direct Log call bypasses the gate (and R8 strips it from candidates)",
            DIRECT_LOG.containsMatchIn(code(f.readText())))
        val surface = File(dir, "WorldEngineSurface.kt").readText()
        assertEquals("the fragment's and the admission's loggers", 2, Regex("""val log: \(String\) -> Unit = WorldLog\.line""").findAll(surface).count())
        assertTrue("the legacy GL30 path (debug flag)", "val log:(String)->Unit=WorldLog.line" in File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/WorldSurface.kt").readText())
        val host = File(dir, "WorldEngineHost.kt").readText()
        val status = host.substring(host.indexOf("private fun status(now: Double) {"))
        assertTrue("release builds and candidates get no fps readout on screen", status.lines()[1].trim().startsWith("if (!WorldLog.readout) return"))
    }

    private companion object {
        val DIRECT_LOG = Regex("""\bLog\.(v|d|i|w|e|wtf|println)\(""")
        /** Code lines only (KDoc and comments may name the calls). */
        fun code(text: String): String = text.lines().filterNot { val t = it.trimStart(); t.startsWith("*") || t.startsWith("/**") || t.startsWith("//") }.joinToString("\n")
    }
}
