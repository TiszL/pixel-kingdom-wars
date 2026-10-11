package gg.pixelkingdomwars.nativeclient.scene.world

import gg.pixelkingdomwars.nativeclient.renderer.gl3.DirectProgramCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramJob
import gg.pixelkingdomwars.nativeclient.scene.SharedContextCompiler
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.3 and §5.9: programs compile and link on ONE worker context in the world context's share
 * group, never on the GL thread after the first world frame; the GL thread never waits for the worker; a context
 * change never adopts a program from the dead share group; and leaving the World tab (libGDX's UI-thread pause
 * handshake) never waits for the worker.
 */
class SharedContextCompilerTest {
    private val ids = SharedIds()
    private val contexts = FakeWorkerContexts(ids)
    private val world = RecordingGl3("world", ids)
    private var share: Any = "world-context-1"
    private val cacheThreads = ArrayList<String>()
    private val setups = ArrayList<SharedContextCompiler.Setup>()

    private fun setup(): SharedContextCompiler.Setup =
        SharedContextCompiler.create(world.gl, contexts, share, { share }, { synchronized(cacheThreads) { cacheThreads += Thread.currentThread().name }; null })
            .also { setups += it }

    @After fun stopWorkers() { setups.forEach { it.worker?.dispose() } }

    /** Blocks the worker until [release] (a stand-in for a long link) and says when it has started. */
    private class Gate(epoch: Int = 0) : WorkerTask(epoch) {
        val started = CountDownLatch(1)
        private val release = CountDownLatch(1)
        override fun run(scope: WorkerScope) { started.countDown(); release.await(10, TimeUnit.SECONDS) }
        fun open() = release.countDown()
    }

    private fun job(name: String, epoch: Int = 0) = ProgramJob(name, "#version 300 es\n// vs $name", "#version 300 es\n// fs $name").also { it.epoch = epoch }

    @Test fun `submit returns at once and the worker builds FIFO on its own thread and context`() {
        val setup = setup()
        val compiler = setup.compiler
        val worker = checkNotNull(setup.worker) { "the shared worker context must exist" }
        assertFalse("the shared compiler must never block the GL thread", compiler.blocksCaller)
        val gate = Gate(); worker.post(gate)
        assertTrue(gate.started.await(5, TimeUnit.SECONDS))
        val jobs = listOf(job("a"), job("b"), job("c"))
        val t0 = System.nanoTime()
        jobs.forEach(compiler::submit)
        val submitMs = (System.nanoTime() - t0) / 1e6
        assertTrue("submit took $submitMs ms while the worker was busy: it must only enqueue", submitMs < 50)
        assertTrue("nothing may build while the worker is busy", jobs.all { it.state == ProgramJob.QUEUED })
        gate.open()
        assertTrue(eventually { jobs.all { it.state == ProgramJob.BUILT } })
        val context = contexts.created.single()
        val sources = context.recorder.named("shaderSource").map { it.args[1] as String }.filter { "// vs" in it }
        assertEquals(listOf("a", "b", "c").map { "#version 300 es\n// vs $it" }, sources)
        assertEquals("every GL call of a build runs on the worker thread", setOf(worker.threadName), context.recorder.threads())
        assertEquals(worker.threadName, context.currentOn)
        assertTrue("the world context issued no compile or link", world.count("linkProgram") == 0 && world.count("compileShader") == 0)
        assertEquals("the binary cache opens on the worker (it deletes directories: disk I/O)", listOf(worker.threadName), cacheThreads)
    }

    @Test fun `a context change drops older jobs and rebuilds the worker context in the new share group first`() {
        val setup = setup()
        val compiler = setup.compiler; val worker = setup.worker!!
        val gate = Gate(); worker.post(gate)
        assertTrue(gate.started.await(5, TimeUnit.SECONDS))
        val stale = job("stale", epoch = 0)
        compiler.submit(stale)
        share = "world-context-2"
        compiler.contextChanged(1)
        val fresh = job("fresh", epoch = 1)
        compiler.submit(fresh)
        gate.open()
        assertTrue(eventually { fresh.state == ProgramJob.BUILT })
        assertEquals("a job of the dead share group is never built (its program could never be adopted)", ProgramJob.QUEUED, stale.state)
        assertEquals(2, contexts.created.size)
        val (old, new) = contexts.created
        assertEquals("world-context-2", new.share)
        assertEquals("the old worker context is destroyed by the worker itself", worker.threadName, old.destroyedOn)
        assertTrue("the new job built on the new context", new.recorder.count("linkProgram") == 1 && old.recorder.count("linkProgram") == 0)
        assertEquals(2, worker.generation)
    }

    @Test fun `dispose is O(1) and never joins, even while the worker is inside a long build`() {
        val setup = setup()
        val worker = setup.worker!!
        val gate = Gate(); worker.post(gate)
        assertTrue(gate.started.await(5, TimeUnit.SECONDS))
        val queued = job("queued")
        setup.compiler.submit(queued)
        val t0 = System.nanoTime()
        setup.compiler.dispose()
        val disposeMs = (System.nanoTime() - t0) / 1e6
        assertTrue("dispose took $disposeMs ms with the worker busy: libGDX runs it inside a UI-thread wait", disposeMs < 50)
        assertFalse("dispose must not have waited for the worker", worker.stopped)
        gate.open()
        assertTrue(eventually { worker.stopped })
        assertEquals("queued work is dropped, not built after dispose", ProgramJob.QUEUED, queued.state)
        assertEquals("the worker destroys its own context", worker.threadName, contexts.created.single().destroyedOn)
        val late = job("late"); setup.compiler.submit(late)
        assertEquals(ProgramJob.QUEUED, late.state)
    }

    @Test fun `without a shared context programs build on the GL thread before the first world frame only`() {
        contexts.refuse = true
        val setup = setup()
        assertNull(setup.worker)
        assertTrue(setup.compiler is DirectProgramCompiler && setup.compiler.blocksCaller)
        val core = Gl3Core(world.gl, setup.compiler, 0L, strict = false).apply { resize(8, 8) }
        val early = core.program("early", "vs-early", "fs-early")
        assertTrue(core.beginFrame(1L, 1L))
        assertEquals("a program built before the first frame is adopted at the next frame start", Gl3Program.READY, early.state)
        core.beginScreen(0f, 0f, 0f, 1f)
        core.endFrame(2L)
        val late = core.program("late", "vs-late", "fs-late")
        assertEquals("after the first world frame a GL-thread link is refused", Gl3Program.FAILED, late.state)
        assertEquals(1, world.count("linkProgram"))
    }

    @Test fun `a program built on the worker is adopted only after its fence has signalled`() {
        val setup = setup()
        val core = Gl3Core(world.gl, setup.compiler, 0L, strict = true).apply { resize(8, 8) }
        world.signalled = { false }
        val program = core.program("realm", "vs", "fs")
        assertTrue("the build has ended and published its fence", eventually { setup.worker!!.tasksRun == 1L })
        repeat(3) { i -> assertTrue(core.beginFrame(10L + i, 1L)); core.endFrame(10L + i) }
        assertEquals("an unsignalled fence means the link may still be running on the GPU queue", Gl3Program.PENDING, program.state)
        assertTrue("the GL thread only ever polls (timeout 0)", world.named("clientWaitSync").all { it.args[2] == 0L })
        world.signalled = { true }
        assertTrue(core.beginFrame(20L, 1L)); core.endFrame(20L)
        assertEquals(Gl3Program.READY, program.state)
    }

    @Test fun `a worker context that cannot be made current fails its jobs instead of leaving them queued forever`() {
        contexts.makeCurrentFails = true
        val setup = setup()
        val job = job("orphan")
        setup.compiler.submit(job)
        assertTrue(eventually { job.state == ProgramJob.FAILED })
        assertTrue(job.error!!.contains("could not be made current"))
        assertTrue(setup.worker!!.failure != null)
        assertEquals(0, contexts.created.single().recorder.count("linkProgram"))
    }
}
