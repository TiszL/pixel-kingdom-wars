package gg.pixelkingdomwars.nativeclient.ui.kingdom

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.audio.UiAudioScope
import kotlinx.coroutines.withContext
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.BaseRepository
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ContentRepository
import gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentRepository
import gg.pixelkingdomwars.nativeclient.data.HeroAltarReview
import gg.pixelkingdomwars.nativeclient.data.WallBatchRepository
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeEvent
import gg.pixelkingdomwars.nativeclient.scene.sameWallGeometry
import gg.pixelkingdomwars.nativeclient.data.DevicePreferences
import gg.pixelkingdomwars.nativeclient.data.MemoryDevicePreferences
import gg.pixelkingdomwars.nativeclient.data.WallRowOutcome
import gg.pixelkingdomwars.nativeclient.model.ActiveBaseRaid
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.network.RaidInterlockState
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.network.BaseOrderPrice
import gg.pixelkingdomwars.nativeclient.network.buildCountPresentation
import gg.pixelkingdomwars.nativeclient.network.buildingPrice
import gg.pixelkingdomwars.nativeclient.network.constructionStartAvailable
import gg.pixelkingdomwars.nativeclient.network.phaseEConstructionChoices
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt
import gg.pixelkingdomwars.nativeclient.network.wallRowThrough
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.Receipt
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.ops.WallRowSpec
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.data.BuildingMove
import gg.pixelkingdomwars.nativeclient.renderer.CarryEvent
import gg.pixelkingdomwars.nativeclient.renderer.CarryMode
import gg.pixelkingdomwars.nativeclient.renderer.CarryRect
import gg.pixelkingdomwars.nativeclient.renderer.CarryTile
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlight
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind
import gg.pixelkingdomwars.nativeclient.scene.BaseGeometry
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import gg.pixelkingdomwars.nativeclient.data.bindPhaseEConstructionArt
import gg.pixelkingdomwars.nativeclient.data.PhaseEConstructionDraftContext
import gg.pixelkingdomwars.nativeclient.data.PhaseEConstructionPreparation
import gg.pixelkingdomwars.nativeclient.data.PhaseEConstructionPreparationState
import gg.pixelkingdomwars.nativeclient.data.PhaseEConstructionRuntime
import gg.pixelkingdomwars.nativeclient.data.phaseEConstructionRequests
import kotlinx.serialization.json.JsonObject

/** Player intent that has not reached the server: which building is inspected, what is being placed. */
data class PlacementDraft(val type: String, val tile: Pair<Int, Int>? = null)

/** The modal surfaces the Kingdom screen opens over the base (web screens `claim` and `expand`). */
enum class KingdomSheet { DAILY_CACHE, EXPAND }

/** Everything the player has selected or opened on the Kingdom screen; never server state. */
data class KingdomLocal(
    val selectedBuildingId: String? = null,
    val selectedObstacleId: String? = null,
    val selectedJobId: String? = null,
    val placement: PlacementDraft? = null,
    val buildMenu: Boolean = false,
    val heroesOnly: Boolean = false,
    /** Web `wallRow`: widen a wall selection to the whole run the server would price. */
    val wallRow: Boolean = false,
    /** The frozen row quote under review (web `WallRowUpgrade.quote`); null closes the dialog. */
    val wallRowQuote: WallRowQuote? = null,
    val sheet: KingdomSheet? = null,
    /** Selection details start collapsed for every building, including the Keep. */
    val infoOpen: Boolean? = null,
    val keepConfirm: Boolean = true,
    /** Web `settlingMoves`: dropped tiles the scene keeps until the move's own Home read answers (`base:moveSettled`). */
    val settling: Map<String, Pair<Int, Int>> = emptyMap(),
    /** Counts every answered carry release so the renderer's post-drop hold hands over even when nothing else changed. */
    val carrySeq: Long = 0L,
)

data class KingdomUiState(
    val home: BaseState = BaseState(),
    val assets: java.io.File? = null,
    val catalogue: JsonObject? = null,
    val renderCatalogue: JsonObject? = null,
    val interrupted: List<InterruptedIntent> = emptyList(),
    val local: KingdomLocal = KingdomLocal(),
    val contentUpdate: String? = null,
    val updateNotice: String? = null,
    val ordersAllowed: Boolean = true,
    /** Web `deedActionsAllowed`: the selected deed's mutation affordances need a canonical "no raid" reading. */
    val deedActionsAllowed: Boolean = true,
    val activeRaid: ActiveBaseRaid? = null,
    val wallet: String? = null,
    val selectedBaseId: String? = null,
    val baseGeneration: Long = 0,
    val constructionArt: PhaseEConstructionArt? = null,
    val constructionPreparation: PhaseEConstructionPreparationState? = null,
) {
    val base: BaseSnapshot? get() = home.base
    val selectedBuildingId: String? get() = local.selectedBuildingId
    val selectedBuilding: Building? get() = base?.buildings?.firstOrNull { it.id == local.selectedBuildingId }
    val selectedObstacle: Obstacle? get() = base?.obstacles?.firstOrNull { it.id == local.selectedObstacleId }
    val placement: PlacementDraft? get() = local.placement
    val buildMenu: Boolean get() = local.buildMenu
    /** A saved construction intent blocks new construction until it is resolved (Unknown blocks new intents). */
    val constructionBlocked: Boolean get() = interrupted.any { it.kind == IntentKind.CONSTRUCTION && it.blocking }
    /** The server answered `unknown` for the saved construction: its card offers CLOSE (owner 2026-10-06, BUILD's way out). */
    val constructionClosable: Boolean get() = interrupted.any { it.kind == IntentKind.CONSTRUCTION && it.closable }
    val wallRowBlocked: Boolean get() = interrupted.any { it.kind == IntentKind.WALL_ROW && it.blocking }
    /** The last purchase reply was lost: the saved key is offered again (web `retry` → RETRY SAME UPGRADE). */
    val wallRowRetry: Boolean get() = wallRowBlocked && local.wallRowQuote != null
    val geometry: BaseGeometry? get() = catalogue?.let { BaseGeometry(it, renderCatalogue) }
    /** The walls a row purchase would price (web `base:wallRow` pulse): the run through the selected wall. */
    val wallRowIds: List<String> get() {
        val selected = selectedBuilding?.takeIf { it.type == "wall" && local.wallRow } ?: return emptyList()
        return wallRowThrough(base?.buildings.orEmpty(), selected.id).map { it.id }
    }
    /** What the scene paints: while placing, the plot grid plus the picked footprint (web `drawPlacementGrid` /
     * `showFootprintTint`); otherwise the selection chrome (web `showSelection`). */
    val highlights: List<SceneHighlight> get() {
        val geometry = geometry ?: return emptyList(); val base = base ?: return emptyList()
        placement?.let { draft ->
            // Only the server answers a placement's validity (space, ownership, builders, cost), so the picked
            // footprint stays neutral gold. A wall stroke paints its own tiles in the renderer.
            val grid = listOfNotNull(base.claim?.let { BaseGeometry.plotGrid(it.min, it.max) })
            val picked = draft.tile?.takeIf { draft.type != "wall" }?.let { listOf(geometry.footprintHighlight(draft.type, 1, it, valid = null)) }.orEmpty()
            return grid + picked
        }
        val row = wallRowIds.toSet()
        // buildings/wall-row.png: the priced row is outlined wall by wall, never framed wall by wall.
        val walls = if (row.isEmpty()) emptyList() else base.buildings.filter { it.id in row }.map { geometry.highlight(it, BaseGeometry.SELECTION, BaseGeometry.SELECTION_ALPHA, kind = SceneHighlightKind.OUTLINE) }
        val building = selectedBuilding?.takeIf { it.id !in row }?.let { listOf(geometry.highlight(it, BaseGeometry.SELECTION, BaseGeometry.SELECTION_ALPHA, kind = SceneHighlightKind.SELECTION)) }.orEmpty()
        val obstacle = selectedObstacle?.let { listOf(geometry.highlight(it, BaseGeometry.SELECTION, BaseGeometry.SELECTION_ALPHA, kind = SceneHighlightKind.SELECTION)) }.orEmpty()
        return walls + building + obstacle
    }
    fun price(type: String): BaseOrderPrice? = catalogue?.let { c -> base?.let { b -> buildingPrice(c, b.raw, type) } }
    val phaseEBuildingChoices: List<String> get() = phaseEConstructionChoices(base?.raw, catalogue, renderCatalogue, art = constructionArt)
    fun constructionAvailable(type: String, level: Int = 1, buildingId: String? = null): Boolean =
        constructionStartAvailable(base?.raw, catalogue, renderCatalogue, type, level, constructionArt, buildingId)
    /** Buildings with a dropped-but-unanswered move already on its tile, so a second carry sees the vacated ground. */
    val settledBuildings: List<Building> get() = base?.buildings.orEmpty().map { b -> local.settling[b.id]?.let { (tx, ty) -> b.copy(tx = tx, ty = ty) } ?: b }
    /** Web `BaseScene` hold-to-lift admission: every building on the player's base may be carried (walls and the Keep
     * included), the selected wall row carries as a line (#61), and the renderer tints from these footprints. Null
     * while placing or whenever orders are refused; the layout editor supplies its own scene. A saved construction is
     * not a refusal here: it refuses new construction (BUILD, its own door), while a move is a plain keyless order the
     * server re-checks (BaseRepository.moveBuilding) and the web sends it whatever requests are saved. Gating on it froze
     * every building silently while a "Build goldforge" herald waited (owner field result 2026-10-06). */
    val carryMode: CarryMode? get() {
        val base = base ?: return null; val geometry = geometry ?: return null; val claim = base.claim ?: return null
        val baseId = base.baseId?.takeIf { it.isNotBlank() } ?: return null
        if (placement != null || !ordersAllowed || !deedActionsAllowed || claim.max <= claim.min) return null
        val buildings = settledBuildings
        val occupied = buildings.map { b -> val (fw, fh) = geometry.footprint(b); CarryRect(b.id, b.tx, b.ty, fw, fh) } +
            base.obstacles.map { o -> val size = geometry.obstacleFootprint(o); CarryRect(null, o.tx, o.ty, size, size) }
        return CarryMode(baseId, buildings.mapTo(HashSet()) { it.id }, wallRowIds.toSet(), claim.min, claim.max, occupied,
            local.settling.mapValues { (_, tile) -> CarryTile(tile.first, tile.second) }, local.carrySeq)
    }
}

class KingdomViewModel(private val baseRepository: BaseRepository, private val content: ContentRepository, private val observer: ReceiptObserver,
                       private val actions: InterruptedActions?, private val versionCode: Int, private val preferences: DevicePreferences = MemoryDevicePreferences(),
                       private val wallet: String? = null, private val deedInterlock: StateFlow<RaidInterlockState>? = null, val audioIdentity: Any? = null,
                       val heroRecruitment: HeroRecruitmentRepository? = null, val wallBatch: WallBatchRepository? = null,
                       private val accountState: StateFlow<gg.pixelkingdomwars.nativeclient.data.AccountState>? = null,
                       private val recoveryOnly: Boolean = false,
                       constructionArt: StateFlow<PhaseEConstructionArt?> = MutableStateFlow(null),
                       constructionPreparation: StateFlow<PhaseEConstructionPreparationState?> = MutableStateFlow(null),
                       constructionRuntimeFactory: ((CoroutineScope, Flow<String?>, () -> String?) -> PhaseEConstructionRuntime)? = null,
                       private val costAccount: gg.pixelkingdomwars.nativeclient.session.AccountSession? = null,
                       private val costHolder: gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder? = null) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph, recoveryOnly: Boolean = false,
        constructionArt: StateFlow<PhaseEConstructionArt?>? = null,
        constructionPreparation: StateFlow<PhaseEConstructionPreparationState?>? = null) : this(session.base, graph.content, session.observer,
            null, graph.versionCode, graph.preferences, session.session.wallet, session.interlock.state, session.session,
            session.heroRecruitment, session.wallBatch, graph.account.state, recoveryOnly,
            constructionArt ?: MutableStateFlow(null),
            constructionPreparation ?: MutableStateFlow(null),
            if (recoveryOnly || constructionArt != null || constructionPreparation != null) null else { scope, selected, selectedNow ->
                bindPhaseEConstructionArt(graph, session, scope, selected, selectedNow)
            }, costAccount = session.session, costHolder = graph.holder) { fallback = interruptedActions(session) }
    private var fallback: InterruptedActions? = null
    /** Bound only while this exact Kingdom surface is visible; actions capture before suspension. */
    var audio: UiAudioScope? = null
    /** The last prepared Home scene: a Kingdom surface that re-enters composition starts on it (PreparedSceneMemory). */
    internal val preparedScenes = gg.pixelkingdomwars.nativeclient.scene.PreparedSceneMemory()
    /** Home shows a picture of this kingdom (live or its postcard), not the wallpaper cover: HomeShell shows the HUD only then
     *  (scene-transitions spec §1.5). Kept here so a Home that re-enters composition starts with the last answer. */
    internal val homePicture = kotlinx.coroutines.flow.MutableStateFlow(false)
    private val local = MutableStateFlow(KingdomLocal(keepConfirm = preferences.keepConfirm))
    // Demand depends on pre-art local selection, never on the constructionArt-backed UI flow.
    private val constructionRuntime = constructionRuntimeFactory?.invoke(viewModelScope,
        local.map { it.selectedBuildingId }.distinctUntilChanged(), { local.value.selectedBuildingId })
    private val constructionArt = constructionRuntime?.constructionArt ?: constructionArt
    private val constructionPreparation = constructionRuntime?.constructionPreparation ?: constructionPreparation
    // Captured only at an admitted explicit start. This token can retain intent, never spend.
    private var placementContext: PhaseEConstructionDraftContext? = null
    val state: StateFlow<KingdomUiState> = combine(baseRepository.state, content.state, observer.interrupted, local, deedInterlock ?: MutableStateFlow(RaidInterlockState(null, known = true))) { home, content, interrupted, local, interlock ->
        KingdomUiState(home, content.assets, content.catalogue, content.renderCatalogue, interrupted, local, content.contentUpdate, content.updateNotice, content.allowsGameOrders(versionCode), interlock.actionsAllowed, interlock.activeRaid)
    }.combine(this.constructionArt) { current, art -> current.copy(constructionArt = art) }
        .combine(this.constructionPreparation) { current, preparation -> current.copy(constructionPreparation = preparation) }
        .combine(accountState ?: MutableStateFlow<gg.pixelkingdomwars.nativeclient.data.AccountState?>(null)) { current, account ->
        current.copy(wallet = wallet, selectedBaseId = if (account == null) current.base?.baseId else account.selectedBaseId,
            baseGeneration = account?.baseSelectionGeneration ?: 0L)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, KingdomUiState())
    private val buildPriceMemory = gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildPriceMemory()
    /** Typed live owners, read synchronously before the combined UI catches up. Catalogue reference
     * identity is the content fence; no duplicate content generation or owner is introduced. */
    internal fun buildingCosts(rendered: KingdomUiState): gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildingCosts {
        val owner = costAccount ?: return gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildingCosts.unavailable()
        val holder = costHolder ?: return gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildingCosts.unavailable()
        val costs = gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveBuildingCosts(holder, owner,
            readState = {
                holder.requireCurrent(owner)
                val account = requireNotNull(accountState?.value)
                check(account.session === owner)
                val content = content.state.value
                val raid = deedInterlock?.value ?: RaidInterlockState(null, known = true)
                KingdomUiState(baseRepository.state.value, content.assets, content.catalogue, content.renderCatalogue,
                    observer.interrupted.value, local.value, content.contentUpdate, content.updateNotice,
                    content.allowsGameOrders(versionCode), raid.actionsAllowed, raid.activeRaid,
                    wallet = owner.wallet, selectedBaseId = account.selectedBaseId, baseGeneration = account.baseSelectionGeneration,
                    constructionArt = constructionArt.value, constructionPreparation = constructionPreparation.value)
            }, readBalanceRevision = { baseRepository.balanceRevision }, heldPrices = buildPriceMemory, rendered = rendered)
        // The rendered/live mismatch still closes reviewCurrent, upgrades and placement. Only display history survives.
        return costs
    }

    val interrupted: InterruptedActions get() = actions ?: requireNotNull(fallback)

    init {
        // Real retirement is permanent. A same-context lease reload keeps local intent, with
        // all new starts, confirmation and upgrade still gated by the current full art callback.
        viewModelScope.launch { state.collect { current ->
            val draft = current.placement
            if (draft == null) {
                if (local.value.placement == null) placementContext = null
            } else if (local.value.placement === draft && !retainPlacement(current, draft)) {
                retirePlacement(draft)
            }
        } }
        viewModelScope.launch {
            state.map { Triple(it.selectedBaseId, it.baseGeneration, it.ordersAllowed && it.deedActionsAllowed) }
                .distinctUntilChanged().collect { retireBuilderFinishReview() }
        }
        if (!recoveryOnly) refresh()
    }
    fun refresh() = run { baseRepository.refresh(); mineQuietly() }
    /** The X on a kingdom notice: the base message/error and the screen notice retire together. */
    fun clearNotice() { baseRepository.clearNotice(); dismissNotice() }
    fun dismissUpdateNotice() = content.dismissUpdateNotice()
    /** Foreground cadence tick: refresh the kingdom without touching the player's local selection. The
     * mining status rides the same cadence (web `useMineStatus` refreshes on every base refresh).
     * The tick is a background read (owner 2026-10-06 "always loading"): it no longer raises [busy] every
     * `WORLD.mapPollSec`, which closed BUILD, ATTACK, the tools and every Home door and silently dropped an order
     * tapped meanwhile. It is skipped while an action runs, and an action tapped during it cancels it and proceeds. */
    fun tick() { runQuietly { baseRepository.refresh(); mineQuietly(); settleSavedConstruction() } }
    /** Owner 2026-10-06 ("why am I not able to move the buildings?"): a saved construction whose last answer was read before
     * its minimum age had passed is read again on this cadence once that age has passed (GET-only, quiet), so BUILD, MOVE
     * and UPGRADE open without a tap. Nothing is read while the door is open or the age has not passed. */
    private suspend fun settleSavedConstruction() {
        val originalWallet = wallet ?: return
        if (!state.value.constructionBlocked) return
        val wait = try { observer.msUntilSettled(IntentKind.CONSTRUCTION, originalWallet) }
            catch (error: kotlinx.coroutines.CancellationException) { throw error } catch (_: Exception) { null }
        if (wait == 0L) observeSavedConstruction()
    }
    private suspend fun mineQuietly() { runCatching { baseRepository.refreshMine() }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it } }
    fun collectMine() = orders { baseRepository.collectMine() }

    // Web ActionSheet resets its tray / info / row state on every new selection or navigation.
    fun selectBuilding(id: String?) { audio?.invalidate(); dismissBuilderFinishReview(); local.update { it.copy(selectedJobId = null, selectedBuildingId = id, selectedObstacleId = null, wallRow = false, wallRowQuote = null, infoOpen = null) } }
    fun selectObstacle(id: String?) { audio?.invalidate(); dismissBuilderFinishReview(); local.update { it.copy(selectedJobId = null, selectedObstacleId = id, selectedBuildingId = null, wallRow = false, wallRowQuote = null, infoOpen = null) } }
    fun selectJob(job: gg.pixelkingdomwars.nativeclient.model.BaseJob) {
        clearSelection()
        if (job.kind == "clear_obstacle") local.update { it.copy(selectedJobId = job.id) }
        else selectBuilding(job.buildingId)
    }
    fun clearSelection() = selectBuilding(null)
    /** A tap on the base outside placement: the covered building, else the covered obstacle, else nothing
     * (the renderer reports building taps too; both paths land on the same identity). */
    fun tapGround(x: Float, y: Float) {
        val current = state.value
        if (current.placement != null) { if (current.placement?.type != "wall") pickTile(x, y); return }
        val base = current.base ?: return; val geometry = current.geometry ?: return
        geometry.buildingAt(base.buildings, x, y)?.let { selectBuilding(it.id); return }
        geometry.obstacleAt(base.obstacles, x, y)?.let { selectObstacle(it.id); return }
        clearSelection()
    }
    fun openBuildMenu(heroesOnly: Boolean = false) { audio?.invalidate(); heroRecruitment?.dismiss(); wallBatch?.dismiss(); local.update { it.copy(buildMenu = true, heroesOnly = heroesOnly, placement = null, selectedBuildingId = null, selectedObstacleId = null) } }
    fun closeBuildMenu() { audio?.invalidate(); heroRecruitment?.dismiss(); local.update { it.copy(buildMenu = false) } }
    fun startPlacement(type: String) {
        audio?.invalidate(); wallBatch?.dismiss()
        if (!berthCapacityAvailableNow(type)) {
            local.value.placement?.takeIf { it.type == type }?.let(::retirePlacement)
            notify(CONSTRUCTION_UNAVAILABLE, error = true); return
        }
        if (!constructionAvailableNow(type)) { notify(CONSTRUCTION_UNAVAILABLE, error = true); return }
        placementContext = capturePlacementContext(type)
        if (type == "wall") {
            orders(audioFeedback = false) {
                baseRepository.refresh(); requireNotNull(wallBatch) { "Wall stroke recovery is unavailable." }.prepare()
                local.update { KingdomLocal(placement = PlacementDraft(type), keepConfirm = it.keepConfirm) }
            }
        } else local.update { KingdomLocal(placement = PlacementDraft(type), keepConfirm = it.keepConfirm) }
    }
    fun pickTile(x: Float, y: Float) { local.update { it.copy(placement = it.placement?.copy(tile = kotlin.math.floor(x).toInt() to kotlin.math.floor(y).toInt())) } }
    fun clearTile() { heroRecruitment?.dismiss(); local.update { it.copy(placement = it.placement?.copy(tile = null)) } }
    fun cancelPlacement() { audio?.invalidate(); heroRecruitment?.dismiss(); wallBatch?.dismiss(); placementContext = null; local.update { it.copy(placement = null) } }
    private suspend fun observeBuilderFinish() {
        val originalWallet = requireNotNull(wallet)
        observer.refresh(originalWallet)
        if (observer.interrupted.value.any { it.kind == IntentKind.CONSTRUCTION && it.intent.wallet == originalWallet &&
                gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec.modernBuilder(it.intent) })
            observer.check(IntentKind.CONSTRUCTION, originalWallet)
    }
    fun refreshBuilderFinish() = run { observeBuilderFinish() }
    /** Every Home resume, so also after a process restart, re-reads ANY saved construction (GET-only): the server's answer,
     * and with it the herald's CLOSE, is back without a tap (owner field result 2026-10-06, build 607a9c37: the answer lived
     * only in memory). A legacy placement's failed background read keeps the request and stays quiet; RETRY CHECK reports.
     * A modern builder payment keeps its existing reporting. */
    private suspend fun observeSavedConstruction() {
        val originalWallet = wallet ?: return
        observer.refresh(originalWallet)
        val saved = observer.interrupted.value.firstOrNull { it.kind == IntentKind.CONSTRUCTION && it.intent.wallet == originalWallet && !it.kept } ?: return
        if (gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec.modernBuilder(saved.intent)) { observer.check(IntentKind.CONSTRUCTION, originalWallet); return }
        try { observer.check(IntentKind.CONSTRUCTION, originalWallet) }
        catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (_: Exception) { }
    }
    /** Owner review 2026-10-06 (M2): a lost POST can commit long after CLOSE or after a newer order parked it. Every Home
     * resume re-reads every kept request (GET-only); a late acceptance is hydrated, announced and the kingdom re-read, so a
     * real charge is never hidden. A failed read keeps the record kept and says nothing. */
    private suspend fun surfaceLateAcceptances() {
        val originalWallet = wallet ?: return
        val late = try { observer.recheckKept(originalWallet) }
            catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (_: Exception) { emptyList() }
        val accepted = late.filter { it.second is gg.pixelkingdomwars.nativeclient.ops.Receipt.Accepted }
        if (accepted.isEmpty()) return
        notify(accepted.joinToString(" ") { "The server confirmed the original request · ${it.first.label}." })
        runCatching { baseRepository.refresh() }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
    }
    fun refreshConstructionReceipts() = run { observeSavedConstruction(); surfaceLateAcceptances(); heroRecruitment?.refresh(); wallBatch?.refresh() }
    fun refreshWallBatch() = run { wallBatch?.refresh() }
    fun retryWallBatch() = run { wallBatch?.retry() }
    /** CLOSE on the wall batch / hero altar card: the owner's own closure; its observation is announced like the herald's. */
    fun closeWallBatch() = run { gg.pixelkingdomwars.nativeclient.ui.Copy.observation(wallBatch?.close())?.let { notify(it) } }
    fun closeHeroRecruitment() = run { gg.pixelkingdomwars.nativeclient.ui.Copy.observation(heroRecruitment?.close())?.let { notify(it) } }
    fun dismissWallReceipt(receiptId: String) { wallBatch?.dismissReceipt(receiptId) }
    fun dismissWallDrawing() { wallBatch?.dismiss(); local.update { if (it.placement?.type == "wall") it.copy(placement = null) else it } }
    fun checkWallDrawingGeometry() {
        val drawing = wallBatch?.state?.value?.drawing ?: return
        if (!sameWallGeometry(state.value.base, drawing.base)) dismissWallDrawing()
    }
    fun wallStroke(event: WallStrokeEvent) {
        val repo = wallBatch ?: return; val drawing = repo.state.value.drawing ?: return
        if (event.token != drawing.mode.token || state.value.placement?.type != "wall") return
        when (event) {
            is WallStrokeEvent.Preview -> repo.preview(event.token, event.tiles)
            is WallStrokeEvent.Released -> {
                if (active || !state.value.ordersAllowed || !state.value.deedActionsAllowed) {
                    dismissWallDrawing(); notify("The wall stroke was cancelled while your base was updating. Draw it again.", error = true)
                } else orders {
                    try { repo.release(event.token, event.tiles) }
                    finally { dismissWallDrawing() }
                }
            }
        }
    }
    /** A carry put down (web `pointerup` → 'base:move' / 'base:moveLine'): the dropped tiles are held locally (web
     * `holdSettlingMove`) until the move's own Home read answers, on success or refusal alike (web `base:moveSettled`);
     * a refusal reverts through that read and the repository's dismissible notice. The renderer has already reverted an
     * invalid drop; it only needs the word. */
    fun carry(event: CarryEvent) {
        val release = event as? CarryEvent.Released ?: return
        if (!release.valid) { notify(CARRY_BLOCKED, error = true); return }
        val moves = release.moves.map { BuildingMove(it.id, it.tx, it.ty) }
        val ids = moves.mapTo(HashSet()) { it.id }
        fun settle() = local.update { it.copy(settling = it.settling - ids, carrySeq = it.carrySeq + 1) }
        local.update { it.copy(selectedBuildingId = null, selectedObstacleId = null, wallRow = false, wallRowQuote = null, infoOpen = null,
            settling = it.settling + moves.associate { m -> m.id to (m.tx to m.ty) }) }
        val job = orders { if (moves.size > 1) baseRepository.moveWalls(moves) else moves.single().let { baseRepository.moveBuilding(it.id, it.tx, it.ty) } }
        if (job == null) { settle(); notify(CARRY_BUSY, error = true) } else job.invokeOnCompletion { settle() }
    }
    fun refreshHeroRecruitment() = run { heroRecruitment?.refresh() }
    fun reviewHeroPlacement() { val draft = state.value.placement ?: return; val tile = draft.tile ?: return
        run { heroRecruitment?.review(draft.type, tile.first, tile.second) } }
    fun confirmHeroPlacement(review: HeroAltarReview) = orders { heroRecruitment?.confirm(review); local.update { it.copy(placement = null) } }
    fun retryHeroRecruitment() = run { heroRecruitment?.retry() }
    fun dismissHeroReview() = heroRecruitment?.dismiss()
    fun confirmPlacement() {
        val draft = state.value.placement ?: return; val tile = draft.tile ?: return
        if (draft.type == "wall") return // Wall release owns the exact batch; no singular legacy fallback.
        if (!berthCapacityAvailableNow(draft.type)) {
            retirePlacement(draft)
            notify(CONSTRUCTION_UNAVAILABLE, error = true); return
        }
        // A tap racing a routine lease reload is refused before consuming local intent.
        // The existing in-order guard below still rechecks immediately before dispatch.
        if (!constructionAvailableNow(draft.type)) {
            notify(CONSTRUCTION_UNAVAILABLE, error = true); return
        }
        // The live SHARDS ghost refuses known occupied/out-of-claim tiles using the current repository read.
        // This is an additional local refusal only: the existing money and server admission remain below.
        if (state.value.price(draft.type)?.currency == "SHARDS") {
            val currentBase = baseRepository.state.value.base
            val currentGeometry = content.state.value.catalogue?.let { BaseGeometry(it, content.state.value.renderCatalogue) }
            val reason = if (currentBase == null || currentGeometry == null) "Land bounds are unavailable"
                else gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.placementSpace(
                    currentBase, currentGeometry, draft.type, tile, local.value.settling).reason
            if (reason != null) { notify(reason, error = true); return }
        }
        placementContext = null
        local.update { it.copy(placement = null) }
        orders {
            check(constructionAvailableNow(draft.type) && berthCapacityAvailableNow(draft.type)) { CONSTRUCTION_UNAVAILABLE }
            baseRepository.place(draft.type, tile.first, tile.second)
        }
    }
    fun upgrade(buildingId: String) = orders {
        val building = requireNotNull(baseRepository.state.value.base?.buildings?.firstOrNull { it.id == buildingId }) {
            "This building is no longer available. Refresh your base before starting an upgrade."
        }
        check(constructionAvailableNow(building.type, building.level + 1, building.id)) { CONSTRUCTION_UNAVAILABLE }
        baseRepository.upgrade(buildingId)
    }
    fun finishJob(jobId: String) = orders {
        val job = requireNotNull(baseRepository.state.value.base?.jobs?.find { it.id == jobId }) { "Refresh this job before finishing." }
        check(builderFinishIsFree(job)) { "Review the exact builder currency before paying." }
        baseRepository.finishJob(jobId)
    }
    fun finishBuilderJob(job: gg.pixelkingdomwars.nativeclient.model.BaseJob) =
        if (builderFinishIsFree(job)) finishJob(job.id) else reviewBuilderFinish(job.id)
    fun reviewBuilderFinish(jobId: String) = orders { baseRepository.reviewBuilderFinish(jobId) }
    fun reviewSavedBuilderFinish() = orders { baseRepository.reviewSavedBuilderFinish() }
    fun confirmBuilderFinish() = orders { baseRepository.confirmBuilderFinish() }
    fun dismissBuilderFinishReview() = baseRepository.dismissBuilderFinishReview()
    /** Screen-driven close (interlock/update-gate flip, Home recomposed): never withdraws a payment in flight. */
    fun retireBuilderFinishReview() = baseRepository.retireBuilderFinishReview()
    fun cancelJob(jobId: String) = orders { baseRepository.cancelJob(jobId) }
    fun repairTrap(buildingId: String) = orders { baseRepository.repairTrap(buildingId) }
    /** Web `ObstacleSheet` CLEAR: the sheet closes on acceptance, the base re-reads with the running job. */
    fun clearObstacle(obstacleId: String) = orders { baseRepository.clearObstacle(obstacleId); local.update { if (it.selectedObstacleId == obstacleId) it.copy(selectedObstacleId = null) else it } }
    fun toggleInfo() { local.update { it.copy(infoOpen = !(it.infoOpen ?: false)) } }
    /** DON'T ASK AGAIN is applied on CONFIRM only (web `KeepSpendConfirm`); the preference is per device. */
    /** Read at the tap: Army or Heroes can change this shared preference while Home remains alive. */
    fun keepConfirmationRequired(): Boolean = preferences.keepConfirm
    fun setKeepConfirm(on: Boolean) { preferences.keepConfirm = on; local.update { it.copy(keepConfirm = on) } }

    // Wall row upgrade (web `sheets.tsx` SELECT WHOLE ROW + `WallRowUpgrade.tsx`).
    fun toggleWallRow() { local.update { it.copy(wallRow = !it.wallRow, wallRowQuote = null) } }
    /** A new quote is refused while a lost purchase reply is unresolved: the saved key must be retried or checked first. */
    fun quoteWallRow() {
        val wall = state.value.selectedBuilding?.takeIf { it.type == "wall" } ?: return
        orders(audioFeedback = false) {
            check(!observer.blocks(IntentKind.WALL_ROW)) { "Resolve the interrupted wall row purchase before checking the row again" }
            val quote = baseRepository.quoteWallRow(wall.id); local.update { it.copy(wallRowQuote = quote) }
        }
    }
    fun dismissWallRowQuote() { local.update { it.copy(wallRowQuote = null) } }
    fun purchaseWallRow() {
        val quote = state.value.local.wallRowQuote ?: return
        orders(audioFeedback = false) {
            when (val outcome = baseRepository.upgradeWallRow(quote)) {
                is WallRowOutcome.Upgraded -> local.update { it.copy(wallRowQuote = null) }
                is WallRowOutcome.Repriced -> { local.update { it.copy(wallRowQuote = outcome.quote) }; notify(outcome.message, error = true) }
            }
        }
    }
    /** RETRY SAME UPGRADE: the saved key is re-sent by explicit choice; the server replays a committed purchase
     * as `duplicate` and answers a changed row with the replacement quote, which retires the key. */
    fun retryWallRow() = orders(audioFeedback = false) {
        val owner = requireNotNull(wallet) { "Sign in again to retry this purchase" }
        try {
            val receipt = observer.retry(IntentKind.WALL_ROW, owner)
            if (receipt is Receipt.Accepted) local.update { it.copy(wallRowQuote = null) }
            Copy.observation(receipt)?.let { notify(it) }
        } catch (error: ApiException) {
            val replacement = if (error.code in WallRowSpec.REPRICED) (error.details["quote"] as? JsonObject)?.let { runCatching { WallRowQuote.from(it) }.getOrNull() } else null
            if (replacement != null) local.update { it.copy(wallRowQuote = replacement) }
            throw error
        }
    }

    fun openDailyCache() { audio?.invalidate(); local.update { it.copy(sheet = KingdomSheet.DAILY_CACHE) }; run { baseRepository.refreshMine() } }
    fun openExpand() { audio?.invalidate(); local.update { it.copy(sheet = KingdomSheet.EXPAND) } }
    fun closeSheet() { audio?.invalidate(); local.update { it.copy(sheet = null) } }
    fun claimDailyCache() = orders { baseRepository.claimDailyCache() }

    /** The layout editor owns the base while open: the ordinary sheets close (web screen `layout` unmounts them). */
    fun closeSurfaces() { dismissBuilderFinishReview(); audio?.invalidate(); heroRecruitment?.dismiss(); wallBatch?.dismiss(); local.update { KingdomLocal(keepConfirm = it.keepConfirm) } }

    fun tutorialAction(action: String) = orders(audioFeedback = false) { baseRepository.tutorialAction(action) }
    /** The guided chain's CLAIM: the server pays the objective and reports the next step with Home. */
    fun claimQuest(questId: String) = orders { baseRepository.claimQuest(questId); baseRepository.refresh() }
    fun applyContentUpdate(canActivate: () -> Boolean) = run { content.applyUpdate(canActivate) }

    /** Read repositories at dispatch; the combined UI flow may still hold the previous feature snapshot. */
    private fun constructionAvailableNow(type: String, level: Int = 1, buildingId: String? = null): Boolean = content.state.value.let {
        constructionStartAvailable(baseRepository.state.value.base?.raw, it.catalogue, it.renderCatalogue, type, level, constructionArt.value, buildingId)
    }

    /** Demand metadata can preserve already-started intent only. The collector inside this
     * selector ALWAYS refuses action admission; it creates no residency or spending capability. */
    private fun placementMetadataCurrent(type: String): Boolean = content.state.value.let { current ->
        phaseEConstructionRequests(baseRepository.state.value.base?.raw, current.catalogue, current.renderCatalogue, null)
            .any { it.type == type && it.level == 1 && it.buildingId == null }
    }

    private fun capturePlacementContext(type: String): PhaseEConstructionDraftContext? {
        val status = constructionPreparation.value ?: return null
        val context = status.context ?: return null
        return context.takeIf { status.phase == PhaseEConstructionPreparation.READY &&
            status.base === baseRepository.state.value.base?.raw && context.isCurrent() && placementMetadataCurrent(type) }
    }

    /** Retire only the still-selected intent; a stale UI observation cannot clear its replacement. */
    private fun retirePlacement(draft: PlacementDraft) {
        if (local.value.placement !== draft) return
        placementContext = null
        local.update { if (it.placement === draft) it.copy(placement = null) else it }
    }

    private fun retainPlacement(current: KingdomUiState, draft: PlacementDraft): Boolean {
        if (!berthCapacityAvailableNow(draft.type)) return false
        val captured = placementContext ?: return current.constructionAvailable(draft.type)
        // Check the captured identity BEFORE any new ready callback: a brief permission/content
        // retirement must clear this draft even if a replacement READY overtook the UI collector.
        if (!captured.isCurrent() || !placementMetadataCurrent(draft.type)) return false
        val status = constructionPreparation.value ?: return false
        if (status.context !== captured || status.phase == PhaseEConstructionPreparation.REFUSED) return false
        // A stale raw-status pair is not a terminal result for the newly refreshed Home. Preserve
        // intent only under the still-current context/demand until its queued preparation catches
        // up. Dispatch remains closed because the full callback binds exact raw identity.
        return status.phase == PhaseEConstructionPreparation.PREPARING || status.phase == PhaseEConstructionPreparation.READY
    }

    /** Only new berths consume the additive current server capacity; upgrades and legacy construction retain their rules. */
    private fun berthCapacityAvailableNow(type: String): Boolean {
        if (type != "berth") return true
        val base = baseRepository.state.value.base ?: return false
        val catalogue = content.state.value.catalogue ?: return false
        return buildCountPresentation(catalogue, type, base.player.keepLevel, base.buildings.map { it.type },
            base.raw["constructionCapacity"])?.atCap == false
    }

    private fun orders(audioFeedback: Boolean = true, block: suspend () -> Unit): kotlinx.coroutines.Job? {
        if (active) return null
        audio?.invalidate()
        val ticket = audio?.takeIf { audioFeedback }?.capture()
        return run {
            check(state.value.ordersAllowed) { "Install the available native app update before submitting game orders. Your account is preserved." }
            // The server owns the lock (423 BASE_BEING_RAIDED); the interlock only says so first, in production's words.
            check(state.value.activeRaid == null) { gg.pixelkingdomwars.nativeclient.ui.Copy.ACTIVE_RAID_MESSAGE }
            if (ticket == null) block() else withContext(ticket) { block() }
        }
    }

    private companion object {
        const val CONSTRUCTION_UNAVAILABLE = "This building is not available to start. Refresh your base and available game content."
        /** The renderer's local footprint check refused the drop (web reverts silently; native says why the piece snapped back). */
        const val CARRY_BLOCKED = "CAN'T PLACE IT THERE"
        /** Another order is still in flight: the drop is reverted rather than queued behind it. */
        const val CARRY_BUSY = "YOUR BASE IS BUSY — TRY THE MOVE AGAIN"
    }
}
