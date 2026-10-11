package gg.pixelkingdomwars.nativeclient.diagnostics

import android.util.Log
import java.lang.reflect.Method

/**
 * Field report 2026-10-06 (Seeker, build 880a7e7a, -PnativeOptimizedDebug=true, candidate origin): no PKWLoad, PKWFrames or
 * PKWChainPins line reached logcat. Candidate builds are R8-optimized debug builds, and the wallet module's consumer rule
 * `-assumenosideeffects class android.util.Log` (Privy's OAuth activity logs its callback URI) deletes every direct Log call
 * from the whole app there. These lines are the measurement source on exactly those builds, so they write through
 * `Log.println`, resolved by reflection, which the rule cannot see — the pattern [gg.pixelkingdomwars.nativeclient.scene.world.WorldLog]
 * already uses for PKWWorldGL. Callers gate it (debug or candidate builds only); release keeps printing nothing.
 */
internal object DeviceLog {
    /** `Log.println(int, String, String)`, resolved once; null only if the platform lacks it (then nothing is logged). */
    internal val printlnHandle: Method? = runCatching {
        Log::class.java.getMethod("println", Int::class.javaPrimitiveType, String::class.java, String::class.java)
    }.getOrNull()

    fun info(tag: String, line: String) { runCatching { printlnHandle?.invoke(null, Log.INFO, tag, line) } }
}
