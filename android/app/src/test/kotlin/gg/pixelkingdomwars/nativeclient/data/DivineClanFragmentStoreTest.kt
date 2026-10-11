package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.divinefragments.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DivineClanFragmentStoreTest {
 private val old=DivineFragmentFixtures;private val clan=DivineClanFragmentFixtures
 @Test fun `old individual record remains unchanged when clan delivery enters and survives cold recovery`()=runBlocking {
  val disk=DivineFragmentFixtures.Memory();val identity=old.identity();val store=DivineFragmentStore(disk,identity)
  val individual=old.command();store.begin(individual);store.mark(individual.key);store.observe(individual.key,old.receipt(individual))
  val before=store.read().commands.single();val c=clan.command();store.begin(c);store.mark(c.key)
  val reopened=DivineFragmentStore(DivineFragmentFixtures.Memory(disk.value),identity)
  assertEquals(before,reopened.read().commands.first());assertEquals(c.consent.toString(),reopened.read().commands.last().consent.toString())
  assertEquals(individual.rules,reopened.read().commands.last().rules)
  reopened.observe(c.key,clan.receipt(c));assertEquals(before,reopened.read().commands.first());assertFalse(reopened.read().commands.last().unresolved)
 }
 @Test fun `attempted clan original cannot be abandoned replaced by individual or adopted by another actor`()=runBlocking {
  val disk=DivineFragmentFixtures.Memory();val store=DivineFragmentStore(disk,old.identity());val c=clan.command();store.begin(c);store.mark(c.key)
  assertTrue(runCatching{store.closeDraft(c.key)}.isFailure)
  assertTrue(runCatching{store.begin(old.command())}.isFailure)
  assertTrue(runCatching{DivineFragmentStore(DivineFragmentFixtures.Memory(disk.value),old.identity()).read()}.isFailure)
  assertEquals(c.consent,store.read().commands.single().consent)
 }
 @Test fun `accepted clan receipt is permanent through changed response quantity or domain metadata`()=runBlocking {
  val store=DivineFragmentStore(DivineFragmentFixtures.Memory(),old.identity());val c=clan.command();store.begin(c);store.mark(c.key)
  val receipt=clan.receipt(c);store.observe(c.key,receipt)
  assertTrue(runCatching{store.observe(c.key,JsonObject(receipt+("quantity" to JsonPrimitive("12"))))}.isFailure)
  val changed=JsonObject(c.consent+("award" to JsonObject(c.consent.fo("award")+("sourceHash" to JsonPrimitive("e".repeat(64))))))
  assertTrue(runCatching{store.begin(c.copy(consent=changed))}.isFailure)
  assertEquals(c.consent,store.read().commands.single().consent);assertEquals(receipt,store.read().commands.single().receipt)
 }
}
