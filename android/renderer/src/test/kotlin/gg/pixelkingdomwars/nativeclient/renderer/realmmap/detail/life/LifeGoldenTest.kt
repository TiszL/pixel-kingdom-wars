package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit.children
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit.hashOf
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit.u32
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LIFE parity with the pinned web engine (tools/world-lifebases.mjs goldens, GLOBE-NATIVE-PLAN §7 "scatter", 100 %).
 * Why it matters: LIFE places instances in the VERBATIM web shaders from tables and uniforms this port compiles, so a
 * drifted compile, rank window or planner would put a different tree on a tile than the web (or thin a different set),
 * and the two clients would disagree on what a realm looks like. Every assertion is exact (doubles bit for bit).
 */
class LifeGoldenTest {
    private val file = LifeTablesFile.load()
    private val c = file.constants
    private val cat = GoldenKit.catalogue()
    private val geo = LifeGeometry(cat.get("GRID").getInt("tilePx"), cat.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles"), c.pinnedMapArt)
    private val sc = Scatter(c, geo)
    private val bands = LifeBandsIn.fromGenerated()

    private fun golden(name: String) = GoldenKit.json(LifeGoldenTest::class.java, name)

    @Test fun tablesArePinnedAndTheCatalogueAgrees() {
        val g = golden("golden-compile.json")
        assertEquals("tables and goldens come from one pin", g.getString("pin"), file.pin)
        // the catalogue's game geometry must be the pin's, or every lattice would shift (fail loud, never adapt)
        assertEquals(c.pinnedArt, geo.art); assertEquals(c.pinnedTiles, geo.tilesPerDeed); assertEquals(c.pinnedDeedArt, geo.deedArt)
        // stage B (web 69fb02c2): the three new realms have LIFE tables, so LIFE draws on every realm map (no "no LIFE table")
        assertEquals(listOf("sunscar", "frostveil", "cinderfall", "stormcairn", "crownlands", "elderwood", "thornwake", "seeker-reach"), file.tables.keys.toList())
    }

    // ---------------------------------------------------------------- compile

    private class Stubs(val sprites: Map<String, LifeSprite>, val creatures: Map<String, LifeSheet>, val landmarks: List<String>, val objects: List<Pair<String, String?>>) : LifeLookup {
        override fun sprite(id: String): LifeSprite? = sprites[id.replace('-', '_')]
        override fun creature(id: String): LifeSheet? = creatures[id.replace('-', '_')]
    }
    private fun stubs(v: JsonValue): Stubs {
        val sp = LinkedHashMap<String, LifeSprite>()
        // later rows win, as in the generator's `new Map(rows)`
        for (r in children(v.get("sprites"))) sp[r.getString(0)] = LifeSprite(r.getInt(1), r.getInt(2), r.getInt(3), r.getDouble(4), r.getDouble(5), r.getInt(6), r.getInt(7))
        val cr = LinkedHashMap<String, LifeSheet>()
        for (r in children(v.get("creatures"))) cr[r.getString(0)] = LifeSheet(r.getInt(1), r.getInt(2), r.getInt(3), r.getDouble(4), r.getInt(5), r.getInt(6), r.getString(7) == "water")
        val lm = children(v.get("landmarks")).map { it.asString() }
        val ob = children(v.get("objects")).map { it.getString(0) to (it.get(1).takeIf { x -> !x.isNull }?.asString()) }
        return Stubs(sp, cr, lm, ob)
    }
    private fun compiled(realm: String, st: Stubs): CLife = sc.compileLife(realm, sc.lifeTable(file.tables[realm], st.landmarks, st.objects), st)!!

    private fun projSpecies(s: CSpecies): List<Any?> = listOf(s.id, s.w, s.on, if (s.coast) 1 else 0,
        s.emit?.let { listOf(it.fx, it.dx, it.dy, it.rise, it.puffs) }, s.cum, s.footR, s.glow)
    private fun projCompiled(l: CLife): Map<String, Any?> = mapOf(
        "realm" to l.realm, "wind" to l.wind.toList(), "missing" to l.missing,
        "fields" to l.fields.map { listOf(it.id, it.salt, it.lo, it.k) },
        "groups" to l.groups.map { g -> mapOf("id" to g.id, "kind" to g.kind, "salt" to g.salt, "pitch" to g.pitch, "pitchArt" to g.pitchArt, "jitterArt" to g.jitterArt,
            "density" to g.density.toList(), "species" to g.species.map(::projSpecies), "missing" to g.missing,
            "flags" to listOf(g.twin, g.sway, g.mapOnly, g.trueOnly).map { if (it) 1 else 0 },
            "mod" to g.mod?.let { listOf(it.id, it.salt, it.lo, it.k, it.out, it.inn, it.edge) }, "cluster8" to g.cluster8, "maxInkH" to g.maxInkH,
            "minInkH" to (if (g.minInkH.isInfinite()) "Infinity" else g.minInkH), "maxExtent" to g.maxExtent) },
        "stands" to l.stands?.let { s -> mapOf("salt" to s.salt, "pitch" to s.pitch, "pitchArt" to s.pitchArt, "jitterArt" to s.jitterArt, "species" to s.species.map { it.id },
            "mixes" to s.mixes.map { listOf(it.id, it.index, it.field.id, it.density.toList(), if (it.sway) 1 else 0, if (it.mapOnly) 1 else 0) },
            "variants" to s.variants.map { v -> listOf(v.mix, v.r4, v.inkH, v.footDy, v.members.map { listOf(it.dx, it.dy, it.s, it.flip) }) }, "missing" to s.missing,
            "maxInkH" to s.maxInkH, "minInkH" to s.minInkH, "mergeUntil" to s.mergeUntil, "memberInkMin" to s.memberInkMin) },
        "creatures" to l.creatures?.let { cr -> mapOf("salt" to cr.salt, "pitch" to cr.pitch, "pitchArt" to cr.pitchArt, "jitterArt" to cr.jitterArt, "density" to cr.density.toList(),
            "species" to cr.species.map { listOf(it.id, it.w, it.herdMin, it.herdMax, it.on, it.cum) }, "missing" to cr.missing, "maxInkH" to cr.maxInkH) },
        "birds" to l.birds?.let { b -> mapOf("salt" to b.salt, "pitch" to b.pitch, "pitchArt" to b.pitchArt, "jitterArt" to b.jitterArt, "p16" to b.p16,
            "species" to b.species.map { listOf(it.id, it.w, it.fMin, it.fMax, it.on, it.speed, it.alt, it.cum) }) },
        "ambience" to l.ambience.map { listOf(it.id, it.kind, it.salt, it.pitchArt, it.jitterArt, it.density.toList(), it.lifeMs, it.alt, it.windK, if (it.rise) 1 else 0, it.minD, if (it.shared) 1 else 0) },
    )

    @Test fun compileLifeMatchesTheWebForEveryRealm() {
        val g = golden("golden-compile.json")
        var realms = 0
        for (r in children(g.get("realms"))) {
            val st = stubs(r.get("stubs"))
            val l = compiled(r.name, st)
            assertEquals("${r.name} compileLife", Deep.json(r.get("compiled")), Deep.kotlin(projCompiled(l)))
            assertEquals("${r.name} withCanopy", children(r.get("canopy")).map { it.asString() }, sc.withCanopy(sc.lifeTable(file.tables[r.name], st.landmarks, st.objects)!!)!!.map { it.id })
            realms++
        }
        assertEquals(8, realms)
    }

    /**
     * Stage B (scatter.js lifeTable): a map object's weight and coast rule come from the table's `mapobjs` by object id,
     * then by role, read as `typeof o === 'number' ? o : o?.w ?? 1` and `o?.coast`; its lens glow from `glow` by id. The
     * pinned tables use only numbers and { w, coast } (golden-compile pins those); a PACK `realm.json.life` may write any
     * JSON, and the two clients must weigh it alike or the same deed grows a different map object.
     */
    @Test fun mapObjectWeightsAndGlowsReadAsTheWebsLifeTableReadsThem() {
        val base = LifeTablesFile.table(com.badlogic.gdx.utils.JsonReader().parse("""{"groups":[{"id":"mapobj","kind":"mapobj","pitch":15,"density":{"ROCK":0.5},"species":[],"twin":true,"mapOnly":true}],
            "mapobjs":{"map_peak_1":{"w":0.5},"peak":3,"crag":{"coast":1},"hill":null,"spire":"x","mesa":{"w":2,"coast":0}},"glow":{"map_peak_1":[1,2],"map_crag_1":null}}"""))
        val objs = listOf("map_peak_1" to "peak", "map_peak_2" to "peak", "map_crag_1" to "crag", "map_hill_1" to "hill", "map_spire_1" to "spire", "map_mesa_1" to "mesa")
        val rows = sc.lifeTable(base, emptyList(), objs)!!.groups.single().species.associateBy { it.id }
        fun row(id: String) = rows.getValue(id).let { listOf(it.w, it.coast, it.glow?.toList()) }
        assertEquals("the id's entry wins over the role's", listOf(0.5, false, listOf(1.0, 2.0)), row("map_peak_1"))
        assertEquals("a bare number weighs, no coast rule", listOf(3.0, false, null), row("map_peak_2"))
        assertEquals("an object without w weighs 1; a truthy coast", listOf(1.0, true, null), row("map_crag_1"))
        assertEquals("a null entry falls through to the default", listOf(1.0, false, null), row("map_hill_1"))
        assertEquals("a string entry: o.w undefined, weighs 1", listOf(1.0, false, null), row("map_spire_1"))
        assertEquals("a falsy coast is no coast rule", listOf(2.0, false, null), row("map_mesa_1"))
    }

    // ---------------------------------------------------------------- placement (the same tree on the same tile)

    private fun cells(pitchArt: Int, x0: Double, y0: Double, x1: Double, y1: Double): List<IntArray> {
        val ix0 = Math.floor(x0 / pitchArt).toInt(); val ix1 = Math.floor(x1 / pitchArt).toInt(); val iy0 = Math.floor(y0 / pitchArt).toInt(); val iy1 = Math.floor(y1 / pitchArt).toInt()
        val out = ArrayList<IntArray>()
        for (j in 0 until Math.max(0, iy1 - iy0 + 1)) for (i in 0 until Math.max(0, ix1 - ix0 + 1)) out += intArrayOf(ix0 + i, iy0 + j)
        return out
    }
    private val lodDs = doubleArrayOf(0.7, 30.0, 60.0, 200.0, 260.0, 300.0, 400.0, 800.0, 900.0, 1000.0, 1100.0, 3000.0)
    private fun wTrue(d: Double) = bands.lnT(d, bands.trueStart, bands.trueFull)
    private fun wTwin(d: Double) = bands.lnT(d, bands.twins0, bands.twins1)

    @Test fun scatterStandsHerdsBirdsAndParticlesPlaceTheSameInstances() {
        val gc = golden("golden-compile.json"); val g = golden("golden-place.json")
        var groupsChecked = 0; var instances = 0
        for (r in children(g.get("realms"))) {
            val l = compiled(r.name, stubs(gc.get("realms").get(r.name).get("stubs")))
            val dx0 = r.getInt("dx0"); val dy0 = r.getInt("dy0")
            val env = GoldenKit.Env(children(r.get("plots")).map { it.asDoubleArray() })
            val art = 3136.0
            for (gv in children(r.get("groups"))) {
                val grp = l.groups.first { it.id == gv.getString("id") }
                val all = ArrayList<List<Any?>>(); val small = ArrayList<List<Any?>>()
                for (cell in cells(grp.pitchArt, dx0 * art, dy0 * art, dx0 * art + 3 * art, dy0 * art + 3 * art)) {
                    val ix = cell[0]; val iy = cell[1]
                    val s = sc.scatterInstance(grp, ix, iy, env)
                    val row: List<Any?> = if (s != null) listOf(ix, iy, s.x, s.y, s.cls, s.species, s.flip, s.phase, u32(s.h2), s.rank) else listOf(ix, iy)
                    all += row
                    if (s != null && ix * grp.pitchArt < dx0 * art + 1568 && iy * grp.pitchArt < dy0 * art + 1568 && ix * grp.pitchArt >= dx0 * art && iy * grp.pitchArt >= dy0 * art) small += row
                    if (s != null) instances++
                }
                assertEquals("${r.name}/${grp.id} cells", gv.getInt("cells"), all.size)
                assertEquals("${r.name}/${grp.id} rows", Deep.json(gv.get("rows")), Deep.kotlin(small))
                assertEquals("${r.name}/${grp.id} instance hash", gv.getString("hash"), hashOf(all))
                val found = all.filter { it.size > 2 }.take(40)
                val lods = found.map { f -> lodDs.map { d -> listOf(
                    sc.instanceLod(grp, f[5] as Int, (f[8] as Long).toInt(), f[9] as Int, d, wTrue(d), wTwin(d)),
                    sc.instanceLod(grp, f[5] as Int, (f[8] as Long).toInt(), f[9] as Int, d, wTrue(d), wTwin(d), 0.37)) } }
                assertEquals("${r.name}/${grp.id} lods", Deep.json(gv.get("lods")), Deep.kotlin(lods))
                val sway = found.take(12).map { f -> val h2 = (f[8] as Long).toInt(); doubleArrayOf(0.0, 999.0, 123456.0, 7654321.0).map { ms ->
                    listOf(sc.swayArt(h2, (h2 ushr 17) and 0x7fff, ms, 2500.0, false, bands.sway), sc.clipFrame((h2 ushr 17) and 0x7fff, ms, 8, 110, false)) } }
                assertEquals("${r.name}/${grp.id} sway", Deep.json(gv.get("sway")), Deep.kotlin(sway))
                groupsChecked++
            }
            checkStands(r.name, r.get("stands"), l, env, dx0, dy0)
            checkCreatures(r.name, r.get("creatures"), l, env, dx0, dy0)
            checkBirds(r.name, r.get("birds"), l, env, dx0, dy0)
            for (av in children(r.get("ambience"))) {
                val a = l.ambience.first { it.id == av.getString("id") }
                val rows = ArrayList<List<Any?>>()
                for (cell in cells(a.pitchArt, dx0 * art, dy0 * art, dx0 * art + art, dy0 * art + art)) for (ms in doubleArrayOf(0.0, 1500.0, 123457.0)) {
                    val p = sc.particle(a, cell[0], cell[1], ms, env, l.wind)
                    rows += if (p != null) listOf(cell[0], cell[1], ms, p.x, p.y, p.alt, p.frame, p.fade, p.flip) else listOf(cell[0], cell[1], ms)
                }
                assertEquals("${r.name}/${a.id} particle hash", av.getString("hash"), hashOf(rows))
                assertEquals("${r.name}/${a.id} ink", av.getInt("ink"), sc.ambienceInk(a, bands.snap))
            }
        }
        assertTrue("every realm's groups were checked ($groupsChecked)", groupsChecked >= 40)
        assertTrue("the windows hold real instances ($instances)", instances > 1000)
    }

    private fun checkStands(realm: String, v: JsonValue?, l: CLife, env: LifeEnv, dx0: Int, dy0: Int) {
        val st = l.stands
        if (v == null || v.isNull) { assertTrue("$realm has no stands", st == null); return }
        st!!
        val art = 3136.0
        val sites = ArrayList<List<Any?>>(); val members = ArrayList<List<Any?>>(); val merged = ArrayList<List<Any?>>()
        val found = ArrayList<StandSiteR>()
        for (cell in cells(st.pitchArt, dx0 * art, dy0 * art, dx0 * art + 3 * art, dy0 * art + 3 * art)) {
            val s = sc.standSite(st, cell[0], cell[1], env)
            sites += if (s != null) listOf(cell[0], cell[1], s.x, s.y, s.cls, s.v, s.mix, s.flip, u32(s.h2), s.sdf, s.rank) else listOf(cell[0], cell[1])
            if (s != null) found += s
            if (s != null && members.size < 400) for (m in 0 until 16) {
                val mm = sc.standMember(st, s, m, env)
                members += if (mm != null) listOf(cell[0], cell[1], m, mm.x, mm.y, mm.species, mm.flip) else listOf(cell[0], cell[1], m)
            }
        }
        val b0y = Math.floor(dy0 * 98 / 16.0).toInt(); val b0x = Math.floor(dx0 * 98 / 16.0).toInt()
        for (by in b0y - 1 until b0y + 19) for (bx in b0x - 1 until b0x + 19) {
            val s = sc.mergedSite(st, bx, by, env); merged += if (s != null) listOf(bx, by, s.x, s.y, s.v) else listOf(bx, by)
        }
        assertEquals("$realm stand sites", v.getString("sites"), hashOf(sites))
        assertEquals("$realm stand count", v.getInt("siteCount"), found.size)
        assertEquals("$realm stand members", v.getString("members"), hashOf(members))
        assertEquals("$realm merged", v.getString("merged"), hashOf(merged))
        val lods = found.take(30).map { s -> doubleArrayOf(30.0, 60.0, 150.0, 180.0, 210.0, 400.0, 800.0, 950.0, 1100.0).map { d ->
            listOf(sc.standLod(st, s.v, s.h2, s.rank, d, wTrue(d)), sc.standLod(st, s.v, s.h2, s.rank, d, wTrue(d), 0.5), sc.mergedLod(st, s.v, s.h2, d)) } }
        assertEquals("$realm stand lods", Deep.json(v.get("lods")), Deep.kotlin(lods))
        val sway = found.take(6).map { s -> intArrayOf(0, 1, 7, 15).map { m -> sc.standSwayArt(s.h2, m, 4321.0, 2600.0, false, bands.sway) } }
        assertEquals("$realm stand sway", Deep.json(v.get("sway")), Deep.kotlin(sway))
    }

    private fun checkCreatures(realm: String, v: JsonValue?, l: CLife, env: LifeEnv, dx0: Int, dy0: Int) {
        val cr = l.creatures
        if (v == null || v.isNull) return
        cr!!
        val art = 3136.0
        val sites = ArrayList<List<Any?>>(); val members = ArrayList<List<Any?>>(); var n = 0
        for (cell in cells(cr.pitchArt, dx0 * art, dy0 * art, dx0 * art + 4 * art, dy0 * art + 4 * art)) {
            val s = sc.herdSite(cr, cell[0], cell[1], env)
            sites += if (s != null) listOf(cell[0], cell[1], s.x, s.y, s.cls, s.species, s.n, u32(s.h2)) else listOf(cell[0], cell[1])
            if (s == null) continue
            n++
            for (m in 0 until 4) {
                val mb = sc.herdMember(cr, s, m, env)
                if (mb == null) { members += listOf(cell[0], cell[1], m); continue }
                val sh = cr.species[mb.species].sh
                val poses = doubleArrayOf(0.0, 1234.0, 98765.0, 5555555.0).map { ms -> val p = sc.memberPose(mb, ms, false)
                    listOf(p.x, p.y, c.facings.indexOf(p.facing), if (p.dwelling) 1 else 0, sc.poseFrame(p, ms, sh.frames, sh.frameMs, sh.directions)) }
                members += listOf(cell[0], cell[1], m, mb.phase, mb.points.map { listOf(it.x, it.y) }, poses)
            }
        }
        assertEquals("$realm herd sites", v.getString("sites"), hashOf(sites))
        assertEquals("$realm herd count", v.getInt("siteCount"), n)
        assertEquals("$realm herd members", v.getString("members"), hashOf(members))
    }

    private fun checkBirds(realm: String, v: JsonValue?, l: CLife, env: LifeEnv, dx0: Int, dy0: Int) {
        val b = l.birds
        if (v == null || v.isNull) return
        b!!
        val art = 3136
        val rows = ArrayList<List<Any?>>()
        val iy0 = Math.floor(dy0 * art / b.pitchArt.toDouble()).toInt(); val ix0 = Math.floor(dx0 * art / b.pitchArt.toDouble()).toInt()
        for (iy in iy0 - 2 until iy0 + 30) for (ix in ix0 - 2 until ix0 + 30) {
            val f = sc.flockSite(b, ix, iy, env)
            if (f == null) { rows += listOf(ix, iy); continue }
            val poses = ArrayList<Any?>()
            for (ms in doubleArrayOf(0.0, 777.0, 123456.0)) for (m in intArrayOf(0, 1, f.n - 1)) { val p = sc.birdPose(b, f, m, ms); poses.add(listOf(p.x, p.y, p.alt, p.flip, p.frame)) }
            rows += listOf(ix, iy, f.x, f.y, f.species, f.n, f.radius, f.dir, u32(f.h2), f.rank, poses)
        }
        assertEquals("$realm birds", v.getString("hash"), hashOf(rows))
    }

    @Test fun ranksFieldsEdgesAndHashesMatch() {
        val g = golden("golden-place.json")
        val ranks = ArrayList<List<Any?>>()
        for (salt in intArrayOf(0, 1, 4242, 65535)) { var iy = -9; while (iy < 9) { var ix = -9; while (ix < 9) {
            val h0 = LifeHash.pcgX(ix, iy)
            ranks += listOf(salt, ix, iy, sc.cellRank(salt, ix, iy), sc.cellSeatX(56, 47, ix, h0), sc.cellSeatY(56, 47, iy, h0)); ix += 2 }; iy += 3 } }
        assertEquals(Deep.json(g.get("ranks")), Deep.kotlin(ranks))
        val slots = ArrayList<List<Any?>>(); val out = IntArray(3)
        for (salt in intArrayOf(3, 999)) for (by in -2 until 2) for (bx in -2 until 2) for (j in 0 until 16) { sc.slotCell(salt, bx, by, j, out); slots += listOf(salt, bx, by, j, out[0], out[1], out[2]) }
        assertEquals(Deep.json(g.get("slots")), Deep.kotlin(slots))
        // every rank window submits exactly the cells whose rank is in range (the planner's premise)
        for (row in slots) { val salt = row[0] as Int; assertEquals(row[6], sc.cellRank(salt, row[4] as Int, row[5] as Int)) }
        val field = ArrayList<List<Any?>>()
        for (salt in intArrayOf(7, 51234)) { var y = -300; while (y < 3000) { var x = -500; while (x < 5000) { field += listOf(salt, x, y, sc.valueU8(salt, x, y, 10), sc.standField(salt, x, y)); x += 211 }; y += 97 } }
        assertEquals(Deep.json(g.get("field")), Deep.kotlin(field))
        val edges = ArrayList<List<Any?>>(); var sdf = -3.0
        while (sdf < 24) { edges += listOf(sdf, sc.edgeWeight(sdf, 2.0), sc.edgeWeight(sdf, 4.75)); sdf += 0.37 }
        assertEquals(Deep.json(g.get("edges")), Deep.kotlin(edges))
        val mods = ArrayList<List<Any?>>()
        for (dens in intArrayOf(0, 1, 5000, 65535)) for (cover in intArrayOf(0, 100, 256)) for (edge in intArrayOf(-1, 0, 128, 255)) mods += listOf(dens, cover, edge, sc.modDensity(dens, 179, 614, 768, cover, edge))
        assertEquals(Deep.json(g.get("mods")), Deep.kotlin(mods))
        val hashes = ArrayList<List<Any?>>()
        for (i in 0 until 64) {
            val a = (i.toLong() * 2654435761L).toInt(); val b = (i.toLong() * 40503 - 77777).toInt()
            hashes += listOf(a, b, u32(LifeHash.kitHash(a, b)), u32(LifeHash.pcgX(a, b)), u32(LifeHash.pcgY(a, b)), sc.salt16("realm:$i"), sc.range16(LifeHash.kitHash(a, b), 97))
        }
        assertEquals(Deep.json(g.get("hashes")), Deep.kotlin(hashes))
        val draws = ArrayList<List<Any?>>(); val win = PlanWindow(); val range = PlanRange()
        val planner = LifePlanner(sc, CLife("x", doubleArrayOf(0.0, 0.0), arrayOf(), emptyList(), null, null, null, emptyList(), emptyList()), bands)
        for (w in arrayOf(intArrayOf(-5, 3, 17, 9), intArrayOf(100, 200, 64, 48), intArrayOf(-1, -1, 1, 1))) for (lh in arrayOf(intArrayOf(0, 65536), intArrayOf(0, 0), intArrayOf(0, 12000),
                intArrayOf(5000, 30000), intArrayOf(30000, 65536), intArrayOf(65535, 65536), intArrayOf(0, 1), intArrayOf(4096, 8192))) {
            win.ix0 = w[0]; win.iy0 = w[1]; win.nx = w[2]; win.ny = w[3]
            planner.rankDraw(win, lh[0], lh[1], range)
            draws += listOf(w[0], w[1], w[2], w[3], lh[0], lh[1], range.lo, range.hi, range.count, if (range.rl) listOf(range.bx0, range.by0, range.nbx, range.nby, range.j0, range.m) else null)
        }
        assertEquals(Deep.json(g.get("draws")), Deep.kotlin(draws))
        val m = g.get("misc")
        assertEquals(Deep.json(m.get("thinFactor")), Deep.kotlin(listOf(sc.thinFactor(0, 1, 0.5), sc.thinFactor(0, 3, 0.5), sc.thinFactor(1, 3, 0.5), sc.thinFactor(2, 3, 0.5), sc.thinFactor(0, 4, 0.9))))
        assertEquals(Deep.json(m.get("isqrt")), Deep.kotlin(longArrayOf(0, 1, 2, 3, 4, 15, 16, 17, 1000000, 123456789).map { sc.isqrt(it) }))
        assertEquals(Deep.json(m.get("bandWeights")), Deep.kotlin(doubleArrayOf(0.5, 23.0, 24.0, 30.0, 48.0, 100.0, 250.0, 300.0, 350.0, 799.0, 800.0, 900.0, 1100.0, 1100.0000001, 4000.0)
            .map { d -> listOf(d, wTrue(d), wTwin(d)) }))
        assertEquals(Deep.json(m.get("skyScale")), Deep.kotlin(doubleArrayOf(1.0, 100.0, 367.0, 1100.0, 5000.0).map { sc.skyScale(it, bands.trueFull) }))
        assertEquals(Deep.json(m.get("splitWeight")), Deep.kotlin(doubleArrayOf(100.0, 150.0, 180.0, 210.0, 300.0).map { sc.splitWeight(it) }))
        assertEquals(Deep.json(m.get("fadeU8")), Deep.kotlin(intArrayOf(0, 1, 64, 128, 200, 255).map { sc.fadeU8(it) }))
        // stage B: the lens glow's strength (SCATTER_VS's CPU twin), over uint32 h2 edges, ms past 2^32 and reduced motion
        val pulse = children(m.get("glowPulse"))
        assertEquals(8 * 9 * 3, pulse.size)
        for (row in pulse) {
            val h2 = row.get(0).asLong().toInt(); val ms = row.get(1).asDouble(); val rm = row.get(2).asInt() == 1
            val per = row.get(3); val want = row.get(4).asDouble()
            val got = if (per.isNull) sc.glowPulse(h2, ms, rm) else sc.glowPulse(h2, ms, rm, per.asInt())
            assertEquals("glowPulse(${row.get(0).asLong()}, $ms, $rm, $per)", GoldenKit.num(want), GoldenKit.num(got))
        }
    }

    // ---------------------------------------------------------------- planDraws (the §9 ceiling, rank windows, streams)

    private fun projWin(w: PlanWindow): List<Any?> = listOf(w.ix0, w.iy0, w.nx, w.ny, w.stride)
    private fun projRange(r: PlanRange): List<Any?> = listOf(r.lo, r.hi, r.count, if (r.rl) listOf(r.bx0, r.by0, r.nbx, r.nby, r.j0, r.m) else null)
    fun projPlan(p: LifePlanner): List<Any?> {
        if (p.empty) return listOf(p.total, null, null, if (p.trueClasses) 1 else 0, null, null, emptyList<Any?>(), null, null, null, emptyList<Any?>())
        val groups = p.groups.map { e -> listOf(e.g.id, projWin(e.win), e.keep, e.kitK, e.twK, e.truHi.takeIf { it >= 0 }, e.keepHi.takeIf { it >= 0 }, e.twinHi.takeIf { it >= 0 },
            if (e.hasKit) projRange(e.kit) else null, if (e.hasTw) projRange(if (e.twIsKit) e.kit else e.tw) else null, e.count) }
        val s = p.stands
        val stands = if (s.active) listOf(projWin(s.win), s.sites, s.keep, s.truHi, s.keepHi, projRange(s.mem), projRange(s.clu), s.members, s.clumps, s.merged,
            if (s.hasMergedWin) projWin(s.mergedWin) else null) else null
        val cr = if (p.creatures.active) listOf(projWin(p.creatures.win), p.creatures.count, p.creatures.keep, p.creatures.cap) else null
        val b = if (p.birds.active) listOf(projWin(p.birds.win), p.birds.count, p.birds.keep, p.birds.scale) else null
        val amb = (0 until p.ambienceCount).map { val e = p.ambience[p.ambienceOn[it]]; listOf(e.ambience!!.id, projWin(e.win), e.count, e.keep) }
        return listOf(p.total, p.cap, if (p.trueOn) 1 else 0, if (p.trueClasses) 1 else 0, p.tau.toList(), p.model, groups, stands, cr, b, amb)
    }

    @Suppress("UNCHECKED_CAST")
    private fun discrete(p: List<Any?>): List<Any?> {
        val groups = (p[6] as List<List<Any?>>).map { g -> listOf(g[0], g[1], null) + g.drop(3) }
        val st = p[7] as List<Any?>?; val cr = p[8] as List<Any?>?; val b = p[9] as List<Any?>?
        return listOf(p[0], p[1], p[2], p[3], null, null, groups, st?.let { listOf(it[0], it[1], null) + it.drop(3) },
            cr?.let { listOf(it[0], it[1], null, it[3]) }, b?.let { listOf(it[0], it[1], null, null) }, (p[10] as List<List<Any?>>).map { listOf(it[0], it[1], it[2], null) })
    }
    @Suppress("UNCHECKED_CAST")
    private fun floats(p: List<Any?>): List<Any?> {
        val out = ArrayList<Any?>()
        (p[4] as List<Any?>?)?.let { out.addAll(it) }; p[5]?.let { out.add(it) }
        for (g in p[6] as List<List<Any?>>) out.add(g[2])
        (p[7] as List<Any?>?)?.let { out.add(it[2]) }; (p[8] as List<Any?>?)?.let { out.add(it[2]) }; (p[9] as List<Any?>?)?.let { out.add(it[2]); out.add(it[3]) }
        for (e in p[10] as List<List<Any?>>) out.add(e[3])
        return out
    }

    @Test fun planDrawsMatchesTheWebAtEveryBandViewportAndPan() {
        val gc = golden("golden-compile.json"); val g = golden("golden-plan.json")
        var views = 0; var readable = 0
        for (r in children(g.get("realms"))) {
            val st = stubs(gc.get("realms").get(r.name).get("stubs"))
            val cols = r.getInt("cols"); val rows = r.getInt("rows")
            val plain = compiled(r.name, st); val sub = compiled(r.name, st)
            for (grp in sub.groups) grp.submit = GroupSubmit(2, 1, if (grp.twin) 1 else 0, if (grp.species.any { it.emit != null }) 3 else 0)
            sub.stands?.submit = StandSubmit(3, 1); sub.birds?.submit = 2
            for (l in arrayOf(plain, sub)) { l.bx0 = 0.0; l.by0 = 0.0; l.bx1 = cols * 3136.0; l.by1 = rows * 3136.0 }
            val planners = arrayOf(LifePlanner(sc, plain, bands), LifePlanner(sc, sub, bands))
            for (v in children(r.get("views"))) {
                val p = planners[v.getInt(0)]
                p.plan(v.getDouble(3), v.getDouble(4), v.getDouble(2), v.getDouble(6), v.getDouble(7), v.getDouble(8), v.getInt(5) == 1)
                val proj = projPlan(p)
                val where = "${r.name} submit=${v.getInt(0)} ${v.getString(1)} d=${v.getDouble(2)} x=${v.getDouble(3)}"
                if (!v.get(12).isNull) { for ((i, k) in Deep.PLAN_KEYS.withIndex()) Close.assertClose("$where.$k", v.get(12).get(k), proj[i]); readable++ }
                assertEquals("$where total", v.getInt(9), p.total)
                // windows, rank bounds and counts exact; the pow-derived keeps within 1e-12 (V8 Math.pow is not fdlibm)
                assertEquals("$where discrete hash", v.getString(10), hashOf(discrete(proj)))
                Close.assertClose("$where floats", v.get(11), floats(proj))
                views++
            }
        }
        assertEquals(8 * 2 * 5 * 35 * 3, views) // 8 realms (stage B) × 2 submit modes × 5 viewports × 35 d × 3 pans
        assertTrue(readable >= 300)
    }

    // ---------------------------------------------------------------- pixels

    @Test fun layerPixelWorkMatchesTheWeb() {
        val g = golden("golden-pixels.json")
        for (cv in children(g.get("cases"))) {
            val w = cv.getInt("w"); val h = cv.getInt("h"); val seed = cv.getLong("seed"); val lw = cv.getInt("LW"); val lh = cv.getInt("LH")
            val img = GoldenKit.synthImage(w + 6, h + 4, seed)
            assertEquals(cv.getString("image"), GoldenKit.sha256(img.data))
            val px = LifePixels.copyFrame(img, 3, 2, w, h, lw, lh, Math.floorDiv(lw - w, 2), lh - h)
            assertEquals("copyFrame $w×$h", cv.getString("frame"), GoldenKit.sha256(px))
            assertEquals(Deep.json(cv.get("ink")), Deep.kotlin(LifePixels.inkRows(px, lw, lh)?.toList()))
            val bl = LifePixels.bleed(px.copyOf(), lw, lh)
            assertEquals("bleed", cv.getString("bleed"), GoldenKit.sha256(bl))
            var m = LifePixels.Level(bl, lw, lh); val chain = ArrayList<List<Any?>>()
            var l = 0
            while (l < 8 && (m.w > 1 || m.h > 1)) { m = LifePixels.reduce2(m.px, m.w, m.h); chain += listOf(m.w, m.h, GoldenKit.sha256(m.px)); l++ }
            assertEquals("reduce2 chain", Deep.json(cv.get("chain")), Deep.kotlin(chain))
            val map = LifePixels.reduceMap(LifeFrameSource(img, 3, 2, w, h, w / 2.0, h.toDouble()))
            assertEquals("reduceMap", Deep.json(cv.get("reduceMap")), Deep.kotlin(listOf(map.w, map.h, map.ax, map.ay, GoldenKit.sha256(map.img.data))))
        }
    }
}
