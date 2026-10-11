package gg.pixelkingdomwars.nativeclient.scene.world

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.opengl.GLES30
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmCatalog
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmImageDecoder
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackFiles
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPixelFill
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmUploads
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RgbaImage
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGl
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.Gl3IntUniforms
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneUploads
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePixelFill
import gg.pixelkingdomwars.nativeclient.scene.StagingUploader
import java.io.FileNotFoundException
import java.nio.ByteBuffer

/**
 * The bundled world content (`app/src/main/assets/world`, filled by `tools/world-debug-content.mjs`; every build type
 * since N5) as the realm loader's files. Every file is checked against `world/content.json`, and a file the
 * manifest does not list is refused (an empty expected hash never matches): content activates only after hash
 * verification (native CLAUDE.md). Called on the decode threads only (AssetManager reads).
 */
class AssetWorldFiles(private val assets: AssetManager, private val root: String = "world/") : RealmPackFiles {
    private val hashes: Map<String, String> by lazy {
        RealmLoader.contentHashes(String(bytes(CONTENT) ?: error("$root$CONTENT is missing: the world bundle was not built"), Charsets.UTF_8))
    }

    /** True when this APK carries the world bundle at all (every N5 build does; a CI `pkwWorldContent=absent-ci` one does not). */
    fun present(): Boolean = bytes(CONTENT) != null

    override fun read(path: String): ByteArray? = bytes(path)
    override fun expectedSha256(path: String): String = hashes[path] ?: UNLISTED

    private fun bytes(path: String): ByteArray? = try { assets.open(root + path).use { it.readBytes() } } catch (e: FileNotFoundException) { null }

    companion object {
        const val CONTENT = "content.json"
        private const val UNLISTED = ""
    }
}

/** chart8.webp → straight RGBA8 through `BitmapFactory`: never premultiplied, never density-scaled (plan §6.3). */
object BitmapRealmImages : RealmImageDecoder {
    override fun decode(bytes: ByteArray, key: String): RgbaImage? {
        val options = BitmapFactory.Options().apply { inPremultiplied = false; inScaled = false; inPreferredConfig = Bitmap.Config.ARGB_8888 }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
        try {
            if (bitmap.config != Bitmap.Config.ARGB_8888) return null
            val pixels = ByteBuffer.allocate(bitmap.byteCount)
            bitmap.copyPixelsToBuffer(pixels) // ARGB_8888 is R, G, B, A in memory
            return RgbaImage(bitmap.width, bitmap.height, pixels.array())
        } finally { bitmap.recycle() }
    }
}

/** Never-sampled realm textures through the shared worker context (`StagingUploader.fresh`, plan §5.7). */
class StagingRealmUploads(private val uploader: StagingUploader) : RealmUploads {
    override fun fresh(core: Gl3Core, pool: Gl3Pool, width: Int, height: Int, format: Gl3Format, levels: Int,
                       sampling: Gl3Sampling, wrap: Gl3Wrap, fill: RealmPixelFill): Gl3Texture? =
        uploader.fresh(core, pool, false, width, height, 1, format, levels, sampling, wrap) { _, level, w, h, out -> fill.fill(level, w, h, out) }
}

/** The N3 lanes' fresh array/2D textures (GROUND, LIFE, BASES share this one seam, NR/NL) through the same worker path. */
class StagingLaneUploads(private val uploader: StagingUploader) : LaneUploads {
    override fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                       sampling: Gl3Sampling, wrap: Gl3Wrap, fill: LanePixelFill): Gl3Texture? =
        uploader.fresh(core, pool, array, width, height, layers, format, levels, sampling, wrap) { layer, level, w, h, out -> fill.fill(layer, level, w, h, out) }
}

/**
 * The GLES 3.0 integer/array uniform calls GROUND ([GroundGl]) and LIFE ([Gl3IntUniforms]) need and `Gl3` does not carry
 * (lead decision, Rule 2: one app-side adapter instead of widening `Gl3`/`AndroidGl3`/`FakeGl3` for two lanes). One
 * `android.opengl` call per method on the current context; no allocation (the arrays are the lanes' own, reused).
 * World GL thread only (the lanes set uniforms only there).
 */
object Gles30LaneUniforms : GroundGl, Gl3IntUniforms {
    override fun uniform1ui(location: Int, v: Int) = GLES30.glUniform1ui(location, v)
    override fun uniform2i(location: Int, x: Int, y: Int) = GLES30.glUniform2i(location, x, y)
    override fun uniform4i(location: Int, x: Int, y: Int, z: Int, w: Int) = GLES30.glUniform4i(location, x, y, z, w)
    override fun uniform4ui(location: Int, x: Int, y: Int, z: Int, w: Int) = GLES30.glUniform4ui(location, x, y, z, w)
    override fun uniform1iv(location: Int, count: Int, v: IntArray, offset: Int) = GLES30.glUniform1iv(location, count, v, offset)
    override fun uniform2iv(location: Int, count: Int, v: IntArray, offset: Int) = GLES30.glUniform2iv(location, count, v, offset)
    override fun uniform4iv(location: Int, count: Int, v: IntArray, offset: Int) = GLES30.glUniform4iv(location, count, v, offset)
    override fun uniform3fv(location: Int, count: Int, v: FloatArray, offset: Int) = GLES30.glUniform3fv(location, count, v, offset)
    override fun uniform4fv(location: Int, count: Int, v: FloatArray, offset: Int) = GLES30.glUniform4fv(location, count, v, offset)
}

/** The frozen deed catalog the app ships (`native/fantasy/world-v1.json`): the realm map's deed authority. */
fun realmCatalog(assets: AssetManager): RealmCatalog =
    RealmCatalog.parse(assets.open("native/fantasy/world-v1.json").use { String(it.readBytes(), Charsets.UTF_8) })
