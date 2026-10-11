package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import kotlin.math.abs
import kotlin.math.hypot

/**
 * The resident realm's bases as the map reads them (map.js `R.bases`, `passes`, `applyFilter`, `pushSelection`, `step`,
 * `pick`): one entry per occupied deed of a [WorldBases] snapshot, with the web's base-state `FLAG` bits. The deed is
 * the unit of picking and selection; the plot centre ([plotX], [plotY], contracts.js `plotCentre`) is where the
 * minimap dot, fly targets and tags aim. Server data only: nothing here decides who may be attacked.
 */
class RealmBases(private val plots: RealmPlotRules) {
    var cols = 0; private set
    var rows = 0; private set
    var size = 0; private set
    var deedX = IntArray(0); private set
    var deedY = IntArray(0); private set
    var level = IntArray(0); private set
    var flags = IntArray(0); private set
    /** The base's read carried a shield bit ([WorldBases.shieldKnown]); false: absent, so UNSHIELDED never passes it. */
    var shieldKnown = BooleanArray(0); private set
    var plotX = DoubleArray(0); private set
    var plotY = DoubleArray(0); private set
    /** deed index → base index + 1 (0 = no base). */
    private var byCell = IntArray(0)
    var filtered = BooleanArray(0); private set
    var filteredCount = 0; private set
    var filter = WorldFilter(WorldFilterKind.ALL); private set
    var epoch = -1L; private set
    /** Bumped by every change of the bases, the filter or the selection (label layouts recompute on a change). */
    var version = 0; private set

    // selection: a base, or a free (open) deed
    var selectedBase = -1; private set
    var selectedFreeX = -1; private set
    var selectedFreeY = -1; private set
    val hasSelection: Boolean get() = selectedBase >= 0 || selectedFreeX >= 0

    fun reset(cols: Int, rows: Int) {
        this.cols = cols; this.rows = rows; size = 0; epoch = -1L
        byCell = IntArray(cols * rows); clearSelection()
        ensure(0)
    }

    private fun ensure(n: Int) {
        if (deedX.size >= n && deedX.isNotEmpty()) return
        val c = maxOf(16, n)
        deedX = IntArray(c); deedY = IntArray(c); level = IntArray(c); flags = IntArray(c); shieldKnown = BooleanArray(c)
        plotX = DoubleArray(c); plotY = DoubleArray(c); filtered = BooleanArray(c)
    }

    /** Replace the bases with a server snapshot (bases outside the grid are dropped, never wrapped into it). */
    fun set(snapshot: WorldBases) {
        val keepX = if (selectedBase >= 0) deedX[selectedBase] else -1; val keepY = if (selectedBase >= 0) deedY[selectedBase] else -1
        ensure(snapshot.size)
        byCell.fill(0); size = 0
        for (i in 0 until snapshot.size) {
            val x = snapshot.deedX[i]; val y = snapshot.deedY[i]
            if (x !in 0 until cols || y !in 0 until rows || byCell[y * cols + x] != 0) continue
            val n = size++
            deedX[n] = x; deedY[n] = y; level[n] = plots.clampLevel(snapshot.level[i].toDouble()); flags[n] = snapshot.flags[i]
            shieldKnown[n] = snapshot.shieldKnown?.get(i) ?: false
            plotX[n] = plots.centreX(x, y, level[n]); plotY[n] = plots.centreY(x, y, level[n])
            byCell[y * cols + x] = n + 1
        }
        epoch = snapshot.epoch
        selectedBase = if (keepX >= 0) baseAt(keepX, keepY) else -1
        // An open deed picked before its kingdom's marker loaded (the feed is windowed): the kingdom owns it now, so the
        // selection is that kingdom (the web draws the open-land box only while `api.selected.free` is set).
        if (selectedFreeX >= 0) baseAt(selectedFreeX, selectedFreeY).let { if (it >= 0) { selectedBase = it; selectedFreeX = -1; selectedFreeY = -1 } }
        applyFilter(filter)
        version++
    }

    fun baseAt(x: Int, y: Int): Int = if (x in 0 until cols && y in 0 until rows) byCell[y * cols + x] - 1 else -1
    fun mine(i: Int) = flags[i] and FLAG_MINE != 0
    fun mineIndex(): Int { for (i in 0 until size) if (mine(i)) return i; return -1 }

    /** map.js `passes(b)`: the level range, then the chip. UNSHIELDED (SHARDKEEP D-191) passes only a shield bit the
     *  read carried as false: an absent bit is unknown, never unshielded (D-169 / D-181: hidden, not faked). */
    fun passes(i: Int, f: WorldFilter = filter): Boolean {
        val lv = f.levels
        if (lv != null && (level[i] < lv.first || level[i] > lv.last)) return false
        return when (f.kind) {
            WorldFilterKind.MINE -> mine(i)
            WorldFilterKind.CLAN -> flags[i] and FLAG_CLAN != 0
            WorldFilterKind.ATTACKABLE -> flags[i] and FLAG_ATTACKABLE != 0
            WorldFilterKind.UNSHIELDED -> shieldKnown[i] && flags[i] and FLAG_SHIELD == 0
            WorldFilterKind.ALL, WorldFilterKind.LEVEL -> true
        }
    }

    /**
     * SHARDKEEP D-191 (owner 2026-09-28, a player: "I sort to level 7-20, it still shows me keeps below level 6"): a
     * kingdom the active filter drops draws NOTHING on the map (no dot, marker, keep, minis, emitters, tag or dome); its
     * deed stays an occupied plot on the ground. The one exception is the selected kingdom, whose card is up. Before
     * D-191 both clients dimmed it, which players read as the filter doing nothing. The minimap keeps its own look.
     */
    fun drawn(i: Int): Boolean = filtered[i] || i == selectedBase

    /** map.js `filterActive`: a chip other than All, or a level range narrower than every level. */
    val filterActive: Boolean
        get() = filter.kind != WorldFilterKind.ALL || filter.levels?.let { it.first > 1 || it.last < plots.maxLevel } == true

    fun applyFilter(f: WorldFilter) {
        filter = f; filteredCount = 0
        for (i in 0 until size) { val ok = passes(i, f); filtered[i] = ok; if (ok) filteredCount++ }
        version++
    }

    fun select(base: Int) { clearSelection(); if (base in 0 until size) selectedBase = base }
    fun selectFree(x: Int, y: Int) { clearSelection(); selectedFreeX = x; selectedFreeY = y }
    fun clearSelection() { selectedBase = -1; selectedFreeX = -1; selectedFreeY = -1; version++ }
    val selectedX: Int get() = if (selectedBase >= 0) deedX[selectedBase] else selectedFreeX
    val selectedY: Int get() = if (selectedBase >= 0) deedY[selectedBase] else selectedFreeY
    /** The selection's aim point in deed units (plot centre of a base; deed centre of an open deed). */
    val selectedAimX: Double get() = if (selectedBase >= 0) plotX[selectedBase] else selectedFreeX + 0.5
    val selectedAimY: Double get() = if (selectedBase >= 0) plotY[selectedBase] else selectedFreeY + 0.5

    /** map.js occupancy: `(mine ? 2 : 1) | (selected ? 4 : 0)` per base deed, 0 elsewhere. */
    fun occupancy(out: ByteArray) {
        out.fill(0)
        for (i in 0 until size) out[deedY[i] * cols + deedX[i]] = ((if (mine(i)) 2 else 1) or (if (i == selectedBase) 4 else 0)).toByte()
    }

    /**
     * minimap.js `setBases` order and flags into the caller's arrays: others first, then mine, then the selection
     * (a base or an open deed) last. Returns the count; the arrays must hold [size] + 1.
     */
    fun minimapPoints(x: DoubleArray, y: DoubleArray, fl: IntArray): Int {
        val active = filterActive; val attack = filter.kind == WorldFilterKind.ATTACKABLE
        var n = 0
        for (pass in 0..1) for (i in 0 until size) {
            if (mine(i) != (pass == 1)) continue
            x[n] = plotX[i]; y[n] = plotY[i]
            fl[n] = (if (mine(i)) 1 else 0) or (if (active && filtered[i]) 2 else 0) or (if (attack && flags[i] and FLAG_ATTACKABLE != 0) 4 else 0)
            n++
        }
        if (hasSelection) { x[n] = selectedAimX; y[n] = selectedAimY; fl[n] = 8; n++ }
        return n
    }

    /**
     * The main view's stand-in occupancy dots (SHARDKEEP D-191): only the DRAWN bases ([drawn]: filtered-in, plus the
     * selection), in [minimapPoints]'s order, the selection point last. No filtered-in bit (2): the main view never dims a
     * kingdom, it hides it, and the core draws this list with the dim state off. The minimap keeps [minimapPoints] and
     * its 15 % look. Returns the count; the arrays must hold [size] + 1.
     */
    fun standInPoints(x: DoubleArray, y: DoubleArray, fl: IntArray): Int {
        val attack = filter.kind == WorldFilterKind.ATTACKABLE
        var n = 0
        for (pass in 0..1) for (i in 0 until size) {
            if (mine(i) != (pass == 1) || !drawn(i)) continue
            x[n] = plotX[i]; y[n] = plotY[i]
            fl[n] = (if (mine(i)) 1 else 0) or (if (attack && flags[i] and FLAG_ATTACKABLE != 0) 4 else 0)
            n++
        }
        if (hasSelection) { x[n] = selectedAimX; y[n] = selectedAimY; fl[n] = 8; n++ }
        return n
    }

    /** map.js `step(dir)`: the proximity walk inside the filtered list from the selection (or the camera centre). */
    fun step(dir: Int, camX: Double, camY: Double): Int {
        if (filteredCount == 0) return -1
        val cur = selectedBase
        val ox = if (cur >= 0) deedX[cur].toDouble() else camX; val oy = if (cur >= 0) deedY[cur].toDouble() else camY
        var best = -1; var bd = Double.POSITIVE_INFINITY
        for (i in 0 until size) {
            if (!filtered[i] || i == cur) continue
            val dx = (deedX[i] - ox) * dir
            if (dx <= 0) continue
            val s = hypot(deedX[i] - ox, deedY[i] - oy) + abs(deedY[i] - oy) * 0.6
            if (s < bd) { bd = s; best = i }
        }
        if (best >= 0) return best
        for (i in 0 until size) {
            if (!filtered[i]) continue
            if (best < 0 || (if (dir > 0) deedX[i] < deedX[best] else deedX[i] > deedX[best])) best = i
        }
        return best
    }

    companion object {
        /** contracts.js `FLAG` bits (the base-state texture and the [WorldBases] snapshot). */
        const val FLAG_OCCUPIED = 1
        const val FLAG_MINE = 2
        const val FLAG_SHIELD = 4
        const val FLAG_ATTACKABLE = 8
        const val FLAG_CLAN = 64
    }
}

/** Result of [RealmPick.pick]: a base index, an open deed of this realm, or nothing. */
class RealmPickResult {
    var kind = NONE
    var base = -1
    var deedX = -1
    var deedY = -1
    fun clear() { kind = NONE; base = -1; deedX = -1; deedY = -1 }
    companion object { const val NONE = 0; const val BASE = 1; const val OPEN = 2 }
}

/** map.js `pick(sx, sy)` without a BASES lane: the deed under a CSS px point, a base on it, or an open deed that the
 *  CATALOG mask marks as this realm's (never the pack's paint). */
object RealmPick {
    fun pick(cam: RealmCamera, bases: RealmBases, deeds: ByteArray, thisRealm: Int, sx: Double, sy: Double, out: RealmPickResult): RealmPickResult {
        out.clear()
        val x = Math.floor(cam.screenToDeedX(sx)).toInt(); val y = Math.floor(cam.screenToDeedY(sy)).toInt()
        if (x < 0 || y < 0 || x >= bases.cols || y >= bases.rows) return out
        val b = bases.baseAt(x, y)
        if (b >= 0) { out.kind = RealmPickResult.BASE; out.base = b; out.deedX = x; out.deedY = y; return out }
        if ((deeds[y * bases.cols + x].toInt() and 0xff) == thisRealm) { out.kind = RealmPickResult.OPEN; out.deedX = x; out.deedY = y }
        return out
    }
}
