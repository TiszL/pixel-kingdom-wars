package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.retirement.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class RetirementReview(val operation:JsonObject,val pins:JsonObject,val crypto:JsonObject)
@Serializable data class RetirementRecord(val key:String,val clanId:String,val response:JsonObject?=null,val observations:List<JsonObject> = emptyList(),
 val held:Boolean=false,val attempts:List<String> = emptyList(),val review:RetirementReview?=null,val signed:JsonObject?=null) {
 val request get()=buildJsonObject{put("clanId",clanId);put("idempotencyKey",key)}
 val operation get()=response?.charterOptional("operation")
 val terminal get()=response?.let{CharterGrammar.bool(it.getValue("cancelled"))||operation?.charterOptional("terminal")!=null}==true
}
@Serializable data class RetirementJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,val records:List<RetirementRecord> = emptyList())
private val retirementJson=Json{encodeDefaults=true}
/** Atomic original intent and sign-only evidence; failed writes stay queued under
 * the same identity across view recreation. Nothing clears an uncertain original. */
class RetirementStore(private val secret:SecretStore,val identity:StarterIdentity) {
 private class Locks {val updates=Mutex();val requests=Mutex();val observations=mutableListOf<Pair<String,JsonObject>>();val signatures=mutableMapOf<String,JsonObject>()}
 companion object {private val all=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun shared(id:StarterIdentity)=all.getOrPut(id){Locks()}}
 private val locks=shared(identity);val requests get()=locks.requests
 init{identity.validate();require(identity.origin.startsWith("https://"))}
 private fun response(r:RetirementRecord,raw:JsonObject)=RetirementProtocol.draft(raw).also{require(it.charterText("actor")==identity.wallet&&it.charterObject("request")==r.request)}
 private suspend fun snapshot():RetirementJournal {
  val text=secret.read()?:return RetirementJournal(identity=identity);require(text.length<=8*1024*1024)
  val j=retirementJson.decodeFromString<RetirementJournal>(text);require(j.version==1&&j.identity==identity&&j.revision>=0&&j.records.size<=128&&j.records.map{it.key}.distinct().size==j.records.size)
  for(r in j.records){CharterGrammar.id(JsonPrimitive(r.key));CharterGrammar.id(JsonPrimitive(r.clanId));require(r.attempts.size<=128&&r.attempts.distinct().size==r.attempts.size&&r.observations.size<=64)
   r.response?.let{response(r,it)};r.observations.forEach{RetirementProtocol.copy(it)}
   r.review?.let{c->val current=requireNotNull(r.operation);RetirementProtocol.operation(c.operation);require(c.operation["original"]==current["original"]&&c.operation["preparation"]==current["preparation"]);CharterSigningTrust.from(c.pins);charterCryptoPolicy(c.crypto)}
   r.signed?.let{val c=requireNotNull(r.review);require("wallet" in r.attempts);RetirementTransaction.verifyWire(c.operation,CharterSigningTrust.from(c.pins),it,charterCryptoPolicy(c.crypto))}
  };require(j.records.mapNotNull{it.response?.charterText("id")}.let{it.distinct().size==it.size});return j
 }
 private fun write(j:RetirementJournal,rows:List<RetirementRecord>):RetirementJournal{require(rows.size<=128);val next=j.copy(revision=Math.addExact(j.revision,1),records=rows);val text=retirementJson.encodeToString(RetirementJournal.serializer(),next);require(text.length<=8*1024*1024);secret.write(text);return next}
 private fun update(j:RetirementJournal,key:String,f:(RetirementRecord)->RetirementRecord):RetirementJournal{require(j.records.any{it.key==key});return write(j,j.records.map{if(it.key==key)f(it) else it})}
 private suspend fun flush():RetirementJournal {var j=snapshot()
  while(locks.observations.isNotEmpty()){val(key,raw)=locks.observations.first();j=update(j,key){r->require(r.observations.size<64||raw in r.observations);r.copy(observations=if(raw in r.observations)r.observations else r.observations+raw,held=true)};locks.observations.removeAt(0)}
  while(locks.signatures.isNotEmpty()){val(key,wire)=locks.signatures.entries.first();val r=j.records.single{it.key==key};val c=requireNotNull(r.review);require("wallet" in r.attempts);RetirementTransaction.verifyWire(c.operation,CharterSigningTrust.from(c.pins),wire,charterCryptoPolicy(c.crypto));j=update(j,key){it.signed?.let{old->require(old==wire)};it.copy(signed=wire)};locks.signatures.remove(key)};return j
 }
 suspend fun read()=locks.updates.withLock{flush()}
 suspend fun record(key:String)=read().records.single{it.key==key}
 suspend fun begin(key:String,clan:String)=locks.updates.withLock{val j=flush();CharterGrammar.id(JsonPrimitive(key));CharterGrammar.id(JsonPrimitive(clan));j.records.singleOrNull{it.key==key}?.let{require(it.clanId==clan);return@withLock it};require(j.records.none{it.clanId==clan&&(!it.terminal||it.held)}){"Recover the saved dissolution first."};val r=RetirementRecord(key,clan);write(j,j.records+r);r}
 suspend fun observe(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{locks.observations+=key to RetirementProtocol.copy(raw).jsonObject;flush();Unit}}
 private fun immutable(a:JsonObject,b:JsonObject){
  for(k in listOf("version","id","actor","request","clan","fenceId","totalShards","shares"))require(a[k]==b[k])
  if(a["memberPayment"]!=JsonNull)require(a["memberPayment"]==b["memberPayment"])
  if(CharterGrammar.bool(a.getValue("cancelled")))require(a==b)
  a.charterOptional("operation")?.let{old->val next=b.charterObject("operation");require(old["original"]==next["original"]&&old["memberPayment"]==next["memberPayment"]);for(k in listOf("attempt","preparation","signed","terminal"))if(old[k]!=JsonNull)require(old[k]==next[k])}
 }
 private fun terminalClaim(v:JsonObject):Boolean {val op=v["operation"] as? JsonObject;return v["cancelled"]==JsonPrimitive(true)||op?.get("terminal")?.let{it!=JsonNull}==true||(op?.get("status") as? JsonPrimitive)?.content in listOf("completed","cancelled")}
 private fun claimedOutcomes(v:JsonObject):List<String> {val op=v["operation"] as? JsonObject;return listOfNotNull(if(v["cancelled"]==JsonPrimitive(true))"cancelled" else null,(op?.get("status") as? JsonPrimitive)?.content,((op?.get("terminal") as? JsonObject)?.get("outcome") as? JsonPrimitive)?.content).filter{it in listOf("completed","cancelled")}}
 suspend fun accept(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val j=flush();val r=j.records.single{it.key==key};val v=response(r,raw);r.response?.let{immutable(it,v)}
  require(j.records.none{it.key!=key&&it.response?.get("id")==v["id"]})
  val owned=r.observations.filter{it["actor"]==JsonPrimitive(identity.wallet)&&it["request"]==r.request};require(owned.all{it["id"]==v["id"]}){"The saved original draft changed."}
  // A damaged terminal claim is evidence too. Only a fully validated matching
  // terminal can resolve its hold; a stale prepared reply cannot reopen signing.
  require(owned.none{terminalClaim(it)}||terminalClaim(v)){"Saved terminal evidence still needs a matching final result."}
  val outcomes=(owned+v).flatMap{claimedOutcomes(it)}.distinct();require(outcomes.size<=1){"Conflicting terminal evidence is retained for recovery."}
  r.review?.let{c->v.charterOptional("operation")?.charterOptional("signed")?.let{RetirementTransaction.verifyWire(c.operation,CharterSigningTrust.from(c.pins),it,charterCryptoPolicy(c.crypto))}}
  update(j,key){it.copy(response=v,held=false)};Unit}}
 suspend fun attempt(key:String,name:String,repeatable:Boolean=false)=locks.updates.withLock{val j=flush();val r=j.records.single{it.key==key};check(!r.held);val tag=if(repeatable)"$name:${r.attempts.count{it.startsWith("$name:")}}" else name;check(tag !in r.attempts){"This action already started. Check its original outcome."};require(r.attempts.size<128);val next=r.copy(attempts=r.attempts+tag);update(j,key){next};next}
 suspend fun review(key:String,c:RetirementReview)=locks.updates.withLock{val j=flush();val r=j.records.single{it.key==key};require(!r.held&&"wallet" !in r.attempts&&c.operation==r.operation);r.review?.let{require(it==c)};update(j,key){it.copy(review=c)};Unit}
 suspend fun signed(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val v=RetirementProtocol.wire(raw);locks.signatures[key]?.let{require(it==v)};locks.signatures[key]=v;flush();Unit}}
}
