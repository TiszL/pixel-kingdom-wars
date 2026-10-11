package gg.pixelkingdomwars.nativeclient.renderer.globe2

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.GlobeArt
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3VertexArray
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The 32 exploration islands as their own GPU layer (RG-1; GLOBE-NATIVE-PLAN §3.2 ExplorationIslandLayer): the legacy
 * globe's chain art ('globe-isles', one instanced quad per island, the exact texel at the ray's hit) and its animated
 * falls, beacons, vents and spores ('globe-fx', one pixel square per authored point, the production featureFrame
 * rules evaluated in the vertex stage). The globe-v2 faces carry plain sea under every islet slot (LANE-NB.md), so this
 * layer is the only island art: it draws at every zoom (mipmapped when minified, crisp texels when magnified).
 *
 * The per-frame CPU work is the legacy `visible()` rule and feature size per island (32 × a projection), written to
 * uniforms; the instance buffers are static. GL thread only; [frame] and [draw] never allocate.
 */
class ExplorationIslandLayer(private val art: GlobeArt, private val cell: Int, private val atlas: Int, private val fxCount: Int) {
    private val isleData: FloatArray = FloatArray(art.islands.size * 8).also { d ->
        art.islands.forEachIndexed { i, isle ->
            d[i * 8] = isle.lon.toFloat(); d[i * 8 + 1] = isle.lat.toFloat(); d[i * 8 + 2] = isle.rx.toFloat(); d[i * 8 + 3] = isle.ry.toFloat()
            d[i * 8 + 4] = isle.chain.toFloat(); d[i * 8 + 5] = (isle.slot % 3).toFloat(); d[i * 8 + 6] = (isle.slot / 3).toFloat(); d[i * 8 + 7] = 0f
        }
    }
    /** Per island: x = feature square size (screen px), y = 1 while shown (the legacy visible() rule). */
    val fx = FloatArray(MAX_ISLANDS * 4)
    val visibleCount: Int get() { var n = 0; for (i in art.islands.indices) if (fx[i * 4 + 1] > 0.5f) n++; return n }
    var isleVao: Gl3VertexArray? = null; private set
    var fxVao: Gl3VertexArray? = null; private set
    private var buffers = IntArray(0)
    private val p = DoubleArray(3); private val out = DoubleArray(2)

    init { require(art.islands.size <= MAX_ISLANDS) { "More than $MAX_ISLANDS exploration islands" } }

    /** Create the vertex arrays and static buffers (after every context change too). [points] may be null (no fx). */
    fun build(core: Gl3Core, points: GlobeFxPoints?) {
        val gl = core.gl
        val quad = gl.genBuffer(); val isles = gl.genBuffer()
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quad); gl.bufferData(GL20.GL_ARRAY_BUFFER, QUAD.capacity() * 4, QUAD, GL20.GL_STATIC_DRAW)
        val v = core.vertexArray(LAYOUT_ISLES)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, GL20.GL_FLOAT, false, 0, 0)
        val data = floats(isleData)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, isles); gl.bufferData(GL20.GL_ARRAY_BUFFER, isleData.size * 4, data, GL20.GL_STATIC_DRAW)
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, GL20.GL_FLOAT, false, 32, 0); gl.vertexAttribDivisor(1, 1)
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, GL20.GL_FLOAT, false, 32, 16); gl.vertexAttribDivisor(2, 1)
        isleVao = v
        var made = intArrayOf(quad, isles)
        if (points != null && points.count > 0) {
            val dirs = gl.genBuffer(); val info = gl.genBuffer(); val colors = gl.genBuffer()
            val f = core.vertexArray(LAYOUT_FX)
            gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, GL20.GL_FLOAT, false, 0, 0)
            gl.bindBuffer(GL20.GL_ARRAY_BUFFER, dirs); gl.bufferData(GL20.GL_ARRAY_BUFFER, points.dirs.size * 4, floats(points.dirs), GL20.GL_STATIC_DRAW)
            gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, GL20.GL_FLOAT, false, 12, 0); gl.vertexAttribDivisor(1, 1)
            gl.bindBuffer(GL20.GL_ARRAY_BUFFER, info); gl.bufferData(GL20.GL_ARRAY_BUFFER, points.info.size * 4, ints(points.info), GL20.GL_STATIC_DRAW)
            gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 4, GL20.GL_INT, 16, 0); gl.vertexAttribDivisor(2, 1)
            gl.bindBuffer(GL20.GL_ARRAY_BUFFER, colors); gl.bufferData(GL20.GL_ARRAY_BUFFER, points.colors.size, bytes(points.colors), GL20.GL_STATIC_DRAW)
            gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, GL20.GL_UNSIGNED_BYTE, true, 4, 0); gl.vertexAttribDivisor(3, 1)
            fxVao = f
            made += intArrayOf(dirs, info, colors)
        }
        core.bindVertexArray(null)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, 0)
        buffers = made
    }

    /** Forget the GL names of a dead context (never deleted: they belong to it). */
    fun lost() { isleVao = null; fxVao = null; buffers = IntArray(0) }

    /** `glDelete*` of the buffers only (the core deletes the vertex arrays it made): O(1), plan §5.9. */
    fun dispose(core: Gl3Core) {
        for (b in buffers) core.gl.deleteBuffer(b)
        buffers = IntArray(0); isleVao = null; fxVao = null
    }

    /**
     * The legacy `GlobeIslandEffects.visible()` rule and feature size on the new camera, per island, into [fx]: an
     * island's features show while it faces the camera (cosine > 0.2 from the view centre, the legacy `p.z > .2`), is
     * on screen ±30 px, and is at least 48 px across per [pxPerDp] (the legacy CSS-px threshold). The feature square is
     * one atlas cell texel on screen (legacy `size`), at least 1 px.
     */
    fun frame(cam: GlobeCameraV2, pxPerDp: Double) {
        val v = cam.view
        V.norm(p, v.eye)
        val ex = p[0]; val ey = p[1]; val ez = p[2]
        for (i in art.islands.indices) {
            val isle = art.islands[i]
            V.dirOf(p, isle.lon, isle.lat)
            val facing = p[0] * ex + p[1] * ey + p[2] * ez
            val dist = distanceTo(p, v.eye)
            val pxPerRad = v.pxPerRad / dist
            val across = 2 * isle.rx * PI / 180 * cos(isle.lat * PI / 180) * pxPerRad * facing
            val shown = facing > 0.2 && across / pxPerDp >= 48 && cam.projectDir(p, 0.0, out) &&
                out[0] > -30 * pxPerDp && out[0] < v.w + 30 * pxPerDp && out[1] > -30 * pxPerDp && out[1] < v.h + 30 * pxPerDp
            val size = max(1.0, (pxPerRad * PI / 180 * 2 * art.extent * max(isle.rx * cos(isle.lat * PI / 180), isle.ry) / art.cell).roundToInt().toDouble())
            fx[i * 4] = size.toFloat(); fx[i * 4 + 1] = if (shown) 1f else 0f
        }
    }

    /** Animation phase of the features (legacy: floor(elapsedMs / 125) % 8, 0 with motion off). */
    fun phase(clockMs: Long, motion: Boolean): Int = if (motion) (floor(clockMs / FX_STEP_MS.toDouble()).toLong() % 8).toInt() else 0

    fun drawIsles(core: Gl3Core, program: Gl3Program) {
        val vao = isleVao ?: return
        core.bindVertexArray(vao)
        core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, art.islands.size)
        core.bindVertexArray(null)
    }

    fun drawFx(core: Gl3Core, program: Gl3Program) {
        val vao = fxVao ?: return
        if (visibleCount == 0) return
        core.bindVertexArray(vao)
        core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, fxCount)
        core.bindVertexArray(null)
    }

    /** The feature draw regardless of visibility (the rehearsal draws it once into a 1×1 scratch target). */
    fun drawFxAlways(core: Gl3Core) {
        val vao = fxVao ?: return
        core.bindVertexArray(vao)
        core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, fxCount)
        core.bindVertexArray(null)
    }

    /** uIsleGrid: x = cell px, y = atlas px (at the uploaded resolution), z = the box extent in rx/ry units. */
    val gridX: Float = cell.toFloat()
    val gridY: Float = atlas.toFloat()
    val gridZ: Float = art.extent.toFloat()

    val islandCount: Int get() = art.islands.size

    companion object {
        const val MAX_ISLANDS = 32
        const val LAYOUT_ISLES = 0x6710
        const val LAYOUT_FX = 0x6711
        /** The production featureFrame step (island-effects.mjs), as the legacy renderer runs it. */
        const val FX_STEP_MS = 125L
        private val QUAD = floats(floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 0f, 1f, 1f, 0f, 1f))

        private fun distanceTo(p: DoubleArray, eye: DoubleArray): Double {
            val dx = eye[0] - p[0]; val dy = eye[1] - p[1]; val dz = eye[2] - p[2]; return kotlin.math.sqrt(dx * dx + dy * dy + dz * dz)
        }
        private fun floats(a: FloatArray) = ByteBuffer.allocateDirect(a.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().put(a).also { it.position(0) }
        private fun ints(a: IntArray) = ByteBuffer.allocateDirect(a.size * 4).order(ByteOrder.nativeOrder()).asIntBuffer().put(a).also { it.position(0) }
        private fun bytes(a: ByteArray) = ByteBuffer.allocateDirect(a.size).order(ByteOrder.nativeOrder()).put(a).also { it.position(0) }
    }
}
