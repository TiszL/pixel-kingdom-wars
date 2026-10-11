package gg.pixelkingdomwars.nativeclient.fleetjourney

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic journey shapes matching the accepted shared grammar. The optional
 * selected appearance comes from an existing exact primary fixture; these are
 * NOT captured event responses, HTTP201 evidence, or renderer admission. */
class FleetJourneyPresentationTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val baseId = id(1)
    private val legacy = buildJsonObject { put("state", "legacy"); put("visual", JsonNull) }
    private val unavailable = buildJsonObject { put("state", "unavailable"); put("visual", JsonNull) }
    private val off = buildJsonObject { put("state", "available"); put("visual", buildJsonObject { put("version", 1); put("wake", JsonNull) }) }
    private fun selected(): JsonObject {
        // Reuse the existing immutable source fixture, without changing/re-labelling
        // its synthetic-readiness provider provenance as event or native HTTP proof.
        val pair = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream(
            "/boundcosmetics/wake-workshop-primary-pair.json")).use { it.readBytes().toString(Charsets.UTF_8) }).jsonObject
        val appearance = pair.getValue("completed").jsonObject.getValue("recipe").jsonObject.getValue("appearance")
        return buildJsonObject { put("state", "available"); put("visual", buildJsonObject { put("version", 1); put("wake", appearance) }) }
    }
    private fun event(kind: String = "departure", family: String = "starter", tier: Int? = null, wake: JsonObject = legacy) = buildJsonObject {
        put("version", 1); put("kind", kind); put("baseId", baseId); put("berthId", id(2))
        put("installationId", id(3)); put("expeditionId", id(4)); put("at", "2026-10-01T03:52:08.000Z")
        put("vehicle", buildJsonObject { put("family", family); tier?.let { put("tier", it) } }); put("wake", wake)
        if (kind == "return") put("returnId", id(5))
    }
    private fun batch(events: List<JsonElement>) = buildJsonObject { put("version", 1); put("events", JsonArray(events)) }
    private fun read(raw: JsonObject) = FleetJourneyEvent.from(raw)
    private fun readBatch(raw: JsonObject, expectedBase: String = baseId) = FleetJourneyEventBatch.from(raw, expectedBase)
    private fun change(raw: JsonObject, path: String, value: JsonElement): JsonObject {
        val parts = path.split('.', limit = 2)
        return JsonObject(raw + (parts[0] to if (parts.size == 1) value else change(raw.getValue(parts[0]).jsonObject, parts[1], value)))
    }
    private fun refuses(action: () -> Unit) { assertThrows(Exception::class.java, action) }

    @Test fun `closed family tier and event vocabulary matches shared source for every admitted variant`() {
        for (kind in listOf("departure", "return")) {
            assertEquals(FleetJourneyVehicle("starter"), read(event(kind)).vehicle)
            for (family in listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge")) for (tier in 1..4) {
                val parsed = read(event(kind, family, tier))
                assertEquals(FleetJourneyVehicle(family, tier), parsed.vehicle)
                assertEquals(kind, parsed.kind)
                assertEquals(if (kind == "return") id(5) else null, parsed.returnId)
            }
        }
    }

    @Test fun `legacy off unavailable and exact original selected appearance stay distinct`() {
        val values = listOf(legacy, off, unavailable, selected()).map { read(event(wake = it)).wake }
        assertEquals(4, values.toSet().size)
        assertEquals("legacy", values[0].state); assertNull(values[0].visual)
        assertEquals("available", values[1].state); assertNull(requireNotNull(values[1].visual).wake)
        assertEquals("unavailable", values[2].state); assertNull(values[2].visual)
        assertEquals("aurora_wake", requireNotNull(values[3].visual?.wake).outputId)
        refuses { read(JsonObject(event() - "wake")) }
        refuses { read(change(event(), "wake", JsonNull)) }
        refuses { read(change(event(wake = selected()), "wake.state", JsonPrimitive("legacy"))) }
    }

    @Test fun `departure forbids even null return identity while return requires an actual canonical receipt`() {
        refuses { read(JsonObject(event() + ("returnId" to JsonNull))) }
        refuses { read(JsonObject(event() + ("returnId" to JsonPrimitive(id(5))))) }
        refuses { read(JsonObject(event("return") - "returnId")) }
        refuses { read(change(event("return"), "returnId", JsonNull)) }
        assertEquals("departure:starter:${id(4)}", fleetJourneyEventKey(read(event())))
        assertEquals("return:starter:${id(5)}", fleetJourneyEventKey(read(event("return"))))
    }

    @Test fun `family shape cannot coerce a tier or attach an advanced tier to starter`() {
        for (vehicle in listOf(
            buildJsonObject { put("family", "starter"); put("tier", JsonNull) },
            buildJsonObject { put("family", "starter"); put("tier", 1) },
            buildJsonObject { put("family", "survey_balloon") },
            buildJsonObject { put("family", "unknown"); put("tier", 1) },
        )) refuses { read(change(event(), "vehicle", vehicle)) }
        for (tier in listOf(JsonNull, JsonPrimitive("1"), JsonPrimitive(0), JsonPrimitive(5), JsonPrimitive(true), JsonPrimitive(1.5)))
            refuses { read(change(event(family = "survey_balloon", tier = 1), "vehicle.tier", tier)) }
        refuses { read(change(event(), "vehicle.family", JsonPrimitive(1))) }
    }

    @Test fun `identities and timestamps are canonical without current clock or inferred return authority`() {
        for (field in listOf("baseId", "berthId", "installationId", "expeditionId", "returnId")) {
            for (invalid in listOf("AAAAAAAA-0000-4000-8000-000000000001", "not-a-uuid", "00000000-0000-9000-8000-000000000001"))
                refuses { read(change(event("return"), field, JsonPrimitive(invalid))) }
        }
        for (stamp in listOf("2026-10-01T03:52:08Z", "2026-10-01T03:52:08.000+00:00", "2026-02-30T03:52:08.000Z"))
            refuses { read(change(event(), "at", JsonPrimitive(stamp))) }
        for (special in listOf("00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"))
            assertEquals(special, read(change(event(), "expeditionId", JsonPrimitive(special))).expeditionId)
        // The wire contains no observation time; only the producer can prove freshness.
        assertEquals("2099-01-01T00:00:00.000Z", read(change(event(), "at", JsonPrimitive("2099-01-01T00:00:00.000Z"))).at)
    }

    @Test fun `private economic and unknown nested fields never enter presentation`() {
        for (field in listOf("wallet", "termHash", "request", "grossQuantity", "sourceProof"))
            refuses { read(JsonObject(event() + (field to JsonPrimitive("private")))) }
        for (path in listOf("vehicle.installationId", "wake.wallet", "wake.visual.enabled", "wake.visual.wake.owner"))
            refuses { read(change(event(wake = selected()), path, JsonPrimitive("private"))) }
        refuses { readBatch(JsonObject(batch(listOf(event())) + ("wallet" to JsonPrimitive("private")))) }
    }

    @Test fun `numeric primitive coercion and malformed original Wake bindings fail closed`() {
        for ((path, bad) in listOf("version" to JsonPrimitive("1"), "version" to JsonPrimitive(2), "kind" to JsonPrimitive("history"),
            "at" to JsonPrimitive(1), "wake.visual.version" to JsonPrimitive("1"),
            "wake.visual.wake.version" to JsonPrimitive("1"), "wake.visual.wake.sourceId" to JsonPrimitive("artisan-market-t1"),
            "wake.visual.wake.bindingSha256" to JsonPrimitive(123), "wake.visual.wake.sourceManifestSha256" to JsonPrimitive("bad")))
            refuses { read(change(event(wake = selected()), path, bad)) }
        refuses { readBatch(change(batch(listOf(event())), "version", JsonPrimitive("1"))) }
    }

    @Test fun `whole batch binding and family aware receipt dedup match shared identity domains`() {
        val departure = event(); val returned = event("return")
        val advanced = event(family = "survey_balloon", tier = 1)
        val valid = readBatch(batch(listOf(departure, returned, advanced)))
        assertEquals(3, valid.events.size)
        assertEquals(3, valid.events.map(::fleetJourneyEventKey).toSet().size)
        refuses { readBatch(batch(listOf(departure, departure))) }
        refuses { readBatch(batch(listOf(returned, change(returned, "expeditionId", JsonPrimitive(id(9)))))) }
        refuses { readBatch(batch(listOf(advanced, change(advanced, "vehicle.tier", JsonPrimitive(2))))) }
        refuses { readBatch(batch(listOf(departure, change(advanced, "baseId", JsonPrimitive(id(9)))))) }
        refuses { readBatch(batch(listOf(departure)), id(9)) }
        refuses { readBatch(batch(emptyList()), "not-a-uuid") }
        assertTrue(readBatch(batch(emptyList())).events.isEmpty())
    }

    @Test fun `parsed event list owns immutable data and decoder ceilings are not gameplay capacity`() {
        val inputs = arrayListOf<JsonElement>(event())
        val parsed = readBatch(batch(inputs)); inputs.clear()
        assertEquals(1, parsed.events.size)
        refuses { (parsed.events as MutableList<FleetJourneyEvent>).clear() }
        refuses { readBatch(batch(List(513) { event() })) }
        refuses { read(change(event(wake = selected()), "wake.visual.wake.bindingSha256", JsonPrimitive("a".repeat(257)))) }
        var deep: JsonElement = JsonNull
        repeat(13) { deep = buildJsonObject { put("next", deep) } }
        refuses { read(JsonObject(event() + ("extra" to deep))) }
    }
}
