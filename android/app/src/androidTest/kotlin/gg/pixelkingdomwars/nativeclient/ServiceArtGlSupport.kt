package gg.pixelkingdomwars.nativeclient

import com.badlogic.gdx.files.FileHandle
import gg.pixelkingdomwars.nativeclient.content.ContentFile
import gg.pixelkingdomwars.nativeclient.content.ContentManifest
import gg.pixelkingdomwars.nativeclient.content.ContentStore
import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.FilterInputStream
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal fun serviceGlHash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** Synthetic Home response only. Positions and long-lived job timestamps are test
 * geometry, not copied game tuning or a server/gameplay acceptance fixture. */
internal class ServiceArtGlHome(private val catalogue: JsonObject, private val render: JsonObject) {
    val types = listOf("workshop", "lodge", "market", "harvester", "berth")
    private val plot = PlotGeometry.from(catalogue)
    private val center = (plot.min + plot.max) / 2
    val visual = render.getValue("ground").jsonObject.getValue("defaultVisual").jsonObject
    val realms = render.getValue("ground").jsonObject.getValue("realms").jsonArray.map { it.jsonPrimitive.content }
    val firstRealm = visual.getValue("realmId").jsonPrimitive.content
    val otherRealm = realms.first { it != firstRealm }
    fun id(index: Int) = "00000000-0000-4000-8000-${index.toString().padStart(12, '0')}"
    fun response(enabled: Boolean? = true, state: String = "idle", berth: String? = "away", knownBerth: Boolean = true,
                 realm: String? = firstRealm, construction: Boolean = false, upgrade: Boolean = false,
                 base: Int = 90, refresh: Boolean = false): JsonObject = buildJsonObject {
        put("baseId", id(base)); put("player", buildJsonObject { put("keepLevel", 1) })
        put("claim", buildJsonObject { put("min", plot.min); put("max", plot.max) })
        put("buildings", buildJsonArray {
            for ((index, type) in types.withIndex()) add(buildJsonObject {
                put("id", id(index + 1)); put("type", type); put("level", 1)
                put("tx", center - 7 + index * 3); put("ty", center + 2)
                put("underConstruction", construction && type == "workshop")
            })
            // Existing bodies give the reviewer real scale/depth references.
            for ((index, type) in listOf("keep", "clanhall").withIndex()) {
                check(render.getValue("entries").jsonArray.any { it.jsonObject["type"] == JsonPrimitive(type) && it.jsonObject["level"] == JsonPrimitive(1) })
                add(buildJsonObject {
                    put("id", id(index + 10)); put("type", type); put("level", 1)
                    put("tx", center - 5 + index * 7 + if(refresh && index == 1) 1 else 0); put("ty", center - 5)
                })
            }
        })
        put("jobs", buildJsonArray {
            if (construction || upgrade) add(buildJsonObject {
                put("id", id(30)); put("kind", if(construction) "build" else "upgrade"); put("buildingId", id(1))
                put("startedAt", "2000-01-01T00:00:00Z"); put("finishesAt", "2099-01-01T00:00:00Z")
            })
        })
        put("features", buildJsonObject {
            if (enabled != null) put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", enabled) })
            put("phaseEBuildings", buildJsonObject { put("version", 1); put("enabledTypes", buildJsonArray {}) })
        })
        put("serviceActivity", buildJsonObject {
            put("version", 1); put("services", buildJsonArray {
                types.take(4).forEachIndexed { index, type -> add(buildJsonObject {
                    put("buildingId", id(index + 1))
                    put("state", if(type == "market" || state == "ready" && type != "workshop") "idle" else state)
                }) }
            })
        })
        if (knownBerth) put("servicePresentation", buildJsonObject {
            put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
                put("buildingId", id(5)); put("installation", berth?.let { buildJsonObject { put("family", "starter"); put("presence", it) } } ?: JsonNull)
            }) })
        })
        if (realm != null) put("visualContext", JsonObject(visual + ("realmId" to JsonPrimitive(realm))))
    }
}

/** Test-only offline provider. Each selected two-file group goes through the real
 * ContentStore verifier/immutable generation/lease. Candidate files and the core
 * manifest are never edited, and neither this root nor its receipts are app cache. */
internal class ServiceArtGlSource(private val candidate: File, private val root: File,
    private val manifest: NativeContentManifest, private val art: PhaseEServiceArt,
    private val unavailable: Set<String> = emptySet()) : ServiceAssetSource {
    private val current = AtomicBoolean(true)
    private val epoch = AtomicInteger()
    private val stores = ConcurrentHashMap<String, ContentStore>()
    private val releases = Executors.newSingleThreadExecutor()
    val requested = ConcurrentHashMap.newKeySet<String>()
    val activeLeases = AtomicInteger()
    val activeAcquires = AtomicInteger()
    val acquired = AtomicInteger()
    val released = AtomicInteger()
    init {
        art.groups.values.forEach { group -> group.files.forEach { pin ->
            val original = manifest.files.single { it.path == pin.path }
            check(original.tier == "optional" && original.sha256 == pin.sha256 && original.size == pin.size)
        } }
    }
    override fun isCurrent() = current.get()
    fun retire() { current.set(false); cancelPending() }
    override fun cancelPending() { epoch.incrementAndGet() }
    override fun acquire(group: String, checkpoint: () -> Unit): ServiceAssetLease {
        activeAcquires.incrementAndGet()
        try { return acquireOwned(group, checkpoint) } finally { activeAcquires.decrementAndGet() }
    }
    private fun acquireOwned(group: String, checkpoint: () -> Unit): ServiceAssetLease {
        val expected = epoch.get()
        fun checkCurrent() { checkpoint(); if (!isCurrent() || epoch.get() != expected) throw CancellationException() }
        checkCurrent(); val descriptor = art.groups.getValue(group); requested.add(group)
        check(group !in unavailable) { "Intentionally unavailable optional fixture group" }
        val files = descriptor.files.map { ContentFile(it.path, it.sha256, it.size) }
        val version = serviceGlHash(files.joinToString("\n") { "${it.path}:${it.size}:${it.sha256}" }.toByteArray())
        val receipt = ContentManifest(1, manifest.sourceCommit, version, files)
        val store = stores.computeIfAbsent(group) { ContentStore(File(root, group), verifier = "service-gl") }
        store.install(receipt) { entry ->
            checkCurrent()
            val file = serviceGlFile(candidate, entry.path)
            object : FilterInputStream(file.inputStream()) {
                override fun read(): Int { checkCurrent(); return super.read().also { checkCurrent() } }
                override fun read(b: ByteArray, off: Int, len: Int): Int { checkCurrent(); return super.read(b, off, len).also { checkCurrent() } }
            }
        }
        checkCurrent(); val lease = store.retain(version)
        try { checkCurrent() } catch (error: Throwable) { lease.close(); throw error }
        activeLeases.incrementAndGet(); acquired.incrementAndGet()
        return ServiceAssetLease(FileHandle(lease.directory)) {
            releases.execute { try { lease.close() } finally { activeLeases.decrementAndGet(); released.incrementAndGet() } }
        }
    }
    fun finish() {
        check(!isCurrent() && activeLeases.get() == 0 && activeAcquires.get() == 0) { "Service GL fixture still owns renderer work" }
        releases.shutdown(); check(releases.awaitTermination(10, TimeUnit.SECONDS))
    }
}

internal fun serviceGlFile(root: File, path: String): File = File(root, path).also {
    require(!File(path).isAbsolute && path.split('/').none { part -> part.isEmpty() || part == "." || part == ".." })
    require(it.canonicalPath.startsWith(root.canonicalPath + File.separator) && it.isFile)
}

/** Exact canonical SIM18 events. Only the candidate's default realm is an explicit
 * TEST presentation context; no installation or historical server fact is added. */
internal class ServiceArtGlBattle(bytes: ByteArray, catalogue: JsonObject, render: JsonObject,
    private val art: PhaseEServiceArt) {
    val raw: JsonObject
    val scene: BattleScene
    val provenance: JsonObject
    private val model: BattleVisualModel
    private val health: BuildingHealthVisualModel
    private val hitPolicy: HitFeedbackPolicy
    private val hitEvents: List<Pair<Int, JsonObject>>
    val liveBeforeTick = 44f
    val liveHitTick = 45f
    val liveOverlapTick = 47f
    val liveNextHitTick = 50f
    val liveFirstExpiryTick: Float
    val liveExpiryTick: Float
    val damagedTick: Float
    val collapseTick: Float
    val middleCollapseTick: Float
    val rubbleTick: Float
    val endTick: Float
    init {
        require(serviceGlHash(bytes) == "b9b793f619a01a0f7f2d6b6ee2d07ed82ac7390893fe6d9e5bc668ae31596907")
        val fixture = Json.parseToJsonElement(bytes.decodeToString()).jsonObject
        provenance = fixture.getValue("provenance").jsonObject
        val original = fixture.getValue("replay").jsonObject
        val events = original.getValue("events").jsonArray
        check(original["simVersion"] == JsonPrimitive(18) && catalogue["simVersion"] == original["simVersion"])
        check("servicePresentation" !in original && "servicePresentation" !in original.getValue("snapshot").jsonObject)
        var hash = 0x811c9dc5.toInt()
        events.toString().forEach { hash = (hash xor it.code) * 0x01000193 }
        check(hash.toUInt().toString(16) == "b26e3eac" && events.size == 550)
        check(serviceGlHash(events.toString().toByteArray()) == original.getValue("timeline").jsonObject.getValue("sha256").jsonPrimitive.content)
        val visual = render.getValue("ground").jsonObject.getValue("defaultVisual")
        raw = JsonObject(original + ("visualContext" to visual))
        scene = gg.pixelkingdomwars.nativeclient.scene.SceneMapper(catalogue, render).replayScene(raw).copy(playing = false)
        check(scene.base.services.berths == null && scene.base.services.activity == null && scene.base.services.phaseEArtEnabled == null)
        check(scene.base.buildings.count { it.service != null } == 5)
        model = BattleVisualModel(scene.revision.events, scene.positionCadenceTicks, scene.summonedPositionCadenceTicks)
        health = BuildingHealthVisualModel(scene.base.buildings, scene.revision.events, render.getValue("buildingDamageThreshold").jsonPrimitive.float)
        hitPolicy = requireNotNull(HitFeedbackPolicy.parse(com.badlogic.gdx.utils.JsonReader().parse(render.getValue("hitFeedback").toString())))
        val serviceIds = scene.base.buildings.filter { it.service != null }.map { it.id }.toSet()
        hitEvents = events.mapIndexedNotNull { ordinal, value -> value.jsonObject.let { event ->
            if (event["e"] == JsonPrimitive("hit") && event["target"]?.jsonPrimitive?.content in serviceIds) ordinal to event else null
        } }
        check(hitEvents.filter { it.second.getValue("t").jsonPrimitive.float == liveHitTick }.map { it.first } == listOf(78, 79, 80, 81))
        check(health.at("lodge", liveBeforeTick)?.hp == 312L && health.at("lodge", liveHitTick)?.hp == 296L)
        liveFirstExpiryTick = liveHitTick + hitPolicy.starMs / scene.tickDurationMs
        liveExpiryTick = liveOverlapTick + hitPolicy.starMs / scene.tickDurationMs
        check(liveExpiryTick < liveNextHitTick && hitSamples(liveBeforeTick).isEmpty())
        collapseTick = requireNotNull(model.destroyedTick("lodge")).toFloat()
        damagedTick = events.map { it.jsonObject.getValue("t").jsonPrimitive.int.toFloat() }.distinct().first {
            it < collapseTick && health.at("lodge", it)?.damagedSinceTick != null
        }
        val collapse = requireNotNull(selectServicePlan(art, scene.base.buildings.single { it.id == "lodge" },
            scene.base.visual?.realmId, scene.base.services, true, false, combat = ServiceCombatState.COLLAPSE).plan)
        check(collapse.groups == setOf("pe_lodge_t1", "pe_workshop_t1"))
        check(collapse.terminal!!.layers.single().frames == listOf("pe_workshop_t1_rubble_f1"))
        val duration = collapse.layers.maxOf { clip(it).durationMs }
        middleCollapseTick = collapseTick + duration / scene.tickDurationMs / 2
        rubbleTick = collapseTick + duration / scene.tickDurationMs + 1
        endTick = events.last().jsonObject.getValue("t").jsonPrimitive.int.toFloat()
        check(damagedTick < collapseTick && rubbleTick < requireNotNull(model.destroyedTick("workshop")))
        check(frames(collapseTick, false).getValue("lodge") != frames(middleCollapseTick, false).getValue("lodge"))
        check(frames(rubbleTick, false).getValue("lodge") == listOf("pe_workshop_t1_rubble_f1"))
        check(frames(collapseTick, true).getValue("lodge") == listOf("pe_workshop_t1_rubble_f1"))
        check("berth" !in frames(0f, false))
    }
    private fun clip(layer: ServiceLayer) = AuthoredClip("fixture-observation", layer.group, listOf(layer.frames),
        listOf("s"), layer.fps, layer.origin.x, layer.origin.y, layer.scale, layer.cell.x, layer.cell.y, layer.loop, null, emptyMap())
    fun at(tick: Float) = scene.copy(playheadTick = tick, playing = false)
    /** Expected authored keys in the renderer's stable south-edge depth order.
     * Observed successful GL draws must match the aggregate, not just this plan. */
    fun frames(tick: Float, reduced: Boolean): Map<String, List<String>> = buildMap {
        for (building in scene.base.buildings.filter { it.service != null }.sortedBy { it.tileY + it.footprintHeight }) {
            val destroyed = model.destroyedTick(building.id)?.takeIf { tick >= it }
            val state = when {
                destroyed != null -> ServiceCombatState.COLLAPSE
                health.at(building.id, tick)?.damagedSinceTick != null -> ServiceCombatState.DAMAGED
                else -> ServiceCombatState.IDLE
            }
            var plan = selectServicePlan(art, building, scene.base.visual?.realmId, scene.base.services, true, reduced, combat = state).plan ?: continue
            var age = (tick - (destroyed ?: 0)) * scene.tickDurationMs
            val duration = plan.layers.maxOf { clip(it).durationMs }
            plan.terminal?.let { if (age >= duration) { age -= duration; plan = it } }
            put(building.id, plan.layers.map { clip(it).frame(age, 0) })
        }
    }
    fun frameHash(tick: Float, reduced: Boolean) = frames(tick, reduced).values.flatten().fold(0) { hash, key -> 31 * hash + key.hashCode() }
    /** Independent expectation from unchanged events, authored service geometry and
     * exported feedback metadata. Actual successful draw counters/hash are separate. */
    data class HitSample(val ordinal: Int, val tick: Int, val key: String, val x: Float, val y: Float)
    fun hitSamples(tick: Float): List<HitSample> = hitEvents.mapNotNull { (ordinal, event) ->
        val at = event.getValue("t").jsonPrimitive.int
        val elapsed = tick * scene.tickDurationMs - at * scene.tickDurationMs
        if (at < liveBeforeTick || elapsed < 0 || elapsed >= hitPolicy.starMs) return@mapNotNull null
        val building = scene.base.buildings.single { it.id == event.getValue("target").jsonPrimitive.content }
        val state = if (health.afterEvent(building.id, ordinal)?.damagedSinceTick != null) ServiceCombatState.DAMAGED else ServiceCombatState.IDLE
        val layer = requireNotNull(selectServicePlan(art, building, scene.base.visual?.realmId, scene.base.services,
            true, false, combat = state).plan).layers.first()
        val x = (building.tileX + building.footprintWidth / 2) * scene.base.tilePixels
        val y = (building.tileY + building.footprintHeight) * scene.base.tilePixels -
            minOf(layer.cell.y * layer.scale * hitPolicy.buildingHeightFactor, hitPolicy.buildingLiftMax)
        val frame = hitPolicy.starFrameTimes.indexOfLast { it <= elapsed }
        HitSample(ordinal, at, hitPolicy.star.frames.single()[frame], x, y)
    }
    fun hitHash(tick: Float): Int = hitSamples(tick).fold(0) { previous, hit ->
        listOf(hit.ordinal, hit.tick, hit.key.hashCode(), hit.x.toBits(), hit.y.toBits()).fold(previous) { hash, value -> 31 * hash + value }
    }
    fun hitProof(tick: Float) = buildJsonObject {
        put("actualDrawTick", tick); put("cueFloor", liveBeforeTick); put("playbackRate", .25f)
        put("starLifetimeMs", hitPolicy.starMs); put("expiryTick", liveExpiryTick)
        put("expectedDrawHash", hitHash(tick)); put("evidence", "canonical-expected-cues-matched-to-successful-GL-draw-hash")
        put("expected", buildJsonArray { hitSamples(tick).forEach { hit -> add(buildJsonObject {
            put("ordinal", hit.ordinal); put("eventTick", hit.tick); put("frame", hit.key); put("x", hit.x); put("y", hit.y)
        }) } })
    }
    fun proof(tick: Float, reduced: Boolean) = buildJsonObject {
        put("playheadTick", tick); put("eventFnv1a", "b26e3eac"); put("eventCount", 550)
        put("frozenServicePresentation", "absent-preserved-unknown")
        put("visualContextAuthority", "explicit-test-only-candidate-default")
        put("expectedSuccessfulDrawFrameHash", frameHash(tick, reduced))
        put("frames", buildJsonObject { frames(tick, reduced).forEach { (id, keys) -> put(id, JsonArray(keys.map(::JsonPrimitive))) } })
    }
}
