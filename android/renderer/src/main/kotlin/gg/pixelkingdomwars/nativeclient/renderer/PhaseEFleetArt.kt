package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import java.util.Collections

/** Candidate renderer17 (N-C5-ART): the authored fleet-journey art — starter and four
 * advanced families — packed in 1 + 20 optional groups beside the renderer15 service graph
 * and the renderer16 bound cosmetics. The block carries the two generated web sidecars
 * VERBATIM; this parser admits them strictly (exact inventories, one-based keys, zero-based
 * source indices, geometry stated twice and agreeing, bindings pinned to one source) and
 * exposes the ONE concrete [FleetJourneyArt] adapter the accepted R1 consumer plays.
 * Metadata only: no files are opened, no art permission, residency, pixel readiness or
 * journey production follows from decoding it. [PhaseEFleetArt.parse] is a PRIVATE entry:
 * the global catalogue admission ([RendererCatalogue]) still rejects 17. */
data class FleetClip(val id: String, val group: String, val frames: List<ServiceSourceFrame>, val keys: List<String>,
    val fps: Float, val loop: Boolean, val cell: ServicePoint, val anchorPx: ServicePoint, val anchorKind: String,
    val reducedMotionFrame: Int, val reducedMotionClip: String?)
data class FleetBerthGeometry(val cell: ServicePoint, val footprint: ServicePoint, val horizontalPivot: Float, val sourceCellBottom: Float,
    val groundContact: ServicePoint, val attachment: ServicePoint, val tidalGate: ServicePoint?)
data class FleetVehicleGeometry(val cell: ServicePoint, val horizontalPivot: Float, val sourceCellBottom: Float,
    val contactPx: ServicePoint, val dockOffsetPx: ServicePoint, val berthRef: String)
/** Authored track DATA for one dash-named family: step offsets AND opacity, the shared gate effect name, its seat. */
data class FleetTrack(val family: String, val mode: String, val fps: Float, val departure: List<JourneyStep>, val back: List<JourneyStep>,
    val sharedFxRef: String?, val effectAttachmentPx: ServicePoint, val reducedMotion: String)
data class FleetBerth(val family: String, val group: String, val geometry: FleetBerthGeometry)
/** One craft: [tier] is null for the starter. [docked] is the clip a journey cycles on the contact. */
data class FleetVehicle(val family: String, val tier: Int?, val group: String, val geometry: FleetVehicleGeometry,
    val idle: FleetClip, val docked: FleetClip, val travel: FleetClip, val exhausted: FleetClip?)
data class FleetBasePack(val sourceCommit: String, val contentVersion: String)

class PhaseEFleetArt private constructor(
    /** The renderer15 service graph WITH the renderer16 cosmetics attached (both required at 17). */
    val services: PhaseEServiceArt,
    /** Every fleet clip (11 starter + 80 advanced) by id. */
    val clips: Map<String, FleetClip>,
    /** Dash-named family → berth (`starter`, `survey-balloon`, …). */
    val berths: Map<String, FleetBerth>,
    /** `starter` and `<dash-family>:<tier>` → craft. */
    val vehicles: Map<String, FleetVehicle>,
    /** Dash-named family → authored track. */
    val tracks: Map<String, FleetTrack>,
    /** The shared gate effect animations and their SEPARATELY authored one-frame stills. */
    val gateEffects: Map<RenderJourneyKind, FleetClip>, val gateStills: Map<RenderJourneyKind, FleetClip>,
    /** The 1 + 20 packed fleet groups with paired pins. */
    val groups: Map<String, ServiceAtlasGroup>,
    val sourceManifestSha256: String, val sourceIndexSha256: String, val sourceTracksSha256: String,
    val starterBindingSha256: String, val sourceCommit: String?, val basePack: FleetBasePack?,
) {
    /** The concrete adapter the accepted consumer plays. [atlasPath] resolves a packed group (the 21
     *  fleet groups and the cosmetics group) to the atlas identity the renderer's residency check
     *  compares — the lease-time canonical path of the resident atlas, as ServicePackedAtlas.path
     *  carries it. It is called ONCE per group at creation and the answers are owned immutable data;
     *  a null/blank answer, or one path answered for two groups (ambiguous), gives those groups NO
     *  art. The default pack-relative `atlas/<group>@1x.json` serves private metadata/source tests
     *  only and establishes no residency: real admission needs a later scoped mount that binds this
     *  resolver to the exact current content lease and recreates the adapter on generation change.
     *  Family names are the dash-named family-track names. Nothing here loads, queues or infers a journey. */
    fun journeyArt(atlasPath: (ServiceAtlasGroup) -> String? = { it.atlasPath }): FleetJourneyArt {
        val answered = linkedMapOf<String, String>()
        for (group in groups.values + listOfNotNull(services.cosmetics?.group)) atlasPath(group)?.takeIf { it.isNotBlank() }?.let { answered[group.id] = it }
        val ambiguous = answered.values.groupingBy { it }.eachCount().filterValues { it > 1 }.keys
        val paths: Map<String, String> = immutableMap(answered.filterValues { it !in ambiguous })
        return object : FleetJourneyArt {
            override fun track(family: String): JourneyTrack? = tracks[family]?.let { JourneyTrack(it.fps, it.departure, it.back, it.effectAttachmentPx, it.sharedFxRef) }
            override fun vehicle(family: String, tier: Int?): JourneyVehicleArt? {
                val craft = vehicles[if (tier == null) family else "$family:$tier"] ?: return null
                if (craft.tier != tier || craft.family != family) return null
                val path = paths[craft.group] ?: return null
                // Translation = berth attachment − craft contact (verified at parse); the consumer applies it ONCE.
                return JourneyVehicleArt(path, craft.docked.keys, craft.docked.fps, craft.geometry.cell, craft.geometry.contactPx, craft.geometry.dockOffsetPx)
            }
            override fun gateEffect(kind: RenderJourneyKind): JourneyEffectArt? {
                val effect = gateEffects[kind] ?: return null; val still = gateStills[kind] ?: return null
                val path = paths[effect.group] ?: return null
                return JourneyEffectArt(path, effect.keys, effect.fps, effect.cell, still.keys.single())
            }
            override fun wake(wake: RenderJourneyWake.Available): JourneyEffectArt? {
                val cosmetics = services.cosmetics ?: return null
                val binding = cosmetics.wakeBinding
                if (wake.outputId != PhaseECosmeticArt.WAKE_OUTPUT || wake.bindingSha256 != binding.sha256
                    || wake.sourceManifestSha256 != binding.sourceManifestSha256 || wake.sourceIndexSha256 != binding.sourceIndexSha256) return null
                val clip = cosmetics.clips[PhaseECosmeticArt.WAKE_CLIP] ?: return null
                val path = paths[cosmetics.group.id] ?: return null
                val still = (clip.reducedMotion as? ServiceReducedMotion.Frame)?.let { clip.frames.getOrNull(it.index)?.key }
                return JourneyEffectArt(path, immutableList(clip.frames.map { it.key }), clip.fps, clip.cell, still)
            }
        }
    }

    companion object {
        const val CONTRACT = 17
        const val STARTER_GROUP = "pe_fleet_starter"
        /** Group/wire names stay underscored; the authored family-track names are dashed. */
        val advancedFamilies: List<String> = immutableList(listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge"))
        val tiers: List<Int> = immutableList(listOf(1, 2, 3, 4))
        private val berthStates = listOf("intact", "damaged", "destroyed", "ambient")
        private val vehicleStates = listOf("idle", "docked", "travel", "exhausted")
        private val gateRefs = mapOf("departure" to RenderJourneyKind.DEPARTURE, "return" to RenderJourneyKind.RETURN)
        private const val MAX_FRAMES = 64
        fun dashed(family: String): String = family.replace('_', '-')

        /** The private renderer17 entry: the WHOLE render catalogue root. Exact integer 17, the complete
         *  service + cosmetics graphs and the strict fleet block; anything else throws. */
        fun parse(root: JsonValue): PhaseEFleetArt {
            val exact = root.get("rendererContractVersion")
            require(exact != null && exact.isNumber && exact.asDouble() == CONTRACT.toDouble()) { "Fleet art requires renderer17" }
            val services = PhaseEServiceArt.parse(requireNotNull(root.get("phaseE")) { "Service metadata is missing" })
                .withCosmetics(PhaseECosmeticArt.parse(requireNotNull(root.get("boundCosmetics")) { "Bound cosmetics metadata is missing" }))
            return parseFleet(requireNotNull(root.get("fleetJourneys")) { "Fleet journey metadata is missing" }, services)
        }

        private fun parseFleet(value: JsonValue, services: PhaseEServiceArt): PhaseEFleetArt {
            keys(value, setOf("version", "metadata", "groups") + optionalKeys(value, setOf("sourceCommit", "basePack")))
            require(integer(value.get("version")) == 1)
            val sourceCommit = value.get("sourceCommit")?.let { text(it).also { sha -> require(sha.matches(Regex("[0-9a-f]{40}"))) } }
            val basePack = value.get("basePack")?.let { pack -> keys(pack, setOf("sourceCommit", "contentVersion")); FleetBasePack(text(pack.get("sourceCommit")).also { s -> require(s.matches(Regex("[0-9a-f]{40}"))) }, hash(pack.get("contentVersion"))) }
            val metadata = requireNotNull(value.get("metadata")); keys(metadata, setOf("peStarterFleet", "peAdvancedFleet"))
            val clips = linkedMapOf<String, FleetClip>(); val berths = linkedMapOf<String, FleetBerth>(); val vehicles = linkedMapOf<String, FleetVehicle>()
            val tracks = linkedMapOf<String, FleetTrack>(); val frames = linkedSetOf<String>()
            val starter = parseStarter(metadata.get("peStarterFleet"), clips, berths, vehicles, tracks, frames)
            val advanced = parseAdvanced(metadata.get("peAdvancedFleet"), clips, berths, vehicles, tracks, frames)
            require(starter.sourceManifestSha256 == advanced.sourceManifestSha256 && starter.sourceIndexSha256 == advanced.sourceIndexSha256
                && starter.sourceTracksSha256 == advanced.sourceTracksSha256) { "Starter and advanced fleet tables come from different sources" }
            require(frames.size == 42 + 268) { "Fleet frame inventory changed" }
            // The 1 + 20 packed groups, paired pins, native scale, no collision with the service or cosmetics groups.
            val expectedGroups = (listOf(STARTER_GROUP) + advanced.atlases).toSet()
            val rawGroups = array(value.get("groups"), expectedGroups.size)
            val groups = linkedMapOf<String, ServiceAtlasGroup>()
            for (rawGroup in rawGroups) {
                keys(rawGroup, setOf("id", "atlasPath", "imagePath", "decodedBytes", "files"))
                val id = text(rawGroup.get("id")); require(id in expectedGroups && id !in groups && id !in services.groups) { "Fleet group collision: $id" }
                val atlasPath = text(rawGroup.get("atlasPath")); val imagePath = text(rawGroup.get("imagePath"))
                require(atlasPath == "atlas/$id@1x.json" && imagePath == "atlas/$id@1x.png")
                val decoded = positiveLong(rawGroup.get("decodedBytes")); require(decoded <= 4096L * 4096 * 4 && decoded % 4 == 0L)
                val pins = array(rawGroup.get("files"), 2).map { pin -> keys(pin, setOf("path", "sha256", "size")); ServiceFilePin(text(pin.get("path")), hash(pin.get("sha256")), positiveLong(pin.get("size"))) }
                require(pins.map { it.path } == listOf(atlasPath, imagePath))
                groups[id] = ServiceAtlasGroup(id, atlasPath, imagePath, decoded, immutableList(pins))
            }
            require(groups.keys == expectedGroups)
            for (clip in clips.values) require(clip.group in groups) { "Fleet clip packed in an unpinned group: ${clip.id}" }
            val gateEffects = linkedMapOf<RenderJourneyKind, FleetClip>(); val gateStills = linkedMapOf<RenderJourneyKind, FleetClip>()
            for ((ref, kind) in gateRefs) {
                val effect = clips.getValue("pe_fx_$ref"); val still = clips.getValue(requireNotNull(effect.reducedMotionClip))
                require(effect.keys.size == 8 && still.keys.size == 1 && still.keys.single() !in effect.keys) { "Gate still must be its own packed frame" }
                require(effect.frames.none { it.sha256 == still.frames.single().sha256 }) { "Gate still duplicates a normal frame digest" }
                gateEffects[kind] = effect; gateStills[kind] = still
            }
            return PhaseEFleetArt(services, immutableMap(clips), immutableMap(berths), immutableMap(vehicles), immutableMap(tracks), immutableMap(gateEffects),
                immutableMap(gateStills), immutableMap(groups), starter.sourceManifestSha256, starter.sourceIndexSha256, starter.sourceTracksSha256,
                starter.bindingSha256, sourceCommit, basePack)
        }

        private class StarterHeader(val sourceManifestSha256: String, val sourceIndexSha256: String, val sourceTracksSha256: String, val bindingSha256: String)
        private class AdvancedHeader(val sourceManifestSha256: String, val sourceIndexSha256: String, val sourceTracksSha256: String, val atlases: List<String>)

        private fun parseStarter(raw0: JsonValue?, clips: MutableMap<String, FleetClip>, berths: MutableMap<String, FleetBerth>, vehicles: MutableMap<String, FleetVehicle>,
            tracks: MutableMap<String, FleetTrack>, frames: MutableSet<String>): StarterHeader {
            val table = requireNotNull(raw0); keys(table, setOf("schemaVersion", "atlas", "sourceScale", "sourceIndexBase", "keyIndexBase", "sourceManifestSha256", "sourceTracksSha256", "sourceFxManifestSha256",
                "sourceIndexSha256", "provenanceSha256", "fxProvenanceSha256", "clips", "tracks", "geometry", "awayComposition", "bindingSha256"))
            require(integer(table.get("schemaVersion")) == 1 && text(table.get("atlas")) == STARTER_GROUP)
            require(number(table.get("sourceScale")) == 1f && integer(table.get("sourceIndexBase")) == 0 && integer(table.get("keyIndexBase")) == 1)
            for (name in listOf("sourceFxManifestSha256", "provenanceSha256", "fxProvenanceSha256")) hash(table.get(name))
            val header = StarterHeader(hash(table.get("sourceManifestSha256")), hash(table.get("sourceIndexSha256")), hash(table.get("sourceTracksSha256")), hash(table.get("bindingSha256")))
            require(text(table.get("awayComposition")).isNotBlank())
            val geometry = requireNotNull(table.get("geometry")); keys(geometry, setOf("starter", "berth"))
            val berth = berthGeometry(geometry.get("berth")); val craft = vehicleGeometry(geometry.get("starter"), berth, "starter-berth")
            val rawClips = requireNotNull(table.get("clips"))
            val ids = listOf("idle", "docked", "travel").map { "pe_veh_starter_$it" } + berthStates.map { "pe_berth_starter_$it" } +
                listOf("pe_fx_departure", "pe_fx_departure_still", "pe_fx_return", "pe_fx_return_still")
            keys(rawClips, ids.toSet())
            for (id in ids) {
                val raw = requireNotNull(rawClips.get(id))
                val kind = when { id.startsWith("pe_berth_") -> "berth"; id.startsWith("pe_veh_") -> "vehicle"; else -> "effect" }
                val clip = clip(id, raw, STARTER_GROUP, kind, berth, craft, "sha256", frames)
                if (kind != "effect") { val g = raw.get("geometry"); require(g != null); if (kind == "berth") require(berthGeometry(g) == berth) else require(vehicleGeometry(g, berth, "starter-berth") == craft) }
                require(clips.put(id, clip) == null)
            }
            for (ref in gateRefs.keys) { require(clips.getValue("pe_fx_$ref").reducedMotionClip == "pe_fx_${ref}_still"); require(clips.getValue("pe_fx_${ref}_still").keys.size == 1) }
            berths["starter"] = FleetBerth("starter", STARTER_GROUP, berth)
            vehicles["starter"] = FleetVehicle("starter", null, STARTER_GROUP, craft, clips.getValue("pe_veh_starter_idle"), clips.getValue("pe_veh_starter_docked"), clips.getValue("pe_veh_starter_travel"), null)
            val rawTracks = requireNotNull(table.get("tracks")); val fps = tracksHeader(rawTracks); keys(rawTracks.get("families"), setOf("starter"))
            tracks["starter"] = track("starter", rawTracks.get("families").get("starter"), fps, berth)
            return header
        }

        private fun parseAdvanced(raw0: JsonValue?, clips: MutableMap<String, FleetClip>, berths: MutableMap<String, FleetBerth>, vehicles: MutableMap<String, FleetVehicle>,
            tracks: MutableMap<String, FleetTrack>, frames: MutableSet<String>): AdvancedHeader {
            val table = requireNotNull(raw0); keys(table, setOf("schemaVersion", "sourceScale", "sourceIndexBase", "keyIndexBase", "sourceManifestSha256", "sourceTracksSha256", "sourceIndexSha256", "provenanceSha256", "atlases", "clips", "bindings", "tracks"))
            require(integer(table.get("schemaVersion")) == 1 && number(table.get("sourceScale")) == 1f && integer(table.get("sourceIndexBase")) == 0 && integer(table.get("keyIndexBase")) == 1)
            hash(table.get("provenanceSha256"))
            val expectedAtlases = advancedFamilies.flatMap { family -> listOf("pe_berth_$family") + tiers.map { "pe_veh_${family}_t$it" } }
            val atlases = array(table.get("atlases"), expectedAtlases.size).map(::text); require(atlases.toSet() == expectedAtlases.toSet() && atlases.size == atlases.toSet().size)
            val header = AdvancedHeader(hash(table.get("sourceManifestSha256")), hash(table.get("sourceIndexSha256")), hash(table.get("sourceTracksSha256")), immutableList(atlases))
            val rawClips = requireNotNull(table.get("clips")); val ids = linkedSetOf<String>()
            val berthGeometries = linkedMapOf<String, FleetBerthGeometry>(); val craftGeometries = linkedMapOf<String, FleetVehicleGeometry>()
            for (family in advancedFamilies) {
                val dash = dashed(family); val berthGroup = "pe_berth_$family"
                // Four berth states share ONE geometry per family.
                val berthRaw = berthStates.map { requireNotNull(rawClips.get("${berthGroup}_$it")) }
                val berth = berthGeometry(berthRaw.first().get("geometry"))
                for ((state, raw) in berthStates.zip(berthRaw)) {
                    val id = "${berthGroup}_$state"; require(ids.add(id))
                    require(text(raw.get("atlas")) == berthGroup && text(raw.get("sourceAssetId")) == "$dash-berth" && berthGeometry(raw.get("geometry")) == berth)
                    require(clips.put(id, clip(id, raw, berthGroup, "berth", berth, null, "rgbaSha256", frames)) == null)
                }
                berthGeometries[dash] = berth; berths[dash] = FleetBerth(dash, berthGroup, berth)
                for (tier in tiers) {
                    val group = "pe_veh_${family}_t$tier"
                    val vehicleRaw = vehicleStates.map { requireNotNull(rawClips.get("${group}_$it")) }
                    val craft = vehicleGeometry(vehicleRaw.first().get("geometry"), berth, "$dash-berth")
                    for ((state, raw) in vehicleStates.zip(vehicleRaw)) {
                        val id = "${group}_$state"; require(ids.add(id))
                        require(text(raw.get("atlas")) == group && text(raw.get("sourceAssetId")) == "$dash-t$tier" && vehicleGeometry(raw.get("geometry"), berth, "$dash-berth") == craft)
                        require(clips.put(id, clip(id, raw, group, "vehicle", berth, craft, "rgbaSha256", frames)) == null)
                    }
                    craftGeometries[group] = craft
                    vehicles["$dash:$tier"] = FleetVehicle(dash, tier, group, craft, clips.getValue("${group}_idle"), clips.getValue("${group}_docked"), clips.getValue("${group}_travel"), clips.getValue("${group}_exhausted"))
                }
            }
            keys(rawClips, ids)
            val rawTracks = requireNotNull(table.get("tracks")); val fps = tracksHeader(rawTracks)
            keys(rawTracks.get("families"), advancedFamilies.map(::dashed).toSet())
            for (family in advancedFamilies) { val dash = dashed(family); tracks[dash] = track(dash, rawTracks.get("families").get(dash), fps, berthGeometries.getValue(dash)) }
            // Bindings: exactly the twenty groups, pinned to THIS table's sources, geometry and track equal to the parsed ones.
            val rawBindings = requireNotNull(table.get("bindings")); keys(rawBindings, expectedAtlases.toSet())
            for (group in expectedAtlases) {
                val raw = requireNotNull(rawBindings.get(group)); keys(raw, setOf("sha256", "value")); hash(raw.get("sha256"))
                val v = requireNotNull(raw.get("value"))
                keys(v, setOf("version", "sourceAssetId", "sourceFamily", "kind", "tier", "atlas", "sourceManifestSha256", "sourceTracksSha256", "sourceIndexSha256", "geometry", "track", "clips") + optionalKeys(v, setOf("awayComposition")))
                require(integer(v.get("version")) == 1 && text(v.get("atlas")) == group)
                require(hash(v.get("sourceManifestSha256")) == header.sourceManifestSha256 && hash(v.get("sourceTracksSha256")) == header.sourceTracksSha256 && hash(v.get("sourceIndexSha256")) == header.sourceIndexSha256)
                // The binding's declared identity must be the ENCLOSING admitted group's own family / kind / tier / asset.
                val berth = group.startsWith("pe_berth_")
                val vehicleMatch = Regex("^pe_veh_([a-z_]+)_t([1-4])$").matchEntire(group)
                val family = if (berth) group.removePrefix("pe_berth_") else requireNotNull(vehicleMatch).groupValues[1]
                val groupTier = if (berth) null else requireNotNull(vehicleMatch).groupValues[2].toInt()
                require(family in advancedFamilies); val dash = dashed(family)
                require(text(v.get("sourceFamily")) == dash) { "Binding family differs from its group: $group" }
                require(text(v.get("kind")) == if (berth) "berth" else "vehicle") { "Binding kind differs from its group: $group" }
                if (berth) { require(v.get("tier").isNull && text(v.get("sourceAssetId")) == "$dash-berth") { "Binding identity differs from its group: $group" }; require(berthGeometry(v.get("geometry")) == berthGeometries.getValue(dash)) }
                else { require(integer(v.get("tier")) == groupTier && text(v.get("sourceAssetId")) == "$dash-t$groupTier") { "Binding identity differs from its group: $group" }
                    require(vehicleGeometry(v.get("geometry"), berthGeometries.getValue(dash), "$dash-berth") == craftGeometries.getValue(group)) }
                require(track(dash, v.get("track"), fps, berthGeometries.getValue(dash)) == tracks.getValue(dash)) { "Binding track differs from the family track: $group" }
                val bound = requireNotNull(v.get("clips")); require(bound.isArray && bound.size > 0)
                for (entry in bound) { val id = if (entry.isString) entry.asString() else { require(entry.isObject); text(entry.get("id")) }; require(clips[id]?.group == group) }
                v.get("awayComposition")?.let { require(text(it).isNotBlank()) }
            }
            return header
        }

        private fun clip(id: String, raw0: JsonValue?, group: String, kind: String, berth: FleetBerthGeometry, craft: FleetVehicleGeometry?, digestKey: String, frames: MutableSet<String>): FleetClip {
            val raw = requireNotNull(raw0); val base = setOf("sourcePath", "sourceSha256", "cellW", "cellH", "anchorKind", "anchorPx", "fps", "loop", "frames")
            keys(raw, base + optionalKeys(raw, setOf("sourceAssetId", "atlas", "geometry", "providerIndices", "reducedMotionFrame", "reducedMotionClip")))
            require(text(raw.get("sourcePath")).isNotBlank()); hash(raw.get("sourceSha256"))
            val cell = ServicePoint(number(raw.get("cellW")), number(raw.get("cellH"))); require(cell.x > 0f && cell.y > 0f)
            val anchor = point(raw.get("anchorPx")); val anchorKind = text(raw.get("anchorKind"))
            when (kind) {
                "berth" -> require(anchorKind == "cellBottomPivotX" && cell == berth.cell && anchor == ServicePoint(berth.horizontalPivot, berth.sourceCellBottom))
                "vehicle" -> { val c = requireNotNull(craft); require(anchorKind == "attachment" && cell == c.cell && anchor == c.contactPx) }
                else -> require(anchorKind == "centre" && anchor == ServicePoint(cell.x / 2f, cell.y / 2f))
            }
            val fps = number(raw.get("fps")); require(fps >= 0f); val loop = boolean(raw.get("loop"))
            val rawFrames = requireNotNull(raw.get("frames")); require(rawFrames.isArray && rawFrames.size in 1..MAX_FRAMES)
            val provider = raw.get("providerIndices")?.let { p -> require(p.isArray && p.size == rawFrames.size); p.map { integer(it).also { i -> require(i >= 0) } } }
            val source = rawFrames.mapIndexed { index, row ->
                keys(row, setOf("sourceIndex", "key", digestKey) + optionalKeys(row, setOf("providerIndex")))
                require(integer(row.get("sourceIndex")) == index)
                row.get("providerIndex")?.let { require(provider != null && integer(it) == provider[index]) }
                val key = text(row.get("key")); require(key == "${id}_f${index + 1}") { "Frame key is not one-based: $key" }; require(frames.add(key)) { "Duplicate fleet frame: $key" }
                ServiceSourceFrame(index, key, hash(row.get(digestKey)))
            }
            val reduced = raw.get("reducedMotionFrame")?.let(::integer) ?: 0; require(reduced in 0 until source.size)
            val reducedClip = raw.get("reducedMotionClip")?.let { text(it).also { c -> require(c.isNotBlank() && c != id) } }
            return FleetClip(id, group, immutableList(source), immutableList(source.map { it.key }), fps, loop, cell, anchor, anchorKind, reduced, reducedClip)
        }

        private fun berthGeometry(raw0: JsonValue?): FleetBerthGeometry {
            val raw = requireNotNull(raw0); keys(raw, setOf("cell", "footprint", "horizontalPivot", "sourceCellBottom", "groundContact", "attachment", "tidalGate", "drawScale"))
            val cell = point(raw.get("cell")); require(cell.x > 0f && cell.y > 0f && number(raw.get("drawScale")) == 1f)
            val attachment = point(raw.get("attachment")); require(within(attachment, cell))
            val ground = point(raw.get("groundContact")); require(within(ground, cell))
            val gate = raw.get("tidalGate")?.takeUnless { it.isNull }?.let(::point)?.also { require(within(it, cell)) }
            val pivot = number(raw.get("horizontalPivot")); val bottom = number(raw.get("sourceCellBottom")); require(pivot in 0f..cell.x && bottom in 0f..cell.y)
            return FleetBerthGeometry(cell, point(raw.get("footprint")).also { require(it.x > 0f && it.y > 0f) }, pivot, bottom, ground, attachment, gate)
        }
        /** The authored dock translation is stated twice (attachment − contact and dockOffsetPx); they must agree. */
        private fun vehicleGeometry(raw0: JsonValue?, berth: FleetBerthGeometry, berthRef: String): FleetVehicleGeometry {
            val raw = requireNotNull(raw0); keys(raw, setOf("cell", "horizontalPivot", "sourceCellBottom", "contactPx", "dockOffsetPx", "berthRef", "drawScale"))
            val cell = point(raw.get("cell")); require(cell.x > 0f && cell.y > 0f && number(raw.get("drawScale")) == 1f)
            val contact = point(raw.get("contactPx")); require(within(contact, cell))
            val dock = point(raw.get("dockOffsetPx"))
            require(dock == ServicePoint(berth.attachment.x - contact.x, berth.attachment.y - contact.y)) { "Dock translation differs from attachment minus contact" }
            require(text(raw.get("berthRef")) == berthRef)
            val pivot = number(raw.get("horizontalPivot")); val bottom = number(raw.get("sourceCellBottom")); require(pivot in 0f..cell.x && bottom in 0f..cell.y)
            return FleetVehicleGeometry(cell, pivot, bottom, contact, dock, berthRef)
        }
        private fun tracksHeader(raw0: JsonValue?): Float {
            val raw = requireNotNull(raw0); keys(raw, setOf("schemaVersion", "timingUnit", "fps", "generatedMotionRequired", "families"))
            require(integer(raw.get("schemaVersion")) == 1 && text(raw.get("timingUnit")).isNotBlank()); boolean(raw.get("generatedMotionRequired"))
            val fps = integer(raw.get("fps")); require(fps > 0); return fps.toFloat()
        }
        private fun track(family: String, raw0: JsonValue?, fps: Float, berth: FleetBerthGeometry): FleetTrack {
            val raw = requireNotNull(raw0); keys(raw, setOf("mode", "departure", "return", "berthPersists", "footprint", "sharedFxRef", "effectAttachmentPx", "contactRemainsOnWater", "travelScene", "reducedMotion"))
            val mode = text(raw.get("mode")); require(mode.isNotBlank())
            boolean(raw.get("berthPersists")); boolean(raw.get("contactRemainsOnWater")); require(text(raw.get("travelScene")).isNotBlank())
            require(point(raw.get("footprint")) == berth.footprint)
            val fx = raw.get("sharedFxRef"); val sharedFxRef = if (fx == null || fx.isNull) null else text(fx).also { require(it in gateRefs) { "Unknown shared gate effect: $it" } }
            val attachment = point(raw.get("effectAttachmentPx")); require(within(attachment, berth.cell))
            return FleetTrack(family, mode, fps, steps(raw.get("departure")), steps(raw.get("return")), sharedFxRef, attachment, text(raw.get("reducedMotion")).also { require(it.isNotBlank()) })
        }
        private fun steps(raw0: JsonValue?): List<JourneyStep> {
            val raw = requireNotNull(raw0); require(raw.isArray && raw.size in 1..MAX_FRAMES)
            return immutableList(raw.mapIndexed { index, row ->
                keys(row, setOf("frame", "offsetPx", "opacity"))
                require(integer(row.get("frame")) == index) { "Track ordinal is not zero-based" }
                val opacity = decimal(row.get("opacity"), 0.0, 1.0) // authored 0.85 / 0.15: finite, ranged on the ORIGINAL double, then converted
                JourneyStep(index, point(row.get("offsetPx")), opacity)
            })
        }
        private fun within(p: ServicePoint, cell: ServicePoint) = p.x in 0f..cell.x && p.y in 0f..cell.y

        private fun optionalKeys(value: JsonValue?, candidates: Set<String>): Set<String> = candidates.filter { value != null && value.isObject && value.has(it) }.toSet()
        private fun keys(value: JsonValue?, expected: Set<String>) { require(value != null && value.isObject); val found = value.map { it.name }; require(found.size == expected.size && found.toSet() == expected) { "Unexpected keys: $found" } }
        private fun array(value: JsonValue?, size: Int): List<JsonValue> { require(value != null && value.isArray && value.size == size); return value.toList() }
        private fun text(value: JsonValue?): String { require(value != null && value.isString); return value.asString() }
        private fun hash(value: JsonValue?): String = text(value).also { require(it.matches(Regex("[0-9a-f]{64}"))) }
        /** A finite authored decimal (opacity): the ORIGINAL double must lie in [min, max] before Float conversion, so a
         *  value outside the range can never round into it; integer-only fields keep the strict exact checks below. */
        private fun decimal(value: JsonValue?, min: Double, max: Double): Float { require(value != null && value.isNumber); val d = value.asDouble(); require(d.isFinite() && d >= min && d <= max); return d.toFloat().also { require(it.isFinite()) } }
        private fun number(value: JsonValue?): Float { require(value != null && value.isNumber && value.asDouble().isFinite()); return value.asFloat().also { require(it.isFinite() && it.toDouble() == value.asDouble()) } }
        private fun integer(value: JsonValue?): Int { require(value != null && value.isNumber); val number = value.asDouble(); require(number.isFinite() && number % 1 == 0.0 && number >= Int.MIN_VALUE && number <= Int.MAX_VALUE); return number.toInt() }
        private fun positiveLong(value: JsonValue?): Long { require(value != null && value.isNumber); val number = value.asDouble(); require(number.isFinite() && number % 1 == 0.0 && number > 0 && number <= Long.MAX_VALUE.toDouble()); return number.toLong() }
        private fun boolean(value: JsonValue?): Boolean { require(value != null && value.isBoolean); return value.asBoolean() }
        private fun point(value: JsonValue?): ServicePoint = array(value, 2).let { ServicePoint(number(it[0]), number(it[1])) }
        private fun <T> immutableList(values: List<T>): List<T> = Collections.unmodifiableList(values.toList())
        private fun <K, V> immutableMap(values: Map<K, V>): Map<K, V> = Collections.unmodifiableMap(LinkedHashMap(values))
    }
}
