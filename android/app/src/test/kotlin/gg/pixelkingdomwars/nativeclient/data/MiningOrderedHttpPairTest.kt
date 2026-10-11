package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningClaimsPhase
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimOrderedPin
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedHttpPairTest {
 @Test fun `actual API pair survives setup restart explicit continuation consent child signature and paid history without provider`()=runBlocking {
  val bytes=requireNotNull(javaClass.getResourceAsStream("/mining-ordered-http-pair.json")).readBytes();assertEquals("d12c87983029fcc51687046c4770dd45b85f7ceed10fb4c15cc623c0b1562e92",MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)});val raw=Json.parseToJsonElement(bytes.decodeToString()).jsonObject;val policy=MiningClaimsProtocolPolicy(9,1,120,200000);val p=MiningClaimPreparationView.from(raw.getValue("prepared").jsonObject,policy)
  val ti=raw.getValue("trust").jsonObject
  fun t(k:String)=ti.getValue(k).jsonPrimitive.content
  val pin=ti.getValue("orderedLookupTable").jsonObject;val trust=MiningClaimSigningTrust(t("genesisHash"),t("programId"),t("configAddress"),t("keepMint"),t("reserveOwner"),MiningClaimOrderedPin(pin.getValue("address").jsonPrimitive.content,pin.getValue("dataSha256").jsonPrimitive.content))
  val memory=MemoryStore();val identity=StarterIdentity("https://pair.test","devnet",p.wallet);var store=MiningClaimsStore(memory,identity);store.begin(store.read(),p.idempotencyKey,policy,"ordered-v0");store.prepareAttempt(store.read());store.acceptPreparation(p.idempotencyKey,p)
  MiningClaimOrdinalReview.from(raw.getValue("review0").jsonObject).bind(p,0);val setup=prepareMiningClaimsSigning(p,policy,trust,0).verifySignedBase64(raw.getValue("setupWire").jsonPrimitive.content);store.signingAttempt(store.read(),0);store.acceptSigned(p.idempotencyKey,setup.wire,0);store.submitAttempt(store.read(),0);store.acceptClaim(p.idempotencyKey,MiningClaimView.from(raw.getValue("setupView").jsonObject));assertTrue(miningClaimsPhase(store.read().operation!!).contains("KEEP NOT YET PAID"))
  store=MiningClaimsStore(memory,identity);val envelope=MiningClaimContinuationEnvelope.from(raw.getValue("continuation").jsonObject,policy);val c=requireNotNull(envelope.continuation);store.continuationAttempt(store.read(),c.childPreparation.idempotencyKey);store.acceptContinuation(p.idempotencyKey,envelope);assertEquals(p.claimId,store.read().operation!!.preparation!!.claimId);store.useContinuation(store.read())
  val child=c.childPreparation;MiningClaimOrdinalReview.from(raw.getValue("childReview").jsonObject).bind(child,0,c.setup);val signed=prepareMiningClaimsSigning(child,policy,trust,0).verifySignedBase64(raw.getValue("childWire").jsonPrimitive.content);store.signingAttempt(store.read(),0);store.acceptSigned(child.idempotencyKey,signed.wire,0);store.submitAttempt(store.read(),0);store.acceptClaim(child.idempotencyKey,MiningClaimView.from(raw.getValue("final").jsonObject));store.finish(store.read())
  val history=MiningClaimsStore(memory,identity).read();assertNull(history.operation);assertEquals(2,history.archives.size);assertNull(history.archives[0].claim!!.settledBaseUnits);assertEquals(p.leaf.cumulativeKeepBaseUnits,history.archives[1].claim!!.settledBaseUnits);assertEquals(setup.signature,history.archives[0].ordered!!.signed.single().signature);assertEquals(c,history.archives[1].ordered!!.parent);Unit
 }
}
