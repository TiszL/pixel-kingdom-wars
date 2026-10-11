package gg.pixelkingdomwars.nativeclient.charter
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class CharterProtocolTest {
 private val vectors = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterClient.json")).readText()).jsonObject
 @Test fun `canonical creation and both immutable sale participants preserve exact shared ABI`() {
  vectors.getValue("envelopes").jsonObject.values.forEach { value ->
   val envelope = CharterEnvelope.from(value.jsonObject)
   assertEquals(value, envelope.raw)
  }
 }

 private fun envelope()=vectors.getValue("envelopes").jsonObject.getValue("creation").jsonObject
 private fun change(raw:JsonObject,path:String,value:JsonElement):JsonObject {
  val keys=path.split('.');fun set(o:JsonObject,i:Int):JsonObject=JsonObject(o+(keys[i] to if(i==keys.lastIndex)value else set(o.getValue(keys[i]).jsonObject,i+1)))
  return set(raw,0)
 }
 @Test fun `strict nested grammar rejects extra fields coercion unsafe u64 and claimed authority`() {
  val e=envelope()
  for((path,value) in listOf("extra" to JsonPrimitive(true),"version" to JsonPrimitive("1"),"state.signingAuthorized" to JsonPrimitive(true),
   "signing.relayAuthorized" to JsonPrimitive(true),"signing.lookupTable.executable" to JsonPrimitive(true),"signing.observedSlot" to JsonPrimitive(9007199254740992L),
   "signing.costs.totalLamports" to JsonPrimitive("18446744073709551616"),"state.original.price.shards" to JsonPrimitive(5000)))
   assertTrue(path,runCatching{CharterEnvelope.from(change(e,path,value))}.isFailure)
 }
 @Test fun `original identity packet costs and observations remain internally bound`() {
  val e=envelope()
  for((path,value) in listOf("key" to JsonPrimitive("90000000-0000-4000-8000-000000000001"),"signing.context.closingGenesisHash" to JsonPrimitive("11111111111111111111111111111111"),
   "signing.blockhashSlot" to JsonPrimitive(0),"signing.packet.unsignedTransactionHex" to JsonPrimitive("01"),"signing.costs.rentLamports" to JsonPrimitive("1"),
   "signing.original.metadata.name" to JsonPrimitive("Changed Clan"),"state.request.tag" to JsonPrimitive("ZZZ")))
   assertTrue(path,runCatching{CharterEnvelope.from(change(e,path,value))}.isFailure)
 }
 @Test fun `independent economic policy rejects response changes without learning returned policy`() {
  val e=envelope();val policy=CharterProtocolPolicy(3,24,2,5,"5000",500,10000,"1500000")
  policy.validate(CharterEnvelope.from(e))
  assertTrue(runCatching{policy.validate(CharterEnvelope.from(change(e,"state.original.price.shards",JsonPrimitive("5001"))))}.isFailure)
  assertTrue(runCatching{CharterProtocolPolicy.from(JsonObject(policy.toJson()+("nameMax" to JsonPrimitive("24"))))}.isFailure)
 }
 @Test fun `wire signature encoding and incomplete contribution sets cannot claim full custody`() {
  val raw=vectors.getValue("envelopes").jsonObject.getValue("saleBuyer").jsonObject
  val row=vectors.getValue("rows").jsonArray[0].jsonObject
  val both=JsonArray(listOf(row.getValue("buyerContribution"),row.getValue("sellerContribution")))
  assertTrue(runCatching{CharterEnvelope.from(JsonObject(raw+("contributions" to both)))}.isFailure)
  for(v in listOf("AA==", "A".repeat(87)+"=",java.util.Base64.getEncoder().encodeToString(ByteArray(65))))assertTrue(runCatching{CharterGrammar.base64(JsonPrimitive(v),true)}.isFailure)
 }
 @Test fun `private activity and bykey absence remain metadata not effect authority`() {
  val actor=envelope().charterText("actor");val key=envelope().charterText("key")
  val activity=buildJsonObject{put("version",1);put("actor",actor);putJsonObject("newActions"){put("creation",false);put("sale",false)};put("items",JsonArray(emptyList()));put("nextCursor",JsonNull)}
  assertTrue(CharterActivity.from(activity).items.isEmpty())
  assertNull(charterSaleByKey(buildJsonObject{put("version",1);put("actor",actor);put("idempotencyKey",key);put("sale",JsonNull)},actor,key))
  assertTrue(runCatching{CharterActivity.from(JsonObject(activity+("nextCursor" to JsonPrimitive("bad cursor"))))}.isFailure)
 }
 @Test fun `creation requests reject unsafe name URI shaped input and unknown fields before HTTP`() {
  val request=envelope().charterObject("state").charterObject("request")
  validateCharterRequest("POST","/clans/charter/client/creations",emptyMap(),request)
  for(value in listOf(JsonObject(request+("name" to JsonPrimitive("<img>"))),JsonObject(request+("inviteMode" to JsonPrimitive("everyone"))),JsonObject(request+("price" to JsonPrimitive("1")))))
   assertTrue(runCatching{validateCharterRequest("POST","/clans/charter/client/creations",emptyMap(),value)}.isFailure)
 }
}
