package gg.pixelkingdomwars.nativeclient.scene

import android.opengl.GLES20
import android.opengl.GLES30
import android.opengl.GLES31Ext
import android.opengl.GLES32
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.scene.world.CopyImage
import gg.pixelkingdomwars.nativeclient.scene.world.Gles3Paths
import gg.pixelkingdomwars.nativeclient.scene.world.ResetQuery
import java.nio.Buffer
import java.nio.ByteBuffer

/**
 * The world engines' GL surface over `android.opengl.GLES30`/`GLES32` (GLOBE-NATIVE-PLAN §3.2: the plan's
 * `AndroidGles3Ext`; the `Gl3` interface folds libGDX `GL30` and the extension calls into one, see `Gl3.kt`).
 *
 * One instance per thread that has a world-share-group context current (the world GL thread, the shared worker),
 * because the scratch arrays below are not thread-safe. The `android.opengl` calls act on whatever context is current
 * on the calling thread, so an instance survives a context change.
 *
 * **Allocation-free.** The zero-allocation steady frame (plan §5.9) runs through this class on the device, so no
 * method may allocate: every `glGen*`/`glGet*` goes through the preallocated arrays here (`AndroidGl3SourceTest` fails on
 * an allocation outside a property initializer). Strings (`getString`, info logs, uniform names) are the documented
 * exceptions and are never on the per-frame path.
 *
 * **Only the entry points the context has.** [paths] is `WorldEngineGuard.decide`'s choice from `GL_VERSION` and
 * `GL_EXTENSIONS`. Below ES 3.2 the `GLES32` entry points are logging stubs, so [getGraphicsResetStatus] and
 * [copyImageSubData] call them only on an ES 3.2 path (`WorldHostPinTest` checks every such call sits on its branch).
 * The default, [Gles3Paths.ES30], calls neither: the shared worker's contexts never reset-check or copy.
 */
class AndroidGl3(private val paths: Gles3Paths = Gles3Paths.ES30) : Gl3 {
    /** Copies asked for on a context with no copy path. `StagingUploader` refuses first, so this stays 0; the probe
     *  reports it. */
    @Volatile var copiesRefused = 0L; private set

    private val one = IntArray(1)
    private val length = IntArray(1)
    /** Multi-valued `glGetIntegerv` results; a name with more values than this is refused, never overflowed. */
    private val wide = IntArray(256)

    // ---- context ----
    override fun getString(name: Int): String? = GLES20.glGetString(name)
    override fun getInteger(pname: Int): Int { one[0] = 0; GLES20.glGetIntegerv(pname, one, 0); return one[0] }

    /**
     * `glGetIntegerv` for a multi-valued name. The driver writes as many values as the name has, whatever the array
     * holds (Android's JNI bounds check knows `GL_COMPRESSED_TEXTURE_FORMATS` but not the ES 3 `GL_PROGRAM_BINARY_FORMATS`,
     * so a short array would be overrun), so the count is queried first, the values land in [wide], and the first
     * `out.size` are copied. Returns the number copied; 0 when the name has more values than [wide] holds (the binary
     * cache is then simply off).
     */
    override fun getIntegers(pname: Int, out: IntArray): Int {
        val count = when (pname) {
            GLES30.GL_PROGRAM_BINARY_FORMATS -> getInteger(GLES30.GL_NUM_PROGRAM_BINARY_FORMATS)
            GLES20.GL_COMPRESSED_TEXTURE_FORMATS -> getInteger(GLES20.GL_NUM_COMPRESSED_TEXTURE_FORMATS)
            GLES20.GL_MAX_VIEWPORT_DIMS, GLES20.GL_ALIASED_LINE_WIDTH_RANGE, GLES20.GL_ALIASED_POINT_SIZE_RANGE -> 2
            GLES20.GL_VIEWPORT, GLES20.GL_SCISSOR_BOX, GLES20.GL_COLOR_WRITEMASK -> 4
            else -> 1
        }
        if (count <= 0 || count > wide.size) return 0
        GLES20.glGetIntegerv(pname, wide, 0)
        val copied = minOf(count, out.size)
        System.arraycopy(wide, 0, out, 0, copied)
        return copied
    }

    override fun getError(): Int = GLES20.glGetError()
    /** `GL_NO_ERROR` without a query when this context has no reset query ([ResetQuery.NONE]). */
    override fun getGraphicsResetStatus(): Int = when (paths.reset) {
        ResetQuery.ES32 -> GLES32.glGetGraphicsResetStatus()
        ResetQuery.NONE -> GLES20.GL_NO_ERROR
    }
    override fun flush() = GLES20.glFlush()

    // ---- shaders and programs ----
    override fun createShader(type: Int): Int = GLES20.glCreateShader(type)
    override fun shaderSource(shader: Int, source: String) = GLES20.glShaderSource(shader, source)
    override fun compileShader(shader: Int) = GLES20.glCompileShader(shader)
    override fun getShaderi(shader: Int, pname: Int): Int { one[0] = 0; GLES20.glGetShaderiv(shader, pname, one, 0); return one[0] }
    override fun getShaderInfoLog(shader: Int): String = GLES20.glGetShaderInfoLog(shader)
    override fun deleteShader(shader: Int) = GLES20.glDeleteShader(shader)
    override fun createProgram(): Int = GLES20.glCreateProgram()
    override fun attachShader(program: Int, shader: Int) = GLES20.glAttachShader(program, shader)
    override fun detachShader(program: Int, shader: Int) = GLES20.glDetachShader(program, shader)
    override fun linkProgram(program: Int) = GLES20.glLinkProgram(program)
    override fun getProgrami(program: Int, pname: Int): Int { one[0] = 0; GLES20.glGetProgramiv(program, pname, one, 0); return one[0] }
    override fun getProgramInfoLog(program: Int): String = GLES20.glGetProgramInfoLog(program)
    override fun deleteProgram(program: Int) = GLES20.glDeleteProgram(program)
    override fun isProgram(program: Int): Boolean = GLES20.glIsProgram(program)
    override fun useProgram(program: Int) = GLES20.glUseProgram(program)
    override fun programParameteri(program: Int, pname: Int, value: Int) = GLES30.glProgramParameteri(program, pname, value)

    override fun getProgramBinary(program: Int, out: ByteBuffer, format: IntArray): Int {
        length[0] = 0
        out.position(0)
        GLES30.glGetProgramBinary(program, out.capacity(), length, 0, format, 0, out)
        return length[0]
    }

    override fun programBinary(program: Int, format: Int, binary: ByteBuffer, length: Int) {
        binary.position(0)
        GLES30.glProgramBinary(program, format, binary, length)
    }

    override fun getUniformLocation(program: Int, name: String): Int = GLES20.glGetUniformLocation(program, name)
    override fun getUniformBlockIndex(program: Int, name: String): Int = GLES30.glGetUniformBlockIndex(program, name)
    override fun uniformBlockBinding(program: Int, blockIndex: Int, binding: Int) = GLES30.glUniformBlockBinding(program, blockIndex, binding)
    override fun uniform1i(location: Int, v: Int) = GLES20.glUniform1i(location, v)
    override fun uniform1f(location: Int, v: Float) = GLES20.glUniform1f(location, v)
    override fun uniform2f(location: Int, x: Float, y: Float) = GLES20.glUniform2f(location, x, y)
    override fun uniform3f(location: Int, x: Float, y: Float, z: Float) = GLES20.glUniform3f(location, x, y, z)
    override fun uniform4f(location: Int, x: Float, y: Float, z: Float, w: Float) = GLES20.glUniform4f(location, x, y, z, w)

    // ---- buffers and vertex arrays ----
    override fun genBuffer(): Int { one[0] = 0; GLES20.glGenBuffers(1, one, 0); return one[0] }
    override fun deleteBuffer(buffer: Int) { one[0] = buffer; GLES20.glDeleteBuffers(1, one, 0) }
    override fun bindBuffer(target: Int, buffer: Int) = GLES20.glBindBuffer(target, buffer)
    override fun bufferData(target: Int, size: Int, data: Buffer?, usage: Int) = GLES20.glBufferData(target, size, data, usage)
    override fun bufferSubData(target: Int, offset: Int, size: Int, data: Buffer) = GLES20.glBufferSubData(target, offset, size, data)
    override fun bindBufferBase(target: Int, index: Int, buffer: Int) = GLES30.glBindBufferBase(target, index, buffer)
    override fun genVertexArray(): Int { one[0] = 0; GLES30.glGenVertexArrays(1, one, 0); return one[0] }
    override fun deleteVertexArray(array: Int) { one[0] = array; GLES30.glDeleteVertexArrays(1, one, 0) }
    override fun bindVertexArray(array: Int) = GLES30.glBindVertexArray(array)
    override fun enableVertexAttribArray(index: Int) = GLES20.glEnableVertexAttribArray(index)
    override fun vertexAttribPointer(index: Int, size: Int, type: Int, normalized: Boolean, stride: Int, offset: Int) =
        GLES20.glVertexAttribPointer(index, size, type, normalized, stride, offset)
    override fun vertexAttribIPointer(index: Int, size: Int, type: Int, stride: Int, offset: Int) =
        GLES30.glVertexAttribIPointer(index, size, type, stride, offset)
    override fun vertexAttribDivisor(index: Int, divisor: Int) = GLES30.glVertexAttribDivisor(index, divisor)

    // ---- textures ----
    override fun genTexture(): Int { one[0] = 0; GLES20.glGenTextures(1, one, 0); return one[0] }
    override fun deleteTexture(texture: Int) { one[0] = texture; GLES20.glDeleteTextures(1, one, 0) }
    override fun activeTexture(unit: Int) = GLES20.glActiveTexture(unit)
    override fun bindTexture(target: Int, texture: Int) = GLES20.glBindTexture(target, texture)
    override fun texParameteri(target: Int, pname: Int, value: Int) = GLES20.glTexParameteri(target, pname, value)
    override fun texStorage2D(target: Int, levels: Int, internalFormat: Int, width: Int, height: Int) =
        GLES30.glTexStorage2D(target, levels, internalFormat, width, height)
    override fun texStorage3D(target: Int, levels: Int, internalFormat: Int, width: Int, height: Int, depth: Int) =
        GLES30.glTexStorage3D(target, levels, internalFormat, width, height, depth)
    override fun texSubImage2D(target: Int, level: Int, x: Int, y: Int, width: Int, height: Int, format: Int, type: Int, pixels: Buffer) =
        GLES20.glTexSubImage2D(target, level, x, y, width, height, format, type, pixels)
    override fun texSubImage3D(target: Int, level: Int, x: Int, y: Int, z: Int, width: Int, height: Int, depth: Int, format: Int, type: Int, pixels: Buffer) =
        GLES30.glTexSubImage3D(target, level, x, y, z, width, height, depth, format, type, pixels)
    override fun pixelStorei(pname: Int, value: Int) = GLES20.glPixelStorei(pname, value)
    override fun copyImageSubData(src: Int, srcTarget: Int, srcLevel: Int, srcX: Int, srcY: Int, srcZ: Int,
                                  dst: Int, dstTarget: Int, dstLevel: Int, dstX: Int, dstY: Int, dstZ: Int,
                                  width: Int, height: Int, depth: Int) {
        when (paths.copy) {
            CopyImage.ES32 -> GLES32.glCopyImageSubData(src, srcTarget, srcLevel, srcX, srcY, srcZ, dst, dstTarget, dstLevel, dstX, dstY, dstZ, width, height, depth)
            CopyImage.EXT -> GLES31Ext.glCopyImageSubDataEXT(src, srcTarget, srcLevel, srcX, srcY, srcZ, dst, dstTarget, dstLevel, dstX, dstY, dstZ, width, height, depth)
            CopyImage.NONE -> copiesRefused++
        }
    }

    // ---- framebuffers ----
    override fun genFramebuffer(): Int { one[0] = 0; GLES20.glGenFramebuffers(1, one, 0); return one[0] }
    override fun deleteFramebuffer(framebuffer: Int) { one[0] = framebuffer; GLES20.glDeleteFramebuffers(1, one, 0) }
    override fun bindFramebuffer(target: Int, framebuffer: Int) = GLES20.glBindFramebuffer(target, framebuffer)
    override fun framebufferTexture2D(target: Int, attachment: Int, textureTarget: Int, texture: Int, level: Int) =
        GLES20.glFramebufferTexture2D(target, attachment, textureTarget, texture, level)
    override fun framebufferTextureLayer(target: Int, attachment: Int, texture: Int, level: Int, layer: Int) =
        GLES30.glFramebufferTextureLayer(target, attachment, texture, level, layer)
    override fun checkFramebufferStatus(target: Int): Int = GLES20.glCheckFramebufferStatus(target)
    override fun invalidateFramebuffer(target: Int, count: Int, attachments: IntArray) =
        GLES30.glInvalidateFramebuffer(target, count, attachments, 0)

    // ---- fixed-function state ----
    override fun viewport(x: Int, y: Int, width: Int, height: Int) = GLES20.glViewport(x, y, width, height)
    override fun scissor(x: Int, y: Int, width: Int, height: Int) = GLES20.glScissor(x, y, width, height)
    override fun enable(cap: Int) = GLES20.glEnable(cap)
    override fun disable(cap: Int) = GLES20.glDisable(cap)
    override fun blendFuncSeparate(srcRgb: Int, dstRgb: Int, srcAlpha: Int, dstAlpha: Int) = GLES20.glBlendFuncSeparate(srcRgb, dstRgb, srcAlpha, dstAlpha)
    override fun depthFunc(func: Int) = GLES20.glDepthFunc(func)
    override fun depthMask(flag: Boolean) = GLES20.glDepthMask(flag)
    override fun colorMask(r: Boolean, g: Boolean, b: Boolean, a: Boolean) = GLES20.glColorMask(r, g, b, a)
    override fun clearColor(r: Float, g: Float, b: Float, a: Float) = GLES20.glClearColor(r, g, b, a)
    override fun clear(mask: Int) = GLES20.glClear(mask)

    // ---- draws ----
    override fun drawArrays(mode: Int, first: Int, count: Int) = GLES20.glDrawArrays(mode, first, count)
    override fun drawElements(mode: Int, count: Int, type: Int, offset: Int) = GLES20.glDrawElements(mode, count, type, offset)
    override fun drawArraysInstanced(mode: Int, first: Int, count: Int, instances: Int) = GLES30.glDrawArraysInstanced(mode, first, count, instances)
    override fun drawElementsInstanced(mode: Int, count: Int, type: Int, offset: Int, instances: Int) =
        GLES30.glDrawElementsInstanced(mode, count, type, offset, instances)

    // ---- sync ----
    override fun fenceSync(): Long = GLES30.glFenceSync(GLES30.GL_SYNC_GPU_COMMANDS_COMPLETE, 0)
    override fun clientWaitSync(sync: Long, flags: Int, timeoutNs: Long): Int = GLES30.glClientWaitSync(sync, flags, timeoutNs)
    override fun waitSync(sync: Long) = GLES30.glWaitSync(sync, 0, GLES30.GL_TIMEOUT_IGNORED)
    override fun deleteSync(sync: Long) = GLES30.glDeleteSync(sync)
}
