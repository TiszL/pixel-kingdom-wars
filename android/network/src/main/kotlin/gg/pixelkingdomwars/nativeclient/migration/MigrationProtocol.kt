package gg.pixelkingdomwars.nativeclient.migration

import gg.pixelkingdomwars.nativeclient.charter.*
import java.time.OffsetDateTime
import kotlinx.serialization.json.*

private typealias Check=(JsonElement)->Unit
private val id:Check=CharterGrammar::id
private val address:Check=CharterGrammar::address
private val amount:Check={CharterGrammar.amount(it)}
private val hash:Check={CharterGrammar.hex(it,32)}
private val no:Check={require(!CharterGrammar.bool(it))}
private val version:Check={require(CharterGrammar.number(it)==1L)}
private val label:Check={require(CharterGrammar.text(it).length in 1..24)}
private fun enum(vararg values:String):Check={require(CharterGrammar.text(it) in values)}
private fun nullable(check:Check):Check={if(it!=JsonNull)check(it)}
private fun obj(vararg fields:Pair<String,Check>):Check={raw->val o=raw.jsonObject;require(o.keys==fields.map{it.first}.toSet());fields.forEach{(k,c)->c(o.getValue(k))}}
private val request=obj("clanId" to id,"idempotencyKey" to id)
private val clan=obj("id" to id,"name" to label,"tag" to label,"inviteMode" to enum("open","invite"))
private val snapshot=obj("clan" to clan,"memberCount" to {require(CharterGrammar.number(it)>=1)},"chestShards" to amount,
 "capturedAt" to {val s=CharterGrammar.text(it);require(s.length in 20..40);OffsetDateTime.parse(s)},"commitment" to hash)
private val statuses=arrayOf("pending","issuing","prepared","signed","controlled","cancelled")
private val terminal=obj("id" to id,"outcome" to enum("controlled","cancelled"))

/** Bounded public migration ABI. An authentic registration original is independent of
 * a funded creation envelope; no balance, reservation or signing authority is invented. */
object MigrationProtocol {
 const val ROOT="/clans/charter/migrations"
 const val MAX_RESPONSE_BYTES=131072
 fun copy(raw:JsonElement):JsonElement=CharterGrammar.copy(raw)
 fun migration(input:JsonObject):JsonObject {
  val m=copy(input).jsonObject
  obj("version" to version,"id" to id,"actor" to address,"request" to request,"snapshot" to snapshot,
   "original" to {CharterRegistrationProtocol.original(it.jsonObject)},"status" to enum(*statuses),
   "signing" to nullable({CharterRegistrationProtocol.signing(it.jsonObject)}),"wire" to nullable({CharterRegistrationProtocol.wire(it.jsonObject)}),
   "terminal" to nullable(terminal),"signingAuthorized" to no,"relayAuthorized" to no,"migrationAuthorized" to no,"fenceReleaseAuthorized" to no)(m)
  val o=m.charterObject("original");val s=m.charterObject("snapshot");val c=s.charterObject("clan");val status=m.charterText("status")
  require(m["id"]==o["creationIntentId"]&&m.charterObject("request")["clanId"]==c["id"]&&c["id"]==o["clanId"]&&m["actor"]==o["payer"])
  require(c["name"]==o.charterObject("metadata")["name"]&&s["commitment"]==o["admissionCommitment"])
  val signing=m.charterOptional("signing");val wire=m.charterOptional("wire");val terminal=m.charterOptional("terminal")
  signing?.let{require(it["original"]==o)}
  wire?.let{require(signing!=null&&it["messageSha256"]==signing.charterObject("packet")["messageSha256"])}
  terminal?.let{require(it.charterText("outcome")==status)}
  require(status !in listOf("controlled","cancelled")||terminal!=null)
  if(status in listOf("pending","issuing"))require(signing==null&&wire==null)
  if(status=="prepared")require(signing!=null&&wire==null)
  if(status=="signed")require(signing!=null&&wire!=null)
  return m
 }
 fun byKey(input:JsonObject,actor:String,key:String):JsonObject? {
  val m=copy(input).jsonObject
  obj("version" to version,"actor" to address,"idempotencyKey" to id,"migration" to nullable({migration(it.jsonObject)}))(m)
  require(m.charterText("actor")==actor&&m.charterText("idempotencyKey")==key)
  return m.charterOptional("migration")?.also{require(it.charterText("actor")==actor&&it.charterObject("request").charterText("idempotencyKey")==key)}
 }
 fun activity(input:JsonObject):JsonObject {
  val m=copy(input).jsonObject
  obj("version" to version,"actor" to address,"newActions" to {CharterGrammar.bool(it)},
   "currentClan" to nullable(obj("id" to id,"name" to label,"tag" to label,"inviteMode" to enum("open","invite"),"authority" to enum("legacy","pending","controlled"),"migrationId" to nullable(id))),
   "items" to {raw->val items=raw.jsonArray;require(items.size<=20);items.forEach{obj("id" to id,"clanId" to id,"name" to label,"tag" to label,"status" to enum(*statuses))(it)}})(m)
  val current=m.charterOptional("currentClan")
  if(current?.charterText("authority")=="pending")require(current["migrationId"]!=JsonNull)
  if(CharterGrammar.bool(m.getValue("newActions")))require(current?.charterText("authority")=="legacy")
  return m
 }
 /** Call on owned bounded evidence before semantic parsing. Status and terminal claims
  * are independent: a damaged claim cannot disappear behind a nonterminal status. */
 fun observedTerminal(input:JsonObject):Set<String> {
  val observed=linkedSetOf<String>();val status=(input["status"] as? JsonPrimitive)?.takeIf{it.isString}?.content
  if(status in listOf("controlled","cancelled"))observed.add(requireNotNull(status))
  input["terminal"]?.takeUnless{it==JsonNull}?.let{t->
   val outcome=((t as? JsonObject)?.get("outcome") as? JsonPrimitive)?.takeIf{it.isString}?.content
   observed.add(if(outcome in listOf("controlled","cancelled"))requireNotNull(outcome) else "unknown")
  }
  return observed
 }
 /** Game limits come from the installed canonical CLANS catalogue, never Kotlin copies. */
 fun validatePolicy(input:JsonObject,clans:JsonObject) {
  val m=migration(input);val s=m.charterObject("snapshot");val c=s.charterObject("clan")
  fun n(k:String)=CharterGrammar.number(clans.getValue(k))
  require(c.charterText("name").length.toLong() in n("nameMinLen")..n("nameMaxLen")&&c.charterText("tag").length.toLong() in n("tagMinLen")..n("tagMaxLen"))
  require(CharterGrammar.number(s.getValue("memberCount")) in 1..n("rosterCap"))
 }
}
fun validateMigrationRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?) {
 val root=MigrationProtocol.ROOT;require(method in listOf("GET","POST")&&query.isEmpty()&&'?' !in path&&'#' !in path)
 if(path==root){require(method=="POST");request(requireNotNull(body));return}
 require(path.startsWith("$root/"));val parts=path.removePrefix("$root/").split('/')
 if(method=="GET") {
  require(body==null)
  if(parts==listOf("activity"))return
  if(parts.size==2&&parts[0]=="by-key"){id(JsonPrimitive(parts[1]));return}
  require(parts.size==1);id(JsonPrimitive(parts[0]));return
 }
 require(parts.size==2);id(JsonPrimitive(parts[0]));val b=requireNotNull(body);MigrationProtocol.copy(b)
 if(parts[1]=="signed")obj("signedTransaction" to {CharterGrammar.base64(it)})(b)
 else{require(parts[1] in listOf("prepare","recover-preparation","deliver","recover","cancel"));require(b.isEmpty())}
}
