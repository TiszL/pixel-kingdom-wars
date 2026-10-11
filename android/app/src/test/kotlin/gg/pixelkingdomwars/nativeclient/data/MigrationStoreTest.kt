package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MigrationStoreTest {
 private val f=MigrationFixtures
 @Test fun `original review wallet marker and exact wire persist atomically through restart`()=runBlocking {
  val memory=CharterFixtures.Memory();val id=f.identity();val s=MigrationStore(memory,id);f.saved(s);s.review(f.key,f.review());s.attempt(f.key,"wallet");s.signed(f.key,f.wire)
  val r=MigrationStore(memory,id).record(f.key);assertEquals(f.wire,r.signed);assertEquals(f.review(),r.review);assertEquals(f.prepared,r.response);assertNotNull(runCatching{s.attempt(f.key,"wallet")}.exceptionOrNull());Unit
 }
 @Test fun `failed signed persistence retains original custody for the next store instance`()=runBlocking {
  val memory=CharterFixtures.Memory();val id=f.identity();val s=MigrationStore(memory,id);f.saved(s);s.review(f.key,f.review());s.attempt(f.key,"wallet");memory.fail=true;assertNotNull(runCatching{s.signed(f.key,f.wire)}.exceptionOrNull());memory.fail=false;assertEquals(f.wire,MigrationStore(memory,id).record(f.key).signed);Unit
 }
 @Test fun `contradictory terminal claims cannot resolve by choosing a favorable outcome`()=runBlocking {
  val s=MigrationStore(CharterFixtures.Memory(),f.identity());f.saved(s);val bad=JsonObject(f.status("controlled")+("terminal" to buildJsonObject{put("id",f.id);put("outcome","cancelled")}));s.observe(f.key,bad);assertNotNull(runCatching{s.accept(f.key,bad)}.exceptionOrNull())
  for(v in listOf(f.prepared,f.status("controlled"),f.status("cancelled"))){s.observe(f.key,v);assertNotNull(runCatching{s.accept(f.key,v)}.exceptionOrNull());assertTrue(s.record(f.key).held)};Unit
 }
 @Test fun `foreign owned fields and replacement snapshot never overwrite the original`()=runBlocking {
  val s=MigrationStore(CharterFixtures.Memory(),f.identity());f.saved(s);val foreign=JsonObject(f.prepared+("actor" to f.prepared.charterObject("original").charterObject("chain").getValue("economyProgram")));assertNotNull(runCatching{s.observe(f.key,foreign)}.exceptionOrNull());assertFalse(s.record(f.key).held)
  val changed=JsonObject(f.prepared+("snapshot" to JsonObject(f.prepared.charterObject("snapshot")+("chestShards" to JsonPrimitive("8")))));s.observe(f.key,changed);assertNotNull(runCatching{s.accept(f.key,changed)}.exceptionOrNull());assertEquals(f.prepared,s.record(f.key).response);assertTrue(s.record(f.key).held);Unit
 }
}
