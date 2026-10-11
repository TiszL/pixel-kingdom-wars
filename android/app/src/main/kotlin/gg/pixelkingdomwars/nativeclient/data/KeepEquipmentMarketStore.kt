@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class KeepEquipmentMarketConsent(val purchase:JsonObject,val review:JsonObject,val pins:JsonObject)
@Serializable data class KeepEquipmentMarketRecord(val kind:String,val key:String,val request:JsonObject,val policy:JsonObject,val preview:JsonObject?=null,
 val response:JsonObject?=null,val attempts:List<String> = emptyList(),val consent:KeepEquipmentMarketConsent?=null,val signed:JsonObject?=null,
 val held:Boolean=false,val observations:List<JsonObject> = emptyList(),val discardedUnsent:Boolean=false,
 /** Owner rule 2026-10-06: a POSTed original closed on this device after the same action's by-key GET found no such
  * record. Late server evidence may still attach to it. Never written while false, so older bytes stay unchanged. */
 @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val closedAbsent:Boolean=false)
@Serializable data class KeepEquipmentMarketJournal(val version:Int=1,val identity:StarterIdentity,val revision:Long=0,
 val pending:List<KeepEquipmentMarketRecord> = emptyList(),val archives:List<KeepEquipmentMarketRecord> = emptyList()){val records get()=pending+archives}
private val marketStoreJson=Json{encodeDefaults=true}
/** Representation bounds from shared PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT,
 * September 28. No eviction, wallet reset or expiry releases an original. */
class KeepEquipmentMarketStore(private val secret:SecretStore,val identity:StarterIdentity) {
 private class Locks{val updates=Mutex();val requests=Mutex();val replies=mutableListOf<Pair<String,JsonObject>>();val signatures=mutableMapOf<String,JsonObject>()}
 companion object{private val all=mutableMapOf<StarterIdentity,Locks>();@Synchronized private fun shared(id:StarterIdentity)=all.getOrPut(id){Locks()}}
 private val locks=shared(identity);val requests get()=locks.requests
 init{identity.validate();require(identity.origin.startsWith("https://"))}
 fun path(kind:String)=KeepEquipmentMarketProtocol.ROOT+when(kind){"listing"->"/listings";"fill"->"/fills";"cancellation"->"/cancellations";else->error("Unknown market operation")}
 fun terminal(r:KeepEquipmentMarketRecord)=r.discardedUnsent||r.closedAbsent||r.response?.let{r.kind!="fill"||KeepEquipmentMarketProtocol.terminalPurchase(it)}==true
 private suspend fun validate(r:KeepEquipmentMarketRecord){CharterGrammar.id(JsonPrimitive(r.key));KeepEquipmentMarketProtocol.policy(r.policy);KeepEquipmentMarketProtocol.request("POST",path(r.kind),emptyMap(),r.request);require(r.request.charterText("idempotencyKey")==r.key&&r.attempts.size<=128&&r.attempts.distinct().size==r.attempts.size&&r.observations.size<=32);r.preview?.let(KeepEquipmentMarketProtocol::listing)
  if(r.discardedUnsent)require(r.attempts.isEmpty()&&r.response==null&&r.consent==null&&r.signed==null&&!r.held)
  if(r.closedAbsent)require(!r.discardedUnsent&&r.attempts.isNotEmpty()&&r.attempts.all{it.startsWith("post:")}&&r.consent==null&&r.signed==null)
  r.response?.let{verify(r,it)};r.observations.forEach(KeepEquipmentMarketProtocol::copy)
  r.consent?.let{require(r.kind=="fill"&&r.response!=null);val pins=KeepEquipmentMarketSigningTrust.from(it.pins);KeepEquipmentMarketTransaction.prepare(it.purchase,pins,r.policy);KeepEquipmentMarketProtocol.review(it.review);require(it.review["purchase"]==it.purchase&&it.purchase["fill"]==r.response["fill"]&&it.purchase["preparation"]==r.response["preparation"])}
  r.signed?.let{require("wallet" in r.attempts);KeepEquipmentMarketTransaction.verifyWire(requireNotNull(r.consent).purchase,it,r.policy)}
 }
 private suspend fun verify(r:KeepEquipmentMarketRecord,raw:JsonObject):JsonObject=when(r.kind){
  "listing"->KeepEquipmentMarketProtocol.listing(raw).also{require(it.charterText("sellerWallet")==identity.wallet&&it.charterText("id")==r.key);for((a,b)in listOf("sellerBaseId" to "baseId","itemId" to "itemId","quantity" to "quantity","unitPriceBaseUnits" to "unitPriceBaseUnits"))require(it[a]==r.request[b])}
  "cancellation"->KeepEquipmentMarketProtocol.cancellation(raw).also{require(it.charterText("actorWallet")==identity.wallet&&it.charterText("id")==r.key&&it["listingId"]==r.request["listingId"]);r.preview?.let{p->require(it.amount("quantity")<=p.amount("availableQuantity"))}}
  "fill"->KeepEquipmentMarketProtocol.purchase(raw).also{v->val f=v.charterObject("fill");require(f.charterText("buyerWallet")==identity.wallet&&f.charterText("id")==r.key);for(k in listOf("listingId","buyerBaseId","quantity"))require(f[k]==r.request[k]);r.preview?.let{p->for(k in listOf("sellerWallet","sellerBaseId","itemId","unitPriceBaseUnits"))require(f[k]==p[k])};KeepEquipmentMarketTransaction.verifyHistory(v,r.policy)}
  else->error("Unknown market operation")
 }
 private suspend fun snapshot():KeepEquipmentMarketJournal {val text=secret.read()?:return KeepEquipmentMarketJournal(identity=identity);require(text.length<=8*1024*1024);val j=marketStoreJson.decodeFromString<KeepEquipmentMarketJournal>(text);require(j.version==1&&j.identity==identity&&j.revision>=0&&j.pending.size<=32&&j.archives.size<=128&&j.records.map{it.key}.distinct().size==j.records.size);j.records.forEach{validate(it)};j.pending.forEach{require(!it.closedAbsent)};j.archives.forEach{require(terminal(it))};return j}
 private fun save(j:KeepEquipmentMarketJournal,pending:List<KeepEquipmentMarketRecord> = j.pending,archives:List<KeepEquipmentMarketRecord> = j.archives):KeepEquipmentMarketJournal {val next=j.copy(revision=Math.addExact(j.revision,1),pending=pending,archives=archives);val text=marketStoreJson.encodeToString(KeepEquipmentMarketJournal.serializer(),next);require(text.length<=8*1024*1024);secret.write(text);return next}
 private fun update(j:KeepEquipmentMarketJournal,key:String,fn:(KeepEquipmentMarketRecord)->KeepEquipmentMarketRecord):KeepEquipmentMarketJournal {require(j.records.any{it.key==key});return save(j,j.pending.map{if(it.key==key)fn(it)else it},j.archives.map{if(it.key==key)fn(it)else it})}
 private suspend fun flush():KeepEquipmentMarketJournal {var j=snapshot();while(locks.replies.isNotEmpty()){val(key,raw)=locks.replies.first();j=update(j,key){r->require(raw in r.observations||r.observations.size<32);r.copy(held=true,observations=if(raw in r.observations)r.observations else r.observations+raw)};locks.replies.removeAt(0)}
  while(locks.signatures.isNotEmpty()){val(key,wire)=locks.signatures.entries.first();val r=j.records.single{it.key==key};require("wallet" in r.attempts);KeepEquipmentMarketTransaction.verifyWire(requireNotNull(r.consent).purchase,wire,r.policy);j=update(j,key){it.signed?.let{old->require(old==wire)};it.copy(signed=wire)};locks.signatures.remove(key)};return j}
 suspend fun read()=locks.updates.withLock{flush()}
 suspend fun record(key:String)=read().records.single{it.key==key}
 suspend fun begin(record:KeepEquipmentMarketRecord,historical:Boolean=false)=locks.updates.withLock{val j=flush();validate(record);require(record.response==null&&record.attempts.isEmpty()&&record.consent==null&&record.signed==null&&!record.held&&record.observations.isEmpty()&&!record.discardedUnsent)
  j.records.singleOrNull{it.key==record.key}?.let{require(it.kind==record.kind&&it.request==record.request&&it.policy==record.policy);return@withLock it};check(j.pending.size<32){"Saved market journal is full. Archive completed records first"}
  check(historical||j.pending.none{!terminal(it)&&it.kind==record.kind&&when(record.kind){"listing"->it.request["baseId"]==record.request["baseId"];"fill"->it.request["buyerBaseId"]==record.request["buyerBaseId"];else->it.request["listingId"]==record.request["listingId"]}}){"Check the original market request before starting another"};save(j,j.pending+record);record}
 suspend fun attempt(key:String,name:String,repeatable:Boolean=false)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.key==key};check(!r.held&&!r.discardedUnsent&&!(r.kind=="fill"&&terminal(r)));require(r.attempts.size<128);val marker=if(repeatable)"$name:${r.attempts.count{it.startsWith("$name:")}}" else name;check(marker !in r.attempts){"Original wallet approval is already attempted. Check the saved payment"};update(j,key){it.copy(attempts=it.attempts+marker)};Unit}
 suspend fun retain(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val owned=KeepEquipmentMarketProtocol.copy(raw).jsonObject;locks.replies+=key to owned;val j=flush();val r=j.records.single{it.key==key};val v=verify(r,owned)
  r.response?.let{old->when(r.kind){"listing"->{require(JsonObject(old-setOf("availableQuantity","reservedQuantity","cancelledQuantity"))==JsonObject(v-setOf("availableQuantity","reservedQuantity","cancelledQuantity")));require(v.amount("reservedQuantity")>=old.amount("reservedQuantity")&&v.amount("cancelledQuantity")>=old.amount("cancelledQuantity"))};"fill"->{require(old["fill"]==v["fill"]);for(k in listOf("preparation","wire","delivery","release"))if(old[k]!=null&&old[k]!=JsonNull)require(old[k]==v[k])};else->require(old==v)}}
  if(r.kind=="fill")r.signed?.let{wire->v.charterOptional("wire")?.let{saved->for(k in wire.keys)require(wire[k]==saved[k])}}
  update(j,key){val remaining=it.observations.filterNot{row->row==owned};it.copy(response=v,observations=remaining,held=remaining.isNotEmpty())};Unit}}
 suspend fun consent(key:String,consent:KeepEquipmentMarketConsent)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.key==key};require(!r.held&&"wallet" !in r.attempts&&r.response==consent.purchase);val next=r.copy(consent=consent);validate(next);r.consent?.let{require(it.pins==consent.pins&&it.purchase["fill"]==consent.purchase["fill"]&&it.purchase["preparation"]==consent.purchase["preparation"])};update(j,key){next};Unit}
 suspend fun signed(key:String,raw:JsonObject)=withContext(NonCancellable){locks.updates.withLock{val wire=KeepEquipmentMarketProtocol.wire(raw);locks.signatures[key]?.let{require(it==wire)};locks.signatures[key]=wire;flush();Unit}}
 suspend fun adopt(kind:String,raw:JsonObject,policy:JsonObject):KeepEquipmentMarketRecord {val v=when(kind){"listing"->KeepEquipmentMarketProtocol.listing(raw);"fill"->KeepEquipmentMarketProtocol.purchase(raw);"cancellation"->KeepEquipmentMarketProtocol.cancellation(raw);else->error("Unknown market history")};val f=if(kind=="fill")v.charterObject("fill")else v;val key=f.charterText("id");val body=buildJsonObject{put("idempotencyKey",key);when(kind){"listing"->{put("baseId",f.getValue("sellerBaseId"));for(k in listOf("itemId","quantity","unitPriceBaseUnits"))put(k,f.getValue(k))};"fill"->for(k in listOf("listingId","buyerBaseId","quantity"))put(k,f.getValue(k));else->put("listingId",f.getValue("listingId"))}};begin(KeepEquipmentMarketRecord(kind,key,body,policy),true);retain(key,v);return record(key)}
 /** An unsent draft closes as discardedUnsent. A POSTed original ("post:N" markers only: no wallet, payment or
  * release step) closes only as [absent]: the unchanged record the caller's same-action by-key GET found missing. */
 suspend fun discard(key:String,absent:KeepEquipmentMarketRecord?=null)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.key==key};val sent=r.attempts.isNotEmpty()
  require((!sent||r==absent&&r.attempts.all{it.startsWith("post:")}&&r.consent==null&&r.observations.isEmpty())&&r.response==null&&!r.held&&r.signed==null);check(j.archives.size<128);save(j,j.pending.filterNot{it.key==key},j.archives+(if(sent)r.copy(closedAbsent=true)else r.copy(discardedUnsent=true)));Unit}
 suspend fun archive(key:String,expected:KeepEquipmentMarketRecord)=locks.updates.withLock{val j=flush();val r=j.pending.single{it.key==key};require(r==expected&&terminal(r)&&!r.held);check(j.archives.size<128);save(j,j.pending.filterNot{it.key==key},j.archives+r);Unit}
}
