package gg.pixelkingdomwars.nativeclient.renderer

/** Optional local observation only. Implementations must never block the render thread. */
interface LocalSceneDiagnostics {
    val observeCampFrames: Boolean get() = false
    /** Offline instrumentation only; no service work or counters are enabled by default. */
    val observeServiceFrames: Boolean get() = false
    fun frameStarted()
    fun frameCompleted()
    fun state(snapshot: LocalSceneSnapshot)
    fun lifecycle(stage: LocalLifecycleStage): LocalLifecycleSpan? = null
}
/** Closed vocabulary only: no caller-supplied paths, identities or exception text. */
enum class LocalLifecycleStage { FRAGMENT_REMOVE, FRAGMENT_PAUSE, RENDERER_DISPOSE, ASSET_MANAGER_DISPOSE }
fun interface LocalLifecycleSpan { fun end() }
inline fun <T> LocalSceneDiagnostics?.duringLifecycle(stage: LocalLifecycleStage, work: () -> T): T {
    val span = runCatching { this?.lifecycle(stage) }.getOrNull()
    try { return work() } finally { runCatching { span?.end() } }
}
enum class LocalSceneKind { LOADING, BASE, BATTLE }
data class LocalSceneSnapshot(val kind: LocalSceneKind, val queueDepth: Int, val textureMiB: Double,
    val pendingWallUploads: Int, val viewportWidth: Int, val viewportHeight: Int,
    val cameraX: Double, val cameraY: Double, val cameraZoom: Double,
    /** Bounded local presentation counters. No player, troop or account identifiers. */
    val campCount: Int = 0, val campRosterHash: Int = 0, val campPoseHash: Int = 0,
    val campDrawn: Int = 0, val campFrameHash: Int = 0,
    /** Previous completed Home draw, not a permission or content-readiness API. */
    val serviceDrawn: Int = 0, val serviceLayers: Int = 0, val serviceFrameHash: Int = 0,
    val serviceOutlines: Int = 0, val serviceGroups: Int = 0, val serviceSceneRevision: Long = 0,
    /** Previous completed battle draw. Hash folds ordinal, event tick, frame key, emitted x/y bits. */
    val serviceHitDrawn: Int = 0, val serviceHitHash: Int = 0, val serviceHitTick: Float = 0f,
    /** The previous frame's revision-5 ground: overview stills, tile chunk batches and tile quads it drew. */
    val realmKitStillDraws: Int = 0, val realmKitChunkDraws: Int = 0, val realmKitTileQuads: Int = 0)

/** Local timing crosses the scene boundary as a callback, never canonical game data. */
enum class LocalPreparationStage { MAPPER_QUEUED, MAPPER_STARTED, MAPPER_COMPLETED, RENDERER_QUEUED, RENDERER_STARTED, RENDERER_COMPLETED, GL_ACTIVATED, FIRST_DRAW }
enum class LocalPreparationOutcome { CANCELLED, SUPERSEDED, FAILED }
interface LocalPreparationTrace {
    fun stage(stage: LocalPreparationStage)
    /** One concrete renderer generation owns all later milestones. */
    fun renderer(generation: Long): LocalPreparationTrace?
    fun finish(outcome: LocalPreparationOutcome)
}
fun LocalPreparationTrace?.observe(stage: LocalPreparationStage) { runCatching { this?.stage(stage) } }
fun LocalPreparationTrace?.end(outcome: LocalPreparationOutcome) { runCatching { this?.finish(outcome) } }
