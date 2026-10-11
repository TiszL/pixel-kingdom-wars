package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmImageDecoder
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackException
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackFiles
import gg.pixelkingdomwars.nativeclient.renderer.world.ExactPng

/**
 * Verified reads of the pack files LIFE and BASES draw with (decode threads only): the realm's full `realm.json` (the
 * `sprites`, `creatures`, `map`, `edges`, `plots`, `true` sections the core's loader does not parse), realm files pinned
 * in its `files` table, and the shared realm-map pack (`realm/shared/…`: keeps, decor, the ambient fx). Every byte is
 * hashed against every manifest that pins it (native CLAUDE.md: content activates only after hash verification); a shared
 * file with no pinning manifest is refused, never used unverified.
 */
class LanePack(private val files: RealmPackFiles, private val images: RealmImageDecoder) {
    // No shared JsonReader: LIFE's and BASES' loads run on the two world-load threads at once and both parse realm.json
    // here, and a JsonReader keeps its parse state in fields (one reader per call, P0 2026-09-26).

    /** `realm/<id>/realm.json`, parsed, checked against the outer manifest when there is one. */
    fun realmJson(realmId: String): JsonValue {
        require(ID.matches(realmId)) { "Bad realm id $realmId" }
        val path = "realm/$realmId/realm.json"
        val bytes = verified(path, null, requireHash = false)
        return try { JsonReader().parse(String(bytes, Charsets.UTF_8)) } catch (e: RuntimeException) { throw RealmPackException("$path is not JSON: ${e.message}") }
    }

    /** A realm file pinned in its `realm.json` `files` table (null when the pack does not ship it). */
    fun realmFile(realm: JsonValue, realmId: String, key: String): ByteArray? {
        require(!key.contains("..") && !key.startsWith("/")) { "Bad pack key $key" }
        val pin = realm.get("files")?.get(key)?.getString("sha256", null) ?: return null
        return verified("realm/$realmId/$key", pin, requireHash = true)
    }

    /** A shared realm-map file (`realm/shared/<key>`), or null when absent. Refused without an outer manifest hash. Read
     *  and hashed once (keeps.png and decor.png are 0.3 MB each: a second read was a second copy on the heap). */
    fun shared(key: String): ByteArray? {
        require(!key.contains("..") && !key.startsWith("/")) { "Bad pack key $key" }
        val path = "realm/shared/$key"
        val bytes = files.read(path) ?: return null
        return checked(path, bytes, null, requireHash = true)
    }

    fun sharedJson(key: String): JsonValue? = shared(key)?.let {
        try { JsonReader().parse(String(it, Charsets.UTF_8)) } catch (e: RuntimeException) { throw RealmPackException("realm/shared/$key is not JSON: ${e.message}") }
    }

    /** Straight RGBA of a pack image: PNG through the exact decoder (binary alpha must survive), else the app's decoder. */
    fun pixels(bytes: ByteArray, key: String): LifeImage {
        if (key.endsWith(".png")) {
            val p = ExactPng.decode(bytes) ?: throw RealmPackException("$key is not an exact-decodable PNG")
            return LifeImage(p.width, p.height, p.rgba)
        }
        val img = images.decode(bytes, key) ?: throw RealmPackException("$key did not decode")
        return LifeImage(img.width, img.height, img.rgba)
    }

    private fun verified(path: String, packSha256: String?, requireHash: Boolean): ByteArray =
        checked(path, files.read(path) ?: throw RealmPackException("$path is missing"), packSha256, requireHash)

    private fun checked(path: String, bytes: ByteArray, packSha256: String?, requireHash: Boolean): ByteArray {
        val outer = files.expectedSha256(path)
        if (packSha256 == null && outer == null) {
            if (requireHash) throw RealmPackException("$path is pinned by no manifest: refused")
            return bytes
        }
        val got = RealmLoader.sha256Hex(bytes)
        if (packSha256 != null && got != packSha256.lowercase()) throw RealmPackException("$path does not match the sha256 its realm.json pins")
        if (outer != null && got != outer.lowercase()) throw RealmPackException("$path does not match the sha256 the content manifest pins")
        return bytes
    }

    companion object { private val ID = Regex("[a-z0-9][a-z0-9-]{0,40}") }
}
