package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.wallet.KeepEquipmentMarketSigningTrust
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepEquipmentMarketStoreTest {
 private val f=KeepEquipmentMarketFixtures
 private fun rejects(block:suspend()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 @Test fun `all real signed and delivered originals survive restart without installing trust`()=runBlocking {
  for(row in f.rows){val x=KeepEquipmentMarketFixtures.Fixture(row);x.adopt(row.charterObject("signedPurchase"));x.store.retain(x.key,row.charterObject("deliveredPurchase"));val restart=KeepEquipmentMarketStore(x.memory,x.identity);val saved=restart.record(x.key);assertEquals(row.charterObject("deliveredPurchase"),saved.response);restart.archive(x.key,saved);assertEquals(1,restart.read().archives.size);assertEquals(0,restart.read().pending.size)};Unit
 }
 @Test fun `foreign actor or replaced preparation is held with evidence and original preserved`()=runBlocking {
  for(path in listOf("fill.buyerWallet","preparation.messageSha256")){val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val changed=f.change(x.purchase,path,if(path.endsWith("buyerWallet"))x.fill.getValue("sellerWallet")else JsonPrimitive("00".repeat(32)));rejects{x.store.retain(x.key,changed)};val saved=x.store.record(x.key);assertTrue(saved.held);assertEquals(x.purchase,saved.response);assertEquals(listOf(changed),saved.observations);rejects{x.store.archive(x.key,saved)}};Unit
 }
 @Test fun `unresolved fill and ambiguous wallet markers cannot be archived or closed`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val saved=x.store.record(x.key);rejects{x.store.archive(x.key,saved)};rejects{x.store.discard(x.key)};x.store.attempt(x.key,"wallet");rejects{x.store.attempt(x.key,"wallet")};assertEquals(listOf("wallet"),x.store.record(x.key).attempts);Unit
 }
 @Test fun `write failure blocks wallet transition and never clears old bytes`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val before=x.memory.value;x.memory.fail=true;rejects{x.store.attempt(x.key,"wallet")};assertEquals(before,x.memory.value);x.memory.fail=false;assertTrue(x.store.record(x.key).attempts.isEmpty());Unit
 }
 @Test fun `late signed bytes drain after a transient encrypted store write failure`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();x.store.consent(x.key,KeepEquipmentMarketConsent(x.purchase,x.row.charterObject("review"),KeepEquipmentMarketSigningTrust.from(x.row.charterObject("trust")).toJson()));x.store.attempt(x.key,"wallet");x.memory.fail=true;rejects{x.store.signed(x.key,x.wire)};x.memory.fail=false;assertEquals(x.wire,KeepEquipmentMarketStore(x.memory,x.identity).record(x.key).signed);Unit
 }
 @Test fun `malformed or identity swapped journal remains intact for recovery`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();x.adopt();val original=x.memory.value!!;x.memory.value="{broken";rejects{x.store.read()};assertEquals("{broken",x.memory.value);x.memory.value=original;rejects{KeepEquipmentMarketStore(x.memory,x.identity.copy(origin="https://other.test")).read()};assertEquals(original,x.memory.value);Unit
 }
 @Test fun `pending journal capacity never evicts an original`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();repeat(32){val key=UUID.randomUUID().toString();val req=buildJsonObject{put("idempotencyKey",key);put("baseId",UUID.randomUUID().toString());put("itemId","route_compass");put("quantity","1");put("unitPriceBaseUnits","1000001")};x.store.begin(KeepEquipmentMarketRecord("listing",key,req,f.policy))};val before=x.memory.value;val key=UUID.randomUUID().toString();rejects{x.store.begin(KeepEquipmentMarketRecord("listing",key,buildJsonObject{put("idempotencyKey",key);put("baseId",x.base);put("itemId","route_compass");put("quantity","1");put("unitPriceBaseUnits","1000001")},f.policy))};assertEquals(before,x.memory.value);assertEquals(32,x.store.read().pending.size);Unit
 }
 @Test fun `same original id cannot change request after restart`()=runBlocking {
  val x=KeepEquipmentMarketFixtures.Fixture();val first=x.adopt();val next=first.copy(response=null,request=f.change(first.request,"quantity",JsonPrimitive("2")));rejects{KeepEquipmentMarketStore(x.memory,x.identity).begin(next)};assertEquals(first,x.store.record(x.key));Unit
 }
 @Test fun `both released terminal receipts archive and survive cold restart without losing originals`()=runBlocking {
  for(failed in listOf(false,true)){val x=KeepEquipmentMarketFixtures.Fixture();val released=f.released(x.row,failed);x.adopt(released);val saved=x.store.record(x.key);assertTrue(x.store.terminal(saved));rejects{x.store.attempt(x.key,"wallet")};x.store.archive(x.key,saved);val cold=KeepEquipmentMarketStore(x.memory,x.identity);assertEquals(released,cold.read().archives.single().response)};Unit
 }
 @Test fun `terminal release never regresses to active or delivered and keeps contradictory evidence held`()=runBlocking {
  for(failed in listOf(false,true)){val x=KeepEquipmentMarketFixtures.Fixture();val released=f.released(x.row,failed);x.adopt(released);rejects{x.store.retain(x.key,if(failed)x.row.charterObject("deliveredPurchase")else f.reserved(x.row))};val saved=x.store.record(x.key);assertEquals(released,saved.response);assertTrue(saved.held);assertTrue(saved.observations.isNotEmpty())};Unit
 }

}
