package gg.pixelkingdomwars.nativeclient.tournament
import gg.pixelkingdomwars.nativeclient.charter.CharterHttpPort
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.serialization.json.*
interface TournamentPort {
 val identity:StarterIdentity
 suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit):JsonElement
}
class TournamentHttpPort(private val port:CharterHttpPort):TournamentPort {
 override val identity get()=port.identity
 override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit)=port.tournamentRequest(method,path,query,body,guard,retain)
}
class TournamentTransport(private val port:TournamentPort) {
 val identity get()=port.identity
 suspend fun request(method:String,path:String,body:JsonObject?,guard:()->Unit,query:Map<String,String> = emptyMap(),retain:suspend (JsonElement)->Unit):JsonElement {
  validateTournamentRequest(method,path,query,body)
  val result=port.request(method,path,query,body,guard){retain(TournamentProtocol.copy(it))}
  guard();return result
 }
}
