package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.floor

/** Which composed wall frame a wall building shows. Keys are `wallRenderKey` signatures (plus a
 * collapse frame index): the 3×3 context is the complete input of a frame, so keys are reusable
 * across scenes and snapshot refreshes exactly as the web's `WallLayer` reuses them. */
sealed class WallFrameRef {
    abstract val renderKey: String
    abstract val key: String
    data class Live(override val renderKey: String) : WallFrameRef() { override val key: String get() = renderKey }
    /** Frozen pre-breach geometry squashing into material rubble; `frame` follows the collapse clock. */
    data class Collapse(override val renderKey: String, val frame: Int) : WallFrameRef() {
        override val key: String get() = collapseKey(renderKey, frame)
    }
    companion object {
        const val COLLAPSE_MARK = "#collapse"
        fun collapseKey(renderKey: String, frame: Int) = "$renderKey$COLLAPSE_MARK$frame"
    }
}

/** Pure presentation history of the five-tier wall field (`apps/web/src/game/world/walls.ts` +
 * `BattleScene.retileSurvivingWalls`/`onDestroyed`). Canonical hits lower a wall's health and can
 * change its damage stage; a breach captures the collapse before the cell leaves adjacency, and
 * survivors re-resolve immediately. The home base is the same timeline with no events. Walls
 * without authoritative health stay intact: nothing here infers damage. */
class WallFieldTimeline(private val spec: WallArtSpec, buildings: List<RenderBuilding>,
                        events: List<PresentationEvent> = emptyList(), private val tickDurationMs: Float = 1f, checkpoint: () -> Unit = {}) {
    private class Wall(val id: String, val x: Int, val y: Int, val tier: Int, var hp: Long?, val maxHp: Long?)
    private data class Change(val tick: Int, val ref: WallFrameRef)
    private val history = HashMap<String, MutableList<Change>>()
    private val notes = mutableListOf<String>()
    /** Every frame key this timeline can show, including all collapse frames of each breach. */
    val keys: Set<String>
    val isEmpty: Boolean get() = history.isEmpty()
    /** Tolerated input (a hit without a usable `dmg`) worth reporting; never a scene failure. */
    val diagnostics: List<String> get() = notes

    init {
        require(tickDurationMs.isFinite() && tickDurationMs > 0)
        val compositor = WallCompositor(spec)
        val walls = buildings.filter { it.type == "wall" && it.level != null }.map { b ->
            require(b.tileX == floor(b.tileX) && b.tileY == floor(b.tileY)) { "Wall cells sit on whole tiles" }
            require(b.initialHp == null || b.maxHp == null || (b.initialHp >= 0 && b.maxHp >= b.initialHp)) { "Invalid authoritative wall health" }
            Wall(b.id, b.tileX.toInt(), b.tileY.toInt(), spec.tierOfLevel(b.level!!), b.initialHp, b.maxHp)
        }
        val grid = WallGrid()
        val byCell = HashMap<Long, Wall>()
        val byId = HashMap<String, Wall>()
        for (wall in walls) {
            require(byCell.put(WallGrid.key(wall.x, wall.y), wall) == null) { "Overlapping wall presentation cells" }
            require(byId.put(wall.id, wall) == null) { "Duplicate wall identity" }
            grid.put(wall.x, wall.y, cell(wall))
        }
        for (wall in walls) history[wall.id] = mutableListOf(Change(Int.MIN_VALUE, WallFrameRef.Live(compositor.renderKey(grid, wall.x, wall.y))))
        val live = walls.mapTo(HashSet()) { it.id }
        fun retile(x: Int, y: Int, tick: Int) {
            for (dy in -1..1) for (dx in -1..1) {
                val wall = byCell[WallGrid.key(x + dx, y + dy)] ?: continue
                if (wall.id !in live) continue
                val next = WallFrameRef.Live(compositor.renderKey(grid, wall.x, wall.y))
                val changes = history.getValue(wall.id)
                if (changes.last().ref != next) changes += Change(tick, next)
            }
        }
        var previousTick = Int.MIN_VALUE
        for (event in events) {
            checkpoint()
            require(event.t >= previousTick) { "Unordered wall presentation events" }
            previousTick = event.t
            if (event.e != "hit" && event.e != "destroyed") continue
            val data = JsonReader().parse(event.json)
            val target = data.get(if (event.e == "hit") "target" else "id") ?: continue
            if (!target.isString) continue // troop ids are numeric; a building named "1" is a different target
            val wall = byId[target.asString()] ?: continue
            if (wall.id !in live) continue
            if (event.e == "hit") {
                val hp = wall.hp ?: continue
                if (wall.maxHp == null) continue
                // The web applies `hp - dmg` unchecked (BattleScene `onHit`); a hit whose damage is absent
                // or not a whole non-negative number does no presentation damage here and is reported,
                // so an older log or a future sim revision plays instead of failing the scene.
                val damage = data.get("dmg")
                val number = damage?.takeIf { it.isNumber }?.asDouble()
                if (number == null || !number.isFinite() || number < 0 || number % 1.0 != 0.0 || number > 9_007_199_254_740_991.0) {
                    notes += "hit on wall ${wall.id} at tick ${event.t} carries ${if (damage == null) "no dmg" else "a dmg that is not a whole non-negative number"}; no presentation damage"
                    continue
                }
                wall.hp = hp - minOf(hp, number.toLong())
                val next = cell(wall)
                if (grid[wall.x, wall.y] != next) { grid.put(wall.x, wall.y, next); retile(wall.x, wall.y, event.t) }
            } else {
                // Snapshot precedes removal from adjacency; the survivors re-resolve at the same tick.
                history.getValue(wall.id) += Change(event.t, WallFrameRef.Collapse(compositor.renderKey(grid, wall.x, wall.y), 0))
                live -= wall.id
                grid.remove(wall.x, wall.y)
                retile(wall.x, wall.y, event.t)
            }
        }
        keys = history.values.flatMap { changes -> changes.flatMap { change ->
            when (val ref = change.ref) {
                is WallFrameRef.Live -> listOf(ref.key)
                is WallFrameRef.Collapse -> (0 until spec.collapseFrames).map { WallFrameRef.collapseKey(ref.renderKey, it) }
            }
        } }.toSet()
    }

    private fun cell(wall: Wall): WallCell {
        val stage = spec.damageStage(wall.hp, wall.maxHp)
        return WallCell(wall.tier, damage = stage > 0, damageStage = if (stage > 1) 2 else 1)
    }

    /** The frame a wall shows at [tick]; null for anything that is not a wall of this field. A breach at
     * or before [seekFloor] was jumped over by a seek: it shows the final rubble at once, like the web's
     * `collapse(id, jumping)`, rather than a squash frame timed from a breach nobody watched. */
    fun frameAt(id: String, tick: Float, seekFloor: Float = Float.NEGATIVE_INFINITY): WallFrameRef? {
        val changes = history[id] ?: return null
        var low = 0; var high = changes.size
        while (low < high) { val mid = (low + high) ushr 1; if (changes[mid].tick <= tick) low = mid + 1 else high = mid }
        val change = changes[(low - 1).coerceAtLeast(0)]
        return when (val ref = change.ref) {
            is WallFrameRef.Live -> ref
            is WallFrameRef.Collapse -> ref.copy(frame = if (change.tick <= seekFloor) spec.collapseFrames - 1
                else spec.collapseFrameAt(((tick - change.tick) * tickDurationMs).toDouble()))
        }
    }
}

/** Resolved RGBA of composed frames by key, shared by every scene of one pack. Composition is CPU work
 * meant for the presentation thread; the GL thread only reads finished pixels. Only the pixels are kept
 * (never the command list) and [retain] bounds the library to the scene on show, as the web's
 * `WallLayer` frees its textures per scene; an evicted key recomposes from its own context. */
class WallFrameLibrary(private val compositor: WallCompositor) {
    private val pixels = ConcurrentHashMap<String, ByteArray>()
    val size: Int get() = pixels.size
    fun prepare(keys: Collection<String>) { for (key in keys) pixels(key) }
    /** The delivery owns its byte arrays even after the worker evicts its cache. GL never composes. */
    fun snapshot(keys: Set<String>, checkpoint: () -> Unit = {}): Map<String, ByteArray> =
        keys.associateWith { checkpoint(); pixels(it) }.also { retain(keys) }
    fun pixels(key: String): ByteArray = pixels.getOrPut(key) { compose(key).data }
    /** Keep only [keys]; every other frame is released with its atlas cell. */
    fun retain(keys: Set<String>) { pixels.keys.retainAll(keys) }
    private fun compose(key: String): WallFrame {
        val mark = key.indexOf(WallFrameRef.COLLAPSE_MARK)
        if (mark < 0) {
            val (grid, x, y) = compositor.gridFromKey(key)
            return requireNotNull(compositor.composeWall(grid, x, y)) { "Wall key has no centre cell: $key" }
        }
        val frame = key.substring(mark + WallFrameRef.COLLAPSE_MARK.length).toInt()
        val (grid, x, y) = compositor.gridFromKey(key.substring(0, mark))
        val snapshot = requireNotNull(compositor.captureCollapse(grid, x, y, 0.0)) { "Wall key has no centre cell: $key" }
        return compositor.composeCollapse(snapshot, compositor.spec.collapseFrameTimeMs(frame))
    }
}

/** The web seat for a contextual frame: origin (0.5, 1) at `WALL_ART.drawScale` on the tile's south edge. */
fun wallSeat(spec: WallArtSpec, building: RenderBuilding, tilePixels: Float): SpritePlacement =
    placeBuilding(building, tilePixels, spec.tile.toFloat(), spec.contextFrameHeight.toFloat(), spec.seatScale, spec.seatAnchorX, spec.seatOffsetX, spec.seatOffsetY)

/** Fixed-cell page layout for uploading composed frames into a few shared textures instead of one
 * texture per wall (a 250-wall base would otherwise flush the sprite batch 250 times per frame). */
class WallFrameAtlasLayout(val cellWidth: Int, val cellHeight: Int, val pageSize: Int) {
    val columns: Int = pageSize / cellWidth
    val rows: Int = pageSize / cellHeight
    val cellsPerPage: Int = columns * rows
    init { require(cellWidth > 0 && cellHeight > 0 && columns > 0 && rows > 0) { "Wall frames do not fit an atlas page" } }
    fun page(cell: Int): Int = cell / cellsPerPage
    fun x(cell: Int): Int = (cell % cellsPerPage) % columns * cellWidth
    fun y(cell: Int): Int = (cell % cellsPerPage) / columns * cellHeight
}

/** Copies one composed frame into the RGBA mirror of its atlas page at [slot]'s cell. The mirror is what a
 * managed page re-uploads after a GL context loss, so it must hold every resident frame exactly where the
 * page texture has it: a page row is [pageWidth] pixels, a frame row `layout.cellWidth`. */
fun writeWallFrameCell(page: ByteBuffer, pageWidth: Int, layout: WallFrameAtlasLayout, slot: Int, data: ByteArray) {
    require(data.size == layout.cellWidth * layout.cellHeight * 4) { "Wall frame pixels do not fill an atlas cell" }
    require(pageWidth >= layout.columns * layout.cellWidth && slot >= 0) { "Wall frame cell lies outside its page" }
    val x = layout.x(slot); val y = layout.y(slot); val rowBytes = layout.cellWidth * 4
    for (row in 0 until layout.cellHeight) {
        page.position(((y + row) * pageWidth + x) * 4)
        page.put(data, row * rowBytes, rowBytes)
    }
    page.position(0)
}

/** Cell bookkeeping for [WallFrameAtlasLayout]: frames keep their cell across refreshes while still
 * referenced; released cells are reused before new pages are opened. */
class WallFrameAtlasIndex(private val layout: WallFrameAtlasLayout) {
    private val cells = HashMap<String, Int>()
    private val free = ArrayDeque<Int>()
    private var next = 0
    val pages: Int get() = if (next == 0) 0 else layout.page(next - 1) + 1
    fun cell(key: String): Int? = cells[key]
    /** Returns the cell for [key] and whether it was newly allocated (its pixels still need uploading). */
    fun allocate(key: String): Pair<Int, Boolean> {
        cells[key]?.let { return it to false }
        val cell = free.removeFirstOrNull() ?: next++
        cells[key] = cell
        return cell to true
    }
    /** Keep only [keys]; every other frame's cell becomes reusable. */
    fun retain(keys: Set<String>) {
        val iterator = cells.entries.iterator()
        while (iterator.hasNext()) { val entry = iterator.next(); if (entry.key !in keys) { free += entry.value; iterator.remove() } }
    }
    fun clear() { cells.clear(); free.clear(); next = 0 }
}
