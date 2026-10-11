package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class RetirementHttpPairJournalTest {
 @Test fun `normal HTTP payout and final retirement survive independent verified serialized native history`()=runBlocking {
  val f=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterRetirementHttpPair.json")).readText()).jsonObject
  val prepared=f.charterObject("preparedDraft");val key=prepared.charterObject("request").charterText("idempotencyKey");val clan=prepared.charterObject("clan").charterText("id");val actor=f.charterText("actor")
  val identity=StarterIdentity("https://retirement-http-pair.test","devnet",actor);val memory=CharterFixtures.Memory();val store=RetirementStore(memory,identity)
  store.begin(key,clan);store.observe(key,prepared);store.accept(key,prepared);val op=prepared.charterObject("operation");store.review(key,RetirementReview(op,f.charterObject("trust"),charterCryptoJson(CharterFixtures.crypto)));store.attempt(key,"wallet")
  val signed=f.charterObject("signedDraft");store.signed(key,signed.charterObject("operation").charterObject("signed"));store.observe(key,signed);store.accept(key,signed)
  val completed=f.charterObject("completedDraft");store.observe(key,completed);store.accept(key,completed);val reopened=RetirementStore(memory,identity).record(key)
  assertTrue(reopened.terminal);assertEquals(completed,reopened.response);assertEquals(prepared.getValue("memberPayment"),reopened.response!!.getValue("memberPayment"));assertEquals(signed.charterObject("operation").getValue("signed"),reopened.signed);Unit
 }
}
