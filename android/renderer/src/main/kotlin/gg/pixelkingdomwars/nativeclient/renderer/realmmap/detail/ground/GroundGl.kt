package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program

/**
 * The GLES 3.0 uniform calls GROUND's programs need and [gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3] does not
 * carry yet (integer vectors, uvec4, and arrays). Signatures mirror `android.opengl.GLES30` (`glUniform4iv(location,
 * count, v, offset)`), so `:app`'s implementation is one call each and never allocates. Asked of the lead / lane NA:
 * add these to `Gl3` (+ `AndroidGl3`, `FakeGl3`) together with LIFE's `Gl3IntUniforms` (the union: 1ui, 2i, 4i, 4ui, 1iv,
 * 2iv, 4iv, 3fv, 4fv); then this interface is a one-line adapter over it.
 */
interface GroundGl {
    fun uniform2i(location: Int, x: Int, y: Int)
    fun uniform4i(location: Int, x: Int, y: Int, z: Int, w: Int)
    /** `glUniform4ui` (the uint bits in Ints). */
    fun uniform4ui(location: Int, x: Int, y: Int, z: Int, w: Int)
    fun uniform1iv(location: Int, count: Int, v: IntArray, offset: Int)
    fun uniform2iv(location: Int, count: Int, v: IntArray, offset: Int)
    fun uniform4iv(location: Int, count: Int, v: IntArray, offset: Int)
    fun uniform3fv(location: Int, count: Int, v: FloatArray, offset: Int)
    fun uniform4fv(location: Int, count: Int, v: FloatArray, offset: Int)
}

/**
 * Where GROUND's uniform values go, by program and uniform NAME (so a test can read back exactly what the web's
 * ground.js would have set). Production is [GlGroundUniforms]; every array is caller-owned and reused (no per-frame
 * allocation), and a name's location is cached by [Gl3Program.uniform] after its first lookup.
 */
interface GroundUniformSink {
    fun i1(p: Gl3Program, name: String, v: Int)
    fun f1(p: Gl3Program, name: String, v: Float)
    fun f2(p: Gl3Program, name: String, x: Float, y: Float)
    fun f3(p: Gl3Program, name: String, x: Float, y: Float, z: Float)
    fun f4(p: Gl3Program, name: String, x: Float, y: Float, z: Float, w: Float)
    fun i2(p: Gl3Program, name: String, x: Int, y: Int)
    fun i4(p: Gl3Program, name: String, x: Int, y: Int, z: Int, w: Int)
    fun ui4(p: Gl3Program, name: String, x: Int, y: Int, z: Int, w: Int)
    /** [n] scalars / ivec2 / ivec4 / vec3 / vec4 elements from [v] (n × width values). */
    fun i1v(p: Gl3Program, name: String, v: IntArray, n: Int)
    fun i2v(p: Gl3Program, name: String, v: IntArray, n: Int)
    fun i4v(p: Gl3Program, name: String, v: IntArray, n: Int)
    fun f3v(p: Gl3Program, name: String, v: FloatArray, n: Int)
    fun f4v(p: Gl3Program, name: String, v: FloatArray, n: Int)
}

/** The production sink: [Gl3Program.uniform] locations, scalars through `Gl3`, vectors and arrays through [GroundGl]. */
class GlGroundUniforms(private val core: Gl3Core, private val ext: GroundGl) : GroundUniformSink {
    private fun loc(p: Gl3Program, name: String) = p.uniform(core, name)
    override fun i1(p: Gl3Program, name: String, v: Int) = core.gl.uniform1i(loc(p, name), v)
    override fun f1(p: Gl3Program, name: String, v: Float) = core.gl.uniform1f(loc(p, name), v)
    override fun f2(p: Gl3Program, name: String, x: Float, y: Float) = core.gl.uniform2f(loc(p, name), x, y)
    override fun f3(p: Gl3Program, name: String, x: Float, y: Float, z: Float) = core.gl.uniform3f(loc(p, name), x, y, z)
    override fun f4(p: Gl3Program, name: String, x: Float, y: Float, z: Float, w: Float) = core.gl.uniform4f(loc(p, name), x, y, z, w)
    override fun i2(p: Gl3Program, name: String, x: Int, y: Int) = ext.uniform2i(loc(p, name), x, y)
    override fun i4(p: Gl3Program, name: String, x: Int, y: Int, z: Int, w: Int) = ext.uniform4i(loc(p, name), x, y, z, w)
    override fun ui4(p: Gl3Program, name: String, x: Int, y: Int, z: Int, w: Int) = ext.uniform4ui(loc(p, name), x, y, z, w)
    override fun i1v(p: Gl3Program, name: String, v: IntArray, n: Int) = ext.uniform1iv(loc(p, name), n, v, 0)
    override fun i2v(p: Gl3Program, name: String, v: IntArray, n: Int) = ext.uniform2iv(loc(p, name), n, v, 0)
    override fun i4v(p: Gl3Program, name: String, v: IntArray, n: Int) = ext.uniform4iv(loc(p, name), n, v, 0)
    override fun f3v(p: Gl3Program, name: String, v: FloatArray, n: Int) = ext.uniform3fv(loc(p, name), n, v, 0)
    override fun f4v(p: Gl3Program, name: String, v: FloatArray, n: Int) = ext.uniform4fv(loc(p, name), n, v, 0)
}
