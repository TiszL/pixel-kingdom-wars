package gg.pixelkingdomwars.nativeclient.realmsales

import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.Base64
import kotlinx.serialization.json.*

/** An application adapter must bind this port to one authenticated session and
 * drain each owned success or prepare refusal through suspend retain BEFORE checking a changed
 * session/view or delivering cancellation. No retries or generic API fallback.
 * This interface itself provides no HTTP implementation or live authority. */
interface RealmSalesAuthenticatedPort {
    val identity: StarterIdentity
    suspend fun request(method: String, path: String, body: JsonObject?, guard: () -> Unit,
        refusal: (suspend (RealmSalePrepareRefusal) -> Unit)? = null, retain: suspend (JsonObject) -> Unit): JsonObject
}

/** Exact endpoint/actor/key boundary. Nested saved evidence is deliberately left
 * to its durable owner so malformed wire data cannot suppress a positive hold. */
class RealmSalesTransport(private val port: RealmSalesAuthenticatedPort) {
    val identity = port.identity.copy().also { it.validate(); require(it.origin.startsWith("https://")) }
    private fun key(value: String) {
        require(value.length == 36 && (value.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
            value == "00000000-0000-0000-0000-000000000000" || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"))
    }
    /** Exact outer scope is mandatory even for malformed adjacent evidence. */
    fun attributeOwner(raw: JsonObject, id: String) {
        key(id)
        fun text(name: String) = (raw[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
        require(text("wallet") == identity.wallet && text("idempotencyKey") == id)
    }
    fun attribute(raw: JsonObject, id: String, submitted: Boolean) {
        key(id)
        val required = if (submitted) setOf("wallet", "idempotencyKey", "wire", "settlement", "delivery") else setOf("wallet", "idempotencyKey", "preparation", "wire", "settlement")
        val allowed = required + if (submitted) setOf("reason", "reconciliation") else emptySet()
        require(raw.keys.containsAll(required) && allowed.containsAll(raw.keys))
        fun text(name: String) = (raw[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
        require(text("wallet") == identity.wallet && text("idempotencyKey") == id)
        if (submitted) require(text("delivery") in setOf("held", "submitted", "settled"))
    }
    private suspend fun call(method: String, path: String, body: JsonObject?, guard: () -> Unit, refusal: (suspend (RealmSalePrepareRefusal) -> Unit)? = null, retain: suspend (JsonObject) -> Unit): JsonObject {
        guard(); check(port.identity == identity)
        val value = port.request(method, path, body, guard, refusal, retain)
        retain(value); guard(); return value
    }
    suspend fun preparation(request: RealmSalePrepareRequest, policy: RealmSalesProtocolPolicy, post: Boolean,
        guard: () -> Unit, refusal: (suspend (RealmSalePrepareRefusal) -> Unit)? = null,
        observe: (suspend () -> Unit)? = null, retain: suspend (RealmSalePreparationEnvelope) -> Unit) {
        require(post || refusal == null)
        request.validate(policy)
        val body = if (post) buildJsonObject { put("idempotencyKey", request.idempotencyKey); put("spot", request.spot); put("realm", request.realm) } else null
        call(if (post) "POST" else "GET", if (post) "/seeker/realm-sales/prepare" else "/seeker/realm-sales/prepare/by-key/${request.idempotencyKey}", body, guard, refusal) { raw ->
            require(raw.keys == setOf("wallet", "idempotencyKey", "preparation"))
            fun text(name: String) = (raw[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
            require(text("wallet") == identity.wallet && text("idempotencyKey") == request.idempotencyKey)
            if (raw.getValue("preparation") != JsonNull) observe?.invoke()
            val value = RealmSalePreparationEnvelope.from(raw, policy)
            require(value.wallet == identity.wallet && value.idempotencyKey == request.idempotencyKey)
            value.preparation?.let { require(it.spot == request.spot && it.realm == request.realm) }
            if (post) require(value.preparation != null)
            retain(value)
        }
    }
    suspend fun saved(id: String, guard: () -> Unit, retain: suspend (JsonObject) -> Unit) {
        key(id); call("GET", "/seeker/realm-sales/by-key/$id", null, guard) { raw -> attributeOwner(raw, id); retain(raw); attribute(raw, id, false) }
    }
    suspend fun failures(id: String, guard: () -> Unit, retain: suspend (JsonObject) -> Unit) {
        key(id); call("GET", "/seeker/realm-sales/failures/by-key/$id", null, guard) { raw ->
            attributeOwner(raw, id); retain(raw)
            require(raw.keys == setOf("wallet", "idempotencyKey", "failure"))
        }
    }
    suspend fun review(preparation: RealmSalePreparation, policy: RealmSalesProtocolPolicy, guard: () -> Unit): RealmSaleReview {
        preparation.validate(policy); require(preparation.wallet == identity.wallet)
        var parsed: RealmSaleReview? = null
        call("GET", "/seeker/realm-sales/review/by-key/${preparation.idempotencyKey}", null, guard) { raw -> parsed = RealmSaleReview.from(preparation, raw, policy) }
        return requireNotNull(parsed)
    }
    suspend fun submit(id: String, signed: String, guard: () -> Unit, retain: suspend (JsonObject) -> Unit) {
        key(id); require(signed.length in 88..1644 && signed.length % 4 == 0)
        val bytes = Base64.getDecoder().decode(signed)
        require(bytes.size in 66..1232 && Base64.getEncoder().encodeToString(bytes) == signed)
        val body = buildJsonObject { put("idempotencyKey", id); put("signedTransaction", signed) }
        call("POST", "/seeker/realm-sales/submit", body, guard) { raw -> attributeOwner(raw, id); retain(raw); attribute(raw, id, true) }
    }
}
