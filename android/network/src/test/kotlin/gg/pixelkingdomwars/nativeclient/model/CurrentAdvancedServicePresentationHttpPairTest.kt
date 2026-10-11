package gg.pixelkingdomwars.nativeclient.model

import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Exact authenticated primary buildApp.inject /base bodies through normal native parsers.
 * The primary fixture establishes a genuinely overdue unreturned trip, then an accepted return;
 * it intentionally supplies no advanced collector to the app. Its encoded finalized chain,
 * historical initial clock and scaffolding are declared synthetic fixture inputs. This JVM
 * pairing is not native HTTP, Android pixels, art admission or a production runtime proof. */
class CurrentAdvancedServicePresentationHttpPairTest {
    private fun pair(): JsonObject {
        val bytes = requireNotNull(javaClass.getResource("/advanced/current-base-http-pair.json")).readBytes()
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertEquals("7319222336da771e9862de7d6874ea9ba809891966d4313a4f74266935343921", hash)
        return Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject.also {
            assertEquals(setOf("provenance", "overdueAway", "returned"), it.keys)
            assertEquals("normal-buildApp-authenticated-inject-response-bodies",
                it.getValue("provenance").jsonObject.getValue("kind").jsonPrimitive.content)
        }
    }
    private fun body(pair: JsonObject, name: String) =
        Json.parseToJsonElement(pair.getValue(name).jsonPrimitive.content).jsonObject
    private fun berths(raw: JsonObject) = raw.getValue("buildings").jsonArray.map { it.jsonObject }
        .filter { it.getValue("type").jsonPrimitive.content == "berth" }

    @Test fun `actual current base retains overdue away until accepted return while construction stays uninstalled`() {
        val pair = pair()
        val provenance = pair.getValue("provenance").jsonObject
        val berthId = provenance.getValue("berthId").jsonPrimitive.content
        val constructionId = provenance.getValue("constructionId").jsonPrimitive.content
        for ((name, presence) in listOf("overdueAway" to AdvancedPresence.AWAY, "returned" to AdvancedPresence.OCCUPIED)) {
            val raw = body(pair, name)
            val base = BaseSnapshot.from(raw)
            assertEquals(provenance.getValue("baseId").jsonPrimitive.content, base.baseId)
            assertEquals(provenance.getValue("wallet").jsonPrimitive.content, base.player.wallet)
            assertEquals(raw, base.raw)
            val advanced = requireNotNull(base.advancedServicePresentation)
            assertEquals(advanced, BaseServiceFacts.current(raw).advancedPresentation)
            val originalIds = berths(raw).map { it.getValue("id").jsonPrimitive.content }.sorted()
            assertEquals(listOf(berthId, constructionId).sorted(), originalIds)
            assertEquals(originalIds, advanced.berths.map { it.buildingId })
            assertEquals(AdvancedInstallationPresentation("survey_balloon", 1, presence),
                advanced.berths.single { it.buildingId == berthId }.installation)
            assertNull(advanced.berths.single { it.buildingId == constructionId }.installation)
            val construction = berths(raw).single { it.getValue("id").jsonPrimitive.content == constructionId }
            assertEquals(JsonPrimitive(true), construction["underConstruction"])
            assertEquals(JsonPrimitive(0), construction["level"])
            assertEquals(setOf("version", "berths"), raw.getValue("advancedServicePresentation").jsonObject.keys)
            for (row in raw.getValue("advancedServicePresentation").jsonObject.getValue("berths").jsonArray) {
                assertEquals(setOf("buildingId", "installation"), row.jsonObject.keys)
                if (row.jsonObject["installation"] != JsonNull)
                    assertEquals(setOf("family", "tier", "presence"), row.jsonObject.getValue("installation").jsonObject.keys)
            }
        }
        assertEquals(berths(body(pair, "overdueAway")), berths(body(pair, "returned")))
    }

    @Test fun `actual current construction allowance cannot weaken frozen facts or imply starter and art admission`() {
        val pair = pair()
        for (name in listOf("overdueAway", "returned")) {
            val raw = body(pair, name)
            val base = BaseSnapshot.from(raw)
            assertNotNull(base.advancedServicePresentation)
            val starter = requireNotNull(base.servicePresentation)
            assertEquals(base.advancedServicePresentation!!.berths.map { it.buildingId }, starter.berths.map { it.buildingId })
            assertTrue(starter.berths.all { it.installation == null })
            assertNull(base.phaseEArt)
            // Feed the unchanged current object to the historical entry on purpose.
            // It is not a captured raid and cannot pass frozen construction admission.
            assertNull(AdvancedServicePresentation.optional(raw["advancedServicePresentation"], raw))
            assertNull(BaseServiceFacts.frozen(raw, raw).advancedPresentation)
            assertNull(PresentationHead.from(raw).advancedServicePresentation)
            assertEquals(base.advancedServicePresentation, BaseServiceFacts.current(raw).advancedPresentation)
        }
    }
}
