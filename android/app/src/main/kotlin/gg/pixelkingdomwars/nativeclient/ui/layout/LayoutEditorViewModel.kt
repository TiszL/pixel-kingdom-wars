package gg.pixelkingdomwars.nativeclient.ui.layout

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.BaseRepository
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ContentRepository
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.LayoutSlot
import gg.pixelkingdomwars.nativeclient.model.Layouts
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeMode
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeEvent
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import gg.pixelkingdomwars.nativeclient.renderer.HighlightColors
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlight
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind
import gg.pixelkingdomwars.nativeclient.scene.BaseGeometry
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlin.math.floor
import kotlin.math.roundToInt

/** Web `LayoutEditor.tsx` friendlyError: server refusals in the editor's own voice. */
fun layoutErrorCopy(error: Throwable): String {
    if (error is ApiException) {
        val byCode = mapOf(
            "LAYOUT_STALE" to "THIS LAYOUT CHANGED ELSEWHERE — THE SERVER COPY WAS RELOADED",
            "LAYOUT_GEOMETRY_STALE" to "BASE GEOMETRY CHANGED — RELOAD BEFORE EDITING",
            "LAYOUT_SLOT_LOCKED" to "UNLOCK ${layoutSlotLabel("FARM")} BEFORE SAVING IT",
            "LAYOUT_INVALID" to error.message.uppercase(),
            "BASE_BEING_RAIDED" to "AN INCOMING RAID HAS LOCKED THIS BASE",
            "INSUFFICIENT_SHARDS" to "NOT ENOUGH BASE SHARDS TO UNLOCK ${layoutSlotLabel("FARM")}",
            "DEED_OWNERSHIP_CHANGED" to "DEED OWNERSHIP CHANGED — BASE ACCESS CLOSED",
        )
        return error.code?.let { byCode[it] } ?: error.message.uppercase()
    }
    return error.message?.uppercase() ?: "LAYOUT ACTION FAILED"
}

/** Web `LayoutEditor.tsx` buildingName. */
fun layoutBuildingName(type: String): String = type
    .replace("archertower", "ARCHER TOWER").replace("electrictower", "TESLA TOWER").replace("lasertower", "LASER TOWER")
    .replace("airdefence", "AIR DEFENCE").replace("goldforge", "GOLD FORGE").replace("heroaltar", "VEX ALTAR")
    .replace("siegestool", "THEODOR STOOL").replace("dragonnest", "DRAGON NEST").replace("powdermine", "POWDER MINE")
    .replace("spiketrap", "SPIKE TRAP").uppercase()

/** The base shape the drafts were built against (web `baseShapeKey`): a changed identity, type or live position reloads them. */
fun baseShapeKey(base: BaseSnapshot?): String? = base?.let { "${it.baseId}:${it.plotVersion ?: 1}:${it.claim}:" + it.buildings.map { b -> "${b.id}:${b.type}:${b.tx}:${b.ty}" }.sorted().joinToString("|") }

data class LayoutLocal(
    val open: Boolean = false,
    val slot: String = "HOME",
    val drafts: Map<String, LayoutDraft> = emptyMap(),
    /** `unlock` | `save` | `apply` while that request is in flight. */
    val busy: String? = null,
    val notice: String? = null,
    val wallPaintLevel: Int? = null,
    val wallTool: LayoutWallTool? = null,
    val wallRefusal: String? = null,
    val wallEpoch: Long = 0,
    val wallInputPaused: Boolean = false,
    val wallPreview: LayoutWallPending? = null,
    val wallPending: LayoutWallPending? = null,
    val wallSelectedIds: List<String> = emptyList(),
    val discardOpen: Boolean = false,
    val loadError: String? = null,
    val installedShape: String? = null,
)

data class LayoutEditorState(
    val home: BaseState = BaseState(),
    val catalogue: JsonObject? = null,
    val renderCatalogue: JsonObject? = null,
    val interrupted: List<InterruptedIntent> = emptyList(),
    val local: LayoutLocal = LayoutLocal(),
    val deedActionsAllowed: Boolean = true,
    val wallBinding: LayoutWallBinding? = null,
) {
    val wallUi: LayoutWallEditorUi get() = layoutWallEditorUi(this)
    val wallPending: LayoutWallPending? get() = wallBinding?.let { binding -> local.wallPending?.takeIf { it.token == binding.mode.token && it.context == binding.context } }
    val wallPreviewCount: Int get() = wallPending?.affectedCount ?: local.wallPreview?.takeIf { it.token == wallBinding?.mode?.token }?.affectedCount ?: 0
    val wallStrokeMode: WallStrokeMode? get() = wallBinding?.mode?.takeIf { wallPending == null }
    val open: Boolean get() = local.open
    val base: BaseSnapshot? get() = home.base
    val layouts: Layouts? get() = home.layouts
    val slot: String get() = local.slot
    val currentSlot: LayoutSlot? get() = layouts?.slot(local.slot)
    val draft: LayoutDraft? get() = local.drafts[local.slot]
    val locked: Boolean get() = currentSlot?.locked == true
    val unlockBlocked: Boolean get() = interrupted.any { it.kind == IntentKind.LAYOUT_UNLOCK && it.blocking }
    val geometry: LayoutGeometry? get() {
        val data = layouts ?: return null; val base = base ?: return null; val catalogue = catalogue ?: return null
        val shared = BaseGeometry(catalogue, renderCatalogue)
        val plot = runCatching { gg.pixelkingdomwars.nativeclient.model.PlotGeometry.from(catalogue, data.plotVersion) }.getOrNull() ?: return null
        if ((data.plotVersion ?: 1) != (base.plotVersion ?: 1) || data.claim.min < plot.min || data.claim.max > plot.max) return null
        return LayoutGeometry(data.geometryVersion, data.claim.min, data.claim.max, base.buildings, base.obstacles,
            footprint = { type -> footprintOf(catalogue, type, data.geometryVersion) }, obstacleSize = { key -> shared.obstacleFootprint(Obstacle("", key, 0, 0)) }, plotGeometry = plot)
    }
    val buildingsById: Map<String, Building> get() = base?.buildings.orEmpty().associateBy { it.id }
    val selected: Building? get() = draft?.selectedId?.let { buildingsById[it] }
    val selectedInTray: Boolean get() = selected?.let { draft?.inTray(it.id) } == true
    val keepPlaced: Boolean get() { val placed = draft?.positions?.map { it.buildingId }?.toSet().orEmpty(); return base?.buildings?.any { it.type == "keep" && it.id in placed } == true }
    /** Trayed walls grouped by level in stable tray order (web `trayedWallGroups`). */
    val trayedWallGroups: Map<Int, List<String>> get() {
        val byId = buildingsById; val groups = linkedMapOf<Int, MutableList<String>>()
        for (id in draft?.trayIds.orEmpty()) { val building = byId[id] ?: continue; if (building.type != "wall") continue; groups.getOrPut(building.level) { mutableListOf() } += id }
        return groups
    }
    val saveDisabled: Boolean get() = geometry == null || !deedActionsAllowed || locked || draft == null || !keepPlaced || draft!!.trayIds.isNotEmpty() || local.busy != null || wallPending != null
    /** The base as the scene must draw it: the draft's coordinates, trayed identities withheld. */
    val draftBase: JsonObject? get() { val base = base ?: return null; return draft?.applyToBase(base.raw) ?: base.raw }
    /** What the scene paints while editing (web `drawPlacementGrid` + `showFootprintTint`): the plot grid for
     * the whole edit so every tile reads while a building moves, then the selected building's footprint at
     * its draft position, coloured by the draft's own placement check. */
    val highlights: List<SceneHighlight> by lazy {
        if (!open) return@lazy emptyList()
        val draft = draft ?: return@lazy emptyList(); val geometry = geometry ?: return@lazy emptyList()
        val pendingTiles = wallPending?.let { pending ->
            val changed = if (pending.context.tool == LayoutWallTool.ERASE) draft.positions.filter { pending.result.draft.position(it.buildingId) == null }
                else pending.result.draft.positions.filter { draft.position(it.buildingId) != it }
            changed.map { WallStrokeTile(it.tx, it.ty) }
        }.orEmpty()
        val wallTiles = pendingTiles + draft.positions.filter { it.buildingId in local.wallSelectedIds }.map { WallStrokeTile(it.tx, it.ty) }
        val (wallWidth, wallHeight) = geometry.footprint("wall")
        val wallHighlights = wallTiles.distinct().map { SceneHighlight(it.tx.toFloat(), it.ty.toFloat(), wallWidth.toFloat(), wallHeight.toFloat(), HighlightColors.VALID, BaseGeometry.FOOTPRINT_ALPHA, SceneHighlightKind.FOOTPRINT_OVERLAY) }
        val grid = layoutGrid(geometry, draft) + wallHighlights
        val selected = selected ?: return@lazy grid
        val position = draft.position(selected.id) ?: return@lazy grid
        val (fw, fh) = geometry.footprint(selected.type)
        val valid = validatePlacement(geometry, draft.positions, selected.id, position.tx, position.ty) == null
        grid + SceneHighlight(position.tx.toFloat(), position.ty.toFloat(), fw.toFloat(), fh.toFloat(), HighlightColors.footprint(valid), BaseGeometry.FOOTPRINT_ALPHA, SceneHighlightKind.FOOTPRINT_OVERLAY)
    }
}

/** The layout editor (web `ui/layoutEditor/LayoutEditor.tsx`): authoritative HOME / BASE presets edited
 * as a reversible coordinate draft over the live base, saved or applied with the server's ETags. */
class LayoutEditorViewModel(private val base: BaseRepository, private val content: ContentRepository, private val observer: ReceiptObserver,
                            private val actions: InterruptedActions?, deedInterlock: StateFlow<RaidInterlockState>? = null) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph) : this(session.base, graph.content, session.observer, null, session.interlock.state) { fallback = interruptedActions(session) }
    private var fallback: InterruptedActions? = null
    private val local = MutableStateFlow(LayoutLocal())
    private var wallBinding: LayoutWallBinding? = null
    private val interlockState = deedInterlock ?: MutableStateFlow(RaidInterlockState(null, known = true))
    val state: StateFlow<LayoutEditorState> = combine(base.state, content.state, observer.interrupted, local, interlockState) { _, _, _, _, _ ->
        currentEditorState()
    }.stateIn(viewModelScope, SharingStarted.Eagerly, LayoutEditorState())

    /** UI projection can lag a callback batch. Admission always reads the current source snapshots. */
    internal fun currentEditorState(): LayoutEditorState {
        val pack = content.state.value
        val next = LayoutEditorState(base.state.value, pack.catalogue, pack.renderCatalogue, observer.interrupted.value, local.value, interlockState.value.actionsAllowed)
        wallBinding = bindLayoutWalls(next, wallBinding)
        return next.copy(wallBinding = wallBinding)
    }
    private fun canEdit(current: LayoutEditorState): Boolean = current.open && !current.locked && current.local.busy == null &&
        !current.local.discardOpen && !current.local.wallInputPaused && current.wallPending == null && current.deedActionsAllowed
    val interrupted: InterruptedActions get() = actions ?: requireNotNull(fallback)

    init {
        // Web: a base whose shape changed under an open editor reloads every draft from the live base.
        viewModelScope.launch {
            base.state.map { baseShapeKey(it.base) }.distinctUntilChanged().collect { shape ->
                val current = local.value
                if (current.open && current.installedShape != null && shape != null && shape != current.installedShape) {
                    base.state.value.layouts?.let { install(it, preserve = false) }
                    local.update { it.copy(notice = "BASE CHANGED — DRAFTS RELOADED FROM THE LIVE BASE") }
                }
            }
        }
    }

    fun open() {
        local.update { LayoutLocal(open = true) }
        run { try { install(base.refreshLayouts(), preserve = false) } catch (error: Exception) { if (error !is CancellationException) local.update { it.copy(loadError = layoutErrorCopy(error)) }; throw error } }
    }
    fun reload() = run { install(base.refreshLayouts(), preserve = true) }
    /** Web `install`: one draft per unlocked slot; `preserve` keeps an existing draft across a reload. */
    private fun install(data: Layouts, preserve: Boolean) {
        val buildings = base.state.value.base?.buildings.orEmpty()
        local.update { current ->
            val next = data.slots.filterNot { it.locked }.associate { slot -> slot.slot to (current.drafts[slot.slot]?.takeIf { preserve } ?: createDraft(buildings, slot)) }
            current.copy(drafts = next, loadError = null, wallRefusal = null, installedShape = baseShapeKey(base.state.value.base))
        }
    }
    /** CANCEL sends nothing. A dirty draft asks first (web `useMobileBackHandler` at 160 → MobileBackConfirm at 1000). */
    fun close() {
        val current = local.value
        if (current.busy != null) return
        if (current.drafts.values.any { it.dirty }) { local.update { it.copy(discardOpen = true, wallPending = null, wallPreview = null, wallEpoch = it.wallEpoch + 1) }; return }
        local.value = LayoutLocal()
    }
    fun cancelDiscard() { local.update { it.copy(discardOpen = false) } }
    fun confirmDiscard() { local.value = LayoutLocal() }
    fun selectSlot(slot: String) { require(slot == "HOME" || slot == "FARM"); local.update { it.copy(slot = slot, wallPaintLevel = null, wallTool = null, wallPending = null, wallPreview = null, wallSelectedIds = emptyList(), wallEpoch = it.wallEpoch + 1, wallRefusal = null, notice = null) } }

    private fun update(transform: (LayoutDraft) -> LayoutDraft) { local.update { current -> current.drafts[current.slot]?.let { current.copy(drafts = current.drafts + (current.slot to transform(it))) } ?: current } }
    private fun apply(result: DraftResult) { local.update { current -> current.copy(notice = result.error, wallRefusal = result.error, drafts = if (current.drafts[current.slot] != null) current.drafts + (current.slot to result.draft) else current.drafts) } }

    fun selectBuilding(id: String?) { clearWallPaint(); local.update { it.copy(notice = null) }; update { selectBuilding(it, id) } }
    /** A tap on the plot: in paint mode it paints the tile; otherwise a covered building is selected, else the
     * selection (placed or trayed) is centred on the tap. The scene consumes wall drags through
     * wallStroke; tap/nudge remain accessible local draft controls, including selected runs. */
    fun tapTile(x: Float, y: Float) {
        val current = currentEditorState()
        if (!canEdit(current)) return
        val draft = current.draft ?: return; val geometry = current.geometry ?: return
        if (!x.isFinite() || !y.isFinite() || current.wallPending != null) return
        if (current.local.wallSelectedIds.isNotEmpty()) {
            val positions = draft.positions.filter { it.buildingId in current.local.wallSelectedIds }
            if (positions.isNotEmpty()) {
                val dx = floor(x.toDouble()).toLong() - positions.minOf { it.tx }.toLong()
                val dy = floor(y.toDouble()).toLong() - positions.minOf { it.ty }.toLong()
                if (dx in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong() && dy in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) moveSelectedWallRun(dx.toInt(), dy.toInt())
            }
            return
        }
        // The renderer owns ERASE/SELECT taps as one-cell strokes. A delayed ground fallback must not move a building.
        if (current.local.wallTool == LayoutWallTool.ERASE || current.local.wallTool == LayoutWallTool.SELECT) return
        local.update { it.copy(notice = null) }
        current.local.wallPaintLevel?.let { level -> apply(paintWalls(draft, geometry, level, listOf(floor(x).toInt() to floor(y).toInt()))); return }
        val shared = BaseGeometry(current.catalogue ?: return, current.renderCatalogue)
        val placed = current.base?.buildings.orEmpty().filter { draft.position(it.id) != null }
        shared.buildingAt(placed, x, y) { building -> draft.position(building.id)!!.let { it.tx to it.ty } }?.let { selectBuilding(it.id); return }
        val selected = current.selected ?: return
        val (fw, fh) = geometry.footprint(selected.type)
        apply(moveBuilding(draft, geometry, selected.id, (x - fw / 2f).roundToInt(), (y - fh / 2f).roundToInt()))
    }
    fun nudge(dx: Int, dy: Int) { val current = currentEditorState(); if (!canEdit(current)) return; if (current.local.wallSelectedIds.isNotEmpty()) { moveSelectedWallRun(dx, dy); return }; val draft = current.draft ?: return; val geometry = current.geometry ?: return; apply(nudgeSelected(draft, geometry, dx, dy)) }
    fun moveSelectedToTray() { val current = currentEditorState(); if (!canEdit(current)) return; val draft = current.draft ?: return; val id = draft.selectedId ?: return; apply(moveToTray(draft, current.base?.buildings.orEmpty(), id)) }
    fun undo() { val current = currentEditorState(); if (current.wallPending != null) { cancelWallStroke(); return }; if (!canEdit(current)) return; cancelWallStroke(); local.update { it.copy(wallSelectedIds = emptyList()) }; update(::undoDraft) }
    fun pickUpAll() { val current = currentEditorState(); if (!canEdit(current)) return; val buildings = current.base?.buildings.orEmpty(); clearWallPaint(); update { pickUpAll(it, buildings) } }
    /** The tray's wall chip toggles paint mode for that level and selects its first wall (web tray button). */
    fun toggleWallPaint(level: Int) {
        val first = currentEditorState().trayedWallGroups[level]?.firstOrNull() ?: return
        local.update { it.copy(wallPaintLevel = if (it.wallPaintLevel == level) null else level, wallTool = if (it.wallPaintLevel == level) null else LayoutWallTool.PAINT, wallPending = null, wallPreview = null, wallSelectedIds = emptyList(), wallEpoch = it.wallEpoch + 1, wallRefusal = null) }
        update { selectBuilding(it, first) }
    }
    fun clearWallPaint() { local.update { it.copy(wallPaintLevel = null, wallTool = null, wallPending = null, wallPreview = null, wallSelectedIds = emptyList(), wallEpoch = it.wallEpoch + 1, wallRefusal = null) } }
    fun selectTrayItem(id: String) {
        val current = currentEditorState()
        val wall = current.buildingsById[id]?.takeIf { it.type == "wall" && current.draft?.inTray(id) == true }
        local.update { it.copy(wallPaintLevel = wall?.level, wallTool = wall?.let { LayoutWallTool.PAINT }, wallPending = null, wallPreview = null, wallSelectedIds = emptyList(), wallEpoch = it.wallEpoch + 1, wallRefusal = null) }
        update { selectBuilding(it, id) }
    }

    fun setWallTool(tool: LayoutWallTool) {
        val current = currentEditorState()
        val paintLevel = current.local.wallPaintLevel ?: current.trayedWallGroups.keys.firstOrNull()
        local.update { it.copy(wallTool = tool, wallPaintLevel = if (tool == LayoutWallTool.PAINT) paintLevel else null,
            wallPending = null, wallPreview = null, wallSelectedIds = emptyList(), wallEpoch = it.wallEpoch + 1, wallRefusal = null, notice = null) }
    }

    /** Scene callbacks are proposals only. The ordinary BUILD repository is never called here. */
    fun wallStroke(event: WallStrokeEvent) {
        val current = currentEditorState()
        if (!canEdit(current)) return
        val binding = current.wallBinding ?: return
        if (current.wallStrokeMode?.token != event.token) return
        val tiles = when (event) { is WallStrokeEvent.Preview -> event.tiles; is WallStrokeEvent.Released -> event.tiles }.distinct()
        if (tiles.any { it !in binding.mode.validTiles }) {
            if (event is WallStrokeEvent.Released) { cancelWallStroke(); local.update { it.copy(wallRefusal = "WALL STROKE CHANGED — TRY AGAIN") } }
            return
        }
        val geometry = current.geometry ?: return
        val draft = current.draft ?: return
        if (binding.context.tool == LayoutWallTool.SELECT) {
            if (event is WallStrokeEvent.Released) {
                val ids = layoutWallSelection(draft, geometry, tiles)
                local.update { it.copy(wallSelectedIds = ids, wallTool = null, wallPaintLevel = null, wallPending = null, wallPreview = null, wallEpoch = it.wallEpoch + 1, notice = null) }
            }
            return
        }
        if (tiles.isEmpty()) {
            if (event is WallStrokeEvent.Released) cancelWallStroke() else local.update { it.copy(wallPreview = null) }
            return
        }
        val result = when (binding.context.tool) {
            LayoutWallTool.PAINT -> layoutPaintWalls(draft, geometry, binding.context.level ?: return, tiles)
            LayoutWallTool.ERASE -> eraseLayoutWalls(draft, geometry, tiles)
            LayoutWallTool.SELECT -> return
        }
        val affected = if (binding.context.tool == LayoutWallTool.PAINT) draft.trayIds.size - result.draft.trayIds.size else result.draft.trayIds.size - draft.trayIds.size
        val candidate = LayoutWallPending(event.token, binding.context, tiles.toList(), result, tiles.size, affected)
        if (event is WallStrokeEvent.Preview) local.update { it.copy(wallPreview = candidate) }
        else if (result.error != null || affected == 0) {
            cancelWallStroke(); local.update { it.copy(notice = result.error, wallRefusal = result.error) }
        } else local.update { it.copy(wallPending = candidate, wallPreview = null, wallRefusal = null, notice = null) }
    }

    fun cancelWallStroke() { local.update { it.copy(wallPending = null, wallPreview = null, wallRefusal = null, wallEpoch = it.wallEpoch + 1) } }
    fun pauseWallInput() { local.update { it.copy(wallInputPaused = true, wallPending = null, wallPreview = null, wallEpoch = it.wallEpoch + 1) } }
    fun resumeWallInput() { local.update { it.copy(wallInputPaused = false, wallPending = null, wallPreview = null, wallEpoch = it.wallEpoch + 1) } }

    fun confirmWallStroke() {
        val current = currentEditorState()
        val pending = current.wallPending
        if (pending == null) { cancelWallStroke(); return }
        local.update { it.copy(drafts = it.drafts + (current.slot to pending.result.draft), wallPending = null, wallPreview = null,
            wallEpoch = it.wallEpoch + 1, wallRefusal = null, notice = if (pending.affectedCount < pending.requestedCount) "${pending.affectedCount} OF ${pending.requestedCount} OWNED WALL TILES CHANGED" else null) }
    }

    /** Move the selected draft identities together, allowing each other's vacated tiles. */
    fun moveSelectedWallRun(dx: Int, dy: Int) {
        val current = currentEditorState()
        if (!canEdit(current)) return
        val draft = current.draft ?: return; val geometry = current.geometry ?: return
        apply(moveLayoutWallRun(draft, geometry, current.local.wallSelectedIds, dx, dy))
    }

    /** Web `unlockFarm`: the money op persists the key first; a lost reply is retried from the interrupted banner. */
    fun unlock() {
        if (local.value.busy != null || !state.value.deedActionsAllowed) return
        local.update { it.copy(busy = "unlock", notice = null) }
        run {
            try {
                val accepted = base.unlockFarmLayout()
                install(base.refreshLayouts(), preserve = true)
                local.update { it.copy(notice = if (accepted.chargedShards == "0") "${layoutSlotLabel("FARM")} WAS ALREADY UNLOCKED" else "${layoutSlotLabel("FARM")} UNLOCKED · ${accepted.chargedShards} SHARDS") }
            } catch (error: Exception) {
                if (error !is CancellationException) local.update { it.copy(notice = layoutErrorCopy(error)) }
                throw error
            } finally { local.update { it.copy(busy = null) } }
        }
    }
    /** Web `persist`: the complete inventory is validated locally, then saved or applied against the ETags read. */
    fun save(mode: String) {
        require(mode == "save" || mode == "save_apply")
        val current = currentEditorState()
        val data = current.layouts ?: return; val slot = current.currentSlot ?: return; val draft = current.draft ?: return; val geometry = current.geometry ?: return
        if (current.local.busy != null || !current.deedActionsAllowed || current.wallPending != null) return
        if (!current.keepPlaced) { local.update { it.copy(notice = "PLACE THE KEEP BEFORE SAVING") }; return }
        if (draft.trayIds.isNotEmpty()) { local.update { it.copy(notice = "PLACE EVERY TRAYED BUILDING BEFORE SAVING") }; return }
        validateCompleteLayout(geometry, draft.positions)?.let { invalid -> local.update { it.copy(notice = invalid) }; return }
        local.update { it.copy(busy = if (mode == "save") "save" else "apply", notice = null) }
        run {
            try {
                val result = base.saveLayout(slot.slot, mode, data.geometryVersion, slot.etag, if (mode == "save_apply") data.active.etag else null, draft.positions)
                install(base.refreshLayouts(), preserve = false)
                local.update { it.copy(notice = if (mode == "save_apply") "${slot.slot} APPLIED · ${result.moved} MOVED${if (result.replayed) " · REPLAY SAFE" else ""}" else "${slot.slot} SAVED${if (result.replayed) " · ALREADY CURRENT" else ""}") }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                local.update { it.copy(notice = layoutErrorCopy(error)) }
                if (error is ApiException && (error.code == "LAYOUT_STALE" || error.code == "LAYOUT_GEOMETRY_STALE")) runCatching { install(base.refreshLayouts(), preserve = false) }
                throw error
            } finally { local.update { it.copy(busy = null) } }
        }
    }
}
