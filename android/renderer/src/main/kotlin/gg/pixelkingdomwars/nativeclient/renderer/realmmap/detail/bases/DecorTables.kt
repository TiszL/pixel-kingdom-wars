package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue

/**
 * The BASES lane's presentation tables (web `decor.js`, `bases.js`, `demo-bases.js` and the contracts.js decor rules),
 * generated from the pinned web modules by `tools/world-lifebases.mjs` into `decor-tables.json` (a classpath resource
 * next to this class; key order = the web's insertion order). Nothing here is typed by hand. Game numbers are NOT in it:
 * [DecorGame] reads them from the constants catalogue.
 */
class DecorTables(root: JsonValue) {
    val pin: String = root.getString("pin")
    val generator: String = root.getString("generator")

    // ---- decor.js
    val layout: DecorLayout
    /** decor.js GAME_ART: key → [cellW, cellH, anchorX, inkX0, inkY0, inkX1, inkY1, frames, fps, rows]. */
    val gameArt = HashMap<String, IntArray>()
    /** decor.js KIT_ART (with ART_KIT merged): realm → id → [cellW, cellH, inkX0, inkY0, inkX1, inkY1, fpW, fpH, frames, ms]. */
    val kitArt = HashMap<String, HashMap<String, IntArray>>()
    val wallCellH: IntArray
    val fireCell: IntArray; val fireInk: IntArray; val fireFrames: Int; val fireMs: Int
    /** KEEP_TIPS[L−1][i] = [x, y] (cell px). */
    val keepTips: Array<Array<IntArray>>
    /** KIT_DRESSING: realm → role → candidates (array roles) or a named piece map (bridge, pen, edge). */
    val dressing = LinkedHashMap<String, LinkedHashMap<String, Dress>>()
    val flatCrops: Set<String>
    val decals: Set<String>
    val edgeArms: List<String>
    val gateSides: List<String>
    val paths: PathRules
    val pathTerrain: PathTerrain
    val poleRoles: Set<String>
    val runtime = HashMap<String, String>()
    val wallShapeByMask: List<String>
    val decorCap = HashMap<String, Int>()
    val buildKey = HashMap<String, String>()
    val keepFit: KeepFit
    val realmsWithMaps: List<String>

    // ---- bases.js
    val mapPxPerTile: Double
    val sizeClasses: Array<IntArray>
    val maxLayers: Int
    val mini: Int
    val speckRoles: Set<String>
    val shieldMapCap: Int; val shieldTrueCap: Int
    val heraldic: Array<DoubleArray>
    val gold: DoubleArray
    val iconTowers: List<String>
    val accent = HashMap<String, String>()
    /** bases.js BASES_GL: kind → (program, depth test, depth write, blend null|over|add), in the web's order. */
    val basesGl = LinkedHashMap<String, GlState>()
    val rehearsal: BasesRehearsal
    val workMs: Double; val minPx: Double
    /** bases.js `ICON_CENTRE_D` = [150, BANDS.impostor[0]] (stage B, 090b3428): the MAP marker icon is centred on its plot up
     *  to d [0] and stands on the keep seat from d [1] ([BasesRules.iconAnchorY]). */
    val iconCentreD: DoubleArray

    // ---- demo-bases.js
    val demo: DemoRules
    val syllables: List<String>
    val clans: List<String>

    init {
        val d = root.get("decor")
        layout = DecorLayout(d.get("DECOR_LAYOUT"))
        each(d.get("GAME_ART")) { gameArt[it.name] = it.asIntArray() }
        each(d.get("KIT_ART")) { r -> val m = HashMap<String, IntArray>(); each(r) { m[it.name] = it.asIntArray() }; kitArt[r.name] = m }
        wallCellH = d.get("WALL_CELL_H").asIntArray()
        val fire = d.get("FIRE"); fireCell = fire.get("cell").asIntArray(); fireInk = fire.get("ink").asIntArray(); fireFrames = fire.getInt("frames"); fireMs = fire.getInt("ms")
        keepTips = list(d.get("KEEP_TIPS")) { lv -> list(lv) { it.asIntArray() }.toTypedArray() }.toTypedArray()
        each(d.get("KIT_DRESSING")) { r ->
            val roles = LinkedHashMap<String, Dress>()
            each(r) { role -> roles[role.name] = if (role.isArray) Dress(role.asStringArray().toList(), null) else Dress(null, LinkedHashMap<String, String>().also { m -> each(role) { m[it.name] = it.asString() } }) }
            dressing[r.name] = roles
        }
        flatCrops = d.get("FLAT_CROPS").asStringArray().toHashSet()
        decals = d.get("DECALS").asStringArray().toHashSet()
        edgeArms = d.get("EDGE_ARMS").asStringArray().toList()
        gateSides = d.get("GATE_SIDES").asStringArray().toList()
        paths = PathRules(d.get("PATHS")); pathTerrain = PathTerrain(d.get("PATH_TERRAIN"))
        poleRoles = d.get("POLE_ROLES").asStringArray().toHashSet()
        each(d.get("RUNTIME")) { runtime[it.name] = it.asString() }
        wallShapeByMask = d.get("WALL_SHAPE_BY_MASK").asStringArray().toList()
        each(d.get("DECOR_CAP")) { decorCap[it.name] = it.asInt() }
        each(d.get("BUILD_KEY")) { buildKey[it.name] = it.asString() }
        keepFit = KeepFit(d.get("KEEP_FIT"))
        realmsWithMaps = d.get("REALMS_WITH_MAPS").asStringArray().toList()

        val b = root.get("bases")
        mapPxPerTile = b.getDouble("MAP_PX_PER_TILE")
        sizeClasses = list(b.get("CLASSES")) { it.asIntArray() }.toTypedArray()
        maxLayers = b.getInt("MAX_LAYERS"); mini = b.getInt("MINI")
        speckRoles = b.get("SPECK_ROLES").asStringArray().toHashSet()
        shieldMapCap = b.get("SHIELD").getInt("mapCap"); shieldTrueCap = b.get("SHIELD").getInt("trueCap")
        heraldic = list(b.get("HERALDIC")) { it.asDoubleArray() }.toTypedArray()
        gold = b.get("GOLD").asDoubleArray()
        iconTowers = b.get("ICON_TOWERS").asStringArray().toList()
        each(b.get("ACCENT")) { accent[it.name] = it.asString() }
        each(b.get("BASES_GL")) { basesGl[it.name] = GlState(it.getString(0), it.getBoolean(1), it.getBoolean(2), it.get(3).takeIf { v -> !v.isNull }?.asString()) }
        rehearsal = BasesRehearsal(b.get("REHEARSAL"))
        workMs = b.get("BASES_LIMITS").getDouble("workMs"); minPx = b.get("BASES_LIMITS").getDouble("minPx")
        iconCentreD = b.get("ICON_CENTRE_D").asDoubleArray()

        val dm = root.get("demo")
        demo = DemoRules(dm.get("DEMO"))
        syllables = dm.get("SYL").asStringArray().toList()
        clans = dm.get("CLANS").asStringArray().toList()
    }

    /**
     * bases.js `smokeIdOf(realm)` = `KIT_DRESSING[realm]?.smoke?.[0] ?? 'smoke_drift'` (stage B, aff798ad): the kit sprite a
     * realm's chimneys breathe. Solana Reach's kit has no smoke_drift; its dressing names vapour_drift instead.
     */
    fun smokeIdOf(realmId: String): String = dressing[realmId]?.get("smoke")?.list?.firstOrNull() ?: "smoke_drift"

    companion object {
        const val RESOURCE = "decor-tables.json"

        /** Parse the bundled resource. Reads the classpath (the APK): call it on a worker, never inside a frame. */
        fun load(): DecorTables {
            val s = DecorTables::class.java.getResourceAsStream(RESOURCE) ?: throw IllegalStateException("$RESOURCE is not on the classpath")
            return parse(s.use { String(it.readBytes(), Charsets.UTF_8) })
        }
        fun parse(json: String): DecorTables {
            val root = JsonReader().parse(json)
            require(root.getString("kind", null) == "pkw-decor-tables") { "not a decor-tables file" }
            return DecorTables(root)
        }
        internal inline fun each(v: JsonValue?, f: (JsonValue) -> Unit) { var c = v?.child; while (c != null) { f(c); c = c.next } }
        internal fun <T> list(v: JsonValue?, f: (JsonValue) -> T): List<T> { val out = ArrayList<T>(); each(v) { out.add(f(it)) }; return out }
    }
}

/** A KIT_DRESSING role: candidates in preference order, or named pieces (bridge ew/ns, pen/edge ew/ns/post/gate). */
class Dress(val list: List<String>?, val pieces: Map<String, String>?)
/** One BASES_GL entry. */
class GlState(val program: String, val depthTest: Boolean, val depthWrite: Boolean, val blend: String?)

class DecorLayout(v: JsonValue) {
    val heroScale = v.getDouble("heroScale"); val poleSky = v.getDouble("poleSky")
    val hayFrom = v.getInt("hayFrom"); val wellFrom = v.getInt("wellFrom"); val hiveFrom = v.getInt("hiveFrom"); val penFrom = v.getInt("penFrom")
    val orchardFrom = v.getInt("orchardFrom"); val orchard2From = v.getInt("orchard2From"); val farmFrom = v.getInt("farmFrom"); val farm2From = v.getInt("farm2From")
    val tentFrom = v.getInt("tentFrom"); val smokeByBand: IntArray = v.get("smokeByBand").asIntArray()
    val hedgeFrom = v.getInt("hedgeFrom"); val hedgeAllFrom = v.getInt("hedgeAllFrom"); val fieldPropFrom = v.getInt("fieldPropFrom")
    val wildBase = v.get("wild").getDouble("base"); val wildEdge = v.get("wild").getDouble("edge"); val wildSegment = v.get("wild").getDouble("segment")
    val fallow = v.getDouble("fallow")
    val cropPairs = HashMap<String, String>().also { m -> DecorTables.each(v.get("cropPairs")) { m[it.name] = it.asString() } }
    /** soil[realm] = [field, pen, path] hex colours. */
    val soil = HashMap<String, Array<String>>().also { m -> DecorTables.each(v.get("soil")) { m[it.name] = arrayOf(it.getString("field"), it.getString("pen"), it.getString("path")) } }
    /** track[realm] = the terrain its lanes and paths are painted with when it is not the realm's ROAD terrain (stage B:
     *  Solana Reach's crystaldust worn track). */
    val track = HashMap<String, String>().also { m -> DecorTables.each(v.get("track")) { m[it.name] = it.asString() } }
    val glowR = v.get("glow").getDouble("r"); val glowA = v.get("glow").getDouble("a"); val glowFlicker = v.get("glow").getDouble("flicker")
}
class PathRules(v: JsonValue) {
    val maxDeeds = v.getDouble("maxDeeds"); val secondDeeds = v.getDouble("secondDeeds"); val stepTiles = v.getDouble("stepTiles")
    val clearTiles = v.getDouble("clearTiles"); val loneDeeds = v.getDouble("loneDeeds")
}
class PathTerrain(v: JsonValue) {
    val step = v.getDouble("step"); val maxBridge = v.getDouble("maxBridge"); val maxFord = v.getDouble("maxFord"); val approach = v.getDouble("approach"); val probe = v.getDouble("probe")
}
class KeepFit(v: JsonValue) {
    val maxScale = v.getDouble("maxScale")
    val clearBelow9 = v.get("clearTiles").getDouble("below9"); val clearCitadel = v.get("clearTiles").getDouble("citadel")
    val courtyard: IntArray = v.get("courtyard").asIntArray()
    val fitFromD = v.getDouble("fitFromD"); val trueAtD = v.getDouble("trueAtD")
}
/** bases.js REHEARSAL: the band rehearsal's own view UBO, one instance per program, 2×2 placeholder arrays. */
class BasesRehearsal(v: JsonValue) {
    val view: FloatArray = v.get("view").asFloatArray()
    val attribs = HashMap<String, Int>().also { m -> DecorTables.each(v.get("attribs")) { m[it.name] = it.asInt() } }
    val inst = HashMap<String, FloatArray>().also { m -> DecorTables.each(v.get("inst")) { m[it.name] = it.asFloatArray() } }
    val texW = v.get("tex").getInt("w"); val texH = v.get("tex").getInt("h"); val texLayers = v.get("tex").getInt("layers"); val texLevels = v.get("tex").getInt("levels")
}
/** demo-bases.js DEMO. */
class DemoRules(v: JsonValue) {
    val seed = v.getInt("seed"); val occupancy = v.getDouble("occupancy"); val hubs = v.getInt("hubs"); val levelSkew = v.getDouble("levelSkew")
    val shieldShare = v.getDouble("shieldShare"); val clanShare = v.getDouble("clanShare"); val myLevel = v.getInt("myLevel"); val attackRange = v.getInt("attackRange")
    val ladder: IntArray = v.get("ladder").asIntArray()
    val vacant = v.getDouble("vacant"); val localCap = v.getInt("localCap"); val nearCap = v.getInt("nearCap")
    /** realm → [x, y, level] of its river deed. */
    val moat = HashMap<String, IntArray>().also { m -> DecorTables.each(v.get("moat")) { m[it.name] = intArrayOf(it.getInt("x"), it.getInt("y"), it.getInt("level")) } }
}

/**
 * The game numbers decor reads (decor.js imports them from packages/shared), from the ACTIVE constants catalogue — never a
 * Kotlin copy (native CLAUDE.md). `wallCapForKeepLevel(L)` is `BUILD_COUNT_CAP_BY_KEEP.wall[L − 1]` (constants.ts).
 */
class DecorGame(
    val art: Int, val tilesPerDeed: Int, val claimTilesByKeep: IntArray, val wallRingsByKeep: IntArray, val outerWallInset: Int,
    val maxMinesByKeep: IntArray, val buildCaps: Map<String, IntArray>, val buildingSourceScale: Map<String, Double>,
    val footprints: Map<String, IntArray>, val sourceScale: Map<String, Double>, val offsetGamePxX: Map<String, Double>,
) {
    val keepFootprint: IntArray get() = footprints.getValue("keep")
    fun wallCap(level: Int): Int = buildCaps.getValue("wall")[level - 1]

    companion object {
        /** From `catalogue.json` `constants` (the host reads the active catalogue; tests read the app's copy). */
        fun fromCatalogue(c: JsonValue): DecorGame {
            val caps = HashMap<String, IntArray>(); DecorTables.each(c.get("BUILD_COUNT_CAP_BY_KEEP")) { caps[it.name] = it.asIntArray() }
            val src = HashMap<String, Double>(); DecorTables.each(c.get("ART_V2").get("buildingSourceScale")) { src[it.name] = it.asDouble() }
            val fp = HashMap<String, IntArray>()
            DecorTables.each(c.get("STRUCTURES")) { s -> s.get("footprint")?.let { fp[s.name] = it.asIntArray() } }
            DecorTables.each(c.get("DEFENSES")) { s -> s.get("footprint")?.let { fp[s.name] = it.asIntArray() } } // DEFENSES[u] ?? STRUCTURES[u]
            val scale = HashMap<String, Double>(); val off = HashMap<String, Double>()
            DecorTables.each(c.get("WARE_WORLD_PRESENTATION")) { w ->
                w.get("sourceScale")?.let { scale[w.name] = it.asDouble() }
                w.get("offsetGamePx")?.let { off[w.name] = it.get(0).asDouble() }
            }
            return DecorGame(c.get("GRID").getInt("tilePx"), c.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles"),
                c.get("CAMPAIGN").get("claimTilesByKeep").asIntArray(), c.get("CAMPAIGN_LAYOUT").get("wallRingsByKeep").asIntArray(),
                c.get("CAMPAIGN_LAYOUT").getInt("outerWallInset"), c.get("MINING").get("MAX_MINES_BY_KEEP").asIntArray(), caps, src, fp, scale, off)
        }
    }
}
