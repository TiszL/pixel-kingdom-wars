package gg.pixelkingdomwars.nativeclient.wallet
import gg.pixelkingdomwars.nativeclient.charter.*
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MigrationHttpPairTest {
 @Test fun `actual normal API purpose five packet independently reconstructs and verifies browser wallet wire`()=runBlocking {
  val bytes=requireNotNull(javaClass.getResourceAsStream("/charterMigrationHttpPair.json")).readBytes();assertEquals("bead2cbe227d6754321ef6ee4df50c002ef52fa6b96fe32f9eaaf964f15ff557",MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)})
  val v=Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject;val m=v.charterObject("preparedMigration");val trust=CharterSigningTrust.from(v.charterObject("trust"));val policy=CharterCryptoPolicy(400000,600,540,"1500000",500,10000)
  val p=MigrationTransaction.prepare(m,trust,v.charterText("actor"),policy);val raw=v.charterText("actualWireHex").chunked(2).map{it.toInt(16).toByte()}.toByteArray();val wire=v.charterObject("signedMigration").charterObject("wire")
  assertEquals(wire,MigrationTransaction.toWire(p,p.verifySigned(raw)));assertEquals(wire,MigrationTransaction.verifyWire(v.charterObject("controlledMigration"),trust,wire,policy));assertTrue(p.unsignedTransaction().size<=1232);Unit
 }
}
