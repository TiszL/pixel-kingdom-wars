package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import java.util.Collections

/** Candidate renderer16 bound-cosmetics extension: the four Artisan Market
 * Awnings packed in the optional `pe_cosmetics` group. Metadata only — no files
 * are opened, no art permission, pixel readiness or crafting entitlement follows
 * from decoding it. The packed group physically carries the craft-success
 * overlay and the Aurora wake cells; they are described for atlas closure. The
 * wake binding is exposed SEPARATELY ([PhaseECosmeticArt.wakeBinding], C5a source
 * preview only): no wake appearance, selection or application readiness exists here. */
data class CosmeticBinding(val outputId: String, val sha256: String, val sourceManifestSha256: String,
    val sourceIndexSha256: String, val sourceId: String)
/** Admitted catalogue rules carried by the extension (never a native literal): the queue
 *  limit the shared Workshop API caps a base's cosmetic queue with, and its export name. */
data class CosmeticRules(val maxConcurrentPerBase: Int, val queueSource: String)

class PhaseECosmeticArt private constructor(
    /** `awning-t1` … `awning-t4`, facility `market`, sharing the Market's seat geometry. */
    val appearances: Map<String, ServiceAppearance>,
    /** Every clip of the packed group (Awning states, `pe_cos_ready_fx`, `pe_cos_wake`). */
    val clips: Map<String, ServiceClip>,
    val group: ServiceAtlasGroup,
    /** The four Awning bindings only; `aurora_wake` is never in this map. */
    val bindings: Map<String, CosmeticBinding>,
    /** The packed `aurora_wake` binding, kept apart from [bindings] so every Awning rule
     *  ([admitted], the four-Awning readiness check) is untouched. It admits the verified
     *  SOURCE PREVIEW of the wake still only: no appearance, selection, trip attachment
     *  or application readiness follows from it. */
    val wakeBinding: CosmeticBinding,
    val sourceManifestSha256: String, val sourceIndexSha256: String, val provenanceSha256: String,
    val sourceCommit: String?,
    /** Null on an extension exported without its constants slice: application stays closed. */
    val rules: CosmeticRules?,
) {
    /** The admitted Awning appearance for a Market of [tier] wearing [outputId] with exactly
     *  these binding hashes, or null: any hash or tier disagreement draws ordinary art. */
    fun admitted(outputId: String, bindingSha256: String, sourceManifestSha256: String, sourceIndexSha256: String, tier: Int?): ServiceAppearance? {
        val binding = bindings[outputId] ?: return null
        if (binding.sha256 != bindingSha256 || binding.sourceManifestSha256 != sourceManifestSha256 || binding.sourceIndexSha256 != sourceIndexSha256) return null
        val appearance = appearances[appearanceId(outputId)] ?: return null
        return if (appearance.tier == tier) appearance else null
    }

    companion object {
        const val GROUP = "pe_cosmetics"
        const val OVERLAY_CLIP = "pe_cos_ready_fx"
        const val WAKE_OUTPUT = "aurora_wake"
        const val WAKE_CLIP = "pe_cos_wake"
        val awningOutputs: List<String> = immutableList((1..4).map { "artisan_market_awning_t$it" })
        private val outputs = awningOutputs + WAKE_OUTPUT
        private val bodyStates = listOf("idle", "damaged", "destroyed", "working", "construction", "collapse", "ready")
        fun appearanceId(outputId: String): String { require(outputId in awningOutputs); return "awning-t${outputId.last()}" }

        /** Strict closed graph: exact clip inventory, one-based keys, alias/overlay references,
         *  per-cell digests, one packed group with paired pins and the five bindings. */
        fun parse(value: JsonValue): PhaseECosmeticArt {
            keys(value, setOf("version", "metadata", "groups", "awnings") + optionalKeys(value, setOf("sourceCommit", "basePack", "constants")))
            require(integer(value.get("version")) == 1)
            val rules = value.get("constants")?.let { constants ->
                keys(constants, setOf("PHASE_E_BOUND_COSMETICS", "queue"))
                val table = constants.get("PHASE_E_BOUND_COSMETICS"); require(table != null && table.isObject && integer(table.get("currentRecipeVersion")) == 1)
                val recipes = requireNotNull(table.get("v1")?.get("recipes")); require(recipes.isObject)
                for (tier in 1..4) { val recipe = requireNotNull(recipes.get("craft_artisan_market_awning_t${tier}_v1")); require(text(recipe.get("facility")) == "market") }
                val queue = constants.get("queue"); keys(queue, setOf("maxConcurrentPerBase", "source"))
                val limit = integer(queue.get("maxConcurrentPerBase")); require(limit >= 1)
                CosmeticRules(limit, text(queue.get("source")).also { require(it == "PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase") })
            }
            val sourceCommit = value.get("sourceCommit")?.let { text(it).also { sha -> require(sha.matches(Regex("[0-9a-f]{40}"))) } }
            val metadata = value.get("metadata"); keys(metadata, setOf("peCosmetics"))
            val table = metadata.get("peCosmetics")
            keys(table, setOf("schemaVersion", "atlas", "sourceScale", "sourceIndexBase", "keyIndexBase", "sourceManifestSha256", "indexSha256", "provenanceSha256", "clips", "bindings"))
            require(integer(table.get("schemaVersion")) == 1 && text(table.get("atlas")) == GROUP)
            require(number(table.get("sourceScale")) == 1f && integer(table.get("sourceIndexBase")) == 0 && integer(table.get("keyIndexBase")) == 1)
            val sourceManifest = hash(table.get("sourceManifestSha256")); val sourceIndex = hash(table.get("indexSha256")); val provenance = hash(table.get("provenanceSha256"))
            val rawClips = table.get("clips"); objectSize(rawClips, 30)
            val clips = linkedMapOf<String, ServiceClip>(); val frames = linkedSetOf<String>()
            fun claim(key: String) { require(frames.add(key)); require(key.startsWith("pe_cos_")) }
            fun clip(id: String, count: Int, fps: Float, loop: Boolean, cell: Float, alias: String? = null, overlay: Boolean = false) {
                val raw = requireNotNull(rawClips.get(id))
                val base = setOf("sourcePath", "sourceSha256", "cellW", "cellH", "anchorPx", "anchorKind", "fps", "loop", "reducedMotionFrame", "frames")
                val body = cell == 112f
                keys(raw, base + (if (body) setOf("sourcePivot", "footprint") else emptySet()) + (if (alias != null) setOf("alias") else emptySet())
                    + (if (overlay) setOf("overlay") else emptySet()) + optionalKeys(raw, setOf("sourceFrameIndices")))
                require(text(raw.get("sourcePath")).isNotEmpty()); hash(raw.get("sourceSha256"))
                require(number(raw.get("cellW")) == cell && number(raw.get("cellH")) == cell)
                val anchor = point(raw.get("anchorPx")); require(anchor == if (body) ServicePoint(56f, 112f) else ServicePoint(32f, 32f))
                require(text(raw.get("anchorKind")) == if (body) "cellBottomPivotX" else "centre")
                if (body) { require(point(raw.get("sourcePivot")) == ServicePoint(56f, 104f) && point(raw.get("footprint")) == ServicePoint(2f, 2f)) }
                require(number(raw.get("fps")) == fps && boolean(raw.get("loop")) == loop)
                val reduced = integer(raw.get("reducedMotionFrame")); require(reduced in 0 until count)
                val keyBase = alias ?: id
                val source = array(raw.get("frames"), count).mapIndexed { index, row ->
                    keys(row, setOf("sourceIndex", "key", "rgbaSha256"))
                    require(integer(row.get("sourceIndex")) == index)
                    val key = text(row.get("key")); require(key == "${keyBase}_f${index + 1}")
                    if (alias == null) claim(key)
                    ServiceSourceFrame(index, key, hash(row.get("rgbaSha256")))
                }
                if (alias != null) {
                    require(text(raw.get("alias")) == alias)
                    val target = requireNotNull(clips[alias]); require(target.frames.map { it.key } == source.map { it.key })
                }
                if (overlay) { val o = raw.get("overlay"); keys(o, setOf("clip", "offset")); require(text(o.get("clip")) == OVERLAY_CLIP && point(o.get("offset")) == ServicePoint(24f, 0f)) }
                if (alias == null) clips[id] = ServiceClip(id, immutableList(source), immutableList((0 until count).toList()), fps, loop,
                    ServicePoint(cell, cell), anchor, if (body) "cellBottomPivotX" else "centre", if (body) ServicePoint(2f, 2f) else null,
                    ServiceReducedMotion.Frame(reduced), null)
            }
            // The overlay clip is referenced by every ready state, so it is admitted first.
            clip(OVERLAY_CLIP, 8, 8f, false, 64f)
            val appearances = linkedMapOf<String, ServiceAppearance>()
            val geometry = ServiceGeometry(ServicePoint(112f, 112f), ServicePoint(2f, 2f), 1f, .5f, 56f, 112f, null, ServicePoint(56f, 104f), 104f, null, null, null)
            for (tier in 1..4) {
                val prefix = "pe_cos_market_t$tier"
                for (still in listOf("idle", "damaged", "destroyed")) clip("${prefix}_$still", 1, 0f, false, 112f)
                clip("${prefix}_working", 8, 8f, true, 112f)
                clip("${prefix}_construction", 9, 8f, false, 112f)
                clip("${prefix}_collapse", 9, 8f, false, 112f)
                clip("${prefix}_ready", 1, 0f, false, 112f, alias = "${prefix}_idle", overlay = true)
                val id = "awning-t$tier"
                val states = linkedMapOf<String, ServiceArtState>()
                for (still in listOf("idle", "damaged", "destroyed")) states[still] = ServiceArtState.Still("${prefix}_${still}_f1")
                for (name in listOf("working", "construction", "collapse")) states[name] = ServiceArtState.Clip("${prefix}_$name")
                states["ready"] = ServiceArtState.Composition(immutableList(listOf(ServiceStateRef(id, "idle"))), ServicePoint(24f, 0f), OVERLAY_CLIP)
                appearances[id] = ServiceAppearance(id, "market", "artisan_market_awning", tier, geometry, immutableMap(states))
            }
            clip("pe_cos_wake", 8, 8f, true, 64f)
            keys(rawClips, clips.keys + (1..4).map { "pe_cos_market_t${it}_ready" }); require(frames.size == 132)
            // One packed group, paired pins, native scale.
            val groups = array(value.get("groups"), 1)
            val rawGroup = groups.single(); keys(rawGroup, setOf("id", "atlasPath", "imagePath", "decodedBytes", "files"))
            require(text(rawGroup.get("id")) == GROUP)
            val atlasPath = text(rawGroup.get("atlasPath")); val imagePath = text(rawGroup.get("imagePath"))
            require(atlasPath == "atlas/$GROUP@1x.json" && imagePath == "atlas/$GROUP@1x.png")
            val decoded = positiveLong(rawGroup.get("decodedBytes")); require(decoded <= 4096L * 4096 * 4 && decoded % 4 == 0L)
            val pins = array(rawGroup.get("files"), 2).map { pin -> keys(pin, setOf("path", "sha256", "size")); ServiceFilePin(text(pin.get("path")), hash(pin.get("sha256")), positiveLong(pin.get("size"))) }
            require(pins.map { it.path } == listOf(atlasPath, imagePath))
            val group = ServiceAtlasGroup(GROUP, atlasPath, imagePath, decoded, immutableList(pins))
            // Bindings: exact five outputs, provenance equal to the table, clips packed here.
            val rawBindings = table.get("bindings"); keys(rawBindings, outputs.toSet())
            val bindings = linkedMapOf<String, CosmeticBinding>()
            var wakeBinding: CosmeticBinding? = null
            for (outputId in outputs) {
                val raw = rawBindings.get(outputId); keys(raw, setOf("sha256", "value"))
                val sha = hash(raw.get("sha256")); val v = raw.get("value")
                keys(v, setOf("version", "outputId", "sourceId", "sourceManifestSha256", "sourceIndexSha256", "sourceScale", "clips"))
                require(integer(v.get("version")) == 1 && text(v.get("outputId")) == outputId && number(v.get("sourceScale")) == 1f)
                val sourceId = text(v.get("sourceId"))
                require(sourceId == if (outputId == "aurora_wake") "auroraWake" else "artisan-market-t${outputId.last()}")
                require(hash(v.get("sourceManifestSha256")) == sourceManifest && hash(v.get("sourceIndexSha256")) == sourceIndex)
                val bound = requireNotNull(v.get("clips")); require(bound.isArray && bound.size > 0)
                for (entry in bound) {
                    val id = if (entry.isString) entry.asString() else { require(entry.isObject); text(entry.get("id")) }
                    require(id in clips || id in (1..4).map { "pe_cos_market_t${it}_ready" })
                }
                val binding = CosmeticBinding(outputId, sha, sourceManifest, sourceIndex, sourceId)
                if (outputId in awningOutputs) bindings[outputId] = binding else wakeBinding = binding
            }
            val awnings = array(value.get("awnings"), 4).map(::text); require(awnings == awningOutputs)
            return PhaseECosmeticArt(immutableMap(appearances), immutableMap(clips), group, immutableMap(bindings), requireNotNull(wakeBinding), sourceManifest, sourceIndex, provenance, sourceCommit, rules)
        }

        private fun optionalKeys(value: JsonValue?, candidates: Set<String>): Set<String> =
            candidates.filter { value != null && value.isObject && value.has(it) }.toSet()
        private fun keys(value: JsonValue?, expected: Set<String>) { require(value != null && value.isObject); val found = value.map { it.name }; require(found.size == expected.size && found.toSet() == expected) }
        private fun objectSize(value: JsonValue?, size: Int) { require(value != null && value.isObject && value.size == size) }
        private fun array(value: JsonValue?, size: Int): List<JsonValue> { require(value != null && value.isArray && value.size == size); return value.toList() }
        private fun text(value: JsonValue?): String { require(value != null && value.isString); return value.asString() }
        private fun hash(value: JsonValue?): String = text(value).also { require(it.matches(Regex("[0-9a-f]{64}"))) }
        private fun number(value: JsonValue?): Float { require(value != null && value.isNumber && value.asDouble().isFinite()); return value.asFloat().also { require(it.isFinite() && it.toDouble() == value.asDouble()) } }
        private fun integer(value: JsonValue?): Int { require(value != null && value.isNumber); val number = value.asDouble(); require(number.isFinite() && number % 1 == 0.0 && number >= Int.MIN_VALUE && number <= Int.MAX_VALUE); return number.toInt() }
        private fun positiveLong(value: JsonValue?): Long { require(value != null && value.isNumber); val number = value.asDouble(); require(number.isFinite() && number % 1 == 0.0 && number > 0 && number <= 9_007_199_254_740_991.0); return number.toLong() }
        private fun boolean(value: JsonValue?): Boolean { require(value != null && value.isBoolean); return value.asBoolean() }
        private fun point(value: JsonValue?): ServicePoint = array(value, 2).let { ServicePoint(number(it[0]), number(it[1])) }
        private fun <T> immutableList(values: List<T>): List<T> = Collections.unmodifiableList(values.toList())
        private fun <K, V> immutableMap(values: Map<K, V>): Map<K, V> = Collections.unmodifiableMap(LinkedHashMap(values))
    }
}
