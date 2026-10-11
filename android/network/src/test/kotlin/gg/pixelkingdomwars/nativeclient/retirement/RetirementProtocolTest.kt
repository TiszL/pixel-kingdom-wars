package gg.pixelkingdomwars.nativeclient.retirement

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RetirementProtocolTest {
 private val fixture=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterRetirement.json")).readText()).jsonObject
 private val draft=fixture.charterObject("draft")
 private fun edit(v:JsonObject,path:List<String>,value:JsonElement):JsonObject=JsonObject(v+(path.first() to if(path.size==1)value else edit(v.charterObject(path.first()),path.drop(1),value)))
 @Test fun `shared ephemeral prepared original parses without creating signing authority`() {
  assertEquals(draft,RetirementProtocol.draft(draft));assertEquals(draft.charterObject("operation"),RetirementProtocol.operation(draft.charterObject("operation")))
  val byKey=buildJsonObject{put("version",1);put("actor",draft["actor"]!!);put("idempotencyKey",draft.charterObject("request")["idempotencyKey"]!!);put("draft",draft)}
  assertEquals(draft,RetirementProtocol.byKey(byKey,draft.charterText("actor"),draft.charterObject("request").charterText("idempotencyKey")))
  assertNull(RetirementProtocol.byKey(JsonObject(byKey+("draft" to JsonNull)),draft.charterText("actor"),draft.charterObject("request").charterText("idempotencyKey")))
 }
 @Test fun `refuses authority escalation foreign original and lifecycle or payout disagreement`() {
  val mutations=listOf(
   listOf("retirementAuthorized") to JsonPrimitive(true),listOf("extra") to JsonPrimitive(false),listOf("cancelled") to JsonPrimitive(true),
   listOf("totalShards") to JsonPrimitive("1"),listOf("fenceId") to draft.getValue("id"),listOf("operation","status") to JsonPrimitive("completed"),
   listOf("operation","attempt","quote","packetInput","candidateHex") to JsonPrimitive("00".repeat(161)),
   listOf("operation","attempt","quote","observation","lockId") to JsonPrimitive("01".repeat(16)),
   listOf("operation","attempt","quote","observation","source","programs","economy","programId") to draft.getValue("actor"),
   listOf("operation","attempt","quote","costs","totalLamports") to JsonPrimitive("1"),
   listOf("operation","attempt","quote","packetInput","currentBlockHeight") to JsonPrimitive(999999999),
   listOf("operation","preparation","packet","unsignedTransactionHex") to JsonPrimitive("00".repeat(100)))
  mutations.forEach{(path,value)->assertThrows("Changed $path",Exception::class.java){RetirementProtocol.draft(edit(draft,path,value))}}
  val shares=draft.getValue("shares").jsonArray;assertThrows(Exception::class.java){RetirementProtocol.draft(JsonObject(draft+("shares" to JsonArray(shares+shares))))}
 }
 @Test fun `refuses alternate routes query injection noncanonical keys and extra command fields`() {
  val root=RetirementProtocol.ROOT;val id=draft.charterText("id");val request=draft.charterObject("request")
  validateRetirementRequest("POST",root,emptyMap(),request);validateRetirementRequest("GET","$root/$id",emptyMap(),null)
  for(action in listOf("pay-members","prepare","recover-preparation","deliver","recover","cancel"))validateRetirementRequest("POST","$root/$id/$action",emptyMap(),buildJsonObject{})
  listOf(root,"$root/$id?x=1","$root/$id/extra","$root/by-key/$id/more","$root//${id}","$root/$id%2f","$root/${id.uppercase()}").forEach{path->assertThrows(Exception::class.java){validateRetirementRequest("GET",path,emptyMap(),null)}}
  assertThrows(Exception::class.java){validateRetirementRequest("GET","$root/$id",mapOf("actor" to draft.charterText("actor")),null)}
  assertThrows(Exception::class.java){validateRetirementRequest("POST","$root/$id/cancel",emptyMap(),buildJsonObject{put("verified",true)})}
  assertThrows(Exception::class.java){validateRetirementRequest("POST","$root/$id/signed",emptyMap(),buildJsonObject{put("signedTransaction","not-base64")})}
 }
 @Test fun `bounds hostile response trees and preserves owned immutable copies`() {
  val mutable=draft.toMutableMap();val owned=RetirementProtocol.draft(JsonObject(mutable));mutable["actor"]=JsonPrimitive("changed");assertEquals(draft,owned)
  assertThrows(Exception::class.java){RetirementProtocol.copy(JsonArray(List(257){JsonNull}))}
  assertThrows(Exception::class.java){RetirementProtocol.copy(JsonPrimitive("x".repeat(16497)))}
  var nested:JsonElement=JsonNull;repeat(22){nested=buildJsonObject{put("nested",nested)}};assertThrows(Exception::class.java){RetirementProtocol.copy(nested)}
 }
}
