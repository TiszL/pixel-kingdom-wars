package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEFleetArt
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAtlasGroup
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.Collections

/** Process-local reuse of verified immutable metadata, never permission, account state, or a lease.
 * Only [PrivateFleetContent]'s published-directory opener consults this cache. Caller-supplied byte
 * arrays always take the uncached verification path. The constructor hooks are internal test seams. */
internal class PrivateFleetParseCache(
    private val readBytes: (File) -> ByteArray = { it.readBytes() },
    private val digest: (ByteArray) -> String = { bytes ->
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    },
    private val parseFleet: (JsonValue) -> PhaseEFleetArt = { PhaseEFleetArt.parse(it) },
) {
    internal class Parsed(val manifest: NativeContentManifest, val fleet: PhaseEFleetArt,
        val descriptors: Map<String, ServiceAtlasGroup>)

    private data class Key(val directory: String, val contentVersion: String, val simVersion: Int,
        val catalogueSha256: String, val renderSha256: String)

    private val gate = Mutex()
    private val entries = object : LinkedHashMap<Key, Parsed>(4, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Key, Parsed>) = size > 2
    }

    /** The caller supplies only a published manifest, never an alleged verified parse. A cold parse
     * becomes reusable only after [consume] validates its descriptors through ServiceContent.session.
     * The mutex prevents concurrent foreground binders from repeating a cold verification. */
    suspend fun <T> published(directory: File, manifest: NativeContentManifest, candidate: PrivateFleetCandidate,
        requireCurrent: () -> Unit, consume: (Parsed) -> T): T = gate.withLock {
        requireCurrent(); currentCoroutineContext().ensureActive()
        require(manifest.contentVersion == candidate.contentVersion && manifest.simVersion == candidate.simVersion) {
            "Published content differs from the explicitly selected candidate"
        }
        fun pin(path: String) = manifest.files.single { it.path == path }.also {
            require(it.tier == "core" && it.size in 1..PrivateFleetContent.METADATA_BOUND.toLong())
        }
        val key = Key(directory.canonicalPath, manifest.contentVersion, manifest.simVersion,
            pin("catalogue.json").sha256, pin("render-catalog.json").sha256)
        val cached = entries[key]
        // Check the whole stored manifest too: the lookup tuple alone cannot authorize a forged
        // sourceCommit, size, tier or optional pin under the same advertised contentVersion.
        val parsed = if (cached != null) {
            require(cached.manifest == manifest) { "Published manifest differs from the verified generation" }
            cached
        } else {
            val root = File(key.directory)
            val raw = boundedRead(File(root, "manifest.json"), PrivateFleetContent.MANIFEST_BOUND)
            val catalogue = boundedRead(File(root, "catalogue.json"), PrivateFleetContent.METADATA_BOUND)
            val render = boundedRead(File(root, "render-catalog.json"), PrivateFleetContent.METADATA_BOUND)
            requireCurrent(); currentCoroutineContext().ensureActive()
            verify(candidate, raw, catalogue, render, manifest)
        }
        requireCurrent(); currentCoroutineContext().ensureActive()
        val opened = consume(parsed)
        requireCurrent(); currentCoroutineContext().ensureActive()
        if (cached == null) entries[key] = parsed
        opened
    }

    /** Same bounded owned snapshots are authenticated and parsed. The byte-array opener copies them
     * before suspension; the directory opener privately owns its newly read arrays. */
    fun verify(candidate: PrivateFleetCandidate, manifestBytes: ByteArray, catalogueBytes: ByteArray,
        renderBytes: ByteArray, publishedManifest: NativeContentManifest? = null): Parsed {
        require(manifestBytes.size in 1..PrivateFleetContent.MANIFEST_BOUND) { "Private candidate manifest exceeds the manifest bound" }
        require(catalogueBytes.size in 1..PrivateFleetContent.METADATA_BOUND && renderBytes.size in 1..PrivateFleetContent.METADATA_BOUND) {
            "Private candidate metadata exceeds the bound"
        }
        SceneLoadLog.mark(LoadEvent.PRIVATE_CONTENT_PARSE)
        val raw = Json.parseToJsonElement(String(manifestBytes, Charsets.UTF_8)).jsonObject
        val manifest = nativeContentManifest(raw, candidate.simVersion).let {
            it.copy(files = Collections.unmodifiableList(it.files.toList()))
        }
        require(manifest.contentVersion == candidate.contentVersion) { "Private candidate identity differs from the explicitly selected content" }
        require(publishedManifest == null || manifest == publishedManifest) { "Raw manifest differs from the published generation" }
        val contract = (raw["rendererContractVersion"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        require(contract == PrivateFleetContent.CONTRACT) { "Private candidate manifest is not renderer17" }
        corePin(manifest, "catalogue.json", catalogueBytes)
        corePin(manifest, "render-catalog.json", renderBytes)
        val catalogue = Json.parseToJsonElement(String(catalogueBytes, Charsets.UTF_8)).jsonObject
        require(catalogue["schemaVersion"]?.jsonPrimitive?.intOrNull == 1 &&
            catalogue["sourceCommit"]?.jsonPrimitive?.contentOrNull == manifest.sourceCommit &&
            catalogue["simVersion"]?.jsonPrimitive?.intOrNull == manifest.simVersion) {
            "Private candidate catalogue belongs to another content generation"
        }
        val root = JsonReader().parse(String(renderBytes, Charsets.UTF_8))
        val exact = root.get("rendererContractVersion")
        require(exact != null && exact.isNumber && exact.asDouble() == PrivateFleetContent.CONTRACT.toDouble()) {
            "Private candidate render catalogue is not renderer17"
        }
        val fleet = parseFleet(root)
        require(fleet.groups.keys.none { it in fleet.services.groups }) { "Fleet groups collide with service groups" }
        val descriptors = LinkedHashMap<String, ServiceAtlasGroup>(fleet.services.groups).also { it.putAll(fleet.groups) }
        return Parsed(manifest, fleet, Collections.unmodifiableMap(descriptors))
    }

    private fun corePin(manifest: NativeContentManifest, path: String, bytes: ByteArray) {
        val entry = manifest.files.single { it.path == path }
        require(entry.tier == "core" && entry.size == bytes.size.toLong()) { "Private candidate $path size differs from the manifest pin" }
        require(digest(bytes) == entry.sha256) { "Private candidate $path bytes differ from the manifest pin" }
    }

    private fun boundedRead(file: File, bound: Int): ByteArray {
        require(file.isFile && file.length() in 1..bound.toLong()) { "Private candidate metadata is absent or exceeds the bound" }
        return readBytes(file).also { require(it.size in 1..bound) { "Private candidate metadata exceeds the bound" } }
    }

    companion object { val process = PrivateFleetParseCache() }
}
