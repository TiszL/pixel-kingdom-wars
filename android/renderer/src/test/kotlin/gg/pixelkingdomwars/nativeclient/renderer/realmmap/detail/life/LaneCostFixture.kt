package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BasesBandsIn
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BasesCost
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.Decor
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorGame
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorTables
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit.children
import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRow

/**
 * LIFE and BASES PassCost lists for the whole-frame model (WorldFrameCostTest, the integrate step): the lanes' own
 * models ([LifeCost], [BasesCost]) on the pinned tables and the golden stubs of the pack's sprites (golden-compile.json:
 * the real pack's sprite sizes at its manifest), planned on a Seeker row's viewport. Test-side only.
 *
 * Assumptions (stated, since the device computes them from its loaded arrays): one texture array per size class, every
 * species of a twin group has a twin (MAP draws twins, not kit art: `kitMap` 0), every emitter group's fx exists (puffs
 * on with the air array), the realm's centre as the view (full lattice windows, no edge clipping).
 */
object LaneCostFixture {
    private val file = LifeTablesFile.load()
    private val c = file.constants
    private val cat = GoldenKit.catalogue()
    private val geo = LifeGeometry(cat.get("GRID").getInt("tilePx"), cat.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles"), c.pinnedMapArt)
    val scatter = Scatter(c, geo)
    val bands = LifeBandsIn.fromGenerated()
    private val compile = GoldenKit.json(LaneCostFixture::class.java, "golden-compile.json")
    private val plan = GoldenKit.json(LaneCostFixture::class.java, "golden-plan.json")
    /** The realms with LIFE tables at the pin (web insertion order). */
    val REALMS: List<String> = file.tables.keys.toList()

    private class Stubs(val sprites: Map<String, LifeSprite>, val creatures: Map<String, LifeSheet>) : LifeLookup {
        override fun sprite(id: String): LifeSprite? = sprites[id.replace('-', '_')]
        override fun creature(id: String): LifeSheet? = creatures[id.replace('-', '_')]
    }

    class RealmLife(val life: CLife, val planner: LifePlanner, val cost: LifeCost, val cols: Int, val rows: Int)
    private val cache = HashMap<String, RealmLife>()

    fun life(realm: String): RealmLife = cache.getOrPut(realm) {
        val r = compile.get("realms").get(realm) ?: error("no golden stubs for $realm")
        val st = r.get("stubs")
        val sp = LinkedHashMap<String, LifeSprite>()
        for (row in children(st.get("sprites"))) sp[row.getString(0)] = LifeSprite(row.getInt(1), row.getInt(2), row.getInt(3), row.getDouble(4), row.getDouble(5), row.getInt(6), row.getInt(7))
        val cr = LinkedHashMap<String, LifeSheet>()
        for (row in children(st.get("creatures"))) cr[row.getString(0)] = LifeSheet(row.getInt(1), row.getInt(2), row.getInt(3), row.getDouble(4), row.getInt(5), row.getInt(6), row.getString(7) == "water")
        val landmarks = children(st.get("landmarks")).map { it.asString() }
        val objects = children(st.get("objects")).map { it.getString(0) to (it.get(1).takeIf { x -> !x.isNull }?.asString()) }
        val stubs = Stubs(sp, cr)
        val life = scatter.compileLife(realm, scatter.lifeTable(file.tables[realm], landmarks, objects), stubs)!!
        submitCounts(life)
        val p = plan.get("realms").get(realm)
        val cols = p.getInt("cols"); val rows = p.getInt("rows")
        life.bx0 = 0.0; life.by0 = 0.0; life.bx1 = cols * geo.deedArt.toDouble(); life.by1 = rows * geo.deedArt.toDouble()
        RealmLife(life, LifePlanner(scatter, life, bands), LifeCost(scatter, life), cols, rows)
    }

    private fun classOf(classes: Array<IntArray>, w: Int, h: Int): Int = classes.indexOfFirst { w <= it[0] && h <= it[1] }
    /** LifeLoad.submitCounts over the stub sizes (see the class note for the assumptions). */
    private fun submitCounts(life: CLife) {
        val k = geo.deedArt.toDouble() / geo.mapArt
        fun twinClass(sp: LifeSprite) = classOf(c.twinClasses, Math.ceil(sp.w / k).toInt(), Math.ceil(sp.h / k).toInt())
        for (g in life.groups) {
            val kit = if (g.mapOnly) 0 else g.species.map { classOf(c.sizeClasses, it.sp.w, it.sp.h) }.filter { it >= 0 }.toSet().size
            val twin = if (g.twin || g.mapOnly) g.species.map { twinClass(it.sp) }.filter { it >= 0 }.toSet().size else 0
            g.hasTwins = twin > 0; g.hasEmit = g.species.any { it.emit != null }
            g.submit = GroupSubmit(kit, if (g.twin || g.mapOnly) 0 else kit, twin, if (g.hasEmit) c.puffs else 0)
        }
        life.stands?.let { s ->
            val members = s.species.map { classOf(c.sizeClasses, it.sp.w, it.sp.h) }.filter { it >= 0 }.toSet().size
            s.submit = StandSubmit(members, Math.max(1, Math.min(c.twinClasses.size, members)))
        }
        life.birds?.submit = 2
    }

    /** CSS viewport of a Seeker row (panel px / density) and its dpr (the web cap). */
    fun cssW(row: SeekerRow) = row.panelW / row.density
    fun cssH(row: SeekerRow) = row.panelH / row.density

    /**
     * LIFE's passes on [row] at [d] with a ladder level's LIFE cap ([lifeCap], 0 = the phone cap) and heaviness
     * ([heavy]: GPU_SAFE.heavy at the level's web level; off = safe mode: reduced motion and no air pass).
     */
    fun lifePasses(realm: String, row: SeekerRow, d: Double, lifeCap: Int, heavy: Boolean, fx: Double = 0.5, fy: Double = 0.5): List<PassCost> {
        val r = life(realm)
        r.planner.capOverride = lifeCap
        r.planner.plan(r.cols * fx, r.rows * fy, d, cssW(row), cssH(row), row.dpr, !heavy)
        return r.cost.passes(r.planner, row.bufferW, row.bufferH, heavy)
    }

    /** GPU_SAFE.heavy at a ladder level (web level = min(level, 2)). */
    fun heavy(level: Int): Boolean = GpuSafe.HEAVY[Math.min(level, GpuSafe.HEAVY.size - 1)]

    // ---------------------------------------------------------------- BASES

    private val decorTables = DecorTables.load()
    private val game = DecorGame.fromCatalogue(cat)
    val decor = Decor(decorTables, game, RealmEngineWiring.plots(game.claimTilesByKeep, game.wallRingsByKeep, game.tilesPerDeed))
    val basesCost = BasesCost(decor, BasesBandsIn.fromGenerated())
    private val kingdoms = HashMap<String, BasesCost.Kingdom>()

    /** The largest kingdom of [level] in [realm] over a few seeds (the four formations). */
    fun kingdom(realm: String, level: Int): BasesCost.Kingdom = kingdoms.getOrPut("$realm/$level") {
        (0L until 8L).map { basesCost.kingdom(level, realm, it * 2654435761L % 4294967296L) }
            .maxByOrNull { it.decorArea + it.keepArea + it.groundCells }!!
    }

    /** BASES' passes on [row] at [d]: every deed in view claimed ([occupancy] = 1) by a level-[level] kingdom, shielded. */
    fun basesPasses(realm: String, row: SeekerRow, d: Double, level: Int = 20, occupancy: Double = 1.0): List<PassCost> {
        val f = basesCost.bound(d, row.dpr, row.bufferW, row.bufferH, occupancy)
        return basesCost.passes(kingdom(realm, level), f, row.bufferW, row.bufferH)
    }
}
