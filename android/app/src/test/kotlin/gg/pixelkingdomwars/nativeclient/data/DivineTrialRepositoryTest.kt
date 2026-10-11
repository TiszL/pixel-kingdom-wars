package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.divine.*
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class DivineTrialRepositoryTest {
 private val f=DivineTrialFixtures
 private inner class Fixture {
  val identity=f.identity();var participant=f.participant(null);var allow=true;var current=true;var offline=false;var lose:String?=null;var stale=false;var disk=DivineTrialFixtures.Memory();var store=DivineTrialStore(disk,identity);val calls=mutableListOf<Pair<String,String>>();var hydrate=0;var abandonStatus="abandoned"
  fun repo():DivineTrialRepository {val ports=object:DivineTrialPorts{
   override fun rules()=f.rules;override fun key()=UUID.randomUUID().toString();override fun owned(base:String){require(base==f.base)};override fun capture(fresh:Boolean):()->Unit={check(current);if(fresh)check(allow)};override suspend fun hydrate(guard:()->Unit){guard();hydrate++}
   override val transport=DivineTransport(object:DivinePort{override val identity=this@Fixture.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
     guard();if(offline)throw IOException("Source unavailable");calls+=method to path
     val raw=if(method=="GET")when{path.endsWith("/participant")->participant;path=="/divine-trials/events"->buildJsonObject{put("version",1);put("events",JsonArray(listOf(f.event)));put("nextCursor",JsonNull)};else->error("Unexpected read")}
     else {val e=store.read().events.single();val c=e.commands.single{it.request==body&&store.path(e.id,it)==path};assertTrue("Original marker precedes HTTP",c.sent)
      when(c.kind){
       "entries"->JsonObject(f.entry+mapOf("baseId" to body!!.getValue("baseId"),"idempotencyKey" to body.getValue("idempotencyKey"))).also{participant=f.participant(it)}
       "attempts"->{val previous=participant.drows("attempts");JsonObject(f.admitted+mapOf("id" to JsonPrimitive(if(previous.isEmpty())f.admitted.dt("id")else UUID.randomUUID().toString()),"ordinal" to JsonPrimitive(previous.size+1),"baseId" to body!!.getValue("baseId"),"idempotencyKey" to body.getValue("idempotencyKey"))).also{participant=f.participant(participant.doptional("entry"),previous+it)}}
       "submit"->{val a=participant.drows("attempts").single();JsonObject(f.complete+mapOf("idempotencyKey" to a.getValue("idempotencyKey"),"baseId" to a.getValue("baseId"))).also{require(it["orders"]==body!!["orders"]);participant=f.participant(participant.doptional("entry"),listOf(it))}}
       "abandon"->terminal(participant.drows("attempts").single{it.dt("id")==c.attemptId},abandonStatus).also{ended->participant=f.participant(participant.doptional("entry"),participant.drows("attempts").map{if(it.dt("id")==c.attemptId)ended else it})}
       "prize"->buildJsonObject{put("eventId",f.event.getValue("id"));put("wallet",f.wallet);put("baseId",body!!.getValue("baseId"));put("amounts",participant.dobj("prize").getValue("amounts"));put("claimedAt","2035-01-08T00:00:01.000Z")}.also{participant=f.participant(participant.doptional("entry"),participant.drows("attempts"),buildJsonObject{put("amounts",it.getValue("amounts"));put("claim",it)})}
       else->error("Unexpected trial mutation")
      }
     };if(lose==path){lose=null;throw IOException("Lost accepted response")};retain(raw);if(stale&&method=="POST"){current=false};guard();return raw
    }
   })
  };return DivineTrialRepository(store,ports)}
  suspend fun open():DivineTrialRepository=repo().also{it.select(f.event)}
  suspend fun ready():DivineTrialRepository=open().also{it.enter(f.base);it.admit(f.base)}
  suspend fun cold():DivineTrialRepository {disk=DivineTrialFixtures.Memory(disk.value);store=DivineTrialStore(disk,identity);return repo().also{it.local();it.reopen(f.event.dt("id"))}}
 }
 @Test fun `lost submit reply recovers completed original after serialized reopen without a second POST`()=runBlocking {val x=Fixture();val r=x.ready();x.lose="/divine-trials/attempts/${f.admitted.dt("id")}/submit";assertTrue(runCatching{r.submit(f.admitted.dt("id"),f.complete.dobj("orders"))}.isFailure);val c=x.store.read().events.single().commands.last();assertNull(c.response);x.allow=false;val cold=x.cold();cold.retry(c.id);val recovered=x.store.read().events.single();assertEquals(f.complete.getValue("result"),recovered.commands.last().response!!["result"]);assertEquals(1,x.calls.count{it.first=="POST"&&it.second.endsWith("/submit")})}
 @Test fun `unknown entry must recover before another key can be created`()=runBlocking {val x=Fixture();val r=x.open();x.lose="/divine-trials/events/${f.event.dt("id")}/entries";assertTrue(runCatching{r.enter(f.base)}.isFailure);val c=x.store.read().events.single().commands.single();assertTrue(runCatching{r.enter(f.base)}.isFailure);r.retry(c.id);assertEquals(1,x.calls.count{it.first=="POST"});assertEquals(c.request["idempotencyKey"],x.store.read().events.single().commands.single().response!!["idempotencyKey"])}
 @Test fun `lost prize acknowledgement retains original destination through cold paused recovery`()=runBlocking {val x=Fixture();val r=x.ready();r.submit(f.admitted.dt("id"),f.complete.dobj("orders"));val amounts=f.vector.dobj("settlement").dobj("budget");x.participant=f.participant(x.participant.doptional("entry"),x.participant.drows("attempts"),buildJsonObject{put("amounts",amounts);put("claim",JsonNull)});x.lose="/divine-trials/events/${f.event.dt("id")}/prize";assertTrue(runCatching{r.claim(f.base)}.isFailure);val c=x.store.read().events.single().commands.last();x.allow=false;val cold=x.cold();cold.retry(c.id);assertEquals(f.base,x.store.read().events.single().commands.last().response!!.dt("baseId"));assertEquals(1,x.calls.count{it.first=="POST"&&it.second.endsWith("/prize")});x.offline=true;assertTrue(runCatching{cold.check()}.isFailure);cold.local();assertNotNull(cold.state.value.selected?.participant?.dobj("prize")?.doptional("claim"))}
 @Test fun `capture refusal releases identity mutex so the saved view can recover`()=runBlocking {val x=Fixture();val r=x.open();x.allow=false;assertTrue(runCatching{r.enter(f.base)}.isFailure);x.allow=true;r.enter(f.base);assertEquals(1,x.calls.count{it.first=="POST"})}
 @Test fun `late valid original is retained before stale view guard refuses publication`()=runBlocking {val x=Fixture();val r=x.open();x.stale=true;assertTrue(runCatching{r.enter(f.base)}.isFailure);assertNotNull(x.store.read().events.single().commands.single().response);assertEquals(1,x.calls.count{it.first=="POST"})}
 @Test fun `frozen batch cannot be replaced or abandoned after committed request`()=runBlocking {val x=Fixture();val r=x.ready();r.submit(f.admitted.dt("id"),f.complete.dobj("orders"));val before=x.calls.count{it.first=="POST"};assertTrue(runCatching{r.submit(f.admitted.dt("id"),f.vector.drows("plans")[1].dobj("attempt").dobj("orders"))}.isFailure);assertTrue(runCatching{r.abandon(f.admitted.dt("id"))}.isFailure);assertEquals(before,x.calls.count{it.first=="POST"});assertTrue(x.calls.all{it.second.startsWith("/divine-trials/")})}
 @Test fun `write failure stops HTTP while retained response drains on repaired storage`()=runBlocking {val x=Fixture();val r=x.open();x.disk.fail=true;assertTrue(runCatching{r.enter(f.base)}.isFailure);assertEquals(0,x.calls.count{it.first=="POST"});x.disk.fail=false;r.enter(f.base);val saved=x.store.read().events.single();x.disk.fail=true;assertTrue(runCatching{x.store.observe(saved.id,null,x.participant)}.isFailure);x.disk.fail=false;assertEquals(x.participant,x.store.read().events.single().participant)}
 @Test fun `persisted terminal and original actor cannot roll back or migrate`()=runBlocking {val x=Fixture();val r=x.ready();r.submit(f.admitted.dt("id"),f.complete.dobj("orders"));val original=x.store.read().events.single();assertTrue(runCatching{x.store.observe(original.id,null,f.participant(x.participant.doptional("entry"),listOf(f.admitted)))}.isFailure);assertTrue(x.disk.value!!.contains("completed"));assertTrue(runCatching{DivineTrialStore(DivineTrialFixtures.Memory(x.disk.value),f.identity()).read()}.isFailure)}
 @Test fun `participant omission cannot erase a reply already accepted into original custody`()=runBlocking {val x=Fixture();val r=x.open();r.enter(f.base);val saved=x.store.read().events.single();assertNotNull(saved.commands.single().response);assertTrue(runCatching{x.store.observe(saved.id,null,f.participant(null))}.isFailure);assertTrue(x.disk.value!!.contains(saved.commands.single().id))}

 private fun terminal(a:JsonObject,status:String)=JsonObject(a+mapOf("status" to JsonPrimitive(status),"orders" to JsonNull,"result" to JsonNull,"completedAt" to JsonPrimitive("2035-01-08T00:00:00.000Z")))
 private fun outcome(a:JsonObject,result:JsonObject)=JsonObject(result+listOf("id","eventId","wallet","baseId","idempotencyKey","ordinal","admittedAt").associateWith{a.getValue(it)})
 private fun entitlement()=buildJsonObject{put("amounts",f.vector.dobj("settlement").dobj("budget"));put("claim",JsonNull)}
 @Test fun `unsent second batch superseded by canonical closure preserves first prize through cold reopen`()=runBlocking {
  for(status in listOf("expired","abandoned")){
   val x=Fixture();val r=x.ready();r.submit(f.admitted.dt("id"),f.complete.dobj("orders"));r.admit(f.base)
   val original=x.participant.drows("attempts").last();val command=DivineCommand(UUID.randomUUID().toString(),"submit",buildJsonObject{put("orders",f.complete.getValue("orders"))},original.dt("id"));x.store.begin(f.event.dt("id"),command)
   val closed=terminal(original,status);x.participant=f.participant(x.participant.doptional("entry"),x.participant.drows("attempts").dropLast(1)+closed,entitlement())
   val cold=x.cold();cold.retry(command.id);val saved=x.store.event(f.event.dt("id")).commands.last()
   assertEquals(command.request,saved.request);assertFalse(saved.sent);assertNull(saved.response);assertEquals(closed,saved.supersededBy);assertFalse(saved.retryable)
   cold.claim(f.base);val again=x.cold();again.retry(command.id)
   val history=x.store.event(f.event.dt("id"));assertEquals(saved,history.commands.single{it.id==command.id});assertNotNull(history.participant!!.dobj("prize").doptional("claim"))
   assertEquals(1,x.calls.count{it.first=="POST"&&it.second.endsWith("/submit")});assertEquals(1,x.calls.count{it.first=="POST"&&it.second.endsWith("/prize")})
  }
 }
 @Test fun `unknown abandon superseded by another device commit never resends and preserves its first proof`()=runBlocking {
  val x=Fixture();x.ready();val original=x.participant.drows("attempts").single();val c=DivineCommand(UUID.randomUUID().toString(),"abandon",buildJsonObject{},original.dt("id"));x.store.begin(f.event.dt("id"),c);x.store.mark(f.event.dt("id"),c.id)
  val committed=outcome(original,f.committed);x.participant=f.participant(x.participant.doptional("entry"),listOf(committed));val cold=x.cold();cold.retry(c.id)
  val saved=x.store.event(f.event.dt("id")).commands.last();assertNull(saved.response);assertEquals(committed,saved.supersededBy);assertTrue(saved.sent)
  x.participant=f.participant(x.participant.doptional("entry"),listOf(outcome(original,f.complete)));cold.check();cold.admit(f.base)
  val again=x.cold();again.retry(c.id);assertEquals(2,x.participant.drows("attempts").size);assertEquals(saved,x.store.event(f.event.dt("id")).commands.single{it.id==c.id});assertEquals(0,x.calls.count{it.first=="POST"&&it.second.endsWith("/abandon")})
 }
 @Test fun `different canonical batch supersedes an unsent plan without treating it as accepted`()=runBlocking {
  val x=Fixture();x.ready();val a=x.participant.drows("attempts").single();val c=DivineCommand(UUID.randomUUID().toString(),"submit",buildJsonObject{put("orders",f.complete.getValue("orders"))},a.dt("id"));x.store.begin(f.event.dt("id"),c)
  // An admitted observation is not evidence that this saved batch has resolved.
  val before=x.cold();assertTrue(x.store.event(f.event.dt("id")).commands.last().unresolved);assertTrue(runCatching{before.abandon(a.dt("id"))}.isFailure)
  val other=outcome(a,f.vector.drows("plans")[1].dobj("attempt"));assertNotEquals(c.request["orders"],other["orders"])
  val committed=JsonObject(other+mapOf("status" to JsonPrimitive("committed"),"result" to JsonNull,"completedAt" to JsonNull));x.participant=f.participant(x.participant.doptional("entry"),listOf(committed));val cold=x.cold();cold.retry(c.id)
  assertNull(x.store.event(f.event.dt("id")).commands.last().response);assertEquals(committed,x.store.event(f.event.dt("id")).commands.last().supersededBy)
  x.participant=f.participant(x.participant.doptional("entry"),listOf(other),entitlement());cold.check();cold.claim(f.base);val again=x.cold();again.retry(c.id)
  assertEquals(c.request,x.store.event(f.event.dt("id")).commands.single{it.id==c.id}.request);assertEquals(0,x.calls.count{it.first=="POST"&&it.second.endsWith("/submit")});assertEquals(1,x.calls.count{it.first=="POST"&&it.second.endsWith("/prize")})
 }
 @Test fun `canonical expiry resolves unknown abandon but cannot fabricate an accepted abandonment`()=runBlocking {
  val x=Fixture();x.ready();val a=x.participant.drows("attempts").single();val c=DivineCommand(UUID.randomUUID().toString(),"abandon",buildJsonObject{},a.dt("id"));x.store.begin(f.event.dt("id"),c);x.store.mark(f.event.dt("id"),c.id)
  val expired=terminal(a,"expired");x.participant=f.participant(x.participant.doptional("entry"),listOf(expired),entitlement());val cold=x.cold();cold.retry(c.id);cold.claim(f.base)
  val saved=x.store.event(f.event.dt("id")).commands.single{it.id==c.id};assertNull(saved.response);assertEquals(expired,saved.supersededBy)
  assertTrue(runCatching{x.store.observe(f.event.dt("id"),c.id,terminal(a,"abandoned"))}.isFailure);assertEquals(0,x.calls.count{it.first=="POST"&&it.second.endsWith("/abandon")})
 }

 @Test fun `expiry returned by the abandon POST is retained as supersession before refresh`()=runBlocking {
  val x=Fixture();val r=x.ready();x.abandonStatus="expired";r.abandon(f.admitted.dt("id"));val saved=x.store.event(f.event.dt("id")).commands.last()
  assertNull(saved.response);assertEquals("expired",saved.supersededBy!!.dt("status"));assertTrue(saved.sent);assertTrue(x.store.event(f.event.dt("id")).held.isEmpty())
  x.participant=f.participant(x.participant.doptional("entry"),x.participant.drows("attempts"),entitlement());val cold=x.cold();cold.retry(saved.id);cold.claim(f.base)
  assertEquals(saved,x.store.event(f.event.dt("id")).commands.single{it.id==saved.id});assertEquals(1,x.calls.count{it.first=="POST"&&it.second.endsWith("/abandon")});assertEquals(1,x.calls.count{it.first=="POST"&&it.second.endsWith("/prize")})
 }

}
