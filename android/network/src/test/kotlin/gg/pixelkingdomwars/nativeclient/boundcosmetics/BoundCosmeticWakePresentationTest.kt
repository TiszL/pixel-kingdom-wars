package gg.pixelkingdomwars.nativeclient.boundcosmetics

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic sidecar identities/times; no game tuning, original receipt edits,
 * preference lookup, content admission or persistence is involved. */
class BoundCosmeticWakePresentationTest {
    private val json = Json { encodeDefaults = true }
    private val wallet = "11111111111111111111111111111112"
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val departed = "2026-09-30T12:00:00.000Z"
    private val arrival = "2026-09-30T12:01:00.000Z"
    private val after = "2026-09-30T12:02:00.000Z"
    private val on = BoundCosmeticWakeCapture("available", BoundCosmeticWakeVisual(1,
        BoundCosmeticAppearance(1, "aurora_wake", "auroraWake", "a".repeat(64), "b".repeat(64), "c".repeat(64))))
    private val captures = listOf(on, BoundCosmeticWakeCapture("available", BoundCosmeticWakeVisual(1, null)),
        BoundCosmeticWakeCapture("unavailable", null), BoundCosmeticWakeCapture("legacy", null))
    private fun original(wake: BoundCosmeticWakeCapture = on) = BoundCosmeticWakeOriginalEnvelope(1, wallet, "starter", id(1), after, "known",
        BoundCosmeticWakeOriginalPresentation(id(1), id(2), id(3), "crownlands", "frostveil", departed, arrival, wake), null)
    private fun current(wake: BoundCosmeticWakeCapture = on) = BoundCosmeticWakeCurrentEnvelope(1, wallet, id(2), after,
        listOf(BoundCosmeticWakeCurrentTrip("advanced", id(1), id(3), "crownlands", "frostveil", departed, arrival, wake)))
    private fun raw(value: BoundCosmeticWakeOriginalEnvelope) = json.encodeToJsonElement(BoundCosmeticWakeOriginalEnvelope.serializer(), value).jsonObject
    private fun raw(value: BoundCosmeticWakeCurrentEnvelope) = json.encodeToJsonElement(BoundCosmeticWakeCurrentEnvelope.serializer(), value).jsonObject
    private fun read(value: JsonObject) = BoundCosmeticWakeOriginalEnvelope.from(value, wallet, "starter", id(1))
    private fun readCurrent(value: JsonObject) = BoundCosmeticWakeCurrentEnvelope.from(value, wallet, id(2))
    private fun change(value: JsonObject, path: String, next: JsonElement): JsonObject {
        val parts = path.split('.', limit = 2)
        return JsonObject(value + (parts[0] to if (parts.size == 1) next else change(value.getValue(parts[0]).jsonObject, parts[1], next)))
    }
    private fun refuses(block: () -> Unit) { assertThrows(Exception::class.java, block) }
    @Test fun `known sidecars retain four capture states while actual returnedAt stays outside immutable presentation`() {
        for (capture in captures) {
            val accepted = read(raw(original(capture))); val returned = read(raw(original(capture).copy(returnedAt = arrival)))
            assertEquals(capture, accepted.presentation!!.wake); assertEquals(accepted.presentation, returned.presentation)
            assertNull(accepted.returnedAt); assertEquals(arrival, returned.returnedAt)
        }
        val unknown = original().copy(status = "unknown", presentation = null)
        assertEquals(unknown, read(raw(unknown)))
        refuses { read(raw(unknown.copy(returnedAt = arrival))) }; refuses { read(raw(original().copy(status = "unknown"))) }
        refuses { read(raw(original().copy(presentation = null))) }
    }
    @Test fun `original boundary refuses foreign identity malformed capture wrong scalars and invented returned chronology`() {
        val valid = raw(original())
        for ((path, bad) in listOf("version" to JsonPrimitive("1"), "kind" to JsonPrimitive("other"),
            "presentation.expeditionId" to JsonPrimitive(id(9)), "presentation.wake" to JsonNull,
            "presentation.wake.state" to JsonPrimitive("legacy"), "presentation.wake.visual.version" to JsonPrimitive("1"),
            "presentation.wake.visual.wake.sourceId" to JsonPrimitive("artisan-market-t1"),
            "presentation.wake.visual.wake.bindingSha256" to JsonPrimitive("not-a-hash"),
            "presentation.wake.visual.wake.enabled" to JsonPrimitive(true), "presentation.termHash" to JsonPrimitive("a".repeat(64)),
            "presentation.departedAt" to JsonPrimitive(after), "presentation.returnsAt" to JsonPrimitive(departed),
            "returnedAt" to JsonPrimitive(departed), "returnedAt" to JsonPrimitive("2026-09-30T12:03:00.000Z"),
            "serverNow" to JsonPrimitive("2026-09-30T12:02:00Z"))) refuses { read(change(valid, path, bad)) }
        refuses { BoundCosmeticWakeOriginalEnvelope.from(valid, "11111111111111111111111111111113", "starter", id(1)) }
        refuses { BoundCosmeticWakeOriginalEnvelope.from(valid, wallet, "advanced", id(1)) }
        refuses { BoundCosmeticWakeOriginalEnvelope.from(valid, wallet, "starter", id(9)) }
        refuses { read(change(valid, "wallet", JsonPrimitive("1".repeat(32)))) }
    }
    @Test fun `current sidecars are redacted owned observations and elapsed arrival does not manufacture return`() {
        for (capture in captures) assertEquals(current(capture), readCurrent(raw(current(capture))))
        val v = current(); val trip = v.trips.single()
        refuses { readCurrent(raw(v.copy(trips = listOf(trip, trip)))) }
        refuses { readCurrent(raw(v.copy(trips = listOf(trip, trip.copy(expeditionId = id(9)))))) }
        refuses { readCurrent(raw(v.copy(trips = listOf(trip.copy(departedAt = "2026-09-30T12:04:00.000Z", returnsAt = "2026-09-30T12:05:00.000Z"))))) }
        assertEquals(2, readCurrent(raw(v.copy(trips = listOf(trip, trip.copy(kind = "starter"))))).trips.size)
        val source = raw(v); val privateTrip = JsonObject(source.getValue("trips").jsonArray.single().jsonObject + ("wallet" to JsonPrimitive(wallet)))
        refuses { readCurrent(JsonObject(source + ("trips" to JsonArray(listOf(privateTrip))))) }
        refuses { BoundCosmeticWakeCurrentEnvelope.from(source, wallet, id(9)) }
        refuses { BoundCosmeticWakeCurrentEnvelope.from(source, "11111111111111111111111111111113", id(2)) }
        assertTrue(readCurrent(raw(v.copy(trips = emptyList()))).trips.isEmpty())
    }
    @Test fun `presentation decoding bounds raw input and returns an owned immutable trip list`() {
        val parsed = readCurrent(raw(current()))
        refuses { (parsed.trips as MutableList).clear() }
        val source = raw(current())
        refuses { readCurrent(JsonObject(source + ("trips" to JsonArray(List(513) { source.getValue("trips").jsonArray.single() })))) }
        refuses { read(change(raw(original()), "presentation.wake.visual.wake.bindingSha256", JsonPrimitive("x".repeat(257)))) }
    }
}
