package gg.pixelkingdomwars.nativeclient.ui.layout

import androidx.compose.ui.unit.IntOffset
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.EditorSaveState
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.EditorTool
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.LayoutEditorActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.LayoutEditorUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.LayoutSlotUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.WallLevelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.WallStrokeUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.saveLook

/** Opus 4a51f17a editor chrome only. The host retains building controls and supplies any real anchor/hint flag. */
fun LayoutEditorState.layoutEditorUi(anchor: IntOffset?, showHint: Boolean): LayoutEditorUi {
    val walls = wallUi
    fun art(level: Int?): String = if (level == null || catalogue == null) "building-wall"
        else sheetBuildingPortrait(requireNotNull(catalogue), "wall", level)
    val reason = editorSaveBlockedReason()
    return LayoutEditorUi(
        slots = layouts?.slots.orEmpty().filter { it.slot == "HOME" || it.slot == "FARM" }.map {
            LayoutSlotUi(it.slot, it.slot, enabled = !it.locked && editorContextAvailable() && wallPending == null)
        },
        activeSlot = walls.activeSlot,
        ownedWalls = walls.ownedWallCount.takeIf { base != null },
        trayedWalls = walls.trayedWallCount.takeIf { draft != null },
        tool = when (walls.tool) {
            LayoutWallTool.PAINT -> EditorTool.WALLS
            LayoutWallTool.ERASE -> EditorTool.ERASE
            LayoutWallTool.SELECT -> EditorTool.MOVE
            null -> null
        },
        paintLevel = walls.paintLevel,
        wallLevels = trayedWallGroups.map { (level, ids) -> WallLevelUi(level, art(level), ids.size) },
        wallArt = art(walls.paintLevel),
        stroke = walls.proposal?.let { WallStrokeUi(it.affectedCount, it.sampledCount, it.wallsLeftAtLevel, walls.requiresConfirmation, anchor) },
        selectedRunCount = walls.selectedRunCount,
        undoCount = walls.undoCount,
        changeCount = walls.changeCount,
        canSave = walls.canSave && reason == null,
        saveBlockedReason = reason,
        // The existing owner exposes no uncertain-save state. An arbitrary error is not CHECKING.
        saveState = if (local.busy == "save" || local.busy == "apply") EditorSaveState.SAVING else EditorSaveState.IDLE,
        refusal = walls.refusal,
        notice = walls.notice ?: local.loadError,
        showHint = showHint,
        discardOpen = local.discardOpen,
        discardMessage = "Unsaved layout drafts will be discarded. Your saved layouts stay as they were.",
    )
}

private fun LayoutEditorState.editorContextAvailable(): Boolean =
    open && local.busy == null && !local.wallInputPaused && !local.discardOpen && deedActionsAllowed

private fun LayoutEditorState.editorControlsAvailable(allowPending: Boolean = false): Boolean =
    editorContextAvailable() && !locked && draft != null && geometry != null && (allowPending || wallPending == null)

private fun LayoutEditorState.editorSaveBlockedReason(): String? = when {
    !open -> "Open the layout editor first"
    base == null || layouts == null -> local.loadError ?: "Layout data is unavailable"
    !deedActionsAllowed -> "Layout editing is unavailable"
    locked -> "This layout is locked"
    draft == null || geometry == null -> local.loadError ?: "Layout data is unavailable"
    local.busy != null -> "A layout action is in progress"
    local.wallInputPaused -> "Layout input is paused"
    local.discardOpen -> "Finish the discard confirmation first"
    wallPending != null -> "Keep or drop the wall run before saving"
    !keepPlaced -> "Place the Keep first"
    draft!!.trayIds.isNotEmpty() -> "Place every stored building before saving"
    else -> null
}

/** UI dispatch reads the owner’s synchronous snapshot; model methods retain token and persistence admission.
 * The injected BUILD-more callback is navigation, never purchase. C owns host lifetime and scene callbacks. */
fun layoutEditorActions(model: LayoutEditorViewModel, onBuildMore: () -> Unit, onExplain: (String) -> Unit,
    onDiscarded: (() -> Unit)? = null, onDiscardCancelled: (() -> Unit)? = null): LayoutEditorActions {
    fun edit(allowPending: Boolean = false, action: () -> Unit) {
        if (model.currentEditorState().editorControlsAvailable(allowPending)) action()
    }
    return LayoutEditorActions(
        onClose = model::close,
        onSlot = { id ->
            val state = model.currentEditorState()
            if (state.editorContextAvailable() && state.wallPending == null && id in setOf("HOME", "FARM") &&
                state.layouts?.slot(id)?.locked == false) model.selectSlot(id)
        },
        onPaint = { edit { model.setWallTool(LayoutWallTool.PAINT) } },
        onErase = { edit { model.setWallTool(LayoutWallTool.ERASE) } },
        onSelectRun = { edit { model.setWallTool(LayoutWallTool.SELECT) } },
        onPan = { edit { model.clearWallPaint() } },
        onPaintLevel = { level -> edit { model.toggleWallPaint(level) } },
        onConfirm = { edit(allowPending = true) { model.confirmWallStroke() } },
        onCancel = { if (model.currentEditorState().open && model.currentEditorState().local.busy == null) model.cancelWallStroke() },
        onUndo = { edit(allowPending = true) { model.undo() } },
        onMove = { dx, dy -> edit { model.moveSelectedWallRun(dx, dy) } },
        onSave = {
            val ui = model.currentEditorState().layoutEditorUi(anchor = null, showHint = false)
            if (saveLook(ui.changeCount, ui.canSave, ui.stroke?.pending == true, ui.saveState, ui.saveBlockedReason).sends)
                model.save("save")
        },
        onConfirmDiscard = { if (model.currentEditorState().local.discardOpen) (onDiscarded ?: model::confirmDiscard).invoke() },
        onCancelDiscard = { if (model.currentEditorState().local.discardOpen) (onDiscardCancelled ?: model::cancelDiscard).invoke() },
        onBuildMore = { edit(allowPending = true, action = onBuildMore) },
        onExplain = onExplain,
    )
}

/** Compatibility controls retained beside the wall kit; no shared kit model or saveLook rule changes. */
data class LayoutEditorCompatibilityUi(
    val showSavePreset: Boolean,
    val canSavePreset: Boolean,
    val canSaveApply: Boolean,
    val showLockedFarm: Boolean,
    val canOpenLockedFarm: Boolean,
    val canEditBuildings: Boolean,
)

fun LayoutEditorState.layoutEditorCompatibilityUi(): LayoutEditorCompatibilityUi {
    val preset = draft?.dirty == true && currentSlot?.compatibility in setOf("empty", "needs_repair") &&
        wallUi.changeCount == 0
    val save = !saveDisabled && editorSaveBlockedReason() == null
    val lockedFarm = layouts?.slot("FARM")?.locked == true && slot != "FARM"
    return LayoutEditorCompatibilityUi(
        showSavePreset = preset,
        canSavePreset = preset && save,
        canSaveApply = save,
        showLockedFarm = lockedFarm,
        canOpenLockedFarm = lockedFarm && editorContextAvailable() && wallPending == null,
        canEditBuildings = editorControlsAvailable(),
    )
}

class LayoutEditorCompatibilityActions(
    val onSavePreset: () -> Unit,
    val onSaveApply: () -> Unit,
    val onLockedFarm: () -> Unit,
    val onPickUpAll: () -> Unit,
    val onNudge: (Int, Int) -> Unit,
    val onMoveToTray: () -> Unit,
    val onTrayItem: (String) -> Unit,
)

/** Never trust a rendered enabled flag after a queued pause, confirmation or deed change. */
fun layoutEditorCompatibilityActions(model: LayoutEditorViewModel): LayoutEditorCompatibilityActions {
    fun edit(action: (LayoutEditorState) -> Unit) {
        val state = model.currentEditorState()
        if (state.editorControlsAvailable()) action(state)
    }
    return LayoutEditorCompatibilityActions(
        onSavePreset = {
            if (model.currentEditorState().layoutEditorCompatibilityUi().canSavePreset) model.save("save")
        },
        onSaveApply = {
            if (model.currentEditorState().layoutEditorCompatibilityUi().canSaveApply) model.save("save_apply")
        },
        // Opens the retained recovery presentation only. Its existing explicit unlock flow remains separate.
        onLockedFarm = {
            if (model.currentEditorState().layoutEditorCompatibilityUi().canOpenLockedFarm) model.selectSlot("FARM")
        },
        onPickUpAll = { edit { model.pickUpAll() } },
        onNudge = { dx, dy -> edit { state -> if (state.selected != null && !state.selectedInTray) model.nudge(dx, dy) } },
        onMoveToTray = { edit { state -> if (state.selected != null && !state.selectedInTray) model.moveSelectedToTray() } },
        onTrayItem = { id -> edit { state ->
            if (id in state.draft!!.trayIds && id in state.buildingsById) model.selectTrayItem(id)
        } },
    )
}

/** Short-screen tools occupy a side column; their height must never be subtracted from the scene twice. */
fun layoutEditorCameraInsets(
    safe: gg.pixelkingdomwars.nativeclient.renderer.CameraInsets,
    kitTop: Int,
    kitBottom: Int,
    statusHeight: Int,
    panel: androidx.compose.ui.unit.IntSize,
    sidePanel: Boolean,
): gg.pixelkingdomwars.nativeclient.renderer.CameraInsets =
    gg.pixelkingdomwars.nativeclient.renderer.CameraInsets(
        left = safe.left + if (sidePanel) panel.width else 0,
        right = safe.right,
        top = safe.top + kitTop + statusHeight,
        bottom = safe.bottom + kitBottom + if (sidePanel) 0 else panel.height,
    )


/** Both columns include safe drawing insets. Fall back to the footer unless every control fits. */
fun layoutEditorSidePanelWidth(widthDp: Float, horizontalInsetDp: Float, short: Boolean): Float? {
    if (!short) return null
    // Nudge row: four 48dp controls + three 4dp gaps + 20dp padding. Kit strip minimum: 326dp.
    val panel = minOf(280f, widthDp - horizontalInsetDp - 326f)
    return panel.takeIf { it >= 224f + horizontalInsetDp }
}
