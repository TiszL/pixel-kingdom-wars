package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

/** CONTINUITY: the strict current-only identity parser against root's genuine current HTTP pair (advanced away/returned bodies
 *  with a genuine starter installation in the same base). The fixture is root's exact bytes; nothing here is manufactured. */
class CurrentFleetIdentityTest {
    private val pair = Json.parseToJsonElement(javaClass.getResource("/advanced/current-fleet-identity-http.json")!!.readText()).jsonObject
    private val provenance = pair.getValue("provenance").jsonObject
    private fun body(key: String): JsonObject = Json.parseToJsonElement(pair.getValue(key).jsonPrimitive.content).jsonObject
    private fun identityOf(raw: JsonObject): CurrentFleetIdentity? {
        val base = BaseSnapshot.from(raw)
        return CurrentFleetIdentity.current(base.raw, base.baseId, base.servicePresentation, base.advancedServicePresentation)
    }

    @Test fun `genuine away and returned bodies yield the exact advanced and starter installations of the same response`() {
        for (key in listOf("away", "returned")) {
            val raw = body(key); val parsed = identityOf(raw); assertNotNull(parsed); val identity = requireNotNull(parsed)
            val advanced = requireNotNull(identity.installation(provenance.getValue("advancedBerthId").jsonPrimitive.content))
            assertEquals(provenance.getValue("advancedInstallationId").jsonPrimitive.content, advanced.installationId)
            assertEquals("survey_balloon", advanced.family); assertEquals(1, advanced.tier)
            val starter = requireNotNull(identity.installation(provenance.getValue("starterBerthId").jsonPrimitive.content))
            assertEquals(provenance.getValue("starterInstallationId").jsonPrimitive.content, starter.installationId)
            assertEquals("starter", starter.family); assertNull(starter.tier)
            assertEquals(2, identity.installations.size)
        }
    }

    @Test fun `a malformed or contradictory optional identity refuses continuity without failing the base read`() {
        val raw = body("returned"); val base = BaseSnapshot.from(raw)
        assertNotNull(base.advancedServicePresentation) // the ordinary read is intact
        val sibling = raw.getValue("advancedFleetIdentity").jsonObject
        fun mutated(identity: JsonObject?) = JsonObject(raw.toMutableMap().apply { if (identity == null) remove("advancedFleetIdentity") else put("advancedFleetIdentity", identity) })
        assertNull("absent sibling with an installed berth", identityOf(mutated(null)))
        assertNull("wrong version", identityOf(mutated(JsonObject(sibling + ("version" to JsonPrimitive(2))))))
        val berths = sibling.getValue("berths")
        assertNull("extra key", identityOf(mutated(buildJsonObject { put("version", 1); put("berths", berths); put("extra", true) })))
        val starterless = JsonObject(raw.toMutableMap().apply { put("starterFleet", buildJsonObject { put("installation", kotlinx.serialization.json.JsonNull) }) })
        assertNull("occupied starter berth without its identity", identityOf(starterless))
    }
}
