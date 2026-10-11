package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepEquipmentMarketControlsTest {
 @Test fun `resource and item selectors contain exactly the approved goods with readable original names`() {
  val resources=keepMarketItems("resources");val items=keepMarketItems("items")
  assertEquals(9,resources.size);assertEquals(setOf("route_compass","survey_lens","navigation_kit","climate_kit","expedition_kit"),items.toSet())
  assertTrue(resources.intersect(items.toSet()).isEmpty());assertFalse("frost_quartz" in resources)
  assertEquals("Prismstone Lens",keepMarketName("prismstone_lens"));assertEquals("Navigation Kit",keepMarketName("navigation_kit"))
  for(id in resources+items){assertNotEquals("Goods",keepMarketName(id));assertFalse(keepMarketName(id).contains('_'))}
 }
 @Test fun `stock labels distinguish production trip reservations market holds and incoming purchases`() {
  val equipment=keepMarketStockLabels("route_compass").toMap();val material=keepMarketStockLabels("frostglass").toMap()
  assertEquals(setOf("available","reserved","pendingOutput","marketOutgoing","marketIncoming"),material.keys)
  assertEquals("Reserved for trips",equipment["reserved"]);assertEquals("Reserved",material["reserved"])
  assertEquals("Listed / buyer holds",material["marketOutgoing"]);assertEquals("Incoming purchases",material["marketIncoming"])
  assertNotEquals(material["available"],material["pendingOutput"])
 }
 @Test fun `a saved crafting request keeps its original goods and amount when the browse category changes`() {
  val x=KeepEquipmentMarketFixtures.Fixture();val record=KeepEquipmentMarketRecord("listing",x.key,buildJsonObject{
   put("idempotencyKey",x.key);put("baseId",x.base);put("itemId","frostglass");put("quantity","2");put("unitPriceBaseUnits","1000001")},KeepEquipmentMarketFixtures.policy)
  val state=KeepEquipmentMarketState(category="items",commandReview=record,journal=KeepEquipmentMarketJournal(identity=x.identity,pending=listOf(record)),selectedKey=x.key)
  assertEquals("Sell Frostglass",keepMarketTitle(state.selected!!));assertEquals("confirm",keepMarketPrimary(state));assertEquals(record,state.selected)
 }
 @Test fun `KEEP prices preserve one base unit and reject lossy or misleading input`() {
  assertEquals("0.001000001",keepMarketAmount("1000001",9));assertEquals("18446744073.709551615",keepMarketAmount("18446744073709551615",9));assertEquals("1",keepMarketPrice("0.000000001",9));assertEquals("18446744073709551615",keepMarketPrice("18446744073.709551615",9))
  for(value in listOf("0","01","1e2","-1","0.0000000001","18446744073.709551616"))assertNull(value,keepMarketPrice(value,9))
 }
 @Test fun `only explicit reviewed original can expose wallet approval and uncertainty exposes recovery`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val r=x.adopt();fun state(record:KeepEquipmentMarketRecord,review:JsonObject?=null)=KeepEquipmentMarketState(journal=KeepEquipmentMarketJournal(identity=x.identity,pending=listOf(record)),selectedKey=record.key,paymentReview=review)
  assertEquals("review",keepMarketPrimary(state(r)));assertEquals("approve",keepMarketPrimary(state(r,x.row.charterObject("review"))));assertEquals("recover",keepMarketPrimary(state(r.copy(attempts=listOf("wallet")),x.row.charterObject("review"))));assertEquals("check",keepMarketPrimary(state(r.copy(held=true),x.row.charterObject("review"))));assertEquals("send",keepMarketPrimary(state(r.copy(signed=x.wire))));assertEquals("send",keepMarketPrimary(state(r.copy(signed=x.wire,attempts=listOf("deliver:0")))));assertNull(keepMarketPrimary(state(r.copy(response=x.row.charterObject("deliveredPurchase")))));Unit
 }
 @Test fun `titles name equipment and action without exposing transaction identifiers`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val r=x.adopt();assertEquals("Buy Route Compass",keepMarketTitle(r));assertEquals("Survey Lens",keepMarketName("survey_lens"));assertFalse(keepMarketTitle(r).contains(r.key));Unit
 }
 @Test fun `retained payment exposes recovery independently of new payment controls`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val unsigned=x.adopt();assertFalse(keepMarketCanRecover(unsigned));assertEquals("PAYMENT NOT RECORDED",keepMarketPill(unsigned).label);val signed=unsigned.copy(response=x.row.charterObject("signedPurchase"),attempts=listOf("deliver:0"));assertTrue(keepMarketCanRecover(signed));assertFalse(keepMarketCanRecover(signed.copy(held=true)));assertFalse(keepMarketCanRecover(signed.copy(response=x.row.charterObject("deliveredPurchase"))));Unit
 }

 @Test fun `release controls distinguish unprepared cancellation signed failure and unresolved prepared original`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val r=x.adopt();assertNull(keepMarketReleaseAction(r));assertEquals("cancel",keepMarketReleaseAction(r.copy(response=KeepEquipmentMarketFixtures.reserved(x.row))));assertEquals("failure",keepMarketReleaseAction(r.copy(signed=x.wire)));assertEquals("failure",keepMarketReleaseAction(r.copy(response=x.row.charterObject("signedPurchase"))));assertNull(keepMarketReleaseAction(r.copy(held=true,signed=x.wire)));Unit
 }
 @Test fun `released original shows closed and has no resend resign recovery or release action`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();for(failed in listOf(false,true)){val r=KeepEquipmentMarketRecord("fill",x.key,buildJsonObject{put("idempotencyKey",x.key);for(k in listOf("listingId","buyerBaseId","quantity"))put(k,x.fill.getValue(k))},KeepEquipmentMarketFixtures.policy,response=KeepEquipmentMarketFixtures.released(x.row,failed));val state=KeepEquipmentMarketState(journal=KeepEquipmentMarketJournal(identity=x.identity,pending=listOf(r)),selectedKey=x.key,paymentReview=x.row.charterObject("review"));assertEquals("RESERVATION CLOSED",keepMarketPill(r).label);assertNull(keepMarketPrimary(state));assertNull(keepMarketReleaseAction(r));assertFalse(keepMarketCanRecover(r))};Unit
 }

 @Test fun `fragment Resources UI names protected stock without invented crafting or travel capability`() {
  assertTrue("crystal_fragment" in keepMarketItems("resources"));assertFalse("crystal_fragment" in keepMarketItems("items"))
  assertEquals("Crystal Fragment",keepMarketName("crystal_fragment"))
  assertEquals(setOf("available","marketOutgoing","marketIncoming"),keepMarketStockLabels("crystal_fragment").map{it.first}.toSet())
  val note=requireNotNull(keepMarketStockNote("crystal_fragment"));assertTrue(note.contains("Protected kingdom stock"));assertTrue(note.contains("unclaimed awards and island shares"))
  assertNull(keepMarketStockNote("frostglass"));assertNull(keepMarketStockNote("route_compass"))
 }

}
