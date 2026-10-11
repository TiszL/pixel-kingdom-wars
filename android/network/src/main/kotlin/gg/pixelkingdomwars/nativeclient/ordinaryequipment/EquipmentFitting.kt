package gg.pixelkingdomwars.nativeclient.ordinaryequipment
import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.json.*
val equipmentResourceIds=setOf("frost_quartz","heartwood_logs","sunstone_rubble","crown_iron_ore","rough_prism","storm_ore","thorn_fibre","ember_nodules")
/** Additive historical DTOs; current admission still requires installed policy. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EquipmentFitting(val itemId:String,val policyVersion:Int,@EncodeDefault(EncodeDefault.Mode.NEVER) val resourceId:String?=null){fun validate(){EquipmentPolicy.selection(equipmentJson.encodeToJsonElement(serializer(),this).jsonObject)}}
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EquipmentFittingSnapshot(val itemId:String,val policyVersion:Int,val originalDurationSec:Long,
 val originalGrossQuantity:String,val originalNetQuantity:String,val originalIslandPoolQuantity:String,@EncodeDefault(EncodeDefault.Mode.NEVER) val resourceId:String?=null){
 fun selection()=EquipmentFitting(itemId,policyVersion,resourceId)
 fun validate(){EquipmentPolicy.snapshot(equipmentJson.encodeToJsonElement(serializer(),this).jsonObject)}
}
@Serializable data class EquipmentSecondaryOutput(val resourceId:String,val grossQuantity:String,val netQuantity:String,val islandPoolQuantity:String){
 fun validate(){require(resourceId in equipmentResourceIds);val gross=CharterGrammar.amount(JsonPrimitive(grossQuantity),true);require(gross<=Long.MAX_VALUE.toBigInteger());require(CharterGrammar.amount(JsonPrimitive(netQuantity),true)+CharterGrammar.amount(JsonPrimitive(islandPoolQuantity),true)==gross)}
}
fun equipmentSelection(snapshot:JsonObject)=JsonObject(snapshot.filterKeys{it in setOf("itemId","policyVersion","resourceId")})
fun equipmentSecondary(raw:JsonObject):EquipmentSecondaryOutput {gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives(raw,EquipmentSecondaryOutput.serializer().descriptor);return equipmentJson.decodeFromJsonElement<EquipmentSecondaryOutput>(raw).also{it.validate()}}
fun equipmentCompanion(route:JsonObject){val fitting=route["fitting"]?.jsonObject;val secondary=route["secondaryOutput"]
 if(fitting?.charterText("itemId")=="survey_lens"){val output=equipmentSecondary(requireNotNull(secondary).jsonObject);require(output.resourceId==fitting.charterText("resourceId")&&route.charterText("resourceId")!=output.resourceId)
  for(key in listOf("grossQuantity","netQuantity","islandPoolQuantity")){val original="original"+key.replaceFirstChar{it.uppercase()};require(CharterGrammar.amount(route.getValue(key),true)+CharterGrammar.amount(secondary.jsonObject.getValue(key),true)==CharterGrammar.amount(fitting.getValue(original),true))}
  require(route["durationSec"]==fitting["originalDurationSec"])
 }else require(secondary==null)
}
