package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.security.MessageDigest

data class LayeredRgba(val width: Int, val height: Int, val bytes: ByteArray)
fun interface LayeredImageDecoder {
    /** Called on the presentation worker, after compressed size/hash admission.
     * Returned pixels are row-major, top-to-bottom, straight RGBA, not bitmap-native ARGB. */
    fun decode(encoded: ByteArray, width: Int, height: Int): LayeredRgba
}
data class PreparedLayeredPage(val asset: LayeredGroundAsset, val pixels: LayeredRgba)
data class PreparedLayeredGround(val source: LayeredGroundSource, val pages: List<PreparedLayeredPage>)

/** Manifest and all image bytes come from the same scene-leased, verified root.
 * Accepted registries admit only their requested realm; previews require an
 * explicit host opt-in. Section presence never chooses a historical scene context. */
class LayeredGroundSource private constructor(val manifestSha256: String, val rules: LayeredRealmGround) {
    fun identity(tilePixels: Float) = "layered-r${rules.groundRevision}:$manifestSha256@$tilePixels"
    fun prepare(read: (String, Int) -> ByteArray, decoder: LayeredImageDecoder, checkpoint: () -> Unit): PreparedLayeredGround {
        val pages = mutableListOf<PreparedLayeredPage>()
        for (asset in rules.assets.values) {
            checkpoint()
            val bytes = read(asset.path, asset.size.toInt())
            require(bytes.size.toLong() == asset.size && sha256(bytes) == asset.sha256) { "Layered artwork integrity mismatch" }
            checkpoint()
            val pixels = decoder.decode(bytes, asset.width, asset.height)
            require(pixels.width == asset.width && pixels.height == asset.height && pixels.bytes.size.toLong() == asset.width.toLong() * asset.height * 4) { "Layered artwork dimensions changed" }
            if (rules.groundRevision == 3) {
                if (asset.id == rules.ground.id) require((3 until pixels.bytes.size step 4).all { (pixels.bytes[it].toInt() and 255) == 255 }) { "Layered ground must be opaque" }
            } else validateAlpha(asset, pixels, checkpoint)
            checkpoint(); pages += PreparedLayeredPage(asset, pixels)
        }
        return PreparedLayeredGround(this, pages)
    }
    private fun validateAlpha(asset: LayeredGroundAsset, pixels: LayeredRgba, checkpoint: () -> Unit) {
        val center = asset.id == rules.ground.id
        val outer = asset.id == rules.exterior?.asset?.id
        val far = asset.id == rules.far?.asset?.id
        if (!center && !outer && !far) return
        for (y in 0 until pixels.height) {
            checkpoint()
            for (x in 0 until pixels.width) {
                val alpha = pixels.bytes[(y * pixels.width + x) * 4 + 3].toInt() and 255
                if (far) require(alpha == 255) { "Far ground must be opaque" }
                else {
                    if (x == 0 || y == 0 || x == pixels.width - 1 || y == pixels.height - 1)
                        require(alpha == 0) { "Layered scenery must have a transparent border" }
                    if (center) {
                        val r = rules.centerRect; val f = rules.field
                        val wx = r.x + (x + .5) * r.width / pixels.width; val wy = r.y + (y + .5) * r.height / pixels.height
                        if (wx >= f.x && wx < f.x + f.width && wy >= f.y && wy < f.y + f.height)
                            require(alpha == 255) { "The battlefield must be opaque" }
                    }
                }
            }
        }
    }
    companion object {
        fun read(section: JsonValue, realmId: String, allowedRealms: Set<String>, previewAllowed: Boolean, read: (String, Int) -> ByteArray): LayeredGroundSource {
            require(section.get("version")?.isLong == true && section.getLong("version") == 1L)
            val status = section.getString("status")
            require(status == "accepted" || (previewAllowed && status == "preview-only")) { "Unapproved layered artwork requires a preview host" }
            val entries = section.get("manifests")?.also { require(it.isArray && it.size in 1..allowedRealms.size) }
            if (entries != null) require(entries.map { it.getString("realmId") }.let { it.toSet().size == it.size && it.all { id -> id in allowedRealms } })
            val descriptor = if (entries == null) section else requireNotNull(entries.firstOrNull { it.getString("realmId") == realmId }) { "Layered realm artwork is not installed" }
            val hash = descriptor.getString("sha256"); require(hash.matches(Regex("[a-f0-9]{64}")))
            val path = descriptor.getString("manifestPath")
            require(path == "atlas/fantasy/layered-ground/$hash/manifest.json") { "Layered preview manifest identity changed" }
            val bytes = read(path, 256 * 1024)
            require(bytes.size <= 256 * 1024 && sha256(bytes) == hash) { "Layered preview manifest failed verification" }
            val rules = LayeredRealmGround(JsonReader().parse(bytes.toString(Charsets.UTF_8)), allowedRealms, bytes.size)
            require(rules.realmId == realmId && rules.status == status) { "Layered manifest admission disagrees with its scene" }
            return LayeredGroundSource(hash, rules)
        }
        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
