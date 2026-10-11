package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
class RetirementStoreTest {
 private val f=RetirementFixtures
 @Test fun `unknown original blocks replacement across serialized restart`()=runBlocking {val m=CharterFixtures.Memory();val id=f.identity();val s=RetirementStore(m,id);s.begin(f.key,f.clan);s.attempt(f.key,"create");val reopened=RetirementStore(m,id);assertEquals(f.clan,reopened.record(f.key).clanId);assertNotNull(runCatching{reopened.begin(UUID.randomUUID().toString(),f.clan)}.exceptionOrNull());Unit}
 @Test fun `late verified signature drains through failed storage before another prompt`()=runBlocking {val m=CharterFixtures.Memory();val id=f.identity();val s=RetirementStore(m,id);f.saved(s);s.review(f.key,f.review());s.attempt(f.key,"wallet");val wire=f.wire();m.failRead=true;assertNotNull(runCatching{s.signed(f.key,wire)}.exceptionOrNull());m.failRead=false;val reopened=RetirementStore(m,id);assertEquals(wire,reopened.record(f.key).signed);assertNotNull(runCatching{reopened.attempt(f.key,"wallet")}.exceptionOrNull());Unit}
 @Test fun `malformed terminal is retained and cannot authorize more effects`()=runBlocking {val m=CharterFixtures.Memory();val id=f.identity();val s=RetirementStore(m,id);f.saved(s);val bad=JsonObject(f.draft+("cancelled" to JsonPrimitive(true)));m.fail=true;assertNotNull(runCatching{s.observe(f.key,bad)}.exceptionOrNull());m.fail=false;val reopened=RetirementStore(m,id);assertTrue(reopened.record(f.key).held);assertEquals(bad,reopened.record(f.key).observations.last());assertNotNull(runCatching{reopened.accept(f.key,bad)}.exceptionOrNull());assertNotNull("A stale prepared reply must not clear terminal custody",runCatching{reopened.accept(f.key,f.draft)}.exceptionOrNull());assertTrue(reopened.record(f.key).held);assertNotNull(runCatching{reopened.attempt(f.key,"prepare")}.exceptionOrNull());Unit}
 @Test fun `final receipts and payout capture remain immutable`()=runBlocking {val s=RetirementStore(CharterFixtures.Memory(),f.identity());f.saved(s);val completed=f.status("completed");s.observe(f.key,completed);s.accept(f.key,completed);assertNotNull(runCatching{s.accept(f.key,f.draft)}.exceptionOrNull());val changed=JsonObject(completed+("totalShards" to JsonPrimitive("1")));assertNotNull(runCatching{s.accept(f.key,changed)}.exceptionOrNull());assertTrue(s.record(f.key).terminal);Unit}
}
