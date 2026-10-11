package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

interface VehiclePorts {
 val transport:VehicleTransport
 fun capture(fresh:Boolean):()->Unit
 fun policy():VehiclePolicy?
 fun trust():VehicleSigningTrust?
 fun key():String
 fun now():Long
 fun requireOwnedBase(base:String)
 suspend fun live(client:JsonObject,prepared:PreparedVehicle,pins:VehicleSigningTrust,policy:VehiclePolicy,networkFeeLamports:String,guard:()->Unit):()->Unit
 suspend fun ready(guard:()->Unit)
 suspend fun sign(prepared:PreparedVehicle,guard:()->Unit,beforeWallet:suspend ()->Unit,retain:suspend (JsonObject)->Unit)
 suspend fun hydrate(guard:()->Unit)
}
/** Current service availability is separate from a failed, retryable read and from saved original receipts. */
enum class VehicleUnavailable { MISSING_POLICY, SERVICE_HELD }
private class VehicleReadUnavailable(val reason:VehicleUnavailable) : IllegalStateException("Vehicles are not open on this server yet")
// Existing HomeVoyageSheet read-failure copy; never put an unexpected exception's diagnostics in a borrowed sheet.
internal const val VEHICLE_READ_FAILED = "Fleet details could not be refreshed. Original receipts remain available."
/** The codes the server sends, with a 503, while its crafted-vehicle feature is switched off (PHASE_E_VEHICLES_ENABLED false
 * leaves the provider unset; night/server apps/api/src/game): advancedFleetRoutes.ts:12, vehicleClientRoutes.ts:15,
 * vehicleRoutes.ts:15, vehicleServiceRoutes.ts:15, vehicleCraftClientRoutes.ts:12. */
internal val VEHICLE_FEATURE_OFF_CODES=setOf("ADVANCED_FLEET_UNAVAILABLE","VEHICLE_CLIENT_UNAVAILABLE","VEHICLE_WORKFLOW_UNAVAILABLE",
 "VEHICLE_SERVICE_WORKFLOW_UNAVAILABLE","VEHICLE_CRAFT_UNAVAILABLE")
/** The server says crafted vehicles are not open: a 503 with one of its feature-off codes. Any other 503 (no code, another
 * code), a 5xx or a network error is a real failure that keeps Retry. Matched on the code, never the status or message. */
// 2026-10-06, after the Seeker test against QA (912e04e0): that build answers the switched-off feature with a 503 whose
// code is not one of the five above and may be absent, so every 503 on a crafted-vehicle READ counts as "not open here".
// A 503 is the server saying the vehicle service is unavailable, which is exactly the state the Berth draws as a quiet line;
// network errors and every other status keep RETRY.
internal fun vehicleFeatureOff(e:Throwable):Boolean = e is ApiException && e.status==503
/** A crafted READ route answered a bare 404 (no server code): this server build has no such route (production answers
 * /vehicles/fleet 404), which is the feature off. A coded 404 (BASE_NOT_OWNED) stays a real refusal. Reads only. */
internal fun vehicleRouteAbsent(e:Throwable):Boolean = e is ApiException && e.status==404 && e.code==null

data class VehicleState(val loaded:Boolean=false,val busy:Boolean=false,val journal:VehicleJournal?=null,val selectedId:String?=null,
 val activity:JsonObject?=null,val assets:JsonObject?=null,val fleet:JsonObject?=null,val routes:JsonObject?=null,val review:JsonObject?=null,val error:String?=null,
 val unavailable:VehicleUnavailable?=null) {
 val selected get()=journal?.records?.singleOrNull{it.id==selectedId}
}

/** Explicit effects only. History cannot create another reservation, approval,
 * blockhash or destination. The original committed base may have a new owner. */
class VehicleRepository(private val store:VehicleStore,private val ports:VehiclePorts) {
 private val mutable=MutableStateFlow(VehicleState());val state=mutable.asStateFlow();private var epoch=0L
 private var reviewGuard:(()->Unit)?=null;private val hydrated=mutableSetOf<String>()
 init {require(store.identity==ports.transport.identity)}
 fun dismiss(){epoch++;reviewGuard=null;mutable.value=mutable.value.copy(review=null)}
 suspend fun awaitIdle(){store.requests.withLock{}}
 private fun requirePolicy():VehiclePolicy = ports.policy() ?: throw VehicleReadUnavailable(VehicleUnavailable.MISSING_POLICY)
 // Crafted read routes only: a server without the route (bare 404) has crafted vehicles off, not a retryable read failure.
 private suspend fun craftedRead(read:suspend ()->Unit){try{read()}catch(e:ApiException){if(vehicleRouteAbsent(e))throw VehicleReadUnavailable(VehicleUnavailable.SERVICE_HELD);throw e}}
 private fun clearCurrent(){reviewGuard=null;mutable.value=mutable.value.copy(assets=null,fleet=null,routes=null,review=null)}
 private suspend fun hydrate(guard:()->Unit){
  try{ports.hydrate(guard);guard()}catch(error:Exception){
   if(error is CancellationException)throw error
   guard();hydrated.clear();clearCurrent();throw error
  }
 }
 private suspend fun reload(guard:()->Unit,readOnlyRecovery:Boolean=false,observeOnly:Boolean=false){
  val j=store.read();guard();val ends=j.records.filter{store.isTerminal(it)}.map{it.id+when(it.kind){"installation","service"->it.response!!.getValue("burnReceipt");"expedition"->it.response!!.getValue("return");else->it.response!!}.toString()}
  if(ends.any{it !in hydrated}){
   // Saved receipts remain readable; current fleet authority needs a successful refresh.
   clearCurrent()
   if(observeOnly){mutable.value=mutable.value.copy(loaded=true,journal=j);return}
   try{hydrate(guard);hydrated.addAll(ends)}catch(error:Exception){
    if(error is CancellationException)throw error
    guard();if(!readOnlyRecovery)throw error
    mutable.value=mutable.value.copy(loaded=true,journal=j,error="Current kingdom state could not refresh. Saved vehicle receipts and original checks remain available.");return
   }
  }
  mutable.value=mutable.value.copy(loaded=true,journal=j)
 }
 private suspend fun action(fresh:Boolean,readOnlyRecovery:Boolean=false,run:suspend (()->Unit)->Unit){val captured=ports.capture(fresh);val current=epoch;val guard={captured();check(current==epoch){"The vehicle view changed. Its original result is saved."}};guard();check(store.requests.tryLock()){"Another vehicle action owns the saved journal."}
  try{mutable.value=mutable.value.copy(busy=true,error=null);reload(guard,readOnlyRecovery,observeOnly=readOnlyRecovery)
   if(fresh)state.value.unavailable?.let{throw VehicleReadUnavailable(it)}
   run(guard);reload(guard,readOnlyRecovery)
  }catch(e:Exception){
   reviewGuard=null
   if(e is CancellationException)throw e
   if(runCatching{guard()}.isSuccess){
    val unavailable=when {
     e is VehicleReadUnavailable -> e.reason
     vehicleFeatureOff(e) -> VehicleUnavailable.SERVICE_HELD
     else -> null
    }
    // A held service is not evidence of an empty fleet. Retire live authority, keep the journal and original selection.
    if(unavailable!=null)clearCurrent()
    mutable.value=mutable.value.copy(review=null,unavailable=unavailable,error=if(unavailable==null)VEHICLE_READ_FAILED else null)
   }
   throw e
  }finally{store.requests.unlock();if(runCatching{captured()}.isSuccess)mutable.value=mutable.value.copy(busy=false)}
 }
 private fun selected()=requireNotNull(state.value.selected){"Open a saved vehicle operation."}
 private fun signing(r:VehicleRecord):JsonObject {require(r.kind in listOf("installation","service"));return requireNotNull(r.response){"Recover the original reservation first."}}
 private fun endpoint(r:VehicleRecord):String {val c=signing(r);return store.path(r.kind)+"/"+VehicleProtocol.reference(c).charterText("id")}
 private fun selected(id:String){reviewGuard=null;mutable.value=mutable.value.copy(selectedId=id,review=null)}
 private suspend fun retain(r:VehicleRecord,raw:JsonObject,delivery:Boolean=false)=withContext(NonCancellable){store.observe(r.id,raw);store.accept(r.id,if(delivery)VehicleProtocol.delivery(raw).charterObject("client") else raw)}
 private suspend fun fetch(r:VehicleRecord,guard:()->Unit){if(r.kind=="collect"){refreshTracked(r.request.charterText("baseId"),guard);return};val path=if(r.kind in listOf("installation","service")&&r.response!=null)endpoint(r) else VehicleProtocol.byKeyPath(r.kind,r.key);ports.transport.request("GET",path,guard=guard){retain(r,it)}}
 private suspend fun submit(r:VehicleRecord,guard:()->Unit){store.attempt(r.id,"post",true);guard();ports.transport.request("POST",store.path(r.kind),r.request,guard){retain(r,it)};reload(guard);selected(r.id)}
 suspend fun open(cursor:String?=null)=action(false,readOnlyRecovery=true){guard->val policy=requirePolicy();craftedRead{ports.transport.request("GET","/vehicles/client/activity",guard=guard,query=cursor?.let{mapOf("cursor" to it)}?:emptyMap()){raw->val v=VehicleProtocol.activity(raw);require(v.charterText("wallet")==store.identity.wallet);require(v.getValue("items").jsonArray.size<=policy.bound("discoveryPageSize"));guard();mutable.value=mutable.value.copy(activity=v)}}}
 suspend fun assets(cursor:String?=null)=action(false){guard->val policy=requirePolicy();craftedRead{ports.transport.request("GET","/vehicles/client/assets-v2",guard=guard,query=cursor?.let{mapOf("cursor" to it)}?:emptyMap()){raw->val v=VehicleProtocol.assetsV2(raw);require(v.charterText("wallet")==store.identity.wallet);require(v.getValue("items").jsonArray.size<=policy.bound("discoveryPageSize"));guard();mutable.value=mutable.value.copy(assets=v)}}}
 private suspend fun fleet(base:String,guard:()->Unit,version:Long?=null){ports.requireOwnedBase(base);val policy=requirePolicy();val routeVersion=version?:policy.routePolicyVersion;require(policy.supportsRouteVersion(routeVersion));craftedRead{ports.transport.request("GET","/vehicles/fleet",guard=guard,query=mapOf("baseId" to base)){raw->val v=VehicleProtocol.fleet(raw);require(v.charterText("wallet")==store.identity.wallet&&v.charterText("baseId")==base);policy.verifyFleet(v);guard();mutable.value=mutable.value.copy(fleet=v)}};craftedRead{ports.transport.request("GET","/vehicles/client/routes",guard=guard,query=mapOf("baseId" to base)+if(routeVersion==1L)emptyMap() else mapOf("policyVersion" to routeVersion.toString())){raw->val v=VehicleProtocol.routes(raw);require(v.charterText("wallet")==store.identity.wallet&&v.charterText("baseId")==base);policy.verifyRoutes(v,routeVersion);val fleetRows=requireNotNull(state.value.fleet).getValue("vehicles").jsonArray.map{it.jsonObject};v.getValue("items").jsonArray.forEach{item->val row=item.jsonObject;val vehicle=fleetRows.single{it["installationId"]==row["installationId"]};row.getValue("previews").jsonArray.forEach{preview->require(preview.jsonObject["family"]==vehicle["family"]&&preview.jsonObject["tier"]==vehicle["tier"])}};guard();mutable.value=mutable.value.copy(routes=v,unavailable=null)}}}
 suspend fun fleet(base:String)=action(false){fleet(base,it)}
 suspend fun select(id:String)=action(false,readOnlyRecovery=true){guard->selected(id);fetch(store.record(id),guard)}
 suspend fun check()=action(false,readOnlyRecovery=true){guard->for(r in store.read().pending)fetch(r,guard)}
 suspend fun openActivity(item:JsonObject)=action(false,readOnlyRecovery=true){guard->require(item in requireNotNull(state.value.activity).getValue("items").jsonArray);val kind=item.charterText("kind");val key=item.charterText("idempotencyKey");val path=if(kind=="expedition")VehicleProtocol.byKeyPath(kind,key) else store.path(kind)+"/"+item.charterText("id");val policy=requireNotNull(ports.policy());ports.transport.request("GET",path,guard=guard){raw->val r=if(kind=="expedition"){val v=VehicleProtocol.expedition(raw);val receipt=requireNotNull(v.charterOptional("receipt"));require(receipt.charterText("expeditionId")==item.charterText("id")&&receipt.charterObject("request")["baseId"]==item["baseId"]);store.adoptExpedition(v,policy)}else{val v=VehicleProtocol.client(raw);require(VehicleProtocol.reference(v).charterText("id")==item.charterText("id")&&VehicleProtocol.request(v).charterText("idempotencyKey")==key&&VehicleProtocol.destination(v)["baseId"]==item["baseId"]);store.adopt(v,policy)};guard();selected(r.id)}}
 suspend fun reserve(base:String,berth:String,asset:String)=action(true){guard->requireNotNull(ports.trust()){"Vehicle signing is not configured."};ports.requireOwnedBase(base);val policy=requireNotNull(ports.policy());val key=ports.key();val request=buildJsonObject{put("baseId",base);put("berthId",berth);put("assetId",asset);put("idempotencyKey",key)};val r=store.begin("installation",key,request,policy);selected(r.id);submit(r,guard)}
 suspend fun service(base:String,installation:String,asset:String,operation:String)=action(true){guard->requireNotNull(ports.trust()){"Vehicle signing is not configured."};ports.requireOwnedBase(base);fleet(base,guard);val fleet=requireNotNull(state.value.fleet);require(CharterGrammar.bool(fleet.getValue("acceptingNewActions")));val row=fleet.getValue("vehicles").jsonArray.map{it.jsonObject}.single{it.charterText("installationId")==installation};require(!CharterGrammar.bool(row.getValue("away"))&&!CharterGrammar.bool(row.getValue("pendingService")));val key=ports.key();val request=buildJsonObject{put("installationId",installation);put("assetId",asset);put("operation",operation);put("idempotencyKey",key)};val r=store.begin("service",key,request,requireNotNull(ports.policy()),destination=buildJsonObject{put("baseId",base);put("berthId",row.getValue("berthId"))});selected(r.id);submit(r,guard)}
 suspend fun retry(id:String)=action(store.record(id).kind!="collect"){guard->val r=store.record(id);if(r.response!=null&&!(r.kind=="expedition"&&r.response.charterText("status")=="unknown")){fetch(r,guard);return@action};if(r.kind in listOf("installation","service")){try{fetch(r,guard);return@action}catch(e:ApiException){if(e.status!=404)throw e}};when(r.kind){"installation"->{requireNotNull(ports.trust());ports.requireOwnedBase(r.request.charterText("baseId"))};"service"->{requireNotNull(ports.trust());val base=requireNotNull(r.destination).charterText("baseId");ports.requireOwnedBase(base)};else->ports.requireOwnedBase(r.request.charterText("baseId"))};submit(r,guard)}
 suspend fun command(name:String)=action(name=="prepare"){guard->require(name in listOf("prepare","recover"));var r=selected();fetch(r,guard);r=store.record(r.id);if(name=="prepare")requireNotNull(ports.trust());store.attempt(r.id,name,true);guard();ports.transport.request("POST","${endpoint(r)}/$name",buildJsonObject{},guard){retain(r,it)};reviewGuard=null;mutable.value=mutable.value.copy(review=null)}
 private suspend fun current(r:VehicleRecord,pins:VehicleSigningTrust,policy:VehiclePolicy,guard:()->Unit):Pair<PreparedVehicle,()->Unit> {val c=signing(r);val prepared=VehicleTransaction.prepare(c,pins,policy);val started=ports.now();require(started>=0);var review:JsonObject?=null;ports.transport.request("POST","${endpoint(r)}/review",buildJsonObject{},guard){raw->val v=VehicleProtocol.review(raw);policy.verifyReview(v,c);require(v.charterText("status")=="ready"){"Vehicle approval is held: ${v["reason"]}"};guard();review=v};val live=ports.live(c,prepared,pins,policy,requireNotNull(review).charterObject("observation").charterText("networkFeeLamports"),guard);val fresh={guard();live();require(Math.subtractExact(ports.now(),started) in 0..policy.bound("reviewMaxAgeMs")){"Review the original vehicle message again."};check(ports.trust()==pins&&policy.sameBurnPolicy(ports.policy()))};fresh();mutable.value=mutable.value.copy(review=requireNotNull(review));return prepared to fresh}
 suspend fun review()=action(true){guard->val r=selected();fetch(r,guard);val saved=store.record(r.id);require(!saved.held&&saved.signed==null&&"wallet" !in saved.attempts);val c=signing(saved);require(VehicleProtocol.terminal(c)==null&&c.charterObject("record").charterOptional("signed")==null);val pins=requireNotNull(ports.trust());val policy=VehiclePolicy.from(saved.policy);require(policy.sameBurnPolicy(ports.policy()));val(_,fresh)=current(saved,pins,policy,guard);store.consent(r.id,VehicleConsent(c,pins.toJson()));fresh();reviewGuard=fresh}
 suspend fun approve()=action(true){guard->val reviewed=requireNotNull(reviewGuard){"Review the original burn and destination first."};reviewed();val prior=requireNotNull(state.value.review);val r=selected();fetch(r,guard);val saved=store.record(r.id);require(!saved.held&&saved.signed==null&&"wallet" !in saved.attempts);val c=signing(saved);require(VehicleProtocol.terminal(c)==null&&c.charterObject("record").charterOptional("signed")==null);val consent=requireNotNull(saved.consent);val pins=requireNotNull(ports.trust());val policy=VehiclePolicy.from(saved.policy);require(consent.pins==pins.toJson()&&VehicleProtocol.original(consent.client)==VehicleProtocol.original(c)&&consent.client.charterObject("record")["preparation"]==c.charterObject("record")["preparation"]);val(prepared,fresh)=current(saved,pins,policy,guard);require(prior.charterObject("observation")["networkFeeLamports"]==state.value.review!!.charterObject("observation")["networkFeeLamports"]){"The fee quote changed. Review it again."};ports.ready(fresh);fresh();val marked=java.util.concurrent.atomic.AtomicBoolean(false);ports.sign(prepared,fresh,{check(marked.compareAndSet(false,true));fresh();store.attempt(r.id,"wallet");fresh()}){store.signed(r.id,it)};check(marked.get());fresh();reviewGuard=null;mutable.value=mutable.value.copy(review=null)}
 suspend fun upload()=action(false){guard->val r=selected();val wire=requireNotNull(r.signed);VehicleTransaction.verifyWire(requireNotNull(r.consent).client,wire,VehiclePolicy.from(r.policy));val hex=wire.charterText("signedTransactionHex");val bytes=hex.chunked(2).map{it.toInt(16).toByte()}.toByteArray();store.attempt(r.id,"upload",true);guard();ports.transport.request("POST","${endpoint(r)}/signed",buildJsonObject{put("signedTransaction",Base64.getEncoder().encodeToString(bytes))},guard){retain(r,it)}}
 suspend fun deliver()=action(true){guard->val old=selected();fetch(old,guard);val r=store.record(old.id);require(!r.held);val c=signing(r);require(VehicleProtocol.terminal(c)==null&&c.charterObject("record").charterOptional("signed")!=null);val pins=requireNotNull(ports.trust());val policy=VehiclePolicy.from(r.policy);require(policy.sameBurnPolicy(ports.policy()));r.consent?.let{require(it.pins==pins.toJson())};val(_,fresh)=current(r,pins,policy,guard);fresh();store.attempt(r.id,"deliver",true);fresh();ports.transport.request("POST","${endpoint(r)}/deliver",buildJsonObject{},fresh){retain(r,it,true)};reviewGuard=null;mutable.value=mutable.value.copy(review=null)}
 suspend fun dispatch(base:String,installation:String,routeId:String,policyVersion:Long?=null)=action(true){guard->ports.requireOwnedBase(base);val displayed=state.value.routes?.takeIf{it.charterText("baseId")==base}?.getValue("items")?.jsonArray?.map{it.jsonObject}?.singleOrNull{it.charterText("installationId")==installation}?.getValue("previews")?.jsonArray?.map{it.jsonObject}?.singleOrNull{it.charterText("routeId")==routeId};val version=policyVersion?:displayed?.let{CharterGrammar.number(it.getValue("policyVersion"))}?:1L;fleet(base,guard,version);val fleet=requireNotNull(state.value.fleet);require(CharterGrammar.bool(fleet.getValue("acceptingNewActions")));val vehicle=fleet.getValue("vehicles").jsonArray.map{it.jsonObject}.single{it.charterText("installationId")==installation};require(!CharterGrammar.bool(vehicle.getValue("away"))&&!CharterGrammar.bool(vehicle.getValue("pendingService"))&&CharterGrammar.number(vehicle.getValue("remainingUses"))>0);val preview=requireNotNull(state.value.routes).getValue("items").jsonArray.map{it.jsonObject}.single{it.charterText("installationId")==installation}.getValue("previews").jsonArray.map{it.jsonObject}.single{it.charterText("routeId")==routeId};if(displayed!=null)require(displayed==preview){"The route preview changed. Check its current provisions and access before dispatch."};val policy=requireNotNull(ports.policy());policy.verifyRoute(preview,true);val key=ports.key();val request=buildJsonObject{put("idempotencyKey",key);put("baseId",base);put("installationId",installation);put("routeId",routeId);put("policyVersion",preview.getValue("policyVersion"))};val r=store.begin("expedition",key,request,policy,preview);selected(r.id);submit(r,guard);fleet(base,guard)}
 private suspend fun refreshTracked(base:String,guard:()->Unit){for(r in store.read().records.filter{it.kind=="expedition"&&it.request.charterText("baseId")==base})fetch(r,guard);fleet(base,guard)}
 suspend fun collect(base:String)=action(false){guard->ports.requireOwnedBase(base);val key=ports.key();val r=store.begin("collect",key,buildJsonObject{put("baseId",base)},requireNotNull(ports.policy()));selected(r.id);submit(r,guard);refreshTracked(base,guard);hydrate(guard)}
 /** Owner rule 2026-10-06 (no saved request may block play forever): CLOSE reads the selected pending original by its own key
  * now and archives it only on the server's answer that it has no record of that key: an expedition "unknown", or the
  * installation/service not-found code for an original that never received a reservation. An answer that knows the key
  * is retained instead. A collect has no by-key read and is never closed. No POST. */
 suspend fun closeUnknown()=action(false,readOnlyRecovery=true){guard->val old=selected();val r=store.read().pending.single{it.id==old.id}
  require(!r.held&&!store.isTerminal(r)&&r.consent==null&&r.signed==null){"This original has saved progress. Recover it instead."}
  when(r.kind){
   "expedition"->{var seen:JsonObject?=null;ports.transport.request("GET",VehicleProtocol.byKeyPath(r.kind,r.key),guard=guard){retain(r,it);seen=it};guard()
    val saved=store.record(r.id);if(saved.response?.charterText("status")=="unknown")store.closeUnknown(r.id,saved,requireNotNull(seen))}
   "installation","service"->{require(r.response==null){"This original has a server reservation. Recover it instead."}
    val evidence=try{ports.transport.request("GET",VehicleProtocol.byKeyPath(r.kind,r.key),guard=guard){retain(r,it)};null}catch(e:ApiException){if(e.status==404&&e.code==VehicleStore.unknownCode(r.kind))VehicleStore.serverUnknown(r.kind) else throw e}
    guard();if(evidence!=null)store.closeUnknown(r.id,store.record(r.id),evidence)}
   else->error("A saved collection has no by-key record to check. Retry it instead.")
  }
  reviewGuard=null;mutable.value=mutable.value.copy(review=null)}
 suspend fun archive()=action(false){guard->val old=selected();require(store.read().pending.any{it.id==old.id});fetch(old,guard);val saved=store.record(old.id);require(store.isTerminal(saved)&&!saved.held);hydrate(guard);guard();store.archive(old.id,saved);reviewGuard=null;mutable.value=mutable.value.copy(review=null)}
}
