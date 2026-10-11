package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.migration.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.serialization.json.*
internal object MigrationFixtures {
 val vector=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterMigrationHttpPair.json")).readText()).jsonObject
 val prepared=MigrationProtocol.migration(vector.charterObject("preparedMigration"));val actor=prepared.charterText("actor");val key=prepared.charterObject("request").charterText("idempotencyKey");val clan=prepared.charterObject("request").charterText("clanId");val id=prepared.charterText("id")
 val pins=CharterSigningTrust.from(vector.charterObject("trust"));val crypto=CharterFixtures.crypto;val wire=vector.charterObject("signedMigration").charterObject("wire");val bytes=java.util.Base64.getDecoder().decode(wire.charterText("signedTransaction"))
 fun identity()=StarterIdentity("https://${UUID.randomUUID()}.test","devnet",actor)
 fun review()=MigrationReview(prepared,pins.toJson(),charterCryptoJson(crypto))
 fun status(status:String)=JsonObject(prepared+mapOf("status" to JsonPrimitive(status),"signing" to if(status in listOf("pending","issuing"))JsonNull else prepared.getValue("signing"),"wire" to if(status in listOf("signed","controlled"))wire else JsonNull,"terminal" to if(status in listOf("controlled","cancelled"))buildJsonObject{put("id","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");put("outcome",status)} else JsonNull))
 fun activity(current:Boolean=true)=buildJsonObject{put("version",1);put("actor",actor);put("newActions",current);put("currentClan",if(current)JsonObject(prepared.charterObject("snapshot").charterObject("clan")+mapOf("authority" to JsonPrimitive("legacy"),"migrationId" to JsonNull)) else JsonNull);put("items",buildJsonArray{})}
 suspend fun saved(s:MigrationStore){s.begin(key,clan);s.observe(key,prepared);s.accept(key,prepared)}
}
