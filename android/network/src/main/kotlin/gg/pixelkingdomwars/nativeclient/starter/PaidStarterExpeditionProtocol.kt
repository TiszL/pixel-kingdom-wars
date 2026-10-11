package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.quantity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import kotlinx.serialization.*
import kotlinx.serialization.json.*
import java.time.Instant

/** Wire selection only; no current entitlement can be derived from this display DTO. */
fun validatePaidStarterSelection(baseId: String, realm: String) {
    uuid(baseId); require(realm in paidStarterRealmIds.indices.map(Int::toString))
}
internal fun validatePaidStarterPreview(route: StarterExpeditionRoute) {
    require(route.routeCatalogueVersion == 3 && route.rewardTableVersion == 2 && route.vehicleFamily == "starter")
    require(route.realmId in paidStarterRealmIds && route.routeId == "paid_${route.realmId.replace('-', '_')}"
        && starterResourceRealms[route.resourceId] == route.realmId && route.access == StarterExpeditionAccess("paid_realm", 1))
    count(route.durationSec, true)
    require(quantity(route.netQuantity) + quantity(route.islandPoolQuantity) == quantity(route.grossQuantity, true))
}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class PaidStarterCoverage(val status: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val expiresAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val observedAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val reason: String? = null)
@Serializable data class PaidStarterExpeditionView(val wallet: String, val baseId: String, val realm: Int, val serverNow: String,
    val authorization: String, val acceptingDepartures: Boolean, val route: StarterExpeditionRoute, val coverage: PaidStarterCoverage) {
    fun validate() {
        wallet(wallet); uuid(baseId); require(realm in paidStarterRealmIds.indices && authorization == "none")
        val now = timestamp(serverNow); require(serverNow.length == 24 && now >= Instant.EPOCH)
        validatePaidStarterPreview(route); require(route.realmId == paidStarterRealmIds[realm])
        when (coverage.status) {
            "covered" -> {
                require(coverage.reason == null)
                val expires = requireNotNull(coverage.expiresAt); val observed = requireNotNull(coverage.observedAt)
                require(expires.length in 1..19 && expires.matches(Regex("0|[1-9][0-9]{0,18}")))
                require(expires.toBigInteger() <= Long.MAX_VALUE.toBigInteger() && expires.toBigInteger() > now.epochSecond.toBigInteger())
                require(observed.length == 24 && timestamp(observed) in Instant.EPOCH..now)
            }
            "blocked" -> require(coverage.reason in setOf("NO_COVERAGE", "EXPIRED") && coverage.expiresAt == null && coverage.observedAt == null)
            "unavailable" -> require(coverage.expiresAt == null && coverage.observedAt == null && coverage.reason == null)
            else -> error("Unsupported paid coverage display")
        }
    }
    companion object { fun from(raw: JsonObject): PaidStarterExpeditionView {
        boundedStarterHistory(raw, paidProof = false); starterPrimitives(raw, serializer().descriptor)
        val coverage = raw.getValue("coverage").jsonObject
        require(coverage.keys == when (coverage["status"]?.jsonPrimitive?.content) {
            "covered" -> setOf("status", "expiresAt", "observedAt")
            "blocked" -> setOf("status", "reason")
            else -> setOf("status")
        })
        return starterJson.decodeFromJsonElement<PaidStarterExpeditionView>(raw).also { it.validate() }
    } }
}
