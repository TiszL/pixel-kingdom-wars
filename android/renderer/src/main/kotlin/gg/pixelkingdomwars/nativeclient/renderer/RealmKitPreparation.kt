package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue

data class PreparedRealmKitPage(val asset: LayeredGroundAsset, val pixels: LayeredRgba)
data class PreparedRealmKit(val source: RealmKitSource, val pages: List<PreparedRealmKitPage>)

/** Revision-5 counterpart of [LayeredGroundSource]: manifest and every sheet come from the same
 * scene-leased, verified root; bytes are hashed before the worker decodes them; decoded pixels are
 * checked like `assertRealmKitAssetPixels` before any GL upload is admitted. Accepted registries
 * admit only their requested realm; previews require an explicit host opt-in. */
class RealmKitSource private constructor(val manifestSha256: String, val kit: RealmKitManifest) {
    fun identity(tilePixels: Float) = "layered-r${kit.groundRevision}:$manifestSha256@$tilePixels"
    /** Presentation-worker only. `checkpoint` is the cancellation probe between reads, decodes and pixel rows. */
    fun prepare(read: (String, Int) -> ByteArray, decoder: LayeredImageDecoder, checkpoint: () -> Unit): PreparedRealmKit {
        val pages = mutableListOf<PreparedRealmKitPage>()
        for (asset in kit.assets.values) {
            checkpoint()
            val bytes = read(asset.path, asset.size.toInt())
            require(bytes.size.toLong() == asset.size && LayeredGroundSource.sha256(bytes) == asset.sha256) { "Realm kit artwork integrity mismatch" }
            checkpoint()
            val pixels = decoder.decode(bytes, asset.width, asset.height)
            validatePixels(kit, asset, pixels, checkpoint)
            checkpoint(); pages += PreparedRealmKitPage(asset, pixels)
        }
        return PreparedRealmKit(this, pages)
    }
    companion object {
        /** `section` is `layeredGroundV5` (or the debug preview twin): the r3/r4 descriptor shape,
         * `{version:1, status, manifests:[{realmId, manifestPath, sha256, size}]}`. */
        fun read(section: JsonValue, realmId: String, allowedRealms: Set<String>, previewAllowed: Boolean, rules: RealmKitRules, read: (String, Int) -> ByteArray): RealmKitSource {
            require(section.get("version")?.isLong == true && section.getLong("version") == 1L)
            val status = section.getString("status")
            require(status == "accepted" || (previewAllowed && status == "preview-only")) { "Unapproved realm kit artwork requires a preview host" }
            val entries = section.get("manifests")?.also { require(it.isArray && it.size in 1..allowedRealms.size) }
            if (entries != null) require(entries.map { it.getString("realmId") }.let { it.toSet().size == it.size && it.all { id -> id in allowedRealms } })
            val descriptor = if (entries == null) section else requireNotNull(entries.firstOrNull { it.getString("realmId") == realmId }) { "Realm kit artwork is not installed" }
            val hash = descriptor.getString("sha256"); require(hash.matches(Regex("[a-f0-9]{64}")))
            val path = descriptor.getString("manifestPath")
            require(path == "atlas/fantasy/layered-ground/$hash/manifest.json") { "Realm kit manifest identity changed" }
            val bytes = read(path, rules.manifestBytes)
            require(bytes.size <= rules.manifestBytes && LayeredGroundSource.sha256(bytes) == hash) { "Realm kit manifest failed verification" }
            val kit = RealmKitManifest(JsonReader().parse(bytes.toString(Charsets.UTF_8)), rules, allowedRealms, bytes.size)
            require(kit.realmId == realmId && kit.status == status) { "Realm kit manifest admission disagrees with its scene" }
            return RealmKitSource(hash, kit)
        }
        /** Mirror of `assertRealmKitAssetPixels`: every sheet has binary alpha (1 art px = 1 texel,
         * nothing to filter); the far repeat and the overview still are fully opaque; and in the
         * tileset, wherever a water-layer cell is opaque the base cell baked above it on the same tile
         * is transparent, in every frame of both (§7: the surface loop shows through bed and shore). */
        fun validatePixels(kit: RealmKitManifest, asset: LayeredGroundAsset, pixels: LayeredRgba, checkpoint: () -> Unit = {}) {
            require(pixels.width == asset.width && pixels.height == asset.height && pixels.bytes.size.toLong() == asset.width.toLong() * asset.height * 4) { "Realm kit artwork dimensions changed" }
            val opaque = asset.id == kit.far.asset.id || asset.id == kit.overview?.asset?.id
            for (y in 0 until pixels.height) {
                checkpoint()
                val row = y * pixels.width * 4
                for (x in 0 until pixels.width) {
                    val alpha = pixels.bytes[row + x * 4 + 3].toInt() and 255
                    require(alpha == 0 || alpha == 255) { "Realm kit sheets must have binary alpha" }
                    if (opaque) require(alpha == 255) { "Realm kit far and overview stills must be opaque" }
                }
            }
            if (asset.id != kit.tileset.id) return
            val water = kit.grid(RealmKitLayerId.WATER) ?: return
            val base = kit.grid(RealmKitLayerId.BASE) ?: return
            val tile = kit.tilePixels; val checked = mutableSetOf<Long>()
            for (i in 0 until kit.rules.fieldCells) {
                val w = water[i]; val b = base[i]
                if (w == 0 || b == 0 || !checked.add(w.toLong() * 65536 + b)) continue
                checkpoint()
                val wc = kit.cells[w - 1]; val bc = kit.cells[b - 1]
                for (wf in 0 until wc.frames) for (bf in 0 until bc.frames) for (v in 0 until tile) for (u in 0 until tile) {
                    val waterAlpha = pixels.bytes[((wc.y + v) * asset.width + wc.x + wf * tile + u) * 4 + 3].toInt() and 255
                    val baseAlpha = pixels.bytes[((bc.y + v) * asset.width + bc.x + bf * tile + u) * 4 + 3].toInt() and 255
                    require(waterAlpha != 255 || baseAlpha == 0) { "A base cell covers open water" }
                }
            }
        }
    }
}
