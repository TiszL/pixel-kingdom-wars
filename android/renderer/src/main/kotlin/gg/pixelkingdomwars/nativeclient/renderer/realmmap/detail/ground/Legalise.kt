package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Classes

/** The 14 semantic classes by name (contracts.js `CLASS`, generated) and their legalise ranks (classify.js `CLASS_RANK`). */
object ClassNames {
    const val COUNT = 14
    val BY_NAME: Map<String, Int> = linkedMapOf(
        "DEEP" to Classes.DEEP, "SEA" to Classes.SEA, "WATER" to Classes.WATER, "SHORE" to Classes.SHORE, "WILD" to Classes.WILD,
        "GROUND2" to Classes.GROUND2, "FIELD" to Classes.FIELD, "ROCK" to Classes.ROCK, "SNOW" to Classes.SNOW, "SPECIAL" to Classes.SPECIAL,
        "ROAD" to Classes.ROAD, "TURF" to Classes.TURF, "RING" to Classes.RING, "FOREST" to Classes.FOREST,
    )
    /** contracts.js `Object.keys(CLASS)` order (what `Object.keys(CLASS).find(…)` walks). */
    val NAMES_IN_KEY_ORDER: List<String> = BY_NAME.keys.toList()
    fun name(c: Int): String? = BY_NAME.entries.firstOrNull { it.value == c }?.key

    /** classify.js §3.2 step 5 rule order → legalise priority rank (0 = highest). SNOW rides with ROCK. */
    private val ORDER = listOf("TURF", "RING", "DEEP", "SEA", "WATER", "SHORE", "ROCK", "SNOW", "ROAD", "FIELD", "FOREST", "SPECIAL", "GROUND2", "WILD")
    val RANK: IntArray = IntArray(COUNT) { 99 }.also { r -> ORDER.forEachIndexed { i, n -> r[BY_NAME.getValue(n)] = i } }
}

/**
 * A band's drawability table (classify.js `bandTable`): class → terrain id (null = unmapped), legal neighbour pairs
 * (equal, joined by a family, or both uppers over a shared lower), and each class's fallback (−1 none).
 */
class BandTable(val terrainOf: Array<String?>, val fallback: IntArray, private val pair: Set<String>, private val lowerOf: Map<String, Set<String>>,
                private val shared: List<String>) {
    val rank: IntArray = ClassNames.RANK

    fun legal(a: String?, b: String?): Boolean {
        if (a == b || a == null || b == null) return true
        if (pair.contains("$a|$b")) return true
        if (shared.contains(a) && lowerOf[b]?.contains(a) == true) return true
        if (shared.contains(b) && lowerOf[a]?.contains(b) == true) return true
        val la = lowerOf[a]; val lb = lowerOf[b]
        if (la != null && lb != null) for (s in shared) if (la.contains(s) && lb.contains(s)) return true
        return false
    }

    companion object {
        /** classify.js `bandTable(spec)`: [classToTerrain] name → terrain, [families] (lower, upper), [fallback] name → name. */
        fun of(classToTerrain: List<Pair<String, String?>>, families: List<Pair<String, String>>, fallback: List<Pair<String, String>>,
               sharedLower: List<String> = emptyList()): BandTable {
            val terrainOf = arrayOfNulls<String>(ClassNames.COUNT)
            for ((n, t) in classToTerrain) ClassNames.BY_NAME[n]?.let { terrainOf[it] = t }
            val pair = HashSet<String>(); val lowerOf = LinkedHashMap<String, LinkedHashSet<String>>()
            for ((lower, upper) in families) {
                pair += "$lower|$upper"; pair += "$upper|$lower"
                lowerOf.getOrPut(upper) { LinkedHashSet() } += lower
            }
            val fb = IntArray(ClassNames.COUNT) { -1 }
            for ((n, to) in fallback) { val a = ClassNames.BY_NAME[n]; val b = ClassNames.BY_NAME[to]; if (a != null && b != null) fb[a] = b }
            return BandTable(terrainOf, fb, pair, lowerOf, sharedLower.distinct())
        }

        /**
         * classify.js `mapBandTable(map, over)`: the MAP table from realm.json `map` ({ wild, families: { M1: {lower,
         * upper} … }, classToTerrain, snowPeaks }): terrains are the family keys plus the wild id.
         */
        fun map(map: JsonValue, over: List<Pair<String, String>> = emptyList()): BandTable {
            val wild = map.getString("wild")
            val keyOfUpper = HashMap<String, String>()
            val fam = map.get("families")
            var f = fam?.child
            while (f != null) { keyOfUpper[f.getString("upper")] = f.name; f = f.next }
            fun lowerKey(lower: String) = if (lower == wild) wild else keyOfUpper[lower] ?: lower
            val families = ArrayList<Pair<String, String>>()
            f = fam?.child
            while (f != null) { families += Pair(lowerKey(f.getString("lower")), f.name); f = f.next }
            val snow = map.get("snowPeaks")?.let { it.isBoolean && it.asBoolean() || (it.isNumber && it.asDouble() != 0.0) } ?: false
            fun pick(v: String): String = if (v.contains('|')) v.split('|')[if (snow) 0 else 1] else v
            val cls2t = ArrayList<Pair<String, String?>>()
            var c = map.get("classToTerrain")?.child
            while (c != null) { val v = pick(c.asString()); cls2t += Pair(c.name, if (v == "WILD") wild else v); c = c.next }
            fun t(cls: String) = cls2t.firstOrNull { it.first == cls }?.second
            fun classOf(terr: String): String? = listOf("ROCK", "SNOW", "GROUND2", "FIELD", "FOREST", "SPECIAL", "WILD").firstOrNull { t(it) == terr }
            val fallback = LinkedHashMap<String, String>()
            for ((cls, terr) in cls2t) {
                if (terr == wild) continue
                val fm = families.firstOrNull { it.second == terr }
                fallback[cls] = if (fm != null && fm.first != wild) (classOf(fm.first) ?: "WILD") else "WILD"
            }
            for ((k, v) in over) fallback[k] = v
            return of(cls2t, families, fallback.entries.map { Pair(it.key, it.value) }, listOf(wild))
        }

        /** ground.js trueSetup's table: realm.json `true` (classToTerrain, families [{lower, upper}], fallback). */
        fun trueBand(t: JsonValue): BandTable {
            val cls2t = ArrayList<Pair<String, String?>>()
            var c = t.get("classToTerrain")?.child
            while (c != null) { cls2t += Pair(c.name, if (c.isNull) null else c.asString()); c = c.next }
            val fams = ArrayList<Pair<String, String>>()
            var f = t.get("families")?.child
            while (f != null) { fams += Pair(f.getString("lower"), f.getString("upper")); f = f.next }
            val fb = ArrayList<Pair<String, String>>()
            var b = t.get("fallback")?.child
            while (b != null) { if (b.isString) fb += Pair(b.name, b.asString()); b = b.next }
            return of(cls2t, fams, fb)
        }
    }
}

/** The legalise program's integer tables (ground.js `legaliseTables`). */
class LegaliseTables(val ids: List<String>, val terr: IntArray, val legal: IntArray, val fallback: IntArray, val rank: IntArray) {
    companion object {
        fun of(table: BandTable): LegaliseTables {
            val ids = ArrayList<String>()
            fun idx(t: String?): Int {
                if (t == null) return 15
                var i = ids.indexOf(t); if (i < 0) { ids += t; i = ids.size - 1 }
                return minOf(i, 14)
            }
            val terr = IntArray(table.terrainOf.size) { idx(table.terrainOf[it]) }
            val legal = IntArray(16)
            for (a in ids.indices) for (b in ids.indices) if (table.legal(ids[a], ids[b])) legal[a] = legal[a] or (1 shl b)
            legal[15] = 0xffff; for (a in 0 until 16) legal[a] = legal[a] or (1 shl 15)
            return LegaliseTables(ids, terr, legal, table.fallback.copyOf(), table.rank.copyOf())
        }
    }
}

/** The CPU references of the GPU resolve passes (classify.js legalise, despeckle, latticePure, resolveRegion). */
object Resolve {
    /** classify.js `DESPECKLE_PASSES` / `despeckleMode` (TRUE) and `MAP_DESPECKLE` / `mapDespeckleMode` (lattice). */
    const val DESPECKLE_PASSES = 6
    fun despeckleMode(k: Int): Int = if (k == 0) 1 else 3
    const val MAP_DESPECKLE = 2
    fun mapDespeckleMode(k: Int): Int = if (k == 0) 12 else 4

    private val N8 = arrayOf(intArrayOf(-1, -1), intArrayOf(0, -1), intArrayOf(1, -1), intArrayOf(-1, 0), intArrayOf(1, 0), intArrayOf(-1, 1), intArrayOf(0, 1), intArrayOf(1, 1))

    /** classify.js `victimOf`: which vertex of an illegal pair collapses (0 / 1), −1 none. */
    fun victimOf(table: BandTable, ca: Int, cb: Int): Int {
        val fa = table.fallback[ca]; val fb = table.fallback[cb]; val first = table.rank[ca] <= table.rank[cb]
        if (first && fa >= 0) return 0
        if (!first && fb >= 0) return 1
        if (fa >= 0) return 0
        if (fb >= 0) return 1
        return -1
    }

    class LegaliseResult(val grid: ByteArray, val collapsed: Int, val illegal: Int)

    /** classify.js `legalise`: 8-neighbour Jacobi passes (each reads the previous grid, as the GPU pass does). */
    fun legalise(grid: ByteArray, w: Int, h: Int, table: BandTable, passes: Int = 2): LegaliseResult {
        var cur = grid.copyOf(); var collapsed = 0
        for (p in 0 until passes) {
            val next = cur.copyOf(); var changed = 0
            for (y in 0 until h) for (x in 0 until w) {
                val c = cur[y * w + x].toInt() and 0xff; val t = table.terrainOf[c]
                for (o in N8) {
                    val nx = x + o[0]; val ny = y + o[1]; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
                    val n = cur[ny * w + nx].toInt() and 0xff
                    if (n == c || table.legal(t, table.terrainOf[n])) continue
                    if (victimOf(table, c, n) == 0) { next[y * w + x] = table.fallback[c].toByte(); changed++; break }
                }
            }
            collapsed += changed; cur = next
            if (changed == 0) break
        }
        var illegal = 0
        for (y in 0 until h) for (x in 0 until w) {
            val t = table.terrainOf[cur[y * w + x].toInt() and 0xff]
            for (k in 4 until 8) {
                val nx = x + N8[k][0]; val ny = y + N8[k][1]; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
                if (!table.legal(t, table.terrainOf[cur[ny * w + nx].toInt() and 0xff])) illegal++
            }
        }
        return LegaliseResult(cur, collapsed, illegal)
    }

    private fun isWet(c: Int) = c <= Classes.WATER
    private fun isPlotCls(c: Int) = c == Classes.TURF || c == Classes.RING

    private fun majority(n: IntArray, wet: Boolean): Int {
        var best = -1; var bc = 0
        for (k in 0 until 4) {
            if (isWet(n[k]) != wet) continue
            var c = 0; for (m in 0 until 4) if (n[m] == n[k]) c++
            if (c > bc) { bc = c; best = n[k] }
        }
        return best
    }

    class DespeckleResult(val grid: ByteArray, val flipped: Int, val ring: ByteArray?)

    /** classify.js `despeckle`: one Jacobi pass removing 1-vertex runs across the water line (mode bits 1 fill, 2 erode,
     *  4 isolated dry vertex, 8 a 1-wide upper-terrain run); ring-flagged vertices only fill. */
    fun despeckle(grid: ByteArray, w: Int, h: Int, mode: Int = 3, ring: ByteArray? = null): DespeckleResult {
        val out = grid.copyOf(); val ringOut = ring?.copyOf(); var flipped = 0; val n = IntArray(4); val nb = IntArray(4)
        fun plotN(k: Int) = isPlotCls(n[k])
        fun okTo(c: Int, k: Int) = !isWet(c) && !isPlotCls(c) && !(ring != null && ring[nb[k]].toInt() == 1)
        for (y in 1 until h - 1) for (x in 1 until w - 1) {
            val i = y * w + x; val c = grid[i].toInt() and 0xff
            if (isPlotCls(c)) continue
            val flagged = ring != null && ring[i].toInt() == 1
            nb[0] = i - 1; nb[1] = i + 1; nb[2] = i - w; nb[3] = i + w
            n[0] = grid[i - 1].toInt() and 0xff; n[1] = grid[i + 1].toInt() and 0xff; n[2] = grid[i - w].toInt() and 0xff; n[3] = grid[i + w].toInt() and 0xff
            val wx = isWet(n[0]); val wx1 = isWet(n[1]); val wy = isWet(n[2]); val wy1 = isWet(n[3])
            if (flagged) {
                if (!isWet(c) && (mode and 1) != 0 && ((wx && wx1) || (wy && wy1))) { out[i] = majority(n, true).toByte(); ringOut!![i] = 0; flipped++ }
                continue
            }
            if (!isWet(c)) {
                if ((mode and 1) != 0 && ((wx && wx1) || (wy && wy1))) { out[i] = majority(n, true).toByte(); flipped++ }
                else if ((mode and 8) != 0 && c != Classes.ROAD && c != Classes.WILD && ((n[0] != c && n[1] != c) || (n[2] != c && n[3] != c))) {
                    val a = if (n[2] != c && n[3] != c) 2 else 0; val aa = n[a]; val bb = n[a + 1]; val oa = okTo(aa, a); val ob = okTo(bb, a + 1)
                    val to = if (oa && ob) (if (aa == bb || aa == Classes.WILD || (aa == Classes.GROUND2 && bb != Classes.WILD)) aa else bb) else if (oa) aa else if (ob) bb else -1
                    if (to >= 0 && to != c) { out[i] = to.toByte(); flipped++ }
                } else if ((mode and 4) != 0 && n[0] != c && n[1] != c && n[2] != c && n[3] != c) {
                    val to = majority(n, false); if (to >= 0 && !isPlotCls(to)) { out[i] = to.toByte(); flipped++ }
                }
            } else if ((mode and 2) != 0 && ((!wx && !wx1) || (!wy && !wy1)) && !plotN(0) && !plotN(1) && !plotN(2) && !plotN(3)) {
                val to = majority(n, false); if (to >= 0) { out[i] = to.toByte(); flipped++ }
            }
        }
        return DespeckleResult(out, flipped, ringOut)
    }

    /** classify.js `latticePure`: 1 where a vertex and its 8 neighbours draw the same MAP slot (border vertices 0). */
    fun latticePure(grid: ByteArray, w: Int, h: Int, slots: IntArray): ByteArray {
        val out = ByteArray(w * h)
        for (y in 1 until h - 1) for (x in 1 until w - 1) {
            val s = slots[grid[y * w + x].toInt() and 0xff]; var one = true
            var j = -1
            while (j <= 1 && one) { for (i in -1..1) if (slots[grid[(y + j) * w + x + i].toInt() and 0xff] != s) { one = false; break }; j++ }
            out[y * w + x] = if (one) 1 else 0
        }
        return out
    }

    class Region(val grid: ByteArray, val ground: ByteArray, val ring: ByteArray, val collapsed: Int, val illegal: Int, val flipped: Int, val pure: ByteArray?)

    /**
     * classify.js `resolveRegion`: resolve + despeckle + legalise vertices (x0 + i·step, y0 + j·step), i < w, j < h, on an
     * apron of `passes + despeckle (+ 1 with slots)` vertices so the cropped result equals a tiled GPU resolve. step 1 =
     * a TRUE page (6 despeckle passes), step 7 = the MAP lattice (2, with the lattice class config).
     */
    fun region(cls: Classify, fields: Fields, lines: Lines?, state: BaseState?, x0: Int, y0: Int, w: Int, h: Int, step: Int, table: BandTable?, cfg: ClassCfg,
               passes: Int = 2, despeckle: Int = if (step == 1) DESPECKLE_PASSES else MAP_DESPECKLE, slots: IntArray? = null): Region {
        val c = if (step > 1) cfg.lattice() else cfg
        val a = if (table != null) passes + despeckle + (if (slots != null) 1 else 0) else 0; val ww = w + 2 * a; val hh = h + 2 * a
        var raw = ByteArray(ww * hh); var ring = ByteArray(ww * hh)
        val d = ClassDetail()
        for (j in 0 until hh) for (i in 0 until ww) {
            cls.classDetail(fields, lines, state, (x0 + (i - a) * step).toDouble(), (y0 + (j - a) * step).toDouble(), c, d)
            raw[j * ww + i] = d.ground.toByte(); ring[j * ww + i] = if (d.ring) 1 else 0
        }
        if (table == null) {
            val g = ByteArray(ww * hh) { if (ring[it].toInt() != 0) Classes.RING.toByte() else raw[it] }
            return Region(g, raw, ring, 0, 0, 0, null)
        }
        var flipped = 0
        for (k in 0 until despeckle) { val r = despeckle(raw, ww, hh, if (step == 1) despeckleMode(k) else mapDespeckleMode(k), ring); raw = r.grid; ring = r.ring!!; flipped += r.flipped }
        val l = legalise(raw, ww, hh, table, passes)
        val ground = ByteArray(w * h); val rg = ByteArray(w * h)
        for (j in 0 until h) { System.arraycopy(l.grid, (j + a) * ww + a, ground, j * w, w); System.arraycopy(ring, (j + a) * ww + a, rg, j * w, w) }
        val grid = ByteArray(w * h) { if (rg[it].toInt() != 0) Classes.RING.toByte() else ground[it] }
        val pure = if (slots != null) latticePure(l.grid, ww, hh, slots) else null
        val pureOut = pure?.let { p -> ByteArray(w * h).also { o -> for (j in 0 until h) System.arraycopy(p, (j + a) * ww + a, o, j * w, w) } }
        return Region(grid, ground, rg, l.collapsed, l.illegal, flipped, pureOut)
    }
}
