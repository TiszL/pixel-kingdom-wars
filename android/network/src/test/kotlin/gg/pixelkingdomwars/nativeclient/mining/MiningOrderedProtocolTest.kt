package gg.pixelkingdomwars.nativeclient.mining
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedProtocolTest {
 private val raw=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-ordered-journal.json")).readText()).jsonObject
 private val policy=MiningClaimsProtocolPolicy(9,1,120,200000);private val p=MiningClaimPreparationView.from(raw.getValue("preparation").jsonObject,policy)
 @Test fun `ordered profile is explicit and absent legacy request remains identical`() {
  val key=p.idempotencyKey;assertEquals(buildJsonObject{put("idempotencyKey",key)},MiningClaimPrepareRequest(key).body());assertEquals("ordered-v0",MiningClaimPrepareRequest.from(MiningClaimPrepareRequest(key,"ordered-v0").body()).profile)
  assertEquals(2,p.version);assertEquals(listOf("setup","claim"),p.transactions.map{it.kind});assertThrows(Exception::class.java){p.copy(version=1).validate(policy)};assertThrows(Exception::class.java){p.copy(format=null).validate(policy)}
 }
 @Test fun `frozen format hash owner contexts and separate fees bind the whole plan`() {
  val f=requireNotNull(p.format);for(bad in listOf(f.copy(blockhashContextSlot=f.lookupTable.slot-1),f.copy(lookupTable=f.lookupTable.copy(owner=p.wallet)),f.copy(expectedLookupTable=f.expectedLookupTable.copy(dataSha256="00".repeat(32)))))assertThrows(Exception::class.java){p.copy(format=bad).validate(policy)}
  assertThrows(Exception::class.java){p.copy(fees=p.fees.copy(totalLamports="1")).validate(policy)};assertThrows(Exception::class.java){p.copy(transactions=p.transactions.reversed()).validate(policy)}
 }
 @Test fun `ordinal reviews bind original message and require proven setup for reward`() {
  val reviews=raw.getValue("reviews").jsonArray.map{MiningClaimOrdinalReview.from(it.jsonObject)};reviews.forEachIndexed{i,r->r.bind(p,i)}
  assertThrows(Exception::class.java){reviews[1].copy(setup=null).bind(p,1)};assertThrows(Exception::class.java){reviews[1].copy(messageSha256="00".repeat(32)).bind(p,1)};assertThrows(Exception::class.java){reviews[0].copy(blockHeight=301).validate()}
 }
 @Test fun `continuation preserves leaf identity root and original setup without reinitializing accounts`() {
  val c=MiningClaimContinuation.from(raw.getValue("continuation").jsonObject,policy);assertEquals(c.parentPreparation.leaf,c.childPreparation.leaf);assertFalse(c.childPreparation.needsAta)
  for(bad in listOf(c.copy(expiry=c.expiry.copy(blockHeight=300)),c.copy(setup=c.setup.copy(claimId=c.childClaimId)),c.copy(childPreparation=c.childPreparation.copy(needsAta=true)),c.copy(parentClaimId=c.childClaimId)))assertThrows(Exception::class.java){bad.validate(policy)}
 }
 @Test fun `ordinal review cannot precede its finalized setup account observation`() {
  val review=MiningClaimOrdinalReview.from(raw.getValue("reviews").jsonArray[1].jsonObject);assertThrows(Exception::class.java){review.copy(snapshotSlot=requireNotNull(review.setup).observedAccountSlot-1).validate()}
 }
 @Test fun `continuation quote causality requires distinct original key and fresh observation slots and times`() {
  val c=MiningClaimContinuation.from(raw.getValue("continuation").jsonObject,policy);val child=c.childPreparation;val format=requireNotNull(child.format);val stale=format.lookupTable.copy(slot=c.expiry.slot-1)
  val staleChild=child.copy(format=format.copy(lookupTable=stale),transactions=child.transactions.map{it.copy(lookupTables=listOf(stale))})
  val failure=MiningClaimFailureBinding(1,c.setup.signature,150,181,miningMessageHash(c.parentPreparation.transactions.last().message),c.setup.wireSha256)
  for(bad in listOf(c.copy(childPreparation=child.copy(idempotencyKey=c.parentPreparation.idempotencyKey)),c.copy(expiry=c.expiry.copy(slot=c.setup.observedAccountSlot-1)),c.copy(childPreparation=staleChild),c.copy(createdAt=c.parentPreparation.preparedAt),c.copy(reason="failed",failure=failure)))assertThrows(Exception::class.java){bad.validate(policy)}
 }

}
