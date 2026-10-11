package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.abs
import kotlin.math.floor

data class CarryTile(val tx: Int, val ty: Int)
/** A tile-space footprint the app knows about: a current building (`id`) or an obstacle (`id == null`). */
data class CarryRect(val id: String?, val tx: Int, val ty: Int, val width: Int, val height: Int) {
    init { require(width > 0 && height > 0) }
    fun overlaps(tx: Int, ty: Int, width: Int, height: Int): Boolean =
        tx < this.tx + this.width && this.tx < tx + width && ty < this.ty + this.height && this.ty < ty + height
}
/** One piece's destination on release (web `base:move` / `base:moveLine` moves). */
data class CarryPiece(val id: String, val tx: Int, val ty: Int)

/** The web `BaseScene` hold-to-lift contract as the app admits it for one base: which buildings the player may
 * carry, the selected wall LINE (#61), the half-open claim `[plotMin, plotMax)` and every current footprint for the
 * local validity check (`isValidSpot` / `wallSpotFreeIgnoring`). `holds` are dropped tiles the app keeps until its
 * move settles (web `holdSettlingMove`); `settleEpoch` changes on every release the app has answered, which is when
 * the renderer's own post-drop hold hands over to `holds`. The renderer never validates or prices a move. */
data class CarryMode(val baseId: String, val movableIds: Set<String>, val lineIds: Set<String>, val plotMin: Int, val plotMax: Int,
    val occupied: List<CarryRect>, val holds: Map<String, CarryTile> = emptyMap(), val settleEpoch: Long = 0L) {
    init { require(baseId.isNotBlank() && plotMax > plotMin) }
    fun rect(id: String): CarryRect? = occupied.firstOrNull { it.id == id }
    /** Every carried piece inside the claim and clear of every footprint that is not itself moving. */
    fun fits(pieces: List<CarryPiece>, width: Int, height: Int): Boolean {
        val moving = pieces.mapTo(HashSet()) { it.id }
        return pieces.all { piece ->
            piece.tx >= plotMin && piece.ty >= plotMin && piece.tx + width <= plotMax && piece.ty + height <= plotMax &&
                occupied.none { it.id !in moving && it.overlaps(piece.tx, piece.ty, width, height) }
        }
    }
}

sealed interface CarryEvent {
    /** The hold elapsed still on a piece: the app buzzes (web `haptic('light')` in the HOLD_TO_LIFT_MS timer). Always
     * followed by exactly one [Released] or [Cancelled], so the app may hide map chrome for the lift. */
    data class Armed(val id: String) : CarryEvent
    data class Preview(val id: String, val tx: Int, val ty: Int, val valid: Boolean) : CarryEvent
    /** The carried pieces were put down; `valid` is the local check the app also sees in the footprint tint. */
    data class Released(val moves: List<CarryPiece>, val valid: Boolean) : CarryEvent
    /** The lift ended with nothing put down: a revert, or an armed press released without moving (still a tap). */
    data object Cancelled : CarryEvent
}

/** What the renderer draws for the gesture: lifted pieces ride above the world at alpha [LIFT_ALPHA]; held pieces
 * seat normally on their dropped tile. */
data class CarryVisual(val lifted: List<CarryPiece>, val liftedIds: Set<String>, val held: Map<String, CarryTile>)

/** Web `BaseScene` HOLD-TO-LIFT (owner 2026-08-01): a pointer that stays within [slopPixels] (manhattan, web
 * DRAG_THRESHOLD) of its press on a movable building for [HOLD_TO_LIFT_MS] arms a move; only then does movement
 * carry the piece by whole tiles. Crossing the slop before the hold elapses is a camera pan that happened to start
 * on a building. A release that never moved is still a tap. A second contact or a cancel reverts. Pure: time and
 * slop come from the caller. */
class BuildingCarryInput(private val emit: (CarryEvent) -> Unit, private val slopPixels: () -> Float) {
    private var mode: CarryMode? = null
    private val contacts = mutableSetOf<Int>()
    private var blocked = false
    private var press: Press? = null
    /** Pieces put down and not yet answered by the app (web `settlingMoves` before `base:moveSettled`). */
    private var selfHeld: Map<String, CarryTile> = emptyMap()
    private var selfHeldEpoch = 0L

    private class Press(val pointer: Int, val id: String, val startX: Float, val startY: Float, val downMs: Long,
        val origins: List<CarryPiece>, val width: Int, val height: Int) {
        var armed = false
        var moved = false
        var tile = CarryTile(origins.first().tx, origins.first().ty)
        fun pieces(): List<CarryPiece> {
            val dx = tile.tx - origins.first().tx; val dy = tile.ty - origins.first().ty
            return origins.map { CarryPiece(it.id, it.tx + dx, it.ty + dy) }
        }
    }

    val movableIds: Set<String> get() = mode?.movableIds.orEmpty()
    val visual: CarryVisual get() {
        val current = press?.takeIf { it.armed }
        val lifted = current?.pieces().orEmpty()
        return CarryVisual(lifted, lifted.mapTo(HashSet()) { it.id }, selfHeld + mode?.holds.orEmpty())
    }
    /** The plot grid and the carried footprint tint (web `drawPlacementGrid` / `showFootprintTint`) from the lift on: a long
     * press moves the building with the placement visuals (design buildings/SPEC.md §1.2 item 4, §4), so the player sees the
     * piece is held before the first tile. The web waited for the first move; owner demo 2026-10-06 asked for them at lift. */
    val highlights: List<SceneHighlight> get() {
        val m = mode ?: return emptyList(); val p = press?.takeIf { it.armed } ?: return emptyList()
        val size = (m.plotMax - m.plotMin).toFloat()
        val valid = m.fits(p.pieces(), p.width, p.height)
        return listOf(SceneHighlight(m.plotMin.toFloat(), m.plotMin.toFloat(), size, size, HighlightColors.INK, GRID_ALPHA, SceneHighlightKind.GRID)) +
            p.pieces().map { SceneHighlight(it.tx.toFloat(), it.ty.toFloat(), p.width.toFloat(), p.height.toFloat(), HighlightColors.footprint(valid), FOOTPRINT_ALPHA, SceneHighlightKind.FOOTPRINT) }
    }

    /** Admits the app's mode for this frame. A base refresh mid-gesture only replaces the occupancy the tint reads;
     * losing the mode, the base or the carried building reverts (web `cancelDrag`). */
    fun frame(next: CarryMode?, baseId: String?, battle: Boolean) {
        val admitted = next?.takeIf { !battle && it.baseId == baseId }
        if (admitted != mode) {
            if (selfHeld.isNotEmpty() && (admitted == null || admitted.settleEpoch != selfHeldEpoch)) selfHeld = emptyMap()
            mode = admitted
            val p = press
            if (p != null && (admitted == null || p.id !in admitted.movableIds || p.origins.any { admitted.rect(it.id) == null })) cancel()
        }
    }
    /** `hitId` is the movable building under the press, resolved by the caller from the drawn footprints. */
    fun down(pointer: Int, hitId: String?, x: Float, y: Float, nowMs: Long) {
        contacts.add(pointer)
        if (contacts.size > 1) { cancel(); blocked = true; return }
        val m = mode
        if (blocked || m == null || hitId == null || hitId !in m.movableIds || press != null) return
        val primary = m.rect(hitId) ?: return
        // #61: a wall of the selected LINE carries the whole line; members share the primary's footprint.
        val line = if (hitId in m.lineIds && m.lineIds.size > 1) m.lineIds.filter { it != hitId }.mapNotNull { m.rect(it) } else emptyList()
        press = Press(pointer, hitId, x, y, nowMs, (listOf(primary) + line).map { CarryPiece(requireNotNull(it.id), it.tx, it.ty) }, primary.width, primary.height)
    }
    /** Per-frame clock: the still-held press arms at [HOLD_TO_LIFT_MS] (the web's delayed cue). */
    fun tick(nowMs: Long) {
        val p = press ?: return
        if (!p.armed && nowMs - p.downMs >= HOLD_TO_LIFT_MS) { p.armed = true; emit(CarryEvent.Armed(p.id)) }
    }
    /** True when this move belongs to the press: a still press below the slop, or a carry. False hands the move to
     * the camera, including the swipe that breached the slop before the hold elapsed (the press is dropped). */
    fun move(pointer: Int, x: Float, y: Float, tileX: Float, tileY: Float, nowMs: Long): Boolean {
        val p = press ?: return false
        if (p.pointer != pointer || blocked) return false
        val m = mode ?: return false
        if (!p.moved) {
            val manhattan = abs(x - p.startX) + abs(y - p.startY)
            if (manhattan <= slopPixels()) return true
            if (!p.armed && nowMs - p.downMs < HOLD_TO_LIFT_MS) { press = null; return false }
            if (!p.armed) { p.armed = true; emit(CarryEvent.Armed(p.id)) }
            p.moved = true
        }
        if (!tileX.isFinite() || !tileY.isFinite()) return true
        // Web: Math.round(world / T - fw / 2) clamped into the plot (`clampPlotPosition`); the line follows by delta.
        val tx = floor(tileX - p.width / 2f + .5f).toInt().coerceIn(m.plotMin, m.plotMax - p.width)
        val ty = floor(tileY - p.height / 2f + .5f).toInt().coerceIn(m.plotMin, m.plotMax - p.height)
        val tile = CarryTile(tx, ty)
        if (tile != p.tile) { p.tile = tile; emit(CarryEvent.Preview(p.id, tx, ty, m.fits(p.pieces(), p.width, p.height))) }
        return true
    }
    /** True when the release ended a carry (never a tap). A press that never moved stays a tap for the caller; if it
     * had armed, the lift is called off first, so every [CarryEvent.Armed] ends in one `Released` or `Cancelled`. */
    fun up(pointer: Int, nowMs: Long): Boolean {
        contacts.remove(pointer)
        val p = press?.takeIf { it.pointer == pointer }
        if (p != null) press = null
        if (contacts.isEmpty()) blocked = false
        val m = mode
        if (p == null) return false
        if (!p.moved || m == null) { if (p.armed) emit(CarryEvent.Cancelled); return false }
        val pieces = p.pieces()
        val valid = m.fits(pieces, p.width, p.height)
        if (valid) { selfHeld = pieces.associate { it.id to CarryTile(it.tx, it.ty) }; selfHeldEpoch = m.settleEpoch }
        emit(CarryEvent.Released(pieces, valid))
        return true
    }
    /** Reverts any carry (web `cancelDrag`); the lifted pieces return to their origin on the next frame. */
    fun cancel(pointer: Int? = null) {
        if (pointer != null) contacts.remove(pointer)
        val p = press; press = null
        if (p != null && p.armed) emit(CarryEvent.Cancelled)
        blocked = contacts.isNotEmpty()
    }
    /** Platform pause/disposal ends the entire contact stream. */
    fun reset() { cancel(); contacts.clear(); blocked = false }

    companion object {
        /** Web HOLD_TO_LIFT_MS. */
        const val HOLD_TO_LIFT_MS = 200L
        /** Web DRAG_THRESHOLD (12 logical px @2x) in dp. */
        const val SLOP_DP = 6f
        /** Web LIFT_ALPHA: the lifted-ghost feedback. */
        const val LIFT_ALPHA = 0.95f
        /** Web `showFootprintTint` / `drawPlacementGrid` alphas (the app's `BaseGeometry` uses the same values). */
        const val FOOTPRINT_ALPHA = 0.35f
        const val GRID_ALPHA = 0.12f
    }
}
