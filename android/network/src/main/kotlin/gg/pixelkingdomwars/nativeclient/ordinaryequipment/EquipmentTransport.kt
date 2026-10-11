package gg.pixelkingdomwars.nativeclient.ordinaryequipment
import gg.pixelkingdomwars.nativeclient.charter.CharterHttpPort
import gg.pixelkingdomwars.nativeclient.fleetjourney.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import kotlinx.serialization.json.*
interface EquipmentPort {val identity:StarterIdentity;suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit,refusal:suspend(ApiException)->Unit = {}):JsonObject
 suspend fun requestWithDeparture(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
  retain:suspend(JsonObject)->Unit,refusal:suspend(ApiException)->Unit,created:(FreshFleetDeparture)->Unit):JsonObject = request(method,path,query,body,guard,retain,refusal)
}
class EquipmentHttpPort(private val source:CharterHttpPort):EquipmentPort {override val identity get()=source.identity;override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit,refusal:suspend(ApiException)->Unit)=source.equipmentRequest(method,path,query,body,guard,retain,refusal)
 override suspend fun requestWithDeparture(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
  retain:suspend(JsonObject)->Unit,refusal:suspend(ApiException)->Unit,created:(FreshFleetDeparture)->Unit)=source.equipmentRequestWithDeparture(method,path,query,body,guard,retain,refusal,created)
}
class EquipmentTransport(private val port:EquipmentPort, private val captureDeparture:FleetDepartureCapture = { _, _ -> null }){val identity get()=port.identity
 suspend fun request(method:String,path:String,body:JsonObject?=null,guard:()->Unit,query:Map<String,String> = emptyMap(),refusal:suspend(ApiException)->Unit={},retain:suspend(JsonObject)->Unit={}):JsonObject {
  val b=body?.let{VehicleProtocol.copy(it).jsonObject};val q=query.toMap();EquipmentGrammar.request(method,path,q,b);guard()
  val observer=captureFleetDeparture(captureDeparture,method,path,b,guard)
  var departure:FreshFleetDeparture?=null
  val result=port.requestWithDeparture(method,path,q,b,guard,{retain(VehicleProtocol.copy(it).jsonObject)},refusal,{departure=it})
  guard();val owned=VehicleProtocol.copy(result).jsonObject
  deliverFleetDeparture(departure?.takeIf{it.original==owned},guard,observer)
  return owned
 }
}
