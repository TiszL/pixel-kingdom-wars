package gg.pixelkingdomwars.nativeclient.audio

import gg.pixelkingdomwars.nativeclient.content.*
import gg.pixelkingdomwars.nativeclient.data.ApiClient
import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.network.sameOriginContentUrl
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.Closeable
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class AudioAssetLease(val directory: File, val paths: Set<String>, private val release: () -> Unit) : Closeable {
    private var closed = false
    fun file(path: String): File { check(!closed && path in paths); return File(directory, path) }
    @Synchronized override fun close() { if (!closed) { closed = true; release() } }
}

fun interface AudioAssetSource {
    suspend fun acquire(pack: AudioPack, paths: Set<String>): AudioAssetLease
}

internal class AudioRetryException(val retryAfterMs: Long) : IOException("Optional audio is temporarily unavailable")

internal fun audioRetryDelayMs(error: Exception, minimumMs: Long): Long = maxOf(minimumMs, when (error) {
    is AudioRetryException -> error.retryAfterMs
    is ApiException -> (error.retryAfterSeconds ?: 0).coerceIn(0, Long.MAX_VALUE / 1_000) * 1_000
    else -> 0
})

internal fun audioRetryDeadline(nowMs: Long, delayMs: Long): Long =
    if (nowMs > Long.MAX_VALUE - delayMs) Long.MAX_VALUE else nowMs + delayMs

/** One optional store per app/origin. Complete exact banks only; core installation stays untouched.
 * Like WorldContent, a cached bank works offline, and a late/corrupt stage never becomes playable. */
class AudioContent(root: File, private val origin: String, verifier: String = "", transport: OkHttpClient = OkHttpClient(),
                   private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private val store = ContentStore(root, verifier = verifier)
    private val gate = Mutex()
    private var verifiedGeneration: Pair<NativeContentManifest, HttpUrl>? = null
    private var retryAtMs = Long.MIN_VALUE
    private val trusted = origin.toHttpUrl()
    private val client = transport.newBuilder().apply { interceptors().clear(); networkInterceptors().clear() }
        .cookieJar(CookieJar.NO_COOKIES).authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(true).build()

    fun source(api: ApiClient): AudioAssetSource = AudioAssetSource { pack, paths -> acquire(pack, paths, api) }

    suspend fun acquire(pack: AudioPack, paths: Set<String>, api: ApiClient): AudioAssetLease = gate.withLock {
        require(paths.isNotEmpty())
        val files = paths.sorted().map { path ->
            require(path.startsWith("audio/") && path.split('/').none { it == ".." || it.isEmpty() })
            val file = requireNotNull(pack.manifest.files.singleOrNull { it.path == path }) { "Audio is absent from this content pack" }
            ContentFile(file.path, file.sha256, file.size)
        }
        val identityBytes = buildJsonObject {
            put("pack", pack.identity)
            put("files", buildJsonArray { files.forEach { file -> add(buildJsonObject {
                put("path", file.path); put("sha256", file.sha256); put("size", file.size)
            }) } })
        }.toString().toByteArray()
        val identity = MessageDigest.getInstance("SHA-256").digest(identityBytes).joinToString("") { "%02x".format(it) }
        val manifest = ContentManifest(1, pack.manifest.sourceCommit, identity, files)
        fun wrap(lease: ContentLease) = AudioAssetLease(lease.directory, paths.toSet(), lease::close)
        // Keep ownership outside withContext: cancellation on its dispatch back to main can
        // discard the return value even though the IO block already acquired a store lease.
        var cached: ContentLease? = null
        try {
            withContext(Dispatchers.IO) { cached = runCatching { store.retain(identity) }.getOrNull() }
            currentCoroutineContext().ensureActive()
            cached?.let { return@withLock wrap(it).also { cached = null } }
        } finally { cached?.close() }
        // A cold battle bank contains many samples. Share one verified immutable manifest,
        // and one origin-wide failure cooldown, so optional sound cannot flood the gameplay API.
        // Already verified disk leases above remain available while offline or throttled.
        val now = nowMs()
        if (now < retryAtMs) throw AudioRetryException(retryAtMs - now)
        var retained: ContentLease? = null
        try {
        val known = verifiedGeneration?.takeIf { it.first == pack.manifest }?.second
        val base = known ?: run {
            val advertised = NativeCapabilities.from(api.get("/native/capabilities")).contentManifestUrl
                ?: error("Optional audio is not available")
            sameOriginContentUrl(trusted, advertised.toHttpUrl())
        }
        coroutineScope {
            val context = currentCoroutineContext()
            val calls = java.util.concurrent.ConcurrentHashMap.newKeySet<Call>()
            val cancel = launch(start = CoroutineStart.UNDISPATCHED) {
                try { awaitCancellation() } finally { calls.forEach { it.cancel() } }
            }
            try {
                withContext(Dispatchers.IO) {
                    fun open(url: HttpUrl, timeoutMs: Long): InputStream {
                        context.ensureActive()
                        val call = client.newCall(Request.Builder().url(sameOriginContentUrl(trusted, url)).get().build())
                        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
                        calls += call
                        val response = try { context.ensureActive(); call.execute() }
                        catch (error: Exception) { calls -= call; context.ensureActive(); throw error }
                        if (!response.isSuccessful) {
                            val status = response.code
                            val retryAfter = response.header("Retry-After")?.toLongOrNull()?.takeIf { it >= 0 }
                            response.close(); calls -= call
                            if (status == 429 || status == 503) throw ApiException(status, null, "Optional audio download is busy", retryAfterSeconds = retryAfter)
                            error("Optional audio download failed")
                        }
                        return object : FilterInputStream(requireNotNull(response.body).byteStream()) {
                            override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                                context.ensureActive()
                                return try { super.read(bytes, offset, length) }
                                catch (error: Exception) { context.ensureActive(); throw error }
                            }
                            override fun close() { try { response.close() } finally { calls -= call } }
                        }
                    }
                    if (known == null) {
                    val raw = open(base, pack.runtime.manifestRequestTimeoutMs).use { input ->
                        val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val count = input.read(buffer); if (count < 0) break
                            require(output.size() + count <= 16 * 1024 * 1024) { "Content manifest is too large" }
                            output.write(buffer, 0, count)
                        }
                        Json.parseToJsonElement(output.toString(Charsets.UTF_8.name())).jsonObject
                    }
                    val remote = nativeContentManifest(raw, pack.manifest.simVersion)
                    require(remote.contentVersion == pack.identity && remote.files == pack.manifest.files) { "Audio content generation changed" }
                    context.ensureActive()
                    verifiedGeneration = pack.manifest to base
                    }
                    store.install(manifest) { file -> open(requireNotNull(base.resolve(file.path)), pack.runtime.assetRequestTimeoutMs) }
                    context.ensureActive()
                    store.activate(identity)
                    retained = store.retain(identity)
                }
                context.ensureActive()
            } finally { cancel.cancel() }
        }
        // coroutineScope waits for the cancellation watcher. Retain ownership until that
        // suspending boundary has completed, so cancellation cannot discard an unowned lease.
        currentCoroutineContext().ensureActive()
        wrap(requireNotNull(retained)).also { retained = null }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            retryAtMs = audioRetryDeadline(nowMs(), audioRetryDelayMs(error, pack.runtime.manifestRetryDelayMs))
            throw error
        } finally { retained?.close() }
    }
}
