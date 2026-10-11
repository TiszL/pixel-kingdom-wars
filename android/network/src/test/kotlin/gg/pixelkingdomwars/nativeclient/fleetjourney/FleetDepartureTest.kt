package gg.pixelkingdomwars.nativeclient.fleetjourney

import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Existing literal primary originals/sidecars; synthetic HTTP metadata and
 * starter fleet reconstruction are explicit, not a new server/renderer capture. */
class FleetDepartureTest {
    private val pair = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/boundcosmetics/wake-sidecar-primary-pair.json")).readText()).jsonObject
    private fun sample(kind: String, state: String = "selected") = pair.getValue(kind).jsonObject.getValue(state).jsonObject
    private fun fresh(kind: String, sample: JsonObject = sample(kind)): FreshFleetDeparture = requireNotNull(
        FreshFleetDeparture.fromResponse("POST", if (kind == "starter") "/starter-expeditions" else "/advanced-expeditions",
            201, listOf("1"), sample.getValue("original").jsonObject))
    private fun starterFleet(s: JsonObject): JsonObject {
        val original = starterJson.decodeFromJsonElement(StarterExpeditionProof.serializer(), s.getValue("original"))
        val receipt = requireNotNull(original.receipt)
        val installed = StarterFleetInstallation(receipt.installationId, receipt.request.baseId,
            "00000000-0000-4000-8000-000000000081", "starter", "00000000-0000-4000-8000-000000000082", receipt.departedAt, receipt.departedAt)
        val view = StarterExpeditionView(original.wallet, receipt.request.baseId, receipt.departedAt,
            StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true, null, emptyList(), installed, receipt.flight(), null,
            starterResourceRealms.keys.map { OrdinaryRawStock(it, "0", "0", "0") })
        return starterJson.encodeToJsonElement(StarterExpeditionView.serializer(), view).jsonObject
    }
    private fun bind(kind: String, s: JsonObject = sample(kind), sidecar: JsonObject = s.getValue("sidecar").jsonObject,
        current: JsonObject = s.getValue("current").jsonObject): FleetJourneyEvent {
        val proof = fresh(kind, s)
        return bindFreshFleetDeparture(proof, proof.wallet, sidecar, current,
            if (kind == "starter") starterFleet(s) else sample("advanced").getValue("fleet").jsonObject)
    }

    @Test fun `HTTP creation requires both exact markers and only the two departure POST routes`() {
        val raw = sample("starter").getValue("original").jsonObject
        assertNotNull(FreshFleetDeparture.fromResponse("POST", "/starter-expeditions", 201, listOf("1"), raw))
        for (status in listOf(200, 202, 409)) assertNull(FreshFleetDeparture.fromResponse("POST", "/starter-expeditions", status, listOf("1"), raw))
        for (headers in listOf(emptyList(), listOf("true"), listOf("1, 1"), listOf("1", "1")))
            assertNull(FreshFleetDeparture.fromResponse("POST", "/starter-expeditions", 201, headers, raw))
        for (path in listOf("/starter-expeditions/by-key/${fresh("starter").expeditionId}", "/advanced-expeditions/collect", "/ordinary-equipment/jobs", "/vehicles/craft/quote"))
            assertNull(FreshFleetDeparture.fromResponse("POST", path, 201, listOf("1"), raw))
        assertNull(FreshFleetDeparture.fromResponse("GET", "/starter-expeditions", 201, listOf("1"), raw))
        assertNull(FreshFleetDeparture.fromResponse("POST", "/starter-expeditions", 201, listOf("1"), JsonObject(raw + ("extra" to JsonPrimitive(true)))))
        assertNull(FreshFleetDeparture.fromResponse("POST", "/starter-expeditions", 201, listOf("1"), sample("starter").getValue("returnedOriginal").jsonObject))
    }

    @Test fun `actual selected original sidecars bind both families without exposing private original fields`() {
        for (kind in listOf("starter", "advanced")) {
            val event = bind(kind)
            assertEquals("departure", event.kind); assertEquals(fresh(kind).expeditionId, event.expeditionId)
            assertEquals("available", event.wake.state); assertNotNull(event.wake.visual?.wake)
            assertNull(event.returnId)
            val raw = Json.encodeToJsonElement(FleetJourneyEvent.serializer(), event).jsonObject
            assertFalse(raw.containsKey("wallet")); assertFalse(raw.containsKey("receipt")); assertFalse(raw.containsKey("termHash"))
        }
    }

    @Test fun `Off unavailable and legacy stay distinct while foreign current original and returned proofs refuse`() {
        for (state in listOf("default", "unavailable")) {
            val event = bind("starter", sample("starter", state))
            assertEquals(if (state == "default") "available" else "unavailable", event.wake.state)
            assertNull(event.wake.visual?.wake)
        }
        val s = sample("starter")
        fun legacy(raw: JsonObject, original: Boolean): JsonObject {
            val capture = buildJsonObject { put("state", "legacy"); put("visual", JsonNull) }
            return if (original) JsonObject(raw + ("presentation" to JsonObject(raw.getValue("presentation").jsonObject + ("wake" to capture))))
            else JsonObject(raw + ("trips" to JsonArray(raw.getValue("trips").jsonArray.map { JsonObject(it.jsonObject + ("wake" to capture)) })))
        }
        assertEquals("legacy", bind("starter", s, legacy(s.getValue("sidecar").jsonObject, true), legacy(s.getValue("current").jsonObject, false)).wake.state)
        assertThrows(Exception::class.java) { bind("starter", s, s.getValue("returnedSidecar").jsonObject) }
        assertThrows(Exception::class.java) { bind("starter", s, current = s.getValue("afterReturnCurrent").jsonObject) }
        val side = s.getValue("sidecar").jsonObject
        assertThrows(Exception::class.java) { bind("starter", s, JsonObject(side + ("wallet" to JsonPrimitive("11111111111111111111111111111112")))) }
        val receipt = fresh("starter")
        val fleet = starterFleet(s)
        assertThrows(Exception::class.java) { bindFreshFleetDeparture(receipt, receipt.wallet, side, s.getValue("current").jsonObject,
            JsonObject(fleet + ("baseId" to JsonPrimitive("00000000-0000-4000-8000-000000000099")))) }
    }

    @Test fun `advanced departure refuses a replaced family tier installation or no longer away fleet`() {
        val s = sample("advanced"); val proof = fresh("advanced"); val fleet = s.getValue("fleet").jsonObject
        val original = fleet.getValue("vehicles").jsonArray.single().jsonObject
        for ((field, value) in listOf("family" to JsonPrimitive("cargo_cutter"), "tier" to JsonPrimitive(2),
            "installationId" to JsonPrimitive("00000000-0000-4000-8000-000000000099"), "away" to JsonPrimitive(false))) {
            val changed = JsonObject(fleet + ("vehicles" to JsonArray(listOf(JsonObject(original + (field to value))))))
            assertThrows(Exception::class.java) { bindFreshFleetDeparture(proof, proof.wallet, s.getValue("sidecar").jsonObject, s.getValue("current").jsonObject, changed) }
        }
    }

    @Test fun `capture precedes command and stale or failed optional delivery cannot become a command failure`() = runBlocking {
        val proof = fresh("starter"); var visible = true; var delivered = 0
        val observer = captureFleetDeparture({ _, _ -> val captured = visible; { _: FreshFleetDeparture -> if (captured && visible) delivered++ } },
            "POST", "/starter-expeditions", proof.receipt.getValue("request").jsonObject, {})
        visible = false; deliverFleetDeparture(proof, {}, observer); assertEquals(0, delivered)
        deliverFleetDeparture(proof, { error("stale") }) { delivered++ }; assertEquals(0, delivered)
        deliverFleetDeparture(proof, {}) { error("optional sidecar failed") }
        deliverFleetDeparture(proof, {}) { withTimeout(1) { delay(100) } }
        assertNull(captureFleetDeparture({ _, _ -> error("optional capture failed") }, "POST", "/starter-expeditions", proof.receipt.getValue("request").jsonObject, {}))
        assertNull(captureFleetDeparture({ _, _ -> error("GET must never capture") }, "GET", "/starter-expeditions", null, {}))
    }
}
