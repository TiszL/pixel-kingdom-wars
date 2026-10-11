package gg.pixelkingdomwars.nativeclient.migration

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Grammar fixture only: the existing public registration packet is reused directly.
 * This is not a claim that a funded creation migrated or a backend migration ran. */
internal object MigrationFixture {
 val creation=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterClient.json")).readText()).jsonObject.charterObject("envelopes").charterObject("creation")
 val signing=creation.charterObject("signing")
 val original=signing.charterObject("original")
 val prepared=buildJsonObject {
  put("version",1);put("id",original.getValue("creationIntentId"));put("actor",original.getValue("payer"))
  put("request",buildJsonObject{put("clanId",original.getValue("clanId"));put("idempotencyKey",original.getValue("creationIntentId"))})
  put("snapshot",buildJsonObject{
   put("clan",buildJsonObject{put("id",original.getValue("clanId"));put("name",original.charterObject("metadata").getValue("name"));put("tag",creation.charterObject("state").charterObject("request").getValue("tag"));put("inviteMode","open")})
   put("memberCount",1);put("chestShards","7");put("capturedAt","2026-09-30T00:00:00.000Z");put("commitment",original.getValue("admissionCommitment"))
  })
  put("original",original);put("status","prepared");put("signing",signing);put("wire",JsonNull);put("terminal",JsonNull)
  listOf("signingAuthorized","relayAuthorized","migrationAuthorized","fenceReleaseAuthorized").forEach{put(it,false)}
 }
 fun byKey(m:JsonElement=prepared)=buildJsonObject{put("version",1);put("actor",prepared.getValue("actor"));put("idempotencyKey",prepared.charterObject("request").getValue("idempotencyKey"));put("migration",m)}
 fun edit(v:JsonObject,path:List<String>,value:JsonElement):JsonObject=JsonObject(v+(path.first() to if(path.size==1)value else edit(v.charterObject(path.first()),path.drop(1),value)))
}
class MigrationProtocolTest {
 private val prepared=MigrationFixture.prepared
 @Test fun `registration packet is reused without a funded creation reservation or SHARDS price`() {
  assertEquals(prepared,MigrationProtocol.migration(prepared));assertEquals(MigrationFixture.signing,CharterRegistrationProtocol.signing(MigrationFixture.signing))
  assertEquals(MigrationFixture.creation,CharterEnvelope.from(MigrationFixture.creation).raw)
  val key=prepared.charterObject("request").charterText("idempotencyKey");val actor=prepared.charterText("actor")
  assertEquals(prepared,MigrationProtocol.byKey(MigrationFixture.byKey(),actor,key));assertNull(MigrationProtocol.byKey(MigrationFixture.byKey(JsonNull),actor,key))
  val terminal=buildJsonObject{put("id",prepared.getValue("id"));put("outcome","controlled")}
  val externallyObserved=JsonObject(prepared+mapOf("status" to JsonPrimitive("controlled"),"signing" to JsonNull,"terminal" to terminal))
  assertEquals(externallyObserved,MigrationProtocol.migration(externallyObserved))
 }
 @Test fun `rejects authority escalation foreign snapshot charge fields broken costs and unbacked stages`() {
  val mutations=listOf(
   listOf("migrationAuthorized") to JsonPrimitive(true),listOf("price") to JsonPrimitive("25"),listOf("snapshot","commitment") to JsonPrimitive("00".repeat(32)),
   listOf("snapshot","clan","id") to prepared.getValue("id"),listOf("actor") to MigrationFixture.original.charterObject("chain").getValue("economyProgram"),
   listOf("status") to JsonPrimitive("controlled"),listOf("status") to JsonPrimitive("signed"),listOf("status") to JsonPrimitive("pending"),
   listOf("signing","costs","totalLamports") to JsonPrimitive("1"),listOf("signing","packet","unsignedTransactionHex") to JsonPrimitive("00".repeat(100)),
   listOf("signing","original","admissionCommitment") to JsonPrimitive("00".repeat(32)),listOf("snapshot","memberCount") to JsonPrimitive(0))
  mutations.forEach{(path,value)->assertThrows("Changed $path",Exception::class.java){MigrationProtocol.migration(MigrationFixture.edit(prepared,path,value))}}
  val policy=buildJsonObject{put("nameMinLen",1);put("nameMaxLen",24);put("tagMinLen",1);put("tagMaxLen",24);put("rosterCap",1)}
  MigrationProtocol.validatePolicy(prepared,policy)
  assertThrows(Exception::class.java){MigrationProtocol.validatePolicy(MigrationFixture.edit(prepared,listOf("snapshot","memberCount"),JsonPrimitive(2)),policy)}
 }
 @Test fun `terminal status and outcome each retain evidence including opaque contradictory claims`() {
  assertEquals(emptySet<String>(),MigrationProtocol.observedTerminal(prepared))
  val both=JsonObject(prepared+mapOf("status" to JsonPrimitive("controlled"),"terminal" to buildJsonObject{put("outcome","cancelled")}))
  assertEquals(setOf("controlled","cancelled"),MigrationProtocol.observedTerminal(both))
  val opaque=JsonObject(prepared+mapOf("status" to JsonPrimitive("controlled"),"terminal" to JsonPrimitive("damaged")))
  assertEquals(setOf("controlled","unknown"),MigrationProtocol.observedTerminal(opaque))
  assertEquals(setOf("unknown"),MigrationProtocol.observedTerminal(JsonObject(prepared+("terminal" to buildJsonObject{}))))
 }
 @Test fun `activity admits landless leader discovery and paused historical requests without granting new authority`() {
  val current=JsonObject(prepared.charterObject("snapshot").charterObject("clan")+mapOf("authority" to JsonPrimitive("legacy"),"migrationId" to JsonNull))
  val activity=buildJsonObject{put("version",1);put("actor",prepared.getValue("actor"));put("newActions",true);put("currentClan",current);put("items",JsonArray(emptyList()))}
  assertEquals(activity,MigrationProtocol.activity(activity))
  assertThrows(Exception::class.java){MigrationProtocol.activity(MigrationFixture.edit(activity,listOf("currentClan","authority"),JsonPrimitive("pending")))}
  assertThrows(Exception::class.java){MigrationProtocol.activity(MigrationFixture.edit(activity,listOf("currentClan","authority"),JsonPrimitive("controlled")))}
  val paused=JsonObject(activity+mapOf("newActions" to JsonPrimitive(false),"currentClan" to JsonNull));assertEquals(paused,MigrationProtocol.activity(paused))
 }
 @Test fun `routes forbid alternate commands queries encoded IDs and client source proofs`() {
  val root=MigrationProtocol.ROOT;val id=prepared.charterText("id")
  validateMigrationRequest("POST",root,emptyMap(),prepared.charterObject("request"));validateMigrationRequest("GET","$root/$id",emptyMap(),null);validateMigrationRequest("GET","$root/activity",emptyMap(),null)
  for(action in listOf("prepare","recover-preparation","deliver","recover","cancel"))validateMigrationRequest("POST","$root/$id/$action",emptyMap(),buildJsonObject{})
  listOf(root,"$root/$id?x=1","$root/$id/extra","$root/by-key/$id/more","$root//$id","$root/$id%2f","$root/${id.uppercase()}").forEach{p->assertThrows(Exception::class.java){validateMigrationRequest("GET",p,emptyMap(),null)}}
  assertThrows(Exception::class.java){validateMigrationRequest("GET","$root/$id",mapOf("actor" to prepared.charterText("actor")),null)}
  assertThrows(Exception::class.java){validateMigrationRequest("POST","$root/$id/cancel",emptyMap(),buildJsonObject{put("verified",true)})}
  assertThrows(Exception::class.java){validateMigrationRequest("POST","$root/$id/pay-members",emptyMap(),buildJsonObject{})}
 }
 @Test fun `bounded copies own their evidence and refuse excessive tree depth and strings`() {
  val mutable=prepared.toMutableMap();val owned=MigrationProtocol.migration(JsonObject(mutable));mutable["actor"]=JsonPrimitive("changed");assertEquals(prepared,owned)
  assertThrows(Exception::class.java){MigrationProtocol.copy(JsonArray(List(21){JsonNull}))}
  assertThrows(Exception::class.java){MigrationProtocol.copy(JsonPrimitive("x".repeat(3289)))}
  var nested:JsonElement=JsonNull;repeat(14){nested=buildJsonObject{put("nested",nested)}};assertThrows(Exception::class.java){MigrationProtocol.copy(nested)}
 }
}
