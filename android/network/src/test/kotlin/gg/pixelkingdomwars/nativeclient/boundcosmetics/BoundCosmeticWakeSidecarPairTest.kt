package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Actual isolated primary source DTOs, including its authenticated sidecar and
 * restricted unfitted recovery checks. Local chain/term fixtures are explicit.
 * These are captured JSON objects, not separately captured HTTP response bytes,
 * and establish neither native transport nor renderer/device admission. */
class BoundCosmeticWakeSidecarPairTest {
    private fun capture(): JsonObject {
        val bytes = requireNotNull(javaClass.getResourceAsStream("/boundcosmetics/wake-sidecar-primary-pair.json")).use { it.readBytes() }
        assertEquals("caafa33122c9f1bf660f2440cfb80d3525927e1c59eb4e16def2baeb13087ec9",
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) })
        return Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject.also {
            assertEquals("local_private_primary_v1_sidecar_fixture", it.charterObject("provenance").charterText("kind"))
            assertEquals(JsonPrimitive(true), it.charterObject("provenance")["actualAuthenticatedRuntime"])
            assertEquals(JsonPrimitive(true), it.charterObject("provenance")["restrictedUnfittedOriginal"])
        }
    }
    private fun sidecar(row: JsonObject, field: String = "sidecar"): BoundCosmeticWakeOriginalEnvelope {
        val raw = row.charterObject(field); val original = row.charterObject("original")
        return BoundCosmeticWakeOriginalEnvelope.from(raw, original.charterText("wallet"), raw.charterText("kind"), original.charterText("idempotencyKey"))
    }
    private fun current(row: JsonObject, field: String = "current"): BoundCosmeticWakeCurrentEnvelope {
        val raw = row.charterObject(field); val original = row.charterObject("original")
        return BoundCosmeticWakeCurrentEnvelope.from(raw, original.charterText("wallet"), original.charterObject("receipt").charterObject("request").charterText("baseId"))
    }
    private fun originalGrammar(raw: JsonObject): StarterExpeditionProof {
        // No installation snapshot exists in selected/legacy capture; validate the
        // unchanged strict grammar and flight, without inventing a saved command.
        boundedStarterHistory(raw); starterPrimitives(raw, StarterExpeditionProof.serializer().descriptor)
        return starterJson.decodeFromJsonElement<StarterExpeditionProof>(raw).also { requireNotNull(it.receipt).flight().validate() }
    }
    private fun compare(row: JsonObject, name: String) {
        val original = row.charterObject("original").charterObject("receipt")
        assertFalse(original.containsKey("boundCosmeticWake"))
        val separate = sidecar(row); val p = requireNotNull(separate.presentation)
        assertEquals(original.charterText("expeditionId"), p.expeditionId)
        assertEquals(original.charterText("installationId"), p.installationId)
        assertEquals(original.charterText("departedAt"), p.departedAt)
        assertEquals(original.charterText("returnsAt"), p.returnsAt)
        assertEquals(original.charterObject("route").charterText("realmId"), p.realmId)
        when (name) {
            "selected" -> assertEquals("aurora_wake", p.wake.visual!!.wake!!.outputId)
            "default" -> { assertEquals("available", p.wake.state); assertNull(p.wake.visual!!.wake) }
            "legacy" -> { assertEquals("legacy", p.wake.state); assertNull(p.wake.visual) }
            else -> { assertEquals("unavailable", p.wake.state); assertNull(p.wake.visual) }
        }
        val active = current(row).trips.single()
        assertEquals(p.wake, active.wake); assertEquals(p.expeditionId, active.expeditionId)
        assertEquals(p.installationId, active.installationId); assertEquals(p.homeRealmId, active.homeRealmId)
        if ("returnedSidecar" in row) {
            val returned = sidecar(row, "returnedSidecar")
            assertEquals(p, returned.presentation); assertNull(separate.returnedAt)
            assertEquals(row.charterObject("returnedOriginal").charterObject("return").charterText("returnedAt"), returned.returnedAt)
            assertEquals(original, row.charterObject("returnedOriginal").charterObject("receipt"))
            // This capture transferred the base before the return observation.
            // Old actor history survives; current data belongs to its new owner.
            assertThrows(IllegalArgumentException::class.java) { current(row, "afterReturnCurrent") }
            val after = row.charterObject("afterReturnCurrent")
            assertNotEquals(separate.wallet, after.charterText("wallet"))
            assertTrue(BoundCosmeticWakeCurrentEnvelope.from(after, after.charterText("wallet"), p.baseId).trips.isEmpty())
        }
    }
    private class Memory : SecretStore {
        var value: String? = null
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun clear() = error("Original history is preserved")
    }
    @Test fun `actual starter sidecars preserve selection apart from unchanged originals and strict journals`() {
        val rows = capture().charterObject("starter")
        for (name in listOf("selected", "default", "unavailable")) {
            val row = rows.charterObject(name); compare(row, name)
            val parsed = originalGrammar(row.charterObject("original"))
            row["returnedOriginal"]?.let { assertEquals(parsed.receipt, originalGrammar(it.jsonObject).receipt) }
            row["view"]?.let { rawView ->
                val view = StarterExpeditionView.from(rawView.jsonObject)
                val command = StarterExpeditionCommand(parsed.receipt!!.request, parsed.receipt!!.route, requireNotNull(view.installation))
                val identity = StarterIdentity("https://sidecar-pair.test", "devnet", view.wallet)
                val proof = StarterExpeditionProof.from(row.charterObject("original"), identity, command)
                val disk = Memory(); val store = StarterExpeditionStore(disk, identity)
                store.begin(store.read(), command); store.accept(command, proof)
                assertEquals(proof, StarterExpeditionStore(disk, identity).read().operation!!.proof)
                assertFalse(requireNotNull(disk.value).contains("boundCosmeticWake"))
            }
        }
    }
    @Test fun `actual advanced sidecars preserve immutable trip presentation through actual recorded return`() {
        val rows = capture().charterObject("advanced")
        for (name in listOf("selected", "default", "unavailable")) {
            val row = rows.charterObject(name); compare(row, name)
            val original = VehicleProtocol.expedition(row.charterObject("original"))
            row["returnedOriginal"]?.let { assertEquals(original["receipt"], VehicleProtocol.expedition(it.jsonObject)["receipt"]) }
            row["fleet"]?.let { rawFleet ->
                val vehicle = VehicleProtocol.fleet(rawFleet.jsonObject)["vehicles"]!!.jsonArray.single().jsonObject
                // Legacy fleet exposes only the installation's away state. The
                // trip details live in the separately requested v1 sidecar.
                assertFalse(vehicle.containsKey("flight")); assertFalse(vehicle.containsKey("boundCosmeticWake"))
                assertEquals(sidecar(row).presentation!!.installationId, vehicle.charterText("installationId"))
                assertEquals(JsonPrimitive(true), vehicle["away"])
            }
        }
    }
    @Test fun `genuine legacy original stays unchanged while its separate sidecar explicitly reports no capture`() {
        val row = capture().charterObject("legacy").charterObject("starter")
        compare(row, "legacy"); val proof = originalGrammar(row.charterObject("original"))
        val serialized = starterJson.encodeToJsonElement(StarterExpeditionProof.serializer(), proof).jsonObject
        assertEquals(row.charterObject("original"), serialized)
        assertFalse(serialized.toString().contains("boundCosmeticWake"))
    }
}
