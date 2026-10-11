package gg.pixelkingdomwars.nativeclient.seekerauction

import gg.pixelkingdomwars.nativeclient.network.ApiException
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

private val auctionHttpJson = Json { encodeDefaults = true }
// Transport envelope bounds, not game numbers: a full round view and the largest submit body sit well inside them.
private const val AUCTION_MAX_RESPONSE_BYTES = 131072
private const val AUCTION_MAX_REQUEST_BYTES = 4096
private const val AUCTION_ROUTES = "/seeker/auctions/"

/** Exactly the seven server auction routes (apps/api/src/seeker/auctionRoutes.ts) with their exact bodies.
 * Anything else is refused before a cookie is read or a byte leaves the device. */
private fun auctionRoute(method: String, path: String, query: Map<String, String>, body: JsonObject?) {
    when (method) {
        "GET" -> {
            require(body == null) { "Seeker auction reads carry no body" }
            when {
                path == "${AUCTION_ROUTES}current" -> require(query.isEmpty())
                path == "${AUCTION_ROUTES}refunds" -> if (query.isNotEmpty()) {
                    require(query.keys == setOf("round", "spot")); auctionU64(query.getValue("round"))
                    val spot = query.getValue("spot"); require(spot.length <= 9 && spot.matches(Regex("0|[1-9][0-9]*")))
                }
                path.startsWith("${AUCTION_ROUTES}round/") -> { require(query.isEmpty()); auctionU64(path.removePrefix("${AUCTION_ROUTES}round/")) }
                path.startsWith("${AUCTION_ROUTES}tx/") -> { require(query.isEmpty()); auctionSignature(path.removePrefix("${AUCTION_ROUTES}tx/")) }
                else -> throw IllegalArgumentException("Not a Seeker auction read")
            }
        }
        "POST" -> {
            val sent = requireNotNull(body) { "Seeker auction writes carry a body" }
            require(query.isEmpty())
            fun text(key: String): String = requireNotNull((sent[key] as? JsonPrimitive)?.takeIf { it.isString }).content
            fun spot() { require(requireNotNull((sent["spot"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()) >= 0) }
            when (path) {
                "${AUCTION_ROUTES}bids/prepare" -> {
                    require(sent.keys == setOf("round", "spot", "newTotalRaw")); auctionU64(text("round")); spot()
                    require(auctionU64(text("newTotalRaw")) > 0uL)
                }
                "${AUCTION_ROUTES}withdrawals/prepare" -> { require(sent.keys == setOf("round", "spot")); auctionU64(text("round")); spot() }
                "${AUCTION_ROUTES}submit" -> when (sent.keys) {
                    setOf("signedTransaction") -> { auctionBase64(text("signedTransaction"), minimumBytes = 66) }
                    setOf("signature") -> auctionSignature(text("signature"))
                    else -> throw IllegalArgumentException("Not a Seeker auction submission")
                }
                else -> throw IllegalArgumentException("Not a Seeker auction write")
            }
        }
        else -> throw IllegalArgumentException("Not a Seeker auction method")
    }
}

/** The Seeker island auction over GameApi's one captured authenticated origin and session (its cookie jar; never a
 * second cookie store). Private: no HTTP cache is ever consulted or written, whatever cache the caller's transport
 * carries. Neither GET nor POST retries or follows redirects; an error keeps its original HTTP status and code even
 * when a proxy answers with a non-JSON page. An owned response drains through retain before cancellation or a
 * changed session can return, and its cookies are published only to the unchanged session. */
class SeekerAuctionHttpPort(identity: StarterIdentity, private val jar: SessionCookieJar,
    private val token: SessionToken, release: String, transport: OkHttpClient = OkHttpClient()) : SeekerAuctionAuthenticatedPort {
    override val identity = identity.copy().also { it.validate() }
    private val base = this.identity.origin.toHttpUrl().also {
        require(it.isHttps && it.encodedPath == "/" && it.username.isEmpty() && it.password.isEmpty() && it.query == null && it.fragment == null)
    }
    private val agent = "PKW-Native/$release".also { require(it.length <= 256 && it.all { c -> c.code in 32..126 }) }
    private val client = transport.newBuilder().cookieJar(CookieJar.NO_COOKIES).cache(null)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).callTimeout(55, TimeUnit.SECONDS).build()

    /** Identity/token proof for an app adapter; exposes no credentials or rebinding. */
    fun requireCurrent(identity: StarterIdentity, token: SessionToken) {
        require(this.identity == identity && this.token === token); jar.requireCurrent(this.token)
    }

    override suspend fun request(method: String, path: String, query: Map<String, String>, body: JsonObject?,
        guard: () -> Unit, retain: suspend (JsonObject) -> Unit): JsonObject {
        val frozenQuery = query.toMap(); val frozenBody = body?.let { JsonObject(it.toMap()) }
        auctionRoute(method, path, frozenQuery, frozenBody)
        return exchange(method, path, frozenQuery, frozenBody, guard, retain)
    }
    private data class Received(val raw: JsonObject, val headers: Headers, val url: HttpUrl)

    private suspend fun exchange(method: String, path: String, query: Map<String, String>, body: JsonObject?, guard: () -> Unit,
        retain: suspend (JsonObject) -> Unit): JsonObject {
        val encoded = body?.toString()?.toByteArray(Charsets.UTF_8)?.also { require(it.size <= AUCTION_MAX_REQUEST_BYTES) }
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
                                val outcome: Pair<JsonObject?, ApiException?> = withContext(Dispatchers.IO) {
                                    response.use {
                                        val content = requireNotNull(it.body)
                                        require(content.contentLength() <= AUCTION_MAX_RESPONSE_BYTES &&
                                            !content.source().request(AUCTION_MAX_RESPONSE_BYTES + 1L)) { "Auction response exceeds byte limit" }
                                        val text = content.string()
                                        if (it.isSuccessful) {
                                            Pair(requireNotNull(auctionHttpJson.parseToJsonElement(text) as? JsonObject) { "Auction response is not an object" }, null)
                                        } else {
                                            // A proxy page is not JSON; the status and Retry-After still decide recovery.
                                            val parsed = runCatching { auctionHttpJson.parseToJsonElement(text) as? JsonObject }.getOrNull()
                                            Pair(null, apiFailure(it.code, parsed, it.header("Retry-After"), token))
                                        }
                                    }
                                }
                                outcome.second?.let { failure -> throw failure }
                                val raw = requireNotNull(outcome.first); retain(raw)
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
