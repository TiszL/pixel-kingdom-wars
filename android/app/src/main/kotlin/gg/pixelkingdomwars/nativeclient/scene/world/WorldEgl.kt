package gg.pixelkingdomwars.nativeclient.scene.world

/**
 * EGL context specs for the world surface and its shared worker (GLOBE-NATIVE-PLAN §5.3, §5.7). Pure: the attribute
 * lists and fallback order are decided here and tested on the JVM; `WorldGraphics` and `SharedContextCompiler` only
 * hand them to EGL.
 *
 * - **World context, robust first.** libGDX's `GLSurfaceView20$ContextFactory` asks only for the client version, so
 *   a Mali GPU reset is never reported. When `EGL_EXT_create_context_robustness` is listed the world context asks for
 *   robust access with `EGL_LOSE_CONTEXT_ON_RESET_EXT`, so `glGetGraphicsResetStatus` reports a reset and the engine
 *   restores (plan §5.7). The ladder then falls back to a plain context of the same version and last to ES 2, which
 *   leaves `Gdx.gl30` null and the engine guard picks the legacy globe.
 * - **Worker context, matched to the world context.** EGL refuses (`EGL_BAD_MATCH`) a context whose reset
 *   notification strategy differs from its share context's, so the worker copies the world context's version and
 *   robustness exactly, and adds `EGL_CONTEXT_PRIORITY_LEVEL_IMG = LOW` when `EGL_IMG_context_priority` is listed, so
 *   background compiles and uploads yield the GPU to the world frame.
 */
object WorldEgl {
    const val EGL_NONE = 0x3038
    const val EGL_TRUE = 1
    const val EGL_CONTEXT_CLIENT_VERSION = 0x3098
    const val EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT = 0x30BF
    const val EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT = 0x3138
    const val EGL_LOSE_CONTEXT_ON_RESET_EXT = 0x31BF
    const val EGL_CONTEXT_PRIORITY_LEVEL_IMG = 0x3100
    const val EGL_CONTEXT_PRIORITY_LOW_IMG = 0x3103

    const val EXT_ROBUSTNESS = "EGL_EXT_create_context_robustness"
    const val EXT_PRIORITY = "EGL_IMG_context_priority"
    const val EXT_SURFACELESS = "EGL_KHR_surfaceless_context"
    const val EXT_PRESENTATION_TIME = "EGL_ANDROID_presentation_time"
    const val EXT_FRAME_TIMESTAMPS = "EGL_ANDROID_get_frame_timestamps"

    /** One context request. [attributes] is the `EGL_NONE`-terminated list handed to `eglCreateContext`. */
    data class ContextSpec(val version: Int, val robust: Boolean, val lowPriority: Boolean = false) {
        fun attributes(): IntArray {
            val out = ArrayList<Int>(9)
            out += EGL_CONTEXT_CLIENT_VERSION; out += version
            if (robust) {
                out += EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT; out += EGL_TRUE
                out += EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT; out += EGL_LOSE_CONTEXT_ON_RESET_EXT
            }
            if (lowPriority) { out += EGL_CONTEXT_PRIORITY_LEVEL_IMG; out += EGL_CONTEXT_PRIORITY_LOW_IMG }
            out += EGL_NONE
            return out.toIntArray()
        }

        override fun toString() = "ES$version${if (robust) " robust" else ""}${if (lowPriority) " low-priority" else ""}"
    }

    /** Whole-token match in an EGL/GL extension string (`EGL_KHR_x` must not match `EGL_KHR_x_y`). */
    fun listed(extensions: String?, name: String): Boolean {
        if (extensions.isNullOrEmpty()) return false
        var from = 0
        while (true) {
            val at = extensions.indexOf(name, from)
            if (at < 0) return false
            val end = at + name.length
            val startOk = at == 0 || extensions[at - 1].isWhitespace()
            val endOk = end == extensions.length || extensions[end].isWhitespace()
            if (startOk && endOk) return true
            from = at + 1
        }
    }

    /** The world context's fallback ladder, most capable first. */
    fun worldLadder(version: Int, eglExtensions: String?): List<ContextSpec> {
        val robust = listed(eglExtensions, EXT_ROBUSTNESS)
        val ladder = ArrayList<ContextSpec>(3)
        if (robust) ladder += ContextSpec(version, robust = true)
        ladder += ContextSpec(version, robust = false)
        if (version > 2) ladder += ContextSpec(2, robust = false)
        return ladder
    }

    /** The worker's ladder for a world context created as [world]: low priority when listed, then without it. Version
     *  and robustness never differ from the world context's (a mismatch is `EGL_BAD_MATCH`, not a weaker context). */
    fun workerLadder(world: ContextSpec, eglExtensions: String?): List<ContextSpec> {
        val plain = ContextSpec(world.version, world.robust, lowPriority = false)
        return if (listed(eglExtensions, EXT_PRIORITY)) listOf(plain.copy(lowPriority = true), plain) else listOf(plain)
    }
}
