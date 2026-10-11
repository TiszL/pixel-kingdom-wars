package gg.pixelkingdomwars.nativeclient.scene.probe

import android.opengl.GLES20
import android.opengl.GLES30
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Raw GL for the probe's GL thread (debug only). Blocking calls (`glFinish`, `glReadPixels`) are allowed HERE, on the
 * probe screen, and nowhere in a world frame (WorldHostPinTest keeps them out of `AndroidGl3`).
 */
internal class ProbeGl {
    private var quad = 0
    private val ids = IntArray(1)
    private val dummies = HashMap<ProbeStages.Dummy, Int>()
    private var zeroUbo = 0

    /** A fullscreen triangle with attribute 0 fed from a buffer (vec2), drawn with vertex array 0. */
    fun fullscreen() {
        if (quad == 0) {
            GLES20.glGenBuffers(1, ids, 0); quad = ids[0]
            val data = ByteBuffer.allocateDirect(24).order(ByteOrder.nativeOrder()).asFloatBuffer().put(floatArrayOf(-1f, -1f, 3f, -1f, -1f, 3f))
            data.position(0)
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, quad)
            GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, 24, data, GLES20.GL_STATIC_DRAW)
        }
        GLES30.glBindVertexArray(0)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, quad)
        GLES20.glEnableVertexAttribArray(0)
        GLES20.glVertexAttribPointer(0, 2, GLES20.GL_FLOAT, false, 0, 0)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, 3)
    }

    /** Link from source, or throw with the driver's log. */
    fun link(vs: String, fs: String, retrievable: Boolean = false): Int = tryLink(vs, fs, retrievable).let { (program, error) ->
        check(program != 0) { error ?: "link failed" }
        program
    }

    /** Link from source: the program, or 0 and the driver's log (truncated). */
    fun tryLink(vs: String, fs: String, retrievable: Boolean = false): Pair<Int, String?> {
        fun shader(type: Int, src: String): Pair<Int, String?> {
            val s = GLES20.glCreateShader(type); GLES20.glShaderSource(s, src); GLES20.glCompileShader(s)
            GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ids, 0)
            if (ids[0] == GLES20.GL_TRUE) return s to null
            val log = GLES20.glGetShaderInfoLog(s); GLES20.glDeleteShader(s)
            return 0 to "compile ${if (type == GLES20.GL_VERTEX_SHADER) "vs" else "fs"}: ${log.take(300)}"
        }
        val (v, ve) = shader(GLES20.GL_VERTEX_SHADER, vs); if (v == 0) return 0 to ve
        val (f, fe) = shader(GLES20.GL_FRAGMENT_SHADER, fs); if (f == 0) { GLES20.glDeleteShader(v); return 0 to fe }
        val program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, v); GLES20.glAttachShader(program, f)
        if (retrievable) GLES30.glProgramParameteri(program, GLES30.GL_PROGRAM_BINARY_RETRIEVABLE_HINT, GLES20.GL_TRUE)
        GLES20.glLinkProgram(program)
        GLES20.glDeleteShader(v); GLES20.glDeleteShader(f)
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, ids, 0)
        if (ids[0] == GLES20.GL_TRUE) return program to null
        val log = GLES20.glGetProgramInfoLog(program); GLES20.glDeleteProgram(program)
        return 0 to "link: ${log.take(300)}"
    }

    /** ms for one draw by [program], from submit to `glFinish` (the variant build and the draw). */
    fun timeDraw(program: Int, attributeless: Boolean): Double {
        GLES20.glUseProgram(program)
        val t0 = System.nanoTime()
        if (attributeless) { GLES30.glBindVertexArray(0); GLES20.glDisableVertexAttribArray(0); GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, 3) }
        else fullscreen()
        GLES20.glFinish()
        return (System.nanoTime() - t0) / 1e6
    }

    /** The first-draw state every pre-warm trial uses: alpha blending, 1×1 scissor, no depth. */
    fun trialState(on: Boolean) {
        if (on) {
            GLES20.glEnable(GLES20.GL_BLEND)
            GLES20.glBlendFuncSeparate(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA, GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA)
            GLES20.glDisable(GLES20.GL_DEPTH_TEST)
            GLES20.glEnable(GLES20.GL_SCISSOR_TEST); GLES20.glScissor(0, 0, 1, 1)
        } else {
            GLES20.glDisable(GLES20.GL_BLEND); GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
            GLES20.glUseProgram(0)
        }
    }

    /** RGBA8 bytes of [width]×1 texels at (0, 0) of the bound read framebuffer. */
    fun readRow(width: Int): ByteArray {
        val buffer = ByteBuffer.allocateDirect(width * 4).order(ByteOrder.nativeOrder())
        GLES20.glPixelStorei(GLES20.GL_PACK_ALIGNMENT, 1)
        GLES20.glReadPixels(0, 0, width, 1, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buffer)
        GLES20.glPixelStorei(GLES20.GL_PACK_ALIGNMENT, 4)
        return ByteArray(width * 4).also { buffer.get(it) }
    }

    /** Colour and depth sizes of the default framebuffer (bind 0 first). */
    fun defaultFramebufferBits(): Map<String, Int> {
        val out = LinkedHashMap<String, Int>()
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        for ((key, name) in listOf("red" to GLES30.GL_FRAMEBUFFER_ATTACHMENT_RED_SIZE, "green" to GLES30.GL_FRAMEBUFFER_ATTACHMENT_GREEN_SIZE,
                "blue" to GLES30.GL_FRAMEBUFFER_ATTACHMENT_BLUE_SIZE, "alpha" to GLES30.GL_FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE)) {
            ids[0] = -1; GLES30.glGetFramebufferAttachmentParameteriv(GLES20.GL_FRAMEBUFFER, GLES20.GL_BACK, name, ids, 0); out[key] = ids[0]
        }
        ids[0] = -1; GLES30.glGetFramebufferAttachmentParameteriv(GLES20.GL_FRAMEBUFFER, GLES30.GL_DEPTH, GLES30.GL_FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE, ids, 0)
        out["depth"] = ids[0]
        GLES20.glGetError() // a surface without depth reports GL_INVALID_OPERATION here: not the probe's error
        return out
    }

    /** The zeroed uniform buffer ([ProbeStages.ZERO_UBO_BYTES]). */
    fun zeroUbo(): Int {
        if (zeroUbo == 0) {
            GLES20.glGenBuffers(1, ids, 0); zeroUbo = ids[0]
            GLES20.glBindBuffer(GLES30.GL_UNIFORM_BUFFER, zeroUbo)
            GLES20.glBufferData(GLES30.GL_UNIFORM_BUFFER, ProbeStages.ZERO_UBO_BYTES,
                ByteBuffer.allocateDirect(ProbeStages.ZERO_UBO_BYTES).order(ByteOrder.nativeOrder()), GLES20.GL_STATIC_DRAW)
            GLES20.glBindBuffer(GLES30.GL_UNIFORM_BUFFER, 0)
        }
        return zeroUbo
    }

    /** A zero-filled 1×1 texture of [kind], NEAREST (an integer texture must be, to be complete). */
    fun dummy(kind: ProbeStages.Dummy): Int = dummies.getOrPut(kind) {
        GLES20.glGenTextures(1, ids, 0)
        val name = ids[0]
        val zero = ByteBuffer.allocateDirect(64).order(ByteOrder.nativeOrder())
        GLES20.glBindTexture(kind.target, name)
        when (kind.target) {
            GLES30.GL_TEXTURE_2D_ARRAY -> {
                GLES30.glTexStorage3D(kind.target, 1, kind.internal, 1, 1, 1)
                GLES30.glTexSubImage3D(kind.target, 0, 0, 0, 0, 1, 1, 1, kind.format, kind.type, zero)
            }
            GLES20.GL_TEXTURE_CUBE_MAP -> {
                GLES30.glTexStorage2D(kind.target, 1, kind.internal, 1, 1)
                for (face in 0 until 6) GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, 0, 0, 1, 1, kind.format, kind.type, zero)
            }
            else -> {
                GLES30.glTexStorage2D(kind.target, 1, kind.internal, 1, 1)
                GLES20.glTexSubImage2D(kind.target, 0, 0, 0, 1, 1, kind.format, kind.type, zero)
            }
        }
        GLES20.glTexParameteri(kind.target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST)
        GLES20.glTexParameteri(kind.target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST)
        GLES20.glBindTexture(kind.target, 0)
        name
    }

    fun delete() {
        if (quad != 0) { ids[0] = quad; GLES20.glDeleteBuffers(1, ids, 0); quad = 0 }
        if (zeroUbo != 0) { ids[0] = zeroUbo; GLES20.glDeleteBuffers(1, ids, 0); zeroUbo = 0 }
        for (name in dummies.values) { ids[0] = name; GLES20.glDeleteTextures(1, ids, 0) }
        dummies.clear()
    }

    /** A [size]² colour target of [internal] format (RGBA8 by default) behind its own framebuffer. */
    class Target(val size: Int, internal: Int = GLES30.GL_RGBA8) {
        private val ids = IntArray(2)
        init {
            GLES20.glGenTextures(1, ids, 0)
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ids[0])
            GLES30.glTexStorage2D(GLES20.GL_TEXTURE_2D, 1, internal, size, size)
            GLES20.glGenFramebuffers(1, ids, 1)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, ids[1])
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, ids[0], 0)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        }
        fun bind() { GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, ids[1]); GLES20.glViewport(0, 0, size, size) }
        fun delete() { GLES20.glDeleteFramebuffers(1, ids, 1); GLES20.glDeleteTextures(1, ids, 0) }
    }

    /** A framebuffer reading layer [layer] of the 2D array [texture] (level 0), for a readback. */
    class LayerReader(texture: Int, layer: Int) {
        private val ids = IntArray(1)
        init {
            GLES20.glGenFramebuffers(1, ids, 0)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, ids[0])
            GLES30.glFramebufferTextureLayer(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, texture, 0, layer)
        }
        val complete: Boolean get() = GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) == GLES20.GL_FRAMEBUFFER_COMPLETE
        fun delete() { GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0); GLES20.glDeleteFramebuffers(1, ids, 0) }
    }
}
