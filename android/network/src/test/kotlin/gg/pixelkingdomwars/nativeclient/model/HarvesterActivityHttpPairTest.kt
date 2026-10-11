package gg.pixelkingdomwars.nativeclient.model

import java.security.MessageDigest
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Literal authenticated primary buildApp.inject bodies from an owner DB fixture.
 * Actual private source admission/settlement and protected reads use synthetic
 * facilities, original term/finality and a historical Date-only fixture clock.
 * This is JVM parsing, not restricted-login, native HTTP, pixels or art admission. */
class HarvesterActivityHttpPairTest {
    private fun pair(): JsonObject {
        val bytes = requireNotNull(javaClass.getResource("/harvester-activity/current-base-http-pair.json")).readBytes()
        assertEquals(108735, bytes.size)
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertEquals("4c0e8a09e9996c4584f8f510cb6af79feba007941b19d616ea176a08b1a6b180", hash)
        return Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject.also {
            assertEquals(setOf("provenance", "working", "idle"), it.keys)
            assertEquals("normal-buildApp-authenticated-inject-response-bodies",
                it.getValue("provenance").jsonObject.getValue("kind").jsonPrimitive.content)
        }
    }
    private fun body(pair: JsonObject, name: String): JsonObject =
        Json.parseToJsonElement(pair.getValue(name).jsonPrimitive.content).jsonObject

    @Test fun `actual working body binds the exact completed Harvester source and preserves other current facts`() {
        val pair = pair()
        val provenance = pair.getValue("provenance").jsonObject
        val raw = body(pair, "working")
        val base = BaseSnapshot.from(raw)
        val harvesterId = provenance.getValue("harvesterId").jsonPrimitive.content
        assertEquals(provenance.getValue("baseId").jsonPrimitive.content, base.baseId)
        assertEquals(provenance.getValue("wallet").jsonPrimitive.content, base.player.wallet)
        assertEquals(raw, base.raw)
        assertEquals(VisualContext.of(raw), base.visualContext)
        val activity = requireNotNull(base.serviceActivity)
        assertEquals(activity, BaseServiceFacts.current(raw).activity)
        val services = base.buildings.filter { it.type in setOf("workshop", "lodge", "market", "harvester") }
        assertEquals(services.map { it.id }.sorted(), activity.services.map { it.buildingId })
        val facility = services.single { it.id == harvesterId }
        assertEquals("harvester", facility.type)
        assertFalse(facility.underConstruction)
        assertTrue(facility.level > 0)
        val harvesters = raw.getValue("harvesters").jsonObject
        val source = harvesters.getValue("source").jsonObject
        assertEquals(base.baseId, source.getValue("baseId").jsonPrimitive.content)
        assertEquals(harvesterId, source.getValue("harvesterId").jsonPrimitive.content)
        assertEquals(source, harvesters["walletSource"])
        val sourceFacility = harvesters.getValue("facilities").jsonArray.single().jsonObject
        assertEquals(source["baseId"], sourceFacility["baseId"])
        assertEquals(source["harvesterId"], sourceFacility["harvesterId"])
        assertTrue(sourceFacility.getValue("completedBuildJobId").jsonPrimitive.content.isNotEmpty())
        assertEquals(Instant.parse(source.getValue("leaseExpiresAt").jsonPrimitive.content).minusMillis(1),
            Instant.parse(harvesters.getValue("serverNow").jsonPrimitive.content))
        // This capture contains a Lodge, not a Workshop; no coexistence fact is invented.
        val lodge = services.single { it.type == "lodge" }
        assertEquals(ServiceActivityState.IDLE, activity.services.single { it.buildingId == lodge.id }.state)
        for (service in activity.services) {
            assertEquals(if (service.buildingId == harvesterId) ServiceActivityState.WORKING else ServiceActivityState.IDLE,
                service.state)
            assertNotEquals(ServiceActivityState.READY, service.state)
        }
        // Activity is a redacted current observation, not an economic/readiness payload.
        assertEquals(setOf("version", "services"), raw.getValue("serviceActivity").jsonObject.keys)
        for (row in raw.getValue("serviceActivity").jsonObject.getValue("services").jsonArray)
            assertEquals(setOf("buildingId", "state"), row.jsonObject.keys)
        assertNull(base.phaseEArt)
    }

    @Test fun `actual exclusive expiry body is idle while retaining the same original head and current siblings`() {
        val pair = pair()
        val working = body(pair, "working")
        val idle = body(pair, "idle")
        val before = BaseSnapshot.from(working)
        val after = BaseSnapshot.from(idle)
        assertEquals(before.baseId, after.baseId)
        assertEquals(before.player.wallet, after.player.wallet)
        assertEquals(idle, after.raw)
        assertEquals(before.buildings, after.buildings)
        assertEquals(before.visualContext, after.visualContext)
        assertEquals(before.servicePresentation, after.servicePresentation)
        assertEquals(before.advancedServicePresentation, after.advancedServicePresentation)
        assertEquals(working["boundCosmetics"], idle["boundCosmetics"])
        assertEquals(working["ordinaryCrafting"], idle["ordinaryCrafting"]?.let { current ->
            // Only its sampled serverNow may advance; jobs remain the same.
            JsonObject(current.jsonObject + ("serverNow" to working.getValue("ordinaryCrafting").jsonObject.getValue("serverNow")))
        })
        val workingSource = working.getValue("harvesters").jsonObject
        val idleSource = idle.getValue("harvesters").jsonObject
        assertEquals(workingSource["source"], idleSource["source"])
        assertEquals(workingSource["walletSource"], idleSource["walletSource"])
        assertEquals(workingSource["facilities"], idleSource["facilities"])
        assertEquals(idleSource.getValue("source").jsonObject["leaseExpiresAt"], idleSource["serverNow"])
        val activity = requireNotNull(after.serviceActivity)
        assertEquals(activity, BaseServiceFacts.current(idle).activity)
        assertEquals(requireNotNull(before.serviceActivity).services.map { it.buildingId }, activity.services.map { it.buildingId })
        assertTrue(activity.services.all { it.state == ServiceActivityState.IDLE })
        assertNull(after.phaseEArt)
        // These are two server observations. No client deadline or return policy is executed.
        assertEquals(1L, Instant.parse(idleSource.getValue("serverNow").jsonPrimitive.content).toEpochMilli()
            - Instant.parse(workingSource.getValue("serverNow").jsonPrimitive.content).toEpochMilli())
    }
}
