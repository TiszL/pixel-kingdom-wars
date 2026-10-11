package gg.pixelkingdomwars.nativeclient.migration

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*

interface MigrationPort {
 val identity:StarterIdentity
 suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit):JsonElement
}
class MigrationHttpPort(private val port:CharterHttpPort):MigrationPort {
 override val identity get()=port.identity
 override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit)=port.migrationRequest(method,path,query,body,guard,retain)
}
/** Own matching bounded evidence before semantic checks so malformed terminal claims
 * reach the durable journal. A foreign actor, original or request never reaches it. */
class MigrationTransport(private val port:MigrationPort) {
 val identity get()=port.identity
 suspend fun request(method:String,path:String,body:JsonObject?,guard:()->Unit,query:Map<String,String> = emptyMap(),retain:suspend (JsonElement)->Unit):JsonElement {
  val frozen=body?.let{MigrationProtocol.copy(it).jsonObject};val q=query.toMap();validateMigrationRequest(method,path,q,frozen)
  val result=port.request(method,path,q,frozen,guard){raw->
   val value=MigrationProtocol.copy(raw).jsonObject;val byKey=path.startsWith(MigrationProtocol.ROOT+"/by-key/");val activity=path==MigrationProtocol.ROOT+"/activity"
   require(value.charterText("actor")==identity.wallet)
   if(byKey){
    val key=path.substringAfterLast('/');require(value.charterText("idempotencyKey")==key)
    value.charterOptional("migration")?.let{require(it.charterText("actor")==identity.wallet&&it.charterObject("request").charterText("idempotencyKey")==key)}
   }else if(path==MigrationProtocol.ROOT)require(value["request"]==frozen)
   else if(!activity)require(value.charterText("id")==path.removePrefix(MigrationProtocol.ROOT+"/").substringBefore('/'))
   retain(value)
   if(activity)MigrationProtocol.activity(value) else if(byKey)MigrationProtocol.byKey(value,identity.wallet,path.substringAfterLast('/')) else MigrationProtocol.migration(value)
  }
  guard();return result
 }
}
