package gg.pixelkingdomwars.nativeclient.wallet
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class RetirementTransactionTest {
 private val f=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterRetirement.json")).readText()).jsonObject
 private val op=f.getValue("draft").jsonObject.getValue("operation").jsonObject
 private val actor=f.getValue("draft").jsonObject.getValue("actor").jsonPrimitive.content
 private val trust=CharterSigningTrust.from(f.getValue("trust").jsonObject)
 // Explicit canonical constants fixture, not runtime defaults.
 private val policy=CharterCryptoPolicy(400000,600,540,"1500000",500,10000)
 private val bytes=cHex(f.getValue("wireHex").jsonPrimitive.content,66,1232)
 private fun change(v:JsonObject,path:String,value:JsonElement):JsonObject{val p=path.split('.',limit=2);return JsonObject(v+(p[0] to if(p.size==1)value else change(v.getValue(p[0]).jsonObject,p[1],value)))}
 private suspend fun reject(block:suspend()->Unit){assertNotNull(runCatching{block()}.exceptionOrNull())}
 @Test fun `purpose nine reconstructs public backend bytes and only original leader signature`()=runBlocking {
  val p=RetirementTransaction.prepare(op,trust,actor,policy);assertEquals("retirement",p.kind);assertArrayEquals(bytes.copyOfRange(65,bytes.size),p.unsignedTransaction().copyOfRange(65,bytes.size))
  val wire=RetirementTransaction.toWire(p,p.verifySigned(bytes));assertEquals(wire,RetirementTransaction.verifyWire(op,trust,wire,policy));Unit
 }
 @Test fun `changed permanent clearance and revision cannot borrow the original approval`()=runBlocking {
  for((path,value) in listOf("clearanceHash" to JsonPrimitive("01".repeat(32)),"expectedRevision" to JsonPrimitive(99),"fenceId" to JsonPrimitive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))){val changed=change(op,"original.retirement.$path",value);reject{RetirementTransaction.prepare(change(changed,"attempt.quote.packetInput.original",changed.getValue("original")),trust,actor,policy)}}
 }
 @Test fun `installed trust leader and compute policy are independent of response`()=runBlocking {
  reject{RetirementTransaction.prepare(op,trust,f.getValue("trust").jsonObject.getValue("policySigner").jsonPrimitive.content,policy)}
  reject{RetirementTransaction.prepare(op,CharterSigningTrust.from(change(trust.toJson(),"deployment.economy.reviewedProgramDataSha256",JsonPrimitive("00".repeat(32)))),actor,policy)}
  reject{RetirementTransaction.prepare(op,trust,actor,policy.copy(computeUnitLimit=policy.computeUnitLimit-1))}
 }
 @Test fun `policy signature final packet and unsigned template cannot drift`()=runBlocking {
  for(path in listOf("preparation.policySignatureHex","preparation.packet.messageSha256","attempt.quote.template.messageSha256")){val n=if(path.endsWith("policySignatureHex"))64 else 32;reject{RetirementTransaction.prepare(change(op,path,JsonPrimitive("00".repeat(n))),trust,actor,policy)}}
 }
 @Test fun `wallet mutation or extra transaction never becomes retained evidence`()=runBlocking {
  val p=RetirementTransaction.prepare(op,trust,actor,policy);for(at in listOf(0,1,65,bytes.lastIndex)){val bad=bytes.copyOf();bad[at]=(bad[at].toInt() xor 1).toByte();reject{p.verifySigned(bad)}};reject{p.verifySigned(bytes+byteArrayOf(0))}
 }
 @Test fun `completed original reconstructs without granting another approval`()=runBlocking {
  val p=RetirementTransaction.prepare(op,trust,actor,policy);val wire=RetirementTransaction.toWire(p,p.verifySigned(bytes));val terminal=buildJsonObject{put("id","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");put("outcome","completed")}
  val old=JsonObject(op+mapOf("signed" to wire,"status" to JsonPrimitive("completed"),"terminal" to terminal));val saved=RetirementTransaction.prepare(old,trust,actor,policy);assertArrayEquals(bytes,saved.unsignedTransaction());assertEquals(wire,RetirementTransaction.verifyWire(old,trust,wire,policy));Unit
 }
}
