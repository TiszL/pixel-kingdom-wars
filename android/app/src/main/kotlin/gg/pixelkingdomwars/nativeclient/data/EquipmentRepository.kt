package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

interface EquipmentPorts {
 val transport:EquipmentTransport
 fun capture(fresh:Boolean):()->Unit
 fun policy():EquipmentPolicy?
 fun vehiclePolicy():VehiclePolicy?
 fun selectedBase():String?
 fun requireOwnedBase(base:String)
 fun key():String
 suspend fun hydrate(guard:()->Unit)
}
data class EquipmentState(val busy:Boolean=false,val journal:EquipmentJournal?=null,val view:EquipmentView?=null,
 val starter:JsonObject?=null,val paid:JsonObject?=null,val paidRealm:String?=null,val fleet:JsonObject?=null,val routes:JsonObject?=null,val selectedKey:String?=null,val item:String="route_compass",val resource:String?=null,val lensAvailable:Boolean=false,val review:EquipmentRecord?=null,val error:String?=null) {
 val selected get()=journal?.records?.singleOrNull{it.key==selectedKey}
}
/** A craft or fitted departure has one durable original and explicit confirm.
 * Foreground/recovery never POST, and a sale never retargets the saved tool/base. */
class EquipmentRepository(private val store:EquipmentStore,private val ports:EquipmentPorts) {
 private val mutable=MutableStateFlow(EquipmentState());val state=mutable.asStateFlow();private var epoch=0L
 private fun fitting()=requireNotNull(ports.policy()).selectionFor(state.value.item,state.value.resource)
 private fun query(selection:JsonObject=fitting())=mapOf("fitting" to selection.charterText("itemId"))+selection["resourceId"]?.jsonPrimitive?.content?.let{mapOf("resourceId" to it)}.orEmpty()
 suspend fun choose(item:String,resource:String?=null){check(!state.value.busy);requireNotNull(ports.policy()).selectionFor(item,resource);dismiss();mutable.value=mutable.value.copy(item=item,resource=resource);open()}
 private val hydrated=mutableSetOf<String>()
 init{require(store.identity==ports.transport.identity)}
 fun dismiss(){epoch++;mutable.value=mutable.value.copy(busy=false,view=null,starter=null,paid=null,paidRealm=null,fleet=null,routes=null,review=null,error=null)}
 suspend fun awaitIdle(){store.requests.withLock{}}
 private fun clearCurrent(){mutable.value=mutable.value.copy(view=null,starter=null,paid=null,paidRealm=null,fleet=null,routes=null,review=null)}
 private suspend fun hydrate(guard:()->Unit){try{ports.hydrate(guard);guard()}catch(error:Exception){if(runCatching{guard()}.isSuccess){hydrated.clear();clearCurrent()};throw error}}
 private suspend fun reload(guard:()->Unit,requireHydration:Boolean,observeOnly:Boolean=false){
  val j=store.read();guard();val accepted=j.records.filter{it.response!=null&&(it.kind=="collect"||it.response!!.charterText("status")=="accepted")}.map{it.key+it.response!!.filterKeys{k->k!="serverNow"}.toString()}
  if(accepted.any{it !in hydrated}){
   // Original evidence remains readable; current stock and routes require successful hydration.
   if(observeOnly){clearCurrent();mutable.value=mutable.value.copy(journal=j);return}
   try{hydrate(guard);hydrated.addAll(accepted)}catch(error:Exception){
    if(error is CancellationException)throw error
    guard();if(requireHydration)throw error
    mutable.value=mutable.value.copy(journal=j,error="Current kingdom stock and routes could not refresh. Saved requests and original receipt checks remain available.");return
   }
  }
  mutable.value=mutable.value.copy(journal=j)
 }
 private suspend fun action(fresh:Boolean,historyRecovery:Boolean=false,work:suspend(()->Unit)->Unit){val captured=ports.capture(fresh);val e=epoch;val guard={captured();check(e==epoch){"The equipment view changed. Its original result is saved."}};guard();check(store.requests.tryLock()){"An equipment request is still running."}
  try{mutable.value=mutable.value.copy(busy=true,error=null);reload(guard,requireHydration=!historyRecovery,observeOnly=historyRecovery);work(guard);reload(guard,requireHydration=!historyRecovery)}catch(error:Exception){if(runCatching{guard()}.isSuccess){if(historyRecovery)clearCurrent();mutable.value=mutable.value.copy(error=error.message,review=null)};throw error}finally{store.requests.unlock();if(runCatching{captured()}.isSuccess)mutable.value=mutable.value.copy(busy=false)}
 }
 private fun owned(base:String,guard:()->Unit){guard();check(ports.selectedBase()==base){"The selected kingdom changed."};ports.requireOwnedBase(base)}
 private suspend fun fetch(r:EquipmentRecord,guard:()->Unit){if(r.kind=="collect"){for(trip in store.read().records.filter{it.kind=="advanced"&&it.request["baseId"]==r.request["baseId"]})fetch(trip,guard);return};ports.transport.request("GET",store.receiptPath(r),guard=guard){store.retain(r.key,it)}}
 suspend fun check()=action(false,historyRecovery=true){guard->for(r in store.read().pending)fetch(r,guard)}
 suspend fun select(key:String)=action(false,historyRecovery=true){guard->mutable.value=mutable.value.copy(selectedKey=key,review=null);fetch(store.record(key),guard)}
 private suspend fun inventory(base:String,guard:()->Unit):EquipmentView {owned(base,guard);val policy=requireNotNull(ports.policy()){"Equipment content is unavailable."};val raw=ports.transport.request("GET","/ordinary-equipment",guard=guard,query=mapOf("baseId" to base)+if(policy.surveyLens!=null)mapOf("catalogueVersion" to "2")else emptyMap());val view=EquipmentView.from(raw);require(view.wallet==store.identity.wallet&&view.baseId==base);require(view.catalogueVersion==(if(policy.surveyLens!=null)2 else null));view.recipes.forEach(policy::verify);require(view.recipeVersion.toLong()==CharterGrammar.number(policy.equipment.getValue("recipeVersion"))&&view.maxBatch.toLong()==CharterGrammar.number(policy.equipment.getValue("maxBatch")));owned(base,guard);mutable.value=mutable.value.copy(view=view,lensAvailable=policy.surveyLens!=null);return view}
 private suspend fun starter(base:String,guard:()->Unit,selection:JsonObject=fitting()):JsonObject{owned(base,guard);val policy=requireNotNull(ports.policy());val raw=ports.transport.request("GET","/starter-expeditions",guard=guard,query=mapOf("baseId" to base)+query(selection));val view=EquipmentGrammar.starterView(raw,policy);require(view.charterText("wallet")==store.identity.wallet&&view.charterText("baseId")==base&&view["fitting"]==selection);owned(base,guard);if(selection==fitting())mutable.value=mutable.value.copy(starter=view);return view}
 private suspend fun fleet(base:String,guard:()->Unit,selection:JsonObject=fitting()):JsonObject{owned(base,guard);val policy=requireNotNull(ports.vehiclePolicy());val raw=ports.transport.request("GET","/vehicles/fleet",guard=guard,query=mapOf("baseId" to base));val view=VehicleProtocol.fleet(raw);require(view.charterText("wallet")==store.identity.wallet&&view.charterText("baseId")==base);policy.verifyFleet(view);owned(base,guard);mutable.value=mutable.value.copy(fleet=view)
  val routes=VehicleProtocol.routes(ports.transport.request("GET","/vehicles/client/routes",guard=guard,query=mapOf("baseId" to base,"policyVersion" to policy.routePolicyVersion.toString())+query(selection)));require(routes.charterText("wallet")==store.identity.wallet&&routes.charterText("baseId")==base);policy.verifyRoutes(routes,policy.routePolicyVersion)
  val vehicles=view.getValue("vehicles").jsonArray.map{it.jsonObject};routes.getValue("items").jsonArray.forEach{item->val row=item.jsonObject;val installed=vehicles.single{it["installationId"]==row["installationId"]};row.getValue("previews").jsonArray.forEach{preview->val p=preview.jsonObject;require(p["fitting"]!=null&&p["family"]==installed["family"]&&p["tier"]==installed["tier"]&&equipmentSelection(p.charterObject("fitting"))==selection)}};owned(base,guard);if(selection==fitting())mutable.value=mutable.value.copy(routes=routes);return routes
 }
 suspend fun open()=action(false,historyRecovery=true){guard->if(state.value.item=="survey_lens"&&ports.policy()?.surveyLens==null)mutable.value=mutable.value.copy(item="route_compass",resource=null,lensAvailable=false);mutable.value=mutable.value.copy(view=null,starter=null,paid=null,paidRealm=null,fleet=null,routes=null,review=null);for(r in store.read().pending)fetch(r,guard);val base=ports.selectedBase();if(base!=null&&ports.policy()!=null&&runCatching{ports.requireOwnedBase(base)}.isSuccess){inventory(base,guard);starter(base,guard);if(ports.vehiclePolicy()!=null)fleet(base,guard)}}
 private suspend fun paid(base:String,realm:String,guard:()->Unit,selection:JsonObject=fitting()):JsonObject{owned(base,guard);val realmId=gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds.getOrNull(realm.toIntOrNull()?:-1);require(realmId!=null&&equipmentPaidDestinationSupports(selection.charterText("itemId"),selection["resourceId"]?.jsonPrimitive?.content,realmId)){"Choose a destination with different main cargo from your Lens material."};val view=EquipmentGrammar.paidView(ports.transport.request("GET","/starter-expeditions/paid-route",guard=guard,query=mapOf("baseId" to base,"realm" to realm)+query(selection)),requireNotNull(ports.policy()));require(view.charterText("wallet")==store.identity.wallet&&view.charterText("baseId")==base&&CharterGrammar.number(view.getValue("realm")).toString()==realm);require(equipmentSelection(view.charterObject("route").charterObject("fitting"))==selection);owned(base,guard);return view}
 suspend fun paid(realm:String){
  // A failed or late lookup must never leave a different destination on the current card.
  mutable.value=mutable.value.copy(paid=null,paidRealm=realm)
  action(false){guard->val selection=fitting();val view=paid(requireNotNull(ports.selectedBase()),realm,guard,selection);if(state.value.paidRealm==realm&&selection==fitting())mutable.value=mutable.value.copy(paid=view)}
 }
 private suspend fun prepare(record:EquipmentRecord,guard:()->Unit){guard();store.begin(record);guard();mutable.value=mutable.value.copy(selectedKey=record.key,review=record)}
 suspend fun reviewCraft()=action(true){guard->val base=requireNotNull(ports.selectedBase());val displayed=requireNotNull(state.value.view);val view=inventory(base,guard);require(displayed.baseId==base&&displayed.recipes==view.recipes){"The Workshop recipe changed. Review its current materials."};val command=EquipmentCommand.review(store.identity,view,ports.key(),state.value.item);prepare(EquipmentRecord("craft",command.request.idempotencyKey,command.request.body(),requireNotNull(ports.policy()).raw,recipe=command.recipe),guard)}
 private suspend fun route(kind:String,base:String,installation:String,id:String,guard:()->Unit,paidRealm:String?=null,selection:JsonObject=fitting()):JsonObject {
  val view=inventory(base,guard);require(view.equipmentStock.single{it.itemId==selection.charterText("itemId")}.available.toBigInteger().signum()>0){"No selected fitting is available in this kingdom."}
  if(kind=="starter"){val current=starter(base,guard,selection);require(CharterGrammar.bool(current.getValue("acceptingDepartures"))&&current["flight"]==JsonNull&&current["lodgeCompletedAt"]!=JsonNull&&current.charterOptional("installation")?.charterText("installationId")==installation)
   return if(paidRealm!=null){val selected=paid(base,paidRealm,guard,selection);require(CharterGrammar.bool(selected.getValue("acceptingDepartures"))&&selected.charterObject("coverage").charterText("status")=="covered");selected.charterObject("route").also{require(it.charterText("routeId")==id)}}else current.getValue("routes").jsonArray.map{it.jsonObject}.single{it.charterText("routeId")==id}
  }
  require(kind=="advanced");val routes=fleet(base,guard,selection);val fleet=requireNotNull(state.value.fleet);require(CharterGrammar.bool(fleet.getValue("acceptingNewActions")));val vehicle=fleet.getValue("vehicles").jsonArray.map{it.jsonObject}.single{it.charterText("installationId")==installation};require(!CharterGrammar.bool(vehicle.getValue("away"))&&!CharterGrammar.bool(vehicle.getValue("pendingService"))&&CharterGrammar.number(vehicle.getValue("remainingUses"))>0)
  return routes.getValue("items").jsonArray.map{it.jsonObject}.single{it.charterText("installationId")==installation}.getValue("previews").jsonArray.map{it.jsonObject}.single{it.charterText("routeId")==id}
 }
 suspend fun reviewTrip(kind:String,installation:String,preview:JsonObject,paidRealm:String?=null)=action(true){guard->val base=requireNotNull(ports.selectedBase());val current=route(kind,base,installation,preview.charterText("routeId"),guard,paidRealm);require(current==preview){"The fitted route changed. Check its current cargo and deadline."};val policy=requireNotNull(ports.policy());val key=ports.key();val request=buildJsonObject{put("idempotencyKey",key);put("baseId",base);put("installationId",installation);put("routeId",current.getValue("routeId"));put("fitting",fitting());if(kind=="starter"){put("routeVersion",current.getValue("routeCatalogueVersion"));put("rewardVersion",current.getValue("rewardTableVersion"))}else put("policyVersion",current.getValue("policyVersion"))};prepare(EquipmentRecord(kind,key,request,policy.raw,preview=current,vehiclePolicy=if(kind=="advanced")requireNotNull(ports.vehiclePolicy()).raw else null),guard)}
 private suspend fun current(r:EquipmentRecord,guard:()->Unit){val base=r.request.charterText("baseId");owned(base,guard);require(ports.policy()?.sameItemPolicy(EquipmentPolicy.from(r.policy),r.recipe?.output?.itemId?:r.request.charterObject("fitting").charterText("itemId"))==true){"Installed equipment policy changed. Recover this original."};when(r.kind){"craft"->{val view=inventory(base,guard);EquipmentCommand(EquipmentGrammar.craftRequest(r.request),requireNotNull(r.recipe)).admit(store.identity,view)}
  "starter","advanced"->{val paidRealm=if(r.kind=="starter"&&r.preview!!.charterText("routeId").startsWith("paid_"))gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds.indexOf(r.preview.charterText("realmId")).also{require(it>=0)}.toString()else null;require(route(r.kind,base,r.request.charterText("installationId"),r.request.charterText("routeId"),guard,paidRealm,r.request.charterObject("fitting"))==r.preview)}
 }}
 private suspend fun submit(r:EquipmentRecord,guard:()->Unit){val first=!r.attempted;val attempt=store.attempt(r.key);guard();ports.transport.request("POST",store.path(r.kind),r.request,guard,refusal={error->if(first&&equipmentDefinitiveRefusal(error.status,error.code))store.refuse(r.key,EquipmentRefusal(error.status,requireNotNull(error.code),requireNotNull(attempt.attemptRevision)))
  // Owner review 2026-10-06: a gateway failure may mean the server is still processing this POST: kept, not closable yet.
  else if(error.status in setOf(502,503,504))store.markServerBusy(r.key,requireNotNull(attempt.attemptRevision))}){store.retain(r.key,it)};guard();mutable.value=mutable.value.copy(review=null);hydrate(guard)}
 suspend fun confirm()=action(true){guard->val review=requireNotNull(state.value.review);val r=store.record(review.key);require(r==review&&!r.held);fetch(r,guard);val observed=store.record(r.key);if(observed.response?.charterText("status")=="accepted"){mutable.value=mutable.value.copy(review=null);return@action};current(observed,guard);submit(observed,guard)}
 suspend fun retry(key:String)=action(false,historyRecovery=true){guard->val r=store.record(key);require(!r.discardedUnsent&&!r.closedRefusal&&!r.closedUnknown);fetch(r,guard);val saved=store.record(key);if(saved.response!=null&&(saved.kind=="collect"||saved.response.charterText("status")=="accepted"))return@action
  require(saved.refusal==null){"Archive the original verified refusal before a new command."};val fresh=if(saved.kind=="collect")guard else ports.capture(true);val combined={guard();fresh()};reload(combined,requireHydration=true);if(saved.kind=="collect")owned(saved.request.charterText("baseId"),combined)else current(saved,combined);submit(saved,combined)}
 suspend fun collect()=action(false){guard->val base=requireNotNull(ports.selectedBase());owned(base,guard);val r=store.begin(EquipmentRecord("collect",ports.key(),buildJsonObject{put("baseId",base)},requireNotNull(ports.policy()).raw));mutable.value=mutable.value.copy(selectedKey=r.key);submit(r,guard);for(trip in store.read().records.filter{it.kind=="advanced"&&it.request["baseId"]==r.request["baseId"]})fetch(trip,guard)}
 /** Owner rule 2026-10-06: no saved request blocks play forever. A sent original closes only when THIS action's
  * by-key GET answers "unknown"; that exact reply is handed to the store, so an older saved "unknown" never counts. */
 suspend fun discard(key:String)=action(false){guard->val r=store.record(key);require(r.kind!="collect"&&!r.discardedUnsent&&!r.closedRefusal&&!r.closedUnknown)
  val fresh=ports.transport.request("GET",store.receiptPath(r),guard=guard){store.retain(r.key,it)};val saved=store.record(key);guard();store.discard(key,saved,fresh);mutable.value=mutable.value.copy(review=null)}
 suspend fun archive(key:String)=action(false){guard->val r=store.record(key);fetch(r,guard);val saved=store.record(key);require(store.terminal(saved)&&!saved.held);hydrate(guard);guard();store.archive(key,saved)}
}
