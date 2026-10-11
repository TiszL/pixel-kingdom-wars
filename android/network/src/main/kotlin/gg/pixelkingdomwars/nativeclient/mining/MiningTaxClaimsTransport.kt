package gg.pixelkingdomwars.nativeclient.mining

import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.network.SessionToken
import gg.pixelkingdomwars.nativeclient.network.apiFailure
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.IOException
import java.util.Base64
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

private val taxHttpJson = Json { encodeDefaults = true }

/** One captured authenticated origin/session. An owned response drains through retain before
 * cancellation or a changed session can return. Neither GET nor POST retries or redirects. */
class MiningTaxClaimsHttpPort(identity: StarterIdentity, private val jar: SessionCookieJar,
    private val token: SessionToken, release: String, transport: OkHttpClient = OkHttpClient()) {
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

    private fun route(method: String, path: String, body: JsonObject?): JsonObject? {
        require(path.length <= 128)
        if (method == "POST") {
            val value = requireNotNull(body)
            return when (path) {
                // This low-level bound is the historical u8 ABI, not today's catalogue spot count.
                "/claims/mining-tax/prepare" -> taxHttpJson.encodeToJsonElement(MiningTaxClaimsPrepareRequest.serializer(), MiningTaxClaimsPrepareRequest.from(value, 256)).jsonObject
                "/claims/mining-tax/submit" -> taxHttpJson.encodeToJsonElement(MiningTaxClaimsSubmitRequest.serializer(), MiningTaxClaimsSubmitRequest.from(value)).jsonObject
                else -> {
                    val prefix = "/claims/mining-tax/continue/"; require(path.startsWith(prefix)); taxReviewKey(path.removePrefix(prefix))
                    taxHttpJson.encodeToJsonElement(MiningTaxClaimsContinuationRequest.serializer(), MiningTaxClaimsContinuationRequest.from(value)).jsonObject
                }
            }
        }
        require(method == "GET" && body == null)
        val prefix = listOf("/claims/mining-tax/prepare/by-key/", "/claims/mining-tax/review/by-key/", "/claims/mining-tax/failures/by-key/", "/claims/mining-tax/continuations/by-key/", "/claims/mining-tax/by-key/").firstOrNull { path.startsWith(it) }
            ?: error("Unexpected tax history route")
        val suffix = path.removePrefix(prefix)
        if (prefix.contains("/review/")) {
            require(suffix.length == 38 && suffix[36] == '/' && suffix.last() in '0'..'1'); taxReviewKey(suffix.take(36))
        } else taxReviewKey(suffix)
        return null
    }
    private data class Received(val raw: JsonObject, val headers: Headers, val url: HttpUrl)

    suspend fun request(method: String, path: String, body: JsonObject?, guard: () -> Unit,
        ambiguous: () -> Unit, errorBody: suspend (JsonObject) -> Unit = {}, retain: suspend (JsonObject) -> Unit): JsonObject {
        val frozen = route(method, path, body)
        val encoded = frozen?.toString()?.toByteArray(Charsets.UTF_8)?.also { require(it.size <= 4096) }
        currentCoroutineContext().ensureActive(); jar.requireCurrent(token); guard()
        val url = base.newBuilder().encodedPath("/api$path").build()
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
                                        try {
                                            val content = requireNotNull(it.body)
                                            require(content.contentLength() <= 32768 && !content.source().request(32769)) { "Tax response exceeds byte limit" }
                                            val parsed = taxHttpJson.parseToJsonElement(content.string()) as? JsonObject
                                            if (it.isSuccessful) requireNotNull(parsed) { "Tax response is not an object" }
                                            parsed to if (it.isSuccessful) null else apiFailure(it.code, parsed, it.header("Retry-After"), token)
                                        } catch (error: Throwable) {
                                            if (it.isSuccessful) ambiguous()
                                            throw error
                                        }
                                    }
                                }
                                body.second?.let { failure ->
                                    body.first?.let { errorBody(it) }
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

/** Private endpoint grammar only. Durable owners must cryptographically bind retained evidence;
 * none of these acknowledgements or observations authorizes signing, relay, or archival. */
class MiningTaxClaimsTransport(private val port: MiningTaxClaimsHttpPort, private val miningEnabled: () -> Boolean) {
    val identity = port.identity.copy()
    private fun checkGuard(post: Boolean, guard: () -> Unit): () -> Unit = {
        guard(); check(port.identity == identity); if (post) check(miningEnabled()) { "Mining mutations are paused" }
    }
    private fun attribute(raw: JsonObject, key: String) {
        fun string(name: String) = (raw[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
        require(string("wallet") == identity.wallet && string("idempotencyKey") == key)
    }
    private fun observeRecovery(raw: JsonObject, observe: (Int?) -> Unit) {
        val status = (raw["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (status in setOf("setup", "settled") || raw["settlement"] != JsonNull || status !in setOf("unknown", "prepared", "signed")) {
            val ordinal = ((raw["settlement"] as? JsonObject)?.get("ordinal") as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it in 0..1 }
            observe(ordinal)
        }
    }
    private suspend fun retainWires(raw: JsonObject, key: String, observe: (Int?) -> Unit, retain: suspend (MiningTaxClaimsSignedWire) -> Unit) {
        val rows = requireNotNull(raw["wires"] as? JsonArray).toList(); require(rows.size <= 2)
        var failure: Exception? = null
        for (row in rows) try {
            val wire = MiningTaxClaimsSignedWire.from(row.jsonObject)
            require(wire.wallet == identity.wallet && wire.idempotencyKey == key)
            retain(wire)
        } catch (error: Exception) { observe(null); if (failure == null) failure = error }
        failure?.let { throw it }
    }
    suspend fun preparation(request: MiningTaxClaimsPrepareRequest, totalSpots: Int, post: Boolean,
        guard: () -> Unit, retain: suspend (MiningTaxClaimsPreparationEnvelope) -> Unit) {
        val original = request.copy(caps = request.caps.copy()).also { it.validate(if (post) totalSpots else 256) }
        val body = if (post) taxHttpJson.encodeToJsonElement(MiningTaxClaimsPrepareRequest.serializer(), original).jsonObject else null
        port.request(if (post) "POST" else "GET", if (post) "/claims/mining-tax/prepare" else "/claims/mining-tax/prepare/by-key/${original.idempotencyKey}", body, checkGuard(post, guard), {}) { raw ->
            attribute(raw, original.idempotencyKey)
            val result = MiningTaxClaimsPreparationEnvelope.from(raw)
            if (post) require(result.preparation != null)
            result.preparation?.let { require(it.round == original.round && it.spot == original.spot && it.caps == original.caps) }
            retain(result)
        }
    }
    suspend fun review(preparation: MiningTaxClaimsPreparation, ordinal: Int, guard: () -> Unit): MiningTaxClaimsReviewResponse {
        val original = preparation.owned().also { it.validate(); require(it.wallet == identity.wallet && ordinal in it.transactions.indices) }
        var result: MiningTaxClaimsReviewResponse? = null
        port.request("GET", "/claims/mining-tax/review/by-key/${original.idempotencyKey}/$ordinal", null, checkGuard(false, guard), {}) { raw ->
            attribute(raw, original.idempotencyKey)
            result = MiningTaxClaimsReviewResponse.from(original, raw).also { require(it.ordinal == ordinal.toLong()) }
        }
        return requireNotNull(result)
    }
    suspend fun saved(key: String, guard: () -> Unit, observe: (Int?) -> Unit,
        retainWire: suspend (MiningTaxClaimsSignedWire) -> Unit = {}, retain: suspend (MiningTaxClaimsRecoveryEnvelope) -> Unit) {
        taxReviewKey(key)
        port.request("GET", "/claims/mining-tax/by-key/$key", null, checkGuard(false, guard), { observe(null) }) { raw ->
            observeRecovery(raw, observe)
            val result = try {
                // The durable owner verifies each attributed original wire against saved local
                // consent before malformed adjacent receipts/outer identity can refuse the GET.
                retainWires(raw, key, observe, retainWire)
                attribute(raw, key); MiningTaxClaimsRecoveryEnvelope.from(raw)
            } catch (error: Exception) { observe(null); throw error }
            retain(result)
        }
    }
    suspend fun failures(key: String, guard: () -> Unit, observe: (Int?) -> Unit,
        retainWire: suspend (MiningTaxClaimsSignedWire) -> Unit = {}, failureObserved: () -> Unit = {}, retain: suspend (MiningTaxClaimsFailureEnvelope) -> Unit) {
        taxReviewKey(key)
        suspend fun consume(raw: JsonObject, successful: Boolean) {
            val recovery = raw["recovery"] as? JsonObject
            val failures = raw["failures"] as? JsonArray
            if (failures == null || failures.isNotEmpty()) failureObserved()
            if (failures == null || failures.size > 2) observe(null)
            else for (row in failures) observe(((row as? JsonObject)?.get("ordinal") as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it in 0..1 })
            if (recovery == null) observe(null) else observeRecovery(recovery, observe)
            if (!successful) observe(null)
            val result = try {
                val r = requireNotNull(recovery); retainWires(r, key, observe, retainWire)
                if (successful) { attribute(r, key); MiningTaxClaimsFailureEnvelope.from(raw) } else null
            } catch (error: Exception) { observe(null); throw error }
            if (result != null) retain(result)
        }
        port.request("GET", "/claims/mining-tax/failures/by-key/$key", null, checkGuard(false, guard), { observe(null) }, errorBody = { raw ->
            // Error status never authorizes a receipt, but owned nested positive
            // evidence and independently attributed original custody still drain.
            if ("recovery" in raw || "failures" in raw) consume(raw, false)
        }) { consume(it, true) }
    }
    /** A request is supplied only for an explicit unsigned preparation POST.
     * A received link is history, never permission to adopt or approve its child. */
    suspend fun continuation(key: String, request: MiningTaxClaimsContinuationRequest?, guard: () -> Unit,
        observe: (Int?) -> Unit, continuationObserved: () -> Unit, retainWire: suspend (MiningTaxClaimsSignedWire) -> Unit,
        retain: suspend (MiningTaxClaimsContinuationEnvelope) -> Unit) {
        taxReviewKey(key); val original = request?.copy(caps = request.caps.copy())?.also { it.validate(); require(it.idempotencyKey != key) }
        suspend fun consume(raw: JsonObject, successful: Boolean) {
            val status = (raw["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val link = raw["continuation"] as? JsonObject
            if (status != "unknown" || raw["continuation"] != JsonNull) continuationObserved()
            if (!successful) observe(null)
            val value = try {
                (link?.get("parentWire") as? JsonObject)?.let {
                    val wire = MiningTaxClaimsSignedWire.from(it)
                    require(wire.wallet == identity.wallet && wire.idempotencyKey == key); retainWire(wire)
                }
                if (!successful) null else MiningTaxClaimsContinuationEnvelope.from(raw).also {
                    require(it.wallet == identity.wallet && it.parentIdempotencyKey == key)
                    if (original != null) {
                        val child = requireNotNull(it.continuation).childPreparation
                        require(child.idempotencyKey == original.idempotencyKey && child.caps == original.caps)
                    }
                }
            } catch (error: Exception) { observe(null); throw error }
            if (value != null) retain(value)
        }
        val body = original?.let { taxHttpJson.encodeToJsonElement(MiningTaxClaimsContinuationRequest.serializer(), it).jsonObject }
        port.request(if (original == null) "GET" else "POST", if (original == null) "/claims/mining-tax/continuations/by-key/$key" else "/claims/mining-tax/continue/$key",
            body, checkGuard(original != null, guard), { observe(null) }, errorBody = { raw ->
                if ("continuation" in raw || raw["status"] == JsonPrimitive("continued")) consume(raw, false)
            }) { consume(it, true) }
    }
    suspend fun submit(key: String, signed: String, guard: () -> Unit, observe: (Int?) -> Unit,
        retainWire: suspend (MiningTaxClaimsSignedWire) -> Unit, retain: suspend (MiningTaxClaimsSubmitResponse) -> Unit) {
        val original = MiningTaxClaimsSubmitRequest(key, signed).also { it.validate() }
        val bytes = Base64.getDecoder().decode(original.signedTransaction)
        val hex = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
        val body = taxHttpJson.encodeToJsonElement(MiningTaxClaimsSubmitRequest.serializer(), original).jsonObject
        port.request("POST", "/claims/mining-tax/submit", body, checkGuard(true, guard), { observe(null) }) { raw ->
            val delivery = (raw["delivery"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (delivery !in setOf("held", "submitted")) {
                val ordinal = ((raw["wire"] as? JsonObject)?.get("ordinal") as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it in 0..1 }
                observe(if (delivery in setOf("setup", "settled")) ordinal else null)
            }
            val result = try {
                (raw["wire"] as? JsonObject)?.let {
                    val wire = MiningTaxClaimsSignedWire.from(it)
                    require(wire.wallet == identity.wallet && wire.idempotencyKey == key && wire.signedTransactionHex == hex)
                    // Save a valid original wire even if adjacent ACK fields are malformed or the session changed.
                    retainWire(wire)
                }
                attribute(raw, key)
                MiningTaxClaimsSubmitResponse.from(raw)
            } catch (error: Exception) { observe(null); throw error }
            retain(result)
        }
    }
}
