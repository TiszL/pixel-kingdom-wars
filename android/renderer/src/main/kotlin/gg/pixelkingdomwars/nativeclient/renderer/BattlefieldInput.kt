package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.abs
import kotlin.math.floor

/** Frozen snapshot occupancy and generated shared policy. Cosmetic scenery never enters this set. */
data class BattlefieldInputPolicy(val version: Int, val legacyVersion: Int, val currentVersion: Int,
    val minimum: Int, val maximum: Int, val claimMin: Int, val claimMax: Int,
    val occupied: Set<Pair<Int, Int>>, val snapRadius: Int, val deploymentSquareTiles: Int? = null) {
    init {
        // These are protocol versions, not deployment dimensions. Archived v2 keeps its single-cell rule.
        require(version in setOf(legacyVersion, 2, 3) && version <= currentVersion) { "Unsupported battlefield version" }
        require(maximum > minimum && claimMax > claimMin && snapRadius >= 0)
        require(if (version == 3) deploymentSquareTiles != null && deploymentSquareTiles in 1..(maximum - minimum)
            else deploymentSquareTiles == null) { "Missing or incompatible deployment clearance" }
    }
    private fun free(x: Int, y: Int): Boolean = x >= minimum && y >= minimum && x < maximum && y < maximum &&
        (x to y) !in occupied

    fun legal(x: Int, y: Int): Boolean {
        if (!free(x, y) || version == legacyVersion && x > claimMin && x < claimMax - 1 && y > claimMin && y < claimMax - 1) return false
        val side = deploymentSquareTiles ?: return true
        // Any fully free square containing the tapped tile is sufficient; it is not a fixed top-left anchor.
        for (top in y - side + 1..y) for (left in x - side + 1..x) {
            if (left < minimum || top < minimum || left + side > maximum || top + side > maximum) continue
            var clear = true
            for (dy in 0 until side) for (dx in 0 until side) if (!free(left + dx, top + dy)) clear = false
            if (clear) return true
        }
        return false
    }

    /** Same source snapToDeployable ordering: direct tile, then distance, row, column. */
    fun nearest(x: Float, y: Float, visible: (Int, Int) -> Boolean = { _, _ -> true }): Pair<Int, Int>? {
        if (!x.isFinite() || !y.isFinite()) return null
        val tx = floor(x).toInt(); val ty = floor(y).toInt()
        // Off-field touches must not project back into the field.
        if (tx < minimum || ty < minimum || tx >= maximum || ty >= maximum) return null
        if (legal(tx, ty) && visible(tx, ty)) return tx to ty
        var best: Pair<Int, Int>? = null
        var distance = Double.POSITIVE_INFINITY
        for (cy in ty - snapRadius..ty + snapRadius) for (cx in tx - snapRadius..tx + snapRadius) {
            if (!legal(cx, cy) || !visible(cx, cy)) continue
            val dx = cx + .5 - x; val dy = cy + .5 - y
            val next = dx * dx + dy * dy
            if (next < distance - 1e-9) { best = cx to cy; distance = next }
        }
        return best
    }
}

/** Main owns selection/availability; GL owns contacts. A mode change cancels an old hold. */
data class BattleDeploymentTarget(val raidId: String, val kind: String, val unit: String)
data class BattleDeploymentMode(val identity: String, val holdMs: Long, val repeatMs: Long,
    val panThresholdPx: Float, val repeat: Boolean, val admission: Any = identity,
    val target: BattleDeploymentTarget? = null) {
    init { require(holdMs > 0 && repeatMs > 0 && panThresholdPx > 0 && panThresholdPx.isFinite()) }
}

/** A completed GL placement keeps the selection used to interpret its gesture. */
data class CompletedBattlePlacement(val mode: BattleDeploymentMode, val x: Float, val y: Float, val legal: Boolean)
fun dispatchBattlePlacement(placement: CompletedBattlePlacement, postToMain: (() -> Unit) -> Unit,
    currentAdmission: () -> Any?, isCurrent: () -> Boolean, receive: (CompletedBattlePlacement) -> Unit) {
    val delivered = java.util.concurrent.atomic.AtomicBoolean()
    postToMain {
        if (delivered.compareAndSet(false, true) && isCurrent() && currentAdmission() === placement.mode.admission) receive(placement)
    }
}

/** One contact can tap, pan, or hold-deploy. Missed frames never create a catch-up burst. */
class BattleDeploymentGesture {
    private enum class Phase { IDLE, PENDING, PAN, HOLD, CANCELLED }
    private var phase = Phase.IDLE
    private var mode: BattleDeploymentMode? = null
    private var downX = 0f
    private var downY = 0f
    private var due = 0L
    private var lastFrame = 0L
    fun down(x: Float, y: Float, nowMs: Long, value: BattleDeploymentMode?) {
        mode = value; downX = x; downY = y; due = nowMs + (value?.holdMs ?: 0); lastFrame = nowMs
        phase = if (value == null) Phase.PAN else Phase.PENDING
    }
    /** True permits camera movement; after a confirmed hold dragging only moves its deploy point. */
    fun move(x: Float, y: Float): Boolean {
        if (phase == Phase.PENDING && abs(x - downX) + abs(y - downY) > requireNotNull(mode).panThresholdPx) phase = Phase.PAN
        return phase == Phase.PAN
    }
    fun frame(nowMs: Long, value: BattleDeploymentMode?): Boolean {
        sync(value)
        val selected = mode ?: return false
        val gap = nowMs - lastFrame; lastFrame = nowMs
        if (phase != Phase.PENDING && phase != Phase.HOLD) return false
        if (gap > selected.repeatMs) {
            due = nowMs + if (phase == Phase.HOLD) selected.repeatMs else selected.holdMs
            return false
        }
        if (nowMs < due) return false
        phase = if (selected.repeat) Phase.HOLD else Phase.CANCELLED
        due = nowMs + selected.repeatMs
        return true
    }
    fun up(x: Float, y: Float): Boolean {
        move(x, y)
        val tap = phase == Phase.PENDING
        phase = Phase.IDLE; mode = null
        return tap
    }
    fun cancel() { phase = Phase.CANCELLED; mode = null }
    fun pan() { phase = Phase.PAN; mode = null }
    fun sync(value: BattleDeploymentMode?) {
        if ((phase == Phase.PENDING || phase == Phase.HOLD) && mode != value) cancel()
    }
}
