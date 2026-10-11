package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class VehicleStoreTest {
 private val f=VehicleFixtures
 private fun rejects(block:suspend ()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 @Test fun `unknown burn retains original destination and prevents another key or cross-kind asset burn`()=runBlocking {
  val m=VehicleFixtures.Memory();val id=f.identity();val s=VehicleStore(m,id);val r=s.begin("installation",f.request.charterText("idempotencyKey"),f.request,f.policy)
  val reopened=VehicleStore(m,id);assertEquals(f.request,reopened.record(r.id).request)
  rejects{reopened.begin("installation","new",JsonObject(f.request+("idempotencyKey" to JsonPrimitive("new"))),f.policy)}
  val service=VehicleProtocol.request(f.rows[1].charterObject("client"));rejects{reopened.begin("service",service.charterText("idempotencyKey"),JsonObject(service+("assetId" to f.request.getValue("assetId"))),f.policy)};Unit
 }
 @Test fun `exact wallet evidence survives serialized restart and cannot prompt again`()=runBlocking {
  val m=VehicleFixtures.Memory();val id=f.identity();val s=VehicleStore(m,id);val r=s.adopt(f.client,f.policy);s.consent(r.id,VehicleConsent(f.client,f.pins.toJson()));s.attempt(r.id,"wallet");s.signed(r.id,f.wire)
  val next=VehicleStore(m,id);assertEquals(f.wire,next.record(r.id).signed);rejects{next.attempt(r.id,"wallet")};Unit
 }
 @Test fun `late verified bytes remain latched through storage failure before stale callback refusal`()=runBlocking {
  val m=VehicleFixtures.Memory();val id=f.identity();val s=VehicleStore(m,id);val r=s.adopt(f.client,f.policy);s.consent(r.id,VehicleConsent(f.client,f.pins.toJson()));s.attempt(r.id,"wallet");m.failRead=true
  rejects{s.signed(r.id,f.wire)};m.failRead=false;assertEquals(f.wire,VehicleStore(m,id).record(r.id).signed);Unit
 }
 @Test fun `invalid owned response is retained and held across restart`()=runBlocking {
  val m=VehicleFixtures.Memory();val id=f.identity();val s=VehicleStore(m,id);val r=s.adopt(f.client,f.policy);val bad=f.change(f.client,"record.wallet",f.client.charterOptional("consentSource")!!.getValue("genesisHash"));m.fail=true
  rejects{s.observe(r.id,bad)};m.fail=false;val reopened=VehicleStore(m,id);assertTrue(reopened.record(r.id).held);assertTrue(bad in reopened.record(r.id).observations);rejects{reopened.accept(r.id,bad)};rejects{reopened.attempt(r.id,"prepare")};Unit
 }
 @Test fun `terminal lost-wire evidence validates real signature and cannot regress or change destination`()=runBlocking {
  val m=VehicleFixtures.Memory();val id=f.identity();val s=VehicleStore(m,id);val end=f.terminal();val r=s.adopt(end,f.policy);assertTrue(s.isTerminal(r));assertEquals(end,VehicleStore(m,id).record(r.id).response)
  rejects{s.accept(r.id,f.client)};rejects{s.accept(r.id,f.change(end,"record.reservation.request.baseId",JsonPrimitive(UUID.randomUUID().toString())))};rejects{s.accept(r.id,f.change(end,"burnReceipt.wireSha256",JsonPrimitive("b".repeat(64))))};Unit
 }
 @Test fun `archive verifies originals and never evicts unresolved entries at pending or archive limit`()=runBlocking {
  val m=VehicleFixtures.Memory();val id=f.identity();val s=VehicleStore(m,id);val r=s.adopt(f.terminal(),f.policy);s.archive(r.id,r);assertTrue(s.read().pending.isEmpty());assertEquals(r,s.read().archives.single())
  val p=f.policy.bound("localPendingLimit").toInt();val records=(0 until p).map{val key=UUID.randomUUID().toString();VehicleRecord(UUID.randomUUID().toString(),"collect",key,buildJsonObject{put("baseId",UUID.randomUUID().toString())},f.policy.raw)}
  m.value=Json.encodeToString(VehicleJournal.serializer(),VehicleJournal(identity=id,pending=records));val before=m.value
  rejects{s.begin("collect",UUID.randomUUID().toString(),buildJsonObject{put("baseId",f.base)},f.policy)};assertEquals(before,m.value);assertEquals(p,s.read().pending.size);Unit
 }
 @Test fun `reopened intent key request and consent cannot be remapped`()=runBlocking {
  val m=VehicleFixtures.Memory();val id=f.identity();val s=VehicleStore(m,id);s.adopt(f.client,f.policy);val saved=requireNotNull(m.value);val raw=Json.parseToJsonElement(saved).jsonObject;val r=raw.getValue("pending").jsonArray.single().jsonObject
  for(change in listOf("key" to JsonPrimitive("other"),"kind" to JsonPrimitive("service"),"request" to JsonObject(f.request+("baseId" to JsonPrimitive(UUID.randomUUID().toString()))))){m.value=JsonObject(raw+("pending" to JsonArray(listOf(JsonObject(r+change))))).toString();rejects{VehicleStore(m,id).read()}}
  m.value=saved;assertEquals(f.client,VehicleStore(m,id).read().records.single().response);Unit
 }
 @Test fun `repeated accepted reads do not consume unresolved observation capacity before a terminal arrives`()=runBlocking {
  val s=VehicleStore(VehicleFixtures.Memory(),f.identity());val r=s.adopt(f.client,f.policy)
  repeat(70){i->val next=f.change(f.client,"record.serverNow",JsonPrimitive("2035-01-01T00:00:00.${i.toString().padStart(3,'0')}Z"));s.observe(r.id,next);s.accept(r.id,next)}
  assertTrue(s.record(r.id).observations.isEmpty());val end=f.terminal();s.observe(r.id,end);s.accept(r.id,end);assertEquals(end,s.record(r.id).response);Unit
 }
 @Test fun `archive full refuses without deleting terminal or pending evidence`()=runBlocking {
  val m=VehicleFixtures.Memory();val id=f.identity();val s=VehicleStore(m,id);val r=s.adopt(f.terminal(),f.policy)
  val archived=(0 until f.policy.bound("localArchiveLimit").toInt()).map{val key=UUID.randomUUID().toString();VehicleRecord(UUID.randomUUID().toString(),"collect",key,buildJsonObject{put("baseId",f.base)},f.policy.raw,response=buildJsonObject{put("baseId",f.base);put("serverNow","2035-01-01T00:00:00.000Z");put("returned",0)})}
  m.value=Json.encodeToString(VehicleJournal.serializer(),VehicleJournal(identity=id,pending=listOf(r),archives=archived));val before=m.value;rejects{s.archive(r.id,r)};assertEquals(before,m.value);Unit
 }
}
