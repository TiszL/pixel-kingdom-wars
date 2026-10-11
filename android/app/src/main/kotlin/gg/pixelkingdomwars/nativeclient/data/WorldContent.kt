package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.content.ContentFile
import gg.pixelkingdomwars.nativeclient.content.ContentLease
import gg.pixelkingdomwars.nativeclient.content.ContentManifest
import gg.pixelkingdomwars.nativeclient.content.ContentStore
import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.sameOriginContentUrl
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.GlobeAssetLease
import gg.pixelkingdomwars.nativeclient.renderer.GlobeAssetSource
import com.badlogic.gdx.files.FileHandle
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.CoroutineContext

enum class WorldContentPhase { CHECKING_CACHE, CHECKING_RELEASE, DOWNLOADING, VERIFYING, READY }
data class WorldContentProgress(val phase: WorldContentPhase, val verifiedFiles: Int, val totalFiles: Int)

/** A separate verified optional generation. The installed render catalogue, already admitted by
 * core content verification, supplies every digest. Downloaded metadata may not replace those pins. */
class WorldContent(private val root: File, private val origin: String, verifier: String = "", transport: OkHttpClient = OkHttpClient(),
                   private val availableBytes: (File)->Long = { it.usableSpace }) {
    private val store = ContentStore(root, verifier = verifier, availableBytes = availableBytes)
    private val gate = Mutex()
    private val groupStores = java.util.concurrent.ConcurrentHashMap<String, Pair<ContentStore, Mutex>>()
    private val verifier = verifier
    private val downloads = Semaphore(3)
    // ContentStore serializes install and release. A slow body must never make a GL/Main lease
    // release wait on that monitor; ownership remains retained until this IO task completes.
    private val leaseReleases = CoroutineScope(SupervisorJob()+Dispatchers.IO)
    /** Diagnostics/tests may await ownership drainage off Main; renderer disposal never does. */
    internal suspend fun awaitLeaseReleases() { leaseReleases.coroutineContext.job.children.toList().joinAll() }
    private val client = transport.newBuilder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(true).connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(60, TimeUnit.SECONDS).build()

    suspend fun acquire(content: ContentState, api: ApiClient, onProgress: (WorldContentProgress) -> Unit = {}): ContentLease =
        acquireGroup(content, api, null, onProgress)

    /** The first draw requires only the overview. Each later region/chain is independently
     * verified and retained; a failed detail cannot make the already usable world disappear. */
    suspend fun open(content: ContentState, api: ApiClient, onProgress: (WorldContentProgress) -> Unit = {}): WorldContentSession {
        val fantasy = requireNotNull(content.renderCatalogue?.get("fantasy") as? JsonObject)
        val groups = worldContentGroups(fantasy).associateBy { it.id }
        val overview = acquireGroup(content, api, groups.getValue("overview"), onProgress)
        val source = object : GlobeAssetSource, java.io.Closeable {
            private val closed = java.util.concurrent.atomic.AtomicBoolean()
            private val jobs = java.util.concurrent.ConcurrentHashMap.newKeySet<Job>()
            override fun acquire(group: String, checkpoint: () -> Unit): GlobeAssetLease {
                val job = Job()
                jobs.add(job)
                if (closed.get()) job.cancel()
                var owned: ContentLease? = null
                try {
                    checkpoint() // Registration precedes the fence, so pause cannot miss this job.
                    runBlocking(job) {
                        owned = acquireGroup(content, api, requireNotNull(groups[group]) { "Unknown world detail group" })
                        ensureActive()
                    }
                    job.ensureActive()
                    val lease = requireNotNull(owned)
                    return GlobeAssetLease(FileHandle(lease.directory)) { leaseReleases.launch { lease.close() } }.also { owned = null }
                } finally { jobs.remove(job); job.cancel(); owned?.close() }
            }
            override fun cancelPending() { jobs.forEach { it.cancel() } }
            override fun close() { closed.set(true); cancelPending() }
        }
        return WorldContentSession(overview, source) { source.close();leaseReleases.launch { overview.close() } }
    }

    private suspend fun acquireGroup(content: ContentState, api: ApiClient, group: WorldContentGroup?, onProgress: (WorldContentProgress) -> Unit = {}): ContentLease {
        val ownedStore = if (group == null) store to gate else groupStores.computeIfAbsent(group.id) {
            ContentStore(File(root, "groups/${group.id}"), verifier = verifier, availableBytes = availableBytes) to Mutex()
        }
        val store = ownedStore.first
        val gate = ownedStore.second
        // Call cancellation belongs to one acquisition, never every region sharing this client.
        val activeCalls = java.util.concurrent.ConcurrentHashMap.newKeySet<okhttp3.Call>()
        // withContext can discard a successful result when cancellation wins the dispatch back.
        // Hold ownership outside that boundary until the caller can actually receive the lease.
        var retained: ContentLease? = null
        try {
            val acquired = gate.withLock {
        val render = requireNotNull(content.renderCatalogue)
        val section = requireNotNull(render["fantasy"] as? JsonObject) { "World artwork needs a content update" }
        require(section["presentation"] is JsonObject) { "World artwork needs a content update" }
        val globe = section.getValue("globe").jsonObject
        val files = group?.files?.sortedBy { it.path } ?: globe.getValue("files").jsonArray.map { element ->
            val file = element.jsonObject
            ContentFile(requireNotNull(file.string("path")), requireNotNull(file.string("sha256")), file.getValue("size").jsonPrimitive.long)
        }.also { list -> require(list.isNotEmpty() && list.all { it.path.startsWith("atlas/fantasy/globe/") }) }
        val legacyGlobe = JsonObject(globe.filterKeys { it != "groups" })
        val identity = group?.identity ?: worldContentHash(legacyGlobe)
        val proposedManifest = ContentManifest(1, requireNotNull(content.catalogue?.string("sourceCommit")), identity, files)
        val manifest = if(group==null)proposedManifest else withContext(Dispatchers.IO) { store.receiptForSameFiles(proposedManifest) }
        fun progress(phase: WorldContentPhase, verified: Int = 0) = onProgress(WorldContentProgress(phase,verified,files.size))
        // A complete cache remains available offline. An incomplete staging tree never activates.
        progress(WorldContentPhase.CHECKING_CACHE)
        val cached = withContext(Dispatchers.IO) { runCatching { store.retain(identity).also { retained = it } }.getOrNull() }
        if (cached != null) { progress(WorldContentPhase.READY,files.size);return@withLock cached }
        // Existing complete verified worlds remain usable without downloading the new grouping.
        // Retention checks the whole legacy receipt and pins it while either GL or its worker reads.
        if (group != null) {
            val legacy = withContext(Dispatchers.IO) { runCatching { this@WorldContent.store.retain(worldContentHash(legacyGlobe)).also { retained = it } }.getOrNull() }
            if (legacy != null) { progress(WorldContentPhase.READY,files.size); return@withLock legacy }
        }
        progress(WorldContentPhase.CHECKING_RELEASE)
        val advertised = NativeCapabilities.from(api.get("/native/capabilities")).contentManifestUrl
            ?: error("World download is not available yet. Realm lists and parcel inspection remain available.")
        val base = sameOriginContentUrl(origin.toHttpUrl(), advertised.toHttpUrl())
        coroutineScope {
            val operation = currentCoroutineContext()
            // Own the HTTP call throughout a stalled body read; leaving/backgrounding the screen
            // cancels this watcher immediately and closes all calls on this section-only client.
            val cancel = launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { activeCalls.forEach { it.cancel() } } }
            try {
                withContext(Dispatchers.IO) {
                    val context = operation
                    fun open(url: okhttp3.HttpUrl, requestContext: CoroutineContext = context): InputStream {
                        requestContext.ensureActive()
                        val call=client.newCall(Request.Builder().url(url).get().build())
                        activeCalls.add(call)
                        val response=try { worldDownloadIO(context,requestContext) { call.execute() } } catch(error:Exception) { activeCalls.remove(call);throw error }
                        if (!response.isSuccessful) { val status = response.code; response.close();activeCalls.remove(call);error("World download failed ($status)") }
                        return object : FilterInputStream(requireNotNull(response.body).byteStream()) {
                            override fun read(b: ByteArray, off: Int, len: Int): Int = worldDownloadIO(context,requestContext) { super.read(b,off,len) }
                            override fun close() { try { response.close() } finally { activeCalls.remove(call) } }
                        }
                    }
                    val raw = open(base).use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val count = input.read(buffer);if (count < 0) break
                            require(output.size() + count <= 16 * 1024 * 1024) { "World manifest is too large" }
                            output.write(buffer,0,count)
                        }
                        Json.parseToJsonElement(output.toString(Charsets.UTF_8.name())).jsonObject
                    }
                    val remote = nativeContentManifest(raw, requireNotNull(content.simVersion))
                    require(files.all { pinned -> remote.files.any { it.path == pinned.path && it.sha256 == pinned.sha256 && it.size == pinned.size } }) {
                        "World content changed. Apply the available content update before downloading the globe."
                    }
                    // Overlap network latency without keeping large PNG bodies in memory. The
                    // bounded scratch files are untrusted; ContentStore still hashes each byte and
                    // activates only its complete generation. No image decoding happens here.
                    var downloadBytes = 0L
                    val reusable=store.reusableFiles(manifest)
                    val needed=files.filter { it.path !in reusable }
                    needed.forEach { file ->
                        require(file.size >= 0 && file.size <= 512L * 1024 * 1024 - downloadBytes) { "World download exceeds the content limit" }
                        downloadBytes += file.size
                    }
                    require(availableBytes(root) >= downloadBytes * 2) { "Not enough space for world content" }
                    val scratch = File(root, "prefetch-${java.util.UUID.randomUUID()}").also { check(it.mkdir()) }
                    try {
                        coroutineScope {
                            val pending = needed.mapIndexed { index, file -> file.path to async(Dispatchers.IO) {
                                downloads.withPermit {
                                    val downloadContext = currentCoroutineContext()
                                    val output = File(scratch, index.toString())
                                    open(sameOriginContentUrl(origin.toHttpUrl(), requireNotNull(base.resolve(file.path))), downloadContext).use { input ->
                                        output.outputStream().use { target ->
                                            val buffer = ByteArray(64 * 1024)
                                            var received = 0L
                                            while (true) {
                                                downloadContext.ensureActive()
                                                val count = input.read(buffer, 0, minOf(buffer.size.toLong(), file.size - received + 1).toInt())
                                                if (count < 0) break
                                                received += count
                                                require(received <= file.size) { "World content exceeds declared length: ${file.path}" }
                                                target.write(buffer, 0, count)
                                            }
                                            require(received == file.size) { "Incomplete world content: ${file.path}" }
                                        }
                                    }
                                    output
                                }
                            } }.toMap()
                            try {
                                var openedFiles = reusable.size
                                store.install(manifest) { file ->
                                    context.ensureActive()
                                    // The preceding entry has passed ContentStore's hash before this
                                    // callback. Download completion alone never earns verified progress.
                                    progress(WorldContentPhase.DOWNLOADING, openedFiles)
                                    openedFiles++
                                    val downloaded = runBlocking { pending.getValue(file.path).await() }
                                    object : FilterInputStream(downloaded.inputStream()) {
                                        override fun read(b: ByteArray, off: Int, len: Int): Int { context.ensureActive(); return super.read(b, off, len) }
                                        override fun close() { try { super.close() } finally { downloaded.delete() } }
                                    }
                                }
                            } finally {
                                pending.values.forEach { it.cancel() }
                                activeCalls.forEach { it.cancel() }
                                withContext(NonCancellable) { pending.values.toList().joinAll() }
                            }
                        }
                    } finally { scratch.deleteRecursively() }
                    context.ensureActive()
                    progress(WorldContentPhase.VERIFYING,files.size)
                    store.activate(identity) // Complete section only; retain previous verified optional generation.
                    context.ensureActive()
                    store.retain(identity).also { retained = it; progress(WorldContentPhase.READY,files.size) }
                }
            } finally { cancel.cancel() }
        }
            }
            currentCoroutineContext().ensureActive()
            retained = null
            return acquired
        } finally { retained?.close() }
    }
}

class WorldContentSession(val overview: ContentLease, val assets: GlobeAssetSource, private val stop: () -> Unit) : java.io.Closeable {
    private val closed = java.util.concurrent.atomic.AtomicBoolean()
    override fun close() { if (closed.compareAndSet(false, true)) stop() }
}

internal inline fun <T> worldDownloadIO(operation: CoroutineContext, request: CoroutineContext, block: () -> T): T {
    operation.ensureActive()
    request.ensureActive()
    return try { block() } catch (error: Exception) {
        // The earlier cancellation watcher can reset HTTP before cancellation propagates to
        // this nested download. A closed viewer must still finish as cancellation, not IO failure.
        operation.ensureActive()
        request.ensureActive()
        throw error
    }
}
