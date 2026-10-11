package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.UUID
import kotlinx.serialization.json.*
object DivineTrialFixtures {
 val vector=Json.parseToJsonElement(javaClass.classLoader!!.getResource("divine-trial-vectors.json")!!.readText()).jsonObject
 val rules=DivineRules.installed(vector.dobj("policy"),vector.dobj("validationConstants"));val event=vector.dobj("event");val entry=vector.dobj("entry");val complete=vector.drows("plans").first().dobj("attempt");val wallet=entry.dt("wallet");val base=entry.dt("baseId")
 fun identity()=StarterIdentity("https://${UUID.randomUUID()}.test","devnet",wallet)
 fun change(o:JsonObject,k:String,v:JsonElement)=JsonObject(o+(k to v))
 val admitted=JsonObject(complete+mapOf("status" to JsonPrimitive("admitted"),"orders" to JsonNull,"result" to JsonNull,"completedAt" to JsonNull))
 val committed=JsonObject(complete+mapOf("status" to JsonPrimitive("committed"),"result" to JsonNull,"completedAt" to JsonNull))
 fun participant(e:JsonObject?=entry,attempts:List<JsonObject> = emptyList(),prize:JsonObject?=null)=buildJsonObject{put("version",1);put("eventId",event.getValue("id"));put("wallet",wallet);put("entry",e?:JsonNull);put("attempts",JsonArray(attempts));put("prize",prize?:JsonNull)}
 class Memory(var value:String?=null):SecretStore{var fail=false;override fun read()=value;override fun write(value:String){check(!fail){"Disk unavailable"};this.value=value};override fun clear(){error("Never clear originals")}}
}
