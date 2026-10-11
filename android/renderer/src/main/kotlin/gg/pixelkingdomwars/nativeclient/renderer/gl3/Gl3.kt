package gg.pixelkingdomwars.nativeclient.renderer.gl3

import java.nio.Buffer
import java.nio.ByteBuffer

/**
 * The GLES 3.x call surface the world engines use (GLOBE-NATIVE-PLAN §3.2). `:renderer` stays pure JVM, so the
 * engines never touch `android.opengl` or `Gdx.gl30`: `:app` implements this over `android.opengl.GLES30`/`GLES32`
 * (one implementation per EGL context: the world context and the one shared worker context), and tests use the
 * recording `FakeGl3`.
 *
 * One interface instead of libGDX `GL30` + a separate `Gles3Ext`: libGDX 1.13.1's `GL30` has no `glTexStorage2D/3D`,
 * fence sync, program binary, `glCopyImageSubData` or reset status (javap), so an engine written against it would
 * straddle two APIs and a fake would have to implement ~300 methods. Every method maps 1:1 to one GL call, takes
 * primitives or caller-owned buffers, and never allocates on the caller's behalf (the zero-allocation frame depends
 * on it). Handles are GL names, except sync objects, which are `Long` like `GLES30.glFenceSync`.
 *
 * Blocking calls are marked. The world context may issue them only before its first world frame (plan §5.3); the
 * worker context may always issue them.
 */
interface Gl3 {
    // ---- context ----
    fun getString(name: Int): String?
    fun getInteger(pname: Int): Int
    /** `glGetIntegerv` into a caller array (e.g. `GL_PROGRAM_BINARY_FORMATS`); returns the values written. */
    fun getIntegers(pname: Int, out: IntArray): Int
    fun getError(): Int
    /** GLES 3.2 `glGetGraphicsResetStatus`: 0 (`GL_NO_ERROR`) unless the context was reset. Cheap; polled per frame. */
    fun getGraphicsResetStatus(): Int
    fun flush()

    // ---- shaders and programs ----
    fun createShader(type: Int): Int
    fun shaderSource(shader: Int, source: String)
    fun compileShader(shader: Int)
    /** BLOCKING until the compile has ended on most drivers. */
    fun getShaderi(shader: Int, pname: Int): Int
    fun getShaderInfoLog(shader: Int): String
    fun deleteShader(shader: Int)
    fun createProgram(): Int
    fun attachShader(program: Int, shader: Int)
    fun detachShader(program: Int, shader: Int)
    fun linkProgram(program: Int)
    /** BLOCKING until the link has ended for `GL_LINK_STATUS` (and most other names). */
    fun getProgrami(program: Int, pname: Int): Int
    fun getProgramInfoLog(program: Int): String
    fun deleteProgram(program: Int)
    fun isProgram(program: Int): Boolean
    fun useProgram(program: Int)
    fun programParameteri(program: Int, pname: Int, value: Int)
    /** `glGetProgramBinary` into [out] from position 0; the binary format goes to `format[0]`. Returns the length. */
    fun getProgramBinary(program: Int, out: ByteBuffer, format: IntArray): Int
    fun programBinary(program: Int, format: Int, binary: ByteBuffer, length: Int)
    fun getUniformLocation(program: Int, name: String): Int
    fun getUniformBlockIndex(program: Int, name: String): Int
    fun uniformBlockBinding(program: Int, blockIndex: Int, binding: Int)
    fun uniform1i(location: Int, v: Int)
    fun uniform1f(location: Int, v: Float)
    fun uniform2f(location: Int, x: Float, y: Float)
    /** A `vec3` uniform (the minimap's `uSea`): `glUniform4f` on a vec3 is GL_INVALID_OPERATION and sets nothing. */
    fun uniform3f(location: Int, x: Float, y: Float, z: Float)
    fun uniform4f(location: Int, x: Float, y: Float, z: Float, w: Float)

    // ---- buffers and vertex arrays ----
    fun genBuffer(): Int
    fun deleteBuffer(buffer: Int)
    fun bindBuffer(target: Int, buffer: Int)
    fun bufferData(target: Int, size: Int, data: Buffer?, usage: Int)
    fun bufferSubData(target: Int, offset: Int, size: Int, data: Buffer)
    fun bindBufferBase(target: Int, index: Int, buffer: Int)
    fun genVertexArray(): Int
    fun deleteVertexArray(array: Int)
    fun bindVertexArray(array: Int)
    fun enableVertexAttribArray(index: Int)
    fun vertexAttribPointer(index: Int, size: Int, type: Int, normalized: Boolean, stride: Int, offset: Int)
    fun vertexAttribIPointer(index: Int, size: Int, type: Int, stride: Int, offset: Int)
    fun vertexAttribDivisor(index: Int, divisor: Int)

    // ---- textures ----
    fun genTexture(): Int
    fun deleteTexture(texture: Int)
    fun activeTexture(unit: Int)
    fun bindTexture(target: Int, texture: Int)
    fun texParameteri(target: Int, pname: Int, value: Int)
    fun texStorage2D(target: Int, levels: Int, internalFormat: Int, width: Int, height: Int)
    fun texStorage3D(target: Int, levels: Int, internalFormat: Int, width: Int, height: Int, depth: Int)
    fun texSubImage2D(target: Int, level: Int, x: Int, y: Int, width: Int, height: Int, format: Int, type: Int, pixels: Buffer)
    fun texSubImage3D(target: Int, level: Int, x: Int, y: Int, z: Int, width: Int, height: Int, depth: Int, format: Int, type: Int, pixels: Buffer)
    fun pixelStorei(pname: Int, value: Int)
    /** GLES 3.2 core (`GLES32.glCopyImageSubData`, API 24+): the staging-ring copy into a live array layer (plan §5.7). */
    fun copyImageSubData(src: Int, srcTarget: Int, srcLevel: Int, srcX: Int, srcY: Int, srcZ: Int,
                         dst: Int, dstTarget: Int, dstLevel: Int, dstX: Int, dstY: Int, dstZ: Int,
                         width: Int, height: Int, depth: Int)

    // ---- framebuffers ----
    fun genFramebuffer(): Int
    fun deleteFramebuffer(framebuffer: Int)
    fun bindFramebuffer(target: Int, framebuffer: Int)
    fun framebufferTexture2D(target: Int, attachment: Int, textureTarget: Int, texture: Int, level: Int)
    fun framebufferTextureLayer(target: Int, attachment: Int, texture: Int, level: Int, layer: Int)
    fun checkFramebufferStatus(target: Int): Int
    fun invalidateFramebuffer(target: Int, count: Int, attachments: IntArray)

    // ---- fixed-function state ----
    fun viewport(x: Int, y: Int, width: Int, height: Int)
    fun scissor(x: Int, y: Int, width: Int, height: Int)
    fun enable(cap: Int)
    fun disable(cap: Int)
    fun blendFuncSeparate(srcRgb: Int, dstRgb: Int, srcAlpha: Int, dstAlpha: Int)
    fun depthFunc(func: Int)
    fun depthMask(flag: Boolean)
    fun colorMask(r: Boolean, g: Boolean, b: Boolean, a: Boolean)
    fun clearColor(r: Float, g: Float, b: Float, a: Float)
    fun clear(mask: Int)

    // ---- draws ----
    fun drawArrays(mode: Int, first: Int, count: Int)
    fun drawElements(mode: Int, count: Int, type: Int, offset: Int)
    fun drawArraysInstanced(mode: Int, first: Int, count: Int, instances: Int)
    fun drawElementsInstanced(mode: Int, count: Int, type: Int, offset: Int, instances: Int)

    // ---- sync ----
    fun fenceSync(): Long
    /** With `timeoutNs = 0` this is a poll and never blocks; the world context never passes anything else. */
    fun clientWaitSync(sync: Long, flags: Int, timeoutNs: Long): Int
    /** A GPU-side wait (`glWaitSync`, `GL_TIMEOUT_IGNORED`): the CPU never blocks. */
    fun waitSync(sync: Long)
    fun deleteSync(sync: Long)
}
