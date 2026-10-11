package gg.pixelkingdomwars.nativeclient.fleetjourney

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeCurrentEnvelope
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeOriginalEnvelope
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*

/** Ephemeral HTTP provenance, never persisted or reconstructed from a receipt.
 * The command owner retains and validates the full original before delivery. */
class FreshFleetDeparture private constructor(val kind: String, val original: JsonObject) {
    val wallet: String get() = original.getValue("wallet").jsonPrimitive.content
    val baseId: String get() = receipt.getValue("request").jsonObject.getValue("baseId").jsonPrimitive.content
    val expeditionId: String get() = receipt.getValue("expeditionId").jsonPrimitive.content
    internal val receipt: JsonObject get() = original.getValue("receipt").jsonObject

    companion object {
        internal fun fromResponse(method: String, path: String, status: Int, markers: List<String>, raw: JsonObject): FreshFleetDeparture? {
            if (method != "POST" || status != 201 || markers != listOf("1")) return null
            val kind = when (path) {
                "/starter-expeditions" -> "starter"
                "/advanced-expeditions" -> "advanced"
                else -> return null
            }
            // Optional metadata cannot convert an accepted command into failure.
            return runCatching {
                val owned = VehicleProtocol.copy(raw).jsonObject
                if (kind == "advanced") VehicleProtocol.expedition(owned)
                else {
                    boundedStarterHistory(owned); starterPrimitives(owned, StarterExpeditionProof.serializer().descriptor)
                    val parsed = starterJson.decodeFromJsonElement(StarterExpeditionProof.serializer(), owned)
                    val original = requireNotNull(parsed.receipt)
                    original.request.validate(); original.flight().validate()
                    gg.pixelkingdomwars.nativeclient.workshop.wallet(parsed.wallet)
                    require(gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp(original.departedAt) <=
                        gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp(parsed.serverNow))
                }
                require(owned.getValue("status") == JsonPrimitive("accepted") && owned.getValue("return") == JsonNull)
                val receipt = owned.getValue("receipt").jsonObject
                val request = receipt.getValue("request").jsonObject
                require(owned.getValue("wallet") == receipt.getValue("wallet"))
                require(owned.getValue("idempotencyKey") == request.getValue("idempotencyKey") && owned.getValue("idempotencyKey") == receipt.getValue("expeditionId"))
                require(request.getValue("installationId") == receipt.getValue("installationId"))
                FreshFleetDeparture(kind, owned).also { it.baseId; it.wallet; it.expeditionId }
            }.getOrNull()
        }
    }
}

/** Capture before the POST. Missing/throwing presentation capability is a drop. */
typealias FleetDepartureCapture = suspend (String, () -> Unit) -> (suspend (FreshFleetDeparture) -> Unit)?

internal suspend fun captureFleetDeparture(capture: FleetDepartureCapture, method: String, path: String,
    body: JsonObject?, guard: () -> Unit): (suspend (FreshFleetDeparture) -> Unit)? {
    if (method != "POST" || path !in setOf("/starter-expeditions", "/advanced-expeditions")) return null
    return try { capture(requireNotNull(body).getValue("baseId").jsonPrimitive.content, guard) }
    catch (_: Exception) { currentCoroutineContext().ensureActive(); null }
}

internal suspend fun deliverFleetDeparture(proof: FreshFleetDeparture?, guard: () -> Unit,
    observer: (suspend (FreshFleetDeparture) -> Unit)?) {
    if (proof == null || observer == null) return
    try { currentCoroutineContext().ensureActive(); guard(); observer(proof) }
    catch (_: Exception) {
        // Child timeout/optional parser failure drops only the visual. Actual
        // caller cancellation keeps the existing cancellation semantics.
        currentCoroutineContext().ensureActive()
    }
}

/** Bind immutable originals and current owned fleet facts. This does not prove
 * scene visibility: the caller must retain its pre-POST scene/snapshot guard,
 * check a completed current berth, and publish only while that guard still holds. */
fun bindFreshFleetDeparture(proof: FreshFleetDeparture, wallet: String, originalWakeRaw: JsonObject,
    currentWakeRaw: JsonObject, fleetRaw: JsonObject): FleetJourneyEvent {
    require(proof.wallet == wallet)
    val receipt = proof.receipt
    val installationId = receipt.getValue("installationId").jsonPrimitive.content
    val departedAt = receipt.getValue("departedAt").jsonPrimitive.content
    val returnsAt = receipt.getValue("returnsAt").jsonPrimitive.content
    val route = receipt.getValue("route").jsonObject
    val original = BoundCosmeticWakeOriginalEnvelope.from(originalWakeRaw, wallet, proof.kind, proof.expeditionId)
    require(original.status == "known" && original.returnedAt == null)
    val captured = requireNotNull(original.presentation)
    require(captured.baseId == proof.baseId && captured.installationId == installationId && captured.departedAt == departedAt && captured.returnsAt == returnsAt)
    require(captured.realmId == route.getValue("realmId").jsonPrimitive.content)
    val current = BoundCosmeticWakeCurrentEnvelope.from(currentWakeRaw, wallet, proof.baseId)
    val trip = current.trips.single { it.kind == proof.kind && it.expeditionId == proof.expeditionId }
    require(trip.installationId == installationId && trip.departedAt == departedAt && trip.returnsAt == returnsAt &&
        trip.homeRealmId == captured.homeRealmId && trip.realmId == captured.realmId && trip.wake == captured.wake)
    val berthId: String
    val vehicle: FleetJourneyVehicle
    if (proof.kind == "starter") {
        val fleet = StarterExpeditionView.from(fleetRaw)
        val installed = requireNotNull(fleet.installation); val flight = requireNotNull(fleet.flight)
        require(fleet.wallet == wallet && fleet.baseId == proof.baseId && installed.installationId == installationId)
        require(flight.expeditionId == proof.expeditionId && flight.departedAt == departedAt && flight.returnsAt == returnsAt)
        berthId = installed.berthId; vehicle = FleetJourneyVehicle("starter")
    } else {
        VehicleProtocol.expedition(proof.original)
        val fleet = VehicleProtocol.fleet(fleetRaw)
        require(fleet.getValue("wallet") == JsonPrimitive(wallet) && fleet.getValue("baseId") == JsonPrimitive(proof.baseId))
        val installed = fleet.getValue("vehicles").jsonArray.map { it.jsonObject }.single { it.getValue("installationId") == JsonPrimitive(installationId) }
        require(installed.getValue("away") == JsonPrimitive(true) && installed.getValue("family") == route.getValue("family") && installed.getValue("tier") == route.getValue("tier"))
        berthId = installed.getValue("berthId").jsonPrimitive.content
        vehicle = FleetJourneyVehicle(installed.getValue("family").jsonPrimitive.content, installed.getValue("tier").jsonPrimitive.int)
    }
    return FleetJourneyEvent(1, "departure", proof.baseId, berthId, installationId, proof.expeditionId, departedAt, vehicle, captured.wake).also { it.validate() }
}
