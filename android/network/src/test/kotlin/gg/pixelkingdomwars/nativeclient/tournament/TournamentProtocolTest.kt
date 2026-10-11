package gg.pixelkingdomwars.nativeclient.tournament
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class TournamentProtocolTest {
 private val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterTournamentSigning.json")).readText()).jsonObject
 @Test fun `both lock actions retain the original public source`() {for(row in vectors.getValue("rows").jsonArray){val operation=row.jsonObject.getValue("operation").jsonObject;assertEquals(operation,TournamentProtocol.operation(operation))}}

 private fun first()=vectors.getValue("rows").jsonArray[0].jsonObject.getValue("operation").jsonObject
 @Test fun `terminal status needs a terminal and original roster cannot change`() {val o=first();assertThrows(Exception::class.java){TournamentProtocol.operation(JsonObject(o+("status" to JsonPrimitive("completed"))))};val t=o.getValue("operationTerms").jsonObject;assertThrows(Exception::class.java){TournamentProtocol.operation(JsonObject(o+("operationTerms" to JsonObject(t+("roster" to JsonArray(emptyList()))))))}}
 @Test fun `inventory loss fee mismatch and source substitution fail closed`() {val o=first();val a=o.getValue("attempt").jsonObject;val q=a.getValue("quote").jsonObject
  for(changed in listOf(JsonObject(o+("inventory" to buildJsonObject{put("version",1);put("revision","0");put("count",0);put("messages",JsonArray(emptyList()))})),JsonObject(o+("unexpected" to JsonPrimitive(true))),JsonObject(o+("attempt" to JsonObject(a+("quote" to JsonObject(q+("costs" to JsonObject(q.getValue("costs").jsonObject+("totalLamports" to JsonPrimitive("0"))))))))))) assertThrows(Exception::class.java){TournamentProtocol.operation(changed)}
 }
 @Test fun `commands reject caller targeting rewards and replacement signing bytes`() {val id="12345678-1234-4678-9abc-def012345682";val root="/clans/charter/tournaments";val raid=buildJsonObject{put("baseId",id);put("idempotencyKey",id)}
  validateTournamentRequest("POST","$root/events/$id/raids",emptyMap(),raid)
  for(field in listOf("target","wallet","stars","reward","excludeBaseIds"))assertThrows(Exception::class.java){validateTournamentRequest("POST","$root/events/$id/raids",emptyMap(),JsonObject(raid+(field to JsonPrimitive(id))))}
  assertThrows(Exception::class.java){validateTournamentRequest("POST","$root/operations/$id/prepare",emptyMap(),buildJsonObject{put("blockhash",id)})}
  assertThrows(Exception::class.java){validateTournamentRequest("GET","$root/events/$id",mapOf("actor" to id),null)}
 }
 @Test fun `cancellation is only an explicit original request route`() {val id="12345678-1234-4678-9abc-def012345682";val path="/clans/charter/tournaments/events/$id/raids/by-key/$id/cancel";validateTournamentRequest("POST",path,emptyMap(),buildJsonObject{});assertThrows(Exception::class.java){validateTournamentRequest("POST",path,emptyMap(),buildJsonObject{put("refund",true)})}}
}
