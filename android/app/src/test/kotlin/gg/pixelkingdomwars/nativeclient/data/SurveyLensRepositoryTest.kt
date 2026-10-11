package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.ui.phasee.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.serialization.json.*
import java.io.IOException
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
internal object SurveyLensFixtures {
 val f=EquipmentFixtures
 val raw=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/survey-lens.json")).readText()).jsonObject
 val policy=EquipmentPolicy.from(raw.charterObject("policy"));val vehicle=VehiclePolicy.from(JsonObject(f.vehicle.raw+("ordinaryEquipment" to policy.raw)))
 fun view(lens:String="1")=JsonObject(raw.charterObject("view")+mapOf("pendingJobs" to JsonArray(emptyList()),"equipmentStock" to JsonArray(raw.charterObject("view").getValue("equipmentStock").jsonArray.map{JsonObject(it.jsonObject+mapOf("available" to JsonPrimitive(if(it.jsonObject.charterText("itemId")=="survey_lens")lens else "1"),"pendingOutput" to JsonPrimitive("0")))}),"craftingStock" to f.readyView().getValue("craftingStock")))
 fun fit(route:JsonObject,resource:String)=f.change(f.change(route,"fitting.resourceId",JsonPrimitive(resource)),"secondaryOutput.resourceId",JsonPrimitive(resource))
 fun starter(resource:String)=JsonObject(raw.charterObject("starterView")+mapOf("fitting" to policy.selectionFor("survey_lens",resource),"routes" to JsonArray(raw.charterObject("starterView").getValue("routes").jsonArray.map{it.jsonObject}.filter{it.charterText("resourceId")!=resource}.map{fit(it,resource)})))
 fun paid(realm:String,resource:String):JsonObject {
  val realmId=gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds[realm.toInt()]
  val primary=equipmentResourceIds.toList()[realm.toInt()]
  val source=raw.charterObject("starterView");val route=fit(source.getValue("routes").jsonArray.first().jsonObject,resource)
  return buildJsonObject{put("wallet",source.getValue("wallet"));put("baseId",source.getValue("baseId"));put("serverNow",source.getValue("serverNow"));put("realm",realm.toInt());put("authorization","none");put("acceptingDepartures",true);put("coverage",buildJsonObject{put("status","unavailable")});put("route",JsonObject(route+mapOf("routeCatalogueVersion" to JsonPrimitive(3),"routeId" to JsonPrimitive("paid_${realmId.replace('-','_')}"),"realmId" to JsonPrimitive(realmId),"resourceId" to JsonPrimitive(primary),"access" to buildJsonObject{put("kind","paid_realm");put("policyVersion",1)})))}
 }
 fun advanced(resource:String)=JsonObject(raw.charterObject("advancedView")+("items" to JsonArray(raw.charterObject("advancedView").getValue("items").jsonArray.map{item->JsonObject(item.jsonObject+("previews" to JsonArray(item.jsonObject.getValue("previews").jsonArray.map{it.jsonObject}.filter{it.charterText("resourceId")!=resource}.map{fit(it,resource)})))})))
 fun proof(r:EquipmentRecord):JsonObject{if(r.recipe?.output?.itemId=="route_compass"||r.preview?.charterObject("fitting")?.charterText("itemId")=="route_compass")return f.proof(r);val original=raw.charterObject(when(r.kind){"craft"->"envelope";"starter"->"starterEnvelope";else->"advancedEnvelope"});return JsonObject(original+mapOf("idempotencyKey" to JsonPrimitive(r.key),"receipt" to JsonObject(original.charterObject("receipt")+mapOf("request" to r.request,(if(r.kind=="craft")"jobId"else "expeditionId") to JsonPrimitive(r.key))+if(r.preview!=null)mapOf("route" to r.preview)else emptyMap())))}
 fun complete(r:EquipmentRecord):JsonObject{val accepted=proof(r);val deadline=accepted.charterObject("receipt").getValue(if(r.kind=="craft")"readyAt"else "returnsAt");return JsonObject(accepted+mapOf("serverNow" to deadline,(if(r.kind=="craft")"completion"else "return") to buildJsonObject{if(r.kind=="craft")put("completedAt",deadline)else {put("returnId",UUID.randomUUID().toString());put("returnedAt",deadline);if(r.kind=="advanced")put("completedTotal","1");r.preview?.get("secondaryOutput")?.let{put("secondaryOutput",it)}}}))}
}
class SurveyLensRepositoryTest {
 private val f=SurveyLensFixtures
 private class Harness {
  val f=SurveyLensFixtures;val disk=EquipmentFixtures.Memory();val identity=EquipmentFixtures.identity();val store=EquipmentStore(disk,identity)
  var allowed=true;var owned=true;var generation=0;var lost=false;var stale=false;var forged=false;var lens="1";var policy:EquipmentPolicy?=f.policy;var refusal:String?=null
  var paidFailure=false;var afterPaid:suspend()->Unit={};val paidQueries=mutableListOf<String>()
  val server=mutableMapOf<String,JsonObject>();val posts=mutableListOf<JsonObject>();val queries=mutableListOf<Map<String,String>>()
  val ports=object:EquipmentPorts {
   override val transport=EquipmentTransport(object:EquipmentPort{override val identity=this@Harness.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit,refusal:suspend(ApiException)->Unit):JsonObject{guard();queries+=query
     val raw=if(method=="POST"){val r=store.read().pending.single{it.request==body};assertTrue(r.attempted);posts+=requireNotNull(body);this@Harness.refusal?.let{val e=ApiException(409,it,"refused");refusal(e);throw e};val proof=f.proof(r);server[r.key]=proof;if(lost)throw IOException("lost reply");if(stale)generation++;if(forged)EquipmentFixtures.change(proof,"receipt.route.secondaryOutput.netQuantity",JsonPrimitive("999"))else proof
     }else when(path){"/starter-expeditions/paid-route"->{paidQueries+=query.getValue("realm");afterPaid();if(paidFailure)throw IOException("paid destination unavailable");f.paid(query.getValue("realm"),query.getValue("resourceId"))};"/ordinary-equipment"->if(query["catalogueVersion"]=="2")f.view(lens)else EquipmentFixtures.readyView();"/starter-expeditions"->if(query["fitting"]=="survey_lens")f.starter(query.getValue("resourceId"))else EquipmentFixtures.raw.charterObject("starterView");"/vehicles/fleet"->EquipmentFixtures.fleet();"/vehicles/client/routes"->if(query["fitting"]=="survey_lens")f.advanced(query.getValue("resourceId"))else EquipmentFixtures.raw.charterObject("advancedView");else->{val key=path.substringAfterLast('/');server[key]?:EquipmentFixtures.unknown(store.record(key))}}
     retain(raw);guard();return raw
    }})
   override fun policy()=policy;override fun vehiclePolicy()=if(policy==null)null else VehiclePolicy.from(JsonObject(f.vehicle.raw+("ordinaryEquipment" to policy!!.raw)))
   override fun capture(fresh:Boolean):()->Unit{val g=generation;val p=policy;val guard={check(g==generation);if(fresh)check(allowed&&p!=null&&policy==p)};guard();return guard}
   override fun selectedBase()=EquipmentFixtures.base;override fun requireOwnedBase(base:String){check(owned&&base==EquipmentFixtures.base)};override fun key()=UUID.randomUUID().toString();override suspend fun hydrate(guard:()->Unit){guard()}
  }
  fun repo()=EquipmentRepository(store,ports)
  suspend fun lens(repo:EquipmentRepository)=repo.choose("survey_lens","frost_quartz")
  fun route(repo:EquipmentRepository,kind:String)=if(kind=="starter")repo.state.value.starter!!.getValue("routes").jsonArray.first().jsonObject else repo.state.value.routes!!.getValue("items").jsonArray.first().jsonObject.getValue("previews").jsonArray.first().jsonObject
 }
 private fun reject(block:suspend()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 @Test fun `Lens craft binds selected recipe and lost response recovers while paused`()=runBlocking{val h=Harness();val r=h.repo();h.lens(r);r.reviewCraft();val original=h.store.read().pending.single();assertEquals("craft_survey_lens",original.request.charterText("recipeId"));assertTrue(h.posts.isEmpty());h.lost=true;reject{r.confirm()};h.allowed=false;h.owned=false;h.policy=null;val disk=EquipmentFixtures.Memory().apply{value=h.disk.value};val cold=EquipmentStore(disk,h.identity);EquipmentRepository(cold,h.ports).check();assertEquals(f.proof(original),cold.record(original.key).response);assertEquals(1,h.posts.size);Unit}
 @Test fun `both trip families freeze selected material and preserve exact returned companion`()=runBlocking{for(kind in listOf("starter","advanced")){val h=Harness();val r=h.repo();h.lens(r);val route=h.route(r,kind);r.reviewTrip(kind,EquipmentFixtures.installation,route);h.lost=true;reject{r.confirm()};val saved=h.store.read().pending.single();assertEquals("frost_quartz",saved.request.charterObject("fitting").charterText("resourceId"));h.server[saved.key]=f.complete(saved);h.policy=null;h.allowed=false;h.owned=false;val cold=h.repo();cold.open();assertNull(cold.state.value.view);assertEquals(route["secondaryOutput"],h.store.record(saved.key).response!!.charterObject("return")["secondaryOutput"]);cold.archive(saved.key);assertEquals(1,h.posts.size);assertEquals(saved.preview,h.store.read().archives.single().preview)};Unit}
 @Test fun `changing selected material clears consent but never replaces durable original`()=runBlocking{val h=Harness();val r=h.repo();h.lens(r);r.reviewTrip("starter",EquipmentFixtures.installation,h.route(r,"starter"));val original=h.store.read().pending.single();r.choose("survey_lens","heartwood_logs");assertNull(r.state.value.review);assertEquals("heartwood_logs",r.state.value.starter!!.charterObject("fitting").charterText("resourceId"));assertEquals(original.request,h.store.record(original.key).request);assertTrue(h.posts.isEmpty());r.retry(original.key);assertEquals(original.request,h.posts.single());assertEquals("heartwood_logs",r.state.value.starter!!.charterObject("fitting").charterText("resourceId"));Unit}
 @Test fun `same material selection produces no dispatchable starter or advanced preview`()=runBlocking{val h=Harness();val r=h.repo();r.choose("survey_lens","crown_iron_ore");assertTrue(r.state.value.starter!!.getValue("routes").jsonArray.isEmpty());assertTrue(r.state.value.routes!!.getValue("items").jsonArray.first().jsonObject.getValue("previews").jsonArray.isEmpty());assertTrue(h.posts.isEmpty());Unit}
 @Test fun `Compass stock cannot substitute for a missing Lens`()=runBlocking{val h=Harness();h.lens="0";val r=h.repo();h.lens(r);assertFalse(equipmentCanDepart(r.state.value,EquipmentFixtures.base,true));assertTrue(equipmentCanCraft(r.state.value,EquipmentFixtures.base,true));reject{r.reviewTrip("starter",EquipmentFixtures.installation,h.route(r,"starter"))};assertTrue(h.store.read().pending.isEmpty());Unit}
 @Test fun `removed Lens content resets only current choice and preserves saved history`()=runBlocking{val h=Harness();val r=h.repo();h.lens(r);r.reviewCraft();val original=h.store.read().pending.single();h.policy=EquipmentFixtures.policy;r.dismiss();r.open();assertEquals("route_compass",r.state.value.item);assertFalse(r.state.value.lensAvailable);assertEquals(original.request,h.store.record(original.key).request);assertEquals(1,r.state.value.view!!.equipmentStock.size);assertTrue(h.posts.isEmpty());Unit}
 @Test fun `late accepted Lens receipt is owned before changed selection publication`()=runBlocking{val h=Harness();val r=h.repo();h.lens(r);r.reviewTrip("starter",EquipmentFixtures.installation,h.route(r,"starter"));h.stale=true;reject{r.confirm()};val saved=h.store.read().pending.single();assertEquals(h.server[saved.key],saved.response);assertEquals(1,h.posts.size);r.dismiss();assertNull(r.state.value.starter);Unit}
 @Test fun `forged second cargo leg remains held with immutable original request`()=runBlocking{val h=Harness();val r=h.repo();h.lens(r);r.reviewTrip("starter",EquipmentFixtures.installation,h.route(r,"starter"));val original=h.store.read().pending.single();h.forged=true;reject{r.confirm()};val saved=h.store.record(original.key);assertTrue(saved.held);assertEquals(original.preview,saved.preview);assertEquals(original.request,saved.request);reject{r.archive(saved.key)};Unit}
 @Test fun `Lens last copy refusal closes only after fresh original lookup`()=runBlocking{val h=Harness();val r=h.repo();h.lens(r);r.reviewTrip("starter",EquipmentFixtures.installation,h.route(r,"starter"));h.refusal="LENS_UNAVAILABLE";reject{r.confirm()};val original=h.store.read().pending.single();assertEquals("LENS_UNAVAILABLE",original.refusal!!.code);r.discard(original.key);assertTrue(h.store.read().archives.single().closedRefusal);assertFalse(equipmentDefinitiveRefusal(500,"LENS_UNAVAILABLE"));Unit}
 @Test fun `adding Lens policy does not strand an original unknown Compass command`()=runBlocking{val h=Harness();val original=EquipmentFixtures.record();h.store.begin(original);h.store.attempt(original.key);h.store.retain(original.key,EquipmentFixtures.unknown(original));val r=h.repo();r.retry(original.key);assertEquals(original.request,h.posts.single());assertEquals(original.policy,h.store.record(original.key).policy);Unit}
 @Test fun `old wallet or selected kingdom cannot publish new Lens actions`()=runBlocking{val h=Harness();val r=h.repo();h.lens(r);h.owned=false;r.dismiss();r.open();assertNull(r.state.value.view);reject{r.reviewCraft()};val other=EquipmentStore(h.disk,h.identity.copy(wallet="11111111111111111111111111111113"));h.store.begin(EquipmentFixtures.record());reject{other.read()};assertTrue(h.posts.isEmpty());Unit}
 @Test fun `selected recipe and stock controls remain tied to base and pause`() {val s=EquipmentState(view=EquipmentView.from(f.view()),item="survey_lens",resource="frost_quartz");assertTrue(equipmentCanCraft(s,EquipmentFixtures.base,true));assertTrue(equipmentCanDepart(s,EquipmentFixtures.base,true));assertFalse(equipmentCanCraft(s,"wrong",true));assertFalse(equipmentCanDepart(s,EquipmentFixtures.base,false));assertFalse(equipmentCanDepart(s.copy(item="missing"),EquipmentFixtures.base,true))}
 @Test fun `matching main cargo cannot request paid preview or alter saved original`()=runBlocking{
  val h=Harness();val r=h.repo();h.lens(r);r.reviewTrip("starter",EquipmentFixtures.installation,h.route(r,"starter"));val original=h.store.read().pending.single()
  r.paid("1");assertNotNull(r.state.value.paid);val requests=h.paidQueries.toList()
  reject{r.paid("0")};assertNull(r.state.value.paid);assertEquals("0",r.state.value.paidRealm);assertEquals(requests,h.paidQueries)
  assertEquals(original,h.store.record(original.key));assertTrue(h.posts.isEmpty());Unit
 }
 @Test fun `new destination clears old paid card before request and failure`()=runBlocking{
  val h=Harness();val r=h.repo();h.lens(r);r.paid("1");assertNotNull(r.state.value.paid)
  h.afterPaid={assertNull(r.state.value.paid);assertEquals("2",r.state.value.paidRealm)};h.paidFailure=true
  reject{r.paid("2")};assertNull(r.state.value.paid);assertEquals(listOf("1","2"),h.paidQueries);assertTrue(h.store.read().pending.isEmpty());assertTrue(h.posts.isEmpty());Unit
 }
 @Test fun `late paid reply cannot become the newly selected destination card`()=runBlocking{
  val h=Harness();val r=h.repo();h.lens(r);val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
  h.afterPaid={entered.complete(Unit);release.await()}
  val first=async{r.paid("1")};entered.await();reject{r.paid("2")};release.complete(Unit);first.await()
  assertEquals("2",r.state.value.paidRealm);assertNull(r.state.value.paid);assertEquals(listOf("1"),h.paidQueries);assertTrue(h.posts.isEmpty());Unit
 }

}
