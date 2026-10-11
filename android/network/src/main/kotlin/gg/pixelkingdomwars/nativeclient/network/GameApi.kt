package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.realmsales.RealmSalePrepareRefusal
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingRequest
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.ordinaryJson
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid as ordinaryCraftingUuid
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetRequest
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionRequest
import gg.pixelkingdomwars.nativeclient.starter.starterJson
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterRequest
import gg.pixelkingdomwars.nativeclient.harvester.harvesterJson
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.emitAll
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

class ApiException(val status: Int, val code: String?, override val message: String,
                   val details: JsonObject = buildJsonObject {}, val retryAfterSeconds: Long? = null,
                   val session: SessionToken? = null) : IOException(message)

/** Preserve the server's structured recovery data; never classify a failure by translated copy. */
internal fun apiFailure(status: Int, value: JsonObject?, retryAfter: String? = null, session: SessionToken? = null): ApiException {
    val error = (value?.get("error") as? JsonObject) ?: value
    return ApiException(status, error?.string("code"),
        error?.string("message") ?: value?.string("error") ?: "Server request failed ($status)",
        error ?: buildJsonObject {}, retryAfter?.toLongOrNull()?.takeIf { it >= 0 },session)
}
private class BoundSession(val token: SessionToken): AbstractCoroutineContextElement(Key) {
    companion object Key: CoroutineContext.Key<BoundSession>
}
private val RAID_COMMAND_PATH = Regex("/raids/[0-9a-fA-F-]{36}/commands")
fun JsonObject.string(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull
fun JsonObject.flag(key: String) = (get(key) as? JsonPrimitive)?.booleanOrNull == true
fun JsonObject.objects(key: String) = (get(key) as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
fun jsonBody(vararg values: Pair<String, String>) = buildJsonObject { values.forEach { put(it.first, it.second) } }

/** Recover stale pooled connections for reads only. A sent order can already
 * have been accepted even if its response disappears, so it must never replay here. */
internal class ApiConnections(private val commands: OkHttpClient) {
    init { require(!commands.retryOnConnectionFailure) }
    private val queries = commands.newBuilder().retryOnConnectionFailure(true).build()
    /** Cold-start measurement 2026-10-06 (QA chain lane): OkHttp runs at most 5 async calls per host, an open raid-events
     *  stream holds one of them for as long as it is open, and the lane's Phase E reads answer 503 only after seconds — so
     *  the Home read could wait in the dispatcher queue behind optional reads. The reads Home and sign-in need
     *  ([homeCriticalRead]) get their own dispatcher (same connection pool, same policy) and are never queued behind them. */
    private val critical = queries.newBuilder().dispatcher(Dispatcher()).build()
    fun newCall(request: Request): Call = when {
        request.method != "GET" -> commands
        homeCriticalRead(request.url.encodedPath) -> critical
        else -> queries
    }.newCall(request)
}

/** The GETs the first live Home and sign-in wait for: login status, identity, the deed directory, playtest access, the
 *  public update check and the Home read itself (`/base`, `/balances`, `/tutorial`). Every other read — Phase E, chain,
 *  social — is optional to the opening scene. Exact paths: `/base/buildings/receipt` and the like are not Home reads. */
val HOME_CRITICAL_READS: Set<String> = setOf("/api/auth/login/status", "/api/me", "/api/bases", "/api/playtest/access",
    "/api/native/capabilities", "/api/base", "/api/balances", "/api/tutorial")
fun homeCriticalRead(encodedPath: String): Boolean = encodedPath in HOME_CRITICAL_READS

/** [rendererContract] names the render-catalogue contract of the pack the app has LOADED (not the
 * ceiling the APK could admit): the API serves revision-5 realm-kit ground only to a renderer that
 * declares `X-PKW-Renderer-Contract` >= 15 (apps/api/src/native/clientPresentation.ts, E-12), and a
 * contract-15 APK still carrying a contract-14 pack has no `layeredGroundV5` section to draw it with.
 * Null (content not published yet) omits the header, which the API reads as the revision-4 floor.
 * It precedes [simVersion] so existing trailing-lambda call sites keep naming the SIM version. */
class GameApi internal constructor(origin: String, private val jar: SessionCookieJar, private val release: String, transport: OkHttpClient,
              private val rendererContract: () -> Int? = { null }, private val simVersion: () -> Int? = { null }) {
    constructor(origin: String, jar: SessionCookieJar, release: String, rendererContract: () -> Int? = { null }, simVersion: () -> Int? = { null }):
        this(origin,jar,release,OkHttpClient(),rendererContract,simVersion)
    companion object {
        /** Shorter than the smallest server keep-alive the app talks to (Node's 5 s default). */
        const val IDLE_CONNECTION_SECONDS = 4L
        /** A client over a caller-supplied transport (local HTTPS bridges and tests); the request policy above still applies. */
        fun withTransport(origin: String, jar: SessionCookieJar, release: String, transport: OkHttpClient,
                          rendererContract: () -> Int? = { null }, simVersion: () -> Int? = { null }): GameApi =
            GameApi(origin,jar,release,transport,rendererContract,simVersion)
    }
    private val base = origin.toHttpUrl().also { require(it.isHttps && it.encodedPath == "/") }
    private val client = transport.newBuilder().cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).callTimeout(55, TimeUnit.SECONDS)
        // Mutations are never replayed, so a pooled socket the origin already closed (Node's default
        // 5 s keep-alive) must not be reused for one: idle connections are dropped before that window.
        .connectionPool(ConnectionPool(5, IDLE_CONNECTION_SECONDS, TimeUnit.SECONDS))
        // Mutations may be accepted even when their response is lost. Never retry implicitly.
        .retryOnConnectionFailure(false).eventListenerFactory(commandTimingListener(transport.eventListenerFactory)).addInterceptor { chain ->
            // A server-sent-event GET names its own Accept; every other request is JSON.
            val request = chain.request().newBuilder().apply { if (chain.request().header("Accept") == null) header("Accept", "application/json") }
                .header("Origin", base.toString().trimEnd('/'))
                .header("X-PKW-Client", "android-native").header("User-Agent", "PKW-Native/$release")
            simVersion()?.let { request.header("x-sim-version",it.toString()) }
            rendererContract()?.let { request.header("X-PKW-Renderer-Contract",it.toString()) }
            chain.proceed(request.build())
        }.build()
    private val connections = ApiConnections(client)
    // A raid-events stream stays open for as long as the deed is watched: no call timeout, reads still bounded
    // (the server heartbeats well inside the read timeout), reconnection is the caller's explicit backoff.
    private val streams = client.newBuilder().retryOnConnectionFailure(true).callTimeout(0, TimeUnit.SECONDS).build()

    fun sessionToken(): SessionToken = jar.sessionToken()
    /** Exact tax transport over the existing authentication owner, never a second cookie store. */
    fun miningTaxClaimsPort(identity: gg.pixelkingdomwars.nativeclient.starter.StarterIdentity, session: SessionToken): gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsHttpPort {
        require(identity.origin == base.toString().trimEnd('/')); jar.requireCurrent(session)
        return gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsHttpPort(identity, jar, session, release, client)
    }
    /** SHARDS claims share this exact authentication owner and captured session. */
    fun seekerShardsClaimsPort(identity: gg.pixelkingdomwars.nativeclient.starter.StarterIdentity, session: SessionToken,
        policy: gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimsPolicy): gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimsHttpPort {
        require(identity.origin == base.toString().trimEnd('/')); jar.requireCurrent(session)
        return gg.pixelkingdomwars.nativeclient.seeker.SeekerShardsClaimsHttpPort(identity, jar, session, policy, release, client)
    }
    /** The Seeker island auction shares this exact authentication owner and captured session. */
    fun seekerAuctionPort(identity: gg.pixelkingdomwars.nativeclient.starter.StarterIdentity, session: SessionToken): gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionHttpPort {
        require(identity.origin == base.toString().trimEnd('/')); jar.requireCurrent(session)
        return gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionHttpPort(identity, jar, session, release, client)
    }
    /** Phase E Charter uses this captured authentication owner and drains late evidence. */
    fun charterClientPort(identity: gg.pixelkingdomwars.nativeclient.starter.StarterIdentity, session: SessionToken): gg.pixelkingdomwars.nativeclient.charter.CharterHttpPort {
        require(identity.origin == base.toString().trimEnd('/')); jar.requireCurrent(session)
        return gg.pixelkingdomwars.nativeclient.charter.CharterHttpPort(identity, jar, session, release, client)
    }
    /** Equipment market keeps the same original authentication and evidence drain. */
    fun keepEquipmentMarketClientPort(identity: gg.pixelkingdomwars.nativeclient.starter.StarterIdentity, session: SessionToken): gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketHttpPort {
        require(identity.origin == base.toString().trimEnd('/')); jar.requireCurrent(session)
        return gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketHttpPort(identity, jar, session, release, client)
    }
    fun beginAuthentication(session: SessionToken = jar.sessionToken()): SessionToken = jar.beginAuthentication(session)
    fun beginLogout(session: SessionToken = jar.sessionToken()): SessionToken = jar.beginLogout(session)
    fun requireCurrentSession(session: SessionToken) = jar.requireCurrent(session)
    suspend fun boundSession(): SessionToken = (currentCoroutineContext()[BoundSession]?.token ?: jar.sessionToken()).also { jar.requireCurrent(it) }
    suspend fun requireCurrentSession() { requireCurrentSession(boundSession()) }
    suspend fun <T> withSession(session: SessionToken, block: suspend () -> T): T {
        jar.requireCurrent(session)
        val result=withContext(BoundSession(session)) { block() }
        jar.requireCurrent(session)
        return result
    }
    suspend fun request(path: String, method: String = "GET", body: JsonObject? = null, query: Map<String,String> = emptyMap(), session: SessionToken? = null): JsonObject {
        val captured=session ?: boundSession()
        return requestCaptured(path,method,body,query,captured)
    }
    private suspend fun requestCaptured(path: String, method: String, body: JsonObject?, query: Map<String,String>, session: SessionToken,
                                        logoutCookies: List<Cookie>? = null, recentAuth: String? = null,
                                        binaryBody: RequestBody? = null, gameCurrency: gg.pixelkingdomwars.nativeclient.model.GameCurrency? = null, commandTiming: BattleCommandTransportTiming? = null, preparationTiming: BattlePreparationTiming? = null,
                                        expectedCurrency: gg.pixelkingdomwars.nativeclient.model.GameCurrency? = null, commandGuard: (() -> Unit)? = null, workshopEvidence: ((JsonObject) -> Unit)? = null, workshopRefusal: ((ApiException) -> Unit)? = null, moneyRefusal: ((ApiException) -> Unit)? = null,
                                        ordinaryEvidence: ((JsonObject) -> Unit)? = null, ordinaryRefusal: ((ApiException) -> Unit)? = null,
                                        miningResponseBound: Boolean = false, boundCosmeticResponse: Boolean = false, realmSaleEvidence: (suspend (JsonObject) -> Unit)? = null,
                                        realmSaleRefusal: (suspend (RealmSalePrepareRefusal) -> Unit)? = null,
                                        created: ((gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture) -> Unit)? = null): JsonObject {
        jar.requireCurrent(session)
        commandGuard?.invoke()
        try {
        var departure: gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture? = null
        val result=withContext(Dispatchers.IO) {
        commandTiming.observe(BattleCommandStage.TRANSPORT_IO_STARTED)
        require(path.startsWith('/') && !path.startsWith("//") && !path.contains('?') && !path.contains('#') && !path.contains(".."))
        val url = base.newBuilder().encodedPath("/api$path").apply { query.forEach { (k,v) -> addQueryParameter(k,v) } }.build()
        val payload = binaryBody ?: if (method == "GET") null else (body ?: buildJsonObject {}).toString().toRequestBody("application/json".toMediaType())
        val cookies=logoutCookies ?: jar.requestCookies(session,url)
        jar.requireCurrent(session)
        val request=Request.Builder().url(url).method(method,payload)
        if(cookies.isNotEmpty()) request.header("Cookie",cookies.joinToString("; ") { "${it.name}=${it.value}" })
        gameCurrency?.let { request.header("x-pkw-currency", it.name) }
        expectedCurrency?.let { request.header("x-pkw-expected-currency", it.name) }
        if(recentAuth != null) request.header("x-shardkeep-recent-auth", recentAuth)
        if(commandTiming != null) request.tag(BattleCommandTransportTiming::class.java, commandTiming)
        val call = connections.newCall(request.build())
        data class ParsedResponse(val response: Response, val parsed: JsonObject?, val failure: ApiException?)
        // No session, cookie or UI publication here: an explicitly observed response may belong
        // to a caller that was cancelled while its original evidence was arriving.
        fun parseResponse(response: Response): ParsedResponse = response.use {
            // Opt-in signed-wire boundaries: bound decompressed bytes before
            // JSON parsing, including chunked bodies with unknown content length.
            if (miningResponseBound || boundCosmeticResponse || realmSaleEvidence != null) {
                val body = it.body ?: throw ApiCompatibilityException(path)
                if (body.contentLength() > 32_768 || body.source().request(32_769)) throw ApiCompatibilityException(path)
            }
            val text = it.body?.string().orEmpty()
            commandTiming.observe(BattleCommandStage.RESPONSE_BODY_READ)
            preparationTiming.observe(BattlePreparationStage.BODY_READ)
            val parsed = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            if (parsed != null) { commandTiming.observe(BattleCommandStage.RESPONSE_JSON_PARSED); preparationTiming.observe(BattlePreparationStage.JSON_PARSED) }
            // Explicit historical GETs and unpaid resource POSTs retain their original proof
            // before late session/lifecycle guards, without publishing state or cookies.
            val evidence = ordinaryEvidence ?: workshopEvidence
            if (it.isSuccessful && evidence != null) evidence(validateResponseContract(path, method, parsed ?: throw ApiCompatibilityException(path)))
            // Only a Workshop POST exposes its own HTTP refusal before a changed session
            // masks the exception. Its engine admits exact first-attempt evidence under CAS.
            if (!it.isSuccessful && workshopRefusal != null) workshopRefusal(apiFailure(it.code, parsed, it.header("Retry-After"), session))
            // Explicit money/unpaid resource routes: malformed bodies remain uncertain even
            // when the ordinary catch runs. Only an actual typed original HTTP error is evidence.
            val originalError = parsed?.get("error") as? JsonObject
            val typedError = (originalError?.get("code") as? JsonPrimitive)?.isString == true &&
                (originalError["message"] as? JsonPrimitive)?.isString == true
            val typedRefusal = ordinaryRefusal ?: moneyRefusal
            val failure = if (it.isSuccessful) null else apiFailure(it.code,
                if (typedRefusal != null && !typedError) null else parsed, it.header("Retry-After"), session)
            if (failure != null && typedRefusal != null && typedError) typedRefusal(failure)
            ParsedResponse(it, parsed, failure)
        }
        val requestContext = currentCoroutineContext()
        fun enqueue(callback: Callback) {
            commandTiming.observe(BattleCommandStage.CALL_ENQUEUED)
            preparationTiming.observe(BattlePreparationStage.CALL_ENQUEUED)
            requestContext.ensureActive()
            if (commandGuard != null) { jar.requireCurrent(session); commandGuard() }
            call.enqueue(callback)
        }
        val observed = moneyRefusal != null || workshopEvidence != null || workshopRefusal != null || ordinaryEvidence != null || ordinaryRefusal != null || realmSaleEvidence != null
        val received = if (observed) {
            // 0 waiting, 1 response drain owned, 2 cancelled before handoff, 3 drain complete.
            // OkHttp's responseBodyEnd fires *inside* a source read, before string() returns.
            // Cancelling that read can lose a fully received original refusal. The callback
            // therefore owns parsing/closure once handed off, including prompt cancellation
            // before the IO continuation resumes. Existing read/call timeouts remain bounded.
            val phase = java.util.concurrent.atomic.AtomicInteger(0)
            val drained = kotlinx.coroutines.CompletableDeferred<Unit>()
            try {
                suspendCancellableCoroutine<ParsedResponse> { continuation ->
                    continuation.invokeOnCancellation { if (phase.compareAndSet(0, 2)) call.cancel() }
                    enqueue(object : Callback {
                        override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
                        override fun onResponse(call: Call, response: Response) {
                            if (!phase.compareAndSet(0, 1)) { response.close(); return }
                            if (realmSaleEvidence != null) {
                                // Ownership is claimed above before dispatch. The caller joins
                                // this bounded body drain and suspending durable retention even
                                // when its account scope is cancelled. No blocked coroutine bridge.
                                kotlinx.coroutines.CoroutineScope(requestContext + kotlinx.coroutines.NonCancellable).launch {
                                    try {
                                        val result = parseResponse(response)
                                        if (response.isSuccessful) realmSaleEvidence(validateResponseContract(path, method,
                                            result.parsed ?: throw ApiCompatibilityException(path)))
                                        else if (realmSaleRefusal != null) RealmSalePrepareRefusal.response(response.code, result.parsed)?.let { realmSaleRefusal(it) }
                                        else if (method == "GET" && (path.startsWith("/seeker/realm-sales/failures/by-key/") || path.startsWith("/seeker/realm-sales/by-key/"))) {
                                            // Historical error bodies have no success authority, but their
                                            // bounded attributed observations must drain before session failure.
                                            result.parsed?.let { realmSaleEvidence(it) }
                                        }
                                        if (continuation.isActive) continuation.resume(result)
                                    } catch (error: Exception) {
                                        response.close()
                                        if (continuation.isActive) continuation.resumeWithException(error)
                                    } finally { phase.set(3); drained.complete(Unit) }
                                }
                                return
                            }
                            try {
                                commandTiming.observe(BattleCommandStage.RESPONSE_CALLBACK)
                                preparationTiming.observe(BattlePreparationStage.RESPONSE_HEADERS)
                                val result = parseResponse(response)
                                if (continuation.isActive) continuation.resume(result)
                            } catch (error: Exception) {
                                response.close()
                                if (continuation.isActive) continuation.resumeWithException(error)
                            } finally { phase.set(3); drained.complete(Unit) }
                        }
                    })
                }
            } finally {
                // A cancelled owner cannot close its store ahead of the original callback's
                // CAS. This is only a join of an already-started response, never a new request.
                if (phase.get() == 1) withContext(kotlinx.coroutines.NonCancellable) { drained.await() }
            }
        } else {
            val response = suspendCancellableCoroutine<Response> { continuation ->
                continuation.invokeOnCancellation { call.cancel() }
                enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
                    override fun onResponse(call: Call, response: Response) {
                        commandTiming.observe(BattleCommandStage.RESPONSE_CALLBACK)
                        preparationTiming.observe(BattlePreparationStage.RESPONSE_HEADERS)
                        if (continuation.isActive) continuation.resume(response) { _, value, _ -> value.close() } else response.close()
                    }
                })
            }
            // Ordinary reads/posts still cancel their socket while consuming a slow body.
            val cancellation = kotlinx.coroutines.Job(currentCoroutineContext()[kotlinx.coroutines.Job])
            cancellation.invokeOnCompletion { call.cancel() }
            try { parseResponse(response) } finally { cancellation.cancel() }
        }
        currentCoroutineContext().ensureActive()
        if (realmSaleEvidence != null || boundCosmeticResponse) commandGuard?.invoke()
        val response = received.response
        jar.acceptResponse(session, response.request.url, Cookie.parseAll(response.request.url, response.headers))
        received.failure?.let { throw it }
        val validated = validateResponseContract(path, method, received.parsed ?: if (response.code == 204) buildJsonObject {} else throw ApiCompatibilityException(path))
        if (created != null) departure = gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture.fromResponse(
            method, path, response.code, response.headers.values("x-pkw-journey-created"), validated)
        validated
        }
        // This runs after returning to the caller dispatcher, including Android Main.
        commandTiming.observe(BattleCommandStage.TRANSPORT_RESUMED)
        jar.requireCurrent(session)
        if (boundCosmeticResponse || created != null) commandGuard?.invoke()
        departure?.let { proof -> runCatching { created?.invoke(proof) } }
        return result
        } catch(e: Exception) {
            currentCoroutineContext().ensureActive(); jar.requireCurrent(session)
            // Malformed/oversized bodies must not route an obsolete appearance view's
            // compatibility error into a newly selected kingdom or closed screen.
            if (boundCosmeticResponse) commandGuard?.invoke()
            throw e
        }
    }
    internal suspend fun getPresentation(path: String, query: Map<String,String>, session: SessionToken, timing: BattlePreparationTiming?): JsonObject =
        requestCaptured(path, "GET", null, query, session, preparationTiming = timing)
    suspend fun get(path: String, query: Map<String,String> = emptyMap(), session: SessionToken? = null) = request(path,query=query,session=session)
    /** A public read that belongs to no identity (M45 §5: stable update rows are public). No cookie is sent and none is
     * accepted, so a restore, sign-in, 401 or sign-out cannot supersede it. Same origin, TLS, headers, contract check and
     * no-redirect policy as every request. Never for account data: those reads stay bound to their session. */
    suspend fun getPublic(path: String): JsonObject = withContext(Dispatchers.IO) {
        require(path.startsWith('/') && !path.startsWith("//") && !path.contains('?') && !path.contains('#') && !path.contains(".."))
        val url = base.newBuilder().encodedPath("/api$path").build()
        require(url.encodedPath.startsWith("/api/")) { "Public path must stay inside the API" }
        val call = connections.newCall(Request.Builder().url(url).build())
        val response = suspendCancellableCoroutine<Response> { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
                override fun onResponse(call: Call, response: Response) {
                    if (continuation.isActive) continuation.resume(response) { _, value, _ -> value.close() } else response.close()
                }
            })
        }
        val cancellation = kotlinx.coroutines.Job(currentCoroutineContext()[kotlinx.coroutines.Job])
        cancellation.invokeOnCompletion { call.cancel() }
        try { response.use {
            val parsed = runCatching { Json.parseToJsonElement(it.body?.string().orEmpty()) as? JsonObject }.getOrNull()
            currentCoroutineContext().ensureActive()
            if (!it.isSuccessful) throw apiFailure(it.code, parsed, it.header("Retry-After"))
            validateResponseContract(path, "GET", parsed ?: throw ApiCompatibilityException(path))
        } } finally { cancellation.cancel() }
    }
    suspend fun post(path: String, body: JsonObject = buildJsonObject {}, session: SessionToken? = null) = request(path,"POST",body,session=session)
    /** Workshop-specific guards never attach gameplay currency headers or replay commands. */
    suspend fun getWorkshop(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                            evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        require(path == "/workshop" || path.matches(Regex("/workshop/jobs/(?:by-key/[^/]+|[0-9a-f-]{36}/collect/by-key/[^/]+)")))
        require(evidence == null || path != "/workshop")
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard, workshopEvidence = evidence)
    }
    suspend fun postWorkshop(path: String, body: JsonObject, session: SessionToken, refusal: ((ApiException) -> Unit)? = null, guard: () -> Unit): JsonObject {
        require(path == "/workshop/jobs" || path.matches(Regex("/workshop/jobs/[0-9a-f-]{36}/collect")))
        return requestCaptured(path, "POST", body, emptyMap(), session, commandGuard = guard, workshopRefusal = refusal)
    }

    /** Current snapshots have no evidence callback; original recovery never carries a current base query. */
    suspend fun getOrdinaryCrafting(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                                    evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        if (path == "/ordinary-crafting") {
            require(query.keys.all { it in setOf("baseId", "catalogueVersion") } && evidence == null)
            query["catalogueVersion"]?.let { require(it == "2") }
            ordinaryCraftingUuid(requireNotNull(query["baseId"]))
        } else {
            val prefix = "/ordinary-crafting/jobs/by-key/"
            require(path.startsWith(prefix) && query.isEmpty() && evidence != null)
            ordinaryCraftingUuid(path.removePrefix(prefix))
        }
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard, ordinaryEvidence = evidence)
    }
    /** One exact unpaid command; both accepted proof and typed refusal retain the original owned response. */
    suspend fun postOrdinaryCrafting(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                                     evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
        require(path == "/ordinary-crafting/jobs")
        strictPrimitives(body, OrdinaryCraftingRequest.serializer().descriptor)
        ordinaryJson.decodeFromJsonElement<OrdinaryCraftingRequest>(body).validate()
        return requestCaptured(path, "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, ordinaryRefusal = refusal)
    }

    /** Current appearance discovery cannot masquerade as an original. Historical recovery
     * retains its bounded proof before stale guards, without changing current selection. */
    suspend fun getBoundCosmetic(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                                 evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        if (path == "/bound-cosmetics" || path == "/bound-cosmetics/wakes/v1/workshop") {
            require(query.keys.all { it == "baseId" } && evidence == null)
            query["baseId"]?.let(::ordinaryCraftingUuid)
        } else if (path == "/bound-cosmetics/wakes/v1/current") {
            require(query.keys == setOf("baseId") && evidence == null)
            ordinaryCraftingUuid(requireNotNull(query["baseId"]))
        } else if (path.startsWith("/bound-cosmetics/wakes/v1/originals/")) {
            require(query.isEmpty() && evidence == null)
            val parts = path.removePrefix("/bound-cosmetics/wakes/v1/originals/").split('/')
            require(parts.size == 2 && parts[0] in setOf("starter", "advanced"))
            ordinaryCraftingUuid(parts[1])
        } else {
            val prefix = "/bound-cosmetics/jobs/by-key/"
            require(path.startsWith(prefix) && query.isEmpty() && evidence != null)
            ordinaryCraftingUuid(path.removePrefix(prefix))
        }
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard,
            ordinaryEvidence = evidence, boundCosmeticResponse = true)
    }
    /** Every attempted failure remains uncertain; there is deliberately no refusal callback. */
    suspend fun postBoundCosmetic(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                                  evidence: (JsonObject) -> Unit): JsonObject {
        require(path == "/bound-cosmetics/jobs" || path == "/bound-cosmetics/wakes/v1/jobs")
        val request = gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticRequest.from(body)
        require((request.recipeId == "craft_aurora_wake_v1") == (path == "/bound-cosmetics/wakes/v1/jobs"))
        return requestCaptured(path, "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, boundCosmeticResponse = true)
    }
    /** Free preference changes still use exact CAS consent and never replay automatically. */
    suspend fun putBoundCosmeticPreference(body: JsonObject, session: SessionToken, guard: () -> Unit): JsonObject {
        gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticPreferenceRequest.from(body)
        return requestCaptured("/bound-cosmetics/awning", "PUT", body, emptyMap(), session,
            commandGuard = guard, boundCosmeticResponse = true)
    }

    /** Account-wide Wake CAS has no selected-base or currency input. */
    suspend fun putBoundCosmeticWakePreference(body: JsonObject, session: SessionToken, guard: () -> Unit): JsonObject {
        gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakePreferenceRequest.from(body)
        return requestCaptured("/bound-cosmetics/wakes/v1/preference", "PUT", body, emptyMap(), session,
            commandGuard = guard, boundCosmeticResponse = true)
    }

    /** Resource commitment uses the existing bounded owned-response drain, never a retry. */
    suspend fun getMiningContribution(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                                     evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        if (path == "/mining/contributions") {
            require(query.keys.all { it in setOf("baseId", "catalogueVersion") } && evidence == null)
            query["catalogueVersion"]?.let { require(it == "3") }
            ordinaryCraftingUuid(requireNotNull(query["baseId"]))
        } else {
            val prefix = "/mining/contributions/by-key/"
            require(path.startsWith(prefix) && query.isEmpty() && evidence != null)
            ordinaryCraftingUuid(path.removePrefix(prefix))
        }
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard, ordinaryEvidence = evidence)
    }
    suspend fun postMiningContribution(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                                      evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
        require(path == "/mining/contributions")
        gg.pixelkingdomwars.nativeclient.miningcontribution.MiningContributionRequest.from(body)
        return requestCaptured(path, "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, ordinaryRefusal = refusal)
    }

    /** Starter commands reuse the bounded original-body drain, with separate exact path/body admission. */
    suspend fun getStarterFleet(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                               evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        if (path == "/starter-fleet") {
            require(query.keys == setOf("baseId") && evidence == null)
            ordinaryCraftingUuid(requireNotNull(query["baseId"]))
        } else {
            val prefix = "/starter-fleet/installations/by-key/"
            require(path.startsWith(prefix) && query.isEmpty() && evidence != null)
            ordinaryCraftingUuid(path.removePrefix(prefix))
        }
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard, ordinaryEvidence = evidence)
    }
    suspend fun postStarterFleet(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                                evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
        require(path == "/starter-fleet/installations")
        strictPrimitives(body, StarterFleetRequest.serializer().descriptor)
        starterJson.decodeFromJsonElement<StarterFleetRequest>(body).validate()
        return requestCaptured(path, "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, ordinaryRefusal = refusal)
    }
    /** Phase E: exact SHARDS purchase path, using the existing bounded evidence drain. */
    suspend fun getFreeBasePurchase(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                                    evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        if (path == "/bases/free-purchases") {
            require(query.keys.all { it == "sourceBaseId" } && evidence == null)
            query["sourceBaseId"]?.let(::ordinaryCraftingUuid)
        } else {
            val prefix = "/bases/free-purchases/by-key/"
            require(path.startsWith(prefix) && query.isEmpty() && evidence != null)
            ordinaryCraftingUuid(path.removePrefix(prefix))
        }
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard, ordinaryEvidence = evidence)
    }
    suspend fun postFreeBasePurchase(body: JsonObject, session: SessionToken, guard: () -> Unit,
                                     evidence: (JsonObject) -> Unit): JsonObject {
        gg.pixelkingdomwars.nativeclient.freebase.FreeBasePurchaseRequest.from(body)
        return requestCaptured("/bases/free-purchases", "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, ordinaryRefusal = {})
    }
    /** Phase E resource claims: exact paths and bounded owned-response retention. */
    suspend fun getSeekerResourceClaim(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                                      evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        if (path == "/seeker/resource-claims") {
            require(query.keys.all { it == "cursor" } && evidence == null); query["cursor"]?.let(::ordinaryCraftingUuid)
        } else {
            val prefix = "/seeker/resource-claims/by-key/"
            require(path.startsWith(prefix) && query.isEmpty() && evidence != null); ordinaryCraftingUuid(path.removePrefix(prefix))
        }
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard, ordinaryEvidence = evidence)
    }
    suspend fun postSeekerResourceClaim(body: JsonObject, session: SessionToken, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject {
        gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimRequest.from(body)
        return requestCaptured("/seeker/resource-claims", "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, ordinaryRefusal = {})
    }
    /** Phase E mining: original callbacks validate and retain owned DTOs before
     * stale session/view rejection. Status is a current read, never evidence. */
    suspend fun getMiningClaim(path: String, session: SessionToken, guard: () -> Unit,
                               evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        val parts=path.split('?',limit=2);val clean=parts[0];var query:Map<String,String> = emptyMap()
        if (clean == "/claims/mining/status") require(evidence == null && parts.size==1)
        else if(clean.endsWith("/review")||clean.endsWith("/continuation")){
            require(clean.startsWith("/claims/mining/")&&evidence!=null);ordinaryCraftingUuid(clean.removePrefix("/claims/mining/").substringBefore('/'))
            val id=clean.removePrefix("/claims/mining/").substringBefore('/');require(clean=="/claims/mining/$id/review"||clean=="/claims/mining/$id/continuation")
            if(clean.endsWith("/review")){require(parts.size==2&&parts[1] in listOf("ordinal=0","ordinal=1"));query=mapOf("ordinal" to parts[1].substringAfter('='))}else require(parts.size==1)
        }else {
            require(parts.size==1)
            val prefix = if (clean.startsWith("/claims/mining/prepare/by-key/")) "/claims/mining/prepare/by-key/" else "/claims/mining/"
            require(clean.startsWith(prefix) && evidence != null);ordinaryCraftingUuid(clean.removePrefix(prefix))
        }
        return requestCaptured(clean, "GET", null, query, session, commandGuard = guard,
            ordinaryEvidence = evidence, miningResponseBound = true).also { guard() }
    }

    suspend fun postMiningClaim(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                                evidence: ((JsonObject) -> Unit)? = null, refusal: ((ApiException) -> Unit)? = null): JsonObject {
        when (path) {
            "/claims/mining/prepare" -> { require(evidence != null); gg.pixelkingdomwars.nativeclient.mining.MiningClaimPrepareRequest.from(body) }
            "/claims/mining/submit" -> { require(refusal == null); gg.pixelkingdomwars.nativeclient.mining.MiningClaimSubmitRequest.from(body) }
            else -> {require(path.startsWith("/claims/mining/")&&path.endsWith("/continue")&&evidence!=null)
                val id=path.removePrefix("/claims/mining/").removeSuffix("/continue");ordinaryCraftingUuid(id);require(body.keys==setOf("idempotencyKey"));ordinaryCraftingUuid(body.getValue("idempotencyKey").jsonPrimitive.content)}
        }
        val originalRefusal: (ApiException) -> Unit = { failure ->
            val expected = when (failure.code) { "INVALID_INPUT" -> 400; "INSUFFICIENT_SOL" -> 422; "CLAIM_ROOT_PENDING", "CLAIM_BLOCKHASH_REUSED" -> 409; "PHASE_E_DISABLED" -> 503; else -> null }
            if(path.endsWith("/continue")){val code=failure.code;val definitive=when(code){"MINING_CLAIM_INVALID_INPUT","MINING_CLAIM_NOT_PREPARED"->400;"MINING_CLAIM_NOT_EXPIRED","MINING_CLAIM_SETUP_REQUIRED","MINING_CLAIM_PARENT_SIGNED","MINING_CLAIM_DISABLED"->409;else->null};if(definitive==failure.status)refusal?.invoke(failure)}
            if (path == "/claims/mining/prepare" && expected == failure.status && failure.message.isNotBlank() && failure.message.length <= 1024) refusal?.invoke(failure)
        }
        return requestCaptured(path, "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, ordinaryRefusal = originalRefusal, miningResponseBound = true).also { guard() }
    }
    /** Phase E realm sales: exact original-key paths, awaited owned evidence, no
     * gameplay currency header or automatic replay. Exact first-prepare refusals
     * are retained by the caller before stale guards; absence is checked separately. */
    suspend fun getRealmSale(path: String, session: SessionToken, guard: () -> Unit,
                             evidence: suspend (JsonObject) -> Unit): JsonObject {
        val prefix = listOf("/seeker/realm-sales/prepare/by-key/", "/seeker/realm-sales/review/by-key/", "/seeker/realm-sales/failures/by-key/", "/seeker/realm-sales/by-key/")
            .singleOrNull { path.startsWith(it) } ?: throw IllegalArgumentException("Unsupported realm-sale request")
        ordinaryCraftingUuid(path.removePrefix(prefix))
        return requestCaptured(path, "GET", null, emptyMap(), session, commandGuard = guard, realmSaleEvidence = evidence).also { guard() }
    }
    suspend fun postRealmSale(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                              refusal: (suspend (RealmSalePrepareRefusal) -> Unit)? = null, evidence: suspend (JsonObject) -> Unit): JsonObject {
        require(refusal == null || path == "/seeker/realm-sales/prepare")
        fun text(name: String): String = requireNotNull((body[name] as? JsonPrimitive)?.takeIf { it.isString }?.content)
        ordinaryCraftingUuid(text("idempotencyKey"))
        when (path) {
            "/seeker/realm-sales/prepare" -> {
                require(body.keys == setOf("idempotencyKey", "spot", "realm"))
                // Technical JSON integer domain only; canonical game policy is
                // injected and enforced by RealmSalesTransport before this boundary.
                for (name in listOf("spot", "realm")) {
                    val value = requireNotNull((body[name] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull)
                    require(value in 0..9_007_199_254_740_991L)
                }
            }
            "/seeker/realm-sales/submit" -> {
                require(body.keys == setOf("idempotencyKey", "signedTransaction"))
                val signed = text("signedTransaction"); require(signed.length in 88..1644 && signed.length % 4 == 0)
                val bytes = java.util.Base64.getDecoder().decode(signed)
                require(bytes.size in 66..1232 && java.util.Base64.getEncoder().encodeToString(bytes) == signed)
            }
            else -> throw IllegalArgumentException("Unsupported realm-sale request")
        }
        // Own the immutable primitive request before the first suspension.
        val frozen = JsonObject(body.toMap())
        return requestCaptured(path, "POST", frozen, emptyMap(), session, commandGuard = guard, realmSaleEvidence = evidence, realmSaleRefusal = refusal).also { guard() }
    }
    suspend fun getStarterExpedition(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                                    evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        if (path == "/starter-expeditions") {
            require(query.keys == setOf("baseId") && evidence == null)
            ordinaryCraftingUuid(requireNotNull(query["baseId"]))
        } else if (path == "/starter-expeditions/paid-route") {
            require(query.keys == setOf("baseId", "realm") && evidence == null)
            gg.pixelkingdomwars.nativeclient.starter.validatePaidStarterSelection(requireNotNull(query["baseId"]), requireNotNull(query["realm"]))
        } else {
            val prefix = "/starter-expeditions/by-key/"
            require(path.startsWith(prefix) && query.isEmpty() && evidence != null)
            ordinaryCraftingUuid(path.removePrefix(prefix))
        }
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard, ordinaryEvidence = evidence)
    }
    suspend fun postStarterExpedition(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                                     evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject =
        postStarterExpeditionWithDeparture(path, body, session, guard, evidence, refusal) {}
    suspend fun postStarterExpeditionWithDeparture(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                                     evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit,
                                     created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture) -> Unit): JsonObject {
        require(path == "/starter-expeditions")
        strictPrimitives(body, StarterExpeditionRequest.serializer().descriptor)
        starterJson.decodeFromJsonElement<StarterExpeditionRequest>(body).validate()
        return requestCaptured(path, "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, ordinaryRefusal = refusal, created = created)
    }

    /** Source recovery has no current-base query; new selection binds the exact reviewed head. */
    suspend fun getHarvester(path: String, query: Map<String, String>, session: SessionToken, guard: () -> Unit,
                             evidence: ((JsonObject) -> Unit)? = null): JsonObject {
        if (path == "/harvesters") {
            require(query.keys == setOf("baseId") && evidence == null)
            ordinaryCraftingUuid(requireNotNull(query["baseId"]))
        } else {
            val prefix = "/harvesters/sources/by-key/"
            require(path.startsWith(prefix) && query.isEmpty() && evidence != null)
            ordinaryCraftingUuid(path.removePrefix(prefix))
        }
        return requestCaptured(path, "GET", null, query, session, commandGuard = guard, ordinaryEvidence = evidence)
    }
    suspend fun postHarvester(path: String, body: JsonObject, session: SessionToken, guard: () -> Unit,
                              evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
        require(path == "/harvesters/sources")
        strictPrimitives(body, HarvesterRequest.serializer().descriptor)
        harvesterJson.decodeFromJsonElement<HarvesterRequest>(body).validate()
        return requestCaptured(path, "POST", body, emptyMap(), session, commandGuard = guard,
            ordinaryEvidence = evidence, ordinaryRefusal = refusal)
    }

    /** Explicit opt-in after a Gems-aware consent. Never attach a global header: legacy screens
     * still show KEEP and historical requests must retain their original semantics. The server
     * may debit the complete fallback currency; the consent must disclose both possibilities. */
    suspend fun postGameCurrency(path: String, body: JsonObject, consent: gg.pixelkingdomwars.nativeclient.model.GameCurrencyConsent,
                                 session: SessionToken? = null): JsonObject =
        requestCaptured(path, "POST", body, emptyMap(), session ?: boundSession(), gameCurrency = consent.preferred)

    /** Only an admitted command's immutable consent opts in; ordinary requests retain their old semantics. */
    suspend fun postExactGameCurrency(path: String, body: JsonObject, currency: gg.pixelkingdomwars.nativeclient.model.GameCurrency,
                                     session: SessionToken? = null, requireCurrent: () -> Unit = {}): JsonObject =
        requestCaptured(path, "POST", body, emptyMap(), session ?: boundSession(), expectedCurrency = currency, commandGuard = requireCurrent)

    /** Durable Hero/Gems/research/paid training/builder commands only. Ordinary POSTs cannot observe evidence. */
    suspend fun postMoneyCommand(path: String, body: JsonObject, currency: gg.pixelkingdomwars.nativeclient.model.GameCurrency?,
                                 session: SessionToken, refusal: (ApiException) -> Unit, guard: () -> Unit): JsonObject {
        val exact = path in setOf("/army/research/speedup", "/army/train/speedup") || path.matches(Regex("/heroes/[a-z][a-z0-9_]*/(?:upgrade|recovery/speedup)")) ||
            path.matches(Regex("/base/jobs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/speedup"))
        require(if (exact) currency != null else currency == null && (path in setOf("/gems/from-keep", "/gems/to-shards", "/heroes/recruit/v1") ||
            path.matches(Regex("/gems/tasks/[a-z0-9_-]{1,64}/claim"))))
        return requestCaptured(path, "POST", body, emptyMap(), session, expectedCurrency = currency, commandGuard = guard, moneyRefusal = refusal)
    }

    /** Only the coordinator's exact command endpoint can opt in. Creation, reads and other writes
     * retain the ordinary transport; an observer failure never blocks or retries the actual order. */
    internal suspend fun postBattle(path: String, body: JsonObject, session: SessionToken, timing: BattleCommandTiming?): JsonObject {
        val observer = if (timing != null && RAID_COMMAND_PATH.matches(path))
            body.string("clientCommandId")?.let { runCatching { timing.transport(it) }.getOrNull() } else null
        return requestCaptured(path, "POST", body, emptyMap(), session, commandTiming = observer)
    }
    /** Raw avatar/feedback bytes use the same cookie, origin and no-replay policy as JSON writes.
     * Freeze the input before suspension; caller-owned buffers cannot change an in-flight upload. */
    suspend fun upload(path: String, method: String, bytes: ByteArray, contentType: String, session: SessionToken): JsonObject {
        require(method == "POST" || method == "PATCH") { "Unsupported upload method" }
        require(contentType in setOf("image/png", "image/jpeg", "image/webp")) { "Unsupported image type" }
        val frozen = bytes.copyOf().toRequestBody(contentType.toMediaType())
        return requestCaptured(path, method, null, emptyMap(), session, binaryBody = frozen)
    }
    /** Authenticated image reads retain the captured identity through headers and the complete bounded
     * body. No redirect, image cache, cookie borrowed from another account, or grant is allowed. */
    suspend fun download(path: String, contentType: String, maxBytes: Int, session: SessionToken): ByteArray {
        require(maxBytes > 0 && contentType in setOf("image/webp", "image/png", "image/jpeg"))
        require(path.startsWith('/') && !path.startsWith("//") && !path.contains('?') && !path.contains('#') && !path.contains(".."))
        jar.requireCurrent(session)
        try {
            val bytes = withContext(Dispatchers.IO) {
                val url = base.newBuilder().encodedPath("/api$path").build()
                require(url.encodedPath.startsWith("/api/")) { "Image path must stay inside the API" }
                val cookies = jar.requestCookies(session, url); jar.requireCurrent(session)
                val request = Request.Builder().url(url).header("Accept", contentType)
                    .cacheControl(CacheControl.Builder().noCache().noStore().build())
                if (cookies.isNotEmpty()) request.header("Cookie", cookies.joinToString("; ") { "${it.name}=${it.value}" })
                val call = connections.newCall(request.build())
                val response = suspendCancellableCoroutine<Response> { continuation ->
                    continuation.invokeOnCancellation { call.cancel() }
                    call.enqueue(object : Callback {
                        override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
                        override fun onResponse(call: Call, response: Response) {
                            if (continuation.isActive) continuation.resume(response) { _, value, _ -> value.close() } else response.close()
                        }
                    })
                }
                val cancellation = kotlinx.coroutines.Job(currentCoroutineContext()[kotlinx.coroutines.Job])
                cancellation.invokeOnCompletion { call.cancel() }
                try { response.use {
                    currentCoroutineContext().ensureActive(); jar.requireCurrent(session)
                    val body = it.body ?: throw ApiCompatibilityException(path)
                    if (body.contentLength() > maxBytes) throw ApiCompatibilityException(path)
                    if (it.isSuccessful && body.contentType()?.let { type -> "${type.type}/${type.subtype}" } != contentType) throw ApiCompatibilityException(path)
                    val context = currentCoroutineContext()
                    val result = body.byteStream().use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        while (true) {
                            context.ensureActive(); jar.requireCurrent(session)
                            val count = input.read(buffer)
                            if (count < 0) break
                            if (count > maxBytes - output.size()) throw ApiCompatibilityException(path)
                            output.write(buffer, 0, count)
                        }
                        output.toByteArray()
                    }
                    context.ensureActive(); jar.requireCurrent(session)
                    jar.acceptResponse(session, it.request.url, Cookie.parseAll(it.request.url, it.headers))
                    if (!it.isSuccessful) {
                        val parsed = runCatching { Json.parseToJsonElement(result.toString(Charsets.UTF_8)) as? JsonObject }.getOrNull()
                        throw apiFailure(it.code, parsed, it.header("Retry-After"), session)
                    }
                    if (result.isEmpty()) throw ApiCompatibilityException(path)
                    result
                } } finally { cancellation.cancel() }
            }
            jar.requireCurrent(session); return bytes
        } catch (error: Exception) { currentCoroutineContext().ensureActive(); jar.requireCurrent(session); throw error }
    }
    /** A one-action grant stays on this request, never on the shared client, cookies or durable intent.
     * Callers keep it in memory and bind it to the session that obtained the wallet proof. */
    suspend fun postWithRecentAuth(path: String, body: JsonObject, grant: String, session: SessionToken): JsonObject {
        require(grant.isNotBlank() && grant.all { it.code in 33..126 }) { "Invalid recent authentication grant" }
        return requestCaptured(path, "POST", body, emptyMap(), session, recentAuth = grant)
    }
    suspend fun logout(session: SessionToken? = null) {
        val captured=session ?: boundSession().let { jar.beginLogout(it) }
        check(jar.isLogout(captured)) { "Begin sign-out before using its session token" }
        try {
            val cookies=withContext(Dispatchers.IO) { jar.detachLogoutCookies(captured,base.resolve("/api/auth/logout")!!) }
            requestCaptured("/auth/logout","POST",buildJsonObject {},emptyMap(),captured,cookies)
        } finally { withContext(kotlinx.coroutines.NonCancellable+Dispatchers.IO) { jar.finishLogout(captured) } }
    }
    /** `GET /bases/:id/raid-events` as decoded frames; the response is closed when the collector leaves. Bound
     * to [session] like every request: a superseded identity fails before the handshake. */
    fun raidEvents(path: String, baseId: String, session: SessionToken? = null): kotlinx.coroutines.flow.Flow<RaidEventFrame> = kotlinx.coroutines.flow.flow {
        val (response, call) = openStream(path, session)
        // The handshake continuation has finished: retain cancellation ownership while a body read blocks,
        // so leaving Home or switching identity closes the socket immediately instead of waiting 45 seconds.
        val cancellation = kotlinx.coroutines.Job(currentCoroutineContext()[kotlinx.coroutines.Job])
        cancellation.invokeOnCompletion { call.cancel() }
        try { emitAll(raidEventFrames(response.body!!.source(), baseId)) }
        catch (error: IOException) { currentCoroutineContext().ensureActive(); throw error }
        finally { cancellation.cancel(); response.close() }
    }
    private suspend fun openStream(path: String, session: SessionToken?): Pair<Response, Call> {
        val captured = session ?: boundSession()
        jar.requireCurrent(captured)
        return withContext(Dispatchers.IO) {
            require(path.startsWith('/') && !path.startsWith("//") && !path.contains('?') && !path.contains('#') && !path.contains(".."))
            val url = base.newBuilder().encodedPath("/api$path").build()
            val cookies = jar.requestCookies(captured, url)
            jar.requireCurrent(captured)
            val request = Request.Builder().url(url).header("Accept", "text/event-stream")
            if (cookies.isNotEmpty()) request.header("Cookie", cookies.joinToString("; ") { "${it.name}=${it.value}" })
            val call = streams.newCall(request.build())
            val response = suspendCancellableCoroutine<Response> { continuation ->
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
                    override fun onResponse(call: Call, response: Response) {
                        if (continuation.isActive) continuation.resume(response) { _, value, _ -> value.close() } else response.close()
                    }
                })
            }
            try {
                jar.acceptResponse(captured, response.request.url, Cookie.parseAll(response.request.url, response.headers))
                if (!response.isSuccessful) {
                    val parsed = runCatching { Json.parseToJsonElement(response.body?.string().orEmpty()) as? JsonObject }.getOrNull()
                    throw apiFailure(response.code, parsed, response.header("Retry-After"), captured)
                }
                if (!response.header("Content-Type")?.substringBefore(';')?.trim().equals("text/event-stream", ignoreCase = true) || response.body == null)
                    throw ApiException(0, RAID_EVENTS_INVALID, "Live raid updates were interrupted.")
                jar.requireCurrent(captured)
                response to call
            } catch (error: Exception) { response.close(); throw error }
        }
    }
    fun forgetLocalSession() = jar.clear()
    fun forgetLocalSession(session: SessionToken): Boolean = jar.clearIfCurrent(session)
}
