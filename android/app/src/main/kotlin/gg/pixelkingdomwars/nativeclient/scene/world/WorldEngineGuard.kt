package gg.pixelkingdomwars.nativeclient.scene.world

/** Which engine the world surface runs (GLOBE-NATIVE-PLAN §3.3, §8.1). */
enum class WorldEngineChoice { GL30, LEGACY }

/** How a context reads a GPU reset (GLOBE-NATIVE-PLAN §5.7). */
enum class ResetQuery {
    /** `GLES32.glGetGraphicsResetStatus`, core in ES 3.2. */
    ES32,
    /** Not queried. `GL_EXT_robustness` and `GL_KHR_robustness` have no `android.opengl` binding, so below ES 3.2 a
     *  loss is found by `Gl3Core`'s per-frame context-handle and sentinel checks (GLSurfaceView recreates the context
     *  when a swap reports `EGL_CONTEXT_LOST`). */
    NONE,
}

/** Which `glCopyImageSubData` a context has for the staging copy (plan §5.7). */
enum class CopyImage {
    /** `GLES32.glCopyImageSubData`, core in ES 3.2. */
    ES32,
    /** `GLES31Ext.glCopyImageSubDataEXT` (`GL_EXT_copy_image`, part of the Android extension pack). */
    EXT,
    /** None usable: `GL_OES_copy_image` has no `android.opengl` binding. The staging ring is off, and a live array is
     *  replaced by a fresh texture filled before its first sample. */
    NONE,
}

/** The entry points [AndroidGl3][gg.pixelkingdomwars.nativeclient.scene.AndroidGl3] calls for the two world calls that
 *  are not ES 3.0 core. On ES 3.1 drivers the `GLES32` entry points are logging stubs: calling them unchecked turns
 *  reset detection off and makes every staged copy a silent no-op (N0 review, 2026-09-25). */
data class Gles3Paths(val reset: ResetQuery, val copy: CopyImage) {
    val stagingCopy: Boolean get() = copy != CopyImage.NONE
    override fun toString() = "reset ${reset.name.lowercase()}, copy ${copy.name.lowercase()}"

    companion object {
        /** ES 3.0 core only: nothing beyond it is called. The default for contexts that never reset-check or copy
         *  (the shared worker's). */
        val ES30 = Gles3Paths(ResetQuery.NONE, CopyImage.NONE)
    }
}

/** A decision and the reason, which is always logged (`[world-engine]`). [paths] matter only for [WorldEngineChoice.GL30]. */
data class WorldEngineDecision(val choice: WorldEngineChoice, val reason: String, val paths: Gles3Paths = Gles3Paths.ES30) {
    val gl30: Boolean get() = choice == WorldEngineChoice.GL30
}

/**
 * Where the GL30 world engines may run (GLOBE-NATIVE-PLAN §3.3 and §8.1, D-168.3, RM-GPU-1).
 *
 * On 2026-09-24 a WebGL realm-map page hung the owner's Mac through its real GPU. An Android emulator whose GLES is
 * translated to the host GPU would put the same shaders on that GPU. So the guard lives in the engine, not only in
 * this lane's harness: every lane's androidTest that opens the World tab passes through it.
 *
 * Two gates:
 * 1. [admitContext], before the surface exists: only ask libGDX for an ES3 context when the device reports GLES 3.0
 *    (`reqGlEsVersion`) and the caller has admitted the GL30 path (a debug flag in N0; the v2 content group from N1).
 *    Otherwise the unchanged legacy globe runs on its ES2 context.
 * 2. [decide], in `create()` on the GL thread, once the context exists:
 *    - libGDX silently falls back to ES2 when ES3 creation fails, which leaves `Gdx.gl30` null inside a GL30 fragment:
 *      legacy.
 *    - On an emulator (`Build.HARDWARE` ranchu or goldfish) the GL30 engines run ONLY when `GL_RENDERER` names
 *      SwiftShader (the CPU renderer). Any other renderer string may be the host GPU: legacy, which is what these
 *      emulators ran before this port.
 *    - A GL30 decision carries [paths] from `GL_VERSION` and `GL_EXTENSIONS`: ES 3.2 core first, then
 *      `GL_EXT_copy_image`, then none (no staging ring). The reason names them, so the log says which ran.
 */
object WorldEngineGuard {
    /** `ActivityManager.getDeviceConfigurationInfo().reqGlEsVersion` for GLES 3.0. */
    const val GLES_3_0 = 0x30000

    fun isEmulator(hardware: String?): Boolean {
        val h = hardware?.lowercase() ?: return false
        return "ranchu" in h || "goldfish" in h
    }

    fun namesSwiftShader(glRenderer: String?): Boolean = glRenderer?.contains("SwiftShader", ignoreCase = true) == true

    fun admitContext(requested: Boolean, reqGlEsVersion: Int): WorldEngineDecision = when {
        !requested -> WorldEngineDecision(WorldEngineChoice.LEGACY, "GL30 world path not admitted (legacy globe)")
        reqGlEsVersion < GLES_3_0 ->
            WorldEngineDecision(WorldEngineChoice.LEGACY, "device reports GLES ${reqGlEsVersion ushr 16}.${reqGlEsVersion and 0xffff}; GL30 needs 3.0")
        else -> WorldEngineDecision(WorldEngineChoice.GL30, "GL30 context requested")
    }

    /** `GL_EXT_copy_image`, the one copy extension with an `android.opengl` binding (`GLES31Ext`). */
    const val EXT_COPY_IMAGE = "GL_EXT_copy_image"
    const val ES_3_2 = 0x30002

    /** `GL_VERSION` → `major shl 16 or minor` ("OpenGL ES 3.2 v1.r38p1" → 0x30002); 0 when it does not start with the
     *  ES prefix the spec requires, so an unreadable string never admits an ES 3.2 entry point. */
    fun glesVersion(glVersion: String?): Int {
        val match = VERSION.find(glVersion ?: return 0) ?: return 0
        val major = match.groupValues[1].toIntOrNull() ?: return 0
        val minor = match.groupValues[2].toIntOrNull() ?: return 0
        return (major shl 16) or minor
    }

    fun paths(glVersion: String?, glExtensions: String?): Gles3Paths {
        val es32 = glesVersion(glVersion) >= ES_3_2
        return Gles3Paths(
            reset = if (es32) ResetQuery.ES32 else ResetQuery.NONE,
            copy = when {
                es32 -> CopyImage.ES32
                WorldEgl.listed(glExtensions, EXT_COPY_IMAGE) -> CopyImage.EXT
                else -> CopyImage.NONE
            },
        )
    }

    fun decide(hardware: String?, glRenderer: String?, gl30Present: Boolean, glVersion: String?, glExtensions: String?): WorldEngineDecision {
        if (!gl30Present) return WorldEngineDecision(WorldEngineChoice.LEGACY, "no ES3 context (libGDX fell back to ES2): legacy globe")
        if (isEmulator(hardware) && !namesSwiftShader(glRenderer)) return WorldEngineDecision(WorldEngineChoice.LEGACY,
            "emulator hardware '$hardware' with renderer '$glRenderer' is not SwiftShader: GL30 engines never run on a host GPU (RM-GPU-1)")
        val paths = paths(glVersion, glExtensions)
        val where = if (isEmulator(hardware)) "emulator on SwiftShader ('$glRenderer')" else "device renderer '$glRenderer'"
        val staging = if (paths.stagingCopy) "" else "; no staging ring (live layers need fresh textures)"
        return WorldEngineDecision(WorldEngineChoice.GL30, "$where, '$glVersion': $paths$staging", paths)
    }

    private val VERSION = Regex("""^OpenGL ES (\d+)\.(\d+)""")
}
