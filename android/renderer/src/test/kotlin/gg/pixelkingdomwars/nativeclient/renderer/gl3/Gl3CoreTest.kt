package gg.pixelkingdomwars.nativeclient.renderer.gl3

import com.badlogic.gdx.graphics.GL20
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.test.*
import org.junit.Test

/** A world core on a recording fake, with a worker fake in the same share group and a hand-driven compiler. */
internal class CoreRig(strict: Boolean = true, coldUploadBytes: Long = 256 * 1024L, wake: Runnable = Runnable {}) {
    val group = FakeShareGroup()
    val world = FakeGl3(group, "world")
    val worker = FakeGl3(group, "worker")
    val compiler = ManualCompiler(ProgramBuilder(worker, null, VIEW_BLOCK, 0))
    val core = Gl3Core(world, compiler, coldUploadBytes, strict, wake).also { it.resize(914, 2034) }
    var now = 0L

    fun frame(contextId: Long = 1L, body: Gl3Core.() -> Unit = {}): Gl3FrameReport {
        now += 16_666_667L
        check(core.beginFrame(now, contextId)) { "frame skipped" }
        core.body()
        return core.endFrame(now)
    }

    /** A program built by the worker and adopted by one frame. */
    fun ready(name: String, fs: String = FS): Gl3Program {
        val program = core.program(name, VS, fs)
        compiler.runAll(); frame()
        check(program.ready) { "$name not adopted" }
        return program
    }

    companion object {
        const val VIEW_BLOCK = "RealmView"
        const val VS = "#version 300 es\nlayout(std140) uniform RealmView { vec4 uCam; };\nvoid main() { gl_Position = vec4(0.0); }"
        const val FS = "#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }"
    }
}

/**
 * The N1 host's pacing contract on a fake vsync (plan §5.6): [vsync] runs a frame only when one was asked for, by the
 * core's wake ([woken], set from any thread, the pacer's `markDirty`) or by [Gl3Core.needsFrame] after the last frame
 * (the host's `idle.invalidate()`). At most one frame per vsync. [frames] counts what it ran.
 */
internal class OnDemandHost(private val rig: CoreRig, private val woken: AtomicBoolean) {
    var frames = 0; private set
    private var again = false

    fun vsync(body: Gl3Core.() -> Unit = { beginScreen(0f, 0f, 0f, 1f) }): Boolean {
        val asked = woken.getAndSet(false) or again
        if (!asked) return false
        rig.frame(body = body)
        frames++
        again = rig.core.needsFrame
        return true
    }
}

class Gl3CoreTest {
    private fun bytes(n: Int) = ByteBuffer.allocateDirect(n)

    @Test fun `a draw under a program still building is skipped and counted and the frame never waits for the build`() {
        val rig = CoreRig()
        val program = rig.core.program("rm-map", CoreRig.VS, CoreRig.FS)
        rig.frame { beginScreen(0f, 0f, 0f, 1f); assertFalse(use(program)); fullscreen() }
        assertEquals(0L, rig.world.drawCount)
        assertEquals(1L, rig.core.stats.skippedDraws)

        rig.group.holdFences()
        rig.compiler.runAll() // the worker linked it; its fence has not signalled yet
        rig.frame { beginScreen(0f, 0f, 0f, 1f); use(program); fullscreen() }
        assertEquals(Gl3Program.PENDING, program.state, "a program is adopted only after its fence signals")
        assertEquals(0L, rig.world.drawCount)

        rig.group.signalAll()
        val report = rig.frame { beginScreen(0f, 0f, 0f, 1f); assertTrue(use(program)); fullscreen() }
        assertEquals(1L, rig.world.drawCount)
        assertEquals(1, report.adoptions)
        assertTrue(report.cold, "an adoption and a first draw are one-off work, never a steady sample")
        assertEquals(0, rig.world.blockingCalls, "the world context issued a blocking status or sync query")
        assertTrue(rig.worker.blockingCalls > 0, "the worker, not the GL thread, waits for the link")
        assertEquals(0, rig.group.program(program.handle)!!.blockBinding, "the view block is bound on the worker")
    }

    @Test fun `without a worker context programs build before the first world frame and a later build is refused`() {
        val group = FakeShareGroup()
        val world = FakeGl3(group)
        val core = Gl3Core(world, DirectProgramCompiler(ProgramBuilder(world, null, CoreRig.VIEW_BLOCK, 0)), 256 * 1024L, strict = false)
        val globe = core.program("globe", CoreRig.VS, CoreRig.FS) // behind the Compose loading state
        assertTrue(core.beginFrame(1L, 1L)); core.beginScreen(0f, 0f, 0f, 1f)
        assertTrue(core.use(globe)); core.fullscreen(); core.endFrame(1L)
        assertTrue(core.firstWorldFrameDrawn)
        val blockingBefore = world.blockingCalls

        val late = core.program("rm-true", CoreRig.VS, CoreRig.FS)
        assertEquals(Gl3Program.FAILED, late.state)
        assertEquals(blockingBefore, world.blockingCalls, "no GL-thread link after the first world frame")
        assertEquals(1L, core.stats.orderViolations)

        val strict = Gl3Core(FakeGl3(), DirectProgramCompiler(ProgramBuilder(FakeGl3(), null, CoreRig.VIEW_BLOCK, 0)), 1L, strict = true)
        strict.beginFrame(1L, 1L); strict.beginScreen(0f, 0f, 0f, 1f); strict.endFrame(1L)
        assertFailsWith<IllegalStateException> { strict.program("late", CoreRig.VS, CoreRig.FS) }
    }

    /**
     * The world renders on demand and sits at 0 fps when idle (plan §5.6, §5.8), so a program the worker finishes
     * between frames must itself schedule the frame that adopts it, or dive readiness and the first draws wait for the
     * next touch. The host here runs a frame ONLY when asked: by the core's wake, or by [Gl3Core.needsFrame] after a
     * frame, which is the whole contract the N1 host implements.
     */
    @Test fun `a build ending between frames wakes the on-demand host, which then renders only the frames the core asks for`() {
        val woken = AtomicBoolean(false)
        val rig = CoreRig(wake = { woken.set(true) })
        val host = OnDemandHost(rig, woken)
        val program = rig.core.program("rm-map", CoreRig.VS, CoreRig.FS)
        assertFalse(rig.core.needsFrame, "a build still queued on the worker needs no frame: the world stays at 0 fps")
        repeat(10) { assertFalse(host.vsync(), "no frame while the worker links") }

        rig.group.holdFences()
        thread(name = "world-gl-worker") { rig.compiler.runAll() }.join() // the worker publishes BUILT off the GL thread
        assertTrue(woken.get(), "the builder's publish must wake the host; nothing else would")
        assertTrue(host.vsync(), "the wake schedules exactly the next frame")
        assertEquals(Gl3Program.PENDING, program.state, "adopted only once its fence has signalled")
        assertTrue(rig.core.needsFrame, "a pending program fence is work only another frame can finish")
        assertTrue(host.vsync(), "so the host keeps pacing, one frame per vsync")
        rig.group.signalAll()
        assertTrue(host.vsync())
        assertTrue(program.ready)
        assertFalse(rig.core.needsFrame)
        repeat(10) { assertFalse(host.vsync(), "adopted: back to 0 fps") }

        val broken = rig.core.program("rm-broken", CoreRig.VS, "#version 300 es\n#error broken\n")
        thread(name = "world-gl-worker") { rig.compiler.runAll() }.join()
        assertTrue(host.vsync(), "a failed build wakes the host too, so the failure is reported without waiting for input")
        assertEquals(Gl3Program.FAILED, broken.state)
        assertFalse(host.vsync())
        assertEquals(4, host.frames, "every frame was asked for, and no more")
    }

    @Test fun `a worker-filled texture adopted on a pending fence keeps frames coming until it is ready, then none`() {
        val woken = AtomicBoolean(false)
        val rig = CoreRig(wake = { woken.set(true) })
        val host = OnDemandHost(rig, woken)
        val texture = rig.core.reserve(Gl3Pool.REALM, array = false, width = 4, height = 4, layers = 1, format = Gl3Format.RGBA8)!!
        rig.group.holdFences()
        val name = rig.worker.genTexture(); val fence = rig.worker.fenceSync() // what StagingUploader's worker hands over
        woken.set(true) // (the uploader's own completion wake)
        assertTrue(host.vsync { adopt(texture, name, fence) }) // StagingUploader.poll adopts after beginFrame
        assertTrue(rig.core.needsFrame, "the adopted texture becomes READY only in a later frame's fence poll")
        assertTrue(host.vsync())
        assertFalse(texture.ready)
        rig.group.signalAll()
        assertTrue(host.vsync())
        assertTrue(texture.ready)
        assertFalse(host.vsync(), "ready: back to 0 fps")
        assertEquals(3, host.frames)
    }

    /**
     * Without a shared context every program links on the GL thread. After a context loss the old code relinked all of
     * them inside one beginFrame, mid-session: seconds on a Seeker, and libGDX's pause handshake kills the process after
     * 4 s (plan §5.9). Now the restore frame links nothing and each later frame at most one, behind the loading state.
     */
    @Test fun `a context loss without a worker context relinks one program per frame, never all in one frame`() {
        val world = FakeGl3(FakeShareGroup())
        val core = Gl3Core(world, DirectProgramCompiler(ProgramBuilder(world, null, CoreRig.VIEW_BLOCK, 0)), 256 * 1024L, strict = true)
        val programs = listOf("globe", "rm-map", "rm-true").map { core.program(it, CoreRig.VS, CoreRig.FS) }
        var now = 0L
        var context = 1L
        fun links() = world.calls("linkProgram") + world.calls("programBinary")
        fun frame(): Int {
            val before = links()
            now += 16_666_667L
            check(core.beginFrame(now, context))
            core.beginScreen(0f, 0f, 0f, 1f)
            for (program in programs) { core.use(program); core.fullscreen() }
            core.endFrame(now)
            return links() - before
        }
        frame()
        assertTrue(programs.all { it.ready } && core.firstWorldFrameDrawn)

        context = 2L // the world context was replaced mid-session
        val perFrame = arrayListOf(frame())
        assertEquals(1, core.stats.contextLosses)
        assertEquals(0, perFrame[0], "the restore frame links nothing")
        assertTrue(core.restoring, "the host shows the loading state and the notice")
        assertTrue(core.needsFrame, "the restore must not wait for input to continue")
        assertFalse(core.firstWorldFrameDrawn, "a screen pass while restoring is not the first world frame")
        val before = links()
        val late = core.program("rm-life", CoreRig.VS, CoreRig.FS) // a lane asks for a program meanwhile
        assertEquals(before, links(), "queued behind the others, not linked inside program()")
        assertEquals(Gl3Program.PENDING, late.state)
        assertEquals(4, core.pendingPrograms)

        while (core.needsFrame && perFrame.size < 20) perFrame += frame()
        assertTrue(perFrame.all { it <= 1 }, "at most one GL-thread link per frame, got $perFrame")
        assertEquals(4, perFrame.sum(), "every program relinked exactly once")
        assertTrue((programs + late).all { it.ready })
        assertFalse(core.restoring)
        assertEquals(0, core.pendingPrograms)

        frame()
        assertTrue(core.firstWorldFrameDrawn, "the world is back")
        assertFailsWith<IllegalStateException>("the no-link-after-the-first-world-frame rule applies again") {
            core.program("after", CoreRig.VS, CoreRig.FS)
        }
    }

    @Test fun `dispose during a restore only deletes, including programs that never had a build in this context`() {
        val world = FakeGl3(FakeShareGroup())
        val core = Gl3Core(world, DirectProgramCompiler(ProgramBuilder(world, null, CoreRig.VIEW_BLOCK, 0)), 256 * 1024L, strict = true)
        core.program("globe", CoreRig.VS, CoreRig.FS)
        assertTrue(core.beginFrame(1L, 1L)); core.beginScreen(0f, 0f, 0f, 1f); core.endFrame(1L)
        assertTrue(core.beginFrame(2L, 2L)); core.endFrame(2L) // restore frame
        core.program("rm-life", CoreRig.VS, CoreRig.FS) // queued, never submitted
        assertTrue(core.restoring)
        world.log.clear()
        core.dispose()
        assertEquals(emptyList(), world.log.filterNot { it.startsWith("delete") }, "libGDX waits on the UI thread for dispose()")
        assertFalse(core.restoring)
    }

    @Test fun `first draws are tracked per program and state so a variant drawn only opaque is still cold when drawn blended`() {
        val rig = CoreRig()
        val program = rig.ready("rm-map")
        fun opaque(core: Gl3Core) { core.beginScreen(0f, 0f, 0f, 1f); core.use(program); core.disable(GL20.GL_BLEND); core.fullscreen() }
        val first = rig.frame { opaque(this) }
        assertEquals(1, first.firstDraws)
        val after = rig.frame { opaque(this) }
        assertEquals(0, after.firstDraws)
        assertTrue(after.cold, "the frame after a cold frame waits on that work too (core.js lastCold)")
        assertFalse(rig.frame { opaque(this) }.cold, "a steady frame is a real sample")

        val blended = rig.frame {
            beginScreen(0f, 0f, 0f, 1f); use(program)
            enable(GL20.GL_BLEND); blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA); fullscreen()
        }
        assertEquals(1, blended.firstDraws, "a new blend state is a new pipeline variant on Mali")
        assertTrue(blended.cold)

        val target = rig.core.texture2D(Gl3Pool.CORE, 8, 8, Gl3Format.RGBA8)!!
        val offscreen = rig.frame { offscreen(target); use(program); disable(GL20.GL_BLEND); fullscreen(); beginScreen(0f, 0f, 0f, 1f) }
        assertEquals(1, offscreen.firstDraws, "the same state into another target format is another variant")
    }

    @Test fun `a rehearsal draws into the scratch target under a locked 1x1 scissor and restores every state`() {
        val rig = CoreRig()
        val stand = rig.ready("life-stand")
        val minimap = rig.ready("minimap")
        val scratch = rig.core.texture2D(Gl3Pool.CORE, 4, 4, Gl3Format.RGB8)!!
        val depth = rig.core.texture2D(Gl3Pool.CORE, 4, 4, Gl3Format.DEPTH16)!!
        val liveBefore = rig.core.stats.liveFirstDraws
        rig.frame {
            // what the previous frame's passes left bound
            use(minimap); enable(GL20.GL_CULL_FACE); colorMask(true, true, true, false); enable(GL20.GL_BLEND); blendFunc(GL20.GL_ONE, GL20.GL_ONE)
            val before = snapshot(rig.world)
            val drew = rehearse(scratch, depth, forScreen = true, testDepth = true) {
                use(stand); disable(GL20.GL_BLEND); colorMask(true, true, true, true); disable(GL20.GL_CULL_FACE)
                scissor(0, 0, 500, 500); disable(GL20.GL_SCISSOR_TEST) // a lane can neither widen nor drop the box
                fullscreen()
            }
            assertTrue(drew)
            val draw = rig.world.draws.last()
            assertEquals(scratch.name, draw.colorTexture, "a rehearsal never draws into a live target")
            assertTrue(draw.scissor); assertEquals(1, draw.scissorW); assertEquals(1, draw.scissorH)
            assertEquals(before, snapshot(rig.world), "the rehearsal leaked state into the frame's passes")

            // the live screen pass in the rehearsed state is no longer a first draw
            beginScreen(0f, 0f, 0f, 1f); use(stand); disable(GL20.GL_BLEND); disable(GL20.GL_CULL_FACE)
            enable(GL20.GL_DEPTH_TEST); depthFunc(GL20.GL_LEQUAL); depthMask(true); fullscreen()
        }
        assertEquals(liveBefore, rig.core.stats.liveFirstDraws, "the rehearsal did not warm the pair the screen pass uses")
        assertEquals(1L, rig.core.stats.rehearsalDraws)
    }

    @Test fun `rehearsal runs only before the frame's passes`() {
        val rig = CoreRig()
        val scratch = rig.core.texture2D(Gl3Pool.CORE, 4, 4, Gl3Format.RGB8)!!
        rig.frame {
            beginScreen(0f, 0f, 0f, 1f)
            assertFailsWith<IllegalStateException> { rehearse(scratch, null, forScreen = true, testDepth = false) {} }
        }
    }

    @Test fun `offscreen passes come first and the screen is bound once, cleared at its start and its depth invalidated`() {
        val rig = CoreRig()
        val program = rig.ready("rm-map")
        val low = rig.core.lowres(0.5)!!
        rig.world.framebufferHistory.clear(); rig.world.clears = 0; rig.world.invalidations = 0
        rig.frame { offscreen(low); use(program); fullscreen(); beginScreen(0f, 0f, 0f, 1f); use(program); fullscreen() }
        assertEquals(listOf(low.fbos!![0], 0), rig.world.framebufferHistory, "a tiler flushes on every framebuffer bind")
        assertEquals(2, rig.world.clears)
        assertEquals(1, rig.world.invalidations, "the screen's depth must not be stored at the swap")
        assertEquals(457, low.width); assertEquals(1017, low.height)

        assertFailsWith<IllegalStateException> { rig.frame { beginScreen(0f, 0f, 0f, 1f); offscreen(low) } }
        val lenient = CoreRig(strict = false)
        val target = lenient.core.texture2D(Gl3Pool.CORE, 8, 8, Gl3Format.RGBA8)!!
        lenient.frame { beginScreen(0f, 0f, 0f, 1f); offscreen(target); beginScreen(0f, 0f, 0f, 1f) }
        assertEquals(2L, lenient.core.stats.orderViolations)
        assertEquals(0, lenient.world.framebuffer, "a refused pass leaves the screen bound")
    }

    @Test fun `a live array never receives texSubImage and its layers arrive through the staging copy`() {
        val rig = CoreRig()
        val chart16 = rig.core.array(Gl3Pool.REALM, 512, 512, 16, Gl3Format.RGBA8)!!
        rig.core.upload(chart16, 3, 0, 0, 0, 512, 512, bytes(512 * 512 * 4)) // not sampled yet: allowed
        rig.frame { beginScreen(0f, 0f, 0f, 1f); bindTexture(1, chart16) }
        assertTrue(chart16.sampled)
        assertFailsWith<IllegalStateException> { rig.core.upload(chart16, 4, 0, 0, 0, 64, 64, bytes(64 * 64 * 4)) }
        assertEquals(1, rig.group.texture(chart16.name)!!.subImages.size, "Mali would ghost the whole 16 MB array")

        val staging = rig.worker.genTexture()
        rig.worker.bindTexture(GL20.GL_TEXTURE_2D, staging)
        val fence = rig.worker.fenceSync()
        rig.world.log.clear()
        val report = rig.frame { copyStaged(staging, GL20.GL_TEXTURE_2D, chart16, 4, 0, fence) }
        assertEquals(1, rig.group.texture(chart16.name)!!.copies)
        val log = rig.world.log
        assertTrue(log.indexOf("waitSync") in 0 until log.indexOf("copyImageSubData"), "the copy waits on the GPU, never the CPU")
        assertEquals(0, rig.world.blockingCalls)
        assertTrue(report.cold, "a 1 MB layer copy is one-off work")
    }

    @Test fun `after the first world frame a large GL-thread upload is refused and a small live 2D update is allowed`() {
        val rig = CoreRig()
        val baseState = rig.core.texture2D(Gl3Pool.REALM, 128, 128, Gl3Format.RGBA8UI)!!
        val painting = rig.core.texture2D(Gl3Pool.GLOBE, 1024, 1024, Gl3Format.RGBA8)!!
        rig.frame { beginScreen(0f, 0f, 0f, 1f); bindTexture(3, baseState) }
        rig.core.upload(baseState, 0, 0, 0, 0, 128, 128, bytes(128 * 128 * 4))
        assertEquals(1, rig.group.texture(baseState.name)!!.subImages.size)
        assertFailsWith<IllegalStateException> { rig.core.upload(painting, 0, 0, 0, 0, 1024, 1024, bytes(1024 * 1024 * 4)) }
    }

    @Test fun `the allocator evicts the least recently used evictable texture first and refuses only when nothing can go`() {
        val rig = CoreRig()
        val mib = 1024L * 1024
        rig.core.setCaps(globe = 50 * mib, realm = 3 * mib, combined = 200 * mib)
        val evicted = ArrayList<Int>()
        fun page() = rig.core.array(Gl3Pool.REALM, 512, 512, 1, Gl3Format.RGBA8)?.also { t -> t.evictable = true; t.onEvict = { evicted += it.uid } }
        val a = page()!!; val b = page()!!; val c = page()!!
        rig.frame { beginScreen(0f, 0f, 0f, 1f); bindTexture(0, a) } // a is now the most recently used
        val d = page()!!
        assertEquals(listOf(b.uid), evicted, "the least recently used page goes, not the one just drawn")
        assertEquals(Gl3Texture.FREED, b.state)
        assertEquals(3 * mib, rig.core.stats.gpuBytes(Gl3Pool.REALM))

        rig.frame {
            beginScreen(0f, 0f, 0f, 1f); bindTexture(0, a); bindTexture(1, c); bindTexture(2, d)
            assertNull(page(), "every resident page is drawn this frame: evicting one would break the frame")
        }
        assertEquals(1L, rig.core.stats.refusals)
        assertEquals(listOf(b.uid), evicted)

        for (t in listOf(a, c, d)) t.evictable = false
        assertNull(page(), "nothing may go: refuse rather than break the band cap")
        assertEquals(2L, rig.core.stats.refusals)
        assertEquals(3 * mib, rig.core.stats.gpuBytes(Gl3Pool.REALM))
    }

    @Test fun `a pool over its own cap evicts only from itself and the combined cap evicts across pools`() {
        val mib = 1024L * 1024
        val own = CoreRig()
        own.core.setCaps(globe = 2 * mib, realm = 2 * mib, combined = 3 * mib)
        val globe = own.core.array(Gl3Pool.GLOBE, 512, 512, 1, Gl3Format.RGBA8)!!.also { it.evictable = true }
        val realm1 = own.core.array(Gl3Pool.REALM, 512, 512, 1, Gl3Format.RGBA8)!!.also { it.evictable = true }
        own.core.array(Gl3Pool.REALM, 512, 512, 1, Gl3Format.RGBA8)!!.also { it.evictable = true }
        assertNotNull(own.core.array(Gl3Pool.REALM, 512, 512, 1, Gl3Format.RGBA8))
        assertEquals(Gl3Texture.FREED, realm1.state)
        assertEquals(Gl3Texture.READY, globe.state, "the realm pool's own cap evicted a globe texture")

        val combined = CoreRig()
        combined.core.setCaps(globe = 2 * mib, realm = 4 * mib, combined = 3 * mib)
        val sleeping = combined.core.array(Gl3Pool.GLOBE, 512, 512, 1, Gl3Format.RGBA8)!!.also { it.evictable = true }
        val page1 = combined.core.array(Gl3Pool.REALM, 512, 512, 1, Gl3Format.RGBA8)!!.also { it.evictable = true }
        combined.core.array(Gl3Pool.REALM, 512, 512, 1, Gl3Format.RGBA8)!!.also { it.evictable = true }
        assertNotNull(combined.core.array(Gl3Pool.REALM, 512, 512, 1, Gl3Format.RGBA8))
        assertEquals(Gl3Texture.FREED, sleeping.state, "the combined 200 MB-style cap frees the least recently used, in either pool")
        assertEquals(Gl3Texture.READY, page1.state)
    }

    @Test fun `a changed context handle goes stale, restores core objects, resubmits programs and runs the lanes' restore`() {
        val rig = CoreRig()
        val program = rig.ready("rm-map")
        val texture = rig.core.texture2D(Gl3Pool.REALM, 4, 4, Gl3Format.RGBA8)!!
        var restores = 0
        rig.core.onRestore { restores++ }
        val report = rig.frame(contextId = 2L) {
            bindTexture(0, texture)
            assertEquals(0, rig.world.unitTextures[0], "a texture of the dead context must bind nothing")
        }
        assertTrue(report.contextChanged)
        assertEquals(1, rig.core.stats.contextLosses)
        assertEquals(1, restores)
        assertEquals(Gl3Program.PENDING, program.state, "programs come back through the worker (binary cache), not the GL thread")
        assertEquals(listOf(1), rig.compiler.epochs, "the worker context must be rebuilt in the new share group")
        assertEquals(0L, rig.core.stats.gpuBytes(Gl3Pool.REALM), "dead textures still counted against the cap")
        rig.compiler.runAll(); rig.frame(contextId = 2L)
        assertTrue(program.ready)
    }

    @Test fun `a reset skips frames until a new context arrives and a vanished sentinel restores at once`() {
        val rig = CoreRig()
        rig.ready("rm-map")
        rig.world.resetStatus = 0x8253 // GUILTY_CONTEXT_RESET
        assertFalse(rig.core.beginFrame(1L, 1L))
        rig.world.resetStatus = 0 // reported once; the context stays dead under LOSE_CONTEXT_ON_RESET
        assertFalse(rig.core.beginFrame(2L, 1L), "restored onto a dead context")
        assertTrue(rig.core.beginFrame(3L, 7L)); rig.core.endFrame(3L)
        assertEquals(1, rig.core.stats.contextLosses)

        val other = CoreRig()
        val program = other.ready("rm-map")
        other.group.programs[program.handle] = null // same handle value, fresh context: our objects are gone
        assertTrue(other.core.beginFrame(10L, 1L)); other.core.endFrame(10L)
        assertEquals(1, other.core.stats.contextLosses)
        assertEquals(Gl3Program.PENDING, program.state)
    }

    @Test fun `dispose only deletes, never waits, queries or links`() {
        val rig = CoreRig()
        rig.ready("rm-map")
        rig.core.texture2D(Gl3Pool.REALM, 4, 4, Gl3Format.RGBA8)
        rig.core.uniformBlock(0, 112)
        rig.group.holdFences()
        rig.core.program("rm-true", CoreRig.VS, CoreRig.FS); rig.compiler.runAll() // built, not yet adopted
        rig.frame { beginScreen(0f, 0f, 0f, 1f) }
        rig.world.log.clear()
        val blocking = rig.world.blockingCalls
        rig.core.dispose()
        assertTrue(rig.world.log.isNotEmpty())
        assertEquals(emptyList(), rig.world.log.filterNot { it.startsWith("delete") }, "libGDX waits on the UI thread for dispose()")
        assertEquals(blocking, rig.world.blockingCalls)
        assertTrue(rig.compiler.disposed)
    }

    @Test fun `a fence still pending two frames later flags the frame GPU-bound and yields a latency lower bound`() {
        val rig = CoreRig()
        rig.group.holdFences()
        rig.frame()
        assertFalse(rig.frame().gpuBound, "one frame in flight is normal pipelining")
        assertTrue(rig.frame().gpuBound, "frame 1's fence was still pending when frame 3 started")
        assertEquals(1L, rig.core.stats.gpuBoundFrames)
        rig.group.signalAll()
        val report = rig.frame()
        assertFalse(report.gpuBound)
        assertEquals(3, report.gpuSampleCount)
        assertEquals(33.3, report.gpuSamplesMs[0], 0.1, "last unsignalled poll minus submit, never inflated by CPU stalls")
    }

    @Test fun `uniform blocks upload in place to their binding`() {
        val rig = CoreRig()
        val view = rig.core.uniformBlock(0, 112)
        view.floats.put(0, 1.5f); view.ints.put(24, 7)
        rig.world.log.clear()
        rig.core.upload(view)
        assertEquals(listOf("bindBuffer", "bufferSubData", "bindBufferBase"), rig.world.log)
        assertFailsWith<IllegalArgumentException> { rig.core.uniformBlock(0, 100) }
    }

    private data class State(val program: Int, val blend: Boolean, val src: Int, val dst: Int, val depth: Boolean, val depthWrite: Boolean,
                             val depthFunc: Int, val cull: Boolean, val scissor: Boolean, val color: Int, val vao: Int, val framebuffer: Int)
    private fun snapshot(gl: FakeGl3) = State(gl.program, gl.blend, gl.blendSrcRgb, gl.blendDstRgb, gl.depthTest, gl.depthWrite, gl.depthFunc,
        gl.cull, gl.scissorTest, gl.colorMask, gl.vertexArray, gl.framebuffer)
}

class LongSetAndLruTest {
    @Test fun `the pair set grows without losing members`() {
        val set = LongSet(4)
        for (i in 1L..1000L) assertTrue(set.add(i * 0x1_0000_0001L))
        for (i in 1L..1000L) { assertTrue(set.contains(i * 0x1_0000_0001L)); assertFalse(set.add(i * 0x1_0000_0001L)) }
        assertFalse(set.contains(0x7777L))
        assertEquals(1000, set.size)
    }

    @Test fun `the lru evicts the least recently used and a read refreshes recency`() {
        val evicted = ArrayList<String>()
        val lru = Gl3Lru<String, Int>(2) { k, _ -> evicted += k }
        lru.put("a", 1); lru.put("b", 2)
        assertEquals(1, lru["a"])
        lru.put("c", 3)
        assertEquals(listOf("b"), evicted)
        assertEquals(listOf("a", "c"), lru.keys())
        lru.put("a", 4)
        assertEquals(listOf("b", "a"), evicted, "a replaced value is released too")
    }
}
