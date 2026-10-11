package gg.pixelkingdomwars.nativeclient.realmsales

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RealmSalesRefusalTest {
    private val codes = listOf("REALM_SALE_NO_QUOTA", "REALM_SALE_UNSOLD", "REALM_SALE_REALM_UNAVAILABLE")
    private fun body(code: String) = buildJsonObject { putJsonObject("error") { put("code", code); put("message", "The selected offer is no longer available") } }
    @Test fun `only the exact initial unsigned sale race refusals join the finite persisted contract`() {
        for (code in codes) {
            val refusal = requireNotNull(RealmSalePrepareRefusal.response(422, body(code)))
            assertEquals(RealmSalePrepareRefusal(422, code), refusal); refusal.validate()
        }
    }
    @Test fun `the same text at another status or an adjacent code never proves an unsigned refusal`() {
        for (code in codes) for (status in listOf(200, 400, 401, 403, 409, 429, 500, 503)) assertNull(RealmSalePrepareRefusal.response(status, body(code)))
        for (code in listOf("NO_QUOTA", "REALM_SALE_NO_QUOTA ", "REALM_SALE_UNSOLD_UNKNOWN", "REALM_SALE_FAILED")) assertNull(RealmSalePrepareRefusal.response(422, body(code)))
    }
    @Test fun `extra evidence missing message and malformed primitive never acquire refusal authority`() {
        for (code in codes) {
            val raw = body(code); val error = raw.getValue("error").jsonObject
            val invalid = listOf(JsonObject(raw + ("preparation" to JsonNull)), JsonObject(mapOf("error" to JsonObject(error + ("settlement" to JsonNull)))),
                JsonObject(mapOf("error" to JsonObject(error - "message"))), JsonObject(mapOf("error" to JsonObject(error + ("message" to JsonPrimitive(1))))),
                JsonObject(mapOf("error" to JsonObject(error + ("message" to JsonPrimitive(""))))), JsonObject(mapOf("error" to JsonObject(error + ("code" to JsonPrimitive(422))))))
            for (value in invalid) assertNull(RealmSalePrepareRefusal.response(422, value))
        }
    }
}
