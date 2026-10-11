package gg.pixelkingdomwars.nativeclient.charter
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*

interface CharterPort {
 val identity:StarterIdentity
 suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonObject)->Unit):JsonObject
}
/** Only the authenticated original actor may be retained. These callbacks run before
 * a stale view/session guard. Parsed data still grants no signing or send authority. */
class CharterTransport(private val port:CharterPort) {
 val identity get()=port.identity
 suspend fun activity(cursor:String?,guard:()->Unit):CharterActivity {
  var result:CharterActivity?=null
  port.request("GET","/clans/charter/client/activity",cursor?.let{mapOf("cursor" to it)}?:emptyMap(),null,guard) {raw->
   require(raw.charterText("actor")==identity.wallet); result=CharterActivity.from(raw)
  }
  guard();return requireNotNull(result)
 }
 suspend fun request(method:String,path:String,body:JsonObject?,guard:()->Unit,retain:suspend (JsonObject)->Unit) {
  validateCharterRequest(method,path,emptyMap(),body)
  port.request(method,path,emptyMap(),body,guard) {raw->
   require(raw.charterText("actor")==identity.wallet);retain(CharterGrammar.copy(raw).jsonObject)
  }
  guard()
 }
}
