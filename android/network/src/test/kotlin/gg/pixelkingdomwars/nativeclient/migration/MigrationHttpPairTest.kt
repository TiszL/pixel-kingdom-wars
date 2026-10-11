package gg.pixelkingdomwars.nativeclient.migration
import gg.pixelkingdomwars.nativeclient.charter.*
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MigrationHttpPairTest {
 @Test fun `actual authenticated API migrations preserve original snapshot and browser signed wire`() {
  val bytes=requireNotNull(javaClass.getResourceAsStream("/charterMigrationHttpPair.json")).readBytes();assertEquals("bead2cbe227d6754321ef6ee4df50c002ef52fa6b96fe32f9eaaf964f15ff557",MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)})
  val v=Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject;val rows=listOf("pendingMigration","preparedMigration","signedMigration","controlledMigration").map{MigrationProtocol.migration(v.charterObject(it))};val first=rows.first()
  rows.forEach{m->listOf("id","actor","request","snapshot","original").forEach{k->assertEquals(first[k],m[k])};assertFalse(m.containsKey("funding"));assertFalse(m.containsKey("price"))}
  val wire=rows[2].charterObject("wire");assertEquals(v.charterText("actualWireHex"),Base64.getDecoder().decode(wire.charterText("signedTransaction")).joinToString(""){"%02x".format(it)});assertEquals(wire,rows[3].charterObject("wire"));assertEquals("controlled",rows[3].charterObject("terminal").charterText("outcome"))
 }
}
