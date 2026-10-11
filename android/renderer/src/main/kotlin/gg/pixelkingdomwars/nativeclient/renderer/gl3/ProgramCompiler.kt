package gg.pixelkingdomwars.nativeclient.renderer.gl3

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * One program to build off the GL thread (GLOBE-NATIVE-PLAN §5.3). The GL thread creates it; the builder (on the
 * shared worker context) fills [program], [fence], [error] and the flags, then publishes [state] LAST: the volatile
 * write orders every other field before it, so the GL thread reads [state] first and the rest is visible.
 *
 * Stages are the fully preprocessed strings from the generated `WorldShaders.kt` (no `#include` at run time); their
 * sha256 hashes come from the same file, or are computed by the builder when absent.
 *
 * Every write of [state] other than QUEUED runs [onSettled] right after it, on the writing thread, whoever writes it (the
 * builder, or a compiler reporting its worker gone). `Gl3Core` sets it to the host's wake, because the world renders on
 * demand and sits at 0 fps when idle (plan §5.6, §5.8): without it, a program built between frames would wait for the
 * next input before any frame adopted it.
 */
class ProgramJob(val name: String, val vs: String, val fs: String, val vsSha256: String? = null, val fsSha256: String? = null) {
    /** Any-thread and non-blocking (the pacer's `markDirty`). Cleared when the job is abandoned. */
    @Volatile var onSettled: Runnable? = null
    @Volatile var state: Int = QUEUED
        set(value) { field = value; if (value != QUEUED) onSettled?.run() }
    /** The context generation the job was submitted in; a job from a lost context is discarded, never adopted. */
    @Volatile var epoch: Int = 0
    @Volatile var program: Int = 0
    @Volatile var fence: Long = 0L
    @Volatile var error: String? = null
    @Volatile var fromCache: Boolean = false
    @Volatile var buildNanos: Long = 0L

    companion object {
        const val QUEUED = 0
        const val BUILT = 1
        const val FAILED = 2
    }
}

/**
 * Where programs are compiled and linked. [submit] runs on the GL thread and never blocks unless [blocksCaller].
 * `:app` implements the shared-context worker (`SharedContextCompiler`: one pbuffer EGL context in the world context's
 * share group, LOW priority when `EGL_IMG_context_priority` is listed, running [ProgramBuilder] per job). When that
 * context cannot be created, [DirectProgramCompiler] builds on the GL thread, and [Gl3Core] allows that only before the
 * first world frame (behind the Compose loading state): after it, a GL-thread link is refused. After a context loss it
 * relinks one program per frame while [Gl3Core.restoring] (the host shows the loading state and the notice).
 *
 * Completion is reported through [ProgramJob.onSettled] (set by [Gl3Core]), so an implementation needs no callback of
 * its own: it only publishes [ProgramJob.state].
 */
interface ProgramCompiler {
    /** True when [submit] builds on the calling (GL) thread and blocks it. */
    val blocksCaller: Boolean
    fun submit(job: ProgramJob)
    /** The world context was replaced (plan §5.7): rebuild the worker context in the new share group and drop every
     *  queued job of an older [ProgramJob.epoch] (their programs belong to the dead share group). */
    fun contextChanged(epoch: Int) {}
    /** O(1) and never joins: the worker finishes its current item and destroys its own context (plan §5.9). */
    fun dispose()
}

/** The no-worker fallback: builds on the GL thread, so only before the first world frame, and after a context loss one
 *  program per frame while [Gl3Core.restoring] (both enforced by [Gl3Core]). */
class DirectProgramCompiler(private val builder: ProgramBuilder) : ProgramCompiler {
    override val blocksCaller: Boolean get() = true
    override fun submit(job: ProgramJob) = builder.build(job)
    override fun dispose() {}
}

/**
 * Builds one program on the context of [gl] (the worker, or the GL thread before the first frame). Status queries
 * block here, which is why this never runs on the world context after its first frame.
 *
 * Order: a cached binary first (a rejected one is deleted and the program rebuilt from source), else compile + link
 * with `GL_PROGRAM_BINARY_RETRIEVABLE_HINT` and store the binary. The view uniform block is bound here (so the GL
 * thread never queries a block index), then a fence is inserted and flushed: the GL thread adopts the program only
 * after that fence has signalled (polled with timeout 0).
 */
class ProgramBuilder(
    private val gl: Gl3,
    private val cache: ProgramCache?,
    private val viewBlock: String,
    private val viewBinding: Int,
    private val nanoTime: () -> Long = System::nanoTime,
) {
    private val formats = IntArray(32)
    private val formatOut = IntArray(1)

    fun build(job: ProgramJob) {
        val t0 = nanoTime()
        try {
            val formatCount = if (cache == null || gl.getInteger(GL30.GL_NUM_PROGRAM_BINARY_FORMATS) <= 0) 0
                else gl.getIntegers(GL30.GL_PROGRAM_BINARY_FORMATS, formats)
            val key = if (formatCount > 0) cache!!.key(job.vsSha256 ?: ProgramCache.sha256Hex(job.vs), job.fsSha256 ?: ProgramCache.sha256Hex(job.fs)) else null
            if (key != null) {
                val binary = cache!!.load(key, formats, formatCount)
                if (binary != null) {
                    val program = gl.createProgram()
                    gl.programBinary(program, binary.format, direct(binary.bytes), binary.bytes.size)
                    if (gl.getProgrami(program, GL20.GL_LINK_STATUS) == GL20.GL_TRUE) { finish(job, program, true, t0); return }
                    gl.deleteProgram(program); cache.invalidate(key)
                }
            }
            val vs = compile(GL20.GL_VERTEX_SHADER, job.vs)
            val fs = compile(GL20.GL_FRAGMENT_SHADER, job.fs)
            val vsLog = log(vs); val fsLog = log(fs)
            if (vsLog != null || fsLog != null) {
                gl.deleteShader(vs); gl.deleteShader(fs)
                return fail(job, "realm program ${job.name}: ${listOfNotNull(vsLog?.let { "vs: $it" }, fsLog?.let { "fs: $it" }).joinToString(" ")}")
            }
            val program = gl.createProgram()
            gl.attachShader(program, vs); gl.attachShader(program, fs)
            if (key != null) gl.programParameteri(program, GL30.GL_PROGRAM_BINARY_RETRIEVABLE_HINT, GL20.GL_TRUE)
            gl.linkProgram(program)
            val linked = gl.getProgrami(program, GL20.GL_LINK_STATUS) == GL20.GL_TRUE
            gl.detachShader(program, vs); gl.detachShader(program, fs); gl.deleteShader(vs); gl.deleteShader(fs)
            if (!linked) {
                val message = "realm program ${job.name}: ${gl.getProgramInfoLog(program)}"
                gl.deleteProgram(program)
                return fail(job, message)
            }
            if (key != null) storeBinary(key, program)
            finish(job, program, false, t0)
        } catch (error: RuntimeException) {
            fail(job, "realm program ${job.name}: ${error.message}")
        }
    }

    private fun compile(type: Int, source: String): Int {
        val shader = gl.createShader(type)
        gl.shaderSource(shader, source); gl.compileShader(shader)
        return shader
    }

    private fun log(shader: Int): String? = if (gl.getShaderi(shader, GL20.GL_COMPILE_STATUS) == GL20.GL_TRUE) null else gl.getShaderInfoLog(shader)

    private fun storeBinary(key: String, program: Int) {
        val length = gl.getProgrami(program, GL30.GL_PROGRAM_BINARY_LENGTH)
        if (length <= 0) return
        val buffer = ByteBuffer.allocateDirect(length).order(ByteOrder.nativeOrder())
        val written = gl.getProgramBinary(program, buffer, formatOut)
        if (written <= 0) return
        val bytes = ByteArray(written)
        buffer.position(0); buffer.get(bytes, 0, written)
        cache!!.store(key, formatOut[0], bytes)
    }

    private fun finish(job: ProgramJob, program: Int, fromCache: Boolean, t0: Long) {
        val block = gl.getUniformBlockIndex(program, viewBlock)
        if (block != GL30.GL_INVALID_INDEX) gl.uniformBlockBinding(program, block, viewBinding)
        job.program = program
        job.fromCache = fromCache
        job.fence = gl.fenceSync()
        gl.flush()
        job.buildNanos = nanoTime() - t0
        job.state = ProgramJob.BUILT
    }

    private fun fail(job: ProgramJob, message: String) {
        job.error = message
        job.state = ProgramJob.FAILED
    }

    private fun direct(bytes: ByteArray): ByteBuffer =
        ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).put(bytes).also { it.position(0) }
}
