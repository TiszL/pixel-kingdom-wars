package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.InputAdapter
import com.badlogic.gdx.assets.AssetManager
import com.badlogic.gdx.assets.loaders.FileHandleResolver
import com.badlogic.gdx.assets.loaders.TextureLoader
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.OrthographicCamera
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.graphics.g2d.TextureRegion
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.glutils.PixmapTextureData
import com.badlogic.gdx.graphics.glutils.ShapeRenderer
import com.badlogic.gdx.math.Vector2
import com.badlogic.gdx.math.Vector3
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.viewport.ScreenViewport
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.Executors
import java.security.MessageDigest
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.PI

/** A native GL surface. The app owns network/lifecycle/navigation. Catalogue values are generated
 * from the approved web source; this module never chooses game statistics or validates orders. */
class NativeGameRenderer(
    private val assetRoot: FileHandle,
    private val onBuildingSelected: (String) -> Unit,
    private val onError: (String) -> Unit = {},
    private val onBattleCoverage: (Set<String>) -> Unit = {},
    /** Exact tick of a fully resident battle frame, emitted only after its batch is submitted. */
    private val onBattleProgress: (Float) -> Unit = {},
    private val performanceSink: ((String) -> Unit)? = null,
    private val onGroundSelected: (Float, Float) -> Unit = { _, _ -> },
    private val onBattleGroundSelected: (BattleDeploymentMode, Float, Float, Boolean) -> Unit = { _, _, _, _ -> },
    private val onDisposed: () -> Unit = {},
    private val inputDiagnostics: ((String) -> Unit)? = null,
    private val onBattleFrame: (BattlePlaybackFrame) -> Unit = {},
    /** An admitted render catalogue shared by the app; invoked once, off the GL and main threads. */
    private val catalogueTree: (() -> JsonValue)? = null,
    /** Non-fatal presentation notes (a realm painting that is not installed yet); never a scene failure. */
    private val onDiagnostic: (String) -> Unit = {},
    private val sensoryAdmissionEpoch:(String,String,Long)->Long={_,_,_->-1},
    private val onSensoryFrame:((SensoryFrame)->Unit)?=null,
    private val audioAdmissionEpoch: () -> Long = { -1 },
    private val onBattleAudioFrame: ((BattleAudioRenderFrame) -> Unit)? = null,
    private val deploymentHandled:(String,String,Long,DeployHaptic)->Boolean={_,_,_,_->false},
    private val deploymentPreview:(String,String,Long)->List<DeployPreviewMark> = {_,_,_->emptyList()},
    private val onWallStroke: (WallStrokeEvent) -> Unit = {},
    /** Hold-to-lift building moves on the home scene (web `BaseScene` drag contract); the app posts the move. */
    private val onCarry: (CarryEvent) -> Unit = {},
    private val onPerformanceSample: ((FrameTimeReport) -> Unit)? = null,
    private val onPerformanceSummary: ((FrameTimeReport) -> Unit)? = null,
    private val localDiagnostics: LocalSceneDiagnostics? = null,
    private val onPreparationError: ((ScenePreparationNotice) -> Unit)? = null,
    /** Explicit debug/instrumentation opt-in; a pack section alone never enables unapproved art. */
    private val allowLayeredGroundPreview: Boolean = false,
    private val layeredImageDecoder: LayeredImageDecoder? = null,
    /** Bounded GL-local callback after successful body submission; never posted to Main. */
    private val onCommandBodiesSubmitted: ((BattleCommandBodySubmission) -> Unit)? = null,
    /** GL-thread publication of the drawn Home camera (null while loading or in battle), only when it changes. */
    private val onBaseCamera: ((BaseCameraView?) -> Unit)? = null,
    serviceAssets: ServiceAssetSource? = null,
) : ApplicationAdapter() {
    @Volatile private var serviceSource: ServiceAssetSource? = serviceAssets
    @Volatile private var serviceArtEnabled = false
    private val serviceSubmissions = ServiceSceneSubmissions()
    private fun refreshServiceScene() = serviceSubmissions.refresh()
    /** Current capability, separate from frozen battle facts. A change fences old
     * pixels synchronously; asynchronous preparation never carries permission. */
    fun setServiceArtEnabled(enabled: Boolean) = serviceSubmissions.change {
        if (disposed || serviceArtEnabled == enabled) false else {
            serviceArtEnabled = enabled; serviceSource?.cancelPending(); if (!enabled) fleetJourneys.revoke(); serviceSource != null
        }
    }
    /** The content source and, beside it (N-C5 RESIDENCY), the optional typed private fleet capability. Either
     *  replacement fences old pixels and revokes every journey admission exactly as a source change always did;
     *  the capability confers no content admission — only groups the source actually leases become resident. */
    fun setServiceAssets(source: ServiceAssetSource?, fleet: PhaseEFleetArt? = null) = serviceSubmissions.change {
        if (disposed || (serviceSource === source && fleetCapability === fleet)) false else {
            val previous = serviceSource; serviceSource = source; fleetCapability = fleet; previous?.cancelPending(); fleetJourneys.revoke(); true
        }
    }
    private val serviceArt by lazy { RendererCatalogue.serviceArt(catalogueRoot) }
    // N-C5 private ingress. Journey art is PREPARED with each current Home generation's assets (ServiceSceneAssets.fleet)
    // and installed with them — there is no separate late art setter; a journey is never stored on a scene or inside a
    // replayable submission.
    @Volatile private var fleetCapability: PhaseEFleetArt? = null
    private val fleetJourneys = FleetJourneyPlayback()
    private val journeySprites = ArrayList<JourneySprite>()
    /** GL: packed frames for the verified journey cells of the active admission; dropped with the frame map. */
    private val journeyFrames = HashMap<ServicePackedCell, PackedFrame>()
    /** N-C5 RESIDENCY private host eligibility input: the installed admission is this base's and carries prepared
     *  journey art. A pure read; it attaches, loads and promises nothing. */
    fun fleetJourneysPrepared(baseId: String): Boolean = eligibleAdmission(baseId) != null
    /** The ONE authoritative read (eligibleJourneyAdmission): current requested generation, exact current source and
     *  capability, the admission's own prepared assets/art, current source validity, base and permission/lifecycle. */
    private fun eligibleAdmission(baseId: String) = eligibleJourneyAdmission(fleetJourneys.admission(), generation.get(), serviceSource, fleetCapability,
        baseId, enabled = !disposed && !layeredPaused && serviceArtEnabled)
    /** Synchronous main-thread hand-off against ONE captured admission (the scene, generation, assets
     *  and art GL installed together). Returns false when DROPPED (never queued): disposed/paused,
     *  service art off, no installed admission (battle, revocation), another base, no such complete
     *  berth, no admitted plan, art groups not resident in that admission's assets, or the admission
     *  replaced/revoked before insertion (checked again under the playback monitor). */
    fun submitFleetJourney(journey: RenderFleetJourney): Boolean {
        // The SAME eligibility read the host used; the playback gate re-checks the admission's identity and lifetime at insertion.
        val admission = eligibleAdmission(journey.baseId) ?: return false
        val current = admission.scene
        val building = current.buildings.firstOrNull { it.id == journey.berthId } ?: return false
        val plan = selectJourneyPlan(admission.art, building, current.services, journey, reducedMotion) ?: return false
        val resident = admission.assets ?: return false
        // Every normal key AND the separate still of every piece must resolve in the ONE resident atlas at its exact
        // path, in THIS admission's asset set (ordinary + cosmetics + selected fleet); the flight then draws those
        // verified cells, never the flattened frame map.
        val residency = verifiedJourneyCells(plan, resident.allAtlases.values.map { JourneyResidentAtlas(it.path, it.cells) }) ?: return false
        // An ADMITTED captured Wake (output + three hashes equal the carried binding) whose cells are not resident in
        // this generation drops the journey: never a partial flight that silently strips its original Wake.
        val wake = journey.wake
        if (wake is RenderJourneyWake.Available && plan.wake == null && resident.fleet?.wakeAdmitted(wake) == true) return false
        // Inserted only if the SAME live eligibility read still names this exact admission under the gate (no IO: flags,
        // generation, identities and the source's cheap current check).
        return fleetJourneys.start(journey, plan, System.currentTimeMillis(), admission, residency) { eligibleAdmission(journey.baseId) === admission }
    }
    fun cancelFleetJourneys() = fleetJourneys.revoke()
    private var decodedServices: ServiceSceneVisuals? = null // preparation worker only
    private var serviceVisuals: ServiceSceneVisuals? = null // GL only
    private var activeServiceAssets: ServiceSceneAssets? = null
    private val retiringServiceAssets = mutableListOf<ServiceSceneAssets>()
    private val serviceTextureFiles = java.util.concurrent.ConcurrentHashMap<String, FileHandle>()
    private val serviceTexturePixels = mutableMapOf<String,ServiceTexturePixels>() // GL texture ownership
    /** Home preparations decode a selected picture once while its pixels are owned (ServicePixelCache, 2026-10-11); battle
     *  preparation keeps its own decode unchanged. */
    private val homeServicePixels = ServicePixelCache()
    private val serviceSprites = mutableListOf<BaseVisualSprite>()
    private var observedServiceDrawn = 0
    private var observedServiceLayers = 0
    private var observedServiceFrameHash = 0
    private var observedServiceHitDrawn = 0
    private var observedServiceHitHash = 0
    private var observedServiceHitTick = 0f
    private var observedServiceOutlines = 0
    private val observedServiceIdentities = mutableSetOf<String>()
    private val pending = AtomicReference<PreparedScene?>()
    private val handoffLock = Any()
    private val pendingCatalogue = AtomicReference<List<Art>?>()
    private val preparationFailure = AtomicReference<Pair<Long,String>?>()
    private var staged: PreparedScene? = null
    private var stagedGround: GroundSurface? = null
    private var stagedLayeredGround: LayeredGroundSurface? = null
    private var stagedRealmKit: RealmKitSurface? = null
    private var uploadFailure: ScenePreparationNotice? = null
    private var serviceUploadFailure = false
    private var catalogueReady = false
    private val generation = AtomicLong()
    private val preparationTrace = AtomicReference<Pair<Long, LocalPreparationTrace?>?>()
    private var preparationDrawToken = -1L
    /** GL only: this renderer has drawn a complete scene frame (see [loaderBudgetMs]). */
    private var presented = false
    /** The requested scene's realm ground colour (RGB), set by its preparation worker: the clear colour until a ground exists. */
    @Volatile private var openingBackdrop: Int? = null
    private fun realmBackdrop(scene: BaseScene): Int? = runCatching {
        scene.visual?.let { visual -> groundRules?.artFor(visual)?.sources?.get(visual.realmId)?.color }
    }.getOrNull()
    private val decoding = Executors.newSingleThreadExecutor { work -> Thread(work, "pkw-battle-presentation") }
    private val preparation = LatestPreparation(decoding)
    private val pendingPlayback = BattlePlaybackControls()
    private val pendingCameraFit = java.util.concurrent.atomic.AtomicBoolean()
    private val pendingCameraInsets = AtomicReference(CameraInsets())
    private val inputGeometry = AtomicReference<SceneInputGeometry?>(null)
    private var panGeometry: SceneInputGeometry? = null
    private val deploymentMode = AtomicReference<BattleDeploymentMode?>(null)
    private val requestedBattleRaid = AtomicReference<String?>(null)
    fun setDeploymentMode(mode: BattleDeploymentMode?) { deploymentMode.set(mode) }
    private var cameraInsets = CameraInsets()
    private val cameraControls = AtomicReference<SceneCameraControls?>(null)
    private var activeAudioToken = 0L
    private val sensory=BattleSensoryPlayback(deploymentHandled={ cue ->
        battle?.let { deploymentHandled(it.scene.revision.raidId,it.scene.revision.revision,activeAudioToken,cue) } ?: false
    })
    private var sensoryControl=0L
    private var sensorySequence=0L
    private val sensoryProjection=com.badlogic.gdx.math.Matrix4()
    private val camera = OrthographicCamera()
    private val commandBodyCorner = com.badlogic.gdx.math.Vector3()
    private var commandDraws: BattleCommandDrawTracker? = null
    private val viewport = ScreenViewport(camera)
    private lateinit var batch: SpriteBatch
    private var hitFillShader:com.badlogic.gdx.graphics.glutils.ShaderProgram?=null
    private val croppedRegion = TextureRegion()
    private lateinit var assets: AssetManager
    private var scene: BaseScene? = null
    private var terrainBounds: BaseWorldBounds? = null
    /** Backend D-185 (owner 2026-09-27): the world the scene actually draws, which bounds the zoom floor ([drawnWorldFrame])
     *  and the home pan ([clampDrawnWorldAxis]) in every scene: [terrainBounds] when a realm kit (its 98-tile field,
     *  `RealmKitManifest.floorBounds`, never the `REALM_KIT.edgeExtendTiles` margin clamped beyond it) or a layered painting
     *  is drawn. Null for scenes without one (legacy v1 plots, simulator fixtures, a ground not loaded yet): they keep the
     *  pre-D-183 framing. Chosen by [drawnWorldBounds] with [terrainBounds] when a scene activates. */
    private var drawnWorld: BaseWorldBounds? = null
    private val catalogue = mutableMapOf<String, Art>()
    private var frames = mutableMapOf<String, PackedFrame>()
    private val requestedAtlases = mutableSetOf<String>()
    private val atlasTextures = mutableMapOf<String,Set<String>>()
    private var sceneAtlases: Set<String> = emptySet()
    private var scenePreparationFailed = false
    private val reported = mutableSetOf<String>()
    private val drawables = mutableListOf<Drawable>()
    private var selectableBuildingIds: Set<String> = emptySet()
    private val cameraFraming = SceneCameraFraming()
    @Volatile private var disposed = false
    private var battle: PreparedBattle? = null
    private var battleTick = 0f
    /** Ticks of a live clock correction still to ease in (see [easesLiveCorrection]); relative to [battleTick]. */
    private var battleCorrection = 0f
    private var battleCueFloor = 0f
    private val serviceHitCursor = ServiceHitCursor()
    private var skipAdvance = true
    private var sceneToken = -1L
    @Volatile private var renderedSceneToken = -1L
    private var progressElapsed = 0f
    private var progressPending = false
    private val paintPool = mutableListOf<Paint>()
    private val drawnKegPrimes = mutableMapOf<Int,KegPrimePresentation>()
    private val paintOrder = mutableListOf<Paint>()
    private val liveTroopStacks = LiveTroopStacks()
    /** Floating HP bar seats (web fx/hpbars.ts) rebuilt per frame from pooled records; no per-frame allocation. */
    private class HpBarSeat(var kind: HpBars.Kind, var cx: Float, var top: Float, var fraction: Float)
    private val hpBarSeats = mutableListOf<HpBarSeat>()
    private val hpBarPool = mutableListOf<HpBarSeat>()
    private val performance = performanceSink?.let { FrameTimeSampler() }
    private val diagnosticsEnabled = java.util.concurrent.atomic.AtomicBoolean()
    private val diagnosticsEpoch = AtomicLong()
    private var sampledDiagnosticsEpoch = -1L
    private var diagnosticSample: FrameTimeSampler? = null
    private var diagnosticSummary: FrameTimeSampler? = null
    private var textureRgbaMiB = 0.0
    private var textureCount = -1
    private val combatSprites = mutableListOf<CombatSprite>()
    private val combatStrokes = mutableListOf<CombatStroke>()
    private val strokeArt = Art("native-stroke","",1f,0f,0f,0f,0f)
    private lateinit var strokePixel: Pixmap
    private lateinit var strokeTexture: Texture
    private val catalogueRoot by lazy { catalogueTree?.invoke() ?: JsonReader().parse(safeFile("render-catalog.json")) }
    private val staticArtByKey by lazy { RendererCatalogue.staticArt(catalogueRoot).associateBy { it.key } }
    private val wallCatalogue by lazy { WallCatalogue(catalogueRoot) }
    private var baseWalls: WallVisualModel? = null
    private val baseRules by lazy { RendererCatalogue.basePresentation(catalogueRoot) }
    private val baseSeatOffsets by lazy { catalogueRoot.get("entries").filterNot { it.has("phaseE") }.associate {
        it.getString("frameKey") to (it.getFloat("offsetX",0f) to it.getFloat("offsetY",0f)) } }
    private var decodedBase: BaseVisualModel? = null // owned only by decoding executor
    private var baseVisuals: BaseVisualModel? = null
    private val baseSprites = mutableListOf<BaseVisualSprite>()
    private val campVisuals = CampVisualModel()
    private var campDrawn = 0
    private var campFrameHash = 0
    /** What the revision-5 ground drew last frame (the realm kit surface counts them; the snapshot reports them). */
    private var realmKitStillDraws = 0
    private var realmKitChunkDraws = 0
    private var realmKitTileQuads = 0
    private val campArtwork by lazy { PreparedCampScene.artwork(catalogueRoot) }
    @Volatile private var campFrameNanos = 0L
    private val basePaintPool = mutableListOf<BasePaint>()
    private val basePaintOrder = mutableListOf<BasePaint>()
    private val combatLibrary by lazy { CombatArt.catalogue(catalogueRoot) }
    private val deployPolicy by lazy { DeployPreviewPolicy.parse(catalogueRoot.get("sensoryPolicy")?.get("deploymentPreview")) }
    private val deployElapsed=mutableMapOf<Long,Float>()
    // Contract 13 sections. Each is null on an older pack, which keeps the legacy views (authored
    // 16-mask wall cells, the per-level builder stand-in, the tiled grass terrain) exactly as before.
    private val wallSpec by lazy { RendererCatalogue.wallArt(catalogueRoot) }
    private val wallLibrary by lazy { wallSpec?.let { WallFrameLibrary(WallCompositor(it)) } }
    private val builderRules by lazy { RendererCatalogue.builder(catalogueRoot) }
    private val groundRules by lazy { RendererCatalogue.ground(catalogueRoot) }
    /** `catalogue.json` constants (every `constants.ts` export): the realm-kit geometry and limits are read, never restated. */
    private val realmKitRules by lazy { RealmKitRules.read(requireNotNull(JsonReader().parse(safeFile("catalogue.json")).get("constants")) { "The content pack has no constants" }) }
    private var wallFrames: WallFieldTimeline? = null
    private val wallSeats = HashMap<String, SpritePlacement>()
    private var wallAtlas: WallFrameAtlas? = null
    private var composedRegion: TextureRegion? = null
    private var composedSeat: SpritePlacement? = null
    private var ground: GroundSurface? = null
    private var layeredGround: LayeredGroundSurface? = null
    private var realmKit: RealmKitSurface? = null
    @Volatile private var layeredPaused = false
    @Volatile private var groundIdentity: String? = null
    private val motionGlyphs = mutableListOf<GroundGlyph>()
    @Volatile private var reducedMotion = false
    /** Accessibility gates decorative terrain only; canonical battle clocks and essential clips never change. */
    fun setReducedMotion(reduced: Boolean) = serviceSubmissions.change {
        if (disposed || reducedMotion == reduced) false else { reducedMotion = reduced; serviceSource?.cancelPending(); serviceSource != null }
    }
    private var motionPhase = 0.0
    private var motionNextMs = 0L
    private var motionView = ""
    private var motionVisible: List<GroundMote> = emptyList()
    private lateinit var shapes: ShapeRenderer
    private var drawCalls = 0
    private val pendingHighlights = AtomicReference<List<SceneHighlight>?>()
    private var highlights: List<SceneHighlight> = emptyList()
    /** The designed selection marker (frame + sprite outline): its motion, the building it marks (kept through the
     * deselect fade), the base it was shown on, and every id whose sprite carries the gold outline. */
    private val selectionMotion = SelectionMotion()
    private val selectionFrame = SelectionFrame()
    private var selectionTargetId: String? = null
    private var selectionBaseId: String? = null
    /** The marked highlight's own fill alpha (the app's SELECTION_ALPHA, the design's 18 %). */
    private var selectionFillAlpha = 0.18f
    private var outlineIds: Set<String> = emptySet()
    private var selectionOutlineShader: com.badlogic.gdx.graphics.glutils.ShaderProgram? = null
    private var selectionOutlineUnavailable = false
    private val pendingWallMode = AtomicReference<WallStrokeMode?>()
    private val wallStroke = WallStrokeInput(onWallStroke)
    fun setWallStrokeMode(mode: WallStrokeMode?) {
        if (pendingWallMode.get() != mode) pendingWallMode.set(mode?.copy(validTiles = mode.validTiles.toSet()))
    }
    private val pendingCarryMode = AtomicReference<CarryMode?>()
    private val carry = BuildingCarryInput(onCarry) { BuildingCarryInput.SLOP_DP * Gdx.graphics.density }
    /** The app's current hold-to-lift admission (null outside an interactive home scene). */
    fun setCarryMode(mode: CarryMode?) { if (pendingCarryMode.get() != mode) pendingCarryMode.set(mode) }

    /** Replaces the overlay rectangles drawn above the base on the next frame; battle scenes draw none. */
    fun setHighlights(next: List<SceneHighlight>) { pendingHighlights.set(next.toList()) }

    fun updateBase(scene: BaseScene) = serviceSubmissions.replace { submitBase(scene) }
    private fun submitBase(scene: BaseScene) {
        if (disposed) return
        serviceSource?.cancelPending()
        requestedBattleRaid.set(null)
        preparationTrace.getAndSet(null)?.second.end(LocalPreparationOutcome.SUPERSEDED)
        // N-C5 RESIDENCY R3: generation advance + admission revoke + authorizing predecessor in ONE short transition under
        // the playback gate's own monitor, before any asynchronous work; traces/notices/IO/preparation stay outside.
        // CONTINUITY: decided atomically with the generation advance — an ALREADY RUNNING original survives only when THIS next scene
        // proves the same installation on the same berth geometry (journeyContinuity); everything else ends before preparation.
        val (token, journeyPredecessor) = fleetJourneys.authorizeRequest({ generation.incrementAndGet() }) { journey, startedOn -> journeyContinuity(scene, journey, startedOn) }
        preparationNotice(ScenePreparationNotice(token, null))
        val frozen = scene.copy(buildings = scene.buildings.toList(), jobs = scene.jobs.toList(), obstacles = scene.obstacles.toList(), remnants = scene.remnants.toList(), campTroops = scene.campTroops.toList())
        try { preparation.submit(token) {
            if (disposed || generation.get() != token) return@submit
            realmBackdrop(frozen)?.let { openingBackdrop = it }
            try {
                val walls = WallVisualModel(frozen.buildings, wallCatalogue)
                val field = wallSpec?.let { spec -> WallFieldTimeline(spec, frozen.buildings) }
                val visuals = baseRules?.let { BaseVisualModel(frozen,combatLibrary,it,System.currentTimeMillis(),decodedBase,baseSeatOffsets,builderRules) }
                val camps = baseRules?.let { rules -> PreparedCampScene.prepare(frozen, combatLibrary, rules.jobs.actorDepthOffset, campArtwork) { checkPreparation(token) } }
                val ground = prepareGround(frozen, checkpoint = { checkPreparation(token) })
                if (generation.get() == token) { decodedBase=visuals;publish(SceneUpdate.Base(frozen, walls, visuals, token, field, ground, camps, journeyPredecessor = journeyPredecessor)) }
                else ground.discard()
            } catch (error: Exception) { if (generation.get() == token) preparationFailure.set(token to "Base wall presentation: ${error.message}") }
        } } catch (error: java.util.concurrent.RejectedExecutionException) { if (!disposed) throw error }
    }

    fun updateBattle(scene: BattleScene, audioToken: Long = 0) {
        val request = Any() // Refresh repeats this owner; an external submission always replaces it.
        serviceSubmissions.replace { submitBattle(scene,audioToken,request) }
    }
    private fun submitBattle(scene: BattleScene, audioToken: Long, request: Any) {
        if (disposed) return
        serviceSource?.cancelPending()
        requestedBattleRaid.set(scene.revision.raidId)
        val (token, journeyPredecessor) = fleetJourneys.authorizeRequest({ generation.incrementAndGet() }) // one transition; a battle request ends any admission and every original
        val trace = runCatching { scene.preparationTrace?.renderer(token) }.getOrNull()
        preparationTrace.getAndSet(token to trace)?.second.end(LocalPreparationOutcome.SUPERSEDED)
        preparationNotice(ScenePreparationNotice(token, null))
        val frozen = scene.copy(preparationTrace = trace, base = scene.base.copy(buildings = scene.base.buildings.toList()),
            actorFrames = scene.actorFrames.toMap(), actorMaxHp=scene.actorMaxHp.toMap(), deploymentFrames=scene.deploymentFrames.toMap(), revision = scene.revision.copy(events = scene.revision.events.toList()))
        try { preparation.submit(token) {
            if (disposed || generation.get() != token) return@submit
            realmBackdrop(frozen.base)?.let { openingBackdrop = it }
            try {
                trace.observe(LocalPreparationStage.RENDERER_STARTED)
                val checkpoint = { checkPreparation(token) }
                val model = BattleVisualModel(frozen.revision.events, frozen.positionCadenceTicks, frozen.summonedPositionCadenceTicks, checkpoint)
                if (disposed || generation.get() != token) return@submit
                val walls = WallVisualModel(frozen.base.buildings, wallCatalogue, frozen.revision.events, checkpoint)
                val field = wallSpec?.let { spec -> WallFieldTimeline(spec, frozen.base.buildings, frozen.revision.events, frozen.tickDurationMs, checkpoint) }
                field?.diagnostics?.forEach(onDiagnostic)
                // Battle structures sort on their raw south edge; flying bodies take the same actor band the base scene uses.
                val prepared = PreparedBattle(frozen, model, CombatVisualPlan(frozen, model, combatLibrary, catalogueRoot.get("buildingDamageThreshold")?.asFloat(), walls, SensoryPolicy.parse(catalogueRoot.get("sensoryPolicy")), HitFeedbackPolicy.parse(catalogueRoot.get("hitFeedback")),ArchivedMeleePolicy.parse(catalogueRoot.get("archivePresentation")), checkpoint,
                    flyingDepthOffset = baseRules?.jobs?.actorDepthOffset ?: 0f), walls,
                    walls.requiredFrames.flatMap { combatLibrary[it]?.atlases.orEmpty() }.toSet(), field)
                if (disposed || generation.get() != token) return@submit
                val ground = prepareGround(frozen.base, checkpoint = checkpoint)
                if (generation.get() == token) publish(SceneUpdate.Battle(prepared, token, ground, audioToken, request, journeyPredecessor = journeyPredecessor)) else ground.discard()
            } catch (error: Exception) {
                trace.end(if (error is java.util.concurrent.CancellationException) LocalPreparationOutcome.CANCELLED else LocalPreparationOutcome.FAILED)
                if (generation.get() == token) preparationFailure.set(token to "Battle presentation: ${error.message}")
            }
        } } catch (error: java.util.concurrent.RejectedExecutionException) { if (!disposed) throw error }
    }

    fun setBattlePlayback(playheadTick: Float, rate: Float, playing: Boolean, audioToken: Long = 0) {
        require(playheadTick.isFinite() && playheadTick >= 0 && rate.isFinite() && rate > 0)
        if (!disposed) pendingPlayback.seek(playheadTick,rate,playing,generation.get(),audioToken)
    }

    /** The GL thread alone mutates the camera, including requests from the layout toolbar. */
    fun requestCameraFit() { if (!disposed) pendingCameraFit.set(true) }
    fun setDiagnosticsEnabled(enabled: Boolean) {
        if (!disposed && diagnosticsEnabled.getAndSet(enabled) != enabled) diagnosticsEpoch.incrementAndGet()
    }
    fun setInputGeometry(geometry: SceneInputGeometry?) { if (!disposed) inputGeometry.set(geometry) }
    fun setCameraInsets(insets: CameraInsets) { if (!disposed) pendingCameraInsets.set(insets) }
    fun setCameraControls(controls: SceneCameraControls?) { if (!disposed) cameraControls.set(controls) }
    fun clearCameraControls(controls: SceneCameraControls?) { cameraControls.compareAndSet(controls, null) }

    /** Pause/resume or change replay speed at the actual GL clock, not a delayed UI sample. */
    fun setBattlePlaying(playing: Boolean, audioToken: Long = 0, rate: Float? = null) {
        if (!disposed) pendingPlayback.playing(playing,generation.get(),audioToken,rate)
    }

    private fun checkPreparation(token: Long) {
        if (disposed || generation.get() != token || Thread.currentThread().isInterrupted) throw java.util.concurrent.CancellationException()
    }

    /** A superseded update that nobody took still owns a decoded painting. */
    private fun publish(update: SceneUpdate) {
        var ownedServices: ServiceSceneAssets? = null
        try {
            if (disposed || generation.get() != update.token) { update.ground.discard(); return }
            val base = when(update) { is SceneUpdate.Base -> update.scene; is SceneUpdate.Battle -> update.prepared.scene.base }
            val battle = (update as? SceneUpdate.Battle)?.prepared
            val walls = battle?.walls ?: (update as SceneUpdate.Base).walls
            val services = ServiceSceneAssets.prepare(serviceArt, base, serviceSource, serviceArtEnabled && !layeredPaused,
                reducedMotion, battle != null, { checkPreparation(update.token) }, onDiagnostic,
                decode = if (battle == null) homeServicePixels::decode else ServiceTexturePixels::decode, fleet = fleetCapability).also { ownedServices = it }
            val serviceViews = ServiceSceneVisuals(services, base, System.currentTimeMillis(), decodedServices)
            val keys = base.buildings.filter { it.service == null }.map { it.frameKey } + base.terrainFrameKey + walls.requiredFrames +
                (if(battle == null) base.obstacles.map { it.frameKey } else battle.scene.actorFrames.values + battle.scene.deploymentFrames.values)
            val art = staticArtByKey
            keys.forEach { require(it in art) { "Missing approved artwork catalogue entry: $it" } }
            val preview = battle?.scene?.deploymentFrames.orEmpty().flatMap { (identity,key) ->
                combatLibrary[key]?.let { deploymentClips(it, identity in setOf("vex","theodor")).let { clips -> listOfNotNull(clips.first,clips.second).map { it.atlasPath } } }.orEmpty()
            }
            val paths = keys.flatMap { key -> art[key]?.let { listOfNotNull(it.atlasPath,it.motion?.atlasPath) }.orEmpty() }.toSet() + preview +
                (battle?.let { it.visuals.requiredAtlases + it.wallAtlases } ?: (update as SceneUpdate.Base).let { it.visuals?.requiredAtlases.orEmpty() + it.camps?.requiredAtlases.orEmpty() })
            val metadata = paths.associateWith { path ->
                if (disposed || generation.get() != update.token) throw java.util.concurrent.CancellationException()
                atlasMetadataCache.getOrPut(path) { readAtlas(path) }
            } + services.atlases.mapValues { (_, atlas) -> AtlasMetadata(setOf(atlas.texture), atlas.cells.mapValues { (_, cell) ->
                PackedFrame(cell.texture,cell.x,cell.y,cell.width,cell.height,cell.width.toFloat(),cell.height.toFloat(),0f,0f)
            }) } + services.fleet?.atlases.orEmpty().mapValues { (_, atlas) -> AtlasMetadata(setOf(atlas.texture), emptyMap()) }
            // Fleet textures are queued/retained like service textures but contribute NO flattened frame entries: a fleet
            // atlas shares authored keys with ordinary groups (e.g. starter berth stills), and journey sprites draw their
            // verified resident cell directly.
            keys.forEach { key -> require(metadata[art.getValue(key).atlasPath]?.frames?.containsKey(key) == true) { "Missing approved atlas frame: $key" } }
            atlasMetadataCache.keys.retainAll(paths)
            val pixels = wallLibrary?.snapshot(update.wallField?.keys.orEmpty()) { checkPreparation(update.token) }.orEmpty()
            val lookup = mutableMapOf<String,PackedFrame>()
            metadata.values.forEach { atlas -> atlas.frames.forEach { (key,frame) -> checkPreparation(update.token); lookup[key] = frame.copy() } }
            synchronized(handoffLock) {
                if (disposed || generation.get() != update.token) { update.ground.discard(); services.close() }
                else {
                    (update as? SceneUpdate.Battle)?.prepared?.scene?.preparationTrace.observe(LocalPreparationStage.RENDERER_COMPLETED)
                    decodedServices = serviceViews
                    // The request's own authorization travels with the publication: completion never samples fresh authority.
                    pending.getAndSet(PreparedScene(update,metadata,pixels,lookup,services,serviceViews, journeyPredecessor = update.journeyPredecessor))?.let { it.update.ground.discard(); it.services.close() }
                    ownedServices = null
                }
            }
        } catch (error: Exception) { update.ground.discard(); ownedServices?.close(); throw error }
    }
    private data class AtlasMetadata(val textures: Set<String>, val frames: Map<String,PackedFrame>)
    private data class PreparedScene(val update: SceneUpdate, val atlases: Map<String,AtlasMetadata>, val wallPixels: Map<String,ByteArray>,
        val frames: MutableMap<String,PackedFrame>, val services: ServiceSceneAssets, val serviceVisuals: ServiceSceneVisuals,
        /** N-C5 RESIDENCY: the playback lifetime this preparation was authorized under (worker, at publication) … */
        val journeyPredecessor: Long = 0L,
        /** … and the single ticket GL arming returned for it (null = stale/revoked: no admission until fresh preparation). */
        val journeyTicket: Long? = null)
    private val atlasMetadataCache = mutableMapOf<String,AtlasMetadata>() // preparation worker only
    private var preparedAtlases: Map<String,AtlasMetadata> = emptyMap() // GL only

    override fun create() {
        batch = SpriteBatch()
        shapes = ShapeRenderer()
        strokePixel = Pixmap(1,1,Pixmap.Format.RGBA8888)
        strokePixel.setColor(1f,1f,1f,1f);strokePixel.fill();strokeTexture = managedTexture(strokePixel)
        assets = AssetManager(FileHandleResolver { path -> serviceTextureFiles[path] ?: safeFile(path) })
        assets.setErrorListener { descriptor, error ->
            if (serviceTextureFiles.containsKey(descriptor.fileName)) serviceUploadFailure = true
            else uploadFailure = ScenePreparationNotice(staged?.update?.token ?: sceneToken,
                "Unable to load ${descriptor.fileName}: ${error.message}")
        }
        camera.setToOrtho(true)
        decoding.execute {
            try { val entries = loadCatalogue(); if (!disposed) pendingCatalogue.set(entries) }
            catch (error: Exception) { onError("Base artwork catalogue: ${error.message}") }
        }
        Gdx.input.inputProcessor = input
    }

    override fun resize(width: Int, height: Int) {
        if(cameraFraming.resize(width,height)) cancelSceneGesture() else wallStroke.cancel()
        viewport.update(width, height, false)
        if (!cameraFraming.moved) fitCamera()
        clampCamera()
        traceInput("resize",-1,width,height)
    }

    override fun render() {
        runCatching { localDiagnostics?.frameStarted() }
        try { renderFrame() } finally { runCatching { localDiagnostics?.frameCompleted() } }
    }

    private fun renderFrame() {
        runCatching { localDiagnostics?.state(LocalSceneSnapshot(
            if(scene == null || renderedSceneToken != sceneToken) LocalSceneKind.LOADING else if(battle == null) LocalSceneKind.BASE else LocalSceneKind.BATTLE,
            preparation.depth(),textureRgbaMiB,wallAtlas?.pendingUploads ?: 0,viewport.screenWidth,viewport.screenHeight,
            camera.position.x.toDouble(),camera.position.y.toDouble(),camera.zoom.toDouble(),
            campVisuals.count,if(localDiagnostics?.observeCampFrames==true) campVisuals.rosterHash() else 0,
            if(localDiagnostics?.observeCampFrames==true) campVisuals.poseHash() else 0,campDrawn,campFrameHash,
            observedServiceDrawn,observedServiceLayers,observedServiceFrameHash,observedServiceOutlines,
            if(localDiagnostics?.observeServiceFrames==true) activeServiceAssets?.atlases?.size ?: 0 else 0,
            if(localDiagnostics?.observeServiceFrames==true) sceneToken else 0,
            observedServiceHitDrawn,observedServiceHitHash,observedServiceHitTick,
            // Released revision-5 ground counters follow the Phase E service counters (LocalSceneSnapshot field order).
            realmKitStillDraws,realmKitChunkDraws,realmKitTileQuads)) }
        if (localDiagnostics?.observeServiceFrames == true) {
            observedServiceDrawn = 0; observedServiceLayers = 0; observedServiceFrameHash = 0; observedServiceOutlines = 0
            observedServiceIdentities.clear()
            observedServiceHitDrawn = 0; observedServiceHitHash = 0; observedServiceHitTick = 0f
        }
        realmKitStillDraws = 0; realmKitChunkDraws = 0; realmKitTileQuads = 0
        if (disposed) return
        val requestedInsets = pendingCameraInsets.get()
        if (requestedInsets != cameraInsets) {
            cameraInsets = requestedInsets
            // Changing disclosure/chrome must not move a deliberately framed scene; it is only re-clamped (a no-op unless the
            // smaller chrome would now show past the drawn world, D-185).
            if (!cameraFraming.moved) fitCamera() else if (scene != null) clampCamera()
        }
        // The home pan rectangle follows the measured chrome (panCameraInsets): a closing sheet re-clamps a moved camera.
        inputGeometry.get().let { geometry -> if (geometry != panGeometry) { panGeometry = geometry; if (scene != null && battle == null) clampCamera() } }
        if (pointers.isNotEmpty() && (touchChromeEpoch != (inputGeometry.get()?.cancellation?.revision ?: 0L) || pointers.values.any { !insideViewport(it.x.toInt(), it.y.toInt()) })) cancelSceneGesture()
        val frameAudioEpoch = audioAdmissionEpoch()
        pendingCatalogue.getAndSet(null)?.let { entries ->
            entries.forEach { catalogue[it.key] = it }
            catalogueReady = true
        }
        if (staged?.update?.token?.let { it != generation.get() } == true) discardStaging()
        preparationFailure.getAndSet(null)?.let { (token,message) -> failPreparation(message, token) }
        (if (catalogueReady) pending.getAndSet(null) else null)?.let { delivery ->
            if (delivery.update.token != generation.get()) { delivery.update.ground.discard(); delivery.services.close() }
            else {
                discardStaging()
                // N-C5 RESIDENCY: ONE predecessor-checked arming at the playback gate the moment the delivery is staged. The
                // delivery carries the lifetime its preparation was authorized under; if any revoke happened since, arming
                // refuses (ticket null) and this delivery stays without journeys until a fresh preparation. The returned
                // ticket travels UNCHANGED with the staged delivery through upload/activation waits — never re-sampled — so
                // a revoke after arming still refuses the install below. Scene, assets and art install as one admission.
                staged = delivery.copy(journeyTicket = fleetJourneys.arm(delivery.services.journeyArt, delivery.journeyPredecessor))
                delivery.services.allAtlases.values.forEach { serviceTextureFiles[it.texture] = it.file }
                preparedAtlases = preparedAtlases + delivery.atlases
                try {
                    delivery.atlases.keys.forEach(::requestAtlas)
                    val atlas = wallAtlas ?: wallLibrary?.let { WallFrameAtlas() }.also { wallAtlas = it }
                    atlas?.prepare(wallFrames?.keys.orEmpty() + delivery.update.wallField?.keys.orEmpty(), delivery.wallPixels)
                    releaseUnusedAtlases(sceneAtlases + delivery.atlases.keys)
                } catch (error: Exception) { failPreparation("Scene preparation: ${error.message}", delivery.update.token) }
            }
        }
        // Current drawables/ground remain owned until every replacement dependency is ready.
        // Do not stack a final atlas upload, wall-page upload, shader compilation and
        // ground activation into one GL frame. Any single driver upload is non-preemptible.
        val hadTextureUploads = assets.queuedAssets > 0
        loaderBudgetMs(presented).let { budget -> if (budget > 0) assets.update(budget) else assets.update() }
        if (serviceUploadFailure) { serviceUploadFailure = false; discardStagedServiceArt() }
        drainServiceAssets()
        uploadFailure?.let { uploadFailure = null; failPreparation(requireNotNull(it.message), it.generation) }
        // A canceled in-flight task remains in AssetManager.contains until update removes it.
        // The newest scene can need that same page; reacquire it only after cancellation clears.
        staged?.atlases?.values?.forEach { queueSceneTextures(it.textures) }
        val wallUploadToken = staged?.update?.token ?: sceneToken
        val hadWallUploads = (wallAtlas?.pendingUploads ?: 0) > 0
        try { if (!hadTextureUploads) wallAtlas?.advance() } catch (error: Exception) { failPreparation("Wall upload: ${error.message}", wallUploadToken) }
        staged?.let { delivery ->
            if (delivery.update.token != generation.get()) { discardStaging(); return@let }
            if (hadTextureUploads || hadWallUploads || !atlasesReady(delivery.atlases.keys) || wallAtlas?.ready == false) return@let
            val reuse = (delivery.update.ground as? GroundDelivery.Keep)?.admission
            if (reuse?.prepareIfChanged(groundIdentity) { reprepareGround(delivery.update, delivery.journeyTicket) } == true) return@let
            try {
                if ((delivery.update as? SceneUpdate.Battle)?.prepared?.visuals?.hitFeedback != null && hitFillShader == null) {
                    hitFillShader = HitFillShader.create()
                    return@let
                }
                val groundDelivery = delivery.update.ground
                if (groundDelivery is GroundDelivery.Replace) stagedGround = GroundSurface(groundDelivery.prepared)
                if (groundDelivery is GroundDelivery.Layered) {
                    val candidate = stagedLayeredGround ?: LayeredGroundSurface(groundDelivery.prepared).also { stagedLayeredGround = it }
                    if (!candidate.ready) { candidate.advance(); return@let }
                }
                if (groundDelivery is GroundDelivery.RealmKit) {
                    val candidate = stagedRealmKit ?: RealmKitSurface(groundDelivery.prepared).also { stagedRealmKit = it }
                    if (!candidate.ready) { candidate.advance(); return@let }
                }
            } catch (error: Exception) { failPreparation("Scene activation: ${error.message}", delivery.update.token); return@let }
            if (delivery.update.token != generation.get()) { discardStaging(); return@let }
            val next = delivery.update
            val replacementGround = stagedGround
            val replacementLayeredGround = stagedLayeredGround
            val replacementRealmKit = stagedRealmKit
            val oldServiceAssets = activeServiceAssets
            val ticket = delivery.journeyTicket // the exact staged ticket; never re-sampled
            val committed = fleetJourneys.commitDelivery({ next.token == generation.get() && !disposed }) {
                // No GPU work, disposal or notices under this monitor. A newer request sees
                // either the old ownership or this complete reference/admission transition.
                staged = null; stagedGround = null; stagedLayeredGround = null; stagedRealmKit = null
                activeServiceAssets = delivery.services; serviceVisuals = delivery.serviceVisuals
                sceneToken = next.token; preparedAtlases = delivery.atlases
                frames = delivery.frames; journeyFrames.clear()
                if (next is SceneUpdate.Base && serviceArtEnabled && !layeredPaused && ticket != null)
                    fleetJourneys.install(next.scene, next.token, activeServiceAssets, ticket)
                else fleetJourneys.revokeDelivery(next.token) { generation.get() }
            }
            if (!committed) { discardStaging(); return@let } // only the stale delivery's resources
            delivery.services.releasePixels() // Queued/resident textures own their exact managed data now.
            val serviceRefresh = serviceHitCursor.adopt((next as? SceneUpdate.Battle)?.request)
            renderedSceneToken = -1L
            scenePreparationFailed = false
            commandDraws = if (next is SceneUpdate.Battle && onCommandBodiesSubmitted != null)
                BattleCommandDrawTracker.create(next.prepared.scene.commandDrawPlan, sceneToken,
                    next.prepared.scene.revision.raidId, next.prepared.scene.revision.revision) else null
            progressElapsed = 0f
            when (next) {
                is SceneUpdate.Base -> { sensory.clear();deployElapsed.clear();battle = null; scene = next.scene; baseWalls = next.walls; baseVisuals=next.visuals; campVisuals.replace(next.camps); campFrameNanos = 0L }
                is SceneUpdate.Battle -> {
                    if(!serviceRefresh) activeAudioToken = next.audioToken
                    campVisuals.replace(null); campFrameNanos = 0L
                    val previousScene=battle?.scene
                    if(previousScene?.revision?.raidId!=next.prepared.scene.revision.raidId)deployElapsed.clear()
                    val previous = battle?.let { BattlePlaybackFrame(it.scene.revision.raidId,it.scene.revision.revision,battleTick,it.extent) }
                    battle = if(serviceRefresh && previousScene!=null) next.prepared.copy(scene=next.prepared.scene.copy(
                        playing=previousScene.playing,rate=previousScene.rate)) else next.prepared
                    if(!serviceRefresh) { battleTick = initialBattleTick(next.prepared.scene,next.prepared.extent,previous); battleCorrection = 0f }
                    if(previousScene==null || !sensory.continueRevision(next.prepared.visuals.sensoryCues,previousScene,next.prepared.scene,battleTick)) {
                        sensoryControl++
                        sensory.replace(next.prepared.visuals.sensoryCues,previous==null && battleTick==0f && next.prepared.scene.presentationStart==BattlePresentationStart.Continuous)
                    }
                    if(!serviceRefresh) battleCueFloor = battleTick
                    skipAdvance = true
                    scene = next.prepared.scene.base
                    val missingMotion = next.prepared.model.actorIds.filter { id ->
                        catalogue[actorFrame(next.prepared, id)]?.motion == null
                    }.map { "motion:${next.prepared.model.actorIdentity(it)}" }
                    onBattleCoverage(next.prepared.visuals.missingCoverage + missingMotion)
                    progressPending = true
                }
            }
            val active=scene!!
            val destinationChanged=cameraFraming.activate(active,battle?.scene?.revision?.raidId)
            if(destinationChanged) cancelSceneGesture()
            wallFrames = next.wallField
            wallAtlas?.prepare(next.wallField?.keys.orEmpty(), emptyMap())
            applyGround(next.ground, replacementGround, replacementLayeredGround, replacementRealmKit)
            selectableBuildingIds=active.buildings.mapTo(HashSet()) { it.id }
            terrainBounds=realmKit?.worldBounds(active.tilePixels) ?: layeredGround?.worldBounds(active.tilePixels) ?: ground?.worldBounds(active.tilePixels) ?: baseWorldBounds(active.columns,active.rows,active.tilePixels,
                if(battle==null) active.camera?.skirtTiles ?: 0f else active.battlefield?.minimum?.let { -it.toFloat() } ?: 0f, active.minimumTileX, active.minimumTileY)
            drawnWorld=drawnWorldBounds(realmKit?.worldBounds(active.tilePixels),layeredGround?.worldBounds(active.tilePixels))
            prepareScene(active, battle?.walls ?: baseWalls!!)
            if(battle==null) (baseVisuals?.requiredAtlases.orEmpty() + (next as SceneUpdate.Base).camps?.requiredAtlases.orEmpty()).forEach { requestAtlas(it) }
            val requiredActorFrames = battle?.let { prepared ->
                (prepared.model.actorIds.mapNotNull { actorFrame(prepared, it) } +
                    if(deployPolicy!=null)prepared.scene.deploymentFrames.values else emptyList()).distinct()
            } ?: emptyList()
            requiredActorFrames.forEach { key ->
                val art = catalogue[key]
                if (art == null) report("Missing approved actor artwork: $key")
                else runCatching { requestAtlas(art.atlasPath); art.motion?.let { requestAtlas(it.atlasPath) } }
                    .onFailure { report("Actor artwork: ${it.message}") }
            }
            val previewAtlases=if(deployPolicy==null)emptySet() else battle?.scene?.deploymentFrames.orEmpty().entries
                .flatMap { (identity,key)->combatLibrary[key]?.let { art->deploymentClips(art,identity in setOf("vex","theodor")).let {listOfNotNull(it.first,it.second)} }.orEmpty() }
                .map {it.atlasPath}.toSet()
            previewAtlases.forEach { atlas->runCatching {requestAtlas(atlas)}.onFailure {report("Pending actor artwork: ${it.message}")} }
            val neededFrames = scene!!.buildings.map { it.frameKey } + (if(battle==null) scene!!.obstacles.map { it.frameKey } else emptyList()) + (battle?.walls ?: baseWalls!!).requiredFrames + scene!!.terrainFrameKey +
                requiredActorFrames
            (battle?.let { it.visuals.requiredAtlases + it.wallAtlases })?.forEach { atlas ->
                runCatching { requestAtlas(atlas) }.onFailure { report("Combat artwork: ${it.message}") }
            }
            val neededAtlases = neededFrames.flatMap { key ->
                catalogue[key]?.let { art -> listOfNotNull(art.atlasPath, art.motion?.atlasPath) } ?: emptyList()
            }.toSet() + previewAtlases + (battle?.let { it.visuals.requiredAtlases + it.wallAtlases } ?: (baseVisuals?.requiredAtlases.orEmpty() + (next as SceneUpdate.Base).camps?.requiredAtlases.orEmpty()))
            sceneAtlases = neededAtlases + delivery.services.paths
            releaseUnusedAtlases(sceneAtlases)
            oldServiceAssets?.let { retiringServiceAssets += it }
            drainServiceAssets()
            (next as? SceneUpdate.Battle)?.prepared?.scene?.preparationTrace.observe(LocalPreparationStage.GL_ACTIVATED)
            preparationNotice(ScenePreparationNotice(next.token, null))
            // Only a new destination frames the camera (scene open, another raid or plot). A revision of the
            // current battle — every acknowledged deploy delivers one — keeps the camera exactly where it is;
            // resize, inset changes with an untouched camera and explicit FIT keep their own paths above/below.
            if (destinationChanged && !cameraFraming.moved) fitCamera()
            // The realm map's Enter-base seam (D-162.3): this base's first frame opens on the camera the World tab handed
            // over (the map's TRUE view of the deed) instead of the fit, never another base's frame or a battle on it.
            // Clamped to this base's zoom band and painted bounds like a pinch, then kept as the player's own framing.
            if (destinationChanged) cameraControls.get()?.entryFor(active.baseId, battle != null)?.let { entry ->
                camera.zoom = entry.zoom; camera.position.set(entry.worldX, entry.worldY, 0f)
                cameraFraming.moved = true; clampCamera()
                onDiagnostic("seam entry ${entry.baseId} at ${entry.worldX},${entry.worldY} zoom ${entry.zoom} -> ${camera.position.x},${camera.position.y} zoom ${camera.zoom}")
            }
        }
        if (scene != null && pendingCameraFit.getAndSet(false)) { cameraFraming.moved = false; fitCamera() }
        if (scene != null) cameraControls.get()?.let { controls ->
            while (true) {
                val command = controls.take() ?: break
                cancelSceneGesture()
                if (command == SceneCameraControls.Command.FIT) { cameraFraming.moved = false; fitCamera() }
                else controls.zoomStep?.let { step ->
                    val band = expandedBattleFrame() ?: baseCameraFrame()
                    // libGDX zoom is inverse source scale; use the same band as native pinch.
                    camera.zoom = (camera.zoom * if (command == SceneCameraControls.Command.IN) 1f / step else step)
                        .coerceIn(band?.minZoom ?: 0.3f, band?.maxZoom ?: 8f)
                    cameraFraming.moved = true
                    clampCamera()
                }
            }
        }
        if(battle != null) pendingPlayback.take(generation.get(),sceneToken)?.let { control ->
                activeAudioToken = control.audioToken
                sensoryControl++
                battle = battle!!.let { it.copy(scene = it.scene.copy(rate = control.rate ?: it.scene.rate, playing = control.playing)) }
                // A live clock's small correction eases in (owner 2026-10-11); a mode change cancels an unapplied one.
                val eased = control.tick?.let { tick ->
                    val target = tick.coerceAtMost(battle!!.extent.visualEndTick)
                    easesLiveCorrection(battle!!.scene,target-battleTick).also { ease ->
                        if(ease) battleCorrection = target-battleTick
                        else { battleTick = target; battleCueFloor = battleTick;serviceHitCursor.clear(); battleCorrection = 0f }
                    }
                } ?: run { battleCorrection = 0f; false }
                progressPending = true
                skipAdvance = skipAdvance || !eased // an eased correction keeps advancing; an activation's skip stays
        }
        // The web paints the realm colour behind its ground; beyond a v1 skirt only that colour shows.
        val backdrop = ground
        // Owner 2026-10-06 ("black screen is low quality"): before this renderer has its own ground (and for a realm kit, which
        // has no v1 ground), clear to the scene's realm colour, never near-black.
        val opening = openingBackdrop
        if (backdrop != null) Gdx.gl.glClearColor(backdrop.red, backdrop.green, backdrop.blue, 1f)
        else if (opening != null) Gdx.gl.glClearColor((opening shr 16 and 255) / 255f, (opening shr 8 and 255) / 255f, (opening and 255) / 255f, 1f)
        else Gdx.gl.glClearColor(0.035f, 0.055f, 0.04f, 1f)
        Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)
        val active = scene
        if (active == null) { publishBaseCamera(null); samplePerformance("loading", 0); return }
        // An empty loader queue can also mean a failed texture task. Require every
        // declared texture, including combat effects, before showing or advancing
        // this scene. Loading time cannot consume an attack's authored frames.
        val sceneReady = !scenePreparationFailed && atlasesReady(sceneAtlases)
        if (!sceneReady) { publishBaseCamera(null);sensory.interrupted();renderedSceneToken=-1L;samplePerformance("loading",0);return }
        camera.update()
        val sensoryBattle=battle
        val sensoryEpoch=sensoryBattle?.let { sensoryAdmissionEpoch(it.scene.revision.raidId,it.scene.revision.revision,activeAudioToken) } ?: -1
        val hapticRequests=if(sensoryBattle!=null)sensory.advance(battleTick,Gdx.graphics.deltaTime*1000f,sensoryBattle.scene.rate,
            sensoryBattle.scene.playing,if(reducedMotion)-1 else sensoryEpoch,sensoryControl,sensoryBattle.visuals.sensoryPolicy,
            Gdx.graphics.width.toFloat(),Gdx.graphics.height.toFloat(),1f/camera.zoom,sceneToken==generation.get()) else emptyList()
        val offset=sensory.offset
        sensoryProjection.setToTranslation(offset.x*2/Gdx.graphics.width,-offset.y*2/Gdx.graphics.height,0f).mul(camera.combined)
        batch.projectionMatrix = sensoryProjection
        batch.begin()
        drawTerrain(active)
        batch.end(); drawCalls = batch.renderCalls
        drawGroundMotion(active)
        pendingHighlights.getAndSet(null)?.let { highlights = it; selectionChanged(active) }
        syncCarryInput(); carry.tick(System.nanoTime() / 1_000_000)
        val activeBattle = battle
        if (activeBattle == null) {
            selectionMotion.advance(Gdx.graphics.deltaTime.coerceIn(0f, .1f))
            drawHighlightFills(active)
        } else selectionMotion.reset()
        batch.begin()
        val renderedBattleTick = battleTick
        drawnKegPrimes.clear()
        commandDraws?.beginFrame()
        if (activeBattle == null) drawBase(System.currentTimeMillis())
        else {
            drawBattle(activeBattle)
            if (sceneToken == generation.get() && activeBattle.scene.playing && !skipAdvance) {
                val frameTicks = battleFrameTicks(Gdx.graphics.deltaTime, activeBattle.scene.tickDurationMs, activeBattle.scene.rate)
                val ease = liveEaseTicks(frameTicks, battleCorrection)
                battleCorrection -= ease
                battleTick = (battleTick + frameTicks + ease).coerceAtMost(activeBattle.extent.visualEndTick)
            }
            skipAdvance = false
            progressElapsed += Gdx.graphics.deltaTime
        }
        batch.end(); drawCalls += batch.renderCalls
        if (activeBattle != null) commandDraws?.submitted(generation.get(), activeBattle.scene.revision.raidId,
            activeBattle.scene.revision.revision, !disposed && !layeredPaused && !scenePreparationFailed && sceneToken == generation.get())?.let {
            runCatching { onCommandBodiesSubmitted?.invoke(it) }
        }
        drawServiceOutlines(active, activeBattle)
        syncWallInput()
        if (activeBattle == null) drawHighlightStrokes(active)
        // A base revision in preparation keeps drawing the previous scene; its camera stays valid meanwhile.
        publishBaseCamera(active.takeIf { activeBattle == null })
        if (!scenePreparationFailed && sceneToken==generation.get()) {
            renderedSceneToken=sceneToken; presented = true
            if (preparationDrawToken != sceneToken) {
                preparationDrawToken = sceneToken
                activeBattle?.scene?.preparationTrace.observe(LocalPreparationStage.FIRST_DRAW)
            }
        }
        advanceDeploymentInput()
        if (activeBattle != null && !scenePreparationFailed && sceneToken==generation.get() && (progressPending || progressElapsed >= 0.25f)) {
            progressElapsed=0f;progressPending=false
            val frame = BattlePlaybackFrame(activeBattle.scene.revision.raidId, activeBattle.scene.revision.revision,
                renderedBattleTick, activeBattle.extent)
            onBattleFrame(frame)
            onBattleProgress(renderedBattleTick)
        }
        if (activeBattle != null && frameAudioEpoch >= 0 && onBattleAudioFrame != null &&
            !scenePreparationFailed && sceneToken == generation.get()) {
            val owned = activeBattle.audioActorIds.mapNotNull { id ->
                val model = activeBattle.model
                if ((model.deployTick(id) ?: Int.MAX_VALUE) > renderedBattleTick ||
                    model.deathTick(id)?.let { it <= renderedBattleTick } == true) return@mapNotNull null
                if (!activeBattle.visuals.hasActorArt(id) && actorFrame(activeBattle, id)?.let { it in catalogue } != true) return@mapNotNull null
                BattleAudioActor(id, requireNotNull(model.actorIdentity(id)), model.pose(id, renderedBattleTick)?.visible == false, drawnKegPrimes[id])
            }
            onBattleAudioFrame.invoke(BattleAudioRenderFrame(activeBattle.scene.revision.raidId,
                activeBattle.scene.revision.revision, renderedBattleTick, activeBattle.scene.playing,
                activeAudioToken, frameAudioEpoch, owned))
        }
        if(activeBattle!=null && sensoryEpoch>=0 && !scenePreparationFailed && sceneToken==generation.get() &&
            sensoryAdmissionEpoch(activeBattle.scene.revision.raidId,activeBattle.scene.revision.revision,activeAudioToken)==sensoryEpoch)
            onSensoryFrame?.invoke(SensoryFrame(sensoryEpoch,++sensorySequence,hapticRequests,activeAudioToken))
        samplePerformance(if (activeBattle == null) "base" else "battle", drawCalls)
    }

    private var publishedCamera: BaseCameraView? = null
    private var drawnCamera: BaseCameraView? = null
    private val cameraOverlay = BaseCameraOverlay()
    private val uiCameraContact = java.util.concurrent.atomic.AtomicBoolean(false)
    private val pendingCameraContact = java.util.concurrent.atomic.AtomicBoolean(false)
    /** UI dispatch hides chrome before libGDX can move its independent surface. Never changes input admission. */
    fun setBaseCameraContact(active: Boolean) { if (active) pendingCameraContact.set(true); uiCameraContact.set(active) }
    /** Publish the drawn projection and its settled visibility together. Idle Home retains its camera object. */
    private fun publishBaseCamera(active: BaseScene?) {
        val sink = onBaseCamera ?: return
        val width = viewport.screenWidth; val height = viewport.screenHeight
        drawnCamera = if (active == null || width <= 0 || height <= 0) null
            else drawnCamera?.takeIf { it.matches(active.baseId, camera.position.x, camera.position.y, camera.zoom, width, height, cameraFraming.moved) }
                ?: BaseCameraView(active.baseId, camera.position.x, camera.position.y, camera.zoom, width, height, moved = cameraFraming.moved)
        val began = pendingCameraContact.getAndSet(false)
        val next = cameraOverlay.frame(drawnCamera, began || uiCameraContact.get() || pointers.isNotEmpty())
        if (next != publishedCamera) { publishedCamera = next; sink(next) }
    }

    private fun samplePerformance(activeScene: String, drawCalls: Int) {
        val epoch = diagnosticsEpoch.get()
        if (sampledDiagnosticsEpoch != epoch) {
            diagnosticSample = null; diagnosticSummary = null; sampledDiagnosticsEpoch = epoch
        }
        if (diagnosticsEnabled.get()) {
            if (diagnosticSample == null && onPerformanceSample != null) diagnosticSample = FrameTimeSampler(reportIntervalNanos = 1_000_000_000L)
            if (diagnosticSummary == null && onPerformanceSummary != null) diagnosticSummary = FrameTimeSampler()
        } else { diagnosticSample = null; diagnosticSummary = null }
        // Local reports are independent of performance/remote sampler admission. This estimates
        // AssetManager RGBA textures only; direct ground/wall/font textures and GPU overhead are excluded.
        // Unchanged frames only compare the loaded asset count.
        if (textureCount != assets.loadedAssets) {
            textureCount = assets.loadedAssets
            textureRgbaMiB = assets.assetNames.sumOf { path ->
                if (assets.isLoaded(path, Texture::class.java)) {
                    val texture = assets.get(path, Texture::class.java)
                    texture.width.toLong() * texture.height * 4
                } else 0L
            } / (1024.0 * 1024)
        }
        if (performance == null && diagnosticSample == null && diagnosticSummary == null) return
        val now = System.nanoTime()
        performance?.frame(now, activeScene, drawCalls, textureRgbaMiB)?.let { performanceSink?.invoke(it.toJson()) }
        diagnosticSample?.frame(now, activeScene, drawCalls, textureRgbaMiB)?.let { onPerformanceSample?.invoke(it) }
        diagnosticSummary?.frame(now, activeScene, drawCalls, textureRgbaMiB)?.let { onPerformanceSummary?.invoke(it) }
    }

    // The base preparation already parsed the static art for publish (staticArtByKey) on this same worker, and this job queues
    // behind it: reuse that parse instead of repeating it on the opening path. Same entries (a duplicate key keeps the last).
    private fun loadCatalogue(): List<Art> = staticArtByKey.values.toList()

    private fun prepareScene(next: BaseScene, walls: WallVisualModel) {
        drawables.clear()
        wallSeats.clear()
        wallSpec?.let { spec -> for (building in next.buildings) if (building.type == "wall") wallSeats[building.id] = wallSeat(spec, building, next.tilePixels) }
        val scenery = if(battle==null) next.obstacles.map { RenderBuilding(it.id,it.frameKey,it.tileX,it.tileY,it.footprintWidth,it.footprintHeight) } else emptyList()
        (next.buildings.filter { it.service == null }.map { it.frameKey } + scenery.map { it.frameKey } + walls.requiredFrames + next.terrainFrameKey).distinct().forEach { key ->
            val art = catalogue[key]
            if (art == null) report("Missing approved artwork catalogue entry: $key")
            else runCatching { requestAtlas(art.atlasPath) }.onFailure { report("Artwork ${art.atlasPath}: ${it.message}") }
        }
        for (original in next.buildings + scenery) {
            if (original.service != null) {
                // Logical footprint remains selectable even with absent optional pixels.
                drawables += Drawable(original, Art(original.frameKey,"",1f,.5f,1f,0f,0f),
                    SpritePlacement(original.tileX*next.tilePixels,original.tileY*next.tilePixels,
                        original.footprintWidth*next.tilePixels,original.footprintHeight*next.tilePixels,
                        (original.tileY+original.footprintHeight)*next.tilePixels))
                continue
            }
            val building = original.copy(frameKey = walls.frameAt(original.id, 0f) ?: original.frameKey)
            val art = catalogue[building.frameKey] ?: continue
            val packed = frames[building.frameKey]
            if (packed == null) { report("Missing approved atlas frame: ${building.frameKey}"); continue }
            drawables += Drawable(building, art, placeBuilding(building, next.tilePixels,
                packed.sourceWidth, packed.sourceHeight, art.scale, art.anchorX, art.offsetX, art.offsetY))
        }
        drawables.sortWith(compareBy<Drawable> { it.placement.depth }
            .thenBy { if (it.building.frameKey.startsWith("bld_wall_")) 0 else 1 })
        // All current drawables are rebuilt before texture residency changes. Frames never retain
        // an atlas belonging only to the previous scene.
    }

    private fun readAtlas(path: String): AtlasMetadata {
        val root = JsonReader().parse(safeFile(path))
        val textures = mutableSetOf<String>()
        val parsedFrames = mutableMapOf<String,PackedFrame>()
        for (page in root.get("textures")) {
            val image = page.getString("image")
            require(!image.contains('/') && !image.contains('\\') && image != "..")
            val texturePath = path.substringBeforeLast('/', "").let { if (it.isEmpty()) image else "$it/$image" }
            textures += texturePath
            for (frame in page.get("frames")) {
                require(!frame.getBoolean("rotated", false)) { "Rotated atlas frames require explicit conversion" }
                val bounds = frame.get("frame"); val source = frame.get("sourceSize"); val trim = frame.get("spriteSourceSize")
                parsedFrames[frame.getString("filename")] = PackedFrame(texturePath,
                    bounds.getInt("x"), bounds.getInt("y"), bounds.getInt("w"), bounds.getInt("h"),
                    source.getFloat("w"), source.getFloat("h"), trim.getFloat("x"), trim.getFloat("y"))
            }
        }
        require(textures.isNotEmpty()) { "An approved atlas contains no textures: $path" }
        return AtlasMetadata(textures,parsedFrames)
    }

    private fun requestAtlas(path: String) {
        if (path in requestedAtlases) return
        val metadata = requireNotNull(preparedAtlases[path]) { "Atlas was not prepared: $path" }
        queueSceneTextures(metadata.textures)
        atlasTextures[path] = metadata.textures
        requestedAtlases += path
    }

    private fun queueSceneTextures(textures: Set<String>) {
        for (path in textures) {
            if (!serviceTextureFiles.containsKey(path)) { queueMissingSceneAssets(assets,listOf(path),Texture::class.java); continue }
            if (assets.contains(path)) continue
            val existing=serviceTexturePixels[path]
            val pixels=existing ?: requireNotNull(staged?.services?.allAtlases?.values?.singleOrNull { it.texture == path }).pixels.retain().also {
                serviceTexturePixels[path]=it
            }
            try {
                // Pinned TextureLoader only checks isPrepared in loadAsync when
                // textureData is supplied: no file/Pixmap read can outlive cancel.
                assets.load(path,Texture::class.java,TextureLoader.TextureParameter().also { it.textureData=pixels.data })
            } catch (error: Exception) { if (existing == null) { serviceTexturePixels.remove(path); pixels.close() }; throw error }
        }
    }

    private fun atlasesReady(paths: Set<String>) = paths.all { atlas ->
        atlas in requestedAtlases && atlasTextures[atlas]?.all { assets.isLoaded(it,Texture::class.java) } == true
    }

    private fun discardStaging() {
        val previous = staged
        staged = null
        when {
            stagedGround != null -> stagedGround?.dispose()
            stagedLayeredGround != null -> stagedLayeredGround?.dispose()
            stagedRealmKit != null -> stagedRealmKit?.dispose()
            else -> previous?.update?.ground?.discard()
        }
        stagedGround = null; stagedLayeredGround = null; stagedRealmKit = null
        wallAtlas?.prepare(wallFrames?.keys.orEmpty(), emptyMap())
        if (::assets.isInitialized) releaseUnusedAtlases(sceneAtlases)
        preparedAtlases = preparedAtlases.filterKeys { it in sceneAtlases }
        previous?.services?.let { retiringServiceAssets += it }
        if (::assets.isInitialized) drainServiceAssets()
    }

    /** A cancelled asynchronous texture load can still own its input. Release only
     * after AssetManager drains it, or another active lease covers identical files. */
    private fun drainServiceAssets() {
        val protected = listOfNotNull(activeServiceAssets, staged?.services).flatMap { it.allAtlases.values }.map { it.texture }.toSet()
        val iterator = retiringServiceAssets.iterator()
        while (iterator.hasNext()) {
            val retired = iterator.next()
            if (retired.allAtlases.values.all { it.texture in protected || !assets.contains(it.texture) }) { retired.close(); iterator.remove() }
        }
        val retained = protected + retiringServiceAssets.flatMap { it.allAtlases.values }.map { it.texture }
        serviceTextureFiles.keys.retainAll(retained.toSet())
        serviceTexturePixels.keys.filter { !assets.contains(it) }.forEach { serviceTexturePixels.remove(it)?.close() }
    }

    /** A device/decoder refusal of optional pixels must not hide the logical base.
     * Drop only this staging bundle's service layers; legacy failures retain their
     * existing scene-failure path. Cancelled inputs keep their leases until drained. */
    private fun discardStagedServiceArt() {
        val previous=staged ?: return
        val empty=ServiceSceneAssets(emptyMap(),emptyMap(),emptyList())
        val base=when(val update=previous.update) { is SceneUpdate.Base -> update.scene; is SceneUpdate.Battle -> update.prepared.scene.base }
        val textures=previous.services.allAtlases.values.map { it.texture }.toSet()
        val atlas=previous.atlases.filterKeys { it !in previous.services.paths }
        fleetJourneys.revokeDelivery(previous.update.token) { generation.get() } // only the current delivery may void its ticket
        staged=previous.copy(atlases=atlas,frames=previous.frames.filterValues { it.texturePath !in textures }.toMutableMap(),
            services=empty,serviceVisuals=ServiceSceneVisuals(empty,base,0),journeyTicket=null)
        preparedAtlases=preparedAtlases.filterKeys { it in sceneAtlases || it in atlas }
        releaseUnusedAtlases(sceneAtlases + atlas.keys)
        retiringServiceAssets += previous.services
        onDiagnostic("Service artwork is unavailable on this device; logical footprints remain visible")
    }

    /** Read on Main after dispatch as well as before emitting from GL. */
    fun isCurrentPreparation(notice: ScenePreparationNotice) = notice.isCurrent(generation.get(), disposed)

    private fun preparationNotice(notice: ScenePreparationNotice) {
        if (isCurrentPreparation(notice)) runCatching { onPreparationError?.invoke(notice) }
    }

    private fun failPreparation(message: String, token: Long) {
        val notice = ScenePreparationNotice(token, message, fatal = scene == null)
        // CONTINUITY: the CURRENT request failed — its preserved originals, admission and authorizing lifetime end under the monitor
        // BEFORE cleanup/notification; a late install carrying this request's ticket is refused and nothing resumes drawing.
        if (!fleetJourneys.failPreparation { isCurrentPreparation(notice) }) return
        preparationTrace.get()?.takeIf { it.first == token }?.second.end(LocalPreparationOutcome.FAILED)
        discardStaging()
        if (notice.fatal) {
            // Direct renderer users retain onError. The Android host handles this through the
            // generation-fenced Main callback; equal errors in two generations must both deliver.
            if (onPreparationError == null) report(message)
            else { renderedSceneToken = -1L; scenePreparationFailed = true; preparationNotice(notice) }
        } else { onDiagnostic(message); preparationNotice(notice) }
    }

    /** A prior commit can change the ground after a worker decided to reuse it. Keep the same
     * generation and playback ownership while repairing only that delivery's painting. */
    private fun reprepareGround(update: SceneUpdate, journeyTicket: Long?) {
        // N-C5 RESIDENCY R2: the re-published delivery is authorized by the ARMED delivery's own ticket (its arming re-checks
        // that ticket as the predecessor: still current → a new ticket, revoked since → refused). A delivery that was never
        // armed or already lost its ticket carries a predecessor no lifetime equals and arms nothing. No fresh authority.
        val predecessor = journeyTicket ?: FleetJourneyPlayback.STALE_PREDECESSOR
        preparation.submit(update.token) {
            if (disposed || generation.get() != update.token) return@submit
            try {
                val base = when(update) { is SceneUpdate.Base -> update.scene; is SceneUpdate.Battle -> update.prepared.scene.base }
                val replacement = prepareGround(base,force = true, checkpoint = { checkPreparation(update.token) })
                publish(when(update) { is SceneUpdate.Base -> update.copy(ground = replacement, journeyPredecessor = predecessor)
                    is SceneUpdate.Battle -> update.copy(ground = replacement, journeyPredecessor = predecessor) })
            } catch (error: Exception) {
                if (!disposed && generation.get() == update.token) preparationFailure.set(update.token to "Ground preparation: ${error.message}")
            }
        }
    }

    private fun releaseUnusedAtlases(needed: Set<String>) {
        textureCount = -1
        val retainedTextures = needed.flatMap { atlasTextures[it].orEmpty() }.toSet()
        for (path in requestedAtlases.filter { it !in needed }) {
            for (texturePath in atlasTextures[path].orEmpty()) if(texturePath !in retainedTextures) {
                frames.values.filter { it.texturePath == texturePath }.forEach { it.region = null }
                if (assets.contains(texturePath)) assets.unload(texturePath)
            }
            requestedAtlases.remove(path); atlasTextures.remove(path)
        }
    }

    private fun drawTerrain(active: BaseScene) {
        // Revision-5 props are ground, not structures: they draw right over the floor, under every
        // building, obstacle and actor, exactly where web (E-7: ground band `1 + layer`) and the deed
        // rasterizer put them. E-6 amended lets a prop share tiles with troops and kingdom rows, so
        // the three surfaces must sort it alike — and a wilderness tree the player cannot clear must
        // never cover a building on the kingdom's last row.
        realmKit?.let { it.drawFloor(active.tilePixels, realmKitClaim(active)); it.drawProps(active.tilePixels); return }
        layeredGround?.let { it.drawFloor(active.tilePixels); return }
        ground?.let { painted -> painted.draw(active.tilePixels); return }
        val bounds=if(active.battlefield?.let { it.version!=it.legacyVersion }==true) BaseWorldBounds(
            camera.position.x-camera.viewportWidth*camera.zoom/2,camera.position.y-camera.viewportHeight*camera.zoom/2,
            camera.position.x+camera.viewportWidth*camera.zoom/2,camera.position.y+camera.viewportHeight*camera.zoom/2) else terrainBounds ?: return
        val art = catalogue[active.terrainFrameKey] ?: return
        val width = camera.viewportWidth * camera.zoom / 2
        val height = camera.viewportHeight * camera.zoom / 2
        val startX = floor((camera.position.x - width) / active.tilePixels).toInt().coerceAtLeast(floor(bounds.left/active.tilePixels).toInt())
        val endX = ceil((camera.position.x + width) / active.tilePixels).toInt().coerceAtMost(ceil(bounds.right/active.tilePixels).toInt())
        val startY = floor((camera.position.y - height) / active.tilePixels).toInt().coerceAtLeast(floor(bounds.top/active.tilePixels).toInt())
        val endY = ceil((camera.position.y + height) / active.tilePixels).toInt().coerceAtMost(ceil(bounds.bottom/active.tilePixels).toInt())
        val frame = frames[art.key] ?: return
        val region = region(frame) ?: return
        for (y in startY until endY) for (x in startX until endX) {
            batch.draw(region, x * active.tilePixels, y * active.tilePixels,
                frame.width * art.scale, frame.height * art.scale)
        }
    }

    /** [dx], [dy]: a world-unit nudge off the seat (the selection outline's offset draws); zero for the art itself. */
    private fun draw(art: Art, placement: SpritePlacement, dx: Float = 0f, dy: Float = 0f): Boolean {
        val frame = frames[art.key] ?: return false
        val region = region(frame) ?: return false
        val halfWidth = camera.viewportWidth * camera.zoom / 2
        val halfHeight = camera.viewportHeight * camera.zoom / 2
        if (art.rotation == 0f && (placement.left > camera.position.x + halfWidth || placement.left + placement.width < camera.position.x - halfWidth ||
            placement.top > camera.position.y + halfHeight || placement.top + placement.height < camera.position.y - halfHeight)) return false
        val drawnWidth = minOf(frame.width.toFloat(), art.cropWidth / art.horizontalScale - frame.trimX)
        if (drawnWidth <= 0 || art.horizontalScale <= 0) return false
        val visibleRegion = if (drawnWidth < frame.width) {
            croppedRegion.setRegion(region)
            croppedRegion.regionWidth = kotlin.math.ceil(drawnWidth).toInt()
            croppedRegion
        } else region
        if (art.rotation != 0f) batch.draw(visibleRegion, placement.left + dx + frame.trimX * art.horizontalScale, placement.top + dy + frame.trimY * art.scale,
            (frame.sourceWidth * art.anchorX - frame.trimX) * art.horizontalScale, (frame.sourceHeight * art.anchorY - frame.trimY) * art.scale,
            drawnWidth * art.horizontalScale, frame.height * art.scale, 1f, 1f, art.rotation)
        else batch.draw(visibleRegion, placement.left + dx + (if (art.flipX) frame.sourceWidth - frame.trimX else frame.trimX) * art.horizontalScale, placement.top + dy + frame.trimY * art.scale,
            drawnWidth * art.horizontalScale * if (art.flipX) -1f else 1f, frame.height * art.scale)
        return true
    }

    /** Measure only the pixels' submitted rectangle, not transparent source padding.
     * Current actor bodies are unrotated; unsupported rotations remain unmeasured. */
    private fun commandBodyVisible(art: Art, placement: SpritePlacement): Boolean {
        val frame = frames[art.key] ?: return false
        return commandBodyIntersectsViewport(art, placement, frame.sourceWidth, frame.trimX, frame.trimY,
            frame.width.toFloat(), frame.height.toFloat(), sensoryProjection, commandBodyCorner)
    }

    /** A five-tier wall's composed frame at [tick], seated like the web's contextual sprite. Breaches at
     * or before [seekFloor] were jumped over (scene start or a seek) and rest at their final rubble. */
    private fun composedWall(id: String, tick: Float, seekFloor: Float = Float.NEGATIVE_INFINITY): Boolean {
        composedRegion = null; composedSeat = null
        val ref = wallFrames?.frameAt(id, tick, seekFloor) ?: return false
        val seat = wallSeats[id] ?: return false
        val region = wallAtlas?.region(ref.key) ?: return false
        composedRegion = region; composedSeat = seat
        return true
    }

    private fun drawBase(nowMs: Long) {
        val nowNanos = System.nanoTime()
        val priorCampFrame = campFrameNanos
        campFrameNanos = nowNanos
        campVisuals.advance(if (priorCampFrame == 0L) 0f else (nowNanos - priorCampFrame) / 1_000_000f, reducedMotion)
        val visuals=baseVisuals
        val active = scene ?: return
        val tilePixels = active.tilePixels
        val carried = carry.visual
        // E-11: on revision-5 ground a server obstacle row draws the kit's own twin (web BaseScene.styleObstacle,
        // the deed) in place of its `dec_` drawable; a key the kit leaves unmapped keeps the catalogue art. A
        // row under a running clear job shows the kit's `clearing` state, which falls back to intact.
        val kitObstacles: Map<String, Pair<TextureRegion, LayeredGroundRect>> = kitObstacleTwins(active)
        // E-11 remnants (`clearedObstacles[]`): the kit's stump/rubble twin on the seat of every row the player
        // felled, keyed like the row it replaces — its footprint's south edge — and hidden under anything standing
        // there (web BaseScene.syncRemnants). Only the kit sheet has remnant twins, so without a revision-5 ground
        // (or on a pack without depth rules, which has no kit) the tile stays bare, exactly as on web.
        val kitRemnants: List<Triple<TextureRegion, LayeredGroundRect, Float>> = realmKit?.let { surface -> active.remnants.mapNotNull { r ->
            if (active.remnantCovered(r, carried.held)) null
            else surface.remnant(r, tilePixels)?.let { (region, d) -> Triple(region, d, (r.tileY + r.footprintHeight) * tilePixels) }
        } }.orEmpty()
        if(visuals==null) {
            // Packs without a base presentation contract have no depth rules.
            for(drawable in drawables) {
                if (drawable.building.service != null) { drawServiceHome(drawable.building, nowMs, drawable.placement.depth); continue }
                val id = drawable.building.id
                if (id in carried.liftedIds) continue
                val held = carried.held[id]
                if (held != null) { drawCarried(drawable, held, tilePixels); continue }
                val twin = kitObstacles[id]
                if (twin != null) { val (region, d) = twin; batch.draw(region, d.x.toFloat(), d.y.toFloat(), d.width.toFloat(), d.height.toFloat()); continue }
                if(composedWall(id,0f)) { val seat=composedSeat!!;batch.draw(composedRegion!!,seat.left,seat.top,seat.width,seat.height) }
                else draw(drawable.art,drawable.placement)
            }
            drawLifted(carried, tilePixels)
            return
        }
        basePaintOrder.clear()
        fun add(drawable: Drawable?,sprite: BaseVisualSprite?,depth: Float,region: TextureRegion?=null,seat: SpritePlacement?=null,serviceId: String?=null,alpha: Float=1f,frame: PackedFrame?=null,outline: String?=null) {
            val index=basePaintOrder.size
            if(index==basePaintPool.size) basePaintPool+=BasePaint()
            val item=basePaintPool[index];item.alpha=alpha;item.frame=frame;item.drawable=drawable;item.sprite=sprite;item.depth=depth;item.region=region;item.seat=seat;item.serviceId=serviceId;item.outline=outline;basePaintOrder+=item
        }
        for(drawable in drawables) {
            val id = drawable.building.id
            if (id in carried.liftedIds) continue
            val held = carried.held[id]
            val outline = outlineKey(id)
            if (drawable.building.service != null) {
                if (servicePixelsCurrent()) {
                    val building = held?.let { drawable.building.copy(tileX=it.tx.toFloat(),tileY=it.ty.toFloat()) } ?: drawable.building
                    serviceSprites.clear()
                    serviceVisuals?.sprites(building,nowMs,visuals.structureDepth((building.tileY+building.footprintHeight)*tilePixels),serviceSprites)
                    serviceSprites.forEach { add(null,it,it.depth,serviceId=if(localDiagnostics?.observeServiceFrames==true) building.id else null,outline=outline) }
                    // N-C5: a journey in flight on this berth (authored offsets AND opacity), never stored on the scene.
                    journeySprites.clear()
                    fleetJourneys.sprites(building,nowMs,visuals.structureDepth((building.tileY+building.footprintHeight)*tilePixels),tilePixels,journeySprites)
                    journeySprites.forEach { add(null,it.sprite,it.sprite.depth,alpha=it.alpha,frame=journeyFrames.getOrPut(it.cell) {
                        PackedFrame(it.cell.texture,it.cell.x,it.cell.y,it.cell.width,it.cell.height,it.cell.width.toFloat(),it.cell.height.toFloat(),0f,0f) }) }
                } else {
                    // CONTINUITY: while a request is pending (generation advanced, no admission yet) ONLY a proven already-running original
                    // may keep drawing — bound to the current request, lifetime, still-owned ACTIVE assets, source, capability and permission.
                    // Static service art and new ingress keep the ordinary generation gate above; nothing else is relaxed.
                    val building = held?.let { drawable.building.copy(tileX=it.tx.toFloat(),tileY=it.ty.toFloat()) } ?: drawable.building
                    if (continuityPixelsCurrent(building)) {
                        journeySprites.clear()
                        fleetJourneys.sprites(building,nowMs,visuals.structureDepth((building.tileY+building.footprintHeight)*tilePixels),tilePixels,journeySprites)
                        journeySprites.forEach { add(null,it.sprite,it.sprite.depth,alpha=it.alpha,frame=journeyFrames.getOrPut(it.cell) {
                            PackedFrame(it.cell.texture,it.cell.x,it.cell.y,it.cell.width,it.cell.height,it.cell.width.toFloat(),it.cell.height.toFloat(),0f,0f) }) }
                    }
                }
                continue
            }
            if (held != null) {
                // A dropped piece seats on its held tile (web `reseatSettlingMoves`): static art, depth from that tile.
                val depth = visuals.structureDepth(drawable.placement.depth + (held.ty - drawable.building.tileY) * tilePixels)
                if (composedWall(id, 0f)) add(null, null, depth, composedRegion, shifted(composedSeat!!, drawable, held, tilePixels), outline = outline)
                else add(drawable.copy(placement = shifted(drawable.placement, drawable, held, tilePixels)), null, depth, outline = outline)
                continue
            }
            if(composedWall(id,0f)) { add(null,null,visuals.structureDepth(drawable.placement.depth),composedRegion,composedSeat,outline=outline);continue }
            val twin = kitObstacles[id]
            if (twin != null) {
                // Same depth key as the `dec_` drawable it replaces: the row's world south edge.
                val (region, d) = twin
                add(null, null, visuals.structureDepth(drawable.placement.depth), region,
                    SpritePlacement(d.x.toFloat(), d.y.toFloat(), d.width.toFloat(), d.height.toFloat(), drawable.placement.depth), outline = outline)
                continue
            }
            val sprite=visuals.building(id,nowMs)
            add(if(sprite==null) drawable else null,sprite,sprite?.depth ?: visuals.structureDepth(drawable.placement.depth),outline=outline)
        }
        for ((region, d, south) in kitRemnants) add(null, null, visuals.structureDepth(south), region,
            SpritePlacement(d.x.toFloat(), d.y.toFloat(), d.width.toFloat(), d.height.toFloat(), south))
        visuals.jobs(nowMs,baseSprites)
        val campStart = baseSprites.size
        campVisuals.sprites(baseSprites, reducedMotion)
        campDrawn = 0; campFrameHash = 1
        if (localDiagnostics?.observeCampFrames==true) for (index in campStart until baseSprites.size) {
            val sprite = baseSprites[index]
            val packed = frames[sprite.frameKey]
            if (packed != null && region(packed) != null) campDrawn++
            campFrameHash = 31 * campFrameHash + sprite.frameKey.hashCode()
        }
        baseSprites.forEach { add(null,it,it.depth) }
        basePaintOrder.sortBy { it.depth }
        var previousOutline: String? = null
        for(index in basePaintOrder.indices) {
            val item=basePaintOrder[index]
            // The selected sprite's gold rim goes down just before its first layer, so that layer covers all but the
            // rim and anything standing in front still covers the rim.
            val outline=item.outline
            if(outline!=null && outline!=previousOutline) drawOutlineRun(index,outline)
            previousOutline=outline
            item.region?.let { region -> val seat=item.seat!!;batch.draw(region,seat.left,seat.top,seat.width,seat.height) }
            item.drawable?.let { draw(it.art,it.placement) }
            item.sprite?.let { sprite ->
                val frame=item.frame ?: frames[sprite.frameKey] ?: return@let // a journey sprite draws ITS verified cell
                val region=region(frame) ?: return@let
                val scaleX=sprite.width/frame.sourceWidth;val scaleY=sprite.height/frame.sourceHeight
                if(item.alpha!=1f) batch.setColor(1f,1f,1f,item.alpha)
                batch.draw(region,sprite.x-sprite.width*sprite.anchorX+frame.trimX*scaleX,
                    sprite.y-sprite.height*sprite.anchorY+frame.trimY*scaleY,frame.width*scaleX,frame.height*scaleY)
                if(item.alpha!=1f) batch.setColor(Color.WHITE)
                item.serviceId?.let { observeServiceSprite(it,sprite.frameKey) }
            }
        }
        drawLifted(carried, tilePixels)
    }

    private var kitTwinScene: BaseScene? = null
    private var kitTwinSurface: RealmKitSurface? = null
    private var kitTwins: Map<String, Pair<TextureRegion, LayeredGroundRect>> = emptyMap()
    /** The E-11 kit twins of [active]'s obstacle rows (a `clearing` row under its running clear job). They depend only on
     *  the scene (rows, jobs, tile size) and the kit surface, so they are built once per scene instead of on every frame
     *  (a map, a pair and a kit draw per obstacle per frame before). */
    private fun kitObstacleTwins(active: BaseScene): Map<String, Pair<TextureRegion, LayeredGroundRect>> {
        val surface = realmKit
        if (active !== kitTwinScene || surface !== kitTwinSurface) {
            val tilePixels = active.tilePixels
            kitTwins = surface?.let { kit -> active.obstacles.mapNotNull { row ->
                val clearing = active.jobs.any { it.kind == "clear_obstacle" && it.buildingId == null && it.targetX == row.tileX && it.targetY == row.tileY }
                kit.obstacle(row, if (clearing) RealmKitObstacleState.CLEARING else RealmKitObstacleState.INTACT, tilePixels)?.let { row.id to it }
            }.toMap() }.orEmpty()
            kitTwinScene = active; kitTwinSurface = surface
        }
        return kitTwins
    }

    /** The id whose sprite wears the selection's gold outline: a SELECTION or OUTLINE target, or the marker's own
     * target while it fades out after a deselect. Null for every other sprite. */
    private fun outlineKey(id: String): String? =
        if (id in outlineIds || (id == selectionTargetId && selectionMotion.visible)) id else null

    /**
     * DESIGN-SYSTEM §Selection: a 2 dp gold-hi outline on the selected sprite, as four 2 dp offset draws of every layer
     * in this building's run ([start] onward while the paint item carries [key]) in flat gold, under the run's own
     * draws. Two shader switches per selected building; nothing is allocated.
     */
    private fun drawOutlineRun(start: Int, key: String) {
        // The marked building's rim follows the marker's fade; a wall-row piece's rim is simply on.
        val alpha = if (key == selectionTargetId && selectionMotion.visible) selectionMotion.outlineAlpha else 1f
        if (alpha <= 0f || selectionOutlineUnavailable) return
        val shader = selectionOutlineShader ?: SelectionOutlineShader.create().also { selectionOutlineShader = it }
        if (shader == null) { selectionOutlineUnavailable = true; return }
        val offset = SelectionChrome.SPRITE_OUTLINE_DP * HighlightGeometry.worldPerDp(Gdx.graphics.density, camera.zoom)
        val color = SelectionChrome.GOLD_HI
        batch.shader = shader
        batch.setColor((color shr 16 and 255) / 255f, (color shr 8 and 255) / 255f, (color and 255) / 255f, alpha)
        var index = start
        while (index < basePaintOrder.size && basePaintOrder[index].outline == key) {
            val item = basePaintOrder[index]
            drawSilhouette(item, offset, 0f); drawSilhouette(item, -offset, 0f)
            drawSilhouette(item, 0f, offset); drawSilhouette(item, 0f, -offset)
            index++
        }
        batch.shader = null
        batch.setColor(Color.WHITE)
    }

    /** One paint item drawn [dx], [dy] world units off its seat, in whatever colour and shader the batch holds. */
    private fun drawSilhouette(item: BasePaint, dx: Float, dy: Float) {
        item.region?.let { region -> val seat = item.seat ?: return@let; batch.draw(region, seat.left + dx, seat.top + dy, seat.width, seat.height) }
        item.drawable?.let { draw(it.art, it.placement, dx, dy) }
        item.sprite?.let { sprite ->
            val frame = item.frame ?: frames[sprite.frameKey] ?: return@let
            val region = region(frame) ?: return@let
            val scaleX = sprite.width / frame.sourceWidth; val scaleY = sprite.height / frame.sourceHeight
            batch.draw(region, sprite.x - sprite.width * sprite.anchorX + frame.trimX * scaleX + dx,
                sprite.y - sprite.height * sprite.anchorY + frame.trimY * scaleY + dy, frame.width * scaleX, frame.height * scaleY)
        }
    }

    /** `placement` moved from the drawable's scene tile to `tile`, in whole tiles (web `positionBuilding`). */
    private fun shifted(placement: SpritePlacement, drawable: Drawable, tile: CarryTile, tilePixels: Float): SpritePlacement {
        val dx = (tile.tx - drawable.building.tileX) * tilePixels; val dy = (tile.ty - drawable.building.tileY) * tilePixels
        return SpritePlacement(placement.left + dx, placement.top + dy, placement.width, placement.height, placement.depth + dy)
    }
    /** CONTINUITY draw gate for a preserved original only: permission/pause/source/base-mode as the ordinary gate, WITHOUT the installed-token
     *  equality (the request is pending by definition), plus the monitor's own binding of that original to the current request token,
     *  lifetime, still-owned active assets, source and capability. */
    private fun continuityPixelsCurrent(building: RenderBuilding) = fleetJourneys.continuityDrawable(
        building, activeServiceAssets, serviceSource, fleetCapability, generation.get(),
        serviceArtEnabled && !layeredPaused && !disposed && battle == null && scene?.services?.phaseEArtEnabled == true)
    private fun servicePixelsCurrent() = serviceArtEnabled && !layeredPaused && sceneToken == generation.get() &&
        runCatching { serviceSource?.isCurrent() == true }.getOrDefault(false) &&
        (battle != null || scene?.services?.phaseEArtEnabled == true)

    private fun drawServiceHome(building: RenderBuilding, nowMs: Long, depth: Float) {
        if (!servicePixelsCurrent()) return
        serviceSprites.clear(); serviceVisuals?.sprites(building,nowMs,depth,serviceSprites)
        for (sprite in serviceSprites) {
            val frame=frames[sprite.frameKey] ?: continue
            val region=region(frame) ?: continue
            batch.draw(region,sprite.x-sprite.width*sprite.anchorX,sprite.y-sprite.height*sprite.anchorY,sprite.width,sprite.height)
            if (localDiagnostics?.observeServiceFrames == true) observeServiceSprite(building.id,sprite.frameKey)
        }
    }

    private fun observeServiceSprite(id: String, frame: String) {
        if (observedServiceIdentities.add(id)) observedServiceDrawn++
        observedServiceLayers++; observedServiceFrameHash = 31 * observedServiceFrameHash + frame.hashCode()
    }

    /** Missing optional art leaves a visible, selectable footprint. Construction
     * does not invent scaffold pacing or a guessed occupied/empty berth body. */
    private fun drawServiceOutlines(active: BaseScene, combat: PreparedBattle?) {
        val missing=active.buildings.filter { building ->
            if (building.service == null) false else {
                val state=if(combat==null)null else when {
                    combat.model.isDestroyed(building.id,battleTick) -> ServiceCombatState.COLLAPSE
                    combat.visuals.buildingHealthAt(building.id,battleTick)?.damagedSinceTick != null -> ServiceCombatState.DAMAGED
                    else -> ServiceCombatState.IDLE
                }
                !servicePixelsCurrent() || serviceVisuals?.available(building.id,state) != true
            }
        }
        if (missing.isEmpty()) return
        shapes.projectionMatrix=camera.combined
        shapes.begin(ShapeRenderer.ShapeType.Line); shapes.setColor(.68f,.73f,.77f,1f)
        for (building in missing) {
            // The selection frame already marks this footprint; a grey line over its gold rim would only muddy it.
            if (combat == null && building.id == selectionTargetId && selectionMotion.visible) continue
            val held=if(combat==null)carry.visual.held[building.id] else null
            shapes.rect((held?.tx?.toFloat() ?: building.tileX)*active.tilePixels,(held?.ty?.toFloat() ?: building.tileY)*active.tilePixels,
                building.footprintWidth*active.tilePixels,building.footprintHeight*active.tilePixels)
        }
        shapes.end()
        if (localDiagnostics?.observeServiceFrames == true) observedServiceOutlines = missing.size
    }

    private fun drawCarried(drawable: Drawable, tile: CarryTile, tilePixels: Float) {
        if (drawable.building.service != null) {
            drawServiceHome(drawable.building.copy(tileX=tile.tx.toFloat(),tileY=tile.ty.toFloat()),System.currentTimeMillis(),(tile.ty+drawable.building.footprintHeight)*tilePixels)
        } else if (composedWall(drawable.building.id, 0f)) { val seat = shifted(composedSeat!!, drawable, tile, tilePixels); batch.draw(composedRegion!!, seat.left, seat.top, seat.width, seat.height) }
        else draw(drawable.art, shifted(drawable.placement, drawable, tile, tilePixels))
    }
    /** Lifted pieces ride above every base sprite at LIFT_ALPHA (web `liftPiece`: LIFT_DEPTH + LIFT_ALPHA). */
    private fun drawLifted(visual: CarryVisual, tilePixels: Float) {
        if (visual.lifted.isEmpty()) return
        batch.setColor(1f, 1f, 1f, BuildingCarryInput.LIFT_ALPHA)
        for (piece in visual.lifted) {
            val drawable = drawables.firstOrNull { it.building.id == piece.id } ?: continue
            drawCarried(drawable, CarryTile(piece.tx, piece.ty), tilePixels)
        }
        batch.setColor(Color.WHITE)
    }

    private fun drawBattle(prepared: PreparedBattle) {
        val state = prepared.scene
        val model = prepared.model
        val feedback=prepared.visuals.hitFeedback
        val cueTicks = (feedback?.policy?.flashMs ?: 100f) / state.tickDurationMs // historical fallback only
        fun hit(target:HitTarget,legacy:String)=feedback?.flashing(target,battleTick,battleCueFloor)
            ?: model.wasHit(legacy,battleTick,cueTicks,battleCueFloor)
        paintOrder.clear()
        liveTroopStacks.beginFrame()
        fun paint(art: Art, placement: SpritePlacement, hit: Boolean, alpha: Float = 1f, region: TextureRegion? = null) {
            val index = paintOrder.size
            if (index == paintPool.size) paintPool += Paint(art, placement, hit)
            val item = paintPool[index]
            item.art = art; item.placement = placement; item.hit = hit; item.alpha = alpha;item.stroke = null;item.region = region;item.kegPrime = null
            item.actorId = null; item.serviceId = null; item.serviceHit = null
            paintOrder += item
        }
        fun actorBody(id: Int, x: Float, y: Float, height: Float) {
            val item = paintOrder.last()
            item.actorId = id; item.actorX = x; item.actorY = y; item.actorHeight = height
            // Authored death clips still render. Only a living accepted actor counts.
            item.actorAlive = model.deathTick(id)?.let { battleTick < it } != false
        }
        fun paintCombat(sprite: CombatSprite, building: Boolean = false, actorId: Int? = null, target:HitTarget?=null) {
            val clip = sprite.clip
            val art = Art(sprite.frameKey, clip.atlasPath, clip.scale, if (sprite.flipX) 1f - clip.anchorX else clip.anchorX,
                if (building) 1f else clip.anchorY, 0f, 0f, flipX = sprite.flipX, rotation = sprite.rotation, cropWidth = sprite.cropWidth, horizontalScale = sprite.horizontalScale)
            sprite.ruin?.let(::ruinRegion)?.let { region ->
                // Same seat as the collapse cell it replaces: the ruin shares the pack cell size.
                // A missing resource falls through to the authored final frame below.
                val width = region.regionWidth * art.horizontalScale; val height = region.regionHeight * art.scale
                paint(art, SpritePlacement(sprite.x - width * art.anchorX, sprite.y - height * art.anchorY, width, height, sprite.depth),
                    target?.let { feedback?.flashing(it,battleTick,battleCueFloor) } ?: sprite.hit, sprite.alpha, region)
                return
            }
            val packed = frames[sprite.frameKey] ?: return
            val width = packed.sourceWidth * art.horizontalScale; val height = packed.sourceHeight * art.scale
            paint(art, SpritePlacement(sprite.x - width * art.anchorX, sprite.y - height * art.anchorY,
                width, height, sprite.depth), target?.let { feedback?.flashing(it,battleTick,battleCueFloor) } ?: sprite.hit, sprite.alpha)
            if(localDiagnostics?.observeServiceFrames==true) paintOrder.last().serviceHit=sprite.serviceHit?.let { Triple(it,sprite.x,sprite.y) }
            if (actorId != null) actorBody(actorId, sprite.x, sprite.y, height)
            if(actorId!=null && sprite.alpha>0) sprite.kegPrime?.let { paintOrder.last().kegPrime=actorId to it }
        }
        hpBarSeats.clear()
        fun seatBar(kind: HpBars.Kind, cx: Float, top: Float, fraction: Float) {
            val index = hpBarSeats.size
            if (index == hpBarPool.size) hpBarPool += HpBarSeat(kind, cx, top, fraction)
            val seat = hpBarPool[index]
            seat.kind = kind; seat.cx = cx; seat.top = top; seat.fraction = fraction
            hpBarSeats += seat
        }
        /** Web BattleScene.update building bars: the sprite's own top edge, the footprint-centred x. */
        fun buildingBar(building: Drawable) {
            val id = building.building.id
            val health = prepared.visuals.buildingHealthAt(id, battleTick) ?: return
            if (!HpBars.buildingVisible(health.hp, health.maxHp, building.building.type == "wall", model.isDestroyed(id, battleTick))) return
            val placement = paintOrder.last().placement
            seatBar(HpBars.Kind.BUILDING, placement.left + placement.width / 2, placement.top, HpBars.fraction(health.hp.toDouble(), health.maxHp))
        }
        /** Web BattleScene.update troop bars: `s.x`, `s.y - displayHeight`, shown once damaged, never on the dead. */
        fun actorBar(id: Int) {
            val item = paintOrder.last()
            if (item.alpha <= 0f) return
            val health = prepared.visuals.actorHealthAt(id, battleTick) ?: return
            if (!HpBars.troopVisible(health.hp, health.maxHp, item.actorAlive)) return
            seatBar(HpBars.Kind.TROOP, item.actorX, item.actorY - item.actorHeight, HpBars.fraction(health.hp, health.maxHp))
        }
        for (building in drawables) {
            if (building.building.service != null) {
                if (servicePixelsCurrent()) {
                    val id = building.building.id
                    val destroyed = model.destroyedTick(id)?.takeIf { battleTick >= it }
                    val health = prepared.visuals.buildingHealthAt(id,battleTick)
                    val state = when { destroyed != null -> ServiceCombatState.COLLAPSE
                        health?.damagedSinceTick != null -> ServiceCombatState.DAMAGED
                        else -> ServiceCombatState.IDLE }
                    serviceSprites.clear()
                    serviceVisuals?.sprites(building.building,0L,building.placement.depth,serviceSprites,state,
                        (battleTick-(destroyed ?: 0))*prepared.scene.tickDurationMs)
                    serviceSprites.forEach { sprite ->
                        val art=Art(sprite.frameKey,sprite.clip.atlasPath,sprite.clip.scale,sprite.anchorX,sprite.anchorY,0f,0f)
                        paint(art,SpritePlacement(sprite.x-sprite.width*sprite.anchorX,sprite.y-sprite.height*sprite.anchorY,
                            sprite.width,sprite.height,sprite.depth),hit(HitTarget.Building(id),id))
                        if (localDiagnostics?.observeServiceFrames == true) paintOrder.last().serviceId = id
                    }
                    if (serviceSprites.isNotEmpty()) buildingBar(building)
                }
                continue
            }
            if (composedWall(building.building.id, battleTick, battleCueFloor)) {
                // Composed five-tier walls replace the authored damaged/collapse cells; the hit cue stays.
                paint(building.art, composedSeat!!, hit(HitTarget.Building(building.building.id),building.building.id), region = composedRegion)
                buildingBar(building)
                continue
            }
            val animated = prepared.visuals.building(building.building.id, battleTick, cueTicks, battleCueFloor,
                prepared.walls.frameAt(building.building.id,battleTick),
                prepared.walls.frameSinceTick(building.building.id,battleTick) ?: 0)
            if (animated != null) { paintCombat(animated, building = true,target=HitTarget.Building(building.building.id)); if (frames[animated.frameKey] != null) buildingBar(building) }
            else if (!model.isDestroyed(building.building.id, battleTick)) {
                val frame = prepared.walls.frameAt(building.building.id,battleTick) ?: building.art.key
                val art = catalogue[frame] ?: building.art
                val packed = frames[frame]
                val placement = if (packed == null || frame == building.art.key) building.placement else
                    placeBuilding(building.building,state.base.tilePixels,packed.sourceWidth,packed.sourceHeight,
                        art.scale,art.anchorX,art.offsetX,art.offsetY)
                paint(art, placement, hit(HitTarget.Building(building.building.id),building.building.id))
                buildingBar(building)
            }
        }
        val unitScale = state.base.tilePixels / state.simUnitsPerTile
        for (id in model.actorIds) {
            if (prepared.visuals.hasActorArt(id)) {
                prepared.visuals.actor(id, battleTick, cueTicks, battleCueFloor)?.let { if (frames[it.frameKey] != null) { paintCombat(it,actorId=id,target=HitTarget.Actor(id)); actorBar(id) } }
                continue
            }
            val snappedPose = model.pose(id, battleTick, interpolate = false) ?: continue
            if (!snappedPose.visible) continue
            val key = actorFrame(prepared, id)
            if (key == null) { report("Missing approved battle actor mapping: ${snappedPose.identity}"); continue }
            val standingArt = catalogue[key] ?: continue
            val motion = standingArt.motion
            val movement = model.motion(id, battleTick)
            val direction = motion?.rowOrder?.indexOf(movement.facing)?.coerceAtLeast(0) ?: 0
            val animation = motion?.frames?.getOrNull(direction)
            val animationKey = if (motion == null || animation.isNullOrEmpty()) null else animation[
                ((battleTick * state.tickDurationMs / 1000 * motion.fps).toInt().coerceAtLeast(0) % animation.size)]
            val motionReady = animationKey?.let { frames[it]?.let { packed -> assets.isLoaded(packed.texturePath) } } == true
            val pose = if (motionReady) model.pose(id, battleTick)!! else snappedPose
            val art = if (motionReady && movement.moving && motion != null)
                standingArt.copy(key = animationKey, atlasPath = motion.atlasPath, scale = motion.scale,
                    anchorX = motion.anchorX, anchorY = motion.anchorY) else standingArt
            val packed = frames[art.key] ?: continue
            val width = packed.sourceWidth * art.scale
            val height = packed.sourceHeight * art.scale
            paint(art, SpritePlacement(pose.x * unitScale - width * art.anchorX + art.offsetX,
                pose.y * unitScale - height * art.anchorY + art.offsetY, width, height, pose.y * unitScale),
                hit(HitTarget.Actor(id),id.toString()))
            actorBody(id, pose.x * unitScale + art.offsetX, pose.y * unitScale + art.offsetY, height)
            actorBar(id)
        }
        // Canonical sensory hydration above has already removed promoted markers.
        // Pending silhouettes are opaque presentation only; no actor/model/order is created.
        val previews=deployPolicy?.takeIf {sceneToken==generation.get()}?.let { policy->
            policy.seats(deploymentPreview(state.revision.raidId,state.revision.revision,activeAudioToken),state.base.tilePixels)
        }.orEmpty()
        for(seat in previews) {
            val key=state.deploymentFrames[seat.mark.key.hero ?: seat.mark.key.troop] ?: continue
            val fallback=catalogue[key] ?: continue
            val elapsed=deployElapsed.getOrPut(seat.mark.id){0f}
            deployElapsed[seat.mark.id]=elapsed+Gdx.graphics.deltaTime*1000f*state.rate
            val original=combatLibrary[key]
            val clips=original?.let {deploymentClips(it,seat.mark.key.hero!=null)}
            val spawn=clips?.first
            val entering=spawn!=null && elapsed<spawn.durationMs
            val clip=if(entering)spawn else clips?.second
            val row=clip?.row("s") ?: 0
            val art=if(clip==null)fallback else fallback.copy(key=clip.frame(if(entering)elapsed else elapsed-(spawn?.durationMs ?: 0f),row,!entering),
                atlasPath=clip.atlasPath,scale=clip.scale,anchorX=clip.anchorX,anchorY=clip.anchorY,
                flipX=clip.flipX.getOrNull(row) ?: false)
            val packed=frames[art.key] ?: continue
            val width=packed.sourceWidth*art.scale;val height=packed.sourceHeight*art.scale
            paint(art,SpritePlacement(seat.x-width*art.anchorX+art.offsetX,seat.y-height*art.anchorY+art.offsetY,width,height,seat.depth),false)
        }
        feedback?.let { serviceHitCursor.retainVisible(battleTick,battleCueFloor,state.tickDurationMs,it.policy.starMs) }
        prepared.visuals.transientSprites(battleTick, combatSprites,battleCueFloor,feedback?.let { plan -> { cue ->
            serviceHitCursor.y(cue,plan.policy) { anchor ->
                if(servicePixelsCurrent()) activeServiceAssets?.hitBodyHeight(anchor.buildingId,anchor.state) ?: HIDDEN_SERVICE_BODY_HEIGHT
                else HIDDEN_SERVICE_BODY_HEIGHT
            }
        } })
        combatSprites.forEach { paintCombat(it) }
        prepared.visuals.transientStrokes(battleTick,combatStrokes)
        for(stroke in combatStrokes) {
            paint(strokeArt,SpritePlacement(stroke.fromX,stroke.fromY,0f,0f,stroke.depth),false)
            paintOrder.last().stroke = stroke
        }
        if(localDiagnostics?.observeServiceFrames==true) observedServiceHitTick=battleTick
        paintOrder.sortBy { it.placement.depth }
        var filling=false
        for (item in paintOrder) {
            val fill=feedback!=null && item.hit
            if(fill!=filling) { batch.shader=if(fill)hitFillShader else null;filling=fill }
            val tint=if(item.hit && !fill)0.55f else 1f
            val stroke = item.stroke
            val region = item.region
            if(region != null) {
                batch.setColor(1f,tint,tint,item.alpha)
                batch.draw(region, item.placement.left, item.placement.top, item.placement.width, item.placement.height)
            } else if(stroke != null) {
                batch.setColor(((stroke.color shr 16) and 255) / 255f,((stroke.color shr 8) and 255) / 255f,(stroke.color and 255) / 255f,stroke.alpha)
                val dx = stroke.toX - stroke.fromX;val dy = stroke.toY - stroke.fromY
                batch.draw(strokeTexture,stroke.fromX,stroke.fromY - stroke.width / 2,0f,stroke.width / 2,
                    hypot(dx,dy),stroke.width,1f,1f,(atan2(dy,dx) * 180 / PI).toFloat(),0,0,1,1,false,false)
            } else {
                batch.setColor(1f,tint,tint,item.alpha)
                if(draw(item.art, item.placement)) {
                    if (localDiagnostics?.observeServiceFrames == true) item.serviceId?.let { observeServiceSprite(it,item.art.key) }
                    if(localDiagnostics?.observeServiceFrames==true) item.serviceHit?.let { (cue,x,y)->
                        observedServiceHitDrawn++
                        observedServiceHitHash=31*observedServiceHitHash+cue.ordinal
                        observedServiceHitHash=31*observedServiceHitHash+cue.tick
                        observedServiceHitHash=31*observedServiceHitHash+item.art.key.hashCode()
                        observedServiceHitHash=31*observedServiceHitHash+x.toBits()
                        observedServiceHitHash=31*observedServiceHitHash+y.toBits()
                    }
                    item.kegPrime?.let { (id,prime)->drawnKegPrimes[id]=prime }
                    item.actorId?.let { id -> liveTroopStacks.drawn(id, item.actorX, item.actorY, item.actorHeight,
                        item.actorAlive, visible = true, alpha = item.alpha) }
                    item.actorId?.let { id -> commandDraws?.takeIf { it.needs(id) }?.drawn(id, item.actorAlive, item.alpha,
                        commandBodyVisible(item.art, item.placement)) }
                }
            }
            batch.setColor(1f, 1f, 1f, 1f)
        }
        if(filling)batch.shader=null
        drawHpBars(state.base.tilePixels)
        // Owner rule (D-140 §5, 2026-09-18): no text for deployed troops. The web still draws the ×N
        // badges over pending seats and coincident bodies; native draws none (bodies stack silently).
    }

    /** Web fx/hpbars.ts drawn above every sprite: a Night-Ink outline+backing rectangle, then the band fill.
     * Two quads from the shared white pixel per bar; the ledger lookups behind each seat are binary searches. */
    private fun drawHpBars(tilePixels: Float) {
        if (hpBarSeats.isEmpty()) return
        fun tint(rgb: Int, alpha: Float) = batch.setColor(((rgb shr 16) and 255) / 255f, ((rgb shr 8) and 255) / 255f, (rgb and 255) / 255f, alpha)
        for (seat in hpBarSeats) {
            val bar = HpBars.geometry(seat.kind, seat.cx, seat.top, seat.fraction, tilePixels)
            tint(HpBars.INK, HpBars.INK_ALPHA); batch.draw(strokeTexture, bar.outlineX, bar.outlineY, bar.outlineWidth, bar.outlineHeight)
            if (bar.fillWidth > 0f) { tint(bar.fillColor, 1f); batch.draw(strokeTexture, bar.fillX, bar.fillY, bar.fillWidth, bar.fillHeight) }
        }
        batch.setColor(1f, 1f, 1f, 1f)
    }

    private fun actorFrame(prepared: PreparedBattle, id: Int): String? =
        prepared.scene.actorFrames["#$id"] ?: prepared.scene.actorFrames[prepared.model.actorIdentity(id)]

    private fun region(frame: PackedFrame): TextureRegion? {
        frame.region?.let { return it }
        if (!assets.isLoaded(frame.texturePath)) return null
        val texture = assets.get(frame.texturePath, Texture::class.java)
        texture.setFilter(Texture.TextureFilter.Nearest, Texture.TextureFilter.Nearest)
        return TextureRegion(texture, frame.x, frame.y, frame.width, frame.height).also {
            it.flip(false, true); frame.region = it
        }
    }

    private fun fitCamera() {
        val active = scene ?: return
        val visible = visibleCameraRect() ?: return
        (expandedBattleFrame() ?: baseCameraFrame())?.let { frame ->
            camera.zoom = frame.zoom
            camera.position.set(visible.cameraX(frame.center, frame.zoom), visible.cameraY(frame.centerY, frame.zoom), 0f)
            clampCamera()
            return
        }
        camera.zoom = max(active.columns * active.tilePixels / visible.width,
            active.rows * active.tilePixels / visible.height) * 1.08f
        paintedBattleBounds()?.let { camera.zoom=paintedViewportZoom(camera.zoom,viewport.screenWidth,viewport.screenHeight,it) }
        camera.position.set(visible.cameraX((active.minimumTileX + active.columns / 2f) * active.tilePixels, camera.zoom), visible.cameraY((active.minimumTileY + active.rows / 2f) * active.tilePixels, camera.zoom), 0f)
        if(paintedBattleBounds()!=null) clampCamera() else camera.update()
    }

    private fun clampCamera() {
        val active = scene ?: return
        val visible = visibleCameraRect() ?: return
        expandedBattleFrame()?.let { frame ->
            camera.zoom = camera.zoom.coerceIn(frame.minZoom, frame.maxZoom)
            val policy = requireNotNull(active.battlefield)
            // Controls reserve framing space without clipping either the field or the GL surface. D-185 (owner 2026-09-27): zoom-out
            // stops where the drawn world covers the surface (drawnWorldFrame), and panning keeps the whole field, where troops
            // may still deploy ("Keep whole field", D-183).
            val min = policy.minimum * active.tilePixels; val max = policy.maximum * active.tilePixels
            camera.position.x = visible.cameraX(clampBattleCameraAxis(visible.visibleX(camera.position.x,camera.zoom), visible.width * camera.zoom,min,max),camera.zoom)
            camera.position.y = visible.cameraY(clampBattleCameraAxis(visible.visibleY(camera.position.y,camera.zoom), visible.height * camera.zoom,min,max),camera.zoom)
            camera.update();return
        }
        val baseFrame=baseCameraFrame()
        baseFrame?.let { camera.zoom = camera.zoom.coerceIn(it.minZoom,it.maxZoom) }
        val world=baseFrame?.let { drawnWorld }
        if(world!=null) {
            // D-185 (owner 2026-09-27): pan across the whole drawn world, never past it. The pan rectangle excludes the measured
            // chrome so every edge of the art can be brought out from under the HUD. Home scenes with a drawn world end here;
            // the terrain clamp below (and extendedBaseRenderBounds) keeps serving scenes without one, as before D-183, and
            // legacy painted battles.
            val pan=panCameraInsets(cameraInsets,viewport.screenWidth,viewport.screenHeight,inputGeometry.get())
                .visible(viewport.screenWidth,viewport.screenHeight) ?: visible
            camera.position.x=pan.cameraX(clampDrawnWorldAxis(pan.visibleX(camera.position.x,camera.zoom),pan.width*camera.zoom,world.left,world.right),camera.zoom)
            camera.position.y=pan.cameraY(clampDrawnWorldAxis(pan.visibleY(camera.position.y,camera.zoom),pan.height*camera.zoom,world.top,world.bottom),camera.zoom)
            camera.update();return
        }
        val bounds=terrainBounds?.let {
            if(battle==null && active.camera?.extendedPlot==true && baseFrame!=null)
                extendedBaseRenderBounds(it,viewport.screenWidth,viewport.screenHeight,baseFrame.maxZoom,cameraInsets) else it
        }
        val paintedBattle=paintedBattleBounds()
        paintedBattle?.let { camera.zoom=paintedViewportZoom(camera.zoom,viewport.screenWidth,viewport.screenHeight,it) }
        if((battle==null && active.camera!=null || paintedBattle!=null) && bounds!=null && camera.viewportWidth>0 && camera.viewportHeight>0) {
            // Floating Compose tools leave gaps: the full GL viewport must remain over painted ground.
            camera.position.x=clampBaseCameraAxis(camera.position.x,viewport.screenWidth*camera.zoom,bounds.left,bounds.right)
            camera.position.y=clampBaseCameraAxis(camera.position.y,viewport.screenHeight*camera.zoom,bounds.top,bounds.bottom)
        } else {
            camera.position.x = visible.cameraX(visible.visibleX(camera.position.x, camera.zoom).coerceIn(active.minimumTileX * active.tilePixels, (active.minimumTileX + active.columns) * active.tilePixels), camera.zoom)
            camera.position.y = visible.cameraY(visible.visibleY(camera.position.y, camera.zoom).coerceIn(active.minimumTileY * active.tilePixels, (active.minimumTileY + active.rows) * active.tilePixels), camera.zoom)
        }
        camera.update()
    }

    private fun visibleCameraRect() = cameraInsets.visible(viewport.screenWidth, viewport.screenHeight)
    private fun expandedBattleFrame(): CameraFrame? {
        if (battle==null || viewport.screenWidth<=0 || viewport.screenHeight<=0) return null
        val active = scene ?: return null
        val policy = active.battlefield?.takeIf { it.version != it.legacyVersion } ?: return null
        val spec = active.battleCamera ?: return null
        if (visibleCameraRect()==null) return null
        val frame = fitExpandedBattleFrame(policy,spec,viewport.screenWidth,viewport.screenHeight,Gdx.graphics.density,active.tilePixels,cameraInsets,active.defenderBounds)
        // D-185: battle, scout and replay zoom out to the drawn world covering the surface, not to the authored whole-field fit
        // on the short axis. Without a drawn world the authored band stands, as before D-183. Legacy v1 battlefields (archived
        // replays) keep their historical framing: this frame is null for them.
        return drawnWorld?.let { drawnWorldFrame(frame,it,viewport.screenWidth,viewport.screenHeight,Gdx.graphics.density) } ?: frame
    }

    /** Only a verified, loaded v2 painting owns these bounds; legacy/missing-ground fallback stays unchanged. */
    private fun paintedBattleBounds(): BaseWorldBounds? = terrainBounds?.takeIf {
        battle!=null && (ground?.plan?.art?.artVersion==2 || layeredGround!=null || realmKit!=null) && viewport.screenWidth>0 && viewport.screenHeight>0
    }

    private fun baseCameraFrame(): CameraFrame? {
        val active = scene ?: return null
        if (battle != null || viewport.screenWidth <= 0 || viewport.screenHeight <= 0) return null
        visibleCameraRect() ?: return null
        val spec = active.camera ?: return null
        val bounds=terrainBounds ?: return null
        val frame = fitBaseFrame(spec,viewport.screenWidth,viewport.screenHeight,Gdx.graphics.density,
            max(bounds.width,bounds.height),active.tilePixels,cameraInsets)
        // D-185: the home band's widest zoom is the drawn world covering the surface; without one the authored band stands.
        return drawnWorld?.let { drawnWorldFrame(frame,it,viewport.screenWidth,viewport.screenHeight,Gdx.graphics.density) } ?: frame
    }

    private val touch = TouchIntent(12f)
    private val deploymentGesture = BattleDeploymentGesture()
    private var touchSceneToken = -1L
    private var touchRaidId: String? = null
    private var touchChromeEpoch = 0L
    private val pointers = mutableMapOf<Int, Vector2>()
    private val physicalContacts = mutableSetOf<Int>()
    private var poisonedContacts = false
    private var pinchDistance = 0f
    private val worldPoint = Vector3()
    private fun sceneAcceptsInput() = !disposed && renderedSceneToken==sceneToken &&
        (sceneToken==generation.get() || battle?.scene?.revision?.raidId?.let { it==requestedBattleRaid.get() }==true)
    private fun sameTouchScene() = touchSceneToken==sceneToken || touchRaidId?.let {
        it==battle?.scene?.revision?.raidId && it==requestedBattleRaid.get()
    }==true
    private fun cancelSceneGesture() {
        touch.cancel();deploymentGesture.cancel();pointers.clear();pinchDistance=0f;touchSceneToken=-1L;touchRaidId=null;wallStroke.cancel();carry.cancel()
        // Geometry/HUD/frame cancellation does not mean the fingers were physically lifted.
        poisonedContacts = physicalContacts.isNotEmpty()
    }
    private fun cancelAllSceneContacts() { cancelSceneGesture();physicalContacts.clear();poisonedContacts=false }
    private fun syncWallInput() = wallStroke.frame(pendingWallMode.get().takeIf { sceneAcceptsInput() }, generation.get(),
        scene?.baseId, battle != null, viewport.screenWidth, viewport.screenHeight)
    private fun syncCarryInput() = carry.frame(pendingCarryMode.get().takeIf { sceneAcceptsInput() }, scene?.baseId, battle != null)
    private fun gestureNowMs() = System.nanoTime() / 1_000_000
    private fun insideViewport(x: Int, y: Int): Boolean = inputGeometry.get()?.accepts(x, y, viewport.screenWidth, viewport.screenHeight)
        ?: physicalSceneContains(x, y, viewport.screenWidth, viewport.screenHeight)
    private fun wallPoint(x: Int, y: Int): Pair<Float, Float> {
        viewport.unproject(worldPoint.set(x.toFloat(), y.toFloat(), 0f))
        val tile = scene?.tilePixels ?: 1f
        return worldPoint.x / tile to worldPoint.y / tile
    }
    private fun emitBattlePlacement(x: Int, y: Int, mode: BattleDeploymentMode) {
        val active = scene ?: return
        val point = wallPoint(x, y)
        val tile = active.battlefield?.nearest(point.first, point.second) { tx, ty ->
            viewport.project(worldPoint.set((tx + .5f) * active.tilePixels, (ty + .5f) * active.tilePixels, 0f))
            insideViewport(worldPoint.x.toInt(), (viewport.screenHeight - worldPoint.y).toInt())
        }
        onBattleGroundSelected(mode, tile?.first?.plus(.5f) ?: point.first,
            tile?.second?.plus(.5f) ?: point.second, tile != null)
    }
    private fun advanceDeploymentInput() {
        if (battle==null || pointers.size!=1) return
        if (!sceneAcceptsInput() || !sameTouchScene()) { cancelSceneGesture(); return }
        val mode = deploymentMode.get()
        if (deploymentGesture.frame(System.nanoTime()/1_000_000, mode) && mode != null) {
            val contact = pointers.values.first()
            emitBattlePlacement(contact.x.toInt(), contact.y.toInt(), mode)
        }
    }
    private val input = object : InputAdapter() {
        override fun touchDown(x: Int, y: Int, pointer: Int, button: Int): Boolean {
            syncWallInput()
            val continuing = physicalContacts.isNotEmpty()
            val freshPointer = physicalContacts.add(pointer)
            if (!continuing) poisonedContacts = false
            if(!freshPointer || !sceneAcceptsInput() || !insideViewport(x, y) || poisonedContacts ||
                continuing && touchChromeEpoch!=(inputGeometry.get()?.cancellation?.revision ?: 0L)) {
                wallStroke.down(pointer, false, false);carry.down(pointer, null, 0f, 0f, 0L);cancelSceneGesture();return true
            }
            syncCarryInput()
            pointers[pointer] = Vector2(x.toFloat(), y.toFloat())
            if (pointers.size == 1) {
                touchChromeEpoch=inputGeometry.get()?.cancellation?.revision ?: 0L;touchSceneToken=sceneToken
                touchRaidId=battle?.scene?.revision?.raidId;touch.down(x.toFloat(), y.toFloat())
                deploymentGesture.down(x.toFloat(),y.toFloat(),System.nanoTime()/1_000_000,deploymentMode.get())
            } else {
                touch.pinch(); deploymentGesture.pan(); pinchDistance = distance()
            }
            val painting = wallStroke.down(pointer, button == com.badlogic.gdx.Input.Buttons.LEFT, insideViewport(x, y))
            if (painting) touch.pinch()
            // Hold-to-lift presses the movable building under the finger; the footprint hit matches the tap path.
            val carryHit = if (!painting && pointers.size == 1 && battle == null && button == com.badlogic.gdx.Input.Buttons.LEFT) {
                val point = wallPoint(x, y)
                drawables.asReversed().firstOrNull { selectableBuildingHit(it.building, point.first, point.second, carry.movableIds) }?.building?.id
            } else null
            carry.down(pointer, carryHit, x.toFloat(), y.toFloat(), gestureNowMs())
            traceInput("down",pointer,x,y)
            return true
        }

        override fun touchDragged(x: Int, y: Int, pointer: Int): Boolean {
            syncWallInput()
            if(!sceneAcceptsInput() || !sameTouchScene() || touchChromeEpoch!=(inputGeometry.get()?.cancellation?.revision ?: 0L) || !insideViewport(x, y)) { cancelSceneGesture();return true }
            val old = pointers[pointer] ?: return false
            val dx = x - old.x; val dy = y - old.y
            old.set(x.toFloat(), y.toFloat())
            if (pointers.size > 1) {
                touch.pinch()
                val nextDistance = distance()
                if (pinchDistance > 0 && nextDistance > 0) {
                    val band=expandedBattleFrame() ?: baseCameraFrame()
                    camera.zoom = (camera.zoom * pinchDistance / nextDistance).coerceIn(band?.minZoom ?: 0.3f,band?.maxZoom ?: 8f)
                }
                pinchDistance = nextDistance
            } else {
                val point = wallPoint(x, y)
                if (wallStroke.move(pointer, point.first, point.second, insideViewport(x, y))) {
                    traceInput("wall-paint",pointer,x,y);return true
                }
                // A still press or an armed carry owns the move; a swipe before the hold falls through to the pan.
                if (carry.move(pointer, x.toFloat(), y.toFloat(), point.first, point.second, gestureNowMs())) {
                    traceInput("carry",pointer,x,y);return true
                }
                touch.move(x.toFloat(), y.toFloat())
                if (battle!=null && !deploymentGesture.move(x.toFloat(),y.toFloat())) return true
                camera.translate(-dx * camera.zoom, -dy * camera.zoom)
            }
            cameraFraming.moved = true
            clampCamera()
            traceInput("drag",pointer,x,y,"dx=$dx dy=$dy")
            return true
        }

        override fun touchUp(x: Int, y: Int, pointer: Int, button: Int): Boolean {
            syncWallInput()
            if (!physicalContacts.remove(pointer)) return true // Stale release after Android ACTION_CANCEL.
            if(poisonedContacts || !sceneAcceptsInput() || !sameTouchScene() || touchChromeEpoch!=(inputGeometry.get()?.cancellation?.revision ?: 0L) || !insideViewport(x, y)) {
                wallStroke.up(pointer,0f,0f,false);carry.cancel(pointer);cancelSceneGesture();return true
            }
            val point = wallPoint(x, y)
            val painted = wallStroke.up(pointer, point.first, point.second, insideViewport(x, y))
            pointers.remove(pointer)
            if (painted) { carry.cancel(pointer);touch.cancel();traceInput("wall-release",pointer,x,y);return true }
            if (carry.up(pointer, gestureNowMs())) { touch.cancel();traceInput("carry-release",pointer,x,y);return true }
            val mode = deploymentMode.get()
            if (battle!=null && mode!=null) {
                deploymentGesture.sync(mode)
                if (pointers.isEmpty() && deploymentGesture.up(x.toFloat(),y.toFloat())) emitBattlePlacement(x,y,mode)
                touch.cancel();return true
            }
            val tapped=pointers.isEmpty() && touch.up(x.toFloat(), y.toFloat())
            traceInput("up",pointer,x,y,"tap=$tapped")
            if (tapped && insideViewport(x, y)) {
                viewport.unproject(worldPoint.set(x.toFloat(), y.toFloat(), 0f))
                val active = scene ?: return true
                traceInput("tap",pointer,x,y,"tileX=${worldPoint.x/active.tilePixels} tileY=${worldPoint.y/active.tilePixels}")
                dispatchSceneTap(worldPoint.x / active.tilePixels,worldPoint.y / active.tilePixels,
                    active.columns,active.rows,battle != null,onGroundSelected,active.minimumTileX,active.minimumTileY) {
                    // Footprint hit regions remain independent of animated art dimensions.
                    drawables.asReversed().firstOrNull { item ->
                        selectableBuildingHit(item.building,worldPoint.x/active.tilePixels,worldPoint.y/active.tilePixels,selectableBuildingIds)
                    }?.let { onBuildingSelected(it.building.id) }
                }
            }
            return true
        }

        override fun touchCancelled(x: Int, y: Int, pointer: Int, button: Int): Boolean {
            // Android ACTION_CANCEL reports one pointer through libGDX, but terminates every contact.
            cancelAllSceneContacts();wallStroke.reset();carry.reset();traceInput("cancel",pointer,x,y);return true
        }
    }

    private fun traceInput(event: String,pointer: Int,x: Int,y: Int,detail: String="") {
        val sink=inputDiagnostics ?: return
        sink("event=$event pointer=$pointer x=$x y=$y pointers=${pointers.size} " +
            "viewport=${viewport.screenWidth}x${viewport.screenHeight} graphics=${Gdx.graphics.width}x${Gdx.graphics.height} " +
            "cameraX=${camera.position.x} cameraY=${camera.position.y} zoom=${camera.zoom} $detail")
    }

    private fun distance(): Float {
        val values = pointers.values.take(2)
        return if (values.size == 2) hypot(values[0].x - values[1].x, values[0].y - values[1].y) else 0f
    }

    private fun safeFile(path: String): FileHandle {
        require(path.split('/').all { it.isNotEmpty() && it != "." && it != ".." && !it.contains('\\') && !it.contains(':') })
        return assetRoot.child(path)
    }

    private fun report(message: String) { renderedSceneToken=-1L;scenePreparationFailed=true;if (reported.add(message)) onError(message) }
    // Every texture this renderer creates itself is managed (its pixmap is retained), so after an EGL
    // context loss libGDX re-uploads them before the first resumed frame; nothing needs a re-upload here.
    override fun resume() { layeredPaused = false; if (serviceSource != null) refreshServiceScene(); layeredGround?.resetClock(); realmKit?.resetClock(); skipAdvance = true; motionNextMs = 0L; campFrameNanos = 0L }
    override fun pause() { layeredPaused = true; serviceSource?.cancelPending(); fleetJourneys.revoke(); layeredGround?.resetClock(); realmKit?.resetClock(); campFrameNanos = 0L; skipAdvance = true; cancelAllSceneContacts();wallStroke.reset();carry.reset(); performance?.pause(); diagnosticSample?.pause(); diagnosticSummary?.pause() }
    override fun dispose() = localDiagnostics.duringLifecycle(LocalLifecycleStage.RENDERER_DISPOSE) {
        disposed = true
        serviceSource?.cancelPending(); serviceSubmissions.clear(); fleetJourneys.revoke()
        preparationTrace.getAndSet(null)?.second.end(LocalPreparationOutcome.CANCELLED)
        commandDraws = null
        wallStroke.reset();pendingWallMode.set(null);carry.reset();pendingCarryMode.set(null)
        generation.incrementAndGet()
        discardStaging()
        preparation.close()
        decoding.shutdownNow()
        if (Gdx.input.inputProcessor === input) Gdx.input.inputProcessor = null
        if (::batch.isInitialized) batch.dispose()
        hitFillShader?.dispose();hitFillShader=null
        selectionOutlineShader?.dispose();selectionOutlineShader=null
        deployElapsed.clear()
        serviceHitCursor.clear()
        if (::shapes.isInitialized) shapes.dispose()
        if (::assets.isInitialized) localDiagnostics.duringLifecycle(LocalLifecycleStage.ASSET_MANAGER_DISPOSE) { assets.dispose() }
        serviceTexturePixels.values.forEach { it.close() }; serviceTexturePixels.clear()
        if (::strokeTexture.isInitialized) strokeTexture.dispose()
        if (::strokePixel.isInitialized) strokePixel.dispose()
        ruinRegions.values.forEach { it?.texture?.dispose() }; ruinRegions.clear()
        wallAtlas?.dispose(); wallAtlas = null; wallFrames = null; wallSeats.clear()
        ground?.dispose(); ground = null; layeredGround?.dispose(); layeredGround = null; realmKit?.dispose(); realmKit = null; groundIdentity = null
        synchronized(handoffLock) { pending.getAndSet(null)?.let { it.update.ground.discard(); it.services.close() } }
        activeServiceAssets?.close(); activeServiceAssets = null
        retiringServiceAssets.forEach { it.close() }; retiringServiceAssets.clear(); serviceTextureFiles.clear(); serviceVisuals = null
        frames.clear(); catalogue.clear(); drawables.clear(); pending.set(null); pendingCatalogue.set(null); paintPool.clear(); paintOrder.clear(); battle = null
        onDisposed()
    }

    private data class PackedFrame(val texturePath: String, val x: Int, val y: Int, val width: Int, val height: Int,
                                   val sourceWidth: Float, val sourceHeight: Float, val trimX: Float, val trimY: Float,
                                   var region: TextureRegion? = null)
    private class BasePaint(var alpha: Float=1f,var frame: PackedFrame?=null,var drawable: Drawable?=null,var sprite: BaseVisualSprite?=null,var depth: Float=0f,var region: TextureRegion?=null,var seat: SpritePlacement?=null,var serviceId: String?=null,var outline: String?=null)
    private data class Drawable(val building: RenderBuilding, val art: Art, val placement: SpritePlacement)
    private data class Paint(var art: Art, var placement: SpritePlacement, var hit: Boolean, var alpha: Float = 1f,var stroke: CombatStroke? = null,var region: TextureRegion? = null,var kegPrime: Pair<Int,KegPrimePresentation>? = null,
        var serviceId: String? = null, var serviceHit: Triple<HitFeedbackCue,Float,Float>? = null, var actorId: Int? = null, var actorX: Float = 0f, var actorY: Float = 0f, var actorHeight: Float = 0f, var actorAlive: Boolean = false)
    private data class PreparedBattle(val scene: BattleScene, val model: BattleVisualModel, val visuals: CombatVisualPlan,
        val walls: WallVisualModel, val wallAtlases: Set<String>, val wallField: WallFieldTimeline? = null) {
        val extent: BattlePlaybackExtent = visuals.playbackExtent
        val audioActorIds = model.actorIds.filter { model.actorIdentity(it) in setOf("kegrunner", "tunneler", "bilgewraith") }
    }
    private sealed interface SceneUpdate {
        val token: Long
        val wallField: WallFieldTimeline?
        val ground: GroundDelivery
        /** N-C5 RESIDENCY R2: the playback lifetime this request was AUTHORIZED under, captured synchronously at request
         *  time before any asynchronous work, and carried unchanged through publication and ground-only re-preparation. */
        val journeyPredecessor: Long
        data class Base(val scene: BaseScene, val walls: WallVisualModel, val visuals: BaseVisualModel?, override val token: Long,
            override val wallField: WallFieldTimeline?, override val ground: GroundDelivery, val camps: PreparedCampScene? = null,
            override val journeyPredecessor: Long = FleetJourneyPlayback.STALE_PREDECESSOR) : SceneUpdate
        data class Battle(val prepared: PreparedBattle, override val token: Long, override val ground: GroundDelivery, val audioToken: Long, val request: Any,
            override val journeyPredecessor: Long = FleetJourneyPlayback.STALE_PREDECESSOR) : SceneUpdate {
            override val wallField: WallFieldTimeline? get() = prepared.wallField
        }
    }

    /** Classpath rest cells (BuildingRuinArt): one texture per path for the renderer's life,
     * flipped like pack regions. A missing resource is remembered as null, not a scene failure. */
    private val ruinRegions = mutableMapOf<String, TextureRegion?>()
    private fun ruinRegion(path: String): TextureRegion? = ruinRegions.getOrPut(path) {
        Gdx.files.classpath(path).takeIf { it.exists() }?.let { file ->
            TextureRegion(Texture(file).also { it.setFilter(Texture.TextureFilter.Nearest, Texture.TextureFilter.Nearest) })
                .also { it.flip(false, true) }
        }
    }

    /** A texture over a pixmap this renderer keeps alive: managed `PixmapTextureData`, which libGDX
     * re-uploads from that pixmap after an EGL context loss (`Texture.invalidateAllTextures` →
     * `reload`). `Texture(Pixmap)` and `Texture(w, h, format)` are NOT managed in libGDX 1.13.1 — they
     * would come back as dead handles after a background GPU reset until the next scene publish. */
    private fun managedTexture(pixmap: Pixmap): Texture =
        Texture(PixmapTextureData(pixmap, Pixmap.Format.RGBA8888, false, false, true))
            .also { it.setFilter(Texture.TextureFilter.Nearest, Texture.TextureFilter.Nearest) }

    /** GL-side pages of composed wall frames: one upload per key, cells kept while a scene references
     * them. Each page keeps its RGBA mirror and is a managed texture, so a context loss is repaired by
     * libGDX from the mirror; nothing here ever writes into a stale handle. The frame library is
     * bounded to the same key set as the cells. */
    private inner class WallFrameAtlas {
        private val spec = wallSpec!!
        private val layout = WallFrameAtlasLayout(spec.tile, spec.contextFrameHeight, WALL_ATLAS_PAGE)
        private val index = WallFrameAtlasIndex(layout)
        private val pages = mutableListOf<Page>()
        private val regions = HashMap<String, TextureRegion>()
        private val cell = Pixmap(spec.tile, spec.contextFrameHeight, Pixmap.Format.RGBA8888)
        private var pixels: Map<String,ByteArray> = emptyMap()
        private val uploads = FrameUploadQueue<String>()
        val ready: Boolean get() = uploads.size == 0
        val pendingUploads: Int get() = uploads.size
        fun prepare(keys: Set<String>, prepared: Map<String,ByteArray>) {
            index.retain(keys); regions.keys.retainAll(keys); pixels = prepared
            uploads.replace(keys.filter { it !in regions })
        }
        fun advance() { uploads.advance { upload(it) }; if (ready) pixels = emptyMap() }
        fun region(key: String): TextureRegion? = regions[key]
        private fun upload(key: String): TextureRegion {
            regions[key]?.let { return it }
            val (slot, fresh) = index.allocate(key)
            val page = layout.page(slot)
            while (pages.size <= page) pages += Page()
            if (fresh) pages[page].write(requireNotNull(pixels[key]) { "Wall pixels were not prepared" }, slot)
            val region = TextureRegion(pages[page].texture, layout.x(slot), layout.y(slot), layout.cellWidth, layout.cellHeight)
            region.flip(false, true)
            regions[key] = region
            return region
        }
        fun dispose() { pages.forEach { it.dispose() }; pages.clear(); regions.clear(); index.clear(); cell.dispose() }

        private inner class Page {
            val mirror = Pixmap(layout.columns * layout.cellWidth, layout.rows * layout.cellHeight, Pixmap.Format.RGBA8888)
            val texture = managedTexture(mirror)
            /** The mirror first (that is what a reload uploads), then only the cell reaches the live page:
             * `Texture.draw` refuses managed textures, so this is its `glTexSubImage2D` without the check. */
            fun write(pixels: ByteArray, slot: Int) {
                writeWallFrameCell(mirror.pixels, mirror.width, layout, slot, pixels)
                val buffer = cell.pixels; buffer.position(0); buffer.put(pixels); buffer.position(0)
                texture.bind()
                Gdx.gl.glTexSubImage2D(GL20.GL_TEXTURE_2D, 0, layout.x(slot), layout.y(slot), cell.width, cell.height, cell.glFormat, cell.glType, cell.pixels)
            }
            fun dispose() { texture.dispose(); mirror.dispose() }
        }
    }

    /** Decoded on the presentation thread; the pixmap is owned by whoever takes the delivery. */
    private class PreparedGround(val plan: GroundPlan, val pixmap: Pixmap, val motion: GroundMotion, val motes: List<GroundMote>, val identity: String)
    private sealed interface GroundDelivery {
        fun discard() { when (this) { is Replace -> prepared.pixmap.dispose(); is Layered -> prepared.close(); is RealmKit -> prepared.close(); else -> {} } }
        /** The GL surface already shows this realm window. */
        class Keep(val admission: GroundReuseAdmission) : GroundDelivery
        /** No ground section, or the optional painting is not installed: the legacy terrain stays. */
        object None : GroundDelivery
        class Replace(val prepared: PreparedGround) : GroundDelivery
        class Layered(val prepared: PreparedLayeredSurface) : GroundDelivery
        /** Revision 5: one tileset, far repeat, optional overview still and prop sheets (docs/REALM-KIT-PLAN.md E-8). */
        class RealmKit(val prepared: PreparedRealmKitSurface) : GroundDelivery
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** `FantasyGround.set`: resolve the realm, verify the accepted painting's digest before decoding,
     * then either keep the source pixels (v2, sampled by GL) or run the canonical row writer (v1). The
     * ground window is the plot plus the scene camera's `BASE_CAMERA.skirtTiles` (`BaseScene.drawUnderlay`). */
    private fun prepareGround(requested: BaseScene, force: Boolean = false, checkpoint: () -> Unit = {}): GroundDelivery {
        val kit = catalogueRoot.get("layeredGroundV5")
            ?: if (allowLayeredGroundPreview) catalogueRoot.get("layeredGroundV5Preview") else null
        // A pack pinned before the realm kit draws the realm's revision-4 painting; it never refuses the kingdom.
        val scene = requested.copy(visual = presentableGroundVisual(requested.visual, kit != null))
        if (scene.visual != requested.visual) onDiagnostic("realm kit content is absent from this pack; ${scene.visual?.realmId} presents revision 4")
        if (scene.visual?.groundRevision == 5) {
            val visual = requireNotNull(scene.visual)
            check(visual.artVersion == 2) { "Unsupported realm kit terrain context" }
            val decoder = requireNotNull(layeredImageDecoder) { "Layered terrain decoder is unavailable" }
            val section = requireNotNull(kit) { "Realm kit content is unavailable" }
            checkpoint()
            val source = RealmKitSource.read(section, visual.realmId, requireNotNull(groundRules).realms.toSet(), allowLayeredGroundPreview, realmKitRules, ::readLayeredBytes)
            val identity = source.identity(scene.tilePixels)
            if (!force && identity == groundIdentity) return GroundDelivery.Keep(GroundReuseAdmission(identity))
            val prepared = source.prepare(::readLayeredBytes, decoder, checkpoint)
            val pixmaps = linkedMapOf<String, Pixmap>()
            try {
                for (page in prepared.pages) {
                    checkpoint()
                    val pixmap = Pixmap(page.pixels.width, page.pixels.height, Pixmap.Format.RGBA8888)
                    pixmaps[page.asset.id] = pixmap
                    pixmap.pixels.apply { position(0); put(page.pixels.bytes); position(0) }
                }
                checkpoint()
                return GroundDelivery.RealmKit(PreparedRealmKitSurface(source, identity, pixmaps))
            } catch (error: Exception) { pixmaps.values.forEach { it.dispose() }; throw error }
        }
        if (scene.visual?.groundRevision in setOf(3, 4)) {
            val visual = requireNotNull(scene.visual)
            check(visual.artVersion == 2) { "Unsupported layered terrain context" }
            val decoder = requireNotNull(layeredImageDecoder) { "Layered terrain decoder is unavailable" }
            val section = catalogueRoot.get(if (visual.groundRevision == 4) "layeredGroundV4" else "layeredGround")
                ?: if (allowLayeredGroundPreview) catalogueRoot.get("layeredGroundPreview") else null
            requireNotNull(section) { "Layered realm content is unavailable" }
            checkpoint()
            val source = LayeredGroundSource.read(section, visual.realmId, requireNotNull(groundRules).realms.toSet(), allowLayeredGroundPreview, ::readLayeredBytes)
            check(source.rules.groundRevision == visual.groundRevision) { "Layered terrain revision mismatch" }
            val identity = source.identity(scene.tilePixels)
            if (!force && identity == groundIdentity) return GroundDelivery.Keep(GroundReuseAdmission(identity))
            check(source.rules.sampling == "world") { "Native layered ground requires a composed painting" }
            val prepared = source.prepare(::readLayeredBytes, decoder, checkpoint)
            val pixmaps = linkedMapOf<String, Pixmap>()
            try {
                for (page in prepared.pages) {
                    checkpoint()
                    val pixmap = Pixmap(page.pixels.width, page.pixels.height, Pixmap.Format.RGBA8888)
                    pixmaps[page.asset.id] = pixmap
                    pixmap.pixels.apply { position(0); put(page.pixels.bytes); position(0) }
                }
                checkpoint()
                return GroundDelivery.Layered(PreparedLayeredSurface(source, identity, pixmaps))
            } catch (error: Exception) { pixmaps.values.forEach { it.dispose() }; throw error }
        }
        val rules = groundRules ?: return GroundDelivery.None
        val visual = rules.resolve(scene.visual); val art = rules.artFor(visual); val source = rules.sourceFor(visual)
        val skirtTiles = scene.camera?.skirtTiles ?: 0f
        require(skirtTiles == floor(skirtTiles)) { "The ground skirt is whole tiles" }
        val plan = GroundPlan(visual, art, source, scene.columns, skirtTiles.toInt(), scene.minimumTileX)
        val identity = "${plan.identity}@${scene.tilePixels}"
        if (!force && identity == groundIdentity) return GroundDelivery.Keep(GroundReuseAdmission(identity))
        val file = safeFile(source.path)
        if (!file.exists()) { onDiagnostic("ground ${source.path} is not installed; the legacy terrain stays"); return GroundDelivery.None }
        val bytes = file.readBytes()
        if (sha256(bytes) != source.sha256) { onDiagnostic("ground ${source.path} failed its integrity check; the legacy terrain stays"); return GroundDelivery.None }
        val decoded = Pixmap(bytes, 0, bytes.size)
        val rgba = try {
            require(decoded.width == art.sourceSize && decoded.height == art.sourceSize) { "Ground artwork dimensions changed" }
            Pixmap(decoded.width, decoded.height, Pixmap.Format.RGBA8888).also { it.blending = Pixmap.Blending.None; it.drawPixmap(decoded, 0, 0) }
        } finally { decoded.dispose() }
        val data = ByteArray(rgba.width * rgba.height * 4)
        rgba.pixels.duplicate().apply { position(0) }.get(data)
        val pixels = GroundPixels(data, rgba.width, rgba.height)
        val motion = GroundMotion(rules, scene.tilePixels)
        return if (plan.rasterised) {
            val raster = GroundRaster.render(pixels, art, visual.realmId, plan.coverage.width, plan.coverage.height, plan.coverage.originX, plan.coverage.originY)
            rgba.dispose()
            val surface = Pixmap(plan.coverage.width, plan.coverage.height, Pixmap.Format.RGBA8888)
            surface.pixels.apply { position(0); put(raster); position(0) }
            GroundDelivery.Replace(PreparedGround(plan, surface, motion, emptyList(), identity))
        } else {
            val motes = motion.motes(art.worldOriginTiles, art.worldTiles)
            motion.attachTerrainFeatures(motes, pixels, art, visual.realmId)
            GroundDelivery.Replace(PreparedGround(plan, rgba, motion, motes, identity))
        }
    }

    private fun applyGround(delivery: GroundDelivery, preparedSurface: GroundSurface? = null, preparedLayered: LayeredGroundSurface? = null, preparedRealmKit: RealmKitSurface? = null) {
        when (delivery) {
            is GroundDelivery.Keep -> {}
            GroundDelivery.None -> { ground?.dispose(); ground = null; layeredGround?.dispose(); layeredGround = null; realmKit?.dispose(); realmKit = null; groundIdentity = null }
            is GroundDelivery.Replace -> {
                val replacement = preparedSurface ?: GroundSurface(delivery.prepared)
                val previous = ground; ground = replacement; groundIdentity = delivery.prepared.identity; previous?.dispose()
                layeredGround?.dispose(); layeredGround = null; realmKit?.dispose(); realmKit = null
            }
            is GroundDelivery.Layered -> {
                val replacement = requireNotNull(preparedLayered); check(replacement.ready)
                val previous = layeredGround; layeredGround = replacement; groundIdentity = delivery.prepared.identity
                previous?.dispose(); ground?.dispose(); ground = null; realmKit?.dispose(); realmKit = null
            }
            is GroundDelivery.RealmKit -> {
                val replacement = requireNotNull(preparedRealmKit); check(replacement.ready)
                val previous = realmKit; realmKit = replacement; groundIdentity = delivery.prepared.identity
                previous?.dispose(); ground?.dispose(); ground = null; layeredGround?.dispose(); layeredGround = null
            }
        }
        motionView = ""; motionNextMs = 0L; motionGlyphs.clear()
    }

    private fun readLayeredBytes(path: String, maximum: Int): ByteArray {
        val file = safeFile(path)
        require(file.exists() && file.length() in 1..maximum.toLong()) { "Layered preview content is unavailable" }
        return file.read().use { input ->
            val output = java.io.ByteArrayOutputStream(minOf(maximum, 65536)); val buffer = ByteArray(16384)
            while (true) {
                val count = input.read(buffer); if (count < 0) break
                require(output.size() + count <= maximum) { "Layered preview content exceeds its manifest" }
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
    }

    private class PreparedLayeredSurface(val source: LayeredGroundSource, val identity: String, val pixmaps: Map<String, Pixmap>) {
        private var closed = false
        fun close() { if (!closed) { closed = true; pixmaps.values.forEach { it.dispose() } } }
    }
    /** At most one prepared page is uploaded per GL iteration. Managed textures
     * retain their worker-prepared Pixmaps for EGL restoration without re-decoding. */
    private inner class LayeredGroundSurface(private val prepared: PreparedLayeredSurface) {
        private val textures = linkedMapOf<String, Texture>()
        private val regions = mutableMapOf<String, TextureRegion>()
        private val rules = prepared.source.rules
        private val repeatVertices = FloatArray(20)
        private var closed = false
        private var previousNanos = 0L
        private var elapsedMs = 0L
        val ready: Boolean get() = textures.size == prepared.pixmaps.size
        fun advance() {
            check(!closed && !ready)
            val page = prepared.pixmaps.entries.first { it.key !in textures }
            textures[page.key] = managedTexture(page.value).also {
                val wrap = if (page.key == rules.far?.asset?.id) Texture.TextureWrap.Repeat else Texture.TextureWrap.ClampToEdge
                it.setWrap(wrap, wrap)
            }
            onDiagnostic("layered ground uploaded ${page.key} ${textures.size}/${prepared.pixmaps.size} frame=${Gdx.graphics.frameId} rgbaBytes=${rules.rgbaBytes}")
        }
        fun worldBounds(tilePixels: Float): BaseWorldBounds = rules.floorBounds(tilePixels.toDouble()).let {
            BaseWorldBounds(it.x.toFloat(), it.y.toFloat(), (it.x + it.width).toFloat(), (it.y + it.height).toFloat())
        }
        private fun view(): LayeredGroundRect {
            val width = camera.viewportWidth * camera.zoom; val height = camera.viewportHeight * camera.zoom
            return LayeredGroundRect((camera.position.x - width / 2).toDouble(), (camera.position.y - height / 2).toDouble(), width.toDouble(), height.toDouble())
        }
        fun drawFloor(tilePixels: Float) {
            check(rules.sampling == "world") { "Native layered preview requires a composed painting" }
            draw(rules.floorPlan(tilePixels.toDouble(), view()))
        }
        fun drawMotion(tilePixels: Float) {
            if (layeredPaused) { resetClock(); return }
            val now = System.nanoTime()
            if (previousNanos != 0L && !reducedMotion) elapsedMs += ((now - previousNanos) / 1_000_000).coerceIn(0L, 100L)
            previousNanos = now
            val draws = rules.drawPlan(tilePixels.toDouble(), view(), elapsedMs, reducedMotion)
            if (draws.isEmpty()) return
            batch.begin(); draw(draws); batch.end(); drawCalls += batch.renderCalls
        }
        private fun draw(draws: List<LayeredGroundDraw>) {
            batch.color = Color.WHITE
            for (draw in draws) {
                if (draw.repeat != null) {
                    draw.repeat.writeQuad(draw.destination, repeatVertices)
                    batch.draw(textures.getValue(draw.asset.id), repeatVertices, 0, repeatVertices.size)
                    continue
                }
                val key = "${draw.asset.id}:${draw.source.x}:${draw.source.y}:${draw.source.width}:${draw.source.height}:${draw.flipX}:${draw.flipY}"
                val region = regions.getOrPut(key) { TextureRegion(textures.getValue(draw.asset.id), draw.source.x.toInt(), draw.source.y.toInt(),
                    draw.source.width.toInt(), draw.source.height.toInt()).also { it.flip(draw.flipX, !draw.flipY) } }
                val b = draw.destination
                batch.draw(region, b.x.toFloat(), b.y.toFloat(), b.width.toFloat(), b.height.toFloat())
            }
        }
        fun resetClock() { previousNanos = 0L }
        fun dispose() { if (!closed) { closed = true; textures.values.forEach { it.dispose() }; textures.clear(); regions.clear(); prepared.close() } }
    }

    private class PreparedRealmKitSurface(val source: RealmKitSource, val identity: String, val pixmaps: Map<String, Pixmap>) {
        private var closed = false
        fun close() { if (!closed) { closed = true; pixmaps.values.forEach { it.dispose() } } }
    }
    /** The scene's kingdom rect for the revision-5 ground: the raid snapshot's frozen claim in battle, else
     * the server claim the camera frames, else (fixtures without a claim) the plot itself. Coerced into the
     * kit's frame with a diagnostic rather than crashing the GL thread on a claim the server should never send. */
    private fun realmKitClaim(active: BaseScene): RealmKitClaim {
        val rules = realmKitRules
        val field = active.battlefield?.takeIf { battle != null }
        val camera = active.camera
        val raw = when {
            field != null -> RealmKitClaim(field.claimMin, field.claimMax)
            camera != null -> RealmKitClaim(camera.claimMin.toInt(), camera.claimMax.toInt()).also {
                if (camera.claimMin != it.min.toFloat() || camera.claimMax != it.max.toFloat()) onDiagnostic("realm kit claim ${camera.claimMin}..${camera.claimMax} is not whole tiles")
            }
            else -> RealmKitClaim(active.minimumTileX, active.minimumTileX + active.columns)
        }
        val min = raw.min.coerceIn(rules.frameMinTile, rules.frameMaxTile - 1); val max = raw.max.coerceIn(min + 1, rules.frameMaxTile)
        if (min != raw.min || max != raw.max) onDiagnostic("realm kit claim ${raw.min}..${raw.max} coerced to $min..$max")
        return RealmKitClaim(min, max)
    }
    /** Revision-5 ground (docs/REALM-KIT-PLAN.md E-8): the far repeat quad, then either the overview still,
     * its edge-clamped margin strips and a paddingColor kingdom fill where [RealmKitManifest.drawsOverview] allows (a still texel of 2 px or less), or the
     * per-chunk cached quad batches from the single tileset texture (both cover the extent, not the field alone:
     * a phone at the zoom floor sees far past the 98-tile field). The still bakes only the tile layers: E-6 amended hides a prop by the
     * claim at draw time and a bake cannot follow the claim, so [drawProps] draws the culled prop plan over
     * the floor at every zoom and a hidden prop never reaches the zoom floor (RealmKitPropPassTest). At most
     * one prepared page is uploaded per GL iteration; managed textures retain their worker Pixmaps for EGL
     * restoration. The motion clock advances once per frame in [drawFloor]; reduced motion pins frame 0. */
    private inner class RealmKitSurface(private val prepared: PreparedRealmKitSurface) {
        private val textures = linkedMapOf<String, Texture>()
        private val regions = HashMap<String, HashMap<LayeredGroundRect, TextureRegion>>()
        private val kit = prepared.source.kit
        private val repeatVertices = FloatArray(20)
        private var chunks: RealmKitChunkCache? = null
        private var closed = false
        private var previousNanos = 0L
        private var elapsedMs = 0L
        private var claim = RealmKitClaim(kit.rules.frameMinTile, kit.rules.frameMaxTile)
        val ready: Boolean get() = textures.size == prepared.pixmaps.size
        fun advance() {
            check(!closed && !ready)
            val page = prepared.pixmaps.entries.first { it.key !in textures }
            textures[page.key] = managedTexture(page.value).also {
                val wrap = if (page.key == kit.far.asset.id) Texture.TextureWrap.Repeat else Texture.TextureWrap.ClampToEdge
                it.setWrap(wrap, wrap)
            }
            onDiagnostic("realm kit uploaded ${page.key} ${textures.size}/${prepared.pixmaps.size} frame=${Gdx.graphics.frameId} rgbaBytes=${kit.rgbaBytes}")
        }
        fun worldBounds(tilePixels: Float): BaseWorldBounds = kit.floorBounds(tilePixels.toDouble()).let {
            BaseWorldBounds(it.x.toFloat(), it.y.toFloat(), (it.x + it.width).toFloat(), (it.y + it.height).toFloat())
        }
        private fun view(): LayeredGroundRect {
            val width = camera.viewportWidth * camera.zoom; val height = camera.viewportHeight * camera.zoom
            return LayeredGroundRect((camera.position.x - width / 2).toDouble(), (camera.position.y - height / 2).toDouble(), width.toDouble(), height.toDouble())
        }
        /** [RealmKitManifest.drawsOverview] with this frame's camera: one rule in every scene, with no scene flag (a
         * scouted base, preview, raid or replay opens at a home base's zooms). [drawFloor] counts what it then drew. */
        private fun overviewZoom(tilePixels: Double): Boolean = kit.drawsOverview(tilePixels, camera.zoom.toDouble(), Gdx.graphics.density.toDouble())
        private fun tick() {
            if (layeredPaused) { resetClock(); return }
            val now = System.nanoTime()
            if (previousNanos != 0L && !reducedMotion) elapsedMs += ((now - previousNanos) / 1_000_000).coerceIn(0L, 100L)
            previousNanos = now
        }
        fun drawFloor(tilePixels: Float, sceneClaim: RealmKitClaim) {
            tick()
            claim = sceneClaim
            val view = view(); val T = tilePixels.toDouble()
            batch.color = Color.WHITE
            drawRepeat(kit.farDraw(T, view))
            if (overviewZoom(T)) {
                realmKitStillDraws++
                val plan = kit.overviewPlan(T, view, claim)
                plan.overview?.let(::drawRegion)
                plan.margin.forEach(::drawRegion)
                plan.kingdom?.let { fill ->
                    val rgb = fill.color; val d = fill.destination
                    batch.setColor(((rgb shr 16) and 255) / 255f, ((rgb shr 8) and 255) / 255f, (rgb and 255) / 255f, 1f)
                    batch.draw(strokeTexture, d.x.toFloat(), d.y.toFloat(), d.width.toFloat(), d.height.toFloat())
                    batch.color = Color.WHITE
                }
                return
            }
            val cache = chunks?.takeIf { it.rendererTilePixels == T } ?: RealmKitChunkCache(kit, T).also { chunks = it }
            val texture = textures.getValue(kit.tileset.id)
            for ((cx, cy) in cache.visibleChunks(view)) {
                val chunk = cache.vertices(cx, cy, claim, elapsedMs, reducedMotion)
                if (chunk.quads > 0) { batch.draw(texture, chunk.vertices, 0, chunk.quads * 20); realmKitChunkDraws++; realmKitTileQuads += chunk.quads }
            }
        }
        /** The culled props AND the roaming creatures (D-153 creature paths) for this frame's clock under the
         * claim [drawFloor] stamped this frame (E-6: the kingdom and its ring hide their props), in the shared
         * ground-band order (`realmKitGroundBandPlan`: one painter's band by the anchor row, birds and smoke
         * above it), straight over the floor: the ground band, never the depth-sorted structure pass (see
         * [drawTerrain]). A creature's sheet cell is its facing row × frames + walk frame; reduced motion
         * pins the first vertex. */
        fun drawProps(tilePixels: Float) {
            for (entry in kit.groundBandPlan(tilePixels.toDouble(), view(), claim, elapsedMs, reducedMotion)) drawRegion(entry.draw)
        }
        /** E-11: the kit twin of a server obstacle row (RealmKitManifest.obstacleDraw), or null when the kit
         * leaves its key to the catalogue `dec_` drawable. */
        fun obstacle(row: RenderObstacle, state: RealmKitObstacleState, tilePixels: Float): Pair<TextureRegion, LayeredGroundRect>? {
            val draw = kit.obstacleDraw(row.spriteKey ?: return null, state, tilePixels.toDouble(),
                row.tileX.toDouble(), row.tileY.toDouble(), row.footprintWidth.toDouble(), row.footprintHeight.toDouble()) ?: return null
            return region(draw) to draw.destination
        }
        /** E-11: the kit's remnant twin (stump/rubble) of a felled row, seated on the row's old footprint like
         * [obstacle]; null when the manifest leaves the key unmapped, and then the tile stays bare. */
        fun remnant(r: RenderRemnant, tilePixels: Float): Pair<TextureRegion, LayeredGroundRect>? {
            val draw = kit.obstacleDraw(r.spriteKey, RealmKitObstacleState.REMNANT, tilePixels.toDouble(),
                r.tileX.toDouble(), r.tileY.toDouble(), r.footprintWidth.toDouble(), r.footprintHeight.toDouble()) ?: return null
            return region(draw) to draw.destination
        }
        /** Called for every prop, creature and obstacle twin on every frame: keyed by the asset, then the source rect itself
         *  (a data class, hashed without allocating), never by a formatted string (four Double formats and a String per
         *  draw, hundreds a frame, were steady garbage and GC pauses on Home). */
        fun region(draw: LayeredGroundDraw): TextureRegion {
            val byAsset = regions.getOrPut(draw.asset.id) { HashMap() }
            return byAsset.getOrPut(draw.source) { TextureRegion(textures.getValue(draw.asset.id), draw.source.x.toInt(), draw.source.y.toInt(),
                draw.source.width.toInt(), draw.source.height.toInt()).also { it.flip(false, true) } }
        }
        private fun drawRepeat(draw: LayeredGroundDraw) {
            requireNotNull(draw.repeat).writeQuad(draw.destination, repeatVertices)
            batch.draw(textures.getValue(draw.asset.id), repeatVertices, 0, repeatVertices.size)
        }
        private fun drawRegion(draw: LayeredGroundDraw) {
            val b = draw.destination
            batch.draw(region(draw), b.x.toFloat(), b.y.toFloat(), b.width.toFloat(), b.height.toFloat())
        }
        fun resetClock() { previousNanos = 0L }
        fun dispose() { if (!closed) { closed = true; textures.values.forEach { it.dispose() }; textures.clear(); regions.clear(); chunks = null; prepared.close() } }
    }

    /** One realm painting on the GPU as a managed texture over the retained pixmap (see [managedTexture]),
     * drawn over the plan's coverage: v1 shows the realm colour beyond its rasterised window, v2 repeats
     * the world's edge pixels beyond the painting. */
    private inner class GroundSurface(val prepared: PreparedGround) {
        val plan: GroundPlan get() = prepared.plan
        private val texture = managedTexture(prepared.pixmap).also {
            it.setWrap(Texture.TextureWrap.ClampToEdge, Texture.TextureWrap.ClampToEdge)
        }
        private val region = TextureRegion(texture)
        val red = (plan.source.color shr 16 and 255) / 255f
        val green = (plan.source.color shr 8 and 255) / 255f
        val blue = (plan.source.color and 255) / 255f
        fun worldBounds(tilePixels: Float) = plan.worldBounds(tilePixels)
        fun draw(tilePixels: Float) {
            val halfW=camera.viewportWidth*camera.zoom/2; val halfH=camera.viewportHeight*camera.zoom/2
            val bounds=plan.drawBounds(tilePixels,BaseWorldBounds(camera.position.x-halfW,camera.position.y-halfH,
                camera.position.x+halfW,camera.position.y+halfH))
            val left=bounds.left; val top=bounds.top; val right=bounds.right; val bottom=bounds.bottom
            val window = plan.textureWindow(tilePixels, left, top, right, bottom)
            region.setRegion(window[0], window[1], window[2], window[3]); region.flip(false, true)
            batch.draw(region, left, top, right - left, bottom - top)
        }
        fun dispose() { texture.dispose(); prepared.pixmap.dispose() }
    }

    /** `FantasyGroundMotion.onUpdate`: cached world motes reselected only when the view changes, glyphs
     * redrawn every `motion.frameMs`; a paused surface never catches up a backlog. */
    private fun drawGroundMotion(active: BaseScene) {
        if (realmKit != null) return // Revision-5 props enter the depth-sorted structure pass; the floor already advanced the clock.
        layeredGround?.let { it.drawMotion(active.tilePixels); return }
        if (reducedMotion) { motionGlyphs.clear(); motionNextMs = 0L; return }
        val surface = ground ?: return; val rules = groundRules ?: return
        if (surface.prepared.motes.isEmpty()) return
        val now = System.currentTimeMillis()
        if (now >= motionNextMs) {
            motionNextMs = now + rules.motionFrameMs
            motionPhase += rules.motionFrameMs / 1000.0
            val halfWidth = camera.viewportWidth * camera.zoom / 2; val halfHeight = camera.viewportHeight * camera.zoom / 2
            val left = camera.position.x - halfWidth; val top = camera.position.y - halfHeight
            val view = "$left:$top:$halfWidth:$halfHeight"
            if (view != motionView) {
                motionView = view
                motionVisible = visibleGroundMotes(surface.prepared.motes, left, top, camera.position.x + halfWidth, camera.position.y + halfHeight, active.tilePixels, rules.motionMaxVisiblePoints)
            }
            motionGlyphs.clear()
            // Web screen pixels are CSS pixels; Android's equivalent is density-independent pixels.
            val screenScale = Gdx.graphics.width / (camera.viewportWidth * camera.zoom * Gdx.graphics.density)
            for (point in motionVisible) surface.prepared.motion.glyphs(point, motionPhase, surface.plan.visual.realmId, motionGlyphs, screenScale)
        }
        if (motionGlyphs.isEmpty()) return
        Gdx.gl.glEnable(GL20.GL_BLEND); Gdx.gl.glBlendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        shapes.projectionMatrix = sensoryProjection
        shapes.begin(ShapeRenderer.ShapeType.Filled)
        for (glyph in motionGlyphs) when (glyph) {
            is GroundGlyph.Line -> { tint(glyph.color, glyph.alpha); shapes.rectLine(glyph.x1, glyph.y1, glyph.x2, glyph.y2, glyph.width) }
            is GroundGlyph.StrokeEllipse -> {
                tint(glyph.color, glyph.alpha)
                val segments = 24; var previousX = glyph.cx + glyph.width / 2; var previousY = glyph.cy
                for (i in 1..segments) {
                    val angle = 2 * PI * i / segments
                    val x = glyph.cx + (cos(angle) * glyph.width / 2).toFloat(); val y = glyph.cy + (sin(angle) * glyph.height / 2).toFloat()
                    shapes.rectLine(previousX, previousY, x, y, glyph.lineWidth); previousX = x; previousY = y
                }
            }
            is GroundGlyph.FillEllipse -> { tint(glyph.color, glyph.alpha); shapes.ellipse(glyph.cx - glyph.width / 2, glyph.cy - glyph.height / 2, glyph.width, glyph.height) }
            is GroundGlyph.FillRect -> { tint(glyph.color, glyph.alpha); shapes.rect(glyph.x, glyph.y, glyph.width, glyph.height) }
            is GroundGlyph.FillTriangle -> { tint(glyph.color, glyph.alpha); shapes.triangle(glyph.x0, glyph.y0, glyph.x1, glyph.y1, glyph.x2, glyph.y2) }
            is GroundGlyph.FillCircle -> { tint(glyph.color, glyph.alpha); shapes.circle(glyph.cx, glyph.cy, glyph.radius) }
        }
        shapes.end()
    }
    private fun tint(color: Int, alpha: Float) = shapes.setColor((color shr 16 and 255) / 255f, (color shr 8 and 255) / 255f, (color and 255) / 255f, alpha)

    private fun fill(rect: HighlightRect) = shapes.rect(rect.x, rect.y, rect.width, rect.height)
    private fun beginHighlightShapes() {
        Gdx.gl.glEnable(GL20.GL_BLEND); Gdx.gl.glBlendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        shapes.projectionMatrix = camera.combined
        shapes.begin(ShapeRenderer.ShapeType.Filled)
    }

    /** Re-aims the selection marker when the app's highlights change: the first SELECTION is the marked building
     * (KingdomViewModel), every SELECTION / OUTLINE target wears the sprite rim. The same footprint again (a routine
     * refresh) leaves the marker exactly as it is; no SELECTION plays the deselect. Runs on change, not per frame. */
    private fun selectionChanged(active: BaseScene) {
        var target: SceneHighlight? = null
        val ids = HashSet<String>()
        for (index in highlights.indices) {
            val highlight = highlights[index]
            if (highlight.kind != SceneHighlightKind.SELECTION && highlight.kind != SceneHighlightKind.OUTLINE) continue
            if (target == null && highlight.kind == SceneHighlightKind.SELECTION) target = highlight
            highlight.targetId?.let { ids += it }
        }
        outlineIds = ids
        if (target == null) { selectionMotion.hide(); return }
        selectionTargetId = target.targetId; selectionBaseId = active.baseId; selectionFillAlpha = target.alpha
        selectionMotion.show(target.tileX, target.tileY, target.width, target.height, reducedMotion)
    }

    /** App-owned tile fills, the plot grid and the selection marker, drawn after the ground and BEFORE the base
     * sprites: the marker lies on the ground under the building it marks (design-beacon `selected.png`), and the web
     * tints the tiles beneath a moving building while keeping the art itself untinted. Allocates nothing per frame. */
    private fun drawHighlightFills(active: BaseScene) {
        if (selectionMotion.visible && selectionBaseId != active.baseId) selectionMotion.reset()
        val moving = carry.highlights
        if (!selectionMotion.visible && !hasFills(highlights) && !hasFills(moving)) return
        val tile = active.tilePixels
        val dp = HighlightGeometry.worldPerDp(Gdx.graphics.density, camera.zoom)
        beginHighlightShapes()
        drawFills(highlights, tile, dp); drawFills(moving, tile, dp)
        val motion = selectionMotion
        if (motion.visible) drawSelectionFrame(motion.tileX * tile, motion.tileY * tile, motion.width * tile, motion.height * tile,
            motion.scale, motion.ringAlpha, selectionFillAlpha, dp)
        shapes.end()
    }
    private fun hasFills(list: List<SceneHighlight>): Boolean {
        for (index in list.indices) when (list[index].kind) {
            SceneHighlightKind.GRID, SceneHighlightKind.FOOTPRINT, SceneHighlightKind.SELECTION, SceneHighlightKind.OUTLINE -> return true
            SceneHighlightKind.FILL, SceneHighlightKind.GRID_OVERLAY, SceneHighlightKind.FOOTPRINT_OVERLAY -> Unit
        }
        return false
    }
    private fun drawFills(list: List<SceneHighlight>, tile: Float, dp: Float) {
        // The first SELECTION is the animated marker, drawn after this loop by [drawHighlightFills]; any other one (or
        // that one while the marker is down) stands still.
        var marked = !selectionMotion.visible
        for (index in list.indices) {
            val highlight = list[index]
            when (highlight.kind) {
                SceneHighlightKind.GRID -> {
                    tint(highlight.color, highlight.alpha)
                    val columns = highlight.width.roundToInt().coerceAtLeast(1); val rows = highlight.height.roundToInt().coerceAtLeast(1)
                    for (line in HighlightGeometry.gridLines(highlight.tileX * tile, highlight.tileY * tile, columns, rows, tile, dp * HighlightGeometry.GRID_LINE_DP)) fill(line)
                }
                SceneHighlightKind.FOOTPRINT -> {
                    tint(highlight.color, highlight.alpha)
                    shapes.rect(highlight.tileX * tile, highlight.tileY * tile, highlight.width * tile, highlight.height * tile)
                }
                SceneHighlightKind.OUTLINE -> {
                    tint(SelectionChrome.GOLD_HI, highlight.alpha)
                    shapes.rect(highlight.tileX * tile, highlight.tileY * tile, highlight.width * tile, highlight.height * tile)
                }
                SceneHighlightKind.SELECTION -> {
                    if (marked) drawSelectionFrame(highlight.tileX * tile, highlight.tileY * tile, highlight.width * tile, highlight.height * tile,
                        1f, 1f, highlight.alpha, dp)
                    marked = true
                }
                SceneHighlightKind.FILL, SceneHighlightKind.GRID_OVERLAY, SceneHighlightKind.FOOTPRINT_OVERLAY -> Unit
            }
        }
    }

    /** The designed stepped footprint frame ([SelectionChrome]): soft gold-hi fill, 7 dp ink then 3 dp gold-hi on the
     * footprint edge, the dashed gold ring inside; scaled by [scale] about the footprint centre, faded by [alpha]. */
    private fun drawSelectionFrame(x: Float, y: Float, width: Float, height: Float, scale: Float, alpha: Float, fillAlpha: Float, dp: Float) {
        if (alpha <= 0f) return
        val f = selectionFrame
        SelectionChrome.layout(f, x, y, width, height, dp, scale)
        tint(SelectionChrome.GOLD_HI, (fillAlpha * alpha).coerceIn(0f, 1f))
        SelectionChrome.steppedFill(f.x, f.y, f.width, f.height, f.step) { rx, ry, rw, rh -> shapes.rect(rx, ry, rw, rh) }
        tint(SelectionChrome.INK, alpha)
        SelectionChrome.steppedStroke(f.x, f.y, f.width, f.height, f.step, f.ink) { rx, ry, rw, rh -> shapes.rect(rx, ry, rw, rh) }
        tint(SelectionChrome.GOLD_HI, alpha)
        SelectionChrome.steppedStroke(f.x, f.y, f.width, f.height, f.step, f.rim) { rx, ry, rw, rh -> shapes.rect(rx, ry, rw, rh) }
        if (f.hasInner) {
            tint(SelectionChrome.GOLD, SelectionChrome.DASH_ALPHA * alpha)
            SelectionChrome.dashedRect(f.innerX, f.innerY, f.innerWidth, f.innerHeight, f.dash, f.dashOn, f.dashOff) { rx, ry, rw, rh -> shapes.rect(rx, ry, rw, rh) }
        }
    }

    /** Wall-stroke fills and the placement / layout footprint strokes, drawn AFTER the base sprites so an outline
     * is never hidden by the art it marks (web `overlayDepth`: UI on the world, never occluded by it). The selection
     * marker lies under the sprites instead ([drawHighlightFills]) and its rim is part of the sprite pass
     * ([drawOutlineRun]). Allocates nothing per frame on the selection path. */
    private fun drawHighlightStrokes(active: BaseScene) {
        val painted = wallStroke.highlights; val moving = carry.highlights
        if (!hasStrokes(highlights) && !hasStrokes(painted) && !hasStrokes(moving)) return
        val tile = active.tilePixels
        val dp = HighlightGeometry.worldPerDp(Gdx.graphics.density, camera.zoom)
        beginHighlightShapes()
        drawStrokes(highlights, tile, dp); drawStrokes(painted, tile, dp); drawStrokes(moving, tile, dp)
        shapes.end()
    }
    private fun hasStrokes(list: List<SceneHighlight>): Boolean {
        for (index in list.indices) when (list[index].kind) {
            SceneHighlightKind.FILL, SceneHighlightKind.FOOTPRINT, SceneHighlightKind.FOOTPRINT_OVERLAY, SceneHighlightKind.GRID_OVERLAY -> return true
            SceneHighlightKind.SELECTION, SceneHighlightKind.OUTLINE, SceneHighlightKind.GRID -> Unit
        }
        return false
    }
    private fun drawStrokes(list: List<SceneHighlight>, tile: Float, dp: Float) {
        val outline = dp * HighlightGeometry.OUTLINE_DP
        for (index in list.indices) {
            val highlight = list[index]
            val x = highlight.tileX * tile; val y = highlight.tileY * tile; val width = highlight.width * tile; val height = highlight.height * tile
            when (highlight.kind) {
                SceneHighlightKind.FILL -> { tint(highlight.color, highlight.alpha); shapes.rect(x, y, width, height) }
                SceneHighlightKind.FOOTPRINT, SceneHighlightKind.FOOTPRINT_OVERLAY -> {
                    if (highlight.kind == SceneHighlightKind.FOOTPRINT_OVERLAY) {
                        tint(highlight.color, highlight.alpha); shapes.rect(x, y, width, height)
                    }
                    tint(highlight.color, HighlightGeometry.STROKE_ALPHA)
                    for (bar in HighlightGeometry.outlineSegments(x, y, width, height, outline)) fill(bar)
                }
                SceneHighlightKind.GRID_OVERLAY -> {
                    tint(highlight.color, highlight.alpha)
                    val columns = highlight.width.roundToInt(); val rows = highlight.height.roundToInt()
                    for (line in HighlightGeometry.gridLines(x, y, columns, rows, tile, dp * HighlightGeometry.GRID_LINE_DP)) fill(line)
                }
                SceneHighlightKind.SELECTION, SceneHighlightKind.OUTLINE, SceneHighlightKind.GRID -> Unit
            }
        }
    }

    private companion object { const val WALL_ATLAS_PAGE = 1024 }
}

/** Owner 2026-10-06 ("fast", no loading screens): until a renderer has drawn its first complete frame nothing of it is on
 *  screen (the app veils it), so its texture loader may spend up to [FIRST_OPEN_LOADER_BUDGET_MS] of each GL frame instead of
 *  one step: libGDX's `AssetManager.update()` advances one step of one task, so every atlas page waited ~3 frames for its
 *  decode hand-off and upload. Once a scene is drawn (0 = one step per frame) a revision never stacks uploads into a frame. */
internal fun loaderBudgetMs(presented: Boolean): Int = if (presented) 0 else FIRST_OPEN_LOADER_BUDGET_MS
internal const val FIRST_OPEN_LOADER_BUDGET_MS = 12
