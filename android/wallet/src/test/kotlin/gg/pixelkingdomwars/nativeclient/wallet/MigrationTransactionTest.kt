package gg.pixelkingdomwars.nativeclient.wallet
import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Public registration vector exercises migration binding; normal HTTP pairing is separate. */
class MigrationTransactionTest {
 private val v=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterMigration.json")).readText()).jsonObject
 private val m=v.charterObject("prepared");private val trust=CharterSigningTrust.from(v.charterObject("trust"));private val actor=m.charterText("actor")
 // Shared PHASE_E_CHARTER_PREPARATION/ADMISSION/SEEKER_AUCTION/POLICY fixture values.
 private val policy=CharterCryptoPolicy(400000,600,540,"1500000",500,10000)
 private fun edit(o:JsonObject,path:String,value:JsonElement):JsonObject{val p=path.split('.',limit=2);return JsonObject(o+(p[0] to if(p.size==1)value else edit(o.charterObject(p[0]),p[1],value)))}
 @Test fun `authentic registration original reconstructs without funded creation envelope`()=runBlocking {
  val p=MigrationTransaction.prepare(m,trust,actor,policy);val wire=v.charterObject("wire");assertEquals(wire,MigrationTransaction.toWire(p,p.verifySignedBase64(wire.charterText("signedTransaction"))))
  assertEquals(wire,MigrationTransaction.verifyWire(m,trust,wire,policy));assertFalse(m.containsKey("price"));assertFalse(m.containsKey("reservation"));Unit
 }
 @Test fun `original clan snapshot payer and migration identity are independently bound`()=runBlocking {
  for((path,value) in listOf("id" to m.charterObject("original").getValue("clanId"),"snapshot.commitment" to JsonPrimitive("00".repeat(32)),"snapshot.clan.name" to JsonPrimitive("Changed"),"actor" to m.charterObject("original").charterObject("chain").getValue("economyProgram"))){assertNotNull(path,runCatching{MigrationTransaction.prepare(edit(m,path,value),trust,actor,policy)}.exceptionOrNull())}
  assertNotNull(runCatching{MigrationTransaction.prepare(m,trust,m.charterObject("original").charterObject("chain").charterText("economyProgram"),policy)}.exceptionOrNull());Unit
 }
 @Test fun `registration purpose policy native instruction and rent cannot be altered`()=runBlocking {
  val signing=m.charterObject("signing");val candidate=signing.charterObject("policy").charterText("candidateHex");val purposeChanged=candidate.substring(0,144)+"09"+candidate.substring(146)
  for((path,value) in listOf("signing.policy.candidateHex" to JsonPrimitive(purposeChanged),"signing.packet.nativeInstructionIndex" to JsonPrimitive(0),"signing.costs.totalLamports" to JsonPrimitive("1"),"signing.original.metadata.uri" to JsonPrimitive("https://invalid.test"))){assertNotNull(path,runCatching{MigrationTransaction.prepare(edit(m,path,value),trust,actor,policy)}.exceptionOrNull())};Unit
 }
 @Test fun `wire signature hashes and exact packet survive historical verification only`()=runBlocking {
  val wire=v.charterObject("wire");for(k in listOf("wireSha256","messageSha256"))assertNotNull(runCatching{MigrationTransaction.verifyWire(m,trust,JsonObject(wire+(k to JsonPrimitive("00".repeat(32)))),policy)}.exceptionOrNull())
  val bytes=java.util.Base64.getDecoder().decode(wire.charterText("signedTransaction"));bytes[1]=(bytes[1].toInt() xor 1).toByte();assertNotNull(runCatching{MigrationTransaction.verifyWire(m,trust,JsonObject(wire+("signedTransaction" to JsonPrimitive(java.util.Base64.getEncoder().encodeToString(bytes)))),policy)}.exceptionOrNull());Unit
 }
}
