package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Transport fixtures: no source/ownership, HTTP or Android rendering claim. */
class StarterServicePresentationAssemblyTest {
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val berth = "22222222-2222-4222-8222-222222222222"
    private val priorRevision = "a".repeat(64)
    private val revision = "b".repeat(64)
    private fun event(tick: Int) = buildJsonObject { put("t", tick); put("e", "pos") }
    private fun facts(presence: String?) = buildJsonObject {
        put("version", 1)
        put("berths", buildJsonArray { add(buildJsonObject {
            put("buildingId", berth)
            put("installation", presence?.let { buildJsonObject { put("family", "starter"); put("presence", it) } } ?: JsonNull)
        }) })
    }
    private fun metadata(facts: JsonElement?, terminal: Boolean = false) = buildJsonObject {
        put("source", if (terminal) "archive" else "live"); put("status", if (terminal) "resolved" else "pending_orders")
        put("simVersion", 14); put("raidProtocolVersion", 2); put("clock", JsonNull); put("lastSequence", -1)
        put("snapshot", buildJsonObject { put("buildings", buildJsonArray { add(buildJsonObject {
            put("id", berth); put("type", "berth"); put("level", 1); put("tx", 0); put("ty", 0)
        }) }) })
        put("armySnapshot", buildJsonObject {}); put("commands", JsonArray(emptyList())); put("result", JsonNull)
        if (facts != null) put("servicePresentation", facts)
    }
    private fun parent(facts: JsonElement?) = JsonObject(metadata(facts) + mapOf(
        "revision" to JsonPrimitive(priorRevision), "events" to JsonArray(listOf(event(0)))))
    private fun page(facts: JsonElement?, parent: String? = priorRevision, terminal: Boolean = false,
                     newRevision: String = revision) = buildJsonObject {
        put("protocolVersion", 2); put("raidId", raid); put("revision", newRevision); put("generation", "c".repeat(32))
        put("parentRevision", parent?.let(::JsonPrimitive) ?: JsonNull); put("replaceFromTick", if (parent == null) 0 else 2)
        put("eventOffset", 0); put("totalEvents", 1); put("events", JsonArray(listOf(event(2))))
        put("commandOffset", 0); put("totalCommands", 0); put("commands", JsonArray(emptyList()))
        put("nextCursor", JsonNull); put("state", metadata(facts, terminal))
    }
    private fun assembly(parent: JsonObject?) = PresentationAssembly(raid, 14, parent, 50, 262_144, 10)

    @Test fun `a suffix preserves original occupied away unavailable and legacy facts unchanged`() {
        for (value in listOf(null, JsonNull, facts(null), facts("occupied"), facts("away"))) {
            val assembly = assembly(parent(value))
            assembly.accept(page(value))
            val result = assembly.complete()
            assertEquals(value, result["servicePresentation"])
            assertEquals(value != null, result.containsKey("servicePresentation"))
            assertEquals(listOf(0, 2), result.objects("events").map { it.battleInt("t") })
        }
    }

    @Test fun `changed fleet facts cannot relabel events retained from any different parent`() {
        val values = listOf(null, JsonNull, facts(null), facts("occupied"), facts("away"))
        for (before in values) for (after in values) if (before != after) {
            assertThrows(PresentationParentMismatch::class.java) { assembly(parent(before)).accept(page(after)) }
        }
    }

    @Test fun `a complete reset discards the earlier timeline before accepting different facts`() {
        val assembly = assembly(parent(facts("away")))
        assembly.accept(page(facts("occupied"), parent = null))
        val result = assembly.complete()
        assertEquals(facts("occupied"), result["servicePresentation"])
        assertEquals(listOf(2), result.objects("events").map { it.battleInt("t") })
    }

    @Test fun `ordinary observer refreshes changed frozen facts without emitting a mixed suffix`() = runBlocking {
        var reads = 0
        val requestedQueries = mutableListOf<Map<String, String>>()
        val api = BattlePresentation({ path, query ->
            if (path == "/native/capabilities") buildJsonObject { put("presentation", buildJsonObject {
                put("enabled", true); put("protocolVersions", JsonArray(listOf(JsonPrimitive(2)))); put("maxWaitMs", 15_000)
                put("maxEvents", 50); put("maxCommands", 10); put("maxPageBytes", 262_144)
            }) } else {
                requestedQueries += query.toMap()
                when (reads++) {
                    0 -> page(facts("away"), parent = null, newRevision = priorRevision)
                    1 -> page(facts("occupied"), terminal = true)
                    2 -> page(facts("occupied"), parent = null, terminal = true)
                    else -> error("Unbounded refresh")
                }
            }
        }, 14, {})
        val received = api.observe(raid).toList()
        assertEquals(3, reads)
        assertEquals(listOf(facts("away"), facts("occupied")), received.map { it["servicePresentation"] })
        assertTrue(received.all { it.objects("events").map { e -> e.battleInt("t") } == listOf(2) })
        assertEquals(priorRevision, requestedQueries[1]["afterRevision"])
        assertFalse(requestedQueries.last().containsKey("afterRevision"))
    }
}
