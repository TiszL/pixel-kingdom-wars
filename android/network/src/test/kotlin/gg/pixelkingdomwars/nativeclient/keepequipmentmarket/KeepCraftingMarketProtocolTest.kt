package gg.pixelkingdomwars.nativeclient.keepequipmentmarket

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepCraftingMarketProtocolTest {
 private val f=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/keep-equipment-market-vectors.json")).readText()).jsonObject
 private val fill=f.getValue("vectors").jsonArray.first().jsonObject.charterObject("purchase").charterObject("fill")
 private val root=KeepEquipmentMarketProtocol.ROOT
 private fun stock(expanded:Boolean)=buildJsonObject {
  put("baseId",fill.getValue("buyerBaseId"));put("wallet",fill.getValue("buyerWallet"));put("serverNow",fill.getValue("createdAt"));put("policy",f.getValue("policy"))
  if(expanded)put("catalogueVersion",2)
  put("items",JsonArray((if(expanded)KeepEquipmentMarketCatalogue.craftingCatalogueIds else KeepEquipmentMarketCatalogue.equipmentIds).map{id->buildJsonObject {
   put("itemId",id);for(k in listOf("available","reserved","pendingOutput","marketOutgoing","marketIncoming"))put(k,"0")
  }}))
 }
 private fun rejected(block:()->Unit){assertNotNull(runCatching(block).exceptionOrNull())}
 private fun rows(v:JsonObject,values:List<JsonElement>)=JsonObject(v+("items" to JsonArray(values)))
 @Test fun `old two item stock is unchanged while explicit second catalogue has all eleven identities`() {
  val old=stock(false);val expanded=stock(true)
  assertEquals(old,KeepEquipmentMarketProtocol.stock(old));assertEquals(expanded,KeepEquipmentMarketProtocol.stock(expanded))
  assertEquals(11,KeepEquipmentMarketCatalogue.craftingCatalogueIds.size);assertEquals(8,(KeepEquipmentMarketCatalogue.resourceIds-"crystal_fragment").size)
  assertEquals(setOf("route_compass","survey_lens","navigation_kit"),KeepEquipmentMarketCatalogue.craftingCatalogueIds-KeepEquipmentMarketCatalogue.resourceIds)
  rejected{KeepEquipmentMarketProtocol.stock(JsonObject(expanded-"catalogueVersion"))}
  for(version in listOf<JsonElement>(JsonPrimitive("2"),JsonPrimitive(1),JsonNull))rejected{KeepEquipmentMarketProtocol.stock(JsonObject(expanded+("catalogueVersion" to version)))}
 }
 @Test fun `complete stock refuses missing duplicate unknown or extra rows and caller stock families`() {
  val v=stock(true);val items=v.getValue("items").jsonArray
  rejected{KeepEquipmentMarketProtocol.stock(rows(v,items.dropLast(1)))}
  rejected{KeepEquipmentMarketProtocol.stock(rows(v,items+items.first()))}
  rejected{KeepEquipmentMarketProtocol.stock(rows(v,items.dropLast(1)+items.first()))}
  rejected{KeepEquipmentMarketProtocol.stock(rows(v,items.dropLast(1)+JsonObject(items.last().jsonObject+("itemId" to JsonPrimitive("ingot")))))}
  rejected{KeepEquipmentMarketProtocol.stock(rows(v,items.dropLast(1)+JsonObject(items.last().jsonObject+("stockKind" to JsonPrimitive("equipment")))))}
 }
 @Test fun `crafting stock cannot invent trip reservations or exceed capacity with held incoming units`() {
  val v=stock(true);val items=v.getValue("items").jsonArray;val i=items.indexOfFirst{it.jsonObject.charterText("itemId")=="frostglass"}
  fun changed(vararg fields:Pair<String,JsonElement>)=rows(v,items.mapIndexed{n,row->if(n==i)JsonObject(row.jsonObject+fields)else row})
  rejected{KeepEquipmentMarketProtocol.stock(changed("reserved" to JsonPrimitive("1")))}
  KeepEquipmentMarketProtocol.stock(changed("available" to JsonPrimitive((Long.MAX_VALUE-1).toString()),"marketIncoming" to JsonPrimitive("1")))
  rejected{KeepEquipmentMarketProtocol.stock(changed("available" to JsonPrimitive(Long.MAX_VALUE.toString()),"marketIncoming" to JsonPrimitive("1")))}
  rejected{KeepEquipmentMarketProtocol.stock(changed("marketOutgoing" to JsonPrimitive(1)))}
 }
 @Test fun `fresh discovery requires version two for category and crafting ids without broadening stock query`() {
  for(path in listOf("listings","history"))for(id in KeepEquipmentMarketCatalogue.craftingCatalogueIds){
   val q=mapOf("catalogueVersion" to "2","category" to KeepEquipmentMarketCatalogue.category(id),"itemId" to id)
   KeepEquipmentMarketProtocol.request("GET","$root/$path",q,null)
   rejected{KeepEquipmentMarketProtocol.request("GET","$root/$path",q+("category" to if(q["category"]=="items")"resources"else"items"),null)}
   if(id !in KeepEquipmentMarketCatalogue.equipmentIds)rejected{KeepEquipmentMarketProtocol.request("GET","$root/$path",mapOf("itemId" to id),null)}
  }
  KeepEquipmentMarketProtocol.request("GET","$root/stock",mapOf("baseId" to fill.charterText("buyerBaseId"),"catalogueVersion" to "2"),null)
  for(q in listOf(mapOf("catalogueVersion" to "1"),mapOf("category" to "items"),mapOf("catalogueVersion" to "2","category" to "raw")))rejected{KeepEquipmentMarketProtocol.request("GET","$root/listings",q,null)}
  rejected{KeepEquipmentMarketProtocol.request("GET","$root/stock",mapOf("baseId" to fill.charterText("buyerBaseId"),"catalogueVersion" to "2","category" to "items"),null)}
 }
 @Test fun `expanded history keeps full cursor grammar and exact original lookups accept no discovery query`() {
  val q=mapOf("catalogueVersion" to "2","category" to "resources","before" to fill.charterText("createdAt"),"beforeId" to fill.charterText("id"),"beforeKind" to "fill")
  KeepEquipmentMarketProtocol.request("GET","$root/history",q,null)
  for(k in listOf("before","beforeId","beforeKind"))rejected{KeepEquipmentMarketProtocol.request("GET","$root/history",q-k,null)}
  KeepEquipmentMarketProtocol.request("GET","$root/fills/${fill.charterText("id")}",emptyMap(),null)
  rejected{KeepEquipmentMarketProtocol.request("GET","$root/fills/${fill.charterText("id")}",mapOf("catalogueVersion" to "2"),null)}
 }
 @Test fun `listing commands allow only the eleven known goods with unchanged original body shape`() {
  fun request(id:String)=buildJsonObject{put("idempotencyKey",fill.getValue("id"));put("baseId",fill.getValue("sellerBaseId"));put("itemId",id);put("quantity","1");put("unitPriceBaseUnits","1000000")}
  for(id in KeepEquipmentMarketCatalogue.craftingCatalogueIds)KeepEquipmentMarketProtocol.request("POST","$root/listings",emptyMap(),request(id))
  for(id in listOf("frost_quartz","ingot","divine_fragment","navigation_kit ","Frostglass"))rejected{KeepEquipmentMarketProtocol.request("POST","$root/listings",emptyMap(),request(id))}
  rejected{KeepEquipmentMarketProtocol.request("POST","$root/listings",emptyMap(),JsonObject(request("frostglass")+("catalogueVersion" to JsonPrimitive(2))))}
 }
}
