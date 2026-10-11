package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class TrainingConfirmationTest {
    private val quote = Json.parseToJsonElement("""{"requested":[{"troop":"plunderer","count":6}],"queueable":[{"troop":"plunderer","count":5}],"remaining":[{"troop":"plunderer","count":1,"reason":"Army Camps are full"}],"costShards":"9007199254740993"}""").jsonObject
    @Test fun `partial purchase contains only confirmed units and exact decimal price`() {
        val request = trainingConfirmation(quote,"deed-A","same-receipt")
        assertEquals(quote["queueable"],request["composition"])
        assertEquals("9007199254740993",request.string("confirmedCostShards"))
        assertEquals("deed-A",request.string("baseId"))
    }
    @Test fun `lost response retry retains the same serialized intent and receipt`() {
        val confirmed = trainingConfirmation(quote,"deed-A","same-receipt")
        val recovered = Json.parseToJsonElement(confirmed.toString()).jsonObject
        assertEquals(confirmed,recovered)
        assertEquals("same-receipt",recovered.string("idempotencyKey"))
    }
    @Test fun `malformed prices cannot reach a purchase request`() {
        assertThrows(IllegalArgumentException::class.java) { trainingConfirmation(JsonObject(quote + ("costShards" to JsonPrimitive("1e4"))),"deed-A","receipt") }
    }
}
