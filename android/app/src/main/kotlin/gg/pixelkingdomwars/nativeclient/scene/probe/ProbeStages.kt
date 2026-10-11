package gg.pixelkingdomwars.nativeclient.scene.probe

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** One exported production program: its two stage files under [ProbeStages.ROOT]. */
data class ProbeStage(val name: String, val group: String, val vsPath: String, val fsPath: String)

/**
 * The production programs the probe times one by one on the Seeker (GLOBE-NATIVE-PLAN §5.3 step 4, §8.3: "`glProgramBinary`
 * ms and first-draw ms per program"). They come from the exported stages the renderer packages from the classpath
 * (`tools/world-shaders.mjs` → `world/shaders/index.json`, schema 2: realm `programs` and `globe` programs), so the
 * probe measures exactly the stages the engines will hand the driver.
 *
 * For a first draw every uniform block is backed by a zeroed buffer and every sampler gets a 1×1 texture of ITS kind
 * on its own unit ([dummyFor]): a sampler left on a unit of another kind is `GL_INVALID_OPERATION` at the draw, which
 * would time nothing. A sampler type the probe has no dummy for skips the draw and says so. Each draw is one
 * 1×1-scissored triangle: the inputs are zero, so its GPU time means nothing; its first-draw CPU cost does.
 */
object ProbeStages {
    const val ROOT = "world/shaders/"
    const val INDEX = ROOT + "index.json"
    /** The zeroed uniform buffer backing every block: `GL_MAX_UNIFORM_BLOCK_SIZE` is at least this on every ES 3 device. */
    const val ZERO_UBO_BYTES = 16384

    data class Parsed(val schema: Int?, val pin: String?, val stages: List<ProbeStage>, val errors: List<String>)

    /** Every entry without a name and both stage paths is an error, never skipped silently. */
    fun parse(json: String): Parsed {
        val root = runCatching { Json.parseToJsonElement(json) as? JsonObject }.getOrNull()
            ?: return Parsed(null, null, emptyList(), listOf("index.json is not a JSON object"))
        val stages = ArrayList<ProbeStage>()
        val errors = ArrayList<String>()
        for (group in listOf("programs", "globe")) {
            val list = root[group] ?: continue
            if (list !is JsonArray) { errors += "$group is not a list"; continue }
            for ((i, entry) in list.withIndex()) {
                val o = entry as? JsonObject
                val name = o?.string("name")
                val vs = (o?.get("vs") as? JsonObject)?.string("path")
                val fs = (o?.get("fs") as? JsonObject)?.string("path")
                if (name == null || vs == null || fs == null) errors += "$group[$i] lacks a name or a stage path"
                else stages += ProbeStage(name, group, vs, fs)
            }
        }
        if (stages.isEmpty() && errors.isEmpty()) errors += "index.json lists no programs"
        val schema = (root["schema"] as? JsonPrimitive)?.intOrNull
        val pin = ((root["source"] as? JsonObject)?.get("commit") as? JsonPrimitive)?.takeIf { it.isString }?.content
        return Parsed(schema, pin, stages, errors)
    }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** A 1×1 texture the probe binds for one sampler kind (target, internal format, upload format and type). */
    enum class Dummy(val target: Int, val internal: Int, val format: Int, val type: Int, val bytesPerTexel: Int) {
        FLOAT_2D(GL20.GL_TEXTURE_2D, GL30.GL_RGBA8, GL20.GL_RGBA, GL20.GL_UNSIGNED_BYTE, 4),
        FLOAT_2D_ARRAY(GL30.GL_TEXTURE_2D_ARRAY, GL30.GL_RGBA8, GL20.GL_RGBA, GL20.GL_UNSIGNED_BYTE, 4),
        FLOAT_CUBE(GL20.GL_TEXTURE_CUBE_MAP, GL30.GL_RGBA8, GL20.GL_RGBA, GL20.GL_UNSIGNED_BYTE, 4),
        UINT_2D(GL20.GL_TEXTURE_2D, GL30.GL_RGBA16UI, GL30.GL_RGBA_INTEGER, GL20.GL_UNSIGNED_SHORT, 8),
        UINT_2D_ARRAY(GL30.GL_TEXTURE_2D_ARRAY, GL30.GL_RGBA16UI, GL30.GL_RGBA_INTEGER, GL20.GL_UNSIGNED_SHORT, 8),
        INT_2D(GL20.GL_TEXTURE_2D, GL30.GL_RGBA16I, GL30.GL_RGBA_INTEGER, GL20.GL_SHORT, 8),
        INT_2D_ARRAY(GL30.GL_TEXTURE_2D_ARRAY, GL30.GL_RGBA16I, GL30.GL_RGBA_INTEGER, GL20.GL_SHORT, 8),
    }

    /** The dummy for a sampler uniform's GL type (`glGetActiveUniform`), or null when the probe has none. */
    fun dummyFor(type: Int): Dummy? = when (type) {
        GL20.GL_SAMPLER_2D -> Dummy.FLOAT_2D
        GL30.GL_SAMPLER_2D_ARRAY -> Dummy.FLOAT_2D_ARRAY
        GL20.GL_SAMPLER_CUBE -> Dummy.FLOAT_CUBE
        GL30.GL_UNSIGNED_INT_SAMPLER_2D -> Dummy.UINT_2D
        GL30.GL_UNSIGNED_INT_SAMPLER_2D_ARRAY -> Dummy.UINT_2D_ARRAY
        GL30.GL_INT_SAMPLER_2D -> Dummy.INT_2D
        GL30.GL_INT_SAMPLER_2D_ARRAY -> Dummy.INT_2D_ARRAY
        else -> null
    }

    /** Whether a uniform's GL type is any sampler (a sampler without a dummy must skip the draw, not bind nothing). */
    fun isSampler(type: Int): Boolean = dummyFor(type) != null || type in OTHER_SAMPLERS

    private val OTHER_SAMPLERS = setOf(GL30.GL_SAMPLER_3D, GL30.GL_SAMPLER_2D_SHADOW, GL30.GL_SAMPLER_2D_ARRAY_SHADOW,
        GL30.GL_SAMPLER_CUBE_SHADOW, GL30.GL_INT_SAMPLER_3D, GL30.GL_INT_SAMPLER_CUBE, GL30.GL_UNSIGNED_INT_SAMPLER_3D,
        GL30.GL_UNSIGNED_INT_SAMPLER_CUBE)

    /** One element of a sampler array uniform: `glGetActiveUniform` reports `name[0]` with its size. */
    fun elementName(reported: String, size: Int, index: Int): String =
        if (size <= 1) reported else reported.removeSuffix("[0]") + "[$index]"

    /** The probe's summary line for a finished run. */
    fun summary(results: List<Map<String, JsonElement>>): Map<String, JsonElement> {
        fun max(key: String) = results.mapNotNull { (it[key] as? JsonPrimitive)?.content?.toDoubleOrNull() }.maxOrNull()
        fun sum(key: String) = results.mapNotNull { (it[key] as? JsonPrimitive)?.content?.toDoubleOrNull() }.sum()
        return linkedMapOf(
            "programs" to JsonPrimitive(results.size),
            "failed" to JsonPrimitive(results.count { "error" in it }),
            "drawSkipped" to JsonPrimitive(results.count { "drawSkipped" in it }),
            "compileLinkMsMax" to JsonPrimitive(max("compileLinkMs")),
            "compileLinkMsSum" to JsonPrimitive(sum("compileLinkMs")),
            "programBinaryMsMax" to JsonPrimitive(max("programBinaryMs")),
            "programBinaryMsSum" to JsonPrimitive(sum("programBinaryMs")),
            "firstDrawMsMax" to JsonPrimitive(max("firstDrawMs")),
        )
    }
}
