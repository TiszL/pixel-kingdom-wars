package gg.pixelkingdomwars.nativeclient.retirement

import gg.pixelkingdomwars.nativeclient.charter.*
import java.math.BigInteger
import java.net.URI
import kotlinx.serialization.json.*

private typealias Check=(JsonElement)->Unit
private val id:Check=CharterGrammar::id
private val key:Check=CharterGrammar::address
private val n:Check={CharterGrammar.number(it)}
private val amount:Check={CharterGrammar.amount(it)}
private val hash:Check={CharterGrammar.hex(it,32)}
private val no:Check={require(!CharterGrammar.bool(it))}
private val bool:Check={CharterGrammar.bool(it)}
private val ver:Check={require(CharterGrammar.number(it)==1L)}
private val revision:Check={require(CharterGrammar.number(it)<0xffffffffL)}
private val time:Check={require(CharterGrammar.amount(it)<=BigInteger.valueOf(Long.MAX_VALUE))}
private fun enum(vararg values:String):Check={require(CharterGrammar.text(it) in values)}
private fun obj(vararg fields:Pair<String,Check>):Check={x->val v=x.jsonObject;require(v.keys==fields.map{it.first}.toSet());fields.forEach{(k,c)->c(v.getValue(k))}}
private fun arr(max:Int,check:Check):Check={x->val a=x.jsonArray;require(a.size<=max);a.forEach(check)}
private fun nullable(check:Check):Check={if(it!=JsonNull)check(it)}
private fun hex(bytes:Int):Check={CharterGrammar.hex(it,bytes,max=bytes)}
private val signature:Check={val s=CharterGrammar.text(it);require(s.length in 64..88&&s.matches(Regex("[1-9A-HJ-NP-Za-km-z]+")))}
private val program=obj("programId" to key,"reviewedDeploymentSlot" to n,"reviewedProgramDataSha256" to hash,"upgradeAuthority" to nullable(key))
private val deployment=obj("expectedGenesisHash" to key,"economy" to program,"craft" to program,"core" to program,"stateProvenance" to enum("fresh-reviewed-deployment"))
private val packet=obj("version" to ver,"messageHex" to {CharterGrammar.hex(it,max=1167)},"unsignedTransactionHex" to {CharterGrammar.hex(it)},"messageSha256" to hash,"packetBytes" to {require(CharterGrammar.number(it) in 66..1232)},"nativeInstructionIndex" to ver,"signingAuthorized" to no,"relayAuthorized" to no)
private val creation=obj("creationIntentId" to id,"clanId" to id,"payer" to key,
 "metadata" to obj("name" to {val s=CharterGrammar.text(it);require(s.length in 1..24&&s.matches(Regex("[A-Za-z0-9 ._-]+")))},"uri" to {val s=CharterGrammar.text(it);require(s.length in 1..292&&URI(s).let{u->u.scheme=="https"&&!u.host.isNullOrBlank()&&u.userInfo==null})},"hash" to hash),
 "chain" to obj(*listOf("genesisHash","economyProgram","craftProgram","config","craftControl","collection","collectionAuthority","charter","asset","assetBinding","freezeAuthority","executor","creationReceipt").map{it to key}.toTypedArray()),
 "admissionCommitment" to hash,"issuedPermitIds" to {x->arr(256,hex(16))(x);require(x.jsonArray.isNotEmpty()&&x.jsonArray.distinct().size==x.jsonArray.size)})
private val original=obj("creation" to creation,"retirement" to obj("id" to id,"fenceId" to id,"clanId" to id,"leader" to key,"expectedRevision" to revision,"clearanceHash" to hash))
private val request=obj("clanId" to id,"idempotencyKey" to id)
private val payment=obj("id" to id,"totalShards" to amount)
private val wireCheck=obj("signedTransactionHex" to {CharterGrammar.hex(it)},"signature" to signature,"wireSha256" to hash,"messageSha256" to hash)
private val flags=arrayOf("signingAuthorized" to no,"relayAuthorized" to no,"retirementAuthorized" to no,"fenceReleaseAuthorized" to no)
private val allocation=obj("kind" to enum("permit-receipt","retirement-receipt"),"address" to key,"bytes" to {require(CharterGrammar.number(it) in 1..1232)},"minimumBalanceLamports" to amount)
private val quote=obj("version" to ver,"packetInput" to obj("original" to original,"candidateHex" to hex(161),"policySigner" to key,
 "lookupTable" to obj("address" to key,"owner" to key,"executable" to no,"dataHex" to {CharterGrammar.hex(it,max=8248)},"slot" to n),"expectedLookupTable" to obj("address" to key,"dataSha256" to hash),"blockhash" to key,"blockhashSlot" to n,"lastValidBlockHeight" to n,"currentBlockHeight" to n),
 "observation" to obj("slot" to n,"unixTimestamp" to time,"registryRevision" to revision,"registryLeader" to key,"lockKind" to {require(CharterGrammar.number(it)==0L)},"lockId" to hex(16),"policySigner" to key,"admissionPaused" to no,"craftPaused" to no,
 "source" to obj("genesisHash" to key,"programs" to deployment,"accounts" to arr(100,obj("address" to key,"owner" to nullable(key),"executable" to nullable(bool),"dataSha256" to nullable(hash))))),
 "template" to packet,"costs" to obj("networkFeeLamports" to amount,"rentLamports" to amount,"totalLamports" to amount,"allocations" to arr(2,allocation)),
 "costLimits" to obj("maxNetworkFeeLamports" to amount,"maxRentLamports" to amount,"maxAdditionalLamports" to amount),"context" to obj("feeSlot" to n,"closingSlot" to n,"closingGenesisHash" to key),"signingAuthorized" to no,"retirementAuthorized" to no,"fenceReleaseAuthorized" to no)

/** Closed public records establish consistency only. Installed trust, cryptographic
 * consent and finality remain independent wallet/server responsibilities. */
object RetirementProtocol {
 const val ROOT="/clans/charter/retirements"
 const val MAX_RESPONSE_BYTES=262144
 fun copy(raw:JsonElement):JsonElement {var nodes=0;fun visit(v:JsonElement,depth:Int):JsonElement {require(++nodes<=10000&&depth<=20);return when(v){is JsonObject->{require(v.size<=64);JsonObject(v.mapValues{(k,x)->require(k.length<=64);visit(x,depth+1)})};is JsonArray->{require(v.size<=256);JsonArray(v.map{visit(it,depth+1)})};is JsonPrimitive->v.also{require(it.content.length<=16496)}}};return visit(raw,0)}
 fun wire(raw:JsonObject):JsonObject=copy(raw).jsonObject.also{wireCheck(it)}
 fun operation(raw:JsonObject):JsonObject {
  val v=copy(raw).jsonObject
  obj("version" to ver,"original" to original,"status" to enum("cleared","issuing","prepared","signed","completed","cancelled"),"memberPayment" to payment,
   "attempt" to nullable(obj("id" to id,"candidateHex" to hex(161),"policySigner" to key,"quote" to quote)),"preparation" to nullable(obj("policySignatureHex" to hex(64),"packet" to packet)),"signed" to nullable(wireCheck),"terminal" to nullable(obj("id" to id,"outcome" to enum("completed","cancelled"))),*flags)(v)
  val o=v.charterObject("original");val r=o.charterObject("retirement");val chain=o.charterObject("creation").charterObject("chain");require(r["clanId"]==o.charterObject("creation")["clanId"])
  val a=v.charterOptional("attempt");val p=v.charterOptional("preparation");val signed=v.charterOptional("signed");val end=v.charterOptional("terminal")
  require(v.charterText("status")== (end?.charterText("outcome")?:if(signed!=null)"signed" else if(p!=null)"prepared" else if(a!=null)"issuing" else "cleared"))
  require(p==null||a!=null);require(signed==null||p!=null);require(end?.charterText("outcome")!="completed"||signed!=null)
  if(a!=null){val q=a.charterObject("quote");val input=q.charterObject("packetInput");val b=q.charterObject("observation");val source=b.charterObject("source");val deploy=source.charterObject("programs")
   require(input["original"]==o&&input["candidateHex"]==a["candidateHex"]&&input["policySigner"]==a["policySigner"]&&b["policySigner"]==a["policySigner"]&&b["registryLeader"]==r["leader"]&&b["registryRevision"]==r["expectedRevision"]&&b.charterText("lockId")=="0".repeat(32))
   val slots=listOf(b.getValue("slot"),input.charterObject("lookupTable").getValue("slot"),input.getValue("blockhashSlot"),q.charterObject("context").getValue("feeSlot"),q.charterObject("context").getValue("closingSlot")).map(CharterGrammar::number)
   require(slots.zipWithNext().all{(x,y)->x<=y}&&CharterGrammar.number(input.getValue("currentBlockHeight"))<=CharterGrammar.number(input.getValue("lastValidBlockHeight")))
   require(q.charterObject("context")["closingGenesisHash"]==chain["genesisHash"]&&source["genesisHash"]==chain["genesisHash"]&&deploy["expectedGenesisHash"]==chain["genesisHash"]&&deploy.charterObject("economy")["programId"]==chain["economyProgram"]&&deploy.charterObject("craft")["programId"]==chain["craftProgram"])
   require(input.charterObject("lookupTable")["address"]==input.charterObject("expectedLookupTable")["address"]);listOf("economy","craft","core").forEach{require(CharterGrammar.number(deploy.charterObject(it).getValue("reviewedDeploymentSlot"))<=slots.first())}
   val costs=q.charterObject("costs");val limits=q.charterObject("costLimits");fun money(x:JsonObject,k:String)=CharterGrammar.amount(x.getValue(k))
   val allocations=costs.getValue("allocations").jsonArray.map{it.jsonObject};require(allocations.size==2&&allocations.map{it["kind"]}.distinct().size==2&&allocations.map{it["address"]}.distinct().size==2)
   val fee=money(costs,"networkFeeLamports");val rent=allocations.fold(BigInteger.ZERO){sum,x->sum+money(x,"minimumBalanceLamports")};require(rent==money(costs,"rentLamports")&&fee+rent==money(costs,"totalLamports")&&fee<=money(limits,"maxNetworkFeeLamports")&&rent<=money(limits,"maxRentLamports")&&fee+rent<=money(limits,"maxAdditionalLamports"))
  }
  for(packed in listOfNotNull(a?.charterObject("quote")?.charterObject("template"),p?.charterObject("packet"))){val m=packed.charterText("messageHex");require(m.startsWith("80")&&CharterGrammar.number(packed.getValue("packetBytes"))==65L+m.length/2&&packed.charterText("unsignedTransactionHex")=="01"+"00".repeat(64)+m)}
  if(signed!=null)require(signed["messageSha256"]==p!!.charterObject("packet")["messageSha256"])
  return v
 }
 fun draft(raw:JsonObject):JsonObject {
  val v=copy(raw).jsonObject
  // These text/array limits bound transport memory, not game roster/name policy.
  obj("version" to ver,"id" to id,"actor" to key,"request" to request,"clan" to obj("id" to id,"name" to {require(CharterGrammar.text(it).length in 1..128)},"tag" to {require(CharterGrammar.text(it).length in 1..24)}),"fenceId" to id,"totalShards" to amount,"shares" to arr(256,obj("wallet" to key,"shards" to amount)),"memberPayment" to nullable(payment),"operation" to nullable{operation(it.jsonObject)},"cancelled" to bool,*flags)(v)
  val shares=v.getValue("shares").jsonArray.map{it.jsonObject};require(shares.isNotEmpty()&&shares.map{it.charterText("wallet")}.zipWithNext().all{(a,b)->a<b}&&shares.any{it["wallet"]==v["actor"]})
  require(shares.fold(BigInteger.ZERO){sum,s->sum+CharterGrammar.amount(s.getValue("shards"))}==CharterGrammar.amount(v.getValue("totalShards"))&&v.charterObject("clan")["id"]==v.charterObject("request")["clanId"])
  val paid=v.charterOptional("memberPayment");val operation=v.charterOptional("operation");require(paid==null||paid["totalShards"]==v["totalShards"]);require(!CharterGrammar.bool(v.getValue("cancelled"))||operation==null)
  operation?.let{val o=it.charterObject("original").charterObject("retirement");require(o["leader"]==v["actor"]&&o["clanId"]==v.charterObject("clan")["id"]&&o["fenceId"]==v["fenceId"]&&paid!=null&&paid==it["memberPayment"])}
  return v
 }
 fun byKey(raw:JsonObject,actor:String,key:String):JsonObject? {
  val v=copy(raw).jsonObject;obj("version" to ver,"actor" to {CharterGrammar.address(it)},"idempotencyKey" to id,"draft" to nullable{draft(it.jsonObject)})(v)
  require(v.charterText("actor")==actor&&v.charterText("idempotencyKey")==key)
  return v.charterOptional("draft")?.also{require(it.charterText("actor")==actor&&it.charterObject("request").charterText("idempotencyKey")==key)}
 }
}
fun validateRetirementRequest(method:String,path:String,query:Map<String,String>,body:JsonObject?) {
 val root=RetirementProtocol.ROOT;require(query.isEmpty()&&method in listOf("GET","POST")&&path.startsWith(root)&&'?' !in path&&'#' !in path)
 val parts=path.removePrefix(root).removePrefix("/").split('/');if(method=="GET"){
  require(body==null);if(parts.size==1)id(JsonPrimitive(parts[0])) else{require(parts.size==2&&parts[0]=="by-key");id(JsonPrimitive(parts[1]))};require(path==root+"/"+parts.joinToString("/"));return
 }
 val b=requireNotNull(body);RetirementProtocol.copy(b)
 if(path==root){request(b);return}
 require(parts.size==2&&path==root+"/"+parts.joinToString("/"));id(JsonPrimitive(parts[0]));require(parts[1] in listOf("pay-members","prepare","recover-preparation","signed","deliver","recover","cancel"))
 if(parts[1]=="signed")obj("signedTransaction" to {require(CharterGrammar.base64(it).size>129)})(b) else require(b.isEmpty())
}
