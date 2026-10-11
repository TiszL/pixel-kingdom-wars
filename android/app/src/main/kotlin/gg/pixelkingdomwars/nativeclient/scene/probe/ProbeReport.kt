package gg.pixelkingdomwars.nativeclient.scene.probe

import gg.pixelkingdomwars.nativeclient.scene.world.WorldEgl
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The N0 device probe's report (GLOBE-NATIVE-PLAN §8.3). The owner runs the probe once on the Seeker; everything the
 * plan leaves "unverified until the N0 probe" must be in this one JSON, or the question stays open for another
 * session. [missing] names what a finished report lacks, and the probe prints it on screen.
 *
 * No player, account, wallet or session data: GPU, display, thermal and timing facts only.
 */
class ProbeReport {
    private val sections = LinkedHashMap<String, JsonElement>()

    fun put(section: String, value: JsonElement) { sections[section] = value }
    fun put(section: String, value: String?) { sections[section] = value?.let(::JsonPrimitive) ?: JsonNull }
    fun put(section: String, value: Number?) { sections[section] = value?.let(::JsonPrimitive) ?: JsonNull }
    fun put(section: String, value: Boolean?) { sections[section] = value?.let(::JsonPrimitive) ?: JsonNull }
    operator fun contains(section: String) = section in sections

    fun json(): JsonObject = JsonObject(LinkedHashMap(sections).apply { put("schemaVersion", JsonPrimitive(SCHEMA)) })

    /** Required sections not yet present. */
    fun missing(): List<String> = REQUIRED.filter { it !in sections }

    companion object {
        /** 2: the worker pre-warm, scratch-vs-screen, per-program, touch-pacing, unanswerable and owner-step sections. */
        const val SCHEMA = 2
        const val TAG = "PKWProbe"
        const val PREFIX = "[world-probe]"

        /** Every N0 question the plan sends to the probe (§1.2, §5.3–§5.7, §8.3). Under D-171 there is one Seeker
         *  session, so what is not here stays unanswered: those questions are listed in [UNANSWERABLE] instead. */
        val REQUIRED = listOf(
            "build", "engineGuard", "gl", "egl", "extensions", "programBinaryFormats", "limits",
            "display", "surface", "thermal", "workerPipeline", "programBinaryTiming", "workerPrewarm", "scratchPrewarm",
            "programStages", "uploadTiming", "bench", "pacing", "idle", "touchPacing", "unanswerable", "ownerSteps",
        )

        /** Plan §8.3 questions the probe cannot answer in the D-171 session, each with the reason (read by the lead). */
        val UNANSWERABLE = linkedMapOf(
            "perPassGpuMs" to "unanswerable in the D-171 session: a production pass's GPU time depends on the engine's own " +
                "inputs (instance buffers, uniform contents, textures, coverage), which exist only inside the N1-N3 engines. " +
                "The probe times every exported program's link, glProgramBinary and first draw (programStages) and the " +
                "synthetic bench's ns per fetch (bench), which feed the cost model; the finished APK's [world-perf] lines carry " +
                "GL-thread CPU and the fence GPU-bound flag per frame.",
            "vsSeatParity" to "unanswerable in the D-171 session: the transform-feedback capture of the production tree VS needs " +
                "N3's life and scatter instance data and the JS reference seats (plan §7), which the probe does not have; it runs " +
                "on the guarded emulator at N3 and on a later Seeker session.",
            "presentToPresent" to "not measurable from inside the app: SurfaceFlinger TimeStats present-to-present comes from " +
                "tools/measure-live-seeker.mjs over USB; the probe reports app-side frame starts (pacing, touchPacing).",
        )

        /** What the owner runs over USB while or after the probe runs (the probe cannot read these itself). */
        val OWNER_STEPS = listOf(
            "While the probe runs: adb shell dumpsys SurfaceFlinger > sf.txt (is the world layer DEVICE or CLIENT, plan §5.5).",
            "When the screen says DRAG: drag one finger around the screen for 5 seconds (pacing under touch, touchPacing).",
            "Afterwards: adb shell wm size; adb shell wm density; adb shell dumpsys display > display.txt; " +
                "adb shell dumpsys meminfo gg.pixelkingdomwars.twa.debug > meminfo.txt.",
        )

        fun unanswerable(): JsonObject = JsonObject(UNANSWERABLE.mapValues { JsonPrimitive(it.value) })
        fun ownerSteps(): JsonArray = JsonArray(OWNER_STEPS.map(::JsonPrimitive))

        /** The extensions whose presence the plan's decisions hang on (`extensions` section). */
        val EXTENSION_FLAGS = listOf(
            "GL_EXT_disjoint_timer_query",
            WorldEgl.EXT_PRESENTATION_TIME,
            WorldEgl.EXT_FRAME_TIMESTAMPS,
            WorldEgl.EXT_PRIORITY,
            WorldEgl.EXT_ROBUSTNESS,
            WorldEgl.EXT_SURFACELESS,
            "GL_EXT_robustness",
            "GL_KHR_robustness",
            "GL_OES_get_program_binary",
            "GL_EXT_texture_border_clamp",
            "GL_EXT_color_buffer_half_float",
            "GL_EXT_color_buffer_float",
            "GL_EXT_copy_image",
            "GL_OES_copy_image",
        )

        /** One flag per [EXTENSION_FLAGS] entry, looked up in the GL and EGL extension strings. */
        fun extensionFlags(glExtensions: String?, eglExtensions: String?): JsonObject =
            JsonObject(EXTENSION_FLAGS.associateWith { JsonPrimitive(WorldEgl.listed(glExtensions, it) || WorldEgl.listed(eglExtensions, it)) })

        /** logcat drops lines past ~4 KB: the JSON goes out in numbered chunks the reader re-joins. */
        fun chunks(json: String, size: Int = 3000): List<String> {
            require(size > 0)
            val total = (json.length + size - 1) / size
            return (0 until total).map { i -> "$PREFIX ${i + 1}/$total ${json.substring(i * size, minOf(json.length, (i + 1) * size))}" }
        }
    }
}
