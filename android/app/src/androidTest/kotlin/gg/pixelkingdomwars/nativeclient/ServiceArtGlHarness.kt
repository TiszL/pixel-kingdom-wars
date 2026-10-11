package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.AbstractComposeView
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.content.ContentFile
import gg.pixelkingdomwars.nativeclient.content.ContentManifest
import gg.pixelkingdomwars.nativeclient.content.ContentStore
import gg.pixelkingdomwars.nativeclient.content.SceneContentLeases
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.*
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import kotlinx.serialization.json.*
import java.io.Closeable
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Explicit offline candidate15 Home capture. It exercises production mapping,
 * selected verified group leases and real Android/GL decoding, but does not admit
 * a release pack, contact an account/provider, or prove physical Seeker behavior. */
internal object ServiceArtGlHarness {
    private fun surfaces(view: View): List<SurfaceView> = when (view) {
        is SurfaceView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { surfaces(view.getChildAt(it)) }
        else -> emptyList()
    }
    fun capture(i: Instrumentation, expectedManifest: String, profile: String? = null): String {
        require(profile == null || profile == "battle")
        val battleProfile = profile == "battle"
        check(BuildConfig.DEBUG && BuildConfig.APPLICATION_ID == "gg.pixelkingdomwars.twa.debug" &&
            Build.HARDWARE == "ranchu" && BuildConfig.API_ORIGIN == "https://127.0.0.1:18443")
        require(expectedManifest.matches(Regex("[a-f0-9]{64}")))
        val candidate = File("/data/local/tmp/pkw-service-art-fixture")
        val context = i.targetContext
        val directory = File(context.noBackupFilesDir, "service-art-gl/${System.currentTimeMillis()}")
        check(directory.mkdirs())
        val records = mutableListOf<JsonObject>()
        val sources = mutableListOf<ServiceArtGlSource>()
        val frames = AtomicInteger()
        val last = AtomicReference<LocalSceneSnapshot?>()
        var activity: MainActivity? = null
        var coreLease: Closeable? = null
        var status = "running"
        var stage = "candidate-verification"
        var failureClass: String? = null
        var sourceCommit: String? = null
        var contentVersion: String? = null
        var sourceSim: Int? = null
        var coreVerified = false
        var battleProvenance: JsonObject? = null
        fun receipt() { File(directory, "receipt.json").writeText(buildJsonObject {
            put("status", status); put("stage", stage); put("failureClass", failureClass?.let(::JsonPrimitive) ?: JsonNull)
            put("manifestSha256", expectedManifest); put("sourceCommit", sourceCommit?.let(::JsonPrimitive) ?: JsonNull)
            put("contentVersion", contentVersion?.let(::JsonPrimitive) ?: JsonNull); put("candidateSimVersion", sourceSim?.let(::JsonPrimitive) ?: JsonNull)
            put("rendererContractVersion", 15); put("syntheticHomeFacts", !battleProfile); put("candidateOnly", true)
            put("coreVerified", coreVerified); put("optionalVerification", "ContentStore-on-selected-acquisition")
            put("networkRequests", 0); put("accountActions", 0)
            put("packRepinned", false); put("combatFixture", battleProfile); put("physicalSeekerAcceptance", false)
            put("captures", JsonArray(records))
            battleProvenance?.let { put("battleProvenance", it) }
            put("sources", buildJsonArray { sources.forEach { source -> add(buildJsonObject {
                put("requestedGroups", JsonArray(source.requested.sorted().map(::JsonPrimitive)))
                put("acquired", source.acquired.get()); put("released", source.released.get()); put("activeLeases", source.activeLeases.get())
                put("activeAcquires", source.activeAcquires.get())
            }) } })
        }.toString()) }
        fun <T> main(block: () -> T): T { val value = AtomicReference<T>(); i.runOnMainSync { value.set(block()) }; return value.get() }
        fun await(label: String, condition: () -> Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(50)
            while (System.nanoTime() < deadline) { if (condition()) return; Thread.sleep(20) }
            error("Service GL wait failed: $label")
        }
        try {
            val manifestFile = serviceGlFile(candidate, "manifest.json")
            require(manifestFile.length() in 1..(16L * 1024 * 1024))
            val manifestBytes = manifestFile.readBytes()
            check(serviceGlHash(manifestBytes) == expectedManifest)
            val manifestRaw = Json.parseToJsonElement(manifestBytes.decodeToString()).jsonObject
            val sim = manifestRaw.getValue("simVersion").jsonPrimitive.int
            val manifest = nativeContentManifest(manifestRaw, sim)
            require(manifestRaw.getValue("rendererContractVersion") == JsonPrimitive(15))
            sourceCommit = manifest.sourceCommit; contentVersion = manifest.contentVersion; sourceSim = sim
            // SceneHost admits downloaded generations only beneath this exact
            // origin root. Claim it before starting MainActivity, on a fresh
            // disposable emulator: an existing root is a refusal, never reset.
            // Thus install has no existing generation/pointer to prune or replace.
            val coreRoot = File(context.noBackupFilesDir, storageNamespace(BuildConfig.API_ORIGIN, "content-updates"))
            check(coreRoot.mkdir()) { "Service GL requires a fresh, absent content-updates root" }
            check(coreRoot.canonicalFile.parentFile == context.noBackupFilesDir.canonicalFile)
            val store = ContentStore(coreRoot, verifier = "service-gl-${BuildConfig.VERSION_CODE}")
            val coreManifest = ContentManifest(1, manifest.sourceCommit, manifest.contentVersion,
                manifest.files.map { ContentFile(it.path, it.sha256, it.size, it.tier) })
            val assets = store.install(coreManifest) { serviceGlFile(candidate, it.path).inputStream() }
            val retained = store.retain(manifest.contentVersion)
            val sceneLease = try { SceneContentLeases.acquire(coreRoot, assets) }
                catch (failure: Throwable) { retained.close(); throw failure }
            // Never activate a pointer. Keep both owners through GL disposal;
            // SceneHost takes its normal additional lease for the same generation.
            coreLease = Closeable { try { sceneLease.close() } finally { retained.close() } }
            fun read(name: String): JsonObject {
                val file = serviceGlFile(assets, name); require(file.length() <= 32L * 1024 * 1024)
                return Json.parseToJsonElement(file.readText()).jsonObject
            }
            val catalogue = read("catalogue.json"); val render = read("render-catalog.json")
            check(catalogue["sourceCommit"] == JsonPrimitive(manifest.sourceCommit) && catalogue["simVersion"] == JsonPrimitive(sim))
            check(render["rendererContractVersion"] == JsonPrimitive(15))
            val art = requireNotNull(RendererCatalogue.serviceArt(JsonReader().parse(render.toString())))
            coreVerified = true
            val fixture = ServiceArtGlHome(catalogue, render)
            val mapper = SceneMapper(catalogue, render)
            val battleFixture = if (battleProfile) ServiceArtGlBattle(i.context.assets.open("service-art/phase-e-structures.json").use { it.readBytes() }, catalogue, render, art) else null
            battleProvenance = battleFixture?.provenance
            val activeBattle = mutableStateOf(battleFixture?.at(0f))
            val playbackKey = mutableIntStateOf(0)
            val playback = AtomicReference<BattlePlaybackFrame?>()
            val scene = mutableStateOf(battleFixture?.scene?.base ?: mapper.baseScene(fixture.response(enabled = false)))
            check(scene.value.buildings.count { it.service != null } == 5)
            val reduced = mutableStateOf(false)
            val cameraStep = catalogue.getValue("constants").jsonObject.getValue("RAID_CAMERA").jsonObject.getValue("zoomStep").jsonPrimitive.float
            val controls = SceneCameraControls(cameraStep)
            fun source(missing: Set<String> = emptySet()) = ServiceArtGlSource(candidate, File(directory, "groups-${sources.size}"), manifest, art, missing)
                .also { sources += it }
            val stale = source().also { it.retire() }
            val good = source()
            val workshop = scene.value.buildings.single { it.type == "workshop" }
            val workshopGroup = requireNotNull(selectServicePlan(art, workshop, fixture.firstRealm, scene.value.services, true, false).plan).groups.single()
            val missing = source(setOf(workshopGroup))
            activity = i.startActivitySync(Intent(context, MainActivity::class.java).putExtra("preview", "base")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            val host = activity
            repeat(3) {
                val frame = CountDownLatch(1); main { Choreographer.getInstance().postFrameCallback { frame.countDown() } }
                check(frame.await(12, TimeUnit.SECONDS))
            }
            main {
                val container = host.findViewById<ViewGroup>(android.R.id.content)
                (0 until container.childCount).map { container.getChildAt(it) }.filterIsInstance<AbstractComposeView>().forEach { it.disposeComposition() }
                container.removeAllViews()
            }; i.waitForIdleSync()
            val sceneHost = SceneHost(host)
            val owner = Any()
            val observer = object : LocalSceneDiagnostics {
                override val observeServiceFrames = true
                override fun frameStarted() {}
                override fun frameCompleted() { frames.incrementAndGet() }
                override fun state(snapshot: LocalSceneSnapshot) { last.set(snapshot) }
            }
            main {
                sceneHost.serviceSource(owner, assets, good)
                host.setContent { PkwTheme { CompositionLocalProvider(LocalSceneHost provides sceneHost,
                    LocalSceneObserver provides observer, LocalReducedMotion provides reduced.value) {
                    SceneSurface(assets, scene.value, Modifier.fillMaxSize(), battle = activeBattle.value, playbackKey = playbackKey.intValue,
                        retainedPlaybackRate = activeBattle.value?.rate,
                        onFrame = { playback.set(it) }, cameraControls = controls)
                } } }
            }
            fun settled(drawn: Int, outlines: Int, afterRevision: Long? = null) {
                var firstFrame: Int? = null
                await(stage) {
                    val snapshot = last.get()
                    val matches = snapshot?.kind == LocalSceneKind.BASE && snapshot.queueDepth == 0 && snapshot.pendingWallUploads == 0 &&
                        snapshot.serviceDrawn == drawn && snapshot.serviceOutlines == outlines &&
                        (afterRevision == null || snapshot.serviceSceneRevision > afterRevision)
                    if (!matches) firstFrame = null else if (firstFrame == null) firstFrame = frames.get()
                    matches && frames.get() - (firstFrame ?: frames.get()) >= 6
                }
            }
            fun workshopReadyProof(): JsonObject {
                val current = scene.value
                val building = current.buildings.single { it.type == "workshop" }
                check(building.level == 1 && building.service?.tier == 1)
                val activities = requireNotNull(current.services.activity)
                check(activities.single { it.buildingId == building.id }.state == RenderServiceState.READY)
                check(activities.filter { it.buildingId != building.id }.all { it.state == RenderServiceState.IDLE })
                val authored = art.appearances.getValue("workshop-t1").states.getValue("ready") as ServiceArtState.Still
                check(authored.key == "pe_workshop_t1_ready_f1")
                val selection = selectServicePlan(art, building, current.visual?.realmId, current.services, true, reduced.value)
                val plan = requireNotNull(selection.plan)
                check(selection.status == "Ready" && plan.signature == "workshop-t1:ready:${reduced.value}")
                check(plan.layers.single().frames == listOf(authored.key) && plan.groups == setOf("pe_workshop_t1"))
                val snapshot = requireNotNull(last.get())
                check(snapshot.serviceDrawn == 5 && snapshot.serviceLayers == 6 && snapshot.serviceOutlines == 0)
                // This is selected-plan identity plus observed GL counts, not a
                // claim that the aggregate frame hash identifies individual pixels.
                return buildJsonObject {
                    put("buildingId", building.id); put("state", "ready"); put("frame", authored.key)
                    put("planSignature", plan.signature); put("reducedMotion", reduced.value)
                    put("expectedSceneLayers", 6); put("observedSceneLayers", snapshot.serviceLayers)
                    put("identityEvidence", "canonical-selected-plan")
                }
            }
            fun capture(name: String, readyProof: JsonObject? = null, battleProof: JsonObject? = null, hitProof: JsonObject? = null) {
                val snapshot = requireNotNull(last.get())
                val surface = main { surfaces(host.window.decorView).single() }
                val bitmap = Bitmap.createBitmap(surface.width, surface.height, Bitmap.Config.ARGB_8888)
                val latch = CountDownLatch(1); var result = -1
                PixelCopy.request(surface, bitmap, { result = it; latch.countDown() }, Handler(Looper.getMainLooper()))
                check(latch.await(12, TimeUnit.SECONDS) && result == PixelCopy.SUCCESS)
                try {
                    val file = File(directory, "$name.png")
                    check(file.createNewFile()) { "Capture identity already exists" }
                    file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
                    records += buildJsonObject {
                        put("case", name); put("path", file.name); put("sha256", serviceGlHash(file.readBytes()))
                        put("width", bitmap.width); put("height", bitmap.height); put("cameraZoom", snapshot.cameraZoom)
                        put("reducedMotion", reduced.value); put("serviceDrawn", snapshot.serviceDrawn)
                        put("serviceLayers", snapshot.serviceLayers); put("serviceFrameHash", snapshot.serviceFrameHash)
                        put("serviceOutlines", snapshot.serviceOutlines); put("selectedResidentGroups", snapshot.serviceGroups)
                        put("sceneRevision", snapshot.serviceSceneRevision); put("textureMiB", snapshot.textureMiB)
                        put("queueDepth", snapshot.queueDepth); put("completedFrames", frames.get())
                        if (battleProfile) {
                            put("serviceHitDrawn", snapshot.serviceHitDrawn); put("serviceHitHash", snapshot.serviceHitHash)
                            put("serviceHitTick", snapshot.serviceHitTick)
                        }
                        if (readyProof != null) put("workshopReady", readyProof)
                        if (battleProof != null) put("battle", battleProof)
                        if (hitProof != null) put("serviceHits", hitProof)
                    }
                } finally { bitmap.recycle() }; receipt()
            }
            fun update(name: String, raw: JsonObject, drawn: Int, outlines: Int, checkWorkshopReady: Boolean = false) {
                stage = name; val previous = last.get()?.serviceSceneRevision
                val mapped = mapper.baseScene(raw)
                main { scene.value = mapped }
                settled(drawn, outlines, previous); capture(name, if (checkWorkshopReady) workshopReadyProof() else null)
            }
            fun bind(source: ServiceAssetSource, enabled: Boolean) {
                main { sceneHost.serviceSource(owner, assets, source); sceneHost.servicePermission(owner, enabled) }
            }
            if (battleFixture != null) {
                fun battleSettled(tick: Float, enabled: Boolean, after: Long? = null) {
                    var first: Int? = null
                    val expected = if (enabled) battleFixture.frameHash(tick, reduced.value) else 0
                    await(stage) {
                        val snapshot = last.get(); val frame = playback.get()
                        val matches = snapshot?.kind == LocalSceneKind.BATTLE && snapshot.queueDepth == 0 && snapshot.pendingWallUploads == 0 &&
                            snapshot.serviceDrawn == (if (enabled) 4 else 0) && snapshot.serviceLayers == (if (enabled) 4 else 0) &&
                            snapshot.serviceOutlines == (if (enabled) 1 else 5) && snapshot.serviceFrameHash == expected &&
                            frame?.raidId == battleFixture.scene.revision.raidId && frame.revision == battleFixture.scene.revision.revision &&
                            kotlin.math.abs(frame.playheadTick - tick) < .001f && (after == null || snapshot.serviceSceneRevision > after)
                        if (!matches) first = null else if (first == null) first = frames.get()
                        matches && frames.get() - (first ?: frames.get()) >= 6
                    }
                }
                fun battleStage(name: String, tick: Float, reduce: Boolean = false, enabled: Boolean = true) {
                    stage = name
                    val previous = last.get()?.serviceSceneRevision.takeIf { reduced.value != reduce }
                    main {
                        reduced.value = reduce
                        activeBattle.value = battleFixture.at(tick); scene.value = battleFixture.scene.base
                        playbackKey.intValue++
                        sceneHost.servicePermission(owner, enabled)
                    }
                    battleSettled(tick, enabled, previous)
                    capture(stage, battleProof = battleFixture.proof(tick, reduce))
                }
                battleStage("battle-01-permission-off", 0f, enabled = false)
                battleStage("battle-02-idle-history-unknown", 0f)
                // A cold seek alone cannot prove emission-bound live hit geometry.
                // Use real playback and its pause-without-seek path; no injected
                // events or synthetic clock replaces the canonical timeline.
                stage = "battle-live-01-before-hit"
                main {
                    activeBattle.value = battleFixture.at(battleFixture.liveBeforeTick).copy(rate = .25f)
                    playbackKey.intValue++
                }
                battleSettled(battleFixture.liveBeforeTick, true)
                check(last.get()!!.serviceHitDrawn == 0 && last.get()!!.serviceHitHash == 0)
                capture(stage, battleProof = battleFixture.proof(battleFixture.liveBeforeTick, false),
                    hitProof = battleFixture.hitProof(battleFixture.liveBeforeTick))
                fun playing(value: Boolean) = main {
                    activeBattle.value = requireNotNull(activeBattle.value).copy(playing = value, retainPlaybackTick = true)
                    playbackKey.intValue++
                }
                fun matchesHit(snapshot: LocalSceneSnapshot?, from: Float, until: Float, count: Int): Boolean {
                    if (snapshot == null || snapshot.kind != LocalSceneKind.BATTLE || snapshot.queueDepth != 0 ||
                        snapshot.pendingWallUploads != 0 || snapshot.serviceDrawn != 4 || snapshot.serviceLayers != 4 ||
                        snapshot.serviceOutlines != 1 || snapshot.serviceHitTick < from || snapshot.serviceHitTick >= until) return false
                    val tick = snapshot.serviceHitTick
                    return snapshot.serviceHitDrawn == count && battleFixture.hitSamples(tick).size == count &&
                        snapshot.serviceHitHash == battleFixture.hitHash(tick) && snapshot.serviceFrameHash == battleFixture.frameHash(tick, false)
                }
                fun pauseHit(from: Float, until: Float, count: Int): LocalSceneSnapshot {
                    await(stage) { matchesHit(last.get(), from, until, count) }
                    playing(false)
                    var stableTick: Float? = null; var first: Int? = null
                    await("$stage paused completed frames") {
                        val snapshot = last.get(); val tick = snapshot?.serviceHitTick
                        val frame = playback.get()
                        val matches = matchesHit(snapshot, from, until, count) && frame?.raidId == battleFixture.scene.revision.raidId &&
                            frame.revision == battleFixture.scene.revision.revision && tick != null && kotlin.math.abs(frame.playheadTick - tick) < .001f
                        if (!matches || tick != stableTick) { first = null; stableTick = tick }
                        if (matches && first == null) first = frames.get()
                        matches && frames.get() - (first ?: frames.get()) >= 6
                    }
                    return requireNotNull(last.get())
                }
                stage = "battle-live-02-admitted-hit"; playing(true)
                val admitted = pauseHit(battleFixture.liveHitTick, battleFixture.liveHitTick + 1, 4)
                check(battleFixture.hitSamples(admitted.serviceHitTick).map { it.ordinal } == listOf(78, 79, 80, 81))
                capture(stage, battleProof = battleFixture.proof(admitted.serviceHitTick, false),
                    hitProof = battleFixture.hitProof(admitted.serviceHitTick))
                stage = "battle-live-03-expired-hit"; playing(true)
                var overlap: LocalSceneSnapshot? = null
                await("canonical later hits retain original emitted geometry") {
                    last.get()?.takeIf { matchesHit(it, battleFixture.liveOverlapTick, battleFixture.liveFirstExpiryTick, 6) }
                        ?.also { overlap = it } != null
                }
                val expired = pauseHit(battleFixture.liveExpiryTick, battleFixture.liveNextHitTick, 0)
                val overlapFrame = requireNotNull(overlap)
                capture(stage, battleProof = battleFixture.proof(expired.serviceHitTick, false),
                    hitProof = JsonObject(battleFixture.hitProof(expired.serviceHitTick) + ("observedOverlap" to buildJsonObject {
                        put("actualDrawTick", overlapFrame.serviceHitTick); put("actualDrawn", overlapFrame.serviceHitDrawn)
                        put("actualHash", overlapFrame.serviceHitHash); put("expected", battleFixture.hitProof(overlapFrame.serviceHitTick))
                    })))
                battleStage("battle-03-canonical-damage", battleFixture.damagedTick)
                battleStage("battle-04-collapse-first", battleFixture.collapseTick)
                battleStage("battle-05-collapse-advanced", battleFixture.middleCollapseTick)
                battleStage("battle-06-cross-group-rubble", battleFixture.rubbleTick)
                battleStage("battle-07-reduced-damage", battleFixture.damagedTick, reduce = true)
                battleStage("battle-08-reduced-destruction", battleFixture.collapseTick, reduce = true)
                battleStage("battle-09-seek-back-idle", 0f)
                battleStage("battle-10-terminal", battleFixture.endTick)
                battleStage("battle-11-permission-revoked", battleFixture.endTick, enabled = false)
                battleStage("battle-12-permission-restored", battleFixture.endTick)
                // Leave and re-enter through the real surface host. Existing Home
                // acceptance is not repeated; this only retires the battle owner.
                stage = "battle-13-exit"
                main { sceneHost.servicePermission(owner, false); activeBattle.value = null; scene.value = mapper.baseScene(fixture.response(enabled = false)) }
                settled(0, 5); capture(stage)
                battleStage("battle-14-reentered-rubble", battleFixture.rubbleTick)
                val required = battleFixture.scene.base.buildings.filter { it.service != null }.flatMap { building ->
                    ServiceCombatState.entries.flatMap { state -> selectServicePlan(art, building, battleFixture.scene.base.visual?.realmId,
                        battleFixture.scene.base.services, true, false, combat = state).plan?.groups.orEmpty() }
                }.toSet()
                check(good.requested == required && required.none { it.startsWith("pe_fleet") })
                stage = "battle-15-source-retired"; good.retire()
                battleSettled(battleFixture.rubbleTick, false); capture(stage, battleProof = battleFixture.proof(battleFixture.rubbleTick, false))
            } else {
            stage = "01-live-flag-off"; settled(0, 5); capture(stage)
            bind(good, true)
            update("02-base-capability-absent", fixture.response(enabled = null), 0, 5)
            update("03-base-capability-off", fixture.response(enabled = false), 0, 5)
            bind(stale, true)
            update("04-stale-source", fixture.response(), 0, 5)
            stage = "05-positive-idle"; bind(good, true); settled(5, 0); capture(stage)
            val idleLayers = last.get()!!.serviceLayers
            check(good.requested == scene.value.buildings.flatMap { building ->
                selectServicePlan(art, building, scene.value.visual?.realmId, scene.value.services, true, false).plan?.groups.orEmpty()
            }.toSet()) { "Unselected optional groups were acquired" }
            stage = "05b-live-permission-revoked"
            main { sceneHost.servicePermission(owner, false) }; settled(0, 5); capture(stage)
            stage = "05c-live-permission-restored"
            main { sceneHost.servicePermission(owner, true) }; settled(5, 0); capture(stage)
            val priorOrientation = main { host.requestedOrientation }
            try {
                stage = "05d-landscape-scale-references"
                main { host.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
                await("landscape service surface") { last.get()?.let { it.viewportWidth > it.viewportHeight } == true }
                controls.fit(); settled(5, 0); capture(stage)
            } finally { main { host.requestedOrientation = priorOrientation } }
            stage = "06-missing-workshop-pair"; bind(missing, true); settled(4, 1); capture(stage)
            stage = "07-verified-pair-restored"; bind(good, true); settled(5, 0); capture(stage)
            // Hold the berth so its independent ambient loop cannot satisfy the
            // working-service motion assertion below.
            update("08-working", fixture.response(state = "working", berth = "occupied"), 5, 0)
            val moving = last.get()!!.serviceFrameHash
            await("authored working frames advance") { last.get()?.serviceFrameHash != moving }
            capture("09-working-advanced")
            update("10-same-base-refresh", fixture.response(state = "working", berth = "occupied", refresh = true), 5, 0)
            stage = "11-reduced-working"; val beforeReduced = last.get()!!.serviceSceneRevision
            main { reduced.value = true }; settled(5, 0, beforeReduced); capture(stage)
            val held = last.get()!!.serviceFrameHash; Thread.sleep(450)
            check(last.get()!!.serviceFrameHash == held) { "Reduced service motion did not hold a neutral frame" }
            // This fixture marks only Workshop READY. Its authored READY is one
            // still in either motion mode; Lodge/Market craft-success is unrelated.
            update("12-reduced-workshop-ready", fixture.response(state = "ready"), 5, 0, checkWorkshopReady = true)
            check(idleLayers == 6)
            stage = "13-workshop-ready"; val beforeReady = last.get()!!.serviceSceneRevision
            main { reduced.value = false }; settled(5, 0, beforeReady)
            capture(stage, workshopReadyProof())
            update("14-construction-outline", fixture.response(construction = true), 4, 1)
            update("15-upgrade-current-tier", fixture.response(state = "working", upgrade = true), 5, 0)
            check(scene.value.buildings.single { it.type == "workshop" }.level == 1)
            update("16-no-current-realm", fixture.response(realm = null), 4, 1)
            update("17-current-realm-change", fixture.response(realm = fixture.otherRealm), 5, 0)
            // The vehicle-free scene draws the intact Berth for occupied, empty and unknown projections.
            update("18-berth-occupied-held", fixture.response(berth = "occupied"), 5, 0)
            update("19-berth-empty-held", fixture.response(berth = null), 5, 0)
            update("20-berth-history-unknown", fixture.response(knownBerth = false), 5, 0)
            update("21-new-base-revoked", fixture.response(enabled = false, base = 91), 0, 5)
            update("22-current-base-restored", fixture.response(base = 91), 5, 0)
            val beforeRetirement = last.get()!!.serviceSceneRevision
            stage = "23-account-source-retired"; good.retire(); settled(0, 5); capture(stage)
            check(last.get()!!.serviceSceneRevision == beforeRetirement) { "Retirement proof unexpectedly required a new scene" }
            }
            check(serviceGlHash(manifestFile.readBytes()) == expectedManifest)
            status = "captured-needs-pixel-review"; receipt()
        } catch (failure: Throwable) {
            status = "failed"; failureClass = failure.javaClass.simpleName; receipt(); throw failure
        } finally {
            sources.forEach { it.retire() }
            activity?.let { host -> main { host.finishAndRemoveTask() } }; i.waitForIdleSync()
            try {
                await("renderer disposal releases selected groups") { sources.all { it.activeLeases.get() == 0 && it.activeAcquires.get() == 0 } }
                sources.forEach { it.finish() }
            } catch (cleanup: Throwable) {
                status = "failed"; stage = "lease-cleanup"; failureClass = cleanup.javaClass.simpleName; receipt(); throw cleanup
            } finally { coreLease?.close(); receipt() }
        }
        return directory.absolutePath
    }
}
