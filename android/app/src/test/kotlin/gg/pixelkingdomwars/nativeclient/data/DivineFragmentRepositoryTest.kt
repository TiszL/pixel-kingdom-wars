package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class DivineFragmentRepositoryTest {
 private val f=DivineFragmentFixtures
 private inner class Fixture {
  var award=f.award;val identity=f.identity();var disk=DivineFragmentFixtures.Memory();var store=DivineFragmentStore(disk,identity);var base:String?=f.base;var owned=true;var active=true;var destinations=true;var generation=0;var lose=false;var late=false;var interveningTerms=0;var foreignExact=false;var policyUnavailable=false;var noReceipt=false;var failReceiptWrite=false;var next=100
  val calls=mutableListOf<String>();val receipts=mutableMapOf<String,JsonObject>();val row=f.raw.fo("entitlement")
  fun repo():DivineFragmentRepository {val ports=object:DivineFragmentPorts{
   override fun rules(policy:JsonObject)=DivineFragmentRules.installed(policy,f.raw.fo("catalogue"))
   override fun selectedBase()=base
   override fun owned(base:String){check(owned&&base==this@Fixture.base)}
   override fun key()=f.id(next++)
   override suspend fun refresh(guard:()->Unit){guard()}
   override fun capture(destination:Boolean):()->Unit{val g=generation;val guard={check(active);if(destination)check(destinations&&g==generation)};guard();return guard}
   override val transport=DivineFragmentTransport(object:DivineFragmentPort{
    override val identity=this@Fixture.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
     guard();calls+="$method $path ${query["cursor"].orEmpty()}";val raw=if(method=="POST"){
      val c=store.read().commands.single{it.path==path&&it.consent.fo("request")==body};assertTrue("Saved attempt exists before POST",c.sent);val r=if(c.kind=="delivery"&&"clan" in c.consent.fo("award"))DivineClanFragmentFixtures.receipt(c)else f.receipt(c);receipts[c.key]=r;r
     }else when{
      path.endsWith("/policy")->if(policyUnavailable)throw java.io.IOException("Provider unavailable")else f.raw.fo("policy")
      path.endsWith("/awards")->f.page(listOf(buildJsonObject{put("award",award);put("delivery",JsonNull)}))
      path.contains("/seeker/terms/")->f.page(listOf(if(foreignExact)JsonObject(row+("termId" to JsonPrimitive(f.id(999))))else row))
      path.endsWith("/seeker/terms")->if(interveningTerms>0&&query["cursor"]==null)f.page(listOf(JsonObject(row+("termId" to JsonPrimitive(f.id(10))))),f.id(10))else f.page(listOf(row))
      path.contains("/events/")->buildJsonObject{put("version",1);put("wallet",f.wallet);put("eventId",award.getValue("eventId"));put("enrolled",true);put("settled",true);put("award",award);put("delivery",receipts.values.firstOrNull{it["eventId"]==award["eventId"]}?:JsonNull)}
      path.contains("/stock/")->buildJsonObject{put("version",1);put("resourceId","crystal_fragment");put("wallet",f.wallet);put("baseId",path.substringAfterLast('/'));put("available","12")}
      else->{val key=path.substringAfterLast('/');buildJsonObject{put("version",1);put("wallet",f.wallet);put("idempotencyKey",key);put("receipt",if(noReceipt)JsonNull else receipts[key]?:JsonNull)}}
     }
     if(method=="POST"&&lose){lose=false;throw java.io.IOException("Accepted reply lost")};if(method=="POST"&&failReceiptWrite)disk.fail=true
     retain(raw);if(method=="POST"&&late)active=false;guard();return raw
    }
   })
  };return DivineFragmentRepository(store,ports)}
  suspend fun cold():DivineFragmentRepository{disk=DivineFragmentFixtures.Memory(disk.value);store=DivineFragmentStore(disk,identity);return repo().also{it.local()}}
  fun posts()=calls.count{it.startsWith("POST")}
 }
 @Test fun `lost delivery reply survives cold paused changed-base recovery without another mutation`()=runBlocking{val x=Fixture();var r=x.repo();r.reviewDelivery(f.award.ft("eventId"));val review=r.state.value.review!!;x.lose=true;assertTrue(runCatching{r.confirm(review)}.isFailure);val original=x.store.read().commands.single();assertTrue(original.sent);assertNull(original.receipt);x.destinations=false;x.base=f.id(9);x.owned=false;r=x.cold();r.check(original.key);assertEquals(f.base,x.store.read().commands.single().receipt!!.ft("baseId"));assertNull(r.state.value.stock);assertEquals(1,x.posts())}
 @Test fun `refresh and missing receipts never auto-submit or clear ambiguous originals`()=runBlocking{val x=Fixture();val r=x.repo();r.reviewDelivery(f.award.ft("eventId"));val c=x.store.read().commands.single();x.store.mark(c.key);r.check(c.key);r.discover();r.local();assertEquals(0,x.posts());assertTrue(x.store.read().commands.single().unresolved);assertTrue(runCatching{r.abandonDraft(c.key)}.isFailure)}
 @Test fun `double confirm has one stock mutation and keeps exact original key`()=runBlocking{val x=Fixture();val r=x.repo();r.reviewDelivery(f.award.ft("eventId"));val q=r.state.value.review!!;r.confirm(q);assertTrue(runCatching{r.confirm(q)}.isFailure);assertEquals(1,x.posts());assertNotNull(x.store.read().commands.single().receipt)}
 @Test fun `destination change invalidates visible consent without retargeting saved command`()=runBlocking{val x=Fixture();val r=x.repo();r.reviewDelivery(f.award.ft("eventId"));val q=r.state.value.review!!;x.base=f.id(9);x.generation++;r.dismiss();assertTrue(runCatching{r.confirm(q)}.isFailure);assertEquals(f.base,x.store.read().commands.single().base);assertEquals(0,x.posts())}
 @Test fun `failed durable attempt write prevents POST and preserved draft remains reviewable`()=runBlocking{val x=Fixture();val r=x.repo();r.reviewDelivery(f.award.ft("eventId"));x.disk.fail=true;assertTrue(runCatching{r.confirm(r.state.value.review!!)}.isFailure);assertEquals(0,x.posts());x.disk.fail=false;assertFalse(x.store.read().commands.single().sent)}
 @Test fun `owned late response stays with old actor before stale session can publish`()=runBlocking{val x=Fixture();val r=x.repo();r.reviewDelivery(f.award.ft("eventId"));x.late=true;assertTrue(runCatching{r.confirm(r.state.value.review!!)}.isFailure);assertNotNull(x.store.read().commands.single().receipt);assertEquals(1,x.posts())}
 @Test fun `more than a traversal bound of inserted terms cannot strand saved original spot`()=runBlocking{val x=Fixture();val r=x.repo();r.discover("claims");r.reviewClaim(x.row);val q=r.state.value.review!!;x.interveningTerms=f.rules.localLimit+1;val before=x.calls.size;r.confirm(q);assertEquals(1,x.posts());assertEquals(x.row["termId"],x.store.read().commands.single().receipt!!["termId"]);assertTrue(x.calls.drop(before).any{it=="GET /divine-fragments/seeker/terms/${x.row.ft("termId")} "});assertFalse(x.calls.drop(before).any{it.startsWith("GET /divine-fragments/seeker/terms ")})}
 @Test fun `accepted original cannot disappear from a later recovery response`()=runBlocking{val x=Fixture();val r=x.repo();r.reviewDelivery(f.award.ft("eventId"));r.confirm(r.state.value.review!!);val c=x.store.read().commands.single();x.noReceipt=true;assertTrue(runCatching{r.check(c.key)}.isFailure);assertEquals(c,x.store.read().commands.single());assertEquals(1,x.posts())}
 @Test fun `exact lookup rejects a foreign term even when it has the same spot and positive amount`()=runBlocking{val x=Fixture();val r=x.repo();r.discover("claims");r.reviewClaim(x.row);val q=r.state.value.review!!;x.foreignExact=true;assertTrue(runCatching{r.confirm(q)}.isFailure);assertEquals(0,x.posts());assertTrue(x.store.read().commands.single().unresolved)}
 @Test fun `entry discovery requires provider policy but failed discovery retains saved history`()=runBlocking{val x=Fixture();val r=x.repo();x.policyUnavailable=true;r.discoverEntry();assertFalse(r.state.value.available);assertEquals(0,x.posts());x.policyUnavailable=false;r.discoverEntry();assertTrue(r.state.value.available);r.reviewDelivery(f.award.ft("eventId"));x.policyUnavailable=true;r.discoverEntry();assertFalse(r.state.value.available);assertEquals(1,r.state.value.journal!!.commands.size);assertEquals(0,x.posts())}
 @Test fun `lost permanent claim reply recovers at original destination after cold pause and transfer`()=runBlocking{val x=Fixture();var r=x.repo();r.discover("claims");r.reviewClaim(x.row);x.lose=true;assertTrue(runCatching{r.confirm(r.state.value.review!!)}.isFailure);val c=x.store.read().commands.single();assertTrue(c.sent);assertNull(c.receipt);x.destinations=false;x.owned=false;x.base=f.id(9);r=x.cold();r.check(c.key);assertEquals(f.base,x.store.read().commands.single().receipt!!.ft("baseId"));assertEquals(x.row["termId"],x.store.read().commands.single().receipt!!["termId"]);assertEquals(1,x.posts())}
 @Test fun `clan lost reply recovers original frozen roster delivery after cold pause and base change`()=runBlocking {
  val x=Fixture();x.award=DivineClanFragmentFixtures.award;var r=x.repo();r.reviewDelivery(x.award.ft("eventId"));val c=x.store.read().commands.single()
  x.lose=true;assertTrue(runCatching{r.confirm(r.state.value.review!!)}.isFailure);assertEquals(1,x.posts())
  x.destinations=false;x.policyUnavailable=true;x.base=f.id(9);x.owned=false;r=x.cold();r.check(c.key)
  val saved=x.store.read().commands.single();assertEquals(c.consent.toString(),saved.consent.toString())
  assertEquals(c.base,saved.receipt!!.ft("baseId"));assertEquals(x.award["net"],saved.receipt!!["quantity"]);assertNull(r.state.value.stock);assertEquals(1,x.posts())
 }
 @Test fun `changed clan roster provenance after consent holds without replacing the saved award or sending`()=runBlocking {
  val x=Fixture();x.award=DivineClanFragmentFixtures.award;val r=x.repo();r.reviewDelivery(x.award.ft("eventId"));val review=r.state.value.review!!;val c=x.store.read().commands.single()
  x.award=JsonObject(x.award+("clan" to JsonObject(x.award.fo("clan")+("rosterHash" to JsonPrimitive("e".repeat(64))))))
  assertTrue(runCatching{r.confirm(review)}.isFailure);assertEquals(0,x.posts());assertEquals(c,x.store.read().commands.single())
 }
 @Test fun `individual history remains exact beside newly accepted clan delivery and both recover without new POST`()=runBlocking {
  val x=Fixture();var r=x.repo();r.reviewDelivery(x.award.ft("eventId"));r.confirm(r.state.value.review!!);val individual=x.store.read().commands.single()
  x.award=DivineClanFragmentFixtures.award;r.reviewDelivery(x.award.ft("eventId"));r.confirm(r.state.value.review!!);val saved=x.store.read().commands
  assertEquals(individual,saved.first());assertEquals(2,x.posts());x.destinations=false;x.base=f.id(9);x.owned=false;r=x.cold()
  saved.forEach{r.check(it.key)};assertEquals(saved,x.store.read().commands);assertEquals(2,x.posts())
 }

}
