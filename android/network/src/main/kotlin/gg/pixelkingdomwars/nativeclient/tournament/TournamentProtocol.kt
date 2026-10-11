package gg.pixelkingdomwars.nativeclient.tournament

import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*

private typealias Check=(JsonElement)->Unit
private val id:Check=CharterGrammar::id
private val key:Check=CharterGrammar::address
private val n:Check={CharterGrammar.number(it)}
private val amount:Check={CharterGrammar.amount(it)}
private val hash:Check={CharterGrammar.hex(it,32)}
private val no:Check={require(!CharterGrammar.bool(it))}
private val yesno:Check={CharterGrammar.bool(it)}
private val ver:Check={require(CharterGrammar.number(it)==1L)}
private val rev:Check={require(CharterGrammar.number(it)<0xffffffffL)}
private val time:Check=CharterGrammar::timestamp
private fun s(vararg values:String):Check={require(CharterGrammar.text(it) in values)}
private fun obj(vararg fields:Pair<String,Check>):Check={x->val v=x.jsonObject;require(v.keys==fields.map{it.first}.toSet());fields.forEach{(k,c)->c(v.getValue(k))}}
private fun arr(max:Int,check:Check):Check={x->val a=x.jsonArray;require(a.size<=max);a.forEach(check)}
private fun nullable(check:Check):Check={if(it!=JsonNull)check(it)}
private fun hex(bytes:Int):Check={CharterGrammar.hex(it,bytes)}
private val bounded:Check={TournamentProtocol.copy(it);require(it is JsonObject)}
private val domain=obj("genesisHash" to key,"economyProgram" to key,"craftProgram" to key,"treasury" to key)
private val roster:Check={x->val a=x.jsonArray;require(a.isNotEmpty()&&a.size<=256);a.forEach(key);require(a.map(CharterGrammar::text).zipWithNext().all{(a,b)->a<b})}
private val amounts:Check={x->val a=x.jsonObject;require(a.size in 1..32);a.forEach{(k,v)->require(k.matches(Regex("[a-z_]{1,64}")));amount(v)}}
private val terms=obj("version" to ver,"id" to id,"domain" to domain,"sponsorWallet" to key,"entryStartsAt" to time,"playStartsAt" to time,"playEndsAt" to time,"occupationEndsAt" to time,"policy" to bounded,"budget" to amounts)
private val terminal=obj("version" to ver,"eventId" to id,"completedAt" to time,"rankings" to arr(10000,obj("clanId" to id,"stars" to n,"destruction" to n,"completedRaids" to n,"rosterSize" to n)),"occupations" to arr(10000,obj("site" to n,"clanId" to id)),"entitlements" to arr(10000,obj("wallet" to key,"amounts" to amounts)))
private val creation=obj("creationIntentId" to id,"clanId" to id,"payer" to key,"metadata" to obj("name" to {x->val v=CharterGrammar.text(x);require(v.length in 1..24&&v.matches(Regex("[A-Za-z0-9 ._-]+")))},"uri" to {x->val v=CharterGrammar.text(x);require(v.length<=292&&java.net.URI(v).let{it.scheme=="https"&&!it.host.isNullOrBlank()&&it.userInfo==null})},"hash" to hash),"chain" to obj(*listOf("genesisHash","economyProgram","craftProgram","config","craftControl","collection","collectionAuthority","charter","asset","assetBinding","freezeAuthority","executor","creationReceipt").map{it to key}.toTypedArray()),"admissionCommitment" to hash,"issuedPermitIds" to arr(256,hex(16)))
private val lock=obj("id" to id,"fenceId" to id,"eventId" to id,"leader" to key,"lockId" to id,"expectedRevision" to rev,"action" to s("set","clear"),"termsHash" to hash)
private val original=obj("creation" to creation,"operation" to lock)
private val clearance:Check={x->if(x!=JsonNull){if("kind" in x.jsonObject)obj("version" to ver,"kind" to s("late-entry-nonparticipation"),"entryId" to id,"eventId" to id,"terminalId" to id,"lockId" to id,"awards" to arr(0,bounded))(x) else terminal(x)}}
private val operationTerms=obj("version" to ver,"epochId" to id,"entryId" to id,"eventId" to id,"clanId" to id,"leader" to key,"lockId" to id,"fenceId" to id,"operationId" to id,"action" to s("set","clear"),"expectedRevision" to rev,"domain" to domain,"event" to terms,"roster" to roster,"clearance" to clearance)
private val pin=obj("address" to key,"dataSha256" to hash)
private val deployment:Check={x->val v=x.jsonObject;obj("expectedGenesisHash" to key,"stateProvenance" to s("fresh-reviewed-deployment"),*listOf("economy","craft","core").map{it to obj("programId" to key,"reviewedDeploymentSlot" to n,"reviewedProgramDataSha256" to hash,"upgradeAuthority" to nullable(key))}.toTypedArray())(v)}
private val packet=obj("version" to ver,"messageHex" to {CharterGrammar.hex(it,max=1167)},"unsignedTransactionHex" to {CharterGrammar.hex(it)},"messageSha256" to hash,"packetBytes" to n,"nativeInstructionIndex" to ver,"signingAuthorized" to no,"relayAuthorized" to no)
private val quote=obj("version" to ver,"packetInput" to obj("original" to original,"candidateHex" to hex(161),"policySigner" to key,"lookupTable" to obj("address" to key,"owner" to key,"executable" to no,"dataHex" to hex(440),"slot" to n),"expectedLookupTable" to pin,"blockhash" to key,"blockhashSlot" to n,"lastValidBlockHeight" to n,"currentBlockHeight" to n),"observation" to obj("slot" to n,"unixTimestamp" to amount,"registryRevision" to rev,"registryLeader" to key,"lockKind" to {require(CharterGrammar.number(it) in 0..1)},"lockId" to {x->if(CharterGrammar.text(x).length==32)hex(16)(x) else id(x)},"policySigner" to key,"admissionPaused" to no,"craftPaused" to no,"source" to obj("genesisHash" to key,"programs" to deployment,"accounts" to arr(16,obj("address" to key,"owner" to nullable(key),"executable" to nullable(yesno),"dataSha256" to nullable(hash))))),"template" to packet,"costs" to obj("networkFeeLamports" to amount,"rentLamports" to amount,"totalLamports" to amount,"allocations" to arr(1,obj("kind" to s("permit-receipt"),"address" to key,"bytes" to {require(CharterGrammar.number(it)==107L)},"minimumBalanceLamports" to amount))),"costLimits" to obj("maxNetworkFeeLamports" to amount,"maxRentLamports" to amount,"maxAdditionalLamports" to amount),"context" to obj("feeSlot" to n,"closingSlot" to n,"closingGenesisHash" to key),"signingAuthorized" to no,"entryAuthorized" to no,"fenceReleaseAuthorized" to no)
private val wireCheck=obj("signedTransactionHex" to {CharterGrammar.hex(it)},"signature" to {val v=CharterGrammar.text(it);require(v.length in 64..88&&v.matches(Regex("[1-9A-HJ-NP-Za-km-z]+")))},"wireSha256" to hash,"messageSha256" to hash)

/** Closed response shapes establish consistency only. Fresh signing also requires the
 * separately installed pins, admitted catalogue policy and independent cryptography. */
object TournamentProtocol {
 fun copy(raw:JsonElement):JsonElement {var nodes=0;fun visit(v:JsonElement,depth:Int):JsonElement {require(++nodes<=100000&&depth<=20);return when(v){is JsonObject->{require(v.size<=64);JsonObject(v.mapValues{(k,x)->require(k.length<=64);visit(x,depth+1)})};is JsonArray->{require(v.size<=10000);JsonArray(v.map{visit(it,depth+1)})};is JsonPrimitive->v.also{require(it.content.length<=4096)}}};return visit(raw,0)}
 fun wire(raw:JsonObject)=copy(raw).jsonObject.also{wireCheck(it)}
 fun operation(raw:JsonObject):JsonObject {val v=copy(raw).jsonObject;val flags=setOf("signingAuthorized","relayAuthorized","entryAuthorized","fenceReleaseAuthorized");v.filterKeys{it in flags}.values.forEach(no)
  obj("version" to ver,"original" to original,"operationTerms" to operationTerms,"status" to s("draft","issuing","prepared","signed","completed","cancelled"),"entryId" to id,"attempt" to nullable(obj("id" to id,"candidateHex" to hex(161),"policySigner" to key,"quote" to quote)),"preparation" to nullable(obj("policySignatureHex" to hex(64),"packet" to packet)),"signed" to nullable(wireCheck),"terminal" to nullable(obj("id" to id,"outcome" to s("completed","cancelled"),"record" to bounded)),"inventory" to obj("version" to ver,"revision" to s("0","1"),"count" to {require(CharterGrammar.number(it) in 0..1)},"messages" to arr(1,hex(161))))(JsonObject(v-flags))
  val o=v.charterObject("original").charterObject("operation");val c=v.charterObject("original").charterObject("creation");val t=v.charterObject("operationTerms");val a=v.charterOptional("attempt");val p=v.charterOptional("preparation");val signed=v.charterOptional("signed");val end=v.charterOptional("terminal")
  for(k in listOf("fenceId","eventId","leader","lockId","action","expectedRevision"))require(t[k]==o[k]);require(t["entryId"]==v["entryId"]&&t["fenceId"]==v["entryId"]&&t["operationId"]==o["id"]&&t["clanId"]==c["clanId"]&&t.getValue("roster").jsonArray.contains(o["leader"]))
  require((o.charterText("action")=="set")== (t["clearance"]==JsonNull));require(t.charterObject("event")["id"]==t["eventId"]&&t.charterObject("event")["domain"]==t["domain"])
  val d=t.charterObject("domain");val chain=c.charterObject("chain");for(k in listOf("genesisHash","economyProgram","craftProgram"))require(d[k]==chain[k])
  t.charterOptional("clearance")?.let{require(it["eventId"]==t["eventId"]);if("kind" in it)require(it["entryId"]==t["entryId"]&&it["lockId"]==t["lockId"])}
  require(v.charterText("status")== (end?.charterText("outcome")?:if(signed!=null)"signed" else if(p!=null)"prepared" else if(a!=null)"issuing" else "draft"));require(p==null||a!=null);require(signed==null||p!=null)
  val inventory=v.charterObject("inventory");require(inventory.charterText("revision")== (if(a==null)"0" else "1")&&CharterGrammar.number(inventory.getValue("count"))==(if(a==null)0L else 1L)&&inventory.getValue("messages").jsonArray==JsonArray(a?.let{listOf(it.getValue("candidateHex"))}?:emptyList()))
  if(a!=null){val q=a.charterObject("quote");val input=q.charterObject("packetInput");val b=q.charterObject("observation");require(input["original"]==v["original"]&&input["candidateHex"]==a["candidateHex"]&&input["policySigner"]==a["policySigner"]&&b["policySigner"]==a["policySigner"]&&b["registryLeader"]==o["leader"]&&b["registryRevision"]==o["expectedRevision"])
   require(CharterGrammar.number(b.getValue("lockKind"))==if(o.charterText("action")=="set")0L else 1L);require(b.charterText("lockId")==if(o.charterText("action")=="set")"0".repeat(32) else o.charterText("lockId"))
   val slots=listOf(b.getValue("slot"),input.charterObject("lookupTable").getValue("slot"),input.getValue("blockhashSlot"),q.charterObject("context").getValue("feeSlot"),q.charterObject("context").getValue("closingSlot")).map(CharterGrammar::number);require(slots.zipWithNext().all{(x,y)->x<=y}&&CharterGrammar.number(input.getValue("currentBlockHeight"))<=CharterGrammar.number(input.getValue("lastValidBlockHeight")))
   require(q.charterObject("context")["closingGenesisHash"]==chain["genesisHash"]&&b.charterObject("source")["genesisHash"]==chain["genesisHash"]&&input.charterObject("lookupTable")["address"]==input.charterObject("expectedLookupTable")["address"])
   val costs=q.charterObject("costs");val limits=q.charterObject("costLimits");fun money(x:JsonObject,k:String)=CharterGrammar.amount(x.getValue(k))
   val fee=money(costs,"networkFeeLamports");val rent=money(costs,"rentLamports");require(costs.getValue("allocations").jsonArray.single().jsonObject["minimumBalanceLamports"]==costs["rentLamports"]&&money(costs,"totalLamports")==fee+rent&&fee<=money(limits,"maxNetworkFeeLamports")&&rent<=money(limits,"maxRentLamports")&&fee+rent<=money(limits,"maxAdditionalLamports"))
  }
  p?.charterObject("packet")?.let{val m=it.charterText("messageHex");require(m.startsWith("80")&&CharterGrammar.number(it.getValue("packetBytes"))==65L+m.length/2&&it.charterText("unsignedTransactionHex")=="01"+"00".repeat(64)+m);if(signed!=null)require(signed["messageSha256"]==it["messageSha256"])}
  return v
 }
 fun entry(raw:JsonObject):JsonObject {val v=copy(raw).jsonObject;obj("version" to ver,"id" to id,"eventId" to id,"clanId" to id,"leader" to key,"epochId" to id,"lockId" to id,"roster" to roster,"status" to s("pending","entered","nonparticipating","released","cancelled"),"set" to {operation(it.jsonObject)},"clear" to nullable{operation(it.jsonObject)})(v)
  for(o in listOfNotNull(v.charterObject("set"),v.charterOptional("clear"))){val t=o.charterObject("operationTerms");require(o["entryId"]==v["id"]);for(k in listOf("eventId","clanId","leader","epochId","lockId","roster"))require(t[k]==v[k])};require(v.charterObject("set").charterObject("original").charterObject("operation").charterText("action")=="set")
  v.charterOptional("clear")?.let{require(it.charterObject("original").charterObject("operation").charterText("action")=="clear"&&it.charterObject("original")["creation"]==v.charterObject("set").charterObject("original")["creation"]&&CharterGrammar.number(it.charterObject("operationTerms").getValue("expectedRevision"))==CharterGrammar.number(v.charterObject("set").charterObject("operationTerms").getValue("expectedRevision"))+1)}
  when(v.charterText("status")){"cancelled"->require(v.charterObject("set").charterText("status")=="cancelled");"entered","nonparticipating","released"->require(v.charterObject("set").charterText("status")=="completed")};if(v.charterText("status")=="released")require(v.charterObject("clear").charterText("status")=="completed");return v
 }
 fun event(raw:JsonObject):JsonObject {val v=copy(raw).jsonObject;terms(JsonObject(v-"terminal"));nullable(terminal)(v.getValue("terminal"));v.charterOptional("terminal")?.let{require(it["eventId"]==v["id"])};return v}
 fun events(raw:JsonObject):JsonObject=copy(raw).jsonObject.also{obj("version" to ver,"events" to arr(20){event(it.jsonObject)},"nextCursor" to nullable{val c=CharterGrammar.text(it);require(c.length in 1..256&&c.all{it.code in 33..126})})(it)}
 fun prize(raw:JsonObject):JsonObject=copy(raw).jsonObject.also{obj("eventId" to id,"wallet" to key,"baseId" to id,"amounts" to amounts,"claimedAt" to time)(it)}
 fun raid(raw:JsonObject):JsonObject=copy(raw).jsonObject.also{v->obj("version" to ver,"eventId" to id,"requestId" to id,"baseId" to id,"status" to s("requested","admitted","cancelled"),"ordinal" to nullable(n),"raid" to nullable(bounded))(v);if(v["raid"]!=JsonNull){require(v.charterText("status")=="admitted"&&v["ordinal"]!=JsonNull);id(v.charterObject("raid").getValue("id"))}else require(v["ordinal"]==JsonNull&&v.charterText("status")!="admitted")}
 fun participation(raw:JsonObject):JsonObject=copy(raw).jsonObject.also{v->obj("version" to ver,"eventId" to id,"entry" to nullable(obj("entryId" to id,"clanId" to id,"leader" to key,"roster" to roster,"lockId" to id,"lockTerminalId" to id)),"prize" to nullable(obj("amounts" to amounts,"claim" to nullable{prize(it.jsonObject)})),"raids" to arr(256){raid(it.jsonObject)})(v);v.getValue("raids").jsonArray.forEach{require(it.jsonObject["eventId"]==v["eventId"])};v.charterOptional("prize")?.charterOptional("claim")?.let{require(it["eventId"]==v["eventId"])}}
 fun delivery(raw:JsonObject):JsonObject=copy(raw).jsonObject.also{v->obj("version" to ver,"operationId" to id,"status" to s("held","terminal","observed","submitted"),"signature" to nullable{require(CharterGrammar.text(it).length in 64..88)},"reason" to nullable{s("NOT_SIGNED","PAUSED","TRANSPORT_UNAVAILABLE","IDENTITY","EXPIRED_UNRESOLVED","ADMISSION_HELD","SOURCE_CONFLICT","OBSERVED_TRANSACTION","FINALIZED_ERROR_UNVERIFIED","SEND_UNCERTAIN","TIMEOUT","BUSY")(it)},"operation" to {operation(it.jsonObject)},"signingAuthorized" to no,"entryAuthorized" to no,"fenceReleaseAuthorized" to no)(v);require(v["operationId"]==v.charterObject("operation").charterObject("original").charterObject("operation")["id"]&&v["signature"]==(v.charterObject("operation").charterOptional("signed")?.get("signature")?:JsonNull))}
}

fun validateTournamentRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?) {
 val prefix="/clans/charter/tournaments/";require(path.startsWith(prefix)&&'?' !in path&&'#' !in path);val p=path.removePrefix(prefix).split('/');require(method in listOf("GET","POST"))
 if(method=="GET"){require(body==null);if(p==listOf("events")){require(query.keys.all{it=="cursor"});query["cursor"]?.let{require(it.length in 1..256&&it.all{c->c.code in 33..126})};return};require(query.isEmpty());when {p.size==2&&p[0] in listOf("events","entries","operations")->id(JsonPrimitive(p[1]));p.size==3&&p[0]=="entries"&&p[1]=="by-key"->id(JsonPrimitive(p[2]));p.size==3&&p[0]=="events"&&p[2]=="participation"->id(JsonPrimitive(p[1]));p.size==5&&p[0]=="events"&&p[2]=="raids"&&p[3]=="by-key"->{id(JsonPrimitive(p[1]));id(JsonPrimitive(p[4]))};else->error("Unsupported tournament read")};return}
 require(query.isEmpty());val b=requireNotNull(body);TournamentProtocol.copy(b)
 when {p==listOf("entries")->obj("eventId" to id,"clanId" to id,"idempotencyKey" to id)(b)
  p.size==3&&p[0]=="entries"&&p[2]=="clear"->{id(JsonPrimitive(p[1]));obj("idempotencyKey" to id)(b)}
  p.size==3&&p[0]=="operations"->{id(JsonPrimitive(p[1]));if(p[2]=="signed")obj("signedTransaction" to {CharterGrammar.base64(it)})(b) else {require(p[2] in listOf("prepare","recover-preparation","recover","cancel","deliver"));require(b.isEmpty())}}
  p.size==3&&p[0]=="events"->{id(JsonPrimitive(p[1]));when(p[2]){"raids"->obj("baseId" to id,"idempotencyKey" to id)(b);"prize"->obj("baseId" to id)(b);"close"->require(b.isEmpty());else->error("Unsupported tournament command")}}
  p.size==6&&p[0]=="events"&&p[2]=="raids"&&p[3]=="by-key"&&p[5]=="cancel"->{id(JsonPrimitive(p[1]));id(JsonPrimitive(p[4]));require(b.isEmpty())}
  p.size==3&&p[0]=="raids"&&p[2]=="replay"->{id(JsonPrimitive(p[1]));require(b.isEmpty())}
  else->error("Unsupported tournament command")
 }
}
