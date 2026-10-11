package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.migration.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class MigrationReview(val migration:JsonObject,val pins:JsonObject,val crypto:JsonObject)
@Serializable data class MigrationRecord(val key:String,val clanId:String,val response:JsonObject?=null,val observations:List<JsonObject> = emptyList(),
 val held:Boolean=false,val attempts:List<String> = emptyList(),val review:MigrationReview?=null,val signed:JsonObject?=null) {
 val request get()=buildJsonObject{put("clanId",clanId);put("idempotencyKey",key)}
 val remoteId get()=(response?:observations.lastOrNull())?.charterText("id")
 val terminal get()=response?.charterOptional("terminal")!=null
}
@Serializable data class MigrationJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,val records:List<MigrationRecord> = emptyList())
private val migrationJson=Json{encodeDefaults=true}
/** The original request, pre-wallet marker, terminal evidence and late signatures
 * survive view recreation. Failed persistence blocks effects and keeps custody queued. */
class MigrationStore(private val secret:SecretStore,val identity:StarterIdentity) {
 private class Locks {val updates=Mutex();val requests=Mutex();val observations=mutableListOf<Pair<String,JsonObject>>();val signatures=mutableMapOf<String,JsonObject>()}
 companion object {private val all=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun shared(id:StarterIdentity)=all.getOrPut(id){Locks()}}
 private val locks=shared(identity);val requests get()=locks.requests
 init{identity.validate();require(identity.origin.startsWith("https://"))}
 private fun owned(r:MigrationRecord,raw:JsonObject){require(raw["actor"]==JsonPrimitive(identity.wallet)&&raw["request"]==r.request);CharterGrammar.id(raw.getValue("id"));r.response?.let{require(it["id"]==raw["id"])};require(r.observations.all{it["id"]==raw["id"]})}
 private fun response(r:MigrationRecord,raw:JsonObject)=MigrationProtocol.migration(raw).also{owned(r,it)}
 private suspend fun snapshot():MigrationJournal {
  val text=secret.read()?:return MigrationJournal(identity=identity);require(text.length<=8*1024*1024)
  val j=migrationJson.decodeFromString<MigrationJournal>(text);require(j.version==1&&j.identity==identity&&j.revision>=0&&j.records.size<=128&&j.records.map{it.key}.distinct().size==j.records.size)
  for(r in j.records){CharterGrammar.id(JsonPrimitive(r.key));CharterGrammar.id(JsonPrimitive(r.clanId));require(r.attempts.size<=128&&r.attempts.distinct().size==r.attempts.size&&r.observations.size<=64)
   r.response?.let{response(r,it)};r.observations.forEach{MigrationProtocol.copy(it);owned(r,it)}
   r.review?.let{c->MigrationProtocol.migration(c.migration);val current=requireNotNull(r.response);require(c.migration["original"]==current["original"]&&c.migration["snapshot"]==current["snapshot"]&&c.migration["signing"]==current["signing"]);CharterSigningTrust.from(c.pins);charterCryptoPolicy(c.crypto)}
   r.signed?.let{val c=requireNotNull(r.review);require("wallet" in r.attempts);MigrationTransaction.verifyWire(c.migration,CharterSigningTrust.from(c.pins),it,charterCryptoPolicy(c.crypto))}
  };require(j.records.mapNotNull{it.response?.charterText("id")}.let{it.distinct().size==it.size});return j
 }
 private fun write(j:MigrationJournal,rows:List<MigrationRecord>):MigrationJournal{require(rows.size<=128);val next=j.copy(revision=Math.addExact(j.revision,1),records=rows);val text=migrationJson.encodeToString(MigrationJournal.serializer(),next);require(text.length<=8*1024*1024);secret.write(text);return next}
 private fun update(j:MigrationJournal,key:String,f:(MigrationRecord)->MigrationRecord):MigrationJournal{require(j.records.any{it.key==key});return write(j,j.records.map{if(it.key==key)f(it) else it})}
 private suspend fun flush():MigrationJournal {var j=snapshot()
  while(locks.observations.isNotEmpty()){val(key,raw)=locks.observations.first();j=update(j,key){r->owned(r,raw);require(r.observations.size<64||raw in r.observations);r.copy(observations=if(raw in r.observations)r.observations else r.observations+raw,held=true)};locks.observations.removeAt(0)}
  while(locks.signatures.isNotEmpty()){val(key,wire)=locks.signatures.entries.first();val r=j.records.single{it.key==key};val c=requireNotNull(r.review);require("wallet" in r.attempts);MigrationTransaction.verifyWire(c.migration,CharterSigningTrust.from(c.pins),wire,charterCryptoPolicy(c.crypto));j=update(j,key){it.signed?.let{old->require(old==wire)};it.copy(signed=wire)};locks.signatures.remove(key)};return j
 }
 suspend fun read()=locks.updates.withLock{flush()}
 suspend fun record(key:String)=read().records.single{it.key==key}
 private fun add(j:MigrationJournal,key:String,clan:String,fresh:Boolean):MigrationRecord {CharterGrammar.id(JsonPrimitive(key));CharterGrammar.id(JsonPrimitive(clan));j.records.singleOrNull{it.key==key}?.let{require(it.clanId==clan);return it};if(fresh)require(j.records.none{it.clanId==clan&&(!it.terminal||it.held)}){"Recover the saved migration first."};val r=MigrationRecord(key,clan);write(j,j.records+r);return r}
 suspend fun begin(key:String,clan:String)=locks.updates.withLock{add(flush(),key,clan,true)}
 /** A server-owned historical request may coexist with a later request for the same clan. */
 suspend fun discover(raw:JsonObject)=locks.updates.withLock{val v=MigrationProtocol.copy(raw).jsonObject;require(v["actor"]==JsonPrimitive(identity.wallet));CharterGrammar.id(v.getValue("id"));val q=v.charterObject("request");require(q.keys==setOf("clanId","idempotencyKey"));add(flush(),q.charterText("idempotencyKey"),q.charterText("clanId"),false).also{owned(it,v)}}
 suspend fun observe(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val v=MigrationProtocol.copy(raw).jsonObject;owned(flush().records.single{it.key==key},v);locks.observations+=key to v;flush();Unit}}
 private fun immutable(a:JsonObject,b:JsonObject){for(k in listOf("version","id","actor","request","snapshot","original"))require(a[k]==b[k]);for(k in listOf("signing","wire","terminal"))if(a[k]!=JsonNull)require(a[k]==b[k]);if(a.charterOptional("terminal")!=null)require(a==b)}
 suspend fun accept(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val j=flush();val r=j.records.single{it.key==key};val v=response(r,raw);r.response?.let{immutable(it,v)};require(j.records.none{it.key!=key&&it.response?.get("id")==v["id"]})
  val claims=r.observations.flatMap{MigrationProtocol.observedTerminal(it)}.toSet();val current=MigrationProtocol.observedTerminal(v)
  require(claims.isEmpty()||current.isNotEmpty()){"Saved terminal evidence still needs a matching final result."};require((claims+current).filter{it!="unknown"}.distinct().size<=1){"Conflicting terminal evidence is retained for recovery."}
  r.review?.let{c->v.charterOptional("wire")?.let{MigrationTransaction.verifyWire(c.migration,CharterSigningTrust.from(c.pins),it,charterCryptoPolicy(c.crypto))}}
  update(j,key){it.copy(response=v,held=false)};Unit}}
 suspend fun attempt(key:String,name:String,repeatable:Boolean=false)=locks.updates.withLock{val j=flush();val r=j.records.single{it.key==key};check(!r.held||name=="recover");val tag=if(repeatable)"$name:${r.attempts.count{it.startsWith("$name:")}}" else name;check(tag !in r.attempts){"This action already started. Check its original outcome."};require(r.attempts.size<128);val next=r.copy(attempts=r.attempts+tag);update(j,key){next};next}
 suspend fun review(key:String,c:MigrationReview)=locks.updates.withLock{val j=flush();val r=j.records.single{it.key==key};require(!r.held&&"wallet" !in r.attempts&&c.migration==r.response);r.review?.let{require(it==c)};update(j,key){it.copy(review=c)};Unit}
 suspend fun signed(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val v=CharterRegistrationProtocol.wire(raw);locks.signatures[key]?.let{require(it==v)};locks.signatures[key]=v;flush();Unit}}
}
