package gg.pixelkingdomwars.nativeclient.mining
import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedHttpPairTest {
 @Test fun `actual restricted HTTP parent setup continuation child review and reward receipts preserve exact original binding`() {
  val bytes=requireNotNull(javaClass.getResourceAsStream("/mining-ordered-http-pair.json")).readBytes();assertEquals("d12c87983029fcc51687046c4770dd45b85f7ceed10fb4c15cc623c0b1562e92",MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)});val raw=Json.parseToJsonElement(bytes.decodeToString()).jsonObject;val policy=MiningClaimsProtocolPolicy(9,1,120,200000)
  val p=MiningClaimPreparationView.from(raw.getValue("prepared").jsonObject,policy);assertEquals(2,p.transactions.size);MiningClaimOrdinalReview.from(raw.getValue("review0").jsonObject).bind(p,0);MiningClaimOrdinalReview.from(raw.getValue("review1").jsonObject).bind(p,1)
  val setup=MiningClaimView.from(raw.getValue("setupView").jsonObject);assertNull(setup.settledBaseUnits);assertEquals("0",setup.transactions[0].settledBaseUnits)
  val envelope=MiningClaimContinuationEnvelope.from(raw.getValue("continuation").jsonObject,policy);val c=requireNotNull(envelope.continuation);assertTrue(c.parentPreparation.sameOriginal(p,policy));assertEquals(miningMessageHash(raw.getValue("setupWire").jsonPrimitive.content),c.setup.wireSha256)
  val review=MiningClaimOrdinalReview.from(raw.getValue("childReview").jsonObject);review.bind(c.childPreparation,0,c.setup);val final=MiningClaimView.from(raw.getValue("final").jsonObject);assertEquals(c.childClaimId,final.claimId);assertEquals(p.leaf.cumulativeKeepBaseUnits,final.settledBaseUnits);assertEquals(13,raw.getValue("browserCalls").jsonArray.size)
 }
}
