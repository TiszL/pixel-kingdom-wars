package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
/** Owner rule 2026-10-06: no saved request may block play forever on this device. An unresolved trial command blocks every
 * new action of its event, including the PRIZE CLAIM (DivineTrialStore.begin). An entry/attempt request the server has no
 * record of closes only against the complete participant record read in the closing action. No POST. */
class DivineTrialServerUnknownCloseTest {
 private val f=DivineTrialFixtures
 private val event=f.event.dt("id")
 private fun entitlement(claim:JsonObject?=null)=buildJsonObject{put("amounts",f.vector.dobj("settlement").dobj("budget"));put("claim",claim?:JsonNull)}
 private fun claim(base:String)=buildJsonObject{put("eventId",f.event.getValue("id"));put("wallet",f.wallet);put("baseId",base);put("amounts",f.vector.dobj("settlement").dobj("budget"));put("claimedAt","2035-01-08T00:00:01.000Z")}
 private inner class Fixture {
  val identity=f.identity();val disk=DivineTrialFixtures.Memory();val store=DivineTrialStore(disk,identity)
  // Entered, first attempt already completed on the server.
  var participant=f.participant(f.entry,listOf(f.complete))
  // lostBeforeServer: the POST never reached the server. loseReply: accepted, reply lost. refuse: the server refuses a retry.
  var lostBeforeServer=false;var loseReply=false;var refuse=false;val posts=mutableListOf<String>()
  fun repo()=DivineTrialRepository(store,object:DivineTrialPorts{
   override fun rules()=f.rules;override fun key()=UUID.randomUUID().toString();override fun owned(base:String){require(base==f.base)}
   override fun capture(fresh:Boolean):()->Unit={};override suspend fun hydrate(guard:()->Unit){guard()}
   override val transport=DivineTransport(object:DivinePort{override val identity=this@Fixture.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
     guard();val raw=if(method=="GET"){check(path.endsWith("/participant"));participant}else{posts+=path
      if(lostBeforeServer)throw IOException("Lost before the server")
      if(refuse)throw ApiException(409,"WINDOW","The play window has closed")
      val e=store.read().events.single();val c=e.commands.single{it.request==body&&store.path(e.id,it)==path}
      when(c.kind){
       "attempts"->{val previous=participant.drows("attempts");JsonObject(f.admitted+mapOf("id" to JsonPrimitive(UUID.randomUUID().toString()),"ordinal" to JsonPrimitive(previous.size+1),"baseId" to body!!.getValue("baseId"),"idempotencyKey" to body.getValue("idempotencyKey"))).also{participant=f.participant(participant.doptional("entry"),previous+it,participant.doptional("prize"))}}
       "prize"->claim(body!!.dt("baseId")).also{participant=f.participant(participant.doptional("entry"),participant.drows("attempts"),entitlement(it))}
       else->error("Unexpected trial mutation")
      }.also{if(loseReply)throw IOException("Accepted reply lost")}
     }
     retain(raw);guard();return raw
    }
   })
  })
 }

 @Test fun `a lost attempt request the server does not know cannot block the prize claim forever`()=runBlocking {
  val x=Fixture();val r=x.repo();r.select(f.event);x.lostBeforeServer=true;assertTrue(runCatching{r.admit(f.base)}.isFailure)
  val c=x.store.event(event).commands.single();assertEquals("attempts",c.kind);assertTrue(c.sent);assertTrue(c.unresolved)
  // The event settles without that attempt: its retry is refused by the server and the saved request blocks the prize.
  x.lostBeforeServer=false;x.refuse=true;x.participant=f.participant(f.entry,listOf(f.complete),entitlement())
  assertTrue(runCatching{r.retry(c.id)}.isFailure);assertTrue(runCatching{r.claim(f.base)}.isFailure);assertTrue(x.store.event(event).commands.single().unresolved)
  assertTrue("A participant record this action did not read is not evidence",runCatching{x.store.closeAbsent(event,c.id,f.participant(f.entry,listOf(f.complete)))}.isFailure)
  val posts=x.posts.size;r.closeAbsent(c.id);assertEquals("CLOSE sends nothing",posts,x.posts.size)
  val closed=x.store.event(event).commands.single{it.id==c.id};assertTrue(closed.closedAbsent);assertFalse(closed.unresolved);assertFalse(closed.retryable);assertNull(closed.response)
  x.refuse=false;r.claim(f.base)
  assertEquals(f.base,x.store.event(event).participant!!.dobj("prize").dobj("claim").dt("baseId"));assertEquals(1,x.posts.count{it.endsWith("/prize")})
  assertEquals(closed,DivineTrialStore(DivineTrialFixtures.Memory(x.disk.value),x.identity).event(event).commands.single{it.id==c.id})
 }
 @Test fun `close is refused when the participant record shows the saved attempt and that attempt is kept instead`()=runBlocking {
  val x=Fixture();val r=x.repo();r.select(f.event);x.loseReply=true;assertTrue(runCatching{r.admit(f.base)}.isFailure);x.loseReply=false
  val c=x.store.event(event).commands.single();assertTrue(c.unresolved)
  val posts=x.posts.size;r.closeAbsent(c.id);assertEquals(posts,x.posts.size)
  val saved=x.store.event(event).commands.single();assertFalse(saved.closedAbsent);assertEquals(c.request["idempotencyKey"],saved.response!!["idempotencyKey"])
  assertTrue(runCatching{x.store.closeAbsent(event,c.id,x.participant)}.isFailure)
 }
 @Test fun `a prize claimed elsewhere into another kingdom pauses its event without making the saved journal unreadable`()=runBlocking {
  val x=Fixture();x.participant=f.participant(f.entry,listOf(f.complete),entitlement());val r=x.repo();r.select(f.event)
  x.lostBeforeServer=true;assertTrue(runCatching{r.claim(f.base)}.isFailure);x.lostBeforeServer=false
  x.participant=f.participant(f.entry,listOf(f.complete),entitlement(claim(UUID.randomUUID().toString())))
  assertTrue(runCatching{r.check()}.isFailure)
  val saved=x.store.read().events.single();assertEquals(1,saved.held.size);assertTrue(saved.commands.single{it.kind=="prize"}.unresolved)
  assertEquals(saved,DivineTrialStore(DivineTrialFixtures.Memory(x.disk.value),x.identity).read().events.single())
  assertTrue(runCatching{x.store.begin(event,DivineCommand(UUID.randomUUID().toString(),"prize",buildJsonObject{put("baseId",f.base)}))}.isFailure)
  assertTrue(runCatching{r.check()}.isFailure);assertEquals(saved,x.store.read().events.single())
 }
 @Test fun `a trial journal saved before the close rule still decodes`()=runBlocking {
  val x=Fixture();val r=x.repo();r.select(f.event);x.lostBeforeServer=true;assertTrue(runCatching{r.admit(f.base)}.isFailure)
  val saved=Json.parseToJsonElement(x.disk.value!!).jsonObject
  val old=JsonObject(saved+("events" to JsonArray(saved.getValue("events").jsonArray.map{e->val o=e.jsonObject;JsonObject(o+("commands" to JsonArray(o.getValue("commands").jsonArray.map{JsonObject(it.jsonObject-"closedAbsent")})))})))
  assertTrue(old.getValue("events").jsonArray.single().jsonObject.getValue("commands").jsonArray.none{"closedAbsent" in it.jsonObject})
  assertEquals(x.store.read(),DivineTrialStore(DivineTrialFixtures.Memory(old.toString()),x.identity).read())
 }
}
