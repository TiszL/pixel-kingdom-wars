package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepEquipmentMarketRepositoryTest {
 private val f=KeepEquipmentMarketFixtures
 private suspend fun archivedListing(x:KeepEquipmentMarketFixtures.Fixture):KeepEquipmentMarketRecord {
  val listing=JsonObject(x.listing+mapOf("id" to JsonPrimitive(java.util.UUID.randomUUID().toString()),"sellerWallet" to JsonPrimitive(x.wallet),"sellerBaseId" to JsonPrimitive(x.base)))
  val saved=x.store.adopt("listing",listing,f.policy);x.store.archive(saved.key,saved);return saved
 }
 private fun rejects(block:suspend()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 @Test fun `review saves exact draft and first POST requires explicit confirmation`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();repo.reviewListing("route_compass","2","1000001");assertTrue(x.posts.isEmpty());assertEquals("2",x.store.record(x.key).request.charterText("quantity"));repo.confirm();assertEquals(1,x.posts.size);assertNull(repo.state.value.commandReview);assertNotNull(x.store.record(x.key).response);Unit
 }
 @Test fun `restart checks originals without POST and unsent draft cannot bypass confirmation`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.repo().reviewListing("survey_lens","3","1000001");val cold=x.repo();cold.open();rejects{cold.retry(x.key)};assertTrue(x.posts.isEmpty());cold.reviewSaved(x.key);assertEquals("3",cold.state.value.commandReview!!.request.charterText("quantity"));cold.confirm();assertEquals(1,x.posts.size);Unit
 }
 @Test fun `saved base and policy changes hold first confirmation without replacing original`()=runBlocking {
  for(change in listOf("base","policy")){val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();repo.reviewListing("route_compass","2","1000001");val original=x.store.record(x.key);if(change=="base")x.selected=java.util.UUID.randomUUID().toString()else x.currentPolicy=f.change(f.policy,"minFillBaseUnits",JsonPrimitive("1000002"));rejects{repo.confirm()};assertEquals(original,x.store.record(x.key));assertTrue(x.posts.isEmpty())};Unit
 }
 @Test fun `partial fill freezes displayed price quantity and destination before any POST`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();repo.reviewFill(x.listing,"1");val saved=x.store.record(x.key);assertEquals(x.listing,saved.preview);assertEquals(x.base,saved.request.charterText("buyerBaseId"));assertTrue(x.posts.isEmpty());x.listing=f.change(x.listing,"unitPriceBaseUnits",JsonPrimitive("2000001"));rejects{repo.confirm()};assertEquals(saved,x.store.record(x.key));assertTrue(x.posts.isEmpty());Unit
 }
 @Test fun `lost first writes recover their exact receipt while paused or after transfer`()=runBlocking {
  for(kind in listOf("listing","fill","cancellation")){val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();when(kind){"listing"->repo.reviewListing("route_compass","1","1000001");"fill"->repo.reviewFill(x.listing,"1");else->{x.listing=f.change(x.listing,"sellerBaseId",JsonPrimitive(x.base));repo.reviewCancel(x.listing)}};x.failPost=x.store.path(kind).substringAfterLast('/');rejects{repo.confirm()};assertNull(x.store.record(x.key).response);x.allowed=false;x.owned=false;x.failPost=null;val cold=x.repo();cold.retry(x.key);assertNotNull(x.store.record(x.key).response);assertEquals(1,x.posts.size)};Unit
 }
 @Test fun `accepted fill checks and opens do not prepare or sign automatically`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt(f.reserved(x.row));val repo=x.repo();repo.open();repo.selectSaved(x.key);repo.check();assertTrue(x.posts.isEmpty());assertEquals(0,x.approvals);Unit
 }
 @Test fun `original consent signs once after base transfer and persists exact wire before send`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();x.owned=false;val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();assertEquals(0,x.approvals);repo.approve();assertEquals(x.wire,x.store.record(x.key).signed);assertEquals(1,x.approvals);assertEquals(2,x.liveChecks);assertFalse(x.posts.any{it.second.endsWith("/signed")||it.second.endsWith("/deliver")});rejects{repo.approve()};Unit
 }
 @Test fun `wallet setup failure leaves original eligible for a new explicit review`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();x.failSetup=true;rejects{repo.approve()};assertFalse("wallet" in x.store.record(x.key).attempts);x.failSetup=false;repo.reviewPayment();repo.approve();assertEquals(1,x.approvals);Unit
 }
 @Test fun `uncertain wallet invocation never permits replacement approval`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();x.failWallet=true;rejects{repo.approve()};assertTrue("wallet" in x.store.record(x.key).attempts);assertNull(x.store.record(x.key).signed);val cold=x.repo();cold.selectSaved(x.key);rejects{cold.reviewPayment()};cold.command("recover");assertEquals(1,x.approvals);Unit
 }
 @Test fun `late signed bytes remain durable even when session changes during wallet`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();x.lateWallet=true;rejects{repo.approve()};assertEquals(x.wire,x.store.record(x.key).signed);assertEquals(x.wire,KeepEquipmentMarketStore(x.memory,x.identity).record(x.key).signed);Unit
 }
 @Test fun `seller account creation requires explicit full rent cap consent`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture(f.rows.last());x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();rejects{repo.approve()};assertEquals(0,x.approvals);assertFalse("wallet" in x.store.record(x.key).attempts);repo.reviewPayment();repo.approve(true);assertEquals(x.wire,x.store.record(x.key).signed);Unit
 }
 @Test fun `ready server response cannot override independent current hold or missing installed trust`()=runBlocking {
  for(missing in listOf(false,true)){val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);x.configured=!missing;x.failLive=!missing;rejects{repo.reviewPayment()};assertEquals(0,x.approvals);assertTrue(x.store.record(x.key).attempts.isEmpty())};Unit
 }
 @Test fun `expired review and changed fee require renewed explicit consent`()=runBlocking {
  for(change in listOf("time","fee")){val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();if(change=="time")x.clock=30000 else x.reviewCost="5001";rejects{repo.approve()};assertEquals(0,x.approvals);assertFalse("wallet" in x.store.record(x.key).attempts)};Unit
 }
 @Test fun `delivery uploads exact saved wire then reviews current original before explicit send`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();repo.approve();val before=x.posts.size;repo.send();assertEquals(listOf("signed","recover","review","deliver"),x.posts.drop(before).map{it.second.substringAfterLast('/')});assertEquals(x.row.charterObject("deliveredPurchase"),x.store.record(x.key).response);assertEquals(1,x.approvals);assertTrue(x.hydrates>0);Unit
 }
 @Test fun `lost delivery stays same signed original and paused recovery accepts eventual delivery`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();repo.approve();x.failPost="deliver";rejects{repo.send()};assertTrue(x.store.record(x.key).attempts.any{it.startsWith("deliver:")});x.allowed=false;x.configured=false;x.owned=false;x.failPost=null;val cold=x.repo();cold.selectSaved(x.key);cold.command("recover");assertEquals("delivered",x.store.record(x.key).response!!.charterText("status"));assertEquals(1,x.approvals);assertEquals(1,x.posts.count{it.second.endsWith("/deliver")});Unit
 }
 @Test fun `history adoption works without new action trust or ownership and hydrates delivery`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.remote[x.path("fill")]=x.row.charterObject("deliveredPurchase");x.historyItems=JsonArray(listOf(buildJsonObject{put("kind","fill");put("id",x.key);put("baseId",x.base);put("itemId",x.fill.getValue("itemId"));put("createdAt",x.fill.getValue("createdAt"))}));x.owned=false;x.allowed=false;x.configured=false;val repo=x.repo();repo.open();repo.openHistory(x.historyItems.single().jsonObject);assertEquals("delivered",repo.state.value.selected!!.response!!.charterText("status"));assertTrue(x.posts.isEmpty());assertEquals(1,x.hydrates);Unit
 }
 @Test fun `accepted late response retained before changed session prevents presentation`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();repo.reviewListing("route_compass","1","1000001");x.failPost="listings";rejects{repo.confirm()};x.failPost=null;x.failAfterRetain=true;rejects{repo.check()};assertNotNull(x.store.record(x.key).response);assertEquals(1,x.posts.size);Unit
 }
 @Test fun `unsent close never clears accepted or ambiguous originals`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val repo=x.repo();repo.reviewListing("route_compass","1","1000001");repo.discard(x.key);assertTrue(x.store.read().archives.single().discardedUnsent);assertTrue(x.posts.isEmpty());val y=KeepEquipmentMarketFixtures.Fixture();val other=y.repo();other.reviewListing("route_compass","1","1000001");y.failPost="listings";rejects{other.confirm()};rejects{other.discard(y.key)};assertEquals(1,y.store.read().pending.size);Unit
 }
 @Test fun `terminal recovery stops send before any fresh bank check or relay`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt(x.row.charterObject("signedPurchase"));val repo=x.repo();repo.selectSaved(x.key);x.recoverDelivered=true;repo.send();assertEquals(listOf("recover"),x.posts.map{it.second.substringAfterLast('/')});assertEquals(0,x.liveChecks);assertEquals("delivered",x.store.record(x.key).response!!.charterText("status"));Unit
 }
 @Test fun `only exact recovery unavailable code permits fresh checks of same retained wire`()=runBlocking {
  for(code in listOf("KEEP_EQUIPMENT_PAYMENT_NOT_RETAINED","KEEP_EQUIPMENT_PAYMENT_HELD","unavailable")){val x=KeepEquipmentMarketFixtures.Fixture();x.adopt(x.row.charterObject("signedPurchase"));val repo=x.repo();repo.selectSaved(x.key);x.recoveryCode=code;rejects{repo.send()};assertEquals(listOf("recover"),x.posts.map{it.second.substringAfterLast('/')});assertEquals(0,x.liveChecks);assertFalse(x.store.record(x.key).attempts.any{it.startsWith("deliver:")})};Unit
 }
 @Test fun `lost signed upload recovers server original without resigning or uploading replacement`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();repo.approve();x.failPost="signed";rejects{repo.send()};assertEquals(x.wire,x.store.record(x.key).signed);x.failPost=null;val cold=x.repo();cold.selectSaved(x.key);cold.send();assertEquals(1,x.posts.count{it.second.endsWith("/signed")});assertEquals(1,x.approvals);assertEquals("delivered",x.store.record(x.key).response!!.charterText("status"));Unit
 }

 @Test fun `delivery failure before relay allows explicit retry of exact signed wire without another approval`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();repo.approve();x.failBeforePost="deliver";rejects{repo.send()};assertEquals("signed",x.store.record(x.key).response!!.charterText("status"));assertTrue(x.store.record(x.key).attempts.any{it.startsWith("deliver:")});x.failBeforePost=null;val cold=x.repo();cold.selectSaved(x.key);cold.send();assertEquals(1,x.approvals);assertEquals(1,x.posts.count{it.second.endsWith("/signed")});assertEquals(2,x.posts.count{it.second.endsWith("/deliver")});assertEquals(x.wire,x.store.record(x.key).signed);assertEquals("delivered",x.store.record(x.key).response!!.charterText("status"));Unit
 }

 @Test fun `explicit saved payment recovery remains available paused unconfigured and transferred`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt(x.row.charterObject("signedPurchase"));val repo=x.repo();repo.selectSaved(x.key);x.allowed=false;x.configured=false;x.owned=false;x.recoverDelivered=true;repo.command("recover");assertEquals(listOf("recover"),x.posts.map{it.second.substringAfterLast('/')});assertEquals("delivered",x.store.record(x.key).response!!.charterText("status"));assertEquals(0,x.approvals);assertEquals(0,x.liveChecks);Unit
 }

 @Test fun `unprepared reservation release is explicit and remains available paused after transfer`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt(f.reserved(x.row));val repo=x.repo();repo.open();repo.selectSaved(x.key);assertTrue(x.posts.isEmpty());x.allowed=false;x.configured=false;x.owned=false;repo.release();assertEquals(listOf("release"),x.posts.map{it.second.substringAfterLast('/')});assertEquals(f.released(x.row),x.store.record(x.key).response);assertTrue(x.hydrates>0);repo.archive(x.key);assertEquals(1,x.store.read().archives.size);Unit
 }
 @Test fun `lost release reply recovers exact terminal receipt without repeating write`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt(f.reserved(x.row));val repo=x.repo();repo.selectSaved(x.key);x.failPost="release";rejects{repo.release()};assertTrue(x.store.record(x.key).attempts.any{it.startsWith("release:")});assertEquals("reserved",x.store.record(x.key).response!!.charterText("status"));x.failPost=null;x.allowed=false;x.configured=false;x.owned=false;val cold=x.repo();cold.selectSaved(x.key);cold.release();assertEquals("released",x.store.record(x.key).response!!.charterText("status"));assertEquals(1,x.posts.size);Unit
 }
 @Test fun `prepared payment without signature stays unresolved and cannot cancel`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);rejects{repo.release()};assertTrue(x.posts.isEmpty());assertEquals(x.purchase,x.store.record(x.key).response);Unit
 }
 @Test fun `signed failed release retains original proof and permanently removes wallet and relay actions`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt(x.row.charterObject("signedPurchase"));val repo=x.repo();repo.selectSaved(x.key);x.allowed=false;x.configured=false;x.owned=false;repo.release();val end=x.store.record(x.key);assertEquals(f.released(x.row,true),end.response);repo.command("recover");repo.release();assertEquals(1,x.posts.size);x.allowed=true;x.configured=true;rejects{repo.reviewPayment()};repo.send();assertEquals(1,x.posts.size);assertEquals(0,x.approvals);Unit
 }
 @Test fun `unknown signed failure proof holds original instead of inferring cancellation from expiry`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt(x.row.charterObject("signedPurchase"));val repo=x.repo();repo.selectSaved(x.key);x.releaseHeld=true;rejects{repo.release()};assertEquals("signed",x.store.record(x.key).response!!.charterText("status"));assertNull(x.store.record(x.key).response!!["release"]);assertFalse(x.store.terminal(x.store.record(x.key)));Unit
 }
 @Test fun `local signed failure check uploads exact retained wire while paused without sending`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val repo=x.repo();repo.selectSaved(x.key);repo.reviewPayment();repo.approve();val before=x.posts.size;x.allowed=false;x.configured=false;x.owned=false;repo.release();assertEquals(listOf("signed","release"),x.posts.drop(before).map{it.second.substringAfterLast('/')});assertEquals(x.wire,x.store.record(x.key).signed);assertEquals("released",x.store.record(x.key).response!!.charterText("status"));assertEquals(1,x.approvals);assertFalse(x.posts.any{it.second.endsWith("/deliver")});Unit
 }

 @Test fun `cold saved originals remain readable and GET recoverable while account hydration fails`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val archived=archivedListing(x);val original=x.adopt();x.failHydrate=true;x.allowed=false;x.owned=false;x.configured=false
  val cold=x.repo();cold.open();assertEquals(setOf(archived.key,original.key),cold.state.value.journal!!.records.map{it.key}.toSet());assertNull(cold.state.value.stock);assertTrue(cold.state.value.error!!.contains("Saved requests"))
  x.calls.clear();cold.selectSaved(original.key);assertTrue(cold.state.value.error!!.contains("original receipt checks remain available"));cold.check();assertTrue(cold.state.value.error!!.contains("original receipt checks remain available"));assertEquals(listOf("GET" to x.path("fill"),"GET" to x.path("fill")),x.calls);assertEquals(original.request,cold.state.value.selected!!.request)
  x.remote[x.path("fill")]=x.row.charterObject("deliveredPurchase");cold.check();assertEquals("delivered",cold.state.value.selected!!.response!!.charterText("status"));assertEquals(original.request,x.store.record(original.key).request);assertEquals(archived,x.store.read().archives.single());assertNull(cold.state.value.stock);assertTrue(x.posts.isEmpty());assertEquals(0,x.approvals);Unit
 }
 @Test fun `pending hydration holds fresh listing preparation and payment review until refreshed`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();archivedListing(x);val original=x.adopt();x.failHydrate=true;val cold=x.repo();cold.selectSaved(original.key);x.calls.clear()
  rejects{cold.reviewListing("route_compass","1","1000001")};rejects{cold.command("prepare")};rejects{cold.reviewPayment()}
  assertTrue(x.calls.isEmpty());assertNull(cold.state.value.commandReview);assertNull(cold.state.value.paymentReview);assertNull(cold.state.value.stock);assertEquals(original,x.store.record(original.key));assertEquals(0,x.approvals)
  x.failHydrate=false;cold.open();assertNotNull(cold.state.value.stock);assertNull(cold.state.value.error);cold.selectSaved(original.key);cold.reviewPayment();assertNotNull(cold.state.value.paymentReview);assertEquals(listOf("review"),x.posts.map{it.second.substringAfterLast('/')});assertEquals(0,x.approvals);Unit
 }
 @Test fun `same original retry observes GET but cannot resubmit before required hydration`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();archivedListing(x)
  val request=buildJsonObject{put("idempotencyKey",x.key);put("baseId",x.base);put("itemId","route_compass");put("quantity","1");put("unitPriceBaseUnits","1000001")}
  x.store.begin(KeepEquipmentMarketRecord("listing",x.key,request,f.policy));x.store.attempt(x.key,"post",true);val before=x.store.record(x.key);x.failHydrate=true;val cold=x.repo()
  rejects{cold.retry(x.key)};assertEquals(listOf("GET" to x.path("listing")),x.calls);assertEquals(before,x.store.record(x.key));assertTrue(x.posts.isEmpty())
  x.failHydrate=false;cold.retry(x.key);assertEquals(1,x.posts.size);assertEquals(request,x.store.record(x.key).request);assertNotNull(x.store.record(x.key).response);Unit
 }
 @Test fun `hydration cannot swallow cancellation or publish a late original after session change`()=runBlocking {
  for(cancel in listOf(false,true)){
   val x=KeepEquipmentMarketFixtures.Fixture();archivedListing(x);val original=x.adopt();x.remote[x.path("fill")]=x.row.charterObject("deliveredPurchase")
   x.afterHydrate={if(cancel)throw kotlinx.coroutines.CancellationException("Screen stopped")else x.session=false}
   val cold=x.repo();rejects{cold.check()};assertEquals(original.response,cold.state.value.journal!!.pending.single().response);assertEquals("delivered",x.store.record(original.key).response!!.charterText("status"));assertTrue(x.posts.isEmpty());assertEquals(0,x.approvals)
  };Unit
 }

}
