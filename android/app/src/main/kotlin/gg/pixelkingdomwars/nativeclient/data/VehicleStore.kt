package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class VehicleConsent(val client:JsonObject,val pins:JsonObject)
/** [closedUnknown]: the server's own by-key "no record of this key" answer that archived a non-terminal original (owner rule
 * 2026-10-06). Only archives carry it; a later server answer that knows the key returns the record to pending. */
@Serializable data class VehicleRecord(val id:String,val kind:String,val key:String,val request:JsonObject,val policy:JsonObject,
 val response:JsonObject?=null,val preview:JsonObject?=null,val destination:JsonObject?=null,val observations:List<JsonObject> = emptyList(),val held:Boolean=false,
 val attempts:List<String> = emptyList(),val consent:VehicleConsent?=null,val signed:JsonObject?=null,val closedUnknown:JsonObject?=null)
@Serializable data class VehicleJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,
 val pending:List<VehicleRecord> = emptyList(),val archives:List<VehicleRecord> = emptyList()) {
 val records get()=pending+archives
}
private val vehicleStoreJson=Json{encodeDefaults=true}

/** Original requests and verified wallet bytes outlive screen/session eligibility.
 * Pending/archive limits never evict an unresolved record or recreate an effect. */
class VehicleStore(private val secret:SecretStore,val identity:StarterIdentity) {
 private class Locks {val updates=Mutex();val requests=Mutex();val observations=mutableListOf<Pair<String,JsonObject>>();val signatures=mutableMapOf<String,JsonObject>()}
 companion object {private val all=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun shared(id:StarterIdentity)=all.getOrPut(id){Locks()}
  /** The server's by-key not-found codes (night/server apps/api/src/game: vehicleWorkflow.ts:20, vehicleServiceWorkflow.ts:24).
   * A bare 404 (route absent, feature off) is not evidence that the server does not know a key. */
  fun unknownCode(kind:String)=when(kind){"installation"->"VEHICLE_RESERVATION_UNKNOWN";"service"->"VEHICLE_SERVICE_UNKNOWN";else->error("No by-key not-found code for $kind")}
  fun serverUnknown(kind:String)=buildJsonObject{put("status",404);put("code",unknownCode(kind))}
 }
 private val locks=shared(identity);val requests get()=locks.requests
 init {identity.validate();require(identity.origin.startsWith("https://"))}
 fun path(kind:String)=when(kind){"installation"->"/vehicles/client/installations";"service"->"/vehicles/client/services";"expedition"->"/advanced-expeditions";"collect"->"/advanced-expeditions/collect";else->error("Unsupported vehicle intent")}
 private fun validate(r:VehicleRecord) {
  CharterGrammar.id(JsonPrimitive(r.id));require(r.attempts.size<=128&&r.attempts.distinct().size==r.attempts.size&&r.observations.size<=64)
  val policy=VehiclePolicy.from(r.policy);VehicleProtocol.validateRequest("POST",path(r.kind),emptyMap(),r.request)
  if(r.kind=="collect")CharterGrammar.id(JsonPrimitive(r.key)) else require(r.request.charterText("idempotencyKey")==r.key)
  r.destination?.let{require(r.kind in listOf("installation","service")&&it.keys==setOf("baseId","berthId"));it.values.forEach(CharterGrammar::id)}
  r.preview?.let{require(r.kind=="expedition");policy.verifyRoute(it)};r.response?.let{validateResponse(r,it)};r.observations.forEach{VehicleProtocol.copy(it)}
  r.consent?.let{require(r.kind in listOf("installation","service")&&r.response!=null);VehicleSigningTrust.from(it.pins);policy.verifyClient(it.client);VehicleTransaction.verifyHistory(it.client,policy);require(VehicleProtocol.original(it.client)==VehicleProtocol.original(r.response)&&it.client["consentSource"]==r.response["consentSource"]&&it.client.charterObject("record")["preparation"]==r.response.charterObject("record")["preparation"])}
  r.signed?.let{require("wallet" in r.attempts);VehicleTransaction.verifyWire(requireNotNull(r.consent).client,it,policy)}
  r.closedUnknown?.let{verifyClosedUnknown(r,it)}
 }
 private fun verifyClosedUnknown(r:VehicleRecord,e:JsonObject) {
  require(r.consent==null&&r.signed==null&&"wallet" !in r.attempts)
  when(r.kind){
   "expedition"->{val v=VehicleProtocol.expedition(e);require(v.charterText("status")=="unknown"&&v.charterText("wallet")==identity.wallet&&v.charterText("idempotencyKey")==r.key);require(r.response==null||r.response.charterText("status")=="unknown")}
   "installation","service"->require(r.response==null&&e==serverUnknown(r.kind))
   else->error("A collection has no by-key record that can show the server does not know it.")
  }
 }
 private fun validateResponse(r:VehicleRecord,raw:JsonObject):JsonObject {
  val policy=VehiclePolicy.from(r.policy)
  return when(r.kind){
   "installation","service"->VehicleProtocol.client(raw).also{require(it.charterText("kind")==r.kind&&VehicleProtocol.actor(it)==identity.wallet&&VehicleProtocol.request(it)==r.request);r.destination?.let{d->require(VehicleProtocol.destination(it)==d)};policy.verifyClient(it);VehicleTransaction.verifyHistory(it,policy)}
   "expedition"->VehicleProtocol.expedition(raw).also{require(it.charterText("wallet")==identity.wallet&&it.charterText("idempotencyKey")==r.key);it.charterOptional("receipt")?.let{receipt->require(receipt.charterObject("request")==r.request);r.preview?.let{require(receipt["route"]==it)}};policy.verifyExpedition(it)}
   "collect"->VehicleProtocol.collect(raw).also{require(it["baseId"]==r.request["baseId"])}
   else->error("Unsupported vehicle history")
  }
 }
 private fun serverReference(r:VehicleRecord)=r.response?.takeIf{r.kind in listOf("installation","service")}?.let{VehicleProtocol.reference(it).toString()}
 private fun unique(j:VehicleJournal){val rows=j.records;require(rows.map{it.id}.distinct().size==rows.size&&rows.map{it.kind to it.key}.distinct().size==rows.size);val refs=rows.mapNotNull(::serverReference);require(refs.distinct().size==refs.size){"Vehicle history duplicates a server operation."}}
 private fun snapshot():VehicleJournal {val text=secret.read()?:return VehicleJournal(identity=identity);require(text.length<=8*1024*1024);val j=vehicleStoreJson.decodeFromString<VehicleJournal>(text);require(j.version==1&&j.identity==identity&&j.revision>=0&&j.pending.size<=512&&j.archives.size<=512);unique(j);j.records.forEach(::validate);j.archives.forEach{require(isTerminal(it)||it.closedUnknown!=null)};j.pending.forEach{require(it.closedUnknown==null)};return j}
 private fun write(j:VehicleJournal,pending:List<VehicleRecord> = j.pending,archives:List<VehicleRecord> = j.archives):VehicleJournal {val next=j.copy(revision=Math.addExact(j.revision,1),pending=pending.toList(),archives=archives.toList());unique(next);val text=vehicleStoreJson.encodeToString(VehicleJournal.serializer(),next);require(text.length<=8*1024*1024);secret.write(text);return next}
 private fun update(j:VehicleJournal,id:String,fn:(VehicleRecord)->VehicleRecord):VehicleJournal {require(j.records.any{it.id==id});return write(j,j.pending.map{if(it.id==id)fn(it) else it},j.archives.map{if(it.id==id)fn(it) else it})}
 private fun flush():VehicleJournal {var j=snapshot();while(locks.observations.isNotEmpty()){val(id,raw)=locks.observations.first();j=update(j,id){r->require(r.observations.size<64||raw in r.observations);r.copy(observations=if(raw in r.observations)r.observations else r.observations+raw,held=true)};locks.observations.removeAt(0)}
  while(locks.signatures.isNotEmpty()){val(id,wire)=locks.signatures.entries.first();val r=j.records.single{it.id==id};require("wallet" in r.attempts);val c=requireNotNull(r.consent);VehicleTransaction.verifyWire(c.client,wire,VehiclePolicy.from(r.policy));j=update(j,id){it.signed?.let{require(it==wire)};it.copy(signed=wire)};locks.signatures.remove(id)};return j
 }
 suspend fun read()=locks.updates.withLock{flush()}
 suspend fun record(id:String)=read().records.single{it.id==id}
 fun isTerminal(r:VehicleRecord):Boolean {val v=r.response?:return false;return when(r.kind){"installation","service"->VehicleProtocol.terminal(v)!=null;"expedition"->v.charterOptional("return")!=null;"collect"->true;else->false}}
 suspend fun begin(kind:String,key:String,request:JsonObject,policy:VehiclePolicy,preview:JsonObject?=null,destination:JsonObject?=null)=create(kind,key,request,policy,preview,destination,false)
 private suspend fun create(kind:String,key:String,request:JsonObject,policy:VehiclePolicy,preview:JsonObject?,destination:JsonObject?,historical:Boolean):VehicleRecord=locks.updates.withLock{
  val j=flush();j.records.singleOrNull{it.kind==kind&&it.key==key}?.let{require(it.request==request&&it.preview==preview&&(it.destination==null||destination==null||it.destination==destination));return@withLock it}
  check(j.pending.size<policy.bound("localPendingLimit")){"Vehicle journal is full. Recover and archive saved originals first."}
  // A saved unknown burn/dispatch cannot be bypassed with another command key.
  check(historical||kind !in listOf("installation","service")||j.pending.none{!isTerminal(it)&&it.kind in listOf("installation","service")&&it.request["assetId"]==request["assetId"]}){"Recover the original asset burn before reserving another."}
  check(historical||j.pending.none{!isTerminal(it)&&it.kind==kind&&when(kind){"installation"->it.request["assetId"]==request["assetId"]||it.request["berthId"]==request["berthId"];"service"->it.request["assetId"]==request["assetId"]||it.request["installationId"]==request["installationId"];"expedition","collect"->it.request["baseId"]==request["baseId"];else->true}}){"Recover the original vehicle intent before creating another."}
  val r=VehicleRecord(UUID.randomUUID().toString(),kind,key,VehicleProtocol.copy(request).jsonObject,policy.raw,preview=preview?.let{VehicleProtocol.copy(it).jsonObject},destination=destination?.let{VehicleProtocol.copy(it).jsonObject});validate(r);write(j,j.pending+r);r
 }
 private fun immutable(r:VehicleRecord,next:JsonObject){val old=r.response?:return
  when(r.kind){
   "installation","service"->{require(VehicleProtocol.original(old)==VehicleProtocol.original(next));for(k in listOf("consentSource","burnReceipt"))if(old[k]!=JsonNull)require(old[k]==next[k]);val a=old.charterObject("record");val b=next.charterObject("record");for(k in listOf("preparation","signed",if(r.kind=="installation")"installation" else "application"))if(a[k]!=JsonNull)require(a[k]==b[k])}
   "expedition"->{for(k in listOf("receipt","return"))if(old[k]!=JsonNull)require(old[k]==next[k])}
   "collect"->require(JsonObject(old-"serverNow")==JsonObject(next-"serverNow"))
  }
 }
 suspend fun observe(id:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{locks.observations+=id to VehicleProtocol.copy(raw).jsonObject;flush();Unit}}
 suspend fun accept(id:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val j=flush();val r=j.records.single{it.id==id};val v=validateResponse(r,raw);immutable(r,v);val next=r.copy(response=v,held=false,observations=r.observations.filterNot{it==v||it["client"]==v});serverReference(next)?.let{ref->require(j.records.none{it.id!=id&&serverReference(it)==ref})};r.signed?.let{wire->val signed=v.charterObject("record").charterOptional("signed");signed?.let{for(k in listOf("signature","messageSha256","wireSha256"))require(it[k]==wire[k])}}
  // Acceptance wins: a closed "server has no record" original that the server now knows returns to pending with this answer.
  if(r.closedUnknown!=null&&!(r.kind=="expedition"&&v.charterText("status")=="unknown")){check(j.pending.size<512){"Vehicle journal is full. Saved originals have been preserved."};write(j,j.pending+next.copy(closedUnknown=null),j.archives.filterNot{it.id==id})}
  else update(j,id){next};Unit}}
 suspend fun adopt(raw:JsonObject,policy:VehiclePolicy):VehicleRecord {val v=VehicleProtocol.client(raw);require(VehicleProtocol.actor(v)==identity.wallet);policy.verifyClient(v);VehicleTransaction.verifyHistory(v,policy);val kind=v.charterText("kind");val request=VehicleProtocol.request(v);val key=request.charterText("idempotencyKey");val r=create(kind,key,request,policy,null,VehicleProtocol.destination(v),true);observe(r.id,v);accept(r.id,v);return record(r.id)}
 suspend fun adoptExpedition(raw:JsonObject,policy:VehiclePolicy):VehicleRecord {val v=VehicleProtocol.expedition(raw);require(v.charterText("wallet")==identity.wallet);policy.verifyExpedition(v);val receipt=requireNotNull(v.charterOptional("receipt"));val r=create("expedition",v.charterText("idempotencyKey"),receipt.charterObject("request"),policy,receipt.charterObject("route"),null,true);observe(r.id,v);accept(r.id,v);return record(r.id)}
 suspend fun attempt(id:String,name:String,repeatable:Boolean=false):VehicleRecord=locks.updates.withLock{val j=flush();val r=j.pending.single{it.id==id};check(!r.held);require(r.attempts.size<128);val tag=if(repeatable)"$name:${r.attempts.count{it.startsWith("$name:")}}" else name;check(tag !in r.attempts){"Original action already attempted. Recover its saved result."};val next=r.copy(attempts=r.attempts+tag);update(j,id){next};next}
 suspend fun consent(id:String,value:VehicleConsent)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.id==id};require(!r.held&&"wallet" !in r.attempts&&r.response==value.client);VehicleSigningTrust.from(value.pins);r.consent?.let{old->require(old.pins==value.pins&&JsonObject(old.client+("record" to JsonObject(old.client.charterObject("record")-"serverNow")))==JsonObject(value.client+("record" to JsonObject(value.client.charterObject("record")-"serverNow"))))};update(j,id){it.copy(consent=it.consent?:value)};Unit}
 suspend fun signed(id:String,wire:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val raw=VehicleProtocol.copy(wire).jsonObject;locks.signatures[id]?.let{require(it==raw)};locks.signatures[id]=raw;flush();Unit}}
 suspend fun archive(id:String,expected:VehicleRecord)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.id==id};require(r==expected&&!r.held&&isTerminal(r));validate(r);val policy=VehiclePolicy.from(r.policy);check(j.archives.size<policy.bound("localArchiveLimit")){"Vehicle archive is full. Saved originals have been preserved."};write(j,j.pending.filterNot{it.id==id},j.archives+r);Unit}
 /** Owner rule 2026-10-06 (no saved request may block play forever): a pending, non-terminal, unheld original is archived
  * with [evidence] only when its own by-key read in the closing action said the server has no record of its key.
  * Expedition: [evidence] is that read's "unknown" answer, already stored as the response. Installation/service: no
  * reservation, consent or wallet bytes were ever saved and the read answered the kind's not-found code. Never a collect. */
 suspend fun closeUnknown(id:String,expected:VehicleRecord,evidence:JsonObject)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.id==id};require(r==expected&&!r.held&&!isTerminal(r)&&r.closedUnknown==null)
  val e=VehicleProtocol.copy(evidence).jsonObject
  if(r.kind=="expedition")require(r.response!=null&&r.response==VehicleProtocol.expedition(e)){"Check the saved expedition by its key first."}
  val next=r.copy(closedUnknown=e);validate(next)
  check(j.archives.size<VehiclePolicy.from(r.policy).bound("localArchiveLimit")){"Vehicle archive is full. Saved originals have been preserved."}
  write(j,j.pending.filterNot{it.id==id},j.archives+next);Unit}
}
