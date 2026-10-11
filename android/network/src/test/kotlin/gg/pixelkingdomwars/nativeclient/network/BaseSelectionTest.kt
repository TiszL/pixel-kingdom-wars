package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BaseSelectionTest {
    private fun base(id:String,status:String="active",slot:Int?=1)=buildJsonObject {
        put("id",id);put("status",status);put("slot",slot?.let(::JsonPrimitive) ?: JsonNull)
    }
    @Test fun `process restart restores an owned active base despite server listing order`() {
        val saved=Json.parseToJsonElement(jsonBody("wallet" to "walletA","baseId" to "baseB").toString()).jsonObject
        assertEquals("baseB",resolveBaseSelection(saved,"walletA",listOf(base("baseA"),base("baseB"))))
    }
    @Test fun `wallet switch cannot inherit another wallets saved selection`() {
        val saved=jsonBody("wallet" to "walletA","baseId" to "baseB")
        assertEquals("baseA",resolveBaseSelection(saved,"walletB",listOf(base("baseA"),base("baseB"))))
    }
    @Test fun `transferred inactive or unslotted deeds cannot override active server ownership`() {
        val saved=jsonBody("wallet" to "walletA","baseId" to "old")
        for (old in listOf(base("old","inactive"),base("old",slot=null))) {
            assertEquals("current",resolveBaseSelection(saved,"walletA",listOf(old,base("current"))))
        }
        assertNull(resolveBaseSelection(saved,"walletA",emptyList()))
    }
}
