package gg.pixelkingdomwars.nativeclient.scene.world

import android.opengl.EGL14
import android.opengl.GLES20
import android.opengl.GLES30
import android.os.Build
import android.os.Process
import com.badlogic.gdx.ApplicationListener
import com.badlogic.gdx.Gdx
import gg.pixelkingdomwars.nativeclient.renderer.gl3.DriverIdentity
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramCache
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameSampler
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldScene
import gg.pixelkingdomwars.nativeclient.scene.AndroidGl3
import gg.pixelkingdomwars.nativeclient.scene.EglWorkerContexts
import gg.pixelkingdomwars.nativeclient.scene.SharedContextCompiler
import gg.pixelkingdomwars.nativeclient.scene.WorldGraphics
import java.io.File

/**
 * The N0 host of the GL30 world surface (debug flag [WorldEngineFlags.gl30Requested] only). It wraps the unchanged
 * legacy globe and adds what N0 must prove on a device (GLOBE-NATIVE-PLAN §3.3, §5.3, §5.6, §5.9, §8.1):
 * - `create()`: GL thread at `THREAD_PRIORITY_DISPLAY`; the engine guard ([WorldEngineGuard.decide]) with its reason
 *   (including the reset and copy entry points it chose) logged; on GL30, a `Gl3Core` over [AndroidGl3] with those
 *   paths and the shared-context compiler (or the direct fallback), which
 *   builds one smoke program in the background and adopts it on its fence: the whole program path end to end. The
 *   legacy globe renders every frame as before; the core only polls fences and programs (it draws nothing).
 * - `[world-perf]` lines from [WorldFrameSampler], with motion = the pacer's continuous flag.
 * - `pause()`/`dispose()` are O(1) (plan §5.9): `glDelete*` through the core, the worker disposed without a join,
 *   and the `Gdx.gl30` leak cleared; `resume()` puts this surface's own handle back.
 *
 * Emulator on a non-SwiftShader renderer: no core, no worker, no GL30 program ever compiles; the legacy globe runs.
 */
class WorldGl30Listener(
    private val legacy: ApplicationListener,
    private val graphics: () -> WorldGraphics?,
    private val programRoot: File,
    private val versionCode: Long,
    private val strict: Boolean,
    private val log: (String) -> Unit,
) : ApplicationListener {
    var decision: WorldEngineDecision? = null; private set
    private var core: Gl3Core? = null
    private var smoke: Gl3Program? = null
    private var smokeReported = false
    private val sampler = WorldFrameSampler()

    override fun create() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY)
        val world = graphics()
        val renderer = Gdx.gl?.glGetString(GLES20.GL_RENDERER)
        // this surface's own handle, not the static (which another surface could have left behind); GL_VERSION and
        // GL_EXTENSIONS choose the reset and copy entry points (ES 3.1 drivers stub the GLES32 ones)
        val choice = WorldEngineGuard.decide(Build.HARDWARE, renderer, world?.getGL30() != null,
            Gdx.gl?.glGetString(GLES20.GL_VERSION), Gdx.gl?.glGetString(GLES20.GL_EXTENSIONS))
        decision = choice
        log("[world-engine] ${choice.choice} ${choice.reason}")
        if (choice.gl30 && world != null) runCatching { startCore(world, choice.paths) }.onFailure { log("[world-engine] GL30 core failed: ${it.message}") }
        world?.frameListener = WorldGraphics.FrameListener { start, cpu ->
            sampler.frame(start, WorldScene.GLOBE, world.pacer.isContinuous, cpu, 0L)?.let { log("[world-perf] ${it.toJson()}") }
        }
        legacy.create()
    }

    private fun startCore(world: WorldGraphics, paths: Gles3Paths) {
        val spec = world.contextFactory.created ?: return
        val gl = AndroidGl3(paths)
        val setup = SharedContextCompiler.create(
            worldGl = gl,
            contexts = EglWorkerContexts(spec) { log("[world-engine] $it") },
            share = EGL14.eglGetCurrentContext(),
            currentShare = { EGL14.eglGetCurrentContext() },
            cacheFactory = { g -> programCache(g, programRoot, versionCode) },
            threadSetup = EglWorkerContexts.workerThreadSetup {},
            log = { log("[world-engine] $it") },
        )
        log("[world-engine] compiler: ${setup.reason}")
        val c = Gl3Core(gl, setup.compiler, NO_GL_THREAD_UPLOADS, strict)
        smoke = c.program(SMOKE_NAME, SMOKE_VS, SMOKE_FS)
        core = c
        restoreLibGdxBindings()
    }

    override fun resize(width: Int, height: Int) {
        core?.resize(width, height)
        legacy.resize(width, height)
    }

    override fun render() {
        val c = core
        if (c != null) {
            val now = System.nanoTime()
            if (c.beginFrame(now, graphics()?.contextHandle ?: EGL14.eglGetCurrentContext().nativeHandle)) {
                val report = c.endFrame(now)
                if (report.contextChanged) { log("[world-engine] context changed; programs resubmitted"); restoreLibGdxBindings() }
                val program = smoke
                if (!smokeReported && program != null && program.state != Gl3Program.PENDING) {
                    smokeReported = true
                    log("[world-engine] smoke program ${if (program.ready) "adopted" else "FAILED ${program.error}"} " +
                        "fromCache=${program.fromCache} buildMs=${program.buildNanos / 1_000_000.0}")
                }
            }
        }
        legacy.render()
    }

    override fun pause() {
        legacy.pause()
        sampler.pause()
        WorldGdxStatics.clearGl30()
    }

    override fun resume() {
        WorldGdxStatics.restoreGl30(graphics()?.getGL30())
        legacy.resume()
    }

    override fun dispose() {
        try { legacy.dispose() } finally {
            core?.dispose(); core = null
            WorldGdxStatics.clearGl30()
        }
    }

    /** The core's buffer and array setup leaves its own objects bound; libGDX's client-side paths expect 0. */
    private fun restoreLibGdxBindings() {
        GLES30.glBindVertexArray(0)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    }

    companion object {
        /** No GL-thread upload is allowed after the first world frame on this path: it uploads nothing. N1's host uses
         *  the generated `GPU_SAFE.coldUploadBytes` here; this is not a copy of that web constant. */
        const val NO_GL_THREAD_UPLOADS = 0L
        /** Program-binary cache cap. Not in the plan (NA-core suggested 32 MiB); the lead decides the final value. */
        const val PROGRAM_CACHE_BYTES = 32L * 1024 * 1024
        const val SMOKE_NAME = "n0-smoke"
        const val SMOKE_VS = "#version 300 es\nlayout(location = 0) in vec2 a_pos;\nvoid main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n"
        const val SMOKE_FS = "#version 300 es\nprecision mediump float;\nlayout(std140) uniform RealmView { vec4 u_tint; };\n" +
            "out vec4 o_color;\nvoid main() { o_color = u_tint; }\n"

        /** Opens the program-binary cache on the calling (worker) thread for the driver of [gl]. */
        fun programCache(gl: Gl3, root: File, versionCode: Long): ProgramCache =
            ProgramCache(root, DriverIdentity(gl.getString(GLES20.GL_RENDERER) ?: "unknown", gl.getString(GLES20.GL_VERSION) ?: "unknown", versionCode),
                PROGRAM_CACHE_BYTES)
    }
}
