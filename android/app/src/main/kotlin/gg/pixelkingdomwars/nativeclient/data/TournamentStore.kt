package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.tournament.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class TournamentReview(val operation:JsonObject,val pins:JsonObject,val crypto:JsonObject,val policy:JsonObject)
@Serializable data class TournamentRecord(val key:String,val kind:String,val eventId:String,val path:String,val body:JsonObject,
 val response:JsonObject?=null,val observations:List<JsonObject> = emptyList(),val held:Boolean=false,val attempts:List<String> = emptyList(),
 val review:TournamentReview?=null,val signed:JsonObject?=null,
 /** Dead-end audit 2026-10-06: an entry/raid the server answered null for by key in the same explicit action;
  * counted as resolved. Any later server bytes reopen it. Absent in older journal bytes. */
 val closed:Boolean=false)
@Serializable data class TournamentJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,val records:List<TournamentRecord> = emptyList())
private val tournamentStoreJson=Json{encodeDefaults=true}

/** One encrypted atomic document owns intents before HTTP and exact wallet evidence
 * before any stale-view check. Failed storage never grants a replacement request. */
class TournamentStore(private val secret:SecretStore,val identity:StarterIdentity) {
 private class Locks {val updates=Mutex();val requests=Mutex();val observations=mutableListOf<Pair<String,JsonObject>>();val signatures=mutableMapOf<String,JsonObject>()}
 companion object {private val all=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun shared(id:StarterIdentity)=all.getOrPut(id){Locks()}}
 private val locks=shared(identity);val requests get()=locks.requests
 init {identity.validate();require(identity.origin.startsWith("https://"))}
 private suspend fun snapshot():TournamentJournal {
  val text=secret.read()?:return TournamentJournal(identity=identity);require(text.length<=8*1024*1024);val j=tournamentStoreJson.decodeFromString<TournamentJournal>(text)
  require(j.version==1&&j.identity==identity&&j.revision>=0&&j.records.size<=128&&j.records.map{it.key}.distinct().size==j.records.size)
  for(r in j.records){validateIntent(r);require(r.attempts.size<=128&&r.attempts.distinct().size==r.attempts.size&&r.observations.size<=64)
   if(r.kind=="operation") {require(r.path=="/clans/charter/tournaments/operations/${r.key}"&&r.body.isEmpty());r.response?.let{require(TournamentProtocol.operation(it).charterObject("original").charterObject("operation").charterText("leader")==identity.wallet)}}
   else validateTournamentRequest("POST",r.path,emptyMap(),r.body)
   r.response?.let{validateResponse(r,it)};r.observations.forEach{TournamentProtocol.copy(it)}
   if(r.closed)require(r.kind in listOf("entry","raid")&&r.response==null&&r.observations.isEmpty()&&r.signed==null&&r.review==null)
   r.review?.let{require(r.kind=="operation"&&r.response!=null);require(it.operation.charterObject("original")==r.response.charterObject("original")&&it.operation["operationTerms"]==r.response["operationTerms"]&&it.operation["preparation"]==r.response["preparation"]);CharterSigningTrust.from(it.pins);charterCryptoPolicy(it.crypto);TournamentProtocol.copy(it.policy)}
   r.signed?.let{val c=requireNotNull(r.review);require("wallet" in r.attempts);TournamentTransaction.verifyWire(c.operation,CharterSigningTrust.from(c.pins),it,charterCryptoPolicy(c.crypto))}
  };val raidIds=j.records.filter{it.kind=="raid"}.mapNotNull{it.response?.charterText("requestId")};require(raidIds.distinct().size==raidIds.size){"Tournament requests share a server identity."};return j
 }
 private fun validateIntent(r:TournamentRecord) {
  CharterGrammar.id(JsonPrimitive(r.key));CharterGrammar.id(JsonPrimitive(r.eventId));val root="/clans/charter/tournaments"
  if(r.kind=="operation"){require(r.path=="$root/operations/${r.key}"&&r.body.isEmpty());return}
  require(r.kind in listOf("entry","clear","raid","prize"));validateTournamentRequest("POST",r.path,emptyMap(),r.body)
  if(r.kind!="prize")require(r.body.charterText("idempotencyKey")==r.key){"Saved tournament request key changed."}
  when(r.kind){
   "entry"->require(r.path=="$root/entries"&&r.body.charterText("eventId")==r.eventId)
   "raid"->require(r.path=="$root/events/${r.eventId}/raids")
   "prize"->require(r.path=="$root/events/${r.eventId}/prize")
   "clear"->{val pieces=r.path.split('/');require(pieces.size==7&&pieces.take(5).joinToString("/")=="$root/entries"&&pieces[6]=="clear");CharterGrammar.id(JsonPrimitive(pieces[5]))}
  }
 }
 private fun write(old:TournamentJournal,rows:List<TournamentRecord>):TournamentJournal {val next=old.copy(revision=Math.addExact(old.revision,1),records=rows.toList());require(rows.size<=128);val encoded=tournamentStoreJson.encodeToString(TournamentJournal.serializer(),next);require(encoded.length<=8*1024*1024);secret.write(encoded);return next}
 private fun update(j:TournamentJournal,key:String,f:(TournamentRecord)->TournamentRecord):TournamentJournal {require(j.records.any{it.key==key});return write(j,j.records.map{if(it.key==key)f(it) else it})}
 private suspend fun flush():TournamentJournal {var j=snapshot()
  while(locks.observations.isNotEmpty()){val (key,raw)=locks.observations.first();j=update(j,key){r->require(r.observations.size<64||raw in r.observations);r.copy(observations=if(raw in r.observations)r.observations else r.observations+raw,held=true,closed=false)};locks.observations.removeAt(0)}
  while(locks.signatures.isNotEmpty()){val (key,wire)=locks.signatures.entries.first();val r=j.records.single{it.key==key};val c=requireNotNull(r.review);require("wallet" in r.attempts);TournamentTransaction.verifyWire(c.operation,CharterSigningTrust.from(c.pins),wire,charterCryptoPolicy(c.crypto));j=update(j,key){it.signed?.let{old->require(old==wire)};it.copy(signed=wire)};locks.signatures.remove(key)}
  return j
 }
 suspend fun read()=locks.updates.withLock{flush()}
 suspend fun record(key:String)=read().records.single{it.key==key}
 /** Technical journal capacity, not a game cap. Reserve the operation child before
  * an intent can POST and preserve the first clear path for every unfinished entry. */
 private fun reservations(j:TournamentJournal):Int {
  var slots=0
  fun hasOperation(id:String)=j.records.any{it.kind=="operation"&&it.key==id}
  fun operationId(v:JsonObject)=v.charterObject("original").charterObject("operation").charterText("id")
  for(r in j.records){
   if(r.kind=="clear") {if(r.response==null||!hasOperation(operationId(r.response)))slots++}
   if(r.kind!="entry")continue
   val entry=r.response
   if(entry==null){if(!r.closed)slots+=3;continue} // set child + clear intent + clear child; a closed unknown entry reserves none
   if(!hasOperation(operationId(entry.charterObject("set"))))slots++
   if(entry.charterText("status") in listOf("cancelled","released"))continue
   val entryId=entry.charterText("id")
   val released=j.records.any{it.kind=="operation"&&it.response?.charterText("entryId")==entryId&&it.response.charterObject("original").charterObject("operation").charterText("action")=="clear"&&it.response.charterText("status")=="completed"}
   if(released)continue
   val activeClear=j.records.any{it.kind=="clear"&&it.path=="/clans/charter/tournaments/entries/$entryId/clear"&&!resolved(it,j)}
   if(!activeClear)slots+=2
  }
  return slots
 }
 suspend fun begin(kind:String,key:String,event:String,path:String,body:JsonObject):TournamentRecord=locks.updates.withLock {
  val j=flush();CharterGrammar.id(JsonPrimitive(key));CharterGrammar.id(JsonPrimitive(event));require(kind in listOf("entry","clear","raid","prize"));validateTournamentRequest("POST",path,emptyMap(),body)
  j.records.singleOrNull{it.key==key}?.let{require(it.kind==kind&&it.eventId==event&&it.path==path&&it.body==body);return@withLock it}
  require(j.records.none{it.kind==kind&&it.eventId==event&&(kind=="prize"||!resolved(it,j))}){"Recover the original tournament intent first."}
  val r=TournamentRecord(key,kind,event,path,TournamentProtocol.copy(body).jsonObject);validateIntent(r);val next=j.copy(records=j.records+r);check(next.records.size+reservations(next)<=128){"Tournament journal capacity is reserved for original recovery. Complete saved entries before a new request."};write(j,next.records);r
 }
 private fun resolved(r:TournamentRecord,j:TournamentJournal):Boolean {if(r.held)return false;if(r.closed)return true;var v=r.response?:return false;if(r.kind=="clear"){val operationId=v.charterObject("original").charterObject("operation").charterText("id");val saved=j.records.singleOrNull{it.kind=="operation"&&it.key==operationId};if(saved?.held==true)return false;v=saved?.response?:v};return when(r.kind){"entry"->v.charterText("status") in listOf("cancelled","released");"clear","operation"->v.charterOptional("terminal")!=null;"raid"->v.charterText("status") in listOf("admitted","cancelled");"prize"->true;else->false}}
 suspend fun operation(raw:JsonObject):TournamentRecord=locks.updates.withLock {
  val v=TournamentProtocol.operation(raw);require(v.charterObject("original").charterObject("operation").charterText("leader")==identity.wallet);val key=v.charterObject("original").charterObject("operation").charterText("id");val j=flush()
  j.records.singleOrNull{it.key==key}?.let{require(it.kind=="operation");return@withLock it}
  val r=TournamentRecord(key,"operation",v.charterObject("operationTerms").charterText("eventId"),"/clans/charter/tournaments/operations/$key",buildJsonObject{});write(j,j.records+r);r
 }
 suspend fun observe(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{locks.observations+=key to TournamentProtocol.copy(raw).jsonObject;flush();Unit}}
 private fun validateResponse(r:TournamentRecord,raw:JsonObject):JsonObject {
  val v=when(r.kind){"entry"->TournamentProtocol.entry(raw);"clear","operation"->TournamentProtocol.operation(raw);"raid"->TournamentProtocol.raid(raw);"prize"->TournamentProtocol.prize(raw);else->error("Unknown intent")}
  when(r.kind){
   "entry"->{require(v.charterText("leader")==identity.wallet&&v["eventId"]==r.body["eventId"]&&v["clanId"]==r.body["clanId"])}
   "operation","clear"->{val o=v.charterObject("original").charterObject("operation");require(o.charterText("leader")==identity.wallet);if(r.kind=="operation")require(o.charterText("id")==r.key) else require(v.charterText("entryId")==r.path.split('/')[5]&&o.charterText("action")=="clear");require(v.charterObject("operationTerms").charterText("eventId")==r.eventId)}
   // requestId is the server row identity. The original POST/by-key route binds
   // it to this command key; immutable() keeps that attribution on every update.
   "raid"->{require(v.charterText("eventId")==r.eventId&&v["baseId"]==r.body["baseId"]);v.charterOptional("raid")?.let{raid->raid["attackerWallet"]?.let{require(CharterGrammar.text(it)==identity.wallet)};raid["attackerBaseId"]?.let{require(it==r.body["baseId"])}}}
   "prize"->require(v.charterText("eventId")==r.eventId&&v.charterText("wallet")==identity.wallet&&v["baseId"]==r.body["baseId"])
  };return v
 }
 private fun immutable(old:JsonObject,next:JsonObject,kind:String) {
  when(kind){
   "operation","clear"->{for(k in listOf("original","operationTerms","entryId"))require(old[k]==next[k]);for(k in listOf("attempt","preparation","signed","terminal"))if(old[k]!=JsonNull)require(old[k]==next[k]);if(old.charterObject("inventory").charterText("revision")=="1")require(old["inventory"]==next["inventory"])}
   "entry"->{for(k in listOf("id","eventId","clanId","leader","epochId","lockId","roster"))require(old[k]==next[k]);immutable(old.charterObject("set"),next.charterObject("set"),"operation");val a=old.charterOptional("clear");val b=next.charterOptional("clear");if(a!=null){require(b!=null);if(a.charterObject("original").charterObject("operation")["id"]==b.charterObject("original").charterObject("operation")["id"])immutable(a,b,"operation") else require(a.charterText("status")=="cancelled")}}
   "raid"->{for(k in listOf("version","eventId","requestId","baseId"))require(old[k]==next[k]);if(old.charterText("status")!="requested")require(old==next)}
   "prize"->require(old==next)
  }
 }
 suspend fun accept(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val j=flush();val r=j.records.single{it.key==key};val v=validateResponse(r,raw);if(r.kind=="raid")require(j.records.none{it.kind=="raid"&&it.key!=key&&it.response?.get("requestId")==v["requestId"]}){"Tournament request is already attributed to another original command."};r.response?.let{immutable(it,v,r.kind)};r.review?.let{c->v.charterOptional("signed")?.let{TournamentTransaction.verifyWire(c.operation,CharterSigningTrust.from(c.pins),it,charterCryptoPolicy(c.crypto))}};update(j,key){it.copy(response=v,held=false,closed=false)};Unit}}
 /** Dead-end audit 2026-10-06 (shape A). The repository calls this only after its same-action by-key GET answered
  * null for exactly this key. A record with any server bytes, a held response or wallet evidence never closes. */
 suspend fun closeAbsent(key:String):TournamentRecord=locks.updates.withLock {
  val j=flush();val r=j.records.single{it.key==key}
  check(r.kind in listOf("entry","raid")&&r.response==null&&!r.held&&r.observations.isEmpty()&&r.signed==null&&r.review==null){"The server has shown this tournament request; it stays open."}
  val next=r.copy(closed=true);update(j,key){next};next
 }
 suspend fun attempt(key:String,name:String,repeatable:Boolean=false):TournamentRecord=locks.updates.withLock {val j=flush();val r=j.records.single{it.key==key};check(!r.held);val tag=if(repeatable)"$name:${r.attempts.count{it.startsWith("$name:")}}" else name;check(tag !in r.attempts){"The original action was already attempted. Recover it first."};require(r.attempts.size<128);val next=r.copy(attempts=r.attempts+tag);update(j,key){next};next}
 suspend fun review(key:String,context:TournamentReview)=locks.updates.withLock {val j=flush();val r=j.records.single{it.key==key};require(!r.held&&"wallet" !in r.attempts&&r.kind=="operation"&&context.operation==r.response);r.review?.let{require(it==context)};update(j,key){it.copy(review=context)};Unit}
 suspend fun signed(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val wire=TournamentProtocol.wire(raw);locks.signatures[key]?.let{require(it==wire)};locks.signatures[key]=wire;flush();Unit}}
}
