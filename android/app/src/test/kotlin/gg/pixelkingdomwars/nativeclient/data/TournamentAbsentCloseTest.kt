package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.tournament.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Dead-end audit 2026-10-06 (shape A). An unknown tournament entry blocked every entry for its event (and reserved
 * three journal slots); an unknown match request blocked that event's raids. Neither could ever be closed. Owner
 * rule: a saved request the server does not know cannot block a door forever, but it closes only after a
 * same-action by-key GET answered null for exactly its key. */
class TournamentAbsentCloseTest {
    private val f=TournamentFixtures
    private val root="/clans/charter/tournaments"
    private class Fixture {
        val store=TournamentStore(TournamentFixtures.Memory(),TournamentFixtures.identity());var answer:JsonElement=JsonNull
        val calls=mutableListOf<Pair<String,String>>()
        val port=object:TournamentPort {
            override val identity=store.identity
            override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit):JsonElement {
                guard();calls+=method to path;check(method=="GET"&&"/by-key/" in path){"Closing never sends $method $path"};retain(answer);guard();return answer
            }
        }
        val ports=object:TournamentPorts {
            override val transport=TournamentTransport(port)
            override fun capture(newAction:Boolean):()->Unit={}
            override fun trust():CharterSigningTrust?=null
            override fun cryptoPolicy():CharterCryptoPolicy?=null
            override fun policy():JsonObject?=null
            override fun key()=UUID.randomUUID().toString()
            override fun requireBase(baseId:String){}
            override suspend fun live(prepared:PreparedCharter,operation:JsonObject,guard:()->Unit):()->Unit=guard
            override suspend fun ready(guard:()->Unit)=guard()
            override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit){error("No wallet in this test")}
            override suspend fun hydrate(guard:()->Unit)=guard()
            override suspend fun battle(raidId:String,baseId:String,guard:()->Unit){error("No battle in this test")}
        }
        val repository=TournamentRepository(store,ports)
    }
    private fun entryBody(key:String)=buildJsonObject{put("eventId",f.eventId);put("clanId",f.entry.getValue("clanId"));put("idempotencyKey",key)}
    private val base=UUID.randomUUID().toString()
    private fun raidBody(key:String)=buildJsonObject{put("baseId",base);put("idempotencyKey",key)}
    private suspend fun begin(x:Fixture,kind:String,key:String=UUID.randomUUID().toString())=
        if(kind=="entry")x.store.begin("entry",key,f.eventId,"$root/entries",entryBody(key)) else x.store.begin("raid",key,f.eventId,"$root/events/${f.eventId}/raids",raidBody(key))

    @Test fun `an entry or match request the server does not know closes after its own by-key read and frees its door`()=runBlocking {
        for(kind in listOf("entry","raid")) {
            val x=Fixture();val unknown=begin(x,kind)
            assertTrue("the door was dead while the unknown $kind was open",runCatching{begin(x,kind)}.isFailure)
            x.repository.closeAbsent(unknown.key)
            val path=if(kind=="entry")"$root/entries/by-key/${unknown.key}" else "$root/events/${f.eventId}/raids/by-key/${unknown.key}"
            assertEquals("closing is one GET of exactly this key",listOf("GET" to path),x.calls)
            val closed=x.store.record(unknown.key);assertTrue(closed.closed);assertEquals(unknown.body,closed.body)
            assertTrue("a closed original cannot be resent",runCatching{x.repository.retry(unknown.key)}.isFailure);assertEquals(1,x.calls.size)
            val next=begin(x,kind);assertFalse(x.store.record(next.key).closed);assertEquals(2,x.store.read().records.size)
        }
    }
    @Test fun `close is refused when the by-key read shows the match request and the event stays blocked`()=runBlocking {
        val x=Fixture();val unknown=begin(x,"raid")
        x.answer=buildJsonObject{put("version",1);put("eventId",f.eventId);put("requestId",UUID.randomUUID().toString());put("baseId",base);put("status","requested");put("ordinal",JsonNull);put("raid",JsonNull)}
        assertTrue(runCatching{x.repository.closeAbsent(unknown.key)}.isFailure)
        val shown=x.store.record(unknown.key);assertFalse(shown.closed);assertEquals("requested",shown.response!!.charterText("status"))
        assertTrue(runCatching{begin(x,"raid")}.isFailure)
    }
    @Test fun `a closed unknown entry no longer reserves journal capacity`()=runBlocking {
        // Each unresolved entry reserves three extra slots of the 128; a closed one reserves none. With 32 closed
        // entries the 33rd needs 33 + 3 slots; had closed entries kept reserving, it would need 33 + 99 and be refused.
        val x=Fixture();val keys=(1..32).map{begin(x,"entry").also{r->x.repository.closeAbsent(r.key)}.key}
        assertEquals(32,x.store.read().records.count{it.closed});assertTrue(keys.all{x.store.record(it).closed})
        begin(x,"entry");assertEquals(33,x.store.read().records.size)
    }
}
