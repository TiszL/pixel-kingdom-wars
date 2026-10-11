package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleHudActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleHudEndConfirmLayer
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleHudOverlay
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleHudRegion
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleResultCardV2
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleResultV2Actions
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import androidx.compose.ui.text.style.TextAlign
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.*
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Surface
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.FilterChip

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.SceneMapper
import gg.pixelkingdomwars.nativeclient.scene.SceneSurface
import gg.pixelkingdomwars.nativeclient.scene.SceneInputScope
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.army.trainingTroopLabel
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.node.LayoutModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.verticalScroll
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.attack.raidEntryCostLabel
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import kotlin.math.floor
import kotlin.math.roundToLong

class BattleViewModel(val battle: BattleRepository, val content: ContentRepository, private val homeRequests: HomeRequests? = null, val feedbackIdentity:Any?=null) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph) : this(session.battle, graph.content, graph.homeRequests, session.session)
    val state = battle.state.stateIn(viewModelScope, SharingStarted.Eagerly, battle.state.value)
    val contentState: StateFlow<gg.pixelkingdomwars.nativeclient.data.ContentState> = content.state
    fun mapper(c: ContentState = content.state.value): SceneMapper? = if (c.catalogue != null && c.renderCatalogue != null) SceneMapper(c.catalogue, c.renderCatalogue, gg.pixelkingdomwars.nativeclient.ui.kingdom.visualLog) else null
    fun action(block: suspend () -> Unit) = battle.battleAction(block)
    fun stagingAction(coordinator: BattleCoordinator, block: suspend () -> Unit) = battle.battleAction {
        check(battle.stagingInputAllowed(coordinator)) { "Checking this march. Your saved orders are safe." }
        block()
    }
    /** A deploy or hero tap: the same staging recheck as [stagingAction], without the error line (see `BattleRepository.deployAction`). */
    fun deployAction(coordinator: BattleCoordinator, block: suspend () -> Unit) = battle.deployAction {
        check(battle.stagingInputAllowed(coordinator)) { "Checking this march. Your saved orders are safe." }
        block()
    }
    fun checkReservation(coordinator: BattleCoordinator) = run { battle.refreshStagingReservation(coordinator) }
    fun returnHome() = run { battle.returnHome() }
    /** Web `exit` followed by a destination (WORLD MAP, CAMPAIGN, TRAIN ARMY, RAID LOG, BUY LAND): Home first, then the request. */
    fun exitTo(request: HomeRequest? = null, after: (() -> Unit)? = null) = run { battle.returnHome(); request?.let { homeRequests?.request(it) }; after?.invoke() }
    fun retryCreate() = run { battle.retryCreate() }
    fun checkEntry(coordinator: BattleCoordinator) = battle.battleAction { coordinator.refreshEntry() }
    /** The player's confirmed "Discard saved request" (D153.333 d): nothing is sent (see `BattleRepository.discardSavedCreate`). */
    fun discardSavedRequest(coordinator: BattleCoordinator, id: String) = run { battle.discardSavedCreate(coordinator, id) }
    /** Navigation only: do not FINISH or clear an acknowledged march when the connection is unavailable. */
    fun leaveSavedEntry() = battle.leaveBattleView()
    /** Web `replayAgain`: NEXT RAID starts an automatic match, NEXT STAGE advances; past the last stage the campaign list opens. */
    fun raidAgain() = run { if (!battle.raidAgain()) homeRequests?.request(HomeRequest.Tab(HomeTab.ATTACK)) }
    fun nextTarget() = run { battle.nextTarget() }
    fun retreat() = run { battle.retreat() }
    fun buffNotice(message: String) = notify(message, error = false)
    suspend fun foreground(coordinator: BattleCoordinator) = battle.foreground(coordinator)
    suspend fun foreground(spectator: BattleSpectator) = battle.foreground(spectator)
    fun closeReplay() = battle.closeReplay()
    fun closePreview() = battle.closePreview()
    fun attackPreview(preview: ScoutPreview) = run { battle.attackPreview(preview) }
    fun closeSpectator() = battle.closeSpectator()
}

/** Destinations a battle exit can name (web `goToMap`, `trainAfterRaid`, `setLandPrompt('browse')`). */
class BattleExits(val onEnergy: ((String, String) -> Unit)? = null, val onLand: () -> Unit)

/** The web's BUFF_DEFS labels; costs come from the catalogue's `BUFFS.<key>.costKeep`. */
private val BUFF_LABELS = linkedMapOf("warhorn" to "WAR HORN", "swiftboots" to "SWIFT BOOTS", "powdercharge" to "POWDER CHARGE")

/** Live battle: canonical playhead from the server clock via withFrameNanos, ColdPrefix hydration
 * kept per raid, roster from the frozen reservation. PvP adds the buff pills, NEXT TARGET, the create
 * refusal panels and the VICTORY / DEFEAT verdict (web RaidUI.tsx). */
@Composable fun LiveBattleScreen(model: BattleViewModel, coordinator: BattleCoordinator, keepLevel: Int, exits: BattleExits = BattleExits {}, onboarding: Boolean = false,
    /** The signed-in account's postcard key (ScenePostcards): the opening shows the player's own base dimmed while it waits. */
    postcardAccount: String? = null) {
    val live by coordinator.state.collectAsState()
    val raidId = live.pending?.raidId
    val domain by model.state.collectAsState()
    val content by model.contentState.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val resultUi=rememberLiveResult(model,coordinator,content,live.result,live.pending?.raidId)
    fun leave(block:()->Unit){resultUi.dismiss();block()}
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val haptic = LocalGameHaptic.current
    var selection by remember(coordinator) { mutableStateOf<Pair<String, String>?>(null) }
    val roster = remember(live.presentation) { BattleRoster.read(live.presentation?.get("armySnapshot")) }
    LaunchedEffect(roster) { if (selection?.let(roster::contains) == false) selection = null }
    var confirmRetreat by remember { mutableStateOf(false) }
    var confirmNextTarget by remember { mutableStateOf(false) }
    LaunchedEffect(coordinator, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(coordinator) } }
    val commandTiming = remember(coordinator) { model.battle.commandTiming(coordinator) }
    val commandDraw = remember(commandTiming, raidId) { commandTiming?.drawTiming() }
    DisposableEffect(commandDraw) { onDispose { commandDraw?.close() } }
    val playback = rememberBattlePlayback(coordinator, raidId, live, content, model, commandDraw, commandTiming)
    SideEffect { commandDraw?.activate(playback.scene?.commandTiming) }
    val constants = content.catalogue?.get("constants")?.jsonObject
    val failure = domain.createFailure
    val entryRecovery = battleEntryRecovery(live, domain.error, domain.lastTarget != null, playback.error)
    BackHandlerAt(BackPriority.CONFIRM, enabled = confirmRetreat || confirmNextTarget) { if (!domain.retreating) { confirmRetreat = false; confirmNextTarget = false } }
    BackHandlerAt(BackPriority.BATTLE, enabled = !confirmRetreat && !confirmNextTarget) {
        if (live.creating) return@BackHandlerAt
        // The result's Back is its HOME door, held while a door's order is in flight (the old result dialog's rule).
        if (live.result != null && busy) return@BackHandlerAt
        if (entryRecovery.leaveSavedView) leave(model::leaveSavedEntry)
        else if (live.terminal || live.blocked || live.pending?.raidId == null) leave(model::returnHome) else confirmRetreat = true
    }
    // A result ends the battle: no END confirm outlives it, and a notice left from the fight does not belong on the result
    // card (whose notice line then carries only what its own doors report).
    LaunchedEffect(live.result != null) { if (live.result != null) { confirmRetreat = false; model.dismissNotice() } }
    // NEXT TARGET asks in the designed decision dialog (the old dark AlertDialog is off the battle path); same strings,
    // guards and owner call.
    if (confirmNextTarget) BattleDecisionDialog(Copy.NEXT_TARGET_TITLE, onDismiss = { if (!domain.retreating) confirmNextTarget = false },
        body = { BattleDialogLine(Copy.nextTargetBody(raidEntryCostLabel(constants, keepLevel) ?: "—")) }) {
        SecondaryButton("CANCEL", { if (!domain.retreating) confirmNextTarget = false }, Modifier.weight(1f), enabled = !domain.retreating)
        SecondaryButton(if (domain.retreating) Copy.CONFIRMING else if (domain.nextTargetIntent) Copy.RETRY_NEXT_TARGET else Copy.NEXT_TARGET,
            { confirmNextTarget = false; model.nextTarget() }, Modifier.weight(1f), verb = Verb.RED, enabled = !domain.retreating)
    }
    SceneInputScope {
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val shortLandscape = this.maxWidth > this.maxHeight * 1.1f && this.maxHeight <= 520.dp
    val desktop = this.maxWidth >= 900.dp && this.maxHeight >= 600.dp
    val activeScene = playback.scene?.scene
    val progressIndex = rememberBattleHudProgress(activeScene, content.catalogue)
    val progressTick = activeScene?.tickDurationMs?.takeIf { it > 0 }?.let { floor(playback.shown / it).toFloat() } ?: 0f
    val progress = remember(progressIndex, progressTick) { progressIndex?.at(progressTick) }
    val field = remember(progressIndex, progressTick) { progressIndex?.fieldAt(progressTick) }
    // Every acknowledged deploy is a new revision whose index is rebuilt off the main thread. What the HUD shows
    // holds its last value meanwhile (no "—%", no dimmed stars, no hint flip); automatic FINISH reads `progress`.
    val shownStars = remember(coordinator, raidId) { BattleHudLatch<Int>() }.offer(progress?.first)
    val shownDestroyed = remember(coordinator, raidId) { BattleHudLatch<Int>() }.offer(progress?.second)
    val shownField = remember(coordinator, raidId) { BattleHudLatch<BattleHudProgress.Field>() }.offer(field)
    val troopsCommitted = remember(coordinator, raidId) { BattleHudLatch<Boolean>() }.offer(true.takeIf { battleTroopsCommitted(live) }) == true
    val reservesLeft = roster.troops.any { live.available(it) > 0 } || roster.heroes.any { !live.reserved("hero", "hero", it) }
    val catalogueBattleDurationMs = (constants?.get("RAID_RULES") as? JsonObject)?.string("battleDurationSec")?.toLongOrNull()
        ?.takeIf { it > 0 && it <= Long.MAX_VALUE / 1000 }?.times(1000)
    val deployTimer = rememberDeploymentTimer(live.deployEndsAtMs(catalogueBattleDurationMs))
    val stagingInputAllowed = model.battle.stagingInputAllowed(coordinator)
    val deploymentHint = battleHintLine(live, stagingInputAllowed, domain.stagingReservation, domain.nextTargetIntent, domain.retreating,
        shownDestroyed, shownField, reservesLeft, troopsCommitted, selection?.let { trainingTroopLabel(it.second).uppercase() })
    val recovery = battleRecoverySummary(live)
    val stuckRequests = rememberStuckBattleRequests(coordinator, raidId, recovery.waiting)
    // Automatic FINISH (web commitRaid): once at 100% destruction, once at the due clock; the server result ends the battle.
    val autoFinish = remember(coordinator, raidId) { BattleAutoFinish() }
    val clockDue = live.clock?.value?.let { it.anchorWallAt != null && playback.playhead >= it.durationMs } == true
    val finishReady = raidId != null && live.connected && !live.blocked && !domain.retreating && !domain.nextTargetIntent && live.unresolvedFinish == null
    LaunchedEffect(autoFinish, live.phase, live.result == null, finishReady, progress?.second, clockDue) {
        if (autoFinish.shouldFinish(progress?.second, live.phase == BattlePhase.RUNNING, live.result != null, finishReady, clockDue))
            model.action { try { coordinator.finish() } catch (error: ApiException) { if (error.code != "RAID_CLOCK_NOT_DUE") throw error } }
    }
    val cameraControls = rememberBattleCameraControls(live.pending?.raidId ?: coordinator, content.catalogue)
    var hudMeasure by remember(coordinator) { mutableStateOf<BattleChromeMeasure?>(null) }
    var trayMeasure by remember(coordinator) { mutableStateOf<BattleChromeMeasure?>(null) }
    val cameraInsetLatch = remember(coordinator, raidId) { BattleCameraInsetLatch() }
    var presented by remember(coordinator, raidId, content.assets) { mutableStateOf(false) }
    var graphicsRetry by remember(coordinator, raidId, content.assets) { mutableStateOf<(() -> Unit)?>(null) }
    // The field's own opening failure (preparation error with its retry, or a fatal renderer error), reported to the cover.
    var fieldFailed by remember(coordinator, raidId, content.assets) { mutableStateOf(false) }
    var fieldRetry by remember(coordinator, raidId, content.assets) { mutableStateOf<(() -> Unit)?>(null) }
    val sceneHost = gg.pixelkingdomwars.nativeclient.scene.LocalSceneHost.current
    val battleGround = rememberRealmGround(content.assets, playback.scene?.scene?.base?.visual)
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val hudPixels = hudMeasure?.pixels ?: 0; val trayPixels = trayMeasure?.pixels ?: 0
        val unavailablePadding = with(LocalDensity.current) { PaddingValues(top = hudPixels.toDp(), bottom = trayPixels.toDp()) }
        val cameraEnvironment = BattleCameraEnvironment(raidId, constraints.maxWidth, constraints.maxHeight, safeBattleCameraInsets(0, 0, constraints.maxHeight))
        val recoveryWidth = (maxWidth - 176.dp).coerceAtLeast(160.dp) // Clear of the camera rail at the trailing edge.
        val active = playback.scene; val assets = content.assets
        val opening = (active == null || assets == null || !presented) && !live.expired && live.result == null &&
            !(live.pending == null && !live.creating && failure != null)
        // While the designed HUD is up, its own END confirm asks (battle-hud.png ConfirmDialog, composed below over the
        // whole battle). This dialog remains only for the opening and recovery paths, where no HUD is composed.
        val hudConfirm = !opening && live.result == null && live.pending != null && !live.expired
        if (confirmRetreat && !hudConfirm && live.result == null) BattleDecisionDialog(Copy.RETREAT_TITLE, onDismiss = { if (!domain.retreating) confirmRetreat = false },
            body = { BattleDialogLine(Copy.RETREAT_BODY) }) {
            SecondaryButton("STAY", { if (!domain.retreating) confirmRetreat = false }, Modifier.weight(1f), enabled = !domain.retreating)
            SecondaryButton(if (domain.retreating) Copy.CONFIRMING else Copy.RETREAT, { confirmRetreat = false; model.retreat() }, Modifier.weight(1f),
                verb = Verb.RED, enabled = live.pending?.raidId != null && !live.blocked && !domain.retreating)
        }
        val retryEntry: (() -> Unit)? = when (entryRecovery.retry) {
            BattleEntryRetry.CREATE -> ({ model.retryCreate(); Unit })
            BattleEntryRetry.CHECK -> ({ model.checkEntry(coordinator); Unit })
            BattleEntryRetry.PLAYBACK -> playback.retry
            null -> null
        }
        // The opening and recovery bar in kit controls (no Material buttons or text on the battle path).
        val openingActions: @Composable () -> Unit = {
                val ending = live.pending?.raidId != null && !live.terminal && !live.blocked && !entryRecovery.leaveSavedView
                SecondaryButton(if (ending) "END" else Copy.BACK_TO_BASE, {
                    if (entryRecovery.leaveSavedView) leave(model::leaveSavedEntry)
                    else if (live.terminal || live.blocked || live.pending?.raidId == null) leave(model::returnHome) else confirmRetreat = true
                }, verb = if (ending) Verb.RED else Verb.STONE, icon = "close", enabled = !live.creating && !busy)
                Column(Modifier.heightIn(max = maxHeight / 3).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    notice?.message?.takeIf { it != entryRecovery.message }?.let { BattleLine(it, PkwTokens.Colors.danger) }
                    if (!live.connected && live.pending?.raidId != null) BattleLine(Copy.RAID_OFFLINE, PkwTokens.Colors.gold.hi)
                    if (domain.nextTargetIntent) SecondaryButton(Copy.RETRY_NEXT_TARGET, { confirmNextTarget = true }, enabled = !domain.retreating)
                    PendingBattleRecovery(live, recovery, stuckRequests, model, coordinator)
                }
            }
        if (live.pending == null && !live.creating && failure != null) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)).padding(unavailablePadding).verticalScroll(rememberScrollState())) {
                CreateFailurePanel(failure, constants, busy, onBack = model::returnHome, onRetry = model::retryCreate,
                    onWorldMap = { model.exitTo(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.Rivals)) }, onCampaign = { model.exitTo(HomeRequest.Campaign) }, onBuyLand = { model.exitTo(after = exits.onLand) }, energyBaseId = coordinator.baseId,
                    onEnergy = exits.onEnergy?.let { route -> { kind: String -> model.exitTo(HomeRequest.Tab(HomeTab.KINGDOM), after = { route(kind, coordinator.baseId) }); Unit } })
            }
        } else if (live.expired) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)).padding(unavailablePadding).verticalScroll(rememberScrollState()).padding(20.dp),
                verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Plate(PlateKind.CHARCOAL, Modifier.widthIn(max = 360.dp).fillMaxWidth()) {
                    Column(Modifier.padding(6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        PkwText("March expired", PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                        BattleDialogLine("The server closed this reservation before battle. Return Home to refresh your army and balances.")
                    }
                }
            }
        } else if (active != null && assets != null) {
            val playing = livePlaybackScene(active, playback.rendererPlayhead, live.phase, live.result != null, live.clock?.value?.rate?.toFloat() ?: 1f)
            val deployment=rememberDeployFeedback(model.feedbackIdentity,content.catalogue,assets,playing,
                ((content.renderCatalogue?.get("sensoryPolicy") as? JsonObject)?.get("eventHaptics") as? JsonObject)?.containsKey("deployment")==true)
            SideEffect { deployment?.restore(live,constants) }
            val admissionOpen = stagingInputAllowed && live.connected && !live.blocked && !live.terminal &&
                !domain.retreating && !domain.nextTargetIntent && !confirmRetreat && !confirmNextTarget
            val admission = remember(coordinator, raidId, assets, admissionOpen) { Any() }
            val inputPolicy = battleDeploymentMode(selection, live, constants, admissionOpen)?.copy(admission = admission)
            val inputMode = remember(inputPolicy) { inputPolicy?.let { it.copy(identity = "${it.identity}:${java.util.UUID.randomUUID()}") } }
            key(coordinator, raidId, assets) { SceneSurface(assets, playing.base, Modifier.fillMaxSize(), battle = playing, playbackKey = playback.clockKey, deployment=deployment,
                onCommandBodiesSubmitted = { value -> if(commandDraw!=null) commandTiming?.bodySubmitted(commandDraw,value) },
                onPresentationReady = { presented = it }, onPreparationRetry = { graphicsRetry = it }, openingTopBar = openingActions,
                coveredByParent = true, onOpeningFailure = { failed, retry -> fieldFailed = failed; fieldRetry = retry },
                deploymentMode = inputMode, deploymentAdmission = admission.takeIf { admissionOpen },
                cameraInsets = cameraInsetLatch.resolve(cameraEnvironment,
                    safeBattleCameraInsets(hudPixels, trayPixels, constraints.maxHeight), hudMeasure, trayMeasure), cameraControls = cameraControls, onBattleGround = { target, x, y ->
                val current = coordinator.state.value
                if (target.raidId != raidId || current.pending?.raidId != target.raidId) return@SceneSurface
                val chosen = target.kind to target.unit
                val ready = roster.contains(chosen) && when (chosen.first) { "deploy" -> current.available(chosen.second) > 0; "hero" -> !current.reserved("hero", "hero", chosen.second); else -> false }
                if (BuildConfig.DEBUG) android.util.Log.i("PKWBattle", "ground tap x=$x y=$y chosen=$chosen ready=$ready blocked=${live.blocked} terminal=${live.terminal} connected=${live.connected} phase=${live.phase}")
                if (ready && model.battle.stagingInputAllowed(coordinator) && !current.blocked && !current.terminal && current.connected && !domain.retreating && !domain.nextTargetIntent) {
                    val tx=floor(x).toInt();val ty=floor(y).toInt()
                    if (playing.base.battlefield?.legal(tx,ty) != true) return@SceneSurface
                    val inputTiming=coordinator.beginInputTiming()
                    haptic()
                    val marker=deployMarkerKey(chosen,tx,ty,constants)?.let {deployment?.mark(it)}
                    val action=model.deployAction(coordinator) {
                        marker?.enter()
                        when (chosen.first) {
                            "deploy" -> coordinator.deploy(chosen.second,tx,ty,marker,inputTiming)
                            "hero" -> coordinator.hero(chosen.second,tx,ty,marker,inputTiming)
                        }
                    }
                    if(action==null)marker?.actionFinished() else action.invokeOnCompletion {marker?.actionFinished()}
                }
            }) }
        }
        // Owner 2026-10-06 (no dark plate, the 220 ms fade through the scene colour): the player's own base dimmed, else the
        // wallpaper, with the honest indicator, then the fade through the target's ground colour. Same retry owner, same way out.
        val homePostcard = gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.slot.shown?.takeIf { card ->
            gg.pixelkingdomwars.nativeclient.scene.postcardAdmitted(card.key, card.savedAtMs, postcardAccount, assets?.let { sceneHost?.tagFor(it) },
                coordinator.baseId, constraints.maxWidth, constraints.maxHeight, System.currentTimeMillis()) }
        BattleSceneCover(live = !opening, fieldPresented = presented, ground = battleGround, postcard = homePostcard,
            cause = entryRecovery.message ?: if (fieldFailed) "Couldn’t open the battlefield" else "Entering battle…",
            failed = entryRecovery.message != null || fieldFailed, onRetry = retryEntry ?: fieldRetry, route = "battle",
            topBar = openingActions)
        if (active != null && assets != null && !live.expired && live.result == null && presented) BattleCameraRail(cameraControls, content.catalogue, this.maxWidth, this.maxHeight, hudPixels, trayPixels)
        // Unready gameplay chrome can cover recovery in short landscape and expose spending
        // controls before the field exists. Opening keeps the original receipt/exit paths only.
        if (!opening && live.result == null) {
        val designedHud = liveBattleHudUi(live, content.catalogue, selection,
            stagingInputAllowed && !domain.retreating && !domain.nextTargetIntent,
            playback.playhead, live.clock?.value?.durationMs, deployTimer,
            live.result?.string("stars")?.toIntOrNull() ?: shownStars,
            live.result?.string("destructionPct")?.toIntOrNull() ?: shownDestroyed,
            deploymentHint, if (live.terminal) Copy.HOME else if (live.blocked) Copy.BACK_TO_BASE else "END",
            if (live.terminal || live.blocked) !busy else !live.creating)
            // The HUD's own END confirm (battle-hud.png); its sentence is the existing server-rule wording, because the
            // frame's own line is marked unconfirmed. CONFIRMING… holds both buttons while the retreat is sent.
            .copy(endConfirmShown = confirmRetreat, endConfirmLine = Copy.RETREAT_BODY,
                endConfirmEnabled = live.pending?.raidId != null && !live.blocked && !domain.retreating,
                endConfirmBusyText = if (domain.retreating) Copy.CONFIRMING else null)
        val designedActions = BattleHudActions(
            onSelect = { id ->
                val current = coordinator.state.value
                if (model.battle.stagingInputAllowed(coordinator) && current.connected && !current.blocked && !current.terminal)
                    liveBattleHudSelection(current, id)?.let { selection = it }
            },
            onHeroAbility = {}, // This raid owner has no ability endpoint; a sent hero's card explains itself via onRefused.
            onLeave = { if (live.terminal || live.blocked) leave(model::returnHome) else confirmRetreat = true },
            onRequestEnd = { if (live.terminal || live.blocked) leave(model::returnHome) else confirmRetreat = true },
            // The same retreat owner and guards the opening path's BattleDecisionDialog uses (it serves only that path).
            onConfirmEnd = { if (live.pending?.raidId != null && !live.blocked && !domain.retreating) { confirmRetreat = false; model.retreat() } },
            onCancelEnd = { if (!domain.retreating) confirmRetreat = false },
            onRefused = model::buffNotice)

        Column(Modifier.align(Alignment.TopStart).widthIn(max = 720.dp).fillMaxWidth().battleChromeMeasured(cameraEnvironment) { hudMeasure = it }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            ) {
        if (live.pending != null && !live.expired) {
            BattleHudOverlay(designedHud, designedActions, BattleHudRegion.TOP)
            LiveBattleHudHint(deploymentHint)
            if (live.terminal) LiveBattleHudTools(listOf(LiveBattleHudTool(Copy.HOME, !busy, { leave(model::returnHome) })))
        } else BattleOpeningStatus(if (live.creating) { if (domain.lastTarget is RaidCreateTarget.Campaign) Copy.PREPARING_CAMPAIGN else Copy.FINDING_TARGET } else "BATTLE",
            busy = live.creating) {
            if (!live.creating) SecondaryButton(Copy.BACK_TO_BASE, model::returnHome, icon = "close", enabled = !busy)
        }
        // A blocking coordinator error, repository order errors (a retired build, a base switch, a refused start) and screen notices surface here.
        battleErrorLines(live, domain.error, notice?.message, createFailed = failure != null).forEach { BattleLine(it, PkwTokens.Colors.danger, Modifier.padding(horizontal = 16.dp).blockSceneInput()) }
        if (live.phase == BattlePhase.STAGING && domain.stagingReservation.canRetry) {
            if (domain.stagingReservation == StagingReservationStatus.WINDOW_CLOSED) {
                BattleLine("Retreat to choose another battle, or check its status.", PkwTokens.Colors.text, Modifier.padding(horizontal = 16.dp).blockSceneInput())
            }
            SecondaryButton(if (domain.stagingReservation == StagingReservationStatus.FAILED) "CHECK CONNECTION" else "CHECK STATUS",
                { model.checkReservation(coordinator) }, Modifier.padding(horizontal = 8.dp), verb = Verb.BLUE)
        }
        val battlefieldRetry = (if (activeScene != null) playback.error?.let { playback.retry } else null) ?: graphicsRetry
        if (battlefieldRetry != null) Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BattleLine("Couldn’t update the battlefield.", PkwTokens.Colors.text, Modifier.weight(1f, fill = false).blockSceneInput())
            SecondaryButton("TRY AGAIN", battlefieldRetry, verb = Verb.BLUE)
        }
        if (!live.connected && live.pending?.raidId != null) BattleLine(Copy.RAID_OFFLINE, PkwTokens.Colors.gold.hi, Modifier.padding(horizontal = 16.dp).blockSceneInput())
        }
        Column(Modifier.align(Alignment.BottomStart).widthIn(max = 720.dp).fillMaxWidth().battleChromeMeasured(cameraEnvironment) { trayMeasure = it }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
            ) {
        if (!live.terminal && live.pending != null) {
            BattleHudOverlay(designedHud, designedActions, BattleHudRegion.BOTTOM, compact = shortLandscape)
            LiveBattleHudTools(buildList {
                val rate = live.clock?.value?.rate
                if (live.phase == BattlePhase.RUNNING && rate != null) add(LiveBattleHudTool("SPEED ${rate}×",
                    live.connected && !live.blocked, { model.action { coordinator.speed(if (rate == 1) 2 else 1) }; Unit }))
                if (live.canChooseNextTarget || domain.nextTargetIntent) {
                    add(LiveBattleHudTool(if (domain.retreating) Copy.CONFIRMING else if (domain.nextTargetIntent) Copy.RETRY_NEXT_TARGET else Copy.NEXT_TARGET,
                        !domain.retreating, { confirmNextTarget = true }))
                } else {
                    val unlock = constants?.get("RALLY")?.jsonObject?.string("unlockKeepLevel")?.toIntOrNull()
                    val rallyUsed = live.reserved("rally")
                    val snapshot = live.presentation?.get("snapshot") as? JsonObject
                    val grid = constants?.get("GRID") as? JsonObject
                    val minimum = snapshot?.string("claimMin")?.toIntOrNull() ?: grid?.string("deployRingTiles")?.toIntOrNull()
                    val maximum = snapshot?.string("claimMax")?.toIntOrNull() ?: grid?.string("claimTiles")?.toIntOrNull()?.let { width -> minimum?.let { it + width } }
                    val ready = unlock != null && keepLevel >= unlock && minimum != null && maximum != null && live.connected && !live.blocked && live.phase == BattlePhase.RUNNING && !rallyUsed
                    add(LiveBattleHudTool(if (rallyUsed) "RALLY SET" else if (unlock != null && keepLevel < unlock) "RALLY K$unlock" else "RALLY RDY", ready, {
                        val centre = floor((requireNotNull(minimum).toDouble() + requireNotNull(maximum)) / 2).toInt()
                        model.action { coordinator.rally(centre, centre) }; Unit
                    }))
                }
                if (live.phase == BattlePhase.STAGING) add(LiveBattleHudTool("START ATTACK",
                    stagingInputAllowed && live.connected && !live.blocked && !domain.retreating && !domain.nextTargetIntent,
                    { model.stagingAction(coordinator) { coordinator.start() }; Unit }, Verb.RED))
                if (live.phase == BattlePhase.RUNNING) add(LiveBattleHudTool("CHECK RESULT", live.connected && !live.blocked, {
                    if (live.unresolvedFinish != null) model.checkEntry(coordinator) else model.action { coordinator.finish() }; Unit
                }))
                val buffs = constants?.get("BUFFS") as? JsonObject
                BUFF_LABELS.forEach { (key, label) ->
                    val cost = (buffs?.get(key) as? JsonObject)?.string("costKeep") ?: return@forEach
                    val on = live.reserved("buff", "buff", key)
                    val committed = battleTroopsCommitted(live)
                    val interactive = live.phase == BattlePhase.STAGING
                    add(LiveBattleHudTool("$label · ${if (on) "ACTIVE" else "$cost KEEP"}",
                        interactive && stagingInputAllowed && !live.blocked && live.connected && !domain.retreating && !domain.nextTargetIntent,
                        { if (!on) { if (committed) model.buffNotice(Copy.CHOOSE_BUFFS_FIRST) else model.stagingAction(coordinator) { coordinator.buff(key) } }; Unit },
                        if (on) Verb.GOLD else Verb.STONE))
                }
            })
        }
        }
        // A stuck order's recovery floats above the tray, outside both measured columns: showing or clearing it can
        // move neither a troop card under the player's thumb nor the chrome heights the camera was framed against.
        Column(Modifier.align(Alignment.BottomStart).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
            .padding(bottom = unavailablePadding.calculateBottomPadding()).widthIn(max = recoveryWidth)) {
            PendingBattleRecovery(live, recovery, stuckRequests, model, coordinator)
        }
        // Composed last so the confirm and its scrim sit over every HUD part and keep taps off the scene while it asks.
        if (hudConfirm) BattleHudEndConfirmLayer(designedHud, designedActions)
        }
        // The designed result (result.png / result-defeat.png) over the parked battle, composed last so it covers the HUD
        // remnants and recovery; its full-card ModalScrim keeps every tap off the scene. Every number is the server
        // result's (battleResultV2Ui). rememberLiveResult still owns the result sounds and haptics, so the card's own
        // sensory hooks stay at their no-op defaults and no cue plays twice; the card draws its own rays, so
        // ResultDecorations is not composed. RaidResultPanel stays for no live caller: it is off this path.
        live.result?.let { result ->
            val target = domain.lastTarget
            val nextLabel = when (target) {
                is RaidCreateTarget.Campaign -> {
                    val stages = (constants?.get("CAMPAIGN") as? JsonObject)?.get("tierByStage")?.let { it as? JsonArray }?.size
                    if (stages != null && target.stage >= stages) Copy.CAMPAIGN_MAP else Copy.NEXT_STAGE
                }
                else -> "NEXT" // result.png's door caption; raidAgain starts the next automatic match.
            }
            Box(Modifier.fillMaxSize()) {
                BattleResultCardV2(battleResultV2Ui(result, target, nextLabel, live, content.catalogue, busy), BattleResultV2Actions(
                    onHome = { leave(model::returnHome) },
                    onNext = { leave(model::raidAgain) },
                    // SPEC: RETRAIN → Army(TRAIN). A queued HomeRequest.Training opens the Army sheet on TRAIN once Home
                    // mounts (PkwApp's army request effect; ArmyLiveHost consumes it), the composer's own entry.
                    onRetrain = { leave { model.exitTo(HomeRequest.Training) } },
                    // The saved replay is reached through the raid log (the old result's RAID LOG exit).
                    onReplay = { _ -> leave { model.exitTo(HomeRequest.Tab(HomeTab.ATTACK)) } },
                    onRefused = { door -> door.reason?.let(model::buffNotice) }), Modifier.fillMaxSize())
                // A door whose order failed (NEXT with no march to repeat, a refused create) says why here, over the card.
                notice?.message?.let { message ->
                    Plate(PlateKind.VEIL, Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = 160.dp),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), blocksScene = false) {
                        PkwText(message, PkwTokens.Type.body, color = PkwTokens.Colors.text, outline = 1.dp, textAlign = TextAlign.Center, maxLines = 3)
                    }
                }
            }
        }
    }
    }
    }
}

/** The same durable commands remain recoverable while the first scene is still opening. */
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun PendingBattleRecovery(live: LiveBattleState, recovery: BattleRecoverySummary, stuck: Set<String>, model: BattleViewModel, coordinator: BattleCoordinator) {
    val unresolved = recovery.unresolved(stuck).size
    var expanded by remember(coordinator, live.pending?.raidId) { mutableStateOf(false) }
    var confirmDiscard by remember(coordinator) { mutableStateOf<String?>(null) }
    LaunchedEffect(unresolved == 0) { if (unresolved == 0) expanded = false }
    // Orders queued behind the journal or being sent show nothing (see BattleRecoverySummary.unresolved); only a stuck one does.
    // Kit controls and the designed decision dialog (the old dark AlertDialogs are off the battle path); the same strings,
    // guards and owner calls as before.
    if (unresolved > 0) {
        SecondaryButton("$unresolved WAITING · DETAILS", { expanded = true }, Modifier.blockSceneInput(), verb = Verb.BLUE,
            contentDescription = "$unresolved awaiting confirmation · Details")
        if (expanded) BattleDecisionDialog("BATTLE REQUESTS", onDismiss = { expanded = false }, body = {
            recovery.requests.forEachIndexed { index, request ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    BattleDialogLine("${index + 1}. ${if (request == live.pending?.create) "Raid request" else "Battle order"} · ${if (request.id in live.inFlight) "Sending…" else "Awaiting confirmation"}")
                    SecondaryButton("RETRY SAME REQUEST", { model.action { model.battle.retrySavedRequest(coordinator, request.id) } }, Modifier.fillMaxWidth(),
                        verb = Verb.BLUE, enabled = !live.blocked && request.id !in live.inFlight, contentDescription = "Retry same request")
                    if (request == live.pending?.create) SecondaryButton("DISCARD SAVED REQUEST", { confirmDiscard = request.id }, Modifier.fillMaxWidth(),
                        enabled = !live.blocked && request.id !in live.inFlight, contentDescription = "Discard saved request")
                }
            }
        }) {
            SecondaryButton("CLOSE", { expanded = false }, Modifier.weight(1f), contentDescription = "Close")
        }
    }
    // D153.333 (d): one tap must not forget a request the server may have committed; "Keep it" changes nothing on the device.
    confirmDiscard?.let { id -> BattleDecisionDialog("Discard the saved raid request?", onDismiss = { confirmDiscard = null },
        body = { BattleDialogLine("The server has not confirmed this request. Discarding forgets it on this device only; a raid the server did create still appears as an unfinished raid you can resume.") }) {
        SecondaryButton("KEEP IT", { confirmDiscard = null }, Modifier.weight(1f), contentDescription = "Keep it")
        SecondaryButton("DISCARD", { confirmDiscard = null; expanded = false; model.discardSavedRequest(coordinator, id) }, Modifier.weight(1f), verb = Verb.RED, contentDescription = "Discard")
    } }
    if (live.pending == null) live.candidates.forEach { raid ->
        SecondaryButton("RESUME RAID ${raid.string("campaignStage") ?: ""}".trim(), { model.action { coordinator.resumeRaid(requireNotNull(raid.string("id"))) } },
            Modifier.blockSceneInput(), verb = Verb.BLUE)
    }
}

/** The waiting requests that have stayed unsent and unacknowledged for [STUCK_BATTLE_REQUEST_MS], on the device's
 * monotonic clock. One tracker per battle, shared by the opening bar and the tray overlay. */
@Composable private fun rememberStuckBattleRequests(coordinator: BattleCoordinator, raidId: String?, waiting: List<String>): Set<String> {
    val tracker = remember(coordinator, raidId) { BattleStuckRequests() }
    var stuck by remember(tracker) { mutableStateOf(emptySet<String>()) }
    LaunchedEffect(tracker, waiting) {
        while (true) {
            val now = android.os.SystemClock.elapsedRealtime()
            val next = tracker.observe(waiting, now)
            stuck = tracker.stuck(now)
            kotlinx.coroutines.delay(next ?: break)
        }
    }
    return stuck
}

/** Source useTimerLabel: display the authoritative deploy deadline, without ordering or expiring a battle. */
@Composable private fun rememberDeploymentTimer(deadlineMs: Long?): String {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var now by remember(deadlineMs) { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(deadlineMs, lifecycle) {
        if (deadlineMs == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) { now = System.currentTimeMillis(); kotlinx.coroutines.delay(250) }
        }
    }
    if (deadlineMs == null) return "DEPLOY"
    val seconds = ((deadlineMs.toDouble() - now.toDouble()) / 1000).roundToLong().coerceAtLeast(0)
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}

/** Web RaidUI's `!raid && err` panel: the deedless empty pool replaces the red line with the honest landing; every
 * other refusal shows the server's line verbatim with the exits its own advice names. */
@Composable private fun CreateFailurePanel(failure: RaidCreateFailure, constants: JsonObject?, busy: Boolean, onBack: () -> Unit, onRetry: () -> Unit,
                                           onWorldMap: () -> Unit, onCampaign: () -> Unit, onBuyLand: () -> Unit, energyBaseId: String, onEnergy: ((String) -> Unit)?) {
    // One charcoal plate with kit text and buttons (no Material text or buttons on the battle path); the same strings,
    // exits and owners as before. The energy rows only open the existing purchase review.
    Column(Modifier.fillMaxWidth().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    Plate(PlateKind.CHARCOAL, Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
    Column(Modifier.padding(6.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (failure.pool == "deedless") {
            PkwText(Copy.NO_SETTLERS_TITLE, PkwTokens.Type.title, color = PkwTokens.Colors.gold.hi, outline = 1.dp, maxLines = 2)
            PkwText(Copy.NO_SETTLERS_WHY, PkwTokens.Type.body, color = PkwTokens.Colors.muted, maxLines = 8)
            SecondaryButton(Copy.PLAY_CAMPAIGN, onCampaign, Modifier.fillMaxWidth(), verb = Verb.RED, enabled = !busy)
            // The price is the catalogue's `ECONOMY.entryFeeSol`; a pack without it cannot state a number.
            (constants?.get("ECONOMY") as? JsonObject)?.string("entryFeeSol")?.let { fee ->
                SecondaryButton(Copy.buyYourLand(fee), onBuyLand, Modifier.fillMaxWidth(), enabled = !busy)
            }
        } else PkwText(failure.message.ifBlank { "That keep can't be raided right now — pick another target" }, PkwTokens.Type.body,
            color = PkwTokens.Colors.danger, maxLines = 8)
        if (failure.outOfEnergy && constants != null && onEnergy != null) {
            for (kind in listOf("energy_pack", "energy")) energyPurchaseOffer(constants, energyBaseId, kind)?.let { offer ->
                val label = "+${offer.energyQuantity} ENERGY · ${gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseSol(offer.amountLamports)} SOL"
                SecondaryButton(label, { onEnergy(kind) }, Modifier.fillMaxWidth(), verb = if (kind == "energy_pack") Verb.BLUE else Verb.STONE,
                    icon = "energy", enabled = !busy)
            }
            BattleDialogLine("Review the energy purchase, then choose Attack separately when you return Home.")
        }
        if (failure.pool == "ladder") {
            SecondaryButton(Copy.WORLD_MAP, onWorldMap, Modifier.fillMaxWidth(), verb = Verb.BLUE, icon = "map", enabled = !busy)
            SecondaryButton(Copy.CAMPAIGN, onCampaign, Modifier.fillMaxWidth(), icon = "star", enabled = !busy)
        }
        if (failure.retryable) SecondaryButton(Copy.TRY_AGAIN, onRetry, Modifier.fillMaxWidth(), verb = Verb.BLUE, enabled = !busy)
        SecondaryButton(Copy.BACK_TO_BASE, onBack, Modifier.fillMaxWidth(), icon = "close", enabled = !busy)
    }
    }
    }
}

/** [playhead] is the server clock (countdown, clock-due finish); [shown] and [rendererPlayhead] are the field's time, a
 * held lag behind it (livePresentationLagMs, owner 2026-10-11): the HUD's stars and destruction follow what the field shows. */
private class BattlePlayback(val scene: PreparedLiveBattle?, val error: String?, val playhead: Double, val shown: Double, val clockKey: Int, val rendererPlayhead: Double, val retry: () -> Unit)

/** The canonical playhead, the prepared scene and its replacement rules shared by the attacker's and the spectator's views. */
@Composable private fun rememberBattlePlayback(key: Any, expectedRaidId: String?, live: LiveBattleState, content: gg.pixelkingdomwars.nativeclient.data.ContentState, model: BattleViewModel,
    commandDraw: gg.pixelkingdomwars.nativeclient.diagnostics.LocalCommandDrawTiming? = null,
    preparationTiming: gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports.CommandLease? = null): BattlePlayback {
    var scene by remember(key, expectedRaidId) { mutableStateOf<PreparedLiveBattle?>(null) }
    var renderError by remember(key, expectedRaidId) { mutableStateOf<String?>(null) }
    var playhead by remember(key, expectedRaidId) { mutableDoubleStateOf(0.0) }
    var shown by remember(key, expectedRaidId) { mutableDoubleStateOf(0.0) }
    var lag by remember(key, expectedRaidId) { mutableStateOf<Double?>(null) }
    val currentClock by rememberUpdatedState(live.clock)
    var clockKey by remember(key, expectedRaidId) { mutableIntStateOf(0) }
    var preparationAttempt by remember(key, expectedRaidId) { mutableIntStateOf(0) }
    LaunchedEffect(key, expectedRaidId, live.clock, live.result, scene) { clockKey++ }
    // The renderer advances its own admitted smooth clock. Compose only needs a new
    // value at a canonical HUD tick, not another full battle/tray composition every vsync.
    LaunchedEffect(key, expectedRaidId, live.clock, live.result, scene?.scene?.tickDurationMs) {
        while (isActive) withFrameNanos {
            val now = System.nanoTime()
            playhead = battleHudPlayhead(live.clock?.playheadMs(now) ?: 0.0, scene?.scene?.tickDurationMs)
            shown = battleHudPlayhead(liveShownPlayheadMs(live.clock, now, lag, scene), scene?.scene?.tickDurationMs)
        }
    }
    LaunchedEffect(key, expectedRaidId, live.presentation, live.result, live.expired, content.assets, content.catalogue,
        content.renderCatalogue, content.manifest?.contentVersion, live.clock == null, preparationAttempt) {
        if (live.expired || expectedRaidId == null) { scene = null; renderError = null; return@LaunchedEffect }
        val data = live.presentation ?: return@LaunchedEffect
        if (data.string("raidId") != expectedRaidId) { renderError = "The battlefield does not match this raid"; return@LaunchedEffect }
        val terminal = data.string("source") == "archive" || data.string("status") == "resolved"
        if (live.result != null && !terminal) return@LaunchedEffect
        if (!terminal && scene == null && live.clock == null) return@LaunchedEffect
        val mappingKey = liveBattleMappingKey(data, content, preparationAttempt) ?: return@LaunchedEffect
        val preparationOrdinal = data.string("_clientPreparationOrdinal")?.toLongOrNull()
        retainedLiveMapping(scene, mappingKey)?.let { retained ->
            // Reconnects still update the coordinator's authoritative clock and receipts.
            // Keep the exact prepared scene, including its ColdPrefix and diagnostic plans.
            if (preparationOrdinal != retained.preparationOrdinal) runCatching {
                preparationOrdinal?.let { preparationTiming?.reusePreparation(it, mappingKey.revision) }
            }
            renderError = null
            return@LaunchedEffect
        }
        val mapper = model.mapper(content) ?: return@LaunchedEffect
        renderError = null
        val preparationTrace = runCatching { data.string("_clientPreparationOrdinal")?.toLongOrNull()?.let {
            preparationTiming?.preparationTrace(it, data.string("revision").orEmpty())
        } }.getOrNull()
        try {
            val current = scene
            val shownMs = liveShownPlayheadMs(live.clock, System.nanoTime(), lag, current)
            val candidate = withContext(Dispatchers.Default) {
                preparationTrace.observe(LocalPreparationStage.MAPPER_STARTED)
                // This exact JsonObject is the coordinator's completed PresentationAssembly result.
                // Never correlate against live.commands (the independently arriving receipt union).
                val timing = runCatching { content.catalogue?.let { gg.pixelkingdomwars.nativeclient.diagnostics.commandCorrelationPolicy(it) }
                    ?.let { commandDraw?.prepare(expectedRaidId,data,it) } }.getOrNull()
                val mapped=mapper.liveScene(data) { ensureActive() }
                preparationTrace.observe(LocalPreparationStage.MAPPER_COMPLETED)
                prepareLiveStart(current, PreparedLiveBattle(mapped.copy(commandDrawPlan=timing?.plan, preparationTrace=preparationTrace), terminal, timing,
                    mappingKey, preparationOrdinal), shownMs)
            }
            val accepted = acceptLivePresentation(scene, candidate, live.result != null, expectedRaidId)
            if (accepted !== candidate) preparationTrace.end(LocalPreparationOutcome.SUPERSEDED)
            // Fixed in the same snapshot as the scene, so the field never opens this revision at server time.
            val clock = currentClock
            lag = livePresentationLagMs(lag, candidate.takeIf { accepted === it }, clock?.playheadMs(System.nanoTime()) ?: 0.0,
                clock?.value?.anchorWallAt != null)
            scene = accepted
            renderError = null
        } catch (error: CancellationException) { preparationTrace.end(LocalPreparationOutcome.CANCELLED); throw error } catch (error: Exception) { preparationTrace.end(LocalPreparationOutcome.FAILED); renderError = error.message?.takeIf { it.isNotBlank() } ?: "The battlefield could not be prepared" }
    }
    // Retry only remaps the retained canonical presentation; it never submits a battle command.
    return BattlePlayback(scene, renderError, playhead, shown, clockKey, liveShownPlayheadMs(live.clock, System.nanoTime(), lag, scene)) { preparationAttempt++ }
}

/** The defender's WATCH LIVE: the same canonical playback and HUD, without command controls. */
@Composable fun SpectatorBattleScreen(model: BattleViewModel, view: SpectatorView) {
    val spectator = view.spectator
    val live by spectator.state.collectAsState()
    val content by model.contentState.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(spectator, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(spectator) } }
    val playback = rememberBattlePlayback(spectator, spectator.raidId, live, content, model)
    var watchAgain by remember(spectator) { mutableStateOf(false) }
    // A complete authorized archive has the same frozen scene contract as a replay.
    // Only adapt its identity field; never replay the live prediction as a settled battle.
    val archive = remember(spectator, live.presentation, live.result) {
        archivedSpectatorReplay(live.presentation, live.result, spectator.raidId)
    }
    if (watchAgain && archive != null) {
        ReplayScreen(model, archive, onClose = model::closeSpectator)
        return
    }
    BackHandlerAt(BackPriority.BATTLE) { model.closeSpectator() }
    val activeScene = playback.scene?.scene
    val progressIndex = rememberBattleHudProgress(activeScene, content.catalogue)
    val tick = activeScene?.tickDurationMs?.let { floor(playback.shown / it).toFloat() } ?: 0f
    val progress = remember(progressIndex, tick) { progressIndex?.at(tick) }
    val cameraControls = rememberBattleCameraControls(spectator, content.catalogue)
    var hudPixels by remember(spectator) { mutableIntStateOf(0) }
    var footerPixels by remember(spectator) { mutableIntStateOf(0) }
    var presented by remember(spectator, content.assets) { mutableStateOf(false) }
    var graphicsRetry by remember(spectator, content.assets) { mutableStateOf<(() -> Unit)?>(null) }
    var fieldFailed by remember(spectator, content.assets) { mutableStateOf(false) }
    var fieldRetry by remember(spectator, content.assets) { mutableStateOf<(() -> Unit)?>(null) }
    val watchGround = rememberRealmGround(content.assets, playback.scene?.scene?.base?.visual)
    SceneInputScope {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val active = playback.scene; val assets = content.assets
        if (live.expired) Column(Modifier.fillMaxSize().padding(with(LocalDensity.current) { PaddingValues(top = hudPixels.toDp(), bottom = footerPixels.toDp()) })
            .verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.Center) {
            Text("The attacker's reservation expired before battle.")
        }
        else if (active != null && assets != null) {
            val playing = livePlaybackScene(active, playback.rendererPlayhead, live.phase, live.result != null, live.clock?.value?.rate?.toFloat() ?: 1f)
            key(assets) { SceneSurface(assets, playing.base, Modifier.fillMaxSize(), battle = playing, playbackKey = playback.clockKey, cameraInsets = safeBattleCameraInsets(hudPixels, footerPixels, constraints.maxHeight), cameraControls = cameraControls,
                onPresentationReady = { presented = it }, onPreparationRetry = { graphicsRetry = it }, openingTopBar = { OutlinedButton(onClick = model::closeSpectator) { Text("CLOSE") } },
                coveredByParent = true, onOpeningFailure = { failed, retry -> fieldFailed = failed; fieldRetry = retry }) }
        }
        // No dark shell (owner 2026-10-06): the wallpaper with the strip, then the fade through the field's ground colour.
        BattleSceneCover(live = live.expired || (active != null && assets != null && presented), fieldPresented = presented, ground = watchGround,
            postcard = null, cause = if (playback.error == null && !fieldFailed) "Opening the battle…" else "Couldn’t open the battlefield",
            failed = playback.error != null || fieldFailed, onRetry = if (playback.error != null) playback.retry else fieldRetry, route = "watch",
            topBar = { OutlinedButton(onClick = model::closeSpectator) { Text("CLOSE") } })
        if (active != null && assets != null && !live.expired && presented) BattleCameraRail(cameraControls, content.catalogue, this.maxWidth, this.maxHeight, hudPixels, footerPixels)
        if ((active != null && assets != null && presented) || live.expired) {
        Column(Modifier.align(Alignment.TopStart).widthIn(max = 720.dp).fillMaxWidth().onSizeChanged { hudPixels = it.height }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            ) {
        BattleHud(cameraControls = cameraControls, timer = if (live.phase == BattlePhase.RUNNING) battleTimeLabel(playback.playhead, live.clock?.value?.durationMs) else "LIVE",
            running = live.phase == BattlePhase.RUNNING, rate = live.clock?.value?.rate,
            stars = live.result?.string("stars")?.toIntOrNull() ?: progress?.first,
            destroyed = live.result?.string("destructionPct")?.toIntOrNull() ?: progress?.second,
            result = live.result, target = null, onEnd = model::closeSpectator, endEnabled = true, endLabel = "CLOSE",
            onRate = null, rateEnabled = false, buffs = { ReadOnlyBattleBuffs(live.presentation) })
        live.error?.let { Text(it, Modifier.padding(horizontal = 16.dp).blockSceneInput(), color = MaterialTheme.colorScheme.error) }
        if (activeScene != null) playback.error?.let { TextButton(onClick = playback.retry) { Text("Couldn’t update the battlefield. TRY AGAIN") } }
        graphicsRetry?.let { retry -> TextButton(onClick = retry) { Text("Couldn’t update the battlefield. TRY AGAIN") } }
        if (!live.connected && !live.blocked) Text(Copy.RAID_OFFLINE, Modifier.padding(horizontal = 16.dp).blockSceneInput(), color = Palette.gold)
        }
        Column(Modifier.align(Alignment.BottomStart).widthIn(max = 720.dp).fillMaxWidth().onSizeChanged { footerPixels = it.height }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
            ) {
        if (live.phase == BattlePhase.STAGING) BattlePill(Modifier.fillMaxWidth().padding(12.dp)) {
            Text("ATTACKER IS PREPARING · LIVE STREAM WILL START WITH THE FIRST DEPLOY", color = Palette.goldHi, fontSize = 14.sp)
        }
        live.result?.let { result ->
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("LIVE BATTLE SETTLED${if (result.flag("retreated")) " · RETREATED" else ""} · ${result.string("destructionPct") ?: "—"}% · ${result.string("stars") ?: "—"}★", color = Palette.muted, fontSize = 15.sp)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = { watchAgain = true }, enabled = archive != null, modifier = Modifier.weight(1f)) { Text(if (archive == null) "LOADING…" else "↻ WATCH AGAIN") }
                    Button(onClick = model::closeSpectator, modifier = Modifier.weight(1f)) { Text("CLOSE") }
                }
            }
        }
        }
        }
    }
    }
}

/** Native presentation commands are the authority for a read-only buff indicator. */
@Composable private fun ReadOnlyBattleBuffs(source: JsonObject?) {
    val commands = source?.get("commands") as? JsonArray
    BUFF_LABELS.forEach { (key, label) ->
        val on = commands?.any { row ->
            val command = row as? JsonObject
            command?.string("kind") == "buff" && (command?.get("payload") as? JsonObject)?.string("buff") == key
        } == true
        BattlePill(active = on, modifier = Modifier.alpha(if (on) 1f else .4f),
            description = "$label · ${if (on) "ACTIVE" else if (commands == null) "STATUS UNAVAILABLE" else "INACTIVE"}") {
            GameArt("ui_icon_$key", Modifier.size(20.dp))
        }
    }
}

/** Scout HUD (web `ScoutHud`) over a read-only snapshot: the target's name, keep level and trophies, a countdown from
 * the preview window the source names (the catalogue's `RAID_RULES.scoutPreviewSec` for a stage, the server's
 * `previewSec` for a player), explicit ATTACK and CLOSE. Android back closes it (priority 120). */
@OptIn(ExperimentalLayoutApi::class)
@Composable fun ScoutScreen(model: BattleViewModel, preview: ScoutPreview, onClose: () -> Unit) {
    val content by model.contentState.collectAsState()
    val domain by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    var scene by remember(preview) { mutableStateOf<BattleScene?>(null) }
    var error by remember(preview) { mutableStateOf<String?>(null) }
    var preparationAttempt by remember(preview) { mutableIntStateOf(0) }
    val previewSec = preview.previewSec
    var left by remember(preview) { mutableIntStateOf(previewSec ?: 0) }
    BackHandlerAt(BackPriority.SCOUT) { onClose() }
    LaunchedEffect(preview, content.renderCatalogue, preparationAttempt) {
        val mapper = model.mapper() ?: return@LaunchedEffect
        val sim = model.content.simVersion() ?: return@LaunchedEffect
        error = null
        try { scene = withContext(Dispatchers.Default) { when (preview) {
            is CampaignPreview -> mapper.previewScene(preview.head.raw, sim)
            is TargetScout -> mapper.scoutScene(preview.head.raw, preview.baseId ?: preview.wallet, sim)
        } } } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "Stronghold preview unavailable" }
    }
    LaunchedEffect(preview, previewSec) {
        if (previewSec == null || previewSec <= 0) return@LaunchedEffect
        left = previewSec
        while (left > 0) { kotlinx.coroutines.delay(1_000); left-- }
        onClose()
    }
    val cameraControls = rememberBattleCameraControls(preview, content.catalogue)
    var cameraDetails by remember(preview) { mutableStateOf(false) }
    var hudPixels by remember(preview) { mutableIntStateOf(0) }
    var footerPixels by remember(preview) { mutableIntStateOf(0) }
    var presented by remember(preview, content.assets) { mutableStateOf(false) }
    var graphicsRetry by remember(preview, content.assets) { mutableStateOf<(() -> Unit)?>(null) }
    var fieldFailed by remember(preview, content.assets) { mutableStateOf(false) }
    var fieldRetry by remember(preview, content.assets) { mutableStateOf<(() -> Unit)?>(null) }
    val scoutGround = rememberRealmGround(content.assets, scene?.base?.visual)
    SceneInputScope {
        BoxWithConstraints(Modifier.fillMaxSize()) {
                val ready = scene; val assets = content.assets
            if (ready != null && assets != null) {
                SceneSurface(assets, ready.base, Modifier.fillMaxSize(), battle = ready,
                    cameraInsets = safeBattleCameraInsets(hudPixels, footerPixels, constraints.maxHeight), cameraControls = cameraControls,
                    onPresentationReady = { presented = it }, onPreparationRetry = { graphicsRetry = it }, openingTopBar = { SecondaryButton(Copy.SCOUT_CLOSE, onClose, icon = "close") },
                    coveredByParent = true, onOpeningFailure = { failed, retry -> fieldFailed = failed; fieldRetry = retry })
                if (presented) BattleCameraRail(cameraControls, content.catalogue, this.maxWidth, this.maxHeight, hudPixels, footerPixels)
            }
            // No dark plate (owner 2026-10-06): the wallpaper with the strip, then the fade through the stronghold's ground colour.
            BattleSceneCover(live = ready != null && assets != null && presented, fieldPresented = presented, ground = scoutGround, postcard = null,
                cause = if (error == null && !fieldFailed) "Scouting the kingdom…" else "Couldn’t open this preview",
                failed = error != null || fieldFailed, onRetry = if (error != null) ({ preparationAttempt++; Unit }) else fieldRetry, route = "scout",
                topBar = { SecondaryButton(Copy.SCOUT_CLOSE, onClose, icon = "close") })
            if (ready != null && assets != null && presented) {
            gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ScoutLiveOverlay(
                preview = preview, current = domain.preview, catalogue = content.catalogue,
                busy = busy, loading = domain.loading, secondsLeft = if (previewSec == null) null else left,
                message = notice?.message ?: domain.error, graphicsRetry = graphicsRetry,
                onAttack = {
                    if (gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.scoutLiveCanAttack(
                            preview, model.state.value.preview, model.busy.value, model.state.value.loading,
                            if (previewSec == null) null else left)) model.attackPreview(preview)
                },
                onClose = onClose, onCamera = { cameraDetails = true },
                onHeaderMeasured = { hudPixels = it }, onFooterMeasured = { footerPixels = it })
            // The camera tools in the designed decision dialog with kit buttons (the old dark dialog is off the scout path).
            if (cameraDetails) BattleDecisionDialog("PREVIEW CAMERA", onDismiss = { cameraDetails = false }, body = {
                SecondaryButton("ZOOM IN", cameraControls::zoomIn, Modifier.fillMaxWidth(), enabled = cameraControls.zoomStep != null)
                SecondaryButton("ZOOM OUT", cameraControls::zoomOut, Modifier.fillMaxWidth(), enabled = cameraControls.zoomStep != null)
                SecondaryButton("FIT FIELD", cameraControls::fit, Modifier.fillMaxWidth())
            }) {
                SecondaryButton("DONE", { cameraDetails = false }, Modifier.weight(1f), verb = Verb.BLUE)
            }
            }
        }
    }
}

/** Archived replay with the Continuous presentation start; playback controls only, no orders. */
@Composable fun ReplayScreen(model: BattleViewModel, replay: JsonObject, preview: Boolean = false, onClose: () -> Unit) {
    val content by model.contentState.collectAsState()
    ReplayScreen(content, replay, preview, onClose)
}

/** The offline fixture uses this same read-only presentation without creating an account graph. */
@Composable internal fun ReplayScreen(content: gg.pixelkingdomwars.nativeclient.data.ContentState, replay: JsonObject,
    preview: Boolean = false, onClose: () -> Unit) {
    var ready by remember(replay) { mutableStateOf<BattleScene?>(null) }
    var error by remember(replay) { mutableStateOf<String?>(null) }
    var preparationAttempt by remember(replay) { mutableIntStateOf(0) }
    var extent by remember(replay) { mutableStateOf<BattlePlaybackExtent?>(null) }
    var shownTick by remember(replay) { mutableFloatStateOf(0f) }
    var controlKey by remember(replay) { mutableIntStateOf(0) }
    var playback by remember(replay) { mutableStateOf(true) }
    var replayRate by remember(replay) { mutableIntStateOf(1) }
    var seek by remember(replay) { mutableFloatStateOf(0f) }
    var retainTick by remember(replay) { mutableStateOf(false) }
    BackHandlerAt(BackPriority.BATTLE) { onClose() }
    LaunchedEffect(replay, content.catalogue, content.renderCatalogue, preparationAttempt) {
        val catalogue = content.catalogue ?: return@LaunchedEffect
        val renderCatalogue = content.renderCatalogue ?: return@LaunchedEffect
        val mapper = SceneMapper(catalogue, renderCatalogue, gg.pixelkingdomwars.nativeclient.ui.kingdom.visualLog)
        error = null
        try { ready = withContext(Dispatchers.Default) { mapper.replayScene(replay) } }
        catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "This replay cannot be presented yet" }
    }
    val scene = ready
    val progressIndex = rememberBattleHudProgress(scene, content.catalogue)
    val progressTick = floor(shownTick).toFloat()
    val progress = remember(progressIndex, progressTick) { progressIndex?.at(progressTick) }
    val ended = extent?.let { shownTick >= it.visualEndTick } == true
    val result = replay["result"] as? JsonObject
    val durationMs = ((content.catalogue?.get("constants") as? JsonObject)?.get("RAID_RULES") as? JsonObject)?.string("battleDurationSec")?.toLongOrNull()?.let { it * 1000 }
    fun restart() { shownTick = 0f; seek = 0f; retainTick = false; playback = true; controlKey++ }
    val cameraControls = rememberBattleCameraControls(replay, content.catalogue)
    var hudPixels by remember(replay) { mutableIntStateOf(0) }
    var footerPixels by remember(replay) { mutableIntStateOf(0) }
    var presented by remember(replay, content.assets) { mutableStateOf(false) }
    var graphicsRetry by remember(replay, content.assets) { mutableStateOf<(() -> Unit)?>(null) }
    var fieldFailed by remember(replay, content.assets) { mutableStateOf(false) }
    var fieldRetry by remember(replay, content.assets) { mutableStateOf<(() -> Unit)?>(null) }
    val replayGround = rememberRealmGround(content.assets, scene?.base?.visual)
    SceneInputScope {
        BoxWithConstraints(Modifier.fillMaxSize()) {
                val assets = content.assets
            if (scene != null && assets != null) {
                val playingScene = remember(scene, playback, seek, retainTick, replayRate) { scene.copy(playing = playback, playheadTick = seek, retainPlaybackTick = retainTick, rate = replayRate.toFloat()) }
                SceneSurface(assets, playingScene.base, Modifier.fillMaxSize(), battle = playingScene, playbackKey = controlKey,
                    retainedPlaybackRate = replayRate.toFloat(), cameraInsets = safeBattleCameraInsets(hudPixels, footerPixels, constraints.maxHeight), cameraControls = cameraControls, performance = preview,
                    onPresentationReady = { presented = it }, onPreparationRetry = { graphicsRetry = it }, openingTopBar = { OutlinedButton(onClick = onClose) { Text("CLOSE") } },
                    coveredByParent = true, onOpeningFailure = { failed, retry -> fieldFailed = failed; fieldRetry = retry }, onFrame = { frame ->
                    if (!frame.matches(scene)) return@SceneSurface
                    extent = frame.extent
                    shownTick = frame.playheadTick
                    if (BuildConfig.DEBUG && preview && playback && frame.playheadTick >= frame.extent.visualEndTick) { shownTick = 0f; seek = 0f; retainTick = false; controlKey++ }
                })

            }
            // No dark shell (owner 2026-10-06): the wallpaper with the strip, then the fade through the field's ground colour.
            BattleSceneCover(live = scene != null && assets != null && presented, fieldPresented = presented, ground = replayGround, postcard = null,
                cause = if (error == null && !fieldFailed) "Opening the replay…" else "Couldn’t open this replay",
                failed = error != null || fieldFailed, onRetry = if (error != null) ({ preparationAttempt++; Unit }) else fieldRetry, route = "replay",
                topBar = { OutlinedButton(onClick = onClose) { Text("CLOSE") } })
            if (scene != null && assets != null && presented) {
            MeasuredBattleChrome(footer = {
                Column(Modifier.widthIn(max = 720.dp).fillMaxWidth().onSizeChanged { footerPixels = it.height }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
                    .padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (ended) BattlePill {
                        Text("REPLAY ENDED · ${result?.string("destructionPct") ?: result?.string("destruction") ?: "—"}% · ${result?.string("stars") ?: "—"}★", color = Palette.text, fontSize = 15.sp)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (!ended) Button(onClick = { retainTick = true; playback = !playback; controlKey++ }, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp)) { Text(if (playback) "PAUSE" else "PLAY") }
                        OutlinedButton(onClick = ::restart, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp)) { Text(if (ended) "↻ WATCH AGAIN" else "↻ RESTART") }
                        if (ended) Button(onClick = onClose, modifier = Modifier.weight(1f)) { Text("CLOSE") }
                        else OutlinedButton(enabled = extent != null, onClick = { seek = requireNotNull(extent).visualEndTick; retainTick = false; playback = false; controlKey++ },
                            modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp)) { Text("RESULT") }
                    }
                }
            }, rail = { top, bottom ->
                BattleCameraRail(cameraControls, content.catalogue, this@BoxWithConstraints.maxWidth, this@BoxWithConstraints.maxHeight, top, bottom)
            }, header = {
            Column(Modifier.widthIn(max = 720.dp).fillMaxWidth().onSizeChanged { hudPixels = it.height }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                ) {
            BattleHud(cameraControls = cameraControls, timer = if (ended || scene == null) "REPLAY" else battleTimeLabel(shownTick.toDouble() * (scene?.tickDurationMs ?: 0f), durationMs),
                running = !ended && scene != null, rate = replayRate,
                stars = if (ended) result?.string("stars")?.toIntOrNull() ?: progress?.first else progress?.first,
                destroyed = if (ended) result?.string("destructionPct")?.toIntOrNull() ?: progress?.second else progress?.second,
                result = result, target = null, onEnd = onClose, endEnabled = true, endLabel = "CLOSE",
                onRate = if (scene != null && !ended) ({ replayRate = if (replayRate == 1) 2 else 1; retainTick = true; controlKey++ }) else null,
                rateEnabled = scene != null && !ended, buffs = { ReadOnlyBattleBuffs(replay) })
            graphicsRetry?.let { retry -> TextButton(onClick = retry) { Text("Couldn’t update the replay. TRY AGAIN") } }
            }
            })
            }
        }
    }
}

@Composable private fun rememberBattleCameraControls(identity: Any, catalogue: JsonObject?): SceneCameraControls {
    val step = (((catalogue?.get("constants") as? JsonObject)?.get("RAID_CAMERA") as? JsonObject)?.get("zoomStep") as? JsonPrimitive)
        ?.floatOrNull?.takeIf { it.isFinite() && it > 1f }
    return remember(identity, step) { SceneCameraControls(step) }
}

/** Controls include their vertical safe padding in measured heights; the scene still fills the display. */
@Composable private fun safeBattleCameraInsets(top: Int, bottom: Int, height: Int): CameraInsets {
    val safe = WindowInsets.safeDrawing
    val density = LocalDensity.current
    val direction = androidx.compose.ui.platform.LocalLayoutDirection.current
    return CameraInsets(left = safe.getLeft(density, direction), right = safe.getRight(density, direction),
        top = maxOf(top, safe.getTop(density)).coerceAtMost(height / 3), bottom = maxOf(bottom, safe.getBottom(density)).coerceAtMost(height / 3))
}

/** Reports a live-battle chrome column's height from every measure pass, tagged with the environment that pass was
 * composed under. onSizeChanged cannot carry that: it stays silent when a new raid, viewport or safe area leaves the
 * height unchanged, and then nothing says the old number is this layout's. A changed environment is a changed
 * modifier element, which remeasures the column, so its first report under the new environment is that environment's own. */
private fun Modifier.battleChromeMeasured(environment: BattleCameraEnvironment, report: (BattleChromeMeasure) -> Unit) =
    this then BattleChromeMeasuredElement(environment, report)
private data class BattleChromeMeasuredElement(val environment: BattleCameraEnvironment, val report: (BattleChromeMeasure) -> Unit) : ModifierNodeElement<BattleChromeMeasuredNode>() {
    override fun create() = BattleChromeMeasuredNode(environment, report)
    override fun update(node: BattleChromeMeasuredNode) { node.environment = environment; node.report = report }
    override fun InspectorInfo.inspectableProperties() { name = "battleChromeMeasured" }
}
private class BattleChromeMeasuredNode(var environment: BattleCameraEnvironment, var report: (BattleChromeMeasure) -> Unit) : Modifier.Node(), LayoutModifierNode {
    override fun MeasureScope.measure(measurable: Measurable, constraints: Constraints): MeasureResult {
        val placeable = measurable.measure(constraints)
        report(BattleChromeMeasure(placeable.height, environment))
        return layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    }
}

/** Floating 48dp camera targets; measured chrome determines a collision-free placement. */
@Composable private fun BoxScope.BattleCameraRail(controls: SceneCameraControls, catalogue: JsonObject?, width: androidx.compose.ui.unit.Dp,
    height: androidx.compose.ui.unit.Dp, hudPixels: Int, footerPixels: Int) {
    val density = LocalDensity.current
    val hud = with(density) { hudPixels.toDp() }; val footer = with(density) { footerPixels.toDp() }
    val rules = (catalogue?.get("constants") as? JsonObject)?.get("RAID_CAMERA") as? JsonObject
    val gap = ((rules?.get("pillGapPx") as? JsonPrimitive)?.floatOrNull?.takeIf { it.isFinite() && it >= 0 } ?: 0f).dp
    val placement = battleCameraRailPlacement(width.value, height.value, hud.value, footer.value, gap.value) ?: return // Camera actions remain in Details.
    val modifier = Modifier.align(Alignment.TopEnd).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
        .padding(end = 10.dp).offset(y = placement.top.dp).heightIn(max = placement.height.dp)

    val buttons: @Composable () -> Unit = {
        BattlePill(Modifier.size(48.dp), description = "Zoom in", enabled = controls.zoomStep != null, onClick = controls::zoomIn) { Text("+", fontSize = 22.sp) }
        BattlePill(Modifier.size(48.dp), description = "Zoom out", enabled = controls.zoomStep != null, onClick = controls::zoomOut) { Text("−", fontSize = 22.sp) }
        BattlePill(Modifier.size(48.dp), description = "Fit battlefield", onClick = controls::fit) { Text("⌖", fontSize = 22.sp) }
    }
    if (placement.horizontal) Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) { buttons() }
    else Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) { buttons() }
}
