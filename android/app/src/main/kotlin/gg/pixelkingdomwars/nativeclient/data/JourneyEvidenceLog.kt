package gg.pixelkingdomwars.nativeclient.data

import android.util.Log
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticProof
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeCapture
import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEvent
import gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.*

/** Debug evidence only: never a gameplay input, persisted history, or network reader.
 * Invalid fields become unavailable; no raw request, response, auth or exception text
 * reaches Log. Optional diagnostics must never change command/publication behavior. */
internal object JourneyEvidenceLog {
    internal const val UNAVAILABLE = "unavailable"
    private val points = setOf("departure_submitted", "departure_settled", "return_requested", "return_settled")
    private val id = Regex("[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")
    private val wallet = Regex("[1-9A-HJ-NP-Za-km-z]{32,44}")
    private val hash = Regex("[0-9a-f]{64}")
    private val time = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z")
    private val sequence = AtomicLong()

    internal data class Fields(val wallet: String? = null, val base: String? = null,
        val installation: String? = null, val berth: String? = null, val expedition: String? = null,
        val craft: String? = null, val wake: String? = null, val wakeBinding: String? = null,
        val wakeState: String? = null, val departedAt: String? = null, val returnsAt: String? = null,
        val returnedAt: String? = null, val serverNow: String? = null, val kind: String? = null,
        val publication: String? = null)

    private fun safe(value: String?, rule: Regex) = value?.takeIf(rule::matches) ?: UNAVAILABLE
    private fun choice(value: String?, choices: Set<String>) = value?.takeIf { it in choices } ?: UNAVAILABLE
    private fun instant(value: String?): String = value?.takeIf {
        time.matches(it) && runCatching { Instant.parse(it) }.isSuccess
    } ?: UNAVAILABLE

    /** Pure JVM boundary. The caller never passes session contents or arbitrary maps. */
    internal fun format(point: String, fields: Fields, seq: Long): String? {
        if (point !in points || seq <= 0) return null
        val values = linkedMapOf("wallet" to safe(fields.wallet, wallet), "base" to safe(fields.base, id),
            "installation" to safe(fields.installation, id), "berth" to safe(fields.berth, id),
            "expedition" to safe(fields.expedition, id), "craft" to safe(fields.craft, id),
            "wake" to safe(fields.wake, hash), "wakeBinding" to safe(fields.wakeBinding, hash),
            "wakeState" to choice(fields.wakeState, setOf("legacy", "available", "unavailable")),
            "departedAt" to instant(fields.departedAt), "returnsAt" to instant(fields.returnsAt),
            "returnedAt" to instant(fields.returnedAt), "serverNow" to instant(fields.serverNow),
            "kind" to choice(fields.kind, setOf("departure", "return")),
            "publication" to choice(fields.publication, setOf("accepted", "rejected", "pending", "unavailable")),
            "seq" to seq.toString())
        return "journey $point " + values.entries.joinToString(" ") { "${it.key}=${it.value}" }
    }

    /** Canonical UTF-8 JSON: recursively sorted object keys, compact JSON string escaping.
     * Includes the whole original capture, distinguishing legacy, unavailable, off, on.
     * This digest is not the appearance's already supplied bindingSha256 field. */
    internal fun canonical(value: JsonElement): String = when (value) {
        is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { JsonPrimitive(it).toString() + ":" + canonical(value.getValue(it)) }
        is JsonArray -> value.joinToString(",", "[", "]", transform = ::canonical)
        else -> value.toString()
    }
    internal fun wakeHash(capture: BoundCosmeticWakeCapture): String {
        capture.validate()
        val bytes = canonical(Json.encodeToJsonElement(BoundCosmeticWakeCapture.serializer(), capture)).toByteArray(Charsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /** Limited diagnostic residency, not a fleet/game cap. A missing/evicted context
     * stays unavailable. Equality is checked before any prior identity is repeated. */
    internal class Contexts(private val limit: Int = 64) {
        private val values = LinkedHashMap<List<String>, Fields>()
        @Synchronized fun remember(fields: Fields) {
            if (safe(fields.expedition, id) == UNAVAILABLE) return
            val key = listOf(fields.wallet, fields.base, fields.installation, fields.berth, fields.expedition).map { it ?: UNAVAILABLE }
            if (safe(fields.wallet, wallet) == UNAVAILABLE || listOf(fields.base, fields.installation, fields.berth).any { safe(it, id) == UNAVAILABLE }) return
            val prior = values[key]
            if (prior != null && !same(prior, fields)) { values.remove(key); return }
            values[key] = fields.copy(departedAt = instant(fields.departedAt), returnsAt = instant(fields.returnsAt), serverNow = instant(fields.serverNow))
            while (values.size > limit) values.remove(values.keys.first())
        }
        @Synchronized fun find(event: FleetJourneyEvent, observedWallet: String? = null): Fields? = values.values.filter {
            it.expedition == event.expeditionId && it.base == event.baseId && it.installation == event.installationId && it.berth == event.berthId &&
                (observedWallet == null || it.wallet == observedWallet) && it.wake == wakeHash(event.wake)
        }.singleOrNull()
        private fun same(a: Fields, b: Fields) = a.wallet == b.wallet && a.base == b.base &&
            a.installation == b.installation && a.berth == b.berth && a.expedition == b.expedition && a.wake == b.wake && a.craft == b.craft &&
            a.departedAt == b.departedAt && a.returnsAt == b.returnsAt
    }
    private val contexts = Contexts()
    private fun text(raw: JsonObject?, key: String): String? = (raw?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun fields(event: FleetJourneyEvent, observedWallet: String?, publication: String, previous: Fields? = null): Fields = Fields(
        wallet = observedWallet ?: previous?.wallet, base = event.baseId, installation = event.installationId,
        berth = event.berthId, expedition = event.expeditionId, craft = previous?.craft, wake = wakeHash(event.wake),
        wakeBinding = event.wake.visual?.wake?.bindingSha256, wakeState = event.wake.state,
        departedAt = if (event.kind == "departure") event.at else previous?.departedAt,
        returnsAt = previous?.returnsAt, returnedAt = if (event.kind == "return") event.at else null,
        serverNow = previous?.serverNow, kind = event.kind, publication = publication)
    private fun emit(point: String, value: Fields) { format(point, value, sequence.incrementAndGet())?.let { Log.i("PKWJourney", it) } }

    /** Account's unique completed aurora_wake job, correlated by the full frozen
     * appearance. This is not a job field received in the trip sidecar: its sealed
     * selection_record.jobId remains server-side. Never use a berth/blueprint ID. */
    internal fun craftJob(observedWallet: String, event: FleetJourneyEvent, original: BoundCosmeticProof?): String = runCatching {
        event.validate(); require(event.kind == "departure")
        val proof = requireNotNull(original); proof.validate()
        require(proof.status == "accepted" && proof.wallet == observedWallet)
        val receipt = requireNotNull(proof.receipt); val completed = requireNotNull(proof.completion)
        require(receipt.wallet == observedWallet && receipt.recipe.outputId == "aurora_wake" && receipt.appearance.outputId == "aurora_wake")
        require(receipt.jobId == proof.idempotencyKey && id.matches(receipt.jobId))
        require(event.wake.state == "available" && event.wake.visual?.wake == receipt.appearance)
        require(Instant.parse(completed.completedAt) <= Instant.parse(event.at))
        receipt.jobId
    }.getOrDefault(UNAVAILABLE)

    fun submitted(observedWallet: String, proof: FreshFleetDeparture, event: FleetJourneyEvent, craftOriginal: BoundCosmeticProof? = null) {
        if (!BuildConfig.DEBUG) return
        runCatching {
            event.validate()
            if (event.kind != "departure" || proof.wallet != observedWallet || proof.baseId != event.baseId || proof.expeditionId != event.expeditionId) return
            val receipt = proof.original["receipt"] as? JsonObject
            val value = fields(event, observedWallet, "pending").copy(
                craft = craftJob(observedWallet, event, craftOriginal), departedAt = text(receipt, "departedAt"), returnsAt = text(receipt, "returnsAt"), serverNow = text(proof.original, "serverNow"))
            contexts.remember(value); emit("departure_submitted", value)
        }
    }
    fun returnRequested(observedWallet: String, event: FleetJourneyEvent) {
        if (!BuildConfig.DEBUG) return
        runCatching {
            event.validate(); if (event.kind != "return") return
            emit("return_requested", fields(event, observedWallet, "pending", contexts.find(event, observedWallet)))
        }
    }
    fun published(event: FleetJourneyEvent, accepted: Boolean) {
        if (!BuildConfig.DEBUG) return
        runCatching {
            event.validate()
            // Accepted means admitted insertion only, never visible playback.
            // A false renderer result is explicitly rejected, never accepted.
            emit(if (event.kind == "departure") "departure_settled" else "return_settled",
                fields(event, null, if (accepted) "accepted" else "rejected", contexts.find(event)))
        }
    }
}
