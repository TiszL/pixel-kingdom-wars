package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.IOException
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
class EquipmentRepositoryTest {
 private val f=EquipmentFixtures
 private class Harness {
  val f=EquipmentFixtures;val disk=EquipmentFixtures.Memory();val identity=f.identity();val store=EquipmentStore(disk,identity)
  var allowed=true;var owned=true;var generation=0;var lost=false;var stale=false;var forged=false;var hydrations=0;var failHydration=false
  var afterHydrate:()->Unit={};var failGet:String?=null
  var refuseNext:Pair<Int,String>?=null;var policy:EquipmentPolicy?=f.policy;var view=f.readyView();var starter=f.raw.charterObject("starterView");val server=mutableMapOf<String,JsonObject>();val posts=mutableListOf<JsonObject>();val paths=mutableListOf<String>();val queries=mutableListOf<Map<String,String>>()
  val ports=object:EquipmentPorts {
   override val transport=EquipmentTransport(object:EquipmentPort {override val identity=this@Harness.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit,refusal:suspend(gg.pixelkingdomwars.nativeclient.network.ApiException)->Unit):JsonObject{guard();paths+=path;queries+=query;if(method=="GET"&&path==failGet)throw IOException("Current equipment read unavailable")
     val raw=if(method=="POST"){val request=requireNotNull(body);val r=store.read().records.single{it.request==request};assertTrue("Intent and sent marker precede HTTP",r.attempted);posts+=request
      refuseNext?.let{(status,code)->val error=gg.pixelkingdomwars.nativeclient.network.ApiException(status,code,"exact rollback");refusal(error);throw error}
      val accepted=if(r.kind=="collect")buildJsonObject{put("baseId",f.base);put("serverNow","2035-01-01T00:00:00.000Z");put("returned",0)}else f.proof(r);server[r.key]=accepted;if(stale)generation++;if(lost)throw IOException("lost original reply");if(forged)f.change(accepted,"wallet",JsonPrimitive("11111111111111111111111111111113"))else accepted
     }else when(path){"/ordinary-equipment"->view;"/starter-expeditions"->starter;"/vehicles/fleet"->f.fleet();"/vehicles/client/routes"->f.raw.charterObject("advancedView");else->{val key=path.substringAfterLast('/');server[key]?:f.unknown(store.record(key))}}
     retain(raw);guard();return raw
    }})
   override fun capture(fresh:Boolean):()->Unit{val g=generation;val p=policy;val guard={check(g==generation);if(fresh)check(allowed&&p!=null&&policy==p)};guard();return guard}
   override fun policy()=policy;override fun vehiclePolicy()=f.vehicle;override fun selectedBase()=f.base;override fun requireOwnedBase(base:String){check(owned&&base==f.base)};override fun key()=UUID.randomUUID().toString()
   override suspend fun hydrate(guard:()->Unit){guard();afterHydrate();check(!failHydration);hydrations++;guard()}
  }
  fun repo()=EquipmentRepository(store,ports)
 }
 private suspend fun accepted(h:Harness,archive:Boolean=false):EquipmentRecord {
  val draft=h.store.begin(f.record(key=UUID.randomUUID().toString()));h.store.attempt(draft.key)
  val proof=if(archive)f.complete(draft)else f.proof(draft);h.store.retain(draft.key,proof);h.server[draft.key]=proof
  val saved=h.store.record(draft.key);if(archive)h.store.archive(saved.key,saved);return saved
 }
 private fun noCurrent(repo:EquipmentRepository){val state=repo.state.value;assertNull(state.view);assertNull(state.starter);assertNull(state.paid);assertNull(state.paidRealm);assertNull(state.fleet);assertNull(state.routes);assertNull(state.review)}
 private fun rejects(block:suspend()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 @Test fun `review is durable but performs no mutation until explicit confirmation`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();assertTrue(h.posts.isEmpty());val original=h.store.read().pending.single();assertFalse(original.attempted);assertEquals(f.recipe,original.recipe);repo.confirm();assertEquals(1,h.posts.size);assertEquals(original.request,h.posts.single());assertTrue(h.hydrations>0);Unit}
 @Test fun `lost craft response cold recovery remains GET only after transfer and pause`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.lost=true;rejects{repo.confirm()};val original=h.store.read().pending.single();assertTrue(original.attempted);assertEquals("unknown",original.response!!.charterText("status"));h.allowed=false;h.owned=false;h.policy=null;h.lost=false;val cold=h.repo();cold.check();assertEquals(h.server[original.key],h.store.record(original.key).response);assertEquals(1,h.posts.size);assertEquals(original.request,h.store.record(original.key).request);Unit}
 @Test fun `retry observes accepted original before paused admission and never posts twice`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.lost=true;rejects{repo.confirm()};val key=h.store.read().pending.single().key;h.allowed=false;h.owned=false;h.policy=null;h.lost=false;h.repo().retry(key);assertEquals(1,h.posts.size);Unit}
 @Test fun `serialized journal restores crafted completion and original recipe after policy disappears`()=runBlocking{val h=Harness();val r=h.store.begin(f.record());h.store.attempt(r.key);h.store.retain(r.key,f.complete(r));val copied=EquipmentFixtures.Memory().apply{value=h.disk.value};val cold=EquipmentStore(copied,h.identity);assertEquals(h.store.read(),cold.read());h.policy=null;h.server[r.key]=r.let(f::complete);val before=h.store.record(r.key);h.repo().archive(r.key);assertEquals(before.request,h.store.read().archives.single().request);Unit}
 @Test fun `fitted starter dispatch freezes server route and fitting then recovers one return`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();val route=h.starter.getValue("routes").jsonArray.first().jsonObject;repo.reviewTrip("starter",f.installation,route);repo.confirm();val r=h.store.read().pending.single();assertEquals(route,r.preview);assertEquals(f.policy.selection,r.request["fitting"]);h.server[r.key]=f.complete(r);h.allowed=false;h.owned=false;repo.check();assertNotNull(h.store.record(r.key).response!!.charterOptional("return"));assertEquals(1,h.posts.size);Unit}
 @Test fun `advanced dispatch verifies original canonical economics with durable fitting`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();val route=f.raw.charterObject("advancedEnvelope").charterObject("receipt").charterObject("route");repo.reviewTrip("advanced",f.installation,route);repo.confirm();assertEquals(route,h.store.read().pending.single().preview);assertTrue(h.queries.any{it["fitting"]=="route_compass"&&it["policyVersion"]=="1"});Unit}
 @Test fun `unknown original blocks replacement keys while observed receipt may recover`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.lost=true;rejects{repo.confirm()};rejects{repo.reviewCraft()};assertEquals(1,h.posts.size);assertEquals(1,h.store.read().pending.size);Unit}
 @Test fun `late accepted original is retained before changed view publication fails`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.stale=true;rejects{repo.confirm()};val r=h.store.read().pending.single();assertEquals(h.server[r.key],r.response);assertEquals(1,h.posts.size);repo.dismiss();assertFalse(repo.state.value.busy);assertNull(repo.state.value.view);Unit}
 @Test fun `forged reply is held with original sent marker and cannot be retried or archived`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.forged=true;rejects{repo.confirm()};val r=h.store.read().pending.single();assertTrue(r.attempted&&r.held);assertTrue(r.observations.isNotEmpty());rejects{repo.archive(r.key)};assertTrue(h.store.record(r.key).held);assertEquals(1,h.posts.size);Unit}
 @Test fun `disk failure retains response custody and restores original after repair`()=runBlocking{val h=Harness();val r=h.store.begin(f.record());h.store.attempt(r.key);h.disk.fail=true;rejects{h.store.retain(r.key,f.proof(r))};h.disk.fail=false;assertTrue(h.store.read().pending.single().held);h.store.retain(r.key,f.proof(r));assertEquals(f.proof(r),h.store.record(r.key).response);assertFalse(h.store.record(r.key).held);Unit}
 @Test fun `wallet namespace and corrupt bytes never silently reset inventory commands`()=runBlocking{val h=Harness();h.store.begin(f.record());val before=h.disk.value;val other=EquipmentStore(h.disk,h.identity.copy(wallet="11111111111111111111111111111113"));rejects{other.read()};assertEquals(before,h.disk.value);h.disk.value="not JSON";rejects{h.store.read()};assertEquals("not JSON",h.disk.value);Unit}
 @Test fun `selected base generation or missing tool stops a fresh departure before persistence`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();val route=h.starter.getValue("routes").jsonArray.first().jsonObject;h.view=f.readyView("0");rejects{repo.reviewTrip("starter",f.installation,route)};assertTrue(h.store.read().pending.isEmpty());assertTrue(h.posts.isEmpty());Unit}
 @Test fun `old actor cannot convert original receipt into current stock or a new craft`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();h.owned=false;repo.dismiss();repo.open();assertNull(repo.state.value.view);rejects{repo.reviewCraft()};assertTrue(h.posts.isEmpty());Unit}
 @Test fun `hydration failure preserves accepted result without publishing terminal state`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.failHydration=true;rejects{repo.confirm()};val original=h.store.read().pending.single();assertEquals("accepted",original.response!!.charterText("status"));assertNotEquals(original,repo.state.value.journal!!.pending.single());h.failHydration=false;h.repo().check();assertEquals(1,h.posts.size);Unit}
 @Test fun `unattempted draft can archive only after current GET proves original unknown`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();val key=h.store.read().pending.single().key;repo.discard(key);assertTrue(h.store.read().pending.isEmpty());assertTrue(h.store.read().archives.single().discardedUnsent);assertTrue(h.posts.isEmpty());rejects{repo.retry(key)};Unit}
 // Rewritten 2026-10-06 (dead-end audit): the owner now lets a sent original close once THIS action's by-key GET answers
 // "unknown", so it cannot block the kingdom forever. Still pinned: an older saved "unknown" without a fresh answer never
 // releases the key, and closing never POSTs.
 @Test fun `attempted unknown releases its key only after a fresh GET in the same action answers unknown`()=runBlocking{val h=Harness();val r=h.store.begin(f.record());h.store.attempt(r.key);h.store.retain(r.key,f.unknown(r))
  h.failGet=h.store.receiptPath(r);rejects{h.repo().discard(r.key)};assertEquals(r.key,h.store.read().pending.single().key)
  h.failGet=null;h.repo().discard(r.key);val closed=h.store.read().archives.single();assertTrue(closed.closedUnknown);assertFalse(closed.closedRefusal);assertTrue(h.store.read().pending.isEmpty());assertTrue(h.posts.isEmpty());Unit}
 @Test fun `completed advanced collection remains explicit and available during pause`()=runBlocking{val h=Harness();h.allowed=false;val repo=h.repo();repo.collect();assertEquals(1,h.posts.size);assertEquals("collect",h.store.read().pending.single().kind);assertTrue(h.store.read().pending.single().attempted);Unit}
 @Test fun `first definitive rollback refusal archives only after fresh GET unknown`()=runBlocking{for((status,code)in listOf(422 to "INSUFFICIENT_CRAFTING_STOCK",409 to "EQUIPMENT_CRAFT_UNAVAILABLE",409 to "COMPASS_UNAVAILABLE")){val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.refuseNext=status to code;rejects{repo.confirm()};val r=h.store.read().pending.single();assertEquals(code,r.refusal!!.code);repo.discard(r.key);val closed=h.store.read().archives.single();assertTrue(closed.closedRefusal);assertEquals("unknown",closed.response!!.charterText("status"));assertEquals(r.request,closed.request);assertEquals(1,h.posts.size)};Unit}
 @Test fun `wrong code status or ambiguous server failure never grants refusal close`()=runBlocking{for((status,code)in listOf(500 to "INSUFFICIENT_CRAFTING_STOCK",409 to "UNKNOWN",503 to "COMPASS_UNAVAILABLE")){val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.refuseNext=status to code;rejects{repo.confirm()};val r=h.store.read().pending.single();assertNull(r.refusal)
  // Rewritten 2026-10-06 (dead-end audit): the request may now close through a fresh by-key "unknown", but never as a refusal.
  // Rewritten again 2026-10-06 (owner review): after a 502/503/504 the server may still be processing the POST, so it is KEPT
  // (the close is refused) until the minimum age has passed; a plain 500 or an unknown 409 may close as unknown.
  if(status in setOf(502,503,504)){rejects{repo.discard(r.key)};assertEquals(1,h.store.read().pending.size);assertTrue(h.store.read().archives.isEmpty())}
  else{repo.discard(r.key);val closed=h.store.read().archives.single();assertFalse(closed.closedRefusal);assertNull(closed.refusal);assertTrue(closed.closedUnknown)}
  assertEquals(1,h.posts.size)};Unit}
 @Test fun `definitive refusal on a later retry cannot resolve the first uncertain POST`()=runBlocking{val h=Harness();val repo=h.repo();repo.open();repo.reviewCraft();h.lost=true;rejects{repo.confirm()};val r=h.store.read().pending.single();h.server.clear();h.lost=false;h.refuseNext=409 to "EQUIPMENT_CRAFT_UNAVAILABLE";rejects{repo.retry(r.key)};assertNull(h.store.record(r.key).refusal)
  // Rewritten 2026-10-06 (dead-end audit): the later refusal still resolves nothing; only the fresh by-key "unknown" closes it.
  repo.discard(r.key);val closed=h.store.read().archives.single();assertFalse(closed.closedRefusal);assertNull(closed.refusal);assertTrue(closed.closedUnknown);assertEquals(2,h.posts.size);Unit}
 @Test fun `late positive original wins over retained refusal and remains recoverable after close`()=runBlocking{val h=Harness();val r=h.store.begin(f.record());val marked=h.store.attempt(r.key);h.store.refuse(r.key,EquipmentRefusal(409,"EQUIPMENT_CRAFT_UNAVAILABLE",marked.attemptRevision!!));h.store.retain(r.key,f.unknown(r));h.store.discard(r.key,h.store.record(r.key));h.store.retain(r.key,f.proof(r));val saved=h.store.read().archives.single();assertEquals("accepted",saved.response!!.charterText("status"));assertTrue(saved.closedRefusal);assertEquals(r.request,saved.request);Unit}
 @Test fun `stale first refusal cannot supersede a newer attempt or accepted receipt`()=runBlocking{val h=Harness();val r=h.store.begin(f.record());val first=h.store.attempt(r.key);val second=h.store.attempt(r.key);assertNotEquals(first.attemptRevision,second.attemptRevision);h.store.refuse(r.key,EquipmentRefusal(409,"COMPASS_UNAVAILABLE",first.attemptRevision!!));assertNull(h.store.record(r.key).refusal);h.store.retain(r.key,f.proof(r));h.store.refuse(r.key,EquipmentRefusal(409,"COMPASS_UNAVAILABLE",second.attemptRevision!!));assertNull(h.store.record(r.key).refusal);Unit}

 @Test fun `cold accepted craft remains visible and GET recoverable during continuing hydration failure`()=runBlocking {
  val h=Harness();val original=accepted(h);h.failHydration=true;val cold=h.repo();cold.open()
  assertEquals(original,cold.state.value.journal!!.pending.single());noCurrent(cold);assertTrue(cold.state.value.error!!.contains("Saved requests"))
  h.paths.clear();cold.select(original.key);assertEquals(original,cold.state.value.selected);assertTrue(cold.state.value.error!!.contains("original receipt checks remain available"));cold.check();assertTrue(cold.state.value.error!!.contains("original receipt checks remain available"));assertEquals(listOf(h.store.receiptPath(original),h.store.receiptPath(original)),h.paths)
  h.server[original.key]=f.complete(original);cold.check();assertNotNull(cold.state.value.selected!!.response!!.charterOptional("completion"));assertEquals(original.request,h.store.record(original.key).request);assertEquals(original.recipe,h.store.record(original.key).recipe);noCurrent(cold);assertTrue(h.posts.isEmpty());Unit
 }
 @Test fun `failed hydration blocks craft departure and paused collection until current state refreshes`()=runBlocking {
  val h=Harness();val repo=h.repo();repo.open();val route=repo.state.value.starter!!.getValue("routes").jsonArray.first().jsonObject;assertNotNull(repo.state.value.view);assertNotNull(repo.state.value.fleet);assertNotNull(repo.state.value.routes)
  val original=accepted(h,archive=true);h.failHydration=true;h.paths.clear()
  rejects{repo.reviewCraft()};rejects{repo.reviewTrip("starter",f.installation,route)};h.allowed=false;rejects{repo.collect()}
  assertTrue(h.paths.isEmpty());assertTrue(h.posts.isEmpty());assertEquals(original,h.store.read().archives.single());assertTrue(h.store.read().pending.isEmpty());noCurrent(repo)
  h.failHydration=false;repo.open();assertNull(repo.state.value.error);assertNotNull(repo.state.value.view);assertNotNull(repo.state.value.starter);assertNotNull(repo.state.value.routes);repo.collect();assertEquals(1,h.posts.size);assertEquals("collect",h.store.read().pending.single().kind);Unit
 }
 @Test fun `retry observes saved original but both craft and collection resubmission require hydration`()=runBlocking {
  for(kind in listOf("craft","collect")){
   val h=Harness();accepted(h,archive=true);val key=UUID.randomUUID().toString()
   val draft=if(kind=="craft")f.record(key=key)else EquipmentRecord("collect",key,buildJsonObject{put("baseId",f.base)},f.policy.raw)
   h.store.begin(draft);h.store.attempt(key);val before=h.store.record(key);h.failHydration=true;h.allowed=kind!="collect";val cold=h.repo()
   rejects{cold.retry(key)};assertTrue(h.posts.isEmpty());assertEquals(before.request,h.store.record(key).request);assertEquals(before.attemptRevision,h.store.record(key).attemptRevision);assertEquals(if(kind=="craft")listOf(h.store.receiptPath(before))else emptyList<String>(),h.paths);noCurrent(cold)
   h.failHydration=false;cold.retry(key);assertEquals(listOf(before.request),h.posts);assertEquals(before.request,h.store.record(key).request)
  };Unit
 }
 @Test fun `failed current route read leaves saved originals visible without partial live stock`()=runBlocking {
  val h=Harness();val original=accepted(h);h.failGet="/starter-expeditions";val cold=h.repo();rejects{cold.open()};assertEquals(original,cold.state.value.journal!!.pending.single());noCurrent(cold);assertEquals("Current equipment read unavailable",cold.state.value.error)
  h.failHydration=true;cold.select(original.key);assertEquals(original,cold.state.value.selected);assertTrue(cold.state.value.error!!.contains("Saved requests"));assertTrue(h.posts.isEmpty());Unit
 }
 @Test fun `cancellation or changed account during hydration cannot publish newly retained completion`()=runBlocking {
  for(cancel in listOf(false,true)){
   val h=Harness();val original=accepted(h);h.server[original.key]=f.complete(original);h.afterHydrate={if(cancel)throw kotlinx.coroutines.CancellationException("Equipment screen stopped")else h.generation++}
   val cold=h.repo();rejects{cold.check()};assertEquals(original,cold.state.value.journal!!.pending.single());assertNotNull(h.store.record(original.key).response!!.charterOptional("completion"));assertEquals(original.request,h.store.record(original.key).request);assertTrue(h.posts.isEmpty())
  };Unit
 }
 @Test fun `archive refresh failure clears current displays without retiring original evidence`()=runBlocking {
  val h=Harness();val original=accepted(h,archive=false);h.server[original.key]=f.complete(original);val repo=h.repo();repo.open();assertNotNull(repo.state.value.view);assertNotNull(repo.state.value.routes)
  h.failHydration=true;rejects{repo.archive(original.key)};noCurrent(repo);assertTrue(h.store.read().archives.isEmpty());assertNotNull(h.store.read().pending.single().response!!.charterOptional("completion"));assertTrue(h.posts.isEmpty());val calls=h.paths.toList();rejects{repo.collect()};assertEquals(calls,h.paths);assertTrue(h.posts.isEmpty());h.failHydration=false;repo.collect();assertEquals(1,h.posts.size);Unit
 }

}
