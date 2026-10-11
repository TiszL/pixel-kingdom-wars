package gg.pixelkingdomwars.nativeclient.seeker

import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.network.SessionToken
import gg.pixelkingdomwars.nativeclient.network.apiFailure
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

private val shardsHttpJson = Json { encodeDefaults = true }

/** One captured authenticated origin/session. An owned response drains through retain before
 * cancellation or a changed session can return. Neither GET nor POST retries or redirects. */
class SeekerShardsClaimsHttpPort(identity: StarterIdentity, private val jar: SessionCookieJar,
    private val token: SessionToken, policy: SeekerShardsClaimsPolicy, release: String, transport: OkHttpClient = OkHttpClient()) : SeekerShardsClaimPort {
    private val policy = policy.copy().also { it.validate() }
    val identity = identity.copy().also { it.validate() }
    private val base = this.identity.origin.toHttpUrl().also {
        require(it.isHttps && it.encodedPath == "/" && it.username.isEmpty() && it.password.isEmpty() && it.query == null && it.fragment == null)
    }
    private val agent = "PKW-Native/$release".also { require(it.length <= 256 && it.all { c -> c.code in 32..126 }) }
    private val client = transport.newBuilder().cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).callTimeout(55, TimeUnit.SECONDS).build()

    /** Identity/token proof for an app adapter; exposes no credentials or rebinding. */
    fun requireCurrent(identity: StarterIdentity, token: SessionToken) {
        require(this.identity == identity && this.token === token); jar.requireCurrent(this.token)
    }

    private fun route(path: String, query: Map<String, String>) {
        if (path == "/seeker/shards/entitlements") {
            SeekerShardsEntitlementQuery.from(buildJsonObject { query.forEach { (key, value) -> put(key, value) } })
        } else {
            val prefix = "/seeker/shards/claims/by-key/"
            require(path.startsWith(prefix) && query.isEmpty())
            gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid(path.removePrefix(prefix))
        }
    }
    override suspend fun get(path: String, query: Map<String, String>, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
        val frozen = query.toMap(); route(path, frozen)
        return request("GET", path, frozen, null, guard, retain)
    }
    override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
        val frozen = SeekerShardsClaimRequest.from(body, policy).body(policy)
        return request("POST", "/seeker/shards/claims", emptyMap(), frozen, guard, retain)
    }
    private data class Received(val raw: JsonObject, val headers: Headers, val url: HttpUrl)

    private suspend fun request(method: String, path: String, query: Map<String, String>, body: JsonObject?, guard: () -> Unit,
        retain: (JsonObject) -> Unit): JsonObject {
        val encoded = body?.toString()?.toByteArray(Charsets.UTF_8)?.also { require(it.size <= 4096) }
        currentCoroutineContext().ensureActive(); jar.requireCurrent(token); guard()
        val url = base.newBuilder().encodedPath("/api$path").apply { query.forEach { (key, value) -> addQueryParameter(key, value) } }.build()
        val cookies = jar.requestCookies(token, url)
        val request = Request.Builder().url(url).header("Accept", "application/json").header("Origin", identity.origin)
            .header("X-PKW-Client", "android-native").header("User-Agent", agent)
            .apply { if (cookies.isNotEmpty()) header("Cookie", cookies.joinToString("; ") { "${it.name}=${it.value}" }) }
            .method(method, encoded?.toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        val call = client.newCall(request); val context = currentCoroutineContext()
        // 0 awaiting callback, 1 owned drain, 2 cancelled before ownership, 3 drain finished.
        val phase = AtomicInteger(0); val drained = CompletableDeferred<Unit>()
        val received = try {
            suspendCancellableCoroutine<Received> { continuation ->
                continuation.invokeOnCancellation { if (phase.compareAndSet(0, 2)) call.cancel() }
                context.ensureActive(); jar.requireCurrent(token); guard()
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
                    override fun onResponse(call: Call, response: Response) {
                        if (!phase.compareAndSet(0, 1)) { response.close(); return }
                        CoroutineScope(context + NonCancellable).launch {
                            try {
                                val body = withContext(Dispatchers.IO) {
                                    response.use {
                                            val content = requireNotNull(it.body)
                                            require(content.contentLength() <= 131072 && !content.source().request(131073)) { "SHARDS response exceeds byte limit" }
                                            val parsed = shardsHttpJson.parseToJsonElement(content.string()) as? JsonObject
                                            if (it.isSuccessful) requireNotNull(parsed) { "SHARDS response is not an object" }
                                            parsed to if (it.isSuccessful) null else apiFailure(it.code, parsed, it.header("Retry-After"), token)
                                    }
                                }
                                body.second?.let { failure ->
                                    throw failure
                                }
                                val raw = requireNotNull(body.first); retain(raw)
                                if (continuation.isActive) continuation.resume(Received(raw, response.headers, response.request.url))
                            } catch (error: Throwable) {
                                response.close()
                                if (continuation.isActive) continuation.resumeWithException(error)
                            } finally { phase.set(3); drained.complete(Unit) }
                        }
                    }
                })
            }
        } finally {
            if (phase.get() == 1) withContext(NonCancellable) { drained.await() }
        }
        currentCoroutineContext().ensureActive(); guard(); jar.requireCurrent(token)
        jar.acceptResponse(token, received.url, Cookie.parseAll(received.url, received.headers))
        return received.raw
    }
}
