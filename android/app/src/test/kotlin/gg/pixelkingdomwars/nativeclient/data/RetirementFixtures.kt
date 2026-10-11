package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.retirement.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.serialization.json.*
internal object RetirementFixtures {
 val vector=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterRetirement.json")).readText()).jsonObject
 val draft=RetirementProtocol.draft(vector.charterObject("draft"));val op=draft.charterObject("operation");val actor=draft.charterText("actor");val key=draft.charterObject("request").charterText("idempotencyKey");val clan=draft.charterObject("clan").charterText("id")
 val pins=CharterSigningTrust.from(vector.charterObject("trust"));val crypto=CharterFixtures.crypto
 val bytes=vector.charterText("wireHex").chunked(2).map{it.toInt(16).toByte()}.toByteArray()
 fun identity()=StarterIdentity("https://${UUID.randomUUID()}.test","devnet",actor)
 suspend fun wire():JsonObject{val p=RetirementTransaction.prepare(op,pins,actor,crypto);return RetirementTransaction.toWire(p,p.verifySigned(bytes))}
 fun review()=RetirementReview(op,pins.toJson(),charterCryptoJson(crypto))
 fun unpaid()=JsonObject(draft+mapOf("memberPayment" to JsonNull,"operation" to JsonNull))
 suspend fun status(status:String):JsonObject {val p=when(status){"cleared"->JsonObject(op+mapOf("status" to JsonPrimitive(status),"attempt" to JsonNull,"preparation" to JsonNull));"signed","completed"->JsonObject(op+mapOf("status" to JsonPrimitive(status),"signed" to wire(),"terminal" to if(status=="completed")buildJsonObject{put("id","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");put("outcome","completed")} else JsonNull));else->op};return JsonObject(draft+("operation" to p))}
 suspend fun saved(s:RetirementStore){s.begin(key,clan);s.observe(key,draft);s.accept(key,draft)}
}
