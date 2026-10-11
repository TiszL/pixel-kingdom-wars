package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.content.ContentFile
import gg.pixelkingdomwars.nativeclient.content.ContentLease
import gg.pixelkingdomwars.nativeclient.content.ContentManifest
import gg.pixelkingdomwars.nativeclient.content.ContentStore
import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.sameOriginContentUrl
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEServiceArt
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetLease
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAssetSource
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAtlasGroup
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.Closeable
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Selected service groups use the existing verified store. Core pairs are copied
 * from admitted local content; optional pairs retain the same-origin download path.
 * Each renderer lease independently retains its verified JSON/PNG generation. */
class ServiceContent(private val root: File, origin: String, private val verifier: String = "",
                     transport: OkHttpClient = OkHttpClient(), private val availableBytes: (File) -> Long = { it.usableSpace }) {
    private val origin = origin.toHttpUrl()
    private val client = transport.newBuilder().cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS).build()
    private val stores = ConcurrentHashMap<String, Pair<ContentStore, Mutex>>()
    // One streamed pair at a time, with no scratch prefetch or whole-image buffers.
    private val downloads = Mutex()
    private val releases = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    internal suspend fun awaitLeaseReleases() { releases.coroutineContext.job.children.toList().joinAll() }

    suspend fun open(content: ContentState, api: ApiClient, owner: Job, requireCurrent: () -> Unit): ServiceContentSession =
        openOwned(content, api, owner, null, requireCurrent)

    suspend fun open(content: ContentState, api: ApiClient, owner: Job, retirement: ServiceContentRetirement,
                     requireCurrent: () -> Unit): ServiceContentSession =
        openOwned(content, api, owner, retirement, requireCurrent)

    private suspend fun openOwned(content: ContentState, api: ApiClient, owner: Job,
                                  retirement: ServiceContentRetirement?, requireCurrent: () -> Unit): ServiceContentSession {
        fun checkCurrent() {
            requireCurrent()
            if (retirement != null) {
                owner.ensureActive()
                if (retirement.requested) throw CancellationException("Service retirement requested")
            }
        }
        var owned: ServiceContentSession? = null
        try {
            val result = withContext(Dispatchers.IO) {
                checkCurrent(); ensureActive()
                val render = requireNotNull(content.renderCatalogue)
                val contract = requireNotNull((render["rendererContractVersion"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull)
                require(contract in 15..17)
                // Use the renderer's exact version dispatch: R17 validates the complete fleet
                // and cosmetics metadata before exposing its service graph. No fleet pixels load here.
                val art = requireNotNull(RendererCatalogue.serviceArt(JsonReader().parse(render.toString())))
                val manifest = requireNotNull(content.manifest).let { it.copy(files = it.files.toList()) }
                require(content.simVersion == manifest.simVersion && content.catalogue?.get("sourceCommit") == JsonPrimitive(manifest.sourceCommit))
                art.groups.values.forEach { groupManifest(manifest, it) }
                checkCurrent(); ensureActive()
                sessionOwned(manifest, art.groups, api, owner, art, content.assets, retirement, requireCurrent).also { owned = it }
            }
            currentCoroutineContext().ensureActive(); checkCurrent()
            return result.also { owned = null }
        } finally { owned?.close() } // coordinated close requests; it never awaits its unfinished open ticket
    }

    /** Internal seam exercises real TLS/ContentStore ownership without a copied
     * synthetic 49-appearance graph; production open always uses the strict parser. */
    internal fun session(manifest: NativeContentManifest, groups: Map<String, ServiceAtlasGroup>, api: ApiClient, owner: Job,
                         requireCurrent: () -> Unit): ServiceContentSession = session(manifest, groups, api, owner, null, null, requireCurrent)
    /** open()'s form: the parsed admitted graph rides the session for the Awning admission seam. */
    internal fun session(manifest: NativeContentManifest, groups: Map<String, ServiceAtlasGroup>, api: ApiClient, owner: Job,
                         art: PhaseEServiceArt?, requireCurrent: () -> Unit): ServiceContentSession =
        session(manifest, groups, api, owner, art, null, requireCurrent)
    internal fun session(manifest: NativeContentManifest, groups: Map<String, ServiceAtlasGroup>, api: ApiClient, owner: Job,
                         art: PhaseEServiceArt?, residentRoot: File?, requireCurrent: () -> Unit): ServiceContentSession =
        sessionOwned(manifest, groups, api, owner, art, residentRoot, null, requireCurrent)
    internal fun session(manifest: NativeContentManifest, groups: Map<String, ServiceAtlasGroup>, api: ApiClient, owner: Job,
                         art: PhaseEServiceArt?, residentRoot: File?, retirement: ServiceContentRetirement,
                         requireCurrent: () -> Unit): ServiceContentSession =
        sessionOwned(manifest, groups, api, owner, art, residentRoot, retirement, requireCurrent)

    private fun sessionOwned(manifest: NativeContentManifest, groups: Map<String, ServiceAtlasGroup>, api: ApiClient, owner: Job,
                             art: PhaseEServiceArt?, residentRoot: File?, retirement: ServiceContentRetirement?,
                             requireCurrent: () -> Unit): ServiceContentSession {
        val ownedManifest = manifest.copy(files = manifest.files.toList())
        val ownedGroups = groups.mapValues { (_, group) -> group.copy(files = group.files.toList()) }.toMap()
        ownedGroups.values.forEach {
            groupManifest(ownedManifest, it)
            require(!isCore(ownedManifest, it) || residentRoot != null) { "Resident service content is unavailable" }
        }
        requireCurrent(); owner.ensureActive()
        if (retirement?.requested == true) throw CancellationException("Service retirement requested")
        return ServiceContentSession(owner, requireCurrent, art, retirement) { group, checkpoint ->
            acquire(ownedManifest, requireNotNull(ownedGroups[group]) { "Unknown service group" }, api, residentRoot) {
                requireCurrent(); checkpoint()
            }
        }
    }

    private fun groupManifest(manifest: NativeContentManifest, group: ServiceAtlasGroup): ContentManifest {
        // The public opener's canonical parser owns the exact selected identities.
        // This internal IO seam only rechecks path safety, never copies realm IDs.
        require(group.id.matches(Regex("pe_[a-z0-9_-]{1,100}")))
        require(group.atlasPath == "atlas/${group.id}@1x.json" && group.imagePath == "atlas/${group.id}@1x.png")
        require(group.files.map { it.path } == listOf(group.atlasPath, group.imagePath))
        require(group.decodedBytes in 4..(4096L * 4096 * 4) && group.decodedBytes % 4 == 0L)
        val files = group.files.map { pin ->
            require(pin.size in 1..(512L * 1024 * 1024) && pin.sha256.matches(Regex("[a-f0-9]{64}")))
            val original = manifest.files.single { it.path == pin.path }
            require(original.tier in setOf("optional", "core") && original.sha256 == pin.sha256 && original.size == pin.size) { "Service pins differ from admitted content" }
            ContentFile(pin.path, pin.sha256, pin.size)
        }
        require(group.files.map { pin -> manifest.files.single { it.path == pin.path }.tier }.distinct().size == 1) {
            "Service pins differ from admitted content: mixed residency"
        }
        val identity = buildJsonObject {
            put("serviceGroupVersion", 1)
            put("files", buildJsonArray { files.forEach { file -> add(buildJsonObject { put("path", file.path); put("sha256", file.sha256); put("size", file.size) }) } })
        }.toString().toByteArray()
        val version = MessageDigest.getInstance("SHA-256").digest(identity).joinToString("") { "%02x".format(it) }
        return ContentManifest(1, manifest.sourceCommit, version, files)
    }

    private fun isCore(manifest: NativeContentManifest, group: ServiceAtlasGroup): Boolean =
        manifest.files.single { it.path == group.atlasPath }.tier == "core"

    private suspend fun acquire(full: NativeContentManifest, group: ServiceAtlasGroup, api: ApiClient, residentRoot: File?, checkpoint: () -> Unit): ServiceAssetLease {
        val proposed = groupManifest(full, group)
        val (store, gate) = stores.computeIfAbsent(group.id) {
            ContentStore(File(root, group.id), verifier = verifier, availableBytes = availableBytes) to Mutex()
        }
        var retained: ContentLease? = null
        val calls = ConcurrentHashMap.newKeySet<Call>()
        try {
            val result = gate.withLock {
                coroutineScope {
                    val context = currentCoroutineContext()
                    fun check() { context.ensureActive(); checkpoint() }
                    val cancel = launch(start = CoroutineStart.UNDISPATCHED) {
                        try { awaitCancellation() } finally { calls.forEach { it.cancel() } }
                    }
                    try {
                        withContext(Dispatchers.IO) {
                            check()
                            val manifest = store.receiptForSameFiles(proposed)
                            val cached = runCatching { store.retain(manifest.contentVersion) }.getOrNull()
                            if (cached != null) {
                                retained = cached
                                require(cached.manifest == manifest) { "Cached service receipt differs" }
                                check(); return@withContext cached
                            }
                            downloads.withLock download@ {
                                check()
                                if (isCore(full, group)) {
                                    val resident = requireNotNull(residentRoot).canonicalFile
                                    store.install(manifest) { file ->
                                        check()
                                        val source = File(resident, file.path)
                                        require(source.canonicalFile == source.absoluteFile && source.isFile) { "Invalid resident service file" }
                                        source.inputStream()
                                    }
                                    check(); check(store.activate(manifest.contentVersion)); check()
                                    return@download store.retain(manifest.contentVersion).also { retained = it; check() }
                                }
                                val advertised = NativeCapabilities.from(api.get("/native/capabilities")).contentManifestUrl
                                    ?: error("Service content is unavailable")
                                check()
                                val base = sameOriginContentUrl(origin, advertised.toHttpUrl())
                                fun open(url: HttpUrl): InputStream {
                                    check()
                                    val call = client.newCall(Request.Builder().url(url).get().build())
                                    calls.add(call)
                                    try {
                                        check()
                                        val response = call.execute()
                                        try {
                                            check(); require(response.isSuccessful) { "Service content download failed (${response.code})" }
                                            return object : FilterInputStream(requireNotNull(response.body).byteStream()) {
                                                override fun read(): Int { check(); return super.read().also { check() } }
                                                override fun read(b: ByteArray, off: Int, len: Int): Int {
                                                    check()
                                                    return try { super.read(b, off, len).also { check() } } catch (error: Exception) { check(); throw error }
                                                }
                                                override fun close() { try { response.close() } finally { calls.remove(call) } }
                                            }
                                        } catch (error: Exception) { response.close(); throw error }
                                    } catch (error: Exception) { calls.remove(call); check(); throw error }
                                }
                                val raw = open(base).use { input ->
                                    val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(64 * 1024)
                                    while (true) {
                                        val count = input.read(buffer); if (count < 0) break
                                        require(out.size() + count <= 16 * 1024 * 1024) { "Service manifest is too large" }
                                        out.write(buffer, 0, count)
                                    }
                                    Json.parseToJsonElement(out.toString(Charsets.UTF_8.name())).jsonObject
                                }
                                val remote = nativeContentManifest(raw, full.simVersion)
                                require(manifest.files.all { pin -> remote.files.any { it.path == pin.path && it.tier == "optional" && it.sha256 == pin.sha256 && it.size == pin.size } }) { "Service content changed; update core content first" }
                                check()
                                store.install(manifest) { file ->
                                    check(); open(sameOriginContentUrl(origin, requireNotNull(base.resolve(file.path))))
                                }
                                check(); check(store.activate(manifest.contentVersion)); check()
                                store.retain(manifest.contentVersion).also { retained = it; check() }
                            }
                        }
                    } finally { cancel.cancel(); calls.forEach { it.cancel() } }
                }
            }
            currentCoroutineContext().ensureActive(); checkpoint()
            return ServiceAssetLease(FileHandle(result.directory)) { releases.launch { result.close() } }.also { retained = null }
        } finally { retained?.let { releases.launch { it.close() } } }
    }
}

/** Session closure owns cancellation, while each renderer lease independently
 * owns its verified generation until textures are unloaded. Coordinated sessions
 * fence logically first and cancel physically only after admission invalidation. */
class ServiceContentSession internal constructor(private val owner: Job, private val requireCurrent: () -> Unit,
                                                 /** The SAME admitted graph open() parsed, never a readiness claim. */
                                                 val art: PhaseEServiceArt?,
                                                 private val retirement: ServiceContentRetirement?,
                                                 private val acquireGroup: suspend (String, () -> Unit) -> ServiceAssetLease) : Closeable {
    /** Preserve the existing constructor and its automatic owner cancellation. */
    internal constructor(owner: Job, requireCurrent: () -> Unit, art: PhaseEServiceArt? = null,
                         acquireGroup: suspend (String, () -> Unit) -> ServiceAssetLease) :
        this(owner, requireCurrent, art, null, acquireGroup)

    private val closed = AtomicBoolean() // logical fence; published before physical cancellation
    private val physicallyClosed = AtomicBoolean()
    private val lifetime = SupervisorJob(if (retirement == null) owner else null)
    private val stateLock = Any()
    private val jobs = ConcurrentHashMap.newKeySet<Job>()
    private fun coordinatedCurrent(): Boolean = retirement == null || (owner.isActive && !retirement.requested)
    /** Private unconditional cancellation; never delegates to gated public cancelPending. */
    private fun cancelJobs() {
        val pending = synchronized(stateLock) { jobs.toList() }
        pending.forEach { it.cancel() }
    }
    val assets: ServiceAssetSource = object : ServiceAssetSource {
        override fun isCurrent(): Boolean = !closed.get() && lifetime.isActive && coordinatedCurrent() &&
            runCatching { requireCurrent(); true }.getOrDefault(false)
        override fun acquire(group: String, checkpoint: () -> Unit): ServiceAssetLease {
            val job = Job(lifetime); synchronized(stateLock) { jobs.add(job) }
            var retained: ServiceAssetLease? = null
            fun check() {
                job.ensureActive()
                if (closed.get() || !coordinatedCurrent()) throw CancellationException("Service session closed")
                checkpoint()
            }
            try {
                check()
                runBlocking(job) { retained = acquireGroup(group, ::check); ensureActive() }
                check()
                return requireNotNull(retained).also { retained = null }
            } finally { synchronized(stateLock) { jobs.remove(job) }; job.cancel(); retained?.close() }
        }
        override fun cancelPending() {
            if (retirement == null) { cancelJobs(); return }
            // e613ec93: ordinary ACTIVE cancellation leaves the owner reusable. Its
            // snapshot linearizes under the same state lock as logical/physical close;
            // actual job cancellation is outside locks. Retirement owns later cleanup.
            val pending = synchronized(stateLock) {
                if (retirement.requested || closed.get() || physicallyClosed.get() || !owner.isActive) return
                jobs.toList()
            }
            pending.forEach { it.cancel() }
        }
    }
    init {
        retirement?.registerSource(revoke = { synchronized(stateLock) { closed.set(true) } }, close = ::closePhysical)
    }
    private fun closePhysical() {
        val close = synchronized(stateLock) {
            closed.set(true)
            physicallyClosed.compareAndSet(false, true)
        }
        if (close) { lifetime.cancel(); cancelJobs() }
    }
    override fun close() {
        if (retirement == null) closePhysical()
        else {
            synchronized(stateLock) { closed.set(true) }
            retirement.requestRetirement() // request only; the opener may still own its ticket
        }
    }
}

/** Permission belongs to the current account/foreground observation, never to a
 * cached file or frozen battle. Older replies cannot restore a newer refusal. */
class ServiceArtPermission(private val api: ApiClient, private val requireCurrent: () -> Unit,
                           private val publish: (Boolean) -> Unit) : Closeable {
    private var revision = 0L
    private var closed = false
    suspend fun refresh() {
        val request = synchronized(this) {
            if (closed) return
            publish(false); ++revision; requireCurrent(); revision
        }
        try {
            val permitted = NativeCapabilities.from(api.get("/native/capabilities")).phaseEArt?.enabled == true
            currentCoroutineContext().ensureActive()
            synchronized(this) {
                if (!closed && revision == request) { requireCurrent(); publish(permitted) }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* Missing, malformed and failed reads keep this observation dark. */ }
    }
    override fun close() = synchronized(this) { if (!closed) { closed = true; ++revision; publish(false) } }
}
