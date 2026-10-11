package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent

import android.graphics.Rect
import android.opengl.GLSurfaceView
import android.os.Bundle
import android.util.Log
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.chrome.LoadingOverlay
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.doOnAttach
import androidx.fragment.app.FragmentActivity
import androidx.fragment.app.FragmentManager
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.diagnostics.LocalNativeDiagnosticsEnabled
import gg.pixelkingdomwars.nativeclient.diagnostics.NativeDiagnosticsRuntime
import gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports
import com.badlogic.gdx.backends.android.AndroidApplicationConfiguration
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import com.badlogic.gdx.files.FileHandle
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.BundledContent
import gg.pixelkingdomwars.nativeclient.GameContentCache
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.content.SceneContentLeases
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.audio.BattleAudioBridge
import gg.pixelkingdomwars.nativeclient.ui.LocalNativeAudio
import gg.pixelkingdomwars.nativeclient.ui.LocalNativeSensory
import gg.pixelkingdomwars.nativeclient.ui.BattleSensoryBridge
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.asStateFlow

/** The GL surface fragments AndroidX rebuilds by class name: the base scene's and every World surface (the legacy
 * globe's [WorldFragment] and the GL30 world's WorldEngineFragment both extend [WorldApplicationFragment]). */
internal val RESTORABLE_GL_SURFACES: List<Class<*>> = listOf(KingdomFragment::class.java, WorldApplicationFragment::class.java)

/** Configure each pointer-driven GL surface and its container before attachment.
 * Compose owns keyboard/IME and accessible controls outside this subtree. The parent
 * barrier also refuses libGDX's later focus requests; clearing here removes any stale
 * focused bit from initialization before Compose can observe the View. */
internal fun <T : View> T.withoutSceneInputFocus(): T = apply {
    if (this is ViewGroup) descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
    isFocusableInTouchMode = false
    isFocusable = false
    clearFocus()
}

/** Discard process/configuration-restored GL fragments immediately after Activity.onCreate.
 * Compose must supply freshly admitted content and scenes before any surface is initialized.
 * A restored view has no Compose container; destroying it after STARTED can wait forever for
 * a render-thread acknowledgment because that unattached GL surface cannot draw a frame. */
internal fun discardRestoredGlSurfaces(manager: FragmentManager) {
    val restored=manager.fragments.filter { f -> RESTORABLE_GL_SURFACES.any { it.isInstance(f) } }
    if(restored.isEmpty()) return
    check(restored.all { it.view==null && !it.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }) {
        "Restored game surfaces must be discarded before view creation"
    }
    manager.beginTransaction().apply { restored.forEach { remove(it) } }.commitNow()
}

/** Keeps exactly one [KingdomFragment] per content generation for the activity, shared by Home,
 * Battle and Replay. Screens hand it scenes; the teardown ordering below is what keeps libGDX's
 * pause handshake alive when the GL surface leaves the composition. */
class SceneHost(private val activity: FragmentActivity) {
    private val fragments = mutableMapOf<String, KingdomFragment>()
    private var resumedAtMs = 0L
    fun resumed() { resumedAtMs = android.os.SystemClock.elapsedRealtime() }
    /** [fleet]: N-C5 RESIDENCY optional typed private fleet capability beside the source (no production caller passes one). */
    private data class Services(val owner: Any, val assets: File, val source: ServiceAssetSource, val enabled: Boolean, val fleet: PhaseEFleetArt? = null)
    private var services: Services? = null
    private val refresh = ServiceRefreshRequests()
    /** EXISTING signal: every explicit foreground/lifecycle refresh AND every scene preparation (the 15 observer re-observes on each). */
    val serviceRefreshRequests get() = refresh.serviceRefreshRequests
    /** N-C5 CONTENT-MOUNT R1: capability re-observation only (see [ServiceRefreshRequests]); the bound-17 observer collects this. */
    val capabilityRefreshRequests get() = refresh.capabilityRefreshRequests
    fun requestServiceRefresh() = refresh.requestServiceRefresh()
    fun requestSceneRefresh(previousBaseId: String?, previousBattle: Boolean, nextBaseId: String?, nextBattle: Boolean) =
        refresh.requestSceneRefresh(previousBaseId, previousBattle, nextBaseId, nextBattle)
    fun serviceSource(owner: Any, assets: File, source: ServiceAssetSource, fleet: PhaseEFleetArt? = null) {
        revokeFleetJourneys(); publication = null // a new source is a new content identity: the activity rebinds its publication
        services = Services(owner, assets, source, false, fleet)
        fragments.values.forEach(::applyServices)
    }
    fun servicePermission(owner: Any, enabled: Boolean) {
        val current = services?.takeIf { it.owner === owner } ?: return
        if (enabled) SceneLoadLog.mark(LoadEvent.SERVICE_READY, "sinceResumeMs=${(android.os.SystemClock.elapsedRealtime() - resumedAtMs).coerceAtLeast(0)}")
        revokeFleetJourneys()
        services = current.copy(enabled = enabled); fragments.values.forEach(::applyServices)
        reconcileFleetJourneys() // permission on with a prepared generation attaches; permission off stays revoked
    }
    fun clearServices(owner: Any) {
        if (services?.owner !== owner) return
        revokeFleetJourneys(); publication = null
        services = null; fragments.values.forEach(::applyServices)
    }
    /** N-C5 CONTENT-MOUNT: the activity binds the account's own publication, its current-base read and the EXACT opened content
     *  for [owner]'s current record. From then on the host alone decides attachment, idempotently, on each prepared/lifecycle
     *  transition; nothing here polls, loads, queues or replays. Ignored unless [owner] holds the current record. */
    fun fleetPublication(owner: Any, publication: gg.pixelkingdomwars.nativeclient.data.FleetJourneyPublication, baseIdNow: () -> String?, contentIdentity: Any) {
        if (services?.owner !== owner) return
        revokeFleetJourneys()
        this.publication = PublicationBinding(owner, publication, baseIdNow, contentIdentity)
        reconcileFleetJourneys()
    }
    private data class PublicationBinding(val owner: Any, val publication: gg.pixelkingdomwars.nativeclient.data.FleetJourneyPublication, val baseIdNow: () -> String?, val contentIdentity: Any)
    private var publication: PublicationBinding? = null
    /** ONE idempotent decision (fleetPublicationDecision): a current lease for the unchanged base is KEPT warm across ordinary
     *  same-base preparations; a lease whose base changed or vanished is revoked; with no current lease, attach (cold) only when
     *  the private eligibility (owner record, resumed Home fragment, exact renderer, PREPARED generation) holds. Runs on the
     *  existing guarded preparation notice, on permission changes and at binding. Warmth never implies visual continuity. */
    fun reconcileFleetJourneys() {
        val bound = publication ?: return
        val baseId = bound.baseIdNow(); val lease = journeyLease
        val eligible = baseId != null && fleetJourneysEligible(bound.owner, baseId)
        when (fleetPublicationDecision(lease?.guard?.isCurrent() == true, lease?.baseId, baseId, eligible)) {
            FleetPublicationDecision.KEEP, FleetPublicationDecision.NONE -> Unit
            FleetPublicationDecision.REVOKE -> revokeFleetJourneys()
            FleetPublicationDecision.ATTACH -> attachFleetJourneys(bound.owner, bound.publication, requireNotNull(baseId), bound.contentIdentity)
        }
    }
    /** Synchronous lifecycle revocation precedes coroutine/network cancellation drainage. */
    fun pauseServices() { revokeFleetJourneys(); services?.let { it.source.cancelPending(); clearServices(it.owner) } }
    /** N-C5 private ingress (NOT mounted by production code). R1: the lease is bound to the EXACT
     *  service record (source + assets + permission) held at attach, to ONE admitted RESUMED fragment
     *  showing [baseId], and to the host's revocation generation; it is revoked SYNCHRONOUSLY by every
     *  service source/permission/clear/pause transition (the generation advances and the stored lease is
     *  closed), so a lease from a prior content or lifecycle can never become current again, and a
     *  journey is handed to that one fragment's renderer only. Returns null (and binds nothing) when no
     *  admitted fragment currently shows [baseId]; [contentIdentity] must be the exact admitted content
     *  the caller holds and is compared by reference. */
    fun attachFleetJourneys(owner: Any, publication: gg.pixelkingdomwars.nativeclient.data.FleetJourneyPublication,
        baseId: String, contentIdentity: Any): gg.pixelkingdomwars.nativeclient.data.FleetJourneyPublication.Lease? {
        revokeFleetJourneys()
        val bound = services?.takeIf { it.owner === owner && it.enabled } ?: return null
        // N-C5 RESIDENCY private eligibility: the exact owner's enabled record, ONE resumed Home fragment showing this base
        // with no battle, its exact renderer, and a PREPARED generation whose installed admission carries journey art.
        val renderer = fleetJourneyEligibility(bound, fragments.values.toList(),
            fragmentCurrent = { f -> (f as KingdomFragment).let { it.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && it.scene?.baseId == baseId && it.battle == null } },
            rendererOf = { f -> (f as KingdomFragment).renderer }, prepared = { r -> (r as NativeGameRenderer).fleetJourneysPrepared(baseId) }) as? NativeGameRenderer ?: return null
        val fragment = fragments.values.single { it.renderer === renderer }
        val guard = FleetJourneyLeaseGuard(servicesNow = { services }, generationNow = { serviceGeneration },
            fragmentCurrent = { f -> (f as KingdomFragment).let { it.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && it.scene?.baseId == baseId && it.battle == null } },
            rendererNow = { f -> (f as KingdomFragment).renderer }, fragmentGenerationNow = { f -> (f as KingdomFragment).journeyGeneration })
        guard.bind(bound, contentIdentity, fragment, renderer, fragment.journeyGeneration)
        fragment.onJourneyInvalidate = { revokeFleetJourneys() } // pause / destroyView / renderer replacement revoke synchronously
        val lease = publication.attach(owner, baseId, contentIdentity, guard::isCurrent) { event ->
            val target = guard.target() ?: return@attach
            val bound = guard.renderer() as? NativeGameRenderer ?: return@attach
            if ((target as KingdomFragment).renderer === bound) bound.submitFleetJourney(renderFleetJourney(event)).also { gg.pixelkingdomwars.nativeclient.data.JourneyEvidenceLog.published(event, it) }
        }
        journeyLease = HeldLease(lease, guard, baseId)
        return lease
    }
    private var serviceGeneration = 0L
    private class HeldLease(val lease: gg.pixelkingdomwars.nativeclient.data.FleetJourneyPublication.Lease, val guard: FleetJourneyLeaseGuard, val baseId: String)
    private var journeyLease: HeldLease? = null
    /** Synchronous revocation: advances the generation (every outstanding guard turns false at once),
     *  revokes the guard and closes the stored lease (owner-safe in the publication). */
    private fun revokeFleetJourneys() {
        serviceGeneration += 1
        journeyLease?.let { held -> held.guard.revoke(); held.lease.close() }
        journeyLease = null
    }
    private fun applyServices(fragment: KingdomFragment) {
        val current = services?.takeIf { it.assets.absolutePath == fragment.assetPath }
        fragment.serviceContent(current?.source, current?.enabled == true, current?.fleet)
    }
    /** Pure read of the private eligibility decision for [owner]'s current record and [baseId]; attaches nothing. */
    fun fleetJourneysEligible(owner: Any, baseId: String): Boolean {
        val bound = services?.takeIf { it.owner === owner && it.enabled } ?: return false
        return fleetJourneyEligibility(bound, fragments.values.toList(),
            fragmentCurrent = { f -> (f as KingdomFragment).let { it.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && it.scene?.baseId == baseId && it.battle == null } },
            rendererOf = { f -> (f as KingdomFragment).renderer }, prepared = { r -> (r as NativeGameRenderer).fleetJourneysPrepared(baseId) }) != null
    }
    fun fragmentFor(assets: File): KingdomFragment {
        val tag = tagFor(assets)
        return fragments.getOrPut(tag) { KingdomFragment() }.also {
            it.assetPath = assets.absolutePath; it.onServiceRefresh = ::requestServiceRefresh; it.onScenePrepared = ::reconcileFleetJourneys; applyServices(it)
        }
    }
    fun tagFor(assets: File) = "native-kingdom-${assets.name}"
    /** The Home scene's camera controls, shared with the World tab: the realm map's Enter-base seam hands the base scene
     *  its opening camera through [SceneCameraControls.enterAt] (one per activity, like the fragment it drives). */
    val homeCamera = SceneCameraControls(null)
}

/** Provided by MainActivity; a test host that sets its own content falls back to a per-activity host. */
val LocalSceneHost = staticCompositionLocalOf<SceneHost?> { null }
/** Inert production default. Explicit instrumentation hosts can observe the real renderer without
 * changing either report preference; this also works in the minified, nondebuggable test build. */
val LocalSceneObserver = staticCompositionLocalOf<LocalSceneDiagnostics?> { null }

@Composable fun SceneSurface(assets: File, scene: BaseScene, modifier: Modifier, battle: BattleScene? = null, playbackKey: Int = 0,
                             performance: Boolean = false, onSelected: (String) -> Unit = {}, onGround: (Float, Float) -> Unit = { _, _ -> },
                             onProgress: (Float) -> Unit = {}, onFrame: (BattlePlaybackFrame) -> Unit = {}, highlights: List<SceneHighlight> = emptyList(), deployment:gg.pixelkingdomwars.nativeclient.ui.BattleDeployFeedback?=null,
                             wallStroke: WallStrokeMode? = null, onWallStroke: (WallStrokeEvent) -> Unit = {},
                             carry: CarryMode? = null, onCarry: (CarryEvent) -> Unit = {},
                             deploymentMode: BattleDeploymentMode? = null, onInvalidDeployment: (Float, Float) -> Unit = { _, _ -> },
                             onBattleGround: ((BattleDeploymentTarget, Float, Float) -> Unit)? = null,
                             deploymentAdmission: Any? = deploymentMode?.admission,
                             retainedPlaybackRate: Float? = null, cameraFitKey: Int = 0, cameraInsets: CameraInsets = CameraInsets(), cameraControls: SceneCameraControls? = null,
                             onPresentationReady: (Boolean) -> Unit = {}, openingTopBar: (@Composable () -> Unit)? = null,
                             onPreparationRetry: (((() -> Unit)?) -> Unit)? = null,
                             onCommandBodiesSubmitted: ((BattleCommandBodySubmission) -> Unit)? = null,
                             /** The drawn Home camera for world-anchored chrome (the army chips); written from the GL thread. */
                             baseCamera: MutableState<BaseCameraView?>? = null,
                             /** Observe a surface-local down before chrome hides; renderer still decides tap versus pan. */
                             onSurfaceDown: (Float, Float) -> Unit = { _, _ -> },
                             /** Home (scene-transitions spec §2): the parent draws the one cover (postcard or wallpaper) and its
                              *  indicator, so this surface draws no opening veil of its own; an opening that failed (preparation
                              *  error, or a fatal renderer error) is reported through [onOpeningFailure] with the preparation's
                              *  own retry when it has one (false/null once it clears). */
                             coveredByParent: Boolean = false, onOpeningFailure: (Boolean, (() -> Unit)?) -> Unit = { _, _ -> },
                             /** Home postcards (ScenePostcards): the account key, and whether Home is clean right now. */
                             postcardAccount: String? = null, postcardClean: Boolean = false) {
    val inputRegions = LocalSceneInputRegions.current
    var surfaceBounds by remember { mutableStateOf<androidx.compose.ui.geometry.Rect?>(null) }
    val inputWindow = androidx.compose.ui.platform.LocalView.current.windowToken
    val inputGeometry = inputRegions?.geometry(surfaceBounds, inputWindow)
    val reducedMotion = gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion.current
    val diagnosticsEnabled = LocalNativeDiagnosticsEnabled.current
    val sceneObserver = LocalSceneObserver.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val activity = requireNotNull(LocalActivity.current as? FragmentActivity)
    val provided = LocalSceneHost.current
    val host = provided ?: remember(activity) { SceneHost(activity) }
    val selection by rememberUpdatedState(onSelected)
    val progress by rememberUpdatedState(onProgress)
    val frame by rememberUpdatedState(onFrame)
    val ground by rememberUpdatedState(onGround)
    val surfaceDown by rememberUpdatedState(onSurfaceDown)
    val battleGround by rememberUpdatedState(onBattleGround)
    val invalidDeployment by rememberUpdatedState(onInvalidDeployment)
    val wallEvents by rememberUpdatedState(onWallStroke)
    val carryEvents by rememberUpdatedState(onCarry)
    val viewId = R.id.kingdom_surface
    val fragmentTag = host.tagFor(assets)
    val fragment = remember(fragmentTag) { host.fragmentFor(assets) }
    val audio = LocalNativeAudio.current
    val audioBridge = remember(audio, fragment) { audio?.bridge() }
    val sensory=LocalNativeSensory.current
    val sensoryBridge=remember(sensory,fragment,assets,deployment) { sensory?.bridge(assets,deployment) }
    var renderError by remember { mutableStateOf<String?>(null) }
    var preparationError by remember { mutableStateOf(false) }
    // A remounted surface must wait for its own view, even if the outgoing view of this
    // cached fragment has not been removed yet. Same-composition revisions retain readiness.
    var sceneReady by remember(fragment) { mutableStateOf(false) }
    val presentationReady by rememberUpdatedState(onPresentationReady)
    val preparationRetry by rememberUpdatedState(onPreparationRetry)
    val retryPreparation = {
        val renderer = fragment.renderer
        if (renderer != null) {
            fragment.battle?.let { renderer.updateBattle(it, fragment.audioToken) }
                ?: fragment.scene?.let(renderer::updateBase)
        }
        Unit
    }
    // This is a readiness transition, not a frame callback. The parent must not put gameplay
    // controls over the opaque shell while the first valid scene is still activating.
    LaunchedEffect(fragment, sceneReady, renderError != null) { presentationReady(sceneReady && renderError == null) }
    LaunchedEffect(fragment, sceneReady, preparationError, renderError != null) {
        preparationRetry?.invoke(if (sceneReady && preparationError && renderError == null) retryPreparation else null)
    }
    val openingFailure by rememberUpdatedState(onOpeningFailure)
    LaunchedEffect(fragment, sceneReady, preparationError, renderError != null, coveredByParent) {
        if (coveredByParent) openingFailure(!sceneReady && (preparationError || renderError != null),
            if (!sceneReady && preparationError && renderError == null) retryPreparation else null)
    }
    SideEffect { fragment.postcardAccount = postcardAccount; fragment.postcardClean = postcardClean && battle == null }
    // Spec §4 step 5: a postcard after the camera has been idle 1.5 s past a new scene (at most once per 10 s, clean Home
    // only), so a copy exists even if the one taken as the surface leaves fails (PixelCopy timing on Android 14+).
    val latestClean by rememberUpdatedState(postcardClean && battle == null)
    LaunchedEffect(fragment, sceneReady, scene, postcardAccount, battle == null) {
        val drawn = baseCamera
        if (!sceneReady || battle != null || postcardAccount == null || drawn == null) return@LaunchedEffect
        // Not inside the swap and the 2 s after it (field report 2026-10-06): the first copy waits until that has passed.
        kotlinx.coroutines.delay(POSTCARD_FIRST_SETTLE_MS)
        androidx.compose.runtime.snapshotFlow { drawn.value }.collectLatest { view ->
            if (view == null || !view.overlayVisible) return@collectLatest
            kotlinx.coroutines.delay(POSTCARD_SETTLE_MS)
            if (latestClean && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) ScenePostcards.capture(fragment, fragmentTag, proactive = true)
        }
    }
    // Retain the renderer diagnostic internally; players need the scene that failed to load.
    if (renderError != null) {
        LoadingOverlay(if (battle != null) "Couldn’t open the battlefield" else "Couldn’t open your kingdom", modifier,
            art = if (battle != null) "raid" else "profile", error = "Return to your kingdom and try again.", topBar = openingTopBar)
        return
    }
    SideEffect { fragment.onSceneReady = { sceneReady = it }; fragment.onCommandBodiesSubmitted = onCommandBodiesSubmitted }
    SideEffect { fragment.sensoryBridge=sensoryBridge;fragment.audioBridge = audioBridge; fragment.onFrame = { frame(it) }; fragment.onProgress = { progress(it) }; fragment.onSelection = { selection(it) }; fragment.onGroundSelected = { x, y -> ground(x, y) }; fragment.onError = { renderError = it }; fragment.onPreparationError = { preparationError = it != null } }
    SideEffect { fragment.onBattlePlacement = { target, x, y -> battleGround?.invoke(target, x, y) ?: ground(x, y) } }
    SideEffect { fragment.wallStrokeMode = wallStroke; fragment.onWallStroke = { wallEvents(it) }; fragment.renderer?.setWallStrokeMode(wallStroke) }
    SideEffect { fragment.carryMode = carry; fragment.onCarry = { carryEvents(it) }; fragment.renderer?.setCarryMode(carry) }
    SideEffect {
        fragment.deploymentMode = deploymentMode
        fragment.deploymentAdmission = deploymentAdmission
        fragment.onInvalidDeployment = { x, y -> invalidDeployment(x, y) }
        fragment.renderer?.setDeploymentMode(deploymentMode)
    }
    // A retried preparation may replace its diagnostic plan without changing the
    // canonical revision. Playback copies retain this immutable plan reference.
    LaunchedEffect(scene, battle?.revision, battle?.commandDrawPlan, battle?.preparationTrace) {
        // N-C5 CONTENT-MOUNT R1: a same-base, same-mode preparation refreshes service art without re-observing capability.
        host.requestSceneRefresh(fragment.scene?.baseId, fragment.battle != null, scene.baseId, battle != null)
        SceneLoadLog.mark(LoadEvent.SCENE_SUBMIT, if (battle != null) "battle" else "home")
        fragment.scene = scene; fragment.battle = battle
        fragment.audioToken = audioBridge?.change(battle) ?: BattleSensoryBridge.nextToken()
        val publish = { if (battle != null) fragment.renderer?.updateBattle(battle, fragment.audioToken) else fragment.renderer?.updateBase(scene);Unit }
        if(sensoryBridge!=null)sensoryBridge.expect(battle,fragment.audioToken,revisionReplacement=true,publish=publish) else publish()
    }
    LaunchedEffect(fragment, reducedMotion) { fragment.reducedMotion = reducedMotion; fragment.renderer?.setReducedMotion(reducedMotion) }
    val localReportLease = remember(fragment) { LocalBattleReports.openScene() }
    val observerOwner = remember(fragment, sceneObserver) { Any() }
    SideEffect { fragment.localReportLease = localReportLease }
    DisposableEffect(fragment, lifecycle, localReportLease, observerOwner) {
        localReportLease.activate()
        fragment.observerOwner = observerOwner; fragment.sceneObserver = sceneObserver
        fun update() {
            val resumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            localReportLease.visible(resumed)
            if (fragment.observerOwner === observerOwner) fragment.observerVisible = resumed
        }
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer); update()
        onDispose {
            lifecycle.removeObserver(observer); localReportLease.close()
            if (fragment.observerOwner === observerOwner) {
                fragment.observerVisible = false; fragment.observerOwner = null; fragment.sceneObserver = null
            }
            if (fragment.localReportLease === localReportLease) fragment.localReportLease = null
        }
    }
    val diagnosticsOwner = remember(fragment) { Any() }
    DisposableEffect(fragment, lifecycle, diagnosticsEnabled) {
        fragment.diagnosticsOwner = diagnosticsOwner
        fun update() {
            if (fragment.diagnosticsOwner !== diagnosticsOwner) return
            val enabled = diagnosticsEnabled && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            fragment.diagnosticsEnabled = enabled; fragment.renderer?.setDiagnosticsEnabled(enabled)
        }
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer); update()
        onDispose {
            lifecycle.removeObserver(observer)
            if (fragment.diagnosticsOwner === diagnosticsOwner) {
                fragment.diagnosticsOwner = null; fragment.diagnosticsEnabled = false; fragment.renderer?.setDiagnosticsEnabled(false)
            }
        }
    }
    SideEffect { fragment.inputGeometry = inputGeometry; fragment.renderer?.setInputGeometry(inputGeometry) }
    SideEffect { fragment.cameraInsets = cameraInsets; fragment.renderer?.setCameraInsets(cameraInsets) }
    DisposableEffect(fragment, cameraControls) {
        fragment.cameraControls = cameraControls; fragment.renderer?.setCameraControls(cameraControls)
        onDispose {
            if (fragment.cameraControls === cameraControls) fragment.cameraControls = null
            fragment.renderer?.clearCameraControls(cameraControls)
        }
    }
    DisposableEffect(fragment, baseCamera) {
        val sink: ((BaseCameraView?) -> Unit)? = baseCamera?.let { state -> { view -> state.value = view } }
        fragment.baseCameraSink(sink)
        onDispose { fragment.clearBaseCameraSink(sink); baseCamera?.value = null }
    }
    LaunchedEffect(fragment, cameraFitKey) { fragment.renderer?.requestCameraFit() }
    LaunchedEffect(highlights) { fragment.highlights = highlights; fragment.renderer?.setHighlights(highlights) }
    LaunchedEffect(playbackKey, retainedPlaybackRate) { battle?.let {
        fragment.audioToken = audioBridge?.control() ?: BattleSensoryBridge.nextToken()
        sensoryBridge?.expect(battle,fragment.audioToken)
        if (it.retainPlaybackTick) fragment.renderer?.setBattlePlaying(it.playing, fragment.audioToken, retainedPlaybackRate)
        else fragment.renderer?.setBattlePlayback(it.playheadTick, it.rate, it.playing, fragment.audioToken)
    } }
    val removeFragment: () -> Unit = remember(fragment, audioBridge, sensoryBridge) {
        var removed = false
        return@remember {
            // The outgoing DisposableEffect can run after a new surface attaches; it must never
            // remove a fragment that the incoming scene reuses.
            if (!removed) {
                removed = true
                // The GL surface is still attached here: keep its last Home frame as the next opening's postcard.
                if (fragment.isAdded) ScenePostcards.capture(fragment, fragmentTag, proactive = false)
                SceneLoadLog.mark(LoadEvent.FRAGMENT_REMOVE, if (fragment.battle != null) "battle" else "home")
                localReportLease.duringLifecycle(LocalLifecycleStage.FRAGMENT_REMOVE) {
                fragment.localReportLease?.visible(false); fragment.observerVisible = false
                fragment.wallStrokeMode = null; fragment.renderer?.setWallStrokeMode(null)
                fragment.carryMode = null; fragment.renderer?.setCarryMode(null)
                fragment.deploymentMode = null; fragment.renderer?.setDeploymentMode(null)
                fragment.deploymentAdmission = null
                audioBridge?.close();sensoryBridge?.close()
                if (!activity.isDestroyed && !activity.supportFragmentManager.isDestroyed && fragment.isAdded)
                    activity.supportFragmentManager.beginTransaction().remove(fragment).commitNowAllowingStateLoss()
                }
            }
        }
    }
    // A parent node detaches before its children. Dispose the fragment while the child GLSurfaceView
    // is still attached: AndroidView detaches its GL thread before DisposableEffect runs.
    Box(modifier.onGloballyPositioned { surfaceBounds = it.boundsInWindow() }.then(FragmentTeardownElement(removeFragment))) {
        AndroidView(modifier = Modifier.fillMaxSize(), factory = { context ->
            object : FrameLayout(context) {
                override fun dispatchTouchEvent(event: MotionEvent): Boolean {
                    when (event.actionMasked) {
                        MotionEvent.ACTION_DOWN -> { surfaceDown(event.x, event.y); fragment.baseCameraContact(true) }
                        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> fragment.baseCameraContact(false)
                    }
                    return super.dispatchTouchEvent(event)
                }
                override fun onDetachedFromWindow() { fragment.baseCameraContact(false); super.onDetachedFromWindow() }
            }.also { container ->
                container.withoutSceneInputFocus()
                container.id = viewId
                fragment.reducedMotion = reducedMotion
                fragment.localReportLease = localReportLease
                fragment.observerOwner = observerOwner; fragment.sceneObserver = sceneObserver
                fragment.performanceEnabled = BuildConfig.DEBUG && performance
                fragment.assetPath = assets.absolutePath
                if (!fragment.isAdded) fragment.arguments = Bundle().apply { putString("assetPath", fragment.assetPath); putBoolean("performanceEnabled", fragment.performanceEnabled) }
                fragment.scene = scene
                fragment.battle = battle
                fragment.wallStrokeMode = wallStroke
                fragment.carryMode = carry
                fragment.deploymentMode = deploymentMode
                fragment.deploymentAdmission = deploymentAdmission
                fragment.cameraInsets = cameraInsets
                fragment.inputGeometry = inputGeometry
                fragment.sensoryBridge=sensoryBridge
                fragment.audioBridge = audioBridge
                fragment.audioToken = audioBridge?.change(battle) ?: BattleSensoryBridge.nextToken()
                sensoryBridge?.expect(battle,fragment.audioToken)
                container.doOnAttach {
                    if (!fragment.isAdded && !activity.supportFragmentManager.isStateSaved) activity.supportFragmentManager.beginTransaction().add(viewId, fragment, fragmentTag).commitNow()
                }
            }
        })
        // Home's cover is its parent's (ScenePresentationLayer: postcard or wallpaper, never this dark shell). Battle, replay
        // and scout keep the LoadingOverlay until their own transition lands (spec V2 step 8).
        if (!sceneReady && !coveredByParent) LoadingOverlay(
            if (preparationError) { if (battle != null) "Couldn’t open the battlefield" else "Couldn’t open your kingdom" }
            else if (battle != null) "Entering battle…" else "Opening your kingdom…",
            art = if (battle != null) "raid" else "profile", topBar = openingTopBar,
            error = if (preparationError) "Try opening this scene again." else null, onRetry = retryPreparation)
        // Owner 2026-10-06 ("no card over the base"): a covered Home keeps its picture and says it once as a kit toast, then
        // re-submits the same scene once (homeUpdateFailure). Uncovered scenes keep the card.
        if (preparationError && sceneReady && onPreparationRetry == null && !coveredByParent) Card(Modifier.align(Alignment.TopCenter).safeDrawingPadding().padding(8.dp)) {
            Column(Modifier.padding(8.dp)) {
                Text(if (battle != null) "Couldn’t update the battlefield." else "Couldn’t update your base.")
                TextButton(onClick = retryPreparation) { Text("TRY AGAIN") }
            }
        }
        val updateFailed = homeUpdateFailure(preparationError, sceneReady, coveredByParent)
        LaunchedEffect(fragment, updateFailed) {
            if (!updateFailed) return@LaunchedEffect
            gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(HOME_UPDATE_FAILED, error = true)
            kotlinx.coroutines.delay(HOME_UPDATE_RETRY_MS)
            retryPreparation()
        }
    }
    DisposableEffect(fragment, audioBridge, sensoryBridge) { onDispose { removeFragment(); audioBridge?.let { audio?.release(it) } } }
}

/** A covered Home whose scene revision failed to prepare (the previous scene is still drawn): no card over the base. */
internal fun homeUpdateFailure(preparationError: Boolean, sceneReady: Boolean, coveredByParent: Boolean): Boolean =
    preparationError && sceneReady && coveredByParent
internal const val HOME_UPDATE_FAILED = "Couldn’t update your base. Trying once more…"
/** One automatic re-submission of the same scene after the toast; a persistent failure waits for the next Home update. */
internal const val HOME_UPDATE_RETRY_MS = 3_000L

internal data class FragmentTeardownElement(val remove: () -> Unit) : ModifierNodeElement<FragmentTeardownNode>() {
    override fun create() = FragmentTeardownNode(remove)
    override fun update(node: FragmentTeardownNode) { node.remove = remove }
    override fun InspectorInfo.inspectableProperties() { name = "fragmentTeardownBeforeGlDetach" }
}
internal class FragmentTeardownNode(var remove: () -> Unit) : Modifier.Node() {
    override fun onDetach() { remove() }
}

/** AndroidFragmentApplication owns pause/resume/dispose and the GL surface. */
class KingdomFragment : AndroidFragmentApplication() {
    var assetPath: String = ""
    /** Set only by a dedicated offline test host, never by server state or a default selector. */
    var layeredGroundPreview: Boolean = false
    /** ScenePostcards: the owner's account key and whether Home is clean right now (set by SceneSurface on Main). */
    @Volatile var postcardAccount: String? = null
    @Volatile var postcardClean: Boolean = false
    var performanceEnabled: Boolean = false
    var diagnosticsEnabled: Boolean = false
    var diagnosticsOwner: Any? = null
    @Volatile var localReportLease: LocalBattleReports.SceneLease? = null
    @Volatile var sceneObserver: LocalSceneDiagnostics? = null
    @Volatile var observerOwner: Any? = null
    @Volatile var observerVisible = false
    var reducedMotion: Boolean = false
    /** N-C5 (R1c): a BASE IDENTITY change or a Home/battle MODE transition invalidates the journey lease
     *  SYNCHRONOUSLY, before the state is replaced (an away-and-back between two predicate observations
     *  must not revive a warm lease). A same-base Home snapshot refresh does not. */
    var scene: BaseScene? = null
        set(value) { if (journeyScopeChanged(field?.baseId, battle != null, value?.baseId, battle != null)) invalidateJourneys(); field = value }
    var battle: BattleScene? = null
        set(value) { if (journeyScopeChanged(scene?.baseId, field != null, scene?.baseId, value != null)) invalidateJourneys(); field = value }
    var highlights: List<SceneHighlight> = emptyList()
    var onSelection: (String) -> Unit = {}
    var renderer: NativeGameRenderer? = null
    /** N-C5 (R1): advanced on pause, destroyView and renderer replacement; the host's journey lease is bound to it. */
    var journeyGeneration = 0L
        private set
    var onJourneyInvalidate: () -> Unit = {}
    private fun invalidateJourneys() { journeyGeneration += 1; onJourneyInvalidate() }
    private var serviceSource: ServiceAssetSource? = null
    private var serviceFleet: PhaseEFleetArt? = null
    private var servicePermission = false
    var onServiceRefresh: () -> Unit = {}
    /** N-C5 CONTENT-MOUNT: the host's reconciliation, invoked on each successful (guarded, Main-dispatched) preparation notice. */
    var onScenePrepared: () -> Unit = {}
    fun serviceContent(source: ServiceAssetSource?, enabled: Boolean, fleet: PhaseEFleetArt? = null) {
        if (serviceSource !== source || serviceFleet !== fleet) {
            renderer?.setServiceArtEnabled(false)
            serviceSource = source; serviceFleet = fleet; renderer?.setServiceAssets(source, fleet)
        }
        servicePermission = enabled && source != null
        renderer?.setServiceArtEnabled(servicePermission && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
    }
    @Volatile private var rendererOwner: Any? = null
    var onError: (String) -> Unit = {}
    var onPreparationError: (String?) -> Unit = {}
    var hasPresentedScene: Boolean = false
        private set
    var onSceneReady: (Boolean) -> Unit = {}
    var onProgress: (Float) -> Unit = {}
    var onFrame: (BattlePlaybackFrame) -> Unit = {}
    @Volatile var onCommandBodiesSubmitted: ((BattleCommandBodySubmission) -> Unit)? = null
    @Volatile var sensoryBridge:BattleSensoryBridge?=null
    @Volatile var audioBridge: BattleAudioBridge? = null
    var audioToken: Long = 0
    var onGroundSelected: (Float, Float) -> Unit = { _, _ -> }
    var onBattlePlacement: (BattleDeploymentTarget, Float, Float) -> Unit = { _, _, _ -> }
    @Volatile private var deploymentEpoch = Any()
    var onInvalidDeployment: (Float, Float) -> Unit = { _, _ -> }
    var deploymentMode: BattleDeploymentMode? = null
    var deploymentAdmission: Any? = null
    var wallStrokeMode: WallStrokeMode? = null
    var cameraInsets = CameraInsets()
    var inputGeometry: SceneInputGeometry? = null
    var cameraControls: SceneCameraControls? = null
    var onWallStroke: (WallStrokeEvent) -> Unit = {}
    var carryMode: CarryMode? = null
    var onCarry: (CarryEvent) -> Unit = {}
    private val baseCameraLock = Any()
    private var baseCameraSink: ((BaseCameraView?) -> Unit)? = null
    private var lastBaseCamera: BaseCameraView? = null
    private var baseCameraContactActive = false
    /** Synchronous UI invalidation precedes delivery of the down to the GL input queue. Only GL's settled frame
     * may restore the overlay; release/cancel never re-publishes the old camera. */
    fun baseCameraContact(active: Boolean) = synchronized(baseCameraLock) {
        baseCameraContactActive = active
        renderer?.setBaseCameraContact(active)
        if (active) {
            lastBaseCamera = lastBaseCamera?.copy(overlayVisible = false)
            baseCameraSink?.invoke(lastBaseCamera)
        }
    }
    /** A new observer of a retained renderer starts from the camera already drawn: an idle camera publishes nothing more. */
    fun baseCameraSink(sink: ((BaseCameraView?) -> Unit)?) = synchronized(baseCameraLock) { baseCameraSink = sink; sink?.invoke(lastBaseCamera) }
    /** The camera of the last drawn Home frame (a postcard keeps it, so the next renderer can open on it). */
    val drawnCamera: BaseCameraView? get() = synchronized(baseCameraLock) { lastBaseCamera }
    fun clearBaseCameraSink(sink: ((BaseCameraView?) -> Unit)?) = synchronized(baseCameraLock) { if (baseCameraSink === sink) baseCameraSink = null }
    private fun publishBaseCamera(owner: Any?, view: BaseCameraView?) = synchronized(baseCameraLock) {
        if (owner != null && rendererOwner !== owner) return@synchronized
        val visible = if (baseCameraContactActive) view?.copy(overlayVisible = false) else view
        lastBaseCamera = visible; baseCameraSink?.invoke(visible)
    }
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, state: Bundle?): View {
        check(assetPath.isNotEmpty()) { "Scene content has not been admitted" }
        performanceEnabled = BuildConfig.DEBUG && (performanceEnabled || arguments?.getBoolean("performanceEnabled") == true)
        val performance: ((String) -> Unit)? = if (performanceEnabled) ({ record -> Log.i("PKWPerf", record); Unit }) else null
        val assets = File(assetPath)
        val appRoot = requireContext().noBackupFilesDir
        if (assets.name.startsWith("bundled-")) require(assets.canonicalFile.parentFile == appRoot.canonicalFile) { "Bundled artwork escapes app storage" }
        val bundleLease = BundledContent.acquire(assets)
        val downloadedLease = if (bundleLease == null) SceneContentLeases.acquire(File(appRoot, storageNamespace(BuildConfig.API_ORIGIN, "content-updates")), assets) else null
        val localReporter = localReportLease
        val currentRendererOwner = Any().also { rendererOwner = it }
        hasPresentedScene = false
        onSceneReady(false)
        var readyPosted = false
        val createdAtMs = android.os.SystemClock.elapsedRealtime()
        val openedAs = if (battle != null) "battle" else "home"
        SceneLoadLog.mark(LoadEvent.FRAGMENT_CREATE, openedAs)
        val observed = sceneObserver
        val observedOwner = observerOwner
        fun observe(block: (LocalSceneDiagnostics) -> Unit) {
            if (observed != null && observedOwner != null && observerOwner === observedOwner && observerVisible) runCatching { block(observed) }
        }
        return try {
            val game = NativeGameRenderer(FileHandle(assetPath), { id -> activity?.runOnUiThread { onSelection(id) } }, { message ->
                dispatchSceneCallback(message, postToMain = { deliver -> activity?.runOnUiThread(deliver) },
                    isCurrent = { rendererOwner === currentRendererOwner && localReportLease === localReporter },
                    receive = {
                        // Players see a generic overlay; the exact renderer diagnostic goes to logcat only.
                        android.util.Log.e("SceneHost", "Renderer error: $it")
                        gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryRuntime.record(gg.pixelkingdomwars.nativeclient.telemetry.NativeError.RENDER)
                        onError(it)
                    })
            },
                onBattleProgress = { tick -> activity?.runOnUiThread { onProgress(tick) } }, performanceSink = performance,
                onPreparationError = { notice -> dispatchSceneCallback(notice,
                    postToMain = { deliver -> activity?.runOnUiThread(deliver) },
                    isCurrent = { rendererOwner === currentRendererOwner && localReportLease === localReporter && renderer?.isCurrentPreparation(it) == true },
                    receive = {
                        if (it.fatal) {
                            android.util.Log.e("SceneHost", "Fatal scene preparation: ${it.message}")
                            gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryRuntime.record(gg.pixelkingdomwars.nativeclient.telemetry.NativeError.RENDER)
                            onError(requireNotNull(it.message))
                        } else {
                            // A successful preparation notice (message null) follows the renderer's admission install: the host reconciles
                            // its publication on it (N-C5 CONTENT-MOUNT); failures only log as before.
                            if (it.message != null) android.util.Log.w("SceneHost", "Scene preparation: ${it.message}") else onScenePrepared()
                            onPreparationError(it.message)
                        }
                    }) },
                localDiagnostics = object : LocalSceneDiagnostics {
                    override fun lifecycle(stage: LocalLifecycleStage) = localReporter?.lifecycle(stage)
                    override val observeCampFrames: Boolean get() = observerVisible && sceneObserver?.observeCampFrames == true
                    override val observeServiceFrames: Boolean get() = observerVisible && sceneObserver?.observeServiceFrames == true
                    override fun frameStarted() { localReporter?.frameStarted(); observe { it.frameStarted() } }
                    override fun frameCompleted() { localReporter?.frameCompleted(); observe { it.frameCompleted() } }
                    override fun state(snapshot: LocalSceneSnapshot) {
                        localReporter?.state(snapshot); observe { it.state(snapshot) }
                        // BASE/BATTLE is observed at the start of the GL iteration after the prior
                        // scene batch was drawn and swapped, not merely when pixels were prepared.
                        // Publish once per renderer view; later revisions retain their valid scene.
                        if (!readyPosted && snapshot.kind != LocalSceneKind.LOADING) {
                            readyPosted = true
                            dispatchSceneCallback(Unit, postToMain = { deliver -> activity?.runOnUiThread(deliver) },
                                isCurrent = { rendererOwner === currentRendererOwner && localReportLease === localReporter },
                                receive = { hasPresentedScene = true; onSceneReady(true)
                                    SceneLoadLog.mark(LoadEvent.SCENE_READY, "$openedAs sinceCreateMs=${android.os.SystemClock.elapsedRealtime() - createdAtMs}") })
                        }
                    }
                },
                onPerformanceSample = NativeDiagnosticsRuntime::sample, onPerformanceSummary = NativeDiagnosticsRuntime::summary,
                onDisposed = { bundleLease?.close(); downloadedLease?.close() }, onGroundSelected = { x, y -> activity?.runOnUiThread { onGroundSelected(x, y) } },
                onBattleGroundSelected = { mode, x, y, legal ->
                    val epoch = deploymentEpoch
                    dispatchBattlePlacement(CompletedBattlePlacement(mode, x, y, legal),
                        postToMain = { deliver -> activity?.runOnUiThread(deliver) }, currentAdmission = { deploymentAdmission },
                        isCurrent = { rendererOwner === currentRendererOwner && deploymentEpoch === epoch && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) },
                        receive = { placement ->
                            if (!placement.legal) onInvalidDeployment(placement.x, placement.y)
                            else placement.mode.target?.let { onBattlePlacement(it, placement.x, placement.y) }
                                ?: onGroundSelected(placement.x, placement.y)
                        })
                },
                inputDiagnostics = if (BuildConfig.DEBUG) ({ record -> Log.i("PKWInput", record); Unit }) else null,
                onBattleFrame = { frame -> activity?.runOnUiThread { onFrame(frame) } },
                onCommandBodiesSubmitted = { value ->
                    // Stay on GL: no Main dispatch delay, IO or account lookup. The captured
                    // renderer/view owner must still be visible; the sink fences exact plan/epoch.
                    if(rendererOwner === currentRendererOwner && localReportLease === localReporter && observerVisible)
                        runCatching { onCommandBodiesSubmitted?.invoke(value) }
                },
                catalogueTree = { GameContentCache.rendererCatalogue(assets) },
                allowLayeredGroundPreview = BuildConfig.DEBUG && layeredGroundPreview,
                layeredImageDecoder = AndroidLayeredImageDecoder,
                onDiagnostic = { note -> if (BuildConfig.DEBUG) Log.i("PKWVisual", note) },
                audioAdmissionEpoch = { audioBridge?.epoch() ?: -1 },
                onBattleAudioFrame = { frame -> audioBridge?.mailbox?.offer(frame) },
                sensoryAdmissionEpoch = { raid,revision,token->sensoryBridge?.admission(raid,revision,token) ?: -1 },
                onSensoryFrame = { frame->sensoryBridge?.offer(frame) },
                deploymentHandled = { raid,revision,token,cue->sensoryBridge?.deployed(raid,revision,token,cue) ?: true },
                deploymentPreview = { raid,revision,token->sensoryBridge?.deployPreview(raid,revision,token).orEmpty() },
                onWallStroke = { event -> activity?.runOnUiThread { onWallStroke(event) } },
                onCarry = { event -> activity?.runOnUiThread { onCarry(event) } },
                // Stays on GL: a snapshot-state write needs no Main hop, and a hop would trail the drawn frame.
                onBaseCamera = { view -> publishBaseCamera(currentRendererOwner, view) }, serviceAssets = serviceSource)
            invalidateJourneys() // renderer replacement: a lease bound to the previous renderer identity ends
            renderer = game
            if (serviceFleet != null) game.setServiceAssets(serviceSource, serviceFleet) // the constructor carries the source only
            game.setServiceArtEnabled(servicePermission && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
            game.setReducedMotion(reducedMotion)
            game.setDiagnosticsEnabled(diagnosticsEnabled)
            game.setHighlights(highlights)
            game.setWallStrokeMode(wallStrokeMode)
            game.setCarryMode(carryMode)
            game.setDeploymentMode(deploymentMode)
            game.setCameraInsets(cameraInsets)
            game.setInputGeometry(inputGeometry)
            game.setCameraControls(cameraControls)
            if (battle != null) game.updateBattle(battle!!, audioToken) else scene?.let(game::updateBase)
            // GLOBE-NATIVE-PLAN §3.3: base and battle share this GLES 2 fragment; no GL30 handle left by the world surface may reach them.
            if (gg.pixelkingdomwars.nativeclient.scene.world.WorldGdxStatics.clearGl30()) Log.w("SceneHost", "[world-engine] cleared a GL30 handle left by the world surface")
            initializeForView(game, AndroidApplicationConfiguration().apply {
                useAccelerometer = false; useCompass = false; useGyroscope = false; useImmersiveMode = false; numSamples = 0
            }).withoutSceneInputFocus().also { surface ->
                // AndroidView can mount this nested SurfaceView during an existing traversal. SurfaceView
                // creates its holder only after a pre-draw observes its laid-out size; invalidate the
                // window root once after attachment completes rather than drawing on the GL thread.
                surface.doOnAttach { mounted ->
                    mounted.post {
                        if (mounted.isAttachedToWindow && view === mounted) { mounted.rootView.postInvalidateOnAnimation(); surfaceDiagnostic("requested-root-traversal", mounted) }
                    }
                }
                if (BuildConfig.DEBUG) observeSurfaceLifecycle(surface)
                // GL thread, first frame: create() has just built this scene's SpriteBatch, whose VAO path follows Gdx.gl30.
                if (BuildConfig.DEBUG) postRunnable { check(com.badlogic.gdx.Gdx.gl30 == null) { "GL30 handle leaked into a GLES 2 scene" }; Log.i("SceneHost", "[world-engine] GLES 2 scene created with Gdx.gl30 == null") }
            }
        } catch (error: Exception) { bundleLease?.close(); downloadedLease?.close(); throw error }
    }
    override fun onResume() { deploymentEpoch = Any(); surfaceDiagnostic("resume-before", view); super.onResume(); onServiceRefresh(); surfaceDiagnostic("resume-after", view) }
    override fun onPause() = localReportLease.duringLifecycle(LocalLifecycleStage.FRAGMENT_PAUSE) {
        invalidateJourneys()
        renderer?.setServiceArtEnabled(false); serviceSource?.cancelPending()
        deploymentEpoch = Any()
        localReportLease?.visible(false); observerVisible = false; renderer?.setWallStrokeMode(null)
        surfaceDiagnostic("pause-before", view); super.onPause(); surfaceDiagnostic("pause-after", view)
    }
    override fun onDestroyView() { invalidateJourneys(); publishBaseCamera(null, null); rendererOwner = null; hasPresentedScene = false; onSceneReady(false); localReportLease?.visible(false); observerVisible = false; observerOwner = null; wallStrokeMode = null; renderer?.setWallStrokeMode(null); surfaceDiagnostic("destroy-view", view); renderer = null; super.onDestroyView() }

    /** Observe platform delivery only; never advance frames or alter the GL pause handshake. */
    private fun observeSurfaceLifecycle(surface: View) {
        surfaceDiagnostic("initialized", surface)
        (surface as? SurfaceView)?.holder?.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) { surfaceDiagnostic("holder-created", surface) }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) { surfaceDiagnostic("holder-changed", surface) }
            override fun surfaceDestroyed(holder: SurfaceHolder) { surfaceDiagnostic("holder-destroyed", surface) }
        })
        val settled = Runnable { surfaceDiagnostic("attached-500ms", surface) }
        var observer: ViewTreeObserver? = null
        val firstPreDraw = object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                surfaceDiagnostic("first-predraw", surface)
                observer?.takeIf { it.isAlive }?.removeOnPreDrawListener(this); observer = null
                return true
            }
        }
        surface.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(view: View) {
                surfaceDiagnostic("attached", view)
                observer = view.viewTreeObserver.also { it.addOnPreDrawListener(firstPreDraw) }
                view.postDelayed(settled, 500)
            }
            override fun onViewDetachedFromWindow(view: View) {
                view.removeCallbacks(settled)
                observer?.takeIf { it.isAlive }?.removeOnPreDrawListener(firstPreDraw); observer = null
                surfaceDiagnostic("detached", view)
            }
        })
        surface.addOnLayoutChangeListener { view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) surfaceDiagnostic("layout", view)
        }
        // queueEvent can run before an EGL surface exists; this marker distinguishes a live GL thread
        // waiting for a holder from a thread that never processes work.
        (surface as? GLSurfaceView)?.queueEvent { Log.i("PKWSurface", "event=gl-thread-queued fragment=${System.identityHashCode(this)} thread=${Thread.currentThread().name}") }
    }
    private fun surfaceDiagnostic(event: String, surface: View?) {
        if (!BuildConfig.DEBUG) return
        val holder = (surface as? SurfaceView)?.holder
        Log.i("PKWSurface", "event=$event fragment=${System.identityHashCode(this)} view=${surface?.let { System.identityHashCode(it) }} " +
            "attached=${surface?.isAttachedToWindow} shown=${surface?.isShown} windowVisibility=${surface?.windowVisibility} " +
            "size=${surface?.width}x${surface?.height} globallyVisible=${surface?.getGlobalVisibleRect(Rect())} " +
            "surfaceValid=${holder?.surface?.isValid} holderSize=${holder?.surfaceFrame?.width()}x${holder?.surfaceFrame?.height()}")
    }
}

/** N-C5 (R1) pure lease binding, testable without Android: one exact service record, one admitted
 *  content identity, one fragment identity and the host generation captured at bind. [isCurrent] holds
 *  only while the host still holds the SAME record and generation and the bound fragment still passes
 *  the caller's current-predicate; [revoke] ends it for good (no later revival). All reference identity. */
/** The fragment's journey scope: the shown base identity and the Home/battle mode. True when a transition
 *  must invalidate the journey lease synchronously — a different base (including to/from none) or a mode
 *  flip; false for an ordinary same-base Home snapshot refresh or a battle revision replacement. */
internal fun journeyScopeChanged(previousBaseId: String?, previousBattle: Boolean, nextBaseId: String?, nextBattle: Boolean): Boolean =
    previousBaseId != nextBaseId || previousBattle != nextBattle

/** N-C5 CONTENT-MOUNT R1: the host's two refresh requests in one object, so the routing is testable without an Activity.
 *  [serviceRefreshRequests] is the EXISTING signal: every explicit foreground/lifecycle refresh and every scene preparation; the
 *  contract-15 observer used to re-observe permission on each; both contracts now collect only the capability signal.
 *  [capabilityRefreshRequests] carries capability re-observation
 *  only: explicit foreground/lifecycle refreshes and scene transitions that change the base identity or the Home/battle mode
 *  (the same [journeyScopeChanged] rule that revokes the lease). An ordinary SAME-BASE scene preparation never reaches it, so a
 *  bound-17 publication lease is not revoked by the observer's false-first re-observation merely to prepare new geometry/facts.
 *  Nothing suppresses a genuine false, caches a positive, polls, queues or replays: every refresh that IS requested still
 *  publishes false first through the accepted permission observer. */
internal class ServiceRefreshRequests {
    private val service = MutableStateFlow(0L)
    private val capability = MutableStateFlow(0L)
    val serviceRefreshRequests = service.asStateFlow()
    val capabilityRefreshRequests = capability.asStateFlow()
    /** Explicit foreground/lifecycle (fragment resume): service art AND capability. */
    fun requestServiceRefresh() { service.value += 1; capability.value += 1 }
    /** A scene preparation: always the existing service refresh; capability re-observation only when the journey scope changed. */
    fun requestSceneRefresh(previousBaseId: String?, previousBattle: Boolean, nextBaseId: String?, nextBattle: Boolean) {
        service.value += 1
        if (journeyScopeChanged(previousBaseId, previousBattle, nextBaseId, nextBattle)) capability.value += 1
    }
}

/** N-C5 RESIDENCY private host eligibility (pure, testable): with [bound] the exact owner's ENABLED service record,
 *  exactly ONE fragment must be current (resumed Home showing the base, no battle), hold a renderer, and that
 *  renderer must report a PREPARED generation for the base. Returns that exact renderer, else null. Two current
 *  fragments, a missing renderer or an unprepared generation are all ineligible. No production mount follows. */
/** N-C5 CONTENT-MOUNT: the pure, idempotent publication decision. KEEP a CURRENT lease for the unchanged base (warm publication
 *  survives ordinary same-base preparations); REVOKE a current lease whose base changed or vanished (never re-targeted); ATTACH
 *  cold only when no current lease exists, a base is shown and the host is eligible; otherwise NONE. */
internal enum class FleetPublicationDecision { KEEP, ATTACH, REVOKE, NONE }
internal fun fleetPublicationDecision(leaseCurrent: Boolean, leaseBaseId: String?, baseIdNow: String?, eligible: Boolean): FleetPublicationDecision = when {
    baseIdNow == null -> if (leaseCurrent) FleetPublicationDecision.REVOKE else FleetPublicationDecision.NONE
    leaseCurrent && leaseBaseId == baseIdNow -> FleetPublicationDecision.KEEP
    leaseCurrent -> FleetPublicationDecision.REVOKE
    eligible -> FleetPublicationDecision.ATTACH
    else -> FleetPublicationDecision.NONE
}

internal fun fleetJourneyEligibility(bound: Any?, fragments: List<Any>, fragmentCurrent: (Any) -> Boolean, rendererOf: (Any) -> Any?, prepared: (Any) -> Boolean): Any? {
    if (bound == null) return null
    val fragment = fragments.singleOrNull(fragmentCurrent) ?: return null
    val renderer = rendererOf(fragment) ?: return null
    return if (prepared(renderer)) renderer else null
}

internal class FleetJourneyLeaseGuard(private val servicesNow: () -> Any?, private val generationNow: () -> Long,
    private val fragmentCurrent: (Any) -> Boolean, private val rendererNow: (Any) -> Any?, private val fragmentGenerationNow: (Any) -> Long) {
    private var services: Any? = null
    private var content: Any? = null
    private var fragment: Any? = null
    private var renderer: Any? = null
    private var generation = Long.MIN_VALUE
    private var fragmentGeneration = Long.MIN_VALUE
    /** Bind to the exact service record, content, fragment, its renderer and both generations as they are NOW. */
    @Synchronized fun bind(services: Any, content: Any, fragment: Any, renderer: Any, fragmentGeneration: Long) {
        this.services = services; this.content = content; this.fragment = fragment; this.renderer = renderer
        generation = generationNow(); this.fragmentGeneration = fragmentGeneration
    }
    @Synchronized fun revoke() { services = null; content = null; fragment = null; renderer = null; generation = Long.MIN_VALUE; fragmentGeneration = Long.MIN_VALUE }
    /** True only while the host still holds the SAME record and generation, the bound fragment has not
     *  paused/destroyed its view or replaced its renderer since bind (its generation is unchanged and its
     *  renderer is the SAME object), and the fragment still passes the caller's current-predicate. */
    @Synchronized fun isCurrent(): Boolean {
        val f = fragment ?: return false
        return services != null && content != null && servicesNow() === services && generationNow() == generation &&
            fragmentGenerationNow(f) == fragmentGeneration && rendererNow(f) === renderer && renderer != null && fragmentCurrent(f)
    }
    /** The one bound fragment while current, else null. */
    @Synchronized fun target(): Any? = if (isCurrent()) fragment else null
    /** The exact renderer identity bound at attach while current, else null. */
    @Synchronized fun renderer(): Any? = if (isCurrent()) renderer else null
}
