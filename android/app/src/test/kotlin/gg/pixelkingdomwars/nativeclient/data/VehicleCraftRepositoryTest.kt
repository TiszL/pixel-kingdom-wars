package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VehicleCraftRepositoryTest {
    private val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-craft-vectors.json")).readText()).jsonObject
    private val held=vectors.charterObject("held");private val quote=vectors.charterObject("quote")
    private fun change(v:JsonObject,k:String,x:JsonElement)=JsonObject(v+(k to x))
    private fun outcome(status:String)=JsonObject(held+mapOf("status" to JsonPrimitive(status),"consumedAt" to if(status=="held")JsonNull else JsonPrimitive("2035-01-01T00:00:00.000002Z"),"mintedAt" to if(status=="minted")JsonPrimitive("2035-01-01T00:00:00.000003Z")else JsonNull))
    private class Memory:SecretStore {var text:String?=null;var broken=false;override fun read():String?{check(!broken);return text};override fun write(value:String){check(!broken);text=value};override fun clear(){error("Original cache is never cleared")}}
    private inner class Fixture {
        val memory=Memory();val identity=VehicleFixtures.identity();val store=VehicleCraftStore(memory,identity)
        var active=true;var hydrated=false;var hydrateFails=false;var offline=false;var rows=listOf(held);var response=held;var afterResponse:()->Unit={}
        val calls=mutableListOf<Pair<String,String>>()
        val ports=object:VehiclePorts {
            override val transport=VehicleTransport(object:VehiclePort{
                override val identity get()=this@Fixture.identity
                override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
                    guard();calls+=method to path;if(offline)throw IOException("offline")
                    val raw=when{path.endsWith("/quote")->quote;path.endsWith("/history")->buildJsonObject{put("version",1);put("wallet",identity.wallet);put("items",JsonArray(rows));put("nextCursor",JsonNull)}
                        else->buildJsonObject{put("version",1);put("wallet",identity.wallet);put("idempotencyKey",held.getValue("idempotencyKey"));put("status","held");put("reason","PROVIDER_UNAVAILABLE");put("record",response)}}
                    afterResponse();retain(raw);guard();return raw
                }
            })
            override fun capture(fresh:Boolean):()->Unit {assertFalse(fresh);return {check(active)}}
            override fun requireOwnedBase(base:String){check(hydrated&&base==held.charterText("baseId"))}
            override suspend fun hydrate(guard:()->Unit){guard();if(hydrateFails)throw IOException("account refresh unavailable");hydrated=true;guard()}
            override fun policy():VehiclePolicy?=null
            override fun trust():VehicleSigningTrust?=null
            override fun key():String=error("No admission key")
            override fun now()=0L
            override suspend fun live(client:JsonObject,prepared:PreparedVehicle,pins:VehicleSigningTrust,policy:VehiclePolicy,networkFeeLamports:String,guard:()->Unit):()->Unit=error("No signing")
            override suspend fun ready(guard:()->Unit)=error("No wallet")
            override suspend fun sign(prepared:PreparedVehicle,guard:()->Unit,beforeWallet:suspend()->Unit,retain:suspend(JsonObject)->Unit)=error("No wallet")
        }
        fun repo()=VehicleCraftRepository(store,ports)
        fun selected(repo:VehicleCraftRepository){repo.select(VehicleCraftSelection(held.charterText("baseId"),"survey_balloon",1))}
    }
    private fun rejects(block:suspend()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
    @Test fun `cold history survives account outage with original cache and no admission`()=runBlocking{
        val f=Fixture();f.store.accept(listOf(held));f.hydrateFails=true;val repo=f.repo();repo.history()
        assertEquals(listOf(held),repo.state.value.records);assertFalse(f.hydrated);assertEquals(listOf("GET" to "/vehicles/craft/history"),f.calls);Unit
    }
    @Test fun `network failure keeps previously cached history visible after restart`()=runBlocking{
        val f=Fixture();f.store.accept(listOf(outcome("won_unminted")));f.offline=true;val repo=f.repo();rejects{repo.history()}
        assertTrue(repo.state.value.loaded);assertEquals("won_unminted",repo.state.value.records.single().charterText("status"));assertNotNull(repo.state.value.error);Unit
    }
    @Test fun `quote needs hydrated ownership while account failure never clears originals`()=runBlocking{
        val f=Fixture();f.store.accept(listOf(held));val repo=f.repo();f.selected(repo);repo.quote();assertEquals(quote,repo.state.value.quote)
        f.hydrateFails=true;rejects{repo.quote()};assertNull(repo.state.value.quote);assertEquals(listOf(held),repo.state.value.records);assertEquals(1,f.calls.size);Unit
    }
    @Test fun `selection invalidation fences a delayed quote and clears previous selection`()=runBlocking{
        val f=Fixture();val repo=f.repo();f.selected(repo);f.afterResponse={repo.select(VehicleCraftSelection(held.charterText("baseId"),"cargo_cutter",1))}
        rejects{repo.quote()};assertNull(repo.state.value.quote);assertEquals("cargo_cutter",repo.state.value.selection!!.family);assertFalse(repo.state.value.busy);Unit
    }
    @Test fun `late original reply is retained only for its actor and never updates stale screen`()=runBlocking{
        val f=Fixture();val repo=f.repo();f.afterResponse={repo.dismiss()};rejects{repo.history()}
        assertEquals(listOf(held),f.store.read());assertTrue(repo.state.value.records.isEmpty());Unit
    }
    @Test fun `recovery is explicit retains paid entitlement and does not require current ownership`()=runBlocking{
        val f=Fixture();f.store.accept(listOf(held));f.hydrateFails=true;f.response=outcome("won_unminted");val repo=f.repo();repo.recover(held.charterText("idempotencyKey"))
        assertEquals("won_unminted",repo.state.value.records.single().charterText("status"));assertTrue(repo.state.value.error!!.contains("preserved"));assertEquals(1,f.calls.size);assertTrue(f.calls.single().second.endsWith("/recover"));assertFalse(f.hydrated);Unit
    }
    @Test fun `saved source and terminal contradictions cannot overwrite immutable original`()=runBlocking{
        val f=Fixture();val minted=outcome("minted");f.store.accept(listOf(minted));val before=f.memory.text
        rejects{f.store.accept(listOf(held))};rejects{f.store.accept(listOf(change(minted,"baseId",minted.getValue("reservationId"))))}
        rejects{f.store.accept(listOf(change(minted,"wallet",JsonPrimitive("So11111111111111111111111111111111111111112"))))}
        assertEquals(before,f.memory.text);assertEquals(listOf(minted),f.store.read());Unit
    }
    @Test fun `win advances to mint once while paid loss cannot become success`()=runBlocking{
        val f=Fixture();f.store.accept(listOf(held));f.store.accept(listOf(outcome("won_unminted")));f.store.accept(listOf(outcome("minted")));assertEquals("minted",f.store.read().single().charterText("status"))
        val loss=Fixture();loss.store.accept(listOf(outcome("paid_loss")));rejects{loss.store.accept(listOf(outcome("minted")))};assertEquals("paid_loss",loss.store.read().single().charterText("status"));Unit
    }
    @Test fun `corrupt encrypted cache fails closed and is not replaced with empty history`()=runBlocking{
        val f=Fixture();f.memory.text="corrupt";val repo=f.repo();rejects{repo.history()};assertEquals("corrupt",f.memory.text);assertTrue(f.calls.isEmpty());assertFalse(repo.state.value.loaded);Unit
    }
}
