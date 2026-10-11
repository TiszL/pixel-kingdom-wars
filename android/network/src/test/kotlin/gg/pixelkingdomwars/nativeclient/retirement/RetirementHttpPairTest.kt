package gg.pixelkingdomwars.nativeclient.retirement

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RetirementHttpPairTest {
 @Test fun `actual ordinary HTTP retirement retains its original payout and wallet wire through completion`() {
  val fixture=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterRetirementHttpPair.json")).readText()).jsonObject
  val drafts=listOf("preparedDraft","signedDraft","completedDraft").map{RetirementProtocol.draft(fixture.charterObject(it))}
  val prepared=drafts.first();val operations=drafts.map{it.charterObject("operation")}
  assertEquals(listOf("prepared","signed","completed"),operations.map{it.charterText("status")})
  for(draft in drafts){
   assertEquals(fixture["actor"],draft["actor"])
   for(field in listOf("id","actor","request","clan","fenceId","totalShards","shares","memberPayment"))assertEquals("Historical $field changed",prepared[field],draft[field])
   val byKey=buildJsonObject{put("version",1);put("actor",draft["actor"]!!);put("idempotencyKey",draft.charterObject("request")["idempotencyKey"]!!);put("draft",draft)}
   assertEquals(draft,RetirementProtocol.byKey(byKey,fixture.charterText("actor"),draft.charterObject("request").charterText("idempotencyKey")))
  }
  for(operation in operations)for(field in listOf("original","memberPayment","attempt","preparation"))assertEquals("Signed source $field changed",operations.first()[field],operation[field])
  assertEquals(JsonNull,operations.first()["signed"])
  val signed=RetirementProtocol.wire(operations[1].charterObject("signed"))
  assertEquals(fixture["actualWireHex"],signed["signedTransactionHex"])
  assertEquals(signed,operations.last()["signed"])
  assertEquals("completed",operations.last().charterObject("terminal").charterText("outcome"))
 }
}
