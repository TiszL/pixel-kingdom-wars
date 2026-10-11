package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.tournament.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import java.io.IOException
class TournamentRepositoryTest {
 private val f=TournamentFixtures
 private class Fixture {
  val f=TournamentFixtures;val memory=TournamentFixtures.Memory();val identity=f.identity();val store=TournamentStore(memory,identity)
  var current=true;var configured=true;var failAfterPost=false;var invalidateAfterSigning=false;var prompts=0;var hydrations=0;var raidStarted:String?=null;var operation=f.operation;var responseEntry=f.entry
  var hydrationError:Exception?=null;var onHydrate:()->Unit={}
  val calls=mutableListOf<Pair<String,String>>();var onPost:suspend (String,JsonObject)->Unit={_,_->}
  var responsePrize:JsonObject?=null
  var responseRaid:JsonElement=JsonNull;var participationRaids=JsonArray(emptyList())
  val operationResponses=mutableMapOf<String,JsonObject>()
  val port=object:TournamentPort {
   override val identity=this@Fixture.identity
   override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit):JsonElement {
    guard();calls+=method to path;if(method=="POST"){onPost(path,requireNotNull(body));if(failAfterPost)error("Reply lost")}
    val raw=when {
     path.endsWith("/events")->buildJsonObject{put("version",1);put("events",buildJsonArray{add(JsonObject(f.event+("terminal" to JsonNull)))});put("nextCursor",JsonNull)}
     path.endsWith("/participation")->buildJsonObject{put("version",1);put("eventId",f.eventId);put("entry",JsonNull);put("prize",JsonNull);put("raids",participationRaids)}
     path.contains("/raids")->responseRaid
     path.endsWith("/prize")&&responsePrize!=null->requireNotNull(responsePrize)
     path.contains("/events/")->JsonObject(f.event+("terminal" to JsonNull))
     path.endsWith("/clear")->operation
     path.contains("/entries")->responseEntry
     else->operationResponses[path.substringAfter("/operations/").substringBefore('/')]?:operation
    };retain(raw);guard();return raw
   }
  }
  val ports=object:TournamentPorts {
   override val transport=TournamentTransport(port)
   override fun capture(newAction:Boolean):()->Unit={check(current);if(newAction)check(configured)}
   override fun trust()=if(configured)f.pins else null
   override fun cryptoPolicy()=f.crypto
   override fun policy()=f.policy
   override fun key()=UUID.randomUUID().toString()
   override fun requireBase(baseId:String){require(baseId==f.eventId)}
   override suspend fun live(prepared:PreparedCharter,operation:JsonObject,guard:()->Unit):()->Unit=guard
   override suspend fun ready(guard:()->Unit)=guard()
   override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit){guard();prompts++;val saved=store.record(f.operationId);check("wallet" in saved.attempts);val bytes=f.wire.charterText("signedTransactionHex").chunked(2).map{it.toInt(16).toByte()}.toByteArray();val signed=prepared.verifySigned(bytes);if(invalidateAfterSigning)current=false;retain(signed);guard()}
   override suspend fun hydrate(guard:()->Unit){guard();onHydrate();hydrationError?.let{throw it};guard();hydrations++}
   override suspend fun battle(raidId:String,baseId:String,guard:()->Unit){guard();raidStarted=raidId}
  }
  val repository=TournamentRepository(store,ports)
  suspend fun prepared(){val r=store.operation(operation);store.observe(r.key,operation);store.accept(r.key,operation);repository.selectEvent(f.eventId);repository.selectOperation(f.operationId)}
 }
 @Test fun `entry request is persisted before POST and lost reply reuses exact identity`()=runBlocking {
  val x=Fixture();x.repository.selectEvent(f.eventId);x.onPost={_,body->val saved=x.store.read().records.single{it.kind=="entry"};assertEquals(body,saved.body)};x.failAfterPost=true
  assertThrows(Exception::class.java){runBlocking{x.repository.enter(f.entry.charterText("clanId"))}};val r=x.store.read().records.single{it.kind=="entry"};assertNull(r.response)
  assertThrows(Exception::class.java){runBlocking{x.repository.enter(f.entry.charterText("clanId"))}};assertEquals(1,x.calls.count{it.first=="POST"})
  x.failAfterPost=false;x.repository.retry(r.key);assertEquals(2,x.calls.count{it.first=="POST"});assertEquals(f.entry,x.store.record(r.key).response);Unit
 }
 @Test fun `late valid wallet callback is saved before stale view refusal`()=runBlocking {
  val x=Fixture();x.prepared();x.repository.review();x.invalidateAfterSigning=true
  assertThrows(Exception::class.java){runBlocking{x.repository.approve()}};assertEquals(f.wire,x.store.record(f.operationId).signed);assertEquals(1,x.prompts)
  x.current=true;x.repository.open();assertThrows(Exception::class.java){runBlocking{x.repository.review()}};assertEquals(1,x.prompts);Unit
 }
 @Test fun `wallet failure marker prevents another prompt even without a saved signature`()=runBlocking {
  val x=Fixture();x.prepared();x.repository.review();x.store.attempt(f.operationId,"wallet");assertThrows(Exception::class.java){runBlocking{x.repository.approve()}};assertEquals(0,x.prompts);Unit
 }
 @Test fun `default null trust blocks new effects while original GET recovery stays available`()=runBlocking {
  val x=Fixture();x.prepared();x.configured=false;x.repository.open();x.repository.selectOperation(f.operationId)
  assertThrows(Exception::class.java){runBlocking{x.repository.review()}};assertThrows(Exception::class.java){runBlocking{x.repository.enter(f.entry.charterText("clanId"))}};assertTrue(x.calls.all{it.first=="GET"});Unit
 }
 @Test fun `exact saved signature uploads while paused and does not open wallet`()=runBlocking {
  val x=Fixture();x.prepared();x.repository.review();x.repository.approve();x.configured=false
  x.onPost={path,body->assertTrue(path.endsWith("/signed"));val wire=java.util.Base64.getDecoder().decode(body.charterText("signedTransaction"));assertEquals(f.wire.charterText("signedTransactionHex"),wire.joinToString(""){"%02x".format(it.toInt() and 255)});x.operation=JsonObject(f.operation+mapOf("status" to JsonPrimitive("signed"),"signed" to f.wire))}
  x.repository.upload();assertEquals(1,x.prompts);assertEquals(f.wire,x.store.record(f.operationId).response?.get("signed"));Unit
 }
 @Test fun `catalogue policy or source change refuses approval before marker`()=runBlocking {
  val x=Fixture();x.prepared();x.repository.review();val t=f.operation.charterObject("operationTerms");x.operation=JsonObject(f.operation+("operationTerms" to JsonObject(t+("eventId" to JsonPrimitive(UUID.randomUUID().toString())))))
  assertThrows(Exception::class.java){runBlocking{x.repository.approve()}};assertEquals(0,x.prompts);assertFalse("wallet" in x.store.record(f.operationId).attempts);assertTrue(x.store.record(f.operationId).held);Unit
 }
 @Test fun `terminal original refreshes game state before publication`()=runBlocking {
  val x=Fixture();x.prepared();x.operation=JsonObject(f.operation+mapOf("status" to JsonPrimitive("cancelled"),"terminal" to buildJsonObject{put("id",UUID.randomUUID().toString());put("outcome","cancelled");put("record",buildJsonObject{})}));x.repository.selectOperation(f.operationId);assertEquals(1,x.hydrations);assertEquals("cancelled",x.repository.state.value.operation?.response?.charterText("status"));Unit
 }

 @Test fun `raid and prize intents reject another selected base before any POST`()=runBlocking {
  val x=Fixture();x.repository.selectEvent(f.eventId);val other=UUID.randomUUID().toString();assertThrows(Exception::class.java){runBlocking{x.repository.raid(other)}};assertThrows(Exception::class.java){runBlocking{x.repository.claim(other)}};assertEquals(0,x.calls.count{it.first=="POST"});assertTrue(x.store.read().records.isEmpty());Unit
 }
 @Test fun `unknown prize keeps its original destination and duplicate key after reply loss`()=runBlocking {
  val x=Fixture();x.repository.selectEvent(f.eventId);x.onPost={path,body->assertTrue(path.endsWith("/prize"));assertEquals(body,x.store.read().records.single{it.kind=="prize"}.body)};x.failAfterPost=true
  assertThrows(Exception::class.java){runBlocking{x.repository.claim(f.eventId)}};val old=x.store.read().records.single();assertThrows(Exception::class.java){runBlocking{x.repository.claim(f.eventId)}};assertEquals(old.key,x.store.read().records.single().key);assertEquals(2,x.calls.count{it.first=="POST"});Unit
 }
 @Test fun `lost raid reply binds its distinct server request only through the original key route`()=runBlocking {
  val x=Fixture();x.repository.selectEvent(f.eventId);x.failAfterPost=true
  assertThrows(Exception::class.java){runBlocking{x.repository.raid(f.eventId)}};val intent=x.store.read().records.single();assertNull(intent.response)
  val requestId=UUID.randomUUID().toString();val pending=buildJsonObject{put("version",1);put("eventId",f.eventId);put("requestId",requestId);put("baseId",f.eventId);put("status","requested");put("ordinal",JsonNull);put("raid",JsonNull)}
  x.participationRaids=JsonArray(listOf(JsonObject(pending+("requestId" to JsonPrimitive(intent.key)))))
  x.repository.selectEvent(f.eventId);assertNull(x.store.record(intent.key).response)
  x.failAfterPost=false;x.responseRaid=pending;x.repository.recoverIntent(intent.key)
  assertTrue(x.calls.contains("GET" to "/clans/charter/tournaments/events/${f.eventId}/raids/by-key/${intent.key}"));assertEquals(pending,TournamentStore(x.memory,x.identity).record(intent.key).response)
  val raidId=UUID.randomUUID().toString();val admitted=JsonObject(pending+mapOf("status" to JsonPrimitive("admitted"),"ordinal" to JsonPrimitive(1),"raid" to buildJsonObject{put("id",raidId);put("attackerBaseId",f.eventId)}))
  x.participationRaids=JsonArray(listOf(admitted));x.repository.selectEvent(f.eventId);assertEquals(admitted,x.store.record(intent.key).response)
  x.responseRaid=admitted;x.repository.play(intent.key);assertEquals(raidId,x.raidStarted);assertEquals(1,x.calls.count{it.first=="POST"});Unit
 }
 @Test fun `fresh clear first retains cancelled predecessor so refresh and restart preserve both originals`()=runBlocking {
  fun terminal(operation:JsonObject,outcome:String)=JsonObject(operation+mapOf("status" to JsonPrimitive(outcome),"terminal" to buildJsonObject{put("id",UUID.randomUUID().toString());put("outcome",outcome);put("record",buildJsonObject{})}))
  fun draftClear():JsonObject {
   val id=UUID.randomUUID().toString();val terms=JsonObject(f.operation.charterObject("operationTerms")+mapOf("action" to JsonPrimitive("clear"),"operationId" to JsonPrimitive(id),"expectedRevision" to JsonPrimitive(1),"clearance" to buildJsonObject{put("version",1);put("eventId",f.eventId);put("completedAt",f.event.getValue("playEndsAt"));put("rankings",JsonArray(emptyList()));put("occupations",JsonArray(emptyList()));put("entitlements",JsonArray(emptyList()))}))
   val original=JsonObject(f.operation.charterObject("original")+("operation" to JsonObject(f.operation.charterObject("original").charterObject("operation")+mapOf("id" to JsonPrimitive(id),"action" to JsonPrimitive("clear"),"expectedRevision" to JsonPrimitive(1)))))
   return JsonObject(f.operation+mapOf("original" to original,"operationTerms" to terms,"status" to JsonPrimitive("draft"),"attempt" to JsonNull,"preparation" to JsonNull,"signed" to JsonNull,"terminal" to JsonNull,"inventory" to buildJsonObject{put("version",1);put("revision","0");put("count",0);put("messages",JsonArray(emptyList()))}))
  }
  val x=Fixture();x.repository.selectEvent(f.eventId);val set=terminal(f.operation,"completed");val old=draftClear();val oldId=old.charterObject("original").charterObject("operation").charterText("id");val cancelled=terminal(old,"cancelled")
  val entryKey=UUID.randomUUID().toString();val clearKey=UUID.randomUUID().toString();val entryId=f.entry.charterText("id");val clearPath="/clans/charter/tournaments/entries/$entryId/clear"
  val staleEntry=JsonObject(f.entry+mapOf("status" to JsonPrimitive("entered"),"set" to set,"clear" to old));x.store.begin("entry",entryKey,f.eventId,"/clans/charter/tournaments/entries",buildJsonObject{put("eventId",f.eventId);put("clanId",f.entry.getValue("clanId"));put("idempotencyKey",entryKey)});x.store.accept(entryKey,staleEntry)
  x.store.begin("clear",clearKey,f.eventId,clearPath,buildJsonObject{put("idempotencyKey",clearKey)});x.store.accept(clearKey,old);x.store.operation(old);x.store.accept(oldId,cancelled)
  x.responseEntry=JsonObject(staleEntry+("clear" to cancelled));val next=draftClear();val nextId=next.charterObject("original").charterObject("operation").charterText("id");x.operationResponses.putAll(mapOf(f.operationId to set,oldId to cancelled,nextId to next))
  x.onPost={path,_->assertEquals(clearPath,path);assertEquals(cancelled,x.store.record(entryKey).response?.get("clear"));assertEquals(cancelled,x.store.record(oldId).response);x.operation=next;x.responseEntry=JsonObject(staleEntry+("clear" to next))}
  x.repository.clear();x.repository.check();val reopened=TournamentStore(x.memory,x.identity)
  assertEquals(next,reopened.record(entryKey).response?.get("clear"));assertEquals(cancelled,reopened.record(oldId).response);assertEquals(next,reopened.record(nextId).response);assertEquals(1,x.calls.count{it.first=="POST"});Unit
 }
 private suspend fun terminal(x:Fixture):TournamentRecord {
  x.operation=JsonObject(f.operation+mapOf("status" to JsonPrimitive("cancelled"),"terminal" to buildJsonObject{put("id",UUID.randomUUID().toString());put("outcome","cancelled");put("record",buildJsonObject{})}))
  val record=x.store.operation(x.operation);x.store.observe(record.key,x.operation);x.store.accept(record.key,x.operation);return record
 }
 @Test fun `cold terminal tournament history and original GET survive continued account refresh failure without new effects`()=runBlocking {
  val x=Fixture();val r=terminal(x);val saved=x.store.read();x.configured=false;x.hydrationError=IOException("hydration offline");val cold=TournamentRepository(x.store,x.ports)
  cold.open();assertEquals(saved,cold.state.value.journal);cold.selectEvent(f.eventId);cold.selectOperation(r.key);cold.recoverIntent(r.key);cold.check()
  assertEquals(x.operation,cold.state.value.operation!!.response);assertTrue(x.calls.contains("GET" to r.path));assertTrue(x.calls.all{it.first=="GET"});assertEquals(0,x.prompts);assertEquals(0,x.hydrations);assertEquals(saved.records,x.store.read().records);assertFalse(cold.state.value.reviewed)
  assertTrue(cold.state.value.error!!.contains("Saved tournament receipts"));x.hydrationError=null;cold.check();assertEquals(1,x.hydrations);assertNull(cold.state.value.error);cold.check();assertEquals(1,x.hydrations);Unit
 }
 @Test fun `tournament recovery hydration fallback never admits fresh or mixed mutation actions`()=runBlocking {
  val x=Fixture();val r=terminal(x);x.hydrationError=IOException("hydration offline");val repo=x.repository;repo.selectEvent(f.eventId);repo.selectOperation(r.key);val saved=x.store.read();val calls=x.calls.toList()
  val actions:List<suspend()->Unit> = listOf({repo.enter(f.entry.charterText("clanId"))},{repo.command("recover")},{repo.command("recover-preparation")},{repo.command("cancel")},{repo.upload()},{repo.cancelRaid(r.key)},{repo.closeEvent()},{repo.retry(r.key)})
  for(action in actions){val error=assertThrows(Exception::class.java){runBlocking{action()}};assertEquals("hydration offline",error.message)}
  assertEquals(saved,x.store.read());assertEquals(calls,x.calls);assertEquals(0,x.prompts);Unit
 }
 @Test fun `tournament read recovery propagates cancellation and stale hydration guards without marking current state refreshed`()=runBlocking {
  for(cancel in listOf(true,false)){
   val x=Fixture();val r=terminal(x);val repo=x.repository
   if(cancel)x.hydrationError=CancellationException("hydration cancelled") else x.onHydrate={x.current=false}
   val error=assertThrows(Exception::class.java){runBlocking{repo.selectOperation(r.key)}}
   if(cancel)assertTrue(error is CancellationException)
   assertFalse(repo.state.value.error.orEmpty().contains("Saved tournament receipts"));assertEquals(0,x.hydrations);assertEquals(x.operation,x.store.record(r.key).response)
   x.current=true;x.hydrationError=null;x.onHydrate={};repo.selectOperation(r.key);assertEquals(1,x.hydrations);assertTrue(x.calls.all{it.first=="GET"});assertEquals(0,x.prompts)
  };Unit
 }

 @Test fun `failed prize hydration without a captain operation holds later effects but preserves original recovery`()=runBlocking {
  val x=Fixture();val repo=x.repository;repo.selectEvent(f.eventId)
  x.responsePrize=buildJsonObject{put("eventId",f.eventId);put("wallet",x.identity.wallet);put("baseId",f.eventId);put("amounts",f.event.getValue("budget"));put("claimedAt",f.event.getValue("playEndsAt"))}
  x.hydrationError=IOException("hydration offline");assertThrows(Exception::class.java){runBlocking{repo.claim(f.eventId)}}
  val saved=x.store.read().records.single();assertEquals("prize",saved.kind);assertEquals(x.responsePrize,saved.response);assertEquals(1,x.calls.count{it.first=="POST"})
  val calls=x.calls.toList();val error=assertThrows(Exception::class.java){runBlocking{repo.closeEvent()}};assertEquals("hydration offline",error.message);assertEquals(calls,x.calls)
  x.configured=false;repo.recoverIntent(saved.key);assertEquals(saved,repo.state.value.journal!!.records.single());assertTrue(repo.state.value.error!!.contains("Saved tournament receipts"));assertEquals(0,x.hydrations)
  x.hydrationError=null;repo.recoverIntent(saved.key);assertNull(repo.state.value.error);assertEquals(1,x.hydrations);assertEquals(1,x.calls.count{it.first=="POST"});assertEquals(0,x.prompts);Unit
 }

}
