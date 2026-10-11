package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.realmsales.RealmSalesAuthenticatedPort
import gg.pixelkingdomwars.nativeclient.realmsales.RealmSalePrepareRefusal
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Bind one original wallet/origin to its captured authenticated ApiClient.
 * Only scoped suspend-evidence methods are used; ordinary GET/POST cannot replace
 * this capability. Late evidence has identity checks but no current-view guard. */
class RealmSalesTransportBinding(override val identity: StarterIdentity, private val session: AccountSession,
    private val holder: AccountSessionHolder, private val api: ApiClient) : RealmSalesAuthenticatedPort {
    init {
        identity.validate(); require(identity.origin.startsWith("https://"))
        require(identity.wallet == session.wallet && identity.origin == session.origin.toHttpUrl().toString().trimEnd('/'))
    }
    override suspend fun request(method: String, path: String, body: JsonObject?, guard: () -> Unit,
        refusal: (suspend (RealmSalePrepareRefusal) -> Unit)?, retain: suspend (JsonObject) -> Unit): JsonObject {
        require(refusal == null || method == "POST" && path == "/seeker/realm-sales/prepare")
        val current = { holder.requireCurrent(session); guard() }
        current()
        val key = when (method) {
            "GET" -> {
                require(body == null)
                val prefix = listOf("/seeker/realm-sales/prepare/by-key/", "/seeker/realm-sales/review/by-key/", "/seeker/realm-sales/failures/by-key/", "/seeker/realm-sales/by-key/")
                    .singleOrNull { path.startsWith(it) } ?: throw IllegalArgumentException("Unsupported realm-sale path")
                path.removePrefix(prefix)
            }
            "POST" -> { require(path in setOf("/seeker/realm-sales/prepare", "/seeker/realm-sales/submit")); requireNotNull((body?.get("idempotencyKey") as? JsonPrimitive)?.takeIf { it.isString }?.content) }
            else -> throw IllegalArgumentException("Unsupported realm-sale method")
        }
        require(key.length == 36 && (key.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
            key == "00000000-0000-0000-0000-000000000000" || key == "ffffffff-ffff-ffff-ffff-ffffffffffff"))
        val owned: suspend (JsonObject) -> Unit = { raw ->
            fun text(name: String) = (raw[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
            require(text("wallet") == identity.wallet && text("idempotencyKey") == key)
            retain(raw)
        }
        return when (method) {
            "GET" -> api.getRealmSale(path, current, owned)
            else -> api.postRealmSale(path, requireNotNull(body), current, refusal, owned)
        }.also { current() }
    }
}
