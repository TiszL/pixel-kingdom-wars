package gg.pixelkingdomwars.nativeclient.renderer.gl3

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import java.nio.Buffer
import java.nio.ByteBuffer

/** GL objects shared by the contexts of one share group (the world context and its worker), like EGL share groups. */
class FakeShareGroup(
    /** Program binaries embed this token; a different token (a driver update) makes `glProgramBinary` fail to link. */
    var driverToken: String = "mali-g615-r47",
    var binaryFormats: IntArray = intArrayOf(0x8743),
) {
    /** False: `GL_PROGRAM_BINARY_LENGTH` reports 0 (some drivers cannot return a binary for a given program). */
    var binaryRetrievable = true
    internal val programs = ArrayList<FakeProgram?>().apply { add(null) }
    internal val shaders = ArrayList<FakeShader?>().apply { add(null) }
    internal val textures = ArrayList<FakeTexture?>().apply { add(null) }
    internal val framebuffers = ArrayList<IntArray?>().apply { add(null) } // [colour texture, layer, depth texture]
    internal var buffers = 0
    internal var vertexArrays = 0
    internal var syncs = 0L
    /** Fences complete in creation order, like a GPU queue: every sync ≤ this id has signalled. */
    var signalledThrough = Long.MAX_VALUE
    var liveSyncs = 0

    fun program(id: Int): FakeProgram? = programs.getOrNull(id)
    fun texture(id: Int): FakeTexture? = textures.getOrNull(id)
    /** Make fences manual: nothing signals until [signalAll] or [signalThrough]. */
    fun holdFences() { signalledThrough = syncs }
    fun signalAll() { signalledThrough = Long.MAX_VALUE }
}

class FakeShader(val type: Int, var source: String = "", var compiled: Boolean = false)
class FakeProgram(val id: Int) {
    val shaders = ArrayList<FakeShader>()
    var vs = ""; var fs = ""
    var linked = false
    var fromBinary = false
    var retrievable = false
    var blockBinding = -1
}
class FakeTexture(val target: Int) {
    var internalFormat = 0; var width = 0; var height = 0; var layers = 1; var levels = 0
    val subImages = ArrayList<IntArray>() // [level, x, y, z, w, h]
    var copies = 0
}

/**
 * Recording fake of [Gl3] for JVM tests (GLOBE-NATIVE-PLAN §8.2). It tracks the real bound state so tests can check
 * what a draw hit, counts every call per name, and counts BLOCKING calls (status queries and `clientWaitSync` with a
 * timeout) so a test can prove the world context never issues one. With [record] off it never allocates on the draw,
 * state, fence or texture-bind paths, so the zero-allocation frame test can run on it.
 */
class FakeGl3(val group: FakeShareGroup = FakeShareGroup(), val label: String = "world") : Gl3 {
    var record = true
    val log = ArrayList<String>()
    val draws = ArrayList<FakeDraw>()
    var blockingCalls = 0
    var resetStatus = 0
    var drawCount = 0L
    var callCount = 0L

    // bound state
    var program = 0; private set
    var framebuffer = 0; private set
    var vertexArray = 0; private set
    var activeUnit = 0; private set
    val unitTextures = IntArray(32)
    var blend = false; private set
    var depthTest = false; private set
    var cull = false; private set
    var scissorTest = false; private set
    var depthWrite = true; private set
    var depthFunc = GL20.GL_LESS; private set
    var blendSrcRgb = GL20.GL_ONE; private set
    var blendDstRgb = GL20.GL_ZERO; private set
    var colorMask = 15; private set
    val scissorBox = IntArray(4)
    val viewportBox = IntArray(4)
    var clears = 0
    var invalidations = 0

    private fun call(name: String) { callCount++; if (record) log += name }

    override fun getString(name: Int): String? { call("getString"); return if (name == GL20.GL_RENDERER) "Fake Mali-G615" else "OpenGL ES 3.2 fake" }
    override fun getInteger(pname: Int): Int { call("getInteger"); return when (pname) {
        GL30.GL_NUM_PROGRAM_BINARY_FORMATS -> group.binaryFormats.size
        GL20.GL_MAX_TEXTURE_IMAGE_UNITS -> 16
        GL20.GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS -> 32
        else -> 0 } }
    override fun getIntegers(pname: Int, out: IntArray): Int {
        call("getIntegers")
        if (pname != GL30.GL_PROGRAM_BINARY_FORMATS) return 0
        val n = minOf(out.size, group.binaryFormats.size)
        for (i in 0 until n) out[i] = group.binaryFormats[i]
        return n
    }
    override fun getError(): Int { call("getError"); return 0 }
    override fun getGraphicsResetStatus(): Int { call("getGraphicsResetStatus"); return resetStatus }
    override fun flush() = call("flush")

    override fun createShader(type: Int): Int { call("createShader"); group.shaders += FakeShader(type); return group.shaders.size - 1 }
    override fun shaderSource(shader: Int, source: String) { call("shaderSource"); group.shaders[shader]!!.source = source }
    override fun compileShader(shader: Int) { call("compileShader"); val s = group.shaders[shader]!!; s.compiled = !s.source.contains("#error") }
    override fun getShaderi(shader: Int, pname: Int): Int {
        call("getShaderi"); blockingCalls++
        return if (group.shaders[shader]!!.compiled) GL20.GL_TRUE else GL20.GL_FALSE
    }
    override fun getShaderInfoLog(shader: Int): String { call("getShaderInfoLog"); return "ERROR: 0:1: '#error' : fake compile error" }
    override fun deleteShader(shader: Int) { call("deleteShader") }
    override fun createProgram(): Int { call("createProgram"); val id = group.programs.size; group.programs += FakeProgram(id); return id }
    override fun attachShader(program: Int, shader: Int) { call("attachShader"); group.programs[program]!!.shaders += group.shaders[shader]!! }
    override fun detachShader(program: Int, shader: Int) { call("detachShader"); group.programs[program]!!.shaders.remove(group.shaders[shader]) }
    override fun linkProgram(program: Int) {
        call("linkProgram")
        val p = group.programs[program]!!
        p.vs = p.shaders.firstOrNull { it.type == GL20.GL_VERTEX_SHADER }?.source ?: ""
        p.fs = p.shaders.firstOrNull { it.type == GL20.GL_FRAGMENT_SHADER }?.source ?: ""
        p.linked = p.shaders.size == 2 && p.shaders.all { it.compiled } && !p.fs.contains("#link-error")
    }
    override fun getProgrami(program: Int, pname: Int): Int {
        call("getProgrami")
        val p = group.programs[program]!!
        return when (pname) {
            GL20.GL_LINK_STATUS -> { blockingCalls++; if (p.linked) GL20.GL_TRUE else GL20.GL_FALSE }
            GL30.GL_PROGRAM_BINARY_LENGTH -> if (group.binaryRetrievable) binaryOf(p).size else 0
            else -> 0
        }
    }
    override fun getProgramInfoLog(program: Int): String { call("getProgramInfoLog"); return "fake link error" }
    override fun deleteProgram(program: Int) { call("deleteProgram"); if (program in 1 until group.programs.size) group.programs[program] = null }
    override fun isProgram(program: Int): Boolean { call("isProgram"); return program in 1 until group.programs.size && group.programs[program] != null }
    override fun useProgram(program: Int) { call("useProgram"); this.program = program }
    override fun programParameteri(program: Int, pname: Int, value: Int) {
        call("programParameteri"); if (pname == GL30.GL_PROGRAM_BINARY_RETRIEVABLE_HINT) group.programs[program]!!.retrievable = value == GL20.GL_TRUE
    }
    override fun getProgramBinary(program: Int, out: ByteBuffer, format: IntArray): Int {
        call("getProgramBinary")
        val bytes = binaryOf(group.programs[program]!!)
        out.position(0); out.put(bytes); format[0] = group.binaryFormats[0]
        return bytes.size
    }
    override fun programBinary(program: Int, format: Int, binary: ByteBuffer, length: Int) {
        call("programBinary")
        val bytes = ByteArray(length); binary.position(0); binary.get(bytes)
        val text = String(bytes, Charsets.UTF_8)
        val p = group.programs[program]!!
        p.linked = format in group.binaryFormats && text.startsWith(group.driverToken + "|")
        p.fromBinary = p.linked
        if (p.linked) { val parts = text.split("|", limit = 3); p.vs = parts[1]; p.fs = parts[2] }
    }
    private fun binaryOf(p: FakeProgram) = "${group.driverToken}|${p.vs.replace("|", "")}|${p.fs}".toByteArray(Charsets.UTF_8)
    override fun getUniformLocation(program: Int, name: String): Int { call("getUniformLocation"); return name.length }
    override fun getUniformBlockIndex(program: Int, name: String): Int {
        call("getUniformBlockIndex"); val p = group.programs[program]!!
        return if (p.vs.contains(name) || p.fs.contains(name)) 0 else GL30.GL_INVALID_INDEX
    }
    override fun uniformBlockBinding(program: Int, blockIndex: Int, binding: Int) { call("uniformBlockBinding"); group.programs[program]!!.blockBinding = binding }
    override fun uniform1i(location: Int, v: Int) = call("uniform1i")
    override fun uniform1f(location: Int, v: Float) = call("uniform1f")
    override fun uniform2f(location: Int, x: Float, y: Float) = call("uniform2f")
    override fun uniform3f(location: Int, x: Float, y: Float, z: Float) = call("uniform3f")
    override fun uniform4f(location: Int, x: Float, y: Float, z: Float, w: Float) = call("uniform4f")

    override fun genBuffer(): Int { call("genBuffer"); return ++group.buffers }
    override fun deleteBuffer(buffer: Int) = call("deleteBuffer")
    override fun bindBuffer(target: Int, buffer: Int) = call("bindBuffer")
    override fun bufferData(target: Int, size: Int, data: Buffer?, usage: Int) = call("bufferData")
    override fun bufferSubData(target: Int, offset: Int, size: Int, data: Buffer) = call("bufferSubData")
    override fun bindBufferBase(target: Int, index: Int, buffer: Int) = call("bindBufferBase")
    override fun genVertexArray(): Int { call("genVertexArray"); return ++group.vertexArrays }
    override fun deleteVertexArray(array: Int) = call("deleteVertexArray")
    override fun bindVertexArray(array: Int) { call("bindVertexArray"); vertexArray = array }
    override fun enableVertexAttribArray(index: Int) = call("enableVertexAttribArray")
    override fun vertexAttribPointer(index: Int, size: Int, type: Int, normalized: Boolean, stride: Int, offset: Int) = call("vertexAttribPointer")
    override fun vertexAttribIPointer(index: Int, size: Int, type: Int, stride: Int, offset: Int) = call("vertexAttribIPointer")
    override fun vertexAttribDivisor(index: Int, divisor: Int) = call("vertexAttribDivisor")

    override fun genTexture(): Int { call("genTexture"); group.textures += null; return group.textures.size - 1 }
    override fun deleteTexture(texture: Int) { call("deleteTexture"); if (texture in 1 until group.textures.size) group.textures[texture] = null }
    override fun activeTexture(unit: Int) { call("activeTexture"); activeUnit = unit - GL20.GL_TEXTURE0 }
    override fun bindTexture(target: Int, texture: Int) {
        call("bindTexture"); unitTextures[activeUnit] = texture
        if (texture != 0 && group.textures[texture] == null) group.textures[texture] = FakeTexture(target)
    }
    override fun texParameteri(target: Int, pname: Int, value: Int) = call("texParameteri")
    override fun texStorage2D(target: Int, levels: Int, internalFormat: Int, width: Int, height: Int) {
        call("texStorage2D"); group.textures[unitTextures[activeUnit]]!!.apply { this.internalFormat = internalFormat; this.width = width; this.height = height; this.levels = levels }
    }
    override fun texStorage3D(target: Int, levels: Int, internalFormat: Int, width: Int, height: Int, depth: Int) {
        call("texStorage3D"); group.textures[unitTextures[activeUnit]]!!.apply { this.internalFormat = internalFormat; this.width = width; this.height = height; this.layers = depth; this.levels = levels }
    }
    override fun texSubImage2D(target: Int, level: Int, x: Int, y: Int, width: Int, height: Int, format: Int, type: Int, pixels: Buffer) {
        call("texSubImage2D"); group.textures[unitTextures[activeUnit]]!!.subImages += intArrayOf(level, x, y, 0, width, height)
    }
    override fun texSubImage3D(target: Int, level: Int, x: Int, y: Int, z: Int, width: Int, height: Int, depth: Int, format: Int, type: Int, pixels: Buffer) {
        call("texSubImage3D"); group.textures[unitTextures[activeUnit]]!!.subImages += intArrayOf(level, x, y, z, width, height)
    }
    override fun pixelStorei(pname: Int, value: Int) = call("pixelStorei")
    override fun copyImageSubData(src: Int, srcTarget: Int, srcLevel: Int, srcX: Int, srcY: Int, srcZ: Int, dst: Int, dstTarget: Int, dstLevel: Int,
                                  dstX: Int, dstY: Int, dstZ: Int, width: Int, height: Int, depth: Int) { call("copyImageSubData"); group.textures[dst]!!.copies++ }

    override fun genFramebuffer(): Int { call("genFramebuffer"); group.framebuffers += intArrayOf(0, 0, 0); return group.framebuffers.size - 1 }
    override fun deleteFramebuffer(framebuffer: Int) { call("deleteFramebuffer") }
    /** Every framebuffer bound, in order (recorded only when [record]). */
    val framebufferHistory = ArrayList<Int>()
    override fun bindFramebuffer(target: Int, framebuffer: Int) { call("bindFramebuffer"); this.framebuffer = framebuffer; if (record) framebufferHistory += framebuffer }
    override fun framebufferTexture2D(target: Int, attachment: Int, textureTarget: Int, texture: Int, level: Int) {
        call("framebufferTexture2D"); val fb = group.framebuffers[framebuffer]!!
        if (attachment == GL20.GL_DEPTH_ATTACHMENT) fb[2] = texture else fb[0] = texture
    }
    override fun framebufferTextureLayer(target: Int, attachment: Int, texture: Int, level: Int, layer: Int) {
        call("framebufferTextureLayer"); group.framebuffers[framebuffer]!!.apply { this[0] = texture; this[1] = layer }
    }
    override fun checkFramebufferStatus(target: Int): Int { call("checkFramebufferStatus"); return GL20.GL_FRAMEBUFFER_COMPLETE }
    override fun invalidateFramebuffer(target: Int, count: Int, attachments: IntArray) { call("invalidateFramebuffer"); invalidations++ }

    override fun viewport(x: Int, y: Int, width: Int, height: Int) { call("viewport"); viewportBox[0] = x; viewportBox[1] = y; viewportBox[2] = width; viewportBox[3] = height }
    override fun scissor(x: Int, y: Int, width: Int, height: Int) { call("scissor"); scissorBox[0] = x; scissorBox[1] = y; scissorBox[2] = width; scissorBox[3] = height }
    override fun enable(cap: Int) { call("enable"); setCap(cap, true) }
    override fun disable(cap: Int) { call("disable"); setCap(cap, false) }
    private fun setCap(cap: Int, on: Boolean) { when (cap) {
        GL20.GL_BLEND -> blend = on; GL20.GL_DEPTH_TEST -> depthTest = on; GL20.GL_CULL_FACE -> cull = on; GL20.GL_SCISSOR_TEST -> scissorTest = on } }
    override fun blendFuncSeparate(srcRgb: Int, dstRgb: Int, srcAlpha: Int, dstAlpha: Int) { call("blendFuncSeparate"); blendSrcRgb = srcRgb; blendDstRgb = dstRgb }
    override fun depthFunc(func: Int) { call("depthFunc"); depthFunc = func }
    override fun depthMask(flag: Boolean) { call("depthMask"); depthWrite = flag }
    override fun colorMask(r: Boolean, g: Boolean, b: Boolean, a: Boolean) {
        call("colorMask"); colorMask = (if (r) 1 else 0) or (if (g) 2 else 0) or (if (b) 4 else 0) or (if (a) 8 else 0)
    }
    override fun clearColor(r: Float, g: Float, b: Float, a: Float) = call("clearColor")
    override fun clear(mask: Int) { call("clear"); clears++ }

    override fun drawArrays(mode: Int, first: Int, count: Int) = draw("drawArrays", 1)
    override fun drawElements(mode: Int, count: Int, type: Int, offset: Int) = draw("drawElements", 1)
    override fun drawArraysInstanced(mode: Int, first: Int, count: Int, instances: Int) = draw("drawArraysInstanced", instances)
    override fun drawElementsInstanced(mode: Int, count: Int, type: Int, offset: Int, instances: Int) = draw("drawElementsInstanced", instances)
    private fun draw(name: String, instances: Int) {
        call(name); drawCount++
        if (record) draws += FakeDraw(program, framebuffer, colorAttachment(framebuffer), scissorTest, scissorBox[2], scissorBox[3], instances)
    }
    fun colorAttachment(framebuffer: Int): Int = if (framebuffer == 0) 0 else group.framebuffers[framebuffer]!![0]

    override fun fenceSync(): Long { call("fenceSync"); group.liveSyncs++; return ++group.syncs }
    override fun clientWaitSync(sync: Long, flags: Int, timeoutNs: Long): Int {
        call("clientWaitSync")
        if (timeoutNs != 0L) blockingCalls++
        return if (sync <= group.signalledThrough) GL30.GL_ALREADY_SIGNALED else GL30.GL_TIMEOUT_EXPIRED
    }
    override fun waitSync(sync: Long) = call("waitSync")
    override fun deleteSync(sync: Long) { call("deleteSync"); group.liveSyncs-- }

    fun calls(name: String): Int = log.count { it == name }
}

class FakeDraw(val program: Int, val framebuffer: Int, val colorTexture: Int, val scissor: Boolean, val scissorW: Int, val scissorH: Int, val instances: Int)

/** A compiler whose jobs a test completes by hand, on a worker fake sharing the world fake's objects. */
class ManualCompiler(private val builder: ProgramBuilder) : ProgramCompiler {
    val queued = ArrayList<ProgramJob>()
    var epochs = ArrayList<Int>()
    var disposed = false
    override val blocksCaller: Boolean get() = false
    override fun submit(job: ProgramJob) { queued += job }
    override fun contextChanged(epoch: Int) { epochs += epoch; queued.clear() }
    override fun dispose() { disposed = true }
    /** Build every queued job (what the worker thread does between frames). */
    fun runAll() { val jobs = queued.toList(); queued.clear(); for (job in jobs) builder.build(job) }
}
