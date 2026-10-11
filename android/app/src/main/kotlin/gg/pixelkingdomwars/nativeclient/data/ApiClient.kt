package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.realmsales.RealmSalePrepareRefusal
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SessionToken
import gg.pixelkingdomwars.nativeclient.ops.OpTransport
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

/** The one transport surface repositories see; fakes replace it in tests. */
interface ApiClient {
    suspend fun get(path: String, query: Map<String, String> = emptyMap()): JsonObject
    suspend fun post(path: String, body: JsonObject = buildJsonObject {}): JsonObject
    suspend fun getWorkshop(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Workshop transport is unavailable")
    suspend fun postWorkshop(path: String, body: JsonObject, refusal: ((ApiException) -> Unit)? = null, guard: () -> Unit): JsonObject =
        throw UnsupportedOperationException("Workshop transport is unavailable")
    /** Scoped ordinary crafting transport; history requires original evidence retention, never generic fallback. */
    suspend fun getOrdinaryCrafting(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Ordinary crafting transport is unavailable")
    suspend fun postOrdinaryCrafting(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject =
        throw UnsupportedOperationException("Ordinary crafting transport is unavailable")
    /** Original appearances retain proof before stale guards; attempted errors never retire a key. */
    suspend fun getBoundCosmetic(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Appearance transport is unavailable")
    suspend fun postBoundCosmetic(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject =
        throw UnsupportedOperationException("Appearance transport is unavailable")
    suspend fun putBoundCosmeticPreference(body: JsonObject, guard: () -> Unit): JsonObject =
        throw UnsupportedOperationException("Appearance preferences are unavailable")
    suspend fun putBoundCosmeticWakePreference(body: JsonObject, guard: () -> Unit): JsonObject =
        throw UnsupportedOperationException("Wake preferences are unavailable")
    suspend fun getMiningContribution(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Mining contribution transport is unavailable")
    suspend fun postMiningContribution(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject =
        throw UnsupportedOperationException("Mining contribution transport is unavailable")
    suspend fun getStarterFleet(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Starter fleet transport is unavailable")
    suspend fun postStarterFleet(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject =
        throw UnsupportedOperationException("Starter fleet transport is unavailable")
    /** Phase E: original purchase evidence uses its own bounded transport. */
    suspend fun getFreeBasePurchase(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Free base purchase transport is unavailable")
    suspend fun postFreeBasePurchase(body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject =
        throw UnsupportedOperationException("Free base purchase transport is unavailable")
    /** Phase E: original-resource claims use exact scoped evidence transport. */
    suspend fun getSeekerResourceClaim(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Seeker resource transport is unavailable")
    suspend fun postSeekerResourceClaim(body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject =
        throw UnsupportedOperationException("Seeker resource transport is unavailable")
    /** Mining status has no evidence callback; saved request recovery must retain its owned response. */
    suspend fun getMiningClaim(path: String, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Mining claim transport is unavailable")
    suspend fun postMiningClaim(path: String, body: JsonObject, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null,
                                refusal: ((ApiException) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Mining claim transport is unavailable")
    /** Realm-sale encrypted retention suspends and must drain before stale guards. */
    suspend fun getRealmSale(path: String, guard: () -> Unit, evidence: suspend (JsonObject) -> Unit): JsonObject =
        throw UnsupportedOperationException("Realm-sale transport is unavailable")
    suspend fun postRealmSale(path: String, body: JsonObject, guard: () -> Unit, refusal: (suspend (RealmSalePrepareRefusal) -> Unit)? = null, evidence: suspend (JsonObject) -> Unit): JsonObject =
        throw UnsupportedOperationException("Realm-sale transport is unavailable")
    suspend fun getStarterExpedition(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Starter expedition transport is unavailable")
    suspend fun postStarterExpedition(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject =
        throw UnsupportedOperationException("Starter expedition transport is unavailable")
    /** Older adapters provide no creation metadata; body-only success never animates. */
    suspend fun postStarterExpeditionWithDeparture(path: String, body: JsonObject, guard: () -> Unit,
        evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit,
        created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture) -> Unit): JsonObject =
        postStarterExpedition(path, body, guard, evidence, refusal)
    suspend fun getHarvester(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)? = null): JsonObject =
        throw UnsupportedOperationException("Harvester transport is unavailable")
    suspend fun postHarvester(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject =
        throw UnsupportedOperationException("Harvester transport is unavailable")
    /** Exact paid-command consent is opt-in and never silently degrades to ordinary POST. */
    suspend fun postExactGameCurrency(path: String, body: JsonObject, currency: gg.pixelkingdomwars.nativeclient.model.GameCurrency, requireCurrent: () -> Unit = {}): JsonObject =
        throw UnsupportedOperationException("Exact currency commands are unavailable")
    /** Original HTTP evidence is restricted to durable Hero/Gems commands. No ordinary POST fallback. */
    suspend fun postMoneyCommand(path: String, body: JsonObject, currency: gg.pixelkingdomwars.nativeclient.model.GameCurrency?,
                                 refusal: (ApiException) -> Unit, guard: () -> Unit): JsonObject =
        throw UnsupportedOperationException("Durable money command transport is unavailable")
    /** Ephemeral wallet/TOTP authorization is deliberately outside [OpTransport] and saved intents. */
    suspend fun postWithRecentAuth(path: String, body: JsonObject, grant: String): JsonObject =
        throw UnsupportedOperationException("Recent authentication is unavailable")
    /** Layout, army-preset and equipment writes; like every mutation, never automatically replayed. */
    suspend fun put(path: String, body: JsonObject = buildJsonObject {}): JsonObject
    suspend fun patch(path: String, body: JsonObject): JsonObject =
        throw UnsupportedOperationException("Profile updates are unavailable")
    suspend fun upload(path: String, method: String, bytes: ByteArray, contentType: String): JsonObject =
        throw UnsupportedOperationException("Image upload is unavailable")
    suspend fun download(path: String, contentType: String, maxBytes: Int): ByteArray =
        throw UnsupportedOperationException("Image download is unavailable")
    suspend fun delete(path: String): JsonObject
    suspend fun delete(path: String, body: JsonObject): JsonObject =
        throw UnsupportedOperationException("This DELETE request is unavailable")
    fun asTransport(): OpTransport = object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = this@ApiClient.get(path, query)
        override suspend fun post(path: String, body: JsonObject) = this@ApiClient.post(path, body)
    }
}

/** Where a failed request sends the player. Mirrors the web's global handlers (`lib/api.ts`). */
sealed interface RoutingEvent {
    data object SessionExpired : RoutingEvent
    data object LandRequired : RoutingEvent
    data object AlphaGated : RoutingEvent
    data class UpdateRequired(val code: String?, val message: String) : RoutingEvent
    data class Maintenance(val retryAfterSeconds: Long?, val message: String) : RoutingEvent
    data class InsufficientFunds(val code: String, val message: String) : RoutingEvent
    data class Incompatible(val route: String) : RoutingEvent
    /** Web `BASE_SELECTION_ERROR_CODES` → `recoverBaseAuthority`: the selected deed's authority is gone or unverifiable. */
    data class BaseAuthority(val code: String, val message: String) : RoutingEvent {
        /** `DEED_AUTHORITY_UNAVAILABLE` only asks for a retry; every other code sends the player to choose a base. */
        val transient: Boolean get() = code == DEED_AUTHORITY_UNAVAILABLE
        companion object {
            const val BASE_CLIENT_UPGRADE_REQUIRED = "BASE_CLIENT_UPGRADE_REQUIRED"
            const val DEED_AUTHORITY_UNAVAILABLE = "DEED_AUTHORITY_UNAVAILABLE"
            val CODES = setOf(BASE_CLIENT_UPGRADE_REQUIRED, "BASE_NOT_OWNED", "DEED_OWNERSHIP_CHANGED", DEED_AUTHORITY_UNAVAILABLE)
        }
    }
}

/** One classifier for every response. Repositories report; the navigation host listens. */
class ApiRouting {
    private val _events = MutableSharedFlow<RoutingEvent>(extraBufferCapacity = 16)
    val events: SharedFlow<RoutingEvent> = _events.asSharedFlow()

    fun report(error: Throwable): RoutingEvent? = classify(error)?.also { _events.tryEmit(it) }

    companion object {
        /** Web `ui/actionError.ts isHandledGlobally`: a refusal that another surface is already explaining
         * (the land gate for `LAND_NOT_OWNED`; on native also the funds sheet for `INSUFFICIENT_*`, APP_SHELL
         * "Global API routing") must not fire a second, quieter refusal under it. */
        fun handledGlobally(error: Throwable): Boolean = classify(error).let { it is RoutingEvent.LandRequired || it is RoutingEvent.InsufficientFunds }
        fun classify(error: Throwable): RoutingEvent? = when (error) {
            is ApiCompatibilityException -> RoutingEvent.Incompatible(error.route)
            is ApiException -> when {
                error.status == 401 -> RoutingEvent.SessionExpired
                error.status == 402 && error.code == "LAND_NOT_OWNED" -> RoutingEvent.LandRequired
                error.status == 403 && error.code == "ALPHA_GATED" -> RoutingEvent.AlphaGated
                // A base-selection 426 is an explicit-selection demand, not a stale bundle (web `throwResponseError`).
                error.code in RoutingEvent.BaseAuthority.CODES -> RoutingEvent.BaseAuthority(requireNotNull(error.code), error.message)
                error.status == 426 -> RoutingEvent.UpdateRequired(error.code, error.message)
                error.status == 503 && error.code == "MAINTENANCE" -> RoutingEvent.Maintenance(error.retryAfterSeconds, error.message)
                error.code?.startsWith("INSUFFICIENT_") == true -> RoutingEvent.InsufficientFunds(requireNotNull(error.code), error.message)
                else -> null
            }
            else -> null
        }
    }
}

/** Binds every request to one session token: a superseded identity fails at the transport, so a
 * late response can never be published into a newer account. Null binds to whatever is current
 * (used only before sign-in completes). */
class SessionApiClient(private val api: GameApi, private val token: SessionToken?, private val routing: ApiRouting) : ApiClient {
    override suspend fun get(path: String, query: Map<String, String>): JsonObject = routed { api.get(path, query, session = token) }
    override suspend fun post(path: String, body: JsonObject): JsonObject = routed { api.post(path, body, session = token) }
    override suspend fun getWorkshop(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getWorkshop(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postWorkshop(path: String, body: JsonObject, refusal: ((ApiException) -> Unit)?, guard: () -> Unit): JsonObject = routed {
        api.postWorkshop(path, body, requireNotNull(token), refusal, guard)
    }
    override suspend fun getOrdinaryCrafting(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getOrdinaryCrafting(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postOrdinaryCrafting(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject = routed {
        api.postOrdinaryCrafting(path, body, requireNotNull(token), guard, evidence, refusal)
    }
    override suspend fun getBoundCosmetic(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getBoundCosmetic(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postBoundCosmetic(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject = routed {
        api.postBoundCosmetic(path, body, requireNotNull(token), guard, evidence)
    }
    override suspend fun putBoundCosmeticPreference(body: JsonObject, guard: () -> Unit): JsonObject = routed {
        api.putBoundCosmeticPreference(body, requireNotNull(token), guard)
    }
    override suspend fun putBoundCosmeticWakePreference(body: JsonObject, guard: () -> Unit): JsonObject = routed {
        api.putBoundCosmeticWakePreference(body, requireNotNull(token), guard)
    }
    override suspend fun getMiningContribution(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getMiningContribution(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postMiningContribution(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject = routed {
        api.postMiningContribution(path, body, requireNotNull(token), guard, evidence, refusal)
    }
    override suspend fun getStarterFleet(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getStarterFleet(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postStarterFleet(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject = routed {
        api.postStarterFleet(path, body, requireNotNull(token), guard, evidence, refusal)
    }
    override suspend fun getSeekerResourceClaim(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getSeekerResourceClaim(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postSeekerResourceClaim(body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject = routed {
        api.postSeekerResourceClaim(body, requireNotNull(token), guard, evidence)
    }
    override suspend fun getFreeBasePurchase(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getFreeBasePurchase(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postFreeBasePurchase(body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject = routed {
        api.postFreeBasePurchase(body, requireNotNull(token), guard, evidence)
    }
    override suspend fun getMiningClaim(path: String, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getMiningClaim(path, requireNotNull(token), guard, evidence)
    }
    override suspend fun postMiningClaim(path: String, body: JsonObject, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?, refusal: ((ApiException) -> Unit)?): JsonObject = routed {
        api.postMiningClaim(path, body, requireNotNull(token), guard, evidence, refusal)
    }
    override suspend fun getRealmSale(path: String, guard: () -> Unit, evidence: suspend (JsonObject) -> Unit): JsonObject = routed {
        api.getRealmSale(path, requireNotNull(token), guard, evidence)
    }
    override suspend fun postRealmSale(path: String, body: JsonObject, guard: () -> Unit, refusal: (suspend (RealmSalePrepareRefusal) -> Unit)?, evidence: suspend (JsonObject) -> Unit): JsonObject = routed {
        api.postRealmSale(path, body, requireNotNull(token), guard, refusal, evidence)
    }
    override suspend fun getStarterExpedition(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getStarterExpedition(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postStarterExpedition(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject = routed {
        api.postStarterExpedition(path, body, requireNotNull(token), guard, evidence, refusal)
    }
    override suspend fun postStarterExpeditionWithDeparture(path: String, body: JsonObject, guard: () -> Unit,
        evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit,
        created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture) -> Unit): JsonObject = routed {
        api.postStarterExpeditionWithDeparture(path, body, requireNotNull(token), guard, evidence, refusal, created)
    }
    override suspend fun getHarvester(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject = routed {
        api.getHarvester(path, query, requireNotNull(token), guard, evidence)
    }
    override suspend fun postHarvester(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject = routed {
        api.postHarvester(path, body, requireNotNull(token), guard, evidence, refusal)
    }
    override suspend fun postExactGameCurrency(path: String, body: JsonObject, currency: gg.pixelkingdomwars.nativeclient.model.GameCurrency, requireCurrent: () -> Unit): JsonObject = routed {
        api.postExactGameCurrency(path, body, currency, requireNotNull(token) { "Sign in before paying." }, requireCurrent)
    }
    override suspend fun postMoneyCommand(path: String, body: JsonObject, currency: gg.pixelkingdomwars.nativeclient.model.GameCurrency?,
                                          refusal: (ApiException) -> Unit, guard: () -> Unit): JsonObject = routed {
        api.postMoneyCommand(path, body, currency, requireNotNull(token), refusal, guard)
    }
    override suspend fun postWithRecentAuth(path: String, body: JsonObject, grant: String): JsonObject = routed {
        api.postWithRecentAuth(path, body, grant, requireNotNull(token) { "Sign in before confirming this action" })
    }
    override suspend fun put(path: String, body: JsonObject): JsonObject = routed { api.request(path, "PUT", body, session = token) }
    override suspend fun patch(path: String, body: JsonObject): JsonObject = routed { api.request(path, "PATCH", body, session = token) }
    override suspend fun upload(path: String, method: String, bytes: ByteArray, contentType: String): JsonObject = routed {
        api.upload(path, method, bytes, contentType, requireNotNull(token) { "Sign in before uploading an image" })
    }
    override suspend fun download(path: String, contentType: String, maxBytes: Int): ByteArray = routed {
        api.download(path, contentType, maxBytes, requireNotNull(token) { "Sign in before loading this image" })
    }
    override suspend fun delete(path: String): JsonObject = routed { api.request(path, "DELETE", session = token) }
    override suspend fun delete(path: String, body: JsonObject): JsonObject = routed { api.request(path, "DELETE", body, session = token) }
    private inline fun <T> routed(block: () -> T): T = try { block() } catch (error: Exception) { routing.report(error); throw error }
}
