package gg.pixelkingdomwars.nativeclient.wallet
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
/** Captured ordinary authenticated API and independent browser wallet journey;
 * only public originals/signatures are imported, never signing keys. */
class RetirementHttpPairTest {
 @Test fun `normal HTTP original and real browser signature independently reconstruct in Kotlin`()=runBlocking {
  val f=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterRetirementHttpPair.json")).readText()).jsonObject
  val op=f.getValue("preparedDraft").jsonObject.getValue("operation").jsonObject;val trust=CharterSigningTrust.from(f.getValue("trust").jsonObject);val actor=f.getValue("actor").jsonPrimitive.content
  val policy=CharterCryptoPolicy(400000,600,540,"1500000",500,10000);val bytes=cHex(f.getValue("actualWireHex").jsonPrimitive.content,66,1232)
  val prepared=RetirementTransaction.prepare(op,trust,actor,policy);assertArrayEquals(bytes.copyOfRange(65,bytes.size),prepared.unsignedTransaction().copyOfRange(65,bytes.size));val wire=RetirementTransaction.toWire(prepared,prepared.verifySigned(bytes))
  for(key in listOf("signedDraft","completedDraft")){val historical=f.getValue(key).jsonObject.getValue("operation").jsonObject;assertEquals(historical.getValue("signed"),wire);assertEquals(wire,RetirementTransaction.verifyWire(historical,trust,wire,policy))};Unit
 }
}
