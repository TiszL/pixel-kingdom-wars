package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Dead-end audit 2026-10-06 (shape A). One unconfirmed sale offer blocked every new Clan Charter offer forever
 * (CharterStore.begin) with no close. The owner rule: a saved request the server does not know cannot block a door
 * forever, but it may be closed only after a same-action by-key GET answered `sale:null` for exactly its key. */
class CharterAbsentCloseTest {
    private class Fixture {
        val envelope=CharterFixtures.envelope("sale");val memory=CharterFixtures.Memory();val identity=CharterFixtures.identity(envelope.actor)
        val store=CharterStore(memory,identity);var absent=true;var loseBeforeResponse=true;var keys=0
        val calls=mutableListOf<Pair<String,String>>()
        val port=object:CharterPort {
            override val identity=this@Fixture.identity
            override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonObject)->Unit):JsonObject {
                guard();validateCharterRequest(method,path,query,body);calls+=method to path
                if(method=="POST" && loseBeforeResponse)throw IOException("Reply lost")
                val response=when {
                    path.endsWith("/activity")->CharterFixtures.activity(identity.wallet)
                    "/by-key/" in path->buildJsonObject{put("version",1);put("actor",identity.wallet);put("idempotencyKey",path.substringAfterLast('/'));put("sale",if(absent)JsonNull else envelope.raw)}
                    else->envelope.raw
                }
                withContext(NonCancellable){retain(response)};guard();return response
            }
        }
        val ports=object:CharterPorts {
            override val transport=CharterTransport(port)
            override fun capture(newAction:Boolean):()->Unit={}
            override fun policy()=CharterFixtures.protocol
            override fun cryptoPolicy()=CharterFixtures.crypto
            override fun trust()=CharterFixtures.pins
            override fun key()="30000000-0000-4000-8000-00000000000${++keys}"
            override suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit):()->Unit=guard
            override suspend fun ready(guard:()->Unit)=guard()
            override suspend fun hydrate(guard:()->Unit)=guard()
            override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit){error("No wallet in this test")}
        }
        val repository=CharterRepository(store,ports)
        suspend fun sell()=runCatching{val o=envelope.original;repository.sell(o.charterText("clanId"),o.charterText("buyer"),o.charterText("priceLamports"),CharterGrammar.bool(o.getValue("sellerLeaves")))}
        fun posts()=calls.count{it.first=="POST"}
    }

    @Test fun `a sale offer the server does not know closes after its own by-key read so a new offer can be saved`()=runBlocking {
        val f=Fixture();f.repository.open();assertTrue(f.sell().isFailure);val first=f.store.read().records.single();assertEquals(1,f.posts())
        // The door was dead: the next offer is refused before any POST while the unknown one is open.
        assertTrue(f.sell().isFailure);assertEquals(1,f.posts())
        f.repository.selectSaved(first.localKey)
        assertFalse("an attributed sale:null answer is absence, not a held contradiction",f.store.record(first.localKey).held)
        val before=f.calls.size;f.repository.closeAbsent()
        assertEquals("closing is one GET of exactly this key, never a POST",listOf("GET" to "/clans/charter/client/sales/by-key/${first.localKey}"),f.calls.drop(before))
        val closed=f.store.record(first.localKey);assertTrue(closed.closed);assertEquals(first.request,closed.request)
        // The door admits a new offer under a new key; the closed one stays as history on this device.
        assertTrue(f.sell().isFailure);assertEquals("the new offer reached the server",2,f.posts());val records=f.store.read().records;assertEquals(2,records.size)
        assertTrue(records.single{it.localKey!=first.localKey}.let{!it.closed && it.request!=null})
    }
    @Test fun `close is refused when the by-key read shows the sale and the offer stays open`()=runBlocking {
        val f=Fixture();f.repository.open();assertTrue(f.sell().isFailure);val first=f.store.read().records.single()
        f.repository.selectSaved(first.localKey);f.absent=false
        assertTrue(runCatching{f.repository.closeAbsent()}.isFailure)
        val after=f.store.record(first.localKey);assertFalse(after.closed);assertEquals(f.envelope.key,after.serverKey);assertNotNull(after.envelope)
        assertTrue("a shown sale keeps the door closed",f.sell().isFailure);assertEquals(1,f.posts())
    }
    @Test fun `a closed offer reopens when the server later shows it and older journal bytes still decode`()=runBlocking {
        val f=Fixture();f.repository.open();assertTrue(f.sell().isFailure);val key=f.store.read().records.single().localKey
        f.repository.selectSaved(key);f.repository.closeAbsent();assertTrue(f.store.record(key).closed)
        f.absent=false;f.repository.checkOriginal();val shown=f.store.record(key);assertFalse(shown.closed);assertNotNull(shown.envelope)
        f.memory.value=f.memory.value!!.replace(",\"closed\":false","");assertFalse(f.memory.value!!.contains("\"closed\""))
        assertEquals(shown,CharterStore(f.memory,f.identity).record(key))
    }
}
