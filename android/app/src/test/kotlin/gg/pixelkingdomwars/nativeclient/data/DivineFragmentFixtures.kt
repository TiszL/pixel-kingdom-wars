package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.UUID
import kotlinx.serialization.json.*
object DivineFragmentFixtures {
 val raw=Json.parseToJsonElement(javaClass.classLoader!!.getResource("divine-fragment-vectors.json")!!.readText()).jsonObject
 val rules=DivineFragmentRules.from(raw.fo("rules"));val award=raw.fo("award");val base=raw.fo("delivery").ft("baseId");val wallet=award.ft("wallet")
 fun id(n:Int)="00000000-0000-4000-8000-${n.toString().padStart(12,'0')}"
 fun identity()=StarterIdentity("https://${UUID.randomUUID()}.example","devnet",wallet)
 class Memory(var value:String?=null):SecretStore{var fail=false;override fun read()=value;override fun write(value:String){check(!fail){"Storage unavailable"};this.value=value};override fun clear(){error("Never clear fragments")}}
 fun command(kind:String="delivery",key:String=id(3)):DivineFragmentCommand {val consent=raw.fo(if(kind=="delivery")"consent" else "claimConsent");return DivineFragmentCommand(kind,JsonObject(consent+("request" to JsonObject(consent.fo("request")+("idempotencyKey" to JsonPrimitive(key))))),rules.raw,if(kind=="claim")award.ft("termHash")else null)}
 fun receipt(c:DivineFragmentCommand)=JsonObject(raw.fo(if(c.kind=="delivery")"delivery" else "claim")+c.consent.fo("request"))
 fun page(rows:List<JsonObject>,next:String?=null)=buildJsonObject{put("version",1);put("wallet",wallet);put("rows",JsonArray(rows));put("nextCursor",next?.let(::JsonPrimitive)?:JsonNull)}
}
