package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

internal val starterJson = Json { encodeDefaults = true }
@Serializable data class StarterIdentity(val origin: String, val cluster: String, val wallet: String) {
    fun validate() {
        WorkshopIdentity(origin, cluster, wallet).validate()
        require(origin.toHttpUrl().toString().removeSuffix("/") == origin)
    }
}
/** Wire identities only. Amounts, durations and rewards always come from server reviews. */
internal val starterResourceRealms = linkedMapOf("frost_quartz" to "frostveil", "heartwood_logs" to "elderwood",
    "sunstone_rubble" to "sunscar", "crown_iron_ore" to "crownlands", "rough_prism" to "seeker-reach",
    "storm_ore" to "stormcairn", "thorn_fibre" to "thornwake", "ember_nodules" to "cinderfall")
internal val starterRouteIds = setOf("introduction", "coastal_survey", "long_survey") + starterResourceRealms.values.map { "common_${it.replace('-', '_')}" }
internal fun starterPrimitives(raw: JsonElement, schema: SerialDescriptor) {
    strictPrimitives(raw, schema)
    fun routes(value: JsonElement) {
        when (value) {
            is JsonObject -> {
                if ("routeId" in value && "vehicleFamily" in value && "access" in value) require(value["access"] != JsonNull)
                if ("routeId" in value && "fitting" in value) require(value["fitting"] != JsonNull)
                if ("secondaryOutput" in value) require(value["secondaryOutput"] != JsonNull)
                if ("itemId" in value && "resourceId" in value) require(value["resourceId"] != JsonNull)
                value.values.forEach(::routes)
            }
            is JsonArray -> value.forEach(::routes)
            else -> Unit
        }
    }
    routes(raw)
}
