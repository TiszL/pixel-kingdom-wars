package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.TextureData
import com.badlogic.gdx.graphics.glutils.PixmapTextureData
import com.badlogic.gdx.utils.JsonReader
import java.io.Closeable
import java.nio.ByteBuffer
import java.util.Collections
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

/** Operational allocation bound, not gameplay tuning or a device-readiness
 * approval. The pinned candidate's maximum single-realm closure is 32,702,864 B. */
internal const val MAX_SELECTED_SERVICE_RGBA_BYTES = 64L * 1024 * 1024
internal fun servicePixelsWithinBudget(groups: Iterable<ServiceAtlasGroup>): Boolean {
    var total=0L
    for (group in groups) {
        if (group.decodedBytes <= 0 || group.decodedBytes > MAX_SELECTED_SERVICE_RGBA_BYTES - total) return false
        total += group.decodedBytes
    }
    return true
}

internal data class ServicePackedCell(val texture: String, val x: Int, val y: Int, val width: Int, val height: Int)
internal data class ServicePackedAtlas(val path: String, val texture: String, val file: FileHandle,
    val cells: Map<String, ServicePackedCell>, val pixels: ServiceTexturePixels)

/** Only pending bundles and queued/resident textures own these CPU pixels.
 * Managed context restoration reuses the same retained owner; no file is reopened. */
internal class ServiceTexturePixels(val data: TextureData, private val dispose: () -> Unit) : Closeable {
    private var references = 1
    @Synchronized fun retain(): ServiceTexturePixels { check(references > 0); references++; return this }
    /** Another owner only while one still holds these pixels; null once the last owner has left (they are disposed). */
    @Synchronized fun retainIfOwned(): ServiceTexturePixels? = if (references > 0) { references++; this } else null
    @Synchronized override fun close() { check(references > 0); if (--references == 0) dispose() }
    companion object {
        fun decode(file: FileHandle): ServiceTexturePixels {
            val pixmap = Pixmap(file)
            return try {
                require(pixmap.format == Pixmap.Format.RGBA8888)
                ServiceTexturePixels(PixmapTextureData(pixmap,Pixmap.Format.RGBA8888,false,false,true)) { pixmap.dispose() }
            } catch (error: Exception) { pixmap.dispose(); throw error }
        }
    }
}

/** Owner report 2026-10-11 ("so laggy it is not playable"): with Phase E art on, every /base-driven Home refresh (each
 * resume, each poll) decoded every selected PNG again (up to the 64 MiB selected-pixel cap) only for the renderer to skip
 * uploading textures that were already resident, so each refresh was a burst of large allocations and GC pauses.
 * A selected picture is now decoded at most once while any owner (a pending/staged bundle or a resident texture) still
 * holds its pixels: a later preparation of the same picture becomes one more owner of the SAME pixels. This index owns
 * NO reference itself, so residency, the selected-pixel cap and eviction stay exactly the existing owners' (the last
 * close disposes the pixels and unindexes them; the next preparation decodes afresh). Keyed by the leased image's
 * canonical path, the identity the renderer's texture residency already uses; leased directories are content-addressed
 * (one verified generation per content version), so one path is one set of bytes. What is drawn never changes. */
internal class ServicePixelCache(private val decoder: (FileHandle) -> ServiceTexturePixels = ServiceTexturePixels::decode) {
    private val owned = java.util.concurrent.ConcurrentHashMap<String, ServiceTexturePixels>()
    fun decode(file: FileHandle): ServiceTexturePixels {
        val key = file.file().canonicalPath
        owned[key]?.retainIfOwned()?.let { return it }
        val decoded = decoder(file)
        lateinit var shared: ServiceTexturePixels
        shared = ServiceTexturePixels(decoded.data) { owned.remove(key, shared); decoded.close() }
        owned[key] = shared
        return shared
    }
}

/** N-C5 RESIDENCY: the selected fleet groups PREPARED with one current Home generation — their packed atlases
 *  (by canonical atlas path, kept apart from the ordinary service atlases so ordinary visuals are untouched) and
 *  the ONE private ART adapter built for exactly this generation from those canonical paths. [capability] is the
 *  typed private fleet art the owner wiring supplied (never a production default); it confers no content
 *  admission: only groups the EXISTING source actually leased are resident here. */
internal class FleetResidency(val atlases: Map<String, ServicePackedAtlas>, val journeyArt: FleetJourneyArt,
    val groups: Set<String>, val capability: PhaseEFleetArt,
    /** The exact source whose leases these atlases are; eligibility compares it by identity. */
    val source: ServiceAssetSource) {
    /** True when [wake] is the admitted Aurora capture (output and all three hashes equal the carried binding):
     *  such a Wake must DRAW from resident cells or the journey DROPS — never a partial flight without it. */
    fun wakeAdmitted(wake: RenderJourneyWake.Available): Boolean {
        val binding = capability.services.cosmetics?.wakeBinding ?: return false
        return wake.outputId == PhaseECosmeticArt.WAKE_OUTPUT && wake.bindingSha256 == binding.sha256
            && wake.sourceManifestSha256 == binding.sourceManifestSha256 && wake.sourceIndexSha256 == binding.sourceIndexSha256
    }
}

/** Leases follow worker → pending → staged → active ownership. Close only after
 * the last GL texture load/unload using these files, or before an unused handoff. */
internal class ServiceSceneAssets(val plans: Map<String, Map<ServiceCombatState?, ServicePlan>>,
    val atlases: Map<String, ServicePackedAtlas>, private val leases: List<ServiceAssetLease>,
    /** Selected fleet residency prepared with this generation, or null (no capability, battle, nothing selected, refused). */
    val fleet: FleetResidency? = null) : Closeable {
    private val closed = AtomicBoolean()
    private val pixelsReleased = AtomicBoolean()
    /** Every packed atlas this generation owns (ordinary service + cosmetics + selected fleet), by canonical path. */
    val allAtlases: Map<String, ServicePackedAtlas> = if (fleet == null) atlases else Collections.unmodifiableMap(LinkedHashMap(atlases + fleet.atlases))
    val paths: Set<String> get() = allAtlases.keys
    /** The adapter prepared WITH these assets (null = no journey can be admitted against this generation). */
    val journeyArt: FleetJourneyArt? get() = fleet?.journeyArt
    /** Only a fully admitted current state's first body layer owns hit height. */
    fun hitBodyHeight(id:String,state:ServiceCombatState?):Float? = state?.let { plans[id]?.get(it) }
        ?.layers?.firstOrNull()?.let { it.cell.y*it.scale }
    fun releasePixels() { if (pixelsReleased.compareAndSet(false,true)) allAtlases.values.forEach { it.pixels.close() } }
    override fun close() { if (closed.compareAndSet(false, true)) { releasePixels(); leases.forEach { it.close() } } }
    companion object {
        /** The fleet groups a CURRENT Home generation selects, solely from accepted completed-berth facts: the starter
         *  installation's craft group, or the exact current advanced family/tier craft group; the shared gate group
         *  ONLY when that family's track names a shared effect (aerial lift-off acquires no tidal gate); and, once any
         *  craft is selected, the existing cosmetics group so the ORIGINAL captured Wake's cells are resident
         *  independent of present On/Off. Null/unknown/contradictory siblings, construction, level 0 and duplicate
         *  rows select nothing for that berth. No tier is inferred from a level, no ID from anything. */
        internal fun selectFleetGroups(fleet: PhaseEFleetArt, art: PhaseEServiceArt, base: BaseScene): Set<String> {
            val facts = base.services; val groups = linkedSetOf<String>()
            for (building in base.buildings) {
                if (building.service?.facility != "berth" || building.type != "berth" || building.underConstruction || (building.level ?: 0) < 1) continue
                val starterInstalled = facts.berths?.any { it.buildingId == building.id && it.installation != null } == true
                val advancedInstalled = facts.currentAdvancedBerths?.any { it.buildingId == building.id && it.installation != null } == true
                if (starterInstalled && advancedInstalled) continue // contradictory installed siblings: nothing is selected
                val starter = facts.berths?.singleOrNull { it.buildingId == building.id }?.installation
                val advanced = facts.currentAdvancedBerths?.singleOrNull { it.buildingId == building.id }?.installation
                val familyKey: String; val tier: Int?
                when {
                    starter?.family == "starter" -> { familyKey = "starter"; tier = null }
                    advanced != null && advanced.family in PhaseEFleetArt.advancedFamilies && advanced.tier in PhaseEFleetArt.tiers -> { familyKey = journeyFamilyKey(advanced.family); tier = advanced.tier }
                    else -> continue
                }
                val craft = fleet.vehicles[if (tier == null) familyKey else "$familyKey:$tier"] ?: continue
                val track = fleet.tracks[familyKey] ?: continue
                groups += craft.group
                if (track.sharedFxRef != null) { fleet.gateEffects.values.forEach { groups += it.group }; fleet.gateStills.values.forEach { groups += it.group } }
            }
            if (groups.isNotEmpty()) art.cosmetics?.let { groups += it.group.id }
            return groups
        }

        /** A capability is the admitted service art's COMPANION only when its cosmetics descriptor (group, paths, pins,
         *  decoded size) and carried Aurora binding EQUAL the ordinary graph's, and none of its fleet group ids exist in
         *  the ordinary graph. Otherwise its Wake metadata could be evaluated against bytes of another graph; the whole
         *  optional fleet addition refuses and the ordinary scene is untouched. Identity by exact pins, never by id alone. */
        internal fun fleetCompatible(fleet: PhaseEFleetArt, art: PhaseEServiceArt): Boolean {
            val ordinary = art.cosmetics ?: return false; val companion = fleet.services.cosmetics ?: return false
            if (ordinary.group != companion.group || ordinary.wakeBinding != companion.wakeBinding) return false
            if (ordinary.sourceManifestSha256 != companion.sourceManifestSha256 || ordinary.sourceIndexSha256 != companion.sourceIndexSha256) return false
            return fleet.groups.keys.none { it in art.groups }
        }

        fun prepare(art: PhaseEServiceArt?, base: BaseScene, source: ServiceAssetSource?, enabled: Boolean,
            reduced: Boolean, battle: Boolean, checkpoint: () -> Unit, diagnostic: (String) -> Unit = {},
            decode: (FileHandle) -> ServiceTexturePixels = ServiceTexturePixels::decode,
            /** N-C5 RESIDENCY: optional typed private fleet art beside the source (no production default caller). */
            fleet: PhaseEFleetArt? = null): ServiceSceneAssets {
            if (art == null || source == null || !runCatching { source.isCurrent() }.getOrDefault(false) || !enabled || !battle && base.services.phaseEArtEnabled != true)
                return ServiceSceneAssets(emptyMap(), emptyMap(), emptyList())
            val ownedCheckpoint = {
                checkpoint()
                if (!runCatching { source.isCurrent() }.getOrDefault(false)) throw CancellationException()
            }
            val selected = base.buildings.filter { it.service != null }.associate { building ->
                val states: List<ServiceCombatState?> = if (battle) ServiceCombatState.entries else listOf(null)
                building.id to states.mapNotNull { state ->
                    val job = if (battle) null else base.jobs.singleOrNull { it.buildingId == building.id }?.kind
                    selectServicePlan(art, building, base.visual?.realmId, base.services, true, reduced, job, state,
                        staticBerth = !battle && fleet == null).plan?.let { state to it }
                }.toMap()
            }
            val needed = selected.values.flatMap { it.values }.flatMap { it.groups }.toSortedSet()
            if (!servicePixelsWithinBudget(needed.map { art.groups.getValue(it) })) {
                diagnostic("Service artwork exceeds this renderer's selected-pixel allocation limit")
                return ServiceSceneAssets(emptyMap(),emptyMap(),emptyList())
            }
            // N-C5 RESIDENCY: current Home only (never a battle), selected from the accepted facts, charged against the
            // SAME selected-pixel budget after the ordinary groups. A refused fleet addition is diagnosed and leaves
            // journeys unavailable; it never changes the ordinary scene and is never reported as prepared.
            val companion = fleet != null && !battle && (fleetCompatible(fleet, art) || run { diagnostic("Fleet artwork is not the companion of the admitted service art"); false })
            val fleetSelected: Set<String> = if (!companion) emptySet() else selectFleetGroups(fleet!!, art, base)
            val fleetGroups = fleetSelected.filter { it !in needed }
            val fleetNeeded: List<String> = if (fleetGroups.isEmpty()) emptyList()
                else if (servicePixelsWithinBudget(needed.map { art.groups.getValue(it) } + fleetGroups.map { fleet!!.groups[it] ?: art.groups.getValue(it) })) fleetGroups
                else { diagnostic("Fleet artwork exceeds this renderer's selected-pixel allocation limit"); emptyList() }
            val leases = linkedMapOf<String, ServiceAssetLease>(); val packed = linkedMapOf<String, ServicePackedAtlas>()
            try {
                for (id in needed + fleetNeeded) {
                    ownedCheckpoint()
                    var lease: ServiceAssetLease? = null
                    var atlas: ServicePackedAtlas? = null
                    try {
                        lease = source.acquire(id, ownedCheckpoint); ownedCheckpoint()
                        val fleetGroup = if (id in fleetNeeded) fleet?.groups?.get(id) else null
                        // Fleet groups: the leased bytes must BE the capability's pinned bytes (exact size + SHA-256 of both files,
                        // bounded by the pins) BEFORE any canonical path is exposed; then the SAME reader with the exact accepted
                        // inventory (never the legacy service routing). The ordinary source authenticates its own groups' pins.
                        if (fleetGroup != null) verifyPackedPins(fleetGroup, lease.directory)
                        atlas = if (fleetGroup != null) readPackedAtlas(fleetExpectedCells(fleet!!, fleetGroup), fleetGroup, lease.directory, decode)
                            else readServiceAtlas(art, art.groups.getValue(id), lease.directory, decode)
                        ownedCheckpoint(); packed[id] = atlas; leases[id] = lease; lease = null; atlas = null
                    } catch (error: Exception) {
                        ownedCheckpoint() // Supersession always wins over a recoverable missing optional group.
                        if (error is CancellationException) throw error
                        diagnostic(if (id in fleetNeeded) "Fleet artwork unavailable: $id" else "Service artwork unavailable: $id")
                    } finally { atlas?.pixels?.close(); lease?.close() }
                }
                val available = selected.mapValues { (_, plans) -> plans.filterValues { plan -> plan.groups.all { it in packed } } }
                val used = available.values.flatMap { it.values }.flatMap { it.groups }.toSet()
                // Selected fleet groups (and the Wake's cosmetics group) survive service-plan pruning; everything else
                // unused is released exactly once here.
                val fleetPacked = fleetNeeded.filter { it in packed }.toSet()
                val keep = used + fleetPacked
                leases.keys.filter { it !in keep }.forEach { leases.remove(it)?.close(); packed.remove(it)?.pixels?.close() }
                val fleetAtlasIds = fleetPacked.filter { fleet!!.groups.containsKey(it) }.toSet()
                val service = packed.filterKeys { it !in fleetAtlasIds }
                // The adapter is built ONCE for this generation from the exact canonical paths of the groups it leased;
                // an unleased group answers null, so its art is simply absent (never a relative metadata identity).
                val residency = if (fleet != null && fleetAtlasIds.isNotEmpty())
                    FleetResidency(Collections.unmodifiableMap(packed.filterKeys { it in fleetAtlasIds }.values.associateBy { it.path }),
                        fleet.journeyArt { group -> packed[group.id]?.path }, Collections.unmodifiableSet(fleetPacked), fleet, source) else null
                return ServiceSceneAssets(Collections.unmodifiableMap(available.mapValues { Collections.unmodifiableMap(it.value) }),
                    Collections.unmodifiableMap(service.values.associateBy { it.path }), leases.values.toList(), residency)
            } catch (error: Exception) { packed.values.forEach { it.pixels.close() }; leases.values.forEach { it.close() }; throw error }
        }
    }
}

/** Validate the complete selected atlas before any texture is queued. The content
 * source authenticates bytes; this binds packed geometry and bounded PNG residency
 * to the admitted graph. It does not claim GL upload or device readiness. */
internal fun readServiceAtlas(art: PhaseEServiceArt, group: ServiceAtlasGroup, directory: FileHandle,
    decode: (FileHandle) -> ServiceTexturePixels): ServicePackedAtlas {
    val expected = linkedMapOf<String, ServicePoint>()
    for (clip in art.clips.values) for (frame in clip.frames) if (art.groupFor(frame.key).id == group.id) expected[frame.key] = clip.cell
    for (appearance in art.appearances.values) for (state in appearance.states.values)
        if (state is ServiceArtState.Still && art.groupFor(state.key).id == group.id) expected[state.key] = appearance.geometry.cell
    return readPackedAtlas(expected, group, directory, decode)
}

/** N-C5 RESIDENCY: the exact expected cell inventory of one accepted fleet group — every frame key of every clip
 *  packed in it (normal frames AND the separately authored stills are their own clips), at the clip's cell. */
internal fun fleetExpectedCells(fleet: PhaseEFleetArt, group: ServiceAtlasGroup): Map<String, ServicePoint> {
    val expected = linkedMapOf<String, ServicePoint>()
    for (clip in fleet.clips.values) if (clip.group == group.id) for (key in clip.keys) expected[key] = clip.cell
    return expected
}

/** N-C5 RESIDENCY: bind leased files to the capability's exact pins — paths, sizes and streamed SHA-256 of BOTH files
 *  (bounded by the pinned sizes: ≤ 8 MiB atlas JSON, ≤ decodedBytes + 1 MiB image, the reader's own limits). A changed
 *  byte under the same id and size refuses before any canonical path or cell is exposed. */
internal fun verifyPackedPins(group: ServiceAtlasGroup, directory: FileHandle) {
    require(group.files.size == 2 && group.files[0].path == group.atlasPath && group.files[1].path == group.imagePath) { "Pins do not describe ${group.id}" }
    require(group.files[0].size <= 8L * 1024 * 1024 && group.files[1].size <= group.decodedBytes + 1024 * 1024) { "Pinned sizes exceed the reader's bounds: ${group.id}" }
    for (pin in group.files) {
        val file = directory.child(pin.path)
        require(file.exists() && file.length() == pin.size) { "Leased file size differs from its pin: ${pin.path}" }
        val digest = java.security.MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(64 * 1024); var remaining = pin.size
        file.read().use { input -> while (remaining > 0) { val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt()); require(n > 0) { "Leased file ended early: ${pin.path}" }; digest.update(buffer, 0, n); remaining -= n }; require(input.read() < 0) { "Leased file longer than its pin: ${pin.path}" } }
        require(digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) } == pin.sha256) { "Leased bytes differ from the capability pin: ${pin.path}" }
    }
}

/** The minimal reader seam (N-C5 RESIDENCY): the SAME packed-format, size, PNG header, geometry and overlap checks
 *  as before, against an explicit expected-cell inventory, so accepted service and fleet inventories share ONE
 *  reader and no second decoder exists. */
internal fun readPackedAtlas(expected: Map<String, ServicePoint>, group: ServiceAtlasGroup, directory: FileHandle,
    decode: (FileHandle) -> ServiceTexturePixels): ServicePackedAtlas {
    require(expected.isNotEmpty()) { "Nothing is expected in ${group.id}" }
    val json = directory.child(group.atlasPath); val image = directory.child(group.imagePath)
    require(json.length() == group.files.first().size && image.length() == group.files.last().size)
    // Encoded metadata and PNG container overhead are bounded before allocation.
    require(json.length() <= 8L * 1024 * 1024 && image.length() <= group.decodedBytes + 1024 * 1024)
    val root = JsonReader().parse(json)
    val pages = requireNotNull(root.get("textures")); require(pages.isArray && pages.size == 1)
    val page = pages.first(); require(page.getString("image") == image.name() && page.getString("format") == "RGBA8888")
    fun integer(value: com.badlogic.gdx.utils.JsonValue?): Int {
        require(value != null && value.isNumber && value.asDouble().isFinite())
        val n = value.asDouble(); require(n >= 0 && n <= Int.MAX_VALUE && n % 1 == 0.0); return n.toInt()
    }
    require(integer(page.get("scale")) == 1)
    val width = integer(page.get("size").get("w")); val height = integer(page.get("size").get("h"))
    require(width in 1..4096 && height in 1..4096 && width.toLong() * height * 4 == group.decodedBytes)
    val header = ByteArray(29); image.read().use { input -> java.io.DataInputStream(input).readFully(header) }
    require(header.take(8).toByteArray().contentEquals(byteArrayOf(-119,80,78,71,13,10,26,10)))
    require(String(header,12,4,Charsets.US_ASCII) == "IHDR" && ByteBuffer.wrap(header,8,4).int == 13)
    require(ByteBuffer.wrap(header,16,4).int == width && ByteBuffer.wrap(header,20,4).int == height)
    require(header[24].toInt() == 8 && header[25].toInt() == 6 && header[26].toInt() == 0 && header[27].toInt() == 0 && header[28].toInt() == 0)
    val rows = requireNotNull(page.get("frames")); require(rows.isArray && rows.size == expected.size)
    val texture = image.file().canonicalPath; val cells = linkedMapOf<String, ServicePackedCell>()
    for (row in rows) {
        val key = row.getString("filename"); val size = requireNotNull(expected[key]); require(key !in cells)
        require(row.get("rotated")?.isBoolean == true && !row.getBoolean("rotated"))
        require(row.get("trimmed")?.isBoolean == true && !row.getBoolean("trimmed"))
        val rect = row.get("frame"); val x = integer(rect.get("x")); val y = integer(rect.get("y"))
        val w = integer(rect.get("w")); val h = integer(rect.get("h"))
        require(w.toFloat() == size.x && h.toFloat() == size.y && x.toLong()+w <= width && y.toLong()+h <= height)
        require(integer(row.get("sourceSize").get("w")) == w && integer(row.get("sourceSize").get("h")) == h)
        val trim = row.get("spriteSourceSize")
        require(integer(trim.get("x")) == 0 && integer(trim.get("y")) == 0 && integer(trim.get("w")) == w && integer(trim.get("h")) == h)
        require(cells.values.none { cell -> x < cell.x + cell.width && x + w > cell.x && y < cell.y + cell.height && y + h > cell.y })
        cells[key] = ServicePackedCell(texture,x,y,w,h)
    }
    val pixels=decode(image)
    try {
        require(pixels.data.isPrepared && pixels.data.isManaged && !pixels.data.disposePixmap())
        require(pixels.data.width == width && pixels.data.height == height && pixels.data.format == Pixmap.Format.RGBA8888)
        return ServicePackedAtlas(json.file().canonicalPath, texture, image, Collections.unmodifiableMap(cells),pixels)
    } catch (error: Exception) { pixels.close(); throw error }
}
