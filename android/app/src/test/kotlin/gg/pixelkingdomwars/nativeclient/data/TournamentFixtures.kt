package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.tournament.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.serialization.json.*
internal object TournamentFixtures {
 val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterTournamentSigning.json")).readText()).jsonObject
 val row=vectors.getValue("rows").jsonArray[0].jsonObject
 val operation=TournamentProtocol.operation(row.charterObject("operation"))
 val leader=row.charterText("leader");val event=operation.charterObject("operationTerms").charterObject("event")
 val eventId=event.charterText("id");val operationId=operation.charterObject("original").charterObject("operation").charterText("id")
 val pins=CharterSigningTrust.from(row.charterObject("trust"));val crypto=CharterFixtures.crypto
 val policy=event.charterObject("policy")
 val wire=row.charterObject("wire")
 val entry=buildJsonObject{put("version",1);put("id",operation.getValue("entryId"));for(k in listOf("eventId","clanId","leader","epochId","lockId","roster"))put(k,operation.charterObject("operationTerms").getValue(k));put("status","pending");put("set",operation);put("clear",JsonNull)}
 fun identity()=StarterIdentity("https://${UUID.randomUUID()}.test","devnet",leader)
 class Memory:SecretStore {var value:String?=null;var fail=false;var failRead=false;override fun read():String?{check(!failRead);return value};override fun write(value:String){check(!fail);this.value=value};override fun clear(){error("Never clear tournament originals")}}
 fun review()=TournamentReview(operation,pins.toJson(),charterCryptoJson(crypto),policy)
 val catalogue:JsonObject get(){return buildJsonObject{put("constants",buildJsonObject{
  put("PHASE_E_CHARTER_TOURNAMENT",JsonObject(policy-setOf("rosterCap","freeRaidsPerBaseDay","fragments","prizeSource","prizeItems")))
  put("CLANS",buildJsonObject{put("nameMinLen",3);put("nameMaxLen",24);put("tagMinLen",2);put("tagMaxLen",5);put("createCostShards",5000);put("rosterCap",policy.getValue("rosterCap"))})
  put("RAID_ENERGY",buildJsonObject{put("freePerDay",policy.getValue("freeRaidsPerBaseDay"))});put("PHASE_E_POLICY",buildJsonObject{put("basisPoints",crypto.basisPoints)})
  put("PHASE_E_CHARTER_PREPARATION",buildJsonObject{put("computeUnitLimit",crypto.computeUnitLimit);put("coreCreateFeeLamports",crypto.coreCreateFeeLamports.toLong())})
  put("PHASE_E_CHARTER_TRANSFER",buildJsonObject{put("royaltyBps",crypto.royaltyBps)})
  put("PHASE_E_CHARTER_ADMISSION",buildJsonObject{put("v1",buildJsonObject{put("issuedPermitTtlSec",crypto.issuedPermitTtlSec);put("observationMaxAgeMs",15000)})})
  put("PHASE_E_SEEKER_AUCTION",buildJsonObject{put("maxPolicyPermitTtlSec",crypto.maxPolicyPermitTtlSec)})
 })}}
}
