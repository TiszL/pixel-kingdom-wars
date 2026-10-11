package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepFragmentMarketRepositoryTest {
 private fun rejected(block:suspend()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 private fun fragmentRow(value:JsonElement):JsonElement=when(value){is JsonObject->JsonObject(value.mapValues{(key,v)->if(key=="itemId")JsonPrimitive("crystal_fragment")else fragmentRow(v)});is JsonArray->JsonArray(value.map(::fragmentRow));else->value}
 @Test fun `fresh full stock refuses all earlier catalogues without altering an existing saved payment`()=runBlocking {
  for(version in listOf("1","2","3")){val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val saved=x.store.record(x.key);x.stockVersionOverride=version
   val repo=x.repo();rejected{repo.open()};assertNull(repo.state.value.stock);assertEquals(saved,x.store.record(x.key));assertTrue(x.posts.isEmpty())
   assertEquals("4",x.queries.last{it.first.endsWith("/stock")}.second["catalogueVersion"])
  }
 }
 @Test fun `fragment listing survives lost reply restart paused providerless recovery and changed current kingdom`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();repo.reviewListing("crystal_fragment","2","1000001");val request=x.store.record(x.key).request
  x.failPost="listings";rejected{repo.confirm()};x.failPost=null;x.allowed=false;x.configured=false;x.owned=false;x.selected=UUID.randomUUID().toString()
  val cold=x.repo();cold.open();cold.selectSaved(x.key);val saved=requireNotNull(cold.state.value.selected)
  assertEquals(request,saved.request);assertEquals("crystal_fragment",saved.response!!.charterText("itemId"));assertEquals(x.base,saved.response.charterText("sellerBaseId"));assertEquals("2",saved.response.charterText("quantity"));assertEquals(1,x.posts.size)
 }
 @Test fun `fragment holds and unavailable stock never become sellable units`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.stockItems=JsonArray(x.stockItems.map{row->if(row.jsonObject.charterText("itemId")=="crystal_fragment")JsonObject(row.jsonObject+mapOf("available" to JsonPrimitive("0"),"marketIncoming" to JsonPrimitive("5"),"marketOutgoing" to JsonPrimitive("5")))else row})
  val repo=x.repo();rejected{repo.reviewListing("crystal_fragment","1","1000001")};assertTrue(x.store.read().records.isEmpty());assertTrue(x.posts.isEmpty())
 }
 @Test fun `fragment Resources purchase retains exact original wallet message and delivered base through cold paused recovery`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture(fragmentRow(KeepEquipmentMarketFixtures.rows.first()).jsonObject);val repo=x.repo();repo.open();repo.browse("resources")
  assertEquals("crystal_fragment",repo.state.value.listings!!.getValue("items").jsonArray.single().jsonObject.charterText("itemId"))
  repo.reviewFill(x.listing,x.fill.charterText("quantity"));repo.confirm();repo.command("prepare");repo.reviewPayment();repo.approve();repo.send()
  val paid=x.store.record(x.key);assertEquals(x.wire,paid.signed);assertEquals("crystal_fragment",paid.response!!.charterObject("delivery").charterText("itemId"));assertEquals(x.base,paid.response.charterObject("delivery").charterText("buyerBaseId"));assertEquals(1,x.approvals)
  val posts=x.posts.size;x.allowed=false;x.configured=false;x.owned=false;x.selected=UUID.randomUUID().toString();val cold=x.repo();cold.open();cold.selectSaved(x.key)
  assertEquals(paid,cold.state.value.selected);assertEquals(posts,x.posts.size);assertEquals(1,x.posts.count{it.second.endsWith("/deliver")})
 }
}
