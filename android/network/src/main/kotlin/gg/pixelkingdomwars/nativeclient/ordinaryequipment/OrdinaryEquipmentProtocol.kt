package gg.pixelkingdomwars.nativeclient.ordinaryequipment

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

internal val equipmentJson = Json { encodeDefaults = true }
@Serializable data class EquipmentFeature(val version:Int,val receipts:Int)
@Serializable data class EquipmentFeatures(val ordinaryEquipment:EquipmentFeature)
@Serializable data class EquipmentInput(val kind:String,val itemId:String,val quantity:String)
@Serializable data class EquipmentOutput(val itemId:String,val quantity:String)
@Serializable data class EquipmentRecipe(val recipeVersion:Int,val recipeId:String,val quantity:Int,val durationSec:Long,
 val inputs:List<EquipmentInput>,val output:EquipmentOutput) {
 fun validate(){require(recipeVersion==1&&quantity==1&&durationSec>0);require(output.itemId in setOf("route_compass","survey_lens")&&recipeId=="craft_${output.itemId}");quantity(output.quantity,true)
  require(inputs.map{it.kind to it.itemId}==listOf("crafting" to "prismstone_lens","crafting" to if(output.itemId=="survey_lens")"frostglass"else "crownsteel"));inputs.forEach{quantity(it.quantity,true)}}
}
@Serializable data class EquipmentStock(val itemId:String,val available:String,val reserved:String,val pendingOutput:String) {
 fun validate(){require(itemId in setOf("route_compass","survey_lens"));require(quantity(available)+quantity(reserved)+quantity(pendingOutput)<=Long.MAX_VALUE.toBigInteger())}
}
@Serializable data class EquipmentJob(val jobId:String,val recipe:EquipmentRecipe,val startedAt:String,val readyAt:String) {
 fun validate(){uuid(jobId);recipe.validate();require(timestamp(readyAt)==timestamp(startedAt).plusSeconds(recipe.durationSec))}
}
@Serializable data class EquipmentView(val wallet:String,val baseId:String,val serverNow:String,val features:EquipmentFeatures,
 val acceptingJobs:Boolean,val recipeVersion:Int,val maxBatch:Int,val recipes:List<EquipmentRecipe>,val craftingStock:List<OrdinaryProtectedStock>,
 val equipmentStock:List<EquipmentStock>,val pendingJobs:List<EquipmentJob>,val catalogueVersion:Int?=null) {
 fun validate(){wallet(wallet);uuid(baseId);val now=timestamp(serverNow);require(features.ordinaryEquipment==EquipmentFeature(1,1));require(recipeVersion>0&&maxBatch>0)
  val items=if(catalogueVersion==null)listOf("route_compass")else {require(catalogueVersion==2);listOf("route_compass","survey_lens")};require(recipes.map{it.output.itemId}==items);recipes.forEach{it.validate();require(it.recipeVersion==recipeVersion&&it.quantity<=maxBatch)}
  require(craftingStock.map{it.itemId}.toSet()==craftingItemIds&&craftingStock.size==craftingItemIds.size);craftingStock.forEach{it.validate()}
  require(equipmentStock.map{it.itemId}==items);equipmentStock.forEach{it.validate()};require(pendingJobs.map{it.jobId}.distinct().size==pendingJobs.size)
  pendingJobs.forEach{it.validate();require(timestamp(it.startedAt)<=now&&timestamp(it.readyAt)>now)}
  pendingJobs.forEach{require(it.recipe.output.itemId in items)};equipmentStock.forEach{stock->require(quantity(stock.pendingOutput)==pendingJobs.filter{it.recipe.output.itemId==stock.itemId}.fold(java.math.BigInteger.ZERO){a,j->a+quantity(j.recipe.output.quantity,true)})}
 }
 companion object {fun from(raw:JsonObject):EquipmentView{require(raw["catalogueVersion"]!=JsonNull);strictPrimitives(raw,serializer().descriptor);return equipmentJson.decodeFromJsonElement<EquipmentView>(raw).also{it.validate()}}}
}
@Serializable data class EquipmentRequest(val idempotencyKey:String,val baseId:String,val recipeId:String,val recipeVersion:Int,val quantity:Int) {
 fun validate(){uuid(idempotencyKey);uuid(baseId);require(recipeId in setOf("craft_route_compass","craft_survey_lens")&&recipeVersion==1&&quantity==1)}
 fun body()=equipmentJson.encodeToJsonElement(serializer(),this).jsonObject
}
@Serializable data class EquipmentCommand(val request:EquipmentRequest,val recipe:EquipmentRecipe) {
 fun validate(){request.validate();recipe.validate();require(request.recipeId==recipe.recipeId&&request.recipeVersion==recipe.recipeVersion&&request.quantity==recipe.quantity)}
 fun admit(identity:StarterIdentity,view:EquipmentView){validate();identity.validate();view.validate();require(view.wallet==identity.wallet&&view.baseId==request.baseId&&view.acceptingJobs&&view.pendingJobs.isEmpty())
  require(view.recipeVersion==request.recipeVersion&&request.quantity<=view.maxBatch&&view.recipes.single{it.recipeId==request.recipeId}==recipe)
  recipe.inputs.forEach{input->require(quantity(view.craftingStock.single{it.itemId==input.itemId}.available)>=quantity(input.quantity,true))}
  val stock=view.equipmentStock.single{it.itemId==recipe.output.itemId};require(quantity(stock.available)+quantity(stock.reserved)+quantity(stock.pendingOutput)+quantity(recipe.output.quantity,true)<=Long.MAX_VALUE.toBigInteger())
 }
 companion object {fun review(identity:StarterIdentity,view:EquipmentView,key:String,item:String="route_compass"):EquipmentCommand {val recipe=view.recipes.single{it.output.itemId==item};return EquipmentCommand(EquipmentRequest(key,view.baseId,recipe.recipeId,recipe.recipeVersion,recipe.quantity),recipe).also{it.admit(identity,view)}}}
}
@Serializable data class EquipmentReceipt(val wallet:String,val request:EquipmentRequest,val jobId:String,val recipe:EquipmentRecipe,val startedAt:String,val readyAt:String) {
 fun validate(identity:StarterIdentity,command:EquipmentCommand){command.validate();require(wallet==identity.wallet&&request==command.request&&jobId==request.idempotencyKey&&recipe==command.recipe);EquipmentJob(jobId,recipe,startedAt,readyAt).validate()}
}
@Serializable data class EquipmentCompletion(val completedAt:String)
@Serializable data class EquipmentProof(val wallet:String,val idempotencyKey:String,val serverNow:String,val status:String,val receipt:EquipmentReceipt?,val completion:EquipmentCompletion?) {
 fun validate(identity:StarterIdentity,command:EquipmentCommand){identity.validate();command.validate();require(wallet==identity.wallet&&idempotencyKey==command.request.idempotencyKey);val now=timestamp(serverNow)
  if(status=="unknown"){require(receipt==null&&completion==null);return};require(status=="accepted");val r=requireNotNull(receipt);r.validate(identity,command);require(timestamp(r.startedAt)<=now);completion?.let{require(timestamp(it.completedAt) in timestamp(r.readyAt)..now)}
 }
 companion object {fun from(raw:JsonObject,identity:StarterIdentity,command:EquipmentCommand):EquipmentProof {strictPrimitives(raw,serializer().descriptor);return equipmentJson.decodeFromJsonElement<EquipmentProof>(raw).also{it.validate(identity,command)}}}
}
