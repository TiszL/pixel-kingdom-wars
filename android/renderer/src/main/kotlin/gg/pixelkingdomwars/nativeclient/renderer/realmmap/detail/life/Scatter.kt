package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash.dissolve
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash.kitHash
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash.pcgX
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash.pcgY

/**
 * A sprite as LIFE places and draws it (life.js `readSprites` entry): the ink height the 6-px rule reads, the frame
 * geometry, and — once the layers are built — where its frames live on the GPU (array, first layer, layer size, anchor
 * in the layer). [twin] is its MAP-scale twin; [src] frame 0 for the MAP clump reducer.
 */
class LifeSprite(val inkH: Int, val w: Int, val h: Int, val ax: Double, val ay: Double, val frames: Int, val frameMs: Int) {
    var arr = -1; var layer0 = 0; var lw = 0; var lh = 0; var lax = 0.0; var lay = 0.0
    var twin: LifeTwin? = null
    var src: LifeFrameSource? = null
    var map7: LifeReduced? = null
}
/**
 * A twin, map object or stand clump layer: array, layer, layer size, anchor in the layer (life.js `twin`/`clump`), and the
 * frame's offset in its layer ([ox], [oy]: life.js keeps them on a map object's twin since stage B, for the lens glow's
 * anchor; 0 on every other twin, as the web's `tw.ox ?? 0` reads them).
 */
class LifeTwin(val arr: Int, val layer: Int, val lw: Int, val lh: Int, val lax: Int, val lay: Int, val ox: Int = 0, val oy: Int = 0)
/** A creature sheet (life.js `creatures` entry). */
class LifeSheet(val inkH: Int, val frames: Int, val frameMs: Int, val speed: Double, val dwellMs: Int, val directions: Int, val water: Boolean) {
    var arr = -1; var layer0 = 0; var lw = 0; var lh = 0; var lax = 0.0; var lay = 0.0
}

/** What compileLife may look up (life.js: the pack's sprites and creature sheets). Null = not in the pack. */
interface LifeLookup {
    fun sprite(id: String): LifeSprite?
    fun creature(id: String): LifeSheet?
}

/** The terrain a JS-reference placement reads: GROUND's class at a tile and the plot SDF (tiles). */
interface LifeEnv {
    fun classAt(tx: Int, ty: Int): Int
    fun plotSdf(x: Double, y: Double): Double
}

// ---- compiled forms (scatter.js compile*) ------------------------------------------------------------------------------

class CField(val id: Int, val salt: Int, val lo: Int, val k: Int)
class CMod(val id: Int, val salt: Int, val lo: Int, val k: Int, val out: Int, val inn: Int, val edge: Int)
/** [glow]: a map object's lens anchor in its map canvas (scatter.js compileGroup keeps `opt.glow`, stage B), null for none. */
class CSpecies(val id: String, val w: Double, val on: Int, val coast: Boolean, val emit: EmitRow?, val sp: LifeSprite, val cum: Int, val footR: Int, val glow: DoubleArray? = null)
/** How many instanced draws submit a group's ranges each window (life.js `submitCounts`, scatter.js `submittedTotal`). */
class GroupSubmit(val kit: Int, val kitMap: Int, val twin: Int, val puffs: Int)
class CGroup(
    val id: String, val kind: String, val realm: String, val salt: Int, val pitch: Double, val pitchArt: Int, val jitterArt: Int,
    val density: IntArray, val species: Array<CSpecies>, val missing: List<String>, val twin: Boolean, val sway: Boolean, val mapOnly: Boolean,
    val trueOnly: Boolean, val mod: CMod?, val cluster8: Int, val maxInkH: Int, val minInkH: Double, val maxExtent: Int,
) {
    /** life.js: the species table row, whether any species has a twin / an emitter / a lens glow (stage B), the draw multiplicities. */
    var row = -1; var hasTwins = false; var hasEmit = false; var hasGlow = false
    var submit: GroupSubmit? = null
}
class CStandSpecies(val id: String, val sp: LifeSprite)
class CMix(val id: String, val index: Int, val field: CField, val density: IntArray, val sway: Boolean, val mapOnly: Boolean)
class CMember(val dx: Int, val dy: Int, val s: Int, val flip: Int)
class CVariant(val mix: Int, val r4: Int, val members: Array<CMember>, val inkH: Int, val footDy: Int) { var clump: LifeTwin? = null }
class StandSubmit(val members: Int, val clumps: Int)
class CStands(
    val realm: String, val salt: Int, val pitch: Int, val pitchArt: Int, val jitterArt: Int, val species: List<CStandSpecies>, val mixes: List<CMix>,
    val variants: List<CVariant>, val missing: List<String>, val maxInkH: Int, val minInkH: Double, val mergeUntil: Double, val memberInkMin: Double,
) { var row = -1; var submit: StandSubmit? = null }
class CCreature(val id: String, val w: Double, val herdMin: Int, val herdMax: Int, val on: Int, val sh: LifeSheet, val cum: Int)
class CCreatures(
    val realm: String, val salt: Int, val pitch: Double, val pitchArt: Int, val jitterArt: Int, val density: IntArray, val species: List<CCreature>,
    val missing: List<String>, val maxInkH: Int,
) { var row = -1 }
class CBird(val id: String, val w: Double, val fMin: Int, val fMax: Int, val on: Int, val speed: Double, val alt: Double, val sp: LifeSprite, val cum: Int)
class CBirds(val realm: String, val salt: Int, val pitch: Double, val pitchArt: Int, val jitterArt: Int, val p16: Int, val species: List<CBird>) {
    /** life.js `submit`: draws per window (2 with the air array, 0 without; null = unknown, counted once). */
    var row = -1; var submit: Int? = null
}
class CAmbience(
    val id: String, val kind: String, val shared: Boolean, val salt: Int, val pitchArt: Int, val jitterArt: Int, val density: IntArray, val lifeMs: Int,
    val alt: Double?, val windK: Double?, val rise: Boolean, val minD: Double?, val sp: LifeSprite,
) { var row = -1 }
class CLife(
    val realm: String, var wind: DoubleArray, val fields: Array<CField>, val groups: List<CGroup>, val stands: CStands?, val creatures: CCreatures?,
    val birds: CBirds?, val ambience: List<CAmbience>, val missing: List<String>,
) {
    /** Art-px bounds of the realm grid (life.js `L.bounds`): the planner never walks lattices outside it. */
    var bx0 = 0.0; var by0 = 0.0; var bx1 = 0.0; var by1 = 0.0
}

// ---- reference placement results (tests and QC; the GPU does this per instance) ------------------------------------------

class ScatterInst(val ix: Int, val iy: Int, val x: Int, val y: Int, val cls: Int, val species: Int, val id: String, val flip: Int, val phase: Int, val h2: Int, val rank: Int)
class StandSiteR(val ix: Int, val iy: Int, val x: Int, val y: Int, val cls: Int, val v: Int, val mix: Int, val flip: Int, val h2: Int, val sdf: Double, val rank: Int)
class StandMemberR(val x: Int, val y: Int, val species: Int, val id: String, val flip: Int)
class HerdSiteR(val ix: Int, val iy: Int, val x: Int, val y: Int, val cls: Int, val species: Int, val id: String, val n: Int, val h2: Int)
class PathPoint(val x: Double, val y: Double)
class HerdMemberR(val m: Int, val id: String, val species: Int, val points: List<PathPoint>, val speed: Double, val dwellMs: Int, val phase: Int)
class Pose(val x: Double, val y: Double, val facing: String, val dx: Double, val dy: Double, val dwelling: Boolean)
class FlockR(val ix: Int, val iy: Int, val x: Int, val y: Int, val species: Int, val id: String, val n: Int, val radius: Int, val dir: Int, val h2: Int, val rank: Int)
class BirdPoseR(val x: Double, val y: Double, val alt: Double, val flip: Int, val frame: Int)
class ParticleR(val x: Double, val y: Double, val alt: Double, val frame: Int, val fade: Double, val flip: Int)

/**
 * The LIFE lane's placement maths (web `scatter.js`, pinned), 1:1: compile a realm's table against the sprites the pack
 * carries, and the JS reference of every instance the GLSL places (`glsl/sprites.glsl.js`, `air.glsl.js`): same integer
 * hashes, same lattices, so a golden vector pins "the same tree on the same tile". Pure; no wall clock, no randomness.
 * The compile runs on a worker at load; the reference functions are for tests and QC (the GPU places instances).
 */
class Scatter(val c: LifeConstants, val geo: LifeGeometry) {
    private val art = geo.art
    private val deedArt = geo.deedArt
    private val nClass = c.classCount
    val rankB = 1 shl c.rankN
    val rankSlots = rankB * rankB
    val rankStep = 65536 / rankSlots
    private val clsDeep = c.classId("DEEP"); private val clsSea = c.classId("SEA"); private val clsWater = c.classId("WATER")
    private val watery = c.classMask(listOf("DEEP", "SEA", "WATER"))
    private val waterWalk = c.classMask(listOf("WATER", "SEA", "SHORE"))
    private val landBlock = c.classMask(listOf("DEEP", "SEA", "WATER", "ROAD", "TURF", "RING"))
    private val landy = watery.inv()
    private val edgeFlatQ = c.stand.edgeFlat * 4
    private val edgeQ = (c.stand.edgeFlat + c.stand.edgeTiles) * 4
    private val edgeInv = Math.floorDiv(65536, c.stand.edgeTiles * 4)

    init { require(clsDeep == 0 && clsSea == 1 && clsWater == 2) { "LIFE expects DEEP/SEA/WATER = 0/1/2 (contracts.js CLASS)" } }

    // ---------------------------------------------------------------- small rules

    fun bigEnough(inkArt: Double, d: Double, scale: Double = 1.0): Boolean = inkArt * scale * d >= c.minSpritePx * deedArt.toDouble()
    fun minVisibleD(inkArt: Double, scale: Double = 1.0): Double = c.minSpritePx * deedArt.toDouble() / Math.max(1e-6, inkArt * scale)
    fun devicePx(inkArt: Double, d: Double, scale: Double = 1.0): Double = inkArt * scale * d / deedArt

    /** scatter.js `salt16`: FNV-1a over UTF-16 code units, folded to 16 bits. */
    fun salt16(s: String): Int {
        var h = 0x811c9dc5.toInt()
        for (ch in s) { h = h xor ch.code; h *= 0x01000193 }
        return ((h ushr 16) xor h) and 0xffff
    }

    /** A 16-bit hash field reduced to [0, n) by multiply-shift (never a modulo: scatter.js `range16`). */
    fun range16(h16: Int, n: Int): Int = ((((h16 and 0xffff).toLong() * n) and 0xffffffffL) ushr 16).toInt()

    private fun densityOf(d: Map<String, Double>): IntArray {
        val out = IntArray(nClass)
        for ((name, p) in d) out[c.classId(name)] = JsMath.round(JsMath.clamp(p, 0.0, 1.0) * 65535).toInt()
        return out
    }

    // ---------------------------------------------------------------- compile

    fun compileFields(realm: String, veg: DoubleArray?, rock: DoubleArray?): Array<CField> {
        fun one(name: String, lh: DoubleArray?): CField {
            val lo = lh?.get(0) ?: 128.0; val hi = lh?.get(1) ?: 168.0
            return CField(if (name == "rock") 1 else 0, salt16("$realm:field:$name"), lo.toInt(), Math.floor(65536 / Math.max(1.0, hi - lo)).toInt())
        }
        return arrayOf(one("veg", veg), one("rock", rock))
    }

    private fun compileMod(m: ModRow?, fields: Array<CField>?): CMod? {
        if (m == null || fields == null) return null
        val f = fields[if (m.field == "rock") 1 else 0]
        return CMod(f.id, f.salt, f.lo, f.k, JsMath.round(m.out * 256).toInt(), JsMath.round(m.inn * 256).toInt(), JsMath.round((m.edge ?: 0.0) * 256).toInt())
    }

    fun compileGroup(realm: String, g: GroupRow, sprites: (String) -> LifeSprite?, fields: Array<CField>?): CGroup {
        class Kept(val id: String, val w: Double, val on: Int, val coast: Boolean, val emit: EmitRow?, val glow: DoubleArray?, val sp: LifeSprite)
        val kept = ArrayList<Kept>(); val missing = ArrayList<String>()
        for (s in g.species) {
            val sp = sprites(s.id)
            if (sp == null) { missing += s.id; continue }
            if (kept.size >= c.maxSpecies) { missing += "${s.id} (over ${c.maxSpecies} species in ${g.id})"; continue }
            kept += Kept(s.id, s.w, if (s.on != null) c.classMask(s.on) else 0, s.coast, s.emit, s.glow, sp)
        }
        var total = 0.0; for (k in kept) total += k.w
        var acc = 0.0
        val species = Array(kept.size) { i ->
            val s = kept[i]; acc += s.w
            val fr = Math.max(1.0, Math.ceil(Math.max(s.sp.w.toDouble(), s.sp.h * 0.6) / art / 2)).toInt()
            CSpecies(s.id, s.w, s.on, s.coast, s.emit, s.sp, if (total > 0) Math.min(65536.0, JsMath.round(acc / total * 65536)).toInt() else 0, fr, s.glow)
        }
        if (species.isNotEmpty()) { val l = species.last(); species[species.size - 1] = CSpecies(l.id, l.w, l.on, l.coast, l.emit, l.sp, 65536, l.footR, l.glow) }
        val pitchArt = JsMath.round(g.pitch * art).toInt()
        var maxInk = 0; var minInk = Double.POSITIVE_INFINITY; var maxExt = 0
        for (s in species) { maxInk = Math.max(maxInk, s.sp.inkH); minInk = Math.min(minInk, s.sp.inkH.toDouble()); maxExt = Math.max(maxExt, Math.max(s.sp.w, s.sp.h)) }
        return CGroup(
            g.id, g.kind, realm, salt16("$realm:${g.id}"), g.pitch, pitchArt,
            Math.max(0, Math.min(pitchArt - 1, Math.floor(pitchArt * (g.jitter ?: 0.8)).toInt())),
            densityOf(g.density), species, missing, g.twin, g.sway, g.mapOnly, !g.twin, compileMod(g.mod, fields),
            JsMath.round(JsMath.clamp(g.cluster ?: 0.0, 0.0, 1.0) * 255).toInt(), maxInk, minInk, maxExt,
        )
    }

    fun compileCreatures(realm: String, t: CreatureTable, sheet: (String) -> LifeSheet?): CCreatures {
        class Kept(val id: String, val w: Double, val herdMin: Int, val herdMax: Int, val on: Int, val sh: LifeSheet)
        val kept = ArrayList<Kept>(); val missing = ArrayList<String>()
        for (s in t.species) {
            val sh = sheet(s.id)
            if (sh == null) { missing += s.id; continue }
            kept += Kept(s.id, s.w, s.herdMin, Math.min(c.herdMax, s.herdMax), c.classMask(s.on), sh)
        }
        var total = 0.0; for (k in kept) total += k.w
        var acc = 0.0
        val species = kept.mapIndexed { i, s ->
            acc += s.w
            CCreature(s.id, s.w, s.herdMin, s.herdMax, s.on, s.sh, if (i == kept.size - 1) 65536 else Math.min(65536.0, JsMath.round(acc / total * 65536)).toInt())
        }
        val pitchArt = JsMath.round(t.pitch * art).toInt()
        var maxInk = 0; for (s in species) maxInk = Math.max(maxInk, s.sh.inkH)
        return CCreatures(realm, salt16("$realm:creatures"), t.pitch, pitchArt, Math.floor(pitchArt * 0.7).toInt(), densityOf(t.density), species, missing, maxInk)
    }

    fun compileBirds(realm: String, t: BirdTable, sprite: (String) -> LifeSprite?): CBirds {
        class Kept(val r: BirdRow, val sp: LifeSprite)
        val kept = ArrayList<Kept>()
        for (s in t.species) { val sp = sprite(s.id); if (sp != null) kept += Kept(s, sp) }
        var total = 0.0; for (k in kept) total += k.r.w
        var acc = 0.0
        val species = kept.mapIndexed { i, k ->
            acc += k.r.w
            CBird(k.r.id, k.r.w, k.r.fMin, Math.min(c.flockMax, k.r.fMax), c.classMask(k.r.on), k.r.speed ?: 36.0, k.r.alt ?: 72.0, k.sp,
                if (i == kept.size - 1) 65536 else Math.min(65536.0, JsMath.round(acc / total * 65536)).toInt())
        }
        return CBirds(realm, salt16("$realm:birds"), t.pitch, JsMath.round(t.pitch * art).toInt(), Math.floor(t.pitch * art * 0.6).toInt(),
            JsMath.round(JsMath.clamp(t.p, 0.0, 1.0) * 65535).toInt(), species)
    }

    fun compileAmbience(realm: String, list: List<AmbienceRow>, sprite: (String) -> LifeSprite?): List<CAmbience> {
        val out = ArrayList<CAmbience>()
        for (a in list) {
            val sp = sprite(a.id) ?: continue
            out += CAmbience(a.id, a.kind, a.shared, salt16("$realm:amb:${a.id}:${a.kind}"), JsMath.round(a.pitch * art).toInt(), Math.floor(a.pitch * art * 0.9).toInt(),
                densityOf(a.density), a.lifeMs, a.alt, a.windK, a.rise, a.minD, sp)
        }
        return out
    }

    /**
     * Compile a realm's stand table (scatter.js `compileStands`): mixes → species list, per-mix class densities and
     * their pre-laid variants. Null when the table has no mixes or no variant survives.
     */
    fun compileStands(realm: String, mixesIn: List<MixRow>?, fields: Array<CField>, sprites: (String) -> LifeSprite?): CStands? {
        if (mixesIn.isNullOrEmpty()) return null
        val species = ArrayList<CStandSpecies>(); val missing = ArrayList<String>(); val index = HashMap<String, Int>()
        fun sIdx(id: String): Int {
            index[id]?.let { return it }
            val sp = sprites(id)
            if (sp == null || species.size >= c.maxSpecies) { missing += if (sp != null) "$id (over ${c.maxSpecies} stand species)" else id; index[id] = -1; return -1 }
            species += CStandSpecies(id, sp); index[id] = species.size - 1; return species.size - 1
        }
        val mixes = ArrayList<CMix>(); val variants = ArrayList<CVariant>()
        for (mx in mixesIn) {
            val sp = ArrayList<Pair<Int, Double>>()
            for ((id, w) in mx.species) sp += sIdx(id) to w
            sp.removeAll { it.first < 0 }
            if (sp.isEmpty()) continue
            val mix = CMix(mx.id, mixes.size, fields[if (mx.field == "rock") 1 else 0], densityOf(mx.density), mx.sway, mx.mapOnly)
            mixes += mix
            val salt = salt16("$realm:stand:${mx.id}")
            for (v in 0 until (mx.variants ?: 8)) variants += layStand(mix, mx, sp, species, salt, v)
        }
        if (variants.isEmpty()) return null
        var minInk = Double.POSITIVE_INFINITY; var maxInk = 0; for (v in variants) { minInk = Math.min(minInk, v.inkH.toDouble()); maxInk = Math.max(maxInk, v.inkH) }
        var memberMin = Double.POSITIVE_INFINITY; for (s in species) memberMin = Math.min(memberMin, s.sp.inkH.toDouble())
        return CStands(realm, salt16("$realm:stands"), c.stand.pitch, c.stand.pitch * art, Math.floor(c.stand.pitch * art * c.stand.jitter).toInt(),
            species, mixes, variants, missing, maxInk, minInk,
            Math.max(c.stand.splitFull, Math.ceil(c.minSpritePx * deedArt.toDouble() / Math.max(1.0, minInk))), memberMin)
    }

    /** One pre-laid stand (scatter.js `layStand`): pure in (realm, mix, v); the hash stream order is the web's. */
    private fun layStand(mix: CMix, mx: MixRow, sp: List<Pair<Int, Double>>, species: List<CStandSpecies>, salt: Int, v: Int): CVariant {
        var k = 0
        fun hh(): Int {
            val a = salt * 131 + v * 0x9e37
            val b = ((k.toLong() * 0x85ebca6bL + v) and 0xffffffffL).toInt(); k++
            return pcgX(a, b)
        }
        fun u(): Double = (hh() and 0xffff) / 65536.0
        var total = 0.0; for (e in sp) total += e.second
        fun pick(r: Double): Int { var x = r * total; for (e in sp) { if (x < e.second) return e.first; x -= e.second }; return sp[sp.size - 1].first }
        val r0 = mx.r?.get(0) ?: 2.0; val r1 = mx.r?.get(1) ?: 4.0
        val rr = JsMath.round((r0 + (r1 - r0) * u()) * 4) / 4; val ra = rr * art
        val s = (mx.spacing ?: 2.2) * art; val rowH = s * 0.866; val ox = u() * s; val oy = u() * rowH
        val dominant = pick(u()); val cluster = mx.cluster ?: 0.7
        class Cand(val dx: Int, val dy: Int, val s: Int, val flip: Int, val r2: Double)
        val cand = ArrayList<Cand>()
        val n = Math.ceil(ra / rowH).toInt() + 1
        for (j in -n..n) for (i in -n..n) {
            val x = (i + (if (j and 1 != 0) 0.5 else 0.0)) * s + ox - s / 2 + (u() - 0.5) * s * 0.45
            val y = j * rowH + oy - rowH / 2 + (u() - 0.5) * rowH * 0.45
            val lim = ra * (0.8 + 0.4 * u())
            val sIx = if (u() < cluster) dominant else pick(u())
            val flip = if (u() < 0.5) 1 else 0
            if (x * x + y * y <= lim * lim) cand += Cand(JsMath.round(x).toInt(), JsMath.round(y).toInt(), sIx, flip, x * x + y * y)
        }
        cand.sortWith { a, b -> java.lang.Double.compare(a.r2, b.r2).let { if (a.r2 - b.r2 == 0.0) 0 else it } }
        val chosen = ArrayList(cand.subList(0, Math.min(c.stand.members, cand.size)))
        chosen.sortWith { a, b -> if (a.dy != b.dy) a.dy - b.dy else a.dx - b.dx }
        val members = chosen.map { CMember(it.dx, it.dy, it.s, it.flip) }.toMutableList()
        if (members.isEmpty()) members += CMember(0, 0, dominant, 0)
        var top = Double.POSITIVE_INFINITY; var bot = Double.NEGATIVE_INFINITY
        for (m in members) { top = Math.min(top, (m.dy - species[m.s].sp.inkH).toDouble()); bot = Math.max(bot, m.dy.toDouble()) }
        return CVariant(mix.index, JsMath.round(rr * 4).toInt(), members.toTypedArray(), (bot - top).toInt(), bot.toInt())
    }

    /** scatter.js `withCanopy`: a map-only canopy mix of the grove's own species fills FOREST at MAP (fix iteration 1). */
    fun withCanopy(table: LifeTable): List<MixRow>? {
        val grove = table.groups.firstOrNull { it.id == "grove" }; val mixes = table.mixes ?: return null
        if (grove == null || mixes.any { (it.density["FOREST"] ?: 0.0) != 0.0 }) return mixes
        // the canopy mix's literals are scatter.js's own (variants 16, R [1.5, 3.5], cluster 0.8, FOREST 0.95)
        return mixes + MixRow("canopy", null, 16, doubleArrayOf(1.5, 3.5), grove.pitch, 0.8, false, true,
            linkedMapOf("FOREST" to 0.95), grove.species.map { it.id to it.w })
    }

    /**
     * scatter.js `lifeTable`: the pack's own `realm.json.life` when present, else the defaults, plus the pack's landmark
     * sprites and map objects (by role). [landmarks] / [objects] come from the pack's realm.json in its order. Stage B: a map
     * object takes its weight and coast rule from the table's `mapobjs` (by object id, then by role; unlisted objects weigh
     * 1: a FALL is 0.08 and by water only) and its lens glow from the table's `glow` (by object id).
     */
    fun lifeTable(base: LifeTable?, landmarks: List<String>, objects: List<Pair<String, String?>>): LifeTable? {
        if (base == null) return null
        if (landmarks.isEmpty() && objects.isEmpty()) return base
        val objRows = objects.map { (id, role) ->
            val r = mapObjectRole(id, role)
            val o = base.mapobjs[id] ?: r?.let { base.mapobjs[it] }
            SpeciesRow(id, o?.w ?: 1.0, r?.let { c.mapobjRoles[it] } ?: listOf("ROCK"), o?.coast ?: false, null, base.glow[id])
        }
        return base.withGroups(base.groups.map { g ->
            when (g.id) {
                "landmarks" -> GroupRow(g.id, g.kind, g.pitch, g.density, g.species + landmarks.filter { id -> g.species.none { it.id == id } }.map { SpeciesRow(it, 1.0, null, false, null) },
                    g.jitter, g.twin, g.sway, g.mapOnly, g.mod, g.cluster)
                "mapobj" -> GroupRow(g.id, g.kind, g.pitch, g.density, g.species + objRows, g.jitter, g.twin, g.sway, g.mapOnly, g.mod, g.cluster)
                else -> g
            }
        })
    }

    /** scatter.js `mapObjectRole`: ART's role words, else the id's `map_<role>_<n>` prefix. */
    fun mapObjectRole(id: String, role: String?): String? {
        val words = (role ?: "").lowercase().trim()
        val cand = ArrayList<String>(); cand += words.replace(Regex("\\s+"), "_"); cand += words.split(Regex("\\s+")).reversed()
        cand.firstOrNull { c.mapobjRoles.containsKey(it) }?.let { return it }
        return c.mapobjRoles.keys.firstOrNull { k -> Regex("^map_${Regex.escape(k)}(_|$)").containsMatchIn(id) }
    }

    /** scatter.js `compileLife`: every LIFE table of a realm against what the pack carries; unknown ids dropped and listed. */
    fun compileLife(realm: String, table: LifeTable?, look: LifeLookup): CLife? {
        if (table == null) return null
        val fields = compileFields(realm, table.fieldVeg, table.fieldRock)
        val sprite: (String) -> LifeSprite? = { look.sprite(it) }
        val groups = table.groups.map { compileGroup(realm, it, sprite, fields) }.filter { it.species.isNotEmpty() }
        val stands = if (table.mixes != null) compileStands(realm, withCanopy(table), fields, sprite) else null
        val creatures = table.creatures?.let { compileCreatures(realm, it, look::creature) }
        val birds = table.birds?.let { compileBirds(realm, it, sprite) }
        val ambience = compileAmbience(realm, table.ambience, sprite)
        val missing = ArrayList<String>()
        for (g in table.groups) missing += compileGroup(realm, g, sprite, null).missing
        creatures?.let { missing += it.missing }
        for (a in table.ambience) if (look.sprite(a.id) == null) missing += "${a.id}${if (a.shared) " (shared fx pack)" else ""}"
        stands?.let { for (id in LinkedHashSet(it.missing)) missing += "$id (stand)" }
        return CLife(realm, table.wind.copyOf(), fields, groups, stands, creatures, birds, ambience, missing)
    }

    // ---------------------------------------------------------------- lattices and ranks

    /** `floor(a / b)` for the rank maths (JS `Math.floor(a / b)`, b > 0). */
    private fun floorDivD(a: Int, b: Int): Int = Math.floor(a.toDouble() / b).toInt()

    fun rankHashSx(salt: Int, bx: Int, by: Int): Int = rankH(salt, bx, by) and (rankB - 1)
    fun rankHashSy(salt: Int, bx: Int, by: Int): Int = (rankH(salt, bx, by) ushr 4) and (rankB - 1)
    fun rankHashU16(salt: Int, bx: Int, by: Int): Int = rankH(salt, bx, by) ushr 16
    private fun rankH(salt: Int, bx: Int, by: Int): Int = pcgX(bx xor salt xor 0x5a17, by xor (salt * 7) xor 0x3c6e)

    fun slotX(j: Int): Int { val a = j and 3; val b = (j shr 2) and 3; return (((a xor (a shr 1)) and 1) shl 1) or ((b xor (b shr 1)) and 1) }
    fun slotY(j: Int): Int { val a = j and 3; val b = (j shr 2) and 3; return ((a and 1) shl 1) or (b and 1) }
    fun xySlot(x: Int, y: Int): Int {
        fun q(dx: Int, dy: Int) = ((dx xor dy) shl 1) or dy
        return q((x shr 1) and 1, (y shr 1) and 1) or (q(x and 1, y and 1) shl 2)
    }
    fun cellRank(salt: Int, ix: Int, iy: Int): Int {
        val bx = floorDivD(ix, rankB); val by = floorDivD(iy, rankB); val h = rankH(salt, bx, by)
        return xySlot((ix - bx * rankB) xor (h and (rankB - 1)), (iy - by * rankB) xor ((h ushr 4) and (rankB - 1))) * rankStep + ((h ushr 16) ushr (2 * c.rankN))
    }
    /** Slot j of block (bx, by) → [ix, iy, rank] into [out]. */
    fun slotCell(salt: Int, bx: Int, by: Int, j: Int, out: IntArray) {
        val h = rankH(salt, bx, by)
        out[0] = bx * rankB + (slotX(j) xor (h and (rankB - 1))); out[1] = by * rankB + (slotY(j) xor ((h ushr 4) and (rankB - 1)))
        out[2] = j * rankStep + ((h ushr 16) ushr (2 * c.rankN))
    }
    fun rankBound(w: Double): Int = Math.min(65536.0, Math.max(0.0, JsMath.round(w * 65536))).toInt()

    // ---------------------------------------------------------------- cells, fields, edges

    fun cellSeatX(pitchArt: Int, jitterArt: Int, ix: Int, h0: Int): Int = ix * pitchArt + ((pitchArt - jitterArt) shr 1) + range16(h0, jitterArt + 1)
    fun cellSeatY(pitchArt: Int, jitterArt: Int, iy: Int, h0: Int): Int = iy * pitchArt + ((pitchArt - jitterArt) shr 1) + range16(h0 ushr 16, jitterArt + 1)

    fun fadeU8(t: Int): Int = ((t.toLong() * t * (768 - 2 * t)) ushr 16).toInt()
    private fun vcell(salt: Int, cx: Int, cy: Int): Int = pcgX(cx xor salt, cy xor (salt * 7)) and 255
    fun valueU8(salt: Int, x: Int, y: Int, shift: Int): Int {
        val m = (1 shl shift) - 1; val cx = x shr shift; val cy = y shr shift
        val fx = fadeU8(((x and m) shl 8) shr shift); val fy = fadeU8(((y and m) shl 8) shr shift)
        val a = vcell(salt, cx, cy) * (256 - fx) + vcell(salt, cx + 1, cy) * fx
        val b = vcell(salt, cx, cy + 1) * (256 - fx) + vcell(salt, cx + 1, cy + 1) * fx
        return ((a.toLong() * (256 - fy) + b.toLong() * fy) ushr 16).toInt()
    }
    fun standField(salt: Int, x: Int, y: Int): Int = (valueU8(salt, x, y, 10) * 3 + valueU8(salt xor 0x5bd1, x, y, 9)) shr 2
    fun coverOf(v: Int, lo: Int, k: Int): Int = Math.max(0, Math.min(256, ((v - lo) * k) shr 8))
    fun edgeWeight(sdf: Double, clear: Double): Int {
        val e = Math.floor(Math.min(sdf - clear, 64.0) * 4)
        if (e < 0) return -1
        if (e < edgeFlatQ) return 255
        if (e >= edgeQ) return 0
        return ((edgeQ - e.toInt()) * edgeInv) shr 8
    }
    fun modDensity(dens16: Int, out: Int, inn: Int, edge: Int, cover256: Int, edge256: Int): Int {
        if (dens16 == 0) return dens16
        var m = out + (((inn - out) * cover256) shr 8)
        val e = if (edge256 > 0) (edge * edge256) shr 8 else 0
        if (e > m) m = e
        return Math.min(65535, (dens16 * m) shr 8)
    }
    fun clusterPick(salt: Int, x: Int, y: Int): Int = pcgX((x shr 8) xor (salt * 3), (y shr 8) xor (salt * 5)) ushr 16

    // ---------------------------------------------------------------- scatter (JS reference)

    /** scatter.js `pickSpecies`, a linear scan (the web's CPU twin stays linear). The GPU (stage B) runs a lower-bound
     *  search of the table's non-decreasing `cum − 1` column in ≤ 7 fetches, which picks the same index. */
    internal fun pickSpecies(species: Array<CSpecies>, pick16: Int): Int { for (i in species.indices) if (pick16 < species[i].cum) return i; return -1 }

    fun nearWater(env: LifeEnv, tx: Int, ty: Int, r: Int): Boolean {
        if (((watery ushr env.classAt(tx + r, ty)) and 1) != 0) return true
        if (((watery ushr env.classAt(tx - r, ty)) and 1) != 0) return true
        if (((watery ushr env.classAt(tx, ty + r)) and 1) != 0) return true
        return ((watery ushr env.classAt(tx, ty - r)) and 1) != 0
    }

    fun scatterInstance(g: CGroup, ix: Int, iy: Int, env: LifeEnv): ScatterInst? {
        if (g.species.isEmpty()) return null
        val h0 = pcgX(ix xor g.salt, iy xor (g.salt * 7)); val h1 = pcgY(ix xor g.salt, iy xor (g.salt * 7)); val h2 = kitHash(ix xor g.salt, iy)
        val sx = cellSeatX(g.pitchArt, g.jitterArt, ix, h0); val sy = cellSeatY(g.pitchArt, g.jitterArt, iy, h0)
        val tx = Math.floorDiv(sx, art); val ty = Math.floorDiv(sy, art)
        val cls = env.classAt(tx, ty)
        var dens = g.density[cls]; var sdf = Double.NaN
        val mod = g.mod
        if (mod != null && dens != 0) {
            sdf = env.plotSdf(sx.toDouble() / art, sy.toDouble() / art)
            dens = modDensity(dens, mod.out, mod.inn, mod.edge, coverOf(standField(mod.salt, sx, sy), mod.lo, mod.k), edgeWeight(sdf, c.plotClear.toDouble()))
        }
        if ((h1 and 0xffff) >= dens) return null
        var pick = h1 ushr 16
        if (g.cluster8 != 0 && (pcgX(h0, h1) and 255) < g.cluster8) pick = clusterPick(g.salt, sx, sy)
        var s = pickSpecies(g.species, pick)
        if (s < 0) return null
        fun grows(i: Int) = g.species[i].on == 0 || ((g.species[i].on ushr cls) and 1) != 0
        if (g.mapOnly && !grows(s)) {
            val e = pcgX(h1, h0)
            for (p in intArrayOf(e ushr 16, e and 0xffff)) { val t = pickSpecies(g.species, p); if (t >= 0 && grows(t)) { s = t; break } }
        }
        val sp = g.species[s]
        if (sp.on != 0 && ((sp.on ushr cls) and 1) == 0) return null
        val r = sp.footR
        if (r > 1) {
            val cx = intArrayOf(-r, r, -r, r); val cy = intArrayOf(-r, -r, 0, 0)
            for (i in 0 until 4) {
                val cc = env.classAt(tx + cx[i], ty + cy[i])
                if (if (sp.on != 0) ((sp.on ushr cc) and 1) == 0 else g.density[cc] == 0) return null
            }
        }
        if (sp.coast && !nearWater(env, tx, ty, r + 3)) return null
        val sd = if (!sdf.isNaN()) sdf else env.plotSdf(sx.toDouble() / art, sy.toDouble() / art)
        if (sd < c.plotClear + r) return null
        return ScatterInst(ix, iy, sx, sy, cls, s, sp.id, (h2 ushr 16) and 1, (h2 ushr 17) and 0x7fff, h2, cellRank(g.salt, ix, iy))
    }

    /** scatter.js `instanceLod`: 'true', 'twin' or 'none' (per instance, by its rank; map objects by their hash). */
    fun instanceLod(g: CGroup, species: Int, h2: Int, rank: Int, d: Double, wTrue: Double, wTwin: Double, keep: Double = 1.0): String {
        val sp = g.species[species].sp
        if (!bigEnough(sp.inkH.toDouble(), d)) return "none"
        if (rank >= rankBound(keep)) return "none"
        if (g.mapOnly) return if (dissolve(h2, wTrue)) "none" else "twin"
        if (rank < rankBound(wTrue * keep)) return "true"
        if (g.twin && rank < rankBound(wTwin * keep)) return "twin"
        return "none"
    }

    fun swayArt(h2: Int, phase: Int, ms: Double, d: Double, rm: Boolean, swayD: Double): Int {
        if (rm || d < swayD) return 0
        val period = c.swayPeriodMinMs + range16(h2 ushr 16, c.swayPeriodMaxMs - c.swayPeriodMinMs + 1)
        return Math.floor(JsMath.sin((ms % period) / period * 2 * Math.PI + phase) * c.swayAmpArt + 0.5).toInt()
    }
    /**
     * scatter.js `glowPulse` (stage B), the CPU twin of SCATTER_VS's lens glow strength: a smoothstepped triangle over the
     * period, phase `(h2 >>> 17) & 0x7fff` × 61 ms, `GLOW.rest` under reduced motion.
     */
    fun glowPulse(h2: Int, ms: Double, rm: Boolean, periodMs: Int = c.glow.periodMs): Double {
        if (rm) return c.glow.rest
        val ph = (h2 ushr 17) and 0x7fff
        val t = JsMath.u32(JsMath.toInt32(ms + ph * 61)) % periodMs
        val tri = 1 - Math.abs(2 * (t / periodMs) - 1)
        return c.glow.lo + (1 - c.glow.lo) * tri * tri * (3 - 2 * tri)
    }
    fun clipFrame(phase: Int, ms: Double, frames: Int, frameMs: Int, rm: Boolean): Int {
        if (frames <= 1 || rm) return 0
        val t = JsMath.u32(JsMath.toInt32(ms + phase * 37))
        return (Math.floor(t / Math.max(1, frameMs)) % frames).toInt()
    }

    // ---------------------------------------------------------------- creatures

    fun isqrt(n: Long): Long {
        if (n < 2) return n
        var x = n; var y = Math.floorDiv(x + 1, 2)
        while (y < x) { x = y; y = Math.floorDiv(x + Math.floorDiv(n, x), 2) }
        return x
    }
    fun segmentFacing(dx: Double, dy: Double): String = if (Math.abs(dx) >= Math.abs(dy)) (if (dx < 0) "left" else "right") else (if (dy < 0) "up" else "down")
    fun facingRow(directions: Int, facing: String, dx: Double): Int = when (directions) {
        4 -> c.facings.indexOf(facing)
        2 -> if (facing == "left" || (facing != "right" && dx < 0)) 0 else 1
        else -> 0
    }

    /** scatter.js `pathPose` (the realm kit's realmKitPathPose): integer-safe. [loopCycle] only (herd loops are cycles). */
    fun pathPose(points: List<PathPoint>, speed: Double, dwellMs: Int, elapsedMs: Double, still: Boolean): Pose {
        val vertices = points; val segments = vertices.size - 1
        fun travel(i: Int): Double { val p = vertices[i]; val q = vertices[i + 1]; val dx = q.x - p.x; val dy = q.y - p.y
            return Math.floor(isqrt((dx * dx + dy * dy).toLong()) * 1000 / speed) }
        val f0 = vertices[0]; val f1 = vertices[1]
        val home = Pose(f0.x, f0.y, segmentFacing(f1.x - f0.x, f1.y - f0.y), f1.x - f0.x, f1.y - f0.y, true)
        if (still) return home
        val dwell = dwellMs.toDouble()
        var period = 0.0
        for (i in 0 until segments) period += dwell + travel(i)
        var t = if (period > 0) elapsedMs % period else 0.0
        for (i in 0 until segments) {
            val p = vertices[i]; val q = vertices[i + 1]; val dx = q.x - p.x; val dy = q.y - p.y; val facing = segmentFacing(dx, dy)
            if (t < dwell) return Pose(p.x, p.y, facing, dx, dy, true)
            t -= dwell
            val tt = travel(i)
            if (t < tt) return Pose(p.x + Math.floor(dx * t / tt), p.y + Math.floor(dy * t / tt), facing, dx, dy, false)
            t -= tt
        }
        return home
    }
    fun poseFrame(pose: Pose, elapsedMs: Double, frames: Int, frameMs: Int, directions: Int = 4, still: Boolean = false): Int {
        val walk = if (still || pose.dwelling) 0 else (Math.floor(elapsedMs / frameMs) % frames).toInt()
        return facingRow(directions, pose.facing, pose.dx) * frames + walk
    }
    fun walkableFor(water: Boolean, cls: Int): Boolean = if (water) ((waterWalk ushr cls) and 1) == 1 else ((landBlock ushr cls) and 1) == 0

    fun herdSite(cr: CCreatures, ix: Int, iy: Int, env: LifeEnv): HerdSiteR? {
        if (cr.species.isEmpty()) return null
        val h0 = pcgX(ix xor cr.salt, iy xor (cr.salt * 7)); val h1 = pcgY(ix xor cr.salt, iy xor (cr.salt * 7)); val h2 = kitHash(ix xor cr.salt, iy)
        val sx = cellSeatX(cr.pitchArt, cr.jitterArt, ix, h0); val sy = cellSeatY(cr.pitchArt, cr.jitterArt, iy, h0)
        val tx = Math.floorDiv(sx, art); val ty = Math.floorDiv(sy, art)
        val cls = env.classAt(tx, ty)
        if ((h1 and 0xffff) >= cr.density[cls]) return null
        var s = -1; for (i in cr.species.indices) if ((h1 ushr 16) < cr.species[i].cum) { s = i; break }
        if (s < 0) return null
        val sp = cr.species[s]
        if (((sp.on ushr cls) and 1) == 0 || !walkableFor(sp.sh.water, cls)) return null
        if (env.plotSdf(sx.toDouble() / art, sy.toDouble() / art) < c.plotClear + c.loopRadiusTiles + 2) return null
        val n = sp.herdMin + range16(h2 ushr 16, sp.herdMax - sp.herdMin + 1)
        return HerdSiteR(ix, iy, sx, sy, cls, s, sp.id, n, h2)
    }
    private fun snap(v: Double): Double = JsMath.round(v / c.waypointSnap) * c.waypointSnap
    fun segmentWalkable(water: Boolean, env: LifeEnv, ax: Double, ay: Double, bx: Double, by: Double): Boolean {
        val dx = bx - ax; val dy = by - ay; val n = Math.max(1.0, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / c.waypointSnap)).toInt()
        for (k in 1 until n) {
            val x = ax + Math.floor(dx * k / n); val y = ay + Math.floor(dy * k / n)
            if (!walkableFor(water, env.classAt(Math.floor(x / art).toInt(), Math.floor(y / art).toInt()))) return false
        }
        return true
    }
    fun herdMember(cr: CCreatures, site: HerdSiteR, m: Int, env: LifeEnv): HerdMemberR? {
        if (m >= site.n) return null
        val sp = cr.species[site.species]; val rr = c.loopRadiusTiles * art
        val ax0 = site.h2 xor (m * 0x9e37); val ay0 = site.ix * 31 + site.iy * 17 + m
        val a = pcgX(ax0, ay0); val b = pcgY(ax0, ay0)
        fun off(v: Int) = range16(v, 97) - 48
        val hx = snap(site.x + (if (m != 0) off(a and 0xffff) else 0).toDouble()); val hy = snap(site.y + (if (m != 0) off(a ushr 16) else 0).toDouble())
        if (!walkableFor(sp.sh.water, env.classAt(Math.floor(hx / art).toInt(), Math.floor(hy / art).toInt()))) return null
        val pts = ArrayList<PathPoint>(); pts += PathPoint(hx, hy)
        val c1 = pcgX(a, b); val c2 = pcgY(a, b); val c3 = pcgX(b, a)
        var px = hx; var py = hy
        for (h in intArrayOf(c1, c2, c3)) {
            val qx = snap(hx + range16(h, 2 * rr + 1) - rr); val qy = snap(hy + range16(h ushr 16, 2 * rr + 1) - rr)
            val ok = walkableFor(sp.sh.water, env.classAt(Math.floor(qx / art).toInt(), Math.floor(qy / art).toInt())) &&
                segmentWalkable(sp.sh.water, env, px, py, qx, qy) && segmentWalkable(sp.sh.water, env, qx, qy, hx, hy)
            if (ok) { px = qx; py = qy }
            pts += PathPoint(px, py)
        }
        pts += PathPoint(hx, hy)
        return HerdMemberR(m, sp.id, site.species, pts, sp.sh.speed, sp.sh.dwellMs, (b ushr 8) and 0xffff)
    }
    fun siteKept(h2: Int, keep: Double): Boolean = (h2 and 0xffff) < keep * 65536
    fun memberPose(mb: HerdMemberR, ms: Double, rm: Boolean): Pose = pathPose(mb.points, mb.speed, mb.dwellMs, JsMath.u32(JsMath.toInt32(ms + mb.phase)), rm)

    // ---------------------------------------------------------------- birds

    fun skyScale(d: Double, trueFull: Double): Double = Math.min(3.0, Math.max(1.0, trueFull / Math.max(1.0, d)))
    fun flockSite(b: CBirds, ix: Int, iy: Int, env: LifeEnv): FlockR? {
        if (b.species.isEmpty()) return null
        val h0 = pcgX(ix xor b.salt, iy xor (b.salt * 7)); val h1 = pcgY(ix xor b.salt, iy xor (b.salt * 7)); val h2 = kitHash(ix xor b.salt, iy)
        if ((h1 and 0xffff) >= b.p16) return null
        val sx = cellSeatX(b.pitchArt, b.jitterArt, ix, h0); val sy = cellSeatY(b.pitchArt, b.jitterArt, iy, h0)
        var s = -1; for (i in b.species.indices) if ((h1 ushr 16) < b.species[i].cum) { s = i; break }
        if (s < 0) return null
        val sp = b.species[s]
        if (sp.on != 0 && ((sp.on ushr env.classAt(Math.floorDiv(sx, art), Math.floorDiv(sy, art))) and 1) == 0) return null
        val n = sp.fMin + range16(h2 ushr 16, sp.fMax - sp.fMin + 1)
        val radius = (6 + range16((h0 xor h2) ushr 16, 7)) * art
        return FlockR(ix, iy, sx, sy, s, sp.id, n, radius, if (((h2 ushr 20) and 1) != 0) 1 else -1, h2, (h0 xor h2) and 0xffff)
    }
    fun birdPose(b: CBirds, f: FlockR, m: Int, ms: Double): BirdPoseR {
        val sp = b.species[f.species]
        val w = sp.speed / f.radius * f.dir
        val periodMs = Math.floor(2 * Math.PI * f.radius / sp.speed * 1000 + 0.5)
        val th = (f.h2 and 0xffff) / 65536.0 * 2 * Math.PI + w * (ms % periodMs) / 1000 - m * 0.22 * f.dir
        val rr = f.radius * (1 - 0.06 * m)
        val x = f.x + JsMath.cos(th) * rr; val y = f.y + JsMath.sin(th) * rr * 0.62
        val vx = -JsMath.sin(th) * w
        val frame = ((Math.floor(ms / sp.sp.frameMs) + m) % sp.sp.frames).toInt()
        return BirdPoseR(x, y, sp.alt + 10 * m, if (vx < 0) 1 else 0, frame)
    }

    // ---------------------------------------------------------------- ambience

    fun ambienceInk(a: CAmbience, snapD: Double): Int {
        val ink = a.sp.inkH
        if (ink < c.minSpritePx) return Math.floor(c.minSpritePx * deedArt.toDouble() / Math.max(a.minD ?: 0.0, snapD)).toInt()
        val minD = a.minD
        return if (minD != null && minD != 0.0) Math.min(ink.toDouble(), Math.floor(c.minSpritePx * deedArt.toDouble() / minD)).toInt() else ink
    }
    fun nearLand(env: LifeEnv, tx: Int, ty: Int): Boolean {
        if (((landy ushr env.classAt(tx + 2, ty)) and 1) != 0) return true
        if (((landy ushr env.classAt(tx - 2, ty)) and 1) != 0) return true
        if (((landy ushr env.classAt(tx, ty + 2)) and 1) != 0) return true
        return ((landy ushr env.classAt(tx, ty - 2)) and 1) != 0
    }
    fun particle(a: CAmbience, ix: Int, iy: Int, ms: Double, env: LifeEnv, wind: DoubleArray): ParticleR? {
        val h0 = pcgX(ix xor a.salt, iy xor (a.salt * 7)); val h1 = pcgY(ix xor a.salt, iy xor (a.salt * 7)); val h2 = kitHash(ix xor a.salt, iy)
        val sx = cellSeatX(a.pitchArt, a.jitterArt, ix, h0); val sy = cellSeatY(a.pitchArt, a.jitterArt, iy, h0)
        val cls = env.classAt(Math.floorDiv(sx, art), Math.floorDiv(sy, art))
        if ((h1 and 0xffff) >= a.density[cls]) return null
        if (a.kind == "spray" && !nearLand(env, Math.floorDiv(sx, art), Math.floorDiv(sy, art))) return null
        val life = a.lifeMs
        val t = JsMath.u32(JsMath.toInt32(ms + range16(h2, life))) % life; val u = t / life
        val drift = if (a.kind == "spray") 0.0 else t / 1000
        val k = a.windK ?: 1.0
        val x = sx + wind[0] * drift * k; val y = sy + wind[1] * drift * k
        val alt = when (a.kind) {
            "fall" -> if (a.rise) (a.alt ?: Double.NaN) * u else (a.alt ?: Double.NaN) * (1 - u)
            "spray" -> 0.0
            else -> a.alt ?: 0.0
        }
        val frame = ((Math.floor(ms / a.sp.frameMs) + (h1 ushr 16)) % a.sp.frames).toInt()
        val fade = Math.min(1.0, Math.min(u / 0.15, (1 - u) / 0.15))
        return ParticleR(x, y, alt, frame, fade, (h2 ushr 20) and 1)
    }

    // ---------------------------------------------------------------- stands

    fun standSite(st: CStands, ix: Int, iy: Int, env: LifeEnv): StandSiteR? {
        val h0 = pcgX(ix xor st.salt, iy xor (st.salt * 7)); val h1 = pcgY(ix xor st.salt, iy xor (st.salt * 7)); val h2 = kitHash(ix xor st.salt, iy)
        val sx = cellSeatX(st.pitchArt, st.jitterArt, ix, h0); val sy = cellSeatY(st.pitchArt, st.jitterArt, iy, h0)
        val tx = sx shr 5; val ty = sy shr 5 // scatter.js: `seat.x >> 5` (32 art px per tile)
        val cls = env.classAt(tx, ty)
        val e0 = pcgX(h0, h1); val nV = st.variants.size
        var v = range16(h1 ushr 16, nV)
        if (st.mixes[st.variants[v].mix].density[cls] == 0) v = range16(e0 and 0xffff, nV)
        if (st.mixes[st.variants[v].mix].density[cls] == 0) v = range16(e0 ushr 16, nV)
        val vv = st.variants[v]; val mix = st.mixes[vv.mix]; val p = mix.density[cls]
        if (p == 0) return null
        val sdf = env.plotSdf(sx.toDouble() / art, sy.toDouble() / art)
        val ew = edgeWeight(sdf, c.plotClear + vv.r4 / 4.0)
        if (ew < 0) return null
        var q = if (mix.mapOnly) p else ((p.toLong() * coverOf(standField(mix.field.salt, sx, sy), mix.field.lo, mix.field.k)) ushr 8).toInt()
        val qe = ((p.toLong() * ew) ushr 8).toInt(); if (qe > q) q = qe
        if ((h1 and 0xffff) >= q) return null
        val r = (vv.r4 + 3) shr 2; val dd = (r * 181) shr 8
        val ox = intArrayOf(r, -r, 0, 0, dd, -dd, dd, -dd); val oy = intArrayOf(0, 0, r, -r, dd, dd, -dd, -dd)
        for (i in 0 until 8) if (mix.density[env.classAt(tx + ox[i], ty + oy[i])] == 0) return null
        return StandSiteR(ix, iy, sx, sy, cls, v, vv.mix, (h2 ushr 16) and 1, h2, sdf, cellRank(st.salt, ix, iy))
    }
    fun standMember(st: CStands, site: StandSiteR, m: Int, env: LifeEnv): StandMemberR? {
        val vv = st.variants[site.v]
        if (m >= vv.members.size || st.mixes[vv.mix].mapOnly) return null
        val mm = vv.members[m]; val x = site.x + (if (site.flip != 0) -mm.dx else mm.dx); val y = site.y + mm.dy
        if (st.mixes[vv.mix].density[env.classAt(x shr 5, y shr 5)] == 0) return null
        if (env.plotSdf(x.toDouble() / art, y.toDouble() / art) < c.plotClear + 1) return null
        return StandMemberR(x, y, mm.s, st.species[mm.s].id, site.flip xor mm.flip)
    }
    fun standSwayArt(h2: Int, m: Int, ms: Double, d: Double, rm: Boolean, swayD: Double): Int {
        val ph = (h2 ushr 17) xor (m * 977)
        return swayArt((ph and 0xffff) shl 16, ph and 0x7fff, ms, d, rm, swayD)
    }
    fun splitWeight(d: Double): Double = JsMath.clamp((d - c.stand.splitFrom) / (c.stand.splitFull - c.stand.splitFrom), 0.0, 1.0)
    private fun ownClump(vv: CVariant, h2: Int, d: Double): Boolean = vv.inkH * d >= c.minSpritePx * deedArt.toDouble() && dissolve(h2 ushr 16, splitWeight(d))
    fun standLod(st: CStands, v: Int, h2: Int, rank: Int, d: Double, wTrue: Double, keep: Double = 1.0): String {
        val vv = st.variants[v]
        if (rank >= rankBound(keep)) return "none"
        if (rank < rankBound(wTrue * keep)) return if (st.mixes[vv.mix].mapOnly) "none" else "true"
        return if (ownClump(vv, h2, d)) "clump" else "none"
    }
    fun mergedSite(st: CStands, bx: Int, by: Int, env: LifeEnv): StandSiteR? {
        for (k in 0 until 4) {
            val site = standSite(st, 2 * bx + (k and 1), 2 * by + (k shr 1), env) ?: continue
            val vv = st.variants[site.v]; val mix = st.mixes[vv.mix]; val r2 = ((vv.r4 + 3) shr 2) * c.stand.merge
            if (site.sdf < c.plotClear + r2) continue
            val tx = site.x shr 5; val ty = site.y shr 5
            if (mix.density[env.classAt(tx + r2, ty)] == 0 || mix.density[env.classAt(tx - r2, ty)] == 0 ||
                mix.density[env.classAt(tx, ty + r2)] == 0 || mix.density[env.classAt(tx, ty - r2)] == 0) continue
            return site
        }
        return null
    }
    fun mergedLod(st: CStands, v: Int, h2: Int, d: Double): String {
        val vv = st.variants[v]
        if (d < c.stand.mergeFrom || d >= st.mergeUntil || vv.inkH.toDouble() * c.stand.merge * d < c.minSpritePx * deedArt.toDouble()) return "none"
        return if (ownClump(vv, h2, d)) "none" else "merged"
    }
    fun keepFraction(cap: Double, expected: Double): Double = if (expected <= cap) 1.0 else cap / expected
    fun thinFactor(pos: Int, n: Int, f: Double): Double {
        val k = if (n > 1) 1 + (c.thinSpread - 1) * (n - 1 - pos) / (n - 1) else 1.0
        return JsMath.pow(f, k)
    }
}
