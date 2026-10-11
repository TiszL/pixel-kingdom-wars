package gg.pixelkingdomwars.nativeclient.wallet
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedHttpPairTest {
 private fun JsonObject.s(k:String)=getValue(k).jsonPrimitive.content
 private fun input(p:JsonObject):MiningClaimSigningInput{
  val i=p.getValue("identity").jsonObject;val l=p.getValue("leaf").jsonObject;val f=p.getValue("format").jsonObject;val t=f.getValue("lookupTable").jsonObject;val pin=f.getValue("expectedLookupTable").jsonObject
  return MiningClaimSigningInput(p.s("wallet"),MiningClaimSigningTrust(i.s("genesisHash"),i.s("programId"),i.s("configAddress"),i.s("keepMint"),i.s("reserveOwner")),p.s("rootSequence"),l.s("wallet"),l.s("rootSequence"),l.s("cumulativeKeepBaseUnits"),l.s("cumulativeRenown"),l.s("cumulativeDays"),p.getValue("proof").jsonArray.map{v->v.jsonObject.let{MiningClaimProofNode(it.s("hash"),it.s("sumBaseUnits"),it.getValue("isLeft").jsonPrimitive.boolean)}},p.getValue("needsAta").jsonPrimitive.boolean,p.getValue("needsMinerRecords").jsonPrimitive.boolean,p.getValue("transactions").jsonArray.map{v->v.jsonObject.let{MiningClaimSigningMessage(it.getValue("ordinal").jsonPrimitive.int,it.s("kind"),it.s("version"),it.s("message"),it.getValue("lookupTables").jsonArray.map{n->n.jsonObject.s("address")},it.s("feePayer"),it.s("blockhash"))}},MiningClaimOrderedFormat(t.s("address"),t.s("owner"),t.getValue("executable").jsonPrimitive.boolean,t.s("dataHex"),t.getValue("slot").jsonPrimitive.long,pin.s("address"),pin.s("dataSha256"),f.getValue("blockhashContextSlot").jsonPrimitive.long))
 }
 @Test fun `actual API setup and continuation child signatures verify only against independently reconstructed original packets`()=runBlocking {
  val bytes=requireNotNull(javaClass.getResourceAsStream("/mining-ordered-http-pair.json")).readBytes();assertEquals("d12c87983029fcc51687046c4770dd45b85f7ceed10fb4c15cc623c0b1562e92",MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)});val raw=Json.parseToJsonElement(bytes.decodeToString()).jsonObject
  val t=raw.getValue("trust").jsonObject;val pin=t.getValue("orderedLookupTable").jsonObject;val trust=MiningClaimSigningTrust(t.s("genesisHash"),t.s("programId"),t.s("configAddress"),t.s("keepMint"),t.s("reserveOwner"),MiningClaimOrderedPin(pin.s("address"),pin.s("dataSha256")))
  val parent=input(raw.getValue("prepared").jsonObject);val child=input(raw.getValue("continuation").jsonObject.getValue("continuation").jsonObject.getValue("childPreparation").jsonObject)
  for((p,key)in listOf(parent to "setupWire",child to "childWire")){val prepared=MiningClaimTransaction.prepare(p,trust,0,200000);val signed=prepared.verifySignedBase64(raw.s(key));assertEquals(signed,verifyOrderedMiningClaimWire(p.wallet,p.transactions[0].blockhash,p.transactions[0].message,signed.wire,0))}
  assertNotNull(runCatching{MiningClaimTransaction.prepare(parent,trust,0,200000).verifySignedBase64(raw.s("childWire"))}.exceptionOrNull());Unit
 }
}
