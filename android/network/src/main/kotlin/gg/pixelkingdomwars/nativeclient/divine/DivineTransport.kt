package gg.pixelkingdomwars.nativeclient.divine
import gg.pixelkingdomwars.nativeclient.charter.CharterHttpPort
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*
interface DivinePort {
 val identity:StarterIdentity
 suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject
}
class DivineHttpPort(private val port:CharterHttpPort):DivinePort {
 override val identity get()=port.identity
 override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit)=port.divineRequest(method,path,query,body,guard,retain)
}
class DivineTransport(private val port:DivinePort) {
 val identity get()=port.identity
 suspend fun request(method:String,path:String,body:JsonObject?,guard:()->Unit,query:Map<String,String> = emptyMap(),retain:suspend(JsonObject)->Unit = {}):JsonObject {
  val frozen=body?.let{DivineGrammar.copy(it).jsonObject};DivineGrammar.request(method,path,query,frozen)
  return port.request(method,path,query.toMap(),frozen,guard){retain(DivineGrammar.copy(it,true).jsonObject)}.also{guard()}
 }
}
