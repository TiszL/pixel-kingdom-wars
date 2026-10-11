package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.*
import com.badlogic.gdx.utils.JsonValue

internal data class CampPoint(val x: Float, val y: Float)
internal data class CampPath(val points: List<CampPoint>, val facings: List<String>)

/** Source occupancy.ts: feet occupy tiles; walls, buildings and real obstacles block
 * every route. Scenery does not. Route trees are prepared off the graphics thread. */
internal class CampOccupancy(private val scene: BaseScene, private val checkpoint: () -> Unit = {}) {
    private val n = scene.columns
    private val h = scene.rows
    private val tile = scene.tilePixels
    private val minX = scene.minimumTileX
    private val minY = scene.minimumTileY
    private val blocked = BooleanArray(n * h)
    init {
        fun block(x: Float, y: Float, width: Float, height: Float) {
            for (ty in (floor(y).toInt() - minY).coerceAtLeast(0) until (ceil(y + height).toInt() - minY).coerceAtMost(h)) {
                checkpoint()
                for (tx in (floor(x).toInt() - minX).coerceAtLeast(0) until (ceil(x + width).toInt() - minX).coerceAtMost(n)) blocked[ty * n + tx] = true
            }
        }
        scene.buildings.forEach { block(it.tileX, it.tileY, it.footprintWidth, it.footprintHeight) }
        scene.obstacles.forEach { block(it.tileX, it.tileY, it.footprintWidth, it.footprintHeight) }
    }
    fun same(other: CampOccupancy) = n == other.n && h == other.h && minX == other.minX && minY == other.minY && tile == other.tile && blocked.contentEquals(other.blocked)
    private fun tileFree(x: Int, y: Int) = x !in 0 until n || y !in 0 until h || !blocked[y * n + x]
    fun free(x: Float, y: Float) = tileFree(floor(x / tile).toInt() - minX, floor(y / tile).toInt() - minY)
    fun clear(ax: Float, ay: Float, bx: Float, by: Float): Boolean {
        val steps = max(1, ceil(hypot(bx - ax, by - ay) / (tile / 4)).toInt())
        for (i in 0..steps) {
            val t = i.toFloat() / steps
            if (!free(ax + (bx - ax) * t, ay + (by - ay) * t)) return false
        }
        return true
    }
    fun nearest(point: CampPoint, maxTiles: Int): CampPoint? {
        if (free(point.x, point.y)) return point
        for (r in 1..maxTiles) for (dy in -r..r) for (dx in -r..r) {
            if (max(abs(dx), abs(dy)) != r) continue
            val x = point.x + dx * tile; val y = point.y + dy * tile
            if (free(x, y)) return CampPoint(x, y)
        }
        return null
    }
    /** Reverse BFS admits every reachable tile. A new revision can join this prepared
     * tree from a surviving walker's current position without a graphics-thread BFS. */
    fun toward(goal: CampPoint): CampGoal {
        val gx = floor(goal.x / tile).toInt() - minX; val gy = floor(goal.y / tile).toInt() - minY
        val next = IntArray(n * h) { -1 }
        if (gx in 0 until n && gy in 0 until h && tileFree(gx, gy)) {
            val queue = IntArray(n * h); var head = 0; var tail = 0
            val root = gy * n + gx; queue[tail++] = root; next[root] = root
            while (head < tail) {
                checkpoint()
                val current = queue[head++]; val x = current % n; val y = current / n
                for (direction in 0..3) {
                    val nx = x + when (direction) { 0 -> 1; 2 -> -1; else -> 0 }
                    val ny = y + when (direction) { 1 -> 1; 3 -> -1; else -> 0 }
                    if (nx !in 0 until n || ny !in 0 until h) continue
                    val index = ny * n + nx
                    if (next[index] != -1 || blocked[index]) continue
                    next[index] = current; queue[tail++] = index
                }
            }
        }
        return CampGoal(goal, next)
    }
    inner class CampGoal(val point: CampPoint, private val next: IntArray) {
        fun from(start: CampPoint): CampPath? {
            if (clear(start.x, start.y, point.x, point.y)) return path(start, listOf(point))
            val sx = floor(start.x / tile).toInt() - minX; val sy = floor(start.y / tile).toInt() - minY
            if (sx !in 0 until n || sy !in 0 until h) return null
            var cursor = sy * n + sx
            if (next[cursor] < 0) return null
            val raw = ArrayList<CampPoint>()
            while (next[cursor] != cursor) {
                cursor = next[cursor]
                if (next[cursor] != cursor) raw += CampPoint((minX + cursor % n + .5f) * tile, (minY + cursor / n + .5f) * tile)
            }
            raw += point
            val pulled = ArrayList<CampPoint>(); var at = start; var i = 0
            while (i < raw.size) {
                var take = i
                for (j in raw.lastIndex downTo i + 1) if (clear(at.x, at.y, raw[j].x, raw[j].y)) { take = j; break }
                val target = raw[take]
                if (!clear(at.x, at.y, target.x, target.y)) return null
                pulled += target; at = target; i = take + 1
            }
            return path(start, pulled)
        }
    }
    private fun path(start: CampPoint, points: List<CampPoint>): CampPath {
        var prior = start
        return CampPath(points, points.map { point ->
            facing8((point.x - prior.x).toDouble(), (point.y - prior.y).toDouble()).also { prior = point }
        })
    }
}

internal data class CampRing(val points: List<CampPoint>, val goals: List<CampOccupancy.CampGoal>, val paths: List<List<CampPath?>>)
internal data class CampBody(val troop: RenderCampTroop, val move: AuthoredClip, val stand: AuthoredClip)
data class CampLocomotion(val move: AuthoredClip, val stand: AuthoredClip)

/** Immutable preparation result; only locomotion/stand clips own residency. */
class PreparedCampScene private constructor(val baseId: String?, internal val rules: CampPatrolRules,
    internal val occupancy: CampOccupancy, internal val rings: Map<String, CampRing>,
    internal val bodies: List<CampBody>, internal val scale: Float, internal val speed: Float,
    internal val actorDepth: Float) {
    val requiredAtlases = bodies.flatMap { listOf(it.move.atlasPath, it.stand.atlasPath) }.toSet()
    companion object {
        fun artwork(root: JsonValue): Map<String, CampLocomotion>? {
            val section = root.get("campPresentation") ?: return null
            require(section.getInt("version") == 1) { "Unsupported camp presentation" }
            return section.get("actors").associate { it.name to CampLocomotion(AuthoredClip.parse(it.get("move")), AuthoredClip.parse(it.get("stand"))) }
        }
        fun prepare(scene: BaseScene, art: Map<String, CombatArt>, actorDepth: Float,
            compact: Map<String, CampLocomotion>? = null, checkpoint: () -> Unit = {}): PreparedCampScene? {
            val rules = scene.campRules ?: return null
            if (scene.campTroops.isEmpty()) return null
            require(scene.campTroops.map { it.identity }.distinct().size == scene.campTroops.size)
            require(scene.campTroops.map { it.campId to it.slot }.distinct().size == scene.campTroops.size)
            require(scene.campTroops.all { it.slot in 0 until rules.maxPerCamp })
            val occupancy = CampOccupancy(scene, checkpoint)
            val rings = scene.buildings.filter { it.type == "camp" && !it.underConstruction }.associate { camp ->
                checkpoint()
                val pad = rules.wanderPadTiles; val tile = scene.tilePixels
                val x0 = (camp.tileX - pad) * tile; val x1 = (camp.tileX + camp.footprintWidth + pad) * tile
                val y0 = (camp.tileY - pad) * tile; val y1 = (camp.tileY + camp.footprintHeight + pad) * tile
                val xm = (x0 + x1) / 2; val ym = (y0 + y1) / 2
                val ring = listOf(CampPoint(x0, y0), CampPoint(xm, y0), CampPoint(x1, y0), CampPoint(x1, ym),
                    CampPoint(x1, y1), CampPoint(xm, y1), CampPoint(x0, y1), CampPoint(x0, ym))
                    .mapNotNull { occupancy.nearest(it, rules.detourSearchTiles) }.distinct()
                val goals = ring.map { occupancy.toward(it) }
                val paths = ring.map { start -> goals.map { goal -> checkpoint(); goal.from(start) } }
                camp.id to CampRing(ring, goals, paths)
            }
            val bodies = scene.campTroops.mapNotNull { troop ->
                checkpoint()
                if (rings[troop.campId]?.points.isNullOrEmpty()) return@mapNotNull null
                val home = compact?.let { requireNotNull(it[troop.frameKey]) { "Compact camp artwork missing for ${troop.troop}" } }
                val body = if(home == null) requireNotNull(art[troop.frameKey]) { "Camp locomotion metadata missing for ${troop.troop}" } else null
                val move = home?.move ?: requireNotNull(body!!.clips[body.profile.getString("move")]) { "Camp movement clip missing" }
                val stand = home?.stand ?: requireNotNull(body!!.clips[body.profile.getString("stand")]) { "Camp stand clip missing" }
                CampBody(troop, move, stand)
            }
            return PreparedCampScene(scene.baseId, rules, occupancy, rings, bodies,
                rules.scaleRatio * scene.tilePixels / rules.sourceTilePixels,
                rules.speedPxPerSec * scene.tilePixels / rules.sourceTilePixels, actorDepth)
        }
    }
}

/** GL-owned walkers. Prepared routes are reused at every arrival; snapshots change
 * only the authoritative roster and geometry, never duplicate the same seat. */
class CampVisualModel {
    private class Walker(var body: CampBody, var ring: CampRing) {
        private var seed = "${body.troop.campId}:${body.troop.slot}".fold(0L) { h, c -> (h * 31 + c.code) and 0xffffffffL }.let { if (it == 0L) 1L else it }
        fun random(): Float { seed = (seed * 1664525L + 1013904223L) and 0xffffffffL; return (seed.toDouble() / 4294967296.0).toFloat() }
        var stop = (random() * ring.points.size).toInt().coerceAtMost(ring.points.lastIndex)
        var x = ring.points[stop].x; var y = ring.points[stop].y
        var pause = 0f; var walkAge = 0f; var standAge = 0f; var moving = false; var facing = "s"
        var path: CampPath? = null; var leg = 0; var destination = stop
    }
    private var scene: PreparedCampScene? = null
    private var walkers = emptyList<Walker>()
    val count: Int get() = walkers.size
    internal fun rosterHash(): Int = walkers.fold(1) { hash, w -> 31 * hash + w.body.troop.identity.hashCode() }
    internal fun poseHash(): Int = walkers.fold(1) { hash, w -> 31 * (31 * hash + w.x.toBits()) + w.y.toBits() }
    fun replace(next: PreparedCampScene?) {
        val previous = scene
        val sameBase = next?.baseId != null && next.baseId == previous?.baseId
        val existing = if (sameBase) walkers.associateBy { it.body.troop.identity } else emptyMap()
        val sameGround = sameBase && next!!.occupancy.same(previous!!.occupancy)
        scene = next
        walkers = next?.bodies?.map { body ->
            val ring = next.rings.getValue(body.troop.campId)
            val kept = existing[body.troop.identity]
            if (kept == null) Walker(body, ring).also { it.pause = it.random() * next.rules.pauseMaxMs; retarget(it, next) }
            else kept.also {
                val unchanged = sameGround && it.ring.points == ring.points
                it.body = body; it.ring = ring
                if (!unchanged) {
                    // Revision-only allocation, no route search on the render loop.
                    val settled = next.occupancy.nearest(CampPoint(it.x, it.y), next.rules.detourSearchTiles)
                        ?: ring.points.first()
                    it.x = settled.x; it.y = settled.y; it.path = null; it.moving = false
                    val nearest = ring.points.indices.minBy { k -> hypot(ring.points[k].x - it.x, ring.points[k].y - it.y) }
                    it.stop = nearest; it.destination = nearest
                    it.path = ring.goals[nearest].from(settled); it.leg = 0
                    if (it.path == null) { it.x = ring.points[nearest].x; it.y = ring.points[nearest].y; retarget(it, next) }
                    it.pause = max(it.pause, next.rules.pauseMinMs)
                }
            }
        }.orEmpty()
    }
    private fun retarget(w: Walker, current: PreparedCampScene) {
        w.path = null; w.leg = 0
        val count = w.ring.points.size; val direction = if (w.random() < .5f) 1 else -1
        for (k in 1..min(count - 1, current.rules.routeRetries)) {
            val index = Math.floorMod(w.stop + direction * k, count)
            val path = w.ring.paths[w.stop][index] ?: continue
            if (w.ring.points[index].x == w.x && w.ring.points[index].y == w.y) continue
            w.path = path; w.destination = index; return
        }
    }
    fun advance(deltaMs: Float, reducedMotion: Boolean) {
        val current = scene ?: return
        if (reducedMotion || !deltaMs.isFinite() || deltaMs <= 0) return
        for (w in walkers) {
            var remaining = deltaMs
            while (remaining > 0) {
                if (w.pause > 0) {
                    val used = min(remaining, w.pause); w.pause -= used; remaining -= used; w.standAge += used
                    if (remaining <= 0) break
                }
                val path = w.path
                if (path == null) { w.moving = false; w.pause = current.rules.pauseMinMs; retarget(w, current); break }
                val point = path.points[w.leg]; val distance = hypot(point.x - w.x, point.y - w.y)
                val travel = min(distance, current.speed * remaining / 1000)
                val x = if (distance == 0f) point.x else w.x + (point.x - w.x) * travel / distance
                val y = if (distance == 0f) point.y else w.y + (point.y - w.y) * travel / distance
                if (!current.occupancy.clear(w.x, w.y, x, y)) { w.moving = false; w.path = null; w.pause = current.rules.pauseMinMs; break }
                w.x = x; w.y = y; w.facing = path.facings[w.leg]; w.moving = travel > 0
                val walkingMs = travel / current.speed * 1000
                remaining -= walkingMs; w.walkAge += walkingMs
                if (travel < distance) break
                w.leg++
                if (w.leg == path.points.size) {
                    w.stop = w.destination; w.moving = false
                    w.pause = current.rules.pauseMinMs + w.random() * (current.rules.pauseMaxMs - current.rules.pauseMinMs)
                    retarget(w, current)
                    if (w.pause <= 0 && w.path == null) break
                }
            }
        }
    }
    fun sprites(output: MutableList<BaseVisualSprite>, reducedMotion: Boolean) {
        val current = scene ?: return
        for (w in walkers) {
            val moving = w.moving && !reducedMotion && w.pause <= 0
            val clip = if (moving) w.body.move else w.body.stand
            val scale = clip.scale * current.scale
            // Some source profiles explicitly share move/stand (prowl/scurry).
            // A stopped walker uses their authored standing pose, not walking in place.
            val heldPose = reducedMotion || (!moving && w.body.stand.key == w.body.move.key)
            output += BaseVisualSprite(clip, clip.frame(if (heldPose) 0f else if (moving) w.walkAge else w.standAge, clip.row(w.facing), clip.loop),
                w.x, w.y, clip.cellWidth * scale, clip.cellHeight * scale, clip.anchorX, clip.anchorY, current.actorDepth + w.y)
        }
    }
}
