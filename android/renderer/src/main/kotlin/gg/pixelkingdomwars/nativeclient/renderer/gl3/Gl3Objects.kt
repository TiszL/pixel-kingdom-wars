package gg.pixelkingdomwars.nativeclient.renderer.gl3

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.IntBuffer

/** Which allocator tally a GPU object counts against (plan §5.8). CORE (UBOs, quads, dummies, the lowres ground
 *  target) is tallied but uncapped: the plan books it on the swapchain/driver line, not in the 200 MB combined cap. */
enum class Gl3Pool { GLOBE, REALM, CORE }

/** How a colour target starts a pass (plan §5.9: every FBO is cleared or invalidated at bind; KEEP is a tile reload
 *  on Mali and is counted in [Gl3Stats.reloads]). */
enum class Gl3Load { CLEAR, DONT_CARE, KEEP }

enum class Gl3Sampling { NEAREST, LINEAR, NEAREST_MIPMAP_NEAREST, LINEAR_MIPMAP_LINEAR }
enum class Gl3Wrap { CLAMP, REPEAT, MIRROR }

/**
 * A program created through [Gl3Core.program]. It is PENDING until its background build has ended and its fence has
 * signalled; draws issued while it is not READY are skipped and counted, never waited for (the native analogue of the
 * web's `KHR_parallel_shader_compile` path, core.js `settle`).
 */
class Gl3Program internal constructor(val name: String, internal val vs: String, internal val fs: String,
                                       internal val vsSha256: String?, internal val fsSha256: String?, val uid: Int) {
    var state: Int = PENDING; internal set
    var error: String? = null; internal set
    /** True when the adopted program came from the binary cache. */
    var fromCache: Boolean = false; internal set
    /** Worker time from submit to fence, for `stats().programs.linkMs`. */
    var buildNanos: Long = 0L; internal set
    internal var handle = 0
    internal var epoch = -1
    internal lateinit var job: ProgramJob
    private val locations = HashMap<String, Int>()

    val ready: Boolean get() = state == READY

    /** Uniform location, -1 until READY (GL calls on -1 are no-ops). Cached: only the first lookup queries GL. */
    fun uniform(core: Gl3Core, name: String): Int {
        if (state != READY || epoch != core.epoch) return -1
        return locations.getOrPut(name) { core.gl.getUniformLocation(handle, name) }
    }

    internal fun resetLocations() = locations.clear()

    companion object {
        const val PENDING = 0
        const val READY = 1
        const val FAILED = 2
    }
}

/**
 * An immutable texture (texStorage) tracked by the allocator. READY once its storage exists and, when a worker filled
 * it, once the worker's fence has signalled. [sampled] turns true at its first bind for sampling: from then on the
 * texture is LIVE and an array layer may change only through the staging copy (plan §5.7, no Mali ghosting).
 */
class Gl3Texture internal constructor(
    val uid: Int, val pool: Gl3Pool, val target: Int, val width: Int, val height: Int, val layers: Int, val levels: Int,
    val format: Gl3Format, val bytes: Long,
) {
    var state: Int = PENDING; internal set
    var sampled: Boolean = false; internal set
    /** May the allocator free this texture to make room (an LRU cache entry)? [onEvict] is told first. */
    var evictable: Boolean = false
    var onEvict: ((Gl3Texture) -> Unit)? = null
    internal var name = 0
    internal var epoch = -1
    internal var fence = 0L
    internal var usedFrame = -1L
    internal var fbos: IntArray? = null
    internal var prev: Gl3Texture? = null
    internal var next: Gl3Texture? = null
    internal var tracked = false

    val ready: Boolean get() = state == READY
    val isArray: Boolean get() = layers > 1 || target == com.badlogic.gdx.graphics.GL30.GL_TEXTURE_2D_ARRAY

    companion object {
        const val PENDING = 0
        const val READY = 1
        const val FREED = 2
    }
}

/** A vertex array with the vertex-layout id its pipeline variants depend on (part of the (program, state) key). */
class Gl3VertexArray internal constructor(val layout: Int) {
    internal var name = 0
    internal var epoch = -1
}

/** A std140 uniform block (the RealmView UBO at binding 0). Fill [floats]/[ints] with absolute puts, then
 *  [Gl3Core.upload]. Both views share [bytes]; positions stay 0, so an upload never allocates. */
class Gl3UniformBlock internal constructor(val binding: Int, val sizeBytes: Int) {
    val bytes: ByteBuffer = ByteBuffer.allocateDirect(sizeBytes).order(ByteOrder.nativeOrder())
    val floats: FloatBuffer = bytes.asFloatBuffer()
    val ints: IntBuffer = bytes.asIntBuffer()
    internal var buffer = 0
    internal var epoch = -1
}

/** Counters for the debug overlay and the gates (plan §8.3). Cumulative unless named `…Last`. */
class Gl3Stats {
    var frames = 0L
    var drawsLast = 0; var instancesLast = 0L; var passesLast = 0
    var skippedDraws = 0L
    /** (program, state) pairs drawn for the first time, in a rehearsal and in a live pass. */
    var rehearsedFirstDraws = 0L; var liveFirstDraws = 0L
    var rehearsalDraws = 0L
    var adoptions = 0L; var adoptedFromCache = 0L; var failedPrograms = 0L
    var uploadBytes = 0L; var copyBytes = 0L
    var reloads = 0L
    var refusals = 0L; var evictions = 0L
    var contextLosses = 0
    var staleUses = 0L
    var orderViolations = 0L
    var gpuBoundFrames = 0L
    val poolBytes = LongArray(Gl3Pool.entries.size)

    fun gpuBytes(pool: Gl3Pool): Long = poolBytes[pool.ordinal]
}

/** What one frame did, for [HangGuard][gg.pixelkingdomwars.nativeclient.renderer.world.HangGuard], the ladder and
 *  the sampler. One instance, reused every frame. */
class Gl3FrameReport {
    var frame = 0L
    /** One-off work (a first-drawn pair, a program adoption, > coldUploadBytes uploaded) in this frame or the last. */
    var cold = false
    /** The fence of frame N-2 had not signalled when this frame started (plan §5.4 GPU-bound flag). */
    var gpuBound = false
    /** Fence-latency lower bounds (ms) of earlier frames that completed since the last report, with their coldness. */
    val gpuSamplesMs = DoubleArray(3)
    val gpuSamplesCold = BooleanArray(3)
    var gpuSampleCount = 0
    var draws = 0
    var instances = 0L
    var passes = 0
    var firstDraws = 0
    var adoptions = 0
    var uploadBytes = 0L
    var contextChanged = false
}
