package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepCraftingMarketRepositoryTest {
 private val root=KeepEquipmentMarketProtocol.ROOT
 private fun rejects(block:suspend()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 @Test fun `fresh discovery opts into full catalogue and category changes only GET without changing originals`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val original=x.store.record(x.key);val repo=x.repo();repo.open();repo.selectSaved(x.key)
  assertEquals(14,repo.state.value.stock!!.getValue("items").jsonArray.size)
  for(path in listOf("stock","listings","history"))assertEquals("4",x.queries.last{it.first=="$root/$path"}.second["catalogueVersion"])
  repo.browse("resources");assertEquals("resources",repo.state.value.category);assertTrue(repo.state.value.listings!!.getValue("items").jsonArray.isEmpty())
  assertEquals(original,x.store.record(x.key));assertEquals(x.key,repo.state.value.selectedKey);assertTrue(x.posts.isEmpty())
  for(path in listOf("listings","history"))assertEquals(mapOf("catalogueVersion" to "4","category" to "resources"),x.queries.last{it.first=="$root/$path"}.second)
 }
 @Test fun `pagination retains selected category while category changes discard old cursors`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.listingCursor=buildJsonObject{put("before",x.fill.getValue("createdAt"));put("beforeId",x.fill.getValue("id"))};x.historyCursor=JsonObject(x.listingCursor!!+("beforeKind" to JsonPrimitive("fill")))
  val repo=x.repo();repo.open();repo.browse("resources")
  for(kind in listOf("listings","history")){repo.page(kind);val q=x.queries.last{it.first=="$root/$kind"}.second;assertEquals("resources",q["category"]);assertEquals("4",q["catalogueVersion"]);assertEquals(x.key,q["beforeId"])}
  repo.browse("items");for(kind in listOf("listings","history"))assertEquals(mapOf("catalogueVersion" to "4","category" to "items"),x.queries.last{it.first=="$root/$kind"}.second)
  assertTrue(x.posts.isEmpty())
 }
 @Test fun `all nine crafting identities review and list exact original units from available stock`()=runBlocking {
  for(id in KeepEquipmentMarketCatalogue.craftingCatalogueIds-KeepEquipmentMarketCatalogue.equipmentIds){val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo()
   repo.reviewListing(id,"2","1000001");val reviewed=x.store.record(x.key);repo.browse(if(KeepEquipmentMarketCatalogue.category(id)=="resources")"items"else"resources");repo.confirm()
   val original=x.store.record(x.key);assertEquals(reviewed.request,original.request);assertEquals(id,original.response!!.charterText("itemId"));assertEquals("2",original.response.charterText("quantity"));assertEquals(x.base,original.response.charterText("sellerBaseId"));assertEquals(1,x.posts.size)
  }
 }
 @Test fun `stock failure and wrong category response never create or replace an original`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();rejects{repo.reviewListing("frostglass","11","1000001")};assertTrue(x.store.read().records.isEmpty())
  x.adopt();val saved=x.store.record(x.key);x.ignoreCategory=true;rejects{repo.browse("resources")};assertEquals(saved,x.store.record(x.key));assertNull(repo.state.value.listings);assertTrue(x.posts.isEmpty())
 }
 @Test fun `new listing lost reply recovers GET only while paused providerless and another base is selected`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();repo.reviewListing("navigation_kit","2","1000001");x.failPost="listings";rejects{repo.confirm()};val request=x.store.record(x.key).request
  x.failPost=null;x.allowed=false;x.configured=false;x.owned=false;x.selected=UUID.randomUUID().toString();val cold=x.repo();cold.open();cold.selectSaved(x.key)
  assertEquals(request,cold.state.value.selected!!.request);assertEquals(x.base,cold.state.value.selected!!.response!!.charterText("sellerBaseId"));assertEquals(1,x.posts.size)
 }
 @Test fun `mixed old signed history and new goods preserve exact saved bytes and reject item substitution`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val old=x.row.charterObject("deliveredPurchase");x.adopt(old);x.store.archive(x.key,x.store.record(x.key))
  val id=UUID.randomUUID().toString();val request=buildJsonObject{put("idempotencyKey",id);put("baseId",x.base);put("itemId","frostglass");put("quantity","1");put("unitPriceBaseUnits","1000001")}
  x.store.begin(KeepEquipmentMarketRecord("listing",id,request,KeepEquipmentMarketFixtures.policy));val cold=KeepEquipmentMarketStore(x.memory,x.identity)
  assertEquals(old,cold.read().archives.single().response);assertEquals(request,cold.record(id).request)
  rejects{cold.begin(cold.record(id).copy(request=JsonObject(request+("itemId" to JsonPrimitive("navigation_kit")))))}
  assertEquals(request,cold.record(id).request);assertEquals(old,cold.read().archives.single().response)
 }
 @Test fun `each newly crafted kit lists as Items and survives lost response without another mutation`()=runBlocking {
  for(kit in listOf("climate_kit","expedition_kit")){
   val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();repo.open()
   assertEquals(14,repo.state.value.stock!!.getValue("items").jsonArray.size)
   assertEquals("items",KeepEquipmentMarketCatalogue.category(kit))
   repo.reviewListing(kit,"2","1000001");val command=x.store.record(x.key).request
   x.failPost="listings";rejects{repo.confirm()};assertEquals(1,x.posts.size)
   x.failPost=null;x.allowed=false;x.configured=false;x.owned=false
   val cold=x.repo();cold.selectSaved(x.key);cold.check()
   assertEquals(command,cold.state.value.selected!!.request);assertEquals(kit,cold.state.value.selected!!.response!!.charterText("itemId"))
   assertEquals(1,x.posts.size)
  }
 }

}
