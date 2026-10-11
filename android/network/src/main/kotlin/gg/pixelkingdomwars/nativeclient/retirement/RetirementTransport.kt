package gg.pixelkingdomwars.nativeclient.retirement

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*

interface RetirementPort {
 val identity:StarterIdentity
 suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit):JsonElement
}
class RetirementHttpPort(private val port:CharterHttpPort):RetirementPort {
 override val identity get()=port.identity
 override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit)=port.retirementRequest(method,path,query,body,guard,retain)
}
/** A captured actor owns the response before cancellation/current-view checks.
 * Original IDs and creation requests cannot be rebound by a server response. */
class RetirementTransport(private val port:RetirementPort) {
 val identity get()=port.identity
 suspend fun request(method:String,path:String,body:JsonObject?,guard:()->Unit,query:Map<String,String> = emptyMap(),retain:suspend (JsonElement)->Unit):JsonElement {
  val frozen=body?.let{RetirementProtocol.copy(it).jsonObject};val q=query.toMap();validateRetirementRequest(method,path,q,frozen)
  val result=port.request(method,path,q,frozen,guard){raw->
   val value=RetirementProtocol.copy(raw).jsonObject
   val byKey=path.startsWith(RetirementProtocol.ROOT+"/by-key/")
   if(byKey){
    val key=path.substringAfterLast('/');require(value.charterText("actor")==identity.wallet&&value.charterText("idempotencyKey")==key)
    value.charterOptional("draft")?.let{require(it.charterText("actor")==identity.wallet&&it.charterObject("request").charterText("idempotencyKey")==key)}
   }else{
    require(value.charterText("actor")==identity.wallet)
    if(path==RetirementProtocol.ROOT)require(value["request"]==frozen)
    else require(value.charterText("id")==path.removePrefix(RetirementProtocol.ROOT+"/").substringBefore('/'))
   }
   // Own bounded evidence before semantic checks: a damaged terminal claim
   // must reach the durable journal's hold, never disappear as a retryable read.
   retain(value)
   if(byKey)RetirementProtocol.byKey(value,identity.wallet,path.substringAfterLast('/')) else RetirementProtocol.draft(value)
  }
  guard();return result
 }
}
