package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticProof
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture
import gg.pixelkingdomwars.nativeclient.fleetjourney.bindFreshFleetDeparture
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject

/** Optional appearance reads stay outside receipt retention and global API routing.
 * Capture before the command; a newly mounted Home can never inherit its callback. */
class FleetJourneyDepartures(
    private val wallet: String,
    private val publication: FleetJourneyPublication,
    private val currentBase: () -> BaseSnapshot?,
    private val selectedBase: () -> String?,
    private val selectionGeneration: () -> Long,
    private val diagnosticOriginal: suspend (() -> Unit) -> BoundCosmeticProof? = { null },
    private val read: suspend (String, Map<String, String>, () -> Unit) -> JsonObject,
) {
    suspend fun capture(baseId: String, originalGuard: () -> Unit): (suspend (FreshFleetDeparture) -> Unit)? {
        val generation = selectionGeneration()
        val guard = {
            originalGuard()
            check(selectedBase() == baseId && selectionGeneration() == generation) { "Journey kingdom changed" }
        }
        // Q9c: one optional diagnostic read before scene capture and before POST.
        // Its timeout is independent of the post-response 30-second visual block.
        val craftOriginal = if (BuildConfig.DEBUG) try {
            withTimeoutOrNull(5_000L) { guard(); diagnosticOriginal(guard).also { guard() } }
        } catch (_: Exception) { currentCoroutineContext().ensureActive(); null } else null
        val captured = publication.capture(baseId, currentBase(), guard) ?: return null
        if (!captured.sameSnapshot(currentBase())) return null
        return { proof ->
            fun current() { guard(); check(captured.sameSnapshot(currentBase())) { "Journey scene changed" } }
            current(); check(proof.baseId == baseId)
            // A transport resource deadline, not an expedition duration or gameplay rule.
            withTimeout(30_000L) {
                val original = read("/bound-cosmetics/wakes/v1/originals/${proof.kind}/${proof.expeditionId}", emptyMap(), ::current)
                current()
                val active = read("/bound-cosmetics/wakes/v1/current", mapOf("baseId" to baseId), ::current)
                current()
                val fleet = read(if (proof.kind == "starter") "/starter-expeditions" else "/vehicles/fleet", mapOf("baseId" to baseId), ::current)
                current()
                val event = bindFreshFleetDeparture(proof, wallet, original, active, fleet)
                val snapshot = requireNotNull(currentBase())
                check(snapshot.buildings.any { it.id == event.berthId && it.type == "berth" && it.level >= 1 && !it.underConstruction })
                JourneyEvidenceLog.submitted(wallet, proof, event, craftOriginal)
                publication.publishDeparture(event, captured) { captured.sameSnapshot(currentBase()) }
            }
        }
    }
}
