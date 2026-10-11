package gg.pixelkingdomwars.nativeclient.keepequipmentmarket

import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*

interface KeepEquipmentMarketPort {
 val identity:StarterIdentity
 suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject
}
class KeepEquipmentMarketTransport(private val port:KeepEquipmentMarketPort) {
 val identity get()=port.identity
 suspend fun request(method:String,path:String,body:JsonObject?=null,guard:()->Unit,query:Map<String,String> = emptyMap(),retain:suspend(JsonObject)->Unit={}):JsonObject {
  val b=body?.let{KeepEquipmentMarketProtocol.copy(it).jsonObject};val q=query.toMap();KeepEquipmentMarketProtocol.request(method,path,q,b);guard()
  val response=port.request(method,path,q,b,guard,{retain(KeepEquipmentMarketProtocol.copy(it).jsonObject)});guard();return KeepEquipmentMarketProtocol.copy(response).jsonObject
 }
}
