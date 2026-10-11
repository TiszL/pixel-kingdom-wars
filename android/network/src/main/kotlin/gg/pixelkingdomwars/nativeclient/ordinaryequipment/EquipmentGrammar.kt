package gg.pixelkingdomwars.nativeclient.ordinaryequipment

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import java.time.Instant
import kotlinx.serialization.json.*

/** Exact additive routes and original identity binding. No ownership authority is
 * inferred from historical receipts or from a former actor's original base id. */
object EquipmentGrammar {
 private fun keys(raw:JsonObject,vararg fields:String){require(raw.keys==fields.toSet())}
 private fun time(raw:JsonObject,key:String):Instant{val value=raw.charterText(key);require(value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")));return Instant.parse(value)}
 fun craftRequest(raw:JsonObject):EquipmentRequest{strictPrimitives(raw,EquipmentRequest.serializer().descriptor);return equipmentJson.decodeFromJsonElement<EquipmentRequest>(raw).also{it.validate()}}
 fun starterRoute(raw:JsonObject,policy:EquipmentPolicy,preview:Boolean=false):StarterExpeditionRoute{val original=policy.original(raw);strictPrimitives(original,StarterExpeditionRoute.serializer().descriptor);return equipmentJson.decodeFromJsonElement<StarterExpeditionRoute>(original).also{if(preview&&it.routeId.startsWith("paid_")&&it.access?.observation==null)validatePaidStarterPreview(it)else it.validate()}}
 fun starterRequest(raw:JsonObject){require(raw.keys==setOf("idempotencyKey","baseId","installationId","routeId","routeVersion","rewardVersion","fitting"));EquipmentPolicy.selection(raw.charterObject("fitting"));val plain=JsonObject(raw-"fitting");strictPrimitives(plain,StarterExpeditionRequest.serializer().descriptor);equipmentJson.decodeFromJsonElement<StarterExpeditionRequest>(plain).validate()}
 fun starterView(input:JsonObject,policy:EquipmentPolicy):JsonObject{val raw=VehicleProtocol.copy(input).jsonObject;keys(JsonObject(raw-"fitting"),"wallet","baseId","serverNow","features","acceptingDepartures","home","routes","installation","flight","lodgeCompletedAt","rawStock");raw["fitting"]?.let{EquipmentPolicy.selection(it.jsonObject)}
  CharterGrammar.address(raw.getValue("wallet"));CharterGrammar.id(raw.getValue("baseId"));val now=time(raw,"serverNow");CharterGrammar.bool(raw.getValue("acceptingDepartures"));require(raw.getValue("features")==buildJsonObject{put("starterExpeditions",buildJsonObject{put("version",1);put("receipts",1)})})
  val home=raw.charterOptional("home")?.let{strictPrimitives(it,StarterExpeditionHome.serializer().descriptor);equipmentJson.decodeFromJsonElement<StarterExpeditionHome>(it).also{h->h.validate()}}
  val routes=raw.getValue("routes").jsonArray.map{it.jsonObject};require(if(home==null)routes.isEmpty()else if("fitting" in raw)routes.map{it.charterText("routeId")}.distinct().size==routes.size&&routes.all{it.charterText("routeId") in starterRouteIds&&it["fitting"]!=null}else routes.size==starterRouteIds.size&&routes.map{it.charterText("routeId")}.toSet()==starterRouteIds)
  routes.forEach{if("fitting" in raw)require(equipmentSelection(it.charterObject("fitting"))==raw["fitting"]);val r=starterRoute(it,policy);require(r.access!=null||r.realmId==home?.realmId)}
  val installation=raw.charterOptional("installation")?.let{strictPrimitives(it,StarterFleetInstallation.serializer().descriptor);equipmentJson.decodeFromJsonElement<StarterFleetInstallation>(it).also{i->i.validate();require(i.baseId==raw.charterText("baseId")&&Instant.parse(i.installedAt)<=now)}}
  raw.charterOptional("flight")?.let{f->keys(f,"expeditionId","installationId","route","departedAt","returnsAt","termId","termHash");trip(f,policy);require(f.charterText("installationId")==installation?.installationId&&time(f,"departedAt")<=now&&time(f,"returnsAt")>now)}
  if(raw["lodgeCompletedAt"]!=JsonNull)require(time(raw,"lodgeCompletedAt")<=now)
  val stocks=raw.getValue("rawStock").jsonArray.map{strictPrimitives(it,OrdinaryRawStock.serializer().descriptor);equipmentJson.decodeFromJsonElement<OrdinaryRawStock>(it).also{r->r.validate()}};require(stocks.size==starterResourceRealms.size&&stocks.map{it.resourceId}.toSet()==starterResourceRealms.keys)
  return raw
 }
 fun paidView(input:JsonObject,policy:EquipmentPolicy):JsonObject{val raw=VehicleProtocol.copy(input).jsonObject;val route=raw.charterObject("route");require(route["fitting"]!=null);PaidStarterExpeditionView.from(JsonObject(raw+("route" to policy.original(route))));return raw}
 private fun trip(raw:JsonObject,policy:EquipmentPolicy){for(k in listOf("expeditionId","installationId","termId"))CharterGrammar.id(raw.getValue(k));CharterGrammar.hex(raw.getValue("termHash"),32);val route=raw.charterObject("route");val original=starterRoute(route,policy);require(time(raw,"returnsAt")==time(raw,"departedAt").plusSeconds(CharterGrammar.number(route.getValue("durationSec"))));original.access?.observation?.atDeparture(raw.charterText("departedAt"))}
 fun starterProof(input:JsonObject,identity:StarterIdentity,request:JsonObject,preview:JsonObject,policy:EquipmentPolicy):JsonObject{val raw=VehicleProtocol.copy(input).jsonObject;keys(raw,"wallet","idempotencyKey","serverNow","status","receipt","return");starterRequest(request);starterRoute(preview,policy,true);require(raw.charterText("wallet")==identity.wallet&&raw["idempotencyKey"]==request["idempotencyKey"]);val now=time(raw,"serverNow");val receipt=raw.charterOptional("receipt");val returned=raw.charterOptional("return")
  if(raw.charterText("status")=="unknown"){require(receipt==null&&returned==null);return raw};require(raw.charterText("status")=="accepted");val r=requireNotNull(receipt);keys(r,"wallet","request","expeditionId","installationId","route","departedAt","returnsAt","termId","termHash");require(r.charterText("wallet")==identity.wallet&&r.charterObject("request")==request&&r["expeditionId"]==request["idempotencyKey"]&&r["installationId"]==request["installationId"]);val acceptedRoute=r.charterObject("route");val comparable=if(preview.charterText("routeId").startsWith("paid_"))JsonObject(acceptedRoute+("access" to preview.getValue("access")))else acceptedRoute;require(comparable==preview);trip(r,policy);require(time(r,"departedAt")<=now)
  val route=r.charterObject("route");require(route["routeId"]==request["routeId"]&&route["routeCatalogueVersion"]==request["routeVersion"]&&route["rewardTableVersion"]==request["rewardVersion"]&&equipmentSelection(route.charterObject("fitting"))==request["fitting"])
  starterRoute(route,policy).access?.observation?.let{require(it.wallet==identity.wallet)}
  returned?.let{keys(JsonObject(it-"secondaryOutput"),"returnId","returnedAt");require(it["secondaryOutput"]==route["secondaryOutput"]);CharterGrammar.id(it.getValue("returnId"));require(time(it,"returnedAt") in time(r,"returnsAt")..now)};return raw
 }
 fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?){require(method in setOf("GET","POST")&&'?' !in path&&'#' !in path);body?.let(VehicleProtocol::copy)
  if(method=="GET"){require(body==null)
   if(path in setOf("/ordinary-equipment","/starter-expeditions","/starter-expeditions/paid-route","/vehicles/fleet","/vehicles/client/routes")){
    val allowed=when(path){"/starter-expeditions"->setOf("baseId","fitting","resourceId");"/starter-expeditions/paid-route"->setOf("baseId","realm","fitting","resourceId");"/vehicles/client/routes"->setOf("baseId","policyVersion","fitting","resourceId");"/ordinary-equipment"->setOf("baseId","catalogueVersion");else->setOf("baseId")}
    require(query.keys.all{it in allowed}&&"baseId" in query);CharterGrammar.id(JsonPrimitive(query.getValue("baseId")));query["policyVersion"]?.let{require(it in setOf("1","2"))};query["catalogueVersion"]?.let{require(it=="2")};if(query["fitting"]!=null)EquipmentPolicy.selection(buildJsonObject{put("itemId",query.getValue("fitting"));put("policyVersion",1);query["resourceId"]?.let{put("resourceId",it)}})else require("resourceId" !in query);if(path.endsWith("paid-route"))validatePaidStarterSelection(query.getValue("baseId"),query.getValue("realm"));return}

   require(query.isEmpty());val roots=listOf("/ordinary-equipment/jobs/by-key/","/starter-expeditions/by-key/","/advanced-expeditions/by-key/");val root=roots.singleOrNull{path.startsWith(it)}?:error("Unsupported equipment read");CharterGrammar.id(JsonPrimitive(path.removePrefix(root)));return
  }
  require(query.isEmpty());val value=requireNotNull(body);when(path){"/ordinary-equipment/jobs"->craftRequest(value);"/starter-expeditions"->starterRequest(value);"/advanced-expeditions","/advanced-expeditions/collect"->VehicleProtocol.validateRequest(method,path,query,value);else->error("Unsupported equipment effect")}
 }
}
