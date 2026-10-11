package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.model.ArmyStatus
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.CarryEvent
import gg.pixelkingdomwars.nativeclient.renderer.HpBars
import gg.pixelkingdomwars.nativeclient.renderer.RenderBuilding
import java.time.Instant
import kotlin.math.ceil
import kotlin.math.roundToInt

/** Owner 2026-09-19 ("black floating box displays army data; it should be well implemented over camps and
 * barracks"): army information lives ON the building it belongs to, as one small forged chip, never as an
 * aggregated block over the map. Everything here is pure: which building carries a chip, what it reads, and
 * where it sits. Every number is the server's `armyStatus` as sent; the client computes no cap. */
internal enum class ArmyChipKind { CAMP, BARRACKS }
internal enum class ArmyChipTone { NORMAL, FULL, OVER, TRAINING }

/** [labels] run from the richest wording to the most compact; the layout takes the first that fits its building. */
internal data class ArmyChip(val buildingId: String, val kind: ArmyChipKind, val tone: ArmyChipTone,
    val labels: List<List<String>>, val aboveJob: Boolean, val description: String)

/** What the Home scene is doing. A chip never competes with a mode that owns the map or with its own sheet. */
internal data class ArmyChipScene(val home: Boolean, val editing: Boolean = false, val placing: Boolean = false,
    val carrying: Boolean = false, val sheetBuildingId: String? = null, val movingIds: Set<String> = emptySet())

/** [ArmyChipScene.carrying] after [event]: a hold-to-lift owns the map from its lift cue until the gesture's terminal
 * event. The renderer owes every `Armed` exactly one `Released` or `Cancelled`, including the slow tap that armed
 * and lifted without moving; a missing one left the chips hidden until the next carry. */
internal fun carryOwnsMap(current: Boolean, event: CarryEvent): Boolean = when (event) {
    is CarryEvent.Armed -> true
    is CarryEvent.Released, CarryEvent.Cancelled -> false
    is CarryEvent.Preview -> current
}

/** Ground and footprint callbacks describe the same tap. Once a chip claims it, an adjacent building underneath
 * must not replace that selection. A new ground tap also clears a claim that had no footprint callback. */
internal class ArmyChipTapClaim {
    private var claimed = false
    private var downChip: String? = null
    fun down(chipId: String?) { downChip = chipId; claimed = false }
    /** Only called after the renderer classified the completed gesture as a tap; pans never consume a target. */
    fun takeDownChip(): String? = downChip.also { downChip = null }
    fun ground(chipId: String?) { claimed = chipId != null }
    fun allowFootprint(): Boolean = (!claimed).also { claimed = false }
    /** A scene-tap owner took this tap ([sceneTapConsumed], MS-C3): the chip seen at pointer-down is dropped and the same
     *  tap's footprint callback is refused, so the tap mutates nothing; the next [down] starts clean. */
    fun consume() { downChip = null; claimed = true }
}

/** Server deadlines wake Home even without a catalogue polling cadence. Observe the next training completion,
 * not only the end of the whole queue, so the readout and camp bodies update as each troop becomes ready. */
internal fun homeRefreshDeadline(base: BaseSnapshot?): Long? {
    val army = base?.armyStatus?.takeIf { it.trainingTroopCount > 0 }
    return (base?.jobs.orEmpty().map { it.finishesAt } + listOf(army?.nextReadyAt, army?.allReadyAt))
        .mapNotNull { it?.let { at -> runCatching { Instant.parse(at).toEpochMilli() }.getOrNull() } }.minOrNull()
}

/** Housing and the training queue are base-wide pools (`armyStatus`), so ONE building of a kind carries the chip:
 * the highest level, then the lowest id. Identical numbers on every camp would litter the map, a dot on the others
 * would be a mark nobody can read, and neither key changes when a building is moved, so the chip never hops
 * during a drag. A building still under construction holds nothing yet. */
internal fun armyChipCarrier(buildings: List<Building>, type: String): Building? =
    buildings.filter { it.type == type && !it.underConstruction }.sortedWith(compareByDescending<Building> { it.level }.thenBy { it.id }).firstOrNull()

/** Buildings the drawn scene has not caught up with: a finished move is re-mapped off Main, and for those frames
 * the scene still holds the old tile. The chip waits rather than sit where its building was. */
internal fun unsettledIds(base: BaseSnapshot?, drawn: List<RenderBuilding>): Set<String> {
    val tiles = drawn.associate { it.id to (it.tileX.toInt() to it.tileY.toInt()) }
    return base?.buildings.orEmpty().filter { tiles[it.id] != (it.tx to it.ty) }.mapTo(HashSet()) { it.id }
}

internal fun armyChips(base: BaseSnapshot?, nowMs: Long, scene: ArmyChipScene): List<ArmyChip> {
    val status = base?.armyStatus ?: return emptyList()
    if (!scene.home || scene.editing || scene.placing || scene.carrying) return emptyList()
    val jobs = base.jobs.mapNotNullTo(HashSet()) { it.buildingId }
    fun shown(building: Building?) = building?.takeIf { it.id != scene.sheetBuildingId && it.id !in scene.movingIds }
    return listOfNotNull(
        shown(armyChipCarrier(base.buildings, "camp"))?.let { campChip(it.id, status, it.id in jobs) },
        // An idle Barracks says nothing: the chip exists only while the server reports troops in training.
        shown(armyChipCarrier(base.buildings, "barracks"))?.takeIf { status.trainingTroopCount > 0 }?.let { barracksChip(it.id, status, nowMs, it.id in jobs) })
}

/** Queued troops already reserve their housing (the server refuses training past it), so they count as used. */
internal fun campChip(buildingId: String, status: ArmyStatus, aboveJob: Boolean = false): ArmyChip {
    val used = status.readyPts + (status.trainingPts ?: 0); val capacity = status.campCapacityPts
    val numbers = "$used/$capacity"
    return when {
        used > capacity -> ArmyChip(buildingId, ArmyChipKind.CAMP, ArmyChipTone.OVER, listOf(listOf("OVER $numbers"), listOf("OVER")), aboveJob, "Army housing over capacity, $used of $capacity points")
        capacity > 0 && used == capacity -> ArmyChip(buildingId, ArmyChipKind.CAMP, ArmyChipTone.FULL, listOf(listOf("FULL $numbers"), listOf("FULL")), aboveJob, "Army housing full, $used of $capacity points")
        else -> ArmyChip(buildingId, ArmyChipKind.CAMP, ArmyChipTone.NORMAL, listOf(listOf(numbers)), aboveJob, "Army housing, $used of $capacity points")
    }
}

/** The countdown is the shared `fmtDur` (days above 24 h, never m:ss: that is the battle clock's alone). Only a
 * server refresh can complete the queue; an elapsed or unreadable deadline says VERIFYING meanwhile. */
internal fun barracksChip(buildingId: String, status: ArmyStatus, nowMs: Long, aboveJob: Boolean = false): ArmyChip {
    val count = status.trainingTroopCount
    val left = status.allReadyAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        ?.let { ceil((it - nowMs) / 1000.0).toLong() }?.takeIf { it > 0 }?.let(::fmtDur) ?: "VERIFYING"
    val queue = status.trainingPts?.let { used -> status.barracksQueuePts?.let { "$used/$it" } }
    val head = "$count TRAINING"
    val labels = listOfNotNull(queue?.let { listOf("$head · $left · $it") }, listOf("$head · $left"), listOf(head, left), listOf("$count", left))
    return ArmyChip(buildingId, ArmyChipKind.BARRACKS, ArmyChipTone.TRAINING, labels, aboveJob,
        "$count troops training, " + if (left == "VERIFYING") "verifying completion" else "all ready in $left")
}

/** Chip metrics in dp at scale 1. VT323 is monospace: every glyph advances 0.4 em (`hmtx` 400 of 1000 units), so a
 * label's width is known before it is drawn and the fit below is exact rather than a guess. */
internal object ArmyChipMetrics {
    const val FONT_SP = 12f
    const val CHAR_EM = .4f
    const val ICON_DP = 9f
    const val ICON_GAP_DP = 2f
    const val PAD_H_DP = 4f
    const val PAD_V_DP = 2f
    /** A chip is never wider than this share of its building's footprint on screen while a shorter wording exists. */
    const val FOOTPRINT_SHARE = 1.2f
    /** The most the last wording may shrink to meet that share; below this the text stops being legible. */
    const val MIN_FIT = .85f
    /** Web `armyStatusChipScale`: a constant size on screen from claim-fit zoom up to this many dp per world pixel,
     * then growing with the world so a close zoom is not dominated by a fixed plate, and shrinking with it below FAR. */
    const val CLOSE_ZOOM = .72f / .7f
    const val FAR_ZOOM = .72f / 5.25f
    /** A footprint this small on screen is a miniature base; a chip there would only cover its neighbours. */
    const val MIN_FOOTPRINT_DP = 8f
    const val MIN_GAP_DP = 2f
    const val SCALE_STEP = .05f
}

/** [zoom] is dp per world pixel. */
internal fun armyChipScale(zoom: Float): Float = when {
    !zoom.isFinite() || zoom <= 0 -> 1f
    zoom > ArmyChipMetrics.CLOSE_ZOOM -> zoom / ArmyChipMetrics.CLOSE_ZOOM
    zoom < ArmyChipMetrics.FAR_ZOOM -> zoom / ArmyChipMetrics.FAR_ZOOM
    else -> 1f
}

/** The icon leads the first line; a second line is centred beneath it. */
internal fun armyChipWidthDp(label: List<String>, scale: Float, fontScale: Float): Float {
    val char = ArmyChipMetrics.FONT_SP * fontScale * ArmyChipMetrics.CHAR_EM
    val first = ArmyChipMetrics.ICON_DP + ArmyChipMetrics.ICON_GAP_DP + label.first().length * char
    val rest = label.drop(1).maxOfOrNull { it.length * char } ?: 0f
    return (2 * ArmyChipMetrics.PAD_H_DP + maxOf(first, rest)) * scale
}

internal data class ArmyChipLayout(val label: List<String>, val scale: Float)

/** The richest wording that stays within [ArmyChipMetrics.FOOTPRINT_SHARE] of the footprint; when even the most
 * compact one is wider it shrinks, but never past legibility. Null hides the chip. */
internal fun armyChipLayout(chip: ArmyChip, footprintDp: Float, zoom: Float, fontScale: Float): ArmyChipLayout? {
    if (!footprintDp.isFinite() || footprintDp < ArmyChipMetrics.MIN_FOOTPRINT_DP) return null
    val scale = armyChipScale(zoom); val budget = footprintDp * ArmyChipMetrics.FOOTPRINT_SHARE
    chip.labels.firstOrNull { armyChipWidthDp(it, scale, fontScale) <= budget }?.let { return ArmyChipLayout(it, quantized(scale)) }
    val compact = chip.labels.last()
    val fit = (budget / armyChipWidthDp(compact, scale, fontScale)).coerceIn(ArmyChipMetrics.MIN_FIT, 1f)
    return ArmyChipLayout(compact, quantized(scale * fit))
}
/** Floors to a step, so a pinch re-styles the text a few times rather than every frame and never rounds a fit back over its budget. */
private fun quantized(scale: Float) = (kotlin.math.floor(scale / ArmyChipMetrics.SCALE_STEP + 1e-3f) * ArmyChipMetrics.SCALE_STEP).coerceAtLeast(ArmyChipMetrics.SCALE_STEP)

/** World pixels: the footprint's horizontal centre and width, and the top of the building's PAINTED pixels (its
 * cell carries transparent rows above the roof, which would leave the chip floating over nothing). */
internal data class ArmyChipAnchor(val centerX: Float, val roofY: Float, val footprintWidth: Float)

/** Top-left of a chip [width]×[height] px, centred above its roof. The gap is the building-bar lift the battle
 * already uses over a sprite top ([HpBars.Kind.BUILDING]); a job chip on the same building wins the roof and the
 * army chip stacks above its band. Null while no base frame is drawn (loading, battle, scout, preview). */
internal fun armyChipOffset(view: BaseCameraView?, anchor: ArmyChipAnchor, width: Int, height: Int, tilePixels: Float,
    minGapPx: Float, jobBandPx: Float): Pair<Int, Int>? {
    if (view == null || !view.overlayVisible) return null
    val gap = maxOf(minGapPx, HpBars.Kind.BUILDING.lift * tilePixels / HpBars.WEB_TILE_WORLD_PX * view.scale)
    return (view.screenX(anchor.centerX) - width / 2f).roundToInt() to (view.screenY(anchor.roofY) - gap - jobBandPx - height).roundToInt()
}
