package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.tournament.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class TournamentAppPortsTest {
 private val f=TournamentFixtures
 @Test fun `missing canonical tournament content keeps fresh operations unavailable`() {assertNull(tournamentPolicy(null));assertNull(tournamentPolicy(buildJsonObject{put("constants",buildJsonObject{})}))}
 @Test fun `numeric rules and symbolic prize items match canonical event terms`() {assertEquals(f.policy,tournamentPolicy(f.catalogue));validateTournamentPolicy(f.operation,requireNotNull(tournamentPolicy(f.catalogue)))}
 @Test fun `schedule roster and prize source changes never become signing authority`() {
  val t=f.operation.charterObject("operationTerms");val e=t.charterObject("event");val changed=JsonObject(f.operation+("operationTerms" to JsonObject(t+("event" to JsonObject(e+("playEndsAt" to JsonPrimitive("2026-10-06T00:00:00.000Z")))))))
  assertThrows(Exception::class.java){validateTournamentPolicy(changed,f.policy)}
  assertThrows(Exception::class.java){validateTournamentPolicy(f.operation,JsonObject(f.policy+("raidsPerWallet" to JsonPrimitive(99))))}
 }

 @Test fun `tournament live gate passes the original quote height and closing slot to reviewed RPC guard`()=runBlocking {
  val identity=f.identity();var captured:JsonObject?=null;var configured=f.catalogue;var selected:String?=f.eventId
  val ordinary=object:CharterPorts {
   override val transport=CharterTransport(object:CharterPort{override val identity=identity;override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonObject)->Unit):JsonObject=error("No HTTP here")})
   override fun capture(newAction:Boolean):()->Unit={}
   override fun policy()=CharterFixtures.protocol
   override fun cryptoPolicy()=f.crypto
   override fun trust()=f.pins
   override fun key()="unused"
   override suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit):()->Unit{captured=signing;guard();return guard}
   override suspend fun hydrate(guard:()->Unit)=guard()
   override suspend fun ready(guard:()->Unit)=guard()
   override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend (SignedCharter)->Unit)=error("No wallet here")
  }
  val transport=TournamentTransport(object:TournamentPort{override val identity=identity;override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend (JsonElement)->Unit):JsonElement=error("No HTTP here")})
  val ports=TournamentAppPorts(ordinary,transport,{configured},{selected}){_,_,_->};val guard=ports.capture(true);val p=TournamentTransaction.prepare(f.operation,f.pins,f.leader,f.crypto);ports.live(p,f.operation,guard)()
  val q=f.operation.charterObject("attempt").charterObject("quote");assertEquals(q["context"],captured?.get("context"));assertEquals(q.charterObject("packetInput")["lastValidBlockHeight"],captured?.get("lastValidBlockHeight"))
  ports.requireBase(f.eventId);selected=null;assertThrows(Exception::class.java){ports.requireBase(f.eventId)}
  configured=buildJsonObject{put("constants",buildJsonObject{})};assertThrows(Exception::class.java){guard()};ports.capture(false)();Unit
 }
}
