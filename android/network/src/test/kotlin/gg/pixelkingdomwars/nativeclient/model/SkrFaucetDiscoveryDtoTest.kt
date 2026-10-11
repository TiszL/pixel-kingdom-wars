package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SkrFaucetDiscoveryDtoTest {
    private fun page(): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-discovery-vectors.json")
        assertNotNull("MISSING: actual authenticated P5 discovery route vector", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue("pendingPage").jsonObject
    }
    @Test fun `actual wallet owned discovery page uses existing grant DTO and exact cursor shape`() {
        val raw = page(); val parsed = SkrFaucetGrantPage.from(raw, 20)
        assertEquals(raw.getValue("items").jsonArray.size, parsed.items.size); assertNull(parsed.nextCursor)
    }
    @Test fun `unknown envelope fields malformed cursor duplicate ids and oversized pages fail closed`() {
        val raw = page(); val item = raw.getValue("items").jsonArray.single()
        val invalid = listOf(JsonObject(raw + ("wallet" to JsonPrimitive("forged"))),
            JsonObject(raw + ("nextCursor" to JsonPrimitive("bad"))),
            JsonObject(raw + ("items" to JsonArray(listOf(item, item)))),
            JsonObject(raw + ("items" to JsonArray(List(21) { item }))),
            buildJsonObject { put("items", JsonArray(emptyList())); put("nextCursor", item.jsonObject.getValue("id")) })
        invalid.forEach { assertThrows(IllegalArgumentException::class.java) { SkrFaucetGrantPage.from(it, 20) } }
    }
}
