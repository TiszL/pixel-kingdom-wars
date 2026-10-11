package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** Only server-authored originals are cached. No local admission intent,
 * signature, blockhash, template, reservation or cancellation exists here. */
class VehicleCraftStore(private val secret: SecretStore, val identity: StarterIdentity) {
    companion object {
        private val locks = mutableMapOf<StarterIdentity, Mutex>()
        @Synchronized private fun lock(identity: StarterIdentity) = locks.getOrPut(identity) { Mutex() }
    }
    private val mutex = lock(identity)
    init { identity.validate(); require(identity.origin.startsWith("https://")) }
    private fun snapshot(): List<JsonObject> {
        val text = secret.read() ?: return emptyList(); require(text.length <= 2 * 1024 * 1024)
        val v = Json.parseToJsonElement(text).jsonObject
        require(v.keys == setOf("version", "origin", "cluster", "wallet", "records") && CharterGrammar.number(v.getValue("version")) == 1L)
        require(v.charterText("origin") == identity.origin && v.charterText("cluster") == identity.cluster && v.charterText("wallet") == identity.wallet)
        return validate(v.getValue("records").jsonArray.map { it.jsonObject })
    }
    private fun validate(rows: List<JsonObject>): List<JsonObject> {
        require(rows.size <= 512)
        val values = rows.map { VehicleCraftProtocol.record(it).also { v -> require(v.charterText("wallet") == identity.wallet) } }
        for (k in listOf("idempotencyKey", "reservationId", "rootId", "attemptId")) require(values.map { it[k] }.distinct().size == values.size)
        return values
    }
    suspend fun read() = mutex.withLock { snapshot() }
    suspend fun accept(rows: List<JsonObject>) = withContext(NonCancellable) { mutex.withLock {
        val old = snapshot(); val incoming = validate(rows); val merged = old.associateBy { it.charterText("idempotencyKey") }.toMutableMap()
        incoming.forEach { next ->
            val key = next.charterText("idempotencyKey"); merged[key]?.let { prior ->
                require(VehicleCraftProtocol.original(prior) == VehicleCraftProtocol.original(next)) { "Original crafting terms changed; saved history was preserved." }
                val status = prior.charterText("status")
                require(status == "held" || status == next.charterText("status") || status == "won_unminted" && next.charterText("status") == "minted") { "Crafting outcome contradicted saved history." }
                for (k in listOf("consumedAt", "mintedAt")) if (prior[k] != JsonNull) require(prior[k] == next[k])
            }; merged[key] = next
        }
        val records = validate(merged.values.toList())
        val text = buildJsonObject { put("version", 1); put("origin", identity.origin); put("cluster", identity.cluster); put("wallet", identity.wallet); put("records", JsonArray(records)) }.toString()
        require(text.length <= 2 * 1024 * 1024); secret.write(text); Unit
    } }
}

data class VehicleCraftSelection(val baseId: String, val family: String, val tier: Long) {
    fun request() = buildJsonObject { put("baseId", baseId); put("family", family); put("tier", tier); put("recipeVersion", 1) }.also(VehicleCraftProtocol::request)
}
data class VehicleCraftState(val loaded: Boolean = false, val busy: Boolean = false, val selection: VehicleCraftSelection? = null,
    val quote: JsonObject? = null, val records: List<JsonObject> = emptyList(), val nextCursor: String? = null, val error: String? = null)

class VehicleCraftRepository(private val store: VehicleCraftStore, private val ports: VehiclePorts) {
    private val mutable = MutableStateFlow(VehicleCraftState()); val state = mutable.asStateFlow()
    private val requests = Mutex(); private var epoch = 0L
    init { require(store.identity == ports.transport.identity) }
    fun select(selection: VehicleCraftSelection?) { if (selection != state.value.selection) { epoch++; mutable.value = state.value.copy(selection = selection, quote = null) } }
    fun dismiss() { epoch++; mutable.value = state.value.copy(quote = null) }
    private suspend fun action(run: suspend (()->Unit) -> Unit) {
        val captured = ports.capture(false); val ownEpoch = epoch
        val guard = { captured(); check(ownEpoch == epoch) { "The crafting view changed. Original history remains saved." } }
        guard(); check(requests.tryLock()) { "A crafting check is already in progress." }
        try {
            mutable.value = state.value.copy(busy = true, error = null)
            val cached = store.read(); guard(); mutable.value = state.value.copy(loaded = true, records = cached)
            run(guard)
            val updated = store.read(); guard(); mutable.value = state.value.copy(records = updated)
        } catch (e: Exception) {
            if (runCatching { guard() }.isSuccess) mutable.value = state.value.copy(error = e.message ?: "Crafting history is unavailable. Saved originals were preserved.")
            throw e
        } finally { requests.unlock(); mutable.value = state.value.copy(busy = false) }
    }
    suspend fun history(cursor: String? = null) = action { guard ->
        ports.transport.request("GET", "/vehicles/craft/history", guard = guard, query = cursor?.let { mapOf("cursor" to it) } ?: emptyMap()) { raw ->
            val page = VehicleCraftProtocol.history(raw); require(page.charterText("wallet") == store.identity.wallet)
            store.accept(page.getValue("items").jsonArray.map { it.jsonObject })
            guard(); mutable.value = state.value.copy(nextCursor = page["nextCursor"]?.takeUnless { it == JsonNull }?.let(CharterGrammar::text))
        }
    }
    suspend fun quote() = action { guard ->
        val selected = requireNotNull(state.value.selection) { "Select a kingdom and vehicle first." }
        mutable.value = state.value.copy(quote = null)
        ports.hydrate(guard); guard(); ports.requireOwnedBase(selected.baseId)
        ports.transport.request("POST", "/vehicles/craft/quote", selected.request(), guard) { raw ->
            val quote = VehicleCraftProtocol.quote(raw); require(quote.charterText("wallet") == store.identity.wallet && quote.charterText("baseId") == selected.baseId)
            val recipe = quote.charterObject("recipe"); require(recipe.charterText("family") == selected.family && CharterGrammar.number(recipe.getValue("tier")) == selected.tier)
            guard(); mutable.value = state.value.copy(quote = quote)
        }
    }
    suspend fun recover(key: String) = action { guard ->
        CharterGrammar.id(JsonPrimitive(key)); require(state.value.records.any { it.charterText("idempotencyKey") == key })
        ports.transport.request("POST", "/vehicles/craft/by-key/$key/recover", buildJsonObject {}, guard) { raw ->
            val result = VehicleCraftProtocol.recovery(raw); require(result.charterText("wallet") == store.identity.wallet && result.charterText("idempotencyKey") == key)
            store.accept(listOf(result.charterObject("record"))); guard()
            if (result.charterText("status") == "held") mutable.value = state.value.copy(error = "The original outcome could not be verified. Its saved materials and last confirmed status are preserved.")
        }
    }
}
