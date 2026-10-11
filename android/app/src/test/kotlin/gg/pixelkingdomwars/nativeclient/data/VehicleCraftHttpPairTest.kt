package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleCraftProtocol
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VehicleCraftHttpPairTest {
    @Test fun `actual authenticated originals retain earned terms through won mint continuation and reopen`()=runBlocking {
        val pair=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-craft-http-pair.json")).readText()).jsonObject
        val rows=pair.charterObject("records")
        val identity=StarterIdentity("https://vehicle-craft-pair.test","devnet",pair.charterText("wallet"))
        val memory=object:SecretStore{var text:String?=null;override fun read()=text;override fun write(value:String){text=value};override fun clear(){error("Do not forget originals")}}
        val store=VehicleCraftStore(memory,identity)
        store.accept(listOf(rows.charterObject("held"),rows.charterObject("paid_loss"),rows.charterObject("won_unminted")))
        val original=VehicleCraftProtocol.original(rows.charterObject("won_unminted"))
        val recovery=VehicleCraftProtocol.recovery(pair.charterObject("recoveries").charterObject("minted"))
        store.accept(listOf(recovery.charterObject("record")))
        val reopened=VehicleCraftStore(memory,identity).read()
        assertEquals(setOf("held","paid_loss","minted"),reopened.map{it.charterText("status")}.toSet())
        assertEquals(original,VehicleCraftProtocol.original(reopened.single{it.charterText("status")=="minted"}))
        assertEquals(JsonObject(rows.charterObject("minted")-"serverNow"),JsonObject(reopened.single{it.charterText("status")=="minted"}-"serverNow"))
        val saved=memory.text
        assertThrows(Exception::class.java){runBlocking{store.accept(listOf(rows.charterObject("won_unminted")))}}
        assertEquals(saved,memory.text);Unit
    }
}
