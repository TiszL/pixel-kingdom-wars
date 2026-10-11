package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.network.archivewirefixture.NativePresentationPageDto
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Uses the actual generator's declarations, verified byte-for-byte by the Node
 * contract test. Nested orders remain JsonElement; schema bounds are enforced by
 * the source server, not by these DTOs or a second hand-maintained validator. */
class NativeArchivedHeroOrdersWireTest {
    private val json = Json { ignoreUnknownKeys = true }
    private fun fixture(): JsonObject = requireNotNull(javaClass.getResourceAsStream("/native-archived-hero-orders.json"))
        .bufferedReader().use { json.parseToJsonElement(it.readText()).jsonObject }

    @Test fun `frozen accepted hero orders survive Kotlin decode and reencode without actor events`() {
        val wire = fixture()
        val decoded = json.decodeFromJsonElement<NativePresentationPageDto>(wire)
        val state = requireNotNull(decoded.state)
        assertEquals(wire["state"]!!.jsonObject["orders"], state.orders)
        val heroes = state.orders!!.jsonObject["heroDeploys"]!!.jsonArray
        val accepted = heroes[0].jsonObject
        assertEquals(-34, accepted["tx"]!!.jsonPrimitive.int)
        assertEquals(63, accepted["ty"]!!.jsonPrimitive.int)
        assertEquals(80_000L, accepted["tMs"]!!.jsonPrimitive.long)
        assertEquals("frozen-accepted-order", accepted["loadout"]!!.jsonObject["hash"]!!.jsonPrimitive.content)
        assertEquals(-500, accepted["loadout"]!!.jsonObject["modifiers"]!!.jsonObject["hero_hp_bps"]!!.jsonPrimitive.int)
        assertFalse(heroes[1].jsonObject.containsKey("level"))
        assertFalse(heroes[1].jsonObject.containsKey("loadout"))
        assertTrue(decoded.events.none { it.jsonObject["e"]!!.jsonPrimitive.content == "deploy" })
        assertEquals("9007199254740993123", state.result!!.jsonObject["lootShards"]!!.jsonPrimitive.content)
        assertEquals(wire, json.encodeToJsonElement(decoded))
    }

    @Test fun `historical omission remains distinct from an explicitly empty accepted hero list`() {
        val original = fixture()
        val state = original["state"]!!.jsonObject
        for (orders in listOf(null, buildJsonObject { put("heroDeploys", JsonArray(emptyList())) })) {
            val wireState = if (orders == null) JsonObject(state - "orders") else JsonObject(state + ("orders" to orders))
            val wire = JsonObject(original + ("state" to wireState))
            val decoded = json.decodeFromJsonElement<NativePresentationPageDto>(wire)
            assertEquals(orders, decoded.state!!.orders)
            assertEquals(wire, json.encodeToJsonElement(decoded))
        }
    }

    @Test fun `continuation pages keep required null state and never invent orders`() {
        val wire = JsonObject(fixture() + ("state" to JsonNull))
        val decoded = json.decodeFromJsonElement<NativePresentationPageDto>(wire)
        assertNull(decoded.state)
        assertEquals(wire, json.encodeToJsonElement(decoded))
        assertThrows(SerializationException::class.java) {
            json.decodeFromJsonElement<NativePresentationPageDto>(JsonObject(wire - "state"))
        }
    }
}
