package gg.pixelkingdomwars.nativeclient.vehicle

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Captured authenticated normal API bytes from actual earned input/reservation
 * services. Chain finality was serialized-fixture input, not an Android run. */
class VehicleCraftHttpPairTest {
    @Test fun `actual normal HTTP states and candidate provenance cross the strict native boundary`() {
        val pair=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-craft-http-pair.json")).readText()).jsonObject
        val raw=pair.charterObject("raw")
        fun response(key:String)=Json.parseToJsonElement(raw.charterText(key)).jsonObject
        assertEquals(pair["quote"],VehicleCraftProtocol.quote(response("quote")))
        for((key,state) in listOf("held" to "held","paid_loss" to "paid_loss","won_unminted" to "won_unminted","minted" to "minted")){
            assertEquals(state,VehicleCraftProtocol.record(response(key)).charterText("status"))
            assertEquals(pair.getValue("wallet"),response(key)["wallet"])
        }
        assertEquals(pair["history"],VehicleCraftProtocol.history(response("history")))
        for(key in listOf("recoverWon","recoverLoss","recoverMinted"))VehicleCraftProtocol.recovery(response(key))
        val candidates=VehicleProtocol.assetsV2(response("assetsV2")).getValue("items").jsonArray
        assertEquals(setOf("owner_attested","finalized_issuance"),candidates.map{it.jsonObject.charterObject("provenance").charterText("kind")}.toSet())
        VehicleProtocol.assets(response("assetsV1"))
        assertThrows(Exception::class.java){VehicleProtocol.assets(response("assetsV2"))}
    }
}
