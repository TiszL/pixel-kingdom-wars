package gg.pixelkingdomwars.nativeclient.diagnostics

import java.io.File
import java.lang.reflect.Modifier
import org.junit.Assert.*
import org.junit.Test

/**
 * Field report 2026-10-06 (Seeker, 880a7e7a, -PnativeOptimizedDebug=true, candidate origin): not one PKWLoad, PKWFrames or
 * PKWChainPins line in logcat, so nothing in the measurement plan could be measured. Candidate builds are R8-optimized, and
 * the wallet module's consumer rule `-assumenosideeffects class android.util.Log` deletes every direct Log call app-wide.
 * The stage lines now write through Log.println resolved by reflection (the PKWWorldGL pattern), which the rule cannot see.
 */
class DeviceLogTest {
    @Test fun `the reason still holds - the wallet strips direct Log calls from optimized builds`() {
        val rules = listOf(File("../wallet/consumer-rules.pro"), File("wallet/consumer-rules.pro")).first { it.isFile }.readText()
        assertTrue("if this rule goes, DeviceLog is merely redundant, never wrong", rules.contains("-assumenosideeffects class android.util.Log"))
    }

    @Test fun `a stage line reaches logcat through a call the Log rule cannot delete`() {
        // A wrong name or signature here would log nothing on the device, silently: the handle must be Log.println.
        val handle = requireNotNull(DeviceLog.printlnHandle) { "Log.println(int, String, String) resolves" }
        assertEquals("android.util.Log", handle.declaringClass.name)
        assertEquals("println", handle.name)
        assertEquals(listOf(Int::class.javaPrimitiveType, String::class.java, String::class.java), handle.parameterTypes.toList())
        assertTrue(Modifier.isStatic(handle.modifiers))
    }

    @Test fun `PKWLoad, PKWFrames and PKWChainPins go through DeviceLog, gated to debug and candidate builds`() {
        val main = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
        val activity = File(main, "MainActivity.kt").readText()
        val sink = activity.substring(activity.indexOf("SceneLoadLog.sink = "), activity.indexOf("else null", activity.indexOf("SceneLoadLog.sink = ")))
        assertTrue("gated as before", sink.startsWith("SceneLoadLog.sink = if (BuildConfig.DEBUG || BuildConfig.NATIVE_CANDIDATE)"))
        assertTrue(sink.contains("DeviceLog.info("))
        assertFalse("no direct Log call in the sink", Regex("""\bLog\.(v|d|i|w|e|wtf|println)\(""").containsMatchIn(sink))
        val pins = File(main, "data/ChainPins.kt").readText()
        assertTrue(pins.contains("DeviceLog.info(\"PKWChainPins\""))
        assertFalse(Regex("""\bLog\.i\("PKWChainPins"""").containsMatchIn(pins))
        val log = File(main, "diagnostics/DeviceLog.kt").readText()
        assertTrue("written at INFO", log.contains("printlnHandle?.invoke(null, Log.INFO, tag, line)"))
    }
}
