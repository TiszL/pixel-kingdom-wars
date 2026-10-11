package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ExpiredBattleTest {
    private val raid="11111111-1111-4111-8111-111111111111"
    private class Memory:SecretStore { var raw:String?=null;override fun read()=raw;override fun write(value:String) { raw=value };override fun clear() { raw=null } }
    private fun page()=Json.parseToJsonElement("""{"protocolVersion":1,"raidId":"$raid","simVersion":14,"raidProtocolVersion":2,"source":"live","status":"expired","revision":"${"b".repeat(64)}","replaceFromTick":0,"lastSequence":-1,"commands":[],"result":null,"events":[],"_clientFirstPageReceivedAtNanos":1,"clock":{"protocolVersion":2,"revision":0,"rate":1,"anchorWallAt":null,"anchorSimMs":0,"serverNow":"2026-09-07T02:25:59.702Z","simNowMs":0,"battleEndsAt":null,"durationMs":90000}}""").jsonObject
    private fun pending()=PendingBattle("wallet","base",raid,writes=listOf(PendingBattleWrite("uncertain","/raids/$raid/commands",jsonBody("clientCommandId" to "uncertain"),true)))
    private fun coordinator(store:PendingBattleStore,pages:Flow<JsonObject>,post:suspend(String,JsonObject)->JsonObject={_,_->error("Expiry must never send an order")}) =
        BattleCoordinator("wallet","base",14,store,{_,_->error("An empty pending list is not expiry proof")},post,{pages})

    @Test fun `server expiry reconciles ambiguous commands without fabricated result and keeps Home receipt`() = runBlocking {
        val store=PendingBattleStore(Memory());store.put(pending())
        val c=coordinator(store,flowOf(page()));c.runForeground()
        assertEquals(BattlePhase.EXPIRED,c.state.value.phase);assertTrue(c.state.value.terminal)
        assertNull(c.state.value.result);assertNull(c.state.value.clock)
        assertEquals(emptyList<PendingBattleWrite>(),store.get("wallet","base")!!.writes)
        for(action in listOf<suspend()->Unit>({c.deploy("highlander",0,0)},{c.start()},{c.retreat()},{c.finish()},{c.retry("uncertain")}))
            assertTrue(runCatching { action() }.isFailure)
        assertNotNull(store.get("wallet","base"));c.home();assertNull(store.get("wallet","base"))
    }

    @Test fun `accepted prestart buff journal may expire without local refund assumptions`() = runBlocking {
        val store=PendingBattleStore(Memory());store.put(pending())
        val command=Json.parseToJsonElement("""{"sequence":0,"clientCommandId":"buff-1","kind":"buff","payload":{"buff":"warhorn"}}""")
        val expired=JsonObject(page()+mapOf("lastSequence" to JsonPrimitive(0),"commands" to JsonArray(listOf(command))))
        val c=coordinator(store,flowOf(expired));c.runForeground()
        assertTrue(c.state.value.expired);assertEquals(command,c.state.value.commands.single());assertNull(c.state.value.result)
    }

    @Test fun `partial unsupported or contradictory expiry never clears uncertain intent`() = runBlocking {
        val base=page();val clock=base["clock"]!!.jsonObject
        val invalid=listOf(
            JsonObject(base+("lastSequence" to JsonPrimitive(0))),
            JsonObject(base+("events" to JsonArray(listOf(jsonBody("e" to "deploy"))))),
            JsonObject(base+("result" to jsonBody("stars" to "0"))),
            JsonObject(base+("raidProtocolVersion" to JsonPrimitive(1))),
            JsonObject(base+("status" to JsonPrimitive("abandoned"))),
            JsonObject(base+("source" to JsonPrimitive("archive"))),
            JsonObject(base+("clock" to JsonObject(clock+("protocolVersion" to JsonPrimitive(1))))),
            JsonObject(base+("clock" to JsonObject(clock+("revision" to JsonPrimitive(1))))),
            JsonObject(base+("clock" to JsonObject(clock+("rate" to JsonPrimitive(2))))),
            JsonObject(base+("clock" to JsonObject(clock+("serverNow" to JsonPrimitive("invalid"))))),
            JsonObject(base+("clock" to JsonObject(clock+("anchorWallAt" to JsonPrimitive("2026-09-07T00:00:00Z"))))))
        for(value in invalid) {
            val store=PendingBattleStore(Memory());val original=pending();store.put(original)
            val c=coordinator(store,flowOf(value));c.runForeground()
            assertFalse(c.state.value.terminal);assertTrue(c.state.value.blocked)
            assertEquals(original,store.get("wallet","base"));assertTrue(runCatching { c.home() }.isFailure)
        }
    }

    @Test fun `only buffs can belong to a reservation that never armed or started`() = runBlocking {
        for(kind in listOf("deploy","hero","rally","start","speed","retreat","unknown")) {
            val command=buildJsonObject { put("sequence",0);put("clientCommandId","accepted");put("kind",kind) }
            val value=JsonObject(page()+mapOf("lastSequence" to JsonPrimitive(0),"commands" to JsonArray(listOf(command))))
            val store=PendingBattleStore(Memory());val original=pending();store.put(original)
            val c=coordinator(store,flowOf(value));c.runForeground()
            assertTrue(kind,c.state.value.blocked);assertFalse(c.state.value.expired)
            assertEquals(original,store.get("wallet","base"))
        }
    }

    @Test fun `terminal expiry cannot erase a previously acknowledged journal or started clock`() = runBlocking {
        val buff=Json.parseToJsonElement("""{"sequence":0,"clientCommandId":"buff","kind":"buff","payload":{"buff":"warhorn"},"serverOffsetMs":0,"acceptedAt":"2026-09-07T00:00:00Z"}""").jsonObject
        val prior=JsonObject(page()+mapOf("status" to JsonPrimitive("pending_orders"),"commands" to JsonArray(listOf(buff))))
        val expired=JsonObject(page()+mapOf("lastSequence" to JsonPrimitive(0),"commands" to JsonArray(listOf(buff))))
        val changes=listOf(
            "clientCommandId" to JsonPrimitive("different"),
            "serverOffsetMs" to JsonPrimitive(1),
            "acceptedAt" to JsonPrimitive("2026-09-07T00:00:01Z"),
            "payload" to jsonBody("buff" to "swiftboots"))
        val cases=mutableListOf(prior to page())
        changes.forEach { change -> cases.add(prior to JsonObject(expired+("commands" to JsonArray(listOf(JsonObject(buff+change)))))) }
        val staged=JsonObject(page()+("status" to JsonPrimitive("pending_orders")))
        val started=JsonObject(staged+("clock" to JsonObject(staged.getValue("clock").jsonObject+mapOf(
            "revision" to JsonPrimitive(1),"anchorWallAt" to JsonPrimitive("2026-09-07T00:00:00Z")))))
        cases.add(started to page())
        val deployed=JsonObject(buff+("kind" to JsonPrimitive("deploy")))
        cases.add(JsonObject(prior+("commands" to JsonArray(listOf(deployed)))) to page())
        for((observed,terminal) in cases) {
            val store=PendingBattleStore(Memory());val original=pending();store.put(original)
            val c=coordinator(store,flowOf(observed,terminal));c.runForeground()
            assertTrue(c.state.value.blocked);assertFalse(c.state.value.expired)
            assertEquals(original,store.get("wallet","base"));assertEquals(observed,c.state.value.presentation)
            assertEquals(observed.getValue("commands").jsonArray.toList(),c.state.value.commands)
        }
        // Added compatible envelope/payload fields do not rewrite known authority.
        val compatible=JsonObject(buff+mapOf("future" to JsonPrimitive(true),
            "payload" to JsonObject(buff.getValue("payload").jsonObject+("future" to JsonPrimitive(true)))))
        val store=PendingBattleStore(Memory());store.put(pending())
        val c=coordinator(store,flowOf(prior,JsonObject(expired+("commands" to JsonArray(listOf(compatible))))))
        c.runForeground();assertTrue(c.state.value.expired)
    }

    @Test fun `late contradictory expiry cannot discard a persisted server result`() = runBlocking {
        val store=PendingBattleStore(Memory());val original=pending();store.put(original)
        val pages=Channel<JsonObject>(Channel.UNLIMITED)
        val result=jsonBody("stars" to "0")
        val c=coordinator(store,pages.receiveAsFlow()) { _,_->buildJsonObject { put("result",result) } }
        val watching=launch { c.runForeground() }
        pages.send(JsonObject(page()+("status" to JsonPrimitive("pending_orders"))))
        withTimeout(2000) { c.state.first { it.phase==BattlePhase.STAGING } }
        c.finish();assertEquals(result,c.state.value.result)
        pages.send(page());watching.join()
        assertTrue(c.state.value.blocked);assertFalse(c.state.value.expired)
        assertEquals(result,c.state.value.result);assertEquals(original,store.get("wallet","base"))
    }

    @Test fun `delayed acknowledgement cannot resurrect an expired journal`() = runBlocking {
        val store=PendingBattleStore(Memory());store.put(pending().copy(writes=emptyList()))
        val pages=Channel<JsonObject>(Channel.UNLIMITED);val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
        val c=coordinator(store,pages.receiveAsFlow()) { _,body ->
            entered.complete(Unit);release.await()
            buildJsonObject { put("command",buildJsonObject { put("sequence",0);put("clientCommandId",body.getValue("clientCommandId")) }) }
        }
        val watching=launch { c.runForeground() }
        pages.send(JsonObject(page()+("status" to JsonPrimitive("pending_orders"))))
        withTimeout(2000) { c.state.first { it.phase==BattlePhase.STAGING } }
        val sending=async { c.rally(0,0) };entered.await()
        pages.send(page());withTimeout(2000) { c.state.first { it.expired } }
        release.complete(Unit);sending.await();watching.join()
        assertTrue(c.state.value.expired);assertTrue(c.state.value.commands.isEmpty());assertTrue(store.get("wallet","base")!!.writes.isEmpty())
    }

    @Test fun `cold restart reobserves terminal proof instead of retrying saved orders`() = runBlocking {
        val memory=Memory();PendingBattleStore(memory).put(pending())
        val first=coordinator(PendingBattleStore(memory),flowOf(page()));first.runForeground()
        val second=coordinator(PendingBattleStore(memory),flowOf(page()));second.runForeground()
        assertTrue(second.state.value.expired);assertNull(second.state.value.result)
        assertNotNull(PendingBattleStore(memory).get("wallet","base"))
    }

    @Test fun `protocol one observer stops at canonical expired response without polling or POST`() = runBlocking {
        var reads=0
        val api=BattlePresentation({path,_->reads++
            if(path=="/native/capabilities") Json.parseToJsonElement("""{"presentation":{"enabled":true,"protocolVersions":[1],"maxWaitMs":0}}""").jsonObject else page()
        },14,{error("Terminal observer must not wait")})
        assertEquals(1,api.observe(raid).toList().size);assertEquals(2,reads)
    }
}
