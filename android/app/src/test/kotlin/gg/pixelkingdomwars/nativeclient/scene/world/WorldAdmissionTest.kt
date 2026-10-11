package gg.pixelkingdomwars.nativeclient.scene.world

import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * N5 (D-175/D-NEXT): the GL30 world runs in RELEASE builds on GLES 3.0+ devices, with the world content bundled in the
 * APK, and the legacy globe everywhere else. Two levers send a device back to the legacy globe without a release: the
 * server's `worldV2` kill switch (the last value the app read) and this device's crash record.
 */
class WorldAdmissionTest {
    private fun capabilities(worldV2: String?) = NativeCapabilities.from(Json.parseToJsonElement(
        """{"protocolVersion":1,"simVersion":17${worldV2?.let { ",\"worldV2\":$it" } ?: ""}}""").jsonObject)

    private class Disk { val values = mutableMapOf<String, String>(); val switch = WorldV2Switch({ values[it] }, { k, v -> values[k] = v }) }

    @Test fun `release admits the GL30 world when the bundle is present and nothing refuses`() {
        // The whole point of N5: a release build on a GLES 3 phone with the bundled content runs the new world. The rule
        // takes no build type, so nothing but these inputs can keep release on the legacy globe.
        assertNull(WorldEngineAdmission.refusal(legacyRequested = false, gles = 0x30000, bundle = true, worldV2 = true, hangStop = null))
        assertNull("ES 3.1", WorldEngineAdmission.refusal(false, 0x30001, true, true, null))
        assertNull("ES 3.2", WorldEngineAdmission.refusal(false, 0x30002, true, true, null))
    }

    @Test fun `each lever alone sends the device to the legacy globe`() {
        fun refusal(legacy: Boolean = false, gles: Int = 0x30000, bundle: Boolean = true, worldV2: Boolean = true, hang: String? = null) =
            WorldEngineAdmission.refusal(legacy, gles, bundle, worldV2, hang)
        assertEquals("OpenGL ES 0x20000 < 3.0", refusal(gles = 0x20000))
        assertEquals("no device report is no GL30", "OpenGL ES 0x0 < 3.0", refusal(gles = 0))
        assertEquals("a build without the generated bundle keeps the legacy globe instead of failing to load",
            "this build carries no world content", refusal(bundle = false))
        assertEquals("the new world is switched off by the server (worldV2)", refusal(worldV2 = false))
        assertEquals("the realm map is stopped on this device: a visit ended inside the realm map even in safe mode",
            refusal(hang = "a visit ended inside the realm map even in safe mode"))
        assertEquals("the legacy globe was requested (worldLegacy)", refusal(legacy = true))
    }

    @Test fun `the switch is ON until the server says otherwise`() {
        // Nothing cached (a fresh install, or no capabilities read yet) must not lock players out of the shipped world.
        assertTrue(Disk().switch.enabled)
        assertTrue("an unreadable store is ON (the server's default)", WorldV2Switch({ error("unreadable") }, { _, _ -> }).enabled)
    }

    @Test fun `a switch-off holds until the server switches the world back on`() {
        // The owner's incident lever: once read, OFF must survive an older server, a route without the key, a malformed
        // value and every failed read (onCapabilities never runs then); only an explicit ON lifts it.
        val disk = Disk(); val switch = disk.switch
        switch.onCapabilities(capabilities("""{"enabled":false}"""))
        assertFalse(switch.enabled)
        switch.onCapabilities(capabilities(null)); assertFalse("absent keeps the cached value", switch.enabled)
        switch.onCapabilities(capabilities("\"off\"")); assertFalse("malformed keeps the cached value", switch.enabled)
        assertFalse("the value survives the process", WorldV2Switch({ disk.values[it] }, { _, _ -> }).enabled)
        switch.onCapabilities(capabilities("""{"enabled":true}"""))
        assertTrue(switch.enabled)
        switch.onCapabilities(capabilities(null)); assertTrue(switch.enabled)
        switch.onCapabilities(capabilities("{}")); assertTrue("the server's default is ON", switch.enabled)
        WorldV2Switch({ null }, { _, _ -> error("disk full") }).onCapabilities(capabilities("""{"enabled":false}""")) // never throws into the read
    }

    @Test fun `each API origin keeps its own switch`() {
        // A candidate or local server's switch must never answer for production, like the app's other stores.
        assertEquals("world-v2", WorldV2Switch.storeName("https://play.pixelkingdomwars.com"))
        val candidate = WorldV2Switch.storeName("https://qa.pixelkingdomwars.com")
        assertTrue(candidate.startsWith("world-v2-")); assertNotEquals("world-v2", candidate)
    }

    @Test fun `every capabilities read reaches the switch and the admission reads the real levers`() {
        // Without these lines the switch is never written (the owner's OFF would do nothing) or never read.
        val graph = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/AppGraph.kt").readText()
        assertTrue("the content check's capabilities", Regex("""LiveContentRepository\([^)]*\) \{ worldV2\.onCapabilities\(it\); updates\.onCapabilities\(it\) }""").containsMatchIn(graph))
        assertTrue("the update channel's own capabilities read (signed out too)", "updateCapabilities(gameApi, " in graph &&
            Regex("""updateCapabilities\(gameApi, [^\n]*\.also \{ worldV2\.onCapabilities\(it\) }""").containsMatchIn(graph))
        val surface = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineSurface.kt").readText()
        val admission = surface.substring(surface.indexOf("object WorldEngineAdmission"), surface.indexOf("class WorldPackFiles"))
        assertTrue("the last worldV2 read", "WorldV2Switch.of(context).enabled" in admission)
        assertTrue("this device's crash record, dated by the wall clock", "HangMemory.stopReason(HangRecordStore.of(context).load(), System.currentTimeMillis())" in admission)
    }

    @Test fun `nothing on the path to the GL30 world is gated to debug builds`() {
        // Release must reach the new world: only the diagnostics gate (WorldLog: debug and candidate print, release is
        // silent) and the debug launch extras may read the build type.
        val main = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
        for (dir in listOf("scene/world", "ui/world")) File(main, dir).walk().filter { it.isFile && it.name != "WorldLog.kt" }.forEach {
            val text = it.readText()
            assertFalse("${it.name} reads BuildConfig.DEBUG", "BuildConfig.DEBUG" in text)
            assertFalse("${it.name} reads NATIVE_CANDIDATE", "NATIVE_CANDIDATE" in text)
        }
        val pkwApp = File(main, "ui/nav/PkwApp.kt").readLines().single { "rememberWorldEngine(" in it }
        assertFalse("the World tab's engine choice is the same in every build: $pkwApp", "DEBUG" in pkwApp || "CANDIDATE" in pkwApp)
        File(main, "MainActivity.kt").readLines().filter { "WorldEngineFlags." in it }.forEach {
            assertTrue("only the debug launch extras touch the world flags: $it", it.trimStart().startsWith("if (BuildConfig.DEBUG)"))
        }
    }

    @Test fun `the smoke and probe activities stay debug-only`() {
        // They drive the GL30 engine with test inputs and are exported; a release APK must never carry them.
        val release = File("src/main/AndroidManifest.xml").readText()
        val debug = File("src/debug/AndroidManifest.xml").readText()
        for (activity in listOf(".scene.world.WorldEngineSmokeActivity", ".scene.probe.DeviceProbeActivity")) {
            assertFalse(activity, activity in release); assertTrue(activity, activity in debug)
        }
        assertTrue(File("src/debug/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineSmokeActivity.kt").isFile)
        assertFalse(File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineSmokeActivity.kt").exists())
    }
}
