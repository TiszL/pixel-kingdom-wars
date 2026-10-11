package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.*
import java.util.UUID
import kotlinx.serialization.json.*
internal object EquipmentFixtures {
 val raw=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-equipment.json")).readText()).jsonObject
 val policy=EquipmentPolicy.from(raw.charterObject("policy"));val request=EquipmentGrammar.craftRequest(raw.charterObject("request"));val view=EquipmentView.from(raw.charterObject("view"));val recipe=view.recipes.single();val command=EquipmentCommand(request,recipe)
 val vehicle=VehiclePolicy.from(JsonObject(VehicleFixtures.policy.raw+("ordinaryEquipment" to policy.raw)))
 val base=request.baseId;val wallet=view.wallet;val installation=raw.charterObject("starterView").charterObject("installation").charterText("installationId")
 fun identity()=StarterIdentity("https://${UUID.randomUUID()}.test","devnet",wallet)
 class Memory:SecretStore{var value:String?=null;var fail=false;override fun read()=value;override fun write(value:String){check(!fail);this.value=value};override fun clear(){error("Never erase originals")}}
 fun change(o:JsonObject,path:String,value:JsonElement):JsonObject{val p=path.split('.',limit=2);return JsonObject(o+(p[0] to if(p.size==1)value else change(o.charterObject(p[0]),p[1],value)))}
 fun readyView(compasses:String="1")=JsonObject(raw.charterObject("view")+mapOf("pendingJobs" to JsonArray(emptyList()),"equipmentStock" to JsonArray(listOf(buildJsonObject{put("itemId","route_compass");put("available",compasses);put("reserved","0");put("pendingOutput","0")})),"craftingStock" to JsonArray(raw.charterObject("view").getValue("craftingStock").jsonArray.map{JsonObject(it.jsonObject+("available" to JsonPrimitive("100")))})))
 fun record(kind:String="craft",key:String=request.idempotencyKey):EquipmentRecord{if(kind=="craft")return EquipmentRecord(kind,key,JsonObject(request.body()+("idempotencyKey" to JsonPrimitive(key))),policy.raw,recipe=recipe)
  val receipt=raw.charterObject(if(kind=="starter")"starterEnvelope"else "advancedEnvelope").charterObject("receipt");return EquipmentRecord(kind,key,JsonObject(receipt.charterObject("request")+("idempotencyKey" to JsonPrimitive(key))),policy.raw,preview=receipt.charterObject("route"),vehiclePolicy=if(kind=="advanced")vehicle.raw else null)}
 fun proof(r:EquipmentRecord):JsonObject{val template=raw.charterObject(when(r.kind){"craft"->"envelope";"starter"->"starterEnvelope";else->"advancedEnvelope"});val receipt=JsonObject(template.charterObject("receipt")+mapOf("request" to r.request,(if(r.kind=="craft")"jobId"else "expeditionId") to JsonPrimitive(r.key)));return JsonObject(template+mapOf("idempotencyKey" to JsonPrimitive(r.key),"receipt" to receipt))}
 fun unknown(r:EquipmentRecord)=buildJsonObject{put("wallet",wallet);put("idempotencyKey",r.key);put("serverNow","2035-01-01T00:00:00.000Z");put("status","unknown");put("receipt",JsonNull);put(if(r.kind=="craft")"completion"else "return",JsonNull)}
 fun complete(r:EquipmentRecord):JsonObject{val original=proof(r);val receipt=original.charterObject("receipt");val deadline=receipt.getValue(if(r.kind=="craft")"readyAt"else "returnsAt");return JsonObject(original+mapOf("serverNow" to deadline,(if(r.kind=="craft")"completion"else "return") to if(r.kind=="craft")buildJsonObject{put("completedAt",deadline)}else buildJsonObject{put("returnId",UUID.randomUUID().toString());put("returnedAt",deadline);if(r.kind=="advanced")put("completedTotal","1")}))}
 fun fleet()=buildJsonObject{put("version",1);put("wallet",wallet);put("baseId",base);put("serverNow","2035-01-01T00:00:00.000Z");put("acceptingNewActions",true);put("vehicles",buildJsonArray{add(buildJsonObject{put("installationId",installation);put("berthId","00000000-0000-4000-8000-000000000005");put("family","survey_balloon");put("tier",1);put("revision",0);put("completedTotal","0");put("allowanceStart","0");put("remainingUses",vehicle.completedUses);put("away",false);put("pendingService",false)})})}
}
