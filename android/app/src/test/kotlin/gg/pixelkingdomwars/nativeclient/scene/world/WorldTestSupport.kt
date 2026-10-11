package gg.pixelkingdomwars.nativeclient.scene.world

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import java.lang.reflect.Proxy
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** One recorded GL call: its name, arguments, result and the thread that issued it. */
class GlCall(val name: String, val args: List<Any?>, val thread: String, val result: Any?) {
    override fun toString() = "$thread:$name$args=$result"
}

/**
 * A recording [Gl3] for `:app` JVM tests (the renderer's `FakeGl3` lives in another module's test sources). Every call
 * is recorded with its thread; object names and sync handles come from counters SHARED by all recorders built on the
 * same [ids], like one share group; fences signal when [signalled] says so (per recorder: a test that shares a fence
 * between contexts sets both). Status queries answer success.
 */
class RecordingGl3(val label: String, private val ids: SharedIds = SharedIds()) {
    val calls: MutableList<GlCall> = Collections.synchronizedList(ArrayList())
    @Volatile var signalled: (Long) -> Boolean = { true }
    @Volatile var linkOk = true
    @Volatile var binaryFormats = 0

    val gl: Gl3 = Proxy.newProxyInstance(Gl3::class.java.classLoader, arrayOf(Gl3::class.java)) { proxy, method, rawArgs ->
        val args = rawArgs?.toList() ?: emptyList()
        when (method.name) {
            "toString" -> return@newProxyInstance "RecordingGl3($label)"
            "hashCode" -> return@newProxyInstance System.identityHashCode(proxy)
            "equals" -> return@newProxyInstance proxy === args[0]
        }
        val result: Any? = when (method.name) {
            "genTexture", "genBuffer", "genVertexArray", "genFramebuffer", "createShader", "createProgram" -> ids.names.incrementAndGet()
            "fenceSync" -> ids.syncs.incrementAndGet()
            // like a driver, an unsignalled wait with a timeout takes (up to 5 ms of) that timeout
            "clientWaitSync" -> if (signalled(args[0] as Long)) GL30.GL_ALREADY_SIGNALED
                else GL30.GL_TIMEOUT_EXPIRED.also { val ns = args[2] as Long; if (ns > 0) Thread.sleep(minOf(5L, maxOf(1L, ns / 1_000_000L))) }
            "getShaderi" -> GL20.GL_TRUE
            "getProgrami" -> when (args[1] as Int) { GL20.GL_LINK_STATUS -> if (linkOk) GL20.GL_TRUE else GL20.GL_FALSE; else -> 0 }
            "getInteger" -> when (args[0] as Int) {
                GL20.GL_MAX_TEXTURE_IMAGE_UNITS, GL20.GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS -> 16
                GL30.GL_NUM_PROGRAM_BINARY_FORMATS -> binaryFormats
                else -> 0
            }
            "getIntegers", "getProgramBinary", "getError", "getGraphicsResetStatus", "getUniformLocation" -> 0
            "getUniformBlockIndex" -> GL30.GL_INVALID_INDEX
            "checkFramebufferStatus" -> GL20.GL_FRAMEBUFFER_COMPLETE
            "isProgram" -> true
            "getString" -> "Recording $label"
            "getShaderInfoLog", "getProgramInfoLog" -> ""
            else -> null
        }
        calls += GlCall(method.name, args, Thread.currentThread().name, result)
        result
    } as Gl3

    fun named(name: String): List<GlCall> = synchronized(calls) { calls.filter { it.name == name } }
    fun count(name: String): Int = named(name).size
    fun threads(): Set<String> = synchronized(calls) { calls.mapTo(HashSet()) { it.thread } }
}

/** Object names and sync handles shared by the recorders of one share group. */
class SharedIds { val names = AtomicInteger(); val syncs = AtomicLong() }

/** A worker context over a [RecordingGl3]; records where it was made current and destroyed. */
class FakeWorkerContext(val share: Any, ids: SharedIds, private val current: Boolean = true) : WorkerContext {
    val recorder = RecordingGl3("worker", ids)
    override val gl: Gl3 = recorder.gl
    override val description = "fake($share)"
    @Volatile var currentOn: String? = null
    @Volatile var destroyedOn: String? = null
    override fun makeCurrent(): Boolean { currentOn = Thread.currentThread().name; return current }
    override fun destroy() { destroyedOn = Thread.currentThread().name }
}

class FakeWorkerContexts(private val ids: SharedIds) : WorkerContexts {
    val created: MutableList<FakeWorkerContext> = Collections.synchronizedList(ArrayList())
    @Volatile var refuse = false
    @Volatile var makeCurrentFails = false
    override fun create(share: Any): WorkerContext? {
        if (refuse) return null
        return FakeWorkerContext(share, ids, current = !makeCurrentFails).also { created += it }
    }
}

/** Polls [condition] for up to [timeoutMs]; the tests never sleep a fixed time to "let a thread run". */
fun eventually(timeoutMs: Long = 5_000L, condition: () -> Boolean): Boolean {
    val end = System.nanoTime() + timeoutMs * 1_000_000L
    while (System.nanoTime() < end) { if (condition()) return true; Thread.sleep(2) }
    return condition()
}
