package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue

/**
 * The LIFE lane's presentation tables (web `scatter.js` LIFE_TABLES and constants, `life.js` layer sizes), generated
 * from the pinned web modules by `tools/world-lifebases.mjs` into `life-tables.json` (a classpath resource next to this
 * class). Nothing here is typed by hand: every number is read from that file, whose pin and generator hash it carries.
 * Game numbers (art px per tile, tiles per deed) are NOT in it; [LifeGeometry] takes them from the constants catalogue.
 */
class LifeConstants(root: JsonValue) {
    val minSpritePx: Int = root.getInt("MIN_SPRITE_PX")
    val capSway: Int; val capProps: Int; val capCreatures: Int; val capBirds: Int; val capParticles: Int; val capHerds: Int; val capMapobj: Int
    val submittedPhone: Int; val submittedDesktop: Int
    val phoneCssMax: Int = root.getInt("PHONE_CSS_MAX")
    val thinMax: Int = root.getInt("THIN_MAX")
    val thinOrder: List<String> = root.get("THIN_ORDER").asStringArray().toList()
    val swayAmpArt: Int; val swayPeriodMinMs: Int; val swayPeriodMaxMs: Int
    val plotClear: Int = root.getInt("PLOT_CLEAR")
    val maxSpecies: Int = root.getInt("MAX_SPECIES")
    val facings: List<String> = root.get("FACINGS").asStringArray().toList()
    val herdMax: Int = root.getInt("HERD_MAX")
    val loopRadiusTiles: Int = root.getInt("LOOP_RADIUS_TILES")
    val waypointSnap: Int = root.getInt("WAYPOINT_SNAP")
    val flockMax: Int = root.getInt("FLOCK_MAX")
    val rankN: Int = root.getInt("RANK_N")
    val stand: StandRules
    val thinSpread: Double = root.getDouble("THIN_SPREAD")
    val thinEps: Double = root.getDouble("THIN_EPS")
    /** Map-object role → class names (scatter.js MAPOBJ_ROLES), in the web's order. */
    val mapobjRoles: LinkedHashMap<String, List<String>> = LinkedHashMap()
    val standMargin: Int = root.getInt("STAND_MARGIN")
    /** contracts.js CLASS: name → id, and id → name. */
    val classIds: LinkedHashMap<String, Int> = LinkedHashMap()
    val classNames: Array<String>
    /** contracts.js geometry at the pin (ART, TILES, DEED_ART, CELL, MAP_ART): a catalogue that disagrees is refused. */
    val pinnedArt: Int; val pinnedTiles: Int; val pinnedDeedArt: Int; val pinnedCell: Int; val pinnedMapArt: Int
    /** life.js layer size classes [w, h] (sprites and the air array) and twin classes; the array index no draw binds. */
    val sizeClasses: Array<IntArray>; val twinClasses: Array<IntArray>
    val noArray: Int = root.getInt("NO_ARRAY")
    val maxLayers: Int = root.getInt("MAX_LAYERS")
    val spt: Int = root.getInt("SPT")
    val puffs: Int = root.getInt("PUFFS")
    val puffLifeMs: Int = root.getInt("PUFF_LIFE_MS")
    /** scatter.js GLOW (stage B): a map object's pulsing lens glow — halo radius (map px), period, strength lo and at rest. */
    val glow: GlowRules = GlowRules(root.get("GLOW"))

    init {
        val caps = root.get("LIFE_CAPS")
        capSway = caps.getInt("sway"); capProps = caps.getInt("props"); capCreatures = caps.getInt("creatures"); capBirds = caps.getInt("birds")
        capParticles = caps.getInt("particles"); capHerds = caps.getInt("herds"); capMapobj = caps.getInt("mapobj")
        submittedPhone = caps.get("submitted").getInt("phone"); submittedDesktop = caps.get("submitted").getInt("desktop")
        val sway = root.get("SWAY")
        swayAmpArt = sway.getInt("ampArt"); swayPeriodMinMs = sway.getInt("periodMinMs"); swayPeriodMaxMs = sway.getInt("periodMaxMs")
        stand = StandRules(root.get("STAND"))
        var r = root.get("MAPOBJ_ROLES").child
        while (r != null) { mapobjRoles[r.name] = r.asStringArray().toList(); r = r.next }
        var c = root.get("CLASS").child
        while (c != null) { classIds[c.name] = c.asInt(); c = c.next }
        classNames = Array(classIds.size) { i -> classIds.entries.first { it.value == i }.key }
        val g = root.get("pinnedGeometry")
        pinnedArt = g.getInt("ART"); pinnedTiles = g.getInt("TILES"); pinnedDeedArt = g.getInt("DEED_ART"); pinnedCell = g.getInt("CELL"); pinnedMapArt = g.getInt("MAP_ART")
        sizeClasses = pairs(root.get("SIZE_CLASSES")); twinClasses = pairs(root.get("TWIN_CLASSES"))
    }

    val classCount: Int get() = classNames.size
    fun classId(name: String): Int = classIds[name] ?: throw IllegalArgumentException("unknown class $name")
    /** scatter.js `classMask(names)`. */
    fun classMask(names: List<String>?): Int { var m = 0; if (names != null) for (n in names) m = m or (1 shl classId(n)); return m }

    private fun pairs(v: JsonValue): Array<IntArray> { val out = ArrayList<IntArray>(); var e = v.child; while (e != null) { out += e.asIntArray(); e = e.next }; return out.toTypedArray() }
}

/** scatter.js STAND. */
class StandRules(v: JsonValue) {
    val pitch: Int = v.getInt("pitch")
    val jitter: Double = v.getDouble("jitter")
    val members: Int = v.getInt("members")
    val edgeFlat: Int = v.getInt("edgeFlat")
    val edgeTiles: Int = v.getInt("edgeTiles")
    val mergeFrom: Double = v.getDouble("mergeFrom")
    val mergeCap: Double = v.getDouble("mergeCap")
    val splitFrom: Double = v.getDouble("splitFrom")
    val splitFull: Double = v.getDouble("splitFull")
    val merge: Int = v.getInt("merge")
}

/** scatter.js GLOW. */
class GlowRules(v: JsonValue) {
    val radiusMap: Int = v.getInt("radiusMap")
    val periodMs: Int = v.getInt("periodMs")
    val lo: Double = v.getDouble("lo")
    val rest: Double = v.getDouble("rest")
}

/**
 * A table's `mapobjs` entry (scatter.js `lifeTable`, stage B): a map object's species weight and coast flag, by object id
 * or by role. The web reads `typeof o === 'number' ? o : o?.w ?? 1` and `o?.coast` (truthy), so a bare number is a weight
 * with no coast rule, and an object without `w` weighs 1.
 */
class MapObjWeight(val w: Double, val coast: Boolean) {
    companion object {
        /** Null for an absent or JSON-null entry (the web's `??` falls through to the role's entry). */
        fun of(v: JsonValue?): MapObjWeight? {
            if (v == null || v.isNull) return null
            if (v.isNumber) return MapObjWeight(v.asDouble(), false)
            if (!v.isObject) return MapObjWeight(1.0, false) // a string, array or boolean: `o.w` and `o.coast` are undefined
            val w = v.get("w")
            require(w == null || w.isNull || w.isNumber) { "mapobjs weight ${v.name}.w is not a number: the web would sum it as text" }
            return MapObjWeight(if (w == null || w.isNull) 1.0 else w.asDouble(), truthy(v.get("coast")))
        }
        /** JavaScript truthiness of a JSON value (`!!x`). */
        fun truthy(v: JsonValue?): Boolean = when {
            v == null || v.isNull -> false
            v.isBoolean -> v.asBoolean()
            v.isNumber -> v.asDouble().let { it != 0.0 && !it.isNaN() }
            v.isString -> v.asString().isNotEmpty()
            else -> true // objects and arrays
        }
    }
}

/** Game geometry from the constants catalogue: art px per tile (GRID.tilePx) and tiles per deed (worldTiles). */
class LifeGeometry(val art: Int, val tilesPerDeed: Int, val mapArt: Int) {
    val deedArt: Int get() = art * tilesPerDeed
}

// ---- the raw table rows (scatter.js LIFE_TABLES shapes) --------------------------------------------------------------

class EmitRow(val fx: String, val dx: Double, val dy: Double, val rise: Double, val puffs: Double)
/** [glow]: a map object's lens anchor [x, y] in its map canvas (scatter.js `opt.glow`, stage B), null for none. */
class SpeciesRow(val id: String, val w: Double, val on: List<String>?, val coast: Boolean, val emit: EmitRow?, val glow: DoubleArray? = null)
class ModRow(val field: String, val out: Double, val inn: Double, val edge: Double?)
class GroupRow(
    val id: String, val kind: String, val pitch: Double, val density: LinkedHashMap<String, Double>, val species: List<SpeciesRow>,
    val jitter: Double?, val twin: Boolean, val sway: Boolean, val mapOnly: Boolean, val mod: ModRow?, val cluster: Double?,
)
class MixRow(
    val id: String, val field: String?, val variants: Int?, val r: DoubleArray?, val spacing: Double?, val cluster: Double?, val sway: Boolean,
    val mapOnly: Boolean, val density: LinkedHashMap<String, Double>, val species: List<Pair<String, Double>>,
)
class CreatureRow(val id: String, val w: Double, val herdMin: Int, val herdMax: Int, val on: List<String>?)
class CreatureTable(val pitch: Double, val density: LinkedHashMap<String, Double>, val species: List<CreatureRow>)
class BirdRow(val id: String, val w: Double, val fMin: Int, val fMax: Int, val on: List<String>?, val speed: Double?, val alt: Double?)
class BirdTable(val pitch: Double, val p: Double, val species: List<BirdRow>)
class AmbienceRow(
    val id: String, val shared: Boolean, val kind: String, val pitch: Double, val minD: Double?, val density: LinkedHashMap<String, Double>,
    val lifeMs: Int, val alt: Double?, val windK: Double?, val rise: Boolean,
)
/**
 * [mapobjs]: map-object weights by object id or role (stage B, scatter.js `lifeTable`); [glow]: lens anchors by map-object id
 * (stage B, Solana Reach's beacons). Both empty in a table that has none.
 */
class LifeTable(
    val wind: DoubleArray, val fieldVeg: DoubleArray?, val fieldRock: DoubleArray?, val mixes: List<MixRow>?,
    val groups: List<GroupRow>, val creatures: CreatureTable?, val birds: BirdTable?, val ambience: List<AmbienceRow>,
    val mapobjs: Map<String, MapObjWeight> = emptyMap(), val glow: Map<String, DoubleArray> = emptyMap(),
) {
    fun withGroups(g: List<GroupRow>) = LifeTable(wind, fieldVeg, fieldRock, mixes, g, creatures, birds, ambience, mapobjs, glow)
    fun withMixes(m: List<MixRow>?) = LifeTable(wind, fieldVeg, fieldRock, m, groups, creatures, birds, ambience, mapobjs, glow)
}

/** The whole `life-tables.json`: constants and every realm's table (web insertion order kept). */
class LifeTablesFile(val pin: String, val generator: String, val constants: LifeConstants, val tables: LinkedHashMap<String, LifeTable>) {
    companion object {
        const val RESOURCE = "life-tables.json"

        /** Parse the bundled resource. Reads the classpath (the APK): call it on a worker, never inside a frame. */
        fun load(): LifeTablesFile {
            val stream = LifeTablesFile::class.java.getResourceAsStream(RESOURCE) ?: throw IllegalStateException("$RESOURCE is not on the classpath")
            return parse(stream.use { String(it.readBytes(), Charsets.UTF_8) })
        }

        fun parse(json: String): LifeTablesFile {
            val root = JsonReader().parse(json)
            require(root.getString("kind", null) == "pkw-life-tables") { "not a life-tables file" }
            val tables = LinkedHashMap<String, LifeTable>()
            var t = root.get("tables").child
            while (t != null) { tables[t.name] = table(t); t = t.next }
            return LifeTablesFile(root.getString("pin"), root.getString("generator"), LifeConstants(root.get("constants")), tables)
        }

        fun table(v: JsonValue): LifeTable {
            val f = v.get("fields")
            return LifeTable(
                v.get("wind")?.asDoubleArray() ?: doubleArrayOf(0.0, 0.0),
                f?.get("veg")?.asDoubleArray(), f?.get("rock")?.asDoubleArray(),
                v.get("stands")?.get("mixes")?.let { list(it, ::mix) },
                list(v.get("groups"), ::group),
                v.get("creatures")?.let(::creatures), v.get("birds")?.let(::birds),
                v.get("ambience")?.let { list(it, ::ambience) } ?: emptyList(),
                mapobjs(v.get("mapobjs")), glowAnchors(v.get("glow")),
            )
        }

        /** A table's `mapobjs` (object id or role → weight, or { w, coast }), in the table's order. */
        private fun mapobjs(v: JsonValue?): Map<String, MapObjWeight> {
            val out = LinkedHashMap<String, MapObjWeight>()
            var e = v?.child
            while (e != null) { MapObjWeight.of(e)?.let { out[e.name] = it }; e = e.next }
            return out
        }
        /** A table's `glow` (map-object id → [x, y] in its map canvas). The web applies an entry when it is truthy (any array). */
        private fun glowAnchors(v: JsonValue?): Map<String, DoubleArray> {
            val out = LinkedHashMap<String, DoubleArray>()
            var e = v?.child
            while (e != null) { if (MapObjWeight.truthy(e)) out[e.name] = anchor(e); e = e.next }
            return out
        }
        /** A glow anchor as the packer reads it: a missing or non-numeric coordinate is NaN (`undefined + ox`), which the
         *  table write stores as 0 on both clients. */
        private fun anchor(v: JsonValue): DoubleArray =
            if (!v.isArray) doubleArrayOf(Double.NaN, Double.NaN) else DoubleArray(2) { i -> v.get(i)?.takeIf { it.isNumber }?.asDouble() ?: Double.NaN }

        fun density(v: JsonValue?): LinkedHashMap<String, Double> {
            val out = LinkedHashMap<String, Double>()
            var e = v?.child
            while (e != null) { out[e.name] = e.asDouble(); e = e.next }
            return out
        }
        private fun strings(v: JsonValue?): List<String>? = if (v == null || v.isNull) null else v.asStringArray().toList()
        private fun <T> list(v: JsonValue?, f: (JsonValue) -> T): List<T> { val out = ArrayList<T>(); var e = v?.child; while (e != null) { out += f(e); e = e.next }; return out }
        private fun optD(v: JsonValue, name: String): Double? = v.get(name)?.takeIf { !it.isNull }?.asDouble()

        private fun species(v: JsonValue): SpeciesRow {
            val id = v.get(0).asString(); val w = v.get(1).asDouble(); val opt = if (v.size > 2) v.get(2) else null
            val emit = opt?.get("emit")?.let { EmitRow(it.getString("fx"), it.getDouble("dx", 0.0), it.getDouble("dy", 0.0), it.getDouble("rise", 0.0), it.getDouble("puffs", 0.0)) }
            val glow = opt?.get("glow")?.takeIf { MapObjWeight.truthy(it) }?.let(::anchor)
            return SpeciesRow(id, w, strings(opt?.get("on")), opt?.getBoolean("coast", false) ?: false, emit, glow)
        }
        private fun group(v: JsonValue): GroupRow = GroupRow(
            v.getString("id"), v.getString("kind"), v.getDouble("pitch"), density(v.get("density")), list(v.get("species"), ::species),
            optD(v, "jitter"), v.getBoolean("twin", false), v.getBoolean("sway", false), v.getBoolean("mapOnly", false),
            v.get("mod")?.let { ModRow(it.getString("field", "veg"), it.getDouble("out"), it.getDouble("in"), optD(it, "edge")) }, optD(v, "cluster"),
        )
        private fun mix(v: JsonValue): MixRow = MixRow(
            v.getString("id"), v.getString("field", null), v.get("variants")?.asInt(), v.get("R")?.asDoubleArray(), optD(v, "spacing"), optD(v, "cluster"),
            v.getBoolean("sway", false), v.getBoolean("mapOnly", false), density(v.get("density")),
            list(v.get("species")) { it.get(0).asString() to it.get(1).asDouble() },
        )
        private fun creatures(v: JsonValue) = CreatureTable(v.getDouble("pitch"), density(v.get("density")), list(v.get("species")) {
            val herd = it.get(2).asIntArray()
            CreatureRow(it.get(0).asString(), it.get(1).asDouble(), herd[0], herd[1], strings(it.get(3)))
        })
        private fun birds(v: JsonValue) = BirdTable(v.getDouble("pitch"), v.getDouble("p"), list(v.get("species")) {
            val flock = it.get(2).asIntArray(); val opt = if (it.size > 4) it.get(4) else null
            BirdRow(it.get(0).asString(), it.get(1).asDouble(), flock[0], flock[1], strings(it.get(3)), opt?.let { o -> optD(o, "speed") }, opt?.let { o -> optD(o, "alt") })
        })
        private fun ambience(v: JsonValue) = AmbienceRow(
            v.getString("id"), v.getBoolean("shared", false), v.getString("kind"), v.getDouble("pitch"), optD(v, "minD"), density(v.get("density")),
            v.getInt("lifeMs"), optD(v, "alt"), optD(v, "windK"), v.getBoolean("rise", false),
        )
    }
}
