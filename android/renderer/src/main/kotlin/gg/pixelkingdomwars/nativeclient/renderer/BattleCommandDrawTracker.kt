package gg.pixelkingdomwars.nativeclient.renderer

/** Optional, in-memory diagnostics only. Aliases are local counters, never command IDs.
 * Copy on admission prevents a newer presentation from rebinding an older scene. */
class BattleCommandDrawPlan(val lease: Long, val raidId: String, val revision: String, aliasesByActor: Map<Int, Long>) {
    val aliasesByActor: Map<Int, Long> = java.util.Collections.unmodifiableMap(
        if (aliasesByActor.size <= MAX_ALIASES) HashMap(aliasesByActor) else HashMap())
    companion object {
        /** A diagnostics memory bound matching the local input ring; not a gameplay limit. */
        const val MAX_ALIASES = 128
    }
}

/** A successful graphics submission, not display/compositor presentation or occlusion proof. */
data class BattleCommandBodySubmission(val lease: Long, val raidId: String, val revision: String, val aliases: List<Long>)

/** GL-thread only. A failed/endless frame can never consume an alias; only [submitted]
 * after the successful body batch may do so. Work is bounded by the admitted alias map. */
internal class BattleCommandDrawTracker private constructor(private val plan: BattleCommandDrawPlan, private val generation: Long) {
    private val consumed = HashSet<Int>()
    private val pending = LinkedHashSet<Int>()
    fun beginFrame() { pending.clear() }
    fun needs(actorId: Int) = actorId in plan.aliasesByActor && actorId !in consumed && actorId !in pending
    fun drawn(actorId: Int, alive: Boolean, alpha: Float, visible: Boolean) {
        if (alive && alpha.isFinite() && alpha > 0f && visible && needs(actorId)) pending += actorId
    }
    fun submitted(currentGeneration: Long, raidId: String, revision: String, active: Boolean): BattleCommandBodySubmission? {
        if (!active || generation != currentGeneration || plan.raidId != raidId || plan.revision != revision) {
            pending.clear(); return null
        }
        if (pending.isEmpty()) return null
        val aliases = pending.map { plan.aliasesByActor.getValue(it) }
        consumed += pending; pending.clear()
        return BattleCommandBodySubmission(plan.lease, plan.raidId, plan.revision, aliases)
    }
    companion object {
        fun create(plan: BattleCommandDrawPlan?, generation: Long, raidId: String, revision: String): BattleCommandDrawTracker? {
            if (plan == null || plan.lease < 0 || plan.raidId != raidId || plan.revision != revision ||
                plan.aliasesByActor.isEmpty() || plan.aliasesByActor.any { it.key < 0 || it.value <= 0 } ||
                plan.aliasesByActor.values.toSet().size != plan.aliasesByActor.size) return null
            return BattleCommandDrawTracker(plan, generation)
        }
    }
}

/** Corners of the actual trimmed/cropped body quad after the current orthographic
 * projection (including camera shake). Merely touching a viewport edge is not visible. */
internal fun commandBodyIntersectsClip(x1: Float, y1: Float, x2: Float, y2: Float): Boolean =
    x1.isFinite() && y1.isFinite() && x2.isFinite() && y2.isFinite() && x1 != x2 && y1 != y2 &&
        minOf(x1, x2) < 1f && maxOf(x1, x2) > -1f && minOf(y1, y2) < 1f && maxOf(y1, y2) > -1f

/** Mirrors the renderer's unrotated draw quad, including trim, clipping and flip.
 * Unsupported rotations remain unmeasured instead of claiming offscreen bodies. */
internal fun commandBodyIntersectsViewport(art: Art, placement: SpritePlacement, sourceWidth: Float,
    trimX: Float, trimY: Float, width: Float, height: Float, projection: com.badlogic.gdx.math.Matrix4,
    corner: com.badlogic.gdx.math.Vector3): Boolean {
    if (art.rotation != 0f || art.horizontalScale <= 0f || art.scale <= 0f) return false
    val drawnWidth = minOf(width, art.cropWidth / art.horizontalScale - trimX)
    if (drawnWidth <= 0f) return false
    val x = placement.left + (if (art.flipX) sourceWidth - trimX else trimX) * art.horizontalScale
    val y = placement.top + trimY * art.scale
    corner.set(x, y, 0f).prj(projection)
    val x1 = corner.x; val y1 = corner.y
    corner.set(x + drawnWidth * art.horizontalScale * if (art.flipX) -1f else 1f,
        y + height * art.scale, 0f).prj(projection)
    return commandBodyIntersectsClip(x1, y1, corner.x, corner.y)
}
