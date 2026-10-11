package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.content.*
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.util.concurrent.TimeUnit

/** One instance per app data root. All hashing/decoding/downloads happen away from UI and GL. */
internal class NativeContentUpdates(root: File, origin: String,
    client: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15,TimeUnit.SECONDS).readTimeout(30,TimeUnit.SECONDS).callTimeout(60,TimeUnit.SECONDS)
        .retryOnConnectionFailure(false).build(),
    private val onLoad:((ContentLoadSample)->Unit)?=null,
    /** The APK build fingerprint that owns verification stamps; a new build re-hashes once. */
    verifier: String = "") {
    // This private transport only sends GETs. Recover a closed pooled connection;
    // game orders use GameApi's separate non-retrying command transport.
    private val client = client.newBuilder().retryOnConnectionFailure(true).build()
    private val storeRoot = root
    private val origin = origin.toHttpUrl()
    private val store = ContentStore(root, verifier = verifier, onVerification = { report ->
        onLoad?.invoke(ContentLoadSample(if (report.hashed) ContentLoadStage.STORE_VERIFY else ContentLoadStage.STORE_TRUST, report.elapsedNanos, report.files, 0, true))
    })
    private val gate = Mutex()
    private var lease: ContentLease? = null
    private data class Pending(val version: String,val sim: Int,val minimumRenderer: Int,val bundledVersion: String)
    private var pending: Pending? = null
    private var pendingLease: ContentLease? = null

    /** Optional consumers inherit the displayed generation's full verified receipt, never a later offer.
     * The receipt omits SIM; bind it to the already-admitted catalogue and recheck native identity. */
    suspend fun admittedManifest(content: AdmittedGameContent): NativeContentManifest = gate.withLock {
        val selected = checkNotNull(lease).also { check(it.directory == content.directory) }
        val manifest = checkNotNull(selected.manifest)
        val sim = content.catalogue.getValue("simVersion").jsonPrimitive.int
        nativeContentManifest(buildJsonObject {
            put("schemaVersion", manifest.schemaVersion); put("sourceCommit", manifest.sourceCommit)
            put("simVersion", sim); put("contentVersion", manifest.contentVersion)
            put("files", buildJsonArray { manifest.files.forEach { file -> add(buildJsonObject {
                put("path", file.path); put("sha256", file.sha256); put("size", file.size); put("tier", file.tier)
            }) } })
            put("cataloguePath", "catalogue.json"); put("renderCataloguePath", "render-catalog.json")
            put("atlasMetadataPath", "atlas/meta.json"); put("contractPath", "contracts.json")
            put("kotlinModelsPath", "kotlin/NativeContracts.kt")
        }, sim)
    }

    /** [bundledVersion] is the APK's own pack: a download is restored only under the bundle it
     * superseded (see [supersedes]); otherwise the bundle is used and the update check runs. */
    suspend fun restore(supportedSim: Int, minimumRenderer: Int = 2, bundledVersion: String): AdmittedGameContent? = withContext(Dispatchers.IO) {
        gate.withLock {
        currentCoroutineContext().ensureActive()
        var admitted:AdmittedGameContent?=null
        val selected=contentLoadWork(ContentLoadStage.RESTORE,onLoad) {
            store.acquireScene { directory ->
                supersedes(directory,bundledVersion) && compatibleContent(directory,supportedSim,minimumRenderer)?.also { admitted=it } != null
            }
        }
        try {
            currentCoroutineContext().ensureActive()
            val result=selected?.let {
                checkNotNull(admitted).also { content -> check(content.directory==it.directory) }
            }
            val previous=lease;lease=selected;previous?.close()
            result
        } catch(error:Exception) { selected?.close();throw error }
        }
    }

    suspend fun prepare(url: String, supportedSim: Int, bundledVersion: String, minimumRenderer: Int = 2): String? = withContext(Dispatchers.IO) {
        gate.withLock {
        val context = currentCoroutineContext()
        val manifestUrl = contentUpdateStep(ContentUpdateStage.MANIFEST_VALIDATION) { sameOriginContentUrl(origin,url.toHttpUrl()) }
        val bytes = contentUpdateStep(ContentUpdateStage.MANIFEST_DOWNLOAD) { get(manifestUrl).use { response ->
            requireNotNull(response.body).byteStream().use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(64 * 1024)
                while (true) { val count=input.read(buffer); if(count < 0) break
                    require(output.size() + count <= 16 * 1024 * 1024) { "Content manifest is too large" }
                    output.write(buffer,0,count)
                }
                output.toByteArray()
            }
        } }
        val (manifest,advertisedRenderer) = contentUpdateStep(ContentUpdateStage.MANIFEST_VALIDATION) {
            val value=Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
            nativeContentManifest(value,supportedSim) to value["rendererContractVersion"]
        }
        // This optional header is an admission hint, not hashed catalogue authority.
        // Legacy manifests omit it and still take the mandatory post-install check.
        if(advertisedRenderer!=null) contentUpdateStep(ContentUpdateStage.COMPATIBILITY) {
            val value=advertisedRenderer as? JsonPrimitive
            require(value!=null && !value.isString && compatibleRenderer(value.intOrNull,minimumRenderer)) {
                "Content renderer is incompatible"
            }
        }
        if (manifest.contentVersion == bundledVersion || manifest.contentVersion == lease?.directory?.name) return@withContext null
        val content = ContentManifest(1,manifest.sourceCommit,manifest.contentVersion,
            manifest.files.map { ContentFile(it.path,it.sha256,it.size,it.tier) })
        val directory = contentUpdateStep(ContentUpdateStage.INSTALL) { store.install(content) { file ->
            context.ensureActive()
            val fileUrl = sameOriginContentUrl(origin,requireNotNull(manifestUrl.resolve(file.path)))
            val response = contentUpdateStep(ContentUpdateStage.ASSET_DOWNLOAD) { get(fileUrl) }
            val input = requireNotNull(response.body).byteStream()
            // Closing a file closes its response even when a digest or size check fails.
            object : java.io.FilterInputStream(input) {
                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    context.ensureActive()
                    return contentUpdateStep(ContentUpdateStage.ASSET_DOWNLOAD) { super.read(b,off,len) }
                }
                override fun close() { response.close() }
            }
        } }
        contentUpdateStep(ContentUpdateStage.COMPATIBILITY) { require(compatible(directory,supportedSim,minimumRenderer)) { "Content catalogue is incompatible" } }
        val retained = contentUpdateStep(ContentUpdateStage.RETAIN) { store.retain(manifest.contentVersion) }
        pendingLease?.close(); pendingLease = retained
        pending = Pending(manifest.contentVersion,supportedSim,minimumRenderer,bundledVersion)
        manifest.contentVersion
        }
    }

    /** Caller only offers activation outside battles; old assets remain on disk for departing GL work. */
    suspend fun activate(): File? = withContext(Dispatchers.IO) {
        gate.withLock {
        val candidate = pending ?: return@withContext null
        val accepts: (File)->Boolean = { compatible(it,candidate.sim,candidate.minimumRenderer) }
        // Keep the displayed generation leased until its validated replacement
        // has been selected. Actual battle activation is gated by GameModel.
        // Record which bundle this download supersedes before it can become active, so a
        // process death between the two writes can only cost a re-download, never a stale restore.
        writeSupersedes(candidate.version,candidate.bundledVersion)
        contentUpdateStep(ContentUpdateStage.COMPATIBILITY) { check(store.activate(candidate.version,accepts)) }
        val selected=checkNotNull(store.acquireScene(accepts=accepts))
        check(selected.directory.name==candidate.version)
        val previous=lease;lease=selected;previous?.close()
        pendingLease?.close(); pendingLease = null
        pending = null
        selected.directory
        }
    }

    /** A downloaded generation is newer only than the bundle it was fetched against. After an
     * in-place APK upgrade the bundle changes and is at least as new as any earlier download, so
     * an older download must never outrank it (an upgraded Seeker otherwise kept the previous QA
     * pack active and could not present content the new bundle carries). Legacy downloads
     * without a marker are treated as superseded; their directories stay on disk. */
    private fun supersedes(directory: File, bundledVersion: String): Boolean =
        runCatching { File(storeRoot,"supersedes-${directory.name}").readText(Charsets.US_ASCII) == bundledVersion }.getOrDefault(false)
    private fun writeSupersedes(version: String, bundledVersion: String) {
        require(version.matches(Regex("[a-f0-9]{64}")) && bundledVersion.isNotEmpty() && bundledVersion.length <= 256)
        val target = File(storeRoot,"supersedes-$version"); val temporary = File(storeRoot,"supersedes-$version.${java.util.UUID.randomUUID()}.tmp")
        try {
            java.io.FileOutputStream(temporary).use { it.write(bundledVersion.toByteArray(Charsets.US_ASCII)); it.fd.sync() }
            java.nio.file.Files.move(temporary.toPath(),target.toPath(),java.nio.file.StandardCopyOption.ATOMIC_MOVE,java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
    }
    private fun compatible(directory: File, sim: Int, minimumRenderer: Int): Boolean =
        compatibleContent(directory,sim,minimumRenderer)!=null

    private fun compatibleContent(directory: File, sim: Int, minimumRenderer: Int): AdmittedGameContent? = runCatching {
        // A verified catalogue whose header already names an unsupported contract is rejected
        // before its multi-megabyte parse; the full parse below still decides every admission.
        rendererVersionHint(directory)?.let { hint ->
            contentLoadWork(ContentLoadStage.RENDER_HINT, onLoad) { require(compatibleRenderer(hint, minimumRenderer)) { "Content renderer is incompatible" } }
        }
        val content = GameContentCache.admitted(directory, onLoad)
        val catalogue = content.catalogue; val render = content.renderCatalogue
        val renderer=render["rendererContractVersion"]?.jsonPrimitive?.int
        content.takeIf {
            catalogue["schemaVersion"]?.jsonPrimitive?.int == 1 && catalogue["simVersion"]?.jsonPrimitive?.int == sim &&
                render["schemaVersion"]?.jsonPrimitive?.int == 1 && compatibleRenderer(renderer,minimumRenderer)
        }
    }.getOrNull()

    /** The exporter writes `rendererContractVersion` in the catalogue head; absent, the parse decides. */
    private fun rendererVersionHint(directory: File): Int? = runCatching {
        val head = ByteArray(256)
        val read = File(directory, "render-catalog.json").inputStream().use { it.read(head) }
        if (read <= 0) null else Regex(""""rendererContractVersion"\s*:\s*(\d{1,9})""").find(String(head, 0, read, Charsets.US_ASCII))?.groupValues?.get(1)?.toInt()
    }.getOrNull()

    private fun compatibleRenderer(renderer: Int?,minimumRenderer: Int) =
        renderer!=null && renderer in 2..15 && renderer>=minimumRenderer

    private fun get(url: HttpUrl): Response {
        val response = client.newCall(Request.Builder().url(url).header("Accept","application/octet-stream").build()).execute()
        if (!response.isSuccessful) { val code=response.code; response.close(); throw ContentHttpFailure(code) }
        return response
    }
    fun cancelDownloads() { client.dispatcher.cancelAll() }
    suspend fun close() = gate.withLock { lease?.close(); lease=null; pendingLease?.close(); pendingLease=null; client.connectionPool.evictAll() }
}
