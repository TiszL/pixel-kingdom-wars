package gg.pixelkingdomwars.nativeclient.model

import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Unedited authenticated primary buildApp.inject bodies, parsed on the JVM.
 * The producing fixture declares synthetic raw materials/completed facilities and
 * a historical Date-only clock. It exercises actual ordinary admission, owner
 * precollection, restricted request-role reads and automatic completion. This is
 * not a native HTTP connection, Android rendering or art/readiness admission. */
class ServiceActivityHttpPairTest {
    private fun pair(): JsonObject {
        val bytes = requireNotNull(javaClass.getResource("/service-activity/current-base-http-pair.json")).readBytes()
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertEquals("eed197614d142bc96aa9a367ea2ddb50fd28dda9731c97aeb241729fc478ee63", hash)
        return Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject.also {
            assertEquals(setOf("provenance", "working", "idle"), it.keys)
            assertEquals("normal-buildApp-authenticated-inject-response-bodies",
                it.getValue("provenance").jsonObject.getValue("kind").jsonPrimitive.content)
        }
    }
    private fun body(pair: JsonObject, name: String): JsonObject =
        Json.parseToJsonElement(pair.getValue(name).jsonPrimitive.content).jsonObject
    private fun stock(raw: JsonObject, itemId: String): JsonObject = raw.getValue("craftingStock").jsonArray
        .map { it.jsonObject }.single { it.getValue("itemId").jsonPrimitive.content == itemId }
    private fun amount(row: JsonObject, key: String) = row.getValue(key).jsonPrimitive.content.toBigInteger()

    @Test fun `actual current bodies bind the working Workshop and automatic inventory completion without ready`() {
        val pair = pair()
        val provenance = pair.getValue("provenance").jsonObject
        val workshopId = provenance.getValue("workshopId").jsonPrimitive.content
        val working = body(pair, "working")
        val idle = body(pair, "idle")
        for ((name, raw) in listOf("working" to working, "idle" to idle)) {
            val base = BaseSnapshot.from(raw)
            assertEquals(provenance.getValue("baseId").jsonPrimitive.content, base.baseId)
            assertEquals(provenance.getValue("wallet").jsonPrimitive.content, base.player.wallet)
            assertEquals(raw, base.raw)
            val activity = requireNotNull(base.serviceActivity)
            assertEquals(activity, BaseServiceFacts.current(raw).activity)
            val currentServices = raw.getValue("buildings").jsonArray.map { it.jsonObject }
                .filter { it.getValue("type").jsonPrimitive.content in setOf("workshop", "lodge", "market", "harvester") }
                .associateBy { it.getValue("id").jsonPrimitive.content }
            assertEquals(currentServices.keys.sorted(), activity.services.map { it.buildingId })
            assertEquals("workshop", currentServices.getValue(workshopId).getValue("type").jsonPrimitive.content)
            assertEquals(setOf("version", "services"), raw.getValue("serviceActivity").jsonObject.keys)
            for (row in raw.getValue("serviceActivity").jsonObject.getValue("services").jsonArray)
                assertEquals(setOf("buildingId", "state"), row.jsonObject.keys)
            for (service in activity.services) {
                assertEquals(if (name == "working" && service.buildingId == workshopId)
                    ServiceActivityState.WORKING else ServiceActivityState.IDLE, service.state)
                assertNotEquals(ServiceActivityState.READY, service.state)
            }
        }
        assertEquals(working["buildings"], idle["buildings"])
        val pending = working.getValue("ordinaryCrafting").jsonObject.getValue("pendingJobs").jsonArray.single().jsonObject
        val output = pending.getValue("recipe").jsonObject.getValue("output").jsonObject
        val itemId = output.getValue("itemId").jsonPrimitive.content
        val quantity = amount(output, "quantity")
        val before = stock(working, itemId)
        val after = stock(idle, itemId)
        assertTrue(idle.getValue("ordinaryCrafting").jsonObject.getValue("pendingJobs").jsonArray.isEmpty())
        assertEquals(quantity, amount(after, "available") - amount(before, "available"))
        assertEquals(quantity, amount(before, "pendingOutput") - amount(after, "pendingOutput"))
        assertEquals(pending["readyAt"], idle.getValue("ordinaryCrafting").jsonObject["serverNow"])
    }

    @Test fun `actual current activity cannot supply frozen raid facts or an art capability`() {
        val pair = pair()
        for (name in listOf("working", "idle")) {
            val raw = body(pair, name)
            assertNotNull(BaseSnapshot.from(raw).serviceActivity)
            assertNull(BaseSnapshot.from(raw).phaseEArt)
            // Feed the unchanged current body to the historical boundary on purpose.
            // This is an isolation assertion, not a captured raid/archive response.
            for (snapshot in listOf(raw, null)) {
                val frozen = BaseServiceFacts.frozen(raw, snapshot)
                assertNull(frozen.activity)
                assertNull(frozen.phaseEArt)
            }
            // Parsing a historical request never mutates the original current observation.
            assertEquals(BaseServiceFacts.current(raw).activity, BaseSnapshot.from(raw).serviceActivity)
        }
    }
}
