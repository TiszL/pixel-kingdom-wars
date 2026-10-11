package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPlotRules
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash

/** One decor sprite instance (decor.js instance): deed-local tiles; the cell point [anchor] lands on ([tx], [ty]). */
class DecorSprite(
    val key: String, val atlas: String, val kind: String, val role: String?, val fam: String?, val fx: Int, val fy: Int, val fp: IntArray,
    var tx: Double, var ty: Double, var z: Double, val anchor: DoubleArray, val scale: Double, val cell: IntArray, val ink: IntArray, val rows: Int,
    val clipFrames: Int, val clipMs: Int, val flipX: Boolean, var phase: Int,
) {
    val clip: Boolean get() = clipFrames > 0
    fun copyWithPhase(p: Int) = DecorSprite(key, atlas, kind, role, fam, fx, fy, fp, tx, ty, z, anchor, scale, cell, ink, rows, clipFrames, clipMs, flipX, p)
}
class DecorWall(val tier: Int, val x: Int, val y: Int, val piece: String, val ring: String)
class DecorEdge(val style: String, val x: Int, val y: Int, val piece: String, val mask: Int, val loop: Int)
class DecorEmitter(val kind: String, val attach: String?, val tx: Double, val ty: Double, val dx: Double, val dy: Double, val r: Double?, val a: Double?)
class DecorGround(val x: Int, val y: Int, val k: Int, val t: Int, val p: Int)
class DecorPatch(val kind: String, val seg: String, val cells: Int, val crop: String?, val hedged: Boolean?)
class InkBox(val x0: Double, val y0: Double, val x1: Double, val y1: Double)

/** decor.js `plotGeometry`: the plot geometry shared by GROUND, PACK and the composer (deed-local tiles). */
class PlotGeometry(
    val level: Int, val s: Int, val a: Int, val b: Int, val ring: Int, val p0: Int, val p1: Int, val o0: Int, val o1: Int, val doubled: Boolean,
    val wIn: Int, val wInHi: Int, val citadel: IntArray?, val court: IntArray, val wallRings: Int, val wallTier: Int, val lanes: IntArray, val keep: IntArray,
)

/** composeBaseDecor's result (decor.js): a kingdom's decor, pure in (level, realm, seed, gates). */
class BaseDecor(
    val level: Int, val realmId: String, val formation: Int, val geometry: PlotGeometry, val claim: IntArray, val plot: IntArray, val keep: DecorSprite,
    val walls: List<DecorWall>, val sprites: List<DecorSprite>, val emitters: List<DecorEmitter>, val omitted: List<String>, val seed: Long,
    val edges: List<DecorEdge>, val ground: List<DecorGround>, val lanes: Map<String, List<IntArray>>, val laneEnds: Map<String, Int>,
    val gates: List<String>, val patches: List<DecorPatch>,
)

/**
 * Level decor of a claimed deed (web `decor.js` `composeBaseDecor`, pinned), 1:1: PURE and DETERMINISTIC, the same
 * (level, realm, seed, gates) always yields the same kingdom, so the MAP mini-sprites and TRUE sprites of one base sit on
 * the same seats and the web and native clients draw the same plot layout (golden vectors, 100 %). The decor is an
 * ILLUSTRATION of a level-L kingdom, never the real defence layout (scouting is metered, plan §6.3).
 *
 * Game numbers come from [DecorGame] (the catalogue); presentation tables from [DecorTables]; plot rules from NM's
 * [RealmPlotRules] (contracts.js `plotRule`/`plotOffset`). Throws exactly where the web throws (a kingdom that cannot be
 * laid out is an error, never a silent drop).
 */
class Decor(val t: DecorTables, val game: DecorGame, val plots: RealmPlotRules) {
    private val tiles = game.tilesPerDeed
    private val art = game.art.toDouble()
    private val c = plots.plotCentre
    private val kw = game.keepFootprint[0]; private val kh = game.keepFootprint[1]
    private val k0 = c - kw / 2
    private val lanesX = IntArray(kw) { k0 + it }
    private val inset = game.outerWallInset
    private val cache = HashMap<String, Layout>()

    // ---------------------------------------------------------------- rules

    fun decorBand(l: Int): Int = if (l <= 1) 0 else if (l <= 4) 1 else if (l <= 8) 2 else if (l <= 12) 3 else if (l <= 16) 4 else 5
    fun towerTier(level: Int): Int = Math.min(4, Math.max(1, Math.ceil(level / 5.0).toInt()))

    fun plotGeometry(level: Int): PlotGeometry {
        val r = plots.rule(level); val s = r.claim; val a = c - s / 2; val b = c + s / 2
        val o0 = a + inset; val o1 = b - 1 - inset; val doubled = r.wallRings >= 3
        val wIn = o0 + 1 + (if (doubled) 1 else 0); val wInHi = o1 - 1 - (if (doubled) 1 else 0)
        val q0 = t.keepFit.courtyard[0]; val q1 = t.keepFit.courtyard[1]
        val citadel = if (r.wallRings >= 2) intArrayOf(q0, q1 - 1) else null
        val court = if (citadel != null) intArrayOf(q0 + 1, q1 - 1) else intArrayOf(q0, q1)
        return PlotGeometry(r.level, s, a, b, r.ring, a - r.ring, b + r.ring, o0, o1, doubled, wIn, wInHi, citadel, court, r.wallRings, r.wallTier,
            lanesX.copyOf(), intArrayOf(k0, k0 + kw))
    }

    private fun isLane(g: PlotGeometry, x: Int, y: Int): Boolean {
        val top = g.citadel?.get(0) ?: g.court[0]
        val southStop = g.citadel?.get(1) ?: g.court[1]
        val west = g.citadel?.get(0) ?: g.court[0]; val east = if (g.citadel != null) g.citadel[1] + 1 else g.court[1]
        if (lanesX.contains(x) && (y < top || y >= southStop)) return true
        if (lanesX.contains(y) && (x < west || x >= east)) return true
        return false
    }

    private fun ringWalk(a: Int, b: Int): MutableList<IntArray> {
        val out = ArrayList<IntArray>()
        if (b < a) return out
        for (x in a..b) out += intArrayOf(x, b)
        for (y in b - 1 downTo a) out += intArrayOf(b, y)
        for (x in b - 1 downTo a) out += intArrayOf(x, a)
        for (y in a + 1..b - 1) out += intArrayOf(a, y)
        return out
    }

    private class Piece(val x: Int, val y: Int, val piece: String, val mask: Int)
    private fun resolvePieces(cells: List<IntArray>): List<Piece> {
        val has = HashSet<Long>(); for (p in cells) has += key(p[0], p[1])
        return cells.map { (x, y) ->
            val n = has.contains(key(x, y - 1)); val e = has.contains(key(x + 1, y)); val s = has.contains(key(x, y + 1)); val w = has.contains(key(x - 1, y))
            val mask = (if (n) 1 else 0) or (if (e) 2 else 0) or (if (s) 4 else 0) or (if (w) 8 else 0)
            Piece(x, y, t.wallShapeByMask[mask], mask)
        }
    }
    private fun key(x: Int, y: Int): Long = (x.toLong() shl 32) xor (y.toLong() and 0xffffffffL)

    // ---- keep
    private fun keepArt(l: Int): IntArray = t.gameArt.getValue("keep/l$l")
    class KeepExtents(val left: Double, val right: Double, val up: Double, val down: Double, val w: Double, val h: Double)
    fun keepExtents(level: Int): KeepExtents {
        val l = plots.rule(level).level; val a = keepArt(l); val k = scaleOf("keep")
        val h = a[1]; val ax = a[2]; val x0 = a[3]; val y0 = a[4]; val x1 = a[5]; val y1 = a[6]
        return KeepExtents((ax - x0) * k, (x1 - ax) * k, (h - y0) * k, (h - y1) * k, (x1 - x0) * k, (y1 - y0) * k)
    }
    /** kFit per level, memoised: the live keep's scale is read per base per frame (no allocation there). */
    private val kFits = DoubleArray(plots.maxLevel + 1) { Double.NaN }
    fun kFit(level: Int): Double {
        val l = plots.rule(level).level
        val m = kFits[l]; if (!m.isNaN()) return m
        return kFitOf(level).also { kFits[l] = it }
    }
    private fun kFitOf(level: Int): Double {
        val g = plotGeometry(level); val e = keepExtents(level)
        val clear = if (g.citadel != null) t.keepFit.clearCitadel else t.keepFit.clearBelow9
        var k = Math.min(t.keepFit.maxScale, (clear / 2) / Math.max(e.left, e.right))
        if (g.citadel == null) k = Math.min(k, (k0 + kh - g.court[0]) / e.up)
        return k
    }
    fun keepScale(level: Int, d: Double): Double {
        val kf = kFit(level); val a = t.keepFit.fitFromD; val b = t.keepFit.trueAtD
        if (d <= a) return kf
        if (d >= b) return 1.0
        return JsMath.pow(kf, 1 - JsMath.log(d / a) / JsMath.log(b / a))
    }
    fun keepInkRect(level: Int, scale: Double = 1.0): InkBox {
        val e = keepExtents(level); val sy = (k0 + kh).toDouble()
        return InkBox(c - e.left * scale, sy - e.up * scale, c + e.right * scale, sy - e.down * scale)
    }

    // ---- sprites
    private fun runtimeOf(fam: String) = t.runtime[fam] ?: fam
    fun scaleOf(fam: String): Double = when (fam) {
        "cannon", "mortar" -> game.buildingSourceScale.getValue(fam) / art
        "heroaltar", "siegestool" -> t.layout.heroScale / art
        else -> game.sourceScale.getValue(runtimeOf(fam)) / art
    }
    fun footprintOf(fam: String): IntArray = game.footprints[runtimeOf(fam)] ?: throw IllegalStateException("decor: no footprint for $fam")
    fun decorCountCap(fam: String, l: Int): Int {
        if (fam == "mine") return game.maxMinesByKeep[l - 1]
        val arr = game.buildCaps[runtimeOf(fam)] ?: throw IllegalStateException("decor: no build cap for $fam")
        return arr[l - 1]
    }
    /** contracts.js `decorCap(key, level)`: min(the game's build cap, DECOR_CAP). */
    fun decorCap(key: String, level: Int): Int {
        val arr = game.buildCaps[t.buildKey[key] ?: key]
        val gameCap = if (arr != null) arr[Math.min(20, Math.max(1, level)) - 1].toDouble() else Double.POSITIVE_INFINITY
        return Math.min(gameCap, (t.decorCap[key] ?: 0).toDouble()).toInt()
    }
    private fun offsetXOf(fam: String): Double = (game.offsetGamePxX[runtimeOf(fam)] ?: 0.0) / art

    private fun gameSprite(fam: String, variant: String, fx: Int, fy: Int, role: String? = null): DecorSprite {
        val key = "$fam/$variant"; val a = t.gameArt[key] ?: throw IllegalStateException("decor: no art for $key")
        val fp = footprintOf(fam)
        return DecorSprite(key, "game", "building", role ?: fam, fam, fx, fy, intArrayOf(fp[0], fp[1]),
            fx + fp[0] / 2.0 + offsetXOf(fam), (fy + fp[1]).toDouble(), (fy + fp[1]).toDouble(), doubleArrayOf(a[2].toDouble(), a[1].toDouble()), scaleOf(fam),
            intArrayOf(a[0], a[1]), intArrayOf(a[3], a[4], a[5], a[6]), a[9], if (a[7] > 1) a[7] else 0, if (a[7] > 1) JsMath.round(1000.0 / a[8]).toInt() else 0, false, 0)
    }
    fun kitSprite(realm: String, id: String, fx: Int, fy: Int, kind: String, role: String?): DecorSprite {
        val a = t.kitArt[realm]?.get(id) ?: throw IllegalStateException("decor: $realm kit has no measured '$id'")
        val creature = id.startsWith("creature:")
        val fw = if (creature) 1 else a[6]; val fh = if (creature) 1 else a[7]
        return DecorSprite("kit:$id", if (creature) "creature" else "kit", kind, role, null, fx, fy, intArrayOf(fw, fh), fx + fw / 2.0, (fy + fh).toDouble(), (fy + fh).toDouble(),
            doubleArrayOf(a[0] / 2.0, a[1].toDouble()), 1 / art, intArrayOf(a[0], a[1]), intArrayOf(a[2], a[3], a[4], a[5]), 1,
            if (a[8] > 1 && !creature) a[8] else 0, if (a[8] > 1 && !creature) a[9] else 0, false, 0)
    }
    private fun wallSprite(tier: Int, x: Int, y: Int, piece: String, ring: String): DecorSprite {
        val h = t.wallCellH[tier - 1]
        // decor.js wallSprite: wall5 cells are 32 art px wide, anchored at the bottom centre (16, h)
        return DecorSprite("wall5/t$tier/$piece", "wall", "wall", ring, null, x, y, intArrayOf(1, 1), x + 0.5, (y + 1).toDouble(), (y + 1).toDouble(),
            doubleArrayOf(16.0, h.toDouble()), 1 / art, intArrayOf(32, h), intArrayOf(0, 0, 32, h), 1, 0, 0, false, 0)
    }
    fun inkRect(s: DecorSprite, scale: Double = 1.0): InkBox {
        val k = s.scale * scale; val ax = s.anchor[0]; val ay = s.anchor[1]
        return InkBox(s.tx + (s.ink[0] - ax) * k, s.ty + (s.ink[1] - ay) * k, s.tx + (s.ink[2] - ax) * k, s.ty + (s.ink[3] - ay) * k)
    }
    fun obeysSky(s: DecorSprite, level: Int): Boolean {
        val kr = keepInkRect(level); val khh = kr.y1 - kr.y0; val ka = khh * (kr.x1 - kr.x0); val r = inkRect(s); val h = r.y1 - r.y0; val area = h * (r.x1 - r.x0)
        if (s.kind == "flat") return true
        if (s.kind == "fence" || s.kind == "edge") return h - (s.fp[1] - 1) < khh - 1e-9
        if (s.kind == "pole") return h <= khh * t.layout.poleSky + 1e-9
        return h < khh - 1e-9 && area < ka
    }

    // ---- hashing
    fun hash2(a: Int, b: Int): Int = LifeHash.kitHash(a, b)
    private fun u01(a: Int, b: Int): Double = JsMath.u32(hash2(a, b)) / 4294967296.0
    private fun u01(a: Long, b: Int): Double = u01(a.toInt(), b)
    /** decor.js `seedOf` for a numeric id (JS `hash2(id | 0, 7331)`), as the uint32 value. */
    fun seedOf(id: Double): Long = JsMath.u32L(hash2(JsMath.toInt32(id), 7331))
    /** decor.js `seedOf` for a string id: FNV-1a over the first UTF-16 unit of each code point. */
    fun seedOf(id: String): Long {
        var h = 2166136261L.toInt()
        var i = 0
        while (i < id.length) { val cp = id.codePointAt(i); h = (h xor id[i].code) * 16777619; i += Character.charCount(cp) }
        return JsMath.u32L(hash2(h, 7331))
    }

    // ---------------------------------------------------------------- the composer

    private class Layout(val level: Int, val realmId: String, val formation: Int, val geometry: PlotGeometry, val claim: IntArray, val plot: IntArray,
                         val keep: DecorSprite, val walls: List<DecorWall>, val sprites: List<DecorSprite>, val emitters: List<DecorEmitter>, val omitted: List<String>)

    /**
     * decor.js `composeBaseDecor({ level, realmId, seed, gates })`. [seed] is the uint32 seed (`seedOf(id)`); [gates] the
     * sides a path to a neighbour leaves by (bases.js `paths.sides`).
     */
    fun compose(level: Int, realmId: String, seed: Long, gates: Collection<String>): BaseDecor {
        if (game.keepFootprint[0] != kw || game.keepFootprint[1] != kh) throw IllegalStateException("decor: keep footprint v2 needs the 8×8 citadel (plan §6.3)")
        // the dressing is the gate, not SHELL's REALMS_WITH_MAPS list (decor.js, stage B aff798ad)
        if (t.dressing[realmId] == null) throw IllegalStateException("decor: no kit dressing for realm '$realmId'")
        val l = plots.rule(level).level; val seedU = seed and 0xffffffffL; val formation = (seedU % 4).toInt()
        val ck = "$realmId|$l|$formation||"
        val base = cache[ck] ?: layout(l, realmId, formation).also { cache[ck] = it }
        val gateSet = LinkedHashSet<String>(); for (sd in gates) if (t.gateSides.contains(sd)) gateSet += sd
        val ring = RingLayout(l, realmId, seedU, base.geometry, gateSet).run()
        val all = base.sprites + ring.sprites
        val sprites = all.mapIndexed { i, s -> if (s.clip) s.copyWithPhase((JsMath.u32L(hash2(seedU.toInt(), i)) % s.clipFrames).toInt()) else s }
        val emitters = ArrayList(base.emitters)
        for (s in sprites) if (s.role == "brazier" || s.role == "campfire" || s.role == "light") {
            val r = inkRect(s)
            emitters += DecorEmitter("glow", null, (r.x0 + r.x1) / 2, r.y0 + 0.25, 0.0, 0.0, t.layout.glowR / art, t.layout.glowA * 0.8)
        }
        return BaseDecor(base.level, base.realmId, base.formation, base.geometry, base.claim, base.plot, base.keep, base.walls, sprites, emitters,
            base.omitted + ring.omitted, seedU, ring.edges, ring.ground, ring.lanes, ring.laneEnds, gateSet.toList(), ring.patches)
    }

    private fun layout(l: Int, realmId: String, formation: Int): Layout {
        val g = plotGeometry(l); val band = decorBand(l); val tier = g.wallTier
        val dress = t.dressing.getValue(realmId)
        val n = tiles; val grid = ByteArray(n * n)
        fun at(x: Int, y: Int): Int = grid[y * n + x].toInt()
        fun set(x: Int, y: Int, v: Int) { grid[y * n + x] = v.toByte() }
        for (y in g.p0 until g.p1) for (x in g.p0 until g.p1) {
            var z = Z_RING
            if (x == g.p0 || y == g.p0 || x == g.p1 - 1 || y == g.p1 - 1) z = Z_EDGE
            if (x >= g.a && x < g.b && y >= g.a && y < g.b) z = Z_SKIRT
            if (x > g.o0 && x < g.o1 && y > g.o0 && y < g.o1) z = Z_YARD
            fun onRing(a: Int, b: Int) = (x == a || x == b || y == a || y == b) && x >= a && x <= b && y >= a && y <= b
            if (onRing(g.o0, g.o1) || (g.doubled && onRing(g.o0 + 1, g.o1 - 1)) || (g.citadel != null && onRing(g.citadel[0], g.citadel[1]))) z = Z_WALL
            if (x >= g.court[0] && x < g.court[1] && y >= g.court[0] && y < g.court[1]) z = Z_COURT
            if (x >= k0 && x < k0 + kw && y >= k0 && y < k0 + kh) z = Z_KEEP
            else if (z != Z_COURT && isLane(g, x, y)) z = Z_LANE
            set(x, y, z)
        }
        val walls = ArrayList<DecorWall>()
        fun addRing(cells: List<IntArray>, ring: String) { for (p in resolvePieces(cells)) walls += DecorWall(tier, p.x, p.y, p.piece, ring) }
        fun notLane(p: IntArray) = at(p[0], p[1]) != Z_LANE
        if (g.wallRings >= 1) addRing(ringWalk(g.o0, g.o1).filter(::notLane), "outer")
        if (g.doubled) addRing(ringWalk(g.o0 + 1, g.o1 - 1).filter(::notLane), "inner")
        if (g.citadel != null) addRing(ringWalk(g.citadel[0], g.citadel[1]).filter(::notLane), "citadel")
        if (g.wallRings == 0) addRing(listOf(intArrayOf(k0 - 2, g.o1), intArrayOf(k0 - 1, g.o1), intArrayOf(k0 + kw, g.o1), intArrayOf(k0 + kw + 1, g.o1)), "stub")
        val wallCap = game.wallCap(l)
        if (walls.size > wallCap) throw IllegalStateException("decor L$l: ${walls.size} wall pieces exceed the keep cap $wallCap")

        val sprites = ArrayList<DecorSprite>(); val omitted = ArrayList<String>(); val emitters = ArrayList<DecorEmitter>()
        fun occupy(fx: Int, fy: Int, fw: Int, fh: Int) { for (y in fy until fy + fh) for (x in fx until fx + fw) set(x, y, Z_OCC) }
        fun fits(fx: Int, fy: Int, fw: Int, fh: Int, zones: IntArray): Boolean {
            if (fx < g.p0 || fy < g.p0 || fx + fw > g.p1 || fy + fh > g.p1) return false
            for (y in fy until fy + fh) for (x in fx until fx + fw) if (!zones.contains(at(x, y))) return false
            return true
        }
        fun find(fw: Int, fh: Int, ax: Double, ay: Double, zones: IntArray): IntArray? {
            var best: IntArray? = null; var bd = Double.POSITIVE_INFINITY
            var fy = g.p0
            while (fy + fh <= g.p1) {
                var fx = g.p0
                while (fx + fw <= g.p1) {
                    val dx = fx + fw / 2.0 - ax; val dy = fy + fh / 2.0 - ay; val d = dx * dx + dy * dy
                    if (d < bd && fits(fx, fy, fw, fh, zones)) { bd = d; best = intArrayOf(fx, fy) }
                    fx++
                }
                fy++
            }
            return best
        }
        fun tx(x: Double, y: Double): DoubleArray {
            var xx = x; var yy = y
            if (formation and 1 != 0) xx = 2.0 * c - xx
            if (formation and 2 != 0) { xx = 2.0 * c - xx; yy = 2.0 * c - yy }
            return doubleArrayOf(xx, yy)
        }
        fun placeBuilding(fam: String, variant: String, ax: Double, ay: Double, zones: IntArray): DecorSprite {
            val fp = footprintOf(fam); val xy = tx(ax, ay); val p = find(fp[0], fp[1], xy[0], xy[1], zones)
                ?: throw IllegalStateException("decor L$l $realmId f$formation: no room for $fam")
            val s = gameSprite(fam, variant, p[0], p[1])
            if (!obeysSky(s, l)) throw IllegalStateException("decor L$l: $fam/$variant breaks the keep's sky law")
            occupy(p[0], p[1], fp[0], fp[1]); sprites += s; return s
        }
        fun placeKit(role: String, ax: Double, ay: Double, zones: IntArray, pick: Int = 0, kind: String = "dressing", fixed: Boolean = false): DecorSprite? {
            val list = dress[role]?.list ?: emptyList()
            val m = pick % Math.max(1, list.size)
            val ids = list.subList(m, list.size) + list.subList(0, m)
            for (id in ids) {
                val probe = kitSprite(realmId, id, 0, 0, kindOfRole(role, kind), role)
                if (!obeysSky(probe, l)) continue
                val fw = probe.fp[0]; val fh = probe.fp[1]; val xy = if (fixed) doubleArrayOf(ax, ay) else tx(ax, ay)
                val p = if (fixed) (if (fits(Math.floor(xy[0]).toInt(), Math.floor(xy[1]).toInt(), fw, fh, zones)) intArrayOf(Math.floor(xy[0]).toInt(), Math.floor(xy[1]).toInt()) else null)
                    else find(fw, fh, xy[0], xy[1], zones)
                if (p == null) continue
                val s = kitSprite(realmId, id, p[0], p[1], probe.kind, role)
                occupy(p[0], p[1], fw, fh); sprites += s; return s
            }
            omitted += role; return null
        }

        // ---- fixtures (formation-invariant)
        val free = intArrayOf(Z_RING, Z_SKIRT, Z_YARD)
        val lc = k0 - 1; val rc = k0 + kw
        val cheeksOut = mapOf("S" to arrayOf(intArrayOf(lc, g.o1 + 1), intArrayOf(rc, g.o1 + 1)), "N" to arrayOf(intArrayOf(lc, g.o0 - 1), intArrayOf(rc, g.o0 - 1)),
            "W" to arrayOf(intArrayOf(g.o0 - 1, lc), intArrayOf(g.o0 - 1, rc)), "E" to arrayOf(intArrayOf(g.o1 + 1, lc), intArrayOf(g.o1 + 1, rc)))
        val cheeksIn = mapOf("S" to arrayOf(intArrayOf(lc, g.wInHi), intArrayOf(rc, g.wInHi)), "N" to arrayOf(intArrayOf(lc, g.wIn), intArrayOf(rc, g.wIn)),
            "W" to arrayOf(intArrayOf(g.wIn, lc), intArrayOf(g.wIn, rc)), "E" to arrayOf(intArrayOf(g.wInHi, lc), intArrayOf(g.wInHi, rc)))
        fun fixture(role: String, p: IntArray) = placeKit(role, p[0].toDouble(), p[1].toDouble(), free, 0, "dressing", true)
        fixture("banner", cheeksOut.getValue("S")[1])
        if (band >= 1 && l >= 3) fixture("banner", cheeksOut.getValue("S")[0])
        if (band >= 2) {
            for (side in arrayOf("N", "E", "W")) { fixture("banner", cheeksOut.getValue(side)[1]); fixture(if (band >= 5) "banner" else "light", cheeksOut.getValue(side)[0]) }
            for (cc in cheeksIn.getValue("S")) fixture("light", cc)
        }
        if (band >= 3) {
            val a = g.citadel!![0]; val b = g.citadel[1]
            for (cc in arrayOf(intArrayOf(a - 1, a - 1), intArrayOf(b + 1, a - 1), intArrayOf(a - 1, b + 1), intArrayOf(b + 1, b + 1))) fixture("brazier", cc)
            for (cc in arrayOf(intArrayOf(g.o0 - 1, g.o0 - 1), intArrayOf(g.o1 + 1, g.o0 - 1), intArrayOf(g.o0 - 1, g.o1 + 1), intArrayOf(g.o1 + 1, g.o1 + 1))) fixture("banner", cc)
        }
        if (band >= 5) {
            for (side in arrayOf("N", "E", "W")) for (cc in cheeksIn.getValue(side)) fixture("light", cc)
            for (cc in arrayOf(intArrayOf(g.wIn, g.wIn), intArrayOf(g.wInHi, g.wIn), intArrayOf(g.wIn, g.wInHi), intArrayOf(g.wInHi, g.wInHi))) fixture("brazier", cc)
        }
        if (band >= 4) {
            val topPx = t.wallCellH[tier - 1] - 12 // decor.js: the wall crest, 12 px below the cell top
            for (w in walls) if (w.ring == "outer" && w.piece.startsWith("end_")) {
                val s = DecorSprite("fx/fire", "fx", "fx", "torch", null, w.x, w.y, intArrayOf(0, 0), w.x + 0.5, w.y + 1 - topPx / art, w.y + 1 + 0.01,
                    doubleArrayOf(8.0, 24.0), 1 / art, t.fireCell.copyOf(), t.fireInk.copyOf(), 1, t.fireFrames, t.fireMs, false, 0)
                sprites += s
                emitters += DecorEmitter("glow", null, s.tx, s.ty - 0.4, 0.0, 0.0, t.layout.glowR / art, t.layout.glowA)
            }
        }

        // ---- buildings (slot-placed; formation moves them)
        val s0 = g.a + 1.0; val s1 = g.b - 1.0; val q = g.s / 4.0 + 1
        val m0 = (g.wIn + (g.citadel?.get(0) ?: g.court[0])) / 2.0
        val m1 = ((if (g.citadel != null) g.citadel[1] + 1 else g.court[1]) + g.wInHi + 1) / 2.0
        val tt = "t${towerTier(l)}"; val cc = c.toDouble()
        fun count(fam: String) = Math.min(decorCountCap(fam, l), decorCap(fam, l))
        val yard = intArrayOf(Z_YARD); val skirt = intArrayOf(Z_SKIRT)
        class Item(val fam: String, val v: String, val anchors: Array<DoubleArray>)
        fun a(x: Double, y: Double) = doubleArrayOf(x, y)
        val yardBig = arrayOf(
            Item("goldforge", "l$l", arrayOf(a(m0, cc + 2))), Item("heroaltar", "base", arrayOf(a(cc - 2, m0))), Item("siegestool", "base", arrayOf(a(cc + 2, m0))),
            Item("clanhall", tt, arrayOf(a(cc + 2, m1))), Item("mortar", tt, arrayOf(a(m1, m0), a(m0, m1))), Item("airdefence", tt, arrayOf(a(m1, cc - 2), a(m0, cc - 2))),
            Item("dragonnest", tt, arrayOf(a(m1, cc + 2))),
        )
        val yardSmall = arrayOf(
            Item("lasertower", tt, arrayOf(a(m1, m1), a(m0, m0))), Item("magetower", tt, arrayOf(a(cc - 2, m1), a(m1, m0))), Item("electrictower", tt, arrayOf(a(m0, m1), a(cc + 2, m0))),
            Item("archer", tt, arrayOf(a(m0, m0), a(m1, m0), a(m0, cc + 2), a(m1, cc - 2))), Item("cannon", tt, arrayOf(a(m1, m1), a(m0, m1), a(cc + 2, m1), a(cc - 2, m0))),
        )
        val skirtItems = arrayOf(
            Item("camp", tt, arrayOf(a(cc - q, s1), a(cc + q, s0))), Item("barracks", tt, arrayOf(a(cc + q, s1))), Item("vault", tt, arrayOf(a(s0, cc - q), a(s1, cc + q))),
            Item("mine", tt, arrayOf(a(s1, cc - q), a(s0, cc + q), a(s0, s0), a(s1, s1))), Item("alchemylab", tt, arrayOf(a(cc - q, s0))),
        )
        for (it in yardBig + yardSmall) { val nn = count(it.fam); for (i in 0 until nn) { val an = it.anchors[i % it.anchors.size]; placeBuilding(it.fam, it.v, an[0], an[1], yard) } }
        for (it in skirtItems) { val nn = count(it.fam); for (i in 0 until nn) { val an = it.anchors[i % it.anchors.size]; placeBuilding(it.fam, it.v, an[0], an[1], skirt) } }

        // ---- emitters: keep smoke, alchemy-lab chimney, keep pennants
        val kr = keepInkRect(l); val kwid = kr.x1 - kr.x0; val khgt = kr.y1 - kr.y0; val nSmoke = t.layout.smokeByBand[band]
        val smokeX = doubleArrayOf(-0.26, 0.26, 0.0)
        for (i in 0 until nSmoke) emitters += DecorEmitter("smoke", "keep", cc + smokeX[i] * kwid, kr.y0 + khgt * (if (i < 2) 0.42 else 0.1), 0.0, 0.0, null, null)
        for (s in sprites) if (s.fam == "alchemylab") { val r = inkRect(s); emitters += DecorEmitter("smoke", null, (r.x0 + r.x1) / 2 + 0.15, r.y0 + 0.1, 0.0, 0.0, null, null) }
        val tips = t.keepTips[l - 1]; val kk = scaleOf("keep"); val ka = keepArt(l); val kch = ka[1]; val kax = ka[2]
        val pick = if (l >= 9) tips.toList() else listOf(tips[0], tips[tips.size - 1])
        for (p in pick) emitters += DecorEmitter("pennant", "keep", cc + (p[0] - kax) * kk, k0 + kh + (p[1] - kch) * kk, 0.0, 0.0, null, null)

        val keep = DecorSprite("keep/l$l", "game", "keep", null, null, k0, k0, intArrayOf(kw, kh), cc, (k0 + kh).toDouble(), (k0 + kh).toDouble(),
            doubleArrayOf(ka[2].toDouble(), ka[1].toDouble()), scaleOf("keep"), intArrayOf(ka[0], ka[1]), intArrayOf(ka[3], ka[4], ka[5], ka[6]), 1, 3, 83, false, 0)
        return Layout(l, realmId, formation, g, intArrayOf(g.a, g.a, g.b, g.b, g.s), intArrayOf(g.p0, g.p0, g.p1, g.p1, g.ring), keep, walls, sprites, emitters, omitted)
    }

    private fun kindOfRole(role: String, fallback: String) = if (t.poleRoles.contains(role)) "pole" else fallback
    fun isFlatCrop(id: String) = t.flatCrops.contains(id) || id.startsWith("crop_")
    fun mainGate(seed: Long): String { val u = u01(seed.toInt(), 0x6a7e); return if (u < 0.4) "S" else if (u < 0.6) "N" else if (u < 0.8) "W" else "E" }
    fun fieldCount(l: Int, seed: Long): Int {
        val lo: Int; val hi: Int
        if (l <= 1) { lo = 1; hi = 2 } else if (l <= 5) { lo = 1; hi = 3 } else if (l <= 11) { lo = 2; hi = 3 } else if (l <= 16) { lo = 2; hi = 4 } else { lo = 3; hi = 4 }
        return lo + Math.min(hi - lo, Math.floor(u01(seed.toInt(), 0xf1e1d) * (hi - lo + 1)).toInt())
    }
    fun ringWants(l: Int, seed: Long): List<String> {
        val want = arrayListOf("camp", "field"); val nF = fieldCount(l, seed)
        if (l >= t.layout.penFrom) want += "pen"
        if (l >= t.layout.orchardFrom) want += "orchard"
        for (i in 1 until nF) want += "field"
        if (l >= t.layout.farmFrom) want += "yard"
        if (l >= t.layout.orchard2From) want += "orchard"
        return want
    }

    class Slot(val id: String, val side: String, val alongX: Boolean, val x0: Int, val x1: Int, val y0: Int, val y1: Int)
    class Lane(val ring: List<IntArray>, val claim: List<IntArray>, val end: Int)

    /** decor.js `laneCells` (lanes run straight on the keep's columns; laneMeander is identically 0 at the pin). */
    private fun laneCells(g: PlotGeometry, side: String): Lane {
        val ring = ArrayList<IntArray>(); val claim = ArrayList<IntArray>(); val ns = side == "N" || side == "S"
        for (tt in 0 until g.ring) {
            val sh = 0; val o = if (side == "N" || side == "W") g.a - 1 - tt else g.b + tt
            for (v in lanesX) ring += if (ns) intArrayOf(v + sh, o) else intArrayOf(o, v + sh)
        }
        val top = g.citadel?.get(0) ?: g.court[0]; val bot = if (g.citadel != null) g.citadel[1] + 1 else g.court[1]
        for (v in lanesX) {
            if (side == "N") for (y in g.a until top) claim += intArrayOf(v, y)
            if (side == "S") for (y in bot until g.b) claim += intArrayOf(v, y)
            if (side == "W") for (x in g.a until top) claim += intArrayOf(x, v)
            if (side == "E") for (x in bot until g.b) claim += intArrayOf(x, v)
        }
        return Lane(ring, claim, 0)
    }

    fun ringSlots(g: PlotGeometry, gates: Set<String>, laneOf: Map<String, Lane>, seed: Long): List<Slot> {
        class Band(val side: String, val alongX: Boolean, val a0: Int, val a1: Int, val c0: Int, val c1: Int)
        val bands = arrayOf(
            Band("N", true, g.p0, g.p1 - 1, g.p0, g.a - 1), Band("S", true, g.p0, g.p1 - 1, g.b, g.p1 - 1),
            Band("W", false, g.a + 1, g.b - 2, g.p0, g.a - 1), Band("E", false, g.a + 1, g.b - 2, g.b, g.p1 - 1),
        )
        val slots = ArrayList<Slot>()
        for (b in bands) {
            var parts = listOf(intArrayOf(b.a0, b.a1))
            if (gates.contains(b.side)) {
                val across = laneOf.getValue(b.side).ring.map { if (b.alongX) it[0] else it[1] }
                parts = listOf(intArrayOf(b.a0, across.min() - 2), intArrayOf(across.max() + 2, b.a1))
            }
            for ((pi, pp) in parts.withIndex()) {
                val p0 = pp[0]; val p1 = pp[1]
                val len = p1 - p0 + 1; val h = hash2(seed.toInt(), 5000 + t.gateSides.indexOf(b.side) * 7 + pi)
                if (len < 3) continue
                val n = if (len >= 30) 2 + (if (u01(h, 1) < 0.35) 1 else 0) else if (len >= 15) 1 + (if (u01(h, 1) < 0.6) 1 else 0) else 1
                var s0 = p0; var i = 0
                while (i < n && p1 - s0 + 1 >= 4) {
                    val remain = p1 - s0 + 1
                    val want = if (i == n - 1) remain.toDouble() else JsMath.round((remain.toDouble() / (n - i)) * (0.7 + 0.6 * u01(h, 10 + i)))
                    val s1 = Math.min(p1.toDouble(), s0 + Math.max(4.0, want) - 1).toInt()
                    slots += if (b.alongX) Slot("${b.side}$pi$i", b.side, true, s0, s1, b.c0, b.c1) else Slot("${b.side}$pi$i", b.side, false, b.c0, b.c1, s0, s1)
                    s0 = s1 + 2 + (JsMath.u32L(hash2(h, 20 + i)) % 2).toInt()
                    i++
                }
            }
        }
        return slots
    }

    /** decor.js `patchCells`: an organic patch in a slot (never a notched rectangle); sorted tile keys (y · TILES + x). */
    fun patchCells(slot: Slot, h: Int, free: (Int, Int) -> Boolean, fill: Double = 1.0, maxLen: Double = Double.POSITIVE_INFINITY, convex: Boolean = false): List<Int> {
        val ax = slot.alongX; val n = tiles
        var a0 = if (ax) slot.x0 else slot.y0; var a1 = if (ax) slot.x1 else slot.y1
        val c0 = if (ax) slot.y0 else slot.x0; val c1 = if (ax) slot.y1 else slot.x1; val wid = c1 - c0 + 1
        if (a1 - a0 + 1 > maxLen) { val st = a0 + Math.floor(u01(h, 29) * (a1 - a0 + 2 - maxLen)).toInt(); a0 = st; a1 = (st + maxLen - 1).toInt() }
        val len = a1 - a0 + 1
        if (len < 3 || wid < 2) return emptyList()
        val blobs = ArrayList<DoubleArray>()
        if (convex) blobs += doubleArrayOf(a0 + len / 2.0 + (u01(h, 30) - 0.5) * len * 0.1, c0 + wid / 2.0, Math.max(1.5, (len / 2.0) * fill), Math.max(1.3, (wid / 2.0) * fill),
            u01(h, 70) * 6.2832, 0.07, 2.3)
        else {
            val nb = if (len >= 18) 3 else if (len >= 9) 2 else 1
            for (i in 0 until nb) blobs += doubleArrayOf(a0 + ((i + 0.5) * len) / nb + (u01(h, 30 + i) - 0.5) * (len.toDouble() / nb) * 0.5, c0 + wid / 2.0 + (u01(h, 40 + i) - 0.5) * wid * 0.35,
                Math.max(1.3, (len.toDouble() / nb / 2) * (0.9 + 0.45 * u01(h, 50 + i)) * fill), Math.max(1.1, (wid / 2.0) * (0.62 + 0.38 * u01(h, 60 + i)) * fill), u01(h, 70 + i) * 6.2832, 0.16, 2.0)
        }
        val set = LinkedHashSet<Int>()
        for (a in a0..a1) for (cy in c0..c1) {
            val x = if (ax) a else cy; val y = if (ax) cy else a
            if (!free(x, y)) continue
            for (bl in blobs) {
                val da = (a + 0.5 - bl[0]) / bl[2]; val dc = (cy + 0.5 - bl[1]) / bl[3]; val th = JsMath.atan2(dc, da)
                if (JsMath.pow(Math.abs(da), bl[6]) + JsMath.pow(Math.abs(dc), bl[6]) < 1 + bl[5] * JsMath.sin(3 * th + bl[4])) { set += y * n + x; break }
            }
        }
        fun boxOf(st: Collection<Int>): IntArray {
            var x0 = Int.MAX_VALUE; var x1 = Int.MIN_VALUE; var y0 = Int.MAX_VALUE; var y1 = Int.MIN_VALUE
            for (k in st) { val x = k % n; val y = k / n; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
            return intArrayOf(x0, x1, y0, y1)
        }
        if (!convex && set.size > 6) {
            val bb = boxOf(set)
            val cs = arrayListOf(intArrayOf(bb[0], bb[2]), intArrayOf(bb[1] + 1, bb[2]), intArrayOf(bb[0], bb[3] + 1), intArrayOf(bb[1] + 1, bb[3] + 1))
            cs.sortWith { p, qq -> java.lang.Long.signum(JsMath.u32L(hash2(h, p[0] * 131 + p[1])) - JsMath.u32L(hash2(h, qq[0] * 131 + qq[1]))) }
            var r = 1.6; var i = 0
            while (set.size > 6 && r < 6) {
                val b2 = boxOf(set); if (set.size <= (b2[1] - b2[0] + 1) * (b2[3] - b2[2] + 1) * 0.84) break
                val qx = cs[i][0]; val qy = cs[i][1]
                for (k in ArrayList(set)) if (JsMath.hypot((k % n) + 0.5 - qx, (k / n) + 0.5 - qy) < r) set.remove(k)
                i = (i + 1) % 4; r += if (i == 0) 0.6 else 0.0
            }
        }
        val core = HashSet<Int>(); for (k in set) if (set.contains(k - 1) && set.contains(k + 1) && set.contains(k - n) && set.contains(k + n)) core += k
        val opened = LinkedHashSet<Int>(); for (k in set) if (core.contains(k) || core.contains(k - 1) || core.contains(k + 1) || core.contains(k - n) || core.contains(k + n)) opened += k
        var best: MutableList<Int> = ArrayList()
        val seen = HashSet<Int>()
        for (k in opened.sorted()) {
            if (seen.contains(k)) continue
            val comp = ArrayList<Int>(); val st = ArrayList<Int>(); st += k; seen += k
            while (st.isNotEmpty()) {
                val cc = st.removeAt(st.size - 1); comp += cc
                for (m in intArrayOf(cc - 1, cc + 1, cc - n, cc + n)) if (opened.contains(m) && !seen.contains(m) && Math.abs((m % n) - (cc % n)) <= 1) { seen += m; st += m }
            }
            if (comp.size > best.size) best = comp
        }
        if (best.isNotEmpty()) {
            val bb = boxOf(best); val corner = hashSetOf(bb[2] * n + bb[0], bb[2] * n + bb[1], bb[3] * n + bb[0], bb[3] * n + bb[1])
            best = best.filter { !corner.contains(it) }.toMutableList()
        }
        return best.sorted()
    }

    private fun slotScore(use: String, slot: Slot, main: String, h: Int): Double {
        val area = ((slot.x1 - slot.x0 + 1) * (slot.y1 - slot.y0 + 1)).toDouble(); val j = u01(h, 1)
        return when (use) {
            "camp" -> (if (slot.side == main) 2 else 1) * (0.6 + 0.8 * j) / (1 + Math.abs(area - 40) / 40)
            "pen" -> if (area >= 20) Math.min(area, 60.0) * (0.5 + j) else -1.0
            "yard" -> if (area >= 12) Math.min(area, 50.0) * (0.5 + j) else -1.0
            "orchard" -> if (area >= 12) area * (0.4 + j) else -1.0
            else -> if (area >= 10) area * (0.45 + j) else -1.0
        }
    }

    /** decor.js `ringLayout`: the tended ring between the claim and the plot edge, laid out per BASE (the whole seed). */
    private inner class RingLayout(val l: Int, val realmId: String, val seed: Long, val g: PlotGeometry, val gates: Set<String>) {
        val n = tiles; val occ = ByteArray(n * n); val band = decorBand(l)
        val dress = t.dressing.getValue(realmId)
        val laneOf = LinkedHashMap<String, Lane>(); val road = ByteArray(n * n)
        val sprites = ArrayList<DecorSprite>(); val edges = ArrayList<DecorEdge>(); val ground = ArrayList<DecorGround>(); val patches = ArrayList<DecorPatch>(); val omitted = ArrayList<String>()
        val lanes = LinkedHashMap<String, List<IntArray>>(); val laneEnds = LinkedHashMap<String, Int>()
        val seedI = seed.toInt()
        var nField = 0
        lateinit var cropOrder: List<String>
        lateinit var laneTiles: List<IntArray>

        fun inClaim(x: Int, y: Int) = x >= g.a && x < g.b && y >= g.a && y < g.b
        fun inPlot(x: Int, y: Int) = x >= g.p0 && y >= g.p0 && x < g.p1 && y < g.p1
        fun corridor(x: Int, y: Int) = road[y * n + x].toInt() == 1
        val free: (Int, Int) -> Boolean = { x, y -> inPlot(x, y) && !inClaim(x, y) && !corridor(x, y) && occ[y * n + x].toInt() == 0 }
        fun fits(fx: Int, fy: Int, fw: Int, fh: Int, allow: (Int, Int) -> Boolean = free): Boolean {
            for (y in fy until fy + fh) for (x in fx until fx + fw) if (!allow(x, y)) return false
            return true
        }
        fun take(fx: Int, fy: Int, fw: Int, fh: Int) { for (y in fy until fy + fh) for (x in fx until fx + fw) occ[y * n + x] = 1 }
        fun sky(s: DecorSprite) = t.decals.contains(s.key.substring(4)) || obeysSky(s, l)
        fun kindOf(id: String, role: String) = if (t.decals.contains(id) || isFlatCrop(id)) "flat" else kindOfRole(role, "dressing")
        fun put(id: String, fx: Int, fy: Int, role: String, jx: Double = 0.0, jy: Double = 0.0, kind: String? = null): DecorSprite {
            val s = kitSprite(realmId, id, fx, fy, kind ?: kindOf(id, role), role)
            if (jx != 0.0 || jy != 0.0) { s.tx += jx; s.ty += jy; s.z = s.ty }
            take(fx, fy, s.fp[0], s.fp[1]); sprites += s; return s
        }
        fun probe(id: String, role: String) = kitSprite(realmId, id, 0, 0, kindOf(id, role), role)
        fun placeNear(role: String, ax: Double, ay: Double, allow: (Int, Int) -> Boolean, pick: Long = 0, jx: Double = 0.0, jy: Double = 0.0, again: Boolean = true): DecorSprite? {
            val list = dress[role]?.list ?: emptyList(); val nn = list.size
            for (j in 0 until nn) {
                val id = list[((pick + j) % nn).toInt()]; val pr = probe(id, role)
                if (!sky(pr)) continue
                val fw = pr.fp[0]; val fh = pr.fp[1]
                var best: IntArray? = null; var bd = Double.POSITIVE_INFINITY
                var fy = g.p0
                while (fy + fh <= g.p1) {
                    var fx = g.p0
                    while (fx + fw <= g.p1) {
                        val dx = fx + fw / 2.0 - ax; val dy = fy + fh / 2.0 - ay; val d = dx * dx + dy * dy
                        if (d < bd && fits(fx, fy, fw, fh, allow)) { bd = d; best = intArrayOf(fx, fy) }
                        fx++
                    }
                    fy++
                }
                if (best != null) return put(id, best[0], best[1], role, jx, jy)
            }
            if (again && allow !== free) return placeNear(role, ax, ay, free, pick, jx, jy, false)
            omitted += role; return null
        }
        fun inSet(set: Set<Int>): (Int, Int) -> Boolean = { x, y -> set.contains(y * n + x) && free(x, y) }
        fun outlineOf(cells: List<Int>, set: Set<Int>): List<Int> {
            val out = LinkedHashSet<Int>()
            for (k in cells) {
                val x = k % n; val y = k / n; var edge = false
                loop@ for (dy in -1..1) for (dx in -1..1) if ((dx != 0 || dy != 0) && !set.contains((y + dy) * n + x + dx)) { edge = true; break@loop }
                if (edge) out += k
            }
            var changed = true
            while (changed) {
                changed = false
                for (k in ArrayList(out)) {
                    var cnt = 0; for (m in intArrayOf(k - 1, k + 1, k - n, k + n)) if (out.contains(m)) cnt++
                    if (cnt < 2) { out.remove(k); changed = true }
                }
            }
            return out.sorted()
        }
        fun fenceable(cells0: List<Int>): List<Int>? {
            var cells = cells0
            var it = 0
            while (it < 8 && cells.size >= 8) {
                val set = HashSet(cells); val on = HashSet(outlineOf(cells, set))
                val drop = cells.filter { k ->
                    if (on.contains(k)) { var cnt = 0; for (m in intArrayOf(k - 1, k + 1, k - n, k + n)) if (on.contains(m)) cnt++; cnt != 2 }
                    else intArrayOf(-n - 1, -n, -n + 1, -1, 1, n - 1, n, n + 1).any { o -> !set.contains(k + o) }
                }
                if (drop.isEmpty()) return cells
                val dropS = HashSet(drop); val rest = LinkedHashSet<Int>(); for (k in cells) if (!dropS.contains(k)) rest += k
                val seen = HashSet<Int>(); var best: List<Int> = ArrayList()
                for (k in rest.sorted()) {
                    if (seen.contains(k)) continue
                    val comp = ArrayList<Int>(); val st = ArrayList<Int>(); st += k; seen += k
                    while (st.isNotEmpty()) {
                        val cc = st.removeAt(st.size - 1); comp += cc
                        for (m in intArrayOf(cc - 1, cc + 1, cc - n, cc + n)) if (rest.contains(m) && !seen.contains(m)) { seen += m; st += m }
                    }
                    if (comp.size > best.size) best = comp
                }
                cells = best.sorted()
                it++
            }
            return null
        }
        fun addLoop(loop: List<Int>, gateTo: DoubleArray, style: String, id: Int) {
            val on = HashSet(loop)
            var gi = -1; var gd = Double.POSITIVE_INFINITY
            for ((i, k) in loop.withIndex()) {
                val ew = on.contains(k - 1) && on.contains(k + 1) && !on.contains(k - n) && !on.contains(k + n)
                val ns = on.contains(k - n) && on.contains(k + n) && !on.contains(k - 1) && !on.contains(k + 1)
                if (!ew && !ns) continue
                val dx = (k % n) + 0.5 - gateTo[0]; val dy = (k / n) + 0.5 - gateTo[1]; val d = dx * dx + dy * dy
                if (d < gd) { gd = d; gi = i }
            }
            val cells = ArrayList<IntArray>(); for ((i, k) in loop.withIndex()) if (i != gi) cells += intArrayOf(k % n, k / n)
            for (p in resolvePieces(cells)) { edges += DecorEdge(style, p.x, p.y, p.piece, p.mask, id); occ[p.y * n + p.x] = 1 }
        }
        fun gateTarget(cells: List<Int>): DoubleArray {
            var sx = 0.0; var sy = 0.0; for (k in cells) { sx += k % n; sy += k / n }
            val cx = sx / cells.size + 0.5; val cy = sy / cells.size + 0.5
            var best: DoubleArray? = null; var bd = 144.0
            for (p in laneTiles) { val dx = p[0] + 0.5 - cx; val dy = p[1] + 0.5 - cy; val d = dx * dx + dy * dy; if (d < bd) { bd = d; best = doubleArrayOf(p[0] + 0.5, p[1] + 0.5) } }
            return best ?: doubleArrayOf(Math.min(Math.max(cx, g.a.toDouble()), g.b.toDouble()), Math.min(Math.max(cy, g.a.toDouble()), g.b.toDouble()))
        }
        fun centroid(cells: List<Int>): DoubleArray { var sx = 0.0; var sy = 0.0; for (k in cells) { sx += k % n; sy += k / n }; return doubleArrayOf(sx / cells.size + 0.5, sy / cells.size + 0.5) }
        fun boxFill(cells: List<Int>): Double {
            var x0 = Int.MAX_VALUE; var x1 = Int.MIN_VALUE; var y0 = Int.MAX_VALUE; var y1 = Int.MIN_VALUE
            for (k in cells) { x0 = Math.min(x0, k % n); x1 = Math.max(x1, k % n); y0 = Math.min(y0, k / n); y1 = Math.max(y1, k / n) }
            return cells.size.toDouble() / ((x1 - x0 + 1) * (y1 - y0 + 1))
        }

        fun run(): RingLayout {
            for (side in t.gateSides) if (gates.contains(side)) {
                val ln = laneCells(g, side); laneOf[side] = ln; val ns = side == "N" || side == "S"
                for (p in ln.ring) for (d in intArrayOf(-1, 0, 1)) road[(if (ns) p[1] else p[1] + d) * n + (if (ns) p[0] + d else p[0])] = 1
            }
            laneTiles = laneOf.values.flatMap { it.ring }
            val main = mainGate(seed); val slots = ringSlots(g, gates, laneOf, seed)
            val uses = HashMap<String, String>(); val plan = ArrayList<Slot>()
            cropOrder = (dress["crops"]?.list ?: emptyList()).mapIndexed { i, id -> JsMath.u32L(hash2(seedI, 700 + i)) to id }.sortedWith { a, b -> java.lang.Long.signum(a.first - b.first) }.map { it.second }
            for ((wi, use) in ringWants(l, seed).withIndex()) {
                val cands = slots.filter { !uses.containsKey(it.id) }.map { sl -> slotScore(use, sl, main, hash2(seedI, 900 + wi * 37 + slots.indexOf(sl))) to sl }
                    .filter { it.first > 0 }.sortedWith { a, b -> java.lang.Double.compare(b.first, a.first).let { r -> if (b.first - a.first == 0.0) 0 else r } }
                var done = false
                for ((_, sl) in cands) if (tryPatch(sl, use, hash2(seedI, 1000 + slots.indexOf(sl) + wi * 53))) { uses[sl.id] = use; plan += sl; done = true; break }
                if (!done) omitted += use
            }
            val farmed = ByteArray(n * n)
            for (sl in plan) if (uses[sl.id] != "wild") for (y in sl.y0..sl.y1) for (x in sl.x0..sl.x1) farmed[y * n + x] = 1
            for (y in g.p0 until g.p1) for (x in g.p0 until g.p1) {
                if (!free(x, y)) continue
                val dist = maxOf(g.a - 1 - x, x - g.b, g.a - 1 - y, y - g.b)
                val o = Math.max(0.0, Math.min(1.0, (dist - 1).toDouble() / Math.max(1, g.ring - 2)))
                val wild = farmed[y * n + x].toInt() == 0; val h = hash2(seedI xor 0x9e3779b9.toInt(), y * n + x)
                val dens = t.layout.wildBase + t.layout.wildEdge * o + (if (wild) t.layout.wildSegment else 0.0)
                if (u01(h, 1) >= dens) continue
                val r = u01(h, 2)
                val role = if (o >= 0.5 && r < (if (wild) 0.42 else 0.28)) "wildTree" else if (r < 0.6) "wildRock" else "wildSmall"
                val list = dress[role]?.list ?: emptyList()
                if (list.isEmpty()) continue
                val id = list[(JsMath.u32L(hash2(h, 3)) % list.size).toInt()]; val pr = probe(id, role)
                if (!fits(x, y, pr.fp[0], pr.fp[1])) continue
                if (role != "wildTree" && !sky(pr)) continue
                put(id, x, y, role, (u01(h, 4) - 0.5) * 0.5, (u01(h, 5) - 0.5) * 0.3, if (role == "wildTree") "tree" else null)
            }
            for ((side, ln) in laneOf) { lanes[side] = ln.ring + ln.claim; laneEnds[side] = ln.end }
            return this
        }

        fun tryPatch(seg: Slot, use: String, h: Int): Boolean {
            val pid = patches.size
            when (use) {
                "field" -> {
                    var hedged = l >= t.layout.hedgeFrom && (l >= t.layout.hedgeAllFrom || u01(h, 8) < 0.6)
                    var cells = patchCells(seg, h, free, if (hedged) 0.98 else 0.95 + 0.12 * u01(h, 7), Double.POSITIVE_INFINITY, hedged)
                    if (hedged && cells.size < 20) { if (l >= t.layout.hedgeAllFrom) return false; hedged = false; cells = patchCells(seg, h, free, 0.95 + 0.12 * u01(h, 7)) }
                    if (cells.size < 8 || boxFill(cells) > 0.88) return false
                    if (hedged) { val fc = fenceable(cells); if (fc != null && fc.size >= 16 && boxFill(fc) <= 0.9) cells = fc else if (l >= t.layout.hedgeAllFrom) return false else hedged = false }
                    val set = HashSet(cells)
                    val crop = if (cropOrder.isEmpty()) null else cropOrder[nField % Math.max(1, cropOrder.size)]
                    val tint = (JsMath.u32L(hash2(h, 9)) % 4).toInt()
                    for (k in cells) ground += DecorGround(k % n, k / n, 0, tint, pid)
                    if (hedged) addLoop(outlineOf(cells, set), gateTarget(cells), "hedge", pid)
                    patches += DecorPatch("field", seg.id, cells.size, crop, hedged)
                    val inside = inSet(set)
                    if (l >= t.layout.fieldPropFrom && u01(h, 10) < 0.6) {
                        var sx = 0.0; var sy = 0.0; for (k in cells) { sx += k % n; sy += k / n }
                        val cx = sx / cells.size; val cy = sy / cells.size
                        placeNear("fieldProp", cx + (u01(h, 11) - 0.5) * 3, cy, inside, JsMath.u32L(hash2(h, 12)) % 3)
                    }
                    if (crop != null) plantField(cells, inside, crop, h)
                    nField++
                }
                "pen" -> {
                    val cells = fenceable(patchCells(seg, h, free, 1.02, 13.0, true)) ?: emptyList(); val set = HashSet(cells)
                    if (cells.size < 12) return false
                    for (k in cells) ground += DecorGround(k % n, k / n, 1, 0, pid)
                    addLoop(outlineOf(cells, set), gateTarget(cells), "pen", pid)
                    patches += DecorPatch("pen", seg.id, cells.size, null, null)
                    val inside = inSet(set); val beasts = dress["livestock"]?.list ?: emptyList(); val nb = if (l >= 14) 4 else if (l >= 10) 3 else 2
                    if (l >= 8) { val cxy = centroid(cells); placeNear("farm", cxy[0], cxy[1] - 1, inside, 1) }
                    val spots = cells.filter { inside(it % n, it / n) }.sortedWith { a, b -> java.lang.Long.signum(JsMath.u32L(hash2(h, a)) - JsMath.u32L(hash2(h, b))) }
                    var i = 0; var nn = 0
                    while (i < spots.size && nn < nb) {
                        val x = spots[i] % n; val y = spots[i] / n
                        if (free(x, y) && beasts.isNotEmpty()) { put(beasts[nn % beasts.size], x, y, "livestock", (u01(h, 40 + i) - 0.5) * 0.4, (u01(h, 60 + i) - 0.5) * 0.2, "creature"); nn++ }
                        i++
                    }
                }
                "orchard" -> {
                    val cells = patchCells(seg, h, free, 1.05, 16.0)
                    if (cells.size < 4) return false
                    patches += DecorPatch("orchard", seg.id, cells.size, null, null)
                    val trees = HashSet<Int>(); val list = dress["orchard"]?.list ?: emptyList()
                    for (k in cells.sortedWith { a, b -> java.lang.Long.signum(JsMath.u32L(hash2(h, a)) - JsMath.u32L(hash2(h, b))) }) {
                        val x = k % n; val y = k / n
                        var near = false; for (dy in -1..1) for (dx in -1..1) if (trees.contains((y + dy) * n + x + dx)) near = true
                        if (near || !free(x, y) || u01(h, k) > 0.8) continue
                        for (j in list.indices) {
                            val id = list[((JsMath.u32L(hash2(h, k + 7)) + j) % list.size).toInt()]; val pr = probe(id, "orchard")
                            if (!sky(pr)) continue
                            put(id, x, y, "orchard", (u01(h, k + 3) - 0.5) * 0.4, (u01(h, k + 5) - 0.5) * 0.3); trees += k; break
                        }
                    }
                    if (trees.isEmpty()) omitted += "orchard"
                }
                "camp", "yard" -> {
                    val cells = patchCells(seg, h, free, 1.05, if (use == "camp") 10.0 else 11.0); val set = HashSet(cells)
                    if (cells.isEmpty()) return false
                    for (k in cells) ground += DecorGround(k % n, k / n, 1, 1, pid)
                    patches += DecorPatch(use, seg.id, cells.size, null, null)
                    val inside = inSet(set); val cxy = centroid(cells); val cx = cxy[0]; val cy = cxy[1]
                    fun j(a: Int, b: Double) = (u01(h, a) - 0.5) * b
                    if (use == "camp") {
                        placeNear("campfire", cx + j(20, 1.0), cy + j(21, 1.0), inside)
                        if (l >= t.layout.tentFrom) placeNear("tent", cx - 1.5 + j(22, 1.0), cy - 1.5, inside)
                        placeNear("hay", cx + 1.5, cy - 1 + j(23, 1.0), inside, JsMath.u32L(hash2(h, 24)))
                        if (l >= t.layout.wellFrom) placeNear("well", cx + 1.5, cy + 1.5, inside)
                        if (l >= t.layout.hiveFrom) placeNear("hive", cx - 2, cy + 1.5, inside)
                        for (i in 0 until 1 + (band shr 1)) placeNear("clutter", cx + j(30 + i, 5.0), cy + j(40 + i, 4.0), inside, JsMath.u32L(hash2(h, 50 + i)))
                    } else {
                        placeNear("farm", cx, cy, inside)
                        if (l >= t.layout.farm2From) placeNear("farm", cx + 2.5, cy + 1.5, inside, 1)
                        for (i in 0 until 2 + (band shr 1)) placeNear(if (i % 2 != 0) "hay" else "clutter", cx + j(30 + i, 5.0), cy + j(40 + i, 4.0), inside, JsMath.u32L(hash2(h, 50 + i)))
                    }
                }
            }
            return true
        }

        fun plantField(cells: List<Int>, inside: (Int, Int) -> Boolean, crop: String, h: Int) {
            val flat = isFlatCrop(crop); val fp0 = probe(crop, "crops").fp; val fw = fp0[0]; val fh = fp0[1]; val flip = u01(h, 13) < 0.5
            var x0 = Int.MAX_VALUE; var y0 = Int.MAX_VALUE; for (k in cells) { x0 = Math.min(x0, k % n); y0 = Math.min(y0, k / n) }
            val order = cells.sortedWith { a, b -> val d = a / n - b / n; if (d != 0) d else (if (flip) b - a else a - b) }
            var planted = 0
            for (k in order) {
                val x = k % n; val y = k / n
                if (!flat && ((y - y0) % 2 != 0 || (x - x0) % (fw + 1) != 0)) continue
                if (!fits(x, y, fw, fh, inside)) continue
                if (planted != 0 && u01(h, k + 311) < t.layout.fallow) { take(x, y, fw, fh); continue }
                val alt = t.layout.cropPairs[crop]
                val altOk = alt != null && t.kitArt[realmId]?.get(alt) != null && u01(h, k) < 0.3 && probe(alt, "crops").fp.let { fits(x, y, it[0], it[1], inside) }
                val id = if (altOk) alt!! else crop
                val s = probe(id, "crops")
                if (!flat && !sky(s)) continue
                if (flat) put(id, x, y, "crops") else put(id, x, y, "crops", (u01(h, k + 523) - 0.5) * 0.4, (u01(h, k + 524) - 0.5) * 0.24)
                planted++
            }
            val fill = dress["fieldFill"]?.list ?: emptyList()
            for (k in order) {
                val x = k % n; val y = k / n
                if (!inside(x, y) || u01(h, k + 99) > 0.3 || fill.isEmpty()) continue
                val id = fill[(JsMath.u32L(hash2(h, k)) % fill.size).toInt()]; val pr = probe(id, "fieldFill")
                if (pr.fp[0] == 1 && pr.fp[1] == 1 && sky(pr)) put(id, x, y, "fieldFill", (u01(h, k + 7) - 0.5) * 0.3)
            }
            if (planted == 0) omitted += "crops"
        }
    }

    // ---------------------------------------------------------------- sprite lists of a decor

    /** decor.js `edgeSprites`: hedges/fences from the kit's own pieces (the fallback without a 16-piece autotile). */
    fun edgeSprites(d: BaseDecor): List<DecorSprite> {
        val realm = d.realmId; val out = ArrayList<DecorSprite>()
        val loops = LinkedHashMap<Int, MutableList<DecorEdge>>()
        for (e in d.edges) loops.getOrPut(e.loop) { ArrayList() }.add(e)
        for (list in loops.values) {
            val style = t.dressing.getValue(realm).getValue(if (list[0].style == "pen") "pen" else "edge").pieces!!
            val on = HashSet<Long>(); for (e in list) on += key(e.x, e.y)
            val used = HashSet<Long>()
            fun free(x: Int, y: Int) = on.contains(key(x, y)) && !used.contains(key(x, y))
            for (e in list.sortedWith { a, b -> if (a.y != b.y) a.y - b.y else a.x - b.x }) {
                val x = e.x; val y = e.y; if (!free(x, y)) continue
                val ew = style["ew"]; val ns = style["ns"]; val post = style["post"]
                if (ew != null && (e.mask and 2) != 0 && free(x + 1, y)) { out += kitSprite(realm, ew, x, y, "edge", "edge"); used += key(x, y); used += key(x + 1, y); continue }
                if (ns != null && (e.mask and 4) != 0 && free(x, y + 1)) { out += kitSprite(realm, ns, x, y, "edge", "edge"); used += key(x, y); used += key(x, y + 1); continue }
                if (post != null) { out += kitSprite(realm, post, x, y, "edge", "edge"); used += key(x, y) }
            }
        }
        return out
    }

    /** decor.js `edgeAutotileSprites`: ART's 16-piece plot-edge autotile, one 32×48 piece per edge tile. */
    fun edgeAutotileSprites(d: BaseDecor): List<DecorSprite> = d.edges.map { e ->
        DecorSprite("edge:${t.edgeArms[e.mask]}", "edge", "edge", "edge", null, e.x, e.y, intArrayOf(1, 1), e.x + 0.5, (e.y + 1).toDouble(), (e.y + 1).toDouble(),
            doubleArrayOf(16.0, 48.0), 1 / art, intArrayOf(32, 48), intArrayOf(0, 0, 32, 48), 1, 0, 0, false, 0)
    }

    fun wallSprites(d: BaseDecor): List<DecorSprite> = d.walls.map { wallSprite(it.tier, it.x, it.y, it.piece, it.ring) }

    /** The realm kit's bridge piece for an axis (a flat kit sprite probe), or null. */
    fun bridgePiece(realmId: String, axis: String): DecorSprite? {
        val id = t.dressing[realmId]?.get("bridge")?.pieces?.get(axis) ?: return null
        return kitSprite(realmId, id, 0, 0, "flat", "bridge")
    }

    companion object {
        const val Z_NONE = 0; const val Z_RING = 1; const val Z_SKIRT = 2; const val Z_YARD = 3; const val Z_COURT = 4; const val Z_WALL = 5
        const val Z_EDGE = 6; const val Z_LANE = 7; const val Z_OCC = 8; const val Z_KEEP = 9
    }
}
