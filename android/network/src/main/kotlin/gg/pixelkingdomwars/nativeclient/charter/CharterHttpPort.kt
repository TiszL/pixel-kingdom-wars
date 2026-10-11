package gg.pixelkingdomwars.nativeclient.charter

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

private val charterHttpJson = Json { encodeDefaults = true }

/** One captured authenticated origin/session. An owned response drains through retain before
 * cancellation or a changed session can return. Neither GET nor POST retries or redirects. */
class CharterHttpPort(identity: StarterIdentity, private val jar: SessionCookieJar,
    private val token: SessionToken, release: String, transport: OkHttpClient = OkHttpClient()) : CharterPort {
    override val identity = identity.copy().also { it.validate() }
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

    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonObject)->Unit):JsonObject {
        val frozenQuery=query.toMap(); val frozenBody=body?.let{CharterGrammar.copy(it).jsonObject}
        validateCharterRequest(method,path,frozenQuery,frozenBody)
        return exchange(method,path,frozenQuery,frozenBody,guard,{retain(it.jsonObject)}).jsonObject
    }
    /** Tournament requests share the same captured session and owned-response drain. */
    suspend fun tournamentRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonElement)->Unit):JsonElement {
        val frozenQuery=query.toMap();val frozenBody=body?.let{gg.pixelkingdomwars.nativeclient.tournament.TournamentProtocol.copy(it).jsonObject}
        gg.pixelkingdomwars.nativeclient.tournament.validateTournamentRequest(method,path,frozenQuery,frozenBody)
        return exchange(method,path,frozenQuery,frozenBody,guard,retain,1_048_576,true)
    }
    /** D153.204 dissolution uses the same captured session and owned-response drain. */
    suspend fun retirementRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonElement)->Unit):JsonElement {
        val frozenQuery=query.toMap();val frozenBody=body?.let{gg.pixelkingdomwars.nativeclient.retirement.RetirementProtocol.copy(it).jsonObject}
        gg.pixelkingdomwars.nativeclient.retirement.validateRetirementRequest(method,path,frozenQuery,frozenBody)
        return exchange(method,path,frozenQuery,frozenBody,guard,retain,gg.pixelkingdomwars.nativeclient.retirement.RetirementProtocol.MAX_RESPONSE_BYTES)
    }
    /** D153.205 migration retains the same captured session and owned-response drain. */
    suspend fun migrationRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonElement)->Unit):JsonElement {
        val frozenQuery=query.toMap();val frozenBody=body?.let{gg.pixelkingdomwars.nativeclient.migration.MigrationProtocol.copy(it).jsonObject}
        gg.pixelkingdomwars.nativeclient.migration.validateMigrationRequest(method,path,frozenQuery,frozenBody)
        return exchange(method,path,frozenQuery,frozenBody,guard,retain,gg.pixelkingdomwars.nativeclient.migration.MigrationProtocol.MAX_RESPONSE_BYTES)
    }
    /** Vehicle requests retain the same original authenticated session and drain. */
    suspend fun vehicleRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonObject)->Unit):JsonObject = vehicleRequestWithDeparture(method,path,query,body,guard,retain) {}
    suspend fun vehicleRequestWithDeparture(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonObject)->Unit, created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture)->Unit):JsonObject {
        val frozenQuery=query.toMap();val frozenBody=body?.let{gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol.copy(it).jsonObject}
        gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol.validateRequest(method,path,frozenQuery,frozenBody)
        return exchange(method,path,frozenQuery,frozenBody,guard,{retain(it.jsonObject)},1_048_576,created=created).jsonObject
    }
    /** D184 exact dedicated trial routes, retaining original replies through cancellation. */
    suspend fun divineRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonObject)->Unit):JsonObject {
        val frozenQuery=query.toMap();val frozenBody=body?.let{gg.pixelkingdomwars.nativeclient.divine.DivineGrammar.copy(it).jsonObject}
        gg.pixelkingdomwars.nativeclient.divine.DivineGrammar.request(method,path,frozenQuery,frozenBody)
        return exchange(method,path,frozenQuery,frozenBody,guard,{retain(it.jsonObject)},gg.pixelkingdomwars.nativeclient.divine.DivineGrammar.MAX_RESPONSE_BYTES).jsonObject
    }
    /** D192 earned fragment custody reuses the captured session and owned-response drain. */
    suspend fun fragmentRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonObject)->Unit):JsonObject {
        val q=query.toMap();val b=body?.let{gg.pixelkingdomwars.nativeclient.divinefragments.DivineFragmentProtocol.copy(it).jsonObject}
        gg.pixelkingdomwars.nativeclient.divinefragments.DivineFragmentProtocol.request(method,path,q,b)
        return exchange(method,path,q,b,guard,{retain(it.jsonObject)},gg.pixelkingdomwars.nativeclient.divinefragments.DivineFragmentProtocol.MAX_BYTES).jsonObject
    }
    /** D188 ordinary equipment shares the captured session and original-response drain. */
    suspend fun equipmentRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonObject)->Unit, refusal:suspend (ApiException)->Unit = {}):JsonObject =
        equipmentRequestWithDeparture(method,path,query,body,guard,retain,refusal) {}
    suspend fun equipmentRequestWithDeparture(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
        retain:suspend (JsonObject)->Unit, refusal:suspend (ApiException)->Unit,
        created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture)->Unit):JsonObject {
        val frozenQuery=query.toMap();val frozenBody=body?.let{gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol.copy(it).jsonObject}
        gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentGrammar.request(method,path,frozenQuery,frozenBody)
        return exchange(method,path,frozenQuery,frozenBody,guard,{retain(it.jsonObject)},1_048_576,retainFailure=refusal,created=created).jsonObject
    }
    /** Fixed installed read-only RPC; bound decompressed bytes before JSON parsing. */
    suspend fun vehicleRpcRequest(method:String,params:JsonArray,guard:()->Unit):JsonObject {
        require(method in setOf("getGenesisHash","getSlot","getMultipleAccounts","getBlockHeight","isBlockhashValid","getFeeForMessage","getBalance","getSignatureStatuses"))
        require(identity.cluster in setOf("devnet","mainnet-beta"))
        val body=buildJsonObject{put("jsonrpc","2.0");put("id",1);put("method",method);put("params",gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol.copy(params))}
        return exchange("POST","/rpc/solana/${identity.cluster}",emptyMap(),body,guard,{},16*1024*1024).jsonObject
    }
    private data class Received(val raw: JsonElement, val headers: Headers, val url: HttpUrl, val status: Int)

    private suspend fun exchange(method: String, path: String, query: Map<String, String>, body: JsonObject?, guard: () -> Unit,
        retain: suspend (JsonElement) -> Unit, maxResponseBytes: Int = 65536, allowNull: Boolean = false, retainFailure:suspend(ApiException)->Unit = {},
        created: ((gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture)->Unit)? = null): JsonElement {
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
                                            require(content.contentLength() <= maxResponseBytes && !content.source().request(maxResponseBytes.toLong()+1)) { "Charter response exceeds byte limit" }
                                            val parsed = charterHttpJson.parseToJsonElement(content.string())
                                            if (it.isSuccessful) require(parsed is JsonObject || allowNull && parsed == JsonNull) { "Charter response is not an object" }
                                            parsed to if (it.isSuccessful) null else apiFailure(it.code, parsed as? JsonObject, it.header("Retry-After"), token)
                                    }
                                }
                                body.second?.let { failure ->
                                    retainFailure(failure)
                                    throw failure
                                }
                                val raw = requireNotNull(body.first); retain(raw)
                                if (continuation.isActive) continuation.resume(Received(raw, response.headers, response.request.url, response.code))
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
        if (created != null && received.raw is JsonObject) {
            gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture.fromResponse(method, path, received.status,
                received.headers.values("x-pkw-journey-created"), received.raw)?.let { proof -> runCatching { created(proof) } }
        }
        return received.raw
    }
}
