@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class EquipmentRefusal(val status:Int,val code:String,val attemptRevision:Long)
fun equipmentDefinitiveRefusal(status:Int,code:String?)=code!=null&&mapOf("INSUFFICIENT_CRAFTING_STOCK" to 422,"EQUIPMENT_CRAFT_UNAVAILABLE" to 409,"COMPASS_UNAVAILABLE" to 409,"LENS_UNAVAILABLE" to 409)[code]==status
@Serializable data class EquipmentRecord(val kind:String,val key:String,val request:JsonObject,val policy:JsonObject,
 val recipe:EquipmentRecipe?=null,val preview:JsonObject?=null,val vehiclePolicy:JsonObject?=null,
 val discardedUnsent:Boolean=false,val closedRefusal:Boolean=false,val attempted:Boolean=false,val attemptRevision:Long?=null,val refusal:EquipmentRefusal?=null,val response:JsonObject?=null,val held:Boolean=false,val observations:List<JsonObject> = emptyList(),
 /** Owner rule 2026-10-06: a sent original closed on this device after the same action's by-key GET answered "unknown".
  * Absent from older bytes and never written while false, so existing journals decode and re-encode unchanged. */
 @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val closedUnknown:Boolean=false,
 /** Owner review 2026-10-06: the last POST failed with 502/503/504, so the server may still be processing it; it cannot be
  * closed as unknown until [gg.pixelkingdomwars.nativeclient.ops.SAVED_REQUEST_MIN_AGE_MS] after that failure. Never written while null. */
 @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val serverBusyAtMs:Long?=null)
@Serializable data class EquipmentJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,
 val pending:List<EquipmentRecord> = emptyList(),val archives:List<EquipmentRecord> = emptyList()) {val records get()=pending+archives}
private val equipmentStoreJson=Json{encodeDefaults=true}
/** Per-origin/cluster/wallet custody. Read failures preserve bytes; full journals
 * refuse new commands. Original responses drain before view/session publication. */
class EquipmentStore(private val secret:SecretStore,val identity:StarterIdentity,private val clock:()->Long=System::currentTimeMillis) {
 private class Locks {val updates=Mutex();val requests=Mutex();val replies=mutableListOf<Pair<String,JsonObject>>();val refusals=mutableListOf<Pair<String,EquipmentRefusal>>()}
 companion object {private val all=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun shared(id:StarterIdentity)=all.getOrPut(id){Locks()}}
 private val locks=shared(identity);val requests get()=locks.requests
 init{identity.validate()}
 fun path(kind:String)=when(kind){"craft"->"/ordinary-equipment/jobs";"starter"->"/starter-expeditions";"advanced"->"/advanced-expeditions";"collect"->"/advanced-expeditions/collect";else->error("Unknown equipment operation")}
 fun receiptPath(r:EquipmentRecord)=path(r.kind)+if(r.kind=="craft")"/by-key/${r.key}" else "/by-key/${r.key}"
 fun terminal(r:EquipmentRecord)=r.response?.let{when(r.kind){"craft"->it["completion"]!=JsonNull;"starter","advanced"->it["return"]!=JsonNull;"collect"->true;else->false}}?:false
 private fun validate(r:EquipmentRecord){CharterGrammar.id(JsonPrimitive(r.key));EquipmentPolicy.from(r.policy);EquipmentGrammar.request("POST",path(r.kind),emptyMap(),r.request)
  require(r.kind=="collect"||r.request.charterText("idempotencyKey")==r.key);require(r.observations.size<=32)
  when(r.kind){"craft"->{require(r.preview==null&&r.vehiclePolicy==null);val c=EquipmentCommand(EquipmentGrammar.craftRequest(r.request),requireNotNull(r.recipe));c.validate();EquipmentPolicy.from(r.policy).verify(c.recipe)}
   "starter"->{require(r.recipe==null&&r.vehiclePolicy==null);EquipmentGrammar.starterRoute(requireNotNull(r.preview),EquipmentPolicy.from(r.policy),true)}
   "advanced"->{require(r.recipe==null);VehiclePolicy.from(requireNotNull(r.vehiclePolicy)).verifyRoute(requireNotNull(r.preview))}
   "collect"->require(r.recipe==null&&r.preview==null&&r.vehiclePolicy==null)}
  require(r.attempted==(r.attemptRevision!=null));r.attemptRevision?.let{require(it>0)};r.refusal?.let{require(r.attempted&&it.attemptRevision==r.attemptRevision&&equipmentDefinitiveRefusal(it.status,it.code))};if(r.discardedUnsent)require(!r.attempted);if(r.closedRefusal)require(r.refusal!=null);if(r.closedUnknown)require(r.attempted&&!r.discardedUnsent&&!r.closedRefusal);r.response?.let{verify(r,it)};r.observations.forEach(VehicleProtocol::copy)
 }
 fun verify(r:EquipmentRecord,raw:JsonObject){when(r.kind){
  "craft"->EquipmentProof.from(raw,identity,EquipmentCommand(EquipmentGrammar.craftRequest(r.request),requireNotNull(r.recipe)))
  "starter"->EquipmentGrammar.starterProof(raw,identity,r.request,requireNotNull(r.preview),EquipmentPolicy.from(r.policy))
  "advanced"->{val v=VehicleProtocol.expedition(raw);require(v.charterText("wallet")==identity.wallet&&v.charterText("idempotencyKey")==r.key);v.charterOptional("receipt")?.let{require(it.charterObject("request")==r.request&&it.charterObject("route")==r.preview)};VehiclePolicy.from(requireNotNull(r.vehiclePolicy)).verifyExpedition(v)}
  "collect"->{VehicleProtocol.collect(raw);require(raw["baseId"]==r.request["baseId"])}
 }}
 private fun snapshot():EquipmentJournal{val text=secret.read()?:return EquipmentJournal(identity=identity);require(text.length<=8*1024*1024);val j=equipmentStoreJson.decodeFromString<EquipmentJournal>(text);require(j.version==1&&j.identity==identity&&j.revision>=0&&j.pending.size<=128&&j.archives.size<=128&&j.records.map{it.key}.distinct().size==j.records.size);j.records.forEach{validate(it);require(it.attemptRevision==null||it.attemptRevision<=j.revision)};j.pending.forEach{require(!it.discardedUnsent&&!it.closedRefusal&&!it.closedUnknown)};j.archives.forEach{require((terminal(it)||it.discardedUnsent||it.closedRefusal||it.closedUnknown)&&!it.held)};return j}
 private fun save(j:EquipmentJournal,pending:List<EquipmentRecord> = j.pending,archives:List<EquipmentRecord> = j.archives):EquipmentJournal{val next=j.copy(revision=Math.addExact(j.revision,1),pending=pending,archives=archives);val raw=equipmentStoreJson.encodeToString(EquipmentJournal.serializer(),next);require(raw.length<=8*1024*1024);secret.write(raw);return next}
 private fun update(j:EquipmentJournal,key:String,fn:(EquipmentRecord)->EquipmentRecord):EquipmentJournal{require(j.records.any{it.key==key});return save(j,j.pending.map{if(it.key==key)fn(it)else it},j.archives.map{if(it.key==key)fn(it)else it})}
 private fun flush():EquipmentJournal{var j=snapshot();while(locks.replies.isNotEmpty()){val(key,raw)=locks.replies.first();j=update(j,key){r->require(raw in r.observations||r.observations.size<32);r.copy(held=true,observations=if(raw in r.observations)r.observations else r.observations+raw)};locks.replies.removeAt(0)}
  while(locks.refusals.isNotEmpty()){val(key,refusal)=locks.refusals.first();val r=j.records.single{it.key==key};if(r.attemptRevision==refusal.attemptRevision&&r.response?.get("status")!=JsonPrimitive("accepted"))j=update(j,key){it.copy(refusal=refusal)};locks.refusals.removeAt(0)};return j}
 suspend fun read()=locks.updates.withLock{flush()}
 suspend fun record(key:String)=read().records.single{it.key==key}
 suspend fun begin(record:EquipmentRecord)=locks.updates.withLock{val j=flush();validate(record);require(!record.discardedUnsent&&!record.closedRefusal&&record.refusal==null&&record.attemptRevision==null&&!record.attempted&&record.response==null&&!record.held&&record.observations.isEmpty());check(j.pending.size<128&&j.records.none{it.key==record.key}){"Saved equipment journal is full or already holds this key."}
  check(j.pending.none{!terminal(it)&&it.request["baseId"]==record.request["baseId"]&&if(record.kind=="collect")it.kind=="collect"else it.kind!="collect"}){"Recover the original equipment operation before starting another."};save(j,j.pending+record);record}
 suspend fun attempt(key:String)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.key==key};check(!r.held&&!terminal(r)&&r.refusal==null);val next=r.copy(attempted=true,attemptRevision=Math.addExact(j.revision,1),serverBusyAtMs=null);update(j,key){next};next}
 /** Records that [attemptRevision]'s POST failed with a gateway status (502/503/504): the server may still be processing it. */
 suspend fun markServerBusy(key:String,attemptRevision:Long)=withContext(NonCancellable){locks.updates.withLock{val j=flush();val r=j.pending.firstOrNull{it.key==key}
  if(r!=null&&r.attemptRevision==attemptRevision&&r.response?.get("status")!=JsonPrimitive("accepted"))update(j,key){it.copy(serverBusyAtMs=clock())};Unit}}
 suspend fun retain(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val owned=VehicleProtocol.copy(raw).jsonObject;locks.replies+=key to owned;val j=flush();val r=j.records.single{it.key==key};verify(r,owned)
  r.response?.let{old->if(r.kind=="collect")require(JsonObject(old-"serverNow")==JsonObject(owned-"serverNow"))else for(k in listOf("receipt",if(r.kind=="craft")"completion" else "return"))if(old[k]!=JsonNull)require(old[k]==owned[k])}
  update(j,key){it.observations.filterNot{observation->observation==owned}.let{remaining->it.copy(response=owned,held=remaining.isNotEmpty(),observations=remaining)}};Unit}}
 suspend fun refuse(key:String,refusal:EquipmentRefusal)=withContext(NonCancellable){require(equipmentDefinitiveRefusal(refusal.status,refusal.code));locks.updates.withLock{locks.refusals+=key to refusal;flush();Unit}}
 /** A sent original without a definitive refusal closes only with [fresh]: the by-key reply the caller's
  * same action just retained, which must still be the saved response and say "unknown" (owner rule 2026-10-06). */
 suspend fun discard(key:String,expected:EquipmentRecord,fresh:JsonObject?=null)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.key==key};val unknown=r.attempted&&r.refusal==null
  require(r==expected&&(!unknown||fresh!=null&&r.response==fresh)&&!r.held&&r.observations.isEmpty()&&r.response?.charterText("status")=="unknown")
  check(!unknown||r.serverBusyAtMs==null||clock()-r.serverBusyAtMs>=gg.pixelkingdomwars.nativeclient.ops.SAVED_REQUEST_MIN_AGE_MS){"The server may still be processing this request. Check it again in a few minutes."};check(j.archives.size<128);save(j,j.pending.filterNot{it.key==key},j.archives+r.copy(discardedUnsent=!r.attempted,closedRefusal=r.attempted&&!unknown,closedUnknown=unknown));Unit}
 suspend fun archive(key:String,expected:EquipmentRecord)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.key==key};require(r==expected&&terminal(r)&&!r.held);check(j.archives.size<128);save(j,j.pending.filterNot{it.key==key},j.archives+r);Unit}
}
