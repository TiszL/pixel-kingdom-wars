package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.ui.phasee.equipmentHasUnresolved
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit): a saved request may close only after a fresh by-key GET in the same action
 * answered "unknown" for exactly its key, and never against a receipt. Without this, a sent craft whose reply was lost
 * and whose server record never existed holds its kingdom's only equipment slot, so Workshop crafts and fitted
 * departures there stay blocked forever once paused orders or a changed recipe refuse the retry. */
class EquipmentUnknownCloseTest {
 private val f=EquipmentFixtures
 private class Harness {
  val f=EquipmentFixtures;val disk=EquipmentFixtures.Memory();val identity=f.identity();val store=EquipmentStore(disk,identity)
  var allowed=true;val server=mutableMapOf<String,JsonObject>();val posts=mutableListOf<JsonObject>();val gets=mutableListOf<String>()
  val ports=object:EquipmentPorts {
   override val transport=EquipmentTransport(object:EquipmentPort {override val identity=this@Harness.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit,refusal:suspend(ApiException)->Unit):JsonObject{guard()
     if(method=="POST"){posts+=requireNotNull(body);error("Closing or checking must never send the original again")}
     gets+=path;val key=path.substringAfterLast('/');val raw=server[key]?:f.unknown(store.record(key));retain(raw);guard();return raw}})
   override fun capture(fresh:Boolean):()->Unit{val guard={if(fresh)check(allowed){"Game orders are paused"}};guard();return guard}
   override fun policy()=f.policy;override fun vehiclePolicy()=f.vehicle;override fun selectedBase()=f.base
   override fun requireOwnedBase(base:String){check(base==f.base)};override fun key()=UUID.randomUUID().toString()
   override suspend fun hydrate(guard:()->Unit)=guard()
  }
  fun repo()=EquipmentRepository(store,ports)
  /** A craft whose POST left this device but whose reply never arrived: attempted, no refusal, saved "unknown". */
  suspend fun lostCraft():EquipmentRecord{val r=store.begin(f.record(key=UUID.randomUUID().toString()));store.attempt(r.key);store.retain(r.key,f.unknown(r));return store.record(r.key)}
 }
 private fun rejects(block:suspend()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}

 @Test fun `a saved craft the server does not know cannot block Workshop crafting forever`()=runBlocking{val h=Harness();val lost=h.lostCraft();val repo=h.repo()
  // The dead end: the original holds the kingdom's slot and paused orders refuse its retry.
  rejects{h.store.begin(f.record(key=UUID.randomUUID().toString()))};h.allowed=false;rejects{repo.retry(lost.key)}
  assertTrue(equipmentHasUnresolved(repo.state.value,f.base));assertTrue(h.posts.isEmpty())
  repo.discard(lost.key)
  val closed=h.store.read().archives.single();assertEquals(lost.request,closed.request);assertTrue(closed.closedUnknown);assertFalse(closed.closedRefusal||closed.discardedUnsent)
  assertTrue(h.posts.isEmpty());assertEquals(listOf(h.store.receiptPath(lost)),h.gets.distinct())
  // The door that refused a new craft or fitted departure for this kingdom is open again.
  assertFalse(equipmentHasUnresolved(repo.state.value,f.base));h.store.begin(f.record(key=UUID.randomUUID().toString()));Unit}

 @Test fun `close is refused when the by-key GET shows the craft was accepted`()=runBlocking{val h=Harness();val lost=h.lostCraft();h.server[lost.key]=f.proof(lost);val repo=h.repo()
  rejects{repo.discard(lost.key)}
  val kept=h.store.read().pending.single();assertEquals(lost.key,kept.key);assertEquals("accepted",kept.response!!.charterText("status"));assertFalse(kept.closedUnknown)
  assertTrue(h.store.read().archives.isEmpty());assertTrue(h.posts.isEmpty());Unit}

 @Test fun `only the reply fetched by the closing action can close a sent original`()=runBlocking{val h=Harness();val lost=h.lostCraft()
  // A saved "unknown" from an earlier check is not fresh evidence; neither is a reply that differs from the saved one.
  rejects{h.store.discard(lost.key,lost)}
  rejects{h.store.discard(lost.key,lost,JsonObject(f.unknown(lost)+("serverNow" to JsonPrimitive("2034-12-31T00:00:00.000Z"))))}
  assertEquals(lost,h.store.read().pending.single());assertTrue(h.store.read().archives.isEmpty())
  h.store.discard(lost.key,lost,f.unknown(lost));assertTrue(h.store.read().archives.single().closedUnknown);Unit}

 @Test fun `journals saved before the close flag decode and keep their bytes`()=runBlocking{val h=Harness();val lost=h.lostCraft();val before=requireNotNull(h.disk.value)
  assertFalse(before.contains("closedUnknown"))
  assertEquals(lost,EquipmentStore(EquipmentFixtures.Memory().apply{value=before},h.identity).record(lost.key))
  h.repo().discard(lost.key);assertTrue(requireNotNull(h.disk.value).contains("\"closedUnknown\":true"))
  assertEquals(h.store.read(),EquipmentStore(EquipmentFixtures.Memory().apply{value=h.disk.value},h.identity).read());Unit}
}
