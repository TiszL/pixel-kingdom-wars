package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.math.BigInteger
import java.util.UUID
import kotlinx.serialization.json.*

internal object CharterFixtures {
    val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterClient.json")).readText()).jsonObject
    val row=vectors.getValue("rows").jsonArray[0].jsonObject
    val pins=CharterSigningTrust.from(vectors.charterObject("trust"))
    // Explicit test authority sourced from canonical shared constants; never app defaults.
    val protocol=CharterProtocolPolicy(3,24,2,5,"5000",500,10000,"1500000")
    val crypto=CharterCryptoPolicy(400000,600,540,"1500000",500,10000)
    fun envelope(kind:String="creation",buyer:Boolean=false):CharterEnvelope {
        val s=row.charterObject(kind);val base=vectors.charterObject("envelopes").charterObject(if(kind=="creation")"creation" else if(buyer)"saleBuyer" else "saleSeller")
        val original=s.charterObject("original");val actor=if(kind=="creation")original.charterText("payer") else original.charterObject("terms").charterText(if(buyer)"buyer" else "seller")
        val key=if(kind=="creation")original.charterText("creationIntentId") else original.charterObject("terms").charterText("id")
        val old=base.charterObject("state");val state=if(kind=="creation") {
            val metadata=original.charterObject("metadata");val clan=JsonObject(old.charterObject("original").charterObject("clan")+("name" to metadata.getValue("name")))
            val request=JsonObject(old.charterObject("request")+mapOf("creationIntentId" to JsonPrimitive(key),"name" to metadata.getValue("name")))
            val source=JsonObject(old.charterObject("original")+mapOf("clanId" to original.getValue("clanId"),"metadata" to metadata,"clan" to clan))
            val candidate=s.charterObject("policy").charterText("candidateHex");val expiry=BigInteger(1,candidate.substring(242,258).chunked(2).map{it.toInt(16).toByte()}.reversed().toByteArray()).toString()
            JsonObject(old+mapOf("wallet" to JsonPrimitive(actor),"creationIntentId" to JsonPrimitive(key),"request" to request,"original" to source,
                "policy" to buildJsonObject{put("permitId",candidate.substring(146,178));put("expiry",expiry);put("signer",s.charterObject("policy").charterText("signer"))},
                "preparation" to buildJsonObject{put("attemptId",s.getValue("attemptId"));put("packet",s.getValue("packet"));put("blockhash",s.getValue("blockhash"));put("lastValidBlockHeight",s.getValue("lastValidBlockHeight"));put("costs",JsonObject(s.charterObject("costs")-"allocations"))}))
        } else {
            val terms=original.charterObject("terms");val source=JsonObject(listOf("clanId","seller","buyer","priceLamports","sellerLeaves","expectedRevision").associateWith{terms.getValue(it)}+("termsHash" to original.getValue("termsHash")))
            JsonObject(old+mapOf("id" to JsonPrimitive(key),"original" to source,"preparation" to buildJsonObject{put("packet",s.getValue("packet"));put("costs",JsonObject(s.charterObject("costs")-"allocations"))}))
        }
        return CharterEnvelope.from(JsonObject(base+mapOf("actor" to JsonPrimitive(actor),"key" to JsonPrimitive(key),"state" to state,"signing" to s)))
    }
    fun status(e:CharterEnvelope,status:String,prepared:Boolean=true,wire:JsonObject?=null,contributions:List<JsonObject> = emptyList(),terminal:JsonObject?=null):CharterEnvelope {
        val state=JsonObject(e.state+mapOf("status" to JsonPrimitive(status),"preparation" to if(prepared)e.state.getValue("preparation") else JsonNull,"policy" to (e.state["policy"]?:JsonNull)).filterKeys{it!="policy"||e.kind=="creation"}+
            mapOf("signed" to (wire?.let{if(e.kind=="creation")JsonObject(it-"signedTransaction"+("acceptedAt" to JsonPrimitive("2026-09-28T00:00:00Z"))) else JsonObject(it-"signedTransaction")}?:JsonNull),"terminal" to (terminal?:JsonNull)))
        return CharterEnvelope.from(JsonObject(e.raw+mapOf("state" to state,"signing" to if(prepared)e.raw.getValue("signing") else JsonNull,"wire" to (wire?:JsonNull),"contributions" to JsonArray(contributions))))
    }
    fun activity(actor:String)=buildJsonObject{put("version",1);put("actor",actor);put("newActions",buildJsonObject{put("creation",true);put("sale",true)});put("items",JsonArray(emptyList()));put("nextCursor",JsonNull)}
    fun context(e:CharterEnvelope)=CharterReviewContext(requireNotNull(e.signing),pins.toJson(),protocol.toJson(),charterCryptoJson(crypto))
    class Memory:SecretStore {var value:String?=null;var fail=false;var failRead=false;override fun read():String? {check(!failRead){"Read unavailable"};return value};override fun write(value:String){check(!fail){"Storage unavailable"};this.value=value};override fun clear(){error("Never clear Charter history")}}
    fun identity(actor:String)=StarterIdentity("https://${UUID.randomUUID()}.test","devnet",actor)
}
