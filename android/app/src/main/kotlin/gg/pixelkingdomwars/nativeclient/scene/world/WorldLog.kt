package gg.pixelkingdomwars.nativeclient.scene.world

import android.util.Log
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.scene.WorldContextFactory
import java.lang.reflect.Method

/**
 * The one gate for the world engine's diagnostics (code 29, the release integrator's request): the `PKWWorldGL` lines
 * (the engine decision, `globe ready in … ms`, the realm band lines, `[world-perf]`, `FALLBACK`) and the host's
 * once-per-second readout. On in debug builds and in QA candidates (optimizedDebug with the candidate origin:
 * `DEBUG` is false there, `NATIVE_CANDIDATE` true), where the owner's Seeker session and the integrator's device check
 * read them. Off in release: N5 runs this engine in release builds, which must print none of it.
 *
 * Every optimized build (release and the candidate) is shrunk by R8 with the wallet module's consumer rule
 * `-assumenosideeffects class android.util.Log` (Privy's OAuth redirect activity logs its callback URI), which deletes
 * every direct `Log` call in the APK. An enabled line is therefore written through a reflective handle to
 * `Log.println`, which that rule cannot match (R8 8.6.2 probe, 2026-09-25: a direct `Log.i` compiles to a bare
 * `return`, the reflective call survives). The lines carry no account data; release never reaches the handle, because
 * [enabled] is false there.
 */
object WorldLog {
    /** Debug builds and QA candidates print; release prints nothing. */
    fun enabledFor(debug: Boolean, candidate: Boolean): Boolean = debug || candidate

    /** `Log.println(int, String, String)`, resolved once; null only if the platform lacks it (then nothing is logged). */
    internal val printlnHandle: Method? = runCatching {
        Log::class.java.getMethod("println", Int::class.javaPrimitiveType, String::class.java, String::class.java)
    }.getOrNull()

    private val NONE: (String) -> Unit = {}

    internal fun gate(on: Boolean, sink: (String) -> Unit): (String) -> Unit = if (on) sink else NONE

    val enabled: Boolean = enabledFor(BuildConfig.DEBUG, BuildConfig.NATIVE_CANDIDATE)

    /** The on-screen fps readout is the developer build's alone. Candidates keep every logcat line above but draw
     *  nothing over the globe: the owner's Seeker runs the candidate on stage (2026-10-06, the readout "GL30 globe 27 fps
     *  · L0 · draws 0 · violations 0" sat under the world), and the integrator's device check reads logcat, not the glass. */
    fun readoutFor(debug: Boolean): Boolean = debug

    val readout: Boolean = readoutFor(BuildConfig.DEBUG)

    /** The world's logger (the host's `log`, the surface's and the admission's): logcat under `PKWWorldGL`, or nothing.
     *  Declared after the handle and [NONE]: an object's properties initialise in order. */
    val line: (String) -> Unit = gate(enabled) { write(it) }

    private fun write(line: String) { runCatching { printlnHandle?.invoke(null, Log.INFO, WorldContextFactory.TAG, line) } }
}
