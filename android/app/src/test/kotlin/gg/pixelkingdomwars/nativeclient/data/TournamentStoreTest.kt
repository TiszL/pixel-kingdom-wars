package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
class TournamentStoreTest {
 private val f=TournamentFixtures
 private suspend fun original(s:TournamentStore){val r=s.operation(f.operation);s.observe(r.key,f.operation);s.accept(r.key,f.operation)}
 @Test fun `intent is durable before first POST and unknown entry blocks replacement`()=runBlocking {
  val memory=TournamentFixtures.Memory();val identity=f.identity();val s=TournamentStore(memory,identity);val key=UUID.randomUUID().toString();val body=buildJsonObject{put("eventId",f.eventId);put("clanId",f.entry.getValue("clanId"));put("idempotencyKey",key)}
  s.begin("entry",key,f.eventId,"/clans/charter/tournaments/entries",body);assertEquals(body,TournamentStore(memory,identity).record(key).body)
  assertThrows(Exception::class.java){runBlocking{s.begin("entry",UUID.randomUUID().toString(),f.eventId,"/clans/charter/tournaments/entries",body)}};Unit
 }
 @Test fun `unknown prize cannot change its destination on restart`()=runBlocking {
  val m=TournamentFixtures.Memory();val id=f.identity();val s=TournamentStore(m,id);val key=UUID.randomUUID().toString();val path="/clans/charter/tournaments/events/${f.eventId}/prize";s.begin("prize",key,f.eventId,path,buildJsonObject{put("baseId",key)})
  assertThrows(Exception::class.java){runBlocking{TournamentStore(m,id).begin("prize",UUID.randomUUID().toString(),f.eventId,path,buildJsonObject{put("baseId",UUID.randomUUID().toString())})}};Unit
 }
 @Test fun `wallet marker and verified approval survive serialized reopen`()=runBlocking {
  val m=TournamentFixtures.Memory();val id=f.identity();val s=TournamentStore(m,id);original(s);s.review(f.operationId,f.review());s.attempt(f.operationId,"wallet");s.signed(f.operationId,f.wire)
  val saved=TournamentStore(m,id).record(f.operationId);assertEquals(f.wire,saved.signed);assertTrue("wallet" in saved.attempts);Unit
 }
 @Test fun `late approval is latched before failing storage and blocks another prompt`()=runBlocking {
  val m=TournamentFixtures.Memory();val id=f.identity();val s=TournamentStore(m,id);original(s);s.review(f.operationId,f.review());s.attempt(f.operationId,"wallet");m.failRead=true
  assertThrows(Exception::class.java){runBlocking{s.signed(f.operationId,f.wire)}};m.failRead=false
  val restarted=TournamentStore(m,id);assertEquals(f.wire,restarted.record(f.operationId).signed);assertThrows(Exception::class.java){runBlocking{restarted.attempt(f.operationId,"wallet")}};Unit
 }
 @Test fun `received malformed terminal remains held across failed writes and remount`()=runBlocking {
  val m=TournamentFixtures.Memory();val id=f.identity();val s=TournamentStore(m,id);original(s);val invalid=JsonObject(f.operation+("status" to JsonPrimitive("completed")));m.fail=true
  assertThrows(Exception::class.java){runBlocking{s.observe(f.operationId,invalid)}};m.fail=false;val recovered=TournamentStore(m,id);assertTrue(recovered.record(f.operationId).held);assertEquals(invalid,recovered.record(f.operationId).observations.last());assertThrows(Exception::class.java){runBlocking{recovered.accept(f.operationId,invalid)}};assertThrows(Exception::class.java){runBlocking{recovered.attempt(f.operationId,"prepare")}};Unit
 }
 @Test fun `original operation and terminal cannot be replaced by a newer response`()=runBlocking {
  val s=TournamentStore(TournamentFixtures.Memory(),f.identity());original(s);val changed=JsonObject(f.operation+("entryId" to JsonPrimitive(UUID.randomUUID().toString())));assertThrows(Exception::class.java){runBlocking{s.accept(f.operationId,changed)}}
  val end=JsonObject(f.operation+mapOf("status" to JsonPrimitive("cancelled"),"terminal" to buildJsonObject{put("id",UUID.randomUUID().toString());put("outcome","cancelled");put("record",buildJsonObject{})}));s.accept(f.operationId,end)
  assertThrows(Exception::class.java){runBlocking{s.accept(f.operationId,f.operation)}};Unit
 }
 @Test fun `a forged signed wire fails independent verification on durable reopen`()=runBlocking {
  val m=TournamentFixtures.Memory();val id=f.identity();val s=TournamentStore(m,id);original(s);s.review(f.operationId,f.review());s.attempt(f.operationId,"wallet");s.signed(f.operationId,f.wire)
  m.value=requireNotNull(m.value).replace(f.wire.charterText("wireSha256"),"00".repeat(32));assertThrows(Exception::class.java){runBlocking{TournamentStore(m,id).read()}};Unit
 }

 @Test fun `cancelled clear permits a fresh key only after its bound operation terminal`()=runBlocking {
  val clear=f.vectors.getValue("rows").jsonArray[1].jsonObject.charterObject("operation");val s=TournamentStore(TournamentFixtures.Memory(),f.identity().copy(wallet=clear.charterObject("original").charterObject("operation").charterText("leader")));val key=UUID.randomUUID().toString();val path="/clans/charter/tournaments/entries/${clear.charterText("entryId")}/clear"
  s.begin("clear",key,f.eventId,path,buildJsonObject{put("idempotencyKey",key)});s.observe(key,clear);s.accept(key,clear);val op=s.operation(clear);s.observe(op.key,clear);s.accept(op.key,clear)
  val next=UUID.randomUUID().toString();assertThrows(Exception::class.java){runBlocking{s.begin("clear",next,f.eventId,path,buildJsonObject{put("idempotencyKey",next)})}}
  val cancelled=JsonObject(clear+mapOf("status" to JsonPrimitive("cancelled"),"terminal" to buildJsonObject{put("id",UUID.randomUUID().toString());put("outcome","cancelled");put("record",buildJsonObject{})}));s.accept(op.key,cancelled)
  assertEquals(next,s.begin("clear",next,f.eventId,path,buildJsonObject{put("idempotencyKey",next)}).key);Unit
 }
 @Test fun `unadmitted raid identity is preserved until its immutable cancellation`()=runBlocking {
  val s=TournamentStore(TournamentFixtures.Memory(),f.identity());val key=UUID.randomUUID().toString();val path="/clans/charter/tournaments/events/${f.eventId}/raids";val body=buildJsonObject{put("baseId",f.eventId);put("idempotencyKey",key)};s.begin("raid",key,f.eventId,path,body)
  val pending=buildJsonObject{put("version",1);put("eventId",f.eventId);put("requestId",key);put("baseId",f.eventId);put("status","requested");put("ordinal",JsonNull);put("raid",JsonNull)};s.accept(key,pending)
  val next=UUID.randomUUID().toString();assertThrows(Exception::class.java){runBlocking{s.begin("raid",next,f.eventId,path,JsonObject(body+("idempotencyKey" to JsonPrimitive(next))))}}
  s.accept(key,JsonObject(pending+("status" to JsonPrimitive("cancelled"))));assertEquals(next,s.begin("raid",next,f.eventId,path,JsonObject(body+("idempotencyKey" to JsonPrimitive(next)))).key)
  assertThrows(Exception::class.java){runBlocking{s.accept(key,pending)}};Unit
 }
 @Test fun `server request identity differs from retry key but can never change after attribution`()=runBlocking {
  val m=TournamentFixtures.Memory();val identity=f.identity();val s=TournamentStore(m,identity);val key=UUID.randomUUID().toString();val path="/clans/charter/tournaments/events/${f.eventId}/raids";s.begin("raid",key,f.eventId,path,buildJsonObject{put("baseId",f.eventId);put("idempotencyKey",key)})
  val response=buildJsonObject{put("version",1);put("eventId",f.eventId);put("requestId",UUID.randomUUID().toString());put("baseId",f.eventId);put("status","admitted");put("ordinal",1);put("raid",buildJsonObject{put("id",UUID.randomUUID().toString());put("attackerBaseId",f.eventId)})}
  s.accept(key,response);assertEquals(response,TournamentStore(m,identity).record(key).response)
  for(field in listOf("requestId","eventId","baseId"))assertThrows(Exception::class.java){runBlocking{s.accept(key,JsonObject(response+(field to JsonPrimitive(UUID.randomUUID().toString()))))}}
  assertThrows(Exception::class.java){runBlocking{s.accept(key,JsonObject(response+("raid" to JsonObject(response.charterObject("raid")+("id" to JsonPrimitive(UUID.randomUUID().toString()))))))}};Unit
 }
 @Test fun `distinct client commands cannot claim the same server request on accept or reopen`()=runBlocking {
  val m=TournamentFixtures.Memory();val identity=f.identity();val s=TournamentStore(m,identity);val first=UUID.randomUUID().toString();val second=UUID.randomUUID().toString();val path="/clans/charter/tournaments/events/${f.eventId}/raids"
  s.begin("raid",first,f.eventId,path,buildJsonObject{put("baseId",f.eventId);put("idempotencyKey",first)})
  val response=buildJsonObject{put("version",1);put("eventId",f.eventId);put("requestId",UUID.randomUUID().toString());put("baseId",f.eventId);put("status","admitted");put("ordinal",1);put("raid",buildJsonObject{put("id",UUID.randomUUID().toString());put("attackerBaseId",f.eventId)})};s.accept(first,response)
  s.begin("raid",second,f.eventId,path,buildJsonObject{put("baseId",f.eventId);put("idempotencyKey",second)})
  assertThrows(Exception::class.java){runBlocking{s.accept(second,response)}};assertNull(s.record(second).response);assertEquals(response,s.record(first).response)
  val journal=s.read();m.value=Json.encodeToString(TournamentJournal.serializer(),journal.copy(records=journal.records.map{if(it.key==second)it.copy(response=response) else it}))
  assertThrows(Exception::class.java){runBlocking{TournamentStore(m,identity).read()}};Unit
 }

 @Test fun `durable request kind key event and path cannot be remapped on restore`()=runBlocking {
  val m=TournamentFixtures.Memory();val identity=f.identity();val s=TournamentStore(m,identity);val key=UUID.randomUUID().toString();val body=buildJsonObject{put("baseId",f.eventId);put("idempotencyKey",key)};val path="/clans/charter/tournaments/events/${f.eventId}/raids";s.begin("raid",key,f.eventId,path,body)
  val valid=requireNotNull(m.value);val raw=Json.parseToJsonElement(valid).jsonObject;val record=raw.getValue("records").jsonArray.single().jsonObject
  for(change in listOf("key" to JsonPrimitive(UUID.randomUUID().toString()),"eventId" to JsonPrimitive(UUID.randomUUID().toString()),"kind" to JsonPrimitive("entry"),"body" to JsonObject(body+("idempotencyKey" to JsonPrimitive(UUID.randomUUID().toString()))),"path" to JsonPrimitive("/clans/charter/tournaments/events/${UUID.randomUUID()}/raids"))){m.value=JsonObject(raw+("records" to JsonArray(listOf(JsonObject(record+change))))).toString();assertThrows(Exception::class.java){runBlocking{TournamentStore(m,identity).read()}}}
  m.value=valid;assertEquals(key,TournamentStore(m,identity).read().records.single().key);Unit
 }
 @Test fun `request identity mismatch refuses before any durable intent exists`()=runBlocking {
  val m=TournamentFixtures.Memory();val s=TournamentStore(m,f.identity());val key=UUID.randomUUID().toString();val other=UUID.randomUUID().toString();val body=buildJsonObject{put("eventId",f.eventId);put("clanId",f.entry.getValue("clanId"));put("idempotencyKey",other)}
  assertThrows(Exception::class.java){runBlocking{s.begin("entry",key,f.eventId,"/clans/charter/tournaments/entries",body)}};assertNull(m.value)
  assertThrows(Exception::class.java){runBlocking{s.begin("entry",other,UUID.randomUUID().toString(),"/clans/charter/tournaments/entries",body)}};assertNull(m.value);Unit
 }

 private fun fill(m:TournamentFixtures.Memory,identity:gg.pixelkingdomwars.nativeclient.starter.StarterIdentity,count:Int) {
  val records=(0 until count).map{val key=UUID.randomUUID().toString();val event=UUID.randomUUID().toString();TournamentRecord(key,"prize",event,"/clans/charter/tournaments/events/$event/prize",buildJsonObject{put("baseId",key)})}
  m.value=Json.encodeToString(TournamentJournal.serializer(),TournamentJournal(identity=identity,records=records))
 }
 private fun draftClear():JsonObject {
  val id=UUID.randomUUID().toString();val terms=JsonObject(f.operation.charterObject("operationTerms")+mapOf("action" to JsonPrimitive("clear"),"operationId" to JsonPrimitive(id),"expectedRevision" to JsonPrimitive(1),"clearance" to buildJsonObject{put("version",1);put("eventId",f.eventId);put("completedAt",f.event.getValue("playEndsAt"));put("rankings",JsonArray(emptyList()));put("occupations",JsonArray(emptyList()));put("entitlements",JsonArray(emptyList()))}))
  val original=JsonObject(f.operation.charterObject("original")+("operation" to JsonObject(f.operation.charterObject("original").charterObject("operation")+mapOf("id" to JsonPrimitive(id),"action" to JsonPrimitive("clear"),"expectedRevision" to JsonPrimitive(1)))))
  return JsonObject(f.operation+mapOf("original" to original,"operationTerms" to terms,"status" to JsonPrimitive("draft"),"attempt" to JsonNull,"preparation" to JsonNull,"signed" to JsonNull,"terminal" to JsonNull,"inventory" to buildJsonObject{put("version",1);put("revision","0");put("count",0);put("messages",JsonArray(emptyList()))}))
 }
 @Test fun `entry POST cannot consume the room needed for its child and first clear`()=runBlocking {
  val m=TournamentFixtures.Memory();val identity=f.identity();fill(m,identity,125);val before=m.value;val store=TournamentStore(m,identity);val key=UUID.randomUUID().toString();val body=buildJsonObject{put("eventId",f.eventId);put("clanId",f.entry.getValue("clanId"));put("idempotencyKey",key)}
  assertThrows(Exception::class.java){runBlocking{store.begin("entry",key,f.eventId,"/clans/charter/tournaments/entries",body)}};assertEquals(before,m.value);Unit
 }
 @Test fun `reserved children materialize at the capacity boundary and unrelated writes cannot steal clear room`()=runBlocking {
  val m=TournamentFixtures.Memory();val identity=f.identity();fill(m,identity,124);val store=TournamentStore(m,identity);val key=UUID.randomUUID().toString();val body=buildJsonObject{put("eventId",f.eventId);put("clanId",f.entry.getValue("clanId"));put("idempotencyKey",key)}
  store.begin("entry",key,f.eventId,"/clans/charter/tournaments/entries",body);store.accept(key,f.entry);val op=store.operation(f.operation);store.accept(op.key,f.operation)
  val raidKey=UUID.randomUUID().toString();assertThrows(Exception::class.java){runBlocking{store.begin("raid",raidKey,f.eventId,"/clans/charter/tournaments/events/${f.eventId}/raids",buildJsonObject{put("baseId",f.eventId);put("idempotencyKey",raidKey)})}}
  val clearKey=UUID.randomUUID().toString();val clear=draftClear();store.begin("clear",clearKey,f.eventId,"/clans/charter/tournaments/entries/${f.entry.charterText("id")}/clear",buildJsonObject{put("idempotencyKey",clearKey)});store.accept(clearKey,clear);val clearOp=store.operation(clear);store.accept(clearOp.key,clear)
  assertEquals(128,store.read().records.size);assertEquals(clear,store.record(clearOp.key).response);Unit
 }
 @Test fun `observed cancellation is retained even when it restores unavailable reservations`()=runBlocking {
  val m=TournamentFixtures.Memory();val identity=f.identity();fill(m,identity,124);val store=TournamentStore(m,identity);val key=UUID.randomUUID().toString();store.begin("entry",key,f.eventId,"/clans/charter/tournaments/entries",buildJsonObject{put("eventId",f.eventId);put("clanId",f.entry.getValue("clanId"));put("idempotencyKey",key)});store.accept(key,f.entry);val set=store.operation(f.operation);store.accept(set.key,f.operation)
  val clearKey=UUID.randomUUID().toString();val clear=draftClear();store.begin("clear",clearKey,f.eventId,"/clans/charter/tournaments/entries/${f.entry.charterText("id")}/clear",buildJsonObject{put("idempotencyKey",clearKey)});store.accept(clearKey,clear);val op=store.operation(clear);store.accept(op.key,clear)
  val cancelled=JsonObject(clear+mapOf("status" to JsonPrimitive("cancelled"),"terminal" to buildJsonObject{put("id",UUID.randomUUID().toString());put("outcome","cancelled");put("record",buildJsonObject{})}));store.observe(op.key,cancelled);store.accept(op.key,cancelled);assertEquals(cancelled,TournamentStore(m,identity).record(op.key).response)
  val raidKey=UUID.randomUUID().toString();assertThrows(Exception::class.java){runBlocking{store.begin("raid",raidKey,f.eventId,"/clans/charter/tournaments/events/${f.eventId}/raids",buildJsonObject{put("baseId",f.eventId);put("idempotencyKey",raidKey)})}};Unit
 }
}
