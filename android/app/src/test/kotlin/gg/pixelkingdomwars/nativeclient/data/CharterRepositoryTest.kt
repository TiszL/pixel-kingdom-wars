package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CharterRepositoryTest {
    private class Fixture(kind:String="creation",buyer:Boolean=false) {
        var envelope=CharterFixtures.envelope(kind,buyer);val memory=CharterFixtures.Memory();val identity=CharterFixtures.identity(envelope.actor);val store=CharterStore(memory,identity)
        var active=true;var expired=false;var configured=true;var walletCalls=0;var hydrates=0;var loseReply=false;var loseBeforeResponse=false
        var failHydration=false;var afterHydrate:()->Unit={};var cursor:String?=null
        var afterWallet:()->Unit={};var beforeRequest:suspend (String,String)->Unit={_,_->}
        val calls=mutableListOf<Pair<String,String>>()
        val port=object:CharterPort {
            override val identity=this@Fixture.identity
            override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonObject)->Unit):JsonObject {
                guard();validateCharterRequest(method,path,query,body);beforeRequest(method,path);guard();calls+=method to path
                if(loseBeforeResponse){loseBeforeResponse=false;throw IOException("Reply lost")}
                val response=when {
                    path.endsWith("/activity")->JsonObject(CharterFixtures.activity(identity.wallet)+("nextCursor" to (cursor?.let(::JsonPrimitive)?:JsonNull)))
                    "/by-key/" in path->buildJsonObject{put("version",1);put("actor",identity.wallet);put("idempotencyKey",path.substringAfterLast('/'));put("sale",envelope.raw)}
                    path.endsWith("/deliver")->buildJsonObject{put("version",1);put("actor",identity.wallet);put("kind",envelope.kind);put("key",envelope.key);put("status","submitted");put("signature",envelope.wire!!.getValue("signature"));put("reason",JsonNull);put("original",envelope.raw)}
                    else->envelope.raw
                }
                withContext(NonCancellable){retain(response)}
                if(loseReply){loseReply=false;throw IOException("Reply lost after owned evidence")}
                guard();return response
            }
        }
        val ports=object:CharterPorts {
            override val transport=CharterTransport(port)
            override fun capture(newAction:Boolean):()->Unit {val check={check(active);if(newAction)check(configured)};check();return check}
            override fun policy()=if(configured)CharterFixtures.protocol else null
            override fun cryptoPolicy()=if(configured)CharterFixtures.crypto else null
            override fun trust()=if(configured)CharterFixtures.pins else null
            override fun key()=if(envelope.kind=="creation")envelope.key else "30000000-0000-4000-8000-000000000001"
            override suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit):()->Unit {guard();check(!expired);return {guard();check(!expired)}}
            override suspend fun ready(guard:()->Unit){guard()}
            override suspend fun hydrate(guard:()->Unit){guard();hydrates++;afterHydrate();if(failHydration)throw IOException("Clan refresh unavailable");guard()}
            override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit) {
                guard();walletCalls++;val wire=Base64.getDecoder().decode(CharterFixtures.row.charterObject(if(prepared.kind=="creation")"creationWire" else "saleWire").charterText("signedTransaction"))
                if(prepared.kind=="sale") {val index=if(prepared.wallet==envelope.original.charterText("buyer"))1 else 0;wire.fill(0,1+64*index,65+64*index)}
                val value=prepared.verifySigned(wire);afterWallet();withContext(NonCancellable){retain(value)};guard()
            }
        }
        val repository=CharterRepository(store,ports)
        suspend fun open(){repository.open();repository.select(envelope.kind,envelope.key)}
        fun full() {envelope=CharterFixtures.status(envelope,"signed",wire=CharterFixtures.row.charterObject(if(envelope.kind=="creation")"creationWire" else "saleWire"),contributions=if(envelope.kind=="sale")listOf(CharterFixtures.row.charterObject("buyerContribution"),CharterFixtures.row.charterObject("sellerContribution")) else emptyList())}
    }
    // A GET appends its exact verified envelope to the audit trail; all original fields stay fixed.
    private fun observedAgain(original:CharterRecord)=original.copy(observations=(original.observations+requireNotNull(original.envelope)).distinct())
    private fun completed(f:Fixture){f.full();f.envelope=CharterFixtures.status(f.envelope,"completed",wire=f.envelope.wire,contributions=f.envelope.contributions,terminal=buildJsonObject{put("id","40000000-0000-4000-8000-000000000001");put("outcome","completed")})}
    @Test fun `actual canonical approval is separate from retention and exact server delivery`()=runBlocking {
        val f=Fixture();f.open();f.repository.review();assertTrue(f.repository.state.value.reviewed)
        f.repository.approve();assertEquals(1,f.walletCalls);assertNotNull(f.store.record(f.envelope.key).ownSignature);assertFalse(f.calls.any{it.second.endsWith("/signed")||it.second.endsWith("/deliver")})
        f.full();f.repository.publishSignature();f.repository.deliver();assertEquals(1,f.calls.count{it.second.endsWith("/deliver")})
        assertTrue(runCatching{f.repository.approve()}.isFailure);assertEquals(1,f.walletCalls)
    }
    @Test fun `intent and attempt are durable before funding POST and lost reply recovers same key`()=runBlocking {
        val f=Fixture();f.repository.open();f.beforeRequest={method,path->if(method=="POST") {val r=f.store.read().records.single();assertEquals(f.envelope.key,r.localKey);assertTrue("create" in r.attempts);assertTrue(path.endsWith("/creations"))}}
        f.loseBeforeResponse=true;val r=f.envelope.state.charterObject("request")
        assertTrue(runCatching{f.repository.create(r.charterText("baseId"),r.charterText("name"),r.charterText("tag"),r.charterText("inviteMode"))}.isFailure)
        assertEquals(1,f.calls.count{it.first=="POST"});f.repository.checkOriginal();assertEquals(f.envelope.key,f.repository.state.value.envelope!!.key)
        assertTrue(runCatching{f.repository.create(r.charterText("baseId"),r.charterText("name"),r.charterText("tag"),r.charterText("inviteMode"))}.isFailure);assertEquals(1,f.calls.count{it.first=="POST"})
    }
    @Test fun `lost seller creation reply discovers server original by saved idempotency key`()=runBlocking {
        val f=Fixture("sale");f.repository.open();val o=f.envelope.original;f.loseBeforeResponse=true
        assertTrue(runCatching{f.repository.sell(o.charterText("clanId"),o.charterText("buyer"),o.charterText("priceLamports"),CharterGrammar.bool(o.getValue("sellerLeaves")))}.isFailure)
        val key=f.ports.key();assertNull(f.store.record(key).serverKey);f.repository.checkOriginal();assertEquals(f.envelope.key,f.store.record(key).serverKey)
        assertTrue(f.calls.last().second.endsWith("/sales/by-key/$key"));assertEquals(1,f.calls.count{it.first=="POST"})
    }
    @Test fun `failed durable intent prevents every external request`()=runBlocking {
        val f=Fixture();f.repository.open();val before=f.calls.size;f.memory.fail=true;val r=f.envelope.state.charterObject("request")
        assertTrue(runCatching{f.repository.create(r.charterText("baseId"),r.charterText("name"),r.charterText("tag"),r.charterText("inviteMode"))}.isFailure);assertEquals(before,f.calls.size)
    }
    @Test fun `late wallet approval survives obsolete view and app restart without second approval`()=runBlocking {
        val f=Fixture();f.open();f.repository.review();f.afterWallet={f.repository.dismiss();f.active=false}
        assertTrue(runCatching{f.repository.approve()}.isFailure)
        val reopened=CharterStore(f.memory,f.identity);assertNotNull(reopened.record(f.envelope.key).ownSignature);assertEquals(1,f.walletCalls)
        f.active=true;f.repository.checkOriginal();assertTrue(runCatching{f.repository.review()}.isFailure);assertEquals(1,f.walletCalls)
    }
    @Test fun `expired retained signature remains history and cannot grant delivery`()=runBlocking {
        val f=Fixture();f.open();f.repository.review();f.repository.approve();f.full();f.repository.publishSignature();f.expired=true
        assertTrue(runCatching{f.repository.deliver()}.isFailure);assertFalse(f.calls.any{it.second.endsWith("/deliver")});assertNotNull(f.store.record(f.envelope.key).ownSignature)
    }
    @Test fun `both sale actors retain their own partial signature then fetch full coapproval before delivery`()=runBlocking {
        for(buyer in listOf(false,true)) {
            val f=Fixture("sale",buyer);f.open();f.repository.review();f.repository.approve();val own=f.store.record(f.envelope.key).ownSignature!!;assertNull(own.transactionSignature)
            val contribution=CharterFixtures.row.charterObject(if(buyer)"buyerContribution" else "sellerContribution");f.envelope=CharterFixtures.status(f.envelope,"prepared",contributions=listOf(contribution));f.repository.publishSignature()
            assertTrue(runCatching{f.repository.deliver()}.isFailure);f.full();f.repository.checkOriginal();f.repository.deliver();assertEquals(1,f.walletCalls);assertEquals(1,f.calls.count{it.second.endsWith("/signature")});assertEquals(1,f.calls.count{it.second.endsWith("/deliver")})
        }
    }
    @Test fun `explicit retained signature retry after unknown transport never repeats wallet approval`()=runBlocking {
        val f=Fixture();f.open();f.repository.review();f.repository.approve();f.loseBeforeResponse=true
        assertTrue(runCatching{f.repository.publishSignature()}.isFailure);f.full();f.repository.publishSignature();assertEquals(1,f.walletCalls);assertEquals(2,f.calls.count{it.second.endsWith("/signed")})
    }
    @Test fun `providerless private discovery and saved terminal hydrate domain before publication`()=runBlocking {
        val f=Fixture("sale",true);f.open();val terminal=buildJsonObject{put("id","40000000-0000-4000-8000-000000000001");put("outcome","completed")};f.full();f.envelope=CharterFixtures.status(f.envelope,"completed",wire=f.envelope.wire,contributions=f.envelope.contributions,terminal=terminal)
        f.configured=false;f.repository.checkOriginal();assertEquals(1,f.hydrates);assertEquals("completed",f.repository.state.value.envelope!!.status);assertTrue(runCatching{f.repository.review()}.isFailure)
    }
    @Test fun `cold terminal selection hydrates once before any terminal view publication`()=runBlocking {
        val f=Fixture("sale",true);f.open();f.full()
        f.envelope=CharterFixtures.status(f.envelope,"completed",wire=f.envelope.wire,contributions=f.envelope.contributions,terminal=buildJsonObject{put("id","40000000-0000-4000-8000-000000000001");put("outcome","completed")})
        f.repository.checkOriginal();assertEquals(1,f.hydrates)
        val cold=CharterRepository(CharterStore(f.memory,f.identity),f.ports);cold.open();assertNull(cold.state.value.envelope)
        cold.selectSaved(f.envelope.key);assertEquals(2,f.hydrates);assertEquals("completed",cold.state.value.envelope!!.status)
        cold.checkOriginal();assertEquals(2,f.hydrates)
    }
    @Test fun `simultaneous repository instances cannot double dispatch same identity`()=runBlocking {
        val f=Fixture();f.open();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
        f.beforeRequest={_,path->if(path.endsWith("/recover")){entered.complete(Unit);release.await()}}
        val pending=async{f.repository.recover()};entered.await();assertTrue(runCatching{f.repository.recover()}.isFailure);release.complete(Unit);pending.await();assertEquals(1,f.calls.count{it.second.endsWith("/recover")})
    }
    @Test fun `cold terminal index and detail remain readable while clan hydration repeatedly fails`()=runBlocking {
        val f=Fixture("sale");f.open();completed(f);f.store.accept(f.envelope.key,f.envelope);val original=f.store.record(f.envelope.key);f.failHydration=true;f.configured=false
        val cold=CharterRepository(CharterStore(f.memory,f.identity),f.ports);cold.open();assertEquals(original,cold.state.value.journal!!.records.single());assertNull(cold.state.value.envelope)
        f.calls.clear();cold.selectSaved(original.localKey);assertEquals("completed",cold.state.value.envelope!!.status);assertNotNull(cold.state.value.activity);assertTrue(cold.state.value.error!!.contains("Saved outcomes"));cold.checkOriginal();assertTrue(cold.state.value.error!!.contains("original receipt checks remain available"))
        assertEquals(listOf("GET" to "/clans/charter/client/sales/${original.serverKey}","GET" to "/clans/charter/client/sales/${original.serverKey}"),f.calls);assertEquals(observedAgain(original),f.store.record(original.localKey));assertEquals(0,f.walletCalls)
        f.cursor="historical-page";cold.open();f.calls.clear();cold.nextPage();assertEquals(listOf("GET" to "/clans/charter/client/activity"),f.calls);assertTrue(cold.state.value.error!!.contains("original receipt checks remain available"));assertEquals(observedAgain(original),f.store.record(original.localKey))
    }
    @Test fun `browsing another original cannot evade a terminal pending hydration before commands`()=runBlocking {
        val f=Fixture("sale");f.open();completed(f);f.store.accept(f.envelope.key,f.envelope);val old=f.store.record(f.envelope.key);f.failHydration=true
        val cold=CharterRepository(CharterStore(f.memory,f.identity),f.ports);cold.open();cold.selectSaved(old.localKey)
        f.envelope=CharterFixtures.envelope("creation");cold.select(f.envelope.kind,f.envelope.key);assertEquals(f.envelope.key,cold.state.value.selected);assertTrue(cold.state.value.error!!.contains("Saved outcomes"));val other=f.store.record(f.envelope.key);f.calls.clear()
        for(command in listOf<suspend()->Unit>({cold.prepare()},{cold.recoverPreparation()},{cold.recover()},{cold.cancel()},{cold.refund(null)},{cold.publishSignature()}))assertTrue(runCatching{command()}.isFailure)
        assertTrue(f.calls.isEmpty());assertEquals(observedAgain(old),f.store.record(old.localKey));assertEquals(other,f.store.record(other.localKey));assertEquals(0,f.walletCalls)
        f.failHydration=false;cold.open();assertNull(cold.state.value.error);assertNotNull(cold.state.value.activity);cold.prepare();assertEquals(1,f.calls.count{it.first=="POST"});assertTrue(f.calls.last().second.endsWith("/prepare"));assertEquals(observedAgain(old),f.store.record(old.localKey));assertEquals(0,f.walletCalls)
    }
    @Test fun `terminal hydration cancellation or stale session retains proof without late publication`()=runBlocking {
        for(cancel in listOf(false,true)){
            val f=Fixture("sale");f.open();val original=f.repository.state.value.record!!;completed(f);f.afterHydrate={if(cancel)throw CancellationException("Charter screen stopped")else f.active=false}
            assertTrue(runCatching{f.repository.checkOriginal()}.isFailure);assertEquals(original,f.repository.state.value.record);assertEquals("completed",CharterEnvelope.from(f.store.record(original.localKey).envelope!!).status);assertFalse(f.calls.any{it.first=="POST"});assertEquals(0,f.walletCalls)
        }
    }

}
