package gg.pixelkingdomwars.nativeclient.scene.world

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.gl3.DirectProgramCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramJob
import gg.pixelkingdomwars.nativeclient.scene.PixelSource
import gg.pixelkingdomwars.nativeclient.scene.SharedContextCompiler
import gg.pixelkingdomwars.nativeclient.scene.StagingUploader
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.7: uploads never ghost a live Mali texture and never put swizzle work or a CPU wait on the GL
 * thread. Fresh textures are built and filled on the worker and adopted on a fence; live arrays get whole layers
 * through a ring of staging textures and a GPU-side copy; a staging slot is never overwritten while the GPU may still
 * be copying from it; and a context change never lets a dead share group's name or fence reach the new context.
 *
 * The world renders on demand and sits at 0 fps when idle, and the worker is the ONE FIFO thread for program builds and
 * uploads. So nothing on the worker may wait for a GL frame: a layer waiting for a slot parks instead of blocking the
 * worker, a slot comes back when its copy fence signals (checked on the worker), and the uploader asks for every frame
 * it needs. N0 review defects 1 and 2 (2026-09-25) are the tests that say "no frame" or "context change".
 */
class StagingUploaderTest {
    private val ids = SharedIds()
    private val contexts = FakeWorkerContexts(ids)
    private val world = RecordingGl3("world", ids)
    private val worker = WorldGlWorker(contexts, contexts.create("world-1")!!, { null }, "RealmView", 0)
    private val workerGl get() = contexts.created.last().recorder
    private val decodeThreads = AtomicInteger()
    private val decode = Executors.newFixedThreadPool(2) { r -> Thread(r, "world-decode-${decodeThreads.incrementAndGet()}").apply { isDaemon = true } }
    private val pool = DirectBufferPool(1L shl 20, 1L shl 20)
    private val core = Gl3Core(world.gl, DirectProgramCompiler(ProgramBuilder(world.gl, null, "RealmView", 0)), 256 * 1024L, strict = true).apply { resize(8, 8) }
    private val uploaders = ArrayList<StagingUploader>()
    private var nanos = 1L

    /** Frames the uploader asked for ([StagingUploader] `onReady`, the pacer's markDirty on the device). */
    private val frameRequests = AtomicInteger()

    private fun uploader(ring: Int = 3, band: Int = StagingUploader.FILL_BAND_BYTES) =
        StagingUploader(worker, decode, pool, onReady = { frameRequests.incrementAndGet() }, ringSize = ring, fillBandBytes = band).also { uploaders += it }

    @After fun tearDown() { uploaders.forEach { it.dispose() }; worker.dispose(); decode.shutdownNow() }

    private fun frame(uploader: StagingUploader, budget: Long = Long.MAX_VALUE, contextId: Long = 1L, c: Gl3Core = core): Int {
        check(c.beginFrame(nanos++, contextId))
        val copies = uploader.poll(c, budget)
        c.endFrame(nanos++)
        return copies
    }

    /** Whether the GPU has finished: fences are shared by the share group, so the world and the worker agree. */
    private fun gpu(done: Boolean) { world.signalled = { done }; workerGl.signalled = { done } }

    /** The fence the GL thread created for the [n]-th staged copy (the first fenceSync after that copyImageSubData). */
    private fun copyFence(n: Int = 0): Long {
        val calls = synchronized(world.calls) { world.calls.toList() }
        val copy = calls.withIndex().filter { it.value.name == "copyImageSubData" }[n].index
        return calls.drop(copy).first { it.name == "fenceSync" }.result as Long
    }

    private val decodedOn = CopyOnWriteArrayList<String>()
    private val fill = PixelSource { layer, level, w, h, out ->
        decodedOn += Thread.currentThread().name
        for (i in 0 until w * h * 4) out.put(i, (layer * 16 + level).toByte())
    }

    private fun liveArray(): Gl3Texture {
        val array = core.array(Gl3Pool.REALM, 4, 4, 3, Gl3Format.RGBA8)!!
        check(core.beginFrame(nanos++, 1L)); core.bindTexture(0, array); core.endFrame(nanos++)
        check(array.sampled)
        return array
    }

    @Test fun `fresh textures are decoded off the GL thread, built on the worker and adopted only after its fence`() {
        val u = uploader()
        world.signalled = { false }
        val texture = u.fresh(core, Gl3Pool.REALM, true, 4, 4, 2, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP, fill)!!
        assertEquals(Gl3Texture.PENDING, texture.state)
        assertTrue(eventually { frame(u); u.freshAdopted == 1L })
        repeat(2) { frame(u) }
        assertEquals("an unsignalled worker fence: the layers may still be in flight", Gl3Texture.PENDING, texture.state)
        world.signalled = { true }
        frame(u)
        assertEquals(Gl3Texture.READY, texture.state)
        assertEquals(2, decodedOn.size)
        assertTrue("decode runs on the decode pool: $decodedOn", decodedOn.all { it.startsWith("world-decode-") })
        assertEquals(1, workerGl.count("texStorage3D")); assertEquals(2, workerGl.count("texSubImage3D"))
        assertEquals(setOf(worker.threadName), workerGl.threads())
        for (upload in listOf("texStorage2D", "texStorage3D", "texSubImage2D", "texSubImage3D"))
            assertEquals("the GL thread uploaded nothing ($upload)", 0, world.count(upload))
    }

    /**
     * Owner 2026-09-27 (the Phase E islands "take long time to load"): a big fresh level went up as one texSubImage3D from
     * one buffer the size of the level (an island's near level 0 is 16 MiB, a 24 MiB pool shared with the realm uploads)
     * and held the one worker queue for all of it. A level over the band cap, from a source that can decode rows, is now
     * decoded and uploaded in bands of whole rows, none over the cap, each its own worker item, still never on the GL
     * thread; a level under the cap, or a whole-level source, is one fill as before.
     */
    @Test fun `a fresh level over the band cap goes up in row bands under the cap, each its own worker item, never on the GL thread`() {
        val cap = 1024
        val u = uploader(band = cap)
        val rowCalls = CopyOnWriteArrayList<IntArray>()
        val rows = object : PixelSource {
            override fun decodesRows(): Boolean = true
            override fun decode(layer: Int, level: Int, width: Int, height: Int, out: java.nio.ByteBuffer) {
                decodedOn += Thread.currentThread().name
                for (i in 0 until width * height * 4) out.put(i, level.toByte())
            }
            override fun decodeRows(layer: Int, level: Int, width: Int, height: Int, y0: Int, rows: Int, out: java.nio.ByteBuffer): Boolean {
                decodedOn += Thread.currentThread().name
                rowCalls += intArrayOf(layer, level, y0, rows)
                for (i in 0 until width * rows * 4) out.put(i, (y0 + i / (width * 4)).toByte())
                return true
            }
        }
        // 32² RGBA8 = 4096 B at level 0 (four bands of 8 rows), 1024 B at level 1 (one fill: not over the cap), 2 layers
        val acquired = pool.acquires
        val texture = u.fresh(core, Gl3Pool.GLOBE, true, 32, 32, 2, Gl3Format.RGBA8, 2, Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP, rows)!!
        assertTrue(eventually { frame(u); texture.state == Gl3Texture.READY })
        val subs = workerGl.named("texSubImage3D").map { c -> (0..7).map { (c.args[it] as Int) } }
        val level0 = subs.filter { it[1] == 0 }
        assertEquals("two layers × four bands at level 0: $subs", 8, level0.size)
        for (layer in 0..1) assertEquals("whole rows, in order, covering the level once", listOf(0, 8, 16, 24), level0.filter { it[4] == layer }.map { it[3] })
        assertTrue("no band over the cap", subs.all { it[5] * it[6] * 4 <= cap })
        assertEquals("level 1 is one whole fill per layer (x, y, layer, w, h, depth)", listOf(listOf(0, 0, 0, 16, 16, 1), listOf(0, 0, 1, 16, 16, 1)),
            subs.filter { it[1] == 1 }.map { it.subList(2, 8) })
        assertEquals("the row source is asked only for the level over the cap", 8, rowCalls.size)
        assertTrue("decoded on the decode pool: $decodedOn", decodedOn.all { it.startsWith("world-decode-") })
        assertEquals(setOf(worker.threadName), workerGl.threads())
        assertEquals("the GL thread uploaded nothing", 0, world.count("texSubImage3D") + world.count("texSubImage2D"))
        assertEquals("every band's buffer went back to the pool", 0L, pool.outstandingBytes)
        assertEquals("one buffer per band and per whole level, none taken to be thrown away", 2L * (4 + 1), pool.acquires - acquired)
        // a source that decodes whole levels only is filled as before: one texSubImage3D per (layer, level)
        val before = workerGl.count("texSubImage3D")
        val whole = u.fresh(core, Gl3Pool.GLOBE, true, 32, 32, 1, Gl3Format.RGBA8, 1, Gl3Sampling.LINEAR, Gl3Wrap.CLAMP, fill)!!
        assertTrue(eventually { frame(u); whole.state == Gl3Texture.READY })
        assertEquals(1, workerGl.count("texSubImage3D") - before)
    }

    /**
     * Review 2026-09-27 (minor 4): the band path took a band buffer before it asked the source for rows, so every big
     * level of a whole-level source (every realm upload over 2 MiB) paid a throwaway acquire, which blocks at the 24 MiB
     * cap while other uploads hold it. The source says whether it decodes rows before any buffer is taken.
     */
    @Test fun `a whole-level source over the band cap takes one buffer per level and is never asked for rows`() {
        val u = uploader(band = 1024)
        val asked = AtomicInteger()
        val whole = object : PixelSource {
            override fun decode(layer: Int, level: Int, width: Int, height: Int, out: java.nio.ByteBuffer) = fill.decode(layer, level, width, height, out)
            override fun decodeRows(layer: Int, level: Int, width: Int, height: Int, y0: Int, rows: Int, out: java.nio.ByteBuffer): Boolean {
                asked.incrementAndGet(); return false
            }
        }
        val before = pool.acquires
        // 32² RGBA8: level 0 is 4096 B (over the 1024 B cap), level 1 1024 B, level 2 256 B
        val texture = u.fresh(core, Gl3Pool.GLOBE, true, 32, 32, 1, Gl3Format.RGBA8, 3, Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP, whole)!!
        assertTrue(eventually { frame(u); texture.state == Gl3Texture.READY })
        assertEquals("one buffer per level: none taken for a band and handed back", 3L, pool.acquires - before)
        assertEquals("a whole-level source is never asked for rows", 0, asked.get())
        assertEquals(3, workerGl.count("texSubImage3D"))
    }

    @Test fun `a live array layer arrives through a staging texture and a GPU-side copy, never texSubImage on the array`() {
        val array = liveArray()
        val u = uploader()
        assertTrue(u.layer(core, array, 1, 0, fill))
        assertTrue(eventually { frame(u) == 1 })
        val stagingFence = workerGl.named("fenceSync").single().result as Long
        val copy = world.named("copyImageSubData").single()
        assertEquals(GL20.GL_TEXTURE_2D, copy.args[1])
        assertEquals(GL30.GL_TEXTURE_2D_ARRAY, copy.args[7])
        assertEquals("destination layer", 1, copy.args[11])
        assertEquals(listOf(4, 4, 1), copy.args.subList(12, 15))
        val waits = world.named("waitSync")
        assertEquals("the GPU waits for the worker's fill, the CPU never does", listOf(stagingFence), waits.map { it.args[0] })
        assertTrue(world.calls.indexOf(waits.single()) < world.calls.indexOf(copy))
        assertEquals("a live array never receives texSubImage", 0, world.count("texSubImage3D") + world.count("texSubImage2D"))
        assertEquals(1, workerGl.count("texSubImage2D")); assertEquals(1, workerGl.count("texStorage2D"))
    }

    @Test fun `a staging slot is refilled only after its copy has finished on the GPU, and no GL frame is needed for that`() {
        val array = liveArray()
        val u = uploader(ring = 1)
        assertTrue(u.layer(core, array, 0, 0, fill)); assertTrue(u.layer(core, array, 1, 0, fill))
        assertTrue("the second layer parks for the one slot", eventually { workerGl.count("texSubImage2D") == 1 && u.parkedLayers == 1 && u.workerWaits > 0 })
        gpu(done = false) // the copy (and every fence) is still running on the GPU
        assertEquals(1, frame(u)) // the copy frame hands the slot back to the worker WITH the copy's fence
        val fence = copyFence()
        val calls = synchronized(world.calls) { world.calls.toList() }
        assertTrue("the copy fence is flushed before the worker waits on it from another context",
            calls.drop(calls.indexOfFirst { it.name == "fenceSync" && it.result == fence }).any { it.name == "flush" })
        Thread.sleep(50)
        assertEquals("the worker must not overwrite a texture the GPU may still copy from", 1, workerGl.count("texSubImage2D"))
        assertTrue("the worker checks the GL thread's copy fence itself", workerGl.named("clientWaitSync").any { it.args[0] == fence })
        assertTrue("its waits are bounded turns, never a blocking wait", workerGl.named("clientWaitSync").all { (it.args[2] as Long) <= StagingUploader.COPY_WAIT_NS })
        assertTrue(u.copyFenceWaits > 0)
        gpu(done = true) // from here on NO frame is driven
        assertTrue("the slot comes back without a GL frame", eventually { workerGl.count("texSubImage2D") == 2 })
        assertTrue("the worker that waited on the copy fence deletes it", workerGl.named("deleteSync").any { it.args[0] == fence })
        assertTrue("the GL thread never deletes a fence it handed to the worker", world.named("deleteSync").none { it.args[0] == fence })
        assertEquals("one ring slot, reused", 1L, u.stagingCreated)
        assertTrue(eventually { u.pendingCompletions == 1 })
        assertEquals(1, frame(u))
        assertEquals(2, world.count("copyImageSubData"))
    }

    @Test fun `with no frame after the copy frame the waiting layer still fills and asks for the frame that copies it`() {
        val array = liveArray()
        val u = uploader(ring = 1)
        assertTrue(u.layer(core, array, 0, 0, fill)); assertTrue(u.layer(core, array, 1, 0, fill))
        assertTrue("a finished layer asks for a frame", eventually { u.parkedLayers == 1 && u.pendingCompletions == 1 && frameRequests.get() == 1 })
        val asked = frameRequests.get()
        assertEquals(1, frame(u)) // the only frame: 0 fps from here, as on the idle world tab
        assertTrue("the parked layer fills with no further frame", eventually { workerGl.count("texSubImage2D") == 2 })
        assertTrue("and asks for the frame that will copy it", eventually { frameRequests.get() > asked && u.pendingCompletions == 1 })
        assertEquals(0, u.parkedLayers)
    }

    @Test fun `a layer waiting for a staging slot never holds up program builds or fresh uploads on the one worker`() {
        val array = liveArray()
        val u = uploader(ring = 1)
        assertTrue(u.layer(core, array, 0, 0, fill)); assertTrue(u.layer(core, array, 1, 0, fill))
        assertTrue("no frame has run: the only slot is out and the second layer waits", eventually { u.parkedLayers == 1 })
        val compiler = SharedContextCompiler(worker) { "world-1" }
        val job = ProgramJob("realm-life", "#version 300 es\n// vs", "#version 300 es\n// fs").also { it.epoch = core.epoch }
        compiler.submit(job)
        assertTrue("a program build behind the waiting layer runs without a GL frame", eventually(2_000) { job.state == ProgramJob.BUILT })
        val texture = u.fresh(core, Gl3Pool.REALM, false, 4, 4, 1, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP, fill)!!
        assertTrue("so does a fresh upload", eventually(2_000) { u.pendingCompletions == 2 })
        assertEquals(Gl3Texture.PENDING, texture.state)
        assertEquals("the waiting layer is still parked, not dropped", 1, u.parkedLayers)
    }

    @Test fun `a context change while a layer waits for a slot lets the worker rebuild and adopt the resubmitted programs`() {
        var share: Any = "world-1"
        val c = Gl3Core(world.gl, SharedContextCompiler(worker) { share }, 256 * 1024L, strict = true).apply { resize(8, 8) }
        val program = c.program("realm-chart", "#version 300 es\n// vs chart", "#version 300 es\n// fs chart")
        val u = uploader(ring = 1)
        assertTrue(eventually { frame(u, c = c); program.ready })
        val array = c.array(Gl3Pool.REALM, 4, 4, 3, Gl3Format.RGBA8)!!
        check(c.beginFrame(nanos++, 1L)); c.bindTexture(0, array); c.endFrame(nanos++)
        assertTrue(u.layer(c, array, 0, 0, fill)); assertTrue(u.layer(c, array, 1, 0, fill))
        assertTrue("the second layer waits for the only slot, which is out at the GL thread", eventually { u.parkedLayers == 1 && u.pendingCompletions == 1 })
        share = "world-2" // the GL thread now has a new context: Gl3Core restores and resubmits every program
        assertTrue("the worker rebuilds in the new share group and the resubmitted program adopts",
            eventually { frame(u, contextId = 2L, c = c); program.ready && c.epoch == 1 })
        assertEquals(2, contexts.created.size)
        assertEquals("world-2", contexts.created.last().share)
        assertTrue("the dead epoch's parked layer is dropped and its buffer released", eventually { u.parkedLayers == 0 && pool.outstandingBytes == 0L })
        assertEquals("nothing of the dead context is copied into the new one", 0, world.count("copyImageSubData"))
    }

    @Test fun `copies the budget held back ask for another frame, and an idle uploader asks for none`() {
        val array = liveArray()
        val u = uploader()
        for (layer in 0 until 3) assertTrue(u.layer(core, array, layer, 0, fill))
        assertTrue(eventually { u.pendingCompletions == 3 && frameRequests.get() == 3 }) // each completion asked once
        var asked = frameRequests.get()
        assertEquals(1, frame(u, budget = 1))
        assertEquals("two copies left: one more paced frame is requested", asked + 1, frameRequests.get())
        asked = frameRequests.get()
        assertEquals(1, frame(u, budget = 1)); assertEquals(asked + 1, frameRequests.get())
        asked = frameRequests.get()
        assertEquals(1, frame(u, budget = 1))
        assertEquals("nothing left: no frame is requested, the world can reach 0 fps", asked, frameRequests.get())
        assertEquals(0, frame(u)); assertEquals(asked, frameRequests.get())
    }

    @Test fun `adopting a fresh texture asks for the frame that reads its fence`() {
        val u = uploader()
        val texture = u.fresh(core, Gl3Pool.REALM, false, 4, 4, 1, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP, fill)!!
        assertTrue(eventually { u.pendingCompletions == 1 && frameRequests.get() == 1 })
        val asked = frameRequests.get()
        frame(u)
        assertEquals(1L, u.freshAdopted)
        assertEquals("adopted this frame, READY only when a later frame sees the fence", asked + 1, frameRequests.get())
        frame(u)
        assertEquals(Gl3Texture.READY, texture.state)
    }

    @Test fun `a context without a copy path refuses live layers instead of never copying them`() {
        val array = liveArray()
        val logged = CopyOnWriteArrayList<String>()
        val u = StagingUploader(worker, decode, pool, stagingCopy = false, log = { logged += it }).also { uploaders += it }
        assertFalse("ES 3.0/3.1 without GL_EXT_copy_image: the caller must use a fresh texture", u.layer(core, array, 1, 0, fill))
        assertFalse(u.layer(core, array, 2, 0, fill))
        assertEquals("said once, not per layer", 1, logged.size)
        assertEquals(0, decodedOn.size)
        assertEquals(0, frame(u))
        assertEquals(0, world.count("copyImageSubData"))
    }

    @Test fun `the per-frame copy budget always issues one copy and then stops`() {
        val array = liveArray()
        val u = uploader()
        for (layer in 0 until 3) assertTrue(u.layer(core, array, layer, 0, fill))
        assertTrue(eventually { u.pendingCompletions == 3 })
        assertEquals(1, frame(u, budget = 1))
        assertEquals(1, frame(u, budget = 1))
        assertEquals(1, frame(u, budget = Long.MAX_VALUE))
        assertEquals(0, frame(u))
    }

    @Test fun `completions from a lost context never touch the new context`() {
        val array = liveArray()
        val u = uploader()
        assertTrue(u.layer(core, array, 2, 0, fill))
        assertTrue(eventually { u.pendingCompletions == 1 })
        val deadFence = workerGl.named("fenceSync").single().result as Long
        assertEquals("a new context handle: every object of the old one is gone", 0, frame(u, contextId = 2L))
        assertEquals(0, world.count("copyImageSubData"))
        assertTrue("the dead fence is neither waited on nor deleted in the new context",
            (world.named("waitSync") + world.named("deleteSync")).none { it.args[0] == deadFence })
    }

    @Test fun `a failed decode frees the reservation and deletes the worker's texture`() {
        val u = uploader()
        val broken = PixelSource { _, _, _, _, _ -> throw IllegalStateException("corrupt pack file") }
        val texture = u.fresh(core, Gl3Pool.REALM, false, 4, 4, 1, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP, broken)!!
        assertTrue(eventually { frame(u); texture.state == Gl3Texture.FREED })
        val name = workerGl.named("genTexture").single().result
        assertEquals(listOf(name), world.named("deleteTexture").map { it.args[0] })
        assertEquals("the reservation left the allocator tally", 0L, core.stats.gpuBytes(Gl3Pool.REALM))
    }

    /**
     * P0 (2026-09-26 Seeker OutOfMemoryError): a realm released mid-upload (a leave, its eviction, another realm prepared)
     * frees textures whose fills are still queued on the decode pool. Each fill takes a Java-heap buffer on ART; decoding
     * them for a texture nobody will draw only grew the peak that ran the heap out.
     */
    @Test fun `a texture freed before its fills decode is never decoded or uploaded, and its worker name goes`() {
        val held = HeldDecode()
        val u = StagingUploader(worker, held, pool, onReady = { frameRequests.incrementAndGet() }).also { uploaders += it }
        val texture = u.fresh(core, Gl3Pool.REALM, true, 4, 4, 3, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP, fill)!!
        core.free(texture) // the GL thread drops it before the decode pool reaches it
        held.runAll()
        assertEquals("not one layer decoded", 0, decodedOn.size)
        assertEquals("no decode buffer taken", 0L, pool.outstandingBytes)
        assertTrue("the worker's name for it is deleted on the GL thread", eventually { frame(u); world.count("deleteTexture") == 1 })
        assertEquals("nothing uploaded into it", 0, workerGl.count("texSubImage3D"))
        assertEquals(0L, u.freshAdopted)
    }

    @Test fun `a texture freed while its fills decode stops at the layer in hand`() {
        val held = HeldDecode()
        val u = StagingUploader(worker, held, pool, onReady = { frameRequests.incrementAndGet() }).also { uploaders += it }
        lateinit var texture: Gl3Texture
        val freeing = PixelSource { layer, level, w, h, out ->
            fill.decode(layer, level, w, h, out)
            if (layer == 1) core.free(texture) // released while its second layer decodes
        }
        texture = u.fresh(core, Gl3Pool.REALM, true, 4, 4, 4, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP, freeing)!!
        held.runAll()
        assertEquals("layers 2 and 3 are never decoded", 2, decodedOn.size)
        assertTrue("layer 1's buffer went back at once, layer 0's when the worker drops its fill", eventually { pool.outstandingBytes == 0L })
        assertTrue(eventually { frame(u); world.count("deleteTexture") == 1 })
        assertTrue("the layer in hand is never uploaded", workerGl.named("texSubImage3D").none { it.args[4] == 1 })
    }

    @Test fun `dispose never waits for the worker, even with a layer parked for a staging slot`() {
        val array = liveArray()
        val u = uploader(ring = 1)
        assertTrue(u.layer(core, array, 0, 0, fill)); assertTrue(u.layer(core, array, 1, 0, fill))
        assertTrue(eventually { u.workerWaits > 0 && u.parkedLayers == 1 })
        val t0 = System.nanoTime()
        u.dispose(); worker.dispose()
        val ms = (System.nanoTime() - t0) / 1e6
        assertTrue("dispose took $ms ms: it runs inside libGDX's UI-thread handshake", ms < 50)
        assertTrue("the worker stops at once", eventually(2_000) { worker.stopped })
        assertTrue("every decode buffer went back to the pool, the parked layer's too", eventually { pool.outstandingBytes == 0L })
        assertEquals(0, u.parkedLayers)
    }

    @Test fun `worker-built textures sample exactly like Gl3Core-built ones`() {
        for (format in listOf(Gl3Format.RGBA8, Gl3Format.R8UI, Gl3Format.RG16F)) for (levels in listOf(1, 3))
            for (sampling in Gl3Sampling.entries) for (wrap in Gl3Wrap.entries) {
                val recorder = RecordingGl3("parity")
                val c = Gl3Core(recorder.gl, DirectProgramCompiler(ProgramBuilder(recorder.gl, null, "RealmView", 0)), 0L, strict = true)
                c.texture2D(Gl3Pool.CORE, 8, 8, format, levels, sampling, wrap)
                val params = recorder.named("texParameteri").map { it.args[1] to it.args[2] }.toMap()
                val expected = StagingUploader.samplerParameters(format, levels, sampling, wrap)
                val actual = intArrayOf(params.getValue(GL20.GL_TEXTURE_MIN_FILTER) as Int, params.getValue(GL20.GL_TEXTURE_MAG_FILTER) as Int,
                    params.getValue(GL20.GL_TEXTURE_WRAP_S) as Int)
                assertEquals("$format levels=$levels $sampling $wrap", actual.toList(), expected.toList())
            }
    }
}

/** A decode pool whose tasks run only when the test says, on the test thread (the GL thread acts in between). */
private class HeldDecode : AbstractExecutorService() {
    private val tasks = ConcurrentLinkedQueue<Runnable>()
    @Volatile private var down = false
    override fun execute(command: Runnable) { if (down) throw RejectedExecutionException("shut down"); tasks += command }
    fun runAll() { while (true) (tasks.poll() ?: return).run() }
    override fun shutdown() { down = true }
    override fun shutdownNow(): MutableList<Runnable> { down = true; return ArrayList(tasks).also { tasks.clear() } }
    override fun isShutdown(): Boolean = down
    override fun isTerminated(): Boolean = down
    override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = true
}
