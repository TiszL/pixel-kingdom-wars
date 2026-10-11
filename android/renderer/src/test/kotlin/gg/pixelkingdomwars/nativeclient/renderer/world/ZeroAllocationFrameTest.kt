package gg.pixelkingdomwars.nativeclient.renderer.world

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.gl3.*
import java.lang.management.ManagementFactory
import kotlin.test.*
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.9: a steady world frame allocates nothing on the GL thread (a GC pause on an A55 is a
 * hitch). 600 fake frames through every hot path of this lane — the core's frame, passes, program/texture binds,
 * draws, fences, UBO upload and the host's needsFrame query; the intent drain; the scheduler, guard, ladder and
 * sampler; the input scale; the WorldFrame publish — must not move `getCurrentThreadAllocatedBytes` by a single byte.
 *
 * Two gates run this class:
 * - **Interpreted, strict** (`:renderer:zeroAllocationInterpreted`, which `:renderer:test` depends on): the JVM runs
 *   with `-Xint`, so no JIT swaps code under the loop and no escape analysis hides an allocation ART would make, and
 *   ONE window of 600 frames must be exactly 0 bytes: an allocation made at least once in any 600 consecutive steady
 *   frames fails, whatever a JIT would do. (Checked 2026-09-25: a 24-byte leak every 900th frame failed here and
 *   passed the HotSpot gate below.) The run refuses to pass without `-Xint`, so the gate cannot silently prove less.
 * - **HotSpot, windowed** (`:renderer:test`): up to [WINDOWS] windows of 600 frames, one of which must be exactly zero.
 *   HotSpot can allocate on the calling thread while its JIT swaps the code under the loop: on 2026-09-25, on a loaded
 *   Mac, a window measured 952 bytes in eleven one-off String/byte[] pairs, attributed to
 *   `Intrinsics.checkNotNullParameter` under a just-deoptimised `InputScale` frame (JFR), while the same 600 frames
 *   measured 0 bytes under `-Xint`. This gate alone would pass an allocation rarer than one per window, which is why
 *   the interpreted gate exists; it stays because it runs the frames as compiled code.
 */
class ZeroAllocationFrameTest {
    @Test fun `600 steady world frames allocate nothing on the GL thread`() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        assumeAllocationCounting(bean)
        val interpreted = System.getProperty(INTERPRETED_PROPERTY) == "true"
        if (interpreted) check("-Xint" in ManagementFactory.getRuntimeMXBean().inputArguments) {
            "the interpreted gate is running without -Xint: its single window would prove only what the JIT lets through"
        }
        val maxWindows = if (interpreted) 1 else WINDOWS

        val group = FakeShareGroup()
        val gl = FakeGl3(group)
        val worker = FakeGl3(group, "worker").apply { record = false }
        val compiler = ManualCompiler(ProgramBuilder(worker, null, "RealmView", 0))
        val core = Gl3Core(gl, compiler, WebPin.GPU_SAFE.coldUploadBytes, strict = true).apply { resize(914, 2034) }
        val ground = core.program("rm-map", VS, FS)
        val life = core.program("life-stand", VS, FS)
        compiler.runAll()
        val chart = core.array(Gl3Pool.REALM, 512, 512, 16, Gl3Format.RGBA8)!!
        val lowres = core.lowres(0.5)!!
        val view = core.uniformBlock(0, 112)
        val sprites = core.vertexArray(16)

        val guard = HangGuard(WebPin.GPU_SAFE).apply { start(null, 0L) }
        val ladder = FrameLadder(LadderPolicy.PLAN, WebPin.LADDER_INPUTS)
        val idle = IdleScheduler(WebPin.IDLE).apply { input(0L); animating(IdleScheduler.TAG_WATER, 16) }
        val sampler = WorldFrameSampler()
        val scale = InputScale().apply { set(1050, 2310, 800, 1760) }
        val intents = WorldIntents {}
        val sink = WorldIntentSink { }
        val exchange = WorldFrameExchange(32)
        val rects = FloatArray(16); val bufferRects = FloatArray(16)
        val anchors = FloatArray(8); val viewAnchors = FloatArray(8)
        var nanos = 0L

        fun frame() {
            nanos += 16_666_667L
            val ms = nanos / 1_000_000L
            check(core.beginFrame(nanos, 1L))
            intents.drain(sink)
            idle.setMoving(true)
            idle.delayMs(ms)
            view.floats.put(0, ms.toFloat()); view.ints.put(24, ms.toInt())
            core.upload(view)
            core.offscreen(lowres)
            core.use(ground); core.bindTexture(1, chart); core.fullscreen()
            core.beginScreen(0f, 0f, 0f, 1f)
            core.use(life); core.enable(GL20.GL_DEPTH_TEST); core.depthFunc(GL20.GL_LEQUAL)
            core.bindVertexArray(sprites); core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, 40_000); core.bindVertexArray(null)
            core.disable(GL20.GL_DEPTH_TEST)
            val report = core.endFrame(nanos)
            for (i in 0 until report.gpuSampleCount) guard.sample(report.gpuSamplesMs[i], report.gpuSamplesCold[i])
            ladder.hangLevel(guard.level)
            ladder.motionInterval(16.6, report.cold)
            idle.frameRendered(ms)
            if (core.needsFrame) idle.invalidate() // the host asks after every frame (render on demand)
            sampler.frame(nanos, WorldScene.REALM, idle.motion, 4_000_000L, 1_000_000L)
            scale.viewRectsToBuffer(rects, 4, bufferRects)
            scale.bufferPointsToView(anchors, 4, viewAnchors)
            val back = exchange.back()
            back.anchorCount = 0; back.engine = WorldEngine.REALM; back.ladderLevel = ladder.level
            back.addAnchor(1, viewAnchors[0], viewAnchors[1])
            exchange.publish()
            exchange.latest()
        }

        gl.record = false
        repeat(300) { frame() } // warm up: adoption, first draws, JIT
        assertTrue(ground.ready && life.ready)
        var allocated = -1L
        var windows = 0
        while (allocated != 0L && windows < maxWindows) {
            val before = bean.currentThreadAllocatedBytes
            repeat(600) { frame() }
            allocated = bean.currentThreadAllocatedBytes - before
            windows++
        }
        assertEquals(0L, allocated, "all $windows windows of 600 steady world frames allocated on the GL thread (the last: $allocated bytes)")
        assertEquals(0L, core.stats.orderViolations)
        assertTrue(gl.drawCount >= 1800, "the frames did not draw")
    }

    private fun assumeAllocationCounting(bean: com.sun.management.ThreadMXBean) {
        check(bean.isThreadAllocatedMemorySupported) { "this JVM cannot count thread allocations: the test would prove nothing" }
        bean.isThreadAllocatedMemoryEnabled = true
    }

    private companion object {
        /** HotSpot windows of 600 frames: enough for the JIT to settle under load; a per-frame allocation shows in all. */
        const val WINDOWS = 20
        /** Set by the `zeroAllocationInterpreted` task (renderer/build.gradle.kts) together with `-Xint`. */
        const val INTERPRETED_PROPERTY = "pkw.zeroAllocation.interpreted"
        const val VS = "#version 300 es\nlayout(std140) uniform RealmView { vec4 uCam; };\nvoid main() { gl_Position = vec4(0.0); }"
        const val FS = "#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { o = vec4(1.0); }"
    }
}
