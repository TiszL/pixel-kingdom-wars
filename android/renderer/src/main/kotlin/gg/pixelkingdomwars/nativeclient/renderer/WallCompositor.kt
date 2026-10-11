package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Kotlin port of the accepted five-tier wall compositor (`packages/shared/src/wallRender.ts`,
 * owner 2026-09-09, D-126). Every dimension, palette, threshold and clock comes from the
 * `walls5` catalogue section; only the drawing rules themselves are code, exactly as the
 * exporter's `compositor.codeOnly` list declares. Integer pixel commands are emitted in the same
 * order as the source so the RGBA of every frame hashes byte-for-byte to the pack goldens. */
data class WallCell(val tier: Int, val damage: Boolean = false, val damageStage: Int = 1)

/** Grid keyed by tile coordinates. Negative coordinates are valid (detached rows, tests). */
class WallGrid {
    private val cells = HashMap<Long, WallCell>()
    val size: Int get() = cells.size
    fun put(x: Int, y: Int, cell: WallCell) { cells[key(x, y)] = cell }
    fun remove(x: Int, y: Int): WallCell? = cells.remove(key(x, y))
    operator fun get(x: Int, y: Int): WallCell? = cells[key(x, y)]
    fun forEach(action: (x: Int, y: Int, cell: WallCell) -> Unit) = cells.forEach { (k, v) -> action(xOf(k), yOf(k), v) }
    companion object {
        fun key(x: Int, y: Int): Long = (x.toLong() shl 32) or (y.toLong() and 0xffffffffL)
        fun xOf(key: Long): Int = (key shr 32).toInt()
        fun yOf(key: Long): Int = key.toInt()
    }
}

data class WallPalette(val top: Int, val light: Int, val cap: Int, val face: Int, val stone: Int,
                       val dark: Int, val mortar: Int, val line: Int, val accent: Int) {
    companion object {
        fun parse(v: JsonValue) = WallPalette(rgb(v.getString("top")), rgb(v.getString("light")), rgb(v.getString("cap")),
            rgb(v.getString("face")), rgb(v.getString("stone")), rgb(v.getString("dark")), rgb(v.getString("mortar")),
            rgb(v.getString("line")), rgb(v.getString("accent")))
        fun rgb(hex: String): Int {
            require(hex.length == 7 && hex[0] == '#') { "Wall palette colour must be #rrggbb: $hex" }
            return hex.substring(1).toInt(16)
        }
    }
}

/** The `walls5` section: atlas vocabulary, tier mapping, damage rules and compositor inputs. */
class WallArtSpec(section: JsonValue) {
    val atlasPath: String = section.getString("atlasPath")
    val tiers: Int
    val levelsPerTier: Int
    val tile: Int
    val drawScale: Float
    val preparationBudgetMs: Float
    val tierHeights: IntArray
    val bodyHeights: IntArray
    val contextFrameHeight: Int
    val lightDamageBelow: Double
    val heavyDamageBelow: Double
    val collapseFrames: Int
    val collapseFps: Double
    /** `1000 * collapseFrames / collapseFps` as a double, exactly like `COLLAPSE_DURATION`. */
    val collapseDurationMs: Double
    val palettes: List<WallPalette>
    val tierOfLevel: IntArray
    val shapesByMask: List<String>
    val seatAnchorX: Float
    val seatAnchorY: Float
    val seatScale: Float
    val seatOffsetX: Float
    val seatOffsetY: Float
    /** frames[tier - 1][shape][state] → atlas frame keys. */
    private val frames: Map<Int, Map<String, Map<String, List<String>>>>
    init {
        require(section.getInt("version") == 1) { "Unsupported walls5 section" }
        val constants = section.get("constants")
        tiers = constants.getInt("tiers"); levelsPerTier = constants.getInt("levelsPerTier")
        tile = constants.getInt("sourceTileSize"); drawScale = constants.getFloat("drawScale")
        preparationBudgetMs = constants.getFloat("preparationBudgetMs")
        contextFrameHeight = constants.getInt("contextFrameHeight")
        lightDamageBelow = constants.getDouble("lightDamageBelow"); heavyDamageBelow = constants.getDouble("heavyDamageBelow")
        collapseFrames = constants.getInt("collapseFrames"); collapseFps = constants.getDouble("collapseFps")
        collapseDurationMs = 1000.0 * collapseFrames / collapseFps
        val compositor = section.get("compositor")
        require(compositor.getInt("tile") == tile && compositor.getInt("contextFrameHeight") == contextFrameHeight) { "Wall compositor geometry disagrees with WALL_ART" }
        tierHeights = compositor.get("tierHeights").asIntArray()
        bodyHeights = compositor.get("bodyHeights").asIntArray()
        require(tierHeights.size == tiers && bodyHeights.size == tiers) { "Wall tier vocabulary changed" }
        val bodyOffset = constants.getInt("sourceBodyOffset")
        require(tierHeights.indices.all { bodyHeights[it] == tierHeights[it] - bodyOffset }) { "Wall body heights no longer derive from the source body offset" }
        require(constants.get("sourceFrameHeights").asIntArray().contentEquals(tierHeights)) { "Wall frame heights disagree with the compositor" }
        palettes = compositor.get("palettes").map(WallPalette::parse)
        require(palettes.size == tiers) { "Wall palette table changed shape" }
        val collapse = section.get("collapse")
        require(collapse.getInt("frames") == collapseFrames && abs(collapse.getDouble("durationMs") - collapseDurationMs) < 1e-9) { "Collapse clock no longer comes from WALL_ART" }
        tierOfLevel = section.get("tierOfLevel").asIntArray()
        require(tierOfLevel.isNotEmpty() && tierOfLevel.all { it in 1..tiers }) { "Wall tier mapping out of range" }
        shapesByMask = section.get("shapesByMask").map { it.asString() }
        require(shapesByMask.size == 16) { "Wall shape table changed" }
        val maskBits = section.get("maskBits")
        require(maskBits.getInt("n") == 1 && maskBits.getInt("e") == 2 && maskBits.getInt("s") == 4 && maskBits.getInt("w") == 8) { "Wall mask bit assignment changed" }
        val seat = section.get("seat"); val anchor = seat.get("anchor")
        seatAnchorX = anchor.getFloat(0); seatAnchorY = anchor.getFloat(1); seatScale = seat.getFloat("scale")
        seatOffsetX = seat.getFloat("offsetX", 0f); seatOffsetY = seat.getFloat("offsetY", 0f)
        require(seat.get("contextFrame").getInt("width") == tile && seat.get("contextFrame").getInt("height") == contextFrameHeight)
        frames = section.get("frames").associate { tier -> tier.name.toInt() to tier.associate { shape ->
            shape.name to shape.associate { state -> state.name to state.map { it.asString() } } } }
        require(frames.keys == (1..tiers).toSet()) { "Wall frames are missing a tier" }
        val stages = section.get("damageStages")
        require(stages.get("light").getInt("stage") == 1 && stages.get("heavy").getInt("stage") == 2 && stages.get("collapsed").getInt("stage") == 3)
        require(stages.get("light").getDouble("below") == lightDamageBelow && stages.get("heavy").getDouble("below") == heavyDamageBelow)
    }
    /** `wallTierOfLevel`: the catalogue table, clamped for levels outside it. */
    fun tierOfLevel(level: Int): Int = tierOfLevel[(level - 1).coerceIn(0, tierOfLevel.lastIndex)]
    /** `wallDamageStage`: 0 intact, 1 light, 2 heavy, 3 collapsed. Unknown health is intact. */
    fun damageStage(hp: Long?, maxHp: Long?): Int {
        if (hp == null || maxHp == null) return 0
        if (hp <= 0) return 3
        if (maxHp <= 0) return 0
        if (hp < maxHp * heavyDamageBelow) return 2
        if (hp < maxHp * lightDamageBelow) return 1
        return 0
    }
    fun frameKeys(tier: Int, shape: String, state: String): List<String> =
        frames.getValue(tier).getValue(shape).getValue(state)
    /** Intact baseline cell for a tier and 3×3 cardinal mask, shown until the composed frame is ready. */
    fun intactFrame(tier: Int, mask: Int): String = frameKeys(tier, shapesByMask[mask and 15], "intact").first()
    /** `WallLayer.advance`: collapse frame `f` of `collapseFrames` samples the squash at this time; the last frame is the final rubble. */
    fun collapseFrameTimeMs(frame: Int): Double {
        require(frame in 0 until collapseFrames) { "Collapse frame out of range" }
        return if (frame == collapseFrames - 1) collapseDurationMs else frame.toDouble() / (collapseFrames - 1) * collapseDurationMs
    }
    /** `WallLayer.advance`: the frame index shown `elapsedMs` after a breach (clamped to the clock). */
    fun collapseFrameAt(elapsedMs: Double): Int {
        val elapsed = elapsedMs.coerceIn(0.0, collapseDurationMs)
        return min(collapseFrames - 1, kotlin.math.floor(elapsed / collapseDurationMs * collapseFrames).toInt())
    }
    /** Every atlas key of the family, for residency checks. */
    val allFrameKeys: Set<String> get() = frames.values.flatMap { it.values.flatMap { s -> s.values.flatten() } }.toSet()
    private fun JsonValue.asIntArray() = IntArray(size) { get(it).asInt() }
}

interface WallPixelSink { fun fill(color: Int, x: Int, y: Int, w: Int, h: Int) }

/** A neighbourhood rebuilt from a render key: the cell at (x, y) plus its 3×3 context. */
data class WallKeyGrid(val grid: WallGrid, val x: Int, val y: Int)

/** Frame-local integer commands (`[color, x, y, w, h]` flattened) plus the resolved RGBA bytes. */
class WallFrame(val width: Int, val height: Int, val anchorX: Int, val anchorY: Int, val commands: IntArray, val data: ByteArray) {
    val commandCount: Int get() = commands.size / 5
}

class WallCollapseSnapshot internal constructor(val x: Int, val y: Int, val tier: Int, val startMs: Double, internal val pixels: IntArray)

class WallCompositor(val spec: WallArtSpec) {
    private val tile = spec.tile
    private val tierHeights = spec.tierHeights
    private val contextFrameHeight = spec.contextFrameHeight

    private class Neighbour(val tier: Int, val damage: Boolean)
    /** `resolveWall` output plus the prepared four-centre height patches. */
    private class State(val x: Int, val y: Int, val tier: Int, val damage: Boolean, val damageStage: Int, val mask: Int,
        val n: Neighbour?, val e: Neighbour?, val s: Neighbour?, val w: Neighbour?,
        val fillNw: Boolean, val fillNe: Boolean, val fillSe: Boolean, val fillSw: Boolean, val radius: Int) {
        val bodyHeightPatches = arrayOfNulls<IntArray>(4) // -1 when a node is absent
        var samples: Array<Sample?>? = null
        var computed: BooleanArray? = null
    }
    private class Sample(val h: Int, val body: Int, val transition: Boolean, val edge: Int, val direction: Char,
                         val merlon: Boolean, val state: State, val damaged: Boolean)
    private class Field(val cells: HashMap<Long, State>)

    private fun tierOf(cell: WallCell) = max(1, min(spec.tiers, cell.tier))
    private fun bodyHeight(tier: Int) = spec.bodyHeights[tier - 1]

    private fun resolve(grid: WallGrid, x: Int, y: Int): State? {
        val wall = grid[x, y] ?: return null
        val tier = tierOf(wall)
        fun neighbour(dx: Int, dy: Int) = grid[x + dx, y + dy]?.let { Neighbour(tierOf(it), it.damage) }
        val n = neighbour(0, -1); val e = neighbour(1, 0); val s = neighbour(0, 1); val w = neighbour(-1, 0)
        var mask = 0
        if (n != null) mask = mask or 1; if (e != null) mask = mask or 2; if (s != null) mask = mask or 4; if (w != null) mask = mask or 8
        val nw = grid[x - 1, y - 1] != null && n != null && w != null
        val ne = grid[x + 1, y - 1] != null && n != null && e != null
        val se = grid[x + 1, y + 1] != null && s != null && e != null
        val sw = grid[x - 1, y + 1] != null && s != null && w != null
        val corner = mask != 5 && mask != 10 && ((mask and 3) == 3 || (mask and 6) == 6 || (mask and 12) == 12 || (mask and 9) == 9)
        val filled = listOf(nw, ne, se, sw).count { it }
        val radius = if (corner && filled <= 1) 12 else if (mask == 0) 10 else 6
        return State(x, y, tier, wall.damage, if (wall.damageStage == 2) 2 else 1, mask, n, e, s, w, nw, ne, se, sw, radius)
    }

    /** Exact mating footprint: cardinal arms; a quadrant fills only for a solid 2×2. */
    private fun footprintAt(state: State?, px: Int, py: Int): Boolean {
        if (state == null || px < 0 || py < 0 || px >= 32 || py >= 32) return false
        val mask = state.mask; val radius = state.radius
        val dx = abs(px - 15.5); val dy = abs(py - 15.5)
        if (dx <= radius && dy <= radius && dx + dy <= radius * 2 - 2) return true
        if (px >= 10 && px < 22 && ((mask and 1 != 0 && py <= 16) || (mask and 4 != 0 && py >= 15))) return true
        if (py >= 10 && py < 22 && ((mask and 8 != 0 && px <= 16) || (mask and 2 != 0 && px >= 15))) return true
        if (px < 16 && py < 16 && state.fillNw || px >= 16 && py < 16 && state.fillNe ||
            px >= 16 && py >= 16 && state.fillSe || px < 16 && py >= 16 && state.fillSw) return true
        return false
    }

    // Two shared boundary pixels have exactly the same blend weight (see the source comment).
    private fun edgeWeight(pixel: Int): Double = max(0.0, (12 - min(pixel, 31 - pixel)) / 22.0)

    private fun heightPatch(cells: HashMap<Long, State>, s: State, dx: Int, dy: Int): IntArray {
        val n1 = cells[WallGrid.key(s.x + dx, s.y)]; val n2 = cells[WallGrid.key(s.x, s.y + dy)]; val n3 = cells[WallGrid.key(s.x + dx, s.y + dy)]
        // A diagonal participates only when connected inside this four-centre patch.
        return intArrayOf(bodyHeight(s.tier), n1?.let { bodyHeight(it.tier) } ?: -1, n2?.let { bodyHeight(it.tier) } ?: -1,
            if (n3 != null && (n1 != null || n2 != null)) bodyHeight(n3.tier) else -1)
    }

    private fun shoulderHeight(s: State, px: Int, py: Int): Pair<Int, Boolean> {
        val u = min(.5, edgeWeight(px)); val v = min(.5, edgeWeight(py))
        val values = s.bodyHeightPatches[(if (py < 16) 0 else 2) + (if (px < 16) 0 else 1)]!!
        val weights = doubleArrayOf((1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v)
        var total = 0.0; var weight = 0.0; var transition = false
        for (i in 0 until 4) if (values[i] >= 0 && weights[i] > 0) {
            total += values[i] * weights[i]; weight += weights[i]
            if (values[i] != values[0]) transition = true
        }
        return Math.round(total / weight).toInt() to transition
    }

    /** `buildField`: geometry resolved once; pixels sampled lazily per cell. */
    private fun buildField(grid: WallGrid): Field {
        val cells = HashMap<Long, State>()
        grid.forEach { x, y, _ -> resolve(grid, x, y)?.let { cells[WallGrid.key(x, y)] = it } }
        for (s in cells.values) {
            s.bodyHeightPatches[0] = heightPatch(cells, s, -1, -1); s.bodyHeightPatches[1] = heightPatch(cells, s, 1, -1)
            s.bodyHeightPatches[2] = heightPatch(cells, s, -1, 1); s.bodyHeightPatches[3] = heightPatch(cells, s, 1, 1)
        }
        return Field(cells)
    }

    private fun stateAt(field: Field, wx: Int, wy: Int): State? = field.cells[WallGrid.key(Math.floorDiv(wx, 32), Math.floorDiv(wy, 32))]
    private fun occupied(field: Field, wx: Int, wy: Int) = footprintAt(stateAt(field, wx, wy), Math.floorMod(wx, 32), Math.floorMod(wy, 32))

    private fun sample(field: Field, wx: Int, wy: Int): Sample? {
        val s = stateAt(field, wx, wy) ?: return null
        val px = Math.floorMod(wx, 32); val py = Math.floorMod(wy, 32)
        if (!footprintAt(s, px, py)) return null
        // Border distance is derived from the union, never a tile's own outline.
        var edge = 4; var direction = ' '
        for (d in 1..3) {
            if (!occupied(field, wx, wy - d)) { edge = d; direction = 'n'; break }
            if (!occupied(field, wx - d, wy)) { edge = d; direction = 'w'; break }
            if (!occupied(field, wx, wy + d)) { edge = d; direction = 's'; break }
            if (!occupied(field, wx + d, wy)) { edge = d; direction = 'e'; break }
        }
        val (body, transition) = shoulderHeight(s, px, py)
        val along = if (direction == 'n' || direction == 's') wx else wy
        // Crenels never start/end exactly at a tile join.
        val merlon = edge <= 3 && Math.floorMod(along, 16) >= 4 && Math.floorMod(along, 16) < 12
        var h = body + (if (edge <= 3) 2 else 0) + (if (merlon) 2 else 0)
        // Chips are local surface damage; the shared foundation remains continuous.
        val mating = (px <= 1 && s.w != null) || (px >= 30 && s.e != null) || (py <= 1 && s.n != null) || (py >= 30 && s.s != null)
        val damaged = s.damage && !mating && Math.floorMod(wx * 7 + wy * 11, 23) < (if (s.damageStage == 2) 9 else 5)
        if (damaged) h = max(2, h - (if (s.damageStage == 2) 3 else 2))
        return Sample(h, body, transition, edge, direction, merlon, s, damaged)
    }

    private fun at(field: Field, wx: Int, wy: Int): Sample? {
        val s = field.cells[WallGrid.key(Math.floorDiv(wx, tile), Math.floorDiv(wy, tile))] ?: return null
        val samples = s.samples ?: arrayOfNulls<Sample>(tile * tile).also { s.samples = it }
        val computed = s.computed ?: BooleanArray(tile * tile).also { s.computed = it }
        val index = Math.floorMod(wy, tile) * tile + Math.floorMod(wx, tile)
        if (!computed[index]) { samples[index] = sample(field, wx, wy); computed[index] = true }
        return samples[index]
    }

    // Material collars are limited to the outer coping where timber meets stone.
    private fun materialCollar(s: State, px: Int, py: Int): Boolean {
        val timber = s.tier == 1
        return (px <= 1 && s.w != null && (s.w.tier == 1) != timber) || (px >= 30 && s.e != null && (s.e.tier == 1) != timber) ||
            (py <= 1 && s.n != null && (s.n.tier == 1) != timber) || (py >= 30 && s.s != null && (s.s.tier == 1) != timber)
    }

    private fun timberFace(p: WallPalette, wx: Int, z: Int, a: Sample, exterior: Boolean): Int {
        val post = Math.floorMod(wx, 16) >= 4 && Math.floorMod(wx, 16) <= 6
        var color = if (z == 0) p.line else if (Math.floorMod(wx, 6) == 0) p.dark else if (Math.floorMod(wx, 6) == 1) p.stone else p.face
        if (Math.floorMod(wx * 7 + z * 3, 31) == 0) color = p.dark
        if (Math.floorMod(wx, 6) == 3 && Math.floorMod(z + Math.floorDiv(wx, 6) * 3, 7) < 3) color = p.dark
        if (exterior && post) color = if (Math.floorMod(wx, 16) == 4) p.light else p.stone
        if (exterior && (z == 2 || z == a.h - 3)) color = p.stone
        if (exterior && !post && Math.floorMod(wx + z, 16) == 9 && z > 2 && z < a.h - 3) color = p.light
        if (exterior && post && (z == 2 || z == a.h - 3)) color = if (Math.floorMod(wx, 16) == 5) TIMBER_POST_LIGHT else TIMBER_POST_DARK
        if (z == a.h - 2 && a.edge <= 3) color = p.dark
        if (z == a.h - 1 && a.edge <= 3) color = p.stone
        return color
    }

    private fun timberDeck(p: WallPalette, wx: Int, wy: Int, a: Sample): Int {
        var color = if (a.edge == 1) p.light else if (a.edge <= 3) p.cap else p.top
        if (a.edge > 3) {
            val board = Math.floorMod(wx, 5); val length = Math.floorMod(wy + (Math.floorDiv(wx, 5) % 2) * 9, 24)
            if (board == 0 || length == 0) color = p.dark
            else if (board == 1) color = p.light
            else if (Math.floorMod(wx * 11 + wy * 3, 43) == 0) color = p.face
            // Short staggered grain marks and knots survive nearest-neighbour zoom.
            if (board >= 2 && Math.floorMod(wy + Math.floorDiv(wx, 5) * 7, 19) == 3) color = p.stone
            if (board == 3 && Math.floorMod(wy + Math.floorDiv(wx, 5) * 7, 19) < 3) color = p.face
        }
        if (a.direction == 'e' && a.edge == 1) color = p.dark
        val along = if (a.direction == 'n' || a.direction == 's') wx else wy
        if (a.merlon && a.edge == 2 && Math.floorMod(along, 16) >= 6 && Math.floorMod(along, 16) <= 9) color = p.stone
        if (a.merlon && a.edge == 3) color = p.dark
        return color
    }

    private fun drawWall(sink: WallPixelSink, field: Field, x: Int, y: Int) {
        val s = field.cells[WallGrid.key(x, y)] ?: return
        val p = spec.palettes[s.tier - 1]
        val wood = s.tier == 1
        for (py in 0 until 32) for (px in 0 until 32) {
            val wx = x * 32 + px; val wy = y * 32 + py
            val a = at(field, wx, wy) ?: continue
            val b = at(field, wx, wy + 1); val floor = b?.h ?: 0
            // South faces: continuous masonry courses, shared faces suppressed exactly.
            for (z in floor until a.h) {
                val course = z / 4; val brick = Math.floorMod(wx + (course % 2) * 5, 10)
                val stoneTone = Math.floorMod(Math.floorDiv(wx + (course % 2) * 5, 10) * 7 + course * 11, 5)
                var c = if (z == 0) p.line else if (z % 4 == 0) p.dark else if (brick == 0) p.mortar else if (brick == 1 || stoneTone == 0) p.stone else p.face
                if (a.edge == 1 && (a.direction == 'w' || a.direction == 'e')) c = if (z % 4 == 0) p.dark else p.light
                if (z == a.h - 2 && a.edge <= 3) c = p.dark
                if (z == a.h - 1 && a.edge <= 3) c = p.stone
                if (s.tier >= 4 && z == 4 && a.h > 8) c = p.accent
                if (s.tier == 5 && Math.floorMod(wx, 32) >= 14 && Math.floorMod(wx, 32) <= 16 && z >= 7 && z <= 10) c = if (z == 10) CROWN_SHARD_LIGHT else CROWN_SHARD_DARK
                if (wood) c = timberFace(p, wx, z, a, b == null)
                if (a.edge <= 3 && materialCollar(s, px, py) && z >= a.h - 3) c = if (z == a.h - 1) COLLAR_FACE_LIGHT else COLLAR_FACE_DARK
                if (s.damage && Math.floorMod(wx * 3 + z * 13, 37) < (if (s.damageStage == 2) 6 else 3)) c = if (wood && Math.floorMod(wx + z, 3) == 0) p.cap else p.line
                sink.fill(c, wx, wy - z, 1, 1)
            }
            var c = if (a.edge == 1) p.light else if (a.edge <= 3) p.cap else p.top
            if (a.direction == 'e' && a.edge == 1) c = p.dark
            val rowPhase = Math.floorDiv(wy, 8) % 2
            if (a.edge > 3 && (Math.floorMod(wy, 8) == 0 || Math.floorMod(wx + rowPhase * 6, 12) == 0)) c = p.mortar
            if (a.edge > 3 && Math.floorMod(wy, 8) == 1 && Math.floorMod(wx + rowPhase * 6, 12) > 1) c = p.light
            if (a.edge > 3 && Math.floorMod(wx * 13 + wy * 7, 67) == 0) c = p.light
            if (a.merlon && a.edge == 3) c = p.dark
            if (wood) c = timberDeck(p, wx, wy, a)
            if (a.edge <= 3 && materialCollar(s, px, py)) c = if (a.edge == 1) COLLAR_TOP_LIGHT else COLLAR_TOP_DARK
            if (a.damaged) c = if (wood && Math.floorMod(wx + wy, 3) == 0) p.cap else p.dark
            sink.fill(c, wx, wy - a.h, 1, 1)
        }
    }

    private fun drawCollapse(sink: WallPixelSink, s: WallCollapseSnapshot, timeMs: Double) {
        val progress = max(0.0, min(1.0, (timeMs - s.startMs) / spec.collapseDurationMs))
        val p = spec.palettes[max(1, min(spec.tiers, s.tier)) - 1]
        if (progress < 1) {
            val squash = max(.05, 1 - progress * 1.5)
            val pixels = s.pixels
            var i = 0
            while (i < pixels.size) {
                sink.fill(pixels[i], s.x * 32 + pixels[i + 1], s.y * 32 + Math.round(28 + (pixels[i + 2] - 28) * squash).toInt(), pixels[i + 3], pixels[i + 4])
                i += 5
            }
        }
        if (progress > .3) for (i in 0 until 7) {
            val rx = s.x * 32 + 6 + Math.floorMod(i * 7, 21); val ry = s.y * 32 + 22 + Math.floorMod(i * 5, 7)
            if (s.tier == 1) {
                // Broken lengths and small end-grain chips, rather than stone rubble.
                sink.fill(p.dark, rx, ry, 5, 1); sink.fill(if (i % 2 != 0) p.top else p.light, rx + (i % 2), ry - 1, 4, 1)
                if (i % 2 == 0) sink.fill(p.cap, rx + 4, ry - 2, 1, 2)
            } else { sink.fill(p.dark, rx, ry, 4, 2); sink.fill(if (i % 2 != 0) p.top else p.light, rx, ry - 1, 3, 2) }
        }
    }

    /** A prepared field for one grid: build once, compose any number of cells. */
    inner class Prepared internal constructor(private val grid: WallGrid) {
        private val field = buildField(grid)
        fun contains(x: Int, y: Int) = field.cells.containsKey(WallGrid.key(x, y))
        /** `composeWall`: all tiers use the honest contextual envelope; the anchor stays on the tile's bottom centre. */
        fun compose(x: Int, y: Int): WallFrame? {
            if (!contains(x, y)) return null
            val recorder = Recorder(-x * tile, -y * tile + contextFrameHeight - tile)
            drawWall(recorder, field, x, y)
            return recorder.frame()
        }
        /** `captureCollapse`: frozen geometry before deletion; survivors re-resolve immediately. */
        fun captureCollapse(x: Int, y: Int, startMs: Double = 0.0): WallCollapseSnapshot? {
            val s = field.cells[WallGrid.key(x, y)] ?: return null
            val recorder = Recorder(-x * 32, -y * 32)
            drawWall(recorder, field, x, y)
            return WallCollapseSnapshot(x, y, s.tier, startMs, recorder.commands())
        }
    }
    fun prepare(grid: WallGrid) = Prepared(grid)
    fun composeWall(grid: WallGrid, x: Int, y: Int): WallFrame? = prepare(grid).compose(x, y)
    fun captureCollapse(grid: WallGrid, x: Int, y: Int, startMs: Double = 0.0): WallCollapseSnapshot? = prepare(grid).captureCollapse(x, y, startMs)
    /** `composeCollapse`: the squash and rubble of one frozen snapshot at `timeMs` since its start. */
    fun composeCollapse(snapshot: WallCollapseSnapshot, timeMs: Double): WallFrame {
        val recorder = Recorder(-snapshot.x * tile, -snapshot.y * tile + contextFrameHeight - tile)
        drawCollapse(recorder, snapshot, timeMs)
        return recorder.frame()
    }

    private inner class Recorder(private val offsetX: Int, private val offsetY: Int) : WallPixelSink {
        private var buffer = IntArray(5 * 1024); private var count = 0
        override fun fill(color: Int, x: Int, y: Int, w: Int, h: Int) {
            if (count + 5 > buffer.size) buffer = buffer.copyOf(buffer.size * 2)
            buffer[count] = color; buffer[count + 1] = x + offsetX; buffer[count + 2] = y + offsetY; buffer[count + 3] = w; buffer[count + 4] = h
            count += 5
        }
        fun commands() = buffer.copyOf(count)
        fun frame(): WallFrame {
            val commands = commands()
            return WallFrame(tile, contextFrameHeight, tile / 2, contextFrameHeight, commands, commandsToRgba(commands, tile, contextFrameHeight))
        }
    }

    /** `wallRenderKey`: absolute coordinates stay in the key because courses and grain use world phase. */
    fun renderKey(grid: WallGrid, x: Int, y: Int): String {
        val out = StringBuilder(48).append(x).append(',').append(y)
        for (dy in -1..1) for (dx in -1..1) {
            out.append('|')
            val cell = grid[x + dx, y + dy]
            if (cell == null) out.append('-') else out.append(tierOf(cell)).append(':').append(if (cell.damage) 1 else 0).append(':').append(if (cell.damageStage == 2) 2 else 1)
        }
        return out.toString()
    }

    /** Inverse of [renderKey]: the 3×3 neighbourhood is the complete input of one composed frame, so a
     * key alone rebuilds the grid that reproduces it (the property the web relies on for frame reuse). */
    fun gridFromKey(key: String): WallKeyGrid {
        val parts = key.split('|')
        require(parts.size == 10) { "Malformed wall render key: $key" }
        val centre = parts[0].split(',')
        require(centre.size == 2) { "Malformed wall render key: $key" }
        val x = centre[0].toInt(); val y = centre[1].toInt()
        val grid = WallGrid()
        var index = 1
        for (dy in -1..1) for (dx in -1..1) {
            val cell = parts[index++]
            if (cell == "-") continue
            val fields = cell.split(':')
            require(fields.size == 3) { "Malformed wall render key: $key" }
            grid.put(x + dx, y + dy, WallCell(fields[0].toInt(), fields[1] == "1", fields[2].toInt()))
        }
        return WallKeyGrid(grid, x, y)
    }

    companion object {
        // Code-only material accents from wallRender.ts (not palette members).
        private const val TIMBER_POST_LIGHT = 0xbec0a6; private const val TIMBER_POST_DARK = 0x4b5048
        private const val CROWN_SHARD_LIGHT = 0xb7dbca; private const val CROWN_SHARD_DARK = 0x518b80
        private const val COLLAR_FACE_LIGHT = 0xa5a38b; private const val COLLAR_FACE_DARK = 0x50564c
        private const val COLLAR_TOP_LIGHT = 0xbac0a7; private const val COLLAR_TOP_DARK = 0x687260

        /** `commandsToRgba`: frame-local integer commands into opaque RGBA, later commands winning. */
        fun commandsToRgba(commands: IntArray, width: Int, height: Int): ByteArray {
            val data = ByteArray(width * height * 4)
            var i = 0
            while (i < commands.size) {
                val color = commands[i]; val x = commands[i + 1]; val y = commands[i + 2]; val w = commands[i + 3]; val h = commands[i + 4]
                val r = (color shr 16 and 255).toByte(); val g = (color shr 8 and 255).toByte(); val b = (color and 255).toByte()
                for (py in max(0, y) until min(height, y + h)) for (px in max(0, x) until min(width, x + w)) {
                    val at = (py * width + px) * 4
                    data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = -1
                }
                i += 5
            }
            return data
        }
    }
}
