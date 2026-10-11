package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BaseSnapshotJourneyCacheTest {
    @Test fun `every snapshot strips even malformed transient returns without discarding authoritative fields`() {
        val state = buildJsonObject {
            put("baseId", "00000000-0000-4000-8000-000000000001")
            put("player", buildJsonObject { put("keepLevel", 1) })
            put("freeBuilders", 3)
        }
        val values = listOf(JsonNull, JsonPrimitive("malformed"), JsonArray(emptyList()),
            buildJsonObject { put("version", 1); put("events", JsonArray(emptyList())) })
        for (value in values) {
            val original = JsonObject(state + ("fleetJourneyEvents" to value))
            val snapshot = BaseSnapshot.from(original)
            assertEquals(state, snapshot.raw)
            assertEquals(3, snapshot.freeBuilders)
            assertTrue("Stripping must not mutate the response still owned by readHome", original.containsKey("fleetJourneyEvents"))
        }
        assertSame("Ordinary legacy snapshots need no raw copy", state, BaseSnapshot.from(state).raw)
    }
}
