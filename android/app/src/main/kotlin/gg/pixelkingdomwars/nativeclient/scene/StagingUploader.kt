package gg.pixelkingdomwars.nativeclient.scene

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.scene.world.DirectBufferPool
import gg.pixelkingdomwars.nativeclient.scene.world.WorkerScope
import gg.pixelkingdomwars.nativeclient.scene.world.WorkerTask
import gg.pixelkingdomwars.nativeclient.scene.world.WorldGlWorker
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/** Decodes one (layer, level) into [out] (position 0, exactly `width × height × bytesPerTexel` bytes). Runs on a
 *  decode thread, never on the GL thread. */
fun interface PixelSource {
    fun decode(layer: Int, level: Int, width: Int, height: Int, out: ByteBuffer)
    /** This source decodes row bands ([decodeRows]); only the globe's adapter says so. [StagingUploader.fresh] asks it
     *  before it takes any buffer (review 2026-09-27: asking with a band buffer in hand cost every big realm level a
     *  throwaway acquire, which can block at the pool's cap). A function, not a property: a default getter on a fun
     *  interface makes its SAM lambdas carry a method named `<get-rows>`, which R8 cannot dex (the release build). */
    fun decodesRows(): Boolean = false
    /** Rows [y0], [y0] + [rows] of one (layer, level) into [out] (position 0, `width × rows × bytesPerTexel` bytes), so
     *  [StagingUploader.fresh] can fill a big level in bands; asked only of a source whose [decodesRows] is true, and false
     *  from it is an error. */
    fun decodeRows(layer: Int, level: Int, width: Int, height: Int, y0: Int, rows: Int, out: ByteBuffer): Boolean = false
}

/**
 * Texture uploads without Mali ghosting and without GL-thread CPU work (GLOBE-NATIVE-PLAN §5.7).
 *
 * Writing into a texture that in-flight frames still sample makes the Mali driver copy (ghost) it, possibly a whole
 * array, or stall; and the linear-to-Mali-layout swizzle inside `glTexSubImage` is CPU work on the calling thread. So:
 * - **Decode** runs on the `world-decode` pool into [DirectBufferPool] buffers (capped: a slow worker throttles
 *   decoding instead of piling layers up in memory).
 * - **Fresh textures** (never sampled yet): [fresh] reserves allocator room on the GL thread (`Gl3Core.reserve`), the
 *   worker creates the immutable storage, fills every layer and level, fences and flushes; [poll] hands the name and
 *   fence to `Gl3Core.adopt`, which makes the texture READY once the fence has signalled.
 * - **Live arrays**: [layer] never writes the array. The worker fills one WHOLE layer of a standalone staging texture
 *   (a ring of [ringSize] per format and size), fences and flushes; [poll] issues `Gl3Core.copyStaged` (a GPU-side
 *   `glWaitSync`, then `glCopyImageSubData` into the array layer), fences the copy, flushes, and hands the slot back to
 *   the worker WITH that fence. The worker refills a slot only once the copy fence has signalled, and checks it itself
 *   (sync objects belong to the share group), so the GPU never reads a slot the worker is overwriting and no GL frame is
 *   needed to free one.
 * - **The worker never waits for the GL thread.** It is the one FIFO thread for program builds and uploads, and at
 *   0 fps idle the GL thread may not run for minutes. A layer that finds every slot of its ring out is PARKED, not
 *   waited for, and the work queued behind it runs. [poll] wakes the parked layers when it hands slots back. A slot
 *   whose copy is still on the GPU is waited on for at most [COPY_WAIT_NS] per turn, and the wake then goes to the back
 *   of the queue, so a compile never waits behind a copy.
 * - **Bands**: a fresh level over [fillBandBytes] whose source decodes rows ([PixelSource.decodesRows]) is decoded and
 *   uploaded in bands of whole rows of at most [fillBandBytes] each, one worker item per band (owner 2026-09-27: a
 *   Phase E island's 16 MiB near level 0 was one `texSubImage3D` and one 16 MiB buffer, waiting on the 24 MiB pool
 *   while realm uploads were out, and holding the one worker queue for its whole upload). A program build or another
 *   upload runs between two bands; the GL thread still uploads nothing.
 * - **Frames**: every worker completion requests a frame ([onReady]); [poll] requests one more while completions the
 *   copy budget held back are queued, or after adopting a fresh texture (the next frame reads its fence).
 * - **Budget**: [poll] stops after `maxCopyBytes` of copies in one frame (at least one copy always runs). The budget is
 *   set from the N0 probe's measured µs per MB, not guessed here.
 * - **No copy path** ([stagingCopy] false: neither ES 3.2 nor `GL_EXT_copy_image`, see `WorldEngineGuard.paths`):
 *   [layer] refuses, so a live array is replaced by a [fresh] texture, filled before its first sample.
 * - **Context change**: completions from an older `Gl3Core` epoch are dropped without touching their names or fences
 *   (they belong to the dead share group); [poll] wakes the worker at the change, and the worker drops every parked
 *   layer of the dead epoch (releasing its buffer) and forgets its ring, so nothing of the old context can hold up the
 *   worker's Rebuild or the programs resubmitted after it.
 */
class StagingUploader(
    private val worker: WorldGlWorker,
    private val decode: ExecutorService,
    private val buffers: DirectBufferPool,
    private val onReady: Runnable = Runnable {},
    private val ringSize: Int = 3,
    private val stagingCopy: Boolean = true,
    private val log: (String) -> Unit = {},
    private val fillBandBytes: Int = FILL_BAND_BYTES,
) {
    private val completed = ConcurrentLinkedQueue<Completion>()
    private val returned = ConcurrentLinkedQueue<Slot>()
    /** Layers waiting for a staging slot, oldest first. The worker parks and wakes them; [dispose] (GL thread) and a
     *  dropped wake release them, so every access holds this deque's monitor. */
    private val parked = ArrayDeque<StageTask>()
    private val wake = WakeTask()
    private val wakeQueued = AtomicBoolean(false)
    @Volatile private var disposed = false
    /** The newest `Gl3Core` epoch the GL thread has polled: a parked layer of an older one is dead. */
    @Volatile private var liveEpoch = Int.MIN_VALUE

    // GL thread state
    private var glEpoch = Int.MIN_VALUE
    private var refusalLogged = false

    // worker thread state
    private val rings = HashMap<Long, Ring>()
    private var ringGeneration = -1
    private var copyStillRunning = false

    /** Counters for the probe and the tests. */
    @Volatile var freshAdopted = 0L; private set
    @Volatile var layersCopied = 0L; private set
    /** Times a layer found every slot of its ring out and was parked (the worker itself never waits for a slot). */
    @Volatile var workerWaits = 0L; private set
    /** Bounded worker waits on a copy fence that timed out (the copy was still on the GPU; the wake was requeued). */
    @Volatile var copyFenceWaits = 0L; private set
    @Volatile var stagingCreated = 0L; private set
    /** Finished worker items waiting for the GL thread's [poll] (diagnostics; O(n)). */
    val pendingCompletions: Int get() = completed.size
    /** Layers parked for a staging slot (diagnostics and tests). */
    val parkedLayers: Int get() = synchronized(parked) { parked.size }

    // ---------------------------------------------------------------- GL thread

    /** Reserve and fill a never-sampled texture on the worker. Null when the pool refused room or the uploader is gone. */
    fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format,
              levels: Int, sampling: Gl3Sampling, wrap: Gl3Wrap, source: PixelSource): Gl3Texture? {
        if (disposed || worker.disposed) return null
        val texture = core.reserve(pool, array, width, height, layers, format, levels) ?: return null
        val request = Fresh(texture, core.epoch, sampling, wrap)
        worker.post(CreateTask(request))
        if (!submitDecode { decodeFresh(request, source) }) worker.post(FailTask(request))
        return texture
    }

    /** Replace one whole layer (at [level]) of a live array through the staging ring. False when refused, including on
     *  a context with no copy path ([stagingCopy]): the caller then replaces the array with a [fresh] texture. */
    fun layer(core: Gl3Core, target: Gl3Texture, layer: Int, level: Int, source: PixelSource): Boolean {
        if (!stagingCopy) {
            if (!refusalLogged) { refusalLogged = true; log("no glCopyImageSubData on this context: live layers need a fresh texture") }
            return false
        }
        if (disposed || worker.disposed || !target.ready || layer !in 0 until target.layers || level !in 0 until target.levels) return false
        val width = maxOf(1, target.width shr level); val height = maxOf(1, target.height shr level)
        val epoch = core.epoch
        return submitDecode {
            val bytes = (width.toLong() * height * target.format.bytesPerTexel).toInt()
            val buffer = buffers.acquire(bytes)
            val ok = runCatching { source.decode(layer, level, width, height, buffer) }
                .onFailure { log("layer decode failed: ${it.message}") }.isSuccess
            if (!ok) { buffers.release(buffer); return@submitDecode }
            buffer.position(0)
            worker.post(StageTask(epoch, target, layer, level, width, height, buffer))
        }
    }

    /**
     * GL thread, at frame start after `Gl3Core.beginFrame` and before any pass. Adopts finished fresh textures and
     * issues staged copies up to [maxCopyBytes], handing each slot back to the worker with its copy fence. Returns the
     * copies issued.
     */
    fun poll(core: Gl3Core, maxCopyBytes: Long): Int {
        val gl = core.gl
        liveEpoch = core.epoch
        if (core.epoch != glEpoch) {
            // a context change: the worker drops parked layers of the dead epoch at this wake (its Rebuild runs first)
            if (glEpoch != Int.MIN_VALUE) wakeWorker()
            glEpoch = core.epoch
        }
        var copies = 0
        var bytes = 0L
        var adopted = false
        while (true) {
            if (copies > 0 && bytes >= maxCopyBytes) break
            val done = completed.poll() ?: break
            if (done.epoch != core.epoch) continue // names and fences of a dead context: never touched
            when (done) {
                is FreshDone -> {
                    val texture = done.request.texture
                    if (done.failed) { if (done.name != 0) gl.deleteTexture(done.name); core.free(texture); continue }
                    if (texture.state == Gl3Texture.PENDING) { core.adopt(texture, done.name, done.fence); freshAdopted++; adopted = true }
                    else { gl.deleteTexture(done.name); if (done.fence != 0L) gl.deleteSync(done.fence) } // freed meanwhile
                }
                is LayerDone -> {
                    val slot = done.slot
                    core.copyStaged(slot.name, GL20.GL_TEXTURE_2D, done.target, done.layer, done.level, done.fence)
                    slot.copyFence = gl.fenceSync()
                    returned.offer(slot)
                    copies++; layersCopied++
                    bytes += slot.bytes
                }
            }
        }
        // the copy fences must reach the GPU before the worker waits on them from its own context
        if (copies > 0) { gl.flush(); wakeWorker() }
        if (adopted || !completed.isEmpty()) onReady.run()
        return copies
    }

    /** Never joins: queued decodes are cancelled (`shutdownNow` interrupts, it does not wait), parked layers are
     *  released here, and unpolled completions are forgotten (their names and fences die with the share group when the
     *  surface's contexts are destroyed). */
    fun dispose() {
        disposed = true
        decode.shutdownNow()
        completed.clear()
        releaseParked()
    }

    // ---------------------------------------------------------------- decode threads

    private fun submitDecode(block: () -> Unit): Boolean = try {
        decode.execute { if (!disposed) try { block() } catch (_: InterruptedException) { Thread.currentThread().interrupt() } }
        true
    } catch (_: RejectedExecutionException) { false }

    /**
     * The fills of one fresh texture, layer by layer. A texture the GL thread freed meanwhile (a realm released before
     * its upload finished: a leave, an eviction, another realm prepared) is decoded no further and nothing more of it is
     * posted (P0, 2026-09-26: its remaining layers took decode buffers from the Java heap for a texture nobody draws);
     * the worker's name is deleted through [FailTask]. [Gl3Texture.state] is read here off the GL thread: a stale read
     * costs one more fill, never a wrong texture ([poll] deletes a freed texture's name either way).
     */
    private fun decodeFresh(request: Fresh, source: PixelSource) {
        val t = request.texture
        try {
            for (layer in 0 until t.layers) for (level in 0 until t.levels) {
                if (disposed) return
                if (t.state == Gl3Texture.FREED) { worker.post(FailTask(request)); return }
                val width = maxOf(1, t.width shr level); val height = maxOf(1, t.height shr level)
                val row = width * t.format.bytesPerTexel
                if (source.decodesRows() && row.toLong() * height > fillBandBytes) { decodeBands(request, source, layer, level, width, height, row); continue }
                if (t.state == Gl3Texture.FREED) { worker.post(FailTask(request)); return }
                val buffer = buffers.acquire((width.toLong() * height * t.format.bytesPerTexel).toInt())
                try { source.decode(layer, level, width, height, buffer) }
                catch (error: RuntimeException) { buffers.release(buffer); throw error }
                if (t.state == Gl3Texture.FREED) { buffers.release(buffer); worker.post(FailTask(request)); return }
                buffer.position(0)
                worker.post(FillTask(request, layer, level, width, height, buffer))
            }
            worker.post(FinishTask(request))
        } catch (error: RuntimeException) {
            log("fresh decode failed: ${error.message}")
            worker.post(FailTask(request))
        }
    }

    /** One level of a row source ([PixelSource.decodesRows]) in bands of at most [fillBandBytes] (whole rows, at least one),
     *  each its own worker item. Stops early when the uploader is disposed or the texture was freed meanwhile (the next
     *  level's check in [decodeFresh] then posts the [FailTask]). A row source that fills no rows throws (the texture
     *  fails, as a failed decode does). */
    private fun decodeBands(request: Fresh, source: PixelSource, layer: Int, level: Int, width: Int, height: Int, row: Int) {
        val t = request.texture
        val band = maxOf(1, fillBandBytes / row)
        var y0 = 0
        while (y0 < height) {
            if (disposed) return
            if (t.state == Gl3Texture.FREED) return
            val rows = minOf(band, height - y0)
            val buffer = buffers.acquire(rows * row)
            val filled = try { source.decodeRows(layer, level, width, height, y0, rows, buffer) }
                catch (error: RuntimeException) { buffers.release(buffer); throw error }
            if (!filled) { buffers.release(buffer); throw IllegalStateException("a row source filled no rows at $y0 of level $level") }
            buffer.position(0)
            worker.post(FillTask(request, layer, level, width, rows, buffer, y0))
            y0 += rows
        }
    }

    // ---------------------------------------------------------------- worker tasks

    private class Fresh(val texture: Gl3Texture, val epoch: Int, val sampling: Gl3Sampling, val wrap: Gl3Wrap) {
        @Volatile var name = 0
        @Volatile var failed = false
    }

    private inner class CreateTask(private val request: Fresh) : WorkerTask(request.epoch) {
        override fun run(scope: WorkerScope) {
            val t = request.texture
            val gl = scope.gl
            val name = gl.genTexture()
            gl.bindTexture(t.target, name)
            if (t.target == GL30.GL_TEXTURE_2D_ARRAY) gl.texStorage3D(t.target, t.levels, t.format.internal, t.width, t.height, t.layers)
            else gl.texStorage2D(t.target, t.levels, t.format.internal, t.width, t.height)
            val params = samplerParameters(t.format, t.levels, request.sampling, request.wrap)
            gl.texParameteri(t.target, GL20.GL_TEXTURE_MIN_FILTER, params[0])
            gl.texParameteri(t.target, GL20.GL_TEXTURE_MAG_FILTER, params[1])
            gl.texParameteri(t.target, GL20.GL_TEXTURE_WRAP_S, params[2])
            gl.texParameteri(t.target, GL20.GL_TEXTURE_WRAP_T, params[2])
            gl.bindTexture(t.target, 0)
            request.name = name
        }
        override fun unavailable(reason: String) { request.failed = true }
    }

    /** Fills rows [y0], [y0] + [height] of one (layer, level): the whole level, or one band of it. */
    private inner class FillTask(private val request: Fresh, private val layer: Int, private val level: Int,
                                 private val width: Int, private val height: Int, private val pixels: ByteBuffer,
                                 private val y0: Int = 0) : WorkerTask(request.epoch) {
        override fun run(scope: WorkerScope) {
            try {
                // freed on the GL thread since this fill was decoded: never copied into a texture nobody draws
                if (request.name == 0 || request.failed || request.texture.state == Gl3Texture.FREED) return
                val t = request.texture
                val gl = scope.gl
                gl.bindTexture(t.target, request.name)
                gl.pixelStorei(GL20.GL_UNPACK_ALIGNMENT, 1)
                if (t.target == GL30.GL_TEXTURE_2D_ARRAY) gl.texSubImage3D(t.target, level, 0, y0, layer, width, height, 1, t.format.uploadFormat, t.format.uploadType, pixels)
                else gl.texSubImage2D(t.target, level, 0, y0, width, height, t.format.uploadFormat, t.format.uploadType, pixels)
                gl.pixelStorei(GL20.GL_UNPACK_ALIGNMENT, 4)
                gl.bindTexture(t.target, 0)
            } finally { buffers.release(pixels) }
        }
        override fun dropped() { buffers.release(pixels) }
    }

    private inner class FinishTask(private val request: Fresh) : WorkerTask(request.epoch) {
        override fun run(scope: WorkerScope) {
            if (request.name == 0 || request.failed) { complete(FreshDone(request, request.name, 0L, failed = true)); return }
            val fence = scope.gl.fenceSync()
            scope.gl.flush()
            complete(FreshDone(request, request.name, fence, failed = false))
        }
        override fun unavailable(reason: String) { complete(FreshDone(request, 0, 0L, failed = true)) }
    }

    private inner class FailTask(private val request: Fresh) : WorkerTask(request.epoch) {
        override fun run(scope: WorkerScope) {
            request.failed = true
            complete(FreshDone(request, request.name, 0L, failed = true))
        }
        override fun unavailable(reason: String) { complete(FreshDone(request, 0, 0L, failed = true)) }
    }

    private inner class StageTask(epoch: Int, val target: Gl3Texture, val layer: Int, val level: Int,
                                  val width: Int, val height: Int, private val pixels: ByteBuffer) : WorkerTask(epoch) {
        val key: Long get() = ringKey(target.format, width, height)
        override fun run(scope: WorkerScope) { if (park(this, first = false)) pump(scope) }
        override fun dropped() = release()
        fun release() { buffers.release(pixels) }

        fun fill(scope: WorkerScope, slot: Slot) {
            try {
                val gl = scope.gl
                gl.bindTexture(GL20.GL_TEXTURE_2D, slot.name)
                gl.pixelStorei(GL20.GL_UNPACK_ALIGNMENT, 1)
                gl.texSubImage2D(GL20.GL_TEXTURE_2D, 0, 0, 0, width, height, target.format.uploadFormat, target.format.uploadType, pixels)
                gl.pixelStorei(GL20.GL_UNPACK_ALIGNMENT, 4)
                gl.bindTexture(GL20.GL_TEXTURE_2D, 0)
                val fence = gl.fenceSync()
                gl.flush()
                complete(LayerDone(epoch, slot, target, layer, level, fence))
            } finally { release() }
        }
    }

    /** Runs the parked layers; one instance, posted at most once at a time. It is never dropped for its epoch. */
    private inner class WakeTask : WorkerTask(Int.MAX_VALUE) {
        override fun run(scope: WorkerScope) { wakeQueued.set(false); pump(scope) }
        /** The worker stopped or has no context: a parked layer can never run. */
        override fun dropped() { wakeQueued.set(false); releaseParked() }
    }

    private fun complete(done: Completion) { completed.offer(done); onReady.run() }

    private fun wakeWorker() { if (!disposed && wakeQueued.compareAndSet(false, true)) worker.post(wake) }

    /** Queue [task] ([first]: back at the head, it keeps its turn). False when the uploader is gone: released. */
    private fun park(task: StageTask, first: Boolean): Boolean {
        val kept = synchronized(parked) {
            if (disposed) false else { if (first) parked.addFirst(task) else parked.addLast(task); true }
        }
        if (!kept) task.release()
        return kept
    }

    private fun releaseParked() {
        while (true) (synchronized(parked) { parked.removeFirstOrNull() } ?: return).release()
    }

    /**
     * Worker thread: run parked layers, oldest first, while slots are free. A layer of a dead epoch (older than the
     * worker's minimum or the GL thread's live epoch) is dropped. When the head finds no slot it stays parked: a slot
     * handed back by [poll] wakes it, or, when its slot's copy is still on the GPU, a wake requeued behind the work
     * already queued.
     */
    private fun pump(scope: WorkerScope) {
        if (scope.generation != ringGeneration) { rings.clear(); returned.clear(); ringGeneration = scope.generation }
        while (true) {
            val task = synchronized(parked) { parked.removeFirstOrNull() } ?: return
            if (disposed || task.epoch < worker.minEpoch || task.epoch < liveEpoch) { task.release(); continue }
            val slot = acquireSlot(scope, task)
            if (slot == null) {
                if (park(task, first = true) && copyStillRunning) wakeWorker()
                return
            }
            try { task.fill(scope, slot) } catch (error: RuntimeException) { log("staging fill failed: ${error.message}") }
        }
    }

    /**
     * Worker thread: a staging slot for [task] whose last copy has finished, or null. Creates up to [ringSize] per
     * format and size. Never waits for the GL thread: with every slot out at the GL thread it returns null at once.
     * With free slots still being copied from, it waits at most [COPY_WAIT_NS] on the oldest one's copy fence and sets
     * [copyStillRunning] if that was not enough.
     */
    private fun acquireSlot(scope: WorkerScope, task: StageTask): Slot? {
        copyStillRunning = false
        val gl = scope.gl
        drainReturned(scope.generation)
        val ring = rings.getOrPut(task.key) { Ring() }
        val free = ring.free
        for (i in free.indices) {
            val slot = free[i]
            if (slot.copyFence == 0L || gl.clientWaitSync(slot.copyFence, 0, 0L) != GL30.GL_TIMEOUT_EXPIRED) {
                free.removeAt(i); retire(gl, slot); return slot
            }
        }
        if (ring.created < ringSize) {
            val format = task.target.format
            val name = gl.genTexture()
            gl.bindTexture(GL20.GL_TEXTURE_2D, name)
            gl.texStorage2D(GL20.GL_TEXTURE_2D, 1, format.internal, task.width, task.height)
            gl.texParameteri(GL20.GL_TEXTURE_2D, GL20.GL_TEXTURE_MIN_FILTER, GL20.GL_NEAREST)
            gl.texParameteri(GL20.GL_TEXTURE_2D, GL20.GL_TEXTURE_MAG_FILTER, GL20.GL_NEAREST)
            gl.bindTexture(GL20.GL_TEXTURE_2D, 0)
            ring.created++; stagingCreated++
            return Slot(task.key, scope.generation, name, task.width.toLong() * task.height * format.bytesPerTexel)
        }
        if (free.isEmpty()) { workerWaits++; return null } // every slot is at the GL thread: poll() hands one back and wakes us
        val oldest = free[0]
        if (gl.clientWaitSync(oldest.copyFence, 0, COPY_WAIT_NS) != GL30.GL_TIMEOUT_EXPIRED) { free.removeAt(0); retire(gl, oldest); return oldest }
        copyFenceWaits++
        copyStillRunning = true
        return null
    }

    /** The copy from [slot] has finished: its fence (created on the GL thread, shared by the share group) goes. */
    private fun retire(gl: Gl3, slot: Slot) { if (slot.copyFence != 0L) { gl.deleteSync(slot.copyFence); slot.copyFence = 0L } }

    private fun drainReturned(generation: Int) { while (true) file(returned.poll() ?: return, generation) }
    /** A slot of an older worker context (a dead share group) is forgotten; its name and fence are never touched. */
    private fun file(slot: Slot, generation: Int) { if (slot.generation == generation) rings[slot.key]?.free?.add(slot) }

    private class Ring { var created = 0; val free = ArrayList<Slot>(3) }
    /** [copyFence] is written by the GL thread before the slot is offered to [returned], read by the worker after. */
    private class Slot(val key: Long, val generation: Int, val name: Int, val bytes: Long) { @Volatile var copyFence = 0L }

    private sealed class Completion(val epoch: Int)
    private class FreshDone(val request: Fresh, val name: Int, val fence: Long, val failed: Boolean) : Completion(request.epoch)
    private class LayerDone(epoch: Int, val slot: Slot, val target: Gl3Texture, val layer: Int, val level: Int, val fence: Long) : Completion(epoch)

    companion object {
        /** The longest one worker turn waits for a staging copy to finish on the GPU before it lets queued work run.
         *  A whole 512² RGBA8 layer is 1 MB; the probe measures the Seeker's copy rate (plan §5.7). */
        const val COPY_WAIT_NS = 2_000_000L
        /** The largest band of a fresh level (owner task 2026-09-27: "upload in slices, e.g. ≤ 2 MB"): a 2048² RGBA8
         *  level 0 (16 MiB, 8192 B a row) goes up in 8 bands of 256 rows; a 1024² albedo face (4 MiB) in 2. */
        const val FILL_BAND_BYTES = 2 shl 20

        private fun ringKey(format: Gl3Format, width: Int, height: Int): Long =
            (format.ordinal.toLong() shl 40) or (width.toLong() shl 20) or height.toLong()

        /**
         * min filter, mag filter, wrap for a worker-created texture: the same mapping as `Gl3Core.create` (integer
         * textures always NEAREST; a mip filter only with more than one level), so a texture looks the same whichever
         * path made it.
         */
        fun samplerParameters(format: Gl3Format, levels: Int, sampling: Gl3Sampling, wrap: Gl3Wrap): IntArray {
            val nearest = format.integer || sampling == Gl3Sampling.NEAREST || sampling == Gl3Sampling.NEAREST_MIPMAP_NEAREST
            val min = when {
                format.integer || levels == 1 -> if (nearest) GL20.GL_NEAREST else GL20.GL_LINEAR
                sampling == Gl3Sampling.NEAREST_MIPMAP_NEAREST -> GL20.GL_NEAREST_MIPMAP_NEAREST
                sampling == Gl3Sampling.LINEAR_MIPMAP_LINEAR -> GL20.GL_LINEAR_MIPMAP_LINEAR
                else -> if (nearest) GL20.GL_NEAREST else GL20.GL_LINEAR
            }
            val mag = if (nearest) GL20.GL_NEAREST else GL20.GL_LINEAR
            val w = when (wrap) { Gl3Wrap.CLAMP -> GL20.GL_CLAMP_TO_EDGE; Gl3Wrap.REPEAT -> GL20.GL_REPEAT; Gl3Wrap.MIRROR -> GL20.GL_MIRRORED_REPEAT }
            return intArrayOf(min, mag, w)
        }
    }
}
