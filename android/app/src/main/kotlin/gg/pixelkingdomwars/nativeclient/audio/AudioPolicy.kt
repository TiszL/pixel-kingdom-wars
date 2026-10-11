package gg.pixelkingdomwars.nativeclient.audio

import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.string
import kotlinx.serialization.json.*

/** Technical presentation bounds from the admitted catalogue's shared AUDIO_RUNTIME. */
data class AudioRuntime(
    val maxDecodedBytes: Long, val preloadConcurrency: Int,
    val maxOneShotVoices: Int, val maxOneShotVoicesPerCue: Int,
    val duplicateCoalesceMs: Long, val battleBankWindowMs: Long, val battleBankPreloadLeadMs: Long,
    val manifestRequestTimeoutMs: Long, val manifestRetryDelayMs: Long,
    val assetRequestTimeoutMs: Long, val bankReadyDeadlineMs: Long,
    val initialBattleAudioBudgetMs: Long, val ambienceVolume: Float,
) {
    companion object {
        fun from(catalogue: JsonObject): AudioRuntime {
            val values = catalogue.getValue("constants").jsonObject.getValue("AUDIO_RUNTIME").jsonObject
            fun positive(key: String) = requireNotNull(values[key]?.jsonPrimitive?.longOrNull).also { require(it > 0) }
            fun count(key: String) = positive(key).also { require(it <= Int.MAX_VALUE) }.toInt()
            return AudioRuntime(positive("maxDecodedBytes"), count("preloadConcurrency"),
                count("maxOneShotVoices"), count("maxOneShotVoicesPerCue"), positive("duplicateCoalesceMs"),
                positive("battleBankWindowMs"), positive("battleBankPreloadLeadMs"), positive("manifestRequestTimeoutMs"),
                positive("manifestRetryDelayMs"), positive("assetRequestTimeoutMs"), positive("bankReadyDeadlineMs"),
                positive("initialBattleAudioBudgetMs"), requireNotNull(values["ambienceVolume"]?.jsonPrimitive?.floatOrNull)
                    .also { require(it.isFinite() && it in 0f..1f) })
        }
    }
}

/** The caller supplies the FULL manifest already admitted for this catalogue, never a fresh
 * network manifest. Optional audio bytes are authenticated by these same immutable pins. */
data class AudioPack(val manifest: NativeContentManifest, val runtime: AudioRuntime) {
    val identity: String get() = manifest.contentVersion
    companion object {
        fun from(catalogue: JsonObject, manifest: NativeContentManifest): AudioPack {
            require(catalogue.string("sourceCommit") == manifest.sourceCommit)
            require(catalogue["simVersion"]?.jsonPrimitive?.intOrNull == manifest.simVersion)
            return AudioPack(manifest, AudioRuntime.from(catalogue))
        }
    }
}

enum class MusicTrack(val path: String) {
    WORLD("audio/bgmusic-world.mp3"), BATTLE("audio/bgmusic-battle.mp3");
    companion object {
        /** Canonical audio.ts: deploy, playback and results all belong to screen=battle. */
        fun forScreen(screen: String) = if (screen == "battle") BATTLE else WORLD
        // Canonical apps/web/src/lib/audio.ts: ensureMusicEl(). Technical bus gain, not game tuning.
        const val VOLUME = 0.4f
    }
}

fun ambienceFamilyForScreen(screen: String): String? = when (screen) {
    "battle" -> "sfx_ambience_battle"
    "map", "scout" -> "sfx_ambience_campaign"
    "base", "build", "layout", "expand" -> "sfx_ambience_base_day"
    else -> null
}

/** FNV-1a over UTF-16 code units, exactly the canonical JS deterministicSfxHash. */
fun deterministicSfxHash(value: String): UInt {
    var hash = 0x811c9dc5u
    value.forEach { hash = (hash xor it.code.toUInt()) * 0x01000193u }
    return hash
}

data class AudioDefinition(val id: String, val path: String,
                           val loopStartSeconds: Double? = null, val loopEndSeconds: Double? = null) {
    val loopSafe: Boolean get() = !path.endsWith(".mp3") || (loopStartSeconds != null && loopEndSeconds != null)
}

/** Parse only a hash-verified audio/sfx-ai/manifest.json from this same audio pack. */
class AudioDefinitions(private val definitions: Map<String, AudioDefinition>) {
    // Resolve exact families once per immutable manifest. Playing one cue must not build
    // a regex and scan/sort the entire sound catalogue on Main for every rendered event.
    private val families = definitions.values.filter { it.id.takeLast(3) in setOf("_v1", "_v2", "_v3") }
        .groupBy { it.id.dropLast(3) }.mapValues { (_, variants) -> variants.sortedBy { it.id } }
    fun get(id: String): AudioDefinition? = definitions[id]
    /** A bounded visible-screen bank may retain every authored variant for its named families. */
    fun familyIds(families: Collection<String>): List<String> = families.distinct()
        .flatMap { this.families[it].orEmpty() }.map { it.id }.sorted()
    fun resolve(family: String, variantKey: String, loop: Boolean = false): AudioDefinition? {
        val variants = families[family].orEmpty().let { if (loop) it.filter { value -> value.loopSafe } else it }
        if (variants.isEmpty()) return null
        return variants[(deterministicSfxHash("$family:$variantKey") % variants.size.toUInt()).toInt()]
    }
    companion object {
        private val productionId = Regex("sfx_(?:troop|hero|defense|ui|base|battle|ambience)_[a-z0-9_]+_v[1-3]")
        fun from(pack: AudioPack, productionManifest: JsonObject? = null): AudioDefinitions {
            val files = pack.manifest.files.associateBy { it.path }
            val values = mutableMapOf<String, AudioDefinition>()
            files.keys.filter { it.matches(Regex("audio/sfx/sfx_[a-z0-9_]+\\.wav")) }.forEach { path ->
                val id = path.substringAfterLast('/').removeSuffix(".wav")
                values[id] = AudioDefinition(id, path)
            }
            if (productionManifest?.get("schemaVersion")?.jsonPrimitive?.intOrNull == 1) {
                (productionManifest["entries"] as? JsonArray).orEmpty().forEach { raw ->
                    val entry = raw as? JsonObject ?: return@forEach
                    val id = entry.string("id") ?: return@forEach
                    val file = entry.string("file") ?: return@forEach
                    if (!productionId.matches(id) || !file.matches(Regex("[A-Za-z0-9_./-]+\\.(?:mp3|wav)"))
                        || ".." in file || "//" in file) return@forEach
                    val path = "audio/sfx-ai/$file"
                    if (path !in files) return@forEach
                    val hasLoop = "loopStart" in entry || "loopEnd" in entry
                    val start = (entry["loopStart"] as? JsonPrimitive)?.doubleOrNull
                    val end = (entry["loopEnd"] as? JsonPrimitive)?.doubleOrNull
                    if (hasLoop && (start == null || end == null || !start.isFinite() || !end.isFinite() || start < 0 || start >= end)) return@forEach
                    values[id] = AudioDefinition(id, path, start, end)
                }
            }
            return AudioDefinitions(values)
        }
    }
}

enum class AudioPriority { AMBIENT, NORMAL, CRITICAL }
data class AudioVoice(val token: Long, val cue: String, val priority: AudioPriority)
data class VoiceAdmission(val voice: AudioVoice?, val evicted: List<AudioVoice> = emptyList())

/** Pure canonical audio.ts admission. The playback backend closes every returned victim.
 * Loops use actor leases separately; these limits apply to one-shots only. */
class AudioVoicePlan(private val runtime: AudioRuntime) {
    private val voices = mutableListOf<AudioVoice>()
    private val lastStarted = mutableMapOf<String, Long>()
    private var sequence = 0L
    val active: List<AudioVoice> get() = voices.toList()
    fun admit(cue: String, priority: AudioPriority, nowMs: Long): VoiceAdmission {
        require(nowMs >= 0)
        if (lastStarted[cue]?.let { nowMs - it < runtime.duplicateCoalesceMs } == true) return VoiceAdmission(null)
        val evicted = mutableListOf<AudioVoice>()
        val order = compareBy<AudioVoice> { it.priority.ordinal }.thenBy { it.token }
        val same = voices.filter { it.cue == cue }.sortedWith(order)
        if (same.size >= runtime.maxOneShotVoicesPerCue) {
            val victim = same.first()
            if (victim.priority > priority) return VoiceAdmission(null)
            voices.remove(victim); evicted += victim
        }
        if (voices.size >= runtime.maxOneShotVoices) {
            val victim = voices.minWithOrNull(order)
            if (victim == null || victim.priority > priority) return VoiceAdmission(null, evicted)
            voices.remove(victim); evicted += victim
        }
        val voice = AudioVoice(++sequence, cue, priority)
        voices += voice; lastStarted[cue] = nowMs
        return VoiceAdmission(voice, evicted)
    }
    fun ended(token: Long) { voices.removeAll { it.token == token } }
    fun clear(): List<AudioVoice> = voices.toList().also { voices.clear(); lastStarted.clear() }
}
