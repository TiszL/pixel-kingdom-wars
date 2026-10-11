package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BattlePresentationTest {
    private fun sample() = Json.parseToJsonElement("""{"raidId":"raid","protocolVersion":1,"simVersion":14,"replaceFromTick":0,"revision":"${"a".repeat(64)}","events":[{"t":0,"e":"deploy"},{"t":2,"e":"pos"}]}""").jsonObject
    @Test fun `canonical battle envelope is accepted without simulating locally`() { validatePresentation(sample(),"raid",14) }
    @Test fun `unsupported versions never silently enter the renderer`() {
        for (key in listOf("protocolVersion","simVersion","replaceFromTick")) {
            val invalid = JsonObject(sample() + (key to JsonPrimitive(999)))
            assertThrows(IllegalArgumentException::class.java) { validatePresentation(invalid,"raid",14) }
        }
    }
    @Test fun `cross raid response cannot replace the active battle`() { assertThrows(IllegalArgumentException::class.java) { validatePresentation(sample(),"other",14) } }
    @Test fun `reordered canonical events fail visibly instead of changing combat`() {
        val next = JsonObject(sample()+ ("events" to JsonArray(listOf(buildJsonObject { put("t",3); put("e","pos") },buildJsonObject { put("t",1); put("e","pos") }))))
        assertThrows(IllegalArgumentException::class.java) { validatePresentation(next,"raid",14) }
    }
}
