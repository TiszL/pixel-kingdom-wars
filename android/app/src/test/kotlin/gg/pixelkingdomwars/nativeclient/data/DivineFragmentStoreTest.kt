package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class DivineFragmentStoreTest {
 private val f=DivineFragmentFixtures
 @Test fun `immutable original survives encrypted restart and foreign actor cannot adopt it`()=runBlocking{val disk=DivineFragmentFixtures.Memory();val id=f.identity();val s=DivineFragmentStore(disk,id);val c=f.command();s.begin(c);s.mark(c.key);assertEquals(s.read(),DivineFragmentStore(DivineFragmentFixtures.Memory(disk.value),id).read());assertTrue(runCatching{DivineFragmentStore(disk,f.identity()).read()}.isFailure);assertTrue(runCatching{s.begin(f.command(key=f.id(9)))}.isFailure)}
 @Test fun `write failure holds original and owned receipt drains after storage recovery`()=runBlocking{val disk=DivineFragmentFixtures.Memory();val s=DivineFragmentStore(disk,f.identity());val c=f.command();s.begin(c);s.mark(c.key);disk.fail=true;assertTrue(runCatching{s.observe(c.key,f.receipt(c))}.isFailure);disk.fail=false;assertEquals(f.receipt(c),s.read().commands.single().receipt)}
 @Test fun `first matching receipt is permanent and cannot redirect stock or change quantity`()=runBlocking{val s=DivineFragmentStore(DivineFragmentFixtures.Memory(),f.identity());val c=f.command();s.begin(c);s.mark(c.key);val r=f.receipt(c);s.observe(c.key,r);for(k in listOf("baseId","eventId","wallet","idempotencyKey")){assertTrue(runCatching{s.observe(c.key,JsonObject(r+(k to JsonPrimitive(f.id(9)))))}.isFailure)};assertEquals(r,s.read().commands.single().receipt)}
 @Test fun `unknown attempted command cannot close or turn into a replacement key`()=runBlocking{val s=DivineFragmentStore(DivineFragmentFixtures.Memory(),f.identity());val c=f.command();s.begin(c);s.mark(c.key);assertTrue(runCatching{s.closeDraft(c.key)}.isFailure);assertTrue(runCatching{s.begin(f.command(key=f.id(8)))}.isFailure);assertTrue(s.read().commands.single().sent)}
 @Test fun `completed history beyond pending limit preserves every receipt and allows next earning`()=runBlocking{val s=DivineFragmentStore(DivineFragmentFixtures.Memory(),f.identity());repeat(f.rules.localLimit+2){val c=f.command(key=f.id(it+100));s.begin(c);s.mark(c.key);s.observe(c.key,f.receipt(c))};val next=f.command(key=f.id(900));s.begin(next);assertEquals(f.rules.localLimit+3,s.read().commands.size);assertEquals(1,s.read().commands.count{it.unresolved})}
 @Test fun `permanent claim binds term hash while accepting later cumulative source growth`()=runBlocking{val s=DivineFragmentStore(DivineFragmentFixtures.Memory(),f.identity());val c=f.command("claim");s.begin(c);s.mark(c.key);val r=JsonObject(f.receipt(c)+mapOf("poolTotal" to JsonPrimitive("13"),"cumulativeTotal" to JsonPrimitive("6"),"quantity" to JsonPrimitive("4"),"stockAfter" to JsonPrimitive("4")));assertTrue(runCatching{s.observe(c.key,JsonObject(r+("termHash" to JsonPrimitive("c".repeat(64)))))}.isFailure);s.observe(c.key,r);assertEquals("4",s.read().commands.single().receipt!!.ft("quantity"))}
 @Test fun `accepted history beyond old aggregate byte ceiling cannot exhaust permanent claim rights`()=runBlocking{
  val json=Json{encodeDefaults=true};val id=f.identity();val sample=f.command(key=f.id(100));val accepted=sample.copy(sent=true,receipt=f.receipt(sample))
  val oldCeiling=2*1024*1024;val bytes=json.encodeToString(DivineFragmentCommand.serializer(),accepted).toByteArray().size
  val count=oldCeiling/bytes+2
  val commands=List(count){i->val c=f.command(key=f.id(i+100));c.copy(sent=true,receipt=f.receipt(c))}
  val text=json.encodeToString(DivineFragmentJournal.serializer(),DivineFragmentJournal(identity=id,revision=count.toLong(),commands=commands))
  assertTrue(text.toByteArray().size>oldCeiling)
  val disk=DivineFragmentFixtures.Memory(text);val store=DivineFragmentStore(disk,id);val next=f.command("claim",f.id(count+100))
  store.begin(next);val saved=store.read();assertEquals(count+1,saved.commands.size);assertEquals(commands,saved.commands.dropLast(1));assertEquals(next,saved.commands.last());assertEquals(1,saved.commands.count{it.unresolved})
 }
}
