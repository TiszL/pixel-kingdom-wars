package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
/** Owner rule 2026-10-06: no saved request may block play forever on this device. One sent fragment request blocks every
 * delivery and Seeker claim of the account (DivineFragmentStore.begin), so a request the server has no record of must have
 * an exit: CLOSE, decided only by that request's own by-key receipt read in the same action, never by a POST. */
class DivineFragmentServerUnknownCloseTest {
 private val f=DivineFragmentFixtures
 private inner class Fixture {
  val identity=f.identity();val disk=DivineFragmentFixtures.Memory();val store=DivineFragmentStore(disk,identity);var base=f.base;var next=100
  // lostBeforeServer: the POST never reached the server. loseReply: the server accepted it and only the reply was lost.
  var lostBeforeServer=false;var loseReply=false;val calls=mutableListOf<String>();val receipts=mutableMapOf<String,JsonObject>()
  fun repo()=DivineFragmentRepository(store,object:DivineFragmentPorts{
   override fun rules(policy:JsonObject)=DivineFragmentRules.installed(policy,f.raw.fo("catalogue"))
   override fun selectedBase()=base
   override fun owned(base:String){check(base==this@Fixture.base){"Not your kingdom"}}
   override fun key()=f.id(next++)
   override suspend fun refresh(guard:()->Unit){guard()}
   override fun capture(destination:Boolean):()->Unit={}
   override val transport=DivineFragmentTransport(object:DivineFragmentPort{
    override val identity=this@Fixture.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
     guard();calls+="$method $path";val raw=if(method=="POST"){
      if(lostBeforeServer)throw IOException("Lost before the server")
      val c=store.read().commands.single{it.path==path&&it.consent.fo("request")==body};f.receipt(c).also{receipts[c.key]=it;if(loseReply)throw IOException("Accepted reply lost")}
     }else when{
      path.endsWith("/policy")->f.raw.fo("policy")
      path.contains("/events/")->buildJsonObject{put("version",1);put("wallet",f.wallet);put("eventId",f.award.getValue("eventId"));put("enrolled",true);put("settled",true);put("award",f.award);put("delivery",receipts.values.firstOrNull{it["eventId"]==f.award["eventId"]}?:JsonNull)}
      path.contains("/stock/")->buildJsonObject{put("version",1);put("resourceId","crystal_fragment");put("wallet",f.wallet);put("baseId",path.substringAfterLast('/'));put("available","12")}
      else->envelope(path.substringAfterLast('/'),receipts[path.substringAfterLast('/')])
     }
     retain(raw);guard();return raw
    }
   })
  })
  fun posts()=calls.count{it.startsWith("POST")}
 }
 private fun envelope(key:String,receipt:JsonObject?)=buildJsonObject{put("version",1);put("wallet",f.wallet);put("idempotencyKey",key);put("receipt",receipt?:JsonNull)}
 private val event=f.award.ft("eventId")

 @Test fun `a sent delivery the server does not know cannot block fragment delivery forever`()=runBlocking {
  val x=Fixture();val r=x.repo();r.reviewDelivery(event);x.lostBeforeServer=true;assertTrue(runCatching{r.confirm(r.state.value.review!!)}.isFailure)
  val c=x.store.read().commands.single();assertTrue(c.sent);assertTrue(c.unresolved);assertEquals(1,x.posts())
  // The kingdom was sold: the original retry is refused, and the saved request blocks a delivery into the new kingdom.
  x.lostBeforeServer=false;x.base=f.id(9);assertTrue(runCatching{r.reviewSaved(c.key)}.isFailure);assertTrue(runCatching{r.reviewDelivery(event)}.isFailure)
  r.closeAbsent(c.key)
  assertEquals("CLOSE sends nothing",1,x.posts())
  val closed=x.store.read().commands.single();assertTrue(closed.closed);assertFalse(closed.unresolved);assertNull(closed.receipt);assertEquals(envelope(c.key,null),closed.absent)
  r.reviewDelivery(event);val review=r.state.value.review!!;assertNotEquals(c.key,review.key);assertEquals(f.id(9),x.store.read().commands.single{it.key==review.key}.base)
  assertEquals(x.store.read(),DivineFragmentStore(DivineFragmentFixtures.Memory(x.disk.value),x.identity).read())
 }
 @Test fun `close is refused when the server shows the saved request and its receipt is kept instead`()=runBlocking {
  val x=Fixture();val r=x.repo();r.reviewDelivery(event);val draft=x.store.read().commands.single()
  assertTrue("A draft never sent uses CLOSE UNSENT DRAFT",runCatching{r.closeAbsent(draft.key)}.isFailure)
  x.loseReply=true;assertTrue(runCatching{r.confirm(r.state.value.review!!)}.isFailure);val c=x.store.read().commands.single();assertTrue(c.unresolved)
  assertTrue(runCatching{x.store.closeAbsent(c.key,envelope(c.key,x.receipts.getValue(c.key)))}.isFailure)
  assertTrue("An answer about another key is not evidence",runCatching{x.store.closeAbsent(c.key,envelope(f.id(77),null))}.isFailure)
  assertTrue(x.store.read().commands.single().unresolved)
  r.closeAbsent(c.key)
  val saved=x.store.read().commands.single();assertFalse(saved.closed);assertNull(saved.absent);assertEquals(x.receipts.getValue(c.key),saved.receipt);assertEquals(1,x.posts())
 }
 @Test fun `a fragment journal saved before the close rule still decodes`()=runBlocking {
  val x=Fixture();val r=x.repo();r.reviewDelivery(event);x.lostBeforeServer=true;assertTrue(runCatching{r.confirm(r.state.value.review!!)}.isFailure)
  val saved=Json.parseToJsonElement(x.disk.value!!).jsonObject
  val old=JsonObject(saved+("commands" to JsonArray(saved.getValue("commands").jsonArray.map{JsonObject(it.jsonObject-"absent")})))
  assertTrue(old.getValue("commands").jsonArray.none{"absent" in it.jsonObject})
  assertEquals(x.store.read(),DivineFragmentStore(DivineFragmentFixtures.Memory(old.toString()),x.identity).read())
 }
}
