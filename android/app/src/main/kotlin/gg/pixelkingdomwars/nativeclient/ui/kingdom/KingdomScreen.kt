package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.FilterChip
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import gg.pixelkingdomwars.nativeclient.renderer.SceneInputRegion
import gg.pixelkingdomwars.nativeclient.renderer.homeCameraInsets
import gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeCameraChrome
import gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.home.cameraChromeRect
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.zIndex
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.baseJobProgress
import gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentState
import gg.pixelkingdomwars.nativeclient.data.WallBatchState
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.TutorialState
import gg.pixelkingdomwars.nativeclient.network.BaseOrderPrice
import gg.pixelkingdomwars.nativeclient.network.buildCountPresentation
import gg.pixelkingdomwars.nativeclient.network.ordinaryBuildingChoices
import gg.pixelkingdomwars.nativeclient.network.defenceBuildingChoices
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.isTrapType
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.scene.rememberPreparedBaseScene
import gg.pixelkingdomwars.nativeclient.scene.SceneSurface
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorOverlay
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorViewModel
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.CatalogueTimings
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.renderer.RenderBuilding
import gg.pixelkingdomwars.nativeclient.scene.BuildingRooflines
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.command.SelectionOverlay
import gg.pixelkingdomwars.nativeclient.ui.command.SelectionUi
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.NamePlateUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LIVE_BUILDING_SHEETS
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildTrayHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildTrayFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildingSheetFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LivePlacementSheetFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildingInfoHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildingRoutes
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveConstructionWorldLayer
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LivePlacementWorldLayer
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.liveConstructionSites
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readConstructionJobs
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LivePlacementHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LivePlacementRoutes
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayRoutes
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveUpgradeHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.livePlacementUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.liveUpgradeUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readBuildingFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readMineFact
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readPlacementFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readTrayFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.gemSpendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildersHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.consumeBuildersTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveWallRowHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.consumeWallRowTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveObstacleHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.consumeObstacleTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveExpandHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.consumeExpandTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.LiveDailyCacheHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.consumeDailyCacheTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.dailyCacheBlockedReason
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.home.HomeGuideCard
import gg.pixelkingdomwars.nativeclient.ui.home.KingdomStatusToasts
import gg.pixelkingdomwars.nativeclient.ui.home.homeGuide
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.HomeSolPurchase
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LivePaidUpgradeSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveReadyMarkerLayer
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveShardsNeedMoreHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.liveReadyMarkers
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.liveRearmNeedMore
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.liveUpgradeSheetUi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*

/** Realm-aware rendering is a later block; until then every scene reports its visualContext here. */
internal val visualLog: (String) -> Unit = { if (gg.pixelkingdomwars.nativeclient.BuildConfig.DEBUG) android.util.Log.i("PKWVisual", it) }

internal fun BaseOrderPrice.description() = "${fmtN(amount)} $currency" + (seconds?.toLongOrNull()?.takeIf { it > 0 }?.let { " · ${fmtDur(it)}" } ?: "")

/** Home/Kingdom: the libGDX base, HUD values from the server snapshot, build/collect/placement, the
 * per-building sheet, obstacles, the wall row purchase, the daily cache and the layout editor. Every
 * price shown is a catalogue lookup or the server's quote; the server re-prices every order. */
@Composable internal fun KingdomScreen(model: KingdomViewModel, layout: LayoutEditorViewModel, landOwned: Boolean, requests: HomeRequests, onOpenQuests: () -> Unit, onOpenArmy: () -> Unit, onOpenAttack: () -> Unit, onOpenLand: () -> Unit,
    onOpenResearch: () -> Unit, onOpenForge: () -> Unit,
    onOpenHeroes: () -> Unit = {},
    supplies: (@Composable (List<gg.pixelkingdomwars.nativeclient.ui.model.TabUi>, (String) -> Unit, () -> Unit, () -> Unit, Modifier) -> Unit)? = null,
    onBasePurchase: (String, String, String?) -> Unit = { _, _, _ -> }, chatLayer: @Composable BoxScope.() -> Unit = {}, walletSol: String? = null,
    /** MS-C3 mount contract §1 (KingdomMountHooks.kt): the OR of this screen's private reviews; true at mount, before a
     *  private confirmation opens, on pause, disposal and replacement. Each callback identity is one registration. */
    onReviewBlockedChanged: (Boolean) -> Unit = {},
    /** MS-C3 §1: asked FIRST on a resolved footprint / ground tap (never on a pointer-down); true = the owner consumed
     *  the tap, and the scene, selection, primary command and layout stay untouched. */
    onBeforeSceneTap: () -> Boolean = { false },
    /** Navigation only; the reviewed finish is dismissed before the existing Gems purchase entry opens. */
    onGetGems: ((String) -> Unit)? = null,
    /** Extra dock tiles after FIT (home/HomeScaffold.kt ChatDockControl). */
    dock: @Composable RowScope.() -> Unit = {},
    /** The Home side of SOL base purchases (HIRE BUILDER, Keep EXPAND, a SOL-step upgrade): the EXISTING purchase owner and
     *  wallet sender, raised in place on the designed sheets. Null keeps the old purchase screen ([onBasePurchase]). */
    solPurchase: HomeSolPurchase? = null,
    /** Keep STORES (buildings/keep-stores.png): the caller's tall sheet over the inventory owners. Null: STORES says why. */
    keepStores: (@Composable (onClose: () -> Unit, onGo: (FeatureId) -> Unit, modifier: Modifier) -> Unit)? = null,
    /** The bar facts that live outside this screen's state (research, gear NEW, Workshop jobs), read at the display clock
     *  so their timers tick with the bar. */
    barExtras: (now: Long) -> BuildingBarExtras = { BuildingBarExtras() },
    /** The Clan Hall's CLAN door. */
    onOpenClan: () -> Unit = { Toasts.post("The Clan Hall is not open here yet.") },
    /** GEAR (Hero Altar / Siege Stool) and a Keep STORES gear GO: the Heroes sheet unless the caller has a gear tab. */
    onOpenHeroGear: () -> Unit = onOpenHeroes,
    /** Keep STORES is drawn (a TALL sheet from y 104): the HUD then trims to its BUILD form, as for the BUILD tray. */
    onKeepStoresShown: (Boolean) -> Unit = {}) {
    val state by model.state.collectAsState()
    BuilderFinishLifecycle(model, state)
    val editor by layout.state.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val now = displayClock()
    val viewport = LocalConfiguration.current
    val landscape = viewport.screenWidthDp > viewport.screenHeightDp * 1.1 && viewport.screenHeightDp < 500
    val base = state.base
    val heroState = model.heroRecruitment?.state?.collectAsState()?.value ?: HeroRecruitmentState()
    val wallState = model.wallBatch?.state?.collectAsState()?.value ?: WallBatchState()
    val editing = editor.open
    val assets = state.assets; val catalogue = state.catalogue; val render = state.renderCatalogue
    // Cold-start measurement 2026-10-06 (live at 9.6 s): until the server's /base answer arrives, the scene maps from the
    // last answer this device kept for this account and selected base (LastBasePayload) — its geometry only, never its
    // service facts, and no tap acts on it. The server's answer then replaces it in place (same identity, same surface).
    val sceneAccount = remember(state.wallet) { state.wallet?.let(gg.pixelkingdomwars.nativeclient.scene.ScenePostcards::accountKey) }
    val heldBase = if (base == null && !editing) gg.pixelkingdomwars.nativeclient.scene.LastBasePayload.held.value else null
    val cachedMiss = if (base == null && !editing) gg.pixelkingdomwars.nativeclient.scene.cachedBaseMiss(heldBase, sceneAccount,
        state.selectedBaseId, System.currentTimeMillis()) else "server"
    val cachedRaw = if (cachedMiss == null) heldBase?.raw else null
    val raw = if (editing) editor.draftBase else base?.raw ?: cachedRaw
    val fromCache = raw != null && raw === cachedRaw
    // The renderer and INFO share one current prepared scene, including its stale-service-facts guard.
    val preparedScene = (if (raw != null && assets != null && catalogue != null && render != null)
        rememberPreparedBaseScene(model to raw.string("baseId"), raw, catalogue, render, visualLog, model.preparedScenes) else null)
        ?.let { prepared -> if (fromCache) remember(prepared) { prepared.withoutServices() } else prepared }
    LaunchedEffect(Unit) { gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.stage(
        gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent.BOOT_HOME, note = "cache=${cachedMiss ?: "hit"}") }
    // Every server answer Home holds becomes the next launch's starting point (identity-checked; disk writes throttled).
    SideEffect { val served = base?.raw; if (sceneAccount != null && served != null) gg.pixelkingdomwars.nativeclient.scene.LastBasePayload.offer(sceneAccount, served) }
    // Web `haptic('light')` on arm and on a landed drop; the device gates (settings/background) apply inside.
    val haptic = gg.pixelkingdomwars.nativeclient.ui.LocalGameHaptic.current
    val audioBus = gg.pixelkingdomwars.nativeclient.ui.LocalNativeAudio.current
    val sound = remember(audioBus, model, base?.baseId) {
        base?.baseId?.let { id -> audioBus?.ui?.scope(id, model.audioIdentity) { model.state.value.base?.baseId } }
    }
    val audioLifecycle = LocalLifecycleOwner.current.lifecycle
    val latestEditing = rememberUpdatedState(editing)
    DisposableEffect(model, sound, audioLifecycle) {
        model.audio = sound
        val observer = androidx.lifecycle.LifecycleEventObserver { _, _ ->
            sound?.active(audioLifecycle.currentState == Lifecycle.State.RESUMED && !latestEditing.value)
        }
        audioLifecycle.addObserver(observer)
        sound?.active(audioLifecycle.currentState == Lifecycle.State.RESUMED && !editing)
        onDispose {
            audioLifecycle.removeObserver(observer); sound?.close()
            if (model.audio === sound) model.audio = null
        }
    }
    SideEffect { sound?.active(audioLifecycle.currentState == Lifecycle.State.RESUMED && !editing) }
    var requestedBuildTab by rememberSaveable(base?.baseId) { mutableStateOf(gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.BUILDINGS) }
    val request by requests.pending.collectAsState()
    LaunchedEffect(request, base) {
        when (val r = request) {
            HomeRequest.BuildMenu -> if (base != null) { requestedBuildTab = gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.BUILDINGS; model.openBuildMenu(); requests.consume(r) }
            is HomeRequest.BuildCategory -> if (base != null) {
                requestedBuildTab = r.tab.takeIf { it == gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.DEFENCES ||
                    it == gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.TRAPS }
                    ?: gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.BUILDINGS
                model.openBuildMenu(); requests.consume(r)
            }
            HomeRequest.HeroBuildMenu -> if (base != null) { model.openBuildMenu(true); requests.consume(r) }
            is HomeRequest.FocusBuilding -> if (base != null) { model.selectBuilding(r.buildingId); requests.consume(r) }
            else -> {}
        }
    }
    // Web `useBaseAutoRefetch` + the map cadence: while Home is resumed, re-read the kingdom every
    // `WORLD.mapPollSec` and once more at the soonest job/training deadline, so completions and the next
    // objective arrive without a tap. The player's local selection is never touched by a tick.
    // A pack without `WORLD.mapPollSec` has no cadence (nothing is invented): server deadlines still wake a tick.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) { model.dismissHeroReview(); model.dismissWallDrawing() } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismissHeroReview(); model.dismissWallDrawing() }
    }
    DisposableEffect(layout, lifecycle, editing) {
        fun publishEditorInput() {
            if (editing && lifecycle.currentState == Lifecycle.State.RESUMED) layout.resumeWallInput()
            else layout.pauseWallInput()
        }
        val observer = androidx.lifecycle.LifecycleEventObserver { _, _ -> publishEditorInput() }
        lifecycle.addObserver(observer); publishEditorInput()
        onDispose { lifecycle.removeObserver(observer); layout.pauseWallInput() }
    }
    LaunchedEffect(base?.baseId) { model.dismissHeroReview(); model.dismissWallDrawing() }
    LaunchedEffect(base, editing, state.ordersAllowed, state.deedActionsAllowed) {
        if (!homeWallDrawingAllowed(state, editing)) model.dismissWallDrawing()
        else model.checkWallDrawingGeometry()
    }
    LaunchedEffect(model, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.busy.first { !it }; model.refreshConstructionReceipts()?.join()
        }
    }
    LaunchedEffect(state.local.buildMenu, state.local.heroesOnly, lifecycle) {
        if (state.local.buildMenu && state.local.heroesOnly) lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.busy.first { !it }; model.refreshHeroRecruitment()?.join()
        }
    }
    val cadenceMs = remember(state.catalogue) { CatalogueTimings.homeRefreshMs(state.catalogue) }
    val timingNotice = remember(state.catalogue) { CatalogueTimings.compatibilityNotice(state.catalogue) }
    val nextDeadline = homeRefreshDeadline(base)
    LaunchedEffect(lifecycle, cadenceMs, nextDeadline) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                val untilDeadline = nextDeadline?.let { it - System.currentTimeMillis() + 500 }
                val wait = when {
                    untilDeadline != null && cadenceMs != null -> untilDeadline.coerceIn(500, cadenceMs)
                    untilDeadline != null -> maxOf(500, untilDeadline)
                    else -> cadenceMs ?: return@repeatOnLifecycle
                }
                delay(wait); model.tick()
            }
        }
    }
    val local = state.local
    var buildersOpen by remember(base?.baseId) { mutableStateOf(false) }
    // Placement no longer hides Builders: the band's NO_BUILDER PLACE is the door to it (SPEC §4.3), so it opens over the band.
    val buildersVisible = buildersOpen && !editing && !local.buildMenu
    val dailyCacheVisible = local.sheet == KingdomSheet.DAILY_CACHE && !editing && !local.buildMenu && local.placement == null
    val selectedObstacleJob = state.selectedObstacle?.let { obstacle -> base?.jobs?.firstOrNull { it.obstacleId == obstacle.id } }
    val obstacleQuoteOpen = !editing && state.selectedObstacle != null && selectedObstacleJob == null
    val runningObstacleOpen = state.selectedObstacle != null && selectedObstacleJob != null
    // Presentation only, like LiveUpgradeHost: polling is not a clear submission. Keyed to this obstacle.
    var obstacleSent by remember(base?.baseId, local.selectedObstacleId) { mutableStateOf(false) }
    LaunchedEffect(busy) { if (!busy) obstacleSent = false }
    BackHandlerAt(BackPriority.SHEET, enabled = buildersVisible) { buildersOpen = false }
    // Opening the BUILD tray drops a Builders sheet left open, so it cannot pop over the placement a card then starts.
    LaunchedEffect(local.buildMenu) { if (local.buildMenu) buildersOpen = false }
    var cameraFitKey by remember(base?.baseId) { mutableIntStateOf(0) }
    // BUILD refused by a saved construction (HomeRequest.ShowRecovery): each bump unfolds the interrupted herald.
    var recoveryReveal by remember(base?.baseId) { mutableIntStateOf(0) }
    // The HUD's builders segment and deck tools (they replaced the BUILDERS button and the LAYOUT · EXPAND · FIT dock
    // row): the same callbacks and the same enabled rules those buttons had. A refused tool is still consumed, so it
    // can never block the queue behind it; the HUD drew it disabled already.
    LaunchedEffect(request, base) {
        when (val r = request) {
            HomeRequest.Builders -> if (base != null) { buildersOpen = true; requests.consume(r) }
            // Owner 2026-10-06: the recovery column steps aside for a selection or a draft, so BUILD's refusal clears them
            // (as an opened BUILD tray would) and unfolds the herald. Always consumed: presentation only, never a held head.
            HomeRequest.ShowRecovery -> {
                val shown = model.state.value
                if (shown.placement != null) model.cancelPlacement()
                if (shown.selectedBuildingId != null) model.clearSelection()
                recoveryReveal++; requests.consume(r)
            }
            is HomeRequest.BaseTool -> {
                if (base != null) when (r.tool) {
                    gg.pixelkingdomwars.nativeclient.ui.home.HomeBaseTool.LAYOUT ->
                        if (state.deedActionsAllowed && !model.busy.value) { model.closeSurfaces(); layout.open() }
                    gg.pixelkingdomwars.nativeclient.ui.home.HomeBaseTool.EXPAND -> if (state.deedActionsAllowed) model.openExpand()
                    gg.pixelkingdomwars.nativeclient.ui.home.HomeBaseTool.FIT -> cameraFitKey++
                }
                requests.consume(r)
            }
            else -> {}
        }
    }
    var editorInsets by remember(base?.baseId) { mutableStateOf(gg.pixelkingdomwars.nativeclient.renderer.CameraInsets()) }
    var statusChrome by remember(base?.baseId) { mutableStateOf<SceneInputRegion?>(null) }
    var bottomChrome by remember(base?.baseId) { mutableStateOf<SceneInputRegion?>(null) }
    var surfaceChrome by remember { mutableStateOf<SceneInputRegion?>(null) }
    // Army chips ride the drawn Home camera (written on the GL thread); only the drawn base's identity is read here,
    // so a pan never recomposes this screen.
    val baseCamera = remember { mutableStateOf<gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView?>(null) }
    // Spec §2: the new renderer has drawn its first complete frame (SceneSurface onPresentationReady), and its opening retry.
    var sceneLive by remember { mutableStateOf(false) }
    var openingFailed by remember { mutableStateOf(false) }
    var openingRetry by remember { mutableStateOf<(() -> Unit)?>(null) }
    // A fatal renderer error has no preparation retry: TRY AGAIN mounts a fresh surface (what "return and try again" did).
    var surfaceGeneration by remember { mutableIntStateOf(0) }
    val drawnBase by remember { derivedStateOf { baseCamera.value?.let { it.baseId.orEmpty() } } }
    val chipHits = remember { ArmyChipHits() }
    val chipTap = remember(base?.baseId) { ArmyChipTapClaim() }
    var carrying by remember(base?.baseId) { mutableStateOf(false) }
    val parentChrome = LocalHomeCameraChrome.current
    val parentPadding = gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeScenePadding.current
    val primaryWidth = gg.pixelkingdomwars.nativeclient.ui.home.LocalHomePrimaryWidth.current
    val sceneDensity = LocalDensity.current
    val direction = androidx.compose.ui.platform.LocalLayoutDirection.current
    val parentInsets = with(sceneDensity) { gg.pixelkingdomwars.nativeclient.renderer.CameraInsets(
        parentPadding.calculateLeftPadding(direction).roundToPx(), parentPadding.calculateTopPadding().roundToPx(),
        parentPadding.calculateRightPadding(direction).roundToPx(), parentPadding.calculateBottomPadding().roundToPx()) }
    val childInsets = if (editing) editorInsets else gg.pixelkingdomwars.nativeclient.renderer.CameraInsets()
    val measuredInsets = parentInsets + childInsets
    var confirmation by remember { mutableStateOf<SheetConfirmation?>(null) }
    // MS-C3 §1: one review-blocked lease per callback registration (and lifecycle). Blocked at mount, on pause and on
    // disposal (THIS registration's callback, never a newer one); resume recomputes; the aggregate is published below.
    val reviewLease = remember(onReviewBlockedChanged, lifecycle) { ReviewBlockedLease(onReviewBlockedChanged) }
    DisposableEffect(reviewLease) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) reviewLease.pause() else if (event == Lifecycle.Event.ON_RESUME) reviewLease.resume()
        }
        reviewLease.mount()
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); reviewLease.retire() }
    }
    // UX-ARCHITECTURE §3: a selection shows the name plate + command bar; the BuildingSheet opens only from INFO (its
    // info form) or UPGRADE / REARM (its full form, the review). UI-local; a new selection starts with no sheet.
    var buildingSheet by remember(local.selectedBuildingId) { mutableStateOf<BuildingSheetMode?>(null) }
    // The designed surfaces the bar opens in place (2026-10-06 mount): Keep STORES, the bar's Need-more for a short REARM
    // (the trap's id) and the SOL step of an upgrade. Each belongs to this selection; a new selection closes it.
    var storesOpen by remember(local.selectedBuildingId) { mutableStateOf(false) }
    var barNeedMore by remember(local.selectedBuildingId) { mutableStateOf<String?>(null) }
    var paidUpgradeOpen by remember(local.selectedBuildingId) { mutableStateOf(false) }
    // The in-place order this bar last sent (COLLECT or REARM): only that command shows busy dots, until the model is idle.
    var barSent by remember(local.selectedBuildingId) { mutableStateOf<FeatureId?>(null) }
    LaunchedEffect(busy) { if (!busy) barSent = null }
    val barNeedMoreUi = barNeedMore?.let { id -> base?.buildings?.firstOrNull { it.id == id } }
        ?.let { trap -> readBuildingFacts(state, trap, busy, now) }?.let(::liveRearmNeedMore)
    // No longer short (Shards arrived) or the trap is gone: the Need-more closes rather than reappearing later by itself.
    LaunchedEffect(barNeedMore, barNeedMoreUi == null) { if (barNeedMoreUi == null) barNeedMore = null }
    val sheetOpen = state.selectedBuilding != null && buildingSheet != null
    val barBuilding = state.selectedBuilding?.takeIf { !editing && local.placement == null && !local.buildMenu && buildingSheet == null &&
        !storesOpen && !paidUpgradeOpen && barNeedMoreUi == null }
    val barGates = barBuilding?.let { buildingGates(state, it, busy) }
    val homeRouteDispatcher = LocalHomeRouteDispatcher.current
    val phaseECommands = remember(homeRouteDispatcher) { homeRouteDispatcher?.let(::phaseEBuildingCommands) }
    val barSelection = barBuilding?.let { phaseEBuildingSelection(base?.baseId, it) }
    // Voyage SPEC §1 / §10: the Lodge and Berth selections add their trip line, badges, COLLECT swap and FLEET primary.
    val voyageSelection = gg.pixelkingdomwars.nativeclient.ui.home.rememberVoyageSelection(base?.buildings, base?.baseId)
    val voyageReturn = gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeVoyageReturnAction.current
    // The designed bar (extras, sent) is built first; the voyage wrappers then decorate the Lodge / Berth result.
    val extras = if (barBuilding != null) barExtras(now) else BuildingBarExtras()
    val currentBar = barBuilding?.let { b -> barGates?.let { buildingCommandBar(state, b, it, busy, now, phaseECommands, extras = extras, sent = barSent) }
        ?.let { bar -> gg.pixelkingdomwars.nativeclient.ui.home.voyageCommandBar(bar, b, voyageSelection) } }
    val currentPlate = barBuilding?.let { b -> barGates?.let { buildingNamePlate(b, it, now, state, extras) }
        ?.let { plate -> gg.pixelkingdomwars.nativeclient.ui.home.voyageNamePlate(plate, b, voyageSelection) } }
    // SPEC §1.2 item 6: "Tap the <name> again to open it" for the first three selections per install (SelectionHint.kt).
    val selectionHint = rememberSelectionHint(local.selectedBuildingId, selectionHintLine(currentPlate?.name, currentBar))
    // Live BUILDINGS sheets (HOOKUP-buildings-live.md). Each falls back to the current composable when its mapper declines.
    val buildingCosts = model.buildingCosts(state) // One fresh owner observation per composition; never remembered.
    val liveFacts = state.selectedBuilding?.takeIf { LIVE_BUILDING_SHEETS && !editing && buildingSheet != null }
        ?.let { readBuildingFacts(state, it, busy, now, preparedScene?.scene) }?.let { LiveBuildingSheetFacts(it, buildingCosts) }
    val liveInfo = liveFacts?.takeIf { buildingSheet == BuildingSheetMode.INFO }
    // The designed UPGRADE sheet takes the Shards review and the SOL step; only KEEP / item priced upgrades keep the old sheet.
    val liveUpgrade = liveFacts?.takeIf { buildingSheet == BuildingSheetMode.FULL && liveUpgradeSheetUi(it) != null }
    // The current BuildingSheet is open (it shows the error and owns the bottom column) only when no live host replaced it.
    val legacySheetOpen = sheetOpen && liveInfo == null && liveUpgrade == null
    // HEROES is the tray's own tab now (the old HeroBuildMenu is off the path): a hero request opens the tray on it.
    val liveTray = if (!editing && local.buildMenu)
        LiveBuildTrayFacts(readTrayFacts(state, busy), buildingCosts) else null
    val livePlacement = if (LIVE_BUILDING_SHEETS && !editing && !heroReviewHeld(heroState))
        readPlacementFacts(state, busy, now, heroOffer = heroState.offers.any { it.definition.type == local.placement?.type }, heroes = heroState)
            ?.let { LivePlacementSheetFacts(it, buildingCosts) }?.takeIf { livePlacementUi(it) != null } else null
    // MS-C3 §1: the aggregate of the state this screen already holds, published after every committed composition (a
    // SideEffect runs synchronously at apply, so a review that just drew is never reported a frame late).
    val reviewBlocked = kingdomReviewBlocked(state, confirmation != null, heroReviewHeld(heroState), livePlacement != null,
        solConsent = paidUpgradeOpen || solPurchase?.consentOpen == true)
    SideEffect { reviewLease.publish(reviewBlocked) }
    // A live review closes once its order has landed (the bar then shows FINISH) instead of falling back to the old sheet.
    // FULL is only ever opened with no job running (the bar hides UPGRADE / REARM while one runs), so a job here is ours.
    val selectedJobId = state.selectedBuilding?.let { b -> base?.jobs?.firstOrNull { it.buildingId == b.id }?.id }
    LaunchedEffect(selectedJobId) { if (LIVE_BUILDING_SHEETS && selectedJobId != null && buildingSheet == BuildingSheetMode.FULL) buildingSheet = null }
    val liveRoutes = LiveBuildingRoutes(
        onClose = { buildingSheet = null },
        onReview = { buildingSheet = BuildingSheetMode.FULL },
        onUpgrade = { state.selectedBuilding?.let { model.upgrade(it.id) } },
        onFinish = { base?.jobs?.firstOrNull { it.buildingId == local.selectedBuildingId }?.let { model.finishBuilderJob(it) } },
        // BuildingSheet's RunningJobCard cancel, verbatim: the same confirmation, the same refund, the same cancelJob.
        onCancelJob = {
            val b = state.selectedBuilding
            val job = b?.let { sb -> base?.jobs?.firstOrNull { it.buildingId == sb.id } }
            val refund = job?.takeIf { it.canCancel }?.refundShards
            if (b != null && job != null && refund != null) {
                reviewLease.opening()
                confirmation = SheetConfirmation.CancelJob("${trayLabel(b.type)} LEVEL ${b.level}→${b.level + 1}", refund) { model.cancelJob(job.id) }
            }
        },
        onToggleRow = model::toggleWallRow,
        onBuilders = { buildersOpen = true },
        onGoToMine = { model.selectBuilding(it) },
        onOpenBuild = { model.openBuildMenu() },
        // The SOL step's consent is the designed Seal in place (LivePaidUpgradeSeal), no longer the old purchase screen.
        onPaidUpgrade = { buildingSheet = null; buildersOpen = false; paidUpgradeOpen = true },
        onHeroes = { buildingSheet = null; onOpenHeroes() },
        onRearm = { state.selectedBuilding?.let { buildingSheet = null; barSent = BuildingCommandIds.REARM; model.repairTrap(it.id) } },
        onExpand = { buildingSheet = null; buildersOpen = false; model.clearSelection(); model.openExpand() },
    )
    val trayRoutes = LiveTrayRoutes(
        onPick = { type -> model.audio?.tap(); model.startPlacement(type) },
        onHeroes = { model.openBuildMenu(true) },
        onLayouts = { model.closeSurfaces(); layout.open() },
        onClose = { model.audio?.tap(); model.closeBuildMenu() },
        // Builders never shows behind the tray, so its door leaves the tray first (it used to open nothing until closed).
        onBuilders = { model.closeBuildMenu(); buildersOpen = true },
        onGoToMine = { model.closeBuildMenu(); model.selectBuilding(it) },
        onGoToBuilding = { card ->
            // Navigation must not act on a retained card after its owner, base or recovery state changed.
            if (!model.busy.value && buildingCosts.matchesRendered(state) && buildingCosts.reviewCurrent()) {
                gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(card.reason ?: "Not available right now")
                LiveTrayRoutes.goTarget(card, base?.buildings.orEmpty())?.let { id ->
                    model.audio?.tap()
                    model.closeBuildMenu()
                    model.selectBuilding(id)
                }
            }
        },
        // The tray's own HEROES tab: a pick starts placing the altar; the band's PLACE then opens the recruitment review.
        onHeroPick = { type -> model.audio?.tap(); model.startPlacement(type) },
    )
    val placementRoutes = LivePlacementRoutes(
        onPlace = model::confirmPlacement, onCancel = model::cancelPlacement, onBuilders = { buildersOpen = true },
        onGoToMine = { model.cancelPlacement(); model.selectBuilding(it) }, onOpenBuild = { model.openBuildMenu() },
        // A hero offer's PLACE opens HeroAltarConfirm (the recruitment consent), never an ordinary build order.
        onReviewHero = { model.reviewHeroPlacement() },
    )
    // With the dock row folded into the HUD deck nothing reports bottom chrome at rest (the deck is the parent's
    // padding), so a closed sheet must not leave its old rect in the camera fit.
    val bottomReported = local.placement != null && livePlacement == null || legacySheetOpen || obstacleQuoteOpen || runningObstacleOpen ||
        liveInfo != null || liveUpgrade != null
    LaunchedEffect(bottomReported) { if (!bottomReported) bottomChrome = null }
    // TODO(MS-C2): the registry dispatcher replaces these; each is the callback the BuildingSheet used for the same action.
    val commandRoutes = BuildingCommandRoutes(
        info = { buildingSheet = BuildingSheetMode.INFO }, review = { buildingSheet = BuildingSheetMode.FULL },
        finish = { base?.jobs?.firstOrNull { it.buildingId == local.selectedBuildingId }?.let { model.finishBuilderJob(it) } },
        collect = { barSent = BuildingCommandIds.COLLECT; model.collectMine() }, train = { requests.request(HomeRequest.Training) }, research = onOpenResearch,
        army = onOpenArmy, forge = onOpenForge, heroes = onOpenHeroes, toggleRow = model::toggleWallRow, quoteRow = model::quoteWallRow,
        explain = { Toasts.post(it) },
        // The selection stays (the deck stays hidden and Back or the scrim returns to the Keep's bar); STORES hides the bar.
        stores = { if (keepStores != null) { storesOpen = true } else Toasts.post("Keep stores are not open here yet.") },
        expand = { if (state.deedActionsAllowed) { buildersOpen = false; model.clearSelection(); model.openExpand() } else Toasts.post("Orders are paused here") },
        gear = onOpenHeroGear, heroUpgrade = onOpenHeroes,
        rearm = { state.selectedBuilding?.let { barSent = BuildingCommandIds.REARM; model.repairTrap(it.id) } },
        // Short of Shards: the designed Need-more over the Kingdom; the INFO sheet (it has the same Need-more) if it cannot be read.
        rearmShort = { state.selectedBuilding?.let { trap ->
            if (readBuildingFacts(state, trap, busy, now)?.let(::liveRearmNeedMore) != null) { barNeedMore = trap.id }
            else { buildingSheet = BuildingSheetMode.INFO }
        } },
        clan = onOpenClan)
    // Keep STORES GO: the hero's gear, the Barracks composer, the tray's HEROES tab, or a Phase E building's registry door.
    val storesGo: (FeatureId) -> Unit = { id ->
        storesOpen = false
        when (storesGoTarget(id)) {
            StoresGoTarget.HERO_GEAR -> onOpenHeroGear()
            StoresGoTarget.TRAIN -> requests.request(HomeRequest.Training)
            StoresGoTarget.HERO_BUILD -> requests.request(HomeRequest.HeroBuildMenu)
            StoresGoTarget.REGISTRY -> if (homeRouteDispatcher?.handleFeatureDoor(id) != true) Toasts.post(STORES_DOOR_CLOSED)
        }
    }
    // The one surface that drives the SOL purchase owner now (KingdomMountHooks.kt homeSolSurface).
    val solSurface = homeSolSurface(paidUpgradeOpen && !editing, local.sheet == KingdomSheet.EXPAND, buildersVisible)
    // Voyage SPEC §1: the swapped COLLECT (bar tap or the second tap on the Lodge) collects in place without opening the sheet.
    val onCommand: (FeatureId) -> Unit = { id ->
        if (voyageReturn != null && gg.pixelkingdomwars.nativeclient.ui.home.voyageCommandCollects(id, currentBar)) voyageReturn.collect()
        else routeBuildingCommand(id, currentBar, commandRoutes, phaseECommands, barSelection)
    }
    val latestBar by rememberUpdatedState(currentBar)
    val latestOnCommand by rememberUpdatedState(onCommand)
    // Keep STORES (behind its own scrim), the bar's Need-more and the SOL-step sheet close on a scene tap like Builders;
    // while the SOL Seal, wallet or MFA step is up the tap is only consumed, so a payment in flight is never dismissed.
    val homeExtrasOpen = storesOpen || barNeedMoreUi != null || paidUpgradeOpen
    val latestBeforeSceneTap by rememberUpdatedState({ consumeBuildersTap(homeExtrasOpen, { consumeBuildersTap(buildersVisible, { consumeWallRowTap(local.wallRowQuote != null, busy, { consumeObstacleTap(obstacleQuoteOpen, busy && obstacleSent, { consumeExpandTap(local.sheet == KingdomSheet.EXPAND, { consumeDailyCacheTap(dailyCacheVisible, onBeforeSceneTap, model::closeSheet) }, model::closeSheet) }, model::clearSelection) }, model::dismissWallRowQuote) }) { buildersOpen = false } }) {
        storesOpen = false; barNeedMore = null; if (solPurchase?.consentOpen != true) paidUpgradeOpen = false
    } })
    var selectedAtMs by remember { mutableLongStateOf(0L) }
    // Sheets and dialogs own Back at 220 (web `Sheet` useMobileBackHandler); the layout editor registers its own at 160.
    BackHandlerAt(BackPriority.SHEET, enabled = !editing && (confirmation != null || local.wallRowQuote != null || local.sheet != null || local.placement != null || local.selectedBuildingId != null || local.selectedObstacleId != null || local.selectedJobId != null || local.buildMenu)) {
        when {
            heroState.review != null -> model.dismissHeroReview()
            confirmation != null -> confirmation = null
            local.wallRowQuote != null -> if (!busy) model.dismissWallRowQuote()
            local.sheet != null -> model.closeSheet()
            local.placement != null -> model.cancelPlacement()
            local.buildMenu -> model.closeBuildMenu()
            buildingSheet != null -> buildingSheet = null
            else -> model.clearSelection()
        }
    }
    // home-budget.png: routine notices, read errors and messages are kit toasts now, posted once (KingdomStatusRouting.kt);
    // an error stays with a sheet that prints it. Composed once here, not in statusContent (the editor also draws that).
    KingdomStatusToasts(notice, state.home.error, state.home.message, state.updateNotice, timingNotice,
        sheetShowsErrors = legacySheetOpen || local.wallRowQuote != null || buildersVisible || state.selectedObstacle != null,
        onDismissNotice = model::dismissNotice, onClearNotice = model::clearNotice, onDismissUpdateNotice = model::dismissUpdateNotice)
    val statusContent: @Composable () -> Unit = {
        // Only what needs the player's hand stays in the column: the content APPLY and saved payments / receipts.
        if (state.contentUpdate != null) ContentApplyButton(busy) { model.applyContentUpdate { true } }
        InterruptedBanner(state.interrupted.filter { it.intent.wallet == state.wallet && (it.kind == IntentKind.WALL_ROW ||
            it.kind == IntentKind.CONSTRUCTION && !gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec.modernBuilder(it.intent)) }, busy,
            model.interrupted.check, model.interrupted.close, model.interrupted.retry, reveal = recoveryReveal)
        BuilderFinishPending(state, busy, model)
        HeroRecruitmentHistory(heroState, busy || heroState.busy, { model.refreshHeroRecruitment() }, { model.retryHeroRecruitment() },
            onClose = { model.closeHeroRecruitment() })
        WallBatchHistory(wallState, busy || wallState.busy, { model.refreshWallBatch() }, { model.retryWallBatch() }, model::dismissWallReceipt,
            onCloseSaved = { model.closeWallBatch() })
    }
    BoxWithConstraints(Modifier.fillMaxSize().onGloballyPositioned { surfaceChrome = it.boundsInWindow().cameraChromeRect() }) {
        val safeDrawing = WindowInsets.safeDrawing
        val safeInsets = with(sceneDensity) { gg.pixelkingdomwars.nativeclient.renderer.CameraInsets(
            safeDrawing.getLeft(this, direction), safeDrawing.getTop(this),
            safeDrawing.getRight(this, direction), safeDrawing.getBottom(this)) }
        fun localRect(rect: SceneInputRegion?): SceneInputRegion? = rect?.let {
            val origin = surfaceChrome ?: return@let null
            SceneInputRegion(it.left-origin.left,it.top-origin.top,it.right-origin.left,it.bottom-origin.top)
        }
        val cameraInsets = if (editing) measuredInsets else homeCameraInsets(
            with(sceneDensity) { maxWidth.roundToPx() }, with(sceneDensity) { maxHeight.roundToPx() }, safeInsets,
            listOfNotNull(localRect(parentChrome.header),localRect(statusChrome)),
            listOfNotNull(localRect(parentChrome.primary),localRect(bottomChrome)))
        val chromeLimit = (this.maxHeight - parentPadding.calculateTopPadding() - parentPadding.calculateBottomPadding()).coerceAtLeast(0.dp) / 2
        val sheetLimit = (this.maxHeight * .6f).coerceAtLeast(48.dp)
        // Scene-transitions spec §2 (owner 2026-10-06, "black screen is low quality … professional solution"): one cover over a
        // Home that is not live yet — this base's postcard, else the realm wallpaper — never the dark shell or a centred plate.
        val sceneHost = gg.pixelkingdomwars.nativeclient.scene.LocalSceneHost.current
        val postcardAccount = remember(state.wallet) { state.wallet?.let(gg.pixelkingdomwars.nativeclient.scene.ScenePostcards::accountKey) }
        val heldPostcard = gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.slot.shown
        val postcardMiss = heldPostcard?.let { card -> gg.pixelkingdomwars.nativeclient.scene.postcardMiss(card.key, card.savedAtMs, postcardAccount,
            assets?.let { sceneHost?.tagFor(it) }, base?.baseId ?: state.selectedBaseId, constraints.maxWidth, constraints.maxHeight, System.currentTimeMillis()) }
        val shownPostcard = heldPostcard?.takeIf { postcardMiss == null }
        // Field report 2026-10-06: say once why a held postcard did not stand for this scene (size = another orientation, …).
        LaunchedEffect(heldPostcard?.key, postcardMiss) { postcardMiss?.let { gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog.mark(gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent.FRAME_CAPTURE, "miss reason=$it") } }
        val live = sceneLive && preparedScene?.scene != null
        val picture = scenePicture(live, shownPostcard != null)
        // Spec §1.5 / §4 step 3: HomeShell shows the HUD over the live scene or a postcard, never over the wallpaper.
        SideEffect { model.homePicture.value = homeHudShown(picture) }
        // Spec §2 swap: a camera the player had framed is handed to the new renderer, so the postcard and the first live frame
        // line up (an unmoved camera is the scene's own fit, which the new renderer computes the same way). A pending World
        // seam entry (Enter base) keeps priority.
        LaunchedEffect(shownPostcard?.key, live) {
            val card = shownPostcard ?: return@LaunchedEffect
            val camera = card.camera ?: return@LaunchedEffect
            val controls = sceneHost?.homeCamera ?: return@LaunchedEffect
            if (!live && camera.moved && !controls.entryPending) controls.enterAt(card.key.baseId, camera.x, camera.y, camera.zoom)
        }
        val mappingFailed = preparedScene != null && preparedScene.failed && preparedScene.scene == null
        val surfaceFailed = openingFailed && preparedScene?.scene != null
        val coverFailed = mappingFailed || surfaceFailed || (raw == null && state.home.error != null && !state.home.loading)
        val refreshCover: () -> Unit = { model.refresh(); Unit }
        val remountCover: () -> Unit = { surfaceGeneration += 1 }
        val coverRetry: () -> Unit = openingRetry ?: if (surfaceFailed) remountCover else refreshCover
        Box(Modifier.fillMaxSize()) {
            // Beneath the GL surface (field report 2026-10-06): the frame where Home's surface is gone and its own layers are
            // still drawn shows the kingdom, never the window's black. The surface punches through it while it is up.
            PostcardBacking(shownPostcard)
            if (raw != null && assets != null && catalogue != null && render != null && preparedScene != null) {
                preparedScene.scene?.let { mapped ->
                    key(assets, surfaceGeneration) { SceneSurface(assets, mapped, Modifier.fillMaxSize(),
                        // §3.1: tap 2 on the selected building runs its primary (after the tap-through lock); else select.
                        // MS-C3 §1: the owner's resolved-tap hook runs FIRST in both callbacks; a consumed tap mutates nothing.
                        onSelected = { id -> if (!sceneTapConsumed(latestBeforeSceneTap, chipTap) && chipTap.allowFootprint() && sceneLive && !editing && local.placement == null
                            && model.state.value.base != null) {
                            val primary = latestBar?.takeIf { it.buildingId == id }?.commands?.lastOrNull { it.primary }
                            val tapMs = System.currentTimeMillis()
                            if (primary != null && tapMs - selectedAtMs >= PkwTokens.Motion.TAP_THROUGH_LOCK) latestOnCommand(primary.id)
                            else { selectedAtMs = tapMs; model.selectBuilding(id) }
                        } },
                        onGround = { x, y -> if (!sceneTapConsumed(latestBeforeSceneTap, chipTap)) { if (!sceneLive || model.state.value.base == null) return@SceneSurface
                            val chip = chipTap.takeDownChip()?.takeIf { !editing && local.placement == null }
                            chipTap.ground(chip)
                            if (editing) layout.tapTile(x, y)
                            // A tap on an army chip opens its building, the sheet its footprint opens (VIEW ARMY / TRAIN TROOPS).
                            else chip?.let(model::selectBuilding) ?: model.tapGround(x, y)
                        } },
                        highlights = if (editing) editor.highlights else if (livePlacement != null) state.highlights.filter {
                            it.kind != gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind.FOOTPRINT &&
                                it.kind != gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind.GRID
                        } else state.highlights,
                        // Wall strokes for every kingdom, landless included (homeWallStroke, the homeCarryMode rule).
                        wallStroke = if (editing) editor.wallStrokeMode else homeWallStroke(state, wallState, editing, busy),
                        onWallStroke = { if (editing) layout.wallStroke(it) else model.wallStroke(it) },
                        // Hold-to-lift moves (web BaseScene drag contract): landless kingdoms move too (homeCarryMode);
                        // nothing carries before the server's base has arrived (a kept base draws geometry only).
                        carry = if (base == null) null else homeCarryMode(state, editing),
                        onCarry = { event -> carrying = carryOwnsMap(carrying, event); when (event) {
                            is gg.pixelkingdomwars.nativeclient.renderer.CarryEvent.Armed -> haptic()
                            is gg.pixelkingdomwars.nativeclient.renderer.CarryEvent.Released -> { if (event.valid) haptic(); model.carry(event) }
                            else -> Unit
                        } },
                        cameraFitKey = cameraFitKey, cameraInsets = cameraInsets, baseCamera = baseCamera,
                        // the World tab's OPEN BASE seam: this base's first frame opens on the realm map's TRUE view
                        cameraControls = gg.pixelkingdomwars.nativeclient.scene.LocalSceneHost.current?.homeCamera,
                        onSurfaceDown = { x, y -> chipTap.down(chipHits.atScreen(baseCamera.value, x, y)) },
                        // Spec §2: this screen owns the cover (ScenePresentationLayer below) and learns when the scene is live.
                        onPresentationReady = { sceneLive = it }, coveredByParent = true,
                        onOpeningFailure = { failed, retry -> openingFailed = failed; openingRetry = retry },
                        postcardAccount = postcardAccount,
                        postcardClean = gg.pixelkingdomwars.nativeclient.scene.postcardClean(editing, local.placement != null,
                            state.selectedBuilding != null || state.selectedObstacle != null || local.selectedJobId != null, carrying, local.buildMenu)) }
                    ArmyChipLayer(armyChips(base, now, ArmyChipScene(home = drawnBase != null && drawnBase == base?.baseId.orEmpty(), editing = editing,
                        placing = local.placement != null, carrying = carrying, sheetBuildingId = state.selectedBuilding?.id, movingIds = local.settling.keys + unsettledIds(base, mapped.buildings))),
                        mapped, assets, render, baseCamera, chipHits, Modifier.fillMaxSize())
                    // One rule for both world-marker layers. A routine refresh (home.loading) no longer hides them: it must not
                    // blank markers already shown; another base, a move or a read error still does.
                    val worldMarkersHidden = editing || carrying || local.placement != null || local.buildMenu || local.selectedBuildingId != null ||
                        local.selectedObstacleId != null || local.selectedJobId != null || state.home.error != null ||
                        drawnBase != base?.baseId || local.settling.isNotEmpty() || unsettledIds(base, mapped.buildings).isNotEmpty()
                    LiveConstructionWorldLayer(liveConstructionSites(readConstructionJobs(state, now)), mapped, assets, render, baseCamera,
                        hidden = worldMarkersHidden,
                        onSelect = { id -> if (!sceneTapConsumed(latestBeforeSceneTap, chipTap)) model.selectBuilding(id) })
                    // home.png world markers: the Mine's READY bubble collects in place, a spent trap's notice opens its bar.
                    LiveReadyMarkerLayer(liveReadyMarkers(state), mapped, assets, render, baseCamera, hidden = worldMarkersHidden,
                        onCollect = { if (!sceneTapConsumed(latestBeforeSceneTap, chipTap)) model.collectMine() },
                        onOpen = { id -> if (!sceneTapConsumed(latestBeforeSceneTap, chipTap)) model.selectBuilding(id) })
                    livePlacement?.let { review -> LivePlacementWorldLayer(review, mapped, base?.claim, baseCamera,
                        onMove = { model.pickTile(it.x.toFloat(), it.y.toFloat()) }) }
                    // A lifted building owns the map: the plate and the bar leave at once, so a drag never meets a bar button.
                    if (selectionChromeShown(carrying)) SelectionAnchorLayer(currentPlate, currentBar?.copy(hint = selectionHint), mapped, assets, render, baseCamera, onCommand)
                    VoyageReturnLayer(base?.buildings.orEmpty(), mapped, assets, render, baseCamera,
                        !editing && local.placement == null && !carrying && state.selectedBuilding == null && local.sheet == null,
                        Modifier.fillMaxSize())
                }
                // Owner 2026-10-06: a failed refresh keeps the base drawn and says so once as a kit toast (no card over the base).
                // The same rule for a base drawn from the device's last answer when the server's read failed: it stays drawn,
                // the toast says so, and the read is tried once more.
                val cachedReadFailed = fromCache && state.home.error != null && !state.home.loading
                KingdomRefreshFailedToast((preparedScene.failed && preparedScene.scene != null) || cachedReadFailed)
                var cachedRetried by remember { mutableStateOf(false) }
                LaunchedEffect(cachedReadFailed) { if (cachedReadFailed && !cachedRetried) {
                    cachedRetried = true; kotlinx.coroutines.delay(gg.pixelkingdomwars.nativeclient.scene.HOME_UPDATE_RETRY_MS); model.refresh()
                } }
            }
            // Every path that is not live yet — the base still loading, the payload mapping, the GL activating, or any of them
            // failed — shows the postcard or the wallpaper here, with the honest indicator; a failure keeps the picture.
            ScenePresentationLayer(live, shownPostcard, coverFailed, coverRetry, lineTop = parentPadding.calculateTopPadding(),
                realmId = preparedScene?.scene?.visual?.realmId)
        }
    Box(Modifier.fillMaxSize().padding(parentPadding).consumeWindowInsets(parentPadding)) {
    // Owner 2026-10-06 (screenshots 1, 3, 4): the recovery lines stand on their own kit plates (no ink box behind them), end
    // clear of the QUESTS edge button, and step aside with the top-left cluster while a building is selected or placed.
    if (!editing && liveTray == null && homeStatusShown(state.selectedBuilding != null, local.placement != null)) Column(Modifier.align(Alignment.TopStart).widthIn(max = if (landscape) 360.dp else 480.dp).fillMaxWidth()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)).padding(start = 8.dp, end = HOME_STATUS_END_DP.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.heightIn(max = chromeLimit).verticalScroll(rememberScrollState())
            .onGloballyPositioned { statusChrome = it.boundsInWindow().cameraChromeRect() }) { statusContent() }
        // The BUILDERS dock button is gone: the HUD status chip's builders segment owns this door (HomeRequest.Builders).
    }
    // home.png / home-budget.png: the first-run cards on the kit's charcoal plate (HomeGuideCard), same position rules, only
    // while the tutorial is incomplete. The objective strip that followed them is the transient context chip now
    // (HomeScaffold `objective`, homeGuideObjective), whose tap opens Quests where the step's own doors live.
    val guideTutorial = state.home.tutorial?.takeIf { homeGuide(it, state.catalogue) != null }
    // Spec §1.5: like the HUD, the first-run cards, the chat layer and the dock row stand over a picture of the kingdom only.
    if (!editing && state.selectedBuilding == null && state.selectedObstacle == null && local.placement == null && !local.buildMenu && homeHudShown(picture)) guideTutorial?.let { tutorial -> Box(Modifier.align(Alignment.BottomStart).zIndex(1.5f).windowInsetsPadding(WindowInsets.safeDrawing).padding(start = 8.dp, end = if (landscape) primaryWidth + 8.dp else 8.dp, bottom = 64.dp)
        .widthIn(max = 480.dp).fillMaxWidth().heightIn(max = chromeLimit).verticalScroll(rememberScrollState()).blockSceneInput()) {
        HomeGuideCard(tutorial, state.catalogue, busy, model::tutorialAction, onOpenQuests)
    } }
    if (!editing && homeHudShown(picture)) Box(Modifier.matchParentSize().zIndex(1f).windowInsetsPadding(WindowInsets.safeDrawing), content = chatLayer)
    if (!editing) Column(Modifier.align(Alignment.BottomStart).widthIn(max = if (landscape) (this@BoxWithConstraints.maxWidth - primaryWidth - 8.dp).coerceIn(48.dp, 480.dp) else 480.dp).fillMaxWidth().heightIn(max = if (legacySheetOpen) sheetLimit else chromeLimit)
        .zIndex(if (local.placement != null && livePlacement == null || legacySheetOpen || runningObstacleOpen) 2f else 0f)
        .onGloballyPositioned { if (local.placement != null && livePlacement == null || legacySheetOpen || runningObstacleOpen)
            bottomChrome = it.boundsInWindow().cameraChromeRect() }
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
        .padding(horizontal = 8.dp, vertical = 8.dp)) {
        if (!editing) {
            // The LAYOUT · EXPAND · FIT dock row is folded into the HUD deck's tools shelf (HOST-RESULT.md): HomeScaffold
            // dispatches HomeRequest.BaseTool, consumed above with these same callbacks and enabled rules.
            if (local.placement == null && state.selectedBuilding == null && state.selectedObstacle == null && homeHudShown(picture)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically, content = dock)
            }
            // A draft the designed band does not take is drawn by LegacyPlacementHost (below, on the kit band), not by an ink panel here.
            state.selectedBuilding?.takeIf { buildingSheet != null && liveInfo == null && liveUpgrade == null }?.let { building ->
                BuildingSheet(state, building, busy, now, state.home.mine,
                    infoOnly = buildingSheet == BuildingSheetMode.INFO,
                    maxHeight = minOf(sheetLimit, 460.dp),
                    onTrain = { requests.request(HomeRequest.Training) }, onResearch = onOpenResearch, onArmy = onOpenArmy, onForge = onOpenForge,
                    onHeroes = onOpenHeroes, onRefresh = { model.refresh() },
                    error = notice?.takeIf { it.error }?.message ?: state.home.error?.takeIf { notice == null },
                    onUpgrade = { model.upgrade(building.id) }, onFinish = { base?.jobs?.firstOrNull { it.buildingId == building.id }?.let { model.finishBuilderJob(it) } },
                    onPaidUpgrade = { base?.baseId?.let { onBasePurchase("mine", it, building.id) } },
                    onCancel = { base?.jobs?.firstOrNull { it.buildingId == building.id }?.let { model.cancelJob(it.id) } }, onRepair = { model.repairTrap(building.id) },
                    onCollect = model::collectMine, onToggleRow = model::toggleWallRow, onQuoteRow = model::quoteWallRow, onToggleInfo = model::toggleInfo,
                    onClose = { buildingSheet = null },
                    // Other legacy KEEP actions retain their preference; builder Finish uses exact-currency review.
                    onConfirm = { pending -> if (pending is SheetConfirmation.KeepSpend && !model.keepConfirmationRequired()) pending.onConfirm() else { reviewLease.opening(); confirmation = pending } })
            }
            state.selectedObstacle?.let { obstacle ->
                val job = base?.jobs?.firstOrNull { it.obstacleId == obstacle.id }
                if (job != null) {
                    if (state.home.builderFinishReview == null) RunningObstacleSheet(job, now, !busy && !state.constructionBlocked && state.ordersAllowed && state.deedActionsAllowed,
                        { model.finishBuilderJob(job) }, model::clearSelection)
                }
            }
        }
    }
    if (editing) LayoutEditorOverlay(layout, onInsets = { editorInsets = it }, status = statusContent,
        onBuildMore = { model.openBuildMenu() }) { cameraFitKey++ }
    // The old HeroBuildMenu column is off the player path: a hero request opens the BUILD tray on its HEROES tab, which
    // draws the same offers in place (LiveBuildTrayHost `heroes`). HeroAltarPanels.kt keeps its source.
    }
    // Live BUILDINGS hosts: full-screen plain roots (no pointer handling, the pointer rule); only their painted pieces take
    // touches. Outside the parent padding so the TALL tray starts at y 104 of the screen, as SheetHost would place it.
    val sheetBounds = Modifier.onGloballyPositioned { bottomChrome = it.boundsInWindow().cameraChromeRect() }
    if (!editing) state.selectedObstacle?.let { obstacle ->
        LiveObstacleHost(state, obstacle, busy, preparedScene?.scene,
            onRemove = { model.clearObstacle(obstacle.id) }, onClose = model::clearSelection,
            onBuilders = { buildersOpen = true }, onGoToMine = model::selectBuilding, onOpenBuild = { model.openBuildMenu() },
            modifier = Modifier.zIndex(PkwTokens.Z.SHEET),
            sheetModifier = sheetBounds, sent = obstacleSent, onSent = { obstacleSent = true })
    }
    liveInfo?.let { facts -> LiveBuildingInfoHost(facts, liveRoutes, Modifier.zIndex(PkwTokens.Z.SHEET), sheetBounds) }
    liveUpgrade?.let { facts -> LiveUpgradeHost(facts, liveRoutes, Modifier.zIndex(PkwTokens.Z.SHEET), sheetBounds) }
    liveTray?.let { facts -> LiveBuildTrayHost(facts, readMineFact(state), trayRoutes, Modifier.zIndex(PkwTokens.Z.SHEET),
        initialTab = requestedBuildTab.takeUnless { local.heroesOnly } ?: gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.HEROES,
        supplies = supplies, heroes = heroState, onHeroRefresh = { model.refreshHeroRecruitment() }) }
    livePlacement?.let { facts -> LivePlacementHost(facts, readMineFact(state), placementRoutes, Modifier.zIndex(PkwTokens.Z.SHEET)) }
    // Owner 2026-10-06: a wall stroke, a hero offer without its words and a non-Shards build get the kit placement band (hint
    // pill, shelf, red CANCEL, charcoal plate) instead of the old ink panel; the tile dialog below stays their consent.
    if (!editing && livePlacement == null && !heroState.confirming) local.placement?.let { draft -> LegacyPlacementHost(draft.type, trayLabel(draft.type),
        wallState.takeIf { draft.type == "wall" }, draft.type != "wall" && base?.freeBuilders == 0, model::cancelPlacement, Modifier.zIndex(PkwTokens.Z.SHEET)) }
    // Keep STORES in place over the selected Keep (its own scrim and Back close it; the bar returns).
    val storesShown = storesOpen && !editing && keepStores != null
    if (storesShown) keepStores?.invoke({ storesOpen = false }, storesGo, Modifier.zIndex(PkwTokens.Z.SHEET))
    val latestStoresShown by rememberUpdatedState(onKeepStoresShown)
    LaunchedEffect(storesShown) { latestStoresShown(storesShown) }
    DisposableEffect(Unit) { onDispose { latestStoresShown(false) } }
    // The bar's SHORT REARM: the designed Need-more; every door only navigates, nothing is spent.
    if (!editing) barNeedMoreUi?.let { ui -> LiveShardsNeedMoreHost(ui, readMineFact(state), model::selectBuilding, { model.openBuildMenu() },
        { barNeedMore = null }, Modifier.zIndex(PkwTokens.Z.SHEET)) }
    // A Mine / Gold Forge SOL step: the designed Seal raised in place over the existing purchase owner; DETAILS is the old
    // purchase screen for recovery only.
    if (solSurface == HomeSolSurface.PAID_UPGRADE) state.selectedBuilding?.let { b ->
        LivePaidUpgradeSeal(solPurchase, base?.baseId, b.id, "UPGRADE ${trayLabel(b.type).uppercase()}",
            onClose = { paidUpgradeOpen = false },
            onDetails = { base?.baseId?.let { id -> paidUpgradeOpen = false; onBasePurchase("mine", id, b.id) } },
            modifier = Modifier.zIndex(PkwTokens.Z.SHEET))
    }
    }
    val draft = local.placement; val tile = draft?.tile
    // The MS-C3 review signal reads this same predicate (KingdomMountHooks.kt); the null checks after it only smart-cast.
    if (legacyPlacementDialogVisible(draft, base != null, heroReviewHeld(heroState), livePlacement != null) && draft != null && tile != null && base != null) {
        val price = state.price(draft.type)
        val hero = heroState.offers.find { it.definition.type == draft.type }
        val builderBusy = draft.type != "wall" && base.freeBuilders == 0
        // Owner 2026-10-06: the kit confirm (KingdomConfirmDialog.kt) with the dialog's words, enable rule and owners.
        KingdomConfirmDialog(KingdomConfirmUi("Place ${trayLabel(draft.type)}".uppercase(),
            listOf("Tile ${tile.first}, ${tile.second}", if (builderBusy) "No free builder" else "The server checks space, ownership, builders and current cost."),
            confirmLabel = if (hero != null) "REVIEW RECRUITMENT" else "PLACE", backLabel = "CHOOSE ANOTHER TILE",
            emphasis = hero?.priceLabel() ?: price?.description() ?: "Price unavailable",
            confirmEnabled = (price != null || hero != null && heroState.supported && heroState.enabled && heroState.pending == null)
                && state.constructionAvailable(draft.type) && !busy && !heroState.busy && !state.constructionBlocked && !builderBusy && state.deedActionsAllowed && state.ordersAllowed),
            onConfirm = { if (hero != null) model.reviewHeroPlacement() else model.confirmPlacement() }, onBack = { model.clearTile() })
    }
    heroState.review?.let { review -> HeroAltarConfirm(review, busy || heroState.busy || !state.ordersAllowed || !state.deedActionsAllowed,
        { model.confirmHeroPlacement(review) }, { model.dismissHeroReview() }) }
    BuilderFinishCurrencyConfirm(state, busy, model, preparedScene?.scene, onGetGems)
    if (state.home.builderFinishReview == null) base?.jobs?.firstOrNull { it.id == local.selectedJobId && it.kind == "clear_obstacle" }?.let { job ->
        RunningObstacleSheet(job, now, !busy && !state.constructionBlocked && state.ordersAllowed && state.deedActionsAllowed,
            { model.finishBuilderJob(job) }, model::clearSelection)
    }
    if (buildersVisible && base != null) LiveBuildersHost(state, busy, now = now,
        canHire = landOwned && !busy && state.ordersAllowed && state.deedActionsAllowed,
        onHire = { base.baseId?.let { buildersOpen = false; onBasePurchase("builder", it, null) } },
        onViewJob = { job ->
            buildersOpen = false
            // Opened over the placement band (NO_BUILDER): flying to the job leaves placement first.
            if (local.placement != null) model.cancelPlacement()
            model.selectJob(job)
        }, onFinish = { job -> buildersOpen = false; model.finishBuilderJob(job) },
        onBuild = { buildersOpen = false; model.openBuildMenu() },
        onClose = { buildersOpen = false }, modifier = Modifier.zIndex(PkwTokens.Z.SHEET),
        // HIRE raises the SOL Seal in place on the existing owner; onHire (the old screen) stays only as the fallback, and
        // the old screen is reachable only through DETAILS, to recover a saved purchase.
        purchase = solPurchase.takeIf { solSurface == HomeSolSurface.BUILDERS },
        onPurchaseDetails = { base.baseId?.let { buildersOpen = false; onBasePurchase("builder", it, null) } })
    confirmation?.let { pending ->
        when (pending) {
            is SheetConfirmation.CancelJob -> CancelJobDialog(pending) { confirmation = null }
            is SheetConfirmation.KeepSpend -> KeepSpendDialog(pending, onDismiss = { confirmation = null }, onOptOut = { model.setKeepConfirm(false) })
        }
    }
    local.wallRowQuote?.let {
        LiveWallRowHost(state, busy, notice?.takeIf { it.error }?.message,
            onPurchase = model::purchaseWallRow, onRetry = { model.retryWallRow() }, onCancel = model::dismissWallRowQuote,
            onRecheck = model::quoteWallRow, onGoToMine = model::selectBuilding, onOpenBuild = { model.openBuildMenu() },
            modifier = Modifier.zIndex(PkwTokens.Z.SHEET))
    }
    when (local.sheet) {
        KingdomSheet.DAILY_CACHE -> if (dailyCacheVisible) key(state.selectedBaseId) {
            LiveDailyCacheHost(state.catalogue, state.home.mine, busy, now,
                blockedReason = dailyCacheBlockedReason(state.ordersAllowed, state.deedActionsAllowed, state.activeRaid != null),
                onClaim = model::claimDailyCache, onClose = model::closeSheet, modifier = Modifier.zIndex(PkwTokens.Z.SHEET))
        }
        KingdomSheet.EXPAND -> LiveExpandHost(state,
            testExpansion = gg.pixelkingdomwars.nativeclient.BuildConfig.NATIVE_CANDIDATE,
            enabled = landOwned && !busy && state.ordersAllowed && state.deedActionsAllowed,
            onReview = { base?.baseId?.let { model.closeSheet(); onBasePurchase("expansion", it, null) } }, onClose = model::closeSheet,
            onKeep = { model.closeSheet(); base?.buildings?.firstOrNull { it.type == "keep" }?.let { model.selectBuilding(it.id) } },
            modifier = Modifier.zIndex(PkwTokens.Z.SHEET),
            // EXPAND raises the SOL Seal in place; the candidate's test expansion keeps onReview (its own screen).
            purchase = solPurchase.takeIf { solSurface == HomeSolSurface.EXPAND && !gg.pixelkingdomwars.nativeclient.BuildConfig.NATIVE_CANDIDATE },
            onPurchaseDetails = { base?.baseId?.let { model.closeSheet(); onBasePurchase("expansion", it, null) } })
        null -> {}
    }
}

@Composable private fun JobProgress(job: BaseJob, label: String, now: Long, modifier: Modifier = Modifier) {
    val progress = baseJobProgress(job.startedAt, job.finishesAt, now)
    Column(modifier) {
        Text("$label · ${progress?.remaining ?: "Time unavailable"}", style = MaterialTheme.typography.bodySmall)
        progress?.let { LinearProgressIndicator(progress = { it.fraction }, modifier = Modifier.fillMaxWidth()) }
    }
}

internal fun questLabel(catalogue: JsonObject?, code: String): String =
    (catalogue?.get("display") as? JsonObject)?.get("questLabels")?.jsonObject?.string(code) ?: code.replace('_', ' ').replaceFirstChar { it.uppercase() }

internal fun retiredTutorialStep(step: Int, completed: Boolean, ids: JsonArray?): Boolean {
    if (completed || ids.isNullOrEmpty()) return false
    return step >= ids.size || ids.getOrNull(step)?.jsonPrimitive?.content == "done"
}

/** The objective strip (web `OnboardingStrip`/`OnboardingGuide`): the live chain step, its verb and hint, CLAIM once completed. */
@Composable private fun OnboardingStrip(quest: gg.pixelkingdomwars.nativeclient.model.Quest, action: StepAction?, busy: Boolean,
    catalogue: JsonObject?, walletSol: String?, unpaidLand: Boolean, onClaim: () -> Unit, onGo: (StepDestination) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val stacked = maxWidth < 420.dp
        val cta: @Composable () -> Unit = {
            if (quest.completed && !quest.claimed) Button(onClick = onClaim, enabled = !busy,
                modifier = if (stacked) Modifier.fillMaxWidth() else Modifier.widthIn(min = 76.dp), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) { Text("CLAIM", fontSize = 16.sp) }
            else if (action != null) OutlinedButton(onClick = { onGo(action.go) }, enabled = !busy,
                modifier = if (stacked) Modifier.fillMaxWidth() else Modifier.widthIn(min = 76.dp), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) { Text(action.verb, fontSize = 16.sp) }
        }
        PixelPlate("bar", Modifier.fillMaxWidth(), PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PixelPlate("shard", Modifier.size(38.dp)) { GameArt(if (quest.completed) "star" else "quests", Modifier.align(Alignment.Center).size(20.dp)) }
                    Column(Modifier.weight(1f)) {
                        Text(if (quest.completed) "COMPLETE" else "OBJECTIVE", color = Palette.textFaint, fontSize = 13.sp, lineHeight = 15.sp, letterSpacing = 1.sp)
                        Text(questLabel(catalogue, quest.templateCode), fontSize = 17.sp, lineHeight = 20.sp)
                        action?.let { Text(it.hint, fontSize = 13.sp, lineHeight = 16.sp, color = Palette.goldHi) }
                        if (quest.templateCode == "first_land" && !quest.completed && unpaidLand) {
                            val entry = ((catalogue?.get("constants") as? JsonObject)?.get("ECONOMY") as? JsonObject)?.string("entryFeeSol")
                            entry?.let { Text("PRICE $it SOL + NETWORK FEE", fontSize = 13.sp, lineHeight = 16.sp, color = Palette.muted) }
                            val sol = walletSol?.toBigDecimalOrNull()?.takeIf { it.signum() >= 0 }
                            Text(sol?.let { "WALLET ${it.setScale(4, java.math.RoundingMode.HALF_UP).toPlainString()} SOL" } ?: "CHECKING WALLET SOL…",
                                fontSize = 13.sp, lineHeight = 16.sp, color = Palette.muted)
                            if (sol != null && entry?.toBigDecimalOrNull()?.let { sol < it } == true)
                                Text("ADD SOL TO CONTINUE", fontSize = 13.sp, lineHeight = 16.sp, color = Palette.goldHi)
                        }
                        if (quest.target?.toBigDecimalOrNull()?.let { it > java.math.BigDecimal.ONE } == true)
                            Text("${quest.progress ?: "—"}/${quest.target}", fontSize = 13.sp, lineHeight = 16.sp, color = Palette.textFaint)
                    }
                    PixelPlate("shard", contentPadding = PaddingValues(horizontal = 7.dp, vertical = 3.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            GameArt("shards", Modifier.size(13.dp)); Text("+${quest.rewardShards ?: "—"}", color = Palette.goldHi, fontSize = 15.sp)
                        }
                    }
                    if (!stacked) cta()
                }
                if (stacked) cta()
            }
        }
    }
}

@Composable private fun KingdomGuidance(tutorial: TutorialState, catalogue: JsonObject?, busy: Boolean, onAction: (String) -> Unit, onOpenQuests: () -> Unit, strip: @Composable (gg.pixelkingdomwars.nativeclient.model.Quest) -> Unit) {
    if (tutorial.guideSkipped) return
    if (!tutorial.completed) {
        val ids = (catalogue?.get("constants") as? JsonObject)?.get("TUTORIAL_STEPS")?.jsonObject?.get("ids") as? JsonArray
        if (retiredTutorialStep(tutorial.step, tutorial.completed, ids)) { TextButton(onClick = { onAction("skip") }, enabled = !busy) { Text("Continue to your current objectives") }; return }
        val step = ids?.getOrNull(tutorial.step)?.jsonPrimitive?.content
        val copy = when (step) {
            "welcome" -> "Welcome, Keeper" to "Build your kingdom, train troops and follow the quest board for your first objectives."
            "camera" -> "Explore your kingdom" to "Drag to move around your base and pinch to zoom. Tap a building to inspect it. Hold a building still, then drag, to move it."
            "quests" -> "Your next objective" to "The quest board tracks construction, training and campaign progress. Claim completed objectives there."
            else -> null
        } ?: return
        PixelPlate("bar", Modifier.fillMaxWidth(), PaddingValues(10.dp)) { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(copy.first.uppercase(), fontSize = 20.sp, color = Palette.goldHi); Text(copy.second, fontSize = 15.sp, lineHeight = 18.sp)
            Column {
                TextButton(onClick = { onAction("advance") }, enabled = !busy) { Text("CONTINUE", fontSize = 15.sp) }
                // Web TutorialOverlay: the last card's OPEN QUESTS advances onto 'done' AND opens the board, so the player never
                // comes back from the quest board to a card they have already finished.
                if (step == "quests") TextButton(onClick = { onAction("advance"); onOpenQuests() }, enabled = !busy) { Text("OPEN QUESTS", fontSize = 15.sp) }
                TextButton(onClick = { onAction("guide/skip") }, enabled = !busy) { Text("SKIP GUIDANCE", fontSize = 13.sp) }
            }
        } }
    } else tutorial.onboarding?.let { quest ->
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { onAction("guide/skip") }, enabled = !busy, modifier = Modifier.align(Alignment.End), contentPadding = PaddingValues(horizontal = 8.dp)) { Text("SKIP GUIDANCE", fontSize = 13.sp) }
            strip(quest)
        }
    }
}

internal fun builderFinishIsFree(job: BaseJob): Boolean = job.finishCostKeep == "0"
internal fun builderFinishCanReview(job: BaseJob): Boolean = job.kind in setOf("upgrade", "repair", "clear_obstacle") &&
    job.finishCostKeep?.matches(Regex("[1-9][0-9]*")) == true
internal fun builderFinishReviewTerms(state: KingdomUiState): gg.pixelkingdomwars.nativeclient.model.BuilderJobSpeedupIntent? =
    state.home.builderFinishReview?.takeIf { it.intent.wallet == state.wallet && it.generation == state.baseGeneration &&
        state.selectedBaseId != null && it.intent.baseId == state.selectedBaseId }?.intent?.let {
        runCatching { gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec.builderTerms(it) }.getOrNull()
    }

@Composable private fun BuilderFinishLifecycle(model: KingdomViewModel, state: KingdomUiState) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) model.dismissBuilderFinishReview()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismissBuilderFinishReview() }
    }
    // Runs on every (re)entry and on each interlock flip, back to allowed too: a screen-driven close, never the player's.
    LaunchedEffect(state.selectedBaseId, state.baseGeneration, state.ordersAllowed, state.deedActionsAllowed) { model.retireBuilderFinishReview() }
    BackHandlerAt(BackPriority.SHEET, enabled = state.home.builderFinishReview != null) { model.dismissBuilderFinishReview() }
}

@Composable private fun BuilderFinishPending(state: KingdomUiState, busy: Boolean, model: KingdomViewModel) {
    state.interrupted.filter { it.kind == IntentKind.CONSTRUCTION && it.intent.wallet == state.wallet &&
        gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec.modernBuilder(it.intent) }.forEach { saved ->
        val terms = runCatching { gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec.builderTerms(saved.intent) }.getOrNull()
        // Owner 2026-10-06: the kit herald plate (HomeRecoveryPlates.kt) instead of the old dark card; same words and doors.
        RecoveryPlate("SAVED BUILDER PAYMENT", listOfNotNull(
            terms?.let { "${it.consent.kind} · up to ${it.consent.maxCostKeep} ${it.expectedCurrency}" },
            "Kingdom ${saved.intent.baseId ?: "original kingdom"}",
            if (saved.proven) "Original payment confirmed. Check current state." else "Check the original receipt before another finish.",
            Copy.observation(saved.lastObservation)),
            listOfNotNull(RecoveryAction("CHECK ORIGINAL RECEIPT", { model.refreshBuilderFinish() }, enabled = !busy,
                verb = gg.pixelkingdomwars.nativeclient.ui.model.Verb.GOLD),
                if (!saved.proven && !saved.kept && terms != null) RecoveryAction("REVIEW SAME PAYMENT", { model.reviewSavedBuilderFinish() },
                    enabled = !busy && state.ordersAllowed && state.deedActionsAllowed && state.selectedBaseId != null && state.selectedBaseId == saved.intent.baseId)
                else null,
                // Owner 2026-10-06: once the receipt route answered `unknown` for this key, the herald's CLOSE (same owner
                // callback, MoneyOp.close: one more GET, then forgotten on this device; nothing is sent) is the way out.
                if (saved.closable) RecoveryAction(Copy.CLOSE_REQUEST.uppercase(), { model.interrupted.close(saved.kind) }, enabled = !busy,
                    spoken = "Close saved payment") else null), Modifier.fillMaxWidth())
    }
}

@Composable private fun BuilderFinishCurrencyConfirm(state: KingdomUiState, busy: Boolean, model: KingdomViewModel,
    scene: BaseScene? = null, onGetGems: ((String) -> Unit)? = null) {
    gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeSpeedupMount(state, busy,
        current = { model.state.value }, currentBusy = { model.busy.value },
        onConfirm = { model.confirmBuilderFinish() }, onBack = model::dismissBuilderFinishReview,
        scene = scene, onGetGems = onGetGems, modifier = Modifier.zIndex(PkwTokens.Z.SEAL))
    val terms = builderFinishReviewTerms(state) ?: return
    if (terms.expectedCurrency == gg.pixelkingdomwars.nativeclient.model.GameCurrency.GEMS) return
    // Owner 2026-10-06: the kit confirm (KingdomConfirmDialog.kt) with the review's exact words, guard and owners.
    KingdomConfirmDialog(KingdomConfirmUi("FINISH BUILDER JOB", listOfNotNull(
            // Owner 2026-10-06 17:24 (SealWords.kt): the kingdom's name, the job in words and its time left; the frozen job id and
            // instants stay in the saved request the repository compares and sends.
            gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.builderFinishSubjectLine(state, terms),
            gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealTimeFromNow(terms.consent.finishesAt, displayClock())?.let { "Finishes $it" },
            "Pay only the shown currency. The charge may decrease as this job finishes naturally.",
            if (state.home.builderFinishReview?.intent?.attempted == true) "Use the same saved payment and key." else null),
        confirmLabel = "PAY ${terms.expectedCurrency}", backLabel = "CANCEL", confirmVerb = gg.pixelkingdomwars.nativeclient.ui.model.Verb.GOLD,
        emphasis = "Up to ${terms.consent.maxCostKeep} ${terms.expectedCurrency}",
        confirmEnabled = !busy && state.ordersAllowed && state.deedActionsAllowed),
        onConfirm = { model.confirmBuilderFinish() }, onBack = { model.dismissBuilderFinishReview() }) {
        GameArt(if (terms.expectedCurrency.name == "GEMS") "gem" else "keep", Modifier.size(24.dp), terms.expectedCurrency.name)
    }
}

/** Receipt-only entry survives loss of the last base; no Home hydration or mutation runs on entry. */
@Composable fun BuilderPaymentScreen(model: KingdomViewModel, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val busy by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    BuilderFinishLifecycle(model, state)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(model, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
        model.busy.first { !it }; model.refreshBuilderFinish()?.join()
    } }
    BackHandlerAt(BackPriority.SCREEN) { model.dismissBuilderFinishReview(); onBack() }
    // Second old-screen sweep (owner 2026-10-06): the land gate's CHECK BUILDER PAYMENT door opens the designed page.
    gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage("BUILDER PAYMENT", { model.dismissBuilderFinishReview(); onBack() }) {
        notice?.let { Notice(it.message, it.error, model::dismissNotice) }
        state.home.message?.let { Text(it) }; state.home.error?.let { Text(it) }
        BuilderFinishPending(state, busy, model)
        if (state.interrupted.none { it.kind == IntentKind.CONSTRUCTION && it.intent.wallet == state.wallet }) Text("No saved builder payment is loaded.")
        OutlinedButton(onClick = { model.refreshBuilderFinish() }, enabled = !busy) { Text("CHECK SAVED PAYMENT") }
    }
    BuilderFinishCurrencyConfirm(state, busy, model)
}

/** The kit command bar + name plate over the selected building (MOUNT-COMMAND.md hunk 5). The anchor uses footprint
 * sides and bottom with the measured roof, or the footprint top when the roof is unmeasured. The camera is read only
 * in this layer, so a pan never recomposes KingdomScreen. No camera, another base or a moving camera gives a null
 * anchor: the plate hides and the bar stays at the bottom. This layer
 * is a plain full-size overlay with no pointer handling (the pointer rule); only the command faces take touches. */
@Composable private fun SelectionAnchorLayer(plate: NamePlateUi?, bar: CommandBarUi?, scene: BaseScene, assets: java.io.File,
    render: JsonObject, camera: State<BaseCameraView?>, onCommand: (FeatureId) -> Unit) {
    val building = bar?.let { b -> scene.buildings.firstOrNull { it.id == b.buildingId } }
    var roof by remember(building?.id, building?.frameKey) { mutableStateOf<Float?>(null) }
    LaunchedEffect(assets, render, scene.tilePixels, building) {
        roof = building?.let { b -> withContext(Dispatchers.IO) { BuildingRooflines.measuredRoof(assets, render, b, scene.tilePixels) } }
    }
    val anchor by remember(building, scene.baseId, scene.tilePixels) { derivedStateOf {
        buildingSelectionAnchor(building, roof, scene.baseId, scene.tilePixels, camera.value)
    } }
    SelectionOverlay(if (plate == null || bar == null) null else SelectionUi(plate, bar, anchor), onCommand,
        Modifier.fillMaxSize().zIndex(PkwTokens.Z.COMMAND_BAR))
}

/** Projection only: the footprint comes from the scene and never admits art or commands. */
internal fun buildingSelectionAnchor(building: RenderBuilding?, measuredRoof: Float?, baseId: String?,
    tilePixels: Float, camera: BaseCameraView?): PxRect? {
    val b = building ?: return null
    val view = camera?.takeIf { it.baseId == baseId && it.overlayVisible } ?: return null
    val top = measuredRoof ?: (b.tileY * tilePixels)
    return PxRect(view.screenX(b.tileX * tilePixels), view.screenY(top),
        view.screenX((b.tileX + b.footprintWidth) * tilePixels),
        view.screenY((b.tileY + b.footprintHeight) * tilePixels))
}
