package gg.pixelkingdomwars.nativeclient.keepequipmentmarket

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepFragmentMarketProtocolTest {
 private val f=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/keep-equipment-market-vectors.json")).readText()).jsonObject
 private val purchase=f.getValue("vectors").jsonArray.first().jsonObject.charterObject("purchase")
 private val fill=purchase.charterObject("fill")
 private val root=KeepEquipmentMarketProtocol.ROOT
 private fun stock(version:Int?)=buildJsonObject {
  put("baseId",fill.getValue("buyerBaseId"));put("wallet",fill.getValue("buyerWallet"));put("serverNow",fill.getValue("createdAt"));put("policy",f.getValue("policy"))
  if(version!=null)put("catalogueVersion",version)
  val ids=when(version){null->KeepEquipmentMarketCatalogue.equipmentIds;2->KeepEquipmentMarketCatalogue.craftingCatalogueIds;else->KeepEquipmentMarketCatalogue.fragmentCatalogueIds}
  put("items",JsonArray(ids.map{id->buildJsonObject{put("itemId",id);for(k in listOf("available","reserved","pendingOutput","marketOutgoing","marketIncoming"))put(k,"0")}}))
 }
 private fun changed(v:JsonObject,vararg fields:Pair<String,JsonElement>)=JsonObject(v+("items" to JsonArray(v.getValue("items").jsonArray.map{r->if(r.jsonObject.charterText("itemId")=="crystal_fragment")JsonObject(r.jsonObject+fields)else r})))
 private fun rejected(block:()->Unit)=assertNotNull(runCatching(block).exceptionOrNull())
 @Test fun `three exact stock versions preserve original two and eleven while adding only the twelfth fragment`() {
  for((version,size)in listOf(null to 2,2 to 11,3 to 12)){val v=stock(version);assertEquals(v,KeepEquipmentMarketProtocol.stock(v));assertEquals(size,v.getValue("items").jsonArray.size)}
  val v=stock(3)
  rejected{KeepEquipmentMarketProtocol.stock(JsonObject(v-"catalogueVersion"))}
  rejected{KeepEquipmentMarketProtocol.stock(JsonObject(v+("catalogueVersion" to JsonPrimitive(2))))}
  for(value in listOf<JsonElement>(JsonPrimitive("3"),JsonPrimitive(1),JsonPrimitive(4),JsonNull))rejected{KeepEquipmentMarketProtocol.stock(JsonObject(v+("catalogueVersion" to value)))}
  assertEquals(setOf("crystal_fragment"),KeepEquipmentMarketCatalogue.fragmentCatalogueIds-KeepEquipmentMarketCatalogue.craftingCatalogueIds)
 }
 @Test fun `v3 stock rejects omitted duplicate or unknown identities rather than treating fragments as zero`() {
  val v=stock(3);val rows=v.getValue("items").jsonArray
  for(items in listOf(rows.dropLast(1),rows.dropLast(1)+rows.first(),rows+rows.last()))rejected{KeepEquipmentMarketProtocol.stock(JsonObject(v+("items" to JsonArray(items))))}
  rejected{KeepEquipmentMarketProtocol.stock(changed(v,"itemId" to JsonPrimitive("divine_fragment")))}
 }
 @Test fun `protected fragment stock has no crafting output or trip reservations and holds consume exact capacity`() {
  val v=stock(3)
  for(field in listOf("reserved","pendingOutput"))rejected{KeepEquipmentMarketProtocol.stock(changed(v,field to JsonPrimitive("1")))}
  KeepEquipmentMarketProtocol.stock(changed(v,"available" to JsonPrimitive((Long.MAX_VALUE-2).toString()),"marketIncoming" to JsonPrimitive("1"),"marketOutgoing" to JsonPrimitive("1")))
  rejected{KeepEquipmentMarketProtocol.stock(changed(v,"available" to JsonPrimitive(Long.MAX_VALUE.toString()),"marketIncoming" to JsonPrimitive("1")))}
  rejected{KeepEquipmentMarketProtocol.stock(changed(v,"marketOutgoing" to JsonPrimitive(1)))}
 }
 @Test fun `fragment discovery requires version three and Resources with complete cursor grammar`() {
  assertEquals("resources",KeepEquipmentMarketCatalogue.category("crystal_fragment"))
  for(path in listOf("listings","history")){
   val q=mapOf("catalogueVersion" to "3","category" to "resources","itemId" to "crystal_fragment")
   KeepEquipmentMarketProtocol.request("GET","$root/$path",q,null)
   for(bad in listOf(q-"catalogueVersion",q+("catalogueVersion" to "2"),q+("category" to "items")))rejected{KeepEquipmentMarketProtocol.request("GET","$root/$path",bad,null)}
   val cursor=mapOf("before" to fill.charterText("createdAt"),"beforeId" to fill.charterText("id"))+if(path=="history")mapOf("beforeKind" to "fill")else emptyMap()
   KeepEquipmentMarketProtocol.request("GET","$root/$path",q+cursor,null)
   rejected{KeepEquipmentMarketProtocol.request("GET","$root/$path",q+cursor-"beforeId",null)}
  }
 }
 @Test fun `fragment original commands use the unchanged request body and never add a catalogue or stock family`() {
  val request=buildJsonObject{put("idempotencyKey",fill.getValue("id"));put("baseId",fill.getValue("sellerBaseId"));put("itemId","crystal_fragment");put("quantity","2");put("unitPriceBaseUnits","1000000")}
  KeepEquipmentMarketProtocol.request("POST","$root/listings",emptyMap(),request)
  for(extra in listOf("catalogueVersion" to JsonPrimitive(3),"stockKind" to JsonPrimitive("fragment")))rejected{KeepEquipmentMarketProtocol.request("POST","$root/listings",emptyMap(),JsonObject(request+extra))}
  KeepEquipmentMarketProtocol.request("GET","$root/stock",mapOf("baseId" to fill.charterText("buyerBaseId"),"catalogueVersion" to "3"),null)
  rejected{KeepEquipmentMarketProtocol.request("GET","$root/fills/${fill.charterText("id")}",mapOf("catalogueVersion" to "3"),null)}
 }
 @Test fun `original reserved fragment receipt adds no payment field or substitution permission`() {
  val original=JsonObject(purchase+mapOf("fill" to JsonObject(fill+("itemId" to JsonPrimitive("crystal_fragment"))),"preparation" to JsonNull,"status" to JsonPrimitive("reserved")))
  assertEquals(original,KeepEquipmentMarketProtocol.purchase(original))
  rejected{KeepEquipmentMarketProtocol.purchase(JsonObject(original+("stockKind" to JsonPrimitive("fragment"))))}
 }
}
