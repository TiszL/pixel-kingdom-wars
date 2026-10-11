package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic protocol fixtures only; actual primary response pairing is separate. */
class AdvancedServicePresentationAssemblyTest {
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val berth = "22222222-2222-4222-8222-222222222222"
    private val priorRevision = "a".repeat(64)
    private val revision = "b".repeat(64)
    private fun event(tick: Int) = buildJsonObject { put("t", tick); put("e", "pos") }
    private fun facts(family: String = "survey_balloon", tier: Int = 1, presence: String? = "occupied") = buildJsonObject {
        put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
            put("buildingId", berth); put("installation", presence?.let { buildJsonObject {
                put("family", family); put("tier", tier); put("presence", it)
            } } ?: JsonNull)
        }) })
    }
    private fun metadata(advanced: JsonElement?, terminal: Boolean = false) = buildJsonObject {
        put("source", if (terminal) "archive" else "live"); put("status", if (terminal) "resolved" else "pending_orders")
        put("simVersion", 17); put("raidProtocolVersion", 2); put("clock", JsonNull); put("lastSequence", -1)
        put("snapshot", buildJsonObject { put("buildings", buildJsonArray { add(buildJsonObject {
            put("id", berth); put("type", "berth"); put("level", 1); put("tx", 0); put("ty", 0)
        }) }) })
        put("armySnapshot", buildJsonObject {}); put("commands", JsonArray(emptyList())); put("result", JsonNull)
        put("servicePresentation", buildJsonObject { put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
            put("buildingId", berth); put("installation", JsonNull)
        }) }) })
        if (advanced != null) put("advancedServicePresentation", advanced)
    }
    private fun parent(advanced: JsonElement?) = JsonObject(metadata(advanced) + mapOf(
        "revision" to JsonPrimitive(priorRevision), "events" to JsonArray(listOf(event(0)))))
    private fun page(advanced: JsonElement?, parent: String? = priorRevision, terminal: Boolean = false,
                     newRevision: String = revision) = buildJsonObject {
        put("protocolVersion", 2); put("raidId", raid); put("revision", newRevision); put("generation", "c".repeat(32))
        put("parentRevision", parent?.let(::JsonPrimitive) ?: JsonNull); put("replaceFromTick", if (parent == null) 0 else 2)
        put("eventOffset", 0); put("totalEvents", 1); put("events", JsonArray(listOf(event(2))))
        put("commandOffset", 0); put("totalCommands", 0); put("commands", JsonArray(emptyList()))
        put("nextCursor", JsonNull); put("state", metadata(advanced, terminal))
    }
    private fun assembly(parent: JsonObject?) = PresentationAssembly(raid, 17, parent, 50, 262_144, 10)
    private fun variants() = listOf(null, JsonNull, facts(presence = null), facts(), facts(tier = 2),
        facts(family = "cargo_cutter"), facts(presence = "away"), facts(presence = "exhausted"))

    @Test fun `unchanged original advanced facts preserve a suffix including absent null and no advanced states`() {
        for (value in variants()) {
            val old = parent(value)
            val assembly = assembly(old)
            assembly.accept(page(value))
            val result = assembly.complete()
            assertEquals(value, result["advancedServicePresentation"])
            assertEquals(value != null, result.containsKey("advancedServicePresentation"))
            assertEquals(old["servicePresentation"], result["servicePresentation"])
            assertEquals(listOf(0, 2), result.objects("events").map { it.battleInt("t") })
        }
    }

    @Test fun `family tier presence null and absence changes cannot relabel retained parent events`() {
        for (before in variants()) for (after in variants()) if (before != after) {
            val assembly = assembly(parent(before))
            assertThrows(PresentationParentMismatch::class.java) { assembly.accept(page(after)) }
            assertThrows(IllegalStateException::class.java) { assembly.complete() }
        }
    }

    @Test fun `a complete reset discards the old timeline before publishing different advanced facts`() {
        val changed = facts(family = "expedition_barge", tier = 4, presence = "exhausted")
        val assembly = assembly(parent(facts(presence = "away")))
        assembly.accept(page(changed, parent = null, terminal = true))
        val result = assembly.complete()
        assertEquals(changed, result["advancedServicePresentation"])
        assertEquals(listOf(2), result.objects("events").map { it.battleInt("t") })
        assertEquals("archive", result.battleString("source"))
    }

    @Test fun `ordinary observer forces a full refresh for changed advanced family tier or presence`() = runBlocking {
        for (changed in listOf(facts(family = "cargo_cutter"), facts(tier = 4), facts(presence = "exhausted"))) {
            var reads = 0
            val queries = mutableListOf<Map<String, String>>()
            val api = BattlePresentation({ path, query ->
                if (path == "/native/capabilities") buildJsonObject { put("presentation", buildJsonObject {
                    put("enabled", true); put("protocolVersions", JsonArray(listOf(JsonPrimitive(2)))); put("maxWaitMs", 15_000)
                    put("maxEvents", 50); put("maxCommands", 10); put("maxPageBytes", 262_144)
                }) } else {
                    queries += query.toMap()
                    when (reads++) {
                        0 -> page(facts(), parent = null, newRevision = priorRevision)
                        1 -> page(changed, terminal = true)
                        2 -> page(changed, parent = null, terminal = true)
                        else -> error("Unbounded advanced refresh")
                    }
                }
            }, 17, {})
            val received = api.observe(raid).toList()
            assertEquals(3, reads)
            assertEquals(listOf(facts(), changed), received.map { it["advancedServicePresentation"] })
            assertTrue(received.all { it.objects("events").map { e -> e.battleInt("t") } == listOf(2) })
            assertEquals(priorRevision, queries[1]["afterRevision"])
            assertFalse(queries.last().containsKey("afterRevision"))
        }
    }
}
