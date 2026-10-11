package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import java.util.Collections

/** Renderer15 metadata only. No files are opened and no art permission or pixel
 * readiness follows from decoding this candidate graph. */
data class ServicePoint(val x: Float, val y: Float)
data class ServiceFilePin(val path: String, val sha256: String, val size: Long)
data class ServiceAtlasGroup(val id: String, val atlasPath: String, val imagePath: String,
    val decodedBytes: Long, val files: List<ServiceFilePin>)
data class ServiceSourceFrame(val sourceIndex: Int, val key: String, val sha256: String) {
    val hashDomain: String get() = "rgba-cell"
}
sealed interface ServiceReducedMotion {
    data object Unauthored : ServiceReducedMotion
    data class Frame(val index: Int) : ServiceReducedMotion
    data class SourceImage(val path: String, val sha256: String, val bytes: Long) : ServiceReducedMotion
}
data class ServiceClip(val id: String, val frames: List<ServiceSourceFrame>, val playbackIndices: List<Int>,
    val fps: Float, val loop: Boolean, val cell: ServicePoint, val anchorPx: ServicePoint,
    val anchorKind: String, val footprint: ServicePoint?, val reducedMotion: ServiceReducedMotion,
    val providerIndices: List<Int>?)
data class ServiceGeometry(val cell: ServicePoint, val footprint: ServicePoint, val drawScale: Float,
    val deedScale: Float, val horizontalPivot: Float, val cellBottom: Float, val providerCell: ServicePoint?,
    val sourcePivot: ServicePoint?, val contactLine: Float?, val groundContact: ServicePoint?,
    val attachment: ServicePoint?, val tidalGate: ServicePoint?)
data class ServiceStateRef(val appearance: String, val state: String)
sealed interface ServiceArtState {
    data class Still(val key: String) : ServiceArtState
    data class Clip(val clip: String) : ServiceArtState
    data class Alias(val target: ServiceStateRef) : ServiceArtState
    /** [overlayClip] names the packed craft-success overlay: the renderer15 effect clip by
     *  default, or a family's own packed overlay (renderer16 Awnings use `pe_cos_ready_fx`). */
    data class Composition(val parts: List<ServiceStateRef>, val overlay: ServicePoint? = null,
        val overlayClip: String = "pe_fx_craft-success") : ServiceArtState
}
data class ServiceAppearance(val id: String, val facility: String, val family: String, val tier: Int?,
    val geometry: ServiceGeometry, val states: Map<String, ServiceArtState>)
/** An explicit catalogue entry, never an atlas frame or a fallback realm/family. */
data class RenderServiceIdentity(val facility: String, val tier: Int?)

class PhaseEServiceArt private constructor(val appearances: Map<String, ServiceAppearance>,
    val clips: Map<String, ServiceClip>, val groups: Map<String, ServiceAtlasGroup>,
    val effectAnchor: ServicePoint,
    /** Renderer16 bound-cosmetics extension attached after both graphs parsed; null on a
     *  renderer15 pack. [appearances]/[clips]/[groups] then already include its entries. */
    val cosmetics: PhaseECosmeticArt? = null) {
    fun groupFor(key: String): ServiceAtlasGroup = groups.getValue(serviceGroup(key))

    /** The same admitted graph plus the Awning extension; ids and groups may not collide. */
    fun withCosmetics(extension: PhaseECosmeticArt): PhaseEServiceArt {
        require(cosmetics == null) { "Bound cosmetics are already attached" }
        require(extension.appearances.keys.none { it in appearances } && extension.clips.keys.none { it in clips } && extension.group.id !in groups)
        return PhaseEServiceArt(immutableMap(appearances + extension.appearances), immutableMap(clips + extension.clips),
            immutableMap(groups + (extension.group.id to extension.group)), effectAnchor, extension)
    }

    companion object {
        // Closed candidate-package vocabulary from shared/phaseEArt.ts, not game tuning.
        private val realms = listOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall")
        private val berthFamilies = listOf("starter", "survey-balloon", "cargo-cutter", "courier-airship", "expedition-barge")
        val facilities: Set<String> = immutableSet(setOf("workshop", "lodge", "market", "harvester", "berth"))

        /** Strict bounded graph, source/playback indices and complete reference closure. */
        fun parse(value: JsonValue): PhaseEServiceArt {
            keys(value, setOf("version", "metadata", "groups")); require(integer(value.get("version")) == 1)
            val metadata = value.get("metadata"); keys(metadata, setOf("peClips", "peAppearances", "peEffects"))
            val rawClips = metadata.get("peClips"); objectSize(rawClips, 138)
            val rawAppearances = metadata.get("peAppearances"); objectSize(rawAppearances, 49)
            val rawEffects = metadata.get("peEffects"); keys(rawEffects, setOf("craft-success"))
            val clips = linkedMapOf<String, ServiceClip>(); val appearances = linkedMapOf<String, ServiceAppearance>()
            val frames = linkedSetOf<String>()
            fun claim(key: String) { require(frames.add(key)); serviceGroup(key) }
            fun clip(id: String, count: Int, playback: Int, loop: Boolean, kind: String) {
                val raw = requireNotNull(rawClips.get(id)); val extra = if (kind == "service") setOf("footprint") else
                    setOf("providerIndices", "reducedMotion") + if (kind == "berth") setOf("footprint") else emptySet()
                keys(raw, setOf("frames", "playbackIndices", "fps", "loop", "cellW", "cellH", "anchorPx", "anchorKind") + extra)
                val source = array(raw.get("frames"), count).mapIndexed { index, row ->
                    keys(row, setOf("sourceIndex", "key", "sha256", "hashDomain"))
                    require(integer(row.get("sourceIndex")) == index && text(row.get("hashDomain")) == "rgba-cell")
                    val key = text(row.get("key")); require(key == "${id}_f${index + 1}"); claim(key)
                    ServiceSourceFrame(index, key, hash(row.get("sha256")))
                }
                val indices = array(raw.get("playbackIndices"), playback).map(::integer)
                require(indices == (0 until playback).toList())
                require(number(raw.get("fps")) == 8f && boolean(raw.get("loop")) == loop)
                val effect = kind == "effect"; val edge = if (effect) 64f else 112f
                require(number(raw.get("cellW")) == edge && number(raw.get("cellH")) == edge)
                val anchor = point(raw.get("anchorPx")); require(anchor == if (effect) ServicePoint(32f, 32f) else ServicePoint(56f, 112f))
                val anchorKind = text(raw.get("anchorKind")); require(anchorKind == if (effect) "centre" else "cellBottomPivotX")
                val footprint = raw.get("footprint")?.let(::point); require(footprint == if (effect) null else ServicePoint(2f, 2f))
                val provider = raw.get("providerIndices")?.let { array(it, 8).map(::integer) }
                if (kind != "service") require(provider == (1..8).toList())
                val reduced = when (kind) {
                    "service" -> ServiceReducedMotion.Unauthored
                    "berth" -> { val r = raw.get("reducedMotion"); keys(r, setOf("frame")); require(integer(r.get("frame")) == 0); ServiceReducedMotion.Frame(0) }
                    else -> {
                        val r = raw.get("reducedMotion"); keys(r, setOf("image")); val image = r.get("image"); keys(image, setOf("path", "sha256", "bytes"))
                        val path = text(image.get("path")); require(path == "production-assets/shared-fx/craft-success/frames/frame-00.png")
                        ServiceReducedMotion.SourceImage(path, hash(image.get("sha256")), positiveLong(image.get("bytes")))
                    }
                }
                if (count == 9 && playback == 8) require(source.first().sha256 == source.last().sha256)
                clips[id] = ServiceClip(id, immutableList(source), immutableList(indices), 8f, loop,
                    ServicePoint(edge, edge), anchor, anchorKind, footprint, reduced, provider?.let(::immutableList))
            }
            fun appearance(id: String, facility: String, family: String, tier: Int?, expected: Map<String, ServiceArtState>) {
                val raw = requireNotNull(rawAppearances.get(id)); keys(raw, setOf("id", "facility", "family", "tier", "geometry", "states"))
                require(text(raw.get("id")) == id && text(raw.get("facility")) == facility && text(raw.get("family")) == family)
                require(if (tier == null) raw.get("tier").isNull else integer(raw.get("tier")) == tier)
                val states = raw.get("states"); keys(states, expected.keys)
                expected.forEach { (name, state) -> checkState(states.get(name), state); if (state is ServiceArtState.Still) claim(state.key) }
                appearances[id] = ServiceAppearance(id, facility, family, tier, geometry(raw.get("geometry"), facility, family), immutableMap(expected))
            }
            for (facility in listOf("workshop", "lodge", "market", "harvester")) {
                for (family in if (facility == "harvester") realms else listOf(facility)) for (tier in 1..4) {
                    val id = if (facility == "harvester") "harvester-$family-t$tier" else "$family-t$tier"
                    val prefix = if (facility == "harvester") "pe_harv_${family}_t$tier" else "pe_${family}_t$tier"
                    val states = linkedMapOf<String, ServiceArtState>()
                    val stills = when (facility) { "workshop" -> listOf("idle", "ready", "damaged", "rubble"); "harvester" -> listOf("idle", "ready", "damaged", "destroyed"); else -> listOf("idle", "damaged") }
                    stills.forEach { states[it] = ServiceArtState.Still("${prefix}_${it}_f1") }
                    for (name in listOf("working", "construction", "collapse")) {
                        val working = name == "working"; val clipId = "${prefix}_$name"
                        clip(clipId, if (working && facility in setOf("lodge", "market")) 8 else 9, if (working) 8 else 9, working, "service")
                        states[name] = ServiceArtState.Clip(clipId)
                    }
                    if (facility == "harvester") states["rubble"] = ServiceArtState.Alias(ServiceStateRef(id, "destroyed"))
                    else states["destroyed"] = ServiceArtState.Alias(ServiceStateRef("workshop-t$tier", "rubble"))
                    if (facility in setOf("lodge", "market")) states["ready"] = ServiceArtState.Composition(immutableList(listOf(ServiceStateRef(id, "idle"))), ServicePoint(24f, 0f))
                    appearance(id, facility, family, tier, states)
                }
            }
            for (family in berthFamilies) {
                val id = "$family-berth"; val prefix = "pe_berth_$family"; val states = linkedMapOf<String, ServiceArtState>()
                listOf("intact", "damaged", "destroyed").forEach { states[it] = ServiceArtState.Still("${prefix}_${it}_f1") }
                clip("${prefix}_ambient", 8, 8, true, "berth"); states["ambient"] = ServiceArtState.Clip("${prefix}_ambient")
                states["away"] = ServiceArtState.Composition(immutableList(listOf(ServiceStateRef(id, "intact"), ServiceStateRef(id, "ambient"))))
                appearance(id, "berth", family, null, states)
            }
            clip("pe_fx_craft-success", 8, 8, false, "effect")
            keys(rawClips, clips.keys); keys(rawAppearances, appearances.keys); require(frames.size == 1403)
            val effect = rawEffects.get("craft-success"); keys(effect, setOf("clip", "anchor"))
            require(text(effect.get("clip")) == "pe_fx_craft-success"); val effectAnchor = point(effect.get("anchor")); require(effectAnchor == ServicePoint(.5f, .5f))
            val expectedGroups = frames.map(::serviceGroup).toSet(); require(expectedGroups.size == 46)
            val groups = linkedMapOf<String, ServiceAtlasGroup>()
            for (group in array(value.get("groups"), expectedGroups.size)) {
                keys(group, setOf("id", "atlasPath", "imagePath", "decodedBytes", "files"))
                val id = text(group.get("id")); require(id in expectedGroups && id !in groups)
                val atlasPath = text(group.get("atlasPath")); val imagePath = text(group.get("imagePath"))
                require(atlasPath == "atlas/$id@1x.json" && imagePath == "atlas/$id@1x.png")
                val decoded = positiveLong(group.get("decodedBytes")); require(decoded <= 4096L * 4096 * 4 && decoded % 4 == 0L)
                val pins = array(group.get("files"), 2).map { pin -> keys(pin, setOf("path", "sha256", "size")); ServiceFilePin(text(pin.get("path")), hash(pin.get("sha256")), positiveLong(pin.get("size"))) }
                require(pins.map { it.path } == listOf(atlasPath, imagePath))
                groups[id] = ServiceAtlasGroup(id, atlasPath, imagePath, decoded, immutableList(pins))
            }
            require(groups.keys.toList() == expectedGroups.sorted())
            return PhaseEServiceArt(immutableMap(appearances), immutableMap(clips), immutableMap(groups), effectAnchor)
        }

        /** Structural marker admission only. SceneMapper binds level/tier/footprint
         * to the accompanying exported gameplay catalogue before scene admission. */
        fun entry(value: JsonValue): RenderServiceIdentity {
            keys(value, setOf("type", "level", "footprintWidth", "footprintHeight", "phaseE"))
            val facility = text(value.get("type")); require(facility in facilities)
            val marker = value.get("phaseE"); keys(marker, setOf("facility", "tier")); require(text(marker.get("facility")) == facility)
            require(integer(value.get("level")) > 0 && number(value.get("footprintWidth")) == 2f && number(value.get("footprintHeight")) == 2f)
            require(!value.has("frameKey") && !value.has("atlasPath") && !value.has("motion"))
            val tier = if (facility == "berth") { require(marker.get("tier").isNull); null } else integer(marker.get("tier")).also { require(it in 1..4) }
            return RenderServiceIdentity(facility, tier)
        }
    }
}

private fun geometry(raw: JsonValue, facility: String, family: String): ServiceGeometry {
    val berth = facility == "berth"; val provider = facility in setOf("lodge", "market")
    keys(raw, setOf("cell", "footprint", "drawScale", "deedScale", "seat", "horizontalPivot", "cellBottom") +
        if (berth) setOf("groundContact", "attachment", "tidalGate") else setOf("sourcePivot", "contactLine") + if (provider) setOf("providerCell") else emptySet())
    val cell = point(raw.get("cell")); val footprint = point(raw.get("footprint"))
    require(cell == ServicePoint(112f, 112f) && footprint == ServicePoint(2f, 2f))
    require(number(raw.get("drawScale")) == 1f && number(raw.get("deedScale")) == .5f && text(raw.get("seat")) == "full-cell-bottom")
    require(number(raw.get("horizontalPivot")) == 56f && number(raw.get("cellBottom")) == 112f)
    val sourcePivot = raw.get("sourcePivot")?.let(::point); val contact = raw.get("contactLine")?.let(::number)
    val providerCell = raw.get("providerCell")?.let(::point)
    val ground = raw.get("groundContact")?.let(::point); val attachment = raw.get("attachment")?.let(::point)
    val tidal = raw.get("tidalGate")?.takeUnless { it.isNull }?.let(::point)
    if (berth) {
        val aerial = family in setOf("survey-balloon", "courier-airship")
        require(ground == ServicePoint(56f, 93f) && attachment == ServicePoint(56f, if (aerial) 56f else 78f))
        require(tidal == if (aerial) null else ServicePoint(56f, 28f))
    } else require(sourcePivot == ServicePoint(56f, 104f) && contact == 104f && providerCell == if (provider) ServicePoint(80f, 80f) else null)
    return ServiceGeometry(cell, footprint, 1f, .5f, 56f, 112f, providerCell, sourcePivot, contact, ground, attachment, tidal)
}
private fun checkState(raw: JsonValue, state: ServiceArtState) {
    when (state) {
        is ServiceArtState.Still -> { keys(raw, setOf("kind", "key")); require(text(raw.get("kind")) == "static" && text(raw.get("key")) == state.key) }
        is ServiceArtState.Clip -> { keys(raw, setOf("kind", "clip")); require(text(raw.get("kind")) == "clip" && text(raw.get("clip")) == state.clip) }
        is ServiceArtState.Alias -> { keys(raw, setOf("kind", "target")); require(text(raw.get("kind")) == "alias"); reference(raw.get("target"), state.target) }
        is ServiceArtState.Composition -> {
            keys(raw, setOf("kind", "parts") + if (state.overlay == null) emptySet() else setOf("overlay")); require(text(raw.get("kind")) == "composition")
            array(raw.get("parts"), state.parts.size).zip(state.parts).forEach { (value, expected) -> reference(value, expected) }
            if (state.overlay != null) { val overlay = raw.get("overlay"); keys(overlay, setOf("effect", "offset")); require(text(overlay.get("effect")) == "craft-success" && point(overlay.get("offset")) == state.overlay) }
        }
    }
}
private fun reference(raw: JsonValue, expected: ServiceStateRef) { keys(raw, setOf("appearance", "state")); require(text(raw.get("appearance")) == expected.appearance && text(raw.get("state")) == expected.state) }
private fun serviceGroup(key: String): String = when {
    key.startsWith("pe_cos_") -> PhaseECosmeticArt.GROUP
    key.startsWith("pe_berth_") -> "pe_fleet_berths"
    key.startsWith("pe_fx_craft-success_") -> "pe_fx"
    else -> requireNotNull(Regex("^(pe_(?:workshop|lodge|market|harv_[a-z-]+)_t[1-4])_[a-z]+_f[1-9]$").matchEntire(key)?.groupValues?.get(1))
}
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
private fun <T> immutableSet(values: Set<T>): Set<T> = Collections.unmodifiableSet(values.toSet())
