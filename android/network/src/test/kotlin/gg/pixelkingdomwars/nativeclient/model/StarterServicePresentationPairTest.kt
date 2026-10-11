package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Exact normal authenticated primary response bodies. The source declares
 * synthetic facilities/terms and a test clock, with real install/dispatch/return.
 * This is parser pairing, not an Android render or a native HTTP call. */
class StarterServicePresentationPairTest {
    @Test fun `normal primary occupied away and returned bytes preserve one installation without art admission`() {
        val pair = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/starter/service-presentation-http-pair.json")).readText()).jsonObject
        val source = pair.getValue("source").jsonObject
        val baseId = source.getValue("baseId").jsonPrimitive.content
        val berthId = source.getValue("berthId").jsonPrimitive.content
        val installationId = source.getValue("installationId").jsonPrimitive.content
        for ((name, presence) in listOf("occupied" to StarterPresence.OCCUPIED, "away" to StarterPresence.AWAY, "returned" to StarterPresence.OCCUPIED)) {
            val raw = Json.parseToJsonElement(pair.getValue(name).jsonPrimitive.content).jsonObject
            assertEquals(baseId, raw.getValue("baseId").jsonPrimitive.content)
            val fleet = raw.getValue("starterFleet").jsonObject.getValue("installation").jsonObject
            assertEquals(installationId, fleet.getValue("installationId").jsonPrimitive.content)
            assertEquals(berthId, fleet.getValue("berthId").jsonPrimitive.content)
            val parsed = BaseSnapshot.from(raw)
            assertEquals(listOf(BerthPresentation(berthId, StarterPresentation("starter", presence))), parsed.servicePresentation?.berths)
            assertNull(parsed.phaseEArt)
            val wire = raw.getValue("servicePresentation").jsonObject
            assertEquals(setOf("version", "berths"), wire.keys)
            assertEquals(setOf("buildingId", "installation"), wire.getValue("berths").jsonArray.single().jsonObject.keys)
            val flight = raw.getValue("starterExpeditions").jsonObject.getValue("flight")
            assertEquals(name == "away", flight != JsonNull)
        }
    }
}
