package gg.pixelkingdomwars.nativeclient.scene.world

import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramCache
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.atomic.AtomicLong

/** One GL context in the world context's share group, owned by the worker thread once handed to it. */
interface WorkerContext {
    val gl: Gl3
    val description: String
    /** Make this context current on the calling (worker) thread. */
    fun makeCurrent(): Boolean
    /** Release it from the calling (worker) thread and destroy it. */
    fun destroy()
}

/** Creates worker contexts. [create] never makes the context current, so it may run on the GL thread. */
fun interface WorkerContexts {
    /** A context in the share group of [share] (the world context, `EGL14.eglGetCurrentContext()` on the GL thread);
     *  null when EGL refuses. */
    fun create(share: Any): WorkerContext?
}

/** What a task sees on the worker: the current context's GL, a generation that changes with the context, and the
 *  program builder bound to it. */
class WorkerScope internal constructor(val gl: Gl3, val generation: Int, val builder: ProgramBuilder)

/** One unit of worker work, tagged with the `Gl3Core` epoch (context generation on the GL side) it belongs to. */
abstract class WorkerTask(val epoch: Int) {
    abstract fun run(scope: WorkerScope)
    /** Dropped unrun: an older epoch after a context change, or the worker stopped. Release what the task holds. */
    open fun dropped() = Unit
    /** The worker has no usable context (creation or makeCurrent failed after a context change). Default: dropped. */
    open fun unavailable(reason: String) = dropped()
}

/**
 * The ONE shared GL worker (GLOBE-NATIVE-PLAN §3.4, §5.3, §5.7): a thread that owns one context in the world
 * context's share group and runs program builds and texture uploads for the world surface, in FIFO order.
 *
 * Rules, each one a way the GL thread would otherwise block or the pause handshake would stall:
 * - [post] never blocks the caller.
 * - [rebuild] (GL thread, `Gl3Core.restore` → `ProgramCompiler.contextChanged`) raises the minimum epoch at once, so
 *   every queued task of an older epoch is dropped unrun (its program or texture belongs to the dead share group), and
 *   the worker replaces its context with one in the new share group before it runs anything newer.
 * - [dispose] is O(1) and never joins (plan §5.9: libGDX runs `pause()`/`dispose()` inside a UI-thread handshake).
 *   The worker finishes its current task, drops the rest, and destroys its own context.
 * - The program cache is opened on the worker (it deletes stale directories: disk I/O never runs on the GL thread)
 *   and reads `GL_RENDERER`/`GL_VERSION` from the worker context, the same driver as the world context.
 */
class WorldGlWorker(
    private val contexts: WorkerContexts,
    first: WorkerContext,
    private val cacheFactory: (Gl3) -> ProgramCache?,
    private val viewBlock: String,
    private val viewBinding: Int,
    threadName: String = "world-gl-worker",
    private val threadSetup: () -> Unit = {},
    private val log: (String) -> Unit = {},
) {
    private val queue = LinkedBlockingDeque<Any>()
    @Volatile var disposed = false; private set
    @Volatile var minEpoch = 0; private set
    /** Bumped every time the worker binds a context. */
    @Volatile var generation = 0; private set
    /** Why the worker has no usable context, if it has none. */
    @Volatile var failure: String? = null; private set
    private val run = AtomicLong()
    private val dropped = AtomicLong()
    val tasksRun: Long get() = run.get()
    val tasksDropped: Long get() = dropped.get()
    @Volatile var stopped = false; private set
    val threadName: String = threadName
    private val thread = Thread({ loop(first) }, threadName).apply { isDaemon = true }

    init { thread.start() }

    fun post(task: WorkerTask) {
        if (disposed || task.epoch < minEpoch) { drop(task); return }
        queue.offerLast(task)
        // lost a race with the worker's exit: nobody would ever run or drop it
        if (stopped && queue.remove(task)) drop(task)
    }

    private fun drop(task: WorkerTask) { dropped.incrementAndGet(); runCatching { task.dropped() } }

    fun rebuild(share: Any, epoch: Int) {
        if (disposed) return
        if (epoch > minEpoch) minEpoch = epoch
        queue.offerFirst(Rebuild(share, epoch))
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        queue.offerFirst(STOP)
    }

    /** True on the worker thread (tests and asserts). */
    val onWorkerThread: Boolean get() = Thread.currentThread() === thread

    private var cache: ProgramCache? = null
    private var cacheOpened = false

    private fun bind(context: WorkerContext): WorkerScope? {
        if (!context.makeCurrent()) {
            failure = "worker context ${context.description} could not be made current"
            log(failure!!)
            runCatching { context.destroy() }
            return null
        }
        if (!cacheOpened) {
            cacheOpened = true
            cache = try { cacheFactory(context.gl) } catch (error: Exception) { log("program cache unavailable: ${error.message}"); null }
        }
        failure = null
        generation++
        return WorkerScope(context.gl, generation, ProgramBuilder(context.gl, cache, viewBlock, viewBinding))
    }

    private fun loop(first: WorkerContext) {
        runCatching(threadSetup)
        var scope = bind(first)
        var context: WorkerContext? = if (scope != null) first else null
        try {
            while (true) {
                val item = queue.take()
                if (item === STOP) break
                if (item is Rebuild) {
                    if (item.epoch < minEpoch) continue // a newer rebuild is already ahead of it
                    context?.let { runCatching { it.destroy() } }
                    context = null; scope = null
                    val next = try { contexts.create(item.share) } catch (error: RuntimeException) { null }
                    if (next == null) { failure = "worker context could not be created in the new share group"; log(failure!!) }
                    else { scope = bind(next); context = if (scope != null) next else null }
                    continue
                }
                val task = item as WorkerTask
                if (disposed || task.epoch < minEpoch) { drop(task); continue }
                val current = scope
                if (current == null) { dropped.incrementAndGet(); runCatching { task.unavailable(failure ?: "worker context unavailable") }; continue }
                try { task.run(current); run.incrementAndGet() }
                catch (error: RuntimeException) { log("worker task failed: ${error.message}"); task.dropped() }
            }
        } catch (_: InterruptedException) {
            // nobody interrupts the worker; treat it as a stop
        } finally {
            stopped = true
            while (true) {
                val left = queue.poll() ?: break
                if (left is WorkerTask) drop(left)
            }
            context?.let { runCatching { it.destroy() } }
        }
    }

    private class Rebuild(val share: Any, val epoch: Int)

    private companion object { val STOP = Any() }
}
