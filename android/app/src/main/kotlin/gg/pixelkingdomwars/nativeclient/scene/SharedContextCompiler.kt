package gg.pixelkingdomwars.nativeclient.scene

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.os.Process
import gg.pixelkingdomwars.nativeclient.renderer.gl3.DirectProgramCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramCache
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramJob
import gg.pixelkingdomwars.nativeclient.scene.world.WorkerContext
import gg.pixelkingdomwars.nativeclient.scene.world.WorkerContexts
import gg.pixelkingdomwars.nativeclient.scene.world.WorkerScope
import gg.pixelkingdomwars.nativeclient.scene.world.WorkerTask
import gg.pixelkingdomwars.nativeclient.scene.world.WorldEgl
import gg.pixelkingdomwars.nativeclient.scene.world.WorldGlWorker

/**
 * Programs compiled and linked off the GL thread (GLOBE-NATIVE-PLAN §5.3 step 1; GLES has no
 * `KHR_parallel_shader_compile`): a [ProgramCompiler] over the one shared GL worker ([WorldGlWorker]).
 *
 * - [submit] queues the job FIFO and returns at once ([blocksCaller] is false). The worker runs `ProgramBuilder.build`
 *   on its context in the world context's share group; the builder publishes `job.state` last and fences the program,
 *   and `Gl3Core` adopts it on the GL thread only once that fence has signalled (polled with timeout 0).
 * - [contextChanged] (called by `Gl3Core.restore` on the GL thread, with the NEW world context current) drops every
 *   queued job of an older epoch and has the worker rebuild its context in the new share group.
 * - [dispose] is O(1) and never joins the worker (plan §5.9).
 *
 * [create] is the entry point: it creates the worker context on the GL thread (without making it current), so when
 * EGL refuses a shared context the caller learns it synchronously and gets [DirectProgramCompiler] instead. `Gl3Core`
 * then builds every program of the entry before the first world frame and refuses a GL-thread link after it.
 */
class SharedContextCompiler(private val worker: WorldGlWorker, private val currentShare: () -> Any) : ProgramCompiler {
    override val blocksCaller: Boolean get() = false
    override fun submit(job: ProgramJob) = worker.post(CompileTask(job))
    override fun contextChanged(epoch: Int) = worker.rebuild(currentShare(), epoch)
    override fun dispose() = worker.dispose()

    private class CompileTask(private val job: ProgramJob) : WorkerTask(job.epoch) {
        override fun run(scope: WorkerScope) = scope.builder.build(job)
        override fun unavailable(reason: String) {
            job.error = "realm program ${job.name}: $reason"
            job.state = ProgramJob.FAILED
        }
    }

    /** What [create] set up: the compiler for `Gl3Core`, the worker (null on the fallback), and why. */
    class Setup(val compiler: ProgramCompiler, val worker: WorldGlWorker?, val reason: String)

    companion object {
        /** The uniform block the world programs bind at binding 0 (NA-core's `ProgramBuilder(…, "RealmView", 0)`). */
        const val VIEW_BLOCK = "RealmView"
        const val VIEW_BINDING = 0

        /**
         * GL thread, before the first world frame. [share] is the world context (`EGL14.eglGetCurrentContext()`),
         * [cacheFactory] opens the program-binary cache for a context's driver (the worker calls it; the fallback calls
         * it here, behind the loading state).
         */
        fun create(
            worldGl: Gl3,
            contexts: WorkerContexts,
            share: Any,
            currentShare: () -> Any,
            cacheFactory: (Gl3) -> ProgramCache?,
            threadSetup: () -> Unit = {},
            log: (String) -> Unit = {},
        ): Setup {
            val first = try { contexts.create(share) } catch (error: RuntimeException) { log("worker context: ${error.message}"); null }
            if (first == null) {
                val cache = try { cacheFactory(worldGl) } catch (error: Exception) { null }
                return Setup(DirectProgramCompiler(ProgramBuilder(worldGl, cache, VIEW_BLOCK, VIEW_BINDING)), null,
                    "no shared worker context: programs build on the GL thread before the first world frame")
            }
            val worker = WorldGlWorker(contexts, first, cacheFactory, VIEW_BLOCK, VIEW_BINDING, threadSetup = threadSetup, log = log)
            return Setup(SharedContextCompiler(worker, currentShare), worker, "shared worker context ${first.description}")
        }
    }
}

/**
 * EGL14 worker contexts in the world context's share group (plan §5.3). The world context was created by
 * `WorldGraphics`' context factory as [world]; the worker copies its version and robustness exactly (EGL refuses a
 * share whose reset strategy differs) and asks for LOW priority when `EGL_IMG_context_priority` is listed.
 *
 * The worker uses the world context's own config (looked up by `EGL_CONFIG_ID`), surfaceless when
 * `EGL_KHR_surfaceless_context` is listed, else a 1×1 pbuffer (with a pbuffer-capable ES 3 config if the world
 * config has no pbuffer bit). It never calls `eglTerminate`: the display belongs to the world surface.
 */
class EglWorkerContexts(private val world: WorldEgl.ContextSpec, private val log: (String) -> Unit = {}) : WorkerContexts {
    override fun create(share: Any): WorkerContext? {
        val shareContext = share as? EGLContext ?: return null
        if (shareContext == EGL14.EGL_NO_CONTEXT) return null
        val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        if (display == EGL14.EGL_NO_DISPLAY) return null
        val extensions = EGL14.eglQueryString(display, EGL14.EGL_EXTENSIONS)
        val surfaceless = WorldEgl.listed(extensions, WorldEgl.EXT_SURFACELESS)
        val config = worldConfig(display, shareContext, pbuffer = !surfaceless) ?: return null.also { log("worker: no EGL config") }
        for (spec in WorldEgl.workerLadder(world, extensions)) {
            val context = EGL14.eglCreateContext(display, config, shareContext, spec.attributes(), 0)
            if (context == null || context == EGL14.EGL_NO_CONTEXT) { log("worker: eglCreateContext($spec) failed 0x${Integer.toHexString(EGL14.eglGetError())}"); continue }
            val surface = if (surfaceless) EGL14.EGL_NO_SURFACE
                else EGL14.eglCreatePbufferSurface(display, config, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
            if (surface == null || (!surfaceless && surface == EGL14.EGL_NO_SURFACE)) {
                EGL14.eglDestroyContext(display, context)
                log("worker: pbuffer failed 0x${Integer.toHexString(EGL14.eglGetError())}")
                return null
            }
            return EglWorkerContext(display, context, surface, "$spec${if (surfaceless) " surfaceless" else " pbuffer"}")
        }
        return null
    }

    private fun worldConfig(display: EGLDisplay, share: EGLContext, pbuffer: Boolean): EGLConfig? {
        val value = IntArray(1)
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        if (EGL14.eglQueryContext(display, share, EGL14.EGL_CONFIG_ID, value, 0) &&
            EGL14.eglChooseConfig(display, intArrayOf(EGL14.EGL_CONFIG_ID, value[0], EGL14.EGL_NONE), 0, configs, 0, 1, count, 0) && count[0] > 0) {
            val own = configs[0]!!
            if (!pbuffer) return own
            val surfaceType = IntArray(1)
            if (EGL14.eglGetConfigAttrib(display, own, EGL14.EGL_SURFACE_TYPE, surfaceType, 0) && surfaceType[0] and EGL14.EGL_PBUFFER_BIT != 0) return own
        }
        val renderable = if (world.version >= 3) EGL_OPENGL_ES3_BIT else EGL14.EGL_OPENGL_ES2_BIT
        val attributes = intArrayOf(EGL14.EGL_RENDERABLE_TYPE, renderable, EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_NONE)
        return if (EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) && count[0] > 0) configs[0] else null
    }

    private class EglWorkerContext(
        private val display: EGLDisplay, private val context: EGLContext, private val surface: EGLSurface,
        override val description: String,
    ) : WorkerContext {
        override val gl: Gl3 = AndroidGl3()
        override fun makeCurrent(): Boolean = EGL14.eglMakeCurrent(display, surface, surface, context)
        override fun destroy() {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
            EGL14.eglDestroyContext(display, context)
            EGL14.eglReleaseThread()
        }
    }

    companion object {
        /** `EGL_OPENGL_ES3_BIT_KHR`. */
        const val EGL_OPENGL_ES3_BIT = 0x40

        /** The worker thread's setup: default priority (the GL thread runs at DISPLAY), tid recorded for ADPF. */
        fun workerThreadSetup(onTid: (Int) -> Unit): () -> Unit = {
            Process.setThreadPriority(Process.THREAD_PRIORITY_DEFAULT)
            onTid(Process.myTid())
        }
    }
}
