package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import kotlin.math.floor

/**
 * A realm's deed grid on the global catalog lattice (GLOBE-PRODUCTION-PLAN §2.4.2): `realm.json.grid` gives
 * [x0], [y0], [cols], [rows] on the 720 × 360 lattice of 0.5° deeds, and
 * `tileId = (y0 + dy) · 720 + ((x0 + dx) mod 720)`: it wraps at the antimeridian (Cinderfall has x0 = −5). The inverse
 * is per realm. Deed coordinates (dx, dy) are what every engine layer uses; the tile id is the server's address.
 */
class RealmGrid(val x0: Int, val y0: Int, val cols: Int, val rows: Int, private val deedDeg: Double) {
    init { require(cols > 0 && rows > 0 && cols <= LATTICE_W && rows <= LATTICE_H) { "Bad realm grid ${cols}x$rows" } }

    val size: Int get() = cols * rows

    fun contains(dx: Int, dy: Int): Boolean = dx in 0 until cols && dy in 0 until rows

    /** The catalog tile id of deed (dx, dy); −1 outside the grid or the lattice. */
    fun tileId(dx: Int, dy: Int): Int {
        if (!contains(dx, dy)) return -1
        val row = y0 + dy
        if (row !in 0 until LATTICE_H) return -1
        return row * LATTICE_W + Math.floorMod(x0 + dx, LATTICE_W)
    }

    /** The deed column of catalog tile [tileId] in this grid, or −1 when the tile is outside it. */
    fun deedX(tileId: Int): Int {
        if (tileId !in 0 until LATTICE_W * LATTICE_H) return -1
        val dx = Math.floorMod(tileId % LATTICE_W - x0, LATTICE_W)
        val dy = tileId / LATTICE_W - y0
        return if (contains(dx, dy)) dx else -1
    }

    fun deedY(tileId: Int): Int {
        if (deedX(tileId) < 0) return -1
        return tileId / LATTICE_W - y0
    }

    /** Longitude of deed-space x (fractional deeds; the deed's west edge at whole x), normalised to [−180, 180). */
    fun lonAt(x: Double): Double {
        val lon = -180.0 + (x0 + x) * deedDeg
        return lon - 360.0 * floor((lon + 180.0) / 360.0)
    }

    fun latAt(y: Double): Double = 90.0 - (y0 + y) * deedDeg

    /**
     * Deed-space x of a globe longitude: the representative of the wrapped column that lies in (or nearest to) the
     * grid, so a Cinderfall point east of the antimeridian lands inside the realm instead of clamping to its edge.
     */
    fun xAtLon(lon: Double): Double {
        val span = LATTICE_W.toDouble()
        val raw = (lon + 180.0) / deedDeg - x0
        var best = raw; var bestOut = outside(raw)
        for (k in intArrayOf(-1, 1)) { val c = raw + k * span; val o = outside(c); if (o < bestOut) { best = c; bestOut = o } }
        return best
    }

    fun yAtLat(lat: Double): Double = (90.0 - lat) / deedDeg - y0

    private fun outside(x: Double): Double = if (x < 0) -x else if (x > cols) x - cols else 0.0

    companion object {
        /** The catalog lattice: 720 columns × 360 rows of 0.5° deeds. */
        const val LATTICE_W = 720
        const val LATTICE_H = 360
    }
}

/**
 * The frozen deed catalog (`fantasy/world-v1.json`, `regions[].runs`: inclusive [start, end] tile-id runs per realm):
 * the ONLY deed authority (GLOBE-PRODUCTION-PLAN §2.4.3). Picking, open-deed checks and the uploaded deeds mask use
 * it; a pack's own mask only paints its chart and is compared, never trusted.
 */
class RealmCatalog(regions: Map<String, IntArray>) {
    private val ids = regions.keys.toTypedArray()
    private val runs: Array<IntArray> = Array(ids.size) { i -> regions.getValue(ids[i]).also { validate(ids[i], it) } }

    val realmIds: List<String> get() = ids.toList()

    private fun validate(id: String, r: IntArray) {
        require(r.size % 2 == 0) { "Catalog runs of $id are not pairs" }
        var i = 0; var prev = Int.MIN_VALUE
        while (i < r.size) { require(r[i] <= r[i + 1] && r[i] > prev) { "Catalog runs of $id are not sorted and disjoint" }; prev = r[i + 1]; i += 2 }
    }

    private fun inRuns(r: IntArray, tile: Int): Boolean {
        var lo = 0; var hi = r.size / 2 - 1
        while (lo <= hi) {
            val m = (lo + hi) ushr 1
            if (tile < r[2 * m]) hi = m - 1 else if (tile > r[2 * m + 1]) lo = m + 1 else return true
        }
        return false
    }

    /** Index of the realm that owns [tileId] (−1: none). */
    fun realmIndexOf(tileId: Int): Int { for (i in runs.indices) if (inRuns(runs[i], tileId)) return i; return -1 }
    fun realmOf(tileId: Int): String? = realmIndexOf(tileId).let { if (it < 0) null else ids[it] }

    fun deedCount(realmId: String): Int {
        val r = runs[ids.indexOf(realmId).also { require(it >= 0) { "Unknown realm $realmId" } }]
        var n = 0; var i = 0
        while (i < r.size) { n += r[i + 1] - r[i] + 1; i += 2 }
        return n
    }

    /**
     * The deeds mask of [grid] for [realmId], with the pack's own values: [thisRealm] for this realm's deeds,
     * [otherRealm] for another realm's, 0 for none (open sea).
     */
    fun mask(realmId: String, grid: RealmGrid, thisRealm: Int, otherRealm: Int): ByteArray {
        val own = ids.indexOf(realmId)
        require(own >= 0) { "Realm $realmId is not in the catalog" }
        val out = ByteArray(grid.size)
        for (dy in 0 until grid.rows) for (dx in 0 until grid.cols) {
            val tile = grid.tileId(dx, dy)
            val at = if (tile < 0) -1 else realmIndexOf(tile)
            out[dy * grid.cols + dx] = (if (at == own) thisRealm else if (at >= 0) otherRealm else 0).toByte()
        }
        return out
    }

    companion object {
        /** The app's frozen catalog file (`fantasy/world-v1.json`: `regions[].{id, runs[[start, end]]}`). */
        fun parse(worldJson: String): RealmCatalog {
            val regions = LinkedHashMap<String, IntArray>()
            var r: com.badlogic.gdx.utils.JsonValue? = com.badlogic.gdx.utils.JsonReader().parse(worldJson).get("regions")?.child
                ?: throw IllegalArgumentException("world catalog has no regions")
            while (r != null) {
                val runs = ArrayList<Int>()
                var run = r.get("runs")?.child
                while (run != null) { runs += run.getInt(0); runs += run.getInt(1); run = run.next }
                regions[r.getString("id")] = runs.toIntArray()
                r = r.next
            }
            return RealmCatalog(regions)
        }

        /** Deeds where [pack] and [catalog] disagree on "this realm" (the pack's paint vs the server's truth). */
        fun mismatches(pack: ByteArray, catalog: ByteArray, thisRealm: Int): Int {
            require(pack.size == catalog.size) { "Masks of different grids" }
            var n = 0
            for (i in pack.indices) if (((pack[i].toInt() and 0xff) == thisRealm) != ((catalog[i].toInt() and 0xff) == thisRealm)) n++
            return n
        }
    }
}
