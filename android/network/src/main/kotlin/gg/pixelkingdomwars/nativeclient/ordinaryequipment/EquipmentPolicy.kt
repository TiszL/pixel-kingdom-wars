package gg.pixelkingdomwars.nativeclient.ordinaryequipment

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds
import gg.pixelkingdomwars.nativeclient.starter.starterResourceRealms
import java.math.BigInteger
import kotlinx.serialization.json.*

/** Compatibility only; the server still owns route cargo, access and departure admission. */
fun equipmentPaidDestinationSupports(item:String,resource:String?,realm:String):Boolean {
 if(realm !in paidStarterRealmIds)return false
 return when(item){
  "route_compass"->resource==null
  "survey_lens"->resource in equipmentResourceIds&&resource!=starterResourceRealms.entries.single{it.value==realm}.key
  else->false
 }
}

/** Installed shared constants captured with an original. Server previews are displayed,
 * while these exact integer checks reject forged effects and preserve historical rules. */
data class EquipmentPolicy(val raw:JsonObject) {
 val equipment get()=raw.charterObject("equipment")
 val surveyLens get()=raw["surveyLens"]?.jsonObject
 val tax get()=raw.charterObject("tax")
 private fun number(o:JsonObject,k:String)=CharterGrammar.number(o.getValue(k)).toBigInteger()
 val selection get()=buildJsonObject{put("itemId","route_compass");put("policyVersion",equipment.getValue("policyVersion"))}
 fun sameItemPolicy(other:EquipmentPolicy,item:String)=tax==other.tax&&if(item=="survey_lens")surveyLens!=null&&surveyLens==other.surveyLens else equipment==other.equipment
 fun selectionFor(item:String,resource:String?=null)=buildJsonObject{put("itemId",item);put("policyVersion",(if(item=="survey_lens")requireNotNull(surveyLens)else equipment).getValue("policyVersion"));resource?.let{put("resourceId",it)}}.also{selection(it)}
 fun verify(recipe:EquipmentRecipe){recipe.validate();val equipment=if(recipe.output.itemId=="survey_lens")requireNotNull(surveyLens)else equipment;val r=equipment.charterObject("recipe");require(recipe.recipeVersion.toLong()==CharterGrammar.number(equipment.getValue("recipeVersion"))&&recipe.quantity.toLong()==CharterGrammar.number(equipment.getValue("maxBatch")))
  require(recipe.durationSec==CharterGrammar.number(r.getValue("durationSec"))&&recipe.output.quantity==number(r,"outputQuantity").toString())
  require(recipe.inputs.map{it.quantity}==listOf(number(r,"prismstoneLens").toString(),number(r,if(recipe.output.itemId=="survey_lens")"frostglass"else "crownsteel").toString()))}
 fun original(route:JsonObject):JsonObject {
  val fitting=route["fitting"]?.jsonObject?:return route.also{equipmentCompanion(it)};snapshot(fitting);equipmentCompanion(route);require(equipmentSelection(fitting)==selectionFor(fitting.charterText("itemId"),fitting["resourceId"]?.jsonPrimitive?.content))
  val original=JsonObject(route.filterKeys{it !in setOf("fitting","secondaryOutput")}+mapOf("durationSec" to fitting.getValue("originalDurationSec"),"grossQuantity" to fitting.getValue("originalGrossQuantity"),"netQuantity" to fitting.getValue("originalNetQuantity"),"islandPoolQuantity" to fitting.getValue("originalIslandPoolQuantity")))
  val basis=number(tax,"basisPoints");val rate=number(tax,"islandPoolBps");val quantum=basis/basis.gcd(rate)
  if(fitting.charterText("itemId")=="survey_lens"){
   val lens=requireNotNull(surveyLens);val total=CharterGrammar.amount(original.getValue("grossQuantity"),true);val secondary=total*number(lens,"secondaryNumerator")/number(lens,"secondaryDenominator")/quantum*quantum
   val primary=total-secondary;require(primary.signum()>0&&secondary.signum()>0)
   for((leg,amount)in listOf(route to primary,route.charterObject("secondaryOutput") to secondary)){require(amount*rate%basis==BigInteger.ZERO);require(CharterGrammar.amount(leg.getValue("grossQuantity"),true)==amount&&CharterGrammar.amount(leg.getValue("islandPoolQuantity"),true)==amount*rate/basis&&CharterGrammar.amount(leg.getValue("netQuantity"),true)==amount-amount*rate/basis)}
   return original
  }
  val gross=CharterGrammar.amount(original.getValue("grossQuantity"),true)*number(equipment,"cargoNumerator")/number(equipment,"cargoDenominator")/quantum*quantum
  require(gross.signum()>0);val pool=gross*rate/basis;val duration=(number(original,"durationSec")*number(equipment,"durationNumerator")+number(equipment,"durationDenominator")-BigInteger.ONE)/number(equipment,"durationDenominator")
  require(CharterGrammar.number(route.getValue("durationSec")).toBigInteger()==duration&&CharterGrammar.amount(route.getValue("grossQuantity"))==gross&&CharterGrammar.amount(route.getValue("islandPoolQuantity"))==pool&&CharterGrammar.amount(route.getValue("netQuantity"))==gross-pool)
  return original
 }
 companion object {
  fun selection(raw:JsonObject){require(CharterGrammar.number(raw.getValue("policyVersion"))==1L);when(raw.charterText("itemId")){"route_compass"->require(raw.keys==setOf("itemId","policyVersion"));"survey_lens"->require(raw.keys==setOf("itemId","policyVersion","resourceId")&&raw.charterText("resourceId") in equipmentResourceIds);else->error("Unknown fitting")}}
  fun snapshot(raw:JsonObject){require(raw.keys==setOf("itemId","policyVersion","originalDurationSec","originalGrossQuantity","originalNetQuantity","originalIslandPoolQuantity")+if(raw.charterText("itemId")=="survey_lens")setOf("resourceId")else emptySet<String>());selection(equipmentSelection(raw));require(CharterGrammar.number(raw.getValue("originalDurationSec"))>0)
   val gross=CharterGrammar.amount(raw.getValue("originalGrossQuantity"),true);require(gross<=Long.MAX_VALUE.toBigInteger()&&CharterGrammar.amount(raw.getValue("originalNetQuantity"))+CharterGrammar.amount(raw.getValue("originalIslandPoolQuantity"))==gross)}
  fun from(raw:JsonObject):EquipmentPolicy{val r=VehicleProtocol.copy(raw).jsonObject;require(r.keys==setOf("equipment","tax")||r.keys==setOf("equipment","tax","surveyLens"));r["surveyLens"]?.jsonObject?.let{l->require(l.keys==setOf("catalogueVersion","recipeVersion","maxBatch","policyVersion","recipe","secondaryNumerator","secondaryDenominator"));require(l.charterObject("recipe").keys==setOf("prismstoneLens","frostglass","durationSec","outputQuantity"));l.filterKeys{it!="recipe"}.values.forEach{require(CharterGrammar.number(it)>0)};l.charterObject("recipe").values.forEach{require(CharterGrammar.number(it)>0)};require(CharterGrammar.number(l.getValue("catalogueVersion"))==2L&&CharterGrammar.number(l.getValue("policyVersion"))==1L&&CharterGrammar.number(l.getValue("secondaryNumerator"))<CharterGrammar.number(l.getValue("secondaryDenominator")))};val e=r.charterObject("equipment");require(e.keys==setOf("recipeVersion","maxBatch","policyVersion","recipe","durationNumerator","durationDenominator","cargoNumerator","cargoDenominator"));require(e.charterObject("recipe").keys==setOf("prismstoneLens","crownsteel","durationSec","outputQuantity"));e.filterKeys{it!="recipe"}.values.forEach{require(CharterGrammar.number(it)>0)};e.charterObject("recipe").values.forEach{require(CharterGrammar.number(it)>0)};require(CharterGrammar.number(e.getValue("policyVersion"))==1L)
   val tax=r.charterObject("tax");require(tax.keys==setOf("basisPoints","islandPoolBps"));require(CharterGrammar.number(tax.getValue("basisPoints"))>0&&CharterGrammar.number(tax.getValue("islandPoolBps")) in 1..CharterGrammar.number(tax.getValue("basisPoints")));return EquipmentPolicy(r)}
  fun catalogue(catalogue:JsonObject?):EquipmentPolicy?=runCatching{val c=requireNotNull(catalogue).charterObject("constants");val p=c.charterObject("PHASE_E_POLICY");from(buildJsonObject{put("equipment",c.getValue("PHASE_E_ORDINARY_EQUIPMENT"));c["PHASE_E_SURVEY_LENS"]?.let{put("surveyLens",it)};put("tax",buildJsonObject{put("basisPoints",p.getValue("basisPoints"));put("islandPoolBps",p.charterObject("taxes").charterObject("resources").getValue("islandPoolBps"))})})}.getOrNull()
 }
}
