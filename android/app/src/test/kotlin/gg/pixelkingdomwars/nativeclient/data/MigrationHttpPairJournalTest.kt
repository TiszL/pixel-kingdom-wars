package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MigrationHttpPairJournalTest {
 @Test fun `actual normal HTTP original approval and finalized same clan receipt reopen without live providers`()=runBlocking {
  val f=MigrationFixtures;val bytes=requireNotNull(javaClass.getResourceAsStream("/charterMigrationHttpPair.json")).readBytes();assertEquals("bead2cbe227d6754321ef6ee4df50c002ef52fa6b96fe32f9eaaf964f15ff557",MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)})
  val memory=CharterFixtures.Memory();val identity=f.identity();val store=MigrationStore(memory,identity);store.begin(f.key,f.clan)
  for(k in listOf("pendingMigration","preparedMigration")){val m=f.vector.charterObject(k);store.observe(f.key,m);store.accept(f.key,m)}
  store.review(f.key,f.review());store.attempt(f.key,"wallet");store.signed(f.key,f.wire)
  for(k in listOf("signedMigration","controlledMigration")){val m=f.vector.charterObject(k);store.observe(f.key,m);store.accept(f.key,m)}
  val reopened=MigrationStore(memory,identity).record(f.key);assertTrue(reopened.terminal);assertFalse(reopened.held);assertEquals(f.wire,reopened.signed);assertEquals(f.vector.charterObject("controlledMigration"),reopened.response);assertEquals(f.prepared.getValue("snapshot"),reopened.response!!.getValue("snapshot"));assertEquals(f.clan,reopened.response!!.charterObject("original").charterText("clanId"));Unit
 }
}
