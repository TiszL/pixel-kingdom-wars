package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeShareGroup
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ManualCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The minimap draws opaque with its own GL state (owner, Seeker code-27: "the minimap sometimes turns transparent").
 * It is the last pass of the realm frame and of the leave snapshot, so it inherits whatever the lanes' passes left
 * bound: a blend, a depth test, or a colour mask without alpha would let the frame under it show through the Compose
 * frame. Each check records the state at every draw, not only after the pass.
 */
class RealmMinimapStateTest {
    /** The world fake with the state each draw saw (the recording fake keeps names and counts only). */
    private class StateAtDraw(val fake: FakeGl3) : Gl3 by fake {
        class Draw(val framebuffer: Int, val scissorW: Int, val scissorH: Int, val scissor: Boolean, val blend: Boolean,
                   val src: Int, val dst: Int, val depth: Boolean, val mask: Int, val instances: Int)
        val draws = ArrayList<Draw>()
        private fun snap(instances: Int) {
            draws += Draw(fake.framebuffer, fake.scissorBox[2], fake.scissorBox[3], fake.scissorTest, fake.blend, fake.blendSrcRgb,
                fake.blendDstRgb, fake.depthTest, fake.colorMask, instances)
        }
        override fun drawArrays(mode: Int, first: Int, count: Int) { snap(1); fake.drawArrays(mode, first, count) }
        override fun drawArraysInstanced(mode: Int, first: Int, count: Int, instances: Int) { snap(instances); fake.drawArraysInstanced(mode, first, count, instances) }
    }

    /** A detail lane that ends its last pass (fx) with every state the minimap must not inherit, as a careless lane might. */
    private class DirtyLane(private val core: Gl3Core) : RealmLane {
        override val name = "dirty"
        private val none = emptyList<Gl3Program>()
        var dirtied = 0
        override fun programs(): List<Gl3Program> = none
        override fun bandSet(): Int = 0
        override fun settled(): Boolean = true
        override fun update(view: RealmView) {}
        override fun draw(view: RealmView, pass: Int) {
            if (pass != RealmLane.PASS_FX) return
            core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_ONE, GL20.GL_ONE)
            core.enable(GL20.GL_DEPTH_TEST); core.colorMask(true, true, true, false)
            dirtied++
        }
        override fun rehearse(program: Gl3Program, target: Int, view: RealmView): Boolean = false
        override fun dispose() {}
    }

    private val group = FakeShareGroup()
    private val fake = FakeGl3(group, "world")
    private val gl = StateAtDraw(fake)
    private val worker = FakeGl3(group, "worker")
    private val compiler = ManualCompiler(ProgramBuilder(worker, null, "RealmView", 0))
    private val core = Gl3Core(gl, compiler, 256 * 1024L, strict = true).apply { resize(914, 2034) }
    private val uploads = FakeRealmUploads(worker)
    private var nowMs = 1000.0
    private val lane = DirtyLane(core)
    private val engine = RealmMapEngine(
        core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
        RealmLoader(FixturePack("overview"), PNG_DECODER), null, uploads, DirectExecutor, { nowMs }, RealmDiveFade.PLAN_FADE_MS,
        lanes = listOf(lane),
    ).apply { setViewport(914, 2034, 2.0) }

    private fun begin() { compiler.runAll(); nowMs += 16.667; check(core.beginFrame((nowMs * 1e6).toLong(), 1L)) }
    private fun end() = core.endFrame((nowMs * 1e6).toLong())

    /** Dive-ready, entered, a minimap of 130 × 100 CSS px (260 × 200 device px), bases on it, a few realm frames. */
    private fun onTheMap() {
        assertTrue(engine.prepare("alpha"))
        var n = 0
        while (!engine.ready && n < 300) {
            begin(); engine.update(nowMs, true); uploads.poll(core); engine.rehearseStep(nowMs); core.beginScreen(0f, 0f, 0f, 1f); end(); n++
        }
        assertTrue(engine.ready, "dive-ready (status ${engine.status})")
        val g = assertNotNull(engine.grid)
        assertTrue(engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        engine.setMinimapRect(12.0, 700.0, 130.0, 100.0)
        val xs = ArrayList<Int>(); val ys = ArrayList<Int>()
        for (dy in 0 until g.rows) for (dx in 0 until g.cols) if ((engine.deeds[dy * g.cols + dx].toInt() and 0xff) == 255 && xs.size < 6) {
            val tile = g.tileId(dx, dy); xs += tile % RealmGrid.LATTICE_W; ys += tile / RealmGrid.LATTICE_W
        }
        assertTrue(xs.isNotEmpty(), "the fixture realm has deeds of its own")
        engine.setBases(WorldBases(1, "alpha", xs.toIntArray(), ys.toIntArray(), IntArray(xs.size) { 1 + it }, IntArray(xs.size) { RealmBases.FLAG_OCCUPIED }))
        repeat(4) { realmFrame() }
        assertTrue(engine.minimap.points > 0, "the minimap has its bases")
    }

    private fun realmFrame() {
        begin(); engine.update(nowMs, true); uploads.poll(core)
        if (engine.waiting) engine.rehearseStep(nowMs)
        engine.frame(nowMs, nowMs.toLong(), false)
        end()
    }

    private fun minimapDraws(framebufferIsScreen: Boolean) =
        gl.draws.filter { it.scissor && it.scissorW == 260 && it.scissorH == 200 && (it.framebuffer == 0) == framebufferIsScreen }

    /** The chart opaque (blend off, depth off, RGBA written), then the dots blended over it (SRC_ALPHA, 1−SRC_ALPHA). */
    private fun assertOpaque(draws: List<StateAtDraw.Draw>, where: String) {
        assertTrue(draws.size >= 2, "$where: the chart and the dots were drawn (${draws.size} minimap draws)")
        val chart = draws.first()
        assertEquals(1, chart.instances, "$where: the chart is one full-screen pass")
        assertFalse(chart.blend, "$where: the chart is drawn with blend off (a lane's additive blend would show the frame under it)")
        assertFalse(chart.depth, "$where: the chart is drawn with depth off")
        assertEquals(15, chart.mask, "$where: the chart writes R, G, B and alpha (a mask without alpha keeps the lane's alpha)")
        val dots = draws.drop(1)
        assertTrue(dots.all { it.blend && it.src == GL20.GL_SRC_ALPHA && it.dst == GL20.GL_ONE_MINUS_SRC_ALPHA }, "$where: the dots blend over the chart")
        assertTrue(dots.all { !it.depth && it.mask == 15 }, "$where: the dots draw with depth off and every channel")
    }

    @Test fun `the minimap draws opaque over whatever the lanes' last pass left, on the screen and in the leave snapshot`() {
        onTheMap()
        gl.draws.clear()
        realmFrame()
        assertTrue(lane.dirtied > 0, "the dirty lane's fx pass ran before the minimap")
        assertOpaque(minimapDraws(framebufferIsScreen = true), "screen")

        // the leave: the realm's last frame into the fade snapshot (the owner saw the transparency around leaves)
        gl.draws.clear()
        begin(); engine.update(nowMs, false)
        assertTrue(engine.renderSnapshot(nowMs.toLong(), false))
        core.beginScreen(0f, 0f, 0f, 1f); engine.fade.start(RealmDiveFade.LEAVE, nowMs); engine.compositeFade(nowMs + 100); end()
        assertOpaque(minimapDraws(framebufferIsScreen = false), "leave snapshot")
    }

    @Test fun `the minimap pass sets its own blend, depth and colour mask and leaves blend and scissor off`() {
        onTheMap()
        val p = assertNotNull(engine.programs)
        val tex = assertNotNull(core.texture2D(Gl3Pool.CORE, 4, 4, Gl3Format.RGBA8)) // ready at once: the pass only binds it
        gl.draws.clear()
        begin(); core.beginScreen(0f, 0f, 0f, 1f)
        // everything the minimap must not inherit, set directly on the core
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_ONE, GL20.GL_ONE); core.enable(GL20.GL_DEPTH_TEST); core.colorMask(true, true, true, false)
        engine.minimap.draw(p.minimap, p.dots, tex, tex, tex, engine.view, 2034)
        assertOpaque(minimapDraws(framebufferIsScreen = true), "direct")
        assertFalse(fake.blend, "blend is off after the pass"); assertFalse(fake.depthTest, "depth is off after the pass")
        assertEquals(15, fake.colorMask, "every channel is writable after the pass")
        assertFalse(fake.scissorTest, "the scissor is off after the pass")
        assertEquals(listOf(0, 0, 914, 2034), fake.viewportBox.toList(), "the viewport is the whole target again")
        end()
    }
}
