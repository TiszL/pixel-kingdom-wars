package gg.pixelkingdomwars.nativeclient.vehicle

import gg.pixelkingdomwars.nativeclient.charter.CharterHttpPort
import gg.pixelkingdomwars.nativeclient.fleetjourney.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*

interface VehiclePort {
 val identity:StarterIdentity
 suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonObject)->Unit):JsonObject
 suspend fun requestWithDeparture(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
  retain:suspend (JsonObject)->Unit,created:(FreshFleetDeparture)->Unit):JsonObject = request(method,path,query,body,guard,retain)
}
class VehicleHttpPort(private val source:CharterHttpPort):VehiclePort {
 override val identity get()=source.identity
 override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonObject)->Unit)=source.vehicleRequest(method,path,query,body,guard,retain)
 override suspend fun requestWithDeparture(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,
  retain:suspend (JsonObject)->Unit,created:(FreshFleetDeparture)->Unit)=source.vehicleRequestWithDeparture(method,path,query,body,guard,retain,created)
}
class VehicleTransport(private val port:VehiclePort, private val captureDeparture:FleetDepartureCapture = { _, _ -> null }) {
 val identity get()=port.identity
 suspend fun request(method:String,path:String,body:JsonObject?=null,guard:()->Unit,query:Map<String,String> = emptyMap(),retain:suspend (JsonObject)->Unit={}):JsonObject {
  val q=query.toMap();val b=body?.let{VehicleProtocol.copy(it).jsonObject};VehicleProtocol.validateRequest(method,path,q,b);guard()
  val observer=captureFleetDeparture(captureDeparture,method,path,b,guard)
  var departure:FreshFleetDeparture?=null
  val result=port.requestWithDeparture(method,path,q,b,guard,{retain(VehicleProtocol.copy(it).jsonObject)},{departure=it})
  guard();val owned=VehicleProtocol.copy(result).jsonObject
  deliverFleetDeparture(departure?.takeIf{it.original==owned},guard,observer)
  return owned
 }
}
