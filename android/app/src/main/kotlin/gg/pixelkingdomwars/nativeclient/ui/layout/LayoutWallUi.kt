package gg.pixelkingdomwars.nativeclient.ui.layout

import gg.pixelkingdomwars.nativeclient.model.LayoutPosition

/** Presentation-only contract for Opus. Null blockedCount is unknown: the shared sampler emits
 * admitted cells only, so the client cannot honestly reconstruct how many blocked cells were touched. */
data class LayoutWallProposalUi(val sampledCount: Int, val affectedCount: Int, val wallsLeftAtLevel: Int?, val blockedCount: Int? = null)
data class LayoutWallEditorUi(
    val slotIds: List<String>,
    val activeSlot: String,
    val ownedWallCount: Int,
    val placedWallCount: Int,
    val trayedWallCount: Int,
    val tool: LayoutWallTool?,
    val paintLevel: Int?,
    val availableAtLevel: Int,
    val selectedRunCount: Int,
    val proposal: LayoutWallProposalUi?,
    val requiresConfirmation: Boolean,
    val undoCount: Int,
    val changeCount: Int,
    val canSave: Boolean,
    val refusal: String?,
    val notice: String?,
)

fun layoutWallEditorUi(state: LayoutEditorState): LayoutWallEditorUi {
    val walls = state.buildingsById.values.filter { it.type == "wall" }.map { it.id }.toSet()
    val draft = state.draft
    val level = state.local.wallPaintLevel
    val available = level?.let { state.trayedWallGroups[it] }.orEmpty().size
    val candidate = state.wallPending ?: state.local.wallPreview?.takeIf { it.token == state.wallBinding?.mode?.token }
    val proposal = candidate?.let {
        LayoutWallProposalUi(it.requestedCount, it.affectedCount,
            if (it.context.tool == LayoutWallTool.PAINT) (available - it.affectedCount).coerceAtLeast(0) else null)
    }
    val initial = if (state.currentSlot?.compatibility == "ready") state.currentSlot?.positions.orEmpty()
        else state.base?.buildings.orEmpty().map { LayoutPosition(it.id, it.tx, it.ty) }
    val old = initial.associateBy { it.buildingId }
    val next = draft?.positions.orEmpty().associateBy { it.buildingId }
    val changed = if (draft == null) 0 else (old.keys + next.keys).count { old[it] != next[it] }
    return LayoutWallEditorUi(state.layouts?.slots.orEmpty().map { it.slot }, state.slot, walls.size,
        draft?.positions.orEmpty().count { it.buildingId in walls }, draft?.trayIds.orEmpty().count { it in walls },
        state.local.wallTool, level, available, state.local.wallSelectedIds.size, proposal, state.wallPending != null,
        draft?.history.orEmpty().size, changed, state.open && !state.saveDisabled, state.local.wallRefusal, state.local.notice)
}
