package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEvent
import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEventBatch
import gg.pixelkingdomwars.nativeclient.fleetjourney.fleetJourneyEventKey
import gg.pixelkingdomwars.nativeclient.model.AdvancedPresence
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.CurrentFleetIdentity
import gg.pixelkingdomwars.nativeclient.model.StarterPresence
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.io.Closeable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Optional session-owned presentation only. There is no default consumer, queue,
 * persisted history or replay. All capture/lease/delivery operations share this
 * monitor; the synchronous consumer must only hand off already-resident work.
 * Its guard must cover scene visibility, selected generation and content ownership.
 * Close or invalidate on every lifecycle/base/content change, including resume. */
class FleetJourneyPublication(private val session: AccountSession, private val holder: AccountSessionHolder) {
    private class Binding(val owner: Any, val baseId: String, val contentIdentity: Any,
        val isCurrent: () -> Boolean, val consume: (FleetJourneyEvent) -> Unit) {
        var warm = false
    }
    private var binding: Binding? = null
    private val seen = mutableSetOf<String>() // This instance belongs to exactly one account session.

    class Lease internal constructor(private val release: () -> Unit) : Closeable {
        override fun close() = release()
    }
    class Capture internal constructor(internal val publication: FleetJourneyPublication,
        internal val bindingIdentity: Any, internal val baseId: String,
        internal val initialBase: BaseSnapshot?, internal val guard: () -> Unit,
        internal val wasWarm: Boolean) {
        fun current(): Boolean = publication.current(this)
        fun sameSnapshot(current: BaseSnapshot?): Boolean = publication.sameSnapshot(this, current)
    }

    /** Replacement always starts cold. An older lease cannot detach its successor. */
    @Synchronized fun attach(owner: Any, baseId: String, contentIdentity: Any,
        isCurrent: () -> Boolean, consume: (FleetJourneyEvent) -> Unit): Lease {
        holder.requireCurrent(session)
        val next = Binding(owner, baseId, contentIdentity, isCurrent, consume)
        binding = next
        return Lease { synchronized(this) { if (binding === next) binding = null } }
    }

    /** Retain dedup for the entire session, even when a scene closes and reopens. */
    @Synchronized fun invalidate() { binding = null }

    @Synchronized fun capture(baseId: String, initialBase: BaseSnapshot?, guard: () -> Unit = {}): Capture? {
        val owner = binding ?: return null
        if (owner.baseId != baseId) return null
        val capture = Capture(this, owner, baseId, initialBase, guard,
            owner.warm && matches(initialBase, baseId))
        return capture.takeIf(::current)
    }

    @Synchronized private fun current(capture: Capture): Boolean {
        if (capture.publication !== this || binding !== capture.bindingIdentity) return false
        val owner = requireNotNull(binding)
        val validOwner = runCatching { holder.requireCurrent(session); owner.isCurrent() }.getOrDefault(false)
        if (!validOwner) binding = null // A later foreground cannot revive a refused lease.
        // An older read losing its ticket must not detach the newer read's consumer.
        return validOwner && runCatching { capture.guard(); true }.getOrDefault(false)
    }

    @Synchronized private fun sameSnapshot(capture: Capture, snapshot: BaseSnapshot?): Boolean =
        current(capture) && matches(capture.initialBase, capture.baseId) && snapshot === capture.initialBase

    private fun matches(snapshot: BaseSnapshot?, baseId: String): Boolean =
        snapshot != null && snapshot.baseId == baseId && snapshot.player.wallet == session.wallet

    /** Called after the exact clean Home snapshot wins publication. Malformed optional
     * art, a lost lease or a consumer exception cannot fail the authoritative read. */
    @Synchronized fun publishReturns(raw: JsonElement?, base: BaseSnapshot, capture: Capture?, currentSnapshot: () -> Boolean) {
        if (capture == null) return
        runCatching {
            fun valid() = current(capture) && matches(base, capture.baseId) && currentSnapshot()
            if (!valid()) return
            requireNotNull(binding).warm = true
            if (!capture.wasWarm || raw == null) return
            val batch = FleetJourneyEventBatch.from(requireNotNull(raw as? JsonObject), capture.baseId)
            if (batch.events.any { it.kind != "return" || !settled(base, it) }) return
            for (event in batch.events) {
                if (!valid()) return
                if (fleetJourneyEventKey(event) !in seen) JourneyEvidenceLog.returnRequested(session.wallet, event)
                emit(capture, event)
            }
        }
    }

    /** The caller must already have retained and matched the actual new POST's
     * original and sidecars. A captured current snapshot is required; warm is not. */
    @Synchronized fun publishDeparture(event: FleetJourneyEvent, capture: Capture?, currentSnapshot: () -> Boolean) {
        if (capture == null) return
        runCatching {
            if (event.kind == "departure" && event.baseId == capture.baseId && matches(capture.initialBase, capture.baseId)
                && identityMatches(requireNotNull(capture.initialBase), event) && current(capture) && currentSnapshot()) emit(capture, event)
        }
    }

    private fun emit(capture: Capture, event: FleetJourneyEvent) {
        if (!current(capture) || !seen.add(fleetJourneyEventKey(event))) return
        requireNotNull(binding).consume(event)
    }

    /** CONTINUITY: the event's installation must be the SAME current installed identity this very snapshot proves for that berth
     *  (starter from starterFleet, advanced from the identity sibling); unknown identity refuses — nothing is borrowed from frozen
     *  facts, other endpoints or the event itself. */
    private fun identityMatches(base: BaseSnapshot, event: FleetJourneyEvent): Boolean {
        val identity = CurrentFleetIdentity.current(base.raw, base.baseId, base.servicePresentation, base.advancedServicePresentation) ?: return false
        val row = identity.installation(event.berthId) ?: return false
        return row.installationId == event.installationId && row.family == event.vehicle.family && row.tier == event.vehicle.tier
    }

    private fun settled(base: BaseSnapshot, event: FleetJourneyEvent): Boolean {
        if (!identityMatches(base, event)) return false
        if (base.buildings.none { it.id == event.berthId && it.type == "berth" && it.level >= 1 && !it.underConstruction }) return false
        return if (event.vehicle.family == "starter") {
            val installed = base.servicePresentation?.berths?.singleOrNull { it.buildingId == event.berthId }?.installation
            installed?.family == "starter" && installed.presence == StarterPresence.OCCUPIED
        } else {
            val installed = base.advancedServicePresentation?.berths?.singleOrNull { it.buildingId == event.berthId }?.installation
            installed != null && installed.family == event.vehicle.family && installed.tier == event.vehicle.tier &&
                installed.presence in setOf(AdvancedPresence.OCCUPIED, AdvancedPresence.EXHAUSTED)
        }
    }
}
