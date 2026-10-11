package gg.pixelkingdomwars.nativeclient.scene.probe

import android.content.Context
import android.opengl.EGL14
import android.opengl.GLES20
import android.opengl.GLES30
import android.os.Build
import android.os.Process
import com.badlogic.gdx.ApplicationListener
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.InputAdapter
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.scene.AndroidGl3
import gg.pixelkingdomwars.nativeclient.scene.EglWorkerContexts
import gg.pixelkingdomwars.nativeclient.scene.FramePacer
import gg.pixelkingdomwars.nativeclient.scene.PixelSource
import gg.pixelkingdomwars.nativeclient.scene.SharedContextCompiler
import gg.pixelkingdomwars.nativeclient.scene.StagingUploader
import gg.pixelkingdomwars.nativeclient.scene.WorldGraphics
import gg.pixelkingdomwars.nativeclient.scene.probe.ProbeFirstDraw.TARGET_SIZE
import gg.pixelkingdomwars.nativeclient.scene.probe.ProbeFirstDraw.TRIALS
import gg.pixelkingdomwars.nativeclient.scene.world.DirectBufferPool
import gg.pixelkingdomwars.nativeclient.scene.world.Gles3Paths
import gg.pixelkingdomwars.nativeclient.scene.world.ResetQuery
import gg.pixelkingdomwars.nativeclient.scene.world.WorkerScope
import gg.pixelkingdomwars.nativeclient.scene.world.WorkerTask
import gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineGuard
import gg.pixelkingdomwars.nativeclient.scene.world.WorldGl30Listener
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * The probe's GL-thread script (GLOBE-NATIVE-PLAN §8.3). One phase step per frame; blocking GL calls (`glFinish`,
 * `glReadPixels`, status queries) are allowed HERE ONLY, never in a world frame. Phases:
 * - INFO: `GL_VERSION` first (on screen before any timing), then the reset and copy entry points the engine guard
 *   chose for this context, renderer, extensions, limits.
 * - PIPELINE: worker compile + fresh upload + staged layer copy through `Gl3Core`; the copied texels are READ BACK
 *   (a copy that was issued is not a copy that happened); dispose timing.
 * - BINARY: GL-thread `glProgramBinary` and first-draw ms of a synthetic program.
 * - PREWARM: does a draw on the shared worker context warm the world context's pipeline variant (plan §5.3 step 4)?
 * - SCRATCH: does a draw into an RGB8 or RGBA8 scratch target warm the default framebuffer's variant (the premise of
 *   `Gl3Core.rehearse`)?
 * - STAGES: every exported production program, one per frame: link, `glProgramBinary`, first and second draw.
 * - UPLOAD: µs/MB for `glTexSubImage3D` and the chosen copy, the copy read back.
 * - BENCH ([ProbeBench], one step per frame, ramped) → PACING (5 s continuous at 60 fps) → IDLE (3 s with nothing
 *   requested: frames must stop) → TOUCH (the owner drags a finger for 5 s: frames driven only by touch) → DONE.
 *
 * Under D-171 this is the only Seeker session. A phase that throws records its error in its own section and the
 * probe moves on, so one failure never costs the other answers. What the probe cannot answer is written into the
 * report ([ProbeReport.UNANSWERABLE]) next to the owner's USB steps ([ProbeReport.OWNER_STEPS]).
 *
 * On an emulator whose renderer is not SwiftShader the engine guard refuses: only INFO runs, nothing is compiled or
 * drawn beyond the clear (RM-GPU-1).
 */
internal class DeviceProbe(
    private val app: Context,
    private val graphics: () -> WorldGraphics?,
    private val pacer: FramePacer,
    private val status: (String) -> Unit,
    private val finished: (ProbeReport) -> Unit,
    private val later: (Long, Runnable) -> Unit,
    /** Any thread: true hides the readout (it would catch the finger) and shows the DRAG banner. */
    private val touchMode: (Boolean) -> Unit,
    private val display: JsonObject,
    private val thermalStart: JsonObject,
    private val requestedSurface: IntArray,
) : ApplicationListener {
    private enum class Phase { INFO, PIPELINE, BINARY, PREWARM, SCRATCH, STAGES, UPLOAD, BENCH, PACING, IDLE, TOUCH, DONE, REPORTED }

    private val report = ProbeReport()
    /** Replaced in INFO by one over the entry points the engine guard chose for this context. */
    private var gl = AndroidGl3()
    private var paths = Gles3Paths.ES30
    private val raw = ProbeGl()
    @Volatile private var phase = Phase.INFO
    private var width = 1
    private var height = 1
    private val surfaces = ArrayList<String>()
    private var guardAllowsWork = false
    private var emulator = false
    /** GL thread: libGDX delivers input events there, in the frame that processes them. */
    private var touchEvents = 0

    override fun create() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY)
        graphics()?.surfaceListener = { w, h -> synchronized(surfaces) { surfaces += "${w}x$h" } }
        graphics()?.frameListener = WorldGraphics.FrameListener { start, _ ->
            if (phase == Phase.PACING || (phase == Phase.TOUCH && touchStartNs != 0L)) frameStart(start)
        }
        Gdx.input?.inputProcessor = object : InputAdapter() {
            override fun touchDown(screenX: Int, screenY: Int, pointer: Int, button: Int): Boolean { touchEvents++; return true }
            override fun touchDragged(screenX: Int, screenY: Int, pointer: Int): Boolean { touchEvents++; return true }
        }
        pacer.setContinuous(true)
    }

    override fun resize(width: Int, height: Int) { this.width = maxOf(1, width); this.height = maxOf(1, height) }

    override fun render() {
        val current = phase
        try {
            when (current) {
                Phase.INFO -> info()
                Phase.PIPELINE -> pipeline()
                Phase.BINARY -> { clear(); binaryTiming(); enter(Phase.PREWARM) }
                Phase.PREWARM -> prewarm()
                Phase.SCRATCH -> scratch()
                Phase.STAGES -> stages()
                Phase.UPLOAD -> { clear(); uploadTiming(); enter(Phase.BENCH) }
                Phase.BENCH -> bench()
                Phase.PACING -> pacing()
                Phase.IDLE -> clear()
                Phase.TOUCH -> touch()
                Phase.DONE -> done()
                Phase.REPORTED -> clear()
            }
        } catch (error: RuntimeException) {
            status("phase $current failed: ${error.message}")
            runCatching { abandon(current) }
            runCatching { resetGl() }
            val section = section(current)
            if (section != null && section !in report) report.put(section, JsonObject(mapOf("error" to p(error.message ?: error.toString()))))
            else report.put("error", "${current.name}: ${error.message}")
            if (current == Phase.DONE || current == Phase.REPORTED) { phase = Phase.REPORTED; runCatching { finished(report) } }
            else enter(following(current))
        }
    }

    override fun pause() = Unit
    override fun resume() = Unit
    override fun dispose() {
        disposePipeline()
        prewarmRun?.let { runCatching { it.dispose() } }; prewarmRun = null
        runCatching { raw.delete() }
    }

    /** Enter [p] and run its entry step. Any thread for IDLE → TOUCH (the idle timer runs on the UI thread). */
    private fun enter(p: Phase) {
        phase = p
        status("→ ${p.name.lowercase()}")
        when (p) {
            Phase.PACING -> pacingBegin()
            Phase.IDLE -> idleBegin()
            Phase.TOUCH -> touchBegin()
            Phase.DONE -> pacer.markDirty() // pacing is on demand from IDLE on: DONE needs its frame
            else -> Unit
        }
    }

    private fun following(p: Phase): Phase = when (p) {
        Phase.INFO -> Phase.DONE
        Phase.PIPELINE -> Phase.BINARY
        Phase.BINARY -> Phase.PREWARM
        Phase.PREWARM -> Phase.SCRATCH
        Phase.SCRATCH -> Phase.STAGES
        Phase.STAGES -> Phase.UPLOAD
        Phase.UPLOAD -> Phase.BENCH
        Phase.BENCH -> Phase.PACING
        Phase.PACING -> Phase.IDLE
        Phase.IDLE -> Phase.TOUCH
        Phase.TOUCH -> Phase.DONE
        Phase.DONE, Phase.REPORTED -> Phase.REPORTED
    }

    private fun section(p: Phase): String? = when (p) {
        Phase.PIPELINE -> "workerPipeline"
        Phase.BINARY -> "programBinaryTiming"
        Phase.PREWARM -> "workerPrewarm"
        Phase.SCRATCH -> "scratchPrewarm"
        Phase.STAGES -> "programStages"
        Phase.UPLOAD -> "uploadTiming"
        Phase.BENCH -> "bench"
        Phase.PACING -> "pacing"
        Phase.TOUCH -> "touchPacing"
        else -> null
    }

    /** Release what a failed phase held. */
    private fun abandon(p: Phase) {
        when (p) {
            Phase.PIPELINE -> disposePipeline()
            Phase.PREWARM -> { prewarmRun?.dispose(); prewarmRun = null }
            Phase.SCRATCH -> { scratchPrograms?.forEach(GLES20::glDeleteProgram); scratchPrograms = null }
            Phase.STAGES -> { stageTarget?.delete(); stageTarget = null }
            Phase.BENCH -> { benchSetup?.delete(); benchSetup = null }
            Phase.PACING -> pacer.setContinuous(false)
            Phase.TOUCH -> touchMode(false)
            else -> Unit
        }
    }

    private fun resetGl() {
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0); GLES20.glUseProgram(0); GLES30.glBindVertexArray(0)
        GLES20.glDisable(GLES20.GL_SCISSOR_TEST); GLES20.glDisable(GLES20.GL_BLEND); GLES20.glDisableVertexAttribArray(0)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0); GLES20.glViewport(0, 0, width, height)
    }

    private fun clear(r: Float = 0.05f, g: Float = 0.07f, b: Float = 0.1f) {
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        GLES20.glViewport(0, 0, width, height)
        GLES20.glClearColor(r, g, b, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
    }

    // ------------------------------------------------------------------ INFO

    private fun info() {
        clear()
        val version = gl.getString(GLES20.GL_VERSION)
        val renderer = gl.getString(GLES20.GL_RENDERER)
        val glExtensions = glExtensions()
        val world = graphics()
        val decision = WorldEngineGuard.decide(Build.HARDWARE, renderer, world?.getGL30() != null, version, glExtensions)
        paths = decision.paths
        gl = AndroidGl3(paths)
        // the first thing the lead reads: every staging and reset answer below depends on it
        status("gl.version: $version\nentry points: $paths")
        emulator = WorldEngineGuard.isEmulator(Build.HARDWARE)
        guardAllowsWork = decision.gl30
        report.put("build", JsonObject(mapOf(
            "manufacturer" to p(Build.MANUFACTURER), "model" to p(Build.MODEL), "hardware" to p(Build.HARDWARE),
            "soc" to p(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}" else null),
            "sdk" to p(Build.VERSION.SDK_INT), "versionCode" to p(BuildConfig.VERSION_CODE), "versionName" to p(BuildConfig.VERSION_NAME),
            "nativeBuild" to p(BuildConfig.NATIVE_BUILD_SHA), "emulator" to p(emulator),
        )))
        report.put("engineGuard", JsonObject(mapOf("choice" to p(decision.choice.name), "reason" to p(decision.reason),
            "context" to p(world?.contextFactory?.created?.toString()), "contextGeneration" to p(world?.contextFactory?.generation))))
        report.put("gl", JsonObject(mapOf(
            "version" to p(version), "vendor" to p(gl.getString(GLES20.GL_VENDOR)), "renderer" to p(renderer),
            "glsl" to p(gl.getString(GLES20.GL_SHADING_LANGUAGE_VERSION)),
            "paths" to JsonObject(mapOf("reset" to p(paths.reset.name), "copy" to p(paths.copy.name))),
            "resetStatus" to if (paths.reset == ResetQuery.ES32) p(gl.getGraphicsResetStatus())
                else p("not queried: below ES 3.2 (EXT/KHR_robustness have no android.opengl binding)"),
            "extensions" to p(glExtensions),
        )))
        val display = EGL14.eglGetCurrentDisplay()
        val eglExtensions = EGL14.eglQueryString(display, EGL14.EGL_EXTENSIONS)
        report.put("egl", JsonObject(mapOf(
            "vendor" to p(EGL14.eglQueryString(display, EGL14.EGL_VENDOR)), "version" to p(EGL14.eglQueryString(display, EGL14.EGL_VERSION)),
            "clientApis" to p(EGL14.eglQueryString(display, EGL14.EGL_CLIENT_APIS)), "extensions" to p(eglExtensions),
        )))
        report.put("extensions", ProbeReport.extensionFlags(glExtensions, eglExtensions))
        val formats = IntArray(16)
        val n = gl.getIntegers(GLES30.GL_PROGRAM_BINARY_FORMATS, formats)
        report.put("programBinaryFormats", JsonObject(mapOf("count" to p(gl.getInteger(GLES30.GL_NUM_PROGRAM_BINARY_FORMATS)),
            "formats" to JsonArray((0 until n).map { p("0x" + Integer.toHexString(formats[it])) }))))
        report.put("limits", limits())
        report.put("display", this.display)
        report.put("thermal", thermalStart)
        status("renderer: $renderer\nguard: ${decision.choice} (${decision.reason})\ncontext: ${world?.contextFactory?.created}")
        if (!guardAllowsWork) {
            for (section in listOf("workerPipeline", "programBinaryTiming", "workerPrewarm", "scratchPrewarm", "programStages",
                    "uploadTiming", "bench", "pacing", "idle", "touchPacing"))
                report.put(section, JsonObject(mapOf("skipped" to p("engine guard: ${decision.reason}"))))
            enter(Phase.DONE)
            return
        }
        enter(Phase.PIPELINE)
    }

    private fun glExtensions(): String {
        val count = gl.getInteger(GLES30.GL_NUM_EXTENSIONS)
        return (0 until count).mapNotNull { GLES30.glGetStringi(GLES20.GL_EXTENSIONS, it) }.joinToString(" ")
    }

    private fun limits(): JsonObject {
        val names = linkedMapOf(
            "maxTextureSize" to GLES20.GL_MAX_TEXTURE_SIZE, "maxArrayTextureLayers" to GLES30.GL_MAX_ARRAY_TEXTURE_LAYERS,
            "max3dTextureSize" to GLES30.GL_MAX_3D_TEXTURE_SIZE, "maxRenderbufferSize" to GLES20.GL_MAX_RENDERBUFFER_SIZE,
            "maxTextureImageUnits" to GLES20.GL_MAX_TEXTURE_IMAGE_UNITS, "maxCombinedTextureImageUnits" to GLES20.GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS,
            "maxVertexTextureImageUnits" to GLES20.GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS, "maxUniformBlockSize" to GLES30.GL_MAX_UNIFORM_BLOCK_SIZE,
            "maxUniformBufferBindings" to GLES30.GL_MAX_UNIFORM_BUFFER_BINDINGS, "maxFragmentUniformVectors" to GLES20.GL_MAX_FRAGMENT_UNIFORM_VECTORS,
            "maxVertexUniformVectors" to GLES20.GL_MAX_VERTEX_UNIFORM_VECTORS, "maxVaryingVectors" to GLES20.GL_MAX_VARYING_VECTORS,
            "maxColorAttachments" to GLES30.GL_MAX_COLOR_ATTACHMENTS, "maxDrawBuffers" to GLES30.GL_MAX_DRAW_BUFFERS,
            "maxSamples" to GLES30.GL_MAX_SAMPLES, "maxVertexAttribs" to GLES20.GL_MAX_VERTEX_ATTRIBS,
        )
        val out = LinkedHashMap<String, JsonElement>()
        for ((key, name) in names) out[key] = p(gl.getInteger(name))
        val dims = IntArray(2); gl.getIntegers(GLES20.GL_MAX_VIEWPORT_DIMS, dims)
        out["maxViewportDims"] = p("${dims[0]}x${dims[1]}")
        val range = IntArray(2); val precision = IntArray(1)
        GLES20.glGetShaderPrecisionFormat(GLES20.GL_FRAGMENT_SHADER, GLES20.GL_HIGH_FLOAT, range, 0, precision, 0)
        out["fragmentHighpFloat"] = p("range ${range[0]}..${range[1]} precision ${precision[0]}")
        GLES20.glGetShaderPrecisionFormat(GLES20.GL_FRAGMENT_SHADER, GLES20.GL_HIGH_INT, range, 0, precision, 0)
        out["fragmentHighpInt"] = p("range ${range[0]}..${range[1]}")
        return JsonObject(out)
    }

    // ------------------------------------------------------------------ PIPELINE

    private var core: Gl3Core? = null
    private var uploader: StagingUploader? = null
    private var program: Gl3Program? = null
    private var texture: Gl3Texture? = null
    private var readTarget: Gl3Texture? = null
    private var setupReason = ""
    private var pipelineStartNs = 0L
    private var programReadyMs = -1.0
    private var textureReadyMs = -1.0
    private var layerRequestedNs = 0L
    private var layerCopiedMs = -1.0
    /** Texels of the staged layer read back that match what the copy wrote (-1: not read). */
    private var layerTexels = -1
    private var pipelineFrames = 0
    private val decodeThreads = AtomicInteger()

    private fun pipeline() {
        val now = System.nanoTime()
        var c = core
        if (c == null) {
            val spec = graphics()?.contextFactory?.created ?: error("no world context spec")
            val setup = SharedContextCompiler.create(gl, EglWorkerContexts(spec) { status("worker: $it") }, EGL14.eglGetCurrentContext(),
                { EGL14.eglGetCurrentContext() }, { g -> WorldGl30Listener.programCache(g, File(app.noBackupFilesDir, "world-programs"), BuildConfig.VERSION_CODE.toLong()) },
                EglWorkerContexts.workerThreadSetup {}, { status("worker: $it") })
            setupReason = setup.reason
            c = Gl3Core(gl, setup.compiler, WorldGl30Listener.NO_GL_THREAD_UPLOADS, strict = false).also { it.resize(width, height) }
            core = c
            program = c.program("probe-array", ProbeBench.VERTEX_SHADER, ARRAY_FS)
            readTarget = c.texture2D(Gl3Pool.CORE, ProbeTexels.CHECKED, 1, Gl3Format.RGBA8)
            val worker = setup.worker
            if (worker != null) {
                val decode = Executors.newFixedThreadPool(2) { r -> Thread(r, "world-decode-${decodeThreads.incrementAndGet()}").apply { isDaemon = true } }
                uploader = StagingUploader(worker, decode, DirectBufferPool(64L shl 20, 16L shl 20), { pacer.markDirty() },
                    stagingCopy = paths.stagingCopy, log = { status("uploader: $it") })
                texture = uploader!!.fresh(c, Gl3Pool.CORE, true, LAYER_SIZE, LAYER_SIZE, 2, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP,
                    solid(ProbeTexels.FRESH_LAYER0, ProbeTexels.FRESH_LAYER1))
            }
            pipelineStartNs = now
            GLES30.glBindVertexArray(0)
            status("compiler: $setupReason")
        }
        pipelineFrames++
        if (!c.beginFrame(now, EGL14.eglGetCurrentContext().nativeHandle)) return
        uploader?.poll(c, Long.MAX_VALUE)
        val prog = program; val t = texture
        if (prog != null && prog.ready && programReadyMs < 0) programReadyMs = (now - pipelineStartNs) / 1e6
        if (t != null && t.ready && textureReadyMs < 0) {
            textureReadyMs = (now - pipelineStartNs) / 1e6
            layerRequestedNs = now
            if (paths.stagingCopy) uploader?.layer(c, t, 1, 0, solid(ProbeTexels.STAGED_LAYER1, ProbeTexels.STAGED_LAYER1))
        }
        val u = uploader
        if (u != null && u.layersCopied > 0 && layerCopiedMs < 0) layerCopiedMs = (now - layerRequestedNs) / 1e6
        val target = readTarget
        if (layerCopiedMs >= 0 && layerTexels < 0 && prog != null && prog.ready && t != null && t.ready && target != null && target.ready) {
            // read the copied layer back through a draw of it, in an offscreen pass before the screen pass (frame order)
            c.offscreen(target)
            if (c.use(prog)) {
                c.bindTexture(0, t)
                c.gl.uniform1i(prog.uniform(c, "u_tex"), 0)
                c.gl.uniform1i(prog.uniform(c, "u_layer"), 1)
                GLES20.glDisable(GLES20.GL_DITHER)
                c.fullscreen()
                GLES20.glFinish()
                layerTexels = ProbeTexels.matches(raw.readRow(ProbeTexels.CHECKED), ProbeTexels.CHECKED, ProbeTexels.STAGED_LAYER1, LAYER_SIZE)
                GLES20.glEnable(GLES20.GL_DITHER)
            }
            c.use(null)
        }
        c.beginScreen(0.05f, 0.07f, 0.1f, 1f)
        if (prog != null && prog.ready && t != null && t.ready) {
            c.use(prog)
            c.bindTexture(0, t)
            c.gl.uniform1i(prog.uniform(c, "u_tex"), 0)
            c.gl.uniform1i(prog.uniform(c, "u_layer"), if (layerCopiedMs >= 0) 1 else 0)
            c.fullscreen()
            c.use(null)
        }
        c.endFrame(now)
        val staged = !paths.stagingCopy || layerTexels >= 0
        val finished = prog != null && prog.state != Gl3Program.PENDING && (u == null || (textureReadyMs >= 0 && staged))
        val timedOut = now - pipelineStartNs > 10_000_000_000L
        if (finished || timedOut) {
            val disposeStart = System.nanoTime()
            val stats = c.stats
            disposePipeline()
            val disposeMs = (System.nanoTime() - disposeStart) / 1e6
            val out = linkedMapOf<String, JsonElement>(
                "compiler" to p(setupReason), "timedOut" to p(timedOut && !finished), "frames" to p(pipelineFrames),
                "programState" to p(prog?.state), "programError" to p(prog?.error), "programFromCache" to p(prog?.fromCache),
                "programBuildMs" to p((prog?.buildNanos ?: 0L) / 1e6), "programReadyMs" to p(programReadyMs),
                "freshTextureReadyMs" to p(textureReadyMs), "copyPath" to p(paths.copy.name),
                "stagingCreated" to p(u?.stagingCreated), "workerWaits" to p(u?.workerWaits), "copyFenceWaits" to p(u?.copyFenceWaits),
                "copiesRefused" to p(gl.copiesRefused),
                "adoptions" to p(stats.adoptions), "liveFirstDraws" to p(stats.liveFirstDraws), "orderViolations" to p(stats.orderViolations),
                "disposeMs" to p(disposeMs),
            )
            if (paths.stagingCopy) {
                out["stagedLayerCopiedMs"] = p(layerCopiedMs)
                out["stagedLayerTexelsMatched"] = p("${maxOf(layerTexels, 0)}/${ProbeTexels.CHECKED}")
                out["stagedLayerVerified"] = p(layerTexels == ProbeTexels.CHECKED)
            } else out["stagedLayer"] = p("skipped: no copy path on this context ($paths)")
            report.put("workerPipeline", JsonObject(out))
            status("pipeline: program ${prog?.state} (cache ${prog?.fromCache}) ready ${programReadyMs}ms, texture ${textureReadyMs}ms, " +
                "layer copy ${layerCopiedMs}ms, texels $layerTexels/${ProbeTexels.CHECKED}, dispose ${disposeMs}ms")
            enter(Phase.BINARY)
        }
    }

    private fun disposePipeline() {
        uploader?.dispose(); uploader = null
        core?.dispose(); core = null
        GLES30.glBindVertexArray(0); GLES20.glUseProgram(0)
    }

    private fun solid(layer0: Int, layer1: Int) = PixelSource { layer, _, w, h, out ->
        val rgba = if (layer == 0) layer0 else layer1
        out.order(ByteOrder.BIG_ENDIAN)
        for (i in 0 until w * h) out.putInt(i * 4, ProbeTexels.texel(rgba, w, i))
        out.order(ByteOrder.nativeOrder())
    }

    // ------------------------------------------------------------------ BINARY

    private fun binaryTiming() {
        val t0 = System.nanoTime()
        val program = raw.link(ProbeBench.VERTEX_SHADER, ProbeBench.fragmentShader(BenchKind.ALU, 16), retrievable = true)
        val compileLinkMs = (System.nanoTime() - t0) / 1e6
        val length = gl.getProgrami(program, GLES30.GL_PROGRAM_BINARY_LENGTH)
        val out = LinkedHashMap<String, JsonElement>()
        out["compileLinkMs"] = p(compileLinkMs)
        out["binaryLength"] = p(length)
        if (length > 0) {
            val buffer = ByteBuffer.allocateDirect(length).order(ByteOrder.nativeOrder())
            val format = IntArray(1)
            val written = gl.getProgramBinary(program, buffer, format)
            val copy = GLES20.glCreateProgram()
            val t1 = System.nanoTime()
            gl.programBinary(copy, format[0], buffer, written)
            val linked = gl.getProgrami(copy, GLES20.GL_LINK_STATUS) == GLES20.GL_TRUE
            out["programBinaryMs"] = p((System.nanoTime() - t1) / 1e6)
            out["programBinaryLinked"] = p(linked)
            if (linked) {
                val fbo = ProbeGl.Target(64)
                fbo.bind()
                out["firstDrawMs"] = p(raw.timeDraw(copy, attributeless = false))
                out["secondDrawMs"] = p(raw.timeDraw(copy, attributeless = false))
                GLES20.glUseProgram(0); fbo.delete()
            }
            GLES20.glDeleteProgram(copy)
        }
        GLES20.glDeleteProgram(program)
        out["perProgram"] = p("see programStages (every exported production program)")
        report.put("programBinaryTiming", JsonObject(out))
        status("binary: $out")
    }

    // ------------------------------------------------------------------ PREWARM (plan §5.3 step 4)

    private var prewarmRun: PrewarmRun? = null

    /** Warmed and control programs, and the worker's warm-up of the warmed ones on its own context. */
    private inner class PrewarmRun(val setup: SharedContextCompiler.Setup) {
        val warmed = IntArray(TRIALS) { raw.link(ProbeFirstDraw.VERTEX_SHADER, ProbeFirstDraw.fragmentShader(it)) }
        val control = IntArray(TRIALS) { raw.link(ProbeFirstDraw.VERTEX_SHADER, ProbeFirstDraw.fragmentShader(100 + it)) }
        val startNs = System.nanoTime()
        @Volatile var workerMs = -1.0
        @Volatile var workerError: String? = null
        @Volatile var workerDone = false

        init {
            GLES20.glFinish() // shared objects: the links are complete before another context uses the programs
            setup.worker!!.post(object : WorkerTask(0) {
                override fun run(scope: WorkerScope) {
                    try { warm(scope.gl) } catch (error: RuntimeException) { workerError = error.message ?: error.toString() } finally { workerDone = true }
                }
                override fun dropped() { workerError = "the worker dropped the warm-up"; workerDone = true }
                override fun unavailable(reason: String) { workerError = reason; workerDone = true }
            })
        }

        /** Worker thread, worker context: one 1×1 draw of each warmed program in the trial state, into its own RGBA8
         *  target (framebuffers and vertex arrays are not shared), finished before it reports. */
        private fun warm(g: Gl3) {
            val t0 = System.nanoTime()
            val tex = g.genTexture()
            g.bindTexture(GL20.GL_TEXTURE_2D, tex)
            g.texStorage2D(GL20.GL_TEXTURE_2D, 1, GL30.GL_RGBA8, TARGET_SIZE, TARGET_SIZE)
            g.bindTexture(GL20.GL_TEXTURE_2D, 0)
            val fbo = g.genFramebuffer()
            g.bindFramebuffer(GL20.GL_FRAMEBUFFER, fbo)
            g.framebufferTexture2D(GL20.GL_FRAMEBUFFER, GL20.GL_COLOR_ATTACHMENT0, GL20.GL_TEXTURE_2D, tex, 0)
            try {
                check(g.checkFramebufferStatus(GL20.GL_FRAMEBUFFER) == GL20.GL_FRAMEBUFFER_COMPLETE) { "worker target incomplete" }
                val vao = g.genVertexArray()
                g.bindVertexArray(vao)
                g.viewport(0, 0, TARGET_SIZE, TARGET_SIZE)
                g.enable(GL20.GL_BLEND)
                g.blendFuncSeparate(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA, GL20.GL_ONE, GL20.GL_ONE_MINUS_SRC_ALPHA)
                g.disable(GL20.GL_DEPTH_TEST)
                g.enable(GL20.GL_SCISSOR_TEST); g.scissor(0, 0, 1, 1)
                for (program in warmed) { g.useProgram(program); g.drawArrays(GL20.GL_TRIANGLES, 0, 3) }
                val fence = g.fenceSync()
                val status = g.clientWaitSync(fence, GL30.GL_SYNC_FLUSH_COMMANDS_BIT, 2_000_000_000L)
                g.deleteSync(fence)
                check(status == GL30.GL_ALREADY_SIGNALED || status == GL30.GL_CONDITION_SATISFIED) { "worker warm-up did not finish (0x${Integer.toHexString(status)})" }
                g.useProgram(0); g.bindVertexArray(0); g.deleteVertexArray(vao)
                g.disable(GL20.GL_BLEND); g.disable(GL20.GL_SCISSOR_TEST)
                workerMs = (System.nanoTime() - t0) / 1e6
            } finally {
                g.bindFramebuffer(GL20.GL_FRAMEBUFFER, 0); g.deleteFramebuffer(fbo); g.deleteTexture(tex)
            }
        }

        fun dispose() {
            for (program in warmed) GLES20.glDeleteProgram(program)
            for (program in control) GLES20.glDeleteProgram(program)
            setup.compiler.dispose() // the worker: O(1), never joined
        }
    }

    private fun prewarm() {
        clear()
        val run = prewarmRun
        if (run == null) {
            val spec = graphics()?.contextFactory?.created ?: error("no world context spec")
            val setup = SharedContextCompiler.create(gl, EglWorkerContexts(spec) { status("prewarm worker: $it") }, EGL14.eglGetCurrentContext(),
                { EGL14.eglGetCurrentContext() }, { null }, EglWorkerContexts.workerThreadSetup {}, { status("prewarm worker: $it") })
            if (setup.worker == null) {
                setup.compiler.dispose()
                report.put("workerPrewarm", JsonObject(mapOf("skipped" to p("no shared worker context: ${setup.reason}"))))
                enter(Phase.SCRATCH)
                return
            }
            prewarmRun = PrewarmRun(setup)
            return // the GL thread measures in a later frame, after the worker has drawn
        }
        if (!run.workerDone && System.nanoTime() - run.startNs < 5_000_000_000L) return
        val out = LinkedHashMap<String, JsonElement>()
        out["workerContext"] = p(run.setup.reason)
        out["state"] = p("alpha blend, RGBA8 ${TARGET_SIZE}x$TARGET_SIZE target, 1x1 scissor, attribute-less triangle")
        val error = run.workerError ?: if (!run.workerDone) "the worker warm-up did not finish in 5 s" else null
        if (error != null) out["error"] = p(error)
        else {
            val target = ProbeGl.Target(TARGET_SIZE)
            target.bind(); raw.trialState(true)
            GLES20.glFinish()
            val trials = (0 until TRIALS).map { measure(run.warmed[it], run.control[it], controlFirst = it % 2 == 1) }
            raw.trialState(false); GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0); target.delete()
            out["workerMs"] = p(run.workerMs)
            out["trials"] = trialsJson(trials)
            out["verdict"] = p(ProbeFirstDraw.verdict(trials).name)
        }
        run.dispose(); prewarmRun = null
        report.put("workerPrewarm", JsonObject(out))
        status("prewarm: ${out["verdict"] ?: out["error"]}")
        enter(Phase.SCRATCH)
    }

    /** One trial: the first draws of both programs (which goes first alternates), then their second draws. */
    private fun measure(warmed: Int, control: Int, controlFirst: Boolean): ProbeFirstDraw.Trial {
        val order = if (controlFirst) intArrayOf(control, warmed) else intArrayOf(warmed, control)
        val first = DoubleArray(2) { raw.timeDraw(order[it], attributeless = true) }
        val second = DoubleArray(2) { raw.timeDraw(order[it], attributeless = true) }
        val w = if (controlFirst) 1 else 0
        return ProbeFirstDraw.Trial(first[w], second[w], first[1 - w], second[1 - w])
    }

    private fun trialsJson(trials: List<ProbeFirstDraw.Trial>) = JsonArray(trials.map {
        JsonObject(mapOf("warmedFirstMs" to p(it.warmedFirstMs), "warmedSecondMs" to p(it.warmedSecondMs),
            "controlFirstMs" to p(it.controlFirstMs), "controlSecondMs" to p(it.controlSecondMs)))
    })

    // ------------------------------------------------------------------ SCRATCH (the premise of Gl3Core.rehearse)

    /** [0, TRIALS): warmed on RGB8; [TRIALS, 2·TRIALS): warmed on RGBA8; [2·TRIALS, 3·TRIALS): controls. */
    private var scratchPrograms: IntArray? = null

    private fun scratch() {
        clear()
        val programs = scratchPrograms
        if (programs == null) {
            val made = IntArray(3 * TRIALS) { raw.link(ProbeFirstDraw.VERTEX_SHADER, ProbeFirstDraw.fragmentShader(200 + it)) }
            scratchPrograms = made
            val rgb8 = ProbeGl.Target(TARGET_SIZE, GLES30.GL_RGB8)
            val rgba8 = ProbeGl.Target(TARGET_SIZE)
            raw.trialState(true)
            rgb8.bind(); for (t in 0 until TRIALS) raw.timeDraw(made[t], attributeless = true)
            rgba8.bind(); for (t in 0 until TRIALS) raw.timeDraw(made[TRIALS + t], attributeless = true)
            raw.trialState(false)
            rgb8.delete(); rgba8.delete()
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0); GLES20.glViewport(0, 0, width, height)
            return // the screen draws come in the next frame, as a rehearsal precedes the frame whose pass uses it
        }
        val bits = raw.defaultFramebufferBits()
        GLES20.glViewport(0, 0, width, height)
        raw.trialState(true)
        GLES20.glFinish()
        val onRgb8 = ArrayList<ProbeFirstDraw.Trial>(); val onRgba8 = ArrayList<ProbeFirstDraw.Trial>()
        for (t in 0 until TRIALS) {
            val ids = intArrayOf(programs[t], programs[TRIALS + t], programs[2 * TRIALS + t])
            val order = IntArray(3) { ids[(it + t) % 3] } // rotate which program draws first
            val first = HashMap<Int, Double>(); val second = HashMap<Int, Double>()
            for (id in order) first[id] = raw.timeDraw(id, attributeless = true)
            for (id in order) second[id] = raw.timeDraw(id, attributeless = true)
            val c = ids[2]
            onRgb8 += ProbeFirstDraw.Trial(first.getValue(ids[0]), second.getValue(ids[0]), first.getValue(c), second.getValue(c))
            onRgba8 += ProbeFirstDraw.Trial(first.getValue(ids[1]), second.getValue(ids[1]), first.getValue(c), second.getValue(c))
        }
        raw.trialState(false)
        for (id in programs) GLES20.glDeleteProgram(id)
        scratchPrograms = null
        report.put("scratchPrewarm", JsonObject(mapOf(
            "defaultFramebuffer" to JsonObject(bits.mapValues { p(it.value) }),
            "state" to p("alpha blend, 1x1 scissor, attribute-less triangle; warmed a frame earlier on a ${TARGET_SIZE}x$TARGET_SIZE scratch target"),
            "rgb8" to JsonObject(mapOf("trials" to trialsJson(onRgb8), "verdict" to p(ProbeFirstDraw.verdict(onRgb8).name))),
            "rgba8" to JsonObject(mapOf("trials" to trialsJson(onRgba8), "verdict" to p(ProbeFirstDraw.verdict(onRgba8).name))),
        )))
        status("scratch: default fb $bits, RGB8 ${ProbeFirstDraw.verdict(onRgb8)}, RGBA8 ${ProbeFirstDraw.verdict(onRgba8)}")
        enter(Phase.STAGES)
    }

    // ------------------------------------------------------------------ STAGES (per production program)

    private var stageList: List<ProbeStage>? = null
    private var stageIndex = 0
    private val stageResults = ArrayList<Map<String, JsonElement>>()
    private var stageTarget: ProbeGl.Target? = null
    private var stageMeta: Map<String, JsonElement> = emptyMap()
    private val boundUnits = ArrayList<IntArray>()

    private fun stages() {
        clear()
        val list = stageList
        if (list == null) {
            val index = resource(ProbeStages.INDEX)
            if (index == null) {
                report.put("programStages", JsonObject(mapOf("skipped" to p("no exported stages in this APK: ${ProbeStages.INDEX} is not on the classpath"))))
                enter(Phase.UPLOAD)
                return
            }
            val parsed = ProbeStages.parse(index)
            stageMeta = mapOf("schema" to p(parsed.schema), "pin" to p(parsed.pin), "indexErrors" to JsonArray(parsed.errors.map { p(it) }),
                "draw" to p("1x1-scissored triangle into an RGBA8 ${TARGET_SIZE}x$TARGET_SIZE target; zeroed uniform blocks; a 1x1 texture of each sampler's kind; its GPU time means nothing, its first-draw cost does"))
            stageTarget = ProbeGl.Target(TARGET_SIZE)
            stageList = parsed.stages
            status("stages: ${parsed.stages.size} programs from pin ${parsed.pin}")
            return
        }
        if (stageIndex < list.size) {
            val stage = list[stageIndex++]
            stageResults += try { measureStage(stage) } catch (error: RuntimeException) {
                runCatching { resetGl() }
                mapOf("name" to p(stage.name), "group" to p(stage.group), "error" to p(error.message ?: error.toString()))
            }
            return // one program per frame
        }
        stageTarget?.delete(); stageTarget = null
        val out = LinkedHashMap<String, JsonElement>(stageMeta)
        out += ProbeStages.summary(stageResults)
        out["results"] = JsonArray(stageResults.map { JsonObject(it) })
        report.put("programStages", JsonObject(out))
        status("stages: ${ProbeStages.summary(stageResults)}")
        enter(Phase.UPLOAD)
    }

    private fun resource(path: String): String? =
        DeviceProbe::class.java.classLoader?.getResourceAsStream(path)?.use { it.readBytes().toString(Charsets.UTF_8) }

    private fun measureStage(stage: ProbeStage): Map<String, JsonElement> {
        val out = LinkedHashMap<String, JsonElement>()
        out["name"] = p(stage.name); out["group"] = p(stage.group)
        val vs = resource(ProbeStages.ROOT + stage.vsPath); val fs = resource(ProbeStages.ROOT + stage.fsPath)
        if (vs == null || fs == null) { out["error"] = p("stage file missing from the APK"); return out }
        val t0 = System.nanoTime()
        val (program, linkError) = raw.tryLink(vs, fs, retrievable = true)
        out["compileLinkMs"] = p((System.nanoTime() - t0) / 1e6)
        if (program == 0) { out["error"] = p(linkError); status("stage ${stage.name}: $linkError"); return out }
        var drawProgram = program
        var copy = 0
        val length = gl.getProgrami(program, GLES30.GL_PROGRAM_BINARY_LENGTH)
        out["binaryLength"] = p(length)
        if (length > 0) {
            val buffer = ByteBuffer.allocateDirect(length).order(ByteOrder.nativeOrder())
            val format = IntArray(1)
            val written = gl.getProgramBinary(program, buffer, format)
            copy = GLES20.glCreateProgram()
            val t1 = System.nanoTime()
            gl.programBinary(copy, format[0], buffer, written)
            val linked = gl.getProgrami(copy, GLES20.GL_LINK_STATUS) == GLES20.GL_TRUE
            out["programBinaryMs"] = p((System.nanoTime() - t1) / 1e6)
            out["programBinaryLinked"] = p(linked)
            if (linked) drawProgram = copy // the cached path: what a warm World entry draws with
        }
        try {
            val skip = bindInputs(drawProgram, out)
            if (skip != null) out["drawSkipped"] = p(skip)
            else {
                stageTarget!!.bind()
                GLES20.glDisable(GLES20.GL_BLEND); GLES20.glDisable(GLES20.GL_DEPTH_TEST)
                GLES20.glEnable(GLES20.GL_SCISSOR_TEST); GLES20.glScissor(0, 0, 1, 1)
                GLES20.glGetError()
                out["firstDrawMs"] = p(raw.timeDraw(drawProgram, attributeless = false))
                out["secondDrawMs"] = p(raw.timeDraw(drawProgram, attributeless = false))
                val error = GLES20.glGetError()
                if (error != GLES20.GL_NO_ERROR) out["drawError"] = p("0x" + Integer.toHexString(error))
            }
        } finally {
            unbindInputs()
            GLES20.glDisable(GLES20.GL_SCISSOR_TEST); GLES20.glDisableVertexAttribArray(0); GLES20.glUseProgram(0)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0); GLES20.glViewport(0, 0, width, height)
            GLES20.glDeleteProgram(program); if (copy != 0) GLES20.glDeleteProgram(copy)
        }
        status("stage ${stage.name}: link ${out["compileLinkMs"]} ms, binary ${out["programBinaryMs"]} ms, first draw ${out["firstDrawMs"] ?: out["drawSkipped"]}")
        return out
    }

    /** Back every uniform block with the zeroed buffer and give every sampler a texture of its kind on its own unit.
     *  Returns why the draw is skipped, or null. */
    private fun bindInputs(program: Int, out: MutableMap<String, JsonElement>): String? {
        boundUnits.clear()
        val value = IntArray(1)
        GLES20.glGetProgramiv(program, GLES30.GL_ACTIVE_UNIFORM_BLOCKS, value, 0)
        val blocks = value[0]
        out["uniformBlocks"] = p(blocks)
        val bindings = gl.getInteger(GLES30.GL_MAX_UNIFORM_BUFFER_BINDINGS)
        if (blocks > bindings) return "$blocks uniform blocks, $bindings bindings"
        for (i in 0 until blocks) {
            GLES30.glGetActiveUniformBlockiv(program, i, GLES30.GL_UNIFORM_BLOCK_DATA_SIZE, value, 0)
            if (value[0] > ProbeStages.ZERO_UBO_BYTES) return "uniform block $i needs ${value[0]} bytes"
            GLES30.glUniformBlockBinding(program, i, i)
            GLES30.glBindBufferRange(GLES30.GL_UNIFORM_BUFFER, i, raw.zeroUbo(), 0, maxOf(16, value[0]))
        }
        GLES20.glUseProgram(program)
        GLES20.glGetProgramiv(program, GLES20.GL_ACTIVE_UNIFORMS, value, 0)
        val uniforms = value[0]
        val units = gl.getInteger(GLES20.GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS)
        val size = IntArray(1); val type = IntArray(1)
        var unit = 0
        for (u in 0 until uniforms) {
            val name = GLES20.glGetActiveUniform(program, u, size, 0, type, 0)
            if (!ProbeStages.isSampler(type[0])) continue
            val dummy = ProbeStages.dummyFor(type[0]) ?: return "sampler $name of type 0x${Integer.toHexString(type[0])} has no probe texture"
            for (k in 0 until size[0]) {
                if (unit >= units) return "more than $units sampler units"
                GLES20.glUniform1i(GLES20.glGetUniformLocation(program, ProbeStages.elementName(name, size[0], k)), unit)
                GLES20.glActiveTexture(GLES20.GL_TEXTURE0 + unit)
                GLES20.glBindTexture(dummy.target, raw.dummy(dummy))
                boundUnits += intArrayOf(unit, dummy.target)
                unit++
            }
        }
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        out["samplers"] = p(unit)
        return null
    }

    private fun unbindInputs() {
        for (bound in boundUnits) { GLES20.glActiveTexture(GLES20.GL_TEXTURE0 + bound[0]); GLES20.glBindTexture(bound[1], 0) }
        boundUnits.clear()
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindBuffer(GLES30.GL_UNIFORM_BUFFER, 0)
    }

    // ------------------------------------------------------------------ UPLOAD

    private fun uploadTiming() {
        val size = 512; val layers = 4
        val bytes = size * size * 4
        val pixels = ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder())
        for (i in 0 until bytes) pixels.put(i, ProbeTexels.uploadByte(i))
        // the copy source differs from what texSubImage wrote in every byte, so a copy that never ran cannot read back
        val staged = ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder())
        for (i in 0 until bytes) staged.put(i, ProbeTexels.uploadByte(i + 1))
        val names = IntArray(2); GLES20.glGenTextures(2, names, 0)
        GLES20.glBindTexture(GLES30.GL_TEXTURE_2D_ARRAY, names[0])
        GLES30.glTexStorage3D(GLES30.GL_TEXTURE_2D_ARRAY, 1, GLES30.GL_RGBA8, size, size, layers)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, names[1])
        GLES30.glTexStorage2D(GLES20.GL_TEXTURE_2D, 1, GLES30.GL_RGBA8, size, size)
        GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, size, size, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, staged)
        GLES30.glTexSubImage3D(GLES30.GL_TEXTURE_2D_ARRAY, 0, 0, 0, 0, size, size, 1, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, pixels) // warm
        GLES20.glFinish()
        val t0 = System.nanoTime()
        for (layer in 0 until layers) GLES30.glTexSubImage3D(GLES30.GL_TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, pixels)
        val t1 = System.nanoTime(); GLES20.glFinish(); val t2 = System.nanoTime()
        val mb = bytes.toDouble() * layers / (1024 * 1024)
        val out = linkedMapOf<String, JsonElement>(
            "layerBytes" to p(bytes), "layers" to p(layers), "copyPath" to p(paths.copy.name),
            "texSubImageCallUsPerMb" to p((t1 - t0) / 1e3 / mb), "texSubImageTotalUsPerMb" to p((t2 - t0) / 1e3 / mb),
        )
        if (paths.stagingCopy) {
            gl.copyImageSubData(names[1], GLES20.GL_TEXTURE_2D, 0, 0, 0, 0, names[0], GLES30.GL_TEXTURE_2D_ARRAY, 0, 0, 0, 0, size, size, 1) // warm
            GLES20.glFinish()
            val t3 = System.nanoTime()
            for (layer in 0 until layers) gl.copyImageSubData(names[1], GLES20.GL_TEXTURE_2D, 0, 0, 0, 0, names[0], GLES30.GL_TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1)
            val t4 = System.nanoTime(); GLES20.glFinish(); val t5 = System.nanoTime()
            val reader = ProbeGl.LayerReader(names[0], layers - 1)
            val matched = if (reader.complete) ProbeTexels.uploadMatches(raw.readRow(8), 32, offset = 1) else -1
            reader.delete()
            out["copyImageCallUsPerMb"] = p((t4 - t3) / 1e3 / mb); out["copyImageTotalUsPerMb"] = p((t5 - t3) / 1e3 / mb)
            out["copyVerifiedBytes"] = p("${maxOf(matched, 0)}/32")
            out["copyVerified"] = p(matched == 32)
            out["copiesRefused"] = p(gl.copiesRefused)
        } else out["copyImage"] = p("skipped: no copy path on this context ($paths)")
        GLES20.glDeleteTextures(2, names, 0)
        report.put("uploadTiming", JsonObject(out))
        status("upload: $out")
    }

    // ------------------------------------------------------------------ BENCH

    private val steps = ProbeBench.plan()
    private var stepIndex = 0
    private val stopped = HashSet<BenchKind>()
    private val results = ArrayList<JsonElement>()
    private var benchSetup: BenchSetup? = null

    private inner class BenchSetup {
        val rgba8: Int; val rgba16ui: Int
        val targets = HashMap<Int, ProbeGl.Target>()
        val baselineFinishMs: Double
        init {
            val size = ProbeBench.TEXTURE_SIZE
            val names = IntArray(2); GLES20.glGenTextures(2, names, 0)
            rgba8 = names[0]; rgba16ui = names[1]
            val bytes = ByteBuffer.allocateDirect(size * size * 8).order(ByteOrder.nativeOrder())
            for (i in 0 until size * size * 8) bytes.put(i, ((i * 2654435761L) ushr 24).toByte())
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, rgba8)
            GLES30.glTexStorage2D(GLES20.GL_TEXTURE_2D, 1, GLES30.GL_RGBA8, size, size)
            GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, size, size, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, bytes)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_REPEAT)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_REPEAT)
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, rgba16ui)
            GLES30.glTexStorage2D(GLES20.GL_TEXTURE_2D, 1, GLES30.GL_RGBA16UI, size, size)
            GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, size, size, GLES30.GL_RGBA_INTEGER, GLES20.GL_UNSIGNED_SHORT, bytes)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST)
            for (s in ProbeBench.SIZES) targets[s] = ProbeGl.Target(s)
            GLES20.glFinish()
            val t0 = System.nanoTime(); GLES20.glFinish(); baselineFinishMs = (System.nanoTime() - t0) / 1e6
        }
        fun delete() { GLES20.glDeleteTextures(2, intArrayOf(rgba8, rgba16ui), 0); targets.values.forEach { it.delete() } }
    }

    private fun bench() {
        clear()
        val setup = benchSetup ?: BenchSetup().also { benchSetup = it }
        while (stepIndex < steps.size && steps[stepIndex].kind in stopped) {
            results += JsonObject(mapOf("id" to p(steps[stepIndex].id), "skipped" to p("ramp stop"))); stepIndex++
        }
        if (stepIndex >= steps.size) {
            setup.delete(); benchSetup = null
            report.put("bench", JsonObject(mapOf("baselineFinishMs" to p(setup.baselineFinishMs), "rampStopMs" to p(ProbeBench.RAMP_STOP_MS),
                "draws" to p(ProbeBench.DRAWS), "emulatorTimingsAreNotEvidence" to p(emulator), "steps" to JsonArray(results))))
            enter(Phase.PACING)
            return
        }
        val step = steps[stepIndex++]
        val program = raw.link(ProbeBench.VERTEX_SHADER, ProbeBench.fragmentShader(step.kind, step.iterations))
        val target = setup.targets.getValue(step.size)
        target.bind()
        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, if (step.kind == BenchKind.FETCH_RGBA16UI) setup.rgba16ui else setup.rgba8)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "u_tex"), 0)
        raw.fullscreen(); GLES20.glFinish() // warm: pipeline variant and caches
        val t0 = System.nanoTime()
        repeat(step.draws) { raw.fullscreen() }
        GLES20.glFinish()
        val ms = (System.nanoTime() - t0) / 1e6
        GLES20.glUseProgram(0)
        GLES20.glDeleteProgram(program)
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        if (!ProbeBench.allowsNext(ms)) stopped += step.kind
        results += JsonObject(mapOf("id" to p(step.id), "ms" to p(ms), "msPerDraw" to p(ms / step.draws),
            "nsPerFetch" to p(ProbeBench.nsPerFetch(step, ms)), "fragments" to p(step.fragments), "iterations" to p(step.iterations)))
        status("bench ${step.id}: ${"%.2f".format(ms / step.draws)} ms/draw")
    }

    // ------------------------------------------------------------------ PACING, IDLE and TOUCH

    private val starts = LongArray(1024)
    private var startCount = 0
    private var pacingBeginNs = 0L
    private var pacerStartsAtBegin = 0L
    private var presentationsAtBegin = 0L

    private fun pacingBegin() {
        startCount = 0
        pacingBeginNs = System.nanoTime()
        pacerStartsAtBegin = pacer.framesStarted
        presentationsAtBegin = pacer.presentationsSet
        pacer.setContinuous(true)
    }

    private fun frameStart(start: Long) { if (startCount < starts.size) starts[startCount++] = start }

    private fun pacing() {
        val t = (System.nanoTime() - pacingBeginNs) / 1e9
        clear((t % 1.0).toFloat() * 0.3f, 0.1f, 0.2f)
        if (t < 5.0) return
        val stats = PacingStats.fromStarts(starts, startCount)
        report.put("pacing", JsonObject(mapOf(
            "seconds" to p(5), "refreshHz" to p(pacer.refreshHz), "interval" to p(pacer.interval), "targetFps" to p(pacer.targetFps),
            "presentationTimeSupported" to p(pacer.presentationTimeSupported), "presentationsSet" to p(pacer.presentationsSet - presentationsAtBegin),
            "framesStarted" to p(pacer.framesStarted - pacerStartsAtBegin), "frames" to p(stats?.frames),
            "p50Ms" to p(stats?.p50Ms), "p95Ms" to p(stats?.p95Ms), "p99Ms" to p(stats?.p99Ms),
            "intervalsOver20Ms" to p(stats?.over20Ms), "intervalsOver50Ms" to p(stats?.over50Ms),
            "note" to p("app-side frame starts, untouched; the gate is SurfaceFlinger present-to-present (measure-live-seeker)"),
        )))
        status("pacing: ${stats?.frames} frames, p50 ${stats?.p50Ms} p95 ${stats?.p95Ms} ms at ${pacer.refreshHz} Hz / interval ${pacer.interval}")
        enter(Phase.IDLE)
    }

    @Volatile private var idleFrames = -1L

    /** Motion off; 3 s later (UI thread) count the frames drawn meanwhile, then ask for the touch window. */
    private fun idleBegin() {
        pacer.setContinuous(false)
        val world = graphics()
        val before = world?.framesDrawn ?: 0L
        later(IDLE_MS, Runnable {
            idleFrames = (world?.framesDrawn ?: 0L) - before
            enter(Phase.TOUCH)
        })
    }

    @Volatile private var touchTimedOut = false
    private var touchStartNs = 0L
    private var touchEventsAtStart = 0
    private var touchPresentationsAtStart = 0L
    private var refreshMin = Float.MAX_VALUE
    private var refreshMax = 0f

    private fun touchBegin() {
        touchMode(true)
        status("DRAG: drag one finger around the screen for ${TOUCH_WINDOW_MS / 1000} seconds")
        later(TOUCH_WAIT_MS, Runnable { touchTimedOut = true; pacer.markDirty() })
        pacer.markDirty()
    }

    /** On-demand frames only: each touch event requests one (`WorldGraphics.requestRendering` → the pacer's dirty
     *  flag), so a 120 Hz touch stream must still render at the paced 60. */
    private fun touch() {
        val now = System.nanoTime()
        clear(0.25f, 0.12f, 0.05f)
        if (touchStartNs == 0L) {
            if (touchEvents > 0) {
                touchStartNs = now; startCount = 0
                touchEventsAtStart = touchEvents; touchPresentationsAtStart = pacer.presentationsSet
                later(TOUCH_WINDOW_MS + 250L, Runnable { pacer.markDirty() }) // ends the window if the finger lifted early
            } else if (touchTimedOut) {
                report.put("touchPacing", JsonObject(mapOf("touched" to p(false),
                    "note" to p("nobody touched the screen within ${TOUCH_WAIT_MS / 1000} s: pacing under touch is unanswered"))))
                finishTouch()
            }
            return
        }
        val hz = pacer.refreshHz
        if (hz < refreshMin) refreshMin = hz
        if (hz > refreshMax) refreshMax = hz
        if (now - touchStartNs < TOUCH_WINDOW_MS * 1_000_000L) return
        val stats = PacingStats.fromStarts(starts, startCount)
        report.put("touchPacing", JsonObject(mapOf(
            "touched" to p(true), "seconds" to p(TOUCH_WINDOW_MS / 1000), "touchEvents" to p(touchEvents - touchEventsAtStart),
            "frames" to p(stats?.frames), "p50Ms" to p(stats?.p50Ms), "p95Ms" to p(stats?.p95Ms), "p99Ms" to p(stats?.p99Ms),
            "intervalsOver20Ms" to p(stats?.over20Ms), "intervalsOver50Ms" to p(stats?.over50Ms),
            "refreshHzMin" to p(refreshMin), "refreshHzMax" to p(refreshMax), "interval" to p(pacer.interval), "targetFps" to p(pacer.targetFps),
            "presentationsSet" to p(pacer.presentationsSet - touchPresentationsAtStart),
            "note" to p("frames requested only by touch events; 60 fps on a 120 Hz panel reads p50 near 16.7 ms and more touch events " +
                "than frames; intervals include any pause of the finger; refreshHz is the display mode seen by the pacer"),
        )))
        status("touch: ${touchEvents - touchEventsAtStart} events, ${stats?.frames} frames, p50 ${stats?.p50Ms} ms, refresh $refreshMin..$refreshMax Hz")
        finishTouch()
    }

    private fun finishTouch() { touchMode(false); enter(Phase.DONE) }

    private fun done() {
        clear(0.05f, 0.2f, 0.08f)
        if ("idle" !in report) report.put("idle", JsonObject(mapOf("windowMs" to p(IDLE_MS), "framesDrawn" to p(idleFrames),
            "expect" to p("at most 1 (the frame that switched motion off); more means something keeps requesting frames"))))
        val sizes = synchronized(surfaces) { surfaces.toList() }
        val actual = sizes.lastOrNull()
        report.put("surface", JsonObject(mapOf("requested" to p("${requestedSurface[0]}x${requestedSurface[1]}"),
            "actual" to p(actual), "history" to JsonArray(sizes.map { p(it) }),
            "fixedSizeHeld" to p(actual == "${requestedSurface[0]}x${requestedSurface[1]}"),
            "compositionCheck" to p("owner step: adb shell dumpsys SurfaceFlinger while the probe runs (world layer must be DEVICE, not CLIENT)"))))
        report.put("unanswerable", ProbeReport.unanswerable())
        report.put("ownerSteps", ProbeReport.ownerSteps())
        phase = Phase.REPORTED
        pacer.setContinuous(false)
        finished(report)
    }

    private fun p(value: String?) = JsonPrimitive(value)
    private fun p(value: Number?) = JsonPrimitive(value)
    private fun p(value: Boolean?) = JsonPrimitive(value)

    companion object {
        const val LAYER_SIZE = 256
        const val IDLE_MS = 3_000L
        /** How long the probe waits for the owner's finger, and how long it then measures. */
        const val TOUCH_WAIT_MS = 30_000L
        const val TOUCH_WINDOW_MS = 5_000L
        const val ARRAY_FS = "#version 300 es\nprecision mediump float;\nprecision mediump sampler2DArray;\n" +
            "uniform sampler2DArray u_tex;\nuniform int u_layer;\nout vec4 o_color;\n" +
            "void main() { o_color = texture(u_tex, vec3(gl_FragCoord.xy / 256.0, float(u_layer))); }\n"
    }
}
