package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import java.util.Collections
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Separate versioned presentation, never fields added to an economic receipt.
 * Decode resource ceilings are not fleet capacity or gameplay policy. */
private fun <T> wakePresentationDecode(raw: JsonObject, serializer: KSerializer<T>): T {
    var nodes = 0
    fun bound(value: JsonElement, depth: Int) {
        require(++nodes <= 8192 && depth <= 12) { "Wake presentation exceeds decoder bounds" }
        when (value) {
            is JsonObject -> { require(value.size <= 32); value.forEach { (key, child) -> require(key.length <= 64); bound(child, depth + 1) } }
            is JsonArray -> { require(value.size <= 512); value.forEach { bound(it, depth + 1) } }
            is JsonPrimitive -> require(value.content.length <= 256)
        }
    }
    bound(raw, 0)
    return cosmeticDecode(raw, serializer)
}
private fun wakeKind(kind: String) { require(kind in setOf("starter", "advanced")) }
private fun wakeWallet(value: String) { wallet(value); require(value != "1".repeat(32)) }
private fun wakeTrip(expeditionId: String, installationId: String, homeRealmId: String, realmId: String,
    departedAt: String, returnsAt: String, wake: BoundCosmeticWakeCapture) {
    uuid(expeditionId); uuid(installationId)
    require(homeRealmId in paidStarterRealmIds && realmId in paidStarterRealmIds)
    require(timestamp(returnsAt) > timestamp(departedAt)); wake.validate()
}

/** Legacy means no prospective capture, not a known off selection. */
@Serializable data class BoundCosmeticWakeCapture(val state: String, val visual: BoundCosmeticWakeVisual?) {
    fun validate() {
        if (state == "legacy") require(visual == null)
        else BoundCosmeticWakeRead(state, visual).validate()
    }
}
@Serializable data class BoundCosmeticWakeOriginalPresentation(val expeditionId: String, val baseId: String,
    val installationId: String, val homeRealmId: String, val realmId: String,
    val departedAt: String, val returnsAt: String, val wake: BoundCosmeticWakeCapture) {
    fun validate() { uuid(baseId); wakeTrip(expeditionId, installationId, homeRealmId, realmId, departedAt, returnsAt, wake) }
}
@Serializable data class BoundCosmeticWakeOriginalEnvelope(val version: Int, val wallet: String, val kind: String,
    val key: String, val serverNow: String, val status: String,
    val presentation: BoundCosmeticWakeOriginalPresentation?, val returnedAt: String?) {
    fun validate() {
        require(version == 1); wakeWallet(wallet); wakeKind(kind); uuid(key); val now = timestamp(serverNow)
        when (status) {
            "unknown" -> require(presentation == null && returnedAt == null)
            "known" -> {
                val original = requireNotNull(presentation); original.validate()
                require(key == original.expeditionId && timestamp(original.departedAt) <= now)
                returnedAt?.let { require(timestamp(it) in timestamp(original.returnsAt)..now) }
            }
            else -> error("Unknown Wake original state")
        }
    }
    companion object {
        fun from(raw: JsonObject, wallet: String, kind: String, key: String): BoundCosmeticWakeOriginalEnvelope {
            wakeWallet(wallet); wakeKind(kind); uuid(key)
            return wakePresentationDecode(raw, serializer()).also {
                it.validate(); require(it.wallet == wallet && it.kind == kind && it.key == key) { "Wake original belongs to another request" }
            }
        }
    }
}
@Serializable data class BoundCosmeticWakeCurrentTrip(val kind: String, val expeditionId: String, val installationId: String,
    val homeRealmId: String, val realmId: String, val departedAt: String, val returnsAt: String, val wake: BoundCosmeticWakeCapture) {
    fun validate() { wakeKind(kind); wakeTrip(expeditionId, installationId, homeRealmId, realmId, departedAt, returnsAt, wake) }
}
@Serializable data class BoundCosmeticWakeCurrentEnvelope(val version: Int, val wallet: String, val baseId: String,
    val serverNow: String, val trips: List<BoundCosmeticWakeCurrentTrip>) {
    fun validate() {
        require(version == 1); wakeWallet(wallet); uuid(baseId); val now = timestamp(serverNow)
        require(trips.map { it.kind to it.expeditionId }.distinct().size == trips.size)
        require(trips.map { it.kind to it.installationId }.distinct().size == trips.size)
        trips.forEach { it.validate(); require(timestamp(it.departedAt) <= now) }
        // Elapsed arrival time is not an actual return receipt.
    }
    companion object {
        fun from(raw: JsonObject, wallet: String, baseId: String): BoundCosmeticWakeCurrentEnvelope {
            wakeWallet(wallet); uuid(baseId)
            val parsed = wakePresentationDecode(raw, serializer()).also {
                it.validate(); require(it.wallet == wallet && it.baseId == baseId) { "Wake observation belongs to another kingdom" }
            }
            return parsed.copy(trips = Collections.unmodifiableList(ArrayList(parsed.trips)))
        }
    }
}
