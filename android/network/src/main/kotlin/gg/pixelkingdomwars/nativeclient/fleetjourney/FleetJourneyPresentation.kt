package gg.pixelkingdomwars.nativeclient.fleetjourney

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeCapture
import gg.pixelkingdomwars.nativeclient.boundcosmetics.cosmeticDecode
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import java.util.Collections
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

// Frozen wire vocabulary from shared phaseEVehicles; no costs, capacity or timers.
private val advancedFamilies = setOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge")

/** Same resource-only ceilings as the accepted Wake sidecar decoder. These are
 * input safety limits, never fleet size, gameplay capacity or event provenance. */
private fun boundJourney(raw: JsonObject) {
    var nodes = 0
    fun visit(value: JsonElement, depth: Int) {
        require(++nodes <= 8192 && depth <= 12) { "Journey presentation exceeds decoder bounds" }
        when (value) {
            is JsonObject -> { require(value.size <= 32); value.forEach { (key, child) -> require(key.length <= 64); visit(child, depth + 1) } }
            is JsonArray -> { require(value.size <= 512); value.forEach { visit(it, depth + 1) } }
            is JsonPrimitive -> require(value.content.length <= 256)
        }
    }
    visit(raw, 0)
}

@Serializable data class FleetJourneyVehicle(val family: String, val tier: Int? = null) {
    fun validate() {
        if (family == "starter") require(tier == null)
        else require(family in advancedFamilies && tier != null && tier in 1..4)
    }
}

/** An immutable presentation shape, NOT proof of a fresh committed departure or
 * return. The producer must separately enforce response provenance and lifecycle. */
@Serializable data class FleetJourneyEvent(val version: Int, val kind: String, val baseId: String,
    val berthId: String, val installationId: String, val expeditionId: String, val at: String,
    val vehicle: FleetJourneyVehicle, val wake: BoundCosmeticWakeCapture, val returnId: String? = null) {
    fun validate() {
        require(version == 1); uuid(baseId); uuid(berthId); uuid(installationId); uuid(expeditionId)
        timestamp(at); vehicle.validate(); wake.validate()
        when (kind) {
            "departure" -> require(returnId == null)
            "return" -> uuid(requireNotNull(returnId))
            else -> error("Unknown journey kind")
        }
    }
    companion object {
        fun from(raw: JsonObject): FleetJourneyEvent {
            boundJourney(raw); journeyShape(raw)
            return cosmeticDecode(raw, serializer()).also { it.validate() }
        }
    }
}

/** Discriminated strict shape checks keep illegal explicit nulls distinct from
 * omitted departure returnId / starter tier before decoding nullable Kotlin fields. */
private fun journeyShape(raw: JsonObject) {
    val common = setOf("version", "kind", "baseId", "berthId", "installationId", "expeditionId", "at", "vehicle", "wake")
    val expected = when ((raw["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
        "departure" -> common
        "return" -> common + "returnId"
        else -> error("Unknown journey kind")
    }
    require(raw.keys == expected) { "Journey contains missing or private fields" }
    val vehicle = raw.getValue("vehicle").jsonObject
    val family = (vehicle["family"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    require(vehicle.keys == if (family == "starter") setOf("family") else setOf("family", "tier"))
}

fun fleetJourneyEventKey(event: FleetJourneyEvent): String {
    event.validate()
    // Starter and advanced commands have separate original identity domains.
    return "${event.kind}:${event.vehicle.family}:${if (event.kind == "return") event.returnId else event.expeditionId}"
}

@Serializable data class FleetJourneyEventBatch(val version: Int, val events: List<FleetJourneyEvent>) {
    companion object {
        /** An empty batch is valid. A foreign or duplicate event refuses the whole
         * batch, rather than partially publishing it to the currently selected base. */
        fun from(raw: JsonObject, baseId: String): FleetJourneyEventBatch {
            uuid(baseId); boundJourney(raw)
            raw.getValue("events").jsonArray.forEach { journeyShape(it.jsonObject) }
            val parsed = cosmeticDecode(raw, serializer())
            require(parsed.version == 1)
            parsed.events.forEach { it.validate(); require(it.baseId == baseId) { "Journey belongs to another kingdom" } }
            require(parsed.events.map(::fleetJourneyEventKey).toSet().size == parsed.events.size) { "Duplicate journey event" }
            return parsed.copy(events = Collections.unmodifiableList(ArrayList(parsed.events)))
        }
    }
}
