package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.serialization.json.*
internal object VehicleFixtures {
 val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-client-vectors.json")).readText()).jsonObject
 val policy=VehiclePolicy.from(vectors.charterObject("constants"));val rows=vectors.getValue("vectors").jsonArray.map{it.jsonObject};val row=rows.first()
 val client=row.charterObject("client");val wire=row.charterObject("wire");val pins=VehicleSigningTrust.from(row.charterObject("trust"));val wallet=VehicleProtocol.actor(client)
 val request=VehicleProtocol.request(client);val base=request.charterText("baseId");val berth=request.charterText("berthId")
 fun identity()=StarterIdentity("https://${UUID.randomUUID()}.test","devnet",wallet)
 class Memory:SecretStore {var value:String?=null;var fail=false;var failRead=false;override fun read():String?{check(!failRead);return value};override fun write(value:String){check(!fail);this.value=value};override fun clear(){error("Originals never cleared")}}
 fun change(o:JsonObject,path:String,value:JsonElement):JsonObject {val p=path.split('.',limit=2);return JsonObject(o+(p[0] to if(p.size==1)value else change(o.charterObject(p[0]),p[1],value)))}
 fun reserved(c:JsonObject=client)=change(change(c,"record.status",JsonPrimitive("reserved")),"record.preparation",JsonNull).let{JsonObject(it+("consentSource" to JsonNull))}
 fun signed(c:JsonObject=client,w:JsonObject=wire)=change(change(c,"record.status",JsonPrimitive("signed")),"record.signed",JsonObject(w.filterKeys{it!="signedTransactionHex"}+("acceptedAt" to JsonPrimitive("2035-01-01T00:00:00.000003Z"))))
 fun terminal(c:JsonObject=client,w:JsonObject=wire):JsonObject {val r=c.charterObject("record");val o=VehicleProtocol.original(c);val initial=c.charterText("kind")=="installation";val result=if(initial)buildJsonObject{put("installationId",o.getValue("reservationId"));for(k in listOf("baseId","berthId","assetId"))put(k,o.charterObject("request").getValue(k));for(k in listOf("family","tier"))put(k,o.charterObject("identity").getValue(k));put("installedWallet",r.getValue("wallet"));put("installedAt","2035-01-01T00:00:00.000004Z");put("signature",w.getValue("signature"))}else JsonObject(policy.serviceEffect(o.charterObject("state")).filterKeys{it in listOf("tierAfter","revisionAfter","completedTotal","allowanceStartAfter","remainingUses")}+mapOf("appliedAt" to JsonPrimitive("2035-01-01T00:00:00.000004Z"),"signature" to w.getValue("signature")))
  val end=change(change(c,"record.status",JsonPrimitive(if(initial)"installed" else "applied")),"record.${if(initial)"installation" else "application"}",result)
  return JsonObject(end+("burnReceipt" to buildJsonObject{for(k in listOf("signature","messageSha256","wireSha256"))put(k,w.getValue(k));put("slot",101);put("finalizedThroughSlot",102);put("feeLamports","5000");put("assetRefundLamports","1234")}))
 }
 fun review(c:JsonObject=client)=buildJsonObject{put("version",1);put("reference",VehicleProtocol.reference(c));put("wallet",VehicleProtocol.actor(c));put("reviewedAt","2035-01-01T00:00:00.000Z");put("expiresAt","2035-01-01T00:00:30.000Z");put("status","ready");put("reason",JsonNull);put("messageSha256",c.charterObject("record").charterObject("preparation").getValue("messageSha256"));for(k in listOf("signingAuthorized","broadcastAuthorized","reservationReleaseAuthorized"))put(k,false);put("observation",buildJsonObject{val p=c.charterObject("record").charterObject("preparation");put("genesisHash",pins.toJson().charterObject("core").getValue("expectedGenesisHash"));put("core",JsonObject(pins.toJson().charterObject("core")-"expectedGenesisHash"));put("ownerWallet",wallet);for(k in listOf("ownerSlot","feeSlot","balanceSlot","validitySlot","closingSlot"))put(k,p.getValue("blockhashContextSlot"));put("blockhash",p.getValue("blockhash"));put("lastValidBlockHeight",p.getValue("lastValidBlockHeight"));put("currentBlockHeight",1);put("blockhashValid",true);put("networkFeeLamports","5000");put("payerLamports","1000000")})}
}
