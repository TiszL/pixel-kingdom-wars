package gg.pixelkingdomwars.nativeclient.vehicle

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VehicleCraftProtocolTest {
    private val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-craft-vectors.json")).readText()).jsonObject
    private val held=vectors.charterObject("held");private val quote=vectors.charterObject("quote")
    private fun change(v:JsonObject,k:String,x:JsonElement)=JsonObject(v+(k to x))
    private fun outcome(status:String)=JsonObject(held+mapOf("status" to JsonPrimitive(status),"consumedAt" to if(status=="held")JsonNull else JsonPrimitive("2035-01-01T00:00:00.000002Z"),"mintedAt" to if(status=="minted")JsonPrimitive("2035-01-01T00:00:00.000003Z")else JsonNull))
    @Test fun `preview preserves exact server quantities and fixed charge without invented total`() {
        assertEquals(quote,VehicleCraftProtocol.quote(quote));assertEquals("5678",quote.charterText("applicationFeeLamports"))
        assertThrows(Exception::class.java){VehicleCraftProtocol.quote(change(quote,"totalFeeLamports",JsonPrimitive("5678")))}
    }
    @Test fun `four outcome meanings require their own completion evidence fields`() {
        for(status in listOf("held","paid_loss","won_unminted","minted"))assertEquals(status,VehicleCraftProtocol.record(outcome(status)).charterText("status"))
        assertThrows(Exception::class.java){VehicleCraftProtocol.record(change(held,"status",JsonPrimitive("paid_loss")))}
        assertThrows(Exception::class.java){VehicleCraftProtocol.record(change(outcome("won_unminted"),"mintedAt",JsonPrimitive("2035-01-01T00:00:00.000003Z")))}
    }
    @Test fun `each false capability is enforced rather than trusted from API`() {
        for(flag in listOf("materialReservationAuthorized","signingAuthorized","broadcastAuthorized","reservationReleaseAuthorized")){
            assertThrows(Exception::class.java){VehicleCraftProtocol.record(change(held,flag,JsonPrimitive(true)))}
            assertThrows(Exception::class.java){VehicleCraftProtocol.quote(change(quote,flag,JsonPrimitive(true)))}
        }
    }
    @Test fun `quote mismatched duplicate and malformed ingredients refuse`() {
        val rows=quote.getValue("ingredients").jsonArray
        assertThrows(Exception::class.java){VehicleCraftProtocol.quote(change(quote,"ingredients",JsonArray(listOf(rows[0])+rows)))}
        assertThrows(Exception::class.java){VehicleCraftProtocol.quote(change(quote,"ingredients",JsonArray(listOf(change(rows[0].jsonObject,"required",JsonPrimitive("99")))+rows.drop(1))))}
        assertThrows(Exception::class.java){VehicleCraftProtocol.quote(change(quote,"applicationFeeLamports",JsonPrimitive(1.5)))}
    }
    @Test fun `history cannot contain another actor or duplicate roots`() {
        fun page(rows:List<JsonObject>)=buildJsonObject{put("version",1);put("wallet",held.getValue("wallet"));put("items",JsonArray(rows));put("nextCursor",JsonNull)}
        assertEquals(1,VehicleCraftProtocol.history(page(listOf(held))).getValue("items").jsonArray.size)
        assertThrows(Exception::class.java){VehicleCraftProtocol.history(page(listOf(held,held)))}
        assertThrows(Exception::class.java){VehicleCraftProtocol.history(page(listOf(change(held,"wallet",JsonPrimitive("So11111111111111111111111111111111111111112")))))}
    }
    @Test fun `held recovery can retain won entitlement but cannot change requested identity`() {
        val r=buildJsonObject{put("version",1);put("wallet",held.getValue("wallet"));put("idempotencyKey",held.getValue("idempotencyKey"));put("status","held");put("reason","PROVIDER_UNAVAILABLE");put("record",outcome("won_unminted"))}
        assertEquals("won_unminted",VehicleCraftProtocol.recovery(r).charterObject("record").charterText("status"))
        assertThrows(Exception::class.java){VehicleCraftProtocol.recovery(change(r,"status",JsonPrimitive("current")))}
        assertThrows(Exception::class.java){VehicleCraftProtocol.recovery(change(r,"idempotencyKey",held.getValue("baseId")))}
    }
    @Test fun `craft routes admit only preview history and original outcome checks`() {
        val request=buildJsonObject{put("baseId",held.getValue("baseId"));put("family","survey_balloon");put("tier",1);put("recipeVersion",1)}
        VehicleProtocol.validateRequest("POST","/vehicles/craft/quote",emptyMap(),request)
        VehicleProtocol.validateRequest("GET","/vehicles/craft/history",emptyMap(),null)
        val path="/vehicles/craft/by-key/"+held.charterText("idempotencyKey")
        VehicleProtocol.validateRequest("GET",path,emptyMap(),null);VehicleProtocol.validateRequest("POST","$path/recover",emptyMap(),buildJsonObject{})
        for(action in listOf("reserve","sign","signed","prepare","deliver","cancel"))assertThrows(Exception::class.java){VehicleProtocol.validateRequest("POST","$path/$action",emptyMap(),buildJsonObject{})}
    }
    @Test fun `v2 candidates retain distinct source provenance without broadening old contract`() {
        val item=buildJsonObject{put("identity",held.getValue("identity"));put("observedSlot",100);put("provenance",buildJsonObject{put("kind","finalized_issuance");put("rootId",held.getValue("rootId"))})}
        fun page(i:JsonObject)=buildJsonObject{put("version",2);put("wallet",held.getValue("wallet"));put("items",JsonArray(listOf(i)));put("nextCursor",JsonNull)}
        assertEquals(page(item),VehicleProtocol.assetsV2(page(item)))
        assertThrows(Exception::class.java){VehicleProtocol.assets(page(item))}
        assertThrows(Exception::class.java){VehicleProtocol.assetsV2(page(change(item,"provenance",buildJsonObject{put("kind","finalized_issuance")})))}
        VehicleProtocol.assetsV2(page(change(item,"provenance",buildJsonObject{put("kind","owner_attested")})))
    }
}
