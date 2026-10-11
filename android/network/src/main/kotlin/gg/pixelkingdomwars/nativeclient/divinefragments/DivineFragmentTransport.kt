package gg.pixelkingdomwars.nativeclient.divinefragments
import gg.pixelkingdomwars.nativeclient.charter.CharterHttpPort
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*
interface DivineFragmentPort {
 val identity:StarterIdentity
 suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject
}
class DivineFragmentHttpPort(private val port:CharterHttpPort):DivineFragmentPort {
 override val identity get()=port.identity
 override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit)=port.fragmentRequest(method,path,query,body,guard,retain)
}
class DivineFragmentTransport(private val port:DivineFragmentPort) {
 val identity get()=port.identity
 suspend fun request(method:String,path:String,body:JsonObject?,guard:()->Unit,query:Map<String,String> = emptyMap(),retain:suspend(JsonObject)->Unit = {}):JsonObject {
  val q=query.toMap();val b=body?.let{DivineFragmentProtocol.copy(it).jsonObject};DivineFragmentProtocol.request(method,path,q,b);guard()
  return port.request(method,path,q,b,guard){retain(DivineFragmentProtocol.copy(it).jsonObject)}.also{guard()}
 }
}
