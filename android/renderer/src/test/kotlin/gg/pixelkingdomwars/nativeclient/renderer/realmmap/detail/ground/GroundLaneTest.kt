package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Bands
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import gg.pixelkingdomwars.nativeclient.renderer.world.IdleScheduler
import gg.pixelkingdomwars.nativeclient.renderer.world.WebPin
import org.junit.Test
import java.lang.management.ManagementFactory
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * GROUND's GL orchestration on the recording fake (GLOBE-NATIVE-PLAN §5, §8.2): what it loads where, when it may upload,
 * how its resolve work is sliced, how its band readiness reads, what its rehearsal draws, what it binds for LIFE and
 * BASES, and that a steady frame allocates nothing. Why it matters: the realm map froze the owner's GPU once (RM-GPU-1)
 * and the Seeker bar is 60 fps with no frame over 50 ms; a lane that uploads in a fade, resolves a whole view in one
 * frame, first-draws a bake program at a band change or allocates per frame breaks that bar where no test on a device
 * can be run by a lane. Every rule below is the web ground.js behaviour it ports, measured through the fake GL.
 */
class GroundLaneTest {

    @Test fun `the load runs on the decode executor and nothing is adopted until a frame allows work`() {
        val queued = ArrayList<Runnable>()
        val g = GroundRig(executor = Executor { queued += it })
        g.lane.open(g.open)
        assertEquals("loading", g.lane.stats.status); assertEquals(1, queued.size, "one load task on the decode executor")
        assertEquals(0, g.lane.programs().size, "no program before the load lands")
        queued.single().run()
        assertEquals(1, g.wakes, "the worker asks the host for a frame")
        g.view.workAllowed = false
        g.look(30.0, 20.0, 18.0, 1.0, 0.0)
        g.frame()
        assertEquals(0, g.lane.programs().size, "a flight or a fade adopts nothing (plan §3.5)")
        assertEquals(0, g.uploads.filled.size, "and uploads nothing")
        g.view.workAllowed = true
        g.frame()
        assertEquals(listOf("rm-raw", "rm-despeckle", "rm-legalise", "rm-pure", "rm-record", "rm-map", "rm-true"), g.lane.programs().map { it.name })
        assertTrue(g.uploads.filled.isNotEmpty(), "the fresh textures are filled by the worker uploader")
        assertEquals("ready", g.lane.stats.status)
    }

    @Test fun `GROUND reports MAP and TRUE readiness only once every texture of the band has landed`() {
        val g = GroundRig()
        g.lane.open(g.open)
        g.look(30.0, 20.0, 18.0, 1.0, 0.0)
        g.frame(build = false) // adopt only: the worker has built and filled nothing yet
        assertEquals(0, g.lane.bandSet(), "no band before its textures land")
        assertFalse(g.lane.readyFor(1)); assertFalse(g.lane.readyFor(2))
        g.frame(); g.frame()
        assertTrue(g.lane.readyFor(1), "MAP ready: ${g.lane.stats.error}")
        assertTrue(g.lane.readyFor(2), "TRUE ready (the record cache is sized from the target)")
        assertEquals(2, g.lane.bandSet())
        assertEquals(48, g.lane.stats.recPages, "a 914×2034 buffer wants (2+3)(4+3) = 35 pages at d 600: the 48 floor")
        // array textures with every mip level and every layer, filled on the worker (never texSubImage on a live array)
        assertTrue(g.uploads.filled.any { it[0] == 1 && it[3] == 96 && it[4] == 6 }, "the MAP kit: 96 layers × 6 levels")
        assertTrue(g.uploads.filled.any { it[0] == 1 && it[3] == 256 }, "TRUE array A: globals 0…255")
        assertTrue(g.uploads.filled.any { it[0] == 1 && it[3] == 129 }, "TRUE array B: globals 256…384")
        assertEquals(0, g.rig.gl.calls("texSubImage3D"), "no GL-thread array upload")
    }

    @Test fun `Cinderfall draws the lava variant of rm-map, every other realm the lava-free one, and an export without it falls back`() {
        // Rewritten when NT exported rm-map+RM_LAVA (was: "…which the export does not carry yet"). ground.js compiles the
        // lava branch for Cinderfall only (P0 fix pass #1); without it Cinderfall's lava lakes draw as plain water.
        val g = GroundRig(SyntheticGroundPack(id = "cinderfall"))
        g.openAndLoad()
        assertFalse(g.lane.stats.lavaMissing, "the export carries rm-map+RM_LAVA")
        assertEquals(GroundPrograms.MAP_LAVA, g.lane.programs()[5].name)
        val c = GroundRig(); c.openAndLoad()
        assertFalse(c.lane.stats.lavaMissing, "every other realm draws rm-map")
        assertEquals(GroundPrograms.MAP, c.lane.programs()[5].name)
        // an export without the variant (an older pin) falls back to the lava-free program (GroundLane then sets stats.lavaMissing)
        assertEquals(GroundPrograms.MAP, GroundPrograms.mapKey("cinderfall", setOf(GroundPrograms.MAP)))
        assertEquals(GroundPrograms.MAP, GroundPrograms.mapKey("crownlands"))
    }

    @Test fun `lattice resolves are time-sliced to the frame budget, nearest the view centre first, and mapReady turns true once the view is whole`() {
        val g = GroundRig()
        g.openAndLoad()
        g.look(30.0, 20.0, 150.0, 0.0, 0.0) // MAP at rest
        var frames = 0; var total = 0
        val budget = GroundCost.resolveBudget(914.0 * 2034, false, 6)
        while (!g.lane.mapReady(g.view) && frames < 200) {
            g.frame()
            assertTrue(g.lane.stats.lastSubs <= budget.subs, "frame $frames resolved ${g.lane.stats.lastSubs} sub-tiles (budget ${budget.subs})")
            total += g.lane.stats.lastSubs; frames++
        }
        assertTrue(g.lane.mapReady(g.view), "the view never completed in $frames frames")
        assertTrue(total >= 1 && frames >= total / budget.subs, "$total sub-tiles in $frames frames")
        // the resolve chain draws raw, despeckle ×2, legalise ×2 and the purity pass per sub-tile (6 offscreen passes; at MAP
        // nothing else draws offscreen while the lattice resolves: the chart under it is the core's)
        assertEquals(g.lane.stats.latticeResolved * 6, g.rig.gl.draws.count { it.framebuffer != 0 }.toLong())
        // a view that is whole resolves nothing more: the map idles (the honest `missing`)
        g.frame(); g.frame()
        assertEquals(0, g.lane.stats.lastSubs); assertEquals(0, g.lane.stats.latticeMissingInView)
        assertEquals(RealmLane.GROUND_MAP, g.lane.groundPasses(g.view), "MAP alone at rest once whole: the lone pass that renders at full resolution")
    }

    @Test fun `no resolve runs in a frame without work allowed, and the ladder's L1 allows one sub-tile or one page`() {
        val g = GroundRig()
        g.openAndLoad()
        g.look(30.0, 20.0, 150.0, 0.0, 0.0)
        g.view.workAllowed = false
        repeat(5) { g.frame(); assertEquals(0, g.lane.stats.lastSubs, "a resolve inside a flight or a fade") }
        g.view.workAllowed = true; g.view.maxResolves = 1
        g.look(30.0, 20.0, 700.0, 0.0, 0.0)
        repeat(30) { g.frame(); assertTrue(g.lane.stats.lastSubs + g.lane.stats.lastPages <= 1, "L1 resolved ${g.lane.stats.lastSubs} + ${g.lane.stats.lastPages}") }
    }

    @Test fun `at FAR the view's lattice pre-resolves one sub-tile per resting frame, never while the camera moves, never before its bakes are rehearsed`() {
        val g = GroundRig()
        g.openAndLoad()
        g.look(30.0, 20.0, 12.0, 1.0, 0.0)
        // W1 fix pass 2 #3: a lattice resolve is never a bake program's first draw at FAR (it would build 3–4 pipelines in one
        // frame while the player pans): before the rehearsal has drawn them, a resting FAR view resolves nothing
        g.now += 1000
        repeat(5) { g.frame(); assertEquals(0, g.lane.stats.lastSubs, "a FAR pre-resolve before the bakes were rehearsed") }
        assertTrue(g.lane.stats.bakeHeld)
        g.rehearseAll()
        g.view.moving = true
        repeat(5) { g.frame(); assertEquals(0, g.lane.stats.lastSubs, "pre-resolve while moving") }
        g.view.moving = false
        g.frame(); assertEquals(0, g.lane.stats.lastSubs, "before GPU_SAFE.rehearse.idleMs of rest")
        g.now += 500
        var resolved = 0
        repeat(10) { g.frame(); assertTrue(g.lane.stats.lastSubs <= 1); resolved += g.lane.stats.lastSubs }
        assertTrue(resolved >= 1, "a resting FAR view never pre-resolved")
        assertEquals(RealmLane.GROUND_CHART, g.lane.groundPasses(g.view), "FAR draws the chart only")
        assertFalse(g.lane.drawsGround(g.view), "at FAR the core's chart is the ground")
    }

    @Test fun `TRUE pages keep the nearest pages, fetch within the budget and settle - a static view stops resolving`() {
        val g = GroundRig()
        g.openAndLoad()
        g.look(30.0, 20.0, 150.0, 0.0, 0.0)
        repeat(60) { g.frame() } // the lattice first
        g.look(30.0, 20.0, 1200.0, 0.0, 1.0)
        val budget = GroundCost.resolveBudget(914.0 * 2034, false, 6)
        var frames = 0
        while (g.lane.stats.pagesMissingInView > 0 || frames == 0) {
            g.frame(); frames++
            assertTrue(g.lane.stats.lastPages <= budget.pages, "${g.lane.stats.lastPages} pages in one frame")
            if (frames > 100) break
        }
        assertEquals(0, g.lane.stats.pagesMissingInView, "the view's pages never settled")
        val resolved = g.lane.stats.pagesResolved
        repeat(10) { g.frame() }
        assertEquals(resolved, g.lane.stats.pagesResolved, "a static view kept resolving pages (it would never idle)")
        assertEquals(RealmLane.GROUND_TRUE, g.lane.groundPasses(g.view), "TRUE alone at rest once its pages are in")
    }

    @Test fun `every GROUND program is rehearsed in its real states - bakes into their own target formats, display programs opaque and blended`() {
        val g = GroundRig()
        g.openAndLoad()
        val progs = g.lane.programs()
        val rig = g.rig
        for (p in progs) {
            val targets = g.lane.rehearseTargets(p)
            if (p.name == "rm-map" || p.name == "rm-true") assertEquals(RealmLane.SCREEN_AND_RGBA.toList(), targets.toList(), p.name)
            else assertEquals(listOf(RealmMapEngine.TARGET_OWN), targets.toList(), "${p.name} is a bake: rehearsed in its own format")
        }
        assertEquals("R8UI", g.lane.rehearseScratch(progs[0])!!.format.name); assertEquals("R8UI", g.lane.rehearseScratch(progs[3])!!.format.name)
        assertTrue(g.lane.rehearseScratch(progs[3])!!.isArray, "rm-pure renders into a lattice page: an array layer")
        assertEquals("RGBA16UI", g.lane.rehearseScratch(progs[4])!!.format.name)
        g.look(30.0, 20.0, 18.0, 1.0, 0.0)
        g.now += 16.7
        check(rig.begin())
        val scratch = rig.core.texture2D(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool.CORE, 1, 1, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format.RGBA8)!!
        for (p in progs) {
            val own = g.lane.rehearseScratch(p)
            val target: Gl3Texture = own ?: scratch
            val drew = rig.core.rehearse(target, null, false, false) { assertTrue(g.lane.rehearse(p, RealmMapEngine.TARGET_RGBA, g.view), "${p.name} was not rehearsed") }
            assertTrue(drew, "${p.name} drew no first (program, state) pair")
        }
        rig.end()
        assertTrue(rig.core.stats.rehearsedFirstDraws >= 7 + 2, "map and true each draw opaque and blended: ${rig.core.stats.rehearsedFirstDraws}")
        for (p in listOf("rm-map", "rm-true")) assertEquals(0f, g.sink.floats["$p/uRhAt"]!![2], "$p: the probe is switched off after the rehearsal")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "a rehearsal draw counted as a live first draw")
    }

    @Test fun `after rehearsal a MAP frame first-draws nothing - every pair it uses was drawn before its band`() {
        val g = GroundRig()
        g.openAndLoad()
        val rig = g.rig
        g.look(30.0, 20.0, 18.0, 1.0, 0.0)
        g.now += 16.7; check(rig.begin())
        val screen = rig.core.texture2D(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool.CORE, 1, 1, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format.RGB8)!!
        val depth = rig.core.texture2D(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool.CORE, 1, 1, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format.DEPTH16)!!
        for (p in g.lane.programs()) {
            val own = g.lane.rehearseScratch(p)
            if (own != null) rig.core.rehearse(own, null, false, false) { g.lane.rehearse(p, RealmMapEngine.TARGET_OWN, g.view) }
            else rig.core.rehearse(screen, depth, true, false) { g.lane.rehearse(p, RealmMapEngine.TARGET_SCREEN, g.view) }
        }
        rig.end()
        val before = rig.core.stats.liveFirstDraws
        g.look(30.0, 20.0, 150.0, 0.0, 0.0)
        repeat(80) { g.frame() }
        assertEquals(before, rig.core.stats.liveFirstDraws, "a (program, state) pair was first drawn live in the MAP band")
    }

    @Test fun `bindClasses binds the seven classes units LIFE and BASES read and returns the next unit`() {
        val g = GroundRig()
        g.openAndLoad()
        val rig = g.rig
        val life = rig.core.program("life-test", "void main(){}", "void main(){}")
        rig.compiler.runAll(); g.now += 16.7; check(rig.begin()); rig.core.beginScreen(0f, 0f, 0f, 1f); rig.core.use(life)
        assertTrue(g.lane.bindClasses(life, 8), "GROUND refused its classes once loaded")
        assertEquals(15, g.lane.bindClassUnits(life, 8), "units 8…14, the next free unit 15")
        for (unit in 8..14) assertTrue(rig.gl.unitTextures[unit] != 0, "unit $unit is unbound")
        assertEquals(listOf(1024, 1, 841, 561), g.sink.ints["life-test/uRmLat"]!!.toList(), "uRmLat = LAT_PAGE, pages x, lattice W, H")
        assertEquals(listOf(60, 40, 0, 0), g.sink.ints["life-test/uRmGrid"]!!.toList())
        rig.end()
        assertNotNull(g.lane.classState(), "BASES' CPU class reads have GROUND's inputs once MAP is in")
        val at = g.lane.classAt()!!
        val st = g.lane.classState()!!
        for ((x, y) in listOf(100 to 100, 30 * 98 to 20 * 98, 59 * 98 + 5 to 39 * 98 + 7))
            assertEquals(st.classAt(x.toDouble(), y.toDouble()), at(x, y), "RealmClasses.classAt($x, $y) is classify.js classAt over GROUND's state")
    }

    @Test fun `the MAP pass carries the web's noise bank, legalise tables and band weights`() {
        val g = GroundRig()
        g.openAndLoad()
        g.look(30.0, 20.0, 150.0, 0.0, 0.0)
        repeat(60) { g.frame() }
        val s = g.sink
        assertEquals(GroundTables.mapNoise(ClassCfg.from(com.badlogic.gdx.utils.JsonReader().parse("{\"hasShore\":true}"))).toList(), s.ints["rm-map/uMpNz"]!!.toList())
        val mt = GroundTables.mapTables(g.pack.realmJson())!!
        assertEquals(mt.lg.terr.toList(), s.ints["rm-legalise/uLgTerr"]!!.toList()); assertEquals(mt.lg.legal.toList(), s.ints["rm-legalise/uLgLegal"]!!.toList())
        assertEquals(mt.terr.toList(), s.ints["rm-pure/uPuSlot"]!!.toList())
        // ground.js drawMap at d 150: the tone grade is gone (d ≥ 80), the family grade still on, deed lines just starting
        val grade = s.floats["rm-map/uMpGrade"]!!
        assertEquals(0f, grade[0], "tone grade weight at d 150"); assertEquals(1f, grade[2], "alpha at MAP rest")
        val famW = 1 - Math.log(150.0 / 48) / Math.log(1100.0 / 48)
        assertEquals(famW.toFloat(), s.floats["rm-map/uMpFamW"]!![0], 1e-6f)
        assertEquals(listOf(1024, 1, 841, 561), s.ints["rm-map/uMpLat"]!!.toList())
        assertEquals(0, s.ints["rm-map/uMpVtx"]!![0], "no TRUE vertex classes below d ${Bands.PAGE_RESOLVE}")
    }

    /**
     * Stage B's palette-dependent uniforms, which the parity test cannot compare (the JVM decodes no painting): MAP's inland
     * water starts at the painting's own water (fix pass #6: PACK's palette.water is the kit's, so Solana's pale rivers read
     * dark steel by d 49) and reaches the kit loop by d 120; MAP's kit-water ends and TRUE take the realm's deep tint (a third
     * of it in a gem-sea realm, fix pass #5: its teal read navy); TRUE's slot 2 carries no selection gold (RM-24); a gem-sea
     * realm's MAP gems are its measured colour ratios, every other realm's the ones.
     */
    @Test fun `MAP rivers run from the painting's water to the kit loop, both bands take the realm's deep tint, and the gem colours reach MAP`() {
        for (id in listOf("seeker-reach", "crownlands")) {
            val pack = SyntheticGroundPack(id) { m -> m.addChild("palette", com.badlogic.gdx.utils.JsonReader().parse("{\"water\":\"#102030\"}")) }
            val g = GroundRig(pack)
            g.lane.chartUnder = GroundChartUnder { _, _, _ -> true }
            g.openAndLoad()
            val a = GroundLoad.load(pack, g.plots, pack.deeds, pack.cols, pack.rows) // the same deterministic load the lane ran
            val pal = a.palette; val t = assertNotNull(a.trueAtlas); val kin = assertNotNull(t.kitInland); val kw = assertNotNull(t.kitWater)
            assertFalse(pal.water.contentEquals(pal.paintWater), "the test needs PACK's kit water to differ from the painting's")
            fun drawn(d: Double, trueW: Double, key: String): FloatArray {
                g.look(30.0, 20.0, d, 0.0, trueW); g.sink.reset()
                var n = 0; while (g.sink.floats[key] == null && n++ < 200) g.frame()
                return assertNotNull(g.sink.floats[key], "$id: $key was never set at d $d")
            }
            val at48 = drawn(48.0, 0.0, "rm-map/uMpPal"); val at120 = drawn(120.0, 0.0, "rm-map/uMpPal"); val at800 = drawn(800.0, 0.0, "rm-map/uMpPal")
            val tint = GroundTables.deepTint(pal.deep, pack.realmJson())
            for (c in 0 until 3) {
                assertEquals(pal.paintWater[c].toFloat(), at48[5 * 3 + c], "$id: MAP inland water at d 48 is the painting's")
                assertEquals(kin[c].toFloat(), at120[5 * 3 + c], 1e-6f, "$id: MAP inland water at d 120 is the kit loop's")
                assertEquals((kw[c] * tint[c]).toFloat(), at800[2 * 3 + c], 1e-6f, "$id: MAP deep water at d 800 is the kit loop × the deep tint")
            }
            val gemCol = assertNotNull(g.sink.floats["rm-map/uMpGemCol"]).toList()
            val tp = drawn(1200.0, 1.0, "rm-true/uTgPal")
            assertEquals(tint.map { it.toFloat() }, tp.slice(0 until 3), "$id: TRUE's deep tint")
            assertEquals(List(3) { 0f }, tp.slice(6 until 9), "$id: TRUE's slot 2 (RM-24: no selection outline)")
            val plain = DoubleArray(3) { GroundMath.clamp(pal.deep[it] * 1.6, 0.4, 1.0) }
            if (id == "seeker-reach") {
                for (c in 0 until 3) assertEquals(1 + (plain[c] - 1) / 3, tint[c], 1e-12, "a gem-sea realm takes a third of the tint")
                assertEquals(assertNotNull(t.gemK, "the synthetic sea loop has highlights").flatMap { c -> c.map { it.toFloat() } }, gemCol, "MAP gems are the measured ratios")
                // the sparkle grows in over d 48 → 150, linear in log d (the painting at FAR has none); the parity frames sit at
                // d ≥ 150, where it is whole
                val gd = GroundTables.gemDrift(GroundTables.gemDriftLoop(pack.realmJson()))
                for ((d, k) in listOf(48.0 to 0.0, 85.0 to Math.log(85.0 / 48) / Math.log(150.0 / 48), 400.0 to 1.0)) {
                    val gem = drawn(d, 0.0, "rm-map/uMpGem")
                    assertEquals((0.03 * k).toFloat(), gem[0], 1e-7f, "gem share at d $d"); assertEquals(if (k > 0) 1f else 0f, gem[3], "gems on at d $d")
                    assertEquals(listOf(gd[0].toFloat(), gd[1].toFloat()), listOf(gem[1], gem[2]), "gem drift")
                }
            } else {
                assertEquals(plain.toList(), tint.toList(), "every other realm keeps the whole tint")
                assertEquals(List(6) { 1f }, gemCol, "no gems: the ones")
            }
        }
    }

    /**
     * ground.js update() at 205b6326 (lines 1031-1032) ends with `core.animating('ground', view.reducedMotion ? 0 :
     * Math.min(125, ready.true && w.true > 0 ? trueT.water.frameMs : 600))`, from the first frame after load() starts. So
     * GROUND keeps a resting realm drawing in every band: the chart's and MAP's glints, the cloud shade and Solana's MAP gem
     * sparkle drift (the realm's "one thing to remember") at 125 ms, TRUE's kit water loop at its own period when faster
     * (Solana's 16-frame gem loop: 110 ms). Without it a realm at rest with no LIFE clip, keep or selection in view declares
     * nothing, the idle scheduler answers NEVER and all of that freezes until the next touch. The idle policy still caps it
     * and freezes it after 60 s; reduced motion (or a safe ladder level, folded into view.reducedMotion) stops it.
     */
    @Test fun `GROUND declares the web's idle period - Solana's gem loop at TRUE, the 125 ms drift elsewhere, none under reduced motion`() {
        val solanaTrue = GroundGolden.suite("classify-seeker-reach").get("trueMeta") // the real pack's true.water / waterByClass
        fun copy(v: JsonValue) = JsonReader().parse(v.toJson(JsonWriter.OutputType.json))
        val solana = SyntheticGroundPack("seeker-reach") { m ->
            val t = m.get("true"); for (k in listOf("water", "waterByClass")) { t.remove(k); t.addChild(k, copy(solanaTrue.get(k))) }
        }
        assertEquals(110, solanaTrue.get("water").getInt("frameMs"), "the test needs Solana's real 110 ms loop")
        val queued = ArrayList<Runnable>()
        val g = GroundRig(solana, executor = Executor { queued += it })
        assertEquals(0, g.lane.idlePeriodMs(), "no realm, no declaration")
        g.lane.open(g.open)
        g.look(30.0, 20.0, 30.0, 1.0, 0.0); g.frame()
        assertEquals(125, g.lane.idlePeriodMs(), "while the pack loads the FAR chart's glints still drift (ground.js sets P when load() starts)")
        queued.forEach { it.run() }
        g.look(30.0, 20.0, 1200.0, 0.0, 1.0)
        var n = 0; while (!g.lane.readyFor(2) && n++ < 50) g.frame()
        assertTrue(g.lane.readyFor(2), "TRUE never became ready: ${g.lane.stats.error}")
        g.frame()
        assertEquals(110, g.lane.idlePeriodMs(), "TRUE on screen: Solana's gem loop frame period")
        g.look(30.0, 20.0, 700.0, 0.0, 0.4); g.frame()
        assertEquals(110, g.lane.idlePeriodMs(), "the MAP→TRUE fade already shows the loop")
        g.look(30.0, 20.0, 150.0, 0.0, 0.0); g.frame()
        assertEquals(125, g.lane.idlePeriodMs(), "MAP: the gem sparkle drift, glints and cloud shade at 8 fps")
        g.look(30.0, 20.0, 30.0, 1.0, 0.0); g.frame()
        assertEquals(125, g.lane.idlePeriodMs(), "FAR: the chart's glints")
        g.view.reducedMotion = true; g.frame()
        assertEquals(0, g.lane.idlePeriodMs(), "reduced motion (or a safe ladder level) draws no idle frames")
        g.view.reducedMotion = false
        // a slower loop than the cap still draws at the cap (Crownlands' 180 ms sea): Math.min(125, frameMs)
        val c = GroundRig(); c.openAndLoad()
        c.look(30.0, 20.0, 1200.0, 0.0, 1.0); n = 0; while (!c.lane.readyFor(2) && n++ < 50) c.frame()
        c.frame()
        assertEquals(125, c.lane.idlePeriodMs(), "Crownlands at TRUE: min(125, 180)")
        // why it matters: with GROUND's declaration alone (no LIFE, BASES or selection in view) the idle scheduler still wakes
        g.look(30.0, 20.0, 150.0, 0.0, 0.0); g.frame()
        val idle = IdleScheduler(WebPin.IDLE)
        idle.input(0L); idle.frameRendered(0L)
        idle.animating(IdleScheduler.TAG_GROUND, g.lane.idlePeriodMs()); idle.frameRendered(30_000L)
        assertEquals(125L, idle.delayMs(30_000L), "a resting realm at MAP keeps drawing at the capped 8 fps")
        idle.animating(IdleScheduler.TAG_GROUND, 0)
        assertEquals(IdleScheduler.NEVER, idle.delayMs(30_000L), "without GROUND's period the realm freezes at rest")
    }

    @Test fun `a plot on the map re-resolves only the lattice and pages it reaches`() {
        val g = GroundRig()
        g.openAndLoad()
        g.look(30.0, 20.0, 150.0, 0.0, 0.0)
        var n = 0; while (!g.lane.mapReady(g.view) && n++ < 200) g.frame()
        val resolved = g.lane.stats.latticeResolved
        g.bases.set(gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases(1L, "crownlands", intArrayOf(30), intArrayOf(20), intArrayOf(9), intArrayOf(0)))
        g.lane.basesChanged(g.bases)
        assertFalse(g.lane.mapReady(g.view), "the plot's 3×3 deeds must re-resolve")
        n = 0; while (!g.lane.mapReady(g.view) && n++ < 200) g.frame()
        val again = g.lane.stats.latticeResolved - resolved
        assertTrue(again in 1..9, "a plot re-resolved $again sub-tiles (its 3×3 deeds and apron reach at most a few)")
    }

    @Test fun `a plot on a river bends it on the worker, re-bakes its pages within the frame's upload budget and re-resolves only them`() {
        val g = GroundRig()
        g.openAndLoad()
        g.look(33.0, 20.0, 150.0, 0.0, 0.0)
        var n = 0; while (!g.lane.mapReady(g.view) && n++ < 200) g.frame()
        // the synthetic river runs through deed (33, 20): a level-10 kingdom there must push it aside (G16, one-sided bend)
        g.bases.set(gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases(2L, "crownlands", intArrayOf(33), intArrayOf(20), intArrayOf(10), intArrayOf(0)))
        g.lane.basesChanged(g.bases)
        n = 0
        while (g.lane.stats.baseJobs == 0 && n++ < 50) { g.frame(); assertTrue(g.rig.gl.calls("texSubImage3D") == 0, "no array upload") }
        assertEquals(1, g.lane.stats.baseJobs, "the base-state job never landed")
        assertTrue(g.lane.stats.riversMoved > 0, "the river was not bent round the kingdom (G16)")
        assertTrue(g.lane.stats.lineUploadBytes > 0, "the moved river pages were not re-uploaded")
        // the re-bake is the classify.js reference's: the lane's rivers equal bendRivers over the same state
        val st = g.lane.classState()!!
        val ref = Classify(g.plots).let { c -> c.bendRivers(st.lines, BaseState(st.state.cols, st.state.rows, st.state.data), st.cfg) }
        assertEquals(GroundGolden.sha256Doubles(ref.segs), GroundGolden.sha256Doubles(st.state.rivers!!.segs), "the lane's bent rivers are not classify.js bendRivers")
        n = 0; while (!g.lane.mapReady(g.view) && n++ < 200) g.frame()
        assertTrue(g.lane.mapReady(g.view), "the deeds the river moved never re-resolved")
    }

    @Test fun `a steady ground frame allocates nothing on the GL thread`() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        assertTrue(bean.isThreadAllocatedMemorySupported, "this JVM cannot count allocations: the gate would prove nothing")
        bean.isThreadAllocatedMemoryEnabled = true
        val g = GroundRig(sinkFor = { GlGroundUniforms(it, NoopGroundGl) }) // the production uniform path (locations cached)
        g.openAndLoad()
        g.look(30.0, 20.0, 150.0, 0.0, 0.0)
        repeat(120) { g.frame() }
        g.look(30.0, 20.0, 1200.0, 0.0, 1.0)
        repeat(120) { g.frame() } // pages resolved: the view is steady
        g.rig.gl.record = false; g.sink.record = false; g.rig.worker.record = false
        val tid = Thread.currentThread().id
        var best = Long.MAX_VALUE
        for (window in 0 until 5) {
            val before = bean.getThreadAllocatedBytes(tid)
            repeat(300) { i -> g.look(30.0 + (i % 3) * 0.001, 20.0, 1200.0, 0.0, 1.0); g.frame(build = false) }
            best = minOf(best, bean.getThreadAllocatedBytes(tid) - before)
            if (best == 0L) break
        }
        assertEquals(0L, best, "a steady window of 300 ground frames allocated $best bytes")
    }

    /**
     * D-NEXT (amends D-173, overview first): the engine holds a lane whose pairs are not rehearsed and calls none of its
     * update/draw hooks, so on a cold dive GROUND's finished load used to wait in its inbox until the lane was released,
     * and MAP was not ready when the player first zoomed in. adopt() runs in every work frame, held or not: it must queue
     * the uploads, poll them and turn MAP ready by itself, never draw, and never queue anything twice.
     */
    @Test fun `a held lane's adopt() queues the uploads and turns MAP ready without an update or a draw`() {
        val g = GroundRig()
        g.lane.open(g.open) // the Now executor: the load already waits in the inbox
        fun adoptFrame() { g.rig.compiler.runAll(); g.uploads.poll(g.rig.core); g.now += 16.7; check(g.rig.begin()); g.lane.adopt(g.now); g.rig.end() }
        adoptFrame()
        assertEquals("ready", g.lane.stats.status, "adopt() adopted the load")
        val queued = g.uploads.filled.size
        assertTrue(queued > 17, "the realm's textures were queued with the rehearsal's ($queued)")
        repeat(3) { adoptFrame() }
        assertEquals(queued, g.uploads.filled.size, "adopt() is idempotent: nothing is queued twice")
        assertTrue(g.lane.stats.mapReady && g.lane.readyFor(1), "MAP is ready for the player's first zoom while the lane was held: ${g.lane.stats.error}")
        assertEquals(0, g.rig.gl.draws.size, "adopt() never draws")
        assertFalse(g.lane.readyFor(2), "TRUE's record cache is sized from the screen (ground.js recCap): it waits for a frame with a view")
        g.frame()
        assertTrue(g.lane.readyFor(2), "the first update with a view sizes it")
        assertEquals(48, g.lane.stats.recPages)
    }

    /** D-NEXT: the rehearsal's 17 tiny textures lead the worker's queue (they were last: every GROUND pair waited behind
     *  ~21 MB of kit pixels, retried with a growing backoff), and MAP's kit goes up before TRUE's (MAP is the band the
     *  player zooms into first from the overview). */
    @Test fun `the worker fills the rehearsal's textures first, then MAP's kit, then TRUE's`() {
        val g = GroundRig()
        g.lane.open(g.open)
        g.look(30.0, 20.0, 18.0, 1.0, 0.0)
        g.frame(build = false)
        val pools = g.uploads.requests.map { it.first }
        assertEquals(List(17) { Gl3Pool.CORE }, pools.take(17), "the rehearsal's textures (the core pool) are the first 17 requests")
        assertTrue(pools.drop(17).all { it == Gl3Pool.REALM }, "then the realm's")
        val kit = g.uploads.filled.indexOfFirst { it[0] == 1 && it[3] == 96 && it[4] == 6 }
        val trueA = g.uploads.filled.indexOfFirst { it[0] == 1 && it[3] == 256 }
        assertTrue(kit in 0 until trueA, "the MAP kit (request $kit) before TRUE array A (request $trueA)")
    }

    /**
     * D-NEXT ENGINE contract: while GROUND's rehearsal textures are not resident, rehearse() cannot draw and the engine used
     * to count that as a failed try (1.5 s, 3 s, … backoff: seconds of the Seeker's cold dives). rehearsable() answers
     * false exactly then, so the engine skips the pair and asks again next frame; once they are resident it is true.
     */
    @Test fun `rehearsable() is false exactly while the rehearsal's own textures are not resident`() {
        val g = GroundRig()
        g.lane.open(g.open)
        g.look(30.0, 20.0, 18.0, 1.0, 0.0)
        g.frame(build = false) // adopted: programs and textures requested, the worker has filled nothing yet
        val progs = g.lane.programs()
        assertEquals(7, progs.size)
        for (p in progs) assertFalse(g.lane.rehearsable(p), "${p.name}: rehearsable before its textures landed")
        g.now += 16.7; check(g.rig.begin())
        for (p in progs) assertFalse(g.lane.rehearse(p, RealmMapEngine.TARGET_RGBA, g.view), "${p.name} drew without its textures: a try the engine counted")
        g.rig.end()
        var n = 0
        while (!progs.all { g.lane.rehearsable(it) } && n++ < 5) g.frame()
        for (p in progs) assertTrue(g.lane.rehearsable(p), "${p.name}: still not rehearsable once resident")
    }

    /**
     * P0 memory: the line field (6.3-18.7 MB of words on the real realms) was copied into a new byte array on the GL thread
     * before its fill; on the Seeker's 256 MB heap such allocations failed (OutOfMemoryError, 2026-09-26). The fill now
     * writes the int words straight into the uploader's buffer: the GPU gets the same native-order bytes, and the lane's own
     * GL-thread allocation during the adopt frame stays far below the field's size.
     */
    @Test fun `the line field uploads the same words as before, straight from its ints with no GL-thread copy`() {
        val g = GroundRig()
        g.uploads.keep = setOf(Gl3Pool.REALM to Gl3Format.R32UI)
        g.lane.open(g.open)
        val words = GroundLoad.load(g.pack, g.plots, g.pack.deeds, g.pack.cols, g.pack.rows).lineTex.words // the same deterministic load
        val before = ByteArray(words.size * 4).also { ByteBuffer.wrap(it).order(ByteOrder.nativeOrder()).asIntBuffer().put(words) } // the old copy
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        bean.isThreadAllocatedMemoryEnabled = true
        val tid = Thread.currentThread().id
        g.now += 16.7; check(g.rig.begin())
        val fills0 = g.uploads.freshAllocated; val t0 = bean.getThreadAllocatedBytes(tid)
        g.lane.adopt(g.now)
        val own = bean.getThreadAllocatedBytes(tid) - t0 - (g.uploads.freshAllocated - fills0)
        g.rig.end()
        assertEquals(1, g.uploads.kept.size, "one realm R32UI texture: the line field")
        assertContentEquals(before, g.uploads.kept.single(), "the line field's bytes changed")
        println("[ground-mem] line field ${before.size} B; the lane's own GL-thread allocation in the adopt frame $own B")
        assertTrue(own < before.size / 4, "the adopt frame allocated $own B on the GL thread for a ${before.size} B line field")
    }

    @Test fun `dispose frees every GROUND texture with glDelete only`() {
        val g = GroundRig()
        g.openAndLoad()
        val waits = g.rig.gl.blockingCalls
        g.lane.dispose()
        assertEquals(waits, g.rig.gl.blockingCalls, "dispose waited on the GPU")
        assertEquals("none", g.lane.stats.status)
        assertEquals(0, g.lane.programs().size)
        assertNull(g.lane.classState())
    }
}
