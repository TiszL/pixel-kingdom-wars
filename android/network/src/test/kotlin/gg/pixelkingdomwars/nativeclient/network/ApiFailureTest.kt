package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ApiFailureTest {
    @Test fun `stale clock remains available for exact command reconciliation`() {
        val value = Json.parseToJsonElement("""{"error":{"code":"STALE_CLOCK","message":"Retry with the current clock","clock":{"revision":9,"rate":2},"future":"preserved"}}""").jsonObject
        val failure = apiFailure(409,value)
        assertEquals("STALE_CLOCK",failure.code)
        assertEquals(value["error"],failure.details)
        assertEquals(9,failure.details["clock"]!!.jsonObject["revision"]!!.jsonPrimitive.int)
    }
    @Test fun `overload retains retry guidance without making retries automatic`() {
        val error = buildJsonObject { put("error",buildJsonObject { put("code","NATIVE_PRESENTATION_BUSY");put("message","Busy") }) }
        assertEquals(3L,apiFailure(503,error,"3").retryAfterSeconds)
        assertNull(apiFailure(503,error,"-1").retryAfterSeconds)
    }
    @Test fun `non JSON gateway failure never becomes an account or wallet payload`() {
        assertEquals("Server request failed (502)",apiFailure(502,null).message)
        assertNull(apiFailure(502,null).code)
    }
    @Test fun `legacy flat errors remain readable`() {
        val failure = apiFailure(422,buildJsonObject { put("code","INVALID");put("message","Invalid order") })
        assertEquals("INVALID",failure.code)
        assertEquals("Invalid order",failure.message)
        assertEquals("Try again",apiFailure(503,buildJsonObject { put("error","Try again") }).message)
    }
}
